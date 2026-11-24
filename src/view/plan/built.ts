// What a plan remembers once its code is accepted (planning mode, after the build): which
// procedures carry which nodes, and what each node said then. From that come the links,
// the drift report, and knowing what a changed chart needs rebuilt. Once built the code is
// the source of truth (ADR 0005): differences are reported, never repaired. Pure, and
// nothing here reads SSL (ADR 0003): procedures and calls are the server's.
import { hashText, planHash, type SpecUnit } from "./assist";
import { lastPart, requiredCalls, scriptOf, type BuildRun, type BuildUnit } from "./build";
import { planTestsOf, type Finding, type Plan, type PlanNode } from "./model";

export type BuiltUnit = { name: string; script: string; parameters?: string[]; nodes: string[]; calls: string[] };
/** Kept in the plan's text under "built". Not part of `planHash`: recording a build does not make its spec stale. */
export type Built = { units: BuiltUnit[]; nodes: Record<string, string>; tests?: { script: string; hash: string } };

const isObject = (v: unknown): v is Record<string, any> => typeof v === "object" && v !== null && !Array.isArray(v);
const strings = (v: unknown): string[] => (Array.isArray(v) ? v.filter((s): s is string => typeof s === "string") : []);
const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

/** What the plan says is built, if anything. A hand edit that no longer reads counts as nothing built. */
export function builtOf(plan: Plan): Built | null {
	const raw = plan.built;
	if (!isObject(raw) || !Array.isArray(raw.units) || !isObject(raw.nodes)) return null;
	const units: BuiltUnit[] = raw.units
		.filter((u): u is Record<string, any> => isObject(u) && typeof u.name === "string" && typeof u.script === "string")
		.map((u) => ({
			...u,
			name: u.name,
			script: u.script,
			parameters: Array.isArray(u.parameters) ? u.parameters.filter((p): p is string => typeof p === "string") : [],
			nodes: strings(u.nodes),
			calls: strings(u.calls),
		}));
	const tests =
		isObject(raw.tests) && typeof raw.tests.script === "string"
			? { script: raw.tests.script, hash: typeof raw.tests.hash === "string" ? raw.tests.hash : "" }
			: undefined;
	if (!units.length && !tests) return null;
	const { tests: _rawTests, ...rest } = raw;
	return { ...rest, units, nodes: raw.nodes, ...(tests ? { tests } : {}) } as Built;
}

/**
 * A node as a build sees it: what the chart says of it. Its group only files the code. An answer does
 * not count either: "leave it as it is" must not rewrite it. What a step must newly do goes in its notes.
 */
export function nodePrint(plan: Plan, id: string): string {
	const node = plan.nodes.find((n) => n.id === id);
	const out = plan.edges.filter((e) => e.from === id).map((e) => `${e.to}|${e.label ?? ""}`).sort();
	return hashText(JSON.stringify([node?.kind, node?.text, node?.ref ?? "", node?.notes ?? "", out]));
}

export type Changes = { changed: string[]; added: string[]; removed: string[] };
const NONE: Changes = { changed: [], added: [], removed: [] };

/** How the chart has moved on from what was built. */
export function changesSince(plan: Plan): Changes {
	const built = builtOf(plan);
	if (!built) return NONE;
	const ids = new Set(plan.nodes.map((n) => n.id));
	return {
		changed: plan.nodes.filter((n) => built.nodes[n.id] && built.nodes[n.id] !== nodePrint(plan, n.id)).map((n) => n.id),
		added: plan.nodes.filter((n) => !built.nodes[n.id]).map((n) => n.id),
		removed: Object.keys(built.nodes).filter((id) => !ids.has(id)),
	};
}

/** The same, for the chart to show: while a run of this very chart is open, what it has not reached yet is not a change. */
export const chartChanges = (plan: Plan, run: BuildRun | null | undefined): Changes => (run && run.planHash === planHash(plan) ? NONE : changesSince(plan));

export const anyChanges = (c: Changes) => c.changed.length + c.added.length + c.removed.length > 0;

/** Built nodes a changed chart has not touched: a new spec need not say what becomes of them. */
export function settledNodes(plan: Plan): string[] {
	const built = builtOf(plan);
	if (!built) return [];
	const { changed } = changesSince(plan);
	return plan.nodes.filter((n) => built.nodes[n.id] && !changed.includes(n.id)).map((n) => n.id);
}

const refsIn = (plan: Plan, nodes: string[]) =>
	plan.nodes.filter((n) => nodes.includes(n.id) && n.kind === "call" && typeof n.ref === "string" && n.ref.trim()).map((n) => n.ref!);

/**
 * Sorts a new run against what is built, so only what the chart changed is rebuilt. SSL Studio
 * decides this, not the agent: a unit whose steps are untouched is kept, listed in the spec or not.
 */
