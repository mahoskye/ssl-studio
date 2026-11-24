// What passes between a plan and the agent (planning mode stages 2 and 3):
// prompts, and the reply blocks that come back. Pure, so it can be tested with
// no model. Replies use marker lines rather than fences, since a spec holds
// fences of its own, and parsing is lenient, because models close markers the
// wrong way (docs/spikes/planning-mode.md).
import { baseName, relativeTo } from "../../shared/paths";
import type { DocFile } from "../../shared/protocol";
import { codeMatchesRef } from "../../shared/workContext";
import type { Drift, Reading } from "./built";
import { offsetFor, type LayoutDirection } from "./chart";
import { nextNodeId, nodeDocsOf, nodeLines, parsePlan, planTestsOf, setNodeOffset, type Finding, type NodeKind, type Plan, type PlanEdge, type PlanGroup, type PlanNode, type PlanOffset } from "./model";

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

// --- plan-to-Mermaid export & surgical Markdown sync (Wave 4.2) ------------------

const MERMAID_RESERVED = new Set([
	"end",
	"subgraph",
	"class",
	"style",
	"click",
	"call",
	"graph",
	"flowchart",
	"direction",
	"linkstyle",
	"classdef",
]);

function makeMermaidIdMapper(prefix: string) {
	const mapped = new Map<string, string>();
	const taken = new Set<string>();
	return (raw: string): string => {
		const hit = mapped.get(raw);
		if (hit) return hit;
		let clean = raw.replace(/[^A-Za-z0-9_]/g, "_").replace(/^_+|_+$/g, "");
		if (!clean || /^\d/.test(clean) || MERMAID_RESERVED.has(clean.toLowerCase())) {
			clean = `${prefix}_${clean || "x"}`;
		}
		let candidate = clean;
		let suffix = 2;
		while (taken.has(candidate.toLowerCase())) {
			candidate = `${clean}_${suffix++}`;
		}
		taken.add(candidate.toLowerCase());
		mapped.set(raw, candidate);
		return candidate;
	};
}

