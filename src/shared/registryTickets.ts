import { columnOf, type Table } from "./csv";
import { toneOf } from "./projectDocs";

// A registry row can say which ticket carries it: a "ticket" column, with
// the ticket's key. The ticket's page then lists what it has to bring
// across, and how much of that has come.

/** The rows a registry has for one ticket: how many, and how many of them are done; `done` is absent when the registry has no status column. */
export type RowsFor = { key: string; rows: number; done?: number };

/** Where a registry names tickets: its "ticket" column, or "tickets"; -1 when it has neither. */
export function ticketColumn(table: Pick<Table, "header">): number {
	const one = columnOf(table, "ticket");
	return one >= 0 ? one : columnOf(table, "tickets");
}

/**
 * A word as a ticket's key, when it is written as one: "DEMO-12", or a
 * number, with or without its mark ("#12" is ticket 12). "" for any other
 * word: "n/a", "TBD" and "-" are what a person writes where there is none.
 */
export const keyOf = (word: string) => (/^[A-Za-z][A-Za-z0-9_]*-\d+$/.test(word) ? word : /^#?\d+$/.test(word) ? word.replace(/^#/, "") : "");

/** The keys a cell names: one, or several apart by spaces, commas or semicolons. Words that are not keys are passed over. */
export const keysIn = (cell: string) => cell.split(/[\s,;]+/).map(keyOf).filter(Boolean);

/** The tickets a registry's rows name, in the order they first appear, each with its rows. A key is the same key in any case. */
export function rowsByTicket(table: Table): RowsFor[] {
	const at = ticketColumn(table);
	if (at < 0) return [];
	const status = columnOf(table, "status");
	const found = new Map<string, RowsFor>();
	for (const row of table.rows) {
		const done = status >= 0 && toneOf(row[status]?.text) === "done";
		for (const key of new Set(keysIn(row[at]?.text ?? "").map((key) => key.toLowerCase()))) {
			const written = keysIn(row[at]!.text).find((word) => word.toLowerCase() === key)!;
			const entry = found.get(key) ?? { key: written, rows: 0, ...(status >= 0 ? { done: 0 } : {}) };
			entry.rows++;
			if (done) entry.done = (entry.done ?? 0) + 1;
			found.set(key, entry);
		}
	}
	return [...found.values()];
}

/** A ticket's rows in a line: "3 rows, 1 done". */
export function rowsLine(rows: RowsFor): string {
	return `${rows.rows} ${rows.rows === 1 ? "row" : "rows"}${rows.done === undefined ? "" : `, ${rows.done} done`}`;
}
