// Planning mode's stages 4 and 5 (docs/PLANNING-MODE.md): the agent builds from an
// approved spec, one unit at a time and without stopping, and you review the result.
// Nothing is written while it runs: results collect in a pending change set, kept in
// `.ssl-studio/plans/`, so closing the app loses nothing, paid work included.
import { snapshot } from "solid-js";
import { backend, fileExists } from "../backend";
import { agent, currentModel, interrupt, start } from "../agent/store";
import { fenced } from "../agent/tidy";
import { ask as askUser, choose } from "../dialogs";
import { openReview, type Check } from "../editor/Review";
import { monaco } from "../editor/monaco";
import { measure } from "../editor/textmate";
import { session } from "../lsp/session";
import { cut, MAX_WORK_PROMPT_CHARS, ticketForFile } from "../../shared/workContext";
import { docs } from "../project";
import { catalogsKeptFor, workPrompt } from "../projectDocs";
import { applyText, canonical, documents, notify, openFile, setState, state } from "../state";
import { joinPath, relativeTo } from "../../shared/paths";
import { TEMPLATES } from "../../shared/houseStyle";
import { planHash, planHashMatches, specHash } from "./assist";
import { assembleScript, bannerFor, cutShort, DEFAULT_TOKEN_BUDGET, judgeUnit, MAX_ATTEMPTS, modelIsLocal, newRun, nextCostBudget, nextStep, overBudget, patternsFrom, procedureSpans, procedureText, questionIn, raiseBudget, readCostBudget, readSpecFile, requeueRunning, requiredCalls, retryPrompt, reviewPrompt, runFileName, scriptOf, scriptProblem, spentUp, unbuiltNodes, unitPrompt, unwritableUnit, type BuildRun, type BuildUnit, type Edge } from "./build";
import { builtOf, changeText, classifyUnits, recordBuilt, settleBuilt } from "./built";
import { driftFor } from "./drift";
import type { Plan } from "./model";
import { askAgent, begin, latestAssistOf, planOf, savePlan, specPath, survey, updateAssist } from "./run";

export { bannerFor };

const stopping = new Set<string>();
/**
 * The run each build under way is working on, by plan. A build keeps its own copy of the run and publishes it
 * after every step, so a change made to the stored run meanwhile was written over by the build's next step: an
 * answer typed for a stuck unit while the other units were still being built was lost, and the unit never came
 * back into the queue. What is changed during a build is changed in the build's own copy (`mutate`).
 */
const building = new Map<string, BuildRun>();
/** Tool calls in a turn before it is stopped. Nothing here needs any; a skill may take one to load. */
const TOOL_LIMIT = 2;

export const runFile = (path: string, root = snapshot(state).workspace?.root ?? "") =>
	joinPath(root, ".ssl-studio", "plans", runFileName(relativeTo(root, path)));
const plain = <T>(value: T): T => JSON.parse(JSON.stringify(value));

/** The save of each run's file that is under way: the next one waits for it. */
const saving = new Map<string, Promise<unknown>>();

function publish(path: string, run: BuildRun | null, expectedRoot?: string): boolean {
	const root = snapshot(state).workspace?.root;
	if (!root || (expectedRoot && root !== expectedRoot)) return false;
	updateAssist(path, { run: run && plain(run) });
	// One save of a file at a time, in the order they were asked for. A build says where it stands several times in
	// a moment, and two writes of one file at once got in each other's way: one of them failed, and the file could
	// be left holding an older state than the last, or one that does not read, which loses the build's progress.
	const file = runFile(path, root);
	const text = JSON.stringify(run, null, 1);
	const next = (saving.get(file) ?? Promise.resolve()).then(() => backend.write(file, text)).catch(() => notify("Could not save the build's progress.", "error"));
	saving.set(file, next);
	return true;
}

