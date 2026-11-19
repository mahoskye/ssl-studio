// A plan as a flow chart, laid out by ELK. A view of the plan's text: every
// action is one undoable text edit on the model the text view shows, and the
// selected node is the one under the text cursor (ADR 0002, ADR 0005).
import ELK from "elkjs/lib/elk.bundled.js";
import { createEffect, createMemo, createSignal, createUniqueId, For, on, onCleanup, onMount, Show, untrack } from "solid-js";
import { ask } from "../dialogs";
import { editors } from "../editor/EditorGroup";
import { monaco } from "../editor/monaco";
import { Minimap, type MapBox } from "../graph/Minimap";
import { Finder } from "../graph/Finder";
import { Menu, type MenuItem } from "../Menu";
import { pictureName, savePicture } from "../graph/picture";
import { dirName, joinPath, relativeTo } from "../../shared/paths";
import { regionColor } from "../editor/regions";
import { canvasMeasure, centredOn, clearOf, fitView, legibleScale, mapArea, nearest, outOfSight, recall, remember, reveal, roundedPath, zoomAt, type Measure, type Point } from "../graph/canvas";
import { diagnostics } from "../lsp/session";
import { documents, notify, setState, state, applyText } from "../state";
import { nodeStatuses } from "./build";
import { builtOf, chartChanges, unitsOfNode } from "./built";
import { chartGraph, crossings, routeLength, cycleEdge, describeEdge, describeNode, KEYS, labelPoint, LINE, MARK_WORDS, routeOf, sizeNode, statusMark, type ChartGraph, type Mark, type NodeState, type Sized } from "./chart";
import { recheckPlan } from "./check";
import { driftFor, openProcedure } from "./drift";
import { assistOf } from "./run";
import { PlanAssistant } from "./PlanAssistant";
import { planHash, previewPlan } from "./assist";
import { addAfter, addBranch, addCall, connect, nodeAtLine, nodeLines, parsePlan, printPlan, PROCEDURE_DRAG, removeEdge, removeNode, setDecision, setEdgeLabel, setGroup, setText, type Edit, type Plan, type PlanNode } from "./model";

type Box = { id: string; x: number; y: number; width: number; height: number; node?: PlanNode; lines: string[]; group?: string };
type Line = { id: string; from: string; to: string; label?: string; shown: string; labelWidth: number; points: Point[]; at: Point; missing: boolean; pending: boolean; removing: boolean; /** It closes a loop: it runs back up to a step already passed. */ back: boolean };
type Layout = { boxes: Box[]; lines: Line[]; width: number; height: number };

const elk = new ELK();

// The sizes the style sheet gives a node's words and an edge's label (.plan-node text, .plan-label text).
const NODE_FONT_PX = 13;
const LABEL_FONT_PX = 12;
/** Fit never draws a node's words smaller than can be read; a larger chart is panned. */
const FIT_FLOOR = legibleScale(NODE_FONT_PX);
const MIN_ZOOM = 0.2;
const MAX_ZOOM = 2.5;
/** The assistant's width (.plan-assist), and the least the chart keeps beside it before the assistant goes below. */
const ASSIST_WIDTH = 280;
const MIN_CHART_WIDTH = 360;
/** Narrower than this, the bar's six editing buttons are one menu: side by side they take a second row, and a third. */
const BAR_FITS_FROM = 1030;

/** Whether the assistant shows, as last chosen in any plan; null until it has been chosen. */
const ASSISTANT_KEY = "plan.assistant";
const [assistantChoice, setAssistantChoice] = createSignal<boolean | null>(recall(ASSISTANT_KEY) === null ? null : recall(ASSISTANT_KEY) === "open");

/**
 * Measures in the chart's own font, with a hidden <text> the style sheet styles
 * as it does the words drawn. While the chart is not on screen that reads zero,
 * and a canvas measures instead, or failing that an estimate.
 */
function probeMeasure(probe: () => SVGTextElement | undefined, fallback: Measure): Measure {
	const seen = new Map<string, number>();
	return (text) => {
		if (!text) return 0;
		const known = seen.get(text);
		if (known !== undefined) return known;
		let width = 0;
		try {
			const el = probe();
			if (el?.isConnected) {
				el.textContent = text;
				width = el.getComputedTextLength();
			}
		} catch {
			width = 0;
		}
		if (!(width > 0)) return fallback(text);
		seen.set(text, width);
		return width;
	};
}

async function layoutPlan(plan: Plan, measure: { node: Measure; label: Measure }): Promise<Layout> {
	const sized = new Map<string, Sized>();
	for (const n of plan.nodes) if (!sized.has(n.id)) sized.set(n.id, sizeNode(n.kind, n.text, measure.node));
	const east = await layoutWith(chartGraph(plan, sized), sized, measure);
	if (!east.sided) return east.layout;
	// A loop closed from a decision can leave by either side, and which is clearer depends on
	// where the layout puts the rest: both are laid out, and the one with fewer crossings is kept,
	// or of two with as many, the one with less line.
	const west = await layoutWith(chartGraph(plan, sized, "WEST"), sized, measure);
	return west.crossings < east.crossings || (west.crossings === east.crossings && west.length < east.length) ? west.layout : east.layout;
}

