# What the reviews found, finding by finding

Nine reviews of the work on [the audit](VSCODE-AUDIT.md) were made by a
reader who was given the commits and not the author's conclusions: three
of the build's steps, three of the fixes the last pass made, each of
the fixes that came of the one before, one of what the user's first use
asked for, one of what the second asked for, and one of Markdown drawn
as it is written. The last four found nothing that loses work on disk.
This
lists every finding, what was done about it, and the commit that did it.
"Left" means not changed, with the reason.

## The first review: steps 1 to 3

Fixed in `62e856c`, except where another commit is named.

1. **A closed menu could lose what had the keyboard,** so File > Rename
   acted on the open file and not the Explorer's row. Fixed; seen: the
   dialog named the Explorer's row.
2. **A pinned tab hid its unsaved mark.** Fixed: a dot beside the pin.
3. **Edit and Selection entries acted on the code from a text box.**
   Fixed: in a box, the box's own six commands work on the box.
4. **"Close all" on a tab's menu closed every group's tabs.** Fixed.
5. **The comment marks set in step 1 did nothing.** Fixed: taken out,
   and the audit says the key was the editor's own all along.
6. **A regular expression with "whole word" refused some expressions.**
   Fixed: read the older way where it must be.
7. **ADR 0020 and the audit said what the code did not do.** Fixed.
8. **Entries that cannot run were out of the keyboard's reach.** Fixed:
   the keyboard lands on them and the menu says why.
9. **Step 3 did not say what was looked at.** Fixed: each step says so.
10. **Ctrl+Tab went stale when a tab closed while Ctrl was held.** Fixed.
11. **Smaller points.** Fixed: "Open to the side" from the keyboard,
    pinned tabs first on restore, the path's slashes, a switch that the
    project's settings hold, a stray comment, a hint that named a key.

## The second review: steps 4 to 6

Fixed in `fe6ecc1`, except where another commit is named.

1. **With the left group gone there was no active editor.** Fixed; seen:
   every tab dragged away from the left group, then a line commented
   from the Edit menu.
2. **"Revert" kept a changed kind of line end.** Fixed.
3. **Moving a file with unsaved edits raised a false alarm.** Fixed.
4. **The language server was not told of moves and copies.** Fixed.
5. **Back and forward opened a second tab across a split.** Fixed.
6. **A file that is not text was half treated as text.** Fixed.
7. **A zero byte typed into a text file made the next save fail.** Fixed.
8. **A move onto a path with a stale open document took its text.**
   Fixed: the move is refused until that tab is closed.
9. **Smaller points.** Fixed: the cursor of a tab moved to another group,
   the drop mark's stray line, a folder's copy name, a refused paste
   forgetting the cut, Enter before the list arrives, "name:" with no
   number yet, a copy that fails halfway, a keyboard way to move a tab
   across, a cut row said aloud, Ctrl+C by the key's place. **Left:** a
   failed rename leaves the folders it made; they are empty.

## The last review: steps 7 and 8

Fixed in `d55c814` or `801e1cc`, as named.

### Source control

- **A1. Stage, unstage and discard acted on the wrong path in a
  workspace inside a larger repository.** Fixed, `d55c814`, with a test.
- **A2. File names were read as patterns.** Fixed, `d55c814`, with a
  test.
- **A3. A commit there takes staged changes the panel did not show.**
  Fixed, `d55c814`: the panel counts them and says a commit takes them.
- **A4. The discard dialog promised a copy that bytes do not get.**
  Fixed, `d55c814`: it promises one where the file is text.
- **A5a. Nothing said a staged file has unsaved edits.** Fixed,
  `801e1cc`.
- **A5b. No queue and no time limit for git.** Fixed in part, `801e1cc`:
  one question at a time. **Left:** no time limit, since a repository's
  own checks may rightly take long.
- **A5c. "Stage all" could pass too long a command line.** Fixed,
  `801e1cc`: a hundred paths to a command.
- **A5d. No cap on files git does not follow.** Fixed, `801e1cc`: a list
  shows its first 500 and says so.
- **A5e. Unstaging a renamed file is surprising.** Left: it is git's own
  answer, and nothing is lost by it.
- **A5f. A conflict, or bytes, compared as empty text.** Fixed,
  `801e1cc`: it says so instead.
- **A5g. A discard could raise "changed on disk".** Fixed, `801e1cc`.
- **A5h. "Never asks for a password" said too much.** Fixed, `d55c814`.
- **A5i. The user's checks were run in another language setting.**
  Fixed, `d55c814`.

### Replace across files

- **B1. Most replaced files got no copy in local history.** Fixed,
  `d55c814`; seen: both snapshots on disk after a replace.
- **B2. A replace can change other than what was listed.** Fixed in
  part, `d55c814`: it acts on the file as it is then, and says when the
  count differs; a line too long for the list shows no replacement.
- **B3. A failed save left an unsaved document nobody can see.** Fixed,
  `d55c814`: a file with no tab is changed on disk.
- **B4. A match of nothing beside a wide character hung or split it.**
  Fixed, `d55c814`, with a test.
- **B5. A replace took away whether a file may be run.** Fixed,
  `d55c814`, with a test.

### The earlier fixes

