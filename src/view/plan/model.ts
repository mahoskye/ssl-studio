// A plan: a process or script designed as a flow chart, in plain words, kept
// as `design/<name>.plan.json` (ADR 0005). The chart is a view of this text;
// every chart edit is a text edit, so one undo history serves both. No SSL is
// read or written here (ADR 0003).

export type NodeKind = "start" | "end" | "step" | "decision" | "call";
export type PlanOffset = { x: number; y: number; dir?: "DOWN" | "RIGHT" };
export type PlanNode = { id: string; kind: NodeKind; text: string; ref?: string; group?: string; notes?: string; docs?: string[]; offset?: PlanOffset; [key: string]: unknown };
export type RouteOffsets = Record<string, number>;
export type PlanEdge = { from: string; to: string; label?: string; route?: RouteOffsets; [key: string]: unknown };
export type PlanGroup = { id: string; name: string; offset?: PlanOffset; [key: string]: unknown };
/** A plain-English business test case written by an analyst or developer on a step or across the plan. */
export type PlanTestCase = {
	id: string;
	title: string;
	node?: string;
	/** Optional 1-based flowchart journey number this test case covers. */
	journey?: number;
	given?: string;
	expect?: string;
	/** Additional details, sample data, edge cases, or verification notes. */
	notes?: string;
	[key: string]: unknown;
};
export type PlanTestInput = { title: string; node?: string; journey?: number; given?: string; expect?: string; notes?: string };
export type PlanTestPatch = { title?: string; node?: string; journey?: number | null; given?: string; expect?: string; notes?: string };
/** Fields this version does not know are kept as they are. */
export type Plan = { version: number; title: string; groups: PlanGroup[]; nodes: PlanNode[]; edges: PlanEdge[]; tests?: PlanTestCase[]; [key: string]: unknown };

const KINDS = new Set<string>(["start", "end", "step", "decision", "call"]);
const isObject = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const isSerializable = (value: unknown): boolean => value !== undefined && typeof value !== "function" && typeof value !== "symbol";
const optString = (value: unknown): string | undefined =>
	typeof value === "string" ? value : typeof value === "number" || typeof value === "boolean" ? String(value) : undefined;

function validOffset(value: unknown): PlanOffset | undefined {
	if (!isObject(value)) return undefined;
	if (typeof value.x !== "number" || !Number.isFinite(value.x) || typeof value.y !== "number" || !Number.isFinite(value.y)) return undefined;
	const { x, y, dir, ...rest } = value;
	return dir === "RIGHT" || dir === "DOWN" ? ({ ...rest, x, y, dir } as PlanOffset) : ({ ...rest, x, y } as PlanOffset);
}

function validRoute(value: unknown): RouteOffsets | undefined {
	if (!isObject(value)) return undefined;
	const cleaned: RouteOffsets = {};
	for (const [k, v] of Object.entries(value)) {
		if (typeof v === "number" && Number.isFinite(v)) cleaned[k] = v;
	}
	return Object.keys(cleaned).length ? cleaned : undefined;
}

function sanitizeNode(n: Record<string, unknown>): PlanNode {
	const out: Record<string, unknown> = { ...n };
	if ("ref" in out) {
		const s = optString(out.ref);
		if (s !== undefined) out.ref = s;
		else delete out.ref;
	}
	if ("notes" in out) {
		const s = optString(out.notes);
		if (s !== undefined) out.notes = s;
		else delete out.notes;
	}
	if ("group" in out) {
		const s = optString(out.group);
		if (s !== undefined) out.group = s;
		else delete out.group;
	}
	if ("docs" in out && !Array.isArray(out.docs)) delete out.docs;
	if ("offset" in out) {
		const off = validOffset(out.offset);
		if (off) out.offset = off;
		else delete out.offset;
	}
	return out as PlanNode;
}

function sanitizeEdge(e: Record<string, unknown>): PlanEdge {
	const out: Record<string, unknown> = { ...e };
	if ("label" in out) {
		const s = optString(out.label);
		if (s !== undefined) out.label = s;
		else delete out.label;
	}
	if ("route" in out) {
		const r = validRoute(out.route);
		if (r) out.route = r;
		else delete out.route;
	}
	return out as PlanEdge;
}

function sanitizeGroup(g: Record<string, unknown>): PlanGroup {
	const out: Record<string, unknown> = { ...g };
	if ("offset" in out) {
		const off = validOffset(out.offset);
		if (off) out.offset = off;
		else delete out.offset;
	}
	return out as PlanGroup;
}

/** Dragged from the Objects panel to make a call node. */
export const PROCEDURE_DRAG = "application/x-ssl-procedure";
/** Dragged from the Palette panel to drop a shape onto a node, edge, or canvas. */
export const SHAPE_DRAG = "application/x-ssl-plan-shape";

export const isPlanPath = (path: string | null | undefined) => Boolean(path && /\.plan\.json$/i.test(path));

export function newPlan(title: string): Plan {
	return {
		version: 1,
		title,
		groups: [],
		nodes: [
			{ id: "n1", kind: "start", text: "Start" },
			{ id: "n2", kind: "end", text: "End" },
		],
		edges: [{ from: "n1", to: "n2" }],
	};
}

