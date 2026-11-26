import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
	detectBranchTicketMismatch,
	extractPlanTestCasesFromMarkdown,
	formatAgentThreadMarkdown,
	initialReviewLayout,
	MENU_BAR,
	planLineBreadcrumb,
	planMarkdownReviewExtraction,
	protectedMarkdownSpans,
	replaceErDiagramBlock,
	replaceSafeInText,
	reviewLayoutKey,
	shouldLetEditorHandleKey,
} from "../src/shared/menuBar";
import { searchPattern } from "../src/shared/searchPattern";
import { generateMermaidErDiagram, parseCreateTables } from "../src/shared/sqlSchema";

describe("Wave 1.1 & 1.4 — Non-destructive multi-file ER diagram", () => {
	test("concatenates numerically ordered SQL migrations before parsing so ALTER TABLE & FK constraints survive", () => {
		const files = [
			{
				name: "schema/database/10_fks.sql",
				sql: "ALTER TABLE SAMPLES ADD CONSTRAINT FK_SAMPLES_FOLDERS FOREIGN KEY (FOLDER_ID) REFERENCES FOLDERS (FOLDER_ID);",
			},
			{
				name: "schema/database/01_tables.sql",
				sql: "CREATE TABLE FOLDERS (FOLDER_ID VARCHAR(20) PRIMARY KEY);\nCREATE TABLE SAMPLES (SAMPLE_ID VARCHAR(20) PRIMARY KEY, FOLDER_ID VARCHAR(20));",
			},
			{
				name: "schema/database/02_alters.sql",
				sql: "ALTER TABLE SAMPLES ADD PRIORITY VARCHAR(10) NOT NULL;",
			},
		];
		const ordered = [...files].sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: "base" }));
		expect(ordered.map((f) => f.name)).toEqual([
			"schema/database/01_tables.sql",
			"schema/database/02_alters.sql",
			"schema/database/10_fks.sql",
		]);

		const combined = ordered.map((f) => f.sql).join("\n;\n");
		const tables = parseCreateTables(combined, { includeStandaloneAlter: true });
		const samples = tables.find((t) => t.tableName === "SAMPLES")!;
		expect(samples.columns.map((c) => c.name)).toEqual(["SAMPLE_ID", "FOLDER_ID", "PRIORITY"]);
		expect(samples.foreignKeys).toEqual([{ column: "FOLDER_ID", refTable: "FOLDERS", refColumn: "FOLDER_ID" }]);

		const diagram = generateMermaidErDiagram(tables);
		expect(diagram).toContain("erDiagram");
		expect(diagram).toContain("FOLDERS ||--o{ SAMPLES");
		expect(diagram).toContain("PRIORITY");
	});

	test("replaceErDiagramBlock replaces only the erDiagram fence while preserving frontmatter, prose, and flowchart fences", () => {
		const existing = [
			"---",
			"title: Core Schema ER",
			"owner: Lab Ops",
			"---",
			"",
			"# Core Schema",
			"",
			"Overview note kept verbatim.",
			"",
			"```mermaid",
			"flowchart TD",
			"  A[Intake] --> B[Storage]",
			"```",
			"",
			"```mermaid",
			"%% Auto-generated ER",
			"erDiagram",
			"  OLD_TABLE {",
			"    INT ID PK",
			"  }",
			"```",
			"",
			"## Hand-Written Annotations",
			"Do not overwrite this section.",
			"",
		].join("\n");

		const fresh = "```mermaid\nerDiagram\n  FOLDERS {\n    VARCHAR FOLDER_ID PK\n  }\n```";
		const res = replaceErDiagramBlock(existing, fresh);
		expect(res.replaced).toBe(true);
		expect(res.text).toContain("owner: Lab Ops");
		expect(res.text).toContain("Overview note kept verbatim.");
		expect(res.text).toContain("flowchart TD\n  A[Intake] --> B[Storage]");
		expect(res.text).toContain("FOLDERS {\n    VARCHAR FOLDER_ID PK\n  }");
		expect(res.text).not.toContain("OLD_TABLE");
		expect(res.text).toContain("## Hand-Written Annotations\nDo not overwrite this section.");
	});

	test("replaceErDiagramBlock preserves CRLF and returns replaced: false when no erDiagram fence exists", () => {
		const crlfDoc = "# Notes\r\n\r\n```mermaid\r\nerDiagram\r\n  A { INT X }\r\n```\r\n\r\nTail\r\n";
		const updated = replaceErDiagramBlock(crlfDoc, "```mermaid\nerDiagram\n  B { INT Y }\n```");
		expect(updated.replaced).toBe(true);
		expect(updated.text).toBe("# Notes\r\n\r\n```mermaid\r\nerDiagram\r\n  B { INT Y }\r\n```\r\n\r\nTail\r\n");

		const noEr = "# Notes\n\nJust prose and a SQL snippet:\n\n```sql\nSELECT 1;\n```\n";
		const untouched = replaceErDiagramBlock(noEr, "```mermaid\nerDiagram\n  B { INT Y }\n```");
		expect(untouched.replaced).toBe(false);
		expect(untouched.text).toBe(noEr);
	});
});

