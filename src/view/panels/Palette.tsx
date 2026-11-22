// Templates from the style profile, inserted at the cursor as snippets, and
// the snippets the project keeps in its knowledge base (ADR 0012), inserted
// as they are written. When a plan chart is open, Palette switches cleanly to
// business-analyst process shapes and stage navigation (ADR 0027).
import { createEffect, createSignal, For, onCleanup, Show } from "solid-js";
import { snippetAsText, TEMPLATES, type Template } from "../../shared/houseStyle";
import { isCatalog } from "../../shared/projectDocs";
import type { DocFile } from "../../shared/protocol";
import { backend } from "../backend";
import { activeEditor } from "../editor/EditorGroup";
import { activeLiveEditor } from "../editor/liveBridge";
import { regionColor } from "../editor/regions";
import { Icon, type IconName } from "../Icon";
import { activeGraphBridge } from "../graph/graphBridge";
import { recall, remember } from "../graph/canvas";
import { openQuestions } from "../plan/assist";
import { SHAPE_DRAG, type NodeKind, type Plan } from "../plan/model";
import { PlanAssistant } from "../plan/PlanAssistant";
import { NodeImplementation, PlanImplementation } from "../plan/PlanCodeDrilldown";
import { activePlanBridge } from "../plan/planBridge";
import { assistOf } from "../plan/run";
import { docs } from "../project";
import { activePath, notify, openFile, state } from "../state";
import { IconButton, Row, RowGroup, Rows } from "./Rows";
import { SectionSplitter } from "./SectionSplitter";

export function insertTemplate(template: Template) {
	const live = activeLiveEditor();
	if (live) {
		live.insertText(snippetAsText(template.body()));
		return;
	}
	const editor = activeEditor();
	if (!editor?.getModel()) return notify("Open a file to insert a template.");
	editor.focus();
	const snippets = editor.getContribution("snippetController2") as unknown as { insert(text: string): void } | null;
	const position = editor.getPosition()!;
	const line = editor.getModel()!.getLineContent(position.lineNumber);
	// Templates start a line of their own.
	const body = template.body();
	snippets?.insert(line.trim() && position.column > 1 ? `\n${body}` : body);
}

/** What is shown under the list: a template, or a snippet the project keeps, with what it would insert. */
type Shown = { label: string; note?: string; text: string; path?: string };

/** The project's kept snippets: SQL and SSL in the knowledge base. */
export const keptSnippets = (): DocFile[] => docs().filter((d) => d.exists && d.group === "knowledge" && d.kind === "snippets" && !isCatalog(d));

const snippetText = (file: DocFile) => backend.read(file.path).then((f) => f.text);

/** Puts a kept snippet at the cursor, as it is written: a `$` in a query is a `$`, not a field to fill. */
export async function insertSnippet(file: DocFile) {
	const live = activeLiveEditor();
	const editor = activeEditor();
	const model = editor?.getModel();
	if (!live && (!editor || !model)) return notify("Open a file to insert a snippet into. Its row's title says where it is kept.");
	let text: string;
	try {
		text = await snippetText(file);
	} catch (e: any) {
		return notify(`The snippet could not be read: ${e?.message ?? e}`, "error");
	}
	if (live) {
		live.insertText(text.replace(/\r\n/g, "\n"));
		return;
	}
	const position = editor!.getPosition() ?? model!.getFullModelRange().getEndPosition();
	const selection = editor!.getSelection();
	const range = selection && !selection.isEmpty() ? selection : { startLineNumber: position.lineNumber, startColumn: position.column, endLineNumber: position.lineNumber, endColumn: position.column };
	// A snippet starts a line of its own, as a template does.
	const ownLine = model!.getLineContent(range.startLineNumber).slice(0, range.startColumn - 1).trim() ? "\n" : "";
	editor!.pushUndoStop();
	editor!.executeEdits("snippet", [{ range, text: `${ownLine}${text.replace(/\r\n/g, "\n")}`, forceMoveMarkers: true }]);
	editor!.pushUndoStop();
	editor!.focus();
}

type PlanShapeItem = {
	id: string;
	label: string;
	detail: string;
	icon: IconName;
	about: string;
	dragKind?: string;
	run: (plan: NonNullable<ReturnType<typeof activePlanBridge>>) => void;
	active?: (plan: NonNullable<ReturnType<typeof activePlanBridge>>) => boolean;
};

