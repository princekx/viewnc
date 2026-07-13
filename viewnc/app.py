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
from flask import Flask, jsonify, render_template, request, send_file, Response

from viewnc.iris_loader import cubelist_metadata, extract_slice, load_file

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

app = Flask(__name__, template_folder="templates", static_folder="static")


# ── NaN-safe JSON serialisation ───────────────────────────────────────────────
# Python's json module raises on NaN/Inf; Flask's default encoder inherits
# that limitation.  We override it to emit `null` for any non-finite float
# so masked / fill-value data never breaks the client.

class _NanSafeEncoder(json.JSONEncoder):
    def iterencode(self, o, _one_shot=False):
        # Walk the object tree and replace non-finite floats with None
        return super().iterencode(self._sanitise(o), _one_shot)

    def _sanitise(self, obj):
        if isinstance(obj, float):
            return None if (obj != obj or obj == float('inf') or obj == float('-inf')) else obj
        if isinstance(obj, dict):
            return {k: self._sanitise(v) for k, v in obj.items()}
        if isinstance(obj, (list, tuple)):
            return [self._sanitise(v) for v in obj]
        return obj

app.json_encoder = _NanSafeEncoder  # type: ignore[attr-defined]

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
    return jsonify({"cubes": _state["metadata"], "filepath": _state["filepath"]})


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


@app.route("/api/location_series", methods=["POST"])
def api_location_series():
    """
    Return a 1-D series at a clicked (x, y) grid location along all
    non-spatial (extra) dimensions.

    Body JSON:
        cube_index  : int
        x_val       : float  – clicked x coordinate value
        y_val       : float  – clicked y coordinate value
        constraints : dict   – same non-spatial constraints as /api/slice
                               (used to fix any extra dims that are already
                               collapsed; we'll iterate over the remaining one)
    """
    if _state["cubes"] is None:
        return jsonify({"error": "No file loaded"}), 400

    body = request.get_json(force=True)
    cube_index = int(body.get("cube_index", 0))
    x_val = float(body.get("x_val", 0))
    y_val = float(body.get("y_val", 0))
    constraints = body.get("constraints", {})

    try:
        cube = _state["cubes"][cube_index]
        dim_coords = list(cube.dim_coords)

        if cube.ndim < 2:
            return jsonify({"error": "Cube has fewer than 2 dimensions"}), 400

        # Identify spatial (last 2) and extra coords
        spatial_coords = dim_coords[-2:]   # (y, x)
        extra_coords   = dim_coords[:-2]   # everything before spatial

        y_coord, x_coord = spatial_coords

        # Find nearest grid indices for clicked location
        xpts = x_coord.points
        ypts = y_coord.points
        xi = int(np.argmin(np.abs(xpts - x_val)))
        yi = int(np.argmin(np.abs(ypts - y_val)))

        # Build the series by iterating over ALL non-spatial points
        # We ignore the range/processor constraints here – we want the full
        # series at this location.
        if not extra_coords:
            # 2-D cube: plot a zonal profile (full longitude row at clicked latitude)
            row = np.ma.filled(cube.data[yi, :], np.nan).astype(float)
            lon_vals = xpts.tolist()
            values = [None if np.isnan(v) else float(v) for v in row]
            return jsonify({
                "axis_name": x_coord.name(),
                "axis_units": str(x_coord.units),
                "axis_values": lon_vals,
                "values": values,
                "units": str(cube.units),
                "name": cube.name(),
                "x_val": float(xpts[xi]),
                "y_val": float(ypts[yi]),
            })

        # Choose the series axis.
        # The frontend passes series_axis = coord name chosen by the user.
        # Fall back to the innermost extra dim when no preference is given.
        series_axis = body.get("series_axis") or None
        if series_axis:
            match = next((c for c in extra_coords if c.name() == series_axis), None)
            series_coord = match if match else extra_coords[-1]
        else:
            series_coord = extra_coords[-1]

        # Fix every other extra dim at the user's currently selected slider index.
        # constraints[name] = {"range": [lo, hi], "processor": ..., "value": ...}
        # We must remove dims by their *current* position in the progressively-
        # sliced cube, not always dim-0.  Build a full index tuple each time.
        sliced = cube
        for fc in extra_coords:
            if fc.name() == series_coord.name():
                continue          # leave the series dim intact
            c_spec = constraints.get(fc.name(), {})
            lo = (c_spec.get("range") or [None])[0]
            n_pts = len(fc.points)
            if lo is not None and 0 <= int(lo) < n_pts:
                idx = int(lo)
            else:
                idx = n_pts // 2  # fall back to midpoint
            # Find which dimension fc currently occupies in the sliced cube
            try:
                dim_pos = sliced.coord_dims(fc.name())[0]
            except Exception:
                continue  # coord no longer present, skip
            index_tuple = tuple(
                idx if i == dim_pos else slice(None)
                for i in range(sliced.ndim)
            )
            sliced = sliced[index_tuple]

        # Now sliced has shape (n_series, ny, nx)
        n = len(series_coord.points)
        series_vals = []
        for i in range(n):
            v = sliced[i].data
            if hasattr(v, '__getitem__'):
                v = float(np.ma.filled(np.atleast_1d(v)[yi, xi], np.nan))
            else:
                v = float(v)
            series_vals.append(None if np.isnan(v) else v)

        # Format axis labels (time-aware)
        from viewnc.iris_loader import _is_time_coord, _fmt_date
        if _is_time_coord(series_coord):
            try:
                axis_vals = [_fmt_date(series_coord.units.num2date(p))
                             for p in series_coord.points]
            except Exception:
                axis_vals = series_coord.points.tolist()
        else:
            axis_vals = series_coord.points.tolist()

        return jsonify({
            "axis_name": series_coord.name(),
            "axis_units": str(series_coord.units),
            "axis_values": axis_vals,
            "values": series_vals,
            "units": str(cube.units),
            "name": cube.name(),
            "x_val": float(xpts[xi]),
            "y_val": float(ypts[yi]),
        })

    except Exception as exc:
        logger.exception("Location series failed")
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


