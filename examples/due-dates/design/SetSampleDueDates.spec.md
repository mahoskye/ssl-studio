# Set sample due dates

The spec for `src/DueDates/SetSampleDueDates.ssl`, `src/DueDates/SaveDueDates.ssl` and
`src/DueDates/DueDateSummary.ssl`, as they were built. The chart is
`design/SetSampleDueDates.plan.json`; this says what the chart leaves out.

## Prior art

Everything the scripts need already exists in the project, and they reuse it:

- `DueDates.DueRules.RuleFor` picks the rule for a priority.
- `DueDates.DueRule` and `DueDates.RushDueRule` work out a due date. They read no tables.
- The data sources `DueDates.Holidays` and `DueDates.Outages` read the calendar.
- `DueDates.DueDateConstants` gives the skip codes and the 730-day limit, as procedures.

## Three scripts

Planning, saving and reading the save's answer are separate scripts, so that each can be called and tested alone.

- **`SetSampleDueDates`** takes no parameters. It reads, plans, and hands the planned dates over.
- **`SaveDueDates(aPlanned)`** takes rows `{sSampleId, dDue}`. It saves all of them or none.
- **`DueDateSummary`** has one procedure, `Combine`. It reads no tables and raises nothing.

The first two return the same two shapes:

- **On success:** `{.T., {nSet, nSkipped, aSkipped}}`. Each skip is `{sSampleId, sCode, sText}`.
- **On failure:** `{.F., {"DUE_DATES_NOT_SAVED", "No due dates were saved."}}`. The error's own text goes to the server log only.

## Procedures

In `SetSampleDueDates`, all private: each reports failure by raising, so only the script's own TRY may call it.

- `LoadHolidays()` returns the holidays as an array of dates.
- `LoadOutages()` returns rows `{sInstrumentId, dFrom, dTo}`, with `dTo` included.
- `ApplyDueDates(aHolidays, aOutages)` reads the samples, plans each, hands the dates to `SaveDueDates` and its answer to `Combine`. It raises the problem `Combine` names, and otherwise returns `{nSet, nSkipped, aSkipped}`.
- `PlanDueDate(aSample, aHolidays, aOutages)` writes nothing. It returns the due date, or an empty date and the reason.

In `SaveDueDates`:

- `WriteDueDates(aPlanned)`, private, holds the one transaction. It returns `{nSet, nSkipped, aSkipped}`, and raises after rolling back.
- `SaveDueDate(sSampleId, dDue)`, private, writes one date. It returns `.F.` when the sample no longer needed one.
- `IsPlannedRow(vRow)` says whether a row is a sample id and a day. It raises nothing, so it is not private.

In `DueDateSummary`:

- `Combine(aPlanSkips, aSaved)` returns `{sProblem, aSummary}`. With nothing wrong, the problem is empty and the summary is `{nSet, nSkipped, aSkipped}`: the skips found while planning, then the ones found while saving.
- It tests each type before it reads the value, and names the first thing wrong: an answer that is not an envelope, a save that failed, a summary that is not a count and a list.
- It adds to a new list. The list of planning skips it was handed is left as given.

## Why a sample is skipped

| Code | When |
| --- | --- |
| `NO_RECEIVED_DATE` | The sample has no received date |
| `NO_TURNAROUND` | Its turnaround is empty, zero or less |
| `TURNAROUND_NOT_REACHED` | The count does not finish within 730 days |
| `NOT_WAITING` | It got a due date, or was removed, after it was read |

A skip is not a failure: the script still returns `.T.`.

## Data and transactions

- **Reads:** `DEMO_SAMPLES` where `DUE_ON` is empty, in `SAMPLE_ID` order; `DEMO_HOLIDAYS` and `DEMO_OUTAGES` through their data sources.
- **Writes:** `DEMO_SAMPLES.DUE_ON`, one row for each planned date, only where it is still empty.
- **Order:** every read and every date is worked out before a transaction opens. The transaction is `SaveDueDates`' own and covers the writes only.
- **A row that is not a plan:** a planned row that is not a sample id and a day is raised, not skipped. Leaving it out would save part of a plan.
- **On an error:** nothing is committed. Every write of the call is rolled back.
- **An answer that cannot be read:** if `SaveDueDates` answered success with something that is not its summary, the dates would already be committed and this script would still fail with `DUE_DATES_NOT_SAVED`. `SaveDueDates` as written cannot do that. `Combine` checks all the same, so that a later change to the answer fails loudly and does not report counts that are not there.
- **Dates:** the date columns are whole days, read without timezone conversion.
- **Values:** every value in SQL is bound. None is joined into the text.

