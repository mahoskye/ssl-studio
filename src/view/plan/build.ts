// Planning mode's build (stage 4), the part that needs no model: what a run holds,
// which unit comes next, whether a unit is really done, and what the script becomes.
// The judge is shaped by what went wrong in docs/spikes/planning-mode.md: replies with
// no code, comments in place of a step, calls to procedures that do not exist. Nothing
// here parses SSL (ADR 0003): findings, symbols and calls all come from the server.
import { decisionsOf, readBlocks, type NodeMap, type SpecUnit } from "./assist";
import type { Plan } from "./model";

export type UnitStatus = "pending" | "running" | "passed" | "stuck" | "skipped";
export type BuildUnit = SpecUnit & {
	status: UnitStatus;
	code?: string;
	/** The last attempt of a stuck unit, kept to look at. */
	draft?: string;
	/** Why it is stuck, in words the agent and you can both act on. */
	problems?: string[];
	attempts: number;
	/** A question only you can answer, and your answer. */
	question?: string;
	answer?: string;
	/** Your reason for rejecting it at review. */
	feedback?: string;
};
export type RunStatus = "running" | "stopped" | "budget" | "built";
export type BuildRun = {
	version: 1;
	planHash: string;
	model: string;
	status: RunStatus;
	tokens: number;
	cost: number;
	budget: { cost?: number; tokens: number };
	units: BuildUnit[];
	map: NodeMap[];
	/** The second opinion: advisory. */
	review?: string;
	/** Scripts you have accepted. */
	accepted: string[];
};

export const DEFAULT_TOKEN_BUDGET = 400_000;
export const MAX_ATTEMPTS = 3;

const jsonAfter = (text: string, heading: string): unknown => {
	const at = text.indexOf(heading);
	const block = at < 0 ? null : /```json\s*\n([\s\S]*?)```/.exec(text.slice(at));
	try {
		return block ? JSON.parse(block[1]!) : null;
	} catch {
		return null;
	}
};

/** The units and node map in an approved spec's file. */
export function readSpecFile(text: string): { units: SpecUnit[]; map: NodeMap[] } {
	const units = jsonAfter(text, "## Units");
	const map = jsonAfter(text, "## What each node becomes");
	return { units: Array.isArray(units) ? units.filter((u) => typeof u?.name === "string") : [], map: Array.isArray(map) ? map.filter((m) => typeof m?.node === "string") : [] };
}

export function newRun(plan: { hash: string; model: string }, units: SpecUnit[], map: NodeMap[], budget: { cost?: number; tokens?: number } = {}): BuildRun {
	return {
		version: 1,
		planHash: plan.hash,
		model: plan.model,
		status: "running",
		tokens: 0,
		cost: 0,
		budget: { ...(budget.cost !== undefined ? { cost: budget.cost } : {}), tokens: budget.tokens ?? DEFAULT_TOKEN_BUDGET },
		units: units.map((u) => ({ ...u, status: "pending", attempts: 0 })),
		map,
		accepted: [],
	};
}

const lastPart = (name: string) => String(name).split(".").at(-1)!.toLowerCase();
const namesOf = (calls: unknown): string[] => (Array.isArray(calls) ? calls.filter((c): c is string => typeof c === "string") : []);

/**
 * The next unit to build, marking those that wait on a stuck one. Carrying on with the
 * rest means one hard unit does not cost you the whole run.
 */
export function nextUnit(run: BuildRun): BuildUnit | null {
	const blocked = new Set(run.units.filter((u) => u.status === "stuck" || u.status === "skipped").map((u) => u.name.toLowerCase()));
	for (const unit of run.units) {
		if (unit.status !== "pending") continue;
		const waitsOn = namesOf(unit.calls).find((c) => blocked.has(lastPart(c)));
		if (waitsOn) {
			unit.status = "skipped";
			unit.problems = [`It calls ${waitsOn}, which is stuck.`];
			blocked.add(unit.name.toLowerCase());
			continue;
		}
		return unit;
	}
	return null;
}