/** Picks a run back up when its plan opens. A unit caught mid-turn goes back to waiting. */
export async function loadRun(path: string) {
	const root = snapshot(state).workspace?.root;
	if (!root || latestAssistOf(path).run) return;
	const text = await backend.read(runFile(path, root)).then(
		(f) => f.text,
		() => null,
	);
	if (!text || snapshot(state).workspace?.root !== root || latestAssistOf(path).run) return;
	try {
		const raw = JSON.parse(text) as Partial<BuildRun> | null;
		const plan = planOf(path);
		if (
			!raw ||
			typeof raw !== "object" ||
			!Array.isArray(raw.units) ||
			!Array.isArray(raw.accepted) ||
			!Array.isArray(raw.map) ||
			!plan ||
			!planHashMatches(raw.planHash, plan)
		) {
			return;
		}
		const run: BuildRun = {
			...(raw as BuildRun),
			// A run saved before layout was left out of the hash holds the older kind. It is of this plan, so it takes
			// the kind that moving a node does not change: the next drag would otherwise put a build already paid for
			// out of reach.
			planHash: planHash(plan),
			units: raw.units.filter((u): u is BuildUnit => Boolean(u && typeof u === "object" && typeof u.name === "string")),
			accepted: raw.accepted.filter((s): s is string => typeof s === "string"),
		};
		for (const unit of run.units) if (unit.status === "running") unit.status = "pending";
		if (run.status === "running") run.status = "stopped";
		updateAssist(path, { run });
		// Accepted, and the plan closed without saving its record: the code is still what was accepted.
		const recorded = new Set((builtOf(plan)?.units ?? []).map((u) => u.name.toLowerCase()));
		for (const script of run.accepted) if (run.units.some((u) => u.status === "passed" && scriptOf(u, plan) === script && !recorded.has(u.name.toLowerCase()))) recordAccepted(path, script, run);
	} catch {
		// Not a run this version can read: a new build starts afresh.
	}
}

/** A script as it stands: its buffer if it is open, so accepted and unsaved work is built on, not overwritten. */
export function readScript(script: string, root = snapshot(state).workspace?.root): Promise<string | null> {
	if (!root) return Promise.resolve(null);
	const full = joinPath(root, script);
	const doc = documents.get(canonical(full)) ?? documents.get(full);
	if (doc) return Promise.resolve(doc.model.getValue());
	return backend.read(full).then(
		(f) => f.text,
		() => null,
	);
}

export const spansIn = async (text: string | null) => (text === null ? [] : procedureSpans(await session.scratchTree(text)));

type Reading = { findings: { code?: string; severity: number; message: string; line: number }[]; symbols: { name: string; parameters: string[] }[]; edges: Edge[]; size: { bytes: number; codeLines: number } };

/** What the language server makes of text that exists nowhere yet. */
export async function read(text: string): Promise<Reading> {
	const { diagnostics, symbols, timedOut } = await session.analyze(text);
	// No answer is not a clean answer: said as a finding, so "no errors" cannot be read from silence.
	if (timedOut) diagnostics.push({ code: "server-timeout", severity: 1, message: "The language server did not answer, so this text was not checked. Try again.", line: 1 });
	const procedures: Reading["symbols"] = [];
	const walk = (list: monaco.languages.DocumentSymbol[]) =>
		list.forEach((s) => (s.kind === monaco.languages.SymbolKind.Function || s.kind === monaco.languages.SymbolKind.Method ? procedures.push({ name: s.name, parameters: (s.children ?? []).map((c) => c.name) }) : walk(s.children ?? [])));
	walk(symbols);
	return { findings: diagnostics, symbols: procedures, edges: await session.scratchCalls(text), size: { bytes: new TextEncoder().encode(text).length, codeLines: measure(text).codeLines } };
}

