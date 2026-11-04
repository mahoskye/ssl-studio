// What passes between a plan and the agent (planning mode stages 2 and 3):
// prompts, and the reply blocks that come back. Pure, so it can be tested with
// no model. Replies use marker lines rather than fences, since a spec holds
// fences of its own, and parsing is lenient, because models close markers the
// wrong way (docs/spikes/planning-mode.md).
import { nextNodeId, type NodeKind, type Plan, type PlanEdge, type PlanNode } from "./model";

// --- reply blocks ----------------------------------------------------------------

const MARKER = /^\s*(<<<|>>>)\s*([A-Z]+)\s*$/;

/** Every `<<<NAME` block in a reply. A block ends at its closer, at the next opener, or at the end. */
export function readBlocks(text: string): Record<string, string> {
	const blocks: Record<string, string> = {};
	let name: string | null = null;
	let lines: string[] = [];
	const close = () => {
		if (name !== null) blocks[name] = lines.join("\n").trim();
		name = null;
		lines = [];
	};
	for (const line of text.split(/\r?\n/)) {
		const m = MARKER.exec(line);
		if (!m) {
			if (name !== null) lines.push(line);
			continue;
		}
		const [, mark, label] = m;
		if (name !== null && label === name) close();
		else if (mark === "<<<") {
			close();
			name = label!;
		} else close();
	}
	close();
	return blocks;
}

/** JSON from a block, with any fence a model put round it. Null when it does not parse. */
function jsonOf(block: string | undefined): unknown {
	if (!block) return null;
	const inner = /```[\w-]*\s*\n([\s\S]*?)```/.exec(block)?.[1] ?? block;
	try {
		return JSON.parse(inner.trim());
	} catch {
		return null;
	}
}

const isObject = (v: unknown): v is Record<string, any> => typeof v === "object" && v !== null && !Array.isArray(v);
const listOf = (v: unknown): Record<string, any>[] => (Array.isArray(v) ? v.filter(isObject) : []);

// --- questions, kept in the plan so that no later prompt asks again ---------------

export type Decision = { question: string; node?: string; answer?: string; suggested?: string[] };

export const decisionsOf = (plan: Plan): Decision[] => (Array.isArray(plan.decisions) ? (plan.decisions as Decision[]) : []);
export const openQuestions = (plan: Plan) => decisionsOf(plan).filter((d) => !d.answer?.trim());

const sameQuestion = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();

export function parseQuestions(block: string | undefined): Decision[] {
	return listOf(jsonOf(block))
		.filter((q) => typeof q.question === "string" && q.question.trim())
		.map((q) => ({
			question: q.question.trim(),
			...(typeof q.node === "string" ? { node: q.node } : {}),
			...(Array.isArray(q.answers) && q.answers.length ? { suggested: q.answers.map(String) } : {}),
		}));
}

export function addQuestions(plan: Plan, questions: Decision[]): Plan {
	const decisions = [...decisionsOf(plan)];
	for (const q of questions) if (!decisions.some((d) => sameQuestion(d.question, q.question))) decisions.push(q);
	return decisions.length ? { ...plan, decisions } : plan;
}

export function answerQuestion(plan: Plan, question: string, answer: string): Plan {
	return {
		...plan,
		decisions: decisionsOf(plan).map((d) => {
			if (!sameQuestion(d.question, question)) return d;
			const { suggested: _used, ...rest } = d;
			return { ...rest, answer: answer.trim() };
		}),
	};
}

// --- chart suggestions, to accept or decline one by one ---------------------------

export type Suggestion =
	| { type: "node"; key: string; temp: string; node: Pick<PlanNode, "kind" | "text"> & Partial<PlanNode>; why?: string }
	| { type: "edge"; key: string; from: string; to: string; label?: string; why?: string }
	| { type: "remove-edge"; key: string; from: string; to: string; why?: string }
	| { type: "change"; key: string; id: string; text?: string; notes?: string; kind?: NodeKind; why?: string };

