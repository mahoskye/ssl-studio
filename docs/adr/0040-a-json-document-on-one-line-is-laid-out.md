# ADR 0040: A JSON document on one line is laid out when it is formatted

**Status:** Accepted
**Date:** 2026-11-26
**Decided by:** the user, who asked for this defect of the editor's review
to be fixed ("JSON on one line stays on one line"). The rule below, and
where it stops, are the agent's; the user has not reviewed them.

Under [ADR 0029](0029-prettier-and-sql-formatting-for-non-ssl-files.md),
which gave JSON to Prettier.

## Context

- "Format document" first laid JSON out with a formatter of the app's own
  (`formatJson`), a value to a line. ADR 0029 gave JSON to Prettier, with
  the other files that are not SSL.
- Prettier keeps an object on one line where it fits the line's width,
  unless its first key was written on a line under the `{`. That is how it
  lets an author keep a short row short.
- A payload that came as one line has no such line break anywhere. Short
  enough to fit, it stayed on its line with spaces put in. Longer, its
  outer object was opened and the ones inside it were not.
- A developer who formats a line of JSON wants to read it: in VS Code the
  same command lays the whole of it out.

## Decision

- **A JSON document that stands on one line is laid out,** a property to a
  line at every depth. A line's end after the document does not make it
  two lines.
- **It is still Prettier that lays it out.** The document is handed over
  with a line break after each `{` that opens an object with something in
  it (`jsonOpenedOut`, `src/shared/jsonFormat.ts`), which is the one sign
  Prettier reads. Nothing else is added, and a `{` in a string is text.
- **A list is left to Prettier,** as in every other JSON document: a short
  list of numbers or names stays on its line, and a list of objects is a
  line to each brace.
- **A document that has lines keeps the layout it has.** A row its author
  kept on one line stays on it. Formatting the laid-out document again
  changes nothing.
- **Only a whole document is laid out so.** A JSON code block in a
  Markdown document is an example its author wrote: on one line it stays
  on one line, under "Format code block" and "Format document" both.

## Consequences

- The app's own `formatJson` would have opened every list too, a number
  to a line, and Prettier would have closed the short ones at the next
  format. One formatter, so that a second format is not a second change.
- Only a document that is JSON is opened. One line with a comment in it,
  or a comma too many (`.jsonc`), is left as Prettier leaves it, and one
  that cannot be read gets Prettier's own words about where.
- A document of two lines that somebody joined by hand is not one line,
  and is left to Prettier.
- A plan (`.plan.json`) keeps its own layout, as before.
- This rests on how Prettier reads a line break after a `{`, which its
  documentation gives as its rule for objects. Should that change, the
  tests that ask Prettier itself fail (`test/jsonOneLine.test.ts`).
- Format on save is for SSL alone, so a save lays out no JSON.
