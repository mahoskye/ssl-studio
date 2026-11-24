---
source: schema/database/DEMO_SAMPLES.sql
---

# DEMO_SAMPLES

One row for each sample. `SetSampleDueDates` plans a due date where `DUE_ON` is empty, and `SaveDueDates` writes it.

| Column | Type | Null | What it holds |
| --- | --- | --- | --- |
| `SAMPLE_ID` | varchar(20) | no | The sample's id. Primary key. |
| `RECEIVED_ON` | date | yes | The day the lab received it. |
| `PRIORITY` | varchar(10) | no | `ROUTINE` or `RUSH`. |
| `TURNAROUND_DAYS` | int | yes | Days allowed, counted as the rules say. |
| `INSTRUMENT_ID` | varchar(20) | yes | The instrument needed, if any. Foreign key to [DEMO_INSTRUMENTS](DEMO_INSTRUMENTS.md). |
| `DUE_ON` | date | yes | The due date. Empty until it is set. |

## Foreign keys

| Column | Target table | Target column | Notes |
| --- | --- | --- | --- |
| `INSTRUMENT_ID` | `DEMO_INSTRUMENTS` | `INSTRUMENT_ID` | Optional; empty when no instrument is needed. |

## Indexes

| Name | Unique | Columns |
| --- | --- | --- |
| `IX_SAMPLES_DUE` | no | `DUE_ON`, `PRIORITY` |
| `IX_SAMPLES_INST` | no | `INSTRUMENT_ID` |

A sample with no `RECEIVED_ON` or no `TURNAROUND_DAYS` is skipped.
