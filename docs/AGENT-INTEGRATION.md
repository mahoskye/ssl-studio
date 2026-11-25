# Agent integration (running document)

**Status:** Living design and tracking document (started 2026-11-21).
**Scope:** How agents integrate across SSL Studio's flowchart, Assistant tab, code generation, review, and test workflows.

Agent execution for targeted builds is intentionally deferred until the chart, status language, and test surfaces settle. Placeholder build triggers are wired in the UI now so every entry point can be evaluated in context before turning on live agent runs (per `AGENTS.md`, no model is invoked automatically).

## Code status indicator

Every step and decision on the flowchart carries a five-state code indicator combining stoplight colours with grey and blue. State never relies on colour alone: each node also carries accessible status text, tooltip details, a legend entry, and a named status badge in the Selected step inspector (ADR 0007, ADR 0010).

| Colour | State | Meaning |
| --- | --- | --- |
| Grey | Not built | Newly added step or decision with no linked code yet. |
| Blue | Building | Agent build, refinement, or pending review is active or queued for this step. |
| Green | Built | Linked code exists, matches the chart, and has no warnings or errors. |
| Yellow | Needs rebuild | Step changed since the last build, has drift warnings, or has chart warnings. |
| Red | Needs attention | Implementing procedure is missing, build is stuck, or node has a blocking error. |

### Indicator rules

- **New nodes start Grey:** Adding a step or decision to an already-built chart marks it Grey (`Not built`), not Yellow (`Changed`), so analysts can immediately distinguish new unbuilt work from edits to existing built steps.
- **Built and clean is Green:** Steps and decisions linked to a built procedure with no drift or local edits show Green.
- **Edits and drift turn Yellow:** Changing a built step's text, notes, kind, or outgoing paths turns its dot Yellow until rebuilt. Chart-to-code drift warnings also surface as Yellow.
- **Missing code or stuck builds turn Red:** If an implementing procedure is deleted or renamed away (`gone`), a build unit gets stuck, or a blocking finding lands on the node, its dot turns Red.
- **In-flight agent work is Blue:** Active or queued build units and agent-suggested pending nodes show Blue.

## Build trigger entry points

Users think about building from different places depending on whether they are scanning the whole flow, triaging health findings, or editing a single step. Each surface exposes a build trigger; until the agent pass lands, these triggers act as non-destructive placeholders that open the Assistant tab with a scheduled notice and never spend tokens.

| Surface | Trigger | Scope | Status |
| --- | --- | --- | --- |
| Assistant tab | New build action | Whole plan / delta | Placeholder; wired later |
| Node right-click | Build / rebuild | Single step | Placeholder menu item |
| Stage right-click | Build stage | Steps in stage | Placeholder menu item |
| Canvas right-click | Trigger new build | Whole plan | Placeholder menu item |
| Clean indicator | Status pill menu | Whole plan / check | Placeholder in menu |
| Chart `•••` menu | Trigger new build | Whole plan | Placeholder menu item |
| Selected step | Build step button | Single step | Placeholder button |
| Plan inspector | Build plan button | Whole plan | Placeholder button |

### Scheduled trigger behaviour (current pass)

- Clicking any scheduled build trigger shows a calm notice naming the requested scope (plan, stage, or step), switches Palette to the **Assistant** tab, and highlights the Build card.
- No opencode session is created and no model is called by placeholder triggers.
- Existing planning-mode actions (`Refine`, `Write spec`, `Build`, `Rebuild what changed`, `Write the test script`) remain available inside the Assistant tab for the recorded-fake self-test (`selftestCycle`).

## Assistant tab design

The Assistant tab in Palette is the single home for agent collaboration on a plan. Rather than a flat list of headings, it is organized into five clear cards so status and next actions are visible at a glance:

