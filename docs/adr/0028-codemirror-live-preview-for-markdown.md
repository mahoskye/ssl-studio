# ADR 0028: CodeMirror 6 powers Markdown Live Preview

**Status:** Accepted  
**Date:** 2026-11-21  
**Supersedes:** [ADR 0024](0024-markdown-is-drawn-as-it-is-written.md)  
**Decided by:** user request for Obsidian-grade Markdown editing with consistent IDE shortcuts.

Under [ADR 0002](0002-text-is-the-source-of-truth.md),
[ADR 0003](0003-the-language-server-owns-ssl.md),
[ADR 0007](0007-design-is-held-to-a-standard-that-serves-starlims-work.md), and
[ADR 0020](0020-the-shell-does-what-vs-code-does-and-stays-its-own.md).

## Context

- ADR 0024 drew Markdown Live Preview inside Monaco using CSS decorations and a line-based parser. Monaco is a fixed-line-grid code editor: it cannot replace multi-line Markdown tables, callouts, images, or frontmatter with live DOM widgets, nor can it measure variable-height prose or hide inline markers cleanly without wrap-width drift.
- Meanwhile, SSL, SQL, JSON, TOML, XML, diff review, and `starlims-lsp` depend deeply on Monaco (`src/view/lsp/session.ts`, `src/view/editor/Review.tsx`, TextMate/VS Code JSON themes).
- SSL Studio already projects specialized views (`BlocksView`, `PlanView`, `TableView`, `MarkdownView`) onto one `doc.model` (`ITextModel`).
- The user asked for Markdown editing to feel as close to Obsidian as possible while keeping IDE key commands, shortcuts, and menu actions consistent, with text-editing shortcuts superseding conflicting chrome shortcuts inside Markdown.

## Decision

- **Keep Monaco for code, LSP, diff review, and Markdown Source mode.** All 66 `starlims-lsp` bindings, TextMate highlighting, and Git/Tidy diffs remain untouched.
- **Use CodeMirror 6 (`@codemirror/*`, `@lezer/*`, MIT) for Markdown Live Preview.** `MarkdownLiveEditor` is a self-contained view projection synced 1:1 with `doc.model` using line/column ranges so plain text remains the single source of truth (ADR 0002) and CRLF/LF line endings are preserved.
- **Open Markdown in Live Preview by default.** Each Markdown tab keeps its `Source | Live | Read` switcher, and `Ctrl+E` toggles `Live` and `Read` (matching Obsidian). Turning off `livePreview` in Settings defaults to `Source`.
- **Full Obsidian Live Preview ergonomics:**
  - Token-level syntax reveal on headings, bold, italic, strikethrough, inline code, `==highlight==`, `[links](url)`, and `[[wikilinks]]`.
  - Block-level live widgets via a CodeMirror `StateField` for collapsed YAML frontmatter (paired with an interactive Properties bar), rendered GFM tables (click row to edit that line), Obsidian callouts (`> [!NOTE]`), horizontal rules, and inline images.
  - Real clickable task checkboxes (`- [ ]` / `- [x]`), clean bullet markers, clickable `#tag` pills (opening Search), heading/list folding, fenced code language headers with Copy, hover page preview popovers, and a collapsible `Linked from` backlinks footer.
  - Autocomplete for `[[note]]`, `[[note#heading]]`, `[[#heading]]`, `](path)`, and `> [!callout]`.
- **Unified shortcuts and menu parity, text editing first:**
  - All `Edit`, `Selection`, and `Go` menu actions (`Find`, `Replace`, `Undo`, `Redo`, `Move/Copy line`, `Add cursor above/below`, `Add next occurrence`, `Go to line`, `Comment`) route through `liveBridge.ts` into CodeMirror 6 so both engines behave identically.
  - Inside a Markdown text editor (`Live` or `Source`), text-editing shortcuts supersede conflicting non-editing chrome shortcuts: `Ctrl+B` toggles Bold (rather than toggling the sidebar), while `Ctrl+B` outside Markdown still toggles the sidebar.

| Shortcut | Scope | Action |
| --- | --- | --- |
| `Ctrl+B` | Markdown text | Toggle bold (`**`) |
| `Ctrl+B` | Everywhere else | Toggle side bar |
| `Ctrl+I` | Markdown text | Toggle italic (`*`) |
| `Ctrl+K` | Markdown text | Insert link |
| `Ctrl+L` | Markdown text | Toggle task checkbox |
| `Ctrl+E` | Markdown tab | Toggle Live and Read views |

## Consequences

- Markdown documents feel native to a modern notebook (Obsidian) while staying first-class citizens of the IDE's Git, Search, Document Outline, Health, Agent, and Save workflows.
- CodeMirror 6 (`@codemirror/*` and `@lezer/*`, all MIT) is added to `package.json`, `hutch.lock`, and `THIRD-PARTY-NOTICES.md`.
- Every Markdown editing primitive (`src/shared/markdownEdit.ts`) is pure TypeScript, unit-tested, and shared across both CodeMirror Live Preview and Monaco Source mode.
