import { describe, expect, test } from "bun:test";
import { appendRowEdit, insertRowEdit, parseCsv, rawRowText } from "../src/shared/csv";
import { fileChosen } from "../src/shared/fileGlob";
import {
	codeCheckSearchOptions,
	codeCheckSummary,
	columnCheckTargets,
	defaultCheckColumn,
	defaultExcludePattern,
	extractCellTerms,
	looksLikeListColumn,
} from "../src/shared/registryCheck";

function applyInsert(text: string, edit: { offset: number; text: string }): string {
	return text.slice(0, edit.offset) + edit.text + text.slice(edit.offset);
}

describe("CSV row insertion and duplication edits", () => {
	test("insertRowEdit inserts above and below with LF and preserves trailing newline", () => {
		const text = "name,value\nA,1\nB,2\n";
		const table = parseCsv(text);
		const above0 = insertRowEdit(text, table, 0, "above", ",")!;
		expect(applyInsert(text, above0)).toBe("name,value\n,\nA,1\nB,2\n");
		const below0 = insertRowEdit(text, table, 0, "below", "X,9")!;
		expect(applyInsert(text, below0)).toBe("name,value\nA,1\nX,9\nB,2\n");
		const below1 = insertRowEdit(text, table, 1, "below", "Y,8")!;
		expect(applyInsert(text, below1)).toBe("name,value\nA,1\nB,2\nY,8\n");
	});

	test("insertRowEdit handles CRLF and EOF without trailing newline", () => {
		const crlf = "name,value\r\nA,1\r\nB,2";
		const table = parseCsv(crlf);
		const belowLast = insertRowEdit(crlf, table, 1, "below", "C,3")!;
		expect(applyInsert(crlf, belowLast)).toBe("name,value\r\nA,1\r\nB,2\r\nC,3");
		const aboveFirst = insertRowEdit(crlf, table, 0, "above", "Z,0")!;
		expect(applyInsert(crlf, aboveFirst)).toBe("name,value\r\nZ,0\r\nA,1\r\nB,2");
	});

	test("rawRowText preserves exact quoting when duplicating", () => {
		const text = 'object,used by\nDEMO_SAMPLES,"SetSampleDueDates, SaveDueDates"\n';
		const table = parseCsv(text);
		const raw = rawRowText(text, table, 0)!;
		expect(raw).toBe('DEMO_SAMPLES,"SetSampleDueDates, SaveDueDates"');
		const dup = insertRowEdit(text, table, 0, "below", raw)!;
		expect(applyInsert(text, dup)).toBe(
			'object,used by\nDEMO_SAMPLES,"SetSampleDueDates, SaveDueDates"\nDEMO_SAMPLES,"SetSampleDueDates, SaveDueDates"\n',
		);
	});

	test("appendRowEdit appends cleanly for multi-column and single-column files with or without trailing newline", () => {
		const withNl = "name,value,status\nA,1,found\n";
		const edit1 = appendRowEdit(withNl, ["", "RUSH", ""], ",");
		expect(applyInsert(withNl, edit1)).toBe("name,value,status\nA,1,found\n,RUSH,\n");

		const noNl = "name,value\nA,1";
		const edit2 = appendRowEdit(noNl, ["B", "2, 3"], ",");
		expect(applyInsert(noNl, edit2)).toBe('name,value\nA,1\nB,"2, 3"\n');

		const oneCol = "name\nA\n";
		const edit3 = appendRowEdit(oneCol, ["B"], ",");
		expect(applyInsert(oneCol, edit3)).toBe("name\nA\nB\n");
	});
});

