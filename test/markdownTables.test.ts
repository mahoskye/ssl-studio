import { describe, expect, test } from "bun:test";
import {
	cellRangeInLine,
	cellValueForEdit,
	createEmptyTable,
	deleteTableColumn,
	deleteTableRow,
	docLineToTableRow,
	enterTableRow,
	focusRangeInTableEdit,
	formatTable,
	insertTableColumn,
	insertTableRow,
	locateTableCell,
	moveTableColumn,
	moveTableRow,
	parseMarkdownTable,
	parseTableRaw,
	serializeTableCell,
	setTableAlignment,
	sortTableByColumn,
	splitTableRow,
	stepTableCell,
	updateTableCell,
} from "../src/shared/markdownTables";

const SAMPLE = [
	"# Spec",
	"",
	"| Name | Count | Notes |",
	"| --- | ---: | :--- |",
	"| Beta | 10 | Second item |",
	"| Alpha | 2 | First `a | b` item |",
	"",
	"After table",
];

describe("Markdown pipe table parsing & cell locating", () => {
	test("parses GFM tables with alignments, inline code pipes, and escaped pipes", () => {
		expect(splitTableRow("| `a | b` | x \\| y | plain |")).toEqual(["`a | b`", "x \\| y", "plain"]);
		const table = parseMarkdownTable(SAMPLE, 4);
		expect(table).not.toBeNull();
		expect(table!.startLine).toBe(2);
		expect(table!.endLine).toBe(5);
		expect(table!.alignments).toEqual(["none", "right", "left"]);
		expect(table!.rows).toEqual([
			["Name", "Count", "Notes"],
			["Beta", "10", "Second item"],
			["Alpha", "2", "First `a | b` item"],
		]);
		expect(docLineToTableRow(table!, 2)).toBe(0);
		expect(docLineToTableRow(table!, 3)).toBe(-1);
		expect(docLineToTableRow(table!, 4)).toBe(1);
		expect(docLineToTableRow(table!, 5)).toBe(2);
		expect(parseMarkdownTable(SAMPLE, 0)).toBeNull();
		expect(parseMarkdownTable(SAMPLE, 7)).toBeNull();
	});

	test("locates cell index and exact cell character range", () => {
		const line = "| Alpha | 2 | First `a | b` item |";
		expect(locateTableCell(line, 3, 3)).toBe(0);
		expect(locateTableCell(line, 10, 3)).toBe(1);
		expect(locateTableCell(line, 26, 3)).toBe(2);
		const r0 = cellRangeInLine(line, 0);
		expect(line.slice(r0.from, r0.to)).toBe("Alpha");
		const r2 = cellRangeInLine(line, 2);
		expect(line.slice(r2.from, r2.to)).toBe("First `a | b` item");
	});
});

