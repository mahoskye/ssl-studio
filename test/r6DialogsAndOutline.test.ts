import { describe, expect, test } from "bun:test";
import {
	docIssueCode,
	docIssueDedupKey,
	initialMultiSelectIndices,
	resolveMultiSelectValues,
	selectAllVisibleIndices,
	toggleMultiSelectIndex,
} from "../src/shared/contextMenu";
import {
	demoteMarkdownSection,
	markdownSectionTree,
	moveMarkdownSectionTo,
	promoteMarkdownSection,
} from "../src/shared/outline";
import type { WorkspaceDocIssue } from "../src/shared/protocol";
import { DialogQueue, type DialogOverlay, type Request } from "../src/view/dialogQueue";

describe("Unified DialogQueue serialization across all overlay types", () => {
	test("serializes ask, choose, quickPick, quickPickMany, and browseWorkspaceFile through one FIFO queue", async () => {
		const dialogEvents: (string | null)[] = [];
		const overlayEvents: (string | null)[] = [];
		const queue = new DialogQueue(
			(req: Request | null) => dialogEvents.push(req?.title ?? null),
			(ov: DialogOverlay | null) => overlayEvents.push(ov ? `${ov.kind}:${ov.title}` : null),
		);

		const pAsk = queue.ask("Rename script", "OldName");
		const pPick = queue.quickPick({
			title: "Select ticket",
			items: [
				{ label: "DEMO-101", value: "DEMO-101" },
				{ label: "DEMO-102", value: "DEMO-102" },
			],
		});
		const pMany = queue.quickPickMany({
			title: "Select tags",
			items: [
				{ label: "migration", value: "migration" },
				{ label: "urgent", value: "urgent" },
				{ label: "docs", value: "docs" },
			],
			initialSelected: ["migration"],
			confirmLabel: "Apply",
		});
		const pFile = queue.browseWorkspaceFile({
			title: "Attach reference",
			root: "/workspace",
			initialDir: "/workspace/docs",
		});
		const pChoose = queue.choose("Save changes?", ["Save", "Discard"], { danger: "Discard" });

		// Only the first overlay is mounted; all 5 wait cleanly in one FIFO queue.
		expect(queue.length).toBe(5);
		expect(queue.active?.kind).toBe("dialog");
		expect(queue.current?.title).toBe("Rename script");
		expect(overlayEvents).toEqual(["dialog:Rename script"]);
		expect(dialogEvents).toEqual(["Rename script"]);

		// 1. Finish ask -> advances to quickPick (dialog observer receives null so no dual mount).
		const askReq = queue.current!;
		queue.finish(askReq, { button: "OK", value: "NewName" });
		expect(await pAsk).toBe("NewName");
		expect(queue.length).toBe(4);
		expect(queue.current).toBeNull();
		expect(queue.active?.kind).toBe("pick");
		expect(queue.active?.title).toBe("Select ticket");

		// A stale duplicate finish on the already-completed ask must not affect quickPick.
		queue.finish(askReq, null);
		expect(queue.active?.kind).toBe("pick");

		// 2. Finish quickPick -> advances to quickPickMany.
		const pickOverlay = queue.active!;
		expect(pickOverlay.kind).toBe("pick");
		queue.finishOverlay(pickOverlay, "DEMO-102");
		expect(await pPick).toBe("DEMO-102");
		expect(queue.length).toBe(3);
		expect(queue.active?.kind).toBe("pick-many");
		expect(queue.current).toBeNull();

		// 3. Finish quickPickMany -> advances to browseWorkspaceFile.
		const manyOverlay = queue.active!;
		expect(manyOverlay.kind).toBe("pick-many");
		if (manyOverlay.kind === "pick-many") {
			expect(manyOverlay.initialSelected).toEqual(["migration"]);
			expect(manyOverlay.confirmLabel).toBe("Apply");
		}
		queue.finishOverlay(manyOverlay, ["migration", "docs"]);
		expect(await pMany).toEqual(["migration", "docs"]);
		expect(queue.length).toBe(2);
		expect(queue.active?.kind).toBe("file");

		// 4. Finish browseWorkspaceFile -> advances to choose dialog.
		const fileOverlay = queue.active!;
		expect(fileOverlay.kind).toBe("file");
		queue.finishOverlay(fileOverlay, { path: "/workspace/docs/spec.md", rel: "docs/spec.md" });
		expect(await pFile).toEqual({ path: "/workspace/docs/spec.md", rel: "docs/spec.md" });
		expect(queue.length).toBe(1);
		expect(queue.active?.kind).toBe("dialog");
		expect(queue.current?.title).toBe("Save changes?");

		// 5. Cancel choose -> queue becomes completely idle.
		queue.finish(queue.current!, null);
		expect(await pChoose).toBeNull();
		expect(queue.length).toBe(0);
		expect(queue.active).toBeNull();
		expect(queue.current).toBeNull();

		expect(overlayEvents).toEqual([
			"dialog:Rename script",
			"pick:Select ticket",
			"pick-many:Select tags",
			"file:Attach reference",
			"dialog:Save changes?",
			null,
		]);
		expect(dialogEvents).toEqual(["Rename script", null, "Save changes?", null]);
	});

	test("DialogQueue.unified ignores non-head finishOverlay calls and handles chained overlays", async () => {
		const seen: (string | null)[] = [];
		const queue = DialogQueue.unified((ov) => seen.push(ov ? `${ov.kind}:${ov.title}` : null));

		const first = queue
			.quickPickMany({
				title: "Pick columns",
				items: [
					{ label: "A", value: "a" },
					{ label: "B", value: "b" },
				],
			})
			.then((cols) =>
				cols
					? queue.quickPick({
							title: "Confirm action",
							items: [{ label: `Export ${cols.join(",")}`, value: "export" }],
						})
					: null,
			);
		const second = queue.browseWorkspaceFile({ title: "Pick folder file", root: "/w" });

		const head1 = queue.active!;
		expect(head1.kind).toBe("pick-many");
		queue.finishOverlay(head1, ["a", "b"]);
		// Late duplicate cancellation of head1 must not cancel `second`.
		queue.finishOverlay(head1, null);
		expect(queue.active?.kind).toBe("file");

		queue.finishOverlay(queue.active!, null);
		expect(await second).toBeNull();
		await Promise.resolve();

		expect(queue.active?.kind).toBe("pick");
		expect(queue.active?.title).toBe("Confirm action");
		queue.finishOverlay(queue.active!, "export");
		expect(await first).toBe("export");
		expect(queue.active).toBeNull();
		expect(seen).toEqual([
			"pick-many:Pick columns",
			"file:Pick folder file",
			null,
			"pick:Confirm action",
			null,
		]);
	});
});

