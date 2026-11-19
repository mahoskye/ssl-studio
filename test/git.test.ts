import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Git } from "../src/bun/git";

// A repository made for the test, with the test's own name on its commits: nothing of the machine's git is used
// but the program.
const hasGit = Bun.spawnSync(["git", "--version"]).exitCode === 0;
// The user's own settings are kept out by an empty file of settings: the null device is no file to git on Windows.
const settings = join(mkdtempSync(join(tmpdir(), "ssl-studio-gitconfig-")), "config");
writeFileSync(settings, "");
const identity = { GIT_AUTHOR_NAME: "Test", GIT_AUTHOR_EMAIL: "test@example.test", GIT_COMMITTER_NAME: "Test", GIT_COMMITTER_EMAIL: "test@example.test", GIT_CONFIG_GLOBAL: settings, GIT_CONFIG_NOSYSTEM: "1" };
// For these tests only: the app's own git is run with the process's settings, so they are set here and put back after.
const before = Object.fromEntries(Object.keys(identity).map((name) => [name, process.env[name]]));
beforeAll(() => void Object.assign(process.env, identity));
afterAll(() => {
	for (const [name, value] of Object.entries(before)) {
		if (value === undefined) delete process.env[name];
		else process.env[name] = value;
	}
});

function repository(): string {
	const root = mkdtempSync(join(tmpdir(), "ssl-studio-git-"));
	const git = (...args: string[]) => {
		const ran = Bun.spawnSync(["git", "-C", root, ...args], { env: { ...process.env, ...identity } });
		if (ran.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${ran.stderr.toString()}`);
	};
	git("init", "-q");
	git("symbolic-ref", "HEAD", "refs/heads/main");
	// Text is kept as written, on every system.
	git("config", "core.autocrlf", "false");
	git("config", "commit.gpgsign", "false");
	return root;
}

const names = (root: string, paths: string[]) => paths.map((path) => path.slice(root.length + 1).split("\\").join("/")).sort();

describe.skipIf(!hasGit)("git, asked about a workspace", () => {
	test("a folder that is not in a repository has no status", async () => {
		const plain = mkdtempSync(join(tmpdir(), "ssl-studio-plain-"));
		// A folder under a repository's own would be in it: the system's temporary folder is not.
		expect(await new Git(plain).status()).toBeNull();
		rmSync(plain, { recursive: true, force: true });
	});

	test("before the first commit everything is new, and is staged and taken out again", async () => {
		const root = repository();
		writeFileSync(join(root, "a.ssl"), ":RETURN 1;\n");
		const git = new Git(root);
		let status = (await git.status())!;
		expect(status.initial).toBe(true);
		expect(status.branch).toBe("main");
		expect(status.files).toEqual([{ path: join(root, "a.ssl"), staged: null, unstaged: "untracked" }]);
		await git.stage([join(root, "a.ssl")]);
		status = (await git.status())!;
		expect(status.files).toEqual([{ path: join(root, "a.ssl"), staged: "added", unstaged: null }]);
		await git.unstage([join(root, "a.ssl")]);
		expect((await git.status())!.files).toEqual([{ path: join(root, "a.ssl"), staged: null, unstaged: "untracked" }]);
		expect(existsSync(join(root, "a.ssl"))).toBe(true);
		rmSync(root, { recursive: true, force: true });
	});

	test("a commit takes what is staged, and leaves what is not", async () => {
		const root = repository();
		mkdirSync(join(root, "src"));
		writeFileSync(join(root, "src", "a.ssl"), ":RETURN 1;\n");
		writeFileSync(join(root, "notes.md"), "notes\n");
		const git = new Git(root);
		await git.stage([join(root, "src", "a.ssl")]);
		expect(await git.commit("Add a")).toContain("Add a");
		const status = (await git.status())!;
		expect(status.initial).toBe(false);
		expect(names(root, status.files.map((file) => file.path))).toEqual(["notes.md"]);
		await expect(git.commit("  ")).rejects.toThrow(/message/);
		rmSync(root, { recursive: true, force: true });
	});

	test("a file as it was in the last commit, and as it is staged", async () => {
		const root = repository();
		const file = join(root, "a.ssl");
		writeFileSync(file, "one\n");
		const git = new Git(root);
		await git.stage([file]);
		await git.commit("one");
		writeFileSync(file, "two\n");
		await git.stage([file]);
		writeFileSync(file, "three\n");
		expect(await git.base(file, "head")).toBe("one\n");
		expect(await git.base(file, "index")).toBe("two\n");
		expect((await git.status())!.files).toEqual([{ path: file, staged: "modified", unstaged: "modified" }]);
		// A file git never had has no earlier text.
		expect(await git.base(join(root, "never.ssl"), "head")).toBeNull();
		rmSync(root, { recursive: true, force: true });
	});

	test("a file in a one-byte encoding comes back as its text", async () => {
		const root = repository();
		const file = join(root, "ansi.sql");
		writeFileSync(file, Buffer.from([0x63, 0x61, 0x66, 0xe9, 0x0a]));
		const git = new Git(root);
		await git.stage([file]);
		await git.commit("ansi");
		expect(await git.base(file, "head")).toBe("café\n");
		rmSync(root, { recursive: true, force: true });
	});

	test("discarding puts a followed file back to what is staged, and brings a removed one back", async () => {
		const root = repository();
		const file = join(root, "a.ssl");
		const other = join(root, "b.ssl");
		writeFileSync(file, "one\n");
		writeFileSync(other, "b\n");
		const git = new Git(root);
		await git.stage([file, other]);
		await git.commit("one");
		writeFileSync(file, "two\n");
		await git.stage([file]);
		writeFileSync(file, "three\n");
		rmSync(other);
		expect(await git.follows(file)).toBe(true);
		await git.discard(file);
		await git.discard(other);
		expect(await Bun.file(file).text()).toBe("two\n");
		expect(await Bun.file(other).text()).toBe("b\n");
		// What was staged is still staged.
		expect((await git.status())!.files).toEqual([{ path: file, staged: "modified", unstaged: null }]);
		rmSync(root, { recursive: true, force: true });
	});

	test("a file only in the folder is not followed, and a removed one that is staged shows as removed", async () => {
		const root = repository();
		const file = join(root, "a.ssl");
		writeFileSync(file, "one\n");
		const git = new Git(root);
		expect(await git.follows(file)).toBe(false);
		await git.stage([file]);
		await git.commit("one");
		rmSync(file);
		await git.stage([file]);
		expect((await git.status())!.files).toEqual([{ path: file, staged: "deleted", unstaged: null }]);
		rmSync(root, { recursive: true, force: true });
	});

	test("in a workspace that is a folder inside the repository, each step acts on the file asked for", async () => {
		const root = repository();
		const app = join(root, "app");
		// A twin of the workspace's own name inside it: the path git would land on, were it given the path from the top.
		mkdirSync(join(app, "app"), { recursive: true });
		const file = join(app, "x.ssl");
		const twin = join(app, "app", "x.ssl");
		writeFileSync(file, "one\n");
		writeFileSync(twin, "twin one\n");
		writeFileSync(join(root, "outside.md"), "o\n");
		const top = new Git(root);
		await top.stage([file, twin, join(root, "outside.md")]);
		await top.commit("one");
		const git = new Git(app);
		writeFileSync(file, "two\n");
		writeFileSync(twin, "twin two\n");
		expect(await git.follows(file)).toBe(true);
		await git.stage([file]);
		expect((await git.status())!.files).toEqual([
			{ path: twin, staged: null, unstaged: "modified" },
			{ path: file, staged: "modified", unstaged: null },
		]);
		await git.unstage([file]);
		expect((await git.status())!.files.find((each) => each.path === file)).toEqual({ path: file, staged: null, unstaged: "modified" });
		await git.discard(file);
		expect(await Bun.file(file).text()).toBe("one\n");
		// The twin was not asked for, and is as it was left.
		expect(await Bun.file(twin).text()).toBe("twin two\n");
		expect(await git.base(file, "head")).toBe("one\n");
		rmSync(root, { recursive: true, force: true });
	});

	test("what is staged above the workspace's folder is counted, since a commit takes it", async () => {
		const root = repository();
		mkdirSync(join(root, "app"));
		writeFileSync(join(root, "app", "a.ssl"), "a\n");
		writeFileSync(join(root, "outside.md"), "o\n");
		await new Git(root).stage([join(root, "outside.md")]);
		const status = (await new Git(join(root, "app")).status())!;
		expect(status.stagedOutside).toBe(1);
		expect((await new Git(root).status())!.stagedOutside).toBeUndefined();
		rmSync(root, { recursive: true, force: true });
	});

	test("a file's name is only a name: marks that mean a pattern to git are part of it", async () => {
		const root = repository();
		const odd = join(root, "report[1].ssl");
		const plain = join(root, "report1.ssl");
		const star = join(root, "star*.ssl");
		const starred = join(root, "starA.ssl");
		// A star cannot be in a name on Windows: the brackets are tried everywhere, the star where it can be.
		const stars = process.platform !== "win32";
		for (const file of [odd, plain, ...(stars ? [star, starred] : [])]) writeFileSync(file, "one\n");
		const git = new Git(root);
		await git.stage([odd, plain, ...(stars ? [star, starred] : [])]);
		await git.commit("one");
		for (const file of [odd, plain, ...(stars ? [star, starred] : [])]) writeFileSync(file, "two\n");
		expect(await git.follows(odd)).toBe(true);
		await git.stage([odd, ...(stars ? [star] : [])]);
		expect(names(root, (await git.status())!.files.filter((file) => file.staged).map((file) => file.path))).toEqual(stars ? ["report[1].ssl", "star*.ssl"] : ["report[1].ssl"]);
		await git.unstage([odd]);
		await git.discard(odd);
		expect(await Bun.file(odd).text()).toBe("one\n");
		expect(await Bun.file(plain).text()).toBe("two\n");
		rmSync(root, { recursive: true, force: true });
	});

	test("a file that is not followed is told from a question that failed", async () => {
		const root = repository();
		writeFileSync(join(root, "new.ssl"), "n\n");
		expect(await new Git(root).follows(join(root, "new.ssl"))).toBe(false);
		const plain = mkdtempSync(join(tmpdir(), "ssl-studio-plain-"));
		writeFileSync(join(plain, "a.ssl"), "a\n");
		await expect(new Git(plain).follows(join(plain, "a.ssl"))).rejects.toThrow();
		rmSync(root, { recursive: true, force: true });
		rmSync(plain, { recursive: true, force: true });
	});

	test("only the workspace's own folder is reported, when it is a folder inside the repository", async () => {
		const root = repository();
		mkdirSync(join(root, "app", "src"), { recursive: true });
		writeFileSync(join(root, "app", "src", "a.ssl"), "a\n");
		writeFileSync(join(root, "outside.md"), "o\n");
		const status = (await new Git(join(root, "app")).status())!;
		expect(names(root, status.files.map((file) => file.path))).toEqual(["app/src/a.ssl"]);
		rmSync(root, { recursive: true, force: true });
	});
});
