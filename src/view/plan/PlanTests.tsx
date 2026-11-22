// Business-analyst-first test scenario inspector for a selected step/decision,
// the whole plan, and the Assistant tab. Analysts can inspect and modify every
// detail of a test case (scenario, step, linked journey, starting setup,
// expected outcome, and sample data/notes — stored in `.plan.json`, undoable
// via Ctrl+Z), and inspect or customize any flowchart journey.
import { createEffect, createMemo, createSignal, For, Show } from "solid-js";
import { baseName } from "../../shared/paths";
import { Icon } from "../Icon";
import { IconButton } from "../panels/Rows";
import { planHash } from "./assist";
import { builtOf, journeyBreakdown, journeyDraft, journeyOptionLabel, nodeTestContext, pathsForNode, pathStory, pathSummary, planPaths, shortPhrase, type JourneyBreakdownItem, type PlanPath } from "./built";
import { planTestsOf, type Plan, type PlanNode, type PlanTestCase, type PlanTestInput, type PlanTestPatch } from "./model";
import type { ScheduledBuildScope } from "./planBridge";

export type TestCaseDraft = {
	title?: string;
	node?: string;
	journey?: number;
	given?: string;
	expect?: string;
	notes?: string;
};

/** Auto-grow a textarea to fit its multi-line content cleanly (up to 180px before scrolling). */
function fitTextBox(el: HTMLTextAreaElement) {
	el.style.height = "auto";
	el.style.height = `${Math.min(180, Math.max(54, el.scrollHeight + 2))}px`;
}

/** Splits bulleted multi-line Given text ("- item\n- item") into crisp lines, or null for regular prose. */
function bulletLines(text?: string): string[] | null {
	if (!text) return null;
	const lines = text
		.split(/\r?\n/)
		.map((l) => l.trim())
		.filter(Boolean);
	if (lines.length < 2 || !lines.every((l) => l.startsWith("- "))) return null;
	return lines.map((l) => l.slice(2).trim());
}

export function TestCaseForm(props: {
	initial?: Partial<PlanTestCase> | TestCaseDraft;
	mode?: "create" | "edit";
	nodes: PlanNode[];
	plan: Plan;
	paths: PlanPath[];
	saveLabel: string;
	onSave: (value: PlanTestInput, clearJourney?: boolean) => void;
	onCancel: () => void;
	onDelete?: () => void;
}) {
	const [title, setTitle] = createSignal(props.initial?.title ?? "");
	const [nodeId, setNodeId] = createSignal(props.initial?.node ?? "");
	const [journey, setJourney] = createSignal(props.initial?.journey ? String(props.initial.journey) : "");
	const [given, setGiven] = createSignal(props.initial?.given ?? "");
	const [expect, setExpect] = createSignal(props.initial?.expect ?? "");
	const [notes, setNotes] = createSignal(props.initial?.notes ?? "");
	const [notesOpen, setNotesOpen] = createSignal(Boolean(props.initial?.notes?.trim()));

	const selectedJourneySummary = createMemo(() => {
		const n = journey() ? Number.parseInt(journey(), 10) : 0;
		const p = n >= 1 && n <= props.paths.length ? props.paths[n - 1] : null;
		return p ? pathSummary(p, props.paths, props.plan) : "";
	});

	const submit = (e?: Event) => {
		e?.preventDefault();
		if (!title().trim()) return;
		const parsedJourney = journey() ? Number.parseInt(journey(), 10) : undefined;
		props.onSave(
			{
				title: title().trim(),
				node: nodeId().trim() || undefined,
				journey: parsedJourney && Number.isInteger(parsedJourney) && parsedJourney > 0 ? parsedJourney : undefined,
				given: given().trim() || undefined,
				expect: expect().trim() || undefined,
				notes: notes().trim() || undefined,
			},
			!parsedJourney,
		);
	};

	return (
		<form class="plan-test-form" onSubmit={submit} aria-label={props.mode === "edit" ? "Edit test case" : "New test case"}>
			<div class="plan-test-form-head">
				<span class="plan-test-form-heading">{props.mode === "edit" ? "Edit test case" : "New test case"}</span>
				<IconButton label="Close test form" title="Cancel" icon="close" onClick={props.onCancel} />
			</div>

			<label class="plan-test-form-field">
				<span class="plan-test-field-label">Test name</span>
				<input
					class="plan-test-title-input"
					value={title()}
					placeholder="e.g. Rush sample received on a holiday"
					onInput={(e) => setTitle(e.currentTarget.value)}
					ref={(el) => queueMicrotask(() => el.focus())}
				/>
			</label>

			<Show when={props.nodes.length > 0 || props.paths.length > 0}>
				<div class="plan-test-form-attach">
					<span class="plan-test-attach-title">Linked to</span>
					<div class="plan-test-form-grid">
						<Show when={props.nodes.length > 0}>
							<label class="plan-test-attach-row">
								<span>Step</span>
								<select value={nodeId()} onChange={(e) => setNodeId(e.currentTarget.value)}>
									<option value="">Whole plan</option>
									<For each={props.nodes}>
										{(n) => <option value={n.id}>{shortPhrase(n.text.trim() || n.id, 40)}</option>}
									</For>
								</select>
							</label>
						</Show>
						<Show when={props.paths.length > 0}>
							<label class="plan-test-attach-row">
								<span>Journey</span>
								<select value={journey()} onChange={(e) => setJourney(e.currentTarget.value)}>
									<option value="">None</option>
									<For each={props.paths}>
										{(p, idx) => (
											<option value={String(idx() + 1)}>
												{journeyOptionLabel(p, props.paths, props.plan, idx())}
											</option>
										)}
									</For>
								</select>
							</label>
						</Show>
					</div>
					<Show when={selectedJourneySummary()}>
						<p class="plan-test-attach-preview" title={selectedJourneySummary()}>
							{selectedJourneySummary()}
						</p>
					</Show>
				</div>
			</Show>

			<div class="plan-test-form-spec">
				<label class="plan-test-spec-block">
					<span class="plan-test-kw-row">
						<span class="plan-test-kw given">Given</span>
						<span class="plan-test-kw-hint">Starting conditions (one per line)</span>
					</span>
					<textarea
						rows={2}
						value={given()}
						placeholder="e.g. Rush sample received Friday 4pm, Monday is a holiday"
						ref={(el) => queueMicrotask(() => fitTextBox(el))}
						onInput={(e) => {
							setGiven(e.currentTarget.value);
							fitTextBox(e.currentTarget);
						}}
					/>
				</label>

				<label class="plan-test-spec-block">
					<span class="plan-test-kw-row">
						<span class="plan-test-kw expect">Expect</span>
						<span class="plan-test-kw-hint">What should happen</span>
					</span>
					<textarea
						rows={2}
						value={expect()}
						placeholder="e.g. Due date moves to Tuesday; sample is not skipped"
						ref={(el) => queueMicrotask(() => fitTextBox(el))}
						onInput={(e) => {
							setExpect(e.currentTarget.value);
							fitTextBox(e.currentTarget);
						}}
					/>
				</label>
			</div>

			<Show
				when={notesOpen()}
				fallback={
					<button
						type="button"
						class="plan-test-notes-toggle"
						onClick={() => setNotesOpen(true)}
					>
						<Icon name="add" />
						<span>Add sample data or notes (optional)</span>
					</button>
				}
			>
				<label class="plan-test-spec-block">
					<span class="plan-test-kw-row">
						<span class="plan-test-kw notes">Notes</span>
						<span class="plan-test-kw-hint">Sample IDs, outages, or edge-case checks</span>
					</span>
					<textarea
						rows={2}
						value={notes()}
						placeholder="Sample IDs, instrument outages, edge-case rules, or STARLIMS check notes"
						ref={(el) => queueMicrotask(() => fitTextBox(el))}
						onInput={(e) => {
							setNotes(e.currentTarget.value);
							fitTextBox(e.currentTarget);
						}}
					/>
				</label>
			</Show>

			<div class="plan-test-form-actions">
				<button type="submit" class="primary" disabled={!title().trim()}>
					{props.saveLabel}
				</button>
				<button type="button" onClick={props.onCancel}>
					Cancel
				</button>
				<Show when={props.onDelete}>
					<span class="spacer" />
					<button type="button" class="plan-test-delete-btn" onClick={props.onDelete}>
						Delete
					</button>
				</Show>
			</div>
		</form>
	);
}

