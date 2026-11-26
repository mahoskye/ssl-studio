// A registry is a table of values in a text file: comma-separated, or
// tab-separated, with its columns named in the first row. This reads one with
// each cell's place in the text, so that a table drawn from it can change a
// cell by changing that part of the text and nothing else (ADR 0002).

export type CsvDelimiter = "," | "\t" | ";" | "|";
export type ParseCsvOptions = {
	delimiter?: CsvDelimiter;
	hasHeader?: boolean;
	/**
	 * What the file's name says its values are separated with (`csvDelimiterForPath`). It is taken when the first
	 * record holds it at all, whatever else that record holds; a first record without it is read as any other.
	 */
	prefer?: CsvDelimiter;
};

export type Cell = {
	text: string;
	/** Where the cell is in the source, quotes and all: from `start` up to `end`. */
	start: number;
	end: number;
};
export type Table = {
	delimiter: CsvDelimiter;
	/** The column names: the first row's cells (or synthesized `Column 1`, `Column 2`, ... when `hasHeader` is false). */
	header: Cell[];
	rows: Cell[][];
	/** What is wrong with it as a table, in words; empty when nothing is. */
	problems: string[];
	/** Set to `false` when parsed with `{ hasHeader: false }` so callers know `header` is synthetic. */
	hasHeader?: boolean;
};
export type CsvTable = Table;

/**
 * The first record as the detection goes over it: its characters outside quoted cells, and where it ends (the line
 * end that closes it, or the end of the text). Nothing after `end` has a say in what the file is read with.
 */
function firstRecordUnquoted(text: string, bomOffset: number): { unquoted: string; end: number } {
	const n = text.length;
	let i = bomOffset;
	// Skip leading blank lines starting after BOM before inspecting the first logical record.
	while (i < n && (text[i] === "\r" || text[i] === "\n")) i++;
	// Extract unquoted characters of the first logical record up to the first unquoted CR/LF,
	// respecting quoted spans (including multiline headers like `"Last,\nFirst"\tStatus`).
	let unquoted = "";
	let atFieldStart = true;
	while (i < n) {
		const ch = text[i]!;
		if (ch === "\r" || ch === "\n") break;
		if (atFieldStart && ch === '"') {
			i++;
			while (i < n) {
				if (text[i] === '"') {
					if (text[i + 1] === '"') {
						i += 2;
						continue;
					}
					i++;
					break;
				}
				i++;
			}
			atFieldStart = false;
			continue;
		}
		unquoted += ch;
		atFieldStart = ch === "," || ch === "\t" || ch === ";" || ch === "|";
		i++;
	}
	return { unquoted, end: i };
}

function detectCsvDelimiter(text: string, bomOffset: number, prefer?: CsvDelimiter): CsvDelimiter {
	const { unquoted } = firstRecordUnquoted(text, bomOffset);
	// A .tsv whose header has a bare comma in one name (`id<tab>Last, First<tab>status`) is still tab-separated.
	if (prefer && unquoted.includes(prefer)) return prefer;
	if (unquoted.includes("\t") && !unquoted.includes(",")) return "\t";
	if (unquoted.includes(";") && !unquoted.includes(",") && !unquoted.includes("\t")) return ";";
	if (unquoted.includes("|") && !unquoted.includes(",") && !unquoted.includes("\t") && !unquoted.includes(";")) return "|";
	return ",";
}

/** What the text's first record says its values are separated with: what `parseCsv` reads it with when it is not told. */
export function csvDelimiterOf(text: string, prefer?: CsvDelimiter): CsvDelimiter {
	return detectCsvDelimiter(text, text.startsWith("\uFEFF") ? 1 : 0, prefer);
}

/** What a file's name says its values are separated with: tabs for a .tsv or .tab file. Other names say nothing. */
export function csvDelimiterForPath(path: string): CsvDelimiter | undefined {
	return /\.(tsv|tab)$/i.test(path) ? "\t" : undefined;
}

/**
 * What a view of a file is set to read it with once its text has been given the delimiter `target`: "auto" where
 * the file's name and first record say `target` themselves, and `target` where they would not (a file of one
 * column, or one whose first line has fewer cells than the rest, says nothing of its delimiter).
 */
export function readingAfterConvert(text: string, path: string, target: CsvDelimiter): CsvDelimiter | "auto" {
	return csvDelimiterOf(text, csvDelimiterForPath(path)) === target ? "auto" : target;
}

