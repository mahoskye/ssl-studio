// Pure GFM Markdown pipe-table engine (Obsidian Advanced Tables parity).
// Zero DOM or editor dependencies — every operation is a deterministic transformation
// of plain Markdown lines so every edit remains undoable plain text (ADR 0002).
import { scanQuotePrefix } from "./codeTokens";

export type TableAlign = "none" | "left" | "center" | "right";

export type MarkdownTable = {
	/** 0-based inclusive start line index in the document. */
	startLine: number;
	/** 0-based inclusive end line index in the document. */
	endLine: number;
	/** Leading indentation / optional blockquote prefix preserved on every table line. */
	prefix: string;
	/** Column alignments parsed from the delimiter row. */
	alignments: TableAlign[];
	/** Normalized rows: row 0 is the header, rows 1..N are body rows. */
	rows: string[][];
	/**
	 * The cells a row has beyond the header's columns, by row (`extra[r]` belongs to `rows[r]`); not set when no
	 * row has any. GFM draws a table without them, but they are text of the file: `rows` alone held the header's
	 * count of cells for each row, and a table written back from it had lost the rest.
	 */
	extra?: string[][];
};

export type TableEdit = {
	/** 0-based inclusive start line index to replace. */
	startLine: number;
	/** 0-based inclusive end line index to replace. */
	endLine: number;
	/** Replacement Markdown text for lines [startLine..endLine]. */
	text: string;
	/** Resulting formatted lines (same as `text.split("\n")`). */
	lines: string[];
	/** Target logical row index (0 = header, 1+ = body) to focus after edit. */
	focusRow: number;
	/** Target column index (0-based) to focus after edit. */
	focusCol: number;
	/** Select the cell's text when true, otherwise place cursor at cell text end. */
	selectCell?: boolean;
};

const DELIM_CELL = /^:?-{1,}:?$/;

/** True when `str[i]` is `|` preceded by an even number of backslashes (GFM §4.10 unescaped pipe). */
function isUnescapedPipe(str: string, i: number, minIdx = 0): boolean {
	if (str[i] !== "|") return false;
	let bs = 0;
	for (let k = i - 1; k >= minIdx && str[k] === "\\"; k--) bs++;
	return bs % 2 === 0;
}

/** Splits a single Markdown pipe-table row into trimmed cell texts per GFM §4.10 (splitting on unescaped `|`, honoring `\|` everywhere including inside backticks). */
export function splitTableRow(rawLine: string, prefix = ""): string[] | null {
	const stripped = prefix && rawLine.startsWith(prefix) ? rawLine.slice(prefix.length) : rawLine;
	const trimmed = stripped.trim();
	if (!trimmed.includes("|")) return null;

	const cells: string[] = [];
	let cur = "";

	// Strip optional leading and trailing unescaped pipes.
	let start = 0;
	let end = trimmed.length;
	if (trimmed[start] === "|") start++;
	if (end > start && isUnescapedPipe(trimmed, end - 1, start)) end--;

	for (let i = start; i < end; i++) {
		if (isUnescapedPipe(trimmed, i, start)) {
			cells.push(cur.trim());
			cur = "";
			continue;
		}
		cur += trimmed[i]!;
	}
	cells.push(cur.trim());
	return cells;
}

/** Parses a GFM delimiter row (`| --- | :---: | ---: |`) into alignments, or null if not a delimiter row. */
export function parseDelimiterRow(rawLine: string, prefix = ""): TableAlign[] | null {
	const cells = splitTableRow(rawLine, prefix);
	if (!cells || cells.length === 0) return null;
	// Require at least one pipe-bounded cell or 2+ columns with valid dash markers.
	const stripped = (prefix && rawLine.startsWith(prefix) ? rawLine.slice(prefix.length) : rawLine).trim();
	if (cells.length === 1 && !(stripped.startsWith("|") && stripped.endsWith("|"))) return null;
	const aligns: TableAlign[] = [];
	for (const cell of cells) {
		const c = cell.replace(/\s+/g, "");
		if (!DELIM_CELL.test(c)) return null;
		const left = c.startsWith(":");
		const right = c.endsWith(":");
		aligns.push(left && right ? "center" : right ? "right" : left ? "left" : "none");
	}
	return aligns;
}

function linePrefix(line: string): string {
	const { offset } = scanQuotePrefix(line);
	let end = offset;
	while (end < line.length && (line[end] === " " || line[end] === "\t")) end++;
	return line.slice(0, end);
}