## Test plan

One case for each way through the chart, in `tests/DueDatesTests/`. All of
them pass in the sandbox runner (`bun scripts/demo-sandbox.ts`).

- `SetSampleDueDatesTests`: the worked examples get their dates; a sample with no received date or no turnaround is skipped with its code; routine and rush get different rules; the result has the shape above.
- `SaveDueDatesTests`: planned dates are saved; a sample that already has a date, or is gone, comes back as `NOT_WAITING`; an empty plan saves nothing; something that is not a plan fails.
- `RollbackTests`: a failing row undoes the rows written before it, and the first row really was written before the second failed.
- `DueDateSummaryTests`: planning skips come before saving skips; nothing skipped; a save that failed; and each answer that is not an envelope or not a summary. No database.

Not tested: the one `:IF` of `ApplyDueDates` that raises the problem
`Combine` names. Nothing a test can do makes `SetSampleDueDates` plan a bad
row, so its own save never fails. The reading it depends on is tested in
`DueDateSummaryTests`.

## Units

```json
[
  {
    "name": "LoadHolidays",
    "script": "src/DueDates/SetSampleDueDates.ssl",
    "parameters": [],
    "nodes": [
      "n2"
    ],
    "calls": [
      "DueDates.Holidays"
    ],
    "lines": 4
  },
  {
    "name": "LoadOutages",
    "script": "src/DueDates/SetSampleDueDates.ssl",
    "parameters": [],
    "nodes": [
      "n3"
    ],
    "calls": [
      "DueDates.Outages"
    ],
    "lines": 4
  },
  {
    "name": "ApplyDueDates",
    "script": "src/DueDates/SetSampleDueDates.ssl",
    "parameters": [
      "aHolidays",
      "aOutages"
    ],
    "nodes": [
      "n4",
      "n5",
      "n10",
      "n11",
      "n12",
      "n25"
    ],
    "calls": [
      "PlanDueDate",
      "DueDates.SaveDueDates",
      "DueDates.DueDateSummary.Combine"
    ],
    "lines": 46
  },
  {
    "name": "PlanDueDate",
    "script": "src/DueDates/SetSampleDueDates.ssl",
    "parameters": [
      "aSample",
      "aHolidays",
      "aOutages"
    ],
    "nodes": [
      "n6",
      "n7",
      "n8",
      "n9"
    ],
    "calls": [
      "DueDates.DueRules.RuleFor",
      "SkipNoReceived",
      "SkipNoTurnaround",
      "SkipNotReached"
    ],
    "lines": 32
  },
  {
    "name": "Combine",
    "script": "src/DueDates/DueDateSummary.ssl",
    "parameters": [
      "aPlanSkips",
      "aSaved"
    ],
    "nodes": [
      "n24"
    ],
    "calls": [],
    "lines": 52
  },
  {
    "name": "WriteDueDates",
    "script": "src/DueDates/SaveDueDates.ssl",
    "parameters": [
      "aPlanned"
    ],
    "nodes": [
      "n13",
      "n14",
      "n16",
      "n17",
      "n19",
      "n20",
      "n21"
    ],
    "calls": [
      "IsPlannedRow",
      "SaveDueDate",
      "SkipNotWaiting"
    ],
    "lines": 44
  },
  {
    "name": "IsPlannedRow",
    "script": "src/DueDates/SaveDueDates.ssl",
    "parameters": [
      "vRow"
    ],
    "nodes": [
      "n15"
    ],
    "calls": [],
    "lines": 14
  },
  {
    "name": "SaveDueDate",
    "script": "src/DueDates/SaveDueDates.ssl",
    "parameters": [
      "sSampleId",
      "dDue"
    ],
    "nodes": [
      "n18"
    ],
    "calls": [],
    "lines": 12
  }
]
```

## What each node becomes

```json
[
  {
    "node": "n1",
    "becomes": "the first lines of SetSampleDueDates, which call its procedures inside one TRY"
  },
  {
    "node": "n22",
    "becomes": "the fixed failure that SaveDueDates returns from its CATCH, and SetSampleDueDates after it"
  },
  {
    "node": "n23",
    "becomes": "the last line of each script: the summary, inside the success envelope"
  }
]
```

<!-- plan d1003418 -->