export function parsePlan(text: string): { plan: Plan; error?: undefined } | { plan?: undefined; error: string } {
	let raw: unknown;
	try {
		raw = JSON.parse(text);
	} catch (e: any) {
		return { error: `Not valid JSON: ${e?.message ?? e}` };
	}
	if (!isObject(raw)) return { error: "A plan is one JSON object." };
	if (raw.version !== 1) return { error: `This plan is version ${JSON.stringify(raw.version)}; SSL Studio reads version 1.` };
	const rawGroups = raw.groups ?? [];
	if (!Array.isArray(raw.nodes) || !Array.isArray(raw.edges) || !Array.isArray(rawGroups)) return { error: '"nodes" and "edges" must be lists.' };
	const nodes: PlanNode[] = [];
	for (const n of raw.nodes) {
		if (!isObject(n) || typeof n.id !== "string" || typeof n.text !== "string") return { error: 'Each node needs an "id" and a "text".' };
		if (!KINDS.has(String(n.kind))) return { error: `Node ${n.id} has an unknown kind: ${JSON.stringify(n.kind)}.` };
		nodes.push(sanitizeNode(n));
	}
	const edges: PlanEdge[] = [];
	for (const e of raw.edges) {
		if (!isObject(e) || typeof e.from !== "string" || typeof e.to !== "string") return { error: 'Each edge needs a "from" and a "to".' };
		edges.push(sanitizeEdge(e));
	}
	const groups: PlanGroup[] = [];
	for (const g of rawGroups) {
		if (!isObject(g) || typeof g.id !== "string" || typeof g.name !== "string") return { error: 'Each group needs an "id" and a "name".' };
		groups.push(sanitizeGroup(g));
	}
	const out: Record<string, unknown> = {
		...raw,
		title: typeof raw.title === "string" ? raw.title : "",
		groups,
		nodes,
		edges,
	};
	if ("tests" in out) {
		if (Array.isArray(out.tests)) out.tests = out.tests.filter(isObject);
		else delete out.tests;
	}
	if ("decisions" in out) {
		if (Array.isArray(out.decisions)) out.decisions = out.decisions.filter(isObject);
		else delete out.decisions;
	}
	if (isObject(out.built) && Array.isArray(out.built.units)) {
		out.built = { ...out.built, units: out.built.units.filter(isObject) };
	}
	return { plan: out as Plan };
}

const row = (value: Record<string, unknown>, first: string[]) => {
	const keys = [
		...first.filter((k) => isSerializable(value[k])),
		...Object.keys(value).filter((k) => !first.includes(k) && isSerializable(value[k])),
	];
	return `{ ${keys.map((k) => `${JSON.stringify(k)}: ${JSON.stringify(value[k])}`).join(", ")} }`;
};
const rows = (name: string, list: Record<string, unknown>[], first: string[]) =>
	list.length ? `  ${JSON.stringify(name)}: [\n${list.map((item) => `    ${row(item, first)}`).join(",\n")}\n  ]` : `  ${JSON.stringify(name)}: []`;

/** The record of a build, as `built.ts` has it: a unit a line, a node a line. */
function printBuilt(built: Record<string, unknown>) {
	const inner = Object.entries(built)
		.filter(([, v]) => isSerializable(v))
		.map(([k, v]) => {
			if (k === "units" && Array.isArray(v)) {
				const valid = v.filter(isObject);
				return valid.length
					? `    "units": [\n${valid.map((u) => `      ${row(u, ["name", "script", "parameters", "nodes", "calls"])}`).join(",\n")}\n    ]`
					: `    "units": []`;
			}
			return `    ${JSON.stringify(k)}: ${JSON.stringify(v, null, 2).replace(/\n/g, "\n    ")}`;
		});
	return inner.length ? `  "built": {\n${inner.join(",\n")}\n  }` : `  "built": {}`;
}

/** One node or edge a line, in a stable order, so a change shows as a small diff. */
export function printPlan(plan: Plan): string {
	const { version, title, goal, ticket, targets, groups, nodes, edges, tests, built, ...rest } = plan;
	const head = { version, title, goal, ticket, targets };
	const cleanTests = Array.isArray(tests) ? tests.filter(isObject) : [];
	const restLines = Object.entries(rest)
		.filter(([, v]) => isSerializable(v))
		.map(([k, v]) => JSON.stringify({ [k]: v }, null, 2).split("\n").slice(1, -1).join("\n"))
		.filter((line) => line.length > 0);
	const lines = [
		...Object.entries(head)
			.filter(([, v]) => isSerializable(v))
			.map(([k, v]) => `  ${JSON.stringify(k)}: ${JSON.stringify(v)}`),
		rows("groups", groups, ["id", "name", "offset"]),
		rows("nodes", nodes, ["id", "kind", "text", "ref", "group", "notes", "docs", "offset"]),
		rows("edges", edges, ["from", "to", "label", "route"]),
		...(cleanTests.length ? [rows("tests", cleanTests, ["id", "title", "node", "journey", "given", "expect", "notes"])] : []),
		...restLines,
		...(isObject(built) ? [printBuilt(built)] : isSerializable(built) ? [`  "built": ${JSON.stringify(built)}`] : []),
	];
	return `{\n${lines.join(",\n")}\n}\n`;
}

// --- edits: each returns a new plan, and the node to select --------------------

