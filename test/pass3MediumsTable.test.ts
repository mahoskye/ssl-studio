// The table editor's medium findings: the delimiter a file is read with after its header is written to, the cost
// of ordering rows and filter values, where a paste over a selection starts, the line ends of a table Excel wrote,
// and an open cell editor whose text changed underneath it.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
	addCsvColumn,
	compareCellText,
	convertCsvDelimiter,
	csvCellBreaksToLf,
	csvDelimiterForPath,
	csvDelimiterOf,
	csvFirstRecordCell,
	csvHasBareCellBreaks,
	parseCsv,
	readingAfterConvert,
	renameCsvColumn,
	tableTextToWrite,
	type CsvDelimiter,
} from "../src/shared/csv";
import { columnValueOptions, columnValueOptionsOnce, type ColumnFilter } from "../src/shared/csvFormat";
import { cellEditGuard, compareRowsBySorts, pasteStart } from "../src/shared/tablePower";

const texts = (rows: { text: string }[][]) => rows.map((r) => r.map((c) => c.text));

describe("the delimiter a table is read with survives a header edit", () => {
	test("a column renamed to a name holding a comma is quoted in a tab-separated file, and the file still reads as one", () => {
		const tsv = "id\tname\tstatus\n1\tJane\topen\n";
		const renamed = renameCsvColumn(tsv, parseCsv(tsv), 1, "Last, First")!;
		expect(renamed).toBe('id\t"Last, First"\tstatus\n1\tJane\topen\n');
		const again = parseCsv(renamed);
		expect(again.delimiter).toBe("\t");
		expect(again.header.map((c) => c.text)).toEqual(["id", "Last, First", "status"]);
		expect(texts(again.rows)).toEqual([["1", "Jane", "open"]]);
		expect(again.problems).toEqual([]);
	});

	test("a header name holding any of the four delimiters is quoted, whichever the file's own is", () => {
		for (const [delimiter, name] of [
			[",", "a;b"],
			[",", "a|b"],
			[",", "a\tb"],
			["\t", "a;b"],
			[";", "a, b"],
			[";", "a|b"],
			["|", "a, b"],
			["|", "a;b"],
		] as [CsvDelimiter, string][]) {
			const text = ["k", "v"].join(delimiter) + "\n" + ["1", "2"].join(delimiter) + "\n";
			const renamed = renameCsvColumn(text, parseCsv(text, { delimiter }), 1, name)!;
			const again = parseCsv(renamed);
			expect(again.delimiter).toBe(delimiter);
			expect(again.header.map((c) => c.text)).toEqual(["k", name]);
		}
		// A name with none of them is written bare, as before.
		expect(csvFirstRecordCell("plain name", "\t")).toBe("plain name");
		expect(csvFirstRecordCell('say "hi"', ",")).toBe('"say ""hi"""');
	});

	test("a column added with a name holding a comma keeps a semicolon file a semicolon file", () => {
		const semi = "a;b\n1;2\n";
		const added = addCsvColumn(semi, parseCsv(semi), "x, y", "d, e")!;
		// Only the first record is read for the delimiter: the default value below it is quoted as any cell is.
		expect(added).toBe('a;b;"x, y"\n1;2;d, e\n');
		const again = parseCsv(added);
		expect(again.delimiter).toBe(";");
		expect(again.header.map((c) => c.text)).toEqual(["a", "b", "x, y"]);
		expect(texts(again.rows)).toEqual([["1", "2", "d, e"]]);
	});

	test("a table without a header has its first row treated as the first record it is", () => {
		const raw = "1\t2\n3\t4\n";
		const headerless = parseCsv(raw, { hasHeader: false });
		const added = addCsvColumn(raw, headerless, "ignored", "x, y")!;
		expect(added).toBe('1\t2\t"x, y"\n3\t4\tx, y\n');
		expect(parseCsv(added, { hasHeader: false }).delimiter).toBe("\t");
	});

	test("converting the delimiter keeps the first record's names quoted, so the result reads with the new delimiter", () => {
		const csv = 'id,"Last, First",status\n1,"Doe, Jane",open\n';
		const table = parseCsv(csv);
		const tabbed = convertCsvDelimiter(csv, table, "\t");
		expect(tabbed).toBe('id\t"Last, First"\tstatus\n1\tDoe, Jane\topen\n');
		expect(parseCsv(tabbed).delimiter).toBe("\t");
		expect(parseCsv(tabbed).header.map((c) => c.text)).toEqual(["id", "Last, First", "status"]);
		expect(texts(parseCsv(tabbed).rows)).toEqual([["1", "Doe, Jane", "open"]]);

		const semi = convertCsvDelimiter(csv, table, ";");
		expect(semi).toBe('id;"Last, First";status\n1;Doe, Jane;open\n');
		expect(parseCsv(semi).delimiter).toBe(";");
		expect(texts(parseCsv(semi).rows)).toEqual([["1", "Doe, Jane", "open"]]);

	});

	test("after a conversion the view reads the file with the new delimiter: on Auto where Auto says it, set to it where not", () => {
		const csv = 'id,"Last, First",status\n1,"Doe, Jane",open\n';
		const table = parseCsv(csv);
		for (const target of ["\t", ";", "|"] as CsvDelimiter[]) {
			const converted = convertCsvDelimiter(csv, table, target);
			expect(csvDelimiterOf(converted)).toBe(target);
			expect(readingAfterConvert(converted, "/w/people.csv", target)).toBe("auto");
		}
		// A .tsv given commas has no tab left in its first record, so Auto reads it by what the record says.
		const tsv = "id\tname\n1\tJane\n";
		const commas = convertCsvDelimiter(tsv, parseCsv(tsv), ",");
		expect(commas).toBe("id,name\n1,Jane\n");
		expect(readingAfterConvert(commas, "/w/people.tsv", ",")).toBe("auto");
		expect(parseCsv(commas, { prefer: csvDelimiterForPath("/w/people.tsv") }).delimiter).toBe(",");
		// A first line that says nothing of the delimiter (a title above the table) is one Auto cannot read back.
		const titled = "Report\na,b\n1,2\n";
		const titledSemi = convertCsvDelimiter(titled, parseCsv(titled, { delimiter: "," }), ";");
		expect(titledSemi).toBe("Report\na;b\n1;2\n");
		expect(csvDelimiterOf(titledSemi)).toBe(",");
		expect(readingAfterConvert(titledSemi, "/w/report.csv", ";")).toBe(";");
		// With the view set to it, the table is whole: two columns under the title line, as before the conversion.
		expect(texts(parseCsv(titledSemi, { delimiter: ";" }).rows)).toEqual([
			["a", "b"],
			["1", "2"],
		]);
		expect(texts(parseCsv(titledSemi).rows)).toEqual([["a;b"], ["1;2"]]); // what Auto alone made of it
	});

	test("a .tsv is read as tab-separated when its first record has a tab, whatever else it has", () => {
		expect(csvDelimiterForPath("/w/registries/people.tsv")).toBe("\t");
		expect(csvDelimiterForPath("C:\\w\\PEOPLE.TSV")).toBe("\t");
		expect(csvDelimiterForPath("/w/people.tab")).toBe("\t");
		expect(csvDelimiterForPath("/w/people.csv")).toBeUndefined();
		expect(csvDelimiterForPath("/w/tsv")).toBeUndefined();

		// The file as another tool wrote it: a bare comma in one name of a tab-separated header.
		const tsv = "id\tLast, First\tstatus\n1\tDoe, Jane\topen\n";
		expect(parseCsv(tsv).delimiter).toBe(","); // the first record alone
		const read = parseCsv(tsv, { prefer: csvDelimiterForPath("people.tsv") });
		expect(read.delimiter).toBe("\t");
		expect(read.header.map((c) => c.text)).toEqual(["id", "Last, First", "status"]);
		expect(texts(read.rows)).toEqual([["1", "Doe, Jane", "open"]]);
		expect(csvDelimiterOf(tsv, "\t")).toBe("\t");
		expect(csvDelimiterOf(`\uFEFF${tsv}`, "\t")).toBe("\t");

		// A .tsv with no tab in its first record (its delimiter was converted, or it was misnamed) is read as it says.
		expect(parseCsv("a,b\n1,2\n", { prefer: "\t" }).delimiter).toBe(",");
		expect(parseCsv("a;b\n1;2\n", { prefer: "\t" }).delimiter).toBe(";");
		// A tab inside a quoted name is not the file's delimiter.
		expect(parseCsv('"a\tb",c\n1,2\n', { prefer: "\t" }).delimiter).toBe(",");
		// An explicit delimiter is still the last word.
		expect(parseCsv(tsv, { delimiter: ",", prefer: "\t" }).delimiter).toBe(",");
	});
});

