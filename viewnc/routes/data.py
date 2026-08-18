"""
routes/data.py – Core data-serving endpoints: slice, stats, timeseries, coastlines.

Blueprint: ``data_bp``
"""
from __future__ import annotations

import logging

import numpy as np
from flask import Blueprint, jsonify, request

from viewnc.iris_loader import extract_slice
from viewnc.state import app_state

logger = logging.getLogger(__name__)

data_bp = Blueprint("data", __name__)

# Coastline geometry is slow to build; cache by resolution string
_coastline_cache: dict = {}


# ── Helpers ───────────────────────────────────────────────────────────────────

def _maybe_downsample(arr: np.ndarray, max_size: int) -> np.ndarray:
    """Downsample a 2-D array so neither dimension exceeds *max_size*."""
    if arr.ndim != 2:
        return arr
    r, c = arr.shape
    sr = max(1, r // max_size)
    sc = max(1, c // max_size)
    return arr[::sr, ::sc]


# ── Routes ────────────────────────────────────────────────────────────────────

@data_bp.route("/api/slice", methods=["POST"])
def api_slice():
    """Return a 2-D data slice as JSON for Plotly rendering."""
    if app_state["cubes"] is None:
        return jsonify({"error": "No file loaded"}), 400

    body = request.get_json(force=True)
    cube_index = int(body.get("cube_index", 0))
    constraints = body.get("constraints", {})

    try:
        data, meta = extract_slice(app_state["cubes"], cube_index, constraints)
        data = _maybe_downsample(data, 512)
        data_list = [[None if np.isnan(v) else v for v in row] for row in data.tolist()]
        return jsonify({"data": data_list, "meta": meta})
    except Exception as exc:
        logger.exception("Slice failed")
        return jsonify({"error": str(exc)}), 500


@data_bp.route("/api/timeseries", methods=["POST"])
def api_timeseries():
    """Return a 1-D time series collapsed over spatial dims (spatial mean)."""
    if app_state["cubes"] is None:
        return jsonify({"error": "No file loaded"}), 400

    body = request.get_json(force=True)
    cube_index = int(body.get("cube_index", 0))

    try:
        import iris.analysis as ia

        cube = app_state["cubes"][cube_index]
        spatial_dims = [
            c for c in cube.dim_coords
            if c.name() in ("latitude", "longitude", "grid_latitude", "grid_longitude", "x", "y")
        ]
        collapsed = cube
        for coord in spatial_dims:
            try:
                collapsed = collapsed.collapsed(coord.name(), ia.MEAN)
            except Exception:
                pass

        pts = collapsed.data.flatten()
        try:
            t_coord = collapsed.coord("time")
            t_pts = [str(t_coord.units.num2date(v)) for v in t_coord.points.flatten()]
        except Exception:
            t_pts = list(range(len(pts)))

        values = [None if np.isnan(float(v)) else float(v) for v in pts]
        return jsonify({
            "time": t_pts,
            "values": values,
            "units": str(cube.units),
            "name": cube.name(),
        })
    except Exception as exc:
        logger.exception("Timeseries failed")
        return jsonify({"error": str(exc)}), 500


@data_bp.route("/api/stats", methods=["POST"])
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
    if app_state["cubes"] is None:
        return jsonify({"error": "No file loaded"}), 400

    body = request.get_json(force=True)
    cube_index = int(body.get("cube_index", 0))
    constraints = body.get("constraints", {})\

    try:
        data, meta = extract_slice(app_state["cubes"], cube_index, constraints)

        flat = data.flatten()
        valid = flat[~np.isnan(flat)]
        total = int(flat.size)
        n_valid = int(valid.size)
        n_masked = total - n_valid

        def _f(v):
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


@data_bp.route("/api/coastlines")
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
                xs.append(None)
                ys.append(None)

        payload = {"x": xs, "y": ys}
        _coastline_cache[res] = payload
        logger.info("Coastlines (%s) built: %d points", res, len(xs))
        return jsonify(payload)

    except Exception as exc:
        logger.exception("Coastlines failed")
        return jsonify({"error": str(exc)}), 500
