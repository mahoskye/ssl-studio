# ADR 0045: A format never changes what code says

**Status:** Accepted
**Date:** 2026-11-27
**Decided by:** the user, who asked for the defects of the second review of
the editor to be fixed. The rules below are the agent's; the user has not
reviewed them.

Under [ADR 0029](0029-prettier-and-sql-formatting-for-non-ssl-files.md),
which gave Markdown to Prettier and SQL to sql-formatter.

## Context

- "Format document" on Markdown leaves code blocks as written (its embedded
  formatting is off), but Prettier trims every line it prints. The spaces at
  the end of a code sample's lines went: a string in an SSL example lost
  three spaces, a diff's empty context line became empty.
- `.pks`, `.pkb` and `.pls` files are Oracle's, but were formatted in the
  dialect chosen in Settings, T-SQL by default. T-SQL's reader cut
  `v_due := SYSDATE` into `v_due: = SYSDATE` and `:nId` into `=: nId`, and the
  result was applied with no word.

## Decision

- **A code block in a Markdown document keeps the spaces at its lines'
  ends.** Where a block came out of the formatter the same but for those
  spaces, they are put back. A block it changed otherwise is left as printed.
  An indented code block (four spaces, no fence) is not looked at.
- **An Oracle package or PL/SQL script is formatted as Oracle's,** whatever
  dialect is chosen.
- **A format of SQL that would cut up an operator of two characters (`:=`,
  `=>`, `<>`, `!=`, `<=`, `>=`, `||`, `::`) or a name bound with a colon
  (`:nId`) is refused.** Nothing is changed, and the notice says which and
  that another dialect may be the file's.

## Consequences

- A format may change how code is laid out, never what it says, as far as
  these checks can tell.
- A `.sql` file written for Oracle in a T-SQL project is refused, not broken:
  choosing Oracle under SQL dialect formats it.
- sql-formatter lays out a PL/SQL package body poorly (a procedure's
  declarations run on one line), but what it prints is still the same code.
