// The agent's side of a plan, beside the chart: workflow pipeline, build triggers,
// five-state code status breakdown, open questions/suggestions, flowchart test
// walkthroughs, and spec status. Answers and accepted suggestions are undoable
// text edits on the plan (ADR 0002).
import { createEffect, createMemo, createSignal, createUniqueId, For, onCleanup, onSettled, Show, untrack } from "solid-js";
import { createDraft } from "../draft";
import { createAsyncQuery } from "../asyncQuery";
import { Icon } from "../Icon";
import { agent, currentModel, resume } from "../agent/store";
import { choose } from "../dialogs";
import { showPanel } from "../panels/registry";
import { promoteToKnowledge } from "../projectDocs";
import { documents, openFile, state } from "../state";
import { baseName, joinPath } from "../../shared/paths";
import { buildDriftAgentDraft, buildPlanAgentDraft, buildTestsAgentDraft, decisionsOf, describeSuggestion, planHashMatches, planTargetsOf, testsHashMatches, type Decision } from "./assist";
import { planTestsOf, type Plan, type PlanNode, type PlanTestInput, type PlanTestPatch } from "./model";
import { modelCostNote, scriptOf, unbuiltNodes } from "./build";
import { anyChanges, builtOf, chartChanges, journeyDraft, pathSummary, planPaths, type BuiltUnit, type Drift, type PlanPath } from "./built";
import { CODE_INDICATOR_WORDS, type CodeIndicator } from "./chart";
import { recheckPlan } from "./check";
import { driftFor, openProcedure, openScript } from "./drift";
import type { ScheduledBuildScope } from "./planBridge";
import { TestCaseList, type TestCaseDraft } from "./PlanTests";
import { writeTests } from "./testScript";
import { answerUnit, discardRun, loadRun, retryUnit, reviewBuild, scriptsToReview, startBuild, stopBuild } from "./buildRun";
import { acceptAll, acceptSuggestion, answer, assistOf, declineSuggestion, dismissWarning, refine, specPath, specState, stopAssist, writeSpec } from "./run";

const CODE_ORDER: readonly CodeIndicator[] = ["green", "yellow", "red", "blue", "grey"];

/** Filters malformed or non-string entries out of `plan.decisions` so hand-edited JSON cannot crash the Assistant UI. */
export function safeDecisionsOf(plan: Plan): Decision[] {
	const raw = decisionsOf(plan) as unknown[];
	const out: Decision[] = [];
	for (const d of raw) {
		if (!d || typeof d !== "object" || Array.isArray(d)) continue;
		const rec = d as Record<string, unknown>;
		if (typeof rec.question !== "string" || !rec.question.trim()) continue;
		const answer = typeof rec.answer === "string" ? rec.answer : undefined;
		const node = typeof rec.node === "string" ? rec.node : undefined;
		const suggested = Array.isArray(rec.suggested)
			? rec.suggested.filter((s): s is string => typeof s === "string" && s.trim().length > 0)
			: undefined;
		out.push({
			question: rec.question,
			...(node ? { node } : {}),
			...(answer !== undefined ? { answer } : {}),
			...(suggested?.length ? { suggested } : {}),
		});
	}
	return out;
}

export type DriftOpenAction =
	| { kind: "unit"; unit: BuiltUnit }
	| { kind: "script"; script: string }
	| { kind: "node"; nodeId: string };

/** Resolves what clicking Open / Show step on a drift item should navigate to (handles both built-unit and manual-plan drift items). */
export function resolveDriftOpenAction(
	d: Drift,
	builtUnits: readonly BuiltUnit[],
	targets: readonly string[],
	nodeIds: ReadonlySet<string>,
): DriftOpenAction | null {
	if (d.kind !== "gone") {
		const unit = builtUnits.find((u) => u.name === d.unit);
		if (unit) return { kind: "unit", unit };
		const matchedTarget = targets.find((t) => t.toLowerCase() === d.unit.toLowerCase());
		if (matchedTarget) return { kind: "script", script: matchedTarget };
		if (/\.(ssl|srvscr|ds)$/i.test(d.unit)) return { kind: "script", script: d.unit };
	}
	if (d.node && nodeIds.has(d.node)) return { kind: "node", nodeId: d.node };
	if (d.kind !== "gone" && targets.length > 0) return { kind: "script", script: targets[0]! };
	return null;
}

/** Local draft input for decided answers so unrelated plan edits never overwrite in-progress typing, while unchanged commits snap back after flush. */
function DraftAnswerInput(props: { value: string; ariaLabel: string; onCommit: (value: string) => void }) {
	const [draft, setDraft] = createDraft(() => props.value);
	return (
		<input
			value={draft()}
			aria-label={props.ariaLabel}
			onInput={(e) => setDraft(e.currentTarget.value)}
			onChange={(e) => {
				const el = e.currentTarget;
				props.onCommit(el.value);
				onSettled(() => {
					if (!el.isConnected) return;
					const cur = untrack(() => props.value);
					setDraft(cur);
					if (el.value !== cur) el.value = cur;
				});
			}}
		/>
	);
}

