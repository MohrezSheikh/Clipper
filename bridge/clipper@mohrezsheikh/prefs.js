/* Clipper — preferences.
 *
 * The setting people actually want to touch is the hotkey, so it gets a
 * capture row: click, press the combination, done. The rest is how the panel
 * behaves once it is open.
 */
import Adw from 'gi://Adw';
import Gdk from 'gi://Gdk';
import Gio from 'gi://Gio';
import Gtk from 'gi://Gtk';

import {ExtensionPreferences} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

const DEFAULT_ACCEL = '<Control><Alt>v';
const MODIFIER_KEYS = ['Shift_L', 'Shift_R', 'Control_L', 'Control_R',
    'Alt_L', 'Alt_R', 'Super_L', 'Super_R', 'Meta_L', 'Meta_R',
    'Caps_Lock', 'Num_Lock', 'ISO_Level3_Shift'];

export default class ClipperPreferences extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        this._settings = this.getSettings();
        this._window = window;
        this._capturing = false;

        const page = new Adw.PreferencesPage();
        page.add(this._shortcutGroup());
        page.add(this._appearanceGroup());
        page.add(this._behaviourGroup());
        window.add(page);

        // key capture runs before anything else in the window, otherwise the
        // shell's own shortcuts and the treeview navigation eat the keys
        const keys = new Gtk.EventControllerKey();
        keys.set_propagation_phase(Gtk.PropagationPhase.CAPTURE);
        keys.connect('key-pressed', (_c, keyval, _keycode, state) =>
            this._onKeyPressed(keyval, state));
        window.add_controller(keys);

        this._shortcutChangedId = this._settings.connect(
            'changed::clipper-toggle', () => this._syncShortcutRow());
        window.connect('close-request', () => {
            if (this._shortcutChangedId) {
                this._settings.disconnect(this._shortcutChangedId);
                this._shortcutChangedId = 0;
            }
            return false;
        });

        this._syncShortcutRow();
    }

    /* ---------------------------------------------------------- shortcut */
    _shortcutGroup() {
        const group = new Adw.PreferencesGroup({
            title: 'Shortcut',
            description: 'Press the combination you want to open the panel with. ' +
                'It has to include Ctrl, Alt or Super, since a plain letter ' +
                'would swallow your typing everywhere. ' +
                'This window is always reachable from the Extensions app: ' +
                'Clipper → Settings.',
        });

        this._row = new Adw.ActionRow({
            title: 'Open the clipboard panel',
            activatable: true,
        });
        this._accelLabel = new Gtk.Label({
            valign: Gtk.Align.CENTER,
            css_classes: ['dim-label'],
        });
        this._button = new Gtk.Button({
            label: 'Change',
            valign: Gtk.Align.CENTER,
            css_classes: ['flat'],
        });
        this._button.connect('clicked', () =>
            this._capturing ? this._stopCapture() : this._startCapture());
        this._row.add_suffix(this._accelLabel);
        this._row.add_suffix(this._button);
        this._row.connect('activated', () => this._startCapture());
        group.add(this._row);

        const reset = new Adw.ActionRow({
            title: 'Reset to the default',
            subtitle: prettyAccel(DEFAULT_ACCEL),
            activatable: true,
        });
        const resetButton = new Gtk.Button({
            icon_name: 'edit-undo-symbolic',
            valign: Gtk.Align.CENTER,
            css_classes: ['flat'],
            tooltip_text: 'Reset to Ctrl+Alt+V',
        });
        const doReset = () => {
            this._stopCapture();
            this._write(DEFAULT_ACCEL);
        };
        resetButton.connect('clicked', doReset);
        reset.connect('activated', doReset);
        reset.add_suffix(resetButton);
        group.add(reset);

        return group;
    }

    _startCapture() {
        this._capturing = true;
        this._accelLabel.set_label('Press keys…');
        this._button.set_label('Cancel');
        this._row.add_css_class('accent');
    }

    _stopCapture() {
        this._capturing = false;
        this._row.remove_css_class('accent');
        this._button.set_label('Change');
        this._syncShortcutRow();
    }

    _onKeyPressed(keyval, state) {
        if (!this._capturing)
            return false;

        // Escape leaves the old shortcut alone, Backspace restores the default
        if (keyval === Gdk.KEY_Escape) {
            this._stopCapture();
            return true;
        }
        if (keyval === Gdk.KEY_BackSpace || keyval === Gdk.KEY_Delete) {
            this._write(DEFAULT_ACCEL);
            this._stopCapture();
            return true;
        }

        const name = Gdk.keyval_name(keyval) ?? '';
        if (MODIFIER_KEYS.includes(name))
            return true;                       // still waiting for the real key

        const mods = modifierNames(state);
        const isFunctionKey = /^F([1-9]|1[0-2])$/.test(name);
        if (mods.filter(m => m !== '<Shift>').length === 0 && !isFunctionKey) {
            this._toast('Add Ctrl, Alt or Super to that key');
            return true;
        }

        const accel = mods.join('') + keyName(keyval);
        if (!accelParses(accel)) {
            this._toast('The shortcut is invalid');
            return true;
        }
        this._write(accel);
        this._stopCapture();
        return true;
    }

    _write(accel) {
        const current = this._settings.get_strv('clipper-toggle');
        if (current.length === 1 && current[0] === accel)
            return;
        this._settings.set_strv('clipper-toggle', [accel]);
        log(`clipper: shortcut set to ${accel}`);
        this._syncShortcutRow();
    }

    _syncShortcutRow() {
        if (!this._accelLabel)
            return;
        const accel = this._settings.get_strv('clipper-toggle')[0] ?? DEFAULT_ACCEL;
        this._accelLabel.set_label(prettyAccel(accel));
        this._accelLabel.set_tooltip_text(accel);
    }

    _toast(title) {
        try {
            this._window.add_toast(new Adw.Toast({title}));
        } catch {
            log(`clipper: ${title}`);
        }
    }

    /* -------------------------------------------------------- appearance */
    /* The light palette lives in the same stylesheet as the dark one, so this
     * setting is a class swap on the open panel — it changes in front of you. */
    _appearanceGroup() {
        const group = new Adw.PreferencesGroup({title: 'Appearance'});

        const values = ['system', 'light', 'dark'];
        const current = Math.max(0, values.indexOf(this._themeValue()));

        let row;
        try {
            row = new Adw.ComboRow({
                title: 'Panel appearance',
                subtitle: 'Light, dark, or whatever the desktop is using',
                model: Gtk.StringList.new(['Follow the system', 'Light', 'Dark']),
            });
        } catch (e) {
            log(`clipper: the appearance row is unavailable: ${e}`);
            return group;
        }
        row.set_selected(current);
        row.connect('notify::selected', () => {
            const value = values[row.get_selected()] ?? 'system';
            if (this._themeValue() === value)
                return;
            try {
                this._settings.set_string('theme', value);
            } catch (e) {
                this._toast('Could not save the appearance setting');
                log(`clipper: writing the theme setting failed: ${e}`);
            }
        });
        group.add(row);
        return group;
    }

    _themeValue() {
        try {
            return this._settings.get_string('theme');
        } catch (e) {
            log(`clipper: unreadable theme setting: ${e}`);
            return 'system';
        }
    }

    /* --------------------------------------------------------- behaviour */
    _behaviourGroup() {
        const group = new Adw.PreferencesGroup({title: 'Behaviour'});

        const paste = new Adw.SwitchRow({
            title: 'Paste straight into the window you were in',
            subtitle: 'Picking an entry also sends Ctrl+V, so there is nothing ' +
                'else to press. Turn this off to copy only.',
        });
        this._settings.bind('auto-paste', paste, 'active',
            Gio.SettingsBindFlags.DEFAULT);
        group.add(paste);

        const hide = new Adw.SwitchRow({
            title: 'Close when it loses focus',
            subtitle: 'Clicking anywhere else puts the panel away',
        });
        this._settings.bind('hide-on-focus-loss', hide, 'active',
            Gio.SettingsBindFlags.DEFAULT);
        group.add(hide);

        const limit = new Adw.SpinRow({
            title: 'Entries kept in history',
            subtitle: 'Pinned entries are always kept on top',
            adjustment: new Gtk.Adjustment({
                lower: 20, upper: 2000, step_increment: 10, page_increment: 50,
            }),
        });
        this._settings.bind('history-limit', limit, 'value',
            Gio.SettingsBindFlags.DEFAULT);
        group.add(limit);

        return group;
    }
}