export type Edit = { plan: Plan; select?: string };

export const nextNodeId = (plan: Plan) => nextId(plan);

function nextId(plan: Plan, prefix = "n") {
	const pattern = new RegExp(`^${prefix}(\\d+)$`);
	const used = [...plan.nodes, ...plan.groups].map((x) => pattern.exec(x.id)?.[1]).filter(Boolean).map(Number);
	return `${prefix}${Math.max(0, ...used) + 1}`;
}

const outOf = (plan: Plan, id: string) => plan.edges.filter((e) => e.from === id);
const into = (plan: Plan, id: string) => plan.edges.filter((e) => e.to === id);
const nodeOf = (plan: Plan, id: string) => plan.nodes.find((n) => n.id === id);

function nextLabel(plan: Plan, id: string) {
	const used = new Set(outOf(plan, id).map((e) => (typeof e.label === "string" ? e.label.toLowerCase() : undefined)));
	if (!used.has("yes")) return "yes";
	if (!used.has("no")) return "no";
	return `option ${used.size + 1}`;
}

function make(plan: Plan, kind: NodeKind, text: string, near?: PlanNode, ref?: string): PlanNode {
	return { id: nextId(plan), kind, text, ...(ref ? { ref } : {}), ...(near?.group ? { group: near.group } : {}) };
}

/** The next step: takes over the selected node's way out, or comes before an end. */
export function addAfter(plan: Plan, id: string, kind: NodeKind = "step", text?: string, ref?: string): Edit {
	const at = nodeOf(plan, id);
	if (!at) return { plan };
	if (at.kind === "decision") return addBranch(plan, id, kind, text, ref) ?? { plan };
	const label = text ?? (kind === "end" ? "End" : "New step");
	const node = make(plan, kind, label, at, ref);
	const edges =
		kind === "end"
			? at.kind === "end"
				? plan.edges
				: [...plan.edges, { from: id, to: node.id }]
			: at.kind === "end"
				? [...plan.edges.map((e) => (e.to === id ? { ...e, to: node.id } : e)), { from: node.id, to: id }]
				: [...plan.edges.map((e) => (e.from === id ? { ...e, from: node.id } : e)), { from: id, to: node.id }];
	return { plan: { ...plan, nodes: [...plan.nodes, node], edges }, select: node.id };
}

/** Another way out. A step becomes a decision; the new branch runs to the first end. */
export function addBranch(plan: Plan, id: string, kind: NodeKind = "step", text?: string, ref?: string): Edit | null {
	const at = nodeOf(plan, id);
	if (!at || (at.kind !== "step" && at.kind !== "decision")) return null;
	const label = text ?? (kind === "end" ? "End" : "New step");
	const node = make(plan, kind, label, at, ref);
	// What already leaves a step is its first branch.
	let edges = plan.edges;
	if (at.kind === "step") {
		let labelled = false;
		edges = edges.map((e) => (e.from === id && !e.label && !labelled ? ((labelled = true), { ...e, label: "yes" }) : e));
	}
	const nodes = plan.nodes.map((n) => (n.id === id ? { ...n, kind: "decision" as const } : n));
	const after = { ...plan, nodes, edges };
	const end = plan.nodes.find((n) => n.kind === "end");
	return {
		plan: {
			...after,
			nodes: [...nodes, node],
			edges: [
				...edges,
				{ from: id, to: node.id, label: nextLabel(after, id) },
				...(kind !== "end" && end ? [{ from: node.id, to: end.id }] : []),
			],
		},
		select: node.id,
	};
}

export function addCall(plan: Plan, ref: string, after?: string): Edit {
	if (after && nodeOf(plan, after)) return addAfter(plan, after, "call", ref, ref);
	const node = make(plan, "call", ref, undefined, ref);
	return { plan: { ...plan, nodes: [...plan.nodes, node] }, select: node.id };
}

/** Removes a node. One way in and one way out are joined, so the flow stays whole. */
export function removeNode(plan: Plan, id: string): Edit {
	const ins = into(plan, id).filter((e) => e.from !== id);
	const outs = outOf(plan, id).filter((e) => e.to !== id);
	const edges = plan.edges.filter((e) => e.from !== id && e.to !== id);
	if (
		ins.length === 1 &&
		outs.length === 1 &&
		ins[0]!.from !== outs[0]!.to &&
		!edges.some((e) => e.from === ins[0]!.from && e.to === outs[0]!.to)
	) {
		const { route: _oldRoute, ...restIn } = ins[0]!;
		edges.push({ ...restIn, to: outs[0]!.to } as PlanEdge);
	}
	// Keep any business test cases attached to the removed node as plan-level tests (ADR 0009: nothing lost silently).
	const existingTests = planTestsOf(plan);
	const nextTests = existingTests.length
		? existingTests.map((t) => {
				if (t.node !== id) return t;
				const { node: _dropped, ...rest } = t;
				return rest as PlanTestCase;
			})
		: undefined;
	return {
		plan: pruneGroups({ ...plan, nodes: plan.nodes.filter((n) => n.id !== id), edges, ...(nextTests ? { tests: nextTests } : {}) }),
		select: ins[0]?.from ?? outs[0]?.to,
	};
}

