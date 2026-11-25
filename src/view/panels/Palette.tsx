// Templates from the style profile, inserted at the cursor as snippets, and
// the snippets the project keeps in its knowledge base (ADR 0012), inserted
// as they are written. When a plan chart is open, Palette switches cleanly to
// business-analyst process shapes and stage navigation (ADR 0027).
import { createEffect, createMemo, createSignal, For, onCleanup, onSettled, Show, untrack } from "solid-js";
import { createAsyncQuery } from "../asyncQuery";
import { snippetAsText, TEMPLATES, type Template } from "../../shared/houseStyle";
import { CALLOUT_PRESETS } from "../../shared/markdownEdit";
import { createEmptyTable } from "../../shared/markdownTables";
import { baseName, joinPath, relativeTo } from "../../shared/paths";
import { isCatalog, registryTitle, toneOf } from "../../shared/projectDocs";
import type { DocFile } from "../../shared/protocol";
import type { MarkdownTemplate } from "../../shared/templater";
import { backend } from "../backend";
import { quickPick, type QuickPickOption } from "../dialogs";
import { activeEditor } from "../editor/EditorGroup";
import { activeLiveEditor } from "../editor/liveBridge";
import { monaco } from "../editor/monaco";
import { regionColor } from "../editor/regions";
import { review } from "../editor/Review";
import { Icon, type IconName } from "../Icon";
import { activeGraphBridge } from "../graph/graphBridge";
import {
	graphHighlightedCount,
	graphTicketHighlight,
	graphTicketSubgraph,
	requestGraphTicketImpact,
	setGraphTicketHighlight,
	setGraphTicketSubgraph,
} from "../graph/GraphView";
import { recall, remember } from "../graph/canvas";
import { buildDriftAgentDraft, openQuestions } from "../plan/assist";
import { CODE_INDICATOR_WORDS } from "../plan/chart";
import { driftFor } from "../plan/drift";
import { addNodeDoc, nodeDocsOf, printPlan, removeNodeDoc, SHAPE_DRAG, type NodeKind, type Plan } from "../plan/model";
import { PlanAssistant } from "../plan/PlanAssistant";
import { NodeImplementation, PlanImplementation } from "../plan/PlanCodeDrilldown";
import { activePlanBridge, planPaletteTabRequest, setActivePlanTab } from "../plan/planBridge";
import "../plan/planExtra.css";
import { NodeTests, PlanTests } from "../plan/PlanTests";
import { assistOf } from "../plan/run";
import { docs, isMarkdown } from "../project";
import { activeDoc, activePath, applyText, markdownMode, notify, openFile, planMode, setMarkdownMode, state } from "../state";
import { insertCalloutInteractive, insertImageInteractive, insertMarkdownTemplate, loadMarkdownTemplates, manageTemplates, newNoteFromTemplate } from "../templater";
import { IconButton, Row, RowGroup, Rows, setFolds } from "./Rows";
import { SectionSplitter } from "./SectionSplitter";

let lastHandledPlanTabSeq = 0;

/** Clamps a recalled splitter height into `[min, max]`, falling back when missing or non-numeric. */
export function clampPaletteHeight(raw: string | null, min = 80, max = 440, fallback = 190): number {
	if (raw === null || raw.trim() === "") return fallback;
	const n = Number(raw);
	return Number.isFinite(n) ? Math.max(min, Math.min(max, n)) : fallback;
}

/** Formats a kept project snippet for either a Markdown document (wrapping SQL/SSL in fenced blocks) or a code editor. */
export function formatSnippetForEditor(text: string, snippetFileName: string, targetIsMarkdown: boolean): string {
	const normalized = text.replace(/\r\n/g, "\n");
	if (!targetIsMarkdown) return normalized;
	const raw = normalized.trimEnd();
	const lang = /\.sql$/i.test(snippetFileName) ? "sql" : /\.(ssl|srvscr|ds)$/i.test(snippetFileName) ? "ssl" : "";
	return lang ? `\`\`\`${lang}\n${raw}\n\`\`\`\n` : `${raw}\n`;
}

/** Returns the active Monaco editor and model only when a non-binary text editor is genuinely visible in front. */
function visibleMonacoEditor(): { editor: monaco.editor.IStandaloneCodeEditor; model: monaco.editor.ITextModel; doc: NonNullable<ReturnType<typeof activeDoc>> } | null {
	if (state.centerView !== "editors" || review()) return null;
	const doc = activeDoc();
	if (!doc || doc.binary) return null;
	const editor = activeEditor();
	const model = editor?.getModel();
	if (!editor || !model || model.isDisposed() || !editor.getDomNode()?.offsetParent) return null;
	return { editor, model, doc };
}

/** Inserts text into a visible Monaco editor as one undoable edit, optionally as a standalone block with cursor placement. */
function insertBlockIntoMonaco(
	editor: monaco.editor.IStandaloneCodeEditor,
	model: monaco.editor.ITextModel,
	text: string,
	cursorOffset?: number,
	opts?: { asBlock?: boolean; source?: string; selectLength?: number },
): void {
	const position = editor.getPosition() ?? model.getFullModelRange().getEndPosition();
	const sel = editor.getSelection() ?? {
		startLineNumber: position.lineNumber,
		startColumn: position.column,
		endLineNumber: position.lineNumber,
		endColumn: position.column,
	};
	const isEmpty = sel.startLineNumber === sel.endLineNumber && sel.startColumn === sel.endColumn;
	const eol = model.getEOL();
	const normText = text.replace(/\r?\n/g, eol);
	const normCursor = cursorOffset !== undefined ? text.slice(0, cursorOffset).replace(/\r?\n/g, eol).length : null;
	let insertText = normText;
	let offsetDelta = 0;
	let range: monaco.IRange = sel;
	if (opts?.asBlock && isEmpty) {
		const lineContent = model.getLineContent(sel.startLineNumber);
		if (lineContent.trim()) {
			const endCol = lineContent.length + 1;
			range = { startLineNumber: sel.startLineNumber, startColumn: endCol, endLineNumber: sel.startLineNumber, endColumn: endCol };
			insertText = `${eol}${eol}${normText}`;
			offsetDelta = eol.length * 2;
		}
	}
	const startOffset = model.getOffsetAt({ lineNumber: range.startLineNumber, column: range.startColumn });
	editor.pushUndoStop();
	editor.executeEdits(opts?.source ?? "palette", [{ range, text: insertText, forceMoveMarkers: true }]);
	editor.pushUndoStop();
	if (normCursor !== null) {
		const targetPos = model.getPositionAt(startOffset + offsetDelta + normCursor);
		if (opts?.selectLength && opts.selectLength > 0) {
			const endPos = model.getPositionAt(startOffset + offsetDelta + normCursor + opts.selectLength);
			editor.setSelection(new monaco.Range(targetPos.lineNumber, targetPos.column, endPos.lineNumber, endPos.column));
		} else {
			editor.setPosition(targetPos);
		}
		editor.revealPositionInCenterIfOutsideViewport(targetPos);
	}
	editor.focus();
}

export function insertTemplate(template: Template) {
	if (state.centerView !== "editors" || review()) return notify("Switch to an editable text view to insert a template.");
	const doc = activeDoc();
	if (!doc || doc.binary) return notify("Open an editable text file to insert a template.");
	const live = activeLiveEditor();
	if (live) {
		live.insertText(snippetAsText(template.body()));
		return;
	}
	const target = visibleMonacoEditor();
	if (!target) return notify("Switch to an editable text view to insert a template.");
	const { editor, model } = target;
	const existingPos = editor.getPosition();
	const position = existingPos ?? model.getFullModelRange().getEndPosition();
	if (!existingPos) editor.setPosition(position);
	editor.focus();
	const snippets = editor.getContribution("snippetController2") as unknown as { insert(text: string): void } | null;
	const line = model.getLineContent(position.lineNumber);
	// Templates start a line of their own.
	const body = template.body();
	const needsNewline = Boolean(line.trim() && position.column > 1);
	if (snippets) {
		snippets.insert(needsNewline ? `\n${body}` : body);
	} else {
		const plain = snippetAsText(body);
		insertBlockIntoMonaco(editor, model, needsNewline ? `\n${plain}` : plain, undefined, { source: "template" });
	}
}

