---
source: schema/database/demo.sql
---

# DEMO_SAMPLES

One row for each sample. `SetSampleDueDates` plans a due date where `DUE_ON` is empty, and `SaveDueDates` writes it.

| Column | Type | Null | What it holds |
| --- | --- | --- | --- |
| `SAMPLE_ID` | varchar(20) | no | The sample's id. Primary key. |
| `RECEIVED_ON` | date | yes | The day the lab received it. |
| `PRIORITY` | varchar(10) | no | `ROUTINE` or `RUSH`. |
| `TURNAROUND_DAYS` | int | yes | Days allowed, counted as the rules say. |
| `INSTRUMENT_ID` | varchar(20) | yes | The instrument the sample needs, if any. Matches `DEMO_OUTAGES.INSTRUMENT_ID`. |
| `DUE_ON` | date | yes | The due date. Empty until it is set. |

A sample with no `RECEIVED_ON` or no `TURNAROUND_DAYS` is skipped.
