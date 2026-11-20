---
ticket: DEMO-101
title: Give every waiting sample a due date
source: https://tickets.example.test/browse/DEMO-101
status: done
related: [DEMO-102, DEMO-103]
specs: [design/SetSampleDueDates.spec.md]
---

# DEMO-101: Give every waiting sample a due date

An invented ticket, for this demo.

## What is asked

Samples are logged with a received date, a priority and a turnaround in
days, and no due date. Someone works each due date out by hand from a wall
calendar. Set it for them: count the turnaround in working days from the day
after the sample was received, skip weekends and holidays, and do not land
on a day the sample's instrument is out of service.

## What done looks like

- [x] Every sample with a received date and a turnaround has a due date.
- [x] A sample that cannot be given one is left alone, and the reason is reported.
- [x] Running it twice changes nothing the second time.

## Notes

- Rush work is DEMO-102: it counts Saturday.
- The dates are checked against [the worked examples](../Worked-examples.md).
