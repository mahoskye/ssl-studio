// Modern interactive flow chart view for a plan (`design/<name>.plan.json`,
// ADR 0005). Every visual action — hover '+' ports, drag-to-connect wires,
// insert-on-edge, shape drop from Palette, right-click menus, inline edits,
// and stage renames — produces one undoable text edit on the plan's Monaco
// model (ADR 0002). Assistant (Refine, Questions, Spec, Build, Tests) lives
// cleanly in the Palette panel's Assistant tab so the chart stays unobstructed.
import ELK from "elkjs/lib/elk.bundled.js";
import { createEffect, createMemo, createSignal, createUniqueId, For, on, onCleanup, onMount, Show, untrack } from "solid-js";
import { baseName, dirName, joinPath, relativeTo } from "../../shared/paths";
import { isCatalog, registryTitle, ticketKey } from "../../shared/projectDocs";
import type { DocFile } from "../../shared/protocol";
import { backend } from "../backend";
import { ask, choose } from "../dialogs";
import { editors } from "../editor/EditorGroup";
import { monaco } from "../editor/monaco";
import { cycleRegionColor, regionColor } from "../editor/regions";
import { canvasMeasure, centredOn, clearLabels, clearOf, fitView, legibleScale, mapArea, nearest, outOfSight, recall, remember, reveal, roundedPath, zoomAt, type Measure, type Point, type Rect } from "../graph/canvas";
import { Finder } from "../graph/Finder";
import { Minimap, type MapBox } from "../graph/Minimap";
import { pictureName, savePicture } from "../graph/picture";
import { Icon } from "../Icon";
import { ICON } from "../icons";
import { diagnostics } from "../lsp/session";
import { Menu, type MenuItem } from "../Menu";
import { showPanel } from "../panels/registry";
import { chooseFromMenu, type RowMenuEntry } from "../panels/RowMenu";
import { docs } from "../project";
import { applyText, canonical, documents, notify, openedForALook, openFile, setPlanMode, setState, state } from "../state";
import { PlanTextView, type TextTestBuilderRequest } from "./PlanTextView";
import { planHash, planToMermaid, previewPlan, syncPlanMermaidInMarkdown } from "./assist";
import { nodeStatuses } from "./build";
import { builtOf, chartChanges, pathsForNode, pathSummary, planPaths, unitsOfNode } from "./built";
import {
	applyRouteOffsets,
	chartGraph,
	CODE_INDICATOR_WORDS,
	codeIndicator,
	compactRoutes,
	crossings,
	cycleEdge,
	describeEdge,
	describeNode,
	edgeHandles,
	edgeMidpoint,
	fitRegionBounds,
	KEYS,
	labelPoint,
	LINE,
	MARK_WORDS,
	offsetFor,
	placeEdgeLabel,
	rerouteMovedEdge,
	routeLength,
	routeOf,
	sizeNode,
	statusMark,
	type ChartGraph,
	type CodeIndicator,
	type EdgeHandle,
	type LabelObstacle,
	type LayoutDirection,
	type Mark,
	type NodeState,
	type Sized,
} from "./chart";
import { recheckPlan } from "./check";
import { driftFor, openProcedure, openReference, openScript } from "./drift";
import {
	addAfter,
	addBranch,
	addCall,
	addPlanTest,
	connect,
	duplicateNode,
	hasManualLayout,
	insertOnEdge,
	nodeAtLine,
	nodeDocsOf,
	nodeLines,
	parsePlan,
	printPlan,
	PROCEDURE_DRAG,
	removeEdge,
	removeNode,
	removePlanTest,
	renameGroup,
	resetPlanLayout,
	reverseEdge,
	setDecision,
	setEdgeLabel,
	setEdgeRoute,
	setGroup,
	setGroupOffset,
	setKind,
	setNodeOffset,
	setText,
	SHAPE_DRAG,
	updatePlanTest,
	type Edit,
	type NodeKind,
	type Plan,
	type PlanNode,
	type PlanOffset,
	type RouteOffsets,
} from "./model";
import { registerPlanBridge, requestPlanPaletteTab, type ScheduledBuildScope } from "./planBridge";
import "./planCanvas.css";
import { assistOf, specPath } from "./run";

type Box = { id: string; x: number; y: number; width: number; height: number; node?: PlanNode; lines: string[]; group?: string; memberCount?: number; pillWidth?: number };
type Line = {
	id: string;
	from: string;
	to: string;
	label?: string;
	shown: string;
	labelWidth: number;
	basePoints: Point[];
	points: Point[];
	route?: RouteOffsets;
	at: Point;
	mid: Point;
	missing: boolean;
	pending: boolean;
	removing: boolean;
	back: boolean;
};
type Layout = { boxes: Box[]; lines: Line[]; width: number; height: number };

type WireDrag = {
	fromId: string;
	startClient: Point;
	startCanvas: Point;
	curCanvas: Point;
	dragged: boolean;
	kind: "primary" | "branch";
};

type RouteDrag = {
	from: string;
	to: string;
	key: string;
	axis: "h" | "v";
	startClient: Point;
	startDelta: number;
	curDelta: number;
	moved: boolean;
};

type NodeDrag = {
	kind: "node" | "group";
	id: string;
	startClient: Point;
	startOffset: Point;
	curOffset: Point;
	moved: boolean;
	guideX?: number;
	guideY?: number;
};

const elk = new ELK();

const NODE_FONT_PX = 13;
const LABEL_FONT_PX = 12;
const FIT_FLOOR = legibleScale(NODE_FONT_PX);
const MIN_ZOOM = 0.1;
const MAX_ZOOM = 2.5;
const FAR_UNDER = 0.56;
const FAR_NAME_PX = 11;
const DIRECTION_KEY = "plan.direction";

const shortly = (text: string, most = 30) =>
	text.length <= most ? text : `${text.slice(0, text.lastIndexOf(" ", most) > 10 ? text.lastIndexOf(" ", most) : most).replace(/[,;:.]$/, "")}…`;
const measureName = canvasMeasure(`600 ${FAR_NAME_PX}px system-ui, sans-serif`, FAR_NAME_PX);

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

async function layoutPlan(plan: Plan, measure: { node: Measure; label: Measure; stage: Measure }, direction: LayoutDirection): Promise<Layout> {
	const sized = new Map<string, Sized>();
	for (const n of plan.nodes) if (!sized.has(n.id)) sized.set(n.id, sizeNode(n.kind, n.text, measure.node));
	const first = await layoutWith(chartGraph(plan, sized, "EAST", "NORTH", direction), sized, measure);
	let best = first;
	for (const loopTip of first.sided ? (["EAST", "WEST"] as const) : (["EAST"] as const))
		for (const returnsAt of first.returning ? (["NORTH", "WEST"] as const) : (["NORTH"] as const)) {
			if (loopTip === "EAST" && returnsAt === "NORTH") continue;
			const next = await layoutWith(chartGraph(plan, sized, loopTip, returnsAt, direction), sized, measure);
			if (next.crossings < best.crossings || (next.crossings === best.crossings && next.length < best.length)) best = next;
		}
	return best.layout;
}

async function layoutWith(
	{ graph, nodes, edges, groups, reversed, sided, returning }: ChartGraph,
	sized: ReadonlyMap<string, Sized>,
	measure: { node: Measure; label: Measure; stage: Measure },
): Promise<{ layout: Layout; crossings: number; length: number; sided: boolean; returning: boolean }> {
	const result: any = await elk.layout(graph as any);
	const boxes: Box[] = [];
	const walk = (n: any, ox: number, oy: number) => {
		const x = ox + (n.x ?? 0);
		const y = oy + (n.y ?? 0);
		if (n.id !== "root") {
			const node = nodes.find((p) => p.id === n.id);
			const groupObj = node ? undefined : groups.find((g) => g.id === n.id);
			const memberCount = groupObj ? nodes.filter((m) => m.group === groupObj.id).length : undefined;
			const pillWidth = groupObj
				? Math.max(84, 22 + Math.ceil(measure.stage(groupObj.name)) + 14 + String(memberCount ?? 0).length * 7 + 10)
				: undefined;
			boxes.push({
				id: n.id,
				x,
				y,
				width: n.width,
				height: n.height,
				node,
				lines: node ? sized.get(node.id)!.lines : [],
				group: groupObj?.name,
				memberCount,
				pillWidth,
			});
		}
		for (const c of n.children ?? []) walk(c, x, y);
	};
	walk(result, 0, 0);
	const diamond = (id: string) => boxes.find((b) => b.id === id && b.node?.kind === "decision");
	const obstacles = labelObstaclesOf(boxes);
	const placedLabels: { x: number; y: number; width: number; height: number }[] = [];
	const rawEdges: { e: any; index: number; edge: Plan["edges"][number]; points: Point[] }[] = (result.edges ?? []).map((e: any) => {
		const index = Number(String(e.id).slice(1));
		const edge = edges[index]!;
		const section = e.sections?.[0];
		const points = routeOf(
			section ? [section.startPoint, ...(section.bendPoints ?? []), section.endPoint] : [],
			reversed.has(index),
			diamond(edge.from),
			diamond(edge.to),
		);
		return { e, index, edge, points };
	});
	const compacted = compactRoutes(
		rawEdges.map((r) => ({ to: r.edge.to, points: r.points })),
		boxes,
	);
	const lines: Line[] = rawEdges.map(({ e, index, edge }, ri) => {
		const basePoints = compacted[ri]!;
		const missing = Boolean(diamond(edge.from)) && !edge.label?.trim();
		const shown = edge.label?.trim() || (missing ? "label?" : "");
		const labelWidth = shown ? Math.ceil(measure.label(shown)) + 16 : 0;
		const at = shown ? placeEdgeLabel(basePoints, labelWidth, obstacles, placedLabels) : labelPoint(basePoints, 0);
		if (shown) placedLabels.push({ x: at.x - labelWidth / 2, y: at.y - 10.5, width: labelWidth, height: 21 });
		const mid = placeMidpoint(basePoints, shown ? at : null, labelWidth);
		return {
			id: e.id,
			from: edge.from,
			to: edge.to,
			label: edge.label,
			shown,
			labelWidth,
			basePoints,
			points: basePoints,
			at,
			mid,
			missing,
			pending: Boolean(edge.pending),
			removing: Boolean(edge.removing),
			back: reversed.has(index),
		};
	});
	const nodeBoxes = boxes.filter((b) => b.node);
	const nodeGroup = new Map(nodeBoxes.map((b) => [b.id, b.node?.group]));
	const fittedBoxes = boxes.map((b) => {
		if (!b.group) return b;
		const members = nodeBoxes.filter((m) => m.node?.group === b.id);
		const contained = lines
			.filter((l) => nodeGroup.get(l.from) === b.id && nodeGroup.get(l.to) === b.id)
			.map((l) => ({
				points: l.points,
				labelBox: l.shown && l.labelWidth > 0 ? { x: l.at.x - l.labelWidth / 2, y: l.at.y - 10.5, width: l.labelWidth, height: 21 } : undefined,
			}));
		const next = fitRegionBounds(members, contained, { minWidth: (b.pillWidth ?? 90) + 20, floor: b });
		return next ? { ...b, ...next } : b;
	});
	const maxX = fittedBoxes.reduce((m, b) => Math.max(m, b.x + b.width), result.width);
	const maxY = fittedBoxes.reduce((m, b) => Math.max(m, b.y + b.height), result.height);
	return { layout: { boxes: fittedBoxes, lines, width: maxX, height: maxY }, crossings: crossings(lines.map((l) => l.basePoints)), length: routeLength(lines.map((l) => l.basePoints)), sided, returning };
}

function labelObstaclesOf(boxes: readonly Box[]): LabelObstacle[] {
	const out: LabelObstacle[] = [];
	for (const b of boxes) {
		if (b.node) {
			out.push({ x: b.x, y: b.y, width: b.width, height: b.height, shape: b.node.kind === "decision" ? "diamond" : "rect" });
		} else if (b.group) {
			// Stage header pill + top border band so branch labels stay cleanly above stage titles.
			out.push({ x: b.x + 6, y: b.y - 2, width: (b.pillWidth ?? Math.min(b.width - 12, 160)) + 8, height: 34, shape: "rect" });
		}
	}
	return out;
}

function placeMidpoint(points: readonly Point[], labelAt: Point | null, labelWidth: number): Point {
	let mid = edgeMidpoint(points);
	if (labelAt && Math.hypot(mid.x - labelAt.x, mid.y - labelAt.y) < Math.max(30, labelWidth / 2 + 12)) {
		let bestPt = mid;
		let bestDist = -1;
		for (let i = 1; i < points.length; i++) {
			const a = points[i - 1]!;
			const b = points[i]!;
			const segMid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
			const dist = Math.hypot(segMid.x - labelAt.x, segMid.y - labelAt.y);
			if (dist > bestDist) {
				bestDist = dist;
				bestPt = segMid;
			}
		}
		mid = bestDist >= 22 ? bestPt : { x: labelAt.x + labelWidth / 2 + 16, y: labelAt.y };
	}
	return mid;
}

const pathOf = (points: Point[]) => roundedPath(points, 12);

/** Smooth cubic Bezier path for live wire-dragging preview. */
function bezierWire(a: Point, b: Point, dir: LayoutDirection): string {
	const dx = b.x - a.x;
	const dy = b.y - a.y;
	if (dir === "RIGHT") {
		const c = Math.max(36, Math.abs(dx) * 0.45);
		return `M${a.x},${a.y} C${a.x + c},${a.y} ${b.x - c},${b.y} ${b.x},${b.y}`;
	}
	const c = Math.max(36, Math.abs(dy) * 0.45);
	return `M${a.x},${a.y} C${a.x},${a.y + c} ${b.x},${b.y - c} ${b.x},${b.y}`;
}

/** Distance from point P to line segment AB (used for drag-over-edge hit testing). */
function distToSegment(p: Point, a: Point, b: Point): number {
	const vx = b.x - a.x;
	const vy = b.y - a.y;
	const lenSq = vx * vx + vy * vy;
	if (lenSq === 0) return Math.hypot(p.x - a.x, p.y - a.y);
	const t = Math.max(0, Math.min(1, ((p.x - a.x) * vx + (p.y - a.y) * vy) / lenSq));
	return Math.hypot(p.x - (a.x + t * vx), p.y - (a.y + t * vy));
}

const MARK_PATHS: Record<Mark, string> = {
	passed: "M-3.4,0.2 L-1,2.6 L3.4,-2.4",
	stuck: "M0,-3.6 L0,0.8 M0,3.5 L0,3.6",
	running: "M-3.2,0 L-3.2,0.1 M0,0 L0,0.1 M3.2,0 L3.2,0.1",
	changed: "M0,-3.4 L3.4,2.6 L-3.4,2.6 Z",
	skipped: "M-1.8,-2.8 L-1.8,2.8 M1.8,-2.8 L1.8,2.8",
	gone: "M-2.8,-2.8 L2.8,2.8 M2.8,-2.8 L-2.8,2.8",
};

function typingElsewhere() {
	const el = document.activeElement;
	return el instanceof HTMLElement && !el.closest(".monaco-editor") && el.matches("input, textarea, select, [contenteditable]:not([contenteditable='false'])");
}