async function layoutWith({ graph, nodes, edges, groups, reversed, sided }: ChartGraph, sized: ReadonlyMap<string, Sized>, measure: { node: Measure; label: Measure }): Promise<{ layout: Layout; crossings: number; length: number; sided: boolean }> {
	const result: any = await elk.layout(graph as any);
	const boxes: Box[] = [];
	const walk = (n: any, ox: number, oy: number) => {
		const x = ox + (n.x ?? 0);
		const y = oy + (n.y ?? 0);
		if (n.id !== "root") {
			const node = nodes.find((p) => p.id === n.id);
			boxes.push({ id: n.id, x, y, width: n.width, height: n.height, node, lines: node ? sized.get(node.id)!.lines : [], group: node ? undefined : groups.find((g) => g.id === n.id)?.name });
		}
		for (const c of n.children ?? []) walk(c, x, y);
	};
	walk(result, 0, 0);
	const diamond = (id: string) => boxes.find((b) => b.id === id && b.node?.kind === "decision");
	const lines: Line[] = (result.edges ?? []).map((e: any) => {
		const index = Number(String(e.id).slice(1));
		const edge = edges[index]!;
		const section = e.sections?.[0];
		const points = routeOf(section ? [section.startPoint, ...(section.bendPoints ?? []), section.endPoint] : [], reversed.has(index), diamond(edge.from), diamond(edge.to));
		const missing = Boolean(diamond(edge.from)) && !edge.label?.trim();
		const shown = edge.label?.trim() || (missing ? "label?" : "");
		const labelWidth = shown ? Math.ceil(measure.label(shown)) + 12 : 0;
		return { id: e.id, from: edge.from, to: edge.to, label: edge.label, shown, labelWidth, points, at: labelPoint(points, labelWidth), missing, pending: Boolean(edge.pending), removing: Boolean(edge.removing), back: reversed.has(index) };
	});
	return { layout: { boxes, lines, width: result.width, height: result.height }, crossings: crossings(lines.map((l) => l.points)), length: routeLength(lines.map((l) => l.points)), sided };
}

/** A way out as it is drawn: its corners rounded, so that it reads as one line through each turn. */
const pathOf = (points: Point[]) => roundedPath(points, 10);

/** The glyph of a node's mark, drawn about its centre: a tick, a bang, a triangle and so on, so state does not rest on colour. */
const MARK_PATHS: Record<Mark, string> = {
	passed: "M-3.4,0.2 L-1,2.6 L3.4,-2.4",
	stuck: "M0,-3.6 L0,0.8 M0,3.5 L0,3.6",
	running: "M-3.2,0 L-3.2,0.1 M0,0 L0,0.1 M3.2,0 L3.2,0.1",
	changed: "M0,-3.4 L3.4,2.6 L-3.4,2.6 Z",
	skipped: "M-1.8,-2.8 L-1.8,2.8 M1.8,-2.8 L1.8,2.8",
	gone: "M-2.8,-2.8 L2.8,2.8 M2.8,-2.8 L-2.8,2.8",
};

/** A control someone is typing in, outside the code editor: the chart does not take the keys from it. */
function typingElsewhere() {
	const el = document.activeElement;
	return el instanceof HTMLElement && !el.closest(".monaco-editor") && el.matches("input, textarea, select, [contenteditable]:not([contenteditable='false'])");
}

