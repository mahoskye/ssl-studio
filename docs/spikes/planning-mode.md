# Spike: can a local model build from a plan?

**Date:** 2026-11-03. **Decides:** how far planning mode's agent stages can be
trusted ([PLANNING-MODE.md](../PLANNING-MODE.md), the step before P2).

**Method.** By hand, through the real adapter (`bun/agent.ts`), on the invented
sample `fixtures/workspace/design/Release.plan.json`: ask for a spec, build each
unit with the `ssl-new-procedure` skill, send the language server's findings back
up to twice, then ask a fresh session for a second opinion with `ssl-review`. Local
models only, cost 0. One small plan and one run per setup, so this shows what breaks,
not how often.

## The answer

**A local model is useful for refining a plan, and for a first draft of the code.
It is not ready to build unattended.** On the fair run, `qwen3:14b` got close to
clean code that follows the chart's shape, and still would not have worked:

| What it did | Would the checks catch it? |
| --- | --- |
| Followed the chart: validate, branch, update, return. Findings 4, then 1, then 1 | |
| Invented `DoProc("Name", {key: value})`. One error left after two retries | Yes: `unexpected_token` |
| Used `DoProc` for a procedure in another script | Only with the call graph: a one-part target must be in the same file |
| Called `UpdateSampleStatus`, which exists nowhere and was never built | Only with the call graph (see below) |
| Turned "Tell the lab" into a commented-out placeholder, with no finding | **No** |
| Lost the node's note, "Inside a transaction" | **No** |

The last three are the ones that matter. Lint-clean is far from correct, as the
design's risks section feared: this code reads well and does not release a sample
or tell anyone.

## What worked

- **The questions.** Both models, unprompted beyond the format, asked the same two
  things a chart cannot say: which table and column hold the status, and how the lab
  is told. That is the refine stage earning its place. The spike did not feed answers
  back, and the guesses that followed are exactly what those answers would replace.
- **The retries,** once prompts fit: 4 findings, then 1.
- **Speed and cost:** about 20 to 130 seconds a turn on an RTX 4080. Cost 0.

## What it found to fix

**1. Ollama cuts long prompts silently, and this affects tidy too.** The service runs
with its default context of 4096 tokens (`ollama ps` shows it; the model supports
40960). With a skill loaded, every prompt reported exactly 4096 input tokens: the
model never saw all of it, with no error. Before the fix 2 findings became 12 on
"retry"; after it, 4 became 1. A second instance with
`OLLAMA_CONTEXT_LENGTH=16384` showed the difference, without changing the service.

**2. A new opencode server fills its skill list in stages (fixed in the adapter).**
None, then the two built-ins, then all 19, within about 1.5 s. A step asking too soon
would have run with no skill and no warning. This is what the first two runs did.
`skills()` now waits for the list to settle, and `ask` refuses a step whose skill is
really missing.

**3. "No findings" can mean no code.** Replies came back with `sql` fences, or as raw
JSON. A check that only reads findings passes those. A missing block must count as a
failure.

**4. Replies are not as tidy as the format asks.** Nested fences broke the first
format, so a spec cannot be a fenced block. `gpt-oss` wrote good content with its
markers closed the wrong way (`<<<UNITS` twice), and lost it to a strict parser. Parse
leniently, ending a block at the next marker, and re-ask once if a block is missing.

**5. The second opinion was not reliable locally.** One review found the real gap (no
SQL ran) and also made up rules. Another insisted SSL comments close with `*/`, which
is wrong. A third read for 161,000 tokens, then asked for a file path. `ssl-review`
expects a file; the prompt should supply one, or the review should be plain.

**6. `gpt-oss` was erratic:** one dropped stream, and code in `sql` fences or raw JSON.
`qwen3:14b` was the steadier of the two on this sample.

## What this changes in the design

See [PLANNING-MODE.md](../PLANNING-MODE.md).

