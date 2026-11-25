# ADR 0017: Documents link to each other, and the links are kept true

**Status:** Accepted
**Date:** 2026-11-19
**Decided by:** the user asked for the usual document and file work to be
easier to read and work with (2026-11-18). What that means for the links
between a project's documents is drafted here from the work; the user has
not reviewed it point by point.

Under [ADR 0002](0002-text-is-the-source-of-truth.md) and
[ADR 0009](0009-nothing-is-lost-or-destroyed-without-a-say.md). Adds to
[ADR 0012](0012-a-projects-work-is-written-down.md).

## Context

- A project's record is many small documents that point at each other: a
  catalog's line for a ticket, a decision's link to its spec, a ticket's
  `specs:` line, a registry row's ticket.
- A file that is moved or renamed leaves them pointing at nothing, and
  nothing said so until someone clicked one.
- Rewriting a link is an edit to someone's document. Finding a link by
  looking for its words finds the same words in an example of a link, and
  an edit there is wrong twice: the example is changed and the link is not.

## Decision

- **A link to a file that is not there is said:** in Health, with the
  file's name, and on the document's page, before it is clicked. Links to
  the web and to files outside the project are not judged.
- **Which words are a link is the renderer's to say.** Links are read with
  the renderer's own lexer. Where a link is in the text is asked of the
  renderer too: the place is written over with a name of our own, and is
  the link's only if the renderer then reads that name as its target. A
  link that cannot be placed that way is listed, and never edited.
- **An edit to a link is its file part and nothing else** (ADR 0002). What
  follows "#" is kept, and of the path only the part that changed is
  written anew.
- **A rename takes what names the file along, on the person's word**
  (ADR 0009). The IDE says how many places in how many documents, and
  writes nothing until it is told to. A ticket's `specs:` line and a
  spec's `plan:` line are such places. A document that is moved has its
  own links written from where it now is.
- **A link is mended only where there is one answer:** one file of that
  name elsewhere in the project. Two, and the choice is the person's.
- **A ticket's key is a way to the ticket** wherever it is written as one:
  in a document's prose, and in a registry's `ticket` column. Only the
  keys of tickets the project has, and only what is written as a key.
- **A registry row says which ticket carries it,** in a `ticket` column.
  The ticket's page lists what it has to carry across and how far that is.

## Consequences

- Reading a document's links costs two passes of the renderer. They are
  kept until the document's text changes.
- A link in a form the renderer reads and this cannot place (a target
  written with a backslash) is said when broken, and not followed by a
  rename.
- A folder moved to another depth leaves the links inside its documents
  as they were. Health says which are broken.
- A registry has one more column to keep, where it is used. The templates
  do not add it.
