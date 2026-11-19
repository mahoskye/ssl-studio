# ADR 0023: The window's graphics and menus are its own

**Status:** Draft
**Date:** 2026-11-19
**Decided by:** the agent's draft, written from what the user saw when
trying the app after [the audit's build plan](../VSCODE-AUDIT.md#the-build-plan)
was built; the user has not reviewed it.

Under [ADR 0007](0007-design-is-held-to-a-standard-that-serves-starlims-work.md) and
[ADR 0020](0020-the-shell-does-what-vs-code-does-and-stays-its-own.md).

## Context

- Small graphics were typed as text: a dot for unsaved changes, a plus, a
  turning arrow, a cross. Text is drawn by whichever font the system finds
  the character in. The user saw the dot as a tall oval.
- A right-click where the app had no menu opened the web view's own:
  "Back", "Reload", "Inspect". The user saw a menu styled like nothing
  else in the window, now and again, and asked whether it was the app's.

## Decision

- **Every small graphic is a Codicon**, from the font the text editor
  already ships, or is drawn by a style rule (the unsaved dot). The ones
  used are named in `src/view/icons.ts`; a test holds each to the font's
  own table, and fails when a view types a shape as text.
- **The web view's own menu never opens.** A right-click where the app
  has a menu opens that menu. In a text box it opens the app's menu for a
  text box (cut, copy, paste, select all). On selected words it offers
  Copy. Anywhere else it opens nothing.
- **Letters stay letters.** "Aa", "ab" and ".*" on the search switches
  are text, and so are the punctuation marks in prose.

## Consequences

- No dependency is added: the font is the editor's.
- Paste from the text box menu needs the web view to let the page read
  the clipboard. Where it does not, the menu has no Paste and the key
  still works.
- The web view's "Inspect" is no longer one right-click away. A developer
  opens the tools by their own key.
- Seen in the browser preview only. Whether the desktop window's web view
  would have shown its own menu was not seen; with this it cannot.