function looksLikeTableLine(line: string, prefix: string): boolean {
	const stripped = prefix ? (line.startsWith(prefix) ? line.slice(prefix.length) : null) : line;
	if (stripped === null) return false;
	const t = stripped.trim();
	return Boolean(t) && t.includes("|");
}

/**
 * Detects whether `cursorLine` (0-based) sits inside a valid GFM pipe table
 * (header + delimiter + optional body rows) and returns the parsed table.
 */
export function parseMarkdownTable(lines: readonly string[], cursorLine: number): MarkdownTable | null {
	if (cursorLine < 0 || cursorLine >= lines.length) return null;
	const curText = lines[cursorLine]!;
	const prefix = linePrefix(curText);
	if (!looksLikeTableLine(curText, prefix)) return null;

	// Walk upwards to find the top contiguous pipe-containing line with the same prefix.
	let start = cursorLine;
	while (start > 0 && looksLikeTableLine(lines[start - 1]!, prefix)) start--;
	// Walk downwards to find the bottom contiguous pipe-containing line.
	let end = cursorLine;
	while (end + 1 < lines.length && looksLikeTableLine(lines[end + 1]!, prefix)) end++;

	if (end - start < 1) return null;

	// Locate the delimiter row (normally `start + 1`, or allow finding within contiguous block).
	let headerIdx = -1;
	let aligns: TableAlign[] | null = null;
	for (let i = start + 1; i <= end; i++) {
		const parsed = parseDelimiterRow(lines[i]!, prefix);
		if (parsed) {
			headerIdx = i - 1;
			aligns = parsed;
			break;
		}
	}
	if (headerIdx < 0 || !aligns) return null;
	if (cursorLine < headerIdx) return null;
	start = headerIdx;

	const headerCells = splitTableRow(lines[start]!, prefix);
	if (!headerCells || headerCells.length === 0) return null;

	const colCount = Math.max(headerCells.length, aligns.length);
	const normalize = (cells: string[]): string[] => {
		const out = cells.slice(0, colCount);
		while (out.length < colCount) out.push("");
		return out;
	};
	const alignments = aligns.slice(0, colCount);
	while (alignments.length < colCount) alignments.push("none");

	const rows: string[][] = [normalize(headerCells)];
	const extra: string[][] = [[]];
	for (let i = start + 2; i <= end; i++) {
		const rowCells = splitTableRow(lines[i]!, prefix);
		if (!rowCells) {
			end = i - 1;
			break;
		}
		rows.push(normalize(rowCells));
		extra.push(rowCells.slice(colCount));
	}

	if (cursorLine > end) return null;
	return { startLine: start, endLine: end, prefix, alignments, rows, ...(extra.some((cells) => cells.length) ? { extra } : {}) };
}

/**
 * Given a raw table line and 0-based character column offset, returns the 0-based
 * table cell index (`col`) that the cursor sits inside.
 */
export function locateTableCell(lineText: string, colOffset: number, colCount: number, prefix = ""): number {
	const startIdx = prefix && lineText.startsWith(prefix) ? prefix.length : 0;
	const trimmedStart = startIdx + (/^[ \t]*/.exec(lineText.slice(startIdx))?.[0].length ?? 0);
	const hasLeadingPipe = lineText[trimmedStart] === "|";

	let cell = 0;
	let seenFirstPipe = false;

	for (let i = trimmedStart; i < lineText.length && i < colOffset; i++) {
		if (isUnescapedPipe(lineText, i, trimmedStart)) {
			if (hasLeadingPipe && !seenFirstPipe) {
				seenFirstPipe = true;
			} else {
				cell++;
			}
		}
	}
	return Math.max(0, Math.min(colCount - 1, cell));
}

/** Converts a 0-based document line index inside `table` to a logical row index (`0` = header, `1+` = body, `-1` = delimiter). */
export function docLineToTableRow(table: MarkdownTable, docLine: number): number {
	if (docLine === table.startLine) return 0;
	if (docLine === table.startLine + 1) return -1;
	return Math.max(1, Math.min(table.rows.length - 1, docLine - table.startLine - 1));
}

/** Converts a logical row index (`0` = header, `1+` = body) to its 0-based document line index. */
export function tableRowToDocLine(table: Pick<MarkdownTable, "startLine">, rowIdx: number): number {
	return rowIdx <= 0 ? table.startLine : table.startLine + rowIdx + 1;
}

