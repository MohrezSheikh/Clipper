"""Clipper — a Win+V-style clipboard manager for GNOME.

Modules:
    prefs   — GSettings-backed configuration
    db      — SQLite history store
    items   — item classification / preview helpers
    window  — popup window UI
    main    — daemon entrypoint, DBus service
"""
import os
import sys

# Make sure the bundled library directory is importable when running the
# `clipper` executable directly from anywhere.
_LIB_DIR = os.path.dirname(os.path.realpath(__file__))
if _LIB_DIR not in sys.path:
    sys.path.insert(0, _LIB_DIR)

APP_ID = "io.github.mohrezsheikh.clipper"
BUNDLE_VERSION = "0.1.0"
