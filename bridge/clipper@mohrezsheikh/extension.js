/* Clipper — Windows-style clipboard history for GNOME.
 *
 * Default hotkey: Ctrl+Alt+V (configurable via gsettings).
 *
 * Everything lives inside GNOME Shell:
 *   - captures clipboard changes from Mutter's selection model;
 *   - stores history as JSON + image files under ~/.local/share/Clipper;
 *   - opens a card dialog anchored to the cursor with the hotkey;
 *   - pastes the chosen item into the previously focused window
 *     (clipboard claim + Ctrl+V injection).
 *
 * No daemon, no additional processes.
 */
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Meta from 'gi://Meta';
import Shell from 'gi://Shell';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';

import {CaptureManager} from './lib/capture.js';
import {ClipperHistory, KIND_IMAGE, KIND_FILES} from './lib/storage.js';
import {ClipperDialog} from './ui/dialog.js';

const DEFAULT_ACCEL = '<Control><Alt>v';

const IFACE_SCHEMA = 'org.gnome.desktop.interface';

export default class ClipperExtension extends Extension {
    enable() {
        this._settings = this.getSettings('io.github.mohrezsheikh.clipper');
        this._loadStylesheet();
        // before the dialog exists: "follow the system" has to be resolvable
        // when the panel is built, not one setting-change later
        this._interfaceBind();

        this._history = new ClipperHistory();
        this._history.setLimit(this._settings.get_int('history-limit'));

        this._capture = new CaptureManager(this._history, this._settings);
        this._capture.start({onCaptured: this._refreshDialog.bind(this)});

        this._dialog = new ClipperDialog({
            history: this._history,
            incognito: this._settings.get_boolean('incognito'),
            hideOnFocusLoss: this._settings.get_boolean('hide-on-focus-loss'),
            theme: this._effectiveTheme(),
            position: this._panelPosition(),
            shortcut: this._shortcut(),
            autoPaste: this._settings.get_boolean('auto-paste'),
            onPaste: this._paste.bind(this),
            onCopy: this._copy.bind(this),
            onClear: this._clear.bind(this),
            onIncognitoChanged: enabled => {
                this._settings.set_boolean('incognito', enabled);
                log(`clipper: incognito ${enabled ? 'ON' : 'OFF'}`);
                this._refreshDialog();
            },
            onOpenFolder: this._openFolder.bind(this),
            onMoved: (x, y) => this._settings.set_value('panel-position',
                new GLib.Variant('(ii)', [x, y])),
        });

        this._toggleHandler = () => this._dialog?.toggle();
        if (!this._addToggleKeybinding())
            log('clipper: the configured shortcut was rejected, the panel has no hotkey');

        // the panel must never float over the lock screen
        this._sessionSignal = Main.sessionMode.connect('updated', () => {
            if (Main.sessionMode.isLocked || Main.sessionMode.isGreeter)
                this._dialog?.close();
        });

        this._settingsBind();
        // read the build from metadata.json so the journal can never report a
        // version the package does not actually carry
        const build = this.metadata?.['version-name'] ?? 'unknown';
        log(`clipper: extension enabled (build ${build}), hotkey ${this._shortcut()}, ` +
            `appearance ${this._effectiveTheme()}`);
    }

    disable() {
        if (this._sessionSignal) {
            Main.sessionMode.disconnect(this._sessionSignal);
            this._sessionSignal = 0;
        }
        for (const id of this._settingsSignals ?? []) {
            try {
                this._settings.disconnect(id);
            } catch {
                /* settings already gone */
            }
        }
        this._settingsSignals = [];
        if (this._ifaceSettings) {
            for (const id of this._ifaceSignals ?? []) {
                try {
                    this._ifaceSettings.disconnect(id);
                } catch {
                    /* interface settings already gone */
                }
            }
            this._ifaceSignals = [];
            this._ifaceSettings = null;
        }
        try {
            Main.wm.removeKeybinding('clipper-toggle');
        } catch (e) {
            log(`clipper: could not remove the keybinding: ${e}`);
        }
        this._toggleHandler = null;
        this._capture?.stop();
        this._capture = null;
        this._dialog?.destroy();
        this._dialog = null;
        this._history = null;
        this._unloadStylesheet();
        this._settings = null;
        log('clipper: extension disabled');
    }

    _settingsBind() {
        this._settingsSignals = [
            this._settings.connect(
                'changed::history-limit',
                () => this._history.setLimit(
                    this._settings.get_int('history-limit'))),
            this._settings.connect(
                'changed::incognito',
                () => this._dialog.setIncognito(
                    this._settings.get_boolean('incognito'))),
            this._settings.connect(
                'changed::hide-on-focus-loss',
                () => this._dialog.setHideOnFocusLoss(
                    this._settings.get_boolean('hide-on-focus-loss'))),
            this._settings.connect(
                'changed::auto-paste',
                () => this._dialog.setAutoPaste(
                    this._settings.get_boolean('auto-paste'))),
            this._settings.connect(
                'changed::theme', () => this._applyTheme()),
            this._settings.connect(
                'changed::panel-position',
                () => this._dialog.setPosition(this._panelPosition())),
            this._settings.connect(
                'changed::clipper-toggle', () => {
                    this._rebindToggle();
                    // the empty state names the hotkey, so it has to keep up
                    this._dialog?.setShortcut(this._shortcut());
                }),
        ];
    }

