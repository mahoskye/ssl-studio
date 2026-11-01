# ADR 0003: The language server owns all SSL knowledge

**Status:** Accepted
**Date:** 2026-10-31
**Program decision:** [0007](../../../starlims-program/decisions/0007-ssl-studio-is-a-client.md)

## Context

- `starlims-lsp` already parses SSL as STARLIMS 12 does, formats it, knows
  the built-ins, and carries the style guide's rules.
- A second parser in the IDE would drift from it, and the blocks view would
  then disagree with the diagnostics about what the code is.

## Decision

- The IDE writes no SSL parser, tokenizer, formatter or rule. Highlighting
  uses the formatter extension's published TextMate grammar; everything else
  comes from the language server.
- The IDE pins one `starlims-lsp` release and checks it at start.
- What the IDE needs and the server lacks (a syntax tree, a call graph) is
  asked for on `starlims-lsp` as custom requests. The server owns their
  design. See [LSP-REQUESTS.md](../LSP-REQUESTS.md).

## Consequences

- Blocks mode waits on the syntax tree request (roadmap M3).
- Fixes to SSL behaviour land once, in the server, for every client.
