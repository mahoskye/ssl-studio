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
| `src/DueDates/` | The scripts, the two classes and the data source |
| `docs/` | Notes and decisions |
| `schema/` | The three tables the project reads and writes |
| `tests/DueDatesTests/` | Test scripts for the calendar, availability and the rules |
| `design/` | The plan for `SetSampleDueDates` as a flow chart |

## The scripts

| Script | Kind | What it does |
| --- | --- | --- |
| `WorkCalendar` | utility | Weekends, holidays, adding working days |
| `Availability` | utility | Whether an instrument is available on a day |
| `DueRule` | class | A turnaround in working days; returns a due date |
| `RushDueRule` | child class | `DueRule`, counting Saturdays as well |
| `SetSampleDueDates` | script | Sets `DUE_ON` for every sample that has none |
| `SamplesDueSoon` | data source | The samples due in the next few days |

## Working on it

Open this folder in SSL Studio (`hutch run web examples/due-dates` from the
repository root). The tests are SSL procedures that run inside STARLIMS; they
have not been run there.