async function buildUnit(path: string, root: string, plan: Plan, spec: string, run: BuildRun, unit: BuildUnit, callable: string, skills: string[]) {
	if (snapshot(state).workspace?.root !== root) return;
	unit.status = "running";
	delete unit.problems;
	publish(path, run, root);
	const script = scriptOf(unit, plan);
	const existing = await readScript(script, root);
	if (snapshot(state).workspace?.root !== root) return;
	const spans = await spansIn(existing);
	if (snapshot(state).workspace?.root !== root) return;
	const passed = run.units.filter((u) => u.status === "passed");
	const banner = bannerFor(plan);
	const others = passed.filter((u) => scriptOf(u, plan) === script);
	const without = assembleScript(existing, banner, others, plan, spans);
	const was = await read(without);
	if (snapshot(state).workspace?.root !== root) return;
	// Taken away by hand since it was built: written again, as new.
	const current = unit.change && existing !== null ? procedureText(existing, spans, unit.name) : null;
	if (!current) delete unit.change;
	const known = run.units.filter((u) => u.status === "passed" || u.status === "kept");
	const ticketKey = (typeof plan.ticket === "string" && plan.ticket.trim()) || ticketForFile(docs(), path, root);
	const work = ticketKey ? await workPrompt(ticketKey, { specs: false, plans: false }).catch(() => null) : null;
	if (snapshot(state).workspace?.root !== root) return;
	const rawBase = unitPrompt(plan, spec, unit, known, callable, patternsFrom(TEMPLATES), current ? changeText(plan, unit, current) : "");
	const base = work ? `${rawBase}\n\n${work.text}` : rawBase;
	const units = run.units;
	let prompt = base;
	let problems: string[] = [];
	let code: string | null = null;
	for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
		if (snapshot(state).workspace?.root !== root) return;
		unit.attempts = attempt;
		const spent = latestAssistOf(path);
		const before = { tokens: spent.tokens, cost: spent.cost };
		const reply = await askAgent(path, `Build ${unit.name} (try ${attempt} of ${MAX_ATTEMPTS})`, prompt, skills, TOOL_LIMIT);
		if (snapshot(state).workspace?.root !== root) return;
		const now = latestAssistOf(path);
		run.tokens += now.tokens - before.tokens;
		run.cost += now.cost - before.cost;
		if (stopping.has(path)) {
			unit.status = "pending";
			return publish(path, run, root);
		}
		if (reply === null) {
			// A dropped stream cannot recover the turn: it is simply asked again.
			problems = ["The agent did not finish its turn."];
			continue;
		}
		code = fenced(reply, "ssl").at(-1) ?? null;
		const question = code ? null : questionIn(reply);
		if (question && !unit.answer) {
			unit.status = "stuck";
			unit.question = question;
			unit.problems = [`It needs your answer: ${question}`];
			return publish(path, run, root);
		}
		const withUnit = code ? await read(assembleScript(existing, banner, [...others, { ...unit, code }], plan, spans)) : null;
		if (snapshot(state).workspace?.root !== root) return;
		problems = judgeUnit({
			unit,
			code,
			before: was.findings,
			after: withUnit?.findings ?? was.findings,
			existing: current ? was.symbols.filter((s) => s.name.toLowerCase() !== unit.name.toLowerCase()) : was.symbols,
			symbols: withUnit?.symbols ?? [],
			edges: withUnit?.edges ?? [],
			planned: units.map((u) => u.name),
			mustCall: session.supports("ssl/callGraph") ? requiredCalls(unit, plan, units).filter((c) => c.toLowerCase() !== unit.name.toLowerCase()) : [],
			size: withUnit?.size ?? was.size,
			limits: snapshot(state).settings.limits,
		});
		if (!problems.length) {
			const options = { tabSize: 4, insertSpaces: false };
			unit.code = await session.formatText(code!, options).catch(() => code!);
			if (snapshot(state).workspace?.root !== root) return;
			unit.status = "passed";
			delete unit.draft;
			return publish(path, run, root);
		}
		// Out of budget with tries still to come: it waits, and is not stuck (`cutShort`).
		if (cutShort(run, attempt)) {
			unit.status = "pending";
			return publish(path, run, root);
		}
		prompt = retryPrompt(base, code, problems);
	}
	unit.status = "stuck";
	unit.problems = problems;
	if (code) unit.draft = code;
	publish(path, run, root);
}

