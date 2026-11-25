# ADR 0033: Single definition of Specs and companion `.plan.md` Plan docs

**Status:** Accepted
**Date:** 2026-11-23
**Decided by:** user direction — establish one clear definition of a Spec (`docs/specs/`) for behavior and design specifics, and pair each flowchart plan (`design/<Name>.plan.json`) with a companion `<Name>.plan.md` Plan doc for broken-down implementation steps.

Refines [ADR 0005](0005-a-plan-is-a-document-of-its-own.md) and supersedes the dual-location spec clause in [ADR 0012](0012-a-projects-work-is-written-down.md).

## Context

- Under ADR 0012, the word **Spec** stood for two distinct artifacts in two different folders:
  - Author-written behavior/design specs in `docs/specs/*.md`.
  - Technical implementation breakdowns generated beside flowcharts in `design/<Name>.spec.md`.
- That overlap forced `docs/specs/INDEX.md` to reach across into `design/`, listed plan companions as sibling `spec` rows beside `plan` rows in `Docs → Work`, and blurred the boundary between *what the behavior/design must be* and *how a specific plan breaks down the implementation steps*.
- ADR 0012 explicitly left reconciling `design/*.spec.md` as an open decision for ADR 0005 to revisit.

## Decision

Establish three distinct, non-overlapping work documents:

| Document | Folder | Role |
| --- | --- | --- |
| Ticket | `docs/tickets/` | Business request, acceptance checklist, status, and release |
| Spec | `docs/specs/` | Behavior and design specifics, contracts, and checks |
| Plan + Plan doc | `design/` | Flowchart (`.plan.json`) and step breakdown (`.plan.md`) |

- **One Spec definition:** Every Spec lives in `docs/specs/` and captures behavior and design specifics for one or more tickets (`ticket:` / `tickets:` in frontmatter, or `specs:` on the ticket).
- **Companion Plan docs (`design/<Name>.plan.md`):** The written breakdown paired with `design/<Name>.plan.json` (procedures, units, node map, transactions, test plan, and `<!-- plan <hash> -->`) uses the `.plan.md` extension, belongs to the `plans` group, and is never mixed into `docs/specs/` or `docs/specs/INDEX.md`.
- **Clean break (no legacy `.spec.md` fallback):** Plan tooling (`PlanAssistant`, `plan/run.ts`, `plan/check.ts`, `plan/buildRun.ts`), `project.ts`, `workList.ts`, `workContext.ts`, `Git.tsx`, and `fileIcon.ts` target `.plan.md` exclusively.
- **Plan Assistant terminology:** Stage 3 is named **Plan doc** (`Write plan doc` / `Open the plan doc` / `Approve the plan doc`).
- **Work tree hierarchy:** In `Docs → Work`, a companion `.plan.md` nests as a collapsible child row directly under its parent `.plan.json` (`plan doc`), visually separating plan breakdowns from `docs/specs/` specs (`spec`).
- **Full traceability preserved:** Companion `.plan.md` files still inherit their paired plan's ticket and code references, feed into Agent work context (`PLAN DOC ...`), appear under `Plans` in Document `Info`, trigger Git pre-commit staleness warnings when a `.plan.json` is staged without its `.plan.md`, and link transitively in `docsGoverningFile` and `docLinkedTickets`.

## Consequences

- Each folder and document name now has one unambiguous meaning: Tickets describe *what and why*, Specs describe *behavior and design specifics*, and Plans (`.plan.json` + `.plan.md`) describe *the broken-down implementation steps*.
- `docs/specs/INDEX.md` stays self-contained inside `docs/specs/`.
- Existing projects that still have `design/*.spec.md` files simply rename them to `design/*.plan.md` and update any ticket frontmatter from `specs:` to `plans:` referencing the `.plan.json`.
