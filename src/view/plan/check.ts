// A plan's check, on every change, with or without the chart showing: no agent
// and no cost. Findings go to Problems beside the language server's. The server
// answers whether a call node's target exists; if it cannot be asked, that one
// check waits rather than reporting everything as missing. Once built, the drift
// between chart and code is reported the same way, and re-read as scripts change.
import { createEffect, createRoot, on } from "solid-js";
import { jsonProblem } from "../../shared/jsonCheck";
import { backend } from "../backend";
import { monaco } from "../editor/monaco";
import { publishFindings, session } from "../lsp/session";
import { docs } from "../project";
import { canonical, documents } from "../state";
import { planHash, specHash } from "./assist";
import { builtOf, driftFindings } from "./built";
import { clearDrift, driftFor, readDrift } from "./drift";
import { checkPlan, checkRefs, findingLine, parsePlan, type Finding, type Plan } from "./model";

const specPath = (planPath: string) => planPath.replace(/\.plan\.json$/i, ".spec.md");

const OWNER = "plan";
const SEVERITY = { error: 1, warning: 2, info: 3 } as const;
const rechecks = new Map<string, () => void>();

/** Reads a plan's findings and drift again, for what no edit announces: a file deleted, or a view opened. */
export const recheckPlan = (uri: string) => rechecks.get(uri)?.();
/** A file changed on disk: the server takes a moment to read it again. */
export const recheckPlans = () => rechecks.forEach((_soon, uri) => recheckPlan(uri));

/** Pure doc/spec consistency checks for a plan (missing linked ticket, stale companion spec). */
export function checkPlanDocs(plan: Plan, options: { tickets?: readonly { ticket?: string }[]; specText?: string | null }): Finding[] {
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
	return out;
}

async function knownRefs(plan: Plan): Promise<Set<string> | null> {
	const refs = [...new Set(plan.nodes.filter((n) => n.kind === "call" && n.ref?.trim()).map((n) => n.ref!))];
	const known = new Set<string>();
	try {
		for (const ref of refs) {
			// A target may be written whole (Category.Script.Procedure); symbols are named by their last part.
			const name = ref.split(".").at(-1)!;
			const found = await session.workspaceSymbols(name);
			if (found.some((s) => s.name.toLowerCase() === name.toLowerCase())) known.add(ref);
		}
	} catch {
		return null;
	}
	return known;
}

export function trackPlan(model: monaco.editor.ITextModel) {
	let timer: ReturnType<typeof setTimeout> | undefined;
	const uri = model.uri.toString();
	const planPath = model.uri.scheme === "file" ? model.uri.fsPath : "";
	const companionSpec = planPath ? specPath(planPath) : "";
	const companionCanon = companionSpec && companionSpec !== planPath ? canonical(companionSpec) : "";
	const readSpec = async (): Promise<string | null> => {
		if (!companionCanon) return null;
		const open = documents.get(companionCanon);
		if (open) return open.model.getValue();
		return backend.read(companionSpec).then(
			(f) => f.text,
			() => null,
		);
	};
	const run = async () => {
		const version = model.getVersionId();
		const text = model.getValue();
		const parsed = parsePlan(text);
		if (parsed.error !== undefined) {
			// Where the text stops being JSON, when that is what is wrong: the place itself is marked, not the first line.
			const json = jsonProblem(text);
			const from = json ? model.getPositionAt(json.offset) : { lineNumber: 1, column: 1 };
			const to = json ? model.getPositionAt(json.offset + json.length) : { lineNumber: 1, column: 2 };
			publishFindings(model, OWNER, [{ line: from.lineNumber, column: from.column, endLine: to.lineNumber, endColumn: to.column, severity: 1, message: json ? `This plan cannot be read. ${json.message}` : parsed.error, code: "plan-unreadable", source: "plan" }]);
			return;
		}
		const plan = parsed.plan;
		const [known, drift, specText] = await Promise.all([knownRefs(plan), readDrift(uri, plan), readSpec()]);
		if (model.isDisposed() || model.getVersionId() !== version) return;
		// The server cannot compare while it is still indexing: ask again.
		if (builtOf(plan) && !driftFor(uri).checked && session.supports("ssl/callGraph")) soon(5000);
		const loadedTickets = docs().filter((d) => d.exists && d.group === "tickets" && d.ticket);
		const findings = [
			...checkPlan(plan),
			...(known ? checkRefs(plan, (ref) => known.has(ref)) : []),
			...driftFindings(drift),
			...checkPlanDocs(plan, { tickets: loadedTickets, specText }),
		];
		publishFindings(
			model,
			OWNER,
			findings.map((f) => {
				const line = findingLine(text, plan, f);
				return { line, column: 1, endLine: line, endColumn: model.getLineMaxColumn(line), severity: SEVERITY[f.severity], message: f.message, code: f.code, source: "plan" };
			}),
		);
	};
	const soon = (ms = 200) => {
		clearTimeout(timer);
		timer = setTimeout(() => void run(), ms);
	};
	const changes = model.onDidChangeContent(() => soon());
	// A script's text or companion spec changes what the chart is compared with.
	const scripts: monaco.IDisposable[] = [];
	const watch = (other: monaco.editor.ITextModel) => {
		if (other.getLanguageId() === "ssl") scripts.push(other.onDidChangeContent(() => soon(1500)));
		else if (companionCanon && other.uri.scheme === "file" && canonical(other.uri.fsPath) === companionCanon) scripts.push(other.onDidChangeContent(() => soon(400)));
	};
	monaco.editor.getModels().forEach(watch);
	const created = monaco.editor.onDidCreateModel(watch);
	const disposeDocs = createRoot((dispose) => {
		createEffect(on(docs, () => soon(300), { defer: true }));
		return dispose;
	});
	rechecks.set(uri, () => soon(1000));
	void run();
	// The workspace index may still be filling when a plan opens.
	soon(3000);
	model.onWillDispose(() => {
		clearTimeout(timer);
		changes.dispose();
		created.dispose();
		disposeDocs();
		scripts.forEach((s) => s.dispose());
		rechecks.delete(uri);
		clearDrift(uri);
		publishFindings(model, OWNER, null);
	});
}
