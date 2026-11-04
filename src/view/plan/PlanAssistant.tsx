// The agent's side of a plan, beside the chart: its questions, its suggestions,
// and the spec. Answers and accepted suggestions are text edits on the plan, so
// undo covers them too.
import { createResource, For, onMount, Show } from "solid-js";
import { agent, currentModel } from "../agent/store";
import { showPanel } from "../panels/registry";
import { openFile } from "../state";
import { decisionsOf, describeSuggestion, openQuestions } from "./assist";
import type { Plan } from "./model";
import { unbuiltNodes } from "./build";
import { answerUnit, discardRun, loadRun, retryUnit, reviewBuild, scriptsToReview, startBuild, stopBuild } from "./buildRun";
import { acceptAll, acceptSuggestion, answer, assistOf, declineSuggestion, dismissWarning, refine, specPath, specState, writeSpec } from "./run";

export function PlanAssistant(props: { path: string; plan: Plan; text: string; onSelect: (node: string) => void }) {
	const a = () => assistOf(props.path);
	onMount(() => void loadRun(props.path));
	const run = () => a().run;
	const STATUS = { pending: "Waiting", running: "Building", passed: "Passed", stuck: "Stuck", skipped: "Waiting on a stuck unit" } as const;
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

			<h4 class="plan-assist-head">
				<span>Build</span>
				<Show when={a().running === "build"}>
					<button onClick={() => stopBuild(props.path)}>Stop</button>
				</Show>
			</h4>
			<Show when={spec() === "current" && !run()}>
				<p class="hint">The agent builds from the spec without stopping. Nothing is written until you have reviewed it.</p>
			</Show>
			<Show when={spec() !== "current" && !run()}>
				<p class="hint">Needs an approved spec, up to date with the plan.</p>
			</Show>
			<Show when={!a().running && spec() === "current" && (!run() || run()!.status !== "built" || run()!.units.some((u) => u.status === "pending"))}>
				<button class="primary" onClick={() => void startBuild(props.path)}>
					{run() ? "Carry on building" : "Build"}
				</button>
			</Show>
			<Show when={run()}>
				{(r) => (
					<>
						<p class="hint">
							{r().units.filter((u) => u.status === "passed").length} of {r().units.length} units passed · {r().tokens.toLocaleString()} tokens
							<Show when={r().cost}>, cost {r().cost.toFixed(2)}</Show>
							<Show when={r().status === "budget"}> · stopped at its budget</Show>
							<Show when={r().status === "stopped" && !a().running}> · stopped</Show>
						</p>
						<For each={r().units}>
							{(unit) => (
								<div class={`plan-unit ${unit.status}`}>
									<p>
										<strong>{unit.name}</strong> <span class="hint">{STATUS[unit.status]}{unit.attempts > 1 && unit.status !== "pending" ? `, try ${unit.attempts}` : ""}</span>
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
			<p class="hint plan-assist-foot">Nothing here changes your code until you accept it at review.</p>
		</aside>
	);
}
