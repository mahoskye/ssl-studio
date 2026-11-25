import { describe, expect, mock, test } from "bun:test";
import { resolve } from "node:path";
import { parseMarkdownTable, splitTableRow } from "../src/shared/markdownTables";
import type { DocFile } from "../src/shared/protocol";

// Minimal headless browser & Monaco shims so editor modules load cleanly under Bun tests.
if (typeof (globalThis as any).window === "undefined") {
	(globalThis as any).window = {
		Error,
		Map,
		Set,
		addEventListener() {},
		removeEventListener() {},
		location: { href: "http://localhost/" },
		matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
	};
} else {
	if (!(globalThis as any).window.Error) (globalThis as any).window.Error = Error;
	if (!(globalThis as any).window.Map) (globalThis as any).window.Map = Map;
	if (!(globalThis as any).window.Set) (globalThis as any).window.Set = Set;
}
if (typeof (globalThis as any).document === "undefined") {
	(globalThis as any).document = {
		documentElement: { dataset: {}, style: {} },
		createElement: () => ({ style: {} }),
	};
}
if (typeof (globalThis as any).self === "undefined") {
	(globalThis as any).self = globalThis;
}

const noopProxy = (extra: Record<string, any> = {}) =>
	new Proxy(extra, { get: (target, prop) => (prop in target ? target[prop as any] : () => ({ dispose() {} })) });

mock.module("monaco-editor/editor/editor.api", () => ({
	Range: class {
		constructor(
			public startLineNumber: number,
			public startColumn: number,
			public endLineNumber: number,
			public endColumn: number,
		) {}
	},
	Emitter: class {
		event = () => ({ dispose() {} });
		fire() {}
		dispose() {}
	},
	Uri: { from: () => ({}), file: (p: string) => ({ fsPath: p }) },
	MarkerSeverity: { Hint: 1, Info: 2, Warning: 4, Error: 8 },
	KeyMod: { CtrlCmd: 2048, Shift: 1024, Alt: 512 },
	KeyCode: {},
	languages: noopProxy({
		CompletionItemKind: { File: 1, Keyword: 2, Text: 3, Snippet: 4, Field: 5, Struct: 6 },
	}),
	editor: noopProxy({ getEditors: () => [], ScrollType: { Immediate: 1 } }),
}));
mock.module("monaco-editor/features/register.all", () => ({}));
mock.module("monaco-editor/editor/contrib/semanticTokens/browser/documentSemanticTokens", () => ({}));
mock.module("monaco-editor/editor/editor.worker?worker", () => ({ default: class {} }));
mock.module(`${resolve(import.meta.dir, "../src/view/editor/markdownLive.worker.ts")}?worker`, () => ({
	default: class {},
}));
mock.module(resolve(import.meta.dir, "../src/view/editor/markdownLive.ts"), () => ({
	marksFor: async () => [],
}));

const { SLASH_COMMANDS, buildSlashCommandSnippet, computeTextareaCompletions } = await import(
	"../src/view/editor/cmCompletion"
);
const { resolveSmartPasteText } = await import("../src/view/editor/cmKeymap");
const { mergeTsvIntoTable, parseTsvGrid } = await import("../src/view/editor/cmLiveTable");
const { extractMermaidErrorLine } = await import("../src/view/editor/cmMermaid");
const {
	classifySourceCompletion,
	extractLineContextSnippet,
	extractOutgoingLinks,
	findUnlinkedMentions,
	hasUnclosedPriorFence,
	linkifyMentionInText,
	mentionTermsForDoc,
	SOURCE_FENCE_LANGS,
} = await import("../src/view/editor/markdownLinks");

const ROOT = "/ws/project";

