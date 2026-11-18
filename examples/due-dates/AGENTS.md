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
- `WorkCalendar` and `Availability` take their holidays and outages as
  arrays and run no SQL. Only `SetSampleDueDates` and `SamplesDueSoon` touch
  the database.
- A rule about which days count belongs in `DueRule` or a class that inherits
  it, not in `SetSampleDueDates`.
- A table in the docs has at most four columns, short values in every column
  but the last, and at most one sentence in a cell. More than that becomes a
  short table and a section for each row (docs/Worked-examples.md).
- Server side only. Forms, client scripts and code-behind are on hold
  (docs/Decisions.md): do not add them until the user says so.

## Where things are

- `src/DueDates/`: scripts and the data source. The folder name is the script
  category: `ExecFunction("DueDates.WorkCalendar.AddWorkingDays", ...)`.
- `docs/`: notes and decisions.
- `schema/`: the tables the project reads and writes. Check a table here before writing SQL for it.
- `tests/DueDatesTests/`: test scripts and what they need.
- `design/`: plans and tidy notes.
