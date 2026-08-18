"""
routes/export.py – Data export endpoints (CSV, NetCDF, series CSV/NetCDF).

Blueprint: ``export_bp``
"""
from __future__ import annotations

import logging

import numpy as np
from flask import Blueprint, jsonify, request, send_file, Response

from viewnc.iris_loader import extract_slice
from viewnc.state import app_state

logger = logging.getLogger(__name__)

export_bp = Blueprint("export", __name__)


@export_bp.route("/api/export/csv", methods=["POST"])
def api_export_csv():
    """
    Stream the current 2-D slice as a UTF-8 CSV file.

    Body JSON: same as /api/slice (cube_index, constraints).
    Response: attachment  viewnc_<name>.csv
    """
    if app_state["cubes"] is None:
        return jsonify({"error": "No file loaded"}), 400

    body = request.get_json(force=True)
    cube_index  = int(body.get("cube_index", 0))
    constraints = body.get("constraints", {})

    try:
        import csv

        data, meta = extract_slice(app_state["cubes"], cube_index, constraints)
        cube = app_state["cubes"][cube_index]

        ny, nx = data.shape
        x_vals  = meta["x"].get("values") or list(range(nx))
        y_vals  = (meta.get("y") or {}).get("values") or list(range(ny))
        x_name  = meta["x"].get("name", "x")
        y_name  = (meta.get("y") or {}).get("name", "y")
        x_units = meta["x"].get("units", "")
        y_units = (meta.get("y") or {}).get("units", "")
        cube_units = meta.get("units", "")

        def _generate():
            import io
            buf    = io.StringIO()
            writer = csv.writer(buf)

            writer.writerow([f"# viewnc export"])
            writer.writerow([f"# variable: {cube.name()}"])
            writer.writerow([f"# units: {cube_units}"])
            writer.writerow([f"# shape: {ny} x {nx}"])
            writer.writerow([f"# x_axis: {x_name} ({x_units})"])
            writer.writerow([f"# y_axis: {y_name} ({y_units})"])

            x_header = [f"{y_name}\\{x_name}"] + [str(v) for v in x_vals[:nx]]
            writer.writerow(x_header)

            for i, row in enumerate(data.tolist()):
                y_label = str(y_vals[i]) if i < len(y_vals) else str(i)
                csv_row = [y_label] + [
                    "" if (v is None or (isinstance(v, float) and v != v))
                    else f"{v:.6g}"
                    for v in row
                ]
                writer.writerow(csv_row)

            yield buf.getvalue()

        safe_name = (cube.name() or "slice").replace(" ", "_").replace("/", "-")
        filename  = f"viewnc_{safe_name}.csv"
        return Response(
            _generate(),
            mimetype="text/csv",
            headers={"Content-Disposition": f'attachment; filename="{filename}"'},
        )
    except Exception as exc:
        logger.exception("CSV export failed")
        return jsonify({"error": str(exc)}), 500


