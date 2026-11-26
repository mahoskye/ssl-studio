# ADR 0039: The code editor's keys can be changed in Settings

**Status:** Accepted
**Date:** 2026-11-26
**Decided by:** the user ("make the editor keys rebindable in settings").
The list of commands, how a change reaches the editor and whose a key is
where the shell has it too are the agent's; the user has not reviewed
them one by one.

Under [ADR 0034](0034-in-a-text-editor-sublime-texts-editing-keys-come-first.md),
which put Sublime Text's keys in the editor and left them fixed.

## Context

- Settings listed the shell's commands and let each be given a key. The
  code editor's own keys were outside that list: duplicating a line,
  joining lines and the rest had the keys ADR 0034 chose and no others.
- The editor keeps its keys itself. What a press does there depends on
  where the cursor is and on what is open (a list of suggestions, the
  find box), and a key of two presses is waited for by the editor.
- The shell reads every key before the editor does. It stood aside for
  three editing keys by a fixed list, whatever the editor had on them.

## Decision

- **Settings has a section "Editor keys"** after "Keyboard". It lists the
  editor's commands a key is worth having for: lines, selections and
  cursors, finding and going, what the language server says, folds.
  Each can be given a key, or left with none.
- **A command is named there as it is in the menus.** The list is
  `EDITOR_COMMANDS` (`src/shared/editorKeymap.ts`). A command the shell
  has a command of its own for (the outline, "Format document", the
  command list) is in the shell's list only.
- **The keys the editor comes with are read from the editor** when the
  app starts, after Sublime Text's are in. They differ between Windows,
  Linux and a Mac, and are written nowhere a second time.
- **A change becomes a rule in the editor's own list of keys.** The
  command is taken off its old key and put on the new one, to work where
  its own key worked. The editor goes on deciding what a press does, and
  its command list (F1) and the menus show the new key.
- **Sublime Text's keys are put in afresh at each change,** without the
  ones the user changed. The editor takes a command off a key by a rule
  only where the key is one it came with itself, and the keys of ADR 0034
  are put in by the app. Left in, a key cleared in Settings went on
  running its command. What such a key had before ADR 0034 stays let go:
  cleared, the key does nothing.
- **A key of two presses starts with Ctrl+K** (Cmd+K on a Mac), as the
  editor's own do. Pressed while a key is recorded, Ctrl+K waits for the
  second press.
- **The changes are saved for the user** (`editorKeys`), as the shell's
  are. A folder's settings cannot move the keys of whoever opens it.
- **Only a listed command, on a key the editor has a code for, is
  applied.** Anything else written in the settings by hand is passed
  over: a key that does something no list shows cannot be found again.

### Whose a key is

Where the editor and the shell both have a command on a key, while the
code editor has the keyboard:

| Given to | It runs |
| --- | --- |
| An editor command | That command; elsewhere the shell's |
| A shell command | The shell's command, in the editor too |
| Neither | The shell's command, but for the three editing keys of ADR 0034 |

- The first row comes before the second: a key given to both runs the
  editor's command while code is edited.
- One of those three keys, let go in the editor, is the shell's again.
- **Settings says what a change takes, before it is made:** the key from
  another of the editor's commands, from a shell command while code is
  edited, or both.
- **A key the shell has taken is not shown beside the editor's command,**
  in Settings or in the menus. Pressed in the editor it does not run it.

## Consequences

- The Markdown Live editor keeps the keys it has. It is another editor,
  with a keymap of its own, and a key changed here is not changed there.
  A Markdown file in Source mode is in the code editor and follows.
- Ctrl+K by itself cannot be given to one of the editor's commands: it is
  the first half of the two-press keys.
- A key is named by what it types on a US keyboard, as the editor names
  its own. A key that is a letter of another alphabet has no code in the
  editor and is refused, with the reason.
- Clearing a command's key clears every key it has, and setting one
  replaces them all, as in the shell's list. Each list is reset apart.
- The editor's keys are read through a part of the editor that is not
  public, the one the menu bar reads a key's label from. Should a later
  version not give it, the section is not shown and the keys stay as
  they came.
- The desktop self-test moves a command to a new key, clears it and puts
  it back, and reads the editor's own list each time. It was that run, in
  the desktop window, that showed a cleared Sublime Text key still
  running: in the browser the shell had taken the press first.
- A key held with Cmd and Ctrl both, on a Mac, has no name in the shell's
  way of naming keys. Sublime Text's "move line" and "every occurrence"
  there are such keys: they are not listed with a key, and stay.
- The keys for a Mac are named from the editor's own list for it and
  have not been run on one.