/** Formats a `MarkdownTable` cleanly with padded columns and alignment markers. */
export function formatTableLines(table: MarkdownTable): string[] {
	const cols = table.alignments.length;
	const widths: number[] = Array.from({ length: cols }, (_, c) => {
		const align = table.alignments[c] ?? "none";
		let max = align === "center" ? 5 : align === "left" || align === "right" ? 4 : 3;
		for (const row of table.rows) {
			max = Math.max(max, (row[c] ?? "").length);
		}
		return max;
	});

	// A row's cells beyond the header's columns follow its last column as they were written, unpadded: they
	// belong to no column. They were left out, so every action that writes the table again (a cell edited, Tab,
	// a row added, Format) deleted them from rows the user had not touched.
	const renderRow = (cells: string[], extra: readonly string[] = []): string => {
		const parts: string[] = widths.map((w, c) => {
			const val = cells[c] ?? "";
			const align = table.alignments[c] ?? "none";
			const pad = Math.max(0, w - val.length);
			if (align === "right") return `${" ".repeat(pad)}${val}`;
			if (align === "center") {
				const leftPad = Math.floor(pad / 2);
				return `${" ".repeat(leftPad)}${val}${" ".repeat(pad - leftPad)}`;
			}
			return `${val}${" ".repeat(pad)}`;
		});
		return `${table.prefix}| ${[...parts, ...extra].join(" | ")} |`;
	};

	const renderDelim = (): string => {
		const parts = widths.map((w, c) => {
			const align = table.alignments[c] ?? "none";
			if (align === "center") return `:${"-".repeat(Math.max(3, w - 2))}:`;
			if (align === "left") return `:${"-".repeat(Math.max(3, w - 1))}`;
			if (align === "right") return `${"-".repeat(Math.max(3, w - 1))}:`;
			return "-".repeat(Math.max(3, w));
		});
		return `${table.prefix}| ${parts.join(" | ")} |`;
	};

	const out: string[] = [renderRow(table.rows[0] ?? []), renderDelim()];
	for (let r = 1; r < table.rows.length; r++) out.push(renderRow(table.rows[r]!, table.extra?.[r]));
	return out;
}

/**
 * Returns the 0-based `[from, to]` character range inside a single formatted table line
 * corresponding to the trimmed text of cell `colIdx` (or the cell's insertion point if empty).
 */
export function cellRangeInLine(lineText: string, colIdx: number, prefix = ""): { from: number; to: number } {
	const startIdx = prefix && lineText.startsWith(prefix) ? prefix.length : 0;
	const trimmedStart = startIdx + (/^[ \t]*/.exec(lineText.slice(startIdx))?.[0].length ?? 0);
	const hasLeadingPipe = lineText[trimmedStart] === "|";
	const pipePositions: number[] = [];

	for (let i = trimmedStart; i < lineText.length; i++) {
		if (isUnescapedPipe(lineText, i, trimmedStart)) pipePositions.push(i);
	}

	let rawStart: number;
	let rawEnd: number;
	if (hasLeadingPipe) {
		rawStart = colIdx < pipePositions.length ? pipePositions[colIdx]! + 1 : lineText.length;
		rawEnd = pipePositions[colIdx + 1] ?? lineText.length;
	} else {
		rawStart = colIdx === 0 ? trimmedStart : colIdx - 1 < pipePositions.length ? pipePositions[colIdx - 1]! + 1 : lineText.length;
		rawEnd = pipePositions[colIdx] ?? lineText.length;
	}
	const slice = lineText.slice(rawStart, rawEnd);
	const trimmed = slice.trim();
	if (!trimmed) {
		// Place cursor one space after opening pipe (`| |`) if available.
		const pos = rawStart < rawEnd && lineText[rawStart] === " " ? rawStart + 1 : rawStart;
		return { from: pos, to: pos };
	}
	const lead = slice.indexOf(trimmed);
	return { from: rawStart + lead, to: rawStart + lead + trimmed.length };
}

/** Returns the `[from, to]` character offset within `edit.text` for `(edit.focusRow, edit.focusCol)`. */
export function focusRangeInTableEdit(edit: TableEdit, prefix = ""): { from: number; to: number } {
	const lineIdx = edit.focusRow <= 0 ? 0 : Math.min(edit.lines.length - 1, edit.focusRow + 1);
	let lineStart = 0;
	for (let i = 0; i < lineIdx; i++) lineStart += edit.lines[i]!.length + 1;
	const cell = cellRangeInLine(edit.lines[lineIdx]!, edit.focusCol, prefix);
	if (edit.selectCell) return { from: lineStart + cell.from, to: lineStart + cell.to };
	return { from: lineStart + cell.to, to: lineStart + cell.to };
}

