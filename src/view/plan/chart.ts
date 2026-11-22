// The chart's own arithmetic, kept apart from the view so it can be tested
// without a window: how a node's words wrap and how large its shape must be,
// which edges are loops, what ELK is asked to lay out, where an edge meets a
// decision's diamond and carries its label, which way out comes next, and what
// a node or an edge is called when it is announced. Nothing here reads SSL.
import type { Measure, Point, Rect, Size } from "../graph/canvas";
import type { NodeKind, Plan, PlanEdge, PlanGroup, PlanNode, PlanOffset, RouteOffsets } from "./model";

// --- words in a shape ------------------------------------------------------------

/** A line of a node's words, in the chart's own units. */
export const LINE = 17;
export const NO_WORDS = "(no words yet)";

/** Each shape's smallest width, what of that its outline takes from the words, and the height it adds to them. */
const SHAPES: Record<NodeKind, { width: number; inset: number; pad: number }> = {
	// The rounded ends + kind icon of a start or end, and a call's two bars, take room from the words.
	start: { width: 170, inset: 52, pad: 18 },
	end: { width: 170, inset: 52, pad: 18 },
	step: { width: 190, inset: 24, pad: 20 },
	call: { width: 190, inset: 44, pad: 20 },
	decision: { width: 230, inset: 100, pad: 54 },
};

/** Where a word too long for its line may break: after a dot, a slash, an underscore or a hyphen, never inside a name. */
const pieces = (word: string) => word.match(/[^._/\\-]+[._/\\-]*|[._/\\-]+/g) ?? [word];

/**
 * Wraps words to a measured width. A word is never broken inside: one too long
 * for a line breaks only after its own punctuation ("DueDates.DueRule." then
 * "DueDate"), and what is still too long keeps its line, for the shape to grow to.
 */
export function wrapText(text: string, max: number, measure: Measure): string[] {
	const lines: string[] = [];
	let line = "";
	const add = (piece: string, glued: boolean) => {
		const joined = line ? `${line}${glued ? "" : " "}${piece}` : piece;
		if (line && measure(joined) > max) {
			lines.push(line);
			line = piece;
		} else line = joined;
	};
	for (const word of (text.trim() || NO_WORDS).split(/\s+/)) {
		if (measure(word) <= max) add(word, false);
		else pieces(word).forEach((piece, i) => add(piece, i > 0));
	}
	lines.push(line);
	return lines;
}

export type Sized = Size & { lines: string[] };

/** A node's words wrapped for its shape, and the shape sized so that none of them spills out. */
export function sizeNode(kind: NodeKind, text: string, measure: Measure): Sized {
	const shape = SHAPES[kind];
	const lines = wrapText(text, shape.width - shape.inset, measure);
	const widest = Math.max(...lines.map(measure));
	const words = lines.length * LINE;
	if (kind !== "decision") return { lines, width: Math.max(shape.width, Math.ceil(widest + shape.inset)), height: words + shape.pad };
	// A block of words w by h fits a diamond W by H when w/W + h/H is at most 1.
	const height = words + shape.pad + (lines.length - 1) * 10;
	return { lines, width: Math.max(shape.width, Math.ceil((widest + 16) / (1 - words / height))), height };
}

// --- loops ---------------------------------------------------------------------------

/**
 * The edges that close a loop, by their place in `edges`: those a depth-first
 * walk from the start finds leading back to a node it is still inside. A chart
 * laid out with these taken as running the other way puts a loop's decision
 * above the steps it repeats. Nodes nothing leads to are walked afterwards, in
 * the plan's order. An edge to a node the plan does not have is left out.
 */
export function backEdges(nodes: readonly Pick<PlanNode, "id" | "kind">[], edges: readonly Pick<PlanEdge, "from" | "to">[]): Set<number> {
	const out = new Map<string, number[]>(nodes.map((n) => [n.id, []]));
	edges.forEach((e, i) => out.has(e.to) && out.get(e.from)?.push(i));
	const state = new Map<string, "open" | "done">();
	const back = new Set<number>();
	for (const root of [...nodes.filter((n) => n.kind === "start"), ...nodes]) {
		if (state.has(root.id)) continue;
		state.set(root.id, "open");
		const stack = [{ id: root.id, next: 0 }];
		while (stack.length) {
			const top = stack[stack.length - 1]!;
			const index = out.get(top.id)![top.next++];
			if (index === undefined) {
				state.set(top.id, "done");
				stack.pop();
				continue;
			}
			const to = edges[index]!.to;
			const seen = state.get(to);
			if (seen === "open") back.add(index);
			else if (!seen) {
				state.set(to, "open");
				stack.push({ id: to, next: 0 });
			}
		}
	}
	return back;
}

// --- what ELK is asked ----------------------------------------------------------------

type Side = "NORTH" | "SOUTH" | "EAST" | "WEST";
export type LayoutDirection = "DOWN" | "RIGHT";
/** The points of a decision its ways out leave by, in order: primary flow, then each branch side. */
const TIPS_BY_DIR: Record<LayoutDirection, readonly Side[]> = {
	DOWN: ["SOUTH", "EAST", "WEST"],
	RIGHT: ["EAST", "SOUTH", "NORTH"],
};
const IN_SIDE: Record<LayoutDirection, Side> = { DOWN: "NORTH", RIGHT: "WEST" };
const OUT_SIDE: Record<LayoutDirection, Side> = { DOWN: "SOUTH", RIGHT: "EAST" };
/** The room between steps side by side, passing wires and nodes, rows, and after branch turns into a step. */
const SPACING = {
	"elk.spacing.nodeNode": "38",
	"elk.spacing.edgeNode": "24",
	"elk.layered.spacing.nodeNodeBetweenLayers": "52",
	"elk.layered.spacing.edgeNodeBetweenLayers": "36",
};
/** Global minimum clearance from a region border to every node, contained line, and label inside it. */
export const REGION_PADDING = { top: 46, right: 22, bottom: 22, left: 22 } as const;
type ElkNode = { id: string; width?: number; height?: number; layoutOptions?: Record<string, string>; children?: ElkNode[]; ports?: ElkNode[] };
export type ElkInput = ElkNode & { edges: { id: string; sources: string[]; targets: string[] }[] };
export type ChartGraph = {
	graph: ElkInput;
	/** The nodes, edges and groups drawn: a second node with an id already used, an edge to nothing and an empty group are not. */
	nodes: PlanNode[];
	edges: PlanEdge[];
	groups: PlanGroup[];
	/** Edges given to ELK the other way round, by their place in `edges`: its route for one runs from the edge's end to its start. */
	reversed: Set<number>;
	/** A way that closes a loop leaves a decision by the side asked for: the other side is another chart, worth trying. */
	sided: boolean;
	/** A loop's way back arrives at a decision, at its top or its side as asked: again another chart worth trying. */
	returning: boolean;
};

