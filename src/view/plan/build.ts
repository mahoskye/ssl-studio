// Planning mode's build (stage 4), the part that needs no model: what a run holds,
// which unit comes next, whether a unit is really done, and what the script becomes.
// The judge is shaped by what went wrong in docs/spikes/planning-mode.md: replies with
// no code, comments in place of a step, calls to procedures that do not exist. Nothing
// here parses SSL (ADR 0003): findings, symbols and calls all come from the server.
import { bannerTemplate } from "../../shared/houseStyle";
import { decisionsOf, hashText, planTargetsOf, readBlocks, type NodeMap, type SpecUnit } from "./assist";
import { nodeDocsOf, type Plan } from "./model";
import { isLocalModelRef } from "../../shared/agentModels";
import { languageFor } from "../../shared/languages";

/** `kept`: already built, and the chart has not touched it. It is never sent to the agent or reprinted. */
export type UnitStatus = "pending" | "running" | "passed" | "stuck" | "skipped" | "kept";
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
	/** It edits a procedure that exists, rather than adding one. */
	change?: boolean;
	/**
	 * Set when this unit's code is accepted into its script: a print of the two (`givenPrint`). What a run kept of an
	 * accepting used to be the script's name alone, and a script once accepted was never offered for review again: a
	 * unit that passed afterwards (it was stuck, and tried again) never reached the file, and was recorded as built.
	 */
	given?: string;
	/**
	 * For a unit accepted into the editor: prints of the texts its script would hold again were the accepting taken
	 * back, which are its text just before, what was saved of it then where that differed, and the same of the units
	 * the script was given earlier (`textPrint`). Accepting is an edit that can be undone, or thrown away with the
	 * buffer, and a script that reads as one of these again no longer holds this unit (`takenBack`). A unit whose
	 * file the accepting created has none: no undo takes the file away.
	 */
	was?: string[];
};
export type RunStatus = "running" | "stopped" | "budget" | "built";
export type BuildRun = {
	version: 1;
	planHash: string;
	/**
	 * Each node of the plan this run was begun from, as a build sees it (`nodePrints`, built.ts). The hash says only
	 * whether the chart is still that plan, and the chart can be changed between a build and the accepting of it:
	 * what is then recorded as built is these, and not the chart as it stands by then. A run made before they were
	 * kept is given them where it is taken up again (`loadRun`, `startBuild`), which is only ever with its own plan.
	 */
	prints?: Record<string, string>;
	model: string;
	status: RunStatus;
	tokens: number;
	cost: number;
	budget: { cost?: number; tokens: number };
	units: BuildUnit[];
	map: NodeMap[];
	/** The second opinion: advisory. */
	review?: string;
	/** The print of the passed units the second opinion was last asked about (`passedPrint`, buildRun.ts). */
	reviewOf?: string;
	/** Scripts you have accepted, and that have no unit waiting for review (`settleAccepted`). */
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

export function newRun(plan: { hash: string; model: string; prints?: Record<string, string> }, units: SpecUnit[], map: NodeMap[], budget: { cost?: number; tokens?: number } = {}): BuildRun {
	return {
		version: 1,
		planHash: plan.hash,
		...(plan.prints ? { prints: plan.prints } : {}),
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

const isRecord = (value: unknown): value is Record<string, any> => typeof value === "object" && value !== null && !Array.isArray(value);
/** A count or a sum as a file holds it: a number above zero, or nothing. */
const amount = (value: unknown): number => (typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0);
const RUN_STATUSES: readonly RunStatus[] = ["running", "stopped", "budget", "built"];

/**
 * A run as its file holds it, made safe to carry on; null for what is not a run at all. The file used to be taken
 * as it came. One with no budget, as an earlier version or a hand may have left it, ended every build of its plan
 * with "undefined is not an object (evaluating 'run.budget.cost')"; one whose budget held no token count had no
 * token limit at all, since nothing is ever over a limit that is not a number. What is missing, or does not read as
 * a number above zero, is put right here: nothing spent is nothing spent, a missing token budget is the default
 * one, and a cost budget that does not read is no cost budget, which a build asks for before any turn goes to a
 * model that may cost money (`unbudgeted`). A limit that is missing is never no limit.
 */
export function mendRun(raw: unknown): BuildRun | null {
	if (!isRecord(raw) || !Array.isArray(raw.units) || !Array.isArray(raw.accepted) || !Array.isArray(raw.map)) return null;
	const budget = isRecord(raw.budget) ? raw.budget : {};
	const cost = amount(budget.cost);
	return {
		...(raw as BuildRun),
		model: typeof raw.model === "string" ? raw.model : "",
		status: RUN_STATUSES.includes(raw.status) ? raw.status : "stopped",
		tokens: amount(raw.tokens),
		cost: amount(raw.cost),
		budget: { ...(cost ? { cost } : {}), tokens: amount(budget.tokens) || DEFAULT_TOKEN_BUDGET },
		units: raw.units.filter((u): u is BuildUnit => isRecord(u) && typeof u.name === "string"),
		map: raw.map.filter((m): m is NodeMap => isRecord(m) && typeof m.node === "string"),
		accepted: raw.accepted.filter((s): s is string => typeof s === "string"),
	};
}

export const lastPart = (name: string) => String(name).split(".").at(-1)!.toLowerCase();
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

/**
 * Puts back in the queue what an earlier attempt left marked as being built. A unit is marked before its first
 * turn, and an attempt that ended there (an error, or the folder changed under it) never unmarked it: `nextUnit`
 * takes only what is waiting, so the unit was not built again and the run ended "built" around it.
 * Says whether anything was put back.
 */
export function requeueRunning(run: BuildRun): boolean {
	let found = false;
	for (const unit of run.units) {
		if (unit.status !== "running") continue;
		unit.status = "pending";
		found = true;
	}
	return found;
}

export const overTokens = (run: BuildRun) => run.tokens >= run.budget.tokens;
export const overCost = (run: BuildRun) => run.budget.cost !== undefined && run.cost >= run.budget.cost;
export const overBudget = (run: BuildRun) => overTokens(run) || overCost(run);

/**
 * What a build does next: builds a unit, or ends. With nothing left to build it is built, whatever it has spent:
 * the budget used to be looked at first, so a run whose last unit took it over was "stopped at its budget" with
 * nothing to carry on with. With a unit waiting and the budget reached, it stops there.
 */
export function nextStep(run: BuildRun): { unit: BuildUnit } | { ends: "built" | "budget" } {
	const unit = nextUnit(run);
	if (!unit) return { ends: "built" };
	return overBudget(run) ? { ends: "budget" } : { unit };
}

/**
 * Whether the budget ran out on a unit that still had tries to come. Such a unit has not had its tries, so it is
 * not stuck: it goes back to waiting, and is built when the build is carried on with more to spend. Marked stuck,
 * it had to be tried again by hand before a carried-on build would take it, and what calls it was passed over as
 * waiting on a stuck unit.
 */
export const cutShort = (run: BuildRun, attempt: number) => overBudget(run) && attempt < MAX_ATTEMPTS;

/**
 * What a run must be given before it is carried on, because it has reached that budget and has units waiting to
 * be built; null when it can simply go on. A run that stopped at its budget used to be started again with the
 * budget it had already reached: it stopped at once, and the only way on was to discard it, and with it every
 * unit that had passed. A run with nothing waiting is asked for nothing: there is nothing to spend it on.
 */
export function spentUp(run: BuildRun): { cost: boolean; tokens: boolean } | null {
	if (!run.units.some((u) => u.status === "pending" || u.status === "running")) return null;
	const [cost, tokens] = [overCost(run), overTokens(run)];
	return cost || tokens ? { cost, tokens } : null;
}

/**
 * The cost budget offered when a run that stopped at its budget is carried on: twice the one it had, or, when one
 * turn has taken it past that already, as much again on top of what is spent. Always above what is spent.
 */
export function nextCostBudget(run: BuildRun): number {
	const had = run.budget.cost ?? 0;
	if (had * 2 > run.cost) return had * 2;
	const more = Math.round((run.cost + had) * 100) / 100;
	return more > run.cost ? more : run.cost + 1;
}

/** A cost budget as it was typed, for a run that has spent `spent`: a number above zero and above that, or null. */
export function readCostBudget(answer: string, spent = 0): number | null {
	const cost = Number(answer.trim());
	return answer.trim() && Number.isFinite(cost) && cost > 0 && cost > spent ? cost : null;
}

/**
 * What a run that reached its budget may spend from here: the cost budget it is given, and another token budget
 * on top of the tokens it has used. Only what was agreed to is raised, so a run with one of the two still used
 * up stops again at once. Its units are left as they are: what has passed is not built again.
 */
export function raiseBudget(run: BuildRun, more: { cost?: number; tokens?: boolean }) {
	if (more.cost !== undefined) run.budget.cost = more.cost;
	if (more.tokens) run.budget.tokens = run.tokens + DEFAULT_TOKEN_BUDGET;
}

/**
 * Whether a model is known to cost nothing: opencode lists it as local, or its name is a local provider's (or one
 * of the user's own models), which is the rule the backend goes by (src/shared/agentModels.ts). Any other model
 * the list does not hold is not known to be free, and counts as one that may cost money. The list is empty until
 * opencode has started, and a model missing from it once counted as local, so a build on a paid model could
 * start with no cost budget. Names are compared as opencode compares them, without regard to case.
 */
export function modelIsLocal(models: readonly { providerID: string; id: string; local: boolean }[], ref: string, ownModels?: readonly string[]): boolean {
	const wanted = ref.trim().toLowerCase();
	if (!wanted) return false;
	return models.some((m) => m.local && `${m.providerID}/${m.id}`.toLowerCase() === wanted) || isLocalModelRef(ref, ownModels);
}

/**
 * Whether a build's next turn would go to a model that may cost money with no cost budget agreed to. The budget
 * was asked for once, as the build began, of the model chosen then: a build begun on a local model went on, turn
 * after turn, on a paid one chosen while it ran, and no budget had ever been set for it. Asked before every turn,
 * of the model in use at that moment. With no model chosen opencode takes a local one or refuses the turn.
 */
export function unbudgeted(run: Pick<BuildRun, "budget">, models: readonly { providerID: string; id: string; local: boolean }[], model: string, ownModels?: readonly string[]): boolean {
	return Boolean(model.trim()) && run.budget.cost === undefined && !modelIsLocal(models, model, ownModels);
}

/**
 * What the assistant says beside the model's name about its cost, and why; null when there is nothing to warn of.
 * With no model chosen opencode takes a local one or refuses the turn. A model the list does not hold is said to
 * be one that may cost money, in the words of the build's budget question: until opencode has started the list
 * is empty, and the note used to be left out then, as if the model were known to be local.
 */
export function modelCostNote(
	models: readonly { providerID: string; id: string; local: boolean }[],
	ref: string,
	ownModels?: readonly string[],
): { words: string; why: string } | null {
	const wanted = ref.trim().toLowerCase();
	if (!wanted || modelIsLocal(models, ref, ownModels)) return null;
	if (models.some((m) => `${m.providerID}/${m.id}`.toLowerCase() === wanted)) return { words: "paid model", why: "opencode lists this model as one that is not local." };
	return {
		words: "may cost money",
		why: models.length
			? "opencode does not list this model, so it is not known to be a local one."
			: "opencode has not started, so it has not said whether this model is a local one. A build asks before it spends anything.",
	};
}

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
	if (j.limits.bytes > 0 && j.size.bytes > j.limits.bytes) problems.push(`The script is now ${Math.round(j.size.bytes / 1024)} KB, over the ${Math.round(j.limits.bytes / 1024)} KB limit.`);
	if (j.limits.codeLines > 0 && j.size.codeLines > j.limits.codeLines) problems.push(`The script is now ${j.size.codeLines} code lines, over the ${j.limits.codeLines} limit.`);
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
	const rank: UnitStatus[] = ["kept", "passed", "pending", "running", "skipped", "stuck"];
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
	const done = (id: string) => statuses.get(id) === "passed" || statuses.get(id) === "kept";
	return plan.nodes.filter((n) => (statuses.has(n.id) ? !done(n.id) : !said.has(n.id))).map((n) => n.text);
}

export const scriptOf = (unit: SpecUnit, plan: Plan) =>
	unit.script?.trim() || planTargetsOf(plan)[0] || `${plan.title.replace(/[^\w-]+/g, "") || "Plan"}.ssl`;

/**
 * Why a build may not write a script, or null when it may. A build writes SSL scripts in the workspace's own
 * folders: the path is relative to the workspace and does not step out of it, no folder on the way is hidden and
 * the file is not (.git, .ssl-studio, .github and the like), and it is a file SSL Studio itself takes for SSL
 * (.ssl, .srvscr, .ds, or one of those saved as .txt: the language catalog's rule).
 *
 * A unit's script comes from the plan doc, which a model wrote, or from the plan's target scripts. The backend
 * refuses a path outside the workspace, and that was the only check: inside it a unit could name a git hook or
 * the project's own settings, and the review offered to create that file, or to rewrite it, as SSL.
 */
export function scriptProblem(script: string): string | null {
	const norm = script.trim().replace(/\\/g, "/");
	const parts = norm.split("/").filter((part) => part && part !== ".");
	if (!parts.length || norm.includes("\0")) return "it names no file";
	if (norm.startsWith("/") || /^[A-Za-z]:/.test(norm) || parts.includes("..")) return "it is not a path inside the workspace";
	if (parts.some((part) => part.startsWith("."))) return "it is hidden, or in a hidden folder";
	if (languageFor(norm) !== "ssl") return "it is not an SSL file (.ssl, .srvscr or .ds)";
	return null;
}

/** The first unit a build would write whose script it may not, and why. A unit kept as it is, is not written. */
export function unwritableUnit(units: readonly (SpecUnit & { status?: UnitStatus })[], plan: Plan): { unit: string; script: string; why: string } | null {
	for (const unit of units) {
		if (unit.status === "kept") continue;
		const script = scriptOf(unit, plan);
		const why = scriptProblem(script);
		if (why) return { unit: unit.name, script, why };
	}
	return null;
}

// --- what a script has been given, and what a review is of -------------------------------

/** A text with one kind of line ending: the editor gives a file one kind, and what is accepted into it takes the buffer's. */
const oneEnding = (text: string) => text.replace(/\r\n?/g, "\n");

/** A script's text as one print, line endings aside. */
export const textPrint = (text: string) => hashText(oneEnding(text));

/** Whether two readings of a script are the same text, line endings aside. No file is the same as no file only. */
export const sameText = (a: string | null, b: string | null) => (a === null || b === null ? a === b : oneEnding(a) === oneEnding(b));

/** A unit's code in a script, as one print: what `BuildUnit.given` holds once the script has been given it. */
export const givenPrint = (script: string, code: string | undefined) => hashText(JSON.stringify([script, code ?? ""]));

/** Whether a unit's code, as it is now, has been accepted into the script it goes to now. */
export const isGiven = (unit: BuildUnit, plan: Plan) => unit.given !== undefined && unit.given === givenPrint(scriptOf(unit, plan), unit.code);

/** The units that wait for review: passed, and their code not accepted into their script. */
export const unitsToReview = (run: BuildRun, plan: Plan): BuildUnit[] => run.units.filter((u) => u.status === "passed" && !isGiven(u, plan));

/**
 * Holds `accepted` to what it says: a script that has been given a unit is in it, and one with a unit waiting
 * for review is not, accepted before or not. Called wherever a unit passes, is given to its script, or goes back.
 */
export function settleAccepted(run: BuildRun, plan: Plan) {
	const waits = new Set(unitsToReview(run, plan).map((u) => scriptOf(u, plan)));
	const holds = run.units.filter((u) => u.status === "passed" && isGiven(u, plan)).map((u) => scriptOf(u, plan));
	run.accepted = [...new Set([...run.accepted, ...holds])].filter((script) => !waits.has(script));
}

/**
 * A run saved before units were marked says only which scripts were accepted: each passed unit of those is taken
 * as given, which is what that version went by. A run that marks its units is left alone.
 */
export function givenFromAccepted(run: BuildRun, plan: Plan) {
	if (run.units.some((u) => u.given !== undefined)) return;
	for (const unit of run.units) if (unit.status === "passed" && run.accepted.includes(scriptOf(unit, plan))) unit.given = givenPrint(scriptOf(unit, plan), unit.code);
}

/**
 * Whether a script reads again as it would with a unit's accepting taken back (`BuildUnit.was`, which a file may
 * hold as anything). A script that is gone says nothing: it may have been moved, which the chart reports.
 */
export const takenBack = (was: unknown, text: string | null) => text !== null && Array.isArray(was) && was.includes(textPrint(text));

/** Takes the accepting of units out of a run, by the print each was given under: they wait for review again. */
export function takeBack(run: BuildRun, given: ReadonlySet<string>, plan: Plan) {
	for (const unit of run.units) {
		if (unit.given === undefined || !given.has(unit.given)) continue;
		delete unit.given;
		delete unit.was;
	}
	settleAccepted(run, plan);
}

/** What a review of a build shows, kept from the moment it opens: the script, and each unit as a print of its code there. */
export type Shown = { script: string; units: { name: string; print: string }[] };
export const shownOf = (script: string, units: readonly BuildUnit[]): Shown => ({ script, units: units.map((u) => ({ name: u.name, print: givenPrint(script, u.code) })) });

/** The units of a run that are still as a review shows them: passed, with that code, for that script, and not yet given to it. */
export const stillShown = (shown: Shown, run: BuildRun, plan: Plan): BuildUnit[] =>
	unitsToReview(run, plan).filter((u) => shown.units.some((s) => s.name === u.name && s.print === givenPrint(scriptOf(u, plan), u.code)));

/**
 * Marks the units a review showed as given to its script, those still as it showed them (`stillShown`). `was` is
 * what the script read as before, for an accepting into the editor; the units it was given earlier are taken back
 * with these when the script reads as it did before them, since undo goes back through the later edit first.
 */
export function giveTo(run: BuildRun, shown: Shown, plan: Plan, was: readonly string[]) {
	const earlier = run.units.filter((u) => u.status === "passed" && isGiven(u, plan) && scriptOf(u, plan) === shown.script).flatMap((u) => (Array.isArray(u.was) ? u.was : []));
	for (const unit of stillShown(shown, run, plan)) {
		unit.given = givenPrint(shown.script, unit.code);
		if (was.length) unit.was = [...new Set([...was, ...earlier])];
		else delete unit.was;
	}
	settleAccepted(run, plan);
}

/**
 * Why accepting a review would not act on what it shows, in words that follow "Not accepted:"; null when it would.
 * A review is of one run and one target script, and stays open for as long as you like. Accepting used to act on
 * whatever was stored by then: a new build begun meanwhile had the old review's script marked as accepted, and
 * with the plan's target script changed the old target was written and the plan recorded nothing. Every unit the
 * review shows must still be passed in the run as it is now, with the code shown, for the script shown.
 */
export function reviewStale(shown: Shown, run: BuildRun | null | undefined, plan: Plan): string | null {
	if (!run) return "the build this review was of has been discarded, so nothing was written";
	for (const { name, print } of shown.units) {
		const unit = run.units.find((u) => u.name === name);
		const script = unit && scriptOf(unit, plan);
		if (unit?.status === "passed" && script !== shown.script && givenPrint(shown.script, unit.code) === print)
			return `the plan now puts ${name} in ${script}, not in ${shown.script}, so nothing was written. Reject this review and open it again`;
	}
	const still = stillShown(shown, run, plan);
	if (!shown.units.every((s) => still.some((u) => u.name === s.name && givenPrint(shown.script, u.code) === s.print))) return "the build has changed since this review was opened, so nothing was written. Reject this review and open it again";
	return null;
}

/** Sanitizes free-text titles/stage names for single-line SSL comments (`/* ... ;`). */
const sanitizeSslComment = (text: string): string =>
	text
		.replace(/[\r\n]+/g, " ")
		.replace(/;/g, ",")
		.replace(/\s+/g, " ")
		.trim();

/** Deterministic per-plan run filename incorporating a short hash of the relative path so sibling folders don't collide. */
export function runFileName(relPath: string): string {
	const norm = relPath.trim().replace(/\\/g, "/").replace(/^\.?\/+/, "");
	const base = norm.split("/").at(-1) ?? "plan";
	const stem = base.replace(/\.plan\.json$/i, "") || "plan";
	return `${stem}-${hashText(norm.toLowerCase())}.run.json`;
}

/** House file banner for a new SSL script built from `plan`, safe against `;`, newlines, and `$`-replacement sequences. */
export function bannerFor(plan: Plan): string {
	const raw = typeof plan.goal === "string" && plan.goal.trim() ? plan.goal : plan.title;
	const safeGoal = sanitizeSslComment(String(raw ?? ""));
	return bannerTemplate()
		.replace(/\$\{(?!1\})\d+:([^}]*)\}/g, "$1")
		.replace("${1}", () => safeGoal);
}