export function classifyUnits(run: BuildRun, plan: Plan, moved: Record<string, string> = {}) {
	const built = builtOf(plan);
	if (!built) return;
	const changes = changesSince(plan);
	const touched = new Set([...changes.changed, ...changes.added, ...changes.removed]);
	for (const unit of run.units) {
		const prior = built.units.find((u) => same(u.name, unit.name));
		if (!prior) continue;
		unit.script = moved[prior.name] ?? prior.script;
		const nodes = [...new Set([...prior.nodes, ...(unit.nodes ?? [])])];
		const known = new Set([...prior.calls, ...refsIn(plan, prior.nodes)].map(lastPart));
		const wants = requiredCalls(unit, plan, [...run.units, ...built.units]).filter((c) => !same(lastPart(c), unit.name));
		const parameters = (list?: string[]) => (list ?? []).join(",").toLowerCase();
		if (nodes.some((n) => touched.has(n)) || (unit.parameters && parameters(unit.parameters) !== parameters(prior.parameters)) || wants.some((c) => !known.has(lastPart(c)))) unit.change = true;
		else unit.status = "kept";
	}
	for (const prior of built.units) if (!run.units.some((u) => same(u.name, prior.name))) run.units.push({ ...prior, script: moved[prior.name] ?? prior.script, status: "kept", attempts: 0 });
	// What was settled before, a start or an end with no unit of its own, is still accounted for.
	for (const node of settledNodes(plan)) if (!run.map.some((m) => m.node === node)) run.map.push({ node, becomes: "built earlier, and untouched" });
}

/** Records accepted units: the plan's links, and each node as it stood. A node belongs to the unit that last built it. */
export function recordBuilt(plan: Plan, accepted: BuildUnit[], all: SpecUnit[]): Plan {
	const built = builtOf(plan) ?? { units: [], nodes: {} };
	const claimed = new Set(accepted.flatMap((u) => u.nodes ?? []));
	const units: BuiltUnit[] = built.units.map((u) => ({ ...u, nodes: u.nodes.filter((n) => !claimed.has(n)) }));
	const names = new Set(all.map((u) => lastPart(u.name)));
	for (const unit of accepted) {
		const record: BuiltUnit = {
			name: unit.name,
			script: scriptOf(unit, plan),
			...(unit.parameters ? { parameters: unit.parameters } : {}),
			nodes: unit.nodes ?? [],
			calls: requiredCalls(unit, plan, all).filter((c) => names.has(lastPart(c)) && !same(lastPart(c), unit.name)),
		};
		const at = units.findIndex((u) => same(u.name, unit.name));
		if (at >= 0) units[at] = record;
		else units.push(record);
	}
	const nodes = { ...built.nodes };
	for (const id of claimed) if (plan.nodes.some((n) => n.id === id)) nodes[id] = nodePrint(plan, id);
	return { ...plan, built: { ...built, units, nodes } };
}

/** The whole run is accepted: what the spec only described is settled too, and removed nodes are forgotten. */
export function settleBuilt(plan: Plan, run: BuildRun): Plan {
	const built = builtOf(plan) ?? { units: [], nodes: {} };
	const ids = new Set(plan.nodes.map((n) => n.id));
	const nodes: Record<string, string> = {};
	for (const [id, print] of Object.entries(built.nodes)) if (ids.has(id)) nodes[id] = print;
	for (const { node } of run.map) if (ids.has(node)) nodes[node] = nodePrint(plan, node);
	return { ...plan, built: { ...built, units: built.units.map((u) => ({ ...u, nodes: u.nodes.filter((n) => ids.has(n)) })), nodes } };
}

export const recordTests = (plan: Plan, script: string): Plan => ({ ...plan, built: { ...(builtOf(plan) ?? { units: [], nodes: {} }), tests: { script, hash: planHash(plan) } } });

/** The procedures that carry a node. */
export const unitsOfNode = (plan: Plan, id: string): BuiltUnit[] => (builtOf(plan)?.units ?? []).filter((u) => u.nodes.includes(id));

export type NodeCodeDetails = {
	units: BuiltUnit[];
	scripts: string[];
	/** Direct reference on the node (e.g. an existing workspace procedure), if distinct from its implementing unit name. */
	primaryRef: string | null;
	/** Called / referenced procedures involved with this node (primaryRef first, then implementing unit calls, deduplicated). */
	calls: string[];
	/** How many other nodes in the plan share the same implementing procedure(s). */
	sharedCount: number;
};

/** Summarizes the scripts, implementing functions, and called functions behind any step or decision node. */
export function nodeCodeDetails(plan: Plan, node: PlanNode): NodeCodeDetails {
	const units = unitsOfNode(plan, node.id);
	const scripts = [...new Set(units.map((u) => u.script).filter(Boolean))];
	const unitNames = new Set(units.map((u) => lastPart(u.name).toLowerCase()));
	const rawRef = typeof node.ref === "string" ? node.ref.trim() : "";
	const primaryRef = rawRef && !unitNames.has(lastPart(rawRef).toLowerCase()) ? rawRef : null;
	const calls: string[] = [];
	const seen = new Set<string>();
	const addCall = (target: string) => {
		const trimmed = target.trim();
		if (!trimmed) return;
		const key = lastPart(trimmed).toLowerCase();
		if (seen.has(key) || unitNames.has(key)) return;
		seen.add(key);
		calls.push(trimmed);
	};
	if (primaryRef) addCall(primaryRef);
	for (const u of units) for (const c of u.calls) addCall(c);
	const validIds = new Set(plan.nodes.map((n) => n.id));
	const peers = new Set<string>();
	for (const u of units) for (const nid of u.nodes) if (nid !== node.id && validIds.has(nid)) peers.add(nid);
	return { units, scripts, primaryRef, calls, sharedCount: peers.size };
}