/** Valid plain-English business test cases saved in this plan. */
export function planTestsOf(plan: Plan): PlanTestCase[] {
	if (!Array.isArray(plan.tests)) return [];
	return plan.tests.filter((t): t is PlanTestCase => isObject(t) && typeof t.id === "string" && typeof t.title === "string");
}

function nextTestId(tests: PlanTestCase[]): string {
	const used = tests.map((t) => /^t(\d+)$/.exec(t.id)?.[1]).filter(Boolean).map(Number);
	return `t${Math.max(0, ...used) + 1}`;
}

export function addPlanTest(plan: Plan, input: PlanTestInput): Plan {
	const title = input.title.trim();
	if (!title) return plan;
	const current = planTestsOf(plan);
	const journey = typeof input.journey === "number" && Number.isInteger(input.journey) && input.journey > 0 ? input.journey : undefined;
	const entry: PlanTestCase = {
		id: nextTestId(current),
		title,
		...(input.node?.trim() ? { node: input.node.trim() } : {}),
		...(journey !== undefined ? { journey } : {}),
		...(input.given?.trim() ? { given: input.given.trim() } : {}),
		...(input.expect?.trim() ? { expect: input.expect.trim() } : {}),
		...(input.notes?.trim() ? { notes: input.notes.trim() } : {}),
	};
	return { ...plan, tests: [...current, entry] };
}

export function updatePlanTest(plan: Plan, id: string, patch: PlanTestPatch): Plan {
	const current = planTestsOf(plan);
	if (!current.some((t) => t.id === id)) return plan;
	const next = current.map((t) => {
		if (t.id !== id) return t;
		const title = patch.title !== undefined ? patch.title.trim() || t.title : t.title;
		const node = patch.node !== undefined ? patch.node.trim() : t.node;
		const journey =
			patch.journey === null
				? undefined
				: patch.journey !== undefined
					? Number.isInteger(patch.journey) && patch.journey > 0
						? patch.journey
						: undefined
					: t.journey;
		const given = patch.given !== undefined ? patch.given.trim() : t.given;
		const expect = patch.expect !== undefined ? patch.expect.trim() : t.expect;
		const notes = patch.notes !== undefined ? patch.notes.trim() : t.notes;
		const { node: _n, journey: _j, given: _g, expect: _e, notes: _no, ...rest } = t;
		return {
			...rest,
			title,
			...(node ? { node } : {}),
			...(journey !== undefined ? { journey } : {}),
			...(given ? { given } : {}),
			...(expect ? { expect } : {}),
			...(notes ? { notes } : {}),
		} as PlanTestCase;
	});
	return { ...plan, tests: next };
}

export function removePlanTest(plan: Plan, id: string): Plan {
	const current = planTestsOf(plan);
	const next = current.filter((t) => t.id !== id);
	if (next.length === current.length) return plan;
	if (!next.length) {
		const { tests: _empty, ...rest } = plan;
		return rest as Plan;
	}
	return { ...plan, tests: next };
}

export const setText = (plan: Plan, id: string, text: string): Plan => ({ ...plan, nodes: plan.nodes.map((n) => (n.id === id ? { ...n, text } : n)) });

export function setDecision(plan: Plan, id: string, on: boolean): Plan {
	return { ...plan, nodes: plan.nodes.map((n) => (n.id === id && (n.kind === "step" || n.kind === "decision") ? { ...n, kind: on ? "decision" : "step" } : n)) };
}

/** Converts a node to any flowchart kind, keeping or clearing `ref` as appropriate. */
export function setKind(plan: Plan, id: string, kind: NodeKind, ref?: string): Plan {
	return {
		...plan,
		nodes: plan.nodes.map((n) => {
			if (n.id !== id) return n;
			const { ref: prevRef, ...rest } = n;
			if (kind === "call") {
				const nextRef = ref?.trim() || (typeof prevRef === "string" ? prevRef.trim() : "") || n.text.trim();
				return { ...rest, kind, ...(nextRef ? { ref: nextRef } : {}) } as PlanNode;
			}
			return { ...rest, kind } as PlanNode;
		}),
	};
}

/** Inserts a new node cleanly onto an existing edge `from -> to`, preserving any branch label on the incoming wire. */
export function insertOnEdge(plan: Plan, from: string, to: string, kind: NodeKind = "step", text = "New step", ref?: string): Edit | null {
	const index = plan.edges.findIndex((e) => e.from === from && e.to === to);
	if (index < 0) return null;
	const existing = plan.edges[index]!;
	const fromNode = nodeOf(plan, from);
	const toNode = nodeOf(plan, to);
	const sharedGroup = fromNode?.group && fromNode.group === toNode?.group ? fromNode : fromNode?.group ? fromNode : toNode;
	const node = make(plan, kind, text, sharedGroup, ref);
	const { label, route: _oldRoute, ...restEdge } = existing;
	const first: PlanEdge = { ...restEdge, from, to: node.id, ...(label ? { label } : {}) };
	const second: PlanEdge = { from: node.id, to };
	const edges = [...plan.edges.slice(0, index), first, second, ...plan.edges.slice(index + 1)];
	return { plan: { ...plan, nodes: [...plan.nodes, node], edges }, select: node.id };
}

