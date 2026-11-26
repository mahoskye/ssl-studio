// Audit pass 4, medium findings that were already on main, in the table editor and in what reads a scan's hits:
// P9 (an edit that changes what the file is read with), P8 (a suggestion under a resting pointer is written
// instead of what was typed) and P5 (a scan that ran out of time is taken for a complete one).
//
// TableView.tsx is not mounted in any test. Each decision it makes here is a pure function in src/shared, and is
// run below; that the view calls it is held by its source text only, and each such test says so in its name.
import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WorkspaceFiles } from "../src/bun/workspace";
import {
	addCsvColumn,
	appendRowEdit,
	cellChangeEdit,
	csvDelimiterForPath,
	csvDelimiterOf,
	csvEditsKeepingDelimiter,
	csvFirstRecordCell,
	csvRow,
	csvTextKeepingDelimiter,
	deleteCsvColumn,
	deleteCsvRows,
	insertRowEdit,
	moveCsvRowEdit,
	parseCsv,
	rawRowText,
	renameCsvColumn,
	reorderCsvColumns,
	rowSpan,
	sortCsvRowsEdit,
	type CsvDelimiter,
	type CsvTextEdit,
	type Table,
} from "../src/shared/csv";
import {
	checkedUse,
	codeCheckSaid,
	codeCheckTotals,
	firstRowRefusal,
	NO_SUGGESTION,
	scanValuesInTurn,
	stepSuggestionMark,
	suggestionTaken,
	type CodeCheckTally,
	type SuggestionEvent,
	type SuggestionMark,
} from "../src/shared/tablePower";

const base = realpathSync(mkdtempSync(join(tmpdir(), "ssl-studio-p4m-tables-")));
afterAll(() => rmSync(base, { recursive: true, force: true }));

const readSrc = (rel: string) => readFileSync(join(import.meta.dir, rel), "utf8").replace(/\r\n/g, "\n");
const count = (text: string, part: string) => text.split(part).length - 1;

/** The text with the edits made, as an editor makes them: none overlapping, each on the text as it was. */
function apply(text: string, edits: readonly CsvTextEdit[]): string {
	let out = "";
	let from = 0;
	for (const edit of [...edits].sort((a, b) => a.start - b.start || a.end - b.end)) {
		out += text.slice(from, edit.start) + edit.text;
		from = edit.end;
	}
	return out + text.slice(from);
}

/** The table as the view reads a file on Auto: by its name and its first record. */
const readAuto = (text: string, path: string, hasHeader: boolean) => parseCsv(text, { hasHeader, prefer: csvDelimiterForPath(path) });
const cellsOf = (t: Table) => ({ header: t.hasHeader === false ? null : t.header.map((c) => c.text), rows: t.rows.map((r) => r.map((c) => c.text)) });

/** One edit as the view makes it: worked out on the table as read, then asked of the rule. Null when it is refused. */
function edited(text: string, path: string, t: Table, edits: CsvTextEdit[]): string | null {
	const kept = csvEditsKeepingDelimiter(text, edits, t.delimiter, csvDelimiterForPath(path));
	return kept ? apply(text, kept) : null;
}

