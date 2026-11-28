# ADR 0037: A save formats its changed lines as a format of the document would

**Status:** Accepted
**Date:** 2026-11-26
**Decided by:** the user ("make format on save match format document").
How it is done is the agent's.

Under [ADR 0003](0003-the-language-server-owns-ssl.md).

## Context

- Format on save formats only the lines changed since the last save, so
  that a save does not rewrite code nobody touched.
- It asked the language server to format those ranges. The server's range
  format leaves out, on purpose, what it does to a whole document only:
  the letter case of built-in functions, and the blank lines between
  blocks.
- So a file saved "formatted" changed again under "Format document":
  `SqlExecute` became `SQLExecute`, and blank lines appeared round an
  `:IF` block.

## Decision

- **A save formats the whole document and takes the changed lines from the
  answer** (`formatRangesAsDocument`, `formattedParts`). The document is
  asked for as "Format document" asks for it, so the two cannot differ.
- **Lines that did not change are not touched,** whatever the formatter
  would do to them. The changed lines are still widened to their procedure
  first, as before.
- **A blank line the formatter adds beside the changed lines goes in with
  them:** the one between two procedures, or the one before a `:RETURN`.
  "Format document" then finds nothing left to do at those lines.
- **The edits are the small ones** (`smallEdits`): a line the
  formatter kept is changed only where it differs, so the cursor stays.
- **A script over 400,000 characters is asked for its ranges alone,** as
  before. Formatting all of it on every save would be felt.

## Consequences

- Each save of a script formats the whole of it once: about ten
  milliseconds for a script of ordinary size.
- On a very large script a save still leaves out the whole-document
  passes, and "Format document" may change those lines again.
- Where the formatter's text cannot be set beside the document's (the two
  differ in too many lines), the range format is used for that save.
- Since [ADR 0043](0043-format-selection-takes-its-lines-from-a-whole-format.md)
  "Format Selection" takes its lines the same way.