/** Passed units, in order, wrapped in the regions their chart groups name. */
function assembleUnits(units: BuildUnit[], plan: Plan, eol = "\n"): string {
	const groupOf = (unit: BuildUnit) => {
		for (const id of unit.nodes ?? []) {
			const group = plan.groups.find((g) => g.id === plan.nodes.find((n) => n.id === id)?.group);
			if (group) {
				const safe = sanitizeSslComment(group.name);
				if (safe) return safe;
			}
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
		parts.push(unit.code!.trim().replace(/\r?\n/g, eol));
	}
	if (open) parts.push("/* endregion;");
	return parts.join(`${eol}${eol}`);
}

/** Where a procedure sits, in 0-based lines, with the doc comment directly above it. */
export type ProcedureSpan = { name: string; startLine: number; endLine: number };

/** Procedures from the server's syntax tree, whose procedure nodes start at the keyword. */
export function procedureSpans(nodes: any[]): ProcedureSpan[] {
	const spans: ProcedureSpan[] = [];
	const walk = (list: any[]) =>
		list.forEach((node, i) => {
			if (node.kind !== "procedure" || !node.name) return walk(node.children ?? []);
			let startLine: number = node.range.start.line;
			for (let j = i - 1; j >= 0; j--) {
				const above = list[j];
				if ((above.kind !== "docBlock" && above.kind !== "comment") || above.range.end.line !== startLine - 1) break;
				startLine = above.range.start.line;
			}
			spans.push({ name: node.name, startLine, endLine: node.range.end.line });
		});
	walk(nodes);
	return spans;
}

const spanOf = (spans: ProcedureSpan[], name: string) => spans.find((s) => s.name.toLowerCase() === name.toLowerCase());

/** A procedure's text as it stands, from its span. */
export function procedureText(text: string, spans: ProcedureSpan[], name: string): string | null {
	const span = spanOf(spans, name);
	return span ? text.split(/\r?\n/).slice(span.startLine, span.endLine + 1).join("\n").trim() : null;
}

/** Exact 0-based `:PROCEDURE ... :ENDPROC;` range (without leading doc comments) for code previewing. */
export function procedureBodySpan(nodes: any[], name: string): ProcedureSpan | null {
	const wanted = name.toLowerCase();
	let found: ProcedureSpan | null = null;
	const walk = (list: any[]) => {
		for (const node of list) {
			if (found) return;
			if (node.kind === "procedure" && typeof node.name === "string" && node.name.toLowerCase() === wanted && node.range) {
				found = { name: node.name, startLine: node.range.start.line, endLine: node.range.end.line };
				return;
			}
			if (Array.isArray(node.children) && node.children.length) walk(node.children);
		}
	};
	walk(nodes);
	return found;
}

const NON_CODE_KINDS = new Set(["banner", "docBlock", "comment", "blankLines", "blank"]);

/** Exact 0-based range of a script's top-level entry section (after the file banner, before the first procedure/region). */
export function scriptEntrySpan(nodes: any[]): { startLine: number; endLine: number } | null {
	const top: any[] = [];
	for (const node of nodes) {
		if (node.kind === "procedure" || node.kind === "region") break;
		top.push(node);
	}
	let first = 0;
	while (first < top.length && NON_CODE_KINDS.has(top[first].kind)) first++;
	let last = top.length - 1;
	while (last >= first && NON_CODE_KINDS.has(top[last].kind)) last--;
	if (first > last || !top[first]?.range || !top[last]?.range) return null;
	return { startLine: top[first].range.start.line, endLine: top[last].range.end.line };
}

/**
 * The script a run proposes: what is there now, or a banner for a new one, with changed
 * procedures replaced where they stand and new units after. The lines around them are
 * never touched: this is a text edit on ranges the server gave (ADR 0002).
 */
export function assembleScript(existing: string | null, banner: string, units: BuildUnit[], plan: Plan, spans: ProcedureSpan[] = []): string {
	const eol = existing?.includes("\r\n") ? "\r\n" : "\n";
	const coded = units.filter((u) => u.code);
	const inPlace = existing === null ? [] : coded.filter((u) => u.change && spanOf(spans, u.name));
	const lines = (existing ?? banner).split(/\r?\n/);
	for (const unit of [...inPlace].sort((a, b) => spanOf(spans, b.name)!.startLine - spanOf(spans, a.name)!.startLine)) {
		const span = spanOf(spans, unit.name)!;
		lines.splice(span.startLine, span.endLine - span.startLine + 1, ...unit.code!.trim().split(/\r?\n/));
	}
	const head = lines.join(eol).trimEnd();
	const rest = coded.filter((u) => !inPlace.includes(u));
	if (!rest.length) return `${head}${eol}`;
	return `${head ? `${head}${eol}${eol}` : ""}${assembleUnits(rest, plan, eol)}${eol}`;
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

export function unitPrompt(plan: Plan, spec: string, unit: BuildUnit, built: BuildUnit[], callable: string, patterns = "", changing = ""): string {
	const nodes = plan.nodes.filter((n) => unit.nodes?.includes(n.id));
	const refDocs = [...new Set(nodes.flatMap((n) => nodeDocsOf(n)))];
	const decided = decisionsOf(plan).filter((d) => typeof d.answer === "string" && d.answer.trim());
	return [
		`PLAN STAGE: build ${unit.name}`,
		NO_TOOLS,
		`Write the SSL procedure ${unit.name} from the spec, following the skill ssl-new-procedure. It must really do each step below: no placeholder, no commented-out call, no "implement this later". Call only what exists below or what the spec says will be built. If you need a fact only the user knows, do not guess: reply with a block between lines <<<QUESTIONS and >>>QUESTIONS holding a JSON list of {"question":"..."}.`,
		"Otherwise reply with that procedure only, its doc comment included, in one ```ssl block. Do not reprint other procedures.",
		"",
		"THE UNIT:",
		JSON.stringify({ name: unit.name, script: unit.script, parameters: unit.parameters, calls: unit.calls }),
		...(changing ? ["", changing] : []),
		...(nodes.length
			? [
					"",
					"THE STEPS IT CARRIES OUT, FROM THE CHART:",
					...nodes.map((n) => {
						const stepDocs = nodeDocsOf(n);
						return `- ${n.text}${n.notes ? ` (${n.notes})` : ""}${stepDocs.length ? ` [docs: ${stepDocs.join(", ")}]` : ""}`;
					}),
				]
			: []),
		...(refDocs.length ? ["", `Referenced docs: ${refDocs.join(", ")}`] : []),
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
export function reviewPrompt(plan: Plan, spec: string, scripts: { path: string; text: string }[], only?: string[]): string {
	return [
		"PLAN STAGE: second opinion",
		"You did not write this code, and you cannot read files: all of it is below. Do not ask for a file, and do not call any tool: none can help. Read it against the chart and the spec, and say what is missing or wrong, most serious first. Say which chart step each point concerns. Say whether each step of the chart is really carried out. Do not state rules of the language you are not sure of.",
		...(only ? ["The rest of the chart is already built and is not shown: judge only these steps and this code."] : []),
		"",
		"THE CHART:",
		...plan.nodes.filter((n) => !only || only.includes(n.id)).map((n) => `- ${n.text}${n.notes ? ` (${n.notes})` : ""}`),
		"",
		"THE SPEC:",
		spec,
		"",
		...scripts.flatMap((s) => [`THE SCRIPT ${s.path}:`, "```ssl", s.text, "```", ""]),
	].join("\n");
}