async function secondOpinion(path: string, root: string, plan: Plan, spec: string, run: BuildRun) {
	if (snapshot(state).workspace?.root !== root) return;
	const passed = run.units.filter((u) => u.status === "passed");
	if (!passed.length || overBudget(run)) return;
	const scripts: { path: string; text: string }[] = [];
	for (const script of new Set(passed.map((u) => scriptOf(u, plan)))) scripts.push({ path: script, text: assembleScript(null, "", passed.filter((u) => scriptOf(u, plan) === script), plan) });
	const spent = latestAssistOf(path);
	const before = { tokens: spent.tokens, cost: spent.cost };
	// Rebuilding part of a chart: the rest is not in front of the reader, so it is not asked about.
	const partial = run.units.some((u) => u.status === "kept" || u.change);
	const ticketKey = (typeof plan.ticket === "string" && plan.ticket.trim()) || ticketForFile(docs(), path, root);
	const work = ticketKey ? await workPrompt(ticketKey, { specs: false, plans: false }).catch(() => null) : null;
	if (snapshot(state).workspace?.root !== root) return;
	const workContext = work?.text ? cut(work.text, MAX_WORK_PROMPT_CHARS) : "";
	const review = reviewPrompt(plan, spec, scripts, partial ? passed.flatMap((u) => u.nodes ?? []) : undefined);
	const reply = await askAgent(path, "A second opinion", workContext ? `${review}\n\n${workContext}` : review, [], TOOL_LIMIT);
	if (snapshot(state).workspace?.root !== root) return;
	const now = latestAssistOf(path);
	run.tokens += now.tokens - before.tokens;
	run.cost += now.cost - before.cost;
	if (reply?.trim()) run.review = reply.trim();
	else delete run.review;
}

