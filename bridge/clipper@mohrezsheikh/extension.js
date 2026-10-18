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

export default class ClipperExtension extends Extension {
    enable() {
        this._settings = this.getSettings('io.github.mohrezsheikh.clipper');
        this._loadStylesheet();

        this._history = new ClipperHistory();
        this._history.setLimit(this._settings.get_int('history-limit'));

        this._capture = new CaptureManager(this._history, this._settings);
        this._capture.start({onCaptured: this._refreshDialog.bind(this)});

        this._dialog = new ClipperDialog({
            history: this._history,
            incognito: this._settings.get_boolean('incognito'),
            onPaste: this._paste.bind(this),
            onCopy: this._copy.bind(this),
            onClear: this._clear.bind(this),
            onIncognitoChanged: enabled => {
                this._settings.set_boolean('incognito', enabled);
                log(`clipper: incognito ${enabled ? 'ON' : 'OFF'}`);
                this._refreshDialog();
            },
            onOpenFolder: this._openFolder.bind(this),
        });

        Main.wm.addKeybinding(
            'clipper-toggle', this._settings,
            Meta.KeyBindingFlags.IGNORE_AUTOREPEAT,
            Shell.ActionMode.ALL,
            () => this._dialog.toggle());

        this._settingsBind();
        log('clipper: extension enabled');
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
        ];
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
        this._dialog.close();
        // let the shell hand focus back to the previous window first
        GLib.timeout_add(GLib.PRIORITY_DEFAULT, 90, () => {
            this._capture.claimAndPaste(item).catch(
                e => log(`clipper: paste failed: ${e}`));
            return GLib.SOURCE_REMOVE;
        });
    }

    async _copy(item) {
        try {
            await this._capture.claim(item);
            log('clipper: item copied to clipboard (popup stays open)');
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
            const path = item.kind === KIND_IMAGE
                ? item.content : uriFilePath(item.content.split('\n')[0]);
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
