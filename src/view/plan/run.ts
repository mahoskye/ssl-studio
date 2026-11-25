// Planning mode's stages 2 and 3 (docs/PLANNING-MODE.md): SSL Studio surveys the
// workspace, the agent asks and suggests, then writes a spec for review. The code
// is not touched here. As in the tidy steps, the agent has no file tools: what it
// needs arrives in the prompt, and what it returns is applied after you agree.
import { createStore, snapshot } from "solid-js";
import { backend } from "../backend";
import { ask, agent, currentModel, interrupt, start } from "../agent/store";
import { openReview, type Check } from "../editor/Review";
import { monaco } from "../editor/monaco";
import { session } from "../lsp/session";
import { describeElement } from "../panels/Reference";
import { applyText, canonical, documents, keepTab, notify, setState, state } from "../state";
import { workPrompt } from "../projectDocs";
import { joinPath, relativeTo } from "../../shared/paths";
import { addQuestions, answerQuestion, applySuggestion, formatSurvey, isAllowedContextPath, looksCut, nounsOf, openQuestions, overLimit, parseContext, parseQuestions, parseSpec, parseSuggestions, planHash, planHashMatches, planTargetsOf, printSpec, readBlocks, refinePrompt, specHash, specPrompt, unaccounted, type ContextRequest, type Suggestion, type Survey } from "./assist";
import type { BuildRun } from "./build";
import { revisionText, settledNodes } from "./built";
import { parsePlan, printPlan, type Plan } from "./model";

export { isAllowedContextPath };

export type AssistState = { running: "" | "refine" | "spec" | "build" | "tests"; progress: string; warnings: string[]; suggestions: Suggestion[]; tokens: number; cost: number; specVersion: number; run: BuildRun | null };
const blank = (): AssistState => ({ running: "", progress: "", warnings: [], suggestions: [], tokens: 0, cost: 0, specVersion: 0, run: null });

const [assists, setAssists] = createStore<Record<string, AssistState>>({});
const newIds = new Map<string, Map<string, string>>();

export const assistOf = (path: string): AssistState => assists[path] ?? blank();
export const latestAssistOf = (path: string): AssistState => snapshot(assists)[path] ?? blank();
const update = (path: string, patch: Partial<AssistState>) => {
	setAssists((s) => {
		const cur = (s[path] ??= blank());
		Object.assign(cur, patch);
	});
};
export const updateAssist = update;

/** The companion plan doc (`<Name>.plan.md`) beside a plan's flowchart (`<Name>.plan.json`, ADR 0033). */
export const planDocPath = (planPath: string) => planPath.replace(/\.plan\.json$/i, ".plan.md");
export const specPath = planDocPath;

export const planOf = (path: string): Plan | undefined => {
	const doc = documents.get(canonical(path)) ?? documents.get(path);
	return doc ? parsePlan(doc.model.getValue()).plan : undefined;
};
export const savePlan = (path: string, plan: Plan) => applyText(path, printPlan(plan));
const rel = (path: string, root = snapshot(state).workspace?.root) => relativeTo(root, path);
const PROCEDURES = new Set([6, 12]); // LSP SymbolKind: Method, Function.
const fileOf = (uri: string) => monaco.Uri.parse(uri).fsPath;

/** Lines of a file, read without opening it: looking must not put its findings in Problems. */
async function readLines(uri: string, start: number, end: number): Promise<string | null> {
	const text = await backend.read(fileOf(uri)).then(
		(f) => f.text,
		() => null,
	);
	return text === null ? null : text.split(/\r?\n/).slice(start, end + 1).join("\n");
}

