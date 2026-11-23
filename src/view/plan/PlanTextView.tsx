// Readable, structured Text (list + focus + interactive test builder) projection of a Plan (`.plan.json`).
// Inspired by Call Graph's List mode: reads top-to-bottom in natural flow order,
// supports Focus (Comes from / Goes to) for any step or stage, lets analysts build
// and edit business test cases by clicking decision branches directly on the flow,
// stays live-synced with Palette (Design | Assistant), and switches smoothly to Chart or Source.
import { createEffect, createMemo, createSignal, For, Show } from "solid-js";
import { regionColor } from "../editor/regions";
import { Icon } from "../Icon";
import type { IconName } from "../icons";
import { IconButton } from "../panels/Rows";
import { docs } from "../project";
import { notify, openFile } from "../state";
import { journeyDraft, pathSummary, shortPhrase, type PlanPath } from "./built";
import { CODE_INDICATOR_WORDS, type CodeIndicator } from "./chart";
import { planTestsOf, type Plan, type PlanNode, type PlanTestCase, type PlanTestInput, type PlanTestPatch } from "./model";
import "./planExtra.css";
import {
	choicesFromPath,
	choicesFromStep,
	decisionDisplayLabel,
	matchPathsForChoices,
	planFocusAround,
	planTextOutline,
	syncChoiceInGiven,
	type PlanFocusNeighbor,
	type PlanFocusTarget,
	type PlanTextRow,
	type TestBranchChoices,
} from "./textModel";

const KIND_LABELS: Record<PlanNode["kind"], string> = {
	start: "Start",
	step: "Step",
	call: "Step",
	decision: "Decision",
	end: "End",
};

const KIND_ICONS: Record<PlanNode["kind"], IconName> = {
	start: "play",
	step: "circle-outline",
	call: "circle-outline",
	decision: "git-branch",
	end: "pass-filled",
};

export type TextTestBuilderRequest = {
	nodeId?: string;
	journeyIndex?: number;
	testId?: string;
	seq: number;
};

function fitArea(el: HTMLTextAreaElement) {
	el.style.height = "auto";
	el.style.height = `${Math.min(200, Math.max(66, el.scrollHeight + 2))}px`;
}

