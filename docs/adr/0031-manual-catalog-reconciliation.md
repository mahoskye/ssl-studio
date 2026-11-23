# ADR 0031: Manual catalog (`INDEX.md`) reconciliation

**Status:** Accepted  
**Date:** 2026-11-22  
**Decided by:** user request to avoid noisy diffs and Git merge conflicts by making `INDEX.md` rewrites manual or agent-triggered while surfacing staleness clearly.

Updates [ADR 0012](0012-a-projects-work-is-written-down.md) and [ADR 0030](0030-ticket-bundle-folders-and-selective-docs-visibility.md).

## Context

- Folder catalogs (`INDEX.md`) summarize every document's title, status, and opening line (and registry completion counts).
- Silently rewriting `INDEX.md` on every file creation, status change, rename, move, trash, import, or manifest update produces constant churn across unrelated files and guarantees merge conflicts when two developers touch different tickets, specs, or scripts on parallel branches.
- At the same time, authors still want immediate visibility when an `INDEX.md` drifts from its folder so catalogs can be reconciled intentionally before a PR or milestone.

## Decision

- **No silent auto-rewrites:** Creating, renaming, moving, trashing, importing, or changing the status of documents or scripts never rewrites any `INDEX.md` automatically.
- **Clear out-of-sync indicators:**
  - `listDocs()` continues checking each existing catalog against its folder and marking `catalog.stale = true` whenever it drifts.
  - The **Docs** panel displays a compact out-of-sync bar whenever one or more catalogs are stale (in addition to per-row `out of date` badges), and **Health** continues listing stale/missing catalogs under **To fix**.
- **Explicit reconciliation triggers only:**
  - **Manual:** **Update catalogs** in the **Docs** out-of-sync bar, **Docs -> New…**, a catalog row's right-click menu, **Health**, or the Command Palette (`update-catalogs`), plus **Start folder catalogs** for optional folders.
  - **Agent:** A **Reconcile with Agent** trigger loads a structured prompt summarizing which catalogs are out of sync and what changed so the user or agent can review and trigger reconciliation intentionally.

| Trigger | Rewrites `INDEX.md`? |
| --- | --- |
| Create / rename / trash | No (marks stale) |
| Status change / import | No (marks stale) |
| Update catalogs | Yes (manual) |
| Reconcile with Agent | Yes (user-triggered) |

## Consequences

- Feature branches touch only the documents and code they actually edit, eliminating spurious `INDEX.md` Git merge conflicts.
- Drift is still impossible to miss because **Docs** and **Health** flag stale catalogs immediately after any workspace change.