/* ------------------------------------------------------------- helpers */

function modifierNames(state) {
    const {CONTROL_MASK, SHIFT_MASK, SUPER_MASK, META_MASK} = Gdk.ModifierType;
    // GTK4 calls the Alt modifier ALT_MASK; MOD1_MASK, the older way to ask for
    // it, is gone from the namespace and would silently drop every Alt combo
    const ALT_MASK = Gdk.ModifierType.ALT_MASK ?? Gdk.ModifierType.MOD1_MASK;
    const mods = [];
    if (state & CONTROL_MASK)
        mods.push('<Control>');
    if (ALT_MASK && state & ALT_MASK)
        mods.push('<Alt>');
    if (state & SHIFT_MASK)
        mods.push('<Shift>');
    // Super and Meta are the same key here, so never emit both
    if ((SUPER_MASK && state & SUPER_MASK) || (META_MASK && state & META_MASK))
        mods.push('<Super>');
    return mods;
}

function keyName(keyval) {
    // gtk spells single characters in lower case but named keys in their
    // canonical form — it knows "F5" and "Insert", not "f5" or "insert"
    const name = Gdk.keyval_name(keyval) ?? '';
    return name.length === 1 ? name.toLowerCase() : name;
}

function accelParses(accel) {
    try {
        const parsed = Gtk.accelerator_parse(accel);
        const ok = Array.isArray(parsed) ? parsed[0] : parsed;
        return !!ok;
    } catch {
        return true;                            // older GTK: trust the caller
    }
}

function prettyAccel(accel) {
    try {
        const parsed = Gtk.accelerator_parse(accel);
        if (Array.isArray(parsed) && parsed[0])
            return Gtk.accelerator_get_label(parsed[1], parsed[2]);
    } catch {
        /* fall through to the plain formatter */
    }
    return accel.replace(/<(Control|Primary)>/g, 'Ctrl')
        .replace(/<Super>/g, 'Super')
        .replace(/<Alt>/g, 'Alt')
        .replace(/<Shift>/g, 'Shift')
        .replace(/></g, '+')
        .replace(/[<>]/g, '')
        .replace(/([\w]+)$/, m => m.toUpperCase());
}