describe("Multi-select QuickPick pure state helpers", () => {
	const items = [
		{ label: "Alpha", value: "alpha", checked: true },
		{ label: "Beta", value: "beta" },
		{ label: "Gamma", value: "gamma", checked: true },
		{ label: "Delta", value: "delta" },
	];

	test("initializes from explicit initialSelected or falls back to item.checked", () => {
		expect([...initialMultiSelectIndices(items)]).toEqual([0, 2]);
		expect([...initialMultiSelectIndices(items, ["beta", "delta"])]).toEqual([1, 3]);
		expect([...initialMultiSelectIndices(items, [])]).toEqual([]);
	});

	test("preserves hidden checked items across filtered toggles and select-all-visible", () => {
		let selected = initialMultiSelectIndices(items, ["alpha"]);
		// Imagine search filter shows only indices [1, 3] ("Beta", "Delta"); "Alpha" (0) is hidden.
		selected = toggleMultiSelectIndex(selected, 3);
		expect(resolveMultiSelectValues(items, selected)).toEqual(["alpha", "delta"]);

		// Select all visible ([1, 3]) adds index 1 without losing hidden index 0.
		selected = selectAllVisibleIndices(selected, [1, 3]);
		expect(resolveMultiSelectValues(items, selected)).toEqual(["alpha", "beta", "delta"]);

		// Toggling an already-selected item removes only that item.
		selected = toggleMultiSelectIndex(selected, 1);
		expect(resolveMultiSelectValues(items, selected)).toEqual(["alpha", "delta"]);
	});
});

