# ADR 0026: The schema folder is kept by kind, and prompts are kept

**Status:** Draft
**Date:** 2026-11-20
**Decided by:** the user: "the schema directory would need to be split
into multiple subdirectories", the database's schema "has to be its own
subdirectory", "there are other schema that we should include", and "we
need another directory like the snippets but for prompts". Asked which
other kinds the app should offer, the user chose Interfaces and Files.
What each kind holds, how they are listed, and how a kept prompt is
used are the agent's draft; the user has not reviewed them.

Under [ADR 0006](0006-a-project-has-settings-a-readme-and-an-agents-file.md)
and [ADR 0012](0012-a-projects-work-is-written-down.md).

## Context

- A project's schema folder held one kind of thing: the tables it
  reads and writes, each described in a Markdown file, with the SQL
  that makes them beside it. Every file lay at the folder's top.
- A project's data has other shapes that are as much worth writing
  down: what it exchanges with instruments and other systems, and the
  files it reads and writes. They had nowhere to go.
- The knowledge base keeps snippets: SQL and SSL kept for use, offered
  where code is written. What a project's people ask the agent again
  and again had no such place; the Agent panel offered four questions
  of the app's own.

## Decision

- **The schema folder holds a folder for each kind of thing it
  describes.** The app knows three.

| Folder | One file is | The folder holds |
| --- | --- | --- |
| `database/` | A table | The tables the project reads and writes |
| `interfaces/` | A message | What is exchanged with instruments and other systems |
| `files/` | A file layout | The files the project reads or writes |

- **Any other folder there is a kind of the project's own**, listed
  under its folder's name. What lies at the top of the schema folder is
  still listed, under "At the top". Nothing is moved for a project: its
  files are listed where they are.
- **A description is a Markdown file**: what the thing is, then a
  table of its columns or fields. Beside it may lie the SQL that makes
  a table, a message's own schema or a sample of it (JSON, XML, XSD, WSDL,
  YAML, HL7),
  a sample of a file (CSV, TSV, text): those are listed too.
- **"Set up project" makes the three folders**, each with a README
  that says what goes in it, in a folder that has no schema folder
  yet.
- **Prompts are a kind of the knowledge base**, beside the snippets,
  in `knowledge/prompts/`: one Markdown file for each. Its heading is
  its name; the rest is the words put to the agent.
- **A kept prompt is offered in the Agent panel**, under the app's own
  questions, by its name. Choosing one puts its words in the question
  box, to send as they are or to change first. Nothing is sent by
  choosing it.

## Consequences

- The Docs panel's Schema list has a heading for each kind, each with
  its own menu: a new table, message or file layout from a template, a
  new folder, the folder's place in the Explorer.
- The demo project's tables moved into `schema/database/`, with the
  links to them.
- The registry of database objects still reads the SQL anywhere under
  the schema folder.
- A project that keeps its tables at the top of its schema folder sees
  them under "At the top" until it moves them. The app does not move them.
- A prompt is plain words. It names no model and carries no settings:
  which model answers is the project's and the user's setting, as
  before.

## Not decided

- Whether the agent is told a project's schema when it is asked about
  a script: the request to the language server for the tables a script
  uses is still open (LSP-REQUESTS, L6).
- Whether a prompt can take the place of the app's own four questions,
  or be put to the agent from the editor's menu.
- Forms and their layouts are not a kind here: front-end work is on
  hold.
