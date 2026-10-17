"""The Clipper popup window: search bar, item cards, footer.

The window is a plain GTK4 toplevel owned by the Clipper daemon.  It is
created hidden at startup and shown/hidden via DBus (Win+V through the
shell bridge, or `clipper --toggle`).

Row model note: `Gio.ListStore` holds GObject-derived items, so raw
`db.Item` rows are wrapped in `ItemRow` for the UI.
"""
from __future__ import annotations

import os
import subprocess
from pathlib import Path

import gi

gi.require_version("Gtk", "4.0")
gi.require_version("Adw", "1")

from gi.repository import Adw, Gdk, GdkPixbuf, GLib, GObject, Gio, Gtk, Pango  # noqa: E402

from .db import (  # noqa: E402
    KIND_COLOR, KIND_FILES, KIND_IMAGE, KIND_LINK, KIND_TEXT, Item,
)
from .items import (  # noqa: E402
    display_name, file_display, human_size, looks_like_code, preview_text,
)

STYLES = Path(__file__).with_name("styles.css")
INVALID_POSITION = 4294967295


class ItemRow(GObject.Object):
    """GObject wrapper so db.Item can live in a Gio.ListStore."""

    __gtype_name__ = "ClipperItemRow"

    def __init__(self, item: Item):
        super().__init__()
        self._item = item

    @property
    def item(self) -> Item:
        return self._item


