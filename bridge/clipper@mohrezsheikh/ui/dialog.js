/* The Clipper popup: card dialog rendered inside GNOME Shell, anchored to
 * the mouse pointer on the focused monitor.
 */
import Clutter from 'gi://Clutter';
import Cogl from 'gi://Cogl';
import GdkPixbuf from 'gi://GdkPixbuf';
import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import Pango from 'gi://Pango';
import Shell from 'gi://Shell';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import {KIND_FILES, KIND_IMAGE, KIND_TEXT} from '../lib/storage.js';

const CODE_HINT_RE = /[{};()\[\]<>]|(^|\n)\s+(def |function |class |import |const |let |var |return |#include|func |SELECT )/;

export class ClipperDialog {
    constructor({history, incognito, hideOnFocusLoss = true, theme = 'dark',
                 position = null, shortcut = '', autoPaste = true, onPaste,
                 onCopy, onClear, onIncognitoChanged, onOpenFolder, onMoved}) {
        this._history = history;
        this._onPaste = onPaste;
        this._onCopy = onCopy;
        this._onClear = onClear;
        this._onIncognitoChanged = onIncognitoChanged;
        this._onOpenFolder = onOpenFolder;
        this._onMoved = onMoved;
        this._incognito = incognito;
        this._hideOnFocusLoss = hideOnFocusLoss;
        this._theme = theme === 'light' ? 'light' : 'dark';
        this._savedPosition = position;
        this._shortcut = shortcut;
        this._autoPaste = autoPaste;

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
        this._drag = null;
        this._dragGuard = 0;
        this._grab = null;
        this._pressMods = 0;
        this._keyMods = 0;
    }

    setHideOnFocusLoss(enabled) {
        this._hideOnFocusLoss = enabled;
    }

    setAutoPaste(enabled) {
        this._autoPaste = !!enabled;
        if (this._built)
            this._updateHint();
    }

    setShortcut(accel) {
        this._shortcut = accel ?? '';
    }

    /* 'light' or 'dark': the extension resolves "follow the system" before
     * calling this, so the panel never has to guess. */
    setTheme(mode) {
        const next = mode === 'light' ? 'light' : 'dark';
        if (next === this._theme)
            return;
        this._theme = next;
        this._applyTheme();
    }

    /* [x, y] once the user has dragged the panel somewhere, null to go back to
     * "next to the pointer". */
    setPosition(position) {
        this._savedPosition = position ?? null;
        if (this._open)
            this._position();
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
        this._endDrag(false);
        try {
            this._build();
        } catch (e) {
            log(`clipper: building the dialog failed: ${e}`);
            this._destroyChrome();
            return;
        }
        try {
            this._refreshRows();
        } catch (e) {
            // an empty panel still beats no panel at all
            log(`clipper: filling the dialog failed: ${e}`);
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
        this._endDrag(false);
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
                'captured-event', (_actor, event) => this._onStageEvent(event));
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
                    // focus moves are not mistaken for this.  A drag also takes
                    // the keyboard for as long as it lasts — that is not the
                    // user walking away.
                    GLib.timeout_add(GLib.PRIORITY_DEFAULT, 150, () => {
                        if (this._open && this._hideOnFocusLoss &&
                            !this._drag && !this._cardHasFocus())
                            this.close();
                        return GLib.SOURCE_REMOVE;
                    });
                });
        } catch (e) {
            log(`clipper: focus-loss watch failed: ${e}`);
        }
    }

    /* The panel never grabs input to run itself, so its own drag has to be
     * tracked here: press on the body (not on a control), then motion until the
     * button comes up. */
    _onStageEvent(event) {
        if (!this._open && !this._drag)
            return Clutter.EVENT_PROPAGATE;
        const type = event.type();

        if (this._drag) {
            const [x, y] = event.get_coords();
            if (type === Clutter.EventType.MOTION) {
                this._dragTo(x, y);
                return this._drag.moved ? Clutter.EVENT_STOP
                    : Clutter.EVENT_PROPAGATE;
            }
            if (type === Clutter.EventType.BUTTON_RELEASE)
                return this._endDrag(true) ? Clutter.EVENT_STOP
                    : Clutter.EVENT_PROPAGATE;
            return Clutter.EVENT_PROPAGATE;
        }

        if (type !== Clutter.EventType.BUTTON_PRESS)
            return Clutter.EVENT_PROPAGATE;
        const [x, y] = event.get_coords();
        // let the click through to whatever was clicked
        if (!this._overCard(x, y))
            this.close();
        return Clutter.EVENT_PROPAGATE;
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

    /* ---------------------------------------------------------- dragging */
    /* Called from the card's own press handler, which only runs when no child
     * consumed the press — so the search bar, the buttons and every chip keep
     * working, while the grabber, the padding and the gaps between rows move
     * the panel. */
    _beginDrag(x, y) {
        if (this._drag)
            return;
        try {
            const [cx, cy] = this._card.get_transformed_position();
            this._drag = {pointerX: x, pointerY: y, cardX: cx, cardY: cy,
                          moved: false};
        } catch (e) {
            log(`clipper: could not start the drag: ${e}`);
            return;
        }
        // The pointer is deliberately NOT grabbed here. A grab on press routes
        // the release to the panel and St.Button never emits "clicked", so
        // every plain click on a row would be swallowed. The grab is taken in
        // _dragTo() once the pointer has really moved, which is also the moment
        // the press stops being a click.
        // a lost release (grab revoked mid-drag) must not leave the panel
        // glued to the pointer for the rest of the session
        this._dragGuard = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 15000, () => {
            this._dragGuard = 0;
            this._endDrag(true);
            return GLib.SOURCE_REMOVE;
        });
    }

    _dragTo(x, y) {
        const drag = this._drag;
        if (!drag)
            return;
        const dx = x - drag.pointerX;
        const dy = y - drag.pointerY;
        if (!drag.moved && Math.abs(dx) < 4 && Math.abs(dy) < 4)
            return; // a press that has not moved yet is still a click
        if (!drag.moved) {
            drag.moved = true;
            // from here on the press is a drag: steal the pointer so the motion
            // keeps coming over other windows and the release cannot turn into
            // a click on the row underneath
            try {
                this._grab = global.stage.grab(this._card);
            } catch (e) {
                this._grab = null;
                log(`clipper: pointer grab unavailable, dragging inside the panel only: ${e}`);
            }
        }
        try {
            const [width, height] = this._card.get_transformed_size();
            const area = this._workAreaAt(drag.cardX + dx + width / 2,
                drag.cardY + dy + height / 2);
            const nx = clamp(Math.round(drag.cardX + dx),
                area.x + 8, area.x + area.width - width - 8);
            const ny = clamp(Math.round(drag.cardY + dy),
                area.y + 8, area.y + area.height - height - 8);
            this._card.set_position(nx, ny);
        } catch (e) {
            log(`clipper: moving the panel failed: ${e}`);
        }
    }

    /* Returns true when a real drag ended, i.e. when the release belongs to the
     * panel. A press that never moved is a click and must be left alone so
     * St.Button can finish it. */
    _endDrag(commit) {
        if (this._dragGuard) {
            GLib.source_remove(this._dragGuard);
            this._dragGuard = 0;
        }
        if (this._grab) {
            try {
                this._grab.dismiss();
            } catch (e) {
                log(`clipper: could not release the pointer: ${e}`);
            }
            this._grab = null;
        }
        const drag = this._drag;
        this._drag = null;
        const dragged = !!drag && drag.moved;
        if (!drag || !commit || !drag.moved)
            return dragged;
        try {
            const [x, y] = this._card.get_position();
            this._onMoved?.(Math.round(x), Math.round(y));
            log(`clipper: panel moved to ${Math.round(x)},${Math.round(y)}`);
        } catch (e) {
            log(`clipper: keeping the new position failed: ${e}`);
        }
        // a pointer grab holds the keyboard too: give it back to the search bar
        if (this._open)
            this._search.grab_key_focus();
        return dragged;
    }

    _workAreaAt(x, y) {
        try {
            let monitor = this._monitorIndexAt(x, y);
            if (monitor < 0)
                monitor = Main.layoutManager.primaryIndex;
            return Main.layoutManager.getWorkAreaForMonitor(monitor);
        } catch {
            return {x: 0, y: 0,
                    width: Math.max(1, global.stage.width),
                    height: Math.max(1, global.stage.height)};
        }
    }

    _monitorIndexAt(x, y) {
        return Main.layoutManager.monitors.findIndex(
            m => x >= m.x && x < m.x + m.width &&
                 y >= m.y && y < m.y + m.height);
    }

    /* An empty panel is a good place to name the actual hotkey: the user may
     * have changed it in the settings. */
    _shortcutLabel() {
        return prettyShortcut(this._shortcut);
    }

    destroy() {
        this.close();
        this._endDrag(false);
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
        if (this._built) {
            this._updateIncognitoButton();
            this._updateHint();
        }
    }

    /* Swapping one class is all a palette change costs: the stylesheet carries
     * both, so nothing is re-parsed and the panel does not flicker. */
    _applyTheme() {
        if (!this._card)
            return;
        const light = this._theme === 'light';
        this._card.remove_style_class_name(
            light ? 'clipper-theme-dark' : 'clipper-theme-light');
        this._card.add_style_class_name(
            light ? 'clipper-theme-light' : 'clipper-theme-dark');
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
        this._applyTheme();
        this._card.connect('captured-event',
            this._onCapturedEvent.bind(this));
        // The press is armed for a drag in the capture phase (see
        // _onCapturedEvent) rather than here: St.Button stops the press, so a
        // bubbling handler would never see a press on a row or a chip and the
        // panel could only be dragged by its padding.

        // the grabber: says "this panel can be moved" without a tooltip
        const grip = new St.Widget({
            style_class: 'clipper-grip',
            x_align: Clutter.ActorAlign.CENTER,
            reactive: true,
        });
        this._card.add_child(grip);

        // search bar with an explicit close button (always-dismissable)
        const topBar = new St.BoxLayout({
            style_class: 'clipper-topbar',
            vertical: false,
            x_expand: true,
        });
        this._search = new St.Entry({
            style_class: 'clipper-search',
            hint_text: 'Search',
            can_focus: true,
            x_expand: true,
            text: this._searchText,
        });
        this._search.set_primary_icon(new St.Icon({
            icon_name: 'edit-find-symbolic',
            style_class: 'clipper-search-icon',
        }));
        this._search.get_clutter_text().connect('text-changed', () => {
            this._filterText = this._search.text ?? '';
            this._refreshRows();
        });
        // St.Entry has no `activate` signal; the inner ClutterText does.
        this._search.get_clutter_text().connect('activate',
            () => this._pasteSelected());
        topBar.add_child(this._search);

        this._closeButton = new St.Button({
            style_class: 'clipper-button clipper-icon-button clipper-close',
            y_align: Clutter.ActorAlign.CENTER,
        });
        this._closeButton.set_child(new St.Icon({
            icon_name: 'window-close-symbolic',
            icon_size: 13,
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
        this._hint = ellipsizeLabel(new St.Label({
            style_class: 'clipper-hint',
            text: '',
            y_align: Clutter.ActorAlign.CENTER,
            x_expand: true,
        }));
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
            icon_size: 13,
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
        const type = event.type();
        if (this._drag) {
            // a grab taken mid-drag routes everything through here, release
            // included; a press that never moved is still a plain click, so its
            // release has to reach the row button to become a "clicked"
            const [x, y] = event.get_coords();
            if (type === Clutter.EventType.MOTION) {
                this._dragTo(x, y);
                return this._drag.moved ? Clutter.EVENT_STOP
                    : Clutter.EVENT_PROPAGATE;
            }
            if (type === Clutter.EventType.BUTTON_RELEASE)
                return this._endDrag(true) ? Clutter.EVENT_STOP
                    : Clutter.EVENT_PROPAGATE;
        }
        if (type === Clutter.EventType.BUTTON_PRESS) {
            // remembered so a row click can see whether Ctrl was down: the row
            // is activated by St.Button, which does not pass the event on
            this._pressMods = event.get_state?.() ?? 0;
            // armed for every press: a press that never moves stays a click
            // (the release is passed on to St.Button), a press that moves drags
            if (event.get_button() === 1) {
                const [x, y] = event.get_coords();
                this._beginDrag(x, y);
            }
            return Clutter.EVENT_PROPAGATE;
        }
        if (type !== Clutter.EventType.KEY_PRESS)
            return Clutter.EVENT_PROPAGATE;
        this._keyMods = event.get_state?.() ?? 0;
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
            this._activate(entry.item, this._keyMods);
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

        let items = [];
        try {
            items = this._history.search(this._filterText);
        } catch (e) {
            log(`clipper: searching the history failed: ${e}`);
        }
        for (const item of items) {
            // a single unrenderable item must never keep the popup shut: fall
            // back to a plain label row instead of letting the exception
            // escape into open()
            let entry = null;
            try {
                entry = this._buildRow(item);
            } catch (e) {
                log(`clipper: rendering item ${item?.id} failed: ${e}`);
            }
            if (!entry?.row) {
                try {
                    entry = {row: this._plainRow(item), item};
                } catch (e) {
                    log(`clipper: plain row fallback failed: ${e}`);
                }
            }
            if (!entry)
                continue;
            this._listBox.add_child(entry.row);
            this._rows.push(entry);
        }

        if (items.length === 0) {
            const filtered = (this._filterText ?? '').trim().length > 0;
            const empty = wrapLabel(new St.Label({
                style_class: 'clipper-empty clipper-text',
                text: this._incognito
                    ? 'Incognito is on — nothing new is recorded.'
                    : filtered
                        ? `No items match “${this._filterText.trim()}”.`
                        : 'Nothing copied yet.\nCopy text or take a ' +
                          `screenshot, then press ${this._shortcutLabel()}.`,
            }));
            this._listBox.add_child(empty);
        }

        this._updateHint();

        const keepIndex = respectIndex
            ? clamp(this._selectedIndex, 0, Math.max(0, items.length - 1))
            : 0;
        this._selectedIndex = 0;
        if (items.length > 0)
            this._setSelected(keepIndex);
        else
            this._highlight();
    }

    /* The footer states what a click does, which depends on auto-paste: with
     * it on, picking an item types the paste for the user. */
    _updateHint() {
        if (!this._hint)
            return;
        const count = this._rows.length;
        if (this._incognito) {
            this._hint.text = 'Incognito ON — new copies are not recorded';
            return;
        }
        if (count === 0) {
            this._hint.text = '';
            return;
        }
        this._hint.text =
            `${count} item${count > 1 ? 's' : ''}  ·  ` +
            (this._autoPaste
                ? 'Click or Enter pastes into the window behind · Ctrl+click copies'
                : 'Click or Enter copies to the clipboard') +
            '  ·  Ctrl+S pin · Del remove';
    }

    /* Last-resort row: render whatever we can as plain text. */
    _plainRow(item) {
        const row = new St.BoxLayout({
            style_class: 'clipper-item',
            vertical: false,
            reactive: true,
            x_expand: true,
        });
        const body = new St.Button({
            style_class: 'clipper-item-body',
            x_expand: true,
            y_align: Clutter.ActorAlign.FILL,
            child: wrapLabel(new St.Label({
                style_class: 'clipper-text',
                text: String(item?.content ?? '').slice(0, 400),
            })),
        });
        body.connect('clicked', () => this._activate(item, this._pressMods));
        row.add_child(body);
        return row;
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
        bodyButton.connect('clicked',
            () => this._activate(item, this._pressMods));
        row.add_child(bodyButton);

        // side by side: a vertical stack of three 24px buttons would set a
        // ~96px floor on every row, however short its content is
        const actions = new St.BoxLayout({
            style_class: 'clipper-actions',
            vertical: false,
            y_align: Clutter.ActorAlign.CENTER,
        });
        for (const spec of this._actionsFor(item)) {
            const button = new St.Button({
                style_class: spec.active
                    ? 'clipper-mini-button clipper-mini-active'
                    : 'clipper-mini-button',
                y_align: Clutter.ActorAlign.CENTER,
            });
            button.set_child(new St.Icon({icon_name: spec.icon, icon_size: 12}));
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
            {icon: 'view-pin-symbolic', active: item.pinned, run: (it) => {
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

    /* One press on a row means "put this back where I was typing": the item
     * goes onto the clipboard and the paste is typed into the focused window.
     * Ctrl downgrades that to a plain copy, for pasting somewhere else by
     * hand. */
    _activate(item, mods = 0) {
        if (!item) {
            log('clipper: a row was activated with no item behind it');
            return;
        }
        const copyOnly = (mods & Clutter.ModifierType.CONTROL_MASK) !== 0;
        log(`clipper: row activated (${item.kind}${copyOnly ? ', copy only' : ''})`);
        if (copyOnly) {
            this._onCopy?.(item);
            return;
        }
        this._onPaste?.(item);
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
        box.add_child(ellipsizeLabel(new St.Label({
            style_class: 'clipper-meta',
            text: `${relTime(item.date)}` +
                  `${item.count > 1 ? `  ·  ×${item.count}` : ''}`,
        })));
        return box;
    }

    _textLabel(text, mono = false) {
        return wrapLabel(new St.Label({
            style_class: mono ? 'clipper-text clipper-mono' : 'clipper-text',
            text,
        }));
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
        head.add_child(ellipsizeLabel(new St.Label({
            style_class: 'clipper-text',
            text: urlHost(url),
        })));
        box.add_child(head);
        box.add_child(ellipsizeLabel(new St.Label({
            style_class: 'clipper-meta',
            text: `${clipUrlPath(url, 120)}  ·  ${relTime(item.date)}` +
                  `${item.count > 1 ? `  ·  ×${item.count}` : ''}`,
        })));
        return box;
    }

    /* Code cards in Copyous style: a dim line-number gutter plus lightweight
     * syntax highlighting via Pango markup (keywords, strings, numbers,
     * comments).  Text is escaped first, so markup stays well-formed. */
    _codeLabel(content) {
        const lines = codePreviewLines(content, 8);
        const label = wrapLabel(new St.Label({
            style_class: 'clipper-text clipper-mono',
        }));
        label.clutter_text.set_use_markup(true);
        label.clutter_text.set_markup(annotateCodeLines(lines));
        return label;
    }

    /* A screenshot is its own preview: no file name, no size, no timestamp
     * line — the picture is the content.  The folder chip still gets to the
     * file on disk when the user wants it. */
    _imageView(item) {
        const box = new St.BoxLayout({
            style_class: 'clipper-image-box',
            vertical: true,
        });
        const thumb = this._makeThumb(item.content);
        if (thumb !== null) {
            box.add_child(thumb);
            return box;
        }
        // no texture route and no icon for the file: fall back to the name so
        // the row is still something the user can recognise and click
        box.add_child(this._textLabel(
            item.meta?.name ?? GLib.basename(item.content)));
        return box;
    }

    _makeThumb(path) {
        try {
            const actor = thumbActor(path);
            if (actor)
                return actor;
        } catch (e) {
            log(`clipper: texture thumbnail failed: ${e}`);
        }
        // last resort: the picture is already a file on disk, so an icon can
        // still show it even if the texture route is unavailable
        try {
            return new St.Icon({
                gicon: Gio.FileIcon.new(Gio.File.new_for_path(path)),
                icon_size: 120,
                style_class: 'clipper-thumb',
            });
        } catch (e) {
            log(`clipper: thumbnail failed: ${e}`);
            return null;
        }
    }

    _filesView(item) {
        const paths = item.content.split('\n').map(s => s.trim()).filter(Boolean);
        if (paths.length === 0)
            return this._textLabel(item.content);
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
        head.add_child(ellipsizeLabel(new St.Label({
            style_class: 'clipper-text',
            text: `${firstName}${more}`,
        })));
        box.add_child(head);
        box.add_child(ellipsizeLabel(new St.Label({
            style_class: 'clipper-meta',
            text: `${first.length > 84 ? `…${first.slice(first.length - 84)}` : first}` +
                  `  ·  ${relTime(item.date)}` +
                  `${item.count > 1 ? `  ·  ×${item.count}` : ''}`,
        })));
        return box;
    }

    /* -------------------------------------------------------- positioning */
    /* The panel opens where the pointer is — the point of a Win+V popup is to
     * appear in front of the caret, not in a corner.  Once the user has dragged
     * it somewhere, that position wins instead, clamped to the work area it
     * lands in so a monitor change can never strand the panel off-screen. */
    _position() {
        const [px, py] = global.get_pointer();
        const monitor = this._monitorIndexAt(px, py) >= 0
            ? this._monitorIndexAt(px, py)
            : Main.layoutManager.primaryIndex;
        const area = Main.layoutManager.getWorkAreaForMonitor(monitor);

        const width = Math.min(420, Math.floor(area.width * 0.9));
        const height = Math.min(540, Math.floor(area.height * 0.85));
        this._card.set_size(width, height);

        let x = Math.floor(px - width / 2);
        let y = Math.floor(py + 18);
        if (y + height > area.y + area.height - 24)
            y = py - height - 18;
        x = clamp(x, area.x + 12, area.x + area.width - width - 12);
        y = clamp(y, area.y + 12, area.y + area.height - height - 12);

        const saved = this._savedPosition;
        if (saved) {
            const home = this._monitorIndexAt(saved[0] + width / 2,
                saved[1] + height / 2);
            if (home >= 0) {
                const homeArea = Main.layoutManager.getWorkAreaForMonitor(home);
                x = clamp(Math.round(saved[0]),
                    homeArea.x + 8, homeArea.x + homeArea.width - width - 8);
                y = clamp(Math.round(saved[1]),
                    homeArea.y + 8, homeArea.y + homeArea.height - height - 8);
            }
        }

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

/* The panel has a fixed width, so a long path, URL or pasted one-liner would
 * otherwise be cut off mid-character: labels that must stay on one line get an
 * ellipsis, body text wraps. */
function ellipsizeLabel(label) {
    label.clutter_text.set_ellipsize(Pango.EllipsizeMode.END);
    return label;
}

function wrapLabel(label) {
    label.clutter_text.set_line_wrap(true);
    return label;
}

/* '<Control><Alt>v' reads as 'Ctrl+Alt+V' in the panel.  The settings provide
 * the accel string as GTK writes it; the shell has no GTK to ask for a label,
 * and importing Gtk here would drag a second toolkit into gnome-shell, so this
 * covers the modifiers Clipper accepts and names the keys people actually use
 * (GTK writes them lower case: 'space', 'page_up', 'f5'). */
const KEY_LABELS = {
    space: 'Space', tab: 'Tab', return: 'Return', escape: 'Escape',
    backspace: 'Backspace', delete: 'Delete', insert: 'Insert',
    home: 'Home', end: 'End', page_up: 'Page Up', page_down: 'Page Down',
    up: 'Up', down: 'Down', left: 'Left', right: 'Right',
    print: 'Print', menu: 'Menu', pause: 'Pause',
    kp_enter: 'Enter', kp_insert: 'Insert', kp_delete: 'Delete',
};

function prettyShortcut(accel) {
    const text = (accel ?? '')
        .replace(/<Control>|<Primary>/gi, 'Ctrl+')
        .replace(/<Alt>|<Mod1>/gi, 'Alt+')
        .replace(/<Shift>/gi, 'Shift+')
        .replace(/<Super>|<Meta>/gi, 'Super+')
        .replace(/<([^>]+)>/g, '$1+')
        .replace(/\+$/, '');
    if (!text)
        return 'Ctrl+Alt+V';
    const parts = text.split('+');
    const key = parts.pop();
    parts.push(prettyKey(key));
    return parts.join('+');
}

function prettyKey(name) {
    if (name.length === 1)
        return name.toUpperCase();
    const spelled = KEY_LABELS[name.toLowerCase()];
    if (spelled)
        return spelled;
    if (/^f([1-9]|1[0-9]|2[0-4])$/i.test(name))
        return name.toUpperCase();
    return name.charAt(0).toUpperCase() + name.slice(1);
}

/* Roughly a third of the panel's height: the full 344x184 preview pushed
 * everything else out of a 540px window. */
const THUMB_WIDTH = 344;
const THUMB_HEIGHT = 140;

/* An image preview, scaled down from the stored file. GNOME 49 removed
 * Clutter.Image along with St.Image, so the pixels now go into an
 * St.ImageContent that a plain actor paints; the older spelling stays for
 * 45-48. Returns null when no texture route exists. */
function thumbActor(path) {
    const pixbuf = GdkPixbuf.Pixbuf.new_from_file_at_size(path,
        THUMB_WIDTH, THUMB_HEIGHT);
    const width = pixbuf.get_width();
    const height = pixbuf.get_height();
    const rowstride = pixbuf.get_rowstride();
    // a very tall, thin picture can round down to a zero-width pixbuf, and a
    // zero-sized actor paints nothing: fall through to the icon instead
    if (width <= 0 || height <= 0)
        return null;
    const format = pixbuf.get_has_alpha()
        ? Cogl.PixelFormat.RGBA_8888
        : Cogl.PixelFormat.RGB_888;
    const bytes = pixbuf.read_pixel_bytes();

    if (typeof St.ImageContent === 'function') {
        const content = new St.ImageContent({
            preferredWidth: width,
            preferredHeight: height,
        });
        // from 48 on, set_bytes() also wants the Cogl context the texture is
        // created for; asking for it is the difference between a preview and
        // "thumbnail failed" in the log
        if (content.set_bytes.length === 6) {
            const coglContext = defaultCoglContext();
            if (!coglContext)
                return null;
            content.set_bytes(coglContext, bytes, format, width, height, rowstride);
        } else {
            content.set_bytes(bytes, format, width, height, rowstride);
        }
        // St.Widget takes its size from the stylesheet, not from its content,
        // so without an explicit size the picture reports 0x0 and the row
        // squeezes it into a thin full-width strip. The pixbuf is already
        // scaled to fit the box, so pinning the actor to the pixbuf's own size
        // draws it 1:1, undistorted.
        return new St.Widget({
            style_class: 'clipper-thumb',
            content,
            width,
            height,
            x_align: Clutter.ActorAlign.CENTER,
        });
    }

    if (typeof Clutter.Image === 'function' && typeof St.Image === 'function') {
        const image = new Clutter.Image();
        image.set_data(pixbuf.get_pixels(), format, width, height, rowstride);
        return new St.Image({
            image,
            style_class: 'clipper-thumb',
            width,
            height,
            x_align: Clutter.ActorAlign.CENTER,
        });
    }

    return null;
}

function defaultCoglContext() {
    try {
        return Clutter.get_default_backend()?.get_cogl_context?.() ?? null;
    } catch (e) {
        log(`clipper: no Cogl context available: ${e}`);
        return null;
    }
}

function clipText(value, max = 420) {
    const text = String(value ?? '');
    const lines = text.split('\n');
    if (lines.length > 8)
        return lines.slice(0, 8).join('\n') + '\n…';
    if (text.length > max)
        return text.slice(0, max).trimEnd() + '…';
    return text;
}

function relTime(ms) {
    if (!Number.isFinite(Number(ms)))
        return '';
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
    if (!t || t.includes('\n') || t.length > 800 || /\s/.test(t))
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
