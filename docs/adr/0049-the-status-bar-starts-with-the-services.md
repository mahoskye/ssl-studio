# ADR 0049: The status bar starts with the services

**Status:** Accepted
**Date:** 2026-11-27
**Decided by:** the user, who asked for the status bar's left items to be
the language server, the Agent, Git and Problems, in that order.

Supersedes one point of
[ADR 0032](0032-design-precedents-and-interaction-standards.md): the order of
the status bar's left items.

## Context

- ADR 0032 put the Git branch and the Problems counts first on the left of
  the status bar, then the language server's and the Agent's dots.
- The two dots say whether the IDE's services are there at all. When one is
  missing, completion, diagnostics or the Agent are missing with it, and
  that is the first thing to know about everything else the bar says.

## Decision

- **The left of the status bar reads: LSP, Agent, Git branch, Problems.**
  Nothing else about the items changes: what each says, its tooltip, and
  what a click does.
- In a window under 780px wide, the Agent's dot is still left out while the
  Agent is idle or running well, as before.

## Consequences

- The Problems counts no longer sit at the bar's left edge, where VS Code
  puts them. The keys that show Problems are unchanged.
