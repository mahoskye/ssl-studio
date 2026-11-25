// Canonical prompt summary for `.plan.json` files (ADR 0005), shared across
// `workContext.ts` and the Agent context builder so every surface reads the
// real plan schema (`title`, `goal`, `ticket`, `targets`, `nodes[].text`,
// unanswered `decisions[]`, `tests[]`, and `built`).

type RawPlanTarget = string | { script?: unknown; path?: unknown; procedures?: unknown };
type RawPlanNode = { kind?: unknown; text?: unknown; label?: unknown; ref?: unknown; docs?: unknown };
type RawPlanDecision = { question?: unknown; answer?: unknown; node?: unknown };
type RawPlanTest = { id?: unknown; title?: unknown; name?: unknown; given?: unknown; expect?: unknown };
type RawBuiltUnit = { name?: unknown; script?: unknown };

type RawPlan = {
	title?: unknown;
	goal?: unknown;
	ticket?: unknown;
	targets?: unknown;
	scripts?: unknown;
	testScripts?: unknown;
	nodes?: unknown;
	decisions?: unknown;
	openQuestions?: unknown;
	tests?: unknown;
	built?: {
		units?: unknown;
		tests?: { script?: unknown } | unknown;
	} | null;
};

const str = (v: unknown): string => (typeof v === "string" ? v.trim() : "");

function cutCompact(text: string, limit: number): string {
	const compact = text.replace(/\s+/g, " ").trim();
	if (compact.length <= limit) return compact;
	const spaceAt = compact.lastIndexOf(" ", limit);
	const end = spaceAt > limit * 0.5 ? spaceAt : limit;
	return `${compact.slice(0, end)} … (cut short)`;
}

function addUnique(list: string[], seen: Set<string>, raw: string) {
	const clean = raw.trim();
	if (!clean) return;
	const key = clean.toLowerCase();
	if (seen.has(key)) return;
	seen.add(key);
	list.push(clean);
}

/**
 * Summarizes a `.plan.json` document into a compact, deterministic plain-text
 * prompt block reading the canonical plan schema:
 * - `title`, `ticket`, `goal`
 * - `targets` (both `string[]` and `{ script?, path?, procedures? }[]`)
 * - `nodes[]` (`n.text` with fallback `n.label`, `n.kind`, `n.ref`, `n.docs`)
 * - Unanswered `decisions[]` (`!d.answer`, plus fallback legacy `openQuestions`)
 * - `tests[]` (`id`, `title`/`name`, `given`, `expect`)
 * - `built.units[].script` and `built.tests.script`
 *
 * Returns `null` when `rawJson` cannot be parsed as a JSON object or contains
 * no recognized plan information.
 */