- A step **cannot be silently dropped**: the build's result must account for every
  node, and calls the chart promises or the code makes must resolve in `ssl/callGraph`.
  That catches the invented procedure and the wrong kind of call. A placeholder still
  needs a human.
- **Open questions block the spec.** The model guessed where it had asked.
- **Check the context.** Warn when a prompt was probably cut, and say how to fix it.
- A local build is labelled a **draft**. The review stays required, and says so.
- Not tested: a larger or paid model. That needs the user's say, and is the obvious
  next measurement.

## After P3: building through the app (2026-11-03)

The same plan and model, through the real build loop, with the plan's questions
already answered, and a 16,384-token context.

| Try | What changed | Result |
| --- | --- | --- |
| 1 | The `ssl-new-procedure` skill alone | No code. The model spent 126,000 tokens in a turn trying to write the file with `execute`, said it had, and had not. Two more turns returned no text. Stuck, correctly |
| 2 | Told to call no tool, shown the palette's templates as worked examples, tool calls limited | **Passed on the third try**, using real `RunSQL`, `LSearch` and `:TRY`/`:CATCH`. 124,000 tokens |

- Comparing four prompts over eight fresh runs: with the skill, 8 to 14 findings;
  without it, 18 to 24. **The skill earns its place**; the loop in the first try is
  intermittent, which is why it is limited rather than designed away.
- **The worked examples are what stopped the invented syntax:** `:BEGINTRANSACTION`,
  bare `UPDATE`, `:EXCEPT` and `:CALL` all went once it had been shown the real thing.

The code that passed still had faults no check saw:

- It looked the sample up by a `SAMPLEID` column it made up; the answer said `ORDNO`.
- It has no transaction: the node's note was dropped.
- "Log it" fetches the error and throws it away.
- It calls another script with `DoProc`, where the style guide says `ExecFunction`.
  The server resolves it and raises no finding. Worth asking `starlims-lsp` about.

The second opinion **caught the missing transaction**, which no check can, and then
offered a wrong fix and a wrong point about SQL injection. It stays advisory, and the
review says it may be wrong.

**So:** a local build gives a draft worth reading, on one small plan. It is not a working
script. Whether a stronger model closes that gap is still untested, and needs the user's
say.

## After P4: changing what is built (2026-11-04)

The same local model and 16,384-token context, through the app, on a build of three
procedures written for this trial. One step's notes changed: "also write a line to the log
saying the lab was told".

| Step | What happened |
| --- | --- |
| Spec | Asked two questions first, one about a step that had not changed. Then revised the spec. Its units listed `NotifyLab`, and `ReleaseSample`, which did not need to change |
| Rebuild | **Only `NotifyLab` went to the model:** SSL Studio kept `ReleaseSample` despite the spec, and `MarkReleased`. It passed on the first try, at 27,705 tokens with the second opinion |
| Review | The diff was that one procedure. The other two kept their hand formatting, and a comment written by hand stayed |
| Tests | A script in the skill's shape on the first try, with both paths named, its calls resolving and no findings |

The checks passed, and the code still has faults no check can see:

- It logged by inserting into a `LOG` table it made up, not by a log call.
- The test script's banner says "no database writes", and its first test releases a sample.
- It added a "Path 3" the chart does not have, a rollback test that needs a failure you would
  have to cause by hand.
- Its first test needs a sample "12345" to exist, and does not say so.

The trial also changed the design:

- **An answer no longer marks a node as changed.** Answering "leave it as it is" would have
  rewritten that procedure.
- **The second opinion gave nothing useful:** it called a `models` tool, and reported that its
  own model was missing. It is now told to call no tool, and a turn that keeps trying is
  stopped.
- **The survey** read a target script in a way that put its findings in Problems. It no longer
  does.

**So:** on one small change, the mechanism did what it should: the blast radius was one
procedure. The code inside it is still a draft to read, and the tests are a starting point. A
stronger model is still untested, and needs the user's say.
