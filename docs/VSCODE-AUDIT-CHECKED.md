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

### Markdown writing

Seen at 640 and 1000 wide, in the light and the dark theme, on a page
made for it. The command list now has 90.

| Row | Seen |
| --- | --- |
| Next item | Enter after an item's words began the next: a dash, the next number, an empty task box |
| Mid-item | Enter inside an item's words took the rest of them to the new item |
| List ended | Enter on an item with no words left an empty line, and the next words were plain text |
| In code | Enter on a line of code that began with a dash gave a plain new line |
| Link to a file | Ctrl+click on a link's words opened the document; one to a script's lines opened it at them |
| Link to a heading | Ctrl+click put the cursor on that heading of the same page |
| Same words twice | A link ending "-1" reached the second of two headings with the same words |
| Second on a line | A link further along a line was followed too, also with the keyboard in a panel's box |
| Two groups | Enter in each of two groups began the next item there, and still did after one was closed |
| By keyboard | "Open the link at the cursor" opened the link whose words the cursor was in |
| Double brackets | A link between double brackets was drawn as before, and not followed |

### Links by name

Seen at 680 and 1100 wide, in the light and the dark theme, on a page
made for it.

| Row | Seen |
| --- | --- |
| On the page | `[[DEMO-103]]` was a link to the ticket, its tooltip the ticket's title |
| Words and heading | `[[DEMO-102\|the rush ticket]]` showed its words; a name with a heading showed both |
| By file name | `[[Worked-examples]]` led to docs/Worked-examples.md |
| No such name | A name no document answers to stayed as written, dotted under, with why in its tooltip |
| In code | `[[DEMO-103]]` in a code span stayed as code |
| Followed | A click on the page, and Ctrl+click in the text, opened the ticket |
| Offered | `[[` listed the documents, tickets first; "worked" narrowed it; Enter wrote the name |

### Backlinks and a rename followed by name

Seen at 720 and 1440 wide, each in the light and the dark theme, on a
page made for it that linked to another three times by name and once by
path. Links by name were seen again in the same four, on the page and
in the text, with the list offered inside the window in each.

| Row | Seen |
| --- | --- |
| Linked from | Under the page's text: four documents, the scratch page with "4 places" |
| Its entries | Each showed the document's title or its ticket's key, and its path in the tooltip |
| Rename asked | After the path links' question, a second: three links by name in docs/names.md |
| Rename done | The three names were written anew; the words after a bar and the heading stayed |
| Left alone | A ticket's key, a name that meant nothing, and the same name in a code span |
| Enter on a row | Enter on a folder opened and shut it; on a file it kept the tab and typing went to the text |
| Space on a row | Space showed the file for a look, and the keyboard stayed on the row |

## The second pass

Every row of the audit was tried once more (2026-11-19), after the
Markdown work, in the same kind of instance on the same scratch copy:
the menus read entry by entry, the command list and the editor's own
list read again, each right-click menu opened, and each behaviour run.
What was seen agreed with the rows above but for what is listed here.
One defect was found and fixed, in the last row.

| Row | Seen this time |
| --- | --- |
| Command palette | 90 commands; "Show Health", just run, came first |
| A guide in Help | Help has four entries, not five; none opens a guide |
| Tab menu | Ten entries on a tab that is not pinned: "Copy file name" and "Open to the side" are new |
| Explorer menu | Seven entries: "Copy name" is new |
| Docs row menu | Thirteen entries: the file's own are below the ones that set its state |
| Drag tabs | Dragged along the row by the pointer itself this time |
| Three keys | Ctrl+\, Ctrl+/ and Ctrl+F12 could not be pressed by the tool; each ran from its menu |
| Move to trash | It asked, Cancel the default; on yes the preview said it is only in the app |
| Replace in files | It asked "Replace 85 matches in 10 files…?"; cancelled, not run again |
| Stage and commit | A file made outside was staged from its row and committed by Ctrl+Enter |
| Merge editor | A conflict made again: "!", no discard, "A file is in conflict: settle it first." |
| Settings view | Twelve settings; the keyboard list has 90 rows |
| CSV as a table | jira-export.csv showed 25 headed columns and three rows |
| Agent edits as diff | A snapshot opened as a comparison with Reject; no agent was run |
| Minimap | Drawn at 1280 wide with no right panel; not drawn with the Agent docked there |
| Explorer keys | A click on a row moved the keyboard to the editor: fixed, see below |

