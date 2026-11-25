// Pass 3 of the Solid 2 / dependency upgrade audit: what the branch or its third round of fixes had broken.
// Each test runs the code it names. What can only be seen in a window (the Explorer's remembered folders, the
// Settings number fields, the per-region error boundaries, the review diff's font) was looked at in the running
// app instead, since these tests have no DOM.
import { afterAll, describe, expect, test } from "bun:test";
import { Text } from "@codemirror/state";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setupProject, undoSetup } from "../src/bun/project";
import { dirs } from "../src/bun/paths";
import { SettingsStore } from "../src/bun/settings";
import { foldsCase, isPathInsideRoot, WorkspaceFiles } from "../src/bun/workspace";
import { lineSegments } from "../src/shared/markdownEdit";

const base = mkdtempSync(join(tmpdir(), "ssl-studio-pass3-"));
afterAll(() => rmSync(base, { recursive: true, force: true }));
const fresh = (name: string) => {
	const dir = join(base, name);
	mkdirSync(dir, { recursive: true });
	return dir;
};
const posix = process.platform !== "win32";
/** Two names that differ only by case are two files here (not so on the usual Windows or macOS volume). */
const caseSensitiveHere = (() => {
	const dir = fresh("case-probe");
	writeFileSync(join(dir, "a.txt"), "lower");
	return !existsSync(join(dir, "A.TXT"));
})();

describe("live Markdown: markup that runs over a line break", () => {
	const doc = Text.of(["See [the docs](https://example.com", '"Example title") for more.']);
	const lineEndAt = (pos: number) => doc.lineAt(pos).to;

	test("a wrapped link's tail is hidden a line at a time, never across the break", () => {
		const text = doc.toString();
		const from = text.indexOf("]");
		const to = text.indexOf(")") + 1;
		const parts = lineSegments(from, to, lineEndAt);
		expect(parts.map(([a, b]) => text.slice(a, b))).toEqual(["](https://example.com", '"Example title")']);
		// What CodeMirror refuses from a plugin ("Decorations that replace line breaks…") is a part with a break in it.
		for (const [a, b] of parts) expect(text.slice(a, b)).not.toContain("\n");
	});

	test("markup on one line is one part, and nothing is no parts", () => {
		expect(lineSegments(4, 5, lineEndAt)).toEqual([[4, 5]]);
		expect(lineSegments(7, 7, lineEndAt)).toEqual([]);
		// Ending exactly at a line's end takes in no break and no empty part after it.
		expect(lineSegments(4, doc.line(1).to, lineEndAt)).toEqual([[4, doc.line(1).to]]);
	});

	test("three lines give three parts, an empty line between them none", () => {
		const three = Text.of(["ab", "", "cd"]);
		expect(lineSegments(0, three.length, (pos) => three.lineAt(pos).to)).toEqual([
			[0, 2],
			[4, 6],
		]);
	});
});

describe("Set up project: checked before the first write", () => {
	test.skipIf(!posix)("an area folder that is a link to a folder elsewhere is left as it is, and Undo takes the rest back", async () => {
		const root = fresh("setup-linked");
		const elsewhere = fresh("setup-linked-elsewhere");
		writeFileSync(join(elsewhere, "Notes.md"), "# Notes\n");
		symlinkSync(elsewhere, join(root, "docs"));

		const preview = await setupProject(root, true);
		expect(preview).not.toContain(join("docs", "INDEX.md"));
		const wrote = await setupProject(root);
		expect(wrote).toEqual(preview);
		expect(wrote).toContain(join(".ssl-studio", "project.toml"));
		expect(wrote).toContain(join("schema", "INDEX.md"));
		// Nothing was written through the link.
		expect(readdirSync(elsewhere)).toEqual(["Notes.md"]);

		const undone = await undoSetup(root);
		expect(undone.removed.sort()).toEqual([...wrote].sort());
		expect(readdirSync(root)).toEqual(["docs"]);
	});

	test.skipIf(!posix)("a link that leads out of the folder to nothing stops the setup before anything is written", async () => {
		const root = fresh("setup-dangling");
		const outside = join(base, "setup-dangling-outside");
		symlinkSync(outside, join(root, "docs"));

		await expect(setupProject(root, true)).rejects.toThrow(/outside the workspace/);
		await expect(setupProject(root)).rejects.toThrow(/outside the workspace/);
		expect(readdirSync(root)).toEqual(["docs"]);
		expect(existsSync(outside)).toBe(false);
		expect(await undoSetup(root)).toEqual({ removed: [], kept: [] });
	});

	test("two areas in one folder are one catalog, in the preview as on disk", async () => {
		const root = fresh("setup-shared-folder");
		mkdirSync(join(root, ".ssl-studio"), { recursive: true });
		writeFileSync(join(root, ".ssl-studio", "project.toml"), '[project]\nname = "P"\n\n[folders]\ncode = "app"\ntests = "app"\n');
		const preview = await setupProject(root, true);
		expect(preview.filter((path) => path === join("app", "INDEX.md"))).toHaveLength(1);
		expect(await setupProject(root)).toEqual(preview);
	});
});

