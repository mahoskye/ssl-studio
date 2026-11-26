// A file manifest is a registry of the project's own files: each with its
// size, its lines and a checksum, and a status a person sets as the file is
// carried across. Writing it again from the folder keeps what the person
// wrote (the status, a note, any column of their own) and says what is new,
// what has changed and what has gone.
import { addCsvColumn, cellChangeEdit, columnOf, csvCell, csvRow, parseCsv, type CsvTextEdit } from "./csv";
import { toneOf } from "./projectDocs";
import type { ManifestFile } from "./protocol";

/** The columns the IDE fills, and the one a person does. */
export const MANIFEST_COLUMNS = ["path", "kind", "bytes", "lines", "sha256", "status", "note"] as const;
/** A file seen for the first time, one that changed after verification, and one that is no longer there. */
export const FOUND = "found";
export const CHANGED = "changed";
export const GONE = "gone";

export type ManifestChange = { text: string; added: number; changed: number; gone: number; same: number; changedAfterDone: string[] };

/**
 * The manifest's text with what the folder now holds: a row for each file, in the order the rows had, the new files
 * after them. It is made by edits of the text where they land (ADR 0002): a cell whose value has changed is written,
 * a column the manifest lacks goes on the end of each row's own line, and a new file's row on the end of the file.
 * Every other character stays as it was. The whole table was once printed again from its cells: every value was
 * requoted, blank lines and a byte-order mark went, a row with fewer cells than the header was padded, and a row
 * that had not changed at all came back written another way.
 */
export function mergeManifest(
	existing: string | null | undefined,
	files: readonly ManifestFile[],
	options?: { markChangedAfterDone?: boolean },
): ManifestChange {
	const eol = (existing ?? "").includes("\r\n") ? "\r\n" : "\n";
	let text = existing ?? "";
	let table = parseCsv(text);
	const delimiter = table.delimiter;
	// A text with no row in it has no table to keep: it is given the manifest's own columns.
	if (!table.header.length) {
		text = `${csvRow(MANIFEST_COLUMNS, delimiter)}${eol}`;
		table = parseCsv(text, { delimiter });
	}
	for (const column of ["path", "kind", "bytes", "lines", "sha256", "status"]) {
		if (columnOf(table, column) >= 0) continue;
		text = addCsvColumn(text, table, column) ?? text;
		table = parseCsv(text, { delimiter });
	}
	const [path, kind, bytes, lines, sha, status] = ["path", "kind", "bytes", "lines", "sha256", "status"].map((name) => columnOf(table, name)) as [number, number, number, number, number, number];
	const normPath = (p: string) => p.replace(/\\/g, "/");
	const now = new Map(files.map((file) => [normPath(file.path), file]));
	// A file renamed only in the case of its letters is the same file where the file system says so: it keeps its row.
	const byLower = new Map<string, ManifestFile>();
	for (const file of files) {
		const lower = normPath(file.path).toLowerCase();
		if (!byLower.has(lower)) byLower.set(lower, file);
	}
	const listed = new Set(table.rows.map((cells) => normPath((cells[path]?.text ?? "").trim())).filter(Boolean));
	const seen = new Set<string>();
	const counts = { added: 0, changed: 0, gone: 0, same: 0 };
	const changedAfterDone: string[] = [];
	// The edits, in the order they stand in the text: each a cell of its own, or the end of a row's line.
	const edits: CsvTextEdit[] = [];
	for (const cells of table.rows) {
		const said = (column: number) => cells[column]?.text ?? "";
		const rawName = said(path).trim();
		if (!rawName) continue;
		/** What the row's cells are to say, by column: only one that says something else now is written. */
		const set = new Map<number, string>();
		const normName = normPath(rawName);
		const exact = now.get(normName);
		const renamed = exact ? undefined : byLower.get(normName.toLowerCase());
		// One row to a file: duplicate rows (exact or differing only in case/slashes) must not both claim the same file.
		const candidate = exact ?? (renamed && !listed.has(normPath(renamed.path)) ? renamed : undefined);
		const candidateKey = candidate ? normPath(candidate.path) : undefined;
		const file = candidate && candidateKey && !seen.has(candidateKey) ? candidate : undefined;
		if (file && file.path !== rawName) set.set(path, file.path);
		seen.add(file ? normPath(file.path) : normName);
		if (!file) {
			// A row that says "gone" already, however it is written, is left as it is.
			if (said(status).trim().toLowerCase() !== GONE) {
				counts.gone++;
				set.set(status, GONE);
			}
		} else {
			let state = said(status);
			const shaChanged = Boolean(said(sha).trim() && said(sha).trim() !== file.sha256);
			if (shaChanged) {
				counts.changed++;
				if (toneOf(state) === "done") {
					changedAfterDone.push(file.path);
					if (options?.markChangedAfterDone) state = CHANGED;
				}
			} else counts.same++;
			// A file that had gone and is back is found again; any other status is the person's.
			if (state.trim().toLowerCase() === GONE || !state.trim()) state = FOUND;
			if (state !== said(status)) set.set(status, state);
			set.set(kind, file.kind);
			set.set(bytes, String(file.bytes));
			set.set(lines, String(file.lines));
			set.set(sha, file.sha256);
		}
		const columns = [...set.keys()].sort((a, b) => a - b);
		for (const column of columns) {
			if (column >= cells.length) continue;
			const edit = cellChangeEdit(cells, column, set.get(column)!, delimiter);
			if (edit) edits.push(edit);
		}
		// A row with fewer cells than the header: the cells it lacks, up to the last one that is to say something,
		// go on the end of its line in one piece.
		const last = columns.findLast((column) => column >= cells.length && set.get(column) !== "");
		if (last !== undefined) {
			const end = cells[cells.length - 1]!.end;
			let tail = "";
			for (let column = cells.length; column <= last; column++) tail += delimiter + csvCell(set.get(column) ?? "", delimiter);
			edits.push({ start: end, end, text: tail });
		}
	}
	let out = "";
	let at = 0;
	for (const edit of edits) {
		out += text.slice(at, edit.start) + edit.text;
		at = edit.end;
	}
	out += text.slice(at);
	let fresh = "";
	for (const file of files) {
		if (seen.has(normPath(file.path))) continue;
		const row = table.header.map(() => "");
		[row[path], row[kind], row[bytes], row[lines], row[sha], row[status]] = [file.path, file.kind, String(file.bytes), String(file.lines), file.sha256, FOUND];
		fresh += `${csvRow(row, delimiter)}${eol}`;
		counts.added++;
	}
	if (fresh && out && !/\r?\n$/.test(out)) out += eol;
	return { text: out + fresh, ...counts, changedAfterDone };
}

/** What a manifest's update came to, in a sentence. */
export function manifestSummary(change: ManifestChange): string {
	const parts = [change.added && `${change.added} new`, change.changed && `${change.changed} changed`, change.gone && `${change.gone} gone`].filter(Boolean);
	const total = change.added + change.changed + change.same;
	return parts.length ? `File manifest: ${total} ${total === 1 ? "file" : "files"}; ${parts.join(", ")}.` : `File manifest: ${total} ${total === 1 ? "file" : "files"}, none changed.`;
}