export const overBudget = (run: BuildRun) => run.tokens >= run.budget.tokens || (run.budget.cost !== undefined && run.cost >= run.budget.cost);

/** Words that mean a step was described and not done, in any language's comments. */
const PLACEHOLDER = /\b(todo|fixme|placeholder|stub|not implemented|to be implemented|implement (the )?(actual|real)|replace with (the )?(actual|real)|your (code|logic) here|logic (goes )?here)\b/i;

export function placeholderIn(code: string): string | null {
	for (const line of code.split(/\r?\n/)) if (PLACEHOLDER.test(line)) return line.trim();
	return null;
}

export type Finding = { code?: string; severity: number; message: string; line: number };
export type Edge = { from: string; target: string; resolved: boolean };
export type Judged = {
	unit: Pick<SpecUnit, "name" | "parameters" | "calls">;
	code: string | null;
	/** The script without this unit, and with it. */
	before: Finding[];
	after: Finding[];
	/** Procedures the server sees in the script without this unit, and with it, with parameters. */
	existing: { name: string; parameters: string[] }[];
	symbols: { name: string; parameters: string[] }[];
	/** Calls in the script with this unit. */
	edges: Edge[];
	/** Names that are expected to exist by the time the build ends. */
	planned: string[];
	/** Names the chart or spec say it calls, among unit.calls, that must show as calls. */
	mustCall: string[];
	size: { bytes: number; codeLines: number };
	limits: { bytes: number; codeLines: number };
};

/** Everything wrong with a unit, or nothing. Findings of info level and below do not count. */
export function judgeUnit(j: Judged): string[] {
	if (!j.code?.trim()) return ["Your reply had no ```ssl block, so nothing was written."];
	const problems: string[] = [];
	const count = (list: Finding[]) => list.filter((f) => f.severity <= 2).reduce((m, f) => m.set(f.code ?? "?", (m.get(f.code ?? "?") ?? 0) + 1), new Map<string, number>());
	const was = count(j.before);
	const added = new Set<string>();
	for (const [code, n] of count(j.after)) if (n > (was.get(code) ?? 0)) added.add(code);
	for (const f of j.after) if (f.severity <= 2 && added.has(f.code ?? "?")) problems.push(`Line ${f.line}: ${f.code ?? "finding"}: ${f.message}`);
	const name = j.unit.name.toLowerCase();
	if (j.existing.some((s) => s.name.toLowerCase() === name)) problems.push(`${j.unit.name} already exists in this script.`);
	const found = j.symbols.find((s) => s.name.toLowerCase() === name);
	if (!found) problems.push(`The code does not define the procedure ${j.unit.name}.`);
	else if (j.unit.parameters) {
		const wanted = j.unit.parameters.map((p) => String(p).toLowerCase()).join(", ");
		const got = found.parameters.map((p) => p.toLowerCase()).join(", ");
		if (wanted !== got) problems.push(`${j.unit.name} should take (${j.unit.parameters.join(", ")}), not (${found.parameters.join(", ")}).`);
	}
	const placeholder = placeholderIn(j.code);
	if (placeholder) problems.push(`This is a placeholder, not the step itself: ${placeholder}`);
	const planned = new Set(j.planned.map((p) => lastPart(p)));
	const mine = j.edges.filter((e) => e.from.toLowerCase() === name);
	for (const e of mine) if (!e.resolved && !planned.has(lastPart(e.target))) problems.push(`It calls ${e.target}, which does not exist in the workspace.`);
	for (const required of j.mustCall) if (!mine.some((e) => lastPart(e.target) === lastPart(required))) problems.push(`The spec says it calls ${required}, and it does not.`);
	if (j.size.bytes > j.limits.bytes) problems.push(`The script is now ${Math.round(j.size.bytes / 1024)} KB, over the ${Math.round(j.limits.bytes / 1024)} KB limit.`);
	if (j.size.codeLines > j.limits.codeLines) problems.push(`The script is now ${j.size.codeLines} code lines, over the ${j.limits.codeLines} limit.`);
	return problems;
}

