import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { lineChanges } from "../src/shared/lineDiff";
import {
	diffInlineWords,
	diffMarkdownBlocks,
	diffPlainTextHtml,
	splitTableRow,
} from "../src/shared/markdownDiff";
import { KEEP, LOSE_EDITS, REPLACE, reviewFlow, type Reviewable } from "../src/view/editor/reviewFlow";

const readSrc = (rel: string) => readFileSync(join(import.meta.dir, rel), "utf8").replace(/\r\n/g, "\n");

// =============================================================================
// 1. lineDiff.ts — (a.length + 1) * (b.length + 1) allocation cap
// =============================================================================
describe("lineDiff — exact table cell budget cap", () => {
	test("enforces (a.length + 1) * (b.length + 1) > maxCells so 1 x N never overruns 2x", () => {
		// With maxCells = 6: a.length = 1, b.length = 5 => old a*b = 5 <= 6, but (1+1)*(5+1) = 12 > 6.
		// Must fall back to a single modified block instead of allocating the DP table.
		const before = ["hdr", "old", "ftr"];
		const after = ["hdr", "x1", "x2", "old", "x4", "x5", "ftr"];
		// If DP ran, "old" would match line 4, producing added(2..3) + added(5..6).
		// With the exact (a.length+1)*(b.length+1) > 6 guard, it collapses into one modified block 2..6.
		expect(lineChanges(before, after, 6)).toEqual([{ kind: "modified", line: 2, endLine: 6 }]);
		// With maxCells = 12, (1+1)*(5+1) = 12 <= 12, so exact DP runs and matches "old".
		expect(lineChanges(before, after, 12)).toEqual([
			{ kind: "added", line: 2, endLine: 3 },
			{ kind: "added", line: 5, endLine: 6 },
		]);
	});

	test("handles 1 x 4_000_000 instantly without allocating a 32 MB DP table", () => {
		const before = ["only"];
		const after = new Array<string>(4_000_000).fill("line");
		const t0 = performance.now();
		const res = lineChanges(before, after);
		const elapsed = performance.now() - t0;
		expect(res).toEqual([{ kind: "modified", line: 1, endLine: 4_000_000 }]);
		expect(elapsed).toBeLessThan(200);
	});
});

