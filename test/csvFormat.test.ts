import { describe, expect, test } from "bun:test";
import { parseCsv, reorderCsvColumns } from "../src/shared/csv";
import {
	badgeToneForValue,
	columnValueOptions,
	CSV_STATUS_PRESETS,
	DEFAULT_CSV_TABLE_CONFIG,
	describeColumnFilter,
	distinctTableValuesForColumns,
	effectiveCsvTableConfig,
	ensureRuleForColumn,
	fullColumnOrder,
	hideColumn,
	isColumnFilterActive,
	isNaturalOrder,
	moveColumnInList,
	pruneColumnOrder,
	pruneFrozenColumns,
	pruneHiddenColumns,
	remapColumnIndex,
	removeColumnFromRules,
	rowMatchesColumnFilters,
	ruleForColumn,
	showColumn,
	suggestionsForColumn,
	toggleColumnFilterValue,
	toggleFrozenColumn,
	visualColumnOrder,
	type ColumnFilter,
} from "../src/shared/csvFormat";

describe("configurable CSV column badge formatting", () => {
	test("defaults include both STARLIMS lifecycle statuses and migration registry statuses", () => {
		const cfg = effectiveCsvTableConfig();
		expect(cfg.badgeFormatting).toBe(true);
		const rule = ruleForColumn(cfg, "STATUS");
		expect(rule).not.toBeNull();
		// Registry workflow statuses
		expect(badgeToneForValue(rule, "verified")).toBe("done");
		expect(badgeToneForValue(rule, "migrated")).toBe("done");
		expect(badgeToneForValue(rule, "found")).toBe("waiting");
		expect(badgeToneForValue(rule, "blocked")).toBe("error");
		expect(badgeToneForValue(rule, "not needed")).toBe("off");
		// STARLIMS lifecycle statuses (case-insensitive)
		expect(badgeToneForValue(rule, "Prelogged")).toBe("waiting");
		expect(badgeToneForValue(rule, "logged")).toBe("active");
		expect(badgeToneForValue(rule, "InPrep")).toBe("active");
		expect(badgeToneForValue(rule, "APPROVED")).toBe("done");
		expect(badgeToneForValue(rule, "Released")).toBe("done");
		expect(badgeToneForValue(rule, "On Hold")).toBe("warn");
		expect(badgeToneForValue(rule, "OOS")).toBe("warn");
		expect(badgeToneForValue(rule, "Retest")).toBe("warn");
		expect(badgeToneForValue(rule, "Rejected")).toBe("error");
		expect(badgeToneForValue(rule, "Cancelled")).toBe("off");
		expect(badgeToneForValue(rule, "Disposed")).toBe("off");
		// Empty cells never render a pill
		expect(badgeToneForValue(rule, "   ")).toBeNull();
		// Unmatched columns stay plain text
		expect(ruleForColumn(cfg, "note")).toBeNull();
	});

	test("disabling badgeFormatting turns off all special column formatting", () => {
		const cfg = effectiveCsvTableConfig({ badgeFormatting: false, rules: DEFAULT_CSV_TABLE_CONFIG.rules });
		expect(ruleForColumn(cfg, "status")).toBeNull();
		expect(ruleForColumn(cfg, "sample_status")).toBeNull();
	});

	test("custom rules format arbitrary columns and honor fallback: 'none'", () => {
		const cfg = effectiveCsvTableConfig({
			badgeFormatting: true,
			rules: [
				{
					columns: ["priority", "severity"],
					values: { rush: "error", urgent: "warn", routine: "waiting" },
					fallback: "none",
				},
			],
		});
		// Status column is no longer magically formatted when omitted from rules!
		expect(ruleForColumn(cfg, "status")).toBeNull();
		const prio = ruleForColumn(cfg, "Priority");
		expect(prio).not.toBeNull();
		expect(badgeToneForValue(prio, "RUSH")).toBe("error");
		expect(badgeToneForValue(prio, "urgent")).toBe("warn");
		expect(badgeToneForValue(prio, "other")).toBeNull();
	});

	test("removeColumnFromRules and ensureRuleForColumn update rules cleanly", () => {
		const stripped = removeColumnFromRules(DEFAULT_CSV_TABLE_CONFIG, "status");
		expect(ruleForColumn(stripped, "status")).toBeNull();
		expect(ruleForColumn(stripped, "sample_status")).not.toBeNull();

		const { config, ruleIndex } = ensureRuleForColumn(stripped, "kind", ["table", "data source", "table", ""]);
		expect(config.rules[ruleIndex]?.columns).toEqual(["kind"]);
		expect(Object.keys(config.rules[ruleIndex]!.values)).toEqual(["table", "data source"]);
		expect(ruleForColumn(config, "kind")).not.toBeNull();
	});

	test("suggestionsForColumn merges existing table values and configured rule values without case duplicates", () => {
		const starlims = CSV_STATUS_PRESETS.find((p) => p.id === "starlims")!.config;
		const rule = ruleForColumn(starlims, "status");
		const list = suggestionsForColumn(rule, ["approved", "CustomState", ""]);
		expect(list[0]).toBe("approved");
		expect(list[1]).toBe("CustomState");
		// Should not duplicate "Approved" when "approved" is already present
		expect(list.filter((v) => v.toLowerCase() === "approved")).toHaveLength(1);
		expect(list).toContain("Prelogged");
		expect(list).toContain("OOS");
	});

	test("distinctTableValuesForColumns collects unique non-empty values for matching headers", () => {
		const table = parseCsv("object,kind,status\nA,table,verified\nB,data source,migrated\nC,TABLE,verified\nD,,found\n");
		expect(distinctTableValuesForColumns(table, ["kind"])).toEqual(["table", "data source"]);
	});
});

