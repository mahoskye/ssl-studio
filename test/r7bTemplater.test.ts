import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { frontMatter } from "../src/shared/frontMatter";
import {
	DEFAULT_TEMPLATES,
	formatTemplateHeaderAttr,
	parseCallArgs,
	parseTemplateFile,
	renderTemplate,
	stripRawTemplateFrontmatter,
	stripTemplateFrontmatter,
	type TemplaterContext,
} from "../src/shared/templater";

const FIXED_DATE = new Date(2026, 10, 24, 9, 30, 0);

const makeCtx = (overrides: Partial<TemplaterContext> = {}): TemplaterContext => ({
	title: "Sample Note",
	fileName: "Sample-Note.md",
	relativePath: "docs/Sample-Note.md",
	fullPath: "/ws/docs/Sample-Note.md",
	folder: "docs",
	projectName: "LIMS Core",
	ticket: "LIMS-101",
	now: FIXED_DATE,
	...overrides,
});

describe("Round 7B P0-1: parseCallArgs stray bracket termination & indexing", () => {
	test("terminates quickly (<20ms) on stray closing brackets without infinite loops", () => {
		const inputs = ["]", "]]]", '"a", ]', '["a"]]', "a]b", "[a, b], ]", '["a", "b"]]] , "c"', "foo(1, 2)]"];
		const t0 = performance.now();
		for (const input of inputs) {
			const res = parseCallArgs(input);
			expect(Array.isArray(res)).toBe(true);
		}
		const elapsed = performance.now() - t0;
		expect(elapsed).toBeLessThan(20);

		expect(parseCallArgs("]")).toEqual([]);
		expect(parseCallArgs('"x", ]')).toEqual(["x"]);
		expect(parseCallArgs('["a"]]')).toEqual([["a"]]);
	});

	test("tracks bracketDepth so indexed expressions like arr[0] parse and resolve cleanly", () => {
		expect(parseCallArgs("arr[0], 42")).toEqual(["arr[0]", 42]);
		expect(parseCallArgs("[arr[0], arr[1]], true")).toEqual([["arr[0]", "arr[1]"], true]);
		expect(parseCallArgs("foo(a, b[0]), bar")).toEqual(["foo(a, b[0])", "bar"]);
		expect(parseCallArgs("arr[0], arr[1]", (id) => (id === "arr[0]" ? "first" : undefined))).toEqual(["first", "arr[1]"]);
	});

	test("malformed template tags with stray brackets render safely in <20ms", async () => {
		const t0 = performance.now();
		const res = await renderTemplate('Date: <% tp.date.now(]) %> / Pick: <% tp.system.suggester(["A"]], ["a"]) %>', makeCtx());
		expect(performance.now() - t0).toBeLessThan(20);
		expect(res.cancelled).toBe(false);
		expect(res.text).toContain("Date: 2026-11-24");
		expect(res.text).toContain("Pick: a");
	});
});