// --- drift: the chart against the code --------------------------------------------------

export type Reading = { name: string; procedures: { name: string; line: number }[]; edges: { from: string; target: string; resolved: boolean }[] };
export type Drift = { kind: "gone" | "moved" | "missing-call" | "extra-call" | "orphan"; unit: string; node?: string; message: string; severity: "warning" | "info" };

/**
 * What differs between what the chart says and what the server sees. A chart's edge is order,
 * not a call: Mark then Notify may both be called by Release. So what must show as a call is
 * what a call node names, and what the spec said one unit calls of another.
 */
export function driftOf(plan: Plan, readings: Map<string, Reading | null>, moved: Record<string, string> = {}): Drift[] {
	const out: Drift[] = [];
	const ids = new Set(plan.nodes.map((n) => n.id));
	const text = (id?: string) => plan.nodes.find((n) => n.id === id)?.text;
	for (const unit of builtOf(plan)?.units ?? []) {
		const nodes = unit.nodes.filter((n) => ids.has(n));
		const node = nodes[0];
		const script = moved[unit.name] ?? unit.script;
		const reading = readings.get(script);
		const procedure = reading?.procedures.find((p) => same(p.name, unit.name));
		if (!procedure) {
			out.push({ kind: "gone", unit: unit.name, node, severity: "warning", message: text(node) ? `The chart's "${text(node)}" was built as ${unit.name} in ${script}, and that procedure has gone.` : `${unit.name} was built in ${script}, and that procedure has gone.` });
			continue;
		}
		if (moved[unit.name]) out.push({ kind: "moved", unit: unit.name, node, severity: "info", message: `${unit.name} is now in ${script}; the chart recorded ${unit.script}.` });
		if (!nodes.length) out.push({ kind: "orphan", unit: unit.name, severity: "info", message: `${unit.name} no longer carries any step of the chart. Its code is still there, in ${script}.` });
		const made = (reading?.edges ?? []).filter((e) => same(e.from, unit.name));
		const expected = [...new Set([...refsIn(plan, nodes), ...unit.calls])];
		for (const target of expected) if (!same(lastPart(target), unit.name) && !made.some((e) => same(lastPart(e.target), lastPart(target)))) out.push({ kind: "missing-call", unit: unit.name, node: plan.nodes.find((n) => nodes.includes(n.id) && n.ref && same(lastPart(n.ref), lastPart(target)))?.id ?? node, severity: "warning", message: `The chart says ${unit.name} calls ${target}; the code does not.` });
		const named = new Set(expected.map(lastPart));
		const extras = new Set(made.filter((e) => e.resolved && !named.has(lastPart(e.target)) && !same(lastPart(e.target), unit.name)).map((e) => e.target));
		for (const target of extras) out.push({ kind: "extra-call", unit: unit.name, node, severity: "info", message: `${unit.name} also calls ${target}, which the chart does not show.` });
	}
	return out;
}

export const driftFindings = (drift: Drift[]): Finding[] => drift.map((d) => ({ severity: d.severity, code: `plan-drift-${d.kind}`, message: d.message, ...(d.node ? { node: d.node } : {}) }));

// --- what a changed chart asks of the spec and the units ---------------------------------

const describe = (plan: Plan, ids: string[]) => plan.nodes.filter((n) => ids.includes(n.id)).map((n: PlanNode) => `- ${n.id}: ${n.text}${n.notes ? ` (${n.notes})` : ""}`);

/** What a spec's prompt adds for a chart that is already built. */
export function revisionText(plan: Plan, spec: string | null): string | undefined {
	const built = builtOf(plan);
	if (!built?.units.length) return undefined;
	const { changed, added, removed } = changesSince(plan);
	return [
		"THIS IS A CHANGE TO WHAT IS ALREADY BUILT. The code below stays as it is unless the chart's changes need it to change. Revise the spec: keep what still holds, as it stands, and say what is different.",
		"In UNITS list only the procedures to write or change, using a built procedure's own name to change it. A built procedure you leave out is not touched. In MAP list only the nodes below.",
		"",
		"WHAT IS BUILT:",
		...built.units.map((u) => `${u.name}(${(u.parameters ?? []).join(", ")}) in ${u.script}, for nodes ${u.nodes.join(", ") || "none"}`),
		...(changed.length ? ["", "NODES THAT CHANGED:", ...describe(plan, changed)] : []),
		...(added.length ? ["", "NEW NODES:", ...describe(plan, added)] : []),
		...(removed.length ? ["", `NODES REMOVED: ${removed.join(", ")}. Say what becomes of their code in the spec; removing a procedure is left to the user.`] : []),
		...(spec ? ["", "THE SPEC AS APPROVED:", spec] : []),
	].join("\n");
}

