// Planning mode's stages 2 and 3 (docs/PLANNING-MODE.md): SSL Studio surveys the
// workspace, the agent asks and suggests, then writes a spec for review. The code
// is not touched here. As in the tidy steps, the agent has no file tools: what it
// needs arrives in the prompt, and what it returns is applied after you agree.
import { createStore } from "solid-js/store";
import { backend } from "../backend";
import { ask, agent, currentModel, start } from "../agent/store";
import { openReview, type Check } from "../editor/Review";
import { monaco } from "../editor/monaco";
import { session } from "../lsp/session";
import { describeElement } from "../panels/Reference";
import { applyText, documents, notify, setState, state } from "../state";
import { joinPath, relativeTo } from "../../shared/paths";
import { addQuestions, answerQuestion, applySuggestion, formatSurvey, looksCut, nounsOf, openQuestions, overLimit, parseContext, parseQuestions, parseSpec, parseSuggestions, planHash, printSpec, readBlocks, refinePrompt, specHash, specPrompt, unaccounted, type ContextRequest, type Suggestion, type Survey } from "./assist";
import type { BuildRun } from "./build";
import { parsePlan, printPlan, type Plan } from "./model";

export type AssistState = { running: "" | "refine" | "spec" | "build"; progress: string; warnings: string[]; suggestions: Suggestion[]; tokens: number; cost: number; specVersion: number; run: BuildRun | null };
const blank = (): AssistState => ({ running: "", progress: "", warnings: [], suggestions: [], tokens: 0, cost: 0, specVersion: 0, run: null });

const [assists, setAssists] = createStore<Record<string, AssistState>>({});
const newIds = new Map<string, Map<string, string>>();

export const assistOf = (path: string): AssistState => assists[path] ?? blank();
const update = (path: string, patch: Partial<AssistState>) => {
	if (!assists[path]) setAssists(path, blank());
	setAssists(path, patch);
};
export const updateAssist = update;

export const specPath = (planPath: string) => planPath.replace(/\.plan\.json$/i, ".spec.md");

export const planOf = (path: string): Plan | undefined => {
	const doc = documents.get(path);
	return doc ? parsePlan(doc.model.getValue()).plan : undefined;
};
const savePlan = (path: string, plan: Plan) => applyText(path, printPlan(plan));
const rel = (path: string) => relativeTo(state.workspace?.root, path);
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
	const found: Survey = { calls: [], targets: [], symbols: [], hits: [], callGraph: [] };
	for (const word of nounsOf(plan)) {
		const symbols = await session.workspaceSymbols(word).catch(() => []);
		for (const s of symbols) if (PROCEDURES.has(s.kind) && !found.symbols.some((f) => f.name === s.name)) found.symbols.push({ name: s.name, file: rel(fileOf(s.location.uri)) });
		const hits = await backend.search(word, { caseSensitive: false }).catch(() => []);
		for (const h of hits.filter((x) => !/\.(plan\.json|spec\.md|tidy\.md)$/i.test(x.path)).slice(0, 3)) found.hits.push({ word, file: rel(h.path), line: h.line, text: h.text.trim().slice(0, 120) });
	}
	found.symbols = found.symbols.slice(0, 30);
	found.hits = found.hits.slice(0, 20);
	for (const node of plan.nodes.filter((n) => n.kind === "call" && n.ref)) {
		const name = node.ref!.split(".").at(-1)!;
		const symbol = (await session.workspaceSymbols(name).catch(() => [])).find((s) => s.name.toLowerCase() === name.toLowerCase());
		if (!symbol) continue;
		const start = symbol.location.range.start.line;
		const code = await readLines(symbol.location.uri, start, start + 12);
		if (code !== null) found.calls.push({ ref: node.ref!, code: code.trim() });
		if (session.supports("ssl/callGraph")) {
			const graph: any = await session.request("ssl/callGraph", { textDocument: { uri: symbol.location.uri }, procedure: name, depth: 1 }).catch(() => null);
			const names = new Map<string, string>((graph?.nodes ?? []).map((n: any) => [n.id, n.name]));
			for (const e of graph?.edges ?? []) found.callGraph.push(`${names.get(e.from) ?? e.from} calls ${e.target}${e.resolved ? "" : " (unresolved)"}`);
		}
	}
	found.callGraph = [...new Set(found.callGraph)].slice(0, 20);
	for (const target of Array.isArray(plan.targets) ? (plan.targets as string[]) : []) {
		const path = joinPath(state.workspace!.root, target);
		const exists = await backend.read(path).then(
			() => true,
			() => false,
		);
		if (!exists) {
			found.targets.push({ path: target, outline: null });
			continue;
		}
		const model = await session.ensureModel(monaco.Uri.file(path).toString());
		const lines: string[] = [];
		const walk = (list: monaco.languages.DocumentSymbol[], depth: number) => list.forEach((s) => (lines.push(`${"  ".repeat(depth)}${s.name}`), walk(s.children ?? [], depth + 1)));
		if (model) walk(await session.documentSymbols(model).catch(() => []), 1);
		found.targets.push({ path: target, outline: lines.join("\n") });
	}
	return formatSurvey(found);
}

