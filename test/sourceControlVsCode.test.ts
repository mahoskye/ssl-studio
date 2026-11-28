import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Git } from "../src/bun/git";
import { TEXT, contrast } from "../src/shared/contrast";
import type { GitFile } from "../src/shared/gitStatus";
import { allOklchThemes } from "../src/shared/oklchTheme";
import { ICON } from "../src/view/icons";
import {
	buildGitFileTree,
	collectGitTreeFolderKeys,
	commitSubjectMetrics,
	formatRelativeCommitTime,
	parseGitDecorations,
} from "../src/view/panels/gitTree";
import dark from "../src/view/themes/studio-dark.json";
import light from "../src/view/themes/studio-light.json";

const read = (rel: string) => readFileSync(resolve(import.meta.dir, "..", rel), "utf8").replace(/\r\n/g, "\n");
const hasGit = spawnSync("git", ["--version"], { stdio: "ignore" }).status === 0;

function parseHex(h: string): [number, number, number] {
	return [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)];
}
function toHex([r, g, b]: [number, number, number]): string {
	return (
		"#" +
		[r, g, b]
			.map((v) => Math.round(Math.max(0, Math.min(255, v))).toString(16).padStart(2, "0"))
			.join("")
	);
}
function mixSrgb(fg: string, pct: number, bg: string): string {
	const a = parseHex(fg);
	const b = parseHex(bg);
	const p = pct / 100;
	return toHex([a[0] * p + b[0] * (1 - p), a[1] * p + b[1] * (1 - p), a[2] * p + b[2] * (1 - p)]);
}

describe("VS Code Source Control — compacted folder tree, subject validation, ref badges & timestamps", () => {
	const mkFile = (relPath: string): { file: GitFile; relPath: string } => ({
		relPath,
		file: { path: `/ws/${relPath}`, staged: null, unstaged: "modified" },
	});

	test("buildGitFileTree compacts single-child folders, sorts folders before files, and rolls up descendant GitFiles", () => {
		const tree = buildGitFileTree(
			[
				mkFile("README.md"),
				mkFile("src/DueDates/WorkCalendar.ssl"),
				mkFile("src/DueDates/DueRules.ssl"),
				mkFile("docs/tickets/DEMO-101/DEMO-101.md"),
			],
			"changes",
		);
		expect(tree.map((n) => [n.kind, n.name])).toEqual([
			["folder", "docs/tickets/DEMO-101"],
			["folder", "src/DueDates"],
			["file", "README.md"],
		]);
		const srcFolder = tree[1]!;
		expect(srcFolder.kind).toBe("folder");
		if (srcFolder.kind === "folder") {
			expect(srcFolder.count).toBe(2);
			expect(srcFolder.files.map((f) => f.path)).toEqual([
				"/ws/src/DueDates/DueRules.ssl",
				"/ws/src/DueDates/WorkCalendar.ssl",
			]);
		}
		expect(collectGitTreeFolderKeys(tree)).toEqual([
			"changes:dir:docs/tickets/DEMO-101",
			"changes:dir:src/DueDates",
		]);
	});

	test("commitSubjectMetrics flags 50-char warning and 72-char overflow on first line only", () => {
		expect(commitSubjectMetrics("Short subject").level).toBe("ok");
		expect(commitSubjectMetrics("a".repeat(50)).level).toBe("ok");
		expect(commitSubjectMetrics("a".repeat(51)).level).toBe("warn");
		expect(commitSubjectMetrics("a".repeat(72)).level).toBe("warn");
		expect(commitSubjectMetrics("a".repeat(73)).level).toBe("over");
		expect(commitSubjectMetrics(`Short subject\n\n${"b".repeat(120)}`).level).toBe("ok");
	});

	test("parseGitDecorations classifies HEAD, local branches, remotes, tags, and skips symbolic remote HEAD", () => {
		expect(parseGitDecorations("HEAD -> main, tag: v1.2.0, origin/main, origin/HEAD -> origin/main, feature/git")).toEqual([
			{ label: "main", kind: "head" },
			{ label: "v1.2.0", kind: "tag" },
			{ label: "origin/main", kind: "remote" },
			{ label: "feature/git", kind: "branch" },
		]);
		expect(parseGitDecorations("HEAD")).toEqual([{ label: "HEAD", kind: "head" }]);
		expect(parseGitDecorations("")).toEqual([]);
	});

	test("formatRelativeCommitTime produces compact VS Code Graph ages", () => {
		const now = Date.UTC(2026, 10, 27, 12, 0, 0);
		expect(formatRelativeCommitTime(now - 20_000, now)).toBe("now");
		expect(formatRelativeCommitTime(now - 5 * 60_000, now)).toBe("5m");
		expect(formatRelativeCommitTime(now - 3 * 3600_000, now)).toBe("3h");
		expect(formatRelativeCommitTime(now - 4 * 86400_000, now)).toBe("4d");
		expect(formatRelativeCommitTime(now - 20 * 86400_000, now)).toBeTruthy();
	});
});

