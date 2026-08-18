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
# GRIB support helpers
# ──────────────────────────────────────────────────────────────────────────────

# All GRIB file extensions recognised by the file browser and load_file.
_GRIB_EXTS = {".grb", ".grib", ".grib1", ".grib2", ".grb1", ".grb2"}

# Suppress iris / iris_grib deprecation warnings globally.
warnings.filterwarnings("ignore", category=FutureWarning, module="iris")
warnings.filterwarnings("ignore", category=FutureWarning, module="iris_grib")
warnings.filterwarnings("ignore", category=DeprecationWarning, module="iris_grib")
try:
    from iris.exceptions import IrisVagueMetadataWarning
    warnings.filterwarnings("ignore", category=IrisVagueMetadataWarning)
except ImportError:
    pass

_GRIB_PATCH_APPLIED = False


def _patch_iris_grib_translation() -> None:
    """
    Apply a suite of monkey-patches to iris_grib._grib2_convert to make GRIB/
    GRIB2 loading as resilient as possible.  Each patch catches a known class
    of TranslationError and substitutes a safe fallback rather than aborting
    the entire file load.

    Patches applied
    ───────────────
    1. ``_get_surface_value``
       Returns None instead of raising when the Second Fixed Surface has a
       missing scaled value (typeOfSecondFixedSurface = 255 / _MDI).
       Valid GRIB2 — just means a single-level field (e.g. T at 850 hPa).

    2. ``reference_time_coord``
       Falls back to ``"forecast_reference_time"`` for unknown
       significanceOfReferenceTime codes (anything outside {0,1,2,3}).
       Common in reanalysis / climate files using vendor-specific codes.

    3. ``scanning_mode``
       Treats unsupported alternative-row scanning mode as if it were the
       standard mode (i_alternative=False).  Many operational centres encode
       fields with this flag set but the data is still readable.

    4. ``source_of_grid_definition``
       Ignores non-zero sourceOfGridDefinition values (e.g. pre-defined grids
       in operational systems) rather than raising.

    5. ``grid_definition_section``
       Wraps the entire section in a try/except so that a single unsupported
       grid type does not abort loading — the message is skipped with a
       warning instead of crashing.
    """
    global _GRIB_PATCH_APPLIED
    if _GRIB_PATCH_APPLIED:
        return

    try:
        import iris_grib._grib2_convert as _g2c
        from iris.exceptions import TranslationError as _TE

        # ── Patch 1: _get_surface_value ──────────────────────────────────────
        # Missing Second Fixed Surface (typeOfSecondFixedSurface = 255) is
        # valid and simply means a single-level field.  Return None so the
        # caller skips the upper bound and treats it as a scalar level.
        _orig_gsv = _g2c._get_surface_value

        def _lenient_get_surface_value(section, sub_item, warn_only=False):
            try:
                return _orig_gsv(section, sub_item, warn_only=warn_only)
            except _TE as exc:
                logger.debug(
                    "iris_grib [patch-1] _get_surface_value('%s') → None: %s",
                    sub_item, exc,
                )
                return None   # treat missing surface as absent

        _g2c._get_surface_value = _lenient_get_surface_value
        logger.debug("iris_grib: patch-1 (_get_surface_value) applied")

        # ── Patch 2: reference_time_coord ────────────────────────────────────
        # Unknown significanceOfReferenceTime codes (values outside {0,1,2,3})
        # appear in vendor-specific GRIB2 files.  Fall back gracefully to
        # "forecast_reference_time" instead of raising.
        _orig_rtc = _g2c.reference_time_coord

        def _lenient_reference_time_coord(section):
            try:
                return _orig_rtc(section)
            except _TE as exc:
                logger.debug(
                    "iris_grib [patch-2] reference_time_coord → fallback: %s", exc
                )
                try:
                    from datetime import datetime as _dt
                    from cf_units import Unit as _Unit
                    from iris.coords import DimCoord as _DC
                    dt = _dt(
                        section["year"], section["month"], section["day"],
                        section["hour"], section["minute"], section["second"],
                    )
                    unit = _Unit("hours since epoch", calendar="gregorian")
                    return _DC(
                        float(unit.date2num(dt)),
                        standard_name="forecast_reference_time",
                        units=unit,
                    )
                except Exception as inner:
                    logger.debug(
                        "iris_grib [patch-2] fallback coord also failed: %s", inner
                    )
                    return None

        _g2c.reference_time_coord = _lenient_reference_time_coord
        logger.debug("iris_grib: patch-2 (reference_time_coord) applied")

        # ── Patch 3: scanning_mode ────────────────────────────────────────────
        # Some operational centres set the i_alternative scanning bit but the
        # data are still in the standard row order.  Clear the offending bit
        # and retry, which gives us the standard scanning mode.
        _orig_sm = _g2c.scanning_mode

        def _lenient_scanning_mode(scanningMode):
            try:
                return _orig_sm(scanningMode)
            except _TE as exc:
                logger.debug(
                    "iris_grib [patch-3] scanning_mode(0x%02x) → clearing "
                    "i_alternative bit: %s", scanningMode, exc
                )
                return _orig_sm(scanningMode & ~0x10)

        _g2c.scanning_mode = _lenient_scanning_mode
        logger.debug("iris_grib: patch-3 (scanning_mode) applied")

        # ── Patch 4: source_of_grid_definition ───────────────────────────────
        # Non-zero sourceOfGridDefinition means a pre-defined grid from an
        # operational system.  iris_grib raises; we log and continue so that
        # the rest of the section can still be parsed.
        if hasattr(_g2c, "source_of_grid_definition"):
            _orig_sgd = _g2c.source_of_grid_definition

            def _lenient_source_of_grid_definition(section):
                try:
                    return _orig_sgd(section)
                except _TE as exc:
                    logger.debug(
                        "iris_grib [patch-4] source_of_grid_definition → "
                        "ignoring non-standard grid source: %s", exc
                    )

            _g2c.source_of_grid_definition = _lenient_source_of_grid_definition
            logger.debug("iris_grib: patch-4 (source_of_grid_definition) applied")

        # ── Patch 5: grid_definition_section ─────────────────────────────────
        # Wrap the entire grid section handler so that any remaining
        # unsupported grid type is caught at the message level rather than
        # propagating up to kill the whole file load.
        _orig_gds = _g2c.grid_definition_section

        def _lenient_grid_definition_section(section, metadata):
            try:
                return _orig_gds(section, metadata)
            except (_TE, ValueError, KeyError) as exc:
                logger.debug(
                    "iris_grib [patch-5] grid_definition_section → skipping "
                    "unsupported grid type: %s", exc
                )

        _g2c.grid_definition_section = _lenient_grid_definition_section
        logger.debug("iris_grib: patch-5 (grid_definition_section) applied")

        _GRIB_PATCH_APPLIED = True
        logger.info("iris_grib: all GRIB2 resilience patches applied successfully")

    except Exception as exc:
        logger.warning(
            "iris_grib translation patches could not be applied "
            "(iris_grib not installed or API changed): %s", exc
        )


