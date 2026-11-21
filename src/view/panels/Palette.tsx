// Templates from the style profile, inserted at the cursor as snippets, and
// the snippets the project keeps in its knowledge base (ADR 0012), inserted
// as they are written. When a plan chart is open, Palette switches cleanly to
// business-analyst process shapes and stage navigation (ADR 0027).
import { createSignal, For, Show } from "solid-js";
import { snippetAsText, TEMPLATES, type Template } from "../../shared/houseStyle";
import { isCatalog } from "../../shared/projectDocs";
import type { DocFile } from "../../shared/protocol";
import { backend } from "../backend";
import { activeEditor } from "../editor/EditorGroup";
import { Icon, type IconName } from "../Icon";
import { activeGraphBridge } from "../graph/graphBridge";
import { recall, remember } from "../graph/canvas";
import { activePlanBridge } from "../plan/planBridge";
import { docs } from "../project";
import { activePath, notify, openFile, state } from "../state";
import { Row, RowGroup, Rows } from "./Rows";
import { SectionSplitter } from "./SectionSplitter";

export function insertTemplate(template: Template) {
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
	const editor = activeEditor();
	const model = editor?.getModel();
	if (!editor || !model) return notify("Open a file to insert a snippet into. Its row's title says where it is kept.");
	let text: string;
	try {
		text = await snippetText(file);
	} catch (e: any) {
		return notify(`The snippet could not be read: ${e?.message ?? e}`, "error");
	}
	const position = editor.getPosition() ?? model.getFullModelRange().getEndPosition();
	const selection = editor.getSelection();
	const range = selection && !selection.isEmpty() ? selection : { startLineNumber: position.lineNumber, startColumn: position.column, endLineNumber: position.lineNumber, endColumn: position.column };
	// A snippet starts a line of its own, as a template does.
	const ownLine = model.getLineContent(range.startLineNumber).slice(0, range.startColumn - 1).trim() ? "\n" : "";
	editor.pushUndoStop();
	editor.executeEdits("snippet", [{ range, text: `${ownLine}${text.replace(/\r\n/g, "\n")}`, forceMoveMarkers: true }]);
	editor.pushUndoStop();
	editor.focus();
}

type PlanShapeItem = {
	id: string;
	label: string;
	detail: string;
	icon: IconName;
	about: string;
	run: (plan: NonNullable<ReturnType<typeof activePlanBridge>>) => void;
	active?: (plan: NonNullable<ReturnType<typeof activePlanBridge>>) => boolean;
};

