---
title: A walk looks at most 730 days ahead
status: accepted
date: 2026-11-18
ticket: DEMO-101
---

# A walk looks at most 730 days ahead

Decision 5 in [Decisions](../../Decisions.md), kept here as a file of its own.

## Context

An outage with no known end is recorded with a far-off end date, because the
end date cannot be empty. Counting day by day through it would take millions
of steps inside a transaction.

## Decision

Every walk through the days stops after 730 days and gives an empty date. A
sample whose turnaround cannot be reached in that time is skipped, with the
reason that its turnaround is beyond the day limit.

## Consequences

- A sample behind an open-ended outage gets no due date until the outage is
  given a real end.
- The limit is one place to change.
