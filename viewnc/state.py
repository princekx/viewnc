"""
state.py – Shared mutable application state for viewnc.

All blueprints import from here so every route operates on the same
in-memory cube list without circular imports.
"""
from __future__ import annotations

# ── Global state ──────────────────────────────────────────────────────────────
# Mutated by /api/load; read by every other route.
app_state: dict = {
    "filepath": None,   # str | list[str] | None
    "cubes":    None,   # iris.cube.CubeList | None
    "metadata": None,   # list[dict] | None
}

# ── Location-series response cache ────────────────────────────────────────────
# Keyed by (cube_index, constraints_json, series_axis, xi, yi).
# Cleared by /api/load when a new file is loaded.
loc_series_cache: dict = {}
