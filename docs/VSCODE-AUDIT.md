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
[What could not be checked](#looked-at-and-not-checked) is listed at the end, and
[what was seen for each row](VSCODE-AUDIT-CHECKED.md) is a list of its
own: every row was tried again when the building was done.

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
| Status bar | Yes | Have | Folder, server, branch, agent, problems, place, cursor, encoding, line ends, language |
| Bottom panel | Yes | Have | Problems and Output; Ctrl+J shows and hides it. The call graph is a view of its own |
| Welcome page | Yes | Have | With the folders opened lately |
| Notifications | Yes | Have | An error stays until it is dismissed |
| Zen and full screen | No | Later | A command each |
| Several windows | No | Later | One folder to a window |
| Custom title bar | No | Leave | The system's own is enough |
| Layout controls | Yes | Bring | Built, asked for in use: side, bottom and right panel buttons in the menu bar, and a Layout menu |

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
| Docs row menu | Yes | Have | Open, set a state, update, and a file's own (paths, name, rename, trash) on every row |
| Health row menu | Yes | Have | Open, and what puts the row right |
| Search row menu | No | Later | Copy the line or its path |
| Problems row menu | No | Later | Copy the message |
| Page menu | Yes | Bring | Built, asked for in use: a rendered document's own (copy, link, edit the text, paths, name) |
| Text box menu | Yes | Bring | Built: the app's own cut, copy, paste and select all; the web view's menu never opens (ADR 0023) |

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
| Preview tabs | Yes | Bring | Built, asked for in use: one click opens a tab, in italics, that the next click replaces |
| Grid layouts | No | Later | Two by two, three columns |
| Breadcrumbs | Yes | Have | Above the text, from the language server's symbols; Markdown shows its headings |
| Compare two files | Partly | Later | A file compares with git's, a snapshot with the editor; not any two files |

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
| Sticky scroll | Yes | Have | The enclosing regions and procedure stay at the top; the audit had missed it |
| Emmet | No | Leave | For HTML; forms are on hold |
| Scroll past the end | Yes | Bring | Built, asked for in use: the last line can be brought to the top of the view |

## Go and the palette

| Feature | Here | Verdict | Note |
| --- | --- | --- | --- |
| Go to file | Yes | Have | Ctrl+P |
| Go to symbol | Yes | Have | In the file: Ctrl+Shift+O, the editor's own |
| Workspace symbols | Yes | Have | Ctrl+T, from the language server; the draft had this as missing |
| Go to line | Yes | Have | Ctrl+G went to line 40 |
| Go to definition | Yes | Have | From the language server; in the Go menu and on the right-click menu |
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
| File watching | Partly | Later | Misses a file git puts back and later changes to a new file; needs a check of its own |
| Copy path | Yes | Bring | Built: whole (Alt+Shift+C), from the project's folder, and the name alone, as commands |
| Sections fold | Yes | Bring | Built, asked for in use: Docs groups and tickets fold and stay folded; collapse all, expand all |
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
| Search by key | Yes | Have | Typing a key in Settings' search finds its command; the first check missed it |
| Chords | Partly | Later | The editor's own (Ctrl+K Ctrl+0) work; the app's keys are single |
| Profiles | No | Leave | One person, one setup |
| Settings sync | No | Leave | Needs an account |

## File types

| Feature | Here | Verdict | Note |
| --- | --- | --- | --- |
| Markdown preview | Yes | Have | With front matter and task boxes |
| Markdown as written | Yes | Bring | Built, asked for in use: the text drawn as it is written; markup hidden off the cursor's line |
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

### Step 9: what the first use asked for

Added after the eight steps, from what the user saw and asked for when
trying the app.

| Feature | Size | Done | What it takes |
| --- | --- | --- | --- |
| Layout controls | Medium | Yes | Three buttons and a menu in the menu bar; two new commands |
| Page menu | Small | Yes | A menu on a rendered document, by right-click or the menu key |
| Text box menu | Medium | Yes | One handler for the window; a menu that leaves the keyboard in the box |
| Sections fold | Medium | Yes | A heading that is a row to the keyboard; what is shut is kept |
| Scroll past the end | Small | Yes | One option of the editor |
| Copy file name | Small | Yes | A command, and an entry on three menus |
| Preview tabs | Medium | Yes | A tab opened for a look; a double click, an edit or a pin keeps it |
| Markdown as written | Large | Yes | The marks found line by line; drawn by the editor's own decorations |

Two things were put right with these, not new features: every small
graphic is now from the editor's icon font or drawn by a style rule (the
unsaved mark was an oval), and the strip of regions is wider and is not
taken from the pointer by the bar that resizes the side panel. The rules
are in [ADR 0023](adr/0023-the-windows-graphics-and-menus-are-its-own.md).
Copy file name is part of the Copy path row.

