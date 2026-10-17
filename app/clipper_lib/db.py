"""SQLite-backed clipboard history store for Clipper.

Layout on disk::

    ~/.local/share/Clipper/clipper.db      (catalog)
    ~/.local/share/Clipper/images/<md5>    (image payloads — written by the
                                            GNOME Shell bridge before capture)

Ordering semantics (Windows-clipboard style):
    pinned items always come first (most recently used pin first),
    then unpinned items by last copy time descending.
"""
from __future__ import annotations

import hashlib
import os
import sqlite3
import time
from dataclasses import dataclass
from pathlib import Path

# ---------------------------------------------------------------- item kinds
KIND_TEXT = "text"
KIND_LINK = "link"
KIND_COLOR = "color"
KIND_IMAGE = "image"
KIND_FILES = "files"

VALID_KINDS = {KIND_TEXT, KIND_LINK, KIND_COLOR, KIND_IMAGE, KIND_FILES}

DATA_DIR = Path.home() / ".local" / "share" / "Clipper"
IMAGES_DIR = DATA_DIR / "images"
DB_PATH = DATA_DIR / "clipper.db"


@dataclass
class Item:
    id: int
    kind: str
    content: str          # text | url | hex | image file path | '\\n'.join(uris)
    hash: str             # dedup key
    size: int             # bytes (payload size; text = char count)
    count: int            # how many times copied
    pinned: bool
    created_at: float
    last_used: float


def content_hash(kind: str, content: str) -> str:
    """Stable dedup key for a clipboard entry."""
    return hashlib.md5(f"{kind}|{content}".encode()).hexdigest()


def classify_text(text: str) -> str:
    """Classify plain text into text / link / color."""
    stripped = text.strip()
    if not stripped:
        return KIND_TEXT
    if len(stripped) <= 256 and " " not in stripped:
        if stripped.startswith(("#", "0x")):
            hexish = stripped[2:] if stripped.startswith("0x") else stripped[1:]
            hexish = hexish.rstrip()
            if len(hexish) in (3, 4, 6, 8) and all(
                c in "0123456789abcdefABCDEF" for c in hexish
            ):
                return KIND_COLOR
        if stripped.lower().startswith(("rgb(", "rgba(", "hsl(")) and stripped.endswith(")"):
            return KIND_COLOR
    if len(stripped) < 2000 and "\n" not in stripped and " " not in stripped:
        lowered = stripped.lower()
        if "://" in stripped or lowered.startswith(("www.", "mailto:", "ftp.")):
            return KIND_LINK
    return KIND_TEXT