# ── Statistics ───────────────────────────────────────────────────────────────

@app.route("/api/stats", methods=["POST"])
def api_stats():
    """
    Return descriptive statistics for the current 2-D slice.

    Body JSON: same as /api/slice (cube_index, constraints).
    Returns:
        {
          "mean": float, "std": float, "min": float, "max": float,
          "median": float, "p5": float, "p95": float,
          "count_valid": int, "count_total": int, "pct_masked": float,
          "units": str, "name": str, "shape": [ny, nx]
        }
    """
    if _state["cubes"] is None:
        return jsonify({"error": "No file loaded"}), 400

    body = request.get_json(force=True)
    cube_index = int(body.get("cube_index", 0))
    constraints = body.get("constraints", {})

    try:
        data, meta = extract_slice(_state["cubes"], cube_index, constraints)

        flat = data.flatten()
        valid = flat[~np.isnan(flat)]
        total = int(flat.size)
        n_valid = int(valid.size)
        n_masked = total - n_valid

        def _f(v):
            """Return float or None for JSON safety."""
            if v is None:
                return None
            v = float(v)
            return None if (np.isnan(v) or np.isinf(v)) else v

        if n_valid == 0:
            stats = {k: None for k in ("mean", "std", "min", "max", "median", "p5", "p95")}
        else:
            stats = {
                "mean":   _f(np.mean(valid)),
                "std":    _f(np.std(valid)),
                "min":    _f(np.min(valid)),
                "max":    _f(np.max(valid)),
                "median": _f(np.median(valid)),
                "p5":     _f(np.percentile(valid, 5)),
                "p95":    _f(np.percentile(valid, 95)),
            }

        stats.update({
            "count_valid": n_valid,
            "count_total": total,
            "pct_masked":  _f(100.0 * n_masked / total) if total else 0.0,
            "units":  meta.get("units", ""),
            "name":   meta.get("name", ""),
            "shape":  meta.get("shape", list(data.shape)),
        })
        return jsonify(stats)

    except Exception as exc:
        logger.exception("Stats failed")
        return jsonify({"error": str(exc)}), 500


