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
import numpy as np

logger = logging.getLogger(__name__)


# ──────────────────────────────────────────────────────────────────────────────
# Helpers
# ──────────────────────────────────────────────────────────────────────────────

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
        info.update({"min": None, "max": None, "values": []})
    elif np.issubdtype(pts.dtype, np.floating) or np.issubdtype(pts.dtype, np.integer):
        info["min"] = float(np.nanmin(pts))
        info["max"] = float(np.nanmax(pts))
        # Only include explicit list for small coords (≤ 100 points)
        if pts.size <= 100:
            info["values"] = pts.flatten().tolist()
        else:
            info["values"] = None  # let the UI build a range slider
    else:
        info["values"] = pts.flatten().astype(str).tolist()[:100]
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
    constraints : dict mapping coord name → scalar value (or None to use first)

    Returns
    -------
    data   : 2-D numpy array  (y, x)
    meta   : dict with axis labels and value ranges
    """
    cube = cubes[cube_index]

    # ── Apply scalar constraints (collapse extra dims) ──────────────────────
    sliced = cube
    for coord_name, value in constraints.items():
        if value is None:
            continue
        try:
            coord = sliced.coord(coord_name)
            if coord.ndim != 1:
                continue
            constraint = _safe_constraint(sliced, coord_name, float(value))
            result = sliced.extract(constraint)
            if result is None:
                # Fallback: index-based slicing
                dim_idx = cube.coord_dims(coord)[0]
                pts = coord.points
                idx = int(np.argmin(np.abs(pts - float(value))))
                sliced = sliced[tuple(
                    idx if i == dim_idx else slice(None)
                    for i in range(sliced.ndim)
                )]
            else:
                sliced = result
        except Exception as exc:
            logger.warning("Constraint on %s=%s failed: %s", coord_name, value, exc)

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

    meta = {
        "x": _axis_info(raw_x, nx),
        "y": _axis_info(raw_y, ny),
        "units": str(sliced.units),
        "name": sliced.name(),
        "shape": list(data.shape),
        "vmin": float(np.nanmin(data)) if data.size else 0,
        "vmax": float(np.nanmax(data)) if data.size else 1,
    }

    return data, meta
