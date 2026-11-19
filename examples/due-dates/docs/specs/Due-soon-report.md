---
title: The report of samples due soon
ticket: DEMO-103
status: in progress
---

# The report of samples due soon

What the morning list of samples shows, and what it leaves out.

## What it does

- Reads the samples due from a day through a number of days after it.
- Gives each one a status: due today, due the next working day, or due soon.
- Lists them soonest first, then by sample.

## What it does not do

- It does not change a due date.
- It does not yet mark a sample whose due date has passed.

## How it is checked

- The window is tested at both ends, with no samples, and with a window of
  no days.
- The statuses are tested across a weekend and a holiday.