describe("Wave 1.8 — Safe Markdown Review extraction & per-format Review layout persistence", () => {
	test("never auto-extracts an inner ssl/sql/mermaid fence when diffing against a Markdown file", () => {
		expect(planMarkdownReviewExtraction("markdown", [{ lang: "ssl", code: ":RETURN 1;" }])).toEqual({ mode: "use-full" });
		expect(planMarkdownReviewExtraction("markdown", [{ lang: "sql", code: "SELECT 1;" }])).toEqual({ mode: "use-full" });
		expect(planMarkdownReviewExtraction("markdown", [{ lang: "mermaid", code: "flowchart TD\nA-->B" }])).toEqual({ mode: "use-full" });

		// Single markdown/md/diff/patch fence IS extracted.
		expect(planMarkdownReviewExtraction("markdown", [{ lang: "markdown", code: "# Spec" }]).mode).toBe("use-block");
		expect(planMarkdownReviewExtraction("markdown", [{ lang: "md", code: "# Spec" }]).mode).toBe("use-block");
		expect(planMarkdownReviewExtraction("markdown", [{ lang: "diff", code: "@@ -1 +1 @@\n-a\n+b" }]).mode).toBe("use-block");
		expect(planMarkdownReviewExtraction("markdown", [{ lang: "patch", code: "@@ -1 +1 @@\n-a\n+b" }]).mode).toBe("use-block");
	});

	test("offers 'Use full Markdown reply' as top default choice when multiple blocks exist on a Markdown target", () => {
		const res = planMarkdownReviewExtraction("markdown", [
			{ lang: "ssl", code: ":LOCAL nX := 1;" },
			{ lang: "sql", code: "SELECT * FROM FOLDERS;" },
		]);
		expect(res.mode).toBe("pick");
		if (res.mode === "pick") {
			expect(res.choices[0]!.label).toBe("Use full Markdown reply");
			expect(res.choices[0]!.block).toBeNull();
			expect(res.choices).toHaveLength(3);
		}

		// Non-markdown single block still extracts directly.
		expect(planMarkdownReviewExtraction("ssl", [{ lang: "ssl", code: ":RETURN 1;" }]).mode).toBe("use-block");
	});

	test("persists independent ReviewView layouts for Markdown, CSV, and code", () => {
		expect(reviewLayoutKey("markdown")).toBe("review.layout.markdown");
		expect(reviewLayoutKey("csv")).toBe("review.layout.csv");
		expect(reviewLayoutKey("code")).toBe("review.layout");

		expect(initialReviewLayout("markdown", null)).toBe("rendered");
		expect(initialReviewLayout("markdown", "split")).toBe("split");
		expect(initialReviewLayout("markdown", "inline")).toBe("inline");
		expect(initialReviewLayout("markdown", "table")).toBe("rendered");

		expect(initialReviewLayout("csv", null)).toBe("table");
		expect(initialReviewLayout("csv", "split")).toBe("split");
		expect(initialReviewLayout("csv", "rendered")).toBe("table");

		expect(initialReviewLayout("code", null)).toBe("split");
		expect(initialReviewLayout("code", "inline")).toBe("inline");
		expect(initialReviewLayout("code", "rendered")).toBe("split");
	});
});