/** What a unit's prompt adds when it edits a procedure that exists. */
export function changeText(plan: Plan, unit: BuildUnit, code: string): string {
	const { changed, added, removed } = changesSince(plan);
	const mine = (ids: string[]) => describe(plan, ids.filter((id) => unit.nodes?.includes(id)));
	const lines = [...mine(changed), ...mine(added)];
	return [
		`${unit.name} ALREADY EXISTS, as below. Change only what the chart's changes need, and keep the rest of it as it is. Reply with the whole of this procedure, its doc comment included.`,
		"```ssl",
		code,
		"```",
		...(lines.length ? ["WHAT CHANGED ON THE CHART:", ...lines] : []),
		...(removed.length ? [`STEPS TAKEN OFF THE CHART: ${removed.join(", ")}.`] : []),
	].join("\n");
}

// --- the test script ---------------------------------------------------------------------

export type PlanPath = { steps: { id: string; text: string; label?: string }[] };

export const MAX_PATHS = 24;
export const MAX_PATH_STEPS = 5000;

/** Every way through the chart: each is a test case. A loop is taken once, as each edge is used at most once on a path. */
export function planPaths(plan: Plan, limit = MAX_PATHS, maxSteps = MAX_PATH_STEPS): { paths: PlanPath[]; truncated: boolean } {
	const paths: PlanPath[] = [];
	let truncated = false;
	let visits = 0;
	const nodeById = new Map<string, PlanNode>();
	for (const n of plan.nodes) if (!nodeById.has(n.id)) nodeById.set(n.id, n);
	const outByFrom = new Map<string, typeof plan.edges>();
	for (const e of plan.edges) {
		if (!nodeById.has(e.from) || !nodeById.has(e.to)) continue;
		const list = outByFrom.get(e.from);
		if (list) list.push(e);
		else outByFrom.set(e.from, [e]);
	}
	const walk = (id: string, label: string | undefined, steps: PlanPath["steps"], used: Set<string>) => {
		if (truncated) return;
		if (++visits > maxSteps) {
			truncated = true;
			return;
		}
		const node = nodeById.get(id);
		if (!node) return;
		const here = [...steps, { id, text: node.text, ...(label ? { label } : {}) }];
		const out = (outByFrom.get(id) ?? []).filter((e) => !used.has(`${e.from}>${e.to}`));
		if (!out.length) {
			if (paths.length >= limit) truncated = true;
			else paths.push({ steps: here });
			return;
		}
		for (const e of out) {
			const edgeKey = `${e.from}>${e.to}`;
			used.add(edgeKey);
			walk(e.to, typeof e.label === "string" ? e.label : undefined, here, used);
			used.delete(edgeKey);
			if (truncated) return;
		}
	};
	for (const start of plan.nodes.filter((n) => n.kind === "start")) walk(start.id, undefined, [], new Set());
	return { paths, truncated };
}

export const pathLine = (path: PlanPath, i: number) => `Path ${i + 1}: ${path.steps.map((s) => `${s.label ? `(${s.label}) ` : ""}${s.text}`).join(" -> ")}`;

/** Shortens a step phrase cleanly at punctuation or a word boundary for scenario titles. */
export function shortPhrase(raw: string, max = 32): string {
	const text = raw.trim();
	if (text.length <= max) return text;
	// Prefer a clean clause break before a colon or comma when the lead clause already carries the meaning.
	const clause = text.search(/[:,]\s/);
	if (clause >= 12 && clause <= max) return text.slice(0, clause);
	const cut = text.slice(0, max);
	const space = cut.lastIndexOf(" ");
	return `${(space >= 10 ? cut.slice(0, space) : cut).trimEnd()}…`;
}

/**
 * Plain-English business summary of a flowchart journey: highlights the key
 * branch outcome steps (and distinguishing decision when multiple branches
 * converge on the same action), ending with the final outcome.
 */
