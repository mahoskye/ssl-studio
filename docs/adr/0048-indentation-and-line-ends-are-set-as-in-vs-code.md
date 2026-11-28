# ADR 0048: A file's indentation and line ends are set as in VS Code

**Status:** Accepted
**Date:** 2026-11-27
**Decided by:** the user, who asked for each area of the editor to be
reviewed adversarially and for what was missing to be added. The choices are
the agent's; the user has not reviewed them.

Under [ADR 0032](0032-design-precedents-and-interaction-standards.md): code
editing and the IDE's chrome follow VS Code.

## Context

- The status bar showed a file's line ends and let them be changed. It said
  nothing of its indentation: whether Tab put in a tab or spaces, and how
  wide, could be seen only by typing.
- VS Code shows "Spaces: 4" or "Tab size: 4" beside the line ends, and the
  item offers tabs or spaces, the size, converting the file, and working it
  out from the content.
- A narrow window leaves the status bar's encoding, indentation and line-end
  items out. The command palette had the editor's own "Convert indentation"
  and "Detect indentation" commands, and nothing to change the tab size or
  the line ends.

## Decision

- **The status bar names the open file's indentation** as VS Code does,
  before the line ends, and follows a change to it.
- **Its menu** offers indenting with spaces or tabs (each then asks the
  size), changing the tab size, converting the file's indentation either way
  (while the code editor shows it, since converting is an edit of the text),
  and detecting it from the content.
- **The palette has "Change Indentation…" and "Change End of Line
  Sequence…",** the same menus. Opened from there, a menu stands at the top
  of the window, where the palette was, since the item may not be shown.
- These set the open document only. What a new file is indented with is
  unchanged: for a script, the house style's indentation.

## Consequences

- A tab size chosen here lasts while the file is open. Reopening it reads
  its indentation again from the content. Changing the house style's
  indentation works out every open script's again, a choice made here
  included.
- SSL formatting is the language server's and uses its own settings
  (ADR 0003): a size chosen here does not change what "Format document"
  writes.
