#!/usr/bin/env bash
# Clipper — user-level installer (no root needed).
#
#   ./install.sh                        install to ~/.local
#   PREFIX=/usr ./install.sh            system install (needs sudo)
#   ./install.sh --no-service           skip the systemd user service
set -euo pipefail

SRC="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PREFIX="${PREFIX:-$HOME/.local}"

if [[ "${1:-}" == "--no-service" ]]; then
  NO_SERVICE=1
fi

info() { printf '\033[1;34mclipper:\033[0m %s\n' "$*"; }

if ! command -v python3 >/dev/null; then
  echo "python3 is required" >&2; exit 1
fi

if ! python3 -c "import gi" 2>/dev/null; then
  info "python3-gi is missing — install it (Ubuntu/Debian): sudo apt install python3-gi gir1.2-gtk-4.0 gir1.2-libadwaita-1"
  exit 1
fi
if ! python3 -c "import gi; gi.require_version('Gtk','4.0'); gi.require_version('Adw','1')" 2>/dev/null; then
  info "GTK4/libadwaita GIR bindings are missing — install: gir1.2-gtk-4.0 gir1.2-libadwaita-1"
  exit 1
fi

# ------------------------------------------------------------------ app
APP_DIR="$PREFIX/share/clipper"
info "installing app to $APP_DIR"
mkdir -p "$APP_DIR/clipper_lib" "$PREFIX/bin"
cp "$SRC/app/clipper" "$APP_DIR/clipper"
cp "$SRC/app/clipper_lib/"*.py "$APP_DIR/clipper_lib/"
cp "$SRC/app/clipper_lib/styles.css" "$APP_DIR/clipper_lib/"
chmod +x "$APP_DIR/clipper"
ln -sf "$APP_DIR/clipper" "$PREFIX/bin/clipper"

# --------------------------------------------------------------- schemas
SCHEMA_DIR="$PREFIX/share/glib-2.0/schemas"
info "installing GSettings schema"
mkdir -p "$SCHEMA_DIR"
cp "$SRC/bridge/clipper@mohrezsheikh/io.github.mohrezsheikh.clipper.gschema.xml" "$SCHEMA_DIR/"
glib-compile-schemas "$SCHEMA_DIR" 2>/dev/null || true

# ---------------------------------------------------------- the bridge
EXT_DIR="$HOME/.local/share/gnome-shell/extensions/clipper@mohrezsheikh"
info "installing GNOME Shell bridge to $EXT_DIR"
mkdir -p "$(dirname "$EXT_DIR")"
rm -rf "$EXT_DIR"
cp -r "$SRC/bridge/clipper@mohrezsheikh" "$EXT_DIR"

# ------------------------------------------------------------ data files
data_dir="$PREFIX/share"
for icon_size_dir in scalable; do
  mkdir -p "$data_dir/icons/hicolor/$icon_size_dir/apps"
  cp "$SRC/data/icons/hicolor/$icon_size_dir/apps/clipper.svg" "$data_dir/icons/hicolor/$icon_size_dir/apps/"
done
if command -v gtk-update-icon-cache >/dev/null; then
  gtk-update-icon-cache -q "$data_dir/icons/hicolor" 2>/dev/null || true
fi

mkdir -p "$data_dir/applications" "$data_dir/metainfo"
cp "$SRC/data/software.clipper.desktop" "$data_dir/applications/"
cp "$SRC/data/software.clipper.metainfo.xml" "$data_dir/metainfo/"

# when PREFIX is /usr keep Exec=clipper; for ~/.local make it absolute
if [[ "$PREFIX" != "/usr" && "$PREFIX" != "/usr/local" ]]; then
  sed -i "s|Exec=clipper|Exec=$PREFIX/bin/clipper|" "$data_dir/applications/software.clipper.desktop"
fi

# -------------------------------------------------------------- service
if [[ -z "${NO_SERVICE:-}" ]] && command -v systemctl >/dev/null; then
  UNIT_DIR="$HOME/.config/systemd/user"
  mkdir -p "$UNIT_DIR"
  cp "$SRC/data/clipper.service" "$UNIT_DIR/clipper.service"
  if [[ "$PREFIX" != "/usr" && "$PREFIX" != "/usr/local" ]]; then
    sed -i "s|ExecStart=/usr/bin/clipper|ExecStart=$PREFIX/bin/clipper|" "$UNIT_DIR/clipper.service"
  fi
  systemctl --user daemon-reload
  systemctl --user enable --now clipper.service
  info "autostart service enabled (systemd user unit)"
else
  info "skipping systemd service (either requested or not available)"
fi

info "installed!"
cat <<EOF

  Next steps:
    1. If the bridge was installed/upgraded, log out & back in once
       (the GNOME Shell extension needs a fresh shell session).
    2. Press Win+V (Super+V) to open the popup.
    3. Copy something — it should appear at the top.

  Dev-friendly test without relogin: just run \`clipper --toggle\`.

EOF
