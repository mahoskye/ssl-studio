# ADR 0005: A plan is a document of its own; the code stays the source of truth

**Status:** Accepted
**Date:** 2026-11-03
**Decided by:** the user asked for a planning mode, then accepted the design in
[PLANNING-MODE.md](../PLANNING-MODE.md) with its four recommendations
(2026-11-03).

## Context

- The user wants to design a process or script as a flow chart and have an agent
  build it.
- ADR 0002 makes every visual mode a projection of the code. A chart of code that
  does not exist yet cannot be one.
- ADR 0003 keeps SSL knowledge out of the IDE, so a chart cannot print code.
- ADR 0004's agent has no file tools, and works from what the IDE gives it.

## Decision

- A plan is a text file, `design/<name>.plan.json`, kept with the project and
  reviewed like code. Its chart is a projection of *that* text: chart edits are
  text edits, one undo history covers both, and the Text and Chart views switch
  freely. ADR 0002's rule applies to the plan as it does to a script.
- Plans are in plain words. No SSL is written or parsed for them. Only the agent
  writes code, and only the language server judges it.
- Once built, the code is the source of truth. A chart never regenerates a file,
  and differences between chart and code are reported, not repaired.
- The chart is laid out automatically and stores no positions, so diffs stay
  small. Dragging can be added later without breaking files.
- A build runs unattended and writes nothing: results collect in a pending change
  set, and the user reviews them once, file by file. Accepting is an undoable edit.
- The planning instructions belong in a skill in the style guide (`ssl-plan`), not
  in a second copy in SSL Studio's prompts.

## Consequences

- A plan stays useful with no model at all: P1 ships the chart and its check alone.
- A plan and its code can disagree. That is reported, and the code may well be right.
- The agent stages depend on a style guide change, tracked as an issue on that
  repository when P2 is scheduled.