// =============================================================================
// 2. markdownDiff.ts — lcsAnchors fallback, block pairing, splitTableRow, tokens
// =============================================================================
describe("markdownDiff — lcsAnchors fallback quality & linear performance", () => {
	test("a single moved word does not jump lastJ to EOF and misalign 350 unchanged distinct words", () => {
		const unchanged = Array.from({ length: 350 }, (_, i) => `token${i}`);
		const before = ["MOVED_MARKER", ...unchanged].join(" ");
		const after = [...unchanged, "MOVED_MARKER"].join(" ");

		const d = diffInlineWords(before, after);
		// Every unchanged word must remain untouched (not wrapped in <del>/<ins>).
		expect(d.before).toContain('<del class="md-diff-del">MOVED_MARKER</del>');
		expect(d.after).toContain('<ins class="md-diff-ins">MOVED_MARKER</ins>');
		expect(d.before.match(/<del /g)?.length).toBe(1);
		expect(d.after.match(/<ins /g)?.length).toBe(1);
		expect(d.before).toContain("token0 token1 token2");
		expect(d.before).toContain("token348 token349");
		expect(d.after).toContain("token0 token1 token2");
		expect(d.after).toContain("token348 token349");
	});

	test("a single moved word does not misalign 350 unchanged repeated words", () => {
		const unchanged = Array.from({ length: 350 }, () => "sample");
		const before = ["MOVED_MARKER", ...unchanged].join(" ");
		const after = [...unchanged, "MOVED_MARKER"].join(" ");

		const d = diffInlineWords(before, after);
		expect(d.before).toContain('<del class="md-diff-del">MOVED_MARKER</del>');
		expect(d.after).toContain('<ins class="md-diff-ins">MOVED_MARKER</ins>');
		expect(d.before.match(/<del /g)?.length).toBe(1);
		expect(d.after.match(/<ins /g)?.length).toBe(1);
	});

	test("runs in fast linear time on 15,000+ repeated and distinct tokens", () => {
		// 7,500 words + 7,499 spaces = ~15,000 tokens
		const repeatedA = Array.from({ length: 7500 }, (_, i) => (i === 1200 ? "OLDVAL" : i % 3 === 0 ? "alpha" : "beta"));
		const repeatedB = Array.from({ length: 7500 }, (_, i) => (i === 1200 ? "NEWVAL" : i % 3 === 0 ? "alpha" : "beta"));
		const t0 = performance.now();
		const resRep = diffInlineWords(repeatedA.join(" "), repeatedB.join(" "));
		const elapsedRep = performance.now() - t0;
		expect(resRep.before).toContain('<del class="md-diff-del">OLDVAL</del>');
		expect(resRep.after).toContain('<ins class="md-diff-ins">NEWVAL</ins>');
		expect(elapsedRep).toBeLessThan(100);

		// 7,500 distinct words + 7,499 spaces = ~15,000 tokens with a moved marker
		const distinct = Array.from({ length: 7500 }, (_, i) => `w${i}`);
		const t1 = performance.now();
		const resDist = diffInlineWords(["MOVED", ...distinct].join(" "), [...distinct, "MOVED"].join(" "));
		const elapsedDist = performance.now() - t1;
		expect(resDist.before.match(/<del /g)?.length).toBe(1);
		expect(resDist.after.match(/<ins /g)?.length).toBe(1);
		expect(elapsedDist).toBeLessThan(100);
	});
});

describe("markdownDiff — diffMarkdownBlocks performance & tie-breaking", () => {
	test("diffs 800 changed blocks swiftly without quadratic freeze", () => {
		const before = Array.from({ length: 800 }, (_, i) => `Paragraph ${i} describing sample due date rule alpha${i} old`).join("\n\n");
		const after = Array.from({ length: 800 }, (_, i) => `Paragraph ${i} describing sample due date rule alpha${i} new`).join("\n\n");

		const t0 = performance.now();
		const res = diffMarkdownBlocks(before, after);
		const elapsed = performance.now() - t0;

		expect(res.stats.modified).toBe(800);
		expect(res.stats.added).toBe(0);
		expect(res.stats.removed).toBe(0);
		expect(elapsed).toBeLessThan(250);
	});

	test("breaks equal-score block similarity ties in favor of the earliest matching block", () => {
		// Left has 1 modified paragraph; right has 2 distinct paragraphs with identical similarity to left[0].
		const before = ["Anchor start.", "Check rush sample timing policy old.", "Anchor end."].join("\n\n");
		const after = [
			"Anchor start.",
			"Check rush sample timing policy first.",
			"Check rush sample timing policy second.",
			"Anchor end.",
		].join("\n\n");

		const res = diffMarkdownBlocks(before, after);
		const middle = res.rows.slice(1, -1);
		expect(middle.map((r) => r.kind)).toEqual(["modified", "added"]);
		expect(middle[0]!.after).toBe("Check rush sample timing policy first.");
		expect(middle[1]!.after).toBe("Check rush sample timing policy second.");
	});

	test("pairs blocks meeting the exact 0.25 similarity threshold and skips blocks below 0.25", () => {
		// 1 shared word out of (4 + 4) => Dice = 2*1/8 = 0.25 -> must pair as modified.
		const beforeAt = ["A.", "shared one two three", "shared four five six", "Z."].join("\n\n");
		const afterAt = ["A.", "shared alpha beta gamma", "shared delta epsilon zeta", "Z."].join("\n\n");
		const resAt = diffMarkdownBlocks(beforeAt, afterAt);
		expect(resAt.stats.modified).toBe(2);

		// 1 shared word out of (5 + 5) => Dice = 2*1/10 = 0.20 < 0.25 -> must not pair.
		const beforeLow = ["A.", "shared a1 a2 a3 a4", "other b1 b2 b3 b4", "Z."].join("\n\n");
		const afterLow = ["A.", "shared c1 c2 c3 c4", "extra d1 d2 d3 d4", "Z."].join("\n\n");
		const resLow = diffMarkdownBlocks(beforeLow, afterLow);
		expect(resLow.stats.modified).toBe(0);
		expect(resLow.stats.removed).toBe(2);
		expect(resLow.stats.added).toBe(2);
	});
});

