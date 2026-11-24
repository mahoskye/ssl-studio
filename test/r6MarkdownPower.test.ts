import { describe, expect, test } from "bun:test";
import { marked } from "marked";
import { parseMarkdownTable } from "../src/shared/markdownTables";
import {
	buildHeadingWikiLink,
	bumpSemanticVersion,
	computeDuplicateLineOrSelection,
	computeInsertLineAbove,
	computeInsertLineBelow,
	computeJoinLines,
	computeSelectLine,
	DATE_PROPERTY_KEYS,
	deduplicatedHeadingAnchorsByLine,
	expandTransclusionsMarkdown,
	extractFootnoteDefinition,
	GOVERNANCE_PROPERTY_KEYS,
	isValidIsoDate,
	MAX_TRANSCLUSION_DEPTH,
	normalizeTableRange,
	type PureLineEdit,
	renderCalloutsHtml,
	serializeTableToCsv,
	serializeTableToTsv,
	type TransclusionLoader,
	validateFrontmatterProperty,
} from "../src/view/editor/markdownHtml";

function applyEdit(doc: string, edit: PureLineEdit): string {
	return `${doc.slice(0, edit.changeFrom)}${edit.insert}${doc.slice(edit.changeTo)}`;
}

describe("Round 6 — Sublime Text line-editing helpers", () => {
	test("computeDuplicateLineOrSelection duplicates non-empty selection inline and selects the copy", () => {
		const doc = "hello world";
		const edit = computeDuplicateLineOrSelection(doc, 0, 5);
		expect(applyEdit(doc, edit)).toBe("hellohello world");
		expect(edit.selFrom).toBe(5);
		expect(edit.selTo).toBe(10);
	});

	test("computeDuplicateLineOrSelection duplicates current line below preserving column offset", () => {
		const doc = "alpha\n  beta\ngamma";
		// Cursor at index 10 -> "  be|ta" (col 4)
		const edit = computeDuplicateLineOrSelection(doc, 10, 10);
		const next = applyEdit(doc, edit);
		expect(next).toBe("alpha\n  beta\n  beta\ngamma");
		// Next line starts at index 13; col 4 -> index 17 ("  be|ta")
		expect(edit.selFrom).toBe(17);
		expect(edit.selTo).toBe(17);
		expect(next.slice(edit.selFrom, edit.selFrom + 2)).toBe("ta");
	});

	test("computeJoinLines joins current line with next line using a single space", () => {
		const doc = "first line   \n   second line\nthird line";
		const edit = computeJoinLines(doc, 2, 2);
		expect(edit).not.toBeNull();
		expect(applyEdit(doc, edit!)).toBe("first line second line\nthird line");
		expect(edit!.selFrom).toBe(11);
	});

	test("computeJoinLines returns null on the final line", () => {
		expect(computeJoinLines("only line", 3, 3)).toBeNull();
		expect(computeJoinLines("one\ntwo", 5, 5)).toBeNull();
	});

	test("computeJoinLines joins all lines across a multi-line selection", () => {
		const doc = "alpha\n  beta  \n\tgamma\ndelta";
		const edit = computeJoinLines(doc, 1, 20); // spans alpha..gamma
		expect(edit).not.toBeNull();
		expect(applyEdit(doc, edit!)).toBe("alpha beta gamma\ndelta");
	});

	test("computeInsertLineBelow inserts indented blank line below without splitting current line", () => {
		const doc = "  hello world\nnext";
		// Cursor in middle of "hello"
		const edit = computeInsertLineBelow(doc, 5);
		const next = applyEdit(doc, edit);
		expect(next).toBe("  hello world\n  \nnext");
		expect(edit.selFrom).toBe(16);
		expect(edit.selTo).toBe(16);
	});

	test("computeInsertLineAbove inserts indented blank line above without splitting current line", () => {
		const doc = "top\n    indented line\nbottom";
		// Cursor at "indented"
		const edit = computeInsertLineAbove(doc, 10);
		const next = applyEdit(doc, edit);
		expect(next).toBe("top\n    \n    indented line\nbottom");
		expect(edit.selFrom).toBe(8);
		expect(edit.selTo).toBe(8);
	});

	test("computeSelectLine selects current line and expands line-by-line on repeated presses", () => {
		const doc = "one\ntwo\nthree";
		const s1 = computeSelectLine(doc, 1, 1);
		expect(doc.slice(s1.from, s1.to)).toBe("one\n");

		const s2 = computeSelectLine(doc, s1.from, s1.to);
		expect(doc.slice(s2.from, s2.to)).toBe("one\ntwo\n");

		const s3 = computeSelectLine(doc, s2.from, s2.to);
		expect(doc.slice(s3.from, s3.to)).toBe("one\ntwo\nthree");

		// Repeated press at EOF stays stable
		const s4 = computeSelectLine(doc, s3.from, s3.to);
		expect(s4).toEqual(s3);
	});
});

