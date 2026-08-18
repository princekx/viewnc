"""
app.py – Flask application factory for viewnc.

Route groups are implemented as Flask Blueprints in viewnc/routes/:
    files_bp   – /api/browse, /api/load, /api/metadata, /api/cube
    data_bp    – /api/slice, /api/stats, /api/timeseries, /api/coastlines
    series_bp  – /api/location_series
    export_bp  – /api/export/*

Shared mutable state (loaded cubes, metadata) lives in viewnc/state.py.
"""
from __future__ import annotations

import json
import logging

from flask import Flask, render_template

from viewnc.routes.files  import files_bp
from viewnc.routes.data   import data_bp
from viewnc.routes.series import series_bp
from viewnc.routes.export import export_bp

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

app = Flask(__name__, template_folder="templates", static_folder="static")


# ── NaN-safe JSON serialisation ───────────────────────────────────────────────
# Python's json module raises on NaN/Inf; Flask's default encoder inherits
# that limitation.  We override it to emit `null` for any non-finite float
# so masked / fill-value data never breaks the client.

class _NanSafeEncoder(json.JSONEncoder):
    def iterencode(self, o, _one_shot=False):
        return super().iterencode(self._sanitise(o), _one_shot)

    def _sanitise(self, obj):
        if isinstance(obj, float):
            return None if (obj != obj or obj == float("inf") or obj == float("-inf")) else obj
        if isinstance(obj, dict):
            return {k: self._sanitise(v) for k, v in obj.items()}
        if isinstance(obj, (list, tuple)):
            return [self._sanitise(v) for v in obj]
        return obj


app.json_encoder = _NanSafeEncoder  # type: ignore[attr-defined]


# ── Register blueprints ───────────────────────────────────────────────────────

app.register_blueprint(files_bp)
app.register_blueprint(data_bp)
app.register_blueprint(series_bp)
app.register_blueprint(export_bp)


# ── UI route ─────────────────────────────────────────────────────────────────

@app.route("/")
def index():
    return render_template("index.html")


# ── Entry point ───────────────────────────────────────────────────────────────

def run(filepath: str | list[str] | None = None, port: int = 5765, open_browser: bool = True):
    import threading
    import time
    import webbrowser

    from viewnc.state import app_state

    if filepath:
        from viewnc.iris_loader import load_files, resolve_paths, cubelist_metadata
        try:
            resolved = resolve_paths(filepath)
            if resolved:
                cubes      = load_files(filepath)
                paths_str  = [str(r) for r in resolved]
                app_state["filepath"] = paths_str if len(paths_str) > 1 else paths_str[0]
                app_state["cubes"]    = cubes
                app_state["metadata"] = cubelist_metadata(cubes)
                logger.info(
                    "Pre-loaded: %s (%d cube(s))",
                    app_state["filepath"], len(cubes),
                )
        except Exception as exc:
            logger.error("Failed to pre-load filepath %s: %s", filepath, exc)

    url = f"http://127.0.0.1:{port}"

    def _open():
        time.sleep(1.2)
        webbrowser.open(url)

    if open_browser:
        threading.Thread(target=_open, daemon=True).start()

    logger.info("viewnc running at %s", url)
    app.run(host="127.0.0.1", port=port, debug=False, use_reloader=False)
