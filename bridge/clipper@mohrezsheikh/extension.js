/* Clipper Clipboard Bridge
 *
 * A deliberately small GNOME Shell extension with no UI of its own:
 *  1. watches Mutter's clipboard owner-changed events and forwards
 *     text / image / file-list captures to the Clipper app over DBus;
 *  2. registers the toggle keybinding (schema key `clipper-toggle`);
 *  3. exposes `io.github.mohrezsheikh.clipper.bridge.Paste()` which injects Ctrl+V
 *     into the previously focused window so Enter in the Clipper popup
 *     behaves like Windows' clipboard.
 *
 * Everything user-facing (history, settings) lives in the app.
 */
import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Meta from 'gi://Meta';
import Shell from 'gi://Shell';

import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

const APP_ID = 'io.github.mohrezsheikh.clipper';
const APP_PATH = '/io/github/mohrezsheikh/clipper';
const APP_IFACE = 'io.github.mohrezsheikh.clipper';
const BRIDGE_NAME = 'io.github.mohrezsheikh.clipper.bridge';

const IMAGE_MIMES = ['image/png', 'image/jpeg'];
const FILES_MIMES = ['x-special/gnome-copied-files', 'text/uri-list'];
const TEXT_MIMES = ['text/plain;charset=utf-8', 'text/plain'];

const TEXT_LIMIT = 2 * 1024 * 1024;      // don't forward gigantic text blobs
const IMAGE_LIMIT = 48 * 1024 * 1024;
const FILELIST_LIMIT = 512 * 1024;

const BRIDGE_XML = `
<node>
  <interface name="io.github.mohrezsheikh.clipper.bridge">
    <method name="Paste"/>
    <method name="Ping"><arg type="s" direction="out"/></method>
  </interface>
</node>`;

const KEY_CTRL = Clutter.KEY_Control_L !== undefined ? Clutter.KEY_Control_L : 65507;
const KEY_V = Clutter.KEY_v !== undefined ? Clutter.KEY_v : 118;

export default class ClipperBridge extends Extension {
    enable() {
        log('clipper: bridge enabled');
        this._selection = global.display.get_selection();
        this._selHandler = this._selection.connect(
            'owner-changed', this._onOwnerChanged.bind(this));

        this._settings = Gio.Settings.new(APP_ID);
        Main.wm.addKeybinding(
            'clipper-toggle', this._settings,
            Meta.KeyBindingFlags.IGNORE_AUTOREPEAT,
            Shell.ActionMode.ALL,
            () => this._appCall('Toggle', null));

        this._bridgeOwner = Gio.bus_own_name(
            Gio.BusType.SESSION, BRIDGE_NAME, Gio.BusNameOwnerFlags.NONE,
            bus => this._onBusAcquired(bus), null, null);
    }

    disable() {
        if (this._bridgeOwner !== undefined) {
            Gio.bus_unown_name(this._bridgeOwner);
            this._bridgeOwner = undefined;
        }
        if (this._selHandler !== undefined && this._selection) {
            this._selection.disconnect(this._selHandler);
            this._selHandler = undefined;
        }
        this._selection = null;
        this._settings = null;
        Main.wm.removeKeybinding('clipper-toggle');
        log('clipper: bridge disabled');
    }

    _onBusAcquired(bus) {
        const info = Gio.DBusNodeInfo.new_for_xml(BRIDGE_XML);
        try {
            bus.register_object(APP_PATH, info.interfaces[0], this._bridgeDispatch.bind(this));
        } catch (e) {
            log(`clipper: bridge object registration failed: ${e}`);
        }
    }

    _bridgeDispatch(_conn, _sender, _path, _iface, method, _params, invocation) {
        if (method === 'Paste') {
            this._paste();
            invocation.return_value(null);
            return;
        } else if (method === 'Ping') {
            invocation.return_value(new GLib.Variant('(s)', ['clipper-bridge']));
            return;
        }
        invocation.return_value(null);
    }

    /* ------------------------------------------------- clipboard watcher */
    _onOwnerChanged(_selection, type, source) {
        if (type !== Meta.SelectionType.SELECTION_CLIPBOARD || source === null)
            return;
        // settle briefly so the new owner finished advertising its content
        GLib.timeout_add(GLib.PRIORITY_DEFAULT, 25, () => {
            this._capture(source).catch(e => log(`clipper: capture error: ${e}`));
            return GLib.SOURCE_REMOVE;
        });
    }

    async _capture(source) {
        const kinds = [
            {name: 'image', mimes: IMAGE_MIMES, limit: IMAGE_LIMIT},
            {name: 'files', mimes: FILES_MIMES, limit: FILELIST_LIMIT},
            {name: 'text',  mimes: TEXT_MIMES,  limit: TEXT_LIMIT},
        ];
        for (const kind of kinds) {
            for (const mime of kind.mimes) {
                const bytes = await this._readMime(source, mime, kind.limit);
                if (bytes === null || bytes.get_size() === 0)
                    continue;
                if (kind.name === 'image') {
                    await this._forwardImage(mime, bytes);
                    return;
                } else if (kind.name === 'files') {
                    const blob = this._parseFileList(bytes.toString(), mime);
                    if (blob) {
                        this._appCall('CaptureFiles', GLib.Variant.new_string(blob));
                        return;
                    }
                    continue;
                } else {
                    const text = bytes.toString();
                    if (text.length === 0)
                        continue;
                    this._appCall('CaptureText', GLib.Variant.new_string(text));
                    return;
                }
            }
        }
    }