describe("Problems panel exhaustive doc issue classification and dedup", () => {
	test("maps every WorkspaceDocIssue kind exhaustively without falling back to yaml-frontmatter", () => {
		const expected: Record<WorkspaceDocIssue["kind"], string> = {
			anchor: "broken-anchor",
			table: "table-rule",
			citation: "code-citation",
			yaml: "yaml-frontmatter",
			"schema-drift": "schema-drift",
			"duplicate-heading": "duplicate-heading",
			orphan: "orphan-doc",
			stale: "stale-doc",
		};
		for (const [kind, code] of Object.entries(expected) as [WorkspaceDocIssue["kind"], string][]) {
			expect(docIssueCode(kind)).toBe(code);
		}
		// Unknown future runtime kind must pass through verbatim, never silently dumped into yaml-frontmatter.
		expect(docIssueCode("future-audit-kind" as WorkspaceDocIssue["kind"])).toBe("future-audit-kind");
	});

	test("line-1 document-level warnings never silently collide or drop each other", () => {
		const file = "/workspace/schema/orders.md";
		const driftOrders = docIssueDedupKey(file, {
			line: 1,
			kind: "schema-drift",
			message: "Schema drift in ORDERS vs orders.sql (+1 added).",
		});
		const driftItems = docIssueDedupKey(file, {
			line: 1,
			kind: "schema-drift",
			message: "Schema drift in ORDER_ITEMS vs orders.sql (~2 modified).",
		});
		const yamlErr = docIssueDedupKey(file, {
			line: 1,
			kind: "yaml",
			message: "Front matter YAML is missing a closing delimiter.",
		});
		const orphanNote = docIssueDedupKey(file, {
			line: 1,
			kind: "orphan",
			message: "Unreferenced schema doc: orders.md.",
		});
		const staleA = docIssueDedupKey(file, {
			line: 1,
			kind: "stale",
			message: "Untouched template (12 days old): orders.md.",
		});
		const staleB = docIssueDedupKey(file, {
			line: 1,
			kind: "stale",
			message: "Controlled document orders.md is missing approved-by.",
		});

		const unique = new Set([driftOrders, driftItems, yamlErr, orphanNote, staleA, staleB]);
		expect(unique.size).toBe(6);

		// Identical line-1 issue still deduplicates cleanly.
		const duplicateDriftOrders = docIssueDedupKey(file, {
			line: 1,
			kind: "schema-drift",
			message: "Schema drift in ORDERS vs orders.sql (+1 added).",
		});
		expect(duplicateDriftOrders).toBe(driftOrders);
	});

	test("deduplicates line > 1 table-rule with open-file diagnostics while keeping distinct same-line anchors", () => {
		const file = "/workspace/docs/spec.md";
		expect(docIssueDedupKey(file, { line: 14, kind: "table", message: "Too many columns" })).toBe(
			`${file}:14:table-rule`,
		);
		expect(docIssueDedupKey(file, { line: 14, column: 1, kind: "table", message: "Too many columns" })).toBe(
			`${file}:14:table-rule`,
		);

		const a1 = docIssueDedupKey(file, { line: 22, column: 5, kind: "anchor", message: 'Heading "#one" not found' });
		const a2 = docIssueDedupKey(file, { line: 22, column: 34, kind: "anchor", message: 'Heading "#two" not found' });
		expect(a1).not.toBe(a2);
	});
});

