# VS Code as the baseline: an audit

**Status:** checked in the running app, and being built from
(2026-11-19). Asked for by the user: "Audit SSL Studio against VS Code,
then build what the audit says to bring in."

**The standing choice.** SSL Studio stays its own application. VS Code is
the baseline for what a shell should do; this is not an extension and not
a fork ([why](#why-not-an-extension)).

**How it was made.** Each row was tried in the running app, in an instance
of its own on a scratch copy of the demo project: by its key, by its menu,
or by opening a file made for it (an image, a file of bytes, a file with
Windows line ends, a file in the one-byte Windows encoding). Where a
feature was plainly not there (no menu bar, nothing that runs git), that
is what was seen. The VS Code side is from knowledge of the product.
[What could not be checked](#not-checked) is listed at the end.

| Here | Means |
| --- | --- |
| Yes | It works as VS Code's does, or better |
| Partly | Some of it is there; the note says what is missing |
| No | It is not there |

| Verdict | Means |
| --- | --- |
| Have | Already here: nothing to do |
| Bring | To build now: people will reach for it and not find it |
| Later | Worth having, after the Bring rows |
| Leave | Not for this project, or another tool does it better |

Every Bring row is in [the build plan](#the-build-plan), with its size and
whether it is built.

## Window

| Feature | Here | Verdict | Note |
| --- | --- | --- | --- |
| Menu bar | Yes | Bring | Built: six menus across the top, by pointer, Alt and a letter, or F10; it can be hidden |
| Command palette | Yes | Have | Ctrl+Shift+P; what was used last comes first |
| Activity bar | Yes | Have | Ten panels, each movable to the other side |
| Status bar | Yes | Have | Project, server, agent, problems, cursor, language |
| Bottom panel | Yes | Have | Problems, Output, Call graph |
| Welcome page | Yes | Have | With the folders opened lately |
| Notifications | Yes | Have | An error stays until it is dismissed |
| Zen and full screen | No | Later | A command each |
| Several windows | No | Later | One folder to a window |
| Custom title bar | No | Leave | The system's own is enough |

## The menu bar, menu by menu

The bar holds VS Code's six menus that an editor needs (not Run and not
Terminal: see below). A menu holds what is already a command of the app or
of the text editor, and nothing of its own.

| Feature | Here | Verdict | Note |
| --- | --- | --- | --- |
| File menu | Yes | Bring | Built: new, open folder, save, revert, rename, trash, copy path, close, settings |
| Edit menu | Yes | Bring | Built: undo, redo, cut, copy, paste, find, replace, find in files, comment, format |
| Selection menu | Yes | Bring | Built: select all, grow and shrink, copy and move lines, cursors, occurrences |
| View menu | Yes | Bring | Built: commands, every panel, the bars, split, blocks, word wrap, zoom |
| Go menu | Yes | Bring | Built: file, symbol, line, definition, references, bracket, problems, tabs |
| Help menu | Yes | Bring | Built: all commands, keyboard shortcuts, the editor's commands, the versions |
| Save as | No | Later | Paste in the Explorer makes a copy under another name |
| Auto save | No | Later | Format on save and local history are here; saving is by hand |
| Untitled files | No | Leave | A file is made where it will live |
| Open recent | Partly | Later | On the Welcome page only; the File menu would list the folders |
| A guide in Help | No | Later | No guide for users is written yet; Help would open it |

## Right-click menus

| Feature | Here | Verdict | Note |
| --- | --- | --- | --- |
| Editor menu | Yes | Bring | Built: the app's own five (ask the agent, new question, new decision, Designer, region) |
| Tab menu | Yes | Bring | Built: close, others, to the right, all, pin, copy path, show in Explorer, to the side |
| Explorer menu | Yes | Bring | Built: new, cut, copy, paste, copy path, rename, move to trash |
| Docs row menu | Yes | Have | Open, set a state, update; by the menu key too |
| Health row menu | Yes | Have | Open, and what puts the row right |
| Search row menu | No | Later | Copy the line or its path |
| Problems row menu | No | Later | Copy the message |

## Tabs and groups

| Feature | Here | Verdict | Note |
| --- | --- | --- | --- |
| Close, close others | Yes | Have | Commands: close, close others, close all, reopen closed |
| Close to the right | Yes | Bring | Built: on the tab menu and as a command |
| Pin a tab | Yes | Bring | Built: stays first, kept across sessions, not closed until it is unpinned |
| Switch by Ctrl+Tab | Yes | Bring | Built: to the tab used before, and on through the order with Ctrl held |
| Drag tabs | Yes | Bring | Built: along the row and to the other group; Ctrl+Shift+PageUp and PageDown too |
| Split editor | Yes | Have | Side by side, Ctrl+\ |
| Unsaved mark | Yes | Have | And closing asks first |
| Tab overflow | Partly | Later | The row scrolls, and the open tab is brought into view; no list of the tabs that do not fit |
| Preview tabs | No | Later | One click opens a tab that the next click replaces |
| Grid layouts | No | Later | Two by two, three columns |
| Breadcrumbs | Yes | Have | Above the text, from the language server's symbols; Markdown shows its headings |
| Compare two files | Partly | Later | Review shows a diff for the agent's edits, not for any two files |

## Editing

| Feature | Here | Verdict | Note |
| --- | --- | --- | --- |
| Multi-cursor | Yes | Have | Ctrl+Shift+Down added a cursor; Ctrl+D took the next match |
| Find and replace | Yes | Have | Ctrl+F and Ctrl+H, in one file |
| Folding | Yes | Have | Marks in the gutter; fold commands in the editor's list |
| Go to bracket | Yes | Have | In the editor's list, Ctrl+Shift+\ |
| Move and copy lines | Yes | Have | In the editor's list |
| Minimap | Yes | Have | A setting; hidden when the editor is narrow |
| Format document | Yes | Have | The server's for SSL, here for JSON |
| Format on save | Yes | Have | A setting |
| Completion and hover | Yes | Have | From the language server |
| Snippets | Yes | Have | The Palette panel, and kept snippets |
| Word wrap toggle | Yes | Bring | Built: Alt+Z, a command, and a setting that is kept |
| Toggle comment | Yes | Have | Ctrl+/ is the editor's own, with each kind's marks; SSL is wrapped in `/*` and `;` |
| User snippets | Partly | Later | Kept in the knowledge base, not by prefix and Tab |
| Indent settings | Partly | Later | The editor converts tabs and spaces; nothing shows which a file uses |
| Sticky scroll | No | Later | The enclosing procedure stays at the top |
| Emmet | No | Leave | For HTML; forms are on hold |

## Go and the palette

| Feature | Here | Verdict | Note |
| --- | --- | --- | --- |
| Go to file | Yes | Have | Ctrl+P |
| Go to symbol | Yes | Have | In the file: Ctrl+Shift+O, the editor's own |
| Workspace symbols | Yes | Have | Ctrl+T, from the language server; the draft had this as missing |
| Go to line | Yes | Have | Ctrl+G went to line 40 |
| Go to definition | Yes | Have | From the language server |
| Peek, references | Yes | Have | From the language server |
| Rename symbol | Yes | Have | From the language server |
| Next problem | Yes | Have | F8, the editor's own |
| Palette prefixes | Yes | Bring | Built: one box; `>`, `@`, `#`, `:` and `?` say what it lists, and `name:12` opens at a line |
| Back and forward | Yes | Bring | Built: Alt+Left and Alt+Right, and in the Go menu; fifty places are kept |

## Explorer and files

| Feature | Here | Verdict | Note |
| --- | --- | --- | --- |
| Tree, new, rename | Yes | Have | And move to trash; F2 and Delete work on a row |
| Follows the editor | Yes | Have | The open file's row is marked |
| File watching | Yes | Have | The tree follows the disk |
| Copy path | Yes | Bring | Built: whole (Alt+Shift+C) and from the project's folder, as commands |
| Copy, cut, paste | Yes | Bring | Built: Ctrl+C, Ctrl+X, Ctrl+V and the row's menu; a copy beside itself is "… copy" |
| Drag to move | Yes | Bring | Built: a row onto a folder, or onto the tree for the workspace folder; it asks first |
| Reveal in system | No | Later | Open the folder in the file manager |
| Open editors list | No | Later | The tabs serve |
| Compare with saved | No | Later | Local history has snapshots; a diff against one is close |
| File nesting | No | Leave | Little to nest here |

## Search

| Feature | Here | Verdict | Note |
| --- | --- | --- | --- |
| Across files | Yes | Have | With match case and regular expressions |
| Whole word | Yes | Bring | Built: the third switch, "ab" |
| Include and exclude | Yes | Bring | Built: two boxes of patterns under the "…" switch: `*.ssl`, `src`, `docs/**/*.md` |
| Replace across files | Yes | Bring | Built: each match shown struck out beside what replaces it; written after asking |
| Results as a tree | Partly | Later | By file; not collapsible |
| Search history | No | Later | Up and down through what was searched |
| Search editor | No | Leave | The panel is enough |

## Source control

The app asks the user's own git, for what stays on this machine: what has
changed, a file as it was, and the steps of a commit. Nothing here
fetches, pulls or pushes
([ADR 0022](adr/0022-source-control-is-the-users-own-git-and-stays-on-this-machine.md)).

| Feature | Here | Verdict | Note |
| --- | --- | --- | --- |
| Branch in status bar | Yes | Bring | Built: the branch, how far it is from the one it follows, and how many files changed |
| Changes list | Yes | Bring | Built: a panel of what is staged and what is not, each with a letter for how it changed |
| Diff a change | Yes | Bring | Built: a row opens the file beside what git has of it, to look at and not to edit |
| Stage and commit | Yes | Bring | Built: stage and unstage one file or all, a message box, Commit (Ctrl+Enter) |
| Discard a change | Yes | Bring | Built: it asks first, and the file as it was goes into local history |
| Gutter marks | Yes | Bring | Built: new, changed and removed lines in the margin, against what is staged |
| Explorer colours | No | Later | Changed and new files tinted; cheap once the list exists |
| Switch branch | No | Later | After commit works well |
| Push and pull | No | Later | They reach a remote; after commit works well |
| Blame, timeline | No | Later | Local history covers part of a timeline |
| Merge editor | No | Leave | A terminal or another tool |

## Run and terminal

| Feature | Here | Verdict | Note |
| --- | --- | --- | --- |
| Output | Yes | Have | Errors and the log |
| Problems | Yes | Have | From the server and the document checks |
| Terminal | No | Later | Useful for git and scripts; a real piece of work |
| Test explorer | No | Later | The sandbox runner could feed one |
| Tasks | No | Leave | Nothing here builds |
| Debugger | No | Leave | SSL runs in STARLIMS; no debug adapter exists |

## Settings and shortcuts

| Feature | Here | Verdict | Note |
| --- | --- | --- | --- |
| Settings view | Yes | Have | For the user and for the project, with a search box |
| Settings as a file | Yes | Have | `project.toml` |
| Keyboard shortcuts | Yes | Have | Each can be set and cleared, with checks |
| Shortcut list | Yes | Have | The search box narrows it by a command's name; the draft had Partly |
| Themes | Yes | Have | Dark, light, imported |
| Zoom | Yes | Have | In, out, reset |
| Search by key | No | Later | Find the command a key runs |
| Chords | Partly | Later | The editor's own (Ctrl+K Ctrl+0) work; the app's keys are single |
| Profiles | No | Leave | One person, one setup |
| Settings sync | No | Leave | Needs an account |

## File types

| Feature | Here | Verdict | Note |
| --- | --- | --- | --- |
| Markdown preview | Yes | Have | With front matter and task boxes |
| CSV as a table | Yes | Have | Beyond VS Code's own |
| JSON, TOML, XML | Yes | Have | Coloured, outlined, checked |
| Line ends kept | Yes | Have | A file with Windows line ends was saved with them |
| Encoding kept | Yes | Have | A file in the one-byte Windows encoding read right (ADR 0019) |
| Images | Yes | Bring | Built: PNG, JPEG, GIF, WebP, BMP and ICO are shown, with their pixels and size |
| Binary files | Yes | Bring | Built: a file with a zero byte near its start says it is not text, and how large |
| Encoding shown | Yes | Bring | Built: in the status bar, for the open file |
| Line ends shown | Yes | Bring | Built: LF or CRLF in the status bar; a click changes them all |
| YAML | Partly | Later | No check: ADR 0018 |
| SQL | Partly | Later | Coloured and outlined; no formatting |
| Language picker | No | Later | The status bar says the language; it cannot be changed |
| PDF, Office files | No | Leave | Open in their own programs |

## Accessibility

| Feature | Here | Verdict | Note |
| --- | --- | --- | --- |
| Keyboard everywhere | Yes | Have | ADR 0010; row menus open by the menu key |
| Focus is visible | Yes | Have | A ring on what has the keyboard |
| Reduced motion | Yes | Have | The style honours the system's setting |
| Zoom | Yes | Have | The whole interface |
| Screen reader | Partly | Later | Rows and buttons are labelled; not tried with a reader |
| High contrast | Partly | Later | The editor has its own switch; the shell has no such theme |
| Tab moves focus | No | Later | A key to let Tab leave the editor |

## Extensions and AI

| Feature | Here | Verdict | Note |
| --- | --- | --- | --- |
| Chat | Yes | Have | The Agent panel, on opencode |
| Agent edits as diff | Yes | Have | The Review view |
| Inline suggestions | No | Later | Ghost text; costs tokens on every pause |
| Extensions | No | Leave | The point of staying an application is to own what is in it |

## The build plan

The Bring rows, in the order they are built: smallest and most used
first, source control as a step of its own. "Done" is Yes when a row is
built, looked at in the running app and tested; Skipped says why below.
Where a part of a row could not be tried, the text under its table says
which part and why. Each step says what was looked at.

### Step 1: small habits

| Feature | Size | Done | What it takes |
| --- | --- | --- | --- |
| Word wrap toggle | Small | Yes | Alt+Z, a command, kept as a setting |
| Toggle comment | Small | Yes | Nothing: it was there. The first check was wrong: the key had not reached the editor |
| Whole word | Small | Yes | A third switch in Search |
| Switch by Ctrl+Tab | Small | Yes | To the tab used before this one, and on through the order while Ctrl is held |
| Copy path | Small | Yes | Whole and from the project's folder; a command each |

In SSL a comment runs from `/*` to the next `;`, so the editor wraps a line
in both and a statement's own `;` leaves a second one until the comment is
taken off again. Doing better needs to know where a statement ends, which
is the language server's to say (ADR 0003). In an INI file the editor
writes `#`, not `;`: its own choice, left as it is.

A browser keeps Ctrl+Tab for its own tabs, so in the preview the key was
given to the page by a script, not pressed: held, it went through three
tabs, and let go and pressed again it went between the last two. In the
app's own window the key was not pressed. A tab closed, or shown some
other way, while Ctrl is held ends the walk; the next press starts again
from what is showing.

Looked at: the light theme at 720 wide and the dark theme at 1440 wide.

### Step 2: right-click menus

| Feature | Size | Done | What it takes |
| --- | --- | --- | --- |
| Tab menu | Small | Yes | Close, close others, close to the right, close all, pin, copy path, show in Explorer |
| Close to the right | Small | Yes | On the tab menu and as a command |
| Pin a tab | Small | Yes | Pinned tabs stay first and survive "close others" |
| Explorer menu | Small | Yes | Copy path came first; cut, copy and paste with step 5 |
| Editor menu | Small | Yes | Ask the agent, new question, new decision, copy for Designer, wrap in region |

A pinned tab is not closed by Ctrl+W, as in VS Code: the app says it is
pinned. It has a pin where the others have a cross, and its menu has
"Unpin" where theirs has "Close". Its unsaved changes show as a dot beside
the pin. The tab's menu also opens by the menu key and Shift+F10. "Close
all" on a tab's menu closes that group's tabs; the command "Close all
tabs" closes every group's.

Looked at: the light theme at 720 wide and the dark theme at 1440 wide.

### Step 3: the menu bar

| Feature | Size | Done | What it takes |
| --- | --- | --- | --- |
| Menu bar | Medium | Yes | A bar of menus, by pointer and by Alt and the arrow keys |
| File menu | Small | Yes | New, open folder, save, save all, revert, close, settings |
| Edit menu | Small | Yes | Undo, redo, cut, copy, paste, find, replace, comment |
| Selection menu | Small | Yes | Select all, cursors above and below, next match, move lines |
| View menu | Small | Yes | Palette, each panel, side bar, bottom panel, word wrap, zoom |
| Go menu | Small | Yes | File, symbol, line, definition, next problem; back and forward come with step 4 |
| Help menu | Small | Yes | Keyboard shortcuts, every command, the versions; there is no guide to open yet |

The bar is drawn in the window, not handed to the system, so that it is
the same in the app and in a browser
([ADR 0020](adr/0020-the-shell-does-what-vs-code-does-and-stays-its-own.md)).
An entry that cannot run now is grey, and the keyboard still lands on it:
the menu's last line then says why ("Open a file first", "For a file shown
as text"). The keys beside the text editor's own commands are read from
the editor, since they differ from system to system. With the keyboard in
a text box (a search, the agent's prompt), undo, redo, cut, copy, paste
and select all work on the box, and the entries that are for the code say
so. Paste from the menu needs a web view that lets a page read the
clipboard; where it does not, the entry is grey and the key still pastes.

Not tried: cut, copy and paste from the menu, because a test of them
writes over whatever the person at the machine has copied. Not seen: the
bar in the app's own window, and on a Mac.

Looked at: the dark theme at 1440 wide (every menu open), the light theme
at 720 and at 380 wide (a menu at the right edge is moved back inside the
window), and the dark theme at 720 wide.

### Step 4: finding one's way

| Feature | Size | Done | What it takes |
| --- | --- | --- | --- |
| Palette prefixes | Medium | Yes | One box: a name finds files, `>` commands, `@` symbols, `#` any symbol, `:` a line |
| Back and forward | Medium | Yes | Alt+Left and Alt+Right through where the cursor has been |

A place is kept when the cursor lands in another file, or ten lines or
more from where it was; nearer than that, the place moves with it. Going
back to a file that is open in the other group goes to that group; a
place in a file that can no longer be opened is passed over. On a
Mac the two keys are left to the text, where Alt and an arrow move by a
word: the commands are there to be given keys. The mouse's back and
forward buttons are not wired: they could not be tried here. Ctrl+G and
Ctrl+Shift+O still open the text editor's own boxes.

Looked at: the dark theme at 1440 wide and the light theme at 720 wide.

### Step 5: files by hand

| Feature | Size | Done | What it takes |
| --- | --- | --- | --- |
| Copy, cut, paste | Medium | Yes | In the tree; a paste beside the original is a copy with a new name |
| Drag to move | Medium | Yes | A row onto a folder; it asks before it moves |
| Drag tabs | Medium | Yes | Along the row, and onto the other group |

What is cut or copied in the tree is the app's own, not the system's
clipboard: a file on the system's clipboard is only its path as text. A
cut row is dimmed until it is pasted. A paste asks nothing (it was asked
for twice); a drop asks, because a drop is easily a slip of the hand. A
move is a rename, so open tabs, the places to go back to and the links in
the working documents follow it, and the language server is told which
scripts moved. Nothing is written over: a move onto a name that is taken
is refused, and a copy takes the name "… copy". A copy is of the file on
disk, and says so when the file has unsaved changes. A move to a path
that a tab is still open on (a file that was removed, kept for its
unsaved edits) is refused until that tab is closed.

A dragged tab lands where the mark is: the pinned stay first, so a tab
dropped among them stands after them. Dropped in the other group it
leaves this one, with its cursor where it was; a group left with no tabs
closes. The keyboard does the same along a row with Ctrl+Shift+PageUp and
Ctrl+Shift+PageDown, and to the other group with the command "Move tab to
the other group", which has no key of its own.

Not built: dragging a file in from outside the app, a folder that opens
when a drag rests on it, and a drop onto the editor to open a file there.

Looked at: the dark theme at 1440 wide and the light theme at 720 wide.
A row was dragged with the pointer and the move confirmed; the tabs were
dragged by events given to the page, not by the pointer.

### Step 6: files that are not text

| Feature | Size | Done | What it takes |
| --- | --- | --- | --- |
| Binary files | Small | Yes | Say what it is and how large; never an editor |
| Images | Small | Yes | Shown as a picture, with its size |
| Encoding shown | Small | Yes | In the status bar, for the open file |
| Line ends shown | Small | Yes | In the status bar; a click changes them |

A file is a picture by the end of its name, and other bytes by a zero
byte in its first 8000, which no text has. Neither is read as text, so
neither is put in an editor, and the backend refuses to write text over
either. A file whose first zero byte comes later than that still opens
as text, as it did before. Two things are let through: UTF-16 without its
mark (letters with a zero byte beside each) opens as it always did, to be
saved back byte for byte; and an editor may save the text it opened, even
after a zero byte was typed into it. An SVG is text and is edited as
text. A picture larger than 20 MB is not shown.

The encoding is what the file was read as, and it is saved as that
([ADR 0019](adr/0019-a-file-is-written-back-in-what-it-was-written-in.md)).
Changing it is still done outside the IDE. Changing the line ends is an
edit like any other: it can be undone, and it is kept by saving; "Revert"
puts the file's own line ends back with its text. A file
with both kinds of line end is shown as the kind it has most of, and
saving it writes that kind throughout: the editor's own way, from before
this step.

Looked at: the dark theme at 1440 wide and the light theme at 720 wide;
a picture, a file of bytes, a file in Windows-1252, and a file with CRLF
changed to LF and back by undo.

### Step 7: search and replace

| Feature | Size | Done | What it takes |
| --- | --- | --- | --- |
| Include and exclude | Medium | Yes | Which files to search, by pattern |
| Replace across files | Large | Yes | A preview of every change; nothing written until it is confirmed |

A pattern with no slash names a file or a folder wherever it is (`*.ssl`,
`tests`); one with a slash is read from the workspace's folder
(`src/DueDates`). The patterns narrow a search only while their boxes are
showing, so that nothing out of sight hides results.

The search, the preview and the replace find their matches with the one
expression, a line at a time. What is replaced is what is in the file
when the replace runs: that is what was listed, unless the file changed
since the search or holds unsaved changes (the search reads what is
saved), and the app says so when the two counts differ. A file with a tab
is changed in the editor, where undo takes it back: it is saved straight
away when it had nothing unsaved, and left unsaved when it had. A file
with no tab is changed on disk, in the encoding and with the line ends it
has. Every file that is written goes into its local history first, as it
was. With 2000 results or more only the first are listed, and the replace
is refused until the search is narrowed. In a regular expression the
replacement may name groups: `$1`, `$<name>`, `$&`.

Not built: leaving single results or files out of a replace, and
replacing one result at a time. A match of nothing (`^`, to put a mark
before every line) is replaced but has no mark in the preview; nor has a
match on a line longer than 400 characters, which the list cuts short.

Looked at: the dark theme at 1440 wide and the light theme at 720 wide.
In a copy of the demo, 26 matches in 4 files were replaced and replaced
back, the second time with one of the files holding unsaved changes.

### Step 8: source control

| Feature | Size | Done | What it takes |
| --- | --- | --- | --- |
| Branch in status bar | Small | Yes | The branch, and how many files have changed |
| Changes list | Large | Yes | A panel: changed, new and removed files, staged and not |
| Diff a change | Medium | Yes | A file against what git has of it, in the Review view |
| Stage and commit | Medium | Yes | Stage, unstage, a message, commit |
| Discard a change | Small | Yes | Back to what is staged of it, or the last commit, after asking |
| Gutter marks | Medium | Yes | Added, changed and removed lines in the editor's margin |

The backend runs the git that is on the machine; no library was added.
A commit is made by git itself, so it carries the user's own name and
runs whatever checks their repository runs; when git refuses, its words
are shown. The status is asked again when a file is saved or changes on
disk, and when the window is come back to (a commit made in a terminal
is not heard of otherwise).

Discarding lets go only what is not staged. A file git follows goes back
to what git has of it; a file git does not follow has nothing to go back
to, and goes to the trash. Where the file is text, it is kept as it was
in its local history first; the question's safe answer is the default.

A workspace may be a folder inside a larger repository. The panel lists
that folder's changes only, and each step acts on the file asked for. A
commit is the repository's, though, and takes whatever is staged above
the folder too: the panel says how many such files there are. A file's
name is only ever a name to git here: `report[1].ssl` is that file, not a
pattern.

The margin compares the text in the editor with what is staged, so
staging a change clears its marks. A new line is a solid bar, a changed
line a broken one, and a place where lines went a short stroke: the kinds
differ by shape, not by colour alone.

Not built, and listed above as Later: switching branches, push and pull,
colours in the Explorer, blame. Not built at all: starting a repository,
amending a commit, staging part of a file, stashes, and settling a
conflict (a file in conflict is listed, and a commit is refused until it
is settled elsewhere).

Looked at: the dark theme at 1440 wide and the light theme at 720 wide,
in a copy of the demo made a repository for the purpose: seven changes
listed, one compared, one staged from its row's menu, a commit made, one
change discarded, and the margin marks before and after. Not seen: the
panel in the app's own window, and a workspace inside a larger
repository (the backend's tests stage, unstage and discard in one; CI
runs them on Windows and macOS too).

## What the reviews found

Three reviews were made by a reader who was given the commits and not
the author's conclusions: after steps 1 to 3, after steps 4 to 6, and
after steps 7 and 8. What each confirmed was fixed before the next step;
the fixes are the commits named "defects found by a review".

What the last review found, and what was done about each:

- **Fixed.** Git steps in a workspace inside a larger repository; names
  read as patterns; a failed question taken for "not followed"; what is
  staged above the workspace's folder; a copy in local history of every
  file a replace writes; a replace in a file with no tab; a match of
  nothing beside a wide character; a file's mode on write; "still open
  in a tab" for a file with no tab; text that turns into bytes on disk;
  the cursor kept across a comparison; the commit's message kept across
  panels; the margin's marks blinking; the search kept across panels;
  the steps of a row shown for the pointer; the spoken status; the
  settings the git tests left behind; and every line of this document
  and of ADRs 0021 and 0022 that said what the code did not do.
- **Fixed in part, and said.** A replace acts on what is in the file
  when it runs. The app says when that is not what was listed, and a
  line too long for the list shows no replacement; it does not refuse.
- **Left, with the reason.** Git is given no time limit: a repository's
  own checks may rightly take long. Unstaging a renamed file leaves the
  old name removed and the new one unfollowed: that is git's own answer.
  A very large file with changes at both ends is marked changed
  throughout: comparing it line by line is too slow to do on every key.
  A copy that fails leaves the empty folder it made. Local history, the
  discard and the replace as the backend runs them have no test of
  their own: a test would write into the user's own settings folder.

## Why not an extension

The other way to get all of this is to build SSL Studio as a VS Code
extension. The shell would come for nothing, and the shell built here
(panels, tabs, dialogs, keyboard work, the look) would be lost or rebuilt.
The user's view, 2026-11-19: "I do like what we have built so far … If we
switch to an extension, I worry about losing what we have built."

One rule keeps that door open at no cost: nothing in `src/shared` depends
on the shell. It holds today.

## Not checked

Each step was looked at in the light theme at 720 wide and the dark theme
at 1440 wide as it was built. At the end, everything the steps added was
looked at again the other way round, in the dark theme at 720 wide and
the light theme at 1440 wide: the menu bar with an entry that cannot
run, the quick pick's list of what can be typed, a pinned tab and its
menu, a cut row and a drop mark in the Explorer, a picture, the status
bar's encoding and line ends, the replace preview with its file boxes,
the Source control panel with a row's own steps, a comparison, and the
margin's marks.

- A screen reader was not run against the app.
- The desktop app's own window (its title bar, its system file dialog)
  was not looked at: the checks were made in the preview, which serves the
  same view.
- Column selection by dragging: the keys that add cursors were tried, the
  drag was not.
- VS Code features with no row: remote development, notebooks, live
  share, ports, profiles' details. None looked worth one.
