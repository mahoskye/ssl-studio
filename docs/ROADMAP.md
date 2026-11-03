# Roadmap

Ranked. Each milestone ends in something usable.

## M0: spikes (a day or two)

**Mostly done (2026-11-01)**, results in [spikes/M0.md](spikes/M0.md).
Monaco works in WebKitGTK and in the Electrobun window, the LSP bridge works
over Electrobun's RPC, opencode's API is mapped and tried on the local
model, Solid chosen. The remote machine turned out to be Windows (see M6).

- An Electrobun window on Linux running Monaco with the TextMate grammar and
  a VS Code theme, talking to `starlims-lsp --stdio` through Bun. Decide CEF
  or system webview (ADR 0001).
- Choose the UI library (Solid or Svelte) by building the Objects panel in
  each, roughly.
- Probe the opencode 2.2.5 service API: version endpoint, sessions, prompts,
  the event stream, model list, per-session permissions, skill loading.
  Record the fake from a session on the local model (ADR 0004).
- Find out the remote machine's OS and opencode version.

## M1: a text IDE for daily use

**Done (2026-11-01).** Electrobun app and a browser host for development;
every server feature, multi-file definition and references, rename; format
on save widened to the changed procedures; local history with diff and
restore; `hutch run selftest` checks the desktop build.

- Open a folder; file tree; tabs; split editors.
- All the language server's features; format on save; the Problems panel.
- Light and dark themes; VS Code theme import.
- Status bar: language server and opencode versions, the size meter.
- Local history on save.

## M2: panels and house style

**Done (2026-11-01)**, except what waits on the language server: the Objects
panel shows what document symbols carry (regions, procedures, parameters);
`:INCLUDE`s and calls need L2. The style profile edits the server's own
`ssl` settings over a house preset (decisions 0002, 0005, 0006); the house
preset turns off `c_style_comment_closer`, which flags the Designer banner's
`*/;` closer that decision 0005 prescribes.

- Objects panel from document symbols (regions, procedures, publics, includes,
  calls).
- Palette with templates from the style profile: Designer banner, procedure
  doc block (program decision 0005).
- Reference panel.
- Health panel and the size limits (program decision 0006).
- Style profile editor, mapped to the language server's settings.
- Region minimap; breadcrumbs.

## M3: blocks mode

**First version done (2026-11-01), on what the server already gives.** The
tree is built from document symbols (comment regions, procedures and their
parameters) and folding ranges (control flow, comments, `:REGION` text):
region frames in their colours, procedure cards, control-flow blocks, code
chips coloured by the theme, the banner as a card. Selection follows the text
cursor; moves (siblings up and down), wrap in a region, delete, in-place
editing of chips and drops from the palette are all text edits on the same
model, with one undo stack. The coverage test runs over recorded server
data for every fixture.

With L1 (the server's `ssl/syntaxTree`, released in starlims-lsp 0.29.0 on
2026-11-03, the pinned version): statement-level chips,
`:ELSE`/`:CASE`/`:CATCH` arms as their own blocks, unreadable spans as raw
blocks. The self-test checks the tree on Linux and Windows. A block's header
shows its condition as a field (`:IF` · `Empty(sSampleId)` · `;`), cut from
the server's `headerRange`; editing it replaces only that span, as one undo
step (2026-11-03).

1. Read-only blocks view, synced selection with text mode, region frames with
   colours, collapse. The round-trip coverage test over all fixtures.
2. Block moves: reorder statements and procedures, move into or out of
   regions, wrap in a region.
3. In-place editing of chips and fields (conditions, parameters, banner and
   doc-block forms); drag from the palette.

## M4: agents

**Done (2026-11-01).** A private `opencode serve --stdio` per app run (or an
attached server), version-checked, every session with a set model (local
by default; a paid one asks first) and deny rules for shell, web,
outside-workspace access and questions. The tidy sequence runs step by
step; since the agent has no file tools (M0), the IDE supplies the file,
the note at `design/<name>.tidy.md` and the callers it finds through the
language server, and reviews each step with the runner's checks. Tests use
a fake of the API (`test/fake-opencode.ts`); the real path was checked once
on the local model. opencode 2.2.5 runs two code-mode helpers,
`worktree_create` and `session_move`, without any permission check, so no
rule or policy can deny them (found in the binary, 2026-11-01); the adapter
interrupts any turn whose code names them. That is best effort, and worth
raising with opencode.

- Agent panel: one session per workspace, model picker, local model by
  default.
- Tidy: the six `ssl-tidy-*` steps, a diff and the checks after each, accept
  or reject per step.
- "Ask about this block" from blocks and text mode.

## M5: graph mode

**First version done (2026-11-01), without L2.** The server's references
already resolve `DoProc` and `ExecFunction` targets, so the graph comes from
workspace symbols, document symbols and references: scripts as boxes (marked
near or over the size ceiling), regions inside them, procedures as nodes,
calls as edges, laid out by ELK. Filters: every call, calls between scripts,
and a procedure's or script's neighbourhood to a chosen depth. With L2 (`ssl/callGraph`, also in 0.29.0): data sources, `Include` edges
and unresolved targets as nodes, from one request. The self-test checks that
it resolves the sample's `ExecFunction` call on Linux and Windows.

## M6: packaging

**Done for Linux (2026-11-01).** `hutch run build` makes an installer and an
update bundle, with the pinned language server and the third-party notices
inside; [INSTALL.md](INSTALL.md) covers installing, building per OS and the
self-test. The remote machine is Windows (2026-11-01): paths, data folders,
`PATH` and opencode's npm shim are handled for it, and
`.github/workflows/build.yml` builds Windows, Linux and macOS installers once
the repository is on GitHub. **Run on Windows 11 (2026-11-03)** in an
evaluation VM ([tools/windows-vm](../tools/windows-vm/README.md)): tests,
release build, installer, self-test and opencode 2.2.5 pass.

- Builds for the remote machine's OS; a pinned language server bundled or
  checked; an install note.

## Later

- Run a procedure in the sandbox through a configured command (the sandbox is
  private; the IDE would only call it).
- Semantic token highlighting (L3).