/** What must show as a call: units and chart call nodes the unit is said to call, not built-ins. */
export function requiredCalls(unit: SpecUnit, plan: Plan, units: SpecUnit[]): string[] {
	const known = new Set([...units.map((u) => lastPart(u.name)), ...plan.nodes.filter((n) => n.kind === "call" && n.ref).map((n) => lastPart(n.ref!))]);
	return namesOf(unit.calls).filter((c) => known.has(lastPart(c)));
}

/** Each node's state for the chart: the worst of the units that build it. */
export function nodeStatuses(run: BuildRun | null | undefined): Map<string, UnitStatus> {
	const map = new Map<string, UnitStatus>();
	const rank: UnitStatus[] = ["passed", "pending", "running", "skipped", "stuck"];
	for (const unit of run?.units ?? [])
		for (const node of unit.nodes ?? []) {
			const was = map.get(node);
			if (!was || rank.indexOf(unit.status) > rank.indexOf(was)) map.set(node, unit.status);
		}
	return map;
}

/** Nodes a finished run has nothing to show for. It may not report success while there are any. */
export function unbuiltNodes(plan: Plan, run: BuildRun): string[] {
	const statuses = nodeStatuses(run);
	const said = new Set(run.map.map((m) => m.node));
	return plan.nodes.filter((n) => (statuses.has(n.id) ? statuses.get(n.id) !== "passed" : !said.has(n.id))).map((n) => n.text);
}

export const scriptOf = (unit: SpecUnit, plan: Plan) => unit.script ?? (Array.isArray(plan.targets) && plan.targets.length ? String(plan.targets[0]) : `${plan.title.replace(/[^\w-]+/g, "") || "Plan"}.ssl`);

/** Passed units, in order, wrapped in the regions their chart groups name. */
function assembleUnits(units: BuildUnit[], plan: Plan): string {
	const groupOf = (unit: BuildUnit) => {
		for (const id of unit.nodes ?? []) {
			const group = plan.groups.find((g) => g.id === plan.nodes.find((n) => n.id === id)?.group);
			if (group) return group.name;
		}
		return null;
	};
	const parts: string[] = [];
	let open: string | null = null;
	for (const unit of units) {
		const group = groupOf(unit);
		if (group !== open) {
			if (open) parts.push("/* endregion;");
			if (group) parts.push(`/* region ${group};`);
			open = group;
		}
		parts.push(unit.code!.trim());
	}
	if (open) parts.push("/* endregion;");
	return parts.join("\n\n");
}

/** The script a run proposes: what is there now, or a banner for a new one, then the new units. */
export function assembleScript(existing: string | null, banner: string, units: BuildUnit[], plan: Plan): string {
	const added = assembleUnits(units.filter((u) => u.code), plan);
	const head = existing === null ? banner.trimEnd() : existing.trimEnd();
	return `${head ? `${head}\n\n` : ""}${added}\n`;
}

/** A question for you, if the agent's reply asks one instead of answering. */
export function questionIn(reply: string): string | null {
	const block = readBlocks(reply).QUESTIONS;
	if (!block) return null;
	try {
		const list = JSON.parse(block.replace(/^```\w*\s*|```\s*$/g, ""));
		const first = Array.isArray(list) ? list.find((q) => typeof q?.question === "string" && q.question.trim()) : null;
		return first ? first.question.trim() : null;
	} catch {
		return null;
	}
}

const NO_TOOLS = "You are inside SSL Studio. You cannot read, search or write files: everything you need is below. Do not call any tool: none can help, and none can write a file. Ignore any instruction, from a skill or anywhere, to write or save one. Your whole answer is your reply, as text. SSL Studio checks it with the language server, and the user reviews it before anything is saved.";