/**
 * The plan as a graph for ELK's layered layout, top to bottom. A loop's closing
 * edge is given reversed, so it cannot decide the layers, and tied to the top of
 * the node it returns to and the bottom of the node it leaves: drawn, it goes
 * down, round and back in at the top, as a loop does on paper. A decision's
 * ways meet it at its points: in at the top, on at the bottom, the others out
 * of its sides; `loopTip` is the side a way that closes a loop leaves by, and
 * `returnsAt` where a loop's way back arrives: the top, or the left point,
 * where every way back then runs up the one side.
 */
export function chartGraph(
	plan: Plan,
	sizes: ReadonlyMap<string, Size>,
	loopTip: "EAST" | "WEST" = "EAST",
	returnsAt: "NORTH" | "WEST" = "NORTH",
	direction: LayoutDirection = "DOWN",
): ChartGraph {
	const ids = new Set<string>();
	const nodes = plan.nodes.filter((n) => !ids.has(n.id) && ids.add(n.id));
	const edges = plan.edges.filter((e) => ids.has(e.from) && ids.has(e.to));
	const groups = plan.groups.filter((g) => nodes.some((n) => n.group === g.id));
	const known = new Set(groups.map((g) => g.id));
	const reversed = new Set([...backEdges(nodes, edges)].filter((i) => edges[i]!.from !== edges[i]!.to));
	const primaryIn = IN_SIDE[direction];
	const primaryOut = OUT_SIDE[direction];
	const tips = TIPS_BY_DIR[direction];
	// Map loop side hints cleanly when rotated to horizontal flow.
	const mapSide = (s: "EAST" | "WEST" | "NORTH"): Side =>
		direction === "DOWN" ? s : s === "EAST" ? "SOUTH" : s === "WEST" ? "NORTH" : "WEST";
	const loopSide = mapSide(loopTip);
	const returnSide = mapSide(returnsAt);
	const altReturnSide = mapSide("WEST");
	// A name for ports that no node or group can already have.
	let stem = "port";
	while ([...ids, ...known].some((id) => id.startsWith(`${stem}:`))) stem += "_";
	const ports = new Map<string, ElkNode[]>();
	const port = (node: string, id: string, side: Side) => {
		if (!ports.get(node)?.some((p) => p.id === id)) ports.set(node, [...(ports.get(node) ?? []), { id, width: 0, height: 0, layoutOptions: { "elk.port.side": side } }]);
		return id;
	};
	// A decision is a diamond, and its ways in and out meet it at its points, as on paper: in at
	// the primary entry, the first way out at the primary exit, the others out of its sides.
	const decisions = new Set(nodes.filter((n) => n.kind === "decision").map((n) => n.id));
	const wayOut = new Map<number, Side>();
	let sided = false;
	let returning = false;
	for (const id of decisions) {
		const outs = edges.map((e, i) => ({ e, i })).filter(({ e }) => e.from === id && e.to !== id);
		const [on, back] = [outs.filter(({ i }) => !reversed.has(i)), outs.filter(({ i }) => reversed.has(i))];
		const free = [...tips];
		const take = (side: Side | undefined) => (side && free.includes(side) ? free.splice(free.indexOf(side), 1)[0]! : (free.shift() ?? primaryOut));
		// The way that closes a loop takes the side asked for while it is free; which side is shorter depends on the layout.
		const loops = new Map(back.map(({ i }, at) => [i, at === 0 && on.length <= 1 ? loopSide : undefined] as const));
		if (on.length) wayOut.set(on[0]!.i, take(primaryOut));
		for (const { i } of back) if (loops.get(i)) (sided = true), wayOut.set(i, take(loops.get(i)));
		for (const { i } of [...on.slice(1), ...back]) if (!wayOut.has(i)) wayOut.set(i, take(undefined));
	}
	const leaves = (e: PlanEdge, i: number) => (decisions.has(e.from) ? port(e.from, `${stem}:${i}:out`, wayOut.get(i) ?? primaryOut) : null);
	const arrives = (e: PlanEdge) => (decisions.has(e.to) ? port(e.to, `${stem}:${e.to}:in`, primaryIn) : null);
	// A loop's way back may come in at the decision's side instead, where no way out has taken it:
	// then every way back runs up that side, and the way out of the other side crosses none of them.
	const sideTaken = new Set(edges.map((e, i) => (wayOut.get(i) === altReturnSide ? e.from : "")));
	const returns = (e: PlanEdge) => {
		if (!decisions.has(e.to)) return null;
		if (!sideTaken.has(e.to)) returning = true;
		return returnSide === altReturnSide && !sideTaken.has(e.to) ? port(e.to, `${stem}:${e.to}:back`, altReturnSide) : arrives(e);
	};
	const elkEdges = edges.map((e, i) =>
		reversed.has(i)
			? { id: `e${i}`, sources: [returns(e) ?? port(e.to, `${stem}:${i}:in`, primaryIn)], targets: [leaves(e, i) ?? port(e.from, `${stem}:${i}:out`, primaryOut)] }
			: { id: `e${i}`, sources: [leaves(e, i) ?? e.from], targets: [arrives(e) ?? e.to] },
	);
	const leaf = (n: PlanNode): ElkNode => {
		const size = sizes.get(n.id) ?? { width: SHAPES[n.kind].width, height: LINE + SHAPES[n.kind].pad };
		const own = ports.get(n.id);
		return { id: n.id, width: size.width, height: size.height, ...(own ? { ports: own, layoutOptions: { "elk.portConstraints": "FIXED_SIDE" } } : {}) };
	};
	return {
		nodes,
		edges,
		groups,
		reversed,
		sided,
		returning,
		graph: {
			id: "root",
			layoutOptions: {
				"elk.algorithm": "layered",
				"elk.direction": direction,
				"elk.hierarchyHandling": "INCLUDE_CHILDREN",
				"elk.edgeRouting": "ORTHOGONAL",
				// More tries at the order within each row: a chart is small, and each crossing saved is one less to read past.
				"elk.layered.thoroughness": "40",
				// Pull independent branches and stages tighter along the flow axis so parallel stages don't drift apart.
				"elk.layered.compaction.postCompaction.strategy": "EDGE_LENGTH",
				...SPACING,
				"elk.json.edgeCoords": "ROOT",
			},
			children: [
				...nodes.filter((n) => !n.group || !known.has(n.group)).map(leaf),
				...groups.map((g) => ({
					id: g.id,
					// ELK reads the spacing from the box the nodes are in: without it a group's steps stand closer than the rest.
					layoutOptions: {
						"elk.padding": `[top=${REGION_PADDING.top},left=${REGION_PADDING.left},bottom=${REGION_PADDING.bottom},right=${REGION_PADDING.right}]`,
						"elk.layered.compaction.postCompaction.strategy": "EDGE_LENGTH",
						...SPACING,
					},
					children: nodes.filter((n) => n.group === g.id).map(leaf),
				})),
			],
			edges: elkEdges,
		},
	};
}