@export_bp.route("/api/export/netcdf", methods=["POST"])
def api_export_netcdf():
    """
    Export the current 2-D slice as a NetCDF4 file using iris.

    Body JSON: same as /api/slice (cube_index, constraints).
    Response: attachment  viewnc_<name>.nc
    """
    if app_state["cubes"] is None:
        return jsonify({"error": "No file loaded"}), 400

    body = request.get_json(force=True)
    cube_index  = int(body.get("cube_index", 0))
    constraints = body.get("constraints", {})

    try:
        import tempfile
        import iris
        import iris.analysis as _ia
        from viewnc.iris_loader import _safe_constraint, _PROCESSORS

        cube   = app_state["cubes"][cube_index]
        sliced = cube

        for coord_name, spec in constraints.items():
            if spec is None:
                continue
            if isinstance(spec, dict):
                val_range = spec.get("range")
                scalar    = spec.get("value")
                processor = spec.get("processor", "mean")
            else:
                val_range = None
                scalar    = spec
                processor = "mean"
            try:
                coord = sliced.coord(coord_name)
                if coord.ndim != 1:
                    continue
                pts = coord.points
                if val_range is not None:
                    lo_idx  = max(0, min(int(val_range[0]), len(pts) - 1))
                    hi_idx  = max(lo_idx, min(int(val_range[1]), len(pts) - 1))
                    try:
                        dim_idx = sliced.coord_dims(coord)[0]
                    except Exception:
                        continue
                    idx_slices = tuple(
                        slice(lo_idx, hi_idx + 1) if i == dim_idx else slice(None)
                        for i in range(sliced.ndim)
                    )
                    sub      = sliced[idx_slices]
                    analyser = _PROCESSORS.get(processor, _ia.MEAN)
                    try:
                        sliced = sub.collapsed(coord_name, analyser)
                    except Exception:
                        sliced = sub[tuple(
                            0 if i == dim_idx else slice(None)
                            for i in range(sub.ndim)
                        )]
                else:
                    value      = float(scalar) if scalar is not None else float(pts[0])
                    constraint = _safe_constraint(sliced, coord_name, value)
                    result     = sliced.extract(constraint)
                    if result is None:
                        dim_idx = sliced.coord_dims(coord)[0]
                        idx     = int(np.argmin(np.abs(pts - value)))
                        sliced  = sliced[tuple(
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
        filename  = f"viewnc_{safe_name}.nc"
        return send_file(
            tmp_path,
            mimetype="application/x-netcdf",
            as_attachment=True,
            download_name=filename,
        )
    except Exception as exc:
        logger.exception("NetCDF export failed")
        return jsonify({"error": str(exc)}), 500


@export_bp.route("/api/export/series_csv", methods=["POST"])
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

        axis_name  = body.get("axis_name",  "index")
        axis_units = body.get("axis_units", "")
        data_units = body.get("units",      "")
        var_name   = body.get("name",       "variable")

        buf    = io.StringIO()
        writer = csv.writer(buf)

        writer.writerow(["# viewnc location-series export"])
        writer.writerow([f"# variable: {var_name}  [{data_units}]"])
        writer.writerow([f"# axis: {axis_name}  [{axis_units}]"])
        writer.writerow([""])

        axis_vals = series_list[0].get("axis_values", [])
        labels    = [s.get("label", f"series_{i}") for i, s in enumerate(series_list)]

        header = [f"{axis_name} ({axis_units})" if axis_units else axis_name] + labels
        writer.writerow(header)

        for i, av in enumerate(axis_vals):
            row = [str(av)]
            for s in series_list:
                v   = s.get("values", [])
                val = v[i] if i < len(v) else ""
                row.append(
                    "" if val is None
                    else f"{val:.6g}" if isinstance(val, (int, float))
                    else str(val)
                )
            writer.writerow(row)

        csv_bytes = buf.getvalue().encode("utf-8")
        safe_name = var_name.replace(" ", "_").replace("/", "-")
        filename  = f"viewnc_{safe_name}_series.csv"
        return Response(
            csv_bytes,
            mimetype="text/csv",
            headers={"Content-Disposition": f'attachment; filename="{filename}"'},
        )
    except Exception as exc:
        logger.exception("Series CSV export failed")
        return jsonify({"error": str(exc)}), 500


@export_bp.route("/api/export/series_netcdf", methods=["POST"])
def api_export_series_netcdf():
    """
    Export one or more 1-D location series as a NetCDF4 file.

    Body JSON: same structure as /api/export/series_csv
        { axis_name, axis_units, units, name, series: [{label, axis_values, values}] }
    """
    body = request.get_json(force=True)
    series_list = body.get("series", [])
    if not series_list:
        return jsonify({"error": "No series data provided"}), 400

    axis_name  = body.get("axis_name",  "index")
    axis_units = body.get("axis_units", "")
    data_units = body.get("units",      "")
    var_name   = body.get("name",       "variable")

    try:
        import tempfile, os

        try:
            import netCDF4 as _nc
            _backend = "netCDF4"
        except ImportError:
            _backend = None

        raw_axis = series_list[0].get("axis_values", [])
        n        = len(raw_axis)

        def _to_float(v):
            try:
                return float(v)
            except (TypeError, ValueError):
                return None

        numeric_vals    = [_to_float(v) for v in raw_axis]
        axis_is_numeric = all(v is not None for v in numeric_vals)

        with tempfile.NamedTemporaryFile(suffix=".nc", delete=False) as tmp:
            tmp_path = tmp.name

        if _backend == "netCDF4":
            ds = _nc.Dataset(tmp_path, "w", format="NETCDF4")
            ds.title       = f"viewnc location series: {var_name}"
            ds.Conventions = "CF-1.8"
            ds.source      = "viewnc"

            dim_name = axis_name.replace(" ", "_")
            ds.createDimension(dim_name, n)

            if axis_is_numeric:
                ax = ds.createVariable(dim_name, "f8", (dim_name,))
                ax[:] = numeric_vals
                if axis_units:
                    ax.units = axis_units
                ax.long_name = axis_name
            else:
                ax = ds.createVariable(dim_name, "i4", (dim_name,))
                ax[:] = list(range(n))
                ax.long_name = axis_name
                ax.labels    = ",".join(str(v) for v in raw_axis)

            for i, s in enumerate(series_list):
                raw_label = s.get("label", f"series_{i}")
                safe  = (raw_label.replace("(", "").replace(")", "")
                         .replace(",", "").replace(" ", "_").replace(".", "p"))
                vname  = f"loc_{i}" if len(safe) > 40 else safe
                values = s.get("values", [])
                v      = ds.createVariable(vname, "f8", (dim_name,), fill_value=np.nan)
                v[:]      = [float(x) if x is not None else np.nan for x in values]
                v.units    = data_units
                v.location = raw_label
                v.long_name = f"{var_name} at {raw_label}"

            ds.close()

        else:
            from scipy.io import netcdf_file
            with netcdf_file(tmp_path, "w") as ds:
                ds.title   = f"viewnc location series: {var_name}"
                dim_name   = axis_name.replace(" ", "_") or "index"
                ds.createDimension(dim_name, n)
                ax    = ds.createVariable(dim_name, "f", (dim_name,))
                ax[:] = numeric_vals if axis_is_numeric else list(range(n))
                if axis_units:
                    ax.units = axis_units
                for i, s in enumerate(series_list):
                    raw_label = s.get("label", f"series_{i}")
                    values    = s.get("values", [])
                    v         = ds.createVariable(f"loc_{i}", "f", (dim_name,))
                    v[:]      = [float(x) if x is not None else np.nan for x in values]
                    v.units   = data_units
                    v.location = raw_label

        safe_name = var_name.replace(" ", "_").replace("/", "-")
        filename  = f"viewnc_{safe_name}_{axis_name}_series.nc"
        return send_file(
            tmp_path,
            mimetype="application/x-netcdf",
            as_attachment=True,
            download_name=filename,
        )

    except Exception as exc:
        logger.exception("Series NetCDF export failed")
        return jsonify({"error": str(exc)}), 500