function makeEdit(table: MarkdownTable, focusRow: number, focusCol: number, selectCell = false): TableEdit {
	const lines = formatTableLines(table);
	return {
		startLine: table.startLine,
		endLine: table.endLine,
		lines,
		text: lines.join("\n"),
		focusRow: Math.max(0, Math.min(table.rows.length - 1, focusRow)),
		focusCol: Math.max(0, Math.min(table.alignments.length - 1, focusCol)),
		selectCell,
	};
}

function cloneTable(table: MarkdownTable): MarkdownTable {
	return {
		...table,
		alignments: [...table.alignments],
		rows: table.rows.map((r) => [...r]),
		...(table.extra ? { extra: table.extra.map((cells) => [...cells]) } : {}),
	};
}

/**
 * Adds, removes or reorders rows, each with the cells it has beyond the header's columns: those are the row's
 * own text and go where the row goes. (A column added, removed or moved leaves them where they are, after the
 * row's last column: they belong to no column.)
 */
function editRows(table: MarkdownTable, edit: (rows: { cells: string[]; extra: string[] }[]) => void): void {
	const paired = table.rows.map((cells, r) => ({ cells, extra: table.extra?.[r] ?? [] }));
	edit(paired);
	table.rows = paired.map((row) => row.cells);
	if (table.extra) table.extra = paired.map((row) => row.extra);
}

/** Parses a raw Markdown table string directly into a `MarkdownTable` (0-based line indices). */
export function parseTableRaw(raw: string): MarkdownTable | null {
	const lines = raw.replace(/\r\n/g, "\n").split("\n");
	return parseMarkdownTable(lines, 0);
}

/** Converts a raw GFM cell string into comfortable multi-line editor text (`<br>` → newline, `\|` → `|`). */
export function cellValueForEdit(rawCell: string): string {
	return rawCell
		.replace(/<br\s*\/?>/gi, "\n")
		.replace(/\\\|/g, "|");
}

/** Serializes edited cell text safely back into a single GFM table cell (newlines → `<br>`, every unescaped `|` → `\|`, including inside inline code per GFM §4.10). */
export function serializeTableCell(edited: string): string {
	const singleLine = edited.replace(/\r\n/g, "\n").replace(/\n/g, "<br>").trim();
	let out = "";
	for (let i = 0; i < singleLine.length; i++) {
		if (isUnescapedPipe(singleLine, i, 0)) {
			out += "\\|";
		} else {
			out += singleLine[i]!;
		}
	}
	return out;
}

/** Updates a single cell `(row, col)` in `table` and returns the cleanly formatted `TableEdit`. */
export function updateTableCell(table: MarkdownTable, row: number, col: number, value: string): TableEdit {
	const next = cloneTable(table);
	if (row >= 0 && row < next.rows.length && col >= 0 && col < next.alignments.length) {
		next.rows[row]![col] = serializeTableCell(value);
	}
	return makeEdit(next, Math.max(0, row), Math.max(0, col), false);
}

/** One cell's change as a change of text: `from` and `to` are offsets in the table as it is written. */
export type TableCellTextEdit = { from: number; to: number; insert: string };

/**
 * The edit of one cell `(row, col)` as a change of that cell's own text in `raw`, the table as it is written
 * (`table` is `raw` parsed, see `parseTableRaw`); null when the cell already says `value`.
 *
 * The live table wrote the whole table again, padded, for every letter typed in a cell (`updateTableCell`): the
 * lines the user was not in were rewritten with it, and what a rewrite does not carry was gone from them. Here
 * nothing but the cell is touched: every other line, and the rest of its own line, stays byte for byte.
 *
 * - A cell the row does not have (it is shorter than the header) is written after the row's last cell, with the
 *   empty cells between; nothing is written for it while it is empty.
 * - A value that ends in a backslash gets a space before a pipe that follows it directly, or the backslash would
 *   escape that pipe and join the cell to the next.
 * - The first cell of a row written without a leading pipe is emptied by writing that pipe: left bare, the
 *   row's first separator would be read as one and every cell would move a column to the left.
 */
