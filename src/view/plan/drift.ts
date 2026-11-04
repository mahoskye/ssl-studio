// Reads what the chart is compared with: each built script's procedures and calls, from the
// server. Run by the plan's check, with no agent and no cost. What it finds is a report only:
// the code may well be right (ADR 0005).
import { createStore } from "solid-js/store";
import { monaco } from "../editor/monaco";
import { session } from "../lsp/session";
import { notify, openFile, state } from "../state";
import { joinPath, relativeTo } from "../../shared/paths";
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
