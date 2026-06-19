#!/usr/bin/env python3
"""
viewnc – command-line entry point.

Usage:
    viewnc [FILE] [--port PORT] [--no-browser]
"""
from __future__ import annotations

import argparse
import sys


def main():
    parser = argparse.ArgumentParser(
        prog="viewnc",
        description="Interactive iris data viewer for NetCDF / PP / GRIB files.",
    )
    parser.add_argument(
        "filepath",
        nargs="?",
        default=None,
        help="Path to a NetCDF, PP or GRIB file to open on launch.",
    )
    parser.add_argument(
        "--port",
        type=int,
        default=5765,
        help="Port for the local web server (default: 5765).",
    )
    parser.add_argument(
        "--no-browser",
        action="store_true",
        help="Start the server without opening a browser window.",
    )
    args = parser.parse_args()

    from viewnc.app import run
    run(
        filepath=args.filepath,
        port=args.port,
        open_browser=not args.no_browser,
    )


if __name__ == "__main__":
    main()