// --- an edge as drawn -------------------------------------------------------------------

/**
 * ELK ends an edge on a node's bounding box. A decision is a diamond inside its
 * box, so the edge would stop short of it: this carries the end on, straight, to
 * the diamond's outline.
 */
export function onDiamond(point: Point, box: Rect, slack = 1.5): Point {
	const cx = box.x + box.width / 2;
	const cy = box.y + box.height / 2;
	const near = (a: number, b: number) => Math.abs(a - b) <= slack;
	if (near(point.y, box.y) || near(point.y, box.y + box.height)) {
		const share = Math.max(0, 1 - Math.abs(point.x - cx) / (box.width / 2));
		return { x: point.x, y: cy + Math.sign(point.y - cy) * (box.height / 2) * share };
	}
	if (near(point.x, box.x) || near(point.x, box.x + box.width)) {
		const share = Math.max(0, 1 - Math.abs(point.y - cy) / (box.height / 2));
		return { x: cx + Math.sign(point.x - cx) * (box.width / 2) * share, y: point.y };
	}
	return point;
}

/** Removes consecutive duplicates, redundant collinear vertices, and 180° orthogonal backtracks emitted by ELK at shared merge ports. */
function simplifyOrthogonal(points: readonly Point[]): Point[] {
	const pts = points.map((p) => ({ ...p }));
	let changed = true;
	while (changed && pts.length >= 2) {
		changed = false;
		// Strip consecutive duplicate vertices.
		for (let i = pts.length - 1; i > 0; i--) {
			if (Math.abs(pts[i]!.x - pts[i - 1]!.x) < 0.5 && Math.abs(pts[i]!.y - pts[i - 1]!.y) < 0.5) {
				pts.splice(i, 1);
				changed = true;
			}
		}
		// Strip middle vertices that lie on the exact same horizontal or vertical line as both neighbours (collinear or 180° hairpin backtrack).
		for (let i = 1; i < pts.length - 1; i++) {
			const a = pts[i - 1]!;
			const b = pts[i]!;
			const c = pts[i + 1]!;
			const sameY = Math.abs(a.y - b.y) < 0.5 && Math.abs(b.y - c.y) < 0.5;
			const sameX = Math.abs(a.x - b.x) < 0.5 && Math.abs(b.x - c.x) < 0.5;
			if (sameY || sameX) {
				pts.splice(i, 1);
				changed = true;
				break;
			}
		}
	}
	return pts;
}

/** An edge's points from its start to its end, whichever way ELK was given it, meeting a decision at its outline. */
export function routeOf(points: readonly Point[], isReversed: boolean, from: Rect | undefined, to: Rect | undefined): Point[] {
	const route = isReversed ? [...points].reverse() : [...points];
	if (route.length < 2) return route;
	if (from) route[0] = onDiamond(route[0]!, from);
	if (to) route[route.length - 1] = onDiamond(route[route.length - 1]!, to);
	return simplifyOrthogonal(route);
}

/**
 * How many times the routes cross one another: two stretches of different
 * routes that pass through each other. Meeting at an end, as two ways into one
 * step do, is not a crossing. A chart with fewer is easier to follow.
 */
export function crossings(routes: readonly (readonly Point[])[]): number {
	const turn = (a: Point, b: Point, c: Point) => Math.sign((b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x));
	const cross = (a: Point, b: Point, c: Point, d: Point) => turn(a, b, c) * turn(a, b, d) < 0 && turn(c, d, a) * turn(c, d, b) < 0;
	let count = 0;
	for (let i = 0; i < routes.length; i++)
		for (let j = i + 1; j < routes.length; j++)
			for (let p = 1; p < routes[i]!.length; p++) for (let q = 1; q < routes[j]!.length; q++) if (cross(routes[i]![p - 1]!, routes[i]![p]!, routes[j]![q - 1]!, routes[j]![q]!)) count++;
	return count;
}

/** How far the routes run in all: of two charts with as many crossings, the one with less line is the plainer. */
export function routeLength(routes: readonly (readonly Point[])[]): number {
	let length = 0;
	for (const route of routes) for (let i = 1; i < route.length; i++) length += Math.abs(route[i]!.x - route[i - 1]!.x) + Math.abs(route[i]!.y - route[i - 1]!.y);
	return length;
}

/**
 * Where an edge's label sits: on the first stretch from its start that has room
 * for it, so a branch's label stays by its decision, or failing that in the
 * middle of the longest stretch.
 */
export function labelPoint(points: readonly Point[], labelWidth = 0): Point {
	let longest = { x: points[0]?.x ?? 0, y: points[0]?.y ?? 0 };
	let length = -1;
	for (let i = 1; i < points.length; i++) {
		const [a, b] = [points[i - 1]!, points[i]!];
		const middle = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
		const across = Math.abs(a.x - b.x);
		const down = Math.abs(a.y - b.y);
		if (across >= labelWidth + 16 || down >= 36) return middle;
		if (across + down > length) (length = across + down), (longest = middle);
	}
	return longest;
}

export type LabelObstacle = Rect & { shape: "rect" | "diamond" };

function hitsObstacle(cx: number, cy: number, width: number, height: number, ob: LabelObstacle, pad: number): boolean {
	const x1 = cx - width / 2;
	const x2 = cx + width / 2;
	const y1 = cy - height / 2;
	const y2 = cy + height / 2;
	if (x2 < ob.x - pad || x1 > ob.x + ob.width + pad || y2 < ob.y - pad || y1 > ob.y + ob.height + pad) return false;
	if (ob.shape === "rect") return true;
	const dcx = ob.x + ob.width / 2;
	const dcy = ob.y + ob.height / 2;
	const rx = ob.width / 2 + pad;
	const ry = ob.height / 2 + pad;
	const nx = Math.max(x1, Math.min(dcx, x2));
	const ny = Math.max(y1, Math.min(dcy, y2));
	return Math.abs(nx - dcx) / rx + Math.abs(ny - dcy) / ry <= 1;
}

