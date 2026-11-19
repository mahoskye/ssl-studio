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
- **A text box's menu leaves the keyboard in the box.** A box that saves
  or shuts when the keyboard leaves it (a table's cell, a block's text)
  does neither because its menu opened. Up and Down mark an entry, Enter
  takes the marked one and does nothing with none marked, Escape and Tab
  shut the menu; any other key shuts it and is typed. The box names the
  marked entry to assistive tech.
- **Letters stay letters.** "Aa", "ab" and ".*" on the search switches
  are text, and so are a cross, a minus or an arrow inside a sentence. As
  a control's whole face they are icons.

## Consequences

- No dependency is added: the font is the editor's.
- Paste from the text box menu needs the web view to let the page read
  the clipboard. Where the web view has no way to, the menu has no
  Paste. Where it has one and refuses, Paste says so. The key still
  works in both.
- The web view's "Inspect" is no longer one right-click away. A developer
  opens the tools by their own key.
- Seen in the browser preview only. Whether the desktop window's web view
  would have shown its own menu was not seen; with this it cannot.

## Changes to this draft

A decision is superseded, not rewritten. This one has not been accepted,
and was changed while it was a draft; what changed is kept here.

- 2026-11-19, with the fixes of the review of `3905b68`: added "A text
  box's menu leaves the keyboard in the box"; "Letters stay letters" now
  says a symbol that is a control's whole face is an icon; the
  consequence about Paste now tells a web view that cannot read the
  clipboard from one that refuses.
- 2026-11-19, with the fixes of the review of `defb4df`: this section.
