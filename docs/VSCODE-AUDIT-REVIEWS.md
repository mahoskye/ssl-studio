# What the reviews found, finding by finding

Three reviews of the work on [the audit](VSCODE-AUDIT.md) were made by a
reader who was given the commits and not the author's conclusions. This
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