const MAX_CONTEXT_CHARS = 8000;

/** Answers an agent's `CONTEXT` block from the workspace and the server. */
async function readContext(requests: ContextRequest[]): Promise<string> {
	const parts = ["CONTEXT YOU ASKED FOR:"];
	for (const r of requests) {
		if (r.file) {
			const text = await backend.read(joinPath(state.workspace!.root, r.file)).then(
				(f) => f.text,
				() => null,
			);
			parts.push(`FILE ${r.file}:`, text === null ? "(no such file in the workspace)" : text.slice(0, MAX_CONTEXT_CHARS));
		}
		if (r.procedure) {
			const symbol = (await session.workspaceSymbols(r.procedure).catch(() => [])).find((s) => s.name.toLowerCase() === r.procedure!.toLowerCase());
			const code = symbol && (await readLines(symbol.location.uri, symbol.location.range.start.line, symbol.location.range.end.line));
			parts.push(`PROCEDURE ${r.procedure}:`, code ? code.slice(0, MAX_CONTEXT_CHARS) : "(no such procedure in the workspace)");
		}
		if (r.element) {
			const text = await describeElement(r.element, state.workspace!.root).catch(() => "");
			parts.push(`ELEMENT ${r.element}:`, text || "(the language server does not know it)");
		}
	}
	return parts.join("\n");
}

/** The planning skill, when the style guide has provided it. */
async function planningSkills(path: string): Promise<string[]> {
	if (agent.status.state !== "ready") await start();
	const skills = ((await backend.agent("skills", []).catch(() => [])) as { id: string }[]).map((s) => s.id);
	if (skills.includes("ssl-plan")) return ["ssl-plan"];
	warn(path, "The style guide's ssl-plan skill is not installed, so the agent has only a basic prompt to go on.");
	return [];
}

function warn(path: string, text: string) {
	const current = assistOf(path).warnings;
	if (!current.includes(text)) update(path, { warnings: [...current, text] });
}

const CUT = "This prompt looks cut off: the model reported fewer tokens than it was sent, so it may have missed part of it. With Ollama, set a larger context (docs/INSTALL.md).";

export async function askAgent(path: string, stage: string, text: string, skills: string[], toolLimit?: number): Promise<string | null> {
	update(path, { progress: `${stage}: waiting for ${currentModel() || "the agent"}…` });
	const reply = await ask(text, { title: `${stage}: ${rel(path)}`, skills, show: `${stage}: ${rel(path)}`, toolLimit });
	if (!reply) return null;
	const soFar = assistOf(path);
	const input = reply.tokens?.input ?? 0;
	update(path, { tokens: soFar.tokens + input + (reply.tokens?.output ?? 0), cost: soFar.cost + (reply.cost ?? 0) });
	if (reply.outcome !== "succeeded") {
		notify(`The agent did not finish: ${reply.error ?? reply.outcome}`, "error");
		return null;
	}
	if (looksCut(text.length, input)) warn(path, CUT);
	return reply.text;
}

export const begin = (path: string, running: AssistState["running"], work: () => Promise<void>) => {
	if (assistOf(path).running) return Promise.resolve();
	if (!state.workspace) return Promise.resolve(notify("Open a folder first."));
	update(path, { running, warnings: [], progress: "" });
	return work()
		.catch((e: any) => notify(`${e?.message ?? e}`, "error"))
		.finally(() => update(path, { running: "", progress: "" }));
};