/** Expandable business test case card: click to inspect full details, edit inline, jump to step, or highlight its journey. */
export function TestCaseList(props: {
	plan: Plan;
	cases: PlanTestCase[];
	paths: PlanPath[];
	activePathIndex: number | null;
	heading: string;
	emptyText: string;
	defaultNodeId?: string;
	hideStepBadge?: boolean;
	hideAddButton?: boolean;
	/** Whether clicking a linked step badge switches selection ("jump") or spotlights on chart without moving away ("peek"). */
	stepAction?: "jump" | "peek";
	/** Optional external draft request (e.g. from clicking "Add test details" on a flowchart journey). */
	externalDraft?: { draft: TestCaseDraft; seq: number } | null;
	onHighlightPath: (index: number | null) => void;
	onJumpToNode: (id: string) => void;
	onPeekNode?: (id: string | null, opts?: { pan?: boolean }) => void;
	onOpenTextBuilder?: (opts?: { nodeId?: string; journeyIndex?: number; testId?: string }) => void;
	onAddTestCase: (input: PlanTestInput) => void;
	onUpdateTestCase: (id: string, patch: PlanTestPatch) => void;
	onRemoveTestCase: (id: string) => void;
}) {
	const [adding, setAdding] = createSignal<TestCaseDraft | null>(null);
	const [expandedId, setExpandedId] = createSignal<string | null>(null);
	const [editingId, setEditingId] = createSignal<string | null>(null);

	const actionableNodes = createMemo(() => props.plan.nodes.filter((n) => n.kind !== "start" && n.kind !== "end" && !n.pending));
	const nodeText = (id?: string) => (id ? props.plan.nodes.find((n) => n.id === id)?.text.trim() : undefined);

	// Reset inline editing when switching selected step context.
	createEffect(() => {
		props.defaultNodeId;
		setAdding(null);
		setEditingId(null);
	});

	// Open pre-filled form when user clicks "Add test details" on a flowchart journey.
	createEffect(() => {
		const req = props.externalDraft;
		if (!req) return;
		setEditingId(null);
		setAdding(req.draft);
	});

	return (
		<div class="plan-impl-group">
			<div class="plan-test-head-row">
				<span class="plan-impl-subhead">{props.heading}</span>
				<Show when={!props.hideAddButton && !adding()}>
					<div class="plan-test-head-btns">
						<Show when={props.onOpenTextBuilder}>
							<button
								type="button"
								class="plan-test-add-btn"
								title="Open the interactive Text test builder to trace branches directly on the process outline"
								onClick={() =>
									props.onOpenTextBuilder!({
										nodeId: props.defaultNodeId,
										journeyIndex: props.activePathIndex !== null ? props.activePathIndex : undefined,
									})
								}
							>
								<Icon name="beaker" />
								<span>Build in Text</span>
							</button>
						</Show>
						<button
							type="button"
							class="plan-test-add-btn"
							classList={{ subtle: Boolean(props.onOpenTextBuilder) }}
							title="Quickly write a test case right here in the sidebar"
							onClick={() => {
								setEditingId(null);
								setAdding({
									node: props.defaultNodeId,
									journey: props.activePathIndex !== null ? props.activePathIndex + 1 : undefined,
								});
							}}
						>
							<Icon name="add" />
							<span>{props.onOpenTextBuilder ? "Quick add" : "Add test"}</span>
						</button>
					</div>
				</Show>
			</div>

			<Show when={adding()} keyed>
				{(draft) => (
					<TestCaseForm
						mode="create"
						initial={draft}
						nodes={actionableNodes()}
						plan={props.plan}
						paths={props.paths}
						saveLabel="Save test"
						onSave={(val) => {
							props.onAddTestCase(val);
							setAdding(null);
						}}
						onCancel={() => setAdding(null)}
					/>
				)}
			</Show>

			<Show
				when={props.cases.length > 0}
				fallback={
					<Show when={!adding()}>
						<p class="plan-impl-empty">{props.emptyText}</p>
					</Show>
				}
			>
				<div class="plan-test-cases">
					<For each={props.cases}>
						{(item) => {
							const isEditing = () => editingId() === item.id;
							const isOpen = () => expandedId() === item.id;
							const stepName = () => nodeText(item.node);
							const journeyIdx = () => (item.journey && item.journey >= 1 && item.journey <= props.paths.length ? item.journey - 1 : null);
							const journeyActive = () => journeyIdx() !== null && props.activePathIndex === journeyIdx();
							return (
								<Show
									when={isEditing()}
									fallback={
										<div class="plan-test-case" classList={{ open: isOpen() }}>
											<div class="plan-test-case-head">
												<button
													type="button"
													class="plan-test-case-toggle"
													aria-expanded={isOpen()}
													title={isOpen() ? "Hide test details" : "Click to inspect or modify test details"}
													onClick={() => setExpandedId((cur) => (cur === item.id ? null : item.id))}
												>
													<Icon name={isOpen() ? "chevron-down" : "chevron-right"} class="plan-test-case-chev" />
													<span class="plan-test-case-title">{item.title}</span>
												</button>
												<div class="plan-test-case-btns">
													<IconButton
														label={`Edit test case ${item.title}`}
														title="Edit test details"
														icon="note"
														onClick={() => {
															setAdding(null);
															setExpandedId(item.id);
															setEditingId(item.id);
														}}
													/>
													<IconButton
														label={`Remove test case ${item.title}`}
														title="Delete test case"
														icon="trash"
														onClick={() => props.onRemoveTestCase(item.id)}
													/>
												</div>
											</div>

											<Show when={!isOpen() && (item.expect || item.journey || (!props.hideStepBadge && stepName()))}>
												<div class="plan-test-case-preview" onClick={() => setExpandedId(item.id)}>
													<Show when={!props.hideStepBadge && stepName()}>
														<span class="plan-test-case-badge">{stepName()}</span>
													</Show>
													<Show when={item.journey}>
														<span class="plan-test-case-badge journey">Journey #{item.journey}</span>
													</Show>
													<Show when={item.expect}>
														<span class="plan-test-case-snippet">{item.expect}</span>
													</Show>
												</div>
											</Show>

											<Show when={isOpen()}>
												<div class="plan-test-case-details">
													<Show when={stepName() || journeyIdx() !== null}>
														<div class="plan-test-case-links">
															<Show when={stepName() && item.node}>
																<button
																	type="button"
																	class="plan-test-case-step"
																	title={
																		props.stepAction === "peek"
																			? `Spotlight "${stepName()}" on chart (keeps current step selected)`
																			: `Select "${stepName()}" on chart`
																	}
																	onMouseEnter={() => props.stepAction === "peek" && props.onPeekNode?.(item.node!, { pan: false })}
																	onMouseLeave={() => props.stepAction === "peek" && props.onPeekNode?.(null)}
																	onClick={() =>
																		props.stepAction === "peek" && props.onPeekNode
																			? props.onPeekNode(item.node!, { pan: true })
																			: props.onJumpToNode(item.node!)
																	}
																>
																	<Icon name={props.stepAction === "peek" ? "eye" : "play"} />
																	<span>{stepName()}</span>
																</button>
															</Show>
															<Show when={journeyIdx() !== null}>
																<button
																	type="button"
																	class="plan-test-case-step journey"
																	classList={{ active: journeyActive() }}
																	title={journeyActive() ? "Hide journey on chart" : `Highlight Journey #${item.journey} on chart`}
																	onClick={() => props.onHighlightPath(journeyActive() ? null : journeyIdx())}
																>
																	<Icon name="eye" />
																	<span>Journey #{item.journey}</span>
																</button>
															</Show>
														</div>
													</Show>

													<div class="plan-test-detail-row">
														<span class="plan-test-kw given">Given</span>
														<Show
															when={bulletLines(item.given)}
															fallback={
																<p class="plan-test-detail-val" classList={{ muted: !item.given }}>
																	{item.given || "Not specified yet"}
																</p>
															}
														>
															{(lines) => (
																<ul class="plan-test-bullets">
																	<For each={lines()}>{(line) => <li>{line}</li>}</For>
																</ul>
															)}
														</Show>
													</div>
													<div class="plan-test-detail-row">
														<span class="plan-test-kw expect">Expect</span>
														<p class="plan-test-detail-val" classList={{ muted: !item.expect }}>
															{item.expect || "Not specified yet"}
														</p>
													</div>
													<Show when={item.notes}>
														<div class="plan-test-detail-row">
															<span class="plan-test-kw notes">Notes</span>
															<p class="plan-test-detail-val">{item.notes}</p>
														</div>
													</Show>

													<div class="plan-test-case-footer">
														<button
															type="button"
															class="plan-test-edit-btn"
															onClick={() => {
																setAdding(null);
																setEditingId(item.id);
															}}
														>
															<Icon name="note" />
															<span>Edit details</span>
														</button>
														<button
															type="button"
															class="plan-test-delete-btn"
															onClick={() => props.onRemoveTestCase(item.id)}
														>
															Delete
														</button>
													</div>
												</div>
											</Show>
										</div>
									}
								>
									<TestCaseForm
										mode="edit"
										initial={item}
										nodes={actionableNodes()}
										plan={props.plan}
										paths={props.paths}
										saveLabel="Save changes"
										onSave={(val, clearJourney) => {
											props.onUpdateTestCase(item.id, {
												title: val.title,
												node: val.node ?? "",
												journey: clearJourney ? null : val.journey,
												given: val.given ?? "",
												expect: val.expect ?? "",
												notes: val.notes ?? "",
											});
											setEditingId(null);
											setExpandedId(item.id);
										}}
										onCancel={() => setEditingId(null)}
										onDelete={() => {
											setEditingId(null);
											props.onRemoveTestCase(item.id);
										}}
									/>
								</Show>
							);
						}}
					</For>
				</div>
			</Show>
		</div>
	);
}

