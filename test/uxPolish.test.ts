import { describe, expect, test } from "bun:test";
import { aggregateDocIssues, applyMultiSelectClick, hasAnyDocIssue } from "../src/shared/docSelection";
import { countIndentCols, parseListLine } from "../src/shared/listIndent";
import { resolveReadAssistActiveIndex } from "../src/shared/readAssist";
import {
	parseMarkdownViewMode,
	parsePlanViewMode,
	parseTableTextMode,
	resolveMarkdownMode,
	resolvePlanMode,
	resolveTableTextMode,
	shouldUpdateDefaultMode,
} from "../src/shared/viewModes";
import type { DocFile } from "../src/shared/protocol";

describe("file-type editor view modes", () => {
	test("parses valid persisted values and rejects garbage", () => {
		expect(parseMarkdownViewMode("read")).toBe("read");
		expect(parseMarkdownViewMode("live")).toBe("live");
		expect(parseMarkdownViewMode("source")).toBe("source");
		expect(parseMarkdownViewMode("invalid")).toBeNull();
		expect(parseMarkdownViewMode(null)).toBeNull();

		expect(parsePlanViewMode("chart")).toBe("chart");
		expect(parsePlanViewMode("text")).toBe("text");
		expect(parsePlanViewMode("source")).toBe("source");
		expect(parsePlanViewMode("other")).toBeNull();

		expect(parseTableTextMode("true")).toBe(true);
		expect(parseTableTextMode("false")).toBe(false);
		expect(parseTableTextMode("")).toBeNull();
	});

	test("resolves Markdown mode by file type: group override -> persisted default -> livePreview setting", () => {
		expect(resolveMarkdownMode(undefined, null, undefined)).toBe("live");
		expect(resolveMarkdownMode(undefined, null, false)).toBe("source");
		expect(resolveMarkdownMode(undefined, "read", true)).toBe("read");
		expect(resolveMarkdownMode("source", "read", true)).toBe("source");
		expect(resolveMarkdownMode("read", "live", true)).toBe("read");
	});

	test("resolves Plan and Table modes by file type", () => {
		expect(resolvePlanMode(undefined, null)).toBe("chart");
		expect(resolvePlanMode(undefined, "text")).toBe("text");
		expect(resolvePlanMode("source", "text")).toBe("source");

		expect(resolveTableTextMode(undefined, null)).toBe(false);
		expect(resolveTableTextMode(undefined, true)).toBe(true);
		expect(resolveTableTextMode(false, true)).toBe(false);
	});

	test("updates global file-type default for primary/single group while keeping split side previews independent", () => {
		expect(shouldUpdateDefaultMode(undefined, 1)).toBe(true);
		expect(shouldUpdateDefaultMode(0, 1)).toBe(true);
		expect(shouldUpdateDefaultMode(0, 2)).toBe(true);
		expect(shouldUpdateDefaultMode(1, 2)).toBe(false);
		expect(shouldUpdateDefaultMode(1, 1)).toBe(true);
	});
});