describe("markdownDiff — splitTableRow escaping & inline code spans", () => {
	test("respects \\| escaped pipes with even-backslash parity", () => {
		expect(splitTableRow("| A \\| B | C |")).toEqual(["A \\| B", "C"]);
		expect(splitTableRow("| A \\\\| B |")).toEqual(["A \\\\", "B"]);
		expect(splitTableRow("| A \\\\\\| B | C |")).toEqual(["A \\\\\\| B", "C"]);
		expect(splitTableRow("| A | B \\|")).toEqual(["A", "B \\|"]);
		expect(splitTableRow("| A | B \\\\|")).toEqual(["A", "B \\\\"]);
	});

	test("keeps pipes inside single-backtick and multi-backtick inline code spans intact", () => {
		expect(splitTableRow("| `a | b` | ``c | d`` | plain |")).toEqual(["`a | b`", "``c | d``", "plain"]);
		expect(splitTableRow("| `x|` | y")).toEqual(["`x|`", "y"]);
		expect(splitTableRow("| \\`not code | split |")).toEqual(["\\`not code", "split"]);
		expect(splitTableRow("| unclosed `tick | next |")).toEqual(["unclosed `tick", "next"]);
	});

	test("preserves columns when diffing pipe tables containing escaped and backticked pipes", () => {
		const before = ["| Expr | Note |", "| --- | --- |", "| `a | b` | old \\| val |"].join("\n");
		const after = ["| Expr | Note |", "| --- | --- |", "| `a | b` | new \\| val |"].join("\n");
		const res = diffMarkdownBlocks(before, after);
		expect(res.stats.modified).toBe(1);
		expect(res.rows[0]!.beforeHighlighted).toContain('| `a | b` | <del class="md-diff-del">old</del> \\| val |');
		expect(res.rows[0]!.afterHighlighted).toContain('| `a | b` | <ins class="md-diff-ins">new</ins> \\| val |');
	});
});

describe("markdownDiff — atomic multi-backtick code spans & autolinks", () => {
	test("keeps multi-backtick inline code spans atomic so <del>/<ins> never splits them", () => {
		const d2 = diffInlineWords("Use ``foo `bar` baz`` here.", "Use ``foo `qux` baz`` here.");
		expect(d2.before).toBe('Use <del class="md-diff-del">``foo `bar` baz``</del> here.');
		expect(d2.after).toBe('Use <ins class="md-diff-ins">``foo `qux` baz``</ins> here.');

		const d3 = diffInlineWords("Run ```a `` b``` now.", "Run ```a `` c``` now.");
		expect(d3.before).toBe('Run <del class="md-diff-del">```a `` b```</del> now.');
		expect(d3.after).toBe('Run <ins class="md-diff-ins">```a `` c```</ins> now.');
	});

	test("keeps <https://...> and <mailto:...> autolinks atomic so <del>/<ins> never corrupts URLs", () => {
		const d = diffInlineWords("See <https://example.com/v1/spec> for details.", "See <https://example.com/v2/spec> for details.");
		expect(d.before).toBe('See <del class="md-diff-del"><https://example.com/v1/spec></del> for details.');
		expect(d.after).toBe('See <ins class="md-diff-ins"><https://example.com/v2/spec></ins> for details.');

		const mail = diffInlineWords("Contact <mailto:old@example.test>.", "Contact <mailto:new@example.test>.");
		expect(mail.before).toBe('Contact <del class="md-diff-del"><mailto:old@example.test></del>.');
		expect(mail.after).toBe('Contact <ins class="md-diff-ins"><mailto:new@example.test></ins>.');
	});
});

