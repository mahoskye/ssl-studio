# ADR 0013: The agent is told the work a question is for

**Status:** Accepted
**Date:** 2026-11-18
**Decided by:** the user asked for tickets and the tickets related to them to
drive the work (2026-11-18). What is sent, how much and when is drafted here
from that; the user has not reviewed it point by point.

Adds to [ADR 0012](0012-a-projects-work-is-written-down.md).
Under [ADR 0004](0004-opencode-through-its-service-api.md) and
[ADR 0005](0005-a-plan-is-a-document-of-its-own.md).

## Context

- The agent in the IDE has no file tools: what it needs arrives in the
  prompt. The tickets, the open questions and the decisions were in the
  project's folder, and the agent was told none of them.
- A plan said what to build and not which ticket asked for it. A spec the
  planner wrote was tied to a ticket only by the ticket listing its path.
- A model guesses where it is not told. An open question it does not know
  of is answered by a guess; a decision it does not know of is made again.

## Decision

- **A plan names its ticket.** `"ticket": "LIMS-123"` beside its title, set
  in the plan's details. A plan started while a ticket, or a document for
  one, is open is for that ticket. The ticket is not part of what makes a
  plan a different plan: setting it does not put a spec out of date.
- **A spec the planner writes is for its plan's ticket,** in the Docs
  panel and the catalog, without the ticket having to list it.
- **The planner is told the work** when it refines a plan or writes its
  spec: what the ticket asks, in its own words; the tickets related to it,
  a line each; the questions nobody has answered, with an instruction not
  to guess; the questions answered for the ticket, with the answer; the
  decisions that stand. Specs are left out: it is about to write one.
- **A chat is told the same, with the ticket's specs, once in a
  conversation,** when "include the ticket" is ticked. The tick is kept. The
  conversation says what was sent, in a few words.
- **The ticket at hand** is the open document's own, or the one it says it
  is for, or its plan's. With none, it is the one ticket that is under way;
  with two under way, or none, nothing is sent.
- **It is kept short.** A ticket's words and a spec's are cut at 3000
  characters each, an answer at 400, and at most twelve decisions go, those
  made for the ticket first. A local model's context is small.
- **A decision holds for the project,** whichever ticket it was made for.
  An open question counts when it is for the ticket, for a ticket related
  to it, or for no ticket.

## Consequences

- A first question costs more tokens than it did. The tick box, and the
  line in the conversation that says what went, are how that is seen and
  turned off.
- What is sent is read from the documents as they stand, an open one from
  the editor. Nothing is kept by the IDE between conversations.
- A plan for a ticket that is not in the folder is refined without it, and
  the plan's assistant says so.
- Not covered: the tidy steps, the build and the test script are not told
  the ticket. They work from the spec, which was written with it.