def _iris_load_quiet(path_str: str) -> "iris.cube.CubeList":
    """iris.load() with FutureWarning / DeprecationWarning suppressed."""
    with warnings.catch_warnings():
        warnings.filterwarnings("ignore", category=FutureWarning)
        warnings.filterwarnings("ignore", category=DeprecationWarning)
        return iris.load(path_str)


def _load_grib_safe(path_str: str) -> "iris.cube.CubeList":
    """
    Load a GRIB/GRIB2 file with multiple layers of error resilience.

    Strategy
    ────────
    1. **Fast path** — ``iris.load()`` after all patches have been applied.
       Works for the vast majority of well-formed GRIB/GRIB2 files.

    2. **Per-message fallback** — if a TranslationError still leaks through,
       iterate ``iris_grib.load_cubes()`` as a generator and collect whatever
       cubes succeed, skipping bad messages.  Logs a summary of skipped
       message counts grouped by exception class for easier diagnosis.

    3. **Last resort** — if even the generator fails catastrophically, return
       an empty CubeList with a clear error log rather than crashing the app.
    """
    from iris.cube import CubeList
    from iris.exceptions import TranslationError

    # ── Fast path ──────────────────────────────────────────────────────────
    try:
        return _iris_load_quiet(path_str)
    except TranslationError as exc:
        logger.warning(
            "GRIB fast-path raised TranslationError after patches (%s); "
            "switching to per-message load.", exc
        )
    except Exception as exc:
        logger.warning(
            "GRIB fast-path raised unexpected error (%s: %s); "
            "switching to per-message load.", type(exc).__name__, exc
        )

    # ── Per-message fallback ────────────────────────────────────────────────
    try:
        import iris_grib
        cubes = CubeList()
        skipped: dict = {}  # error class → count

        gen = iris_grib.load_cubes(path_str)
        while True:
            try:
                cubes.append(next(gen))
            except StopIteration:
                break
            except (TranslationError, ValueError, KeyError, NotImplementedError) as msg_err:
                key = type(msg_err).__name__
                skipped[key] = skipped.get(key, 0) + 1
                logger.debug("Skipped GRIB message (%s): %s", key, msg_err)
            except Exception as msg_err:
                key = type(msg_err).__name__
                skipped[key] = skipped.get(key, 0) + 1
                logger.debug(
                    "Skipped GRIB message (unexpected %s): %s", key, msg_err
                )

        if skipped:
            summary = ", ".join(
                f"{v}\u00d7{k}" for k, v in sorted(skipped.items())
            )
            logger.warning(
                "GRIB per-message load: skipped %d message(s) [%s], "
                "recovered %d cube(s).",
                sum(skipped.values()), summary, len(cubes),
            )
        elif cubes:
            logger.info(
                "GRIB per-message load recovered %d cube(s) with no errors.",
                len(cubes),
            )

        return cubes

    except Exception as exc2:
        logger.error(
            "GRIB per-message load also failed (%s: %s). "
            "Returning empty CubeList.",
            type(exc2).__name__, exc2,
        )
        return CubeList()


