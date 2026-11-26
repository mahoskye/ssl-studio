# ADR 0034: Closing keeps unsaved work, and asks nothing

**Status:** Accepted
**Date:** 2026-11-26
**Decided by:** the user. On seeing the close question left open by a
self-test they said: "it should act more like vs code where any unsaved
changes are usually held while the app closes" (2026-11-26). The four points
under "What the user chose" were put to them the same day and are theirs; the
rest is drafted from those.

Supersedes one point of
[ADR 0009](0009-nothing-is-lost-or-destroyed-without-a-say.md): that closing
the window and opening another folder ask about unsaved edits. Everything else
in ADR 0009 stands. Follows
[ADR 0032](0032-design-precedents-and-interaction-standards.md), which names
VS Code as the precedent for the IDE shell.

## Context

- ADR 0009 made sure unsaved edits were never dropped silently. For closing
  the window and for opening another folder it did so with a question: "Save
  all / Discard changes / Cancel".
- The question protects the work, and it is in the way. Closing an editor at
  the end of a day is not a decision about each open file. VS Code closes at
  once and brings the unsaved text back the next time ("hot exit").
- A question was also the only protection. A crash, a kill or a power cut
  asked nothing and lost everything that was not saved.

## Decision

- **Closing the window asks nothing and loses nothing.** The unsaved text of
  every open document is kept by the app, and the window closes. The files on
  disk are not touched.
- **The documents come back as they were left.** When the folder is opened
  again, each comes back in its tab, still unsaved, with the same text. A
  document that has no file yet ("Untitled-1") comes back too.
- **The kept text is the app's own, never the workspace's.** It lives in the
  app's state folder, in a folder for each workspace, keyed by the workspace's
  path as local history is. Nothing is written into the workspace.
- **Kept text ends when it is no longer unsaved:** on a save, on "Discard
  changes", when a tab is closed with its changes given up, or when the text
  is back to what the file has.
- **If the text cannot be kept, the app asks, as before.** Where the state
  folder cannot be written, closing the window or opening another folder asks
  the question of ADR 0009, and says once why. Nothing is ever lost on the
  strength of a keep that failed.

### What the user chose

- **Text is kept as it is typed, not only at close.** Within a second of a
  change, and once more as the window closes. A crash or a kill loses at most
  the last second.
- **A file that changed on disk meanwhile comes back with the kept text,
  marked.** A notice names it, and saving asks "Compare / Overwrite / Reload",
  as ADR 0009 has it for a file changed under open edits. A file that is gone
  comes back unsaved, and saving puts it back. Nothing is asked at start.
- **Opening another folder is the same as closing.** It asks nothing, and the
  edits come back when that folder is opened again. This goes further than VS
  Code, which by default still asks there; one rule for leaving a folder was
  preferred.
- **The browser host behaves as the app does.** It no longer shows the
  browser's "Leave site?" on a reload or a closed tab. The text is sent to be
  kept as the page goes.

## What does not change

- Closing a single tab with unsaved changes still asks "Save / Discard
  changes / Cancel", as VS Code does. Closing a tab is a decision about that
  file.
- A file changed on disk is never overwritten unseen; a destructive choice is
  never the default; the other rules of ADR 0009.
- The tabs a folder was left with are still remembered by the window. The
  unsaved text is kept by the app, so it survives a window whose storage is
  lost and is the same in the desktop app and the browser host.

## Consequences

- The desktop window does not close in the same instant when something is
  unsaved. Electrobun's `will-close` wants its answer at once, so the app says
  no this once, the view hands over the unsaved text, the app writes it and
  closes itself. It takes a few milliseconds and shows nothing.
- A view that does not answer (it crashed, or hangs) no longer holds the
  window for ever. After two seconds a second request closes it, on the text
  that was kept as it was typed. Not while keeping fails: then the window
  waits for the view, as under ADR 0009.
- Unsaved work is no longer visible from outside the app. A folder left with
  unsaved edits has files on disk that lack them, so a commit or a build made
  elsewhere does not include them. The tabs show the unsaved mark when the
  folder is opened again; nothing reminds before that.
- The kept text is tied to the folder's path. A folder that is moved or
  renamed outside the app does not find its unsaved text again; the text
  stays in the state folder under the old path's key.
- Two windows on one folder (two copies of the app, or the app and the browser
  host) each keep their own unsaved text under the same key, and the later one
  wins. One window to a folder is assumed.
- In a browser tab the last send may not arrive: a browser can cut the
  connection before it. What was typed in the last second before the tab was
  closed can be missing there. The desktop app waits for the write.
- "Reload without tabs" (the way out when a restored tab keeps failing) does
  not reopen files with unsaved text either, since one of them may be the tab
  that fails. It says which files have unsaved text kept, and they come back
  when the file is opened.
- `hutch run selftest-close` checks it in the real window, on Linux (X11).
  It leaves a file and a document with no file unsaved, presses the close
  button from outside, and starts the app again: the app has to close by
  itself and ask nothing, the file on disk has to be untouched, and both
  documents have to be back, unsaved, with every line. It has not been run on
  Windows since this change, and there is still no way written to press the
  button on macOS.