describe("targeted code-usage checks", () => {
	test("defaultExcludePattern builds workspace-rooted globs that match docs/plans/.ssl-studio only", () => {
		const pat = defaultExcludePattern(["docs", "./design/", ".ssl-studio", ".", "DOCS"]);
		expect(pat).toBe("docs/**, design/**, .ssl-studio/**");
		expect(fileChosen("docs/registries/settings.csv", "", pat)).toBe(false);
		expect(fileChosen("design/DueDates.spec.md", "", pat)).toBe(false);
		expect(fileChosen(".ssl-studio/cache.json", "", pat)).toBe(false);
		expect(fileChosen("src/DueDates/DueRule.ssl", "", pat)).toBe(true);
		expect(fileChosen("docsite/index.md", "", pat)).toBe(true);
	});

	test("extractCellTerms and columnCheckTargets target any column, optional list splitting, and have no 300-item cutoff", () => {
		expect(extractCellTerms("  SetSampleDueDates, SaveDueDates ; Outages  ", true)).toEqual([
			"SetSampleDueDates",
			"SaveDueDates",
			"Outages",
		]);
		expect(extractCellTerms("SetSampleDueDates, SaveDueDates", false)).toEqual(["SetSampleDueDates, SaveDueDates"]);

		const table = parseCsv(
			'object,used by,status\nDEMO_SAMPLES,"SetSampleDueDates, SaveDueDates",verified\nDEMO_HOLIDAYS,"SetSampleDueDates, x",verified\n',
		);
		const res = columnCheckTargets(table.rows, 1, { splitLists: true, caseSensitive: false, minLength: 2 });
		expect(res.terms).toEqual(["SetSampleDueDates", "SaveDueDates"]);
		expect(res.skippedShort).toBe(1);

		// Verify more than 300 unique values are all returned without silent truncation.
		const bigLines = ["name,val", ...Array.from({ length: 350 }, (_, i) => `ITEM_${i},1`)].join("\n");
		const bigTable = parseCsv(bigLines);
		expect(columnCheckTargets(bigTable.rows, 0).terms.length).toBe(350);
	});

	test("looksLikeListColumn detects comma-separated identifier columns and ignores prose", () => {
		const db = parseCsv(
			'object,used by,note\nDEMO_SAMPLES,"SetSampleDueDates, SaveDueDates, SamplesDueSoon","Read and written, with caution for long notes"\n',
		);
		expect(looksLikeListColumn(db.rows, 1)).toBe(true);
		expect(looksLikeListColumn(db.rows, 0)).toBe(false);
		expect(looksLikeListColumn(db.rows, 2)).toBe(false);
	});

	test("defaultCheckColumn skips path/date/status columns and prefers identifier columns", () => {
		expect(defaultCheckColumn(parseCsv("date,name\n2026-01-01,New Year\n"))).toBe(1);
		expect(defaultCheckColumn(parseCsv("path,kind,status\na.ssl,script,found\n"))).toBe(1);
		expect(defaultCheckColumn(parseCsv("status,object,note\nverified,DEMO_SAMPLES,ok\n"))).toBe(1);
	});

	test("codeCheckSearchOptions builds literal whole-word / glob options cleanly", () => {
		const exclude = defaultExcludePattern(["docs", "design", ".ssl-studio"]);
		expect(
			codeCheckSearchOptions(
				{ fileScope: "ssl", include: "", exclude: "", wholeWord: true, caseSensitive: false },
				exclude,
			),
		).toEqual({
			regex: false,
			wholeWord: true,
			caseSensitive: false,
			include: "*.ssl",
			exclude: "docs/**, design/**, .ssl-studio/**",
		});
		expect(
			codeCheckSearchOptions(
				{ fileScope: "custom", include: "src/DueDates/**", exclude: "tests/**", wholeWord: false, caseSensitive: true },
				exclude,
			),
		).toEqual({
			regex: false,
			wholeWord: false,
			caseSensitive: true,
			include: "src/DueDates/**",
			exclude: "tests/**",
		});
	});

	test("codeCheckSummary reports complete and stopped-early checks clearly", () => {
		expect(codeCheckSummary("name", new Map([["a", 2], ["b", 0]]))).toBe("Checked “name”: 1 of 2 not found in code.");
		expect(codeCheckSummary("name", new Map([["a", 2], ["b", 1]]))).toBe("Checked “name”: all 2 found in code.");
		expect(codeCheckSummary("name", new Map([["a", 0]]), true)).toBe("Stopped checking “name” (1 checked): 1 of 1 not found in code.");
	});
});
