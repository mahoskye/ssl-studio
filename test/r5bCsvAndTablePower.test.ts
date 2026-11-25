import { describe, expect, test } from "bun:test";
import {
	addCsvColumn,
	csvRow,
	deleteCsvColumn,
	parseClipboardGrid,
	parseCsv,
} from "../src/shared/csv";
import {
	badgeToneForValue,
	CSV_STATUS_PRESETS,
	DEFAULT_CSV_TABLE_CONFIG,
	effectiveCsvTableConfig,
	isUnrecognizedBadgeValue,
	knownBadgeValues,
	ruleForColumn,
} from "../src/shared/csvFormat";
import {
	cellMatchesQuery,
	compileCellMatcher,
	getTableViewState,
	parseTableViewStateStore,
	replaceCellMatches,
	sanitizeTableViewState,
	serializeTableViewStateStore,
	upsertTableViewState,
} from "../src/shared/tablePower";

describe("Round 5B: CSV 1-column empty row preservation", () => {
	test("csvRow emits quoted empty string for 1-column empty rows so re-parsing keeps them", () => {
		expect(csvRow([""])).toBe('""');
		expect(csvRow([""], "\t")).toBe('""');
		expect(csvRow([""], ";")).toBe('""');
		expect(csvRow([""], "|")).toBe('""');

		// Multi-column empty rows and single non-empty rows stay unchanged
		expect(csvRow(["", ""])).toBe(",");
		expect(csvRow(["alpha"])).toBe("alpha");
		expect(csvRow([])).toBe("");

		const doc = `${csvRow(["name"])}\n${csvRow([""])}\n${csvRow(["beta"])}\n`;
		const parsed = parseCsv(doc);
		expect(parsed.header.map((c) => c.text)).toEqual(["name"]);
		expect(parsed.rows.map((r) => r.map((c) => c.text))).toEqual([[""], ["beta"]]);
	});

	test("deleteCsvColumn preserves rows reduced to a single empty cell or zero cells", () => {
		// Deleting col 1 leaves col 0 empty on row 0
		const leftEmpty = "a,b\n,x\ny,z\n";
		const del1 = deleteCsvColumn(leftEmpty, parseCsv(leftEmpty), 1)!;
		expect(del1).toBe('a\n""\ny\n');
		expect(parseCsv(del1).rows.map((r) => r.map((c) => c.text))).toEqual([[""], ["y"]]);

		// Deleting col 0 leaves col 1 empty on row 0
		const rightEmpty = "a,b\nx,\ny,z\n";
		const del0 = deleteCsvColumn(rightEmpty, parseCsv(rightEmpty), 0)!;
		expect(del0).toBe('b\n""\nz\n');
		expect(parseCsv(del0).rows.map((r) => r.map((c) => c.text))).toEqual([[""], ["z"]]);

		// Row with both cells empty keeps a preserved empty row
		const bothEmpty = "a,b\n,\ny,z\n";
		const delBoth = deleteCsvColumn(bothEmpty, parseCsv(bothEmpty), 1)!;
		expect(delBoth).toBe('a\n""\ny\n');
		expect(parseCsv(delBoth).rows.map((r) => r.map((c) => c.text))).toEqual([[""], ["y"]]);

		// Already-quoted empty remaining cell stays `""` (never double-quoted)
		const alreadyQuoted = 'a,b\n"",x\ny,z\n';
		const delQuoted = deleteCsvColumn(alreadyQuoted, parseCsv(alreadyQuoted), 1)!;
		expect(delQuoted).toBe('a\n""\ny\n');
		expect(parseCsv(delQuoted).rows.map((r) => r.map((c) => c.text))).toEqual([[""], ["y"]]);

		// Ragged 1-cell row losing its only cell still emits `""`
		const ragged = "a,b\nonly\ny,z\n";
		const delRagged = deleteCsvColumn(ragged, parseCsv(ragged), 0)!;
		expect(delRagged).toBe('b\n""\nz\n');
		expect(parseCsv(delRagged).rows.map((r) => r.map((c) => c.text))).toEqual([[""], ["z"]]);
	});
});

