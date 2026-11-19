# ADR 0020: The shell does what VS Code does, and stays its own

**Status:** Draft
**Date:** 2026-11-19
**Decided by:** the user decided the first point (SSL Studio stays its own
application, with VS Code as the baseline for the shell). The rest is the
agent's draft, written from the work on
[the audit](../VSCODE-AUDIT.md); the user has not reviewed it.

Under [ADR 0007](0007-design-is-held-to-a-standard-that-serves-starlims-work.md) and
[ADR 0003](0003-the-language-server-owns-ssl.md).

## Context

- People who come to SSL Studio have used VS Code. Where this shell did a
  common thing differently, or not at all, they stopped to look for it.
- The choice was between building on VS Code (an extension, or a fork) and
  bringing its habits here. The blocks view, the working documents, the
  plans and the house style are the reason the IDE exists, and none of
  them fits an extension's limits
  ([the audit](../VSCODE-AUDIT.md#why-not-an-extension)).

## Decision

- **SSL Studio is its own application.** It is not an extension of VS
  Code and not a fork of it.
- **Where VS Code's shell has a habit and this shell has the feature, the
  habit is the same:** the name of the command, its default key, and where
  it is found. A difference needs a reason, written where it is made.
- **The menu bar is drawn in the window.** The app also runs in a browser,
  where there is no system menu to hand it to, and a menu must not differ
  between the two. It can be hidden; the command list brings it back.
- **A menu holds no command of its own.** Every entry is a command of the
  app or of the text editor, so that the command list, the keys and the
  menus never disagree about what there is. What only a menu had (the
  versions, the list of keys) became a command first.
- **An entry that cannot run is still an entry.** The keyboard lands on
  it, and the menu says why it cannot run.
- **Alt and a menu's first letter opens that menu,** unless the user has
  given that key to a command: their shortcut wins.
- **A pinned tab is closed only once it is unpinned.** Ctrl+W, "close
  others" and "close all" leave it, and the app says why; its own menu
  offers "Unpin" where another tab's offers "Close". A file that goes to
  the trash closes its tab, pinned or not.
- **Ctrl+Tab goes to the tab used before,** not to the next one along.
  Ctrl+PageDown and Ctrl+PageUp go along the row.
- **What needs to know SSL stays with the language server.** A habit that
  would need the IDE to read SSL itself is asked for there, not built here.

## Consequences

- The menu bar takes a row of the window (28 pixels at the normal size).
- Alt with F, E, S, V, G or H is no longer free for the text editor.
- On macOS the menus are in the window and not in the system's bar at the
  top of the screen. This was not seen on a Mac.
- The text editor's own keys are shown in the menus as the editor reports
  them, by a part of it that is not public: an update of the editor may
  leave those entries without keys. They still run.
- Toggling a comment in SSL uses the block comment, because that is the
  only comment SSL has; a line comment per line needs the language server.
