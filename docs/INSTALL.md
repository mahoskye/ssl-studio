# Installing and building SSL Studio

## What it needs

| | Needed for | Notes |
| --- | --- | --- |
| `starlims-lsp` 0.32.0 | everything SSL | Release builds carry it (`app/bin/starlims-lsp`). From source, put it on `PATH`, set `STARLIMS_LSP`, or set `lspPath` in Settings. Another version runs with a warning in the status bar. |
| opencode 2.2.5 to 2.3.x | the Agent panel only | On `PATH`. The IDE starts its own private server; nothing is shared with opencode's background service. |
| A local model | the Agent panel's default | Ollama through opencode's `ollama` provider, or any provider set in `agentServerConfig`. A paid provider is used only after you choose it. |
| GTK 3, WebKitGTK 4.1, Ayatana AppIndicator, librsvg (Linux) | the window | Native Electrobun runtime libraries. Install the packages for your distribution below. |

## Installing a release (Linux)

```bash
tar xzf linux-x64-SSLStudio-Setup.tar.gz
./installer
```

The installer puts the app in `~/.local/share/` and adds a desktop shortcut.
Settings live in `~/.config/ssl-studio/`, local history in
`~/.local/share/ssl-studio/history/`, and per-workspace settings in
`<workspace>/.ssl-studio/`: `project.toml` for what the project is (you edit
it), `settings.json` for region colours, layout and style overrides (the IDE
writes it).

## Building

Electrobun builds for the machine it runs on: build on each target OS.

```bash
npx electrobun@2.0.5 prepare             # once: Hutch and the Electrobun runtime
hutch install                            # packages, from hutch.lock
bun scripts/bundle-lsp.ts --download     # once per OS: the pinned language server, via gh
hutch run build                          # artifacts/ gets the installer and the update bundle
```

`bundle-lsp.ts` without `--download` copies a local starlims-lsp 0.32.0
instead. The build also writes `THIRD-PARTY-NOTICES.md` (the bundled
packages' licenses) into the app.

`prepare` caches Hutch under `~/.hutch/npm/electrobun/2.0.5/<platform>/bin`; it
does not add the `hutch` command to `PATH`. Make that directory available in
your shell before running the commands below, or use an existing Hutch install.
The platform directory is `linux-x64`, `linux-arm64`, `macos-x64`,
`macos-arm64`, `windows-x64` or `windows-arm64`.

### Linux desktop libraries

The browser host does not need these packages. The Electrobun desktop window
does. On Arch Linux or Manjaro, install them with:

```bash
sudo pacman -S --needed gtk3 webkit2gtk-4.1 libayatana-appindicator librsvg
```

On Ubuntu/Debian, use `libgtk-3-0 libwebkit2gtk-4.1-0
libayatana-appindicator3-1 librsvg2-2`. On Fedora/RHEL, use `gtk3
webkit2gtk4.1 libappindicator-gtk3 librsvg2`.

## Checking a build

```bash
hutch run selftest
```

Opens the app on `fixtures/workspace`, checks highlighting, the language
server, symbols, diagnostics, hover, format with undo and what the Docs panel
lists, writes `selftest.json` and quits. Its settings go to `.selftest/`, not yours. `hutch run selftest-cycle`
does the same and then drives a plan's whole life in the window (build, follow a link, see drift,
change the chart and rebuild, write the tests), on a copy of the workspace, with the recorded
fake in place of a model. On that copy it also presses "Set up project" and reads the documents
that makes, rendered and as text. It costs nothing.

`hutch run selftest-close` checks that closing the window never loses work and never asks
([ADR 0042](adr/0042-closing-keeps-unsaved-work-and-asks-nothing.md)). On a copy of the workspace it
edits a file, writes in a document that has no file yet, leaves both unsaved, and presses the
window's close button from outside. The app has to close by itself, with the file on disk as it
was. Started again, it has to show both documents unsaved with every line they were left with;
the file is then saved, and the window closed once more. It runs on Linux with X11 and `xdotool`,
and on Windows; it is not written for macOS.

## A local model through Ollama

Ollama's default context is 4096 tokens, and it drops what does not fit without an
error. A prompt with a skill and a file does not fit, so agent steps quietly work from
part of what they were given. `ollama ps` shows the context in use. Give the service
more, for example `OLLAMA_CONTEXT_LENGTH=16384` in its environment. A larger context
uses more memory. See the [spike](spikes/planning-mode.md).

## Windows (the remote machine)

The remote machine runs Windows (2026-11-01). Three ways to a build:

- **CI:** `.github/workflows/build.yml` builds on Windows, Linux and macOS
  once the repository is on GitHub, and uploads each OS's installer with the
  pinned language server inside.
- **A Windows checkout:** the steps above, in Git Bash or PowerShell, with
  Bun, Node and the Visual C++ runtime installed (`winget install
  Microsoft.VCRedist.2015+.x64`). Hutch's runtime libraries need the last
  one, and a fresh Windows does not have it: without it the Vite step fails
  with "compression.dll: The specified module could not be found".
- **A test VM on Linux:** [tools/windows-vm](../tools/windows-vm/README.md)
  sets up Microsoft's Windows 11 evaluation in QEMU, builds there and runs
  the self-test in its desktop.

On Windows:

- settings are in `%APPDATA%\ssl-studio\`, local history in
  `%LOCALAPPDATA%\ssl-studio\history\`;
- opencode installed with npm leaves an `opencode.cmd` shim; SSL Studio runs
  the real `opencode.exe` beside it (or goes through `cmd.exe`);
- the system webview is WebView2, which current Windows ships. M0 measured
  WebKitGTK only; run `hutch run selftest` on the machine once to check it.

opencode there is 2.2.x (the user, 2026-11-01), inside the adapter's
supported range (ADR 0004).