/** Stage 4. Runs unattended from an approved spec, or carries on from where a run stopped. */
export function startBuild(path: string) {
	/** What to do when this build is over, however it ends. Nothing, for a call that never became a build. */
	let ended = () => {};
	return begin(path, "build", async () => {
		const root = snapshot(state).workspace?.root;
		if (!root) return;
		const plan = planOf(path);
		if (!plan) return notify("Fix the plan's text first.");
		const specText = await backend.read(specPath(path)).then(
			(f) => f.text,
			() => null,
		);
		if (snapshot(state).workspace?.root !== root) return;
		if (!specText) return notify("Write and approve a plan doc first.");
		const hash = planHash(plan);
		if (!planHashMatches(specHash(specText), plan)) return notify("The plan has changed since its plan doc was approved. Write the plan doc again first.");
		const { units, map } = readSpecFile(specText);
		if (!units.length && !builtOf(plan)) return notify("The spec lists nothing to build.");
		// Before opencode is started or anything is asked: a script this build may not write (`scriptProblem`). A run
		// already begun holds the scripts it was begun with, so correcting the plan doc does not reach it.
		const cannotWrite = (units: Parameters<typeof unwritableUnit>[0], begun = false) => {
			const refused = unwritableUnit(units, plan);
			if (refused) notify(`The build cannot write ${refused.script}, where ${refused.unit} is to go: ${refused.why}. ${begun ? "Discard this build, and correct" : "Correct"} the plan doc or the plan's target scripts.`, "error");
			return Boolean(refused);
		};
		const stored = latestAssistOf(path).run;
		if (stored && planHashMatches(stored.planHash, plan) ? cannotWrite(stored.units, true) : cannotWrite(units)) return;
		// Whether the model costs money is read from opencode's list of models, and on a fresh launch nothing has asked
		// for that list yet: it was empty here, the chosen model was not found in it, and a model not found counted as
		// local, so a build on a paid model began with no cost budget. opencode is started first, as the first turn
		// would have started it anyway.
		if (snapshot(agent).status.state !== "ready" || !snapshot(agent).models.length) await start();
		if (snapshot(state).workspace?.root !== root) return;
		const opencode = snapshot(agent).status;
		if (opencode.state !== "ready") return notify(opencode.message || "opencode is not ready, so nothing can be built.", "error");
		const model = currentModel();
		// With no model chosen and no local one found, opencode refuses the turn: it never falls back on a paid model.
		const local = !model || modelIsLocal(snapshot(agent).models, model, snapshot(state).settings.agentOwnModels);
		const carriesOn = (r: BuildRun | null): r is BuildRun => Boolean(r && planHashMatches(r.planHash, plan));
		const before = latestAssistOf(path).run;
		let cost: number | undefined;
		// Asked for a new run, and for one carried on that has no cost budget: it was begun on a local model, or
		// before the model was known to be one that may cost money.
		if (!local && !(carriesOn(before) && before.budget.cost !== undefined)) {
			const answer = await askUser(`${model} may cost money. Stop the build at what cost?`, "1");
			if (snapshot(state).workspace?.root !== root || answer === null) return;
			cost = Number(answer);
			if (!Number.isFinite(cost) || cost <= 0) return notify("Give the budget as a number above zero.");
		}
		// A run that stopped at its budget is carried on only when it is given more (`spentUp`), and that is asked
		// for here, each time, since it spends money: a cost is a number to give; more tokens, a yes or a no.
		const carried = carriesOn(before) ? before : null;
		const short = carried && spentUp(carried);
		let moreTokens = false;
		if (carried && short?.cost && cost === undefined) {
			const answer = await askUser(`The build has spent ${carried.cost.toFixed(2)}, and its budget was ${carried.budget.cost}. Stop it at what cost now?`, String(nextCostBudget(carried)));
			if (snapshot(state).workspace?.root !== root || answer === null) return;
			const raised = readCostBudget(answer, carried.cost);
			if (raised === null) return notify(`Give the new budget as a number above the ${carried.cost.toFixed(2)} already spent.`);
			cost = raised;
		}
		if (carried && short?.tokens) {
			const CARRY_ON = "Carry on";
			const answer = await choose(`The build has used ${carried.tokens.toLocaleString()} tokens, and its budget was ${carried.budget.tokens.toLocaleString()}. Carry on for up to ${DEFAULT_TOKEN_BUDGET.toLocaleString()} more?`, [CARRY_ON]);
			if (snapshot(state).workspace?.root !== root || answer !== CARRY_ON) return;
			moreTokens = true;
		}
		// Read after the question, not before it: what was changed in the run while the question was open is in it.
		const held = latestAssistOf(path).run;
		let run: BuildRun;
		if (carriesOn(held)) {
			run = plain(held);
			// A run from before layout was left out of the hash holds the older kind. It is of this plan, so it takes
			// the kind that moving a node does not change.
			run.planHash = hash;
			raiseBudget(run, { cost, tokens: moreTokens });
			requeueRunning(run);
		} else {
			run = newRun({ hash, model }, units, map, cost === undefined ? {} : { cost });
			classifyUnits(run, plan, driftFor((documents.get(canonical(path)) ?? documents.get(path))?.model.uri.toString()).moved);
			// What is already built is built where it is now, which the plan's own record says: the same rule holds there.
			if (cannotWrite(run.units)) return;
		}
		building.set(path, run);
		ended = () => {
			if (building.get(path) === run) building.delete(path);
			// However the build ended, nothing is being built now. A build that left without saying so (the folder was
			// changed under it, or something outside a unit threw) must not leave the run saying that it is.
			const stored = latestAssistOf(path).run;
			if (!stored || (stored.status !== "running" && !stored.units.some((u) => u.status === "running"))) return;
			requeueRunning(run);
			if (run.status === "running") run.status = "stopped";
			// The file is the other folder's to write when the folder has changed: only what is shown is put right.
			if (!publish(path, run, root)) updateAssist(path, { run: plain(run) });
		};
		stopping.delete(path);
		run.status = "running";
		const skills = ((await backend.agent("skills", []).catch(() => [])) as { id: string }[]).map((s) => s.id);
		if (snapshot(state).workspace?.root !== root) return;
		if (!skills.includes("ssl-new-procedure")) return notify("The style guide's ssl-new-procedure skill is not installed, and building needs it.", "error");
		updateAssist(path, { progress: "Surveying the workspace…" });
		const callable = await survey(plan);
		if (snapshot(state).workspace?.root !== root) return;
		const spec = specText.split("\n## Units")[0]!.trim();
		publish(path, run, root);
		/** Whether this call has built anything: the second opinion is on what was built, and is asked again only for more. */
		let builtNow = false;
		for (;;) {
			if (snapshot(state).workspace?.root !== root) {
				stopping.delete(path);
				return;
			}
			if (stopping.has(path)) {
				run.status = "stopped";
				break;
			}
			const next = nextStep(run);
			if ("ends" in next) {
				run.status = next.ends;
				if (next.ends === "budget") notify("The build reached its budget and has stopped. Carrying on spends more.");
				break;
			}
			const unit = next.unit;
			try {
				await buildUnit(path, root, plan, spec, run, unit, callable, ["ssl-new-procedure"]);
				builtNow = true;
			} catch (e: any) {
				// A unit is marked as being built before its first turn. When building it threw (the language server
				// gone, a script that could not be read), it stayed marked for the rest of the session: nothing took
				// it up again, and the run ended "built" with the unit still shown as building. It is stuck, with the
				// reason, so it can be tried again. The build stops here: what threw once is likely to throw for the
				// next unit too, after another turn has been spent on it.
				unit.status = "stuck";
				unit.problems = [`It could not be built: ${e?.message ?? e}`];
				run.status = "stopped";
				notify(`The build stopped at ${unit.name}: ${e?.message ?? e}`, "error");
				break;
			}
		}
		if (snapshot(state).workspace?.root !== root) {
			stopping.delete(path);
			return;
		}
		// "Carry on building" is offered on a run that has finished too. With nothing left to build it built nothing,
		// and still asked for the second opinion it already had: a turn of the model, and its cost, for each click.
		if (run.status === "built" && (builtNow || !run.review)) {
			updateAssist(path, { progress: "Asking for a second opinion…" });
			await secondOpinion(path, root, plan, spec, run);
		}
		if (snapshot(state).workspace?.root !== root) {
			stopping.delete(path);
			return;
		}
		publish(path, run, root);
		stopping.delete(path);
		if (run.status === "built" && run.units.every((u) => u.status === "kept")) {
			const latest = planOf(path);
			if (latest) savePlan(path, settleBuilt(latest, run));
			notify("Nothing in the code needed to change. The chart is recorded as built.");
		} else if (run.status === "built") {
			const stuck = run.units.filter((u) => u.status !== "passed" && u.status !== "kept").length;
			notify(stuck ? `The build is done, but ${stuck} ${stuck === 1 ? "unit is" : "units are"} stuck. Nothing has been written.` : "The build is ready to review. Nothing has been written.");
		}
	}).finally(() => ended());
}