describe("Round 6 — Live Table TSV / CSV serialization & rectangular range", () => {
	const tableLines = [
		"| Sample | Status | Notes |",
		"| :--- | :---: | ---: |",
		"| S-01 | Ready | ok, verified |",
		'| S-02 | Hold | "needs review" |',
		"| S-03 | Done | line1<br>line2 |",
	];

	test("normalizeTableRange orders reversed drag coordinates cleanly", () => {
		expect(normalizeTableRange({ row: 3, col: 2 }, { row: 1, col: 0 })).toEqual({
			minRow: 1,
			maxRow: 3,
			minCol: 0,
			maxCol: 2,
		});
	});

	test("serializeTableToTsv exports full table and rectangular range with tabs/newlines flattened", () => {
		const table = parseMarkdownTable(tableLines, 0);
		expect(table).not.toBeNull();

		const full = serializeTableToTsv(table!);
		expect(full).toBe(
			[
				"Sample\tStatus\tNotes",
				"S-01\tReady\tok, verified",
				'S-02\tHold\t"needs review"',
				"S-03\tDone\tline1 line2",
			].join("\n"),
		);

		const slice = serializeTableToTsv(table!, normalizeTableRange({ row: 2, col: 1 }, { row: 1, col: 0 }));
		expect(slice).toBe("S-01\tReady\nS-02\tHold");
	});

	test("serializeTableToCsv quotes commas, double quotes, and newlines per RFC-4180", () => {
		const table = parseMarkdownTable(tableLines, 0);
		expect(table).not.toBeNull();

		const fullCsv = serializeTableToCsv(table!);
		expect(fullCsv).toBe(
			[
				"Sample,Status,Notes",
				'S-01,Ready,"ok, verified"',
				'S-02,Hold,"""needs review"""',
				'S-03,Done,"line1\nline2"',
			].join("\n"),
		);

		const subCsv = serializeTableToCsv(table!, { minRow: 0, maxRow: 1, minCol: 1, maxCol: 2 });
		expect(subCsv).toBe('Status,Notes\nReady,"ok, verified"');
	});
});

describe("Round 6 — Foldable & nested callout HTML rendering", () => {
	test("renders standard non-foldable callout as div.md-callout for both breaks modes", () => {
		const md = "> [!note] Summary\n> First line of body\n> Second line of body";
		for (const breaks of [false, true]) {
			const html = renderCalloutsHtml(marked.parse(md, { async: false, breaks }) as string);
			expect(html).toContain('<div class="md-callout tone-info">');
			expect(html).toContain('<span class="md-callout-title">Summary</span>');
			expect(html).toContain("First line of body");
			expect(html).toContain("Second line of body");
			expect(html).not.toContain("<details");
		}
	});

	test("renders foldable + (open) and - (collapsed) callouts as <details>/<summary>", () => {
		const openMd = "> [!tip]+ Quick Tip\n> Expanded by default";
		const openHtml = renderCalloutsHtml(marked.parse(openMd, { async: false }) as string);
		expect(openHtml).toContain('<details class="md-callout tone-ok is-foldable" open>');
		expect(openHtml).toContain('<summary class="md-callout-head">');
		expect(openHtml).toContain("Quick Tip");
		expect(openHtml).toContain("Expanded by default");

		const closedMd = "> [!warning]- Hidden Details\n> Collapsed initially";
		const closedHtml = renderCalloutsHtml(marked.parse(closedMd, { async: false, breaks: true }) as string);
		expect(closedHtml).toContain('<details class="md-callout tone-warning is-foldable">');
		expect(closedHtml).not.toContain('is-foldable" open>');
		expect(closedHtml).toContain("Hidden Details");
		expect(closedHtml).toContain("Collapsed initially");
	});

	test("renders nested callouts recursively (> [!note] containing > > [!warning]-)", () => {
		const nestedMd = [
			"> [!note] Outer Guide",
			"> Outer prose",
			">",
			"> > [!warning]- Inner Caveat",
			"> > Nested warning body",
		].join("\n");
		const html = renderCalloutsHtml(marked.parse(nestedMd, { async: false, breaks: true }) as string);
		expect(html).toContain('<div class="md-callout tone-info">');
		expect(html).toContain("Outer Guide");
		expect(html).toContain('<details class="md-callout tone-warning is-foldable">');
		expect(html).toContain("Inner Caveat");
		expect(html).toContain("Nested warning body");
	});

	test("does not touch blockquote examples inside <pre><code> blocks", () => {
		const raw =
			'<pre><code><blockquote><p>[!note] Literal</p></blockquote></code></pre>\n<blockquote><p>[!info] Real<br>Body</p></blockquote>';
		const html = renderCalloutsHtml(raw);
		expect(html).toContain("<pre><code><blockquote><p>[!note] Literal</p></blockquote></code></pre>");
		expect(html).toContain('<div class="md-callout tone-info">');
		expect(html).toContain("Real");
	});
});