/** Duplicates a node right after itself (preserving kind, text, ref, group, notes, docs, and custom fields). */
export function duplicateNode(plan: Plan, id: string): Edit | null {
	const src = nodeOf(plan, id);
	if (!src || src.kind === "start" || src.kind === "end") return null;
	const added = addAfter(plan, id, src.kind, src.text, typeof src.ref === "string" ? src.ref : undefined);
	if (!added.select) return null;
	const docs = nodeDocsOf(src);
	const { id: _id, offset: _offset, docs: _docs, notes: _notes, pending: _pending, ...srcRest } = src;
	const nextNodes = added.plan.nodes.map((n) =>
		n.id === added.select
			? {
					...srcRest,
					...n,
					...(typeof src.notes === "string" && src.notes ? { notes: src.notes } : {}),
					...(docs.length ? { docs } : {}),
				}
			: n,
	);
	return { plan: { ...added.plan, nodes: nextNodes }, select: added.select };
}

/** Normalized, deduplicated list of workspace doc paths/references linked to a node. */
export function nodeDocsOf(node: PlanNode | undefined): string[] {
	if (!node || !Array.isArray(node.docs)) return [];
	const seen = new Set<string>();
	const out: string[] = [];
	for (const item of node.docs) {
		if (typeof item !== "string") continue;
		const trimmed = item.trim();
		if (!trimmed) continue;
		const key = trimmed.toLowerCase();
		if (seen.has(key)) continue;
		seen.add(key);
		out.push(trimmed);
	}
	return out;
}

/** Sets or clears linked docs on a node (omitting `docs` when empty so diffs stay clean). */
export function setNodeDocs(plan: Plan, id: string, docs: readonly string[]): Plan {
	const seen = new Set<string>();
	const cleaned: string[] = [];
	for (const d of docs) {
		const trimmed = d.trim();
		if (!trimmed) continue;
		const key = trimmed.toLowerCase();
		if (seen.has(key)) continue;
		seen.add(key);
		cleaned.push(trimmed);
	}
	return {
		...plan,
		nodes: plan.nodes.map((n) => {
			if (n.id !== id) return n;
			const { docs: _old, ...rest } = n;
			return (cleaned.length ? { ...rest, docs: cleaned } : rest) as PlanNode;
		}),
	};
}

export function addNodeDoc(plan: Plan, id: string, docRef: string): Plan {
	const node = nodeOf(plan, id);
	if (!node || !docRef.trim()) return plan;
	return setNodeDocs(plan, id, [...nodeDocsOf(node), docRef.trim()]);
}

export function removeNodeDoc(plan: Plan, id: string, docRef: string): Plan {
	const node = nodeOf(plan, id);
	if (!node) return plan;
	const target = docRef.trim().toLowerCase();
	return setNodeDocs(
		plan,
		id,
		nodeDocsOf(node).filter((d) => d.toLowerCase() !== target),
	);
}

/** Reverses an edge `from -> to` into `to -> from` when the opposite edge does not already exist. */
export function reverseEdge(plan: Plan, from: string, to: string): Plan {
	if (plan.edges.some((e) => e.from === to && e.to === from)) return plan;
	return {
		...plan,
		edges: plan.edges.map((e) => {
			if (e.from !== from || e.to !== to) return e;
			const { route: _oldRoute, ...rest } = e;
			return { ...rest, from: to, to: from } as PlanEdge;
		}),
	};
}

/** Renames a stage group in place (merging into an existing group of the same name, or ungrouping if empty). */
export function renameGroup(plan: Plan, groupId: string, nextName: string): Plan {
	const wanted = nextName.trim();
	if (!wanted) {
		const nodes = plan.nodes.map((n) => {
			if (n.group !== groupId) return n;
			const { group: _old, ...rest } = n;
			return rest as PlanNode;
		});
		return pruneGroups({ ...plan, nodes });
	}
	const existing = plan.groups.find((g) => g.id !== groupId && g.name.toLowerCase() === wanted.toLowerCase());
	if (existing) {
		const nodes = plan.nodes.map((n) => (n.group === groupId ? { ...n, group: existing.id } : n));
		return pruneGroups({ ...plan, nodes });
	}
	return { ...plan, groups: plan.groups.map((g) => (g.id === groupId ? { ...g, name: wanted } : g)) };
}

export function connect(plan: Plan, from: string, to: string): Plan {
	if (from === to || plan.edges.some((e) => e.from === from && e.to === to)) return plan;
	const label = nodeOf(plan, from)?.kind === "decision" ? nextLabel(plan, from) : undefined;
	return { ...plan, edges: [...plan.edges, { from, to, ...(label ? { label } : {}) }] };
}

export const removeEdge = (plan: Plan, from: string, to: string): Plan => ({ ...plan, edges: plan.edges.filter((e) => e.from !== from || e.to !== to) });

export function setEdgeLabel(plan: Plan, from: string, to: string, label: string): Plan {
	return {
		...plan,
		edges: plan.edges.map((e) => {
			if (e.from !== from || e.to !== to) return e;
			const { label: _old, ...rest } = e;
			return (label ? { ...rest, label } : rest) as PlanEdge;
		}),
	};
}