export function PlanView(props: { path: string; group: number }) {
	const doc = () => documents.get(props.path);
	const [text, setTextSignal] = createSignal(doc()?.model.getValue() ?? "");
	const parsed = createMemo(() => parsePlan(text()));
	const plan = () => parsed().plan;
	const [layout, setLayout] = createSignal<Layout | null>(null);
	const [view, setView] = createSignal({ x: 20, y: 20, scale: 1 });
	const [edge, setEdge] = createSignal<{ from: string; to: string } | null>(null);
	const [linking, setLinking] = createSignal<string | null>(null);
	/** A path through the chart being shown, as its nodes in order: it is lit, and the rest steps back. */
	const [walked, setWalked] = createSignal<string[] | null>(null);
	const onPath = createMemo(() => {
		const path = walked();
		return path ? { nodes: new Set(path), ways: new Set(path.slice(1).map((to, i) => `${path[i]}>${to}`)) } : null;
	});
	/** The node the pointer is on: its ways in and out are lit. */
	const [pointed, setPointed] = createSignal<string | null>(null);
	const [keysOpen, setKeysOpen] = createSignal(false);
	/** Too narrow for the chart and the assistant side by side. */
	const [narrow, setNarrow] = createSignal(false);
	/** Too narrow for every button of the bar in one row. */
	const [compact, setCompact] = createSignal(false);
	/** What the small text box is editing, over the chart. */
	const [editing, setEditing] = createSignal<{ node: string } | { from: string; to: string } | null>(null);
	const assistantId = createUniqueId();
	const keysId = createUniqueId();
	/** The bar's editing buttons as a menu, for a chart too narrow to show them side by side. */
	const editItems = (): MenuItem[] => [
		{ label: "Add step", keys: "Enter", run: () => (addNext(), refocus()) },
		{ label: "Add branch", keys: "B", run: () => (addOther(), refocus()) },
		{ label: "Add call…", run: () => void addCallAsk() },
		{ label: "Step or decision", keys: "D", run: () => (toggleDecision(), refocus()) },
		{ label: linking() ? "Stop connecting" : "Connect to another", keys: "C", run: () => (linking() ? setLinking(null) : beginLink(), refocus()) },
		"separator",
		{ label: "Delete the selection", keys: "Delete", run: () => (remove(), refocus()) },
	];
	/** The bar's menu: what is not needed at every look. */
	const more = (): MenuItem[] => [
		{ label: keysOpen() ? "Hide the keys" : "Keys, and what the shapes mean", keys: "?", run: () => setKeysOpen((open) => !open) },
		{
			label: "Save picture…",
			run: () => void savePicture(canvas.querySelector<SVGSVGElement>("svg.graph-canvas") ?? undefined, layout(), joinPath(relativeTo(state.workspace?.root, dirName(props.path)), pictureName(plan()?.title || "plan"))),
			disabled: !layout(),
			why: "The chart is not drawn yet",
		},
	];
	let canvas!: HTMLDivElement;
	let nodeProbe: SVGTextElement | undefined;
	let labelProbe: SVGTextElement | undefined;
	let fitted = false;
	/** The view as the last fit left it: while it is still that, a change of the chart's size fits it again. */
	let fittedView: { x: number; y: number; scale: number } | null = null;
	let seen = 0;
	const measure = {
		node: probeMeasure(() => nodeProbe, canvasMeasure(`${NODE_FONT_PX}px system-ui, sans-serif`, NODE_FONT_PX)),
		label: probeMeasure(() => labelProbe, canvasMeasure(`${LABEL_FONT_PX}px system-ui, sans-serif`, LABEL_FONT_PX)),
	};

	// With no choice made, the assistant shows where there is room for it and the chart both.
	const assistantOpen = () => assistantChoice() ?? !narrow();
	const toggleAssistant = () => {
		const next = !assistantOpen();
		setAssistantChoice(next);
		remember(ASSISTANT_KEY, next ? "open" : "closed");
	};
	const watchWidth = (el: HTMLDivElement) => {
		if (typeof ResizeObserver === "undefined") return;
		// What follows from the width changes the bar's height, and so this element's: it waits for
		// the next frame, where the browser does not count it against the one being laid out.
		let frame = 0;
		const observer = new ResizeObserver((entries) => {
			const width = entries[0]?.contentRect.width ?? Infinity;
			cancelAnimationFrame(frame);
			frame = requestAnimationFrame(() => {
				setNarrow(width < ASSIST_WIDTH + MIN_CHART_WIDTH);
				setCompact(width < BAR_FITS_FROM);
				// A chart nobody has moved since it was fitted stays fitted when the window or a panel changes its room.
				if (view() === fittedView) queueMicrotask(fit);
			});
		});
		observer.observe(el);
		onCleanup(() => (cancelAnimationFrame(frame), observer.disconnect()));
	};

	/** The keys go to the chart, unless the words of a node are being edited. */
	const refocus = () => queueMicrotask(() => !editing() && canvas?.focus());
	/** After a toolbar button: a click hands the keys back to the chart; a button pressed from the keyboard keeps its focus. */
	const after = (e: MouseEvent) => {
		if (e.detail > 0) refocus();
	};

	onMount(() => {
		const model = doc()?.model;
		if (!model) return;
		const sub = model.onDidChangeContent(() => setTextSignal(model.getValue()));
		onCleanup(() => sub.dispose());
		// A file may have gone or changed on disk while this was not showing.
		recheckPlan(model.uri.toString());
		// A plan opens ready for the keyboard, as a script does, but not out from under someone typing or a dialog.
		queueMicrotask(() => !typingElsewhere() && !document.querySelector(".overlay") && canvas?.focus());
	});

	let layoutRun = 0;
	createEffect(
		on([parsed, () => assistOf(props.path).suggestions] as const, async ([result, suggestions]) => {
			if (!result.plan) return;
			const run = ++layoutRun;
			try {
				// What the agent proposes is drawn, marked, until you accept or decline it.
				const next = await layoutPlan(previewPlan(result.plan, suggestions), measure);
				if (run !== layoutRun) return;
				setLayout(next);
				// New suggestions can grow the chart past the view.
				if (!fitted || suggestions.length !== seen) fit();
				fitted = true;
				seen = suggestions.length;
			} catch (e: any) {
				notify(`Could not lay out the chart: ${e?.message ?? e}`, "error");
			}
		}),
	);

	const selected = createMemo(() => {
		const p = plan();
		if (!p || state.groups[state.activeGroup]?.active !== props.path) return null;
		return nodeAtLine(text(), p, state.cursor.line);
	});
	const selectedNode = () => plan()?.nodes.find((n) => n.id === selected());
	const moveCursor = (line: number) => {
		setState("activeGroup", props.group);
		editors[props.group]?.setSelection(new monaco.Range(line, 1, line, 1));
		setState("cursor", { line, column: 1 });
	};
	const select = (id: string | null | undefined) => {
		setEdge(null);
		const p = plan();
		const line = id && p ? nodeLines(text(), p).get(id) : undefined;
		moveCursor(line ?? 1);
	};

	/** The whole chart, or as much as stays legible around the selection or the start. */
	const fit = () => {
		const l = layout();
		if (!l || !canvas) return;
		const here = l.boxes.find((b) => b.node && b.id === selected()) ?? l.boxes.find((b) => b.node?.kind === "start");
		fittedView = fitView(l, canvas.getBoundingClientRect(), { floor: FIT_FLOOR, anchor: here && { x: here.x + here.width / 2, y: here.y + here.height / 2 } });
		setView(fittedView);
	};
	/** Zooms about a point of the canvas: the pointer, or its middle for the keys. */
	const zoomBy = (factor: number, at?: Point) => {
		if (!canvas) return;
		const box = canvas.getBoundingClientRect();
		setView((v) => zoomAt(v, at ?? { x: box.width / 2, y: box.height / 2 }, factor, MIN_ZOOM, MAX_ZOOM));
	};

	// Keep the selection in sight, as an edit or an arrow key may land off screen.
	createEffect(() => {
		const id = selected();
		const chosen = edge();
		const l = layout();
		if (!l || !canvas) return;
		const line = chosen && l.lines.find((x) => x.from === chosen.from && x.to === chosen.to);
		const box = line ? { x: line.at.x - 30, y: line.at.y - 12, width: 60, height: 24 } : l.boxes.find((b) => b.id === id);
		if (!box) return;
		const v = untrack(view);
		const size = canvas.getBoundingClientRect();
		// In sight, and not under the map of the chart in the corner.
		const shown = reveal(v, box, size);
		const next = outOfSight(l, shown, size) ? clearOf(shown, box, mapArea(l, size)) : shown;
		if (next !== v) setView(next);
	});

	/** A step asked for by its words: it is selected, and put in the middle of the view, where what leads to it and from it shows too. */
	const goTo = (id: string) => {
		select(id);
		const box = layout()?.boxes.find((b) => b.id === id);
		if (box && canvas) setView((v) => centredOn(v, { x: box.x + box.width / 2, y: box.y + box.height / 2 }, canvas.getBoundingClientRect()));
		refocus();
	};

	/** Findings on each node, from what Problems shows, so the two cannot disagree. */
	const issues = createMemo(() => {
		const map = new Map<string, string[]>();
		const p = plan();
		const uri = doc()?.model.uri.toString();
		if (!p || !uri) return map;
		// Notes (a call the chart does not show) are for Problems and the assistant, not a badge.
		for (const d of (diagnostics[uri] ?? []).filter((x) => x.severity <= 2)) {
			const id = nodeAtLine(text(), p, d.line);
			if (id) map.set(id, [...(map.get(id) ?? []), d.message]);
		}
		return map;
	});
	const currentRun = () => {
		const run = assistOf(props.path).run;
		const p = plan();
		return run && p && run.planHash === planHash(p) ? run : null;
	};
	const unitStatuses = createMemo(() => nodeStatuses(currentRun()));
	const changed = createMemo(() => {
		const p = plan();
		const c = p ? chartChanges(p, assistOf(props.path).run) : null;
		return new Set(c ? [...c.changed, ...c.added] : []);
	});
	const planUri = () => doc()?.model.uri.toString();
	const gone = createMemo(() => {
		const names = new Set(driftFor(planUri()).items.filter((d) => d.kind === "gone").map((d) => d.unit));
		const p = plan();
		return new Set(p ? (builtOf(p)?.units ?? []).filter((u) => names.has(u.name)).flatMap((u) => u.nodes) : []);
	});
	const linksOf = (id: string | null | undefined) => {
		const p = plan();
		return id && p ? unitsOfNode(p, id) : [];
	};
	const openCode = (id: string | null | undefined) => {
		const unit = linksOf(id)[0];
		if (unit) void openProcedure(planUri(), unit);
		else if (id) notify("Nothing is built for this step yet.");
	};
	const findingCount = () => diagnostics[doc()?.model.uri.toString() ?? ""]?.length ?? 0;
	/** What is so of a node beyond its words: for its mark, its name and the announcement. */
	const stateOf = (n: PlanNode): NodeState => ({
		unit: unitStatuses().get(n.id),
		changed: changed().has(n.id),
		gone: gone().has(n.id),
		suggested: Boolean(n.pending),
		built: linksOf(n.id).length > 0,
		findings: issues().get(n.id)?.length,
	});
	/** Read out when the selection, or what is so of it, changes. */
	const announcement = createMemo(() => {
		const p = plan();
		if (!p) return "";
		const chosen = edge();
		// An undo may have taken the chosen edge away.
		if (chosen && p.edges.some((e) => e.from === chosen.from && e.to === chosen.to)) return describeEdge(p, chosen);
		const node = selectedNode();
		return node ? describeNode(node, stateOf(node)) : "";
	});

	const apply = (next: Plan, selectId?: string | null) => {
		applyText(props.path, printPlan(next));
		if (selectId !== undefined) select(selectId);
	};
	const applyEdit = (result: Edit | null, edit = false) => {
		if (!result) return;
		apply(result.plan, result.select ?? null);
		if (edit && result.select) setEditing({ node: result.select });
	};

	const addNext = () => {
		const p = plan();
		const at = selected();
		if (!p) return;
		if (!at) return notify("Select a node to add after it.");
		applyEdit(addAfter(p, at), true);
	};
	const addOther = () => {
		const p = plan();
		const at = selected();
		if (!p || !at) return notify("Select a step or decision to branch from.");
		const result = addBranch(p, at);
		if (!result) return notify("Only a step or a decision can branch.");
		applyEdit(result, true);
	};
	const toggleDecision = () => {
		const p = plan();
		const node = selectedNode();
		if (p && node && (node.kind === "step" || node.kind === "decision")) apply(setDecision(p, node.id, node.kind === "step"));
	};
	const remove = () => {
		const p = plan();
		const e = edge();
		if (!p) return;
		if (e) {
			apply(removeEdge(p, e.from, e.to));
			return setEdge(null);
		}
		const at = selected();
		if (at) applyEdit(removeNode(p, at));
	};
	const addCallAsk = async (e?: MouseEvent) => {
		const p = plan();
		if (!p) return;
		const button = !e || e.detail > 0 ? null : (e.currentTarget as HTMLElement);
		const ref = (await ask("Procedure, script or data source this calls"))?.trim();
		if (ref) applyEdit(addCall(p, ref, selected() ?? undefined));
		// The dialog took the focus: it goes back to where it came from.
		if (button?.isConnected) button.focus();
		else refocus();
	};
	const beginLink = () => {
		const at = selected();
		if (at) setLinking(at);
		else notify("Select the node the connection starts from.");
	};
	/** Ends a connection at a node, and selects the new way out, ready for F2 or Delete. */
	const linkTo = (id: string | null | undefined) => {
		const from = linking();
		const p = plan();
		if (!from || !p || !id) return;
		setLinking(null);
		if (from === id) return notify("A node cannot lead to itself.");
		apply(connect(p, from, id), from);
		setEdge({ from, to: id });
	};
	/** The next way out of the selected node: the keyboard's way to an edge. */
	const nextEdge = (step: 1 | -1) => {
		const p = plan();
		const at = selected();
		if (!p || !at) return notify("Select a node to choose one of its ways out.");
		const next = cycleEdge(p.edges, at, edge(), step);
		if (next) setEdge(next);
		else notify("Nothing leads on from this node.");
	};
	const editSelection = () => {
		const chosen = edge();
		if (chosen) setEditing(chosen);
		else if (selected()) setEditing({ node: selected()! });
	};
	const undo = (action: "undo" | "redo") => editors[props.group]?.trigger("plan", action, null);

	/** The nearest node in a direction, for the arrow keys. */
	const step = (dx: number, dy: number) => {
		const l = layout();
		if (!l) return;
		const nodes = l.boxes.filter((b) => b.node);
		const here = nodes.find((b) => b.id === selected());
		if (!here) return select(nodes[0]?.id);
		const best = nearest(nodes, here, dx, dy);
		if (best) select(best.id);
	};

	// Tab is not here: it moves on to the next control, as it does everywhere else.
	const onKey = (e: KeyboardEvent) => {
		if (editing() || e.target !== canvas) return;
		const mod = e.ctrlKey || e.metaKey;
		const key = e.key.length === 1 ? e.key.toLowerCase() : e.key;
		if (mod && key === "z") {
			e.preventDefault();
			return undo(e.shiftKey ? "redo" : "undo");
		}
		if (mod && key === "y") {
			e.preventDefault();
			return undo("redo");
		}
		if (mod || e.altKey) return;
		const actions: Record<string, () => void> = {
			Enter: () => (linking() ? linkTo(selected()) : addNext()),
			b: addOther,
			F2: editSelection,
			Delete: remove,
			Backspace: remove,
			d: toggleDecision,
			c: beginLink,
			e: () => nextEdge(e.shiftKey ? -1 : 1),
			g: () => openCode(selected()),
			"+": () => zoomBy(1.2),
			"=": () => zoomBy(1.2),
			"-": () => zoomBy(1 / 1.2),
			"0": fit,
			"?": () => setKeysOpen((open) => !open),
			Escape: () => {
				if (keysOpen()) setKeysOpen(false);
				else if (linking()) setLinking(null);
				else if (edge()) setEdge(null);
				else select(null);
			},
			ArrowUp: () => step(0, -1),
			ArrowDown: () => step(0, 1),
			ArrowLeft: () => step(-1, 0),
			ArrowRight: () => step(1, 0),
		};
		const action = actions[key];
		if (action) {
			e.preventDefault();
			action();
		}
	};

	const clickNode = (id: string) => {
		if (linking()) linkTo(id);
		else select(id);
		refocus();
	};

	// The small text box over the chart.
	const editBox = () => {
		const target = editing();
		const l = layout();
		const v = view();
		if (!target || !l) return null;
		if ("node" in target) {
			const b = l.boxes.find((x) => x.id === target.node);
			return b ? { left: b.x * v.scale + v.x, top: (b.y + b.height / 2 - 13) * v.scale + v.y, width: Math.max(150, b.width * v.scale) } : null;
		}
		const line = l.lines.find((x) => x.from === target.from && x.to === target.to);
		return line ? { left: line.at.x * v.scale + v.x - 50, top: line.at.y * v.scale + v.y - 13, width: 100 } : null;
	};
	const editValue = () => {
		const target = editing();
		const p = plan();
		if (!target || !p) return "";
		if ("node" in target) return p.nodes.find((n) => n.id === target.node)?.text ?? "";
		return p.edges.find((e) => e.from === target.from && e.to === target.to)?.label ?? "";
	};
	/** `back` returns the keys to the chart; a commit made by clicking elsewhere leaves the focus where the click put it. */
	const commitEdit = (value: string, back = true) => {
		const target = editing();
		const p = plan();
		setEditing(null);
		if (back) refocus();
		if (!target || !p) return;
		if ("node" in target) {
			if (value.trim() && value !== p.nodes.find((n) => n.id === target.node)?.text) apply(setText(p, target.node, value.trim()));
		} else if (value !== (p.edges.find((e) => e.from === target.from && e.to === target.to)?.label ?? "")) apply(setEdgeLabel(p, target.from, target.to, value.trim()));
	};

	const setPlanField = (field: "title" | "goal", value: string) => {
		const p = plan();
		if (!p) return;
		const { [field]: _old, ...rest } = p;
		apply((value.trim() || field === "title" ? { ...rest, [field]: value.trim() } : rest) as Plan);
	};
	const setTargets = (value: string) => {
		const p = plan();
		if (!p) return;
		const { targets: _old, ...rest } = p;
		const list = value.split(",").map((t) => t.trim()).filter(Boolean);
		apply((list.length ? { ...rest, targets: list } : rest) as Plan);
	};
	const setNodeField = (field: "notes" | "ref", value: string) => {
		const p = plan();
		const node = selectedNode();
		if (!p || !node) return;
		const nodes = p.nodes.map((n) => {
			if (n.id !== node.id) return n;
			const { [field]: _old, ...rest } = n;
			return (value.trim() ? { ...rest, [field]: value.trim() } : rest) as PlanNode;
		});
		apply({ ...p, nodes });
	};
	const groupName = () => plan()?.groups.find((g) => g.id === selectedNode()?.group)?.name ?? "";

	let dragging: { x: number; y: number; moved: boolean } | null = null;

	return (
		<div class="plan">
			<Show
				when={plan()}
				fallback={
					<div class="plan-error">
						<p>This plan's text cannot be read as a chart.</p>
						<p class="hint">{parsed().error}</p>
						<button onClick={() => setState("planText", props.path, true)}>Fix it in the text</button>
					</div>
				}
			>
				<div class="graph-bar plan-bar" classList={{ narrow: narrow() }}>
					{/* The tab and the Title field say it too: a narrow bar gives its room to the buttons. */}
					<Show when={!narrow()}>
						<strong>{plan()!.title || "Plan"}</strong>
					</Show>
					{/* In a narrow chart the six are one menu, so the bar stays short and the chart keeps its room. */}
					<Show
						when={!compact()}
						fallback={
							<Menu label="Edit the chart" title="Edit: add a step, a branch or a call; make a decision; connect; delete" class="plan-edit-menu" items={editItems}>
								Edit
							</Menu>
						}
					>
						<button title="The next step (Enter)" onClick={(e) => (addNext(), after(e))}>
							Add step
						</button>
						<button title="Another way out (B)" onClick={(e) => (addOther(), after(e))}>
							Add branch
						</button>
						<button title="Something that already exists" onClick={(e) => void addCallAsk(e)}>
							Add call
						</button>
						<button title="Step or decision (D)" onClick={(e) => (toggleDecision(), after(e))}>
							Decision
						</button>
						<button title="Connect the selected node to another (C)" classList={{ on: Boolean(linking()) }} aria-pressed={Boolean(linking())} onClick={(e) => (linking() ? (setLinking(null), after(e)) : (beginLink(), refocus()))}>
							Connect
						</button>
						<button title="Delete the selection (Delete); undo brings it back" onClick={(e) => (remove(), after(e))}>
							Delete
						</button>
					</Show>
					{/* A step by its words: it is selected, and the chart moves to show it. */}
					<Finder
						choices={plan()!.nodes.map((n) => ({ id: n.id, name: n.text.trim() || "(no words yet)", where: n.kind === "call" && n.ref ? `call to ${n.ref}` : n.kind }))}
						label="Find a step by its words and select it"
						title="Type some of a step's words: the one you choose is selected and brought into view"
						placeholder="Find a step…"
						none={(typed) => `No step has “${typed}” in its words.`}
						onChoose={goTo}
					/>
					<span class="spacer" />
					<button title="The agent's questions, suggestions and spec" classList={{ on: assistantOpen() }} aria-expanded={assistantOpen()} aria-controls={assistantId} onClick={toggleAssistant}>
						Assistant
					</button>
					<Show when={findingCount() || !narrow()}>
						<button class="link" title="Show the findings in Problems" onClick={() => (setState("bottomView", "problems"), setState("settings", "layout", "bottom", true))}>
							{findingCount() ? `${findingCount()} ${findingCount() === 1 ? "finding" : "findings"}` : "No findings"}
						</button>
					</Show>
					{/* The same three as the call graph has: out, the scale (which resets it), in. */}
					<div class="graph-zoom" role="group" aria-label="Zoom">
						<button title="Zoom out (−)" aria-label="Zoom out" onClick={(e) => (zoomBy(1 / 1.2), after(e))}>
							−
						</button>
						<button title="Reset the zoom to 100%" aria-label={`Zoom ${Math.round(view().scale * 100)}%. Reset to 100%`} onClick={(e) => (zoomBy(1 / view().scale), after(e))}>
							{Math.round(view().scale * 100)}%
						</button>
						<button title="Zoom in (+)" aria-label="Zoom in" onClick={(e) => (zoomBy(1.2), after(e))}>
							+
						</button>
					</div>
					<button title="The whole chart, or as much as stays legible (0)" onClick={(e) => (fit(), after(e))}>
						Fit
					</button>
					{/* What is used now and then, so the bar stays one row. */}
					<Menu label="More for the chart" title="More: keys, save picture" class="graph-more" items={more}>
						<span aria-hidden="true">⋯</span>
					</Menu>
				</div>
				<div class="plan-main" classList={{ stacked: narrow() && assistantOpen() }} ref={watchWidth}>
				<div
					class="plan-canvas"
					ref={canvas}
					tabIndex={0}
					role="application"
					aria-label="Plan chart. The arrow keys move between nodes; the question mark key lists the rest."
					aria-describedby={keysOpen() ? keysId : undefined}
					classList={{ linking: Boolean(linking()), pathing: Boolean(onPath()) }}
					onKeyDown={onKey}
					onWheel={(e) => {
						e.preventDefault();
						const box = canvas.getBoundingClientRect();
						zoomBy(e.deltaY < 0 ? 1.1 : 0.9, { x: e.clientX - box.left, y: e.clientY - box.top });
					}}
					onMouseDown={(e) => {
						if (e.target instanceof Element && e.target.closest(".plan-edit, .plan-keys")) return;
						dragging = { x: e.clientX, y: e.clientY, moved: false };
					}}
					onMouseMove={(e) => {
						if (!dragging) return;
						const v = view();
						if (Math.abs(e.clientX - dragging.x) + Math.abs(e.clientY - dragging.y) > 2) dragging.moved = true;
						setView({ ...v, x: v.x + e.clientX - dragging.x, y: v.y + e.clientY - dragging.y });
						dragging = { ...dragging, x: e.clientX, y: e.clientY };
					}}
					onMouseUp={() => (dragging = null)}
					onMouseLeave={() => (dragging = null)}
					onDragOver={(e) => {
						if (e.dataTransfer?.types.includes(PROCEDURE_DRAG)) e.preventDefault();
					}}
					onDrop={(e) => {
						const name = e.dataTransfer?.getData(PROCEDURE_DRAG);
						const p = plan();
						if (!name || !p) return;
						e.preventDefault();
						applyEdit(addCall(p, name, selected() ?? undefined));
						refocus();
					}}
				>
					<svg class="graph-canvas" onClick={(e) => {
						if (e.target === e.currentTarget && !linking()) select(null);
						refocus();
					}}>
						<defs>
							<For each={["plain", "back", "near", "on"]}>
								{(kind) => (
									<marker id={`plan-arrow-${kind}`} viewBox="0 0 10 10" refX="9" refY="5" markerWidth="10" markerHeight="10" markerUnits="userSpaceOnUse" orient="auto-start-reverse">
										<path d="M0,1 L10,5 L0,9 z" class={`arrow plan-${kind}`} />
									</marker>
								)}
							</For>
						</defs>
						{/* Measure a node's words and an edge's label in the fonts they are drawn in. */}
						<g class="plan-probe" aria-hidden="true">
							<text class="plan-probe-node" ref={nodeProbe} />
							<text class="plan-probe-label" ref={labelProbe} />
						</g>
						<Show when={layout()}>
							{(l) => (
								<g transform={`translate(${view().x},${view().y}) scale(${view().scale})`}>
									<For each={l().boxes.filter((b) => b.group)}>
										{(b) => (
											<g class="g-region plan-group">
												<rect x={b.x} y={b.y} width={b.width} height={b.height} rx="8" style={{ stroke: `color-mix(in srgb, ${regionColor(b.group!)} 55%, transparent)`, fill: `color-mix(in srgb, ${regionColor(b.group!)} 7%, transparent)` }} />
												<text x={b.x + 10} y={b.y + 19}>
													{b.group}
												</text>
											</g>
										)}
									</For>
									<For each={l().lines}>
										{(line) => {
											const on = () => edge()?.from === line.from && edge()?.to === line.to;
											// The ways in and out of the node the selection or the pointer is on stand out from the rest.
											const near = () => {
												const at = pointed() ?? selected();
												return at !== null && (line.from === at || line.to === at);
											};
											const choose = (e: MouseEvent) => (e.stopPropagation(), setEdge({ from: line.from, to: line.to }), refocus());
											return (
												<g class="plan-edge" classList={{ on: on(), near: near(), back: line.back, pending: line.pending, removing: line.removing, "on-path": Boolean(onPath()?.ways.has(`${line.from}>${line.to}`)) }} role="img" aria-label={plan() ? describeEdge(plan()!, line) : undefined}>
													<path d={pathOf(line.points)} class="plan-edge-hit" onClick={choose} />
													<path d={pathOf(line.points)} class="g-edge" marker-end={`url(#plan-arrow-${on() || onPath()?.ways.has(`${line.from}>${line.to}`) ? "on" : near() ? "near" : line.back ? "back" : "plain"})`} />
													<Show when={line.shown}>
														<g class="plan-label" classList={{ missing: line.missing }} onClick={choose} onDblClick={(e) => (e.stopPropagation(), setEditing({ from: line.from, to: line.to }))}>
															<rect x={line.at.x - line.labelWidth / 2} y={line.at.y - 10} width={line.labelWidth} height="20" rx="4" />
															<text x={line.at.x} y={line.at.y + 4} text-anchor="middle">
																{line.shown}
															</text>
														</g>
													</Show>
												</g>
											);
										}}
									</For>
									<For each={l().boxes.filter((b) => b.node)}>
										{(b) => {
											const n = b.node!;
											const cx = b.x + b.width / 2;
											const cy = b.y + b.height / 2;
											const trouble = () => issues().get(n.id);
											const mark = () => statusMark(stateOf(n));
											// A decision's corners are empty: its marks sit on the diamond's upper edges.
											const corner = n.kind === "decision" ? { x: b.width / 4, y: b.height / 4 } : { x: 2, y: 2 };
											return (
												<g
													class={`plan-node ${n.kind} unit-${unitStatuses().get(n.id) ?? "none"}`}
													classList={{ "on-path": Boolean(onPath()?.nodes.has(n.id)), selected: selected() === n.id, origin: linking() === n.id, trouble: Boolean(trouble()), pending: Boolean(n.pending), changed: changed().has(n.id), gone: gone().has(n.id) }}
													role="img"
													aria-label={describeNode(n, stateOf(n))}
													onMouseDown={(e) => e.stopPropagation()}
													onMouseEnter={() => setPointed(n.id)}
													onMouseLeave={() => setPointed(null)}
													onClick={(e) => {
														e.stopPropagation();
														if (n.pending) return;
														if (e.ctrlKey || e.metaKey) openCode(n.id);
														else clickNode(n.id);
													}}
													onDblClick={(e) => (e.stopPropagation(), !n.pending && setEditing({ node: n.id }))}
												>
													<title>
														{[n.text, n.notes, ...linksOf(n.id).map((u) => `Built as ${u.name} in ${u.script}. Ctrl+click opens it.`), mark() ? MARK_WORDS[mark()!] : "", changed().has(n.id) && mark() !== "changed" ? MARK_WORDS.changed : "", ...(trouble() ?? [])].filter(Boolean).join("\n")}
													</title>
													<Show when={n.kind === "decision"} fallback={<rect x={b.x} y={b.y} width={b.width} height={b.height} rx={n.kind === "start" || n.kind === "end" ? Math.min(b.height / 2, 26) : 5} />}>
														<polygon points={`${cx},${b.y} ${b.x + b.width},${cy} ${cx},${b.y + b.height} ${b.x},${cy}`} />
													</Show>
													<Show when={n.kind === "call"}>
														<line x1={b.x + 10} y1={b.y} x2={b.x + 10} y2={b.y + b.height} />
														<line x1={b.x + b.width - 10} y1={b.y} x2={b.x + b.width - 10} y2={b.y + b.height} />
													</Show>
													<For each={b.lines}>
														{(words, i) => (
															<text x={cx} y={cy + (i() - (b.lines.length - 1) / 2) * LINE + 4} text-anchor="middle">
																{words}
															</text>
														)}
													</For>
													<Show when={linksOf(n.id).length && n.kind !== "decision"}>
														<rect class="plan-built" x={b.x + 5} y={b.y + b.height - 9} width="5" height="5" />
													</Show>
													<Show when={mark()}>
														{(kind) => (
															<g class={`plan-mark ${kind()}`} transform={`translate(${b.x + corner.x},${b.y + corner.y})`}>
																<circle r="7.5" />
																<path d={MARK_PATHS[kind()]} />
															</g>
														)}
													</Show>
													<Show when={trouble()}>
														<circle class="plan-dot" cx={b.x + b.width - corner.x} cy={b.y + corner.y} r="5" />
													</Show>
												</g>
											);
										}}
									</For>
								</g>
							)}
						</Show>
					</svg>
					<Show when={layout()}>
						{(l) => (
							<Minimap
								content={l()}
								boxes={l().boxes.map((b): MapBox => ({ x: b.x, y: b.y, width: b.width, height: b.height, kind: b.group ? "frame" : b.node?.id === selected() ? "mark" : "node" }))}
								view={view()}
								host={() => canvas}
								onMove={setView}
							/>
						)}
					</Show>
					<Show when={editBox()}>
						{(box) => (
							<input
								class="plan-edit"
								aria-label={editing() && "node" in editing()! ? "The node's words" : "The label of this way out"}
								style={{ left: `${box().left}px`, top: `${box().top}px`, width: `${box().width}px` }}
								ref={(el) => {
									el.value = editValue();
									queueMicrotask(() => (el.focus(), el.select()));
								}}
								onMouseDown={(e) => e.stopPropagation()}
								onClick={(e) => e.stopPropagation()}
								onKeyDown={(e) => {
									e.stopPropagation();
									if (e.key === "Enter") commitEdit(e.currentTarget.value);
									if (e.key === "Escape") {
										setEditing(null);
										refocus();
									}
								}}
								onBlur={(e) => {
									if (editing()) commitEdit(e.currentTarget.value, false);
								}}
							/>
						)}
					</Show>
					<Show when={linking()}>
						<div class="plan-hint" role="status">
							Move to the node this leads to and press Enter, or click it. Esc cancels.
						</div>
					</Show>
					<Show when={keysOpen()}>
						<div class="plan-keys" id={keysId} role="group" aria-label="The chart's keys">
							<dl>
								<For each={KEYS}>
									{([keys, what]) => (
										<>
											<dt>{keys}</dt>
											<dd>{what}</dd>
										</>
									)}
								</For>
							</dl>
							<p class="hint">Tab moves on to the details and the assistant.</p>
							{/* What the chart's shapes and lines mean, drawn by the chart's own rules. */}
							<h4>Shapes and lines</h4>
							<ul class="plan-shapes">
								<li>
									<svg viewBox="0 0 34 18" aria-hidden="true">
										<g class="plan-node start">
											<rect x="1" y="2" width="32" height="14" rx="7" />
										</g>
									</svg>
									Where it starts, and where it ends
								</li>
								<li>
									<svg viewBox="0 0 34 18" aria-hidden="true">
										<g class="plan-node step">
											<rect x="1" y="2" width="32" height="14" rx="3" />
										</g>
									</svg>
									A step
								</li>
								<li>
									<svg viewBox="0 0 34 18" aria-hidden="true">
										<g class="plan-node call">
											<rect x="1" y="2" width="32" height="14" rx="3" />
											<line x1="6" y1="2" x2="6" y2="16" />
											<line x1="28" y1="2" x2="28" y2="16" />
										</g>
									</svg>
									A call to another procedure or script
								</li>
								<li>
									<svg viewBox="0 0 34 18" aria-hidden="true">
										<g class="plan-node decision">
											<polygon points="17,1 33,9 17,17 1,9" />
										</g>
									</svg>
									A decision: each way out has a label
								</li>
								<li>
									<svg viewBox="0 0 34 18" aria-hidden="true">
										<g class="plan-edge back">
											<path class="g-edge" d="M2,9 L32,9" />
										</g>
									</svg>
									A loop's way back, in the accent
								</li>
								<li>
									<svg viewBox="0 0 34 18" aria-hidden="true">
										<g class="plan-node step">
											<rect x="1" y="2" width="32" height="14" rx="3" />
											<rect class="plan-built" x="4" y="10" width="5" height="5" />
										</g>
									</svg>
									A green square: the step has code
								</li>
							</ul>
							<p class="hint">A mark at a node's corner is its state in a build, or against its code: point at the node to read it.</p>
						</div>
					</Show>
				</div>
				<PlanAssistant id={assistantId} hidden={!assistantOpen()} path={props.path} plan={plan()!} text={text()} onSelect={select} onPath={setWalked} />
				</div>
				{/* Read out by a screen reader when the selection changes; not seen. */}
				<p class="plan-live" role="status" aria-live="polite">
					{announcement()}
				</p>
				<div class="plan-details">
					<Show
						when={selectedNode()}
						keyed
						fallback={
							<>
								<label>
									Title <input value={plan()!.title} onChange={(e) => setPlanField("title", e.currentTarget.value)} />
								</label>
								<label class="grow">
									Goal <input value={typeof plan()!.goal === "string" ? (plan()!.goal as string) : ""} placeholder="What this should achieve" onChange={(e) => setPlanField("goal", e.currentTarget.value)} />
								</label>
								<label class="grow">
									Scripts <input value={Array.isArray(plan()!.targets) ? (plan()!.targets as string[]).join(", ") : ""} placeholder="Sample/Release.ssl" onChange={(e) => setTargets(e.currentTarget.value)} />
								</label>
							</>
						}
					>
						{(node) => (
							<>
								<span class="plan-kind">{node.kind}</span>
								<For each={linksOf(node.id)}>
									{(unit) => (
										<button class="link" title={`Open this step's code (G)${unit.script ? `: ${unit.script}` : ""}`} onClick={() => void openProcedure(planUri(), unit)}>
											{unit.name}
										</button>
									)}
								</For>
								<Show when={node.kind === "call"}>
									<label>
										Calls <input value={node.ref ?? ""} onChange={(e) => setNodeField("ref", e.currentTarget.value)} />
									</label>
								</Show>
								<label class="grow">
									Notes <input value={node.notes ?? ""} placeholder="Anything the agent should know" onChange={(e) => setNodeField("notes", e.currentTarget.value)} />
								</label>
								<label>
									Group{" "}
									<input
										value={groupName()}
										list="plan-groups"
										placeholder="None (becomes a region)"
										onChange={(e) => {
											const p = plan();
											if (p) apply(setGroup(p, node.id, e.currentTarget.value));
										}}
									/>
								</label>
								<datalist id="plan-groups">
									<For each={plan()!.groups}>{(g) => <option value={g.name} />}</For>
								</datalist>
							</>
						)}
					</Show>
				</div>
			</Show>
		</div>
	);
}