describe("ordering rows and filter values with one collator", () => {
	const mixed = [
		"Object_10",
		"Object_2",
		"object_2",
		"OBJECT_1",
		"",
		" ",
		"10",
		"9",
		"1.5",
		"-3",
		"007",
		"7",
		"a",
		"A",
		"á",
		"ä",
		"Z",
		"z",
		"éclair",
		"eclair",
		"Eclair",
		"ß",
		"ss",
		"ticket-12",
		"ticket-3",
		"TICKET-3",
		"in progress",
		"In Progress",
		"found",
		"x\ny",
		"日本",
		"😀",
		"_under",
		"#hash",
	];
	const before = (a: string, b: string) => a.localeCompare(b, undefined, { numeric: true, sensitivity: "base" });

	test("every pair of a mixed list compares as it did with localeCompare", () => {
		for (const a of mixed) for (const b of mixed) expect([a, b, Math.sign(compareCellText(a, b))]).toEqual([a, b, Math.sign(before(a, b))]);
		expect([...mixed].sort(compareCellText)).toEqual([...mixed].sort(before));
		// What it is for: digits by their number, case and accents aside.
		expect(compareCellText("a2", "a10")).toBeLessThan(0);
		expect(compareCellText("ABC", "abc")).toBe(0);
		expect(compareCellText("á", "a")).toBe(0);
	});

	test("compareRowsBySorts orders rows as before, up and down, and by a second column on a tie", () => {
		const rows = mixed.map((name, at) => [name, String(mixed.length - at)]);
		const cell = (row: string[], col: number) => row[col] ?? "";
		for (const down of [false, true]) {
			const sorts = [
				{ column: 0, down },
				{ column: 1, down: false },
			];
			const was = [...rows].sort((a, b) => {
				const first = before(a[0]!, b[0]!);
				if (first !== 0) return down ? -first : first;
				return before(a[1]!, b[1]!);
			});
			expect([...rows].sort((a, b) => compareRowsBySorts(a, b, sorts, cell))).toEqual(was);
		}
	});

	test("columnValueOptions orders a column's values as before", () => {
		const text = `name,status\n${mixed.map((v, at) => `"${v.replace(/"/g, '""')}",${at % 2 ? "open" : "done"}`).join("\n")}\n`;
		const table = parseCsv(text);
		const options = columnValueOptions(table.rows, table.rows, 0, new Map());
		const was = [...options].sort((a, b) => {
			if ((a.count > 0) !== (b.count > 0)) return a.count > 0 ? -1 : 1;
			if (b.count !== a.count) return b.count - a.count;
			if ((a.key === "") !== (b.key === "")) return a.key === "" ? 1 : -1;
			return before(a.label, b.label);
		});
		expect(options.map((o) => o.key)).toEqual(was.map((o) => o.key));
		expect(options.length).toBeGreaterThan(20);
	});

	test("sorting rows and ordering a column's values asks localeCompare for nothing: it made a collator for each pair", () => {
		const count = 500;
		const rows = Array.from({ length: count }, (_, i) => [`Object_${(i * 7919) % count}`]);
		const cell = (row: string[], col: number) => row[col] ?? "";
		const table = parseCsv(`name\n${rows.map((r) => r[0]).join("\n")}\n`);
		const original = String.prototype.localeCompare;
		let asked = 0;
		String.prototype.localeCompare = function (this: string, ...args: Parameters<typeof original>) {
			asked++;
			return original.apply(this, args);
		};
		let sorted: string[][];
		let options: ReturnType<typeof columnValueOptions>;
		try {
			sorted = [...rows].sort((a, b) => compareRowsBySorts(a, b, [{ column: 0, down: false }], cell));
			options = columnValueOptions(table.rows, table.rows, 0, new Map());
		} finally {
			String.prototype.localeCompare = original;
		}
		expect(asked).toBe(0);
		// And the work was done: both are in order.
		expect(sorted.map((r) => r[0])).toEqual(Array.from({ length: count }, (_, i) => `Object_${i}`));
		expect(options.map((o) => o.label)).toEqual(Array.from({ length: count }, (_, i) => `Object_${i}`));
	});

	test("a column's options are worked out once for one state of the table, however many ask", () => {
		const table = parseCsv("name,status\nb,open\na,done\nc,open\n");
		const base = table.rows.map((cells, index) => ({ cells, index }));
		const filters = new Map<number, ColumnFilter>([[1, { text: "", values: new Set(["open"]) }]]);
		const optionsFor = columnValueOptionsOnce(table.rows, base, filters);
		const first = optionsFor(0);
		// The same array, not an equal one: the chip, the tooltip and the menu share one piece of work.
		expect(optionsFor(0)).toBe(first);
		expect(optionsFor(0)).toBe(first);
		expect(first).toEqual(columnValueOptions(table.rows, table.rows, 0, filters));
		// Another column is its own piece of work, and is right for that column.
		const second = optionsFor(1);
		expect(second).not.toBe(first);
		expect(second).toEqual(columnValueOptions(table.rows, table.rows, 1, filters));
		expect(optionsFor(1)).toBe(second);
		// The rows are only walked for columns that are asked for.
		let walked = 0;
		const watched = new Proxy(base, { get: (target, key, self) => (key === "map" && walked++, Reflect.get(target, key, self)) });
		const lazy = columnValueOptionsOnce(table.rows, watched, filters);
		expect(walked).toBe(0);
		lazy(0);
		lazy(1);
		lazy(0);
		expect(walked).toBe(1);
	});
});

