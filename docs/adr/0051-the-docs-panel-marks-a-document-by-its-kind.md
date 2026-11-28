# ADR 0051: The Docs panel marks a document by its kind

**Status:** Accepted
**Date:** 2026-11-27
**Decided by:** the user, who asked for a different icon for specs and for
catalogs, "maybe better icons for all of the markdown items to help them be
understood better". Which glyph each kind takes is the agent's choice; the
user has not reviewed it.

Under [ADR 0032](0032-design-precedents-and-interaction-standards.md): the
curated sidebar names each document in one friendly standard.

## Context

- The Docs panel drew each file's mark from its type alone, as the Explorer
  does. Every Markdown document had the same mark, so a ticket, a spec, a
  catalog and a decision looked alike, and only the words told them apart.
- The panel already knows what each document is: the folder it is in
  (tickets, specs, the knowledge base's decisions and questions, the schema
  folder), and its name (a catalog is `INDEX.md`; the project's own files are
  README, AGENTS and STATE).

## Decision

- **In the Docs panel a document's mark says what it is**, from the icon set
  the app already uses. Its colour is still its file type's, so Markdown
  stays one colour and a registry the colour of data.

  | Kind | Glyph | Why |
  | --- | --- | --- |
  | Catalog | list-unordered | A list of what the folder holds, wherever it lies |
  | Ticket | tasklist | Work to do, with its task list |
  | Spec | preview | A sheet that lays out what is built |
  | Decision | law | A ruling |
  | Question | question | |
  | Reference note | note | |
  | Prompt | comment-discussion | Something said to the Agent |
  | Snippet | symbol-snippet | When written in Markdown |
  | Registry | table | A CSV of rows to check off |
  | Schema: table | database | A database table's columns |
  | Schema: interface | plug | A message in or out |
  | Schema: file layout | file-text | A file's layout |
  | Schema, other | symbol-structure | A schema folder of the project's own |
  | README | info | The project's overview |
  | AGENTS | robot | Instructions for the Agent |
  | STATE | dashboard | Where the project stands |

- What has no kind keeps its file's mark: a plan, a script, SQL, a Markdown
  document in no folder of a kind. A mark's tooltip names the kind.
- No mark repeats a panel's icon in the activity bar (the library, the book,
  the pulse, the sparkle), so a row is not mistaken for a panel.
- The Explorer and the tabs keep marks by file type: they show files, not
  the project's documents.

## Consequences

- The project's "Deployment" and "Tests" rows are their folders' catalogs and
  take the catalog's mark; their names say which folder.
- The kinds live in `docKindOf` (`src/shared/projectDocs.ts`) and the glyphs
  in `src/view/fileIcon.ts`; a new kind of document needs an entry in both.
