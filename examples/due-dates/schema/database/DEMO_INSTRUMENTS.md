---
source: schema/database/DEMO_INSTRUMENTS.sql
---

# DEMO_INSTRUMENTS

Instruments the lab schedules samples on. Referenced by [DEMO_OUTAGES](DEMO_OUTAGES.md) and [DEMO_SAMPLES](DEMO_SAMPLES.md).

| Column | Type | Null | What it holds |
| --- | --- | --- | --- |
| `INSTRUMENT_ID` | varchar(20) | no | The instrument's id. Primary key. |
| `NAME` | varchar(60) | no | Display name shown on schedules. |
| `LAB_AREA` | varchar(30) | yes | Lab section that owns the instrument. |

## Indexes

| Name | Unique | Columns |
| --- | --- | --- |
| `UQ_INST_NAME` | yes | `NAME` |