const SAMPLE_DOCS: DocFile[] = [
	{
		path: `${ROOT}/docs/tickets/DEMO-101.md`,
		name: "DEMO-101.md",
		group: "tickets",
		exists: true,
		ticket: "DEMO-101",
		title: "Late sample routing",
		status: "in progress",
		tags: ["routing", "lab"],
	},
	{
		path: `${ROOT}/docs/tickets/DEMO-202.md`,
		name: "DEMO-202.md",
		group: "tickets",
		exists: true,
		ticket: "DEMO-202",
		title: "Audit log retention",
		status: "open",
		tags: ["audit"],
	},
	{
		path: `${ROOT}/docs/specs/Due-dates.md`,
		name: "Due-dates.md",
		group: "specs",
		exists: true,
		title: "Due date calculation",
		status: "accepted",
		tags: ["routing", "dates"],
	},
	{
		path: `${ROOT}/docs/knowledge/decisions/0004-cache-policy.md`,
		name: "decisions/0004-cache-policy.md",
		group: "knowledge",
		kind: "decisions",
		exists: true,
		title: "Cache invalidation policy",
		status: "accepted",
	},
	{
		path: `${ROOT}/schema/database/DEMO_HOLIDAYS.md`,
		name: "database/DEMO_HOLIDAYS.md",
		group: "schema",
		kind: "database",
		exists: true,
		title: "DEMO_HOLIDAYS",
		schemaObjects: ["DEMO_HOLIDAYS"],
	},
];

describe("Markdown `/` slash commands", () => {
	test("registers all core slash commands", () => {
		const names = SLASH_COMMANDS.map((c) => c.name);
		for (const expected of ["table", "callout", "mermaid", "ssl", "sql", "details", "toc", "footnote", "template", "date", "hr"]) {
			expect(names).toContain(expected);
		}
	});

	test("builds clean snippets with sensible cursor placement", () => {
		const tbl = buildSlashCommandSnippet("table")!;
		expect(tbl.insert).toContain("| Column 1 | Column 2 | Column 3 |");
		expect(tbl.insert.slice(tbl.selFrom, tbl.selTo)).toBe("Column 1");
		expect(tbl.focusWidget).toBe(true);

		const callout = buildSlashCommandSnippet("callout")!;
		expect(callout.insert).toBe("> [!important]\n> ");
		expect(callout.selFrom).toBe(callout.insert.length);
		expect(callout.focusWidget).toBe(true);

		const mermaid = buildSlashCommandSnippet("mermaid")!;
		expect(mermaid.insert).toContain("```mermaid\nflowchart LR");
		expect(mermaid.insert.slice(mermaid.selFrom, mermaid.selTo)).toBe("A[Start] --> B[End]");

		const ssl = buildSlashCommandSnippet("ssl")!;
		expect(ssl.insert).toBe("```ssl\n\n```");
		expect(ssl.selFrom).toBe(7);

		const sql = buildSlashCommandSnippet("sql")!;
		expect(sql.insert).toBe("```sql\n\n```");
		expect(sql.selFrom).toBe(7);

		const details = buildSlashCommandSnippet("details")!;
		expect(details.insert.slice(details.selFrom, details.selTo)).toBe("Details");

		const toc = buildSlashCommandSnippet("toc", { docText: "# Top\n\n## Alpha\n\n### Beta\n" })!;
		expect(toc.insert).toContain("<!-- toc -->");
		expect(toc.insert).toContain("- [Alpha](#alpha)");
		expect(toc.insert).toContain("  - [Beta](#beta)");

		const fn = buildSlashCommandSnippet("footnote", { docText: "Text[^1]\n\n[^1]: First\n" })!;
		expect(fn.insert).toBe("[^2]");
		expect(fn.appendEnd).toBe("\n[^2]: ");
		expect(fn.action).toBe("footnote");

		const tpl = buildSlashCommandSnippet("template")!;
		expect(tpl.action).toBe("template");

		const date = buildSlashCommandSnippet("date", { today: "2026-11-23" })!;
		expect(date.insert).toBe("2026-11-23");

		const hr = buildSlashCommandSnippet("hr")!;
		expect(hr.insert).toBe("---\n\n");
		expect(buildSlashCommandSnippet("unknown-cmd")).toBeNull();
	});
});

