---
title: Planning and saving are two scripts
status: accepted
date: 2026-11-18
ticket: DEMO-101
---

# Planning and saving are two scripts

Decision 10 in [Decisions](../../Decisions.md), kept here as a file of its own.

## Context

With reading, planning and writing in one script, no test could make a save
fail half way, or hand it a sample that already had a date.

## Decision

One script reads and plans. Another writes, in one transaction: all of the
dates or none.

## Consequences

- Each can be called and tested alone.
- A caller that wants only the plan can have it without writing anything.
