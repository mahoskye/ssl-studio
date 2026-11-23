// What passes between a plan and the agent (planning mode stages 2 and 3):
// prompts, and the reply blocks that come back. Pure, so it can be tested with
// no model. Replies use marker lines rather than fences, since a spec holds
// fences of its own, and parsing is lenient, because models close markers the
// wrong way (docs/spikes/planning-mode.md).
import { baseName, relativeTo } from "../../shared/paths";
import type { DocFile } from "../../shared/protocol";
import { codeMatchesRef } from "../../shared/workContext";
import type { Drift, Reading } from "./built";
import { nextNodeId, nodeDocsOf, type Finding, type NodeKind, type Plan, type PlanEdge, type PlanNode } from "./model";

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
			message: "The companion spec is out of sync with the current plan. Write the spec again before building.",
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