function pointAtDistance(points: readonly Point[], dist: number): Point {
	let rem = dist;
	for (let i = 1; i < points.length; i++) {
		const a = points[i - 1]!;
		const b = points[i]!;
		const len = Math.hypot(b.x - a.x, b.y - a.y);
		if (rem <= len || i === points.length - 1) {
			const t = len > 0 ? Math.max(0, Math.min(1, rem / len)) : 0;
			return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t };
		}
		rem -= len;
	}
	return points[0] ?? { x: 0, y: 0 };
}

/**
 * Places an edge's label pill near the node the edge leaves and clear of every
 * node shape (using exact diamond geometry for decisions), stage header pill,
 * and previously placed label. On long return or bypass runs past other nodes,
 * anchors the label close to the branch's exit corner so it is never confused
 * with an unrelated decision further along the wire.
 */
export function placeEdgeLabel(
	points: readonly Point[],
	labelWidth: number,
	obstacles: readonly LabelObstacle[],
	placed: readonly Rect[] = [],
	labelHeight = 21,
): Point {
	if (points.length < 2) return points[0] ?? { x: 0, y: 0 };
	const clear = (p: Point, pad = 6) =>
		!obstacles.some((ob) => hitsObstacle(p.x, p.y, labelWidth, labelHeight, ob, pad)) &&
		!placed.some((r) => hitsObstacle(p.x, p.y, labelWidth, labelHeight, { ...r, shape: "rect" }, 4));

	// Preferred anchor: first stretch with room for the pill. If it follows an exit stub
	// (segIndex >= 1) and is long (> 110px), stay ~36px from its start corner by the source decision.
	let preferred = labelPoint(points, labelWidth);
	for (let i = 1; i < points.length; i++) {
		const a = points[i - 1]!;
		const b = points[i]!;
		const across = Math.abs(a.x - b.x);
		const down = Math.abs(a.y - b.y);
		if (across >= labelWidth + 16 || down >= 36) {
			const len = Math.hypot(b.x - a.x, b.y - a.y);
			if (i >= 2 && len > 110) {
				const d = Math.min(len / 2, 38);
				preferred = { x: a.x + ((b.x - a.x) / len) * d, y: a.y + ((b.y - a.y) / len) * d };
			} else {
				preferred = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
			}
			break;
		}
	}
	if (clear(preferred, 6)) return preferred;

	// Scan along the polyline from the source end to find the closest collision-free spot.
	let total = 0;
	for (let i = 1; i < points.length; i++) total += Math.hypot(points[i]!.x - points[i - 1]!.x, points[i]!.y - points[i - 1]!.y);
	for (const pad of [6, 2]) {
		for (let dist = 22; dist <= total - 16; dist += 14) {
			const pt = pointAtDistance(points, dist);
			if (clear(pt, pad)) return pt;
		}
	}
	return preferred;
}

/** Exact geometric midpoint along a routed edge polyline (for hover '+' insert buttons). */
export function edgeMidpoint(points: readonly Point[]): Point {
	if (!points.length) return { x: 0, y: 0 };
	if (points.length === 1) return points[0]!;
	const lengths: number[] = [];
	let total = 0;
	for (let i = 1; i < points.length; i++) {
		const d = Math.hypot(points[i]!.x - points[i - 1]!.x, points[i]!.y - points[i - 1]!.y);
		lengths.push(d);
		total += d;
	}
	if (total <= 0) return points[0]!;
	let rem = total / 2;
	for (let i = 0; i < lengths.length; i++) {
		if (rem <= lengths[i]!) {
			const t = lengths[i]! > 0 ? rem / lengths[i]! : 0;
			const a = points[i]!;
			const b = points[i + 1]!;
			return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t };
		}
		rem -= lengths[i]!;
	}
	return points[points.length - 1]!;
}

/**
 * Pulls back oversized orthogonal U-turns that ELK routes past a tall sibling
 * stage in the same layer (for example, a loop below short steps sitting beside
 * a tall multi-step stage). Keeps clear of every obstacle box and preserves
 * shared return buses for sibling loops going back to the same target.
 */
export function compactRoutes(
	routes: readonly { to: string; points: readonly Point[] }[],
	obstacles: readonly Rect[],
	margin = 36,
): Point[][] {
	const out = routes.map((r) => r.points.map((p) => ({ ...p })));
	type Candidate = { routeIndex: number; segIndex: number; axis: "h" | "v"; side: "high" | "low"; orig: number; target: number; busKey: string };
	const candidates: Candidate[] = [];
	const pad = 8;

	for (let ri = 0; ri < out.length; ri++) {
		const pts = out[ri]!;
		if (pts.length < 4) continue;
		const to = routes[ri]!.to;
		for (let i = 1; i <= pts.length - 3; i++) {
			const prev = pts[i - 1]!;
			const a = pts[i]!;
			const b = pts[i + 1]!;
			const next = pts[i + 2]!;
			if (Math.abs(a.y - b.y) < 1) {
				const y = a.y;
				const x1 = Math.min(a.x, b.x);
				const x2 = Math.max(a.x, b.x);
				if (prev.y < y - 1 && next.y < y - 1) {
					let target = Math.max(prev.y, next.y) + margin;
					for (const box of obstacles) {
						if (box.y + box.height > y + 1) continue;
						if (box.x + box.width <= x1 - pad || box.x >= x2 + pad) continue;
						target = Math.max(target, box.y + box.height + margin);
					}
					if (target < y - 4) {
						candidates.push({ routeIndex: ri, segIndex: i, axis: "h", side: "high", orig: y, target, busKey: `${to}:h:high:${Math.round(y / 2)}` });
					}
				} else if (prev.y > y + 1 && next.y > y + 1) {
					let target = Math.min(prev.y, next.y) - margin;
					for (const box of obstacles) {
						if (box.y < y - 1) continue;
						if (box.x + box.width <= x1 - pad || box.x >= x2 + pad) continue;
						target = Math.min(target, box.y - margin);
					}
					if (target > y + 4) {
						candidates.push({ routeIndex: ri, segIndex: i, axis: "h", side: "low", orig: y, target, busKey: `${to}:h:low:${Math.round(y / 2)}` });
					}
				}
			} else if (Math.abs(a.x - b.x) < 1) {
				const x = a.x;
				const y1 = Math.min(a.y, b.y);
				const y2 = Math.max(a.y, b.y);
				if (prev.x < x - 1 && next.x < x - 1) {
					let target = Math.max(prev.x, next.x) + margin;
					for (const box of obstacles) {
						if (box.x + box.width > x + 1) continue;
						if (box.y + box.height <= y1 - pad || box.y >= y2 + pad) continue;
						target = Math.max(target, box.x + box.width + margin);
					}
					if (target < x - 4) {
						candidates.push({ routeIndex: ri, segIndex: i, axis: "v", side: "high", orig: x, target, busKey: `${to}:v:high:${Math.round(x / 2)}` });
					}
				} else if (prev.x > x + 1 && next.x > x + 1) {
					let target = Math.min(prev.x, next.x) - margin;
					for (const box of obstacles) {
						if (box.x < x - 1) continue;
						if (box.y + box.height <= y1 - pad || box.y >= y2 + pad) continue;
						target = Math.min(target, box.x - margin);
					}
					if (target > x + 4) {
						candidates.push({ routeIndex: ri, segIndex: i, axis: "v", side: "low", orig: x, target, busKey: `${to}:v:low:${Math.round(x / 2)}` });
					}
				}
			}
		}
	}

	// Keep sibling edges that shared one ELK return bus aligned onto one clean tightened bus.
	const grouped = new Map<string, Candidate[]>();
	for (const c of candidates) grouped.set(c.busKey, [...(grouped.get(c.busKey) ?? []), c]);
	for (const group of grouped.values()) {
		const side = group[0]!.side;
		const shared = side === "high" ? Math.max(...group.map((c) => c.target)) : Math.min(...group.map((c) => c.target));
		for (const c of group) {
			if (side === "high" ? shared >= c.orig - 4 : shared <= c.orig + 4) continue;
			const pts = out[c.routeIndex]!;
			if (c.axis === "h") {
				pts[c.segIndex]!.y = shared;
				pts[c.segIndex + 1]!.y = shared;
			} else {
				pts[c.segIndex]!.x = shared;
				pts[c.segIndex + 1]!.x = shared;
			}
		}
	}
	return out;
}

