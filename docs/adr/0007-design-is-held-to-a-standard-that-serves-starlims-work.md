# ADR 0007: Design is held to a standard, and the standard serves STARLIMS work

**Status:** Accepted
**Date:** 2026-11-17
**Decided by:** the user asked for an overarching rule: excellent and
beautiful design standards, enforced, all in support of the project's core
aim, developing functionality for STARLIMS (2026-11-17). The practices under
"In practice" were drafted from that and are the user's to change.

## Context

- SSL Studio exists so that people can develop functionality for STARLIMS.
  Everything else in it is there for that.
- The first table in the demo project's docs rendered with words broken in
  the middle ("ROUTI / NE"). Nothing in the project said that was a defect, or
  how good a view or a document has to be before it is done.
- The IDE shows things (editor, blocks, graph, charts, rendered documents) and
  it writes things (project templates, specs, test scripts). Both are read by
  the person doing the STARLIMS work.

## Decision

- Design in SSL Studio is held to a standard: it is excellent and it is
  beautiful, and both are judged by one question. Does this help someone
  develop functionality for STARLIMS?
- The standard is enforced, not hoped for. A design defect is a defect, ranked
  with functional ones.
- The standard covers what the IDE shows, what the IDE writes, and the
  documentation of this repository and of the projects made with it.
- A more specific design rule is recorded as its own ADR under this one. The
  first is [ADR 0008](0008-a-table-in-documentation-has-at-most-four-columns.md).

## In practice

- **Legible first.** Nothing clips, overlaps, or breaks inside a word. A view
  is checked at the narrowest layout the app allows as well as a wide one, and
  in the light and the dark theme.
- **The work gets the room.** Code and documents get the space and the
  contrast; the frame around them stays quiet.
- **One system.** Colours come from the theme's variables, and type, spacing
  and corners from the scales at the top of `style.css` (`--text-*`,
  `--space-*`, `--radius-*`, there since 2026-11-18; before that the sheet had
  literal values and no scale). A new value needs a reason.
- **Nothing for show.** Beauty here is order, proportion and restraint. A
  flourish that does not help the reader is left out, and so is a design change
  that does not help the STARLIMS work.
- **What the IDE writes counts.** A generated README, spec or test script
  meets the same standard as a screen.

## How it is enforced

- A change that can be seen is looked at in the running app before it is called
  done, and what was looked at is said: which layout, which theme.
- A rule a machine can check gets a test, so it cannot quietly lapse:
  `test/docTables.test.ts` (tables), `test/contrast.test.ts` (both themes
  against WCAG contrast), `test/examples.test.ts` (the demo project against
  the pinned language server).
- A rule a machine cannot check is written down specifically enough for a
  reviewer to say yes or no.

## Consequences

- Some work will take longer, because "it works" no longer finishes it.
- Design rules will accumulate. Each is its own ADR, numbered, and superseded
  rather than rewritten.
- Existing views and documents were not made under this rule. They are brought
  up to it when they are next changed, not in one pass.