export function pathSummary(path: PlanPath, all?: readonly PlanPath[], plan?: Plan): string {
	const steps = path.steps;
	if (!steps.length) return "Main flow";
	const kindById = new Map((plan?.nodes ?? []).map((n) => [n.id, n.kind]));
	const inBranchCount = new Map<string, number>();
	for (const e of plan?.edges ?? []) {
		if (e.label?.trim()) inBranchCount.set(e.to, (inBranchCount.get(e.to) ?? 0) + 1);
	}
	const lastStep = steps.at(-1)!;
	const endText = shortPhrase(lastStep.text, 32);

	// When comparing across all paths, ignore steps that appear in every single path.
	const commonIds = new Set<string>();
	if (all && all.length > 1) {
		const counts = new Map<string, number>();
		for (const p of all) for (const id of new Set(p.steps.map((s) => s.id))) counts.set(id, (counts.get(id) ?? 0) + 1);
		for (const [id, c] of counts) if (c === all.length) commonIds.add(id);
	}

	// Track which indices are loop exits (leaving a decision on its second visit in this path).
	const firstSeen = new Map<string, number>();
	const loopExitAt = new Set<number>();
	steps.forEach((s, i) => {
		if (i > 0 && s.label?.trim() && firstSeen.has(steps[i - 1]!.id) && firstSeen.get(steps[i - 1]!.id)! < i - 1) {
			loopExitAt.add(i);
		}
		if (!firstSeen.has(s.id)) firstSeen.set(s.id, i);
	});

	type Cand = { idx: number; id: string; text: string; loopExit: boolean };
	const rawCands: Cand[] = [];
	const seen = new Set<string>();
	for (let i = 1; i < steps.length - 1; i++) {
		const s = steps[i]!;
		if (!s.label?.trim()) continue;
		const kind = kindById.get(s.id);
		if (kind === "decision" || kind === "start" || kind === "end") continue;
		if (commonIds.has(s.id) || seen.has(s.id)) continue;
		seen.add(s.id);
		// If multiple decisions converge on this same step (e.g. two ways to skip), name the decision + choice so the cause is clear.
		const prev = steps[i - 1]!;
		const label =
			(inBranchCount.get(s.id) ?? 0) > 1
				? `${shortPhrase(prev.text.replace(/\?+$/, ""), 32)}: ${s.label.trim()}`
				: shortPhrase(s.text, 38);
		rawCands.push({ idx: i, id: s.id, text: label, loopExit: loopExitAt.has(i) });
	}

	// Drop intermediate setup steps when a deeper in-loop branch outcome immediately follows (without crossing a loop exit).
	const refined = rawCands.filter((c, pos) => {
		const nextCand = rawCands[pos + 1];
		if (!nextCand || nextCand.loopExit || nextCand.idx - c.idx > 3) return true;
		const between = steps.slice(c.idx + 1, nextCand.idx);
		const hasDecision = between.some((s) => kindById.get(s.id) === "decision" || s.text.trim().endsWith("?"));
		return !hasDecision;
	});

	// Drop a trailing loop-exit step (like "Commit the transaction") when we already captured an in-loop outcome right before it.
	const milestones = refined.filter((c, pos) => !(c.loopExit && pos > 0 && !refined[pos - 1]!.loopExit));

	// If a decision branched directly into the final end step with no milestone before it, name that decision + choice.
	if (!milestones.length) {
		const lastLabeledIdx = steps.findLastIndex((s) => Boolean(s.label?.trim()));
		if (lastLabeledIdx > 0) {
			const prev = steps[lastLabeledIdx - 1]!;
			const choice = steps[lastLabeledIdx]!.label!.trim();
			const lead = `${shortPhrase(prev.text, 28)} (${choice})`;
			return endText ? `${lead} · ${endText}` : lead;
		}
		return endText || "Main flow";
	}

	const parts = milestones.slice(0, 2).map((m) => m.text);
	if (endText && !parts.some((p) => p.toLowerCase() === endText.toLowerCase())) parts.push(endText);
	return parts.join(" · ");
}

/** Readable multi-line decision story for hovering a flowchart test path. */
export function pathStory(path: PlanPath): string {
	const lines: string[] = [];
	for (let i = 1; i < path.steps.length; i++) {
		const prev = path.steps[i - 1]!;
		const cur = path.steps[i]!;
		if (cur.label?.trim()) {
			lines.push(`${prev.text.trim()} -> ${cur.label.trim()}: ${cur.text.trim()}`);
		}
	}
	const last = path.steps.at(-1)?.text.trim();
	if (last && !lines.some((l) => l.endsWith(last))) lines.push(`Outcome: ${last}`);
	return lines.join("\n") || path.steps.map((s) => s.text.trim()).join(" -> ");
}

export type NodePathSummary = {
	/** 1-based path number across the plan (matches Path N in generated test scripts). */
	index: number;
	/** 0-based index into `planPaths(plan).paths`. */
	pathIndex: number;
	path: PlanPath;
	/** Outgoing branch label taken from this node on this path (e.g. "yes" or "no"). */
	branchOut?: string;
	summary: string;
	/** Detailed plain-English decision story for tooltips. */
	story: string;
	/** Other step/decision IDs exercised alongside this node on this path. */
	siblingIds: string[];
};

/** All flowchart test paths that pass through a given node, plus the sibling steps exercised with it. */
export function pathsForNode(
	plan: Plan,
	nodeId: string,
	all: { paths: PlanPath[]; truncated: boolean } = planPaths(plan),
): { total: number; truncated: boolean; matches: NodePathSummary[]; coTestedIds: string[] } {
	const kindById = new Map(plan.nodes.map((n) => [n.id, n.kind]));
	const matches: NodePathSummary[] = [];
	const coTested = new Set<string>();
	all.paths.forEach((path, pathIndex) => {
		const hits: number[] = [];
		path.steps.forEach((s, idx) => {
			if (s.id === nodeId) hits.push(idx);
		});
		if (!hits.length) return;
		let branchOut: string | undefined;
		for (const idx of hits) {
			const nextLabel = path.steps[idx + 1]?.label?.trim();
			if (nextLabel) {
				branchOut = nextLabel;
				break;
			}
		}
		const siblings: string[] = [];
		const seenSib = new Set<string>();
		for (const s of path.steps) {
			if (s.id === nodeId || seenSib.has(s.id)) continue;
			if (kindById.get(s.id) === "start") continue;
			seenSib.add(s.id);
			siblings.push(s.id);
			coTested.add(s.id);
		}
		matches.push({
			index: pathIndex + 1,
			pathIndex,
			path,
			...(branchOut ? { branchOut } : {}),
			summary: pathSummary(path, all.paths, plan),
			story: pathStory(path),
			siblingIds: siblings,
		});
	});
	return { total: all.paths.length, truncated: all.truncated, matches, coTestedIds: [...coTested] };
}

