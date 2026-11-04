// A plan's check, on every change, with or without the chart showing: no agent
// and no cost. Findings go to Problems beside the language server's. The server
// answers whether a call node's target exists; if it cannot be asked, that one
// check waits rather than reporting everything as missing. Once built, the drift
// between chart and code is reported the same way, and re-read as scripts change.
import { monaco } from "../editor/monaco";
import { publishFindings, session } from "../lsp/session";
import { builtOf, driftFindings } from "./built";
import { clearDrift, driftFor, readDrift } from "./drift";
import { checkPlan, checkRefs, findingLine, parsePlan, type Plan } from "./model";

const OWNER = "plan";
const SEVERITY = { error: 1, warning: 2, info: 3 } as const;
const rechecks = new Map<string, () => void>();

/** Reads a plan's findings and drift again, for what no edit announces: a file deleted, or a view opened. */
export const recheckPlan = (uri: string) => rechecks.get(uri)?.();
/** A file changed on disk: the server takes a moment to read it again. */
export const recheckPlans = () => rechecks.forEach((_soon, uri) => recheckPlan(uri));

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
	const run = async () => {
		const version = model.getVersionId();
		const text = model.getValue();
		const parsed = parsePlan(text);
		if (parsed.error !== undefined) {
			publishFindings(model, OWNER, [{ line: 1, column: 1, endLine: 1, endColumn: 2, severity: 1, message: parsed.error, code: "plan-unreadable", source: "plan" }]);
			return;
		}
		const plan = parsed.plan;
		const known = await knownRefs(plan);
		const drift = await readDrift(uri, plan);
		if (model.isDisposed() || model.getVersionId() !== version) return;
		// The server cannot compare while it is still indexing: ask again.
		if (builtOf(plan) && !driftFor(uri).checked && session.supports("ssl/callGraph")) soon(5000);
		const findings = [...checkPlan(plan), ...(known ? checkRefs(plan, (ref) => known.has(ref)) : []), ...driftFindings(drift)];
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
	// A script's text changes what the chart is compared with.
	const scripts: monaco.IDisposable[] = [];
	const watch = (other: monaco.editor.ITextModel) => {
		if (other.getLanguageId() === "ssl") scripts.push(other.onDidChangeContent(() => soon(1500)));
	};
	monaco.editor.getModels().forEach(watch);
	const created = monaco.editor.onDidCreateModel(watch);
	rechecks.set(uri, () => soon(1000));
	void run();
	// The workspace index may still be filling when a plan opens.
	soon(3000);
	model.onWillDispose(() => {
		clearTimeout(timer);
		changes.dispose();
		created.dispose();
		scripts.forEach((s) => s.dispose());
		rechecks.delete(uri);
		clearDrift(uri);
		publishFindings(model, OWNER, null);
	});
}