class Store:
    """The clipboard history database.  Owned by one process (the daemon)."""

    def __init__(self, db_path: Path = DB_PATH, images_dir: Path = IMAGES_DIR):
        self.db_path = Path(db_path)
        self.images_dir = Path(images_dir)
        self.db_path.parent.mkdir(parents=True, exist_ok=True)
        self.images_dir.mkdir(parents=True, exist_ok=True)
        self._conn = sqlite3.connect(str(self.db_path))
        self._conn.row_factory = sqlite3.Row
        self._conn.execute("PRAGMA journal_mode=WAL")
        self._create_schema()

    # ------------------------------------------------------------- internals
    def _create_schema(self) -> None:
        with self._conn:
            self._conn.execute(
                """
                CREATE TABLE IF NOT EXISTS items (
                    id         INTEGER PRIMARY KEY,
                    kind       TEXT    NOT NULL,
                    content    TEXT    NOT NULL,
                    hash       TEXT    NOT NULL,
                    size       INTEGER NOT NULL DEFAULT 0,
                    count      INTEGER NOT NULL DEFAULT 1,
                    pinned     INTEGER NOT NULL DEFAULT 0,
                    created_at REAL    NOT NULL,
                    last_used  REAL    NOT NULL
                )
                """
            )
            self._conn.execute("CREATE UNIQUE INDEX IF NOT EXISTS idx_hash ON items(hash)")
            self._conn.execute(
                "CREATE INDEX IF NOT EXISTS idx_order ON items(pinned DESC, last_used DESC)"
            )

    @staticmethod
    def _row_to_item(row) -> Item:
        return Item(
            id=row["id"],
            kind=row["kind"],
            content=row["content"],
            hash=row["hash"],
            size=row["size"],
            count=row["count"],
            pinned=bool(row["pinned"]),
            created_at=row["created_at"],
            last_used=row["last_used"],
        )

    def _insert(self, kind: str, content: str, hsh: str, size: int) -> Item:
        now = time.time()
        with self._conn:
            cur = self._conn.execute(
                "INSERT INTO items (kind, content, hash, size, count, pinned,"
                " created_at, last_used)"
                " VALUES (?, ?, ?, ?, 1, 0, ?, ?)",
                (kind, content, hsh, size, now, now),
            )
        return Item(
            id=cur.lastrowid, kind=kind, content=content, hash=hsh, size=size,
            count=1, pinned=False, created_at=now, last_used=now,
        )

    # ------------------------------------------------------------- capture
    def capture(
        self, kind: str, content: str, hsh: str | None = None, size: int | None = None
    ) -> tuple[Item, bool]:
        """Insert or bump an entry.  Returns (item, inserted_new)."""
        if kind not in VALID_KINDS:
            raise ValueError(f"unknown kind {kind!r}")
        hsh = hsh or content_hash(kind, content)
        if size is None:
            size = len(content)
        try:
            return self._insert(kind, content, hsh, size), True
        except sqlite3.IntegrityError:
            # already known — bump it to the top like Windows does
            now = time.time()
            with self._conn:
                self._conn.execute(
                    "UPDATE items SET last_used = ?, count = count + 1,"
                    " size = ? WHERE hash = ?",
                    (now, size, hsh),
                )
            row = self._conn.execute(
                "SELECT * FROM items WHERE hash = ?", (hsh,)
            ).fetchone()
            if row is None:  # extremely unlikely race
                return self._insert(kind, content, hsh, size), True
            return self._row_to_item(row), False

    # ------------------------------------------------------------- mutation
    def toggle_pin(self, item_id: int) -> Item | None:
        row = self._get_row(item_id)
        if row is None:
            return None
        new_val = 0 if row["pinned"] else 1
        with self._conn:
            self._conn.execute(
                "UPDATE items SET pinned = ?, last_used = ? WHERE id = ?",
                (new_val, row["last_used"], item_id),
            )
        return self._row_to_item(self._get_row(item_id))

    def set_pinned(self, item_id: int, pinned: bool) -> Item | None:
        if self._get_row(item_id) is None:
            return None
        with self._conn:
            self._conn.execute(
                "UPDATE items SET pinned = ? WHERE id = ?", (1 if pinned else 0, item_id)
            )
        return self._row_to_item(self._get_row(item_id))

    def delete(self, item_id: int) -> bool:
        row = self._get_row(item_id)
        if row is None:
            return False
        with self._conn:
            self._conn.execute("DELETE FROM items WHERE id = ?", (item_id,))
        if row["kind"] == KIND_IMAGE:
            p = Path(row["content"])
            # only ever remove files we own in the image stash
            if p.is_file() and self.images_dir in p.parents:
                try:
                    p.unlink()
                except OSError:
                    pass
        return True

    def _prune_orphan_images(self) -> None:
        if not self.images_dir.is_dir():
            return
        referenced = {
            Path(r["content"]).resolve()
            for r in self._conn.execute(
                "SELECT content FROM items WHERE kind = ?", (KIND_IMAGE,)
            )
        }
        for img in self.images_dir.iterdir():
            if img.is_file() and img.resolve() not in referenced:
                try:
                    img.unlink()
                except OSError:
                    pass

    def clear(self, keep_pinned: bool = True) -> int:
        """Remove (non-pinned) history.  Returns rows removed."""
        cond = "WHERE pinned = 0" if keep_pinned else ""
        rows = self._conn.execute(
            f"SELECT id, content FROM items {cond}"
        ).fetchall()
        with self._conn:
            self._conn.execute(f"DELETE FROM items {cond}")
        self._prune_orphan_images()
        return len(rows)

    def trim(self, limit: int) -> None:
        """Keep at most `limit` unpinned items (oldest last_used removed)."""
        with self._conn:
            self._conn.execute(
                """
                DELETE FROM items WHERE pinned = 0 AND id IN (
                    SELECT id FROM items WHERE pinned = 0
                    ORDER BY last_used DESC LIMIT -1 OFFSET ?
                )
                """,
                (max(0, limit),),
            )

    # ------------------------------------------------------------- queries
    def _get_row(self, item_id: int):
        return self._conn.execute(
            "SELECT * FROM items WHERE id = ?", (item_id,)
        ).fetchone()

    def get(self, item_id: int) -> Item | None:
        row = self._get_row(item_id)
        return self._row_to_item(row) if row else None

    def query(self, search: str = "", limit: int = 500) -> list[Item]:
        sql = "SELECT * FROM items"
        args: list = []
        if search:
            sql += " WHERE content LIKE ?"
            args.append(f"%{search.strip()}%")
        sql += " ORDER BY pinned DESC, last_used DESC LIMIT ?"
        args.append(max(1, limit))
        return [
            self._row_to_item(r) for r in self._conn.execute(sql, args).fetchall()
        ]

    def counts(self) -> dict:
        row = self._conn.execute(
            "SELECT COUNT(*) AS total, SUM(pinned) AS pinned FROM items"
        ).fetchone()
        return {"total": row["total"] or 0, "pinned": row["pinned"] or 0}

    def close(self) -> None:
        self._conn.close()