const PLAN_SHAPES: readonly PlanShapeItem[] = [
	{
		id: "plan-step",
		label: "Process step",
		detail: "Next action",
		icon: "play",
		about: "Adds the next plain-English action after the selected node (or after Start).",
		run: (p) => p.addStep(),
	},
	{
		id: "plan-decision",
		label: "Decision (yes / no)",
		detail: "Rule or check",
		icon: "git-branch",
		about: "Adds a yes/no decision diamond to split the process by a business rule.",
		run: (p) => p.addDecision(),
	},
	{
		id: "plan-branch",
		label: "Alternate branch",
		detail: "Another path",
		icon: "arrow-right",
		about: "Adds another outgoing outcome from the selected step or decision.",
		run: (p) => p.addBranch(),
	},
	{
		id: "plan-call",
		label: "Existing process",
		detail: "Reuse procedure",
		icon: "references",
		about: "References an existing procedure, script, or data source in this workspace.",
		run: (p) => p.addCall(),
	},
	{
		id: "plan-stage",
		label: "Stage group",
		detail: "Group into phase",
		icon: "layers",
		about: "Assigns the selected step to a named stage (becomes a region in SSL).",
		run: (p) => p.addStageGroup(),
	},
	{
		id: "plan-connect",
		label: "Connect steps",
		detail: "Draw flow arrow",
		icon: "symbol-event",
		about: "Links the selected step to any other step on the chart (click target or press Esc).",
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
				fallback={
					<Show
						when={planBridge()}
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
									<Show when={shown()} fallback={<p class="hint">Point at a template or a snippet, or move to it with the arrow keys, to see here what it inserts.</p>}>
										{(t) => (
											<>
												<div class="palette-preview-head">
													<strong>{t().label}</strong>
													<Show when={t().note}>
														<span class="hint">{t().note}</span>
													</Show>
													<Show when={t().path}>
														<span class="spacer" />
														<button class="link" title="Copy the snippet" onClick={() => void copy(t().text)}>
															Copy
														</button>
														<button class="link" title="Open the snippet's file, to change it" onClick={() => void openFile(t().path!)}>
															Open
														</button>
													</Show>
												</div>
												<pre>{t().text}</pre>
											</>
										)}
									</Show>
								</div>
							</>
						}
					>
						{(plan) => (
							<>
								<Rows label="Process shapes and stages">
									<RowGroup head="Process shapes">
										<For each={PLAN_SHAPES}>
											{(shape) => (
												<Row
													class="tree-row palette-item plan-shape-item"
													classList={{ active: Boolean(shape.active?.(plan())) }}
													key={shape.id}
													onActivate={() => shape.run(plan())}
													onFocus={() => setPlanNote(shape.about)}
													onPoint={() => setPlanNote(shape.about)}
													title={shape.about}
												>
													<Icon name={shape.icon} class="icon" />
													<span class="label">{shape.label}</span>
													<span class="meta">{shape.active?.(plan()) ? "Active" : shape.detail}</span>
												</Row>
											)}
										</For>
									</RowGroup>
									<Show when={plan().stages().length}>
										<RowGroup head="Stages in this plan">
											<For each={plan().stages()}>
												{(stage) => (
													<Row
														class="tree-row palette-item"
														key={`stage:${stage.id}`}
														onActivate={() => stage.firstNodeId && plan().jumpToNode(stage.firstNodeId)}
														onFocus={() => setPlanNote(`Jump to the "${stage.name}" stage (${stage.count} ${stage.count === 1 ? "step" : "steps"}).`)}
														onPoint={() => setPlanNote(`Jump to the "${stage.name}" stage (${stage.count} ${stage.count === 1 ? "step" : "steps"}).`)}
														title={`Jump to stage: ${stage.name}`}
													>
														<Icon name="layers" class="icon" />
														<span class="label">{stage.name}</span>
														<span class="meta">{stage.count}</span>
													</Row>
												)}
											</For>
										</RowGroup>
									</Show>
								</Rows>
								<div class="palette-preview plan-palette-note" role="region" aria-label="About this element">
									<p class="hint">{planNote() || "Click a process shape to add it to the flowchart, or pick a stage to jump there. Every change is undoable (Ctrl+Z)."}</p>
								</div>
							</>
						)}
					</Show>
				}
			>
				{(graph) => (
					<>
						<Rows label="Call graph controls and scripts">
							<RowGroup head="Graph controls">
								<Row
									class="tree-row palette-item plan-shape-item"
									classList={{ active: graph().filterMode() === "all" }}
									key="graph:all"
									onActivate={() => graph().setFilterMode("all")}
									title="Show every call in the workspace"
								>
									<Icon name="graph" class="icon" />
									<span class="label">Every call</span>
									<span class="meta">{graph().filterMode() === "all" ? "On" : ""}</span>
								</Row>
								<Row
									class="tree-row palette-item plan-shape-item"
									classList={{ active: graph().filterMode() === "cross" }}
									key="graph:cross"
									onActivate={() => graph().setFilterMode("cross")}
									title="Show only calls between scripts"
								>
									<Icon name="references" class="icon" />
									<span class="label">Cross-script calls</span>
									<span class="meta">{graph().filterMode() === "cross" ? "On" : ""}</span>
								</Row>
								<Show when={graph().folding()}>
									<Row
										class="tree-row palette-item plan-shape-item"
										key="graph:fold"
										onActivate={() => graph().foldAll(!graph().allFolded())}
										title={graph().allFolded() ? "Unfold all folders and scripts" : "Fold all folders and scripts"}
									>
										<Icon name={graph().allFolded() ? "expand-all" : "collapse-all"} class="icon" />
										<span class="label">{graph().allFolded() ? "Unfold all" : "Fold all"}</span>
									</Row>
									<Row
										class="tree-row palette-item plan-shape-item"
										classList={{ active: graph().gathered() }}
										key="graph:gather"
										onActivate={() => graph().toggleGathered()}
										title="Toggle bundling calls at folder edges"
									>
										<Icon name="layers" class="icon" />
										<span class="label">Gather folder edges</span>
										<span class="meta">{graph().gathered() ? "On" : "Off"}</span>
									</Row>
								</Show>
								<Show when={graph().unresolvedCount() > 0}>
									<Row
										class="tree-row palette-item plan-shape-item"
										classList={{ active: graph().unresolved() }}
										key="graph:unresolved"
										onActivate={() => graph().toggleUnresolved()}
										title="Show or hide targets the language server could not resolve"
									>
										<Icon name="warning" class="icon" />
										<span class="label">Unresolved targets</span>
										<span class="meta">{graph().unresolved() ? String(graph().unresolvedCount()) : "Hidden"}</span>
									</Row>
								</Show>
								<Row class="tree-row palette-item plan-shape-item" key="graph:fit" onActivate={() => graph().fit()} title="Fit graph to view (0)">
									<Icon name="search" class="icon" />
									<span class="label">Fit to view</span>
								</Row>
							</RowGroup>
							<Show when={graph().targets().length}>
								<RowGroup head="Focus a script">
									<For each={graph().targets()}>
										{(target) => (
											<Row
												class="tree-row palette-item"
												key={`target:${target.id}`}
												onActivate={() => graph().focusTarget(target.id)}
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
						<Show when={graph().tally()}>
							<div class="palette-preview plan-palette-note" role="region" aria-label="Call graph summary">
								<p class="hint">{graph().tally()}</p>
							</div>
						</Show>
					</>
				)}
			</Show>
		</div>
	);
}