/** Stores or clears sparse manual wire-segment offsets on an edge (omitted when zero/empty so diffs stay minimal). */
export function setEdgeRoute(plan: Plan, from: string, to: string, route: RouteOffsets | null): Plan {
	const cleaned: RouteOffsets = {};
	if (route) {
		for (const [k, v] of Object.entries(route)) {
			if (typeof v === "number" && Number.isFinite(v) && Math.abs(v) >= 2) cleaned[k] = Math.round(v);
		}
	}
	const hasAny = Object.keys(cleaned).length > 0;
	return {
		...plan,
		edges: plan.edges.map((e) => {
			if (e.from !== from || e.to !== to) return e;
			const { route: _old, ...rest } = e;
			return (hasAny ? { ...rest, route: cleaned } : rest) as PlanEdge;
		}),
	};
}

function cleanOffset(offset: PlanOffset | null): PlanOffset | undefined {
	if (!offset || !Number.isFinite(offset.x) || !Number.isFinite(offset.y)) return undefined;
	const x = Math.round(offset.x);
	const y = Math.round(offset.y);
	if (Math.abs(x) < 2 && Math.abs(y) < 2) return undefined;
	return offset.dir === "RIGHT" ? { x, y, dir: "RIGHT" } : { x, y };
}

/** Stores or clears a sparse manual position offset on a node relative to its auto-layout position. */
export function setNodeOffset(plan: Plan, id: string, offset: PlanOffset | null): Plan {
	const next = cleanOffset(offset);
	return {
		...plan,
		nodes: plan.nodes.map((n) => {
			if (n.id !== id) return n;
			const { offset: _old, ...rest } = n;
			return (next ? { ...rest, offset: next } : rest) as PlanNode;
		}),
	};
}

/** Stores or clears a sparse manual position offset on a stage group (moves all its steps together with a 1-line diff). */
export function setGroupOffset(plan: Plan, groupId: string, offset: PlanOffset | null): Plan {
	const next = cleanOffset(offset);
	return {
		...plan,
		groups: plan.groups.map((g) => {
			if (g.id !== groupId) return g;
			const { offset: _old, ...rest } = g;
			return (next ? { ...rest, offset: next } : rest) as PlanGroup;
		}),
	};
}

/** Clears all manual node/stage offsets and edge wire tweaks so the chart returns cleanly to pure auto-layout. */
export function resetPlanLayout(plan: Plan): Plan {
	return {
		...plan,
		groups: plan.groups.map((g) => {
			if (!g.offset) return g;
			const { offset: _old, ...rest } = g;
			return rest as PlanGroup;
		}),
		nodes: plan.nodes.map((n) => {
			if (!n.offset) return n;
			const { offset: _old, ...rest } = n;
			return rest as PlanNode;
		}),
		edges: plan.edges.map((e) => {
			if (!e.route) return e;
			const { route: _old, ...rest } = e;
			return rest as PlanEdge;
		}),
	};
}

/** Whether any node, stage group, or edge carries manual layout tweaks for the active direction. */
export function hasManualLayout(plan: Plan, dir: "DOWN" | "RIGHT" = "DOWN"): boolean {
	const matches = (o?: PlanOffset) =>
		Boolean(o && Number.isFinite(o.x) && Number.isFinite(o.y) && (o.dir ?? "DOWN") === dir && (Math.abs(o.x) >= 2 || Math.abs(o.y) >= 2));
	return (
		plan.nodes.some((n) => matches(n.offset)) ||
		plan.groups.some((g) => matches(g.offset)) ||
		plan.edges.some((e) => Boolean(e.route && Object.keys(e.route).length > 0))
	);
}

const pruneGroups = (plan: Plan): Plan => ({ ...plan, groups: plan.groups.filter((g) => plan.nodes.some((n) => n.group === g.id)) });

/** Puts a node in the named group (a region in the code), or takes it out with an empty name. */
export function setGroup(plan: Plan, id: string, name: string): Plan {
	const wanted = name.trim();
	const existing = plan.groups.find((g) => g.name.toLowerCase() === wanted.toLowerCase());
	const group = !wanted ? undefined : (existing ?? { id: nextId(plan, "g"), name: wanted });
	const nodes = plan.nodes.map((n) => {
		if (n.id !== id) return n;
		const { group: _old, ...rest } = n;
		return (group ? { ...rest, group: group.id } : rest) as PlanNode;
	});
	return pruneGroups({ ...plan, nodes, groups: group && !existing ? [...plan.groups, group] : plan.groups });
}

// --- the check: no agent, no cost ------------------------------------------------

export type Finding = { severity: "error" | "warning" | "info"; code: string; message: string; node?: string; edge?: { from: string; to: string }; field?: string };

