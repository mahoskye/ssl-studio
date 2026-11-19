import type { Table } from "./csv";

// A registry's rows against the project's files: is the thing a row names
// anywhere outside the documents? A setting nothing reads, a table no script
// names. It is a search for the name as a whole word, in any kind of file: it
// reads no SSL, and says only whether the name appears (ADR 0003).

/** A name shorter than this is not looked for: it would be found everywhere. */
export const NAME_MIN = 3;
/** As many names as are looked for in one go. */
export const NAMES_CHECKED = 300;

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

/** Whether a table is one whose first column names things to look for: not a list of files, which is checked by its checksums. */
export const checksNames = (table: Table) => table.header.length > 0 && table.rows.length > 0 && !/^(path|file)$/i.test(table.header[0]!.text.trim());

/** What a check came to, in a sentence. */
export function usesSummary(uses: ReadonlyMap<string, number>): string {
	const missing = [...uses.values()].filter((count) => count === 0).length;
	if (!uses.size) return "No names to look for.";
	if (!missing) return `All ${uses.size} are named outside the documents.`;
	return `${missing} of ${uses.size} ${missing === 1 ? "is" : "are"} named nowhere outside the documents.`;
}