Found: a click on a file's row, in the Explorer or in Docs, brought the
file to the front and a moment later gave the keyboard to the editor.
The keys that followed (Delete, F2, Ctrl+C, the arrows) then went to
the file's text or to the row, by how fast the file was read. A file
brought to the front for a look (one click, or Space) now leaves the
keyboard on its row; a double click, or Enter on the row, opens it to
stay and gives the keyboard to the editor. Seen after the fix: the row
kept the keyboard for a file with a tab and for one without, the Down
arrow moved to the next row, Ctrl+C and Ctrl+V made a copy, Ctrl+X
dimmed it, and a double click put the keyboard in the text. Enter on a
row was changed after a reviewer read the fix, and was seen afterwards:
it is in the table above this section.
Left as they were: a click on a search result still goes to its place
in the text with the keyboard, and a look that closes a comparison
still gives the keyboard to the editor.

Not tried again: a screen reader, the app's own window, the copy
commands (they write the clipboard), and an agent's edit.

## The third pass: steps 1 to 8 in the four layouts again

After the last of the building (2026-11-19), each of the plan's first
eight steps was looked at once more at 720 and 1440 wide, each in the
light and the dark theme, with the Agent docked on the right. The same
was read in all four; nothing ran off the window in any.

| Step | Seen in all four |
| --- | --- |
| 1, small habits | The search's three switches, each inside its panel |
| 2, menus | A tab's menu of ten entries and a file's of seven, both inside the window |
| 3, the menu bar | Six menus of 16, 14, 11, 25, 14 and 4 entries, each inside the window |
| 4, finding | "?" in the quick pick listed its five kinds, inside the window |
| 5, files by hand | A file's row and a tab can both be dragged; the row fits its panel |
| 6, not text | A picture drawn inside its view, the status bar saying Picture; a text's UTF-8 and CRLF |
| 7, replace | The four boxes: what to find, what to write, files to include and to leave out |
| 8, source control | Eight changes listed, the message box inside the panel, a comparison in one column |

The comparison is one column here at 1440 too: with the Agent docked on
the right the editors have some 770 across. A change's two buttons take
no room until the pointer is on its row. In the status bar one piece
has no width at 720 (the place in the file, which has no words there);
the rest lie between 6 and 714 of the 720.

Two of the three keys the tool could not press were tried as key
events sent to the page: Ctrl+/ made a comment of an SSL line, and
Ctrl+\ made a second group. Ctrl+F12 sent the same way did nothing;
"Go to definition" ran from the Go menu, as before.

## In the app's own window

The Markdown work had been seen in the browser preview only. The cycle
self-test runs in the desktop window itself and presses the same
things from inside it; eight steps were added to it (2026-11-20), and
all passed on their first run there.

| Step | Checked |
| --- | --- |
| namedLinkOnPage | Two links by name are links on the page; a name that means nothing is marked |
| namedLinkOpens | A click on one opens the ticket it names |
| linkedFromListed | The ticket's page lists the note under "Linked from", with "2 places" |
| drawnAsWritten | As text: a heading sized, markup hidden, a link marked |
| listContinues | Enter's action after an item's words starts the next item; undo takes it back |
| linkFollowedInText | The editor's open-link action on a link by name opens its ticket |
| longPageDrawn | A page of 28,587 characters is drawn, and the worker answered for it: 1.3 and 1.4 seconds |
| renameFollowedByName | A rename asks about two links by name and writes both |

The window was then seen by eye as well (2026-11-20). It cannot be
driven from outside without taking the keyboard from whoever is at the
machine, so the cycle self-test was run four times and the window
alone was captured four times a second while the self-test pressed
things in it: at 1400 and at 720 wide, each in the dark and the light
theme. The self-test passed in all four.