/** Reads the rows, a quoted cell holding the delimiter, a line end or a doubled quote as itself. Blank lines are passed over. */
export function parseCsv(text: string, options?: ParseCsvOptions): Table {
	// Skip UTF-8 BOM without shifting offsets into `text` so cell edits land on exact byte/char ranges.
	const bomOffset = text.startsWith("\uFEFF") ? 1 : 0;
	const delimiter: CsvDelimiter = options?.delimiter ?? detectCsvDelimiter(text, bomOffset, options?.prefer);
	const all: Cell[][] = [];
	let row: Cell[] = [];
	let i = bomOffset;
	const n = text.length;
	const endRow = () => {
		if (row.length > 1 || row[0]?.text.trim() || (row[0] && row[0].end > row[0].start)) all.push(row);
		row = [];
	};
	while (i <= n) {
		const start = i;
		let value = "";
		if (text[i] === '"') {
			i++;
			while (i < n) {
				if (text[i] === '"') {
					if (text[i + 1] === '"') {
						value += '"';
						i += 2;
						continue;
					}
					i++;
					break;
				}
				value += text[i++];
			}
			// Anything after the closing quote and before the delimiter belongs to the cell as written.
			while (i < n && text[i] !== delimiter && text[i] !== "\n" && text[i] !== "\r") value += text[i++];
		} else {
			while (i < n && text[i] !== delimiter && text[i] !== "\n" && text[i] !== "\r") value += text[i++];
		}
		row.push({ text: value, start, end: i });
		if (i >= n) {
			endRow();
			break;
		}
		if (text[i] === delimiter) {
			i++;
			// A delimiter at the very end is one more, empty, cell.
			if (i >= n) {
				row.push({ text: "", start: i, end: i });
				endRow();
				break;
			}
			continue;
		}
		if (text[i] === "\r" && text[i + 1] === "\n") i++;
		i++;
		endRow();
	}
	const hasHeader = options?.hasHeader !== false;
	let header: Cell[];
	let rows: Cell[][];
	if (hasHeader) {
		const [first = [], ...rest] = all;
		header = first;
		rows = rest;
	} else {
		const colCount = all.reduce((max, r) => Math.max(max, r.length), 0);
		header = Array.from({ length: colCount }, (_, idx) => ({ text: `Column ${idx + 1}`, start: 0, end: 0 }));
		rows = all;
	}
	const problems: string[] = [];
	const names = header.map((c) => c.text.trim());
	if (hasHeader) {
		if (!names.length) problems.push("It has no first row to name its columns.");
		const blank = names.filter((name) => !name).length;
		if (blank) problems.push(`${blank} ${blank === 1 ? "column has" : "columns have"} no name.`);
		const twice = [...new Set(names.filter((name, at) => name && names.findIndex((other) => other.toLowerCase() === name.toLowerCase()) !== at))];
		if (twice.length) problems.push(`More than one column is named ${twice.join(", ")}.`);
	}
	const ragged = rows.filter((cells) => cells.length !== header.length).length;
	if (ragged) problems.push(`${ragged} ${ragged === 1 ? "row has" : "rows have"} more or fewer cells than there are columns.`);
	return hasHeader ? { delimiter, header, rows, problems } : { delimiter, header, rows, problems, hasHeader: false };
}