export type NodeTestRequirement = {
	nodeId: string;
	text: string;
	label: string;
};

export type NodeTestBranch = {
	label: string;
	targetId: string;
	targetText: string;
	count: number;
	pathIndices: number[];
};

export type NodeTestOutcome = {
	nodeId: string;
	text: string;
	count: number;
	pathIndices: number[];
};

export type NodeTestContext = {
	/** Invariant decision choices that always hold before reaching this step. */
	requires: NodeTestRequirement[];
	/** Decision governing the outcomes directly from this step (either the node itself or its immediate next decision). */
	branchDecision: { nodeId: string; text: string; isSelf: boolean } | null;
	/** Outgoing branch breakdown for `branchDecision` across journeys reaching this step. */
	branches: NodeTestBranch[];
	/** Distinct final end results reached by journeys through this step. */
	outcomes: NodeTestOutcome[];
};

/**
 * Plain-English test context for a single step/decision:
 * - what decisions must hold to reach it (`requires`)
 * - what branches directly follow it (`branchDecision` + `branches`)
 * - what final end results journeys through it can reach (`outcomes`)
 */
export function nodeTestContext(
	plan: Plan,
	nodeId: string,
	all: { paths: PlanPath[]; truncated: boolean } = planPaths(plan),
): NodeTestContext {
	const nodeById = new Map(plan.nodes.map((n) => [n.id, n]));
	const node = nodeById.get(nodeId);
	const { matches } = pathsForNode(plan, nodeId, all);
	if (!node || !matches.length) {
		return { requires: [], branchDecision: null, branches: [], outcomes: [] };
	}

	// 1. Invariant preconditions: decision choices that appear with the same label before first arrival at `nodeId`
	// on every journey through it (keeping the latest exit choice for looped decisions).
	const perMatchReqs = matches.map((m) => {
		const pos = m.path.steps.findIndex((s) => s.id === nodeId);
		const map = new Map<string, { text: string; label: string }>();
		for (let i = 1; i <= pos; i++) {
			const prev = m.path.steps[i - 1]!;
			const cur = m.path.steps[i]!;
			const label = cur.label?.trim();
			if (!label || prev.id === nodeId) continue;
			map.delete(prev.id);
			map.set(prev.id, { text: prev.text.trim() || prev.id, label });
		}
		return map;
	});
	const requires: NodeTestRequirement[] = [];
	const firstReqs = perMatchReqs[0]!;
	for (const [reqId, info] of firstReqs.entries()) {
		const want = info.label.toLowerCase();
		if (perMatchReqs.every((m) => m.get(reqId)?.label.toLowerCase() === want)) {
			requires.push({ nodeId: reqId, text: info.text, label: info.label });
		}
	}

	// 2. Governing branches: this decision's own outgoing branches, or the immediate next decision after a step/call
	// (ignoring loop-back edges to a decision already passed before reaching this step).
	let branchDecision: NodeTestContext["branchDecision"] = null;
	if (node.kind === "decision") {
		branchDecision = { nodeId: node.id, text: node.text.trim() || node.id, isSelf: true };
	} else if (node.kind !== "end") {
		const out = plan.edges.filter((e) => e.from === node.id);
		if (out.length === 1) {
			const next = nodeById.get(out[0]!.to);
			const isLoopBack =
				next &&
				matches.some((m) => {
					const pos = m.path.steps.findIndex((s) => s.id === nodeId);
					return pos > 0 && m.path.steps.slice(0, pos).some((s) => s.id === next.id);
				});
			if (next?.kind === "decision" && !isLoopBack) {
				branchDecision = { nodeId: next.id, text: next.text.trim() || next.id, isSelf: false };
			}
		}
	}
	const branches: NodeTestBranch[] = [];
	if (branchDecision) {
		const edges = plan.edges.filter((e) => e.from === branchDecision!.nodeId);
		const buckets: NodeTestBranch[] = edges.map((e) => ({
			label: e.label?.trim() || "(unlabelled)",
			targetId: e.to,
			targetText: nodeById.get(e.to)?.text.trim() || e.to,
			count: 0,
			pathIndices: [],
		}));
		for (const m of matches) {
			const startPos = m.path.steps.findIndex((s) => s.id === nodeId);
			const dPos = m.path.steps.findIndex((s, i) => i >= startPos && s.id === branchDecision!.nodeId);
			if (dPos < 0) continue;
			const nextStep = m.path.steps[dPos + 1];
			if (!nextStep) continue;
			const lbl = nextStep.label?.trim() || "(unlabelled)";
			const bucket =
				buckets.find((b) => b.targetId === nextStep.id && b.label.toLowerCase() === lbl.toLowerCase()) ??
				buckets.find((b) => b.targetId === nextStep.id);
			if (bucket) {
				bucket.count++;
				bucket.pathIndices.push(m.pathIndex);
			}
		}
		branches.push(...buckets);
	}

	// 3. Distinct final end outcomes reachable from journeys through this step.
	const outcomeMap = new Map<string, NodeTestOutcome>();
	for (const m of matches) {
		const last = m.path.steps.at(-1);
		if (!last) continue;
		const endNode = nodeById.get(last.id);
		if (endNode && endNode.kind !== "end") continue;
		let entry = outcomeMap.get(last.id);
		if (!entry) {
			entry = { nodeId: last.id, text: last.text.trim() || last.id, count: 0, pathIndices: [] };
			outcomeMap.set(last.id, entry);
		}
		entry.count++;
		entry.pathIndices.push(m.pathIndex);
	}
	const outcomes = [...outcomeMap.values()].sort((a, b) => b.count - a.count);

	return { requires, branchDecision, branches, outcomes };
}

