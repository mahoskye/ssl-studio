// Reads what the chart is compared with: each built script's procedures and calls, from the
// server. Run by the plan's check, with no agent and no cost. What it finds is a report only:
// the code may well be right (ADR 0005).
import { createStore } from "solid-js";
import { backend } from "../backend";
import { monaco } from "../editor/monaco";
import { flatRegions } from "../editor/regions";
import { session } from "../lsp/session";
import { canonical, documents, notify, openFile, state } from "../state";
import { baseName, joinPath, relativeTo } from "../../shared/paths";
import { manualPlanDrift, planTargetsOf, stageRegionDrift } from "./assist";
import { lastPart, procedureBodySpan, scriptEntrySpan } from "./build";
import { builtOf, driftOf, type BuiltUnit, type Drift, type Reading } from "./built";
import type { Plan } from "./model";

export { manualPlanDrift, stageRegionDrift };

export type DriftState = { items: Drift[]; moved: Record<string, string>; checked: boolean };

const EMPTY: DriftState = { items: [], moved: {}, checked: false };
const [drifts, setDrifts] = createStore<Record<string, DriftState>>({});
const driftSeq = new Map<string, number>();

const bumpDriftSeq = (uri: string) => {
	const next = (driftSeq.get(uri) ?? 0) + 1;
	driftSeq.set(uri, next);
	return next;
};
const isDriftCurrent = (uri: string, seq: number, root: string) =>
	driftSeq.get(uri) === seq && state.workspace?.root === root;

/** Keyed by the plan's URI, as findings are. */
export const driftFor = (uri: string | undefined): DriftState => (uri && drifts[uri]) || EMPTY;
const setDrift = (uri: string, next: DriftState) => {
	setDrifts((s) => {
		s[uri] = next;
	});
};

export const clearDrift = (uri: string) => {
	bumpDriftSeq(uri);
	setDrift(uri, EMPTY);
};

export const scriptUri = (script: string, root = state.workspace?.root) =>
	root ? monaco.Uri.file(joinPath(root, script)).toString() : "";

/** Null when the server cannot say yet: nothing is reported rather than everything. */
export async function readingOf(script: string, root = state.workspace?.root): Promise<Reading | null> {
	if (!root) return null;
	return session.scriptCalls(scriptUri(script, root)).catch(() => null);
}

/** Reads `/* region <Stage>;` names for an SSL script via starlims-lsp DocumentSymbols (ADR 0003). */
async function readScriptRegions(script: string, root: string): Promise<string[] | null> {
	if (state.workspace?.root !== root || !/\.(ssl|srvscr)$/i.test(script)) return null;
	const full = joinPath(root, script);
	const openModel = (documents.get(canonical(full)) ?? documents.get(full))?.model;
	if (openModel) {
		const syms = await withTimeout(session.documentSymbols(openModel).catch(() => null), 4000, null);
		return state.workspace?.root === root && syms ? flatRegions(syms).map((r) => r.symbol.name) : null;
	}
	const text = await readWorkspaceText(script, root);
	if (text === null || state.workspace?.root !== root) return null;
	const syms = await withTimeout(session.scratchSymbols(text).catch(() => null), 4000, null);
	return state.workspace?.root === root && syms ? flatRegions(syms).map((r) => r.symbol.name) : null;
}

async function collectTargetRegions(scripts: readonly string[], root: string): Promise<{ regions: Set<string>; checked: string[] }> {
	const regions = new Set<string>();
	const checked: string[] = [];
	for (const script of new Set(scripts)) {
		if (state.workspace?.root !== root) break;
		const found = await readScriptRegions(script, root);
		if (state.workspace?.root !== root) break;
		if (found === null) continue;
		checked.push(script);
		for (const name of found) regions.add(name);
	}
	return { regions, checked };
}

