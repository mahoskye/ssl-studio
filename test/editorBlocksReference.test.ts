import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { extractCommentSpans, findCommentDocRefsInLines, matchingProjectDocsForReference, ticketRefsIn } from "../src/shared/editorDocHelpers";
import { MENU_BAR } from "../src/shared/menuBar";
import type { DocFile } from "../src/shared/protocol";

const ROOT = "/ws";
const SAMPLE_DOCS: DocFile[] = [
	{
		path: "/ws/docs/tickets/DEMO-101.md",
		name: "DEMO-101.md",
		group: "tickets",
		exists: true,
		ticket: "DEMO-101",
		title: "Due date calculation",
		status: "in progress",
	},
	{
		path: "/ws/docs/specs/due-dates.md",
		name: "due-dates.md",
		group: "specs",
		exists: true,
		title: "Due Dates Specification",
		status: "draft",
	},
	{
		path: "/ws/design/due-dates.plan.json",
		name: "due-dates.plan.json",
		group: "plans",
		exists: true,
		title: "Due Dates Plan",
	},
	{
		path: "/ws/schema/database/DEMO_HOLIDAYS.md",
		name: "DEMO_HOLIDAYS.md",
		group: "schema",
		exists: true,
		title: "DEMO_HOLIDAYS",
	},
	{
		path: "/ws/docs/knowledge/decisions/0001-utc-dates.md",
		name: "decisions/0001-utc-dates.md",
		group: "knowledge",
		kind: "decisions",
		exists: true,
		title: "Store holiday dates in UTC",
		summary: "Use SQLExecute with ISO date literals for holiday lookups.",
		status: "accepted",
	},
	{
		path: "/ws/docs/knowledge/snippets/holiday-query.sql",
		name: "snippets/holiday-query.sql",
		group: "knowledge",
		kind: "snippets",
		exists: true,
		title: "SQLExecute holiday lookup snippet",
		summary: "Parameterized query against DEMO_HOLIDAYS",
	},
	{
		path: "/ws/docs/knowledge/reference/sql-safety.md",
		name: "reference/sql-safety.md",
		group: "knowledge",
		kind: "reference",
		exists: true,
		title: "Parameterized queries with SQLExecute",
		summary: "Guidelines for safe database access",
	},
];

describe("schemaHover comment doc-path & wikilink detection", () => {
	test("extracts SSL and SQL comment spans while ignoring strings", () => {
		const sslLines = [
			'sText := "/* docs/specs/due-dates.md not a comment";',
			"/* See docs/specs/due-dates.md and [[DEMO-101]];",
			"/*",
			" * Multi-line banner referencing design/due-dates.plan.json",
			";",
			":RETURN sText;",
		];
		const sslSpans = extractCommentSpans(sslLines, "ssl");
		expect(sslSpans[0]).toEqual([]);
		expect(sslSpans[1]!.length).toBe(1);
		expect(sslSpans[3]!.length).toBe(1);
		expect(sslSpans[5]).toEqual([]);

		const sqlLines = [
			"SELECT '-- not a comment' FROM DEMO_HOLIDAYS;",
			"-- See schema/database/DEMO_HOLIDAYS.md and [[0001-utc-dates]]",
			"/* block comment docs/specs/due-dates.md#L12-L20 */ SELECT 1;",
		];
		const sqlSpans = extractCommentSpans(sqlLines, "sql");
		expect(sqlSpans[0]).toEqual([]);
		expect(sqlSpans[1]!.length).toBe(1);
		expect(sqlSpans[2]!.length).toBe(1);
	});

	test("detects workspace doc paths (with #L / #heading) and [[wikilinks]] in SSL comments, skipping code/strings", () => {
		const sslLines = [
			'sIgnored := "docs/specs/due-dates.md [[DEMO-101]]";',
			"/* Implements docs/specs/due-dates.md#holidays and [[DEMO-101]];",
			"/*",
			" * Plan: design/due-dates.plan.json",
			" * Schema: schema/database/DEMO_HOLIDAYS.md#L5-L18",
			" * ADR: [[0001-utc-dates|UTC rule]]",
			" * Missing: docs/specs/does-not-exist.md",
			";",
			"// Inline check: [[DEMO_HOLIDAYS#Columns]]",
		];

		const refs = findCommentDocRefsInLines(sslLines, "ssl", SAMPLE_DOCS, ROOT);
		expect(refs.map((r) => [r.line, r.kind, r.doc.name, r.heading ?? null, r.targetLine ?? null, r.targetEndLine ?? null])).toEqual([
			[2, "wikilink", "DEMO-101.md", null, null, null],
			[2, "path", "due-dates.md", "holidays", null, null],
			[4, "path", "due-dates.plan.json", null, null, null],
			[5, "path", "DEMO_HOLIDAYS.md", null, 5, 18],
			[6, "wikilink", "decisions/0001-utc-dates.md", null, null, null],
			[9, "wikilink", "DEMO_HOLIDAYS.md", "Columns", null, null],
		]);

		// Verify column offsets slice back to exact tokens (excluding trailing SSL `;`).
		for (const r of refs) {
			expect(sslLines[r.line - 1]!.slice(r.from, r.to)).toBe(r.raw);
			expect(r.raw.endsWith(";")).toBe(false);
		}
	});

	test("detects workspace doc paths and [[wikilinks]] in SQL line and block comments", () => {
		const sqlLines = [
			"-- Source spec: docs/specs/due-dates.md#L10",
			"/* Decision [[0001-utc-dates]] and table schema/database/DEMO_HOLIDAYS.md */",
			"SELECT * FROM DEMO_HOLIDAYS; -- [[DEMO-101]]",
		];
		const refs = findCommentDocRefsInLines(sqlLines, "sql", SAMPLE_DOCS, ROOT);
		expect(refs.map((r) => [r.line, r.kind, r.doc.name, r.targetLine ?? null])).toEqual([
			[1, "path", "due-dates.md", 10],
			[2, "wikilink", "decisions/0001-utc-dates.md", null],
			[2, "path", "DEMO_HOLIDAYS.md", null],
			[3, "wikilink", "DEMO-101.md", null],
		]);
	});
});