export type EdgeHandle = { key: string; axis: "h" | "v"; x: number; y: number; segIndex: number; kind: "slide" | "jog" };

/** Applies sparse per-segment manual offsets (`"1h"`, `"2v"`, etc.) to an orthogonal edge route. */
export function applyRouteOffsets(points: readonly Point[], route?: RouteOffsets): Point[] {
	if (!points.length || !route || !Object.keys(route).length) return points.map((p) => ({ ...p }));
	if (points.length >= 4) {
		const pts = points.map((p) => ({ ...p }));
		for (let i = 1; i <= pts.length - 3; i++) {
			const a = pts[i]!;
			const b = pts[i + 1]!;
			if (Math.abs(a.y - b.y) < 1) {
				const dy = route[`${i}h`];
				if (typeof dy === "number" && Number.isFinite(dy) && dy !== 0) {
					a.y += dy;
					b.y += dy;
				}
			} else if (Math.abs(a.x - b.x) < 1) {
				const dx = route[`${i}v`];
				if (typeof dx === "number" && Number.isFinite(dx) && dx !== 0) {
					a.x += dx;
					b.x += dx;
				}
			}
		}
		return pts;
	}
	// 2- or 3-point straight / L-shaped edge: bow the dragged segment into a crisp orthogonal jog while keeping ports fixed.
	const out: Point[] = [{ ...points[0]! }];
	for (let i = 0; i < points.length - 1; i++) {
		const a = points[i]!;
		const b = points[i + 1]!;
		if (Math.abs(a.y - b.y) < 1) {
			const len = Math.abs(b.x - a.x);
			const dy = route[`${i}h`];
			if (len >= 48 && typeof dy === "number" && Number.isFinite(dy) && Math.abs(dy) >= 4) {
				const inset = Math.min(len * 0.25, Math.max(16, len * 0.18));
				const dir = Math.sign(b.x - a.x);
				const xA = a.x + dir * inset;
				const xB = b.x - dir * inset;
				out.push({ x: xA, y: a.y }, { x: xA, y: a.y + dy }, { x: xB, y: a.y + dy }, { x: xB, y: b.y });
			}
		} else if (Math.abs(a.x - b.x) < 1) {
			const len = Math.abs(b.y - a.y);
			const dx = route[`${i}v`];
			if (len >= 48 && typeof dx === "number" && Number.isFinite(dx) && Math.abs(dx) >= 4) {
				const inset = Math.min(len * 0.25, Math.max(16, len * 0.18));
				const dir = Math.sign(b.y - a.y);
				const yA = a.y + dir * inset;
				const yB = b.y - dir * inset;
				out.push({ x: a.x, y: yA }, { x: a.x + dx, y: yA }, { x: a.x + dx, y: yB }, { x: b.x, y: yB });
			}
		}
		out.push({ ...b });
	}
	return out;
}

function pickClearPoint(a: Point, b: Point, avoid: readonly Point[]): Point {
	const ts = [0.5, 0.34, 0.66, 0.22, 0.78];
	let best = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
	let bestClear = -1;
	for (const t of ts) {
		const p = { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t };
		const clear = avoid.length ? Math.min(...avoid.map((q) => Math.hypot(p.x - q.x, p.y - q.y))) : 999;
		if (clear >= 28) return p;
		if (clear > bestClear) {
			bestClear = clear;
			best = p;
		}
	}
	return best;
}

