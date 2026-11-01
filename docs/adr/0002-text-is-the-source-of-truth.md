# ADR 0002: Text is the source of truth; visual modes are projections

**Status:** Accepted
**Date:** 2026-10-31
**Decided by:** the user chose structured blocks first and a graph later,
switchable with text (2026-10-31).

## Context

- SSL lives in STARLIMS as text, is reviewed as text, and is pasted into
  Designer as text. Comments, blank lines and the team's layout carry meaning
  that a tree does not hold.
- A visual editor that stores its own model and prints code from it loses
  what it does not model, and makes every switch between modes a risk.

## Decision

- The file's text is the only document. Blocks and graph views are built from
  the language server's syntax tree over that text.
- Every visual edit is a text edit on the ranges it touches, then a range
  format of those ranges. No view reprints a whole file.
- A span the parser cannot read is shown as a raw text block and stays
  editable.
- One undo history covers both modes.
- Visual-only state (region colours, collapsed blocks, panel layout) lives in
  settings, never in the code.

## Consequences

- Switching modes is free and lossless.
- Some visual operations are harder than in a tree editor (moving a
  statement between `:CASE` arms needs care over ranges). That is the price.
- Tested by a round-trip property over every fixture: the blocks' ranges
  cover the file exactly, and a no-op edit changes no byte.