/** A value as it is written in a cell: quoted when it holds the delimiter, a quote, a line end, or space at either end. */
export function csvCell(value: string, delimiter: Table["delimiter"] = ","): string {
	return value.includes(delimiter) || /["\r\n]/.test(value) || value !== value.trim() ? `"${value.replace(/"/g, '""')}"` : value;
}

/**
 * A value as it is written in the first record. What separates a file's values is read from that record, where any
 * bare comma, tab, semicolon or pipe counts, so a value holding any of the four is quoted there, not only one
 * holding the file's own: `Last, First` written bare into the header of a tab-separated file made every later
 * reading of it a comma-separated file of two columns.
 */
export function csvFirstRecordCell(value: string, delimiter: Table["delimiter"] = ","): string {
	return /[,\t;|]/.test(value) ? `"${value.replace(/"/g, '""')}"` : csvCell(value, delimiter);
}

export type CsvTextEdit = { start: number; end: number; text: string };

/** `text` with the edits made, as an editor makes them: none overlapping, in any order, each a place in `text` as it is. */
export function applyCsvEdits(text: string, edits: readonly CsvTextEdit[]): string {
	let out = "";
	let from = 0;
	for (const edit of [...edits].sort((a, b) => a.start - b.start || a.end - b.end)) {
		out += text.slice(from, edit.start) + edit.text;
		from = edit.end;
	}
	return out + text.slice(from);
}

/**
 * `text` with the cells of its first record quoted until that record says `delimiter` to whatever reads the file
 * next, or null when no quoting makes it say so. First the cells that hold what the record is now taken to be
 * separated with, and those alone when they are enough (`a|b` stays as it is beside `"Smith, John"` in a
 * semicolon file); then every cell that holds any delimiter or a quote. Each is written with the value it has.
 */
function firstRecordSaying(text: string, delimiter: CsvDelimiter, prefer?: CsvDelimiter): string | null {
	const cells = parseCsv(text, { delimiter, hasHeader: false }).rows[0];
	// No record at all: nothing is there to be read with the wrong delimiter.
	if (!cells) return text;
	const quoted = (cell: Cell) => `"${cell.text.replace(/"/g, '""')}"`;
	const withQuoted = (holds: (value: string) => boolean) => {
		let out = "";
		let from = 0;
		for (const cell of cells) {
			if (!holds(cell.text) || text.slice(cell.start, cell.end) === quoted(cell)) continue;
			out += text.slice(from, cell.start) + quoted(cell);
			from = cell.end;
		}
		return out + text.slice(from);
	};
	const taken = csvDelimiterOf(text, prefer);
	for (const holds of [(value: string) => value.includes(taken), (value: string) => /[,\t;|"]/.test(value)]) {
		const next = withQuoted(holds);
		if (csvDelimiterOf(next, prefer) === delimiter) return next;
	}
	return null;
}

/**
 * The one rule for whatever record is first in a file after an edit: the file must still be read with `delimiter`,
 * the one the table was read with when the edit was worked out. Every writer of a table's text asks here (or
 * `csvEditsKeepingDelimiter`) for what to write: `after` as it is where its first record still says `delimiter`,
 * `after` with cells of that record quoted where that makes it say so, and null where nothing can, in which case
 * the edit is not made.
 *
 * What separates a file's values is read from its first record, where a bare comma outranks a tab, a tab a
 * semicolon, and a semicolon a pipe. Renaming a column knew that (`csvFirstRecordCell`); a cell typed into the
 * first row of a table with no header row, a paste or a fill over it, a sort or a move that put another row
 * first, and a delete of the first row did not: `Smith, John` typed into `1;Ann;x` made the file a comma-separated
 * one of two columns, and the next edit, worked out on that reading, wrote over a whole row.
 *
 * Quoting cannot make a record of ONE cell say anything: with no delimiter in it, it is read as comma-separated.
 * So an edit that leaves a single cell first in a file separated by semicolons, pipes or tabs is refused (a
 * delete or a sort that puts a short row first, a column deleted down to one).
 *
 * Two things are let through as they are. A text with no record left has no cell to misread. And a file that did
 * not say `delimiter` before the edit either (the view was set to read it with one its first record does not
 * name) is not made to say it now: the view's own setting, not the record, is what reads it.
 */
export function csvTextKeepingDelimiter(before: string, after: string, delimiter: CsvDelimiter, prefer?: CsvDelimiter): string | null {
	if (csvDelimiterOf(after, prefer) === delimiter) return after;
	if (csvDelimiterOf(before, prefer) !== delimiter) return after;
	return firstRecordSaying(after, delimiter, prefer);
}

/** The one edit that makes `after` of `before`: from the first character that differs to the last. */
function editBetween(before: string, after: string): CsvTextEdit {
	const most = Math.min(before.length, after.length);
	let start = 0;
	while (start < most && before[start] === after[start]) start++;
	let tail = 0;
	while (tail < most - start && before[before.length - 1 - tail] === after[after.length - 1 - tail]) tail++;
	// Never between the two characters of a CRLF or of a surrogate pair: an editor takes such a place for the one beside it.
	const splits = (text: string, at: number) =>
		at > 0 && at < text.length && ((text[at - 1] === "\r" && text[at] === "\n") || (/[\uD800-\uDBFF]/.test(text[at - 1]!) && /[\uDC00-\uDFFF]/.test(text[at]!)));
	while (start > 0 && (splits(before, start) || splits(after, start))) start--;
	while (tail > 0 && (splits(before, before.length - tail) || splits(after, after.length - tail))) tail--;
	return { start, end: before.length - tail, text: after.slice(start, after.length - tail) };
}

/**
 * `csvTextKeepingDelimiter` for edits of `text` (none overlapping, in any order): the edits to make, or null when
 * they may not be made. They come back as they were given, the same list, when the first record still says
 * `delimiter` with them. Edits that all begin after the first record cannot change what it says and are given back
 * without a look at the rest of the text: an edit of another row leaves the first record as it is, to the character.
 *
 * Where the first record has to be quoted, the edits come back as one edit that holds that quoting and the given
 * edits it reaches, the first of them always, followed by the rest as they were given: never more edits than
 * were given, so one edit comes back as one. The quoting is all in the first record, and an edit that begins after
 * it is not part of it: all the edits were once made one, from the first to the last, so that a column deleted from
 * every row, or the first row and one far below it deleted together, was written as one edit over every row
 * between, the rows it did not touch among them.
 */
export function csvEditsKeepingDelimiter(
	text: string,
	edits: readonly CsvTextEdit[],
	delimiter: CsvDelimiter,
	prefer?: CsvDelimiter,
): readonly CsvTextEdit[] | null {
	const firstEnds = firstRecordUnquoted(text, text.startsWith("\uFEFF") ? 1 : 0).end;
	if (edits.every((edit) => edit.start > firstEnds)) return edits;
	const sorted = [...edits].sort((a, b) => a.start - b.start || a.end - b.end);
	const after = applyCsvEdits(text, sorted);
	const kept = csvTextKeepingDelimiter(text, after, delimiter, prefer);
	if (kept === null) return null;
	if (kept === after) return edits;
	// Where the quoting ends in `after`: from there on `kept` is `after`, to the character.
	let same = 0;
	while (same < after.length && same < kept.length && after[after.length - 1 - same] === kept[kept.length - 1 - same]) same++;
	const quotedTo = after.length - same;
	// The first place at or after that end, past the first edit, that is in no edit: what is before it becomes one
	// edit, and the edits after it stay as they are. `shift` is how far the text before edit `next` has moved.
	let shift = sorted[0]!.text.length - (sorted[0]!.end - sorted[0]!.start);
	let next = 1;
	while (next < sorted.length && quotedTo > sorted[next]!.start + shift) {
		shift += sorted[next]!.text.length - (sorted[next]!.end - sorted[next]!.start);
		next++;
	}
	const cutAfter = Math.max(quotedTo, sorted[next - 1]!.end + shift);
	const cut = cutAfter - shift;
	const head = editBetween(text.slice(0, cut), kept.slice(0, cutAfter + (kept.length - after.length)));
	const rest = sorted.slice(next);
	// Two insertions at one place are one insertion: an editor does not say which of two comes first.
	if (head.start === head.end && rest[0] && rest[0].start === head.start && rest[0].end === head.start) {
		return [{ start: head.start, end: head.end, text: head.text + rest[0].text }, ...rest.slice(1)];
	}
	return [head, ...rest];
}

/** A whole row as a line of text. Preserves a 1-column empty row as `""` so re-parsing never drops it as a blank line. */
export const csvRow = (values: readonly string[], delimiter: Table["delimiter"] = ",") =>
	values.length === 1 && values[0] === "" ? '""' : values.map((v) => csvCell(v, delimiter)).join(delimiter);

/** The place of the column of that name, whatever its case; -1 when there is none. */
export const columnOf = (table: Pick<Table, "header">, name: string) => table.header.findIndex((c) => c.text.trim().toLowerCase() === name.toLowerCase());

// One collator for every comparison. `a.localeCompare(b, undefined, options)` makes one for each pair it is given:
// sorting 5,000 rows that way took 300 ms, and a sorted table was sorted again after every edit.
const cellOrder = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });

/** Orders two cell texts as a person reads them: digits by their number (`a2` before `a10`), case and accents aside. */
export const compareCellText = (a: string, b: string): number => cellOrder.compare(a, b);

/**
 * How far along a registry is: how many of its rows have each word in their
 * `status` column, most first. Null when it has no such column. A row with
 * nothing there counts under "".
 */
export function tally(table: Table, column = "status"): { total: number; by: [status: string, count: number][] } | null {
	const at = columnOf(table, column);
	if (at < 0) return null;
	const by = new Map<string, number>();
	for (const row of table.rows) {
		const status = (row[at]?.text ?? "").trim().toLowerCase();
		by.set(status, (by.get(status) ?? 0) + 1);
	}
	return { total: table.rows.length, by: [...by].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])) };
}

