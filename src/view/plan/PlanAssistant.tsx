// The agent's side of a plan, beside the chart: its questions, its suggestions,
// and the spec. Answers and accepted suggestions are text edits on the plan, so
// undo covers them too.
import { createResource, For, onMount, Show } from "solid-js";
import { agent, currentModel } from "../agent/store";
import { showPanel } from "../panels/registry";
import { documents, openFile, state } from "../state";
import { joinPath } from "../../shared/paths";
import { decisionsOf, describeSuggestion, openQuestions, planHash } from "./assist";
import type { Plan } from "./model";
import { unbuiltNodes } from "./build";
import { anyChanges, builtOf, chartChanges, planPaths } from "./built";
import { recheckPlan } from "./check";
import { driftFor, openProcedure } from "./drift";
import { writeTests } from "./testScript";
import { answerUnit, discardRun, loadRun, retryUnit, reviewBuild, scriptsToReview, startBuild, stopBuild } from "./buildRun";
import { acceptAll, acceptSuggestion, answer, assistOf, declineSuggestion, dismissWarning, refine, specPath, specState, writeSpec } from "./run";

export function PlanAssistant(props: { path: string; plan: Plan; text: string; onSelect: (node: string) => void }) {
	const a = () => assistOf(props.path);
	onMount(() => void loadRun(props.path));
	const run = () => a().run;
	const STATUS = { pending: "Waiting", running: "Building", passed: "Passed", stuck: "Stuck", skipped: "Waiting on a stuck unit", kept: "Untouched" } as const;
	/** A run of an earlier version of the chart: it cannot be reviewed against this one. */
	const stale = () => Boolean(run() && run()!.planHash !== planHash(props.plan));
	const built = () => builtOf(props.plan);
	const changes = () => chartChanges(props.plan, run());
	const uri = () => documents.get(props.path)?.model.uri.toString();
	const drift = () => driftFor(uri());
	const paths = () => planPaths(props.plan);
	const unitByName = (name: string) => built()?.units.find((u) => u.name === name);
	const open = () => openQuestions(props.plan);
	const closed = () => decisionsOf(props.plan).filter((d) => d.answer?.trim());
	const [spec] = createResource(
		() => [props.path, props.text, a().specVersion] as const,
		([path]) => specState(path),
	);
	const isLocal = () => {
		const model = agent.models.find((m) => `${m.providerID}/${m.id}` === currentModel());
		return model ? model.local : true;
	};
	const Node = (p: { id?: string }) => (
		<Show when={p.id && props.plan.nodes.some((n) => n.id === p.id)}>
			<button class="link plan-chip" title="Show this node" onClick={() => props.onSelect(p.id!)}>
				{props.plan.nodes.find((n) => n.id === p.id)?.text}
			</button>
		</Show>
	);
	return (
		<aside class="plan-assist" aria-label="Plan assistant">
			<div class="plan-assist-actions">
				<button class="primary" disabled={Boolean(a().running)} title="The agent looks for what the chart leaves undecided" onClick={() => void refine(props.path)}>
					Refine
				</button>
				<button disabled={Boolean(a().running)} title={open().length ? "Answer the open questions first" : "The agent writes the spec, for you to review"} onClick={() => void writeSpec(props.path)}>
					Write spec
				</button>
			</div>
			<p class="hint plan-assist-model">
				<button class="link" title="Choose the model in the Agent panel" onClick={() => showPanel("agent")}>
					{currentModel() || "The model is chosen in the Agent panel"}
				</button>
				<Show when={!isLocal()}> · this model may cost money</Show>
				<Show when={a().tokens}>
					{" "}
					· {a().tokens.toLocaleString()} tokens
					<Show when={a().cost}>, cost {a().cost.toFixed(2)}</Show>
				</Show>
			</p>
			<Show when={a().progress}>
				<p class="plan-assist-progress">{a().progress}</p>
			</Show>
			<For each={a().warnings}>
				{(w) => (
					<p class="plan-assist-warning">
						{w}{" "}
						<button class="link" onClick={() => dismissWarning(props.path, w)}>
							Dismiss
						</button>
					</p>
				)}
			</For>

			<Show when={open().length}>
				<h4>
					{open().length === 1 ? "A question for you" : `${open().length} questions for you`}
				</h4>
				<For each={open()}>
					{(q) => (
						<div class="plan-question">
							<p>
								{q.question} <Node id={q.node} />
							</p>
							<Show when={q.suggested?.length}>
								<div class="plan-answers">
									<For each={q.suggested}>{(s) => <button onClick={() => answer(props.path, q.question, s)}>{s}</button>}</For>
								</div>
							</Show>
							<input
								placeholder="Your answer"
								aria-label={q.question}
								onKeyDown={(e) => {
									if (e.key === "Enter" && e.currentTarget.value.trim()) answer(props.path, q.question, e.currentTarget.value);
								}}
								onChange={(e) => {
									if (e.currentTarget.value.trim()) answer(props.path, q.question, e.currentTarget.value);
								}}
							/>
						</div>
					)}
				</For>
			</Show>

			<Show when={a().suggestions.length}>
				<h4 class="plan-assist-head">
					<span>Suggestions</span>
					<button onClick={() => acceptAll(props.path)}>Accept all</button>
				</h4>
				<For each={a().suggestions}>
					{(s) => (
						<div class="plan-suggestion">
							<p>{describeSuggestion(s, props.plan, a().suggestions)}</p>
							<Show when={s.why}>
								<p class="hint">{s.why}</p>
							</Show>
							<div class="plan-answers">
								<button onClick={() => acceptSuggestion(props.path, s.key)}>Accept</button>
								<button onClick={() => declineSuggestion(props.path, s.key)}>Decline</button>
							</div>
						</div>
					)}
				</For>
			</Show>

			<Show when={closed().length}>
				<h4>What you decided</h4>
				<For each={closed()}>
					{(q) => (
						<div class="plan-question decided">
							<p class="hint">
								{q.question} <Node id={q.node} />
							</p>
							<input value={q.answer} aria-label={q.question} onChange={(e) => answer(props.path, q.question, e.currentTarget.value)} />
						</div>
					)}
				</For>
			</Show>

			<h4>Spec</h4>
			<Show when={spec() && spec() !== "none"} fallback={<p class="hint">Not written yet. Refine the plan, then write the spec.</p>}>
				<p class="hint">{spec() === "stale" ? "The plan has changed since this spec was approved: write it again." : "Approved, and up to date with the plan."}</p>
				<button class="link" onClick={() => void openFile(specPath(props.path))}>
					Open the spec
				</button>
			</Show>

			<Show when={anyChanges(changes())}>
				<h4>Since it was built</h4>
				<For each={[...changes().changed.map((id) => ({ id, what: "Changed" })), ...changes().added.map((id) => ({ id, what: "New" }))]}>
					{(c) => (
						<p class="plan-change">
							{c.what}: <Node id={c.id} />
						</p>
					)}
				</For>
				<Show when={changes().removed.length}>
					<p class="plan-change">Removed: {changes().removed.join(", ")}. Their code stays until you remove it.</p>
				</Show>
				<p class="hint">Write the spec again, then build. Only what these touch is rebuilt, and the rest of the code is not reprinted.</p>
			</Show>

			<h4 class="plan-assist-head">
				<span>Build</span>
				<Show when={a().running === "build"}>
					<button onClick={() => stopBuild(props.path)}>Stop</button>
				</Show>
			</h4>
			<Show when={spec() === "current" && (!run() || stale()) && (!built()?.units.length || anyChanges(changes()))}>
				<p class="hint">The agent builds from the spec without stopping. Nothing is written until you have reviewed it.</p>
			</Show>
			<Show when={spec() !== "current" && (!run() || stale())}>
				<p class="hint">Needs an approved spec, up to date with the plan.</p>
			</Show>
			<Show when={spec() === "current" && (!run() || stale()) && built()?.units.length && !anyChanges(changes())}>
				<p class="hint">Built, and the chart has not changed since.</p>
			</Show>
			<Show when={!a().running && spec() === "current" && (run() && !stale() ? run()!.status !== "built" || run()!.units.some((u) => u.status === "pending") : !built()?.units.length || anyChanges(changes()))}>
				<button class="primary" onClick={() => void startBuild(props.path)}>
					{run() && !stale() ? "Carry on building" : built()?.units.length ? "Rebuild what changed" : "Build"}
				</button>
			</Show>
			<Show when={stale()}>
				<p class="hint">The last build was of an earlier version of the chart, so it can no longer be reviewed.</p>
			</Show>
			<Show when={run() && !stale() ? run() : null}>
				{(r) => (
					<>
						<p class="hint">
							{r().units.filter((u) => u.status === "passed").length} of {r().units.filter((u) => u.status !== "kept").length} units passed
							<Show when={r().units.some((u) => u.status === "kept")}> · {r().units.filter((u) => u.status === "kept").length} untouched</Show> · {r().tokens.toLocaleString()} tokens
							<Show when={r().cost}>, cost {r().cost.toFixed(2)}</Show>
							<Show when={r().status === "budget"}> · stopped at its budget</Show>
							<Show when={r().status === "stopped" && !a().running}> · stopped</Show>
						</p>
						<For each={r().units.filter((u) => u.status !== "kept")}>
							{(unit) => (
								<div class={`plan-unit ${unit.status}`}>
									<p>
										<strong>{unit.name}</strong> <span class="hint">{STATUS[unit.status]}{unit.change ? ", an edit" : ""}{unit.attempts > 1 && unit.status !== "pending" ? `, try ${unit.attempts}` : ""}</span>
									</p>
									<Show when={unit.problems?.length}>
										<ul class="plan-problems">
											<For each={unit.problems}>{(p) => <li>{p}</li>}</For>
										</ul>
									</Show>
									<Show when={unit.status === "stuck" && unit.question && !unit.answer}>
										<input
											placeholder="Your answer"
											aria-label={unit.question}
											onKeyDown={(e) => {
												if (e.key === "Enter") answerUnit(props.path, unit.name, e.currentTarget.value);
											}}
										/>
									</Show>
									<Show when={unit.status === "stuck" && !a().running && !(unit.question && !unit.answer)}>
										<button onClick={() => retryUnit(props.path, unit.name)}>Try again</button>
									</Show>
								</div>
							)}
						</For>
						<Show when={!a().running && scriptsToReview(r(), props.plan).length}>
							<button class="primary" onClick={() => void reviewBuild(props.path)}>
								Review {scriptsToReview(r(), props.plan).length === 1 ? scriptsToReview(r(), props.plan)[0] : `${scriptsToReview(r(), props.plan).length} scripts`}
							</button>
						</Show>
						<Show when={!a().running && r().status === "built" && r().units.every((u) => u.status === "kept")}>
							<p class="hint">Nothing in the code needed to change.</p>
						</Show>
						<Show when={!a().running && r().status === "built" && !scriptsToReview(r(), props.plan).length && r().accepted.length}>
							<p class="hint">
								{unbuiltNodes(props.plan, r()).length ? `Accepted, but nothing is built yet for: ${unbuiltNodes(props.plan, r()).join(", ")}.` : "Accepted. This code has not been run: test it in STARLIMS."}
							</p>
						</Show>
						<Show when={!a().running}>
							<button class="link" onClick={() => discardRun(props.path)}>
								Discard this build
							</button>
						</Show>
					</>
				)}
			</Show>
			<Show when={built()?.units.length}>
				<h4 class="plan-assist-head">
					<span>Chart and code</span>
					<button title="Compare them again" onClick={() => recheckPlan(uri() ?? "")}>
						Check
					</button>
				</h4>
				<Show when={drift().items.length} fallback={<p class="hint">{drift().checked ? "They agree on procedures and calls. That says nothing about what the code does." : "Not compared yet: the language server is still reading the workspace."}</p>}>
					<For each={drift().items}>
						{(d) => (
							<p class="plan-drift" classList={{ warning: d.severity === "warning" }}>
								{d.message}{" "}
								<Show when={d.kind !== "gone" && unitByName(d.unit)}>
									<button class="link" onClick={() => void openProcedure(uri(), unitByName(d.unit)!)}>
										Open
									</button>
								</Show>
							</p>
						)}
					</For>
					<p class="hint">A report only. The code may well be right.</p>
				</Show>

				<h4>Tests</h4>
				<p class="hint">
					Each path through the chart is a case: {paths().paths.length}
					{paths().truncated ? " or more" : ""}. SSL Studio cannot run SSL, so you run them in STARLIMS.
				</p>
				<button disabled={Boolean(a().running)} title="The agent writes an SSL test script, for you to review" onClick={() => void writeTests(props.path)}>
					Write the test script
				</button>
				<Show when={built()?.tests}>
					{(tests) => (
						<p class="hint">
							<button class="link" onClick={() => void openFile(joinPath(state.workspace!.root, tests().script))}>
								{tests().script}
							</button>
							{tests().hash === planHash(props.plan) ? "" : " was written before the chart last changed."}
						</p>
					)}
				</Show>
			</Show>
			<p class="hint plan-assist-foot">Nothing here changes your code until you accept it at review.</p>
		</aside>
	);
}