describe("where a paste starts", () => {
	test("a selection of several cells is pasted from its top-left cell, whichever corner is active", () => {
		// Rows 2..5 and columns 1..3 selected by dragging down and right: the active cell is the bottom-right one.
		const range = { r1: 2, c1: 1, isMulti: true };
		expect(pasteStart(5, 3, range)).toEqual({ visRow: 2, visCol: 1 });
		// Dragged up and left: the active cell is the top-left one already.
		expect(pasteStart(2, 1, range)).toEqual({ visRow: 2, visCol: 1 });
		// Dragged up and right, and down and left.
		expect(pasteStart(2, 3, range)).toEqual({ visRow: 2, visCol: 1 });
		expect(pasteStart(5, 1, range)).toEqual({ visRow: 2, visCol: 1 });
	});

	test("a cell selected alone is where its paste starts", () => {
		expect(pasteStart(4, 2, null)).toEqual({ visRow: 4, visCol: 2 });
		// An anchored range of one cell (a click that set the anchor) is that cell.
		expect(pasteStart(4, 2, { r1: 4, c1: 2, isMulti: false })).toEqual({ visRow: 4, visCol: 2 });
		// The blank last row (one past the rows) and an active cell whose row is not shown are passed through.
		expect(pasteStart(7, 0, null)).toEqual({ visRow: 7, visCol: 0 });
		expect(pasteStart(-1, 2, null)).toEqual({ visRow: -1, visCol: 2 });
	});
});

