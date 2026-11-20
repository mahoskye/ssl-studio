# What was seen for each row of the audit

Every row of [the audit](VSCODE-AUDIT.md) was tried again in the running
app when the building was done (2026-11-19), in an instance of its own on
a scratch copy of the demo project, made a git repository for the
purpose. This says, row by row, what was seen. Four rows were wrong and
were corrected: the bottom panel has two tabs, Settings' search does
find a command by its key, the file watching misses some changes made by
other programs, and (seen later, in use) the editor does keep the
enclosing lines at the top as it scrolls.

"The list" is the app's command list (84 commands, read in full). "The
editor's list" is the text editor's own (F1), asked term by term. The rows
first left untried (a conflict, a PDF and a Word file, TOML, the editor's
right-click menu, the Review view) were tried in a last pass, on files
and a conflict made for it.

## Window

| Row | Seen |
| --- | --- |
| Menu bar | Six names read from the bar; Alt+G opened Go; F10 went to the bar; hidden and brought back |
| Command palette | Ctrl+Shift+P listed 84 commands; "Show Docs", just run, came first, above a line |
| Activity bar | Ten panel buttons and Call graph read; "Move left panel to the right" is in the list |
| Status bar | Read: folder, server, branch, agent, problems, place, size, cursor, encoding, line ends, language |
| Bottom panel | Ctrl+J showed it with two tabs, Problems and Output |
| Welcome page | Started with no folder: "Open folder…", a Recent list of two folders, what a folder opens to |
| Notifications | A refused rename raised an error; it was still on screen seven seconds later |
| Zen and full screen | Nothing in the list with "zen" or "full screen" |
| Several windows | Nothing in the list opens a second window |
| Custom title bar | The preview has the browser's own; the app's own window was not seen |

## The menu bar, menu by menu

| Row | Seen |
| --- | --- |
| File menu | Entries read; with no folder, all but "Open folder…" and "Settings…" say why they cannot run |
| Edit menu | Entries read; Undo took back a comment; on a rendered page the text's entries were grey |
| Selection menu | Entries and their keys read; "Expand selection" ran from it |
| View menu | Entries read; "Hide the menu bar" hid the bar |
| Go menu | Entries read; "Go to line…", "Go to definition" and "Go to references" ran from it |
| Help menu | Entries read; About showed three versions; "Keyboard shortcuts…" opened Settings on the keys |
| Save as | Nothing in the list |
| Auto save | No command, and no setting among the eleven |
| Untitled files | "New file or folder…" asks for a name before it makes anything |
| Open recent | The Welcome page lists recent folders; the File menu has no such entry |
| A guide in Help | Help has five entries; none opens a guide |

## Right-click menus

| Row | Seen |
| --- | --- |
| Editor menu | A right-click showed sixteen entries, the app's five among them, in all four layouts |
| Tab menu | Opened on a pinned tab in all four layouts: eight entries read |
| Explorer menu | Cut, Copy, Copy path, Copy path in the project, Rename, Move to trash read from a file's row |
| Docs row menu | Open, Set to open, Set to done, Set to blocked, Set to dropped read from a ticket's row |
| Health row menu | A check's row offered "Open the document" and "Update the catalogs"; a file's row offers nothing |
| Search row menu | A right-click on a result opened nothing |
| Problems row menu | A right-click on a problem opened nothing |

## Tabs and groups

| Row | Seen |
| --- | --- |
| Close, close others | The four commands are in the list; Ctrl+W on an unsaved file asked first |
| Close to the right | In the list, and on the tab's menu |
| Pin a tab | Pinned by its command; the tab says "pinned"; two pinned tabs were still pinned after a restart |
| Switch by Ctrl+Tab | By key events given to the page: through three tabs with Ctrl held, then between the last two |
| Drag tabs | By drag events: along the row, to the other group, and a group's last tab; a key moved one along |
| Split editor | Ctrl+\ made a second group |
| Unsaved mark | A typed letter marked the tab; Ctrl+W asked Save, Discard changes or Cancel |
| Tab overflow | With fifteen tabs the row was wider than it shows, and scrolls; nothing lists them |
| Preview tabs | Two single clicks in the Explorer opened two tabs that both stayed |
| Grid layouts | A second Ctrl+\ made no third group |
| Breadcrumbs | "Day tests › IsWorkingDay › dDate" read above a script's text |
| Compare two files | Nothing in the list compares two files; a changed file opened beside what git has of it |

## Editing

