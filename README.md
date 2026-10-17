# Clipper

A Windows-style clipboard history manager for GNOME. Press **Win+V** and a
clean popup shows everything you have copied — text, code, images and
screenshots, files, links, and colors — with instant search, pinning, and
one-click pasting into the window you were working in.

Clipper is an independent application, not a shell-addon clone: the entire
UI, storage, and settings live in a regular GTK4/libadwaita app, and only a
tiny GNOME Shell bridge (~200 lines, no UI) handles the three things Linux
platforms do not grant normal applications: background clipboard capture,
the global hotkey, and keyboard injection for auto-paste. Because the
fragile part is minimal, Clipper keeps working when GNOME updates, unlike
full shell extensions.

## Features

- **Win+V popup** (Super+V by default, configurable) with a pre-focused
  search field, Windows-clipboard style.
- **Everything you copy appears here**: plain text, multi-line code
  (monospace preview), images and screenshots, file lists with sizes, links,
  and hex colors. Copying the same thing again bumps it back to the top and
  increases its counter, exactly like Windows.
- **Screenshots get a file location.** Every image is stored at
  `~/.local/share/Clipper/images/<hash>.png`. The card shows the file path
  and size; the right-click menu offers "Open Folder" and "Copy Path". Works
  with any screenshot tool that puts images on the clipboard.
- **Pinned items always stay on top**; new copies and screenshots flow in
  below them. Pin with Ctrl+S, the pin button, or the right-click menu.
- **Windows-style paste**: Enter or a single click puts the item on the
  clipboard and sends Ctrl+V into your previous window (toggleable in
  settings). Ctrl+C inside the popup copies without pasting; Esc closes.
- **Per-item actions** via right-click: Copy, Pin/Unpin, Delete, Open
  Folder, Copy Path. Bottom bar: incognito capture toggle, settings, and
  Clear (pinned items survive Clear).
- **Follows your theme**: system, light, or dark; pick in settings.
- **Local only**: history is an SQLite database under
  `~/.local/share/Clipper/`. Nothing leaves the machine.

## Install

### Debian / Ubuntu — one file

Download the newest `clipper_*_all.deb` from
[Releases](https://github.com/mohrezsheikh/clipper/releases), then:

```bash
sudo apt install ./clipper_0.1.0_all.deb
```

Log out and back in once (this loads the clipboard bridge), then press
**Win+V**.

### From source (any distro running GNOME)

```bash
git clone https://github.com/mohrezsheikh/clipper
cd clipper
./install.sh              # installs to ~/.local, no root required
```

Uninstall any time with `./uninstall.sh` (add `--purge` to delete your
history data as well).

## The shortcut

The default is `Super+V`. Change it with:

```bash
gsettings set io.github.mohrezsheikh.clipper clipper-toggle "['<Super>v']"
```

## Keyboard reference

| Keys                        | Action                                   |
|-----------------------------|------------------------------------------|
| Super+V (default)           | Toggle the popup                          |
| Up/Down, Home/End           | Move in the list                          |
| Enter or click a card       | Put item on clipboard and paste it        |
| Ctrl+C                      | Copy without pasting                      |
| Ctrl+S                      | Pin / unpin the selected item             |
| Delete                      | Remove the selected item                  |
| Right-click                 | Per-item menu (pin, open folder, ...)     |
| `/`                         | Focus the search field                    |
| Esc                         | Dismiss the popup                         |

## How it works

```
app/clipper_lib/                 the GTK4/libadwaita application
    main.py                      daemon + DBus service (io.github.mohrezsheikh.clipper)
    window.py, styles.css        the popup: search bar, item cards, footer
    db.py                        SQLite history, dedup, pinning, trimming
    prefs.py                     GSettings-backed settings
bridge/clipper@mohrezsheikh/     ~200-line GNOME Shell bridge:
                                 clipboard owner-change capture -> DBus,
                                 the hotkey registration, Ctrl+V injection
dist/deb.sh                      builds the .deb (app + bridge + icons + schema)
.github/workflows/release.yml    tags vX.Y.Z -> GitHub release with the .deb
```

On GNOME Wayland a normal application cannot watch the clipboard in the
background; only code inside GNOME Shell can. That is the reason for the
bridge — the same reason Copyous and Pano are shell extensions. Clipper
flips the trade-off: the parts that change often (UI, storage, settings)
stay in a normal app that never needs a shell restart to update, and the
bridge stays small enough to remain stable across GNOME versions.

## Troubleshooting

- **Win+V does nothing after install** — the bridge needs a fresh session.
  Log out and back in. Check with `gnome-extensions list --enabled | grep
  clipper`; re-enable with `gnome-extensions enable clipper@mohrezsheikh`.
- **Duplicates or missing items** — another clipboard manager may be
  installed. If you still run *clipboard-indicator@tudmotu*, consider
  disabling it; two managers fight over the same clipboard.
- **Auto-paste did not trigger** — make sure it is enabled in settings.
  A few applications reject injected key events; in that case the item is
  still copied, so a manual Ctrl+V works.
- **Data location** — history: `~/.local/share/Clipper/clipper.db`;
  images: `~/.local/share/Clipper/images/`. Logs:
  `journalctl --user -u clipper.service` and, for the bridge,
  `journalctl --user` (filter by the `clipper:` prefix).

## Roadmap

- Extension-free capture backend for KDE/Hyprland/Sway via `wl-clipboard`
- Optional link previews (title + favicon)
- Colored tags for grouping, like Pano projects
- extensions.gnome.org listing for the bridge

## License

GPL-3.0-or-later. See [LICENSE](LICENSE).