describe("Smart clipboard paste & TSV multi-cell table merge", () => {
	test("smart paste converts URL-over-selection, TSV, and rich HTML while respecting fences and plain-paste", () => {
		expect(
			resolveSmartPasteText({
				plain: "https://example.com/docs",
				selected: "Reference",
				insideFence: false,
			}),
		).toBe("[Reference](https://example.com/docs)");

		expect(
			resolveSmartPasteText({
				plain: "Col A\tCol B\n1\t2",
				selected: "",
				insideFence: false,
			}),
		).toBe("| Col A | Col B |\n| --- | --- |\n| 1 | 2 |");

		expect(
			resolveSmartPasteText({
				plain: "hello world",
				html: "<p><strong>hello</strong> <em>world</em></p>",
				selected: "",
				insideFence: false,
			}),
		).toBe("**hello** *world*");

		// Inside fenced code block: never convert TSV or HTML.
		expect(
			resolveSmartPasteText({
				plain: "Col A\tCol B\n1\t2",
				html: "<table><tr><td>A</td><td>B</td></tr></table>",
				selected: "",
				insideFence: true,
			}),
		).toBeNull();

		// Ctrl+Shift+V plain paste bypasses all conversions.
		expect(
			resolveSmartPasteText({
				plain: "https://example.com",
				html: "<b>link</b>",
				selected: "Click",
				insideFence: false,
				plainOnly: true,
			}),
		).toBeNull();
	});

	test("parseTsvGrid distinguishes multi-cell TSV from single-cell or plain multiline prose", () => {
		expect(parseTsvGrid("A\tB\n1\t2\r\n")).toEqual([
			["A", "B"],
			["1", "2"],
		]);
		expect(parseTsvGrid("Only\tOne\tRow")).toEqual([["Only", "One", "Row"]]);
		expect(parseTsvGrid("Just a paragraph\nwith two lines")).toBeNull();
		expect(parseTsvGrid("single cell")).toBeNull();
	});

	test("mergeTsvIntoTable expands across cells and auto-adds rows & columns while keeping alignments", () => {
		const raw = ["| Name | Count |", "| :--- | ----: |", "| Alpha | 1 |"];
		const table = parseMarkdownTable(raw, 2)!;
		const merged = mergeTsvIntoTable(table, 1, 1, "10\tNotes | extra\n20\tSecond row\r\n")!;
		expect(merged).not.toBeNull();
		expect(merged.lines.length).toBe(4);
		expect(splitTableRow(merged.lines[0]!)).toEqual(["Name", "Count", "Column"]);
		expect(merged.lines[1]).toContain(":---");
		expect(merged.lines[1]).toContain("---:");
		expect(splitTableRow(merged.lines[2]!)).toEqual(["Alpha", "10", "Notes \\| extra"]);
		expect(splitTableRow(merged.lines[3]!)).toEqual(["", "20", "Second row"]);
		expect(merged.focusRow).toBe(2);
		expect(merged.focusCol).toBe(2);
	});
});

describe("Widget & inline YAML textarea completions", () => {
	test("completes wikilinks, tags, and tickets inside widget textareas", () => {
		const wiki = computeTextareaCompletions({
			mode: "markdown",
			value: "See [[DEMO",
			caret: 10,
			filePath: `${ROOT}/docs/specs/Due-dates.md`,
			docs: SAMPLE_DOCS,
			root: ROOT,
		});
		expect(wiki?.items.some((i) => i.insert === "DEMO-101]]")).toBe(true);

		const tag = computeTextareaCompletions({
			mode: "markdown",
			value: "Tagged #rou",
			caret: 11,
			filePath: `${ROOT}/docs/specs/Due-dates.md`,
			docs: SAMPLE_DOCS,
			root: ROOT,
		});
		expect(tag?.items.some((i) => i.label === "#routing" && i.insert === "routing")).toBe(true);

		const ticket = computeTextareaCompletions({
			mode: "markdown",
			value: "Blocks DEMO-",
			caret: 12,
			filePath: `${ROOT}/docs/specs/Due-dates.md`,
			docs: SAMPLE_DOCS,
			root: ROOT,
		});
		expect(ticket?.items.map((i) => i.label)).toEqual(["DEMO-101", "DEMO-202"]);
	});

	test("completes YAML keys, statuses, tickets, and tags in inline YAML editor", () => {
		const key = computeTextareaCompletions({
			mode: "yaml",
			value: "sta",
			caret: 3,
			filePath: `${ROOT}/docs/tickets/DEMO-101.md`,
			docs: SAMPLE_DOCS,
			root: ROOT,
			listedDoc: SAMPLE_DOCS[0],
		});
		expect(key?.items[0]?.insert).toBe("status: ");

		const status = computeTextareaCompletions({
			mode: "yaml",
			value: "status: op",
			caret: 10,
			filePath: `${ROOT}/docs/tickets/DEMO-101.md`,
			docs: SAMPLE_DOCS,
			root: ROOT,
			listedDoc: SAMPLE_DOCS[0],
		});
		expect(status?.items.some((i) => i.insert.toLowerCase() === "open")).toBe(true);

		const listTicket = computeTextareaCompletions({
			mode: "yaml",
			value: "related:\n  - DEMO",
			caret: 17,
			filePath: `${ROOT}/docs/tickets/DEMO-101.md`,
			docs: SAMPLE_DOCS,
			root: ROOT,
			listedDoc: SAMPLE_DOCS[0],
		});
		expect(listTicket?.items.some((i) => i.insert === "DEMO-202")).toBe(true);

		const flowTag = computeTextareaCompletions({
			mode: "yaml",
			value: "tags: [lab, au",
			caret: 14,
			filePath: `${ROOT}/docs/tickets/DEMO-101.md`,
			docs: SAMPLE_DOCS,
			root: ROOT,
			listedDoc: SAMPLE_DOCS[0],
		});
		expect(flowTag?.items.some((i) => i.insert === "audit")).toBe(true);
	});
});