- **C1. "Still open in a tab" for a file with no tab.** Fixed, `d55c814`.
- **C2. An empty open file turned into bytes was written over.** Fixed,
  `d55c814`.
- **C3. The cursor was lost after every comparison.** Fixed, `d55c814`.
  **Left:** what is kept is never thrown away; it is small and lasts a
  session.
- **C4a. Every move listed the whole workspace.** Fixed, `801e1cc`, for
  a file. **Left:** a folder is still looked through, up to 20,000 files.
- **C4b. A one-line file lost its kind of line end on revert.** Fixed,
  `801e1cc`.
- **C4c. A failed copy leaves the folder it made.** Left: it is empty.

### The view

- **D1. The commit's message was lost with the panel.** Fixed, `d55c814`.
- **D2. The margin's marks blinked, and git was asked three times.**
  Fixed, `d55c814`.
- **D3. A very large file is marked changed throughout.** Left:
  comparing it line by line is too slow to do on every key.
- **D4. Half of a search was kept across panels.** Fixed, `801e1cc`: all
  of it is.
- **D5. The note about unsaved files went too soon.** Fixed, `d55c814`:
  it stays, and offers "Save all".
- **D6. The search's limit was written in two places.** Fixed, `d55c814`.
- **D7. A replace that threw left the panel "Searching…".** Fixed,
  `d55c814`.

### Accessibility

- **E1. Old and new text were read as one word.** Fixed, `d55c814`.
- **E2. A row's steps were on its menu only.** Fixed, `801e1cc`.
- **E3. Nothing was said after a step.** Fixed, `801e1cc`.
- **E4. The status bar's label read arrows aloud.** Fixed, `d55c814`.

### Tests

- **F1. The git tests changed the process's settings for good.** Fixed,
  `801e1cc`.
- **F2. The null device as git's settings on Windows.** Fixed, `f1bf895`.
- **F3. "Not in a repository" trusts the temporary folder.** Left: it is
  not in one on any system the tests run on.
- **F4. Behaviour with no test.** Fixed in part, `d55c814`: a workspace
  inside a repository, names with pattern marks, wide characters, a
  file's mode. **Left:** the backend's replace and discard, and the
  view's own code: a test of the first writes into the user's own
  settings folder, and there is no harness for the second.

### Documents

- **G1. Six lines of the audit said what the code did not do.** Fixed,
  `d55c814`.
- **G2. ADRs 0021 and 0022 overstated.** Fixed, `d55c814`.
- **G3. One fix commit was looked at in one layout only.** Fixed,
  `801e1cc`: everything added was looked at again in the other two.

## Each fix, shown working

When the building was done, each fix above was shown by itself
(2026-11-19): in the running app, in an instance of its own on a scratch
copy of the demo project, or by its test where the app cannot show it.
"Test" names a test that passes in `bun test`.

### The first review

- **1, 3, 8.** With the keyboard in the Search box, the Selection menu
  offered "Select all" and marked the rest "For the code: the keyboard is
  in a text box"; Enter on one of those did nothing; "Select all"
  selected the box's twelve characters and gave the box the keyboard back.
- **2.** A pinned tab with a typed space read "pinned, unsaved changes"
  and showed its dot; after undo, "pinned".
- **4.** "Close all" on the right group's tab closed that group's one tab
  and left the left group's twenty.
- **6.** Tests: "an expression that reads only the older way is still
  searched", "an expression that cannot be read at all says so".
- **10.** Test: "a walk through the tabs … is over when a tab of it was
  closed".
- **5, 7, 9, 11.** In the code and the documents; nothing to run.

### The second review

- **1.** Seen when it was fixed, as said above.
- **2.** A one-line file with Windows line ends, changed to LF from the
  status bar, read CRLF again after "Revert file".
- **3.** A file with unsaved edits was renamed: its tab took the new
  name, kept "unsaved changes", and no alarm was raised.
- **4.** A script was renamed with its tab closed; "go to definition"
  from a caller in another script then opened it under its new name.
- **5.** With a split, "Go back" and "Go forward" went between two files
  inside the group that held them: six tabs and two before, and after.
- **6.** A file of bytes showed "is not text" and "Not text" in the
  status bar. Tests: "other bytes are not read as text either".
- **7.** Test: "a text file with a zero byte typed into it can still be
  saved by the editor that holds it".
- **8.** A file with unsaved edits was removed by another program; a
  rename of another file onto its name was refused: "is still open in a
  tab from before it was removed".

### The last review

- **A1, A2, A3.** Tests: "in a workspace that is a folder inside the
  repository, each step acts on the file asked for", "a file's name is
  only a name", "what is staged above the workspace's folder is counted".
- **A4.** The discard dialog said "Where it is text, the file as it is
  now on disk is kept in its local history", for a text file and for one
  of bytes.
- **A5a.** Staging a file with unsaved edits said "has unsaved changes:
  what is staged is what is saved".
- **A5c, A5d.** With 600 new files the panel said "1 staged, 608 not
  staged", listed 500 and said "And 108 more, not listed". "Stage all"
  then staged 607, as git itself counted, and "Unstage all" took them
  out again.
- **A5f.** Enter on a changed file of bytes said "is not text in git:
  there is nothing of it to compare"; on a conflict, that there is no one
  earlier text to show.
