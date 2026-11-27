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
                  opencode background service (2.2.5 to 2.3)
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
  on save formats the lines that changed, and leaves them as "Format
  document" would: the whole document is formatted and the changed lines
  are taken from the answer. A script over 400,000 characters is asked for
  its changed ranges alone, which leaves out the server's whole-document
  passes.

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
  SVG with pan and zoom. Folders, scripts and regions become ELK compound
  nodes.
- **What is drawn is chosen before it is laid out**
  ([ADR 0011](adr/0011-a-picture-is-of-what-can-be-followed.md)), by pure functions in
  `src/view/graph/model.ts`: `visible` (every call, calls between scripts,
  or around a focus), `fold` (a script or a folder as one node), `gather`
  (several lines across a folder's edge as one line to the edge), and
  `sameStep` (scripts a layered layout would put in one line, set out as a
  block instead).
- **The layout is tried across and down** for a picture of up to 250 nodes,
  and the one the view shows more of is kept.
- **The view's own arithmetic** is in `src/view/graph/canvas.ts`, shared
  with the plan chart: fitting, revealing, the corner map's area, and
  `clearLabels`, which places the names of the far picture so that none
  lies over another.
- A plan's chart is laid out by the same ELK with right-angled routes
  (`src/view/plan/chart.ts`). A decision's ways meet it at its points, and
  where a loop can be drawn more than one way each is laid out and the
  chart with the fewest crossings is kept.

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

## The working documents (ADR 0012)

What a project writes down about its work: tickets, specs, a knowledge
base, registries, and a catalog for each folder. The guide is
[WORKING-DOCUMENTS.md](WORKING-DOCUMENTS.md).

- **The logic is pure and shared,** in `src/shared/`, and tested without a
  window: `frontMatter.ts` (what a document says of itself), `catalog.ts`
  (the list between two markers), `csv.ts` (a table with each cell's place
  in the text), `manifest.ts` (the file manifest, merged), `projectDocs.ts`
  (folders, templates, states), `workList.ts` (the Work list's order and
  nesting), `docChecks.ts` (what Health says), `workContext.ts` (what the
  agent is sent), `ticketImport.ts` (tickets from an export),
  `registryCheck.ts` (a name looked for in the files).
- **The Bun side lists and reads** (`src/bun/project.ts`): `listDocs`
  gives every working document with its title, state and what it is tied
  to; `fileManifest` gives the files with their checksums; `tomlProblem`
  reads TOML with the reader `project.toml` is loaded with.
- **The view writes through the editor** (`src/view/projectDocs.ts`): a
  document that is open is changed by an edit, so it can be undone, and one
  that is not is written to disk. A file that exists is never replaced.
- **A table is a view of the text** (`src/view/editor/TableView.tsx`): a
  cell changed is that cell's characters changed (ADR 0002).
- **Files that are not SSL are read here**
  ([ADR 0015](adr/0015-what-is-not-ssl-is-read-here.md)): `outline.ts`,
  `jsonCheck.ts` and `jsonFormat.ts` in `src/shared/`, and the grammars in
  `src/view/editor/languages.ts`. SSL stays with the language server.
- **The self-test's cycle run** writes a ticket, a spec, a question and a
  registry into its copy of the workspace and checks them in the window
  (`src/view/selftestDocs.ts`).

## Settings and state

| What | Where |
| --- | --- |
| User settings, style profile, themes | `~/.config/ssl-studio/` |
| Project settings: name, description, folders, agent model, style preset | `<workspace>/.ssl-studio/project.toml`, written once by "Set up project" and then edited by hand ([ADR 0006](adr/0006-a-project-has-settings-a-readme-and-an-agents-file.md)) |
| Workspace settings the IDE writes: region colours, panel layout, profile overrides | `<workspace>/.ssl-studio/settings.json` (the user decides whether to commit it) |
| The project's documents | `README.md` and `AGENTS.md` at the root, Markdown under `docs/`, the data's shape under `schema/` (or the folders `project.toml` names), plans under `design/` |
| Local history snapshots | `~/.local/share/ssl-studio/history/`, keyed by workspace |
| Unsaved text, kept while a folder is not open | `~/.local/state/ssl-studio/unsaved/`, keyed by workspace ([ADR 0042](adr/0042-closing-keeps-unsaved-work-and-asks-nothing.md)) |

Settings layer in this order, each later one winning: the user's, the
project's (`project.toml`), what the IDE saved for the workspace.

## Testing

- `bun test` for the Bun side and pure UI logic.
- Fixtures are SSL written for this repository, plus examples from the public
  style guide and reference site. Never work code.
- The round-trip property for blocks mode runs over every fixture.
- UI checks with Playwright against the webview build where it can run.