describe("Round 7B P0-3: empty/trimmed frontmatter & stripRawTemplateFrontmatter hoisting", () => {
	test("stripTemplateFrontmatter handles empty frontmatter without scanning to a body horizontal rule", () => {
		const text = "---\n---\n\n# Heading\n\n---\n\nFooter\n";
		const res = stripTemplateFrontmatter({ text, cursorOffset: 11, cancelled: false });
		expect(res.text).toBe("# Heading\n\n---\n\nFooter\n");
		expect(res.cursorOffset).toBe(2);

		const crlf = "---\r\n---\r\n\r\n# Heading\r\n\r\n---\r\nFooter\r\n";
		const resCrlf = stripTemplateFrontmatter({ text: crlf, cursorOffset: null, cancelled: false });
		expect(resCrlf.text).toBe("# Heading\r\n\r\n---\r\nFooter\r\n");
	});

	test("stripTemplateFrontmatter strips frontmatter-only templates without trailing newline", () => {
		expect(stripTemplateFrontmatter({ text: "---\ntitle: Only FM\n---", cursorOffset: null, cancelled: false }).text).toBe("");
		expect(stripTemplateFrontmatter({ text: "---\n---", cursorOffset: 4, cancelled: false })).toEqual({
			text: "",
			cursorOffset: 0,
			cancelled: false,
		});
	});

	test("Ticket template with all keys already existing hoists let-tag cleanly without empty --- shell or eating body ---", async () => {
		const ticketTpl = DEFAULT_TEMPLATES.find((t) => t.id === "ticket")!;
		const withRule = `${ticketTpl.content}\n---\n\nTrailing footer\n`;
		const allKeys = new Set(["ticket", "title", "type", "status", "created", "related"]);

		const rawStripped = stripRawTemplateFrontmatter(withRule, allKeys);
		expect(rawStripped.startsWith("---")).toBe(false);
		expect(rawStripped).toContain("let key ??=");

		let promptCalls = 0;
		let suggestCalls = 0;
		const renderedRaw = await renderTemplate(
			rawStripped,
			makeCtx({
				prompt: async () => {
					promptCalls++;
					return "LIMS-999";
				},
				suggest: async (_l, vals) => {
					suggestCalls++;
					return vals[0]!;
				},
			}),
		);
		expect(promptCalls).toBe(1);
		expect(suggestCalls).toBe(0);
		expect(renderedRaw.text.startsWith("---")).toBe(false);

		const stripped = stripTemplateFrontmatter(renderedRaw);
		expect(stripped.text).toContain("# LIMS-999: Sample Note");
		expect(stripped.text).toContain("\n---\n\nTrailing footer\n");
	});

	test("Ticket template with partial existingKeys keeps let-tag before kept ticket property", async () => {
		const ticketTpl = DEFAULT_TEMPLATES.find((t) => t.id === "ticket")!;
		const partialKeys = new Set(["title", "status"]);
		const rawStripped = stripRawTemplateFrontmatter(ticketTpl.content, partialKeys);

		const renderedRaw = await renderTemplate(
			rawStripped,
			makeCtx({
				prompt: async () => "LIMS-777",
				suggest: async (_l, vals) => vals[1]!,
			}),
		);
		const fm = frontMatter(renderedRaw.text);
		expect(fm.values.ticket).toBe("LIMS-777");
		expect(fm.values.type).toBe("change");
		expect(fm.values.title).toBeUndefined();
		expect(fm.values.status).toBeUndefined();

		const stripped = stripTemplateFrontmatter(renderedRaw);
		expect(stripped.text).toContain("# LIMS-777: Sample Note");
		expect(stripped.text).not.toContain("ticket: LIMS-777");
	});

	test("hoisted tags strip leading trimLeft markers (- and _) so they never eat the newline after closing ---", async () => {
		const tplDash = [
			"---",
			"<%-* let key = tp.system.prompt('Key', 'K-1') -%>",
			"ticket: <% key %>",
			"status: open",
			"---",
			"",
			"# <% key %>",
			"",
			"---",
			"Body after rule",
		].join("\n");

		const rawDash = stripRawTemplateFrontmatter(tplDash, new Set(["ticket"]));
		expect(rawDash).not.toMatch(/---\r?\n<%[-_]/);
		const renderedDash = await renderTemplate(rawDash, makeCtx({ prompt: async () => "K-42" }));
		expect(frontMatter(renderedDash.text).values.status).toBe("open");
		const strippedDash = stripTemplateFrontmatter(renderedDash);
		expect(strippedDash.text).toBe("# K-42\n\n---\nBody after rule");

		const tplUnder = [
			"---",
			"ticket: <%_* let code = tp.system.prompt('Code', 'C-1') _%><% code %>",
			"status: draft",
			"---",
			"",
			"Code: <% code %>",
		].join("\n");

		const rawUnder = stripRawTemplateFrontmatter(tplUnder, new Set(["ticket"]));
		expect(rawUnder).not.toMatch(/---\r?\n<%[-_]/);
		const renderedUnder = await renderTemplate(rawUnder, makeCtx({ prompt: async () => "C-9" }));
		expect(frontMatter(renderedUnder.text).values.status).toBe("draft");
		const strippedUnder = stripTemplateFrontmatter(renderedUnder);
		expect(strippedUnder.text).toBe("Code: C-9");
	});
});