/** Survey before you build: the agent cannot look, so SSL Studio does. */
export async function survey(plan: Plan): Promise<string> {
	const root = snapshot(state).workspace?.root;
	if (!root) return "Nothing in the workspace matched.";
	const found: Survey = { calls: [], targets: [], symbols: [], hits: [], callGraph: [] };
	for (const word of nounsOf(plan)) {
		if (snapshot(state).workspace?.root !== root) return "";
		const symbols = await session.workspaceSymbols(word).catch(() => []);
		if (snapshot(state).workspace?.root !== root) return "";
		for (const s of symbols) {
			const fRel = rel(fileOf(s.location.uri), root);
			if (!isAllowedContextPath(fRel)) continue;
			if (PROCEDURES.has(s.kind) && !found.symbols.some((f) => f.name === s.name)) found.symbols.push({ name: s.name, file: fRel });
		}
		const hits = await backend.search(word, { caseSensitive: false }).catch(() => []);
		if (snapshot(state).workspace?.root !== root) return "";
		for (const h of hits.filter((x) => !/\.(plan\.json|spec\.md|tidy\.md)$/i.test(x.path) && isAllowedContextPath(rel(x.path, root))).slice(0, 3)) {
			found.hits.push({ word, file: rel(h.path, root), line: h.line, text: h.text.trim().slice(0, 120) });
		}
	}
	found.symbols = found.symbols.slice(0, 30);
	found.hits = found.hits.slice(0, 20);
	for (const node of plan.nodes.filter((n) => n.kind === "call" && typeof n.ref === "string" && n.ref.trim())) {
		if (snapshot(state).workspace?.root !== root) return "";
		const name = node.ref!.trim().split(".").filter(Boolean).at(-1);
		if (!name) continue;
		const symbol = (await session.workspaceSymbols(name).catch(() => [])).find((s) => s.name.toLowerCase() === name.toLowerCase());
		if (snapshot(state).workspace?.root !== root) return "";
		if (!symbol || !isAllowedContextPath(rel(fileOf(symbol.location.uri), root))) continue;
		const start = symbol.location.range.start.line;
		const code = await readLines(symbol.location.uri, start, start + 12);
		if (snapshot(state).workspace?.root !== root) return "";
		if (code !== null) found.calls.push({ ref: node.ref!, code: code.trim() });
		if (session.supports("ssl/callGraph")) {
			const graph: any = await session.request("ssl/callGraph", { textDocument: { uri: symbol.location.uri }, procedure: name, depth: 1 }).catch(() => null);
			if (snapshot(state).workspace?.root !== root) return "";
			const names = new Map<string, string>((graph?.nodes ?? []).map((n: any) => [n.id, n.name]));
			for (const e of graph?.edges ?? []) found.callGraph.push(`${names.get(e.from) ?? e.from} calls ${e.target}${e.resolved ? "" : " (unresolved)"}`);
		}
	}
	found.callGraph = [...new Set(found.callGraph)].slice(0, 20);
	for (const target of planTargetsOf(plan)) {
		if (snapshot(state).workspace?.root !== root) return "";
		const text = await backend.read(joinPath(root, target)).then(
			(f) => f.text,
			() => null,
		);
		if (snapshot(state).workspace?.root !== root) return "";
		if (text === null) {
			found.targets.push({ path: target, outline: null });
			continue;
		}
		// Read as scratch text: looking must not put its findings in Problems.
		const lines: string[] = [];
		const walk = (list: monaco.languages.DocumentSymbol[], depth: number) => list.forEach((s) => (lines.push(`${"  ".repeat(depth)}${s.name}`), walk(s.children ?? [], depth + 1)));
		walk((await session.analyze(text).catch(() => ({ symbols: [] }))).symbols, 1);
		if (snapshot(state).workspace?.root !== root) return "";
		found.targets.push({ path: target, outline: lines.join("\n") });
	}
	return formatSurvey(found);
}

const MAX_CONTEXT_CHARS = 8000;

/** Answers an agent's `CONTEXT` block from the workspace and the server. */
async function readContext(requests: ContextRequest[]): Promise<string> {
	const root = snapshot(state).workspace?.root;
	if (!root) return "";
	const parts = ["CONTEXT YOU ASKED FOR:"];
	for (const r of requests) {
		if (snapshot(state).workspace?.root !== root) return "";
		if (r.file) {
			if (!isAllowedContextPath(r.file)) {
				parts.push(`FILE ${r.file}:`, "(blocked: hidden or outside-workspace paths cannot be read automatically)");
			} else {
				const text = await backend.read(joinPath(root, r.file)).then(
					(f) => f.text,
					() => null,
				);
				if (snapshot(state).workspace?.root !== root) return "";
				parts.push(`FILE ${r.file}:`, text === null ? "(no such file in the workspace)" : text.slice(0, MAX_CONTEXT_CHARS));
			}
		}
		if (r.procedure) {
			const symbols = await session.workspaceSymbols(r.procedure).catch(() => []);
			if (snapshot(state).workspace?.root !== root) return "";
			const symbol = symbols.find(
				(s) => s.name.toLowerCase() === r.procedure!.toLowerCase() && isAllowedContextPath(rel(fileOf(s.location.uri), root)),
			);
			const code = symbol && (await readLines(symbol.location.uri, symbol.location.range.start.line, symbol.location.range.end.line));
			if (snapshot(state).workspace?.root !== root) return "";
			parts.push(`PROCEDURE ${r.procedure}:`, code ? code.slice(0, MAX_CONTEXT_CHARS) : "(no such procedure in the workspace)");
		}
		if (r.element) {
			const text = await describeElement(r.element, root).catch(() => "");
			if (snapshot(state).workspace?.root !== root) return "";
			parts.push(`ELEMENT ${r.element}:`, text || "(the language server does not know it)");
		}
	}
	return parts.join("\n");
}

