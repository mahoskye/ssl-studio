# Planning mode

**Status:** Accepted (2026-11-03), [ADR 0005](adr/0005-a-plan-is-a-document-of-its-own.md).
P1, the chart, and P2, refine and spec, are built. P3 and P4, building and what
follows, are not. The [spike](spikes/planning-mode.md) found a local model good for
refining a plan and for a first draft, not yet for building unattended; this design
now reflects that.

**The idea, in the user's words:** "a planning mode where I can use a flow
chart to design a process or script and then have an agent take over and work
through all the details to build it."

## The shape of it

You draw what should happen. The agent turns that into a written spec, asks
what it cannot decide, then builds the code without stopping. Nothing touches
your files until you have reviewed the finished change set.

| Stage | Who works | What comes out | You decide |
| --- | --- | --- | --- |
| 1. Draw | You | `design/<name>.plan.json` | When it is ready |
| 2. Refine | Agent | Answers to its questions; chart suggestions | Each question and suggestion |
| 3. Spec | Agent | `design/<name>.spec.md` | Approve, or send it back |
| 4. Build | Agent, unattended | A pending change set; no file changes | Only what it cannot resolve |
| 5. Review | You, helped by a second agent | Accepted edits in the editor | Each file: accept, or reject with a reason |

Stages 2 to 5 reuse what the tidy steps already proved: SSL Studio supplies the
context, the agent replies in fenced blocks, the language server checks the
result, and `openReview` shows the diff. Accepting is an undoable edit, not a
save.

## Three rules it keeps

**The code stays the source of truth (ADR 0002).** A chart describes code that
may not exist yet, so it cannot be a view of the code as blocks and graph are.
It is its own document, and the chart is a view of *that* document's text: a
`.plan.json` opens with the same Text and Chart switch as Text and Blocks, each
chart edit is a text edit on the JSON (`minimalReplace`), and one undo history
covers both. Once built, the code wins: the chart never regenerates a file, and
differences are reported, not repaired.

**The IDE writes no SSL (ADR 0003).** The chart is in plain words: "Is the id
usable?", not `:IF Empty(sId)`. There is no template that prints SSL from a
node. The agent writes the code and the server judges it. This is also what
keeps the chart useful for a process that is not yet thought through to code.

**The agent has no file tools (ADR 0004).** Same deny rules as tidy: no shell,
no web, nothing outside the workspace, no `question` tool. What it needs arrives
in the prompt. Questions and requests for more context are ordinary reply
blocks, which suits a turn-based flow better than a form that holds a turn open.

## Stage 1: the chart

A plan is one file, kept with the project in `design/` beside the tidy notes:

```json
{
  "version": 1,
  "title": "Release a sample",
  "goal": "Release a sample once its results are approved, and tell the lab.",
  "targets": ["Sample/Release.ssl"],
  "groups": [{ "id": "g1", "name": "Validation" }],
  "nodes": [
    { "id": "n1", "kind": "start", "text": "A sample id arrives" },
    { "id": "n2", "kind": "decision", "text": "Is the id usable?", "group": "g1" },
    { "id": "n3", "kind": "call", "text": "Check the id", "ref": "IsUsableId", "group": "g1" },
    { "id": "n4", "kind": "step", "text": "Mark the sample released", "notes": "Inside a transaction." },
    { "id": "n5", "kind": "end", "text": "Return the new status" }
  ],
  "edges": [
    { "from": "n1", "to": "n3" },
    { "from": "n3", "to": "n2" },
    { "from": "n2", "to": "n4", "label": "yes" },
    { "from": "n2", "to": "n5", "label": "no" },
    { "from": "n4", "to": "n5" }
  ]
}
```

- **Node kinds:** `start`, `end`, `step`, `decision`, and `call` for something
  that already exists. A `call` node is dragged from the Objects panel or picked
  from workspace symbols, so its `ref` comes from the server. A loop is an edge
  back to an earlier node.
- **Groups become regions.** A group in the chart is a comment region in the
  code, with the same colour in the chart, blocks and graph.
- **No positions are stored.** ELK lays the chart out, as in graph mode. Diffs
  stay small, and there is nothing to tidy by hand. Keyboard first: Enter adds
  the next step, Tab adds a branch, double-click edits the words.
- **A check with no agent and no cost:** unreachable nodes, dead ends, a decision
  with one way out, unlabelled branches, a `ref` the server cannot resolve. These
  show in Problems like any other finding.

