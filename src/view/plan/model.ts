// A plan: a process or script designed as a flow chart, in plain words, kept
// as `design/<name>.plan.json` (ADR 0005). The chart is a view of this text;
// every chart edit is a text edit, so one undo history serves both. No SSL is
// read or written here (ADR 0003).

export type NodeKind = "start" | "end" | "step" | "decision" | "call";
export type PlanNode = { id: string; kind: NodeKind; text: string; ref?: string; group?: string; notes?: string; [key: string]: unknown };
export type PlanEdge = { from: string; to: string; label?: string; [key: string]: unknown };
export type PlanGroup = { id: string; name: string; [key: string]: unknown };
/** Fields this version does not know are kept as they are. */
export type Plan = { version: number; title: string; groups: PlanGroup[]; nodes: PlanNode[]; edges: PlanEdge[]; [key: string]: unknown };

const KINDS = new Set<string>(["start", "end", "step", "decision", "call"]);
const isObject = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

/** Dragged from the Objects panel to make a call node. */
export const PROCEDURE_DRAG = "application/x-ssl-procedure";

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
	const groups = raw.groups ?? [];
	if (!Array.isArray(raw.nodes) || !Array.isArray(raw.edges) || !Array.isArray(groups)) return { error: '"nodes" and "edges" must be lists.' };
	for (const n of raw.nodes) {
		if (!isObject(n) || typeof n.id !== "string" || typeof n.text !== "string") return { error: 'Each node needs an "id" and a "text".' };
		if (!KINDS.has(String(n.kind))) return { error: `Node ${n.id} has an unknown kind: ${JSON.stringify(n.kind)}.` };
	}
	for (const e of raw.edges) if (!isObject(e) || typeof e.from !== "string" || typeof e.to !== "string") return { error: 'Each edge needs a "from" and a "to".' };
	for (const g of groups) if (!isObject(g) || typeof g.id !== "string" || typeof g.name !== "string") return { error: 'Each group needs an "id" and a "name".' };
	return { plan: { ...raw, title: typeof raw.title === "string" ? raw.title : "", groups } as Plan };
}

const row = (value: Record<string, unknown>, first: string[]) => {
	const keys = [...first.filter((k) => value[k] !== undefined), ...Object.keys(value).filter((k) => !first.includes(k))];
	return `{ ${keys.map((k) => `${JSON.stringify(k)}: ${JSON.stringify(value[k])}`).join(", ")} }`;
};
const rows = (name: string, list: Record<string, unknown>[], first: string[]) =>
	list.length ? `  ${JSON.stringify(name)}: [\n${list.map((item) => `    ${row(item, first)}`).join(",\n")}\n  ]` : `  ${JSON.stringify(name)}: []`;