class ClipperWindow(Gtk.Window):
    def __init__(self, app):
        super().__init__(title="Clipper")
        self._app = app
        self._store_model = Gio.ListStore.new(ItemRow.__gtype__)
        self._search_text = ""
        self._filter: Gtk.CustomFilter | None = None

        self.set_default_size(470, 640)
        self.set_icon_name("clipper")
        self.add_css_class("clipper-window")
        self._apply_css()
        self._install_shortcuts()
        self._register_actions()
        self._build_ui()
        self.connect("close-request", self._on_close_request)
        self.connect("notify::is-active", self._on_active_changed)

    # ------------------------------------------------------------------ css
    def _apply_css(self) -> None:
        if STYLES.is_file():
            css = Gtk.CssProvider()
            css.load_from_path(str(STYLES))
            Gtk.StyleContext.add_provider_for_display(
                Gdk.Display.get_default(), css,
                Gtk.STYLE_PROVIDER_PRIORITY_APPLICATION,
            )

    def _install_shortcuts(self) -> None:
        ctrl = Gtk.ShortcutController()

        def add_shortcut(keyval: int, mods: Gdk.ModifierType, fn) -> None:
            trigger = Gtk.KeyvalTrigger.new(keyval, mods)
            action = Gtk.CallbackAction.new(fn)
            ctrl.add_shortcut(Gtk.Shortcut.new(trigger, action))

        add_shortcut(Gdk.KEY_Escape, Gdk.ModifierType(0),
                     lambda _s, _p: self.hide_popup() or True)
        add_shortcut(Gdk.KEY_s, Gdk.ModifierType.CONTROL_MASK,
                     lambda _s, _p: self.pin_selected() or True)
        add_shortcut(Gdk.KEY_c, Gdk.ModifierType.CONTROL_MASK,
                     lambda _s, _p: self.copy_selected() or True)
        add_shortcut(Gdk.KEY_Delete, Gdk.ModifierType(0),
                     lambda _s, _p: self.delete_selected() or True)
        add_shortcut(Gdk.KEY_slash, Gdk.ModifierType(0),
                     lambda _s, _p: self._search.grab_focus() or True)
        add_shortcut(Gdk.KEY_g, Gdk.ModifierType.CONTROL_MASK,
                     lambda _s, _p: self.open_settings() or True)
        self.add_controller(ctrl)

    # ------------------------------------------------------------- actions
    def _register_actions(self) -> None:
        group = Gio.SimpleActionGroup()
        for name in ("copy", "pin", "delete", "open", "path"):
            action = Gio.SimpleAction.new(f"row{name}", GLib.VariantType.new("i"))
            action.connect("activate", self._row_action(name))
            group.add_action(action)
        self.insert_action_group("win", group)

    def _row_action(self, key: str):
        def handler(_action, param) -> None:
            item = self._app.store.get(int(param))
            if item is None:
                return
            if key == "copy":
                self.copy_item(item)
            elif key == "pin":
                self._app.store.toggle_pin(item.id)
                self.refresh_items()
            elif key == "delete":
                self._app.store.delete(item.id)
                self.refresh_items()
            elif key == "open":
                if item.kind == KIND_IMAGE:
                    target = Path(item.content).parent
                else:
                    target = Path(file_display(item.content.split("\n")[0])).parent
                self._launch(["xdg-open", str(target)])
            elif key == "path":
                inner = (item.content if item.kind == KIND_IMAGE
                         else file_display(item.content.split("\n")[0]))
                self.copy_text_to_clipboard(inner)
                self.hide_popup()
        return handler

    @staticmethod
    def _launch(argv: list[str]) -> None:
        try:
            subprocess.Popen(
                argv, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL
            )
        except OSError as exc:
            print(f"clipper: could not open {argv[1:]}: {exc}", file=os.sys.stderr)

    # ----------------------------------------------------------------- ui
    def _build_ui(self) -> None:
        root = Gtk.Box(orientation=Gtk.Orientation.VERTICAL, spacing=10)
        root.set_margin_top(12)
        root.set_margin_bottom(12)
        root.set_margin_start(12)
        root.set_margin_end(12)

        self._search = Gtk.SearchEntry()
        self._search.set_placeholder_text("Search clipboard…")
        self._search.connect("search-changed", self._on_search_changed)
        root.append(self._search)

        self._filter = Gtk.CustomFilter()
        self._filter.set_filter_func(self._matches_search)
        filter_model = Gtk.FilterListModel.new(self._store_model, self._filter)
        self._results = Gtk.SingleSelection(model=filter_model)
        self._results.set_autoselect(False)

        list_view = Gtk.ListView(
            model=self._results, factory=self._mk_factory(),
        )
        list_view.set_single_click_activate(True)
        list_view.connect("activate", self._on_list_activated)

        scroll = Gtk.ScrolledWindow()
        scroll.set_policy(Gtk.PolicyType.NEVER, Gtk.PolicyType.AUTOMATIC)
        scroll.set_child(list_view)
        scroll.set_vexpand(True)

        self._stack = Gtk.Stack()
        self._stack.add_named(scroll, "list")

        empty = Gtk.Box(
            orientation=Gtk.Orientation.VERTICAL, spacing=8,
            valign=Gtk.Align.CENTER,
        )
        icon = Gtk.Image.new_from_icon_name("edit-paste-symbolic")
        icon.set_pixel_size(44)
        icon.set_opacity(0.55)
        empty.append(icon)
        msg = Gtk.Label(
            label=("Clipboard is empty\n"
                   "Copy text, images or files and they appear here.\n"
                   "Open with Win+V · close with Esc"),
            justify=Gtk.Justification.CENTER,
        )
        msg.add_css_class("clipper-empty")
        empty.append(msg)
        self._stack.add_named(empty, "empty")
        root.append(self._stack)

        root.append(self._build_footer())
        self.set_child(root)
        self.refresh_items()

    def _build_footer(self) -> Gtk.Widget:
        footer = Gtk.Box(orientation=Gtk.Orientation.HORIZONTAL, spacing=6)
        footer.add_css_class("clipper-footer")
        footer.set_valign(Gtk.Align.END)

        self._incognito_btn = Gtk.ToggleButton()
        self._incognito_btn.set_icon_name("view-conceal-symbolic")
        self._incognito_btn.set_tooltip_text(
            "Incognito: stop capturing while enabled")
        self._incognito_btn.connect("toggled", self._on_incognito)
        self.sync_incognito()
        footer.append(self._incognito_btn)

        gear = Gtk.Button.new_from_icon_name("emblem-system-symbolic")
        gear.set_tooltip_text("Settings")
        gear.connect("clicked", lambda *_: self.open_settings())
        footer.append(gear)

        footer.append(Gtk.Box(hexpand=True))  # spacer

        clear = Gtk.Button.new_from_icon_name("edit-clear-symbolic")
        clear.set_label("Clear")
        clear.add_css_class("clipper-clear")
        clear.set_tooltip_text("Clear all unpinned items")
        clear.connect("clicked", self._on_clear)
        footer.append(clear)
        return footer

    # factory -------------------------------------------------------------
    def _mk_factory(self) -> Gtk.ListItemFactory:
        factory = Gtk.SignalListItemFactory()
        factory.connect("setup", self._setup_row)
        factory.connect("bind", self._bind_row)
        return factory

    def _setup_row(self, _factory, listitem) -> None:
        listitem.set_child(Gtk.Box())  # replaced on bind

    def _bind_row(self, _factory, listitem) -> None:
        row = listitem.get_item()
        if row is None:
            return
        listitem.set_child(self._card_for_item(row.item))

    # cards ---------------------------------------------------------------
    def _card_for_item(self, item: Item) -> Gtk.Widget:
        card = Gtk.Box(orientation=Gtk.Orientation.HORIZONTAL, spacing=10)
        card.add_css_class("clipper-card")
        card.add_css_class(f"kind-{item.kind}")
        if item.pinned:
            card.add_css_class("pinned")

        body = self._content_widget(item)
        body.set_hexpand(True)
        card.append(body)

        buttons = Gtk.Box(orientation=Gtk.Orientation.HORIZONTAL, spacing=2)
        buttons.set_valign(Gtk.Align.CENTER)
        pin_btn = Gtk.Button()
        pin_btn.set_icon_name("starred-symbolic" if item.pinned
                              else "non-starred-symbolic")
        pin_btn.set_tooltip_text("Pin/Unpin (Ctrl+S)")
        pin_btn.connect(
            "clicked",
            lambda _b, it=item: self._row_action_dec("pin", it.id),
        )
        buttons.append(pin_btn)

        del_btn = Gtk.Button.new_from_icon_name("user-trash-symbolic")
        del_btn.set_tooltip_text("Delete (Delete key)")
        del_btn.connect(
            "clicked",
            lambda _b, it=item: self._row_action_dec("delete", it.id),
        )
        buttons.append(del_btn)
        card.append(buttons)

        menu_gesture = Gtk.GestureClick()
        menu_gesture.set_button(3)
        menu_gesture.connect("released", self._show_row_menu, item, card)
        card.add_controller(menu_gesture)
        return card

    def _row_action_dec(self, key: str, item_id: int) -> None:
        # action closures want a GVariant parameter
        self._row_action(key)(None, GLib.Variant.new_int32(item_id))

    def _content_widget(self, item: Item) -> Gtk.Widget:
        if item.kind == KIND_TEXT:
            label = Gtk.Label(
                label=preview_text(item.content),
                wrap=True,
                wrap_mode=Pango.WrapMode.WORD_CHAR,
                xalign=0.0,
            )
            if looks_like_code(item.content):
                label.add_css_class("code")
            return label

        if item.kind == KIND_LINK:
            return self._icon_with_text(
                "web-browser-symbolic", display_name(item.content, 110), True
            )

        if item.kind == KIND_COLOR:
            box = Gtk.Box(orientation=Gtk.Orientation.HORIZONTAL, spacing=10)
            color = self._parse_color(item.content)
            box.append(self._make_swatch(color))
            lbl = Gtk.Label(label=display_name(item.content, 30),
                            xalign=0.0, hexpand=True)
            box.append(lbl)
            return box

        if item.kind == KIND_IMAGE:
            return self._image_content(item.content)

        if item.kind == KIND_FILES:
            uris = [u for u in item.content.split("\n") if u]
            first = file_display(uris[0])
            name = Path(first).name or first
            extra = f" +{len(uris) - 1} more" if len(uris) > 1 else ""
            vb = Gtk.Box(orientation=Gtk.Orientation.VERTICAL, spacing=2)
            title = Gtk.Label(label=f"{name}{extra}", xalign=0.0, hexpand=True)
            title.set_ellipsize(Pango.EllipsizeMode.END)
            vb.append(title)
            sub = Gtk.Label(label=first, xalign=0.0, wrap=False)
            sub.set_ellipsize(Pango.EllipsizeMode.START)
            sub.add_css_class("meta")
            vb.append(sub)
            return vb

        return Gtk.Label(label=item.content)

    @staticmethod
    def _icon_with_text(icon_name: str, text: str, italic: bool = False) -> Gtk.Widget:
        box = Gtk.Box(orientation=Gtk.Orientation.HORIZONTAL, spacing=8)
        img = Gtk.Image.new_from_icon_name(icon_name)
        img.add_css_class("kind-icon")
        box.append(img)
        lab = Gtk.Label(label=text, xalign=0.0)
        lab.set_hexpand(True)
        lab.set_ellipsize(Pango.EllipsizeMode.END)
        if italic:
            attrs = Pango.AttrList()
            attrs.insert(Pango.attr_style_new(Pango.Style.ITALIC))
            lab.set_attributes(attrs)
        box.append(lab)
        return box

    def _image_content(self, path: str) -> Gtk.Widget:
        box = Gtk.Box(orientation=Gtk.Orientation.VERTICAL, spacing=6)
        try:
            thumb = GdkPixbuf.Pixbuf.new_from_file_at_size(path, 424, 180)
            picture = Gtk.Image.new_from_pixbuf(thumb)
            picture.set_halign(Gtk.Align.CENTER)
            picture.set_valign(Gtk.Align.START)
            box.append(picture)
        except Exception as exc:
            bad = Gtk.Label(label=f"(unreadable image: {exc})")
            bad.add_css_class("meta")
            box.append(bad)
        try:
            meta = f"{Path(path).name} · {human_size(os.path.getsize(path))}"
        except OSError:
            meta = Path(path).name
        lab = Gtk.Label(label=meta, xalign=0.0)
        lab.add_css_class("meta")
        lab.set_ellipsize(Pango.EllipsizeMode.START)
        box.append(lab)
        return box

    @staticmethod
    def _parse_color(hexish: str):
        rgba = Gdk.RGBA()
        try:
            return rgba if rgba.parse(hexish.strip()) else None
        except Exception:
            return None

    @staticmethod
    def _make_swatch(rgba) -> Gtk.Widget:
        """24x24 rounded color chip without needing cairo bindings."""
        size = 24
        if rgba is None:
            pic = Gtk.Picture()
            pic.set_size_request(size, size)
            return pic
        r = max(0, min(255, int(rgba.red * 255)))
        g = max(0, min(255, int(rgba.green * 255)))
        b = max(0, min(255, int(rgba.blue * 255)))
        a = max(0, min(255, int(rgba.alpha * 255)))
        pixbuf = GdkPixbuf.Pixbuf.new(GdkPixbuf.Colorspace.RGB, True, 8, size, size)
        pixbuf.fill((r << 24) | (g << 16) | (b << 8) | a)
        img = Gtk.Image.new_from_pixbuf(pixbuf)
        img.set_size_request(size, size)
        img.set_halign(Gtk.Align.CENTER)
        img.set_valign(Gtk.Align.CENTER)
        img.add_css_class("clipper-swatch")
        return img

    # row menu -------------------------------------------------------------
    def _show_row_menu(self, gesture, _n, _x, _y, item, widget) -> None:
        pop = Gtk.PopoverMenu.new_from_model(self._row_menu_model(item))
        pop.set_parent(widget)
        pop.connect("closed", lambda p: p.unparent())
        pop.popup()

    def _row_menu_model(self, item: Item) -> Gio.MenuModel:
        menu = Gio.Menu()
        menu.append("Copy", "win.rowcopy")
        menu.append("Unpin" if item.pinned else "Pin", "win.rowpin")
        menu.append("Delete", "win.rowdelete")
        if item.kind in (KIND_IMAGE, KIND_FILES):
            menu.append("Open Folder", "win.rowopen")
            menu.append("Copy Path", "win.rowpath")
        return menu

    def _on_list_activated(self, _view, position: int) -> None:
        row = self._results.get_item(position)
        if row is not None:
            self._paste_item(row.item)

    # -------------------------------------------------------------- paste
    def _paste_item(self, item: Item) -> None:
        if self._app.set_clipboard(item):
            self.hide_popup()
            self._app.request_paste_injection()

    def copy_item(self, item: Item) -> None:
        if self._app.set_clipboard(item):
            self.hide_popup()

    def copy_text_to_clipboard(self, text: str) -> None:
        cb = Gdk.Display.get_default().get_clipboard()
        cb.set_content(
            Gdk.ContentProvider.new_for_bytes(
                "text/plain;charset=utf-8", GLib.Bytes.new(text.encode())
            )
        )

    # ------------------------------------------------------------ selection
    def _selected_item(self) -> Item | None:
        position = self._results.get_selected()
        if position in (0xFFFFFFFF,) or position >= self._results.get_n_items():
            return None
        row = self._results.get_item(position)
        return row.item if row else None

    def pin_selected(self) -> None:
        item = self._selected_item()
        if item:
            self._row_action_dec("pin", item.id)

    def copy_selected(self) -> None:
        item = self._selected_item()
        if item:
            self._row_action_dec("copy", item.id)

    def delete_selected(self) -> None:
        item = self._selected_item()
        if item:
            self._row_action_dec("delete", item.id)

    # ------------------------------------------------------------- window
    def show_popup(self) -> bool:
        self.refresh_items()
        self.present()
        self._search.grab_focus()
        return False

    def hide_popup(self) -> bool:
        self.hide()
        return False

    def toggle_popup(self) -> bool:
        if self.get_visible():
            self.hide_popup()
        else:
            self.show_popup()
        return False

    def open_settings(self) -> None:
        ClipperPrefsWindow(self, self._app).present()

    def _on_close_request(self, _w) -> bool:
        self.hide()
        return True

    def _on_active_changed(self, *_a) -> None:
        if not self.get_visible() or self.is_active():
            return
        if self._app.prefs.get_boolean("hide-on-focus-loss"):
            GLib.timeout_add(220, self._hide_if_inactive)
        return None

    def _hide_if_inactive(self) -> bool:
        if self.get_visible() and not self.is_active():
            self.hide()
        return False

    # ------------------------------------------------------------ callbacks
    def _on_search_changed(self, entry) -> None:
        self._search_text = entry.get_text().strip()
        if self._filter is not None:
            self._filter.changed(Gtk.FilterChange.DIFFERENT)

    def _matches_search(self, row) -> bool:
        if not self._search_text:
            return True
        item = row.item if isinstance(row, ItemRow) else row
        return self._search_text.casefold() in (item.content or "").casefold()

    def _on_incognito(self, btn) -> None:
        self._app.prefs.set_boolean("incognito", btn.get_active())

    def _on_clear(self, *_a) -> None:
        self._app.store.clear(keep_pinned=True)
        self.refresh_items()

    # -------------------------------------------------------------- refresh
    def refresh_items(self) -> bool:
        items = self._app.store.query(
            search=self._search_text,
            limit=int(self._app.prefs.get_int("history-limit")) or 500,
        )
        self._store_model.splice(
            0, self._store_model.get_n_items(),
            [ItemRow(it) for it in items],
        )
        self._stack.set_visible_child_name("empty" if not items else "list")
        if self._results.get_n_items() and self._results.get_selected() != 0:
            self._results.select_item(0, True)
        return False

    def sync_incognito(self) -> bool:
        if not hasattr(self, "_incognito_btn"):
            return False
        btn = self._incognito_btn
        btn.handler_block_by_func(self._on_incognito)
        try:
            btn.set_active(bool(self._app.prefs.get_boolean("incognito")))
        finally:
            btn.handler_unblock_by_func(self._on_incognito)
        return False


