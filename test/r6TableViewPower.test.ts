import { describe, expect, test } from "bun:test";
import { placeAnchoredMenu } from "../src/shared/contextMenu";
import {
	AUTOFIT_SAMPLE_LIMIT,
	cellMatchesQuery,
	cellsToMarkdownTable,
	compareRowsBySorts,
	compileCellMatcher,
	computeVirtualWindow,
	DEFAULT_ROW_HEIGHT,
	extractFirstHttpUrl,
	findUnknownTicketTokens,
	generateFillSeries,
	getTableViewState,
	isCellInFindSelection,
	isDedicatedTicketColumn,
	isSchemaTableColumn,
	nextTableIssueIndex,
	parseTableViewStateStore,
	pruneSortSpecs,
	remapSortSpecs,
	replaceCellMatches,
	sampleRowsForAutoFit,
	serializeTableViewStateStore,
	setColumnSortDirection,
	splitCellUrls,
	summarizeTableIssues,
	TABLE_VIEW_STATE_MAX_FILES,
	tableViewFileKey,
	tableViewStateStorageKey,
	toggleSortSpec,
	tokenizeCellLinks,
	upsertTableViewState,
	type SortSpec,
	type TableIssue,
} from "../src/shared/tablePower";

describe("Multi-column sorting (SortSpec)", () => {
	test("plain click cycles asc -> desc -> clear and replaces active multi-sort", () => {
		let sorts: SortSpec[] = [];
		sorts = toggleSortSpec(sorts, 1, false);
		expect(sorts).toEqual([{ column: 1, down: false }]);
		sorts = toggleSortSpec(sorts, 1, false);
		expect(sorts).toEqual([{ column: 1, down: true }]);
		sorts = toggleSortSpec(sorts, 1, false);
		expect(sorts).toEqual([]);

		// Switching to another column resets to single asc on the new column
		sorts = toggleSortSpec([{ column: 0, down: false }, { column: 2, down: true }], 1, false);
		expect(sorts).toEqual([{ column: 1, down: false }]);
	});

	test("Shift+Click appends secondary/tertiary sorts, flips direction in-place, and removes on 3rd click", () => {
		let sorts: SortSpec[] = [{ column: 0, down: false }];
		sorts = toggleSortSpec(sorts, 2, true);
		expect(sorts).toEqual([
			{ column: 0, down: false },
			{ column: 2, down: false },
		]);
		sorts = toggleSortSpec(sorts, 1, true);
		expect(sorts).toEqual([
			{ column: 0, down: false },
			{ column: 2, down: false },
			{ column: 1, down: false },
		]);
		// Flip secondary column in-place without losing priority slot #2
		sorts = toggleSortSpec(sorts, 2, true);
		expect(sorts).toEqual([
			{ column: 0, down: false },
			{ column: 2, down: true },
			{ column: 1, down: false },
		]);
		// Third Shift+Click removes column 2 while promoting column 1 to priority #2
		sorts = toggleSortSpec(sorts, 2, true);
		expect(sorts).toEqual([
			{ column: 0, down: false },
			{ column: 1, down: false },
		]);
	});

	test("setColumnSortDirection supports primary replacement and additive multi-sort updates", () => {
		expect(setColumnSortDirection([{ column: 0, down: false }], 2, true, true)).toEqual([
			{ column: 0, down: false },
			{ column: 2, down: true },
		]);
		expect(setColumnSortDirection([{ column: 0, down: false }, { column: 2, down: true }], 2, false, true)).toEqual([
			{ column: 0, down: false },
			{ column: 2, down: false },
		]);
		expect(setColumnSortDirection([{ column: 0, down: false }, { column: 2, down: true }], 1, true, false)).toEqual([
			{ column: 1, down: true },
		]);
	});

	test("compareRowsBySorts breaks ties across priority columns with numeric awareness", () => {
		const data = [
			["verified", "Item 10", "low"],
			["in progress", "Item 2", "high"],
			["verified", "Item 2", "high"],
			["verified", "Item 2", "low"],
		];
		const sorts: SortSpec[] = [
			{ column: 0, down: false }, // status asc
			{ column: 1, down: false }, // name numeric asc
			{ column: 2, down: true }, // priority desc ("low" before "high")
		];
		const sorted = [...data].sort((a, b) => compareRowsBySorts(a, b, sorts, (row, c) => row[c] ?? ""));
		expect(sorted).toEqual([
			["in progress", "Item 2", "high"],
			["verified", "Item 2", "low"],
			["verified", "Item 2", "high"],
			["verified", "Item 10", "low"],
		]);
	});

	test("remapSortSpecs and pruneSortSpecs shift indices and drop deleted/out-of-range columns", () => {
		const sorts: SortSpec[] = [
			{ column: 2, down: false },
			{ column: 1, down: true },
			{ column: 4, down: false },
		];
		// Deleting column 1 shifts 2->1 and 4->3
		expect(remapSortSpecs(sorts, (c) => (c === 1 ? -1 : c > 1 ? c - 1 : c))).toEqual([
			{ column: 1, down: false },
			{ column: 3, down: false },
		]);
		expect(pruneSortSpecs(sorts, 3)).toEqual([
			{ column: 2, down: false },
			{ column: 1, down: true },
		]);
	});
});