describe("a table with CRLF rows and bare LF inside cells is saved as it was", () => {
	const onDisk = 'id,note,status\r\n1,"line one\nline two",open\r\n2,"x",done\r\n3,"a\nb\nc",open\r\n';
	/** What the editor's model holds once the file is open: one kind of line end, the kind there is most of. */
	const allCrlf = (text: string) => text.replace(/\r\n|\r|\n/g, "\r\n");

	test("the shape is told: CRLF after every row and a bare LF for every break inside a cell, and nothing else", () => {
		expect(csvHasBareCellBreaks(onDisk)).toBe(true);
		expect(csvHasBareCellBreaks(`\uFEFF${onDisk}`)).toBe(true);
		expect(csvHasBareCellBreaks(allCrlf(onDisk))).toBe(false); // CRLF inside cells too
		expect(csvHasBareCellBreaks(onDisk.replace(/\r\n/g, "\n"))).toBe(false); // LF throughout
		expect(csvHasBareCellBreaks("id,note\r\n1,x\r\n")).toBe(false); // no cell of several lines
		expect(csvHasBareCellBreaks('id,note\r\n1,"a\nb"\n2,c\r\n')).toBe(false); // a row ends in LF
		expect(csvHasBareCellBreaks('id,note\r\n1,"a\nb"\r\n2,"c\r\nd"\r\n')).toBe(false); // one cell has CRLF
		expect(csvHasBareCellBreaks('id,note\r\n1,"a\rb"\r\n')).toBe(false); // a lone CR
		expect(csvHasBareCellBreaks('"a\nb"')).toBe(false); // no row end
		expect(csvHasBareCellBreaks("")).toBe(false);
		// A quote that is never closed makes the rest one cell, with CRLF inside it: not the shape.
		expect(csvHasBareCellBreaks('id,note\r\n1,"a\nb\r\n2,c\r\n')).toBe(false);
	});

	test("breaks inside cells go back to LF and nothing else is touched", () => {
		const open = allCrlf(onDisk);
		expect(open).not.toBe(onDisk);
		expect(csvCellBreaksToLf(open)).toBe(onDisk);
		// Nothing to do: the same text is handed back.
		expect(csvCellBreaksToLf(onDisk)).toBe(onDisk);
		expect(csvCellBreaksToLf("a,b\r\n1,2\r\n")).toBe("a,b\r\n1,2\r\n");
		expect(csvCellBreaksToLf("a,b\n1,2\n")).toBe("a,b\n1,2\n");
		// Doubled quotes inside a cell do not end it; blank lines and a missing last line end are kept.
		expect(csvCellBreaksToLf('a,b\r\n\r\n1,"say ""hi""\r\nthere"\r\n2,"x"')).toBe('a,b\r\n\r\n1,"say ""hi""\nthere"\r\n2,"x"');
		// A quote in the middle of a cell opens nothing, so the row ends after it stay CRLF.
		expect(csvCellBreaksToLf('a\tb\r\n1\tJoin(list, ",")\r\n2\t"x\r\ny"\r\n', "\t")).toBe('a\tb\r\n1\tJoin(list, ",")\r\n2\t"x\ny"\r\n');
		expect(csvCellBreaksToLf('a,b\r\n1,5" pipe\r\n2,"x\r\ny"\r\n')).toBe('a,b\r\n1,5" pipe\r\n2,"x\ny"\r\n');
		// Every delimiter.
		for (const d of [",", "\t", ";", "|"] as CsvDelimiter[]) {
			const text = `k${d}v\r\n1${d}"a\r\nb"\r\n`;
			expect(csvCellBreaksToLf(text, d)).toBe(`k${d}v\r\n1${d}"a\nb"\r\n`);
			expect(csvCellBreaksToLf(text)).toBe(`k${d}v\r\n1${d}"a\nb"\r\n`);
		}
	});

	test("the text written is the file's own again, and an edit keeps the rest of it", () => {
		expect(tableTextToWrite("/w/reg/notes.csv", allCrlf(onDisk), onDisk)).toBe(onDisk);
		// A cell changed, and a cell of two lines added, in the editor (which writes its own line end, CRLF).
		const edited = allCrlf(onDisk).replace("2,\"x\",done", '2,"x\r\nmore",closed');
		const written = tableTextToWrite("/w/reg/notes.csv", edited, onDisk);
		expect(written).toBe('id,note,status\r\n1,"line one\nline two",open\r\n2,"x\nmore",closed\r\n3,"a\nb\nc",open\r\n');
		// What was written is what is on disk at the next save: it keeps the shape.
		expect(tableTextToWrite("/w/reg/notes.csv", allCrlf(written), written)).toBe(written);
		// The cells read the same before and after.
		expect(texts(parseCsv(written).rows)[0]).toEqual(["1", "line one\nline two", "open"]);
		// A tab-separated file, with a comma and a quote in a cell of code.
		const tsv = 'id\tcode\r\n1\tJoin(list, ",")\r\n2\t"a\nb"\r\n';
		expect(tableTextToWrite("/w/reg/code.tsv", allCrlf(tsv), tsv)).toBe(tsv);
	});

	test("a file that was not so on disk, or is not a table, or was changed to LF throughout, is written as it is in the editor", () => {
		const open = allCrlf(onDisk);
		// CRLF throughout on disk: the cells keep CRLF.
		expect(tableTextToWrite("/w/notes.csv", open, open)).toBe(open);
		// LF throughout on disk, changed to CRLF in the editor (the status bar's line ends): every line is CRLF.
		const lf = onDisk.replace(/\r\n/g, "\n");
		expect(tableTextToWrite("/w/notes.csv", open, lf)).toBe(open);
		// The shape on disk, changed to LF in the editor: there is no CRLF to put back, and none is added.
		expect(tableTextToWrite("/w/notes.csv", lf, onDisk)).toBe(lf);
		// Not a table file.
		expect(tableTextToWrite("/w/notes.md", open, onDisk)).toBe(open);
		expect(tableTextToWrite("/w/notes.csv.bak", open, onDisk)).toBe(open);
		// A new file: nothing on disk.
		expect(tableTextToWrite("/w/notes.csv", open, "")).toBe(open);
	});

	test("the editor's own model of such a file comes back to the file's text", async () => {
		// Monaco's text buffer as state.ts makes it (createModel -> PieceTreeTextBufferBuilder, line ends normalised).
		const builderPath = join(import.meta.dir, "../node_modules/monaco-editor/esm/vs/editor/common/model/pieceTreeTextBuffer/pieceTreeTextBufferBuilder.js");
		const { PieceTreeTextBufferBuilder } = await import(builderPath);
		const builder = new PieceTreeTextBufferBuilder();
		builder.acceptChunk(onDisk);
		const { textBuffer } = builder.finish(true).create(1);
		const inModel: string = textBuffer.getValueInRange(textBuffer.getRangeAt(0, textBuffer.getLength()), 0);
		expect(textBuffer.getEOL()).toBe("\r\n");
		expect(inModel).not.toBe(onDisk); // the defect's cause: every break inside a cell is CRLF in the model
		expect(inModel).toContain('"line one\r\nline two"');
		expect(tableTextToWrite("/w/notes.csv", inModel, onDisk)).toBe(onDisk);
	});

	test("save() takes the text it writes through tableTextToWrite (source text: save needs Monaco and a backend)", () => {
		const src = readFileSync(join(import.meta.dir, "../src/view/state.ts"), "utf8");
		expect(src.includes("const text = tableTextToWrite(path, doc.model.getValue(), doc.savedText);")).toBe(true);
	});
});

