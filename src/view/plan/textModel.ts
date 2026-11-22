// Flow-ordered structured outline and focus-neighborhood model for a Plan's Text view
// (the readable list counterpart to the visual flowchart, inspired by Call Graph's List mode).
import { journeyBreakdown, type PlanPath } from "./built";
import type { Plan, PlanEdge, PlanNode } from "./model";

export type PlanTextEdge = {
	edge: PlanEdge;
	target: PlanNode;
	targetStage?: string;
	label?: string;
	/** True when this edge returns to a step earlier in flow order (a loop). */
	loopsBack: boolean;
	/** True when this edge flows directly to the immediately following row in the outline. */
	isImmediateNext: boolean;
};

export type PlanTextRow = {
	node: PlanNode;
	index: number;
	stageId?: string;
	stageName?: string;
	/** True when no path from a Start node reaches this step. */
	unreachable: boolean;
	/** Outgoing edges that carry branching, jumping, or looping information worth showing under the row. */
	links: PlanTextEdge[];
	/** All outgoing edges (including linear next-row transitions). */
	allOutgoing: PlanTextEdge[];
	/** All incoming edges with their source nodes. */
	incoming: { edge: PlanEdge; source: PlanNode; sourceStage?: string; label?: string }[];
};

export type PlanTextSection = {
	key: string;
	/** Stage/group id if this section represents a named stage. */
	stageId?: string;
	/** Section heading (stage name, "Unconnected steps", or undefined for main-flow ungrouped steps). */
	heading?: string;
	/** True when this section holds unreachable/disconnected nodes. */
	unreachable?: boolean;
	rows: PlanTextRow[];
};

export type PlanTextOutline = {
	sections: PlanTextSection[];
	rows: PlanTextRow[];
	rowById: Map<string, PlanTextRow>;
};

export type PlanFocusTarget = { kind: "node"; id: string } | { kind: "stage"; id: string };

export type PlanFocusNeighbor = {
	node: PlanNode;
	stageName?: string;
	label?: string;
	loopsBack?: boolean;
};

export type PlanNodeFocus = {
	kind: "node";
	node: PlanNode;
	stageId?: string;
	stageName?: string;
	incoming: PlanFocusNeighbor[];
	outgoing: PlanFocusNeighbor[];
};

export type PlanStageFocus = {
	kind: "stage";
	stageId: string;
	stageName: string;
	nodes: PlanNode[];
	enteredFrom: PlanFocusNeighbor[];
	leavesTo: PlanFocusNeighbor[];
};

export type PlanFocusView = PlanNodeFocus | PlanStageFocus;

/**
 * Orders a plan's steps top-to-bottom in natural business execution order:
 * starts from Start nodes, keeps steps inside the same stage contiguous, prefers "yes"
 * / primary branches before exits, defers End outcomes until after working steps, and
 * groups any unreachable steps cleanly at the bottom.
 */
