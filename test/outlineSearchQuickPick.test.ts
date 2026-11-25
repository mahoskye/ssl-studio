import { describe, expect, test } from "bun:test";
import {
	csvColumnOutline,
	hasOutline,
	markdownSectionTree,
	moveMarkdownSection,
	outline,
	planStageOutline,
	reorderMarkdownSection,
} from "../src/shared/outline";
import { fileAndLine, fileTarget, parseQuickFacets } from "../src/shared/quickPrefix";

describe("markdownSectionTree", () => {
	test("builds nested headings with per-section task counts and ignores front matter & fenced code", () => {
		const md = [
			"---",
			"title: Spec",
			"# not a heading",
			"- [ ] not a task",
			"---",
			"",
			"# Overview",
			"- [x] Initial scope",
			"## Phase 1",
			"- [ ] Write migration",
			"- [X] Review schema",
			"```sh",
			"# comment inside backtick fence",
			"- [ ] not a task inside code",
			"```",
			"### Details",
			"Inline ```sql``` span stays prose.",
			"- [ ] Verify indexes",
			"~~~md",
			"## Not a heading in tilde fence",
			"- [x] Not a task in tilde fence",
			"~~~",
			"## Phase 2",
			"- [x] Smoke test",
			"## Phase 2",
			"Duplicate heading slug check",
		].join("\n");

		const tree = markdownSectionTree(md);
		expect(tree).toHaveLength(1);
		const root = tree[0]!;
		expect(root.level).toBe(1);
		expect(root.text).toBe("Overview");
		expect(root.slug).toBe("overview");
		expect(root.line).toBe(7);
		expect(root.endLine).toBe(26);
		// Total tasks rolled up across Overview (1/1) + Phase 1 (1/2) + Details (0/1) + Phase 2 (1/1) = 3/5
		expect(root.tasksDone).toBe(3);
		expect(root.tasksTotal).toBe(5);

		expect(root.children.map((c) => [c.text, c.slug, c.line, c.endLine, c.tasksDone, c.tasksTotal])).toEqual([
			["Phase 1", "phase-1", 9, 22, 1, 3],
			["Phase 2", "phase-2", 23, 24, 1, 1],
			["Phase 2", "phase-2-1", 25, 26, 0, 0],
		]);
		expect(root.children[0]!.children).toHaveLength(1);
		expect(root.children[0]!.children[0]).toMatchObject({
			level: 3,
			text: "Details",
			slug: "details",
			line: 16,
			endLine: 22,
			tasksDone: 0,
			tasksTotal: 1,
		});
	});
});

describe("moveMarkdownSection & reorderMarkdownSection", () => {
	test("moves a section and its nested children up and down, preserving blank lines and round-tripping cleanly", () => {
		const original = [
			"# Spec",
			"",
			"## First",
			"Body A",
			"### Nested A",
			"Sub body",
			"",
			"## Second",
			"Body B",
			"",
			"## Third",
			"Body C",
			"",
		].join("\n");

		const movedDown = moveMarkdownSection(original, 3, "down");
		expect(movedDown).not.toBeNull();
		expect(movedDown!.text).toBe(
			[
				"# Spec",
				"",
				"## Second",
				"Body B",
				"",
				"## First",
				"Body A",
				"### Nested A",
				"Sub body",
				"",
				"## Third",
				"Body C",
				"",
			].join("\n"),
		);
		expect(movedDown!.newLine).toBe(6);

		// Moving First back up from its new line restores the exact original text.
		const movedBack = moveMarkdownSection(movedDown!.text, movedDown!.newLine, "up");
		expect(movedBack).not.toBeNull();
		expect(movedBack!.newLine).toBe(3);
		expect(movedBack!.text).toBe(original);
	});

	test("preserves CRLF line endings and no-trailing-newline files", () => {
		const crlf = "# Alpha\r\nline 1\r\n\r\n# Beta\r\nline 2\r\n";
		const moved = moveMarkdownSection(crlf, 4, "up");
		expect(moved).not.toBeNull();
		expect(moved!.newLine).toBe(1);
		expect(moved!.text).toBe("# Beta\r\nline 2\r\n\r\n# Alpha\r\nline 1\r\n");

		const noFinalNl = "## One\na\n\n## Two\nb";
		const moved2 = moveMarkdownSection(noFinalNl, 1, "down");
		expect(moved2).not.toBeNull();
		expect(moved2!.text).toBe("## Two\nb\n\n## One\na");
		expect(moved2!.newLine).toBe(4);
	});

	test("returns null at sibling boundaries or non-heading lines", () => {
		const md = "# A\nbody\n# B\nbody\n";
		expect(moveMarkdownSection(md, 1, "up")).toBeNull();
		expect(moveMarkdownSection(md, 3, "down")).toBeNull();
		expect(moveMarkdownSection(md, 2, "down")).toBeNull();
		expect(moveMarkdownSection("", 1, "up")).toBeNull();
	});

	test("reorders a sibling past multiple siblings", () => {
		const md = "## A\na\n\n## B\nb\n\n## C\nc\n";
		const reordered = reorderMarkdownSection(md, 1, 7, "after");
		expect(reordered).not.toBeNull();
		expect(reordered!.text).toBe("## B\nb\n\n## C\nc\n\n## A\na\n");
		expect(reordered!.newLine).toBe(7);
	});
});