export type JourneyBreakdownItem = {
	/** Decision node id. */
	nodeId: string;
	/** Preceding step context shown above terse decision questions like "Is it?". */
	context?: string;
	/** Decision question text. */
	question: string;
	/** Branch label taken (e.g. "yes", "no"). */
	answer: string;
	/** Target step id. */
	targetId: string;
	/** Resulting action text shown beneath the decision (omitted for next-decision, end, or loop-back targets). */
	result?: string;
	/** True when this branch returns to an earlier step already visited on this journey. */
	loopsBack?: boolean;
	/** Stage/group name this decision belongs to (or enters). */
	stage?: string;
	/** True when this decision is a mechanical loop-header gate entered and exited on this journey. */
	isLoopGate?: boolean;
};

export type JourneyBreakdown = {
	items: JourneyBreakdownItem[];
	outcome: string;
	outcomeId?: string;
};

/**
 * Structured, stage-aware timeline of decisions on a flowchart journey:
 * skips redundant loop-exit duplicates, adds context for terse questions ("Is it?"),
 * and separates each decision question/answer from its resulting action.
 */
export function journeyBreakdown(plan: Plan, path: PlanPath): JourneyBreakdown {
	const nodeById = new Map(plan.nodes.map((n) => [n.id, n]));
	const groupById = new Map(plan.groups.map((g) => [g.id, g.name]));
	const visitCount = new Map<string, number>();
	for (const s of path.steps) visitCount.set(s.id, (visitCount.get(s.id) ?? 0) + 1);
	const repeatedIds = new Set([...visitCount.entries()].filter(([, c]) => c > 1).map(([id]) => id));

	const items: JourneyBreakdownItem[] = [];
	const seenDecisions = new Set<string>();
	const visitedBefore = new Set<string>();

	for (let i = 0; i < path.steps.length; i++) {
		if (i > 0) visitedBefore.add(path.steps[i - 1]!.id);
		if (i === 0) continue;
		const prev = path.steps[i - 1]!;
		const cur = path.steps[i]!;
		const answer = cur.label?.trim();
		if (!answer) continue;

		// Skip the second (loop-exit) pass through a loop header already shown entering the loop.
		if (seenDecisions.has(prev.id)) continue;
		seenDecisions.add(prev.id);

		const prevNode = nodeById.get(prev.id);
		const curNode = nodeById.get(cur.id);
		const question = prev.text.trim() || prev.id;
		const isLoopGate = repeatedIds.has(prev.id);

		// Add preceding action context when the decision itself is terse (e.g. "Is it?", "Valid?").
		let context: string | undefined;
		if (question.length <= 18 && i >= 2) {
			const before = path.steps[i - 2]!;
			const beforeNode = nodeById.get(before.id);
			if (beforeNode && beforeNode.kind !== "start" && beforeNode.kind !== "decision" && !prev.label?.trim()) {
				context = before.text.trim();
			}
		}

		// Attach a stage name: the decision's own stage, or the stage a loop gate enters into.
		const ownStage = prevNode?.group ? groupById.get(prevNode.group) : undefined;
		const nextStage = curNode?.group ? groupById.get(curNode.group) : undefined;
		const stage = ownStage ?? (isLoopGate ? nextStage : undefined);

		const loopsBack = visitedBefore.has(cur.id);
		// Only show an indented "then" action line for real action steps — never echo the next decision,
		// the final end result (shown in Result), a loop-back target, or an action that serves only as
		// context for the very next terse decision.
		const nextStep = path.steps[i + 1];
		const nextAfter = path.steps[i + 2];
		const targetIsNextContext =
			Boolean(nextStep && nextAfter?.label?.trim()) &&
			nodeById.get(nextStep!.id)?.kind === "decision" &&
			nextStep!.text.trim().length <= 18;

		let result: string | undefined;
		if (!loopsBack && curNode?.kind !== "end" && curNode?.kind !== "decision" && !targetIsNextContext) {
			result = cur.text.trim();
		}

		items.push({
			nodeId: prev.id,
			...(context ? { context } : {}),
			question,
			answer,
			targetId: cur.id,
			...(result ? { result } : {}),
			...(loopsBack ? { loopsBack: true } : {}),
			...(stage ? { stage } : {}),
			...(isLoopGate ? { isLoopGate: true } : {}),
		});
	}

	const last = path.steps.at(-1);
	return {
		items,
		outcome: last?.text.trim() ?? "",
		outcomeId: last?.id,
	};
}