/** Structured stage-grouped vertical timeline of a highlighted journey, with one-click conversion into an editable test case. */
function JourneyDetailBox(props: {
	plan: Plan;
	paths: PlanPath[];
	pathIndex: number;
	defaultNodeId?: string;
	onPeekNode?: (id: string | null, opts?: { pan?: boolean }) => void;
	onCustomize: (draft: TestCaseDraft) => void;
}) {
	const path = () => props.paths[props.pathIndex];
	const breakdown = createMemo(() => (path() ? journeyBreakdown(props.plan, path()!) : null));

	/** Group consecutive decision items by stage so the reader sees clear phases rather than a wall of bullets. */
	const sections = createMemo(() => {
		const bd = breakdown();
		if (!bd) return [];
		const out: { stage?: string; items: JourneyBreakdownItem[] }[] = [];
		let sawNamedStage = false;
		for (const item of bd.items) {
			if (item.stage) sawNamedStage = true;
			const label = item.stage ?? (sawNamedStage ? "Wrap-up" : undefined);
			const prev = out.at(-1);
			if (prev && prev.stage === label) prev.items.push(item);
			else out.push({ stage: label, items: [item] });
		}
		return out;
	});

	const toneOf = (label: string) => {
		const lower = label.toLowerCase();
		return lower === "yes" ? "yes" : lower === "no" ? "no" : "";
	};

	const makeDraft = (): TestCaseDraft => {
		const p = path();
		if (!p) return { journey: props.pathIndex + 1, node: props.defaultNodeId };
		return journeyDraft(props.plan, p, props.paths, props.pathIndex, props.defaultNodeId);
	};

	return (
		<Show when={breakdown()} keyed>
			{(bd) => (
				<div class="plan-test-journey-detail">
					<div class="plan-test-journey-head">
						<div class="plan-test-journey-head-title">
							<strong>Journey #{props.pathIndex + 1}</strong>
							<span class="plan-test-journey-of">of {props.paths.length}</span>
						</div>
						<button
							type="button"
							class="plan-test-add-btn"
							title="Create an editable business test case from this flowchart journey"
							onClick={() => props.onCustomize(makeDraft())}
						>
							<Icon name="add" />
							<span>Save as test</span>
						</button>
					</div>

					<Show when={sections().length > 0}>
						<div class="plan-journey-timeline" role="list" aria-label={`Steps in Journey ${props.pathIndex + 1}`}>
							<For each={sections()}>
								{(sec) => (
									<div class="plan-journey-stage">
										<Show when={sec.stage}>
											<div class="plan-journey-stage-label">{sec.stage}</div>
										</Show>
										<div class="plan-journey-rail">
											<For each={sec.items}>
												{(item) => {
													const isCurrent = () =>
														Boolean(props.defaultNodeId && (item.nodeId === props.defaultNodeId || item.targetId === props.defaultNodeId));
													return (
														<div class="plan-journey-item" classList={{ current: isCurrent(), gate: Boolean(item.isLoopGate) }} role="listitem">
															<Show when={item.context}>
																<span class="plan-journey-context">{item.context}</span>
															</Show>
															<div class="plan-journey-qrow">
																<button
																	type="button"
																	class="plan-journey-q"
																	title="Spotlight this decision on the chart (keeps current step selected)"
																	onMouseEnter={() => props.onPeekNode?.(item.nodeId, { pan: false })}
																	onMouseLeave={() => props.onPeekNode?.(null)}
																	onClick={() => props.onPeekNode?.(item.nodeId, { pan: true })}
																>
																	{item.question}
																</button>
																<span class={`plan-test-tag ${toneOf(item.answer)}`}>{item.answer}</span>
															</div>
															<Show when={item.result}>
																<button
																	type="button"
																	class="plan-journey-then"
																	title="Spotlight this step on the chart (keeps current step selected)"
																	onMouseEnter={() => props.onPeekNode?.(item.targetId, { pan: false })}
																	onMouseLeave={() => props.onPeekNode?.(null)}
																	onClick={() => props.onPeekNode?.(item.targetId, { pan: true })}
																>
																	<Icon name="arrow-right" class="plan-journey-arrow" />
																	<span>{item.result}</span>
																</button>
															</Show>
															<Show when={item.loopsBack}>
																<span class="plan-journey-loop">
																	<Icon name="sync" class="plan-journey-arrow" />
																	<span>Continues loop</span>
																</span>
															</Show>
														</div>
													);
												}}
											</For>
										</div>
									</div>
								)}
							</For>
						</div>
					</Show>

					<Show when={bd.outcome}>
						<button
							type="button"
							class="plan-journey-outcome"
							title={bd.outcomeId ? "Spotlight this end result on the chart (keeps current step selected)" : undefined}
							onMouseEnter={() => bd.outcomeId && props.onPeekNode?.(bd.outcomeId, { pan: false })}
							onMouseLeave={() => bd.outcomeId && props.onPeekNode?.(null)}
							onClick={() => bd.outcomeId && props.onPeekNode?.(bd.outcomeId, { pan: true })}
						>
							<span class="plan-test-kw expect">Result</span>
							<span class="plan-journey-outcome-text">{bd.outcome}</span>
						</button>
					</Show>
				</div>
			)}
		</Show>
	);
}