describe("csvColumnOutline", () => {
	test("summarizes CSV column counts, distinct values, and sample types", () => {
		const csv = [
			"id,active,created,amount,notes,empty_col",
			'101,true,2026-01-15,12.5,"first, row",',
			"102,false,2026-01-16,42,",
			"103,true,2026-01-15,12.5,second,",
		].join("\n");

		expect(hasOutline("csv")).toBe(true);
		const cols = csvColumnOutline(csv);
		expect(cols).toEqual([
			{ index: 0, name: "id", nonEmpty: 3, totalRows: 3, distinct: 3, sampleType: "number" },
			{ index: 1, name: "active", nonEmpty: 3, totalRows: 3, distinct: 2, sampleType: "boolean" },
			{ index: 2, name: "created", nonEmpty: 3, totalRows: 3, distinct: 2, sampleType: "date" },
			{ index: 3, name: "amount", nonEmpty: 3, totalRows: 3, distinct: 2, sampleType: "number" },
			{ index: 4, name: "notes", nonEmpty: 2, totalRows: 3, distinct: 2, sampleType: "text" },
			{ index: 5, name: "empty_col", nonEmpty: 0, totalRows: 3, distinct: 0, sampleType: "empty" },
		]);
		expect(outline("csv", csv).map((i) => i.name)).toEqual(["id", "active", "created", "amount", "notes", "empty_col"]);
	});

	test("handles TSV tables cleanly", () => {
		const tsv = "code\tstatus\nA-1\topen\nA-2\tdone\n";
		const cols = csvColumnOutline(tsv);
		expect(cols.map((c) => [c.name, c.nonEmpty, c.distinct, c.sampleType])).toEqual([
			["code", 2, 2, "text"],
			["status", 2, 2, "text"],
		]);
	});
});

describe("planStageOutline", () => {
	test("parses stages (groups) and their steps/decisions/calls with exact line numbers", () => {
		const planText = [
			"{",
			'  "version": 1,',
			'  "title": "Sample workflow",',
			'  "groups": [',
			'    { "id": "g1", "name": "Validate" },',
			'    { "id": "g2", "name": "Publish" }',
			"  ],",
			'  "nodes": [',
			'    { "id": "n1", "kind": "start", "text": "Start" },',
			'    { "id": "n2", "kind": "decision", "text": "Sample active?", "group": "g1" },',
			'    { "id": "n3", "kind": "call", "text": "UpdateStatus", "ref": "UpdateStatus", "group": "g2" },',
			'    { "id": "n4", "kind": "end", "text": "End" }',
			"  ],",
			'  "edges": []',
			"}",
		].join("\n");

		const stages = planStageOutline(planText);
		expect(stages).toEqual([
			{
				id: "g1",
				name: "Validate",
				line: 5,
				nodes: [{ id: "n2", kind: "decision", text: "Sample active?", group: "g1", line: 10 }],
			},
			{
				id: "g2",
				name: "Publish",
				line: 6,
				nodes: [{ id: "n3", kind: "call", text: "UpdateStatus", ref: "UpdateStatus", group: "g2", line: 11 }],
			},
			{
				id: "__ungrouped__",
				name: "Other steps",
				line: 9,
				ungrouped: true,
				nodes: [
					{ id: "n1", kind: "start", text: "Start", line: 9 },
					{ id: "n4", kind: "end", text: "End", line: 12 },
				],
			},
		]);
	});

	test("handles ungrouped plans and invalid JSON safely", () => {
		const simple = JSON.stringify(
			{ version: 1, title: "Simple", groups: [], nodes: [{ id: "n1", kind: "step", text: "Do work" }], edges: [] },
			null,
			2,
		);
		const stages = planStageOutline(simple);
		expect(stages).toHaveLength(1);
		expect(stages[0]!.name).toBe("Flow");
		expect(stages[0]!.nodes[0]!.text).toBe("Do work");
		expect(planStageOutline("{not json")).toEqual([]);
	});
});

describe("parseQuickFacets and fileTarget", () => {
	test("extracts tag:, status:, and type: facets alongside free text", () => {
		expect(parseQuickFacets("tag:migration status:open type:spec due rules")).toEqual({
			text: "due rules",
			tags: ["migration"],
			statuses: ["open"],
			types: ["spec"],
		});
		expect(parseQuickFacets('tag:#release-1 status:"in progress" type:Decision spec.md#Rollback')).toEqual({
			text: "spec.md#Rollback",
			tags: ["release-1"],
			statuses: ["in progress"],
			types: ["decision"],
		});
	});

	test("parses file#heading targets and composes with parseQuickFacets while keeping file:line:col intact", () => {
		expect(fileTarget("spec.md#Rollback")).toEqual({ file: "spec.md", at: null, heading: "Rollback" });
		expect(fileTarget("docs/spec.md#Rollback Plan")).toEqual({ file: "docs/spec.md", at: null, heading: "Rollback Plan" });
		expect(fileTarget("spec.md#")).toEqual({ file: "spec.md", at: null, heading: null });
		expect(fileTarget("DueRules.ssl:20:5")).toEqual({ file: "DueRules.ssl", at: { line: 20, column: 5 }, heading: null });
		expect(fileTarget("#migration")).toEqual({ file: "#migration", at: null, heading: null });
		// Space before #tag stays intact for word matching rather than splitting as a heading.
		expect(fileTarget("due #migration")).toEqual({ file: "due #migration", at: null, heading: null });

		const facets = parseQuickFacets("tag:ops spec.md#Rollback Plan");
		expect(facets.tags).toEqual(["ops"]);
		expect(fileTarget(facets.text)).toEqual({ file: "spec.md", at: null, heading: "Rollback Plan" });

		// Existing fileAndLine contract remains unchanged.
		expect(fileAndLine("DueRules.ssl:20")).toEqual({ query: "DueRules.ssl", at: { line: 20, column: 1 } });
	});
});