# ── Export ───────────────────────────────────────────────────────────────────

@app.route("/api/export/csv", methods=["POST"])
def api_export_csv():
    """
    Stream the current 2-D slice as a UTF-8 CSV file.

    Body JSON: same as /api/slice (cube_index, constraints).
    Response: attachment  viewnc_<name>.csv
    """
    if _state["cubes"] is None:
        return jsonify({"error": "No file loaded"}), 400

    body = request.get_json(force=True)
    cube_index = int(body.get("cube_index", 0))
    constraints = body.get("constraints", {})

    try:
        import csv

        data, meta = extract_slice(_state["cubes"], cube_index, constraints)
        cube = _state["cubes"][cube_index]

        ny, nx = data.shape
        x_vals = meta["x"].get("values") or list(range(nx))
        y_vals = (meta.get("y") or {}).get("values") or list(range(ny))
        x_name = meta["x"].get("name", "x")
        y_name = (meta.get("y") or {}).get("name", "y")
        x_units = meta["x"].get("units", "")
        y_units = (meta.get("y") or {}).get("units", "")
        cube_units = meta.get("units", "")

        def _generate():
            import io
            buf = io.StringIO()
            writer = csv.writer(buf)

            # Header comment lines
            writer.writerow([f"# viewnc export"])
            writer.writerow([f"# variable: {cube.name()}"])
            writer.writerow([f"# units: {cube_units}"])
            writer.writerow([f"# shape: {ny} x {nx}"])
            writer.writerow([f"# x_axis: {x_name} ({x_units})"])
            writer.writerow([f"# y_axis: {y_name} ({y_units})"])

            # Column header row: first cell is the y-axis label, then x values
            x_header = [f"{y_name}\\{x_name}"] + [str(v) for v in x_vals[:nx]]
            writer.writerow(x_header)

            # Data rows
            for i, row in enumerate(data.tolist()):
                y_label = str(y_vals[i]) if i < len(y_vals) else str(i)
                csv_row = [y_label] + [(
                    "" if (v is None or (isinstance(v, float) and (v != v)))
                    else f"{v:.6g}"
                ) for v in row]
                writer.writerow(csv_row)

            yield buf.getvalue()

        safe_name = (cube.name() or "slice").replace(" ", "_").replace("/", "-")
        filename = f"viewnc_{safe_name}.csv"
        return Response(
            _generate(),
            mimetype="text/csv",
            headers={"Content-Disposition": f'attachment; filename="{filename}"'},
        )
    except Exception as exc:
        logger.exception("CSV export failed")
        return jsonify({"error": str(exc)}), 500