/** Escapes node/subgraph text cleanly for Mermaid double-quoted labels. */
function escapeMermaidLabel(raw: string): string {
	const text = raw.trim();
	if (!text) return "(untitled)";
	return text
		.replace(/\r\n/g, "\n")
		.replace(/\r/g, "\n")
		.replace(/\t+/g, " ")
		.replace(/"/g, "#quot;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/\n/g, "<br/>");
}

/** Formats an edge label for Mermaid `-->|...|`, quoting/escaping when punctuation is present. */
function formatMermaidEdgeLabel(raw: string): string {
	const clean = raw.trim().replace(/\r?\n/g, " ").replace(/\s+/g, " ");
	if (!clean) return "";
	if (!/[|"<>\[\]{}()]/.test(clean)) return clean;
	const escaped = clean
		.replace(/"/g, "#quot;")
		.replace(/\|/g, "/")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;");
	return `"${escaped}"`;
}

function mermaidNodeDecl(id: string, node: PlanNode): string {
	const label = escapeMermaidLabel(node.text || node.id);
	switch (node.kind) {
		case "start":
		case "end":
			return `${id}(["${label}"])`;
		case "decision":
			return `${id}{"${label}"}`;
		case "call":
			return `${id}[["${label}"]]`;
		default:
			return `${id}["${label}"]`;
	}
}

/**
 * Deterministic Plan-to-Mermaid flowchart generator (`flowchart TD` or `flowchart LR`):
 * emits stage subgraphs for `plan.groups`, shape-accurate nodes (stadium for start/end,
 * diamond `{}` for decisions, subroutine `[[]]` for calls, rectangle `[]` for steps),
 * properly escaped labels, and labeled edges (`-->|label|`).
 */
export function planToMermaid(plan: Plan, direction: "DOWN" | "RIGHT" = "DOWN"): string {
	const lines: string[] = [`flowchart ${direction === "RIGHT" ? "LR" : "TD"}`];
	const nodeId = makeMermaidIdMapper("node");
	const groupId = makeMermaidIdMapper("stage");
	const validGroupIds = new Set(plan.groups.map((g) => g.id));
	const knownNodeIds = new Set(plan.nodes.map((n) => n.id));

	// Pre-assign deterministic node IDs in plan order.
	for (const n of plan.nodes) nodeId(n.id);

	const ungrouped = plan.nodes.filter((n) => !n.group || !validGroupIds.has(n.group));
	const startUngrouped = ungrouped.filter((n) => n.kind === "start");
	const middleUngrouped = ungrouped.filter((n) => n.kind !== "start" && n.kind !== "end");
	const endUngrouped = ungrouped.filter((n) => n.kind === "end");

	for (const n of startUngrouped) {
		lines.push(`  ${mermaidNodeDecl(nodeId(n.id), n)}`);
	}

	for (const g of plan.groups) {
		const members = plan.nodes.filter((n) => n.group === g.id);
		if (!members.length) continue;
		const gid = groupId(g.id);
		lines.push(`  subgraph ${gid}["${escapeMermaidLabel(g.name || g.id)}"]`);
		for (const n of members) {
			lines.push(`    ${mermaidNodeDecl(nodeId(n.id), n)}`);
		}
		lines.push("  end");
	}

	for (const n of middleUngrouped) {
		lines.push(`  ${mermaidNodeDecl(nodeId(n.id), n)}`);
	}
	for (const n of endUngrouped) {
		lines.push(`  ${mermaidNodeDecl(nodeId(n.id), n)}`);
	}

	for (const e of plan.edges) {
		if (!knownNodeIds.has(e.from) || !knownNodeIds.has(e.to)) continue;
		const from = nodeId(e.from);
		const to = nodeId(e.to);
		const label = e.label ? formatMermaidEdgeLabel(e.label) : "";
		lines.push(label ? `  ${from} -->|${label}| ${to}` : `  ${from} --> ${to}`);
	}

	return lines.join("\n");
}

const PLAN_MERMAID_START = "<!-- plan-mermaid:start -->";
const PLAN_MERMAID_END = "<!-- plan-mermaid:end -->";
const PLAN_MERMAID_RE = /(<!--\s*plan-mermaid:start(?:\s+[^>]*)?\s*-->)[\s\S]*?(<!--\s*plan-mermaid:end\s*-->)/;

/**
 * Surgically updates the Mermaid chart between `<!-- plan-mermaid:start -->` and
 * `<!-- plan-mermaid:end -->` markers in a Markdown spec or ticket (ADR 0002),
 * preserving surrounding prose and CRLF/LF line endings. Appends a `## Flow`
 * section with markers cleanly when none is present yet.
 */
export function syncPlanMermaidInMarkdown(markdown: string, mermaidBlock: string, planName?: string): string {
	const eol = markdown.includes("\r\n") ? "\r\n" : "\n";
	const raw = mermaidBlock.trim().replace(/\r?\n/g, eol);
	const fenced = raw.startsWith("```") ? raw : `\`\`\`mermaid${eol}${raw}${eol}\`\`\``;

	if (PLAN_MERMAID_RE.test(markdown)) {
		return markdown.replace(PLAN_MERMAID_RE, (_match, open: string, close: string) => `${open}${eol}${fenced}${eol}${close}`);
	}

	const heading = planName?.trim()
		? `## Flow${eol}${eol}_Synced from \`${planName.trim()}\`._`
		: "## Flow";
	const section = `${heading}${eol}${eol}${PLAN_MERMAID_START}${eol}${fenced}${eol}${PLAN_MERMAID_END}${eol}`;
	if (!markdown.trim()) return section;
	const sep = markdown.endsWith(`${eol}${eol}`) ? "" : markdown.endsWith(eol) ? eol : `${eol}${eol}`;
	return `${markdown}${sep}${section}`;
}

// --- pure plan validation & lightweight drift helpers (Wave 1.5) -----------------

const normSlash = (p: string) => p.trim().replace(/\\/g, "/").replace(/^\.?\/+/, "").toLowerCase();
const stripCodeExt = (p: string) => p.replace(/\.(ssl|srvscr|ds)$/i, "");
const refLastPart = (ref: string) => ref.split(/[./\\]/).filter(Boolean).at(-1) ?? ref;

/** Extracts normalized non-empty target script paths from `plan.targets`. */
export function planTargetsOf(plan: Plan): string[] {
	if (!Array.isArray(plan.targets)) return [];
	const out: string[] = [];
	const seen = new Set<string>();
	for (const item of plan.targets) {
		const raw = typeof item === "string" ? item : isObject(item) && typeof item.script === "string" ? item.script : "";
		const trimmed = raw.trim();
		if (!trimmed) continue;
		const key = trimmed.toLowerCase();
		if (seen.has(key)) continue;
		seen.add(key);
		out.push(trimmed);
	}
	return out;
}

export type WorkspaceSymbolHit = { name: string; kind?: number; containerName?: string; path: string };

/**
 * Pure verification of a plan node's `ref` (unqualified procedure, qualified `Script.Proc`
 * or `Category.Script.Proc`, or script/data-source `.ssl`/`.srvscr`/`.ds` path/name)
 * against workspace symbols and files. Rejects mismatched script qualifiers (e.g.
 * `WrongScript.Helper`) while accepting valid `.ds` and script references.
 */
export function refMatchesWorkspace(
	ref: string,
	symbols: readonly WorkspaceSymbolHit[],
	workspaceFiles: readonly string[],
	root?: string | null,
): boolean {
	const raw = ref.trim();
	if (!raw) return false;
	const relOf = (p: string) => normSlash(relativeTo(root, p));
	const codeFiles = workspaceFiles.filter((f) => /\.(ssl|srvscr|ds)$/i.test(f));

	// Explicit path or file extension (e.g. `src/DueDates/Holidays.ds`, `Orders/Helper.ssl`).
	if (raw.includes("/") || raw.includes("\\") || /\.(ssl|srvscr|ds)$/i.test(raw)) {
		const clean = normSlash(raw);
		return codeFiles.some((f) => {
			const rel = relOf(f);
			const full = normSlash(f);
			return rel === clean || full === clean || rel.endsWith(`/${clean}`) || full.endsWith(`/${clean}`) || codeMatchesRef(f, raw, root);
		});
	}

	const parts = raw.split(".").filter(Boolean);
	if (!parts.length) return false;
	const last = parts.at(-1)!.toLowerCase();
	const qualifiers = parts.slice(0, -1).map((p) => p.toLowerCase());
	const qualPath = qualifiers.join("/");

	// 1. Match workspace symbols (verifying script/category qualifiers when qualified).
	for (const sym of symbols) {
		const symRel = relOf(sym.path);
		if (symRel.startsWith(".ssl-studio/") || symRel.includes("/.ssl-studio/")) continue;
		if (sym.name.toLowerCase() !== last) continue;
		if (qualifiers.length === 0) return true;
		const symNoExt = stripCodeExt(symRel);
		if (symNoExt === qualPath || symNoExt.endsWith(`/${qualPath}`)) return true;
		if (sym.containerName) {
			const container = sym.containerName.trim().replace(/\\/g, "/").replace(/\./g, "/").toLowerCase();
			if (container === qualPath || container.endsWith(`/${qualPath}`)) return true;
		}
	}

	// 2. Match script or data source files (e.g. `DueDates.Holidays` -> `src/DueDates/Holidays.ds` or `Orders.GetOpen.ds`).
	const dottedPath = parts.map((p) => p.toLowerCase()).join("/");
	const rawLower = raw.toLowerCase();
	for (const f of codeFiles) {
		const fRel = relOf(f);
		if (fRel.startsWith(".ssl-studio/") || fRel.includes("/.ssl-studio/")) continue;
		const fNoExt = stripCodeExt(fRel);
		if (fNoExt === dottedPath || fNoExt.endsWith(`/${dottedPath}`)) return true;
		if (fNoExt === rawLower || fNoExt.endsWith(`/${rawLower}`)) return true;
	}

	return false;
}

/** Validates `n.ref` on ALL actionable node kinds (`step`, `decision`, `call`). */
export function checkPlanRefs(plan: Plan, known: (ref: string) => boolean): Finding[] {
	return plan.nodes
		.filter((n) => (n.kind === "call" || n.kind === "step" || n.kind === "decision") && n.ref?.trim() && !known(n.ref.trim()))
		.map((n) => ({
			severity: "warning" as const,
			code: "plan-unresolved-ref",
			message: `Nothing in the workspace is called ${n.ref!.trim()}.`,
			node: n.id,
		}));
}

export type PlanDocCheckOptions = {
	tickets?: readonly { ticket?: string }[];
	specText?: string | null;
	docs?: readonly Pick<DocFile, "path" | "name" | "group" | "exists" | "ticket">[];
	workspaceFiles?: readonly string[];
	root?: string | null;
};

/** Pure doc/spec/target consistency checks for a plan (ticket, companion spec, `node.docs`, and `plan.targets`). */
export function checkPlanDocs(plan: Plan, options: PlanDocCheckOptions): Finding[] {
	const out: Finding[] = [];
	const ticket = typeof plan.ticket === "string" ? plan.ticket.trim() : "";
	const tickets = (options.tickets ?? []).filter((t) => Boolean(t.ticket?.trim()));
	if (ticket && tickets.length > 0 && !tickets.some((t) => t.ticket!.trim().toLowerCase() === ticket.toLowerCase())) {
		out.push({
			severity: "warning",
			code: "plan-unknown-ticket",
			message: `Ticket ${ticket} was not found in the project's tickets.`,
			field: "ticket",
		});
	}
	const recorded = options.specText ? specHash(options.specText) : null;
	if (recorded !== null && recorded !== planHash(plan)) {
		out.push({
			severity: "warning",
			code: "plan-stale-spec",
			message: "The companion plan doc is out of sync with the current plan. Write the plan doc again before building.",
		});
	}

	// Validate per-node `docs` links against workspace docs & files.
	if (options.docs !== undefined || options.workspaceFiles !== undefined) {
		const existingDocs = (options.docs ?? []).filter((d) => d.exists);
		const wsFiles = options.workspaceFiles ?? [];
		const docExists = (ref: string): boolean => {
			const clean = normSlash(ref);
			if (!clean) return true;
			const inDocs = existingDocs.some((d) => {
				const rel = normSlash(relativeTo(options.root, d.path));
				const full = normSlash(d.path);
				const name = normSlash(d.name);
				return (
					rel === clean ||
					full === clean ||
					full.endsWith(`/${clean}`) ||
					name === clean ||
					(d.group === "tickets" && d.ticket?.trim().toLowerCase() === clean)
				);
			});
			if (inDocs) return true;
			return wsFiles.some((f) => {
				const rel = normSlash(relativeTo(options.root, f));
				const full = normSlash(f);
				return rel === clean || full === clean || full.endsWith(`/${clean}`);
			});
		};
		for (const n of plan.nodes) {
			for (const ref of nodeDocsOf(n)) {
				if (!docExists(ref)) {
					out.push({
						severity: "warning",
						code: "plan-missing-doc",
						message: `Linked document "${ref}" on "${n.text.trim() || n.id}" was not found in the workspace.`,
						node: n.id,
					});
				}
			}
		}
	}

	// Validate `plan.targets` against workspace files.
	if (options.workspaceFiles !== undefined) {
		const wsFiles = options.workspaceFiles;
		for (const target of planTargetsOf(plan)) {
			const clean = normSlash(target);
			const exists = wsFiles.some((f) => {
				const rel = normSlash(relativeTo(options.root, f));
				const full = normSlash(f);
				return rel === clean || full === clean || full.endsWith(`/${clean}`) || codeMatchesRef(f, target, options.root);
			});
			if (!exists) {
				out.push({
					severity: "warning",
					code: "plan-missing-target",
					message: `Target script "${target}" was not found in the workspace.`,
					field: "targets",
				});
			}
		}
	}

	return out;
}

/**
 * Checks plan stage `groups` against SSL `/* region <Stage>;` markers returned by `starlims-lsp`
 * (Namespace DocumentSymbols, ADR 0003). Flags stages absent from all checked target SSL files.
 */
export function stageRegionDrift(plan: Plan, targetRegions: ReadonlySet<string>, targetScripts: readonly string[]): Drift[] {
	if (!targetScripts.length || !plan.groups.length) return [];
	const known = new Set([...targetRegions].map((r) => r.trim().toLowerCase()));
	const out: Drift[] = [];
	for (const g of plan.groups) {
		const members = plan.nodes.filter((n) => n.group === g.id);
		if (!members.length) continue;
		const wanted = g.name.trim().toLowerCase();
		if (!wanted || known.has(wanted)) continue;
		out.push({
			kind: "orphan",
			unit: g.name,
			node: members[0]!.id,
			severity: "info",
			message: `Stage "${g.name}" has no matching /* region ${g.name}; marker in ${targetScripts.join(", ")}.`,
		});
	}
	return out;
}

/**
 * Lightweight ref/target and stage-region drift check for manually authored plans
 * whose `built.units` is empty. Uses only language-server readings & regions (ADR 0003).
 */
export function manualPlanDrift(
	plan: Plan,
	readings: ReadonlyMap<string, Reading | null>,
	targetRegions?: ReadonlySet<string>,
	checkedTargets: readonly string[] = [],
): Drift[] {
	const out: Drift[] = [];
	if (targetRegions !== undefined && checkedTargets.length > 0) {
		out.push(...stageRegionDrift(plan, targetRegions, checkedTargets));
	}

	const validReadings = [...readings.entries()].filter((entry): entry is [string, Reading] => entry[1] !== null);
	if (!validReadings.length) return out;

	const definedProcs = new Set<string>();
	const calledTargets = new Set<string>();
	const scriptNames = new Set<string>();
	for (const [scriptPath, reading] of validReadings) {
		const stem = stripCodeExt(baseName(scriptPath)).toLowerCase();
		if (stem) scriptNames.add(stem);
		if (reading.name) {
			scriptNames.add(reading.name.toLowerCase());
			scriptNames.add(refLastPart(reading.name).toLowerCase());
		}
		for (const proc of reading.procedures) definedProcs.add(proc.name.toLowerCase());
		for (const edge of reading.edges) {
			calledTargets.add(edge.target.toLowerCase());
			calledTargets.add(refLastPart(edge.target).toLowerCase());
		}
	}

	const labelTargets = checkedTargets.length ? checkedTargets.join(", ") : validReadings.map(([p]) => p).join(", ");
	const unitLabel = checkedTargets[0] ?? validReadings[0]![0];
	for (const n of plan.nodes) {
		if (n.kind !== "call" && n.kind !== "step" && n.kind !== "decision") continue;
		const ref = n.ref?.trim();
		if (!ref) continue;
		const refLower = ref.toLowerCase();
		const short = refLastPart(ref).toLowerCase();
		if (
			definedProcs.has(short) ||
			calledTargets.has(short) ||
			calledTargets.has(refLower) ||
			scriptNames.has(short) ||
			scriptNames.has(refLower)
		) {
			continue;
		}
		out.push({
			kind: "missing-call",
			unit: unitLabel,
			node: n.id,
			severity: "warning",
			message: `The chart's "${n.text.trim() || n.id}" references ${ref}, which is neither defined nor called in ${labelTargets}.`,
		});
	}

	return out;
}

// --- Mermaid-to-Plan import (Wave 4.4) -------------------------------------------

type MermaidShape = "bare" | "rect" | "round" | "diamond" | "circle" | "stadium" | "subroutine";

const MERMAID_OPENERS: readonly { open: string; close: string; shape: MermaidShape }[] = [
	{ open: "(((", close: ")))", shape: "circle" },
	{ open: "((", close: "))", shape: "circle" },
	{ open: "([", close: "])", shape: "stadium" },
	{ open: "[[", close: "]]", shape: "subroutine" },
	{ open: "{{", close: "}}", shape: "diamond" },
	{ open: "[(", close: ")]", shape: "rect" },
	{ open: "[/", close: "/]", shape: "rect" },
	{ open: "[\\", close: "\\]", shape: "rect" },
	{ open: "[/", close: "\\]", shape: "rect" },
	{ open: "[\\", close: "/]", shape: "rect" },
	{ open: "[", close: "]", shape: "rect" },
	{ open: "{", close: "}", shape: "diamond" },
	{ open: "(", close: ")", shape: "round" },
];

function unescapeMermaidLabel(raw: string): string {
	let s = raw.trim();
	if (s.length >= 2 && s.startsWith('"') && s.endsWith('"')) {
		s = s.slice(1, -1);
	}
	return s
		.replace(/<br\s*\/?>/gi, "\n")
		.replace(/#quot;/gi, '"')
		.replace(/&quot;/gi, '"')
		.replace(/&lt;/gi, "<")
		.replace(/&gt;/gi, ">")
		.replace(/&amp;/gi, "&")
		.replace(/\\"/g, '"')
		.trim();
}

function stripMermaidComment(line: string): string {
	let inQuote = false;
	for (let i = 0; i < line.length; i++) {
		const ch = line[i]!;
		if (ch === '"' && line[i - 1] !== "\\") {
			inQuote = !inQuote;
			continue;
		}
		if (!inQuote && ch === "%" && line[i + 1] === "%") {
			return line.slice(0, i);
		}
	}
	return line;
}

function splitMermaidStatements(line: string): string[] {
	const out: string[] = [];
	let inQuote = false;
	let start = 0;
	for (let i = 0; i < line.length; i++) {
		const ch = line[i]!;
		if (ch === '"' && line[i - 1] !== "\\") {
			inQuote = !inQuote;
			continue;
		}
		if (inQuote || ch !== ";") continue;
		// Do not split on HTML/Mermaid entities like `&lt;`, `&gt;`, `#quot;`, `&#39;`.
		const before = line.slice(start, i);
		if (/(?:&[A-Za-z0-9#]+|#quot)$/.test(before)) continue;
		const piece = before.trim();
		if (piece) out.push(piece);
		start = i + 1;
	}
	const tail = line.slice(start).trim();
	if (tail) out.push(tail);
	return out;
}

const MERMAID_SKIP_LINE = /^(?:classDef|class|style|linkStyle|click|direction|accTitle|accDescr)\b/i;

type ParsedMermaidAtom = { id: string; shape?: MermaidShape; text?: string };

/** Reads one Mermaid node reference (`id` + optional shape/label + optional `:::class`) starting at `pos`. */
function readMermaidAtom(src: string, start: number): { atom: ParsedMermaidAtom; next: number } | null {
	let i = start;
	while (i < src.length && /\s/.test(src[i]!)) i++;
	const idMatch = /^([A-Za-z0-9_][A-Za-z0-9_.-]*)/.exec(src.slice(i));
	if (!idMatch) return null;
	const id = idMatch[1]!;
	if (MERMAID_RESERVED.has(id.toLowerCase()) && i + id.length < src.length && /\s/.test(src[i + id.length]!)) {
		return null;
	}
	i += id.length;

	let shape: MermaidShape | undefined;
	let text: string | undefined;

	for (const spec of MERMAID_OPENERS) {
		if (!src.startsWith(spec.open, i)) continue;
		const bodyStart = i + spec.open.length;
		let j = bodyStart;
		if (src[j] === '"') {
			j++;
			while (j < src.length) {
				if (src[j] === '"' && src[j - 1] !== "\\") {
					j++;
					break;
				}
				j++;
			}
			while (j < src.length && /\s/.test(src[j]!)) j++;
			if (src.startsWith(spec.close, j)) {
				text = unescapeMermaidLabel(src.slice(bodyStart, j));
				shape = spec.shape;
				i = j + spec.close.length;
				break;
			}
		}
		const closeAt = src.indexOf(spec.close, bodyStart);
		if (closeAt >= 0) {
			text = unescapeMermaidLabel(src.slice(bodyStart, closeAt));
			shape = spec.shape;
			i = closeAt + spec.close.length;
			break;
		}
	}

	// Skip optional `:::className` class shorthand.
	const clsMatch = /^:::[A-Za-z0-9_-]+/.exec(src.slice(i));
	if (clsMatch) i += clsMatch[0].length;

	return { atom: { id, shape, text }, next: i };
}

function readMermaidNodeGroup(src: string, start: number): { atoms: ParsedMermaidAtom[]; next: number } | null {
	const first = readMermaidAtom(src, start);
	if (!first) return null;
	const atoms = [first.atom];
	let i = first.next;
	while (true) {
		let j = i;
		while (j < src.length && /\s/.test(src[j]!)) j++;
		if (src[j] !== "&") break;
		const more = readMermaidAtom(src, j + 1);
		if (!more) break;
		atoms.push(more.atom);
		i = more.next;
	}
	return { atoms, next: i };
}

/** Reads a Mermaid edge operator (`-->`, `-->|label|`, `-- label -->`, `-.->`, `==>`, `---`) at `start`. */
function readMermaidArrow(src: string, start: number): { label?: string; next: number } | null {
	let i = start;
	while (i < src.length && /\s/.test(src[i]!)) i++;
	const rest = src.slice(i);

	// 1. Inline-labeled edges: `-- text -->`, `-. text .->`, `== text ==>`
	const inlinePatterns = [
		/^--\s+([^->\n]+?)\s+--+>/,
		/^--\s+([^->\n]+?)\s+---/,
		/^-\.\s+([^.\n]+?)\s+\.-+>/,
		/^==\s+([^=>\n]+?)\s+==+>/,
	];
	for (const re of inlinePatterns) {
		const m = re.exec(rest);
		if (m) {
			return { label: unescapeMermaidLabel(m[1]!), next: i + m[0].length };
		}
	}

	// 2. Standard arrows optionally followed by `|label|`
	const arrowRe = /^(?:<)?(?:--+>|---+|-\.+->|-\.+-|==+>|===+|--+[ox]|[ox]--+[ox]?)/;
	const am = arrowRe.exec(rest);
	if (!am) return null;
	i += am[0].length;
	let j = i;
	while (j < src.length && /\s/.test(src[j]!)) j++;
	if (src[j] === "|") {
		let k = j + 1;
		let inQuote = false;
		while (k < src.length) {
			if (src[k] === '"' && src[k - 1] !== "\\") {
				inQuote = !inQuote;
				k++;
				continue;
			}
			if (!inQuote && src[k] === "|") {
				const label = unescapeMermaidLabel(src.slice(j + 1, k));
				return { ...(label ? { label } : {}), next: k + 1 };
			}
			k++;
		}
	}
	return { next: i };
}

/**
 * Pure parser converting a Mermaid `flowchart TD|LR|TB|RL` or `graph` diagram
 * (with optional `subgraph` stages, shapes `[step]`, `{decision}`, `((start/end))`,
 * `([call])` / `(["start/end"])`, `[[call]]`, and labeled edges `A -->|label| B`)
 * into a valid SSL Studio `Plan`. Returns `null` for non-flowchart or empty input.
 */
export function mermaidToPlan(mermaidSource: string, title?: string): Plan | null {
	if (typeof mermaidSource !== "string" || !mermaidSource.trim()) return null;
	// Unwrap outer Markdown ```mermaid fence when pasted with fences.
	const fenced = /```(?:mermaid)?\s*\r?\n([\s\S]*?)```/i.exec(mermaidSource);
	const body = (fenced ? fenced[1]! : mermaidSource).replace(/\r\n?/g, "\n");

	const rawLines = body.split("\n").map((l) => stripMermaidComment(l).trim());
	const headerIdx = rawLines.findIndex((l) => l.length > 0);
	if (headerIdx < 0) return null;
	const headerLine = rawLines[headerIdx]!;
	if (!/^(?:flowchart|graph)(?:\s+(?:TD|TB|LR|RL|BT))?\s*;?\s*$/i.test(headerLine)) return null;

	type DraftNode = { id: string; text: string; shape: MermaidShape; group?: string; hasLabel: boolean };
	const nodeMap = new Map<string, DraftNode>();
	const nodeOrder: string[] = [];
	const groups: PlanGroup[] = [];
	const groupById = new Map<string, PlanGroup>();
	const groupStack: string[] = [];
	const edges: PlanEdge[] = [];
	const edgeKeys = new Set<string>();

	const ensureNode = (atom: ParsedMermaidAtom, currentGroup: string | undefined) => {
		let entry = nodeMap.get(atom.id);
		if (!entry) {
			entry = {
				id: atom.id,
				text: atom.text || atom.id,
				shape: atom.shape ?? "bare",
				...(currentGroup ? { group: currentGroup } : {}),
				hasLabel: atom.text !== undefined,
			};
			nodeMap.set(atom.id, entry);
			nodeOrder.push(atom.id);
		} else {
			if (atom.shape && (entry.shape === "bare" || !entry.hasLabel)) {
				entry.shape = atom.shape;
			}
			if (atom.text !== undefined && (!entry.hasLabel || entry.text === entry.id)) {
				entry.text = atom.text || atom.id;
				entry.hasLabel = true;
			}
			if (currentGroup && !entry.group) {
				entry.group = currentGroup;
			}
		}
		return entry;
	};

	const parseSubgraph = (stmt: string): PlanGroup => {
		const rest = stmt.replace(/^subgraph\s+/i, "").trim();
		// Form 1: `subgraph id["Label"]` or `subgraph id[Label]`
		const idBracket = /^([A-Za-z0-9_-]+)\s*\[([\s\S]+)\]$/.exec(rest);
		if (idBracket) {
			const id = idBracket[1]!;
			const name = unescapeMermaidLabel(idBracket[2]!) || id;
			const existing = groupById.get(id);
			if (existing) return existing;
			const g: PlanGroup = { id, name };
			groupById.set(id, g);
			groups.push(g);
			return g;
		}
		// Form 2: `subgraph "Label"` or `subgraph Plain Label`
		const label = unescapeMermaidLabel(rest) || `Stage ${groups.length + 1}`;
		let id = `g${groups.length + 1}`;
		while (groupById.has(id) || nodeMap.has(id)) id = `g${groups.length + Math.floor(Math.random() * 1000) + 2}`;
		const g: PlanGroup = { id, name: label };
		groupById.set(id, g);
		groups.push(g);
		return g;
	};

	for (let li = headerIdx + 1; li < rawLines.length; li++) {
		const line = rawLines[li]!;
		if (!line) continue;
		for (const stmt of splitMermaidStatements(line)) {
			if (!stmt || MERMAID_SKIP_LINE.test(stmt)) continue;
			if (/^end$/i.test(stmt)) {
				if (groupStack.length) groupStack.pop();
				continue;
			}
			if (/^subgraph\b/i.test(stmt)) {
				const g = parseSubgraph(stmt);
				groupStack.push(g.id);
				continue;
			}

			const currentGroup = groupStack.at(-1);
			const firstGroup = readMermaidNodeGroup(stmt, 0);
			if (!firstGroup) continue;
			for (const a of firstGroup.atoms) ensureNode(a, currentGroup);

			let prevAtoms = firstGroup.atoms;
			let pos = firstGroup.next;
			while (pos < stmt.length) {
				const arrow = readMermaidArrow(stmt, pos);
				if (!arrow) break;
				const nextGroup = readMermaidNodeGroup(stmt, arrow.next);
				if (!nextGroup) break;
				for (const a of nextGroup.atoms) ensureNode(a, currentGroup);
				for (const srcAtom of prevAtoms) {
					for (const dstAtom of nextGroup.atoms) {
						if (srcAtom.id === dstAtom.id) continue;
						const key = `${srcAtom.id}>${dstAtom.id}`;
						if (edgeKeys.has(key)) continue;
						edgeKeys.add(key);
						edges.push({
							from: srcAtom.id,
							to: dstAtom.id,
							...(arrow.label ? { label: arrow.label } : {}),
						});
					}
				}
				prevAtoms = nextGroup.atoms;
				pos = nextGroup.next;
			}
		}
	}

	if (!nodeOrder.length) return null;

	const inDeg = new Map<string, number>();
	const outDeg = new Map<string, number>();
	for (const id of nodeOrder) {
		inDeg.set(id, 0);
		outDeg.set(id, 0);
	}
	for (const e of edges) {
		outDeg.set(e.from, (outDeg.get(e.from) ?? 0) + 1);
		inDeg.set(e.to, (inDeg.get(e.to) ?? 0) + 1);
	}

	let assignedStart = false;
	const nodes: PlanNode[] = nodeOrder.map((id) => {
		const d = nodeMap.get(id)!;
		const ins = inDeg.get(id) ?? 0;
		const outs = outDeg.get(id) ?? 0;
		let kind: NodeKind;
		switch (d.shape) {
			case "diamond":
				kind = "decision";
				break;
			case "subroutine":
				kind = "call";
				break;
			case "circle":
				if (ins === 0 && outs > 0) kind = "start";
				else if (outs === 0 && ins > 0) kind = "end";
				else if (/^(end|done|finish|return|stop|exit)\b/i.test(d.text)) kind = "end";
				else if (!assignedStart) kind = "start";
				else kind = "end";
				break;
			case "stadium":
				if (ins === 0 && outs > 0) kind = "start";
				else if (outs === 0 && ins > 0) kind = "end";
				else if (ins > 0 && outs > 0) kind = "call";
				else if (/^(start|begin|receive|entry)\b/i.test(d.text)) kind = "start";
				else if (/^(end|done|finish|return|stop|exit)\b/i.test(d.text)) kind = "end";
				else kind = "call";
				break;
			default:
				kind = "step";
				break;
		}
		if (kind === "start") assignedStart = true;
		const ref = kind === "call" ? d.text.split("\n")[0]!.trim() || d.id : undefined;
		return {
			id: d.id,
			kind,
			text: d.text,
			...(ref ? { ref } : {}),
			...(d.group ? { group: d.group } : {}),
		};
	});

	const usedGroups = new Set(nodes.map((n) => n.group).filter(Boolean));
	const keptGroups = groups.filter((g) => usedGroups.has(g.id));

	return {
		version: 1,
		title: title?.trim() || "Imported Flowchart",
		groups: keptGroups,
		nodes,
		edges,
	};
}

// --- pure Plan multi-select, align, distribute & copy/paste helpers (Wave 4.4) ---

export type NodeRect = { id: string; x: number; y: number; width: number; height: number };
export type AlignAction = "left" | "center" | "top" | "distribute-h" | "distribute-v";
export type PlanClipboard = { nodes: PlanNode[]; edges: PlanEdge[] };

/** Returns IDs of all nodes whose bounding box intersects the selection marquee rectangle. */
export function marqueeNodeIds(
	boxes: readonly NodeRect[],
	rect: { x: number; y: number; width: number; height: number },
): string[] {
	const x1 = rect.width >= 0 ? rect.x : rect.x + rect.width;
	const y1 = rect.height >= 0 ? rect.y : rect.y + rect.height;
	const x2 = x1 + Math.abs(rect.width);
	const y2 = y1 + Math.abs(rect.height);
	return boxes
		.filter((b) => b.x + b.width >= x1 && b.x <= x2 && b.y + b.height >= y1 && b.y <= y2)
		.map((b) => b.id);
}

/** Applies one delta `(dx, dy)` to every node in `ids`, producing a single clean Plan update. */
export function batchOffsetPlanNodes(
	plan: Plan,
	ids: ReadonlySet<string>,
	dx: number,
	dy: number,
	dir: LayoutDirection = "DOWN",
): Plan {
	if (!ids.size || (Math.abs(dx) < 1 && Math.abs(dy) < 1)) return plan;
	let next = plan;
	for (const node of plan.nodes) {
		if (!ids.has(node.id)) continue;
		const cur = offsetFor(node.offset, dir);
		const offset: PlanOffset = {
			x: Math.round(cur.x + dx),
			y: Math.round(cur.y + dy),
			...(dir === "RIGHT" ? { dir: "RIGHT" } : {}),
		};
		next = setNodeOffset(next, node.id, offset);
	}
	return next;
}

/** Aligns or evenly distributes selected nodes by adjusting their sparse `offset` fields (ADR 0002). */
export function alignPlanNodes(
	plan: Plan,
	selectedIds: ReadonlySet<string>,
	boxes: readonly NodeRect[],
	action: AlignAction,
	dir: LayoutDirection = "DOWN",
): Plan {
	const picked = boxes.filter((b) => selectedIds.has(b.id));
	if (picked.length < 2) return plan;
	const deltas = new Map<string, { dx: number; dy: number }>();

	if (action === "left") {
		const targetX = Math.min(...picked.map((b) => b.x));
		for (const b of picked) deltas.set(b.id, { dx: targetX - b.x, dy: 0 });
	} else if (action === "center") {
		const minX = Math.min(...picked.map((b) => b.x));
		const maxX = Math.max(...picked.map((b) => b.x + b.width));
		const targetCx = (minX + maxX) / 2;
		for (const b of picked) deltas.set(b.id, { dx: targetCx - (b.x + b.width / 2), dy: 0 });
	} else if (action === "top") {
		const targetY = Math.min(...picked.map((b) => b.y));
		for (const b of picked) deltas.set(b.id, { dx: 0, dy: targetY - b.y });
	} else if (action === "distribute-h") {
		if (picked.length < 3) return plan;
		const sorted = [...picked].sort((a, b) => a.x + a.width / 2 - (b.x + b.width / 2));
		const first = sorted[0]!;
		const last = sorted.at(-1)!;
		const middleWidth = sorted.slice(1, -1).reduce((sum, b) => sum + b.width, 0);
		const freeSpace = last.x - (first.x + first.width) - middleWidth;
		if (freeSpace >= 0) {
			const gap = freeSpace / (sorted.length - 1);
			let cursor = first.x + first.width + gap;
			for (let i = 1; i < sorted.length - 1; i++) {
				const b = sorted[i]!;
				deltas.set(b.id, { dx: cursor - b.x, dy: 0 });
				cursor += b.width + gap;
			}
		} else {
			const startCx = first.x + first.width / 2;
			const step = (last.x + last.width / 2 - startCx) / (sorted.length - 1);
			for (let i = 1; i < sorted.length - 1; i++) {
				const b = sorted[i]!;
				deltas.set(b.id, { dx: startCx + step * i - (b.x + b.width / 2), dy: 0 });
			}
		}
	} else if (action === "distribute-v") {
		if (picked.length < 3) return plan;
		const sorted = [...picked].sort((a, b) => a.y + a.height / 2 - (b.y + b.height / 2));
		const first = sorted[0]!;
		const last = sorted.at(-1)!;
		const middleHeight = sorted.slice(1, -1).reduce((sum, b) => sum + b.height, 0);
		const freeSpace = last.y - (first.y + first.height) - middleHeight;
		if (freeSpace >= 0) {
			const gap = freeSpace / (sorted.length - 1);
			let cursor = first.y + first.height + gap;
			for (let i = 1; i < sorted.length - 1; i++) {
				const b = sorted[i]!;
				deltas.set(b.id, { dx: 0, dy: cursor - b.y });
				cursor += b.height + gap;
			}
		} else {
			const startCy = first.y + first.height / 2;
			const step = (last.y + last.height / 2 - startCy) / (sorted.length - 1);
			for (let i = 1; i < sorted.length - 1; i++) {
				const b = sorted[i]!;
				deltas.set(b.id, { dx: 0, dy: startCy + step * i - (b.y + b.height / 2) });
			}
		}
	}

	let next = plan;
	for (const [id, d] of deltas) {
		if (Math.abs(d.dx) < 0.5 && Math.abs(d.dy) < 0.5) continue;
		const node = plan.nodes.find((n) => n.id === id);
		if (!node) continue;
		const cur = offsetFor(node.offset, dir);
		const offset: PlanOffset = {
			x: Math.round(cur.x + d.dx),
			y: Math.round(cur.y + d.dy),
			...(dir === "RIGHT" ? { dir: "RIGHT" } : {}),
		};
		next = setNodeOffset(next, id, offset);
	}
	return next;
}

/** Captures the selected nodes and their internal edges into an immutable clipboard payload. */
export function copyPlanSelection(plan: Plan, ids: ReadonlySet<string>): PlanClipboard | null {
	const nodes = plan.nodes.filter((n) => ids.has(n.id) && !n.pending);
	if (!nodes.length) return null;
	const keptIds = new Set(nodes.map((n) => n.id));
	const edges = plan.edges.filter((e) => keptIds.has(e.from) && keptIds.has(e.to) && !e.pending && !e.removing);
	return {
		nodes: nodes.map((n) => ({ ...n, ...(n.docs ? { docs: [...n.docs] } : {}), ...(n.offset ? { offset: { ...n.offset } } : {}) })),
		edges: edges.map((e) => ({ from: e.from, to: e.to, ...(e.label ? { label: e.label } : {}) })),
	};
}

/** Pastes copied nodes and internal edges with fresh IDs and a slight canvas offset. */
export function pastePlanSelection(
	plan: Plan,
	clip: PlanClipboard,
	dir: LayoutDirection = "DOWN",
	shift = 36,
): { plan: Plan; pastedIds: string[] } {
	if (!clip.nodes.length) return { plan, pastedIds: [] };
	const idMap = new Map<string, string>();
	const validGroups = new Set(plan.groups.map((g) => g.id));
	const alreadyHasStart = plan.nodes.some((n) => n.kind === "start");
	let working: Plan = { ...plan, nodes: [...plan.nodes], edges: [...plan.edges] };
	const pastedIds: string[] = [];

	for (const src of clip.nodes) {
		const freshId = nextNodeId(working);
		idMap.set(src.id, freshId);
		pastedIds.push(freshId);
		const curOff = offsetFor(src.offset, dir);
		const nextOffset: PlanOffset = {
			x: Math.round(curOff.x + shift),
			y: Math.round(curOff.y + shift),
			...(dir === "RIGHT" ? { dir: "RIGHT" } : {}),
		};
		const docs = nodeDocsOf(src);
		const clone: PlanNode = {
			id: freshId,
			kind: src.kind === "start" && alreadyHasStart ? "step" : src.kind,
			text: src.text,
			...(src.ref ? { ref: src.ref } : {}),
			...(src.group && validGroups.has(src.group) ? { group: src.group } : {}),
			...(src.notes ? { notes: src.notes } : {}),
			...(docs.length ? { docs } : {}),
			offset: nextOffset,
		};
		working = { ...working, nodes: [...working.nodes, clone] };
	}

	const newEdges: PlanEdge[] = [];
	for (const e of clip.edges) {
		const from = idMap.get(e.from);
		const to = idMap.get(e.to);
		if (!from || !to) continue;
		newEdges.push({ from, to, ...(e.label ? { label: e.label } : {}) });
	}
	return { plan: { ...working, edges: [...working.edges, ...newEdges] }, pastedIds };
}

// --- Plan node lookup for Call Graph -> Plan jumps (Wave 4.4) --------------------

/**
 * Locates the 1-based JSON line number of the first node in `planText` whose
 * `ref` or `built.units` matches `scriptPath` and optional `procName`.
 */
export function findMatchingPlanNodeLine(
	planText: string,
	scriptPath: string,
	procName?: string,
	root?: string | null,
): number | null {
	const { plan } = parsePlan(planText);
	if (!plan) return null;
	const lines = nodeLines(planText, plan);
	const procLower = procName?.trim().toLowerCase() ?? "";
	const scriptStem = stripCodeExt(baseName(scriptPath)).toLowerCase();

	const rawBuilt = isObject(plan.built) && Array.isArray(plan.built.units) ? (plan.built.units as Record<string, any>[]) : [];

	const firstNodeLine = (ids: unknown): number | null => {
		if (!Array.isArray(ids)) return null;
		for (const id of ids) {
			if (typeof id === "string") {
				const ln = lines.get(id);
				if (ln) return ln;
			}
		}
		return null;
	};

	const refMatchesProc = (ref: string): boolean => {
		const trimmed = ref.trim();
		if (!trimmed || !procLower) return false;
		const tail = refLastPart(trimmed).toLowerCase();
		if (tail !== procLower && trimmed.toLowerCase() !== procLower) return false;
		const parts = trimmed.split(".").filter(Boolean);
		if (parts.length <= 1) return true;
		const scriptPart = parts.slice(0, -1).join("/");
		return codeMatchesRef(scriptPath, scriptPart, root) || parts.slice(0, -1).some((p) => p.toLowerCase() === scriptStem);
	};

	const refMatchesScript = (ref: string): boolean => {
		const trimmed = ref.trim();
		if (!trimmed) return false;
		if (codeMatchesRef(scriptPath, trimmed, root)) return true;
		const parts = trimmed.split(".").filter(Boolean);
		if (parts.some((p) => p.toLowerCase() === scriptStem)) return true;
		return false;
	};

	// 1. Exact built unit matching procedure (+ script when specified)
	if (procLower) {
		for (const u of rawBuilt) {
			if (typeof u?.name !== "string" || u.name.toLowerCase() !== procLower) continue;
			if (typeof u.script === "string" && u.script && !codeMatchesRef(scriptPath, u.script, root)) continue;
			const ln = firstNodeLine(u.nodes);
			if (ln) return ln;
		}
		// 2. Node ref matching procedure
		for (const n of plan.nodes) {
			if (n.ref && refMatchesProc(n.ref)) {
				const ln = lines.get(n.id);
				if (ln) return ln;
			}
		}
	}

	// 3. Any built unit on this script
	for (const u of rawBuilt) {
		if (typeof u?.script === "string" && u.script && codeMatchesRef(scriptPath, u.script, root)) {
			const ln = firstNodeLine(u.nodes);
			if (ln) return ln;
		}
	}

	// 4. Any node ref targeting this script
	for (const n of plan.nodes) {
		if (n.ref && refMatchesScript(n.ref)) {
			const ln = lines.get(n.id);
			if (ln) return ln;
		}
	}

	return null;
}

// --- Scoped Agent brief builders (Wave 1.8) --------------------------------------

/** Builds a clean, scoped Agent prompt to implement or rebuild one flowchart step. */
export function buildStepAgentDraft(
	plan: Plan,
	nodeId: string,
	opts?: {
		planLabel?: string;
		codeUnits?: readonly { name: string; script: string }[];
		driftItems?: readonly Drift[];
	},
): string {
	const node = plan.nodes.find((n) => n.id === nodeId);
	if (!node) return "";
	const groupName = node.group ? plan.groups.find((g) => g.id === node.group)?.name : undefined;
	const byId = new Map(plan.nodes.map((n) => [n.id, n]));
	const incoming = plan.edges
		.filter((e) => e.to === nodeId)
		.map((e) => {
			const from = byId.get(e.from);
			const label = e.label ? ` [${e.label}]` : "";
			return `- ${from?.text.trim() || e.from}${label} -> this step`;
		});
	const outgoing = plan.edges
		.filter((e) => e.from === nodeId)
		.map((e) => {
			const to = byId.get(e.to);
			const label = e.label ? ` [${e.label}]` : "";
			return `- this step${label} -> ${to?.text.trim() || e.to}`;
		});
	const linkedDocs = nodeDocsOf(node);
	const targets = planTargetsOf(plan);
	const ticket = typeof plan.ticket === "string" ? plan.ticket.trim() : "";
	const relevantDrift = (opts?.driftItems ?? []).filter(
		(d) => d.node === nodeId || (opts?.codeUnits ?? []).some((u) => u.name.toLowerCase() === d.unit.toLowerCase()),
	);

	const parts: string[] = [
		`${opts?.codeUnits?.length ? "Update / rebuild" : "Implement"} the STARLIMS SSL code for step "${node.text.trim() || node.id}" (${node.kind}) in plan "${plan.title || opts?.planLabel || "Plan"}".`,
	];
	if (ticket) parts.push(`Ticket: ${ticket}`);
	if (groupName) parts.push(`Stage: ${groupName}`);
	if (node.ref?.trim()) parts.push(`Referenced procedure / script: ${node.ref.trim()}`);
	if (targets.length) parts.push(`Target scripts: ${targets.join(", ")}`);
	if (opts?.codeUnits?.length) {
		parts.push(`Linked built units: ${opts.codeUnits.map((u) => `${u.name} (${u.script})`).join(", ")}`);
	}
	if (node.notes?.trim()) parts.push("", "Step notes:", node.notes.trim());
	if (linkedDocs.length) parts.push("", "Linked docs:", ...linkedDocs.map((d) => `- ${d}`));
	if (incoming.length || outgoing.length) {
		parts.push("", "Flowchart neighbors:", ...incoming, ...outgoing);
	}
	if (relevantDrift.length) {
		parts.push("", "Current drift findings:", ...relevantDrift.map((d) => `- [${d.severity}] ${d.message}`));
	}
	return parts.join("\n");
}

/** Builds a clean, scoped Agent prompt to implement or rebuild one flowchart stage. */
export function buildStageAgentDraft(
	plan: Plan,
	groupId: string,
	opts?: { planLabel?: string; driftItems?: readonly Drift[] },
): string {
	const group = plan.groups.find((g) => g.id === groupId);
	if (!group) return "";
	const members = plan.nodes.filter((n) => n.group === groupId);
	const targets = planTargetsOf(plan);
	const ticket = typeof plan.ticket === "string" ? plan.ticket.trim() : "";
	const memberIds = new Set(members.map((m) => m.id));
	const stageDrift = (opts?.driftItems ?? []).filter((d) => (d.node && memberIds.has(d.node)) || d.unit.toLowerCase() === group.name.toLowerCase());

	const parts: string[] = [
		`Implement or update the STARLIMS SSL code for stage "${group.name}" in plan "${plan.title || opts?.planLabel || "Plan"}".`,
	];
	if (ticket) parts.push(`Ticket: ${ticket}`);
	if (targets.length) parts.push(`Target scripts: ${targets.join(", ")}`);
	if (members.length) {
		parts.push(
			"",
			"Steps in this stage:",
			...members.map((m) => {
				const extra = [m.ref ? `ref: ${m.ref}` : "", m.notes ? m.notes : ""].filter(Boolean).join(" — ");
				return `- [${m.kind}] ${m.text.trim() || m.id}${extra ? ` (${extra})` : ""}`;
			}),
		);
	}
	const docs = [...new Set(members.flatMap((m) => nodeDocsOf(m)))];
	if (docs.length) parts.push("", "Linked docs:", ...docs.map((d) => `- ${d}`));
	if (stageDrift.length) parts.push("", "Drift findings:", ...stageDrift.map((d) => `- [${d.severity}] ${d.message}`));
	return parts.join("\n");
}

/** Builds a clean, scoped Agent prompt to reconcile drift between a plan chart and its SSL code. */
export function buildDriftAgentDraft(
	plan: Plan,
	driftItems: readonly Drift[],
	opts?: { planLabel?: string },
): string {
	const targets = planTargetsOf(plan);
	const ticket = typeof plan.ticket === "string" ? plan.ticket.trim() : "";
	const parts: string[] = [
		`Reconcile the drift between plan "${plan.title || opts?.planLabel || "Plan"}" and its STARLIMS SSL implementation.`,
	];
	if (ticket) parts.push(`Ticket: ${ticket}`);
	if (targets.length) parts.push(`Target scripts: ${targets.join(", ")}`);
	if (driftItems.length) {
		parts.push(
			"",
			"Detected differences:",
			...driftItems.map((d) => `- [${d.severity}] (${d.unit}) ${d.message}`),
		);
	}
	parts.push("", "Check whether the code or the flowchart is right for each item, then propose the minimal edits to bring them back in sync.");
	return parts.join("\n");
}

/** Builds a clean, scoped Agent prompt to implement a plan directly when no approved companion spec exists yet. */
export function buildPlanAgentDraft(
	plan: Plan,
	opts?: { planLabel?: string; driftItems?: readonly Drift[] },
): string {
	const targets = planTargetsOf(plan);
	const ticket = typeof plan.ticket === "string" ? plan.ticket.trim() : "";
	const parts: string[] = [
		`Implement or update the STARLIMS SSL code for plan "${plan.title || opts?.planLabel || "Plan"}".`,
	];
	if (ticket) parts.push(`Ticket: ${ticket}`);
	if (typeof plan.goal === "string" && plan.goal.trim()) parts.push(`Goal: ${plan.goal.trim()}`);
	if (targets.length) parts.push(`Target scripts: ${targets.join(", ")}`);
	parts.push("", "Flowchart:", "```mermaid", planToMermaid(plan), "```");
	const docs = [...new Set(plan.nodes.flatMap((n) => nodeDocsOf(n)))];
	if (docs.length) parts.push("", "Linked docs:", ...docs.map((d) => `- ${d}`));
	if (opts?.driftItems?.length) {
		parts.push("", "Current drift findings:", ...opts.driftItems.map((d) => `- [${d.severity}] ${d.message}`));
	}
	return parts.join("\n");
}

/** Builds a clean, scoped Agent prompt to draft STARLIMS SSL unit tests from a plan's flowchart and business test cases. */
export function buildTestsAgentDraft(
	plan: Plan,
	opts?: { planLabel?: string; nodeId?: string },
): string {
	const targets = planTargetsOf(plan);
	const ticket = typeof plan.ticket === "string" ? plan.ticket.trim() : "";
	const focusNode = opts?.nodeId ? plan.nodes.find((n) => n.id === opts.nodeId) : undefined;
	const tests = planTestsOf(plan).filter((t) => !focusNode || !t.node || t.node === focusNode.id);
	const parts: string[] = [
		focusNode
			? `Write STARLIMS SSL unit tests covering step "${focusNode.text.trim() || focusNode.id}" in plan "${plan.title || opts?.planLabel || "Plan"}".`
			: `Write a STARLIMS SSL unit test script covering all paths and business test cases in plan "${plan.title || opts?.planLabel || "Plan"}".`,
	];
	if (ticket) parts.push(`Ticket: ${ticket}`);
	if (targets.length) parts.push(`Target scripts: ${targets.join(", ")}`);
	if (tests.length) {
		parts.push(
			"",
			"Business test cases:",
			...tests.map((t) =>
				`- **${t.title}**${t.given ? ` | Given: ${t.given}` : ""}${t.expect ? ` | Expect: ${t.expect}` : ""}`,
			),
		);
	}
	parts.push("", "Flowchart:", "```mermaid", planToMermaid(plan), "```");
	return parts.join("\n");
}
