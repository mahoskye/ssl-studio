import { describe, expect, test } from "bun:test";
import {
	addCsvColumn,
	convertCsvDelimiter,
	deleteCsvColumn,
	moveCsvRow,
	parseCsv,
	renameCsvColumn,
	reorderCsvColumns,
} from "../src/shared/csv";
import {
	CSV_STATUS_PRESETS,
	effectiveCsvTableConfig,
	isUnrecognizedBadgeValue,
	knownBadgeValues,
	ruleForColumn,
	type CsvColumnFormatRule,
} from "../src/shared/csvFormat";

describe("parseCsv delimiter and headerless options", () => {
	test("parses pipe-delimited files with explicit delimiter: '|'", () => {
		const raw = 'name|kind|note\nSAMPLES|table|"has | pipe"\nRESULTS|view|"say ""ok"""\n';
		const t = parseCsv(raw, { delimiter: "|" });
		expect(t.delimiter).toBe("|");
		expect(t.header.map((c) => c.text)).toEqual(["name", "kind", "note"]);
		expect(t.rows.map((r) => r.map((c) => c.text))).toEqual([
			["SAMPLES", "table", "has | pipe"],
			["RESULTS", "view", 'say "ok"'],
		]);
		expect(t.problems).toEqual([]);
	});

	test("auto-detects pipe delimiter when line 1 has pipes and no commas, tabs, or semicolons", () => {
		const raw = "object|status|ticket\nORD_TEST|verified|DEMO-101\n";
		const t = parseCsv(raw);
		expect(t.delimiter).toBe("|");
		expect(t.rows[0]!.map((c) => c.text)).toEqual(["ORD_TEST", "verified", "DEMO-101"]);
	});

	test("explicit delimiter overrides auto-detection (e.g. forcing '|' even if commas appear)", () => {
		const raw = "a,b|c,d\n1,2|3,4\n";
		const t = parseCsv(raw, { delimiter: "|" });
		expect(t.delimiter).toBe("|");
		expect(t.header.map((c) => c.text)).toEqual(["a,b", "c,d"]);
		expect(t.rows[0]!.map((c) => c.text)).toEqual(["1,2", "3,4"]);
	});

	test("hasHeader: false synthesizes Column 1, Column 2, ... and keeps row 0 as data row 0", () => {
		const raw = "SAMPLES,table,verified\nRESULTS,view,found\n";
		const t = parseCsv(raw, { hasHeader: false });
		expect(t.hasHeader).toBe(false);
		expect(t.header.map((c) => c.text)).toEqual(["Column 1", "Column 2", "Column 3"]);
		expect(t.rows).toHaveLength(2);
		expect(t.rows[0]!.map((c) => c.text)).toEqual(["SAMPLES", "table", "verified"]);
		expect(t.rows[1]!.map((c) => c.text)).toEqual(["RESULTS", "view", "found"]);
		expect(t.problems).toEqual([]);
		// Exact cell offsets into `raw` stay intact for row 0
		expect(raw.slice(t.rows[0]![0]!.start, t.rows[0]![0]!.end)).toBe("SAMPLES");
	});

	test("hasHeader: false handles pipe delimiter, ragged rows, and empty input cleanly", () => {
		const ragged = "a|b\nc|d|e\n";
		const t = parseCsv(ragged, { delimiter: "|", hasHeader: false });
		expect(t.header.map((c) => c.text)).toEqual(["Column 1", "Column 2", "Column 3"]);
		expect(t.rows).toHaveLength(2);
		expect(t.problems).toEqual(["1 row has more or fewer cells than there are columns."]);

		const empty = parseCsv("", { hasHeader: false });
		expect(empty.header).toEqual([]);
		expect(empty.rows).toEqual([]);
		expect(empty.problems).toEqual([]);
	});

	test("column operations respect headerless tables without corrupting row 0", () => {
		const raw = "A,B,C\n1,2,3\n";
		const t = parseCsv(raw, { hasHeader: false });
		expect(reorderCsvColumns(raw, t, [2, 0, 1])).toBe("C,A,B\n3,1,2\n");
		expect(deleteCsvColumn(raw, t, 1)).toBe("A,C\n1,3\n");
		expect(addCsvColumn(raw, t, "IgnoredName", "x")).toBe("A,B,C,x\n1,2,3,x\n");
		expect(renameCsvColumn(raw, t, 0, "NewName")).toBeNull();
	});
});