describe("Advanced Tables navigation & formatting", () => {
	test("Tab steps through cells, formats columns, and appends a row from the last cell", () => {
		const table = parseMarkdownTable(SAMPLE, 4)!;
		const next = stepTableCell(table, 1, 1, 1);
		expect(next.focusRow).toBe(1);
		expect(next.focusCol).toBe(2);
		expect(next.lines[0]).toBe("| Name  | Count | Notes              |");
		expect(next.lines[1]).toBe("| ----- | ----: | :----------------- |");

		// From the very last cell (row 2, col 2), Tab appends a fresh row 3 and focuses (3, 0).
		const added = stepTableCell(table, 2, 2, 1);
		expect(added.focusRow).toBe(3);
		expect(added.focusCol).toBe(0);
		expect(added.lines.length).toBe(5);
		const focus = focusRangeInTableEdit(added);
		expect(added.text.slice(focus.from - 1, focus.from + 1)).toBe("  ");

		// Shift+Tab steps backward across rows.
		const back = stepTableCell(table, 1, 0, -1);
		expect(back.focusRow).toBe(0);
		expect(back.focusCol).toBe(2);
	});

	test("Enter advances to same column on next row and appends at end", () => {
		const table = parseMarkdownTable(SAMPLE, 4)!;
		const down = enterTableRow(table, 1, 1);
		expect(down.focusRow).toBe(2);
		expect(down.focusCol).toBe(1);
		const append = enterTableRow(table, 2, 1);
		expect(append.focusRow).toBe(3);
		expect(append.focusCol).toBe(1);
	});

	test("inserts, moves, and deletes rows while protecting header row", () => {
		const table = parseMarkdownTable(SAMPLE, 4)!;
		expect(deleteTableRow(table, 0, 0)).toBeNull();
		const above = insertTableRow(table, 1, "above");
		expect(above.lines.length).toBe(5);
		expect(above.focusRow).toBe(1);

		const movedDown = moveTableRow(table, 1, 0, 1)!;
		expect(movedDown.focusRow).toBe(2);
		expect(movedDown.lines[2]).toContain("Alpha");
		expect(movedDown.lines[3]).toContain("Beta");

		expect(moveTableRow(table, 1, 0, -1)).toBeNull();
		const del = deleteTableRow(table, 1, 0)!;
		expect(del.lines.length).toBe(3);
		expect(del.lines[2]).toContain("Alpha");
	});

	test("inserts, moves, deletes, aligns, and sorts columns cleanly", () => {
		const table = parseMarkdownTable(SAMPLE, 4)!;
		const addRight = insertTableColumn(table, 1, 0, "right");
		expect(addRight.focusCol).toBe(1);
		expect(splitTableRow(addRight.lines[0]!)).toEqual(["Name", "Column", "Count", "Notes"]);

		const movedLeft = moveTableColumn(table, 1, 1, -1)!;
		expect(splitTableRow(movedLeft.lines[0]!)).toEqual(["Count", "Name", "Notes"]);
		expect(movedLeft.lines[1]).toContain("---:");

		const centered = setTableAlignment(table, 1, 0, "center");
		expect(centered.lines[1]).toMatch(/^\| :---+:/);

		const asc = sortTableByColumn(table, 1, 1, "asc");
		expect(asc.lines[2]).toContain("Alpha");
		expect(asc.lines[3]).toContain("Beta");

		const desc = sortTableByColumn(table, 1, 1, "desc");
		expect(desc.lines[2]).toContain("Beta");
		expect(desc.lines[3]).toContain("Alpha");

		const removed = deleteTableColumn(table, 1, 2)!;
		expect(splitTableRow(removed.lines[0]!)).toEqual(["Name", "Count"]);

		const singleCol = parseMarkdownTable(["| Only |", "| --- |", "| One |"], 0)!;
		expect(deleteTableColumn(singleCol, 0, 0)).toBeNull();
		expect(formatTable(table, 0, 0).lines.length).toBe(4);
	});

	test("creates a starter formatted 3x2 table with cursor in first header cell", () => {
		const created = createEmptyTable(3, 2);
		const lines = created.text.split("\n");
		expect(lines.length).toBe(4);
		expect(lines[0]).toBe("| Column 1 | Column 2 | Column 3 |");
		expect(created.text.slice(created.cursorOffset, created.cursorOffset + 8)).toBe("Column 1");
	});

	test("edits individual cells in place while escaping pipes and preserving <br> line breaks", () => {
		const raw = ["| Step | Area | Action |", "| --- | --- | --- |", "| 1 | Database |  |", "| 2 | Scripts |  |"].join("\n");
		const parsed = parseTableRaw(raw)!;
		expect(parsed.rows.length).toBe(3);
		expect(parsed.rows[1]).toEqual(["1", "Database", ""]);

		// Multiline + literal pipe escaping (outside inline code) round-trips cleanly.
		expect(serializeTableCell("Line 1\nLine 2 | `a | b`")).toBe("Line 1<br>Line 2 \\| `a | b`");
		expect(cellValueForEdit("Line 1<br>Line 2 \\| `a | b`")).toBe("Line 1\nLine 2 | `a | b`");

		const edited1 = updateTableCell(parsed, 1, 2, "Run schema migration");
		const parsed2 = parseTableRaw(edited1.text)!;
		expect(parsed2.rows[1]?.[2]).toBe("Run schema migration");
		expect(parsed2.rows[2]?.[1]).toBe("Scripts");

		const edited2 = updateTableCell(parsed2, 2, 2, "Deploy SSL");
		const parsed3 = parseTableRaw(edited2.text)!;
		expect(parsed3.rows[1]?.[2]).toBe("Run schema migration");
		expect(parsed3.rows[2]?.[2]).toBe("Deploy SSL");
	});
});
