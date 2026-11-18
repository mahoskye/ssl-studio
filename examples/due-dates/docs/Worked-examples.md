# Worked examples

Due dates worked by hand, to check the scripts against. The rows are in
[demo.sql](../schema/demo.sql).

Three facts decide every example:

- 2026-11-16 is a Monday.
- Thursday 2026-11-26 is a holiday.
- The balance `BAL-01` is out on Wednesday 2026-11-18 and Thursday 2026-11-19.

| Sample | Due | What it shows |
| --- | --- | --- |
| `S-1001` | 2026-11-19 | Plain working days |
| `S-1002` | 2026-11-23 | An outage and a weekend push the date back |
| `S-1003` | 2026-11-23 | A routine sample skips Saturday |
| `S-1004` | 2026-11-21 | A rush sample counts Saturday |
| `S-1005` | 2026-11-27 | A holiday does not count |
| `S-1006` | 2026-11-30 | An outage after the due date changes nothing |
| `S-1007` | not set | No turnaround: the sample is skipped |

## S-1001: plain working days

Received Monday 2026-11-16. Routine, 3 days, no instrument.

- Counts: Tue 17, Wed 18, Thu 19.
- **Due 2026-11-19.**

## S-1002: an outage and a weekend

Received Monday 2026-11-16. Routine, 3 days, needs `BAL-01`.

- Counts: Tue 17, Fri 20, Mon 23.
- Does not count: Wed 18 and Thu 19 (`BAL-01` is out), Sat 21 and Sun 22.
- **Due 2026-11-23.** `S-1001` is the same sample without the instrument.

## S-1003: a routine sample skips Saturday

Received Thursday 2026-11-19. Routine, 2 days, no instrument.

- Counts: Fri 20, Mon 23.
- Does not count: Sat 21 and Sun 22.
- **Due 2026-11-23.**

## S-1004: a rush sample counts Saturday

Received Thursday 2026-11-19. Rush, 2 days, no instrument.

- Counts: Fri 20, Sat 21.
- **Due 2026-11-21.** `S-1003` is the same sample as routine.

## S-1005: a holiday

Received Tuesday 2026-11-24. Routine, 2 days, no instrument.

- Counts: Wed 25, Fri 27.
- Does not count: Thu 26 (holiday).
- **Due 2026-11-27.**

## S-1006: an outage that does not matter

Received Friday 2026-11-27. Routine, 1 day, needs `HPLC-02`.

- Counts: Mon 30.
- Does not count: Sat 28 and Sun 29.
- **Due 2026-11-30.** `HPLC-02` is out from 2026-12-01, after the sample is due.

## S-1007: nothing to work from

Received Monday 2026-11-16. Routine, no turnaround.

- **Not set.** `SetSampleDueDates` skips it and says so in its summary.
