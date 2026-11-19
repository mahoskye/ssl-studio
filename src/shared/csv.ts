// A registry is a table of values in a text file: comma-separated, or
// tab-separated, with its columns named in the first row. This reads one with
// each cell's place in the text, so that a table drawn from it can change a
// cell by changing that part of the text and nothing else (ADR 0002).

export type Cell = {
	text: string;
	/** Where the cell is in the source, quotes and all: from `start` up to `end`. */
	start: number;
	end: number;
};
export type Table = {
	delimiter: "," | "\t";
	/** The column names: the first row's cells. */
	header: Cell[];
	rows: Cell[][];
	/** What is wrong with it as a table, in words; empty when nothing is. */
	problems: string[];
};

/** Reads the rows, a quoted cell holding the delimiter, a line end or a doubled quote as itself. Blank lines are passed over. */
export function parseCsv(text: string): Table {
	const firstLine = text.slice(0, text.search(/\r?\n|$/));
	const delimiter = firstLine.includes("\t") && !firstLine.includes(",") ? "\t" : ",";
	const all: Cell[][] = [];
	let row: Cell[] = [];
	let i = 0;
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
	const [header = [], ...rows] = all;
	const problems: string[] = [];
	const names = header.map((c) => c.text.trim());
	if (!names.length) problems.push("It has no first row to name its columns.");
	const blank = names.filter((name) => !name).length;
	if (blank) problems.push(`${blank} ${blank === 1 ? "column has" : "columns have"} no name.`);
	const twice = [...new Set(names.filter((name, at) => name && names.findIndex((other) => other.toLowerCase() === name.toLowerCase()) !== at))];
	if (twice.length) problems.push(`More than one column is named ${twice.join(", ")}.`);
	const ragged = rows.filter((cells) => cells.length !== header.length).length;
	if (ragged) problems.push(`${ragged} ${ragged === 1 ? "row has" : "rows have"} more or fewer cells than there are columns.`);
	return { delimiter, header, rows, problems };
}

/** A value as it is written in a cell: quoted when it holds the delimiter, a quote, a line end, or space at either end. */
export function csvCell(value: string, delimiter: "," | "\t" = ","): string {
	return value.includes(delimiter) || /["\r\n]/.test(value) || value !== value.trim() ? `"${value.replace(/"/g, '""')}"` : value;
}

/** A whole row as a line of text. */
export const csvRow = (values: readonly string[], delimiter: "," | "\t" = ",") => values.map((v) => csvCell(v, delimiter)).join(delimiter);

/** The place of the column of that name, whatever its case; -1 when there is none. */
export const columnOf = (table: Pick<Table, "header">, name: string) => table.header.findIndex((c) => c.text.trim().toLowerCase() === name.toLowerCase());

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