/** Stage 2: the agent finds what the chart leaves undecided. */
export function refine(path: string) {
	return begin(path, "refine", async () => {
		const plan = planOf(path);
		if (!plan) return notify("Fix the plan's text first.");
		update(path, { progress: "Surveying the workspace…" });
		const found = await survey(plan);
		const skills = await planningSkills(path);
		let extra: string | undefined;
		let blocks: Record<string, string> = {};
		for (let round = 0; round < 4; round++) {
			const text = await askAgent(path, "Refine the plan", refinePrompt(plan, found, extra), skills);
			if (text === null) return;
			blocks = readBlocks(text);
			const wanted = round < 3 ? parseContext(blocks.CONTEXT) : [];
			if (wanted.length) {
				update(path, { progress: "Reading what the agent asked for…" });
				extra = await readContext(wanted);
				continue;
			}
			if (Object.keys(blocks).length) break;
			if (round > 0) break;
			extra = "Your last reply had none of the marker lines. Reply using only them.";
		}
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
		const plan = planOf(path);
		if (!plan) return notify("Fix the plan's text first.");
		const open = openQuestions(plan);
		if (open.length) return notify(`Answer ${open.length === 1 ? "the open question" : `the ${open.length} open questions`} first.`);
		update(path, { progress: "Surveying the workspace…" });
		const found = await survey(plan);
		const skills = await planningSkills(path);
		const limits = state.settings.limits;
		let text = await askAgent(path, "Write the spec", specPrompt(plan, found, limits), skills);
		if (text === null) return;
		let parsed = parseSpec(text);
		const lacking = () => [!parsed.spec && "SPEC", !parsed.units.length && "UNITS", !parsed.map.length && "MAP"].filter(Boolean);
		if (lacking().length) {
			text = await askAgent(path, "Write the spec", specPrompt(plan, found, limits, `Your last reply lacked these blocks, or they did not parse as JSON: ${lacking().join(", ")}. Reply again with every block.`), skills);
			if (text === null) return;
			parsed = parseSpec(text);
		}
		if (!parsed.spec) return warn(path, "The agent did not return a spec it could be read from. Try again, or choose another model.");
		const asked = addQuestions(plan, parsed.questions);
		if (openQuestions(asked).length) {
			savePlan(path, asked);
			return notify("The agent has questions before it can finish the spec.");
		}
		const missing = unaccounted(plan, parsed.units, parsed.map);
		const over = overLimit(plan, parsed.units, limits.codeLines);
		const checks: Check[] = [
			{ label: "Every node is accounted for", ok: !missing.length, detail: missing.length ? `nothing says what becomes of ${missing.map((n) => `"${n.text}"`).join(", ")}` : undefined },
			{ label: `Each script under ${limits.codeLines} code lines`, ok: parsed.units.some((u) => typeof u.lines === "number") ? !over.length : null, detail: over.length ? over.map((o) => `${o.script}: about ${o.lines}`).join(", ") : "by the agent's own estimate" },
			{ label: "Says what already exists", ok: /prior art/i.test(parsed.spec) },
		];
		const blocked = missing.length ? "Every node needs an answer before this can be approved. Reject it, and write it again." : over.length ? "A script goes over the size limit: the spec must split it (decision 0006). Reject it, and write it again." : undefined;
		const file = specPath(path);
		const original = await backend.read(file).then(
			(f) => f.text,
			() => "",
		);
		openReview({
			title: `Spec: ${rel(file)}`,
			original,
			proposed: printSpec(parsed.spec, parsed.units, parsed.map, planHash(plan)),
			language: "markdown",
			checks,
			blocked,
			note: "A spec is the build's only memory. Nothing has been built, and the code is untouched.",
			acceptLabel: "Approve the spec",
			onAccept: async (final) => {
				await backend.write(file, final);
				setState("treeVersion", (v) => v + 1);
				update(path, { specVersion: assistOf(path).specVersion + 1 });
				notify("Spec approved and saved.");
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
	return plan && specHash(text) === planHash(plan) ? "current" : "stale";
}

export function acceptSuggestion(path: string, key: string) {
	const plan = planOf(path);
	const s = assistOf(path).suggestions.find((x) => x.key === key);
	if (!plan || !s) return;
	const next = applySuggestion(plan, s, idsFor(path));
	if (!next) return notify("Accept the new step it connects to first.");
	savePlan(path, next);
	update(path, { suggestions: assistOf(path).suggestions.filter((x) => x.key !== key) });
}

const idsFor = (path: string) => {
	if (!newIds.has(path)) newIds.set(path, new Map());
	return newIds.get(path)!;
};

/** Declining a new step declines what connects to it. */
export function declineSuggestion(path: string, key: string) {
	const s = assistOf(path).suggestions.find((x) => x.key === key);
	if (!s) return;
	update(path, { suggestions: assistOf(path).suggestions.filter((x) => x.key !== key && !(s.type === "node" && x.type === "edge" && (x.from === s.temp || x.to === s.temp))) });
}

/** Accepts everything as one undo step, new steps before what connects to them. */
export function acceptAll(path: string) {
	let plan = planOf(path);
	if (!plan) return;
	const order: Suggestion["type"][] = ["node", "change", "remove-edge", "edge"];
	const list = [...assistOf(path).suggestions].sort((a, b) => order.indexOf(a.type) - order.indexOf(b.type));
	const ids = idsFor(path);
	for (const s of list) plan = applySuggestion(plan, s, ids) ?? plan;
	savePlan(path, plan);
	update(path, { suggestions: [] });
}

export const dismissWarning = (path: string, text: string) => update(path, { warnings: assistOf(path).warnings.filter((w) => w !== text) });
