import type { Cell, Table } from "./csv";
import type { SearchOptions } from "./searchPattern";

// A table's values against the project's files: is the thing a cell names
// referenced in code? A setting nothing reads, a table no script names. It is
// a targeted text search (by chosen column, row scope, file scope and match
// rules): it reads no SSL of its own (ADR 0003).

/** A name shorter than this is not looked for by the legacy whole-table helper: it would be found everywhere. */
export const NAME_MIN = 3;
/** Legacy batch cap kept for compatibility with existing callers/tests. */
export const NAMES_CHECKED = 300;

export type CodeFileScopeId = "code" | "ssl" | "data" | "starlims" | "custom";
export type CodeCheckRowScope = "selected" | "checked" | "filtered" | "all";

export type CodeFileScopePreset = {
	id: CodeFileScopeId;
	label: string;
	include: string;
};

export const CODE_FILE_SCOPES: readonly CodeFileScopePreset[] = [
	{ id: "code", label: "All code files (exclude docs)", include: "" },
	{ id: "ssl", label: "SSL scripts (*.ssl)", include: "*.ssl" },
	{ id: "data", label: "Data sources & SQL (*.ds, *.sql)", include: "*.ds, *.sql" },
	{ id: "starlims", label: "SSL, data sources & SQL", include: "*.ssl, *.ds, *.sql" },
	{ id: "custom", label: "Custom file patterns…", include: "" },
];

export type CodeCheckSpec = {
	column: number;
	rowScope: CodeCheckRowScope;
	fileScope: CodeFileScopeId;
	include: string;
	exclude: string;
	wholeWord: boolean;
	caseSensitive: boolean;
	splitLists: boolean;
};

/** The names a table's rows are known by: what each has in its first column, once each, in the table's order. */
export function namesOf(table: Table): string[] {
	const seen = new Set<string>();
	const names: string[] = [];
	for (const cells of table.rows) {
		const name = (cells[0]?.text ?? "").trim();
		if (name.length < NAME_MIN || seen.has(name.toLowerCase())) continue;
		seen.add(name.toLowerCase());
		names.push(name);
	}
	return names;
}

/** The search that finds a name as a whole word, whatever its case: `DUE_SOON` is not found in `DUE_SOON_AT`. */
export function nameQuery(name: string): string {
	const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	return `${/^\w/.test(name) ? "\\b" : ""}${escaped}${/\w$/.test(name) ? "\\b" : ""}`;
}

/**
 * Whether a file counts as the project's own work and not a document about
 * it: outside the docs folder (where the registry itself is), the plans
 * folder and the IDE's own. `path` and the folders are from the project's
 * root, with forward slashes.
 */
export function outsideDocuments(path: string, apart: readonly string[]): boolean {
	const lower = path.toLowerCase();
	return !apart.some((folder) => folder && folder !== "." && (lower === folder.toLowerCase() || lower.startsWith(`${folder.toLowerCase().replace(/\/+$/, "")}/`)));
}

