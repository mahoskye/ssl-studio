// A file manifest is a registry of the project's own files: each with its
// size, its lines and a checksum, and a status a person sets as the file is
// carried across. Writing it again from the folder keeps what the person
// wrote (the status, a note, any column of their own) and says what is new,
// what has changed and what has gone.
import { columnOf, csvRow, parseCsv } from "./csv";
import { toneOf } from "./projectDocs";
import type { ManifestFile } from "./protocol";

/** The columns the IDE fills, and the one a person does. */
export const MANIFEST_COLUMNS = ["path", "kind", "bytes", "lines", "sha256", "status", "note"] as const;
/** A file seen for the first time, one that changed after verification, and one that is no longer there. */
export const FOUND = "found";
export const CHANGED = "changed";
export const GONE = "gone";

export type ManifestChange = { text: string; added: number; changed: number; gone: number; same: number; changedAfterDone: string[] };

export function mergeManifest(
	existing: string | null | undefined,
	files: readonly ManifestFile[],
	options?: { markChangedAfterDone?: boolean },
): ManifestChange {
	const table = parseCsv(existing ?? "");
	const delimiter = table.delimiter;
	const header = table.header.map((c) => c.text.trim());
	const origHeaderLen = header.length;
	if (!header.length) header.push(...MANIFEST_COLUMNS);
	for (const column of ["path", "kind", "bytes", "lines", "sha256", "status"]) if (!header.some((name) => name.toLowerCase() === column)) header.push(column);
	const at = (name: string) => columnOf({ header: header.map((text) => ({ text, start: 0, end: 0 })) }, name);
	const [path, kind, bytes, lines, sha, status] = ["path", "kind", "bytes", "lines", "sha256", "status"].map(at) as [number, number, number, number, number, number];
	const normPath = (p: string) => p.replace(/\\/g, "/");
	const now = new Map(files.map((file) => [normPath(file.path), file]));
	// A file renamed only in the case of its letters is the same file where the file system says so: it keeps its row.
	const byLower = new Map<string, ManifestFile>();
	for (const file of files) {
		const lower = normPath(file.path).toLowerCase();
		if (!byLower.has(lower)) byLower.set(lower, file);
	}
	const listed = new Set(table.rows.map((cells) => normPath((cells[path]?.text ?? "").trim())).filter(Boolean));
	const eol = (existing ?? "").includes("\r\n") ? "\r\n" : "\n";
	const seen = new Set<string>();
	const counts = { added: 0, changed: 0, gone: 0, same: 0 };
	const changedAfterDone: string[] = [];
	const out: string[][] = [];
	for (const cells of table.rows) {
		// Map only cells belonging to the original columns into `header`, preserving ragged extra cells after newly added columns.
		const row = [
			...header.map((_, i) => (i < origHeaderLen ? (cells[i]?.text ?? "") : "")),
			...cells.slice(origHeaderLen).map((cell) => cell.text),
		];
		const rawName = row[path]!.trim();
		if (!rawName) {
			out.push(row);
			continue;
		}
		const normName = normPath(rawName);
		const exact = now.get(normName);
		const renamed = exact ? undefined : byLower.get(normName.toLowerCase());
		// One row to a file: duplicate rows (exact or differing only in case/slashes) must not both claim the same file.
		const candidate = exact ?? (renamed && !listed.has(normPath(renamed.path)) ? renamed : undefined);
		const candidateKey = candidate ? normPath(candidate.path) : undefined;
		const file = candidate && candidateKey && !seen.has(candidateKey) ? candidate : undefined;
		if (file && file.path !== rawName) row[path] = file.path;
		seen.add(file ? normPath(file.path) : normName);
		if (!file) {
			if (row[status]!.trim().toLowerCase() !== GONE) counts.gone++;
			row[status] = GONE;
		} else {
			const shaChanged = Boolean(row[sha]!.trim() && row[sha]!.trim() !== file.sha256);
			if (shaChanged) {
				counts.changed++;
				if (toneOf(row[status]!) === "done") {
					changedAfterDone.push(file.path);
					if (options?.markChangedAfterDone) row[status] = CHANGED;
				}
			} else counts.same++;
			// A file that had gone and is back is found again; any other status is the person's.
			if (row[status]!.trim().toLowerCase() === GONE || !row[status]!.trim()) row[status] = FOUND;
			[row[kind], row[bytes], row[lines], row[sha]] = [file.kind, String(file.bytes), String(file.lines), file.sha256];
		}
		out.push(row);
	}
	for (const file of files) {
		if (seen.has(normPath(file.path))) continue;
		const row = header.map(() => "");
		[row[path], row[kind], row[bytes], row[lines], row[sha], row[status]] = [file.path, file.kind, String(file.bytes), String(file.lines), file.sha256, FOUND];
		out.push(row);
		counts.added++;
	}
	return { text: `${[header, ...out].map((row) => csvRow(row, delimiter)).join(eol)}${eol}`, ...counts, changedAfterDone };
}

/** What a manifest's update came to, in a sentence. */
export function manifestSummary(change: ManifestChange): string {
	const parts = [change.added && `${change.added} new`, change.changed && `${change.changed} changed`, change.gone && `${change.gone} gone`].filter(Boolean);
	const total = change.added + change.changed + change.same;
	return parts.length ? `File manifest: ${total} ${total === 1 ? "file" : "files"}; ${parts.join(", ")}.` : `File manifest: ${total} ${total === 1 ? "file" : "files"}, none changed.`;
}
