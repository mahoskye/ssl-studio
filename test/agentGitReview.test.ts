import { describe, expect, test } from "bun:test";
import { diffInlineWords, diffMarkdownBlocks, draftCommitMessage, formatTicketChangelog, segmentMarkdownBlocks } from "../src/shared/markdownDiff";
import type { TicketGitCommit } from "../src/shared/protocol";

describe("diffMarkdownBlocks", () => {
	test("handles empty inputs cleanly", () => {
		expect(diffMarkdownBlocks("", "")).toEqual({
			rows: [],
			stats: { same: 0, added: 0, removed: 0, modified: 0 },
		});

		const added = diffMarkdownBlocks("", "# Title\n\nFirst paragraph.");
		expect(added.stats).toEqual({ same: 0, added: 2, removed: 0, modified: 0 });
		expect(added.rows.map((r) => [r.kind, r.blockKind])).toEqual([
			["added", "heading"],
			["added", "paragraph"],
		]);

		const removed = diffMarkdownBlocks("# Title\n\nFirst paragraph.", "");
		expect(removed.stats).toEqual({ same: 0, added: 0, removed: 2, modified: 0 });
		expect(removed.rows.map((r) => [r.kind, r.blockKind])).toEqual([
			["removed", "heading"],
			["removed", "paragraph"],
		]);
	});

	test("marks identical multi-block documents as unchanged", () => {
		const md = [
			"# Rush Due Dates",
			"",
			"Samples marked rush use a 24-hour target.",
			"",
			"- Exclude lab holidays",
			"- Count Saturday shifts",
			"",
			"```ssl",
			":LOCAL dDue := Now();",
			"```",
		].join("\n");
		const res = diffMarkdownBlocks(md, md);
		expect(res.stats).toEqual({ same: 5, added: 0, removed: 0, modified: 0 });
		expect(res.rows.every((r) => r.kind === "same")).toBe(true);
	});

	test("aligns added and removed blocks around unchanged anchors", () => {
		const before = [
			"# Spec",
			"",
			"Intro paragraph.",
			"",
			"Old obsolete note.",
			"",
			"Final paragraph.",
		].join("\n");
		const after = [
			"# Spec",
			"",
			"Intro paragraph.",
			"",
			"## Verification",
			"",
			"New check paragraph.",
			"",
			"Final paragraph.",
		].join("\n");
		const res = diffMarkdownBlocks(before, after);
		expect(res.rows[0]).toMatchObject({ kind: "same", blockKind: "heading" });
		expect(res.rows[1]).toMatchObject({ kind: "same", blockKind: "paragraph" });
		expect(res.rows.at(-1)).toMatchObject({ kind: "same", blockKind: "paragraph", after: "Final paragraph." });
		expect(res.stats.same).toBe(3);
		expect(res.stats.added + res.stats.modified).toBeGreaterThanOrEqual(2);
	});

	test("computes inline word-level <del> and <ins> highlights on modified paragraphs", () => {
		const before = "Samples marked rush use a 24 hour turnaround window.";
		const after = "Samples marked STAT use a 4 hour turnaround window.";
		const res = diffMarkdownBlocks(before, after);
		expect(res.stats).toEqual({ same: 0, added: 0, removed: 0, modified: 1 });
		const row = res.rows[0]!;
		expect(row.kind).toBe("modified");
		expect(row.blockKind).toBe("paragraph");
		expect(row.beforeHighlighted).toContain('<del class="md-diff-del">rush</del>');
		expect(row.beforeHighlighted).toContain('<del class="md-diff-del">24</del>');
		expect(row.afterHighlighted).toContain('<ins class="md-diff-ins">STAT</ins>');
		expect(row.afterHighlighted).toContain('<ins class="md-diff-ins">4</ins>');
		expect(row.afterHighlighted).toContain("turnaround window.");
	});

	test("preserves heading markers outside <del>/<ins> tags", () => {
		const res = diffMarkdownBlocks("## Legacy Due Date Rules", "## Updated Due Date Rules");
		expect(res.stats).toEqual({ same: 0, added: 0, removed: 0, modified: 1 });
		const row = res.rows[0]!;
		expect(row.blockKind).toBe("heading");
		expect(row.beforeHighlighted).toBe('## <del class="md-diff-del">Legacy</del> Due Date Rules');
		expect(row.afterHighlighted).toBe('## <ins class="md-diff-ins">Updated</ins> Due Date Rules');
	});

	test("isolates modified list items and keeps list markers outside highlights", () => {
		const before = "- Keep item one\n- Check old threshold\n- Keep item three";
		const after = "- Keep item one\n- Check new threshold\n- Keep item three";
		const res = diffMarkdownBlocks(before, after);
		expect(res.stats).toEqual({ same: 2, added: 0, removed: 0, modified: 1 });
		const mod = res.rows[1]!;
		expect(mod.blockKind).toBe("list-item");
		expect(mod.beforeHighlighted).toBe('- Check <del class="md-diff-del">old</del> threshold');
		expect(mod.afterHighlighted).toBe('- Check <ins class="md-diff-ins">new</ins> threshold');
	});

	test("highlights fenced code blocks safely as pre-rendered HTML without raw injection", () => {
		const before = "```ssl\n:LOCAL nDays := 3;\n:IF nDays < 5;\n:RETURN nDays;\n```";
		const after = "```ssl\n:LOCAL nDays := 7;\n:IF nDays < 5;\n:RETURN nDays;\n```";
		const res = diffMarkdownBlocks(before, after);
		expect(res.stats).toEqual({ same: 0, added: 0, removed: 0, modified: 1 });
		const row = res.rows[0]!;
		expect(row.blockKind).toBe("code");
		expect(row.preRendered).toBe(true);
		expect(row.beforeHighlighted).toContain('<pre><code class="language-ssl">');
		expect(row.beforeHighlighted).toContain('<del class="md-diff-del">3</del>');
		expect(row.beforeHighlighted).toContain("&lt; 5;");
		expect(row.afterHighlighted).toContain('<ins class="md-diff-ins">7</ins>');
		expect(row.afterHighlighted).toContain("&lt; 5;");
	});

	test("segments and highlights callouts and pipe tables cleanly", () => {
		const before = [
			"> [!NOTE] Holiday table",
			"> Read from HOLIDAYS once per day.",
			"",
			"| Column | Type |",
			"| --- | --- |",
			"| DUE_DT | DATE |",
		].join("\n");
		const after = [
			"> [!NOTE] Holiday table",
			"> Read from LAB_HOLIDAYS once per hour.",
			"",
			"| Column | Type |",
			"| --- | --- |",
			"| DUE_DT | DATETIME |",
		].join("\n");
		const blocks = segmentMarkdownBlocks(before);
		expect(blocks.map((b) => b.kind)).toEqual(["callout", "table"]);

		const res = diffMarkdownBlocks(before, after);
		expect(res.stats).toEqual({ same: 0, added: 0, removed: 0, modified: 2 });
		expect(res.rows[0]!.beforeHighlighted).toContain("> [!NOTE] Holiday table");
		expect(res.rows[0]!.beforeHighlighted).toContain('<del class="md-diff-del">HOLIDAYS</del>');
		expect(res.rows[0]!.afterHighlighted).toContain('<ins class="md-diff-ins">LAB_HOLIDAYS</ins>');
		expect(res.rows[1]!.beforeHighlighted).toContain('| DUE_DT | <del class="md-diff-del">DATE</del> |');
		expect(res.rows[1]!.afterHighlighted).toContain('| DUE_DT | <ins class="md-diff-ins">DATETIME</ins> |');
	});

	test("keeps inline code spans atomic in diffInlineWords", () => {
		const d = diffInlineWords("Call `OldProc` here.", "Call `NewProc` here.");
		expect(d.before).toBe('Call <del class="md-diff-del">`OldProc`</del> here.');
		expect(d.after).toBe('Call <ins class="md-diff-ins">`NewProc`</ins> here.');
	});
});