describe("an open cell editor and a change of the text underneath it", () => {
	test("a change from elsewhere makes the open editor stale, so it writes nothing", () => {
		const guard = cellEditGuard();
		const opened = guard.stamp();
		expect(guard.fresh(opened)).toBe(true);
		// The file is reloaded from disk with rows added above: the view's listener asks.
		expect(guard.changed()).toBe(true);
		expect(guard.fresh(opened)).toBe(false);
		// An editor opened after the change is on the text as it now is.
		expect(guard.fresh(guard.stamp())).toBe(true);
	});

	test("an editor's own write is not counted against the editor Tab or Enter opens next", () => {
		const guard = cellEditGuard();
		const first = guard.stamp();
		let heard: boolean | undefined;
		// The write fires the model's listener while the editor is committing.
		const result = guard.commit(() => {
			heard = guard.changed();
			return "written";
		});
		expect(result).toBe("written");
		expect(heard).toBe(false);
		expect(guard.fresh(first)).toBe(true);
		const next = guard.stamp();
		expect(guard.fresh(next)).toBe(true);
		// Once the commit is over, a change is from elsewhere again, and the next editor is stale.
		expect(guard.changed()).toBe(true);
		expect(guard.fresh(next)).toBe(false);
	});

	test("a write that throws does not leave later changes counted as the editor's own", () => {
		const guard = cellEditGuard();
		expect(() =>
			guard.commit(() => {
				throw new Error("no");
			}),
		).toThrow("no");
		const opened = guard.stamp();
		expect(guard.changed()).toBe(true);
		expect(guard.fresh(opened)).toBe(false);
	});

	test("a commit inside a commit is still a commit until the outer one ends", () => {
		const guard = cellEditGuard();
		const opened = guard.stamp();
		guard.commit(() => {
			guard.commit(() => void guard.changed());
			expect(guard.changed()).toBe(false);
		});
		expect(guard.fresh(opened)).toBe(true);
	});

	test("the view asks the guard on every change, closes the cell's editor, and its commit checks first (source text: the view needs a DOM)", () => {
		const src = readFileSync(join(import.meta.dir, "../src/view/editor/TableView.tsx"), "utf8");
		expect(src.includes("if (editGuard.changed()) {")).toBe(true);
		expect(src.includes("if (!editGuard.fresh(openedOn)) return;")).toBe(true);
		expect(src.includes("editGuard.commit(() => commitCell(rowIdx, targetCol, val, move));")).toBe(true);
		expect(src.includes("editGuard.commit(() => commitGhost(targetCol, val, move));")).toBe(true);
	});
});