describe("P9: no edit of a table changes what its file is read with", () => {
	test("a value with a comma typed into the first row of a semicolon table with no header row is quoted, and the next edit lands in its own row", () => {
		const path = "/w/registries/people.csv";
		let text = "1;Ann;lab\n2;Bob;office\n";
		let t = readAuto(text, path, false);
		expect(t.delimiter).toBe(";");
		// What the view wrote before: the cell as any cell of a semicolon file, the comma bare.
		const written = cellChangeEdit(t.rows[0]!, 1, "Smith, John", t.delimiter)!;
		expect(csvDelimiterOf(apply(text, [written]))).toBe(",");
		text = edited(text, path, t, [written])!;
		expect(text).toBe('1;"Smith, John";lab\n2;Bob;office\n');
		t = readAuto(text, path, false);
		expect(t.delimiter).toBe(";");
		expect(cellsOf(t).rows).toEqual([
			["1", "Smith, John", "lab"],
			["2", "Bob", "office"],
		]);
		// Tab went on to the next cell and the next value was typed: on the comma reading that was "the first cell
		// of row 2", which is the whole line, and Bob's row was gone.
		text = edited(text, path, t, [cellChangeEdit(t.rows[1]!, 2, "lab 2", t.delimiter)!])!;
		expect(text).toBe('1;"Smith, John";lab\n2;Bob;lab 2\n');
	});

	test("a sort, a move and a delete that put another row first write that row as a first record", () => {
		// Sort: the row holding a bare comma comes first.
		{
			const text = "2;Bob;y\n1;Smith, John;x\n";
			const t = readAuto(text, "people.csv", false);
			const out = edited(text, "people.csv", t, [sortCsvRowsEdit(text, t, [1, 0])!])!;
			expect(out).toBe('1;"Smith, John";x\n2;Bob;y\n');
			expect(cellsOf(readAuto(out, "people.csv", false)).rows).toEqual([
				["1", "Smith, John", "x"],
				["2", "Bob", "y"],
			]);
		}
		// Move: a row of a pipe-separated file that holds a semicolon goes to the top.
		{
			const text = "a|b\nc; d|e\n";
			const t = readAuto(text, "x.csv", false);
			expect(t.delimiter).toBe("|");
			const out = edited(text, "x.csv", t, [moveCsvRowEdit(text, t, 1, 0)!])!;
			expect(out).toBe('"c; d"|e\na|b\n');
			expect(readAuto(out, "x.csv", false).delimiter).toBe("|");
		}
		// Delete of the first row, as one row (a range) and as selected rows (the whole text).
		{
			const text = "a;b\nc, d;e\nf;g\n";
			const t = readAuto(text, "x.csv", false);
			const span = rowSpan(text, t, 0)!;
			expect(edited(text, "x.csv", t, [{ ...span, text: "" }])).toBe('"c, d";e\nf;g\n');
			const whole = csvTextKeepingDelimiter(text, deleteCsvRows(text, t, [0])!, t.delimiter);
			expect(whole).toBe('"c, d";e\nf;g\n');
			expect(cellsOf(readAuto(whole!, "x.csv", false)).rows).toEqual([
				["c, d", "e"],
				["f", "g"],
			]);
		}
		// A tab-separated .csv: the row moved first holds a comma.
		{
			const text = "1\tAnn\n2\tSmith, John\n";
			const t = readAuto(text, "data.csv", false);
			expect(t.delimiter).toBe("\t");
			const out = edited(text, "data.csv", t, [moveCsvRowEdit(text, t, 1, 0)!])!;
			expect(out).toBe('2\t"Smith, John"\n1\tAnn\n');
		}
	});

	test("only the cells that make the difference are quoted, and an edit of another row is given back as it was", () => {
		const text = "a|b;x;y\r\n1;2;3\r\n";
		const t = readAuto(text, "t.csv", false);
		expect(t.delimiter).toBe(";");
		// `a|b` says nothing against a semicolon and stays as it is beside the cell that is quoted.
		expect(edited(text, "t.csv", t, [cellChangeEdit(t.rows[0]!, 1, "Smith, John", ";")!])).toBe('a|b;"Smith, John";y\r\n1;2;3\r\n');
		// An edit that begins after the first record: the same list comes back, not a copy and not another edit.
		const below = [cellChangeEdit(t.rows[1]!, 1, "Smith, John", ";")!];
		expect(csvEditsKeepingDelimiter(text, below, ";")).toBe(below);
		expect(apply(text, below)).toBe("a|b;x;y\r\n1;Smith, John;3\r\n");
		// One that touches the first record and leaves it saying the same comes back as it was too.
		const plain = [cellChangeEdit(t.rows[0]!, 2, "z", ";")!];
		expect(csvEditsKeepingDelimiter(text, plain, ";")).toBe(plain);
	});

	test("the one edit that carries the quoting does not split a CRLF, and nothing outside the first record is written", () => {
		// Two edits at once (a paste over two rows): the first row's cell is quoted, the second row's is as it was written.
		const text = "1;Ann\r\n2;Bob\r\n3;Cy\r\n";
		const t = readAuto(text, "t.csv", false);
		const edits = [cellChangeEdit(t.rows[0]!, 1, "A, B", ";")!, cellChangeEdit(t.rows[1]!, 1, "C, D", ";")!];
		const kept = csvEditsKeepingDelimiter(text, edits, ";")!;
		// The first row's edit with its quoting, and the second row's as it was given: an edit below the first record is not made part of it.
		expect(kept).toHaveLength(2);
		expect(kept[1]).toBe(edits[1]!);
		const [one] = kept as [CsvTextEdit, CsvTextEdit];
		expect(apply(text, kept)).toBe('1;"A, B"\r\n2;C, D\r\n3;Cy\r\n');
		// The row that was not touched is outside the edit.
		expect(one.end).toBeLessThanOrEqual(text.indexOf("3;Cy") - 2);
		expect(text.slice(one.start - 1, one.start + 1)).not.toBe("\r\n");
		expect(text.slice(one.end - 1, one.end + 1)).not.toBe("\r\n");
	});

	test("an edit that would leave one cell first in a file not separated by commas is refused, and said why", () => {
		// The row below the first has one cell: with the first deleted, nothing says "semicolons", and the row after
		// it (`d, e;f`) would be read as two cells split at its comma.
		const text = "a;b\nc\nd, e;f\n";
		const t = readAuto(text, "x.csv", false);
		const span = rowSpan(text, t, 0)!;
		expect(csvEditsKeepingDelimiter(text, [{ ...span, text: "" }], t.delimiter)).toBeNull();
		expect(csvTextKeepingDelimiter(text, deleteCsvRows(text, t, [0])!, t.delimiter)).toBeNull();
		// So is a sort or a move that puts the short row first.
		expect(csvEditsKeepingDelimiter(text, [moveCsvRowEdit(text, t, 1, 0)!], t.delimiter)).toBeNull();
		// And a column deleted down to one, with a header row: `note` alone names no delimiter.
		const two = "id;note\n1;tea, coffee\n";
		const withHeader = readAuto(two, "x.csv", true);
		const without = deleteCsvColumn(two, withHeader, 0)!;
		expect(without).toBe("note\ntea, coffee\n");
		expect(readAuto(without, "x.csv", true).rows[0]!.map((c) => c.text)).toEqual(["tea", " coffee"]);
		expect(csvTextKeepingDelimiter(two, without, ";")).toBeNull();
		// The same edits of a comma-separated file are made: one cell is read as comma-separated, which it is.
		const commas = "a,b\nc\n";
		const tc = readAuto(commas, "x.csv", false);
		expect(csvEditsKeepingDelimiter(commas, [{ ...rowSpan(commas, tc, 0)!, text: "" }], ",")).not.toBeNull();
		// What the view says.
		expect(firstRowRefusal(";")).toBe(
			"Not done: the file's first row would be left with one cell, and the file would then be read as comma-separated, not semicolon-separated. To do this, convert the file's delimiter to commas first.",
		);
		expect(firstRowRefusal("\t")).toContain("not tab-separated");
		expect(firstRowRefusal("|")).toContain("not pipe-separated");
	});

	test("a table with no row left, and a file the view was set to read against its first record, are let through", () => {
		// Every row deleted: no cell is left to misread.
		const text = "a;b\nc;d\n";
		const t = readAuto(text, "x.csv", false);
		expect(csvTextKeepingDelimiter(text, deleteCsvRows(text, t, [0, 1])!, ";")).toBe("");
		// A file whose first record has one cell, read with semicolons because the view was set to: the record did not
		// say "semicolons" before the edit, and the edit is not held to making it say so.
		const set = "title\na;b\n";
		expect(csvDelimiterOf(set)).toBe(",");
		const read = parseCsv(set, { delimiter: ";", hasHeader: false });
		const edit = [cellChangeEdit(read.rows[0]!, 0, "x|y", ";")!];
		expect(csvEditsKeepingDelimiter(set, edit, ";")).toBe(edit);
		// A .tsv is tab-separated by its name while its first record holds a tab, whatever else it holds.
		const tsv = "id\tname\n1\tAnn\n";
		const tt = readAuto(tsv, "people.tsv", false);
		const typed = [cellChangeEdit(tt.rows[0]!, 1, "Last, First", "\t")!];
		expect(csvEditsKeepingDelimiter(tsv, typed, "\t", csvDelimiterForPath("people.tsv"))).toBe(typed);
		expect(readAuto(apply(tsv, typed), "people.tsv", false).delimiter).toBe("\t");
	});

	test("random tables in every delimiter, random cells full of the others, every kind of edit: the same delimiter and the cells that were meant", () => {
		let seed = 20261125;
		const rnd = () => (seed = (seed * 1664525 + 1013904223) >>> 0) / 0x100000000;
		const int = (n: number) => Math.floor(rnd() * n);
		const pick = <T,>(list: readonly T[]): T => list[int(list.length)]!;
		const DELIMS: CsvDelimiter[] = [",", ";", "|", "\t"];
		const BITS = ["a", "b", "Smith", "John", " ", ",", ";", "|", "\t", '"', "x", "1", ", ", "; ", "\n", "é", "😀"];
		const word = () => {
			let s = "";
			for (let i = int(4); i > 0; i--) s += pick(BITS);
			return s;
		};
		const KINDS = ["cell", "cells", "sort", "move", "deleteRows", "deleteRow", "insert", "append", "addCol", "renameCol", "deleteCol", "reorder", "duplicate"] as const;
		const made: Record<string, number> = {};
		let refused = 0;
		let quoted = 0;
		let flippedWithoutTheRule = 0;
		const wrong: string[] = [];
		for (let round = 0; round < 2500 && wrong.length < 3; round++) {
			const D = pick(DELIMS);
			const path = (D === "\t" && rnd() < 0.5) || rnd() < 0.1 ? "t.tsv" : "t.csv";
			const prefer = csvDelimiterForPath(path);
			const hasHeader = rnd() < 0.4;
			const cols = 1 + int(4);
			const eol = rnd() < 0.3 ? "\r\n" : "\n";
			const lines: string[] = [];
			for (let r = 1 + int(5) + (hasHeader ? 1 : 0); r > 0; r--) {
				const vals = Array.from({ length: rnd() < 0.2 ? 1 + int(cols + 1) : cols }, word);
				lines.push(lines.length === 0 ? (vals.length === 1 && vals[0] === "" ? '""' : vals.map((v) => csvFirstRecordCell(v, D)).join(D)) : csvRow(vals, D));
			}
			let text = (rnd() < 0.1 ? "\uFEFF" : "") + (rnd() < 0.1 ? eol : "") + lines.join(eol) + (rnd() < 0.8 ? eol : "");
			// A table that Auto reads with D: that is the one the rule is asked to keep.
			if (csvDelimiterOf(text, prefer) !== D) continue;
			for (let step = 0; step < 6; step++) {
				const t = readAuto(text, path, hasHeader);
				const nr = t.rows.length;
				const nc = t.header.length;
				const kind = pick(KINDS);
				let edits: CsvTextEdit[] | null = null;
				let whole: string | null = null;
				const at = (e: { offset: number; text: string } | null) => (e ? [{ start: e.offset, end: e.offset, text: e.text }] : null);
				if (kind === "cell" && nr) {
					const e = cellChangeEdit(t.rows[int(nr)]!, int(nc + 1), word(), D);
					if (e) edits = [e];
				} else if (kind === "cells" && nr) {
					// A paste or a fill: one value down a column, short rows padded up to it.
					const col = int(nc + 1);
					const value = word();
					const list = t.rows.flatMap((cells) => (rnd() < 0.6 ? [cellChangeEdit(cells, col, value, D)] : [])).filter((e): e is CsvTextEdit => e !== null);
					if (list.length) edits = list;
				} else if (kind === "sort" && nr > 1) {
					const e = sortCsvRowsEdit(text, t, Array.from({ length: nr }, (_, i) => i).sort(() => rnd() - 0.5));
					if (e) edits = [e];
				} else if (kind === "move" && nr > 1) {
					const e = moveCsvRowEdit(text, t, int(nr), int(nr));
					if (e) edits = [e];
				} else if (kind === "deleteRows" && nr) {
					whole = deleteCsvRows(text, t, Array.from({ length: nr }, (_, i) => i).filter(() => rnd() < 0.4));
				} else if (kind === "deleteRow" && nr) {
					const span = rowSpan(text, t, int(nr));
					if (span) edits = [{ ...span, text: "" }];
				} else if (kind === "insert" && nr && nc) {
					// The blank row as the view writes it.
					edits = at(insertRowEdit(text, t, int(nr), rnd() < 0.5 ? "above" : "below", nc > 1 ? csvRow(t.header.map(() => ""), D) : '""', eol));
				} else if (kind === "append" && nc) {
					edits = at(appendRowEdit(text, t.header.map((_, i) => (i === 0 ? word() || "v" : "")), D, eol));
				} else if (kind === "addCol") {
					whole = addCsvColumn(text, t, word().trim() || "n", word());
				} else if (kind === "renameCol" && nc) {
					whole = renameCsvColumn(text, t, int(nc), word().trim() || "n");
				} else if (kind === "deleteCol" && nc > 1) {
					whole = deleteCsvColumn(text, t, int(nc));
				} else if (kind === "reorder" && nc > 1) {
					whole = reorderCsvColumns(text, t, Array.from({ length: nc }, (_, i) => i).sort(() => rnd() - 0.5));
				} else if (kind === "duplicate" && nr) {
					const row = int(nr);
					const raw = rawRowText(text, t, row);
					edits = raw === null ? null : at(insertRowEdit(text, t, row, "below", raw, eol));
				}
				if (!edits && whole === null) continue;
				// The edit as it was written before, and the cells it means the table to have.
				const plain = edits ? apply(text, edits) : whole!;
				if (plain === text) continue;
				const meant = cellsOf(parseCsv(plain, { delimiter: D, hasHeader }));
				const firstPlain = parseCsv(plain, { delimiter: D, hasHeader: false }).rows[0];
				if (firstPlain && csvDelimiterOf(plain, prefer) !== D) flippedWithoutTheRule++;
				const kept = edits ? csvEditsKeepingDelimiter(text, edits, D, prefer) : csvTextKeepingDelimiter(text, plain, D, prefer);
				const say = (what: string, next?: string) =>
					wrong.push(`${what}: ${kind} in a ${JSON.stringify(D)} ${path}${hasHeader ? " with a header row" : ""}\n  before ${JSON.stringify(text)}\n  plain  ${JSON.stringify(plain)}${next === undefined ? "" : `\n  kept   ${JSON.stringify(next)}`}`);
				if (kept === null) {
					refused++;
					// Refused only where no quoting could do it: one cell first, in a file not separated by commas.
					if (!(firstPlain && firstPlain.length === 1 && D !== ",")) say("refused without cause");
					continue;
				}
				const next = typeof kept === "string" ? kept : apply(text, kept);
				made[kind] = (made[kind] ?? 0) + 1;
				if (next === plain) {
					// Nothing to quote: the edits come back as the list they were, and the text as it was to be.
					if (typeof kept !== "string" && kept !== edits) say("another list for the same edits", next);
				} else {
					quoted++;
					// Only the first record differs from what was written before: all below it is the same, to the character.
					const firstNext = parseCsv(next, { delimiter: D, hasHeader: false }).rows[0]!;
					if (next.slice(firstNext.at(-1)!.end) !== plain.slice(firstPlain!.at(-1)!.end) || next.slice(0, firstNext[0]!.start) !== plain.slice(0, firstPlain![0]!.start)) say("text outside the first record changed", next);
				}
				if (!firstPlain) break;
				const reread = readAuto(next, path, hasHeader);
				if (reread.delimiter !== D) say(`read with ${JSON.stringify(reread.delimiter)}`, next);
				else if (JSON.stringify(cellsOf(reread)) !== JSON.stringify(meant)) say("other cells", next);
				text = next;
			}
		}
		expect(wrong).toEqual([]);
		// The generator reaches the defect (these edits changed the file's delimiter as they were written before),
		// every kind of edit was made, and some were refused.
		expect(flippedWithoutTheRule).toBeGreaterThan(150);
		expect(quoted).toBeGreaterThan(50);
		expect(refused).toBeGreaterThan(50);
		for (const kind of KINDS) expect(made[kind] ?? 0).toBeGreaterThan(200);
	});

	test("held by source text: every write of the table's text in TableView.tsx asks the rule first, except the convert that means to change the delimiter", () => {
		const tv = readSrc("../src/view/editor/TableView.tsx");
		// The one asker, on the delimiter the text is read with now and the file's name. (No writer has the whole text to
		// ask about any more: column and row changes are edits of the places they touch.)
		expect(tv).toContain("const kept = csvEditsKeepingDelimiter(raw, edits, readWith, csvDelimiterForPath(props.path));");
		expect(tv).not.toContain("csvTextKeepingDelimiter(");
		// A refusal says why and offers the convert that makes the edit possible.
		expect(count(tv, "sayNotDone(readWith);")).toBe(1);
		expect(tv).toContain('notify(firstRowRefusal(readWith), "info", { label: "Convert…", run: () => void (disposed || convertDelimiterInteractive()) });');
		// Twelve places write the model's text. Nine ask themselves; `applyTextEdit`, `applyTextEdits` and `applyFullText` are asked for by their callers.
		expect(count(tv, "model.pushEditOperations(")).toBe(12);
		for (const asked of [
			"keptEdits(coalesceZeroWidthEdits(cellEdits))", // fill, clear, replace, Ctrl+Enter over a selection; and paste
			"keptEdits([written])", // one cell
			"keptEdits([{ start: appended.offset, end: appended.offset, text: appended.text }])", // the blank last row
			"keptEdits([moved])",
			"keptEdits([sorted])",
			"keptEdits([{ start: inserted.offset, end: inserted.offset, text: inserted.text }])", // insert, duplicate
			'keptEdits([{ start: span.start, end: span.end, text: "" }])', // delete one row
			"keptEdits(cellEdits)", // one value for the selected rows
			"keptEdits(coalesceZeroWidthEdits(rawEdits))", // schema sync
			"keptEdits(deleted)",
			"keptEdits(added)",
			"keptEdits(renamed)",
			"keptEdits(without)",
			"keptEdits(reordered)",
		])
			expect(tv).toContain(asked);
		expect(count(tv, "keptEdits(coalesceZeroWidthEdits(cellEdits))")).toBe(2);
		expect(count(tv, "keptEdits([{ start: inserted.offset, end: inserted.offset, text: inserted.text }])")).toBe(2);
		expect(count(tv, "applyTextEdit(edit);")).toBe(2);
		// One caller of `applyFullText`, the convert; five of `applyTextEdits`, each with what `keptEdits` gave.
		expect(count(tv, "applyFullText(")).toBe(1);
		expect(count(tv, "applyTextEdits(edits")).toBe(5);
		expect(tv).toMatch(/does not ask `keptEdits`[^\n]*\n(?:\t\t\/\/[^\n]*\n)*\t\tapplyFullText\(next, `Converted file delimiter to /);
		// A move or a sort that is refused changes nothing in the view: the rule is asked before anything is remapped.
		expect(tv.indexOf("keptEdits([moved])")).toBeLessThan(tv.indexOf("remapped.add(remapIndexAfterMove(r, fromRow, toRow))"));
		expect(tv).toMatch(/const edit = keptEdits\(\[sorted\]\)\?\.\[0\];\n\t\tif \(!edit\) return;\n\t\tsetOrder\(\[\]\);/);
	});
});

describe("P8: a suggestion is taken only when the user chose it", () => {
	const run = (events: SuggestionEvent[], from: SuggestionMark = NO_SUGGESTION) => events.reduce(stepSuggestionMark, from);
	const pointer = (index: number, screenX: number, screenY: number): SuggestionEvent => ({ kind: "pointer", index, screenX, screenY });
	const options = ["XXX typed", "YYY", "ZZZ"];

	test("a list that opens under a resting pointer marks nothing, and Enter writes what was typed", () => {
		// The cell is opened; the list is drawn under the pointer, which the web view reports over suggestion 0.
		let mark = run([{ kind: "shown" }, pointer(0, 400, 300)]);
		expect(mark.index).toBe(-1);
		// `y` is typed: the list is made anew, and the suggestion now under the pointer is "entered" again.
		mark = run([{ kind: "shown" }, pointer(0, 400, 300), pointer(0, 400, 300)], mark);
		expect(mark.index).toBe(-1);
		expect(suggestionTaken(mark, options, true)).toBeUndefined();
		// As it was: the first report marked the suggestion, and Enter took it.
		expect(suggestionTaken({ index: 0 }, options, true)).toBe("XXX typed");
	});

	test("a pointer that moves onto a suggestion marks it, and a click needs no mark", () => {
		const mark = run([{ kind: "shown" }, pointer(1, 400, 300), pointer(1, 402, 301)]);
		expect(mark.index).toBe(1);
		expect(suggestionTaken(mark, options, true)).toBe("YYY");
		// Moving on to another suggestion marks that one.
		expect(run([pointer(2, 402, 330)], mark).index).toBe(2);
		// A closed list gives nothing, whatever is marked.
		expect(suggestionTaken(mark, options, false)).toBeUndefined();
	});

	test("typing takes the mark away, and the pointer resting where it was does not put it back", () => {
		const pointed = run([{ kind: "shown" }, pointer(1, 400, 300), pointer(1, 402, 301)]);
		expect(pointed.index).toBe(1);
		const typed = run([{ kind: "shown" }, pointer(0, 402, 301), pointer(0, 402, 301)], pointed);
		expect(typed.index).toBe(-1);
		// A real move afterwards marks again.
		expect(run([pointer(0, 403, 301)], typed).index).toBe(0);
	});

	test("a pointer that left the list and rests elsewhere does not mark what is drawn under it next", () => {
		// Seen at (400,300) over the list; then it leaves, and moves on where no suggestion reports it.
		const left = run([{ kind: "shown" }, pointer(0, 400, 300), pointer(0, 401, 300), { kind: "left" }]);
		expect(left.index).toBe(0);
		expect(left.pointerAt).toBeNull();
		// The list grows after a letter and a suggestion is drawn under the pointer where it now rests: one report,
		// from another place than the last one seen. It is not a move.
		const redrawn = run([{ kind: "shown" }, pointer(2, 400, 420)], left);
		expect(redrawn.index).toBe(-1);
		// The same without the pointer having been reported as leaving: the place is forgotten when the list is made anew.
		expect(run([{ kind: "shown" }, pointer(1, 400, 300), { kind: "shown" }, pointer(2, 400, 420)]).index).toBe(-1);
	});

	test("the arrow keys mark, wrap around, and keep their mark when the list scrolls under a resting pointer", () => {
		const down = (n: number): SuggestionEvent => ({ kind: "arrow", key: "ArrowDown", count: n });
		const up = (n: number): SuggestionEvent => ({ kind: "arrow", key: "ArrowUp", count: n });
		expect(run([{ kind: "shown" }, down(3)]).index).toBe(0);
		expect(run([{ kind: "shown" }, down(3), down(3), down(3), down(3)]).index).toBe(0);
		expect(run([{ kind: "shown" }, up(3)]).index).toBe(2);
		expect(run([{ kind: "shown" }, down(3), up(3)]).index).toBe(2);
		expect(suggestionTaken(run([{ kind: "shown" }, down(3), down(3)]), options, true)).toBe("YYY");
		// The marked suggestion is scrolled into view, and another one comes to lie under the pointer.
		expect(run([{ kind: "shown" }, pointer(0, 400, 300), down(3), down(3), pointer(0, 400, 300)]).index).toBe(1);
		// Even when the pointer had gone elsewhere unseen: the first report after an arrow key only says where it is.
		expect(run([{ kind: "shown" }, pointer(0, 400, 300), down(3), down(3), pointer(2, 400, 360)]).index).toBe(1);
		// No suggestions: nothing to mark.
		expect(run([{ kind: "shown" }, down(0)]).index).toBe(-1);
	});

	test("held by source text: both editors and the list in TableView.tsx go through the rule", () => {
		const tv = readSrc("../src/view/editor/TableView.tsx");
		// The mark is written in one place.
		expect(count(tv, "setPickerIdx(")).toBe(1);
		expect(tv).toContain("const next = stepSuggestionMark({ index, pointerAt: pickerPointerAt }, event);");
		// Reports of the pointer, both kinds, and its leaving.
		expect(tv).toContain('onMouseEnter={(e) => stepPicker({ kind: "pointer", index: idx(), screenX: e.screenX, screenY: e.screenY })}');
		expect(tv).toContain('onMouseMove={(e) => stepPicker({ kind: "pointer", index: idx(), screenX: e.screenX, screenY: e.screenY })}');
		expect(tv).toContain('onMouseLeave={() => stepPicker({ kind: "left" })}');
		expect(tv).not.toContain("onMouseEnter={() => setPickerIdx(idx())}");
		// The cell editor and the new-row editor: typing, the arrows, and Enter, Tab and Ctrl+Enter.
		expect(count(tv, 'stepPicker({ kind: "shown" });')).toBe(4);
		expect(count(tv, 'stepPicker({ kind: "arrow", key: "ArrowDown", count: opts.length });')).toBe(2);
		expect(count(tv, 'stepPicker({ kind: "arrow", key: "ArrowUp", count: opts.length });')).toBe(2);
		expect(count(tv, "const chosen = suggestionTaken({ index: pickerIdx() }, opts, pickerOpen());")).toBe(5);
		expect(tv).not.toContain("pickerIdx() >= 0 ? opts[pickerIdx()]");
	});
});

describe("P5: a scan that ran out of time is not a count", () => {
	/**
	 * The backend as a scan meets it: one thread, so a scan takes its own time for every scan that runs beside it,
	 * and gives back what it has when its budget runs out. `uses` is what a scan that reads every file finds.
	 */
	function oneThread(uses: Record<string, number>, alone = 900, budget = 5000) {
		let running = 0;
		const asked: string[] = [];
		const scan = async (term: string) => {
			asked.push(term);
			running++;
			// Every scan that was started in the same turn is running by now.
			await new Promise((r) => setTimeout(r, 0));
			const took = alone * running;
			await new Promise((r) => setTimeout(r, 0));
			running--;
			return took > budget ? { hits: [], timedOut: true } : { hits: Array.from({ length: uses[term] ?? 0 }, () => ({})), timedOut: false };
		};
		return { scan, asked };
	}
	const tally = (): CodeCheckTally => ({ counts: new Map(), unfinished: new Map() });
	const lower = (term: string) => term.toLowerCase();
	const TERMS = ["DUE_SOON", "NOPE_A", "NOPE_B", "NOPE_C", "NOPE_D", "NOPE_E"];

	test("six scans side by side all run out of time; one after another each reads every file", async () => {
		// As the check ran them: six at once, the list of hits taken for the count.
		const side = oneThread({ DUE_SOON: 1 });
		const was = await Promise.all(TERMS.map((term) => side.scan(term)));
		expect(was.every((r) => r.timedOut && r.hits.length === 0)).toBe(true);
		// As it runs them now.
		const turn = oneThread({ DUE_SOON: 1 });
		const found = tally();
		const progress: number[] = [];
		expect(await scanValuesInTurn(TERMS, lower, turn.scan, found, () => false, (done) => progress.push(done))).toBe(6);
		expect([...found.counts]).toEqual([
			["due_soon", 1],
			["nope_a", 0],
			["nope_b", 0],
			["nope_c", 0],
			["nope_d", 0],
			["nope_e", 0],
		]);
		expect(found.unfinished.size).toBe(0);
		expect(progress).toEqual([1, 2, 3, 4, 5, 6]);
		expect(turn.asked).toEqual(TERMS);
		expect(codeCheckSaid("name", found)).toBe("Checked “name”: 5 of 6 not found in code.");
	});

	test("a scan that runs out of time alone is filed as unfinished: never 0 uses, never a count", async () => {
		// A workspace too large for the budget: every scan is cut short. One had found something by then.
		const scan = async (term: string) => ({ hits: term === "DUE_SOON" ? [{}, {}] : [], timedOut: true });
		const found = tally();
		await scanValuesInTurn(["DUE_SOON", "RUSH_FEE"], lower, scan, found);
		expect(found.counts.size).toBe(0);
		expect([...found.unfinished]).toEqual([
			["due_soon", 2],
			["rush_fee", 0],
		]);
		expect(checkedUse("rush_fee", found, 2000)).toEqual({ state: "unknown" });
		expect(checkedUse("due_soon", found, 2000)).toEqual({ state: "found", count: 2, text: "2+", atLeast: true });
		expect(checkedUse("not_checked", found, 2000)).toBeNull();
		expect(codeCheckTotals(found)).toEqual({ found: 1, missing: 0, unknown: 1 });
		expect(codeCheckSaid("name", found)).toBe("Checked “name”: all 1 found in code. 1 value was not checked: the search ran out of time before it had read every file.");
		// Nothing known at all.
		const none = tally();
		await scanValuesInTurn(["RUSH_FEE", "LATE_FEE"], lower, async () => ({ hits: [], timedOut: true }), none);
		expect(codeCheckTotals(none)).toEqual({ found: 0, missing: 0, unknown: 2 });
		expect(codeCheckSaid("name", none)).toBe("Could not check “name”: the search ran out of time before it had read every file.");
		expect(codeCheckSaid("name", none, true)).toBe("Stopped checking “name”: the search ran out of time before it had read every file.");
	});

	test("complete counts read as before", () => {
		const found: CodeCheckTally = { counts: new Map([["a", 0], ["b", 3], ["c", 2000]]), unfinished: new Map() };
		expect(checkedUse("a", found, 2000)).toEqual({ state: "missing" });
		expect(checkedUse("b", found, 2000)).toEqual({ state: "found", count: 3, text: "3", atLeast: false });
		expect(checkedUse("c", found, 2000)).toEqual({ state: "found", count: 2000, text: "2000+", atLeast: true });
		expect(codeCheckTotals(found)).toEqual({ found: 2, missing: 1, unknown: 0 });
		expect(codeCheckSaid("name", found)).toBe("Checked “name”: 1 of 3 not found in code.");
		expect(codeCheckSaid("name", { counts: new Map([["a", 0]]), unfinished: new Map([["b", 0], ["c", 0]]) })).toBe(
			"Checked “name”: 1 of 1 not found in code. 2 values were not checked: the search ran out of time before it had read every file.",
		);
	});

	test("a value of which nothing was found is looked for once more when another scan of the run did finish, and not when none did", async () => {
		// The first scan reads the files cold and is cut short; the next ones finish.
		const asked: string[] = [];
		const cold = async (term: string) => {
			asked.push(term);
			return asked.length === 1 ? { hits: [], timedOut: true } : { hits: term === "DUE_SOON" ? [{}] : [], timedOut: false };
		};
		const found = tally();
		const progress: number[] = [];
		await scanValuesInTurn(["DUE_SOON", "NOPE_A"], lower, cold, found, () => false, (done) => progress.push(done));
		expect(asked).toEqual(["DUE_SOON", "NOPE_A", "DUE_SOON"]);
		expect([...found.counts].sort()).toEqual([
			["due_soon", 1],
			["nope_a", 0],
		]);
		expect(found.unfinished.size).toBe(0);
		expect(progress).toEqual([1, 2]);
		// No scan finished: the workspace is too large for the budget, and asking again would only take as long again.
		const again: string[] = [];
		await scanValuesInTurn(["A1", "B2"], lower, async (term) => (again.push(term), { hits: [], timedOut: true }), tally());
		expect(again).toEqual(["A1", "B2"]);
	});

	test("a value checked again is in one list only, and a stopped check files nothing more", async () => {
		// Checked to the end before; this time its scan is cut short.
		const found: CodeCheckTally = { counts: new Map([["due_soon", 4]]), unfinished: new Map([["rush_fee", 0]]) };
		await scanValuesInTurn(["DUE_SOON"], lower, async () => ({ hits: [], timedOut: true }), found);
		expect(found.counts.has("due_soon")).toBe(false);
		expect(found.unfinished.get("due_soon")).toBe(0);
		// And the other way round.
		await scanValuesInTurn(["RUSH_FEE"], lower, async () => ({ hits: [{}], timedOut: false }), found);
		expect(found.unfinished.has("rush_fee")).toBe(false);
		expect(found.counts.get("rush_fee")).toBe(1);
		// Stopped (the view was closed, or another check began) while the second value's scan was running.
		const stopped = tally();
		let scans = 0;
		const done = await scanValuesInTurn(["A1", "B2", "C3"], lower, async () => (scans++, { hits: [{}], timedOut: false }), stopped, () => scans >= 2);
		expect(done).toBe(1);
		expect([...stopped.counts]).toEqual([["a1", 1]]);
		expect(scans).toBe(2);
	});

	test("with the real backend: a scan given no time says so, and the check files nothing as 0", async () => {
		const root = join(base, "scan");
		mkdirSync(join(root, "src"), { recursive: true });
		writeFileSync(join(root, "src", "DueDates.ssl"), ':PROCEDURE DueSoon;\n\tsStatus := "DUE_SOON";\n:ENDPROC;\n');
		writeFileSync(join(root, "src", "Fees.ssl"), ':PROCEDURE Fees;\n\tsFee := "RUSH_FEE";\n\tsOther := "RUSH_FEE";\n:ENDPROC;\n');
		const files = new WorkspaceFiles(root);
		const scan = (term: string) => files.searchScan(term, { wholeWord: true });
		const budget = WorkspaceFiles.searchTimeoutMs;
		try {
			// What the check was given before: the hits alone. An empty list from a scan that read nothing.
			WorkspaceFiles.searchTimeoutMs = -1;
			expect(await files.search("DUE_SOON", { wholeWord: true })).toEqual([]);
			const cut = tally();
			await scanValuesInTurn(["DUE_SOON", "RUSH_FEE", "NEVER_USED"], lower, scan, cut);
			expect(cut.counts.size).toBe(0);
			expect([...cut.unfinished.keys()]).toEqual(["due_soon", "rush_fee", "never_used"]);
			expect(codeCheckTotals(cut)).toEqual({ found: 0, missing: 0, unknown: 3 });
			// With its time, the same check counts, and 0 means read to the end and not there.
			WorkspaceFiles.searchTimeoutMs = budget;
			const whole = tally();
			await scanValuesInTurn(["DUE_SOON", "RUSH_FEE", "NEVER_USED"], lower, scan, whole);
			expect([...whole.counts]).toEqual([
				["due_soon", 1],
				["rush_fee", 2],
				["never_used", 0],
			]);
			expect(whole.unfinished.size).toBe(0);
		} finally {
			WorkspaceFiles.searchTimeoutMs = budget;
			files.close();
		}
	});

	test("held by source text: the check in TableView.tsx runs its scans in turn and shows the three states", () => {
		const tv = readSrc("../src/view/editor/TableView.tsx");
		expect(tv).not.toContain("backend.search(");
		expect(tv).not.toContain("CONCURRENCY");
		expect(tv).toMatch(/await scanValuesInTurn\(\s*terms,\s*\(term\) => termLookupKey\(term, spec\.caseSensitive\),\s*\(term\) => backend\.searchScan\(term, options\),\s*\{ counts, unfinished \},/);
		expect(tv).toContain("notify(codeCheckSaid(colName, { counts, unfinished }, !isCurrentRun));");
		// The cell's mark, and the toolbar's: neither reads a count that a scan did not finish.
		expect(tv).toContain("const use = checkedUse(termLookupKey(term, chk.caseSensitive), chk, SEARCH_LIMIT);");
		expect(tv).toContain('{use.state === "unknown" ? "not checked" : `${use.text}×`}');
		expect(tv).toContain("return chk ? codeCheckTotals(chk) : { found: 0, missing: 0, unknown: 0 };");
		expect(tv).toContain("<Show when={checkTotals().unknown > 0}>");
		// "Only missing" still asks for a complete count of 0.
		expect(tv).toContain("return terms.some((t) => chk.counts.get(termLookupKey(t, chk.caseSensitive)) === 0);");
	});
});

describe("P5: the other readers of a scan's hits say when the scan was cut short", () => {
	/**
	 * A pure exported function of a view module, run from its own text. The modules load Monaco and the app's
	 * state; this test file keeps clear of them (the window stand-ins other test files set up depend on which file
	 * is loaded first). The function is cut out of the file, made JavaScript, and called: it is the code as written.
	 */
	function pureFunction<F>(rel: string, name: string): F {
		const src = readSrc(rel);
		const start = src.indexOf(`export function ${name}(`);
		expect(start).toBeGreaterThanOrEqual(0);
		const end = src.indexOf("\n}\n", start);
		const js = new Bun.Transpiler({ loader: "ts" }).transformSync(src.slice(start + "export ".length, end + 2));
		return new Function(`${js}\nreturn ${name};`)() as F;
	}

	test("the tidy steps' callers: \"none found\" is said only of a search that read every file", () => {
		const callersSaid = pureFunction<(lines: readonly string[], name: string, timedOut: boolean) => string>("../src/view/agent/tidy.ts", "callersSaid");
		expect(callersSaid([], "DueDates", false)).toBe("(none found in the workspace)");
		expect(callersSaid([], "DueDates", true)).toBe('(the text search for "DueDates" ran out of time before it had read every file: there may be callers, though none is listed)');
		expect(callersSaid(["DueSoon ← src/Batch.ssl:4: DoProc(\"DueSoon\")"], "DueDates", false)).toBe('DueSoon ← src/Batch.ssl:4: DoProc("DueSoon")');
		expect(callersSaid(["a", "b"], "DueDates", true)).toBe('a\nb\n(the text search for "DueDates" ran out of time before it had read every file: there may be more callers than are listed)');
		// Held by source text: the search is asked for with its flag, and the flag reaches the sentence.
		const tidy = readSrc("../src/view/agent/tidy.ts");
		expect(tidy).not.toContain("backend.search(");
		expect(tidy).toContain("const scan = await backend.searchScan(base(path), { caseSensitive: false }).catch(() => null);");
		expect(tidy).toContain("return callersSaid(lines, base(path), Boolean(scan?.timedOut));");
	});

	test("the plan's survey: a word whose search was cut short with nothing found is named, and \"Nothing matched\" is not said of it", () => {
		const surveySaid = pureFunction<(text: string, nothing: boolean, unsearched: readonly string[]) => string>("../src/view/plan/run.ts", "surveySaid");
		const NOTE = "NOT SEARCHED TO THE END (the search ran out of time before it had read every file, so these words may be in the workspace though none is listed): ";
		expect(surveySaid("Nothing in the workspace matched.", true, [])).toBe("Nothing in the workspace matched.");
		expect(surveySaid("Nothing in the workspace matched.", true, ["sample", "release"])).toBe(`${NOTE}sample, release`);
		expect(surveySaid("WHERE THE CHART'S WORDS APPEAR:\nsrc/A.ssl:3: sample", false, ["release"])).toBe(`WHERE THE CHART'S WORDS APPEAR:\nsrc/A.ssl:3: sample\n${NOTE}release`);
		expect(surveySaid("TARGET SCRIPTS:\nsrc/A.ssl: does not exist yet", false, [])).toBe("TARGET SCRIPTS:\nsrc/A.ssl: does not exist yet");
		// Held by source text.
		const run = readSrc("../src/view/plan/run.ts");
		expect(run).not.toContain("backend.search(");
		expect(run).toContain("const scan = await backend.searchScan(word, { caseSensitive: false }).catch(() => null);");
		expect(run).toContain("if (scan?.timedOut && !shown.length) unsearched.push(word);");
		expect(run).toContain("return surveySaid(formatSurvey(found), nothing, unsearched);");
	});

	test("the document panel: uses and mentions from a search that was cut short are said to be incomplete", () => {
		const note = pureFunction<(timedOut: boolean, found: number, what: "uses" | "mentions") => string>("../src/view/panels/MarkdownInspector.tsx", "unfinishedSearchNote");
		expect(note(false, 0, "uses")).toBe("");
		expect(note(false, 3, "mentions")).toBe("");
		expect(note(true, 0, "uses")).toBe("The search ran out of time before it had read every file: it is not known whether this is used in code.");
		expect(note(true, 2, "uses")).toBe("The search ran out of time before it had read every file: there may be more uses than are listed.");
		expect(note(true, 0, "mentions")).toBe("The search ran out of time before it had read every file: it is not known whether other documents mention this one.");
		expect(note(true, 1, "mentions")).toBe("The search ran out of time before it had read every file: there may be more mentions than are listed.");
		// Held by source text: both searches carry the flag to the panel, and "none found" waits for a whole search.
		const insp = readSrc("../src/view/panels/MarkdownInspector.tsx");
		expect(insp).not.toContain("backend.search(");
		expect(count(insp, "backend.searchScan(")).toBe(2);
		expect(insp).toContain("value: { ident, exclude, groups, totalFiles, totalRefs, timedOut },");
		expect(insp).toContain("<Show when={(currentSchemaUsages()?.totalFiles ?? 0) > 0 || currentSchemaUsages()?.timedOut ? currentSchemaUsages() : undefined}>");
		expect(insp).toContain('<p class="md-insp-empty">{unfinishedSearchNote(true, usages().totalFiles, "uses")}</p>');
		expect(insp).toContain('<p class="md-insp-empty">{unfinishedSearchNote(true, currentUnlinked().length, "mentions")}</p>');
		expect(insp).toMatch(/<Show when=\{!currentUnlinkedState\(\)\.timedOut\}>\s*<p class="md-insp-empty">No unlinked plain-text mentions found in other workspace docs\.<\/p>/);
	});
});