| Layout | Seen |
| --- | --- |
| 1400, dark | A plan's chart, a review's comparison, a ticket's page, and the long page drawn as written |
| 720, dark | The long page as plain text for the moment before its reading came, then drawn; nothing ran off |
| 1400, light | The same pages; headings sized, strong words strong, code in its face, the Agent docked right |
| 720, light | The same; the right panel gives way, the tabs and the Edit and Read switch fit |

Found in those pictures and fixed, both older than this work:
accepting a review raised "Something went wrong: no diff result
available", which is the comparison saying it was closed before it had
worked its lines out, and is no longer shown; and a build raised
"Could not save the build's progress", because it wrote its progress
several times at once and the writes got in each other's way: they now
go one after another. A reviewer made the second happen on its own: of
400 rounds of two to four writes at once, some 185 had a write fail
and some 160 left an older state on disk, 19 of them a file that does
not read; chained, 200 writes all landed. A fifth run was captured
after the fixes, and neither notice came. Found by the same reviewer
and not fixed then: two saves of one file at once (Ctrl+S twice) would
collide the same way, and two saves of the settings at once can lose
one of them without a word. Both are fixed since: see "Saves asked for
at once", at the end. Not seen by eye there: a page's links by name
and "Linked from" (the self-test passes them in under a quarter of a
second), and anything that needs a key pressed from outside.

## What the report could not verify, tried again

The report at the end of the work named things it had not verified.
Three of them were tried, each in a way that touches nothing of the
person's at the machine.

| Tried | Came of it |
| --- | --- |
| The copy commands | With a stand-in clipboard in my own instance, each wrote the right words |
| Go to definition | With keys sent to the editor in my own instance, Ctrl+F12 did nothing: fixed |
| What a reader hears | Read off the accessibility bus during a self-test: the window names its parts |

The copy commands write to the real clipboard, which is the person's,
so they had only been read in the code. With a stand-in clipboard put
in the page of my own instance, "Copy path in the project" wrote
`src/DueDates/WorkCalendar.ssl`, "Copy name" wrote `WorkCalendar.ssl`,
"Copy path" wrote the whole path, and Alt+Shift+C did what the first
does.

The Go menu shows Ctrl+F12 beside "Go to definition". F12 went to the
definition; Ctrl+F12 did nothing. The editor keeps that key for where
it is told it is in a web view (where F12 alone may be the browser's),
and it was never told. It is told now: from a use on line 42 the key
took the cursor to line 30, column 14, where the procedure is
declared, and F12 goes on doing the same.

The app's own window was read off the accessibility bus (AT-SPI, what
a screen reader reads) while a self-test had it open: 113 parts, in
one reading taken part of the way through the run.

| Part | Named |
| --- | --- |
| The window | "SSL Studio", as a frame and as a document |
| The menu bar | "Menus": File, Edit, Selection, View, Go, Help |
| Tabs | "Open files" and "Bottom panel", each tab by its file or its panel |
| The file tree | "Files in workspace", each row by its name |
| Panel buttons | Sixteen switches, each by its panel: Explorer, Docs, Search and the rest |
| Regions | Views, Side panel, Breadcrumbs, Bottom panel, Right panel, Tidy |
| Text boxes | "Editor content" and "Question for the agent" |
| Problems | The list by its file and count, each row by its words |

No button, tab, tree row, switch, box or link was without a name. Four
rows of a list had none of their own, as rows of a plain list do: a
reader says what is in them. This is what the window offers a reader,
not a reader heard: none was run, since one would speak on the
person's machine and take its keys.

## The headings of the Docs panel have a menu

Asked for in use: a right-click on the heading of a list in the Docs
panel, to add a document or a folder there. Each heading that is a
folder of the project's now has a menu, by right-click, the menu key
or Shift+F10. "Project" has none: its files are at the top of the
folder.