describe("settings files keep the access they had", () => {
	const withDirs = async (run: () => Promise<void>) => {
		const prev = { ...dirs };
		const sandbox = mkdtempSync(join(base, "dirs-"));
		Object.assign(dirs, { config: join(sandbox, "config"), data: join(sandbox, "data"), state: join(sandbox, "state") });
		try {
			await run();
		} finally {
			Object.assign(dirs, prev);
		}
	};
	const modeOf = (path: string) => statSync(path).mode & 0o777;

	test.skipIf(!posix)("a workspace's shared settings.json is not made private by a save", async () => {
		await withDirs(async () => {
			const ws = fresh("mode-existing");
			const file = join(ws, ".ssl-studio", "settings.json");
			mkdirSync(join(ws, ".ssl-studio"), { recursive: true });
			writeFileSync(file, '{"fontSize": 16}\n');
			chmodSync(file, 0o664);
			await new SettingsStore(() => ws).save("workspace", { minimap: true });
			expect(modeOf(file)).toBe(0o664);
		});
	});

	test.skipIf(!posix)("a new workspace file gets what any new file gets; a new file of the user's own is theirs alone", async () => {
		await withDirs(async () => {
			const ws = fresh("mode-new");
			const store = new SettingsStore(() => ws);
			await store.save("workspace", { minimap: true });
			expect(modeOf(join(ws, ".ssl-studio", "settings.json"))).toBe(0o666 & ~process.umask());
			await store.save("user", { fontSize: 15 });
			expect(modeOf(join(dirs.config, "settings.json"))).toBe(0o600);
		});
	});
});

describe("names that differ only by case", () => {
	test.skipIf(!caseSensitiveHere)("renaming onto another file's name that differs by case is refused, not a replacement", async () => {
		const root = fresh("case-rename");
		writeFileSync(join(root, "Report.ssl"), "the file being renamed\n");
		writeFileSync(join(root, "report.ssl"), "another file\n");
		const files = new WorkspaceFiles(root);
		await expect(files.rename(join(root, "Report.ssl"), join(root, "report.ssl"))).rejects.toThrow(/already exists/);
		expect(readdirSync(root).sort()).toEqual(["Report.ssl", "report.ssl"]);
	});

	test.skipIf(!caseSensitiveHere)("a rename that changes only the case of a lone file goes through", async () => {
		const root = fresh("case-rename-lone");
		writeFileSync(join(root, "report.ssl"), "x\n");
		await new WorkspaceFiles(root).rename(join(root, "report.ssl"), join(root, "Report.ssl"));
		expect(readdirSync(root)).toEqual(["Report.ssl"]);
	});

	// macOS can have a case-sensitive volume: there the platform's usual answer is the wrong one, so the folder is
	// asked. This file system is such a volume, seen through a process that says it is on macOS.
	test.skipIf(!caseSensitiveHere || !posix)("on a case-sensitive volume a sibling folder differing by case is outside, whatever the platform", () => {
		const parent = fresh("case-sibling");
		const root = join(parent, "proj");
		const sibling = join(parent, "PROJ");
		mkdirSync(root);
		mkdirSync(sibling);
		writeFileSync(join(sibling, "other.txt"), "a different folder's file\n");
		const real = Object.getOwnPropertyDescriptor(process, "platform")!;
		Object.defineProperty(process, "platform", { ...real, value: "darwin" });
		try {
			expect(foldsCase(root)).toBe(false);
			expect(isPathInsideRoot(root, join(sibling, "other.txt"))).toBe(false);
			expect(() => new WorkspaceFiles(root).inside(join(sibling, "other.txt"))).toThrow(/outside the workspace/);
			// And what is inside still is.
			expect(isPathInsideRoot(root, join(root, "a.ssl"))).toBe(true);
		} finally {
			Object.defineProperty(process, "platform", real);
		}
	});

	test("where the platform compares with case, no folder is asked", () => {
		if (process.platform === "win32" || process.platform === "darwin") return;
		expect(foldsCase(fresh("case-linux"))).toBe(false);
	});
});