export function checkPlan(plan: Plan): Finding[] {
	const out: Finding[] = [];
	const add = (severity: Finding["severity"], code: string, message: string, at: Pick<Finding, "node" | "edge"> = {}) => out.push({ severity, code, message, ...at });
	const ids = new Set<string>();
	for (const n of plan.nodes) {
		if (ids.has(n.id)) add("error", "plan-duplicate-id", `Two nodes share the id ${n.id}.`, { node: n.id });
		ids.add(n.id);
	}
	const starts = plan.nodes.filter((n) => n.kind === "start");
	if (!starts.length) add("warning", "plan-no-start", "The plan has no start.");
	if (starts.length > 1) add("warning", "plan-many-starts", "The plan has more than one start.", { node: starts[1]!.id });
	if (!plan.nodes.some((n) => n.kind === "end")) add("warning", "plan-no-end", "The plan has no end.");
	for (const e of plan.edges) {
		for (const id of [e.from, e.to]) if (!ids.has(id)) add("error", "plan-bad-edge", `An edge names ${id}, which is not a node.`, { edge: { from: e.from, to: e.to } });
	}
	const reachable = new Set(starts.map((n) => n.id));
	for (const id of reachable) for (const e of outOf(plan, id)) reachable.add(e.to);
	const label = (n: PlanNode) => `"${n.text}"`;
	const groups = new Set(plan.groups.map((g) => g.id));
	for (const n of plan.nodes) {
		const at = { node: n.id };
		const outs = outOf(plan, n.id);
		const text = typeof n.text === "string" ? n.text.trim() : "";
		const ref = typeof n.ref === "string" ? n.ref.trim() : "";
		if (!text) add("warning", "plan-empty-text", `Node ${n.id} says nothing.`, at);
		if (starts.length && !reachable.has(n.id)) add("warning", "plan-unreachable", `Nothing leads to ${label(n)}.`, at);
		if (n.kind !== "end" && !outs.length) add("warning", "plan-dead-end", `${label(n)} leads nowhere.`, at);
		if (n.kind === "end" && outs.length) add("warning", "plan-end-continues", `${label(n)} is an end, but the flow continues from it.`, at);
		if (n.kind === "start" && into(plan, n.id).length) add("warning", "plan-start-entered", `${label(n)} is a start, but the flow comes back to it.`, at);
		if (n.kind === "call" && !ref) add("warning", "plan-call-no-ref", `${label(n)} does not say what it calls.`, at);
		if (n.group && !groups.has(n.group)) add("warning", "plan-unknown-group", `${label(n)} names a group that does not exist.`, at);
		if (n.kind === "decision") {
			if (outs.length < 2) add("warning", "plan-one-way-decision", `The decision ${label(n)} has ${outs.length ? "one way" : "no way"} out.`, at);
			for (const e of outs) {
				const edgeLabel = typeof e.label === "string" ? e.label.trim() : "";
				if (!edgeLabel) add("warning", "plan-unlabelled-branch", `A branch of the decision ${label(n)} has no label.`, { edge: { from: e.from, to: e.to } });
			}
		}
	}
	return out;
}

/** Call nodes whose `ref` the language server does not know, by the caller's test. */
export function checkRefs(plan: Plan, known: (ref: string) => boolean): Finding[] {
	return plan.nodes
		.filter((n) => n.kind === "call" && typeof n.ref === "string" && n.ref.trim() && !known(n.ref))
		.map((n) => ({ severity: "warning" as const, code: "plan-unresolved-ref", message: `Nothing in the workspace is called ${n.ref}.`, node: n.id }));
}

// --- between the chart and its text ------------------------------------------------

type ScannedPlanJson = {
	topFields: Map<string, number>;
	nodes: { id: string; idLine: number; startLine: number; endLine: number }[];
	edges: { from: string; to: string; line: number; startLine: number; endLine: number }[];
	nodesRange: { startLine: number; endLine: number } | null;
};

type JsonFrame = {
	type: "object" | "array";
	section?: "root" | "nodes-array" | "node-obj" | "edges-array" | "edge-obj";
	expectKey?: boolean;
	pendingKey?: string;
	startLine: number;
	nodeId?: string;
	nodeIdLine?: number;
	edgeFrom?: string;
	edgeTo?: string;
	edgeFromLine?: number;
};