| Row | Seen |
| --- | --- |
| Multi-cursor | "Add Cursor Above", "Add Cursor Below" and Ctrl+D are in the editor's list |
| Find and replace | "Find, Ctrl+F" and "Replace, Ctrl+H" are in the editor's list |
| Folding | Five fold marks in the gutter of a script; twelve fold commands in the editor's list |
| Go to bracket | In the editor's list, with Ctrl+Shift+\ |
| Move and copy lines | Four commands in the editor's list, each with its key |
| Minimap | A Settings row; drawn at 1440 wide, not at 720 |
| Format document | In the editor's list; it changed nothing in SQL. SSL and JSON were formatted at the first check |
| Format on save | A Settings row, "Format changed lines on save" |
| Completion and hover | "Upp" offered Upper; the hover on a parameter said where it is declared |
| Snippets | The Palette panel listed File banner, Class, Data source, Procedure, Region and :IF |
| Word wrap toggle | "Toggle word wrap, Alt+Z" in the list; a Settings row |
| Toggle comment | Ctrl+/ wrote `--` in a SQL file and `#` in an INI file, and wrapped an SSL line |
| User snippets | "New snippet…" is in the list; nothing in the editor's list expands one by its prefix |
| Indent settings | Convert and detect indentation are in the editor's list; the status bar shows neither |
| Sticky scroll | Scrolled into a procedure, “region Report” and “region One sample” held at the top |
| Emmet | Nothing in the editor's list with "emmet" |

## Go and the palette

| Row | Seen |
| --- | --- |
| Go to file | Ctrl+P and "duerules" found DueRules.ssl first |
| Go to symbol | "Go to Symbol…, Ctrl+Shift+O" in the editor's list; "@" listed a file's five symbols |
| Workspace symbols | "#Work" listed four procedures from three files |
| Go to line | "Go to Line/Column…, Ctrl+G" in the editor's list; ":41:5" went to line 41, column 5 |
| Go to definition | From a parameter's use on line 90 it went to its declaration on line 84 |
| Peek, references | A peek listed the parameter's three references |
| Rename symbol | F2 opened the rename box with the name in it |
| Next problem | F8 and Shift+F8 are in the editor's list |
| Palette prefixes | `>`, `@`, `#`, `:` and `?` each listed its kind; "duerules:20" opened at line 20 |
| Back and forward | Alt+Left went back three places and Alt+Right forward again |

## Explorer and files

| Row | Seen |
| --- | --- |
| Tree, new, rename | F2 on a row asked for a new name; Delete asked before the trash, with Cancel the default |
| Follows the editor | The open file's row was the one marked |
| File watching | A file made outside appeared in the tree; a file git put back went unseen until a restart |
| Copy path | Two commands in the list, one with Alt+Shift+C; not run again, since it writes the clipboard |
| Copy, cut, paste | Ctrl+C and Ctrl+V made "Holidays copy.ds"; Ctrl+X dimmed it; Ctrl+V in Legacy moved it |
| Drag to move | A row dragged with the pointer asked "Move … into …?", and moved on yes |
| Reveal in system | Nothing in the list |
| Open editors list | No such panel among the ten, and nothing in the list |
| Compare with saved | Nothing in the list; Local history compares a snapshot with the editor |
| File nesting | The tree lists every file by itself |

## Search

| Row | Seen |
| --- | --- |
| Across files | "IsWeekend" gave ten results in two files; Aa and .* are switches beside the box |
| Whole word | The "ab" switch is beside the box; it narrowed a search when step 1 was built |
| Include and exclude | "*.ssl" without "tests" cut 50 results in 13 files to 26 in 4 |
| Replace across files | 26 matches in 4 files replaced after asking; both snapshots were in local history after |
| Results as a tree | Results stand under file heads; a head does not fold |
| Search history | Up in the search box changed nothing |
| Search editor | Results show in the panel only |

## Source control

| Row | Seen |
| --- | --- |
| Branch in status bar | "main" and the number of changed files read from the status bar |
| Changes list | Seven changes listed under "Staged for the commit" and "Changes", each with its letter |
| Diff a change | A row opened "The last commit" beside "As it is now", with one button, Close |
| Stage and commit | Staged from a row's menu; Ctrl+Enter gave "Committed: [main 35745f0]" |
| Discard a change | It asked, with Cancel the default; the file went back and its marks went |
| Gutter marks | A "removed" mark and then a "changed" one read from the margin as a letter was typed |
| Explorer colours | A changed file's row looks like any other |
| Switch branch | Nothing in the list |
| Push and pull | Nothing in the list |
| Blame, timeline | Nothing in the list; Local history lists a file's snapshots |
| Merge editor | A conflict was made: its row shows “!”, has no discard, and Commit says to settle it |

## Run and terminal

| Row | Seen |
| --- | --- |
| Output | The bottom panel's second tab |
| Problems | A broken XML file listed one problem, at line 4, column 44 |
| Terminal | No such panel, and nothing in the list |
| Test explorer | No such panel, and nothing in the list |
| Tasks | Nothing in the list |
| Debugger | Nothing in the list |

## Settings and shortcuts

| Row | Seen |
| --- | --- |
| Settings view | Four sections, eleven settings and a search box; each row says where it is saved |
| Settings as a file | "Open project settings" is in the list |
| Keyboard shortcuts | 84 rows, each with Set and Clear |
| Shortcut list | "zoom" narrowed the list to three commands |
| Themes | Follow the system, Studio Dark, Studio Light, and "Import…" |
| Zoom | Zoom in, Zoom out and Reset zoom are in the list with their keys |
| Search by key | "Ctrl+W" in Settings' search left one row, "Close tab" |
| Chords | "Fold All, Ctrl+K Ctrl+0" in the editor's list; every key in the app's list is single |
| Profiles | Nothing in the list |
| Settings sync | Nothing in the list |