export function planTextOutline(plan: Plan): PlanTextOutline {
	const nodeById = new Map(plan.nodes.map((n) => [n.id, n]));
	const groupName = new Map(plan.groups.map((g) => [g.id, g.name]));
	const outEdges = new Map<string, PlanEdge[]>();
	const inEdges = new Map<string, PlanEdge[]>();
	for (const e of plan.edges) {
		if (!nodeById.has(e.from) || !nodeById.has(e.to)) continue;
		const out = outEdges.get(e.from);
		if (out) out.push(e);
		else outEdges.set(e.from, [e]);
		const inc = inEdges.get(e.to);
		if (inc) inc.push(e);
		else inEdges.set(e.to, [e]);
	}

	const visited = new Set<string>();
	const ordered: PlanNode[] = [];
	const deferredEnds: PlanNode[] = [];

	const edgePriority = (from: PlanNode, e: PlanEdge): number => {
		const target = nodeById.get(e.to)!;
		const sameStage = Boolean(from.group && target.group === from.group);
		const lbl = e.label?.trim().toLowerCase() ?? "";
		let score = 0;
		// Keep steps inside the current stage together before exiting to another stage.
		if (sameStage) score -= 20;
		// Defer terminal end nodes until after active working steps.
		if (target.kind === "end") score += 40;
		// Walk affirmative / primary branches first so the main happy path reads first.
		if (lbl === "yes" || lbl === "true" || lbl === "ok") score -= 5;
		else if (lbl === "no" || lbl === "false") score += 5;
		return score;
	};

	const walk = (start: PlanNode) => {
		const stack: PlanNode[] = [start];
		while (stack.length > 0) {
			const cur = stack.pop()!;
			if (visited.has(cur.id)) continue;
			visited.add(cur.id);
			if (cur.kind === "end") {
				deferredEnds.push(cur);
				continue;
			}
			ordered.push(cur);
			const nexts = [...(outEdges.get(cur.id) ?? [])]
				.filter((e) => !visited.has(e.to))
				.sort((a, b) => edgePriority(cur, a) - edgePriority(cur, b));
			// Push in reverse so the highest-priority edge pops next.
			for (let i = nexts.length - 1; i >= 0; i--) {
				const target = nodeById.get(nexts[i]!.to);
				if (target && !visited.has(target.id)) stack.push(target);
			}
		}
	};

	const starts = plan.nodes.filter((n) => n.kind === "start");
	for (const s of starts) walk(s);
	// Append deferred terminal outcomes in the order discovered.
	for (const endNode of deferredEnds) ordered.push(endNode);

	const reachableIds = new Set(ordered.map((n) => n.id));
	// Collect any nodes unreachable from a Start node (or all nodes when there is no Start yet).
	const unreachable: PlanNode[] = [];
	for (const n of plan.nodes) {
		if (!reachableIds.has(n.id)) unreachable.push(n);
	}

	const allNodes = [...ordered, ...unreachable];
	const orderOf = new Map<string, number>();
	allNodes.forEach((n, idx) => orderOf.set(n.id, idx));

	const rows: PlanTextRow[] = allNodes.map((node, index) => {
		const stageId = node.group && groupName.has(node.group) ? node.group : undefined;
		const stageName = stageId ? groupName.get(stageId) : undefined;
		const rawOut = outEdges.get(node.id) ?? [];
		const allOutgoing: PlanTextEdge[] = rawOut.map((edge) => {
			const target = nodeById.get(edge.to)!;
			const targetIdx = orderOf.get(target.id) ?? 0;
			const loopsBack = targetIdx <= index;
			const label = edge.label?.trim() || undefined;
			const isImmediateNext = !label && !loopsBack && targetIdx === index + 1 && node.kind !== "decision" && rawOut.length === 1;
			return {
				edge,
				target,
				targetStage: target.group ? groupName.get(target.group) : undefined,
				...(label ? { label } : {}),
				loopsBack,
				isImmediateNext,
			};
		});
		const links = allOutgoing.filter((o) => !o.isImmediateNext);
		const incoming = (inEdges.get(node.id) ?? []).map((edge) => {
			const source = nodeById.get(edge.from)!;
			const label = edge.label?.trim() || undefined;
			return {
				edge,
				source,
				sourceStage: source.group ? groupName.get(source.group) : undefined,
				...(label ? { label } : {}),
			};
		});
		return {
			node,
			index,
			...(stageId ? { stageId, stageName } : {}),
			unreachable: starts.length > 0 && !reachableIds.has(node.id),
			links,
			allOutgoing,
			incoming,
		};
	});

	const rowById = new Map(rows.map((r) => [r.node.id, r]));

	// Group consecutive rows by stage (and separate unreachable steps cleanly at the end).
	const sections: PlanTextSection[] = [];
	let secSeq = 0;
	for (const row of rows) {
		if (row.unreachable) {
			const prev = sections.at(-1);
			if (prev?.unreachable) prev.rows.push(row);
			else sections.push({ key: `unreach-${++secSeq}`, heading: "Unconnected steps", unreachable: true, rows: [row] });
			continue;
		}
		const prev = sections.at(-1);
		if (prev && !prev.unreachable && prev.stageId === row.stageId) {
			prev.rows.push(row);
		} else {
			sections.push({
				key: row.stageId ? `stage-${row.stageId}-${++secSeq}` : `flow-${++secSeq}`,
				...(row.stageId ? { stageId: row.stageId, heading: row.stageName } : {}),
				rows: [row],
			});
		}
	}

	return { sections, rows, rowById };
}