/** The planning skill, when the style guide has provided it. */
async function planningSkills(path: string): Promise<string[]> {
	if (snapshot(agent).status.state !== "ready") await start();
	const skills = ((await backend.agent("skills", []).catch(() => [])) as { id: string }[]).map((s) => s.id);
	if (skills.includes("ssl-plan")) return ["ssl-plan"];
	warn(path, "The style guide's ssl-plan skill is not installed, so the agent has only a basic prompt to go on.");
	return [];
}

export function warn(path: string, text: string) {
	setAssists((s) => {
		const cur = (s[path] ??= blank());
		if (!cur.warnings.includes(text)) cur.warnings.push(text);
	});
}

const CUT = "This prompt looks cut off: the model reported fewer tokens than it was sent, so it may have missed part of it. With Ollama, set a larger context (docs/INSTALL.md).";

/** Plans whose refine, spec or test script was told to stop. A build has its own, in `buildRun.ts`. */
const stopped = new Set<string>();
const inFlight = new Set<string>();
class Stopped extends Error {}

/**
 * Stops a refine, a spec or a test script. The turn in flight is interrupted,
 * whether or not it has begun to answer (the agent store follows a turn from
 * the moment it is asked), and its reply is dropped. Nothing more is asked, and
 * what the turn cost stays in the totals.
 */
export function stopAssist(path: string) {
	const running = latestAssistOf(path).running;
	if (!running || running === "build") return;
	stopped.add(path);
	update(path, { progress: "Stopping…" });
	void interrupt();
}

export async function askAgent(path: string, stage: string, text: string, skills: string[], toolLimit?: number): Promise<string | null> {
	if (stopped.has(path)) throw new Stopped();
	update(path, { progress: `${stage}: waiting for ${currentModel() || "the agent"}…` });
	const reply = await ask(text, { title: `${stage}: ${rel(path)}`, skills, show: `${stage}: ${rel(path)}`, toolLimit });
	if (!reply) {
		if (stopped.has(path)) throw new Stopped();
		return null;
	}
	const input = reply.tokens?.input ?? 0;
	const addedTokens = input + (reply.tokens?.output ?? 0);
	const addedCost = reply.cost ?? 0;
	setAssists((s) => {
		const cur = (s[path] ??= blank());
		cur.tokens += addedTokens;
		cur.cost += addedCost;
	});
	if (stopped.has(path)) throw new Stopped();
	if (reply.outcome !== "succeeded") {
		notify(`The agent did not finish: ${reply.error ?? reply.outcome}`, "error");
		return null;
	}
	if (looksCut(text.length, input)) warn(path, CUT);
	return reply.text;
}

export const begin = (path: string, running: AssistState["running"], work: () => Promise<void>) => {
	if (inFlight.has(path) || latestAssistOf(path).running) return Promise.resolve();
	if (!snapshot(state).workspace) return Promise.resolve(notify("Open a folder first."));
	inFlight.add(path);
	stopped.delete(path);
	// What the run finds is written into this document: its tab is not one to give up to the next file clicked.
	keepTab(path);
	update(path, { running, warnings: [], progress: "" });
	let task: Promise<void>;
	try {
		task = work();
	} catch (e) {
		task = Promise.reject(e);
	}
	return task
		.catch((e: any) => (e instanceof Stopped ? notify("Stopped. Nothing was changed.") : notify(`${e?.message ?? e}`, "error")))
		.finally(() => {
			inFlight.delete(path);
			stopped.delete(path);
			update(path, { running: "", progress: "" });
		});
};

/** The ticket a plan is for, with its behavior specs and decisions, leaving out plans so this chart/plan doc is not duplicated. */
async function workOf(path: string, plan: Plan): Promise<string | undefined> {
	const ticket = typeof plan.ticket === "string" ? plan.ticket.trim() : "";
	if (!ticket) return undefined;
	const work = await workPrompt(ticket, { plans: false });
	if (!work) warn(path, `This plan is for ${ticket}, which is not among the project's tickets, so the agent is not told what the ticket asks.`);
	return work?.text;
}
const together = (...parts: (string | undefined | null)[]) => parts.filter(Boolean).join("\n\n") || undefined;

