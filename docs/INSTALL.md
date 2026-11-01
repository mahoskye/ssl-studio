# Installing and building SSL Studio

## What it needs

| | Needed for | Notes |
| --- | --- | --- |
| `starlims-lsp` 0.28.2 | everything SSL | Release builds carry it (`app/bin/starlims-lsp`). From source, put it on `PATH`, set `STARLIMS_LSP`, or set `lspPath` in Settings. Another version runs with a warning in the status bar. |
| opencode 2.2.x | the Agent panel only | On `PATH`. The IDE starts its own private server; nothing is shared with opencode's background service. |
| A local model | the Agent panel's default | Ollama through opencode's `ollama` provider, or any provider set in `agentServerConfig`. A paid provider is used only after you choose it. |
| WebKitGTK 4.1 (Linux) | the window | The system webview Electrobun uses on Linux (`libwebkit2gtk-4.1`). Present on current Ubuntu and Fedora desktops. |

## Installing a release (Linux)

```bash
tar xzf linux-x64-SSLStudio-Setup.tar.gz
./installer
```

The installer puts the app in `~/.local/share/` and adds a desktop shortcut.
Settings live in `~/.config/ssl-studio/`, local history in
`~/.local/share/ssl-studio/history/`, and per-workspace settings (region
colours, layout, style overrides) in `<workspace>/.ssl-studio/`.

## Building

Electrobun builds for the machine it runs on: build on each target OS.

```bash
npx electrobun@2.0.5 prepare             # once: Hutch and the Electrobun runtime
hutch install                            # packages, from hutch.lock
bun scripts/bundle-lsp.ts --download     # once per OS: the pinned language server, via gh
hutch run build                          # artifacts/ gets the installer and the update bundle
```

`bundle-lsp.ts` without `--download` copies a local starlims-lsp 0.28.2
instead. The build also writes `THIRD-PARTY-NOTICES.md` (the bundled
packages' licenses) into the app.

## Checking a build

```bash
hutch run selftest
```

Opens the app on `fixtures/workspace`, checks highlighting, the language
server, symbols, diagnostics, hover and format with undo, writes
`selftest.json` and quits. Its settings go to `.selftest/`, not yours.

## The remote machine

Not known yet (OS and opencode version). On Windows or macOS, build there
with the steps above; the language server has release assets for
`windows-amd64`, `darwin-amd64` and `darwin-arm64`. The opencode adapter
accepts 2.2.x; another minor version is refused with a message until it has
been tried (ADR 0004).