describe("Per-file TableView state persistence (workspace-scoped LRU)", () => {
	test("generates workspace-scoped storage keys and canonical relative file keys", () => {
		const k1 = tableViewStateStorageKey("/workspace/project-a/");
		const k2 = tableViewStateStorageKey("/workspace/project-b");
		expect(k1).not.toBe(k2);
		expect(tableViewFileKey("/workspace/project-a/docs/database.csv", "/workspace/project-a")).toBe("docs/database.csv");
		expect(tableViewFileKey("/workspace/project-a/Docs/Database.CSV", "/workspace/project-a")).toBe("docs/database.csv");
	});

	test("serializes, restores, prunes out-of-range columns, and clears default entries", () => {
		let store = parseTableViewStateStore(null);
		store = upsertTableViewState(
			store,
			"docs/database.csv",
			{
				colWidths: { 0: 180, 2: 260 },
				frozenCols: [0],
				colOrder: [0, 2, 1],
				hiddenCols: [3],
				order: [{ column: 0, down: false }, { column: 2, down: true }],
				groupByCol: 1,
			},
			1000,
		);
		const roundTripped = parseTableViewStateStore(serializeTableViewStateStore(store));
		expect(getTableViewState(roundTripped, "docs/database.csv", 4)).toEqual({
			colWidths: { 0: 180, 2: 260 },
			frozenCols: [0],
			colOrder: [0, 2, 1],
			hiddenCols: [3],
			order: [{ column: 0, down: false }, { column: 2, down: true }],
			groupByCol: 1,
		});
		// If file shrinks to 2 columns, column indices >= 2 are cleanly pruned
		expect(getTableViewState(roundTripped, "docs/database.csv", 2)).toEqual({
			colWidths: { 0: 180 },
			frozenCols: [0],
			colOrder: [0, 1],
			hiddenCols: [],
			order: [{ column: 0, down: false }],
			groupByCol: 1,
		});
		// Resetting to defaults removes the file's entry completely
		const resetStore = upsertTableViewState(roundTripped, "docs/database.csv", {
			colWidths: {},
			frozenCols: [],
			colOrder: [],
			hiddenCols: [],
			order: [],
			groupByCol: null,
		});
		expect(getTableViewState(resetStore, "docs/database.csv")).toBeNull();
		expect(Object.keys(resetStore.entries)).toHaveLength(0);
	});

	test("enforces bounded LRU ceiling of 40 files and handles corrupt JSON gracefully", () => {
		expect(TABLE_VIEW_STATE_MAX_FILES).toBe(40);
		let store = parseTableViewStateStore("{not valid json");
		expect(store).toEqual({ version: 1, entries: {} });

		for (let i = 0; i < 45; i++) {
			store = upsertTableViewState(
				store,
				`docs/reg-${i}.csv`,
				{ colWidths: { 0: 120 + i } },
				1000 + i * 10,
			);
		}
		expect(Object.keys(store.entries)).toHaveLength(40);
		// Oldest 5 entries (0..4) evicted; newest 40 entries (5..44) retained
		expect(getTableViewState(store, "docs/reg-0.csv")).toBeNull();
		expect(getTableViewState(store, "docs/reg-4.csv")).toBeNull();
		expect(getTableViewState(store, "docs/reg-5.csv")?.colWidths).toEqual({ 0: 125 });
		expect(getTableViewState(store, "docs/reg-44.csv")?.colWidths).toEqual({ 0: 164 });
	});
});

