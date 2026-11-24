// A plan's check, on every change, with or without the chart showing: no agent
// and no cost. Findings go to Problems beside the language server's. The server
// answers whether a call node's target exists; if it cannot be asked, that one
// check waits rather than reporting everything as missing. Once built, the drift
// between chart and code is reported the same way, and re-read as scripts change.
import { createEffect, createRoot, on } from "solid-js";
import { jsonProblem } from "../../shared/jsonCheck";
import { baseName } from "../../shared/paths";
import { backend } from "../backend";
import { monaco } from "../editor/monaco";
import { publishFindings, session } from "../lsp/session";
import { docs } from "../project";
import { canonical, documents, state } from "../state";
import { checkPlanDocs, checkPlanRefs, planTargetsOf, refMatchesWorkspace, type PlanDocCheckOptions, type WorkspaceSymbolHit } from "./assist";
import { builtOf, driftFindings } from "./built";
import { clearDrift, driftFor, readDrift } from "./drift";
import { checkPlan, findingLine, parsePlan, type Plan } from "./model";

export { checkPlanDocs, checkPlanRefs, planTargetsOf, refMatchesWorkspace, type PlanDocCheckOptions, type WorkspaceSymbolHit };

const planDocPath = (planPath: string) => planPath.replace(/\.plan\.json$/i, ".plan.md");

const OWNER = "plan";
const SEVERITY = { error: 1, warning: 2, info: 3 } as const;
const MAX_INDEX_RETRIES = 6;
const rechecks = new Map<string, () => void>();

/** Reads a plan's findings and drift again, for what no edit announces: a file deleted, or a view opened. */
export const recheckPlan = (uri: string) => rechecks.get(uri)?.();
/** A file changed on disk: the server takes a moment to read it again. */
export const recheckPlans = () => rechecks.forEach((_soon, uri) => recheckPlan(uri));

async function knownRefs(plan: Plan, workspaceFiles: readonly string[], root = state.workspace?.root): Promise<Set<string> | null> {
	const refs = [
		...new Set(
			plan.nodes
				.filter((n) => (n.kind === "call" || n.kind === "step" || n.kind === "decision") && typeof n.ref === "string" && n.ref.trim())
				.map((n) => n.ref!.trim()),
		),
	];
	if (!refs.length) return new Set<string>();
	const known = new Set<string>();
	try {
		for (const ref of refs) {
			if (state.workspace?.root !== root) return null;
			const queryName =
				ref.includes("/") || ref.includes("\\") || /\.(ssl|srvscr|ds)$/i.test(ref)
					? baseName(ref).replace(/\.(ssl|srvscr|ds)$/i, "")
					: (ref.split(".").filter(Boolean).at(-1) ?? "");
			if (!queryName) continue;
			const found = await session.workspaceSymbols(queryName);
			if (state.workspace?.root !== root) return null;
			const hits: WorkspaceSymbolHit[] = found.map((s) => ({
				name: s.name,
				kind: s.kind,
				containerName: s.containerName,
				path: monaco.Uri.parse(s.location.uri).fsPath,
			}));
			if (refMatchesWorkspace(ref, hits, workspaceFiles, root)) known.add(ref);
		}
	} catch {
		return null;
	}
	return known;
}

export function trackPlan(model: monaco.editor.ITextModel) {
	let timer: ReturnType<typeof setTimeout> | undefined;
	let runSeq = 0;
	let indexRetries = 0;
	const uri = model.uri.toString();
	const planPath = model.uri.scheme === "file" ? model.uri.fsPath : "";
	const companionSpec = planPath ? planDocPath(planPath) : "";
	const companionCanon = companionSpec && companionSpec !== planPath ? canonical(companionSpec) : "";
	const readSpec = async (): Promise<string | null> => {
		if (!companionCanon) return null;
		const open = documents.get(companionCanon) ?? documents.get(companionSpec);
		if (open) return open.model.getValue();
		return backend.read(companionSpec).then(
			(f) => f.text,
			() => null,
		);
	};
	const run = async () => {
		const seq = ++runSeq;
		const version = model.getVersionId();
		const root = state.workspace?.root;
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
		const workspaceFiles = root ? await backend.files().catch(() => null) : null;
		if (seq !== runSeq || model.isDisposed() || model.getVersionId() !== version || state.workspace?.root !== root) return;
		const [known, drift, specText] = await Promise.all([knownRefs(plan, workspaceFiles ?? [], root), readDrift(uri, plan), readSpec()]);
		if (seq !== runSeq || model.isDisposed() || model.getVersionId() !== version || state.workspace?.root !== root) return;
		// The server cannot compare while it is still indexing: ask again, up to a bounded retry cap.
		if ((builtOf(plan) || planTargetsOf(plan).length > 0) && !driftFor(uri).checked && session.supports("ssl/callGraph")) {
			if (indexRetries < MAX_INDEX_RETRIES) {
				indexRetries++;
				soon(5000);
			}
		} else {
			indexRetries = 0;
		}
		const allDocs = docs();
		const loadedTickets = allDocs.filter((d) => d.exists && d.group === "tickets" && d.ticket);
		const findings = [
			...checkPlan(plan),
			...(known ? checkPlanRefs(plan, (ref) => known.has(ref)) : []),
			...driftFindings(drift),
			...checkPlanDocs(plan, {
				tickets: loadedTickets,
				specText,
				docs: allDocs.length > 0 || workspaceFiles !== null ? allDocs : undefined,
				workspaceFiles: workspaceFiles ?? undefined,
				root,
			}),
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
	const changes = model.onDidChangeContent(() => {
		indexRetries = 0;
		soon();
	});
	// A script's text or companion spec changes what the chart is compared with.
	const watched = new Map<monaco.editor.ITextModel, monaco.IDisposable>();
	const unwatch = (other: monaco.editor.ITextModel) => {
		const sub = watched.get(other);
		if (!sub) return;
		watched.delete(other);
		sub.dispose();
	};
	const watch = (other: monaco.editor.ITextModel) => {
		if (other === model || watched.has(other)) return;
		let delay: number | null = null;
		if (other.getLanguageId() === "ssl") delay = 1500;
		else if (companionCanon && other.uri.scheme === "file" && canonical(other.uri.fsPath) === companionCanon) delay = 400;
		if (delay === null) return;
		const wait = delay;
		const onChange = other.onDidChangeContent(() => {
			indexRetries = 0;
			soon(wait);
		});
		const onDispose = other.onWillDispose(() => unwatch(other));
		watched.set(other, {
			dispose() {
				onChange.dispose();
				onDispose.dispose();
			},
		});
	};
	monaco.editor.getModels().forEach(watch);
	const created = monaco.editor.onDidCreateModel(watch);
	const disposeDocs = createRoot((dispose) => {
		createEffect(on(docs, () => soon(300), { defer: true }));
		return dispose;
	});
	rechecks.set(uri, () => {
		indexRetries = 0;
		soon(1000);
	});
	void run();
	// The workspace index may still be filling when a plan opens.
	soon(3000);
	model.onWillDispose(() => {
		runSeq++;
		clearTimeout(timer);
		changes.dispose();
		created.dispose();
		disposeDocs();
		for (const other of [...watched.keys()]) unwatch(other);
		rechecks.delete(uri);
		clearDrift(uri);
		publishFindings(model, OWNER, null);
	});
}