| Heading | Menu opens with |
| --- | --- |
| Work | New ticket…, Import tickets…, New spec… |
| Knowledge base | New decision…, New question…, New snippet…, New reference note… |
| A kind in it | The one of that kind: "New decision…" on Decisions |
| Registries | New registry… |
| Docs, Schema | New document… |
| Plans | New plan… |

Every one ends with "New folder…" and "Show in the Explorer". A new
folder is made in the folder the heading names; "a/b" makes both. The
panel lists documents, so an empty folder is not in it: under Docs and
Schema, where a document is plain Markdown named by whoever writes it,
the name of the folder's first document is asked for next, and
elsewhere (or when no document comes of that question) a notice says
where the folder is. "New document…" takes a folder before the name
the same way, and its question says so: "guides/Intro" is `Intro.md`
in `guides/`. It used to write the slash as a dash. Refused, in words:
a name that leads out of the folder ("../x"), a folder whose name is
not the same on every system (it ends in a dot, or is a device's on
Windows), and a folder the app leaves out of every list (`build`,
`node_modules`). A document's own name may end in a full stop: the
heading keeps it and the file's name leaves it off.

Looked at in my own instance at 1400 and 720 wide, in the dark and the
light theme, a different heading's menu open in each. Used by pointer
and by keys: the Docs heading's menu by right-click, "New folder…",
"guides", then "Intro: first steps" (listed as `guides/Intro- first
steps.md`, opened with its heading as typed, the keyboard in it); the
Schema heading's by Shift+F10, arrows and Enter, "views/reports", the
next question cancelled (the notice came, and the keyboard was back on
the heading); a name already taken and a name leading out (each
refused in words); a folder under Work (the notice). The self-test
opens the Work heading's menu and makes a folder from it. Not seen:
"Show in the Explorer" for a list whose folder is not there yet, since
every list of the demo has its folder; the notice for it was only read
in the code then, and was seen later (below).

Found on the way and fixed, older than this: "Show in the Explorer"
opened the Explorer on its first row for anything inside a folder,
from a document's row as much as from a heading. The Explorer brought
its remembered open folders back each time it was shown again, and so
shut the folders that had just been opened for the row. It brings them
back once for a folder now. Seen after: a document, a kind's folder
and the tickets folder each shown with the folders above them open
and the keyboard on the row.

A reviewer read all of this before its commit; what it found and what
was done is the fourteenth review in
[VSCODE-AUDIT-REVIEWS.md](VSCODE-AUDIT-REVIEWS.md); what is left is
listed there.

Looked at again after its findings were fixed, in my own instance: the
question for a new document, which now says a folder may come first,
at 720 and 1400 wide in the dark and the light theme (it fits on one
line in all four); and the refusals of `build/notes`, `node_modules`
and `CON`, each as a notice in words, at 1400 in the light theme.

What the reviewer's second reading found was fixed in the commit
after, and looked at in my own instance on two scratch folders.

| Looked at | Seen |
| --- | --- |
| Ctrl+F12, comparison | "No definition found for 'RuleFor'", as F12 says there |
| Headings at the top | They read "Work tickets/" and "Docs", with no "./" |
| The menu at the top | The Docs heading's says "in the project's folder" |
| Show in the Explorer | The Explorer shown, the keyboard on its first row |
| A list, no folder | "tickets/ is not there yet: the first document or folder made here makes it." |
| A folder under Work | Made as `tickets/2026/`, with the notice that says so |
| Work, shown after | The Explorer shown, the keyboard on the row `tickets` |
| "Intro.md." named | `Intro.md`, opened, listed under Docs |
| "Build", a folder | Refused: it is `build` on a disk that does not tell capitals apart |

The comparison was a change to a script in my scratch copy of the
demo, opened from Source control; the rest was a scratch project with
`docs = "."`. Its headings and a different heading's menu were looked
at at 1400 and 720 wide, in the dark and the light theme. The
self-test now also opens a heading's menu by Shift+F10 and by the
menu's own key.

## Saves asked for at once

Two things a reviewer had found and made happen were recorded as not
fixed, and should not have been left: what a review confirms is to be
fixed. Both are fixed.

- **One file saved twice at once.** The two shared a temporary file:
  one failed, or the older text was left. Saves of one file now go one
  after another, in the order they were asked for.