## File types

| Row | Seen |
| --- | --- |
| Markdown preview | A ticket showed its front matter as a header, and three ticked boxes |
| CSV as a table | files.csv showed five headed columns and 36 rows |
| JSON, TOML, XML | JSON and TOML were coloured and outlined; a key set twice and a broken XML file were reported |
| Line ends kept | crlf.sql read CRLF in the status bar; it was saved with them at the first check |
| Encoding kept | ansi.sql read Windows-1252 in the status bar |
| Images | picture.png was drawn, with "64 × 40 pixels · 146 bytes" |
| Binary files | blob.bin said it is not text, and 1 KB; Ctrl+S was refused |
| Encoding shown | UTF-8 and Windows-1252 read from the status bar |
| Line ends shown | CRLF changed to LF from the status bar's menu, and back by undo |
| YAML | Coloured; a broken YAML file raised no problem |
| SQL | Coloured; "Format document" changed nothing |
| Language picker | The language in the status bar is text, not a button |
| PDF, Office files | A PDF and a Word file each opened as “is not text”; the status bar said Not text |

## Accessibility

| Row | Seen |
| --- | --- |
| Keyboard everywhere | The menus, the row menus, the tab menu and Source control were all worked by keys |
| Focus is visible | A ring on the row, tab, menu entry or box that had the keyboard, in every picture taken |
| Reduced motion | Three style rules under "prefers-reduced-motion" |
| Zoom | The three zoom commands; Settings has "Interface size" |
| Screen reader | Labels were read from the page; no reader was run |
| High contrast | "Toggle High Contrast Theme" is in the editor's list; the themes offered have no such one |
| Tab moves focus | Nothing in the editor's list for it |

## Extensions and AI

| Row | Seen |
| --- | --- |
| Chat | The Agent panel opened with its box; opencode was not started and nothing was sent |
| Agent edits as diff | The Review view compared a snapshot, with Restore and Reject; no agent ran, as that needs a model |
| Inline suggestions | Nothing appeared while typing; "Trigger Inline Suggestion" is listed, with nothing to give |
| Extensions | No such panel, and nothing in the list |

## Added in use

Asked for by the user after trying the app (2026-11-19), and seen in the
same kind of instance, at 720 and 1440 wide, each in the light and the
dark theme. The rows above say what was seen before these: the command
list has since grown from 84 to 88, the copy-path commands from two to
three, and a file's menu in the Explorer has "Copy name" as well.

| Row | Seen |
| --- | --- |
| Layout controls | Each button showed and hid its part; Ctrl+Alt+B did the right panel; Reset put all three back |
| Page menu | A right-click on a rendered page listed five entries; “Edit the text” went to the text |
| Text box menu | In the Docs filter: Cut, Copy, Paste, Select all, and Select all selected the eight letters |
| No menu elsewhere | A right-click on a hint, the status bar, the activity bar and the menu bar opened nothing |
| Scroll past the end | Scrolled down from line 200, the view went on past it |
| Copy name | In the tab's menu, the Explorer's and the page's; not run, since it writes the clipboard |
| Sections fold | Work shut by a click and Decisions by Left; both were still shut after a restart |
| Unsaved mark | A drawn dot, round in both themes; it was an oval from whatever font the system found |
| Region strip | From a band's left edge to the strip's right edge the pointer was on that region, not the resize bar |

### The Docs panel and preview tabs

Asked for after the rows above, and seen the same way.

| Row | Seen |
| --- | --- |
| New menu | It had opened cut off, as an empty box; now it lists its thirteen entries inside the window |
| Collapse, expand | Collapse all shut every group; Expand all opened them, and the tickets under Work |
| A ticket folds | A ticket's twisty hid its plans and specs; Left and Right did the same from the keyboard |
| File actions | A project file's row listed eight entries; a ticket's listed those and the states it can be set to |
| Hover | A ticket's row said its path, its status and what it is related to, and nothing else |
| Preview tabs | One click gave an italic tab; the next click took it; a double click or an edit kept it |

### Markdown as it is written

Asked for with the rows above ("behave like Obsidian"), and seen at 720
and 1440 wide, each in the light and the dark theme, on a page made for
it. Settings now has twelve rows and the command list 89.

| Row | Seen |
| --- | --- |
| Headings | Larger than the text, the #s gone until the cursor came; a long one drawn smaller, so it fits |
| Words | Strong, emphasised, struck and code words each drawn so, their marks hidden off the cursor's line |
| Left as written | Stars in a call, a file pattern, a table cell and code under a numbered step all stayed in sight |
| Find | A match inside a link's hidden address showed that line's markup, with the match marked |
| Links | A link and a link between double brackets showed their words only, underlined |
| The line written | With the cursor on it a line showed its markup, dimmed; typed markup was drawn on leaving |
| Tasks | A click on a box ticked it and struck its words; a second click and undo took it back |
| Code, tables | A block of code kept the code's face and its colours; a table kept its columns |
| Other files | A script opened after it had its line numbers, its face and its map back |
| Switched off | The command showed the page as plain text with line numbers, and on again as written |