export function stopBuild(path: string) {
	stopping.add(path);
	void interrupt();
}

const mutate = (path: string, change: (run: BuildRun) => void): BuildRun | null => {
	const live = building.get(path);
	if (live) {
		change(live);
		return publish(path, live) ? plain(live) : null;
	}
	const current = latestAssistOf(path).run;
	if (!current) return null;
	const run = plain(current);
	change(run);
	return publish(path, run) ? run : null;
};

/** Puts a stuck unit, and those waiting on it, back in the queue. */
export function retryUnit(path: string, name: string) {
	mutate(path, (run) => {
		for (const unit of run.units) {
			if (unit.name === name || unit.status === "skipped") {
				unit.status = "pending";
				delete unit.problems;
			}
		}
	});
}

export function answerUnit(path: string, name: string, answer: string) {
	mutate(path, (run) => {
		const unit = run.units.find((u) => u.name === name);
		if (!unit || !answer.trim()) return;
		unit.answer = answer.trim();
		unit.status = "pending";
		delete unit.problems;
		for (const other of run.units) {
			if (other.status === "skipped") {
				other.status = "pending";
				delete other.problems;
			}
		}
	});
}

export const discardRun = (path: string) => publish(path, null);

export const scriptsToReview = (run: BuildRun, plan: Plan): string[] => [...new Set(run.units.filter((u) => u.status === "passed").map((u) => scriptOf(u, plan)))].filter((s) => !run.accepted.includes(s));

/** The links, in the plan's text: an undoable edit, saved when you save the plan. */
function recordAccepted(path: string, script: string, runOverride?: BuildRun | null) {
	const plan = planOf(path);
	const run = runOverride ?? latestAssistOf(path).run;
	if (!plan || !run) return;
	const accepted = run.units.filter((u) => u.status === "passed" && scriptOf(u, plan) === script);
	const recorded = recordBuilt(plan, plain(accepted), plain(run.units));
	const finished = !scriptsToReview(run, plan).length && run.units.every((u) => u.status === "passed" || u.status === "kept");
	savePlan(path, finished ? settleBuilt(recorded, run) : recorded);
}