describe("Round 5B: addCsvColumn ragged long-row alignment", () => {
	test("inserts the new column after the last header-width cell without hijacking extra trailing cells", () => {
		const raw = [
			"a,b",
			"1,2",
			"3",
			"4,5,extra1,extra2",
			'6,"7, quoted",extra3',
			"8,,extra4",
		].join("\n");
		const added = addCsvColumn(raw, parseCsv(raw), "c", "DEF")!;
		expect(added).toBe(
			[
				"a,b,c",
				"1,2,DEF",
				"3,,DEF",
				"4,5,DEF,extra1,extra2",
				'6,"7, quoted",DEF,extra3',
				"8,,DEF,extra4",
			].join("\n"),
		);

		const reparsed = parseCsv(added);
		expect(reparsed.header.map((c) => c.text)).toEqual(["a", "b", "c"]);
		expect(reparsed.rows.map((r) => r[2]?.text)).toEqual(["DEF", "DEF", "DEF", "DEF", "DEF"]);
		expect(reparsed.rows[2]!.map((c) => c.text)).toEqual(["4", "5", "DEF", "extra1", "extra2"]);
		expect(reparsed.rows[3]!.map((c) => c.text)).toEqual(["6", "7, quoted", "DEF", "extra3"]);
		expect(reparsed.rows[4]!.map((c) => c.text)).toEqual(["8", "", "DEF", "extra4"]);
	});

	test("preserves CRLF, blank lines, and TSV delimiter on long ragged rows", () => {
		const tsv = "k\tv\r\n\r\na\tb\textra\r\n";
		const added = addCsvColumn(tsv, parseCsv(tsv), "status", "found")!;
		expect(added).toBe("k\tv\tstatus\r\n\r\na\tb\tfound\textra\r\n");
	});
});

describe("Round 5B: parseClipboardGrid quoted plain-text safety", () => {
	test("preserves SSL/code expressions and plain quoted strings without stripping quotes", () => {
		expect(parseClipboardGrid('"foo" + "bar"')).toEqual([['"foo" + "bar"']]);
		expect(parseClipboardGrid('"UTF-8"')).toEqual([['"UTF-8"']]);
		expect(parseClipboardGrid('"UTF-8"\r\n')).toEqual([['"UTF-8"']]);
		expect(parseClipboardGrid('""')).toEqual([['""']]);
		expect(parseClipboardGrid('"""')).toEqual([['"""']]);
		expect(parseClipboardGrid('"unclosed quote')).toEqual([['"unclosed quote']]);
		expect(parseClipboardGrid('expr\t"foo" + "bar"\nnext\t"a" + "b"\n')).toEqual([
			["expr", '"foo" + "bar"'],
			["next", '"a" + "b"'],
		]);
		expect(parseClipboardGrid('a\t"unclosed\nb\tc')).toEqual([
			["a", '"unclosed'],
			["b", "c"],
		]);
	});

	test("still parses valid RFC 4180 multiline, tab, escaped-quote, and multi-column clipboard grids", () => {
		expect(parseClipboardGrid('a\t"hello\nworld"\nc\td\n')).toEqual([
			["a", "hello\nworld"],
			["c", "d"],
		]);
		expect(parseClipboardGrid('"Single\nMultiline Cell"')).toEqual([["Single\nMultiline Cell"]]);
		expect(parseClipboardGrid('"Line 1\r\nLine 2"\r\n')).toEqual([["Line 1\nLine 2"]]);
		expect(parseClipboardGrid('"has\ttab"')).toEqual([["has\ttab"]]);
		expect(parseClipboardGrid('"""UTF-8"""')).toEqual([['"UTF-8"']]);
		expect(parseClipboardGrid('"say ""hi"""')).toEqual([['say "hi"']]);
		expect(parseClipboardGrid('"a"\t"b"\n"c"\t"d"')).toEqual([
			["a", "b"],
			["c", "d"],
		]);
	});
});

