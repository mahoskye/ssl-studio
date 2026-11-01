# Architecture

Draft, 2026-10-31. Choices marked **spike** are confirmed or replaced in
milestone M0.

```
┌──────────────────────── Electrobun app ────────────────────────┐
│                                                                │
│  Bun main process                    Webview (UI)              │
│  ─────────────────                   ────────────              │
│  workspace: files, watch, history    Monaco editor (text mode) │
│  lsp bridge ──stdio── starlims-lsp   blocks view               │
│  opencode adapter ──HTTP/SSE──┐      graph view                │
│  settings, style profile      │      panels, themes            │
│           ▲                   │            ▲                   │
│           └──── typed RPC (Electrobun) ────┘                   │
└───────────────────────────────┼────────────────────────────────┘
                                ▼
                  opencode background service (v2.2.5)
                  SSL agents + ssl-tidy-* skills (user level)
                  model: a local one, or a chosen provider
```

## Shell: Electrobun (ADR 0001)

- Bun is the main process; the UI runs in the system webview (WebKitGTK on
  Linux, WebView2 on Windows). Typed RPC joins the two.
- Electrobun can bundle CEF instead of the system webview. M0 found
  WebKitGTK runs Monaco well, so the system webview it is.
- The UI is TypeScript with Solid (M0: fine-grained updates, plain JSX,
  an Electrobun template). Built with Vite.

## Text mode

- **Editor:** Monaco, the VS Code editor component, imported as
  `monaco-editor/editor/editor.api` so its other language workers stay out.
- **Highlighting:** the TextMate grammar the formatter extension ships
  (`vs-code-ssl-formatter/syntaxes/ssl.tmLanguage.json`, public), loaded with
  `vscode-textmate` and `vscode-oniguruma`. TextMate scopes are also what
  makes VS Code themes import cleanly. The grammar is copied in by a pinned
  script, with its source commit recorded, not edited here.
- **Language features:** a thin LSP client in the webview wired straight to
  Monaco's provider API (M0: `monaco-languageclient` 11 needs the whole VS
  Code workbench API). Bun pipes it to `starlims-lsp --stdio` over
  Electrobun's RPC, one JSON-RPC message per RPC message, and owns the
  process: start with the workspace, restart on crash, version check. (M0:
  RPC adds about 16 ms per round trip; a loopback WebSocket with a
  per-launch token is the fallback.)
- **Formatting edits** from the server replace the whole range; the client
  trims them to the changed lines so the cursor and markers stay put. Format
  on save formats changed ranges: a full format of a 400 KB script takes
  about a second.

## The language server (ADR 0003)

- Pinned to one release, like the formatter and the style guide. On start the
  IDE checks `starlims-lsp --version` against the pin and says plainly what
  to install if they differ.
- Standard LSP covers text mode, the Objects panel (document symbols already
  include comment regions), folding and the Reference panel's hover data.
- Blocks mode needs a **syntax tree** the LSP does not expose today; graph
  mode needs a **workspace call graph**. Both are asked for as custom
  requests in [LSP-REQUESTS.md](LSP-REQUESTS.md), to be filed on
  `starlims-lsp`. The language server designs them; this repository consumes
  them.

## Blocks mode (ADR 0002)

- Built from the syntax tree: each node carries its text range. A block is
  a view of a range.
- **Edits are text edits.** Moving a procedure is: cut its range, insert at
  the target, format the two touched ranges. Editing a condition chip
  replaces that chip's range. The file is never reprinted from the tree, so
  comments, blank lines and odd layout outside the touched ranges survive
  byte for byte.
- After each edit the server reparses (it already does on every change) and
  the view diffs the new tree against the old by range and kind, so open,
  collapsed and selected blocks stay put.
- Unparsed spans are raw text blocks. A test asserts that for every fixture,
  the concatenation of all block ranges is the whole file.
- One undo stack for both modes: Monaco's model is the document; blocks mode
  applies its edits to that model.

## Graph mode

- Built from the call graph request, laid out with ELK (`elkjs`), drawn as
  SVG with pan and zoom. Regions and scripts become ELK compound nodes.

## Agents: the opencode adapter (ADR 0004)

The cleanup runner (`ssl-harness-results/agent-checks/run_tidy.py`) drove
`opencode run` as a subprocess and parsed its output. That broke on a machine
with a different opencode version. The IDE instead:

- starts a **private opencode server** (`opencode serve --stdio`) and talks
  to its HTTP API (described by `/openapi.json`), with events over SSE;
  attaching to the background service is an option;
- keeps all of it in one adapter module, behind an interface the rest of the
  IDE uses (`createSession`, `prompt`, `events`, `listModels`, `abort`);
- on connect, reads `/api/info` and refuses, with a clear message, a
  version outside the supported range;
- authenticates with HTTP Basic: a password it generates for its private
  server, or the background service's, read at run time and never stored
  or logged;
- sets the model on every session (local by default, pinned for the private
  server through `OPENCODE_CONFIG_CONTENT`) and starts every session with
  deny rules for shell, web, outside-workspace access and, for unattended
  runs, questions;
- puts the code in the prompt and applies the answer as range edits, rather
  than letting the agent edit files (M0: the local model ran in code mode
  with no file tools);
- accepts a `--server` URL, so it can use opencode on another machine.

Tests run against a recorded fake of the API. A contract test that records
against a live server is run by hand, on the local model only.

The **tidy** flow carries over the runner's checks, computed in the IDE with
the language server rather than in Python: baseline findings before the step,
findings after, `:PARAMETERS` compared, and for the comments step the code
with comments stripped compared. Each step runs in a fresh session and hands
over through the context note, as the skills expect.

## Settings and state

| What | Where |
| --- | --- |
| User settings, style profile, themes | `~/.config/ssl-studio/` |
| Workspace settings: region colours, panel layout, profile overrides | `<workspace>/.ssl-studio/` (the user decides whether to commit it) |
| Local history snapshots | `~/.local/share/ssl-studio/history/`, keyed by workspace |

## Testing

- `bun test` for the Bun side and pure UI logic.
- Fixtures are SSL written for this repository, plus examples from the public
  style guide and reference site. Never work code.
- The round-trip property for blocks mode runs over every fixture.
- UI checks with Playwright against the webview build where it can run.
