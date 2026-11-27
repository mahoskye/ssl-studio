# ADR 0050: A filter is out of sight until it is asked for

**Status:** Accepted
**Date:** 2026-11-27
**Decided by:** the user: "I would prefer all such filters be visible only
after selecting and setting from a menu. so if the box is empty and not
active it is hidden. this goes for all areas of the app unless those
sections are specifically for that purpose." Where the menu entries go, and
which lists count as being for that purpose, are the agent's choices; the
user has not reviewed them.

Under [ADR 0032](0032-design-precedents-and-interaction-standards.md): the
shell follows VS Code, whose trees show their find box only when it is
asked for.

## Context

- An empty filter box sat at the top of most lists: the Explorer's Outline,
  the Document panel's Outline, Docs, Health, the table view, the Markdown
  inspector's list of uses. A box nobody is typing in takes a row and draws
  the eye.
- Docs and Health also had rows of filter pills (All, Active, This ticket,
  Issues; All, Active ticket, Warnings) always on show, and Docs a release
  list.
- The plan and the call graph had a "Find a step" or "Find a procedure" box
  always in their bar, where the title was cut short for room.

## Decision

- **A list's text filter is drawn only when asked for, or while it holds
  text.** It is asked for from the list's own menu ("Filter…", or "Filter by
  Text…" beside other filters), and by Ctrl+F (Cmd+F) while the keyboard is
  in the list. It opens with the keyboard in it.
- **An empty box goes again** when the keyboard leaves it, or on Escape,
  which then moves the keyboard to the list. Escape in a box with text
  empties it first. While it holds text it stays, so what is hiding rows is
  always in sight.
- **Other filters are checked items in a filter menu.** A funnel button in
  the panel's title opens it; the funnel is filled, and in the accent, while
  any filter is on. A filter that is on, other than the text, is shown under
  the title as a chip that names it; a click on the chip turns it off. The
  menu also has "Clear Filters" while any is on.
- Where this applies:

  | Where | Asked for from | Note |
  | --- | --- | --- |
  | Explorer Outline | Its ⋯ menu | Opens the section first |
  | Document panel | Its ⋯ menu | Outline and Procedures |
  | Docs | Filter menu | State and release are items |
  | Health | Filter menu | Ticket and warnings are items |
  | Table view | Its ⋯ menu | Ctrl+F there stays Find |
  | Uses list | A funnel button | In the Markdown inspector |
  | Plan, call graph | A search button | Ctrl+F as before |

- **Not changed, being for that purpose:** the Search panel, the Reference
  panel (a lookup list, used through its box), the search in Settings, the
  pickers (quick open, symbols, the palette), a table column's filter
  pop-up, and the find bars, which already open only when asked.

## Consequences

- The Docs panel no longer shows how many documents have issues on a pill.
  The number is in its filter menu ("With issues (2)"), each such row still
  carries its warning, and the Health button in the activity bar carries the
  count of document warnings (ADR 0032).
- Opening the Document panel puts the keyboard on its list, not in a filter.
- A filter left on is easier to forget when its box is gone; the chip, the
  filled funnel and a box that stays while it holds text are there for that.