Looked at: 720 and 1440 wide, each in the light and the dark theme,
before the commit. A seventh review was made of the commit; what it
found is in [the list](VSCODE-AUDIT-REVIEWS.md#the-seventh-review-what-the-first-use-asked-for).

## What the reviews found

A review was made after every two or three steps, by a reader who was
given the commits and not the author's conclusions: of steps 1 to 3, of
steps 4 to 6, and of steps 7 and 8. The first two were read while the
next step was being built, so their fixes went in one step late: those
for steps 1 to 3 after step 4 and before step 5, those for steps 4 to 6
after step 7 and before step 8. The third's went in after step 8. The
fixes are the commits named "defects found by a review".

Each step was looked at before its commit at a narrow and a wide
layout, in the light and the dark theme: light at 720 wide and dark at
1440 wide, as the step's commit or its section here says. All four
pairings were looked at when the building was done.

Every finding of the reviews, with what was done about it and in
which commit, is in [a list of its own](VSCODE-AUDIT-REVIEWS.md). In
short: of the third review's 42 findings, 33 were fixed, 5 were fixed in
part and say what was left, and 4 were left, each with its reason.

When the building was done, each fix was shown working by itself: in the
running app where it can be seen there, by its named test where it
cannot. That list says which, fix by fix. Showing them found two more
defects, both fixed: a file that was only peeked at kept its old text
after it was removed by another program, and gave that text to a file
renamed onto its path; and a small file of bytes was said to be "4 bytes
of bytes". The first of those fixes changed code after the last review,
so a fourth review was made of it alone, a fifth of the fixes that came
of the fourth, and a sixth of those that came of the fifth. They
confirmed five, six and four findings. All were fixed but two small ones
of the last, which are left with their reasons; the sixth review found
nothing that loses work.

A seventh review was made of step 9's commit (`3905b68`), before
anything else was built on it. It had fifteen findings, none that loses
work. Thirteen were fixed, one was fixed in part, and one was fixed with
a part left on purpose. The reviewer then read those fixes before they
were committed and found eight more things in them, which were fixed
too. Two sessions had made those fixes at once in one folder, so the
commit that took both was read once more, by a reviewer for each
session. One found eleven things, eight fixed and three left with their
reasons. The other found eleven: two of them the first had fixed, in
whole or in part; one is left (a pushed commit's message is not
rewritten), one is left in part, one is answered by a note; the rest
are fixed.

An eighth review was made of what was asked for next (the Docs panel's
menus and folding, preview tabs) while it was staged: thirteen findings,
all fixed before the commit. A ninth was made of Markdown drawn as it
is written, and repeated on each round of fixes: eleven findings, three
of which would have hidden what the user wrote, then eight, six, six
and three. All are fixed but a few small ones, which are left and named.

## Why not an extension

The other way to get all of this is to build SSL Studio as a VS Code
extension. The shell would come for nothing, and the shell built here
(panels, tabs, dialogs, keyboard work, the look) would be lost or rebuilt.
The user's view, 2026-11-19: "I do like what we have built so far … If we
switch to an extension, I worry about losing what we have built."

One rule keeps that door open at no cost: nothing in `src/shared` depends
on the shell. It holds today.

## Looked at, and not checked

Each step was looked at in the light theme at 720 wide and the dark theme
at 1440 wide as it was built. When the building was done, every step was
looked at again in all four: 720 and 1440 wide, each in the light and the
dark theme. In none of them did anything run off the window, a menu fall
outside it, or text become unreadable.

| Step | Seen in all four |
| --- | --- |
| 1, small habits | Word wrap on, with a long line wrapped at 720; the search's three switches |
| 2, menus | The editor's menu with the app's five entries; a pinned tab's menu, in the pass before |
| 3, the menu bar | The File menu open from Alt+F, inside the window, over the Explorer |
| 4, finding | The quick pick's list of what can be typed, from "?" |
| 5, files by hand | A cut row; a file dragged over a folder, which is outlined; the line where a dragged tab would land |
| 6, not text | A picture with its size; the status bar saying Picture, or UTF-8 and LF for a text |
| 7, replace | Old and new words in each result; the two file boxes, narrowing a search to the files chosen |
| 8, source control | The panel with its rows' buttons, a comparison, the margin's marks |

At 720 wide a comparison is one column, the old lines above the new; at
1440 it is two. In the pictures at 1440 the cut row lay under the open
File menu, and was read from the page; it was seen by eye in all four in
the passes before. The menu bar was also seen with no folder open, where
each entry says what it needs. The two drop marks were held still for
the look by drag events made by script, since a drag by hand cannot be;
the drop itself was made by script when step 5 was built.

Not checked:

- A screen reader was not run against the app.
- The desktop app's own window (its title bar, its system file dialog)
  was not looked at: the checks were made in the preview, which serves the
  same view.
- Column selection by dragging: the keys that add cursors were tried, the
  drag was not.
- An agent's edit in the Review view: the view was seen with a local
  history snapshot, and no agent was run, since the instance used for the
  checks can reach paid models.
- VS Code features with no row: remote development, notebooks, live
  share, ports, profiles' details. None looked worth one.

Found and not fixed: the file watching, which is older than this work,
misses some changes made by other programs. On Linux with the runtime in
use (Bun 1.3.3), a file that `git checkout` puts back is not reported,
and neither is a later change to a file made after the app started. The
tree and an open tab then show the old state, and the language server
does not learn of a script that came back, until the folder is opened
again. The row is now Partly, for later: it needs a check that does not
rest on the runtime's watching alone.

Also found and not fixed: a folder left with some six hundred tabs open
does not come back usable. The window stopped answering while they were
restored; with sixty it came up at once. Nobody keeps six hundred tabs,
and the row for many tabs (Tab overflow) is already for later.