/** One node or edge a line, in a stable order, so a change shows as a small diff. */
export function printPlan(plan: Plan): string {
	const { version, title, goal, targets, groups, nodes, edges, ...rest } = plan;
	const head = { version, title, goal, targets };
	const lines = [
		...Object.entries(head)
			.filter(([, v]) => v !== undefined)
			.map(([k, v]) => `  ${JSON.stringify(k)}: ${JSON.stringify(v)}`),
		rows("groups", groups, ["id", "name"]),
		rows("nodes", nodes, ["id", "kind", "text", "ref", "group", "notes"]),
		rows("edges", edges, ["from", "to", "label"]),
		...Object.entries(rest).map(([k, v]) => JSON.stringify({ [k]: v }, null, 2).split("\n").slice(1, -1).join("\n")),
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
	const used = new Set(outOf(plan, id).map((e) => e.label?.toLowerCase()));
	if (!used.has("yes")) return "yes";
	if (!used.has("no")) return "no";
	return `option ${used.size + 1}`;
}

function make(plan: Plan, kind: NodeKind, text: string, near?: PlanNode, ref?: string): PlanNode {
	return { id: nextId(plan), kind, text, ...(ref ? { ref } : {}), ...(near?.group ? { group: near.group } : {}) };
}

/** The next step: takes over the selected node's way out, or comes before an end. */
export function addAfter(plan: Plan, id: string, kind: NodeKind = "step", text = "New step", ref?: string): Edit {
	const at = nodeOf(plan, id);
	if (!at) return { plan };
	if (at.kind === "decision") return addBranch(plan, id, kind, text, ref) ?? { plan };
	const node = make(plan, kind, text, at, ref);
	const edges =
		at.kind === "end"
			? [...plan.edges.map((e) => (e.to === id ? { ...e, to: node.id } : e)), { from: node.id, to: id }]
			: [...plan.edges.map((e) => (e.from === id ? { ...e, from: node.id } : e)), { from: id, to: node.id }];
	return { plan: { ...plan, nodes: [...plan.nodes, node], edges }, select: node.id };
}

/** Another way out. A step becomes a decision; the new branch runs to the first end. */
export function addBranch(plan: Plan, id: string, kind: NodeKind = "step", text = "New step", ref?: string): Edit | null {
	const at = nodeOf(plan, id);
	if (!at || (at.kind !== "step" && at.kind !== "decision")) return null;
	const node = make(plan, kind, text, at, ref);
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
		plan: { ...after, nodes: [...nodes, node], edges: [...edges, { from: id, to: node.id, label: nextLabel(after, id) }, ...(end ? [{ from: node.id, to: end.id }] : [])] },
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
	if (ins.length === 1 && outs.length === 1 && !edges.some((e) => e.from === ins[0]!.from && e.to === outs[0]!.to)) edges.push({ ...ins[0]!, to: outs[0]!.to });
	return { plan: pruneGroups({ ...plan, nodes: plan.nodes.filter((n) => n.id !== id), edges }), select: ins[0]?.from ?? outs[0]?.to };
}

export const setText = (plan: Plan, id: string, text: string): Plan => ({ ...plan, nodes: plan.nodes.map((n) => (n.id === id ? { ...n, text } : n)) });

export function setDecision(plan: Plan, id: string, on: boolean): Plan {
	return { ...plan, nodes: plan.nodes.map((n) => (n.id === id && (n.kind === "step" || n.kind === "decision") ? { ...n, kind: on ? "decision" : "step" } : n)) };
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

export type Finding = { severity: "error" | "warning"; code: string; message: string; node?: string; edge?: { from: string; to: string } };

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
		if (!n.text.trim()) add("warning", "plan-empty-text", `Node ${n.id} says nothing.`, at);
		if (starts.length && !reachable.has(n.id)) add("warning", "plan-unreachable", `Nothing leads to ${label(n)}.`, at);
		if (n.kind !== "end" && !outs.length) add("warning", "plan-dead-end", `${label(n)} leads nowhere.`, at);
		if (n.kind === "end" && outs.length) add("warning", "plan-end-continues", `${label(n)} is an end, but the flow continues from it.`, at);
		if (n.kind === "start" && into(plan, n.id).length) add("warning", "plan-start-entered", `${label(n)} is a start, but the flow comes back to it.`, at);
		if (n.kind === "call" && !n.ref?.trim()) add("warning", "plan-call-no-ref", `${label(n)} does not say what it calls.`, at);
		if (n.group && !groups.has(n.group)) add("warning", "plan-unknown-group", `${label(n)} names a group that does not exist.`, at);
		if (n.kind === "decision") {
			if (outs.length < 2) add("warning", "plan-one-way-decision", `The decision ${label(n)} has ${outs.length ? "one way" : "no way"} out.`, at);
			for (const e of outs) if (!e.label?.trim()) add("warning", "plan-unlabelled-branch", `A branch of the decision ${label(n)} has no label.`, { edge: { from: e.from, to: e.to } });
		}
	}
	return out;
}

/** Call nodes whose `ref` the language server does not know, by the caller's test. */
export function checkRefs(plan: Plan, known: (ref: string) => boolean): Finding[] {
	return plan.nodes
		.filter((n) => n.kind === "call" && n.ref?.trim() && !known(n.ref))
		.map((n) => ({ severity: "warning" as const, code: "plan-unresolved-ref", message: `Nothing in the workspace is called ${n.ref}.`, node: n.id }));
}

// --- between the chart and its text ------------------------------------------------

/** Each node's 1-based line in the plan's text. */
export function nodeLines(text: string, plan: Plan): Map<string, number> {
	const lines = text.split(/\r?\n/);
	const result = new Map<string, number>();
	const start = lines.findIndex((l) => /^\s*"nodes"\s*:/.test(l));
	if (start < 0) return result;
	const ids = new Set(plan.nodes.map((n) => n.id));
	for (let i = start; i < lines.length; i++) {
		if (i > start && /^\s{0,2}"\w+"\s*:/.test(lines[i]!)) break;
		for (const m of lines[i]!.matchAll(/"id"\s*:\s*"([^"]*)"/g)) if (ids.has(m[1]!) && !result.has(m[1]!)) result.set(m[1]!, i + 1);
	}
	return result;
}

/** The node whose lines hold the text cursor: the chart's selection. */
export function nodeAtLine(text: string, plan: Plan, line: number): string | null {
	let found: string | null = null;
	let best = 0;
	const lines = nodeLines(text, plan);
	for (const [id, at] of lines) if (at <= line && at > best) (found = id), (best = at);
	if (!found) return null;
	// Past the nodes list, the cursor is on something else.
	const all = text.split(/\r?\n/);
	for (let i = best; i < line && i < all.length; i++) if (/^\s{0,2}"\w+"\s*:/.test(all[i]!)) return null;
	return found;
}

/** Where a finding points in the text. */
export function findingLine(text: string, plan: Plan, finding: Finding): number {
	if (finding.node) return nodeLines(text, plan).get(finding.node) ?? 1;
	if (finding.edge) {
		const { from, to } = finding.edge;
		const lines = text.split(/\r?\n/);
		const at = lines.findIndex((l) => l.includes(`"from": "${from}"`) && l.includes(`"to": "${to}"`));
		if (at >= 0) return at + 1;
	}
	return 1;
}
