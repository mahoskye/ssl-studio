# Code

The project's scripts, classes and data sources. `DueDates/` is the script
category, so a call from another script reads
`ExecFunction("DueDates.WorkCalendar.AddWorkingDays", {...})`.

The list between the two markers is written by SSL Studio from the files here (Docs panel, Update catalogs). Write anything else you like around it.

<!-- catalog -->

### DueDates

- [Availability.ssl](DueDates/Availability.ssl)
- [DueDateConstants.ssl](DueDates/DueDateConstants.ssl)
- [DueDateSummary.ssl](DueDates/DueDateSummary.ssl)
- [DueRule.ssl](DueDates/DueRule.ssl)
- [DueRules.ssl](DueDates/DueRules.ssl)
- [DueSoonReport.ssl](DueDates/DueSoonReport.ssl)
- [Holidays.ds](DueDates/Holidays.ds)
- [Outages.ds](DueDates/Outages.ds)
- [RushDueRule.ssl](DueDates/RushDueRule.ssl)
- [SamplesDueSoon.ds](DueDates/SamplesDueSoon.ds)
- [SaveDueDates.ssl](DueDates/SaveDueDates.ssl)
- [SetSampleDueDates.ssl](DueDates/SetSampleDueDates.ssl)
- [WorkCalendar.ssl](DueDates/WorkCalendar.ssl)

### Legacy

- [OldDueDateCheck.ssl](Legacy/OldDueDateCheck.ssl)

<!-- /catalog -->

## How the scripts call each other

- **`SetSampleDueDates`** reads the calendar through the `Holidays` and
  `Outages` data sources, asks `DueRules.RuleFor` for a rule, asks the rule
  for a date, and hands the planned dates to `SaveDueDates`. It gives the
  answer to `DueDateSummary.Combine` and raises the problem that names, if any.
- **`SaveDueDates`** writes the planned dates in one transaction: all of
  them, or none. A sample that got a date in the meantime is reported, not
  overwritten.
- **`DueDateSummary.Combine`** joins the samples skipped while planning
  with the ones skipped while saving, and says what was wrong with the save's
  answer in place of raising, so every case of it can be tested without a
  database.
- **`DueSoonReport`** reads `SamplesDueSoon` with `RunDS`, and uses the same
  rules, `WorkCalendar` and `Availability` to say how each sample stands.
- **`DueRule`** decides whether a day counts by asking `WorkCalendar` (is it
  a working day?) and `Availability` (is the instrument in?).
  **`RushDueRule`** inherits it and changes one answer: Saturdays count.
- **`DueDateConstants`** is pulled in with `:INCLUDE` wherever a priority, a
  skip code or the day limit is named. Each constant is a procedure:
  `DoProc("MaxWalkDays")` ([decision 9](../docs/Decisions.md)).

## What each script may do

| Script | SQL | Called by others |
| --- | --- | --- |
| `SetSampleDueDates` | yes | the script only |
| `SaveDueDates` | yes | the script only |
| `DueSoonReport` | through `RunDS` | the script only |
| Data sources | yes | with `RunDS` |
| `WorkCalendar` | no | every procedure |
| `Availability` | no | every procedure |
| `DueRules` | no | every procedure |
| `DueDateSummary` | no | every procedure |
| The two classes | no | through an object |

The three scripts keep the procedures that raise private; only the script's
own `:TRY` turns a raise into a result.

## Legacy

`Legacy/OldDueDateCheck.ssl` is left rough on purpose: SQL built from text,
deep nesting, no doc block, a deprecated keyword. It is here so that
Problems, Health and the agent's tidy steps have something to work on.
Nothing calls it, and it is not an example to follow.

## What running it settled

The tests run in the SSL sandbox runner
([tests/INDEX.md](../tests/INDEX.md)). These were in the language
reference but had not been seen working; the run exercises each:

- A base class method reaches a child's override through `Me:`.
- `Base:Constructor(args)` runs the parent's constructor, defaults included.
- An inner commit is undone when the outer transaction rolls back.
- `CToD("")` is the empty date, and `sFmt:Format` fills a template.

## Still not verified

- **`/*@private;`:** the runner does not enforce it, so nothing shows that
  another script is refused.
- **Dates without timezone conversion:** the day survives a write in the
  runner, but the runner converts nothing, so the test would pass without it.
- **The database:** the tests ran on SQLite. Nothing ran on SQL Server or
  Oracle, and nothing ran in STARLIMS.
