# Clipper

A Windows-style clipboard manager for GNOME. Press **Ctrl+Alt+V** and a clean
clipboard history appears right where you are typing — text, code, image
thumbnails, screenshots with their file locations, files, links and colors —
with search, pinning, and one-key pasting into the window you were working in.

Clipper runs entirely inside GNOME Shell: no daemon, no popup app, no extra
processes. It captures the clipboard through Mutter's selection model, which
is the only reliable (and sandbox-respecting) way a clipboard manager can work
on GNOME Wayland.

## Features

- **A hotkey opens the overlay at your cursor** (falls back above the cursor
  if there is not enough room). Default: `Ctrl+Alt+V`, conflict-free on every
  Ubuntu setup; change it any time with `gsettings`.
- **All content types as cards**: plain text, multi-line code (monospace
  preview), images and screenshots (thumbnail, file name, size), file lists
  (name, path, count), links and colors. Copying the same thing again bumps it
  to the top and increases its counter, like the Windows clipboard.
- **Screenshots have a file location**: images are stored at
  `~/.local/share/Clipper/images/<hash>.png`; card actions include Open
  Folder and Copy Path. Any screenshot tool that puts an image on the
  clipboard works.
- **Pinned items always stay on top** with a pin highlight; unpinned history
  flows below them, newest first.
- **Windows-style paste**: Enter or clicking a card puts the item on the
  clipboard and sends Ctrl+V into the previously focused window.
- **Keyboard-first**: type to search, arrows to move, Enter to paste, Ctrl+S
  to pin, Delete to remove, Esc to dismiss.
- **Incognito toggle** in the footer stops recording (handy for passwords).
- **Clear** in the footer empties the unpinned history; pinned items survive.
- Everything stays local: history JSON plus the image cache under
  `~/.local/share/Clipper/`.

## Install (Ubuntu / Debian)

Download the newest `clipper_*_all.deb` from
[Releases](https://github.com/mohrezsheikh/clipper/releases) and run:

```bash
sudo apt install ./clipper_0.1.0_all.deb
```

Then **log out and back in once** (a GNOME extension always needs a fresh
session), and press **Ctrl+Alt+V**.

### From source

```bash
git clone https://github.com/mohrezsheikh/clipper
cd clipper
./install.sh          # no root required; installs to ~/.local
```

Uninstall: `./uninstall.sh` (add `--purge` to remove your history data, too).

## Keyboard reference

| Keys                      | Action                                    |
|---------------------------|-------------------------------------------|
| Ctrl+Alt+V (default)      | Toggle the popup at the cursor            |
| Type (or `/`)        | Search                                    |
| Up / Down            | Move through the list                     |
| Enter or click card  | Put the item on the clipboard and paste   |
| Copy button on card  | Copy without pasting                      |
| Ctrl+S               | Pin / unpin the selected item             |
| Delete               | Remove the selected item                  |
| Right-click row      | Copy / pin / delete / open folder         |
| Esc                  | Dismiss the popup                         |

## The shortcut

Default: `Ctrl+Alt+V`. Change it with, for example:

```bash
gsettings set io.github.mohrezsheikh.clipper clipper-toggle "['<Super>v']"
```

If you pick `Super+V` you may also want to free it from GNOME's notification
panel (`toggle-message-tray`, which stock Ubuntu binds to it); rebinding that
is done in GNOME Settings → Keyboard. `Ctrl+Alt+V` needs no such step.

## What is inside

```
bridge/clipper@mohrezsheikh/   the GNOME Shell extension
    extension.js               wiring: capture, keybinding, dialog glue
    lib/capture.js             selection capture, clipboard claim, Ctrl+V injection
    lib/storage.js             JSON history + image cache
    ui/dialog.js               the card dialog rendered in Shell
    clipboard.css              card styling
legacy/                        preview: a GTK4 desktop manager app (v2)
dist/deb.sh                    builds the .deb (one command)
.github/workflows/release.yml  tags vX.Y.Z -> GitHub release with the .deb
```

## Troubleshooting

- **Ctrl+Alt+V shows nothing after install** — a fresh session is
  required (the extension must load anew). Run
  `./install.sh` again if unsure, then log out/in once.
- **Write about what you copied, but nothing appears** — history is written
  on capture; check the shell log: `journalctl --user | grep clipper`.
- **A competing manager installed** (for example **clipboard-indicator**) —
  install.sh offers to disable it; having two active managers causes
  duplicate captures.
- **Where is my data?** `~/.local/share/Clipper/history.json` and
  `~/.local/share/Clipper/images/`.

## Roadmap

- Colored tags for grouping (Pano-style), per-app incognito exceptions
- Link previews with favicon caching
- Advanced settings dialog (history cap UI, theme picker)
- `gnome-extensions` one-click listing on extensions.gnome.org

## License

GPL-3.0-or-later — see [LICENSE](LICENSE).
