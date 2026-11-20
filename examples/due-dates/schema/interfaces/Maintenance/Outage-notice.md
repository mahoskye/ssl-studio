---
with: Maintenance
direction: in
version: 1
status: draft
---
# Outage notice

The maintenance system is to send one when an instrument is booked out, and again if the booking changes. Each notice is to become a row of [DEMO_OUTAGES](../../database/DEMO_OUTAGES.md). A sample is in [outage-notice.json](outage-notice.json).

Nothing is agreed yet: this page is the proposal. When it is, the agreed specification is to lie beside it, and the maintenance team answers for it on their side.

| Field | Type | Needed | What it holds |
| --- | --- | --- | --- |
| `instrumentId` | text, up to 20 | yes | The instrument that is out. Goes to `INSTRUMENT_ID`. |
| `from` | date, `yyyy-mm-dd` | yes | The first day it is out. Goes to `FROM_ON`. |
| `to` | date, `yyyy-mm-dd` | yes | The last day it is out, inclusive. Goes to `TO_ON`. |
| `reason` | text, up to 60 | no | Why. Goes to `REASON`. |

No script reads this message yet: it is described so that one can be written against it. That script is to refuse a notice whose `to` is before its `from`. Outages are whole days: a time of day in either date is not to be read.
