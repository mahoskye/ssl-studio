# ADR 0021: What the shell does to files, it does without loss

**Status:** Draft
**Date:** 2026-11-19
**Decided by:** the agent's draft, written from steps 5 to 7 of
[the audit's build plan](../VSCODE-AUDIT.md#the-build-plan) and two
reviews of them; the user has not reviewed it.

Under [ADR 0009](0009-nothing-is-lost-or-destroyed-without-a-say.md),
[ADR 0002](0002-text-is-the-source-of-truth.md) and
[ADR 0019](0019-a-file-is-written-back-in-what-it-was-written-in.md).

## Context

- The shell learned to do to files what VS Code's does: copy, cut and
  paste them, drag them, open any kind of them, change their line ends,
  and replace text across many of them at once.
- Each of these can destroy work in one gesture, and most of them act on
  files that are not open, where there is no undo.

## Decision

- **Nothing is written over.** A move onto a name that is taken is
  refused. A copy beside its original takes the name "… copy". A copy
  that fails part of the way is taken away again.
- **A move is a rename.** Open tabs, their unsaved edits, the places to
  go back to and the links in the working documents follow it, and the
  language server is told.
- **A drop asks; a paste does not.** A drop is easily a slip of the hand.
  A paste was asked for twice already.
- **What is cut or copied in the tree is the app's own.** It is not put
  on the system's clipboard, where a file is only its path as text.
- **A file that is not text is never read as text.** A picture is shown;
  other bytes say what they are. The backend refuses to write text over
  either, so that no part of the app can do it by mistake. An editor may
  save the text it opened.
- **Changing line ends is an edit.** It can be undone, it is kept only by
  saving, and "Revert" takes it back with the rest.
- **A replace across files shows every change before it makes any,** and
  makes none until it is confirmed. The two find their matches with one
  expression; what is replaced is what is in the file when the replace
  runs, and the app says so when that is not what was listed. A search
  that ran into its limit refuses the replace.
- **A replaced file has a way back.** Every file that is written goes
  into its local history first, as it was. A file with a tab is changed in
  the editor, where undo takes it back as well.
- **A file with unsaved changes is never saved by the way.** A replace
  changes it in the editor and leaves it unsaved, and says so.
- **A file's text is never another file's.** What the app read of a file
  without opening a tab on it (a definition peeked at, a search's
  results) is let go when that file is removed or moved onto, so that
  what comes to be at its path is shown with its own text.

## Consequences

- A file with a zero byte in its first 8000 bytes cannot be opened as
  text here, even when it is text in an encoding this does not know.
  UTF-16 without its mark is the one exception: it opens as it did.
- A replace cannot leave single results out: the search is narrowed
  first, by words or by which files it looks in.
- Local history grows by a snapshot or two for each file a replace
  writes.
- Copying a file between two workspaces, or in from the system's file
  manager, is not done by cut and paste here.
- All of this rests on the app hearing of changes made by other
  programs, and it does not hear of all of them: see
  [the audit](../VSCODE-AUDIT.md#looked-at-and-not-checked).