describe("draftCommitMessage", () => {
	test("returns empty string when nothing is staged", () => {
		expect(draftCommitMessage({ staged: [] })).toBe("");
		expect(draftCommitMessage({ staged: [{ path: "/repo/src/A.ssl", staged: null }] })).toBe("");
	});

	test("drafts single-file added/modified/deleted commit messages with ticket prefix", () => {
		expect(
			draftCommitMessage({
				root: "/repo",
				staged: [{ path: "/repo/src/DueDates/SetDueDates.ssl", staged: "added" }],
				ticketKey: "DEMO-103",
			}),
		).toBe("DEMO-103: Add SetDueDates.ssl");

		expect(
			draftCommitMessage({
				root: "/repo",
				staged: [{ path: "/repo/docs/specs/due-dates.md", staged: "modified" }],
				ticketKey: "DEMO-103",
				ticketTitle: "Rush sample due dates",
			}),
		).toBe("DEMO-103: Update due-dates.md spec (Rush sample due dates)");

		expect(
			draftCommitMessage({
				root: "/repo",
				staged: [{ path: "/repo/src/OldHelper.ssl", staged: "deleted" }],
			}),
		).toBe("Remove OldHelper.ssl");
	});

	test("groups multi-file staged changes cleanly and trims overly long ticket titles", () => {
		const msg = draftCommitMessage({
			root: "/repo",
			staged: [
				{ path: "/repo/src/DueDates/SetDueDates.ssl", staged: "modified" },
				{ path: "/repo/src/DueDates/WorkCalendar.ssl", staged: "modified" },
				{ path: "/repo/docs/specs/due-dates.md", staged: "modified" },
				{ path: "/repo/docs/registries/files.csv", staged: "modified" },
			],
			ticketKey: "LIMS-420",
			ticketTitle: "Calculate rush turnaround times across laboratory holiday calendars and weekend shifts",
		});
		expect(msg.startsWith("LIMS-420: Update 2 SSL scripts, spec, and registry")).toBe(true);
		expect(msg.length).toBeLessThanOrEqual(78);
	});
});