describe("Round 7B P1-7: formatTemplateHeaderAttr & parseTemplateFile quoted attribute round-trip", () => {
	test("round-trips built-in Ticket template fileName containing double quotes verbatim", async () => {
		const ticket = DEFAULT_TEMPLATES.find((t) => t.id === "ticket")!;
		const header = `<!-- template: ${[
			formatTemplateHeaderAttr("name", ticket.name),
			formatTemplateHeaderAttr("description", ticket.description),
			formatTemplateHeaderAttr("group", ticket.group),
			formatTemplateHeaderAttr("folder", ticket.folder!),
			formatTemplateHeaderAttr("fileName", ticket.fileName!),
		].join(" ")} -->\n`;

		const parsed = parseTemplateFile(header + ticket.content, "Fallback", ticket.id, "/ws/docs/templates/ticket.md");
		expect(parsed.name).toBe(ticket.name);
		expect(parsed.description).toBe(ticket.description);
		expect(parsed.group).toBe(ticket.group);
		expect(parsed.folder).toBe(ticket.folder);
		expect(parsed.fileName).toBe(ticket.fileName);
		expect(parsed.content).toBe(ticket.content);

		const nameRes = await renderTemplate(parsed.fileName!, makeCtx({ prompt: async () => "LIMS-555" }));
		expect(nameRes.text).toBe("LIMS-555.md");
	});

	test("round-trips every built-in default template cleanly", () => {
		for (const tpl of DEFAULT_TEMPLATES) {
			const attrs = [
				formatTemplateHeaderAttr("name", tpl.name),
				formatTemplateHeaderAttr("description", tpl.description),
				formatTemplateHeaderAttr("group", tpl.group),
				...(tpl.folder ? [formatTemplateHeaderAttr("folder", tpl.folder)] : []),
				...(tpl.fileName ? [formatTemplateHeaderAttr("fileName", tpl.fileName)] : []),
			];
			const raw = `<!-- template: ${attrs.join(" ")} -->\n${tpl.content}`;
			const parsed = parseTemplateFile(raw, "Fallback", tpl.id, `/ws/docs/templates/${tpl.id}.md`);
			expect(parsed.name).toBe(tpl.name);
			expect(parsed.description).toBe(tpl.description);
			expect(parsed.group).toBe(tpl.group);
			expect(parsed.folder).toBe(tpl.folder);
			expect(parsed.fileName).toBe(tpl.fileName);
			expect(parsed.content).toBe(tpl.content);
		}
	});

	test("escapes quotes, backslashes, and --> comment closers and parses &quot; and single-quoted attributes", () => {
		const trickyName = 'Review "Phase 1" --> Sign-off \\ QA';
		const formatted = formatTemplateHeaderAttr("name", trickyName);
		expect(formatted).not.toContain("-->");
		const parsedTricky = parseTemplateFile(
			`<!-- template: ${formatted} ${formatTemplateHeaderAttr("description", "Behavior & Design")} -->\n# Body\n`,
			"Fallback",
			"tricky",
			"/ws/docs/templates/tricky.md",
		);
		expect(parsedTricky.name).toBe(trickyName);
		expect(parsedTricky.description).toBe("Behavior & Design");
		expect(parsedTricky.content).toBe("# Body\n");

		const htmlEntityRaw =
			'<!-- template: name="Ticket &quot;v2&quot;" fileName="<%* let key = tp.system.prompt(&quot;Key&quot;, &quot;LIMS-1&quot;) %><% key %>.md" -->\nBody';
		const parsedEntity = parseTemplateFile(htmlEntityRaw, "Fallback", "ent", "/ws/docs/templates/ent.md");
		expect(parsedEntity.name).toBe('Ticket "v2"');
		expect(parsedEntity.fileName).toBe('<%* let key = tp.system.prompt("Key", "LIMS-1") %><% key %>.md');

		const singleQuotedRaw =
			"<!-- template: name='Single \"Quoted\"' fileName='<%* let key = tp.system.prompt(\"Key\", \"LIMS-1\") %><% key %>.md' -->\nBody";
		const parsedSingle = parseTemplateFile(singleQuotedRaw, "Fallback", "sq", "/ws/docs/templates/sq.md");
		expect(parsedSingle.name).toBe('Single "Quoted"');
		expect(parsedSingle.fileName).toBe('<%* let key = tp.system.prompt("Key", "LIMS-1") %><% key %>.md');
	});
});

