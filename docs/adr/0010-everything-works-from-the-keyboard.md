# ADR 0010: Everything works from the keyboard, and says what it is

**Status:** Accepted
**Date:** 2026-11-18
**Decided by:** the user asked for every recommendation of the 2026-11-18
review to be implemented (2026-11-18). This is the rule the keyboard, focus
and labelling fixes follow, drafted from the review.

Under [ADR 0007](0007-design-is-held-to-a-standard-that-serves-starlims-work.md).

## Context

- Lists, trees, editor tabs, Blocks, the call graph and the splitters worked
  with a mouse only.
- The plan chart bound Tab to "Add branch", so the keyboard could not leave
  it.
- Dialogs did not take the keyboard when they opened, did not keep it, and
  did not give it back.
- Icon buttons were named by a glyph, and selection and status were often
  shown by colour alone.

## Decision

- **Every action has a keyboard path.** A row, a tab, a block, a node, a
  splitter: each can be reached and used without a mouse. A gesture that
  needs a mouse (drag, right-click, hover) has a key or a menu that does the
  same.
- **Tab always moves on.** No view keeps Tab for itself. Inside a view, the
  arrow keys move.
- **A dialog owns the keyboard while it is open.** It takes focus, keeps Tab
  inside, closes on Escape, and gives focus back to where it was. The app's
  shortcuts wait.
- **Everything has a name.** A control that shows only an icon has a label a
  screen reader can read. Tabs, trees and toggles say their state.
- **Colour is never the only sign.** Selected, changed, near a limit, failed:
  each also has a mark, a word or a shape.
- **Focus can be seen,** in both themes, on every control.
- **Features have a visible way in.** An action that exists only in the
  command palette also has a menu entry or a button near what it acts on.

## Consequences

- One shared way to build a list or tree row, and one shared dialog, instead
  of one per panel.
- A new view is not done until it can be used with the keyboard alone.
- Not covered: the code editor itself, which is Monaco's and has its own
  keyboard and screen reader support.
