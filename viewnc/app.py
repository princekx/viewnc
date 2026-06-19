"""
app.py – Flask application for viewnc.
"""
from __future__ import annotations

import io
import json
import logging
import os
from pathlib import Path

import numpy as np
from flask import Flask, jsonify, render_template, request, send_file

from viewnc.iris_loader import cubelist_metadata, extract_slice, load_file

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

app = Flask(__name__, template_folder="templates", static_folder="static")

# ── Global state ─────────────────────────────────────────────────────────────
_state: dict = {
    "filepath": None,
    "cubes": None,
    "metadata": None,
}


# ── Routes ────────────────────────────────────────────────────────────────────

@app.route("/")
def index():
    return render_template("index.html")


# ── File Browser ──────────────────────────────────────────────────────────────

_DATA_EXTS = {".nc", ".pp", ".grb", ".grib", ".grib2", ".grb2"}


@app.route("/api/browse")
def api_browse():
    """
    Return a directory listing for the requested path.
    Query params:
        path : absolute directory path (default: user home)
    Returns:
        {
          "path": "/abs/path",
          "parents": [{"name":"home", "path":"/home"}, ...],
          "dirs":  [{"name":str, "path":str, "mtime":float}, ...],
          "files": [{"name":str, "path":str, "size":int, "mtime":float}, ...]
        }
    """
    raw = request.args.get("path", "").strip() or str(Path.home())
    p = Path(raw).resolve()

    if not p.exists() or not p.is_dir():
        # Fall back to the closest existing parent
        while not p.exists() and p != p.parent:
            p = p.parent

    dirs, files = [], []
    try:
        for entry in sorted(p.iterdir(), key=lambda e: (not e.is_dir(), e.name.lower())):
            # Skip hidden entries
            if entry.name.startswith("."):
                continue
            try:
                stat = entry.stat()
            except PermissionError:
                continue
            if entry.is_dir():
                dirs.append({
                    "name": entry.name,
                    "path": str(entry),
                    "mtime": stat.st_mtime,
                })
            elif entry.suffix.lower() in _DATA_EXTS:
                files.append({
                    "name": entry.name,
                    "path": str(entry),
                    "size": stat.st_size,
                    "mtime": stat.st_mtime,
                })
    except PermissionError:
        pass

    # Build breadcrumb list
    parts = p.parts  # ('/', 'home', 'prince', ...)
    parents = []
    for i, part in enumerate(parts):
        full = str(Path(*parts[: i + 1])) if i > 0 else "/"
        parents.append({"name": part, "path": full})

    return jsonify({"path": str(p), "parents": parents, "dirs": dirs, "files": files})


@app.route("/api/load", methods=["POST"])
def api_load():
    body = request.get_json(force=True)
    filepath = body.get("filepath", "").strip()
    if not filepath:
        return jsonify({"error": "No filepath provided"}), 400
    p = Path(filepath)
    if not p.exists():
        return jsonify({"error": f"File not found: {filepath}"}), 404

    try:
        cubes = load_file(p)
        meta = cubelist_metadata(cubes)
        _state["filepath"] = str(p)
        _state["cubes"] = cubes
        _state["metadata"] = meta
        return jsonify({"status": "ok", "filepath": str(p), "cubes": meta})
    except Exception as exc:
        logger.exception("Failed to load file")
        return jsonify({"error": str(exc)}), 500


@app.route("/api/metadata")
def api_metadata():
    if _state["metadata"] is None:
        return jsonify({"error": "No file loaded"}), 400
    return jsonify({"cubes": _state["metadata"]})


@app.route("/api/slice", methods=["POST"])
def api_slice():
    """Return a 2-D data slice as JSON for Bokeh/Plotly rendering."""
    if _state["cubes"] is None:
        return jsonify({"error": "No file loaded"}), 400

    body = request.get_json(force=True)
    cube_index = int(body.get("cube_index", 0))
    constraints = body.get("constraints", {})

    try:
        data, meta = extract_slice(_state["cubes"], cube_index, constraints)
        # Downsample very large arrays for the browser (max 512 × 512)
        data = _maybe_downsample(data, 512)
        # Replace NaN with null for JSON
        data_list = [[None if np.isnan(v) else v for v in row] for row in data.tolist()]
        return jsonify({"data": data_list, "meta": meta})
    except Exception as exc:
        logger.exception("Slice failed")
        return jsonify({"error": str(exc)}), 500