/** Computes the focused "Comes from / Goes to" card for a selected step or stage. */
export function planFocusAround(plan: Plan, outline: PlanTextOutline, target: PlanFocusTarget | null): PlanFocusView | null {
	if (!target) return null;
	if (target.kind === "node") {
		const row = outline.rowById.get(target.id);
		if (!row) return null;
		return {
			kind: "node",
			node: row.node,
			stageId: row.stageId,
			stageName: row.stageName,
			incoming: row.incoming.map((i) => ({ node: i.source, stageName: i.sourceStage, label: i.label })),
			outgoing: row.allOutgoing.map((o) => ({ node: o.target, stageName: o.targetStage, label: o.label, loopsBack: o.loopsBack })),
		};
	}

	const group = plan.groups.find((g) => g.id === target.id);
	if (!group) return null;
	const stageRows = outline.rows.filter((r) => r.stageId === group.id);
	if (!stageRows.length) return null;
	const memberIds = new Set(stageRows.map((r) => r.node.id));
	const enteredFrom: PlanFocusNeighbor[] = [];
	const leavesTo: PlanFocusNeighbor[] = [];
	const seenIn = new Set<string>();
	const seenOut = new Set<string>();
	for (const r of stageRows) {
		for (const inc of r.incoming) {
			if (memberIds.has(inc.source.id)) continue;
			const key = `${inc.source.id}:${inc.label ?? ""}`;
			if (seenIn.has(key)) continue;
			seenIn.add(key);
			enteredFrom.push({ node: inc.source, stageName: inc.sourceStage, label: inc.label });
		}
		for (const out of r.allOutgoing) {
			if (memberIds.has(out.target.id)) continue;
			const key = `${out.target.id}:${out.label ?? ""}`;
			if (seenOut.has(key)) continue;
			seenOut.add(key);
			leavesTo.push({ node: out.target, stageName: out.targetStage, label: out.label, loopsBack: out.loopsBack });
		}
	}
	return {
		kind: "stage",
		stageId: group.id,
		stageName: group.name,
		nodes: stageRows.map((r) => r.node),
		enteredFrom,
		leavesTo,
	};
}

/** Map of decision nodeId -> chosen branch label (e.g. { n6: "yes", n9: "no" }). */
export type TestBranchChoices = Record<string, string>;

export type TestChoiceMatch = {
	/** 0-based indices into `paths` compatible with all chosen branches (and optional anchor step). */
	matchingPathIndices: number[];
	/** Node IDs appearing on at least one matching path. */
	reachableNodeIds: Set<string>;
	/** Set when every matching path ends at the exact same End node. */
	uniqueOutcome: PlanNode | null;
	/** Set when choices narrow down to a single flowchart journey (0-based index). */
	exactPathIndex: number | null;
};

/** Readable label for a decision in Given bullets, adding preceding step context for terse questions like "Is it?". */
export function decisionDisplayLabel(outline: PlanTextOutline, decisionId: string): string {
	const row = outline.rowById.get(decisionId);
	if (!row) return decisionId;
	const q = row.node.text.trim() || decisionId;
	if (q.length <= 18 && row.incoming.length === 1) {
		const src = row.incoming[0]!;
		if (!src.label && src.source.kind !== "start" && src.source.kind !== "decision") {
			const ctx = src.source.text.trim();
			if (ctx) return `${ctx} (${q})`;
		}
	}
	return q;
}

/** First branch label taken out of `decisionId` on a given flowchart path, or null if the path never visits it. */
function firstBranchOnPath(path: PlanPath, decisionId: string): string | null {
	for (let i = 1; i < path.steps.length; i++) {
		if (path.steps[i - 1]!.id === decisionId) {
			const lbl = path.steps[i]!.label?.trim();
			if (lbl) return lbl;
		}
	}
	return null;
}

/**
 * Matches a set of interactive decision choices (and optional anchored step) against all flowchart journeys.
 * Checking each decision's first visit handles loop headers accurately (e.g. choosing "no" on a loop means 0 iterations).
 */
