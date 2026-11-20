# Schema

What the project's data looks like, each kind in its own folder: the database's tables, the messages exchanged with other systems and what was agreed with them, and the files read or written. Another folder made here is a kind of the project's own.

The list between the two markers is written by SSL Studio from the files here (Docs panel, Update catalogs). Write anything else you like around it.

<!-- catalog -->

### Database

- [DEMO_HOLIDAYS](database/DEMO_HOLIDAYS.md): The days the lab is closed, other than weekends.
- [DEMO_OUTAGES](database/DEMO_OUTAGES.md): The days an instrument is not available: maintenance, calibration, a breakdown.
- [DEMO_SAMPLES](database/DEMO_SAMPLES.md): One row for each sample.
- [demo.sql](database/demo.sql)

### Interfaces: Maintenance

- [outage-notice.json](interfaces/Maintenance/outage-notice.json)
- [Outage notice](interfaces/Maintenance/Outage-notice.md): draft. The maintenance system is to send one when an instrument is booked out, and again if the booking changes.

### Files

- [Holiday calendar](files/Holiday-calendar.md): A CSV file with the year's holidays, sent by the site once a year.
- [holidays-2026.csv](files/holidays-2026.csv)

<!-- /catalog -->

`SetSampleDueDates` reads all three tables and hands what it plans to `SaveDueDates`; `SamplesDueSoon` reads `DEMO_SAMPLES` only. [demo.sql](database/demo.sql) creates the three tables and the rows the worked examples use.

Nothing in `src/` reads a message or a file yet: the one of each here is described so that the script that will can be written against it.