describe("BlocksView ticket-key link extraction", () => {
	test("splits banner and comment text into plain segments and clickable ticket tokens", () => {
		const banner = " * Ticket: DEMO-101 (supersedes LIMS-9; see demo-101 for details)\n * Unrelated FAKE-999 stays plain.";
		const segments = ticketRefsIn(banner, ["DEMO-101", "LIMS-9"]);
		const tickets = segments.filter((s) => s.ticket);
		expect(tickets).toEqual([
			{ text: "DEMO-101", ticket: "DEMO-101" },
			{ text: "LIMS-9", ticket: "LIMS-9" },
			{ text: "demo-101", ticket: "DEMO-101" },
		]);
		expect(segments.map((s) => s.text).join("")).toBe(banner);
	});

	test("returns plain text when no known ticket keys match", () => {
		expect(ticketRefsIn("/* plain comment;", ["DEMO-101"])).toEqual([{ text: "/* plain comment;" }]);
		expect(ticketRefsIn("", ["DEMO-101"])).toEqual([]);
	});
});

describe("Reference panel workspace knowledge matching", () => {
	test("finds kept snippets, decisions, and reference notes mentioning a STARLIMS built-in", () => {
		const hit = matchingProjectDocsForReference("SQLExecute", SAMPLE_DOCS);
		expect(hit.snippets.map((d) => d.name)).toEqual(["snippets/holiday-query.sql"]);
		expect(hit.notes.map((d) => d.name)).toEqual(["decisions/0001-utc-dates.md", "reference/sql-safety.md"]);
		// Word-boundary check prevents substrings from matching inside longer words, and ignores file extensions (.sql).
		expect(matchingProjectDocsForReference("Exec", SAMPLE_DOCS)).toEqual({ snippets: [], notes: [] });
		expect(matchingProjectDocsForReference("SQL", SAMPLE_DOCS).snippets).toEqual([]);
	});
});

describe("MENU_BAR command coverage and view architecture guards", () => {
	test("every MENU_BAR command id exists in commands.ts and new Round 5 commands + Ctrl+Shift+O are registered", () => {
		const cmdSource = readFileSync(join(import.meta.dir, "../src/view/commands.ts"), "utf8");
		const registeredIds = new Set([...cmdSource.matchAll(/\{ id: "([a-z0-9-]+)"/g)].map((m) => m[1]!));

		const menuCmdIds = MENU_BAR.flatMap((m) => m.entries).flatMap((e) => (e !== "separator" && "command" in e ? [e.command] : []));
		expect(menuCmdIds.filter((id) => !registeredIds.has(id))).toEqual([]);

		// Verify all required Round 5 command ids exist in commands.ts.
		for (const required of [
			"quick-outline",
			"md-fold-all",
			"md-unfold-all",
			"export-release-bundle",
			"export-rtm",
			"import-legacy-doc",
			"onboard-workspace",
			"generate-er-diagram",
			"rename-tag",
			"promote-question",
			"link-doc-to-ticket",
			"archive-ticket",
			"unarchive-ticket",
			"set-doc-status",
			"create-ticket-folder",
			"open-governing-doc",
			"attach-file-to-agent",
			"show-in-explorer",
		]) {
			expect(registeredIds.has(required)).toBe(true);
		}
		expect(cmdSource).toContain('"ctrl+shift+o": "quick-outline"');
	});

	test("editor/, blocks/, and panels/ never statically import ../commands", () => {
		for (const rel of [
			"../src/view/editor/schemaHover.ts",
			"../src/view/editor/EditorGroup.tsx",
			"../src/view/blocks/BlocksView.tsx",
			"../src/view/panels/Reference.tsx",
		]) {
			const src = readFileSync(join(import.meta.dir, rel), "utf8");
			expect(/^\s*import\s+[^;]*from\s+["']\.\.\/commands["']/m.test(src)).toBe(false);
		}
	});
});
