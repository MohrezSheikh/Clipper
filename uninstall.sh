#!/usr/bin/env bash
# Clipper uninstaller — removes the extension and restores the default
# Win+V behavior (notification panel).
set -euo pipefail

SRC="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
EXT_UUID="clipper@mohrezsheikh"
info() { printf '\033[1;33mclipper:\033[0m %s\n' "$*"; }
PREFIX="${PREFIX:-$HOME/.local}"

# restore GNOME's own binding for the notification panel first
gsettings reset org.gnome.shell.keybindings toggle-message-tray 2>/dev/null || true

rm -rf "$HOME/.local/share/gnome-shell/extensions/$EXT_UUID"

# drop the compiled schema keys and compiled entry
rm -f "$PREFIX/share/glib-2.0/schemas/io.github.mohrezsheikh.clipper.gschema.xml"
glib-compile-schemas "$PREFIX/share/glib-2.0/schemas" 2>/dev/null || true

if [[ "${1:-}" == "--purge" ]]; then
  info "purging history data (JSON history + cached images)"
  rm -rf "$HOME/.local/share/Clipper"
fi

info "removed. Log out and back in once to fully unload the extension."
