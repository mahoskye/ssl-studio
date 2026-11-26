// Audit pass 4, low findings in the CSV/TSV table editor that were already on main:
// B3-10 (column and row changes wrote the whole document), B3-4 (an "editing" state with no editor on the page),
// B3-8 (AltGr and Option characters did not start an edit), B3-9 (a running code check stopped without a word)
// and B3-11 (rows spread into a call's arguments).
//
// TableView.tsx is not mounted in any test. Each decision it makes here is a pure function in src/shared, and is
// run below; that the view calls it is held by its source text only, and each such test says so in its name.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createEffect, createMemo, createRoot, createSignal, flush } from "solid-js";
import {
	addCsvColumn,
	addCsvColumnEdits,
	applyCsvEdits,
	convertCsvDelimiter,
	csvCell,
	csvDelimiterForPath,
	csvDelimiterOf,
	csvEditsKeepingDelimiter,
	csvFirstRecordCell,
	deleteCsvColumn,
	deleteCsvColumnEdits,
	deleteCsvRows,
	deleteCsvRowsEdits,
	parseCsv,
	renameCsvColumn,
	renameCsvColumnEdits,
	reorderCsvColumns,
	reorderCsvColumnsEdits,
	type Cell,
	type CsvDelimiter,
	type CsvTextEdit,
	type Table,
} from "../src/shared/csv";
import {
	cellsToMarkdownTable,
	codeCheckStopped,
	columnMoves,
	editorRowReveal,
	generateFillSeries,
	greatest,
	keyActsOnCell,
	pasteFit,
	trackedColumn,
	typedCharacter,
	type KeyOs,
	type TypedKey,
} from "../src/shared/tablePower";

const readSrc = (rel: string) => readFileSync(join(import.meta.dir, rel), "utf8").replace(/\r\n/g, "\n");
const count = (text: string, part: string) => text.split(part).length - 1;

// --- B3-10 ---------------------------------------------------------------------

type Model = { header: string[] | null; rows: string[][] };
const cellsOf = (t: Table): Model => ({ header: t.hasHeader === false ? null : t.header.map((c) => c.text), rows: t.rows.map((r) => r.map((c) => c.text)) });

type Rnd = { next: () => number; int: (n: number) => number; pick: <T>(list: readonly T[]) => T };
function rng(seed: number): Rnd {
	const next = () => (seed = (seed * 1664525 + 1013904223) >>> 0) / 0x100000000;
	const int = (n: number) => Math.floor(next() * n);
	return { next, int, pick: (list) => list[int(list.length)]! };
}

const DELIMS: CsvDelimiter[] = [",", ";", "|", "\t"];
const LETTERS = ["a", "b", "Smith", "John", "x", "1", "22", "é", "😀", "id"];

/** A value: letters, with now and then a space, a delimiter, a quote or a line break in it. */
function value(r: Rnd, plain = false): string {
	let s = "";
	for (let i = r.int(4); i > 0; i--) {
		s += r.next() < (plain ? 1 : 0.6) ? r.pick(LETTERS) : r.pick([" ", ",", ";", "|", "\t", '"', "\n", "\r\n", ", ", "; "]);
	}
	return s;
}

/** One cell as it is written in a file: as a careful writer would, or one of the ways a file is found written. */
function rawCell(r: Rnd, D: CsvDelimiter, first: boolean): string {
	const word = () => value(r, true).trim();
	switch (r.int(first ? 8 : 10)) {
		case 0:
		case 1:
			return word();
		case 2: {
			// A value that needs its quotes.
			const v = value(r);
			return first ? csvFirstRecordCell(v, D) : csvCell(v, D);
		}
		case 3:
			return `"${word()}"`; // quoted without need
		case 4:
			return r.pick([" ", "  "]) + word() + r.pick(["", " "]); // spaces around a bare value
		case 5:
			return `${word() || "a"}"${word()}`; // a stray quote inside a bare value
		case 6:
			return `"${word()}"${word()}`; // text after a closing quote
		case 7:
			return '""';
		case 8:
			// A bare cell holding another file's delimiter (never in the first record, where it would be taken for this file's).
			return `${word()}${r.pick(DELIMS.filter((d) => d !== D))}${word()}`;
		default:
			return `"${value(r).replace(/"/g, '""')}"`; // quoted, whatever it holds
	}
}

type Made = { text: string; path: string; prefer: CsvDelimiter | undefined; hasHeader: boolean; D: CsvDelimiter };

/**
 * A table as a file may hold it: any of the four delimiters, cells written in every way above, LF or CRLF with
 * now and then the other kind or a bare CR, rows with too few or too many cells, blank lines, a BOM, a last line
 * with or without its line end, and once in a while a quote that is never closed. Null when Auto would not read
 * it with the delimiter it was written with.
 */
function makeTable(r: Rnd): Made | null {
	const D = r.pick(DELIMS);
	const path = (D === "\t" && r.next() < 0.5) || r.next() < 0.1 ? "t.tsv" : "t.csv";
	const prefer = csvDelimiterForPath(path);
	const hasHeader = r.next() < 0.6;
	const cols = 1 + r.int(4);
	const eol = r.next() < 0.35 ? "\r\n" : "\n";
	const records = 1 + r.int(6) + (hasHeader ? 1 : 0);
	let text = (r.next() < 0.1 ? "﻿" : "") + (r.next() < 0.1 ? eol : "");
	for (let i = 0; i < records; i++) {
		const ragged = i > 0 && r.next() < 0.25;
		const n = ragged ? 1 + r.int(cols + 2) : cols;
		text += Array.from({ length: n }, () => rawCell(r, D, i === 0)).join(D);
		const last = i === records - 1;
		if (last && r.next() < 0.04) text += `${D}"left open${r.next() < 0.5 ? D : ""}x`;
		if (!last || r.next() < 0.75) {
			text += r.next() < 0.85 ? eol : r.pick(["\n", "\r\n", "\r"]);
			if (r.next() < 0.12) text += r.pick([eol, "\n", "\r\n"]);
		}
	}
	return csvDelimiterOf(text, prefer) === D ? { text, path, prefer, hasHeader, D } : null;
}

type Rec = { cells: Cell[]; start: number; end: number; row: number };
/** The records in the order they stand in the text, each with the place of its cells; `row` is -1 for the header. */
function recordsOf(t: Table): Rec[] {
	const out: Rec[] = [];
	if (t.hasHeader !== false && t.header.length) out.push({ cells: t.header, start: t.header[0]!.start, end: t.header.at(-1)!.end, row: -1 });
	t.rows.forEach((cells, row) => cells.length && out.push({ cells, start: cells[0]!.start, end: cells.at(-1)!.end, row }));
	return out;
}

/** Whether an edit writes inside the place from `start` to `end`: an insertion at either end of it does not. */
const touches = (e: CsvTextEdit, start: number, end: number) => (e.start === e.end ? e.start > start && e.start < end : e.start < end && e.end > start);
const inside = (e: { start: number; end: number }, start: number, end: number) => e.start >= start && e.end <= end;

const KINDS = ["rename", "add", "deleteCol", "reorder", "deleteRows"] as const;
type Kind = (typeof KINDS)[number];

type Action = {
	kind: Kind;
	/** The edits the action is, on the text as it is. Null when the action is nothing (the same order, the same name). */
	edits: CsvTextEdit[] | null;
	/** The table the action means, worked out from the cells' values and not from the text. */
	meant: Model;
	/** Says what is wrong with the edits as edits of the places the action touches, or nothing. */
	places: (edits: readonly CsvTextEdit[]) => string | null;
	/** The records the action may write in, by their place among `recordsOf`. */
	touched: Set<number>;
};

