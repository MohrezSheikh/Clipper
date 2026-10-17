#!/usr/bin/env bash
# Clipper uninstaller.  Removes the parts installed by install.sh.
#
#   ./uninstall.sh            remove app + bridge + service, keep history data
#   ./uninstall.sh --purge    also delete ~/.local/share/Clipper
set -euo pipefail

SRC="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PREFIX="${PREFIX:-$HOME/.local}"

info() { printf '\033[1;33mclipper:\033[0m %s\n' "$*"; }

# stop the service first
if command -v systemctl >/dev/null && [[ -f "$HOME/.config/systemd/user/clipper.service" ]]; then
  systemctl --user disable --now clipper.service 2>/dev/null || true
  rm -f "$HOME/.config/systemd/user/clipper.service"
  systemctl --user daemon-reload
fi

rm -rf "$PREFIX/share/clipper"
[[ -L "$PREFIX/bin/clipper" ]] && rm -f "$PREFIX/bin/clipper"

rm -rf "$HOME/.local/share/gnome-shell/extensions/clipper@mohrezsheikh"

rm -f "$PREFIX/share/glib-2.0/schemas/io.github.mohrezsheikh.clipper.gschema.xml"
glib-compile-schemas "$PREFIX/share/glib-2.0/schemas" 2>/dev/null || true

rm -f "$PREFIX/share/applications/software.clipper.desktop"
rm -f "$PREFIX/share/metainfo/software.clipper.metainfo.xml"
rm -f "$PREFIX/share/icons/hicolor/scalable/apps/clipper.svg"
command -v gtk-update-icon-cache >/dev/null && \
  gtk-update-icon-cache -q "$PREFIX/share/icons/hicolor" 2>/dev/null || true

if [[ "${1:-}" == "--purge" ]]; then
  info "purging data (history database + images)"
  rm -rf "$HOME/.local/share/Clipper"
fi

info "removed. If the bridge was loaded, log out/in to clean it up."