// =============================================================================
// 3. Frontmatter raw-diff HTML escaping (no broken `&<del>lt</del>;`)
// =============================================================================
describe("diffPlainTextHtml — raw frontmatter diff without HTML entity corruption", () => {
	test("diffs raw characters first and HTML-escapes inside spans so entities are never split", () => {
		const before = '---\ntitle: A < B & "old"\nstatus: draft\n---';
		const after = '---\ntitle: A > B & "new"\nstatus: approved\n---';

		const res = diffPlainTextHtml(before, after);
		expect(res.before).toContain('title: A <del class="md-diff-del">&lt;</del> B &amp; &quot;<del class="md-diff-del">old</del>&quot;');
		expect(res.after).toContain('title: A <ins class="md-diff-ins">&gt;</ins> B &amp; &quot;<ins class="md-diff-ins">new</ins>&quot;');
		expect(res.before).not.toContain("&<del");
		expect(res.after).not.toContain("&<ins");
		expect(res.before).toContain('status: <del class="md-diff-del">draft</del>');
		expect(res.after).toContain('status: <ins class="md-diff-ins">approved</ins>');
	});

	test("escapes HTML special characters in added and removed lines", () => {
		const res = diffPlainTextHtml("a: <script>", "b: <img src=x>");
		expect(res.before).not.toContain("<script>");
		expect(res.after).not.toContain("<img");
		expect(res.before).toContain("&lt;");
		expect(res.after).toContain("&lt;");
	});
});