export function tableCellTextEdit(raw: string, table: MarkdownTable, row: number, col: number, value: string): TableCellTextEdit | null {
	if (row < 0 || row >= table.rows.length || col < 0 || col >= table.alignments.length) return null;
	const lines = raw.split("\n");
	const lineIdx = row === 0 ? 0 : row + 1;
	const lineText = lines[lineIdx];
	if (lineText === undefined) return null;
	let lineStart = 0;
	for (let i = 0; i < lineIdx; i++) lineStart += lines[i]!.length + 1;
	const text = serializeTableCell(value);
	const rowStart = table.prefix && lineText.startsWith(table.prefix) ? table.prefix.length : 0;
	const contentStart = rowStart + (/^[ \t]*/.exec(lineText.slice(rowStart))?.[0].length ?? 0);
	const written = splitTableRow(lineText, table.prefix)?.length ?? 0;

	if (col >= written) {
		if (!text) return null;
		// Before what ends the line (spaces, and the `\r` of a table read with its CRLF line ends).
		const end = lineText.trimEnd().length;
		const closed = end - 1 > contentStart && isUnescapedPipe(lineText, end - 1, contentStart);
		const between = "  |".repeat(col - written);
		const at = lineStart + end;
		return { from: at, to: at, insert: closed ? `${between} ${text} |` : ` |${between} ${text}` };
	}

	const cell = cellRangeInLine(lineText, col, table.prefix);
	if (lineText.slice(cell.from, cell.to) === text) return null;
	let insert = text;
	if (!text && col === 0 && lineText[contentStart] !== "|") insert = "|";
	else if (text.endsWith("\\") && lineText[cell.to] === "|") insert = `${text} `;
	return { from: lineStart + cell.from, to: lineStart + cell.to, insert };
}

/** Formats the table cleanly while keeping cursor in `(row, col)`. */
export function formatTable(table: MarkdownTable, row: number, col: number): TableEdit {
	return makeEdit(cloneTable(table), Math.max(0, row), col, false);
}

/** `Tab` / `Shift+Tab` cell navigation. Moving past the last cell automatically appends a new row. */
export function stepTableCell(table: MarkdownTable, row: number, col: number, dir: 1 | -1): TableEdit {
	const next = cloneTable(table);
	const cols = next.alignments.length;
	const curRow = row < 0 ? 1 : row;
	if (dir === 1) {
		if (col + 1 < cols) return makeEdit(next, curRow, col + 1, true);
		if (curRow + 1 < next.rows.length) return makeEdit(next, curRow + 1, 0, true);
		// At the very last cell: append a new empty body row.
		next.rows.push(Array.from({ length: cols }, () => ""));
		return makeEdit(next, next.rows.length - 1, 0, true);
	}
	if (col > 0) return makeEdit(next, curRow, col - 1, true);
	if (curRow > 0) return makeEdit(next, curRow - 1, cols - 1, true);
	return makeEdit(next, 0, 0, true);
}

/** `Enter` inside a table: formats and advances to the same column in the next row (appending one if on the last row). */
export function enterTableRow(table: MarkdownTable, row: number, col: number): TableEdit {
	const next = cloneTable(table);
	const curRow = row < 0 ? 0 : row;
	if (curRow + 1 < next.rows.length) return makeEdit(next, curRow + 1, col, true);
	next.rows.push(Array.from({ length: next.alignments.length }, () => ""));
	return makeEdit(next, next.rows.length - 1, col, true);
}

/** Inserts an empty row above or below `row` (header row 0 always stays on top). */
export function insertTableRow(table: MarkdownTable, row: number, where: "above" | "below"): TableEdit {
	const next = cloneTable(table);
	const empty = Array.from({ length: next.alignments.length }, () => "");
	const curRow = row < 0 ? 0 : row;
	let insertAt: number;
	if (curRow === 0) {
		// Cannot insert above header row; both "above" and "below" on header insert as first body row.
		insertAt = 1;
	} else {
		insertAt = where === "above" ? curRow : curRow + 1;
	}
	editRows(next, (rows) => rows.splice(insertAt, 0, { cells: empty, extra: [] }));
	return makeEdit(next, insertAt, 0, true);
}

/** Deletes body row `row`. Header row 0 cannot be deleted (returns null). */
export function deleteTableRow(table: MarkdownTable, row: number, col: number): TableEdit | null {
	if (row <= 0 || row >= table.rows.length) return null;
	const next = cloneTable(table);
	editRows(next, (rows) => rows.splice(row, 1));
	const focusRow = Math.min(row, next.rows.length - 1);
	return makeEdit(next, focusRow, col, false);
}

