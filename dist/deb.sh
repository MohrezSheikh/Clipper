#!/usr/bin/env bash
# Build the Clipper .deb package.
#
#   ./dist/deb.sh            -> dist/clipper_0.1.0_all.deb
#   ./dist/deb.sh 0.2.0      -> dist/clipper_0.2.0_all.deb
#
# The package contains the app, the GNOME Shell bridge, icons, desktop
# file, GSettings schema and the systemd user unit — one file installs
# everything an Ubuntu/Debian user needs.
set -euo pipefail

SRC="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
VERSION="${1:-0.1.0}"
BUILD_ROOT="$SRC/dist/debroot"
PKG="$BUILD_ROOT/clipper"

info() { printf '\033[1;34mdeb:\033[0m %s\n' "$*"; }

rm -rf "$PKG"
mkdir -p "$PKG/DEBIAN"

# ------------------------------------------------------------------ payload
install -Dm755 "$SRC/app/clipper"                      "$PKG/usr/lib/clipper/clipper"
mkdir -p "$PKG/usr/lib/clipper/clipper_lib" "$PKG/usr/bin"
install -m644  "$SRC/app/clipper_lib/"*.py             "$PKG/usr/lib/clipper/clipper_lib/"
install -m644  "$SRC/app/clipper_lib/styles.css"       "$PKG/usr/lib/clipper/clipper_lib/styles.css"
ln -sf ../lib/clipper/clipper "$PKG/usr/bin/clipper"

mkdir -p "$PKG/usr/share/gnome-shell/extensions" "$PKG/usr/share/glib-2.0/schemas"
cp -r "$SRC/bridge/clipper@mohrezsheikh"                     "$PKG/usr/share/gnome-shell/extensions/"
install -m644  "$SRC/bridge/clipper@mohrezsheikh/io.github.mohrezsheikh.clipper.gschema.xml" \
                "$PKG/usr/share/glib-2.0/schemas/io.github.mohrezsheikh.clipper.gschema.xml"

mkdir -p "$PKG/usr/share/applications" "$PKG/usr/share/metainfo" \
         "$PKG/usr/share/icons/hicolor/scalable/apps" \
         "$PKG/usr/lib/systemd/user" "$PKG/usr/share/doc/clipper"
install -m644  "$SRC/data/software.clipper.desktop"    "$PKG/usr/share/applications/"
install -m644  "$SRC/data/software.clipper.metainfo.xml" "$PKG/usr/share/metainfo/"
install -m644  "$SRC/data/icons/hicolor/scalable/apps/clipper.svg" \
                "$PKG/usr/share/icons/hicolor/scalable/apps/clipper.svg"
install -m644  "$SRC/data/clipper.service"             "$PKG/usr/lib/systemd/user/clipper.service"
install -m644  "$SRC/LICENSE"                          "$PKG/usr/share/doc/clipper/copyright"
gzip -c "$SRC/README.md" > "$PKG/usr/share/doc/clipper/changelog.gz" 2>/dev/null || true

# ------------------------------------------------------------------ control
cat > "$PKG/DEBIAN/control" <<EOF
Package: clipper
Version: $VERSION
Section: utils
Priority: optional
Architecture: all
Depends: python3 (>= 3.10), python3-gi, gir1.2-gtk-4.0, gir1.2-libadwaita-1, gnome-shell
Recommends: xdg-utils
Suggests: systemd
Maintainer: mohrez <clipper@users.noreply.github.com>
Homepage: https://github.com/mohrezsheikh/clipper
Description: Windows-style clipboard history manager for GNOME
 Clipper keeps a history of everything you copy - text, code, images
 and screenshots, files, links and colors - in one popup opened with
 Win+V. Pin frequently used items, search, and paste directly into the
 window you were working in, just like the Windows clipboard.
EOF

cat > "$PKG/DEBIAN/postinst" <<'EOF'
#!/bin/sh
set -e
glib-compile-schemas /usr/share/glib-2.0/schemas/ 2>/dev/null || true
command -v gtk-update-icon-cache >/dev/null 2>&1 && \
  gtk-update-icon-cache -q /usr/share/icons/hicolor 2>/dev/null || true
command -v update-desktop-database >/dev/null 2>&1 && \
  update-desktop-database -q /usr/share/applications 2>/dev/null || true
echo "clipper: installed. Log out & back in once so the clipboard bridge loads, then press Win+V."
EOF

cat > "$PKG/DEBIAN/postrm" <<'EOF'
#!/bin/sh
set -e
glib-compile-schemas /usr/share/glib-2.0/schemas/ 2>/dev/null || true
EOF

chmod 755 "$PKG/DEBIAN/postinst" "$PKG/DEBIAN/postrm"

# ------------------------------------------------------------------- build
OUT="$SRC/dist/clipper_${VERSION}_all.deb"
rm -f "$OUT"
dpkg-deb --root-owner-group --build "$PKG" "$OUT"
rm -rf "$PKG"
info "built $OUT"