/** What is shown under the list in the SSL palette: a template, or a snippet the project keeps, with what it would insert. */
type Shown = { label: string; note?: string; text: string; path?: string };

/** What is shown in the Markdown palette preview dock: templates, actions, callouts, blocks, or kept snippets. */
type MdPalettePreview =
	| { kind: "template"; tpl: MarkdownTemplate }
	| { kind: "item"; title: string; badge?: string; desc: string; preview: string; actionLabel?: string; onAction?: () => void }
	| { kind: "snippet"; file: DocFile; text: string | null; note?: string };

const MD_PALETTE_FOLDS = ["palette:md:templates", "palette:md:callouts", "palette:md:blocks", "palette:md:snippets"] as const;

const MD_TABLE_PREVIEW = "| Column 1 | Column 2 | Column 3 |\n| --- | --- | --- |\n| Cell 1 | Cell 2 | Cell 3 |\n| Cell 4 | Cell 5 | Cell 6 |";
const MD_IMAGE_PREVIEW = "![Diagram description](attachments/diagram.png)\n\n<!-- Or paste / drag-and-drop any image directly into Live view -->";
const MD_MERMAID_PREVIEW = "```mermaid\nflowchart LR\n\tA[Start] --> B[End]\n```";

/** The project's kept snippets: SQL and SSL in the knowledge base. */
export const keptSnippets = (): DocFile[] => docs().filter((d) => d.exists && d.group === "knowledge" && d.kind === "snippets" && !isCatalog(d));

const snippetText = (file: DocFile) => backend.read(file.path).then((f) => f.text);

async function ensureEditableMd() {
	if (state.centerView !== "editors" || review()) {
		notify("Switch to an editable Markdown view to insert that block.");
		return null;
	}
	const path = activePath();
	const doc = activeDoc();
	if (!path || !doc || doc.binary || !isMarkdown(doc.path)) {
		notify("Open a Markdown document to insert that block.");
		return null;
	}
	const startRoot = state.workspace?.root;
	if (!activeLiveEditor() && !activeEditor()?.getDomNode()?.offsetParent) {
		if (markdownMode(path) === "read") {
			setMarkdownMode(path, state.settings.livePreview === false ? "source" : "live");
			await new Promise((r) => setTimeout(r, 40));
			if (state.centerView !== "editors" || review() || state.workspace?.root !== startRoot || activePath() !== path) return null;
		}
	}
	const live = activeLiveEditor();
	if (live) return { kind: "live" as const, live };
	const monacoTarget = visibleMonacoEditor();
	if (monacoTarget && isMarkdown(monacoTarget.doc.path)) {
		return { kind: "source" as const, editor: monacoTarget.editor, model: monacoTarget.model };
	}
	notify("Switch to an editable Markdown view to insert that block.");
	return null;
}

/** Inserts a 3×2 Markdown table into the active Markdown editor (CM6 Live Preview or visible Monaco Source mode). */
export async function insertTableInMd(): Promise<boolean> {
	const target = await ensureEditableMd();
	if (!target) return false;
	if (target.kind === "live") {
		target.live.runAction("md-table-insert");
		return true;
	}
	const { text, cursorOffset } = createEmptyTable(3, 2);
	insertBlockIntoMonaco(target.editor, target.model, `${text}\n`, cursorOffset, {
		asBlock: true,
		source: "md-table-insert",
		selectLength: "Column 1".length,
	});
	return true;
}

/** Inserts a fenced Mermaid flowchart block into the active Markdown editor (CM6 Live Preview or visible Monaco Source mode). */
export async function insertMermaidInMd(): Promise<boolean> {
	const target = await ensureEditableMd();
	if (!target) return false;
	const block = "```mermaid\nflowchart LR\n\tA[Start] --> B[End]\n```\n";
	const cursorOffset = "```mermaid\nflowchart LR\n\t".length;
	if (target.kind === "live") {
		target.live.insertText(block, cursorOffset, { asBlock: true });
		return true;
	}
	insertBlockIntoMonaco(target.editor, target.model, block, cursorOffset, { asBlock: true, source: "md-mermaid-insert" });
	return true;
}