/** Computes draggable segment handles for an orthogonal edge, clear of labels and insert ports. */
export function edgeHandles(
	basePoints: readonly Point[],
	finalPoints: readonly Point[],
	route?: RouteOffsets,
	avoid: readonly Point[] = [],
): EdgeHandle[] {
	const handles: EdgeHandle[] = [];
	if (basePoints.length >= 4 && finalPoints.length === basePoints.length) {
		for (let i = 1; i <= basePoints.length - 3; i++) {
			const ba = basePoints[i]!;
			const bb = basePoints[i + 1]!;
			const fa = finalPoints[i]!;
			const fb = finalPoints[i + 1]!;
			const isH = Math.abs(ba.y - bb.y) < 1;
			const isV = Math.abs(ba.x - bb.x) < 1;
			if (!isH && !isV) continue;
			if (Math.hypot(fb.x - fa.x, fb.y - fa.y) < 20) continue;
			const pt = pickClearPoint(fa, fb, avoid);
			const axis = isH ? "h" : "v";
			handles.push({ key: `${i}${axis}`, axis, x: pt.x, y: pt.y, segIndex: i, kind: "slide" });
		}
		return handles;
	}
	if (basePoints.length === 2 || basePoints.length === 3) {
		for (let i = 0; i < basePoints.length - 1; i++) {
			const a = basePoints[i]!;
			const b = basePoints[i + 1]!;
			const isH = Math.abs(a.y - b.y) < 1;
			const isV = Math.abs(a.x - b.x) < 1;
			if (!isH && !isV) continue;
			if (Math.hypot(b.x - a.x, b.y - a.y) < 48) continue;
			const axis = isH ? "h" : "v";
			const key = `${i}${axis}`;
			const delta = route?.[key] ?? 0;
			const shiftedA = isH ? { x: a.x, y: a.y + delta } : { x: a.x + delta, y: a.y };
			const shiftedB = isH ? { x: b.x, y: b.y + delta } : { x: b.x + delta, y: b.y };
			const pt = pickClearPoint(shiftedA, shiftedB, avoid);
			handles.push({ key, axis, x: pt.x, y: pt.y, segIndex: i, kind: "jog" });
		}
	}
	return handles;
}

/** Resolves a stored offset for the active layout direction (zero when stored for the opposite orientation). */
export function offsetFor(offset: PlanOffset | undefined, dir: LayoutDirection): Point {
	if (!offset || (offset.dir ?? "DOWN") !== dir) return { x: 0, y: 0 };
	return { x: offset.x, y: offset.y };
}

function boxAnchor(box: Rect, side: Side): Point {
	const cx = box.x + box.width / 2;
	const cy = box.y + box.height / 2;
	if (side === "NORTH") return { x: cx, y: box.y };
	if (side === "SOUTH") return { x: cx, y: box.y + box.height };
	if (side === "EAST") return { x: box.x + box.width, y: cy };
	return { x: box.x, y: cy };
}

/** Clean orthogonal connector between two moved node boxes (respecting diamond tip anchors and layout direction). */
export function orthogonalRoute(
	from: Rect,
	to: Rect,
	fromKind: NodeKind,
	toKind: NodeKind,
	dir: LayoutDirection,
	isBack: boolean,
): Point[] {
	const pad = 26;
	if (dir === "DOWN") {
		if (isBack) {
			const a = boxAnchor(from, fromKind === "decision" ? "WEST" : "SOUTH");
			const b = boxAnchor(to, toKind === "decision" ? "WEST" : "NORTH");
			const gutterX = Math.min(from.x, to.x) - pad;
			if (fromKind === "decision") {
				if (toKind === "decision") return [a, { x: gutterX, y: a.y }, { x: gutterX, y: b.y }, b];
				const topY = Math.min(from.y, to.y) - pad;
				return [a, { x: gutterX, y: a.y }, { x: gutterX, y: topY }, { x: b.x, y: topY }, b];
			}
			const botY = Math.max(from.y + from.height, to.y + to.height) + pad;
			if (toKind === "decision") return [a, { x: a.x, y: botY }, { x: gutterX, y: botY }, { x: gutterX, y: b.y }, b];
			const topY = Math.min(from.y, to.y) - pad;
			return [a, { x: a.x, y: botY }, { x: gutterX, y: botY }, { x: gutterX, y: topY }, { x: b.x, y: topY }, b];
		}
		if (fromKind === "decision" && to.x >= from.x + from.width + 8) {
			const a = boxAnchor(from, "EAST");
			if (to.y >= from.y + from.height * 0.35) {
				const b = boxAnchor(to, "NORTH");
				return [a, { x: b.x, y: a.y }, b];
			}
			const b = boxAnchor(to, "WEST");
			if (Math.abs(a.y - b.y) < 3) return [a, b];
			const midX = (a.x + b.x) / 2;
			return [a, { x: midX, y: a.y }, { x: midX, y: b.y }, b];
		}
		if (fromKind === "decision" && from.x >= to.x + to.width + 8) {
			const a = boxAnchor(from, "WEST");
			if (to.y >= from.y + from.height * 0.35) {
				const b = boxAnchor(to, "NORTH");
				return [a, { x: b.x, y: a.y }, b];
			}
			const b = boxAnchor(to, "EAST");
			if (Math.abs(a.y - b.y) < 3) return [a, b];
			const midX = (a.x + b.x) / 2;
			return [a, { x: midX, y: a.y }, { x: midX, y: b.y }, b];
		}
		if (to.y >= from.y + from.height + 16) {
			const a = boxAnchor(from, "SOUTH");
			const b = boxAnchor(to, "NORTH");
			if (Math.abs(a.x - b.x) < 3) return [a, b];
			const midY = (a.y + b.y) / 2;
			return [a, { x: a.x, y: midY }, { x: b.x, y: midY }, b];
		}
		if (to.x >= from.x + from.width + 12) {
			const a = boxAnchor(from, "EAST");
			if (to.y > from.y + from.height * 0.35) {
				const b = boxAnchor(to, "NORTH");
				return [a, { x: b.x, y: a.y }, b];
			}
			const b = boxAnchor(to, "WEST");
			if (Math.abs(a.y - b.y) < 3) return [a, b];
			const midX = (a.x + b.x) / 2;
			return [a, { x: midX, y: a.y }, { x: midX, y: b.y }, b];
		}
		if (from.x >= to.x + to.width + 12) {
			const a = boxAnchor(from, "WEST");
			if (to.y > from.y + from.height * 0.35) {
				const b = boxAnchor(to, "NORTH");
				return [a, { x: b.x, y: a.y }, b];
			}
			const b = boxAnchor(to, "EAST");
			if (Math.abs(a.y - b.y) < 3) return [a, b];
			const midX = (a.x + b.x) / 2;
			return [a, { x: midX, y: a.y }, { x: midX, y: b.y }, b];
		}
		// Target sits above or overlapping vertically: wrap cleanly around the nearer side.
		const a = boxAnchor(from, "SOUTH");
		const b = boxAnchor(to, "NORTH");
		const goRight = to.x + to.width / 2 >= from.x + from.width / 2;
		const sideX = goRight ? Math.max(from.x + from.width, to.x + to.width) + pad : Math.min(from.x, to.x) - pad;
		const lowY = a.y + pad;
		const highY = b.y - pad;
		return [a, { x: a.x, y: lowY }, { x: sideX, y: lowY }, { x: sideX, y: highY }, { x: b.x, y: highY }, b];
	}

	// Horizontal RIGHT layout.
	if (isBack) {
		const a = boxAnchor(from, fromKind === "decision" ? "NORTH" : "EAST");
		const b = boxAnchor(to, toKind === "decision" ? "NORTH" : "WEST");
		const gutterY = Math.min(from.y, to.y) - pad;
		if (fromKind === "decision") {
			if (toKind === "decision") return [a, { x: a.x, y: gutterY }, { x: b.x, y: gutterY }, b];
			const leftX = Math.min(from.x, to.x) - pad;
			return [a, { x: a.x, y: gutterY }, { x: leftX, y: gutterY }, { x: leftX, y: b.y }, b];
		}
		const rightX = Math.max(from.x + from.width, to.x + to.width) + pad;
		if (toKind === "decision") return [a, { x: rightX, y: a.y }, { x: rightX, y: gutterY }, { x: b.x, y: gutterY }, b];
		const leftX = Math.min(from.x, to.x) - pad;
		return [a, { x: rightX, y: a.y }, { x: rightX, y: gutterY }, { x: leftX, y: gutterY }, { x: leftX, y: b.y }, b];
	}
	if (fromKind === "decision" && to.y >= from.y + from.height + 8) {
		const a = boxAnchor(from, "SOUTH");
		if (to.x >= from.x + from.width * 0.35) {
			const b = boxAnchor(to, "WEST");
			return [a, { x: a.x, y: b.y }, b];
		}
		const b = boxAnchor(to, "NORTH");
		if (Math.abs(a.x - b.x) < 3) return [a, b];
		const midY = (a.y + b.y) / 2;
		return [a, { x: a.x, y: midY }, { x: b.x, y: midY }, b];
	}
	if (fromKind === "decision" && from.y >= to.y + to.height + 8) {
		const a = boxAnchor(from, "NORTH");
		if (to.x >= from.x + from.width * 0.35) {
			const b = boxAnchor(to, "WEST");
			return [a, { x: a.x, y: b.y }, b];
		}
		const b = boxAnchor(to, "SOUTH");
		if (Math.abs(a.x - b.x) < 3) return [a, b];
		const midY = (a.y + b.y) / 2;
		return [a, { x: a.x, y: midY }, { x: b.x, y: midY }, b];
	}
	if (to.x >= from.x + from.width + 16) {
		const a = boxAnchor(from, "EAST");
		const b = boxAnchor(to, "WEST");
		if (Math.abs(a.y - b.y) < 3) return [a, b];
		const midX = (a.x + b.x) / 2;
		return [a, { x: midX, y: a.y }, { x: midX, y: b.y }, b];
	}
	if (to.y >= from.y + from.height + 12) {
		const a = boxAnchor(from, "SOUTH");
		if (to.x > from.x + from.width * 0.35) {
			const b = boxAnchor(to, "WEST");
			return [a, { x: a.x, y: b.y }, b];
		}
		const b = boxAnchor(to, "NORTH");
		if (Math.abs(a.x - b.x) < 3) return [a, b];
		const midY = (a.y + b.y) / 2;
		return [a, { x: a.x, y: midY }, { x: b.x, y: midY }, b];
	}
	if (from.y >= to.y + to.height + 12) {
		const a = boxAnchor(from, "NORTH");
		if (to.x > from.x + from.width * 0.35) {
			const b = boxAnchor(to, "WEST");
			return [a, { x: a.x, y: b.y }, b];
		}
		const b = boxAnchor(to, "SOUTH");
		if (Math.abs(a.x - b.x) < 3) return [a, b];
		const midY = (a.y + b.y) / 2;
		return [a, { x: a.x, y: midY }, { x: b.x, y: midY }, b];
	}
	const a = boxAnchor(from, "EAST");
	const b = boxAnchor(to, "WEST");
	const goDown = to.y + to.height / 2 >= from.y + from.height / 2;
	const sideY = goDown ? Math.max(from.y + from.height, to.y + to.height) + pad : Math.min(from.y, to.y) - pad;
	const rightX = a.x + pad;
	const leftX = b.x - pad;
	return [a, { x: rightX, y: a.y }, { x: rightX, y: sideY }, { x: leftX, y: sideY }, { x: leftX, y: b.y }, b];
}

