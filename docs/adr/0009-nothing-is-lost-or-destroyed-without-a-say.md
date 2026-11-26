# ADR 0009: Nothing is lost or destroyed without a say

**Status:** Accepted; one point superseded by
[ADR 0034](0034-closing-keeps-unsaved-work-and-asks-nothing.md)
(closing the window and opening another folder no longer ask: the unsaved
text is kept)
**Date:** 2026-11-18
**Decided by:** the user asked for every recommendation of the 2026-11-18
review to be implemented (2026-11-18). The review found five ways to lose
work or files; this is the rule the fixes follow, drafted from it.

Under [ADR 0007](0007-design-is-held-to-a-standard-that-serves-starlims-work.md).

## Context

The review found that the IDE could lose work in ordinary use:

- Choosing "Save" while closing a tab closed it even when the save failed.
- Opening another folder dropped every unsaved edit without a word.
- Saving wrote over a file that had changed on disk since it was opened.
- The Explorer's "New file" button also offered to trash the open folder.
- "Set up project" wrote seven files on one click, with no list of them.

## Decision

- **Unsaved edits are never dropped silently.** Anything that would drop
  them asks first: closing a tab, opening another folder, closing the window.
  The question names the files and offers to save them.
- **A save that fails changes nothing else.** `save` says whether the file is
  on disk; a caller that goes on to close or discard checks the answer.
- **A file changed on disk is never overwritten unseen.** Saving asks:
  compare, overwrite, or reload.
- **Anything that writes more than the file in front says what it will write
  before it does.** "Set up project" lists the files.
- **A destructive choice is never the default.** Enter in a question never
  means delete, discard or overwrite.
- **A workspace cannot be told to remove itself.** The root folder can be
  neither renamed nor trashed from inside it.
- **An error stays until it is dismissed,** and is written to Output, so it
  can be read again.

## Consequences

- A few more questions in the way of destructive actions, none in the way of
  ordinary ones.
- Functions that used to return nothing now return whether they succeeded.
- Closing the desktop window asks too. Electrobun raises `will-close` before
  a window closes and takes no for an answer; the app says no while files are
  unsaved, and the view asks what to do (2026-11-18). `hutch run
  selftest-close` checks it in the real window: it leaves an edit unsaved and
  presses the close button from outside, twice. Cancelled, the window stays
  with the edit; with "Save all", the file is saved and the app closes. The
  button is pressed from outside because closing a window through
  Electrobun's own API skips `will-close`. It passes on Linux (X11) and on
  Windows 11 (in the evaluation VM, 2026-11-18). There is no way written to
  press the button on macOS, where nobody has yet closed a window on unsaved
  work.
- "Set up project" can be taken back: the files it wrote and nobody has
  changed since are removed, with the folders they left empty.