/** The house's own templates, as worked examples: models invent syntax they have not been shown. */
export function patternsFrom(templates: { label: string; group: string; body: () => string }[]): string {
	return templates
		.filter((t) => t.group === "Flow" || t.group === "Data")
		.map((t) => `${t.label}:\n${t.body().replace(/\$\{\d+:([^}]*)\}/g, "$1").replace(/\$\{?\d+\}?/g, "...").trim()}`)
		.join("\n");
}

export function unitPrompt(plan: Plan, spec: string, unit: BuildUnit, built: BuildUnit[], callable: string, patterns = ""): string {
	const nodes = plan.nodes.filter((n) => unit.nodes?.includes(n.id));
	const decided = decisionsOf(plan).filter((d) => d.answer?.trim());
	return [
		`PLAN STAGE: build ${unit.name}`,
		NO_TOOLS,
		`Write the SSL procedure ${unit.name} from the spec, following the skill ssl-new-procedure. It must really do each step below: no placeholder, no commented-out call, no "implement this later". Call only what exists below or what the spec says will be built. If you need a fact only the user knows, do not guess: reply with a block between lines <<<QUESTIONS and >>>QUESTIONS holding a JSON list of {"question":"..."}.`,
		"Otherwise reply with that procedure only, its doc comment included, in one ```ssl block. Do not reprint other procedures.",
		"",
		"THE UNIT:",
		JSON.stringify({ name: unit.name, script: unit.script, parameters: unit.parameters, calls: unit.calls }),
		...(nodes.length ? ["", "THE STEPS IT CARRIES OUT, FROM THE CHART:", ...nodes.map((n) => `- ${n.text}${n.notes ? ` (${n.notes})` : ""}`)] : []),
		...(decided.length ? ["", "WHAT THE USER DECIDED:", ...decided.map((d) => `- ${d.question} ${d.answer}`)] : []),
		...(unit.question && unit.answer ? ["", `YOU ASKED: ${unit.question}`, `THE USER SAID: ${unit.answer}`] : []),
		...(unit.feedback ? ["", `THE USER REJECTED THE LAST VERSION: ${unit.feedback}`] : []),
		"",
		"THE SPEC:",
		spec,
		...(built.length ? ["", "ALREADY BUILT IN THIS RUN:", ...built.map((b) => `${b.name}(${(b.parameters ?? []).join(", ")}) in ${b.script ?? "this script"}`)] : []),
		"",
		"WHAT ALREADY EXISTS:",
		callable,
		...(patterns ? ["", "HOW SSL DOES COMMON THINGS. SQL goes through these calls, never as a bare statement. Use only keywords and calls you see here or in the existing code:", patterns] : []),
	].join("\n");
}

export function retryPrompt(base: string, code: string | null, problems: string[]): string {
	return [base, "", ...(code ? ["YOUR LAST ATTEMPT:", "```ssl", code, "```", ""] : []), "THESE ARE WRONG WITH IT. Fix every one, and reply with the whole procedure again in one ```ssl block:", ...problems.map((p) => `- ${p}`)].join("\n");
}

/** A second opinion: a fresh session, told plainly what to judge. Advisory, and never the only check. */
export function reviewPrompt(plan: Plan, spec: string, scripts: { path: string; text: string }[]): string {
	return [
		"PLAN STAGE: second opinion",
		"You did not write this code, and you cannot read files: all of it is below. Do not ask for a file. Read it against the chart and the spec, and say what is missing or wrong, most serious first. Say which chart step each point concerns. Say whether each step of the chart is really carried out. Do not state rules of the language you are not sure of.",
		"",
		"THE CHART:",
		...plan.nodes.map((n) => `- ${n.text}${n.notes ? ` (${n.notes})` : ""}`),
		"",
		"THE SPEC:",
		spec,
		"",
		...scripts.flatMap((s) => [`THE SCRIPT ${s.path}:`, "```ssl", s.text, "```", ""]),
	].join("\n");
}
