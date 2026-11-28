# ADR 0038: An SQL data source is shown and formatted as SQL

**Status:** Accepted
**Date:** 2026-11-26
**Decided by:** the user: what joins data sources and SQL is handled in
the application itself (2026-11-25), and SQL data sources were to be
handled next. The rule below is the agent's.

Under [ADR 0003](0003-the-language-server-owns-ssl.md) and
[ADR 0015](0015-what-is-not-ssl-is-read-here.md).

## Context

- A data source (`.ds`) is either SSL or SQL, and its name does not say
  which. One of SQL may open with a few SSL directives
  (`:PARAMETERS …;`, `:DSN := …;`) above its SQL.
- Every data source was opened as SSL. One of SQL had no SQL colours, and
  "Format document" did nothing to it.
- The language server tells the two apart, by rules that read SSL. Those
  rules are not the IDE's to write again. But the server says what it read:
  its lexical tokens are what it took for SSL, and of an SQL data source
  it reports none, or those of the directives alone.

## Decision

- **What stands below the last thing the server read as SSL is read as
  SQL by the IDE** (`src/shared/sqlDataSource.ts`). If it opens with an SQL
  statement, after SQL's own comments, the data source is SQL from there.
  The IDE reads SQL here and no SSL.
- **Without the server's word, only a file that is SQL from its first line
  is taken for SQL.** One with directives above its SQL is seen for what it
  is once the server has started.
- **An SQL data source is in the SQL language mode:** SQL's colours,
  comments and outline, and no blocks view. The mode follows the text: a
  data source is read again a moment after it is written in.
- **A mode chosen by hand stays** until another is chosen. "Auto Detect"
  in the language picker goes back to the mode the text has.
- **The server is still told of it.** It checks what is its own to check
  in an SQL data source (its parameters, a misplaced `;`), and those
  findings are kept.
- **"Format document" formats its SQL as SQL** and leaves what stands
  above it as it is. The directives are SSL, and no SQL formatter is given
  them.

## Consequences

- A data source with directives above its SQL opens as SSL and turns to
  SQL a moment later, when the server has answered.
- In the SQL mode the directives are coloured as SQL would colour them,
  and the outline lists them as statements. The whole file has one mode.
- SQL written with SQLExecute's `?name?` markers does not format: the SQL
  formatter cannot read them, and says so. The server reports the same
  markers as wrong in an SQL data source.
- Format on save does not format an SQL data source, as it does not
  format an `.sql` file.
