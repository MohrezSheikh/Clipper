#!/usr/bin/env bash
# Build the Clipper .deb package (GNOME Shell extension edition).
#
#   ./dist/deb.sh            -> dist/clipper_0.1.0_all.deb
#   ./dist/deb.sh 0.2.0      -> dist/clipper_0.2.0_all.deb
#
# Installs the extension system-wide so people can run one command:
#   sudo apt install ./clipper_X.Y.Z_all.deb
set -euo pipefail

SRC="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
VERSION="${1:-0.1.0}"
PKG="$SRC/dist/debroot/clipper"

info() { printf '\033[1;34mdeb:\033[0m %s\n' "$*"; }

rm -rf "$PKG"
mkdir -p "$PKG/DEBIAN"

# ------------------------------------------------------------- payload
mkdir -p "$PKG/usr/share/gnome-shell/extensions" \
         "$PKG/usr/share/glib-2.0/schemas" \
         "$PKG/usr/share/doc/clipper"
cp -r "$SRC/bridge/clipper@mohrezsheikh" \
      "$PKG/usr/share/gnome-shell/extensions/"
install -m644 "$SRC/bridge/clipper@mohrezsheikh/io.github.mohrezsheikh.clipper.gschema.xml" \
      "$PKG/usr/share/glib-2.0/schemas/io.github.mohrezsheikh.clipper.gschema.xml"
install -m644 "$SRC/LICENSE" "$PKG/usr/share/doc/clipper/copyright"
gzip -c "$SRC/README.md" > "$PKG/usr/share/doc/clipper/changelog.gz" 2>/dev/null || true

# -------------------------------------------------------------- control
cat > "$PKG/DEBIAN/control" <<EOF
Package: clipper
Version: $VERSION
Section: utils
Priority: optional
Architecture: all
Depends: gnome-shell (>= 45)
Recommends: nautilus
Maintainer: mohrezsheikh <clipper@users.noreply.github.com>
Homepage: https://github.com/mohrezsheikh/clipper
Description: Windows-style clipboard history for GNOME
 Clipper keeps a history of everything you copy - text, code, images
 and screenshots, files, links and colors - behind a Win+V popup
 rendered inside GNOME Shell. Pin frequently used items, search, and
 paste straight into the window you were working in.
EOF

cat > "$PKG/DEBIAN/postinst" <<'EOF'
#!/bin/sh
set -e
glib-compile-schemas /usr/share/glib-2.0/schemas/ 2>/dev/null || true
echo "clipper: installed."
echo "clipper: log out & back in once, then press Win+V. The extension"
echo "clipper: automatically moves Win+V from the notification panel."
EOF

cat > "$PKG/DEBIAN/prerm" <<'EOF'
#!/bin/sh
set -e
if [ -x /usr/bin/gnome-extensions ]; then
  gnome-extensions disable clipper@mohrezsheikh 2>/dev/null || true
fi
EOF

cat > "$PKG/DEBIAN/postrm" <<'EOF'
#!/bin/sh
set -e
glib-compile-schemas /usr/share/glib-2.0/schemas/ 2>/dev/null || true
echo "clipper: removed. Win+V returns to the notification panel after"
echo "clipper: the next logout, or run:"
echo "clipper:   gsettings reset org.gnome.shell.keybindings toggle-message-tray"
EOF

chmod 755 "$PKG/DEBIAN/postinst" "$PKG/DEBIAN/prerm" "$PKG/DEBIAN/postrm"

# ----------------------------------------------------------------- build
OUT="$SRC/dist/clipper_${VERSION}_all.deb"
rm -f "$OUT"
dpkg-deb --root-owner-group --build "$PKG" "$OUT"
rm -rf "$PKG"
info "built $OUT"