export function PlanView(props: { path: string; group: number; mode?: "text" | "chart" }) {
	const isTextMode = () => props.mode === "text";
	const doc = () => documents.get(props.path);
	const [text, setTextSignal] = createSignal(doc()?.model.getValue() ?? "");
	const parsed = createMemo(() => parsePlan(text()));
	const plan = () => parsed().plan;
	const [baseLayout, setBaseLayout] = createSignal<Layout | null>(null);
	const [view, setView] = createSignal({ x: 20, y: 20, scale: 1 });
	const [direction, setDirectionSignal] = createSignal<LayoutDirection>(recall(DIRECTION_KEY) === "RIGHT" ? "RIGHT" : "DOWN");
	const [edge, setEdge] = createSignal<{ from: string; to: string } | null>(null);
	const [linking, setLinking] = createSignal<string | null>(null);
	const [walked, setWalked] = createSignal<string[] | null>(null);
	const [activePathIndex, setActivePathIndexSignal] = createSignal<number | null>(null);
	const [scheduledNotice, setScheduledNotice] = createSignal<string | null>(null);
	const [builderRequest, setBuilderRequest] = createSignal<TextTestBuilderRequest | null>(null);
	let builderReqSeq = 0;
	const [pointed, setPointed] = createSignal<string | null>(null);
	const [peeked, setPeeked] = createSignal<{ id: string; pinned: boolean } | null>(null);
	let peekTimer: ReturnType<typeof setTimeout> | undefined;
	onCleanup(() => peekTimer && clearTimeout(peekTimer));
	const [keysOpen, setKeysOpen] = createSignal(false);
	const [compact, setCompact] = createSignal(false);
	const [tight, setTight] = createSignal(false);
	const [panning, setPanning] = createSignal(false);
	const [editing, setEditing] = createSignal<{ node: string } | { from: string; to: string } | null>(null);
	// Direct authoring drag states: live node/stage dragging, rubber-band wire dragging, segment route dragging, and Palette drop targets.
	const [nodeDrag, setNodeDrag] = createSignal<NodeDrag | null>(null);
	const [wireDrag, setWireDrag] = createSignal<WireDrag | null>(null);
	const [routeDrag, setRouteDrag] = createSignal<RouteDrag | null>(null);
	const [dropNodeId, setDropNodeId] = createSignal<string | null>(null);
	const [dropEdgeKey, setDropEdgeKey] = createSignal<string | null>(null);

	const gridId = createUniqueId();
	const keysId = createUniqueId();

	const allPaths = createMemo(() => {
		const p = plan();
		return p ? planPaths(p) : { paths: [], truncated: false };
	});
	const setActivePathIndex = (index: number | null) => {
		const count = allPaths().paths.length;
		if (index === null || !count || index < 0 || index >= count) {
			setActivePathIndexSignal(null);
			setWalked(null);
			return;
		}
		setActivePathIndexSignal(index);
		setWalked(allPaths().paths[index]!.steps.map((s) => s.id));
	};
	const stepActivePath = (by: 1 | -1) => {
		const count = allPaths().paths.length;
		if (!count) return;
		const cur = activePathIndex();
		const next = cur === null ? (by > 0 ? 0 : count - 1) : (cur + by + count) % count;
		setActivePathIndex(next);
	};
	createEffect(() => {
		const idx = activePathIndex();
		const list = allPaths().paths;
		if (idx === null) return;
		if (!list[idx]) {
			setActivePathIndexSignal(null);
			setWalked(null);
		} else {
			setWalked(list[idx]!.steps.map((s) => s.id));
		}
	});
	const activePathInfo = createMemo(() => {
		const idx = activePathIndex();
		const list = allPaths().paths;
		const p = plan();
		if (idx === null || !list[idx]) return null;
		return { index: idx, total: list.length, summary: pathSummary(list[idx]!, list, p) };
	});

	const onPath = createMemo(() => {
		const path = walked();
		return path ? { nodes: new Set(path), ways: new Set(path.slice(1).map((to, i) => `${path[i]}>${to}`)) } : null;
	});

	const setDirection = (next: LayoutDirection) => {
		if (next === direction()) return;
		setDirectionSignal(next);
		remember(DIRECTION_KEY, next);
		fitted = false;
	};
	const toggleDirection = () => setDirection(direction() === "DOWN" ? "RIGHT" : "DOWN");

	let canvas!: HTMLDivElement;
	let nodeProbe: SVGTextElement | undefined;
	let labelProbe: SVGTextElement | undefined;
	let stageProbe: SVGTextElement | undefined;
	let fitted = false;
	let fittedView: { x: number; y: number; scale: number } | null = null;
	let fittedWhole = false;
	let seen = 0;

	const measure = {
		node: probeMeasure(() => nodeProbe, canvasMeasure(`${NODE_FONT_PX}px system-ui, sans-serif`, NODE_FONT_PX)),
		label: probeMeasure(() => labelProbe, canvasMeasure(`${LABEL_FONT_PX}px system-ui, sans-serif`, LABEL_FONT_PX)),
		stage: probeMeasure(() => stageProbe, canvasMeasure(`600 12px system-ui, sans-serif`, 12)),
	};

	/** Converts viewport client coordinates into SVG canvas coordinates. */
	const clientToCanvas = (clientX: number, clientY: number): Point => {
		const rect = canvas.getBoundingClientRect();
		const v = view();
		return { x: (clientX - rect.left - v.x) / v.scale, y: (clientY - rect.top - v.y) / v.scale };
	};

	const hitNodeAt = (pt: Point, excludeId?: string): string | null => {
		const l = layout();
		if (!l) return null;
		for (const b of l.boxes) {
			if (!b.node || b.id === excludeId) continue;
			if (pt.x >= b.x - 6 && pt.x <= b.x + b.width + 6 && pt.y >= b.y - 6 && pt.y <= b.y + b.height + 6) return b.id;
		}
		return null;
	};

	const hitEdgeAt = (pt: Point): Line | null => {
		const l = layout();
		if (!l) return null;
		let best: Line | null = null;
		let bestDist = 18;
		for (const line of l.lines) {
			for (let i = 1; i < line.points.length; i++) {
				const d = distToSegment(pt, line.points[i - 1]!, line.points[i]!);
				if (d < bestDist) {
					bestDist = d;
					best = line;
				}
			}
		}
		return best;
	};

	const watchCanvas = (el: HTMLDivElement) => {
		if (typeof ResizeObserver === "undefined") return;
		let frame = 0;
		const observer = new ResizeObserver((entries) => {
			const rect = entries[0]?.contentRect;
			const width = rect?.width ?? 0;
			const height = rect?.height ?? 0;
			cancelAnimationFrame(frame);
			frame = requestAnimationFrame(() => {
				setCompact(width > 0 && width < 540);
				setTight(width > 0 && width < 360);
				if (!isTextMode() && width > 10 && height > 10) {
					if (!fitted && layout()) {
						if (fit()) fitted = true;
					} else if (view() === fittedView) {
						queueMicrotask(() => void (fittedWhole ? whole() : fit()));
					}
				}
			});
		});
		observer.observe(el);
		onCleanup(() => (cancelAnimationFrame(frame), observer.disconnect()));
	};

	const refocus = () => queueMicrotask(() => !editing() && !isTextMode() && canvas?.focus());
	const after = (e: MouseEvent) => {
		if (e.detail > 0) refocus();
	};

	onMount(() => {
		const model = doc()?.model;
		if (!model) return;
		const sub = model.onDidChangeContent(() => setTextSignal(model.getValue()));
		onCleanup(() => sub.dispose());
		recheckPlan(model.uri.toString());
		const look = openedForALook(props.path);
		queueMicrotask(() => !look && !typingElsewhere() && !document.querySelector(".overlay") && canvas?.focus());
	});

	// Re-run ELK only when chart topology, text, labels, groups, suggestions, or direction change — NOT on manual drag offsets.
	const topologyKey = createMemo(() => {
		const p = plan();
		if (!p) return "";
		const suggestions = assistOf(props.path).suggestions;
		const preview = previewPlan(p, suggestions);
		return JSON.stringify({
			dir: direction(),
			g: preview.groups.map((g) => [g.id, g.name]),
			n: preview.nodes.map((n) => [n.id, n.kind, n.text, n.group ?? "", Boolean(n.pending)]),
			e: preview.edges.map((e) => [e.from, e.to, e.label ?? "", Boolean(e.pending), Boolean(e.removing)]),
		});
	});

	let layoutRun = 0;
	createEffect(
		on(topologyKey, async (key) => {
			const p = plan();
			if (!key || !p) return;
			const suggestions = assistOf(props.path).suggestions;
			const dir = direction();
			const run = ++layoutRun;
			try {
				const next = await layoutPlan(previewPlan(p, suggestions), measure, dir);
				if (run !== layoutRun) return;
				setBaseLayout(next);
				if (!fitted || suggestions.length !== seen) {
					if (fit()) fitted = true;
				}
				seen = suggestions.length;
			} catch (e: any) {
				notify(`Could not lay out the chart: ${e?.message ?? e}`, "error");
			}
		}),
	);

	// Pure synchronous 60fps layout projection: overlays saved + live node/stage/wire offsets onto ELK's base layout.
	const layout = createMemo<Layout | null>(() => {
		const base = baseLayout();
		if (!base) return null;
		const p = plan();
		const dir = direction();
		const drag = nodeDrag();
		const rDrag = routeDrag();
		const suggestions = assistOf(props.path).suggestions;
		const livePlan = p ? previewPlan(p, suggestions) : null;
		const nodeMap = new Map((livePlan?.nodes ?? []).map((n) => [n.id, n]));
		const groupMap = new Map((livePlan?.groups ?? []).map((g) => [g.id, g]));
		const edgeMap = new Map((livePlan?.edges ?? []).map((e) => [`${e.from}>${e.to}`, e]));

		const groupDeltaOf = (gid: string | undefined): Point => {
			if (!gid) return { x: 0, y: 0 };
			if (drag?.kind === "group" && drag.id === gid && drag.moved) return drag.curOffset;
			return offsetFor(groupMap.get(gid)?.offset, dir);
		};
		const nodeOwnDeltaOf = (nid: string): Point => {
			if (drag?.kind === "node" && drag.id === nid && drag.moved) return drag.curOffset;
			return offsetFor(nodeMap.get(nid)?.offset, dir);
		};

		const nodeBoxes = new Map<string, Box>();
		const nodeDeltas = new Map<string, Point>();
		const shiftedNodes: Box[] = [];
		for (const b of base.boxes) {
			if (!b.node) continue;
			const fresh = nodeMap.get(b.id) ?? b.node;
			const gd = groupDeltaOf(fresh.group);
			const nd = nodeOwnDeltaOf(b.id);
			const delta = { x: gd.x + nd.x, y: gd.y + nd.y };
			const shifted: Box = { ...b, node: fresh, x: b.x + delta.x, y: b.y + delta.y };
			nodeBoxes.set(b.id, shifted);
			nodeDeltas.set(b.id, delta);
			shiftedNodes.push(shifted);
		}

		const nodeGroup = new Map(shiftedNodes.map((b) => [b.id, b.node?.group]));
		const routed = base.lines.map((line) => {
			const key = `${line.from}>${line.to}`;
			const fromBox = nodeBoxes.get(line.from);
			const toBox = nodeBoxes.get(line.to);
			const fromDelta = nodeDeltas.get(line.from) ?? { x: 0, y: 0 };
			const toDelta = nodeDeltas.get(line.to) ?? { x: 0, y: 0 };
			const routedBase =
				fromBox && toBox && fromBox.node && toBox.node
					? rerouteMovedEdge(line.basePoints, fromBox, toBox, fromDelta, toDelta, fromBox.node.kind, toBox.node.kind, dir, line.back)
					: line.basePoints;
			const savedRoute = edgeMap.get(key)?.route;
			const draggingThis = rDrag && rDrag.from === line.from && rDrag.to === line.to ? rDrag : null;
			const effectiveRoute = draggingThis ? { ...(savedRoute ?? {}), [draggingThis.key]: draggingThis.curDelta } : savedRoute;
			const points = applyRouteOffsets(routedBase, effectiveRoute);
			const hasCustomRoute = Boolean(draggingThis) || Boolean(effectiveRoute && Object.keys(effectiveRoute).length > 0);
			const moved = fromDelta.x !== 0 || fromDelta.y !== 0 || toDelta.x !== 0 || toDelta.y !== 0 || hasCustomRoute;
			return { key, line, routedBase, savedRoute, points, hasCustomRoute, moved };
		});

		// Stage containers always enclose all member nodes, contained lines (both endpoints inside), and their labels with REGION_PADDING.
		const fitGroups = (labelByKey?: Map<string, Rect>): Box[] => {
			const out: Box[] = [];
			for (const g of base.boxes) {
				if (!g.group) continue;
				const members = shiftedNodes.filter((n) => n.node?.group === g.id);
				const gd = groupDeltaOf(g.id);
				const anyMemberMoved = members.some((m) => {
					const nd = nodeOwnDeltaOf(m.id);
					return nd.x !== 0 || nd.y !== 0;
				});
				const contained = routed.filter((r) => nodeGroup.get(r.line.from) === g.id && nodeGroup.get(r.line.to) === g.id);
				const anyContainedRouteCustom = contained.some((r) => r.hasCustomRoute);
				const floor = !anyMemberMoved && !anyContainedRouteCustom ? { x: g.x + gd.x, y: g.y + gd.y, width: g.width, height: g.height } : undefined;
				const next = fitRegionBounds(
					members,
					contained.map((r) => ({ points: r.points, labelBox: labelByKey?.get(r.key) })),
					{ minWidth: (g.pillWidth ?? 90) + 20, floor },
				);
				out.push(next ? { ...g, ...next } : { ...g, x: g.x + gd.x, y: g.y + gd.y });
			}
			return out;
		};

		const prelimGroups = fitGroups();
		const obstacles = labelObstaclesOf([...prelimGroups, ...shiftedNodes]);
		const placedLabels: Rect[] = [];
		const labelByKey = new Map<string, Rect>();
		const lines: Line[] = routed.map(({ key, line, routedBase, savedRoute, points, moved }) => {
			const at = moved ? (line.shown ? placeEdgeLabel(points, line.labelWidth, obstacles, placedLabels) : labelPoint(points, 0)) : line.at;
			if (line.shown && line.labelWidth > 0) {
				const rect: Rect = { x: at.x - line.labelWidth / 2, y: at.y - 10.5, width: line.labelWidth, height: 21 };
				placedLabels.push(rect);
				labelByKey.set(key, rect);
			}
			const mid = moved ? placeMidpoint(points, line.shown ? at : null, line.labelWidth) : line.mid;
			return { ...line, basePoints: routedBase, points, route: savedRoute, at, mid };
		});

		const shiftedGroups = fitGroups(labelByKey);
		const boxes = [...shiftedGroups, ...shiftedNodes];
		const maxX = boxes.reduce((m, b) => Math.max(m, b.x + b.width), base.width);
		const maxY = boxes.reduce((m, b) => Math.max(m, b.y + b.height), base.height);
		return { boxes, lines, width: Math.max(base.width, maxX + 20), height: Math.max(base.height, maxY + 20) };
	});

	// Stable string keys from ELK's base layout so live 60fps dragging updates SVG attributes in place without remounting DOM nodes (which would swallow clicks/dblclicks).
	const nodeIds = createMemo(() => (baseLayout()?.boxes.filter((b) => b.node).map((b) => b.id) ?? []));
	const groupIds = createMemo(() => (baseLayout()?.boxes.filter((b) => b.group).map((b) => b.id) ?? []));
	const edgeKeys = createMemo(() => (baseLayout()?.lines.map((l) => `${l.from}>${l.to}`) ?? []));
	const labeledEdgeKeys = createMemo(() => (baseLayout()?.lines.filter((l) => l.shown).map((l) => `${l.from}>${l.to}`) ?? []));
	const boxById = createMemo(() => new Map((layout()?.boxes ?? []).map((b) => [b.id, b])));
	const lineByKey = createMemo(() => new Map((layout()?.lines ?? []).map((l) => [`${l.from}>${l.to}`, l])));

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

	/** Fits as much of the chart as stays legible; returns true if canvas had real dimensions. */
	const fit = (): boolean => {
		const l = layout();
		if (!l || !canvas) return false;
		const box = canvas.getBoundingClientRect();
		if (box.width < 10 || box.height < 10) return false;
		const here = l.boxes.find((b) => b.node && b.id === selected()) ?? l.boxes.find((b) => b.node?.kind === "start");
		fittedView = fitView(l, box, { floor: FIT_FLOOR, anchor: here && { x: here.x + here.width / 2, y: here.y + here.height / 2 } });
		fittedWhole = false;
		setView(fittedView);
		return true;
	};
	const fitOrWhole = () => {
		const l = layout();
		const box = canvas?.getBoundingClientRect();
		if (l && box && view() === fittedView && !fittedWhole && outOfSight(l, view(), box)) whole();
		else fit();
	};
	const whole = () => {
		const l = layout();
		if (!l || !canvas) return;
		const box = canvas.getBoundingClientRect();
		if (box.width < 10 || box.height < 10) return;
		fittedView = fitView(l, box, { floor: MIN_ZOOM });
		fittedWhole = true;
		setView(fittedView);
	};

	const far = () => view().scale < FAR_UNDER;
	const farScale = createMemo(() => (far() ? view().scale : 0));
	const farNames = createMemo(() => {
		const scale = farScale();
		const l = layout();
		if (!scale || !l) return [];
		const size = FAR_NAME_PX / scale;
		return clearLabels(
			l.boxes
				.filter((b) => b.group || b.node?.kind === "start" || b.node?.kind === "end")
				.map((b) => {
					const words = b.group ?? shortly(b.node!.text.trim());
					const width = measureName(words) / scale;
					const x = Math.max(0, Math.min(b.x + b.width / 2 - width / 2, l.width - width));
					const y = Math.max(0, Math.min(b.y + b.height / 2 - size * 0.6, l.height - size * 1.2));
					return { item: { words, stage: Boolean(b.group) }, x, y, width, height: size * 1.2, weight: (b.group ? 1e15 : 0) + b.width * b.height };
				}),
			size * 0.3,
		).map((name) => ({ ...name, size }));
	});
	const comeIn = (at: Point) => {
		const l = layout();
		if (!l || !canvas) return false;
		const holds = (b: Box) => at.x >= b.x && at.x <= b.x + b.width && at.y >= b.y && at.y <= b.y + b.height;
		const to = l.boxes.find((b) => b.group && holds(b)) ?? l.boxes.find((b) => b.node && holds(b));
		if (!to) return false;
		const box = canvas.getBoundingClientRect();
		const scale = Math.max(FIT_FLOOR, Math.min(1, (box.width - 80) / to.width, (box.height - 80) / to.height));
		setView({ scale, x: box.width / 2 - (to.x + to.width / 2) * scale, y: box.height / 2 - (to.y + to.height / 2) * scale });
		return true;
	};
	const zoomBy = (factor: number, at?: Point) => {
		if (!canvas) return;
		const box = canvas.getBoundingClientRect();
		setView((v) => zoomAt(v, at ?? { x: box.width / 2, y: box.height / 2 }, factor, MIN_ZOOM, MAX_ZOOM));
	};

	createEffect(() => {
		const id = selected();
		const chosen = edge();
		const l = layout();
		if (!l || !canvas) return;
		const size = canvas.getBoundingClientRect();
		if (size.width < 10 || size.height < 10) return;
		const line = chosen && l.lines.find((x) => x.from === chosen.from && x.to === chosen.to);
		const box = line ? { x: line.at.x - 30, y: line.at.y - 12, width: 60, height: 24 } : l.boxes.find((b) => b.id === id);
		if (!box) return;
		const v = untrack(view);
		const shown = reveal(v, box, size);
		const next = outOfSight(l, shown, size) ? clearOf(shown, box, mapArea(l, size)) : shown;
		if (next !== v) setView(next);
	});

	const goTo = (id: string) => {
		setPeeked(null);
		select(id);
		if (isTextMode()) {
			if (peekTimer) clearTimeout(peekTimer);
			setPeeked({ id, pinned: true });
			peekTimer = setTimeout(() => {
				setPeeked((cur) => (cur?.id === id && cur.pinned ? null : cur));
				peekTimer = undefined;
			}, 1200);
			return;
		}
		const box = layout()?.boxes.find((b) => b.id === id);
		if (box && canvas) setView((v) => centredOn(v, { x: box.x + box.width / 2, y: box.y + box.height / 2 }, canvas.getBoundingClientRect()));
		refocus();
	};

	/** Switch from Text view to Chart view centered on a step (or the current selection). */
	const showOnChart = (id?: string) => {
		setPlanMode(props.path, "chart");
		if (id) {
			select(id);
			requestAnimationFrame(() => {
				const box = layout()?.boxes.find((b) => b.id === id);
				if (box && canvas) setView((v) => centredOn(v, { x: box.x + box.width / 2, y: box.y + box.height / 2 }, canvas.getBoundingClientRect()));
				refocus();
			});
		}
	};

	/** Switch from Chart/Palette straight into the spacious Text view with the interactive Test Builder open. */
	const openTextTestBuilder = (opts?: { nodeId?: string; journeyIndex?: number; testId?: string }) => {
		setPlanMode(props.path, "text");
		setBuilderRequest({ ...opts, seq: ++builderReqSeq });
	};

	/** Spotlight a node on the canvas (or Text outline) without changing selection or disturbing the Palette inspector. */
	const peekNode = (id: string | null, opts?: { pan?: boolean }) => {
		if (!id) {
			setPeeked((cur) => (cur?.pinned ? cur : null));
			return;
		}
		if (opts?.pan) {
			if (peekTimer) clearTimeout(peekTimer);
			setPeeked({ id, pinned: true });
			if (!isTextMode()) {
				const box = layout()?.boxes.find((b) => b.id === id);
				if (box && canvas) {
					const size = canvas.getBoundingClientRect();
					setView((v) => reveal(v, box, size));
				}
			}
			peekTimer = setTimeout(() => {
				setPeeked((cur) => (cur?.id === id && cur.pinned ? null : cur));
				peekTimer = undefined;
			}, 2200);
		} else {
			if (peekTimer) {
				clearTimeout(peekTimer);
				peekTimer = undefined;
			}
			setPeeked({ id, pinned: false });
		}
	};

	const issues = createMemo(() => {
		const map = new Map<string, string[]>();
		const p = plan();
		const uri = doc()?.model.uri.toString();
		if (!p || !uri) return map;
		for (const d of (diagnostics[uri] ?? []).filter((x) => x.severity <= 2)) {
			const id = nodeAtLine(text(), p, d.line);
			if (id) map.set(id, [...(map.get(id) ?? []), d.message]);
		}
		return map;
	});
	const errorNodes = createMemo(() => {
		const set = new Set<string>();
		const p = plan();
		const uri = doc()?.model.uri.toString();
		if (!p || !uri) return set;
		for (const d of (diagnostics[uri] ?? []).filter((x) => x.severity === 1)) {
			const id = nodeAtLine(text(), p, d.line);
			if (id) set.add(id);
		}
		return set;
	});
	const currentRun = () => {
		const run = assistOf(props.path).run;
		const p = plan();
		return run && p && run.planHash === planHash(p) ? run : null;
	};
	const unitStatuses = createMemo(() => nodeStatuses(currentRun()));
	const changedOnly = createMemo(() => {
		const p = plan();
		const c = p ? chartChanges(p, assistOf(props.path).run) : null;
		return new Set(c ? c.changed : []);
	});
	const planUri = () => doc()?.model.uri.toString();
	const gone = createMemo(() => {
		const names = new Set(driftFor(planUri()).items.filter((d) => d.kind === "gone").map((d) => d.unit));
		const p = plan();
		return new Set(p ? (builtOf(p)?.units ?? []).filter((u) => names.has(u.name)).flatMap((u) => u.nodes) : []);
	});
	const driftNodes = createMemo(() => {
		const items = driftFor(planUri()).items.filter((d) => d.kind !== "gone" && d.severity === "warning");
		const ids = new Set<string>();
		const names = new Set<string>();
		for (const d of items) {
			if (d.node) ids.add(d.node);
			names.add(d.unit);
		}
		const p = plan();
		if (p) for (const u of builtOf(p)?.units ?? []) if (names.has(u.name)) for (const nid of u.nodes) ids.add(nid);
		return ids;
	});
	const linksOf = (id: string | null | undefined) => {
		const p = plan();
		return id && p ? unitsOfNode(p, id) : [];
	};
	const openCode = (id: string | null | undefined) => {
		const unit = linksOf(id)[0];
		if (unit) return void openProcedure(planUri(), unit);
		const ref = id ? plan()?.nodes.find((n) => n.id === id)?.ref?.trim() : "";
		if (ref) return void openReference(ref);
		if (id) notify("No code is linked to this step yet.");
	};
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
	const linkedDocsOfNode = (node: PlanNode) =>
		nodeDocsOf(node).map((ref) => {
			const doc = resolveLinkedDoc(ref);
			const label = doc ? docDisplayName(doc) : baseName(ref) || ref;
			const kind = doc ? docKindTag(doc) : "";
			return { ref, doc, label, kind };
		});
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
	const openLinkedDocsMenu = async (e: MouseEvent, node: PlanNode) => {
		e.stopPropagation();
		const linked = linkedDocsOfNode(node);
		if (!linked.length) return;
		if (linked.length === 1) return openLinkedDoc(linked[0]!);
		const items: RowMenuEntry[] = linked.map((d, i) => ({
			label: d.kind ? `${d.kind}: ${d.label}` : d.label,
			value: `doc:${i}`,
		}));
		const picked = await chooseFromMenu(`Linked docs for ${node.text.trim() || node.id}`, items, { x: e.clientX, y: e.clientY });
		if (picked?.startsWith("doc:")) {
			const hit = linked[Number(picked.slice(4))];
			if (hit) openLinkedDoc(hit);
		}
	};
	const savePlanPicture = () =>
		void savePicture(
			canvas?.querySelector<SVGSVGElement>("svg.graph-canvas") ?? undefined,
			layout(),
			joinPath(relativeTo(state.workspace?.root, dirName(props.path)), pictureName(plan()?.title || "plan")),
		);
	const copyMermaid = async () => {
		const p = plan();
		if (!p) return;
		const fenced = `\`\`\`mermaid\n${planToMermaid(p, direction())}\n\`\`\``;
		const copied = (await backend.clipboard(fenced).catch(() => false)) || (await navigator.clipboard?.writeText(fenced).then(() => true, () => false));
		notify(copied ? "Copied chart as Mermaid." : "Could not reach the clipboard.", copied ? "info" : "error");
	};
	const syncMermaidToDoc = async () => {
		const p = plan();
		if (!p) return;
		const mermaid = planToMermaid(p, direction());
		const allDocs = docs().filter((d) => d.exists && !isCatalog(d));
		const candidates: { label: string; detail: string; path: string }[] = [];
		const seen = new Set<string>();
		const pushCand = (path: string, label: string, detail: string) => {
			const canon = canonical(path);
			if (seen.has(canon)) return;
			seen.add(canon);
			candidates.push({ label, detail, path });
		};
		const pairedSpec = specPath(props.path);
		if (pairedSpec !== props.path) {
			const pairedExists =
				documents.has(canonical(pairedSpec)) ||
				allDocs.some((d) => canonical(d.path) === canonical(pairedSpec)) ||
				(await backend.read(pairedSpec).then(
					() => true,
					() => false,
				));
			if (pairedExists) {
				pushCand(pairedSpec, `Spec: ${baseName(pairedSpec)}`, "Companion spec for this plan");
			}
		}
		const ticketVal = typeof p.ticket === "string" ? p.ticket.trim() : "";
		if (ticketVal) {
			const td = allDocs.find((d) => d.group === "tickets" && d.ticket?.toLowerCase() === ticketVal.toLowerCase());
			if (td) pushCand(td.path, `Ticket: ${docDisplayName(td)}`, "Linked ticket for this plan");
			for (const sp of allDocs.filter((d) => d.group === "specs" && d.tickets?.some((k) => k.toLowerCase() === ticketVal.toLowerCase()))) {
				pushCand(sp.path, `Spec: ${docDisplayName(sp)}`, `Spec for ${ticketVal}`);
			}
		}
		for (const d of allDocs.filter((f) => f.group === "specs" || f.group === "tickets")) {
			const tag = d.group === "tickets" ? "Ticket" : "Spec";
			const rel = relativeTo(state.workspace?.root, d.path).replace(/\\/g, "/");
			pushCand(d.path, `${tag}: ${docDisplayName(d)}`, rel);
		}
		if (!candidates.length) {
			notify("No specs or tickets were found in this workspace to sync Mermaid into.");
			return;
		}
		// Ensure every choice button label is distinct.
		const counts = new Map<string, number>();
		for (const c of candidates) counts.set(c.label, (counts.get(c.label) ?? 0) + 1);
		const labels = candidates.map((c) => ((counts.get(c.label) ?? 0) > 1 ? `${c.label} (${baseName(c.path)})` : c.label));
		const details: Record<string, string> = {};
		labels.forEach((lbl, i) => {
			details[lbl] = candidates[i]!.detail;
		});
		const picked = await choose("Sync Mermaid flowchart into which spec or ticket?", labels, { details });
		if (!picked) return;
		const idx = labels.indexOf(picked);
		const target = idx >= 0 ? candidates[idx] : undefined;
		if (!target) return;
		const canon = canonical(target.path);
		const openDoc = documents.get(canon);
		let before: string;
		try {
			before = openDoc ? openDoc.model.getValue() : (await backend.read(target.path)).text;
		} catch (e: any) {
			notify(`Could not read ${baseName(target.path)}: ${e?.message ?? e}`, "error");
			return;
		}
		const planLabel = baseName(props.path);
		const next = syncPlanMermaidInMarkdown(before, mermaid, planLabel);
		if (next === before) {
			notify(`${baseName(target.path)} already has the latest Mermaid flowchart.`);
			await openFile(target.path);
			return;
		}
		if (openDoc) {
			applyText(canon, next);
		} else {
			try {
				await backend.historyKeep(target.path).catch(() => {});
				await backend.write(target.path, next, true);
				setState("treeVersion", (v) => v + 1);
			} catch (e: any) {
				notify(`Could not update ${baseName(target.path)}: ${e?.message ?? e}`, "error");
				return;
			}
		}
		notify(`Synced Mermaid flowchart into ${baseName(target.path)}.`);
		await openFile(target.path);
	};
	const findingCount = () => diagnostics[doc()?.model.uri.toString() ?? ""]?.length ?? 0;
	const stateOf = (n: PlanNode): NodeState => ({
		unit: unitStatuses().get(n.id),
		changed: changedOnly().has(n.id),
		gone: gone().has(n.id),
		suggested: Boolean(n.pending),
		built: linksOf(n.id).length > 0,
		findings: issues().get(n.id)?.length,
		hasError: errorNodes().has(n.id),
		hasDrift: driftNodes().has(n.id),
	});
	const codeStateOf = (id: string): CodeIndicator => {
		const node = plan()?.nodes.find((n) => n.id === id);
		return node ? codeIndicator(stateOf(node)) : "grey";
	};
	const actionableNodes = createMemo(() => (plan()?.nodes ?? []).filter((n) => n.kind !== "start" && n.kind !== "end" && !n.pending));
	const codeStatusCounts = createMemo<Record<CodeIndicator, number>>(() => {
		const counts: Record<CodeIndicator, number> = { grey: 0, blue: 0, green: 0, yellow: 0, red: 0 };
		for (const n of actionableNodes()) counts[codeIndicator(stateOf(n))]++;
		return counts;
	});
	const nodesByCodeState = (kind: CodeIndicator): PlanNode[] => actionableNodes().filter((n) => codeIndicator(stateOf(n)) === kind);
	const openAssistant = () => {
		showPanel("palette");
		requestPlanPaletteTab("assistant");
	};
	const triggerScheduledBuild = (scope: ScheduledBuildScope) => {
		const title = plan()?.title || "this plan";
		const msg =
			scope.kind === "node"
				? `Build scheduled for step "${scope.label}".`
				: scope.kind === "stage"
					? `Build scheduled for stage "${scope.label}".`
					: scope.kind === "tests"
						? `Test generation scheduled for "${scope.label || title}".`
						: `New build scheduled for "${scope.label || title}".`;
		setScheduledNotice(msg);
		openAssistant();
		notify(`${msg} Agent build triggers will run here in the next pass.`);
	};
	const highlightNodeTestPath = (nodeId: string) => {
		const p = plan();
		if (!p) return;
		const found = pathsForNode(p, nodeId, allPaths());
		const first = found.matches[0];
		if (!first) return notify("No test path from Start reaches this step yet.");
		setActivePathIndex(first.pathIndex);
	};
	const announcement = createMemo(() => {
		const p = plan();
		if (!p) return "";
		const chosen = edge();
		if (chosen && p.edges.some((e) => e.from === chosen.from && e.to === chosen.to)) return describeEdge(p, chosen);
		const node = selectedNode();
		return node ? describeNode(node, stateOf(node)) : "";
	});

	// --- Plan Mutations (each is one undoable text edit on doc.model) ---------

	const apply = (next: Plan, selectId?: string | null) => {
		applyText(props.path, printPlan(next));
		if (selectId !== undefined) select(selectId);
	};
	const applyEdit = (result: Edit | null, edit = false) => {
		if (!result) return;
		apply(result.plan, result.select ?? null);
		if (edit && result.select) setEditing({ node: result.select });
	};

	const addNextFrom = (id?: string | null, kind: NodeKind = "step", label?: string, ref?: string) => {
		const p = plan();
		const at = id ?? selected() ?? p?.nodes.find((n) => n.kind === "start")?.id;
		if (!p) return;
		if (!at) return notify("Select a node to add after it.");
		const defaultText = label ?? (kind === "decision" ? "Decision?" : kind === "call" ? (ref || "Call procedure") : "New step");
		applyEdit(addAfter(p, at, kind, defaultText, ref), true);
	};
	const addNext = () => addNextFrom(selected(), "step");
	const addDecisionNode = () => addNextFrom(selected(), "decision", "Decision?");
	const addBranchFrom = (id?: string | null) => {
		const p = plan();
		const at = id ?? selected() ?? p?.nodes.find((n) => n.kind === "decision" || n.kind === "step" || n.kind === "call")?.id;
		if (!p || !at) return notify("Select a step or decision to branch from.");
		const node = p.nodes.find((n) => n.id === at);
		const prepared = node?.kind === "call" ? setKind(p, at, "step") : p;
		const result = addBranch(prepared, at);
		if (!result) return notify("Only a step or a decision can branch.");
		applyEdit(result, true);
	};
	const insertBetween = (from: string, to: string, kind: NodeKind = "step", label?: string, ref?: string) => {
		const p = plan();
		if (!p) return;
		const defaultText = label ?? (kind === "decision" ? "Decision?" : kind === "call" ? (ref || "Call procedure") : "New step");
		const res = insertOnEdge(p, from, to, kind, defaultText, ref);
		if (res) {
			setEdge(null);
			applyEdit(res, true);
		}
	};
	const toggleDecision = (id?: string) => {
		const p = plan();
		const target = id ? p?.nodes.find((n) => n.id === id) : selectedNode();
		if (!p || !target) return;
		if (target.kind === "decision") apply(setDecision(p, target.id, false), target.id);
		else if (target.kind === "step" || target.kind === "call") apply(setKind(p, target.id, "decision"), target.id);
	};
	const changeKind = (id: string, kind: NodeKind) => {
		const p = plan();
		if (p) apply(setKind(p, id, kind), id);
	};
	const duplicateById = (id?: string | null) => {
		const p = plan();
		const target = id ?? selected();
		if (!p || !target) return;
		const res = duplicateNode(p, target);
		if (res) applyEdit(res, false);
		else notify("Start and End nodes cannot be duplicated.");
	};
	const addStageGroupAsk = async (id?: string | null) => {
		const p = plan();
		const at = id ?? selected();
		if (!p || !at) return notify("Select a step to place into a stage group.");
		const name = (await ask("Stage group name (e.g. Validation, Approval)"))?.trim();
		if (name) apply(setGroup(p, at, name), at);
		refocus();
	};
	const renameStageAsk = async (groupId: string) => {
		const p = plan();
		const g = p?.groups.find((x) => x.id === groupId);
		if (!p || !g) return;
		const next = await ask("Rename stage (leave empty to ungroup)", g.name);
		if (next !== null && next.trim() !== g.name) apply(renameGroup(p, groupId, next));
		refocus();
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
	const reverseSelectedEdge = (target?: { from: string; to: string }) => {
		const p = plan();
		const e = target ?? edge();
		if (!p || !e) return;
		apply(reverseEdge(p, e.from, e.to));
		setEdge({ from: e.to, to: e.from });
	};
	const resetEdgeRoute = (target?: { from: string; to: string }, onlyKey?: string) => {
		const p = plan();
		const e = target ?? edge();
		if (!p || !e) return;
		if (onlyKey) {
			const cur = p.edges.find((x) => x.from === e.from && x.to === e.to)?.route;
			if (!cur || cur[onlyKey] === undefined) return;
			const next = { ...cur };
			delete next[onlyKey];
			apply(setEdgeRoute(p, e.from, e.to, next));
		} else {
			apply(setEdgeRoute(p, e.from, e.to, null));
		}
		setEdge({ from: e.from, to: e.to });
	};
	const nudgeEdgeRoute = (axis: "h" | "v", delta: number) => {
		const p = plan();
		const e = edge();
		const l = layout();
		if (!p || !e || !l) return;
		const line = l.lines.find((x) => x.from === e.from && x.to === e.to);
		if (!line) return;
		const handles = edgeHandles(line.basePoints, line.points, line.route, line.shown ? [line.at, line.mid] : [line.mid]);
		const target = handles.find((h) => h.axis === axis);
		if (!target) return;
		const next = { ...(line.route ?? {}), [target.key]: (line.route?.[target.key] ?? 0) + delta };
		apply(setEdgeRoute(p, e.from, e.to, next));
		setEdge({ from: e.from, to: e.to });
	};
	const resetNodePos = (id?: string | null) => {
		const p = plan();
		const target = id ?? selected();
		if (!p || !target) return;
		apply(setNodeOffset(p, target, null), target);
	};
	const resetGroupPos = (groupId: string) => {
		const p = plan();
		if (!p) return;
		let next = setGroupOffset(p, groupId, null);
		for (const n of p.nodes) if (n.group === groupId && n.offset) next = setNodeOffset(next, n.id, null);
		apply(next);
	};
	const resetAllLayout = () => {
		const p = plan();
		if (!p) return;
		apply(resetPlanLayout(p));
		refocus();
	};
	const nudgeNode = (dx: number, dy: number) => {
		const p = plan();
		const target = selectedNode();
		if (!p || !target) return;
		const dir = direction();
		const cur = offsetFor(target.offset, dir);
		const nextOffset: PlanOffset = { x: cur.x + dx, y: cur.y + dy, ...(dir === "RIGHT" ? { dir: "RIGHT" } : {}) };
		apply(setNodeOffset(p, target.id, nextOffset), target.id);
	};
	const addCallAsk = async (afterId?: string | null, e?: MouseEvent) => {
		const p = plan();
		if (!p) return;
		const button = !e || e.detail > 0 ? null : (e.currentTarget as HTMLElement);
		const ref = (await ask("Procedure, script or data source this calls"))?.trim();
		if (ref) applyEdit(addCall(p, ref, afterId ?? selected() ?? undefined));
		if (button?.isConnected) button.focus();
		else refocus();
	};
	const beginLink = (fromId?: string | null) => {
		const at = fromId ?? selected();
		if (at) setLinking(at);
		else notify("Select the node the connection starts from.");
	};
	const linkTo = (id: string | null | undefined) => {
		const from = linking();
		const p = plan();
		if (!from || !p || !id) return;
		setLinking(null);
		if (from === id) return notify("A node cannot lead to itself.");
		apply(connect(p, from, id), from);
		setEdge({ from, to: id });
	};
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
	const undo = (action: "undo" | "redo") => {
		const model = doc()?.model;
		if (!model) return;
		if (action === "undo") model.undo();
		else model.redo();
	};

	const step = (dx: number, dy: number) => {
		const l = layout();
		if (!l) return;
		const nodes = l.boxes.filter((b) => b.node);
		const here = nodes.find((b) => b.id === selected());
		if (!here) return select(nodes[0]?.id);
		const best = nearest(nodes, here, dx, dy);
		if (best) select(best.id);
	};

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
		if (e.shiftKey && (key === "ArrowUp" || key === "ArrowDown" || key === "ArrowLeft" || key === "ArrowRight")) {
			if (edge()) {
				e.preventDefault();
				const stepPx = 12;
				if (key === "ArrowUp") nudgeEdgeRoute("h", -stepPx);
				else if (key === "ArrowDown") nudgeEdgeRoute("h", stepPx);
				else if (key === "ArrowLeft") nudgeEdgeRoute("v", -stepPx);
				else nudgeEdgeRoute("v", stepPx);
				return;
			}
			if (selected()) {
				e.preventDefault();
				const stepPx = 12;
				if (key === "ArrowUp") nudgeNode(0, -stepPx);
				else if (key === "ArrowDown") nudgeNode(0, stepPx);
				else if (key === "ArrowLeft") nudgeNode(-stepPx, 0);
				else nudgeNode(stepPx, 0);
				return;
			}
		}
		const actions: Record<string, () => void> = {
			Enter: () => (linking() ? linkTo(selected()) : addNext()),
			b: () => addBranchFrom(selected()),
			F2: editSelection,
			Delete: remove,
			Backspace: remove,
			d: () => toggleDecision(),
			c: () => beginLink(),
			e: () => nextEdge(e.shiftKey ? -1 : 1),
			r: () => (edge() ? resetEdgeRoute() : selected() ? resetNodePos() : undefined),
			g: () => openCode(selected()),
			"+": () => zoomBy(1.2),
			"=": () => zoomBy(1.2),
			"-": () => zoomBy(1 / 1.2),
			"0": fitOrWhole,
			"?": () => setKeysOpen((open) => !open),
			Escape: () => {
				if (cancelActiveDrag) {
					cancelActiveDrag();
					return;
				}
				if (keysOpen()) setKeysOpen(false);
				else if (linking()) setLinking(null);
				else if (wireDrag()) setWireDrag(null);
				else if (routeDrag()) setRouteDrag(null);
				else if (nodeDrag()) setNodeDrag(null);
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

	// --- Direct Port Click / Rubber-Band Wire / Node / Stage Dragging --------
	// All drags stay local until the pointer crosses a small movement threshold so
	// plain clicks and double-clicks never trigger reactive drag churn, and every
	// active drag cleans up reliably on mouseup, buttons===0, window blur, Esc, or unmount.

	let cancelActiveDrag: (() => void) | null = null;
	onCleanup(() => cancelActiveDrag?.());

	const startPortDrag = (e: MouseEvent, fromId: string, startCanvas: Point, kind: "primary" | "branch") => {
		if (e.button !== 0) return;
		e.preventDefault();
		e.stopPropagation();
		cancelActiveDrag?.();
		let cur: WireDrag = {
			fromId,
			startClient: { x: e.clientX, y: e.clientY },
			startCanvas,
			curCanvas: startCanvas,
			dragged: false,
			kind,
		};

		const cleanup = () => {
			window.removeEventListener("mousemove", onMove, true);
			window.removeEventListener("mouseup", onUp, true);
			window.removeEventListener("blur", onCancel);
			if (cancelActiveDrag === onCancel) cancelActiveDrag = null;
		};
		const onCancel = () => {
			cleanup();
			setWireDrag(null);
			setDropNodeId(null);
		};
		const onMove = (ev: MouseEvent) => {
			if (ev.buttons === 0) return onUp(ev);
			const moved = cur.dragged || Math.hypot(ev.clientX - cur.startClient.x, ev.clientY - cur.startClient.y) > 5;
			if (!moved) return;
			const pt = clientToCanvas(ev.clientX, ev.clientY);
			cur = { ...cur, curCanvas: pt, dragged: true };
			setWireDrag(cur);
			setDropNodeId(hitNodeAt(pt, cur.fromId));
		};
		const onUp = (ev: MouseEvent) => {
			cleanup();
			setWireDrag(null);
			setDropNodeId(null);
			if (cur.dragged) {
				const target = hitNodeAt(clientToCanvas(ev.clientX, ev.clientY), cur.fromId);
				const p = plan();
				if (target && p) {
					apply(connect(p, cur.fromId, target), cur.fromId);
					setEdge({ from: cur.fromId, to: target });
				}
			} else {
				// Clean single click on '+' port -> quick-add next step or branch!
				if (cur.kind === "branch") addBranchFrom(cur.fromId);
				else addNextFrom(cur.fromId, "step");
			}
			refocus();
		};
		cancelActiveDrag = onCancel;
		window.addEventListener("mousemove", onMove, true);
		window.addEventListener("mouseup", onUp, true);
		window.addEventListener("blur", onCancel);
	};

	const startRouteDrag = (e: MouseEvent, line: Line, handle: EdgeHandle) => {
		if (e.button !== 0) return;
		e.preventDefault();
		e.stopPropagation();
		cancelActiveDrag?.();
		select(null);
		setEdge({ from: line.from, to: line.to });
		const startDelta = line.route?.[handle.key] ?? 0;
		let cur: RouteDrag = {
			from: line.from,
			to: line.to,
			key: handle.key,
			axis: handle.axis,
			startClient: { x: e.clientX, y: e.clientY },
			startDelta,
			curDelta: startDelta,
			moved: false,
		};

		const cleanup = () => {
			window.removeEventListener("mousemove", onMove, true);
			window.removeEventListener("mouseup", onUp, true);
			window.removeEventListener("blur", onCancel);
			if (cancelActiveDrag === onCancel) cancelActiveDrag = null;
		};
		const onCancel = () => {
			cleanup();
			setRouteDrag(null);
		};
		const onMove = (ev: MouseEvent) => {
			if (ev.buttons === 0) return onUp();
			const scale = view().scale || 1;
			const rawShift = cur.axis === "h" ? (ev.clientY - cur.startClient.y) / scale : (ev.clientX - cur.startClient.x) / scale;
			const moved = cur.moved || Math.abs(rawShift) > 2;
			if (!moved) return;
			const rawNext = cur.startDelta + rawShift;
			const snapped = ev.altKey ? Math.round(rawNext) : Math.round(rawNext / 4) * 4;
			const curDelta = Math.abs(snapped) <= 3 ? 0 : snapped;
			cur = { ...cur, curDelta, moved: true };
			setRouteDrag(cur);
		};
		const onUp = () => {
			cleanup();
			setRouteDrag(null);
			if (!cur.moved) return refocus();
			const p = plan();
			if (!p) return;
			const existing = p.edges.find((x) => x.from === cur.from && x.to === cur.to)?.route ?? {};
			const next: RouteOffsets = { ...existing, [cur.key]: cur.curDelta };
			apply(setEdgeRoute(p, cur.from, cur.to, next));
			setEdge({ from: cur.from, to: cur.to });
			refocus();
		};
		cancelActiveDrag = onCancel;
		window.addEventListener("mousemove", onMove, true);
		window.addEventListener("mouseup", onUp, true);
		window.addEventListener("blur", onCancel);
	};

	let justDraggedNodeAt = 0;

	const startNodeDrag = (e: MouseEvent, n: PlanNode) => {
		if (e.button !== 0 || n.pending || linking()) return;
		e.stopPropagation();
		cancelActiveDrag?.();
		const dir = direction();
		const startOffset = offsetFor(n.offset, dir);
		const curLayout = layout();
		const thisBox = curLayout?.boxes.find((b) => b.id === n.id && b.node);
		const otherCenters = (curLayout?.boxes ?? [])
			.filter((b) => b.node && b.id !== n.id)
			.map((b) => ({ cx: b.x + b.width / 2, cy: b.y + b.height / 2 }));
		const baseCenter = thisBox ? { cx: thisBox.x + thisBox.width / 2 - startOffset.x, cy: thisBox.y + thisBox.height / 2 - startOffset.y } : null;

		let cur: NodeDrag = { kind: "node", id: n.id, startClient: { x: e.clientX, y: e.clientY }, startOffset, curOffset: startOffset, moved: false };

		const cleanup = () => {
			window.removeEventListener("mousemove", onMove, true);
			window.removeEventListener("mouseup", onUp, true);
			window.removeEventListener("blur", onCancel);
			if (cancelActiveDrag === onCancel) cancelActiveDrag = null;
		};
		const onCancel = () => {
			cleanup();
			setNodeDrag(null);
		};
		const onMove = (ev: MouseEvent) => {
			if (ev.buttons === 0) return onUp();
			const scale = view().scale || 1;
			const dx = (ev.clientX - cur.startClient.x) / scale;
			const dy = (ev.clientY - cur.startClient.y) / scale;
			const moved = cur.moved || Math.hypot(ev.clientX - cur.startClient.x, ev.clientY - cur.startClient.y) > 4;
			if (!moved) return;
			let ox = cur.startOffset.x + dx;
			let oy = cur.startOffset.y + dy;
			let guideX: number | undefined;
			let guideY: number | undefined;
			if (!ev.altKey) {
				ox = Math.round(ox / 12) * 12;
				oy = Math.round(oy / 12) * 12;
				if (baseCenter) {
					const candCx = baseCenter.cx + ox;
					const candCy = baseCenter.cy + oy;
					for (const o of otherCenters) {
						if (guideX === undefined && Math.abs(candCx - o.cx) <= 6) {
							ox = Math.round(o.cx - baseCenter.cx);
							guideX = o.cx;
						}
						if (guideY === undefined && Math.abs(candCy - o.cy) <= 6) {
							oy = Math.round(o.cy - baseCenter.cy);
							guideY = o.cy;
						}
					}
				}
				if (Math.abs(ox) <= 4) ox = 0;
				if (Math.abs(oy) <= 4) oy = 0;
			} else {
				ox = Math.round(ox);
				oy = Math.round(oy);
			}
			cur = { ...cur, curOffset: { x: ox, y: oy }, moved: true, guideX, guideY };
			setNodeDrag(cur);
		};
		const onUp = () => {
			cleanup();
			setNodeDrag(null);
			if (!cur.moved) return;
			justDraggedNodeAt = performance.now();
			const p = plan();
			if (!p) return;
			const nextOffset: PlanOffset = { x: cur.curOffset.x, y: cur.curOffset.y, ...(dir === "RIGHT" ? { dir: "RIGHT" } : {}) };
			apply(setNodeOffset(p, cur.id, nextOffset), cur.id);
			refocus();
		};
		cancelActiveDrag = onCancel;
		window.addEventListener("mousemove", onMove, true);
		window.addEventListener("mouseup", onUp, true);
		window.addEventListener("blur", onCancel);
	};

	const startGroupDrag = (e: MouseEvent, groupId: string) => {
		if (e.button !== 0 || linking()) return;
		e.stopPropagation();
		cancelActiveDrag?.();
		const p = plan();
		const group = p?.groups.find((g) => g.id === groupId);
		if (!group) return;
		const dir = direction();
		const startOffset = offsetFor(group.offset, dir);
		let cur: NodeDrag = { kind: "group", id: groupId, startClient: { x: e.clientX, y: e.clientY }, startOffset, curOffset: startOffset, moved: false };

		const cleanup = () => {
			window.removeEventListener("mousemove", onMove, true);
			window.removeEventListener("mouseup", onUp, true);
			window.removeEventListener("blur", onCancel);
			if (cancelActiveDrag === onCancel) cancelActiveDrag = null;
		};
		const onCancel = () => {
			cleanup();
			setNodeDrag(null);
		};
		const onMove = (ev: MouseEvent) => {
			if (ev.buttons === 0) return onUp();
			const scale = view().scale || 1;
			const dx = (ev.clientX - cur.startClient.x) / scale;
			const dy = (ev.clientY - cur.startClient.y) / scale;
			const moved = cur.moved || Math.hypot(ev.clientX - cur.startClient.x, ev.clientY - cur.startClient.y) > 4;
			if (!moved) return;
			let ox = cur.startOffset.x + dx;
			let oy = cur.startOffset.y + dy;
			if (!ev.altKey) {
				ox = Math.round(ox / 12) * 12;
				oy = Math.round(oy / 12) * 12;
				if (Math.abs(ox) <= 4) ox = 0;
				if (Math.abs(oy) <= 4) oy = 0;
			} else {
				ox = Math.round(ox);
				oy = Math.round(oy);
			}
			cur = { ...cur, curOffset: { x: ox, y: oy }, moved: true };
			setNodeDrag(cur);
		};
		const onUp = () => {
			cleanup();
			setNodeDrag(null);
			if (!cur.moved) return;
			const latest = plan();
			if (!latest) return;
			const nextOffset: PlanOffset = { x: cur.curOffset.x, y: cur.curOffset.y, ...(dir === "RIGHT" ? { dir: "RIGHT" } : {}) };
			apply(setGroupOffset(latest, cur.id, nextOffset));
			refocus();
		};
		cancelActiveDrag = onCancel;
		window.addEventListener("mousemove", onMove, true);
		window.addEventListener("mouseup", onUp, true);
		window.addEventListener("blur", onCancel);
	};

	// --- Right-Click Context Menus -------------------------------------------

	const nodeContextMenu = async (e: MouseEvent, n: PlanNode) => {
		e.preventDefault();
		e.stopPropagation();
		select(n.id);
		const EDIT = "Edit label";
		const ADD_STEP = "Add step after";
		const ADD_BRANCH = "Add branch";
		const CONNECT = "Connect to another…";
		const TO_STEP = "Convert to Step";
		const TO_DECISION = "Convert to Decision";
		const STAGE = "Set stage group…";
		const DUP = "Duplicate";
		const RESET_POS = "Reset position";
		const CODE = "Inspect code";
		const TESTS = "Highlight test path";
		const BUILD = linksOf(n.id).length > 0 ? "Rebuild this step… (scheduled)" : "Build this step… (scheduled)";
		const DEL = "Delete";
		const canBranch = n.kind === "step" || n.kind === "call" || n.kind === "decision";
		const canDup = n.kind !== "start" && n.kind !== "end";
		const hasCode = linksOf(n.id).length > 0 || Boolean(n.ref?.trim());
		const off = offsetFor(n.offset, direction());
		const hasOffset = off.x !== 0 || off.y !== 0;
		const flowGroup: RowMenuEntry[] = [
			...(n.kind !== "end" ? [{ label: ADD_STEP, value: ADD_STEP, keys: "Enter" }] : []),
			...(canBranch ? [{ label: ADD_BRANCH, value: ADD_BRANCH, keys: "B" }] : []),
			...(n.kind !== "end" ? [{ label: CONNECT, value: CONNECT, keys: "C" }] : []),
		];
		const transformGroup: RowMenuEntry[] = [
			...(n.kind === "decision" ? [TO_STEP] : []),
			...(n.kind !== "decision" && canDup ? [TO_DECISION] : []),
			STAGE,
			...(canDup ? [DUP] : []),
			...(hasOffset ? [{ label: RESET_POS, value: RESET_POS, keys: "R" }] : []),
		];
		const codeGroup: RowMenuEntry[] = [
			...(hasCode ? [{ label: CODE, value: CODE, keys: "G" }] : []),
			TESTS,
			...(canDup ? [BUILD] : []),
		];
		const linked = linkedDocsOfNode(n);
		const docGroup: RowMenuEntry[] =
			linked.length === 1
				? [{ label: `Open linked doc: ${linked[0]!.label}`, value: "doc:0" }]
				: linked.length > 1
					? [
							{
								label: `Linked docs (${linked.length})`,
								children: linked.map((d, i) => ({
									label: d.kind ? `${d.kind}: ${d.label}` : d.label,
									value: `doc:${i}`,
								})),
							},
						]
					: [];
		const items: RowMenuEntry[] = [
			{ label: EDIT, value: EDIT, keys: "F2" },
			"separator",
			...flowGroup,
			"separator",
			...transformGroup,
			"separator",
			...codeGroup,
			...(docGroup.length ? (["separator", ...docGroup] as RowMenuEntry[]) : []),
			"separator",
			{ label: DEL, value: DEL, keys: "Del", danger: true },
		];
		const picked = await chooseFromMenu(`Actions for ${n.text || n.kind}`, items, { x: e.clientX, y: e.clientY });
		if (!picked) return refocus();
		if (picked === EDIT) setEditing({ node: n.id });
		else if (picked === ADD_STEP) addNextFrom(n.id, "step");
		else if (picked === ADD_BRANCH) addBranchFrom(n.id);
		else if (picked === CONNECT) beginLink(n.id);
		else if (picked === TO_STEP) changeKind(n.id, "step");
		else if (picked === TO_DECISION) changeKind(n.id, "decision");
		else if (picked === STAGE) void addStageGroupAsk(n.id);
		else if (picked === DUP) duplicateById(n.id);
		else if (picked === RESET_POS) resetNodePos(n.id);
		else if (picked === CODE) openCode(n.id);
		else if (picked === TESTS) highlightNodeTestPath(n.id);
		else if (picked === BUILD) triggerScheduledBuild({ kind: "node", id: n.id, label: n.text.trim() || n.id });
		else if (picked === DEL) remove();
		else if (picked.startsWith("doc:")) {
			const hit = linked[Number(picked.slice(4))];
			if (hit) openLinkedDoc(hit);
		}
	};

	const edgeContextMenu = async (e: MouseEvent, line: Line) => {
		e.preventDefault();
		e.stopPropagation();
		setEdge({ from: line.from, to: line.to });
		const LABEL = "Edit label";
		const INSERT = "Insert step on wire";
		const REVERSE = "Reverse direction";
		const RESET = "Reset wire route";
		const DEL = "Delete connection";
		const hasCustomRoute = Boolean(line.route && Object.keys(line.route).length > 0);
		const items: RowMenuEntry[] = [
			{ label: LABEL, value: LABEL, keys: "F2" },
			"separator",
			INSERT,
			REVERSE,
			...(hasCustomRoute ? [{ label: RESET, value: RESET, keys: "R" }] : []),
			"separator",
			{ label: DEL, value: DEL, keys: "Del", danger: true },
		];
		const picked = await chooseFromMenu("Actions for connection", items, { x: e.clientX, y: e.clientY });
		if (!picked) return refocus();
		if (picked === LABEL) setEditing({ from: line.from, to: line.to });
		else if (picked === INSERT) insertBetween(line.from, line.to);
		else if (picked === REVERSE) reverseSelectedEdge({ from: line.from, to: line.to });
		else if (picked === RESET) resetEdgeRoute({ from: line.from, to: line.to });
		else if (picked === DEL) remove();
	};

	const groupContextMenu = async (e: MouseEvent, groupId: string, groupName: string) => {
		e.preventDefault();
		e.stopPropagation();
		const RENAME = "Rename stage…";
		const COLOR = "Next stage colour";
		const RESET_STAGE = "Reset stage position";
		const BUILD_STAGE = "Build this stage… (scheduled)";
		const p = plan();
		const dir = direction();
		const gOff = offsetFor(p?.groups.find((g) => g.id === groupId)?.offset, dir);
		const movedStage = gOff.x !== 0 || gOff.y !== 0 || Boolean(p?.nodes.some((n) => n.group === groupId && (offsetFor(n.offset, dir).x !== 0 || offsetFor(n.offset, dir).y !== 0)));
		const items: RowMenuEntry[] = [
			RENAME,
			COLOR,
			...(movedStage ? [RESET_STAGE] : []),
			"separator",
			BUILD_STAGE,
		];
		const picked = await chooseFromMenu(`Stage ${groupName}`, items, { x: e.clientX, y: e.clientY });
		if (picked === RENAME) void renameStageAsk(groupId);
		else if (picked === COLOR) cycleRegionColor(groupName, 1);
		else if (picked === RESET_STAGE) resetGroupPos(groupId);
		else if (picked === BUILD_STAGE) triggerScheduledBuild({ kind: "stage", label: groupName });
	};

	const canvasContextMenu = async (e: MouseEvent) => {
		e.preventDefault();
		const ADD_STEP = "Add step";
		const ADD_DECISION = "Add decision";
		const BUILD_PLAN = "Trigger new build… (scheduled)";
		const WALK_TESTS = activePathIndex() === null ? "Walk test paths on chart" : "Hide highlighted test path";
		const OPEN_TICKET = "Open ticket";
		const OPEN_SPEC = "Open spec";
		const FLIP = direction() === "DOWN" ? "Switch to Horizontal layout" : "Switch to Vertical layout";
		const AUTO = "Auto-layout (reset manual positions)";
		const FIT = "Fit chart to view";
		const COPY_MERMAID = "Copy chart as Mermaid";
		const SYNC_MERMAID = "Sync Mermaid into spec / ticket…";
		const SAVE = "Save picture…";
		const p = plan();
		const manual = Boolean(p && hasManualLayout(p, direction()));
		const ticketVal = typeof p?.ticket === "string" ? p.ticket.trim() : "";
		const ticketDoc = ticketVal
			? docs().find((d) => d.group === "tickets" && d.exists && d.ticket?.toLowerCase() === ticketVal.toLowerCase()) ?? null
			: null;
		const specFile = specPath(props.path);
		const hasSpec =
			specFile !== props.path &&
			(documents.has(canonical(specFile)) ||
				docs().some((d) => d.exists && canonical(d.path) === canonical(specFile)) ||
				(await backend.read(specFile).then(
					() => true,
					() => false,
				)));
		const docItems: RowMenuEntry[] = [
			...(ticketDoc ? [OPEN_TICKET] : []),
			...(hasSpec ? [OPEN_SPEC] : []),
		];
		const items: RowMenuEntry[] = [
			ADD_STEP,
			ADD_DECISION,
			"separator",
			BUILD_PLAN,
			WALK_TESTS,
			...(docItems.length ? (["separator", ...docItems] as RowMenuEntry[]) : []),
			"separator",
			FLIP,
			...(manual ? [AUTO] : []),
			{ label: FIT, value: FIT, keys: "0" },
			"separator",
			{
				label: "Export / Sync",
				children: [
					{ label: COPY_MERMAID, value: COPY_MERMAID },
					{ label: SYNC_MERMAID, value: SYNC_MERMAID },
					"separator",
					{ label: SAVE, value: SAVE },
				],
			},
		];
		const picked = await chooseFromMenu("Flowchart actions", items, { x: e.clientX, y: e.clientY });
		if (picked === ADD_STEP) addNext();
		else if (picked === ADD_DECISION) addDecisionNode();
		else if (picked === BUILD_PLAN) triggerScheduledBuild({ kind: "plan", label: p?.title || "this plan" });
		else if (picked === WALK_TESTS) setActivePathIndex(activePathIndex() === null ? 0 : null);
		else if (picked === OPEN_TICKET && ticketDoc) void openFile(ticketDoc.path);
		else if (picked === OPEN_SPEC && hasSpec) void openFile(specFile);
		else if (picked === FLIP) toggleDirection();
		else if (picked === AUTO) resetAllLayout();
		else if (picked === FIT) fitOrWhole();
		else if (picked === COPY_MERMAID) void copyMermaid();
		else if (picked === SYNC_MERMAID) void syncMermaidToDoc();
		else if (picked === SAVE) savePlanPicture();
	};

	// --- Inline Text Editor Overlay ------------------------------------------

	const editBox = () => {
		const target = editing();
		const l = layout();
		const v = view();
		if (!target || !l) return null;
		if ("node" in target) {
			const b = l.boxes.find((x) => x.id === target.node);
			return b ? { left: b.x * v.scale + v.x, top: (b.y + b.height / 2 - 15) * v.scale + v.y, width: Math.max(170, b.width * v.scale) } : null;
		}
		const line = l.lines.find((x) => x.from === target.from && x.to === target.to);
		return line ? { left: line.at.x * v.scale + v.x - 60, top: line.at.y * v.scale + v.y - 15, width: 120 } : null;
	};
	const editValue = () => {
		const target = editing();
		const p = plan();
		if (!target || !p) return "";
		if ("node" in target) return p.nodes.find((n) => n.id === target.node)?.text ?? "";
		return p.edges.find((e) => e.from === target.from && e.to === target.to)?.label ?? "";
	};
	const commitEdit = (value: string, back = true) => {
		const target = editing();
		const p = plan();
		setEditing(null);
		if (back) refocus();
		if (!target || !p) return;
		if ("node" in target) {
			if (value.trim() && value !== p.nodes.find((n) => n.id === target.node)?.text) apply(setText(p, target.node, value.trim()));
		} else if (value !== (p.edges.find((e) => e.from === target.from && e.to === target.to)?.label ?? "")) {
			apply(setEdgeLabel(p, target.from, target.to, value.trim()));
		}
	};

	// --- Floating Contextual Action Bar Coordinates --------------------------

	const floatBarPos = createMemo(() => {
		if (editing() || far() || panning() || wireDrag() || routeDrag() || nodeDrag()?.moved) return null;
		const l = layout();
		if (!l || !canvas) return null;
		const rect = canvas.getBoundingClientRect();
		if (rect.width < 160) return null;
		const v = view();
		const half = Math.min(rect.width / 2 - 8, tight() ? 76 : 130);
		const chosenEdge = edge();
		if (chosenEdge) {
			const line = l.lines.find((x) => x.from === chosenEdge.from && x.to === chosenEdge.to);
			if (!line) return null;
			const left = Math.max(half, Math.min(rect.width - half, line.at.x * v.scale + v.x));
			const aboveTop = line.at.y * v.scale + v.y - 46;
			const belowTop = line.at.y * v.scale + v.y + 20;
			// Prefer above the wire unless it would sit off-screen or cover the source/target node card.
			const coversNode = (topY: number) =>
				l.boxes.some((b) => {
					if (!b.node) return false;
					const bx1 = b.x * v.scale + v.x;
					const by1 = b.y * v.scale + v.y;
					const bx2 = (b.x + b.width) * v.scale + v.x;
					const by2 = (b.y + b.height) * v.scale + v.y;
					return left + half > bx1 && left - half < bx2 && topY + 34 > by1 && topY < by2;
				});
			const preferBelow = (aboveTop < 10 || coversNode(aboveTop)) && belowTop <= rect.height - 46 && !coversNode(belowTop);
			const top = Math.max(10, Math.min(rect.height - 46, preferBelow ? belowTop : aboveTop < 10 ? belowTop : aboveTop));
			return { kind: "edge" as const, edge: line, left, top };
		}
		const selId = selected();
		if (!selId) return null;
		const b = l.boxes.find((x) => x.id === selId && x.node);
		if (!b?.node) return null;
		const left = Math.max(half, Math.min(rect.width - half, (b.x + b.width / 2) * v.scale + v.x));
		const rawTop = b.y * v.scale + v.y - 42;
		const top = rawTop < 10 ? (b.y + b.height) * v.scale + v.y + 14 : Math.min(rect.height - 46, rawTop);
		return { kind: "node" as const, node: b.node, left, top };
	});

	// --- Plan & Node Field Mutators (shared with Palette via planBridge) -----

	const setPlanField = (field: "title" | "goal" | "ticket", value: string) => {
		const p = plan();
		if (!p) return;
		const { [field]: _old, ...rest } = p;
		apply((value.trim() || field === "title" ? { ...rest, [field]: value.trim() } : rest) as Plan);
	};
	const setTargets = (value: string) => {
		const p = plan();
		if (!p) return;
		const { targets: _old, ...rest } = p;
		const list = value
			.split(",")
			.map((t) => t.trim())
			.filter(Boolean);
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
	const setNodeRef = (value: string) => {
		const p = plan();
		const node = selectedNode();
		if (!p || !node) return;
		const trimmed = value.trim();
		if (node.kind === "step" || node.kind === "call") {
			if (trimmed) apply(setKind(p, node.id, "call", trimmed), node.id);
			else apply(setKind(p, node.id, "step"), node.id);
			return;
		}
		setNodeField("ref", trimmed);
	};
	const groupName = () => plan()?.groups.find((g) => g.id === selectedNode()?.group)?.name ?? "";

	// Expose reactive plan state, editing actions, and Assistant callbacks to the Palette panel.
	createEffect(() => {
		const active = state.groups[state.activeGroup]?.active === props.path && !state.planText[props.path];
		const hasPlan = Boolean(plan());
		if (!active || !hasPlan) return;
		const unregister = registerPlanBridge({
			path: props.path,
			planUri,
			plan,
			text,
			selectedId: selected,
			selectedNode,
			selectedLinks: () => linksOf(selected()),
			builtUnits: () => {
				const cur = plan();
				return cur ? (builtOf(cur)?.units ?? []) : [];
			},
			groupName,
			linking: () => Boolean(linking()),
			layoutDir: direction,
			stages: () => {
				const cur = plan();
				if (!cur) return [];
				return cur.groups.map((g) => {
					const members = cur.nodes.filter((n) => n.group === g.id);
					return { id: g.id, name: g.name, count: members.length, firstNodeId: members[0]?.id };
				});
			},
			codeStateOf,
			codeStatusCounts,
			nodesByCodeState,
			allPaths,
			activePathIndex,
			setActivePathIndex,
			stepActivePath,
			scheduledNotice,
			clearScheduledNotice: () => setScheduledNotice(null),
			triggerScheduledBuild,
			openAssistant,
			setPlanField: (field, value) => setPlanField(field, field === "ticket" ? ticketKey(value) : value),
			setTargets,
			addTestCase: (input) => {
				const p = plan();
				if (p) apply(addPlanTest(p, input));
			},
			updateTestCase: (id, patch) => {
				const p = plan();
				if (p) apply(updatePlanTest(p, id, patch));
			},
			removeTestCase: (id) => {
				const p = plan();
				if (p) apply(removePlanTest(p, id));
			},
			setNodeText: (value) => {
				const p = plan();
				const node = selectedNode();
				if (p && node && value.trim() && value.trim() !== node.text) apply(setText(p, node.id, value.trim()));
			},
			setNodeKind: (kind) => {
				const node = selectedNode();
				if (!node) return;
				if (kind === "step" && node.kind === "call") return;
				changeKind(node.id, kind);
			},
			setNodeField,
			setNodeRef,
			setNodeGroup: (name) => {
				const p = plan();
				const node = selectedNode();
				if (p && node) apply(setGroup(p, node.id, name));
			},
			renameStage: (groupId) => void renameStageAsk(groupId),
			openCodeUnit: (unit) => void openProcedure(planUri(), unit),
			openReference: (ref) => void openReference(ref),
			openScript: (script, line) => void openScript(script, line),
			selectNode: (id) => goTo(id),
			clearSelection: () => (select(null), refocus()),
			setWalkedPath: (nodes) => setWalked(nodes),
			addStep: () => (addNext(), refocus()),
			addDecision: () => (addDecisionNode(), refocus()),
			addBranch: () => (addBranchFrom(selected()), refocus()),
			addCall: () => void addCallAsk(),
			addStageGroup: () => void addStageGroupAsk(),
			toggleConnect: () => (linking() ? setLinking(null) : beginLink(), refocus()),
			toggleLayoutDir: toggleDirection,
			jumpToNode: goTo,
			peekNode,
			openTextTestBuilder,
		});
		onCleanup(unregister);
	});

	const healthMenu = (): MenuItem[] => {
		const count = findingCount();
		const counts = codeStatusCounts();
		const unbuilt = counts.grey + counts.yellow + counts.red;
		return [
			{
				label: count ? `Show ${count} ${count === 1 ? "finding" : "findings"} in Problems` : "Open Problems panel",
				run: () => (setState("bottomView", "problems"), setState("settings", "layout", "bottom", true)),
			},
			{
				label: "Compare chart and code",
				run: () => {
					const uri = planUri();
					if (uri) recheckPlan(uri);
					notify("Comparing chart against workspace code.");
				},
			},
			"separator",
			{
				label: unbuilt > 0 ? `Trigger new build (${unbuilt} pending)… (scheduled)` : "Trigger new build… (scheduled)",
				run: () => triggerScheduledBuild({ kind: "plan", label: plan()?.title || "this plan" }),
			},
			{
				label: "Open Assistant tab",
				run: openAssistant,
			},
		];
	};

	const exportMenu = (): MenuItem[] => [
		{
			label: "Copy chart as Mermaid",
			run: () => void copyMermaid(),
			disabled: !plan(),
			why: "The plan is not loaded yet",
		},
		{
			label: "Sync Mermaid into spec / ticket…",
			run: () => void syncMermaidToDoc(),
			disabled: !plan(),
			why: "The plan is not loaded yet",
		},
		"separator",
		{
			label: "Save picture…",
			run: savePlanPicture,
			disabled: isTextMode() || !layout(),
			why: isTextMode() ? "Switch to Chart view to save an SVG picture" : "The chart is not drawn yet",
		},
	];

	const more = (): MenuItem[] => {
		const p = plan();
		const manual = Boolean(p && hasManualLayout(p, direction()));
		const pathCount = allPaths().paths.length;
		const ticketVal = typeof p?.ticket === "string" ? p.ticket.trim() : "";
		const ticketDoc = ticketVal
			? docs().find((d) => d.group === "tickets" && d.exists && d.ticket?.toLowerCase() === ticketVal.toLowerCase()) ?? null
			: null;
		const specFile = specPath(props.path);
		const hasSpec =
			specFile !== props.path &&
			(documents.has(canonical(specFile)) || docs().some((d) => d.exists && canonical(d.path) === canonical(specFile)));
		return [
			{
				label: "Trigger new build… (scheduled)",
				run: () => triggerScheduledBuild({ kind: "plan", label: p?.title || "this plan" }),
			},
			{ label: "Open Assistant tab", run: openAssistant },
			...(ticketDoc ? [{ label: "Open ticket", run: () => void openFile(ticketDoc.path) }] : []),
			...(hasSpec ? [{ label: "Open spec", run: () => void openFile(specFile) }] : []),
			{
				label: activePathIndex() === null ? `Walk test paths (${pathCount})` : "Hide highlighted test path",
				disabled: pathCount === 0,
				why: "No path leads from Start through this chart yet",
				run: () => setActivePathIndex(activePathIndex() === null ? 0 : null),
			},
			"separator",
			{ label: direction() === "DOWN" ? "Switch to Horizontal layout" : "Switch to Vertical layout", run: toggleDirection },
			...(manual ? [{ label: "Auto-layout (reset manual positions)", run: resetAllLayout }] : []),
			{ label: keysOpen() ? "Hide keyboard shortcuts" : "Keyboard shortcuts & legend", keys: "?", run: () => setKeysOpen((open) => !open) },
			"separator",
			{
				label: "Copy chart as Mermaid",
				run: () => void copyMermaid(),
				disabled: !p,
				why: "The plan is not loaded yet",
			},
			{
				label: "Sync Mermaid into spec / ticket…",
				run: () => void syncMermaidToDoc(),
				disabled: !p,
				why: "The plan is not loaded yet",
			},
			{
				label: "Save picture…",
				run: savePlanPicture,
				disabled: isTextMode() || !layout(),
				why: isTextMode() ? "Switch to Chart view to save an SVG picture" : "The chart is not drawn yet",
			},
		];
	};

	let dragging: { x: number; y: number; moved: boolean } | null = null;
	let panned = 0;

	const gridStep = () => Math.max(12, 24 * view().scale);

	return (
		<div class="plan" classList={{ compact: compact(), tight: tight() }}>
			<Show
				when={plan()}
				fallback={
					<div class="plan-error">
						<p>This plan's text cannot be read as a chart.</p>
						<p class="hint">{parsed().error}</p>
						<button onClick={() => setPlanMode(props.path, "source")}>Fix it in the source</button>
					</div>
				}
			>
				{/* Slim, calm top bar: title, step finder, layout direction switch (chart), health pill, overflow menu. */}
				<div class="plan-topbar" classList={{ compact: compact(), tight: tight() }}>
					<span class="plan-topbar-title" title={plan()!.title || "Plan"}>
						{plan()!.title || "Plan"}
					</span>
					<Finder
						choices={plan()!.nodes.map((n) => ({
							id: n.id,
							name: n.text.trim() || "(no words yet)",
							where: plan()!.groups.find((g) => g.id === n.group)?.name ?? (n.kind === "call" ? "step" : n.kind),
						}))}
						label="Find a step by its words and select it"
						title="Type part of a step's words to jump right to it"
						placeholder="Find a step…"
						none={(typed) => `No step has “${typed}” in its words.`}
						onChoose={goTo}
					/>
					<span class="spacer" />
					<Show when={!isTextMode() && hasManualLayout(plan()!, direction())}>
						<button
							type="button"
							class="plan-reset-pill"
							title="Reset all manually moved nodes, stages, and wires back to automatic layout"
							onClick={(e) => (resetAllLayout(), after(e))}
						>
							<Icon name="layout" />
							<span class="plan-reset-text">Auto-layout</span>
						</button>
					</Show>
					<Show when={!isTextMode()}>
						<div class="plan-dir-switch" role="group" aria-label="Flowchart layout direction">
							<button
								type="button"
								classList={{ on: direction() === "DOWN" }}
								aria-pressed={direction() === "DOWN"}
								title="Top-to-bottom vertical layout"
								onClick={(e) => (setDirection("DOWN"), after(e))}
							>
								<Icon name="arrow-down" />
								<span class="plan-dir-label">Vertical</span>
							</button>
							<button
								type="button"
								classList={{ on: direction() === "RIGHT" }}
								aria-pressed={direction() === "RIGHT"}
								title="Left-to-right horizontal layout"
								onClick={(e) => (setDirection("RIGHT"), after(e))}
							>
								<Icon name="arrow-right" />
								<span class="plan-dir-label">Horizontal</span>
							</button>
						</div>
					</Show>
					<Menu
						label="Export or sync chart"
						title="Copy chart as Mermaid, sync into a spec or ticket, or save SVG picture"
						class="plan-status-menu"
						items={exportMenu}
					>
						<Icon name="copy" />
						<span class="plan-status-text">Export</span>
					</Menu>
					<Menu
						label={findingCount() ? `${findingCount()} chart findings and build actions` : "Chart is clean — health and build actions"}
						title={findingCount() ? `${findingCount()} ${findingCount() === 1 ? "finding" : "findings"} — check health or trigger build` : "Clean — check health or trigger a new build"}
						class={`plan-status-menu ${findingCount() ? "warn" : "ok"}`}
						items={healthMenu}
					>
						<Icon name={findingCount() ? "warning" : "check"} />
						<span class="plan-status-text">{findingCount() ? `${findingCount()} ${findingCount() === 1 ? "finding" : "findings"}` : "Clean"}</span>
					</Menu>
					<Menu label="More for the chart" title="More: layout, keys, Mermaid export, save picture" class="graph-more" items={more}>
						<Icon name="ellipsis" />
					</Menu>
				</div>

				<div class="plan-stage" ref={watchCanvas}>
					<Show
						when={!isTextMode()}
						fallback={
							<PlanTextView
								plan={plan()!}
								selectedId={selected()}
								peekedId={peeked()?.id ?? null}
								allPaths={allPaths()}
								activePathIndex={activePathIndex()}
								onPathNodes={onPath()?.nodes ?? null}
								codeStateOf={codeStateOf}
								troubleOf={(id) => issues().get(id)}
								builderRequest={builderRequest()}
								onSelectNode={(id) => select(id)}
								onPeekNode={peekNode}
								onShowOnChart={showOnChart}
								onStepPath={stepActivePath}
								onClearPath={() => setActivePathIndex(null)}
								onHighlightPath={setActivePathIndex}
								onAddTestCase={(input) => {
									const p = plan();
									if (p) apply(addPlanTest(p, input));
								}}
								onUpdateTestCase={(id, patch) => {
									const p = plan();
									if (p) apply(updatePlanTest(p, id, patch));
								}}
								onRemoveTestCase={(id) => {
									const p = plan();
									if (p) apply(removePlanTest(p, id));
								}}
							/>
						}
					>
					<div
						class="plan-canvas"
						ref={(el) => {
							canvas = el;
						}}
						tabIndex={0}
						role="application"
						aria-label="Plan chart. Hover any node or edge to add steps or drag connections; arrow keys navigate."
						aria-describedby={keysOpen() ? keysId : undefined}
						classList={{
							linking: Boolean(linking()),
							wiring: Boolean(wireDrag()?.dragged),
							panning: panning() || Boolean(nodeDrag()?.moved),
							pathing: Boolean(onPath()),
							far: far(),
						}}
						onKeyDown={onKey}
						onContextMenu={(e) => void canvasContextMenu(e)}
						onWheel={(e) => {
							e.preventDefault();
							const box = canvas.getBoundingClientRect();
							zoomBy(e.deltaY < 0 ? 1.1 : 0.9, { x: e.clientX - box.left, y: e.clientY - box.top });
						}}
						onMouseDown={(e) => {
							if (e.button !== 0) return;
							if (e.target instanceof Element && e.target.closest(".plan-edit, .plan-keys, .plan-float-bar, .plan-float-controls, .plan-port, .plan-seg-handle, .plan-group-header, .plan-doc-badge")) return;
							dragging = { x: e.clientX, y: e.clientY, moved: false };
							panned = 0;
						}}
						onMouseMove={(e) => {
							if (!dragging) return;
							if (e.buttons === 0) {
								dragging = null;
								setPanning(false);
								return;
							}
							const dx = e.clientX - dragging.x;
							const dy = e.clientY - dragging.y;
							if (Math.abs(dx) + Math.abs(dy) > 2) {
								dragging.moved = true;
								setPanning(true);
							}
							panned += Math.abs(dx) + Math.abs(dy);
							const v = view();
							setView({ ...v, x: v.x + dx, y: v.y + dy });
							dragging = { ...dragging, x: e.clientX, y: e.clientY };
						}}
						onMouseUp={() => {
							dragging = null;
							setPanning(false);
						}}
						onMouseLeave={() => {
							dragging = null;
							setPanning(false);
						}}
						onDragOver={(e) => {
							const types = e.dataTransfer?.types;
							if (!types?.includes(PROCEDURE_DRAG) && !types?.includes(SHAPE_DRAG)) return;
							e.preventDefault();
							const pt = clientToCanvas(e.clientX, e.clientY);
							const hitN = hitNodeAt(pt);
							if (hitN) {
								setDropNodeId(hitN);
								setDropEdgeKey(null);
							} else {
								const hitE = hitEdgeAt(pt);
								setDropNodeId(null);
								setDropEdgeKey(hitE ? `${hitE.from}>${hitE.to}` : null);
							}
						}}
						onDragLeave={(e) => {
							if (!canvas.contains(e.relatedTarget as Node | null)) {
								setDropNodeId(null);
								setDropEdgeKey(null);
							}
						}}
						onDrop={(e) => {
							const procName = e.dataTransfer?.getData(PROCEDURE_DRAG);
							const shapeKind = e.dataTransfer?.getData(SHAPE_DRAG);
							const p = plan();
							const targetNode = dropNodeId();
							const targetEdge = dropEdgeKey();
							setDropNodeId(null);
							setDropEdgeKey(null);
							if (!p || (!procName && !shapeKind)) return;
							e.preventDefault();
							if (procName) {
								if (targetEdge) {
									const [from, to] = targetEdge.split(">");
									if (from && to) insertBetween(from, to, "call", procName, procName);
								} else {
									applyEdit(addCall(p, procName, targetNode ?? selected() ?? undefined));
								}
								return refocus();
							}
							if (shapeKind === "branch") {
								addBranchFrom(targetNode ?? selected());
								return refocus();
							}
							if (shapeKind === "call") {
								void addCallAsk(targetNode ?? selected());
								return;
							}
							const kind: NodeKind = shapeKind === "decision" ? "decision" : shapeKind === "end" ? "end" : "step";
							if (targetEdge) {
								const [from, to] = targetEdge.split(">");
								if (from && to) insertBetween(from, to, kind);
							} else {
								addNextFrom(targetNode ?? selected(), kind);
							}
							refocus();
						}}
					>
						<svg
							class="graph-canvas"
							ref={(el) =>
								el.addEventListener(
									"click",
									(e) => {
										if (!far() || panned > 3 || linking()) return;
										const box = el.getBoundingClientRect();
										const v = view();
										if (comeIn({ x: (e.clientX - box.left - v.x) / v.scale, y: (e.clientY - box.top - v.y) / v.scale })) e.stopPropagation();
									},
									true,
								)
							}
							onClick={(e) => {
								if (panned > 4) return;
								if (e.target === e.currentTarget || (e.target instanceof Element && e.target.classList.contains("plan-grid-bg"))) {
									if (!linking()) {
										select(null);
										setEdge(null);
									}
									refocus();
								}
							}}
						>
							<defs>
								<pattern id={gridId} width={gridStep()} height={gridStep()} x={view().x} y={view().y} patternUnits="userSpaceOnUse">
									<circle class="plan-grid-dot" cx={1.5} cy={1.5} r={Math.max(0.85, Math.min(1.35, 1.15 * Math.sqrt(view().scale)))} />
								</pattern>
								<For each={["plain", "back", "near", "on"]}>
									{(kind) => (
										<marker
											id={`plan-arrow-${kind}`}
											viewBox="0 0 10 10"
											refX="8.5"
											refY="5"
											markerWidth="9"
											markerHeight="9"
											markerUnits="userSpaceOnUse"
											orient="auto-start-reverse"
										>
											<path d="M0,1.2 L9.2,5 L0,8.8 L2.1,5 z" class={`arrow plan-${kind}`} />
										</marker>
									)}
								</For>
							</defs>

							{/* Interactive scaled dot-grid background. */}
							<Show when={view().scale >= 0.32}>
								<rect class="plan-grid-bg" width="100%" height="100%" fill={`url(#${gridId})`} />
							</Show>

							<g class="plan-probe" aria-hidden="true">
								<text class="plan-probe-node" ref={nodeProbe} />
								<text class="plan-probe-label" ref={labelProbe} />
								<text class="plan-group-name" ref={stageProbe} />
							</g>

							<Show when={layout()}>
								<g transform={`translate(${view().x},${view().y}) scale(${view().scale})`}>
									{/* Stage group container frames (rendered behind edges). */}
									<For each={groupIds()}>
										{(gid) => {
											const b = () => boxById().get(gid);
											const col = () => regionColor(b()?.group ?? "");
											return (
												<Show when={b()}>
													<g class="g-region plan-group" onContextMenu={(e) => b()?.group && void groupContextMenu(e, gid, b()!.group!)}>
														<rect
															class="plan-group-box"
															x={b()!.x}
															y={b()!.y}
															width={b()!.width}
															height={b()!.height}
															rx="12"
															style={{
																stroke: `color-mix(in srgb, ${col()} 48%, transparent)`,
																fill: `color-mix(in srgb, ${col()} 6.5%, transparent)`,
															}}
														/>
													</g>
												</Show>
											);
										}}
									</For>

									{/* Edges with hover '+' insert-on-wire port and right-click menu. */}
									<For each={edgeKeys()}>
										{(ek) => {
											const line = () => lineByKey().get(ek);
											const on = () => {
												const l = line();
												return Boolean(l && edge()?.from === l.from && edge()?.to === l.to);
											};
											const near = () => {
												const l = line();
												const at = pointed() ?? selected();
												return Boolean(l && at !== null && (l.from === at || l.to === at));
											};
											const isDrop = () => dropEdgeKey() === ek;
											const activeDrag = () => {
												const l = line();
												const d = routeDrag();
												return l && d && d.from === l.from && d.to === l.to ? d : null;
											};
											const choose = (e: MouseEvent) => {
												const l = line();
												if (!l) return;
												e.stopPropagation();
												select(null);
												setEdge({ from: l.from, to: l.to });
												refocus();
											};
											return (
												<Show when={line()}>
													<g
														class="plan-edge"
														classList={{
															on: on(),
															near: near(),
															back: Boolean(line()?.back),
															pending: Boolean(line()?.pending),
															removing: Boolean(line()?.removing),
															dragging: Boolean(activeDrag()),
															"drop-target": isDrop(),
															"on-path": Boolean(onPath()?.ways.has(ek)),
														}}
														role="img"
														aria-label={plan() && line() ? describeEdge(plan()!, line()!) : undefined}
														onContextMenu={(e) => line() && void edgeContextMenu(e, line()!)}
													>
														<path d={pathOf(line()!.points)} class="plan-edge-hit" onClick={choose} />
														<path
															d={pathOf(line()!.points)}
															class="g-edge"
															marker-end={`url(#plan-arrow-${on() || onPath()?.ways.has(ek) ? "on" : near() ? "near" : line()!.back ? "back" : "plain"})`}
														/>
														{/* Hover '+' button on edge midpoint to insert a step directly between two nodes. */}
														<Show when={!far() && !line()!.pending && !line()!.removing && !activeDrag()}>
															<g
																class="plan-port"
																transform={`translate(${line()!.mid.x},${line()!.mid.y})`}
																onMouseDown={(e) => e.stopPropagation()}
																onClick={(e) => {
																	e.stopPropagation();
																	const l = line();
																	if (l) insertBetween(l.from, l.to);
																}}
															>
																<title>Insert a step on this connection</title>
																<circle class="plan-port-hit" r="14" />
																<circle class="plan-port-bg" r="9.5" />
																<path class="plan-port-plus" d="M-4,0 L4,0 M0,-4 L0,4" />
															</g>
														</Show>
													</g>
												</Show>
											);
										}}
									</For>

									{/* Edge labels in their own layer above ALL lines so no sibling wire can paint over a label pill. */}
									<g class="plan-labels">
										<For each={labeledEdgeKeys()}>
											{(ek) => {
												const line = () => lineByKey().get(ek);
												const on = () => {
													const l = line();
													return Boolean(l && edge()?.from === l.from && edge()?.to === l.to);
												};
												const lowerLabel = () => (line()?.shown ?? "").trim().toLowerCase();
												const choose = (e: MouseEvent) => {
													const l = line();
													if (!l) return;
													e.stopPropagation();
													select(null);
													setEdge({ from: l.from, to: l.to });
													refocus();
												};
												return (
													<Show when={line()?.shown}>
														<g
															class="plan-label"
															classList={{
																on: on(),
																missing: Boolean(line()?.missing),
																yes: lowerLabel() === "yes" || lowerLabel() === "true",
																no: lowerLabel() === "no" || lowerLabel() === "false",
																"on-path": Boolean(onPath()?.ways.has(ek)),
															}}
															onMouseDown={(e) => e.stopPropagation()}
															onClick={choose}
															onDblClick={(e) => {
																e.stopPropagation();
																const l = line();
																if (l) setEditing({ from: l.from, to: l.to });
															}}
															onContextMenu={(e) => line() && void edgeContextMenu(e, line()!)}
														>
															<rect x={line()!.at.x - line()!.labelWidth / 2} y={line()!.at.y - 10.5} width={line()!.labelWidth} height="21" rx="10.5" />
															<text x={line()!.at.x} y={line()!.at.y + 4} text-anchor="middle">
																{line()!.shown}
															</text>
														</g>
													</Show>
												);
											}}
										</For>
									</g>

									{/* Stage header pills rendered cleanly inside top padding, layered above edges so arrows never slice through titles. */}
									<For each={groupIds()}>
										{(gid) => {
											const b = () => boxById().get(gid);
											const col = () => regionColor(b()?.group ?? "");
											const pillW = () => {
												const cur = b();
												return cur ? (cur.pillWidth ?? Math.max(82, Math.min(cur.width - 20, (cur.group?.length ?? 0) * 7 + 44))) : 82;
											};
											const pillY = () => (b()?.y ?? 0) + 8;
											const pillCy = () => pillY() + 11;
											return (
												<Show when={b()?.group}>
													<g
														class="plan-group-header"
														classList={{ dragging: nodeDrag()?.kind === "group" && nodeDrag()?.id === gid && Boolean(nodeDrag()?.moved) }}
														onMouseDown={(e) => startGroupDrag(e, gid)}
														onContextMenu={(e) => b()?.group && void groupContextMenu(e, gid, b()!.group!)}
														onDblClick={(e) => {
															e.stopPropagation();
															void renameStageAsk(gid);
														}}
													>
														<title>{`Stage "${b()!.group}" (${b()!.memberCount ?? 0} steps). Drag to move stage; double-click to rename; click swatch to cycle colour.`}</title>
														<rect
															class="plan-group-pill"
															x={b()!.x + 10}
															y={pillY()}
															width={pillW()}
															height={22}
															rx={11}
															style={{ stroke: `color-mix(in srgb, ${col()} 52%, transparent)` }}
														/>
														<circle
															class="plan-group-swatch"
															cx={b()!.x + 22}
															cy={pillCy()}
															r={4.5}
															style={{ fill: col() }}
															onMouseDown={(e) => e.stopPropagation()}
															onClick={(e) => {
																e.stopPropagation();
																if (b()?.group) cycleRegionColor(b()!.group!, e.shiftKey ? -1 : 1);
															}}
														/>
														<text class="plan-group-name" x={b()!.x + 32} y={pillCy() + 4}>
															{b()!.group}
														</text>
														<Show when={b()!.memberCount !== undefined}>
															<text class="plan-group-count" x={b()!.x + 10 + pillW() - 10} y={pillCy() + 3.5} text-anchor="end">
																{b()!.memberCount}
															</text>
														</Show>
													</g>
												</Show>
											);
										}}
									</For>

									{/* Node shapes with icons, notes badge, built mark, hover '+' quick-add & drag-wire ports. */}
									<For each={nodeIds()}>
										{(nid) => {
											const b = () => boxById().get(nid);
											const n = () => b()?.node;
											const cx = () => {
												const cur = b();
												return cur ? cur.x + cur.width / 2 : 0;
											};
											const cy = () => {
												const cur = b();
												return cur ? cur.y + cur.height / 2 : 0;
											};
											const textX = () => {
												const kind = n()?.kind;
												return kind === "start" || kind === "end" ? cx() + 6 : cx();
											};
											const hasBuilt = () => linksOf(nid).length > 0;
											const hasNotes = () => Boolean(n()?.notes?.trim());
											const linkedDocs = () => (n() ? linkedDocsOfNode(n()!) : []);
											const docBadgePos = () => {
												const cur = b();
												const count = linkedDocs().length;
												if (!cur || !count) return { x: 0, y: 0, w: 0 };
												const w = 22 + (String(count).length - 1) * 5.5;
												if (n()?.kind === "decision") {
													return {
														x: cur.x + cur.width - cur.width / 4 - w / 2 - (trouble() ? 14 : 0),
														y: cur.y + cur.height / 4 - 8,
														w,
													};
												}
												return {
													x: cur.x + cur.width - w - (trouble() ? 16 : 6),
													y: cur.y - 7.5,
													w,
												};
											};
											const codeState = () => (n() ? codeIndicator(stateOf(n()!)) : "grey");
											const showCodeDot = () => {
												const kind = n()?.kind;
												if (!kind) return false;
												if (kind === "start" || kind === "end") return hasBuilt() || codeState() !== "grey";
												return true;
											};
											const builtPos = () => {
												const cur = b();
												if (!cur) return { x: 0, y: 0 };
												if (n()?.kind === "decision") {
													const rowY = cur.y + cur.height - 18;
													const dx = hasNotes() ? 10 : 0;
													return { x: cx() - dx - 3, y: rowY - 3 };
												}
												const inset = n()?.kind === "start" || n()?.kind === "end" ? 16 : 8;
												return { x: cur.x + inset, y: cur.y + cur.height - 11.5 };
											};
											const notePos = () => {
												const cur = b();
												if (!cur) return { x: 0, y: 0, anchor: "start" as const };
												if (n()?.kind === "decision") {
													const rowY = cur.y + cur.height - 18;
													const dx = showCodeDot() ? 10 : 0;
													return { x: cx() + dx, y: rowY + 4, anchor: "middle" as const };
												}
												const inset = n()?.kind === "start" || n()?.kind === "end" ? 22 : 17;
												return { x: cur.x + cur.width - inset, y: cur.y + cur.height - 6, anchor: "start" as const };
											};
											const trouble = () => issues().get(nid);
											const mark = () => (n() ? statusMark(stateOf(n()!)) : null);
											const isSel = () => selected() === nid;
											const corner = () => {
												const cur = b();
												return cur && n()?.kind === "decision" ? { x: cur.width / 4, y: cur.height / 4 } : { x: 4, y: 4 };
											};
											const primaryPort = () => {
												const cur = b();
												if (!cur) return { x: 0, y: 0 };
												return direction() === "RIGHT" ? { x: cur.x + cur.width, y: cy() } : { x: cx(), y: cur.y + cur.height };
											};
											const branchPort = () => {
												const cur = b();
												if (!cur) return { x: 0, y: 0 };
												return direction() === "RIGHT" ? { x: cx(), y: cur.y + cur.height } : { x: cur.x + cur.width, y: cy() };
											};
											const canBranch = () => n()?.kind === "step" || n()?.kind === "call" || n()?.kind === "decision";
											const visualKind = () => (n()?.kind === "call" ? "step" : (n()?.kind ?? "step"));
											const shapeRx = () => {
												const cur = b();
												const kind = n()?.kind;
												return cur && (kind === "start" || kind === "end") ? Math.min(cur.height / 2, 26) : 8;
											};
											return (
												<Show when={b() && n()}>
													<g
														class={`plan-node ${visualKind()} unit-${unitStatuses().get(nid) ?? "none"}`}
														classList={{
															"on-path": Boolean(onPath()?.nodes.has(nid)),
															selected: isSel(),
															peeked: peeked()?.id === nid && !isSel(),
															dragging: nodeDrag()?.kind === "node" && nodeDrag()?.id === nid && Boolean(nodeDrag()?.moved),
															origin: linking() === nid || wireDrag()?.fromId === nid,
															"drop-target": dropNodeId() === nid,
															trouble: Boolean(trouble()),
															pending: Boolean(n()!.pending),
															changed: changedOnly().has(nid),
															gone: gone().has(nid),
														}}
														role="img"
														aria-label={describeNode(n()!, stateOf(n()!))}
														onMouseDown={(e) => n() && startNodeDrag(e, n()!)}
														onMouseEnter={() => setPointed(nid)}
														onMouseLeave={() => setPointed(null)}
														onClick={(e) => {
															e.stopPropagation();
															const node = n();
															if (!node || node.pending || performance.now() - justDraggedNodeAt < 120) return;
															if (e.ctrlKey || e.metaKey) openCode(nid);
															else clickNode(nid);
														}}
														onDblClick={(e) => (e.stopPropagation(), !n()?.pending && setEditing({ node: nid }))}
														onContextMenu={(e) => n() && !n()!.pending && void nodeContextMenu(e, n()!)}
													>
														<title>
															{[
																n()!.text,
																n()!.notes,
																linkedDocs().length ? `Linked docs: ${linkedDocs().map((d) => d.label).join(", ")}` : "",
																showCodeDot() ? `Code status: ${CODE_INDICATOR_WORDS[codeState()].label} — ${CODE_INDICATOR_WORDS[codeState()].detail}` : "",
																mark() ? MARK_WORDS[mark()!] : "",
																changedOnly().has(nid) && mark() !== "changed" ? MARK_WORDS.changed : "",
																...(trouble() ?? []),
																linksOf(nid).length > 0 || n()!.ref?.trim() ? "Code linked — expand Implementation in Palette or Ctrl+click to inspect." : "",
															]
																.filter(Boolean)
																.join("\n")}
														</title>
														{/* Soft selection halo */}
														<Show when={isSel()}>
															<Show
																when={n()!.kind === "decision"}
																fallback={<rect class="node-halo" x={b()!.x - 1} y={b()!.y - 1} width={b()!.width + 2} height={b()!.height + 2} rx={shapeRx() + 1} />}
															>
																<polygon class="node-halo" points={`${cx()},${b()!.y - 2} ${b()!.x + b()!.width + 2},${cy()} ${cx()},${b()!.y + b()!.height + 2} ${b()!.x - 2},${cy()}`} />
															</Show>
														</Show>
														{/* Non-intrusive peek spotlight halo (keeps current selection locked) */}
														<Show when={peeked()?.id === nid && !isSel()}>
															<Show
																when={n()!.kind === "decision"}
																fallback={<rect class="node-peek-halo" x={b()!.x - 4} y={b()!.y - 4} width={b()!.width + 8} height={b()!.height + 8} rx={shapeRx() + 3} />}
															>
																<polygon class="node-peek-halo" points={`${cx()},${b()!.y - 5} ${b()!.x + b()!.width + 5},${cy()} ${cx()},${b()!.y + b()!.height + 5} ${b()!.x - 5},${cy()}`} />
															</Show>
														</Show>
														{/* Main shape */}
														<Show
															when={n()!.kind === "decision"}
															fallback={<rect class="node-shape" x={b()!.x} y={b()!.y} width={b()!.width} height={b()!.height} rx={shapeRx()} />}
														>
															<polygon class="node-shape" points={`${cx()},${b()!.y} ${b()!.x + b()!.width},${cy()} ${cx()},${b()!.y + b()!.height} ${b()!.x},${cy()}`} />
														</Show>
														{/* Start/End subtle left kind icon (clear of shifted text) */}
														<Show when={n()!.kind === "start" || n()!.kind === "end"}>
															<text class="node-kind-icon" x={b()!.x + 12} y={cy() + 4.5}>
																{n()!.kind === "start" ? ICON.play : ICON["pass-filled"]}
															</text>
														</Show>
														{/* Node label lines */}
														<For each={b()!.lines}>
															{(words, i) => (
																<text class="node-text" x={textX()} y={cy() + (i() - (b()!.lines.length - 1) / 2) * LINE + 4} text-anchor="middle">
																	{words}
																</text>
															)}
														</For>
														{/* Five-state code indicator dot (stoplight + grey + blue, consistent across steps and decisions) */}
														<Show when={showCodeDot()}>
															<rect
																class={`plan-code-dot ${codeState()}${hasBuilt() ? " plan-built" : ""}`}
																x={builtPos().x}
																y={builtPos().y}
																width="6"
																height="6"
																rx="2"
															/>
														</Show>
														{/* Notes indicator icon when node carries analyst notes (consistent across steps and decisions) */}
														<Show when={hasNotes()}>
															<text class="node-note-icon" x={notePos().x} y={notePos().y} text-anchor={notePos().anchor}>
																{ICON.note}
															</text>
														</Show>
														{/* Linked workspace documents badge pill */}
														<Show when={!far() && linkedDocs().length > 0}>
															<g
																class="plan-doc-badge"
																style={{ cursor: "pointer" }}
																onMouseDown={(e) => e.stopPropagation()}
																onClick={(e) => n() && void openLinkedDocsMenu(e, n()!)}
															>
																<title>{`Linked docs (${linkedDocs().length}): ${linkedDocs().map((d) => d.label).join(", ")}. Click to open.`}</title>
																<rect
																	x={docBadgePos().x}
																	y={docBadgePos().y}
																	width={docBadgePos().w}
																	height="15"
																	rx="7.5"
																	style={{
																		fill: "var(--side-bg)",
																		stroke: "color-mix(in srgb, var(--accent) 55%, var(--border))",
																		"stroke-width": "1",
																	}}
																/>
																<text
																	x={docBadgePos().x + 5.5}
																	y={docBadgePos().y + 10.8}
																	style={{ font: "normal 9.5px/1 codicon", fill: "var(--accent)", "pointer-events": "none" }}
																>
																	{ICON.file}
																</text>
																<text
																	x={docBadgePos().x + docBadgePos().w - 5}
																	y={docBadgePos().y + 10.8}
																	text-anchor="end"
																	style={{ font: "600 9.5px var(--ui-font)", fill: "var(--accent)", "pointer-events": "none" }}
																>
																	{linkedDocs().length}
																</text>
															</g>
														</Show>
														{/* Build / drift status badge */}
														<Show when={mark()} keyed>
															{(kind) => (
																<g class={`plan-mark ${kind}`} transform={`translate(${b()!.x + corner().x},${b()!.y + corner().y})`}>
																	<circle r="7.5" />
																	<path d={MARK_PATHS[kind]} />
																</g>
															)}
														</Show>
														{/* Finding warning dot */}
														<Show when={trouble()}>
															<circle class="plan-dot" cx={b()!.x + b()!.width - corner().x} cy={b()!.y + corner().y} r="5" />
														</Show>

														{/* Hover '+' Quick-Add & Wire-Drag Ports */}
														<Show when={!far() && !n()!.pending && n()!.kind !== "end"}>
															<g
																class="plan-port"
																transform={`translate(${primaryPort().x},${primaryPort().y})`}
																onMouseDown={(e) => startPortDrag(e, nid, primaryPort(), "primary")}
																onClick={(e) => e.stopPropagation()}
															>
																<title>Click to add the next step; drag to another node to connect</title>
																<circle class="plan-port-hit" r="14" />
																<circle class="plan-port-bg" r="9.5" />
																<path class="plan-port-plus" d="M-4,0 L4,0 M0,-4 L0,4" />
															</g>
														</Show>
														<Show when={!far() && !n()!.pending && canBranch()}>
															<g
																class="plan-port"
																transform={`translate(${branchPort().x},${branchPort().y})`}
																onMouseDown={(e) => startPortDrag(e, nid, branchPort(), "branch")}
																onClick={(e) => e.stopPropagation()}
															>
																<title>Click to add a branch; drag to another node to connect</title>
																<circle class="plan-port-hit" r="14" />
																<circle class="plan-port-bg" r="9.5" />
																<path class="plan-port-plus" d="M-4,0 L4,0 M0,-4 L0,4" />
															</g>
														</Show>
													</g>
												</Show>
											);
										}}
									</For>

									{/* Magnetic center alignment guides shown while dragging a node */}
									<Show when={nodeDrag()?.moved && (nodeDrag()?.guideX !== undefined || nodeDrag()?.guideY !== undefined)}>
										<g class="plan-snap-guides" aria-hidden="true">
											<Show when={nodeDrag()?.guideX !== undefined}>
												<line class="plan-snap-guide" x1={nodeDrag()!.guideX!} y1={-400} x2={nodeDrag()!.guideX!} y2={(layout()?.height ?? 2000) + 400} />
											</Show>
											<Show when={nodeDrag()?.guideY !== undefined}>
												<line class="plan-snap-guide" x1={-400} y1={nodeDrag()!.guideY!} x2={(layout()?.width ?? 2000) + 400} y2={nodeDrag()!.guideY!} />
											</Show>
										</g>
									</Show>

									{/* Live rubber-band connector wire while dragging from any port */}
									<Show when={wireDrag()?.dragged}>
										<path
											class="plan-wire-preview"
											d={bezierWire(wireDrag()!.startCanvas, wireDrag()!.curCanvas, direction())}
											marker-end="url(#plan-arrow-on)"
										/>
									</Show>

									{/* Draggable orthogonal segment handles for the selected edge, layered above all wires and nodes so shared rails never occlude handles. */}
									<Show when={!far() && edge()}>
										{(() => {
											const activeLine = () => {
												const e = edge();
												return e ? layout()?.lines.find((x) => x.from === e.from && x.to === e.to && !x.pending && !x.removing) : undefined;
											};
											const activeHandles = () => {
												const line = activeLine();
												if (!line) return [];
												const d = routeDrag();
												const draggingThis = d && d.from === line.from && d.to === line.to ? d : null;
												const r = draggingThis ? { ...(line.route ?? {}), [draggingThis.key]: draggingThis.curDelta } : line.route;
												return edgeHandles(line.basePoints, line.points, r, line.shown ? [line.at, line.mid] : [line.mid]).map((h) => ({ line, h, active: draggingThis?.key === h.key }));
											};
											return (
												<g class="plan-edge-handles">
													<For each={activeHandles()}>
														{({ line, h, active }) => (
															<g
																class={`plan-seg-handle ${h.axis}`}
																classList={{ active }}
																transform={`translate(${h.x},${h.y})`}
																onMouseDown={(e) => startRouteDrag(e, line, h)}
																onClick={(e) => e.stopPropagation()}
																onDblClick={(e) => {
																	e.stopPropagation();
																	resetEdgeRoute({ from: line.from, to: line.to }, h.key);
																}}
															>
																<title>{h.axis === "h" ? "Drag up or down to move this wire segment (double-click to reset)" : "Drag left or right to move this wire segment (double-click to reset)"}</title>
																<circle class="plan-seg-hit" r="14" />
																<Show
																	when={h.axis === "h"}
																	fallback={
																		<>
																			<rect class="plan-seg-pill" x="-4.5" y="-11" width="9" height="22" rx="4.5" />
																			<line class="plan-seg-grip" x1="-1.5" y1="-5" x2="-1.5" y2="5" />
																			<line class="plan-seg-grip" x1="1.5" y1="-5" x2="1.5" y2="5" />
																		</>
																	}
																>
																	<rect class="plan-seg-pill" x="-11" y="-4.5" width="22" height="9" rx="4.5" />
																	<line class="plan-seg-grip" x1="-5" y1="-1.5" x2="5" y2="-1.5" />
																	<line class="plan-seg-grip" x1="-5" y1="1.5" x2="5" y2="1.5" />
																</Show>
															</g>
														)}
													</For>
												</g>
											);
										})()}
									</Show>

									{/* Zoomed-out overview stage labels */}
									<Show when={far()}>
										<g class="g-far" aria-hidden="true">
											<For each={farNames()}>
												{(name) => (
													<text
														classList={{ folder: !name.item.stage }}
														x={name.x + name.width / 2}
														y={name.y + name.size * 0.95}
														text-anchor="middle"
														style={{ "font-size": `${name.size}px`, "stroke-width": `${name.size * 0.28}px` }}
													>
														{name.item.words}
													</text>
												)}
											</For>
										</g>
									</Show>
								</g>
							</Show>
						</svg>

						{/* Floating contextual action toolbar above the selected node or edge. */}
						<Show when={floatBarPos()} keyed>
							{(bar) => (
								<div
									class="plan-float-bar"
									style={{ left: `${bar.left}px`, top: `${bar.top}px` }}
									onMouseDown={(e) => e.stopPropagation()}
									onClick={(e) => e.stopPropagation()}
								>
									<Show
										when={bar.kind === "node"}
										fallback={
											(() => {
												const eb = bar as Extract<NonNullable<ReturnType<typeof floatBarPos>>, { kind: "edge" }>;
												return (
													<>
														<button type="button" title="Edit connection label (F2)" onClick={() => setEditing({ from: eb.edge.from, to: eb.edge.to })}>
															<Icon name="note" />
															<span>Label</span>
														</button>
														<button type="button" title="Insert a step on this wire" onClick={() => insertBetween(eb.edge.from, eb.edge.to)}>
															<Icon name="add" />
															<span>Insert step</span>
														</button>
														<button type="button" title="Reverse connection direction" onClick={() => reverseSelectedEdge({ from: eb.edge.from, to: eb.edge.to })}>
															<Icon name="refresh" />
														</button>
														<Show when={eb.edge.route && Object.keys(eb.edge.route).length > 0}>
															<button type="button" title="Reset manual wire route (R)" onClick={() => resetEdgeRoute({ from: eb.edge.from, to: eb.edge.to })}>
																<Icon name="discard" />
																<span>Reset</span>
															</button>
														</Show>
														<span class="plan-float-sep" />
														<button type="button" class="danger" title="Delete connection (Del)" onClick={remove}>
															<Icon name="trash" />
														</button>
													</>
												);
											})()
										}
									>
										{(() => {
											const n = (bar as Extract<NonNullable<ReturnType<typeof floatBarPos>>, { kind: "node" }>).node;
											const canBranch = n.kind === "step" || n.kind === "call" || n.kind === "decision";
											const canDup = n.kind !== "start" && n.kind !== "end";
											const hasCode = linksOf(n.id).length > 0 || Boolean(n.ref?.trim());
											return (
												<>
													<Show when={n.kind !== "end"}>
														<button type="button" title="Add next step (Enter)" onClick={() => addNextFrom(n.id, "step")}>
															<Icon name="add" />
															<span>Step</span>
														</button>
													</Show>
													<Show when={canBranch}>
														<button type="button" title="Add branch (B)" onClick={() => addBranchFrom(n.id)}>
															<Icon name="git-branch" />
															<span>Branch</span>
														</button>
														<button
															type="button"
															classList={{ on: n.kind === "decision" }}
															title="Toggle Step / Decision (D)"
															onClick={() => toggleDecision(n.id)}
														>
															<span>{n.kind === "decision" ? "To Step" : "Decision"}</span>
														</button>
													</Show>
													<Show when={n.kind !== "end"}>
														<button
															type="button"
															classList={{ on: linking() === n.id }}
															title="Connect to another node (C)"
															onClick={() => (linking() ? setLinking(null) : beginLink(n.id))}
														>
															<Icon name="symbol-event" />
														</button>
													</Show>
													<Show when={canDup}>
														<button type="button" title="Duplicate step" onClick={() => duplicateById(n.id)}>
															<Icon name="layers" />
														</button>
													</Show>
													<Show when={offsetFor(n.offset, direction()).x !== 0 || offsetFor(n.offset, direction()).y !== 0}>
														<button type="button" title="Reset node position (R)" onClick={() => resetNodePos(n.id)}>
															<Icon name="discard" />
															<span>Reset</span>
														</button>
													</Show>
													<Show when={hasCode}>
														<button type="button" title="Inspect linked code (G)" onClick={() => openCode(n.id)}>
															<Icon name="go-to-file" />
														</button>
													</Show>
													<span class="plan-float-sep" />
													<button type="button" class="danger" title="Delete step (Del)" onClick={remove}>
														<Icon name="trash" />
													</button>
												</>
											);
										})()}
									</Show>
								</div>
							)}
						</Show>

						{/* Floating bottom-left zoom, fit, and keyboard shortcuts pill. */}
						<div class="plan-float-controls" role="group" aria-label="Canvas controls" onMouseDown={(e) => e.stopPropagation()}>
							<button type="button" title="Zoom out (−)" aria-label="Zoom out" onClick={(e) => (zoomBy(1 / 1.2), after(e))}>
								<Icon name="remove" />
							</button>
							<button
								type="button"
								title="Reset zoom to 100%"
								aria-label={`Zoom ${Math.round(view().scale * 100)}%. Reset to 100%`}
								onClick={(e) => (zoomBy(1 / view().scale), after(e))}
							>
								{Math.round(view().scale * 100)}%
							</button>
							<button type="button" title="Zoom in (+)" aria-label="Zoom in" onClick={(e) => (zoomBy(1.2), after(e))}>
								<Icon name="add" />
							</button>
							<span class="plan-float-sep" />
							<button type="button" title="Fit legible chart; click again for full overview (0)" onClick={(e) => (fitOrWhole(), after(e))}>
								Fit
							</button>
							<button
								type="button"
								classList={{ on: keysOpen() }}
								aria-pressed={keysOpen()}
								title="Keyboard shortcuts & shape legend (?)"
								aria-label="Keyboard shortcuts and legend"
								onClick={() => setKeysOpen((open) => !open)}
							>
								<Icon name="info" />
							</button>
						</div>

						<Show when={layout()}>
							<Minimap
								content={layout() ?? { width: 0, height: 0 }}
								boxes={(layout()?.boxes ?? []).map(
									(b): MapBox => ({
										x: b.x,
										y: b.y,
										width: b.width,
										height: b.height,
										kind: b.group ? "frame" : b.node?.id === selected() ? "mark" : "node",
									}),
								)}
								view={view()}
								host={() => canvas}
								onMove={setView}
							/>
						</Show>

						<Show when={editBox()} keyed>
							{(box) => (
								<input
									class="plan-edit"
									aria-label={editing() && "node" in editing()! ? "The node's words" : "The label of this way out"}
									style={{ left: `${box.left}px`, top: `${box.top}px`, width: `${box.width}px` }}
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
								Click the target node or navigate with arrows and press Enter. Press Esc to cancel.
							</div>
						</Show>

						<Show when={!linking() && activePathInfo()} keyed>
							{(info) => (
								<div class="plan-path-bar" role="status" aria-label="Highlighted test journey">
									<Icon name="beaker" class="plan-path-bar-icon" />
									<span class="plan-path-bar-num">
										Journey #{info.index + 1} of {info.total}
									</span>
									<span class="plan-path-bar-summary" title={info.summary}>
										{info.summary}
									</span>
									<span class="plan-float-sep" aria-hidden="true" />
									<button type="button" title="Previous test path" aria-label="Previous test path" onClick={() => stepActivePath(-1)}>
										<Icon name="chevron-left" />
									</button>
									<button type="button" title="Next test path" aria-label="Next test path" onClick={() => stepActivePath(1)}>
										<Icon name="chevron-right" />
									</button>
									<button type="button" title="Clear test path highlight" aria-label="Clear test path highlight" onClick={() => setActivePathIndex(null)}>
										<Icon name="close" />
									</button>
								</div>
							)}
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
								<p class="hint">Hover any node or wire for quick '+' add and drag-to-connect ports; plan details and Assistant live in Palette.</p>
								<h4>Shapes and lines</h4>
								<ul class="plan-shapes">
									<li>
										<svg viewBox="0 0 34 18" aria-hidden="true">
											<g class="plan-node start">
												<rect class="node-shape" x="1" y="2" width="32" height="14" rx="7" />
											</g>
										</svg>
										Where it starts, and where it ends
									</li>
									<li>
										<svg viewBox="0 0 34 18" aria-hidden="true">
											<g class="plan-node step">
												<rect class="node-shape" x="1" y="2" width="32" height="14" rx="4" />
											</g>
										</svg>
										A process step
									</li>
									<li>
										<svg viewBox="0 0 34 18" aria-hidden="true">
											<g class="plan-node decision">
												<polygon class="node-shape" points="17,1 33,9 17,17 1,9" />
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
										A loop returning to an earlier step
									</li>
									<li>
										<svg viewBox="0 0 34 18" aria-hidden="true">
											<rect class="plan-code-dot grey" x="2" y="6" width="5.5" height="5.5" rx="1.8" />
											<rect class="plan-code-dot blue" x="8.5" y="6" width="5.5" height="5.5" rx="1.8" />
											<rect class="plan-code-dot green" x="15" y="6" width="5.5" height="5.5" rx="1.8" />
											<rect class="plan-code-dot yellow" x="21.5" y="6" width="5.5" height="5.5" rx="1.8" />
											<rect class="plan-code-dot red" x="28" y="6" width="5.5" height="5.5" rx="1.8" />
										</svg>
										Code status: grey not built, blue building, green built, yellow changed, red error
									</li>
								</ul>
							</div>
						</Show>
					</div>
					</Show>
				</div>
				<p class="plan-live" role="status" aria-live="polite">
					{announcement()}
				</p>
			</Show>
		</div>
	);
}