- **The settings saved twice at once.** Each read the file before the
  other had written it, and one change was lost. Saves of one settings
  file now go one after another, so each reads what the last wrote.

The fix is in the part of the app that writes files, so it holds for
everything that goes through its write: a save, Save all, a document
the app writes. A save that fails is told to whoever asked for it and
does not hold up the next; saves of different files do not wait on
each other.

Made to happen first, in tests written before the fix: of sixty rounds
of four saves of one file at once, the first round already had a save
fail; and three settings saved at once left one of the three in the
file. With the fix, all sixty rounds land every save and leave the
text asked for last, with no temporary file left beside it; forty
rounds of three settings at once keep all three; and a setting taken
out at the same time as another is set comes out right.

A reviewer read the fix before its commit and made the same things
happen (the fifteenth review in
[VSCODE-AUDIT-REVIEWS.md](VSCODE-AUDIT-REVIEWS.md)). What it found
around the fix was dealt with in the same commit:

- **Other work on a file being saved.** A rename, a copy, a discard,
  a move to the trash and a replace across files did not wait for a
  save of the file. They now take their turn with its saves; a rename
  and a copy hold the name they are to take as well; and work on a
  folder waits until nothing in it is being saved, for ten seconds at
  most, after which it says the folder is busy and does nothing.
- **One file by two names.** Reached through a link to its folder, by
  a folder opened a second time, or in other capitals on a disk that
  does not tell them apart, a file is one file to the saving.
- **The settings file.** It is written beside itself and moved into
  place, so it is never half there. One that does not read as settings
  (a comment written into it by hand) is no longer replaced by the one
  setting being saved: the save is refused, in words that name the
  file.
- **Settings worked out on screen.** The shortcuts, the regions'
  colours and the models marked as one's own are each saved whole from
  the value on screen. Two changes in one moment were both worked out
  from the value before either. The new value is now on screen at
  once.

Looked at in my own instance, with its own settings folder:

| Done | Seen |
| --- | --- |
| Ctrl+S three times | No notice came, and the tab lost its unsaved mark |
| The file on disk | It held the words typed, with its Windows line ends kept |
| Beside the file | No temporary file left |
| Three keys cleared | Three shortcuts in one moment: all three cleared on screen and in the settings file |
| A comment in it | The next change refused in a notice that names the file and says why |
| The file after | The same, byte for byte, after four refused changes |
| Word wrap switched | From the View menu: it landed in my own settings, and not in the folder's |
| Four panel moves | With the folder's settings file unreadable: one notice that the layout is not kept |
| That file after | The same, byte for byte |

Both notices were looked at at 1400 and 720 wide, in the dark and the
light theme: each wraps inside its box in all four. Seen with it: while
the settings file does not read, the app shows the settings it would
have with no such file, as it did before; the three cleared shortcuts
showed as set again until the file was mended.

## The schema by kind, and prompts kept

Asked for in use, after the audit's work: the schema folder split into
a folder for each kind of thing it describes, the database's tables
in a folder of their own, and a place like the snippets' for prompts.
Asked which other kinds to offer, the user chose interfaces and files.
The decision is
[ADR 0026](adr/0026-schema-is-kept-by-kind-and-prompts-are-kept.md),
a draft.

| Now | Where |
| --- | --- |
| Tables | `schema/database/`, listed under Database |
| Messages | `schema/interfaces/`, listed under Interfaces |
| File layouts | `schema/files/`, listed under Files |
| A kind of one's own | Any other folder under the schema folder, under its own name |
| What lies at the top | Still listed, under "At the top" |
| Prompts | `docs/knowledge/prompts/`, listed under Prompts beside Snippets |

Looked at in my own instance, on a scratch copy of the demo, at 1400
and 720 wide in the dark and the light theme, a kind's menu open in
each: nothing ran off the panel in any.