describe("Excel drag-fill series progression (generateFillSeries)", () => {
	test("progresses single integers, zero-padded integers, negative integers, and stepped sequences", () => {
		expect(generateFillSeries(["1"], 3)).toEqual(["2", "3", "4"]);
		expect(generateFillSeries(["-2"], 3)).toEqual(["-1", "0", "1"]);
		expect(generateFillSeries(["001"], 3)).toEqual(["002", "003", "004"]);
		expect(generateFillSeries(["10", "20"], 3)).toEqual(["30", "40", "50"]);
		expect(generateFillSeries(["100", "95"], 2)).toEqual(["90", "85"]);
		expect(generateFillSeries(["1.5", "2.0"], 3)).toEqual(["2.5", "3.0", "3.5"]);
	});

	test("progresses prefix + number strings preserving zero padding and custom steps", () => {
		expect(generateFillSeries(["DEMO-101"], 3)).toEqual(["DEMO-102", "DEMO-103", "DEMO-104"]);
		expect(generateFillSeries(["TC-001"], 3)).toEqual(["TC-002", "TC-003", "TC-004"]);
		expect(generateFillSeries(["TC-009"], 2)).toEqual(["TC-010", "TC-011"]);
		expect(generateFillSeries(["DEMO-100", "DEMO-110"], 2)).toEqual(["DEMO-120", "DEMO-130"]);
		expect(generateFillSeries(["Row 1"], 2)).toEqual(["Row 2", "Row 3"]);
	});

	test("progresses ISO dates across month/year boundaries and multi-seed intervals", () => {
		expect(generateFillSeries(["2026-11-23"], 3)).toEqual(["2026-11-24", "2026-11-25", "2026-11-26"]);
		expect(generateFillSeries(["2026-12-30"], 3)).toEqual(["2026-12-31", "2027-01-01", "2027-01-02"]);
		expect(generateFillSeries(["2026-11-01", "2026-11-08"], 2)).toEqual(["2026-11-15", "2026-11-22"]);
		// Invalid calendar dates fall back cleanly without throwing
		expect(generateFillSeries(["2026-02-31"], 1)).toEqual(["2026-02-32"]);
	});

	test("repeats plain text, supports Alt literal copy, and supports reverse fill", () => {
		expect(generateFillSeries(["in progress"], 3)).toEqual(["in progress", "in progress", "in progress"]);
		expect(generateFillSeries(["alpha", "beta"], 4)).toEqual(["alpha", "beta", "alpha", "beta"]);
		// Alt-drag literal copy never increments numbers, prefixes, or dates
		expect(generateFillSeries(["1"], 3, { literal: true })).toEqual(["1", "1", "1"]);
		expect(generateFillSeries(["DEMO-101"], 2, { literal: true })).toEqual(["DEMO-101", "DEMO-101"]);
		expect(generateFillSeries(["2026-11-23"], 2, { literal: true })).toEqual(["2026-11-23", "2026-11-23"]);
		// Reverse fill (dragging up / left)
		expect(generateFillSeries(["10"], 2, { reverse: true })).toEqual(["9", "8"]);
		expect(generateFillSeries(["10", "20"], 2, { reverse: true })).toEqual(["0", "-10"]);
		expect(generateFillSeries(["2026-11-23"], 2, { reverse: true })).toEqual(["2026-11-22", "2026-11-21"]);
		expect(generateFillSeries(["DEMO-105"], 2, { reverse: true })).toEqual(["DEMO-104", "DEMO-103"]);
	});
});

describe("Markdown table serialization (cellsToMarkdownTable)", () => {
	test("escapes literal pipes, normalizes embedded newlines, and pads ragged rows", () => {
		const md = cellsToMarkdownTable(
			["Name", "Expr | Rule", "Notes"],
			[
				["SAMPLES", "A | B", "Line 1\nLine 2"],
				["RESULTS", "plain"],
			],
		);
		expect(md).toBe(
			[
				"| Name | Expr \\| Rule | Notes |",
				"| --- | --- | --- |",
				"| SAMPLES | A \\| B | Line 1<br>Line 2 |",
				"| RESULTS | plain |  |",
			].join("\n"),
		);
		expect(cellsToMarkdownTable([], [])).toBe("");
	});
});

