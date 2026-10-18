/* Clipboard capture, claim and Windows-style paste injection.
 *
 * Captures clipboard changes directly from Mutter's selection model
 * (Meta.Selection) — event-driven, no polling.  The payload of every
 * advertised mime is streamed out of the selection source, decoded with
 * TextDecoder (GLib.Bytes has no useful toString), classified, de-duplicated
 * by checksum and stored through ClipperHistory.
 *
 * Items are put back on the clipboard with St.Clipboard so Enter in the
 * dialog behaves like the Windows Win+V panel: claim + injected Ctrl+V.
 */
import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import Meta from 'gi://Meta';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import {KIND_FILES, KIND_IMAGE, KIND_TEXT, md5} from './storage.js';

/* Async entry points we want as promises.  Copyous and Pano use the same
 * helper; guarded so a missing symbol can never abort the whole extension. */
for (const [proto, name] of [
    [Meta.SelectionSource.prototype, 'read_async'],
    [Gio.MemoryOutputStream.prototype, 'splice_async'],
    [Gio.File.prototype, 'load_contents_async'],
    [Gio.File.prototype, 'replace_contents_async'],
]) {
    try {
        Gio._promisify(proto, name);
    } catch (e) {
        log(`clipper: Gio._promisify(${name}) failed: ${e}`);
    }
}

/* Order inside each group is the preference order.  The first mime the
 * clipboard actually advertises wins, so we never read a mime that is not
 * there (which would just raise inside read_async). */
const IMAGE_MIMES = ['image/png', 'image/jpeg', 'image/webp'];
const FILES_MIMES = ['x-special/gnome-copied-files', 'text/uri-list'];
const TEXT_MIMES = ['text/plain;charset=utf-8', 'UTF8_STRING', 'text/plain', 'STRING'];

/* Never record secrets: password managers set this on their clipboard offer. */
const SENSITIVE_MIMES = ['x-kde-passwordManagerHint'];

const decoder = new TextDecoder();
const encoder = new TextEncoder();

/* Claims we made ourselves echo back through owner-changed; ignore them. */
const SELF_CLAIM_GRACE_MS = 1200;

export class CaptureManager {
    constructor(history, settings) {
        this._history = history;
        this._settings = settings;
        this._selection = null;
        this._selHandler = 0;
        this._stopped = true;
        this._queue = Promise.resolve();
        this._prevClipboard = null;   // [kind, checksum]
        this._lastClaimAt = 0;
        this._device = null;
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
        this._onCaptured = null;
        if (this._selHandler && this._selection) {
            this._selection.disconnect(this._selHandler);
            this._selHandler = 0;
        }
        this._selection = null;
        this._device = null;
    }

    /* ---------------------------------------------------------- capturing */
    _onOwnerChanged(_selection, type, source) {
        if (this._stopped || !source ||
            type !== Meta.SelectionType.SELECTION_CLIPBOARD)
            return;
        if (Date.now() - this._lastClaimAt < SELF_CLAIM_GRACE_MS) {
            log('clipper: capture skipped (own claim echo)');
            return;
        }
        // give the new owner a moment to finish advertising its content, then
        // serialise captures so two near-simultaneous owner changes cannot
        // interleave their de-duplication checks
        GLib.timeout_add(GLib.PRIORITY_DEFAULT, 30, () => {
            this._queue = this._queue
                .then(() => this._capture(source))
                .catch(e => log(`clipper: capture error: ${e}`));
            return GLib.SOURCE_REMOVE;
        });
    }

    async _capture(source) {
        if (this._stopped)
            return;

        let mimes = [];
        try {
            mimes = source.get_mimetypes() ?? [];
        } catch (e) {
            log(`clipper: could not list clipboard formats: ${e}`);
            return;
        }
        if (mimes.some(m => SENSITIVE_MIMES.includes(m))) {
            log('clipper: capture skipped (sensitive content)');
            return;
        }

        const content = await this._read(source, mimes);
        if (!content) {
            log('clipper: nothing captured (no usable format)');
            return;
        }

        // Remember what we just saw even in incognito, so leaving incognito
        // does not immediately store the pre-incognito clipboard.
        const prev = this._prevClipboard;
        this._prevClipboard = [content.kind, content.checksum];
        if (prev && prev[0] === content.kind && prev[1] === content.checksum)
            return; // same content again (mutter fires twice per copy)

        if (this._settings?.get_boolean('incognito')) {
            log('clipper: capture skipped (incognito is on)');
            return;
        }

        const item = await this._commit(content);
        if (item)
            this._onCaptured?.(item);
    }

