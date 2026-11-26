// Five low findings of the pass 4 audit that were on main before this branch: two in the Search panel, three in
// git and local history.
//
// 1. "Find in folder…" after the Code scope kept the Code scope's list of what to leave out: a search of the
//    documents' folder found nothing.
// 2. The question before "Replace all" did not name the text that is replaced, and that text could be another
//    than the one in the search box (a new one typed, Enter not pressed).
// 3. A folder that became a repository after it was opened stayed "not in a git repository" until the app was
//    started again, and one whose `.git` was removed stayed a repository.
// 4. A discard and a replace across files say that the file as it was is kept in local history. A text over 2 MB
//    was not kept, and nothing said so.
// 5. A folder with a repository of its own was listed as one new file, and "Move to trash" on it took the folder.
//
// git and local history are run here as they are: a real git, in repositories made for the test, and the real
// backend on real folders. The panels are not mounted (they need a DOM and the real Monaco): what they decide is
// in functions that are run here, and how the panels call them is held by their source text, in the blocks that
// say so. The backend's side of item 4 is in src/bun/backend.ts, which is another's to change: its tests run once
// that file keeps the copy with `History.keep`, and are passed over until then.
import { afterAll, beforeAll, describe, expect, spyOn, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createBackend, type Host } from "../src/bun/backend";
import { Git, holdsOwnRepository, nearestDotGit } from "../src/bun/git";
import { copyNotKept, History, MAX_SNAPSHOT_BYTES } from "../src/bun/history";
import { dirs } from "../src/bun/paths";
import { WorkspaceFiles } from "../src/bun/workspace";
import { folderPattern } from "../src/shared/fileGlob";
import { folderScope, replacePreviewTitle, replaceQuestion, searchBoxMoved, searchedWords } from "../src/shared/searchPattern";

const base = mkdtempSync(join(tmpdir(), "ssl-studio-p4ml-search-git-"));
afterAll(() => rmSync(base, { recursive: true, force: true }));
const fresh = (name: string) => {
	const dir = join(base, name);
	mkdirSync(dir, { recursive: true });
	return dir;
};
const readSrc = (rel: string) => readFileSync(join(import.meta.dir, "..", rel), "utf8").replace(/\r\n/g, "\n");
const between = (text: string, from: string, to: string) => {
	const start = text.indexOf(from);
	const end = text.indexOf(to, start + from.length);
	if (start < 0 || end < 0) throw new Error(`not found: ${start < 0 ? from : to}`);
	return text.slice(start, end);
};

/** A host that keeps what it was asked to send to the trash, and sends nothing there. */
function hostOf() {
	const trashed: string[] = [];
	const host: Host = { app: "test", kind: "browser", pick: async () => null, trash: async (path) => void trashed.push(path), emit: () => {}, quit: () => {} };
	return { host, trashed };
}

/** The app's own folders somewhere of the test's, for as long as the work takes. */
async function withDirs<T>(name: string, work: (d: { data: string }) => Promise<T>): Promise<T> {
	const before = { ...dirs };
	const sandbox = fresh(name);
	Object.assign(dirs, { config: join(sandbox, "config"), data: join(sandbox, "data"), state: join(sandbox, "state") });
	try {
		return await work({ data: dirs.data });
	} finally {
		Object.assign(dirs, before);
	}
}

// A real git, with the test's own name on its commits and none of the user's settings.
const hasGit = (() => {
	try {
		return Bun.spawnSync(["git", "--version"]).exitCode === 0;
	} catch {
		return false;
	}
})();
const gitSettings = join(fresh("gitconfig"), "config");
writeFileSync(gitSettings, "");
const identity = { GIT_AUTHOR_NAME: "Test", GIT_AUTHOR_EMAIL: "test@example.test", GIT_COMMITTER_NAME: "Test", GIT_COMMITTER_EMAIL: "test@example.test", GIT_CONFIG_GLOBAL: gitSettings, GIT_CONFIG_NOSYSTEM: "1" };
// The app's own git is run with the process's settings, so they are set for this file's tests and put back after.
const envBefore = Object.fromEntries(Object.keys(identity).map((name) => [name, process.env[name]]));
beforeAll(() => void Object.assign(process.env, identity));
afterAll(() => {
	for (const [name, value] of Object.entries(envBefore)) {
		if (value === undefined) delete process.env[name];
		else process.env[name] = value;
	}
});