// =============================================================================
// 4. reviewFlow — replaceable queue, reject() re-entry, force close()
// =============================================================================
describe("reviewFlow — replaceable queue, reject re-entry, and force close", () => {
	type TestReview = Reviewable & { compare?: { left: string; right: string }; rejected: number };

	function makeFlow(opts: { choose?: (title: string, buttons: string[]) => Promise<string | null> } = {}) {
		let current: TestReview | null = null;
		const asked: string[] = [];
		const failures: string[] = [];
		const flow = reviewFlow<TestReview>({
			current: () => current,
			show: (r) => (current = r),
			choose: async (title, buttons) => {
				asked.push(title);
				return opts.choose ? opts.choose(title, buttons) : null;
			},
			fail: (text) => failures.push(text),
			replaceable: (r) => Boolean(r.replaceable || r.compare),
		});
		const mk = (title: string, extra: Partial<TestReview> = {}): TestReview => {
			const r: TestReview = {
				title,
				rejected: 0,
				onAccept: async () => {},
				onReject: () => void r.rejected++,
				...extra,
			};
			return r;
		};
		return { flow, asked, failures, current: () => current, mk };
	}

	test("rapid queued comparison switches replace cleanly without ever prompting 'Replace it?'", async () => {
		const s = makeFlow();
		const c1 = s.mk("a.ssl: changed", { replaceable: true });
		const c2 = s.mk("b.ssl: changed", { compare: { left: "HEAD", right: "Now" } });
		const c3 = s.mk("c.ssl: changed", { replaceable: true });

		// Fire all three in the same synchronous tick before the queue microtask runs.
		const [r1, r2, r3] = await Promise.all([s.flow.open(c1), s.flow.open(c2), s.flow.open(c3)]);
		expect([r1, r2, r3]).toEqual([true, true, true]);
		expect(s.asked).toEqual([]);
		expect(s.current()).toBe(c3);
		expect(c1.rejected).toBe(1);
		expect(c2.rejected).toBe(1);
		expect(c3.rejected).toBe(0);
	});

	test("opening a comparison while an actionable review is open still prompts before replacing", async () => {
		const s = makeFlow({ choose: async () => KEEP });
		const actionable = s.mk("Tidy 1/6");
		const cmp = s.mk("a.ssl: diff", { replaceable: true });

		expect(await s.flow.open(actionable)).toBe(true);
		expect(await s.flow.open(cmp)).toBe(false);
		expect(s.asked).toHaveLength(1);
		expect(s.current()).toBe(actionable);
		expect(actionable.rejected).toBe(0);

		const s2 = makeFlow({ choose: async () => REPLACE });
		const a2 = s2.mk("Tidy 1/6");
		const cmp2 = s2.mk("a.ssl: diff", { replaceable: true });
		await s2.flow.open(a2);
		expect(await s2.flow.open(cmp2)).toBe(true);
		expect(s2.current()).toBe(cmp2);
		expect(a2.rejected).toBe(1);
	});

	test("reject() re-entry guard prevents stacking duplicate edit-loss modals on double-click / double-Esc", async () => {
		let resolvePrompt!: (ans: string | null) => void;
		const s = makeFlow({
			choose: () =>
				new Promise<string | null>((resolve) => {
					resolvePrompt = resolve;
				}),
		});
		const r = s.mk("Proposal");
		await s.flow.open(r);

		// First reject opens the confirmation modal; second concurrent reject must bail without prompting again.
		const first = s.flow.reject(r, true);
		const second = s.flow.reject(r, true);
		expect(await second).toBe(false);
		expect(s.asked).toHaveLength(1);

		// Concurrent accept while reject confirmation is open is also rejected.
		expect(await s.flow.accept(r, "edited")).toBe("It is being rejected.");

		// User keeps reviewing -> guard clears so a later reject works normally.
		resolvePrompt(KEEP);
		expect(await first).toBe(false);
		expect(s.current()).toBe(r);
		expect(r.rejected).toBe(0);

		const third = s.flow.reject(r, true);
		expect(s.asked).toHaveLength(2);
		resolvePrompt(LOSE_EDITS);
		expect(await third).toBe(true);
		expect(s.current()).toBeNull();
		expect(r.rejected).toBe(1);
	});

	test("close() force-closes an open review without prompting and notifies onReject", async () => {
		const s = makeFlow();
		const r = s.mk("Open Agent Proposal");
		await s.flow.open(r);
		s.flow.close();
		expect(s.current()).toBeNull();
		expect(r.rejected).toBe(1);
		expect(s.asked).toEqual([]);
		// Calling close() when idle is a no-op.
		s.flow.close();
		expect(r.rejected).toBe(1);
	});
});

