// What git knows of the workspace, asked of the user's own git: what has
// changed, a file as it was, and the steps of making a commit. Only what
// stays on this machine: nothing here fetches, pulls or pushes, and nothing
// rewrites what was committed.
import { join, relative, resolve, sep } from "node:path";
import { looksBinary } from "../shared/fileKind";
import { parseStatus, type GitStatus } from "../shared/gitStatus";
import type { GitCommit, TicketGitCommit } from "../shared/protocol";
import { decode } from "./encoding";

type Ran = { code: number; out: Uint8Array; err: string };
/** As many paths as one git command is given. */
const BATCH = 100;
const text = (bytes: Uint8Array) => new TextDecoder().decode(bytes);

export class Git {
	private top: string | null | undefined;
	/** Where the workspace's folder is inside the repository, as git says it: "" at its top, "app/" below it. */
	private prefix = "";
	/** The question git is answering now, or answered last: the next one waits for it. */
	private last: Promise<unknown> = Promise.resolve();

	constructor(private readonly root: string) {}

	/**
	 * Runs git in the workspace's folder. It is given no keyboard, and told not to ask at the terminal. A file's
	 * name is only ever a name: "report[1].ssl" is that file, not a pattern that is also "report1.ssl".
	 */
	private run(args: string[]): Promise<Ran> {
		// One question at a time: two steps at once would meet at git's own lock on the repository, and one would fail.
		const next = this.last.then(
			() => this.spawn(args),
			() => this.spawn(args),
		);
		this.last = next;
		return next;
	}

	private async spawn(args: string[]): Promise<Ran> {
		const proc = Bun.spawn(["git", "--no-optional-locks", "--literal-pathspecs", "-C", this.root, ...args], {
			stdin: "ignore",
			stdout: "pipe",
			stderr: "pipe",
			env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
		});
		const [out, err, code] = await Promise.all([new Response(proc.stdout).arrayBuffer(), new Response(proc.stderr).text(), proc.exited]);
		return { code, out: new Uint8Array(out), err };
	}

	/** Runs git and gives what it said; what it said went wrong, as an error, when it failed. */
	private async done(args: string[]): Promise<string> {
		const ran = await this.run(args);
		if (ran.code !== 0) throw new Error((ran.err || text(ran.out)).trim() || `git ${args[0]} failed`);
		return text(ran.out);
	}

	/** The repository's top folder, or null when the workspace is not in one (or there is no git to ask). */
	async repository(): Promise<string | null> {
		if (this.top !== undefined) return this.top;
		try {
			const ran = await this.run(["rev-parse", "--show-toplevel"]);
			this.top = ran.code === 0 ? resolve(text(ran.out).trim()) : null;
			if (this.top) this.prefix = text((await this.run(["rev-parse", "--show-prefix"])).out).trim();
		} catch {
			// No git on this machine.
			this.top = null;
		}
		return this.top;
	}

	/**
	 * A path as git is given it to act on: from the workspace's folder, where git is run, with forward slashes.
	 * Worked out from the workspace's own folder, not from the top folder as git spells it: the two may be the
	 * same place by different names (a link, a drive letter's case).
	 */
	private async here(path: string): Promise<string> {
		if (!(await this.repository())) throw new Error("This folder is not in a git repository.");
		return relative(this.root, resolve(path)).split(sep).join("/");
	}

	/** A path as git names it inside a commit: from the repository's top folder, which may be above the workspace's. */
	private async named(path: string): Promise<string> {
		return this.prefix + (await this.here(path));
	}