export async function readDrift(uri: string, plan: Plan): Promise<Drift[]> {
	const root = state.workspace?.root;
	const seq = bumpDriftSeq(uri);
	if (!root) {
		setDrift(uri, EMPTY);
		return [];
	}
	const built = builtOf(plan);
	const targets = planTargetsOf(plan);

	// Lightweight ref/target and stage-region drift check for manually authored plans (no `built.units`).
	if (!built?.units.length) {
		const sslTargets = targets.filter((t) => /\.(ssl|srvscr)$/i.test(t));
		if (!sslTargets.length) {
			if (isDriftCurrent(uri, seq, root)) setDrift(uri, { items: [], moved: {}, checked: true });
			return [];
		}
		const existingTargets: string[] = [];
		for (const script of sslTargets) {
			const text = await readWorkspaceText(script, root);
			if (!isDriftCurrent(uri, seq, root)) return [];
			if (text !== null) existingTargets.push(script);
		}
		if (!existingTargets.length) {
			setDrift(uri, { items: [], moved: {}, checked: true });
			return [];
		}
		const readings = new Map<string, Reading | null>();
		if (session.supports("ssl/callGraph")) {
			for (const script of existingTargets) {
				const reading = await readingOf(script, root);
				if (!isDriftCurrent(uri, seq, root)) return [];
				// Script exists on disk/editor, so a null reading means the LSP is still indexing.
				if (!reading) return driftFor(uri).items;
				readings.set(script, reading);
			}
		}
		const regionInfo = plan.groups.length ? await collectTargetRegions(existingTargets, root) : { regions: new Set<string>(), checked: [] };
		if (!isDriftCurrent(uri, seq, root)) return [];
		const items = manualPlanDrift(
			plan,
			readings,
			regionInfo.checked.length ? regionInfo.regions : undefined,
			regionInfo.checked.length ? regionInfo.checked : existingTargets,
		);
		setDrift(uri, { items, moved: {}, checked: true });
		return items;
	}

	const readings = new Map<string, Reading | null>();
	const supportsCallGraph = session.supports("ssl/callGraph");
	for (const script of new Set(built.units.map((u) => u.script))) {
		const text = await readWorkspaceText(script, root);
		if (!isDriftCurrent(uri, seq, root)) return [];
		// Missing / deleted script: record null reading so driftOf reports "gone" + checked: true (no infinite polling).
		if (text === null) {
			readings.set(script, null);
			continue;
		}
		if (!supportsCallGraph) continue;
		const reading = await readingOf(script, root);
		if (!isDriftCurrent(uri, seq, root)) return [];
		// Script exists, so a null reading means the LSP is still indexing.
		if (!reading) return driftFor(uri).items;
		readings.set(script, reading);
	}
	// If the server doesn't support call graphs and all built scripts still exist on disk, only check stage regions.
	if (!supportsCallGraph && readings.size === 0) {
		const items: Drift[] = [];
		if (plan.groups.length) {
			const regionScripts = [...new Set([...targets, ...built.units.map((u) => u.script)])];
			const regionInfo = await collectTargetRegions(regionScripts, root);
			if (!isDriftCurrent(uri, seq, root)) return [];
			if (regionInfo.checked.length) items.push(...stageRegionDrift(plan, regionInfo.regions, regionInfo.checked));
		}
		setDrift(uri, { items, moved: {}, checked: true });
		return items;
	}
	// A procedure not where it was may have moved rather than gone.
	const moved: Record<string, string> = {};
	for (const unit of built.units) {
		if (!supportsCallGraph && !readings.has(unit.script)) continue;
		if (readings.get(unit.script)?.procedures.some((p) => p.name.toLowerCase() === unit.name.toLowerCase())) continue;
		const symbols = await session.workspaceSymbols(unit.name).catch(() => []);
		if (!isDriftCurrent(uri, seq, root)) return [];
		const found = symbols.find((s) => s.name.toLowerCase() === unit.name.toLowerCase() && (s.kind === 6 || s.kind === 12));
		if (!found) continue;
		const script = relativeTo(root, monaco.Uri.parse(found.location.uri).fsPath).replace(/\\/g, "/");
		if (script === unit.script || script.startsWith(".ssl-studio")) continue;
		const reading = readings.get(script) ?? (await readingOf(script, root));
		if (!isDriftCurrent(uri, seq, root)) return [];
		if (!reading) continue;
		readings.set(script, reading);
		moved[unit.name] = script;
	}
	const items = driftOf(plan, readings, moved);
	if (plan.groups.length) {
		const regionScripts = [...new Set([...targets, ...built.units.map((u) => moved[u.name] ?? u.script)])];
		const regionInfo = await collectTargetRegions(regionScripts, root);
		if (!isDriftCurrent(uri, seq, root)) return [];
		if (regionInfo.checked.length) {
			items.push(...stageRegionDrift(plan, regionInfo.regions, regionInfo.checked));
		}
	}
	setDrift(uri, { items, moved, checked: true });
	return items;
}

