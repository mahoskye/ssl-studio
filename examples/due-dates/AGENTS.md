# Instructions for agents working on Due dates

Agents read this file before they work in this project. Keep it short and
specific to this project.

## What this project is

A demo project for developing SSL Studio. It sets the due date of lab samples
from their turnaround, the working calendar and instrument availability.
Nobody runs it in production; it has to stay small, readable and correct.

## Rules

- Follow the house style. The language server reports what breaks it.
- Keep each script under the size limits the Health panel shows.
- Do not rename a procedure or change its parameters unless asked.
- Everything here is invented. Do not bring in code, table names or data from
  a real STARLIMS system.
- `WorkCalendar`, `Availability`, `DueRules`, `DueDateSummary` and the two
  classes run no SQL: they are given what they work on. SQL is in
  `SetSampleDueDates`, `SaveDueDates` and the three data sources only.
- A procedure that reports failure by raising is `/*@private;`, so that only
  the script's own `:TRY` can call it. Nothing else is annotated.
- A walk through days never looks more than 730 days ahead (`MaxWalkDays`),
  and returns an empty date for an empty one.
- A constant is a procedure in `DueDateConstants`, read with a one-part
  `DoProc("MaxWalkDays")`. A variable declared in an include is not there
  when another script calls one of this script's procedures by name.
- `DoProc`'s arguments are written as an array literal, `{a, b}`, never
  passed as a variable: the compiler refuses the second form.
- Run the tests after a change: `bun scripts/demo-sandbox.ts` from the
  repository root. The language server accepts things that do not run.
- `src/Legacy/OldDueDateCheck.ssl` is rough on purpose. Do not tidy it in a
  commit, call it, or copy from it.
- A rule about which days count belongs in `DueRule` or a class that inherits
  it, not in `SetSampleDueDates`.
- A table in the docs has at most four columns, short values in every column
  but the last, and at most one sentence in a cell. More than that becomes a
  short table and a section for each row (docs/Worked-examples.md).
- Server side only. Forms, client scripts and code-behind are on hold
  (docs/Decisions.md): do not add them until the user says so.

## Where things are

- `src/DueDates/`: the scripts, classes, include and data sources. The folder
  name is the script category:
  `ExecFunction("DueDates.WorkCalendar.AddWorkingDays", ...)`.
- `src/Legacy/`: the one rough script.
- `docs/`: notes and decisions.
- `docs/tickets/`: the tickets the work comes from, one file each. Read the ticket before starting on it.
- `docs/specs/`: what is to be built, written from the tickets.
- `docs/knowledge/`: decisions, questions, snippets and notes. Look here before deciding again.
- `docs/registries/`: the settings, files and database objects, as tables.
- Each of those four has an `INDEX.md`, its catalog. Do not edit the list between its markers.
- `schema/`: the tables the project reads and writes. Check a table here before writing SQL for it.
- `tests/DueDatesTests/`: test scripts and what they need. `TestSupport` runs
  them; `DbTestSupport` is for the ones that need the database.
- `design/`: the plan for `SetSampleDueDates` (chart, spec, build record),
  and tidy notes.