describe("Round 5B: parseCsv delimiter auto-detection", () => {
	test("detects TSV and semicolon delimiters across multiline quoted headers", () => {
		const multilineTsv = '"Last,\nFirst"\tStatus\nDoe, Jane\tverified\n';
		const tsv = parseCsv(multilineTsv);
		expect(tsv.delimiter).toBe("\t");
		expect(tsv.header.map((c) => c.text)).toEqual(["Last,\nFirst", "Status"]);
		expect(tsv.rows.map((r) => r.map((c) => c.text))).toEqual([["Doe, Jane", "verified"]]);

		const multilineSemi = 'id;"Desc, ""quoted""\r\nwith\ttab";status\r\n1;ok;done\r\n';
		const semi = parseCsv(multilineSemi);
		expect(semi.delimiter).toBe(";");
		expect(semi.header.map((c) => c.text)).toEqual(["id", 'Desc, "quoted"\r\nwith\ttab', "status"]);
		expect(semi.rows.map((r) => r.map((c) => c.text))).toEqual([["1", "ok", "done"]]);
	});

	test("skips leading blank lines after BOM before detecting delimiter and keeps exact source offsets", () => {
		const leadingLf = "\n\nname\tstatus\nA\tdone\n";
		const t1 = parseCsv(leadingLf);
		expect(t1.delimiter).toBe("\t");
		expect(t1.header.map((c) => c.text)).toEqual(["name", "status"]);
		expect(leadingLf.slice(t1.header[0]!.start, t1.header[0]!.end)).toBe("name");

		const bomLeadingCrlf = "\uFEFF\r\n\r\na;b;c\r\n1;2;3\r\n";
		const t2 = parseCsv(bomLeadingCrlf);
		expect(t2.delimiter).toBe(";");
		expect(t2.header.map((c) => c.text)).toEqual(["a", "b", "c"]);
		expect(bomLeadingCrlf.slice(t2.header[0]!.start, t2.header[0]!.end)).toBe("a");
		expect(bomLeadingCrlf.slice(t2.rows[0]![0]!.start, t2.rows[0]![0]!.end)).toBe("1");
	});

	test("detects delimiter on CR-only files without scanning into later rows containing commas", () => {
		const crSemi = "name;status\rA;done, ok\r";
		const tSemi = parseCsv(crSemi);
		expect(tSemi.delimiter).toBe(";");
		expect(tSemi.header.map((c) => c.text)).toEqual(["name", "status"]);
		expect(tSemi.rows.map((r) => r.map((c) => c.text))).toEqual([["A", "done, ok"]]);

		const crTsv = "\r\rname\tstatus\rA\tdone, ok\r";
		const tTsv = parseCsv(crTsv);
		expect(tTsv.delimiter).toBe("\t");
		expect(tTsv.rows.map((r) => r.map((c) => c.text))).toEqual([["A", "done, ok"]]);

		const crPipe = "name|status\rA|done, ok\r";
		const tPipe = parseCsv(crPipe);
		expect(tPipe.delimiter).toBe("|");
		expect(tPipe.rows.map((r) => r.map((c) => c.text))).toEqual([["A", "done, ok"]]);
	});

	test("does not let a stray quote inside an unquoted header field derail delimiter detection", () => {
		const stray = 'Size 12"\tStatus\n1\tdone\n';
		const parsed = parseCsv(stray);
		expect(parsed.delimiter).toBe("\t");
		expect(parsed.header.map((c) => c.text)).toEqual(['Size 12"', "Status"]);
	});
});

describe("Round 5B: csvFormat case deduplication and manifest/schema statuses", () => {
	test("DEFAULT_CSV_TABLE_CONFIG and CSV_STATUS_PRESETS have no case-colliding keys", () => {
		for (const preset of CSV_STATUS_PRESETS) {
			for (const rule of preset.config.rules) {
				const keys = Object.keys(rule.values);
				const lowerKeys = keys.map((k) => k.trim().toLowerCase());
				expect(new Set(lowerKeys).size).toBe(keys.length);
			}
		}
		const defaultKeys = Object.keys(DEFAULT_CSV_TABLE_CONFIG.rules[0]!.values);
		expect(defaultKeys.filter((k) => k.toLowerCase() === "in progress")).toHaveLength(1);
	});

	test("effectiveCsvTableConfig case-deduplicates rule values so edits to 'In Progress' are never shadowed by 'in progress'", () => {
		const cfg = effectiveCsvTableConfig({
			badgeFormatting: true,
			rules: [
				{
					columns: ["status", "STATUS"],
					values: {
						"in progress": "active",
						"In Progress": "warn",
						verified: "done",
					},
					fallback: "waiting",
				},
			],
		});
		const rule = ruleForColumn(cfg, "status")!;
		expect(rule.columns).toEqual(["status"]);
		expect(Object.keys(rule.values).filter((k) => k.toLowerCase() === "in progress")).toHaveLength(1);
		expect(rule.values["In Progress"]).toBe("warn");
		expect(badgeToneForValue(rule, "In Progress")).toBe("warn");
		expect(badgeToneForValue(rule, "in progress")).toBe("warn");
		expect(knownBadgeValues(rule).find((e) => e.value.toLowerCase() === "in progress")).toEqual({
			value: "In Progress",
			tone: "warn",
		});

		// Even on an un-normalized rule object passed directly, later case-colliding value wins.
		const unnormalized = {
			columns: ["status"],
			values: { "in progress": "active" as const, "In Progress": "error" as const },
			fallback: "waiting" as const,
		};
		expect(badgeToneForValue(unnormalized, "In Progress")).toBe("error");
		expect(knownBadgeValues(unnormalized)).toEqual([{ value: "In Progress", tone: "error" }]);
	});

	test("REGISTRY_STATUS_VALUES recognizes 'changed' (warn) and 'gone' (off) without false-positive unrecognized-badge warnings", () => {
		const defaultRule = ruleForColumn(effectiveCsvTableConfig(), "status")!;
		const registryRule = ruleForColumn(CSV_STATUS_PRESETS.find((p) => p.id === "registry")!.config, "status")!;

		for (const rule of [defaultRule, registryRule]) {
			expect(badgeToneForValue(rule, "changed")).toBe("warn");
			expect(badgeToneForValue(rule, "CHANGED")).toBe("warn");
			expect(badgeToneForValue(rule, "gone")).toBe("off");
			expect(badgeToneForValue(rule, "GONE")).toBe("off");
			expect(isUnrecognizedBadgeValue(rule, "changed")).toBe(false);
			expect(isUnrecognizedBadgeValue(rule, "CHANGED")).toBe(false);
			expect(isUnrecognizedBadgeValue(rule, "gone")).toBe(false);
			expect(isUnrecognizedBadgeValue(rule, "GONE")).toBe(false);
		}
	});
});