describe("formatTicketChangelog", () => {
	const commits: TicketGitCommit[] = [
		{
			sha: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
			shortSha: "aaaaaaa",
			time: Date.UTC(2026, 10, 22, 15, 30, 0),
			author: "Dev",
			subject: "DEMO-103: Add weekend due-date guard",
			files: [
				{ status: "M", path: "src/DueDates/SetDueDates.ssl" },
				{ status: "M", path: "docs/specs/due-dates.md" },
			],
		},
		{
			sha: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
			shortSha: "bbbbbbb",
			time: Date.UTC(2026, 10, 21, 9, 0, 0),
			author: "Dev",
			subject: "DEMO-103: Draft initial spec and fixtures",
			files: [
				{ status: "A", path: "docs/specs/due-dates.md" },
				{ status: "A", path: "docs/tickets/DEMO-103/sample1.ssl" },
				{ status: "A", path: "docs/tickets/DEMO-103/sample2.ssl" },
				{ status: "A", path: "docs/tickets/DEMO-103/sample3.ssl" },
				{ status: "A", path: "docs/tickets/DEMO-103/sample4.ssl" },
			],
		},
	];

	test("returns empty string for zero commits", () => {
		expect(formatTicketChangelog("DEMO-103", [])).toBe("");
	});

	test("renders clean Markdown bullet list with ISO dates, SHAs, and file cap", () => {
		const md = formatTicketChangelog("DEMO-103", commits, { title: "Rush sample due dates" });
		expect(md).toContain("### DEMO-103 — Rush sample due dates");
		expect(md).toContain("- `aaaaaaa` (2026-11-22) DEMO-103: Add weekend due-date guard — `src/DueDates/SetDueDates.ssl`, `docs/specs/due-dates.md`");
		expect(md).toContain("- `bbbbbbb` (2026-11-21) DEMO-103: Draft initial spec and fixtures");
		expect(md).toContain("+1 more");
	});

	test("falls back to default heading when ticket title is omitted", () => {
		const md = formatTicketChangelog("DEMO-103", [commits[0]!]);
		expect(md.startsWith("### DEMO-103 Changelog\n\n")).toBe(true);
	});
});