describe("Monaco Source completion parity helpers", () => {
	test("classifies fence langs, callouts, embeds, wikilink headings, links, and tags accurately", () => {
		expect(SOURCE_FENCE_LANGS.some(([lang]) => lang === "ssl")).toBe(true);
		expect(classifySourceCompletion("```ss", "", false)).toEqual({ kind: "fence", typed: "ss" });
		expect(classifySourceCompletion("```ss", "", true)).toBeNull();
		expect(hasUnclosedPriorFence("```ssl\n:DECLARE x;\n")).toBe(true);
		expect(hasUnclosedPriorFence("```ssl\n:DECLARE x;\n```\n")).toBe(false);

		expect(classifySourceCompletion("> [!war", "", false)).toEqual({
			kind: "callout",
			typed: "war",
			restLen: 0,
			hasClose: false,
		});
		expect(classifySourceCompletion("> [!tip", "] Title", false)).toEqual({
			kind: "callout",
			typed: "tip",
			restLen: 0,
			hasClose: true,
		});

		expect(classifySourceCompletion("Look ![[shot", "", false)).toEqual({
			kind: "embed",
			typed: "shot",
			restLen: 0,
			closed: false,
		});

		expect(classifySourceCompletion("See [[Due-dates#Cal", "]]", false)).toEqual({
			kind: "wiki-heading",
			docName: "Due-dates",
			typed: "Cal",
			restLen: 0,
			closed: true,
		});
		expect(classifySourceCompletion("Jump [[#Over", "", false)).toEqual({
			kind: "wiki-heading",
			docName: "",
			typed: "Over",
			restLen: 0,
			closed: false,
		});

		expect(classifySourceCompletion("See [[DEMO", "", false)).toEqual({
			kind: "wiki",
			typed: "DEMO",
			restLen: 0,
			closed: false,
		});
		expect(classifySourceCompletion("See [spec](../specs/Due", ")", false)).toEqual({
			kind: "link",
			typed: "../specs/Due",
			restLen: 0,
		});
		expect(classifySourceCompletion("Category #rou", "", false)).toEqual({ kind: "tag", typed: "rou" });
		// Never suggest tags on ATX headings or CSS hex colors.
		expect(classifySourceCompletion("## Heading", "", false)).toBeNull();
		expect(classifySourceCompletion("Color #ffaa00", "", false)).toBeNull();
		expect(classifySourceCompletion("Inline `[[code", "", false)).toBeNull();
	});
});

describe("Mermaid syntax error line extraction", () => {
	test("extracts line numbers and cleans parser diagnostics", () => {
		expect(extractMermaidErrorLine("Parse error on line 4:\nA -->\nExpecting 'NODE'\nmermaid version 12.3.0")).toEqual({
			line: 4,
			message: "Parse error on line 4: — A -->",
		});
		expect(extractMermaidErrorLine("Lexical error on line 2. Unrecognized text.")).toEqual({
			line: 2,
			message: "Lexical error on line 2. Unrecognized text.",
		});
		expect(extractMermaidErrorLine("Unknown diagram type")).toEqual({
			line: null,
			message: "Unknown diagram type",
		});
	});
});