/**
 * Where one row is in the text, its line end with it, so that taking those
 * characters out leaves a table with one row fewer and nothing else changed.
 * The last row of a file that does not end with a line end takes the line end
 * before it instead. Null when there is no such row.
 */
export function rowSpan(text: string, table: Table, row: number): { start: number; end: number } | null {
	const cells = table.rows[row];
	if (!cells?.length) return null;
	let start = cells[0]!.start;
	let end = cells[cells.length - 1]!.end;
	if (text[end] === "\r" && text[end + 1] === "\n") end += 2;
	else if (text[end] === "\n" || text[end] === "\r") end += 1;
	else if (text[start - 1] === "\n") start -= text[start - 2] === "\r" ? 2 : 1;
	return { start, end };
}

/**
 * Exact raw source text of one row (without its trailing line break), so
 * duplicating a row preserves quoting and formatting untouched (ADR 0002).
 */
export function rawRowText(text: string, table: Table, row: number): string | null {
	const cells = table.rows[row];
	if (!cells?.length) return null;
	return text.slice(cells[0]!.start, cells[cells.length - 1]!.end);
}

/**
 * The edit of the text that writes `value` to column `column` of a row whose cells are `cells`: that cell's part of
 * the text and nothing else (ADR 0002). Null when the table would show nothing different. A row with fewer cells
 * than the header shows the missing ones as empty, so emptying one, or committing it as it is, is no edit; it
 * padded the row with delimiters and left the file changed with nothing to see for it. A value to show in such a
 * cell gives the row the cells between. The only cell of a row is written `""` when it is emptied, so that the row
 * is not read as a blank line.
 */
export function cellChangeEdit(
	cells: readonly Cell[],
	column: number,
	value: string,
	delimiter: Table["delimiter"] = ",",
): { start: number; end: number; text: string } | null {
	const cell = cells[column];
	if ((cell?.text ?? "") === value) return null;
	if (cell) return { start: cell.start, end: cell.end, text: value === "" && cells.length <= 1 ? '""' : csvCell(value, delimiter) };
	const last = cells[cells.length - 1];
	if (!last || column < 0) return null;
	return { start: last.end, end: last.end, text: delimiter.repeat(column - cells.length + 1) + csvCell(value, delimiter) };
}

/**
 * Where to insert a new line directly above or below `row`, as a single text
 * insertion at `offset`. Preserves the file's line ending style.
 */
export function insertRowEdit(
	text: string,
	table: Table,
	row: number,
	position: "above" | "below",
	line: string,
	eol?: string,
): { offset: number; text: string } | null {
	const cells = table.rows[row];
	if (!cells?.length) return null;
	const nl = eol ?? (text.includes("\r\n") ? "\r\n" : "\n");
	if (position === "above") {
		return { offset: cells[0]!.start, text: `${line}${nl}` };
	}
	const end = cells[cells.length - 1]!.end;
	if (text[end] === "\r" && text[end + 1] === "\n") return { offset: end + 2, text: `${line}${nl}` };
	if (text[end] === "\n" || text[end] === "\r") return { offset: end + 1, text: `${line}${nl}` };
	return { offset: end, text: `${nl}${line}` };
}

/**
 * Text insertion to append a row at the end of a CSV/TSV file, ensuring a
 * leading line break when the file does not end with one.
 */
export function appendRowEdit(
	text: string,
	values: readonly string[],
	delimiter: Table["delimiter"] = ",",
	eol?: string,
): { offset: number; text: string } {
	const nl = eol ?? (text.includes("\r\n") ? "\r\n" : "\n");
	const line = values.length > 1 ? csvRow(values, delimiter) : values[0] ? csvCell(values[0], delimiter) : '""';
	const prefix = text && !/\r?\n$/.test(text) ? nl : "";
	return { offset: text.length, text: `${prefix}${line}${nl}` };
}

// --- Changes of Columns and Rows, as Edits of the Places They Touch -----------
//
// Renaming, adding, deleting and reordering columns, and deleting rows, each as the edits of the text it means
// (ADR 0002): none overlapping, each a place in `text` as it is, to be made together. The view wrote the whole
// document for each of them, from a text worked out here. A record no edit touches is not written at all,
// however the parser reads it: a row short of the column, a blank line, a line with a stray quote.

/** The records as they stand in the text: the header's first, where the table has one. */
function recordsOf(table: Table): Cell[][] {
	if (table.hasHeader === false) return table.rows;
	const all: Cell[][] = [table.header];
	for (const row of table.rows) all.push(row);
	return all;
}

/**
 * Whether a cell as written opens a quote and never closes it. Such a cell runs to the end of the text, and
 * whatever is written after it is read as more of it.
 */
function opensUnclosedQuote(raw: string): boolean {
	if (raw[0] !== '"') return false;
	for (let i = 1; i < raw.length; i++) {
		if (raw[i] !== '"') continue;
		if (raw[i + 1] !== '"') return false;
		i++;
	}
	return true;
}