type JourneyFilter =
	| { kind: "branch"; label: string; targetId: string; pathIndices: Set<number> }
	| { kind: "outcome"; nodeId: string; text: string; pathIndices: Set<number> };

export function NodeTests(props: {
	plan: Plan;
	node: PlanNode;
	allPaths: { paths: PlanPath[]; truncated: boolean };
	activePathIndex: number | null;
	open: boolean;
	onToggle: () => void;
	onHighlightPath: (index: number | null) => void;
	onJumpToNode: (id: string) => void;
	onPeekNode?: (id: string | null, opts?: { pan?: boolean }) => void;
	onOpenTextBuilder?: (opts?: { nodeId?: string; journeyIndex?: number; testId?: string }) => void;
	onOpenScript: (script: string) => void;
	onAddTestCase: (input: PlanTestInput) => void;
	onUpdateTestCase: (id: string, patch: PlanTestPatch) => void;
	onRemoveTestCase: (id: string) => void;
	onTriggerScheduled: (scope: ScheduledBuildScope) => void;
}) {
	const [draftReq, setDraftReq] = createSignal<{ draft: TestCaseDraft; seq: number } | null>(null);
	const [journeyFilter, setJourneyFilter] = createSignal<JourneyFilter | null>(null);
	let draftSeq = 0;

	// Clear any active branch/outcome filter when switching to another step.
	createEffect(() => {
		props.node.id;
		setJourneyFilter(null);
	});

	const info = createMemo(() => pathsForNode(props.plan, props.node.id, props.allPaths));
	const ctx = createMemo(() => nodeTestContext(props.plan, props.node.id, props.allPaths));
	const stepCases = createMemo(() => planTestsOf(props.plan).filter((t) => t.node === props.node.id));
	/** Other plan test cases whose linked flowchart journey passes through this step. */
	const sharedCases = createMemo(() => {
		const hitJourneys = new Set(info().matches.map((m) => m.index));
		return planTestsOf(props.plan).filter((t) => t.node !== props.node.id && Boolean(t.journey && hitJourneys.has(t.journey)));
	});

	const testScript = createMemo(() => builtOf(props.plan)?.tests ?? null);
	const testStale = createMemo(() => {
		const t = testScript();
		return Boolean(t && t.hash !== planHash(props.plan));
	});

	const visibleMatches = createMemo(() => {
		const f = journeyFilter();
		const all = info().matches;
		return f ? all.filter((m) => f.pathIndices.has(m.pathIndex)) : all;
	});

	const summary = createMemo(() => {
		const cases = stepCases().length + sharedCases().length;
		const { matches, total, truncated } = info();
		const parts: string[] = [];
		if (cases > 0) parts.push(`${cases} ${cases === 1 ? "test" : "tests"}`);
		if (matches.length > 0) parts.push(`${matches.length} of ${total}${truncated ? "+" : ""} journeys`);
		else if (!cases) parts.push(total ? "Not on a journey" : "No journeys");
		return parts.join(" · ");
	});

	const activeMatch = createMemo(() => info().matches.find((m) => m.pathIndex === props.activePathIndex) ?? null);
	const hasContext = createMemo(() => {
		const c = ctx();
		return c.requires.length > 0 || c.branches.length > 0 || c.outcomes.length > 1 || (c.outcomes.length === 1 && c.branches.length === 0);
	});

	const toggleBranchFilter = (label: string, targetId: string, pathIndices: number[]) => {
		const cur = journeyFilter();
		if (cur?.kind === "branch" && cur.label === label && cur.targetId === targetId) {
			setJourneyFilter(null);
		} else {
			setJourneyFilter({ kind: "branch", label, targetId, pathIndices: new Set(pathIndices) });
		}
	};

	const toggleOutcomeFilter = (nodeId: string, text: string, pathIndices: number[]) => {
		const cur = journeyFilter();
		if (cur?.kind === "outcome" && cur.nodeId === nodeId) {
			setJourneyFilter(null);
		} else {
			setJourneyFilter({ kind: "outcome", nodeId, text, pathIndices: new Set(pathIndices) });
		}
	};

	const toneOf = (label: string) => {
		const lower = label.toLowerCase();
		return lower === "yes" ? "yes" : lower === "no" ? "no" : "";
	};

	return (
		<div class="plan-impl plan-tests-drawer">
			<button
				type="button"
				class="plan-impl-toggle"
				aria-expanded={props.open}
				onClick={props.onToggle}
				title="See and edit plain-English test cases for this step, and inspect every flowchart journey through it"
			>
				<Icon name={props.open ? "chevron-down" : "chevron-right"} />
				<span class="plan-impl-label">Tests</span>
				<span class="spacer" />
				<span class="plan-impl-meta" classList={{ linked: stepCases().length > 0 || sharedCases().length > 0 || info().matches.length > 0 }}>
					{summary()}
				</span>
			</button>

			<Show when={props.open}>
				<div class="plan-impl-body">
					<TestCaseList
						plan={props.plan}
						cases={stepCases()}
						paths={props.allPaths.paths}
						activePathIndex={props.activePathIndex}
						heading="Test cases for this step"
						emptyText="No custom test cases on this step yet. Click Add test or pick any journey below to add details."
						defaultNodeId={props.node.id}
						hideStepBadge
						externalDraft={draftReq()}
						onHighlightPath={props.onHighlightPath}
						onJumpToNode={props.onJumpToNode}
						onPeekNode={props.onPeekNode}
						onOpenTextBuilder={props.onOpenTextBuilder}
						onAddTestCase={props.onAddTestCase}
						onUpdateTestCase={props.onUpdateTestCase}
						onRemoveTestCase={props.onRemoveTestCase}
					/>

					<Show when={sharedCases().length > 0}>
						<TestCaseList
							plan={props.plan}
							cases={sharedCases()}
							paths={props.allPaths.paths}
							activePathIndex={props.activePathIndex}
							heading={`Also covered by other tests (${sharedCases().length})`}
							emptyText=""
							defaultNodeId={props.node.id}
							hideAddButton
							stepAction="peek"
							onHighlightPath={props.onHighlightPath}
							onJumpToNode={props.onJumpToNode}
							onPeekNode={props.onPeekNode}
							onAddTestCase={props.onAddTestCase}
							onUpdateTestCase={props.onUpdateTestCase}
							onRemoveTestCase={props.onRemoveTestCase}
						/>
					</Show>

					<Show
						when={info().matches.length > 0}
						fallback={
							<p class="plan-impl-empty">
								No flowchart journey reaches this step yet. Connect it from Start to include it in end-to-end scenarios.
							</p>
						}
					>
						<Show when={hasContext()}>
							<div class="plan-test-context" aria-label="How this step is tested">
								<Show when={ctx().requires.length > 0}>
									<div class="plan-test-context-block">
										<span class="plan-impl-subhead">Must be true to reach this step</span>
										<div class="plan-test-req-list">
											<For each={ctx().requires}>
												{(req) => (
													<button
														type="button"
														class="plan-test-req-row"
														title="Show this decision on the chart (keeps current step selected)"
														onMouseEnter={() => props.onPeekNode?.(req.nodeId, { pan: false })}
														onMouseLeave={() => props.onPeekNode?.(null)}
														onClick={() => props.onPeekNode?.(req.nodeId, { pan: true })}
													>
														<span class="plan-test-req-text">{req.text}</span>
														<span class={`plan-test-tag ${toneOf(req.label)}`}>{req.label}</span>
													</button>
												)}
											</For>
										</div>
									</div>
								</Show>

								<Show when={ctx().branchDecision && ctx().branches.length > 0}>
									<div class="plan-test-context-block">
										<div class="plan-test-head-row">
											<Show
												when={ctx().branchDecision!.isSelf}
												fallback={
													<button
														type="button"
														class="plan-test-subhead-link"
														title="Show this check on the chart (keeps current step selected)"
														onMouseEnter={() => props.onPeekNode?.(ctx().branchDecision!.nodeId, { pan: false })}
														onMouseLeave={() => props.onPeekNode?.(null)}
														onClick={() => props.onPeekNode?.(ctx().branchDecision!.nodeId, { pan: true })}
													>
														<span class="plan-impl-subhead">Next check: {ctx().branchDecision!.text}</span>
													</button>
												}
											>
												<span class="plan-impl-subhead">Branches from here</span>
											</Show>
										</div>
										<div class="plan-test-filter-list" role="group" aria-label="Filter journeys by branch">
											<For each={ctx().branches}>
												{(b) => {
													const active = () => {
														const f = journeyFilter();
														return f?.kind === "branch" && f.label === b.label && f.targetId === b.targetId;
													};
													return (
														<button
															type="button"
															class="plan-test-filter-row"
															classList={{ active: active(), empty: b.count === 0 }}
															aria-pressed={active()}
															disabled={b.count === 0}
															title={
																b.count === 0
																	? "No journeys currently take this branch"
																	: active()
																		? "Click to show all journeys through this step"
																		: `Click to filter journeys below to "${b.label}" (${b.count})`
															}
															onMouseEnter={() => props.onPeekNode?.(b.targetId, { pan: false })}
															onMouseLeave={() => props.onPeekNode?.(null)}
															onClick={() => toggleBranchFilter(b.label, b.targetId, b.pathIndices)}
														>
															<span class={`plan-test-tag ${toneOf(b.label)}`}>{b.label}</span>
															<span class="plan-test-filter-text">{b.targetText}</span>
															<span class="plan-test-filter-count">{b.count}</span>
														</button>
													);
												}}
											</For>
										</div>
									</div>
								</Show>

								<Show when={ctx().outcomes.length > 1 || (ctx().outcomes.length === 1 && ctx().branches.length === 0)}>
									<div class="plan-test-context-block">
										<span class="plan-impl-subhead">Possible end results</span>
										<div class="plan-test-filter-list" role="group" aria-label="Filter journeys by end result">
											<For each={ctx().outcomes}>
												{(o) => {
													const active = () => {
														const f = journeyFilter();
														return f?.kind === "outcome" && f.nodeId === o.nodeId;
													};
													return (
														<button
															type="button"
															class="plan-test-filter-row"
															classList={{ active: active() }}
															aria-pressed={active()}
															title={
																active()
																	? "Click to show all journeys through this step"
																	: `Click to filter journeys below to "${o.text}" (${o.count})`
															}
															onMouseEnter={() => props.onPeekNode?.(o.nodeId, { pan: false })}
															onMouseLeave={() => props.onPeekNode?.(null)}
															onClick={() => toggleOutcomeFilter(o.nodeId, o.text, o.pathIndices)}
														>
															<span class="plan-test-filter-text">{o.text}</span>
															<span class="plan-test-filter-count">{o.count}</span>
														</button>
													);
												}}
											</For>
										</div>
									</div>
								</Show>
							</div>
						</Show>

						<div class="plan-impl-group">
							<div class="plan-test-head-row">
								<span class="plan-impl-subhead">
									{journeyFilter()
										? `Matching journeys (${visibleMatches().length} of ${info().matches.length})`
										: `Flowchart journeys (${info().matches.length})`}
								</span>
								<Show when={journeyFilter()}>
									<button type="button" class="plan-test-filter-clear" onClick={() => setJourneyFilter(null)}>
										Show all
									</button>
								</Show>
							</div>
							<div class="plan-test-list">
								<For each={visibleMatches()}>
									{(m) => {
										const active = () => props.activePathIndex === m.pathIndex;
										const branchTone = () => toneOf(m.branchOut ?? "");
										return (
											<button
												type="button"
												class="plan-test-row"
												classList={{ active: active() }}
												aria-pressed={active()}
												title={`${active() ? "Click to clear chart highlight" : "Click to inspect and highlight this journey on the chart"}\n\n${m.story}`}
												onClick={() => props.onHighlightPath(active() ? null : m.pathIndex)}
											>
												<span class="plan-test-num">#{m.index}</span>
												<Show when={m.branchOut}>
													<span class={`plan-test-tag ${branchTone()}`}>{m.branchOut}</span>
												</Show>
												<span class="plan-test-summary">{m.summary}</span>
												<Icon name="eye" class="plan-test-eye" />
											</button>
										);
									}}
								</For>
							</div>
						</div>

						<Show when={activeMatch()} keyed>
							{(m) => (
								<JourneyDetailBox
									plan={props.plan}
									paths={props.allPaths.paths}
									pathIndex={m.pathIndex}
									defaultNodeId={props.node.id}
									onPeekNode={props.onPeekNode}
									onCustomize={(draft) => setDraftReq({ draft, seq: ++draftSeq })}
								/>
							)}
						</Show>
					</Show>

					<Show when={testScript()} keyed>
						{(tests) => (
							<div class="plan-impl-group">
								<span class="plan-impl-subhead">STARLIMS test script</span>
								<button
									type="button"
									class="plan-impl-script-row"
									title={`Open ${tests.script}`}
									onClick={() => props.onOpenScript(tests.script)}
								>
									<Icon name="beaker" />
									<span class="plan-impl-script-file">{baseName(tests.script)}</span>
									<Show when={testStale()}>
										<span class="spacer" />
										<span class="plan-test-stale">Out of date</span>
									</Show>
								</button>
							</div>
						)}
					</Show>

					<div class="plan-test-actions">
						<button
							type="button"
							class="plan-sched-btn"
							title="Scheduled — turn this step's journeys and business test cases into runnable STARLIMS SSL tests (see docs/AGENT-INTEGRATION.md)"
							onClick={() => props.onTriggerScheduled({ kind: "tests", label: props.node.text.trim() || "this step" })}
						>
							<Icon name="beaker" />
							<span>Generate STARLIMS tests</span>
							<span class="plan-sched-pill">Soon</span>
						</button>
					</div>
				</div>
			</Show>
		</div>
	);
}