describe.skipIf(!hasGit)("VS Code Source Control — local Git.init() & Git.recentLog() backend", () => {
	test("initializes a repo locally, refuses duplicate init, and reads recent commits with refs, parents & files", async () => {
		const dir = mkdtempSync(join(tmpdir(), "ssl-sc-vscode-"));
		const git = new Git(dir);
		try {
			expect(await git.status()).toBeNull();
			expect(await git.recentLog()).toEqual([]);

			const initRes = await git.init();
			expect(initRes.ok).toBe(true);
			const dupRes = await git.init();
			expect(dupRes.ok).toBe(false);

			const run = (...args: string[]) => {
				const r = spawnSync("git", ["-C", dir, ...args], { encoding: "utf8" });
				if (r.status !== 0) throw new Error(r.stderr || r.stdout);
			};
			run("config", "user.name", "Test Dev");
			run("config", "user.email", "test@example.com");
			mkdirSync(join(dir, "src"), { recursive: true });
			writeFileSync(join(dir, "src", "A.ssl"), ":RETURN 1;\n");
			await git.stage([join(dir, "src", "A.ssl")]);
			await git.commit("DEMO-101: Initial rule");
			run("tag", "v0.1.0");

			writeFileSync(join(dir, "src", "A.ssl"), ":RETURN 2;\n");
			await git.stage([join(dir, "src", "A.ssl")]);
			await git.commit("DEMO-101: Update return value");

			const log = await git.recentLog(10);
			expect(log).toHaveLength(2);
			expect(log[0]!.subject).toBe("DEMO-101: Update return value");
			expect(log[0]!.parents).toHaveLength(1);
			expect(log[0]!.refs.some((r) => r.startsWith("HEAD -> "))).toBe(true);
			expect(log[0]!.files.map((f) => [f.status, f.path])).toEqual([["M", "src/A.ssl"]]);

			expect(log[1]!.subject).toBe("DEMO-101: Initial rule");
			expect(log[1]!.parents).toEqual([]);
			expect(log[1]!.refs).toContain("tag: v0.1.0");
			expect(log[1]!.files.map((f) => [f.status, f.path])).toEqual([["A", "src/A.ssl"]]);
		} finally {
			git.dispose();
			rmSync(dir, { recursive: true, force: true });
		}
	});
});

describe("VS Code Source Control — WCAG AA contrast across all 27 built-in themes", () => {
	test("Commit button, Activity badge, Graph ref pills, and Merge count badge pass WCAG AA (>= 4.5:1)", () => {
		const allThemes = [
			...allOklchThemes().map((t) => ({ name: t.name, s: t.studio })),
			...(
				[
					["Classic Dark", dark],
					["Classic Light", light],
				] as const
			).map(([name, t]) => ({
				name,
				s: {
					sideBg: t.colors["sideBar.background"]!,
					strongFg: t.colors["tab.activeForeground"]!,
					accent: t.colors["focusBorder"]!,
					buttonBg: t.colors["button.background"]!,
					buttonFg: t.colors["button.foreground"]!,
					info: t.colors["editorInfo.foreground"]!,
					warning: t.colors["editorWarning.foreground"]!,
					error: t.colors["editorError.foreground"]!,
				},
			})),
		];
		expect(allThemes.length).toBe(27);

		for (const { name, s } of allThemes) {
			expect(contrast(s.buttonFg, s.buttonBg), `${name} commit/head button`).toBeGreaterThanOrEqual(TEXT);
			expect(contrast(s.strongFg, mixSrgb(s.accent, 16, s.sideBg)), `${name} branch ref badge`).toBeGreaterThanOrEqual(TEXT);
			expect(contrast(s.strongFg, mixSrgb(s.info, 14, s.sideBg)), `${name} remote ref badge`).toBeGreaterThanOrEqual(TEXT);
			expect(contrast(s.strongFg, mixSrgb(s.warning, 16, s.sideBg)), `${name} tag ref badge`).toBeGreaterThanOrEqual(TEXT);
			expect(contrast(s.strongFg, mixSrgb(s.error, 20, s.sideBg)), `${name} merge badge`).toBeGreaterThanOrEqual(TEXT);
		}
	});
});

describe("VS Code Source Control — icons & panel wiring", () => {
	test("Source Control Codicons are registered in icons.ts", () => {
		for (const name of ["git-branch", "git-commit", "git-merge", "repo", "go-to-file", "list-tree", "list-flat", "sparkle"] as const) {
			expect(ICON[name]).toBeTruthy();
		}
	});

	test("Git.tsx wires VS Code header menu, full-width Commit + inline sparkle, Tree/List view, Open File hover action, Merge Changes, Initialize Repository, and Graph accordion", () => {
		const src = read("src/view/panels/Git.tsx");
		expect(src).toContain('class="git-title-actions"');
		expect(src).toContain('class="primary git-commit-btn"');
		expect(src).toContain('class="git-draft-btn"');
		expect(src).toContain('title="Open File"');
		expect(src).toContain('title="Merge Changes"');
		expect(src).toContain('title="Staged Changes"');
		expect(src).toContain('title="Changes"');
		expect(src).toContain("Initialize Repository");
		expect(src).toContain("git-graph-rail");
		expect(src).toContain("moreMenuItems");
		expect(src).toContain("discardMany(");

		const app = read("src/view/App.tsx");
		expect(app).toContain('id === "git" ? badgeText(changedCount())');
		expect(app).toContain('badgeTone={panelBadgeTone(p.id)}');
	});
});