/** Puts a kept snippet at the cursor, as it is written: a `$` in a query is a `$`, not a field to fill. */
export async function insertSnippet(file: DocFile, readSnippet: (f: DocFile) => Promise<string> = snippetText) {
	if (state.centerView !== "editors" || review()) return notify("Switch to an editable text view to insert a snippet.");
	const startDoc = activeDoc();
	if (!startDoc || startDoc.binary) return notify("Open an editable text file to insert a snippet into. Its row's title says where it is kept.");
	const startRoot = state.workspace?.root;
	const path = activePath();
	let live = activeLiveEditor();
	if (!live && path && isMarkdown(path) && !activeEditor()?.getDomNode()?.offsetParent) {
		if (markdownMode(path) === "read") {
			setMarkdownMode(path, state.settings.livePreview === false ? "source" : "live");
			await new Promise((r) => setTimeout(r, 40));
			if (state.centerView !== "editors" || review() || state.workspace?.root !== startRoot || activePath() !== path) return;
			live = activeLiveEditor();
		}
	}
	if (!live && !visibleMonacoEditor()) return notify("Open an editable text view to insert a snippet into. Its row's title says where it is kept.");
	let text: string;
	try {
		text = await readSnippet(file);
	} catch (e: any) {
		return notify(`The snippet could not be read: ${e?.message ?? e}`, "error");
	}
	if (state.centerView !== "editors" || review() || state.workspace?.root !== startRoot || activePath() !== path) return;
	const curDoc = activeDoc();
	if (!curDoc || curDoc.binary) return;
	const curLive = activeLiveEditor();
	if (curLive) {
		curLive.insertText(formatSnippetForEditor(text, file.name, true), undefined, { asBlock: true });
		return;
	}
	const target = visibleMonacoEditor();
	if (!target) return notify("Open an editable text view to insert a snippet into. Its row's title says where it is kept.");
	const { editor, model } = target;
	if (isMarkdown(curDoc.path)) {
		insertBlockIntoMonaco(editor, model, formatSnippetForEditor(text, file.name, true), undefined, { asBlock: true, source: "snippet" });
		return;
	}
	const position = editor.getPosition() ?? model.getFullModelRange().getEndPosition();
	const selection = editor.getSelection();
	const range = selection && !selection.isEmpty() ? selection : { startLineNumber: position.lineNumber, startColumn: position.column, endLineNumber: position.lineNumber, endColumn: position.column };
	// A snippet starts a line of its own, as a template does.
	const ownLine = model.getLineContent(range.startLineNumber).slice(0, range.startColumn - 1).trim() ? "\n" : "";
	editor.pushUndoStop();
	editor.executeEdits("snippet", [{ range, text: `${ownLine}${formatSnippetForEditor(text, file.name, false)}`, forceMoveMarkers: true }]);
	editor.pushUndoStop();
	editor.focus();
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
		return bridge && path && bridge.path === path && planMode(path) !== "source" ? bridge : null;
	};
	const activeMdPath = () => {
		if (state.centerView !== "editors") return null;
		const path = activePath();
		return path && isMarkdown(path) ? path : null;
	};
	const [mdTemplates] = createAsyncQuery(
		() => (activeMdPath() ? ([state.workspace?.root ?? "", state.treeVersion, state.settings.templatesFolder ?? ""] as const) : null),
		() => loadMarkdownTemplates(),
	);
	const [shownMd, setShownMd] = createSignal<MdPalettePreview | null>(null);
	let askedMdSnippet = "";
	const showMdSnippet = (file: DocFile) => {
		askedMdSnippet = file.path;
		setShownMd({ kind: "snippet", file, text: null, note: file.summary });
		void snippetText(file).then(
			(text) => askedMdSnippet === file.path && setShownMd({ kind: "snippet", file, text, note: file.summary }),
			() => askedMdSnippet === file.path && setShownMd({ kind: "snippet", file, text: "", note: "It could not be read." }),
		);
	};
	const [previewH, setPreviewH] = createSignal(clampPaletteHeight(recall("palette.preview.h"), 80, 440, 190));
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
	const [nodeTestsOpen, setNodeTestsOpen] = createSignal(false);
	const [planTestsOpen, setPlanTestsOpen] = createSignal(false);
	const [docPickerOpen, setDocPickerOpen] = createSignal(false);
	const [docPickerQuery, setDocPickerQuery] = createSignal("");
	const [docPickerIdx, setDocPickerIdx] = createSignal(0);
	const [planTab, setPlanTabSignal] = createSignal<"design" | "assistant">("design");

	const LINKABLE_KNOWLEDGE_KINDS = new Set(["decisions", "questions", "reference", "snippets"]);
	const docKindTag = (d: DocFile): string => {
		if (d.group === "knowledge") {
			if (d.kind === "decisions") return "ADR";
			if (d.kind === "questions") return "Question";
			if (d.kind === "reference") return "Ref";
			if (d.kind === "snippets") return "Snippet";
			return "Note";
		}
		if (d.group === "specs") return "Spec";
		if (d.group === "schema") return "Schema";
		if (d.group === "tickets") return "Ticket";
		if (d.group === "registries") return "Registry";
		return "Doc";
	};
	const docDisplayName = (d: DocFile): string => {
		if (d.group === "registries") return registryTitle(d.name);
		if (d.group === "tickets" && d.ticket) {
			return d.title && !d.title.toLowerCase().startsWith(d.ticket.toLowerCase()) ? `${d.ticket}: ${d.title}` : d.title || d.ticket;
		}
		return d.title || d.heading || baseName(d.path);
	};
	const docRelPath = (d: DocFile): string => relativeTo(state.workspace?.root, d.path).replace(/\\/g, "/");
	const resolveLinkedDoc = (ref: string): DocFile | null => {
		const clean = ref.trim().replace(/\\/g, "/").replace(/^\.\//, "").toLowerCase();
		if (!clean) return null;
		const root = state.workspace?.root;
		const all = docs().filter((d) => d.exists && !isCatalog(d));
		return (
			all.find((d) => relativeTo(root, d.path).replace(/\\/g, "/").toLowerCase() === clean) ??
			all.find((d) => d.name.replace(/\\/g, "/").toLowerCase() === clean) ??
			all.find((d) => d.path.replace(/\\/g, "/").toLowerCase().endsWith(`/${clean}`)) ??
			all.find((d) => d.group === "tickets" && d.ticket?.toLowerCase() === clean) ??
			null
		);
	};
	const linkableWorkspaceDocs = () =>
		docs()
			.filter(
				(d) =>
					d.exists &&
					!isCatalog(d) &&
					(d.group === "tickets" ||
						d.group === "specs" ||
						d.group === "schema" ||
						d.group === "registries" ||
						(d.group === "knowledge" && LINKABLE_KNOWLEDGE_KINDS.has(d.kind ?? ""))),
			)
			.sort((a, b) => {
				const rank = (d: DocFile) => {
					if (d.group === "knowledge" && d.kind === "decisions") return 0;
					if (d.group === "knowledge" && d.kind === "questions") return 1;
					if (d.group === "schema") return 2;
					if (d.group === "specs") return 3;
					if (d.group === "knowledge") return 4;
					if (d.group === "registries") return 5;
					return 6;
				};
				return rank(a) - rank(b) || docDisplayName(a).localeCompare(docDisplayName(b), undefined, { sensitivity: "base" });
			});
	const workspaceTickets = () =>
		docs()
			.filter((d) => d.exists && !isCatalog(d) && d.group === "tickets" && d.ticket)
			.sort((a, b) => a.ticket!.localeCompare(b.ticket!, undefined, { numeric: true, sensitivity: "base" }));
	const pickGraphTicketOverlay = async () => {
		const tickets = workspaceTickets();
		if (!tickets.length) return notify("No tickets found in docs/tickets/ yet.");
		const CLEAR = "__clear__";
		const currentLit = graphTicketHighlight();
		const items: QuickPickOption<string>[] = [];
		if (currentLit) {
			items.push({
				value: CLEAR,
				label: "Clear ticket highlight",
				icon: "close",
				description: `Remove ${currentLit} highlight from Call Graph`,
				divide: true,
			});
		}
		for (const t of tickets) {
			const key = t.ticket!;
			const title = t.title && !t.title.toLowerCase().startsWith(key.toLowerCase()) ? t.title : "";
			items.push({
				value: key,
				label: title ? `${key} — ${title}` : key,
				icon: "tag",
				badge: t.status ? { text: t.status, tone: toneOf(t.status) } : undefined,
				detail: relativeTo(state.workspace?.root, t.path).replace(/\\/g, "/"),
				checked: currentLit?.toLowerCase() === key.toLowerCase(),
				keywords: [key, t.title ?? "", t.status ?? ""].filter(Boolean).join(" "),
			});
		}
		const picked = await quickPick<string>({
			title: "Highlight Call Graph scripts for ticket",
			placeholder: "Filter tickets by key, title, or status…",
			items,
		});
		if (!picked) return;
		setGraphTicketHighlight(picked === CLEAR ? null : picked);
	};
	const fixPlanDriftWithAgent = async (planPath: string, curPlan: Plan, planUri?: string) => {
		const drift = driftFor(planUri ?? "");
		if (!drift.items.length) return notify("No drift between chart and code right now.");
		const planRel = relativeTo(state.workspace?.root, planPath).replace(/\\/g, "/");
		const { openAgentWithDraft } = await import("../agent/Agent");
		openAgentWithDraft(buildDriftAgentDraft(curPlan, drift.items, { planLabel: planRel }), { cleanContext: true });
	};
	const setPlanTab = (tab: "design" | "assistant") => {
		setPlanTabSignal(tab);
		setActivePlanTab(tab);
	};
	createEffect(
		() => planPaletteTabRequest(),
		(req) => {
			if (!req || req.seq <= lastHandledPlanTabSeq) return;
			lastHandledPlanTabSeq = req.seq;
			setPlanTab(req.tab);
		},
	);
	const wsRoot = createMemo(() => state.workspace?.root);
	createEffect(
		() => wsRoot(),
		() => {
			asked = "";
			askedMdSnippet = "";
			setShown(null);
			setShownMd(null);
		},
		{ defer: true },
	);
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
	const bindAutoTextarea = (value?: () => string) => {
		let el: HTMLTextAreaElement | undefined;
		let ro: ResizeObserver | undefined;
		const refit = () => {
			if (el) fitTextarea(el);
		};
		if (value) {
			createEffect(
				() => value(),
				() => {
					queueMicrotask(refit);
				},
			);
		}
		onCleanup(() => ro?.disconnect());
		return (nextEl: HTMLTextAreaElement) => {
			el = nextEl;
			ro?.disconnect();
			ro = undefined;
			queueMicrotask(refit);
			if (typeof ResizeObserver !== "undefined") {
				let lastWidth = -1;
				ro = new ResizeObserver((entries) => {
					const w = Math.round(entries[0]?.contentRect.width ?? 0);
					if (w > 0 && w !== lastWidth) {
						lastWidth = w;
						refit();
					}
				});
				ro.observe(nextEl);
			}
		};
	};
	const DraftInput = (props: {
		value: string;
		resetKey?: string;
		placeholder?: string;
		list?: string;
		onKeyDown?: (e: KeyboardEvent) => void;
		onCommit: (value: string) => void;
	}) => {
		const [draft, setDraft] = createSignal(untrack(() => props.value));
		let reverted = false;
		let disposed = false;
		onCleanup(() => {
			disposed = true;
		});
		const syncVal = createMemo(
			() => ({ key: props.resetKey ?? "", value: props.value }),
			{ equals: (a, b) => a.key === b.key && a.value === b.value },
		);
		createEffect(syncVal, ({ value }) => {
			setDraft(value);
		});
		return (
			<input
				value={draft()}
				placeholder={props.placeholder}
				list={props.list}
				onFocus={() => {
					reverted = false;
				}}
				onKeyDown={(e) => {
					if (e.key === "Escape" && !e.isComposing && e.keyCode !== 229) {
						e.preventDefault();
						e.stopPropagation();
						reverted = true;
						const el = e.currentTarget;
						const cur = untrack(() => props.value);
						setDraft(cur);
						el.value = cur;
						el.blur();
						return;
					}
					props.onKeyDown?.(e);
				}}
				onInput={(e) => {
					reverted = false;
					setDraft(e.currentTarget.value);
				}}
				onChange={(e) => {
					if (reverted) {
						reverted = false;
						return;
					}
					const el = e.currentTarget;
					props.onCommit(el.value);
					onSettled(() => {
						if (disposed) return;
						const cur = untrack(() => props.value);
						setDraft(cur);
						if (el.value !== cur) el.value = cur;
					});
				}}
			/>
		);
	};
	const DraftTextarea = (props: {
		value: string;
		resetKey?: string;
		rows?: number;
		placeholder?: string;
		onCommit: (value: string) => void;
	}) => {
		const [draft, setDraft] = createSignal(untrack(() => props.value));
		let reverted = false;
		let disposed = false;
		onCleanup(() => {
			disposed = true;
		});
		const syncVal = createMemo(
			() => ({ key: props.resetKey ?? "", value: props.value }),
			{ equals: (a, b) => a.key === b.key && a.value === b.value },
		);
		createEffect(syncVal, ({ value }) => {
			setDraft(value);
		});
		return (
			<textarea
				ref={bindAutoTextarea(draft)}
				rows={props.rows}
				value={draft()}
				placeholder={props.placeholder}
				onFocus={() => {
					reverted = false;
				}}
				onKeyDown={(e) => {
					if (e.key === "Escape" && !e.isComposing && e.keyCode !== 229) {
						e.preventDefault();
						e.stopPropagation();
						reverted = true;
						const el = e.currentTarget;
						const cur = untrack(() => props.value);
						setDraft(cur);
						el.value = cur;
						fitTextarea(el);
						el.blur();
					}
				}}
				onInput={(e) => {
					reverted = false;
					setDraft(e.currentTarget.value);
					fitTextarea(e.currentTarget);
				}}
				onChange={(e) => {
					if (reverted) {
						reverted = false;
						return;
					}
					const el = e.currentTarget;
					props.onCommit(el.value);
					onSettled(() => {
						if (disposed) return;
						const cur = untrack(() => props.value);
						setDraft(cur);
						if (el.value !== cur) {
							el.value = cur;
							fitTextarea(el);
						}
					});
				}}
			/>
		);
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
				<Show when={!graphBridge() && !planBridge() && activeMdPath()}>
					<IconButton label="Collapse all" title="Collapse all sections" icon="collapse-all" onClick={() => setFolds(MD_PALETTE_FOLDS, true)} />
					<IconButton label="Expand all" title="Expand all sections" icon="expand-all" onClick={() => setFolds(MD_PALETTE_FOLDS, false)} />
				</Show>
			</div>
			<Show
				when={graphBridge()}
				keyed
				fallback={
					<Show
						when={planBridge()}
						keyed
						fallback={
							<Show
								when={activeMdPath()}
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
										<div class="palette-preview-dock">
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
										</div>
									</>
								}
							>
								<>
									<p class="hint">Click a template, callout, or block to insert it at the cursor. Project templates live in docs/templates/.</p>
									<Rows label="Markdown templates and blocks">
										<RowGroup fold="palette:md:templates" label="Templater templates" count={(mdTemplates() ?? []).length} head="Templater templates">
											<For each={mdTemplates() ?? []}>
												{(tpl) => (
													<Row
														class="tree-row palette-item"
														key={`mdtpl:${tpl.id}`}
														onActivate={() => void insertMarkdownTemplate(tpl)}
														onFocus={() => setShownMd({ kind: "template", tpl })}
														onPoint={() => setShownMd({ kind: "template", tpl })}
														title={`${tpl.name}: ${tpl.description}`}
													>
														<Icon name="notebook-template" class="icon" />
														<span class="label">{tpl.name}</span>
														<span class="meta">{tpl.source === "workspace" ? "Custom" : tpl.group}</span>
													</Row>
												)}
											</For>
											<Row
												class="tree-row palette-item"
												key="mdtpl:new-note"
												onActivate={() => void newNoteFromTemplate()}
												onFocus={() =>
													setShownMd({
														kind: "item",
														title: "New note from template",
														badge: "Ctrl+Alt+N",
														desc: "Pick any built-in or workspace template, answer its Templater prompts, and create a new Markdown file.",
														preview: "---\ntitle: <% tp.file.title %>\ncreated: <% tp.date.now(\"YYYY-MM-DD\") %>\n---\n\n# <% tp.file.title %>",
														actionLabel: "Create…",
														onAction: () => void newNoteFromTemplate(),
													})
												}
												onPoint={() =>
													setShownMd({
														kind: "item",
														title: "New note from template",
														badge: "Ctrl+Alt+N",
														desc: "Pick any built-in or workspace template, answer its Templater prompts, and create a new Markdown file.",
														preview: "---\ntitle: <% tp.file.title %>\ncreated: <% tp.date.now(\"YYYY-MM-DD\") %>\n---\n\n# <% tp.file.title %>",
														actionLabel: "Create…",
														onAction: () => void newNoteFromTemplate(),
													})
												}
												title="Create a new document from any workspace or built-in template (Ctrl+Alt+N)"
											>
												<Icon name="new-file" class="icon" />
												<span class="label">New note from template…</span>
											</Row>
											<Row
												class="tree-row palette-item"
												key="mdtpl:manage"
												onActivate={() => void manageTemplates()}
												onFocus={() =>
													setShownMd({
														kind: "item",
														title: "Customize or create template",
														badge: "docs/templates/",
														desc: "Copy a built-in template into docs/templates/ to edit it for your team, or create a brand-new Templater file.",
														preview: "docs/templates/\n  my-template.md",
														actionLabel: "Manage…",
														onAction: () => void manageTemplates(),
													})
												}
												onPoint={() =>
													setShownMd({
														kind: "item",
														title: "Customize or create template",
														badge: "docs/templates/",
														desc: "Copy a built-in template into docs/templates/ to edit it for your team, or create a brand-new Templater file.",
														preview: "docs/templates/\n  my-template.md",
														actionLabel: "Manage…",
														onAction: () => void manageTemplates(),
													})
												}
												title="Create a custom template or copy a built-in one into docs/templates/"
											>
												<Icon name="edit" class="icon" />
												<span class="label">Customize / create template…</span>
											</Row>
										</RowGroup>
										<RowGroup fold="palette:md:callouts" label="Callouts" count={CALLOUT_PRESETS.length} head="Callouts">
											<For each={CALLOUT_PRESETS}>
												{(preset) => {
													const previewCallout = () =>
														setShownMd({
															kind: "item",
															title: `${preset.label} callout`,
															badge: `[!${preset.type}]`,
															desc: preset.about,
															preview: `> [!${preset.type}] ${preset.label}\n> Write callout details here.`,
															actionLabel: "Insert",
															onAction: () => void insertCalloutInteractive(preset.type),
														});
													return (
														<Row
															class="tree-row palette-item"
															key={`callout:${preset.type}`}
															onActivate={() => void insertCalloutInteractive(preset.type)}
															onFocus={previewCallout}
															onPoint={previewCallout}
															title={preset.about}
														>
															<Icon name={preset.type === "important" ? "megaphone" : preset.type === "warning" ? "warning" : preset.type === "caution" ? "report" : preset.type === "tip" ? "lightbulb" : preset.type === "question" ? "question" : preset.type === "todo" ? "checklist" : "note"} class="icon" />
															<span class="label">{preset.label}</span>
															<span class="meta">{"[!" + preset.type + "]"}</span>
														</Row>
													);
												}}
											</For>
										</RowGroup>
										<RowGroup fold="palette:md:blocks" label="Insert blocks" count={3} head="Insert blocks">
											<Row
												class="tree-row palette-item"
												key="md:table"
												onActivate={() => void insertTableInMd()}
												onFocus={() =>
													setShownMd({
														kind: "item",
														title: "Table (3 × 2)",
														badge: "Tab / Enter",
														desc: "Insert an interactive 3-column table with Tab/Enter cell navigation, sorting, and column alignment controls.",
														preview: MD_TABLE_PREVIEW,
														actionLabel: "Insert",
														onAction: () => void insertTableInMd(),
													})
												}
												onPoint={() =>
													setShownMd({
														kind: "item",
														title: "Table (3 × 2)",
														badge: "Tab / Enter",
														desc: "Insert an interactive 3-column table with Tab/Enter cell navigation, sorting, and column alignment controls.",
														preview: MD_TABLE_PREVIEW,
														actionLabel: "Insert",
														onAction: () => void insertTableInMd(),
													})
												}
												title="Insert a 3×2 table with Tab/Enter navigation and floating table toolbar"
											>
												<Icon name="table" class="icon" />
												<span class="label">Table (3 × 2)</span>
												<span class="meta">Tab / Enter</span>
											</Row>
											<Row
												class="tree-row palette-item"
												key="md:image"
												onActivate={() => void insertImageInteractive()}
												onFocus={() =>
													setShownMd({
														kind: "item",
														title: "Image",
														badge: "Paste / drop",
														desc: "Pick an existing workspace image, browse files, or enter a URL. You can also paste or drop images straight into Live view.",
														preview: MD_IMAGE_PREVIEW,
														actionLabel: "Choose…",
														onAction: () => void insertImageInteractive(),
													})
												}
												onPoint={() =>
													setShownMd({
														kind: "item",
														title: "Image",
														badge: "Paste / drop",
														desc: "Pick an existing workspace image, browse files, or enter a URL. You can also paste or drop images straight into Live view.",
														preview: MD_IMAGE_PREVIEW,
														actionLabel: "Choose…",
														onAction: () => void insertImageInteractive(),
													})
												}
												title="Insert a workspace image or URL (or paste/drop directly into Live view)"
											>
												<Icon name="file-media" class="icon" />
												<span class="label">Image…</span>
												<span class="meta">Paste / drop</span>
											</Row>
											<Row
												class="tree-row palette-item"
												key="md:mermaid"
												onActivate={() => void insertMermaidInMd()}
												onFocus={() =>
													setShownMd({
														kind: "item",
														title: "Mermaid diagram",
														badge: "flowchart",
														desc: "Insert a fenced Mermaid diagram block rendered live inline as an interactive SVG diagram.",
														preview: MD_MERMAID_PREVIEW,
														actionLabel: "Insert",
														onAction: () => void insertMermaidInMd(),
													})
												}
												onPoint={() =>
													setShownMd({
														kind: "item",
														title: "Mermaid diagram",
														badge: "flowchart",
														desc: "Insert a fenced Mermaid diagram block rendered live inline as an interactive SVG diagram.",
														preview: MD_MERMAID_PREVIEW,
														actionLabel: "Insert",
														onAction: () => void insertMermaidInMd(),
													})
												}
												title="Insert a Mermaid diagram block rendered inline"
											>
												<Icon name="graph" class="icon" />
												<span class="label">Mermaid diagram</span>
												<span class="meta">flowchart</span>
											</Row>
										</RowGroup>
										<Show when={keptSnippets().length}>
											<RowGroup fold="palette:md:snippets" label="Kept snippets" count={keptSnippets().length} head="Kept snippets">
												<For each={keptSnippets()}>
													{(file) => (
														<Row
															class="tree-row palette-item kept"
															key={file.path}
															onActivate={() => void insertSnippet(file)}
															onFocus={() => showMdSnippet(file)}
															onPoint={() => showMdSnippet(file)}
															title={[file.title || file.name, file.summary, file.path].filter(Boolean).join("\n")}
														>
															<span class="label">{file.title || file.name}</span>
															<span class="meta">{/\.sql$/i.test(file.name) ? "SQL" : /\.(ssl|srvscr|ds)$/i.test(file.name) ? "SSL" : ""}</span>
														</Row>
													)}
												</For>
											</RowGroup>
										</Show>
									</Rows>
									<div class="palette-preview-dock">
										<SectionSplitter label="Height of the preview" value={previewH()} min={80} max={440} onDrag={resizePreview} onReset={resetPreview} />
										<div class="palette-preview" role="region" aria-label="Palette item preview" style={{ height: `${previewH()}px` }}>
											<Show
												when={shownMd()}
												keyed
												fallback={<p class="hint">Point at any template, callout, block, or snippet above to preview what it inserts.</p>}
											>
												{(item) => {
													if (item.kind === "template") {
														const tpl = item.tpl;
														return (
															<>
																<div class="palette-preview-head">
																	<strong>{tpl.name}</strong>
																	<span class="spacer" />
																	<button class="link" title="Insert this template at the cursor" onClick={() => void insertMarkdownTemplate(tpl)}>
																		Insert
																	</button>
																	<button class="link" title="Create a new file from this template" onClick={() => void newNoteFromTemplate(tpl)}>
																		New note
																	</button>
																	<Show
																		when={tpl.path}
																		fallback={
																			<button class="link" title="Save an editable copy into docs/templates/" onClick={() => void manageTemplates(tpl)}>
																				Customize
																			</button>
																		}
																	>
																		<button class="link" title="Open this custom template to edit it" onClick={() => void openFile(tpl.path!)}>
																			Edit
																		</button>
																	</Show>
																</div>
																<Show when={tpl.description}>
																	<p class="palette-preview-desc">{tpl.description}</p>
																</Show>
																<pre>{tpl.content}</pre>
															</>
														);
													}
													if (item.kind === "snippet") {
														const file = item.file;
														return (
															<>
																<div class="palette-preview-head">
																	<strong>{file.title || file.name}</strong>
																	<span class="spacer" />
																	<button class="link" title="Insert this snippet as a fenced code block" onClick={() => void insertSnippet(file)}>
																		Insert
																	</button>
																	<Show when={item.text}>
																		<button class="link" title="Copy the snippet" onClick={() => void copy(item.text!)}>
																			Copy
																		</button>
																	</Show>
																	<button class="link" title="Open the snippet's file" onClick={() => void openFile(file.path)}>
																		Open
																	</button>
																</div>
																<Show when={item.note}>
																	<p class="palette-preview-desc">{item.note}</p>
																</Show>
																<pre>{item.text === null ? "Loading snippet…" : item.text}</pre>
															</>
														);
													}
													return (
														<>
															<div class="palette-preview-head">
																<strong>{item.title}</strong>
																<Show when={item.badge}>
																	<span class="hint">{item.badge}</span>
																</Show>
																<Show when={item.actionLabel && item.onAction}>
																	<span class="spacer" />
																	<button class="link" onClick={() => item.onAction!()}>
																		{item.actionLabel}
																	</button>
																</Show>
															</div>
															<p class="palette-preview-desc">{item.desc}</p>
															<pre>{item.preview}</pre>
														</>
													);
												}}
											</Show>
										</div>
									</div>
								</>
							</Show>
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
											aria-selected={planTab() === "design" ? "true" : "false"}
											class={{ on: planTab() === "design" }}
											onClick={() => setPlanTab("design")}
										>
											Design
										</button>
										<button
											type="button"
											role="tab"
											aria-selected={planTab() === "assistant" ? "true" : "false"}
											class={{ on: planTab() === "assistant" }}
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
											const selectedId = createMemo(() => plan.selectedId());
											createEffect(
												() => selectedId(),
												() => {
													setSelectedShapesExpanded(false);
													setDocPickerOpen(false);
													setDocPickerQuery("");
													setDocPickerIdx(0);
													queueMicrotask(syncDock);
												},
											);
											createEffect(
												() => [shapesCollapsed(), nodeImplOpen(), planImplOpen(), nodeTestsOpen(), planTestsOpen()] as const,
												() => {
													queueMicrotask(syncDock);
												},
											);
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
											const renderRail = (className: string, visible: () => boolean) => (
												<div
													class={[className, { visible: visible() }]}
													role="toolbar"
													aria-label="Process shapes"
													aria-hidden={visible() ? "false" : "true"}
												>
													<For each={PLAN_SHAPES}>
														{(shape) => (
															<button
																type="button"
																class={["plan-dock-btn", { active: Boolean(shape.active?.(plan)) }]}
																tabindex={visible() ? 0 : -1}
																draggable={shape.dragKind ? "true" : "false"}
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
														tabindex={visible() ? 0 : -1}
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
													<Show when={shapesCollapsed()}>{renderRail("plan-shape-rail", () => true)}</Show>

													{/* Scroll-triggered top icon rail when Process shapes is expanded and scrolled out of view. */}
													<Show when={!shapesCollapsed()}>{renderRail("plan-shape-dock", shapesScrolled)}</Show>

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
																				class={[
																					"plan-shape-tile",
																					{
																						active: Boolean(shape.active?.(plan)),
																						wide: shape.id === "plan-connect",
																					},
																				]}
																				draggable={shape.dragKind ? "true" : "false"}
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
															fallback={
																<Show when={p()}>
																	{(curPlan) => (
																		<div class="plan-inspector">
																			<section class="plan-prop-section" aria-label="Plan details">
																				<div class="plan-section-kicker">Plan</div>
																				<div class="plan-prop-fields">
																					<label class="plan-prop-field">
																						<span>Title</span>
																						<DraftInput
																							resetKey={plan.path}
																							value={curPlan().title ?? ""}
																							onKeyDown={commitOnEnter}
																							onCommit={(val) => plan.setPlanField("title", val)}
																						/>
																					</label>
																					<label class="plan-prop-field">
																						<span>Goal</span>
																						<DraftTextarea
																							resetKey={plan.path}
																							rows={2}
																							value={goalText()}
																							placeholder="What this process should achieve"
																							onCommit={(val) => plan.setPlanField("goal", val)}
																						/>
																					</label>
																					<label
																						class="plan-prop-field"
																						title="The ticket this plan is for. The agent uses its goals, open questions, and decisions when refining or building."
																					>
																						<span>Ticket</span>
																						<div class="plan-ticket-row">
																							<DraftInput
																								resetKey={plan.path}
																								value={typeof curPlan().ticket === "string" ? (curPlan().ticket as string) : ""}
																								placeholder="LIMS-123"
																								onKeyDown={commitOnEnter}
																								onCommit={(val) => plan.setPlanField("ticket", val)}
																							/>
																							<Show when={ticketDoc()}>
																								{(td) => (
																									<IconButton
																										label={`Open ticket ${td().ticket}`}
																										title={`Open ${td().ticket}${td().title ? `: ${td().title}` : ""}`}
																										icon="go-to-file"
																										onClick={() => void openFile(td().path)}
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

																			<div class="plan-build-bar">
																				<button
																					type="button"
																					class="plan-sched-btn"
																					title="Implement this plan with Agent or run the spec build"
																					onClick={() => plan.triggerScheduledBuild({ kind: "plan", label: curPlan().title || "this plan" })}
																				>
																					<Icon name="tools" />
																					<span>Implement with Agent</span>
																				</button>
																				<Show when={driftFor(plan.planUri() ?? "").items.length > 0}>
																					<button
																						type="button"
																						class="plan-sched-btn"
																						title="Reconcile chart and code drift with Agent"
																						onClick={() => void fixPlanDriftWithAgent(plan.path, curPlan(), plan.planUri())}
																					>
																						<Icon name="warning" />
																						<span>Fix drift with Agent</span>
																					</button>
																				</Show>
																				<button
																					type="button"
																					class="plan-assist-jump"
																					title="Open the Assistant tab"
																					onClick={() => setPlanTab("assistant")}
																				>
																					<Icon name="sparkle" />
																					<span>Assistant</span>
																				</button>
																			</div>

																			<PlanTests
																				plan={curPlan()}
																				allPaths={plan.allPaths()}
																				activePathIndex={plan.activePathIndex()}
																				open={planTestsOpen()}
																				onToggle={() => setPlanTestsOpen((o) => !o)}
																				onHighlightPath={(idx) => plan.setActivePathIndex(idx)}
																				onStepPath={(by) => plan.stepActivePath(by)}
																				onJumpToNode={(id) => plan.jumpToNode(id)}
																				onPeekNode={(id, opts) => plan.peekNode(id, opts)}
																				onOpenTextBuilder={(opts) => plan.openTextTestBuilder(opts)}
																				onOpenScript={(script) => plan.openScript(script)}
																				onAddTestCase={(input) => plan.addTestCase(input)}
																				onUpdateTestCase={(id, patch) => plan.updateTestCase(id, patch)}
																				onRemoveTestCase={(id) => plan.removeTestCase(id)}
																				onTriggerScheduled={(scope) => plan.triggerScheduledBuild(scope)}
																			/>

																			<PlanImplementation
																				plan={curPlan()}
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
																const displayKind = () => (node().kind === "call" ? "step" : node().kind);
																const heading = () => `Selected ${displayKind()}`;
																const iconName = (): IconName =>
																	displayKind() === "decision"
																		? "git-branch"
																		: displayKind() === "end"
																			? "pass-filled"
																			: "play";
																const codeState = () => plan.codeStateOf(node().id);
																const actionable = () => node().kind !== "start" && node().kind !== "end";
																const linkedDocs = () =>
																	nodeDocsOf(node()).map((ref) => {
																		const doc = resolveLinkedDoc(ref);
																		const label = doc ? docDisplayName(doc) : baseName(ref) || ref;
																		const kind = doc ? docKindTag(doc) : "";
																		const tooltip = doc ? `Open ${kind}: ${docRelPath(doc)}` : `${ref} (not found in workspace)`;
																		return { ref, doc, label, kind, tooltip };
																	});
																const linkedSet = () => {
																	const set = new Set<string>();
																	for (const item of linkedDocs()) {
																		set.add(item.ref.toLowerCase());
																		if (item.doc) set.add(docRelPath(item.doc).toLowerCase());
																	}
																	return set;
																};
																const filteredLinkableDocs = () => {
																	const already = linkedSet();
																	const q = docPickerQuery().trim().toLowerCase();
																	return linkableWorkspaceDocs().filter((d) => {
																		const relPath = docRelPath(d);
																		if (already.has(relPath.toLowerCase())) return false;
																		if (!q) return true;
																		return (
																			docDisplayName(d).toLowerCase().includes(q) ||
																			relPath.toLowerCase().includes(q) ||
																			docKindTag(d).toLowerCase().includes(q) ||
																			(d.ticket?.toLowerCase().includes(q) ?? false)
																		);
																	});
																};
																const visibleLinkableDocs = createMemo(() => filteredLinkableDocs().slice(0, 40));
																const linkDoc = (d: DocFile) => {
																	const cur = p();
																	if (!cur) return;
																	applyText(plan.path, printPlan(addNodeDoc(cur, node().id, docRelPath(d))));
																	setDocPickerOpen(false);
																	setDocPickerQuery("");
																	setDocPickerIdx(0);
																};
																let addDocBtn: HTMLButtonElement | undefined;
																const unlinkDoc = (ref: string) => {
																	const cur = p();
																	if (!cur) return;
																	applyText(plan.path, printPlan(removeNodeDoc(cur, node().id, ref)));
																};
																const openLinkedDoc = (item: { ref: string; doc: DocFile | null }) => {
																	if (item.doc) return void openFile(item.doc.path);
																	if (state.workspace?.root) {
																		const full = joinPath(state.workspace.root, item.ref);
																		void backend.read(full).then(
																			() => void openFile(full),
																			() => notify(`Linked document "${item.ref}" was not found in this workspace.`),
																		);
																		return;
																	}
																	notify(`Linked document "${item.ref}" was not found.`);
																};
																return (
																	<div class="plan-inspector">
																		<section class="plan-prop-section plan-step-section" aria-label={heading()}>
																			<div class="plan-step-head">
																				<Icon name={iconName()} class={`plan-sel-icon ${displayKind()}`} />
																				<span class="plan-prop-title">{heading()}</span>
																				<span class="spacer" />
																				<IconButton label={`Close ${heading().toLowerCase()}`} title="Back to plan details (Esc)" icon="close" onClick={() => plan.clearSelection()} />
																			</div>
																			<Show when={actionable()}>
																				<div class="plan-step-status-row">
																					<span
																						class={`plan-code-badge ${codeState()}`}
																						title={CODE_INDICATOR_WORDS[codeState()].detail}
																					>
																						<span class={`plan-status-dot ${codeState()}`} aria-hidden="true" />
																						<span>{CODE_INDICATOR_WORDS[codeState()].label}</span>
																					</span>
																					<span class="spacer" />
																					<button
																						type="button"
																						class="plan-sched-btn compact"
																						title={
																							codeState() === "yellow"
																								? "Reconcile drift for this step with Agent"
																								: "Build or update code for this step with Agent"
																						}
																						onClick={() => {
																							const cur = p();
																							if (codeState() === "yellow" && cur && driftFor(plan.planUri() ?? "").items.length > 0) {
																								void fixPlanDriftWithAgent(plan.path, cur, plan.planUri());
																							} else {
																								const curNode = node();
																								plan.triggerScheduledBuild({
																									kind: "node",
																									id: curNode.id,
																									label: curNode.text.trim() || curNode.id,
																								});
																							}
																						}}
																					>
																						<Icon name={codeState() === "yellow" ? "warning" : "tools"} />
																						<span>
																							{codeState() === "yellow"
																								? "Fix drift with Agent"
																								: codeState() === "grey"
																									? "Implement with Agent"
																									: "Rebuild with Agent"}
																						</span>
																					</button>
																				</div>
																				<div class="plan-dir-switch plan-kind-switch" role="group" aria-label="Shape kind">
																					<For each={(["step", "decision"] as NodeKind[])}>
																						{(k) => (
																							<button
																								type="button"
																								class={{ on: displayKind() === k }}
																								aria-pressed={displayKind() === k ? "true" : "false"}
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
																					<DraftInput
																						resetKey={node().id}
																						value={node().text}
																						placeholder="Describe this step"
																						onKeyDown={commitOnEnter}
																						onCommit={(val) => plan.setNodeText(val)}
																					/>
																				</label>
																				<label class="plan-prop-field">
																					<span>Stage</span>
																					<DraftInput
																						resetKey={node().id}
																						value={plan.groupName()}
																						list="plan-palette-groups"
																						placeholder="None (unassigned)"
																						onKeyDown={commitOnEnter}
																						onCommit={(val) => plan.setNodeGroup(val)}
																					/>
																				</label>
																				<datalist id="plan-palette-groups">
																					<For each={p()?.groups ?? []}>{(g) => <option value={g.name} />}</For>
																				</datalist>
																				<label class="plan-prop-field">
																					<span>Notes</span>
																					<DraftTextarea
																						resetKey={node().id}
																						rows={2}
																						value={node().notes ?? ""}
																						placeholder="Business rules, exceptions, or context"
																						onCommit={(val) => plan.setNodeField("notes", val)}
																					/>
																				</label>
																				<div class="plan-prop-field plan-node-docs">
																					<div class="plan-node-docs-head">
																						<span>Linked docs</span>
																						<button
																							ref={addDocBtn}
																							type="button"
																							class="plan-node-doc-add"
																							aria-expanded={docPickerOpen() ? "true" : "false"}
																							title="Link a decision, question, reference, snippet, spec, schema, registry, or ticket to this step"
																							onClick={() => {
																								setDocPickerOpen((o) => !o);
																								setDocPickerQuery("");
																								setDocPickerIdx(0);
																							}}
																						>
																							+ Link doc…
																						</button>
																					</div>
																					<Show when={linkedDocs().length > 0}>
																						<div class="plan-node-doc-chips">
																							<For each={linkedDocs()}>
																								{(item) => (
																									<span class={["plan-node-doc-chip", { missing: !item.doc }]}>
																										<button
																											type="button"
																											class="plan-node-doc-open"
																											title={item.tooltip}
																											onClick={() => openLinkedDoc(item)}
																										>
																											<Show when={item.kind}>
																												<span class="plan-node-doc-kind">{item.kind}</span>
																											</Show>
																											<span class="plan-node-doc-label">{item.label}</span>
																										</button>
																										<button
																											type="button"
																											class="plan-node-doc-remove"
																											title={`Remove link to ${item.label}`}
																											aria-label={`Remove ${item.label}`}
																											onClick={() => unlinkDoc(item.ref)}
																										>
																											<Icon name="close" />
																										</button>
																									</span>
																								)}
																							</For>
																						</div>
																					</Show>
																					<Show when={docPickerOpen()}>
																						<div class="plan-doc-picker" role="region" aria-label="Link a document">
																							<input
																								class="plan-doc-picker-input"
																								value={docPickerQuery()}
																								placeholder="Filter decisions, questions, specs, schemas, registries, tickets…"
																								aria-label="Filter documents to link"
																								ref={(el) => queueMicrotask(() => el.focus())}
																								onInput={(e) => {
																									setDocPickerQuery(e.currentTarget.value);
																									setDocPickerIdx(0);
																								}}
																								onKeyDown={(e) => {
																									const opts = visibleLinkableDocs();
																									if (e.key === "Escape") {
																										e.preventDefault();
																										e.stopPropagation();
																										setDocPickerOpen(false);
																										queueMicrotask(() => addDocBtn?.focus());
																									} else if (e.key === "ArrowDown") {
																										e.preventDefault();
																										if (opts.length) setDocPickerIdx((i) => (i + 1) % opts.length);
																									} else if (e.key === "ArrowUp") {
																										e.preventDefault();
																										if (opts.length) setDocPickerIdx((i) => (i - 1 + opts.length) % opts.length);
																									} else if (e.key === "Enter") {
																										e.preventDefault();
																										const picked = opts[Math.min(docPickerIdx(), opts.length - 1)];
																										if (picked) linkDoc(picked);
																									}
																								}}
																							/>
																							<Show
																								when={visibleLinkableDocs().length > 0}
																								fallback={
																									<p class="hint plan-doc-picker-empty">
																										{docPickerQuery().trim()
																											? "No matching documents."
																											: "No unlinked workspace docs available to link."}
																									</p>
																								}
																							>
																								<ul class="plan-doc-picker-list" role="listbox" aria-label="Workspace documents">
																									<For each={visibleLinkableDocs()}>
																										{(doc, i) => (
																											<li>
																												<button
																													type="button"
																													role="option"
																													aria-selected={docPickerIdx() === i() ? "true" : "false"}
																													class={["plan-doc-picker-item", { active: docPickerIdx() === i() }]}
																													title={docRelPath(doc)}
																													onMouseEnter={() => setDocPickerIdx(i())}
																													onClick={() => linkDoc(doc)}
																												>
																													<span class="plan-node-doc-kind">{docKindTag(doc)}</span>
																													<span class="plan-doc-picker-name">{docDisplayName(doc)}</span>
																												</button>
																											</li>
																										)}
																									</For>
																								</ul>
																							</Show>
																						</div>
																					</Show>
																				</div>
																			</div>
																			<Show when={p()}>
																				{(curPlan) => (
																					<>
																						<NodeTests
																							plan={curPlan()}
																							node={node()}
																							allPaths={plan.allPaths()}
																							activePathIndex={plan.activePathIndex()}
																							open={nodeTestsOpen()}
																							onToggle={() => setNodeTestsOpen((o) => !o)}
																							onHighlightPath={(idx) => plan.setActivePathIndex(idx)}
																							onJumpToNode={(id) => plan.jumpToNode(id)}
																							onPeekNode={(id, opts) => plan.peekNode(id, opts)}
																							onOpenTextBuilder={(opts) => plan.openTextTestBuilder(opts)}
																							onOpenScript={(script) => plan.openScript(script)}
																							onAddTestCase={(input) => plan.addTestCase(input)}
																							onUpdateTestCase={(id, patch) => plan.updateTestCase(id, patch)}
																							onRemoveTestCase={(id) => plan.removeTestCase(id)}
																							onTriggerScheduled={(scope) => plan.triggerScheduledBuild(scope)}
																						/>
																						<NodeImplementation
																							plan={curPlan()}
																							planUri={plan.planUri()}
																							node={node()}
																							open={nodeImplOpen()}
																							onToggle={() => setNodeImplOpen((o) => !o)}
																							onOpenUnit={(unit) => plan.openCodeUnit(unit)}
																							onOpenRef={(ref) => plan.openReference(ref)}
																							onOpenScript={(script, line) => plan.openScript(script, line)}
																						/>
																					</>
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
											allPaths={plan.allPaths()}
											activePathIndex={plan.activePathIndex()}
											onSetActivePathIndex={(idx) => plan.setActivePathIndex(idx)}
											onStepActivePath={(by) => plan.stepActivePath(by)}
											codeCounts={plan.codeStatusCounts()}
											nodesByCodeState={(kind) => plan.nodesByCodeState(kind)}
											scheduledNotice={plan.scheduledNotice()}
											onClearScheduledNotice={() => plan.clearScheduledNotice()}
											onTriggerScheduled={(scope) => plan.triggerScheduledBuild(scope)}
											onAddTestCase={(input) => plan.addTestCase(input)}
											onUpdateTestCase={(id, patch) => plan.updateTestCase(id, patch)}
											onRemoveTestCase={(id) => plan.removeTestCase(id)}
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
							<Show when={Boolean(state.settings.activeTicket?.trim() || graphTicketHighlight() || workspaceTickets().length > 0)}>
								{(() => {
									const activeKey = () => state.settings.activeTicket?.trim() || "";
									const litKey = () => graphTicketHighlight()?.trim() || "";
									const targetKey = () => litKey() || activeKey();
									const litCount = () => graphHighlightedCount();
									return (
										<RowGroup head="Ticket overlay">
											<Show when={activeKey()}>
												{(key) => {
													const isOn = () => litKey().toLowerCase() === key().toLowerCase();
													return (
														<Row
															class="tree-row palette-item plan-shape-item"
															classList={{ active: isOn() }}
															key="graph:ticket-active"
															onActivate={() => setGraphTicketHighlight(isOn() ? null : key())}
															title={
																isOn()
																	? `Clear ${key()} highlight in Call Graph`
																	: `Highlight scripts governed by active ticket ${key()} (includes sub-tickets)`
															}
														>
															<Icon name="tag" class="icon" />
															<span class="label">Highlight {key()}</span>
															<span class="meta">
																{isOn() ? `${litCount()} ${litCount() === 1 ? "script" : "scripts"}` : "Off"}
															</span>
														</Row>
													);
												}}
											</Show>
											<Show when={litKey() && litKey().toLowerCase() !== activeKey().toLowerCase()}>
												<Row
													class="tree-row palette-item plan-shape-item active"
													key="graph:ticket-clear"
													onActivate={() => setGraphTicketHighlight(null)}
													title={`Clear ${litKey()} highlight in Call Graph`}
												>
													<Icon name="close" class="icon" />
													<span class="label">Clear {litKey()} highlight</span>
													<span class="meta">{`${litCount()} ${litCount() === 1 ? "script" : "scripts"}`}</span>
												</Row>
											</Show>
											<Show when={targetKey()}>
												{(key) => (
													<Row
														class="tree-row palette-item plan-shape-item"
														classList={{ active: graphTicketSubgraph() }}
														key="graph:ticket-subgraph"
														onActivate={() => {
															const next = !graphTicketSubgraph();
															if (next && !litKey()) setGraphTicketHighlight(key());
															setGraphTicketSubgraph(next);
														}}
														title={
															graphTicketSubgraph()
																? `Showing only ${key()} scripts + 1-hop neighbors. Click to show full workspace graph.`
																: `Filter Call Graph to ${key()} scripts plus 1-hop callers and callees`
														}
													>
														<Icon name={graphTicketSubgraph() ? "filter-filled" : "filter"} class="icon" />
														<span class="label">Filter to ticket (+ 1-hop)</span>
														<span class="meta">{graphTicketSubgraph() ? "On" : "Off"}</span>
													</Row>
												)}
											</Show>
											<Row
												class="tree-row palette-item plan-shape-item"
												key="graph:ticket-impact"
												onActivate={() => requestGraphTicketImpact(targetKey() || undefined)}
												title={
													targetKey()
														? `Run transitive Impact / Blast-Radius Analysis across all scripts for ${targetKey()}`
														: "Pick a ticket to run transitive Impact / Blast-Radius Analysis"
												}
											>
												<Icon name="flame" class="icon" />
												<span class="label">
													{targetKey() ? `Impact / Blast-Radius (${targetKey()})…` : "Impact / Blast-Radius…"}
												</span>
											</Row>
											<Show when={workspaceTickets().length > 0}>
												<Row
													class="tree-row palette-item plan-shape-item"
													key="graph:ticket-pick"
													onActivate={() => void pickGraphTicketOverlay()}
													title="Pick any workspace ticket to highlight its scripts in Call Graph (includes sub-tickets)"
												>
													<Icon name="filter" class="icon" />
													<span class="label">{litKey() ? "Switch ticket…" : "Pick ticket…"}</span>
													<span class="meta">{workspaceTickets().length}</span>
												</Row>
											</Show>
										</RowGroup>
									);
								})()}
							</Show>
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