/** Stage 5: one review per script, walked in turn. Nothing is applied until you accept it. */
export async function reviewBuild(path: string) {
	const root = snapshot(state).workspace?.root;
	const current = latestAssistOf(path).run;
	const plan = planOf(path);
	if (!root || !current || !plan) return;
	const run = plain(current);
	const script = scriptsToReview(run, plan)[0];
	if (!script) return notify("Nothing is waiting for review.");
	// Accepting writes the file, or rewrites it in the editor. A build begun before its scripts were checked, or
	// whose plan has had its target scripts changed since, can still name one it may not write.
	const why = scriptProblem(script);
	if (why) return notify(`The build cannot write ${script}: ${why}. Correct the plan's target scripts, or discard this build and write the plan doc again.`, "error");
	const existing = await readScript(script, root);
	if (snapshot(state).workspace?.root !== root) return;
	const passed = run.units.filter((u) => u.status === "passed" && scriptOf(u, plan) === script);
	const spans = await spansIn(existing);
	if (snapshot(state).workspace?.root !== root) return;
	const proposed = assembleScript(existing, bannerFor(plan), passed, plan, spans);
	const reading = await read(proposed);
	if (snapshot(state).workspace?.root !== root) return;
	const unresolved = reading.edges.filter((e) => !e.resolved).map((e) => e.target);
	const unbuilt = unbuiltNodes(plan, run);
	const local = snapshot(agent).models.find((m) => `${m.providerID}/${m.id}` === run.model)?.local ?? true;
	const checks: Check[] = [
		{ label: "Every step of the chart is built", ok: !unbuilt.length, detail: unbuilt.length ? `nothing yet for ${unbuilt.map((t) => `"${t}"`).join(", ")}` : undefined },
		{ label: "Every call resolves", ok: !unresolved.length, detail: unresolved.length ? [...new Set(unresolved)].join(", ") : undefined },
		{ label: "No errors", ok: !reading.findings.some((f) => f.severity === 1), detail: `${reading.findings.filter((f) => f.severity <= 2).length} errors and warnings` },
		{ label: "This code has not been run", ok: null, detail: "SSL Studio cannot run SSL. Test it in STARLIMS." },
		...(local ? [{ label: "A draft from a local model", ok: null, detail: `${run.model}: read it as you would a first attempt` }] : []),
	];
	const left = scriptsToReview(run, plan).length;
	openReview({
		title: `Build: ${script}${left > 1 ? ` (1 of ${left})` : ""}`,
		original: existing ?? "",
		proposed,
		language: "ssl",
		checks,
		note: run.review ? `A second opinion, which may be wrong:\n\n${run.review}` : undefined,
		acceptLabel: existing === null ? "Accept and create the file" : "Accept into the editor",
		onAccept: async (final) => {
			if (snapshot(state).workspace?.root !== root) return;
			// The plan records this, so it must be open; the script is what you see afterwards.
			if (!planOf(path)) await openFile(path);
			if (snapshot(state).workspace?.root !== root) return;
			const full = joinPath(root, script);
			const openNow = documents.has(canonical(full)) || documents.has(full);
			const existsNow =
				openNow ||
				(await fileExists(full));
			if (snapshot(state).workspace?.root !== root) return;
			if (!existsNow) {
				await backend.write(full, final);
				if (snapshot(state).workspace?.root !== root) return;
				setState((s) => {
					s.treeVersion += 1;
				});
				void catalogsKeptFor([full]);
				await openFile(full);
			} else {
				await openFile(full);
				if (snapshot(state).workspace?.root !== root) return;
				applyText(monaco.Uri.file(full).fsPath, final);
			}
			if (snapshot(state).workspace?.root !== root) return;
			const after = mutate(path, (r) => {
				if (!r.accepted.includes(script)) r.accepted.push(script);
			});
			recordAccepted(path, script, after);
			notify(!existsNow ? `Created ${script}.` : `Applied to ${script}. Review and save it; undo reverts it.`);
			const latestPlan = planOf(path) ?? plan;
			if (after && scriptsToReview(after, latestPlan).length) void reviewBuild(path);
		},
		onReject: async () => {
			if (snapshot(state).workspace?.root !== root) return;
			const reason = await askUser(`What is wrong with ${script}? It goes back to the agent with your reason. Empty keeps it for later.`);
			if (snapshot(state).workspace?.root !== root || !reason?.trim()) return;
			mutate(path, (r) => {
				for (const unit of r.units) {
					if (unit.status === "passed" && scriptOf(unit, plan) === script) {
						unit.status = "pending";
						unit.feedback = reason.trim();
						delete unit.code;
					}
				}
				r.status = "stopped";
				delete r.review;
			});
		},
	});
}