/** git as a terminal runs it, in a folder. */
function gitIn(folder: string) {
	return (...args: string[]) => {
		const ran = Bun.spawnSync(["git", "-C", folder, ...args], { env: { ...process.env, ...identity } });
		if (ran.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${ran.stderr.toString()}`);
		return ran.stdout.toString();
	};
}

/** Makes a folder a repository, as `git init` in a terminal does. */
function init(folder: string) {
	mkdirSync(folder, { recursive: true });
	const git = gitIn(folder);
	git("init", "-q");
	git("symbolic-ref", "HEAD", "refs/heads/main");
	git("config", "core.autocrlf", "false");
	git("config", "commit.gpgsign", "false");
	return git;
}

/** How many times git was started while the work ran. */
async function gitStarts(work: () => Promise<unknown>): Promise<number> {
	const starts = spyOn(Bun, "spawn");
	try {
		await work();
		return (starts.mock.calls as unknown as [string[]][]).filter(([command]) => command[0] === "git").length;
	} finally {
		starts.mockRestore();
	}
}

const inFolder = (root: string, path: string) => path.slice(root.length + 1).split("\\").join("/");

// ---------------------------------------------------------------------------------------------------------------
// 1. "Find in folder…" searches the folder
// ---------------------------------------------------------------------------------------------------------------

describe("1. Find in folder: the folder is what is searched, whatever scope was chosen before", () => {
	/** What the Code scope leaves out, in a project with the usual folders (Search.tsx, `codeExcludeGlob`). */
	const codeLeavesOut = [folderPattern("docs"), folderPattern("design"), folderPattern("schema"), "README.md", "AGENTS.md", "**/INDEX.md"].join(", ");

	test("the scope of a folder is that folder, with nothing left out", () => {
		expect(folderScope("docs")).toEqual({ include: "docs/**", exclude: "" });
		expect(folderScope("docs/tickets")).toEqual({ include: "docs/tickets/**", exclude: "" });
		// The folder as Windows spells it, and one whose name opens with a dot or holds a comma: a name, not a pattern.
		expect(folderScope("docs\\tickets")).toEqual({ include: folderPattern("docs/tickets"), exclude: "" });
		expect(folderScope(".github")).toEqual({ include: folderPattern(".github"), exclude: "" });
		expect(folderScope("a,b").include).toBe(folderPattern("a,b"));
		// The workspace's own folder needs no pattern: every file, and still nothing left out.
		expect(folderScope("")).toEqual({ include: "", exclude: "" });
		expect(folderScope(".")).toEqual({ include: "", exclude: "" });
	});

	test("a search of the documents' folder finds what is in it; with the Code scope's list left standing it found nothing", async () => {
		const root = fresh("find-in-folder");
		for (const [name, text] of [
			["docs/tickets/ABC-1.md", "# ABC-1\n\nThe due date is worked out by DueDate.\n"],
			["docs/INDEX.md", "- ABC-1: DueDate\n"],
			["design/due.plan.json", '{ "name": "DueDate" }\n'],
			["schema/tables.md", "| SAMPLES | DueDate |\n"],
			["src/DueDate.ssl", ":PROCEDURE DueDate;\n:RETURN 1;\n:ENDPROC;\n"],
		] as const) {
			mkdirSync(join(root, name, ".."), { recursive: true });
			writeFileSync(join(root, name), text);
		}
		const files = new WorkspaceFiles(root);
		const found = async (include: string, exclude: string) => [...new Set((await files.searchScan("DueDate", { ...(include ? { include } : {}), ...(exclude ? { exclude } : {}) })).hits.map((hit) => inFolder(root, hit.path)))].sort();
		try {
			// What the boxes held before: the folder to look in, and what the Code scope leaves out, still there.
			expect(await found(folderPattern("docs"), codeLeavesOut)).toEqual([]);
			expect(await found(folderPattern("design"), codeLeavesOut)).toEqual([]);
			expect(await found(folderPattern("schema"), codeLeavesOut)).toEqual([]);
			// What they hold now.
			const docs = folderScope("docs");
			expect(await found(docs.include, docs.exclude)).toEqual(["docs/INDEX.md", "docs/tickets/ABC-1.md"]);
			const design = folderScope("design");
			expect(await found(design.include, design.exclude)).toEqual(["design/due.plan.json"]);
			const schema = folderScope("schema");
			expect(await found(schema.include, schema.exclude)).toEqual(["schema/tables.md"]);
			// A code folder was found before too, and still is.
			expect(await found(folderPattern("src"), codeLeavesOut)).toEqual(["src/DueDate.ssl"]);
			const src = folderScope("src");
			expect(await found(src.include, src.exclude)).toEqual(["src/DueDate.ssl"]);
		} finally {
			files.close();
		}
	});

	test("the panel sets both boxes from it, and shows them (source only: the panel needs a DOM to run)", () => {
		const find = between(readSrc("src/view/panels/Search.tsx"), "export function findInFolder(relFolder: string) {", "/** Shows the Search panel with its row for replacing open. */");
		expect(find).toContain("const scope = folderScope(relFolder);");
		expect(find).toContain("setInclude(scope.include);");
		expect(find).toContain("setExclude(scope.exclude);");
		expect(find).toContain("setTicketScopeKey(null);");
		expect(find).toContain("setChoosing(true);");
	});
});

// ---------------------------------------------------------------------------------------------------------------
// 2. The question before a replace names what is replaced
// ---------------------------------------------------------------------------------------------------------------

describe("2. Replace all: what is replaced is named, and is the text in the search box", () => {
	const kept = "Each file that is written is first kept as it was in its local history.";

	test("the question names the text that was searched, what it becomes, and in how much", () => {
		expect(replaceQuestion({ query: "sName", replacement: "sTitle", matches: 3, files: 2 })).toBe(`Replace 3 matches of “sName” in 2 files with “sTitle”? ${kept}`);
		expect(replaceQuestion({ query: "sName", replacement: "sTitle", matches: 1, files: 1 })).toBe(`Replace 1 match of “sName” in 1 file with “sTitle”? ${kept}`);
		// Replaced with nothing is said, not shown as two quotes with nothing between.
		expect(replaceQuestion({ query: "sName", replacement: "", matches: 2, files: 1 })).toBe(`Replace 2 matches of “sName” in 1 file with nothing? ${kept}`);
		expect(replaceQuestion({ query: "sName", replacement: "sTitle", matches: 3, files: 2, safeDocs: true })).toBe(
			`Replace 3 matches of “sName” in 2 files with “sTitle”? ${kept} Safe docs skips YAML keys, Markdown link targets, and invalid .plan.json edits.`,
		);
	});

	test("it says how the text was searched: as a regular expression, and with which switches", () => {
		expect(searchedWords("sName")).toBe("“sName”");
		expect(searchedWords("sName", { caseSensitive: true })).toBe("“sName” (match case)");
		expect(searchedWords("sName", { wholeWord: true })).toBe("“sName” (whole word)");
		expect(searchedWords("s(Name|Title)", { regex: true })).toBe("the regular expression “s(Name|Title)”");
		expect(searchedWords("s(Name|Title)", { regex: true, caseSensitive: true, wholeWord: true })).toBe("the regular expression “s(Name|Title)” (match case, whole word)");
		expect(replaceQuestion({ query: "s(Name|Title)", regex: true, caseSensitive: true, wholeWord: true, replacement: "s$1Text", matches: 4, files: 2 })).toBe(
			`Replace 4 matches of the regular expression “s(Name|Title)” (match case, whole word) in 2 files with “s$1Text”? ${kept}`,
		);
		// The text as it was searched, blanks and all: two searches that differ in a blank are told apart.
		expect(searchedWords(" sName ")).toBe("“ sName ”");
	});

	test("a text longer than a question can hold is cut in its middle, and both its ends are shown", () => {
		const long = `START${"x".repeat(400)}END`;
		const said = searchedWords(long);
		expect(said.length).toBeLessThan(130);
		expect(said).toStartWith("“START");
		expect(said).toEndWith("END”");
		expect(said).toContain(" … ");
		const question = replaceQuestion({ query: "sName", replacement: long, matches: 1, files: 1 });
		expect(question.length).toBeLessThan(260);
		expect(question).toContain("with “START");
		// One that fits is whole.
		expect(searchedWords("x".repeat(120))).toBe(`“${"x".repeat(120)}”`);
	});

	test("the preview, from which the replace is made with no further question, names it too", () => {
		expect(replacePreviewTitle({ query: "sName", replacement: "sTitle", matches: 3, files: 2 })).toBe("Replace preview: “sName” becomes “sTitle”, 3 matches in 2 files");
		expect(replacePreviewTitle({ query: "s(Name)", regex: true, caseSensitive: true, replacement: "", matches: 1, files: 1 })).toBe("Replace preview: the regular expression “s(Name)” (match case) becomes nothing, 1 match in 1 file");
	});

	test("with another text in the box than the one that was searched, nothing is replaced, and why is said", () => {
		expect(searchBoxMoved("sName", "sName")).toBe("");
		expect(searchBoxMoved("sName", "sTitle")).toBe("What is listed was found for “sName”, and the search box holds another text now: press Enter in it to search again first");
		// An emptied box, and a text that differs in a blank or in its case, are other texts.
		expect(searchBoxMoved("sName", "")).toContain("found for “sName”");
		expect(searchBoxMoved("sName", "sName ")).not.toBe("");
		expect(searchBoxMoved("sName", "sname")).not.toBe("");
		// The filters of a search are part of what was typed: the box is held to all of it.
		expect(searchBoxMoved("tag:lims sName", "tag:lims sName")).toBe("");
		expect(searchBoxMoved("tag:lims sName", "sName")).not.toBe("");
	});

	test("the panel refuses on it, asks with the question, and searches again for what it replaced (source only)", () => {
		const src = readSrc("src/view/panels/Search.tsx");
		// The one refusal serves "Replace all", "Preview…" and the preview's "Apply": each asks noReplace first.
		const noReplace = between(src, "const noReplace = (ignoreReplaceActive = false) => {", "const executeReplace = async (skipConfirm: boolean) => {");
		expect(noReplace).toContain("const moved = searchBoxMoved(asked(), typed());\n\t\tif (moved) return moved;");
		expect(noReplace.indexOf("searchBoxMoved(")).toBeGreaterThan(noReplace.indexOf("Search for something first"));
		expect(noReplace.indexOf("searchBoxMoved(")).toBeLessThan(noReplace.indexOf("return shortfallBlocksReplace("));
		// The box is `typed()`: every way of changing it sets that, and a search sets `asked()` to what it was given.
		expect(between(src, 'role="search"', 'id="search-input"')).toContain("value={typed()}");
		expect(between(src, "const run = async (overrides: RunOverrides = {}) => {", "const curChoosing =")).toContain("const rawQuery = overrides.query ?? input.value;");
		expect(between(src, "const run = async (overrides: RunOverrides = {}) => {", "const curChoosing =")).toContain("setAsked(rawQuery);");

		const replace = between(src, "const executeReplace = async (skipConfirm: boolean) => {", "const replaceAll = () => executeReplace(false);");
		expect(replace).toContain("const searchedFor = asked();\n\t\tconst query = effectiveAsked() || searchedFor;");
		// The question is asked of the text and the switches the replace is then made with.
		expect(replace).toContain("const prompt = replaceQuestion({ query, regex: options.regex, caseSensitive: options.caseSensitive, wholeWord: options.wholeWord, replacement: with_, matches: total, files: paths.length, safeDocs: protect });");
		expect(replace).toContain("const results = await backend.replace(query, with_, replaceOptions, onDiskPaths);");
		expect(replace).toContain("await run({ query: searchedFor });");
		expect(replace).not.toContain("await run();");

		const preview = between(src, "const previewReplace = async () => {", "const summary = () => {");
		expect(preview).toContain("const query = effectiveAsked() || asked();");
		expect(preview).toContain("title: replacePreviewTitle({ query, regex: options.regex, caseSensitive: options.caseSensitive, wholeWord: options.wholeWord, replacement: with_, matches: totalMatches, files: readyFiles }),");
	});
});

// ---------------------------------------------------------------------------------------------------------------
// 3. A repository that appears, or goes, while the folder is open
// ---------------------------------------------------------------------------------------------------------------

describe.skipIf(!hasGit)("3. a folder that becomes a repository after it was opened, or stops being one", () => {
	test("the nearest `.git` is found by a look at the folders, from the workspace's own up", () => {
		const top = fresh("nearest");
		const deep = join(top, "app", "src");
		mkdirSync(deep, { recursive: true });
		// Whatever is above the test's folder is not the test's: only what is at or below it is asked about.
		const above = nearestDotGit(top);
		expect(nearestDotGit(deep)).toBe(above);
		mkdirSync(join(top, ".git"));
		expect(nearestDotGit(deep)).toBe(top);
		expect(nearestDotGit(top)).toBe(top);
		// A worktree has a file in the folder's place; the nearer one is the one found.
		writeFileSync(join(top, "app", ".git"), "gitdir: elsewhere\n");
		expect(nearestDotGit(deep)).toBe(join(top, "app"));
		expect(nearestDotGit(top)).toBe(top);
	});

	test("`git init` in a terminal is found the next time the status is asked for, by the same Git", async () => {
		const folder = fresh("init-later");
		writeFileSync(join(folder, "a.ssl"), ":RETURN 1;\n");
		const g = new Git(folder);
		try {
			expect(await g.status()).toBeNull();
			expect(await g.branches()).toBeNull();
			init(folder);
			const status = await g.status();
			expect(status).not.toBeNull();
			expect(status!.initial).toBe(true);
			expect(status!.branch).toBe("main");
			expect(status!.files.map((file) => inFolder(folder, file.path))).toEqual(["a.ssl"]);
			// What else is asked of git knows of the repository from then on.
			expect((await g.branches())?.current).toBe("main");
			await g.stage([join(folder, "a.ssl")]);
			expect((await g.status())!.files[0]!.staged).toBe("added");
		} finally {
			g.dispose();
		}
	});

	test("a `.git` that is removed is found gone, and one made again is found again", async () => {
		const folder = fresh("removed");
		writeFileSync(join(folder, "a.ssl"), ":RETURN 1;\n");
		init(folder);
		const g = new Git(folder);
		try {
			expect((await g.status())?.files.length).toBe(1);
			rmSync(join(folder, ".git"), { recursive: true, force: true });
			expect(await g.status()).toBeNull();
			expect(await g.branches()).toBeNull();
			init(folder);
			expect((await g.status())?.files.length).toBe(1);
		} finally {
			g.dispose();
		}
	});

	test("a folder below a repository's top that is given a repository of its own is that repository's from then on", async () => {
		const top = fresh("own-below");
		const git = init(top);
		const app = join(top, "app");
		mkdirSync(app);
		writeFileSync(join(app, "a.ssl"), ":RETURN 1;\n");
		writeFileSync(join(top, "above.ssl"), ":RETURN 0;\n");
		git("add", "-A");
		git("commit", "-q", "-m", "one");
		writeFileSync(join(app, "a.ssl"), ":RETURN 2;\n");
		const g = new Git(app);
		try {
			const outer = await g.status();
			expect(outer!.initial).toBe(false);
			expect(outer!.files.map((file) => [inFolder(app, file.path), file.unstaged])).toEqual([["a.ssl", "modified"]]);
			// The workspace's folder gets a repository of its own: nothing in it is committed yet, and a.ssl is new to it.
			init(app);
			const inner = await g.status();
			expect(inner!.initial).toBe(true);
			expect(inner!.files.map((file) => [inFolder(app, file.path), file.unstaged])).toEqual([["a.ssl", "untracked"]]);
			// Paths are worked out from the new top: the file is staged in the inner repository, by its name there.
			await g.stage([join(app, "a.ssl")]);
			expect(gitIn(app)("diff", "--cached", "--name-only").trim()).toBe("a.ssl");
			expect(git("diff", "--cached", "--name-only").trim()).toBe("");
		} finally {
			g.dispose();
		}
	});

	test("git is not asked again what the repository is while nothing has moved", async () => {
		const plain = fresh("asked-once-plain");
		const g = new Git(plain);
		try {
			// Not a repository: git is asked once, and after that a look at the folders is enough.
			expect(await gitStarts(() => g.status())).toBe(1);
			expect(await gitStarts(() => g.status())).toBe(0);
			expect(await gitStarts(() => g.status())).toBe(0);
			init(plain);
			// It has become one: the top, the prefix and the status are asked for; then the status alone.
			expect(await gitStarts(() => g.status())).toBe(3);
			expect(await gitStarts(() => g.status())).toBe(1);
			expect(await gitStarts(() => g.status())).toBe(1);
		} finally {
			g.dispose();
		}
	});

	test("a `.git` that is not a repository yet is asked about each time, until it is one", async () => {
		const folder = fresh("being-made");
		// As a clone or an init leaves it for a moment: the folder is there, and nothing in it.
		mkdirSync(join(folder, ".git"));
		const g = new Git(folder);
		try {
			expect(await g.status()).toBeNull();
			let again = 0;
			expect(await gitStarts(async () => void (again = (await g.status()) === null ? 1 : 0))).toBe(1);
			expect(again).toBe(1);
			init(folder);
			expect(await g.status()).not.toBeNull();
		} finally {
			g.dispose();
		}
	});

	test("the backend's git, kept for as long as the folder is open, finds it too", async () => {
		const folder = fresh("backend-init-later");
		writeFileSync(join(folder, "a.ssl"), ":RETURN 1;\n");
		const backend = createBackend(hostOf().host, folder);
		await backend.ready;
		try {
			expect(await backend.api.gitStatus()).toBeNull();
			init(folder);
			const status = await backend.api.gitStatus();
			expect(status?.files.map((file) => inFolder(folder, file.path))).toEqual(["a.ssl"]);
			expect((await backend.api.gitBranches())?.current).toBe("main");
			rmSync(join(folder, ".git"), { recursive: true, force: true });
			expect(await backend.api.gitStatus()).toBeNull();
		} finally {
			backend.dispose();
		}
	});

	test("the panel asks git again each time it is shown (source only: the panel needs a DOM to run)", () => {
		const panel = between(readSrc("src/view/panels/Git.tsx"), "export function GitPanel() {", "const staged = () =>");
		expect(panel).toContain("onSettled(() => {\n\t\tvoid refreshGit();\n\t});");
		// Its own refresh, the window come back to and a change among the files ask the same question.
		const view = readSrc("src/view/git.ts");
		expect(between(view, "export async function refreshGit(): Promise<void> {", "/** Asks git again soon")).toContain("const next = await backend.gitStatus();");
		expect(between(view, "export function useGit() {", "export const branchText")).toContain('window.addEventListener("focus", focused);');
	});
});

// ---------------------------------------------------------------------------------------------------------------
// 4. The copy a discard and a replace say is kept
// ---------------------------------------------------------------------------------------------------------------

const line = "INSERT INTO SAMPLES VALUES (1, 'a committed row');\n";
/** A text of SQL a little over what a save's snapshot may be. */
const largeText = (mark = "") => mark + line.repeat(Math.ceil((MAX_SNAPSHOT_BYTES + 200_000) / line.length));

describe("4. local history: the copy made before a step that cannot be taken back", () => {
	test("a save's snapshot has a largest size; the copy before a discard or a replace has none", async () => {
		const root = fresh("keep-large");
		const history = new History(root, fresh("keep-large-history"));
		const file = join(root, "data.sql");
		const text = largeText();
		expect(Buffer.byteLength(text, "utf8")).toBeGreaterThan(MAX_SNAPSHOT_BYTES);
		// As a save: passed over, and said to be.
		expect(await history.record(file, text)).toBe(false);
		expect(history.list(file)).toEqual([]);
		// As the copy of a file that is about to go: kept, whole.
		await history.keep(file, text, 1000);
		const list = history.list(file);
		expect(list.length).toBe(1);
		expect(list[0]!.size).toBe(Buffer.byteLength(text, "utf8"));
		expect(await history.read(file, list[0]!.id)).toBe(text);
	});

	test("a text that is the newest snapshot already is not written twice, and a small one is kept as any snapshot is", async () => {
		const root = fresh("keep-same");
		const history = new History(root, fresh("keep-same-history"));
		const file = join(root, "a.ssl");
		await history.keep(file, ":RETURN 1;\n", 1000);
		await history.keep(file, ":RETURN 1;\n", 2000);
		expect(history.list(file).length).toBe(1);
		await history.keep(file, ":RETURN 2;\n", 3000);
		expect(history.list(file).map((snap) => snap.time)).toEqual([3000, 1000]);
		// A save after it still says whether it wrote a snapshot.
		expect(await history.record(file, ":RETURN 2;\n", 4000)).toBe(false);
		expect(await history.record(file, ":RETURN 3;\n", 5000)).toBe(true);
	});

	test("a copy that cannot be written is a failure, not a copy passed over", async () => {
		const root = fresh("keep-fails");
		// Where the history is kept there is a file: no snapshot can be made (as with a full or read-only folder).
		const inTheWay = join(fresh("keep-fails-history"), "history");
		writeFileSync(inTheWay, "in the way\n");
		const history = new History(root, inTheWay);
		let failed: unknown;
		await history.keep(join(root, "a.ssl"), ":RETURN 1;\n").catch((e) => (failed = e));
		expect(failed).toBeInstanceOf(Error);
		expect(copyNotKept("data.sql", "ENOSPC: no space left on device, write")).toBe("no copy of data.sql could be kept in local history (ENOSPC: no space left on device, write): the file is left as it is");
	});

	test("of the copies over a snapshot's size the last five are kept; the snapshots of saves are not counted among them", async () => {
		const root = fresh("keep-few");
		const history = new History(root, fresh("keep-few-history"));
		const file = join(root, "data.sql");
		await history.record(file, "-- small, first\n", 1);
		for (let n = 1; n <= 7; n++) await history.keep(file, largeText(`-- copy ${n}\n`), 10 * n);
		await history.record(file, "-- small, last\n", 100);
		const list = history.list(file);
		const large = list.filter((snap) => snap.size > MAX_SNAPSHOT_BYTES);
		expect(large.map((snap) => snap.time)).toEqual([70, 60, 50, 40, 30]);
		expect(await history.read(file, large[0]!.id)).toStartWith("-- copy 7\n");
		expect(list.filter((snap) => snap.size <= MAX_SNAPSHOT_BYTES).map((snap) => snap.time)).toEqual([100, 1]);
	});

	test("a replace in an open file is not made where its copy was not (source only: the panel needs a DOM to run)", () => {
		const replace = between(readSrc("src/view/panels/Search.tsx"), "const executeReplace = async (skipConfirm: boolean) => {", "const replaceAll = () => executeReplace(false);");
		expect(replace).not.toContain("backend.historyKeep(at).catch(() => {})");
		expect(replace).toContain("const notKept = await backend.historyKeep(at).then(\n\t\t\t\t\t\t\t() => \"\",\n\t\t\t\t\t\t\t(e: any) => String(e?.message ?? e),\n\t\t\t\t\t\t);");
		expect(replace).toContain("if (notKept) {\n\t\t\t\t\t\t\tfailed.push(`${baseName(path)}: its copy for local history was not made (${notKept})`);\n\t\t\t\t\t\t\tcontinue;\n\t\t\t\t\t\t}");
		// The copy is asked for before the edits are made in the file.
		expect(replace.indexOf("backend.historyKeep(at)")).toBeLessThan(replace.indexOf("const replaced = replaceInModel(doc.model, sim.edits);"));
	});
});

/** Whether src/bun/backend.ts keeps these copies with `History.keep` yet: that file is changed by its own owner. */
const backendKeeps = /\bhist\.keep\(/.test(readSrc("src/bun/backend.ts"));

describe.skipIf(!hasGit || !backendKeeps)("4. the backend keeps that copy, and does not go on without it", () => {
	/** A workspace that is a repository with one small and one large file committed, and a backend on it. */
	async function workspace(name: string) {
		const root = fresh(name);
		const git = init(root);
		writeFileSync(join(root, "small.sql"), line.repeat(100));
		writeFileSync(join(root, "large.sql"), largeText());
		git("add", "-A");
		git("commit", "-q", "-m", "one");
		const { host, trashed } = hostOf();
		const backend = createBackend(host, root);
		await backend.ready;
		return { root, git, backend, trashed };
	}
	const edited = (text: string) => `${text}-- an afternoon of edits, saved and not committed\n`;

	test("a discard keeps the file as it was, also where it is larger than a save's snapshot", async () => {
		await withDirs("dirs-discard", async () => {
			const { root, backend } = await workspace("discard-large");
			try {
				for (const name of ["small.sql", "large.sql"]) {
					const path = join(root, name);
					const committed = readFileSync(path, "utf8");
					writeFileSync(path, edited(committed));
					await backend.api.gitDiscard(path);
					expect(readFileSync(path, "utf8")).toBe(committed);
					const snaps = await backend.api.history(path);
					expect(snaps.length).toBe(1);
					expect(await backend.api.snapshot(path, snaps[0]!.id)).toBe(edited(committed));
				}
			} finally {
				backend.dispose();
			}
		});
	});

	test("a replace across files keeps each file as it was, and so does the copy asked for before an open file is replaced in", async () => {
		await withDirs("dirs-replace", async () => {
			const { root, backend } = await workspace("replace-large");
			try {
				const path = join(root, "large.sql");
				const before = readFileSync(path, "utf8");
				const done = await backend.api.replace("a committed row", "a replaced row", {}, [path]);
				expect(done.map((each) => each.count)).toEqual([before.split("a committed row").length - 1]);
				expect(readFileSync(path, "utf8")).toBe(before.replaceAll("a committed row", "a replaced row"));
				const snaps = await backend.api.history(path);
				expect(snaps.length).toBe(1);
				expect(await backend.api.snapshot(path, snaps[0]!.id)).toBe(before);

				const other = join(root, "other.sql");
				writeFileSync(other, largeText("-- another\n"));
				await backend.api.historyKeep(other);
				const kept = await backend.api.history(other);
				expect(kept.length).toBe(1);
				expect(await backend.api.snapshot(other, kept[0]!.id)).toBe(largeText("-- another\n"));
			} finally {
				backend.dispose();
			}
		});
	});

	test("where the copy cannot be made, a followed file is not discarded and a file is not replaced in; a new file still goes to the trash", async () => {
		await withDirs("dirs-refused", async ({ data }) => {
			const { root, backend, trashed } = await workspace("discard-refused");
			// Where the history is kept there is a file: no snapshot can be made (as with a full or read-only folder).
			rmSync(join(data, "history"), { recursive: true, force: true });
			mkdirSync(data, { recursive: true });
			writeFileSync(join(data, "history"), "in the way\n");
			try {
				const path = join(root, "small.sql");
				const now = edited(readFileSync(path, "utf8"));
				writeFileSync(path, now);
				let said = "";
				await backend.api.gitDiscard(path).catch((e) => (said = String(e?.message ?? e)));
				expect(said).toStartWith("no copy of small.sql could be kept in local history (");
				expect(said).toEndWith("): the file is left as it is");
				expect(readFileSync(path, "utf8")).toBe(now);

				const done = await backend.api.replace("a committed row", "a replaced row", {}, [path]);
				expect(done.length).toBe(1);
				expect(done[0]!.count).toBe(0);
				expect(done[0]!.error).toBeTruthy();
				expect(readFileSync(path, "utf8")).toBe(now);

				// A file git does not follow goes to the trash, where it still is: its copy is not what brings it back.
				const fresh = join(root, "new.sql");
				writeFileSync(fresh, line);
				await backend.api.gitDiscard(fresh);
				expect(trashed).toEqual([fresh]);

				// A file that was removed has nothing to keep, and comes back.
				const gone = join(root, "large.sql");
				rmSync(gone);
				await backend.api.gitDiscard(gone);
				expect(existsSync(gone)).toBe(true);
			} finally {
				backend.dispose();
			}
		});
	});
});

// ---------------------------------------------------------------------------------------------------------------
// 5. A folder with a repository of its own
// ---------------------------------------------------------------------------------------------------------------

describe.skipIf(!hasGit)("5. a folder in the workspace that is a repository of its own", () => {
	/** A workspace that is a repository, holding folders with repositories of their own and plain new files. */
	function nested(name: string, below = "") {
		const top = fresh(name);
		const git = init(top);
		const ws = below ? join(top, below) : top;
		mkdirSync(ws, { recursive: true });
		writeFileSync(join(ws, "a.ssl"), ":RETURN 1;\n");
		git("add", "-A");
		git("commit", "-q", "-m", "one");
		// One with a commit of its own, one just made, and a folder of new files that is no repository.
		const committed = join(ws, "library");
		const inner = init(committed);
		writeFileSync(join(committed, "work.ssl"), ":RETURN 2;\n");
		inner("add", "-A");
		inner("commit", "-q", "-m", "its own history");
		init(join(ws, "tools", "started"));
		mkdirSync(join(ws, "plain"));
		writeFileSync(join(ws, "plain", "one.ssl"), ":RETURN 3;\n");
		writeFileSync(join(ws, "plain", "two.ssl"), ":RETURN 4;\n");
		writeFileSync(join(ws, "new.ssl"), ":RETURN 5;\n");
		return { top, ws, git, committed };
	}
	const marks = (ws: string, files: { path: string; unstaged: string | null }[]) => files.map((file) => [inFolder(ws, file.path), file.unstaged, (file as { repository?: boolean }).repository === true] as const).sort((a, b) => a[0].localeCompare(b[0]));

	test("the status marks it as that, by its folder's path; new files in a plain folder are listed one by one", async () => {
		const { ws } = nested("status");
		const g = new Git(ws);
		try {
			expect(marks(ws, (await g.status())!.files)).toEqual([
				["library", "untracked", true],
				["new.ssl", "untracked", false],
				["plain/one.ssl", "untracked", false],
				["plain/two.ssl", "untracked", false],
				["tools/started", "untracked", true],
			]);
		} finally {
			g.dispose();
		}
	});

	test("the same in a workspace below the repository's top", async () => {
		const { ws } = nested("status-below", "app");
		const g = new Git(ws);
		try {
			expect(marks(ws, (await g.status())!.files).filter(([, , own]) => own).map(([path]) => path)).toEqual(["library", "tools/started"]);
		} finally {
			g.dispose();
		}
	});

	test("what is a folder with a `.git` of its own, and what is not", () => {
		const { ws, committed } = nested("is-own");
		expect(holdsOwnRepository(committed)).toBe(true);
		expect(holdsOwnRepository(join(ws, "tools", "started"))).toBe(true);
		expect(holdsOwnRepository(join(ws, "plain"))).toBe(false);
		expect(holdsOwnRepository(join(ws, "new.ssl"))).toBe(false);
		expect(holdsOwnRepository(join(ws, "not-there"))).toBe(false);
	});

	test("it is not sent to the trash, and nothing of it is discarded: the backend refuses, and says what it is", async () => {
		const { ws, committed } = nested("discard");
		const { host, trashed } = hostOf();
		const backend = createBackend(host, ws);
		await backend.ready;
		try {
			for (const folder of [committed, join(ws, "tools", "started")]) {
				let said = "";
				await backend.api.gitDiscard(folder).catch((e) => (said = String(e?.message ?? e)));
				expect(said).toContain("is a folder with a git repository of its own, not a file");
				expect(existsSync(join(folder, ".git"))).toBe(true);
			}
			expect(trashed).toEqual([]);
			expect(readFileSync(join(committed, "work.ssl"), "utf8")).toBe(":RETURN 2;\n");
			// A new file is still let go as it was: to the trash.
			await backend.api.gitDiscard(join(ws, "new.ssl"));
			expect(trashed).toEqual([join(ws, "new.ssl")]);
		} finally {
			backend.dispose();
		}
	});

	test("staged in one command with the files, one that has no commit yet fails the lot; the files without it are staged", async () => {
		const { ws } = nested("stage-all");
		const g = new Git(ws);
		try {
			const changes = (await g.status())!.files;
			// What "Stage all" gave git before: every change, the folders among them. git's own refusal, and nothing staged.
			let said = "";
			await g.stage(changes.map((file) => file.path)).catch((e) => (said = String(e?.message ?? e)));
			expect(said).toContain("does not have a commit checked out");
			expect((await g.status())!.files.filter((file) => file.staged).length).toBe(0);
			// What it gives git now: the files.
			await g.stage(changes.filter((file) => !file.repository).map((file) => file.path));
			expect(marks(ws, (await g.status())!.files.filter((file) => file.staged))).toEqual([
				["new.ssl", null, false],
				["plain/one.ssl", null, false],
				["plain/two.ssl", null, false],
			]);
			expect(marks(ws, (await g.status())!.files.filter((file) => file.repository)).map(([path]) => path)).toEqual(["library", "tools/started"]);
		} finally {
			g.dispose();
		}
	});

	test("the panel shows it as a folder with a repository of its own, and offers no discard for it (source only: the panel needs a DOM to run)", () => {
		const view = readSrc("src/view/git.ts");
		expect(between(view, "export function useGit() {", "export const branchText")).toContain("export const isOwnRepository = (file: GitFile): boolean => file.repository === true;");
		// Neither asked nor done, whichever way the discard was reached; and a look at its change says what it is.
		const discard = between(view, "export async function discard(file: GitFile): Promise<void> {", "const root = state.workspace?.root;");
		expect(discard).toContain('if (isOwnRepository(file)) return notify(ownRepositoryNote(file, "It is not discarded or moved to the trash from here."));');
		expect(between(view, "export async function showChange(", "try {")).toContain('if (!staged && isOwnRepository(file)) return notify(ownRepositoryNote(file, "There is no change of it to show here."));');

		const panel = readSrc("src/view/panels/Git.tsx");
		const row = between(panel, "const FileRow = (props: { file: GitFile; staged: boolean }) => {", "return (\n\t\t<div class=\"panel-body\" data-panel=\"git\">");
		expect(row).toContain("const own = () => !props.staged && isOwnRepository(props.file);");
		expect(row).toContain("<FileMark name={name()} folder={own() ? { open: false } : undefined} />");
		expect(row).toContain('<Show when={own()}>\n\t\t\t\t\t\t<span class="git-folder">{OWN_REPOSITORY}</span>');
		expect(row).toContain('<Show when={!props.staged && kind() !== "conflict" && !own()}>');
		expect(between(panel, "const CODE_OR_SQL_RE", "function formatCommitDate")).toContain('const OWN_REPOSITORY = "a repository of its own";');
		// Its menu is its own: a file's would offer "Move to trash…", "Show the change" and "Open the file".
		const menu = between(panel, "const ownRepositoryMenu = (inWorkspace: boolean): RowMenuEntry[] => [", "];");
		expect(menu).not.toContain("TRASH");
		expect(menu).not.toContain("DISCARD");
		expect(menu).not.toContain("OPEN");
		expect(menu).not.toMatch(/\bSHOW\b/);
		expect(between(panel, "const menu = async (file: GitFile, isStaged: boolean, at: Point) => {", "const make = async () => {")).toContain("const entries = !isStaged && isOwnRepository(file) ? ownRepositoryMenu(inWorkspace) : rowMenuEntries(file, isStaged, inWorkspace);");
		// "Stage all" stages the files, and says which folders it left.
		const stageAll = between(panel, "const stageAll = async () => {", "const draftMessage = () => {");
		expect(stageAll).toContain('const stageable = all.filter((f) => f.unstaged !== "conflict").filter((f) => !isOwnRepository(f));');
		expect(stageAll).toContain("const own = all.filter(isOwnRepository);");
		expect(stageAll).toContain("if (own.length) {\n\t\t\tnotify(");
	});
});