/** Structural JSON scanner tracking brace/bracket depth and line numbers regardless of indentation or field order. */
function scanPlanJson(text: string): ScannedPlanJson {
	const topFields = new Map<string, number>();
	const nodes: ScannedPlanJson["nodes"] = [];
	const edges: ScannedPlanJson["edges"] = [];
	let nodesRange: ScannedPlanJson["nodesRange"] = null;
	let seenNodesArray = false;
	let seenEdgesArray = false;
	const stack: JsonFrame[] = [];

	let i = 0;
	let line = 1;
	const len = text.length;

	const skipWs = () => {
		while (i < len) {
			const c = text.charCodeAt(i);
			if (c === 10) {
				line++;
				i++;
			} else if (c === 32 || c === 9 || c === 13) {
				i++;
			} else break;
		}
	};

	const readString = (): { value: string; line: number } => {
		const start = i;
		const startLine = line;
		i++; // opening quote
		while (i < len) {
			const c = text.charCodeAt(i);
			if (c === 92) {
				// backslash escape
				i++;
				if (i < len) {
					if (text.charCodeAt(i) === 10) line++;
					i++;
				}
			} else if (c === 34) {
				i++;
				break;
			} else {
				if (c === 10) line++;
				i++;
			}
		}
		const raw = text.slice(start, i);
		try {
			return { value: JSON.parse(raw), line: startLine };
		} catch {
			return { value: raw.slice(1, raw.endsWith('"') ? -1 : undefined), line: startLine };
		}
	};

	while (i < len) {
		skipWs();
		if (i >= len) break;
		const ch = text[i]!;
		const top = stack[stack.length - 1];

		if (ch === '"') {
			const tok = readString();
			if (top?.type === "object") {
				if (top.expectKey) {
					skipWs();
					if (text[i] === ":") {
						i++;
						top.pendingKey = tok.value;
						top.expectKey = false;
						if (top.section === "root" && !topFields.has(tok.value)) topFields.set(tok.value, tok.line);
					}
				} else {
					if (top.section === "node-obj" && top.pendingKey === "id" && top.nodeId === undefined) {
						top.nodeId = tok.value;
						top.nodeIdLine = tok.line;
					} else if (top.section === "edge-obj") {
						if (top.pendingKey === "from" && top.edgeFrom === undefined) {
							top.edgeFrom = tok.value;
							top.edgeFromLine = tok.line;
						} else if (top.pendingKey === "to" && top.edgeTo === undefined) {
							top.edgeTo = tok.value;
						}
					}
					top.pendingKey = undefined;
				}
			}
			continue;
		}

		if (ch === "{") {
			i++;
			if (!top) {
				stack.push({ type: "object", section: "root", expectKey: true, startLine: line });
			} else if (top.type === "array" && top.section === "nodes-array") {
				stack.push({ type: "object", section: "node-obj", expectKey: true, startLine: line });
			} else if (top.type === "array" && top.section === "edges-array") {
				stack.push({ type: "object", section: "edge-obj", expectKey: true, startLine: line });
			} else {
				if (top.type === "object") top.pendingKey = undefined;
				stack.push({ type: "object", expectKey: true, startLine: line });
			}
			continue;
		}

		if (ch === "}") {
			i++;
			const closed = stack.pop();
			if (closed?.section === "node-obj" && closed.nodeId !== undefined) {
				nodes.push({ id: closed.nodeId, idLine: closed.nodeIdLine!, startLine: closed.startLine, endLine: line });
			} else if (closed?.section === "edge-obj" && closed.edgeFrom !== undefined && closed.edgeTo !== undefined) {
				edges.push({ from: closed.edgeFrom, to: closed.edgeTo, line: closed.edgeFromLine ?? closed.startLine, startLine: closed.startLine, endLine: line });
			}
			continue;
		}

		if (ch === "[") {
			i++;
			if (top?.type === "object" && top.section === "root" && top.pendingKey === "nodes" && !seenNodesArray) {
				seenNodesArray = true;
				nodesRange = { startLine: line, endLine: Number.MAX_SAFE_INTEGER };
				top.pendingKey = undefined;
				stack.push({ type: "array", section: "nodes-array", startLine: line });
			} else if (top?.type === "object" && top.section === "root" && top.pendingKey === "edges" && !seenEdgesArray) {
				seenEdgesArray = true;
				top.pendingKey = undefined;
				stack.push({ type: "array", section: "edges-array", startLine: line });
			} else {
				if (top?.type === "object") top.pendingKey = undefined;
				stack.push({ type: "array", startLine: line });
			}
			continue;
		}

		if (ch === "]") {
			i++;
			const closed = stack.pop();
			if (closed?.section === "nodes-array" && nodesRange) {
				nodesRange.endLine = line;
			}
			continue;
		}

		if (ch === ",") {
			i++;
			if (top?.type === "object") {
				top.expectKey = true;
				top.pendingKey = undefined;
			}
			continue;
		}

		if (ch === ":") {
			i++;
			continue;
		}

		// Primitive token (number, boolean, null)
		while (i < len && !/[\s,:\[\]{}"]/.test(text[i]!)) i++;
		if (top?.type === "object") top.pendingKey = undefined;
	}

	if (nodesRange && nodesRange.endLine === Number.MAX_SAFE_INTEGER) nodesRange.endLine = line;
	return { topFields, nodes, edges, nodesRange };
}

/** Each node's 1-based line in the plan's text. */
export function nodeLines(text: string, plan: Plan): Map<string, number> {
	const ids = new Set(plan.nodes.map((n) => n.id));
	const result = new Map<string, number>();
	for (const entry of scanPlanJson(text).nodes) {
		if (ids.has(entry.id) && !result.has(entry.id)) result.set(entry.id, entry.idLine);
	}
	return result;
}

/** The node whose lines hold the text cursor: the chart's selection. */
export function nodeAtLine(text: string, plan: Plan, line: number): string | null {
	const ids = new Set(plan.nodes.map((n) => n.id));
	const scanned = scanPlanJson(text);
	if (!scanned.nodesRange || line < scanned.nodesRange.startLine || line > scanned.nodesRange.endLine) return null;
	for (const entry of scanned.nodes) {
		if (ids.has(entry.id) && line >= entry.startLine && line <= entry.endLine) return entry.id;
	}
	return null;
}

/** Where a finding points in the text. */
export function findingLine(text: string, plan: Plan, finding: Finding): number {
	const scanned = scanPlanJson(text);
	if (finding.node) {
		const ids = new Set(plan.nodes.map((n) => n.id));
		const hit = scanned.nodes.find((entry) => entry.id === finding.node && ids.has(entry.id)) ?? scanned.nodes.find((entry) => entry.id === finding.node);
		return hit?.idLine ?? 1;
	}
	if (finding.edge) {
		const { from, to } = finding.edge;
		const hit = scanned.edges.find((e) => e.from === from && e.to === to);
		if (hit) return hit.line;
	}
	if (finding.field) {
		const hit = scanned.topFields.get(finding.field);
		if (hit) return hit;
	}
	return 1;
}