describe("Markdown outline promoteMarkdownSection and demoteMarkdownSection", () => {
	test("promotes a section and all its nested descendants while ignoring code fences and front matter", () => {
		const md = [
			"---",
			"title: Architecture",
			"---",
			"",
			"# Root",
			"",
			"## Design",
			"Intro",
			"```sh",
			"## Not a heading in bash",
			"### Still not a heading",
			"```",
			"### Storage",
			"Details",
			"#### Indexes",
			"B-tree",
			"",
			"## Rollout",
			"Steps",
			"",
		].join("\n");

		const promoted = promoteMarkdownSection(md, 7);
		expect(promoted.changed).toBe(true);
		expect(promoted.newLine).toBe(7);
		expect(promoted.text).toBe(
			[
				"---",
				"title: Architecture",
				"---",
				"",
				"# Root",
				"",
				"# Design",
				"Intro",
				"```sh",
				"## Not a heading in bash",
				"### Still not a heading",
				"```",
				"## Storage",
				"Details",
				"### Indexes",
				"B-tree",
				"",
				"## Rollout",
				"Steps",
				"",
			].join("\n"),
		);

		// Promoting an already level-1 heading is a clean no-op.
		const clamped = promoteMarkdownSection(promoted.text, 7);
		expect(clamped).toEqual({ text: promoted.text, newLine: 7, changed: false });
	});

	test("demotes a section and nested descendants, blocks at H6, and preserves CRLF & closing hashes", () => {
		const crlf = "### Alpha ###\r\nBody\r\n#### Beta\r\nLeaf\r\n##### Gamma\r\nDeep\r\n";

		const demoted = demoteMarkdownSection(crlf, 1);
		expect(demoted.changed).toBe(true);
		expect(demoted.newLine).toBe(1);
		expect(demoted.text).toBe("#### Alpha ####\r\nBody\r\n##### Beta\r\nLeaf\r\n###### Gamma\r\nDeep\r\n");

		// A descendant is now level 6 (###### Gamma), so further demotion is a no-op.
		const blocked = demoteMarkdownSection(demoted.text, 1);
		expect(blocked).toEqual({ text: demoted.text, newLine: 1, changed: false });

		// Demoting a non-heading line is a no-op.
		expect(demoteMarkdownSection(crlf, 2)).toEqual({ text: crlf, newLine: 2, changed: false });
	});
});

