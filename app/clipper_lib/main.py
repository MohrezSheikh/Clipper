"""Clipper daemon entrypoint.

One process owns everything:
    * SQLite history store
    * the hidden popup window (created at startup, shown on demand)
    * the DBus service ``io.github.mohrezsheikh.clipper`` that the GNOME Shell bridge
      talks to (captures + toggle), and which is also used by the CLI for
      ``clipper --toggle`` style commands.
"""
from __future__ import annotations

import argparse
import os
import signal
import sys
import time

import gi

gi.require_version("Gtk", "4.0")
gi.require_version("Adw", "1")
gi.require_version("GdkPixbuf", "2.0")

from gi.repository import Adw, Gdk, GdkPixbuf, GLib, Gio, Gtk  # noqa: E402

from . import APP_ID, BUNDLE_VERSION  # noqa: E402
from .db import (  # noqa: E402
    KIND_COLOR, KIND_FILES, KIND_IMAGE, KIND_LINK, KIND_TEXT,
    Store, classify_text, content_hash,
)
from .prefs import (  # noqa: E402
    KEY_AUTO_PASTE, KEY_HISTORY_LIMIT, KEY_INCOGNITO, load_prefs,
)

DBUS_PATH = "/io/github/mohrezsheikh/clipper"
BRIDGE_NAME = "io.github.mohrezsheikh.clipper.bridge"
IMAGE_BYTE_LIMIT = 48 * 1024 * 1024

INTERFACE_XML = """
<node>
  <interface name="io.github.mohrezsheikh.clipper">
    <method name="CaptureText"><arg type="s" direction="in"/></method>
    <method name="CaptureImage"><arg type="s" direction="in"/></method>
    <method name="CaptureFiles"><arg type="s" direction="in"/></method>
    <method name="Toggle"/>
    <method name="Show"/>
    <method name="Hide"/>
    <method name="Quit"/>
    <method name="SetIncognito"><arg type="b" direction="in"/></method>
    <method name="Ping"><arg type="s" direction="out"/></method>
  </interface>
</node>
"""