@app.route("/api/timeseries", methods=["POST"])
def api_timeseries():
    """Return a 1-D time series collapsed over spatial dims (mean)."""
    if _state["cubes"] is None:
        return jsonify({"error": "No file loaded"}), 400

    body = request.get_json(force=True)
    cube_index = int(body.get("cube_index", 0))

    try:
        import iris.analysis as ia
        cube = _state["cubes"][cube_index]
        # Try to collapse spatial dimensions
        spatial_dims = [c for c in cube.dim_coords if c.name() in ("latitude", "longitude", "grid_latitude", "grid_longitude", "x", "y")]
        collapsed = cube
        for coord in spatial_dims:
            try:
                collapsed = collapsed.collapsed(coord.name(), ia.MEAN)
            except Exception:
                pass

        pts = collapsed.data.flatten()
        # Get time axis if present
        try:
            t_coord = collapsed.coord("time")
            t_pts = [str(t_coord.units.num2date(v)) for v in t_coord.points.flatten()]
        except Exception:
            t_pts = list(range(len(pts)))

        values = [None if np.isnan(float(v)) else float(v) for v in pts]
        return jsonify({"time": t_pts, "values": values, "units": str(cube.units), "name": cube.name()})
    except Exception as exc:
        logger.exception("Timeseries failed")
        return jsonify({"error": str(exc)}), 500


# ── Coastlines ───────────────────────────────────────────────────────────────

_coastline_cache: dict = {}  # keyed by resolution string


@app.route("/api/coastlines")
def api_coastlines():
    """
    Return Natural Earth coastlines as a single concatenated coordinate array
    (null-separated segments) suitable for a Plotly scatter trace.

    Query params:
        res : '110m' (default) | '50m' | '10m'
    """
    res = request.args.get("res", "110m")
    if res not in ("110m", "50m", "10m"):
        res = "110m"

    if res in _coastline_cache:
        return jsonify(_coastline_cache[res])

    try:
        import cartopy.feature as cfeature

        feature = cfeature.NaturalEarthFeature("physical", "coastline", res)
        xs: list = []
        ys: list = []

        for geom in feature.geometries():
            if geom.geom_type == "LineString":
                lines = [geom]
            elif geom.geom_type == "MultiLineString":
                lines = list(geom.geoms)
            else:
                continue

            for line in lines:
                coords = list(line.coords)
                xs.extend(c[0] for c in coords)
                ys.extend(c[1] for c in coords)
                xs.append(None)   # pen-up between segments
                ys.append(None)

        payload = {"x": xs, "y": ys}
        _coastline_cache[res] = payload
        logger.info("Coastlines (%s) built: %d points", res, len(xs))
        return jsonify(payload)

    except Exception as exc:
        logger.exception("Coastlines failed")
        return jsonify({"error": str(exc)}), 500


# ── Helpers ───────────────────────────────────────────────────────────────────

def _maybe_downsample(arr: np.ndarray, max_size: int) -> np.ndarray:
    """Downsample a 2-D array so neither dimension exceeds max_size."""
    if arr.ndim != 2:
        return arr
    r, c = arr.shape
    sr = max(1, r // max_size)
    sc = max(1, c // max_size)
    return arr[::sr, ::sc]


# ── Entry point ───────────────────────────────────────────────────────────────

def run(filepath: str | None = None, port: int = 5765, open_browser: bool = True):
    import threading
    import time
    import webbrowser

    if filepath:
        from pathlib import Path as _P
        from viewnc.iris_loader import load_file as _lf, cubelist_metadata as _cm
        p = _P(filepath)
        if p.exists():
            cubes = _lf(p)
            _state["filepath"] = str(p)
            _state["cubes"] = cubes
            _state["metadata"] = _cm(cubes)
            logger.info("Pre-loaded: %s (%d cube(s))", p, len(cubes))

    url = f"http://127.0.0.1:{port}"

    def _open():
        time.sleep(1.2)
        webbrowser.open(url)

    if open_browser:
        threading.Thread(target=_open, daemon=True).start()

    logger.info("viewnc running at %s", url)
    app.run(host="127.0.0.1", port=port, debug=False, use_reloader=False)