const PLAN_SHAPES: readonly PlanShapeItem[] = [
	{
		id: "plan-step",
		label: "Step",
		detail: "Action",
		icon: "play",
		dragKind: "step",
		about: "Click to add after the selected step, or drag onto any node or wire on the chart.",
		run: (p) => p.addStep(),
	},
	{
		id: "plan-decision",
		label: "Decision",
		detail: "Yes / no",
		icon: "git-branch",
		dragKind: "decision",
		about: "Adds a yes/no decision diamond to split the process by a rule. Drag onto any node or wire.",
		run: (p) => p.addDecision(),
	},
	{
		id: "plan-branch",
		label: "Branch",
		detail: "New path",
		icon: "arrow-right",
		dragKind: "branch",
		about: "Adds another outgoing path from the selected step or decision. Drag onto any node.",
		run: (p) => p.addBranch(),
	},
	{
		id: "plan-stage",
		label: "Stage",
		detail: "Phase",
		icon: "layers",
		about: "Groups the selected step into a named stage phase on the chart.",
		run: (p) => p.addStageGroup(),
	},
	{
		id: "plan-connect",
		label: "Connect steps",
		detail: "Draw arrow",
		icon: "symbol-event",
		about: "Links the selected step to another step on the chart, or drag from any node's '+' port.",
		run: (p) => p.toggleConnect(),
		active: (p) => p.linking(),
	},
];