class Clipper:
    """Application singleton."""

    def __init__(self, opts: argparse.Namespace):
        self.opts = opts
        self.prefs = load_prefs()
        self.store = Store()
        self.window = None            # created once the display is ready
        self._owned = False
        self._loop: GLib.MainLoop | None = None
        self._suppress_hash: str | None = None
        self._suppress_until = 0.0
        self._bridge = None           # lazy proxy to the shell bridge

    # ------------------------------------------------------------------ run
    def run(self) -> int:
        Adw.init()
        Gtk.init()
        self._loop = GLib.MainLoop()
        for sig in (signal.SIGINT, signal.SIGTERM):
            try:
                signal.signal(sig, self._sigterm)
            except (ValueError, OSError):
                pass

        Gio.bus_own_name(
            Gio.BusType.SESSION,
            APP_ID,
            Gio.BusNameOwnerFlags.NONE,
            self._on_bus_acquired,
            None,   # name acquired — service is functional already
            self._on_name_lost,
        )
        GLib.idle_add(self._on_startup_ready)
        self._loop.run()
        return 0

    @staticmethod
    def _sigterm(*_args):
        raise SystemExit(0)

    def stop(self) -> None:
        if self._loop is not None:
            self._loop.quit()

    def _on_startup_ready(self) -> bool:
        try:
            self.make_window()
            _apply_verb_after_start(self, getattr(self.opts, "verb", None))
        except Exception as exc:
            print(f"clipper: startup failed: {exc}", file=sys.stderr)
            self.stop()
        return False

    # --------------------------------------------------------- bus plumbing
    def _on_bus_acquired(self, bus, _name) -> None:
        try:
            node = Gio.DBusNodeInfo.new_for_xml(INTERFACE_XML)
            bus.register_object(DBUS_PATH, node.interfaces[0], self._dispatch)
            self._owned = True
        except Exception as exc:  # pragma: no cover
            print(f"clipper: failed to register DBus object: {exc}", file=sys.stderr)

    def _on_name_lost(self, *_args) -> None:
        """Bus name taken by another instance: forward and exit."""
        GLib.idle_add(self._forward_and_close)

    def _forward_and_close(self) -> bool:
        verb = getattr(self.opts, "verb", None)
        remote_call = {
            "show": "Show", "hide": "Hide", "toggle": "Toggle", "quit": "Quit",
        }.get(verb)
        if remote_call:
            ok = _forward_verb(verb)
            if not ok:
                print(
                    "clipper: another instance is running but unreachable.",
                    file=sys.stderr,
                )
        elif verb == "demo":
            print("clipper: another instance is running; --demo is unsupported there.")
        self.stop()
        return False

    def _dispatch(self, bus, sender, path, iface, method, params, invocation):
        """Low-level DBus method handler.

        GIO appends a `Gio.DBusMethodInvocation`; the call must be completed
        explicitly via `invocation.return_value(...)`.
        """
        handler = {
            "CaptureText": self._capture_text,
            "CaptureImage": self._capture_image,
            "CaptureFiles": self._capture_files,
            "Toggle": self._toggle_window,
            "Show": self._show_window,
            "Hide": self._hide_window,
            "Quit": self._quit,
            "SetIncognito": self._set_incognito,
            "Ping": self._ping,
        }[method]
        try:
            out = handler(params.unpack()[0] if params.n_children() else None)
            if out is None:
                invocation.return_value(None)
            else:
                invocation.return_value(GLib.Variant("(s)", (out,)))
        except Exception as exc:  # keep the daemon alive on bad input
            print(f"clipper: {method} failed: {exc}", file=sys.stderr)
            try:
                invocation.return_value(None)
            except Exception:
                pass

    # -------------------------------------------------------------- handlers
    def _ping(self, _):
        return f"clipper {BUNDLE_VERSION}"

    def _quit(self, _):
        GLib.idle_add(self.stop)

    def _toggle_window(self, _):
        GLib.idle_add(self.window.toggle_popup)
        return None

    def _show_window(self, _):
        GLib.idle_add(self.window.show_popup)
        return None

    def _hide_window(self, _):
        GLib.idle_add(self.window.hide_popup)
        return None

    def _set_incognito(self, value):
        self.prefs.set_boolean(KEY_INCOGNITO, bool(value))
        if self.window is not None:
            GLib.idle_add(self.window.sync_incognito)
        return None

    def _self_suppressed(self, content: str, kind: str) -> bool:
        hsh = content_hash(kind, content)
        return (
            self._suppress_hash == hsh
            and time.time() < self._suppress_until
        )

    def _capture_text(self, content: str):
        if not content or self._is_incognito():
            return None
        if len(content) > 2_000_000:   # huge blobs: don't choke the history
            return None
        kind = classify_text(content)
        if self._self_suppressed(content, kind):
            return None
        item, is_new = self.store.capture(kind, content, size=len(content))
        if is_new:
            self.store.trim(self.prefs.get_int(KEY_HISTORY_LIMIT))
        self._refresh_window()
        return None

    def _capture_image(self, path: str):
        if self._is_incognito() or not path:
            return None
        if not os.path.isfile(path):
            return None
        try:
            digest, nbytes = _md5_and_size(path)
        except OSError:
            return None
        if nbytes == 0 or nbytes > IMAGE_BYTE_LIMIT:
            return None
        if self._self_suppressed(str(path), KIND_IMAGE):
            return None
        item, is_new = self.store.capture(
            KIND_IMAGE, path, hsh=digest, size=nbytes
        )
        if is_new:
            self.store.trim(self.prefs.get_int(KEY_HISTORY_LIMIT))
        self._refresh_window()
        return None

    def _capture_files(self, uris_blob: str):
        if self._is_incognito() or not uris_blob:
            return None
        uris = [u for u in (ln.strip() for ln in uris_blob.split("\n")) if u]
        if not uris:
            return None
        content = "\n".join(uris)
        if self._self_suppressed(content, KIND_FILES):
            return None
        item, is_new = self.store.capture(
            KIND_FILES, content, size=len(content)
        )
        if is_new:
            self.store.trim(self.prefs.get_int(KEY_HISTORY_LIMIT))
        self._refresh_window()
        return None

    # -------------------------------------------------------------- helpers
    def _is_incognito(self) -> bool:
        return bool(self.prefs.get_boolean(KEY_INCOGNITO))

    def _refresh_window(self) -> None:
        if self.window is None:
            return
        GLib.idle_add(self.window.refresh_items)

    def make_window(self):
        """Create the (hidden) popup window.  Called once at startup."""
        from .window import ClipperWindow

        self.window = ClipperWindow(self)
        self._build_bridge_proxy()

    def _build_bridge_proxy(self) -> None:
        """Proxy to the shell bridge so we can ask it to inject Ctrl+V."""
        Gio.bus_watch_name(
            Gio.BusType.SESSION,
            BRIDGE_NAME,
            Gio.BusNameWatcherFlags.NONE,
            self._bridge_appeared,
            self._bridge_gone,
        )

    def _bridge_appeared(self, _bus, _name, _owner) -> None:
        try:
            self._bridge = Gio.DBusProxy.new_for_bus_sync(
                Gio.BusType.SESSION, Gio.DBusProxyFlags.NONE, None,
                BRIDGE_NAME, DBUS_PATH, BRIDGE_NAME, None,
            )
        except Exception as exc:
            print(f"clipper: bridge proxy unavailable: {exc}", file=sys.stderr)

    def _bridge_gone(self, *args) -> None:
        self._bridge = None

    def request_paste_injection(self) -> None:
        """Ask the bridge to hit Ctrl+V in the previously focused window."""
        if self._bridge is None or not self.prefs.get_boolean(KEY_AUTO_PASTE):
            return
        GLib.timeout_add(60, lambda: self._bridge_call("Paste"))

    def _bridge_call(self, method: str) -> bool:
        try:
            self._bridge.call_sync(method, None, None, Gio.DBusCallFlags.NONE, 1500, None)
        except Exception:
            pass  # auto-paste is best-effort
        return False

    # ------------------------------------------------------ clipboard write
    def register_own_clipboard_set(self, kind: str, content: str) -> None:
        """Remember that we ourselves just set the clipboard, so the bridge
        echoes back of that copy doesn't double-bump the history."""
        self._suppress_hash = content_hash(kind, content)
        self._suppress_until = time.time() + 2.5
        # keep suppression pinned to a rolling window; earlier markers stay
        # harmless because the hash check also needs to match
        _ = self._suppress_until

    def set_clipboard(self, item) -> bool:
        """Place `item` onto the system clipboard (Wayland/X11 agnostic)."""
        clipboard = Gdk.Display.get_default().get_clipboard()
        providers = []

        def text_bytes(value: str):
            data = value.encode()
            return [
                Gdk.ContentProvider.new_for_bytes(
                    "text/plain;charset=utf-8", GLib.Bytes.new(data)
                ),
                Gdk.ContentProvider.new_for_bytes("text/plain", GLib.Bytes.new(data)),
            ]

        if item.kind == KIND_TEXT:
            providers = text_bytes(item.content)
        elif item.kind == KIND_LINK:
            providers = text_bytes(item.content)
            providers.append(
                Gdk.ContentProvider.new_for_bytes(
                    "text/uri-list", GLib.Bytes.new(item.content.encode())
                )
            )
        elif item.kind == KIND_COLOR:
            providers = text_bytes(item.content)
            providers.append(
                Gdk.ContentProvider.new_for_bytes(
                    "text/x-color", GLib.Bytes.new(item.content.encode())
                )
            )
        elif item.kind == KIND_IMAGE:
            try:
                with open(item.content, "rb") as fh:
                    data = fh.read()
            except OSError as exc:
                print(f"clipper: can't open {item.content}: {exc}", file=sys.stderr)
                return False
            providers = [
                Gdk.ContentProvider.new_for_bytes(
                    "image/png", GLib.Bytes.new(data)
                )
            ]
        elif item.kind == KIND_FILES:
            uris = [u for u in item.content.split("\n") if u]
            gnome_blob = lines_to_gnome_files("copy", uris)
            providers = [
                Gdk.ContentProvider.new_for_bytes(
                    "x-special/gnome-copied-files", GLib.Bytes.new(gnome_blob.encode())
                ),
                Gdk.ContentProvider.new_for_bytes(
                    "text/uri-list", GLib.Bytes.new("\r\n".join(uris).encode())
                ),
            ]

        if not providers:
            return False
        clipboard.set_content(
            providers[0] if len(providers) == 1 else Gdk.ContentProvider.new_union(providers)
        )
        self.register_own_clipboard_set(item.kind, normalize_for_hash(item))
        return True

    # ------------------------------------------------------------ CLI extra
    def populate_demo(self) -> None:
        """Seed sample items (used by `clipper --demo`)."""
        samples = [
            "hello from Clipper",
            "def greet(name):\n    return f'hello {name}'",
            "https://github.com/",
            "#ff6600",
            "README.md",
        ]
        for text in samples:
            kind = classify_text(text)
            self.store.capture(kind, text, size=len(text))
        # a tiny generated demo image so the image card is visible
        try:
            blob = GdkPixbuf.Pixbuf.new(GdkPixbuf.Colorspace.RGB, True, 8, 96, 60)
            blob.fill(0xFF557799)
            demo_png = str(self.store.images_dir / "demo.png")
            blob.savev(demo_png, "png", [], [])
            self.store.capture(
                KIND_IMAGE, demo_png, size=os.path.getsize(demo_png)
            )
        except Exception as exc:
            print(f"clipper: demo image failed: {exc}", file=sys.stderr)
        self._refresh_window()


