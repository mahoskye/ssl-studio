# ADR 0016: An export is read where it lies, and a description comes across as Markdown

**Status:** Accepted
**Date:** 2026-11-19
**Decided by:** the user said most projects come from a Jira ticket or a
similar source (2026-11-18). What that takes, once real exports were looked
at, is drafted here from the work; the user has not reviewed it point by
point.

Supersedes two points of
[ADR 0014](0014-tickets-come-in-from-an-export.md): that the export is in
the project's folder, and that a description keeps its own markup. The rest
of ADR 0014 stands.

## Context

- An export is downloaded. It lands where downloads land, not in the
  project, and copying it in was a step before the first step.
- The shapes of four real sources were read, for their names and their
  structure only, and invented tickets in those shapes were run through
  the reader: a Jira server's CSV export and its search API, a Jira Cloud
  site's search API, and GitHub's two forms of its issues.
- A Jira server writes a description in its wiki markup. Left as it is in
  a Markdown document, a numbered list reads as a heading and a block of
  code as stray braces.
- Jira Cloud gives a description as a tree of nodes, not as text. Taking
  its words alone loses what is a heading, what is code and what is a list.
- GitHub keeps what was asked under another name, lists pull requests
  among its issues, and writes a state in capitals.

## Decision

- **An export is read from where the person says it is.** In the app, the
  system's file dialog; anywhere, a whole path typed in. Only a table or
  JSON is read, and only by the person's own choice of file. The IDE still
  fetches nothing.
- **A description comes across as Markdown.** Wiki markup from a source of
  the Jira kind, and a tree of nodes, are written as the same headings,
  lists, code, quotations, tables and links in Markdown.
- **Every word is kept.** A node or a mark that is not known is written as
  the words it holds. What was attached is not brought across, and the
  description says something was there.
- **What looks like a mark and is not one is written as itself:** a line
  that begins "1.", a star in a sentence, a word in angle brackets.
- **Markup is not guessed.** Only a source known to write wiki markup is
  turned into Markdown. Markdown from a source that writes Markdown is
  left as it is, whatever it holds.
- **A description's headings go under the ticket's own sections,** so a
  ticket has one title. Only the marks before a heading change.
- **A ticket is put under what it is part of:** its parent, found by the
  system's own number where the export gives that; failing a parent, its
  epic.
- **A pull request is not a ticket,** and is passed over and counted. An
  issue closed without being done says so, and is not counted as done.

## Consequences

- A ticket's file is no longer the description as the ticket system wrote
  it, mark for mark. The ticket keeps a link to its page there.
- A reader of each markup now lives here. Each can be wrong, and was: two
  reviews found words dropped and marks misread. They are tested against
  the shapes real sources give out, with invented tickets.
- The export can stay outside the project, so the people it names need
  not come into a folder that is shared more widely.
- Not covered: Jira Cloud's CSV export, other ticket systems, and an
  export from the user's own system, which has not been tried.
