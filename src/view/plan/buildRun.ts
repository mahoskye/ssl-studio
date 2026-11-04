// Planning mode's stages 4 and 5 (docs/PLANNING-MODE.md): the agent builds from an
// approved spec, one unit at a time and without stopping, and you review the result.
// Nothing is written while it runs: results collect in a pending change set, kept in
// `.ssl-studio/plans/`, so closing the app loses nothing, paid work included.
import { backend } from "../backend";
import { agent, currentModel, interrupt } from "../agent/store";
import { fenced } from "../agent/tidy";
import { ask as askUser } from "../dialogs";
import { openReview, type Check } from "../editor/Review";
import { monaco } from "../editor/monaco";
import { measure } from "../editor/textmate";
import { session } from "../lsp/session";
import { applyText, canonical, documents, notify, openFile, setState, state } from "../state";
import { baseName, joinPath } from "../../shared/paths";
import { bannerTemplate, TEMPLATES } from "../../shared/houseStyle";
import { planHash, specHash } from "./assist";
import { assembleScript, judgeUnit, MAX_ATTEMPTS, newRun, nextUnit, overBudget, patternsFrom, procedureSpans, procedureText, questionIn, readSpecFile, requiredCalls, retryPrompt, reviewPrompt, scriptOf, unbuiltNodes, unitPrompt, type BuildRun, type BuildUnit, type Edge } from "./build";
import { builtOf, changeText, classifyUnits, recordBuilt, settleBuilt } from "./built";
import { driftFor } from "./drift";
import type { Plan } from "./model";
import { askAgent, assistOf, begin, planOf, savePlan, specPath, survey, updateAssist } from "./run";

const stopping = new Set<string>();
/** Tool calls in a turn before it is stopped. Nothing here needs any; a skill may take one to load. */
const TOOL_LIMIT = 2;

const runFile = (path: string) => joinPath(state.workspace!.root, ".ssl-studio", "plans", `${baseName(path).replace(/\.plan\.json$/i, "")}.run.json`);
const plain = <T>(value: T): T => JSON.parse(JSON.stringify(value));

function publish(path: string, run: BuildRun | null) {
	updateAssist(path, { run: run && plain(run) });
	void backend.write(runFile(path), JSON.stringify(run, null, 1)).catch(() => notify("Could not save the build's progress.", "error"));
}

/** Picks a run back up when its plan opens. A unit caught mid-turn goes back to waiting. */
export async function loadRun(path: string) {
	if (!state.workspace || assistOf(path).run) return;
	const text = await backend.read(runFile(path)).then(
		(f) => f.text,
		() => null,
	);
	if (!text) return;
	try {
		const run = JSON.parse(text) as BuildRun | null;
		const plan = planOf(path);
		if (!run || !plan || run.planHash !== planHash(plan)) return;
		for (const unit of run.units) if (unit.status === "running") unit.status = "pending";
		if (run.status === "running") run.status = "stopped";
		updateAssist(path, { run });
		// Accepted, and the plan closed without saving its record: the code is still what was accepted.
		const recorded = new Set((builtOf(plan)?.units ?? []).map((u) => u.name.toLowerCase()));
		for (const script of run.accepted) if (run.units.some((u) => u.status === "passed" && scriptOf(u, plan) === script && !recorded.has(u.name.toLowerCase()))) recordAccepted(path, script);
	} catch {
		// Not a run this version can read: a new build starts afresh.
	}
}

/** A script as it stands: its buffer if it is open, so accepted and unsaved work is built on, not overwritten. */
export function readScript(script: string): Promise<string | null> {
	const full = joinPath(state.workspace!.root, script);
	const doc = documents.get(canonical(full));
	if (doc) return Promise.resolve(doc.model.getValue());
	return backend.read(full).then(
		(f) => f.text,
		() => null,
	);
}

export const spansIn = async (text: string | null) => (text === null ? [] : procedureSpans(await session.scratchTree(text)));

function bannerFor(plan: Plan) {
	const goal = typeof plan.goal === "string" && plan.goal ? plan.goal : plan.title;
	return bannerTemplate().replace("${1}", goal).replace(/\$\{\d+:([^}]*)\}/g, "$1");
}

type Reading = { findings: { code?: string; severity: number; message: string; line: number }[]; symbols: { name: string; parameters: string[] }[]; edges: Edge[]; size: { bytes: number; codeLines: number } };

/** What the language server makes of text that exists nowhere yet. */
export async function read(text: string): Promise<Reading> {
	const { diagnostics, symbols } = await session.analyze(text);
	const procedures: Reading["symbols"] = [];
	const walk = (list: monaco.languages.DocumentSymbol[]) =>
		list.forEach((s) => (s.kind === monaco.languages.SymbolKind.Function || s.kind === monaco.languages.SymbolKind.Method ? procedures.push({ name: s.name, parameters: (s.children ?? []).map((c) => c.name) }) : walk(s.children ?? [])));
	walk(symbols);
	return { findings: diagnostics, symbols: procedures, edges: await session.scratchCalls(text), size: { bytes: new TextEncoder().encode(text).length, codeLines: measure(text).codeLines } };
}