class ClipperPrefsWindow(Gtk.Window):
    """Compact settings dialog."""

    def __init__(self, parent: ClipperWindow, app):
        super().__init__(title="Clipper Settings")
        self.set_transient_for(parent)
        self.set_modal(True)
        self.set_icon_name("clipper")
        self.add_css_class("clipper-window")
        self._app = app
        self.set_default_size(420, 300)

        root = Gtk.Box(orientation=Gtk.Orientation.VERTICAL, spacing=14)
        root.set_margin_top(18)
        root.set_margin_bottom(18)
        root.set_margin_start(18)
        root.set_margin_end(18)

        # theme
        dd = Gtk.DropDown.new_from_strings(["System", "Light", "Dark"])
        dd.set_selected({"system": 0, "light": 1, "dark": 2}.get(
            app.prefs.get_string("theme"), 0))
        theme_row = self._row("Appearance")
        theme_row.append(dd)
        dd.connect("notify::selected", lambda *_: self._on_theme(dd))
        root.append(theme_row)

        # history limit
        spin = Gtk.SpinButton.new_with_range(20, 5000, 10)
        spin.set_value(app.prefs.get_int("history-limit"))
        limit_row = self._row("Keep last n items")
        limit_row.append(spin)
        spin.connect("value-changed", self._on_limit)
        root.append(limit_row)

        # auto-paste
        auto_row = self._row("Auto-paste into previous window")
        auto = Gtk.Switch()
        auto.set_active(bool(app.prefs.get_boolean("auto-paste")))
        auto.connect("notify::active",
                     lambda _s, _p: self._set_bool("auto-paste", auto))
        auto_row.append(auto)
        root.append(auto_row)

        # hide on focus loss
        hid_row = self._row("Hide when clicking away")
        hid = Gtk.Switch()
        hid.set_active(bool(app.prefs.get_boolean("hide-on-focus-loss")))
        hid.connect("notify::active",
                    lambda _s, _p: self._set_bool("hide-on-focus-loss", hid))
        hid_row.append(hid)
        root.append(hid_row)

        hint = Gtk.Label(xalign=0.0)
        hint.set_wrap(True)
        hint.set_opacity(0.75)
        hint.set_markup(
            "<small>Hotkey: change <code>clipper-toggle</code> in GNOME Settings →"
            " Keyboard → View and Customize Shortcuts, or run:"
            " <code>gsettings set io.github.mohrezsheikh.clipper clipper-toggle \"['&lt;Super&gt;v']\"</code></small>"
        )
        root.append(hint)

        close = Gtk.Button(label="Close")
        close.set_halign(Gtk.Align.END)
        close.connect("clicked", lambda *_: self.close())
        root.append(close)

        self.set_child(root)

    @staticmethod
    def _row(label: str) -> Gtk.Box:
        box = Gtk.Box(orientation=Gtk.Orientation.HORIZONTAL, spacing=10)
        lab = Gtk.Label(label=label, xalign=0.0)
        lab.set_hexpand(True)
        box.append(lab)
        return box

    def _on_theme(self, dd) -> None:
        scheme = {0: "system", 1: "light", 2: "dark"}.get(dd.get_selected(), "system")
        self._app.prefs.set_string("theme", scheme)
        apply_theme(scheme)

    def _on_limit(self, spin) -> None:
        self._app.prefs.set_int("history-limit", int(spin.get_value()))

    def _set_bool(self, key: str, sw) -> None:
        self._app.prefs.set_boolean(key, bool(sw.get_active()))
        if key in ("incognito",):
            self._app.window.sync_incognito()


def apply_theme(theme: str) -> None:
    manager = Adw.StyleManager.get_default()
    manager.set_color_scheme({
        "system": Adw.ColorScheme.DEFAULT,
        "light": Adw.ColorScheme.FORCE_LIGHT,
        "dark": Adw.ColorScheme.FORCE_DARK,
    }.get(theme, Adw.ColorScheme.DEFAULT))
