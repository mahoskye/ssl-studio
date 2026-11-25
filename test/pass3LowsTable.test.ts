// The low findings of the third audit pass in the table editor (CSV and TSV registries). Each test runs the code
// that was changed. What sits in the view and needs a page to run (the focus, scrolling, the editor's own edits)
// is not run here; the decisions the view takes are, as the pure functions they were pulled out into.
import { describe, expect, test } from "bun:test";
import {
	cellChangeEdit,
	cellsToClipboardText,
	compareCellText,
	deleteCsvColumn,
	moveCsvRow,
	moveCsvRowEdit,
	parseClipboardGrid,
	parseCsv,
	sortCsvRows,
	sortCsvRowsEdit,
	tableToTsv,
} from "../src/shared/csv";
import {
	cellBeforeInTabOrder,
	cellSortNumber,
	compareRowsBySorts,
	compareSortValues,
	fillNotice,
	focusAfterRowsDrawn,
	generateFillSeries,
	keyActsOnCell,
	pasteFit,
	pasteNotice,
	trackedColumn,
} from "../src/shared/tablePower";

/** A small repeatable source of numbers from 0 up to 1, so that a failing case is the same case on every run. */
function seeded(seed: number): () => number {
	let s = seed;
	return () => (s = (s * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
}

const applyEdit = (text: string, edit: { start: number; end: number; text: string }) => text.slice(0, edit.start) + edit.text + text.slice(edit.end);

describe("sorting a column that holds numbers", () => {
	const up = (values: string[]) => [...values].sort(compareSortValues);
	const cell = (row: string[], col: number) => row[col] ?? "";

	test("negatives, decimals and thousands separators are ordered by their value", () => {
		expect(up(["3", "-5"])).toEqual(["-5", "3"]);
		expect(up(["2", "1.5", "1"])).toEqual(["1", "1.5", "2"]);
		expect(up(["300", "1,200"])).toEqual(["300", "1,200"]);
		// The three that text order got wrong: it had -3 before -5, 1.5 before 1.25, and 1,200 before 300.
		expect(up(["-3", "-5"])).toEqual(["-5", "-3"]);
		expect(up(["1.5", "1.25"])).toEqual(["1.25", "1.5"]);
		expect(up(["3", "-5", "1.5", "1", "2", "1,200", "300", "-3", "1.25", "1,000,000", "0"])).toEqual([
			"-5",
			"-3",
			"0",
			"1",
			"1.25",
			"1.5",
			"2",
			"3",
			"300",
			"1,200",
			"1,000,000",
		]);
	});

	test("the rows of a table are sorted so, up and down", () => {
		const rows = [["a", "3"], ["b", "-5"], ["c", "1,200"], ["d", "1.5"], ["e", "300"], ["f", "-3"]];
		const by = (down: boolean) => [...rows].sort((a, b) => compareRowsBySorts(a, b, [{ column: 1, down }], cell)).map((r) => r[1]);
		expect(by(false)).toEqual(["-5", "-3", "1.5", "3", "300", "1,200"]);
		expect(by(true)).toEqual(["1,200", "300", "3", "1.5", "-3", "-5"]);
	});

	test("what counts as a number is what the footer adds up, and no more", () => {
		expect(cellSortNumber("-5")).toBe(-5);
		expect(cellSortNumber(" 1,200 ")).toBe(1200);
		expect(cellSortNumber("1,234,567.5")).toBe(1234567.5);
		expect(cellSortNumber("007")).toBe(7);
		expect(cellSortNumber("0.50")).toBe(0.5);
		for (const text of ["", " ", "-", "+5", "1,20", "12,3456", "1.5.2", "1e5", "10%", "5 kg", "TC-001", "2026-11-23", "1.", ".5", "--5", "n/a"]) {
			expect([text, cellSortNumber(text)]).toEqual([text, null]);
		}
	});

	test("a number of more than fifteen digits is an identifier: it stays text, in the order of its digits", () => {
		expect(cellSortNumber("123456789012345")).toBe(123456789012345);
		expect(cellSortNumber("1234567890123456")).toBeNull();
		// As numbers these two are the same number, and would be left in whatever order they came in.
		expect(Number("12345678901234567892")).toBe(Number("12345678901234567891"));
		expect(up(["12345678901234567892", "9", "12345678901234567891"])).toEqual(["9", "12345678901234567891", "12345678901234567892"]);
	});

	test("a column of text is ordered as it was", () => {
		const text = ["Object_10", "Object_2", "object_2", "", " ", "a", "A", "á", "Z", "ticket-12", "ticket-3", "in progress", "found", "_under", "#hash", "x\ny", "v1.2.3", "10%", "2026-11-23", "TC-001"];
		expect(up(text)).toEqual([...text].sort(compareCellText));
		for (const a of text) for (const b of text) expect([a, b, Math.sign(compareSortValues(a, b))]).toEqual([a, b, Math.sign(compareCellText(a, b))]);
	});

	test("a mixed column: empty cells, then numbers by value, then text; going down is the same turned round", () => {
		const mixed = ["n/a", "12", "", "-3", "pending", "1,200", " ", "7", "TBD", "2.5"];
		const sorted = up(mixed);
		expect(sorted).toEqual(["", " ", "-3", "2.5", "7", "12", "1,200", "n/a", "pending", "TBD"]);
		const rows = mixed.map((v) => [v]);
		const down = [...rows].sort((a, b) => compareRowsBySorts(a, b, [{ column: 0, down: true }], cell)).map((r) => r[0]);
		expect(down).toEqual([...sorted].reverse());
		expect(down).toEqual(["TBD", "pending", "n/a", "1,200", "12", "7", "2.5", "-3", " ", ""]);
	});

	test("the order agrees with itself for any three cells of a mixed column", () => {
		const cells = ["", " ", "-5", "-3", "0", "1", "1.25", "1.5", "007", "7", "10", "300", "1,200", "-4a", "-", "_x", "#h", "10%", "1e5", "abc", "ABC", "n/a", "12345678901234567890", "1.2.3", "TC-001"];
		for (const a of cells) {
			expect(compareSortValues(a, a)).toBe(0);
			for (const b of cells) {
				expect([a, b, Math.sign(compareSortValues(a, b)) + Math.sign(compareSortValues(b, a))]).toEqual([a, b, 0]);
				for (const c of cells) {
					if (compareSortValues(a, b) <= 0 && compareSortValues(b, c) <= 0) expect([a, b, c, compareSortValues(a, c) <= 0]).toEqual([a, b, c, true]);
				}
			}
		}
	});

	test("the same number written two ways ties, and the next sort column decides", () => {
		expect(compareSortValues("007", "7")).toBe(0);
		expect(compareSortValues("1.50", "1.5")).toBe(0);
		expect(compareSortValues("1,200", "1200")).toBe(0);
		const rows = [["7", "b"], ["007", "a"], ["7.0", "c"]];
		const sorts = [{ column: 0, down: false }, { column: 1, down: true }];
		expect([...rows].sort((a, b) => compareRowsBySorts(a, b, sorts, cell))).toEqual([["7.0", "c"], ["7", "b"], ["007", "a"]]);
	});
});

describe("keys and the focus when the active cell's row is not drawn", () => {
	const key = (k: string, mods: { ctrl?: boolean; meta?: boolean; alt?: boolean; shift?: boolean } = {}) =>
		keyActsOnCell({ key: k, ctrlKey: mods.ctrl, metaKey: mods.meta, altKey: mods.alt, shiftKey: mods.shift });

	test("the keys a cell answers go to the active cell: typing, the arrows, Enter, F2, Delete, paging", () => {
		for (const k of ["a", "Z", "1", " ", "=", "é", "Enter", "F2", "Delete", "Backspace", "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "PageUp", "PageDown", "Home", "End", "ContextMenu"]) {
			expect([k, key(k)]).toEqual([k, true]);
		}
		// Shift extends a selection or types a capital; Alt+arrow moves the row or column; Ctrl+Home and Ctrl+End jump.
		expect(key("ArrowDown", { shift: true })).toBe(true);
		expect(key("A", { shift: true })).toBe(true);
		expect(key(" ", { shift: true })).toBe(true);
		expect(key("ArrowUp", { alt: true })).toBe(true);
		expect(key("Home", { ctrl: true })).toBe(true);
		expect(key("End", { meta: true, shift: true })).toBe(true);
		expect(key("Enter", { ctrl: true })).toBe(true);
		expect(key("F10", { shift: true })).toBe(true);
	});

	test("a key the cell does not answer is left to whoever else does", () => {
		for (const k of ["Shift", "Control", "Alt", "Meta", "Escape", "Tab", "F8", "F10", "F5", "CapsLock", "Dead", "Process", "Unidentified"]) {
			expect([k, key(k)]).toEqual([k, false]);
		}
		// Undo, copy, find, fill down: the table's own shortcuts, not the cell's.
		for (const k of ["z", "y", "c", "v", "x", "f", "h", "d", "r", "a"]) expect([k, key(k, { ctrl: true })]).toEqual([k, false]);
		expect(key("c", { meta: true })).toBe(false);
		expect(key("ArrowDown", { ctrl: true })).toBe(false);
		expect(key("ArrowDown", { alt: true, shift: true })).toBe(false);
		expect(key("Delete", { ctrl: true })).toBe(false);
		expect(key("Backspace", { alt: true })).toBe(false);
		expect(key("PageDown", { ctrl: true })).toBe(false);
		expect(key("Home", { alt: true })).toBe(false);
		expect(key("a", { alt: true })).toBe(false);
	});

	test("the table takes the focus when the focused cell's row is taken off the page, and gives it back", () => {
		const at = { wasInRows: false, lost: false, held: false, onTable: false, cellDrawn: false };
		// The focus was in the rows and is nowhere now: the table takes it, and holds it for the cell.
		expect(focusAfterRowsDrawn({ ...at, wasInRows: true, lost: true })).toEqual({ focus: "table", held: true });
		// Scrolled further, the cell's row still not drawn: the table keeps it, and is not focused again.
		expect(focusAfterRowsDrawn({ ...at, held: true, onTable: true })).toEqual({ focus: null, held: true });
		// The cell's row is drawn again: the cell gets the focus back.
		expect(focusAfterRowsDrawn({ ...at, held: true, onTable: true, cellDrawn: true })).toEqual({ focus: "cell", held: false });
		// What had the focus is gone, but the active cell is on the page (the row was deleted, the rows were put in
		// another order): the focus goes straight to the active cell.
		expect(focusAfterRowsDrawn({ ...at, wasInRows: true, lost: true, cellDrawn: true })).toEqual({ focus: "cell", held: false });
	});

	test("the focus is left alone when nothing was lost, or when it has gone somewhere else", () => {
		const at = { wasInRows: false, lost: false, held: false, onTable: false, cellDrawn: false };
		// An ordinary redraw with the focus still on its cell.
		expect(focusAfterRowsDrawn({ ...at, wasInRows: true, cellDrawn: true })).toEqual({ focus: null, held: false });
		// The focus was outside the rows (the filter box) while they were redrawn.
		expect(focusAfterRowsDrawn({ ...at, cellDrawn: true })).toEqual({ focus: null, held: false });
		// Nothing is focused, but the focus was not in the rows: a click on the page beside the table is not undone.
		expect(focusAfterRowsDrawn({ ...at, lost: true, cellDrawn: true })).toEqual({ focus: null, held: false });
		// The table held the focus and the user has since put it elsewhere: it is not taken back, now or later.
		expect(focusAfterRowsDrawn({ ...at, held: true, cellDrawn: true })).toEqual({ focus: null, held: false });
		// The table has the focus for another reason (after a column was renamed) and nothing was held.
		expect(focusAfterRowsDrawn({ ...at, onTable: true, cellDrawn: true })).toEqual({ focus: null, held: false });
	});

	test("Shift+Tab in the first cell stays in the first cell", () => {
		expect(cellBeforeInTabOrder(0, 0, 4)).toEqual({ visRow: 0, visCol: 0 });
		expect(cellBeforeInTabOrder(0, 0, 1)).toEqual({ visRow: 0, visCol: 0 });
		// Elsewhere it goes where it went: the cell before, and from a row's first cell the last cell of the row above.
		expect(cellBeforeInTabOrder(0, 3, 4)).toEqual({ visRow: 0, visCol: 2 });
		expect(cellBeforeInTabOrder(5, 1, 4)).toEqual({ visRow: 5, visCol: 0 });
		expect(cellBeforeInTabOrder(5, 0, 4)).toEqual({ visRow: 4, visCol: 3 });
		expect(cellBeforeInTabOrder(1, 0, 1)).toEqual({ visRow: 0, visCol: 0 });
		// A row or column that is not among those shown has no cell before it: it stays too.
		expect(cellBeforeInTabOrder(-1, 0, 4)).toEqual({ visRow: -1, visCol: 0 });
		expect(cellBeforeInTabOrder(0, -1, 4)).toEqual({ visRow: 0, visCol: -1 });
	});

	test("Shift+Tab walks every cell back to the first and stops there", () => {
		const cols = 3;
		let at = { visRow: 2, visCol: 2 };
		const seen: string[] = [];
		for (let step = 0; step < 20; step++) {
			seen.push(`${at.visRow}:${at.visCol}`);
			at = cellBeforeInTabOrder(at.visRow, at.visCol, cols);
		}
		expect(seen.slice(0, 9)).toEqual(["2:2", "2:1", "2:0", "1:2", "1:1", "1:0", "0:2", "0:1", "0:0"]);
		expect(new Set(seen.slice(8))).toEqual(new Set(["0:0"]));
	});
});

describe("a cell the row does not have", () => {
	const text = "id,name,status\n1,first\n2,second,open\n";
	const write = (row: number, column: number, value: string) => {
		const edit = cellChangeEdit(parseCsv(text).rows[row]!, column, value);
		return edit ? applyEdit(text, edit) : null;
	};

	test("emptying it, or committing it as it is, writes nothing", () => {
		// The first row has two cells of three: its `status` is shown empty. It gave "1,first," and a changed file.
		expect(parseCsv(text).rows[0]!.length).toBe(2);
		expect(write(0, 2, "")).toBeNull();
	});

	test("a value to show there gives the row the cells between", () => {
		expect(write(0, 2, "open")).toBe("id,name,status\n1,first,open\n2,second,open\n");
		const wide = "a,b,c,d\n1\n";
		expect(applyEdit(wide, cellChangeEdit(parseCsv(wide).rows[0]!, 3, "x")!)).toBe("a,b,c,d\n1,,,x\n");
		expect(cellChangeEdit(parseCsv(wide).rows[0]!, 3, "")).toBeNull();
		expect(cellChangeEdit(parseCsv(wide).rows[0]!, 1, "")).toBeNull();
	});

	test("a cell the row has is written when its text changes, and only then", () => {
		expect(write(1, 2, "open")).toBeNull();
		expect(write(1, 2, "")).toBe("id,name,status\n1,first\n2,second,\n");
		expect(write(1, 1, "has, comma")).toBe('id,name,status\n1,first\n2,"has, comma",open\n');
		expect(write(0, 1, "first")).toBeNull();
		// The only cell of a row, emptied, is written `""`: an empty line would be no row at all.
		const one = "name\nx\ny\n";
		expect(applyEdit(one, cellChangeEdit(parseCsv(one).rows[0]!, 0, "")!)).toBe('name\n""\ny\n');
	});

	test("any value written to any cell changes that cell and no other, and nothing is written for no change", () => {
		const rnd = seeded(12345);
		const pick = <T>(list: readonly T[]) => list[Math.floor(rnd() * list.length)]!;
		const atoms = ["a", "b", "1", " ", '"', ",", "\t", ";", "x y", "é", "", '""', "'"];
		const value = () => Array.from({ length: Math.floor(rnd() * 3) }, () => pick(atoms)).join("");
		let edits = 0;
		let unchanged = 0;
		for (let round = 0; round < 4000; round++) {
			const delimiter = pick([",", "\t", ";"] as const);
			const cols = 1 + Math.floor(rnd() * 4);
			const lines = [Array.from({ length: cols }, (_, i) => `h${i}`).join(delimiter)];
			const count = 1 + Math.floor(rnd() * 3);
			for (let r = 0; r < count; r++) {
				// One row in three is short of the header; a row of one cell is never an empty line.
				const length = rnd() < 0.35 ? 1 + Math.floor(rnd() * cols) : cols;
				const cells = Array.from({ length }, () => value());
				lines.push(length === 1 && cells[0] === "" ? '""' : cells.map((v) => (/[",\t;\r\n]/.test(v) || v !== v.trim() ? `"${v.replace(/"/g, '""')}"` : v)).join(delimiter));
			}
			const source = `${lines.join("\n")}\n`;
			const table = parseCsv(source, { delimiter });
			expect(table.rows.length).toBe(count);
			const row = Math.floor(rnd() * count);
			const column = Math.floor(rnd() * cols);
			const next = rnd() < 0.3 ? "" : value();
			const shown = table.rows[row]![column]?.text ?? "";
			const edit = cellChangeEdit(table.rows[row]!, column, next, delimiter);
			if (shown === next) {
				unchanged++;
				expect([source, row, column, next, edit]).toEqual([source, row, column, next, null]);
				continue;
			}
			edits++;
			const after = parseCsv(applyEdit(source, edit!), { delimiter });
			expect(after.rows.length).toBe(count);
			for (let r = 0; r < count; r++) {
				const was = table.rows[r]!;
				const now = after.rows[r]!;
				// The row written to is as long as it was, or reaches the cell written; every other row is as it was.
				expect([source, r, now.length]).toEqual([source, r, r === row ? Math.max(was.length, column + 1) : was.length]);
				for (let c = 0; c < now.length; c++) {
					expect([source, r, c, now[c]!.text]).toEqual([source, r, c, r === row && c === column ? next : (was[c]?.text ?? "")]);
				}
			}
		}
		expect(edits).toBeGreaterThan(2000);
		expect(unchanged).toBeGreaterThan(300);
	});
});

describe("moving a row and writing a sort to the file", () => {
	const blankLines = (text: string) =>
		text
			.split(/\r\n|\n/)
			.map((line, at) => (line === "" ? at : -1))
			.filter((at) => at >= 0);
	const rowTexts = (text: string) => parseCsv(text).rows.map((cells) => cells.map((c) => c.text).join("|"));

	test("a move touches the rows from the one moved to where it goes, and nothing else", () => {
		const text = "id,name\n\n1,a\n2,b\n\n3,c\n4,d\n\n\n5,e\n";
		const table = parseCsv(text);
		// Row 3,c (the third) one up: only `2,b`, the blank line between, and `3,c` are in the edit.
		const edit = moveCsvRowEdit(text, table, 2, 1)!;
		expect(text.slice(edit.start, edit.end)).toBe("2,b\n\n3,c");
		expect(edit.text).toBe("3,c\n\n2,b");
		const moved = applyEdit(text, edit);
		expect(moved).toBe("id,name\n\n1,a\n3,c\n\n2,b\n4,d\n\n\n5,e\n");
		expect(moveCsvRow(text, table, 2, 1)).toBe(moved);
		expect(blankLines(moved)).toEqual(blankLines(text));
	});

	test("blank lines elsewhere in the file are still there after one row is moved", () => {
		// It gave "id,name\n\n1,a\n2,b\n3,c\n5,e\n4,d\n": the rows written out anew, and every blank line among them gone.
		const text = "id,name\n\n1,a\n2,b\n\n3,c\n4,d\n\n\n5,e\n";
		const moved = moveCsvRow(text, parseCsv(text), 4, 3);
		expect(moved).toBe("id,name\n\n1,a\n2,b\n\n3,c\n5,e\n\n\n4,d\n");
		expect(moved.split("\n").length).toBe(text.split("\n").length);
		expect(rowTexts(moved)).toEqual(["1|a", "2|b", "3|c", "5|e", "4|d"]);
	});

	test("a move that changes nothing, or is out of bounds, is no edit", () => {
		const text = "k,v\na,1\nb,2\n";
		const table = parseCsv(text);
		expect(moveCsvRowEdit(text, table, 0, 0)).toBeNull();
		expect(moveCsvRowEdit(text, table, -1, 1)).toBeNull();
		expect(moveCsvRowEdit(text, table, 0, 2)).toBeNull();
		expect(moveCsvRowEdit(text, table, 0.5, 1)).toBeNull();
		expect(moveCsvRow(text, table, 0, 2)).toBe(text);
		const one = "k,v\na,1\n";
		expect(moveCsvRowEdit(one, parseCsv(one), 0, 0)).toBeNull();
	});

	test("every move of every row keeps the text outside the edit, the blank lines and the line ends where they were", () => {
		const rnd = seeded(20261125);
		const pick = <T>(list: readonly T[]) => list[Math.floor(rnd() * list.length)]!;
		let moves = 0;
		for (let round = 0; round < 300; round++) {
			const nl = pick(["\n", "\r\n"]);
			const count = 2 + Math.floor(rnd() * 5);
			let text = `id,note${nl}`;
			const written: string[] = [];
			for (let r = 0; r < count; r++) {
				while (rnd() < 0.3) text += nl;
				const note = pick(["plain", '"with, comma"', `"two${nl}lines"`, "", '"say ""hi"""', " spaced "]);
				written.push(`${r}|${note}`);
				text += `${r},${note}`;
				if (r < count - 1 || rnd() < 0.7) text += nl;
			}
			while (rnd() < 0.3) text += nl;
			const table = parseCsv(text);
			expect(table.rows.length).toBe(count);
			const before = table.rows.map((cells) => text.slice(cells[0]!.start, cells[cells.length - 1]!.end));
			const from = Math.floor(rnd() * count);
			const to = Math.floor(rnd() * count);
			const edit = moveCsvRowEdit(text, table, from, to);
			if (from === to) {
				expect(edit).toBeNull();
				continue;
			}
			moves++;
			const moved = applyEdit(text, edit!);
			// The edit runs from the first of the two rows to the end of the last, and no further.
			const lo = table.rows[Math.min(from, to)]!;
			const hi = table.rows[Math.max(from, to)]!;
			expect([edit!.start, edit!.end]).toEqual([lo[0]!.start, hi[hi.length - 1]!.end]);
			expect(moved.length).toBe(text.length);
			// Each row is written as it was, in the order the move gives.
			const order = before.map((_, at) => at);
			order.splice(to, 0, order.splice(from, 1)[0]!);
			const after = parseCsv(moved);
			expect(after.rows.map((cells) => moved.slice(cells[0]!.start, cells[cells.length - 1]!.end))).toEqual(order.map((at) => before[at]!));
			// What stands between the rows (line ends and blank lines) is where it was, and as it was.
			const gaps = (t: string, rows: { start: number; end: number }[][]) => rows.map((cells, at) => t.slice(at === 0 ? 0 : rows[at - 1]![rows[at - 1]!.length - 1]!.end, cells[0]!.start));
			expect(gaps(moved, after.rows)).toEqual(gaps(text, table.rows));
			expect(moved.slice(after.rows[count - 1]![after.rows[count - 1]!.length - 1]!.end)).toBe(text.slice(table.rows[count - 1]![table.rows[count - 1]!.length - 1]!.end));
		}
		expect(moves).toBeGreaterThan(150);
	});

	test("a sort written to the file is one edit from the first row that changes place to the last", () => {
		const text = "name,n\n\nb,2\na,1\n\nd,4\nc,3\n\ne,5\n";
		const table = parseCsv(text);
		// By name: the two pairs change places, `e,5` and everything before `b,2` stay.
		const edit = sortCsvRowsEdit(text, table, [1, 0, 3, 2, 4])!;
		expect(text.slice(edit.start, edit.end)).toBe("b,2\na,1\n\nd,4\nc,3");
		const sorted = applyEdit(text, edit);
		expect(sorted).toBe("name,n\n\na,1\nb,2\n\nc,3\nd,4\n\ne,5\n");
		expect(sortCsvRows(text, table, [1, 0, 3, 2, 4])).toBe(sorted);
		// Blank lines are no rows: each is on the line of the file it was on, and the rows change places around them.
		expect(blankLines(sorted)).toEqual(blankLines(text));
		expect(sortCsvRowsEdit(text, table, [0, 1, 2, 3, 4])).toBeNull();
		expect(sortCsvRowsEdit(text, table, [0, 0, 2, 3, 4])).toBeNull();
		expect(sortCsvRowsEdit(text, table, [0, 1, 2])).toBeNull();
	});

	test("a sort of a file with blank lines, CRLF line ends and no line end after the last row", () => {
		// It gave "k,v\r\na,1\r\nb,2\r\nc,3": the blank line gone.
		const text = "k,v\r\nc,3\r\n\r\na,1\r\nb,2";
		const table = parseCsv(text);
		const sorted = sortCsvRows(text, table, [1, 2, 0])!;
		expect(sorted).toBe("k,v\r\na,1\r\n\r\nb,2\r\nc,3");
		expect(rowTexts(sorted)).toEqual(["a|1", "b|2", "c|3"]);
		// A file whose line ends are mixed keeps each where it was.
		const mixed = "k,v\nc,3\r\n\na,1\r\nb,2\n";
		expect(sortCsvRows(mixed, parseCsv(mixed), [1, 2, 0])).toBe("k,v\na,1\r\n\nb,2\r\nc,3\n");
	});

	test("rows are written as they are: quotes, a cell of two lines, extra cells", () => {
		const text = 'k,v\n"B,2","two\nlines"\n"A,1",one,extra\n';
		const table = parseCsv(text);
		expect(sortCsvRows(text, table, [1, 0])).toBe('k,v\n"A,1",one,extra\n"B,2","two\nlines"\n');
		expect(moveCsvRow(text, table, 1, 0)).toBe('k,v\n"A,1",one,extra\n"B,2","two\nlines"\n');
	});
});

describe("copying cells and pasting them back", () => {
	test("the cells `a` and `` of one column come back as two rows", () => {
		// The text was "a\n": its last line end is read as the one Excel puts after its last row, and taken off.
		const text = cellsToClipboardText([["a"], [""]]);
		expect(parseClipboardGrid(text)).toEqual([["a"], [""]]);
		expect(parseClipboardGrid(cellsToClipboardText([[""], [""]]))).toEqual([[""], [""]]);
		expect(parseClipboardGrid(cellsToClipboardText([["a"], [""], [""]]))).toEqual([["a"], [""], [""]]);
		expect(parseClipboardGrid(cellsToClipboardText([[""], ["a"]]))).toEqual([[""], ["a"]]);
	});

	test("it is written as Excel writes it: a line end after the empty last row, and nothing added elsewhere", () => {
		expect(cellsToClipboardText([["a"], [""]])).toBe("a\n\n");
		// What Excel itself puts on the clipboard for those two cells is read the same.
		expect(parseClipboardGrid("a\r\n\r\n")).toEqual([["a"], [""]]);
		expect(cellsToClipboardText([["a"], ["b"]])).toBe("a\nb");
		expect(cellsToClipboardText([["a", ""], ["", ""]])).toBe("a\t\n\t");
		expect(cellsToClipboardText([["a", "b"]])).toBe("a\tb");
		expect(cellsToClipboardText([["a"]])).toBe("a");
		expect(cellsToClipboardText([])).toBe("");
	});

	test("every block of up to three rows and three columns of `a` and empty cells comes back as it was", () => {
		let blocks = 0;
		for (let rows = 1; rows <= 3; rows++) {
			for (let cols = 1; cols <= 3; cols++) {
				for (let mask = 0; mask < 1 << (rows * cols); mask++) {
					const block = Array.from({ length: rows }, (_, r) => Array.from({ length: cols }, (_, c) => ((mask >> (r * cols + c)) & 1 ? "a" : "")));
					// One empty cell alone is an empty clipboard: there is nothing to paste.
					if (rows * cols === 1 && block[0]![0] === "") continue;
					blocks++;
					expect([block, parseClipboardGrid(cellsToClipboardText(block))]).toEqual([block, block]);
				}
			}
		}
		expect(blocks).toBe(681);
	});

	test("blocks of several cells with spaces, tabs, quotes and line breaks in them come back as they were", () => {
		const values = ["", "a", " ", "x y", "\t", "a\nb", '"', 'q"q', '""', "'", "\n", " a", "a ", '"a"', "a\tb", '"a\nb"', "\n\n", '"\n'];
		const rnd = seeded(5);
		let blocks = 0;
		for (let round = 0; round < 4000; round++) {
			const rows = 1 + Math.floor(rnd() * 3);
			const cols = 1 + Math.floor(rnd() * 3);
			if (rows * cols < 2) continue;
			const block = Array.from({ length: rows }, () => Array.from({ length: cols }, () => values[Math.floor(rnd() * values.length)]!));
			blocks++;
			expect([block, parseClipboardGrid(cellsToClipboardText(block))]).toEqual([block, block]);
		}
		expect(blocks).toBeGreaterThan(3000);
	});

	test("rows copied with their header are written the same way", () => {
		expect(tableToTsv(["A", "B"], [["1", "two"]])).toBe("A\tB\n1\ttwo");
		expect(parseClipboardGrid(tableToTsv(["name"], [["x"], [""]]))).toEqual([["name"], ["x"], [""]]);
	});
});

describe("a paste that runs past the last column", () => {
	test("the columns that fit are those from where the paste starts to the last column shown", () => {
		expect(pasteFit(2, 0, 3)).toEqual({ cols: 2, leftOut: 0 });
		expect(pasteFit(3, 0, 3)).toEqual({ cols: 3, leftOut: 0 });
		expect(pasteFit(4, 1, 3)).toEqual({ cols: 2, leftOut: 2 });
		expect(pasteFit(5, 2, 3)).toEqual({ cols: 1, leftOut: 4 });
		expect(pasteFit(1, 2, 3)).toEqual({ cols: 1, leftOut: 0 });
	});

	test("the notice gives the size of what was pasted, and says what was left out", () => {
		// It said "Pasted 3 × 4 cells" for four copied columns of which two were written.
		const said = pasteNotice(3, 2, 2);
		expect(said).toBe("Pasted 3 × 2 cells (Ctrl+Z to undo). The last 2 columns copied were left out: there are no columns for them after the last one shown.");
		expect(said).not.toContain("3 × 4");
		expect(pasteNotice(2, 1, 1)).toBe("Pasted 2 × 1 cells (Ctrl+Z to undo). The last column copied was left out: there is no column for it after the last one shown.");
	});

	test("a paste that fits is said as it was", () => {
		expect(pasteNotice(3, 2, 0)).toBe("Pasted 3 × 2 cells (Ctrl+Z to undo).");
	});
});

describe("a check in code that is still running when the columns change", () => {
	test("its column is followed when a column to its left is deleted", () => {
		const text = "id,owner,note,status\n1,ann,x,open\n";
		const before = parseCsv(text);
		const status = before.header.findIndex((c) => c.text === "status");
		const running = trackedColumn(status);
		// The `owner` column is deleted while the check runs.
		const deleted = 1;
		const after = parseCsv(deleteCsvColumn(text, before, deleted)!);
		running.moved((col) => (col === deleted ? -1 : col > deleted ? col - 1 : col));
		expect(running.at()).toBe(2);
		expect(after.header[running.at()]!.text).toBe("status");
		// The place it had when the check began is another column now: the result landed there.
		expect(after.header[status]).toBeUndefined();
		expect(after.header[status - 1]!.text).toBe("status");
	});

	test("a column to its right deleted leaves it where it is; its own deletion ends it for good", () => {
		const running = trackedColumn(1);
		running.moved((col) => (col === 3 ? -1 : col > 3 ? col - 1 : col));
		expect(running.at()).toBe(1);
		running.moved((col) => (col === 1 ? -1 : col > 1 ? col - 1 : col));
		expect(running.at()).toBe(-1);
		// A later change of the columns does not bring it back as some other column.
		running.moved((col) => col + 5);
		expect(running.at()).toBe(-1);
	});

	test("it is followed when the columns are put in another order", () => {
		const running = trackedColumn(0);
		const applied = [2, 0, 1];
		running.moved((col) => applied.indexOf(col));
		expect(running.at()).toBe(1);
		running.moved(() => Number.NaN);
		expect(running.at()).toBe(-1);
	});
});

describe("filling a series with the fill handle", () => {
	test("a numbered name filled upward stops at zero: there is no TC--001", () => {
		expect(generateFillSeries(["TC-001"], 3, { reverse: true })).toEqual(["TC-000"]);
		expect(generateFillSeries(["TC-003"], 5, { reverse: true })).toEqual(["TC-002", "TC-001", "TC-000"]);
		expect(generateFillSeries(["DEMO-1"], 3, { reverse: true })).toEqual(["DEMO-0"]);
		expect(generateFillSeries(["Item 2"], 4, { reverse: true })).toEqual(["Item 1", "Item 0"]);
		expect(generateFillSeries(["TC-000"], 2, { reverse: true })).toEqual([]);
		// With a step, upward or downward: the last value is the last that is not below zero.
		expect(generateFillSeries(["DEMO-10", "DEMO-20"], 3, { reverse: true })).toEqual(["DEMO-0"]);
		expect(generateFillSeries(["TC-003", "TC-002"], 4)).toEqual(["TC-001", "TC-000"]);
	});

	test("a zero-padded number filled upward stops at zero: there is no -001", () => {
		expect(generateFillSeries(["001"], 3, { reverse: true })).toEqual(["000"]);
		expect(generateFillSeries(["003"], 2, { reverse: true })).toEqual(["002", "001"]);
		expect(generateFillSeries(["001", "002"], 3, { reverse: true })).toEqual(["000"]);
		expect(generateFillSeries(["004", "002"], 3)).toEqual(["000"]);
	});

	test("no series of names or padded numbers has a doubled minus sign or a minus before a padded number", () => {
		const seeds = [["TC-001"], ["TC-010"], ["A-0"], ["x_3"], ["Item 1"], ["#2"], ["001"], ["0005"], ["00"], ["TC-001", "TC-003"], ["TC-009", "TC-006"], ["010", "020"], ["030", "020"]];
		for (const seed of seeds) {
			for (const reverse of [false, true]) {
				const series = generateFillSeries(seed, 12, { reverse });
				for (const value of series) {
					expect([seed, value, value.includes("--")]).toEqual([seed, value, false]);
					expect([seed, value, /^-0/.test(value)]).toEqual([seed, value, false]);
				}
				expect(series.length).toBeLessThanOrEqual(12);
			}
		}
	});

	test("a plain number still counts down through zero, as in Excel and Sheets", () => {
		expect(generateFillSeries(["2"], 4, { reverse: true })).toEqual(["1", "0", "-1", "-2"]);
		expect(generateFillSeries(["10", "20"], 2, { reverse: true })).toEqual(["0", "-10"]);
		expect(generateFillSeries(["1", "3"], 3, { reverse: true })).toEqual(["-1", "-3", "-5"]);
		expect(generateFillSeries(["-3"], 2)).toEqual(["-2", "-1"]);
	});

	test("a series that does not reach zero is as long as it was asked to be", () => {
		expect(generateFillSeries(["TC-001"], 3)).toEqual(["TC-002", "TC-003", "TC-004"]);
		expect(generateFillSeries(["DEMO-105"], 2, { reverse: true })).toEqual(["DEMO-104", "DEMO-103"]);
		expect(generateFillSeries(["001"], 2)).toEqual(["002", "003"]);
		expect(generateFillSeries(["in progress"], 3, { reverse: true })).toEqual(["in progress", "in progress", "in progress"]);
	});

	test("a date written with slashes fills as a date, both ways", () => {
		// It went on to 2026/11/31, 2026/11/32: the day read as the number of a name.
		expect(generateFillSeries(["2026/11/30"], 3)).toEqual(["2026/12/01", "2026/12/02", "2026/12/03"]);
		expect(generateFillSeries(["2026/11/30"], 2, { reverse: true })).toEqual(["2026/11/29", "2026/11/28"]);
		expect(generateFillSeries(["2026/03/01"], 2, { reverse: true })).toEqual(["2026/02/28", "2026/02/27"]);
		expect(generateFillSeries(["2026/12/31"], 2)).toEqual(["2027/01/01", "2027/01/02"]);
		expect(generateFillSeries(["2028/02/28"], 2)).toEqual(["2028/02/29", "2028/03/01"]);
		// Written without leading zeros, it stays so.
		expect(generateFillSeries(["2026/1/30"], 3)).toEqual(["2026/1/31", "2026/2/1", "2026/2/2"]);
	});

	test("a date with the year last fills as a date in the order it is written in", () => {
		// The first number is over twelve: it is the day.
		expect(generateFillSeries(["30/11/2026"], 2)).toEqual(["01/12/2026", "02/12/2026"]);
		// The second is over twelve: the month came first.
		expect(generateFillSeries(["11/30/2026"], 2)).toEqual(["12/01/2026", "12/02/2026"]);
		expect(generateFillSeries(["28-02-2028"], 3)).toEqual(["29-02-2028", "01-03-2028", "02-03-2028"]);
		expect(generateFillSeries(["01/03/2026"], 1, { reverse: true, dayFirst: true })).toEqual(["28/02/2026"]);
		// Neither says: `dayFirst` does.
		expect(generateFillSeries(["01/02/2026"], 2, { dayFirst: true })).toEqual(["02/02/2026", "03/02/2026"]);
		expect(generateFillSeries(["01/02/2026"], 2, { dayFirst: false })).toEqual(["01/03/2026", "01/04/2026"]);
		// Without it the machine's locale does: one of the two, and a date either way.
		expect([["02/02/2026"], ["01/03/2026"]]).toContainEqual(generateFillSeries(["01/02/2026"], 1));
	});

	test("every day a slash date fills to is a real day of the calendar, one after the other, for more than a year each way", () => {
		const real = (y: number, m: number, d: number) => {
			const dt = new Date(Date.UTC(y, m - 1, d));
			return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d ? dt.getTime() / 86_400_000 : null;
		};
		const cases: { seed: string; dayFirst?: boolean; read: (v: string) => number | null }[] = [
			{ seed: "2027/06/15", read: (v) => (/^\d{4}\/\d{2}\/\d{2}$/.test(v) ? real(Number(v.slice(0, 4)), Number(v.slice(5, 7)), Number(v.slice(8, 10))) : null) },
			{ seed: "15/06/2027", read: (v) => (/^\d{2}\/\d{2}\/\d{4}$/.test(v) ? real(Number(v.slice(6, 10)), Number(v.slice(3, 5)), Number(v.slice(0, 2))) : null) },
			{ seed: "06/15/2027", read: (v) => (/^\d{2}\/\d{2}\/\d{4}$/.test(v) ? real(Number(v.slice(6, 10)), Number(v.slice(0, 2)), Number(v.slice(3, 5))) : null) },
			{ seed: "05/06/2027", dayFirst: true, read: (v) => (/^\d{2}\/\d{2}\/\d{4}$/.test(v) ? real(Number(v.slice(6, 10)), Number(v.slice(3, 5)), Number(v.slice(0, 2))) : null) },
		];
		for (const { seed, dayFirst, read } of cases) {
			for (const reverse of [false, true]) {
				const series = generateFillSeries([seed], 800, { reverse, dayFirst });
				expect(series.length).toBe(800);
				let day = read(seed)!;
				for (const value of series) {
					const next = read(value);
					expect([seed, value, next]).toEqual([seed, value, day + (reverse ? -1 : 1)]);
					day = next!;
				}
			}
		}
	});

	test("two slash dates give the step, and dates that do not agree are copied", () => {
		expect(generateFillSeries(["2026/11/30", "2026/12/07"], 2)).toEqual(["2026/12/14", "2026/12/21"]);
		expect(generateFillSeries(["2026/11/30", "2026/12/07"], 2, { reverse: true })).toEqual(["2026/11/23", "2026/11/16"]);
		expect(generateFillSeries(["02/29/2028", "03/07/2028"], 2)).toEqual(["03/14/2028", "03/21/2028"]);
		// No one step between them: the seeds are repeated.
		expect(generateFillSeries(["2026/11/01", "2026/11/02", "2026/11/05"], 3)).toEqual(["2026/11/01", "2026/11/02", "2026/11/05"]);
	});

	test("what is not a day of the calendar is not filled as a date", () => {
		// No 30th of February: it is a name with a number, as before.
		expect(generateFillSeries(["2026/02/30"], 1)).toEqual(["2026/02/31"]);
		expect(generateFillSeries(["13/13/2026"], 1)).toEqual(["13/13/2027"]);
		expect(generateFillSeries(["a/b/c"], 2)).toEqual(["a/b/c", "a/b/c"]);
	});

	test("ISO dates fill as they did", () => {
		expect(generateFillSeries(["2026-11-30"], 2)).toEqual(["2026-12-01", "2026-12-02"]);
		expect(generateFillSeries(["2026-03-01"], 2, { reverse: true })).toEqual(["2026-02-28", "2026-02-27"]);
		expect(generateFillSeries(["2026-11-23", "2026-11-30"], 2)).toEqual(["2026-12-07", "2026-12-14"]);
		expect(generateFillSeries(["2026-11-23", "2026-11-30"], 1, { reverse: true })).toEqual(["2026-11-16"]);
	});

	test("the notice says how many cells were filled, and how many were left as they were", () => {
		expect(fillNotice(3, 0, false)).toBe("Filled 3 cells (Ctrl+Z to undo).");
		expect(fillNotice(1, 0, true)).toBe("Copied 1 cell (Ctrl+Z to undo).");
		expect(fillNotice(1, 2, false)).toBe("Filled 1 cell (Ctrl+Z to undo). 2 cells were left as they were: a numbered name or a zero-padded number does not count below zero.");
		expect(fillNotice(0, 1, false)).toBe("1 cell was left as it was: a numbered name or a zero-padded number does not count below zero.");
		expect(fillNotice(0, 0, false)).toBe("");
	});
});