export function summarizePlanForPrompt(rawJson: string): string | null {
	if (!rawJson || !rawJson.trim()) return null;
	let parsed: unknown;
	try {
		parsed = JSON.parse(rawJson);
	} catch {
		return null;
	}
	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
	const plan = parsed as RawPlan;

	const lines: string[] = [];

	const title = str(plan.title);
	const ticket = str(plan.ticket);
	const goal = str(plan.goal);
	if (title) lines.push(`Title: ${title}`);
	if (ticket) lines.push(`Ticket: ${ticket}`);
	if (goal) lines.push(`Goal: ${cutCompact(goal, 280)}`);

	// Targets (`string[]` or `{ script?, path?, procedures? }[]`, plus legacy `scripts[]`)
	const targets: string[] = [];
	const targetSeen = new Set<string>();
	const pushTarget = (entry: RawPlanTarget) => {
		if (typeof entry === "string") {
			addUnique(targets, targetSeen, entry);
			return;
		}
		if (entry && typeof entry === "object") {
			const file = str(entry.script) || str(entry.path);
			const procs = Array.isArray(entry.procedures)
				? entry.procedures.map(str).filter(Boolean)
				: [];
			const formatted = [file, procs.length ? `(${procs.join(", ")})` : ""].filter(Boolean).join(" ");
			if (formatted) addUnique(targets, targetSeen, formatted);
		}
	};
	if (Array.isArray(plan.targets)) {
		for (const t of plan.targets as RawPlanTarget[]) pushTarget(t);
	}
	if (Array.isArray(plan.scripts)) {
		for (const s of plan.scripts as RawPlanTarget[]) pushTarget(s);
	}
	if (targets.length) lines.push(`Targets: ${targets.join("; ")}`);

	// Built unit scripts & test script
	const builtScripts: string[] = [];
	const builtSeen = new Set<string>();
	if (plan.built && typeof plan.built === "object" && Array.isArray(plan.built.units)) {
		for (const u of plan.built.units as RawBuiltUnit[]) {
			if (!u || typeof u !== "object") continue;
			const script = str(u.script);
			if (script) addUnique(builtScripts, builtSeen, script);
		}
	}
	if (builtScripts.length) lines.push(`Built scripts: ${builtScripts.join("; ")}`);

	const testScripts: string[] = [];
	const testScriptSeen = new Set<string>();
	if (plan.built && typeof plan.built === "object" && plan.built.tests && typeof plan.built.tests === "object") {
		const ts = str((plan.built.tests as { script?: unknown }).script);
		if (ts) addUnique(testScripts, testScriptSeen, ts);
	}
	if (Array.isArray(plan.testScripts)) {
		for (const ts of plan.testScripts) {
			const s = str(ts);
			if (s) addUnique(testScripts, testScriptSeen, s);
		}
	}
	if (testScripts.length) lines.push(`Test script: ${testScripts.join("; ")}`);

	// Flowchart nodes (`n.text` with fallback `n.label`, plus `n.kind`, `n.ref`, `n.docs`)
	const steps: string[] = [];
	const allNodeDocs: string[] = [];
	const nodeDocsSeen = new Set<string>();
	if (Array.isArray(plan.nodes)) {
		for (const rawNode of plan.nodes as RawPlanNode[]) {
			if (!rawNode || typeof rawNode !== "object") continue;
			const text = str(rawNode.text) || str(rawNode.label);
			const kind = str(rawNode.kind);
			const ref = str(rawNode.ref);
			const docs = Array.isArray(rawNode.docs) ? rawNode.docs.map(str).filter(Boolean) : [];
			for (const d of docs) addUnique(allNodeDocs, nodeDocsSeen, d);
			if (!text || steps.length >= 16) continue;
			const prefix = kind ? `[${kind}] ` : "";
			const refPart = ref ? ` (${ref})` : "";
			const docsPart = docs.length ? ` [docs: ${docs.join(", ")}]` : "";
			steps.push(`${prefix}${cutCompact(text, 120)}${refPart}${docsPart}`);
		}
	}
	if (steps.length) lines.push(`Steps: ${steps.join(" → ")}`);
	if (allNodeDocs.length) lines.push(`Linked docs: ${allNodeDocs.slice(0, 12).join("; ")}`);

	// Unanswered `decisions[]` (where `!d.answer`) + fallback legacy `openQuestions[]`
	const unanswered: string[] = [];
	const questionSeen = new Set<string>();
	if (Array.isArray(plan.decisions)) {
		for (const d of plan.decisions as RawPlanDecision[]) {
			if (!d || typeof d !== "object") continue;
			const q = str(d.question);
			const a = str(d.answer);
			if (q && !a) addUnique(unanswered, questionSeen, cutCompact(q, 180));
		}
	}
	if (Array.isArray(plan.openQuestions)) {
		for (const q of plan.openQuestions) {
			const s = str(q);
			if (s) addUnique(unanswered, questionSeen, cutCompact(s, 180));
		}
	}
	if (unanswered.length) lines.push(`Open decisions: ${unanswered.slice(0, 6).join("; ")}`);

	// Business test cases (`tests[]`)
	const testSummaries: string[] = [];
	if (Array.isArray(plan.tests)) {
		for (const rawTest of plan.tests as RawPlanTest[]) {
			if (!rawTest || typeof rawTest !== "object") continue;
			const id = str(rawTest.id);
			const testTitle = str(rawTest.title) || str(rawTest.name);
			const given = str(rawTest.given);
			const expect = str(rawTest.expect);
			if (!testTitle && !given && !expect) continue;
			const head = [id, testTitle].filter(Boolean).join(": ");
			const givenPart = given ? ` (given: ${cutCompact(given, 100)})` : "";
			const expectPart = expect ? ` => ${cutCompact(expect, 100)}` : "";
			testSummaries.push(`${head || "Test"}${givenPart}${expectPart}`);
			if (testSummaries.length >= 8) break;
		}
	}
	if (testSummaries.length) lines.push(`Tests: ${testSummaries.join("; ")}`);

	return lines.length ? lines.join("\n") : null;
}
