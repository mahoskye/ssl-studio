# ADR 0044: One command palette, with the editor's commands in it

**Status:** Accepted
**Date:** 2026-11-27
**Decided by:** the user, who asked for the defects of the second review of
the editor to be fixed. Which commands are listed, and how, are the agent's;
the user has not reviewed them.

Under [ADR 0032](0032-design-precedents-and-interaction-standards.md): a list
to pick from is the app's QuickPick at the top of the window.

## Context

- Ctrl+Shift+P listed the app's commands and none of the editor's: "join"
  found nothing.
- F1 opened the code editor's own list, drawn inside the editor, with only
  the editor's commands. Ctrl+G opened the editor's own box for a line in
  the same place, beside the app's "Go to line" (Ctrl+P, then `:`).
- In VS Code, F1 and Ctrl+Shift+P are one palette with every command, and
  "go to line" is the same box.

## Decision

- **Ctrl+Shift+P and F1 open the app's command palette,** in the code
  editor, the Live editor and everywhere else.
- **It lists the open text editor's commands with the app's,** each named as
  Settings and the menus name it, or as the editor names it written as the
  app writes a command's name ("Go to bracket"), with the keys it has now.
  Left out: the editor's own list, its box for a line, its outline and its
  "Format document", which the app has commands of its own for, and its theme
  switch.
- **Ctrl+G opens "Go to line" in the same box,** from the code editor, the
  Live editor, the status bar and the Go menu. The editor's command for it is
  the app's: a key given to it in Settings opens the app's box.
- "The text editor's commands…" leaves the Help menu: the palette has them.

## Consequences

- A command is found in one place, whichever list it came from.
- The editor's commands are listed only while a text editor is open.
- The editor's own list is not reachable any more; every command in it is in
  the palette.
