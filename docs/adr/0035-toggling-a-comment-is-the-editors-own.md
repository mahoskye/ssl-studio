# ADR 0035: Toggling a comment is the editor's own, built on the grammar

**Status:** Accepted
**Date:** 2026-11-26
**Decided by:** the user, who asked whether the editor's open gaps were
really the language server's ("be adversarial about these issues, are they
really appropriate for the lsp?") and then for this one to be built in the
app. The rule below is the agent's.

Under [ADR 0003](0003-the-language-server-owns-ssl.md), and beside
[ADR 0034](0034-in-a-text-editor-sublime-texts-editing-keys-come-first.md).

## Context

- An SSL comment is `/* … ;`. It ends at the first `;`, which is also what
  every statement ends with.
- The code editor takes a language's two comment tokens for brackets round
  the selection. With two statements selected it put `/*` before the first
  and `;` after the last. The comment ended at the first statement's own
  `;`, and the second statement was still code.
- This had been listed as needing the language server. It does not. The
  protocol has no request for it, and the VS Code extension for SSL toggles
  comments in the extension (`ssl.toggleComment`), not in the server.
- ADR 0003 forbids a parser, a tokenizer or a formatter for SSL here. A
  command that edits text, built on tokens the grammar already gives, is
  none of those.

## Decision

- **The app toggles comments itself** (`src/shared/commentToggle.ts`). It
  reads no SSL: the two tokens are the language configuration's, and where
  comments already are is the grammar's.
- **An opener goes before each thing that would otherwise be code:** before
  the first thing written in the selection, and before the first thing
  written after each `;`, since that `;` ended the comment before it.
- **A statement's own `;` ends its comment.** `x := 1;` becomes
  `/* x := 1;` and comes back as it was. A statement over several lines is
  one comment with one opener.
- **A comment still open where the selection ends is closed there,** with
  a space and a `;`. Without that it would run on into lines that were not
  selected. That `;` goes when the comment does: the space before it is the
  mark that it was added. The VS Code extension writes and reads the same
  mark, so a file goes between the two editors.
- **The grammar is asked before anything is written.** An opener that would
  stand inside a string is not a comment: it changes the string and
  comments nothing. Nothing is written then, and a notice says which line.
- **The editor's comment commands keep their names, keys and menu
  entries.** Each is replaced, in a code editor, by one that does this for
  SSL and what it did before for every other language.

## Consequences

- A line of code that itself ends with a space and a `;` loses that `;`
  when it is commented and uncommented: the space reads as the mark. The
  formatter never leaves code that way, so this is old, unformatted code
  only.
- A line that is a `;` alone comes back blank, for the same reason.
- Text with a `;` in a string is commented in two pieces
  (`/* s := "a;/* b";`). It is the only way such a line can be a comment in
  SSL at all.
