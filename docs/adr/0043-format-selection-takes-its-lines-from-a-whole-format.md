# ADR 0043: Format Selection takes its lines from a format of the whole document

**Status:** Accepted
**Date:** 2026-11-27
**Decided by:** the user, who asked for the defects of the second review of
the editor to be fixed. The rule below is the agent's; the user has not
reviewed it.

Under [ADR 0037](0037-a-save-formats-its-lines-as-a-format-of-the-document-would.md),
which made a save take its changed lines from a format of the whole document.

## Context

- "Format Selection" (Ctrl+K Ctrl+F) on SSL asked the language server for a
  range format of the selection. The server indents what it is given from
  its first line: two lines inside an `:IF`, the first at the wrong depth,
  both came back at that depth, the right one taken out of its block.
- A range format also leaves out what the server does to a whole document
  only (ADR 0037), so a selection formatted on its own could change again
  under "Format document".
- For every other language only a whole-document formatter was registered.
  The editor's action could not run, and nothing said so.

## Decision

- **The selected lines are left as "Format document" would leave them.** The
  whole document is formatted, by the language server for SSL and by the
  app's formatters for the rest, and the selected lines are taken from the
  answer as the smallest edits that make the change. Nothing outside them
  changes.
- **A line the selection ends at the very start of is not taken in,** as in
  VS Code. An empty selection is its own line.
- **Where the whole cannot be had,** an SSL script over 400,000 characters or
  an answer that cannot be set beside the text, SSL falls back to the
  server's range format, as before; another language changes nothing.

## Consequences

- One rule for the two ways of formatting part of a script: a save and a
  selection give the lines the same text.
- A selection costs a format of the whole document: a few tenths of a second
  for a script of the largest size that is formatted so.
- The server's range format is still used for the largest scripts. Its
  keeping of a selection's base indentation from the first line is what its
  own specification asks of a range format (formatting, A2: "the block's
  base indentation is preserved"), so it is not a defect of the server's.

**Corrected on 2026-11-27:** the last point said the server's behaviour was
a defect, to be reported to starlims-lsp. Its specification calls it
intended; the app taking the lines from a whole-document format is the fix.
