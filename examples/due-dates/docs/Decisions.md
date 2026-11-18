# Decisions

Newest first. A decision is replaced by a new entry, not rewritten.

## 4. Forms and code-behind are on hold (2026-11-17)

The project is server side only: scripts, classes, a data source and tests.
A front end (form design, client scripts, code-behind) is wanted eventually
and is on hold with no date. It starts when the user says so, not before.

## 3. Availability is the instrument's, and it stops the count (2026-11-17)

A day the sample's instrument is out does not count toward the turnaround,
the same as a weekend or a holiday. Outages are whole days, `FROM_ON` to
`TO_ON` inclusive. A sample with no instrument is never held up.

Not modelled: analysts' availability, part days, and how much work an
instrument can take in a day.

## 2. Rush samples count Saturdays (2026-11-17)

The lab runs a Saturday shift for rush work only. `RushDueRule` differs from
`DueRule` in that one answer; the walk through the days is the base's.
Sundays and holidays never count.

## 1. The utilities take arrays and run no SQL (2026-11-17)

`WorkCalendar` and `Availability` are given the holidays and outages. They
can be tested without a database, and `SetSampleDueDates` reads each table
once however many samples it sets.
