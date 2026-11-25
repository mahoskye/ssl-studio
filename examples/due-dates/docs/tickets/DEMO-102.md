---
ticket: DEMO-102
title: Rush samples count Saturday as a working day
source: https://tickets.example.test/browse/DEMO-102
status: done
related: [DEMO-101]
plans: [design/SetSampleDueDates.plan.json]
---

# DEMO-102: Rush samples count Saturday as a working day

An invented ticket, for this demo.

## What is asked

The lab works Saturdays on rush samples only. A rush sample's turnaround
should count Saturday; a routine sample's should not. Sundays and holidays
count for neither.

## What done looks like

- [x] A rush sample received on a Friday with a turnaround of one day is due on
  the Saturday.
- [x] A routine sample received the same day is due on the Monday.

## Notes

- Built as a rule of its own that changes one answer of the routine rule.
