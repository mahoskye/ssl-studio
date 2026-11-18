# Tests

Test scripts, and what they need. Each is an SSL script whose `RunTests`
procedure runs every test in it and returns `{nPassed, nTotal, aResults}`.

All 104 pass in the SSL sandbox runner (2026-11-18). The runner is a
compatibility runtime for SSL on SQLite; it is a separate, private project,
and it is not STARLIMS. Nothing here has run in STARLIMS itself.

## Running them

From the repository root, with the runner beside this repository:

```
bun scripts/demo-sandbox.ts
```

It runs each script on a fresh copy of [demo.sql](../schema/demo.sql), and
fails if a script leaves the database changed. In STARLIMS, with the scripts
under the `DueDates` and `DueDatesTests` categories:

```
aResult := ExecFunction("DueDatesTests.WorkCalendarTests.RunTests");
```

A failing test is in `aResults` with what was expected and what came back.
A test that raises is recorded as failed, and the rest still run.

## Tests that need no database

| Script | Tests | What it covers |
| --- | --- | --- |
| `WorkCalendarTests` | 11 | Weekends, holidays, the next working day |
| `AddWorkingDaysTests` | 9 | Counting forward, month ends, the day limit |
| `AvailabilityTests` | 11 | Outages, other instruments, ids with spaces |
| `OutageDaysTests` | 7 | Days out in a span, overlaps, empty dates |
| `DueRuleTests` | 8 | The worked examples `S-1001` to `S-1007` |
| `DueRuleEdgeTests` | 10 | Rush with holidays and Sundays, limits, defaults |
| `DueRulesTests` | 6 | Which rule a priority gets |
| `DueDateSummaryTests` | 11 | Joined skips, and each answer that is not a summary |

## Tests that need the database

These need the three tables and the rows of `demo.sql`, loaded fresh.

- **`SetSampleDueDatesTests`** (7 tests): the result's shape, the skips, the rules.
- **`SaveDueDatesTests`** (5 tests): saving a plan, a sample no longer waiting, a plan that is not one.
- **`RollbackTests`** (3 tests): a failing row undoes the rows written before it.
- **`SamplesDueSoonTests`** (8 tests): the window, both ends included, bad input.
- **`DueSoonReportTests`** (8 tests): statuses, rows, a bad window, a source that is not there.

Each test but those in `RollbackTests` runs inside a transaction that is
rolled back, so the rows are left as they were found. `RollbackTests` owns
its outermost transaction: a rollback inside another transaction is only
carried out when the outer one ends, so it cannot be tested from inside one.

## Shared scripts

- `TestSupport`: `RunAll` runs a script's tests, `CheckEqual` compares, and
  `DemoHolidays`, `DemoOutages` and `NewRule` build what the tests use.
- `DbTestSupport`: `RolledBack`, `AddSample`, `DueOn`, `SkipCode` and
  `PlannedRow`, for the tests that touch the tables.

## What the first run found

The scripts were clean under the language server and had never run. The
first run found three things validation had not:

- `DoProc("CheckEqual", aCheck)` does not compile: the arguments must be
  written as an array literal.
- Constants declared in an include were undefined in a procedure another
  script called by name ([decision 9](../docs/Decisions.md)).
- A rollback test could not pass inside the test runner's own transaction.

## Not tested

- One `:IF` in `SetSampleDueDates.ApplyDueDates`: the one that raises the
  problem `DueDateSummary.Combine` found in what `SaveDueDates` answered.
  Reading the answer is tested in `DueDateSummaryTests`, and a save that
  fails in `SaveDueDatesTests`; nothing a test can do makes
  `SetSampleDueDates` itself get a failed save. Changing the condition to
  never raise leaves all 104 tests passing.
- `/*@private;`, and anything on SQL Server or Oracle
  ([src/README.md](../src/README.md)).
