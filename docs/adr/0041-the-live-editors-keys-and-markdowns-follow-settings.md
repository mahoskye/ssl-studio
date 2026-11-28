# ADR 0041: The Live editor's keys, and Markdown's own, follow Settings

**Status:** Accepted
**Date:** 2026-11-26
**Decided by:** the user ("make the Markdown Live editor's keys
changeable"). How it is done, which keys are whose and the list of
commands are the agent's; the user has not reviewed them one by one.

Under [ADR 0034](0034-in-a-text-editor-sublime-texts-editing-keys-come-first.md)
and [ADR 0039](0039-the-code-editors-keys-can-be-changed-in-settings.md),
which left the Live editor's keys as they were.

## Context

- A Markdown document is edited in the code editor (Source) or in the
  Live editor, which is another editor. ADR 0039 made the code editor's
  keys changeable and left the Live editor's fixed.
- The Live editor's keys were written in three places: its own list, the
  lists the component it is built on comes with, and a table of Markdown's
  keys (Ctrl+B for bold) that the shell read. The code editor held a
  fourth copy of Markdown's keys for Source.
- ADR 0034 says the two editors have the same keys where the Live editor
  has the command. They had come apart: on Linux Alt+Shift+Up copied a
  line in one and added a cursor in the other, and the keys for a block
  comment and for going to a bracket differed.
- Markdown's commands stood in "Keyboard" with no key beside them, though
  Ctrl+B was bold in every document.

## Decision

- **The Live editor has the code editor's keys, as Settings has them,**
  for the commands it has too: duplicating and moving lines, selections
  and cursors, comments, brackets, finding, folds. A key changed under
  "Editor keys" is changed in both editors at once, and a key cleared
  there is clear in both.
- **Those commands are named once** (`LIVE_EDITOR_COMMANDS`,
  `src/shared/editorKeymap.ts`), by the code editor's name for each, and
  the Live editor says what runs each (`LIVE_COMMANDS`).
- **The Live editor's own list keeps the keys no list holds:** what Enter,
  Tab, Backspace and the arrows do in a document, and undo. The keys its
  component comes with for a listed command are taken out, and so is its
  "Tab moves focus" (Ctrl+M), which turned Tab off without a word.
- **A key of two presses is the code editor's alone.** It is the code
  editor that waits for a second press.
- **Markdown's own keys have a list, "Markdown keys",** after "Editor
  keys": bold, italic, strikethrough, inline code, highlight, a link, a
  checkbox. Each can be given a key or left with none. The changes are
  saved for the user (`markdownKeys`).
- **Markdown's keys work while a Markdown document's text is edited,** in
  Live and in Source, and come before every other key there. The shell
  reads them, as it did; neither editor holds a copy any more.
- **"Keyboard" shows one of Markdown's commands only where it was given a
  shortcut there,** which then works anywhere. The list of commands to run
  shows Markdown's key beside each.

### Whose a key is

While the keyboard is in a Markdown document's text:

| The key is | It runs |
| --- | --- |
| One of Markdown's | Markdown's command, before anything else |
| The editor's | As in code (ADR 0039), where the Live editor has the command |
| Neither | The shell's command |

- **Settings says what a change takes, before it is made.** A key given to
  one of Markdown's commands keeps what it does everywhere else. A key
  given to a shortcut or to an editor command stays Markdown's in a
  document, and the question says so.

## Consequences

- Some of the Live editor's keys are now the code editor's, where the two
  differed. On Linux:
  - Alt+Shift+Up and Down add a cursor, where they copied a line; copying
    a line is Ctrl+Alt+Shift+Up and Down.
  - Ctrl+Alt+Up and Down do nothing, where they added a cursor.
  - A block comment is Ctrl+Shift+A or Ctrl+Shift+/, not Alt+Shift+A.
- On Windows those were the same already. On both, Ctrl+Shift+\ goes to
  the bracket, where it selected to it.
- Keys the Live editor's component came with, which no list showed, are
  gone: Alt+L, Alt+U, and Ctrl+Alt+[ and ] for folding everything.
  "Fold all" has no key of one press until it is given one.
- The Live editor gains the keys the code editor had and it had not:
  Alt+Shift+I, Ctrl+Shift+Backspace, Ctrl+Shift+U.
- "Sort lines", the two cases, and what the language server answers (a
  definition, a rename, suggestions) are the code editor's alone. A key
  given to one of them is nothing in the Live editor.
- Where the code editor's keys cannot be read, the Live editor has the
  keys it had (`LIVE_KEYS_AS_THEY_CAME`), and they cannot be changed.
- In a table's cell or a callout's box the keyboard is not in the text,
  and the keys there are as they were.
- On a Mac, Option and a letter type another character. Markdown's keys
  written with Alt are found by the letter on the key. Three of the Live
  editor's keys there are held with Cmd and Ctrl both and stay fixed, as
  the code editor's do. None of this has been run on a Mac.
- The desktop self-test presses keys in a Live editor: one of the list's,
  the same after it is moved in Settings, and Markdown's key for bold.
  The workspace it opens gained a short note for that
  (`fixtures/workspace/Sample/Notes.md`).