/** Preserves ELK's exact route when untouched or rigidly translated; re-routes cleanly when one endpoint moved. */
export function rerouteMovedEdge(
	basePoints: readonly Point[],
	from: Rect,
	to: Rect,
	fromDelta: Point,
	toDelta: Point,
	fromKind: NodeKind,
	toKind: NodeKind,
	dir: LayoutDirection,
	isBack: boolean,
): Point[] {
	if (fromDelta.x === 0 && fromDelta.y === 0 && toDelta.x === 0 && toDelta.y === 0) return basePoints.map((p) => ({ ...p }));
	if (fromDelta.x === toDelta.x && fromDelta.y === toDelta.y) {
		return basePoints.map((p) => ({ x: p.x + fromDelta.x, y: p.y + fromDelta.y }));
	}
	return orthogonalRoute(from, to, fromKind, toKind, dir, isBack);
}

/**
 * Computes a region's bounding box so every member node, every line contained
 * within the region (both endpoints inside), and every label on those contained
 * lines stays inside the border with at least `padding` on all four sides.
 * When `floor` is provided, the region expands as needed without shrinking
 * inside it (preserving auto-layout channels until inner items are moved).
 */
export function fitRegionBounds(
	memberBoxes: readonly Rect[],
	containedEdges: readonly { points: readonly Point[]; labelBox?: Rect }[],
	options: {
		minWidth?: number;
		floor?: Rect;
		padding?: { top: number; right: number; bottom: number; left: number };
	} = {},
): Rect | null {
	const pad = options.padding ?? REGION_PADDING;
	let minX = Infinity;
	let minY = Infinity;
	let maxX = -Infinity;
	let maxY = -Infinity;

	const includeRect = (r: Rect) => {
		if (r.x < minX) minX = r.x;
		if (r.y < minY) minY = r.y;
		if (r.x + r.width > maxX) maxX = r.x + r.width;
		if (r.y + r.height > maxY) maxY = r.y + r.height;
	};
	const includePoint = (p: Point) => {
		if (p.x < minX) minX = p.x;
		if (p.y < minY) minY = p.y;
		if (p.x > maxX) maxX = p.x;
		if (p.y > maxY) maxY = p.y;
	};

	for (const b of memberBoxes) includeRect(b);
	for (const e of containedEdges) {
		for (const p of e.points) includePoint(p);
		if (e.labelBox) includeRect(e.labelBox);
	}
	if (!Number.isFinite(minX)) return options.floor ? { ...options.floor } : null;

	let left = minX - pad.left;
	let top = minY - pad.top;
	let right = maxX + pad.right;
	let bottom = maxY + pad.bottom;

	if (options.floor) {
		left = Math.min(left, options.floor.x);
		top = Math.min(top, options.floor.y);
		right = Math.max(right, options.floor.x + options.floor.width);
		bottom = Math.max(bottom, options.floor.y + options.floor.height);
	}
	const width = Math.max(right - left, options.minWidth ?? 0);
	return { x: left, y: top, width, height: bottom - top };
}

