"""
routes/files.py – File-system browsing and cube loading endpoints.

Blueprint: ``files_bp``
Prefix:    (none — routes are /api/browse, /api/load, /api/metadata, /api/cube)
"""
from __future__ import annotations

import logging
import os
from pathlib import Path

from flask import Blueprint, jsonify, request

from viewnc.iris_loader import cubelist_metadata, load_files, resolve_paths
from viewnc.state import app_state, loc_series_cache

logger = logging.getLogger(__name__)

files_bp = Blueprint("files", __name__)

# Data file extensions shown in the browser
_DATA_EXTS = {".nc", ".pp", ".grb", ".grib", ".grib1", ".grib2", ".grb1", ".grb2"}


@files_bp.route("/api/browse")
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
    raw = (
        request.args.get("path", "").strip()
        or os.environ.get("HOME")
        or os.path.expanduser("~")
    )
    p = Path(raw).resolve()

    if not p.exists() or not p.is_dir():
        # Fall back to the closest existing parent
        while not p.exists() and p != p.parent:
            p = p.parent

    dirs, files = [], []
    try:
        for entry in sorted(p.iterdir(), key=lambda e: (not e.is_dir(), e.name.lower())):
            if entry.name.startswith("."):
                continue
            try:
                stat = entry.stat()
            except PermissionError:
                continue
            if entry.is_dir():
                dirs.append({"name": entry.name, "path": str(entry), "mtime": stat.st_mtime})
            elif entry.suffix.lower() in _DATA_EXTS:
                files.append({
                    "name": entry.name,
                    "path": str(entry),
                    "size": stat.st_size,
                    "mtime": stat.st_mtime,
                })
    except PermissionError:
        pass

    parts = p.parts
    parents = []
    for i, part in enumerate(parts):
        full = str(Path(*parts[: i + 1])) if i > 0 else "/"
        parents.append({"name": part, "path": full})

    return jsonify({"path": str(p), "parents": parents, "dirs": dirs, "files": files})


@files_bp.route("/api/load", methods=["POST"])
def api_load():
    """Load one or more data files and store the resulting CubeList in app_state."""
    body = request.get_json(force=True)
    filepath = body.get("filepath", "")
    if isinstance(filepath, str):
        filepath = filepath.strip()
    if not filepath:
        return jsonify({"error": "No filepath provided"}), 400

    try:
        resolved = resolve_paths(filepath)
        if not resolved:
            return jsonify({"error": f"No files found matching: {filepath}"}), 404

        cubes = load_files(filepath)
        meta = cubelist_metadata(cubes)

        paths_str = [str(r) for r in resolved]
        app_state["filepath"] = paths_str if len(paths_str) > 1 else paths_str[0]
        app_state["cubes"] = cubes
        app_state["metadata"] = meta
        loc_series_cache.clear()   # invalidate stale series cache

        return jsonify({"status": "ok", "filepath": app_state["filepath"], "cubes": meta})
    except Exception as exc:
        logger.exception("Failed to load file(s)")
        return jsonify({"error": str(exc)}), 500


@files_bp.route("/api/metadata")
def api_metadata():
    """Return the metadata list for the currently loaded file."""
    if app_state["metadata"] is None:
        return jsonify({"error": "No file loaded"}), 400
    return jsonify({"cubes": app_state["metadata"], "filepath": app_state["filepath"]})


@files_bp.route("/api/cube", defaults={"cube_index": 0})
@files_bp.route("/api/cube/<int:cube_index>")
def api_cube(cube_index):
    """
    Return metadata for a specific cube in the loaded list.
    If no index is provided in the address bar, it defaults to 0.
    """
    if app_state["metadata"] is None:
        return jsonify({"error": "No file loaded"}), 400
    try:
        cubes_meta = app_state["metadata"]
        if cube_index < 0 or cube_index >= len(cubes_meta):
            return jsonify({
                "error": f"Cube index {cube_index} out of range (max is {len(cubes_meta) - 1})"
            }), 400
        return jsonify(cubes_meta[cube_index])
    except Exception as exc:
        return jsonify({"error": str(exc)}), 500