describe("moveCsvRow", () => {
	const sample = [
		"name,status,note",
		'Row0,found,"quoted, ""verbatim"" note"',
		'Row1,in progress,"line 1\nline 2"',
		"Row2,verified,plain",
	].join("\n") + "\n";

	test("moves a row down while preserving exact raw quoting and embedded newlines", () => {
		const t = parseCsv(sample);
		const moved = moveCsvRow(sample, t, 0, 2);
		expect(moved).toBe(
			[
				"name,status,note",
				'Row1,in progress,"line 1\nline 2"',
				"Row2,verified,plain",
				'Row0,found,"quoted, ""verbatim"" note"',
			].join("\n") + "\n",
		);
	});

	test("moves a row up cleanly across adjacent and non-adjacent positions", () => {
		const t = parseCsv(sample);
		const stepUp = moveCsvRow(sample, t, 2, 1);
		expect(parseCsv(stepUp).rows.map((r) => r[0]!.text)).toEqual(["Row0", "Row2", "Row1"]);
		const toTop = moveCsvRow(sample, t, 2, 0);
		expect(parseCsv(toTop).rows.map((r) => r[0]!.text)).toEqual(["Row2", "Row0", "Row1"]);
	});

	test("preserves CRLF line endings and works on headerless tables", () => {
		const crlf = 'k,v\r\n"A,1",one\r\n"B,2",two\r\n';
		expect(moveCsvRow(crlf, parseCsv(crlf), 1, 0)).toBe('k,v\r\n"B,2",two\r\n"A,1",one\r\n');

		const headerless = "first,1\nsecond,2\nthird,3\n";
		expect(moveCsvRow(headerless, parseCsv(headerless, { hasHeader: false }), 0, 2)).toBe("second,2\nthird,3\nfirst,1\n");
	});

	test("returns input unchanged for out-of-bounds, identical, non-integer, or single-row tables", () => {
		const t = parseCsv(sample);
		expect(moveCsvRow(sample, t, 0, 0)).toBe(sample);
		expect(moveCsvRow(sample, t, -1, 1)).toBe(sample);
		expect(moveCsvRow(sample, t, 0, -1)).toBe(sample);
		expect(moveCsvRow(sample, t, 0, 3)).toBe(sample);
		expect(moveCsvRow(sample, t, 99, 0)).toBe(sample);
		expect(moveCsvRow(sample, t, 0.5, 1)).toBe(sample);

		const single = "a,b\n1,2\n";
		expect(moveCsvRow(single, parseCsv(single), 0, 0)).toBe(single);
	});
});