describe("Find & Replace cell matching (Whole Word, Regex, In Selection)", () => {
	test("supports whole-word matching and case sensitivity", () => {
		expect(cellMatchesQuery("DEMO-1, DEMO-2", "DEMO-1", { wholeWord: true })).toBe(true);
		expect(cellMatchesQuery("DEMO-10", "DEMO-1", { wholeWord: true })).toBe(false);
		expect(cellMatchesQuery("DEMO-1_extra", "DEMO-1", { wholeWord: true })).toBe(false);
		expect(cellMatchesQuery("verified", "VERIFIED", { caseSensitive: false })).toBe(true);
		expect(cellMatchesQuery("verified", "VERIFIED", { caseSensitive: true })).toBe(false);
	});

	test("supports regex matching, capture-group replace, literal $ safety, and safe invalid-regex handling", () => {
		expect(cellMatchesQuery("DEMO-104", "^DEMO-\\d+$", { regex: true })).toBe(true);
		expect(replaceCellMatches("DEMO-104 and DEMO-205", "DEMO-(\\d+)", "LIMS-$1", { regex: true })).toBe(
			"LIMS-104 and LIMS-205",
		);
		// Non-regex replace never interprets `$1` / `$&`
		expect(replaceCellMatches("cost is $old", "$old", "$100 $&", { regex: false })).toBe("cost is $100 $&");

		// Invalid regex returns { ok: false, error } without throwing
		const invalid = compileCellMatcher("[unclosed(", { regex: true });
		expect(invalid).not.toBeNull();
		expect(invalid!.ok).toBe(false);
		expect(cellMatchesQuery("anything", "[unclosed(", { regex: true })).toBe(false);
		expect(replaceCellMatches("keep me", "[unclosed(", "x", { regex: true })).toBe("keep me");
	});

	test("scopes matches accurately with isCellInFindSelection", () => {
		const scope = { rows: new Set([1, 2]), cols: new Set([0, 2]) };
		expect(isCellInFindSelection(1, 0, scope)).toBe(true);
		expect(isCellInFindSelection(2, 2, scope)).toBe(true);
		expect(isCellInFindSelection(1, 1, scope)).toBe(false);
		expect(isCellInFindSelection(0, 0, scope)).toBe(false);
		expect(isCellInFindSelection(99, 99, null)).toBe(true);
	});
});

describe("Measured virtualization & auto-fit row sampling", () => {
	test("computeVirtualWindow uses measured variable heights without spacer drift", () => {
		const keys = Array.from({ length: 300 }, (_, i) => i);
		const heights = new Map<number, number>([
			[0, 93],
			[1, 62],
			[10, 124],
		]);
		const layout = computeVirtualWindow(keys, heights, 1500, 400, 200, 5, DEFAULT_ROW_HEIGHT);
		expect(layout.virtual).toBe(true);
		// Exact total height = 93 + 62 + 124 + 297 * 31
		expect(layout.totalHeight).toBe(93 + 62 + 124 + 297 * DEFAULT_ROW_HEIGHT);
		expect(layout.topPad).toBe(layout.offsets[layout.start]);
		expect(layout.bottomPad).toBe(layout.totalHeight - layout.offsets[layout.end]!);
		// Small tables stay non-virtual
		expect(computeVirtualWindow(keys.slice(0, 100), heights, 0, 400).virtual).toBe(false);
	});

	test("sampleRowsForAutoFit caps at 500 evenly distributed rows including first and last", () => {
		expect(AUTOFIT_SAMPLE_LIMIT).toBe(500);
		const small = Array.from({ length: 120 }, (_, i) => i);
		expect(sampleRowsForAutoFit(small)).toEqual(small);

		const large = Array.from({ length: 2000 }, (_, i) => i);
		const sampled = sampleRowsForAutoFit(large, 500);
		expect(sampled).toHaveLength(500);
		expect(sampled[0]).toBe(0);
		expect(sampled[sampled.length - 1]).toBe(1999);
	});
});