| Done | Seen |
| --- | --- |
| The Schema list | Database, Interfaces, Files and "At the top", each with its count |
| New table… | Asked the table's name; `DEMO_ORDERS.md` in `database/`, from its template |
| Interface message | New interface message…: `Result-from-the-analyser.md` in `interfaces/`, with a table of fields |
| New file layout… | `Sample-export.md` in `files/` |
| Each of the three | Marked "template" in the list until written |
| New folder… there | "labels", then its first document: listed under a heading "labels" |
| A kind's README | Shown by its file's name, not by a title that repeats the heading |
| New prompt… | `Find-what-a-change-touches.md` under Prompts, marked "template" |
| The Agent panel | "Kept in this project": the two written prompts, and not the template |
| A kept prompt chosen | Its words in the question box, the keyboard in it; nothing sent |

The Agent panel is not shown at 720 wide (the right panel gives way),
so its list was looked at at 1400 only, dark and light. No question
was sent to the agent: the instance can reach paid models.

The demo project's tables were moved into `schema/database/` with the
links to them, its file manifest and two catalogs were brought up to
date with the app's own steps, and it was given one message, one file
layout and two prompts, written for this repository. Nothing in the
demo's scripts reads the message or the file yet, and their pages say
so.

Looked at once more after the review's findings were fixed, on a
scratch copy with the interfaces folder written `Interfaces/`, a
folder `Labels/` and a folder `other/`, at 1400 and 720 wide in the
dark and the light theme: the headings read Database, Interfaces,
Files, Labels, other and "At the top", each once. From the Interfaces
heading, "New interface message…" put `Order-feed.md` in
`schema/Interfaces/`, where it was then listed, and "Show in the
Explorer" put the keyboard on `schema/Interfaces`.

## The schema's catalog, and interfaces as contracts

Asked for in use, the day the schema was split by kind. The user asked
what "Schema" at the top of the list was (the folder's own README),
and then for the folder to be found as the others are: "instead of
serving a readme, maybe we use the index approach. I prefer approaches
be consistent wherever possible." And asked whether what is agreed
with an outside system belongs under interfaces, the answer given was
yes, and the user agreed to both changes. They are appended to
[ADR 0026](adr/0026-schema-is-kept-by-kind-and-prompts-are-kept.md).

| Now | How |
| --- | --- |
| The schema's catalog | `schema/INDEX.md`, written and kept as the other four are |
| READMEs there | None made: "Set up project" writes the catalog, which names the kinds |
| "At the top" | Shown only when something other than the catalog lies there |
| A folder in a kind | A heading of its own: a system among the interfaces |
| A message | Opens with whom, which way, the version and how far it is agreed |
| Its states | draft, agreed, retired: set from its row's menu |

Looked at in my own instance, on a scratch copy of the demo, at 1400
and 720 wide in the dark and the light theme: nothing ran off the
panel in any.

| Done | Seen |
| --- | --- |
| The Schema list | Database, Interfaces with Maintenance under it, Files, then Catalog |
| What is gone | No README and no "At the top" in the list; the count is of what is described |
| A system's message | Asked "with Maintenance", then which way it goes: In, Out or Both |
| What it opened as | `with: Maintenance`, `direction: in`, `version: 1`, `status: draft` |
| New folder… there | On Interfaces: "ERP", then a message with ERP, going out, listed under ERP |
| The row's menu | "Set to agreed" and "Set to retired"; chosen, the row read "agreed" |
| The catalog after | Not marked out of date: written with each new description |

The demo's four schema READMEs gave way to one catalog, with what they
said that the list does not say written under it; its one message
moved into a folder for its system and opens with the contract's
lines. Its manifest and catalogs were brought up to date with the
app's own steps.

Asked for with it: "the headers for the sub directories in docs should
also have a faint background to them to help separate them from
working documents". The heading of each kind in the knowledge base and
in the schema has a faint ground now (three parts in a hundred of the
text's colour, against five for the heading of the list itself, which
has a border too), and a folder inside a kind a fainter one (two). A
heading still takes the ground of the row under the pointer when the
pointer is on it. Looked at at 1400 and 720 wide, in the dark and the
light theme: the bands set the headings apart in all four, and no
document's row has one.