describe("convertCsvDelimiter", () => {
	test("converts between comma, tab, semicolon, and pipe with accurate re-quoting", () => {
		const csv = 'name,note,status\n"Alpha, Beta","say ""hi""","x|y"\nPlain,a\tb,verified\n';
		const t = parseCsv(csv);

		// Comma -> Pipe: unquotes "Alpha, Beta", quotes "x|y"
		const piped = convertCsvDelimiter(csv, t, "|");
		expect(piped).toBe('name|note|status\nAlpha, Beta|"say ""hi"""|"x|y"\nPlain|a\tb|verified\n');
		expect(parseCsv(piped, { delimiter: "|" }).rows.map((r) => r.map((c) => c.text))).toEqual(
			t.rows.map((r) => r.map((c) => c.text)),
		);

		// Comma -> Tab: quotes cell holding literal tab
		const tsv = convertCsvDelimiter(csv, t, "\t");
		expect(tsv).toBe('name\tnote\tstatus\nAlpha, Beta\t"say ""hi"""\tx|y\nPlain\t"a\tb"\tverified\n');
		expect(parseCsv(tsv, { delimiter: "\t" }).rows.map((r) => r.map((c) => c.text))).toEqual(
			t.rows.map((r) => r.map((c) => c.text)),
		);

		// Pipe -> Semicolon round-trip
		const semi = convertCsvDelimiter(piped, parseCsv(piped, { delimiter: "|" }), ";");
		expect(parseCsv(semi, { delimiter: ";" }).rows.map((r) => r.map((c) => c.text))).toEqual(
			t.rows.map((r) => r.map((c) => c.text)),
		);
	});

	test("preserves BOM, CRLF, blank lines, headerless rows, and no-ops when delimiter is unchanged", () => {
		const raw = "\uFEFFa,b\r\n\r\n1,2";
		const t = parseCsv(raw);
		expect(convertCsvDelimiter(raw, t, ",")).toBe(raw);
		expect(convertCsvDelimiter(raw, t, "\t")).toBe("\uFEFFa\tb\r\n\r\n1\t2");

		const headerless = "x|y\n1|2\n";
		const th = parseCsv(headerless, { delimiter: "|", hasHeader: false });
		expect(convertCsvDelimiter(headerless, th, ",")).toBe("x,y\n1,2\n");
	});
});

describe("isUnrecognizedBadgeValue and knownBadgeValues", () => {
	const cfg = effectiveCsvTableConfig();
	const statusRule = ruleForColumn(cfg, "status")!;

	test("isUnrecognizedBadgeValue flags typos while accepting canonical values (case-insensitive) and blanks", () => {
		expect(isUnrecognizedBadgeValue(statusRule, "verifed")).toBe(true);
		expect(isUnrecognizedBadgeValue(statusRule, "in progres")).toBe(true);
		expect(isUnrecognizedBadgeValue(statusRule, "totally-unknown")).toBe(true);

		expect(isUnrecognizedBadgeValue(statusRule, "verified")).toBe(false);
		expect(isUnrecognizedBadgeValue(statusRule, "VERIFIED")).toBe(false);
		expect(isUnrecognizedBadgeValue(statusRule, "  In Progress  ")).toBe(false);
		expect(isUnrecognizedBadgeValue(statusRule, "Approved")).toBe(false);
		expect(isUnrecognizedBadgeValue(statusRule, "")).toBe(false);
		expect(isUnrecognizedBadgeValue(statusRule, "   ")).toBe(false);
	});

	test("isUnrecognizedBadgeValue returns false when rule is missing or has no configured values", () => {
		expect(isUnrecognizedBadgeValue(undefined, "anything")).toBe(false);
		expect(isUnrecognizedBadgeValue(null, "anything")).toBe(false);
		const emptyRule: CsvColumnFormatRule = { columns: ["status"], values: {}, fallback: "waiting" };
		expect(isUnrecognizedBadgeValue(emptyRule, "anything")).toBe(false);
	});

	test("knownBadgeValues returns deduplicated canonical { value, tone } entries for enum dropdowns", () => {
		expect(knownBadgeValues(undefined)).toEqual([]);
		expect(knownBadgeValues(null)).toEqual([]);

		const registryRule = ruleForColumn(CSV_STATUS_PRESETS.find((p) => p.id === "registry")!.config, "status")!;
		const regEntries = knownBadgeValues(registryRule);
		expect(regEntries.find((e) => e.value === "verified")).toEqual({ value: "verified", tone: "done" });
		expect(regEntries.find((e) => e.value === "in progress")).toEqual({ value: "in progress", tone: "active" });
		expect(regEntries.find((e) => e.value === "blocked")).toEqual({ value: "blocked", tone: "error" });

		// Default preset merges registry + STARLIMS (which both contain "in progress" / "In Progress"): deduplicated!
		const defaultEntries = knownBadgeValues(statusRule);
		expect(defaultEntries.filter((e) => e.value.toLowerCase() === "in progress")).toHaveLength(1);
		expect(defaultEntries.some((e) => e.value === "OOS" && e.tone === "warn")).toBe(true);
	});
});