describe("Round 7B P2-21: {{alias}} template injection & $ replacement safety", () => {
	test("{{title}}, {{ticket}}, and {{project}} never execute embedded <% ... %> tags or expand $& patterns", async () => {
		const res = await renderTemplate(
			"# {{title}}\nTicket: {{ticket}}\nProject: {{project}}\nDate: {{date}} {{time}}\nTag: <% tp.file.title %>",
			makeCtx({
				title: "Test <% tp.file.path(true) %> Price $& $1 $$",
				ticket: "LIMS-$& <% tp.project.name %>",
				projectName: "Alpha {{title}} $` $'",
			}),
		);
		expect(res.cancelled).toBe(false);
		expect(res.text).toBe(
			[
				"# Test <% tp.file.path(true) %> Price $& $1 $$",
				"Ticket: LIMS-$& <% tp.project.name %>",
				"Project: Alpha {{title}} $` $'",
				"Date: 2026-11-24 09:30",
				"Tag: Test <% tp.file.path(true) %> Price $& $1 $$",
			].join("\n"),
		);
	});

	test("{{title}} containing {{project}} is not double-expanded, and <% tp.file.title %> is not alias-expanded", async () => {
		const res = await renderTemplate(
			"Alias: {{title}} | Expr: <% tp.file.title %> | Real: {{project}}",
			makeCtx({ title: "Uses {{project}} and {{date}}" }),
		);
		expect(res.text).toBe("Alias: Uses {{project}} and {{date}} | Expr: Uses {{project}} and {{date}} | Real: LIMS Core");
	});
});

describe("Round 7B src/view/templater.ts invariants (P0-2, P1-6, P1-7, P1-8, P2-26)", () => {
	const src = readFileSync(resolve(import.meta.dir, "../src/view/templater.ts"), "utf8");

	test("P0-2: never replaces full model range on YAML merge and inserts body before merging frontmatter via applyText", () => {
		expect(src).not.toContain("getFullModelRange()");
		const fnStart = src.indexOf("export async function insertMarkdownTemplate");
		const fnEnd = src.indexOf("export async function newNoteFromTemplate");
		const fnBody = src.slice(fnStart, fnEnd);
		const insertIdx = fnBody.indexOf("insertIntoActiveEditor(");
		const applyIdx = fnBody.indexOf("applyText(canonPath, updated)");
		expect(insertIdx).toBeGreaterThan(-1);
		expect(applyIdx).toBeGreaterThan(insertIdx);
		expect(fnBody).toContain("liveAfterInsert.reveal(");
	});

	test("P1-6: guards workspace root, activePath, documents lookup, and model disposal across async boundaries", () => {
		expect(src).toContain("state.workspace?.root !== startRoot || activePath() !== canonPath");
		expect(src).toContain("documents.get(canonPath)");
		expect(src).toContain("!docObj.model.isDisposed()");

		for (const fnName of ["insertMarkdownTemplate", "insertCalloutInteractive", "insertImageInteractive"]) {
			const start = src.indexOf(`export async function ${fnName}`);
			expect(start).toBeGreaterThan(-1);
			const nextExport = src.indexOf("export async function ", start + 1);
			const body = nextExport > -1 ? src.slice(start, nextExport) : src.slice(start);
			expect(body).toContain("const startRoot = state.workspace?.root");
			expect(body).toContain("const canonPath = canonical(path)");
			expect(body).toContain("activeDocIfCurrent(startRoot, canonPath)");
		}
	});

	test("P1-7 & P2-26: manageTemplates escapes headers with formatTemplateHeaderAttr and wraps writes in try/catch with startRoot checks", () => {
		const start = src.indexOf("export async function manageTemplates");
		const end = src.indexOf("export async function insertCalloutInteractive");
		const body = src.slice(start, end);
		expect(body).toContain("formatTemplateHeaderAttr(");
		expect(body).not.toContain('fileName="${copyBuiltin.fileName}"');
		expect(body).not.toContain('name="${name}"');
		expect((body.match(/await backend\.create\(/g) ?? []).length).toBe(2);
		expect((body.match(/catch \(e: any\) \{\s*\n\s*notify\([^)]+"error"\)/g) ?? []).length).toBeGreaterThanOrEqual(3);
		expect(body).toContain("const startRoot = root");
		expect(body).toContain("state.workspace?.root !== startRoot");
	});

	test("P1-8: insertCalloutInteractive uses activeSelectionText() and insertImageInteractive cancels cleanly on alt === null", () => {
		const calloutStart = src.indexOf("export async function insertCalloutInteractive");
		const imageStart = src.indexOf("export async function insertImageInteractive");
		const calloutBody = src.slice(calloutStart, imageStart);
		const imageBody = src.slice(imageStart);

		expect(calloutBody).toContain("const selected = activeSelectionText()");
		expect(calloutBody).not.toContain("activeLiveEditor()?.getSelectedText()");

		expect(imageBody).toContain("const alt = await ask(");
		expect(imageBody).toContain("if (alt === null");
		expect(imageBody).not.toContain(') ?? ""');
	});
});