export function PlanTests(props: {
	plan: Plan;
	allPaths?: { paths: PlanPath[]; truncated: boolean };
	activePathIndex: number | null;
	open: boolean;
	onToggle: () => void;
	onHighlightPath: (index: number | null) => void;
	onStepPath: (by: 1 | -1) => void;
	onJumpToNode: (id: string) => void;
	onPeekNode?: (id: string | null, opts?: { pan?: boolean }) => void;
	onOpenTextBuilder?: (opts?: { nodeId?: string; journeyIndex?: number; testId?: string }) => void;
	onOpenScript: (script: string) => void;
	onAddTestCase: (input: PlanTestInput) => void;
	onUpdateTestCase: (id: string, patch: PlanTestPatch) => void;
	onRemoveTestCase: (id: string) => void;
	onTriggerScheduled: (scope: ScheduledBuildScope) => void;
}) {
	const [draftReq, setDraftReq] = createSignal<{ draft: TestCaseDraft; seq: number } | null>(null);
	let draftSeq = 0;

	const pathsResult = createMemo(() => props.allPaths ?? planPaths(props.plan));
	const cases = createMemo(() => planTestsOf(props.plan));

	const testScript = createMemo(() => builtOf(props.plan)?.tests ?? null);
	const testStale = createMemo(() => {
		const t = testScript();
		return Boolean(t && t.hash !== planHash(props.plan));
	});

	const summary = createMemo(() => {
		const c = cases().length;
		const n = pathsResult().paths.length;
		const parts: string[] = [];
		if (c > 0) parts.push(`${c} ${c === 1 ? "test" : "tests"}`);
		parts.push(n ? `${n}${pathsResult().truncated ? "+" : ""} ${n === 1 ? "journey" : "journeys"}` : "No journeys");
		return parts.join(" · ");
	});

	return (
		<section class="plan-prop-section plan-impl-section plan-tests-drawer" aria-label="Plan tests">
			<button
				type="button"
				class="plan-impl-toggle"
				aria-expanded={props.open}
				onClick={props.onToggle}
				title="Add and edit business test cases, and walk through end-to-end flowchart journeys"
			>
				<Icon name={props.open ? "chevron-down" : "chevron-right"} />
				<span class="plan-impl-label">Tests</span>
				<span class="spacer" />
				<span class="plan-impl-meta" classList={{ linked: cases().length > 0 || pathsResult().paths.length > 0 }}>
					{summary()}
				</span>
			</button>

			<Show when={props.open}>
				<div class="plan-impl-body">
					<TestCaseList
						plan={props.plan}
						cases={cases()}
						paths={pathsResult().paths}
						activePathIndex={props.activePathIndex}
						heading="Business test cases"
						emptyText="No custom test cases yet. Click Add test or pick any journey below to add scenario details."
						externalDraft={draftReq()}
						onHighlightPath={props.onHighlightPath}
						onJumpToNode={props.onJumpToNode}
						onPeekNode={props.onPeekNode}
						onOpenTextBuilder={props.onOpenTextBuilder}
						onAddTestCase={props.onAddTestCase}
						onUpdateTestCase={props.onUpdateTestCase}
						onRemoveTestCase={props.onRemoveTestCase}
					/>

					<Show
						when={pathsResult().paths.length > 0}
						fallback={<p class="plan-impl-empty">Add a Start node and steps to derive end-to-end test journeys from this flowchart.</p>}
					>
						<div class="plan-impl-group">
							<span class="plan-impl-subhead">End-to-end flowchart journeys</span>
							<div class="plan-test-walk-bar" role="group" aria-label="Walk test journeys on the chart">
								<button
									type="button"
									class="plan-test-walk-step"
									title="Previous journey"
									aria-label="Previous journey"
									onClick={() => props.onStepPath(-1)}
								>
									<Icon name="chevron-left" />
								</button>
								<button
									type="button"
									class="plan-test-walk-main"
									onClick={() => props.onHighlightPath(props.activePathIndex === null ? 0 : null)}
								>
									<Icon name="beaker" />
									<span>
										{props.activePathIndex === null
											? `Walk ${pathsResult().paths.length} journeys on chart`
											: `Journey #${props.activePathIndex + 1} of ${pathsResult().paths.length}`}
									</span>
								</button>
								<button
									type="button"
									class="plan-test-walk-step"
									title="Next journey"
									aria-label="Next journey"
									onClick={() => props.onStepPath(1)}
								>
									<Icon name="chevron-right" />
								</button>
							</div>

							<div class="plan-test-list">
								<For each={pathsResult().paths}>
									{(path, idx) => {
										const active = () => props.activePathIndex === idx();
										return (
											<button
												type="button"
												class="plan-test-row"
												classList={{ active: active() }}
												aria-pressed={active()}
												title={`${active() ? "Click to clear chart highlight" : "Click to inspect and highlight this journey on the chart"}\n\n${pathStory(path)}`}
												onClick={() => props.onHighlightPath(active() ? null : idx())}
											>
												<span class="plan-test-num">#{idx() + 1}</span>
												<span class="plan-test-summary">{pathSummary(path, pathsResult().paths, props.plan)}</span>
												<Icon name="eye" class="plan-test-eye" />
											</button>
										);
									}}
								</For>
							</div>
						</div>

						<Show when={props.activePathIndex !== null && pathsResult().paths[props.activePathIndex]}>
							<JourneyDetailBox
								plan={props.plan}
								paths={pathsResult().paths}
								pathIndex={props.activePathIndex!}
								onPeekNode={props.onPeekNode}
								onCustomize={(draft) => setDraftReq({ draft, seq: ++draftSeq })}
							/>
						</Show>
					</Show>

					<Show when={testScript()} keyed>
						{(tests) => (
							<div class="plan-impl-group">
								<span class="plan-impl-subhead">STARLIMS test script</span>
								<button
									type="button"
									class="plan-impl-script-row"
									title={`Open ${tests.script}`}
									onClick={() => props.onOpenScript(tests.script)}
								>
									<Icon name="beaker" />
									<span class="plan-impl-script-file">{baseName(tests.script)}</span>
									<Show when={testStale()}>
										<span class="spacer" />
										<span class="plan-test-stale">Out of date</span>
									</Show>
								</button>
							</div>
						)}
					</Show>

					<p class="plan-test-explain">
						Turns your flowchart journeys and custom business test cases into a runnable STARLIMS SSL test file for review and execution in STARLIMS.
					</p>
					<div class="plan-test-actions">
						<button
							type="button"
							class="plan-sched-btn"
							title="Scheduled — generate a STARLIMS SSL test script from your flowchart journeys and business test cases (see docs/AGENT-INTEGRATION.md)"
							onClick={() => props.onTriggerScheduled({ kind: "tests", label: props.plan.title || "this plan" })}
						>
							<Icon name="beaker" />
							<span>Generate STARLIMS test script</span>
							<span class="plan-sched-pill">Soon</span>
						</button>
					</div>
				</div>
			</Show>
		</section>
	);
}
