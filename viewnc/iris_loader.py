"""
iris_loader.py – utilities for loading and introspecting iris CubeList.
Supports NetCDF, PP and GRIB2 files.
"""
from __future__ import annotations

import json
import logging
from pathlib import Path
from typing import Any

import iris
import iris.analysis as ia
import numpy as np
import warnings

# Use microsecond-precision dates (avoids iris FutureWarning about legacy precision)
try:
    iris.FUTURE.date_microseconds = True
except AttributeError:
    pass  # older iris versions don't have this flag

# Suppress any remaining cf_units date-precision warnings
warnings.filterwarnings("ignore", category=FutureWarning, module="iris")

logger = logging.getLogger(__name__)


# ──────────────────────────────────────────────────────────────────────────────
# Helpers
# ──────────────────────────────────────────────────────────────────────────────

def _is_time_coord(coord) -> bool:
    """Return True if this coordinate represents a time axis."""
    try:
        units_str = str(coord.units).lower()
        return (
            coord.standard_name == "time"
            or coord.name().lower() in {"time", "t"}
            or " since " in units_str          # e.g. "days since 1970-01-01"
            or coord.units.is_convertible("days since epoch")
        )
    except Exception:
        return False


def _fmt_date(dt) -> str:
    """Format a cftime or datetime object as a compact ISO-style string."""
    try:
        # cftime objects expose year/month/day/hour/minute/second
        if dt.hour == 0 and dt.minute == 0 and dt.second == 0:
            return f"{dt.year:04d}-{dt.month:02d}-{dt.day:02d}"
        return f"{dt.year:04d}-{dt.month:02d}-{dt.day:02d} {dt.hour:02d}:{dt.minute:02d}"
    except AttributeError:
        return str(dt)


def _coord_summary(coord) -> dict:
    """Return a JSON-serialisable summary of a single iris Coord."""
    pts = coord.points
    info: dict[str, Any] = {
        "name": coord.name(),
        "standard_name": coord.standard_name or "",
        "units": str(coord.units),
        "shape": list(pts.shape),
        "dtype": str(pts.dtype),
    }
    if pts.size == 0:
        info.update({"min": None, "max": None, "values": [], "size": 0})
    elif _is_time_coord(coord) and (
        np.issubdtype(pts.dtype, np.floating) or np.issubdtype(pts.dtype, np.integer)
    ):
        # Convert numeric time values → human-readable date strings
        info["min"] = float(np.nanmin(pts))
        info["max"] = float(np.nanmax(pts))
        info["size"] = int(pts.size)
        try:
            dates = [_fmt_date(coord.units.num2date(v)) for v in pts.flatten()]
            info["values"] = dates  # always include for time (used by sliders)
            info["is_time"] = True
        except Exception as exc:
            logger.warning("Time conversion failed for %s: %s", coord.name(), exc)
            info["values"] = pts.flatten().tolist() if pts.size <= 100 else None
    elif np.issubdtype(pts.dtype, np.floating) or np.issubdtype(pts.dtype, np.integer):
        info["min"] = float(np.nanmin(pts))
        info["max"] = float(np.nanmax(pts))
        # Only include explicit list for small coords (≤ 100 points)
        if pts.size <= 100:
            info["values"] = pts.flatten().tolist()
        else:
            info["values"] = None  # let the UI build a range slider
        info["size"] = int(pts.size)
    else:
        info["values"] = pts.flatten().astype(str).tolist()[:100]
        info["size"] = int(pts.size)
    return info


def _cube_summary(cube, index: int) -> dict:
    """Return a JSON-serialisable summary for one iris Cube."""
    dim_coords = [_coord_summary(c) for c in cube.dim_coords]
    aux_coords = [_coord_summary(c) for c in cube.aux_coords]

    return {
        "index": index,
        "name": cube.name(),
        "standard_name": cube.standard_name or "",
        "long_name": cube.long_name or "",
        "var_name": cube.var_name or "",
        "units": str(cube.units),
        "shape": list(cube.shape),
        "ndim": cube.ndim,
        "dtype": str(cube.dtype),
        "dim_coords": dim_coords,
        "aux_coords": aux_coords,
        "attributes": {k: str(v) for k, v in cube.attributes.items()},
    }


# ──────────────────────────────────────────────────────────────────────────────
# Public API
# ──────────────────────────────────────────────────────────────────────────────

