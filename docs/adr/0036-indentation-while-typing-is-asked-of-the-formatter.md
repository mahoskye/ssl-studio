# ADR 0036: Indentation while typing is asked of the formatter

**Status:** Accepted
**Date:** 2026-11-26
**Decided by:** the user, asked where indentation on Enter should come
from: the formatter, or indentation rules added to the VS Code extension's
language configuration. The mechanism below is the agent's.

Under [ADR 0003](0003-the-language-server-owns-ssl.md).

## Context

- Enter after `:IF …;` left the new line where the `:IF` stood, and
  `:ENDIF;` stayed where it was typed. The editor had been given no way to
  know better.
- VS Code's way is a pair of patterns in a language configuration: lines
  after which the next goes in, and lines that come back out. The
  extension's configuration has none; it indents with its own block closer.
- Such patterns would be a second account of how SSL is indented, beside
  the formatter's. They cannot say what the formatter does with the cases
  of a `:BEGINCASE`, or how it lines up a statement that runs on, and they
  know nothing of the house style's tabs or spaces.
- The formatter answers the question as it stands. Given the text above a
  line, with a line of its own added at the foot, it puts that line where a
  line belongs there, in about ten milliseconds.

## Decision

- **The editor asks the formatter** (`src/shared/formatterIndent.ts`,
  `src/view/editor/sslIndent.ts`). No rule for indenting SSL is written in
  the app, and none is asked of the extension.
- **After Enter,** the text above the new line is formatted with a probe
  statement added below it. The probe's indentation is the new line's.
- **After a `;` that ends a line,** the text through that line is
  formatted, and the line takes the indentation the formatter gave it. This
  is what brings `:ENDIF;` and `:ELSE;` back out.
- **Only a line's leading spaces and tabs are changed.** The spacing within
  a statement is left to a save, or to "Format document".
- **Inside a string or a comment nothing is indented.** The formatter
  leaves such text as it finds it, the probe with it, and that is how the
  app knows.
- **An answer is used only if the text it was about is still there.** It
  comes a moment after the key. What was typed in that moment stays, and
  the cursor keeps its place in the text.
- **A setting turns it off** (Editor, "Indent as the formatter does").

## Consequences

- With the language server not running, a new line keeps the indentation
  of the line above, as before.
- The indentation arrives a moment after the key: about a frame or two on
  a script of ordinary size.
- Each Enter and each `;` is a request to the server, which formats the
  text up to that line. On a script of some five hundred lines that took
  thirty milliseconds.
- Nothing was changed in the VS Code extension. It has no indentation
  rules still, and its users are served by its block closer.
