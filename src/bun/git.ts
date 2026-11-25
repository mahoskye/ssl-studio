// What git knows of the workspace, asked of the user's own git: what has
// changed, a file as it was, and the steps of making a commit. Only what
// stays on this machine: nothing here fetches, pulls or pushes, and nothing
// rewrites what was committed.
import { lstatSync, readlinkSync, realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import type { Subprocess } from "bun";
import { parseStatus, type GitStatus } from "../shared/gitStatus";
import type { GitActionResult, GitBlameLine, GitBranchesResult, GitBranchInfo, GitCommit, GitStashResult, TicketGitCommit } from "../shared/protocol";
import { decode, looksBinary } from "./encoding";

type Ran = { code: number; out: Uint8Array; err: string; truncated?: boolean };
type RunOptions = { timeoutMs?: number; maxStdoutBytes?: number; cwd?: string };

/** As many paths as one git command is given. */
const BATCH = 100;
const DEFAULT_TIMEOUT_MS = 30_000;
const COMMIT_TIMEOUT_MS = 120_000;
const MAX_STDOUT_BYTES = 20 * 1024 * 1024;
const MAX_STDERR_BYTES = 1 * 1024 * 1024;
const MAX_SYMLINK_DEPTH = 40;
const text = (bytes: Uint8Array) => new TextDecoder().decode(bytes);

function concatChunks(chunks: Uint8Array[], total: number): Uint8Array {
	if (chunks.length === 0) return new Uint8Array(0);
	if (chunks.length === 1) return chunks[0]!;
	const out = new Uint8Array(total);
	let offset = 0;
	for (const chunk of chunks) {
		out.set(chunk, offset);
		offset += chunk.byteLength;
	}
	return out;
}

async function readStreamCapped(
	reader: ReadableStreamDefaultReader<Uint8Array>,
	maxBytes: number,
	onOverflow?: () => void,
	drainAfterCap = false,
): Promise<{ bytes: Uint8Array; truncated: boolean }> {
	const chunks: Uint8Array[] = [];
	let total = 0;
	let truncated = false;
	try {
		for (;;) {
			const { value, done } = await reader.read();
			if (done) break;
			if (!value || value.byteLength === 0) continue;
			if (truncated) continue;
			if (total + value.byteLength > maxBytes) {
				const remaining = maxBytes - total;
				if (remaining > 0) {
					chunks.push(value.subarray(0, remaining));
					total += remaining;
				}
				truncated = true;
				if (onOverflow) onOverflow();
				if (!drainAfterCap) {
					await reader.cancel().catch(() => {});
					break;
				}
			} else {
				chunks.push(value);
				total += value.byteLength;
			}
		}
	} catch {
		// Stream cancelled or process killed.
	}
	return { bytes: concatChunks(chunks, total), truncated };
}

/** Resolves a path through symlinks (including missing leaf paths and dangling symlinks) with depth protection. */
function resolveRealPath(target: string, origPath: string, depth = 0): string {
	if (depth > MAX_SYMLINK_DEPTH) throw new Error(`outside the git repository: ${origPath}`);
	try {
		return realpathSync.native(target);
	} catch (e: any) {
		if (e?.code !== "ENOENT" && e?.code !== "ENOTDIR" && e?.code !== "ELOOP" && e?.code !== "EACCES") throw e;
	}
	try {
		const lst = lstatSync(target);
		if (lst.isSymbolicLink()) {
			const linkTarget = readlinkSync(target);
			const parentReal = resolveRealPath(dirname(target), origPath, depth + 1);
			return resolveRealPath(resolve(parentReal, linkTarget), origPath, depth + 1);
		}
	} catch (e: any) {
		if (e?.code !== "ENOENT" && e?.code !== "ENOTDIR") throw e;
	}
	const parent = dirname(target);
	if (parent === target) return target;
	const parentReal = resolveRealPath(parent, origPath, depth + 1);
	return resolve(parentReal, basename(target));
}

/** A path as a commit names it: from the repository's top, with no step up or sideways. A tab or a line break may be in a name, and is not refused. */
function isSafeRepoPath(p: string): boolean {
	if (!p || p.startsWith("/") || p.includes("\0")) return false;
	const parts = p.split("/");
	return !parts.some((seg) => seg === ".." || seg === ".");
}

const C_ESCAPES: Record<string, number> = { a: 7, b: 8, t: 9, n: 10, v: 11, f: 12, r: 13, '"': 34, "\\": 92 };

/**
 * A name as it is on disk, from how git prints it where it cannot be asked for the bare name (a blame's
 * `filename`): a name with a quote, a backslash or a control character in it comes between double quotes, with
 * backslash escapes (`"a\tb.txt"`, `\303\251` for a byte). Any other name is printed as it is, and given back so.
 */
export function unquoteGitPath(printed: string): string {
	if (printed.length < 2 || !printed.startsWith('"') || !printed.endsWith('"')) return printed;
	const body = printed.slice(1, -1);
	const bytes: number[] = [];
	const encoder = new TextEncoder();
	for (let at = 0; at < body.length; at++) {
		if (body[at] !== "\\") {
			// Escapes stand for bytes, so everything is put back as bytes and read as one text at the end.
			const plain = /^[^\\]+/.exec(body.slice(at))![0];
			bytes.push(...encoder.encode(plain));
			at += plain.length - 1;
			continue;
		}
		const octal = /^[0-3][0-7]{2}/.exec(body.slice(at + 1, at + 4))?.[0];
		if (octal) {
			bytes.push(Number.parseInt(octal, 8));
			at += 3;
			continue;
		}
		const next = body[++at] ?? "\\";
		bytes.push(C_ESCAPES[next] ?? next.charCodeAt(0));
	}
	return new TextDecoder().decode(Uint8Array.from(bytes));
}

function isSafeRangeRef(r: string): boolean {
	const clean = r.trim();
	if (!clean) return false;
	if (clean.startsWith("-")) return false;
	if (clean.includes("..")) return false;
	if (/[\x00-\x1f\x7f\s]/.test(clean)) return false;
	return /^[A-Za-z0-9._/~^@+-]+$/.test(clean);
}

function isSafeBranchName(clean: string): boolean {
	if (!clean) return false;
	if (clean.startsWith("-") || clean.startsWith("/") || clean.endsWith("/")) return false;
	if (clean === "@" || clean.includes("..") || clean.includes("//") || clean.includes("@{")) return false;
	if (/[\x00-\x1f\x7f\s~^:?*[\\]/.test(clean)) return false;
	return !clean.split("/").some((seg) => !seg || seg.startsWith(".") || seg.endsWith(".") || seg.endsWith(".lock"));
}

/** Parses `git ... --name-status -z` output cleanly without `.trim()` mangling filenames. */
function parseNameStatusZ(raw: string): { status: string; path: string; oldPath?: string }[] {
	const tokens = raw.split("\0");
	const out: { status: string; path: string; oldPath?: string }[] = [];
	for (let i = 0; i < tokens.length; ) {
		const status = tokens[i]!.replace(/^[\r\n]+/, "").trim();
		if (!status) {
			i++;
			continue;
		}
		i++;
		if (status.startsWith("R") || status.startsWith("C")) {
			const oldPath = tokens[i];
			const newPath = tokens[i + 1];
			i += 2;
			if (newPath) out.push({ status, path: newPath, oldPath });
		} else {
			const filePath = tokens[i];
			i += 1;
			if (filePath) out.push({ status, path: filePath });
		}
	}
	return out;
}

/**
 * Parses `git log --format="%x1e%H%x1f%h%x1f%ct%x1f%an%x1f%s[%x1f%b]" --name-status -z`
 * preserving exact filenames (including leading/trailing spaces) and annotating `repoPath` and `inWorkspace`.
 */
function parseCommitLogZ(
	raw: string,
	prefix: string,
	hasBody: boolean,
	filter?: (subject: string, body: string) => boolean,
): TicketGitCommit[] {
	const tokens = raw.split("\0");
	const commits: TicketGitCommit[] = [];
	let i = 0;
	while (i < tokens.length) {
		const headerToken = tokens[i]!.replace(/^[\r\n]+/, "");
		if (!headerToken.startsWith("\x1e")) {
			i++;
			continue;
		}
		i++;
		const fields = headerToken.slice(1).split("\x1f");
		const sha = fields[0] ?? "";
		const shortSha = fields[1] ?? "";
		const ct = fields[2] ?? "";
		const author = fields[3] ?? "";
		const subject = hasBody ? (fields[4] ?? "") : fields.slice(4).join(" ");
		const body = hasBody ? fields.slice(5).join("\x1f") : "";

		const files: TicketGitCommit["files"] = [];
		while (i < tokens.length) {
			const tok = tokens[i]!;
			if (tok === "") {
				i++;
				continue;
			}
			const trimmedStart = tok.replace(/^[\r\n]+/, "");
			if (trimmedStart.startsWith("\x1e")) break;
			const status = trimmedStart.trim();
			i++;
			if (!status) continue;
			let filePath: string | undefined;
			if (status.startsWith("R") || status.startsWith("C")) {
				filePath = tokens[i + 1];
				i += 2;
			} else {
				filePath = tokens[i];
				i += 1;
			}
			if (!filePath) continue;
			const inWorkspace = !prefix || filePath.startsWith(prefix);
			const rel = prefix && filePath.startsWith(prefix) ? filePath.slice(prefix.length) : filePath;
			files.push({ status, path: rel, repoPath: filePath, inWorkspace });
		}
		if (!sha || !shortSha) continue;
		if (filter && !filter(subject, body)) continue;
		commits.push({
			sha,
			shortSha,
			time: (Number(ct) || 0) * 1000,
			author,
			subject,
			files,
		});
	}
	return commits;
}

export class Git {
	private top: string | null | undefined;
	private realTop: string | null = null;
	/** Where the workspace's folder is inside the repository, as git says it: "" at its top, "app/" below it. */
	private prefix = "";
	/** Single deduplicated initialization promise so concurrent callers never observe `top` before `prefix`. */
	private repoInit?: Promise<string | null>;
	/** The question git is answering now, or answered last: the next one waits for it. */
	private last: Promise<unknown> = Promise.resolve();
	/** Active git child processes killed on `dispose()`. */
	private active = new Set<Subprocess<"ignore", "pipe", "pipe">>();
	private disposed = false;

	constructor(
		private readonly root: string,
		/** For tests: overrides the default subprocess timeout (30 s). */
		private readonly defaultTimeoutMs = DEFAULT_TIMEOUT_MS,
		/** For tests: overrides the default stdout byte cap (20 MB). */
		private readonly defaultMaxStdoutBytes = MAX_STDOUT_BYTES,
	) {}

	/** Terminates any active git child processes and prevents new ones from starting. */
	dispose(): void {
		this.disposed = true;
		for (const proc of this.active) {
			try {
				proc.kill();
			} catch {
				// Already exited.
			}
		}
		this.active.clear();
	}

	/**
	 * Runs git in the workspace's folder. It is given no keyboard, and told not to ask at the terminal. A file's
	 * name is only ever a name: "report[1].ssl" is that file, not a pattern that is also "report1.ssl".
	 */
	private run(args: string[], options?: RunOptions): Promise<Ran> {
		// One question at a time: two steps at once would meet at git's own lock on the repository, and one would fail.
		const next = this.last.then(
			() => this.spawn(args, options),
			() => this.spawn(args, options),
		);
		this.last = next;
		return next;
	}

	private async spawn(args: string[], options?: RunOptions): Promise<Ran> {
		if (this.disposed) throw new Error("git helper has been disposed.");
		const timeoutMs = options?.timeoutMs ?? this.defaultTimeoutMs;
		const maxStdoutBytes = options?.maxStdoutBytes ?? this.defaultMaxStdoutBytes;
		const cwd = options?.cwd ?? this.root;
		const proc = Bun.spawn(["git", "--no-optional-locks", "--literal-pathspecs", "-C", cwd, ...args], {
			stdin: "ignore",
			stdout: "pipe",
			stderr: "pipe",
			env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
		});
		this.active.add(proc);

		const stdoutReader = proc.stdout.getReader();
		const stderrReader = proc.stderr.getReader();
		let timer: ReturnType<typeof setTimeout> | undefined;
		const killProc = () => {
			try {
				proc.kill();
			} catch {
				// Already exited.
			}
		};

		const timeoutPromise = new Promise<never>((_, reject) => {
			timer = setTimeout(() => {
				void stdoutReader.cancel().catch(() => {});
				void stderrReader.cancel().catch(() => {});
				killProc();
				reject(new Error(`git ${args[0] ?? ""} timed out after ${timeoutMs >= 1000 ? `${Math.round(timeoutMs / 1000)} s` : `${timeoutMs} ms`}.`));
			}, timeoutMs);
		});

		const work = Promise.all([
			readStreamCapped(stdoutReader, maxStdoutBytes, killProc, false),
			readStreamCapped(stderrReader, MAX_STDERR_BYTES, undefined, true),
			proc.exited,
		]).then(([outRes, errRes, code]): Ran => ({
			code,
			out: outRes.bytes,
			err: text(errRes.bytes),
			...(outRes.truncated ? { truncated: true } : {}),
		}));

		try {
			return await Promise.race([work, timeoutPromise]);
		} finally {
			clearTimeout(timer);
			this.active.delete(proc);
			work.catch(() => {});
		}
	}

	/** Runs git and gives what it said; what it said went wrong, as an error, when it failed. */
	private async done(args: string[], options?: RunOptions): Promise<string> {
		const ran = await this.run(args, options);
		if (ran.truncated) throw new Error(`git ${args[0] ?? ""} output exceeded size limit.`);
		if (ran.code !== 0) throw new Error((ran.err || text(ran.out)).trim() || `git ${args[0]} failed`);
		return text(ran.out);
	}

	/** The repository's top folder, or null when the workspace is not in one (or there is no git to ask). */
	async repository(): Promise<string | null> {
		if (this.top !== undefined) return this.top;
		if (!this.repoInit) {
			this.repoInit = (async () => {
				try {
					const ran = await this.run(["rev-parse", "--show-toplevel"]);
					const rawTop = ran.code === 0 ? text(ran.out).replace(/\r?\n$/, "") : "";
					const top = rawTop ? resolve(rawTop) : null;
					let prefix = "";
					if (top) {
						const prefRan = await this.run(["-c", "core.quotePath=false", "rev-parse", "--show-prefix"]);
						if (prefRan.code === 0) {
							// Strip only the trailing newline so leading spaces in folder names survive.
							prefix = text(prefRan.out).replace(/\r?\n$/, "");
						}
						try {
							this.realTop = realpathSync.native(top);
						} catch {
							this.realTop = top;
						}
					} else {
						this.realTop = null;
					}
					// Commit `prefix` before `top` so no caller ever observes `top` without `prefix`.
					this.prefix = prefix;
					this.top = top;
					return top;
				} catch {
					this.prefix = "";
					this.realTop = null;
					this.top = null;
					return null;
				}
			})();
		}
		return this.repoInit;
	}

	/**
	 * Verifies that `path` resolves inside the enclosing git repository's top folder (following symlinks safely)
	 * and returns its resolved absolute path.
	 */
	async insideRepo(path: string): Promise<string> {
		const rel = await this.repoRelativeIfInside(path);
		if (rel === null) throw new Error(`outside the git repository: ${path}`);
		return resolve(path);
	}

	/** Returns the repo-root-relative POSIX path if `path` resolves inside `top`, else null. */
	private async repoRelativeIfInside(path: string): Promise<string | null> {
		const top = await this.repository();
		if (!top || !this.realTop) return null;
		try {
			const resolved = resolveRealPath(resolve(path), path);
			const rel = relative(this.realTop, resolved);
			if (!rel || rel.startsWith("..") || isAbsolute(rel)) return null;
			return rel.split(sep).join("/");
		} catch {
			return null;
		}
	}

	/** Queries currently staged renames from git's index (`git diff --cached --name-status -M -z`). */
	private async stagedRenames(): Promise<{ oldPath: string; newPath: string }[]> {
		const ran = await this.run(["-c", "core.quotePath=false", "diff", "--cached", "--name-status", "-M", "-z"]);
		if (ran.code !== 0 || ran.truncated) return [];
		return parseNameStatusZ(text(ran.out))
			.filter((e): e is { status: string; path: string; oldPath: string } => e.status.startsWith("R") && Boolean(e.oldPath))
			.map((e) => ({ oldPath: e.oldPath, newPath: e.path }));
	}

	/**
	 * True when `path` resolves inside the enclosing git repository AND is the staged rename source (`from`)
	 * of a file staged within the current workspace folder.
	 */
	async isStagedRenameSource(path: string): Promise<boolean> {
		const repoRel = await this.repoRelativeIfInside(path);
		if (!repoRel) return false;
		const fold = (p: string) => (process.platform === "win32" || process.platform === "darwin" ? p.toLowerCase() : p);
		const target = fold(repoRel);
		const prefixFold = fold(this.prefix);
		const renames = await this.stagedRenames();
		return renames.some((r) => fold(r.oldPath) === target && (!this.prefix || fold(r.newPath).startsWith(prefixFold)));
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

	/**
	 * Resolves a workspace path to its repo-root-relative path, or — when the path lives outside a subdirectory
	 * workspace but strictly inside the enclosing git repository `top` — verifies containment inside `top` and
	 * returns its repo-root-relative path.
	 */
	private async namedOrRepo(path: string): Promise<string> {
		const top = await this.repository();
		if (!top) throw new Error("This folder is not in a git repository.");
		const relToRoot = relative(this.root, resolve(path));
		if (!relToRoot.startsWith("..") && !isAbsolute(relToRoot)) {
			return this.prefix + relToRoot.split(sep).join("/");
		}
		const repoRel = await this.repoRelativeIfInside(path);
		if (repoRel === null) throw new Error(`outside the git repository: ${path}`);
		return repoRel;
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
		// Also surface cross-subdir staged renames whose source lived outside `this.prefix`.
		let stagedOutside = 0;
		const crossSubdirRenames = new Map<string, string>();
		if (this.prefix) {
			const cached = await this.run(["-c", "core.quotePath=false", "diff", "--cached", "--name-status", "-M", "-z"]);
			if (cached.code === 0 && !cached.truncated) {
				for (const entry of parseNameStatusZ(text(cached.out))) {
					if (!entry.path.startsWith(this.prefix)) stagedOutside++;
					else if (entry.status.startsWith("R") && entry.oldPath) crossSubdirRenames.set(entry.path, entry.oldPath);
				}
			}
		}
		return {
			...status,
			...(stagedOutside ? { stagedOutside } : {}),
			files: status.files.map((file) => {
				const crossFrom = !file.from && file.staged === "added" ? crossSubdirRenames.get(file.path) : undefined;
				const from = file.from ?? crossFrom;
				return {
					...file,
					...(crossFrom ? { staged: "renamed" as const } : {}),
					path: whole(file.path),
					...(from ? { from: whole(from) } : {}),
				};
			}),
		};
	}

	/**
	 * A file as it was: in the last commit ("head"), or as it is staged ("index"). Null when it was not there, or
	 * was not text.
	 */
	async base(path: string, from: "head" | "index"): Promise<string | null> {
		const gitPath = await this.namedOrRepo(path);
		const ran = await this.run(["show", `${from === "head" ? "HEAD" : ""}:${gitPath}`]);
		if (ran.truncated || ran.code !== 0 || looksBinary(ran.out)) return null;
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
			"-z",
			"--",
			relHere,
		]);
		if (ran.code !== 0) return [];
		const commits: GitCommit[] = [];
		let lastKnownPath = `${this.prefix}${relHere}`;
		// With -z a name is as it is on disk, ended by a NUL. On lines of its own git puts a name that has a quote, a
		// backslash, a tab or a line break in it between quotes with escapes, and no file in a commit has that name.
		let commit: GitCommit | undefined;
		for (const token of text(ran.out).split("\0")) {
			const header = token.replace(/^[\r\n]+(?=\x1e)/, "");
			if (header.startsWith("\x1e")) {
				const [sha, shortSha, ct, author, ...subjectParts] = header.slice(1).split("\x1f");
				commit = undefined;
				if (!sha || !shortSha) continue;
				// Until its own name follows, the file is where the commit after this one had it.
				commit = { sha, shortSha, time: (Number(ct) || 0) * 1000, author: author ?? "", subject: subjectParts.join(" "), path: lastKnownPath };
				commits.push(commit);
				continue;
			}
			// One line break stands between a commit's header and its file's name; any after it is the name's own.
			const listedPath = token.replace(/^\r?\n/, "");
			if (!listedPath || !commit) continue;
			commit.path = listedPath;
			lastKnownPath = listedPath;
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
			"--format=%x1e%H%x1f%h%x1f%ct%x1f%an%x1f%s%x1f%b",
			"--name-status",
			"-z",
			"--",
		]);
		if (ran.code !== 0) return [];
		const wordRe = new RegExp(`(?<![A-Za-z0-9_-])${cleanKey.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![A-Za-z0-9_-])`, "i");
		return parseCommitLogZ(text(ran.out), this.prefix, true, (subject, body) => wordRe.test(subject) || wordRe.test(body));
	}

	/** Reads a file's text at a specific Git commit SHA. Returns null if binary, missing, oversized, or invalid SHA. */
	async show(path: string, sha: string, repoPath?: string): Promise<string | null> {
		if (!/^[0-9a-f]{4,40}(~\d+|\^\d*)?$/i.test(sha.trim())) return null;
		if (!(await this.repository())) return null;
		let gitPath: string;
		if (repoPath !== undefined && repoPath.trim() !== "") {
			if (!isSafeRepoPath(repoPath)) return null;
			gitPath = repoPath;
		} else {
			gitPath = await this.named(path);
		}
		const ran = await this.run(["show", `${sha.trim()}:${gitPath}`]);
		if (ran.truncated || ran.code !== 0 || looksBinary(ran.out)) return null;
		try {
			return decode(ran.out).text;
		} catch {
			return null;
		}
	}

	/** Reads a file's text before (`sha~1`) and after (`sha`) a specific commit for commit-level diffing, following renames. */
	async commitFile(path: string, sha: string, repoPath?: string): Promise<{ before: string | null; after: string | null }> {
		const clean = sha.trim();
		if (!/^[0-9a-f]{4,40}$/i.test(clean)) return { before: null, after: null };
		if (!(await this.repository())) return { before: null, after: null };
		let gitPath: string;
		if (repoPath !== undefined && repoPath.trim() !== "") {
			if (!isSafeRepoPath(repoPath)) return { before: null, after: null };
			gitPath = repoPath;
		} else {
			gitPath = await this.named(path);
		}
		let parentGitPath = gitPath;
		const diffTree = await this.run([
			"-c",
			"core.quotePath=false",
			"diff-tree",
			"--no-commit-id",
			"-r",
			"-M",
			"--first-parent",
			"--name-status",
			"-z",
			clean,
		]);
		if (diffTree.code === 0 && !diffTree.truncated) {
			const renamed = parseNameStatusZ(text(diffTree.out)).find((e) => (e.status.startsWith("R") || e.status.startsWith("C")) && e.path === gitPath && e.oldPath);
			if (renamed?.oldPath) parentGitPath = renamed.oldPath;
		}
		const [before, after] = await Promise.all([
			this.show(path, `${clean}~1`, parentGitPath),
			this.show(path, clean, gitPath),
		]);
		return { before, after };
	}

	/** Local unified diff (staged or working tree), scoped to the workspace folder (or specific paths) and byte-capped. */
	async diff(options: { staged?: boolean; paths?: string[]; maxBytes?: number } = {}): Promise<string> {
		if (!(await this.repository())) return "";
		const args = ["-c", "core.quotePath=false", "diff", "--no-color", "--unified=3"];
		if (options.staged) args.push("--cached");
		if (options.paths?.length) {
			const rels = await Promise.all(options.paths.map((p) => this.here(p)));
			args.push("--", ...rels);
		} else {
			// Always scope to the workspace folder so parent-repo changes outside a subdir workspace are never leaked.
			args.push("--", ".");
		}
		const cap = Math.max(1024, options.maxBytes ?? 60_000);
		const maxStdoutBytes = Math.min(this.defaultMaxStdoutBytes, cap * 4 + 4096);
		const ran = await this.run(args, { maxStdoutBytes });
		if (ran.code !== 0 && !ran.truncated) return "";
		const out = text(ran.out);
		return ran.truncated || out.length > cap ? `${out.slice(0, cap)}\n... (diff truncated at ${cap} chars)` : out;
	}

	/** Local Git tags sorted newest-first by committer/tagger date. */
	async tags(): Promise<{ name: string; sha: string; time: number }[]> {
		if (!(await this.repository())) return [];
		const ran = await this.run(["for-each-ref", "--sort=-creatordate", "--format=%(refname:short)\x1f%(objectname:short)\x1f%(creatordate:unix)", "refs/tags"]);
		if (ran.code !== 0) return [];
		const out: { name: string; sha: string; time: number }[] = [];
		for (const line of text(ran.out).split(/\r?\n/)) {
			if (!line.trim()) continue;
			const [name, sha, ts] = line.split("\x1f");
			if (name && sha) out.push({ name, sha, time: (Number(ts) || 0) * 1000 });
		}
		return out;
	}

	/** Full HEAD commit SHA, or null outside a repository / unborn HEAD. */
	async headSha(): Promise<string | null> {
		if (!(await this.repository())) return null;
		const ran = await this.run(["rev-parse", "--verify", "HEAD"]);
		if (ran.code !== 0) return null;
		const sha = text(ran.out).trim();
		return /^[0-9a-f]{7,40}$/i.test(sha) ? sha : null;
	}

	/** Commits between `from` and `to` (defaults to HEAD) with changed file paths (ADR 0022). */
	async rangeLog(from: string, to = "HEAD", limit = 100): Promise<TicketGitCommit[]> {
		if (!(await this.repository())) return [];
		if (!isSafeRangeRef(from) || !isSafeRangeRef(to)) return [];
		const n = Math.max(1, Math.min(limit, 300));
		const ran = await this.run([
			"-c",
			"core.quotePath=false",
			"log",
			"-n",
			String(n),
			"--format=%x1e%H%x1f%h%x1f%ct%x1f%an%x1f%s",
			"--name-status",
			"-z",
			"--end-of-options",
			`${from.trim()}..${to.trim()}`,
			"--",
		]);
		if (ran.code !== 0) return [];
		return parseCommitLogZ(text(ran.out), this.prefix, false);
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

	/** Takes files out of the next commit, including both sides of staged renames. Their text in the folder stays as it is. */
	async unstage(paths: string[]): Promise<void> {
		if (!paths.length) return;
		const top = await this.repository();
		if (!top) throw new Error("This folder is not in a git repository.");
		const repoPaths = new Set<string>();
		for (const p of paths) {
			repoPaths.add(await this.namedOrRepo(p));
		}
		const committed = await this.hasCommit();
		if (committed) {
			const renames = await this.stagedRenames();
			for (const r of renames) {
				if (repoPaths.has(r.newPath)) repoPaths.add(r.oldPath);
			}
		}
		const all = [...repoPaths];
		// Before the first commit there is nothing to put the staged file back to: it is only taken out.
		const how = committed ? ["restore", "--staged", "--"] : ["rm", "--cached", "-r", "-q", "--"];
		for (let at = 0; at < all.length; at += BATCH) {
			await this.done([...how, ...all.slice(at, at + BATCH)], { cwd: top });
		}
	}

	/** Makes a commit of what is staged, with the user's own name and any checks their repository runs. Says what git said. */
	async commit(message: string): Promise<string> {
		if (!message.trim()) throw new Error("A commit needs a message.");
		return (await this.done(["commit", "-m", message], { timeoutMs: COMMIT_TIMEOUT_MS })).split("\n")[0] ?? "";
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

	/** Single-line Git blame attribution (`git blame -L line,line --porcelain -- <rel>`). Null outside a repo or on untracked files. */
	async blameLine(path: string, line: number): Promise<GitBlameLine | null> {
		const lineNum = Math.floor(Number(line));
		if (!Number.isFinite(lineNum) || lineNum < 1) return null;
		if (!(await this.repository())) return null;
		const relHere = await this.here(path);
		const ran = await this.run(["-c", "core.quotePath=false", "blame", "-L", `${lineNum},${lineNum}`, "--porcelain", "--", relHere]);
		if (ran.code !== 0) return null;
		const lines = text(ran.out).split(/\r?\n/);
		const headMatch = /^([0-9a-f]{40})\b/i.exec(lines[0] ?? "");
		if (!headMatch) return null;
		const sha = headMatch[1]!;
		const shortSha = sha.slice(0, 7);
		let author = "";
		let authorTime = 0;
		let summary = "";
		let filename = "";
		for (const ln of lines.slice(1)) {
			if (ln.startsWith("\t")) break;
			if (ln.startsWith("author ")) author = ln.slice("author ".length).trim();
			else if (ln.startsWith("author-time ")) authorTime = Number(ln.slice("author-time ".length).trim()) || 0;
			else if (ln.startsWith("summary ")) summary = ln.slice("summary ".length).trim();
			else if (ln.startsWith("filename ")) filename = unquoteGitPath(ln.slice("filename ".length));
		}
		const date = authorTime > 0 ? new Date(authorTime * 1000).toISOString().slice(0, 10) : "";
		const ticket = /\b([A-Z]{2,12}-\d+)\b/.exec(summary)?.[1];
		return {
			sha,
			shortSha,
			author,
			date,
			summary,
			...(ticket ? { ticket } : {}),
			...(filename ? { filename } : {}),
		};
	}

	/** Local Git branches sorted with the active branch first, then most recently committed. Null outside a repository. */
	async branches(): Promise<GitBranchesResult | null> {
		if (!(await this.repository())) return null;
		const ran = await this.run([
			"for-each-ref",
			"--sort=-committerdate",
			"--format=%(HEAD)\x1f%(refname:short)\x1f%(upstream:short)\x1f%(subject)",
			"refs/heads",
		]);
		if (ran.code !== 0) return null;
		const list: GitBranchInfo[] = [];
		for (const ln of text(ran.out).split(/\r?\n/)) {
			if (!ln.trim()) continue;
			const [headMark, name, upstream, ...subjectParts] = ln.split("\x1f");
			const cleanName = (name ?? "").trim();
			if (!cleanName) continue;
			const current = (headMark ?? "").trim() === "*";
			const up = (upstream ?? "").trim();
			const lastSubject = subjectParts.join(" ").trim();
			list.push({
				name: cleanName,
				current,
				...(up ? { upstream: up } : {}),
				...(lastSubject ? { lastSubject } : {}),
			});
		}
		list.sort((a, b) => Number(b.current) - Number(a.current));
		let current = list.find((b) => b.current)?.name ?? "";
		if (!current) {
			const sym = await this.run(["symbolic-ref", "--short", "HEAD"]);
			if (sym.code === 0) current = text(sym.out).trim();
			else {
				const det = await this.run(["rev-parse", "--short", "HEAD"]);
				if (det.code === 0) current = text(det.out).trim();
			}
		}
		return { current, branches: list };
	}

	/** Switches to an existing local Git branch after validating the ref name safely. */
	async checkout(branch: string): Promise<GitActionResult> {
		if (!(await this.repository())) return { ok: false, message: "This folder is not in a git repository." };
		const clean = branch.trim();
		if (!isSafeBranchName(clean)) {
			return { ok: false, message: `Invalid branch name: ${branch}` };
		}
		const check = await this.run(["show-ref", "--verify", "--quiet", `refs/heads/${clean}`]);
		if (check.code !== 0) return { ok: false, message: `Local branch "${clean}" was not found.` };
		let ran = await this.run(["switch", "--no-guess", "--", clean]);
		if (ran.code !== 0 && /not a git command|unknown option/i.test(ran.err)) {
			ran = await this.run(["checkout", clean, "--"]);
		}
		const msg = (ran.err || text(ran.out)).trim();
		if (ran.code !== 0) return { ok: false, message: msg || `Could not switch to branch '${clean}'.` };
		return { ok: true, message: msg || `Switched to branch '${clean}'.` };
	}

	/** Pushes, pops, or lists local Git stash entries. */
	async stash(action: "push" | "pop" | "list", message?: string): Promise<GitStashResult> {
		if (!(await this.repository())) return { ok: false, message: "This folder is not in a git repository." };
		if (action === "list") {
			const ran = await this.run(["stash", "list", "--format=%gd\x1f%gs"]);
			if (ran.code !== 0) {
				return { ok: false, message: (ran.err || text(ran.out)).trim() || "git stash list failed", entries: [] };
			}
			const entries: { ref: string; message: string }[] = [];
			for (const ln of text(ran.out).split(/\r?\n/)) {
				if (!ln.trim()) continue;
				const [ref, ...rest] = ln.split("\x1f");
				if (ref?.trim()) entries.push({ ref: ref.trim(), message: rest.join(" ").trim() });
			}
			return {
				ok: true,
				message: entries.length ? `${entries.length} stash ${entries.length === 1 ? "entry" : "entries"}.` : "No stash entries.",
				entries,
			};
		}
		if (action === "push") {
			const cleanMsg = message?.trim();
			/**
			 * Below the repository's top a stash takes the workspace's folder and nothing else: without a path it took
			 * every change in the repository, also in folders the workspace does not show. The path is "." read the
			 * usual way, not as a literal name: told to read names literally, git 2.43 stashes the folder's changes
			 * and then throws away the changes outside it. Files git does not follow stay where they are, as before.
			 */
			const args = this.prefix
				? ["--no-literal-pathspecs", "stash", "push", ...(cleanMsg ? ["-m", cleanMsg] : []), "--", "."]
				: ["stash", "push", ...(cleanMsg ? ["-m", cleanMsg] : [])];
			const ran = await this.run(args);
			const out = (text(ran.out) || ran.err).trim();
			// A folder in which git follows no file has nothing a stash could hold.
			if (ran.code !== 0 && this.prefix && /did not match any file/i.test(out)) return { ok: false, message: "No local changes to save." };
			if (ran.code !== 0) return { ok: false, message: out || "git stash push failed." };
			if (/no local changes to save/i.test(out)) return { ok: false, message: "No local changes to save." };
			return { ok: true, message: out.split("\n")[0] || "Saved working tree changes to stash." };
		}
		if (action === "pop") {
			const ran = await this.run(["stash", "pop"]);
			const out = (text(ran.out) || ran.err).trim();
			if (ran.code !== 0) return { ok: false, message: (ran.err || text(ran.out)).trim() || "git stash pop failed." };
			return { ok: true, message: out.split("\n")[0] || "Applied and dropped top stash entry." };
		}
		return { ok: false, message: `Unsupported stash action: ${String(action)}` };
	}
}