describe("URL, multi-column ticket, schema column & unified inline issue helpers", () => {
	test("splitCellUrls and extractFirstHttpUrl handle URLs, balanced parens, and reject unsafe schemes", () => {
		expect(extractFirstHttpUrl("See https://example.org/docs_(v2). for details")).toBe("https://example.org/docs_(v2)");
		expect(extractFirstHttpUrl("javascript:alert(1)")).toBeNull();
		expect(splitCellUrls("Spec: https://example.org/a, backup http://example.org/b.")).toEqual([
			{ kind: "text", text: "Spec: " },
			{ kind: "url", text: "https://example.org/a", url: "https://example.org/a" },
			{ kind: "text", text: ", backup " },
			{ kind: "url", text: "http://example.org/b", url: "http://example.org/b" },
			{ kind: "text", text: "." },
		]);
	});

	test("tokenizeCellLinks detects URLs and known tickets in any column without false-linking bare numbers", () => {
		const known = new Set(["demo-101", "42"]);
		expect(tokenizeCellLinks("Tracked in (DEMO-101) and #42, count 42", known)).toEqual([
			{ kind: "text", text: "Tracked in (" },
			{ kind: "ticket", text: "DEMO-101", key: "DEMO-101" },
			{ kind: "text", text: ") and " },
			{ kind: "ticket", text: "#42", key: "42" },
			{ kind: "text", text: ", count 42" },
		]);
		// Ticket key inside a URL stays part of the URL, never split
		expect(tokenizeCellLinks("https://tracker.example.org/browse/DEMO-101", known)).toEqual([
			{ kind: "url", text: "https://tracker.example.org/browse/DEMO-101", url: "https://tracker.example.org/browse/DEMO-101" },
		]);
	});

	test("schema table columns work across registries and unknown ticket tokens ignore placeholders & URLs", () => {
		expect(isSchemaTableColumn("table", false)).toBe(true);
		expect(isSchemaTableColumn("db_table", false)).toBe(true);
		expect(isSchemaTableColumn("object", false)).toBe(true);
		expect(isSchemaTableColumn("entity", false)).toBe(true);
		expect(isSchemaTableColumn("name", false)).toBe(false);
		expect(isSchemaTableColumn("name", true)).toBe(true);

		expect(isDedicatedTicketColumn("ticket")).toBe(true);
		expect(isDedicatedTicketColumn("Tickets")).toBe(true);
		expect(isDedicatedTicketColumn("jira_key")).toBe(true);
		expect(isDedicatedTicketColumn("notes")).toBe(false);

		const known = new Set(["demo-101"]);
		expect(findUnknownTicketTokens("DEMO-101, DEMO-999, N/A, https://example.org/x", known)).toEqual(["DEMO-999"]);
	});

	test("summarizeTableIssues and nextTableIssueIndex navigate forward/backward with wraparound", () => {
		const issues: TableIssue[] = [
			{ row: 1, column: 0, kind: "duplicate-key", message: "Duplicate key" },
			{ row: 3, column: 2, kind: "missing-path", message: "Missing file" },
			{ row: 3, column: 4, kind: "unknown-ticket", message: "Unknown ticket" },
			{ row: 5, column: 1, kind: "unrecognized-badge", message: "Unrecognized status" },
		];
		expect(summarizeTableIssues(issues)).toBe("1 missing file, 1 unknown ticket, 1 unrecognized badge, 1 duplicate key");
		// Starting with no active cell jumps to first (F8) or last (Shift+F8)
		expect(nextTableIssueIndex(issues, null, 1)).toBe(0);
		expect(nextTableIssueIndex(issues, null, -1)).toBe(3);
		// Stepping forward from (1, 0) goes to (3, 2), then (3, 4), then (5, 1), then wraps to (1, 0)
		expect(nextTableIssueIndex(issues, { row: 1, column: 0 }, 1)).toBe(1);
		expect(nextTableIssueIndex(issues, { row: 3, column: 2 }, 1)).toBe(2);
		expect(nextTableIssueIndex(issues, { row: 5, column: 1 }, 1)).toBe(0);
		// Stepping backward from (3, 2) goes to (1, 0), and from (1, 0) wraps to (5, 1)
		expect(nextTableIssueIndex(issues, { row: 3, column: 2 }, -1)).toBe(0);
		expect(nextTableIssueIndex(issues, { row: 1, column: 0 }, -1)).toBe(3);
	});

	test("placeAnchoredMenu flips measured filter popover upward near bottom of a split pane", () => {
		const placed = placeAnchoredMenu(
			{ left: 620, right: 644, top: 610, bottom: 636 },
			{ width: 280, height: 310 },
			{ width: 800, height: 700 },
			8,
			4,
		);
		expect(placed.direction).toBe("up");
		expect(placed.top).toBeLessThan(610);
		expect(placed.left).toBeGreaterThanOrEqual(8);
		expect(placed.left + 280).toBeLessThanOrEqual(800 - 8);
	});
});