# ──────────────────────────────────────────────────────────────────────────────
# Public API
# ──────────────────────────────────────────────────────────────────────────────

def _merge_cubelist(cubes: "iris.cube.CubeList") -> "iris.cube.CubeList":
    """
    Attempt to merge cubes that share the same name/metadata but differ only
    in one or more scalar coordinates (e.g. GRIB2 pressure levels, ensemble
    members, forecast times).

    ``iris.cube.CubeList.merge()`` detects scalar aux_coords that vary across
    cubes and promotes them into a new dimension, turning N single-level cubes
    into one cube with a ``pressure`` (or equivalent) dimension.

    Strategy
    ────────
    1. Group cubes by their canonical name (``cube.name()``).
    2. For groups with > 1 member, attempt ``CubeList(group).merge()``.
       • On success  → replace the group with the merged cube(s).
       • On failure  → keep the originals and log a warning.
    3. Single-member groups are passed through unchanged.

    The returned CubeList is re-indexed so ``cube.index`` remains consistent
    with the CubeList position used by the rest of the app.
    """
    from iris.cube import CubeList
    import iris.util

    if not cubes:
        return cubes

    # Group by canonical name
    groups: dict[str, list] = {}
    for cube in cubes:
        key = cube.name() or "(unnamed)"
        groups.setdefault(key, []).append(cube)

    merged: list = []
    for name, group in groups.items():
        if len(group) == 1:
            merged.append(group[0])
            continue

        # Attempt to unify time units before merging (required by iris.merge)
        try:
            iris.util.unify_time_units(group)
        except Exception:
            pass

        try:
            result = CubeList(group).merge()
            n_in, n_out = len(group), len(result)
            if n_out < n_in:
                logger.info(
                    "Merged %d '%s' cube(s) → %d cube(s) (gained level/time dim)",
                    n_in, name, n_out,
                )
            merged.extend(result)
        except Exception as exc:
            logger.debug(
                "Could not merge %d '%s' cube(s): %s — keeping originals",
                len(group), name, exc,
            )
            merged.extend(group)

    return CubeList(merged)


