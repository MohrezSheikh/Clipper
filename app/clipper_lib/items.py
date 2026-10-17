"""Presentation helpers for clipboard items (kind detection, previews)."""
from __future__ import annotations

import os
import re
import urllib.parse

from .db import KIND_COLOR, KIND_FILES, KIND_IMAGE, KIND_LINK, KIND_TEXT

# GNOME icon names available in the default Adwaita theme
ICONS = {
    KIND_TEXT: "text-x-generic-symbolic",
    KIND_LINK: "web-browser-symbolic",
    KIND_COLOR: "color-select-symbolic",
    KIND_IMAGE: "image-x-generic-symbolic",
    KIND_FILES: "folder-symbolic",
}

MAX_PREVIEW_CHARS = 800

_RGB_FUNC_RE = re.compile(r"^rgba?\(\s*\d+", re.IGNORECASE)
_HSL_FUNC_RE = re.compile(r"^hsla?\(", re.IGNORECASE)


def looks_like_code(text: str) -> bool:
    """Cheap heuristic: multi-line text with indentation/braces/keywords."""
    if "\n" not in text:
        return False
    lines = text.strip().splitlines()
    if len(lines) < 3 or len(text) > 20_000:
        return False
    indented = sum(1 for ln in lines if ln[:1] in (" ", "\t"))
    signals = (
        indented >= (len(lines) - 1) * 0.6,
        bool(re.search(r"[{};()\[\]<>]", text[:200])),
        any(
            k in text for k in (
                "def ", "function", "class ", "import ", "const ", "let ", "var ",
                "return", "#include", "package", "func ", "=>", "::", "SELECT ",
            )
        ),
    )
    return any(signals)


def looks_like_file_path(text: str) -> bool:
    t = text.strip()
    if not t or "\n" in t or len(t) > 500:
        return False
    return os.sep in t or (os.altsep and os.altsep in t)


def preview_text(text: str, max_lines: int = 5, max_chars: int = MAX_PREVIEW_CHARS) -> str:
    """Collapse content to a bounded multi-line preview."""
    if len(text) > max_chars:
        text = text[:max_chars].rstrip() + " …"
    lines = text.splitlines()
    if len(lines) > max_lines:
        text = "\n".join(lines[:max_lines]) + "\n…"
    return text


def display_name(text: str, max_len: int = 60) -> str:
    """Short one-line label (for file/link/color cards)."""
    t = text.strip().replace("\n", " ")
    if len(t) > max_len:
        t = t[: max_len - 1] + "…"
    return t


def file_display(uri: str) -> str:
    """file:// URI -> human path."""
    if uri.startswith("file://"):
        return urllib.parse.unquote(uri[7:])
    return uri


def human_size(num_bytes: int) -> str:
    size = float(num_bytes)
    for unit in ("B", "kB", "MB", "GB"):
        if size < 1000 or unit == "GB":
            if unit == "B":
                return f"{int(size)} {unit}"
            return f"{size:.1f} {unit}"
        size /= 1000.0
    return f"{size:.1f} GB"