/**
 * The edits that put every record's cells in `newOrder` (`newOrder[newIdx] = oldIdx`): one for each record, from
 * the first cell that changes place to the last, each cell written as it is (quotes and line breaks in it too).
 * A row has no edit when the cells that would change places are written alike, or when it is too short to have
 * any of them; one too short to have them all gets empty cells only as far as its last cell that moves, and
 * cells past the header's width stay where they are. Every row was written to the header's full width, so a
 * short row grew delimiters at its end though none of its cells had moved. Null when `newOrder` is not an order
 * of the columns, or is the order they are in.
 */
export function reorderCsvColumnsEdits(text: string, table: Table, newOrder: readonly number[]): CsvTextEdit[] | null {
	const count = table.header.length;
	if (count < 2 || newOrder.length !== count) return null;
	const seen = new Set<number>();
	for (const col of newOrder) {
		if (!Number.isInteger(col) || col < 0 || col >= count || seen.has(col)) return null;
		seen.add(col);
	}
	let lo = 0;
	while (lo < count && newOrder[lo] === lo) lo++;
	if (lo === count) return null;
	let hi = count - 1;
	while (newOrder[hi] === hi) hi--;

	const edits: CsvTextEdit[] = [];
	for (const cells of recordsOf(table)) {
		// The places from `lo` to `hi` hold the same columns after as before, in another order: a row that ends
		// before `lo` has none of them.
		if (cells.length <= lo) continue;
		const parts: string[] = [];
		let last = -1;
		for (let place = lo; place <= hi; place++) {
			const cell = cells[newOrder[place]!];
			if (!cell) {
				parts.push("");
				continue;
			}
			const raw = text.slice(cell.start, cell.end);
			// A quote left open is closed where its cell is moved to: what follows it there would be read into it.
			parts.push(opensUnclosedQuote(raw) ? `${raw}"` : raw);
			last = place - lo;
		}
		parts.length = last + 1;
		const start = cells[lo]!.start;
		const end = cells[Math.min(hi, cells.length - 1)]!.end;
		const written = parts.join(table.delimiter);
		if (text.slice(start, end) !== written) edits.push({ start, end, text: written });
	}
	return edits;
}

/**
 * Reorders every row's columns in `text` according to `newOrder` (where
 * `newOrder[newIdx] = oldIdx`). Preserves each cell's raw source text
 * verbatim (including quoting and embedded line breaks), line endings, blank
 * lines, and any extra ragged trailing cells without dropping data (ADR 0002).
 * Returns `null` when `newOrder` is invalid or already the natural order.
 */
export function reorderCsvColumns(text: string, table: Table, newOrder: readonly number[]): string | null {
	const edits = reorderCsvColumnsEdits(text, table, newOrder);
	return edits ? applyCsvEdits(text, edits) : null;
}

/**
 * The edits that add a column after the last: one insertion for each record, the name in the header (or, in a
 * table with no header row, `defaultValue` in every row) and `defaultValue` below it. A row short of the header
 * gets the delimiters between, so that its new cell is under the new column; a row with more cells than the
 * header gets it after the header's last column, before its other cells. Nothing that is in the text is written
 * anew. Null when there is no name or no column to add one after.
 */
export function addCsvColumnEdits(text: string, table: Table, name: string, defaultValue = ""): CsvTextEdit[] | null {
	const trimmed = name.trim();
	if (!trimmed || !table.header.length) return null;
	const count = table.header.length;
	const headerless = table.hasHeader === false;
	const records = recordsOf(table);
	const edits: CsvTextEdit[] = [];
	for (let r = 0; r < records.length; r++) {
		const cells = records[r]!;
		if (!cells.length) continue;
		const isHeaderRow = !headerless && r === 0;
		const isLongRagged = !isHeaderRow && cells.length > count;
		const before = isLongRagged ? cells[count - 1]! : cells[cells.length - 1]!;
		const padCount = isHeaderRow ? 0 : Math.max(0, count - cells.length);
		const value = isHeaderRow ? trimmed : defaultValue;
		// The first row is the first record with or without a header.
		const val = r === 0 ? csvFirstRecordCell(value, table.delimiter) : csvCell(value, table.delimiter);
		// A quote left open in the cell before is closed first: the new cell would be read into it.
		const close = opensUnclosedQuote(text.slice(before.start, before.end)) ? '"' : "";
		edits.push({ start: before.end, end: before.end, text: close + table.delimiter.repeat(padCount + 1) + val });
	}
	return edits;
}

/**
 * Appends a new column to the header and every row in `text`, preserving existing
 * cells verbatim and padding short ragged rows so the new cell aligns cleanly (ADR 0002).
 */
export function addCsvColumn(text: string, table: Table, name: string, defaultValue = ""): string | null {
	const edits = addCsvColumnEdits(text, table, name, defaultValue);
	return edits ? applyCsvEdits(text, edits) : null;
}

/** The one edit that renames a column: its cell in the header, and nothing else (ADR 0002). Null when there is no header row, no such column, no name, or the name it has. */
export function renameCsvColumnEdits(table: Table, colIdx: number, newName: string): CsvTextEdit[] | null {
	if (table.hasHeader === false) return null;
	const trimmed = newName.trim();
	const cell = table.header[colIdx];
	if (!trimmed || !cell) return null;
	if (cell.text === trimmed) return null;
	return [{ start: cell.start, end: cell.end, text: csvFirstRecordCell(trimmed, table.delimiter) }];
}

/** Renames a single column header cell in `text`, touching nothing else (ADR 0002). */
export function renameCsvColumn(text: string, table: Table, colIdx: number, newName: string): string | null {
	const edits = renameCsvColumnEdits(table, colIdx, newName);
	return edits ? applyCsvEdits(text, edits) : null;
}

