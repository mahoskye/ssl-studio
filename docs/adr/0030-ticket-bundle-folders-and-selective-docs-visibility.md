# ADR 0030: Ticket bundle folders and selective Docs visibility

**Status:** Accepted  
**Date:** 2026-11-22  
**Decided by:** user request to support per-ticket folders holding reference documents, existing code samples, and fixtures without cluttering the Docs panel.

Adds to [ADR 0012](0012-a-projects-work-is-written-down.md) and
[ADR 0013](0013-the-agent-is-told-the-work-a-question-is-for.md). Under
[ADR 0002](0002-text-is-the-source-of-truth.md) and
[ADR 0017](0017-documents-link-to-each-other-and-the-links-are-kept-true.md).

## Context

- A typical STARLIMS project starts from a parent project or epic (often captured in `README.md`) and breaks into tickets, where each ticket accumulates its own local reference documents, existing code samples, sample payloads, screenshots, and test fixtures.
- Under ADR 0012, `listDocs()` scanned `docs/tickets/` recursively and treated every Markdown file inside it as a separate ticket while ignoring non-Markdown files. Creating a ticket folder `docs/tickets/LIMS-123/` with supporting notes turned every note into a fake top-level ticket in **Work**, and hid the ticket's code samples and fixtures from the ticket view.
- At the same time, the **Docs** panel should stay a curated, scannable map of working documents (work hierarchy, knowledge base, registries, schema) rather than mirroring every raw artifact in the file tree.

## Decision

- **A ticket may be a flat file or a self-contained bundle folder:**
  - Flat file (unchanged): `docs/tickets/LIMS-123.md`.
  - Bundle folder: `docs/tickets/LIMS-123/LIMS-123.md` (or `ticket.md` / `README.md`, or a lone Markdown file declaring `ticket:`) with any companion reference docs, code samples, and fixtures alongside it (`docs/tickets/LIMS-123/**`).
  - Sibling folder: a flat `docs/tickets/LIMS-123.md` paired with a matching `docs/tickets/LIMS-123/` folder attaches that folder's files to `LIMS-123` rather than spawning fake tickets.
- **Selective visibility in the Docs panel:**
  - **Docs -> Work** lists only the primary ticket, its plans, its specs, and its child tickets. Companion files inside `docs/tickets/<KEY>/` never appear as separate tickets or clutter the sidebar, nor do they appear in `docs/tickets/INDEX.md` or `registries/files.csv`.
  - Opening the ticket shows a single compact **Ticket files** row inside **The work for `<KEY>`** displaying the folder path and total companion file count; clicking it opens **Explorer** focused directly on `docs/tickets/<KEY>/` (with an **All files** back button to return to the full workspace tree), so tickets with hundreds of samples and fixtures stay clean and browse lazily.
  - Opening any companion Markdown note inside `docs/tickets/<KEY>/` automatically shows its parent ticket under **Linked tickets** (`in ticket folder`) with no extra YAML required.
- **Seamless lifecycle and agent awareness:**
  - **New ticket** lets the author choose between a **Ticket folder** (`docs/tickets/<KEY>/<KEY>.md`) and a **Single file** (`docs/tickets/<KEY>.md`).
  - Any flat ticket can be promoted into a ticket folder in one click (**Folder** in the ticket header or **Create ticket folder…** in Docs), updating open tabs, `docs/tickets/INDEX.md`, and relative links (ADR 0017).
  - **Import tickets** locates existing bundled tickets by key and updates them in place instead of creating duplicate flat files.
  - `workText()` lists the ticket folder's companion file paths for the Agent so it knows what samples and fixtures exist without flooding its context.

| Layout | Primary ticket | Companion files |
| --- | --- | --- |
| Flat | `tickets/LIMS-1.md` | None (one-click promote to folder) |
| Bundle folder | `tickets/LIMS-1/LIMS-1.md` | Everything else in `tickets/LIMS-1/**` |
| Flat + folder | `tickets/LIMS-1.md` | Everything in `tickets/LIMS-1/**` |

## Consequences

- Each ticket can keep all of its local evidence, samples, and fixtures together in one folder under `docs/tickets/` while keeping **Docs -> Work** focused on active tickets, plans, and specs.
- Existing flat-ticket projects continue working identically with zero migration required.
- Anything that graduates into project-wide truth (schemas, decisions, registries, tests) still lives in `schema/`, `docs/knowledge/`, `docs/registries/`, and `tests/`.