/** Stage 2: the agent finds what the chart leaves undecided. */
export function refine(path: string) {
	return begin(path, "refine", async () => {
		const root = snapshot(state).workspace?.root;
		if (!root) return;
		const plan = planOf(path);
		if (!plan) return notify("Fix the plan's text first.");
		update(path, { progress: "Surveying the workspace…" });
		const found = await survey(plan);
		if (snapshot(state).workspace?.root !== root) return;
		const skills = await planningSkills(path);
		if (snapshot(state).workspace?.root !== root) return;
		const work = await workOf(path, plan);
		if (snapshot(state).workspace?.root !== root) return;
		let extra: string | undefined;
		let blocks: Record<string, string> = {};
		for (let round = 0; round < 4; round++) {
			const text = await askAgent(path, "Refine the plan", refinePrompt(plan, found, together(work, extra)), skills);
			if (snapshot(state).workspace?.root !== root || text === null) return;
			blocks = readBlocks(text);
			const wanted = round < 3 ? parseContext(blocks.CONTEXT) : [];
			if (wanted.length) {
				update(path, { progress: "Reading what the agent asked for…" });
				extra = await readContext(wanted);
				if (snapshot(state).workspace?.root !== root) return;
				continue;
			}
			if (Object.keys(blocks).length) break;
			if (round > 0) break;
			extra = "Your last reply had none of the marker lines. Reply using only them.";
		}
		if (snapshot(state).workspace?.root !== root) return;
		const questions = parseQuestions(blocks.QUESTIONS);
		// The plan as it is now: you may have kept working while the agent thought.
		const current = planOf(path) ?? plan;
		const suggestions = parseSuggestions(blocks.CHART, current);
		if (questions.length) savePlan(path, addQuestions(current, questions));
		newIds.set(path, new Map());
		update(path, { suggestions });
		if (!Object.keys(blocks).length) warn(path, "The agent's reply could not be read, so there is nothing to show. Try again, or choose another model.");
		else if (!questions.length && !suggestions.length) notify("The agent has no questions and no suggestions.");
	});
}

/** Stage 3: the written spec. Open questions come first: in the spike, models guessed where they had asked. */
export function writeSpec(path: string) {
	return begin(path, "spec", async () => {
		const root = snapshot(state).workspace?.root;
		if (!root) return;
		const plan = planOf(path);
		if (!plan) return notify("Fix the plan's text first.");
		const open = openQuestions(plan);
		if (open.length) return notify(`Answer ${open.length === 1 ? "the open question" : `the ${open.length} open questions`} first.`);
		update(path, { progress: "Surveying the workspace…" });
		const found = await survey(plan);
		if (snapshot(state).workspace?.root !== root) return;
		const skills = await planningSkills(path);
		if (snapshot(state).workspace?.root !== root) return;
		const limits = snapshot(state).settings.limits;
		const file = specPath(path);
		const original = await backend.read(file).then(
			(f) => f.text,
			() => "",
		);
		if (snapshot(state).workspace?.root !== root) return;
		// With code already built, this revises the spec, and only what changed needs saying.
		const revision = revisionText(plan, original ? original.split("\n## Units")[0]!.trim() : null);
		const work = await workOf(path, plan);
		if (snapshot(state).workspace?.root !== root) return;
		let text = await askAgent(path, "Write the plan doc", specPrompt(plan, found, limits, together(work, revision)), skills);
		if (snapshot(state).workspace?.root !== root || text === null) return;
		let parsed = parseSpec(text);
		const lacking = () => [!parsed.spec && "SPEC", !revision && !parsed.units.length && "UNITS", !revision && !parsed.map.length && "MAP"].filter(Boolean);
		if (lacking().length) {
			text = await askAgent(path, "Write the plan doc", specPrompt(plan, found, limits, [work, revision, `Your last reply lacked these blocks, or they did not parse as JSON: ${lacking().join(", ")}. Reply again with every block.`].filter(Boolean).join("\n\n")), skills);
			if (snapshot(state).workspace?.root !== root || text === null) return;
			parsed = parseSpec(text);
		}
		if (snapshot(state).workspace?.root !== root) return;
		if (!parsed.spec) return warn(path, "The agent did not return a plan doc it could be read from. Try again, or choose another model.");
		// Re-read the latest plan before saving questions so concurrent edits aren't clobbered.
		const latest = planOf(path) ?? plan;
		const asked = addQuestions(latest, parsed.questions);
		if (openQuestions(asked).length) {
			savePlan(path, asked);
			return notify("The agent has questions before it can finish the plan doc.");
		}
		const missing = unaccounted(plan, parsed.units, parsed.map, settledNodes(plan));
		const over = overLimit(plan, parsed.units, limits.codeLines);
		const checks: Check[] = [
			{ label: "Every node is accounted for", ok: !missing.length, detail: missing.length ? `nothing says what becomes of ${missing.map((n) => `"${n.text}"`).join(", ")}` : undefined },
			{ label: `Each script under ${limits.codeLines} code lines`, ok: parsed.units.some((u) => typeof u.lines === "number") ? !over.length : null, detail: over.length ? over.map((o) => `${o.script}: about ${o.lines}`).join(", ") : "by the agent's own estimate" },
			{ label: "Says what already exists", ok: /prior art/i.test(parsed.spec) },
		];
		const blocked = missing.length ? "Every node needs an answer before this can be approved. Reject it, and write it again." : over.length ? "A script goes over the size limit: the plan doc must split it (decision 0006). Reject it, and write it again." : undefined;
		openReview({
			title: `Plan doc: ${rel(file, root)}`,
			original,
			proposed: printSpec(parsed.spec, parsed.units, parsed.map, planHash(plan)),
			language: "markdown",
			checks,
			blocked,
			note: "A plan doc is the build's only memory. Nothing has been built, and the code is untouched.",
			acceptLabel: "Approve the plan doc",
			onAccept: async (final) => {
				if (snapshot(state).workspace?.root !== root) return;
				await backend.write(file, final);
				if (snapshot(state).workspace?.root !== root) return;
				setState((s) => {
					s.treeVersion += 1;
				});
				setAssists((s) => {
					const cur = (s[path] ??= blank());
					cur.specVersion += 1;
				});
				notify("Plan doc approved and saved.");
			},
		});
	});
}