/**
 * The edits that delete column `colIdx`: from each record that has the cell, that cell and one delimiter beside it
 * (the one after the first cell, the one before any other). A row too short to have the cell has no edit. A row
 * that would be left with nothing, or with one empty cell, is left as `""`, so that it is not read as a blank line
 * and passed over. Null when it is the only column, or no column.
 */
export function deleteCsvColumnEdits(text: string, table: Table, colIdx: number): CsvTextEdit[] | null {
	const count = table.header.length;
	if (count < 2 || colIdx < 0 || colIdx >= count) return null;
	const edits: CsvTextEdit[] = [];
	for (const cells of recordsOf(table)) {
		const cell = cells[colIdx];
		if (!cell) continue;
		if (cells.length === 1) {
			if (text.slice(cell.start, cell.end) !== '""') edits.push({ start: cell.start, end: cell.end, text: '""' });
			continue;
		}
		const other = cells[colIdx === 0 ? 1 : 0]!;
		if (cells.length === 2 && other.start === other.end) {
			edits.push({ start: cells[0]!.start, end: cells[1]!.end, text: '""' });
			continue;
		}
		if (colIdx === 0) edits.push({ start: cell.start, end: cells[1]!.start, text: "" });
		else edits.push({ start: cells[colIdx - 1]!.end, end: cell.end, text: "" });
	}
	return edits;
}

/**
 * Deletes column `colIdx` from the header and every row in `text` while keeping
 * every remaining cell's exact raw quoting and formatting untouched (ADR 0002).
 */
export function deleteCsvColumn(text: string, table: Table, colIdx: number): string | null {
	const edits = deleteCsvColumnEdits(text, table, colIdx);
	return edits ? applyCsvEdits(text, edits) : null;
}

/**
 * The one edit of `text` that puts the data rows in `rowOrder` (`rowOrder[newIdx] = oldRowIdx`): it runs from the
 * first row that changes place to the last, and touches nothing outside them (ADR 0002). Each row's own text goes
 * where another row's was, written as it is. What stands between two rows stays where it stands: the line end,
 * and any blank lines, which are no rows, so a blank line is on the same line of the file after as before. The
 * rows were written out anew from the first to the last with one line end between them, which took every blank
 * line among them out of the file. Null when `rowOrder` is not an order of the rows, or changes nothing.
 */
export function sortCsvRowsEdit(text: string, table: Table, rowOrder: readonly number[]): { start: number; end: number; text: string } | null {
	const count = table.rows.length;
	if (count < 2 || rowOrder.length !== count) return null;
	const seen = new Set<number>();
	for (const r of rowOrder) {
		if (!Number.isInteger(r) || r < 0 || r >= count || seen.has(r)) return null;
		seen.add(r);
	}
	let first = 0;
	while (first < count && rowOrder[first] === first) first++;
	if (first === count) return null;
	let last = count - 1;
	while (rowOrder[last] === last) last--;
	const endOf = (row: number) => {
		const cells = table.rows[row]!;
		return cells[cells.length - 1]!.end;
	};
	let out = "";
	for (let place = first; place <= last; place++) {
		out += rawRowText(text, table, rowOrder[place]!) ?? "";
		if (place < last) out += text.slice(endOf(place), table.rows[place + 1]![0]!.start);
	}
	return { start: table.rows[first]![0]!.start, end: endOf(last), text: out };
}

/**
 * Rewrites data rows in `rowOrder` (`rowOrder[newIdx] = oldRowIdx`), preserving
 * header, line endings, blank lines, and every row's exact raw source text verbatim (ADR 0002).
 */
export function sortCsvRows(text: string, table: Table, rowOrder: readonly number[]): string | null {
	const edit = sortCsvRowsEdit(text, table, rowOrder);
	return edit ? text.slice(0, edit.start) + edit.text + text.slice(edit.end) : null;
}

/**
 * The one edit of `text` that moves data row `fromRow` to `toRow`: it runs from the one to the other, the rows
 * between them each moving one place, and touches nothing outside them (see `sortCsvRowsEdit`). Null when the
 * rows are out of bounds or the same.
 */
export function moveCsvRowEdit(text: string, table: CsvTable, fromRow: number, toRow: number): { start: number; end: number; text: string } | null {
	const count = table.rows.length;
	if (!Number.isInteger(fromRow) || !Number.isInteger(toRow) || fromRow < 0 || fromRow >= count || toRow < 0 || toRow >= count) return null;
	const rowOrder = Array.from({ length: count }, (_, idx) => idx);
	const [moved] = rowOrder.splice(fromRow, 1);
	rowOrder.splice(toRow, 0, moved!);
	return sortCsvRowsEdit(text, table, rowOrder);
}

/**
 * Moves data row `fromRow` to `toRow`, preserving header, line endings, and every
 * row's exact raw source text verbatim (ADR 0002). Returns `text` unchanged when
 * indices are out of bounds or identical.
 */
export function moveCsvRow(text: string, table: CsvTable, fromRow: number, toRow: number): string {
	const edit = moveCsvRowEdit(text, table, fromRow, toRow);
	return edit ? text.slice(0, edit.start) + edit.text + text.slice(edit.end) : text;
}

/** What of a cell as written is outside its quotes: all of it, or what follows the closing quote of one that begins with a quote. */
function outsideQuotes(raw: string): string {
	if (raw[0] !== '"') return raw;
	for (let i = 1; i < raw.length; i++) {
		if (raw[i] !== '"') continue;
		if (raw[i + 1] !== '"') return raw.slice(i + 1);
		i++;
	}
	return "";
}