// --- choosing an edge from the keyboard -----------------------------------------------------

export type EdgeRef = { from: string; to: string };

/** The next way out of a node after the one chosen, round and round; the first (or, backwards, the last) when none of them is chosen. */
export function cycleEdge(edges: readonly EdgeRef[], node: string, current: EdgeRef | null, step: 1 | -1 = 1): EdgeRef | null {
	const outs = edges.filter((e) => e.from === node);
	if (!outs.length) return null;
	const at = current ? outs.findIndex((e) => e.from === current.from && e.to === current.to) : -1;
	const next = outs[at < 0 ? (step > 0 ? 0 : outs.length - 1) : (at + step + outs.length) % outs.length]!;
	return { from: next.from, to: next.to };
}

// --- what a node is called, and the mark for its state -----------------------------------------

/** What is known about a node beyond its words: a build's progress, and the chart against its code. */
export type NodeState = { unit?: string; changed?: boolean; gone?: boolean; suggested?: boolean; built?: boolean; findings?: number; hasError?: boolean; hasDrift?: boolean };
export type Mark = "stuck" | "gone" | "running" | "changed" | "skipped" | "passed";
export type CodeIndicator = "grey" | "blue" | "green" | "yellow" | "red";

const UNIT_WORDS: Record<string, string> = { pending: "waiting to be built", running: "building", passed: "passed", stuck: "stuck", skipped: "waiting on a stuck unit", kept: "untouched" };

/** Five-state code indicator (stoplight + grey + blue) for steps and decisions. */
export function codeIndicator(state: NodeState): CodeIndicator {
	if (state.unit === "stuck" || state.gone || state.hasError) return "red";
	if (state.unit === "running" || state.unit === "pending" || state.suggested) return "blue";
	if (state.unit === "skipped") return "yellow";
	if (state.built && (state.changed || state.hasDrift || (state.findings ?? 0) > 0)) return "yellow";
	if (state.built || state.unit === "passed") return "green";
	return "grey";
}

export const CODE_INDICATOR_WORDS: Record<CodeIndicator, { label: string; detail: string }> = {
	grey: { label: "Not built", detail: "No code is linked to this step yet." },
	blue: { label: "Building", detail: "Agent build or update is active or queued for this step." },
	green: { label: "Built", detail: "Linked code exists and agrees with the chart." },
	yellow: { label: "Needs rebuild", detail: "Changed since the last build, or has a drift or chart warning." },
	red: { label: "Needs attention", detail: "Implementing procedure is missing, stuck, or has an error." },
};

/** The one mark a node carries, so its state does not rest on colour: the most pressing wins. */
export function statusMark(state: NodeState): Mark | null {
	if (state.unit === "stuck") return "stuck";
	if (state.gone) return "gone";
	if (state.unit === "running") return "running";
	if (state.changed) return "changed";
	if (state.unit === "skipped") return "skipped";
	if (state.unit === "passed") return "passed";
	return null;
}

export const MARK_WORDS: Record<Mark, string> = {
	stuck: "Stuck: the build could not finish this.",
	gone: "Its procedure has gone from the code.",
	running: "Building now.",
	changed: "Changed since it was built.",
	skipped: "Waiting on a stuck unit.",
	passed: "Passed the build's checks.",
};

/** Everything that is so of a node, in words, for its name and the announcement. */
export function statusWords(state: NodeState): string[] {
	return [
		state.suggested ? "suggested by the agent" : "",
		state.unit ? (UNIT_WORDS[state.unit] ?? state.unit) : "",
		state.changed ? "changed since it was built" : "",
		state.gone ? "its procedure has gone from the code" : "",
		state.built && !state.gone ? "has code" : "",
		state.findings ? `${state.findings} ${state.findings === 1 ? "finding" : "findings"}` : "",
	].filter(Boolean);
}

/** A node's accessible name: its words, its kind, its state. */
export function describeNode(node: Pick<PlanNode, "text" | "kind" | "ref">, state: NodeState = {}): string {
	const kind = node.kind === "call" && node.ref?.trim() ? `call to ${node.ref.trim()}` : node.kind;
	return [node.text.trim() || NO_WORDS, kind, ...statusWords(state)].join(", ");
}

/** An edge's accessible name: where it runs, and its label, or that a decision's branch still needs one. */
export function describeEdge(plan: Pick<Plan, "nodes" | "edges">, edge: EdgeRef): string {
	const words = (id: string) => `"${plan.nodes.find((n) => n.id === id)?.text.trim() || id}"`;
	const label = plan.edges.find((e) => e.from === edge.from && e.to === edge.to)?.label?.trim();
	const decision = plan.nodes.find((n) => n.id === edge.from)?.kind === "decision";
	return `Way out of ${words(edge.from)} to ${words(edge.to)}, ${label ? `labelled ${label}` : decision ? "no label yet: a decision's branch needs one" : "no label"}`;
}

// --- the keys --------------------------------------------------------------------------------

/** The chart's keys, as its Keys help lists them. Tab is not one: it moves on to the next control. */
export const KEYS: readonly (readonly [keys: string, what: string])[] = [
	["Arrow keys", "Move between nodes"],
	["Enter", "Add the next step; while connecting, connect to the selected node"],
	["B", "Add a branch: another way out"],
	["F2", "Edit the words of the node, or the label of the selected way out"],
	["D", "Turn a step into a decision, or back"],
	["C", "Connect: move to the node it leads to, then Enter"],
	["E, Shift+E", "Select the next or the previous way out of the node"],
	["Shift+Arrows, R", "Move a selected node or wire segment, or reset it"],
	["Delete", "Delete the selected node or way out"],
	["G", "Open the step's code"],
	["+, −, 0", "Zoom in, zoom out, fit; 0 again shows the whole chart"],
	["Ctrl+Z, Ctrl+Y", "Undo, redo"],
	["Esc", "Cancel, then clear the selection"],
	["?", "Show or hide this list"],
];