describe("Round 6 — Bounded recursive transclusion expansion", () => {
	const files: Record<string, { title: string; path: string; markdown: string }> = {
		level1: { title: "Level 1", path: "/ws/level1.md", markdown: "Intro 1\n![[level2]]" },
		level2: { title: "Level 2", path: "/ws/level2.md", markdown: "Intro 2\n![[level3]]" },
		level3: { title: "Level 3", path: "/ws/level3.md", markdown: "Should not inline at depth 2" },
		self: { title: "Self Note", path: "/ws/self.md", markdown: "Self start\n![[self]]" },
		a: { title: "Doc A", path: "/ws/a.md", markdown: "From A\n![[b]]" },
		b: { title: "Doc B", path: "/ws/b.md", markdown: "From B\n![[a]]" },
	};

	const loader: TransclusionLoader = async (inner) => {
		const key = inner.trim().toLowerCase();
		const hit = files[key];
		if (!hit) return null;
		return { key: hit.path, docKey: hit.path, ...hit };
	};

	test("expands up to MAX_TRANSCLUSION_DEPTH (2) and stops cleanly at depth 3", async () => {
		expect(MAX_TRANSCLUSION_DEPTH).toBe(2);
		const expanded = await expandTransclusionsMarkdown("Root\n![[level1]]", "/ws/root.md", loader);
		expect(expanded).toContain("> [!note] Level 1");
		expect(expanded).toContain("> > [!note] Level 2");
		expect(expanded).toContain("(max embed depth reached)");
		expect(expanded).not.toContain("Should not inline at depth 2");
	});

	test("prevents self-cycles and mutual A -> B -> A cycles", async () => {
		const selfExpanded = await expandTransclusionsMarkdown("![[self]]", "/ws/root.md", loader);
		expect(selfExpanded).toContain("> [!note] Self Note");
		expect(selfExpanded).toContain("Circular embed skipped: Self Note");

		const mutual = await expandTransclusionsMarkdown("![[a]]", "/ws/root.md", loader, {
			visited: new Set(["/ws/a.md"]),
		});
		expect(mutual).toContain("Circular embed skipped: Doc A");

		const mutualFromRoot = await expandTransclusionsMarkdown("![[a]]", "/ws/root.md", loader, { maxDepth: 4 });
		expect(mutualFromRoot).toContain("> [!note] Doc A");
		expect(mutualFromRoot).toContain("> > [!note] Doc B");
		expect(mutualFromRoot).toContain("Circular embed skipped: Doc A");
	});

	test("ignores fenced code blocks and preserves image embeds untouched", async () => {
		const md = ["```md", "![[level1]]", "```", "", "![[diagram.png|420]]"].join("\n");
		const expanded = await expandTransclusionsMarkdown(md, "/ws/root.md", loader);
		expect(expanded).toBe(md);
	});
});

