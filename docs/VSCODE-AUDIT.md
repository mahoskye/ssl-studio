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
| Menu bar | No | Bring | No bar at all: a command is found in the palette or not at all |
| Command palette | Yes | Have | Ctrl+Shift+P; what was used last comes first |
| Activity bar | Yes | Have | Nine panels, each movable to the other side |
| Status bar | Yes | Have | Project, server, agent, problems, cursor, language |
| Bottom panel | Yes | Have | Problems, Output, Call graph |
| Welcome page | Yes | Have | With the folders opened lately |
| Notifications | Yes | Have | An error stays until it is dismissed |
| Zen and full screen | No | Later | A command each |
| Several windows | No | Later | One folder to a window |
| Custom title bar | No | Leave | The system's own is enough |

## The menu bar, menu by menu

There is no menu bar. This says what each of VS Code's menus holds, and
how much of it the app already does by a command or a key.

| Feature | Here | Verdict | Note |
| --- | --- | --- | --- |
| File menu | Partly | Bring | New, open folder, save, save all, revert, close are commands; no menu |
| Edit menu | Partly | Bring | Undo, cut, copy, paste, find, replace are keys in the editor; no menu |
| Selection menu | Partly | Bring | Cursors and lines move by key; no menu to find them in |
| View menu | Partly | Bring | Every panel has a command; no menu |
| Go menu | Partly | Bring | File, symbol, line, definition are keys; back and forward are missing |
| Help menu | No | Bring | Nothing says the version, the keys, or where the guide is |
| Save as | No | Later | Paste in the Explorer makes a copy under another name |
| Auto save | No | Later | Format on save and local history are here; saving is by hand |
| Untitled files | No | Leave | A file is made where it will live |
| Open recent | Partly | Later | On the Welcome page only; the File menu links to it |

## Right-click menus

| Feature | Here | Verdict | Note |
| --- | --- | --- | --- |
| Editor menu | Partly | Bring | Definition, references, peek, rename, format, cut, copy, paste; none of the app's own |
| Tab menu | No | Bring | A right-click on a tab does nothing |
| Explorer menu | Partly | Bring | New file, new folder, rename, trash; no copy path, cut, copy, paste |
| Docs row menu | Yes | Have | Open, set a state, update; by the menu key too |
| Health row menu | Yes | Have | Open, and what puts the row right |
| Search row menu | No | Later | Copy the line or its path |
| Problems row menu | No | Later | Copy the message |

## Tabs and groups

| Feature | Here | Verdict | Note |
| --- | --- | --- | --- |
| Close, close others | Yes | Have | Commands: close, close others, close all, reopen closed |
| Close to the right | No | Bring | Goes on the tab menu |
| Pin a tab | No | Bring | A pinned tab stays first and is not closed with the others |
| Switch by Ctrl+Tab | Yes | Bring | Built: to the tab used before, and on through the order with Ctrl held |
| Drag tabs | No | Bring | A tab cannot be dragged: not along the row, not to the other group |
| Split editor | Yes | Have | Side by side, Ctrl+\ |
| Unsaved mark | Yes | Have | And closing asks first |
| Tab overflow | Yes | Have | A button lists the tabs that do not fit |
| Preview tabs | No | Later | One click opens a tab that the next click replaces |
| Grid layouts | No | Later | Two by two, three columns |
| Breadcrumbs | Partly | Later | Markdown shows its headings; SSL does not show where the cursor is |
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
| Toggle comment | Yes | Bring | Built: Ctrl+/ in SQL, YAML, INI, XML, Markdown; SSL as the editor wraps it |
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
| Palette prefixes | No | Bring | Three boxes, each its own; `>`, `@` and `:` typed into Go to file find nothing |
| Back and forward | No | Bring | Alt+Left after a jump left the cursor where it was |

## Explorer and files

| Feature | Here | Verdict | Note |
| --- | --- | --- | --- |
| Tree, new, rename | Yes | Have | And move to trash; F2 and Delete work on a row |
| Follows the editor | Yes | Have | The open file's row is marked |
| File watching | Yes | Have | The tree follows the disk |
| Copy path | Yes | Bring | Built: whole (Alt+Shift+C) and from the project's folder, as commands |
| Copy, cut, paste | No | Bring | Files and folders in the tree |
| Drag to move | No | Bring | A row cannot be dragged; moving is a rename with a folder in the name |
| Reveal in system | No | Later | Open the folder in the file manager |
| Open editors list | No | Later | The tabs serve |
| Compare with saved | No | Later | Local history has snapshots; a diff against one is close |
| File nesting | No | Leave | Little to nest here |

## Search

| Feature | Here | Verdict | Note |
| --- | --- | --- | --- |
| Across files | Yes | Have | With match case and regular expressions |
| Whole word | Yes | Bring | Built: the third switch, "ab" |
| Include and exclude | No | Bring | One box, no way to say which files |
| Replace across files | No | Bring | With a preview before anything is written |
| Results as a tree | Partly | Later | By file; not collapsible |
| Search history | No | Later | Up and down through what was searched |
| Search editor | No | Leave | The panel is enough |

## Source control

Nothing in the app runs git. Every row was seen as missing.