describe("Round 5B: tablePower regex+wholeWord and view-state sanitization", () => {
	test("compileCellMatcher regex + wholeWord matches patterns with non-word edges like #\\d+ and :RETURN", () => {
		expect(cellMatchesQuery("Issue #42 fixed", "#\\d+", { regex: true, wholeWord: true })).toBe(true);
		expect(cellMatchesQuery("#42", "#\\d+", { regex: true, wholeWord: true })).toBe(true);
		expect(cellMatchesQuery("Issue #42a fixed", "#\\d+", { regex: true, wholeWord: true })).toBe(false);
		expect(cellMatchesQuery("Issue #42_beta", "#\\d+", { regex: true, wholeWord: true })).toBe(false);

		expect(cellMatchesQuery("  :RETURN;", ":RETURN", { regex: true, wholeWord: true })).toBe(true);
		expect(cellMatchesQuery(":RETURN", ":RETURN", { regex: true, wholeWord: true })).toBe(true);
		expect(cellMatchesQuery(":RETURNVALUE", ":RETURN", { regex: true, wholeWord: true })).toBe(false);
		expect(cellMatchesQuery(":RETURN_1", ":RETURN", { regex: true, wholeWord: true })).toBe(false);

		// Trailing non-word character still enforces leading word boundary
		expect(cellMatchesQuery("say foo! now", "foo!", { regex: true, wholeWord: true })).toBe(true);
		expect(cellMatchesQuery("barfoo! now", "foo!", { regex: true, wholeWord: true })).toBe(false);

		// Capture group numbering stays intact under wholeWord wrapping
		expect(replaceCellMatches("See #42 and #99a", "#(\\d+)", "T-$1", { regex: true, wholeWord: true })).toBe(
			"See T-42 and #99a",
		);

		// Unbalanced regex syntax is still rejected cleanly when wholeWord is true
		expect(compileCellMatcher("a)(?:b", { regex: true, wholeWord: true })?.ok).toBe(false);
		expect(compileCellMatcher("[unclosed(", { regex: true, wholeWord: true })?.ok).toBe(false);
	});

	test("sanitizeTableViewState strips hiddenCols from frozenCols (after clamping hiddenCols)", () => {
		const clean = sanitizeTableViewState(
			{
				frozenCols: [0, 1, 2],
				hiddenCols: [1, 2],
			},
			4,
		);
		expect(clean?.hiddenCols).toEqual([1, 2]);
		expect(clean?.frozenCols).toEqual([0]);

		// Without colCount, overlap is still stripped
		const unbounded = sanitizeTableViewState({
			frozenCols: [2, 0],
			hiddenCols: [0],
		});
		expect(unbounded?.hiddenCols).toEqual([0]);
		expect(unbounded?.frozenCols).toEqual([2]);

		// When hiddenCols tries to hide every column, clamping keeps the last column visible,
		// so if that column was frozen it remains frozen.
		const clamped = sanitizeTableViewState(
			{
				frozenCols: [0, 1],
				hiddenCols: [0, 1],
			},
			2,
		);
		expect(clamped?.hiddenCols).toEqual([0]);
		expect(clamped?.frozenCols).toEqual([1]);

		// Round-trip through persisted store never retains frozen/hidden overlap
		let store = parseTableViewStateStore(null);
		store = upsertTableViewState(store, "docs/reg.csv", { frozenCols: [0, 1], hiddenCols: [1] }, 1000);
		const reloaded = parseTableViewStateStore(serializeTableViewStateStore(store));
		expect(getTableViewState(reloaded, "docs/reg.csv", 3)).toEqual({
			colWidths: {},
			frozenCols: [0],
			colOrder: [],
			hiddenCols: [1],
			order: [],
			groupByCol: null,
		});
	});
});