	/** What has changed in the workspace's folder, each file by its whole path. Null outside a repository. */
	async status(): Promise<GitStatus | null> {
		const top = await this.repository();
		if (!top) return null;
		const ran = await this.run(["status", "--porcelain=v2", "--branch", "-z", "--untracked-files=all", "--", "."]);
		if (ran.code !== 0) throw new Error(ran.err.trim() || "git status failed");
		const status = parseStatus(text(ran.out));
		// Each file by its path under the workspace's folder, as the workspace spells it.
		const whole = (path: string) => (path.startsWith(this.prefix) ? join(this.root, ...path.slice(this.prefix.length).split("/")) : join(top, ...path.split("/")));
		// A commit takes everything that is staged, also above the workspace's folder, where this list does not look.
		const staged = this.prefix ? text((await this.run(["diff", "--cached", "--name-only", "-z"])).out).split("\0").filter(Boolean) : [];
		const stagedOutside = staged.filter((path) => !path.startsWith(this.prefix)).length;
		return { ...status, ...(stagedOutside ? { stagedOutside } : {}), files: status.files.map((file) => ({ ...file, path: whole(file.path), ...(file.from ? { from: whole(file.from) } : {}) })) };
	}

	/**
	 * A file as it was: in the last commit ("head"), or as it is staged ("index"). Null when it was not there, or
	 * was not text.
	 */
	async base(path: string, from: "head" | "index"): Promise<string | null> {
		const ran = await this.run(["show", `${from === "head" ? "HEAD" : ""}:${await this.named(path)}`]);
		if (ran.code !== 0 || looksBinary(ran.out)) return null;
		try {
			return decode(ran.out).text;
		} catch {
			return null;
		}
	}

	/** Recent Git commits touching `path` (following renames). Returns `[]` outside a repository or on untracked files. */
	async log(path: string, limit = 25): Promise<GitCommit[]> {
		const top = await this.repository();
		if (!top) return [];
		const cap = Math.max(1, Math.min(100, Math.round(limit)));
		const relHere = await this.here(path);
		const ran = await this.run([
			"-c",
			"core.quotePath=false",
			"log",
			"--follow",
			"-n",
			String(cap),
			"--format=%x1e%H%x1f%h%x1f%ct%x1f%an%x1f%s",
			"--name-only",
			"--",
			relHere,
		]);
		if (ran.code !== 0) return [];
		const commits: GitCommit[] = [];
		let lastKnownPath = `${this.prefix}${relHere}`;
		for (const chunk of text(ran.out).split("\x1e")) {
			const trimmed = chunk.trim();
			if (!trimmed) continue;
			const lines = trimmed.split(/\r?\n/);
			const header = lines[0] ?? "";
			const [sha, shortSha, ct, author, ...subjectParts] = header.split("\x1f");
			if (!sha || !shortSha) continue;
			const listedPath = lines.slice(1).find((l) => l.trim().length > 0)?.trim();
			const fileInCommit = listedPath || lastKnownPath;
			lastKnownPath = fileInCommit;
			commits.push({
				sha,
				shortSha,
				time: (Number(ct) || 0) * 1000,
				author: author ?? "",
				subject: subjectParts.join(" "),
				path: fileInCommit,
			});
		}
		return commits;
	}

	/** Local Git commits mentioning `ticketKey`, with changed files and statuses (ADR 0022: local only). */
	async ticketLog(ticketKey: string, limit = 30): Promise<TicketGitCommit[]> {
		const cleanKey = ticketKey.trim();
		if (!cleanKey || !(await this.repository())) return [];
		const cap = Math.max(1, Math.min(100, Math.round(limit)));
		const ran = await this.run([
			"-c",
			"core.quotePath=false",
			"log",
			"-n",
			String(cap),
			"-i",
			"--fixed-strings",
			`--grep=${cleanKey}`,
			"--format=%x1e%H%x1f%h%x1f%ct%x1f%an%x1f%s",
			"--name-status",
		]);
		if (ran.code !== 0) return [];
		const commits: TicketGitCommit[] = [];
		const wordRe = new RegExp(`(?<![A-Za-z0-9_-])${cleanKey.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![A-Za-z0-9_-])`, "i");
		for (const chunk of text(ran.out).split("\x1e")) {
			const trimmed = chunk.trim();
			if (!trimmed) continue;
			const lines = trimmed.split(/\r?\n/);
			const header = lines[0] ?? "";
			const [sha, shortSha, ct, author, ...subjectParts] = header.split("\x1f");
			if (!sha || !shortSha) continue;
			const subject = subjectParts.join(" ");
			// Keep commits whose subject/body matched as a whole ticket key (avoiding DEMO-1 matching DEMO-101).
			if (!wordRe.test(subject) && !lines.some((l) => wordRe.test(l))) {
				// Git --grep matched the body; keep if subject doesn't obviously match a longer key only.
				const longerKeyRe = new RegExp(`${cleanKey.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}[0-9]`, "i");
				if (longerKeyRe.test(subject)) continue;
			}
			const files: { status: string; path: string }[] = [];
			for (const line of lines.slice(1)) {
				const l = line.trim();
				if (!l) continue;
				const parts = l.split("\t");
				if (parts.length < 2) continue;
				const status = parts[0]!.trim();
				const filePath = (parts[2] ?? parts[1]!).trim();
				if (!filePath) continue;
				// Convert repo-relative path to workspace-relative path when workspace is inside a subdir.
				const rel = this.prefix && filePath.startsWith(this.prefix) ? filePath.slice(this.prefix.length) : filePath;
				files.push({ status, path: rel });
			}
			commits.push({
				sha,
				shortSha,
				time: (Number(ct) || 0) * 1000,
				author: author ?? "",
				subject,
				files,
			});
		}
		return commits;
	}

