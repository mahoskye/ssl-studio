import { describe, expect, test } from "bun:test";
import { frontMatter } from "../src/shared/frontMatter";
import { validateFrontmatterProperty } from "../src/view/editor/markdownHtml";
import {
	activeMarkdownTab,
	chooseDefaultLinksTab,
	chooseMarkdownPanelTab,
	computeMinimalTextChange,
	defaultMarkdownPanelTab,
	extractDisplayProperties,
	formatCompactHeaderMeta,
	groupPropertiesForInspector,
	markdownLinksSummary,
	markdownPanelTabRequest,
	markdownYamlEditorOpen,
	MD_PANEL_TAB_KEY,
	parseMarkdownPanelTab,
	registerMarkdownPanelOpener,
	requestMarkdownInspector,
	requestMarkdownPanelTab,
	setMarkdownLinksSummary,
	setMarkdownYamlEditorOpen,
} from "../src/view/panels/markdownBridge";

describe("Markdown Document panel tab persistence & defaults", () => {
	test("uses md.panel.tab storage key and parses valid values strictly", () => {
		expect(MD_PANEL_TAB_KEY).toBe("md.panel.tab");
		expect(parseMarkdownPanelTab("info")).toBe("info");
		expect(parseMarkdownPanelTab("outline")).toBe("outline");
		expect(parseMarkdownPanelTab(null)).toBeNull();
		expect(parseMarkdownPanelTab(undefined)).toBeNull();
		expect(parseMarkdownPanelTab("")).toBeNull();
		expect(parseMarkdownPanelTab("properties")).toBeNull();
	});

	test("defaults to info for docs with frontmatter/ticket and outline for plain docs when unset", () => {
		expect(defaultMarkdownPanelTab(true, null)).toBe("info");
		expect(defaultMarkdownPanelTab(false, null)).toBe("outline");
		expect(defaultMarkdownPanelTab(true, "invalid")).toBe("info");
		expect(defaultMarkdownPanelTab(false, "")).toBe("outline");
	});

	test("honors remembered user tab choice regardless of frontmatter presence", () => {
		expect(defaultMarkdownPanelTab(true, "outline")).toBe("outline");
		expect(defaultMarkdownPanelTab(false, "info")).toBe("info");
	});
});

describe("Markdown inspector bridge request signals", () => {
	test("requestMarkdownInspector switches to info, increments seq, propagates focus, and invokes panel opener", () => {
		let openCalls = 0;
		registerMarkdownPanelOpener(() => {
			openCalls++;
		});

		chooseMarkdownPanelTab("outline");
		expect(activeMarkdownTab()).toBe("outline");

		requestMarkdownInspector("links");
		const first = markdownPanelTabRequest();
		expect(activeMarkdownTab()).toBe("info");
		expect(first?.tab).toBe("info");
		expect(first?.focus).toBe("links");
		expect(openCalls).toBe(1);

		requestMarkdownInspector("yaml");
		const second = markdownPanelTabRequest();
		expect(second?.tab).toBe("info");
		expect(second?.focus).toBe("yaml");
		expect(second!.seq).toBeGreaterThan(first!.seq);
		expect(openCalls).toBe(2);

		requestMarkdownPanelTab("outline");
		expect(activeMarkdownTab()).toBe("outline");
		expect(markdownPanelTabRequest()?.tab).toBe("outline");
		expect(openCalls).toBe(3);

		setMarkdownYamlEditorOpen(true);
		expect(markdownYamlEditorOpen()).toBe(true);
		setMarkdownYamlEditorOpen(false);
		expect(markdownYamlEditorOpen()).toBe(false);

		setMarkdownLinksSummary({ path: "/ws/docs/a.md", backlinks: 2, outgoing: 3, unlinked: 1, broken: 1, total: 6 });
		expect(markdownLinksSummary()?.total).toBe(6);
		expect(markdownLinksSummary()?.broken).toBe(1);
	});
});