    _readMime(source, mime, limit) {
        return new Promise(resolve => {
            source.read_async([mime], GLib.PRIORITY_DEFAULT, null,
                (src, res) => {
                    let stream;
                    try {
                        stream = src.read_finish(res);
                    } catch {
                        resolve(null);  // mime type simply not offered
                        return;
                    }
                    this._readStreamChunks(stream, limit).then(resolve)
                        .catch(() => resolve(null));
                });
        });
    }

    async _readStreamChunks(stream, limit) {
        const chunks = [];
        let total = 0;
        while (total < limit) {
            const want = Math.min(1 << 20, limit - total);
            const chunk = await new Promise((resolve, reject) => {
                stream.read_bytes_async(want, GLib.PRIORITY_DEFAULT, null,
                    (s, res) => {
                        try {
                            resolve(s.read_bytes_finish(res));
                        } catch (e) {
                            reject(e);
                        }
                    });
            });
            if (!chunk || chunk.get_size() === 0)
                break;
            chunks.push(chunk);
            total += chunk.get_size();
        }
        if (chunks.length === 0)
            return null;
        return chunks.length === 1 ? chunks[0] : GLib.Bytes.concat(chunks);
    }

    async _forwardImage(mime, bytes) {
        try {
            const checksum = new GLib.Checksum(GLib.ChecksumType.MD5);
            checksum.update(bytes.toArray());
            const digest = checksum.get_string() ?? '';
            if (!digest)
                return;

            const ext = mime === 'image/png' ? 'png' : 'jpg';
            const dir = `${GLib.get_user_data_dir()}/Clipper/images`;
            GLib.mkdir_with_parents(dir, 0o755);
            const path = `${dir}/${digest}.${ext}`;

            const file = Gio.File.new_for_path(path);
            const out = file.replace(null, false,
                Gio.FileCreateFlags.REPLACE_DESTINATION, null);
            await new Promise((resolve, reject) => {
                out.write_bytes_async(bytes, GLib.PRIORITY_DEFAULT, null,
                    (o, res) => {
                        try {
                            o.write_bytes_finish(res);
                            resolve();
                        } catch (e) {
                            reject(e);
                        }
                    });
            });
            await new Promise(resolve => {
                out.close_async(GLib.PRIORITY_DEFAULT, null, (o, res) => {
                    try {
                        o.close_finish(res);
                    } catch { /* already closed */ }
                    resolve();
                });
            });

            this._appCall('CaptureImage', GLib.Variant.new_string(path));
        } catch (e) {
            log(`clipper: image capture failed: ${e}`);
        }
    }

    _parseFileList(blob, mime) {
        let uris;
        if (mime === 'x-special/gnome-copied-files') {
            const lines = blob.split('\n');
            if (lines.length < 2)
                return null;  // operation-only, no files behind it
            uris = lines.slice(1);
        } else {
            uris = blob.split(/\r?\n/);
        }
        uris = uris.filter(u => u.trim().length > 0);
        if (uris.length === 0)
            return null;
        return uris.join('\n');
    }

    /* ------------------------------------------------------ DBus helpers */
    _appCall(method, params) {
        Gio.DBus.session.call(APP_ID, APP_PATH, APP_IFACE, method, params,
            null, Gio.DBusCallFlags.NONE, -1, null,
            (bus, res) => {
                try {
                    bus.call_finish(res);
                } catch (e) {
                    // app not running (yet); the capture is lost this time
                    log(`clipper: app call ${method} failed: ${e}`);
                }
            });
    }

    /* --------------------------------------------- Windows-style paste */
    _paste() {
        // wait for the Clipper window to actually lose focus, then Ctrl+V
        GLib.timeout_add(GLib.PRIORITY_DEFAULT, 130, () => {
            try {
                const seat = Clutter.get_default_backend().get_default_seat();
                const device = seat.create_virtual_device(
                    Clutter.InputDeviceType.KEYBOARD_DEVICE);
                device.notify_key(Clutter.KeyEventType.KEY_PRESS, KEY_CTRL, 0, 0, 0);
                device.notify_key(Clutter.KeyEventType.KEY_PRESS, KEY_V, 0,
                    Clutter.ModifierType.CONTROL_MASK, 0);
                GLib.timeout_add(GLib.PRIORITY_DEFAULT, 40, () => {
                    device.notify_key(Clutter.KeyEventType.KEY_RELEASE, KEY_V, 0,
                        Clutter.ModifierType.CONTROL_MASK, 0);
                    device.notify_key(Clutter.KeyEventType.KEY_RELEASE, KEY_CTRL, 0, 0, 0);
                    return GLib.SOURCE_REMOVE;
                });
            } catch (e) {
                log(`clipper: paste injection failed: ${e}`);
            }
            return GLib.SOURCE_REMOVE;
        });
    }
}
