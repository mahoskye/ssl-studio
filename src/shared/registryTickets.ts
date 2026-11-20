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
 * A word as a ticket's key. The key of a ticket the project has is one
 * however it is written ("LOGIN-REWORK", "T12"). Any other word is one only
 * when it is written the way a ticket system writes keys: capitals, a dash,
 * a number ("DEMO-12", "REL-2024-07"), or all number, with or without its
 * mark ("#12" is ticket 12). "" for any other word: "n/a", "TBD", "utf-8"
 * and "v2.1" are words. The marks a sentence puts round a key are not part
 * of it: "(DEMO-12)." names DEMO-12.
 */
export function keyOf(word: string, known?: ReadonlySet<string>): string {
	const bare = word.replace(/^[(\[{#]+/, "").replace(/[)\]}.,:;!?]+$/, "");
	if (!bare) return "";
	if (known?.has(bare.toLowerCase())) return bare;
	if (/^\d+$/.test(bare)) return bare;
	return /^[A-Z][A-Z0-9_]*-\d[A-Za-z0-9.-]*$/.test(bare) && /[A-Za-z0-9]$/.test(bare) ? bare : "";
}

/** The keys a cell names: one, or several apart by spaces, commas, semicolons or slashes. Words that are not keys are passed over. `known` is the project's tickets, in small letters. */
export const keysIn = (cell: string, known?: ReadonlySet<string>) =>
	cell
		.split(/[\s,;/]+/)
		.map((word) => keyOf(word, known))
		.filter(Boolean);

/** The tickets a registry's rows name, in the order they first appear, each with its rows. A key is the same key in any case. */
export function rowsByTicket(table: Table, known?: ReadonlySet<string>): RowsFor[] {
	const at = ticketColumn(table);
	if (at < 0) return [];
	const status = columnOf(table, "status");
	const found = new Map<string, RowsFor>();
	for (const row of table.rows) {
		const done = status >= 0 && toneOf(row[status]?.text) === "done";
		for (const key of new Set(keysIn(row[at]?.text ?? "", known).map((key) => key.toLowerCase()))) {
			const written = keysIn(row[at]!.text, known).find((word) => word.toLowerCase() === key)!;
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