/** Moves body row `row` up (-1) or down (+1). Cannot cross above header row 0. */
export function moveTableRow(table: MarkdownTable, row: number, col: number, dir: -1 | 1): TableEdit | null {
	if (row <= 0 || row >= table.rows.length) return null;
	const target = row + dir;
	if (target < 1 || target >= table.rows.length) return null;
	const next = cloneTable(table);
	editRows(next, (rows) => {
		const tmp = rows[row]!;
		rows[row] = rows[target]!;
		rows[target] = tmp;
	});
	return makeEdit(next, target, col, false);
}

/** Inserts a new empty column left or right of `col`. */
export function insertTableColumn(table: MarkdownTable, row: number, col: number, where: "left" | "right"): TableEdit {
	const next = cloneTable(table);
	const insertAt = where === "left" ? Math.max(0, col) : Math.min(next.alignments.length, col + 1);
	next.alignments.splice(insertAt, 0, "none");
	for (let r = 0; r < next.rows.length; r++) {
		next.rows[r]!.splice(insertAt, 0, r === 0 ? "Column" : "");
	}
	return makeEdit(next, Math.max(0, row), insertAt, true);
}

/** Deletes column `col`. Keeps at least one column (returns null when table has only 1 column). */
export function deleteTableColumn(table: MarkdownTable, row: number, col: number): TableEdit | null {
	if (table.alignments.length <= 1 || col < 0 || col >= table.alignments.length) return null;
	const next = cloneTable(table);
	next.alignments.splice(col, 1);
	for (const r of next.rows) r.splice(col, 1);
	return makeEdit(next, Math.max(0, row), Math.min(col, next.alignments.length - 1), false);
}

/** Moves column `col` left (-1) or right (+1). */
export function moveTableColumn(table: MarkdownTable, row: number, col: number, dir: -1 | 1): TableEdit | null {
	const target = col + dir;
	if (col < 0 || col >= table.alignments.length || target < 0 || target >= table.alignments.length) return null;
	const next = cloneTable(table);
	const tmpAlign = next.alignments[col]!;
	next.alignments[col] = next.alignments[target]!;
	next.alignments[target] = tmpAlign;
	for (const r of next.rows) {
		const tmp = r[col]!;
		r[col] = r[target]!;
		r[target] = tmp;
	}
	return makeEdit(next, Math.max(0, row), target, false);
}

/** Sets alignment (`left` / `center` / `right`) on column `col`. */
export function setTableAlignment(table: MarkdownTable, row: number, col: number, align: TableAlign): TableEdit {
	const next = cloneTable(table);
	if (col >= 0 && col < next.alignments.length) next.alignments[col] = align;
	return makeEdit(next, Math.max(0, row), col, false);
}

/** Sorts body rows (keeping header fixed) by column `col`, numeric-aware. */
export function sortTableByColumn(table: MarkdownTable, row: number, col: number, dir: "asc" | "desc"): TableEdit {
	const next = cloneTable(table);
	if (next.rows.length <= 2) return makeEdit(next, Math.max(0, row), col, false);
	const strip = (s: string) => s.replace(/[`*_~[\]]/g, "").trim();
	editRows(next, (rows) => {
		const body = rows.splice(1);
		body.sort((a, b) => {
			const av = strip(a.cells[col] ?? "");
			const bv = strip(b.cells[col] ?? "");
			const cmp = av.localeCompare(bv, undefined, { numeric: true, sensitivity: "base" });
			return dir === "asc" ? cmp : -cmp;
		});
		rows.push(...body);
	});
	return makeEdit(next, Math.max(0, row), col, false);
}

/** Builds a clean starter GFM table with `cols` columns and `bodyRows` empty body rows. */
export function createEmptyTable(cols = 3, bodyRows = 2): { text: string; cursorOffset: number } {
	const c = Math.max(1, Math.min(8, cols));
	const r = Math.max(1, Math.min(20, bodyRows));
	const headers = Array.from({ length: c }, (_, i) => `Column ${i + 1}`);
	const table: MarkdownTable = {
		startLine: 0,
		endLine: r + 1,
		prefix: "",
		alignments: Array.from({ length: c }, () => "none"),
		rows: [headers, ...Array.from({ length: r }, () => Array.from({ length: c }, () => ""))],
	};
	const lines = formatTableLines(table);
	const text = lines.join("\n");
	const first = cellRangeInLine(lines[0]!, 0);
	return { text, cursorOffset: first.from };
}