def load_file(path: str | Path) -> iris.cube.CubeList:
    """Load a NetCDF / PP / GRIB file and return a CubeList."""
    path = Path(path)
    logger.info("Loading %s", path)
    cubes = iris.load(str(path))
    logger.info("Loaded %d cube(s)", len(cubes))
    return cubes


def cubelist_metadata(cubes: iris.cube.CubeList) -> list[dict]:
    """Return a list of metadata dicts, one per cube."""
    return [_cube_summary(c, i) for i, c in enumerate(cubes)]


def _safe_constraint(cube, coord_name: str, numeric_value: float):
    """
    Build an iris.Constraint that matches the nearest point on a coord
    without using num2date (works for time, level, or any numeric coord).
    """
    coord = cube.coord(coord_name)
    pts = coord.points
    nearest = pts[int(np.argmin(np.abs(pts - numeric_value)))]

    # Use a lambda constraint to avoid datetime conversion issues
    return iris.Constraint(**{coord_name: lambda cell: cell == nearest})


def _find_spatial_coords(cube, cubes: "iris.cube.CubeList | None" = None):
    """
    Try to find reasonable x (longitude-like) and y (latitude-like) coordinates
    from dim_coords first, then aux_coords, then sibling cubes in the CubeList.
    Returns (x_coord, y_coord) – either may be None.
    """
    lon_names = {"longitude", "grid_longitude", "x", "projection_x_coordinate"}
    lat_names = {"latitude", "grid_latitude", "y", "projection_y_coordinate"}

    all_coords = list(cube.dim_coords) + list(cube.aux_coords)

    x_coord = next((c for c in all_coords if c.name() in lon_names or
                    (c.standard_name or "") in lon_names or
                    (c.units.is_convertible("degrees_east"))), None)
    y_coord = next((c for c in all_coords if c.name() in lat_names or
                    (c.standard_name or "") in lat_names or
                    (c.units.is_convertible("degrees_north"))), None)

    # Fallback: look at sibling cubes in the CubeList
    if (x_coord is None or y_coord is None) and cubes is not None:
        ny = cube.shape[-2] if cube.ndim >= 2 else None
        nx = cube.shape[-1] if cube.ndim >= 1 else None
        for sib in cubes:
            if sib is cube:
                continue
            n = sib.name()
            pts = sib.data
            if x_coord is None and pts.ndim == 1 and pts.size == nx and (
                n in lon_names or (sib.standard_name or "") in lon_names or
                sib.units.is_convertible("degrees_east")
            ):
                # Wrap as a fake DimCoord-like object via iris AuxCoord
                import iris.coords as icoords
                x_coord = icoords.AuxCoord(
                    pts.data if hasattr(pts, 'data') else pts,
                    standard_name=sib.standard_name or None,
                    long_name=sib.long_name or n,
                    units=sib.units,
                )
            if y_coord is None and pts.ndim == 1 and pts.size == ny and (
                n in lat_names or (sib.standard_name or "") in lat_names or
                sib.units.is_convertible("degrees_north")
            ):
                import iris.coords as icoords
                y_coord = icoords.AuxCoord(
                    pts.data if hasattr(pts, 'data') else pts,
                    standard_name=sib.standard_name or None,
                    long_name=sib.long_name or n,
                    units=sib.units,
                )

    return x_coord, y_coord


# Map of processor name → iris analyser
_PROCESSORS = {
    "mean":   ia.MEAN,
    "std":    ia.STD_DEV,
    "min":    ia.MIN,
    "max":    ia.MAX,
    "sum":    ia.SUM,
    "median": ia.MEDIAN,
    "rms":    ia.RMS,
    "variance": ia.VARIANCE,
}


