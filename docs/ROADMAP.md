# Roadmap

Ranked. Each milestone ends in something usable.

## M0: spikes (a day or two)

**Mostly done (2026-11-01)**, results in [spikes/M0.md](spikes/M0.md).
Monaco works in WebKitGTK and in the Electrobun window, the LSP bridge works
over Electrobun's RPC, opencode's API is mapped and tried on the local
model, Solid chosen. Left: the remote machine's details.

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

- Open a folder; file tree; tabs; split editors.
- All the language server's features; format on save; the Problems panel.
- Light and dark themes; VS Code theme import.
- Status bar: language server and opencode versions, the size meter.
- Local history on save.

## M2: panels and house style

- Objects panel from document symbols (regions, procedures, publics, includes,
  calls).
- Palette with templates from the style profile: Designer banner, procedure
  doc block (program decision 0005).
- Reference panel.
- Health panel and the size limits (program decision 0006).
- Style profile editor, mapped to the language server's settings.
- Region minimap; breadcrumbs.

## M3: blocks mode

Needs L1 from [LSP-REQUESTS.md](LSP-REQUESTS.md).

1. Read-only blocks view, synced selection with text mode, region frames with
   colours, collapse. The round-trip coverage test over all fixtures.
2. Block moves: reorder statements and procedures, move into or out of
   regions, wrap in a region.
3. In-place editing of chips and fields (conditions, parameters, banner and
   doc-block forms); drag from the palette.

## M4: agents

- Agent panel: one session per workspace, model picker, local model by
  default.
- Tidy: the six `ssl-tidy-*` steps, a diff and the checks after each, accept
  or reject per step.
- "Ask about this block" from blocks and text mode.

## M5: graph mode

Needs L2. Workspace graph with ELK layout, region and script groups, filters.

## M6: packaging

- Builds for the remote machine's OS; a pinned language server bundled or
  checked; an install note.

## Later

- Run a procedure in the sandbox through a configured command (the sandbox is
  private; the IDE would only call it).
- Semantic token highlighting (L3).
- Copy for Designer.
