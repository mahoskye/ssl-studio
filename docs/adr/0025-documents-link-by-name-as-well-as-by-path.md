# ADR 0025: Documents link by name as well as by path

**Status:** Draft
**Date:** 2026-11-19
**Decided by:** the user, asked "Should [[double-bracket]] links lead to
documents by name?", answered "Yes, by name". How a name is matched and
what is left out are the agent's draft; the user has not reviewed them.

Under [ADR 0002](0002-text-is-the-source-of-truth.md) and
[ADR 0024](0024-markdown-is-drawn-as-it-is-written.md).

## Context

- The project's documents linked to each other by path only: a Markdown
  link, `[words](../specs/Late samples.md)`. The path is checked, mended
  and rewritten when a file moves.
- A link between two pairs of brackets, as a notebook writes it, was
  drawn in the text and led nowhere. On the page it showed as its
  brackets.
- A path is exact and long. A name is what one remembers: a ticket's
  key, what a note is called.

## Decision

- **`[[name]]` is a link to the document the name means.** Also
  `[[name|the words shown]]` and `[[name#a heading]]`. It is followed
  from the text and from the page, and the documents are offered when
  `[[` is typed.
- **A name is matched in this order**, among the documents the Docs
  panel lists, without regard to capitals: a ticket's key; a path from
  the project's folder, with or without the file's ending; a file's
  name, with or without its ending; what the document calls itself.
  Where two documents answer in the same way, the first in the order
  links are offered in is meant: tickets, then specs, and so on.
- **What is offered and written is the shortest name that means that
  document and no other:** a ticket's key; else the file's name without
  its ending; else, where another document answers to that name (two
  catalogs called INDEX), its path from the project's folder.
- **A name that means no document is not a link.** The page shows it as
  written, marked, and says so in its tooltip.
- **The text is not changed by any of this.** A link by name stays as
  it was typed; which document it means is worked out when it is shown
  or followed. The rule is in `src/shared/namedLinks.ts`.

## Consequences

- A link by a ticket's key goes on working when the ticket's file is
  moved or renamed. A link by a file's name stops meaning that file when
  the file is renamed: links by name are not rewritten on a rename, as
  links by path are.
- A name that means no document is not reported by Health, and in the
  text it is drawn like a link that leads somewhere; only the page
  marks it.
- A heading after `#` is carried on the page's link and shown in its
  words, but following the link opens the document at its top.
- Inside a table a bar ends the cell. `[[name]]` works there; with
  words to show, a backslash before the bar makes it work on the page
  and not in the text.
- A file whose name holds a bar, a hash or a bracket has no name that
  can be written between the brackets, and is not offered.
- The page works a link out again whenever the project's documents
  change; the text does when the text changes. A link written before
  its document exists is followed from the text after the next edit.
- A few shapes are read one way by the page and another by the text: a
  link by name followed at once by round brackets, one with a bar and
  no words, one with emphasis inside its brackets.
- On a page shown outside the app (a repository's site) a link by name
  is its brackets and its name. A link that must work there is written
  by path.
- Seen in the browser preview only.