@app.route("/api/export/netcdf", methods=["POST"])
def api_export_netcdf():
    """
    Export the current 2-D slice as a NetCDF4 file using iris.

    Body JSON: same as /api/slice (cube_index, constraints).
    Response: attachment  viewnc_<name>.nc
    """
    if _state["cubes"] is None:
        return jsonify({"error": "No file loaded"}), 400

    body = request.get_json(force=True)
    cube_index = int(body.get("cube_index", 0))
    constraints = body.get("constraints", {})

    try:
        import tempfile
        import iris
        from viewnc.iris_loader import extract_slice as _ext

        # Re-extract the slice cube (not just the numpy array)
        # We replicate the same constraint logic but keep the iris cube object.
        cube = _state["cubes"][cube_index]

        # Apply constraints using the same helper
        from viewnc.iris_loader import _safe_constraint, _PROCESSORS
        import iris.analysis as _ia

        sliced = cube
        for coord_name, spec in constraints.items():
            if spec is None:
                continue
            if isinstance(spec, dict):
                val_range = spec.get("range")
                scalar = spec.get("value")
                processor = spec.get("processor", "mean")
            else:
                val_range = None
                scalar = spec
                processor = "mean"
            try:
                coord = sliced.coord(coord_name)
                if coord.ndim != 1:
                    continue
                pts = coord.points
                if val_range is not None:
                    lo_idx = max(0, min(int(val_range[0]), len(pts) - 1))
                    hi_idx = max(lo_idx, min(int(val_range[1]), len(pts) - 1))
                    try:
                        dim_idx = sliced.coord_dims(coord)[0]
                    except Exception:
                        continue
                    idx_slices = tuple(
                        slice(lo_idx, hi_idx + 1) if i == dim_idx else slice(None)
                        for i in range(sliced.ndim)
                    )
                    sub = sliced[idx_slices]
                    analyser = _PROCESSORS.get(processor, _ia.MEAN)
                    try:
                        sliced = sub.collapsed(coord_name, analyser)
                    except Exception:
                        sliced = sub[tuple(
                            0 if i == dim_idx else slice(None)
                            for i in range(sub.ndim)
                        )]
                else:
                    value = float(scalar) if scalar is not None else float(pts[0])
                    constraint = _safe_constraint(sliced, coord_name, value)
                    result = sliced.extract(constraint)
                    if result is None:
                        dim_idx = sliced.coord_dims(coord)[0]
                        idx = int(np.argmin(np.abs(pts - value)))
                        sliced = sliced[tuple(
                            idx if i == dim_idx else slice(None)
                            for i in range(sliced.ndim)
                        )]
                    else:
                        sliced = result
            except Exception as exc:
                logger.warning("NetCDF constraint on %s failed: %s", coord_name, exc)

        while sliced.ndim > 2:
            sliced = sliced[0]

        with tempfile.NamedTemporaryFile(suffix=".nc", delete=False) as tmp:
            tmp_path = tmp.name

        iris.save(sliced, tmp_path)

        safe_name = (cube.name() or "slice").replace(" ", "_").replace("/", "-")
        filename = f"viewnc_{safe_name}.nc"
        return send_file(
            tmp_path,
            mimetype="application/x-netcdf",
            as_attachment=True,
            download_name=filename,
        )
    except Exception as exc:
        logger.exception("NetCDF export failed")
        return jsonify({"error": str(exc)}), 500


@app.route("/api/export/series_csv", methods=["POST"])
def api_export_series_csv():
    """
    Export one or more 1-D location series as a multi-column CSV.

    Body JSON:
        {
          "axis_name"   : str,
          "axis_units"  : str,
          "series"      : [
            { "label": str, "axis_values": [...], "values": [...] },
            ...
          ],
          "units"       : str,
          "name"        : str
        }
    """
    body = request.get_json(force=True)
    series_list = body.get("series", [])
    if not series_list:
        return jsonify({"error": "No series data provided"}), 400

    try:
        import csv, io

        axis_name  = body.get("axis_name", "index")
        axis_units = body.get("axis_units", "")
        data_units = body.get("units", "")
        var_name   = body.get("name", "variable")

        buf = io.StringIO()
        writer = csv.writer(buf)

        writer.writerow(["# viewnc location-series export"])
        writer.writerow([f"# variable: {var_name}  [{data_units}]"])
        writer.writerow([f"# axis: {axis_name}  [{axis_units}]"])
        writer.writerow([""])

        # Use the first series' axis values as the shared index column
        axis_vals = series_list[0].get("axis_values", [])
        labels    = [s.get("label", f"series_{i}") for i, s in enumerate(series_list)]

        # Header
        header = [f"{axis_name} ({axis_units})" if axis_units else axis_name] + labels
        writer.writerow(header)

        # Rows
        for i, av in enumerate(axis_vals):
            row = [str(av)]
            for s in series_list:
                v = s.get("values", [])
                val = v[i] if i < len(v) else ""
                row.append("" if val is None else f"{val:.6g}" if isinstance(val, (int, float)) else str(val))
            writer.writerow(row)

        csv_bytes = buf.getvalue().encode("utf-8")
        safe_name = var_name.replace(" ", "_").replace("/", "-")
        filename = f"viewnc_{safe_name}_series.csv"
        return Response(
            csv_bytes,
            mimetype="text/csv",
            headers={"Content-Disposition": f'attachment; filename="{filename}"'},
        )
    except Exception as exc:
        logger.exception("Series CSV export failed")
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