1. **Workflow header & primary actions:** Four-step status strip (`Spec`, `Build`, `Code`, `Tests`), primary build trigger, secondary `Refine` and `Write spec` buttons, and a compact model/cost line.
2. **Needs your input:** Open agent questions (with suggested answer chips and node jump links) and pending chart suggestions (`Accept all`, `Accept`, `Decline`), plus a collapsible history of answered decisions. Collapses cleanly when nothing awaits input.
3. **Build & code sync:** Five-colour node status breakdown (`Green`, `Yellow`, `Red`, `Blue`, `Grey`) with clickable jump chips, changes since the last build, live build-run progress and review actions when active, and the `Chart and code` drift report with `Refresh`.
4. **Tests & scenarios:** Always visible even before code is built. Shows total flowchart paths, interactive path walkthrough controls that light up the chart, linked test script status, and the test-script action.
5. **Spec document:** Compact status card (`Approved`, `Out of date`, or `Not written`) with quick open and rewrite links.

## Flowchart-first testing

The flowchart defines the largest, cleanest grouping of test cases for a STARLIMS process: every path from Start through the decisions to an End is an end-to-end scenario. Viewing tests from both the chart and each selected step helps analysts and developers see what scenarios exercise a step and which neighbouring steps are tested alongside it.

### Implemented now (from the chart, no model required)

- **Plain-English business test cases (`plan.tests`):** Analysts and developers can add, edit, and remove plain-English test cases (scenario, optional starting setup, and expected outcome) directly on any selected step, in the Plan inspector, or in the Assistant tab. Each edit is an undoable JSON text edit on `.plan.json` and feeds directly into generated STARLIMS test prompts.
- **Selected step `Tests` section:** Collapsible section inside `Selected step` and `Selected decision` showing custom step test cases (`+ Add test`), how many end-to-end flowchart journeys pass through that step (named by their key milestone actions rather than raw `yes`/`no` chains), decision branch splits, click-to-highlight chart preview, and the neighbouring steps tested alongside it.
- **Plan `Tests` section:** Collapsible summary in the Plan inspector showing all business test cases across the plan (`+ Add test` with optional step link), a one-click `Walk journeys on chart` bar, and a direct link to the generated STARLIMS test script if one exists.
- **Canvas journey walkthrough bar:** When any journey is highlighted (from Selected step, Plan, Assistant, or the `•••` menu), a compact floating bar at the top of the chart shows `Journey #N of M`, the milestone summary, Previous/Next stepping, and a Clear button.

### Scheduled for the agent pass

- **Targeted STARLIMS test updates:** When a step, decision, or custom business test case changes, ask the agent to add or update only the affected test procedures in `<Plan>Tests.ssl` rather than rewriting the whole test file.
- **Manual STARLIMS run notes:** Since SSL runs inside STARLIMS, allow recording which journeys and business test cases were last verified in STARLIMS and flagging stale cases when a step turns Yellow.

## Open questions for the agent pass

- **Single-step build scope:** When triggering a build from a single Grey or Yellow step, should the agent edit the owning procedure directly, or refresh the spec first and confirm the diff?
- **Stage-level builds:** Should building a stage generate/update only procedures mapped to nodes in that stage while leaving neighbouring stages untouched?
- **Spec gate vs quick build:** Should `Trigger new build` automatically run a lightweight spec update when the chart has minor edits, or always stop for spec approval first?
- **Model selection & budget:** Keep local models as default for `Refine` and drafts (per `AGENTS.md`), and require explicit confirmation with an estimated unit count before running a paid model on a multi-unit build.
- **Review granularity:** Support accepting or rejecting changes per step/procedure inside `openReview` when multiple steps are rebuilt together.

## Related documents

- [Planning mode](PLANNING-MODE.md) — original five-stage planning architecture and file format.
- [Roadmap](ROADMAP.md) — overall project milestones and on-hold explorations.
- [ADR 0004](adr/0004-opencode-through-its-service-api.md) — opencode service boundary and tool restrictions.
- [ADR 0005](adr/0005-a-plan-is-a-document-of-its-own.md) — plan document model and code-as-source-of-truth rule.
- [ADR 0013](adr/0013-the-agent-is-told-the-work-a-question-is-for.md) — ticket context passed to agent turns.
