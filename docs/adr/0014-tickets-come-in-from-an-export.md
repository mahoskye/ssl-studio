# ADR 0014: Tickets come in from an export, and people are left out

**Status:** Accepted; two points superseded by
[ADR 0016](0016-an-export-is-read-where-it-lies-and-comes-across-as-markdown.md)
(where the export is, and a description's markup)
**Date:** 2026-11-18
**Decided by:** the user said most projects come from a Jira ticket or a
similar source, with its related tickets (2026-11-18). How they are read in
is drafted here from that; the user has not reviewed it point by point.

Adds to [ADR 0012](0012-a-projects-work-is-written-down.md), which had a
ticket pasted in by hand.

## Context

- A piece of work is seldom one ticket. Typing each one's key, title and
  state, and pasting each description, is slow and goes stale: the ticket
  moves on in the ticket system and the file does not.
- The IDE does not talk to a ticket system, and should not need an
  account, a token or a network to open a project.
- Every ticket system can give out a table of its tickets, and most an
  answer from an API. Those hold more than the work: who reported a ticket,
  who it is assigned to.

## Decision

- **Tickets are read from a file the ticket system gave out:** a table
  (CSV or TSV), or the JSON its API returns: one issue, a list, or a list
  under `issues`. The file is in the project's folder; the IDE fetches
  nothing.
- **Columns are found by their names**, whatever their case: a key
  (`Issue key`, `Key`, `ID`), a title (`Summary`, `Title`), a state, a
  kind, a description, a parent, a link, and every column that ties one
  ticket to another. A row with no key or no title is passed over, and
  counted.
- **A ticket not in the folder gets its file**, with what the export said
  in its front matter and the description as what was asked, in the
  ticket's own words and its own markup.
- **A ticket already in the folder keeps what was written in it.** Its
  state, its title and its kind are set in its front matter where they
  differ; nothing else in the file changes. Read again from a newer export,
  a folder of tickets is brought up to date.
- **People are left out.** Who reported a ticket and who it is assigned
  to are not read. A project's folder is often shared more widely than the
  ticket system is.
- **It asks first,** saying how many tickets are new and how many are
  already there, and says afterwards what it did.

## Consequences

- A project can start from the ticket and the tickets around it in one
  step, and be brought up to date the same way.
- The export stays in the folder until someone removes it. It may hold the
  people the ticket files leave out: that is the person's to keep or delete.
- A description comes as the ticket system wrote it. Markup that is not
  Markdown shows as written.
- A table with an `ID` and a `Name` reads as tickets whether or not it is
  one. The count shown before anything is written is the guard.
- Not covered: fetching from a ticket system, comments, attachments, and
  tickets removed from the export, which stay in the folder.
