/* Clipboard capture, claim and Windows-style paste injection.
 *
 * Captures clipboard changes directly from Mutter's selection model
 * (Meta.Selection) — event-driven, no polling. Claims clipboard content for
 * pasting items back out (text via St.Clipboard; images/files via
 * Meta.SelectionSourceMemory) and injects Ctrl+V through a virtual keyboard
 * device so Enter in the dialog behaves like Windows Win+V.
 */
import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import Meta from 'gi://Meta';
import St from 'gi://St';

import {KIND_FILES, KIND_IMAGE, KIND_TEXT, md5} from './storage.js';

const IMAGE_MIMES = ['image/png', 'image/jpeg'];
const FILES_MIMES = ['x-special/gnome-copied-files', 'text/uri-list'];
const TEXT_MIMES = ['text/plain;charset=utf-8', 'text/plain'];

const TEXT_LIMIT = 1 * 1024 * 1024;
const IMAGE_LIMIT = 48 * 1024 * 1024;
const FILELIST_LIMIT = 512 * 1024;

// enough install state to avoid re-capturing our own paste claim
const SELF_CLAIM_GRACE_MS = 1200;

export class CaptureManager {
    constructor(history, settings) {
        this._history = history;
        this._settings = settings;
        this._selection = null;
        this._selHandler = 0;
        this._sendingPaste = false;
        this._stopped = true;
    }

    start(callbacks) {
        this._onCaptured = callbacks?.onCaptured ?? null;
        this._stopped = false;
        this._selection = global.display.get_selection();
        this._selHandler = this._selection.connect(
            'owner-changed', this._onOwnerChanged.bind(this));
    }

    stop() {
        this._stopped = true;
        if (this._selHandler && this._selection) {
            this._selection.disconnect(this._selHandler);
            this._selHandler = 0;
        }
        this._selection = null;
        this._onCaptured = null;
    }

    _onOwnerChanged(_selection, type, source) {
        if (this._stopped ||
            type !== Meta.SelectionType.SELECTION_CLIPBOARD ||
            source === null)
            return;
        // settle briefly so the new owner finished advertising its content
        GLib.timeout_add(GLib.PRIORITY_DEFAULT, 25, () => {
            this._capture(source).catch(e => log(`clipper: capture error: ${e}`));
            return GLib.SOURCE_REMOVE;
        });
    }

    async _capture(source) {
        if (Date.now() - this._lastPastedAt < SELF_CLAIM_GRACE_MS)
            return; // our own auto-paste claim echoing back
        if (this._settings?.get_boolean('incognito'))
            return;

        const captures = [
            {name: KIND_IMAGE, mimes: IMAGE_MIMES, limit: IMAGE_LIMIT},
            {name: KIND_FILES, mimes: FILES_MIMES, limit: FILELIST_LIMIT},
            {name: KIND_TEXT,  mimes: TEXT_MIMES,  limit: TEXT_LIMIT},
        ];

        for (const capture of captures) {
            for (const mime of capture.mimes) {
                const bytes = await this._readMime(source, mime, capture.limit);
                if (!bytes || bytes.get_size() === 0)
                    continue;
                let item = null;
                if (capture.name === KIND_IMAGE) {
                    item = await this._storeImage(mime, bytes);
                } else if (capture.name === KIND_FILES) {
                    item = this._storeFileList(bytes.toString(), mime);
                } else {
                    const text = bytes.toString();
                    if (text.length > 0)
                        item = this._history.add(KIND_TEXT, text, {
                            size: text.length * 2,
                        }).item;
                }
                if (item) {
                    this._onCaptured?.(item);
                    return; // first matching priority wins
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
                        resolve(null); // mime type simply not offered
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

    async _storeImage(mime, bytes) {
        try {
            const digest = md5(bytes);
            if (!digest)
                return null;
            const ext = mime === 'image/png' ? 'png' : 'jpg';
            const imagesDir = this._history.imagesDir();
            const path = GLib.build_filenamev([
                imagesDir.get_path(), `${digest}.${ext}`]);
            const file = Gio.File.new_for_path(path);
            const size = bytes.get_size();
            await this._writeAsync(file, bytes);
            return this._history.add(KIND_IMAGE, path, {
                hash: digest,
                size,
                meta: {name: `${digest}.${ext}`, hint: `image ${mime}`},
            }).item;
        } catch (e) {
            log(`clipper: image capture failed: ${e}`);
            return null;
        }
    }

    async _writeAsync(file, bytes) {
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
    }

    _storeFileList(blob, mime) {
        let uris;
        if (mime === 'x-special/gnome-copied-files') {
            const lines = blob.split('\n');
            if (lines.length < 2)
                return null; // operation-only, no files behind it
            uris = lines.slice(1);
        } else {
            uris = blob.split(/\r?\n/);
        }
        uris = uris.filter(u => u.trim().length > 0);
        if (uris.length === 0)
            return null;
        const content = uris.join('\n');
        return this._history.add(KIND_FILES, content, {
            size: 0,
            meta: {name: uriFilePath(uris[0]).split('/').pop() || uris[0],
                   hint: uris.length > 1 ? `${uris.length} files` : 'file'},
        }).item;
    }

    /* ------------------------------------------------ claim and re-paste */
    async claimAndPaste(item) {
        const success = await this.claim(item);
        if (!success) {
            log(`clipper: could not claim clipboard for ${item.kind}`);
            return false;
        }
        this._lastPastedAt = Date.now();
        await new Promise(resolve => GLib.timeout_add(
            GLib.PRIORITY_DEFAULT, 120, () => (resolve(), GLib.SOURCE_REMOVE)));
        this._injectCtrlV();
        return true;
    }

    async claim(item) {
        // any claim we make echoes back as an owner-changed event: mark the
        // grace window so we don't capture our own content again
        this._lastPastedAt = Date.now();
        try {
            if (item.kind === KIND_TEXT) {
                St.Clipboard.get_default().set_content(
                    St.ClipboardType.CLIPBOARD, item.content);
                return true;
            }
            if (item.kind === KIND_IMAGE) {
                const [, bytes] = Gio.File.new_for_path(
                    item.content).load_contents(null);
                const source = new Meta.SelectionSourceMemory('image/png', bytes);
                global.display.get_selection().set_selection(
                    Meta.SelectionType.SELECTION_CLIPBOARD, source);
                return true;
            }
            if (item.kind === KIND_FILES) {
                const uris = item.content.split('\n').filter(Boolean);
                const blob = new GLib.Bytes(['copy', ...uris].join('\n'));
                const source = new Meta.SelectionSourceMemory(
                    'x-special/gnome-copied-files', blob);
                global.display.get_selection().set_selection(
                    Meta.SelectionType.SELECTION_CLIPBOARD, source);
                return true;
            }
        } catch (e) {
            log(`clipper: clipboard claim failed: ${e}`);
        }
        return false;
    }

    _injectCtrlV() {
        try {
            const seat = Clutter.get_default_backend().get_default_seat();
            const device = seat.create_virtual_device(
                Clutter.InputDeviceType.KEYBOARD_DEVICE);
            const KEY_CTRL = 65507; // Clutter.KEY_Control_L
            const KEY_V = 118;      // Clutter.KEY_v
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
    }
}

function uriFilePath(uri) {
    try {
        return GLib.uri_parse(uri, GLib.UriFlags.NONE).get_path() ?? uri;
    } catch {
        return uri;
    }
}