describe("Round 6 — Deduplicated heading anchors, wikilinks & footnotes", () => {
	test("deduplicatedHeadingAnchorsByLine assigns unique suffixes while skipping frontmatter and fences", () => {
		const md = [
			"---",
			"title: Sample",
			"---",
			"# Overview",
			"```md",
			"# Overview",
			"```",
			"## Overview",
			"### Overview",
			"## Setup & Run",
		].join("\n");
		const map = deduplicatedHeadingAnchorsByLine(md);
		expect(map.get(4)).toBe("overview");
		expect(map.has(6)).toBe(false);
		expect(map.get(8)).toBe("overview-1");
		expect(map.get(9)).toBe("overview-2");
		expect(map.get(10)).toBe("setup-run");
	});

	test("buildHeadingWikiLink formats doc and self heading links", () => {
		expect(buildHeadingWikiLink("Architecture", "Data Flow")).toBe("[[Architecture#Data Flow]]");
		expect(buildHeadingWikiLink("  ", "Local Section")).toBe("[[#Local Section]]");
	});

	test("extractFootnoteDefinition resolves single-line and multi-line definitions while skipping fences", () => {
		const md = [
			"---",
			"title: Notes",
			"---",
			"Body referencing[^1] and[^note].",
			"",
			"```md",
			"[^1]: decoy inside fence",
			"```",
			"",
			"[^1]: First **real** footnote with `code`.",
			"[^note]: Multi-line",
			"  second line",
			"",
			"  third paragraph",
		].join("\n");
		const f1 = extractFootnoteDefinition(md, "1");
		expect(f1).toEqual({ text: "First **real** footnote with `code`.", line: 10 });

		const f2 = extractFootnoteDefinition(md, "note");
		expect(f2).toEqual({ text: "Multi-line\nsecond line\n\nthird paragraph", line: 11 });
		expect(extractFootnoteDefinition(md, "missing")).toBeNull();
	});
});

describe("Round 6 — Governance keys, ISO date & frontmatter validation", () => {
	test("governance and date key sets include controlled-document metadata", () => {
		expect(GOVERNANCE_PROPERTY_KEYS).toContain("version");
		expect(GOVERNANCE_PROPERTY_KEYS).toContain("approved-by");
		expect(GOVERNANCE_PROPERTY_KEYS).toContain("gxp-impact");
		expect(DATE_PROPERTY_KEYS.has("approved-date")).toBe(true);
		expect(DATE_PROPERTY_KEYS.has("effective-date")).toBe(true);
		expect(DATE_PROPERTY_KEYS.has("review-due")).toBe(true);
	});

	test("isValidIsoDate checks real calendar dates including leap years", () => {
		expect(isValidIsoDate("2026-05-14")).toBe(true);
		expect(isValidIsoDate("2024-02-29")).toBe(true);
		expect(isValidIsoDate("2026-02-29")).toBe(false);
		expect(isValidIsoDate("2026-02-30")).toBe(false);
		expect(isValidIsoDate("2026-13-01")).toBe(false);
		expect(isValidIsoDate("05/14/2026")).toBe(false);
		expect(isValidIsoDate("TBD")).toBe(false);
	});

	test("bumpSemanticVersion bumps minor, major, v-prefixed, and 3-part versions", () => {
		expect(bumpSemanticVersion(undefined, "minor")).toBe("1.0");
		expect(bumpSemanticVersion("1.0", "minor")).toBe("1.1");
		expect(bumpSemanticVersion("1.4", "major")).toBe("2.0");
		expect(bumpSemanticVersion("v2.3.1", "minor")).toBe("v2.4.0");
		expect(bumpSemanticVersion("v2.3.1", "major")).toBe("v3.0.0");
	});

	test("validateFrontmatterProperty flags invalid dates, unknown tickets, and missing files", () => {
		const ctx = {
			knownTickets: new Set(["lims-101", "lims-202"]),
			existingFiles: new Set(["/ws/docs/spec.md", "/ws/plans/rollout.md"]),
			workspaceRoot: "/ws",
			docPath: "/ws/docs/guide.md",
		};

		expect(validateFrontmatterProperty("approved-date", "2026-04-15", ctx)).toBeNull();
		expect(validateFrontmatterProperty("review-due", "2026-02-30", ctx)?.kind).toBe("invalid-date");

		expect(validateFrontmatterProperty("ticket", "LIMS-101", ctx)).toBeNull();
		expect(validateFrontmatterProperty("parent", "LIMS-999", ctx)?.kind).toBe("unknown-ticket");
		expect(validateFrontmatterProperty("related", "[[LIMS-999]]", ctx)).toBeNull();

		expect(validateFrontmatterProperty("specs", "docs/spec.md", ctx)).toBeNull();
		expect(validateFrontmatterProperty("specs", "./spec.md", ctx)).toBeNull();
		expect(validateFrontmatterProperty("plans", "plans/missing.md", ctx)?.kind).toBe("missing-file");
		expect(validateFrontmatterProperty("plans", "https://example.com/plan", ctx)).toBeNull();
	});
});
