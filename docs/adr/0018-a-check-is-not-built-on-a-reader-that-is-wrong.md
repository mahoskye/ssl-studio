# ADR 0018: A check is not built on a reader that is wrong

**Status:** Accepted
**Date:** 2026-11-19
**Decided by:** drafted from the work, after a check was added and taken
out again the same day; the user has not reviewed it.

Adds to [ADR 0015](0015-what-is-not-ssl-is-read-here.md).

## Context

- ADR 0015 lets the IDE say where a document that is not SSL cannot be
  read, with a reader of its own or the runtime's.
- A check for YAML was built on the runtime's YAML reader. That reader
  takes a list or a mapping written in brackets across several lines for a
  fault. The check marked documents that are right.
- A mark on a right document costs more than no mark on a wrong one: the
  person looks for a fault that is not there, and stops believing the
  marks that are true.

## Decision

- **A check marks only what its reader is right about.** Before a check is
  built on a reader, the reader is tried on documents that are right and
  unusual, not only on documents that are wrong.
- **A reader found wrong takes its check with it.** The check is removed,
  not narrowed to the cases it happens to get right.
- **The YAML check is out** until there is a reader that can be trusted.
  YAML is still coloured and outlined.
- **A check that knows where says where; one that does not, says so.** A
  place that is a guess is not shown as a place.

## Consequences

- YAML has no check. JSON, TOML and XML have theirs: JSON by a reader
  written here, TOML by the runtime's, XML by the web view's own.
- A new check needs its reader tried first, which is more work than the
  check.