// =============================================================================
// 5. Frontend repair regression contracts (Git, History, Review, TabStrip, State, Commands)
// =============================================================================
describe("Round 6B frontend repair regression guards", () => {
	test("Git.tsx 'Stage all' skips conflicted files and notifies the user", () => {
		const src = readSrc("../src/view/panels/Git.tsx");
		expect(src).toContain('all.filter((f) => f.unstaged !== "conflict")');
		expect(src).toContain("onClick={() => void stageAll()}");
		expect(src).not.toContain("onClick={() => void stage(changes())}");
		expect(src).toContain("conflicted file");
	});

	test("Git.tsx handles subdirectory commits (inWorkspace === false), make() try/finally, and workspace message reset", () => {
		const src = readSrc("../src/view/panels/Git.tsx");
		expect(src).toContain("f.inWorkspace === false");
		expect(src).toContain("backend.gitCommitFile(targetPath, commitItem.sha, repoPath)");
		expect(src).toContain("const req = ++commitDiffReq");
		expect(src).toContain("finally {\n\t\t\tsetBusy(false);");
		expect(src).toContain("message() === submitted");
		expect(src).toContain("if (root !== messageRoot)");
	});

	test("git.ts handles renamed unstage, workspace-switch stale status, binary showChange, discard revert+historyChanged, and stage toast ordering", () => {
		const src = readSrc("../src/view/git.ts");
		expect(src).toContain("if (file.from && (!root || isInside(root, file.from))) add(file.from)");
		expect(src).toContain("statusRoot = undefined;");
		expect(src).toContain("if (statusRoot !== root) setStatus(undefined);");
		expect(src).toContain("if (open?.binary) return notify");
		expect(src).toContain("const req = ++showingChange");
		expect(src).toContain("await revert(canon)");
		expect(src).toContain("historyChanged.fire(canon)");
		expect(src).toContain("if (!onDisk) {\n\t\tfileRemoved(file.path);");
		// Unsaved-changes toast must be inside the .then() success callback, not after the promise settles.
		const stageBlock = src.slice(src.indexOf("export async function stage("), src.indexOf("export function unstagePaths("));
		expect(stageBlock).toContain(".then(\n\t\tasync () => {");
		expect(stageBlock.indexOf("unsaved changes: what is staged is what is saved.")).toBeLessThan(stageBlock.indexOf('failed("Not staged")'));
	});

	test("History.tsx guards untitled/outside-workspace, binary buffers, docVersion drift, and applyText false return", () => {
		const src = readSrc("../src/view/panels/History.tsx");
		expect(src).toContain('!path.startsWith("untitled:") && Boolean(root && isInside(root, path))');
		expect(src).toContain("if (doc.binary) return notify");
		expect(src).toContain("const docVersion = doc.model.getVersionId()");
		expect(src).toContain("if (doc.model.getVersionId() !== docVersion)");
		expect(src).toContain("if (!applyText(path, restored))");
		expect(src).toContain("activePath() !== path || doc.model.isDisposed()");
	});

	test("Review.tsx hardens DOMPurify, preserves CRLF onMount, diffs raw frontmatter, and guards reject() re-entry", () => {
		const src = readSrc("../src/view/editor/Review.tsx");
		for (const tag of ["script", "style", "iframe", "img", "picture", "source", "video", "audio", "svg", "math", "canvas", "dialog", "area", "track"]) {
			expect(src).toContain(`"${tag}"`);
		}
		for (const attr of ["style", "background", "poster", "src", "srcset", "ping", "action", "formaction", "popover", "popovertarget", "command", "commandfor"]) {
			expect(src).toContain(`"${attr}"`);
		}
		expect(src).toContain("ALLOW_DATA_ATTR: false");
		expect(src).toContain('if (r.original.includes("\\n")) proposed.setEOL(original.getEndOfLineSequence())');
		expect(src).toContain("diffPlainTextHtml(fmBeforeRaw, fmAfterRaw)");
		expect(src).not.toContain("diffInlineWords(escapeHtmlText");
		expect(src).toContain("export const closeReview = () => flow.close()");
		expect(src).toContain("const [rejecting, setRejecting] = createSignal(false)");
	});

	test("state.ts, CenterTabStrip.tsx, and commands.ts hooks are wired cleanly", () => {
		const stateSrc = readSrc("../src/view/state.ts");
		expect(stateSrc).toContain("closeReview();");
		expect(stateSrc).toContain("syncWorkspaceThreads(canonical(workspace.root));");
		expect(stateSrc).toContain("export function applyText(path: string, text: string): boolean");
		expect(stateSrc).toContain("if (!doc || doc.model.isDisposed()) return false;");

		const tabStripSrc = readSrc("../src/view/editor/CenterTabStrip.tsx");
		expect(tabStripSrc).toContain("Accept or reject the open review before closing this file.");
		expect(tabStripSrc).toContain("tryCloseTab(path, state.activeGroup)");

		const cmdSrc = readSrc("../src/view/commands.ts");
		expect(cmdSrc).toContain("backend.gitCommitFile(p, blame.sha, blame.filename)");
	});
});