async function buildUnit(path: string, plan: Plan, spec: string, run: BuildRun, unit: BuildUnit, callable: string, skills: string[]) {
	unit.status = "running";
	delete unit.problems;
	publish(path, run);
	const script = scriptOf(unit, plan);
	const existing = await readScript(script);
	const spans = await spansIn(existing);
	const passed = run.units.filter((u) => u.status === "passed");
	const banner = bannerFor(plan);
	const others = passed.filter((u) => scriptOf(u, plan) === script);
	const without = assembleScript(existing, banner, others, plan, spans);
	const was = await read(without);
	// Taken away by hand since it was built: written again, as new.
	const current = unit.change && existing !== null ? procedureText(existing, spans, unit.name) : null;
	if (!current) delete unit.change;
	const known = run.units.filter((u) => u.status === "passed" || u.status === "kept");
	const base = unitPrompt(plan, spec, unit, known, callable, patternsFrom(TEMPLATES), current ? changeText(plan, unit, current) : "");
	const units = run.units;
	let prompt = base;
	let problems: string[] = [];
	let code: string | null = null;
	for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
		unit.attempts = attempt;
		const spent = assistOf(path);
		const before = { tokens: spent.tokens, cost: spent.cost };
		const reply = await askAgent(path, `Build ${unit.name} (try ${attempt} of ${MAX_ATTEMPTS})`, prompt, skills, TOOL_LIMIT);
		const now = assistOf(path);
		run.tokens += now.tokens - before.tokens;
		run.cost += now.cost - before.cost;
		if (stopping.has(path)) {
			unit.status = "pending";
			return publish(path, run);
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
			return publish(path, run);
		}
		const withUnit = code ? await read(assembleScript(existing, banner, [...others, { ...unit, code }], plan, spans)) : null;
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
			limits: state.settings.limits,
		});
		if (!problems.length) {
			const options = { tabSize: 4, insertSpaces: false };
			unit.code = await session.formatText(code!, options).catch(() => code!);
			unit.status = "passed";
			delete unit.draft;
			return publish(path, run);
		}
		if (overBudget(run)) break;
		prompt = retryPrompt(base, code, problems);
	}
	unit.status = "stuck";
	unit.problems = problems;
	if (code) unit.draft = code;
	publish(path, run);
}

async function secondOpinion(path: string, plan: Plan, spec: string, run: BuildRun) {
	const passed = run.units.filter((u) => u.status === "passed");
	if (!passed.length || overBudget(run)) return;
	const scripts: { path: string; text: string }[] = [];
	for (const script of new Set(passed.map((u) => scriptOf(u, plan)))) scripts.push({ path: script, text: assembleScript(null, "", passed.filter((u) => scriptOf(u, plan) === script), plan) });
	const spent = assistOf(path);
	const before = { tokens: spent.tokens, cost: spent.cost };
	// Rebuilding part of a chart: the rest is not in front of the reader, so it is not asked about.
	const partial = run.units.some((u) => u.status === "kept" || u.change);
	const reply = await askAgent(path, "A second opinion", reviewPrompt(plan, spec, scripts, partial ? passed.flatMap((u) => u.nodes ?? []) : undefined), [], TOOL_LIMIT);
	const now = assistOf(path);
	run.tokens += now.tokens - before.tokens;
	run.cost += now.cost - before.cost;
	if (reply?.trim()) run.review = reply.trim();
	else delete run.review;
}

