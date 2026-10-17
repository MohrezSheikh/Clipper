"""GSettings-backed preferences for Clipper.

All settings live under the relocatable schema ``io.github.mohrezsheikh.clipper``
(path ``/io/github/mohrezsheikh/clipper/``) whose XML is shipped with the app and
compiled at install time.  If the schema is not found (e.g. running
from a source tree before ``install.sh`` has compiled it), this module
transparently falls back to an in-memory defaults object so the app
still runs for development.
"""
from __future__ import annotations

SCHEMA_ID = "io.github.mohrezsheikh.clipper"

KEY_THEME = "theme"                    # s: "system" | "light" | "dark"
KEY_HISTORY_LIMIT = "history-limit"    # i: max unpinned items kept
KEY_AUTO_PASTE = "auto-paste"          # b: inject Ctrl+V into previous window
KEY_INCOGNITO = "incognito"            # b: stop capturing while true
KEY_HIDE_ON_FOCUS_LOSS = "hide-on-focus-loss"  # b: close popup when click away
KEY_TOGGLE_KEYS_AUTO = "clipper-toggle"  # keybinding schema key (bridge reads it)

DEFAULTS = {
    KEY_THEME: "system",
    KEY_HISTORY_LIMIT: 200,
    KEY_AUTO_PASTE: True,
    KEY_INCOGNITO: False,
    KEY_HIDE_ON_FOCUS_LOSS: True,
    KEY_TOGGLE_KEYS_AUTO: ["<Super>v"],
}


class _FallbackPrefs:
    """In-memory stand-in used when the compiled schema isn't present."""

    def __init__(self) -> None:
        self._values: dict = dict(DEFAULTS)

    def get_string(self, key: str) -> str:  # noqa: D102
        return self._values[key]

    def get_int(self, key: str) -> int:  # noqa: D102
        return int(self._values[key])

    def get_boolean(self, key: str) -> bool:  # noqa: D102
        return bool(self._values[key])

    def get_strv(self, key: str) -> list:  # noqa: D102
        return list(self._values[key])

    def set_string(self, key: str, value: str) -> None:  # noqa: D102
        self._values[key] = value

    def set_int(self, key: str, value: int) -> None:  # noqa: D102
        self._values[key] = value

    def set_boolean(self, key: str, value: bool) -> None:  # noqa: D102
        self._values[key] = value

    def set_strv(self, key: str, value: list) -> None:  # noqa: D102
        self._values[key] = value


def load():
    """Return a GSettings object, or a fallback if the schema is missing."""
    from gi.repository import Gio

    try:
        return Gio.Settings.new(SCHEMA_ID)
    except Exception:  # schema not compiled yet — fine during development
        import logging

        logging.getLogger(__name__).warning(
            "GSettings schema %s not found; running with in-memory defaults "
            "(run install.sh to register the schema)", SCHEMA_ID,
        )
        return _FallbackPrefs()


load_prefs = load  # friendlier name used by callers