const KINDS = new Set<string>(["step", "decision", "call", "end"]);

/** What the agent proposes, kept only where it makes sense against this plan. */
export function parseSuggestions(block: string | undefined, plan: Plan): Suggestion[] {
	const raw = jsonOf(block);
	if (!isObject(raw)) return [];
	const known = new Set(plan.nodes.map((n) => n.id));
	const out: Suggestion[] = [];
	const temps = new Map<string, string>();
	listOf(raw.nodes).forEach((n, i) => {
		if (!KINDS.has(n.kind) || typeof n.text !== "string" || !n.text.trim()) return;
		// The agent's ids are its own: they stand for new nodes until accepted.
		const given = typeof n.id === "string" && n.id && !known.has(n.id) ? n.id : `new${i + 1}`;
		const temp = `new:${given}`;
		temps.set(given, temp);
		out.push({ type: "node", key: temp, temp, node: { kind: n.kind, text: n.text.trim(), ...(typeof n.ref === "string" ? { ref: n.ref } : {}), ...(typeof n.notes === "string" ? { notes: n.notes } : {}) }, why: n.why });
	});
	const end = (id: unknown) => (typeof id !== "string" ? null : temps.get(id) ?? (known.has(id) ? id : null));
	for (const e of listOf(raw.edges)) {
		const [from, to] = [end(e.from), end(e.to)];
		if (from && to && from !== to && !plan.edges.some((x) => x.from === from && x.to === to)) out.push({ type: "edge", key: `edge:${from}>${to}`, from, to, ...(typeof e.label === "string" && e.label ? { label: e.label } : {}), why: e.why });
	}
	for (const e of listOf(raw.remove)) {
		if (plan.edges.some((x) => x.from === e.from && x.to === e.to)) out.push({ type: "remove-edge", key: `remove:${e.from}>${e.to}`, from: e.from, to: e.to, why: e.why });
	}
	for (const c of listOf(raw.changes)) {
		if (!known.has(c.id)) continue;
		const kind = KINDS.has(c.kind) ? (c.kind as NodeKind) : undefined;
		if (typeof c.text !== "string" && typeof c.notes !== "string" && !kind) continue;
		out.push({ type: "change", key: `change:${c.id}`, id: c.id, ...(typeof c.text === "string" ? { text: c.text.trim() } : {}), ...(typeof c.notes === "string" ? { notes: c.notes.trim() } : {}), ...(kind ? { kind } : {}), why: c.why });
	}
	return out;
}

/** Accepts one suggestion. Null when an edge's new node has not been accepted yet. */
export function applySuggestion(plan: Plan, s: Suggestion, ids: Map<string, string>): Plan | null {
	const real = (id: string) => ids.get(id) ?? (id.startsWith("new:") ? null : id);
	switch (s.type) {
		case "node": {
			const id = nextNodeId(plan);
			ids.set(s.temp, id);
			return { ...plan, nodes: [...plan.nodes, { ...s.node, id } as PlanNode] };
		}
		case "edge": {
			const [from, to] = [real(s.from), real(s.to)];
			if (!from || !to) return null;
			if (plan.edges.some((e) => e.from === from && e.to === to)) return plan;
			return { ...plan, edges: [...plan.edges, { from, to, ...(s.label ? { label: s.label } : {}) }] };
		}
		case "remove-edge":
			return { ...plan, edges: plan.edges.filter((e) => e.from !== s.from || e.to !== s.to) };
		case "change":
			return {
				...plan,
				nodes: plan.nodes.map((n) => {
					if (n.id !== s.id) return n;
					return { ...n, ...(s.text ? { text: s.text } : {}), ...(s.notes ? { notes: s.notes } : {}), ...(s.kind ? { kind: s.kind } : {}) };
				}),
			};
	}
}