/** Stage 4. Runs unattended from an approved spec, or carries on from where a run stopped. */
export function startBuild(path: string) {
	return begin(path, "build", async () => {
		const plan = planOf(path);
		if (!plan) return notify("Fix the plan's text first.");
		const specText = await backend.read(specPath(path)).then(
			(f) => f.text,
			() => null,
		);
		if (!specText) return notify("Write and approve a spec first.");
		const hash = planHash(plan);
		if (specHash(specText) !== hash) return notify("The plan has changed since its spec was approved. Write the spec again first.");
		const { units, map } = readSpecFile(specText);
		if (!units.length && !builtOf(plan)) return notify("The spec lists nothing to build.");
		const model = currentModel();
		const local = agent.models.find((m) => `${m.providerID}/${m.id}` === model)?.local ?? true;
		let run: BuildRun | null = assistOf(path).run ? plain(assistOf(path).run) : null;
		if (!run || run.planHash !== hash) {
			let cost: number | undefined;
			if (!local) {
				const answer = await askUser(`${model} may cost money. Stop the build at what cost?`, "1");
				if (answer === null) return;
				cost = Number(answer);
				if (!Number.isFinite(cost) || cost <= 0) return notify("Give the budget as a number above zero.");
			}
			run = newRun({ hash, model }, units, map, cost === undefined ? {} : { cost });
			classifyUnits(run, plan, driftFor(documents.get(path)?.model.uri.toString()).moved);
		}
		stopping.delete(path);
		run.status = "running";
		const skills = ((await backend.agent("skills", []).catch(() => [])) as { id: string }[]).map((s) => s.id);
		if (!skills.includes("ssl-new-procedure")) return notify("The style guide's ssl-new-procedure skill is not installed, and building needs it.", "error");
		updateAssist(path, { progress: "Surveying the workspace…" });
		const callable = await survey(plan);
		const spec = specText.split("\n## Units")[0]!.trim();
		publish(path, run);
		for (;;) {
			if (stopping.has(path)) {
				run.status = "stopped";
				break;
			}
			if (overBudget(run)) {
				run.status = "budget";
				notify("The build reached its budget and has stopped. Carrying on spends more.");
				break;
			}
			const unit = nextUnit(run);
			if (!unit) {
				run.status = "built";
				break;
			}
			await buildUnit(path, plan, spec, run, unit, callable, ["ssl-new-procedure"]);
		}
		if (run.status === "built") {
			updateAssist(path, { progress: "Asking for a second opinion…" });
			await secondOpinion(path, plan, spec, run);
		}
		publish(path, run);
		stopping.delete(path);
		if (run.status === "built" && run.units.every((u) => u.status === "kept")) {
			savePlan(path, settleBuilt(plan, run));
			notify("Nothing in the code needed to change. The chart is recorded as built.");
		} else if (run.status === "built") {
			const stuck = run.units.filter((u) => u.status !== "passed" && u.status !== "kept").length;
			notify(stuck ? `The build is done, but ${stuck} ${stuck === 1 ? "unit is" : "units are"} stuck. Nothing has been written.` : "The build is ready to review. Nothing has been written.");
		}
	});
}

export function stopBuild(path: string) {
	stopping.add(path);
	void interrupt();
}

const mutate = (path: string, change: (run: BuildRun) => void) => {
	const current = assistOf(path).run;
	if (!current) return;
	const run = plain(current);
	change(run);
	publish(path, run);
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
function recordAccepted(path: string, script: string) {
	const plan = planOf(path);
	const run = assistOf(path).run;
	if (!plan || !run) return;
	const accepted = run.units.filter((u) => u.status === "passed" && scriptOf(u, plan) === script);
	const recorded = recordBuilt(plan, plain(accepted), plain(run.units));
	const finished = !scriptsToReview(run, plan).length && run.units.every((u) => u.status === "passed" || u.status === "kept");
	savePlan(path, finished ? settleBuilt(recorded, run) : recorded);
}

/** Stage 5: one review per script, walked in turn. Nothing is applied until you accept it. */
export async function reviewBuild(path: string) {
	const current = assistOf(path).run;
	const plan = planOf(path);
	if (!current || !plan) return;
	const run = plain(current);
	const script = scriptsToReview(run, plan)[0];
	if (!script) return notify("Nothing is waiting for review.");
	const existing = await readScript(script);
	const passed = run.units.filter((u) => u.status === "passed" && scriptOf(u, plan) === script);
	const proposed = assembleScript(existing, bannerFor(plan), passed, plan, await spansIn(existing));
	const reading = await read(proposed);
	const unresolved = reading.edges.filter((e) => !e.resolved).map((e) => e.target);
	const unbuilt = unbuiltNodes(plan, run);
	const local = agent.models.find((m) => `${m.providerID}/${m.id}` === run.model)?.local ?? true;
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
			// The plan records this, so it must be open; the script is what you see afterwards.
			if (!planOf(path)) await openFile(path);
			const full = joinPath(state.workspace!.root, script);
			if (existing === null) {
				await backend.write(full, final);
				setState("treeVersion", (v) => v + 1);
				await openFile(full);
			} else {
				await openFile(full);
				applyText(monaco.Uri.file(full).fsPath, final);
			}
			mutate(path, (r) => r.accepted.push(script));
			recordAccepted(path, script);
			notify(existing === null ? `Created ${script}.` : `Applied to ${script}. Review and save it; undo reverts it.`);
			const after = assistOf(path).run;
			if (after && scriptsToReview(after, plan).length) void reviewBuild(path);
		},
		onReject: async () => {
			const reason = await askUser(`What is wrong with ${script}? It goes back to the agent with your reason. Empty keeps it for later.`);
			if (!reason?.trim()) return;
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
