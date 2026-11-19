// A file manifest is a registry of the project's own files: each with its
// size, its lines and a checksum, and a status a person sets as the file is
// carried across. Writing it again from the folder keeps what the person
// wrote (the status, a note, any column of their own) and says what is new,
// what has changed and what has gone.
import { columnOf, csvRow, parseCsv } from "./csv";
import type { ManifestFile } from "./protocol";

/** The columns the IDE fills, and the one a person does. */
export const MANIFEST_COLUMNS = ["path", "kind", "bytes", "lines", "sha256", "status", "note"] as const;
/** A file seen for the first time, and one that is no longer there. */
export const FOUND = "found";
export const GONE = "gone";

export type ManifestChange = { text: string; added: number; changed: number; gone: number; same: number };

export function mergeManifest(existing: string | null | undefined, files: readonly ManifestFile[]): ManifestChange {
	const table = parseCsv(existing ?? "");
	const delimiter = table.delimiter;
	const header = table.header.map((c) => c.text.trim());
	if (!header.length) header.push(...MANIFEST_COLUMNS);
	for (const column of ["path", "kind", "bytes", "lines", "sha256", "status"]) if (!header.some((name) => name.toLowerCase() === column)) header.push(column);
	const at = (name: string) => columnOf({ header: header.map((text) => ({ text, start: 0, end: 0 })) }, name);
	const [path, kind, bytes, lines, sha, status] = ["path", "kind", "bytes", "lines", "sha256", "status"].map(at) as [number, number, number, number, number, number];
	const now = new Map(files.map((file) => [file.path, file]));
	// A file renamed only in the case of its letters is the same file where the file system says so: it keeps its row.
	const byLower = new Map<string, ManifestFile>();
	for (const file of files) if (!byLower.has(file.path.toLowerCase())) byLower.set(file.path.toLowerCase(), file);
	const listed = new Set(table.rows.map((cells) => (cells[path]?.text ?? "").trim()));
	const eol = (existing ?? "").includes("\r\n") ? "\r\n" : "\n";
	const seen = new Set<string>();
	const counts = { added: 0, changed: 0, gone: 0, same: 0 };
	const out: string[][] = [];
	for (const cells of table.rows) {
		// A row with more cells than there are columns keeps them: what a person wrote is not dropped for being out of place.
		const row = [...header.map((_, i) => cells[i]?.text ?? ""), ...cells.slice(header.length).map((cell) => cell.text)];
		const name = row[path]!.trim();
		const renamed = now.has(name) ? undefined : byLower.get(name.toLowerCase());
		// One row to a file: where two rows differ only in case, the first takes the renamed file and the other has gone.
		const file = now.get(name) ?? (renamed && !listed.has(renamed.path) && !seen.has(renamed.path) ? renamed : undefined);
		if (file && file.path !== name) row[path] = file.path;
		seen.add(file?.path ?? name);
		if (!file) {
			if (row[status]!.trim().toLowerCase() !== GONE) counts.gone++;
			row[status] = GONE;
		} else {
			if (row[sha]!.trim() && row[sha]!.trim() !== file.sha256) counts.changed++;
			else counts.same++;
			// A file that had gone and is back is found again; any other status is the person's.
			if (row[status]!.trim().toLowerCase() === GONE || !row[status]!.trim()) row[status] = FOUND;
			[row[kind], row[bytes], row[lines], row[sha]] = [file.kind, String(file.bytes), String(file.lines), file.sha256];
		}
		out.push(row);
	}
	for (const file of files) {
		if (seen.has(file.path)) continue;
		const row = header.map(() => "");
		[row[path], row[kind], row[bytes], row[lines], row[sha], row[status]] = [file.path, file.kind, String(file.bytes), String(file.lines), file.sha256, FOUND];
		out.push(row);
		counts.added++;
	}
	return { text: `${[header, ...out].map((row) => csvRow(row, delimiter)).join(eol)}${eol}`, ...counts };
}

/** What a manifest's update came to, in a sentence. */
export function manifestSummary(change: ManifestChange): string {
	const parts = [change.added && `${change.added} new`, change.changed && `${change.changed} changed`, change.gone && `${change.gone} gone`].filter(Boolean);
	const total = change.added + change.changed + change.same;
	return parts.length ? `File manifest: ${total} ${total === 1 ? "file" : "files"}; ${parts.join(", ")}.` : `File manifest: ${total} ${total === 1 ? "file" : "files"}, none changed.`;
}
