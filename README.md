# Clipper

**Windows-style clipboard history for GNOME Shell.** Press `Ctrl+Alt+V` and a
searchable clipboard panel opens over whatever you are doing. Pick an entry and
it is pasted straight into the window you were working in — you never press
`Ctrl+V` yourself.

![GNOME Shell 45-49](https://img.shields.io/badge/GNOME%20Shell-45--49-4a86cf)
![License GPL-3.0-or-later](https://img.shields.io/badge/license-GPL--3.0--or--later-blue)
![Platform](https://img.shields.io/badge/platform-Wayland%20%7C%20X11-informational)
![No daemon](https://img.shields.io/badge/dependencies-none%20beyond%20GNOME-brightgreen)

Clipper is a single GNOME Shell extension. There is no daemon, no background
app, no tray icon and no separate process to keep alive: the panel is rendered
inside the Shell, and the history lives in one JSON file plus an image cache.

That design is deliberate. On GNOME Wayland the clipboard is owned by Mutter,
and the only supported way to watch it is Mutter's selection model — which a
Shell extension has direct access to, and an external application does not
(the cluster of half-working `wl-paste` daemons is what that looks like when
you fight it). Watching it from inside the Shell also means the panel can
appear over a full-screen window, and that pasting can be typed into whatever
has focus, without any global hotkey hacks.

## Features

**The panel**

- Opens next to the mouse cursor, or wherever you last dragged it, and always
  on top of the window you were using.
- Search-as-you-type, with the search field focused the moment it opens — start
  typing straight away.
- Movable: drag the grip row at the top to put it anywhere, on any monitor. The
  position is remembered. Stray clicks on the grip do nothing; only a real drag
  is saved.
- Non-blocking by design. It takes no input grab, so the application underneath
  stays fully usable while the panel is open. It dismisses itself the instant
  you go back to work — click outside, focus another window, press `Esc`, press
  the hotkey again, or pick an entry. It can never get stuck on screen.

**Everything you copy**

- **Text**, word-wrapped, with a relative timestamp and a `×N` counter when you
  have copied it more than once. Very long entries are clipped in the card but
  pasted in full.
- **Code** — a multi-line entry that looks like source gets a monospace preview
  with syntax highlighting and a dim line-number gutter, up to eight lines.
- **Images and screenshots** — shown as the picture itself, scaled to fit, with
  no file name, size or timestamp clutter. Every screenshot tool that puts an
  image on the clipboard works (GNOME's own <kbd>Print Screen</kbd> included).
- **Files** — the first file name plus a `+N` for the rest, the folder, and the
  usual timestamp.
- **Links** — recognised and shown as a card with the host name, the path and
  the copy count.
- Copying something you already have bumps it back to the top and increases its
  counter, exactly like the Windows clipboard. Duplicate detection is by content
  hash, so the same text copied from two different places is one entry.

**Pasting**

- Clicking an entry (or pressing `Enter`) puts it on the clipboard **and** types
  the paste keystroke into the window you came from: `Ctrl+V` normally, and
  `Ctrl+Shift+Insert` when the focused window is a terminal, because terminals
  do not accept `Ctrl+V`.
- Hold `Ctrl` while clicking (or press `Ctrl+Enter`) when you only want the item
  on the clipboard and no paste — useful for pasting somewhere else by hand.
- Turning the auto-paste off in the settings makes every pick a plain copy.

**Managing the history**

- **Pin** the entries you reuse; pinned items always sit on top with a pin
  highlight and are never cleared, while everything else flows below them,
  newest first.
- Per-entry buttons for pin, delete and — for images and files — open the
  containing folder.
- Footer controls: **Clear** (drops the unpinned history, keeps the pins) and an
  **Incognito** toggle that stops recording new copies, for when you are about
  to touch a password.
- The history size is capped (200 unpinned entries by default) and configurable.

**Appearance**

- Follows your desktop's light/dark appearance and switches live when you toggle
  dark mode; can also be pinned to always Light or always Dark in the settings.

**Privacy**

- Everything stays on your machine: no network access, no telemetry, no account.
- Clipboard offers flagged as sensitive by password managers (the
  `x-kde-passwordManagerHint` type used by KeePassXC, Bitwarden, 1Password and
  friends) are never recorded at all, even with Incognito off.
- Your history is plain files you can read, edit or delete yourself — see
  [Where your data lives](#where-your-data-lives).

## Requirements

| | |
|---|---|
| Desktop | GNOME Shell **45, 46, 47, 48 or 49** |
| Session | Wayland or X11 |
| Distribution | Any distribution shipping GNOME (developed and tested on Ubuntu 25.10 with GNOME 49) |
| Extra packages | None. `nautilus` is recommended only for the "open folder" button, since that is GNOME's default file manager. |

Clipper does not work on KDE, XFCE or non-GNOME desktops — it is a Shell
extension, not a standalone application.

## Install

### Recommended: the `.deb`

Grab the newest `clipper_X.Y.Z_all.deb` from
[Releases](https://github.com/MohrezSheikh/Clipper/releases), then:

```bash
sudo apt install ./clipper_0.3.1_all.deb
```

Then **log out and back in once** and press `Ctrl+Alt+V`.

`apt` rather than `dpkg -i` is worth the extra four characters: it will pull in
any missing dependency and let you remove the package cleanly later. The
`_all.deb` suffix means the package is architecture-independent — the same file
works on Intel, AMD and ARM.

What the package touches:

| Path | What it is |
|---|---|
| `/usr/share/gnome-shell/extensions/clipper@mohrezsheikh/` | the extension itself |
| `/usr/share/glib-2.0/schemas/io.github.mohrezsheikh.clipper.gschema.xml` | its settings schema |
| `/usr/share/doc/clipper/` | license and changelog |

The package scripts compile the settings schema on install, disable the
extension on removal, and recompile the schema afterwards. It does not enable
itself or modify any other extension's settings — log out and back in, then turn
**Clipper** on in the Extensions app if it is not already active.

Why the logout is needed: GNOME Shell imports an extension's JavaScript exactly
once per session and keeps the compiled module in memory. There is no way for
the extension to be reloaded while the session is running — not even
`gnome-extensions disable`/`enable`, which only re-reads the stylesheet. A fresh
login is the only way to load the code.

### From source

```bash
git clone https://github.com/MohrezSheikh/Clipper.git
cd Clipper
./install.sh
```

No root required — it installs into `~/.local` using the standard user paths
(`~/.local/share/gnome-shell/extensions/` and `~/.local/share/glib-2.0/schemas/`),
compiles the schema, and marks the extension for auto-enable at the next login.
If another clipboard manager (for example `clipboard-indicator`) is active, it
warns and offers to disable it, because two managers watching one clipboard
produce confusing duplicate entries.

Then log out and back in once.

### Manual install

If you would rather not run the installer:

```bash
cp -r bridge/clipper@mohrezsheikh ~/.local/share/gnome-shell/extensions/
cp bridge/clipper@mohrezsheikh/io.github.mohrezsheikh.clipper.gschema.xml \
   ~/.local/share/glib-2.0/schemas/
glib-compile-schemas ~/.local/share/glib-2.0/schemas
```

### Uninstall

```bash
sudo apt remove clipper        # if you installed the .deb
./uninstall.sh                 # if you installed from source
./uninstall.sh --purge         # ...and drop your history as well
```

Or by hand: remove the extension directory and the schema file, recompile the
schema, and delete `~/.local/share/Clipper/`.

### Pick one install method

GNOME prefers the user copy in `~/.local` over the system copy in `/usr/share`,
so if you installed from source and later install the `.deb` (or the other way
round), the older copy keeps winning and you will be running old code. Remove
the user copy before switching to the package:

```bash
rm -rf ~/.local/share/gnome-shell/extensions/clipper@mohrezsheikh
```

## Quick start

1. Log out and back in once, so the Shell loads the extension.
2. Copy a few things — some text, a screenshot (<kbd>Print Screen</kbd>), a file
   from Nautilus.
3. Press `Ctrl+Alt+V`. The panel opens next to your cursor with everything you
   copied.
4. Type a few letters to filter, press `Enter` (or click) — it is pasted where
   you were typing.

## Keyboard reference

| Keys | Action |
|---|---|
| `Ctrl+Alt+V` | Open or close the panel (configurable, see below) |
| Type anything | Filter the history as you type |
| `Up` / `Down` | Move the selection |
| `Enter` | Paste the selected entry into the focused window |
| `Ctrl+Enter` | Copy the selection only, do not paste |
| `Ctrl` + click | Same as `Ctrl+Enter` |
| `Ctrl+S` | Pin or unpin the selected entry |
| `Delete` | Remove the selected entry from the history |
| `Esc` | Close the panel |
| Click outside | Close the panel (the click goes to whatever is underneath) |
| Drag the top grip | Move the panel; the spot is remembered |

## Changing the hotkey

`Ctrl+Alt+V` is the default because it is free on every stock Ubuntu setup. To
change it, open the extension's settings: **Extensions** app → *Clipper* → gear
icon, or from a terminal:

```bash
gnome-extensions prefs clipper@mohrezsheikh
```

Click **Open the clipboard panel** and press the combination you want. `Esc`
abandons the change, `Backspace` restores `Ctrl+Alt+V`. A shortcut must include
`Ctrl`, `Alt` or `Super`, or be a function key — that rule stops you from
binding a bare letter and losing that key everywhere else. Changes apply
immediately, with no logout.

If you choose `Super+V`, also consider that Ubuntu binds `Super+V` to the
notification tray by default (`toggle-message-tray`). Clipper's own binding wins
while it is registered, but rebinding the stock one in **Settings → Keyboard**
leaves you with a cleaner setup. `Ctrl+Alt+V` needs no such step.

## Settings

Everything in the settings window applies live — the shortcut, the appearance
and the behaviour, with no logout and no restart.

| Setting | Default | What it does |
|---|---|---|
| Keyboard shortcut | `Ctrl+Alt+V` | Opens the panel |
| Appearance | Follow the system | `System`, `Light` or `Dark` |
| Paste into the focused window after picking an item | On | Off makes picking an item only copy it |
| Hide when another window takes focus | On | The auto-dismiss behaviour |
| History size | 200 | How many unpinned entries to keep |
| Incognito | Off | Stop recording new copies — the button in the panel footer, or `gsettings set io.github.mohrezsheikh.clipper incognito true` |

The same settings are plain GSettings, so they can be scripted:

```bash
S=io.github.mohrezsheikh.clipper
gsettings set $S clipper-toggle "['<Super>v']"      # change the hotkey
gsettings set $S theme 'dark'                       # system | light | dark
gsettings set $S auto-paste false                    # copy only, never paste
gsettings set $S history-limit 500
gsettings reset $S panel-position                    # back to opening at the cursor
gsettings reset-recursively $S                       # every setting back to default
```

One cosmetic quirk: the settings window appears in the Extensions app only after
one logout/login, because the Shell decides which extensions have a settings
page while it is loading them. Until then, use the `gsettings` commands above or
`gnome-extensions prefs`.

## Where your data lives

```
~/.local/share/Clipper/
├── history.json          the history: one JSON object, {version, items: [...]}
└── images/               image and screenshot payloads
    └── <md5>.<ext>       named by content hash, so identical images are one file
```

There is nothing else — no database, no cache, no config beyond GSettings. The
whole history can be inspected or edited with a text editor, and deleting the
directory resets Clipper to a blank slate:

```bash
rm -rf ~/.local/share/Clipper
```

Note that the image files are the entries themselves: deleting one from
`images/` leaves the matching history row pointing at a missing picture, and
Clipper drops such rows the next time it loads the history.

## How it works

```
bridge/clipper@mohrezsheikh/
    extension.js        wiring: capture, keybinding, dialog glue, lifecycle
    prefs.js            the settings window (shortcut capture, appearance, behaviour)
    lib/capture.js      selection watching, clipboard claim, paste injection
    lib/storage.js      the JSON history and the image cache
    ui/dialog.js        the panel: cards, search, pinning, dragging
    clipboard.css       card styling, light and dark palettes
```

**Capture.** The extension connects to Mutter's selection object and listens for
`owner-changed` on the clipboard. When something new is copied it reads the
available types and keeps the most specific one it understands, in the order
images → files → text, then writes images to disk and appends an entry. Reading
is asynchronous and captures are serialised, so two copies in quick succession
cannot interleave and lose one.

**Paste.** Picking an entry claims the clipboard through `St.Clipboard` (text,
`image/png` data or the `x-special/gnome-copied-files` file list), then asks
Mutter's seat for a virtual keyboard device and types the paste keystroke into
the focused window. A claim made by the extension itself comes back as an
`owner-changed` event; a short grace window after each claim keeps Clipper from
recording its own paste as a new history entry.

**Why a Shell extension.** Clipboard access, global hotkeys, typing into another
window and rendering over full-screen windows are four things that are awkward
or impossible from outside the Shell on Wayland, and trivial from inside it. The
trade-off is that Clipper is tied to GNOME — hence the roadmap note about other
desktops.

Everything that touches Shell internals is wrapped so a failure logs a line and
degrades (no thumbnail, no paste, clipboard only) instead of throwing inside the
Shell. `bash dist/doctor.sh` prints those lines along with the current state.

## Troubleshooting

Start with the built-in health check — it is read-only and prints the state of
the extension, the build the running session actually loaded, the hotkey, how
many items have been captured and the recent Shell log lines for Clipper:

```bash
bash dist/doctor.sh
```

**`Ctrl+Alt+V` does nothing after installing.** You have not logged out yet, or
the extension is not enabled. Check with:
`gnome-extensions info clipper@mohrezsheikh` — it should say `State: ACTIVE`.
Enable it in the Extensions app if needed, then log out and back in.
`doctor.sh` prints `not logged in this boot` until the running session has
loaded Clipper.

**I changed the code (or updated) and nothing changed.** Same root cause: the
Shell caches the JavaScript for the whole session.
`gnome-extensions disable`/`enable` does *not* reload it. Only a logout/login (or
a Shell restart) picks up new `.js` files. Stylesheet changes are the exception —
CSS is re-read on `disable`/`enable`, which is a quick way to check whether a
change you made was in the CSS or in the JS.

**Something I copied is not in the list.** Check that Incognito is off (the
footer button shows the state), then watch what Clipper sees:

```bash
journalctl --user -b -f | grep clipper
```

Every accepted item logs a line like `clipper: captured image`. If you see
nothing at all while copying, the clipboard is being claimed by something else —
see the next point.

**Two clipboard managers are fighting.** Another extension that watches the
clipboard (notably `clipboard-indicator@tudmotu.com`, which is enabled by
default on Ubuntu) captures the same events. Run one at a time:

```bash
gnome-extensions disable clipboard-indicator@tudmotu.com
```

**Picking an entry copies but does not paste.** Auto-paste may be off
(`gsettings set io.github.mohrezsheikh.clipper auto-paste true`), or the
keystroke was sent while the Shell still had keyboard focus, which happens if
the panel was opened without a focused window behind it. The journal says which
of the two it was: `row activated` followed by `pasted … into the focused
window` means it worked, and a missing first line means the click never reached
the row at all.

**An entry shows as an "unreadable" or empty row.** Those come from a decoding
bug fixed in 0.2.3; they are dropped automatically when the history loads, so log
out and back in once and they will be gone.

**The panel opened somewhere awkward.** `gsettings reset
io.github.mohrezsheikh.clipper panel-position` sends it back to the mouse
cursor. Dragging the grip row moves it and the position is remembered; a stray
click on the grip does not move anything.

**Weird behaviour after an update over an old install.** If you have both a user
copy and a system copy of the extension, the user copy wins. Remove
`~/.local/share/gnome-shell/extensions/clipper@mohrezsheikh` and log out.

**The Shell reported an error from Clipper.** The full log is:

```bash
journalctl --user -b | grep -i clipper
gnome-extensions show clipper@mohrezsheikh
```

Please include those lines (and your GNOME Shell version, from
`gnome-shell --version`) in a [bug report](https://github.com/MohrezSheikh/Clipper/issues).

## Building the package yourself

The `.deb` is built with `dpkg-deb` alone — no `debuild`, no `dh`, no build
dependencies:

```bash
bash dist/deb.sh            # -> dist/clipper_0.3.1_all.deb
bash dist/deb.sh 0.4.0      # -> dist/clipper_0.4.0_all.deb
```

`dist/deb.sh` assembles a package root from `bridge/`, writes the `control` file
and the maintainer scripts, and builds. To inspect a finished package:

```bash
dpkg-deb -I dist/clipper_0.3.1_all.deb      # control data
dpkg-deb -c dist/clipper_0.3.1_all.deb      # file list
dpkg-deb -x dist/clipper_0.3.1_all.deb /tmp/root   # unpack and look around
```

### Releasing

Tagging is the whole release process. The
[workflow](.github/workflows/release.yml) runs on any `v*` tag, builds the
package from the tagged source, generates `SHA256SUMS` and publishes both as
release assets, so the download link always matches the source:

```bash
git tag v0.3.2 && git push origin v0.3.2
```

The workflow needs permission to create the release. If the last step fails with
a permissions error, set **Settings → Actions → General → Workflow permissions**
to *Read and write permissions* and re-run the job. (You can also skip CI
entirely and attach `dist/clipper_X.Y.Z_all.deb` to a release by hand.)

Version numbers live in three places that must agree: `version-name` in
[`metadata.json`](bridge/clipper@mohrezsheikh/metadata.json), the default in
`dist/deb.sh`, and the tag itself (the quick-install command at the top of this
file quotes it too). The extension logs the build it loaded from `metadata.json`
at startup, so `journalctl --user -b | grep "extension enabled"` always tells you
exactly which version is running.

## Roadmap

- Colored tags for grouping
- Link previews with cached favicons
- Per-app paste shortcuts and a quick-paste bar
- Listing on [extensions.gnome.org](https://extensions.gnome.org)
- A standalone version for other desktops (KDE first)

## Contributing

Bug reports with `bash dist/doctor.sh` output and the relevant
`journalctl --user -b | grep clipper` lines are the most useful thing you can
send — that output usually contains the answer already. Pull requests are
welcome; there is no build step, no linter config and no test runner to install,
just edit the JavaScript and log out to see it. The `legacy/` directory holds an
earlier, abandoned GTK4 prototype and is not part of the shipping product.

Clipper is an independent implementation. It is inspired by the Windows
clipboard panel's interaction model and by the ideas of
[Copyous](https://github.com/G-dH/copyous) and
[clipboard-indicator](https://github.com/Tudmotu/gnome-shell-extension-clipboard-indicator)
— it is not a fork of, or derived from, either.

## License

GPL-3.0-or-later — see [LICENSE](LICENSE).