export function matchPathsForChoices(
	plan: Plan,
	paths: PlanPath[],
	choices: TestBranchChoices,
	anchorNodeId?: string | null,
): TestChoiceMatch {
	const nodeById = new Map(plan.nodes.map((n) => [n.id, n]));
	const entries = Object.entries(choices).filter(([, v]) => v.trim().length > 0);
	const matchingPathIndices: number[] = [];
	const reachableNodeIds = new Set<string>();
	const endIds = new Set<string>();

	paths.forEach((path, idx) => {
		if (anchorNodeId && !path.steps.some((s) => s.id === anchorNodeId)) return;
		for (const [decId, wanted] of entries) {
			const taken = firstBranchOnPath(path, decId);
			if (!taken || taken.toLowerCase() !== wanted.trim().toLowerCase()) return;
		}
		matchingPathIndices.push(idx);
		for (const s of path.steps) reachableNodeIds.add(s.id);
		const last = path.steps.at(-1);
		if (last) {
			const n = nodeById.get(last.id);
			if (!n || n.kind === "end") endIds.add(last.id);
		}
	});

	let uniqueOutcome: PlanNode | null = null;
	if (endIds.size === 1) {
		const onlyId = [...endIds][0]!;
		uniqueOutcome = nodeById.get(onlyId) ?? null;
	}

	return {
		matchingPathIndices,
		reachableNodeIds,
		uniqueOutcome,
		exactPathIndex: matchingPathIndices.length === 1 ? matchingPathIndices[0]! : null,
	};
}

/** Extracts interactive branch choices from a full flowchart journey (skipping mechanical loop-entry gates unless non-looping). */
export function choicesFromPath(plan: Plan, path: PlanPath): TestBranchChoices {
	const bd = journeyBreakdown(plan, path);
	const business = bd.items.filter((it) => !it.isLoopGate);
	const chosen = business.length > 0 ? business : bd.items;
	const out: TestBranchChoices = {};
	for (const item of chosen) out[item.nodeId] = item.answer;
	return out;
}

/** Extracts invariant first-visit decision choices that hold on every journey reaching `nodeId`. */
export function choicesFromStep(nodeId: string, paths: PlanPath[]): TestBranchChoices {
	const hitting = paths.filter((p) => p.steps.some((s) => s.id === nodeId));
	if (!hitting.length) return {};
	const firstMaps = hitting.map((p) => {
		const pos = p.steps.findIndex((s) => s.id === nodeId);
		const m = new Map<string, string>();
		for (let i = 1; i <= pos; i++) {
			const prev = p.steps[i - 1]!;
			const cur = p.steps[i]!;
			const lbl = cur.label?.trim();
			if (!lbl || prev.id === nodeId || m.has(prev.id)) continue;
			m.set(prev.id, lbl);
		}
		return m;
	});
	const out: TestBranchChoices = {};
	for (const [decId, lbl] of firstMaps[0]!.entries()) {
		const lower = lbl.toLowerCase();
		if (firstMaps.every((m) => m.get(decId)?.toLowerCase() === lower)) {
			// Skip loop-entry gates if there are also specific business decisions in the chain?
			// Keeping every true first-visit invariant lets the outline visibly highlight the path to this step.
			out[decId] = lbl;
		}
	}
	return out;
}

/**
 * Updates, appends, or removes a single `- <label>: <answer>` line inside a multi-line Given string
 * without touching any custom business setup lines the analyst wrote.
 */
export function syncChoiceInGiven(given: string, label: string, answer: string | null): string {
	const prefix = `- ${label}:`;
	const lowerPrefix = prefix.toLowerCase();
	const lines = given.split(/\r?\n/);
	const idx = lines.findIndex((l) => l.trim().toLowerCase().startsWith(lowerPrefix));
	if (answer === null) {
		if (idx < 0) return given;
		lines.splice(idx, 1);
		return lines.join("\n").replace(/^\n+|\n+$/g, "");
	}
	const nextLine = `- ${label}: ${answer}`;
	if (idx >= 0) {
		lines[idx] = nextLine;
		return lines.join("\n");
	}
	const trimmed = given.trimEnd();
	return trimmed ? `${trimmed}\n${nextLine}` : nextLine;
}