| Feature | Here | Verdict | Note |
| --- | --- | --- | --- |
| Branch in status bar | No | Bring | Which branch, and whether anything has changed |
| Changes list | No | Bring | What is changed, new and removed since the last commit |
| Diff a change | No | Bring | The Review view can show it |
| Stage and commit | No | Bring | With a message box |
| Discard a change | No | Bring | It asks first: the work is lost |
| Gutter marks | No | Bring | Added, changed and removed lines beside the code |
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
| Images | No | Bring | A PNG opened as lines of unreadable text, in an editor that can save |
| Binary files | No | Bring | A file of bytes opened the same way |
| Encoding shown | No | Bring | Nothing says what a file is written in |
| Line ends shown | No | Bring | Nothing says which line ends a file has, or changes them |
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

### Step 1: small habits

| Feature | Size | Done | What it takes |
| --- | --- | --- | --- |
| Word wrap toggle | Small | Yes | Alt+Z, a command, kept as a setting |
| Toggle comment | Small | Yes | Ctrl+/ comments lines in SQL and the other document kinds; SSL keeps the editor's way |
| Whole word | Small | Yes | A third switch in Search |
| Switch by Ctrl+Tab | Small | Yes | To the tab used before this one, and back; the key itself was not pressed in the preview |
| Copy path | Small | Yes | Whole and from the project's folder; a command each |

In SSL a comment runs from `/*` to the next `;`, so the editor wraps a line
in both and a statement's own `;` leaves a second one until the comment is
taken off again. Doing better needs to know where a statement ends, which
is the language server's to say (ADR 0003).

### Step 2: right-click menus

| Feature | Size | Done | What it takes |
| --- | --- | --- | --- |
| Tab menu | Small | No | Close, close others, close to the right, close all, pin, copy path, show in Explorer |
| Close to the right | Small | No | On the tab menu and as a command |
| Pin a tab | Small | No | Pinned tabs stay first and survive "close others" |
| Explorer menu | Small | No | Copy path, and what step 5 adds |
| Editor menu | Small | No | Ask the agent, new question, copy for Designer, wrap in region |

### Step 3: the menu bar

| Feature | Size | Done | What it takes |
| --- | --- | --- | --- |
| Menu bar | Medium | No | A bar of menus, by pointer and by Alt and the arrow keys |
| File menu | Small | No | New, open folder, save, save all, revert, close, settings |
| Edit menu | Small | No | Undo, redo, cut, copy, paste, find, replace, comment |
| Selection menu | Small | No | Select all, cursors above and below, next match, move lines |
| View menu | Small | No | Palette, each panel, side bar, bottom panel, word wrap, zoom |
| Go menu | Small | No | File, symbol, line, definition, back, forward, next problem |
| Help menu | Small | No | Welcome, keyboard shortcuts, the guide, the version |

### Step 4: finding one's way

| Feature | Size | Done | What it takes |
| --- | --- | --- | --- |
| Palette prefixes | Medium | No | One box: a name finds files, `>` commands, `@` symbols, `#` any symbol, `:` a line |
| Back and forward | Medium | No | Alt+Left and Alt+Right through where the cursor has been |

### Step 5: files by hand

| Feature | Size | Done | What it takes |
| --- | --- | --- | --- |
| Copy, cut, paste | Medium | No | In the tree; a paste beside the original is a copy with a new name |
| Drag to move | Medium | No | A row onto a folder; it asks before it moves |
| Drag tabs | Medium | No | Along the row, and onto the other group |

### Step 6: files that are not text

| Feature | Size | Done | What it takes |
| --- | --- | --- | --- |
| Binary files | Small | No | Say what it is and how large; never an editor |
| Images | Small | No | Shown as a picture, with its size |
| Encoding shown | Small | No | In the status bar, for the open file |
| Line ends shown | Small | No | In the status bar; a click changes them |

### Step 7: search and replace

| Feature | Size | Done | What it takes |
| --- | --- | --- | --- |
| Include and exclude | Medium | No | Which files to search, by pattern |
| Replace across files | Large | No | A preview of every change; nothing written until it is confirmed |

### Step 8: source control

| Feature | Size | Done | What it takes |
| --- | --- | --- | --- |
| Branch in status bar | Small | No | The branch, and how many files have changed |
| Changes list | Large | No | A panel: changed, new and removed files, staged and not |
| Diff a change | Medium | No | A file against its last commit, in the Review view |
| Stage and commit | Medium | No | Stage, unstage, a message, commit |
| Discard a change | Small | No | Back to the last commit, after asking |
| Gutter marks | Medium | No | Added, changed and removed lines in the editor's margin |

## Why not an extension

The other way to get all of this is to build SSL Studio as a VS Code
extension. The shell would come for nothing, and the shell built here
(panels, tabs, dialogs, keyboard work, the look) would be lost or rebuilt.
The user's view, 2026-11-19: "I do like what we have built so far … If we
switch to an extension, I worry about losing what we have built."

One rule keeps that door open at no cost: nothing in `src/shared` depends
on the shell. It holds today.

## Not checked

- A screen reader was not run against the app.
- The desktop app's own window (its title bar, its system file dialog)
  was not looked at: the checks were made in the preview, which serves the
  same view.
- Column selection by dragging: the keys that add cursors were tried, the
  drag was not.
- VS Code features with no row: remote development, notebooks, live
  share, ports, profiles' details. None looked worth one.
