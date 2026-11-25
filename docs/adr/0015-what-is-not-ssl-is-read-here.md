# ADR 0015: What is not SSL is read here

**Status:** Accepted
**Date:** 2026-11-19
**Decided by:** the user asked for TOML, Markdown, SQL, JSON and other
documents to be handled, and for documents to be easier to read and work with
(2026-11-18). Where that stops, against ADR 0003, is drafted here from the
work; the user has not reviewed it point by point.

Under [ADR 0003](0003-the-language-server-owns-ssl.md) and
[ADR 0002](0002-text-is-the-source-of-truth.md). Adds to
[ADR 0012](0012-a-projects-work-is-written-down.md).

## Context

- ADR 0003 says the IDE writes no SSL parser, tokenizer, formatter or rule.
  It says nothing of the other files a project holds: its settings, its
  documents, its schema, its registries.
- Those files have to be coloured, outlined, checked and laid out by
  something. The language server reads SSL; it does not read a project's
  Markdown or its `project.toml`.
- Without a line drawn, each new convenience is a fresh argument about
  whether it is "a parser in the IDE".

## Decision

- **The IDE reads what is not SSL.** Markdown, TOML, INI, JSON, YAML, CSV
  and SQL files are read in the IDE, by small readers of its own or the
  runtime's: to colour them, to outline them, to say where one cannot be
  read, to lay JSON out, to show a CSV as a table.
- **It reads no SSL, and nothing inside SSL.** A `.ssl`, `.srvscr` or `.ds`
  file is the language server's, whole: its outline, its findings, its
  formatting. That includes the SQL in an SSL string, which is part of the
  script.
- **A search for a name is not a reading.** Looking for a registry row's
  name in the project's files, as a whole word, says only that the name
  appears. It is run over every kind of file alike and concludes nothing
  about what a script does with it.
- **What needs a script's meaning is asked of the server.** Which tables a
  script uses, whether a setting is read or only mentioned, what a
  procedure calls: these are requests on `starlims-lsp`
  ([LSP-REQUESTS.md](../LSP-REQUESTS.md)), not something to work out here.
- **A reader here is for finding one's way, not for judging.** An outline
  lists a SQL file's statements by their first words; it does not say a
  statement is valid. The checks say where a JSON or TOML document stops
  being readable, with the runtime's own reader for TOML; they hold no
  rules of style.
- **Laying out changes space only.** A formatter here writes every value
  as it was (ADR 0002).

## Consequences

- A project's documents work with no language server running.
- A registry can be checked one way only: is this row's name anywhere. The
  other way, a table a script uses that no row lists, waits on the server.
- A `.sql` file's outline and a SQL string's handling in SSL come from two
  places, and may name the same statement differently.
- The readers here are small and partial on purpose. One that grows rules
  of its own has become a second language server, and should stop.