describe("Links Inspector: outgoing links, snippets, and unlinked mentions", () => {
	test("extracts resolved links, broken links with fix hints, embeds, ticket refs, and web links", () => {
		const here = `${ROOT}/docs/tickets/DEMO-101.md`;
		const md = [
			"---",
			"title: Late sample routing",
			"---",
			"",
			"Follow [Due dates](../specs/Due-dates.md#rules) and [Missing](../specs/Old.md).",
			"See [[0004-cache-policy]] and [[GhostNote]] plus ![[Due-dates#Overview]].",
			"Depends on DEMO-202 and [STARLIMS Docs](https://example.com/starlims).",
			"```ssl",
			"// DEMO-202 inside fence must be ignored",
			"```",
		].join("\n");

		const out = extractOutgoingLinks(md, here, SAMPLE_DOCS, {
			root: ROOT,
			broken: [{ href: "../specs/Old.md", line: 5, instead: "../specs/Due-dates.md" }],
		});

		const byTarget = new Map(out.map((item) => [`${item.kind}:${item.target}`, item]));
		expect(byTarget.get("link:../specs/Due-dates.md#rules")).toMatchObject({
			broken: false,
			heading: "rules",
			resolvedPath: `${ROOT}/docs/specs/Due-dates.md`,
		});
		expect(byTarget.get("link:../specs/Old.md")).toMatchObject({
			broken: true,
			instead: "../specs/Due-dates.md",
		});
		expect(byTarget.get("wiki:0004-cache-policy")).toMatchObject({
			broken: false,
			resolvedPath: `${ROOT}/docs/knowledge/decisions/0004-cache-policy.md`,
		});
		expect(byTarget.get("wiki:GhostNote")).toMatchObject({ broken: true });
		expect(byTarget.get("embed:Due-dates#Overview")).toMatchObject({
			broken: false,
			heading: "Overview",
			resolvedPath: `${ROOT}/docs/specs/Due-dates.md`,
		});
		expect(byTarget.get("ticket:DEMO-202")).toMatchObject({
			broken: false,
			resolvedPath: `${ROOT}/docs/tickets/DEMO-202.md`,
			line: 7,
		});
		expect(byTarget.get("web:https://example.com/starlims")).toMatchObject({
			broken: false,
			label: "STARLIMS Docs",
		});
		// Fenced DEMO-202 on line 9 should NOT be extracted.
		expect(out.filter((o) => o.kind === "ticket" && o.line === 9)).toEqual([]);
	});

	test("extracts concise context snippets and detects unlinked mentions while skipping linked docs & code", () => {
		const sampleText = [
			"---",
			"title: Notes",
			"---",
			"Wait for DEMO-101 before release.",
			"Already linked [[DEMO-101]] and `DEMO-101` in code.",
			"```",
			"DEMO-101 inside fence",
			"```",
		].join("\n");

		expect(extractLineContextSnippet(sampleText, 4)).toBe("Wait for DEMO-101 before release.");
		expect(mentionTermsForDoc({ ticket: "DEMO-101", title: "DEMO-101: Late sample routing", stem: "DEMO-101" })).toEqual([
			"Late sample routing",
			"DEMO-101",
		]);
		// Generic filenames like README/INDEX do not produce noisy mention terms.
		expect(mentionTermsForDoc({ title: "README", stem: "README" })).toEqual([]);

		const mentions = findUnlinkedMentions(
			{ path: `${ROOT}/docs/tickets/DEMO-101.md`, ticket: "DEMO-101", title: "Late sample routing", stem: "DEMO-101" },
			[
				{ path: `${ROOT}/docs/tickets/DEMO-202.md`, name: "DEMO-202.md", title: "Audit log retention", text: sampleText },
				{ path: `${ROOT}/docs/specs/Due-dates.md`, name: "Due-dates.md", title: "Due dates", text: "Mentions DEMO-101 here." },
			],
			new Set([`${ROOT}/docs/specs/Due-dates.md`]),
		);

		expect(mentions).toHaveLength(1);
		expect(mentions[0]).toMatchObject({
			path: `${ROOT}/docs/tickets/DEMO-202.md`,
			line: 4,
			column: 9,
			matchedText: "DEMO-101",
		});

		const linkedExact = linkifyMentionInText(sampleText, 4, 9, "DEMO-101", "DEMO-101");
		expect(linkedExact).toContain("Wait for [[DEMO-101]] before release.");

		const linkedAlias = linkifyMentionInText("See late sample routing today.", 1, 4, "late sample routing", "DEMO-101");
		expect(linkedAlias).toBe("See [[DEMO-101|late sample routing]] today.");
	});
});