describe("Markdown list hanging-indent parser", () => {
	test("parses top-level and nested unordered bullets", () => {
		const top = parseListLine("- `DueDates.DueRule` picks the rule.");
		expect(top).not.toBeNull();
		expect(top!.kind).toBe("bullet");
		expect(top!.indentEm).toBe(0);
		expect(top!.hangEm).toBe(1.5);
		expect(top!.markerFrom).toBe(0);
		expect(top!.markerTo).toBe(2);

		const nested2 = parseListLine("  * Nested item");
		expect(nested2).not.toBeNull();
		expect(nested2!.indentEm).toBe(1.4);
		expect(nested2!.markerFrom).toBe(2);
		expect(nested2!.markerTo).toBe(4);

		const nestedTab = parseListLine("\t+ Tab-indented item");
		expect(nestedTab).not.toBeNull();
		expect(countIndentCols("\t")).toBe(4);
		expect(nestedTab!.indentEm).toBe(2.8);
	});

	test("parses ordered lists with width scaled for multi-digit numbers", () => {
		const one = parseListLine("1. First step");
		expect(one).not.toBeNull();
		expect(one!.kind).toBe("ordered");
		expect(one!.markerText).toBe("1.");
		expect(one!.hangEm).toBeGreaterThanOrEqual(1.75);

		const ten = parseListLine("10. Tenth step");
		const hundred = parseListLine("100) Hundredth step");
		expect(ten!.hangEm).toBeGreaterThan(one!.hangEm);
		expect(hundred!.hangEm).toBeGreaterThan(ten!.hangEm);
	});

	test("parses task checkboxes and preserves bracket offset", () => {
		const todo = parseListLine("  - [ ] Verify holiday dates");
		expect(todo).not.toBeNull();
		expect(todo!.kind).toBe("task");
		expect(todo!.checked).toBe(false);
		expect(todo!.bracketOffset).toBe(4);
		expect(todo!.indentEm).toBe(1.4);

		const done = parseListLine("- [x] Shipped");
		expect(done!.checked).toBe(true);
		expect(done!.bracketOffset).toBe(2);
	});

	test("handles blockquoted list items and skips horizontal rules and prose", () => {
		const quoted = parseListLine("> - Quoted bullet");
		expect(quoted).not.toBeNull();
		expect(quoted!.kind).toBe("bullet");
		expect(quoted!.quoteLen).toBe(2);
		expect(quoted!.markerFrom).toBe(2);
		expect(quoted!.markerTo).toBe(4);

		expect(parseListLine("---")).toBeNull();
		expect(parseListLine("* * *")).toBeNull();
		expect(parseListLine("Plain paragraph text.")).toBeNull();
	});
});

describe("Docs panel multi-select and unified Issues filter", () => {
	const order = ["/ws/a.md", "/ws/b.md", "/ws/c.md", "/ws/d.md"];

	test("Ctrl+Click toggles individual rows and updates anchor", () => {
		const s1 = applyMultiSelectClick(new Set(), order, null, "/ws/a.md", { ctrl: true, shift: false });
		expect([...s1.selected]).toEqual(["/ws/a.md"]);
		expect(s1.anchor).toBe("/ws/a.md");

		const s2 = applyMultiSelectClick(s1.selected, order, s1.anchor, "/ws/c.md", { ctrl: true, shift: false });
		expect([...s2.selected]).toEqual(["/ws/a.md", "/ws/c.md"]);
		expect(s2.anchor).toBe("/ws/c.md");

		const s3 = applyMultiSelectClick(s2.selected, order, s2.anchor, "/ws/a.md", { ctrl: true, shift: false });
		expect([...s3.selected]).toEqual(["/ws/c.md"]);
	});

	test("Shift+Click selects contiguous range from anchor without losing anchor", () => {
		const s1 = applyMultiSelectClick(new Set(), order, "/ws/b.md", "/ws/d.md", { ctrl: false, shift: true });
		expect([...s1.selected]).toEqual(["/ws/b.md", "/ws/c.md", "/ws/d.md"]);
		expect(s1.anchor).toBe("/ws/b.md");

		// Reverse Shift+Click upwards from same anchor
		const s2 = applyMultiSelectClick(s1.selected, order, s1.anchor, "/ws/a.md", { ctrl: false, shift: true });
		expect([...s2.selected]).toEqual(["/ws/a.md", "/ws/b.md"]);
		expect(s2.anchor).toBe("/ws/b.md");
	});

	test("Ctrl+Shift+Click unions range with existing selection", () => {
		const s1 = applyMultiSelectClick(new Set(["/ws/a.md"]), order, "/ws/c.md", "/ws/d.md", { ctrl: true, shift: true });
		expect([...s1.selected].sort()).toEqual(["/ws/a.md", "/ws/c.md", "/ws/d.md"]);
	});

	test("aggregates direct DocFile flags, docChecks, and docAudit issues without double-counting", () => {
		const files: DocFile[] = [
			{ path: "/ws/README.md", name: "README.md", group: "project", exists: true },
			{ path: "/ws/STATE.md", name: "STATE.md", group: "project", exists: false },
			{
				path: "/ws/docs/tickets/DEMO-101.md",
				name: "DEMO-101.md",
				group: "tickets",
				exists: true,
				broken: [{ href: "missing.md", line: 4, column: 1 }],
			},
			{ path: "/ws/schema/tables/HOLIDAYS.md", name: "HOLIDAYS.md", group: "schema", exists: true },
		];
		const checks = [
			{
				level: "warn" as const,
				text: "DEMO-101 links to a file that is not there: missing.md",
				path: "/ws/docs/tickets/DEMO-101.md",
				fix: { kind: "links" as const, mends: [] },
			},
			{
				level: "note" as const,
				text: "README.md is missing approval metadata",
				path: "/ws/README.md",
				fix: { kind: "record-approval" as const, path: "/ws/README.md" },
			},
		];
		const audit = {
			issues: [
				{ path: "/ws/README.md", line: 12, kind: "table" as const, level: "note" as const, message: "Table has 5 columns (max 4)." },
				{ path: "/ws/schema/tables/HOLIDAYS.md", line: 1, kind: "schema-drift" as const, level: "warn" as const, message: "Schema drift in HOLIDAYS vs holidays.sql (+1 added)." },
				{ path: "/ws/docs/knowledge/snippets/query.sql", line: 1, kind: "orphan" as const, level: "note" as const, message: "Unreferenced snippet: query has no incoming links." },
			],
			citationIssues: [],
			schemaDrift: [
				{ schemaPath: "/ws/schema/tables/HOLIDAYS.md", sqlPath: "/ws/sql/holidays.sql", table: "HOLIDAYS", added: ["SITE"], modified: [], dropped: [] },
			],
		};

		const map = aggregateDocIssues(files, checks, audit);
		expect(hasAnyDocIssue(files[0]!, map)).toBe(true);
		expect(hasAnyDocIssue(files[1]!, map)).toBe(true);
		expect(hasAnyDocIssue(files[2]!, map)).toBe(true);
		expect(hasAnyDocIssue(files[3]!, map)).toBe(true);
		// Orphan note on standalone SQL snippet is NOT surfaced as a noisy issue in Docs -> Issues
		expect(map.has("/ws/docs/knowledge/snippets/query.sql")).toBe(false);

		// README has 2 extra note-level issues (record-approval check + ADR 0008 table audit issue), 0 warnings
		expect(map.get("/ws/readme.md")!.extraCount).toBe(2);
		expect(map.get("/ws/readme.md")!.extraWarn).toBe(0);
		// DEMO-101's broken link check is already shown inline, so extraCount stays 0
		expect(map.get("/ws/docs/tickets/demo-101.md")!.extraCount).toBe(0);
		// HOLIDAYS schema drift is counted ONCE, not twice across audit.issues + audit.schemaDrift
		expect(map.get("/ws/schema/tables/holidays.md")!.extraCount).toBe(1);
		expect(map.get("/ws/schema/tables/holidays.md")!.extraWarn).toBe(1);
	});
});