export function Palette() {
	const groups = () => [...new Set(TEMPLATES.map((t) => t.group))];
	const graphBridge = () => (state.centerView === "graph" ? activeGraphBridge() : null);
	const planBridge = () => {
		if (state.centerView !== "editors") return null;
		const path = activePath();
		const bridge = activePlanBridge();
		return bridge && path && bridge.path === path && !state.planText[path] ? bridge : null;
	};
	const savedPreviewH = Number(recall("palette.preview.h"));
	const [previewH, setPreviewH] = createSignal(Number.isFinite(savedPreviewH) && savedPreviewH >= 80 ? savedPreviewH : 190);
	const resizePreview = (delta: number) => {
		const next = Math.max(80, Math.min(440, previewH() - delta));
		setPreviewH(next);
		remember("palette.preview.h", String(Math.round(next)));
	};
	const resetPreview = () => {
		setPreviewH(190);
		remember("palette.preview.h", "190");
	};
	/** The template, snippet, or process shape the keyboard or pointer is on. */
	const [shown, setShown] = createSignal<Shown | null>(null);
	const [planNote, setPlanNote] = createSignal<string>("");
	const [shapesScrolled, setShapesScrolled] = createSignal(false);
	const [planShapesCollapsed, setPlanShapesCollapsed] = createSignal(false);
	const [selectedShapesExpanded, setSelectedShapesExpanded] = createSignal(false);
	const [nodeImplOpen, setNodeImplOpen] = createSignal(false);
	const [planImplOpen, setPlanImplOpen] = createSignal(false);
	const [planTab, setPlanTab] = createSignal<"design" | "assistant">("design");
	const commitOnEnter = (e: KeyboardEvent) => {
		if (e.key === "Enter" && !e.shiftKey) {
			e.preventDefault();
			(e.currentTarget as HTMLElement).blur();
		}
	};
	const fitTextarea = (el: HTMLTextAreaElement) => {
		el.style.height = "auto";
		el.style.height = `${Math.min(200, Math.max(36, el.scrollHeight + 2))}px`;
	};
	const bindAutoTextarea = (value?: () => string) => (el: HTMLTextAreaElement) => {
		const refit = () => fitTextarea(el);
		queueMicrotask(refit);
		if (value) {
			createEffect(() => {
				value();
				queueMicrotask(refit);
			});
		}
		if (typeof ResizeObserver !== "undefined") {
			let lastWidth = -1;
			const ro = new ResizeObserver((entries) => {
				const w = Math.round(entries[0]?.contentRect.width ?? 0);
				if (w > 0 && w !== lastWidth) {
					lastWidth = w;
					refit();
				}
			});
			ro.observe(el);
			onCleanup(() => ro.disconnect());
		}
	};
	const showTemplate = (t: Template) => void setShown({ label: t.label, note: t.note, text: snippetAsText(t.body()) });
	/** A snippet's text is read when it is pointed at: the row asked for last is the one shown. */
	let asked = "";
	const showSnippet = (file: DocFile) => {
		asked = file.path;
		const label = file.title || file.name;
		void snippetText(file).then(
			(text) => asked === file.path && setShown({ label, note: file.summary, text, path: file.path }),
			() => asked === file.path && setShown({ label, note: "It could not be read.", text: "", path: file.path }),
		);
	};
	const copy = async (text: string) => {
		const copied = (await backend.clipboard(text).catch(() => false)) || (await navigator.clipboard?.writeText(text).then(() => true, () => false));
		notify(copied ? "Copied." : "Could not reach the clipboard.", copied ? "info" : "error");
	};
	return (
		<div class="panel-body" data-panel="palette">
			<div class="panel-title">
				<span>Palette</span>
			</div>
			<Show
				when={graphBridge()}
				keyed
				fallback={
					<Show
						when={planBridge()}
						keyed
						fallback={
							<>
								<p class="hint">Click a template or a kept snippet, or press Enter on it, to insert it at the cursor; or drag a template into the editor. Tab then moves between a template's fields.</p>
								<Rows label="Templates">
									<For each={groups()}>
										{(group) => (
											<RowGroup head={group}>
												<For each={TEMPLATES.filter((t) => t.group === group)}>
													{(t) => (
														<Row
															class="tree-row palette-item"
															key={t.id}
															draggable={true}
															onDragStart={(e) => e.dataTransfer?.setData("text/plain", snippetAsText(t.body()))}
															onActivate={() => insertTemplate(t)}
															onFocus={() => showTemplate(t)}
															onPoint={() => showTemplate(t)}
															title={`${t.label}: ${t.detail}${t.note ? ` (${t.note})` : ""}`}
														>
															<span class="label">{t.label}</span>
															<span class="meta">{t.detail}</span>
														</Row>
													)}
												</For>
											</RowGroup>
										)}
									</For>
									{/* What the project keeps for use: its own queries and pieces of SSL, from the knowledge base. */}
									<Show when={keptSnippets().length}>
										<RowGroup head="Kept in this project">
											<For each={keptSnippets()}>
												{(file) => (
													<Row class="tree-row palette-item kept" key={file.path} onActivate={() => void insertSnippet(file)} onFocus={() => showSnippet(file)} onPoint={() => showSnippet(file)} title={[file.title || file.name, file.summary, file.path].filter(Boolean).join("\n")}>
														<span class="label">{file.title || file.name}</span>
														<span class="meta">{/\.sql$/i.test(file.name) ? "SQL" : /\.(ssl|srvscr|ds)$/i.test(file.name) ? "SSL" : ""}</span>
													</Row>
												)}
											</For>
										</RowGroup>
									</Show>
								</Rows>
								<SectionSplitter label="Height of the template preview" value={previewH()} min={80} max={440} onDrag={resizePreview} onReset={resetPreview} />
								{/* Resizable preview of what the hovered/focused template inserts. */}
								<div class="palette-preview" role="region" aria-label="What it inserts" style={{ height: `${previewH()}px` }}>
									<Show when={shown()} keyed fallback={<p class="hint">Point at a template or a snippet, or move to it with the arrow keys, to see here what it inserts.</p>}>
										{(t) => (
											<>
												<div class="palette-preview-head">
													<strong>{t.label}</strong>
													<Show when={t.note}>
														<span class="hint">{t.note}</span>
													</Show>
													<Show when={t.path}>
														<span class="spacer" />
														<button class="link" title="Copy the snippet" onClick={() => void copy(t.text)}>
															Copy
														</button>
														<button class="link" title="Open the snippet's file, to change it" onClick={() => void openFile(t.path!)}>
															Open
														</button>
													</Show>
												</div>
												<pre>{t.text}</pre>
											</>
										)}
									</Show>
								</div>
							</>
						}
					>
						{(plan) => {
							const p = () => plan.plan();
							let lastPlan: Plan | undefined;
							const safePlan = () => {
								const cur = p();
								if (cur) lastPlan = cur;
								return cur ?? lastPlan;
							};
							const goalText = () => (typeof p()?.goal === "string" ? (p()!.goal as string) : "");
							const ticketDoc = () => {
								const key = typeof p()?.ticket === "string" ? (p()!.ticket as string).trim() : "";
								if (!key) return null;
								return docs().find((d) => d.group === "tickets" && d.exists && d.ticket?.toLowerCase() === key.toLowerCase()) ?? null;
							};
							const assistCount = () => {
								const cur = p();
								const a = assistOf(plan.path);
								return (cur ? openQuestions(cur).length : 0) + a.suggestions.length;
							};
							const assistRunning = () => Boolean(assistOf(plan.path).running);
							return (
								<>
									<div class="plan-palette-tabs" role="tablist" aria-label="Plan tools">
										<button
											type="button"
											role="tab"
											aria-selected={planTab() === "design"}
											classList={{ on: planTab() === "design" }}
											onClick={() => setPlanTab("design")}
										>
											Design
										</button>
										<button
											type="button"
											role="tab"
											aria-selected={planTab() === "assistant"}
											classList={{ on: planTab() === "assistant" }}
											onClick={() => setPlanTab("assistant")}
										>
											<span>Assistant</span>
											<Show when={assistCount() > 0}>
												<span class="plan-tab-badge">{assistCount()}</span>
											</Show>
											<Show when={assistCount() === 0 && assistRunning()}>
												<Icon name="sync" />
											</Show>
										</button>
									</div>

									<Show when={planTab() === "design"}>
										{(() => {
											let scrollEl: HTMLDivElement | undefined;
											let shapeGridEl: HTMLDivElement | undefined;
											const hasSelection = () => Boolean(plan.selectedNode());
											const shapesCollapsed = () => (hasSelection() ? !selectedShapesExpanded() : planShapesCollapsed());
											const syncDock = () => {
												if (shapesCollapsed() || !scrollEl || !shapeGridEl) return setShapesScrolled(false);
												const threshold = Math.max(24, shapeGridEl.offsetTop + 26);
												setShapesScrolled(scrollEl.scrollTop > threshold);
											};
											createEffect(() => {
												plan.selectedId();
												setSelectedShapesExpanded(false);
												queueMicrotask(syncDock);
											});
											createEffect(() => {
												shapesCollapsed();
												nodeImplOpen();
												planImplOpen();
												queueMicrotask(syncDock);
											});
											const startShapeDrag = (e: DragEvent, shape: PlanShapeItem) => {
												if (!shape.dragKind) return;
												e.dataTransfer?.setData(SHAPE_DRAG, shape.dragKind);
												if (e.dataTransfer) e.dataTransfer.effectAllowed = "copy";
											};
											const collapseToRail = () => {
												if (hasSelection()) setSelectedShapesExpanded(false);
												else setPlanShapesCollapsed(true);
											};
											const expandFromRail = () => {
												if (shapesCollapsed()) {
													if (hasSelection()) setSelectedShapesExpanded(true);
													else setPlanShapesCollapsed(false);
													queueMicrotask(() => scrollEl?.scrollTo({ top: 0 }));
												} else {
													scrollEl?.scrollTo({ top: 0, behavior: "smooth" });
												}
											};
											const renderRail = (className: string, visible: boolean) => (
												<div
													class={className}
													classList={{ visible }}
													role="toolbar"
													aria-label="Process shapes"
													aria-hidden={!visible}
												>
													<For each={PLAN_SHAPES}>
														{(shape) => (
															<button
																type="button"
																class="plan-dock-btn"
																classList={{ active: Boolean(shape.active?.(plan)) }}
																tabIndex={visible ? 0 : -1}
																draggable={Boolean(shape.dragKind)}
																onDragStart={(e) => startShapeDrag(e, shape)}
																onClick={() => shape.run(plan)}
																title={`${shape.label}: ${shape.about}`}
																aria-label={shape.label}
															>
																<Icon name={shape.icon} />
															</button>
														)}
													</For>
													<button
														type="button"
														class="plan-rail-toggle"
														tabIndex={visible ? 0 : -1}
														onClick={expandFromRail}
														title="Expand process shapes"
														aria-label="Expand process shapes"
													>
														<Icon name="chevron-down" />
													</button>
												</div>
											);
											return (
												<div class="plan-palette-wrap">
													{/* Top icon rail: shown directly when collapsed (auto on selected step, or manually collapsed). */}
													<Show when={shapesCollapsed()}>{renderRail("plan-shape-rail", true)}</Show>

													{/* Scroll-triggered top icon rail when Process shapes is expanded and scrolled out of view. */}
													<Show when={!shapesCollapsed()}>{renderRail("plan-shape-dock", shapesScrolled())}</Show>

													<div class="plan-palette-scroll" ref={scrollEl} onScroll={syncDock}>
														{/* Full Process shapes grid when expanded; manually collapsible to top rail. */}
														<Show when={!shapesCollapsed()}>
															<section class="plan-shapes-section" aria-label="Process shapes">
																<div class="plan-shapes-head">
																	<span class="plan-section-kicker">Process shapes</span>
																	<span class="spacer" />
																	<button
																		type="button"
																		class="plan-shapes-collapse"
																		onClick={collapseToRail}
																		title="Collapse process shapes to top rail"
																		aria-label="Collapse process shapes to top rail"
																	>
																		<Icon name="chevron-up" />
																	</button>
																</div>
																<div class="plan-shape-grid" ref={shapeGridEl}>
																	<For each={PLAN_SHAPES}>
																		{(shape) => (
																			<button
																				type="button"
																				class="plan-shape-tile"
																				classList={{
																					active: Boolean(shape.active?.(plan)),
																					wide: shape.id === "plan-connect",
																				}}
																				draggable={Boolean(shape.dragKind)}
																				onDragStart={(e) => startShapeDrag(e, shape)}
																				onClick={() => shape.run(plan)}
																				onMouseEnter={() => setPlanNote(shape.about)}
																				onMouseLeave={() => setPlanNote("")}
																				onFocus={() => setPlanNote(shape.about)}
																				onBlur={() => setPlanNote("")}
																				title={shape.about}
																			>
																				<Icon name={shape.icon} class="plan-shape-icon" />
																				<span class="plan-shape-name">{shape.label}</span>
																				<Show when={shape.active?.(plan)}>
																					<span class="plan-shape-state">Active</span>
																				</Show>
																			</button>
																		)}
																	</For>
																</div>
																<p class="plan-shapes-tip">
																	{planNote() || "Drag shapes onto the chart, or drag any step, stage pill, or wire directly."}
																</p>
															</section>
														</Show>

														{/* Contextual inspector: Selected object OR Plan (never both stacked together). */}
														<Show
															when={plan.selectedNode()}
															keyed
															fallback={
																<Show when={p()} keyed>
																	{(curPlan) => (
																		<div class="plan-inspector">
																			<section class="plan-prop-section" aria-label="Plan details">
																				<div class="plan-section-kicker">Plan</div>
																				<div class="plan-prop-fields">
																					<label class="plan-prop-field">
																						<span>Title</span>
																						<input
																							value={curPlan.title ?? ""}
																							onKeyDown={commitOnEnter}
																							onChange={(e) => plan.setPlanField("title", e.currentTarget.value)}
																						/>
																					</label>
																					<label class="plan-prop-field">
																						<span>Goal</span>
																						<textarea
																							ref={bindAutoTextarea(goalText)}
																							rows={2}
																							value={goalText()}
																							placeholder="What this process should achieve"
																							onInput={(e) => fitTextarea(e.currentTarget)}
																							onChange={(e) => plan.setPlanField("goal", e.currentTarget.value)}
																						/>
																					</label>
																					<label
																						class="plan-prop-field"
																						title="The ticket this plan is for. The agent uses its goals, open questions, and decisions when refining or building."
																					>
																						<span>Ticket</span>
																						<div class="plan-ticket-row">
																							<input
																								value={typeof curPlan.ticket === "string" ? curPlan.ticket : ""}
																								placeholder="LIMS-123"
																								onKeyDown={commitOnEnter}
																								onChange={(e) => plan.setPlanField("ticket", e.currentTarget.value)}
																							/>
																							<Show when={ticketDoc()} keyed>
																								{(td) => (
																									<IconButton
																										label={`Open ticket ${td.ticket}`}
																										title={`Open ${td.ticket}${td.title ? `: ${td.title}` : ""}`}
																										icon="go-to-file"
																										onClick={() => void openFile(td.path)}
																									/>
																								)}
																							</Show>
																						</div>
																					</label>
																				</div>
																			</section>

																			<Show when={plan.stages().length > 0}>
																				<section class="plan-prop-section" aria-label="Stages">
																					<div class="plan-section-kicker">Stages</div>
																					<div class="plan-stage-chips">
																						<For each={plan.stages()}>
																							{(stage) => (
																								<button
																									type="button"
																									class="plan-stage-chip"
																									title={`Jump to "${stage.name}" (${stage.count} ${stage.count === 1 ? "step" : "steps"}). Double-click the stage pill on the chart to rename.`}
																									onClick={() => stage.firstNodeId && plan.jumpToNode(stage.firstNodeId)}
																								>
																									<span class="plan-stage-dot" style={{ background: regionColor(stage.name) }} aria-hidden="true" />
																									<span class="plan-stage-chip-name">{stage.name}</span>
																									<span class="plan-stage-chip-count">{stage.count}</span>
																								</button>
																							)}
																						</For>
																					</div>
																				</section>
																			</Show>

																			<PlanImplementation
																				plan={curPlan}
																				builtUnits={plan.builtUnits()}
																				open={planImplOpen()}
																				onToggle={() => setPlanImplOpen((o) => !o)}
																				onOpenUnit={(unit) => plan.openCodeUnit(unit)}
																				onOpenScript={(script, line) => plan.openScript(script, line)}
																				onSetTargets={(value) => plan.setTargets(value)}
																				onCommitOnEnter={commitOnEnter}
																				bindTextarea={bindAutoTextarea}
																				fitTextarea={fitTextarea}
																			/>
																		</div>
																	)}
																</Show>
															}
														>
															{(node) => {
																const displayKind = node.kind === "call" ? "step" : node.kind;
																const heading = `Selected ${displayKind}`;
																const iconName: IconName =
																	displayKind === "decision"
																		? "git-branch"
																		: displayKind === "end"
																			? "pass-filled"
																			: "play";
																return (
																	<div class="plan-inspector">
																		<section class="plan-prop-section plan-step-section" aria-label={heading}>
																			<div class="plan-step-head">
																				<Icon name={iconName} class={`plan-sel-icon ${displayKind}`} />
																				<span class="plan-prop-title">{heading}</span>
																				<span class="spacer" />
																				<IconButton label={`Close ${heading.toLowerCase()}`} title="Back to plan details (Esc)" icon="close" onClick={() => plan.clearSelection()} />
																			</div>
																			<Show when={node.kind !== "start" && node.kind !== "end"}>
																				<div class="plan-dir-switch plan-kind-switch" role="group" aria-label="Shape kind">
																					<For each={(["step", "decision"] as NodeKind[])}>
																						{(k) => (
																							<button
																								type="button"
																								classList={{ on: displayKind === k }}
																								aria-pressed={displayKind === k}
																								onClick={() => plan.setNodeKind(k)}
																							>
																								{k === "step" ? "Step" : "Decision"}
																							</button>
																						)}
																					</For>
																				</div>
																			</Show>
																			<div class="plan-prop-fields">
																				<label class="plan-prop-field">
																					<span>Label</span>
																					<input
																						value={node.text}
																						placeholder="Describe this step"
																						onKeyDown={commitOnEnter}
																						onChange={(e) => plan.setNodeText(e.currentTarget.value)}
																					/>
																				</label>
																				<label class="plan-prop-field">
																					<span>Stage</span>
																					<input
																						value={plan.groupName()}
																						list="plan-palette-groups"
																						placeholder="None (unassigned)"
																						onKeyDown={commitOnEnter}
																						onChange={(e) => plan.setNodeGroup(e.currentTarget.value)}
																					/>
																				</label>
																				<datalist id="plan-palette-groups">
																					<For each={p()?.groups ?? []}>{(g) => <option value={g.name} />}</For>
																				</datalist>
																				<label class="plan-prop-field">
																					<span>Notes</span>
																					<textarea
																						ref={bindAutoTextarea()}
																						rows={2}
																						value={node.notes ?? ""}
																						placeholder="Business rules, exceptions, or context"
																						onInput={(e) => fitTextarea(e.currentTarget)}
																						onChange={(e) => plan.setNodeField("notes", e.currentTarget.value)}
																					/>
																				</label>
																			</div>
																			<Show when={p()} keyed>
																				{(curPlan) => (
																					<NodeImplementation
																						plan={curPlan}
																						planUri={plan.planUri()}
																						node={node}
																						open={nodeImplOpen()}
																						onToggle={() => setNodeImplOpen((o) => !o)}
																						onOpenUnit={(unit) => plan.openCodeUnit(unit)}
																						onOpenRef={(ref) => plan.openReference(ref)}
																						onOpenScript={(script, line) => plan.openScript(script, line)}
																					/>
																				)}
																			</Show>
																		</section>
																	</div>
																);
															}}
														</Show>
													</div>
												</div>
											);
										})()}
									</Show>

									{/* Keep PlanAssistant mounted while this plan is active so ongoing builds & path walkthroughs persist across tabs. */}
									<Show when={p() && safePlan()}>
										<PlanAssistant
											inPalette
											hidden={planTab() !== "assistant"}
											path={plan.path}
											plan={safePlan()!}
											text={plan.text()}
											onSelect={(id) => plan.selectNode(id)}
											onPath={(nodes) => plan.setWalkedPath(nodes)}
										/>
									</Show>
								</>
							);
						}}
					</Show>
				}
			>
				{(graph) => (
					<>
						<Rows label="Call graph controls and scripts">
							<RowGroup head="Graph controls">
								<Row
									class="tree-row palette-item plan-shape-item"
									classList={{ active: graph.filterMode() === "all" }}
									key="graph:all"
									onActivate={() => graph.setFilterMode("all")}
									title="Show every call in the workspace"
								>
									<Icon name="graph" class="icon" />
									<span class="label">Every call</span>
									<span class="meta">{graph.filterMode() === "all" ? "On" : ""}</span>
								</Row>
								<Row
									class="tree-row palette-item plan-shape-item"
									classList={{ active: graph.filterMode() === "cross" }}
									key="graph:cross"
									onActivate={() => graph.setFilterMode("cross")}
									title="Show only calls between scripts"
								>
									<Icon name="references" class="icon" />
									<span class="label">Cross-script calls</span>
									<span class="meta">{graph.filterMode() === "cross" ? "On" : ""}</span>
								</Row>
								<Show when={graph.folding()}>
									<Row
										class="tree-row palette-item plan-shape-item"
										key="graph:fold"
										onActivate={() => graph.foldAll(!graph.allFolded())}
										title={graph.allFolded() ? "Unfold all folders and scripts" : "Fold all folders and scripts"}
									>
										<Icon name={graph.allFolded() ? "expand-all" : "collapse-all"} class="icon" />
										<span class="label">{graph.allFolded() ? "Unfold all" : "Fold all"}</span>
									</Row>
									<Row
										class="tree-row palette-item plan-shape-item"
										classList={{ active: graph.gathered() }}
										key="graph:gather"
										onActivate={() => graph.toggleGathered()}
										title="Toggle bundling calls at folder edges"
									>
										<Icon name="layers" class="icon" />
										<span class="label">Gather folder edges</span>
										<span class="meta">{graph.gathered() ? "On" : "Off"}</span>
									</Row>
								</Show>
								<Show when={graph.unresolvedCount() > 0}>
									<Row
										class="tree-row palette-item plan-shape-item"
										classList={{ active: graph.unresolved() }}
										key="graph:unresolved"
										onActivate={() => graph.toggleUnresolved()}
										title="Show or hide targets the language server could not resolve"
									>
										<Icon name="warning" class="icon" />
										<span class="label">Unresolved targets</span>
										<span class="meta">{graph.unresolved() ? String(graph.unresolvedCount()) : "Hidden"}</span>
									</Row>
								</Show>
								<Row class="tree-row palette-item plan-shape-item" key="graph:fit" onActivate={() => graph.fit()} title="Fit graph to view (0)">
									<Icon name="search" class="icon" />
									<span class="label">Fit to view</span>
								</Row>
							</RowGroup>
							<Show when={graph.targets().length}>
								<RowGroup head="Focus a script">
									<For each={graph.targets()}>
										{(target) => (
											<Row
												class="tree-row palette-item"
												key={`target:${target.id}`}
												onActivate={() => graph.focusTarget(target.id)}
												title={`Show calls into and out of ${target.label}`}
											>
												<Icon name="file" class="icon" />
												<span class="label">{target.label}</span>
												<span class="meta">{target.meta}</span>
											</Row>
										)}
									</For>
								</RowGroup>
							</Show>
						</Rows>
						<Show when={graph.tally()}>
							<div class="palette-preview plan-palette-note" role="region" aria-label="Call graph summary">
								<p class="hint">{graph.tally()}</p>
							</div>
						</Show>
					</>
				)}
			</Show>
		</div>
	);
}