/** Trims text cleanly at a word boundary without stripping meaningful ": no" / "(no)" suffixes. */
function clipWords(raw: string, max: number): string {
	const text = raw.trim();
	if (text.length <= max) return text;
	const cut = text.slice(0, max);
	const space = cut.lastIndexOf(" ");
	return `${(space >= Math.floor(max * 0.45) ? cut.slice(0, space) : cut).trimEnd()}…`;
}

/** Concise label for a final outcome in compact dropdowns and suggested scenario titles. */
function compactOutcome(raw: string, max = 26): string {
	const text = raw.trim();
	const colon = text.indexOf(":");
	const lead = colon >= 8 ? text.slice(0, colon).trim() : text;
	const stripped = lead.replace(/^Return\s+/i, "");
	return clipWords(stripped.length >= 6 ? stripped : lead, max);
}

/** Compact single-line dropdown label for a flowchart journey (distinct, scannable, never overflows narrow selects). */
export function journeyOptionLabel(path: PlanPath, allPaths: PlanPath[], plan: Plan, index: number): string {
	const summary = pathSummary(path, allPaths, plan);
	const parts = summary.split(" · ").filter(Boolean);
	if (parts.length >= 2) {
		const lead = clipWords(parts[0]!.replace(/,\s+to\s+.*$/i, ""), 22);
		const end = compactOutcome(parts.at(-1)!, 20);
		return `#${index + 1} · ${lead} — ${end}`;
	}
	return `#${index + 1} · ${clipWords(summary, 38)}`;
}

/** Clean, human-readable test case draft derived from a flowchart journey (multi-line Given bullets, concise title). */
export function journeyDraft(
	plan: Plan,
	path: PlanPath,
	allPaths: PlanPath[],
	pathIndex: number,
	defaultNodeId?: string,
): { title: string; node?: string; journey: number; given: string; expect: string } {
	const bd = journeyBreakdown(plan, path);
	const summary = pathSummary(path, allPaths, plan);
	const parts = summary.split(" · ").filter(Boolean);
	const shortTitle =
		parts.length >= 2
			? `${clipWords(parts[0]!.replace(/,\s+to\s+.*$/i, ""), 28)} — ${compactOutcome(parts.at(-1)!, 24)}`
			: clipWords(summary, 52);

	// Keep the meaningful business decisions (skipping mechanical loop-entry gates unless there are no others).
	const businessItems = bd.items.filter((it) => !it.isLoopGate);
	const chosen = businessItems.length > 0 ? businessItems : bd.items;
	const givenLines = chosen.map((it) => {
		const q = it.context ? `${it.context} (${it.question})` : it.question;
		return `- ${q}: ${it.answer}`;
	});

	return {
		title: shortTitle,
		...(defaultNodeId ? { node: defaultNodeId } : {}),
		journey: pathIndex + 1,
		given: givenLines.join("\n"),
		expect: bd.outcome,
	};
}

/** The paths a test script's text does not mention by number. */
export function pathsMissing(code: string, count: number): number[] {
	const out: number[] = [];
	for (let n = 1; n <= count; n++) if (!new RegExp(`\\bPath ${n}\\b`, "i").test(code)) out.push(n);
	return out;
}

const NO_TOOLS = "You are inside SSL Studio. You cannot read, search or write files, and you cannot run anything: everything you need is below. Do not call any tool. Your whole answer is your reply, as text. SSL Studio checks it with the language server, and the user reviews it and runs it in STARLIMS.";

export function testsPrompt(plan: Plan, file: string, paths: PlanPath[], code: { name: string; callAs: string; text: string }[], spec: string, patterns = ""): string {
	const custom = planTestsOf(plan);
	const nodeName = (id?: string) => (id ? plan.nodes.find((n) => n.id === id)?.text.trim() : undefined);
	return [
		`PLAN STAGE: tests for ${plan.title || "the plan"}`,
		NO_TOOLS,
		`Write the SSL test script ${file}, following the skill ssl-unit-test. One test procedure for each path through the chart below, and its first comment says which: "Path 3: ...". Test what the caller receives. A step you cannot test without data says what it needs in the file's banner.`,
		"No placeholder and no commented-out call: if a path cannot be reached through what the code offers, its test says so in a comment and reports a failure. Reply with the whole script in one ```ssl block.",
		"",
		"THE PATHS:",
		...paths.map(pathLine),
		...(custom.length
			? [
					"",
					"ADDITIONAL BUSINESS TEST CASES WRITTEN ON THE PLAN:",
					...custom.map((t) => {
						const step = nodeName(t.node);
						return `- ${t.title}${step ? ` (step: ${step})` : ""}${t.journey ? ` (Path ${t.journey})` : ""}${t.given ? ` | Given: ${t.given}` : ""}${t.expect ? ` | Expect: ${t.expect}` : ""}${t.notes ? ` | Notes: ${t.notes}` : ""}`;
					}),
				]
			: []),
		"",
		"THE CODE UNDER TEST:",
		...code.flatMap((c) => [`${c.name}, called from another script as ExecFunction("${c.callAs}", {...}):`, "```ssl", c.text, "```"]),
		"",
		"THE SPEC:",
		spec,
		...(patterns ? ["", "HOW SSL DOES COMMON THINGS. Use only keywords and calls you see here or in the code:", patterns] : []),
	].join("\n");
}
