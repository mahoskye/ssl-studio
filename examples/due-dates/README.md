# Due dates

Works out when a lab sample is due: the received date plus its turnaround,
counting only the days the lab is working and the instrument the sample needs
is available. It is a demo project for developing SSL Studio; every script,
table and date in it is invented.

## How a due date is worked out

1. Start on the day after the sample was received.
2. A day counts when it is a working day and the sample's instrument is
   available on it.
3. The sample is due on the day the count reaches its turnaround.

| Concern | Where | Rule |
| --- | --- | --- |
| Working days | `WorkCalendar` | Not a weekend, and not a holiday in `DEMO_HOLIDAYS` |
| Availability | `Availability` | The sample's instrument is not inside an outage in `DEMO_OUTAGES` |
| Priority | `RushDueRule` | A rush sample also counts Saturdays |

A sample with no instrument is never held up by an outage.

## What is here

| Folder | What it holds |
| --- | --- |
| `src/DueDates/` | The scripts, the two classes, the include and the data sources |
| `src/Legacy/` | One script left rough on purpose, for the IDE to tidy |
| `docs/` | Notes and decisions |
| `schema/` | The three tables the project reads and writes |
| `tests/DueDatesTests/` | Test scripts, and the two scripts they share |
| `design/` | The plan for `SetSampleDueDates`: its chart and its spec |

## The scripts

| Script | Kind | What it does |
| --- | --- | --- |
| `SetSampleDueDates` | script | Plans a due date for every sample that has none |
| `SaveDueDates` | script | Saves planned due dates, all of them or none |
| `DueDateSummary` | utility | Joins the skips and reads what saving answered |
| `DueSoonReport` | script | Lists the samples due soon, with their rule and status |
| `DueRule` | class | A turnaround in working days; returns a due date |
| `RushDueRule` | child class | `DueRule`, counting Saturdays as well |
| `DueRules` | utility | Picks the rule for a priority |
| `WorkCalendar` | utility | Weekends, holidays, counting working days |
| `Availability` | utility | Whether an instrument is available on a day |
| `DueDateConstants` | include | Priorities, skip codes and the 730-day limit |
| `SamplesDueSoon` | data source | The samples due in the next few days |
| `Holidays` | data source | The days the lab is closed |
| `Outages` | data source | The days each instrument is out |
| `OldDueDateCheck` | rough on purpose | Flags overdue samples the old way; nothing calls it |

[src/README.md](src/README.md) says how the scripts call each other.

## What it shows in SSL Studio

- **`SetSampleDueDates.ssl`:** regions as frames in Blocks, the size meter, the Objects outline.
- **`DueSoonReport.ssl`:** `:BEGINCASE` arms, a text `:REGION`, nested regions, a `RunDS` call.
- **`DueRule.ssl` and `RushDueRule.ssl`:** a class and the one that inherits it.
- **The call graph:** scripts joined by their calls, the data sources and the include.
- **`SetSampleDueDates.plan.json`:** a plan with its spec and build record, so its steps link to the code.
- **`OldDueDateCheck.ssl`:** findings in Problems and Health, and something to run Tidy on.
- **The Docs panel:** these documents rendered, and the schema.

## Working on it

Open this folder in SSL Studio (`hutch run web examples/due-dates` from the
repository root).

- **Checked:** every script but `OldDueDateCheck` is clean under the pinned
  language server's strict validation, and the repository's tests keep it so
  (`test/examples.test.ts`).
- **Run:** all 104 tests pass in the SSL sandbox runner
  (`bun scripts/demo-sandbox.ts`, 2026-11-18). The runner is a compatibility
  runtime on SQLite, not STARLIMS: nothing here has run in STARLIMS itself.
  [tests/README.md](tests/README.md) says what the run does and does not show.
- **Expected in Problems:** an information row for each `/*@private;` marker
  in `SetSampleDueDates`, `SaveDueDates` and `DueSoonReport`. The markers are
  required ([decision 7](docs/Decisions.md)).