- **A5g.** A discard of a file open in a tab put its text back with no
  "changed on disk".
- **A5h, A5i, G1, G2.** In the documents and the code; nothing to run.
- **B1.** After a replace in three files, each had two new copies in
  local history: as it was, and as it became.
- **B2.** A file was given one more match after the search; the replace
  said "Replaced 7 matches in 3 files. 6 matches were listed". A line of
  ten thousand characters showed "…" and no replacement.
- **B3.** The file with no tab was changed on disk and got no tab.
- **B4.** Test: "the walk steps past the whole character".
- **B5.** A script that may be run still could be after the replace
  (mode 755). Test: "a file written again keeps whether it may be run".
- **C1.** A script was peeked at, so read with no tab, then removed by
  another program; a file renamed onto its name was let through.
- **C2.** An empty file open in a tab was turned into four bytes by
  another program: the tab showed "is not text", and nothing was written.
- **C3.** A snapshot was compared from line 30; on closing, the cursor
  was at line 30.
- **C4b.** As the second review's 2: the file had one line.
- **D1.** A commit message typed, another panel shown, and Source
  control shown again: the message was there.
- **D2.** The margin's marks were there in all four layouts. That they
  no longer blink between git's answers was not measured.
- **D4.** The words searched for, the replacement and the results were
  there after the Explorer was shown and Search shown again.
- **D5.** A replace in a file with unsaved edits left a note that was
  still there eight seconds on, with "Save all".