    /* Reads the best available representation of the clipboard payload. */
    async _read(source, mimes) {
        const imageMime = IMAGE_MIMES.find(m => mimes.includes(m));
        if (imageMime) {
            const data = await this._readBytes(source, imageMime);
            if (!data || data.length === 0)
                return null;
            const checksum = md5(data);
            if (!checksum)
                return null;
            return {kind: KIND_IMAGE, mimetype: imageMime, data, checksum};
        }

        const filesMime = FILES_MIMES.find(m => mimes.includes(m));
        if (filesMime) {
            const text = decoder.decode(
                await this._readBytes(source, filesMime)).trim();
            const lines = text.split('\n').map(l => l.trim()).filter(Boolean);
            if (lines.length === 0)
                return null;
            const operation = lines[0].toLowerCase();
            const paths = (operation === 'copy' || operation === 'cut')
                ? lines.slice(1) : lines;
            if (paths.length === 0)
                return null;
            return {
                kind: KIND_FILES,
                paths,
                operation: operation === 'cut' ? 'cut' : 'copy',
                checksum: checksumOfString(paths.join('\n')),
            };
        }

        const textMime = TEXT_MIMES.find(m => mimes.includes(m));
        if (textMime) {
            const text = decoder.decode(await this._readBytes(source, textMime));
            if (!text || !text.trim())
                return null;
            return {kind: KIND_TEXT, text, checksum: checksumOfString(text)};
        }

        return null;
    }

    async _readBytes(source, mime) {
        const stream = await source.read_async(mime, null);
        const out = Gio.MemoryOutputStream.new_resizable();
        await out.splice_async(
            stream,
            Gio.OutputStreamSpliceFlags.CLOSE_SOURCE |
            Gio.OutputStreamSpliceFlags.CLOSE_TARGET,
            GLib.PRIORITY_DEFAULT, null);
        return out.steal_as_bytes().toArray();
    }

    async _commit(content) {
        if (content.kind === KIND_IMAGE)
            return this._commitImage(content);
        if (content.kind === KIND_FILES)
            return this._commitFiles(content);

        const item = this._history.add(KIND_TEXT, content.text, {
            hash: content.checksum,
            size: content.text.length * 2,
        }).item;
        log(`clipper: captured text (${content.text.length} chars)`);
        return item;
    }

    async _commitImage(content) {
        const ext = content.mimetype === 'image/webp' ? 'webp'
            : content.mimetype === 'image/jpeg' ? 'jpg' : 'png';
        const dir = this._history.imagesDir();
        const path = GLib.build_filenamev(
            [dir.get_path(), `${content.checksum}.${ext}`]);
        const file = Gio.File.new_for_path(path);
        try {
            if (!file.query_exists(null)) {
                await file.replace_contents_async(content.data, null, false,
                    Gio.FileCreateFlags.REPLACE_DESTINATION, null);
            }
        } catch (e) {
            log(`clipper: writing image failed: ${e}`);
            return null;
        }
        const item = this._history.add(KIND_IMAGE, path, {
            hash: content.checksum,
            size: content.data.length,
            meta: {name: `${content.checksum}.${ext}`,
                   hint: `image · ${content.mimetype}`},
        }).item;
        log(`clipper: captured image (${humanBytes(content.data.length)})`);
        return item;
    }

    _commitFiles(content) {
        const list = content.paths.join('\n');
        const first = uriFilePath(content.paths[0]);
        const item = this._history.add(KIND_FILES, list, {
            hash: content.checksum,
            size: 0,
            meta: {
                name: GLib.basename(first) || first,
                hint: content.paths.length > 1
                    ? `${content.paths.length} files` : 'file',
                operation: content.operation,
            },
        }).item;
        log(`clipper: captured ${content.paths.length} file(s) ` +
            `(${content.operation})`);
        return item;
    }