export function answer(path: string, question: string, text: string) {
	const plan = planOf(path);
	if (plan) savePlan(path, answerQuestion(plan, question, text));
}

/** Whether a spec exists, and whether the plan has moved on from it. */
export async function specState(path: string): Promise<"none" | "current" | "stale"> {
	const text = await backend.read(specPath(path)).then(
		(f) => f.text,
		() => null,
	);
	if (text === null) return "none";
	const plan = planOf(path);
	return plan && planHashMatches(specHash(text), plan) ? "current" : "stale";
}

export function acceptSuggestion(path: string, key: string) {
	const plan = planOf(path);
	const s = latestAssistOf(path).suggestions.find((x) => x.key === key);
	if (!plan || !s) return;
	const next = applySuggestion(plan, s, idsFor(path));
	if (!next) return notify("Accept the new step it connects to first.");
	savePlan(path, next);
	setAssists((st) => {
		const cur = (st[path] ??= blank());
		for (let i = cur.suggestions.length - 1; i >= 0; i--) {
			if (cur.suggestions[i]?.key === key) cur.suggestions.splice(i, 1);
		}
	});
}

const idsFor = (path: string) => {
	if (!newIds.has(path)) newIds.set(path, new Map());
	return newIds.get(path)!;
};

/** Declining a new step declines what connects to it. */
export function declineSuggestion(path: string, key: string) {
	setAssists((st) => {
		const cur = st[path];
		if (!cur) return;
		const s = cur.suggestions.find((x) => x.key === key);
		if (!s) return;
		const dropTemp = s.type === "node" ? s.temp : null;
		for (let i = cur.suggestions.length - 1; i >= 0; i--) {
			const x = cur.suggestions[i]!;
			if (x.key === key || (dropTemp !== null && x.type === "edge" && (x.from === dropTemp || x.to === dropTemp))) {
				cur.suggestions.splice(i, 1);
			}
		}
	});
}

/** Accepts everything as one undo step, new steps before what connects to them. */
export function acceptAll(path: string) {
	let plan = planOf(path);
	if (!plan) return;
	const order: Suggestion["type"][] = ["node", "change", "remove-edge", "edge"];
	const list = [...latestAssistOf(path).suggestions].sort((a, b) => order.indexOf(a.type) - order.indexOf(b.type));
	const ids = idsFor(path);
	for (const s of list) plan = applySuggestion(plan, s, ids) ?? plan;
	savePlan(path, plan);
	update(path, { suggestions: [] });
}

export const dismissWarning = (path: string, text: string) => {
	setAssists((s) => {
		const cur = s[path];
		if (!cur) return;
		for (let i = cur.warnings.length - 1; i >= 0; i--) {
			if (cur.warnings[i] === text) cur.warnings.splice(i, 1);
		}
	});
};
