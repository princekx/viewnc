"""
routes/series.py – Location-series endpoint.

Blueprint: ``series_bp``
"""
from __future__ import annotations

import json
import logging

import numpy as np
from flask import Blueprint, jsonify, request

from viewnc.iris_loader import extract_slice
from viewnc.state import app_state, loc_series_cache

logger = logging.getLogger(__name__)

series_bp = Blueprint("series", __name__)


@series_bp.route("/api/location_series", methods=["POST"])
def api_location_series():
    """
    Return a 1-D series at a clicked (x, y) grid location along all
    non-spatial (extra) dimensions.

    Body JSON:
        cube_index  : int
        x_val       : float  – clicked x coordinate value
        y_val       : float  – clicked y coordinate value
        constraints : dict   – same non-spatial constraints as /api/slice
        series_axis : str    – coordinate name chosen by the user (optional)
    """
    if app_state["cubes"] is None:
        return jsonify({"error": "No file loaded"}), 400

    body = request.get_json(force=True)
    cube_index  = int(body.get("cube_index", 0))
    x_val       = float(body.get("x_val", 0))
    y_val       = float(body.get("y_val", 0))
    constraints = body.get("constraints", {})

    try:
        cube        = app_state["cubes"][cube_index]
        dim_coords  = list(cube.dim_coords)

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

        if not extra_coords:
            # 2-D cube: zonal profile (full longitude row at clicked latitude)
            row = np.ma.filled(cube[yi, :].data, np.nan).astype(float)
            lon_vals = xpts.tolist()
            values = [None if np.isnan(v) else float(v) for v in row]
            return jsonify({
                "axis_name":   x_coord.name(),
                "axis_units":  str(x_coord.units),
                "axis_values": lon_vals,
                "values":      values,
                "units":       str(cube.units),
                "name":        cube.name(),
                "x_val":       float(xpts[xi]),
                "y_val":       float(ypts[yi]),
            })

        series_axis = body.get("series_axis") or None

        # ── Spatial series (latitude or longitude profile) ─────────────────────
        if series_axis in (x_coord.name(), y_coord.name()):
            data, slice_meta = extract_slice(app_state["cubes"], cube_index, constraints)
            xs = np.array(slice_meta["x"].get("values") or xpts.tolist())
            ys = np.array((slice_meta.get("y") or {}).get("values") or ypts.tolist())

            if series_axis == x_coord.name():
                yi_s  = int(np.argmin(np.abs(ys - y_val)))
                row   = np.ma.filled(data[yi_s, :].astype(float), np.nan)
                values = [None if np.isnan(v) else float(v) for v in row]
                return jsonify({
                    "axis_name":   x_coord.name(),
                    "axis_units":  str(x_coord.units),
                    "axis_values": xs.tolist(),
                    "values":      values,
                    "units":       str(cube.units),
                    "name":        cube.name(),
                    "x_val":       float(xs[int(np.argmin(np.abs(xs - x_val)))]),
                    "y_val":       float(ys[yi_s]),
                })
            else:
                xi_s  = int(np.argmin(np.abs(xs - x_val)))
                col   = np.ma.filled(data[:, xi_s].astype(float), np.nan)
                values = [None if np.isnan(v) else float(v) for v in col]
                return jsonify({
                    "axis_name":   y_coord.name(),
                    "axis_units":  str(y_coord.units),
                    "axis_values": ys.tolist(),
                    "values":      values,
                    "units":       str(cube.units),
                    "name":        cube.name(),
                    "x_val":       float(xs[xi_s]),
                    "y_val":       float(ys[int(np.argmin(np.abs(ys - y_val)))]),
                })

        # ── Non-spatial (extra dim) series ─────────────────────────────────────
        if series_axis:
            match = next((c for c in extra_coords if c.name() == series_axis), None)
            series_coord = match if match else extra_coords[-1]
        else:
            series_coord = extra_coords[-1]

        # Build indexing tuple: fix all extra dims except the series dim
        idx_tuple = []
        for fc in dim_coords:
            if fc.name() in (y_coord.name(), x_coord.name()):
                idx_tuple.append(slice(None))
            elif fc.name() == series_coord.name():
                idx_tuple.append(slice(None))
            else:
                c_spec  = constraints.get(fc.name(), {})
                lo      = (c_spec.get("range") or [None])[0]
                n_pts   = len(fc.points)
                fix_idx = int(lo) if (lo is not None and 0 <= int(lo) < n_pts) else n_pts // 2
                idx_tuple.append(fix_idx)

        sliced = cube[tuple(idx_tuple)]

        # ── Cache check ────────────────────────────────────────────────────────
        _ckey = (
            cube_index,
            json.dumps(constraints, sort_keys=True, default=str),
            series_axis or "",
            xi, yi,
        )
        if _ckey in loc_series_cache:
            return jsonify(loc_series_cache[_ckey])

        # Clamp spatial indices to the sliced cube shape
        ny_raw, nx_raw = sliced.shape[-2], sliced.shape[-1]
        yi_c = min(yi, ny_raw - 1)
        xi_c = min(xi, nx_raw - 1)

        # Vectorised extraction — single disk read for lazy cubes
        sliced_idx = tuple(slice(None) for _ in range(sliced.ndim - 2)) + (yi_c, xi_c)
        sliced_pt  = sliced[sliced_idx]
        raw        = np.ma.filled(sliced_pt.data, np.nan).astype(float)
        series_arr = raw.flatten()
        series_vals = [None if np.isnan(v) else float(v) for v in series_arr]

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

        _payload = {
            "axis_name":   series_coord.name(),
            "axis_units":  str(series_coord.units),
            "axis_values": axis_vals,
            "values":      series_vals,
            "units":       str(cube.units),
            "name":        cube.name(),
            "x_val":       float(xpts[xi]),
            "y_val":       float(ypts[yi]),
        }
        loc_series_cache[_ckey] = _payload
        return jsonify(_payload)

    except Exception as exc:
        logger.exception("Location series failed")
        return jsonify({"error": str(exc)}), 500