def resolve_paths(path_input: str | list[str] | Path | list[Path]) -> list[Path]:
    """
    Resolves a single string (glob, comma-separated list, or single path),
    or a list of paths, into a list of existing Path objects.
    """
    import glob
    resolved = []
    
    # Convert single input or list to a list of strings
    if isinstance(path_input, Path):
        inputs = [str(path_input)]
    elif isinstance(path_input, list):
        inputs = [str(p) for p in path_input]
    elif isinstance(path_input, str):
        # Support comma-separated strings
        if "," in path_input:
            inputs = [p.strip() for p in path_input.split(",")]
        else:
            inputs = [path_input.strip()]
    else:
        inputs = []

    for item in inputs:
        if not item:
            continue
        # Handle glob wildcard expansion
        if any(char in item for char in ["*", "?", "[", "]"]):
            matches = glob.glob(item, recursive=True)
            for m in sorted(matches):
                p = Path(m)
                if p.is_file():
                    resolved.append(p)
        else:
            p = Path(item)
            if p.is_file():
                resolved.append(p)
            elif p.is_dir():
                pass
    return resolved


def load_files(paths: str | list[str] | Path | list[Path]) -> iris.cube.CubeList:
    """
    Load one or more NetCDF / PP / GRIB / GRIB2 files and return a unified CubeList.

    After loading, cubes that share the same name but differ only in scalar
    coordinates are automatically merged.
    """
    resolved_paths = resolve_paths(paths)
    if not resolved_paths:
        raise FileNotFoundError(f"No valid files found for: {paths}")

    from iris.cube import CubeList
    all_cubes = CubeList()

    for p in resolved_paths:
        ext = p.suffix.lower()
        if ext in _GRIB_EXTS:
            try:
                import iris_grib  # noqa: F401  registers the GRIB format handler
            except ImportError:
                raise ImportError(
                    "GRIB/GRIB2 support requires the 'iris-grib' package.\n"
                    "Install it with:  pip install iris-grib eccodes"
                ) from None
            _patch_iris_grib_translation()
            logger.info("Loading GRIB: %s", p)
            cubes = _load_grib_safe(str(p))
        else:
            logger.info("Loading: %s", p)
            cubes = _iris_load_quiet(str(p))

        logger.info("Loaded %d cube(s) from %s", len(cubes), p.name)
        all_cubes.extend(cubes)

    # Merge cubes that share the same variable name but differ only in scalar
    # coordinates (e.g. pressure levels in GRIB2 or time across multiple files).
    merged_cubes = _merge_cubelist(all_cubes)
    logger.info("After merging all files: %d cube(s)", len(merged_cubes))

    return merged_cubes


def load_file(path: str | Path) -> iris.cube.CubeList:
    """Backward compatibility wrapper for load_files."""
    return load_files(path)



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


def _normalise_longitude(
    data: np.ndarray,
    x_pts: np.ndarray,
) -> tuple[np.ndarray, np.ndarray]:
    """
    Re-order a 2-D data array (ny, nx) and its longitude axis so that
    longitudes are monotonically increasing in the -180 to +180 range.

    This is needed for GRIB/GRIB2 data whose longitude coordinate runs
    0 → 360 (or 0 → 360 with iris normalising values > 180 to negative
    without reordering the columns).  Without this correction the plot
    shows a blank strip from 0–180 E and the coastline overlay is broken.

    Conditions that trigger the fix
    ────────────────────────────────
    * x_pts spans > 180 degrees  AND  x_pts.max() > 180
      → classic 0–360 grid: wrap values > 180 to value − 360 and roll.
    * x_pts are already negative on the left side but NOT sorted
      (e.g. iris produced [-180 … 0, 180 … 360] from a 0-360 source)
      → sort the columns by ascending longitude value.

    Returns the (possibly reordered) data and longitude arrays.
    """
    if x_pts.ndim != 1 or x_pts.size < 2:
        return data, x_pts

    lon_range = float(x_pts.max()) - float(x_pts.min())

    # ── Case 1: 0-360 grid (max > 180, range ≈ 360) ────────────────────────
    if x_pts.max() > 180.0 and lon_range > 180.0:
        # Convert to -180..180
        new_lons = np.where(x_pts > 180.0, x_pts - 360.0, x_pts)
        # Sort columns by the new longitude values
        order = np.argsort(new_lons)
        logger.debug(
            "Longitude normalisation: 0-360 → -180/180 "
            "(roll by %d columns out of %d)",
            int(np.sum(x_pts > 180.0)), len(x_pts),
        )
        return data[:, order], new_lons[order]

    # ── Case 2: already -180..180 but non-monotonic ─────────────────────────
    if not np.all(np.diff(x_pts) > 0):  # not strictly increasing
        order = np.argsort(x_pts)
        logger.debug(
            "Longitude normalisation: non-monotonic -180/180 axis → sorted"
        )
        return data[:, order], x_pts[order]

    # No fix needed
    return data, x_pts


