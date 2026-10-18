/* Clipper history storage (JSON + image cache).
 *
 * Layout under ~/.local/share/Clipper/:
 *   history.json          {version, items: [...] }
 *   images/<md5>.<ext>    image payloads written by the capture path
 */
import GLib from 'gi://GLib';
import Gio from 'gi://Gio';

export const KIND_TEXT = 'text';
export const KIND_IMAGE = 'image';
export const KIND_FILES = 'files';

const SCHEMA_VERSION = 1;

function dataDir() {
    const base = GLib.get_user_data_dir();
    return Gio.File.new_for_path(GLib.build_filenamev([base, 'Clipper']));
}

function histFile() {
    return Gio.File.new_for_path(
        GLib.build_filenamev([GLib.get_user_data_dir(), 'Clipper', 'history.json']));
}

export class ClipperHistory {
    constructor() {
        this._items = [];      // newest first
        this._nextSeq = 1;
        this._load();
    }

    dir() {
        dataDir().make_directory_with_parents(null);
        return dataDir();
    }

    imagesDir() {
        const dir = Gio.File.new_for_path(
            GLib.build_filenamev([GLib.get_user_data_dir(), 'Clipper', 'images']));
        dir.make_directory_with_parents(null);
        return dir;
    }

    /* ------------------------------------------------------------ loading */
    _load() {
        try {
            const [ok, contents] = histFile().load_contents(null);
            if (!ok)
                return;
            const decoder = new TextDecoder();
            const state = JSON.parse(decoder.decode(contents));
            this._items = (state.items ?? []).filter(Boolean);
            let maxSeq = 0;
            for (const item of this._items) {
                const parsed = Number(String(item.id ?? '').replace(/\D+.*$/, ''));
                if (parsed > maxSeq)
                    maxSeq = parsed;
            }
            this._nextSeq = maxSeq + 1;
        } catch {
            this._items = [];
        }
    }

    save() {
        try {
            const payload = JSON.stringify(
                {version: SCHEMA_VERSION, items: this._items});
            histFile().replace_contents(
                payload, null, false, Gio.FileCreateFlags.REPLACE_DESTINATION, null);
        } catch (e) {
            log(`clipper: saving history failed: ${e}`);
        }
    }

    /* ------------------------------------------------------------- mutate */
    add(kind, content, {hash = null, size = 0, meta = {}} = {}) {
        const key = `${kind}|${content}`;
        let existing = this._items.find(item =>
            item._key === key || (item.kind === kind && item.content === content));
        const now = Date.now();

        if (existing) {
            existing.count = (existing.count ?? 1) + 1;
            existing.date = now;
            const bumped = existing;
            const rest = this._items.filter(i => i !== existing);
            this._items = [bumped, ...rest];
            this.save();
            return {item: bumped, created: false};
        }

        const item = {
            id: `c${this._nextSeq++}-${now}`,
            kind,
            content,
            hash,
            size,
            meta,
            count: 1,
            pinned: false,
            date: now,
        };
        item._key = key;
        this._items = [item, ...this._items];
        this.save();
        return {item, created: true};
    }

    get(id) {
        return this._items.find(item => item.id === id) ?? null;
    }

    remove(id) {
        const item = this.get(id);
        if (!item)
            return null;
        // delete image payload for items we own in the image cache
        if (item.kind === KIND_IMAGE && item.content) {
            const imagesPath = this.imagesDir();
            const file = Gio.File.new_for_path(item.content);
            const dirPath = imagesPath.get_path();
            const filePath = file.get_path();
            if (filePath && dirPath && filePath.startsWith(dirPath)) {
                try {
                    file.delete(null);
                } catch { /* vanished already */ }
            }
        }
        this._items = this._items.filter(i => i.id !== id);
        this.save();
        return item;
    }

    togglePin(id) {
        const item = this.get(id);
        if (!item)
            return null;
        item.pinned = !item.pinned;
        if (item.pinned)
            item.date = Date.now(); // bounce pinned item to top of pinned group
        this.save();
        return item;
    }

    clear(keepPinned = true) {
        const doomed = this._items.filter(item => !item.pinned || !keepPinned);
        for (const item of doomed)
            this.remove(item.id);
        this.save();
        return doomed.length;
    }

    setLimit(limit) {
        let unpinned = this._items.filter(item => !item.pinned);
        while (unpinned.length > limit) {
            // oldest unpinned is at the tail of the newest-first array
            const victim = unpinned[unpinned.length - 1];
            unpinned = unpinned.slice(0, -1);
            this.remove(victim.id);
        }
    }

    /* ------------------------------------------------------------- query */
    search(text = '') {
        const needle = text?.trim().toLowerCase();
        let result;
        if (!needle) {
            result = [...this._items];
        } else {
            result = this._items.filter(item => {
                if (item.kind === KIND_TEXT)
                    return item.content.toLowerCase().includes(needle);
                if (item.kind === KIND_FILES)
                    return item.content.toLowerCase().includes(needle);
                const n = item.meta?.name ?? '';
                return (n.toLowerCase() + ' ' + (item.meta?.hint ?? '').toLowerCase())
                    .includes(needle);
            });
        }
        // pinned on top, then recency
        return result.slice().sort((a, b) =>
            (Number(b.pinned ?? 0) - Number(a.pinned ?? 0)) ||
            (b.date - a.date));
    }

    all() {
        return this._items;
    }

    count() {
        return this._items.length;
    }
}

export function md5(bytes) {
    const checksum = new GLib.Checksum(GLib.ChecksumType.MD5);
    checksum.update(bytes.toArray ? bytes.toArray() : bytes);
    return checksum.get_string() ?? '';
}

export function makeDir(dir) {
    dir.make_directory_with_parents(null);
    return dir;
}