/** Builds a comma-separated exclude glob list for `backend.search` from project doc/plan folders. */
export function defaultExcludePattern(apart: readonly string[]): string {
	const seen = new Set<string>();
	const parts: string[] = [];
	for (const raw of apart) {
		const clean = raw.replace(/\\/g, "/").replace(/^\.\//, "").replace(/^\/+|\/+$/g, "");
		if (!clean || clean === ".") continue;
		const key = clean.toLowerCase();
		if (seen.has(key)) continue;
		seen.add(key);
		parts.push(`${clean}/**`);
	}
	return parts.join(", ");
}

/** Extracts searchable terms from one cell, optionally splitting comma/semicolon-separated lists. */
export function extractCellTerms(text: string, splitLists: boolean): string[] {
	const trimmed = text.trim();
	if (!trimmed) return [];
	if (!splitLists) return [trimmed];
	return trimmed
		.split(/[,;\r\n]+/)
		.map((part) => part.trim())
		.filter(Boolean);
}

/** Normalizes a term to its lookup key according to case sensitivity. */
export const termLookupKey = (term: string, caseSensitive: boolean) => (caseSensitive ? term : term.toLowerCase());

/**
 * Collects unique searchable terms from `column` across the targeted `rows`
 * in table order, with no silent truncation cap. Terms shorter than `minLength`
 * are counted in `skippedShort` so the UI can tell the user transparently.
 */
export function columnCheckTargets(
	rows: readonly Cell[][],
	column: number,
	options: { splitLists?: boolean; caseSensitive?: boolean; minLength?: number } = {},
): { terms: string[]; skippedShort: number } {
	const splitLists = Boolean(options.splitLists);
	const caseSensitive = Boolean(options.caseSensitive);
	const minLength = options.minLength ?? 2;
	const seen = new Set<string>();
	const terms: string[] = [];
	let skippedShort = 0;
	for (const cells of rows) {
		const raw = cells[column]?.text ?? "";
		for (const term of extractCellTerms(raw, splitLists)) {
			if (term.length < minLength) {
				skippedShort++;
				continue;
			}
			const key = termLookupKey(term, caseSensitive);
			if (seen.has(key)) continue;
			seen.add(key);
			terms.push(term);
		}
	}
	return { terms, skippedShort };
}

/** Heuristic hint: true if a column contains comma/semicolon-separated short values (like a `used by` column). */
export function looksLikeListColumn(rows: readonly Cell[][], column: number): boolean {
	for (const cells of rows.slice(0, 50)) {
		const raw = (cells[column]?.text ?? "").trim();
		if (!raw || !/[,;]/.test(raw)) continue;
		const parts = raw
			.split(/[,;]+/)
			.map((p) => p.trim())
			.filter(Boolean);
		if (parts.length >= 2 && parts.every((p) => p.length <= 48 && !/\s{2,}/.test(p) && p.split(/\s+/).length <= 3)) {
			return true;
		}
	}
	return false;
}

const PREFERRED_CHECK_COLUMNS = /^(name|object|setting|key|symbol|identifier|script|procedure|function|table|datasource|data\s*source|used\s*by|code|constant)$/i;
const SKIP_DEFAULT_COLUMNS = /^(path|file|status|state|note|notes|description|comment|comments|date|created|updated|bytes|lines|sha256|ticket|tickets)$/i;

/** Picks a sensible initial column index when opening the targeted Check in code dialog from the table toolbar. */
export function defaultCheckColumn(table: Table): number {
	const names = table.header.map((h) => h.text.trim());
	const preferred = names.findIndex((n) => PREFERRED_CHECK_COLUMNS.test(n));
	if (preferred >= 0) return preferred;
	const nonSkipped = names.findIndex((n) => n && !SKIP_DEFAULT_COLUMNS.test(n));
	return nonSkipped >= 0 ? nonSkipped : 0;
}

/** Converts a targeted `CodeCheckSpec` into `SearchOptions` shared by both `backend.search` and the Search panel. */
export function codeCheckSearchOptions(
	spec: Pick<CodeCheckSpec, "fileScope" | "include" | "exclude" | "wholeWord" | "caseSensitive">,
	defaultExclude: string,
): SearchOptions {
	const preset = CODE_FILE_SCOPES.find((p) => p.id === spec.fileScope);
	const include = spec.fileScope === "custom" ? spec.include.trim() : (preset?.include ?? "");
	const exclude = spec.fileScope === "custom" ? spec.exclude.trim() : defaultExclude;
	return {
		regex: false,
		wholeWord: spec.wholeWord,
		caseSensitive: spec.caseSensitive,
		...(include ? { include } : {}),
		...(exclude ? { exclude } : {}),
	};
}

/** Whether a table is one whose first column names things to look for: not a list of files, which is checked by its checksums. */
export const checksNames = (table: Table) => table.header.length > 0 && table.rows.length > 0 && !/^(path|file)$/i.test(table.header[0]!.text.trim());

/** What a check came to, in a sentence. */
export function usesSummary(uses: ReadonlyMap<string, number>): string {
	const missing = [...uses.values()].filter((count) => count === 0).length;
	if (!uses.size) return "No names to look for.";
	if (!missing) return `All ${uses.size} are named outside the documents.`;
	return `${missing} of ${uses.size} ${missing === 1 ? "is" : "are"} named nowhere outside the documents.`;
}

/** Summary sentence for a targeted column code check. */
export function codeCheckSummary(columnName: string, counts: ReadonlyMap<string, number>, cancelled = false): string {
	const col = columnName.trim() || "column";
	const total = counts.size;
	const missing = [...counts.values()].filter((n) => n === 0).length;
	const prefix = cancelled ? `Stopped checking “${col}” (${total} checked)` : `Checked “${col}”`;
	if (!total) return cancelled ? `Stopped checking “${col}” before any values finished.` : `No values to check in “${col}”.`;
	if (!missing) return `${prefix}: all ${total} found in code.`;
	return `${prefix}: ${missing} of ${total} not found in code.`;
}