def _is_longitude_coord(coord) -> bool:
    """Return True when a coordinate is clearly a geographic longitude.

    We check standard_name / name first (most reliable), then fall back to
    the unit string.  We deliberately avoid ``units.is_convertible`` because
    cf_units considers ``degrees_north`` convertible from ``degrees_east``,
    which would cause latitude coordinates to be misidentified.
    """
    if coord is None:
        return False
    _LON_STANDARD = {
        "longitude", "grid_longitude",
        "projection_x_coordinate",
    }
    _LAT_STANDARD = {
        "latitude", "grid_latitude",
        "projection_y_coordinate",
    }
    try:
        sn = coord.standard_name or ""
        if sn in _LON_STANDARD:
            return True
        if sn in _LAT_STANDARD:
            return False   # definitely not longitude
        nm = coord.name()
        if nm in _LON_STANDARD or nm in {"x", "longitude"}:
            return True
        if nm in _LAT_STANDARD or nm in {"y", "latitude"}:
            return False
        # Last resort: check unit string (not convertibility)
        u = str(coord.units).lower()
        if "east" in u or u in ("degree_e", "degrees_e", "degreee", "degrees_east"):
            return True
    except Exception:
        pass
    return False


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
    # Track what was fixed for each extra dimension (for title display)
    fixed_coords: list[dict] = []

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

                # Record fixed coord info for the title
                if lo_idx == hi_idx:
                    raw_val = pts[lo_idx]
                    if _is_time_coord(coord):
                        try:
                            display_val = _fmt_date(coord.units.num2date(raw_val))
                        except Exception:
                            display_val = str(raw_val)
                    else:
                        display_val = f"{float(raw_val):.4g}"
                    fixed_coords.append({
                        "name": coord_name,
                        "value": display_val,
                        "units": str(coord.units),
                        "index": lo_idx,
                        "total": int(len(pts)),
                    })
                else:
                    fixed_coords.append({
                        "name": coord_name,
                        "value": f"{processor}[{lo_idx}:{hi_idx}]",
                        "units": str(coord.units),
                        "index": lo_idx,
                        "total": int(len(pts)),
                    })
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

                # Record fixed coord info for the title
                nearest_val = pts[int(np.argmin(np.abs(pts - value)))]
                if _is_time_coord(coord):
                    try:
                        display_val = _fmt_date(coord.units.num2date(nearest_val))
                    except Exception:
                        display_val = str(nearest_val)
                else:
                    display_val = f"{float(nearest_val):.4g}"
                fixed_coords.append({
                    "name": coord_name,
                    "value": display_val,
                    "units": str(coord.units),
                    "index": int(np.argmin(np.abs(pts - value))),
                    "total": int(len(pts)),
                })
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

    # ── Longitude normalisation (GRIB2 0-360 → -180/180) ────────────────────
    # GRIB/GRIB2 files store longitudes as 0–360.  When iris exposes them in
    # the -180–180 range (or leaves them as 0–360), the data columns are not
    # automatically reordered, producing a blank strip over 0–180 E and
    # broken coastline overlays.  Detect and fix this here.
    if _is_longitude_coord(raw_x) and raw_x is not None:
        try:
            x_pts = raw_x.points.flatten()
            if x_pts.size == nx:   # safety: sizes must match
                data, new_x_pts = _normalise_longitude(data, x_pts)
                if not np.array_equal(new_x_pts, x_pts):
                    # Re-wrap the coordinate so _axis_info uses correct values
                    import iris.coords as _ic
                    raw_x = _ic.AuxCoord(
                        new_x_pts,
                        standard_name=raw_x.standard_name,
                        long_name=raw_x.long_name,
                        var_name=raw_x.var_name,
                        units=raw_x.units,
                    )
                    nx = data.shape[1]  # shape unchanged, but keep in sync
        except Exception as _lon_exc:
            logger.debug("Longitude normalisation skipped: %s", _lon_exc)

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
        "fixed_coords": fixed_coords,
    }

    return data, meta
