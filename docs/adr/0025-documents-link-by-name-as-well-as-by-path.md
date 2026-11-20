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

- A link whose name still means its document after a file is moved or
  renamed (a ticket's key written in the ticket, most often) is left as
  it is. One that no longer does is offered a new name: see the changes
  to this draft.
- A name that means no document is not reported by Health, and in the
  text it is drawn like a link that leads somewhere; only the page
  marks it.
- A heading after `#` is carried on the page's link and shown in its
  words, but following the link opens the document at its top.
- Inside a table a bar ends the cell. `[[name]]` works there; with
  words to show, the bar is written after a backslash.
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

## Changes to this draft

A decision is superseded, not rewritten. This one has not been accepted,
and was changed while it was a draft; what changed is kept here.

- 2026-11-19, after the user answered "Yes, both" to "Should I build
  backlinks and rename-following for [[name]] links next?":
  - **A rename is followed.** After a file or a folder is renamed, the
    links by name that named a moved document by its file's name or its
    path are counted and, on the person's word, written with the new
    name. Only the name is written; the heading and the words shown
    stay. This comes after the same question for links by path. The
    consequence that said such links stop working is taken out.
  - **A page lists what links to it.** Under a document's text, "Linked
    from" names each document that links to it, by path or by a name
    that means it, with how many places where there is more than one.
    It is read from the files on disk: what is typed and not yet saved
    is not counted.
  - **A link is followed when it no longer means what it meant**, not
    only when its own document moved: a link to a note whose name the
    renamed file took is given the note's path. The documents as they
    are after the rename are asked for afresh, since what a document is
    called can change with where it is.
  - Both read every Markdown document of the folder (up to 2,000, none
    larger than a megabyte, the rest left out without a word), the list
    again whenever the project's documents are listed again: on every
    save. At the example's 33 documents that is a few milliseconds; a
    reviewer measured half a minute for the links by path of 2,000
    documents of 8 KB, where their cache no longer holds.
  - The documents as they were are taken as the rename is made, before
    any question is asked. Where the list in hand was already of after
    the rename, the documents are known only by what they are called
    now, and a link by what a moved document used to call itself is
    then missed.
  - Not done: a file moved in from outside the project's documents may
    take a name a link meant another document by, and nothing is asked;
    a link by a path that named such a file before it was a document is
    offered its new name all the same; choosing an offered document in
    the middle of a table's link drops the backslash before its bar; a
    span of code that runs over a line's end is read as prose on its
    first line; a link typed and not yet saved is neither listed nor
    followed; a document moved out of the project's documents, or to a
    name that cannot stand between the brackets, is left with its links
    meaning nothing, and nothing is said; code set in by four spaces is
    read as prose, so a link by name in it is listed and followed.

