// Reads what the chart is compared with: each built script's procedures and calls, from the
// server. Run by the plan's check, with no agent and no cost. What it finds is a report only:
// the code may well be right (ADR 0005).
import { createStore } from "solid-js/store";
import { backend } from "../backend";
import { monaco } from "../editor/monaco";
import { session } from "../lsp/session";
import { documents, notify, openFile, state } from "../state";
import { baseName, joinPath, relativeTo } from "../../shared/paths";
import { lastPart, procedureBodySpan, scriptEntrySpan } from "./build";
import { builtOf, driftOf, type BuiltUnit, type Drift, type Reading } from "./built";
import type { Plan } from "./model";

export type DriftState = { items: Drift[]; moved: Record<string, string>; checked: boolean };

const EMPTY: DriftState = { items: [], moved: {}, checked: false };
const [drifts, setDrifts] = createStore<Record<string, DriftState>>({});

/** Keyed by the plan's URI, as findings are. */
export const driftFor = (uri: string | undefined): DriftState => (uri && drifts[uri]) || EMPTY;
export const clearDrift = (uri: string) => setDrifts(uri, EMPTY);

export const scriptUri = (script: string) => monaco.Uri.file(joinPath(state.workspace!.root, script)).toString();

/** Null when the server cannot say yet: nothing is reported rather than everything. */
export async function readingOf(script: string): Promise<Reading | null> {
	return session.scriptCalls(scriptUri(script)).catch(() => null);
}

export async function readDrift(uri: string, plan: Plan): Promise<Drift[]> {
	const built = builtOf(plan);
	if (!built?.units.length || !state.workspace) {
		setDrifts(uri, EMPTY);
		return [];
	}
	const readings = new Map<string, Reading | null>();
	for (const script of new Set(built.units.map((u) => u.script))) {
		const reading = await readingOf(script);
		if (!reading) return driftFor(uri).items;
		readings.set(script, reading);
	}
	// A procedure not where it was may have moved rather than gone.
	const moved: Record<string, string> = {};
	for (const unit of built.units) {
		if (readings.get(unit.script)?.procedures.some((p) => p.name.toLowerCase() === unit.name.toLowerCase())) continue;
		const found = (await session.workspaceSymbols(unit.name).catch(() => [])).find((s) => s.name.toLowerCase() === unit.name.toLowerCase() && (s.kind === 6 || s.kind === 12));
		if (!found) continue;
		const script = relativeTo(state.workspace.root, monaco.Uri.parse(found.location.uri).fsPath).replace(/\\/g, "/");
		if (script === unit.script || script.startsWith(".ssl-studio")) continue;
		const reading = readings.get(script) ?? (await readingOf(script));
		if (!reading) continue;
		readings.set(script, reading);
		moved[unit.name] = script;
	}
	const items = driftOf(plan, readings, moved);
	setDrifts(uri, { items, moved, checked: true });
	return items;
}

/** Follows a link from the chart to the code. */
export async function openProcedure(uri: string | undefined, unit: BuiltUnit) {
	if (!state.workspace) return;
	const script = driftFor(uri).moved[unit.name] ?? unit.script;
	const line = (await readingOf(script))?.procedures.find((p) => p.name.toLowerCase() === unit.name.toLowerCase())?.line;
	if (!line) return notify(`${unit.name} is not in ${script} now.`);
	await openFile(joinPath(state.workspace.root, script), { reveal: { line } });
}

export type ResolvedRef = { name: string; script: string; line: number; endLine: number };
export type ProcedurePreview = { name: string; script: string; line: number; endLine: number; code: string };

/** Opens a workspace-relative script path, optionally revealing a 1-based line. */
export async function openScript(script: string, line?: number) {
	if (!state.workspace || !script.trim()) return;
	await openFile(joinPath(state.workspace.root, script.trim()), line ? { reveal: { line } } : undefined);
}

const withTimeout = <T,>(promise: Promise<T>, ms: number, fallback: T): Promise<T> =>
	new Promise((resolve) => {
		const timer = setTimeout(() => resolve(fallback), ms);
		promise.then(
			(val) => {
				clearTimeout(timer);
				resolve(val);
			},
			() => {
				clearTimeout(timer);
				resolve(fallback);
			},
		);
	});