/** One random action on the table, with what it means and where it may write. Null when the table has no such action. */
function makeAction(r: Rnd, text: string, t: Table, kind: Kind): Action | null {
	const D = t.delimiter;
	const before = cellsOf(t);
	const recs = recordsOf(t);
	const nc = t.header.length;
	const nr = t.rows.length;
	const raw = (c: Cell) => text.slice(c.start, c.end);
	/** Every edit in the place `range` gives for one record, and no record with two. */
	const oneEach = (edits: readonly CsvTextEdit[], range: (rec: Rec) => [number, number] | null): string | null => {
		const used = new Set<number>();
		for (const e of edits) {
			const at = recs.findIndex((rec) => {
				const span = range(rec);
				return span !== null && inside(e, span[0], span[1]);
			});
			if (at < 0) return `an edit outside the places it may touch: ${JSON.stringify(e)}`;
			if (used.has(at)) return `two edits in one record: ${JSON.stringify(e)}`;
			used.add(at);
		}
		return null;
	};

	if (kind === "rename") {
		if (t.hasHeader === false || !nc) return null;
		const col = r.int(nc);
		const name = value(r).trim() || "n";
		const cell = t.header[col]!;
		return {
			kind,
			edits: renameCsvColumnEdits(t, col, name),
			meant: { header: before.header!.map((h, i) => (i === col ? name : h)), rows: before.rows },
			touched: new Set([0]),
			places: (edits) => (edits.length === 1 && edits[0]!.start === cell.start && edits[0]!.end === cell.end ? null : `not the one header cell: ${JSON.stringify(edits)}`),
		};
	}
	if (kind === "add") {
		if (!nc) return null;
		const name = value(r).trim() || "n";
		const def = r.next() < 0.3 ? "" : value(r);
		const rows = before.rows.map((row) => (row.length <= nc ? [...row, ...Array<string>(nc - row.length).fill(""), def] : [...row.slice(0, nc), def, ...row.slice(nc)]));
		return {
			kind,
			edits: addCsvColumnEdits(text, t, name, def),
			meant: { header: before.header ? [...before.header, name] : null, rows },
			touched: new Set(recs.map((_, i) => i)),
			// Insertions only, one in each record: nothing that is in the text is written anew.
			places: (edits) =>
				edits.length !== recs.length ? `${edits.length} edits for ${recs.length} records` : edits.some((e) => e.start !== e.end) ? "an edit that is not an insertion" : oneEach(edits, (rec) => [rec.start, rec.end]),
		};
	}
	if (kind === "deleteCol") {
		if (nc < 2) return null;
		const col = r.int(nc);
		const without = (row: string[]) => {
			if (row.length <= col) return row;
			const left = row.filter((_, i) => i !== col);
			return left.length ? left : [""];
		};
		return {
			kind,
			edits: deleteCsvColumnEdits(text, t, col),
			meant: { header: before.header ? before.header.filter((_, i) => i !== col) : null, rows: before.rows.map(without) },
			touched: new Set(recs.flatMap((rec, i) => (rec.cells.length > col ? [i] : []))),
			places: (edits) => {
				const wrong = oneEach(edits, (rec) => (rec.cells.length > col ? [rec.start, rec.end] : null));
				if (wrong) return wrong;
				for (const e of edits) {
					const rec = recs.find((x) => inside(e, x.start, x.end))!;
					const cell = raw(rec.cells[col]!);
					const taken = text.slice(e.start, e.end);
					// The cell and one delimiter and nothing else, or the row written `""` where nothing would be left of it.
					if (e.text === "" ? taken !== cell + D && taken !== D + cell : e.text !== '""' || rec.cells.length > 2) return `not the cell and one delimiter: took ${JSON.stringify(taken)} for ${JSON.stringify(e.text)}`;
				}
				return null;
			},
		};
	}
	if (kind === "reorder") {
		if (nc < 2) return null;
		const order = Array.from({ length: nc }, (_, i) => i);
		// Mostly two columns changing places, now and then every column somewhere else.
		if (r.next() < 0.6) {
			const a = r.int(nc);
			const b = r.int(nc);
			[order[a], order[b]] = [order[b]!, order[a]!];
		} else order.sort(() => r.next() - 0.5);
		let lo = 0;
		while (lo < nc && order[lo] === lo) lo++;
		let hi = nc - 1;
		while (hi >= 0 && order[hi] === hi) hi--;
		const moved = (row: string[]) => {
			// The cells in their new places; a place whose cell the row does not have is empty, and left out at the row's end.
			const out: (string | null)[] = order.map((from) => (from < row.length ? row[from]! : null));
			while (out.length && out.at(-1) === null) out.pop();
			return [...out.map((v) => v ?? ""), ...row.slice(nc)];
		};
		return {
			kind,
			edits: reorderCsvColumnsEdits(text, t, order),
			meant: { header: before.header ? order.map((from) => before.header![from]!) : null, rows: before.rows.map(moved) },
			touched: new Set(recs.flatMap((rec, i) => (lo < nc && rec.cells.length > lo ? [i] : []))),
			// In each record, only the cells from the first that changes place to the last.
			places: (edits) => oneEach(edits, (rec) => (rec.cells.length > lo ? [rec.cells[lo]!.start, rec.cells[Math.min(hi, rec.cells.length - 1)]!.end] : null)),
		};
	}
	if (!nr) return null;
	const rows = Array.from({ length: nr }, (_, i) => i).filter(() => r.next() < 0.4);
	if (!rows.length) rows.push(r.int(nr));
	const gone = new Set(rows);
	return {
		kind,
		edits: deleteCsvRowsEdits(text, t, rows),
		meant: { header: before.header, rows: before.rows.filter((_, i) => !gone.has(i)) },
		touched: new Set(recs.flatMap((rec, i) => (gone.has(rec.row) ? [i] : []))),
		places: (edits) => {
			for (const e of edits) {
				if (e.text !== "") return `a delete that writes: ${JSON.stringify(e)}`;
				// What is taken out is the deleted rows as written and one line end for each, and nothing of another record.
				const between: string[] = [];
				let from = e.start;
				let n = 0;
				for (const rec of recs) {
					if (!touches(e, rec.start, rec.end)) continue;
					if (!gone.has(rec.row) || !inside(rec, e.start, e.end)) return `a delete that reaches into row ${rec.row}`;
					between.push(text.slice(from, rec.start));
					from = rec.end;
					n++;
				}
				between.push(text.slice(from, e.end));
				// (The last row of a file that does not end with a line end takes the one before it, or none where a
				// bare CR is all that stands there.)
				const ends = between.reduce((sum, piece) => sum + (piece.match(/\r\n|\r|\n/g) ?? []).length, 0);
				const fewer = e.end === text.length && ends === n - 1;
				if (between.some((piece) => /[^\r\n]/.test(piece)) || (ends !== n && !fewer)) return `not the rows and a line end each: ${JSON.stringify(text.slice(e.start, e.end))} for ${n} rows`;
			}
			const covered = recs.filter((rec) => gone.has(rec.row)).every((rec) => edits.some((e) => inside(rec, e.start, e.end)));
			return covered ? null : "a row that was to be deleted is not";
		},
	};
}

/** Edits as an editor takes them: none overlapping, and no two insertions at one place (it does not say which comes first). */
function illFormed(edits: readonly CsvTextEdit[]): string | null {
	const sorted = [...edits].sort((a, b) => a.start - b.start || a.end - b.end);
	for (let i = 1; i < sorted.length; i++) {
		const a = sorted[i - 1]!;
		const b = sorted[i]!;
		if (b.start < a.end) return `overlapping edits: ${JSON.stringify([a, b])}`;
		if (a.start === a.end && b.start === b.end && a.start === b.start) return `two insertions at one place: ${JSON.stringify([a, b])}`;
	}
	return null;
}

