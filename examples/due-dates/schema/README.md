# Schema

The tables this project reads and writes: one Markdown file for each table, with its columns, types and keys, and a line on what it is for. `.sql` files are listed too.

| Table | Written by | What it is for |
| --- | --- | --- |
| [DEMO_SAMPLES](DEMO_SAMPLES.md) | `SaveDueDates` | The samples and their due dates |
| [DEMO_HOLIDAYS](DEMO_HOLIDAYS.md) | nothing here | Days the lab is closed |
| [DEMO_OUTAGES](DEMO_OUTAGES.md) | nothing here | Days an instrument is not available |

`SetSampleDueDates` reads all three and hands what it plans to `SaveDueDates`.
`SamplesDueSoon` reads `DEMO_SAMPLES` only.

[demo.sql](demo.sql) creates the three tables and the rows the worked examples use.