describe("Wave 2 — Capture-phase keybinding guards & Round 6 MenuBar / Command integrity", () => {
	test("lets Markdown/CSV table widgets handle Alt+Arrow and CM6 handle Ctrl+Shift+D / Ctrl+J", () => {
		expect(
			shouldLetEditorHandleKey({ id: "go-back", pressed: ["alt+arrowleft"], inTable: true, inLiveMarkdown: false }),
		).toBe(true);
		expect(
			shouldLetEditorHandleKey({ id: "go-forward", pressed: ["alt+arrowright"], inTable: true, inLiveMarkdown: false }),
		).toBe(true);
		expect(
			shouldLetEditorHandleKey({ id: "go-back", pressed: ["alt+arrowleft"], inTable: false, inLiveMarkdown: false }),
		).toBe(false);
		expect(
			shouldLetEditorHandleKey({ id: "go-back", pressed: ["ctrl+-"], inTable: true, inLiveMarkdown: false }),
		).toBe(false);

		expect(
			shouldLetEditorHandleKey({ id: "docs", pressed: ["ctrl+shift+d"], inTable: false, inLiveMarkdown: true }),
		).toBe(true);
		expect(
			shouldLetEditorHandleKey({ id: "toggle-panel", pressed: ["ctrl+j"], inTable: false, inLiveMarkdown: true }),
		).toBe(true);
		expect(
			shouldLetEditorHandleKey({ id: "docs", pressed: ["ctrl+shift+d"], inTable: false, inLiveMarkdown: false }),
		).toBe(false);
		expect(
			shouldLetEditorHandleKey({ id: "toggle-panel", pressed: ["ctrl+j"], inTable: false, inLiveMarkdown: false }),
		).toBe(false);
	});

	test("registers all Round 6 commands in commands.ts and exposes required doc/git/plan entries in MENU_BAR", () => {
		const cmdSource = readFileSync(join(import.meta.dir, "../src/view/commands.ts"), "utf8");
		const registeredIds = new Set([...cmdSource.matchAll(/\{ id: "([a-z0-9-]+)"/g)].map((m) => m[1]!));

		const requiredCommands = [
			"record-doc-approval",
			"generate-test-protocol",
			"release-readiness",
			"clone-ticket",
			"split-ticket",
			"import-mermaid-plan",
			"git-blame-line",
			"git-switch-branch",
			"git-stash",
		];
		for (const id of requiredCommands) {
			expect(registeredIds.has(id)).toBe(true);
		}

		const menuCmdIds = MENU_BAR.flatMap((menu) => menu.entries).flatMap((entry) =>
			entry !== "separator" && "command" in entry ? [entry.command] : [],
		);
		expect(menuCmdIds.filter((id) => !registeredIds.has(id))).toEqual([]);

		for (const expectedInMenu of [
			"open-governing-doc",
			"link-doc-to-ticket",
			"set-doc-status",
			"record-doc-approval",
			"generate-test-protocol",
			"release-readiness",
			"generate-er-diagram",
			"import-mermaid-plan",
			"git-blame-line",
		]) {
			expect(menuCmdIds).toContain(expectedInMenu);
		}
	});

	test("agent/, editor/, and panels/ owned files never statically import ../commands", () => {
		for (const rel of [
			"../src/view/agent/Agent.tsx",
			"../src/view/agent/store.ts",
			"../src/view/editor/Review.tsx",
			"../src/view/panels/Git.tsx",
			"../src/view/panels/Search.tsx",
		]) {
			const src = readFileSync(join(import.meta.dir, rel), "utf8");
			expect(/^\s*import\s+[^;]*from\s+["']\.\.\/commands["']/m.test(src)).toBe(false);
		}
	});
});

describe("Wave 4.4 — Agent test-case extraction & thread export formatting", () => {
	test("extracts test cases from Markdown pipe tables while ignoring ordinary schema tables", () => {
		const md = [
			"Here are the proposed test cases:",
			"",
			"| Test Case | Node | Given | Expect |",
			"| --- | --- | --- | --- |",
			"| **Rush 24h turnaround** | n2 | Sample marked RUSH on Friday | Due date set to Saturday +24h |",
			"| Empty folder guard | n3 | `sFolderNo` is empty | Returns error without DB write |",
		].join("\n");
		const parsed = extractPlanTestCasesFromMarkdown(md);
		expect(parsed).toEqual([
			{
				title: "Rush 24h turnaround",
				node: "n2",
				given: "Sample marked RUSH on Friday",
				expect: "Due date set to Saturday +24h",
			},
			{
				title: "Empty folder guard",
				node: "n3",
				given: "sFolderNo is empty",
				expect: "Returns error without DB write",
			},
		]);

		// Ordinary column table has no Given/Expect column and must not extract bogus tests.
		const schemaTable = "| Column | Type | Constraints |\n| --- | --- | --- |\n| ID | INT | PK |\n";
		expect(extractPlanTestCasesFromMarkdown(schemaTable)).toEqual([]);
	});

	test("extracts test cases from inline checklists and heading/sub-bullet Given/When/Expect replies", () => {
		const md = [
			"### 1. Skip lab holiday",
			"- **Given:** Receipt on Thursday before Friday holiday",
			"- **When:** SetDueDates runs",
			"- **Expect:** Due date lands on Monday",
			"",
			"- [ ] **Null input safety** — Given: blank sample id; When: validating; Expect: returns false",
			"",
			"```ssl",
			"/* Given: code comment inside fence must be ignored;",
			"```",
		].join("\n");
		const parsed = extractPlanTestCasesFromMarkdown(md);
		expect(parsed).toHaveLength(2);
		expect(parsed[0]).toEqual({
			title: "Skip lab holiday",
			given: "Receipt on Thursday before Friday holiday; When: SetDueDates runs",
			expect: "Due date lands on Monday",
		});
		expect(parsed[1]).toEqual({
			title: "Null input safety",
			given: "blank sample id; When: validating",
			expect: "returns false",
		});
	});

	test("formats Q&A thread cleanly for export while stripping context suffixes and internal notes", () => {
		const md = formatAgentThreadMarkdown(
			[
				{ role: "note", text: "New conversation" },
				{ role: "user", text: "How should rush holidays work?  (with DEMO-101; git diff)" },
				{ role: "agent", text: "Skip lab holidays unless marked STAT." },
				{ role: "note", text: "succeeded · 120 in / 40 out tokens" },
			],
			{ title: "Holiday rules discussion", ticket: "DEMO-101" },
		);
		expect(md).toContain("## Holiday rules discussion (DEMO-101)");
		expect(md).toContain("### Question 1\n\nHow should rush holidays work?");
		expect(md).not.toContain("(with DEMO-101");
		expect(md).toContain("#### Answer\n\nSkip lab holidays unless marked STAT.");
		expect(md).not.toContain("120 in / 40 out tokens");
	});
});

describe("Wave 4.4 — Search Plan breadcrumbs & Safe Docs Replace", () => {
	test("maps .plan.json line numbers to Stage › Step and Test › Case breadcrumbs", () => {
		const planText = [
			"{",
			'  "version": 1,',
			'  "title": "Set due dates",',
			'  "groups": [',
			'    { "id": "g1", "name": "Validation" }',
			"  ],",
			'  "nodes": [',
			'    { "id": "n1", "kind": "start", "text": "Start" },',
			'    { "id": "n2", "kind": "step", "text": "Check holiday calendar", "group": "g1" },',
			'    { "id": "n3", "kind": "decision", "text": "Is rush sample?" }',
			"  ],",
			'  "edges": [',
			'    { "from": "n1", "to": "n2" }',
			"  ],",
			'  "tests": [',
			'    { "id": "t1", "title": "Skips Sunday holiday", "node": "n2", "given": "Friday", "expect": "Monday" }',
			"  ]",
			"}",
		].join("\n");

		expect(planLineBreadcrumb(planText, 3)).toBe("Plan › title");
		expect(planLineBreadcrumb(planText, 5)).toBe("Stage › Validation");
		expect(planLineBreadcrumb(planText, 9)).toBe("Validation › Check holiday calendar");
		expect(planLineBreadcrumb(planText, 10)).toBe("Decision › Is rush sample?");
		expect(planLineBreadcrumb(planText, 13)).toBe("Edge › Start -> Check holiday calendar");
		expect(planLineBreadcrumb(planText, 16)).toBe("Test › Skips Sunday holiday");
	});

	test("Safe Replace skips YAML frontmatter keys, Markdown link targets ](...), and [[wikilink]] targets", () => {
		const md = [
			"---",
			"status: draft",
			"title: Old status guide",
			"---",
			"",
			"Check the [status overview](docs/status/guide.md) and [[status-doc]] or [[status-doc|status label]].",
			"Body status text updates normally.",
			"",
		].join("\n");

		const spans = protectedMarkdownSpans(md);
		// Frontmatter key `status:` on line 2 is protected.
		expect(spans.get(2)).toEqual([{ start: 0, end: 7 }]);

		const pat = searchPattern("status", { wholeWord: true });
		const res = replaceSafeInText(md, pat, "state", false, { isMarkdown: true, safeDocs: true });
		expect(res.invalidJson).toBe(false);
		expect(res.skippedProtected).toBe(4); // frontmatter key, ](docs/status/guide.md), [[status-doc]], [[status-doc|
		expect(res.count).toBe(4); // title value, [status overview], |status label]], Body status
		expect(res.text).toContain("status: draft");
		expect(res.text).toContain("title: Old state guide");
		expect(res.text).toContain("[state overview](docs/status/guide.md)");
		expect(res.text).toContain("[[status-doc]]");
		expect(res.text).toContain("[[status-doc|state label]]");
		expect(res.text).toContain("Body state text updates normally.");
	});

	test("Safe Replace blocks .plan.json replacement when the resulting text breaks JSON syntax", () => {
		const planJson = '{\n  "version": 1,\n  "title": "Due Dates",\n  "groups": [],\n  "nodes": [],\n  "edges": []\n}\n';
		const badPat = searchPattern("Due Dates");
		const broken = replaceSafeInText(planJson, badPat, 'Broken "Unescaped', false, { isPlanJson: true, safeDocs: true });
		expect(broken.invalidJson).toBe(true);
		expect(broken.count).toBe(0);
		expect(broken.text).toBe(planJson);

		const valid = replaceSafeInText(planJson, badPat, "Turnaround Dates", false, { isPlanJson: true, safeDocs: true });
		expect(valid.invalidJson).toBe(false);
		expect(valid.count).toBe(1);
		expect(JSON.parse(valid.text).title).toBe("Turnaround Dates");
	});
});

describe("Wave 4.4 — Git branch vs active ticket mismatch detector", () => {
	test("flags branch ticket key that differs from active ticket", () => {
		expect(detectBranchTicketMismatch("feature/DEMO-101-due-dates", "DEMO-102")).toEqual({
			branchTicket: "DEMO-101",
			activeTicket: "DEMO-102",
		});
		expect(detectBranchTicketMismatch("bugfix/lims-42_guard", "LIMS-99")).toEqual({
			branchTicket: "LIMS-42",
			activeTicket: "LIMS-99",
		});
	});

	test("returns null when branch matches active ticket (case-insensitive), contains no ticket, or active ticket is unset", () => {
		expect(detectBranchTicketMismatch("feature/demo-101-due-dates", "DEMO-101")).toBeNull();
		expect(detectBranchTicketMismatch("merge/DEMO-101-and-DEMO-102", "DEMO-102")).toBeNull();
		expect(detectBranchTicketMismatch("main", "DEMO-101")).toBeNull();
		expect(detectBranchTicketMismatch("release/2026-11", "DEMO-101")).toBeNull();
		expect(detectBranchTicketMismatch("feature/DEMO-101", "")).toBeNull();
		expect(detectBranchTicketMismatch(null, "DEMO-101")).toBeNull();
	});
});

describe("ADR 0034 — in a text editor, Sublime Text's editing keys come before the shell's", () => {
	const { EDITING_KEYS_OVER_SHELL } = require("../src/shared/menuBar") as typeof import("../src/shared/menuBar");
	const ask = (id: string | undefined, pressed: string[], where: { code?: boolean; live?: boolean; mac?: boolean } = { code: true }) =>
		shouldLetEditorHandleKey({ id, pressed, inTable: false, inLiveMarkdown: Boolean(where.live), inCodeEditor: Boolean(where.code), mac: where.mac });

	test("Ctrl+Shift+D, Ctrl+J and Ctrl+Shift+M are the editor's in the code editor and in a document, and the shell's elsewhere", () => {
		for (const { key, command } of EDITING_KEYS_OVER_SHELL) {
			expect(ask(command, [key], { code: true })).toBe(true);
			expect(ask(command, [key], { live: true })).toBe(true);
			expect(ask(command, [key], {})).toBe(false);
		}
		expect(EDITING_KEYS_OVER_SHELL.map((k) => k.key)).toEqual(["ctrl+shift+d", "ctrl+j", "ctrl+shift+m"]);
	});

	test("a key the user gave to another command is theirs in an editor too, and no other shell key gives way", () => {
		// Ctrl+J given to "save all": the key runs it everywhere.
		expect(ask("save-all", ["ctrl+j"])).toBe(false);
		// The command moved to another key: that key is not an editing key, and runs the command in an editor.
		expect(ask("toggle-panel", ["ctrl+alt+j"])).toBe(false);
		expect(ask("symbols", ["ctrl+t"])).toBe(false);
		expect(ask("save", ["ctrl+s"])).toBe(false);
		expect(ask(undefined, ["ctrl+j"])).toBe(false);
	});

	test("on a Mac the key is Sublime Text's for a Mac: Cmd for the first two, Ctrl itself for the bracket", () => {
		// Cmd+Shift+D is named "cmd+shift+d" first, then by its name on other systems.
		expect(ask("docs", ["cmd+shift+d", "ctrl+shift+d"], { code: true, mac: true })).toBe(true);
		expect(ask("toggle-panel", ["cmd+j", "ctrl+j"], { code: true, mac: true })).toBe(true);
		expect(ask("problems", ["ctrl+shift+m"], { code: true, mac: true })).toBe(true);
		// Cmd+Shift+M stays the shell's "Problems": Sublime Text's key there is on Ctrl.
		expect(ask("problems", ["cmd+shift+m", "ctrl+shift+m"], { code: true, mac: true })).toBe(false);
		// And the Ctrl key itself with D is not Sublime Text's key for duplicating on a Mac.
		expect(ask("docs", ["ctrl+shift+d"], { code: true, mac: true })).toBe(false);
	});
});

describe("ADR 0034 — the code editor's two-key shortcuts", () => {
	const { EDITOR_CHORD_WAIT, startsEditorChord } = require("../src/shared/menuBar") as typeof import("../src/shared/menuBar");

	test("Ctrl+K is the first key of one, and Cmd+K on a Mac; nothing else is", () => {
		expect(startsEditorChord(["ctrl+k"])).toBe(true);
		expect(startsEditorChord(["ctrl+shift+k"])).toBe(false);
		expect(startsEditorChord(["ctrl+0"])).toBe(false);
		expect(startsEditorChord([])).toBe(false);
		// Cmd+K is named "cmd+k" first on a Mac; the Ctrl key itself with K is the text's there (delete to line end).
		expect(startsEditorChord(["cmd+k", "ctrl+k"], true)).toBe(true);
		expect(startsEditorChord(["ctrl+k"], true)).toBe(false);
	});

	test("the wait for the second key is the editor's own: five seconds", () => {
		expect(EDITOR_CHORD_WAIT).toBe(5000);
	});
});