describe("Markdown reading highlight cursor floor + hover ahead", () => {
	test("keeps everything lit up to the deeper of cursor or mouse pointer", () => {
		// Cursor at line 20, mouse at line 10 -> stays lit through line 20 (cursor floor)
		expect(resolveReadAssistActiveIndex({ enabled: true, unitCount: 40, cursorIndex: 19, pointerIndex: 9 })).toBe(19);
		// Cursor at line 20, mouse at line 30 -> lit through line 30 (hovering ahead below cursor)
		expect(resolveReadAssistActiveIndex({ enabled: true, unitCount: 40, cursorIndex: 19, pointerIndex: 29 })).toBe(29);
		// Cursor at line 20, mouse outside editor -> stays lit through line 20
		expect(resolveReadAssistActiveIndex({ enabled: true, unitCount: 40, cursorIndex: 19, pointerIndex: null })).toBe(19);
	});

	test("falls back to pointer when cursor is not active (Read mode or unfocused)", () => {
		expect(resolveReadAssistActiveIndex({ enabled: true, unitCount: 30, cursorIndex: null, pointerIndex: 9 })).toBe(9);
		expect(resolveReadAssistActiveIndex({ enabled: true, unitCount: 30, cursorIndex: null, pointerIndex: null })).toBeNull();
	});

	test("disables dimming cleanly when toggle is off or document has no visible units", () => {
		expect(resolveReadAssistActiveIndex({ enabled: false, unitCount: 30, cursorIndex: 19, pointerIndex: 9 })).toBeNull();
		expect(resolveReadAssistActiveIndex({ enabled: true, unitCount: 0, cursorIndex: 0, pointerIndex: 0 })).toBeNull();
	});
});
