#!/usr/bin/env bash
# Clipper health check. Read-only: changes nothing, just reports what the
# running session looks like. Run it when the popup misbehaves and paste the
# output into an issue.
set -u

UUID=clipper@mohrezsheikh
SCHEMA=io.github.mohrezsheikh.clipper
DATA="${XDG_DATA_HOME:-$HOME/.local/share}/Clipper"

row() { printf '%-24s %s\n' "$1" "$2"; }
journal() { journalctl --user -b --no-pager 2>/dev/null; }

echo "Clipper health check  ($(date '+%Y-%m-%d %H:%M'))"
echo "-----------------------------------------------------------"

# --- installed & enabled -------------------------------------------------
found=""
for dir in "$HOME/.local/share/gnome-shell/extensions/$UUID" \
           "/usr/share/gnome-shell/extensions/$UUID"; do
    [ -d "$dir" ] && found="$found $dir"
done
row "extension files:" "${found:-NOT INSTALLED (see README)}"

manifest="${found%% *}"
if [ -n "$manifest" ] && [ -f "$manifest/extension.js" ]; then
    row "source build:" "$(grep -o 'build [0-9.]*' "$manifest/extension.js" | head -1 || echo unknown)"
fi

state="$(gnome-extensions info "$UUID" 2>&1 | tr '\n' ' ' | sed 's/  */ /g')"
row "shell state:" "${state:-gnome-extensions unavailable}"

# --- the three things that must all be true for the hotkey to work --------
if gsettings list-schemas 2>/dev/null | grep -qx "$SCHEMA"; then
    row "settings schema:" "installed"
    row "hotkey:" "$(gsettings get "$SCHEMA" clipper-toggle 2>&1)"
    row "auto-paste:" "$(gsettings get "$SCHEMA" auto-paste 2>&1)"
else
    row "settings schema:" "MISSING - enable() will fail, reinstall the package"
fi

# --- what the shell actually loaded in this boot -------------------------
loaded="$(journal | grep -o 'clipper: extension enabled (build [^)]*)' | tail -1)"
row "loaded in session:" "${loaded:-not logged in this boot - LOG OUT AND BACK IN}"
mods="$(journal | grep -o 'clipper: extension enabled' | wc -l)"
row "enable() calls:" "$mods"

errors="$(journal | grep 'clipper:' | grep -iE 'failed|error|warning' | tail -4)"
if [ -n "$errors" ]; then
    echo "-- recent clipper errors ----------------------------------"
    echo "$errors"
fi

# --- captured data ------------------------------------------------------
if [ -f "$DATA/history.json" ]; then
    row "history file:" "$DATA/history.json"
    python3 - "$DATA/history.json" <<'PY' 2>/dev/null || row "history items:" "unreadable"
import json, sys
try:
    items = [i for i in json.load(open(sys.argv[1])).get("items", []) if isinstance(i, dict)]
except Exception as exc:
    print(f"{'history items:':<24} cannot parse ({exc})")
    raise SystemExit(0)
kinds = {}
for i in items:
    kinds[i.get("kind", "?")] = kinds.get(i.get("kind", "?"), 0) + 1
pinned = sum(1 for i in items if i.get("pinned"))
print(f"{'history items:':<24} {len(items)}  {kinds}  pinned={pinned}")
PY
else
    row "history file:" "none yet (copy something, then reopen the popup)"
fi

if [ -d "$DATA/images" ]; then
    row "saved images:" "$(find "$DATA/images" -type f -name '*.png' 2>/dev/null | wc -l) png in $DATA/images"
else
    row "saved images:" "directory not created yet"
fi

# --- known troublemakers ------------------------------------------------
rivals="$(gnome-extensions list --enabled 2>/dev/null | grep -E 'clipboard|copyous')"
if [ -n "$rivals" ]; then
    echo "-- other clipboard managers are enabled -------------------"
    echo "$rivals" | sed 's/^/  /'
    echo "  They capture the same clipboard and (with Copyous) may also"
    echo "  bind Super+V. Disable them to avoid confusing double entries:"
    echo "    gnome-extensions disable <uuid>"
fi