/** Resolves a procedure, script, or data-source reference (e.g. DueDates.DueRules.RuleFor) via starlims-lsp. */
export async function resolveReference(ref: string): Promise<ResolvedRef | null> {
	if (!state.workspace || !ref.trim()) return null;
	const parts = ref.trim().split(".").filter(Boolean);
	const shortName = parts.at(-1)!;
	const qualifiers = parts.slice(0, -1).map((p) => p.toLowerCase());
	const symbols = await withTimeout(session.workspaceSymbols(shortName).catch(() => []), 4000, []);
	const matches = symbols
		.filter((s) => s.name.toLowerCase() === shortName.toLowerCase())
		.map((s) => {
			const rel = relativeTo(state.workspace!.root, monaco.Uri.parse(s.location.uri).fsPath).replace(/\\/g, "/");
			const lower = rel.toLowerCase();
			const isProc = s.kind === 6 || s.kind === 12 ? 10 : 0;
			const qualScore = qualifiers.reduce((acc, q) => acc + (lower.includes(q) ? 5 : 0), 0);
			return { s, rel, score: isProc + qualScore };
		})
		.filter((m) => !m.rel.startsWith(".ssl-studio"))
		.sort((a, b) => b.score - a.score);
	const best = matches[0];
	if (best) {
		return {
			name: best.s.name,
			script: best.rel,
			line: best.s.location.range.start.line + 1,
			endLine: best.s.location.range.end.line + 1,
		};
	}
	// Dotted script, data source, or qualified procedure path (e.g. DueDates.Holidays, DueDates.SaveDueDates, DueDates.DueRules.RuleFor).
	if (parts.length >= 2) {
		const files = await backend.files().catch(() => [] as string[]);
		const candidates = [parts.join("/"), ...(parts.length >= 3 ? [parts.slice(0, -1).join("/")] : [])];
		for (const base of candidates) {
			const lowerBase = base.toLowerCase();
			const targetFile = files.find((f) => {
				const norm = f.replace(/\\/g, "/").toLowerCase();
				return (
					norm.endsWith(`/${lowerBase}.ssl`) ||
					norm === `${lowerBase}.ssl` ||
					norm.endsWith(`/${lowerBase}.srvscr`) ||
					norm === `${lowerBase}.srvscr` ||
					norm.endsWith(`/${lowerBase}.ds`) ||
					norm === `${lowerBase}.ds`
				);
			});
			if (targetFile) {
				return { name: shortName, script: relativeTo(state.workspace.root, targetFile).replace(/\\/g, "/"), line: 1, endLine: 40 };
			}
		}
	}
	return null;
}

/** Resolves and opens a procedure or script reference in the editor. */
export async function openReference(ref: string) {
	const found = await resolveReference(ref);
	if (!found) return notify(`Could not locate ${ref} in this workspace.`);
	await openScript(found.script, found.line);
}

async function readWorkspaceText(script: string): Promise<string | null> {
	if (!state.workspace) return null;
	const full = joinPath(state.workspace.root, script);
	const open = documents.get(full)?.model.getValue();
	if (open !== undefined) return open;
	return backend.read(full).then(
		(f) => f.text,
		() => null,
	);
}

async function findSpanInScript(
	text: string,
	shortName: string,
	isScriptEntry: boolean,
): Promise<{ name: string; startLine: number; endLine: number; code: string } | null> {
	const lines = text.split(/\r?\n/);
	const nodes = await withTimeout(session.scratchTree(text).catch(() => []), 4000, []);
	const procSpan = procedureBodySpan(nodes, shortName);
	if (procSpan) {
		return {
			name: procSpan.name,
			startLine: procSpan.startLine,
			endLine: procSpan.endLine,
			code: lines.slice(procSpan.startLine, procSpan.endLine + 1).join("\n").trimEnd(),
		};
	}
	if (isScriptEntry) {
		const entry = scriptEntrySpan(nodes);
		if (entry) {
			return {
				name: shortName,
				startLine: entry.startLine,
				endLine: entry.endLine,
				code: lines.slice(entry.startLine, entry.endLine + 1).join("\n").trimEnd(),
			};
		}
	}
	// Fallback to standard LSP documentSymbol ranges (still 100% from starlims-lsp, ADR 0003).
	const symbols = await withTimeout(session.scratchSymbols(text).catch(() => []), 4000, []);
	if (symbols.length) {
		const flat: monaco.languages.DocumentSymbol[] = [];
		const walk = (list: monaco.languages.DocumentSymbol[]) => {
			for (const s of list) {
				flat.push(s);
				if (s.children?.length) walk(s.children);
			}
		};
		walk(symbols);
		const sym = flat.find((s) => s.name.toLowerCase() === shortName.toLowerCase());
		if (sym) {
			const startLine = Math.max(0, sym.range.startLineNumber - 1);
			const endLine = Math.min(lines.length - 1, Math.max(startLine, sym.range.endLineNumber - 1));
			return { name: sym.name, startLine, endLine, code: lines.slice(startLine, endLine + 1).join("\n").trimEnd() };
		}
	}
	return null;
}

/**
 * Loads a read-only SSL preview of a specific procedure or script entry section
 * using starlims-lsp's syntax tree / document symbols (ADR 0003: no SSL parsing in the IDE).
 * Never falls back to arbitrary top-of-file header lines when a specific function cannot be located.
 */
export async function readProcedurePreview(
	uri: string | undefined,
	target: { name: string; script?: string; hintScript?: string },
): Promise<ProcedurePreview | null> {
	if (!state.workspace || !target.name.trim()) return null;
	const shortName = lastPart(target.name.trim());
	let script = target.script ? (driftFor(uri).moved[target.name] ?? target.script) : undefined;

	// For unqualified local calls (e.g. PlanDueDate inside the same script), check hintScript first.
	if (!script && target.hintScript && !target.name.includes(".")) {
		const hintText = await readWorkspaceText(target.hintScript);
		if (hintText !== null) {
			const hit = await findSpanInScript(hintText, shortName, false);
			if (hit) return { name: hit.name, script: target.hintScript, line: hit.startLine + 1, endLine: hit.endLine + 1, code: hit.code };
		}
	}

	if (!script) {
		const resolved = await resolveReference(target.name);
		if (!resolved) return null;
		script = resolved.script;
	}
	const text = await readWorkspaceText(script);
	if (text === null) return null;

	const stem = baseName(script).replace(/\.(ssl|srvscr|ds)$/i, "").toLowerCase();
	const isScriptEntry = stem === shortName.toLowerCase();
	const hit = await findSpanInScript(text, shortName, isScriptEntry);
	if (hit) return { name: hit.name, script, line: hit.startLine + 1, endLine: hit.endLine + 1, code: hit.code };

	return null;
}
