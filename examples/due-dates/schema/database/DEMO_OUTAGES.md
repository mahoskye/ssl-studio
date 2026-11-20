# DEMO_OUTAGES

The days an instrument is not available: maintenance, calibration, a breakdown. A sample that needs the instrument does not count those days.

| Column | Type | Null | What it holds |
| --- | --- | --- | --- |
| `OUTAGE_ID` | int | no | Primary key. |
| `INSTRUMENT_ID` | varchar(20) | no | The instrument that is out. |
| `FROM_ON` | date | no | The first day it is out. |
| `TO_ON` | date | no | The last day it is out, inclusive. |
| `REASON` | varchar(60) | yes | Why. |

Outages are whole days. Two outages for one instrument may overlap.