    /* ---------------------------------------------------------- appearance */
    /* "system" means whatever the desktop is doing; the Shell itself follows
     * color-scheme, and the gtk-theme name is the fallback for setups that
     * predate it.  GNOME 49 made this reachable without a private API. */
    _interfaceBind() {
        try {
            this._ifaceSettings = new Gio.Settings({schema_id: IFACE_SCHEMA});
            this._ifaceSignals = [
                this._ifaceSettings.connect('changed::color-scheme',
                    () => this._applyTheme()),
                this._ifaceSettings.connect('changed::gtk-theme',
                    () => this._applyTheme()),
            ];
        } catch (e) {
            log(`clipper: could not watch the desktop appearance: ${e}`);
            this._ifaceSettings = null;
        }
    }

    _effectiveTheme() {
        let mode = 'system';
        try {
            mode = this._settings.get_string('theme');
        } catch (e) {
            log(`clipper: unreadable theme setting: ${e}`);
        }
        if (mode === 'light' || mode === 'dark')
            return mode;
        return this._systemTheme();
    }

    _systemTheme() {
        try {
            const scheme = this._ifaceSettings
                ? this._ifaceSettings.get_string('color-scheme') : '';
            if (scheme === 'prefer-light')
                return 'light';
            if (scheme === 'prefer-dark' || scheme === 'dark')
                return 'dark';
            const gtkTheme = this._ifaceSettings
                ? this._ifaceSettings.get_string('gtk-theme') : '';
            return /-dark$/i.test(gtkTheme) ? 'dark' : 'light';
        } catch (e) {
            log(`clipper: could not read the desktop appearance: ${e}`);
            return 'dark';
        }
    }

    _applyTheme() {
        this._dialog?.setTheme(this._effectiveTheme());
    }

    /* 0,0 is the sentinel for "no saved place": the panel then opens at the
     * pointer like Windows' Win+V, which is what most people expect. */
    _panelPosition() {
        try {
            const [x, y] = this._settings.get_value('panel-position').deepUnpack();
            return (x === 0 && y === 0) ? null : [x, y];
        } catch (e) {
            log(`clipper: unreadable panel position: ${e}`);
            return null;
        }
    }

    /* --------------------------------------------------------- keybinding */
    _shortcut() {
        return this._settings.get_strv('clipper-toggle')[0] ?? DEFAULT_ACCEL;
    }

    _addToggleKeybinding() {
        try {
            Main.wm.addKeybinding(
                'clipper-toggle', this._settings,
                Meta.KeyBindingFlags.IGNORE_AUTOREPEAT,
                Shell.ActionMode.ALL,
                this._toggleHandler);
            return true;
        } catch (e) {
            log(`clipper: cannot bind ${this._shortcut()}: ${e}`);
            return false;
        }
    }

    /* The hotkey is editable in the prefs window, so the binding follows the
     * setting instead of being registered once and forgotten. */
    _rebindToggle() {
        if (this._rebinding || !this._toggleHandler)
            return;
        try {
            Main.wm.removeKeybinding('clipper-toggle');
        } catch (e) {
            log(`clipper: could not remove the old keybinding: ${e}`);
        }
        if (this._addToggleKeybinding()) {
            log(`clipper: hotkey is now ${this._shortcut()}`);
            return;
        }
        // whatever was set is unusable: fall back to the default instead of
        // leaving the panel with no way to open it
        this._rebinding = true;
        this._settings.set_strv('clipper-toggle', [DEFAULT_ACCEL]);
        this._rebinding = false;
        this._addToggleKeybinding();
    }

    /* -------------------------------------------------------------- styling */
    _loadStylesheet() {
        try {
            const context = St.ThemeContext.get_for_stage(global.stage);
            this._cssFile = Gio.File.new_for_uri(
                `${this.dir.get_uri()}/clipboard.css`);
            context.get_theme().load_stylesheet(this._cssFile);
        } catch (e) {
            log(`clipper: stylesheet load failed: ${e}`);
        }
    }

    _unloadStylesheet() {
        if (!this._cssFile)
            return;
        try {
            const context = St.ThemeContext.get_for_stage(global.stage);
            context.get_theme().unload_stylesheet(this._cssFile);
        } catch {
            /* theme may have been reset in a shell restart */
        }
        this._cssFile = null;
    }

    _refreshDialog() {
        if (this._dialog?.isOpen())
            this._dialog._refreshRows();
    }

    /* ---------------------------------------------------------- dialog glue */
    async _paste(item) {
        // close first so the shell hands focus back to the previous window,
        // then claim the clipboard and type the paste into it
        this._dialog?.close();
        GLib.timeout_add(GLib.PRIORITY_DEFAULT, 120, () => {
            this._capture?.pasteItem(item).catch(
                e => log(`clipper: paste failed: ${e}`));
            return GLib.SOURCE_REMOVE;
        });
    }

    async _copy(item) {
        try {
            await this._capture?.claim(item);
            log('clipper: item copied to clipboard');
        } catch (e) {
            log(`clipper: copy failed: ${e}`);
        }
        this._refreshDialog();
    }

    _clear() {
        this._history.clear(true);
        this._refreshDialog();
    }

    _openFolder(item) {
        try {
            const paths = item.content.split('\n').map(l => l.trim())
                .filter(Boolean);
            if (paths.length === 0)
                return;
            const path = item.kind === KIND_IMAGE
                ? item.content : uriFilePath(paths[0]);
            const dir = GLib.path_get_dirname(path);
            Gio.Subprocess.new(['nautilus', dir],
                Gio.SubprocessFlags.NONE);
        } catch (e) {
            log(`clipper: open folder failed: ${e}`);
        }
    }
}

function uriFilePath(uri) {
    try {
        return GLib.uri_parse(uri, GLib.UriFlags.NONE).get_path() ?? uri;
    } catch {
        return uri;
    }
}