/**
 * Converts `text` from `table.delimiter` to `nextDelimiter`: every delimiter between two cells becomes the new
 * one, and all else stays as it is written (BOM, blank lines, line ends, and each cell with its quotes and the
 * spaces around it). A cell is written anew only where it must be: one that holds the new delimiter outside
 * quotes, which is then quoted. Every cell was written anew from its value, which took the quotes off a file that
 * quotes all its cells, put them on a cell with a space at its end, and made `"a"b` into `ab`.
 */
export function convertCsvDelimiter(text: string, table: CsvTable, nextDelimiter: CsvDelimiter): string {
	if (table.delimiter === nextDelimiter) return text;
	let out = "";
	let cursor = 0;
	// The first record's cells are quoted when they hold any delimiter, not only the new one: a comma left bare
	// there (`id<tab>Last, First`) makes the file a comma-separated one to whatever reads it next.
	let first = true;
	for (const cells of recordsOf(table)) {
		if (!cells.length) continue;
		const inFirst = first;
		first = false;
		out += text.slice(cursor, cells[0]!.start);
		for (let c = 0; c < cells.length; c++) {
			const cell = cells[c]!;
			const raw = text.slice(cell.start, cell.end);
			const bare = outsideQuotes(raw);
			const asIs = inFirst ? !/[,\t;|]/.test(bare) : !bare.includes(nextDelimiter);
			out += (c ? nextDelimiter : "") + (asIs ? raw : inFirst ? csvFirstRecordCell(cell.text, nextDelimiter) : csvCell(cell.text, nextDelimiter));
		}
		cursor = cells[cells.length - 1]!.end;
	}
	out += text.slice(cursor);
	return out;
}

/**
 * A block of cells as text for the clipboard: a tab between cells, a line end between rows, and a cell that holds
 * either written in quotes. `parseClipboardGrid` reads a block of more than one cell back as the same cells. A
 * last row that is one empty cell is an empty line, and is given its line end as Excel gives every row one:
 * without it the text ended in the line end before that row, which is read as Excel's own last one and taken off,
 * so the cells `a` and `` copied and pasted came back as `a` alone.
 */
export function cellsToClipboardText(rows: readonly (readonly string[])[]): string {
	const text = rows.map((row) => row.map((v) => csvCell(v, "\t")).join("\t")).join("\n");
	return rows.length > 1 && text.endsWith("\n") ? `${text}\n` : text;
}

/** Exports tabular headers and rows as tab-separated text for pasting into Excel or Sheets. */
export function tableToTsv(headers: readonly string[], rows: readonly (readonly string[])[]): string {
	return cellsToClipboardText([headers, ...rows]);
}

/** Exports tabular headers and rows as a clean GitHub-Flavored Markdown pipe table. */
export function tableToMarkdown(headers: readonly string[], rows: readonly (readonly string[])[]): string {
	const esc = (v: string) => v.replace(/\|/g, "\\|").replace(/\r?\n/g, "<br>");
	const head = `| ${headers.map(esc).join(" | ")} |`;
	const sep = `| ${headers.map(() => "---").join(" | ")} |`;
	const body = rows.map((row) => `| ${headers.map((_, i) => esc(row[i] ?? "")).join(" | ")} |`);
	return [head, sep, ...body].join("\n");
}

/**
 * The edits that delete the rows: each row's line with its line end (`rowSpan`), rows that stand together as one
 * edit, so that none overlaps another (on a file with no line end after its last row, that row and the one above
 * it would both take the line end between them). Nothing else is written. Null when none of the rows is there.
 */
export function deleteCsvRowsEdits(text: string, table: Table, rowIndices: readonly number[]): CsvTextEdit[] | null {
	const count = table.rows.length;
	const unique = [...new Set(rowIndices)].filter((r) => Number.isInteger(r) && r >= 0 && r < count).sort((a, b) => a - b);
	if (!unique.length) return null;
	const spans: CsvTextEdit[] = [];
	for (const r of unique) {
		const sp = rowSpan(text, table, r);
		if (!sp) continue;
		const prev = spans[spans.length - 1];
		if (prev && sp.start <= prev.end) {
			prev.end = Math.max(prev.end, sp.end);
		} else {
			spans.push({ start: sp.start, end: sp.end, text: "" });
		}
	}
	return spans.length ? spans : null;
}

/**
 * Deletes multiple rows cleanly in one pass without overlapping ranges (even on
 * files with no trailing newline, where deleting both the last row and the row
 * above it would otherwise collide on the separating newline). Preserves every
 * remaining row's raw source text verbatim (ADR 0002).
 */
export function deleteCsvRows(text: string, table: Table, rowIndices: readonly number[]): string | null {
	const edits = deleteCsvRowsEdits(text, table, rowIndices);
	return edits ? applyCsvEdits(text, edits) : null;
}

/** Finds duplicate non-empty primary keys in column `colIdx` (case-insensitive). */
export function csvDuplicateKeys(table: Table, colIdx = 0): { key: string; rows: number[] }[] {
	if (colIdx < 0 || colIdx >= table.header.length) return [];
	const byKey = new Map<string, { display: string; rows: number[] }>();
	for (let r = 0; r < table.rows.length; r++) {
		const raw = (table.rows[r]?.[colIdx]?.text ?? "").trim();
		if (!raw) continue;
		const k = raw.toLowerCase();
		const entry = byKey.get(k);
		if (entry) entry.rows.push(r);
		else byKey.set(k, { display: raw, rows: [r] });
	}
	return [...byKey.values()]
		.filter((v) => v.rows.length > 1)
		.map((v) => ({ key: v.display, rows: v.rows }));
}