describe("B3-10: a change of columns or rows is edits of the places it touches", () => {
	test("random tables, every way a file is written: each action re-reads as the table it means, and no edit reaches a record it does not touch", () => {
		const r = rng(20261125);
		const made: Record<string, number> = {};
		let refused = 0;
		let quoted = 0;
		const wrong: string[] = [];
		for (let round = 0; round < 6000 && wrong.length < 3; round++) {
			const table = makeTable(r);
			if (!table) continue;
			const { path, prefer, hasHeader, D } = table;
			let text = table.text;
			for (let step = 0; step < 4; step++) {
				const t = parseCsv(text, { hasHeader, prefer });
				if (t.delimiter !== D) break;
				const action = makeAction(r, text, t, r.pick(KINDS));
				if (!action?.edits) continue;
				const say = (what: string, next?: string) =>
					wrong.push(`${what}\n  ${action.kind} in a ${JSON.stringify(D)} ${path}${hasHeader ? " with a header row" : ""}\n  before ${JSON.stringify(text)}${next === undefined ? "" : `\n  after  ${JSON.stringify(next)}`}\n  edits  ${JSON.stringify(action.edits).slice(0, 400)}`);
				const places = action.places(action.edits) ?? illFormed(action.edits);
				if (places) {
					say(places, applyCsvEdits(text, action.edits));
					break;
				}
				// As the view makes it: the edits, asked of the rule that keeps the file's delimiter (`keptEdits`).
				const kept = csvEditsKeepingDelimiter(text, action.edits, D, prefer);
				if (kept === null) {
					refused++;
					continue;
				}
				const next = applyCsvEdits(text, kept);
				if (kept !== action.edits) quoted++;
				const ill = illFormed(kept);
				if (ill) {
					say(ill, next);
					break;
				}
				// No record the action was not to touch is inside an edit. The one record the rule may write in besides is
				// the one that is first afterwards, which it may have to quote.
				const recs = recordsOf(t);
				const firstLeft = action.kind === "deleteRows" ? recs.findIndex((_, i) => !action.touched.has(i)) : 0;
				const reached = recs.findIndex((rec, i) => !action.touched.has(i) && i !== firstLeft && kept.some((e) => touches(e, rec.start, rec.end)));
				if (reached >= 0) {
					say(`an edit reaches into a record the action does not touch (${JSON.stringify(text.slice(recs[reached]!.start, recs[reached]!.end))}): ${JSON.stringify(kept).slice(0, 300)}`, next);
					break;
				}
				const reread = parseCsv(next, { hasHeader, prefer });
				if (recordsOf(reread).length && reread.delimiter !== D) {
					say(`read with ${JSON.stringify(reread.delimiter)}`, next);
					break;
				}
				if (JSON.stringify(cellsOf(reread)) !== JSON.stringify(action.meant)) {
					say(`not the table that was meant: ${JSON.stringify(cellsOf(reread))} for ${JSON.stringify(action.meant)}`, next);
					break;
				}
				made[action.kind] = (made[action.kind] ?? 0) + 1;
				text = next;
			}
		}
		expect(wrong).toEqual([]);
		// Every action was made many times; some were refused by the delimiter rule, and some had their first record quoted by it.
		for (const kind of KINDS) expect(made[kind] ?? 0).toBeGreaterThan(1500);
		expect(refused).toBeGreaterThan(200);
		expect(quoted).toBeGreaterThan(20);
	});

	// One file with what a whole-document write could lose: CRLF on some lines and LF on others, a blank line, a
	// row short of the column, a line with a stray quote, quotes that are not needed, spaces around a delimiter,
	// a cell of two lines, and no line end after the last row.
	const FILE = 'id,name , "note",state\r\n1,"Ann",x,open\n\n2,Bob\r\n3,Cy" Ray, y ,"done"\n4,"Di\r\nLee",z,open';
	const table = () => parseCsv(FILE);

	test("deleting a column takes that cell and one delimiter out of each record that has it; every other character stays", () => {
		const edits = deleteCsvColumnEdits(FILE, table(), 2)!;
		// One deletion in each record with a third cell. The row `2,Bob` has none and is not written.
		expect(edits.map((e) => [FILE.slice(e.start, e.end), e.text])).toEqual([
			[', "note"', ""],
			[",x", ""],
			[", y ", ""],
			[",z", ""],
		]);
		expect(applyCsvEdits(FILE, edits)).toBe('id,name ,state\r\n1,"Ann",open\n\n2,Bob\r\n3,Cy" Ray,"done"\n4,"Di\r\nLee",open');
		// The first column goes with the delimiter after it.
		expect(deleteCsvColumnEdits(FILE, table(), 0)!.map((e) => FILE.slice(e.start, e.end))).toEqual(["id,", "1,", "2,", "3,", "4,"]);
		// A row that would be left with nothing, or with one empty cell, is written `""`: it is still a row.
		const short = "a,b\nx\ny,\n,z\n";
		expect(deleteCsvColumn(short, parseCsv(short), 0)).toBe('b\n""\n""\nz\n');
		expect(parseCsv(deleteCsvColumn(short, parseCsv(short), 0)!).rows.map((r) => r.map((c) => c.text))).toEqual([[""], [""], ["z"]]);
		expect(deleteCsvColumnEdits(FILE, table(), 4)).toBeNull();
		expect(deleteCsvColumnEdits("a\n1\n", parseCsv("a\n1\n"), 0)).toBeNull();
	});

	test("adding a column is one insertion in each record, renaming one is the header's cell", () => {
		const added = addCsvColumnEdits(FILE, table(), "owner", "n/a")!;
		expect(added.every((e) => e.start === e.end)).toBe(true);
		// The short row gets the delimiters between, so that its new cell is under the new column.
		expect(added.map((e) => e.text)).toEqual([",owner", ",n/a", ",,,n/a", ",n/a", ",n/a"]);
		expect(applyCsvEdits(FILE, added)).toBe('id,name , "note",state,owner\r\n1,"Ann",x,open,n/a\n\n2,Bob,,,n/a\r\n3,Cy" Ray, y ,"done",n/a\n4,"Di\r\nLee",z,open,n/a');
		const renamed = renameCsvColumnEdits(table(), 1, "Last, First")!;
		expect(renamed).toEqual([{ start: 3, end: 8, text: '"Last, First"' }]);
		expect(FILE.slice(3, 8)).toBe("name ");
		expect(renameCsvColumnEdits(table(), 0, " id ")).toBeNull();
		expect(renameCsvColumnEdits(parseCsv(FILE, { hasHeader: false }), 1, "x")).toBeNull();
		// The texts these give are the edits made, and nothing more.
		expect(addCsvColumn(FILE, table(), "owner", "n/a")).toBe(applyCsvEdits(FILE, added));
		expect(renameCsvColumn(FILE, table(), 1, "Last, First")).toBe(applyCsvEdits(FILE, renamed));
	});

	test("putting columns in another order writes the cells that move and no others: a short row is not padded", () => {
		// `name` and `note` change places: in each record, those two cells as they are written.
		const edits = reorderCsvColumnsEdits(FILE, table(), [0, 2, 1, 3])!;
		expect(edits.map((e) => [FILE.slice(e.start, e.end), e.text])).toEqual([
			['name , "note"', ' "note",name '],
			['"Ann",x', 'x,"Ann"'],
			// The short row has `Bob` under `name` and nothing under `note`: an empty cell comes before `Bob`.
			["Bob", ",Bob"],
			['Cy" Ray, y ', ' y ,Cy" Ray'],
			['"Di\r\nLee",z', 'z,"Di\r\nLee"'],
		]);
		expect(reorderCsvColumns(FILE, table(), [0, 2, 1, 3])).toBe('id, "note",name ,state\r\n1,x,"Ann",open\n\n2,,Bob\r\n3, y ,Cy" Ray,"done"\n4,z,"Di\r\nLee",open');
		// `note` and `state` change places: the short row has neither, and is not written. It was written out to the
		// header's width, `2,Bob,,`, with every row of the file.
		const last = reorderCsvColumnsEdits(FILE, table(), [0, 1, 3, 2])!;
		expect(last).toHaveLength(4);
		expect(reorderCsvColumns(FILE, table(), [0, 1, 3, 2])).toContain("\n2,Bob\r\n");
		// Two columns written alike in a row: that row has no edit.
		const twins = "a,b\n1,1\n2,3\n";
		expect(reorderCsvColumnsEdits(twins, parseCsv(twins), [1, 0])!.map((e) => twins.slice(e.start, e.end))).toEqual(["a,b", "2,3"]);
		expect(reorderCsvColumnsEdits(FILE, table(), [0, 1, 2, 3])).toBeNull();
		expect(reorderCsvColumnsEdits(FILE, table(), [0, 1, 1, 3])).toBeNull();
	});

	test("deleting rows takes those rows' lines, rows that stand together as one edit", () => {
		const edits = deleteCsvRowsEdits(FILE, table(), [0, 2, 3])!;
		expect(edits.map((e) => FILE.slice(e.start, e.end))).toEqual(['1,"Ann",x,open\n', '3,Cy" Ray, y ,"done"\n4,"Di\r\nLee",z,open']);
		expect(edits.every((e) => e.text === "")).toBe(true);
		expect(deleteCsvRows(FILE, table(), [0, 2, 3])).toBe('id,name , "note",state\r\n\n2,Bob\r\n');
		// The last row of a file with no line end after it takes the one before it.
		expect(deleteCsvRowsEdits(FILE, table(), [3])!.map((e) => FILE.slice(e.start, e.end))).toEqual(['\n4,"Di\r\nLee",z,open']);
		expect(deleteCsvRowsEdits(FILE, table(), [9])).toBeNull();
	});

	test("a quote that is never closed is closed where a cell is written after it", () => {
		// The last cell runs to the end of the text: a cell written after it would be read as more of it.
		const open = 'a,b\n1,"two\n';
		const t = parseCsv(open);
		expect(t.rows[0]!.map((c) => c.text)).toEqual(["1", "two\n"]);
		const added = addCsvColumn(open, t, "c", "x")!;
		expect(added).toBe('a,b,c\n1,"two\n",x');
		expect(parseCsv(added).rows[0]!.map((c) => c.text)).toEqual(["1", "two\n", "x"]);
		const moved = reorderCsvColumns(open, t, [1, 0])!;
		expect(moved).toBe('b,a\n"two\n",1');
		expect(parseCsv(moved).rows[0]!.map((c) => c.text)).toEqual(["two\n", "1"]);
	});

	test("where the first record has to be quoted, an edit below it stays the edit it was: rows between two deleted rows are not written", () => {
		// No header row, semicolons. Rows 1 and 5 are deleted; the row that becomes first holds a bare comma.
		const text = "1;a\n2;Smith, John\n3;c\n4;d\n5;e\n6;f\n";
		const t = parseCsv(text, { hasHeader: false });
		expect(t.delimiter).toBe(";");
		const edits = deleteCsvRowsEdits(text, t, [0, 4])!;
		expect(edits).toHaveLength(2);
		const kept = csvEditsKeepingDelimiter(text, edits, ";")!;
		expect(applyCsvEdits(text, kept)).toBe('2;"Smith, John"\n3;c\n4;d\n6;f\n');
		// One edit for the first row's delete and the quoting of the row after it, and the other delete as it was given.
		// They were made one edit from the first to the last, with rows 3 and 4 in it.
		expect(kept).toHaveLength(2);
		expect(kept[1]).toBe(edits[1]!);
		expect(kept[0]!.end).toBeLessThanOrEqual(text.indexOf("\n3;c"));
		// One edit comes back as one, whatever the rule adds to it (the view takes the first of the list).
		const one = csvEditsKeepingDelimiter(text, [edits[0]!], ";")!;
		expect(one).toHaveLength(1);
		expect(applyCsvEdits(text, one)).toBe('2;"Smith, John"\n3;c\n4;d\n5;e\n6;f\n');
	});

	test("converting the delimiter changes the delimiters and keeps what is not one", () => {
		// A file that quotes every cell, with spaces around some: only the commas between cells change.
		const all = '"id", "name" ,"note"\r\n"1","Ann, Lee","a;b"\r\n\r\n"2" ,Bob,c"d\r\n';
		expect(convertCsvDelimiter(all, parseCsv(all), "\t")).toBe('"id"\t "name" \t"note"\r\n"1"\t"Ann, Lee"\t"a;b"\r\n\r\n"2" \tBob\tc"d\r\n');
		// A cell that holds the new delimiter outside quotes is the one cell written anew.
		const semi = "id,note\n1,a;b\n2, c \n";
		expect(convertCsvDelimiter(semi, parseCsv(semi), ";")).toBe('id;note\n1;"a;b"\n2; c \n');
		// In the first record, a cell holding any delimiter is quoted: the record is what the file is read by.
		const names = "id\tLast, First\n1\tx, y\n";
		expect(convertCsvDelimiter(names, parseCsv(names, { delimiter: "\t" }), ";")).toBe('id;"Last, First"\n1;x, y\n');

		// Random tables to each other delimiter: the same cells, the same text between the records, and every cell
		// that holds no delimiter at all written as it was.
		const r = rng(5);
		const wrong: string[] = [];
		let converted = 0;
		for (let round = 0; round < 3000 && wrong.length < 3; round++) {
			const made = makeTable(r);
			if (!made) continue;
			const t = parseCsv(made.text, { hasHeader: made.hasHeader, prefer: made.prefer });
			const target = r.pick(DELIMS.filter((d) => d !== made.D));
			const next = convertCsvDelimiter(made.text, t, target);
			const reread = parseCsv(next, { delimiter: target, hasHeader: made.hasHeader });
			const say = (what: string) => wrong.push(`${what}\n  to ${JSON.stringify(target)}\n  before ${JSON.stringify(made.text)}\n  after  ${JSON.stringify(next)}`);
			if (JSON.stringify(cellsOf(reread)) !== JSON.stringify(cellsOf(t))) {
				say("other cells");
				continue;
			}
			const was = recordsOf(t);
			const is = recordsOf(reread);
			if (!was.length) continue;
			for (let i = 0; i < was.length; i++) {
				const gapWas = made.text.slice(i ? was[i - 1]!.end : 0, was[i]!.start);
				const gapIs = next.slice(i ? is[i - 1]!.end : 0, is[i]!.start);
				if (gapWas !== gapIs) say(`the text before record ${i} changed`);
				was[i]!.cells.forEach((cell, c) => {
					const raw = made.text.slice(cell.start, cell.end);
					const now = next.slice(is[i]!.cells[c]!.start, is[i]!.cells[c]!.end);
					if (!/[,\t;|]/.test(raw) && raw !== now) say(`a cell with no delimiter in it was written anew: ${JSON.stringify(raw)} as ${JSON.stringify(now)}`);
				});
			}
			if (made.text.slice(was.at(-1)!.end) !== next.slice(is.at(-1)!.end)) say("the end of the text changed");
			converted++;
		}
		expect(wrong).toEqual([]);
		expect(converted).toBeGreaterThan(1500);
	});

	test("Monaco's own text buffer takes the edits as they are given, and holds the text they mean", async () => {
		// The buffer as state.ts makes a model's (createModel -> PieceTreeTextBufferBuilder, line ends made one kind),
		// and the edits as the view hands them over: each a range between two positions of the text as it is.
		const model = join(import.meta.dir, "../node_modules/monaco-editor/esm/vs/editor/common");
		const { PieceTreeTextBufferBuilder } = await import(join(model, "model/pieceTreeTextBuffer/pieceTreeTextBufferBuilder.js"));
		const { Range } = await import(join(model, "core/range.js"));
		const inBuffer = (text: string) => {
			const builder = new PieceTreeTextBufferBuilder();
			builder.acceptChunk(text);
			const { textBuffer } = builder.finish(true).create(1);
			const value = (): string => textBuffer.getValueInRange(textBuffer.getRangeAt(0, textBuffer.getLength()), 0);
			const write = (edits: readonly CsvTextEdit[]) => {
				const ops = [...edits]
					.sort((a, b) => b.start - a.start || b.end - a.end)
					.map((ed) => {
						const from = textBuffer.getPositionAt(ed.start);
						const to = textBuffer.getPositionAt(ed.end);
						return { range: new Range(from.lineNumber, from.column, to.lineNumber, to.column), text: ed.text };
					});
				textBuffer.applyEdits(ops, false, false);
			};
			return { value, write, eol: textBuffer.getEOL() as string };
		};
		const r = rng(31);
		let written = 0;
		let quoted = 0;
		for (let round = 0; round < 3000; round++) {
			const made = makeTable(r);
			if (!made) continue;
			const buffer = inBuffer(made.text);
			// One change after another on the same model, as in the app.
			for (let step = 0; step < 4; step++) {
				// The view works on the model's text, in which every line end is the model's.
				const text = buffer.value();
				const t = parseCsv(text, { hasHeader: made.hasHeader, prefer: made.prefer });
				if (t.delimiter !== made.D) break;
				const action = makeAction(r, text, t, r.pick(KINDS));
				if (!action?.edits) continue;
				const kept = csvEditsKeepingDelimiter(text, action.edits, made.D, made.prefer);
				if (kept === null) continue;
				if (kept !== action.edits) quoted++;
				// It throws "Overlapping ranges are not allowed!" for edits it cannot take.
				buffer.write(kept);
				// A line end in a value that is written becomes the model's kind, as every line end in a model is.
				expect(buffer.value()).toBe(applyCsvEdits(text, kept).replace(/\r\n|\r|\n/g, buffer.eol));
				written++;
			}
		}
		expect(written).toBeGreaterThan(5000);
		expect(quoted).toBeGreaterThan(10);

		// A column out of 1,500 rows: more edits than the buffer makes one by one (from a thousand on it makes them as
		// one edit of its own, from the first place to the last).
		const big = `id,name,note\n${Array.from({ length: 1500 }, (_, i) => `${i},"n ${i}",x${i % 7 ? "" : ",extra"}`).join("\n")}\n`;
		const buffer = inBuffer(big);
		const edits = deleteCsvColumnEdits(big, parseCsv(big), 1)!;
		expect(edits).toHaveLength(1501);
		buffer.write(edits);
		const without = big.replace(/,"n \d+"/g, "").replace("id,name,note", "id,note");
		expect(buffer.value()).toBe(without);
		// And as many insertions, then as many cells changing places.
		const added = addCsvColumnEdits(without, parseCsv(without), "owner", "n/a")!;
		expect(added).toHaveLength(1501);
		buffer.write(added);
		const withOwner = applyCsvEdits(without, added);
		expect(buffer.value()).toBe(withOwner);
		expect(withOwner.startsWith("id,note,owner\n0,x,extra,n/a\n1,x,n/a\n")).toBe(false);
		expect(withOwner.startsWith("id,note,owner\n0,x,n/a,extra\n1,x,n/a\n")).toBe(true);
		const moved = reorderCsvColumnsEdits(withOwner, parseCsv(withOwner), [2, 1, 0])!;
		expect(moved).toHaveLength(1501);
		buffer.write(moved);
		expect(buffer.value().startsWith("owner,note,id\nn/a,x,0,extra\nn/a,x,1\n")).toBe(true);
		expect(buffer.value()).toBe(reorderCsvColumns(withOwner, parseCsv(withOwner), [2, 1, 0])!);
	});

	test("held by source text: TableView.tsx writes the five changes as edits, each asked of the delimiter rule, and only the convert as a whole text", () => {
		const tv = readSrc("../src/view/editor/TableView.tsx");
		// The edits, worked out on the text as it is at that moment (a place in another text is another place).
		for (const made of [
			"const deleted = deleteCsvRowsEdits(raw, fresh, targetRows);",
			"const added = addCsvColumnEdits(raw, parseCurrentCsv(raw), name, defVal);",
			"const renamed = renameCsvColumnEdits(parseCurrentCsv(model.getValue()), col, nextName);",
			"const without = deleteCsvColumnEdits(raw, fresh, col);",
			"const reordered = reorderCsvColumnsEdits(raw, parseCurrentCsv(raw), applied);",
		])
			expect(tv).toContain(made);
		for (const asked of ["keptEdits(deleted)", "keptEdits(added)", "keptEdits(renamed)", "keptEdits(without)", "keptEdits(reordered)"]) expect(tv).toContain(asked);
		expect(count(tv, "applyTextEdits(edits")).toBe(5);
		// The whole-text makers are not used by the view any more, and one place alone writes the whole document.
		for (const whole of ["deleteCsvRows(", "addCsvColumn(", "renameCsvColumn(", "deleteCsvColumn(", "reorderCsvColumns(", "csvTextKeepingDelimiter("]) expect(tv).not.toContain(whole);
		expect(count(tv, "getFullModelRange()")).toBe(1);
		expect(count(tv, "applyFullText(")).toBe(1);
		expect(tv).toMatch(/const applyFullText = \(nextText: string, message\?: string\) => \{\n\t\tif \(!model\) return;\n\t\tconst fullRange = model\.getFullModelRange\(\);/);
		expect(tv).toContain("applyFullText(next, `Converted file delimiter to ${delimiterLabel(target)} (Ctrl+Z to undo).`);");
	});
});

// --- B3-4 ----------------------------------------------------------------------

describe("B3-4: an open cell editor is on the page", () => {
	test("a blank row put into a closed group has its group opened; a row the filters hide is kept among the rows; a row that is not there closes the editor", () => {
		// Rows grouped by a column: a new row has nothing in it, so it belongs to the group of empty values.
		expect(editorRowReveal(3, { rowCount: 6, passes: true, groupKey: "", collapsed: new Set(["", "done"]) })).toEqual({ pin: false, openGroup: "" });
		// Tab from the grouping column's cell, after writing a value whose group is closed.
		expect(editorRowReveal(0, { rowCount: 6, passes: true, groupKey: "done", collapsed: new Set(["done"]) })).toEqual({ pin: false, openGroup: "done" });
		// Hidden by a filter (a check's result arrived, the row no longer matches): the row is pinned, as a row being worked on is.
		expect(editorRowReveal(2, { rowCount: 6, passes: false, groupKey: null, collapsed: new Set() })).toEqual({ pin: true, openGroup: null });
		expect(editorRowReveal(2, { rowCount: 6, passes: false, groupKey: "open", collapsed: new Set(["open"]) })).toEqual({ pin: true, openGroup: "open" });
		// No such row (rows were deleted under the editor), or nothing that would show it: no editor.
		expect(editorRowReveal(6, { rowCount: 6, passes: true, groupKey: null, collapsed: new Set() })).toBe("close");
		expect(editorRowReveal(-1, { rowCount: 6, passes: false, groupKey: null, collapsed: new Set() })).toBe("close");
		expect(editorRowReveal(2, { rowCount: 6, passes: true, groupKey: "open", collapsed: new Set(["done"]) })).toBe("close");
	});

	/**
	 * The rows as the view shows them, in Solid's own signals (the dev build, as the app's): filters with one pinned
	 * row let through, groups that can be closed, and the view's effect over them. A model of the view's rows, not
	 * the view: what it holds is that the decision, run as the view runs it, ends with the editor's row shown.
	 */
	function shownRows(values: readonly string[]) {
		return createRoot((dispose) => {
			const [rows, setRows] = createSignal(values.map((v, index) => ({ index, value: v })));
			const [hiddenValue, setHiddenValue] = createSignal<string | null>(null);
			const [pinned, setPinned] = createSignal<number | null>(null);
			const [grouped, setGrouped] = createSignal(true);
			const [collapsed, setCollapsed] = createSignal(new Set<string>());
			const [editing, setEditing] = createSignal<number | null>(null);
			const passing = createMemo(() => rows().filter((r) => r.index === pinned() || r.value !== hiddenValue()));
			const shown = createMemo(() => new Set(passing().filter((r) => !grouped() || !collapsed().has(r.value.trim().toLowerCase())).map((r) => r.index)));
			let asked = 0;
			createEffect(
				() => {
					const row = editing();
					if (row === null || shown().has(row)) return null;
					asked++;
					return {
						row,
						reveal: editorRowReveal(row, {
							rowCount: rows().length,
							passes: passing().some((r) => r.index === row),
							groupKey: grouped() ? (rows()[row]?.value ?? "").trim().toLowerCase() : null,
							collapsed: collapsed(),
						}),
					};
				},
				(hidden) => {
					if (!hidden) return;
					if (hidden.reveal === "close") return void setEditing(null);
					if (hidden.reveal.pin) setPinned(hidden.row);
					const group = hidden.reveal.openGroup;
					if (group !== null) setCollapsed((prev) => new Set([...prev].filter((key) => key !== group)));
				},
			);
			return { setRows, setHiddenValue, setGrouped, setCollapsed, setEditing, editing, shown, collapsed, pinned, asked: () => asked, dispose };
		});
	}

	test("with Solid's signals: an editor opened on a hidden row is shown at once, by opening its group or keeping its row, and the rule is asked once", () => {
		const view = shownRows(["open", "done", "", "open"]);
		try {
			// The group of empty values is closed, and a row is inserted: the editor opens on the blank row.
			view.setCollapsed(new Set(["", "done"]));
			flush();
			view.setRows((rows) => [...rows, { index: 4, value: "" }]);
			view.setEditing(4);
			flush();
			expect(view.editing()).toBe(4);
			expect(view.shown().has(4)).toBe(true);
			// Only that group was opened.
			expect([...view.collapsed()]).toEqual(["done"]);
			expect(view.asked()).toBe(1);

			// A filter comes on that hides the row being edited (not by the user's hand: a check's result arriving).
			view.setHiddenValue("");
			flush();
			expect(view.editing()).toBe(4);
			expect(view.pinned()).toBe(4);
			expect(view.shown().has(4)).toBe(true);

			// Another row, in a closed group and hidden by a filter besides: both are put right together.
			view.setHiddenValue("done");
			view.setEditing(1);
			flush();
			expect(view.editing()).toBe(1);
			expect(view.shown().has(1)).toBe(true);
			expect(view.pinned()).toBe(1);
			expect([...view.collapsed()]).toEqual([]);

			// The row goes: no editor is left "open" on nothing.
			view.setEditing(3);
			view.setRows((rows) => rows.slice(0, 3));
			flush();
			expect(view.editing()).toBeNull();
		} finally {
			view.dispose();
		}
	});

	test("random rows, filters and closed groups: after the rule's answer the row is shown, or the editor is closed because the row is not there", () => {
		const r = rng(44);
		for (let round = 0; round < 2000; round++) {
			const values = Array.from({ length: 1 + r.int(6) }, () => r.pick(["open", "Done ", "", " ", "x"]));
			const key = (v: string) => v.trim().toLowerCase();
			const hide = r.next() < 0.5 ? r.pick(values) : null;
			const grouped = r.next() < 0.7;
			const collapsed = new Set(values.map(key).filter(() => r.next() < 0.5));
			let pinned: number | null = r.next() < 0.2 ? r.int(values.length) : null;
			const row = r.int(values.length + 2) - 1;
			const passes = () => row >= 0 && row < values.length && (row === pinned || values[row] !== hide);
			const shown = () => passes() && (!grouped || !collapsed.has(key(values[row]!)));
			if (shown()) continue;
			const reveal = editorRowReveal(row, { rowCount: values.length, passes: passes(), groupKey: grouped && values[row] !== undefined ? key(values[row]) : null, collapsed });
			if (reveal === "close") {
				expect(row < 0 || row >= values.length).toBe(true);
				continue;
			}
			if (reveal.pin) pinned = row;
			if (reveal.openGroup !== null) collapsed.delete(reveal.openGroup);
			expect(shown()).toBe(true);
		}
	});

	test("held by source text: one effect in TableView.tsx asks the rule for every editor, whatever opened it", () => {
		const tv = readSrc("../src/view/editor/TableView.tsx");
		// Asked of the rows as they are shown (`rowVisIndexMap` is the rows that are not in a closed group), for an
		// editor on a row of the file; the blank last row is always on the page.
		expect(tv).toContain("if (!ed || ed.ghost || rowVisIndexMap().has(ed.row)) return null;");
		expect(tv).toContain("reveal: editorRowReveal(row, {");
		expect(tv).toContain("passes: rows().some((r) => r.index === row),");
		// The group's key as the groups are made (`orderedGroups`).
		expect(tv).toContain('groupKey: gCol === null ? null : (table().rows[row]?.[gCol]?.text ?? "").trim().toLowerCase(),');
		expect(tv).toContain("const raw = (item.cells[gCol]?.text ?? \"\").trim();\n\t\t\tconst key = raw.toLowerCase();");
		expect(tv).toMatch(/if \(hidden\.reveal === "close"\) \{\n\t\t\t\tsetEditing\(null\);\n\t\t\t\treturn;\n\t\t\t\}\n\t\t\tif \(hidden\.reveal\.pin\) setPinnedRow\(hidden\.row\);/);
		expect(tv).toMatch(/if \(group !== null\) \{\n\t\t\t\tsetCollapsedGroups\(\(prev\) => \{\n\t\t\t\t\tconst next = new Set\(prev\);\n\t\t\t\t\tnext\.delete\(group\);/);
		// A row inserted is still given its editor, and a pinned row passes every filter.
		expect(tv).toContain("queueMicrotask(() => setEditing({ ghost: false, row: targetRow, column: visibleColumns()[0] ?? 0 }));");
		expect(count(tv, "index === pinned ||")).toBe(6);
	});
});

// --- B3-8 ----------------------------------------------------------------------

describe("B3-8: a character typed with AltGr or Option starts an edit", () => {
	const altGraph = (on: boolean) => (name: string) => on && name === "AltGraph";
	/** AltGr and a key as Windows sends it: Ctrl and Alt together, with the AltGraph state where the engine gives it. */
	const windows = (key: string, state = true): TypedKey => ({ key, ctrlKey: true, altKey: true, getModifierState: altGraph(state) });
	/** AltGr and a key as Linux sends it, and an engine that takes Ctrl and Alt off again: the AltGraph state alone. */
	const level3 = (key: string): TypedKey => ({ key, ctrlKey: false, altKey: false, getModifierState: altGraph(true) });
	/** Option and a key on a Mac: Alt, and the character made. */
	const option = (key: string, shiftKey = false): TypedKey & { shiftKey: boolean } => ({ key, altKey: true, shiftKey, getModifierState: altGraph(false) });
	const EVERYWHERE: KeyOs[] = ["mac", "windows", "other"];

	test("the characters a German keyboard has behind AltGr, as each platform sends them", () => {
		for (const ch of ["@", "{", "[", "]", "}", "\\", "|", "€", "~", "µ", "²"]) {
			// Windows: Ctrl+Alt, with the AltGraph state or (an engine that does not give it) without.
			expect(typedCharacter(windows(ch), "windows")).toBe(ch);
			expect(typedCharacter(windows(ch, false), "windows")).toBe(ch);
			expect(keyActsOnCell(windows(ch), "windows")).toBe(true);
			expect(keyActsOnCell(windows(ch, false), "windows")).toBe(true);
			// Linux, and a Windows engine that says the AltGraph state alone.
			expect(typedCharacter(level3(ch), "other")).toBe(ch);
			expect(typedCharacter(level3(ch), "windows")).toBe(ch);
			expect(keyActsOnCell(level3(ch), "other")).toBe(true);
		}
		// A letter with an accent from a third level (Polish AltGr+A), and an AltGr that says `altKey` too.
		expect(typedCharacter(windows("ą"), "windows")).toBe("ą");
		expect(typedCharacter({ key: "@", altKey: true, getModifierState: altGraph(true) }, "other")).toBe("@");
		// Ctrl+Alt where it is not Windows' AltGr is two keys held for a shortcut, whatever the third key gives.
		expect(typedCharacter(windows("-", false), "other")).toBeNull();
		expect(typedCharacter(windows("@", false), "mac")).toBeNull();
	});

	test("the characters a Mac keyboard has behind Option", () => {
		// German: Option+L is @, Option+5 [, Option+7 |, Option+Shift+7 \. US: Option+A is å, Option+2 ™.
		for (const ch of ["@", "[", "]", "|", "{", "}", "å", "™", "π", "≈"]) {
			expect(typedCharacter(option(ch), "mac")).toBe(ch);
			expect(keyActsOnCell(option(ch), "mac")).toBe(true);
		}
		expect(typedCharacter(option("\\", true), "mac")).toBe("\\");
		// The same press where it is not a Mac is Alt and a key: a menu's letter, or a shortcut.
		for (const os of ["windows", "other"] as const) {
			expect(typedCharacter(option("f"), os)).toBeNull();
			expect(typedCharacter(option("@"), os)).toBeNull();
			expect(keyActsOnCell(option("f"), os)).toBe(false);
		}
		// A dead key (Option+E, then a vowel) is no character yet.
		expect(typedCharacter({ key: "Dead", altKey: true }, "mac")).toBeNull();
	});

	test("plain typing is as it was, and a shortcut never types", () => {
		for (const os of EVERYWHERE) {
			for (const ch of ["a", "Z", "7", " ", "ä", "ß", "?", "😀"]) expect(typedCharacter({ key: ch }, os)).toBe(ch);
			const shifted: TypedKey & { shiftKey: boolean } = { key: "A", shiftKey: true };
			expect(typedCharacter(shifted, os)).toBe("A");
			expect(keyActsOnCell(shifted, os)).toBe(true);
			// The table's own shortcuts and the app's: copy, cut, paste, undo, redo, fill down and right, find and
			// replace, select all, save. With Ctrl, and with Cmd or the Windows key.
			for (const key of ["c", "x", "v", "z", "y", "d", "r", "f", "h", "a", "s", "Z"]) {
				expect(typedCharacter({ key, ctrlKey: true }, os)).toBeNull();
				expect(typedCharacter({ key, metaKey: true }, os)).toBeNull();
				expect(keyActsOnCell({ key, ctrlKey: true }, os)).toBe(false);
				expect(keyActsOnCell({ key, metaKey: true }, os)).toBe(false);
			}
			// Ctrl+Alt with a letter or a digit is a shortcut (Ctrl+Alt+S saves all, Ctrl+Alt+G opens Git), on a
			// keyboard with AltGr too: the key has nothing on its third level, so the key is the letter itself.
			for (const key of ["s", "g", "k", "o", "t", "n", "b", "S", "1"]) {
				expect(typedCharacter(windows(key, false), os)).toBeNull();
				expect(typedCharacter(windows(key), os)).toBeNull();
				expect(keyActsOnCell(windows(key), os)).toBe(false);
			}
			// Cmd with Option, and the Windows key with AltGr.
			expect(typedCharacter({ key: "π", metaKey: true, altKey: true }, os)).toBeNull();
			expect(typedCharacter({ key: "@", metaKey: true, ctrlKey: true, altKey: true, getModifierState: altGraph(true) }, os)).toBeNull();
		}
		// Ctrl on a Mac (Ctrl+A and Ctrl+E move the cursor in a box), and Ctrl+Option.
		expect(typedCharacter({ key: "a", ctrlKey: true }, "mac")).toBeNull();
		expect(typedCharacter({ key: "å", ctrlKey: true, altKey: true }, "mac")).toBeNull();
		// Alt and a letter where it is not a Mac: a menu (Alt+F), word wrap (Alt+Z), copy path (Alt+Shift+C).
		for (const key of ["f", "z", "C", "D"]) {
			expect(typedCharacter({ key, altKey: true, getModifierState: altGraph(false) }, "windows")).toBeNull();
			expect(typedCharacter({ key, altKey: true }, "other")).toBeNull();
		}
		// With no word on whose keyboard it is, the press is read as on neither a Mac nor Windows.
		expect(typedCharacter(option("@"))).toBeNull();
		expect(typedCharacter(windows("@", false))).toBeNull();
		expect(typedCharacter(level3("@"))).toBe("@");
	});

	test("a named key is no character, with or without modifiers; the keys the table answers on a cell are as they were", () => {
		for (const os of EVERYWHERE) {
			for (const key of ["Enter", "Tab", "Escape", "ArrowUp", "F2", "Dead", "Process", "Unidentified", "Shift", "AltGraph", "Backspace", "Delete", ""]) {
				expect(typedCharacter({ key }, os)).toBeNull();
				expect(typedCharacter(windows(key), os)).toBeNull();
				expect(typedCharacter(option(key), os)).toBeNull();
			}
			// A control character is not typed (some engines name Backspace or Delete so).
			for (const key of ["\b", "\t", "\r", "\u001b", "\u007f"]) expect(typedCharacter({ key }, os)).toBeNull();
			// Alt+arrows move a row or a column; Ctrl+arrows and Alt+Shift+arrows are not the table's.
			for (const key of ["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"]) {
				expect(keyActsOnCell({ key }, os)).toBe(true);
				expect(keyActsOnCell({ key, shiftKey: true }, os)).toBe(true);
				expect(keyActsOnCell({ key, altKey: true }, os)).toBe(true);
				expect(keyActsOnCell({ key, ctrlKey: true }, os)).toBe(false);
				expect(keyActsOnCell({ key, altKey: true, shiftKey: true }, os)).toBe(false);
			}
			for (const key of ["Enter", "F2", "ContextMenu"]) expect(keyActsOnCell({ key }, os)).toBe(true);
			expect(keyActsOnCell({ key: "F10", shiftKey: true }, os)).toBe(true);
			for (const key of ["PageUp", "PageDown", "Delete", "Backspace"]) {
				expect(keyActsOnCell({ key }, os)).toBe(true);
				expect(keyActsOnCell({ key, ctrlKey: true }, os)).toBe(false);
				expect(keyActsOnCell({ key, altKey: true }, os)).toBe(false);
			}
			expect(keyActsOnCell({ key: "Home", ctrlKey: true }, os)).toBe(true);
			expect(keyActsOnCell({ key: "End", altKey: true }, os)).toBe(false);
			for (const key of ["Escape", "Tab", "F8", "Control", "Alt", "AltGraph", "Shift", "Meta"]) expect(keyActsOnCell({ key }, os)).toBe(false);
		}
	});

	test("held by source text: a cell, the blank last row and the table itself ask the one rule, and seed the editor with what it gives", () => {
		const tv = readSrc("../src/view/editor/TableView.tsx");
		expect(count(tv, "const typed = typedCharacter(e, keyOs);")).toBe(2);
		expect(tv).toContain("setEditing({ ghost: false, row, column, seed: typed });");
		expect(tv).toContain("setEditing({ ghost: true, column, seed: typed });");
		expect(tv).toContain("!keyActsOnCell(e, keyOs)) return false;");
		expect(tv).toContain('return /Mac|iPhone|iPad/.test(platform) ? "mac" : /Win/.test(platform) ? "windows" : "other";');
		// The old test of a typed key is gone from both handlers.
		expect(tv).not.toContain("e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey");
		// The table's Ctrl shortcuts are not reached by AltGr as Windows sends it (Ctrl with Alt).
		expect(tv).toContain("if (!model || !(e.ctrlKey || e.metaKey) || e.altKey) return;");
	});
});

// --- B3-9 ----------------------------------------------------------------------

describe("B3-9: a check that is stopped says so, and is not stopped by what happens to another column", () => {
	test("what is said, in the words of the check's other notices", () => {
		expect(codeCheckStopped("Name", "column")).toBe("Stopped checking “Name”: the column is no longer in the table.");
		expect(codeCheckStopped("Name", "closed")).toBe("Stopped checking “Name”: the table is no longer shown.");
		expect(codeCheckStopped("Name", "file")).toBe("Stopped checking “Name”: the table shows another file or folder now.");
		expect(codeCheckStopped("Name", "replaced")).toBe("Stopped checking “Name”: another check was started.");
		expect(codeCheckStopped("  ", "closed")).toBe("Stopped checking “column”: the table is no longer shown.");
	});

	test("a running check follows its column through a delete, its undo and its redo; only the delete of its own column ends it", () => {
		// Columns id, name, status, note. The check reads `status` (2); `name` (1) is deleted.
		const running = trackedColumn(2);
		const gone = columnMoves({ deleted: 1 });
		running.moved(gone.made);
		expect(running.at()).toBe(1);
		// Undo: `name` is back, and `status` is where it was. This stopped the check.
		running.moved(gone.undone);
		expect(running.at()).toBe(2);
		// Redo.
		running.moved(gone.made);
		expect(running.at()).toBe(1);
		// A column to its right: nothing moves.
		const right = columnMoves({ deleted: 3 });
		running.moved(right.made);
		running.moved(right.undone);
		expect(running.at()).toBe(1);
		// Its own column: the check has nothing left to read.
		const own = trackedColumn(2);
		own.moved(columnMoves({ deleted: 2 }).made);
		expect(own.at()).toBe(-1);
	});

	test("and through a new order of the columns, its undo and its redo", () => {
		// `order[newPlace] = oldPlace`: status, id, note, name.
		const order = [2, 0, 3, 1];
		const moves = columnMoves({ order });
		const running = trackedColumn(3);
		running.moved(moves.made);
		expect(running.at()).toBe(2);
		running.moved(moves.undone);
		expect(running.at()).toBe(3);
		// Any order, any column, any number of undos and redos: the column is where the order puts it.
		const r = rng(9);
		for (let round = 0; round < 500; round++) {
			const n = 2 + r.int(6);
			const any = Array.from({ length: n }, (_, i) => i).sort(() => r.next() - 0.5);
			const m = columnMoves({ order: any });
			const start = r.int(n);
			const col = trackedColumn(start);
			for (let i = 1 + r.int(4); i > 0; i--) {
				col.moved(m.made);
				expect(any[col.at()]).toBe(start);
				col.moved(m.undone);
				expect(col.at()).toBe(start);
			}
			const del = r.int(n);
			const d = columnMoves({ deleted: del });
			col.moved(d.made);
			if (del === start) expect(col.at()).toBe(-1);
			else {
				col.moved(d.undone);
				expect(col.at()).toBe(start);
			}
		}
	});

	test("held by source text: in TableView.tsx only a check's own Cancel, its own end and `stopCodeCheck` end a run, and `stopCodeCheck` says so", () => {
		const tv = readSrc("../src/view/editor/TableView.tsx");
		// A run ends where `checkRunId` is counted on: a new run, Cancel, a failed scan, the view's end, and the one stop.
		expect(count(tv, "checkRunId++;")).toBe(4);
		expect(count(tv, "++checkRunId")).toBe(1);
		// Clearing a result is not one of them any more, and neither is putting the columns' view back after an undo.
		expect(tv).toMatch(/const clearCodeCheck = \(\) => \{\n\t\tsetCodeCheck\(null\);\n\t\tsetOnlyMissing\(false\);\n\t\};/);
		expect(tv).toMatch(/const restoreColUi = \(snap: ColumnUiSnapshot\) => \{\n\t\tsetColFilters\(new Map\(snap\.colFilters\)\);/);
		// The stop: only of a run that is still running, and said once.
		expect(tv).toMatch(
			/const stopCodeCheck = \(why: CodeCheckStop\) => \{\n\t\tconst running = begunCheck;\n\t\tif \(!running \|\| running\.runId !== checkRunId\) return;\n\t\tuserCancelledRunId = 0;\n\t\tcheckRunId\+\+;\n\t\tcheckedColumn = null;\n\t\tsetChecking\(null\);\n\t\tnotify\(codeCheckStopped\(running\.columnName, why\)\);\n\t\};/,
		);
		expect(tv).toContain("begunCheck = { runId, columnName: colName };");
		expect(tv).toContain("if (begunCheck?.runId === runId) begunCheck = null;");
		// Its four callers: the check's own column gone, another file or folder, another check, and the view's end.
		expect(tv).toMatch(/if \(checkedColumn\.at\(\) >= 0\) return;\n\t\tcheckedColumn = null;\n\t\tstopCodeCheck\("column"\);/);
		expect(tv).toMatch(/stopCodeCheck\("file"\);\n\t\t\tclearCodeCheck\(\);/);
		expect(tv).toMatch(/stopCodeCheck\("replaced"\);\n\t\tconst runId = \+\+checkRunId;/);
		expect(count(tv, "stopCodeCheck(")).toBe(3);
		expect(tv).toMatch(
			/const running = begunCheck && begunCheck\.runId === checkRunId \? begunCheck : null;\n\t\tdisposed = true;\n\t\tcheckRunId\+\+;[^]*?if \(running\) queueMicrotask\(\(\) => notify\(codeCheckStopped\(running\.columnName, "closed"\)\)\);/,
		);
		// The check follows its column: when a column is deleted or the order written, when either is undone or made
		// again, and when columns are taken out of the text in another view.
		expect(tv).toContain("const columnsMoved = columnsAcross.get(colSnapshotTransitionKey(prevAlt, curAlt));\n\t\tif (columnsMoved) moveCheckedColumn(columnsMoved);");
		expect(tv).toContain("const moves = columnMoves({ deleted: col });");
		expect(tv).toContain("const moves = columnMoves({ order: applied });");
		expect(count(tv, "columnsAcross.set(colSnapshotTransitionKey(afterAlt, beforeAlt), moves.undone);")).toBe(2);
		expect(count(tv, "columnsAcross.set(colSnapshotTransitionKey(beforeAlt, afterAlt), moves.made);")).toBe(2);
		expect(tv).toContain("moveCheckedColumn((column) => (column < count ? column : -1));");
	});
});

// --- B3-11 ---------------------------------------------------------------------

describe("B3-11: rows are not spread into a call's arguments", () => {
	// More than either engine takes as arguments: V8 gives up near 125,000, JavaScriptCore under a million.
	const MANY = 1_200_000;

	test("the widest row of a paste of more than a million rows", () => {
		const grid = Array.from({ length: MANY }, (_, i) => (i === 777 ? ["a", "b", "c"] : ["a"]));
		expect(greatest(grid, (row) => row.length)).toBe(3);
		// What the view goes on to say after such a paste.
		expect(pasteFit(greatest(grid, (row) => row.length), 1, 4)).toEqual({ cols: 3, leftOut: 0 });
		// As `Math.max` of nothing, and of a row's missing cells.
		expect(greatest([], (n: number) => n)).toBe(-Infinity);
		expect(greatest(new Map<number, string>().keys(), (c) => c, -1)).toBe(-1);
		expect(greatest(new Map([[4, "x"], [9, "y"], [2, "z"]]).keys(), (c) => c, -1)).toBe(9);
		expect(greatest([3, 1, 2], (n) => -n)).toBe(-1);
	});

	test("a table of more than a million rows as Markdown, and a fill from more than a million cells", () => {
		const rows = Array.from({ length: MANY }, () => ["a"]);
		rows[5] = ["a", "b"];
		const md = cellsToMarkdownTable(["h"], rows);
		expect(md.startsWith("| h | Column 2 |\n| --- | --- |\n| a |  |\n")).toBe(true);
		expect(cellsToMarkdownTable([], [])).toBe("");
		expect(cellsToMarkdownTable(["a", "b"], [])).toBe("| a | b |\n| --- | --- |");
		// Zero-padded numbers, decimals and numbered names each look for the widest of their seeds.
		const padded = Array.from({ length: MANY }, (_, i) => String(i + 1).padStart(8, "0"));
		expect(generateFillSeries(padded, 2)).toEqual(["01200001", "01200002"]);
		const decimals = Array.from({ length: MANY }, (_, i) => (i / 2).toFixed(1));
		expect(generateFillSeries(decimals, 2)).toEqual(["600000.0", "600000.5"]);
		const named = Array.from({ length: MANY }, (_, i) => `TC-${String(i + 1).padStart(7, "0")}`);
		expect(generateFillSeries(named, 2)).toEqual(["TC-1200001", "TC-1200002"]);
	});

	test("held by source text: none of the three files spreads into a call but a path's few parts", () => {
		// A call with a spread as its first argument or a later one: `f(...rows)`, `Math.max(0, ...rows)`. A spread
		// inside an array that is an argument (`f([head, ...rows])`) is no argument of the call, and is not looked for.
		const spread = /[\w\])]\(\s*(?:(?:[^()[\]\n]|\[[^[\]\n]*\])*,\s*)?\.\.\.[\w([]/;
		expect(spread.test("Math.max(...grid.map((r) => r.length))")).toBe(true);
		expect(spread.test("const n = Math.max(headers.length, ...rows.map((r) => r.length), 0);")).toBe(true);
		expect(spread.test("out.push(...more);")).toBe(true);
		expect(spread.test("return cellsToClipboardText([headers, ...rows]);")).toBe(false);
		const found = (rel: string) =>
			readSrc(rel)
				.split("\n")
				.filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line) && spread.test(line))
				.map((line) => line.trim());
		expect(found("../src/shared/csv.ts")).toEqual([]);
		expect(found("../src/shared/tablePower.ts")).toEqual([]);
		// The two that are left hand `joinPath` the parts of one path a user wrote: a few, however large the table.
		expect(found("../src/view/editor/TableView.tsx")).toEqual([
			'const resolved = parts.includes("..") ? resolvePath(root, trimmed) : joinPath(root, ...parts);',
			'const schemaDir = joinPath(root, ...schemaRel.split(/[\\\\/]/).filter((p) => p && p !== "."));',
		]);
		const tv = readSrc("../src/view/editor/TableView.tsx");
		expect(tv).toContain("const fit = pasteFit(greatest(grid, (r) => r.length), startVisCol, cols.length);");
		expect(tv).toContain("const maxColNeeded = greatest(tailVals.keys(), (c) => c, -1);");
		for (const rel of ["../src/shared/csv.ts", "../src/shared/tablePower.ts", "../src/view/editor/TableView.tsx"]) {
			const src = readSrc(rel);
			expect(src).not.toMatch(/\.apply\(/);
			expect(src).not.toMatch(/\.push\(\s*\.\.\./);
		}
	});
});