This stage is useful alone, for thinking a process through or showing it to
someone. It needs no model.

## Stage 2: refine

**Survey first.** The style guide's planner has a gate, "survey before you
build", because agents rebuild what already exists. SSL Studio does the survey
itself, since the agent cannot: workspace symbols and text search for the
chart's nouns, callers and callees from `ssl/callGraph`, and the target files'
outlines. The result goes in the prompt, and into the spec as its prior art.

**The agent replies with blocks,** which SSL Studio turns into UI. They use marker
lines, not fences, since a spec holds fences of its own. Parsing is lenient (a block
ends at the next marker), and a missing block is asked for again once:

- ```` ```questions ````: JSON, each with an optional node id and suggested
  answers. They appear as a short form beside the chart. Answers are kept in the
  plan's `decisions` list, so no later prompt asks again. **Open questions block
  the spec:** in the spike, models asked the right question, then guessed.
- ```` ```chart ````: added or changed nodes and edges. They appear on the chart
  highlighted, to accept or decline one by one.
- ```` ```context ````: files, procedures or built-in elements it wants to read.
  SSL Studio answers from the workspace and the server's hover, and asks again,
  up to three rounds. This is how an agent with no file tools can still look.

## Stage 3: spec

The spec follows the feature spec the `ssl-planner` agent already writes, so
both produce one kind of document: prior art, what each node becomes (script,
region, procedure, signature), data and transactions, error paths, a test plan,
and a verification log of each built-in it names. It is markdown, reviewed with
`openReview`, and it is the build's only memory: each build prompt carries the
spec, not the conversation.

Size is settled here, not discovered later. If the plan cannot fit decision
0006's limits (50 KB, 400 code lines) the spec must split it into small scripts,
and SSL Studio refuses to approve one that does not.

## Stage 4: build

This is "take over and work through all the details". SSL Studio runs a loop,
one **unit** at a time (a procedure, data source or class from the spec), each
in a fresh session so prompts stay small:

1. **Prompt:** the spec, the unit's section, the target file's outline, and the
   signatures of what it calls. Skills: `ssl-new-procedure`, `ssl-new-datasource`
   or `ssl-new-class`. The reply is that unit only, never a reprinted file.
2. **Check, with the language server:** a reply with no code fails outright, so "no
   findings" cannot mean "nothing written". Then: no new findings
   (`session.analyze`), the name and parameters match the spec, the size limits
   hold, the calls the chart's edges promise are there, and **every call the code
   makes resolves**. `ssl/callGraph` reads an open document from its buffer, so it
   sees the pending text with nothing saved (tested against 0.30.0).
3. **On a failed check,** send the findings back, twice at most. Then stop that
   unit and mark it on the chart, and carry on with units that do not depend on
   it.

Each unit lights up on the chart as it finishes: running, passed, stuck.

**Every node is accounted for.** The spec maps each node to a unit or a statement. A
node with nothing to show keeps the run from reporting success. The spike's model
replaced a whole step with a comment and had no findings at all.

**Nothing is written during a build.** Results collect in a pending change set,
`.ssl-studio/plans/<name>.run.json`, with each unit's status and text. Closing
the app loses nothing, including paid work; a run resumes at the next unit. The
event stream has no replay, so a turn in flight when the stream drops is simply
retried.

**The agent stops and asks only** for a question it cannot answer from the spec,
a unit that stays stuck, or the budget.

**Cost is visible and capped.** The run uses the Agent panel's model, local by
default; a paid provider is the user's explicit choice, as today. A local build is
labelled a draft. Before a build SSL Studio shows the unit count and that model, and
warns if prompts look cut off (Ollama's default context silently drops what does not
fit; see [INSTALL](INSTALL.md)). During it, tokens and cost per
unit (`ask` already returns them). A budget stops the run between units.

## Stage 5: review

- **A second opinion first, advisory.** A fresh session, with no sight of the
  builder's reasoning, reads the code against the chart and spec. The report sits
  above the diff, findings tied to nodes. Agent output is judged, not assumed. Locally
  this found real gaps and also made up rules, so it informs you and decides nothing.
- **One review per file,** using `openReview`, with the checks above. A new file
  shows as a diff against nothing. Reject takes a reason and rebuilds only that
  file's units.
- **Accepting applies undoable edits,** then a range format. You save, as with
  tidy. New files are created on accept.
- **Tests you run.** The sandbox is private and nothing runs SSL here. The chart
  supplies the cases, though: every path through its decisions is one. With
  `ssl-unit-test` the agent writes them as an SSL test script for you to run in
  STARLIMS, and the review says plainly that the code has not been executed.

## After the build

- **Links:** accepted nodes record their script and procedure in the plan. Click
  a node to open its code. A badge marks a node whose procedure has gone.
- **Drift:** the chart compares its edges with `ssl/callGraph` and reports the
  difference: "the chart says Release calls IsUsableId; the code no longer does".
  A report only. The code may well be right.
- **Changing the chart:** only changed nodes rebuild, as edits to existing
  procedures, through the same checks and review. Untouched code is never
  reprinted.
- **Later, not now:** drawing a chart from existing code. Blocks and graph already
  show what exists, and a chart inferred from code would look more certain than it
  is.

## Where it lives in the code

| Part | Where | New or reused |
| --- | --- | --- |
| Plan file: parse, validate, the no-agent check | `src/view/plan/model.ts` | New; pure, like `graph/model.ts` |
| Chart view and editing | `src/view/plan/PlanView.tsx` | New; ELK and pan and zoom as in `GraphView` |
| Reply blocks | `fenced()` from `agent/tidy.ts` | Moved to a shared module |
| Survey | `agent/tidy.ts` `callers()`, `graph/load.ts` | Reused |
| Stages 2 to 5 | `src/view/plan/run.ts` | New; follows `agent/tidy.ts` |
| Checks | `session.analyze`, `shared/houseStyle`; `procedureShape` from `agent/tidy.ts` | Reused; `procedureShape` moved to the shared module |
| Review | `editor/Review.tsx` | Reused; multi-file walk added |
| Agent | `bun/agent.ts` `ask` | Unchanged |
| Run state | `backend.read`, `backend.write` | Reused |

No new dependency, and no change to the opencode adapter.

## Build order

Each step is usable before the next starts.

1. **P1, the chart. Done (2026-11-03).** File format, Chart and Text views,
   keyboard editing, the no-agent check, drag from Objects. No model. New plan is
   in the command palette. Keys: Enter adds the next step, Tab a branch, F2 edits
   the words, D switches step and decision, C connects, Delete removes, arrows
   move, Ctrl+Z undoes.
2. **Spike, before P2. Done (2026-11-03),** [results](spikes/planning-mode.md). A
   local model is useful for refining and for a draft, not for building unattended.
   A larger or paid model is untested, and only runs if you ask.
3. **P2, refine and spec. Done (2026-11-03).** Survey, reply blocks, the question
   form, chart suggestions, spec review. Code is not touched. Tried on the local model
   through the app: its questions were good and its spec usable, and it also proposed
   an approval step nobody asked for, and named an API that does not exist. No check
   caught those: that is what accepting one by one, and reviewing the spec, are for.
4. **P3, build and review.** The unit loop, checks and retries, pending change
   set, resume, budget, second opinion, file-by-file review.
5. **P4, after the build.** Links, drift, rebuilding changed nodes, the test
   script.

## Risks

- **The local model is not up to an unattended build.** The spike confirmed it: code
  with the right shape, an invented procedure, and a step reduced to a comment. So
  plan on a better spec and review locally, with local builds labelled drafts, and
  building for real on a model you choose.
- **Lint-clean is not correct.** The checks catch what the server can see, not
  wrong logic. Nothing here runs SSL. That is why review is not optional, the
  second opinion is a separate session, and the review says the code was not run.
- **Skills may be missing.** The private server loads user-level skills, and the
  Windows machine may not have them. `ask` refuses a step whose named skill is
  missing. There is also no planning skill yet, because opencode cannot see the
  `ssl-planner` agent. P2 uses `ssl-plan` when it is installed; until the style guide
  has one, it says so and works from a basic prompt.
- **Your code goes to the chosen model.** As with tidy. The corpus and other
  restricted material stay out by the existing boundaries, and the model in use
  is shown before any build.

## Decisions

The user accepted these on 2026-11-03.

1. **Where plans live:** in `design/`, kept with the project and reviewed like
   code.
2. **How much the agent does unattended:** the whole build, then one review of
   the change set.
3. **Layout:** automatic only at first. Dragging can be added later without
   breaking files.
4. **Planning instructions:** ask the style guide for an `ssl-plan` skill. Proposed
   as its own task on that repository (2026-11-03).
