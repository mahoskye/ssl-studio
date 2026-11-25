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

function detectCsvDelimiter(text: string, bomOffset: number, prefer?: CsvDelimiter): CsvDelimiter {
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

/**
 * Reorders every row's columns in `text` according to `newOrder` (where
 * `newOrder[newIdx] = oldIdx`). Preserves each cell's raw source text
 * verbatim (including quoting and embedded line breaks), line endings, blank
 * lines, and any extra ragged trailing cells without dropping data (ADR 0002).
 * Returns `null` when `newOrder` is invalid or already the natural order.
 */
export function reorderCsvColumns(text: string, table: Table, newOrder: readonly number[]): string | null {
	const count = table.header.length;
	if (count < 2 || newOrder.length !== count) return null;
	const seen = new Set<number>();
	for (const col of newOrder) {
		if (!Number.isInteger(col) || col < 0 || col >= count || seen.has(col)) return null;
		seen.add(col);
	}
	if (newOrder.every((col, idx) => col === idx)) return null;

	const allRows: Cell[][] = table.hasHeader === false ? table.rows : [table.header, ...table.rows];
	let out = "";
	let cursor = 0;
	for (const cells of allRows) {
		if (!cells.length) continue;
		const rowStart = cells[0]!.start;
		const rowEnd = cells[cells.length - 1]!.end;
		out += text.slice(cursor, rowStart);
		const parts: string[] = [];
		for (const oldCol of newOrder) {
			const cell = cells[oldCol];
			parts.push(cell ? text.slice(cell.start, cell.end) : "");
		}
		// Keep any extra ragged cells past the header width rather than dropping data.
		for (let extra = count; extra < cells.length; extra++) {
			const cell = cells[extra]!;
			parts.push(text.slice(cell.start, cell.end));
		}
		out += parts.join(table.delimiter);
		cursor = rowEnd;
	}
	out += text.slice(cursor);
	return out;
}

/**
 * Appends a new column to the header and every row in `text`, preserving existing
 * cells verbatim and padding short ragged rows so the new cell aligns cleanly (ADR 0002).
 */
export function addCsvColumn(text: string, table: Table, name: string, defaultValue = ""): string | null {
	const trimmed = name.trim();
	if (!trimmed || !table.header.length) return null;
	const count = table.header.length;
	const headerless = table.hasHeader === false;
	const allRows: Cell[][] = headerless ? table.rows : [table.header, ...table.rows];
	let out = "";
	let cursor = 0;
	for (let r = 0; r < allRows.length; r++) {
		const cells = allRows[r]!;
		if (!cells.length) continue;
		const isHeaderRow = !headerless && r === 0;
		const isLongRagged = !isHeaderRow && cells.length > count;
		const insertAt = isLongRagged ? cells[count - 1]!.end : cells[cells.length - 1]!.end;
		out += text.slice(cursor, insertAt);
		const padCount = isHeaderRow ? 0 : Math.max(0, count - cells.length);
		const value = isHeaderRow ? trimmed : defaultValue;
		// The first row is the first record with or without a header.
		const val = r === 0 ? csvFirstRecordCell(value, table.delimiter) : csvCell(value, table.delimiter);
		out += table.delimiter.repeat(padCount + 1) + val;
		cursor = insertAt;
	}
	out += text.slice(cursor);
	return out;
}

/** Renames a single column header cell in `text`, touching nothing else (ADR 0002). */
export function renameCsvColumn(text: string, table: Table, colIdx: number, newName: string): string | null {
	if (table.hasHeader === false) return null;
	const trimmed = newName.trim();
	const cell = table.header[colIdx];
	if (!trimmed || !cell) return null;
	if (cell.text === trimmed) return null;
	return text.slice(0, cell.start) + csvFirstRecordCell(trimmed, table.delimiter) + text.slice(cell.end);
}

/**
 * Deletes column `colIdx` from the header and every row in `text` while keeping
 * every remaining cell's exact raw quoting and formatting untouched (ADR 0002).
 */
export function deleteCsvColumn(text: string, table: Table, colIdx: number): string | null {
	const count = table.header.length;
	if (count < 2 || colIdx < 0 || colIdx >= count) return null;
	const allRows: Cell[][] = table.hasHeader === false ? table.rows : [table.header, ...table.rows];
	let out = "";
	let cursor = 0;
	for (const cells of allRows) {
		if (!cells.length) continue;
		const rowStart = cells[0]!.start;
		const rowEnd = cells[cells.length - 1]!.end;
		out += text.slice(cursor, rowStart);
		const kept: string[] = [];
		for (let i = 0; i < cells.length; i++) {
			if (i === colIdx) continue;
			const c = cells[i]!;
			kept.push(text.slice(c.start, c.end));
		}
		// If deleting column `colIdx` leaves zero cells or a single empty unquoted cell,
		// emit `""` so the row isn't silently dropped as a blank line on re-parse.
		out += kept.length === 0 || (kept.length === 1 && kept[0] === "") ? '""' : kept.join(table.delimiter);
		cursor = rowEnd;
	}
	out += text.slice(cursor);
	return out;
}

/**
 * Rewrites data rows in `rowOrder` (`rowOrder[newIdx] = oldRowIdx`), preserving
 * header, line endings, and every row's exact raw source text verbatim (ADR 0002).
 */
export function sortCsvRows(text: string, table: Table, rowOrder: readonly number[]): string | null {
	const count = table.rows.length;
	if (count < 2 || rowOrder.length !== count) return null;
	const seen = new Set<number>();
	for (const r of rowOrder) {
		if (!Number.isInteger(r) || r < 0 || r >= count || seen.has(r)) return null;
		seen.add(r);
	}
	if (rowOrder.every((r, idx) => r === idx)) return null;
	const rawRows = table.rows.map((_, idx) => rawRowText(text, table, idx) ?? "");
	const firstRow = table.rows[0]!;
	const lastRow = table.rows[count - 1]!;
	const nl = text.includes("\r\n") ? "\r\n" : "\n";
	const start = firstRow[0]!.start;
	const end = lastRow[lastRow.length - 1]!.end;
	return text.slice(0, start) + rowOrder.map((idx) => rawRows[idx]!).join(nl) + text.slice(end);
}

/**
 * Moves data row `fromRow` to `toRow`, preserving header, line endings, and every
 * row's exact raw source text verbatim (ADR 0002). Returns `text` unchanged when
 * indices are out of bounds or identical.
 */
export function moveCsvRow(text: string, table: CsvTable, fromRow: number, toRow: number): string {
	const count = table.rows.length;
	if (
		count < 2 ||
		!Number.isInteger(fromRow) ||
		!Number.isInteger(toRow) ||
		fromRow < 0 ||
		fromRow >= count ||
		toRow < 0 ||
		toRow >= count ||
		fromRow === toRow
	) {
		return text;
	}
	const rowOrder = Array.from({ length: count }, (_, idx) => idx);
	const [moved] = rowOrder.splice(fromRow, 1);
	rowOrder.splice(toRow, 0, moved!);
	return sortCsvRows(text, table, rowOrder) ?? text;
}

/**
 * Converts `text` from `table.delimiter` to `nextDelimiter`, re-quoting cells only
 * as required by `nextDelimiter` while preserving BOM, blank lines, and line endings.
 */
export function convertCsvDelimiter(text: string, table: CsvTable, nextDelimiter: CsvDelimiter): string {
	if (table.delimiter === nextDelimiter) return text;
	const allRows: Cell[][] = table.hasHeader === false ? table.rows : [table.header, ...table.rows];
	let out = "";
	let cursor = 0;
	// The first record's cells are quoted when they hold any delimiter, not only the new one: a comma left bare
	// there (`id<tab>Last, First`) makes the file a comma-separated one to whatever reads it next.
	let first = true;
	for (const cells of allRows) {
		if (!cells.length) continue;
		const rowStart = cells[0]!.start;
		const rowEnd = cells[cells.length - 1]!.end;
		out += text.slice(cursor, rowStart);
		if (cells.length === 1 && cells[0]!.text === "") {
			out += '""';
		} else {
			const written = first ? csvFirstRecordCell : csvCell;
			out += cells.map((c) => written(c.text, nextDelimiter)).join(nextDelimiter);
		}
		first = false;
		cursor = rowEnd;
	}
	out += text.slice(cursor);
	return out;
}

/** Exports tabular headers and rows as tab-separated text for pasting into Excel or Sheets. */
export function tableToTsv(headers: readonly string[], rows: readonly (readonly string[])[]): string {
	const fmt = (row: readonly string[]) => row.map((v) => csvCell(v, "\t")).join("\t");
	return [fmt(headers), ...rows.map(fmt)].join("\n");
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
 * Deletes multiple rows cleanly in one pass without overlapping ranges (even on
 * files with no trailing newline, where deleting both the last row and the row
 * above it would otherwise collide on the separating newline). Preserves every
 * remaining row's raw source text verbatim (ADR 0002).
 */
export function deleteCsvRows(text: string, table: Table, rowIndices: readonly number[]): string | null {
	const count = table.rows.length;
	const unique = [...new Set(rowIndices)].filter((r) => Number.isInteger(r) && r >= 0 && r < count).sort((a, b) => a - b);
	if (!unique.length) return null;
	const spans: { start: number; end: number }[] = [];
	for (const r of unique) {
		const sp = rowSpan(text, table, r);
		if (!sp) continue;
		const prev = spans[spans.length - 1];
		if (prev && sp.start <= prev.end) {
			prev.end = Math.max(prev.end, sp.end);
		} else {
			spans.push({ start: sp.start, end: sp.end });
		}
	}
	if (!spans.length) return null;
	let out = text;
	for (let i = spans.length - 1; i >= 0; i--) {
		const sp = spans[i]!;
		out = out.slice(0, sp.start) + out.slice(sp.end);
	}
	return out;
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
