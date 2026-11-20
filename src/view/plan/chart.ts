// The chart's own arithmetic, kept apart from the view so it can be tested
// without a window: how a node's words wrap and how large its shape must be,
// which edges are loops, what ELK is asked to lay out, where an edge meets a
// decision's diamond and carries its label, which way out comes next, and what
// a node or an edge is called when it is announced. Nothing here reads SSL.
import type { Measure, Point, Rect, Size } from "../graph/canvas";
import type { NodeKind, Plan, PlanEdge, PlanGroup, PlanNode } from "./model";

// --- words in a shape ------------------------------------------------------------

/** A line of a node's words, in the chart's own units. */
export const LINE = 17;
export const NO_WORDS = "(no words yet)";

/** Each shape's smallest width, what of that its outline takes from the words, and the height it adds to them. */
const SHAPES: Record<NodeKind, { width: number; inset: number; pad: number }> = {
	// The rounded ends of a start or an end, and a call's two bars, take room from the words.
	start: { width: 170, inset: 36, pad: 18 },
	end: { width: 170, inset: 36, pad: 18 },
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
/** The points of a decision its ways out leave by, in order: down, then out of each side. */
const TIPS: readonly Side[] = ["SOUTH", "EAST", "WEST"];
/** The room between steps side by side, and between one row of steps and the next: enough for a way's label. */
const SPACING = { "elk.spacing.nodeNode": "34", "elk.layered.spacing.nodeNodeBetweenLayers": "46" };
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
export function chartGraph(plan: Plan, sizes: ReadonlyMap<string, Size>, loopTip: "EAST" | "WEST" = "EAST", returnsAt: "NORTH" | "WEST" = "NORTH"): ChartGraph {
	const ids = new Set<string>();
	const nodes = plan.nodes.filter((n) => !ids.has(n.id) && ids.add(n.id));
	const edges = plan.edges.filter((e) => ids.has(e.from) && ids.has(e.to));
	const groups = plan.groups.filter((g) => nodes.some((n) => n.group === g.id));
	const known = new Set(groups.map((g) => g.id));
	const reversed = new Set([...backEdges(nodes, edges)].filter((i) => edges[i]!.from !== edges[i]!.to));
	// A name for ports that no node or group can already have.
	let stem = "port";
	while ([...ids, ...known].some((id) => id.startsWith(`${stem}:`))) stem += "_";
	const ports = new Map<string, ElkNode[]>();
	const port = (node: string, id: string, side: Side) => {
		if (!ports.get(node)?.some((p) => p.id === id)) ports.set(node, [...(ports.get(node) ?? []), { id, width: 0, height: 0, layoutOptions: { "elk.port.side": side } }]);
		return id;
	};
	// A decision is a diamond, and its ways in and out meet it at its points, as on paper: in at
	// the top, the first way out at the bottom, the next out of a side. The ways that go on come
	// before a way that closes a loop, so what goes on goes down.
	const decisions = new Set(nodes.filter((n) => n.kind === "decision").map((n) => n.id));
	const wayOut = new Map<number, Side>();
	let sided = false;
	let returning = false;
	for (const id of decisions) {
		const outs = edges.map((e, i) => ({ e, i })).filter(({ e }) => e.from === id && e.to !== id);
		const [on, back] = [outs.filter(({ i }) => !reversed.has(i)), outs.filter(({ i }) => reversed.has(i))];
		const free = [...TIPS];
		const take = (side: Side | undefined) => (side && free.includes(side) ? free.splice(free.indexOf(side), 1)[0]! : (free.shift() ?? "SOUTH"));
		// The way that closes a loop takes the side asked for while it is free; which side is shorter depends on the layout.
		const loops = new Map(back.map(({ i }, at) => [i, at === 0 && on.length <= 1 ? loopTip : undefined] as const));
		if (on.length) wayOut.set(on[0]!.i, take("SOUTH"));
		for (const { i } of back) if (loops.get(i)) (sided = true), wayOut.set(i, take(loops.get(i)));
		for (const { i } of [...on.slice(1), ...back]) if (!wayOut.has(i)) wayOut.set(i, take(undefined));
	}
	const leaves = (e: PlanEdge, i: number) => (decisions.has(e.from) ? port(e.from, `${stem}:${i}:out`, wayOut.get(i) ?? "SOUTH") : null);
	const arrives = (e: PlanEdge) => (decisions.has(e.to) ? port(e.to, `${stem}:${e.to}:in`, "NORTH") : null);
	// A loop's way back may come in at the decision's side instead, where no way out has taken it:
	// then every way back runs up that side, and the way out of the other side crosses none of them.
	const sideTaken = new Set(edges.map((e, i) => (wayOut.get(i) === "WEST" ? e.from : "")));
	const returns = (e: PlanEdge) => {
		if (!decisions.has(e.to)) return null;
		if (!sideTaken.has(e.to)) returning = true;
		return returnsAt === "WEST" && !sideTaken.has(e.to) ? port(e.to, `${stem}:${e.to}:back`, "WEST") : arrives(e);
	};
	const elkEdges = edges.map((e, i) =>
		reversed.has(i)
			? { id: `e${i}`, sources: [returns(e) ?? port(e.to, `${stem}:${i}:in`, "NORTH")], targets: [leaves(e, i) ?? port(e.from, `${stem}:${i}:out`, "SOUTH")] }
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
				"elk.direction": "DOWN",
				"elk.hierarchyHandling": "INCLUDE_CHILDREN",
				"elk.edgeRouting": "ORTHOGONAL",
				// More tries at the order within each row: a chart is small, and each crossing saved is one less to read past.
				"elk.layered.thoroughness": "40",
				...SPACING,
				"elk.json.edgeCoords": "ROOT",
			},
			children: [
				...nodes.filter((n) => !n.group || !known.has(n.group)).map(leaf),
				...groups.map((g) => ({
					id: g.id,
					// ELK reads the spacing from the box the nodes are in: without it a group's steps stand closer than the rest.
					layoutOptions: { "elk.padding": "[top=30,left=16,bottom=16,right=16]", ...SPACING },
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

/** An edge's points from its start to its end, whichever way ELK was given it, meeting a decision at its outline. */
export function routeOf(points: readonly Point[], isReversed: boolean, from: Rect | undefined, to: Rect | undefined): Point[] {
	const route = isReversed ? [...points].reverse() : [...points];
	if (route.length < 2) return route;
	if (from) route[0] = onDiamond(route[0]!, from);
	if (to) route[route.length - 1] = onDiamond(route[route.length - 1]!, to);
	return route;
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
export type NodeState = { unit?: string; changed?: boolean; gone?: boolean; suggested?: boolean; built?: boolean; findings?: number };
export type Mark = "stuck" | "gone" | "running" | "changed" | "skipped" | "passed";

const UNIT_WORDS: Record<string, string> = { pending: "waiting to be built", running: "building", passed: "passed", stuck: "stuck", skipped: "waiting on a stuck unit", kept: "untouched" };

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
	["Delete", "Delete the selected node or way out"],
	["G", "Open the step's code"],
	["+, −, 0", "Zoom in, zoom out, fit; 0 again shows the whole chart"],
	["Ctrl+Z, Ctrl+Y", "Undo, redo"],
	["Esc", "Cancel, then clear the selection"],
	["?", "Show or hide this list"],
];
