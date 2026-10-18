/* The Clipper popup: card dialog rendered inside GNOME Shell, anchored to
 * the mouse pointer on the focused monitor.
 */
import Clutter from 'gi://Clutter';
import Cogl from 'gi://Cogl';
import GdkPixbuf from 'gi://GdkPixbuf';
import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import Shell from 'gi://Shell';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import {KIND_FILES, KIND_IMAGE, KIND_TEXT} from '../lib/storage.js';

const CODE_HINT_RE = /[{};()\[\]<>]|(^|\n)\s+(def |function |class |import |const |let |var |return |#include|func |SELECT )/;

export class ClipperDialog {
    constructor({history, incognito, onPaste, onCopy, onClear,
                 onIncognitoChanged, onOpenFolder}) {
        this._history = history;
        this._onPaste = onPaste;
        this._onCopy = onCopy;
        this._onClear = onClear;
        this._onIncognitoChanged = onIncognitoChanged;
        this._onOpenFolder = onOpenFolder;
        this._incognito = incognito;

        this._open = false;
        this._built = false;
        this._rows = [];
        this._selectedIndex = 0;
        this._filterText = '';
        this._searchText = '';
    }

    isOpen() {
        return this._open;
    }

    setSearchText(text) {
        this._searchText = text ?? '';
        if (this._built) {
            this._search.text = this._searchText;
        }
    }

    /* ------------------------------------------------------------ lifecycle */
    toggle() {
        if (this._open)
            this.close();
        else
            this.open();
    }

    /* Non-blocking panel: no input grab, so other apps stay fully usable
     * while the history dialog is open.  The user closes it deliberately
     * (close button, Ctrl+Alt+V again, or Esc while the panel has focus). */
    open() {
        if (this._open)
            return;
        try {
            this._build();
            this._refreshRows();
            this._position();
        } catch (e) {
            log(`clipper: opening dialog failed: ${e}`);
            this._destroyChrome();
            return;
        }
        Main.layoutManager.uiGroup.add_child(this._card);
        Main.layoutManager.uiGroup.set_child_above_sibling(this._card, null);
        this._card.show();
        this._card.connect('key-press-event',
            this._onCapturedEvent.bind(this));
        // clicking anywhere on the panel returns keyboard focus to search
        this._card.connect('button-press-event', () => {
            this._search.grab_key_focus();
            return Clutter.EVENT_PROPAGATE;
        });
        this._open = true;
        this._search.grab_key_focus();
        log('clipper: dialog opened (non-blocking)');
    }

    close() {
        if (!this._open)
            return;
        this._destroyChrome();
        this._open = false;
        log('clipper: dialog closed');
    }

    _destroyChrome() {
        const parent = this._card?.get_parent();
        if (parent) {
            try {
                parent.remove_child(this._card);
            } catch {
                /* nothing else we can do here */
            }
        }
    }

    setIncognito(enabled) {
        this._incognito = enabled;
        if (this._built)
            this._updateIncognitoButton();
    }

    /* ---------------------------------------------------------------- build */
    _build() {
        if (this._built)
            return;

        this._card = new St.BoxLayout({
            style_class: 'clipper-card-dialog',
            vertical: true,
            reactive: true,
        });
        this._card.connect('captured-event',
            this._onCapturedEvent.bind(this));

        // search bar with an explicit close button (always-dismissable)
        const topBar = new St.BoxLayout({
            style_class: 'clipper-topbar',
            vertical: false,
            x_expand: true,
        });
        this._search = new St.Entry({
            style_class: 'clipper-search',
            hint_text: 'Search clipboard…',
            can_focus: true,
            x_expand: true,
            text: this._searchText,
        });
        this._search.get_clutter_text().connect('text-changed', () => {
            this._filterText = this._search.text ?? '';
            this._refreshRows();
        });
        // St.Entry has no `activate` signal; the inner ClutterText does.
        this._search.get_clutter_text().connect('activate',
            () => this._pasteSelected());
        topBar.add_child(this._search);

        this._closeButton = new St.Button({
            style_class: 'clipper-button clipper-close',
            y_align: Clutter.ActorAlign.CENTER,
        });
        this._closeButton.set_child(new St.Icon({
            icon_name: 'window-close-symbolic',
            icon_size: 14,
        }));
        this._closeButton.connect('clicked', () => this.close());
        topBar.add_child(this._closeButton);

        this._card.add_child(topBar);

        // history list
        this._listBox = new St.BoxLayout({
            style_class: 'clipper-list',
            vertical: true,
        });
        this._scroll = new St.ScrollView({
            style_class: 'clipper-scroll',
            overlay_scrollbars: true,
            y_expand: true,
            child: this._listBox,
        });
        this._card.add_child(this._scroll);

        // footer
        const footer = new St.BoxLayout({
            style_class: 'clipper-footer',
            x_expand: true,
        });
        this._hint = new St.Label({
            style_class: 'clipper-hint',
            text: '',
            y_align: Clutter.ActorAlign.CENTER,
            x_expand: true,
        });
        footer.add_child(this._hint);

        this._clearButton = new St.Button({
            style_class: 'clipper-button',
            label: 'Clear',
            y_align: Clutter.ActorAlign.CENTER,
        });
        this._clearButton.connect('clicked', () => this._onClear?.());
        footer.add_child(this._clearButton);

        this._incognitoButton = new St.Button({
            style_class: 'clipper-button',
            y_align: Clutter.ActorAlign.CENTER,
        });
        this._updateIncognitoButton();
        this._incognitoButton.connect('clicked', () => {
            const next = !this._incognito;
            this.setIncognito(next);
            this._onIncognitoChanged?.(next);
        });
        footer.add_child(this._incognitoButton);

        this._card.add_child(footer);
        this._built = true;
    }

    _updateIncognitoButton() {
        const row = new St.BoxLayout({
            style_class: 'clipper-incognito-row',
            vertical: false,
            x_align: Clutter.ActorAlign.CENTER,
        });
        row.add_child(new St.Icon({
            icon_name: this._incognito ? 'view-conceal-symbolic'
                                       : 'view-reveal-symbolic',
            icon_size: 14,
        }));
        row.add_child(new St.Label({
            text: this._incognito ? 'Incognito ON' : 'Incognito',
        }));
        this._incognitoButton.set_child(row);
        if (this._incognito)
            this._incognitoButton.add_style_class_name('clipper-incognito-on');
        else
            this._incognitoButton.remove_style_class_name('clipper-incognito-on');
    }

    /* -------------------------------------------------- events & navigation */
    _onCapturedEvent(_actor, event) {
        if (event.type() !== Clutter.EventType.KEY_PRESS)
            return Clutter.EVENT_PROPAGATE;
        const symbol = event.get_key_symbol();
        const control = (event.get_state() &
            Clutter.ModifierType.CONTROL_MASK) !== 0;

        if (symbol === Clutter.KEY_Escape) {
            this.close();
            return Clutter.EVENT_STOP;
        }
        if (symbol === Clutter.KEY_Down) {
            this._moveSelection(1);
            return Clutter.EVENT_STOP;
        }
        if (symbol === Clutter.KEY_Up) {
            this._moveSelection(-1);
            return Clutter.EVENT_STOP;
        }
        if ((symbol === Clutter.KEY_Return || symbol === Clutter.KEY_KP_Enter) &&
            !control && this._rows.length > 0) {
            this._pasteSelected();
            return Clutter.EVENT_STOP;
        }
        if (symbol === Clutter.KEY_s && control) {
            this._pinSelected();
            return Clutter.EVENT_STOP;
        }
        if (symbol === Clutter.KEY_Delete || symbol === Clutter.KEY_KP_Delete) {
            this._deleteSelected();
            return Clutter.EVENT_STOP;
        }
        return Clutter.EVENT_PROPAGATE;
    }

    _moveSelection(delta) {
        if (this._rows.length === 0)
            return;
        const index = clamp(this._selectedIndex + delta,
            0, this._rows.length - 1);
        this._setSelected(index);
    }

    _setSelected(index) {
        if (index < 0 || index >= this._rows.length) {
            this._selectedIndex = 0;
            this._highlight();
            return;
        }
        this._selectedIndex = index;
        this._highlight();
        const row = this._rows[index].row;
        if (row)
            this._ensureVisible(row);
    }

    _highlight() {
        for (const entry of this._rows)
            entry.row.remove_style_class_name('clipper-selected');
        const current = this._rows[this._selectedIndex];
        if (current)
            current.row.add_style_class_name('clipper-selected');
    }

    _ensureVisible(row) {
        try {
            const adjust = this._scroll.get_vscroll_bar();
            const allocation = row.get_allocation_box();
            const y = allocation.get_y();
            const height = allocation.get_height();
            let [value, lower, upper, pageSize] = adjust.get_range();
            const viewTop = adjust.get_value();
            if (y < viewTop)
                adjust.set_value(Math.max(lower, y - 12));
            else if (y + height > viewTop + pageSize)
                adjust.set_value(
                    Math.min(upper - pageSize, y + height - pageSize + 12));
        } catch {
            /* scrolling nicety only */
        }
    }

    _pasteSelected() {
        const entry = this._rows[this._selectedIndex];
        if (entry)
            this._onPaste?.(entry.item);
        else
            this.close();
    }

    _pinSelected() {
        const entry = this._rows[this._selectedIndex];
        if (!entry)
            return;
        this._history.togglePin(entry.item.id);
        this._refreshRows(true);
    }

    _deleteSelected() {
        const entry = this._rows[this._selectedIndex];
        if (!entry)
            return;
        this._history.remove(entry.item.id);
        this._refreshRows();
    }

    /* --------------------------------------------------------------- list */
    _refreshRows(respectIndex = false) {
        if (!this._built)
            return;
        this._listBox.remove_all_children();
        this._rows = [];

        const items = this._history.search(this._filterText);
        for (const item of items)
            this._listBox.add_child(this._buildRow(item).row);

        if (items.length === 0) {
            const empty = new St.Label({
                style_class: 'clipper-empty clipper-text',
                text: this._incognito
                    ? 'Incognito is on — nothing new is recorded.'
                    : 'Clipboard history is empty.\nCopy something or take a screenshot.',
            });
            this._listBox.add_child(empty);
        }

        this._hint.text = this._incognito
            ? 'Incognito ON — new copies are not recorded'
            : (items.length
                ? `${items.length} item${items.length > 1 ? 's' : ''}` +
                  '  ·  Enter paste · Ctrl+S pin · Del remove'
                : '');

        const keepIndex = respectIndex
            ? clamp(this._selectedIndex, 0, Math.max(0, items.length - 1))
            : 0;
        this._selectedIndex = 0;
        if (items.length > 0)
            this._setSelected(keepIndex);
        else
            this._highlight();
    }

    _buildRow(item) {
        const row = new St.BoxLayout({
            style_class: 'clipper-item',
            vertical: false,
            reactive: true,
            x_expand: true,
        });

        const bodyButton = new St.Button({
            style_class: 'clipper-item-body',
            x_expand: true,
            y_align: Clutter.ActorAlign.FILL,
            child: this._contentWidget(item),
        });
        bodyButton.connect('clicked', () => this._onPaste?.(item));
        row.add_child(bodyButton);

        const actions = new St.BoxLayout({
            style_class: 'clipper-actions',
            vertical: true,
        });
        for (const spec of this._actionsFor(item)) {
            const button = new St.Button({
                style_class: 'clipper-mini-button',
                y_align: Clutter.ActorAlign.CENTER,
            });
            button.set_child(new St.Icon({icon_name: spec.icon, icon_size: 13}));
            button.connect('clicked', () => spec.run(item));
            actions.add_child(button);
        }
        row.add_child(actions);

        if (item.pinned)
            row.add_style_class_name('clipper-pinned');
        return {row, item};
    }

    _actionsFor(item) {
        const actions = [
            {icon: 'edit-copy-symbolic', run: (it) => this._onCopy?.(it)},
            {icon: 'view-pin-symbolic', run: (it) => {
                this._history.togglePin(it.id);
                this._refreshRows(true);
            }},
            {icon: 'user-trash-symbolic', run: (it) => {
                this._history.remove(it.id);
                this._refreshRows();
            }},
        ];
        if (item.kind === KIND_IMAGE || item.kind === KIND_FILES) {
            actions.splice(0, 0, {
                icon: 'folder-open-symbolic',
                run: (it) => this._onOpenFolder?.(it),
            });
        }
        return actions;
    }

    /* ------------------------------------------------------- content views */
    _contentWidget(item) {
        if (item.kind === KIND_TEXT)
            return this._textView(item);
        if (item.kind === KIND_IMAGE)
            return this._imageView(item);
        if (item.kind === KIND_FILES)
            return this._filesView(item);
        return this._textLabel(item.content);
    }

    _textView(item) {
        const code = CODE_HINT_RE.test(item.content) && item.content.includes('\n');
        const box = new St.BoxLayout({
            style_class: code ? 'clipper-code' : 'clipper-plain',
            vertical: true,
        });
        box.add_child(this._textLabel(clipText(item.content, 420), code));
        box.add_child(new St.Label({
            style_class: 'clipper-meta',
            text: `${relTime(item.date)}` +
                  `${item.count > 1 ? `  ·  ×${item.count}` : ''}`,
        }));
        return box;
    }

    _textLabel(text, mono = false) {
        return new St.Label({
            style_class: mono ? 'clipper-text clipper-mono' : 'clipper-text',
            text,
        });
    }

    _imageView(item) {
        const box = new St.BoxLayout({
            style_class: 'clipper-image-box',
            vertical: true,
        });
        const thumb = this._makeThumb(item.content);
        if (thumb !== null)
            box.add_child(thumb);
        const name = item.meta?.name ?? GLib.basename(item.content);
        let sizeLabel = item.size > 0 ? humanSize(item.size) : '';
        try {
            const info = Gio.File.new_for_path(item.content).query_info(
                'standard::size', Gio.FileQueryInfoFlags.NONE, null);
            sizeLabel = humanSize(Number(info.get_size()));
        } catch {
            /* fall back to the stored size */
        }
        box.add_child(new St.Label({
            style_class: 'clipper-meta',
            text: `${name}` +
                  `${sizeLabel ? `  ·  ${sizeLabel}` : ''}` +
                  `${item.count > 1 ? `  ·  ×${item.count}` : ''}` +
                  `  ·  ${relTime(item.date)}`,
        }));
        return box;
    }

    _makeThumb(path) {
        try {
            const pixbuf = GdkPixbuf.Pixbuf.new_from_file_at_size(path, 360, 180);
            const image = new Clutter.Image();
            image.set_data(pixbuf.get_pixels(),
                pixbuf.get_has_alpha()
                    ? Cogl.PixelFormat.RGBA_8888
                    : Cogl.PixelFormat.RGB_888,
                pixbuf.get_width(), pixbuf.get_height(),
                pixbuf.get_rowstride());
            return new St.Image({image, style_class: 'clipper-thumb'});
        } catch (e) {
            log(`clipper: thumbnail failed: ${e}`);
            return null;
        }
    }

    _filesView(item) {
        const paths = item.content.split('\n').filter(Boolean);
        const first = uriFilePath(paths[0]);
        const firstName = GLib.basename(first) || first;
        const more = paths.length > 1 ? ` +${paths.length - 1}` : '';
        const box = new St.BoxLayout({
            style_class: 'clipper-files-box',
            vertical: true,
        });
        const head = new St.BoxLayout({
            style_class: 'clipper-head',
            vertical: false,
        });
        head.add_child(new St.Icon({icon_name: 'folder-symbolic', icon_size: 15}));
        head.add_child(new St.Label({
            style_class: 'clipper-text',
            text: `${firstName}${more}`,
        }));
        box.add_child(head);
        box.add_child(new St.Label({
            style_class: 'clipper-meta',
            text: `${first.length > 84 ? `…${first.slice(first.length - 84)}` : first}` +
                  `  ·  ${relTime(item.date)}` +
                  `${item.count > 1 ? `  ·  ×${item.count}` : ''}`,
        }));
        return box;
    }

    /* -------------------------------------------------------- positioning */
    _position() {
        const [px, py] = global.get_pointer();
        const monitors = Main.layoutManager.monitors;
        let monitor = monitors.findIndex(
            m => px >= m.x && px < m.x + m.width &&
                 py >= m.y && py < m.y + m.height);
        if (monitor < 0)
            monitor = Main.layoutManager.primaryIndex;
        const area = Main.layoutManager.getWorkAreaForMonitor(monitor);

        const width = Math.min(470, Math.floor(area.width * 0.92));
        const height = Math.min(620, Math.floor(area.height * 0.88));
        this._card.set_size(width, height);

        let x = Math.floor(px - width / 2);
        let y = Math.floor(py + 18);
        if (y + height > area.y + area.height - 24)
            y = py - height - 18;
        x = clamp(x, area.x + 12, area.x + area.width - width - 12);
        y = clamp(y, area.y + 12, area.y + area.height - height - 12);

        this._card.set_position(x, y);
        this._card.set_opacity(0);
        this._card.ease({
            opacity: 255,
            duration: 130,
            mode: Clutter.AnimationMode.EASE_OUT,
        });
    }
}

/* ---------------------------------------------------------------- helpers */
function clipText(text, max = 420) {
    const lines = text.split('\n');
    if (lines.length > 8)
        return lines.slice(0, 8).join('\n') + '\n…';
    if (text.length > max)
        return text.slice(0, max).trimEnd() + '…';
    return text;
}

function relTime(ms) {
    const diff = Math.max(0, Date.now() - ms);
    const sec = diff / 1000;
    if (sec < 10)
        return 'just now';
    if (sec < 60)
        return `${Math.round(sec)}s ago`;
    const min = sec / 60;
    if (min < 60)
        return `${Math.round(min)} min ago`;
    const hours = min / 60;
    if (hours < 24)
        return `${Math.round(hours)} h ago`;
    const days = hours / 24;
    if (days < 30)
        return `${Math.round(days)} d ago`;
    return new Date(ms).toLocaleDateString();
}

function humanSize(bytes) {
    let size = bytes;
    const units = ['B', 'kB', 'MB', 'GB'];
    let unit = 0;
    while (size >= 1000 && unit < units.length - 1) {
        size /= 1000;
        unit += 1;
    }
    return unit === 0
        ? `${Math.round(size)} ${units[unit]}`
        : `${size.toFixed(1)} ${units[unit]}`;
}

function uriFilePath(uri) {
    try {
        return GLib.uri_parse(uri, GLib.UriFlags.NONE).get_path() ?? uri;
    } catch {
        return uri;
    }
}

function clamp(value, lower, upper) {
    return Math.max(lower, Math.min(value, upper));
}