def extract_slice(
    cubes: "iris.cube.CubeList",
    cube_index: int,
    constraints: dict[str, Any],
) -> tuple[np.ndarray, dict]:
    """
    Extract a 2-D slice from a cube for plotting.

    Parameters
    ----------
    cubes       : CubeList from load_file()
    cube_index  : which cube to slice
    constraints : dict mapping coord name → {
                    "value": scalar (for point selection),
                    OR
                    "range": [lo, hi],  (for range-based collapse)
                    "processor": "mean"|"std"|"min"|"max"|"sum"|...
                  }

    Returns
    -------
    data   : 2-D numpy array  (y, x)
    meta   : dict with axis labels and value ranges
    """
    cube = cubes[cube_index]

    # ── Apply constraints (scalar or range-collapse) ────────────────────────
    sliced = cube
    for coord_name, spec in constraints.items():
        if spec is None:
            continue

        # Normalise spec: support legacy scalar value and new dict form
        if isinstance(spec, dict):
            val_range = spec.get("range")      # [lo, hi] indices or None
            scalar    = spec.get("value")
            processor = spec.get("processor", "mean")
        else:
            # Legacy: plain scalar
            val_range = None
            scalar    = spec
            processor = "mean"

        try:
            coord = sliced.coord(coord_name)
            if coord.ndim != 1:
                continue
            pts = coord.points

            if val_range is not None:
                # Range collapse: extract sub-range by index and apply processor
                lo_idx = int(val_range[0])
                hi_idx = int(val_range[1])
                # Clamp to valid index range
                lo_idx = max(0, min(lo_idx, len(pts) - 1))
                hi_idx = max(lo_idx, min(hi_idx, len(pts) - 1))

                # Determine the dimension index for this coord
                try:
                    dim_idx = sliced.coord_dims(coord)[0]
                except Exception:
                    continue

                # Slice the sub-range
                idx_slices = tuple(
                    slice(lo_idx, hi_idx + 1) if i == dim_idx else slice(None)
                    for i in range(sliced.ndim)
                )
                sub = sliced[idx_slices]

                # Collapse with processor
                analyser = _PROCESSORS.get(processor, ia.MEAN)
                try:
                    sliced = sub.collapsed(coord_name, analyser)
                except Exception as exc:
                    logger.warning("Collapse of %s with %s failed: %s; taking first index", coord_name, processor, exc)
                    sliced = sub[tuple(
                        0 if i == dim_idx else slice(None)
                        for i in range(sub.ndim)
                    )]
            else:
                # Single-point constraint (nearest)
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
            logger.warning("Constraint on %s=%s failed: %s", coord_name, spec, exc)

    # ── Collapse any remaining extra dims to get to 2D ──────────────────────
    while sliced.ndim > 2:
        sliced = sliced[0]   # take first index of leading dimension

    data = np.ma.filled(np.atleast_2d(sliced.data.squeeze()), np.nan).astype(float)

    # ── Build axis metadata ──────────────────────────────────────────────────
    ny, nx = data.shape

    # First try dim_coords for x and y
    dim_coords = sliced.dim_coords
    raw_x = dim_coords[-1] if len(dim_coords) >= 1 else None
    raw_y = dim_coords[-2] if len(dim_coords) >= 2 else None

    # If dim_coords didn't give us spatial info, try named spatial coords + sibling cubes
    if raw_x is None or raw_y is None:
        sx, sy = _find_spatial_coords(sliced, cubes)
        if raw_x is None and sx is not None and sx.points.size == nx:
            raw_x = sx
        if raw_y is None and sy is not None and sy.points.size == ny:
            raw_y = sy

    def _axis_info(coord, fallback_size: int) -> dict:
        if coord is None or coord.points.ndim > 1:
            # No coord found – return a plain integer index axis
            return {
                "name": "index",
                "units": "",
                "values": list(range(fallback_size)),
                "min": 0,
                "max": fallback_size - 1,
                "size": fallback_size,
            }
        pts = coord.points.flatten()
        return {
            "name": coord.name(),
            "units": str(coord.units),
            "values": pts.tolist() if pts.size <= 3600 else None,
            "min": float(pts.min()),
            "max": float(pts.max()),
            "size": int(pts.size),
        }

    # Compute vmin / vmax safely – nanmin/nanmax return NaN when ALL values
    # are masked (e.g. NCEP fill-value data), which is not valid JSON.
    def _safe_stat(fn, fallback):
        try:
            v = float(fn(data))
            return fallback if (np.isnan(v) or np.isinf(v)) else v
        except Exception:
            return fallback

    meta = {
        "x": _axis_info(raw_x, nx),
        "y": _axis_info(raw_y, ny),
        "units": str(sliced.units),
        "name": sliced.name(),
        "shape": list(data.shape),
        "vmin": _safe_stat(np.nanmin, 0.0) if data.size else 0.0,
        "vmax": _safe_stat(np.nanmax, 1.0) if data.size else 1.0,
    }

    return data, meta
