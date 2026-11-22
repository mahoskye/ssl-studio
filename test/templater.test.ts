import { describe, expect, test } from "bun:test";
import { checkTables } from "../src/shared/docTables";
import {
	DEFAULT_TEMPLATES,
	formatDateToken,
	mergeTemplates,
	parseCallArgs,
	parseTemplateFile,
	renderTemplate,
	stripTemplateFrontmatter,
	type TemplaterContext,
} from "../src/shared/templater";

const FIXED_DATE = new Date(2026, 10, 22, 14, 5, 9); // 2026-11-22 14:05:09

const baseCtx = (overrides: Partial<TemplaterContext> = {}): TemplaterContext => ({
	title: "Due Date Update",
	fileName: "Due-Date-Update.md",
	relativePath: "docs/specs/Due-Date-Update.md",
	folder: "docs/specs",
	projectName: "Due Dates",
	ticket: "DEMO-101",
	now: FIXED_DATE,
	...overrides,
});

describe("Templater formatting & argument parsing", () => {
	test("formats date tokens accurately", () => {
		expect(formatDateToken(FIXED_DATE, "YYYY-MM-DD")).toBe("2026-11-22");
		expect(formatDateToken(FIXED_DATE, "MMM DD, YYYY HH:mm")).toBe("Nov 22, 2026 14:05");
		expect(formatDateToken(FIXED_DATE, "dddd")).toBe("Sunday");
	});

	test("parses literal strings, numbers, booleans, and arrays safely without eval", () => {
		expect(parseCallArgs('"YYYY-MM-DD", 7')).toEqual(["YYYY-MM-DD", 7]);
		expect(parseCallArgs('["A", "B"], ["a", "b"], true')).toEqual([["A", "B"], ["a", "b"], true]);
	});
});

describe("Templater rendering", () => {
	test("expands tp.date, tp.file, tp.project, {{aliases}}, and cursor position", async () => {
		const tpl = [
			"---",
			'title: <% tp.file.title %>',
			'date: <% tp.date.now("YYYY-MM-DD") %>',
			'next: <% tp.date.now("YYYY-MM-DD", 7) %>',
			'tomorrow: <% tp.date.tomorrow("YYYY-MM-DD") %>',
			'yesterday: <% tp.date.yesterday("YYYY-MM-DD") %>',
			"ticket: <% tp.project.ticket %>",
			"project: {{project}}",
			"---",
			"",
			"# {{title}} (<% tp.file.folder() %>)",
			"",
			"<% tp.file.cursor() %>Body",
		].join("\n");

		const res = await renderTemplate(tpl, baseCtx());
		expect(res.cancelled).toBe(false);
		expect(res.text).toContain("title: Due Date Update");
		expect(res.text).toContain("date: 2026-11-22");
		expect(res.text).toContain("next: 2026-11-29");
		expect(res.text).toContain("tomorrow: 2026-11-23");
		expect(res.text).toContain("yesterday: 2026-11-21");
		expect(res.text).toContain("ticket: DEMO-101");
		expect(res.text).toContain("project: Due Dates");
		expect(res.text).toContain("# Due Date Update (docs/specs)");
		expect(res.cursorOffset).not.toBeNull();
		expect(res.text.slice(res.cursorOffset!, res.cursorOffset! + 4)).toBe("Body");
	});

	test("runs interactive tp.system.prompt and tp.system.suggester sequentially and honors cancellation", async () => {
		const tpl = `Key: <% tp.system.prompt("Ticket key", "LIMS-1") %> / Type: <% tp.system.suggester(["Feature", "Bug"], ["feat", "bug"]) %>`;
		const ok = await renderTemplate(
			tpl,
			baseCtx({
				prompt: async () => "DEMO-205",
				suggest: async (_labels, values) => values[1]!,
			}),
		);
		expect(ok.cancelled).toBe(false);
		expect(ok.text).toBe("Key: DEMO-205 / Type: bug");

		const cancelled = await renderTemplate(
			tpl,
			baseCtx({
				prompt: async () => null,
			}),
		);
		expect(cancelled.cancelled).toBe(true);
	});

	test("supports whitespace trimming tags (<%- -%> and <%_ _%>)", async () => {
		const tpl = "Line 1\n<%_ tp.file.cursor() _%>\nLine 2";
		const res = await renderTemplate(tpl, baseCtx());
		expect(res.text).toBe("Line 1Line 2");
	});

	test("parses workspace template metadata comments and overrides matching built-in defaults", () => {
		const raw = `<!-- template: name="Custom Ticket" description="Team ticket layout" group="Work" folder="docs/tickets" -->\n# <% tp.file.title %>\n`;
		const parsed = parseTemplateFile(raw, "Ticket", "ticket", "/ws/docs/templates/ticket.md");
		expect(parsed.name).toBe("Custom Ticket");
		expect(parsed.description).toBe("Team ticket layout");
		expect(parsed.content).toBe("# <% tp.file.title %>\n");

		const merged = mergeTemplates([parsed], DEFAULT_TEMPLATES);
		expect(merged[0]!.source).toBe("workspace");
		expect(merged.filter((t) => t.id === "ticket").length).toBe(1);
		expect(merged.length).toBe(DEFAULT_TEMPLATES.length);
	});

	test("every built-in default template renders cleanly and keeps all ADR 0008 table rules", async () => {
		for (const tpl of DEFAULT_TEMPLATES) {
			const res = await renderTemplate(tpl.content, baseCtx());
			expect(res.cancelled).toBe(false);
			expect(res.text).not.toContain("<%");
			expect(checkTables(res.text)).toEqual([]);
		}
	});

	test("strips duplicate YAML frontmatter when inserting into an existing document while keeping cursor offset accurate", async () => {
		const release = DEFAULT_TEMPLATES.find((t) => t.id === "release-checklist")!;
		const rendered = await renderTemplate(release.content, baseCtx());
		const stripped = stripTemplateFrontmatter(rendered);
		expect(stripped.text.startsWith("# Due Date Update")).toBe(true);
		expect(stripped.text).not.toContain("status: draft");
		expect(stripped.cursorOffset).not.toBeNull();
		const aroundCursor = stripped.text.slice(stripped.cursorOffset! - 15, stripped.cursorOffset! + 5);
		expect(aroundCursor).toContain("Database |");
	});
});
