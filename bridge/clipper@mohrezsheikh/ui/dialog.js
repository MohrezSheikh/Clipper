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
    constructor({history, incognito, hideOnFocusLoss = true, onPaste, onCopy,
                 onClear, onIncognitoChanged, onOpenFolder}) {
        this._history = history;
        this._onPaste = onPaste;
        this._onCopy = onCopy;
        this._onClear = onClear;
        this._onIncognitoChanged = onIncognitoChanged;
        this._onOpenFolder = onOpenFolder;
        this._incognito = incognito;
        this._hideOnFocusLoss = hideOnFocusLoss;

        this._open = false;
        this._built = false;
        this._rows = [];
        this._selectedIndex = 0;
        this._filterText = '';
        this._searchText = '';
        this._displaySignal = 0;
        this._stageSignal = 0;
        this._textSignal = 0;
        this._focusWindowAtOpen = null;
    }

    setHideOnFocusLoss(enabled) {
        this._hideOnFocusLoss = enabled;
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

    /* Non-blocking panel: no input grab, so other apps stay fully usable while
     * the dialog is open — but it dismisses itself the moment the user turns
     * to something else (click elsewhere, focus another window, Esc, the
     * toggle key again, or picking an item), exactly like the Windows panel.
     * It never keeps the clipboard over the rest of the desktop. */
    open() {
        if (this._open)
            return;
        try {
            this._build();
            this._refreshRows();
        } catch (e) {
            log(`clipper: opening dialog failed: ${e}`);
            this._destroyChrome();
            return;
        }
        try {
            Main.layoutManager.uiGroup.add_child(this._card);
            Main.layoutManager.uiGroup.set_child_above_sibling(this._card, null);
            this._position();
            this._card.show();
            this._open = true;
            this._focusWindowAtOpen = global.display.focus_window ?? null;
            this._connectDismiss();
            this._search.grab_key_focus();
        } catch (e) {
            log(`clipper: showing dialog failed: ${e}`);
            this.close();
            return;
        }
        log('clipper: dialog opened');
    }

    close() {
        if (!this._open)
            return;
        this._open = false;
        this._destroyChrome();
        // hand keyboard focus back deterministically (removing the actor from
        // the stage usually does this too, but be explicit)
        try {
            global.stage.set_key_focus(null);
        } catch {
            /* stage already gone (shell shutting down) */
        }
        log('clipper: dialog closed');
    }

    /* Nothing here grabs input: we only observe.  That is why the panel can
     * never lock the desktop up, while still disappearing as soon as the user
     * goes back to their work. */
    _connectDismiss() {
        if (this._displaySignal || this._stageSignal || this._textSignal)
            return;
        try {
            this._displaySignal = global.display.connect(
                'notify::focus-window', () => {
                    if (!this._open)
                        return;
                    const focused = global.display.focus_window;
                    if (focused && focused !== this._focusWindowAtOpen)
                        this.close();
                });
        } catch (e) {
            log(`clipper: focus-window watch failed: ${e}`);
        }

        try {
            this._stageSignal = global.stage.connect(
                'captured-event', (_actor, event) => {
                    if (!this._open ||
                        event.type() !== Clutter.EventType.BUTTON_PRESS)
                        return Clutter.EVENT_PROPAGATE;
                    const [x, y] = event.get_coords();
                    // let the click through to whatever was clicked
                    if (!this._overCard(x, y))
                        this.close();
                    return Clutter.EVENT_PROPAGATE;
                });
        } catch (e) {
            log(`clipper: outside-click watch failed: ${e}`);
        }

        try {
            this._textSignal = this._search.get_clutter_text().connect(
                'key-focus-out', (_text, next) => {
                    if (!this._open || !this._hideOnFocusLoss)
                        return;
                    if (next && this._card.contains(next))
                        return;
                    // focus is leaving the shell UI: close on idle so in-panel
                    // focus moves are not mistaken for this
                    GLib.timeout_add(GLib.PRIORITY_DEFAULT, 150, () => {
                        if (this._open && this._hideOnFocusLoss &&
                            !this._cardHasFocus())
                            this.close();
                        return GLib.SOURCE_REMOVE;
                    });
                });
        } catch (e) {
            log(`clipper: focus-loss watch failed: ${e}`);
        }
    }

    _cardHasFocus() {
        try {
            const focused = global.stage.get_key_focus();
            return !!focused && this._card.contains(focused);
        } catch {
            return false;
        }
    }

    _overCard(x, y) {
        try {
            const [cx, cy] = this._card.get_transformed_position();
            const [cw, ch] = this._card.get_transformed_size();
            return x >= cx && x <= cx + cw && y >= cy && y <= cy + ch;
        } catch {
            return false;
        }
    }

    destroy() {
        this.close();
        if (this._displaySignal) {
            global.display.disconnect(this._displaySignal);
            this._displaySignal = 0;
        }
        if (this._stageSignal) {
            global.stage.disconnect(this._stageSignal);
            this._stageSignal = 0;
        }
        if (this._textSignal) {
            this._search?.get_clutter_text().disconnect(this._textSignal);
            this._textSignal = 0;
        }
        this._card?.destroy();
        this._card = null;
        this._search = null;
        this._built = false;
        this._rows = [];
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
            const filtered = (this._filterText ?? '').trim().length > 0;
            const empty = new St.Label({
                style_class: 'clipper-empty clipper-text',
                text: this._incognito
                    ? 'Incognito is on — nothing new is recorded.'
                    : filtered
                        ? `No items match “${this._filterText.trim()}”.`
                        : 'Nothing copied yet.\n' +
                          'Copy text or take a screenshot, then press Ctrl+Alt+V.',
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
        if (item.kind === KIND_TEXT && looksLikeUrl(item.content))
            return this._urlView(item);
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
        if (code)
            box.add_child(this._codeLabel(item.content));
        else
            box.add_child(this._textLabel(clipText(item.content, 420)));
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

    _urlView(item) {
        const url = item.content.trim();
        const box = new St.BoxLayout({
            style_class: 'clipper-files-box',
            vertical: true,
        });
        const head = new St.BoxLayout({
            style_class: 'clipper-head',
            vertical: false,
        });
        head.add_child(new St.Icon({
            icon_name: 'web-browser-symbolic', icon_size: 15,
        }));
        head.add_child(new St.Label({
            style_class: 'clipper-text',
            text: urlHost(url),
        }));
        box.add_child(head);
        box.add_child(new St.Label({
            style_class: 'clipper-meta',
            text: `${clipUrlPath(url, 120)}  ·  ${relTime(item.date)}` +
                  `${item.count > 1 ? `  ·  ×${item.count}` : ''}`,
        }));
        return box;
    }

    /* Code cards in Copyous style: a dim line-number gutter plus lightweight
     * syntax highlighting via Pango markup (keywords, strings, numbers,
     * comments).  Text is escaped first, so markup stays well-formed. */
    _codeLabel(content) {
        const lines = codePreviewLines(content, 8);
        const label = new St.Label({style_class: 'clipper-text clipper-mono'});
        label.clutter_text.set_use_markup(true);
        label.clutter_text.set_markup(annotateCodeLines(lines));
        return label;
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
            // near full-card width, like the reference manager
            const pixbuf = GdkPixbuf.Pixbuf.new_from_file_at_size(path, 430, 230);
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

/* ------------------------------------------------- code & url renderers */
function escapePango(text) {
    return text
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');
}

function codePreviewLines(content, maxLines) {
    const all = content.split('\n');
    const out = all.slice(0, maxLines).map(l => l.replace(/[ \t]+$/, ''));
    if (all.length > maxLines)
        out.push('…');
    return out;
}

const CODE_TOKEN_RE = new RegExp(
    '(/(?:[^/\\\n]|\\.)+/|(?:"(?:[^"\\\\]|\\\\.)*"|\'(?:[^\'\\\\]|\\\\.)*\'|`(?:[^`\\\\]|\\\\.)*`))' +
    '|(#[^\n]*|//[^\n]*|--[^\n]*)' +
    '|\\b\\d+(?:[.]\\d+)?\\b' +
    "|\\b(def|class|import|from|export|return|if|elif|else|for|while|function|lambda|const|let|var|pub|fn|enum|struct|impl|trait|match|use|package|type|interface|async|await|new|this|self|None|True|False|null|undefined|true|false|SELECT|FROM|WHERE|INSERT|UPDATE|DELETE)\\b",
    'g');

const KEYWORDS = new Set('def class import from export return if elif else for while function lambda const let var pub fn enum struct impl trait match use package type interface async await new this self None True False null undefined true false SELECT FROM WHERE INSERT UPDATE DELETE'.split(' '));

function highlightLine(escapedLine) {
    // single pass: strings+regexes, comments, numbers, keywords -> spans.
    return escapedLine.replace(CODE_TOKEN_RE, token => {
        let color;
        if (KEYWORDS.has(token))
            color = '#ff8578';
        else if (token.startsWith('#') || token.startsWith('//') ||
                 token.startsWith('--'))
            color = '#8b949e';
        else if (/^\d/.test(token))
            color = '#d2a8ff';
        else
            color = '#a5b6d9';
        return `<span foreground="${color}">${token}</span>`;
    });
}

function annotateCodeLines(lines) {
    const gutterWidth = String(lines.length).length;
    return lines.map((line, index) => {
        const number = String(index + 1).padStart(gutterWidth, ' ');
        return `<span foreground="#5f6672">${number}</span>  ` +
            highlightLine(escapePango(line));
    }).join('\n');
}

function looksLikeUrl(text) {
    const t = (text ?? '').trim();
    if (!t || '\n' in t || t.length > 800 || /\s/.test(t))
        return false;
    return /^https?:\/\//i.test(t) || /^www\./i.test(t) || /^(mailto:|ftp:\/\/)/i.test(t);
}

function urlHost(url) {
    try {
        const parsed = GLib.uri_parse(url, GLib.UriFlags.NONE);
        return parsed?.get_host() ?? url;
    } catch {
        return url;
    }
}

function clipUrlPath(url, max) {
    return url.length > max ? `…${url.slice(url.length - max)}` : url;
}