    /* ------------------------------------------------ claim and re-paste */
    async claim(item) {
        // any claim we make echoes back as an owner-changed event
        this._lastClaimAt = Date.now();
        try {
            const clipboard = St.Clipboard.get_default();
            if (item.kind === KIND_TEXT) {
                clipboard.set_text(St.ClipboardType.CLIPBOARD, item.content);
                return true;
            }
            if (item.kind === KIND_IMAGE) {
                const file = Gio.File.new_for_path(item.content);
                // promisified load_contents_async resolves to [contents, etag]
                const [contents] = await file.load_contents_async(null);
                if (!contents || contents.length === 0)
                    return false;
                const [guessed] = Gio.content_type_guess(
                    file.get_path(), contents);
                const mimetype =
                    Gio.content_type_get_mime_type(guessed) ?? 'image/png';
                clipboard.set_content(St.ClipboardType.CLIPBOARD, mimetype,
                    new GLib.Bytes(contents));
                return true;
            }
            if (item.kind === KIND_FILES) {
                const uris = item.content.split('\n').filter(Boolean);
                const blob = encoder.encode(`copy\n${uris.join('\n')}`);
                clipboard.set_content(St.ClipboardType.CLIPBOARD,
                    'x-special/gnome-copied-files', new GLib.Bytes(blob));
                return true;
            }
        } catch (e) {
            log(`clipper: clipboard claim failed: ${e}`);
        }
        return false;
    }

    /* Windows-style: put the item back on the clipboard and type paste into
     * whatever window has focus (only when auto-paste is enabled). */
    async pasteItem(item) {
        const claimed = await this.claim(item);
        if (!claimed) {
            log(`clipper: could not claim clipboard for ${item.kind}`);
            return false;
        }
        if (!this._settings?.get_boolean('auto-paste'))
            return true;
        await new Promise(resolve => GLib.timeout_add(
            GLib.PRIORITY_DEFAULT, 250, () => (resolve(), GLib.SOURCE_REMOVE)));
        this._injectPaste();
        return true;
    }

    _injectPaste() {
        try {
            const backend = Clutter.get_default_backend?.() ??
                global.stage.get_context().get_backend();
            const seat = backend.get_default_seat();
            this._device ??= seat.create_virtual_device(
                Clutter.InputDeviceType.KEYBOARD_DEVICE);
            const device = this._device;

            // Ctrl+V is what every GUI toolkit expects; terminals need
            // Ctrl+Shift+Insert.  notify_keyval wants microseconds.
            const terminal = Main.inputMethod?.content_purpose ===
                Clutter.InputContentPurpose.TERMINAL;
            const keys = terminal
                ? [Clutter.KEY_Control_L, Clutter.KEY_Shift_L,
                   Clutter.KEY_Insert]
                : [Clutter.KEY_Control_L, Clutter.KEY_v];

            for (const key of keys)
                device.notify_keyval(Clutter.get_current_event_time() * 1000,
                    key, Clutter.KeyState.PRESSED);
            for (const key of keys.slice().reverse())
                device.notify_keyval(Clutter.get_current_event_time() * 1000,
                    key, Clutter.KeyState.RELEASED);
        } catch (e) {
            log(`clipper: paste injection failed: ${e}`);
        }
    }
}

/* ---------------------------------------------------------------- helpers */
function checksumOfString(text) {
    return GLib.compute_checksum_for_string(
        GLib.ChecksumType.MD5, text, -1) ?? '';
}

function uriFilePath(uri) {
    try {
        return GLib.uri_parse(uri, GLib.UriFlags.NONE).get_path() ?? uri;
    } catch {
        return uri;
    }
}

function humanBytes(bytes) {
    if (bytes < 1024)
        return `${bytes} B`;
    if (bytes < 1024 * 1024)
        return `${(bytes / 1024).toFixed(1)} kB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
