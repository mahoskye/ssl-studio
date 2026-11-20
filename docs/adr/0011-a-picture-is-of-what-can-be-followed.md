# ADR 0011: A picture is of what can be followed

**Status:** Accepted
**Date:** 2026-11-18
**Decided by:** the user asked for the graphs and the flow charts to be made
easier to follow (2026-11-18). These are the rules the work on them came to
follow, drafted from that work; the user has not reviewed them one by one.

Under [ADR 0007](0007-design-is-held-to-a-standard-that-serves-starlims-work.md)
and [ADR 0002](0002-text-is-the-source-of-truth.md).

## Context

- The call graph drew every call as its own line. A folder of tests that
  calls most of the code sent a line to each script across everything on the
  way, and the picture could not be followed.
- Scripts that all call one helper were laid in a single line, as long as
  there were scripts: the demo, unfolded, was 5080 by 7579.
- A flow chart's ways met a decision part of the way along its slanted
  edges, and a loop's way back crossed the way out.
- Zoomed out to see the whole of either, no word could be read.
- Better routing alone did not help: the same lines were still all there.

## Decision

- **What is drawn is chosen before it is laid out.** A picture nobody can
  follow is not made followable by drawing it better. Folding, gathering
  lines at a folder's edge, and setting scripts out as a block are choices
  of what to show, made by pure functions before the layout runs.
- **Nothing is lost by a choice.** A gathered line keeps every node it
  stands for and every place it is called from. Pointing shows them, the
  list has them all, and folding and gathering are each undone from the
  picture: by unfolding, or from its menu.
- **Where a picture can be drawn more than one way, each is laid out and
  the better is kept**: across or down for the graph, by what the view
  shows more of; for a chart, where a loop leaves and returns, by the
  fewest crossings and then the least line.
- **A decision is met at its points**: in at the top, on by the bottom,
  the other way out of a side, as on paper.
- **Far off, a picture names what can be named.** Below the zoom at which
  a word can be read, the small words are left out and scripts, folders and
  stages are named at a size that reads; a name that would lie over another
  waits for a closer look. A click there comes in on what was clicked.
- **Pointing answers at once.** In the graph, what the pointer is on is
  lit, the rest steps back, and it is said in words without waiting for a
  tooltip. In a chart, the ways in and out of the step pointed at stand
  out.

## Consequences

- The layout input is no longer the call graph itself. It includes lines
  that stand for several, and lines only the layout sees.
- A picture is laid out more than once: up to twice for a graph, up to four
  times for a chart. A graph of more than 250 nodes is laid out once.
- A gathered line ends at a folder's edge, not at the scripts it stands
  for. Which scripts those are is read by pointing, or in the list.
- Not covered: the order of scripts within a block, which follows their
  paths and not what calls what; and a block is not a choice the picture
  offers, it is how such scripts are always set out.