/** The plan with what is still only proposed, for the chart to draw differently. */
export function previewPlan(plan: Plan, pending: Suggestion[]): Plan {
	const nodes: PlanNode[] = [...plan.nodes];
	const edges: PlanEdge[] = plan.edges.map((e) => (pending.some((s) => s.type === "remove-edge" && s.from === e.from && s.to === e.to) ? { ...e, removing: true } : e));
	for (const s of pending) if (s.type === "node") nodes.push({ ...s.node, id: s.temp, pending: true } as PlanNode);
	for (const s of pending) if (s.type === "edge") edges.push({ from: s.from, to: s.to, ...(s.label ? { label: s.label } : {}), pending: true });
	return { ...plan, nodes, edges };
}

export function describeSuggestion(s: Suggestion, plan: Plan, pending: Suggestion[]): string {
	const name = (id: string) => {
		const node = plan.nodes.find((n) => n.id === id);
		if (node) return `"${node.text}"`;
		const proposed = pending.find((p) => p.type === "node" && p.temp === id);
		return proposed?.type === "node" ? `"${proposed.node.text}"` : id;
	};
	switch (s.type) {
		case "node":
			return `Add ${s.node.kind === "decision" ? "a decision" : s.node.kind === "call" ? "a call" : s.node.kind === "end" ? "an end" : "a step"}: "${s.node.text}"`;
		case "edge":
			return `Connect ${name(s.from)} to ${name(s.to)}${s.label ? ` (${s.label})` : ""}`;
		case "remove-edge":
			return `Disconnect ${name(s.from)} from ${name(s.to)}`;
		case "change":
			return `Change ${name(s.id)}${s.text ? ` to "${s.text}"` : ""}${s.kind ? `, as a ${s.kind}` : ""}${s.notes ? `, noting: ${s.notes}` : ""}`;
	}
}

// --- what the agent asks to read -----------------------------------------------------

export type ContextRequest = { file?: string; procedure?: string; element?: string };

export function parseContext(block: string | undefined): ContextRequest[] {
	return listOf(jsonOf(block))
		.map((c) => ({ ...(typeof c.file === "string" ? { file: c.file } : {}), ...(typeof c.procedure === "string" ? { procedure: c.procedure } : {}), ...(typeof c.element === "string" ? { element: c.element } : {}) }))
		.filter((c) => c.file || c.procedure || c.element)
		.slice(0, 6);
}

// --- the spec ---------------------------------------------------------------------------

export type SpecUnit = { name: string; script?: string; parameters?: string[]; nodes?: string[]; calls?: string[]; lines?: number };
export type NodeMap = { node: string; becomes: string };

export function parseSpec(text: string) {
	const blocks = readBlocks(text);
	const units = listOf(jsonOf(blocks.UNITS)).filter((u) => typeof u.name === "string" && u.name.trim()) as SpecUnit[];
	const map = listOf(jsonOf(blocks.MAP)).filter((m) => typeof m.node === "string") as NodeMap[];
	return { spec: blocks.SPEC ?? "", units, map, questions: parseQuestions(blocks.QUESTIONS) };
}

/** Nodes the spec does not say what happens to. A chart's start and end still need saying; what is built and untouched does not. */
export function unaccounted(plan: Plan, units: SpecUnit[], map: NodeMap[], settled: string[] = []): PlanNode[] {
	const said = new Set([...map.map((m) => m.node), ...units.flatMap((u) => u.nodes ?? []), ...settled]);
	return plan.nodes.filter((n) => !said.has(n.id));
}

/** Scripts the spec expects to go over the code-line limit (program decision 0006). */
export function overLimit(plan: Plan, units: SpecUnit[], limit: number): { script: string; lines: number }[] {
	const fallback = Array.isArray(plan.targets) && plan.targets.length ? String(plan.targets[0]) : "the script";
	const totals = new Map<string, number>();
	for (const u of units) if (typeof u.lines === "number") totals.set(u.script ?? fallback, (totals.get(u.script ?? fallback) ?? 0) + u.lines);
	return [...totals].filter(([, lines]) => lines > limit).map(([script, lines]) => ({ script, lines }));
}