	/** Reads a file's text at a specific Git commit SHA. Returns null if binary, missing, or invalid SHA. */
	async show(path: string, sha: string, repoPath?: string): Promise<string | null> {
		if (!/^[0-9a-f]{4,40}$/i.test(sha.trim())) return null;
		if (!(await this.repository())) return null;
		const gitPath = repoPath?.trim() || (await this.named(path));
		const ran = await this.run(["show", `${sha.trim()}:${gitPath}`]);
		if (ran.code !== 0 || looksBinary(ran.out)) return null;
		try {
			return decode(ran.out).text;
		} catch {
			return null;
		}
	}

	/** Paths as git is given them, a hundred to a command: a command line is only so long, on Windows shortest of all. */
	private async batches(paths: string[]): Promise<string[][]> {
		const names = await Promise.all(paths.map((path) => this.here(path)));
		const out: string[][] = [];
		for (let at = 0; at < names.length; at += BATCH) out.push(names.slice(at, at + BATCH));
		return out;
	}

	private async hasCommit(): Promise<boolean> {
		return (await this.run(["rev-parse", "--verify", "-q", "HEAD"])).code === 0;
	}

	/** Puts files into the next commit as they are now: changed, new or gone. */
	async stage(paths: string[]): Promise<void> {
		for (const some of await this.batches(paths)) await this.done(["add", "-A", "--", ...some]);
	}

	/** Takes files out of the next commit. Their text in the folder stays as it is. */
	async unstage(paths: string[]): Promise<void> {
		if (!paths.length) return;
		// Before the first commit there is nothing to put the staged file back to: it is only taken out.
		const how = (await this.hasCommit()) ? ["restore", "--staged", "--"] : ["rm", "--cached", "-r", "-q", "--"];
		for (const some of await this.batches(paths)) await this.done([...how, ...some]);
	}

	/** Makes a commit of what is staged, with the user's own name and any checks their repository runs. Says what git said. */
	async commit(message: string): Promise<string> {
		if (!message.trim()) throw new Error("A commit needs a message.");
		return (await this.done(["commit", "-m", message])).split("\n")[0] ?? "";
	}

	/**
	 * Whether git follows a file, or it is only in the folder. A failure to ask is a failure, and is thrown: it is
	 * not taken for "not followed", on which a file would be sent to the trash.
	 */
	async follows(path: string): Promise<boolean> {
		return (await this.done(["ls-files", "-z", "--", await this.here(path)])).length > 0;
	}

	/**
	 * Puts a followed file back to what is staged of it (or to the last commit, with nothing staged): the changes
	 * in the folder that are not staged are gone. A file removed from the folder comes back.
	 */
	async discard(path: string): Promise<void> {
		await this.done(["restore", "--worktree", "--", await this.here(path)]);
	}
}