/** Follows a link from the chart to the code. */
export async function openProcedure(uri: string | undefined, unit: BuiltUnit) {
	const root = state.workspace?.root;
	if (!root) return;
	const script = driftFor(uri).moved[unit.name] ?? unit.script;
	const line = (await readingOf(script, root))?.procedures.find((p) => p.name.toLowerCase() === unit.name.toLowerCase())?.line;
	if (state.workspace?.root !== root) return;
	if (!line) return notify(`${unit.name} is not in ${script} now.`);
	await openFile(joinPath(root, script), { reveal: { line } });
}

export type ResolvedRef = { name: string; script: string; line: number; endLine: number };
export type ProcedurePreview = { name: string; script: string; line: number; endLine: number; code: string };

/** Opens a workspace-relative script path, optionally revealing a 1-based line. */
export async function openScript(script: string, line?: number) {
	const root = state.workspace?.root;
	if (!root || !script.trim()) return;
	await openFile(joinPath(root, script.trim()), line ? { reveal: { line } } : undefined);
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

/** Resolves a procedure, script, or data-source reference (e.g. DueDates.DueRules.RuleFor or src/DueDates/Holidays.ds) via starlims-lsp. */
export async function resolveReference(ref: string): Promise<ResolvedRef | null> {
	const root = state.workspace?.root;
	const raw = ref.trim();
	if (!root || !raw) return null;

	// Explicit relative path or file extension (e.g. src/DueDates/Holidays.ds, Sample/Release.ssl).
	if (raw.includes("/") || raw.includes("\\") || /\.(ssl|srvscr|ds)$/i.test(raw)) {
		const files = await backend.files().catch(() => [] as string[]);
		if (state.workspace?.root !== root) return null;
		const clean = raw.replace(/\\/g, "/").replace(/^\.?\/+/, "").toLowerCase();
		const targetFile = files.find((f) => {
			const rel = relativeTo(root, f).replace(/\\/g, "/").toLowerCase();
			if (rel.startsWith(".ssl-studio/") || rel.includes("/.ssl-studio/")) return false;
			const norm = f.replace(/\\/g, "/").toLowerCase();
			return rel === clean || norm === clean || rel.endsWith(`/${clean}`) || norm.endsWith(`/${clean}`);
		});
		if (targetFile) {
			const rel = relativeTo(root, targetFile).replace(/\\/g, "/");
			return { name: baseName(targetFile).replace(/\.(ssl|srvscr|ds)$/i, ""), script: rel, line: 1, endLine: 40 };
		}
	}

	const stripped = raw.replace(/\.(ssl|srvscr|ds)$/i, "");
	const parts = stripped.split(/[./\\]/).filter(Boolean);
	if (!parts.length) return null;
	const shortName = parts.at(-1)!;
	const qualifiers = parts.slice(0, -1).map((p) => p.toLowerCase());
	const qualPath = qualifiers.join("/");
	const symbols = await withTimeout(session.workspaceSymbols(shortName).catch(() => []), 4000, []);
	if (state.workspace?.root !== root) return null;
	const matches = symbols
		.filter((s) => s.name.toLowerCase() === shortName.toLowerCase())
		.map((s) => {
			const rel = relativeTo(root, monaco.Uri.parse(s.location.uri).fsPath).replace(/\\/g, "/");
			const lower = rel.toLowerCase();
			const noExt = lower.replace(/\.(ssl|srvscr|ds)$/i, "");
			const container = (s.containerName ?? "").trim().replace(/\\/g, "/").replace(/\./g, "/").toLowerCase();
			const exactQual =
				qualifiers.length === 0 ||
				noExt === qualPath ||
				noExt.endsWith(`/${qualPath}`) ||
				(Boolean(container) && (container === qualPath || container.endsWith(`/${qualPath}`)));
			const isProc = s.kind === 6 || s.kind === 12 ? 10 : 0;
			const qualScore = qualifiers.reduce((acc, q) => acc + (lower.includes(q) ? 5 : 0), 0);
			return { s, rel, exactQual, score: isProc + qualScore };
		})
		.filter((m) => !m.rel.startsWith(".ssl-studio") && m.exactQual)
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
	const files = await backend.files().catch(() => [] as string[]);
	if (state.workspace?.root !== root) return null;
	const candidates = [parts.join("/"), stripped, ...(parts.length >= 3 ? [parts.slice(0, -1).join("/")] : [])];
	for (const base of candidates) {
		const lowerBase = base.replace(/\\/g, "/").toLowerCase();
		const targetFile = files.find((f) => {
			const rel = relativeTo(root, f).replace(/\\/g, "/").toLowerCase();
			if (rel.startsWith(".ssl-studio/") || rel.includes("/.ssl-studio/")) return false;
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
			return { name: shortName, script: relativeTo(root, targetFile).replace(/\\/g, "/"), line: 1, endLine: 40 };
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

async function readWorkspaceText(script: string, root = state.workspace?.root): Promise<string | null> {
	if (!root) return null;
	const full = joinPath(root, script);
	const open = (documents.get(canonical(full)) ?? documents.get(full))?.model.getValue();
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
		const wanted = shortName.toLowerCase();
		const matching = flat.filter((s) => s.name.toLowerCase() === wanted);
		const sym =
			matching.find(
				(s) =>
					s.kind === monaco.languages.SymbolKind.Function ||
					s.kind === monaco.languages.SymbolKind.Method,
			) ?? matching[0];
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
	const root = state.workspace?.root;
	const rawName = target.name.trim();
	if (!root || !rawName) return null;
	const strippedName = rawName.replace(/\.(ssl|srvscr|ds)$/i, "");
	const shortName = strippedName.split(/[./\\]/).filter(Boolean).at(-1) ?? lastPart(rawName);
	let script = target.script ? (driftFor(uri).moved[target.name] ?? target.script) : undefined;

	// For unqualified local calls (e.g. PlanDueDate inside the same script), check hintScript first.
	if (!script && target.hintScript && !rawName.includes(".") && !rawName.includes("/") && !rawName.includes("\\")) {
		const hintText = await readWorkspaceText(target.hintScript, root);
		if (state.workspace?.root !== root) return null;
		if (hintText !== null) {
			const hit = await findSpanInScript(hintText, shortName, false);
			if (state.workspace?.root !== root) return null;
			if (hit) return { name: hit.name, script: target.hintScript, line: hit.startLine + 1, endLine: hit.endLine + 1, code: hit.code };
		}
	}

	if (!script) {
		const resolved = await resolveReference(rawName);
		if (state.workspace?.root !== root || !resolved) return null;
		script = resolved.script;
	}
	const text = await readWorkspaceText(script, root);
	if (state.workspace?.root !== root || text === null) return null;

	// Data-source `.ds` files hold SQL/query definitions directly (not SSL `:PROCEDURE` blocks).
	if (/\.ds$/i.test(script)) {
		const lines = text.split(/\r?\n/);
		const previewLines = lines.slice(0, 60);
		while (previewLines.length > 1 && !previewLines.at(-1)!.trim()) previewLines.pop();
		return {
			name: baseName(script).replace(/\.ds$/i, ""),
			script,
			line: 1,
			endLine: Math.max(1, previewLines.length),
			code: previewLines.join("\n").trimEnd(),
		};
	}

	const stem = baseName(script).replace(/\.(ssl|srvscr|ds)$/i, "").toLowerCase();
	const isScriptEntry = stem === shortName.toLowerCase();
	const hit = await findSpanInScript(text, shortName, isScriptEntry);
	if (state.workspace?.root !== root) return null;
	if (hit) return { name: hit.name, script, line: hit.startLine + 1, endLine: hit.endLine + 1, code: hit.code };

	return null;
}