describe("per-column header filtering", () => {
	const table = parseCsv(
		[
			"name,kind,status,ticket",
			"A,table,verified,DEMO-101",
			"B,table,migrated,DEMO-101",
			"C,data source,migrated,DEMO-102",
			"D,data source,found,DEMO-103",
			"E,table,,DEMO-103",
		].join("\n"),
	);

	test("filters rows across multiple columns with both value sets and text queries", () => {
		const filters = new Map<number, ColumnFilter>([
			[1, { text: "", values: new Set(["table"]) }],
			[2, { text: "", values: new Set(["verified", ""]) }],
		]);
		const kept = table.rows.filter((r) => rowMatchesColumnFilters(r, filters)).map((r) => r[0]!.text);
		expect(kept).toEqual(["A", "E"]);

		const textOnly = new Map<number, ColumnFilter>([[3, { text: "103", values: null }]]);
		expect(table.rows.filter((r) => rowMatchesColumnFilters(r, textOnly)).map((r) => r[0]!.text)).toEqual(["D", "E"]);
	});

	test("computes faceted counts using other active column filters while keeping all column values listed", () => {
		// Filter kind = "table" -> remaining rows are A(verified), B(migrated), E("")
		const filters = new Map<number, ColumnFilter>([[1, { text: "", values: new Set(["table"]) }]]);
		const statusOpts = columnValueOptions(table.rows, table.rows, 2, filters);
		const byKey = new Map(statusOpts.map((o) => [o.key, o]));
		expect(byKey.get("verified")?.count).toBe(1);
		expect(byKey.get("migrated")?.count).toBe(1);
		expect(byKey.get("")?.count).toBe(1);
		// "found" only appears on data source row D, so faceted count is 0 while total is 1
		expect(byKey.get("found")?.count).toBe(0);
		expect(byKey.get("found")?.total).toBe(1);
	});

	test("toggleColumnFilterValue unchecks from 'all' and collapses back to null when all values are checked", () => {
		const keys = ["verified", "migrated", "found", ""];
		const afterUncheck = toggleColumnFilterValue(undefined, "found", keys);
		expect(afterUncheck?.values).toEqual(new Set(["verified", "migrated", ""]));
		expect(isColumnFilterActive(afterUncheck)).toBe(true);

		const afterRecheck = toggleColumnFilterValue(afterUncheck, "found", keys);
		expect(afterRecheck).toBeUndefined();
	});

	test("describeColumnFilter formats concise summaries for toolbar chips", () => {
		const opts = columnValueOptions(table.rows, table.rows, 2, new Map());
		expect(describeColumnFilter("status", { text: "", values: new Set(["verified"]) }, opts)).toBe("status: verified");
		expect(describeColumnFilter("status", { text: "", values: new Set(["verified", ""]) }, opts)).toBe("status: verified, (empty)");
		expect(describeColumnFilter("status", { text: "", values: new Set(["verified", "migrated", "found"]) }, opts)).toBe("status: 3 selected");
		expect(describeColumnFilter("ticket", { text: "101", values: null }, opts)).toBe("ticket: “101”");
	});
});

