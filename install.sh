#!/usr/bin/env bash
# Clipper — GNOME Shell extension installer (no root needed).
#
#   ./install.sh         install into ~/.local and claim Win+V
set -euo pipefail

SRC="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
EXT_UUID="clipper@mohrezsheikh"
info() { printf '\033[1;34mclipper:\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33mclipper:\033[0m %s\n' "$*"; }

if ! command -v gnome-shell >/dev/null; then
  echo "gnome-shell is required (Clipper is a GNOME extension)." >&2
  exit 1
fi

# --------------------------------------------------- retire older pieces
# The legacy Python daemon (a previous experiment) is replaced fully by the
# extension; stop and remove it if it is still present.
systemctl --user disable --now clipper.service 2>/dev/null || true
rm -f "$HOME/.config/systemd/user/clipper.service" 2>/dev/null || true
systemctl --user daemon-reload 2>/dev/null || true
pkill -u "$USER" -f "$HOME/\.local/bin/clipper" 2>/dev/null || true
rm -f "$HOME/.local/bin/clipper" 2>/dev/null || true
rm -rf "$HOME/.local/share/clipper" "$HOME/.local/share/ClipperApp" 2>/dev/null || true

# ------------------------------------------------------- the extension
EXT_DIR="$HOME/.local/share/gnome-shell/extensions/$EXT_UUID"
info "installing GNOME Shell extension to $EXT_DIR"
mkdir -p "$(dirname "$EXT_DIR")"
rm -rf "$EXT_DIR"
cp -r "$SRC/bridge/$EXT_UUID" "$EXT_DIR"

# -------------------------------------------------------------- schemas
SCHEMA_DIR="$HOME/.local/share/glib-2.0/schemas"
info "compiling GSettings schema"
mkdir -p "$SCHEMA_DIR"
cp "$SRC/bridge/$EXT_UUID/io.github.mohrezsheikh.clipper.gschema.xml" "$SCHEMA_DIR/"
glib-compile-schemas "$SCHEMA_DIR"

# ----------------------------------------------------------- keybinding
# Default hotkey is Ctrl+Alt+V (conflict-free).  If a previous Clipper
# release moved Win+V out of the notification panel, restore the stock one:
info "setting Clipper toggle key (default Ctrl+Alt+V)"
gsettings reset io.github.mohrezsheikh.clipper clipper-toggle
if command -v gnome-extensions >/dev/null && \
   gnome-extensions info clipper@mohrezsheikh 2>/dev/null | grep -q "State: ACTIVE"; then
  gnome-extensions disable clipper@mohrezsheikh || true
fi

# ---------------------------------------------------- enable next session
enabled="$(gsettings get org.gnome.shell enabled-extensions 2>/dev/null || echo '[]')"
if ! echo "$enabled" | grep -qF "$EXT_UUID"; then
  new_enabled="$(python3 - "$enabled" "$EXT_UUID" <<'PY'
import ast, sys
try:
    current = ast.literal_eval(sys.argv[1]) if sys.argv[1] != '[]' else []
except Exception:
    current = []
uuid = sys.argv[2]
if uuid not in current:
    current.append(uuid)
items = ", ".join(f"'{u}'" for u in current)
print(f"[{items}]", end='')
PY
)"
  gsettings set org.gnome.shell enabled-extensions "$new_enabled" && info "will auto-enable at next login"
fi


# ------------------------------------------------------- rival manager
if command -v gnome-extensions >/dev/null && \
   gnome-extensions info clipboard-indicator@tudmotu.com 2>/dev/null | grep -q "State: ACTIVE"; then
  warn "the extension 'clipboard-indicator@tudmotu.com' is also active."
  if [[ -t 0 ]]; then
    read -r -p "Disable it now to avoid two clipboard managers running? [y/N] " answer || answer=n
    case "$answer" in
      y|Y|yes|YES) gnome-extensions disable clipboard-indicator@tudmotu.com
                   info "clipboard-indicator disabled." ;;
      *) warn "leaving clipboard-indicator enabled — expect duplicate captures." ;;
    esac
  else
    warn "run: gnome-extensions disable clipboard-indicator@tudmotu.com"
  fi
fi

info "installed."
cat <<EOF

  One final step: log out and back in once (a GNOME extension needs a
  fresh Shell session to load), then press Win+V and start copying.

EOF