describe("Compact content-first Markdown header summary formatting", () => {
	test("formats ticket + status + links cleanly when metadata exists", () => {
		const meta = formatCompactHeaderMeta({
			ticket: "DEMO-101",
			status: "done",
			totalLinks: 7,
			brokenLinks: 0,
		});
		expect(meta.ticketLabel).toBe("DEMO-101");
		expect(meta.statusLabel).toBe("done");
		expect(meta.hasLeftMeta).toBe(true);
		expect(meta.linksLabel).toBe("Links (7)");
		expect(meta.brokenCount).toBe(0);
		expect(meta.linksTitle).toContain("Backlinks");
	});

	test("handles status-only, ticket-only, and plain prose docs without left pills", () => {
		const statusOnly = formatCompactHeaderMeta({ status: "draft", totalLinks: 2, brokenLinks: 0 });
		expect(statusOnly.hasLeftMeta).toBe(true);
		expect(statusOnly.ticketLabel).toBe("");
		expect(statusOnly.statusLabel).toBe("draft");

		const plain = formatCompactHeaderMeta({ ticket: "  ", status: "", totalLinks: 0, brokenLinks: 0 });
		expect(plain.hasLeftMeta).toBe(false);
		expect(plain.linksLabel).toBe("Links (0)");
	});

	test("surfaces singular and plural broken outgoing link tooltips and clamps negative inputs", () => {
		const oneBroken = formatCompactHeaderMeta({ totalLinks: 4, brokenLinks: 1 });
		expect(oneBroken.brokenCount).toBe(1);
		expect(oneBroken.linksTitle).toContain("1 broken outgoing link");

		const manyBroken = formatCompactHeaderMeta({ totalLinks: 5, brokenLinks: 3 });
		expect(manyBroken.linksTitle).toContain("3 broken outgoing links");

		const clamped = formatCompactHeaderMeta({ totalLinks: -2, brokenLinks: -1 });
		expect(clamped.linksLabel).toBe("Links (0)");
		expect(clamped.brokenCount).toBe(0);
	});
});

describe("Inspector property extraction, grouping & validation", () => {
	test("extractDisplayProperties excludes title and empty entries while normalizing scalars and arrays", () => {
		const md = [
			"---",
			"title: Batch Release Procedure",
			"status: in progress",
			"ticket: LIMS-101",
			"tags: [gxp, release]",
			"version: 1.2",
			"approved-by: QA Lead",
			"approved-date: 2026-04-15",
			"review-due: 2026-02-30",
			"---",
			"",
			"# Batch Release Procedure",
		].join("\n");

		const fm = frontMatter(md);
		const facts = extractDisplayProperties(fm.values);
		expect(facts.map((f) => f.key)).toEqual([
			"status",
			"ticket",
			"tags",
			"version",
			"approved-by",
			"approved-date",
			"review-due",
		]);
		expect(facts.find((f) => f.key === "tags")?.values).toEqual(["gxp", "release"]);

		const grouped = groupPropertiesForInspector(facts);
		expect(grouped.primary.map((f) => f.key)).toEqual(["status", "ticket", "tags"]);
		expect(grouped.governance.map((f) => f.key)).toEqual(["version", "approved-by", "approved-date", "review-due"]);

		const ctx = {
			knownTickets: new Set(["lims-101"]),
			existingFiles: new Set<string>(),
			workspaceRoot: "/ws",
			docPath: "/ws/docs/sop.md",
		};
		expect(validateFrontmatterProperty("ticket", "LIMS-101", ctx)).toBeNull();
		expect(validateFrontmatterProperty("approved-date", "2026-04-15", ctx)).toBeNull();
		expect(validateFrontmatterProperty("review-due", "2026-02-30", ctx)?.kind).toBe("invalid-date");
	});
});

describe("Default Links tab selection and minimal text diffs", () => {
	test("chooseDefaultLinksTab prioritizes broken links, respects backlinks loading, and falls back in order", () => {
		expect(chooseDefaultLinksTab({ backlinks: 2, outgoing: 3, unlinked: 1, brokenOutgoing: 1 })).toBe("outgoing");
		expect(chooseDefaultLinksTab({ backlinks: 0, outgoing: 4, unlinked: 0, brokenOutgoing: 1, backlinksLoading: true })).toBe("outgoing");
		expect(chooseDefaultLinksTab({ backlinks: 0, outgoing: 4, unlinked: 2, brokenOutgoing: 0, backlinksLoading: true })).toBe("backlinks");
		expect(chooseDefaultLinksTab({ backlinks: 2, outgoing: 5, unlinked: 3, brokenOutgoing: 0 })).toBe("backlinks");
		expect(chooseDefaultLinksTab({ backlinks: 0, outgoing: 3, unlinked: 2, brokenOutgoing: 0 })).toBe("outgoing");
		expect(chooseDefaultLinksTab({ backlinks: 0, outgoing: 0, unlinked: 2, brokenOutgoing: 0 })).toBe("unlinked");
		expect(chooseDefaultLinksTab({ backlinks: 0, outgoing: 0, unlinked: 0, brokenOutgoing: 0 })).toBe("backlinks");
	});

	test("computeMinimalTextChange returns minimal changed slice and null when unchanged", () => {
		expect(computeMinimalTextChange("same\ntext", "same\ntext")).toBeNull();

		const before = "---\nstatus: open\n---\n\n# Doc\n";
		const after = "---\nstatus: done\n---\n\n# Doc\n";
		const diff = computeMinimalTextChange(before, after);
		expect(diff).not.toBeNull();
		expect(before.slice(0, diff!.start) + diff!.insert + before.slice(diff!.endPrev)).toBe(after);
		expect(diff!.insert).toBe("done");
		expect(before.slice(diff!.start, diff!.endPrev)).toBe("open");
	});
});