/** The plan as the spec was written from: words and structure, not who answered what when. */
export function planHash(plan: Plan): string {
	return hashText(JSON.stringify([plan.title, plan.goal, plan.nodes, plan.edges, decisionsOf(plan).map((d) => [d.question, d.answer])]));
}

export function hashText(text: string): string {
	let hash = 5381;
	for (let i = 0; i < text.length; i++) hash = ((hash * 33) ^ text.charCodeAt(i)) >>> 0;
	return hash.toString(16);
}

/** The spec's file: the words you reviewed, then what later stages read, then which plan it came from. */
export function printSpec(spec: string, units: SpecUnit[], map: NodeMap[], hash: string): string {
	return [spec.trim(), "", "## Units", "", "```json", JSON.stringify(units, null, 2), "```", "", "## What each node becomes", "", "```json", JSON.stringify(map, null, 2), "```", "", `<!-- plan ${hash} -->`, ""].join("\n");
}

export const specHash = (text: string) => /<!-- plan ([0-9a-f]+) -->/.exec(text)?.[1] ?? null;

/** A model's context limit cuts a prompt with no error. Its token count gives it away. */
export function looksCut(promptChars: number, inputTokens: number): boolean {
	if (!inputTokens) return false;
	const limits = [2048, 4096, 8192, 16384, 32768];
	return inputTokens * 6 < promptChars || limits.includes(inputTokens);
}

// --- the survey: what the chart's words may already name ------------------------------

const COMMON = new Set("about above after again also and any are been before being but can could does each else for from has have into its may more must not only other out over should some such than that the their them then there these they this those through under until upon was were what when where which while will with without would your yes no arrives return returns check checks mark marks tell".split(" "));

/** Distinct words in the chart worth searching the workspace for, longest first. */
export function nounsOf(plan: Plan, limit = 8): string[] {
	const words = new Map<string, number>();
	const text = [plan.title, typeof plan.goal === "string" ? plan.goal : "", ...plan.nodes.map((n) => n.text)].join(" ");
	for (const raw of text.split(/[^A-Za-z0-9_]+/)) {
		const word = raw.toLowerCase();
		if (word.length >= 4 && !COMMON.has(word)) words.set(word, (words.get(word) ?? 0) + 1);
	}
	return [...words].sort((a, b) => b[1] - a[1] || b[0].length - a[0].length).slice(0, limit).map(([w]) => w);
}

export type Survey = { calls: { ref: string; code: string }[]; targets: { path: string; outline: string | null }[]; symbols: { name: string; file: string }[]; hits: { word: string; file: string; line: number; text: string }[]; callGraph: string[] };

const MAX_SURVEY_CHARS = 6000;

export function formatSurvey(s: Survey): string {
	const parts: string[] = [];
	if (s.targets.length) parts.push("TARGET SCRIPTS:", ...s.targets.map((t) => (t.outline === null ? `${t.path}: does not exist yet` : `${t.path} holds:\n${t.outline}`)));
	if (s.calls.length) parts.push("WHAT THE CHART CALLS:", ...s.calls.map((c) => `${c.ref}:\n${c.code}`));
	if (s.callGraph.length) parts.push("THEIR CALLERS AND CALLEES:", ...s.callGraph);
	if (s.symbols.length) parts.push("PROCEDURES WHOSE NAMES MATCH THE CHART'S WORDS:", ...s.symbols.map((p) => `${p.name} in ${p.file}`));
	if (s.hits.length) parts.push("WHERE THE CHART'S WORDS APPEAR:", ...s.hits.map((h) => `${h.file}:${h.line}: ${h.text}`));
	const text = parts.join("\n") || "Nothing in the workspace matched.";
	return text.length > MAX_SURVEY_CHARS ? `${text.slice(0, MAX_SURVEY_CHARS)}\n(cut here; ask for more with a CONTEXT block)` : text;
}

// --- prompts ---------------------------------------------------------------------------

