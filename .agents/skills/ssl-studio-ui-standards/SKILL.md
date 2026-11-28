---
name: ssl-studio-ui-standards
description: UI design precedents, Solid 2.0.3 patterns, 27-theme WCAG AA contrast rules, Codicon usage, and panel accessibility standards for developing SSL Studio. Use when building or updating any view component, panel, menu, dialog, or CSS rule in src/view/.
---

# SSL Studio UI Standards

Use these rules whenever adding or modifying panels, editors, menus, dialogs, or stylesheets in `src/view/`.

## Design Precedents (ADR 0032 & ADR 0050)

Match the established surface precedent rather than inventing new chrome:

- **IDE chrome, panels, pickers, menus:** VS Code. Use top-center searchable QuickPick (`quickPick()`) for choosing from lists, statuses, tickets, or files. Reserve centered modals (`choose()` / `ask()`) for compact binary/destructive confirmations (ADR 0009) and single-line prompts.
- **Editing keybindings:** Sublime Text (`ADR 0034`). While a text editor holds focus, its editing keys run before shell shortcuts.
- **Markdown authoring:** Obsidian. Keep prose top-first; place metadata and inspectors in the shared right-hand Document panel.
- **CSV / TSV registries:** Excel / Google Sheets.
- **Plans & Call Graph:** Excalidraw / Miro.
- **Panel filters (ADR 0050):** Keep list filters out of sight until requested. Put categorical filters in a header funnel menu (`filter` / `filter-filled` icon, accented when active) and render a removable chip under the panel title only while a filter is active.

## Solid 2.0.3 Patterns

SSL Studio runs Solid 2.0.3. Follow these idioms to avoid runtime and type bugs:

- Context providers use `<MyContext value={...}>` (never `<MyContext.Provider>`).
- Non-keyed `<For each={list()}>` passes the item value directly (`(item, index) => ...`, where `index()` is an accessor). `<Show when={val()}>` callbacks receive an accessor (`(v) => v()`).
- Do not pass a single generic type argument to `createAsyncQuery`; annotate the async fetcher's return type instead.
- Use string `"false"` / `"true"` for enumerated HTML/ARIA attributes such as `spellcheck="false"` and `aria-pressed={on() ? "true" : "false"}`.

## Themes, Tokens & Contrast (27 Built-In Themes)

- Never hardcode hex colors for surfaces, borders, or text in `src/view/style.css` or inline styles. Use semantic tokens (`--bg`, `--surface`, `--surface-2`, `--border`, `--text`, `--text-muted`, `--accent`, `--ok`, `--warn`, `--err`) and `color-mix(in srgb, ...)`.
- Every tinted surface or badge must maintain **WCAG AA contrast (`>= 4.5:1`)** for text across all 27 built-in themes in `src/shared/themes.ts`. Verify new color pairs in unit tests with the theme palette helpers.
- Respect `prefers-reduced-motion: reduce` for any transition or animation.

## Icons & Panel CSS Hygiene

- All icons come from Codicons via `src/view/icons.ts` and `<Icon name="..." />`. Never embed raw Unicode geometric symbols (`●`, `＋`, `⟳`) as icons.
- Keep `ICON` keys in `src/view/icons.ts` sorted alphabetically and take exact codepoints from `node_modules/monaco-editor/esm/vs/base/common/codiconsLibrary.js`.
- Give each panel its own dedicated row and action classes (for example `.history-row` / `.history-row-acts`) instead of borrowing another panel's classes (such as `.git-row` / `.git-acts`), because hover-action positioning varies by row metadata width.
- Hover action toolbars on rows should sit cleanly over the right side on hover/focus-within (with an opaque matching row background) so they consume zero resting layout width and never cause horizontal overflow at narrow (`720px`) widths.
- Menus and popovers (`RowMenu.tsx` / `Menu.tsx`) must clamp inside the viewport and flip near window edges.

## Keyboard & Safety (ADR 0009 & ADR 0010)

- Every list, row action, scrubber, and header control must be reachable and operable from the keyboard with visible focus indicators and meaningful `aria-label` / `title` text.
- Never silently delete user data or history; confirm destructive actions via `choose()` and default bulk clears to preserving pinned/protected items.