/**
 * Parses clipboard text from Excel, Google Sheets, or plain text into a 2D cell grid.
 * Recognizes tab-delimited columns and RFC 4180 quoted multiline cells (including
 * single-cell quoted multiline values without tabs).
 */
export function parseClipboardGrid(raw: string): string[][] {
	const clean = raw.replace(/\r\n/g, "\n").replace(/\r/g, "\n").replace(/\n$/, "");
	if (!clean) return [];
	const hasGridSeparator = clean.includes("\t") || clean.includes("\n");
	const grid: string[][] = [];
	let row: string[] = [];
	let i = 0;
	const n = clean.length;
	while (i <= n) {
		let val = "";
		if (clean[i] === '"') {
			let j = i + 1;
			let unquoted = "";
			let closed = false;
			let hasEscapedQuote = false;
			while (j < n) {
				if (clean[j] === '"') {
					if (clean[j + 1] === '"') {
						unquoted += '"';
						hasEscapedQuote = true;
						j += 2;
						continue;
					}
					j++;
					closed = true;
					break;
				}
				unquoted += clean[j++];
			}
			const followedByBoundary = closed && (j >= n || clean[j] === "\t" || clean[j] === "\n");
			if (followedByBoundary && (hasGridSeparator || hasEscapedQuote)) {
				val = unquoted;
				i = j;
			} else {
				while (i < n && clean[i] !== "\t" && clean[i] !== "\n") val += clean[i++];
			}
		} else {
			while (i < n && clean[i] !== "\t" && clean[i] !== "\n") val += clean[i++];
		}
		row.push(val);
		if (i >= n) {
			grid.push(row);
			break;
		}
		if (clean[i] === "\t") {
			i++;
			continue;
		}
		if (clean[i] === "\n") {
			i++;
			grid.push(row);
			row = [];
		}
	}
	return grid;
}

/**
 * Goes over the line breaks of a table's text, saying of each where it starts and ends and whether it is inside a
 * quoted cell. A quote opens a cell where `parseCsv` takes it to: at the start of a row, or right after the
 * delimiter. Anywhere else it is a character of its cell (`Join(list, ",")` in a tab-separated file opens nothing).
 */
function eachLineBreak(text: string, delimiter: CsvDelimiter, visit: (start: number, end: number, inCell: boolean) => void): void {
	const n = text.length;
	let i = text.startsWith("\uFEFF") ? 1 : 0;
	let atCellStart = true;
	while (i < n) {
		const ch = text[i]!;
		if (atCellStart && ch === '"') {
			i++;
			while (i < n) {
				const inner = text[i]!;
				if (inner === '"') {
					if (text[i + 1] === '"') {
						i += 2;
						continue;
					}
					i++;
					break;
				}
				if (inner === "\r" || inner === "\n") {
					const end = inner === "\r" && text[i + 1] === "\n" ? i + 2 : i + 1;
					visit(i, end, true);
					i = end;
					continue;
				}
				i++;
			}
			atCellStart = false;
			continue;
		}
		if (ch === "\r" || ch === "\n") {
			const end = ch === "\r" && text[i + 1] === "\n" ? i + 2 : i + 1;
			visit(i, end, false);
			i = end;
			atCellStart = true;
			continue;
		}
		atCellStart = ch === delimiter;
		i++;
	}
}

/**
 * Whether the text has the line ends Excel gives a table: CRLF after every row, and a bare LF for every line break
 * inside a quoted cell. True only when it has both kinds and nothing else: a text whose line ends are mixed in
 * some other way is not one whose in-cell breaks can be told from its row ends by their kind.
 */
export function csvHasBareCellBreaks(text: string, delimiter: CsvDelimiter = csvDelimiterOf(text)): boolean {
	let rowEnds = 0;
	let cellBreaks = 0;
	let other = false;
	eachLineBreak(text, delimiter, (start, end, inCell) => {
		const crlf = end - start === 2;
		if (inCell) {
			if (!crlf && text[start] === "\n") cellBreaks++;
			else other = true;
		} else if (crlf) rowEnds++;
		else other = true;
	});
	return !other && rowEnds > 0 && cellBreaks > 0;
}

/** The text with every CRLF inside a quoted cell made a bare LF again. Row ends, and everything else, are as given. */
export function csvCellBreaksToLf(text: string, delimiter: CsvDelimiter = csvDelimiterOf(text)): string {
	let out = "";
	let from = 0;
	eachLineBreak(text, delimiter, (start, end, inCell) => {
		if (!inCell || end - start !== 2) return;
		out += `${text.slice(from, start)}\n`;
		from = end;
	});
	return from === 0 ? text : out + text.slice(from);
}

/**
 * The text to write for a table file, given what is in the editor and what the file has on disk. The editor gives
 * a text one kind of line end, the kind it has most of, so a file Excel wrote (CRLF after each row, a bare LF
 * inside a cell) is all CRLF once it is open, and saving it wrote every cell of several lines anew. Such a file
 * keeps its bare LF inside cells. Another kind of file, or a table whose line ends were not so on disk, is
 * written as it is in the editor; so is one the user has since changed to LF throughout, which has no CRLF left.
 * (So, still, is such a file with more line breaks inside its cells than rows: the editor opens that one as LF
 * throughout, and its text here cannot be told from one the user changed to LF.)
 */
export function tableTextToWrite(path: string, text: string, onDisk: string): string {
	if (!/\.(csv|tsv)$/i.test(path) || !text.includes("\r\n")) return text;
	const prefer = csvDelimiterForPath(path);
	if (!csvHasBareCellBreaks(onDisk, csvDelimiterOf(onDisk, prefer))) return text;
	return csvCellBreaksToLf(text, csvDelimiterOf(text, prefer));
}