const NO_TOOLS = "You are inside SSL Studio. You cannot read, search or write files: everything you need is below, and SSL Studio applies what you return after the user reviews it.";

const answered = (plan: Plan) => {
	const list = decisionsOf(plan).filter((d) => d.answer?.trim());
	return list.length ? ["", "THE USER HAS ALREADY DECIDED (do not ask these again):", ...list.map((d) => `- ${d.question} ${d.answer}`)] : [];
};
const planFor = (plan: Plan) => {
	const { decisions: _kept, built: _built, ...rest } = plan;
	return JSON.stringify(rest, null, 1);
};

export function refinePrompt(plan: Plan, survey: string, extra?: string): string {
	return [
		"PLAN STAGE: refine",
		NO_TOOLS,
		"The user designed a process as a flow chart, in plain words. Do not write code or a spec yet. Find what the chart leaves undecided: missing branches and failure paths, what happens to data, facts about this site that you cannot know. Check it against what already exists, so nothing is built twice.",
		"Reply using only these marker lines, each on its own line, leaving out any block you do not need:",
		"<<<QUESTIONS",
		'a JSON list of what only the user can decide: {"question":"...","node":"n3","answers":["likely answer","another"]}. Ask only what changes the design. Do not guess at this site\'s database or systems: ask.',
		">>>QUESTIONS",
		"<<<CHART",
		'JSON with what to change in the chart: {"nodes":[{"id":"a","kind":"step|decision|call|end","text":"plain words","why":"..."}],"edges":[{"from":"n3","to":"a","label":"no","why":"..."}],"remove":[{"from":"n3","to":"n6"}],"changes":[{"id":"n4","text":"...","notes":"...","why":"..."}]}. Edges may name your new ids. Plain words, no code.',
		">>>CHART",
		"<<<CONTEXT",
		'a JSON list of what you need to read first: {"file":"Sample/Orders.ssl"}, {"procedure":"Name"} or {"element":"BuiltInName"}. If you ask for context, leave the other blocks out.',
		">>>CONTEXT",
		"",
		"THE PLAN:",
		planFor(plan),
		...answered(plan),
		"",
		"WHAT ALREADY EXISTS, from the language server:",
		survey,
		...(extra ? ["", extra] : []),
	].join("\n");
}

export function specPrompt(plan: Plan, survey: string, limits: { codeLines: number }, extra?: string): string {
	return [
		"PLAN STAGE: spec",
		NO_TOOLS,
		"Write the implementation spec a developer would work from, for the flow chart below. Do not write SSL code in it: say what is needed in words, and name no built-in you are not sure exists.",
		`Rules: each script stays under ${limits.codeLines} code lines; split into small scripts rather than exceed it. Reuse what already exists rather than rewriting it. A group in the chart becomes a comment region. Every node of the chart must be accounted for.`,
		"Reply using exactly these marker lines, each on its own line:",
		"<<<SPEC",
		"markdown with these sections: Prior art (what already exists, and what you reuse); Procedures (parameters, return value, error paths); Data and transactions; Test plan (one case per path through the decisions).",
		">>>SPEC",
		"<<<UNITS",
		'a JSON list of what to write, callees first: {"name":"...","script":"Sample/Release.ssl","parameters":["..."],"nodes":["n4"],"calls":["..."],"lines":30}. lines is your estimate of its code lines.',
		">>>UNITS",
		"<<<MAP",
		'a JSON list saying what becomes of EVERY node, the start and end too: {"node":"n1","becomes":"the parameters of ReleaseSample"}.',
		">>>MAP",
		"<<<QUESTIONS",
		'a JSON list of {"question":"...","node":"n3"} for anything only the user can decide. If you need one answered, say so here rather than guessing. [] if none.',
		">>>QUESTIONS",
		"",
		"THE PLAN:",
		planFor(plan),
		...answered(plan),
		"",
		"WHAT ALREADY EXISTS, from the language server:",
		survey,
		...(extra ? ["", extra] : []),
	].join("\n");
}
