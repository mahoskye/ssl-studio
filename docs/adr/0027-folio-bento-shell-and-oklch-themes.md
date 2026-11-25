# ADR 0027: Folio Bento shell and OKLCH Warm Material themes

**Status:** Accepted
**Date:** 2026-11-20
**Decided by:** the user, after live walkthrough review of the current
interface and five iterative design rounds documented in
[UI-DESIGN.md](../UI-DESIGN.md).

Under [ADR 0007](0007-design-is-held-to-a-standard-that-serves-starlims-work.md),
[ADR 0010](0010-everything-works-from-the-keyboard.md),
[ADR 0020](0020-the-shell-does-what-vs-code-does-and-stays-its-own.md), and
[ADR 0023](0023-the-windows-graphics-and-menus-are-its-own.md).

## Context

- The current shell pairs two hand-tuned cool-slate/stark-white themes
  (`studio-dark.json` and `studio-light.json`) with edge-to-edge panels
  separated by `4px` solid borders.
- Live walkthrough screenshots on `examples/due-dates` exposed concrete
  ergonomic defects: low surface separation in dark mode, stark white glare in
  light mode, mid-character status bar clipping at `740px`, vanished document
  tabs in Call Graph and Diff Review, a mismatched 2-column `.diff-sides`
  header over Monaco's inline fallback, an inline Markdown outline hidden
  below `1000px` and squeezing prose above it, wrapping toolbars in Blocks,
  Plan Details, and Table View, and right-docked panel buttons disconnected on
  the left Activity Bar.
- Developers working long sessions in STARLIMS benefit from calm luminance
  stepping between chrome and code—including a mixed-polarity option (dark
  chrome framing a warm paper editor)—without abandoning VS Code muscle memory
  or custom VS Code theme import.

## Decision

- **OKLCH Warm Material theme engine (`5 Tones × 5 Materials`).** Built-in
  themes are generated deterministically in OKLCH from two axes: five surface
  tones (`Paper`, `Stone`, `Split Warm`, `Slate Dusk`, `Obsidian`) and five
  material hues (`Walnut`, `Moss`, `Clay`, `Steel`, `Veridian`). Classic
  `Studio Dark` / `Studio Light` presets and VS Code `.json` theme import
  remain supported.
- **Decoupled chrome and editor tokens.** Every theme emits chrome-scoped CSS
  variables alongside editor-scoped variables (`--editor-*`) so `Split Warm`
  meets WCAG 2.1 AA (`4.5:1` text, `3:1` control edges) independently on dark
  chrome and light paper canvases. Automated tests hold all 25 generated
  combinations to WCAG AA.
- **Folio Bento shell geometry.** Sidebars, the editor sheet, and the bottom
  panel sit as `7px`-rounded `1px`-bordered islands on a recessed tray with
  `5px` gutters and hover-illuminated hidden splitters (collapsing gutters at
  `<= 780px` so code keeps full width). Tucked Folio tabs stay visible across
  every mode (including Call Graph and Diff Review) with view-mode switches
  locked at the tab-strip right end.
- **System-default typography with configurable font slots.** Default UI chrome
  stays pure `system-ui` sans-serif and code stays `ui-monospace` (with Monaco
  Codicons and `FileMark` preserved). Users may configure `--ui-font`,
  `--code-font`, and optional `--read-font` (Markdown Read view only) in
  Settings alongside Theme.
- **Locked workflow choices:**
  - Unify the standalone `Objects` and Markdown `Document outline` panels into
    one right-docked **Document outline** panel (`id: "objects"`), paired with
    a collapsible, resizable **Outline** drawer inside `Explorer` (both backed
    by one shared `SymbolOutline` component with Follow cursor, Sort by
    Position/Name/Type, and Collapse/Expand controls). Gate `Document outline`
    and `Palette` in the Activity Bar so they appear only when a matching
    document or mode is open, and couple `Palette` to SSL, Plans, and Call
    Graph.
  - Mirror VS Code Explorer structure with collapsible, resizable **Open
    editors**, a collapsible workspace root (ready for multi-root workspaces)
    carrying `New file`, `New folder`, `Refresh`, and dynamic `Collapse/Expand`
    actions, and VS Code-grouped right-click context menus with shortcuts.
  - Support floating in-memory `Untitled-N` buffers (double-click empty tab
    strip or `Ctrl+N`), horizontal tab-strip scrolling with `<`/`>` chevrons
    and edge fades, Obsidian-style `Source | Live | Read` Markdown switching,
    flush empty-state start pane (no card chrome or `33px` tab gap), and
    zero-jump hover stability in Blocks view.
  - Render multi-line git gutter hunks continuously without gaps, keeping
    non-color distinction (`3px` solid filled for `added`, `3px` continuous
    hollow rail for `modified`, `7px` tick for `removed`, per ADR 0010).
  - Theme Monaco `peekView.*` and `editorStickyScroll.*` tokens per editor
    polarity across all 25 OKLCH themes, verified to WCAG AA.
  - Keep CSV registry cells 100% literal plain text (ADR 0002); any future
    table display styling lives out-of-band in `.ssl-studio/` config.
  - Hide the bottom panel by default outside the Code Editor and remember its
    open/closed state independently per mode.

## Consequences

- `src/shared/oklchTheme.ts` becomes the single pure source of built-in OKLCH
  palettes, tested directly by `test/contrast.test.ts`.
- `Follow the system` resolves to `Paper` (light) or `Slate Dusk` (dark) in
  the user's chosen Material (default `Walnut`), while saved `"dark"`,
  `"light"`, and `"custom:*"` settings continue to resolve cleanly.
- Implementation completed in staged slices per [UI-DESIGN.md](../UI-DESIGN.md):
  1. OKLCH theme engine, decoupled `--editor-*` tokens, font slots, Settings.
  2. Folio Bento shell, Tucked Folio tabs, hidden splitters, responsive status.
  3. Core editor & panels (collapsing header, Problems grid, continuous git
     bars, shared `Outline`/`Document outline`, narrow right-in-left rail,
     per-mode bottom panel).
  4. Mode refinements (Call Graph tabs/legend/Palette, Plan Palette/Details,
     unified Document outline, sticky CSV column, Diff layout fix, Projects
     toggle) and Phase 1.5 hands-on refinements (C1–C13: flush Start pane,
     VS Code Explorer accordion & context menu, resizable `<SectionSplitter />`,
     Health scrolling, floating untitled buffers, tab overflow scroll,
     Obsidian `Source | Live | Read`, Blocks hover lock, Peek/Sticky Scroll
     theme tokens).

## Not decided

- Phase 2 Diff `Hunk Cards` and an Excalidraw-style visual canvas translating
  bidirectionally to `.plan.json`/Mermaid will receive their own ADRs before
  implementation.
