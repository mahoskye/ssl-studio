# Decisions

What was decided and why, newest first. A decision is replaced by a new entry, not rewritten.

## 10. Planning and saving are two scripts (2026-11-18)

`SetSampleDueDates` reads and plans; `SaveDueDates` writes, in the one
transaction, all of the dates or none. Each can be called and tested alone:
a test hands `SaveDueDates` a sample that already has a date, or a plan whose
second row is not a plan, and sees the skip and the rollback. Before the
split, nothing could make either happen.

## 9. A constant is a procedure, not a variable (2026-11-18)

`DueDateConstants` holds procedures: `DoProc("MaxWalkDays")` gives 730.
It first held variables, which the language server accepted. Running the
tests showed they are undefined in a procedure another script calls by its
three-part name: only the procedure runs then, not the lines of the include
that set them. An include's procedures are always there.

## 8. One script is left rough on purpose (2026-11-18)

`src/Legacy/OldDueDateCheck.ssl` is the kind of script a project inherits:
SQL built from text, deep nesting, no doc block. It is there so that the
IDE's Problems, Health and tidy steps have something real to work on. Nothing
calls it, and it stays rough: tidying it in a commit would remove the point.

## 7. Raise-only helpers are private, and Problems says so (2026-11-18)

Every procedure that reports failure by raising is marked `/*@private;`:
four in `SetSampleDueDates`, two in `SaveDueDates`, three in
`DueSoonReport`. Only the script's own `:TRY` may call such a procedure; the
style guide requires the marker for that case and prefers no marker anywhere
else. `SaveDueDates.IsPlannedRow` raises nothing and has none.

The language server reports every marker as information, the required ones
included. Those nine rows in Problems are expected and cannot be cleared
from here (asked of the language server as mahoskye/starlims-lsp#371). The sandbox runner does
not enforce the marker, so the tests do not show it working.

## 6. The calendar is read through data sources (2026-11-18)

`Holidays` and `Outages` are data sources, and `DueRules.RuleFor` is its own
small script. Both scripts need them, and neither may call the other's
private procedures. This replaces part of decision 1: SQL is now in
`SetSampleDueDates`, `SaveDueDates` (decision 10) and the three data sources.

## 5. A walk looks at most 730 days ahead (2026-11-18)

An outage with no known end has to be recorded with a far-off end date,
because `TO_ON` cannot be empty. Counting day by day through it would take
millions of steps inside a transaction.

So every walk stops after 730 days (`MaxWalkDays`) and gives an empty
date. `SetSampleDueDates` skips such a sample with
`TURNAROUND_NOT_REACHED`. A walk given an empty date gives one back at once.

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
once however many samples it sets. Decision 6 says where the SQL is now.