export function PlanTextView(props: {
	plan: Plan;
	selectedId: string | null;
	peekedId: string | null;
	allPaths: { paths: PlanPath[]; truncated: boolean };
	activePathIndex: number | null;
	onPathNodes: ReadonlySet<string> | null;
	codeStateOf: (id: string) => CodeIndicator;
	troubleOf: (id: string) => string[] | undefined;
	builderRequest?: TextTestBuilderRequest | null;
	onSelectNode: (id: string | null) => void;
	onPeekNode: (id: string | null, opts?: { pan?: boolean }) => void;
	onShowOnChart: (id?: string) => void;
	onStepPath: (by: 1 | -1) => void;
	onClearPath: () => void;
	onHighlightPath: (index: number | null) => void;
	onAddTestCase: (input: PlanTestInput) => void;
	onUpdateTestCase: (id: string, patch: PlanTestPatch) => void;
	onRemoveTestCase: (id: string) => void;
}) {
	let container!: HTMLDivElement;
	let givenEl: HTMLTextAreaElement | undefined;
	let expectEl: HTMLTextAreaElement | undefined;
	let notesEl: HTMLTextAreaElement | undefined;

	const [focus, setFocus] = createSignal<PlanFocusTarget | null>(null);

	// Interactive Test Builder state
	const [builderOpen, setBuilderOpen] = createSignal(false);
	const [editingTestId, setEditingTestId] = createSignal<string | null>(null);
	const [anchorNodeId, setAnchorNodeId] = createSignal<string | null>(null);
	const [choices, setChoices] = createSignal<TestBranchChoices>({});
	const [linkedJourney, setLinkedJourney] = createSignal<number | null>(null);
	const [title, setTitle] = createSignal("");
	const [given, setGiven] = createSignal("");
	const [expect, setExpect] = createSignal("");
	const [expectAuto, setExpectAuto] = createSignal(true);
	const [notes, setNotes] = createSignal("");
	const [notesOpen, setNotesOpen] = createSignal(false);

	const outline = createMemo(() => planTextOutline(props.plan));
	const focusView = createMemo(() => planFocusAround(props.plan, outline(), focus()));

	// Live path match against the analyst's clicked decision choices (and optional anchored step).
	const choiceMatch = createMemo(() =>
		matchPathsForChoices(props.plan, props.allPaths.paths, choices(), anchorNodeId()),
	);
	const hasActiveFilter = createMemo(() => builderOpen() && (Object.keys(choices()).length > 0 || Boolean(anchorNodeId())));

	// Clear focus if the focused step or stage was deleted from the plan.
	createEffect(() => {
		const f = focus();
		if (f && !focusView()) setFocus(null);
	});

	// Scroll smoothly to a row when selected or peeked from Find / Palette / Tests.
	const scrollToNode = (id: string) => {
		if (!container) return;
		const el = container.querySelector<HTMLElement>(`[data-plan-node="${CSS.escape(id)}"]`);
		el?.scrollIntoView({ block: "nearest", behavior: "smooth" });
	};

	createEffect(() => {
		const id = props.peekedId;
		if (id) scrollToNode(id);
	});

	const refitBoxes = () => {
		queueMicrotask(() => {
			if (givenEl) fitArea(givenEl);
			if (expectEl) fitArea(expectEl);
			if (notesEl) fitArea(notesEl);
		});
	};

	const closeBuilder = () => {
		setBuilderOpen(false);
		setEditingTestId(null);
		setAnchorNodeId(null);
		setChoices({});
		setLinkedJourney(null);
		setTitle("");
		setGiven("");
		setExpect("");
		setExpectAuto(true);
		setNotes("");
		setNotesOpen(false);
	};

	const openFreshBuilder = (opts?: { nodeId?: string; journeyIndex?: number }) => {
		setFocus(null);
		setEditingTestId(null);
		setNotes("");
		setNotesOpen(false);
		setLinkedJourney(null);

		if (opts?.journeyIndex !== undefined && props.allPaths.paths[opts.journeyIndex]) {
			const path = props.allPaths.paths[opts.journeyIndex]!;
			const draft = journeyDraft(props.plan, path, props.allPaths.paths, opts.journeyIndex, opts.nodeId);
			setAnchorNodeId(opts.nodeId ?? null);
			setChoices(choicesFromPath(props.plan, path));
			setLinkedJourney(opts.journeyIndex + 1);
			setTitle(draft.title);
			setGiven(draft.given);
			setExpect(draft.expect);
			setExpectAuto(true);
		} else if (opts?.nodeId) {
			const preChoices = choicesFromStep(opts.nodeId, props.allPaths.paths);
			const preLines = Object.entries(preChoices).map(
				([decId, ans]) => `- ${decisionDisplayLabel(outline(), decId)}: ${ans}`,
			);
			const match = matchPathsForChoices(props.plan, props.allPaths.paths, preChoices, opts.nodeId);
			setAnchorNodeId(opts.nodeId);
			setChoices(preChoices);
			setLinkedJourney(match.exactPathIndex !== null ? match.exactPathIndex + 1 : null);
			setTitle("");
			setGiven(preLines.join("\n"));
			setExpect(match.uniqueOutcome?.text.trim() ?? "");
			setExpectAuto(true);
		} else {
			setAnchorNodeId(null);
			setChoices({});
			setTitle("");
			setGiven("");
			setExpect("");
			setExpectAuto(true);
		}

		setBuilderOpen(true);
		refitBoxes();
		if (container) container.scrollTo({ top: 0, behavior: "smooth" });
	};

	const openEditTest = (tc: PlanTestCase) => {
		setFocus(null);
		setEditingTestId(tc.id);
		setAnchorNodeId(tc.node ?? null);
		const jPath = tc.journey && tc.journey >= 1 && tc.journey <= props.allPaths.paths.length ? props.allPaths.paths[tc.journey - 1] : null;
		setChoices(jPath ? choicesFromPath(props.plan, jPath) : {});
		setLinkedJourney(tc.journey ?? null);
		setTitle(tc.title);
		setGiven(tc.given ?? "");
		setExpect(tc.expect ?? "");
		setExpectAuto(!tc.expect?.trim());
		setNotes(tc.notes ?? "");
		setNotesOpen(Boolean(tc.notes?.trim()));
		setBuilderOpen(true);
		refitBoxes();
		if (container) container.scrollTo({ top: 0, behavior: "smooth" });
	};

	// React to external "Build in Text" requests triggered from Chart/Palette.
	let handledSeq = 0;
	createEffect(() => {
		const req = props.builderRequest;
		if (!req || req.seq === handledSeq) return;
		handledSeq = req.seq;
		if (req.testId) {
			const tc = planTestsOf(props.plan).find((t) => t.id === req.testId);
			if (tc) {
				openEditTest(tc);
				return;
			}
		}
		openFreshBuilder({ nodeId: req.nodeId, journeyIndex: req.journeyIndex });
	});

	const toggleBranchChoice = (decisionId: string, branchLabel: string) => {
		const cur = choices();
		const same = cur[decisionId]?.toLowerCase() === branchLabel.toLowerCase();
		const next: TestBranchChoices = { ...cur };
		const label = decisionDisplayLabel(outline(), decisionId);
		if (same) {
			delete next[decisionId];
			setGiven((g) => syncChoiceInGiven(g, label, null));
		} else {
			next[decisionId] = branchLabel;
			setGiven((g) => syncChoiceInGiven(g, label, branchLabel));
		}
		setChoices(next);
		const match = matchPathsForChoices(props.plan, props.allPaths.paths, next, anchorNodeId());
		setLinkedJourney(match.exactPathIndex !== null ? match.exactPathIndex + 1 : null);
		if (expectAuto()) {
			setExpect(match.uniqueOutcome?.text.trim() ?? "");
		}
		refitBoxes();
	};

	const clearAllChoices = () => {
		const cur = choices();
		let nextGiven = given();
		for (const decId of Object.keys(cur)) {
			nextGiven = syncChoiceInGiven(nextGiven, decisionDisplayLabel(outline(), decId), null);
		}
		setChoices({});
		setGiven(nextGiven);
		setLinkedJourney(null);
		if (expectAuto()) setExpect("");
		refitBoxes();
	};

	const applyMatchingJourney = (pathIndex: number) => {
		const path = props.allPaths.paths[pathIndex];
		if (!path) return;
		const fullChoices = choicesFromPath(props.plan, path);
		let nextGiven = given();
		for (const [decId, ans] of Object.entries(fullChoices)) {
			nextGiven = syncChoiceInGiven(nextGiven, decisionDisplayLabel(outline(), decId), ans);
		}
		setChoices(fullChoices);
		setGiven(nextGiven);
		setLinkedJourney(pathIndex + 1);
		const draft = journeyDraft(props.plan, path, props.allPaths.paths, pathIndex, anchorNodeId() ?? undefined);
		if (!title().trim()) setTitle(draft.title);
		if (expectAuto() || !expect().trim()) {
			setExpect(draft.expect);
			setExpectAuto(true);
		}
		refitBoxes();
	};

	const suggestedTitle = createMemo(() => {
		const match = choiceMatch();
		if (match.exactPathIndex !== null && props.allPaths.paths[match.exactPathIndex]) {
			return journeyDraft(props.plan, props.allPaths.paths[match.exactPathIndex]!, props.allPaths.paths, match.exactPathIndex).title;
		}
		const anchor = anchorNodeId() ? props.plan.nodes.find((n) => n.id === anchorNodeId())?.text.trim() : "";
		if (anchor) return shortPhrase(`Test: ${anchor}`, 48);
		return "e.g. Rush sample received on a holiday";
	});

	const saveBuilder = (e?: Event) => {
		e?.preventDefault();
		const finalTitle = title().trim();
		if (!finalTitle) return;
		const resolvedJourney =
			linkedJourney() ?? (choiceMatch().exactPathIndex !== null ? choiceMatch().exactPathIndex! + 1 : undefined);
		const editId = editingTestId();
		if (editId) {
			props.onUpdateTestCase(editId, {
				title: finalTitle,
				node: anchorNodeId() ?? "",
				journey: resolvedJourney ?? null,
				given: given().trim(),
				expect: expect().trim(),
				notes: notes().trim(),
			});
		} else {
			props.onAddTestCase({
				title: finalTitle,
				node: anchorNodeId() ?? undefined,
				journey: resolvedJourney,
				given: given().trim() || undefined,
				expect: expect().trim() || undefined,
				notes: notes().trim() || undefined,
			});
		}
		closeBuilder();
	};

	const toggleNodeFocus = (id: string) => {
		setBuilderOpen(false);
		setFocus((cur) => (cur?.kind === "node" && cur.id === id ? null : { kind: "node", id }));
		if (container) container.scrollTo({ top: 0, behavior: "smooth" });
	};

	const toggleStageFocus = (stageId: string) => {
		setBuilderOpen(false);
		setFocus((cur) => (cur?.kind === "stage" && cur.id === stageId ? null : { kind: "stage", id: stageId }));
		if (container) container.scrollTo({ top: 0, behavior: "smooth" });
	};

	const focusActive = (kind: "node" | "stage", id: string) => {
		const f = focus();
		return Boolean(f && f.kind === kind && f.id === id);
	};

	const toneOf = (label?: string) => {
		const lower = (label ?? "").toLowerCase();
		return lower === "yes" ? "yes" : lower === "no" ? "no" : "";
	};

	const visibleSections = createMemo(() => {
		const f = focus();
		const all = outline().sections;
		if (f?.kind === "stage") return all.filter((s) => s.stageId === f.id);
		return all;
	});

	const stats = createMemo(() => {
		const nodes = props.plan.nodes;
		const decisions = nodes.filter((n) => n.kind === "decision").length;
		const steps = nodes.filter((n) => n.kind === "step" || n.kind === "call").length;
		const stages = props.plan.groups.length;
		const tests = planTestsOf(props.plan).length;
		return { steps, decisions, stages, tests };
	});

	const ticketText = () => (typeof props.plan.ticket === "string" ? props.plan.ticket.trim() : "");
	const ticketDoc = createMemo(() => {
		const key = ticketText();
		if (!key) return null;
		return docs().find((d) => d.group === "tickets" && d.exists && d.ticket?.toLowerCase() === key.toLowerCase()) ?? null;
	});
	const goalText = () => (typeof props.plan.goal === "string" ? props.plan.goal.trim() : "");
	const anchorNodeName = () => {
		const id = anchorNodeId();
		return id ? props.plan.nodes.find((n) => n.id === id)?.text.trim() || id : "";
	};

	const activeJourneySummary = createMemo(() => {
		const idx = props.activePathIndex;
		if (idx === null) return "";
		const p = props.allPaths.paths[idx];
		return p ? pathSummary(p, props.allPaths.paths, props.plan) : "";
	});

	const NeighborItem = (p: { item: PlanFocusNeighbor }) => (
		<li class="plan-text-neighbor">
			<div class="plan-text-neighbor-main">
				<Show when={p.item.label}>
					<span class={`plan-test-tag ${toneOf(p.item.label)}`}>{p.item.label}</span>
				</Show>
				<Show when={p.item.loopsBack}>
					<span class="plan-text-loop-tag" title="Loops back to an earlier step">
						<Icon name="sync" />
						<span>Loop</span>
					</span>
				</Show>
				<button
					type="button"
					class="link plan-text-neighbor-link"
					title="Select this step in Palette"
					onClick={() => {
						props.onSelectNode(p.item.node.id);
						scrollToNode(p.item.node.id);
					}}
				>
					{p.item.node.text.trim() || p.item.node.id}
				</button>
				<Show when={p.item.stageName}>
					<span class="plan-text-neighbor-stage">in {p.item.stageName}</span>
				</Show>
			</div>
			<button
				type="button"
				class="graph-list-focus plan-text-neighbor-focus"
				title={`Focus on "${p.item.node.text.trim() || p.item.node.id}"`}
				onClick={() => toggleNodeFocus(p.item.node.id)}
			>
				Focus
			</button>
		</li>
	);

	const StepRow = (p: { row: PlanTextRow }) => {
		const nid = p.row.node.id;
		const isSelected = () => props.selectedId === nid;
		const isPeeked = () => props.peekedId === nid && !isSelected();
		const isFocused = () => focusActive("node", nid);
		const isAnchor = () => builderOpen() && anchorNodeId() === nid;
		const chosenBranch = () => choices()[nid];
		const ruledOut = () =>
			hasActiveFilter() &&
			choiceMatch().matchingPathIndices.length > 0 &&
			!choiceMatch().reachableNodeIds.has(nid) &&
			!chosenBranch() &&
			!isAnchor();
		const onJourney = () => Boolean(props.onPathNodes?.has(nid));
		const dimmed = () => Boolean(props.onPathNodes && !props.onPathNodes.has(nid)) || ruledOut();
		const actionable = p.row.node.kind !== "start" && p.row.node.kind !== "end";
		const isDecision = p.row.node.kind === "decision";
		const codeState = () => props.codeStateOf(nid);
		const trouble = () => props.troubleOf(nid);

		return (
			<li
				class={`plan-text-row kind-${p.row.node.kind === "call" ? "step" : p.row.node.kind}`}
				classList={{
					selected: isSelected(),
					peeked: isPeeked(),
					focused: isFocused(),
					anchored: isAnchor(),
					decided: builderOpen() && Boolean(chosenBranch()),
					"on-path": onJourney() || (hasActiveFilter() && choiceMatch().reachableNodeIds.has(nid)),
					"off-path": dimmed(),
					trouble: Boolean(trouble()?.length),
				}}
				data-plan-node={nid}
				onClick={(e) => {
					if ((e.target as HTMLElement).closest("button")) return;
					props.onSelectNode(nid);
				}}
			>
				<div class="plan-text-row-gutter">
					<span class="plan-text-num">{p.row.index + 1}</span>
					<Show when={actionable}>
						<span
							class={`plan-status-dot ${codeState()}`}
							title={`Code status: ${CODE_INDICATOR_WORDS[codeState()].label} — ${CODE_INDICATOR_WORDS[codeState()].detail}`}
							aria-label={`Code status: ${CODE_INDICATOR_WORDS[codeState()].label}`}
						/>
					</Show>
				</div>

				<div class="plan-text-row-body">
					<div class="plan-text-row-head">
						<Icon name={KIND_ICONS[p.row.node.kind]} class={`plan-text-kind-icon is-${p.row.node.kind === "call" ? "step" : p.row.node.kind}`} />
						<button
							type="button"
							class="plan-text-row-title"
							aria-current={isSelected() ? "true" : undefined}
							onClick={() => props.onSelectNode(nid)}
						>
							{p.row.node.text.trim() || "(no words yet)"}
						</button>
						<Show when={isAnchor()}>
							<span class="plan-text-anchor-pill">Testing step</span>
						</Show>
						<Show when={trouble()?.length}>
							<span class="plan-text-warn" title={trouble()!.join("\n")}>
								<Icon name="warning" />
							</span>
						</Show>
						<span class="spacer" />
						<Show when={actionable && !builderOpen()}>
							<button
								type="button"
								class="graph-list-focus plan-text-row-focus"
								title={`Build a test case for "${p.row.node.text.trim() || nid}"`}
								onClick={(e) => {
									e.stopPropagation();
									openFreshBuilder({ nodeId: nid });
								}}
							>
								Test
							</button>
						</Show>
						<button
							type="button"
							class="graph-list-focus plan-text-row-focus"
							aria-pressed={isFocused()}
							title={isFocused() ? "Clear focus" : `Show what leads into and out of "${p.row.node.text.trim() || nid}"`}
							onClick={(e) => {
								e.stopPropagation();
								toggleNodeFocus(nid);
							}}
						>
							{isFocused() ? "Focused" : "Focus"}
						</button>
					</div>

					<Show when={p.row.node.notes?.trim()}>
						<p class="plan-text-row-notes">{p.row.node.notes}</p>
					</Show>

					<Show when={p.row.links.length > 0}>
						<ul class="plan-text-links" aria-label={`Next from ${p.row.node.text.trim() || nid}`}>
							<For each={p.row.links}>
								{(link) => {
									const canPick = () => builderOpen() && isDecision && Boolean(link.label);
									const isPicked = () =>
										Boolean(link.label && chosenBranch()?.toLowerCase() === link.label.toLowerCase());
									const otherPicked = () => Boolean(chosenBranch() && !isPicked());
									return (
										<li class="plan-text-link-row" classList={{ "branch-other": canPick() && otherPicked() }}>
											<Show
												when={canPick()}
												fallback={
													<>
														<Show
															when={link.label}
															fallback={
																<Icon
																	name={link.loopsBack ? "sync" : "arrow-right"}
																	class="plan-text-link-icon"
																/>
															}
														>
															<span class={`plan-test-tag ${toneOf(link.label)}`}>{link.label}</span>
														</Show>
														<Show when={link.loopsBack}>
															<span class="plan-text-loop-note">Loops back to</span>
														</Show>
														<button
															type="button"
															class="link plan-text-link-target"
															title={`Scroll to "${link.target.text.trim() || link.target.id}"`}
															onClick={(e) => {
																e.stopPropagation();
																props.onPeekNode(link.target.id, { pan: true });
																scrollToNode(link.target.id);
															}}
														>
															{link.target.text.trim() || link.target.id}
														</button>
														<Show when={link.targetStage && link.targetStage !== p.row.stageName}>
															<span class="plan-text-link-stage">in {link.targetStage}</span>
														</Show>
													</>
												}
											>
												<button
													type="button"
													class={`plan-text-branch-pick ${toneOf(link.label)}`}
													classList={{ picked: isPicked(), other: otherPicked() }}
													aria-pressed={isPicked()}
													title={
														isPicked()
															? `Click to un-pick "${link.label}" from your test scenario`
															: `Click to choose "${link.label}" for your test scenario`
													}
													onClick={(e) => {
														e.stopPropagation();
														toggleBranchChoice(nid, link.label!);
													}}
												>
													<span class="plan-text-pick-mark" aria-hidden="true">
														<Icon name={isPicked() ? "check" : "circle-outline"} />
													</span>
													<span class={`plan-test-tag ${toneOf(link.label)}`}>{link.label}</span>
													<Show when={link.loopsBack}>
														<span class="plan-text-loop-note">Loops back to</span>
													</Show>
													<span class="plan-text-pick-target">{link.target.text.trim() || link.target.id}</span>
													<Show when={link.targetStage && link.targetStage !== p.row.stageName}>
														<span class="plan-text-link-stage">in {link.targetStage}</span>
													</Show>
												</button>
											</Show>
										</li>
									);
								}}
							</For>
						</ul>
					</Show>
				</div>
			</li>
		);
	};

	const chosenEntries = createMemo(() =>
		Object.entries(choices()).map(([decId, answer]) => ({
			nodeId: decId,
			label: decisionDisplayLabel(outline(), decId),
			answer,
		})),
	);

	return (
		<div
			class="plan-text-view"
			classList={{ "building-test": builderOpen() }}
			ref={container}
			tabIndex={0}
			aria-label={`${props.plan.title || "Plan"}, text outline`}
			onClick={(e) => {
				if (e.target === e.currentTarget || (e.target as HTMLElement).classList.contains("plan-text-col")) {
					props.onSelectNode(null);
				}
			}}
		>
			<div class="plan-text-col">
				<Show when={props.activePathIndex !== null && props.allPaths.paths[props.activePathIndex]}>
					<div class="plan-text-journey-bar" role="status">
						<Icon name="beaker" class="plan-text-journey-icon" />
						<span class="plan-text-journey-label">
							<strong>
								Journey #{props.activePathIndex! + 1} of {props.allPaths.paths.length}
							</strong>
							<Show when={activeJourneySummary()}>
								<span class="plan-text-journey-summary">{activeJourneySummary()}</span>
							</Show>
						</span>
						<button
							type="button"
							class="plan-test-add-btn"
							title="Open the interactive test builder pre-filled from this journey"
							onClick={() => openFreshBuilder({ journeyIndex: props.activePathIndex! })}
						>
							<Icon name="add" />
							<span>Build test</span>
						</button>
						<div class="plan-text-journey-nav">
							<button type="button" title="Previous journey" aria-label="Previous journey" onClick={() => props.onStepPath(-1)}>
								<Icon name="chevron-left" />
							</button>
							<button type="button" title="Next journey" aria-label="Next journey" onClick={() => props.onStepPath(1)}>
								<Icon name="chevron-right" />
							</button>
							<button type="button" title="Hide journey highlight" aria-label="Hide journey highlight" onClick={props.onClearPath}>
								<Icon name="close" />
							</button>
						</div>
					</div>
				</Show>

				<header class="plan-text-header">
					<div class="plan-text-title-row">
						<h1>{props.plan.title || "Untitled plan"}</h1>
						<Show when={ticketText()}>
							<button
								type="button"
								class="plan-text-ticket"
								classList={{ linked: Boolean(ticketDoc()) }}
								title={
									ticketDoc()
										? `Open ticket ${ticketDoc()!.ticket}${ticketDoc()!.title ? `: ${ticketDoc()!.title}` : ""}`
										: `Ticket ${ticketText()} (not found in docs/tickets/)`
								}
								onClick={(e) => {
									e.stopPropagation();
									const td = ticketDoc();
									if (td) void openFile(td.path);
									else notify(`Ticket ${ticketText()} was not found in docs/tickets/.`);
								}}
							>
								{ticketText()}
							</button>
						</Show>
						<span class="spacer" />
						<Show
							when={!builderOpen()}
							fallback={
								<button type="button" class="plan-text-around-btn" onClick={closeBuilder}>
									Close test builder
								</button>
							}
						>
							<button
								type="button"
								class="plan-text-build-btn"
								title="Walk through the process and click decision branches to build a plain-English business test case"
								onClick={() => openFreshBuilder(props.selectedId ? { nodeId: props.selectedId } : undefined)}
							>
								<Icon name="beaker" />
								<span>Build a test</span>
							</button>
						</Show>
					</div>
					<Show when={goalText()}>
						<p class="plan-text-goal">{goalText()}</p>
					</Show>
					<div class="plan-text-meta">
						<span>{stats().steps} {stats().steps === 1 ? "step" : "steps"}</span>
						<span>{stats().decisions} {stats().decisions === 1 ? "decision" : "decisions"}</span>
						<Show when={stats().stages > 0}>
							<span>{stats().stages} {stats().stages === 1 ? "stage" : "stages"}</span>
						</Show>
						<Show when={stats().tests > 0}>
							<span>{stats().tests} {stats().tests === 1 ? "test case" : "test cases"}</span>
						</Show>
					</div>
					<p class="hint plan-text-hint">
						{builderOpen()
							? "Click any yes / no decision branch below to trace the scenario you want to test — Given, Expect, and the matching journey update live."
							: focusView()
								? "Focused view: what leads in and where it goes. Click any step to inspect it in Palette, or Focus to move the focus there."
								: "The process in flow order. Click Build a test to trace scenarios directly on the outline, or click Focus on any step or stage."}
					</p>
				</header>

				{/* Interactive Test Builder workspace (full reading width) */}
				<Show when={builderOpen()}>
					<form class="plan-text-builder" onSubmit={saveBuilder} aria-label={editingTestId() ? "Edit test case" : "Build a test case"}>
						<div class="plan-text-builder-head">
							<div class="plan-text-builder-title">
								<Icon name="beaker" class="plan-text-journey-icon" />
								<h2>{editingTestId() ? "Edit test case" : "Build a test case"}</h2>
								<Show when={anchorNodeId()}>
									<span class="plan-text-anchor-chip">
										<span>Step: {shortPhrase(anchorNodeName(), 28)}</span>
										<button
											type="button"
											title="Switch from this step to whole plan"
											aria-label="Detach step anchor"
											onClick={() => setAnchorNodeId(null)}
										>
											<Icon name="close" />
										</button>
									</span>
								</Show>
							</div>
							<div class="plan-text-builder-match">
								<Show
									when={choiceMatch().matchingPathIndices.length > 0}
									fallback={
										<Show when={Object.keys(choices()).length > 0}>
											<span class="plan-text-match-pill warn">
												<Icon name="warning" />
												<span>No path matches these choices</span>
											</span>
										</Show>
									}
								>
									<Show
										when={choiceMatch().exactPathIndex !== null}
										fallback={
											<Show when={Object.keys(choices()).length > 0 || anchorNodeId()}>
												<span class="plan-text-match-pill">
													Matches {choiceMatch().matchingPathIndices.length}{" "}
													{choiceMatch().matchingPathIndices.length === 1 ? "journey" : "journeys"}
												</span>
												<button
													type="button"
													class="plan-text-around-btn"
													title={`Fill remaining decisions from Journey #${choiceMatch().matchingPathIndices[0]! + 1}`}
													onClick={() => applyMatchingJourney(choiceMatch().matchingPathIndices[0]!)}
												>
													Fill from #{choiceMatch().matchingPathIndices[0]! + 1}
												</button>
											</Show>
										}
									>
										<button
											type="button"
											class="plan-text-match-pill exact"
											title="Highlight this matched journey on the outline and chart"
											onClick={() => props.onHighlightPath(choiceMatch().exactPathIndex!)}
										>
											<Icon name="check" />
											<span>Matches Journey #{choiceMatch().exactPathIndex! + 1}</span>
										</button>
									</Show>
								</Show>
								<IconButton label="Close test builder" title="Cancel" icon="close" onClick={closeBuilder} />
							</div>
						</div>

						<div class="plan-text-builder-name-row">
							<label class="plan-test-form-field">
								<span class="plan-test-field-label">Test name</span>
								<input
									class="plan-test-title-input"
									value={title()}
									placeholder={suggestedTitle()}
									onInput={(e) => setTitle(e.currentTarget.value)}
									ref={(el) => queueMicrotask(() => el.focus())}
								/>
							</label>
						</div>

						<Show when={chosenEntries().length > 0}>
							<div class="plan-text-choice-strip" aria-label="Selected decision choices">
								<span class="plan-text-choice-strip-label">Chosen branches</span>
								<div class="plan-text-choice-chips">
									<For each={chosenEntries()}>
										{(entry) => (
											<span class="plan-text-choice-chip">
												<button
													type="button"
													class="plan-text-choice-chip-go"
													title="Scroll to this decision"
													onClick={() => {
														props.onPeekNode(entry.nodeId, { pan: true });
														scrollToNode(entry.nodeId);
													}}
												>
													<span>{shortPhrase(entry.label, 34)}</span>
													<span class={`plan-test-tag ${toneOf(entry.answer)}`}>{entry.answer}</span>
												</button>
												<button
													type="button"
													class="plan-text-choice-chip-x"
													title={`Remove "${entry.label}" choice`}
													aria-label={`Remove ${entry.label}`}
													onClick={() => toggleBranchChoice(entry.nodeId, entry.answer)}
												>
													<Icon name="close" />
												</button>
											</span>
										)}
									</For>
									<button type="button" class="plan-test-filter-clear" onClick={clearAllChoices}>
										Clear
									</button>
								</div>
							</div>
						</Show>

						<div class="plan-text-builder-cols">
							<label class="plan-test-spec-block">
								<span class="plan-test-kw-row">
									<span class="plan-test-kw given">Given</span>
									<span class="plan-test-kw-hint">Starting conditions</span>
								</span>
								<textarea
									rows={3}
									value={given()}
									placeholder="Click yes / no on decisions below, or type business setup (e.g. Rush sample received Friday 4pm)"
									ref={(el) => {
										givenEl = el;
										queueMicrotask(() => fitArea(el));
									}}
									onInput={(e) => {
										setGiven(e.currentTarget.value);
										fitArea(e.currentTarget);
									}}
								/>
							</label>

							<label class="plan-test-spec-block">
								<span class="plan-test-kw-row">
									<span class="plan-test-kw expect">Expect</span>
									<span class="plan-test-kw-hint">Expected outcome</span>
								</span>
								<textarea
									rows={3}
									value={expect()}
									placeholder="What should happen (auto-fills once your choices narrow to one outcome)"
									ref={(el) => {
										expectEl = el;
										queueMicrotask(() => fitArea(el));
									}}
									onInput={(e) => {
										setExpect(e.currentTarget.value);
										setExpectAuto(e.currentTarget.value.trim().length === 0);
										fitArea(e.currentTarget);
									}}
								/>
							</label>
						</div>

						<Show
							when={notesOpen()}
							fallback={
								<button type="button" class="plan-test-notes-toggle" onClick={() => setNotesOpen(true)}>
									<Icon name="add" />
									<span>Add sample data or notes (optional)</span>
								</button>
							}
						>
							<label class="plan-test-spec-block">
								<span class="plan-test-kw-row">
									<span class="plan-test-kw notes">Notes</span>
									<span class="plan-test-kw-hint">Sample IDs, outages, or STARLIMS verification notes</span>
								</span>
								<textarea
									rows={2}
									value={notes()}
									placeholder="Sample IDs, instrument outages, edge-case rules, or STARLIMS check notes"
									ref={(el) => {
										notesEl = el;
										queueMicrotask(() => fitArea(el));
									}}
									onInput={(e) => {
										setNotes(e.currentTarget.value);
										fitArea(e.currentTarget);
									}}
								/>
							</label>
						</Show>

						<div class="plan-test-form-actions">
							<button type="submit" class="primary" disabled={!title().trim()}>
								{editingTestId() ? "Save changes" : "Save test"}
							</button>
							<button type="button" onClick={closeBuilder}>
								Cancel
							</button>
							<Show when={editingTestId()}>
								<span class="spacer" />
								<button
									type="button"
									class="plan-test-delete-btn"
									onClick={() => {
										const id = editingTestId();
										if (id) props.onRemoveTestCase(id);
										closeBuilder();
									}}
								>
									Delete
								</button>
							</Show>
						</div>
					</form>
				</Show>

				<Show when={!builderOpen() && focusView()} keyed>
					{(fv) => (
						<section class="plan-text-around" aria-label="Focused flow neighborhood">
							<Show
								when={fv.kind === "node"}
								fallback={
									(() => {
										const sf = fv as Extract<typeof fv, { kind: "stage" }>;
										return (
											<>
												<div class="plan-text-around-head">
													<span class="plan-stage-dot" style={{ background: regionColor(sf.stageName) }} aria-hidden="true" />
													<h2>{sf.stageName}</h2>
													<span class="plan-text-around-badge">Stage · {sf.nodes.length} {sf.nodes.length === 1 ? "step" : "steps"}</span>
													<span class="spacer" />
													<button type="button" class="plan-text-around-btn" onClick={() => setFocus(null)}>
														Show all stages
													</button>
												</div>
												<div class="plan-text-around-cols">
													<section>
														<h3>
															Entered from <span class="count">{sf.enteredFrom.length}</span>
														</h3>
														<Show when={sf.enteredFrom.length} fallback={<p class="hint">Nothing outside this stage leads into it.</p>}>
															<ul>
																<For each={sf.enteredFrom}>{(item) => <NeighborItem item={item} />}</For>
															</ul>
														</Show>
													</section>
													<section>
														<h3>
															Leaves to <span class="count">{sf.leavesTo.length}</span>
														</h3>
														<Show when={sf.leavesTo.length} fallback={<p class="hint">Nothing leaves this stage.</p>}>
															<ul>
																<For each={sf.leavesTo}>{(item) => <NeighborItem item={item} />}</For>
															</ul>
														</Show>
													</section>
												</div>
											</>
										);
									})()
								}
							>
								{(() => {
									const nf = fv as Extract<typeof fv, { kind: "node" }>;
									return (
										<>
											<div class="plan-text-around-head">
												<Icon name={KIND_ICONS[nf.node.kind]} class={`plan-text-kind-icon is-${nf.node.kind === "call" ? "step" : nf.node.kind}`} />
												<h2>{nf.node.text.trim() || nf.node.id}</h2>
												<span class="plan-text-around-badge">{KIND_LABELS[nf.node.kind]}</span>
												<Show when={nf.stageName}>
													<span class="plan-text-around-stage">
														<span class="plan-stage-dot" style={{ background: regionColor(nf.stageName!) }} aria-hidden="true" />
														<span>{nf.stageName}</span>
													</span>
												</Show>
												<span class="spacer" />
												<Show when={nf.node.kind !== "start" && nf.node.kind !== "end"}>
													<button
														type="button"
														class="plan-text-around-btn"
														title="Build a test case for this step"
														onClick={() => openFreshBuilder({ nodeId: nf.node.id })}
													>
														Build test
													</button>
												</Show>
												<button
													type="button"
													class="plan-text-around-btn"
													title="Switch to Chart view centered on this step"
													onClick={() => props.onShowOnChart(nf.node.id)}
												>
													Show on chart
												</button>
												<button type="button" class="plan-text-around-btn" onClick={() => setFocus(null)}>
													Clear focus
												</button>
											</div>
											<Show when={nf.node.notes?.trim()}>
												<p class="plan-text-around-notes">{nf.node.notes}</p>
											</Show>
											<div class="plan-text-around-cols">
												<section>
													<h3>
														Comes from <span class="count">{nf.incoming.length}</span>
													</h3>
													<Show when={nf.incoming.length} fallback={<p class="hint">Nothing leads into this step.</p>}>
														<ul>
															<For each={nf.incoming}>{(item) => <NeighborItem item={item} />}</For>
														</ul>
													</Show>
												</section>
												<section>
													<h3>
														Goes to <span class="count">{nf.outgoing.length}</span>
													</h3>
													<Show when={nf.outgoing.length} fallback={<p class="hint">The process ends here.</p>}>
														<ul>
															<For each={nf.outgoing}>{(item) => <NeighborItem item={item} />}</For>
														</ul>
													</Show>
												</section>
											</div>
										</>
									);
								})()}
							</Show>
						</section>
					)}
				</Show>

				<div class="plan-text-outline">
					<Show
						when={visibleSections().length > 0}
						fallback={<p class="hint">This plan has no steps yet. Use Palette to add steps, decisions, or stages.</p>}
					>
						<For each={visibleSections()}>
							{(section) => (
								<section
									class="plan-text-section"
									classList={{
										staged: Boolean(section.stageId),
										unreachable: Boolean(section.unreachable),
									}}
								>
									<Show when={section.heading}>
										<div class="plan-text-section-head">
											<Show when={section.stageId}>
												<span class="plan-stage-dot" style={{ background: regionColor(section.heading!) }} aria-hidden="true" />
											</Show>
											<Show when={section.unreachable}>
												<Icon name="warning" class="plan-text-warn-icon" />
											</Show>
											<h3>{section.heading}</h3>
											<span class="plan-text-section-count">
												{section.rows.length} {section.rows.length === 1 ? "step" : "steps"}
											</span>
											<Show when={section.stageId && !builderOpen()}>
												<button
													type="button"
													class="graph-list-focus"
													aria-pressed={focusActive("stage", section.stageId!)}
													title={
														focusActive("stage", section.stageId!)
															? "Show all stages"
															: `Focus on the "${section.heading}" stage`
													}
													onClick={() => toggleStageFocus(section.stageId!)}
												>
													{focusActive("stage", section.stageId!) ? "Focused" : "Focus"}
												</button>
											</Show>
										</div>
									</Show>
									<ol class="plan-text-list">
										<For each={section.rows}>{(row) => <StepRow row={row} />}</For>
									</ol>
								</section>
							)}
						</For>
					</Show>
				</div>

				<section class="plan-text-tests" aria-label="Business test cases">
					<div class="plan-text-section-head">
						<Icon name="beaker" />
						<h3>Business test cases</h3>
						<span class="plan-text-section-count">{planTestsOf(props.plan).length}</span>
						<span class="spacer" />
						<Show when={!builderOpen()}>
							<button type="button" class="plan-test-add-btn" onClick={() => openFreshBuilder()}>
								<Icon name="add" />
								<span>Build a test</span>
							</button>
						</Show>
					</div>
					<Show
						when={planTestsOf(props.plan).length > 0}
						fallback={
							<p class="hint">
								No business test cases yet. Click Build a test above to trace branches directly on the outline and save your first scenario.
							</p>
						}
					>
						<ul class="plan-text-test-cards">
							<For each={planTestsOf(props.plan)}>
								{(tc) => {
									const stepName = () => (tc.node ? props.plan.nodes.find((n) => n.id === tc.node)?.text.trim() : undefined);
									const jIdx = () => (tc.journey && tc.journey >= 1 && tc.journey <= props.allPaths.paths.length ? tc.journey - 1 : null);
									return (
										<li class="plan-text-test-card" classList={{ editing: editingTestId() === tc.id }}>
											<div class="plan-text-test-head">
												<strong>{tc.title}</strong>
												<div class="plan-text-test-badges">
													<Show when={stepName() && tc.node}>
														<button
															type="button"
															class="plan-test-case-step"
															onClick={() => {
																props.onSelectNode(tc.node!);
																scrollToNode(tc.node!);
															}}
														>
															<Icon name="play" />
															<span>{stepName()}</span>
														</button>
													</Show>
													<Show when={jIdx() !== null}>
														<button
															type="button"
															class="plan-test-case-step journey"
															classList={{ active: props.activePathIndex === jIdx() }}
															onClick={() => props.onHighlightPath(props.activePathIndex === jIdx() ? null : jIdx())}
														>
															<Icon name="eye" />
															<span>Journey #{tc.journey}</span>
														</button>
													</Show>
													<button
														type="button"
														class="plan-test-edit-btn"
														onClick={() => openEditTest(tc)}
													>
														<Icon name="note" />
														<span>Edit</span>
													</button>
													<button
														type="button"
														class="plan-test-delete-btn"
														onClick={() => props.onRemoveTestCase(tc.id)}
													>
														Delete
													</button>
												</div>
											</div>
											<Show when={tc.given}>
												<div class="plan-text-test-line">
													<span class="plan-test-kw given">Given</span>
													<p>{tc.given}</p>
												</div>
											</Show>
											<Show when={tc.expect}>
												<div class="plan-text-test-line">
													<span class="plan-test-kw expect">Expect</span>
													<p>{tc.expect}</p>
												</div>
											</Show>
											<Show when={tc.notes}>
												<div class="plan-text-test-line">
													<span class="plan-test-kw notes">Notes</span>
													<p>{tc.notes}</p>
												</div>
											</Show>
										</li>
									);
								}}
							</For>
						</ul>
					</Show>
				</section>
			</div>
		</div>
	);
}
