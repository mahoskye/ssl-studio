# ADR 0032: Design precedents and interaction standards

**Status:** Accepted
**Date:** 2026-11-23
**Decided by:** the user (extending [ADR 0007](0007-design-is-held-to-a-standard-that-serves-starlims-work.md) and [ADR 0020](0020-the-shell-does-what-vs-code-does-and-stays-its-own.md)).

## Context

- SSL Studio brings together code editing, Markdown documentation, tabular registries, flowcharts, call graphs, Git, and an AI agent in one desktop IDE.
- Without explicit product precedents per surface, new dialogs, pickers, popovers, and sidebar labels drift into ad-hoc UI patterns (such as laying 10 long picker choices across a horizontal modal button bar, opening menus off the bottom edge of the screen, or mixing H1 titles with raw filenames in the same sidebar list).
- Establishing clear, extensible design precedents keeps every feature cohesive, predictable, and fast to learn without repeated course corrections.

## Decision

Each surface of SSL Studio follows a clear product precedent unless a STARLIMS-specific requirement justifies an explicit, documented exception:

| Surface | Precedent | Expected interaction pattern |
| --- | --- | --- |
| IDE shell & code | VS Code | Workbench layout, tabs, status bar, context menus, and dialogs |
| Dialogs & pickers | VS Code | Top-center searchable QuickPick for lists and files; compact modal only for confirmations |
| Keybindings | Sublime Text | Fast keyboard-first editing, multi-cursor, unobtrusive quick overlays |
| Markdown & notes | Obsidian | Seamless Live/Read/Source modes, Properties, wikilinks, embeds, slash commands |
| CSV registries | Excel / Sheets | Grid Enter-down/Tab-across, range selection, fill-down, inline pill pickers, grouping |
| Plans & graphs | Excalidraw / Miro | Direct canvas manipulation, clean context controls, non-overlapping drawers |

### Dialogs, menus, and pickers (VS Code standard)

- **Choosing from a list (tickets, files, docs, statuses, headings, registries, exports):** use a top-center searchable QuickPick (`quickPick()` in `src/view/dialogs.tsx`) with instant keyboard filtering, icons/file marks, status badges, quiet right-aligned paths/details, and `ArrowUp`/`ArrowDown`/`Enter`/`Escape`. Never render a multi-item picker as a horizontal row of modal buttons.
- **Picking workspace files (e.g., attaching a file to the Agent):** provide a searchable workspace file browser (folder drill-down with breadcrumbs when the query is empty, switching seamlessly to fuzzy workspace-wide search as soon as the user types).
- **Binary or destructive confirmations and single-line text prompts:** use a compact centered modal (`choose()` with at most 3 short actions, or `ask()`), with dangerous actions explicitly styled and never the default Enter choice (ADR 0009).
- **Dropdowns and context menus:** clamp inside the viewport on every edge, flip upward when opened near the bottom (such as the Agent `Prompts` menu) and flip left near the right edge, use section separators and smart submenus, and align keyboard shortcuts in a right column.

### Curated sidebar naming

- Curated navigation sections use one consistent naming convention across every row rather than mixing headings and raw filenames.
- In **Docs → Project**, every core file displays a clear human-friendly label paired with its quiet filename metadata:

| Friendly name | File | Role |
| --- | --- | --- |
| Project Overview | `README.md` | High-level project overview and orientation |
| Agent Instructions | `AGENTS.md` | Rules and instructions for coding agents |
| Project Settings | `project.toml` | Workspace folder and documentation configuration |
| Project State | `STATE.md` | Current project status and handoff summary |
| Deployment | `src/INDEX.md` | Code folder catalog |
| Tests | `tests/INDEX.md` | Test folder catalog |

## Consequences

- `AGENTS.md` links to this ADR and lists the design-precedent table so every contributor and agent applies these standards upfront.
- The precedent table is designed to grow as SSL Studio adds new surfaces (such as diff/merge tools, deployment runners, or STARLIMS Designer bridges).