- **D6, D7.** In the code; a replace that throws was not provoked.
- **E1.** A result reads "tallyho becomes tallyhey".
- **E2, E3.** Each row has its steps as buttons with names ("Stage
  long.txt"); the count "1 staged, 4 not staged" is a status.
- **E4.** The status bar's label: "Branch main, 3 changed files. Show
  Source control."
- **F1, F2.** The tests pass on Linux, macOS and Windows in CI.

### Found while showing them

- **A file only peeked at kept its text past its file.** With C1 fixed, a
  rename onto the path of a peeked script that another program had
  removed was let through, and the renamed file's tab showed the old
  script: an edit and a save there would have written it over the file.
  Fixed: a document that was only read is let go when its file is
  removed, by the app or by another program, and before a move lands on
  its path. Seen: the same steps then showed the renamed file's own text.
- **"4 bytes of bytes".** The not-text view's sentence, for a file under
  a kilobyte. Fixed, and seen: "It holds 4 bytes that do not read as
  text".
- **The file watching misses some changes.** Not fixed: see
  [the audit](VSCODE-AUDIT.md#looked-at-and-not-checked).

## The fourth review: the fix above

The fix for the file that was only peeked at changed code after the last
review, so it was reviewed by itself (`a8c8fbf`). All five findings were
confirmed and fixed, in the commit after it.

1. **Edits nobody saved, in a file with no tab, still gave their text to
   a file moved onto its path.** A rename across files changes scripts
   that are not open. Fixed: such a move is refused, and says "Save all"
   puts the file back. Seen: a procedure renamed from its caller, its
   script removed by another program, a rename onto its name refused with
   that note; "Save all" then wrote the script back, renamed procedure
   and all.
2. **"Before a move lands" held only when the moved file was open,** and
   not for a new file or a copy. Fixed: what was only read is let go
   before any move onto its path, and is looked at again on disk before
   it is given a tab. Seen: a script was peeked at, changed by another
   program, then opened: its tab showed the file as it is on disk.
3. **A trashed file kept its tab in a second group** when the first was
   left empty. Older than this work, in the function the fix touched.
   Fixed: the groups are gone through from the last back. Seen by the
   other way a file is removed, since the preview cannot move one to the
   trash: a project was set up, one of its files opened in two groups
   that held nothing else, and the set up undone. Both tabs closed.
4. **A "changed on disk" mark could outlive a document that was let go.**
   Fixed: it goes with the document.
5. **Two narrow races.** A file removed while the tabs were being read at
   the start got a tab with nothing behind it; the call graph read a
   script whose model had gone. Fixed: both look again first. The first
   was provoked: with 61 tabs to restore, a small program removed the
   first tab's file the moment the app opened it. The app came up with
   the other 60 tabs, none for that file, and nothing said or broken.
   The second was not seen: that way of reading scripts is used only
   with a language server that has no call graph of its own.

## The fifth review: the fixes of the fourth

The fourth review's fixes were code too, so they were reviewed in turn
(`0b5b593`). Six findings, all confirmed; all are fixed in the commit
after it, the third of them in part.

1. **The refusal said "was removed" of a file that was there.** A name
   that is taken on disk is now left to say so itself. Seen: "already
   exists", for a script with unsaved edits and no tab that was still on
   disk.
2. **"Save all, then try again" could not work,** since saving puts the
   file back and the name is then taken. The note now offers "Open it":
   to save the edits, or to close the tab and give them up, after which
   the name is free. Seen, to the end: refused, opened, closed without
   saving, renamed.
3. **A new file was not refused as a move was.** Fixed for a new file or
   folder in the Explorer and for a new document. Seen for a new file.
   **Left:** the app's own writers of working documents, which write
   through the editor when the file is held there.
4. **Opening a file could fail without a word** when its document was
   let go while the file was read. Fixed: what is done after the read is
   done to the document that is there then.
5. **A file that changed and then went could get a tab on nothing.**
6. **Undo in a newly opened tab brought back the old reading.** Both
   fixed by one change: what was only read is let go when its file is
   opened, and the file is read as it is now, with nothing to undo.
   Seen: "go to definition" into a script with no tab opened it with its
   text, at the definition.

Seen on the way, older than this work, and fixed: the status bar went on
saying the last file's line and column when a file was opened with the
cursor at its first line. It now says 1 and 1.

## The sixth review: the fixes of the fifth

The fifth review's fixes were reviewed in turn (`ae3e4d2`). Its answer:
nothing that loses work or leaves a tab on a document that is gone, and
four small things. The two that were fixed were read by the same
reviewer before they were committed, who found nothing in them.

1. **On Windows, a name that differs only by case was still said to be
   "removed".** So was a name the folder's list does not show. Fixed:
   the disk itself is asked whether something is at the path. Seen, on
   Linux: "already exists" for an open file on disk, and the refusal
   once another program had removed it. Not seen on Windows.
2. **A reload could touch a document let go while the file was read.**
   Fixed: it looks again first.
3. **A peek goes blank when its file is opened** in the other group of a
   split. Left: it is a preview, and the next reference fills it again.
4. **A file is read twice** when a closed tab is reopened or a
   definition is gone to. Left: the second reading is the one that keeps
   the tab true, and it costs one read.

## The seventh review: what the first use asked for

The commit that built [step 9](VSCODE-AUDIT.md#step-9-what-the-first-use-asked-for)
(`3905b68`) was reviewed before anything was built on it. Fifteen
findings, none that loses work. Each fix was then tried in the running
app, or is held by a test, as said.

1. **A text box's menu took the keyboard from the box.** A table's
   cell, a block's text and a plan's node save or shut when the keyboard
   leaves them, so a right-click in one ended the edit and Paste had
   nowhere to go. Fixed: the menu leaves the keyboard in the box, and the
   window gives it Up and Down, Enter for a marked entry, and Escape.
   Seen: in a cell being edited, the menu opened, Down marked an entry,
   Escape shut the menu and the cell was still being edited.
2. **"Reset the layout" left the left side on a panel docked right.**
   Fixed: each side shows a panel docked on it, whatever moved the
   panel. Seen: with the Agent moved left, the reset put the Explorer on
   the left and the Agent back on the right. A test holds the choice.
3. **"Show the side panel" hid it in a narrow window.** The entry and
   Ctrl+B flipped a switch that a crowded-out side ignores. Fixed: both
   now bring that side back, as its button does. Seen at 720 wide.
4. **The bar that resizes lay over the side panel's scroll bar.** Fixed:
   it reaches 2 pixels onto that panel, the scroll bar's clear edge.
   Seen by asking what is under the pointer, pixel by pixel.
5. **"Edit the text" dropped the keyboard.** Fixed: the text takes it.
   Seen.
6. **A review's checks, and Health's ticks, no longer said pass or fail
   to a screen reader.** Fixed: the words are there, hidden from the
   eye. Not heard: no reader was run.
7. **"Hide the menu bar" from the Layout menu dropped the keyboard.**
   Fixed: it goes to the file in front. Seen.
8. **The right side came back on the first panel docked there**, not
   the one that was showing. Fixed: it is kept with the other two. Seen,
   with Source control and the Agent both docked right.
9. **An outer region could not be caught where an inner one overlapped
   it**, and a region five deep was cut away. Fixed: a band is caught
   from its own left edge rightward, and the steps in stop at three.
   Seen, pixel by pixel.
10. **Folded groups were kept through a self-test.** Fixed: a self-test
    starts with every group open and keeps nothing. Left: a group
    folded in one project is folded in every project. That is meant: it
    is the panel that is arranged, not the project.
11. **The icon test did not hold a cross, a minus or an arrow.** Fixed
    in part: a second test fails on the forms such a face has been
    written in (alone on a line, alone in an element, alone in quotes),
    and the first says what it holds. A symbol built some other way
    would pass. The last such face, on a search switch, is an icon now.
12. **A style rule named a class nothing has**, so a review's marks were
    too large. Fixed.
13. **"Copy" for selected words opened beside them**, not only on them.
    Fixed: the pointer has to be on the words.
14. **Paste did nothing, silently, where the web view refused the
    clipboard.** Fixed: it says so; the ADR says both cases.
15. **The documents had fallen behind**: the command count, the Explorer
    menu, and new rows marked as if they had always been there. Fixed:
    the rows are Bring and Built, in a step of their own.

The reviewer also noted that a menu opened from a button does not shut
when a shortcut takes the keyboard elsewhere. That is older than this
work, and is left.

### The fixes, read before they went in

The same reviewer read the fixes above before they were committed, and
found eight things in them, none that loses work. All were fixed.

1. **Enter in a text box's menu, with nothing marked, went on to the
   dialog under it** and ran what was chosen there; Tab left the dialog.
   Fixed: Enter then does nothing, and Tab shuts the menu only. Seen in
   the command list.
2. **That menu was silent to a screen reader**, since the keyboard is
   not in it. Fixed: the box names the marked entry, and a line says
   the menu has opened. Not heard: no reader was run.
3. **"Reset the layout" with the menu bar hidden reset nothing.** Saving
   the bar's setting brought the older layout back from disk. This was
   in the first commit. Fixed for every setting: what comes back from a
   save leaves the layout on screen alone. Seen.
4. **The menu was tied to what had the keyboard**, not the box it was
   for. Fixed: it is given the box.
5. **"Copy" for selected words might not open from the menu key.**
   Fixed: a right-click is told by its button, not by having a place.
6. **The icon test still passed a symbol written in quotes.** Fixed, as
   far as finding 11 above says.
7. **Three sentences said more than the code did**: the strip caught
   "across all 18 pixels", Enter "works the menu", and a comment. Fixed.
8. **Small things**: a second, shorter list of modifier keys; a marked
   entry and a hovered one both lit; a line's indentation. Fixed.

After these the marked entry, the search switch's new icon and the menus
were looked at again at 720 and 1440 wide, in the light and the dark
theme.

### The commit as it went in, read once more

Two sessions were fixing the same findings in the same folder at once,
and one commit (`defb4df`) took both sets of edits. So that commit was
read again, by a reviewer told only that two authors had overlapped.
Eleven findings, none that loses work or traps the user.

1. **Tab in a dialog had two answers**: the dialog moved the keyboard at
   its first and last box, the menu held it still. Fixed: one answer.
   Tab shuts the menu and moves nothing; Shift+Tab does the same.
2. **This document told the pre-commit reading twice**, as five things
   and as eight. Fixed: the one account above.
3. **The count of fixes was said three ways.** Fixed: thirteen fixed,
   one fixed in part (11) and one fixed with a part left on purpose
   (10), here and in the audit.
4. **The marked entry was said to a screen reader twice.** Fixed: the
   box names it, and one line says the menu has opened.
5. **The pointer marked an entry, and Enter in the box then took it.**
   Fixed: the mark goes when the pointer leaves the menu.
6. **Keys with Ctrl, Alt or Shift were taken as the menu's.** Fixed:
   they shut the menu and do what they do in the box.
7. **A branch in saving a setting that nothing reaches.** Left: it is
   the guard for a caller that saves the layout that way.
8. **Moving a panel still picks the side's next panel itself**, as the
   window's layout now does for every cause. Left: harmless, and it
   says what a move does where a move is written.
9. **Six comments said what the code no longer does.** Fixed.
10. **A right-click is told from the menu key by its button.** Left
    here; fixed after the reading below, which showed that the desktop
    window's web view is likely to report the menu key that way.
11. **The deepest band grew past the strip under the pointer.** Fixed:
    it brightens, and does not widen.

### The same commit, read by a second reviewer

Each of the two sessions had asked for a review of `defb4df`. This is
the other one's: eleven findings, none that loses work or traps the
user. One was answered by the fixes above (6) and one in part (5). One
is left (7), one is left in part (8), and one is answered by a note and
not by a change of course (10). The rest were fixed after them by one
session, the other having stopped. The reviewer read these fixes before
they were committed, and found nothing in the code to change; three
sentences it found loose are put right here.

1. **The menu's opening was said twice, and the line that says it was
   inside the menu**, where only entries belong. Fixed: one line,
   beside the menu, filled a moment after it is on the page.
2. **"Copy" for selected words would probably not open from the menu
   key in the desktop window**: its web view may give that key's menu
   the right button and a place beside the words (from the reviewer's
   memory of the web view's source, not run). Fixed: a click is told
   from the key by which was pressed last. A test holds the rule. Not
   seen in the desktop window.
3. **With room for neither side, the right side's button shut it.**
   Only one side could be named as crowded out. Fixed: each side is
   said for itself, and a test holds it. Seen at 540 wide: neither
   key shut a side, and both were back at 1440.
4. **"Edit the text" from the keyboard put the keyboard in the other
   group.** Fixed: the page's own group becomes the one at hand. Seen,
   with the other group at hand when the menu was opened.
5. **A menu that opens under a resting pointer marked an entry at
   once.** Fixed: only a pointer that has moved marks one. The keys
   with Ctrl, Alt or Shift and the mark left behind were fixed above.
6. **Tab over a dialog had two answers.** Fixed above.
7. **The message of `defb4df` gives counts the commit does not bear
   out.** Left: a pushed commit's message is not rewritten. The
   documents give the counts.
8. **A box that names a row of its own to a screen reader could get a
   stale name back** when its menu shut. Fixed: what it names is read
   afresh. A box taken off the page while its menu is open leaves the
   menu until the next key or click; that is left, and said in the code.
9. **Comments that said what the code does not.** Fixed, the strip's
   among them.
10. **ADR 0023 was changed in place**, where decisions are superseded
    and not rewritten. It is a draft nobody has accepted; it and ADR
    0021, changed the same way earlier, now end with what was changed
    and when.
11. **Reading the settings again brought an older layout back** over
    the one on screen, within a moment of a change. Fixed: only a
    folder being opened takes the layout from disk.

## The eighth review: the Docs panel and preview tabs

What the user asked for after trying the Docs panel (file actions on
every row, folding, collapse and expand, the New menu, preview tabs)
was read by a fresh reviewer while it was staged, before any commit.
Thirteen findings. All were fixed, and the reviewer read the fixes
before they went in.

1. **A preview tab could be taken while a run or a review was using its
   document**, and what the run found was dropped without a word. Fixed:
   a plan's run, a tidy and a review each keep the tab of the file they
   work on.
2. **A tab showing unsaved changes could be replaced without asking.**
   Fixed: a file with unsaved changes, or one changed on disk, never
   opens as the tab for a look and never gives way as one. A test holds
   the rule.
3. **With a filter on, a ticket's twisty and "Collapse all" changed what
   was kept and nothing on screen.** Fixed: both are off while
   filtering, and say why.
4. **"Open to the side" on a file that cannot be read left an empty
   group.** Fixed: the group made for it is taken away again.
5. **A reload from disk kept a preview tab.** Fixed: whether the file is
   being written in is asked a moment after the change.
6. **Going to a place in a file looked at kept its tab.** Fixed: only
   opening it to stay keeps it (a double click, "Open" on a menu, Go to
   file); a symbol, a problem, back and forward do not.
7. **Two quick clicks could leave the first file showing.** Fixed: a
   look still being read gives way to the one asked for after it.
8. **Keeping a tab had no keyboard path.** Fixed: Enter on the tab,
   "Keep open" on its menu, and a command.
9. **A list's row said open or shut by a state its role does not have.**
   Fixed: it says it in hidden words; the attribute is a tree's only.
10. **A tooltip advised what cannot work.** Fixed: it says to widen the
    window, for one side open as for both.
11. **Rows in the Work group did not line up.** Fixed: every document's
    row there leaves a twisty's room.
12. **Two counts were wrong** in the list of what was seen. Fixed.
13. **A comment sat over the wrong function.** Fixed.

### The fixes, read before they went in

A second fresh reviewer read the staged change, fixes and all, before
it was committed (`2fb0ad3`), and held nothing back. It found seven
small things, fixed in the commit after.

1. **"Open to the side" with no tab open left an empty group beside the
   file.** Fixed: with nothing open it opens where a file would.
2. **Rename and trash were offered on the row of the project's own
   settings file**, and nothing read the project again after. Fixed:
   that row does not offer them.
3. **"Open the file" on a Source control row did not keep a preview
   tab.** Fixed.
4. **A double click in the twisty's room of a row with nothing under it
   did not keep the tab.** Fixed.
5. **A comparison kept a preview tab**, though it writes nothing. Fixed:
   only a review that can be accepted keeps it.
6. **With the filter on, nothing told the keyboard why a ticket would
   not shut.** Fixed: the row's hidden words say it.
7. **A sentence said "every row"** where one row has no icon to line
   up. Fixed above.

## The ninth review: Markdown drawn as it is written

The live preview was read by a fresh reviewer while it was staged, and
read again after each round of fixes, before any commit. The first
reading had eleven findings, three of which would have hidden characters
the user wrote. The second, of the fixes, had eight, the third six, the
fourth six, of which one was to stop for, and the fifth three, of which
one was.

### The first reading

1. **Code that was not seen as code had its stars and underscores
   hidden**: a fence under a bullet or in a quote, code set in from the
   edge, a block of HTML. Fixed in two steps; see the second reading.
2. **A link or a picture with no words vanished.** Fixed: with nothing
   to show it stays as written.
3. **Stars and underscores were paired where the renderer pairs
   nothing**: across table cells, in `f(*args, **kwargs)`, in `*.ssl`,
   in an address. Fixed: runs are paired by the renderer's own rules,
   the nearest opener first; each cell is read by itself; an address is
   not looked into.
4. **A find match inside hidden markup could not be seen.** Fixed: the
   line of the match shows its markup while the find box has the
   keyboard. Seen.
5. **A long heading ran past the right edge**, since wrapping is worked
   out at the text's size. Seen, as the reviewer suspected. Fixed: a
   heading is drawn at the largest of its sizes that its line has room
   for. Left: a long line of code or a wide table row, in the wider
   face, can still run past the edge and is scrolled to.
6. **One line with thousands of marks that open nothing held the window
   up.** Fixed: the words of a line over 5,000 characters are not read,
   a closing mark looks back a set distance, and no pattern backtracks
   over a line's spaces. A test holds the time.
7. **Every move of the cursor drew every decoration again.** Fixed: the
   markup is drawn apart from the rest, and only it follows the cursor.
8. **A task's box took clicks beside it, a middle click and a double
   click.** Fixed: one click of the main button, on the box itself.
9. **An address stopped at its first round bracket, and three ticks
   with text after them opened a block.** Fixed.
10. **Four sentences said what the code does not do.** Fixed.
11. **Tests**: invariants and the cases above were missing. Added. The
    part that draws, and the box's click, are still untested: they
    need the editor. Left.

### The second reading, of the fixes

The reviewer ran the fixed reading against the renderer on this
repository's documents and some 170 packages' READMEs.

1. **A comment or a tag on the line above a fence swallowed the fence**,
   and code was then read as prose and prose drawn as code. Found in a
   real file. Fixed: which lines are a block of code, of HTML or a table
   is now asked of the renderer's own lexer, so the two agree on them.
2. **Code set in from the edge was still read** under a heading with no
   blank line, under a bullet's words, and after a list had ended.
   Fixed by the same change, and by a rule for code under a bullet.
3. **Tables with no bar at the row's start, in a quote, or under a
   bullet were read across cells.** Fixed, but for one shape: a table
   with no bar at the row's start that is itself inside a list or a
   quote. Left.
4. **Round brackets holding spaces were taken for a link's address**:
   `handlers[name](event, data)`. Fixed: an address has no space in it.
5. **A change of the text's size did not redraw the headings.** Fixed.
6. **One pattern was still slow on a line of many thousand spaces.**
   Fixed: a fence is found without a pattern.
7. **Sentences now said more than the code did.** Fixed: the decision
   says where the two readings can still differ.
8. **No test covered these.** Added.

Left from this reading, as a suspicion the reviewer could not confirm:
a heading brought down to the text's size is still a little bolder than
the measure.

### The third reading

Six findings. The first three were held to be worth stopping for.

1. **The renderer's reading was dropped for any document with a link
   written by name, or a line starting with a tab**, since its pieces
   were then not the length of the text; 23 of 175 real files. The
   rules of a list were used for the whole text, and they hid code set
   in from the edge again. Fixed: each piece is placed where it is found
   in the text, with tabs counted as the renderer counts them. Tests
   hold both.
2. **The lexer is slow in the engine the app's window runs**, which the
   browser preview does not show: a tenth of a second at 35,000
   characters, a second or two near 60,000. Fixed: a text over 8,000
   characters is read in a worker, aside from the window, when the
   typing pauses. Seen in the preview that the worker reads a long
   page; its speed in the app's window was not seen.
3. **Between a change and the next reading, a move of the cursor drew
   the markup from marks of the text as it was**, a line off after
   Enter. Fixed: where each piece of markup is now is asked of the
   editor, which carries it along with every edit; a task's box is
   found in the line as it is. Seen: after Enter nothing moved.
4. **Shapes still read differently inside a list or a quote**: a table
   with no bar, a block of HTML, code set in after a quote's mark.
   Left, as the reviewer would: rare shapes.
5. **Five sentences behind the code.** Fixed.
6. **No test had a link written by name or a tab.** Added. The lexer's
   own time is not held by a test: it differs too much between engines
   to assert.

### The fourth reading

Six findings; one to stop for.

1. **A long document was drawn after its place had been put back**, so
   coming back to its tab, or going to a line in it, would land some
   lines off, by the height its headings gain. Fixed in two parts. A
   document drawn before is drawn at once with what it was drawn with,
   and whenever a reading is drawn the line at the top of the view is
   held where it is. That alone was not enough: checking it showed the
   page still slipping some twenty-five lines on every second return. The
   editor was set for prose (its face, its size, its wrapping) by one
   step, drawn by another and put back by a third, in whichever order
   they came, so the place was sometimes put back while the lines were
   still laid out as code. A file coming to the front is now one step
   in one order: its place kept, the editor set while it holds no file,
   the file taken up and drawn, then put where it was. Seen: a long
   page scrolled to its middle came back to the same line, at the same
   height, on eight returns in a row, wide and dark, then narrow and
   light.
2. **A reading has no time limit**, and a document waits for the one
   before it: the drawing can be seconds late on shapes built to be
   slow. The window is not held. Left.
3. **Two rare shapes still put the renderer's reading aside**: a line
   set in by tab, space, tab; and a paragraph followed by a line set in
   four and a rule. Left.
4. **A piece can be found inside a link's named address** and marks
   nothing there. Harmless. Left.
5. **The order in which readings are asked for and drawn has no test.**
   Left: it needs the editor.
6. **A comment said "well under a frame".** Fixed.

### The fifth reading

Three findings, of the fix to the fourth reading's first; one to stop
for.

1. **Taking the drawing off did not hold the place; putting it on
   did.** A document going from Edit to Read and back, or live preview
   switched off and on, would come back lower by the height its headings
   gain, and further on each round. Fixed: both hold the line at the
   top of the view. Seen: a long page scrolled to its middle showed the
   same line at the same height after four rounds of Edit, Read, Edit,
   and after live preview was switched off and on twice. This fix was
   read with the next commit's, in the tenth review's final reading.
2. **A long document changed while it was not in front is drawn from
   its old reading** until the new one is in. Left, and now said in
   ADR 0024.
3. **The record was one reading behind**, and "four or five parts"
   named no unit. Fixed.

## The tenth review: Markdown writing

Enter in a list and links followed from the text were read by a fresh
reviewer while staged. Nine findings, two to stop for.

1. **Enter was bound for every editor at once**, and the last editor
   made answered for all: in a split, Enter in the left group edited
   the right; after a split was closed, or in a review, Enter in a
   Markdown text did nothing. Fixed: the key is an action of its own
   editor, let go of with it. Seen: with a page in two groups Enter in
   each began the next item in that group, and still did in the one
   left after the other was closed.
2. **The hold on a line's markup during a Ctrl+click was dropped at
   once when the editor did not have the keyboard**: the blur of
   whatever had it was heard as the click called off. So was a drawing
   made during the click. Fixed: only the window's own blur ends the
   hold, and while it lasts the lines being written are those they
   were, whoever asks. Seen: with the keyboard in the Docs filter box,
   Ctrl+click on the second link of a line opened its file.
3. **A link to a heading, followed in one of two groups showing the
   page, moved the other group.** Fixed: a place in the same document
   is gone to in the editor the link was followed in.
4. **"Open the link at the cursor" worked only with the cursor in the
   link's words.** Fixed: the link is its words and its address, from
   bracket to bracket; and the command does nothing from behind a page
   or a table. A link just typed is not yet followed for about a
   second, until the editor has asked for the links again. Left.
5. **Some addresses led to the wrong place**: one in angle brackets
   with a space in it, and one with a backslash before a bracket.
   Fixed, with tests. A link to a folder still asks for a file that is
   a folder, as it does from the page. Left. A text that is no file
   (a proposal under review) has none of these links.
6. **A link to a heading was not matched as the page matches it.** A
   second heading of the same words is now reached by "-1", as on the
   page. A heading with markup in its words, or inside a quote, and a
   link written by reference are still not followed from the text.
   Left, and the ADR's note now says so.
7. **Enter, small cases.** A task's box at the very end of a line now
   counts as a box with no words; the space between the cursor and the
   words that go to the new item is dropped. Left: a number repeats
   when an item is added mid-list; code set in four or in a quote is
   not known to be code; an empty nested item ends the list instead of
   moving out one level.
8. **The editor's own underline on a followed link sat lower than the
   drawing's**, and ran under the markup. Fixed by two style rules;
   seen in the dark theme. With live preview off a followed link is
   underlined by the editor. Left.
9. **On macOS Ctrl+click is the menu**, and the hold may last until the
   next button comes up. Left; not seen, there being no Mac to see it
   on.

### The second reading

Of the fixes. Six findings, none in the code to stop for.

1. **The record said "see below" and nothing was below.** This section.
2. **The Enter action was listed among the editor's own commands for
   every file.** Fixed: it is there for a Markdown text that can be
   written, and nowhere else.
3. **The underline rules did not cover a link while Ctrl is held over
   it.** Fixed by naming that state too. Not seen: the rules were seen
   at rest, in the dark theme.
4. **A file already loaded, opened by following a link, may be drawn
   for an instant with the lines of the page it was followed from
   taken as the lines being written.** Left; not seen.
5. **"Open the link at the cursor", run from the menu bar or the
   command button, has no editor with the keyboard**, so a heading link
   in the second of two groups showing the page still moves the first.
   Left. A link to lines of its own document, from one line to another,
   lost its selection: fixed, it is shown as any file's lines are.
6. **Wording**, and a branch that could not be reached. Fixed.

### The final reading

Of the commit as it was made (`cfed5c0`), with the fixes of the second
reading in it, and of the one change in `e1ea695` that no reviewer had
read: the hold on the top line of the view when the drawing is put on
or taken off. Nothing to fix; three things named.

1. **A link from one line to another of its own page is shown as any
   file's lines are**, so with the page in two groups the first group
   takes it. That is the cost of keeping the lines selected, and the
   choice was the author's, not the reviewer's proposal. Left.
2. **The hold cuts short a smooth scroll that is under way when a
   drawing lands**: a long document's first reading arriving as the
   wheel is turned. Left; not seen.
3. **The record said the last fixes had not been read.** They have
   been now; this section takes that sentence's place.

Checked and found right: Enter falls through to the editor's own in a
script, in a file that cannot be written, and under a list of
suggestions; the hold moves nothing with no file in the editor, at a
change of file, or behind the Read view.

## The eleventh review: links by name

Read while staged. Five findings, two to stop for.

1. **The list offered on `[[` wrote a name that led to another
   document** for five of the example project's 32: every catalog
   called INDEX but the first, and a README below the top one. Fixed:
   the name written is one that means that document and no other, the
   path from the project's folder where the short name is taken; an
   exact path is matched before a bare file name; and where two answer
   alike, the order is the one links are offered in. With tests.
2. **Choosing a document could delete the rest of the line**, where the
   brackets were not yet closed. Fixed: what follows the cursor is taken
   for the rest of a name only in a link that is closed.
3. **A file whose name holds a hash or a bar cannot be named.** It is
   no longer offered. Left, and said in ADR 0025.
4. **The text works its links by name out again only when the text
   changes.** Left, and said in ADR 0025.
5. **The page and the text read a few shapes differently.** Left, and
   said in ADR 0025; the sentence about tables is corrected.

### The second reading

Of the fixes. One finding to stop for, two to name.

1. **The names were worked out over a list that left out the document
   being written in**, so in the top README the README of docs/ was
   still offered as `[[README]]`, which is the top one itself. Fixed:
   names are worked out among all the project's documents. With a test.
2. **Working the names out takes time that grows with the square of
   the number of documents.** Nothing at some thirty; left.
3. **A file with no ending and a dot in its name is offered by the part
   before the dot.** No such file is among a project's documents; left.

The fix to the first was read a third time, with the reviewer's script
run as the editor calls it, each of the example's 33 documents in turn
as the one being written in: of 1,056 names offered, none led anywhere
but the document offered. Nothing to hold the commit.

