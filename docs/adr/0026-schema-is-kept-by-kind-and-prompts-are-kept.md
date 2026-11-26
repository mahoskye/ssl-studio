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

## Changes to this draft

**2026-11-20, the same day, on the user's word after using it.** Three
things above no longer stand as written:

- **The schema folder has a catalog, not READMEs.** The user: "At the
  top feels out of place since we seem to use the automatically
  generated catalog", and "instead of serving a readme, maybe we use
  the index approach. I prefer approaches be consistent wherever
  possible." The schema folder's `INDEX.md` is its catalog, written
  and kept as those of the tickets, specs, knowledge base and
  registries are: a list between two markers, under the kinds, with
  anything written around it left alone. "Set up project" makes that
  one file, which names the kinds; a kind's folder comes with the
  first thing described in it. No README is made for the folder or
  for a kind. The Docs panel shows the catalog last in the Schema
  list, and Health says when it is out of date or missing.
- **What lies at the top of the schema folder** is listed under "At
  the top" only when something other than the catalog lies there.
- **Interfaces are contracts too.** Asked whether what is agreed with
  an outside system belongs under interfaces or somewhere of its own,
  the agent's answer was interfaces, and the user agreed. A folder
  inside a kind's folder is a heading of its own in the list: for
  interfaces, a folder for each system. A message opens with whom it
  is exchanged with, which way it goes, the version agreed and how
  far the agreement is (`draft`, `agreed`, `retired`), and says where
  the agreed specification is kept. The agreed specification itself
  (OpenAPI, WSDL, XSD) lies beside the description. What is not the
  shape of data (obligations, service levels, who signs off a change)
  is prose, and belongs in the docs folder or the knowledge base.

Not decided by this: whether the READMEs that "Set up project" writes
for the docs, tests and code folders should give way to something
generated too. They are as they were.

**2026-11-20, later the same day, on the user's word.** Asked whether
the READMEs that "Set up project" writes for the docs, tests and code
folders should become generated catalogs too, with the agent's own
advice against it for the tests and the code (a list of files says
what the Explorer says), the user answered "Yes, those too". So:

- **The docs, tests and code folders have catalogs too**, each an
  `INDEX.md` that says what the folder is for and lists what it
  holds. "Set up project" writes those in place of the READMEs. The
  project's own `README.md` and `AGENTS.md` are still written: they
  are the project's, not a folder's.
- **The docs folder's catalog** lists the plain documents there, those
  in a folder under that folder's name, and then the way to the
  catalogs of the tickets, specs, knowledge base and registries.
- **The tests' and the code's catalogs** list their files as they
  lie, each by its name, under the folder it is in. Nothing is read
  from a script: what a script is for is the language server's to
  say (ADR 0003).
- **They are kept as the others are**: written afresh when the app
  makes, renames, moves or throws away a file in the folder, by
  "Update catalogs", and marked out of date when the folder has
  changed by another hand. Health says so.
- **A project may do without them.** A docs, tests or code folder
  with no catalog is not asked for one, and "Update catalogs" does
  not start one: "Start folder catalogs" does, when asked. A file of
  the catalog's name that a person keeps there, with no place for the
  list, is theirs: it is not marked and nothing is written into it.
- **A plain document is linked as it was.** Its heading is in its
  line of the docs folder's catalog and is not a name `[[...]]` finds
  it by: a name goes on meaning what it meant.
- **Not catalogued**: a tests or code folder that is the project's
  own folder (a list of everything in the project is no catalog), a
  folder another of these already is (tests kept in the code's own
  folder have the code's), and one with more than a thousand files,
  which the Explorer and search are the way into.
- **Where they show**: the docs' as the Catalog row at the end of the
  Docs list; the tests' and the code's with the project's own files,
  since those folders have no list of their own in the panel.

**2026-11-25, on the user's word.** One thing under "Not decided" no
longer stands as written:

- **The language server is not asked for the tables a script uses.** The
  request (LSP-REQUESTS, L6) is withdrawn and its issue closed. The user:
  "I don't want to bloat the lsp by adding ide features when it should not
  be the lsps responsibility." Which tables a script names is the IDE's own
  to find, from the names of the tables a project describes; the server is
  asked only where comments and strings are (LSP-REQUESTS, L9). Whether the
  agent is told a project's schema is no longer waiting on the server.

**2026-11-25, later, on the user's word.** How much the tables count for:

- **Table information is an extra, and the IDE's own.** The user: "any
  connection with table information and data sources / sql will need to be
  handled in the application itself. it is atypical that we would normally
  have database information and it should be treated as a bonus feature
  built into the app." So nothing the IDE does may depend on a project
  describing its tables, and nothing about SQL is asked of the language
  server.
- **In the code**, as of that day: the comments in a data source's SQL
  are found by the IDE (`withoutComments`, `src/shared/lexicalTokens.ts`);
  and a project that describes no table is put to no work for the feature,
  with no request sent to the server for it (`hasSchemaTables`,
  `src/shared/schemaIndex.ts`). That second point is how the first was
  read, not something the user said.
