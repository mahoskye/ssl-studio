# VS Code as the baseline: an audit

**Status:** draft for review (2026-11-19). Asked for by the user: "a full
audit of the vs code features and what makes sense to bring into this
project". Nothing here is decided.

**How it was made.** The "Here" column was read from this project's
commands, panels and source files, not by trying each feature in the
running app. The VS Code side is from knowledge of the product, not from
its source. Where a feature comes with the Monaco editor, "Here" says so;
whether each is switched on was not checked one by one.

**The standing choice.** The app stays its own application
([the user's words](#why-not-an-extension)), and VS Code is the baseline
for what a shell should do. Each row says whether to bring a feature in.

| Verdict | Means |
| --- | --- |
| Bring | Worth building soon: people will reach for it and not find it |
| Later | Worth having, after the Bring rows |
| Leave | Not for this project, or another tool does it better |

## Window and menus

| Feature | Here | Verdict | Note |
| --- | --- | --- | --- |
| Menu bar | No | Bring | File, Edit, Selection, View, Go, Help: mostly wiring of commands that exist |
| Command palette | Yes | Keep | "Show all commands" |
| Activity bar | Yes | Keep | Nine panels, movable left and right |
| Status bar | Yes | Keep | Project, server, agent, problems, cursor, language |
| Bottom panel | Yes | Keep | Problems, Output, Call graph |
| Zen and full screen | No | Later | A single command each |
| Several windows | No | Later | One folder to a window today |
| Welcome page | Yes | Keep | Start and Welcome views |
| Notifications | Yes | Keep | Errors stay until dismissed |
| Custom title bar | No | Leave | The system's own is enough |

## Tabs and groups

| Feature | Here | Verdict | Note |
| --- | --- | --- | --- |
| Close, close others | Yes | Keep | And close all, reopen closed |
| Split editor | Yes | Keep | Side by side |
| Tab context menu | Partly | Bring | Add: close to the right, copy path, reveal in Explorer |
| Pin a tab | No | Bring | Small, and expected |
| Preview tabs | No | Later | A single click opens in a tab that the next click replaces |
| Drag tabs to split | Not checked | Bring | Dragging between groups is the usual way to arrange them |
| Grid layouts | No | Later | Two by two, three columns |
| Breadcrumbs | Partly | Later | Markdown shows its headings; SSL does not show its region path |
| Unsaved mark | Yes | Keep | And the close guard asks first |
| Compare two files | Partly | Later | Review shows a diff for agent edits; not for any two files |

## Editing

| Feature | Here | Verdict | Note |
| --- | --- | --- | --- |
| Multi-cursor | Monaco | Keep | Comes with the editor |
| Find and replace | Monaco | Keep | In one file |
| Folding | Monaco | Keep | Regions come from the language server |
| Minimap | Yes | Keep | A setting, hidden when narrow |
| Format document | Yes | Keep | The server's for SSL, here for JSON |
| Format on save | Yes | Keep | A setting |
| Snippets | Yes | Keep | The Palette panel, and kept snippets |
| User snippets | Partly | Later | Kept in the knowledge base, not by prefix and Tab |
| Word wrap toggle | Not checked | Bring | Alt+Z is muscle memory |
| Sticky scroll | No | Later | The enclosing procedure stays at the top |
| Emmet | No | Leave | For HTML; forms are on hold |
| Column selection | Monaco | Keep | Comes with the editor |

## Go and palette

| Feature | Here | Verdict | Note |
| --- | --- | --- | --- |
| Go to file | Yes | Keep | Ctrl+P |
| Go to symbol | Yes | Keep | In the open file |
| Palette prefixes | No | Bring | One box: `>` commands, `@` symbols, `:` line, `#` any symbol |
| Go to line | Not checked | Bring | Ctrl+G, and `:` in the box |
| Workspace symbols | No | Bring | Needs the server to list them across files |
| Go to definition | Yes | Keep | From the language server |
| Peek, references | Yes | Keep | From the language server |
| Back and forward | Not checked | Bring | Alt+Left returns to where a jump came from |
| Recent folders | Partly | Later | Open folder; a recent list is small |
| Rename symbol | Yes | Keep | From the language server |

## Explorer and files

| Feature | Here | Verdict | Note |
| --- | --- | --- | --- |
| Tree, new, rename | Yes | Keep | And move to trash |
| Context menu | Yes | Keep | Also by the menu key |
| Drag to move | No | Bring | Moving today is a rename with a folder in the name |
| Copy, cut, paste | No | Bring | Files in the tree |
| Copy path | No | Bring | Whole and relative |
| Reveal in system | No | Later | Open the folder in the file manager |
| Open editors list | No | Later | The tabs serve |
| File nesting | No | Leave | Little to nest here |
| Compare with saved | No | Later | Local history has snapshots; a diff against one is close |
| File watching | Yes | Keep | The tree follows the disk |

## Search

| Feature | Here | Verdict | Note |
| --- | --- | --- | --- |
| Across files | Yes | Keep | With regular expressions |
| Replace across files | No | Bring | With a preview before anything is written |
| Include and exclude | Not checked | Bring | Patterns for which files |
| Search editor | No | Leave | The panel is enough |
| Results as a tree | Partly | Later | By file, collapsible |

## Source control

| Feature | Here | Verdict | Note |
| --- | --- | --- | --- |
| Changes list | No | Bring | The largest piece of work in this audit |
| Diff a change | No | Bring | The Review view can show it |
| Stage and commit | No | Bring | With a message box |
| Gutter marks | No | Bring | Added, changed, removed lines |
| Branch in status bar | No | Bring | And switching |
| Push and pull | No | Later | After commit works well |
| Blame, timeline | No | Later | Local history covers part of timeline |
| Merge editor | No | Leave | A terminal or another tool, at first |
| Explorer colours | No | Later | Changed and new files tinted |

## Run and terminal

| Feature | Here | Verdict | Note |
| --- | --- | --- | --- |
| Terminal | No | Later | Useful for git and scripts; a real piece of work |
| Tasks | No | Leave | Nothing here builds |
| Debugger | No | Leave | SSL runs in STARLIMS; no debug adapter exists |
| Test explorer | No | Later | The sandbox runner could feed one |
| Output | Yes | Keep | Errors and the log |
| Problems | Yes | Keep | From the server and the document checks |

## Settings

| Feature | Here | Verdict | Note |
| --- | --- | --- | --- |
| Settings view | Yes | Keep | User and project |
| Settings as a file | Yes | Keep | `project.toml` |
| Keyboard shortcuts | Yes | Keep | Rebindable, with checks |
| Shortcut list | Partly | Bring | A searchable list of every command and its key |
| Themes | Yes | Keep | Dark, light, imported |
| Profiles | No | Leave | One person, one setup |
| Settings sync | No | Leave | Needs an account |
| Zoom | Yes | Keep | In, out, reset |

## File types

| Feature | Here | Verdict | Note |
| --- | --- | --- | --- |
| Markdown preview | Yes | Keep | With front matter and task boxes |
| CSV as a table | Yes | Keep | Beyond VS Code's own |
| JSON, TOML, XML | Yes | Keep | Coloured, outlined, checked |
| YAML | Partly | Later | No check: ADR 0018 |
| SQL | Partly | Later | Coloured and outlined; no formatting |
| Images | Not checked | Bring | Open a PNG and see it |
| PDF, Office files | No | Leave | Open in their own programs |
| Binary files | Not checked | Bring | Say what it is; never show bytes as text |
| Encoding, line ends | Partly | Bring | Kept on save; shown and changed from the status bar |
| Language picker | No | Later | Say what language a file is |

## Extensions and AI

| Feature | Here | Verdict | Note |
| --- | --- | --- | --- |
| Extensions | No | Leave | The point of staying an application is to own what is in it |
| Chat | Yes | Keep | The Agent panel, on opencode |
| Inline suggestions | No | Later | Ghost text; costs tokens on every pause |
| Agent edits as diff | Yes | Keep | The Review view |

## A suggested order

1. **Palette prefixes, go to line, back and forward.** Small, and used
   every minute.
2. **Menu bar.** Mostly wiring; it also makes every command findable.
3. **Tab and Explorer menus:** pin, close to the right, copy path, cut,
   copy and paste, drag to move.
4. **Replace across files,** with a preview.
5. **Encoding and line ends in the status bar; images and binary files.**
6. **Source control.** Changes, diff, stage, commit, gutter marks, branch.
   The largest by far, and the one most worth planning on its own.

## Why not an extension

The other way to get all of this is to build SSL Studio as a VS Code
extension. The shell would come for nothing, and the shell built here
(panels, tabs, dialogs, keyboard work, the look) would be lost or rebuilt.
The user's view, 2026-11-19: "I do like what we have built so far … If we
switch to an extension, I worry about losing what we have built."

One rule keeps that door open at no cost: nothing in `src/shared` depends
on the shell. It holds today.

## Not checked

- Rows marked "Not checked" need a look in the running app.
- Whether each Monaco feature is switched on.
- VS Code features not listed: remote development, notebooks, live share,
  ports, timeline details, accessibility modes. None looked worth a row.
