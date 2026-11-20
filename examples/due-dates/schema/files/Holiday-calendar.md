# Holiday calendar

A CSV file with the year's holidays, sent by the site once a year. Each line is to become a row of [DEMO_HOLIDAYS](../database/DEMO_HOLIDAYS.md). A sample is in [holidays-2026.csv](holidays-2026.csv).

| Column | Type | Example | What it holds |
| --- | --- | --- | --- |
| `date` | date, `yyyy-mm-dd` | `2026-12-25` | The day the lab is closed. Goes to `HOLIDAY_ON`. |
| `name` | text, up to 60 | `Christmas Day` | What the holiday is. Goes to `NAME`. |

No script reads this file yet: it is described so that the loader can be written against it. The first line names the columns. The file is UTF-8, with a comma between the columns. The loader is to leave a day that is in the table already as it is.