/** Mounted while its plan shows, and hidden when collapsed: a build under way is not lost from sight for good. */
export function PlanAssistant(props: {
	path: string;
	plan: Plan;
	text: string;
	onSelect: (node: string) => void;
	/** A path to light on the chart, as its nodes in order; null for none. */
	onPath?: (nodes: string[] | null) => void;
	/** Shared chart path walkthrough state when hosted beside PlanView. */
	allPaths?: { paths: PlanPath[]; truncated: boolean };
	activePathIndex?: number | null;
	onSetActivePathIndex?: (index: number | null) => void;
	onStepActivePath?: (by: 1 | -1) => void;
	/** Five-state stoplight + grey + blue code counts from PlanView. */
	codeCounts?: Record<CodeIndicator, number>;
	nodesByCodeState?: (kind: CodeIndicator) => PlanNode[];
	/** Optional legacy callbacks kept optional for callers. */
	scheduledNotice?: string | null;
	onClearScheduledNotice?: () => void;
	onTriggerScheduled?: (scope: ScheduledBuildScope) => void;
	onAddTestCase?: (input: PlanTestInput) => void;
	onUpdateTestCase?: (id: string, patch: PlanTestPatch) => void;
	onRemoveTestCase?: (id: string) => void;
	id?: string;
	hidden?: boolean;
	inPalette?: boolean;
}) {
	const a = () => assistOf(props.path);
	const [localPath, setLocalPath] = createSignal<number | null>(null);
	const [buildOpen, setBuildOpen] = createSignal(true);
	const [inputOpen, setInputOpen] = createSignal(false);
	const [decidedOpen, setDecidedOpen] = createSignal(false);
	const [testsOpen, setTestsOpen] = createSignal(true);
	const [specOpen, setSpecOpen] = createSignal(false);
	const [pickedCodeState, setPickedCodeState] = createSignal<CodeIndicator | null>(null);
	const [draftReq, setDraftReq] = createSignal<{ draft: TestCaseDraft; seq: number } | null>(null);
	let draftSeq = 0;
	const customTests = createMemo(() => planTestsOf(props.plan));

	const run = () => a().run;
	const STATUS = { pending: "Waiting", running: "Building", passed: "Passed", stuck: "Stuck", skipped: "Waiting on a stuck unit", kept: "Untouched" } as const;
	/** A run of an earlier version of the chart: it cannot be reviewed against this one. */
	const stale = () => Boolean(run() && !planHashMatches(run()!.planHash, props.plan));
	const built = () => builtOf(props.plan);
	const changes = () => chartChanges(props.plan, run());
	const uri = () => documents.get(props.path)?.model.uri.toString();
	const drift = () => driftFor(uri());
	const paths = createMemo(() => props.allPaths ?? planPaths(props.plan));
	const nodeIdSet = createMemo(() => new Set(props.plan.nodes.map((n) => n.id)));
	const planTargets = createMemo(() => planTargetsOf(props.plan));
	const allDecisions = createMemo(() => safeDecisionsOf(props.plan));
	const open = () => allDecisions().filter((d) => !d.answer?.trim());
	const closed = () => allDecisions().filter((d) => Boolean(d.answer?.trim()));
	const inputCount = () => open().length + a().suggestions.length;

	// Load any saved build run and clear pending journey test drafts when mounting or switching plans.
	const planPath = createMemo(() => props.path);
	createEffect(
		() => planPath(),
		(p) => {
			setDraftReq(null);
			untrack(() => {
				void loadRun(p);
			});
		},
	);
	createEffect(
		() => testsOpen(),
		(isOpen) => {
			if (!isOpen) setDraftReq(null);
		},
	);

	// Auto-open "Needs your input" whenever questions or suggestions arrive.
	const inputTotal = createMemo(() => inputCount());
	createEffect(
		() => inputTotal(),
		(count) => {
			if (count > 0) setInputOpen(true);
		},
	);

	const [spec] = createAsyncQuery(
		() => [props.path, props.text, a().specVersion] as const,
		([path]) => specState(path),
	);

	const DISCARD = "Discard the build";
	/** A build is paid for in tokens, and discarding it cannot be undone: ask first, say what goes, and let Enter mean Cancel (ADR 0009). */
	const discard = async () => {
		const r = run();
		if (!r) return;
		const done = r.units.filter((u) => u.status === "passed" && !r.accepted.includes(scriptOf(u, props.plan))).length;
		const spent = `${r.tokens.toLocaleString()} tokens${r.cost ? `, cost ${r.cost.toFixed(2)}` : ""}`;
		const what = done ? `${done} built ${done === 1 ? "unit" : "units"} not yet accepted (${spent})` : `its progress (${spent})`;
		if ((await choose(`Discard this build? It throws away ${what}, and that cannot be brought back. Code already accepted stays.`, [DISCARD], { danger: DISCARD })) === DISCARD) discardRun(props.path);
	};

	const specHint = createUniqueId();
	// What is known of the chosen model's cost: said even before opencode has listed its models (`modelCostNote`).
	const costNote = () => modelCostNote(agent.models, currentModel(), state.settings.agentOwnModels);
	// The list is read here when opencode is already running (a reloaded page, a second window), so the note is of
	// what is so. It is not started for this: the build starts it before it asks about the cost.
	onSettled(() => void resume());

	const Node = (p: { id?: string }) => (
		<Show when={p.id && props.plan.nodes.some((n) => n.id === p.id)}>
			<button type="button" class="link plan-chip" title="Show this step on the chart" onClick={() => props.onSelect(p.id!)}>
				{props.plan.nodes.find((n) => n.id === p.id)?.text}
			</button>
		</Show>
	);

	const shownPath = () => (props.activePathIndex !== undefined ? props.activePathIndex : localPath());
	const setShownPath = (next: number | null) => {
		if (props.onSetActivePathIndex) props.onSetActivePathIndex(next);
		else setLocalPath(next);
	};
	const stepPath = (by: 1 | -1) => {
		if (props.onStepActivePath) return props.onStepActivePath(by);
		const count = paths().paths.length;
		if (!count) return;
		setLocalPath((at) => (at === null ? (by > 0 ? 0 : count - 1) : (at + by + count) % count));
	};

	// Keep legacy onPath prop synced when running standalone (without shared PlanView path index).
	createEffect(
		() => {
			if (props.onSetActivePathIndex) return { skip: true as const };
			const at = localPath();
			const path = at === null ? undefined : paths().paths[at];
			return { skip: false as const, at, path };
		},
		(res) => {
			if (res.skip) return;
			if (res.at !== null && !res.path) {
				setLocalPath(null);
				return;
			}
			props.onPath?.(res.path ? res.path.steps.map((step) => step.id) : null);
		},
	);
	onCleanup(() => {
		if (!props.onSetActivePathIndex) props.onPath?.(null);
	});

	/** Four-step workflow overview at the top of Assistant. */
	const stages = (): { name: string; state: "done" | "warn" | "todo"; words: string }[] => {
		const hasCode = Boolean(built()?.units.length);
		const changed = anyChanges(changes());
		const testCount = paths().paths.length;
		const testsFile = built()?.tests;
		const testsCurrent = Boolean(testsFile && testsHashMatches(testsFile.hash, props.plan));
		return [
			{
				name: "Plan doc",
				state: spec() === "current" ? "done" : spec() === "stale" ? "warn" : "todo",
				words: spec() === "current" ? "Approved" : spec() === "stale" ? "Out of date" : "Not written",
			},
			{
				name: "Build",
				state: hasCode ? (changed ? "warn" : "done") : "todo",
				words: hasCode ? (changed ? "Chart changed" : "Built") : "Not built",
			},
			{
				name: "Code",
				state: !drift().checked ? "todo" : drift().items.length ? "warn" : "done",
				words: !drift().checked ? "Not checked" : drift().items.length ? "Differs" : "In sync",
			},
			{
				name: "Tests",
				state: testsCurrent ? "done" : testsFile ? "warn" : "todo",
				words: testsCurrent ? "Script current" : testsFile ? "Script stale" : `${testCount} ${testCount === 1 ? "journey" : "journeys"}`,
			},
		];
	};

	const canRealBuild = () =>
		!a().running &&
		spec() === "current" &&
		(run() && !stale() ? run()!.status !== "built" || run()!.units.some((u) => u.status === "pending") : !built()?.units.length || anyChanges(changes()));

	const pickedNodes = createMemo(() => {
		const k = pickedCodeState();
		if (!k || !props.nodesByCodeState) return [];
		return props.nodesByCodeState(k);
	});

	const triggerBuildNow = () => {
		if (spec() === "current") {
			void startBuild(props.path);
			return;
		}
		const draft = buildPlanAgentDraft(props.plan, { planLabel: baseName(props.path), driftItems: drift().items });
		void import("../agent/Agent").then((m) => m.openAgentWithDraft(draft, { cleanContext: true }));
	};

	const fixDriftWithAgent = () => {
		const draft = buildDriftAgentDraft(props.plan, drift().items, { planLabel: baseName(props.path) });
		void import("../agent/Agent").then((m) => m.openAgentWithDraft(draft, { cleanContext: true }));
	};

	const draftTestsWithAgent = () => {
		const draft = buildTestsAgentDraft(props.plan, { planLabel: baseName(props.path) });
		void import("../agent/Agent").then((m) => m.openAgentWithDraft(draft, { cleanContext: true }));
	};

	return (
		<aside class={["plan-assist", { "in-palette": Boolean(props.inPalette) }]} id={props.id} hidden={props.hidden} aria-label="Plan assistant">
			{/* 1. Workflow Header & Primary Actions Card */}
			<section class="pa-card pa-hero" aria-label="Plan workflow and actions">
				<div class="pa-hero-actions">
					<button
						type="button"
						class="primary pa-build-trigger"
						disabled={Boolean(a().running)}
						title={
							spec() === "current"
								? "Build or update STARLIMS code from the approved plan doc"
								: "Open Agent with a scoped implementation brief for this plan"
						}
						onClick={triggerBuildNow}
					>
						<Icon name="tools" />
						<span>{run() && !stale() ? "Carry on building" : built()?.units.length && anyChanges(changes()) ? "Rebuild changes" : "New build"}</span>
					</button>
					<div class="pa-hero-secondary">
						<button
							type="button"
							disabled={Boolean(a().running)}
							title="Ask the assistant to review this flowchart for missing steps, unclear rules, or edge cases and suggest questions to settle"
							onClick={() => void refine(props.path)}
						>
							Refine
						</button>
						<button
							type="button"
							disabled={Boolean(a().running) || open().length > 0}
							title="Turn this flowchart and your settled answers into a companion .plan.md breakdown to review before any code is built"
							aria-describedby={open().length ? specHint : undefined}
							onClick={() => void writeSpec(props.path)}
						>
							Write plan doc
						</button>
						<Show when={a().running && a().running !== "build"}>
							<button type="button" title="Stop the assistant; nothing in your files is changed" onClick={() => stopAssist(props.path)}>
								Stop
							</button>
						</Show>
					</div>
				</div>

				<Show when={open().length}>
					<p class="hint plan-assist-why" id={specHint}>
						Write plan doc waits for your {open().length === 1 ? "answer to the open question" : `answers to the ${open().length} open questions`}.
					</p>
				</Show>

				{/* 2x2 Pipeline Status Strip */}
				<ol class="pa-pipeline" aria-label="Where the plan stands">
					<For each={stages()} keyed={(stage) => stage.name}>
						{(stage) => (
							<li class={`pa-stage ${stage().state}`} title={`${stage().name}: ${stage().words}`}>
								<span class="pa-stage-icon" aria-hidden="true">
									<Icon name={stage().state === "done" ? "check" : stage().state === "warn" ? "warning" : "circle-outline"} />
								</span>
								<span class="pa-stage-body">
									<span class="pa-stage-name">{stage().name}</span>
									<span class="pa-stage-words">{stage().words}</span>
								</span>
							</li>
						)}
					</For>
				</ol>

				<p class="hint pa-model-row">
					<button type="button" class="link" title="Choose the model in the Agent panel" onClick={() => showPanel("agent")}>
						{currentModel() || "Choose model in Agent panel"}
					</button>
					<Show when={costNote()}>
						{(note) => (
							<>
								{" "}
								· <span title={note().why}>{note().words}</span>
							</>
						)}
					</Show>
					<Show when={a().tokens}>
						{" "}
						· {a().tokens.toLocaleString()} tokens
						<Show when={a().cost}>, cost {a().cost.toFixed(2)}</Show>
					</Show>
				</p>
			</section>

			<Show when={a().progress}>
				<p class="plan-assist-progress">{a().progress}</p>
			</Show>
			<For each={a().warnings}>
				{(w) => (
					<p class="plan-assist-warning">
						{w}{" "}
						<button type="button" class="link" onClick={() => dismissWarning(props.path, w)}>
							Dismiss
						</button>
					</p>
				)}
			</For>

			{/* 2. Needs Your Input Card (Questions, Suggestions, Decisions) */}
			<section class="pa-card" aria-label="Questions and suggestions">
				<button type="button" class="pa-card-head" aria-expanded={inputOpen() ? "true" : "false"} onClick={() => setInputOpen((o) => !o)}>
					<Icon name={inputOpen() ? "chevron-down" : "chevron-right"} />
					<span class="pa-card-title">Needs your input</span>
					<span class="spacer" />
					<span class={["pa-card-meta", { accent: inputCount() > 0 }]}>
						{inputCount() > 0 ? `${inputCount()} open` : closed().length ? `${closed().length} decided` : "None"}
					</span>
				</button>

				<Show when={inputOpen()}>
					<div class="pa-card-body">
						<Show when={inputCount() === 0 && closed().length === 0}>
							<p class="hint">No open questions or chart suggestions. Run Refine to have the agent review gaps in this flow.</p>
						</Show>

						<Show when={open().length}>
							<h4 class="pa-subhead">{open().length === 1 ? "A question for you" : `${open().length} questions for you`}</h4>
							<For each={open()} keyed={(q) => q.question}>
								{(q) => (
									<div class="plan-question">
										<p>
											{q().question} <Node id={q().node} />
										</p>
										<Show when={q().suggested?.length}>
											<div class="plan-answers">
												<For each={q().suggested}>
													{(s) => (
														<button type="button" onClick={() => answer(props.path, q().question, s)}>
															{s}
														</button>
													)}
												</For>
											</div>
										</Show>
										<input
											placeholder="Your answer"
											aria-label={q().question}
											onKeyDown={(e) => {
												if (e.key === "Enter" && e.currentTarget.value.trim()) answer(props.path, q().question, e.currentTarget.value);
											}}
											onChange={(e) => {
												if (e.currentTarget.value.trim()) answer(props.path, q().question, e.currentTarget.value);
											}}
										/>
										<div class="pa-promote-row">
											<button
												type="button"
												class="link pa-promote-btn"
												title="Save this open question to docs/knowledge/questions/"
												onClick={() =>
													void promoteToKnowledge("questions", {
														title: q().question,
														body: `Raised while refining plan "${props.plan.title || "Plan"}".`,
														ticket: typeof props.plan.ticket === "string" ? props.plan.ticket : undefined,
													})
												}
											>
												Save as Question doc…
											</button>
										</div>
									</div>
								)}
							</For>
						</Show>

						<Show when={a().suggestions.length}>
							<div class="pa-subhead-row">
								<h4 class="pa-subhead">Suggestions</h4>
								<button type="button" onClick={() => acceptAll(props.path)}>
									Accept all
								</button>
							</div>
							<For each={a().suggestions}>
								{(s) => (
									<div class="plan-suggestion">
										<p>{describeSuggestion(s, props.plan, a().suggestions)}</p>
										<Show when={s.why}>
											<p class="hint">{s.why}</p>
										</Show>
										<div class="plan-answers">
											<button type="button" onClick={() => acceptSuggestion(props.path, s.key)}>
												Accept
											</button>
											<button type="button" onClick={() => declineSuggestion(props.path, s.key)}>
												Decline
											</button>
										</div>
									</div>
								)}
							</For>
						</Show>

						<Show when={closed().length}>
							<button type="button" class="pa-subtoggle" aria-expanded={decidedOpen() ? "true" : "false"} onClick={() => setDecidedOpen((o) => !o)}>
								<Icon name={decidedOpen() ? "chevron-down" : "chevron-right"} />
								<span>What you decided ({closed().length})</span>
							</button>
							<Show when={decidedOpen()}>
								<For each={closed()} keyed={(q) => q.question}>
									{(q) => (
										<div class="plan-question decided">
											<p class="hint">
												{q().question} <Node id={q().node} />
											</p>
											<DraftAnswerInput
												value={q().answer ?? ""}
												ariaLabel={q().question}
												onCommit={(val) => answer(props.path, q().question, val)}
											/>
											<div class="pa-promote-row">
												<button
													type="button"
													class="link pa-promote-btn"
													title="Promote this settled answer to a numbered Decision ADR in docs/knowledge/decisions/"
													onClick={() =>
														void promoteToKnowledge("decisions", {
															title: q().question.replace(/\?+$/, ""),
															body: `Question from plan "${props.plan.title || "Plan"}": ${q().question}`,
															decision: q().answer,
															sourcePlan: props.path,
															ticket: typeof props.plan.ticket === "string" ? props.plan.ticket : undefined,
														})
													}
												>
													Promote to Decision ADR…
												</button>
											</div>
										</div>
									)}
								</For>
							</Show>
						</Show>
					</div>
				</Show>
			</section>

			{/* 3. Build & Code Sync Card */}
			<section class="pa-card" aria-label="Build and code status">
				<button type="button" class="pa-card-head" aria-expanded={buildOpen() ? "true" : "false"} onClick={() => setBuildOpen((o) => !o)}>
					<Icon name={buildOpen() ? "chevron-down" : "chevron-right"} />
					<span class="pa-card-title">Build &amp; code</span>
					<span class="spacer" />
					<span class="pa-card-meta">
						{built()?.units.length ? `${built()!.units.length} ${built()!.units.length === 1 ? "unit" : "units"}` : "Not built"}
					</span>
				</button>

				<Show when={buildOpen()}>
					<div class="pa-card-body">
						{/* Five-state code indicator summary strip (stoplight + grey + blue) */}
						<Show when={props.codeCounts}>
							{(counts) => (
								<div class="pa-code-summary" role="group" aria-label="Step code status breakdown">
									<div class="pa-code-pills">
										<For each={CODE_ORDER}>
											{(kind) => {
												const count = () => counts()[kind] ?? 0;
												const active = () => pickedCodeState() === kind;
												return (
													<Show when={count() > 0 || kind === "green" || kind === "grey"}>
														<button
															type="button"
															class={[`pa-code-pill ${kind}`, { active: active(), empty: count() === 0 }]}
															disabled={count() === 0}
															title={`${CODE_INDICATOR_WORDS[kind].label}: ${CODE_INDICATOR_WORDS[kind].detail}`}
															onClick={() => setPickedCodeState((cur) => (cur === kind ? null : kind))}
														>
															<span class={`plan-status-dot ${kind}`} aria-hidden="true" />
															<span>{CODE_INDICATOR_WORDS[kind].label}</span>
															<strong>{count()}</strong>
														</button>
													</Show>
												);
											}}
										</For>
									</div>
									<Show when={pickedCodeState() && pickedNodes().length > 0}>
										<div class="pa-code-nodes">
											<For each={pickedNodes()}>
												{(n) => (
													<button type="button" class="link plan-chip" onClick={() => props.onSelect(n.id)}>
														{n.text.trim() || "(no words yet)"}
													</button>
												)}
											</For>
										</div>
									</Show>
								</div>
							)}
						</Show>

						<Show when={anyChanges(changes())}>
							<div class="pa-subsection">
								<h4 class="pa-subhead">Since it was built</h4>
								<For each={[...changes().changed.map((id) => ({ id, what: "Changed" })), ...changes().added.map((id) => ({ id, what: "New" }))]} keyed={(c) => `${c.what}:${c.id}`}>
									{(c) => (
										<p class="plan-change">
											{c().what}: <Node id={c().id} />
										</p>
									)}
								</For>
								<Show when={changes().removed.length}>
									<p class="plan-change">Removed: {changes().removed.join(", ")}. Their code stays until you remove it.</p>
								</Show>
								<p class="hint">Write the plan doc again, then build. Only what these touch is rebuilt, and the rest of the code is not reprinted.</p>
							</div>
						</Show>

						<div class="pa-subsection">
							<div class="pa-subhead-row">
								<h4 class="pa-subhead">Build</h4>
								<Show when={a().running === "build"}>
									<button type="button" onClick={() => stopBuild(props.path)}>
										Stop
									</button>
								</Show>
							</div>
							<Show when={spec() === "current" && (!run() || stale()) && (!built()?.units.length || anyChanges(changes()))}>
								<p class="hint">The agent builds from the spec without stopping. Nothing is written until you have reviewed it.</p>
							</Show>
							<Show when={spec() !== "current" && (!run() || stale())}>
								<p class="hint">Needs an approved spec, up to date with the plan.</p>
							</Show>
							<Show when={spec() === "current" && (!run() || stale()) && built()?.units.length && !anyChanges(changes())}>
								<p class="hint">Built, and the chart has not changed since.</p>
							</Show>
							<Show when={canRealBuild()}>
								<button type="button" class="primary" onClick={() => void startBuild(props.path)}>
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
										<For each={r().units.filter((u) => u.status !== "kept")} keyed={(u) => u.name}>
											{(unit) => (
												<div class={`plan-unit ${unit().status}`}>
													<p>
														<strong>{unit().name}</strong>{" "}
														<span class="hint">
															{STATUS[unit().status]}
															{unit().change ? ", an edit" : ""}
															{unit().attempts > 1 && unit().status !== "pending" ? `, try ${unit().attempts}` : ""}
														</span>
													</p>
													<Show when={unit().problems?.length}>
														<ul class="plan-problems">
															<For each={unit().problems}>{(p) => <li>{p}</li>}</For>
														</ul>
													</Show>
													<Show when={unit().status === "stuck" && unit().question && !unit().answer}>
														<input
															placeholder="Your answer"
															aria-label={unit().question}
															onKeyDown={(e) => {
																if (e.key === "Enter") answerUnit(props.path, unit().name, e.currentTarget.value);
															}}
														/>
													</Show>
													<Show when={unit().status === "stuck" && !a().running && !(unit().question && !unit().answer)}>
														<button type="button" onClick={() => retryUnit(props.path, unit().name)}>
															Try again
														</button>
													</Show>
												</div>
											)}
										</For>
										<Show when={!a().running && scriptsToReview(r(), props.plan).length}>
											<button type="button" class="primary" onClick={() => void reviewBuild(props.path)}>
												Review {scriptsToReview(r(), props.plan).length === 1 ? scriptsToReview(r(), props.plan)[0] : `${scriptsToReview(r(), props.plan).length} scripts`}
											</button>
										</Show>
										<Show when={!a().running && r().status === "built" && r().units.every((u) => u.status === "kept")}>
											<p class="hint">Nothing in the code needed to change.</p>
										</Show>
										<Show when={!a().running && r().status === "built" && !scriptsToReview(r(), props.plan).length && r().accepted.length}>
											<p class="hint">
												{unbuiltNodes(props.plan, r()).length
													? `Accepted, but nothing is built yet for: ${unbuiltNodes(props.plan, r()).join(", ")}.`
													: "Accepted. This code has not been run: test it in STARLIMS."}
											</p>
										</Show>
										<Show when={!a().running}>
											<button type="button" class="link" onClick={() => void discard()}>
												Discard this build
											</button>
										</Show>
									</>
								)}
							</Show>
						</div>

						<Show when={built()?.units.length || drift().checked || drift().items.length}>
							<div class="pa-subsection">
								<div class="pa-subhead-row">
									<h4 class="pa-subhead">Chart and code</h4>
									<button type="button" class="pa-mini-btn" title="Compare the chart with the code again" onClick={() => recheckPlan(uri() ?? "")}>
										<Icon name="refresh" />
										<span>Refresh</span>
									</button>
								</div>
								<Show
									when={drift().items.length}
									fallback={
										<p class="hint">
											{drift().checked
												? "They agree: every linked script and function matches the chart. Run your tests in STARLIMS to verify behaviour."
												: "Checking linked scripts against the chart…"}
										</p>
									}
								>
									<For each={drift().items}>
										{(d) => {
											const openAction = () => resolveDriftOpenAction(d, built()?.units ?? [], planTargets(), nodeIdSet());
											return (
												<p class={["plan-drift", { warning: d.severity === "warning" }]}>
													{d.message}{" "}
													<Show when={openAction()}>
														{(action) => (
															<button
																type="button"
																class="link"
																onClick={() => {
																	const act = action();
																	if (act.kind === "unit") void openProcedure(uri(), act.unit);
																	else if (act.kind === "script") void openScript(act.script);
																	else props.onSelect(act.nodeId);
																}}
															>
																{action().kind === "node" ? "Show step" : "Open"}
															</button>
														)}
													</Show>
												</p>
											);
										}}
									</For>
									<p class="hint">Review these differences — the code may have been updated outside the flowchart.</p>
									<button
										type="button"
										class="pa-action-btn"
										title="Open Agent with a scoped brief to reconcile these flowchart and code differences"
										onClick={fixDriftWithAgent}
									>
										<Icon name="sparkle" />
										<span>Fix drift with Agent</span>
									</button>
								</Show>
							</div>
						</Show>
					</div>
				</Show>
			</section>

			{/* 4. Tests & Scenarios Card (Always Visible — Business Test Cases + Flowchart Journeys) */}
			<section class="pa-card" aria-label="Flowchart tests">
				<button type="button" class="pa-card-head" aria-expanded={testsOpen() ? "true" : "false"} onClick={() => setTestsOpen((o) => !o)}>
					<Icon name={testsOpen() ? "chevron-down" : "chevron-right"} />
					<span class="pa-card-title">Tests</span>
					<span class="spacer" />
					<span class={["pa-card-meta", { accent: shownPath() !== null || customTests().length > 0 }]}>
						{customTests().length ? `${customTests().length} ${customTests().length === 1 ? "test" : "tests"} · ` : ""}
						{paths().paths.length}
						{paths().truncated ? "+" : ""} {paths().paths.length === 1 ? "journey" : "journeys"}
					</span>
				</button>

				<Show when={testsOpen()}>
					<div class="pa-card-body">
						<Show
							when={props.onAddTestCase && props.onUpdateTestCase && props.onRemoveTestCase}
							fallback={
								<div class="pa-subsection">
									<h4 class="pa-subhead">Business test cases ({customTests().length})</h4>
									<p class="hint">Open a plan chart in Palette to add or edit plain-English business test cases.</p>
								</div>
							}
						>
							<div class="pa-subsection">
								<TestCaseList
									plan={props.plan}
									cases={customTests()}
									paths={paths().paths}
									activePathIndex={shownPath()}
									heading={`Business test cases (${customTests().length})`}
									emptyText="Add business test cases here or on any selected step, then click any case to inspect or edit all details."
									externalDraft={draftReq()}
									onConsumeDraft={() => setDraftReq(null)}
									onHighlightPath={(idx) => setShownPath(idx)}
									onJumpToNode={(id) => props.onSelect(id)}
									onAddTestCase={(input) => props.onAddTestCase!(input)}
									onUpdateTestCase={(id, patch) => props.onUpdateTestCase!(id, patch)}
									onRemoveTestCase={(id) => props.onRemoveTestCase!(id)}
								/>
							</div>
						</Show>

						<div class="pa-subsection">
							<h4 class="pa-subhead">End-to-end flowchart journeys</h4>
							<p class="hint">
								Each path from Start to Finish is a journey to verify ({paths().paths.length}
								{paths().truncated ? " or more" : ""}). Walk through a journey below or click Add test details to save custom inputs and expectations.
							</p>
							<Show when={paths().paths.length}>
								<div class="plan-paths" role="group" aria-label="Journeys through the chart">
									<button type="button" title="Previous journey" aria-label="Previous journey" onClick={() => stepPath(-1)}>
										<Icon name="chevron-left" />
									</button>
									<span role="status">
										{shownPath() === null ? "Walk a journey on the chart" : `Journey #${shownPath()! + 1} of ${paths().paths.length}`}
									</span>
									<button type="button" title="Next journey" aria-label="Next journey" onClick={() => stepPath(1)}>
										<Icon name="chevron-right" />
									</button>
									<Show when={shownPath() !== null}>
										<button type="button" title="Stop showing this journey" onClick={() => setShownPath(null)}>
											Hide
										</button>
									</Show>
								</div>
								<Show when={shownPath() !== null && paths().paths[shownPath()!]}>
									{(path) => (
										<div class="pa-path-preview">
											<div class="pa-subhead-row">
												<p class="pa-path-caption">{pathSummary(path(), paths().paths, props.plan)}</p>
												<Show when={props.onAddTestCase}>
													<button
														type="button"
														class="plan-test-add-btn"
														title="Save this journey as an editable business test case"
														onClick={() => {
															const idx = shownPath()!;
															setDraftReq({
																draft: journeyDraft(props.plan, path(), paths().paths, idx),
																seq: ++draftSeq,
															});
														}}
													>
														<Icon name="add" />
														<span>Save as test</span>
													</button>
												</Show>
											</div>
											<ol class="plan-path-steps">
												<For each={path().steps}>
													{(step) => (
														<li>
															<Show when={step.label}>
																<span class="plan-path-label">{step.label}</span>{" "}
															</Show>
															<Node id={step.id} />
														</li>
													)}
												</For>
											</ol>
										</div>
									)}
								</Show>
							</Show>
						</div>

						<div class="pa-subsection">
							<h4 class="pa-subhead">STARLIMS test script</h4>
							<p class="hint">
								Generates a runnable STARLIMS SSL test file covering every flowchart journey and custom test case, ready to review and run in STARLIMS.
							</p>
							<Show
								when={built()?.units.length}
								fallback={
									<button
										type="button"
										class="pa-action-btn"
										disabled={Boolean(a().running)}
										title="Open Agent with a scoped brief to draft a STARLIMS SSL test script covering these journeys and business test cases"
										onClick={draftTestsWithAgent}
									>
										<Icon name="beaker" />
										<span>Write tests with Agent</span>
									</button>
								}
							>
								<button
									type="button"
									class="pa-action-btn"
									disabled={Boolean(a().running)}
									title="Ask the assistant to generate a runnable STARLIMS SSL test script covering every flowchart journey and business test case, for review before saving"
									onClick={() => void writeTests(props.path)}
								>
									Write the test script
								</button>
							</Show>

							<Show when={built()?.tests && typeof built()!.tests!.script === "string" && built()!.tests!.script.trim().length > 0 ? built()!.tests! : null}>
								{(tests) => (
									<p class="hint">
										<button type="button" class="link" onClick={() => state.workspace && void openFile(joinPath(state.workspace.root, tests().script))}>
											{tests().script}
										</button>
										{testsHashMatches(tests().hash, props.plan) ? "" : " was written before the chart or its test cases last changed."}
									</p>
								)}
							</Show>
						</div>
					</div>
				</Show>
			</section>

			{/* 5. Plan Doc Card */}
			<section class="pa-card" aria-label="Plan doc">
				<button type="button" class="pa-card-head" aria-expanded={specOpen() ? "true" : "false"} onClick={() => setSpecOpen((o) => !o)}>
					<Icon name={specOpen() ? "chevron-down" : "chevron-right"} />
					<span class="pa-card-title">Plan doc</span>
					<span class="spacer" />
					<span class="pa-card-meta">
						{spec() === "current" ? "Approved" : spec() === "stale" ? "Out of date" : "Not written"}
					</span>
				</button>

				<Show when={specOpen()}>
					<div class="pa-card-body">
						<Show when={spec() && spec() !== "none"} fallback={<p class="hint">Not written yet. Refine the plan, then write the plan doc.</p>}>
							<p class="hint">
								{spec() === "stale" ? "The plan has changed since this plan doc was approved: write it again." : "Approved, and up to date with the plan."}
							</p>
							<button type="button" class="link" onClick={() => void openFile(specPath(props.path))}>
								Open the plan doc
							</button>
						</Show>
					</div>
				</Show>
			</section>

			<p class="hint plan-assist-foot">Nothing here changes your code until you accept it at review.</p>
		</aside>
	);
}
