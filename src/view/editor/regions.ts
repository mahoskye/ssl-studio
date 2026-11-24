// Region colours: kept in workspace settings by region name, never in the
// code (VISION). The palette stays readable on light and dark backgrounds.
import { monaco } from "./monaco";
import { saveSetting, state } from "../state";

export const REGION_PALETTE = ["#9d7cd8", "#5b8def", "#2aa198", "#d4a017", "#e07a4f", "#d16d9e", "#6a9f4b", "#3fa7c4"];

const hash = (s: string) => [...s].reduce((h, c) => (h * 31 + c.charCodeAt(0)) >>> 0, 7);

export const regionColor = (name: string) =>
	(Object.hasOwn(state.settings.regionColors, name) ? state.settings.regionColors[name] : undefined) ??
	REGION_PALETTE[hash(name) % REGION_PALETTE.length]!;

/** The region's colour moves one step through the palette: forwards, or back to the one before. */
export function cycleRegionColor(name: string, step: 1 | -1 = 1) {
	const size = REGION_PALETTE.length;
	const next = REGION_PALETTE[(REGION_PALETTE.indexOf(regionColor(name)) + step + size) % size]!;
	void saveSetting({ regionColors: { ...state.settings.regionColors, [name]: next } }, state.workspace ? "workspace" : "user");
}

/** Comment regions come back from the server as Namespace symbols. */
export const isRegion = (s: monaco.languages.DocumentSymbol) => s.kind === monaco.languages.SymbolKind.Namespace;

export function flatRegions(list: monaco.languages.DocumentSymbol[], depth = 0): { symbol: monaco.languages.DocumentSymbol; depth: number }[] {
	return list.flatMap((s) => (isRegion(s) ? [{ symbol: s, depth }, ...flatRegions(s.children ?? [], depth + 1)] : flatRegions(s.children ?? [], depth)));
}

/** The chain of symbols around a line, outermost first. */
export function symbolPath(list: monaco.languages.DocumentSymbol[], line: number): monaco.languages.DocumentSymbol[] {
	for (const s of list) {
		if (s.range.startLineNumber <= line && line <= s.range.endLineNumber) return [s, ...symbolPath(s.children ?? [], line)];
	}
	return [];
}
