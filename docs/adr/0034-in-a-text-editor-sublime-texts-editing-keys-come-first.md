# ADR 0034: In a text editor, Sublime Text's keys for editing come first

**Status:** Draft
**Date:** 2026-11-26
**Decided by:** the user set the direction: the code editor is to feel like
VS Code with IntelliSense and have Sublime Text's keybindings, and the
keymap was to be done next. The rule below and the list of keys are the
agent's, written from a review of the editor; the user has not reviewed
each key.

Under [ADR 0032](0032-design-precedents-and-interaction-standards.md)
(keybindings: Sublime Text) and
[ADR 0020](0020-the-shell-does-what-vs-code-does-and-stays-its-own.md) (the
shell: VS Code).

## Context

- The two decisions above meet on the keyboard. The code editor is VS
  Code's own editor component and came with VS Code's keys: none of
  Sublime Text's were set.
- The shell had taken three of Sublime Text's editing keys for itself.
  Pressed in the code editor, Ctrl+Shift+D opened the Docs panel and took
  the keyboard away, and Ctrl+J opened the bottom panel.
- Ctrl+M, Sublime Text's "jump to matching bracket", was the editor's key
  for "Tab moves focus". It turned Tab off in every editor, and nothing on
  the screen said so.
- The Markdown editor already let Ctrl+Shift+D and Ctrl+J edit. The same
  key did one thing in a document and another in a script.

## Decision

- **While a text editor has the keyboard, a key that edits text in Sublime
  Text does what it does there.** Everywhere else the shell's keys are VS
  Code's, as ADR 0020 says.
- **The code editor and the Markdown editor have the same keys.**
- **The keys are set in the editor itself,** not in the shell's list of
  shortcuts. The menus and the editor's command list (F1) read the editor's
  keys, so they show the new ones without being told.
- **The second key of a two-key shortcut is the editor's.** After Ctrl+K
  in the code editor, the next key goes to the editor whatever the shell
  has on it. The shell reads one key at a time and took the second for
  itself: Ctrl+K Ctrl+0 focused the side panel and Ctrl+K Ctrl+1 the
  editor, where the editor unfolds everything and folds the first level.

### Keys the code editor gains

| Key | What it does |
| --- | --- |
| Ctrl+Shift+D | Duplicates the line, or the selection |
| Ctrl+J | Joins the line to the next |
| Ctrl+Shift+Up, Down | Moves the line |
| F9 | Sorts the selected lines |
| Ctrl+K Ctrl+K | Deletes to the end of the line |
| Ctrl+Shift+Delete | Deletes to the end of the line |
| Ctrl+Shift+Bksp | Deletes to the start of the line |
| Ctrl+K Ctrl+U | Upper case |
| Ctrl+K Ctrl+L | Lower case |
| Ctrl+Shift+L | Splits the selection into lines |
| Alt+F3 | Selects every occurrence |
| Ctrl+Shift+U | Takes back a cursor undo |
| Ctrl+M | Jumps to the matching bracket |
| Ctrl+Shift+M | Selects to the bracket |
| Ctrl+K Ctrl+0 | Unfolds everything |
| Ctrl+Shift+/ | Toggles a block comment |

- On a Mac the keys are Sublime Text's for a Mac: Cmd where the table says
  Ctrl, except the two bracket keys, which are on Ctrl itself. Moving a
  line is Ctrl+Cmd+Up and Down, sorting is F5, and every occurrence is
  Ctrl+Cmd+G.
- The Markdown editor has those of them that it has a command for: the
  line, selection and bracket keys. A key that starts with Ctrl+K is not
  among them, since Ctrl+K inserts a link in a document.

### What the keys had before

| Key | Was | Now found |
| --- | --- | --- |
| Ctrl+M | Tab moves focus | In the command list (F1) |
| Ctrl+Shift+L | Every occurrence | On Alt+F3 |
| Ctrl+Shift+Up, Down | Add a cursor (Linux) | On Shift+Alt+Up, Down |
| Ctrl+K Ctrl+0 | Fold everything | In the command list (F1) |
| Ctrl+K Ctrl+L | Toggle a fold | On Ctrl+Shift+[ and ] |
| Ctrl+K Ctrl+U | Remove a comment | On Ctrl+/ |
| Ctrl+K Ctrl+K | Select from anchor | In the command list (F1) |

### The shell's keys that give way in an editor

| Key | Shell command | Reached by |
| --- | --- | --- |
| Ctrl+Shift+D | Docs panel | Its button in the activity bar |
| Ctrl+J | Bottom panel | Its button in the title bar |
| Ctrl+Shift+M | Problems | The count in the status bar, or F8 for the next problem |

- A key gives way only while it runs the command it is the default key of.
  A key the user gives to another command is theirs, and runs that command
  in an editor too.

### Keys the shell gains

| Key | Command |
| --- | --- |
| Ctrl+R | Go to a symbol in the file, beside Ctrl+Shift+O |
| Ctrl+Shift+R | Go to a symbol in the workspace, beside Ctrl+T |
| Alt+- | Go back, beside Alt+Left |
| Alt+Shift+- | Go forward, beside Alt+Right |

### The mouse

- **Ctrl+click adds a cursor,** as in Sublime Text, and Alt+click goes to a
  definition. A setting (Editor, "Ctrl+click adds a cursor") turns the two
  round, as VS Code has them. F12 goes to a definition either way.

### Left as VS Code has them

- **Ctrl+T** stays "go to a symbol in the workspace" and is not
  "transpose": it is used from the editor far more often than two letters
  are swapped, and Sublime Text's own key for it, Ctrl+Shift+R, is added.
- **Ctrl+Space and Ctrl+Shift+Space** stay "suggest" and "parameter
  hints". What the language server knows is asked for as in VS Code.
- **F2 and Ctrl+F2** stay "rename" and "change all occurrences". Sublime
  Text keeps bookmarks on them, and this editor has no bookmarks.
- **The editor's own keys for a block comment** stay beside Sublime
  Text's: Ctrl+Shift+A on Linux, Shift+Alt+A on Windows. Toggling a comment
  is right for SSL since
  [ADR 0035](0035-toggling-a-comment-is-the-editors-own.md).

## Consequences

- A hand used to VS Code finds Ctrl+Shift+L, Ctrl+K Ctrl+0 and Ctrl+click
  doing something else in the editor. The tables above say where each
  went, and the menus show the keys.
- The editor's keys cannot yet be changed in Settings, which lists the
  shell's commands only. Until they can, the choices here are the only
  ones, apart from the setting for the click.
- The keys for a Mac are written from Sublime Text's own list and have not
  been run on one.