# ------------------------------------------------------------- small utils
def lines_to_gnome_files(operation: str, uris: list[str]) -> str:
    return "\n".join([operation, *uris])


def normalize_for_hash(item) -> str:
    """The exact string the capture side re-derives a hash from."""
    return item.content


def _md5_and_size(path: str) -> tuple[str, int]:
    h = __import__("hashlib").md5()
    nbytes = 0
    with open(path, "rb") as fh:
        while chunk := fh.read(1 << 20):
            h.update(chunk)
            nbytes += len(chunk)
    return h.hexdigest(), nbytes


def _apply_verb_after_start(app: Clipper, verb: str | None) -> None:
    if verb == "show":
        GLib.idle_add(app.window.show_popup)
    elif verb == "demo":
        app.populate_demo()
        GLib.idle_add(app.window.show_popup)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="clipper", description=__doc__)
    g = parser.add_mutually_exclusive_group()
    g.add_argument("--toggle", action="store_true", help="show or hide the popup")
    g.add_argument("--show", action="store_true", help="show the popup")
    g.add_argument("--hide", action="store_true", help="hide the popup")
    g.add_argument("--quit", action="store_true", help="stop a running instance")
    g.add_argument(
        "--demo", action="store_true",
        help="seed the history with sample items and show the popup",
    )
    args = parser.parse_args(argv)
    args.verb = "toggle" if args.toggle else \
        "show" if args.show else \
        "hide" if args.hide else \
        "quit" if args.quit else \
        "demo" if args.demo else None
    # CLI verbs that need a *running* daemon: forward if one exists.
    if args.verb in ("show", "hide", "toggle", "quit"):
        if _forward_verb(args.verb):
            return 0

    app = Clipper(args)
    app.run()
    app.store.close()
    return 0


def _forward_verb(verb: str) -> bool:
    """If another Clipper owns the bus name, do the verb there and exit."""
    try:
        bus = Gio.bus_get_sync(Gio.BusType.SESSION, None)
        bus.call_sync(
            APP_ID, DBUS_PATH, APP_ID, _VERB_TO_METHOD[verb], None, None,
            Gio.DBusCallFlags.NONE, 1500, None,
        )
        return True
    except Exception:
        return False


_VERB_TO_METHOD = {
    "show": "Show",
    "hide": "Hide",
    "toggle": "Toggle",
    "quit": "Quit",
}


if __name__ == "__main__":
    raise SystemExit(main())