describe("CSV column freezing", () => {
	test("visualColumnOrder moves frozen columns to the left in freeze order without altering file columns", () => {
		expect(visualColumnOrder(6, [])).toEqual([0, 1, 2, 3, 4, 5]);
		expect(visualColumnOrder(6, [3])).toEqual([3, 0, 1, 2, 4, 5]);
		expect(visualColumnOrder(6, [3, 0])).toEqual([3, 0, 1, 2, 4, 5]);
		expect(visualColumnOrder(6, [5, 2, 5, -1, 99])).toEqual([5, 2, 0, 1, 3, 4]);
	});

	test("toggleFrozenColumn freezes and unfreezes cleanly and pruneFrozenColumns drops removed columns", () => {
		let frozen: number[] = [];
		frozen = toggleFrozenColumn(frozen, 3);
		expect(frozen).toEqual([3]);
		frozen = toggleFrozenColumn(frozen, 0);
		expect(frozen).toEqual([3, 0]);
		frozen = toggleFrozenColumn(frozen, 3);
		expect(frozen).toEqual([0]);
		expect(pruneFrozenColumns([0, 4, 2, 4], 3)).toEqual([0, 2]);
	});
});

describe("CSV column reordering", () => {
	test("visualColumnOrder combines frozen columns with custom base order cleanly", () => {
		const custom = moveColumnInList([0, 1, 2, 3, 4], 4, 1); // [0, 4, 1, 2, 3]
		expect(custom).toEqual([0, 4, 1, 2, 3]);
		expect(isNaturalOrder(custom)).toBe(false);
		expect(isNaturalOrder([0, 1, 2])).toBe(true);
		// Freeze col 3 while custom order is active: col 3 goes left, rest keep custom order
		expect(visualColumnOrder(5, [3], custom)).toEqual([3, 0, 4, 1, 2]);
		// Prune appends newly added columns and removes out-of-range ones
		expect(pruneColumnOrder([2, 0, 9, 2], 4)).toEqual([2, 0, 1, 3]);
		expect(remapColumnIndex(4, custom)).toBe(1);
	});

	test("reorderCsvColumns rewrites columns verbatim preserving quoting, CRLF, TSV, multiline cells, and ragged rows", () => {
		const csv = 'name,note,status\r\nMaxWalkDays,"Line 1\r\nLine ""2""",verified\r\nShortRow,only-two\r\nRagged,a,found,extra-cell\r\n';
		const table = parseCsv(csv);
		const reordered = reorderCsvColumns(csv, table, [2, 0, 1]);
		expect(reordered).toBe(
			'status,name,note\r\nverified,MaxWalkDays,"Line 1\r\nLine ""2"""\r\n,ShortRow,only-two\r\nfound,Ragged,a,extra-cell\r\n',
		);

		// TSV with blank line and no trailing newline
		const tsv = "a\tb\tc\n\n1\t2\t3";
		expect(reorderCsvColumns(tsv, parseCsv(tsv), [2, 1, 0])).toBe("c\tb\ta\n\n3\t2\t1");

		// Natural order or invalid permutation returns null
		expect(reorderCsvColumns(csv, table, [0, 1, 2])).toBeNull();
		expect(reorderCsvColumns(csv, table, [0, 0, 1])).toBeNull();
	});

	test("hideColumn never hides the last visible column and fullColumnOrder preserves hidden columns", () => {
		let hidden = new Set<number>();
		hidden = hideColumn(hidden, 2, 3);
		hidden = hideColumn(hidden, 1, 3);
		// Cannot hide column 0 because it is the last visible column
		hidden = hideColumn(hidden, 0, 3);
		expect([...hidden].sort()).toEqual([1, 2]);
		expect(visualColumnOrder(3, [], undefined, hidden)).toEqual([0]);
		expect(fullColumnOrder(3, [], [2, 0, 1])).toEqual([2, 0, 1]);

		hidden = showColumn(hidden, 1);
		expect(visualColumnOrder(3, [], undefined, hidden)).toEqual([0, 1]);
		expect([...pruneHiddenColumns(new Set([0, 1, 2, 9]), 3)].sort()).toEqual([0, 1]);
	});
});