describe("Markdown outline cross-parent moveMarkdownSectionTo", () => {
	const sampleDoc = [
		"---",
		"title: Migration Plan",
		"---",
		"",
		"# Overview",
		"",
		"## Alpha",
		"Alpha body",
		"",
		"### Alpha-1",
		"Alpha-1 body",
		"```bash",
		"# comment stays untouched",
		"```",
		"",
		"#### Alpha-1a",
		"Deep body",
		"",
		"## Beta",
		"Beta body",
		"",
		"### Beta-1",
		"Beta-1 body",
		"",
	].join("\n");

	test("moves a nested section across parents with placement 'before', rebasing its subtree to target level", () => {
		// Move `### Alpha-1` (line 10, level 3, with `#### Alpha-1a`) before `## Beta` (line 19, level 2).
		const res = moveMarkdownSectionTo(sampleDoc, 10, 19, "before");
		expect(res.changed).toBe(true);
		expect(res.text).toBe(
			[
				"---",
				"title: Migration Plan",
				"---",
				"",
				"# Overview",
				"",
				"## Alpha",
				"Alpha body",
				"",
				"## Alpha-1",
				"Alpha-1 body",
				"```bash",
				"# comment stays untouched",
				"```",
				"",
				"### Alpha-1a",
				"Deep body",
				"",
				"## Beta",
				"Beta body",
				"",
				"### Beta-1",
				"Beta-1 body",
				"",
			].join("\n"),
		);
		expect(res.newLine).toBe(10);
		const tree = markdownSectionTree(res.text);
		expect(tree[0]!.children.map((c) => [c.text, c.level])).toEqual([
			["Alpha", 2],
			["Alpha-1", 2],
			["Beta", 2],
		]);
		expect(tree[0]!.children[1]!.children.map((c) => [c.text, c.level])).toEqual([["Alpha-1a", 3]]);
	});

	test("moves a section across parents with placement 'after', placing it after target's full subtree", () => {
		// Move `### Beta-1` (line 22, level 3) after `## Alpha` (line 7, level 2).
		const res = moveMarkdownSectionTo(sampleDoc, 22, 7, "after");
		expect(res.changed).toBe(true);
		expect(res.text).toBe(
			[
				"---",
				"title: Migration Plan",
				"---",
				"",
				"# Overview",
				"",
				"## Alpha",
				"Alpha body",
				"",
				"### Alpha-1",
				"Alpha-1 body",
				"```bash",
				"# comment stays untouched",
				"```",
				"",
				"#### Alpha-1a",
				"Deep body",
				"",
				"## Beta-1",
				"Beta-1 body",
				"",
				"## Beta",
				"Beta body",
				"",
			].join("\n"),
		);
		expect(res.newLine).toBe(19);
		const tree = markdownSectionTree(res.text);
		expect(tree[0]!.children.map((c) => [c.text, c.level])).toEqual([
			["Alpha", 2],
			["Beta-1", 2],
			["Beta", 2],
		]);
	});

	test("moves a section with nested children 'inside' another parent and rebases all descendants", () => {
		// Move `## Alpha` (line 7, level 2, with level 3 & 4 children) inside `## Beta` (line 19, level 2).
		const res = moveMarkdownSectionTo(sampleDoc, 7, 19, "inside");
		expect(res.changed).toBe(true);
		expect(res.text).toBe(
			[
				"---",
				"title: Migration Plan",
				"---",
				"",
				"# Overview",
				"",
				"## Beta",
				"Beta body",
				"",
				"### Beta-1",
				"Beta-1 body",
				"",
				"### Alpha",
				"Alpha body",
				"",
				"#### Alpha-1",
				"Alpha-1 body",
				"```bash",
				"# comment stays untouched",
				"```",
				"",
				"##### Alpha-1a",
				"Deep body",
				"",
			].join("\n"),
		);
		expect(res.newLine).toBe(13);
		const tree = markdownSectionTree(res.text);
		expect(tree[0]!.children).toHaveLength(1);
		const beta = tree[0]!.children[0]!;
		expect(beta.text).toBe("Beta");
		expect(beta.children.map((c) => [c.text, c.level])).toEqual([
			["Beta-1", 3],
			["Alpha", 3],
		]);
		expect(beta.children[1]!.children[0]!.level).toBe(4);
		expect(beta.children[1]!.children[0]!.children[0]!.level).toBe(5);
	});

	test("preserves CRLF and tight (no-blank-line) layout cleanly", () => {
		const crlfTight = "## One\r\na\r\n## Two\r\nb\r\n### Two-A\r\nc";
		const res = moveMarkdownSectionTo(crlfTight, 5, 1, "before");
		expect(res.changed).toBe(true);
		expect(res.newLine).toBe(1);
		expect(res.text).toBe("## Two-A\r\nc\r\n## One\r\na\r\n## Two\r\nb");
	});

	test("rejects invalid drops onto itself, into its own descendant, inside H6, or non-heading lines", () => {
		// Drop onto self
		expect(moveMarkdownSectionTo(sampleDoc, 7, 7, "before")).toEqual({ text: sampleDoc, newLine: 7, changed: false });
		// Drop onto direct child (`### Alpha-1` at line 10)
		expect(moveMarkdownSectionTo(sampleDoc, 7, 10, "before")).toEqual({ text: sampleDoc, newLine: 7, changed: false });
		expect(moveMarkdownSectionTo(sampleDoc, 7, 10, "after")).toEqual({ text: sampleDoc, newLine: 7, changed: false });
		expect(moveMarkdownSectionTo(sampleDoc, 7, 10, "inside")).toEqual({ text: sampleDoc, newLine: 7, changed: false });
		// Drop onto grandchild (`#### Alpha-1a` at line 16)
		expect(moveMarkdownSectionTo(sampleDoc, 7, 16, "inside")).toEqual({ text: sampleDoc, newLine: 7, changed: false });
		// Non-heading source or target
		expect(moveMarkdownSectionTo(sampleDoc, 8, 19, "before")).toEqual({ text: sampleDoc, newLine: 8, changed: false });
		expect(moveMarkdownSectionTo(sampleDoc, 7, 13, "before")).toEqual({ text: sampleDoc, newLine: 7, changed: false });
		// Cannot nest inside an H6 heading
		const h6Doc = "## A\nbody\n\n###### Deep\nleaf\n";
		expect(moveMarkdownSectionTo(h6Doc, 1, 4, "inside")).toEqual({ text: h6Doc, newLine: 1, changed: false });
	});
});
