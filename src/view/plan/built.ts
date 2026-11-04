// What a plan remembers once its code is accepted (planning mode, after the build): which
// procedures carry which nodes, and what each node said then. From that come the links,
// the drift report, and knowing what a changed chart needs rebuilt. Once built the code is
// the source of truth (ADR 0005): differences are reported, never repaired. Pure, and
// nothing here reads SSL (ADR 0003): procedures and calls are the server's.
import { hashText, planHash, type SpecUnit } from "./assist";
import { lastPart, requiredCalls, scriptOf, type BuildRun, type BuildUnit } from "./build";
import type { Finding, Plan, PlanNode } from "./model";

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
	const units = raw.units.filter((u) => typeof u?.name === "string" && typeof u?.script === "string").map((u) => ({ ...u, nodes: strings(u.nodes), calls: strings(u.calls) }));
	return units.length || raw.tests ? { ...raw, units, nodes: raw.nodes } as Built : null;
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

const refsIn = (plan: Plan, nodes: string[]) => plan.nodes.filter((n) => nodes.includes(n.id) && n.kind === "call" && n.ref?.trim()).map((n) => n.ref!);

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

/** Every way through the chart: each is a test case. A loop is taken once, as each edge is used at most once on a path. */
export function planPaths(plan: Plan, limit = MAX_PATHS): { paths: PlanPath[]; truncated: boolean } {
	const paths: PlanPath[] = [];
	let truncated = false;
	const walk = (id: string, label: string | undefined, steps: PlanPath["steps"], used: Set<string>) => {
		if (truncated) return;
		const node = plan.nodes.find((n) => n.id === id);
		if (!node) return;
		const here = [...steps, { id, text: node.text, ...(label ? { label } : {}) }];
		const out = plan.edges.filter((e) => e.from === id && !used.has(`${e.from}>${e.to}`));
		if (!out.length) {
			if (paths.length >= limit) truncated = true;
			else paths.push({ steps: here });
			return;
		}
		for (const e of out) walk(e.to, e.label, here, new Set([...used, `${e.from}>${e.to}`]));
	};
	for (const start of plan.nodes.filter((n) => n.kind === "start")) walk(start.id, undefined, [], new Set());
	return { paths, truncated };
}

export const pathLine = (path: PlanPath, i: number) => `Path ${i + 1}: ${path.steps.map((s) => `${s.label ? `(${s.label}) ` : ""}${s.text}`).join(" -> ")}`;

/** The paths a test script's text does not mention by number. */
export function pathsMissing(code: string, count: number): number[] {
	const out: number[] = [];
	for (let n = 1; n <= count; n++) if (!new RegExp(`\\bPath ${n}\\b`, "i").test(code)) out.push(n);
	return out;
}

const NO_TOOLS = "You are inside SSL Studio. You cannot read, search or write files, and you cannot run anything: everything you need is below. Do not call any tool. Your whole answer is your reply, as text. SSL Studio checks it with the language server, and the user reviews it and runs it in STARLIMS.";

export function testsPrompt(plan: Plan, file: string, paths: PlanPath[], code: { name: string; callAs: string; text: string }[], spec: string, patterns = ""): string {
	return [
		`PLAN STAGE: tests for ${plan.title || "the plan"}`,
		NO_TOOLS,
		`Write the SSL test script ${file}, following the skill ssl-unit-test. One test procedure for each path through the chart below, and its first comment says which: "Path 3: ...". Test what the caller receives. A step you cannot test without data says what it needs in the file's banner.`,
		"No placeholder and no commented-out call: if a path cannot be reached through what the code offers, its test says so in a comment and reports a failure. Reply with the whole script in one ```ssl block.",
		"",
		"THE PATHS:",
		...paths.map(pathLine),
		"",
		"THE CODE UNDER TEST:",
		...code.flatMap((c) => [`${c.name}, called from another script as ExecFunction("${c.callAs}", {...}):`, "```ssl", c.text, "```"]),
		"",
		"THE SPEC:",
		spec,
		...(patterns ? ["", "HOW SSL DOES COMMON THINGS. Use only keywords and calls you see here or in the code:", patterns] : []),
	].join("\n");
}
