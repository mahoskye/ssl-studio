# ADR 0012: A project's work is written down where the project is

**Status:** Accepted
**Date:** 2026-11-19
**Decided by:** the user asked for the docs side of a project to carry the
tickets that drive the work, the work as it is spec'd out, a knowledge base
with catalogs, and registries for a migration, and for TOML, Markdown, SQL,
JSON and other documents to be handled (2026-11-19). The folder names, the
file formats and the catalog's form are drafted here from that; the user has
not reviewed them one by one.

Adds to [ADR 0006](0006-a-project-has-settings-a-readme-and-an-agents-file.md).
Under [ADR 0002](0002-text-is-the-source-of-truth.md).

## Context

- Work on a project starts from a ticket, in Jira or something like it, and
  the tickets related to it. Nothing in the project said which ticket a
  script, a plan or a decision came from.
- The Docs panel listed the Markdown in the docs folder as one flat list. A
  decision, a question nobody has answered and a query kept for use looked
  the same, and were found by remembering a file's name.
- A migration is checked against lists: the application's settings, its
  files, its database objects. Those lists lived in spreadsheets outside the
  project.
- Every file that was not SSL was plain text in the editor.

## Decision

Four folders under the project's docs folder, each with a catalog:

| Folder | What it holds |
| --- | --- |
| `tickets/` | The tickets that drive the work, one file each |
| `specs/` | What is to be built, written from the tickets |
| `knowledge/` | Decisions, questions, snippets and reference notes |
| `registries/` | Tables of what a migration must carry across |

- **A ticket is a Markdown file named by its key**, `LIMS-123.md`. Its
  front matter says its key, its title, a link to it, its state, and the
  tickets it is related to. Its body is what was asked, in the ticket's own
  words. The IDE does not talk to a ticket system: a ticket is pasted in.
- **Spec'd out work is a spec.** A spec is a Markdown file whose front
  matter names the ticket it is for and its state. A spec the planner
  writes beside a plan (`design/*.spec.md`) is a spec as well: a ticket
  names it in its `specs` list, since that file is the planner's to write.
  The Docs panel shows each ticket with its specs under it.
- **The knowledge base keeps one thing in a file**, each kind in its
  folder: `decisions/` (numbered), `questions/` (open or answered),
  `snippets/` (SQL and SSL kept for use, titled by the comment they open
  with) and `reference/`.
- **A registry is a CSV file**: its first row names its columns, and a
  `status` column, where it has one, says how far each row has come. It is
  CSV because a registry is long and narrow, a spreadsheet opens it, and a
  change to one row is one changed line. Three are offered: application
  settings, a file manifest, database objects. Any other can be made.
- **The file manifest is written from the folder**: each file of the
  project's work with its size, its lines and a SHA-256 checksum. Written
  again, it keeps a person's status, notes and own columns, and says what is
  new, what has changed and what has gone. The documents about the work are
  not in it.
- **A catalog is the folder's `INDEX.md`.** Its list, one line for each
  document with its title, state and what it is about, is written by the
  IDE between two marker comments. Everything else in the file is the
  person's. The IDE says when a list is out of date and writes it afresh
  when asked; it also writes it when it makes a document itself.
- **Front matter is the few lines a document says of itself**: `key:
  value`, a list on one line or as dashes. A state is any word; the usual
  ones are drawn as done, under way, waiting or set aside.
- **`STATE.md`** at the top of the docs folder says where the project
  stands, in plain words.
- **Documents are read as what they are.** Markdown, SQL, JSON, TOML, CSV,
  YAML, XML and INI are coloured, through the same theme matching as SSL. A
  registry opens as a table, in which a cell is changed by changing that
  part of the text. A Markdown document's front matter is shown above it,
  with a ticket or a file as a link, and its code is coloured.

## Consequences

- A project carries its own record of why it exists and how far it is. An
  agent finds the ticket, the decisions and the open questions in the
  folder it works in, and the project's AGENTS file says where.
- Nothing here needs a model, a network or a ticket system.
- Two places hold specs: `specs/` and, for the planner's, `design/`. The
  catalog and the panel list both; moving the planner's specs is a decision
  for [ADR 0005](0005-a-plan-is-a-document-of-its-own.md) to revisit.
- A catalog can be out of date until someone asks for it to be written. The
  panel and the file's own row say so.
- The folder names are fixed. `project.toml` renames the docs folder, not
  the four inside it.
- Not covered: reading tickets from a ticket system, checking a registry's
  rows against the code or a database, and telling which tables a script
  uses, which needs the language server (ADR 0003).
