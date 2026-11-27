// Files inside one workspace folder. Every path the UI sends is absolute
// and must stay inside the root.
import {
	accessSync,
	chmodSync,
	constants,
	existsSync,
	lstatSync,
	mkdirSync,
	readdirSync,
	readlinkSync,
	realpathSync,
	renameSync,
	rmSync,
	statSync,
	watch,
	type FSWatcher,
} from "node:fs";
import { cp, open, rm, writeFile } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import type { Entry, FileText, SearchHit } from "../shared/protocol";
import {
	excerptForMatch,
	matchesOn,
	REGEX_MAX_LINE_LENGTH,
	replaceIn,
	SEARCH_LIMIT,
	SEARCH_MAX_TEXT,
	searchPattern,
	textMark,
	withGroups,
	type OpenText,
	type SearchOptions,
} from "../shared/searchPattern";
import { createFileFilter } from "../shared/fileGlob";
import { replaceSafeInText } from "../shared/menuBar";
import { renameReplacing } from "./atomic";
import { decode, encode, encodingOf, isEncoding, looksBinary, textOf, type Encoding } from "./encoding";
import { imageType, sizeText, SNIFF_BYTES } from "../shared/fileKind";
import { UNLISTED } from "../shared/paths";
import { Serial } from "./serial";

const SKIP = new Set<string>(UNLISTED);
const TMP_SUFFIX = ".ssl-studio-tmp";
const OWN_WRITE_TTL_MS = 5000;
const MAX_SYMLINK_DEPTH = 40;

const foldPath = (p: string) => (process.platform === "win32" || process.platform === "darwin" ? p.toLowerCase() : p);

const foldsCaseKnown = new Map<string, boolean>();

/**
 * Whether names in `root` are compared without case. On Windows and macOS that is the usual answer but not the
 * only one: an APFS volume can be case-sensitive, and so can a Windows folder, and there `proj` and `PROJ` are two
 * folders, one of them outside the workspace. So the folder is asked rather than the platform: its own path with
 * the case of its letters swapped is the same folder (names fold), no folder at all, or another one (they do not).
 * Where it cannot say, the answer is the platform's usual one.
 */
export function foldsCase(root: string): boolean {
	if (process.platform !== "win32" && process.platform !== "darwin") return false;
	const known = foldsCaseKnown.get(root);
	if (known !== undefined) return known;
	const swapped = root.replace(/[a-zA-Z]/g, (ch) => (ch === ch.toLowerCase() ? ch.toUpperCase() : ch.toLowerCase()));
	let here: ReturnType<typeof statSync>;
	try {
		here = statSync(root);
	} catch {
		return true;
	}
	let folds = true;
	if (swapped !== root) {
		try {
			const there = statSync(swapped);
			folds = here.dev === there.dev && here.ino === there.ino;
		} catch (e: any) {
			if (e?.code === "ENOENT" || e?.code === "ENOTDIR") folds = false;
		}
	}
	foldsCaseKnown.set(root, folds);
	return folds;
}

/**
 * A Windows path with what is never told apart by case folded: the drive's letter, and the server and share of a
 * network path. A folder there can be case-sensitive (one made from WSL, or marked so), and then its paths are
 * compared as written; but `C:` and `c:` are one drive all the same, and the editor writes the letter small in
 * every path it sends. Compared as written to the last letter, each file of such a workspace was "outside the
 * workspace". Other systems have no such part of a path, and theirs come back as they are.
 */
export function foldVolume(p: string, win32 = process.platform === "win32"): string {
	if (!win32) return p;
	const volume = /^(?:[a-zA-Z]:|[\\/]{2}[^\\/]+[\\/]+[^\\/]+)/.exec(p)?.[0];
	return volume ? volume.toLowerCase() + p.slice(volume.length) : p;
}

/** How two paths in `root` are compared: without case where its names fold (`foldsCase`), else as written but for the volume. */
const folding = (root: string) => (foldsCase(root) ? (p: string) => p.toLowerCase() : (p: string) => foldVolume(p));

/** Ensures a trailing path separator without doubling root paths like `/` or `C:\`. */
export function withSep(p: string): string {
	return p.endsWith(sep) ? p : p + sep;
}

/**
 * Resolves `target` through symlinks (including dangling symlinks and non-existent descendants),
 * stopping at `MAX_SYMLINK_DEPTH` to defeat symlink loops.
 */
export function resolveRealPath(target: string, origPath = target, depth = 0): string {
	if (depth > MAX_SYMLINK_DEPTH) throw new Error(`outside the workspace: ${origPath}`);
	let realErr: any = null;
	try {
		return realpathSync.native(target);
	} catch (e: any) {
		realErr = e;
		if (e?.code !== "ENOENT" && e?.code !== "ENOTDIR" && e?.code !== "ELOOP" && e?.code !== "EACCES") throw e;
	}
	// Check whether `target` itself is a dangling/unreadable symlink (or symlink loop) before walking to its parent.
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
	if (realErr?.code === "EACCES") throw realErr;
	const parent = dirname(target);
	if (parent === target) return target;
	const parentReal = resolveRealPath(parent, origPath, depth + 1);
	return resolve(parentReal, basename(target));
}

/**
 * Verifies that `target` stays inside `root` both lexically and after resolving existing
 * ancestors and symlinks (including dangling symlinks), without case where the folder's names fold (`foldsCase`).
 * When `strict` is true, `target` equal to `root` is rejected.
 */
export function isPathInsideRoot(root: string, target: string, strict = false): boolean {
	try {
		const resolvedRoot = resolve(root);
		const resolvedTarget = resolve(target);
		const fold = folding(resolvedRoot);
		const rootF = fold(resolvedRoot);
		const targetF = fold(resolvedTarget);
		const lexInside = strict ? targetF.startsWith(withSep(rootF)) : targetF === rootF || targetF.startsWith(withSep(rootF));
		if (!lexInside) return false;
		const realRoot = realpathSync.native(resolvedRoot);
		const realTarget = resolveRealPath(resolvedTarget, target);
		const realRootF = fold(realRoot);
		const realTargetF = fold(realTarget);
		return strict ? realTargetF.startsWith(withSep(realRootF)) : realTargetF === realRootF || realTargetF.startsWith(withSep(realRootF));
	} catch {
		return false;
	}
}

/** Throws if `target` escapes `root` lexically or via any symlink (including dangling symlinks). */
export function assertPathInsideRoot(root: string, target: string, strict = false): string {
	const full = resolve(target);
	if (!isPathInsideRoot(root, full, strict)) {
		throw new Error(`outside the workspace: ${target}`);
	}
	return full;
}

/**
 * The work on each file, one after another. One for the whole process, not for each open folder: a folder opened
 * again is the same files.
 */
const writes = new Serial();

/**
 * A file that has other names (hard links), read or written where it is, one such piece of work after another
 * whatever name each came by. Such a file is not replaced by a save but emptied and filled (`atomicWriteFile`),
 * and `writes` lines the saves up by the name they were asked under, which is one line to each of its names: two
 * saves of it by two names ran at once, and the file was left a mix of the two texts. Here the file is known by
 * what it is on the disk, not by a name.
 *
 * A place here is only ever taken by work that has its place in `writes` already, never the other way round, and
 * what runs here is one reading or one writing of the file, which waits for no line at all: so nothing here can
 * be kept waiting without end. Work on a folder (`held`, `quiet`) looks only at `writes`, and still sees each of
 * these saves there, under the name it came by, until it has ended.
 */
const linked = new Serial();

/** A file's own name in `linked`: the disk it is on and its number there, which every name of it gives alike. */
const linkedKey = (there: { dev: number | bigint; ino: number | bigint }) => `${there.dev}:${there.ino}`;

/**
 * One name for a file however it was reached: through a link to its folder, through a link to itself, or in other
 * capitals where the disk does not tell them apart. Two saves of it by two names wait on each other as two by one do.
 */
export function fileKey(full: string): string {
	// The nearest part of the path that is there has a real name; what is not there yet keeps the name it was given.
	// So a file in a folder still to be made is known by one name before the folder is made and after.
	const rest: string[] = [];
	let there = resolve(full);
	while (!existsSync(there) && dirname(there) !== there) {
		rest.unshift(basename(there));
		there = dirname(there);
	}
	let key = full;
	try {
		key = join(realpathSync.native(there), ...rest);
	} catch {
		// What has no real name to be asked for keeps the name it was given.
	}
	// The first part that is not there may be a link to a file still to be made. A save through it makes that file
	// (`landing`), so it is that file's name the save waits under, with a save of the file by its own name.
	if (rest.length) {
		try {
			if (lstatSync(join(there, rest[0]!)).isSymbolicLink()) key = resolveRealPath(resolve(full));
		} catch {
			// Nothing of that name, or a link that leads round to itself: the name it was given.
		}
	}
	return process.platform === "win32" || process.platform === "darwin" ? key.toLowerCase() : key;
}

/** True for a folder that is there. */
const isFolder = (full: string) => {
	try {
		return statSync(full).isDirectory();
	} catch {
		return false;
	}
};

const SEARCH_MAX_BYTES = 4 * 1024 * 1024;
/** Default safety time budget (ms) for a workspace search scan. */
const SEARCH_TIMEOUT_MS = 5000;
/** The largest picture that is sent to the window to be shown. */
const IMAGE_MAX_BYTES = 20 * 1024 * 1024;
/**
 * The largest text that is read to be opened. 20 MB is the most the app takes anywhere else (a file dropped on the
 * Explorer, an import, an export, a picture), so what was put into a workspace through the app can be opened in
 * it; it is the size from which the editor itself stops colouring and checking a file; and it leaves room, in the
 * 32 MB the browser host carries in one message, for what JSON adds to a text.
 */
export const READ_MAX_BYTES = 20 * 1024 * 1024;

export class WorkspaceFiles {
	readonly root: string;
	private readonly realRoot: string;
	private watcher?: FSWatcher;
	/** How long work on a folder waits for the saves inside it to stop coming, in milliseconds. */
	static quietMs = 10_000;
	/** Safety time budget (ms) for `search()` across workspace files. */
	static searchTimeoutMs = SEARCH_TIMEOUT_MS;
	/** How a folder is moved: the system's rename, once. Here so that a test can make it fail as Windows does. */
	static moveFolder: (from: string, to: string) => void = renameSync;
	/** Paths (normalized via fileKey) this process wrote recently; their watch events are not external changes. */
	private ownWrites = new Map<string, number>();

	constructor(root: string) {
		this.root = resolve(root);
		if (!statSync(this.root).isDirectory()) throw new Error(`not a folder: ${root}`);
		this.realRoot = realpathSync.native(this.root);
	}

	inside(path: string): string {
		const full = resolve(path);
		// Without case where this folder's names fold: the usual on Windows and macOS, but asked of the folder
		// (`foldsCase`), since on a case-sensitive volume a sibling whose name differs only by case is another folder.
		const fold = folding(this.root);
		const fullF = fold(full);
		const rootF = fold(this.root);
		if (fullF !== rootF && !fullF.startsWith(withSep(rootF))) {
			throw new Error(`outside the workspace: ${path}`);
		}
		// Resolve real path through symlinks (including dangling symlinks and non-existent descendants).
		const resolvedReal = resolveRealPath(full, path);
		const realF = fold(resolvedReal);
		const realRootF = fold(this.realRoot);
		if (realF !== realRootF && !realF.startsWith(withSep(realRootF))) {
			throw new Error(`outside the workspace: ${path}`);
		}
		return full;
	}

	list(dir: string): Entry[] {
		const full = this.inside(dir);
		const out: Entry[] = [];
		for (const d of readdirSync(full, { withFileTypes: true })) {
			if (SKIP.has(d.name) || d.name.endsWith(TMP_SUFFIX)) continue;
			if (!d.isDirectory() && !d.isFile()) continue;
			const path = join(full, d.name);
			if (d.isDirectory()) {
				out.push({ name: d.name, path, kind: "dir", size: 0 });
			} else {
				try {
					out.push({ name: d.name, path, kind: "file", size: statSync(path).size });
				} catch {
					// File vanished between readdir and stat.
				}
			}
		}
		return out.sort((a, b) => (a.kind === b.kind ? a.name.localeCompare(b.name, undefined, { sensitivity: "base" }) : a.kind === "dir" ? -1 : 1));
	}

	/**
	 * A file's text, read as what the file is written in. A picture, or other bytes that are not text, is not read
	 * as text: it comes back with no text, and says what it is.
	 */
	async read(path: string): Promise<FileText> {
		const full = this.inside(path);
		try {
			const st = statSync(full);
			if (!st.isFile()) {
				const err = new Error(`${relative(this.root, full)} is not a file`) as NodeJS.ErrnoException;
				if (st.isDirectory()) err.code = "EISDIR";
				throw err;
			}
			const mtime = st.mtimeMs;
			const image = imageType(full);
			if (image) return { path: full, text: "", mtime, binary: { size: st.size, image } };
			const file = Bun.file(full);
			const sniff = new Uint8Array(await file.slice(0, SNIFF_BYTES).arrayBuffer());
			if (looksBinary(sniff, true)) return { path: full, text: "", mtime, binary: { size: st.size } };
			// Asked of the file's size before any more of it is read: a text of gigabytes (a dump, a log) was read whole
			// into memory and handed to the window, which could not hold it either.
			if (st.size > READ_MAX_BYTES) {
				const err = new Error(`${relative(this.root, full)} is ${sizeText(st.size)}: too large to open here (the most is ${sizeText(READ_MAX_BYTES)}).`) as NodeJS.ErrnoException;
				err.code = "EFBIG";
				throw err;
			}
			const bytes = st.size <= SNIFF_BYTES && sniff.length === st.size ? sniff : new Uint8Array(await file.arrayBuffer());
			const { text, encoding } = decode(bytes);
			return { path: full, text, mtime, encoding };
		} catch (e: any) {
			// What the file system says is left as it says it; what the reading found names the file.
			throw e instanceof Error && !("code" in e) ? new Error(`${relative(this.root, full)}: ${e.message}`) : e;
		}
	}

	/**
	 * Writes through a temporary file, so a crash never leaves half a script (but for a file with other names, and
	 * never over a read-only one: `atomicWriteFile`). A file is written in what it is
	 * written in now, mark and all; a new file in UTF-8. Writes of one file go one after another, in the order
	 * they were asked for: asked for at once (Ctrl+S twice), they used to share the temporary file, and one failed
	 * or the file was left with the older text.
	 */
	async write(path: string, text: string, asText = false, encoding?: string) {
		const full = this.inside(path);
		return writes.run(fileKey(full), () => this.writeNow(full, text, asText, encoding));
	}

	/**
	 * Atomic serialized binary write inside the workspace (used for `.docx` exports and extracted images).
	 */
	async writeBytes(path: string, bytes: Uint8Array): Promise<{ path: string; size: number; mtime: number }> {
		const full = this.inside(path);
		return writes.run(fileKey(full), async () => {
			this.inside(full);
			await this.atomicWriteFile(full, bytes);
			return { path: full, size: bytes.byteLength, mtime: statSync(full).mtimeMs };
		});
	}

	/**
	 * Work on one file that no save of it runs beside, and that the saves asked for after it wait for: reading it
	 * and writing it as one step (a replace across files), renaming it, throwing it away. The work is given the
	 * write itself: `write` here would wait for the work it is part of.
	 */
	async alone<T>(path: string, work: (write: (text: string, asText?: boolean, encoding?: string) => Promise<{ mtime: number }>) => Promise<T> | T): Promise<T> {
		const full = this.inside(path);
		return this.held([full], () => work((text, asText = false, encoding) => this.writeNow(full, text, asText, encoding)));
	}

	/**
	 * Work that has each of these files to itself: no save of any of them runs beside it, and the saves asked for
	 * after it wait. Taken in one order whatever order they are named in, so that two such pieces of work on the
	 * same two files never each wait for the other. A folder among them is waited for first: nothing in it is being
	 * saved when the work starts (moved or thrown away in the middle of a save inside it, the folder would have come
	 * back with that one file in it).
	 */
	private async held<T>(paths: string[], work: () => Promise<T> | T): Promise<T> {
		const folders = paths.filter(isFolder);
		const keys = [...new Set(paths.map(fileKey))];
		// A folder is waited for before the files are taken, so that work on it does not hold its own name while it
		// waits; and looked at once more when they are held, for a save asked for in between.
		if (folders.length) await this.quiet(folders, keys, () => undefined);
		// A place is taken in every file's line in this one turn (with no folder among them, the turn the work was
		// asked for): work and saves of one file keep the order they were asked in, whatever the files are called,
		// and two pieces of work on the same files stand in the same order in every line, so neither waits for the
		// other without end. Each place is kept until the work is done.
		let letGo!: () => void;
		const done = new Promise<void>((resolve) => (letGo = resolve));
		const taken = keys.map((key) => new Promise<void>((got) => void writes.run(key, () => (got(), done))));
		try {
			await Promise.all(taken);
			return await (folders.length ? this.quiet(folders, keys, work) : work());
		} finally {
			letGo();
		}
	}

	/**
	 * Waits until nothing in these folders is being saved or waiting to be (the files this work holds itself
	 * apart), and then does the work in the same turn as that last look: nothing can be asked for between the two.
	 * Not for ever: a folder saved into without a pause for this long, or held by work that is itself waiting for
	 * this (two folders moved into each other at once), is said to be busy, and the work is not done.
	 */
	private async quiet<T>(folders: string[], own: string[], work: () => Promise<T> | T): Promise<T> {
		const inside = folders.map((folder) => withSep(fileKey(folder)));
		const until = Date.now() + WorkspaceFiles.quietMs;
		for (;;) {
			const pending = writes.pending((other) => !own.includes(other) && inside.some((folder) => other.startsWith(folder)));
			if (!pending.length) return work();
			const left = until - Date.now();
			if (left <= 0) throw new Error(`${folders.map((folder) => relative(this.root, folder) || basename(folder)).join(", ")} is being saved into without a pause, so nothing was done to it. Try again in a moment.`);
			// Until what is under way has ended, or the time is up, whichever comes first: what is waited for may
			// itself be waiting for this.
			let timer: ReturnType<typeof setTimeout> | undefined;
			await Promise.race([Promise.all(pending), new Promise<void>((resolve) => (timer = setTimeout(resolve, left)))]);
			clearTimeout(timer);
		}
	}

	private markOwnWrite(full: string) {
		const now = Date.now();
		for (const [k, ts] of this.ownWrites) {
			if (now - ts > OWN_WRITE_TTL_MS) this.ownWrites.delete(k);
		}
		this.ownWrites.set(fileKey(full), now);
	}

	/**
	 * Where a write of `full` lands: the file itself, or for a link the file it leads to, there yet or not. The
	 * temporary file renamed over the link's own name left a plain file where the link was, and the file the link
	 * named kept the old text. What the link leads to is looked up here and held to the folder here, so that the
	 * place written is the place that was checked.
	 */
	private landing(full: string): string {
		try {
			if (!lstatSync(full).isSymbolicLink()) return full;
		} catch (e: any) {
			if (e?.code !== "ENOENT" && e?.code !== "ENOTDIR") throw e;
			return full;
		}
		const real = resolveRealPath(full);
		const fold = folding(this.root);
		if (!fold(real).startsWith(withSep(fold(this.realRoot)))) throw new Error(`outside the workspace: ${full}`);
		return real;
	}

	private async atomicWriteFile(named: string, bytes: Uint8Array, mode?: number) {
		this.inside(named);
		const full = this.landing(named);
		mkdirSync(dirname(full), { recursive: true });
		let there: ReturnType<typeof lstatSync> | undefined;
		try {
			there = lstatSync(full);
		} catch (e: any) {
			if (e?.code !== "ENOENT" && e?.code !== "ENOTDIR") throw e;
		}
		if (there?.isFile()) {
			// A file this user may not write is not written. The temporary file renamed over its name asks the folder
			// and not the file, so a file made read-only on purpose was replaced without a word. Its permissions are
			// the user's to change, not this program's.
			let writable = true;
			try {
				accessSync(full, constants.W_OK);
			} catch (e: any) {
				writable = !(e?.code === "EACCES" || e?.code === "EPERM" || e?.code === "EROFS");
			}
			if (!writable) throw new Error(`${relative(this.root, named)} is read-only: it is not written over from here. Make the file writable, then save again.`);
			// A file with other names (hard links) is written where it is: the temporary file renamed over this name
			// gave the name a file of its own, and the other names kept the old text. What is given up for that is the
			// rename's all-or-nothing: a crash or a full disk part of the way leaves the file cut short under every name,
			// and a reader in that moment sees it so.
			if (there.nlink > 1) {
				// One such write of the file at a time, by whatever names they come (`linked`): the line a save stands
				// in is its name's, and two names of one file are two lines.
				await linked.run(linkedKey(there), async () => {
					this.markOwnWrite(full);
					const fh = await open(full, process.platform === "win32" ? "w" : constants.O_WRONLY | constants.O_TRUNC | (constants.O_NOFOLLOW ?? 0));
					try {
						await fh.writeFile(bytes);
					} finally {
						await fh.close();
					}
					this.markOwnWrite(full);
				});
				return;
			}
		}
		// A short name of its own, not the file's name with more after it: a name near the 255 bytes a file system
		// allows could be created and then never saved, since its temporary file's name was longer than any name may
		// be. Still told by what it ends with, which is what the listings and the watcher leave out.
		const temp = join(dirname(full), `.${process.pid}.${randomBytes(6).toString("hex")}${TMP_SUFFIX}`);
		const flags =
			process.platform === "win32"
				? "wx"
				: constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0);
		let created = false;
		try {
			const fh = await open(temp, flags, 0o666).catch((e: any) => {
				// A folder that takes no new file takes no temporary one. What the system says of that names the
				// temporary file, which nobody asked to save and no listing shows: the file that was to be saved is
				// named here, and what stands in the way of it.
				if (e?.code !== "EACCES" && e?.code !== "EPERM" && e?.code !== "EROFS") throw e;
				// The folder is named too: through a link it is another than the one the file is named in (and is then
				// known by its real name, as the workspace's own folder has to be to say where in it that is).
				const folder = dirname(full);
				const within = relative(full === named ? this.root : this.realRoot, folder);
				throw new Error(`${relative(this.root, named)} cannot be saved: the folder ${within || basename(folder)} does not take new files, and a save is written to a new file first. Make the folder writable, then save again.`);
			});
			created = true;
			try {
				await fh.writeFile(bytes);
			} finally {
				await fh.close();
			}
			if (mode !== undefined) {
				try {
					chmodSync(temp, mode);
				} catch {
					// A system that keeps no such thing has nothing to carry over.
				}
			}
			this.markOwnWrite(full);
			await renameReplacing(temp, full);
			created = false;
			this.markOwnWrite(full);
		} catch (e) {
			if (created) {
				try {
					rmSync(temp, { force: true });
				} catch {
					// Best-effort cleanup of temp file.
				}
			}
			throw e;
		}
	}

	private async writeNow(full: string, text: string, asText: boolean, wanted?: string) {
		// Re-check containment inside the serialized lock (blocks symlinks pointing outside root).
		this.inside(full);
		// A picture by its name is never text, even if the file does not exist yet.
		if (imageType(full)) throw new Error(`${relative(this.root, full)} is not text: it is not written over from here.`);

		let encoding: Encoding = "utf-8";
		let bytesNow: Uint8Array | null = null;
		let prevMode: number | undefined;
		try {
			const st = lstatSync(full);
			if (st.isDirectory()) {
				const err = new Error(`EISDIR: illegal operation on a directory, open '${full}'`) as NodeJS.ErrnoException;
				err.code = "EISDIR";
				throw err;
			}
			// The file itself: for a link, the one it leads to.
			let file = st;
			if (st.isSymbolicLink()) {
				const targetStat = statSync(full);
				if (targetStat.isDirectory()) {
					const err = new Error(`EISDIR: illegal operation on a directory, open '${full}'`) as NodeJS.ErrnoException;
					err.code = "EISDIR";
					throw err;
				}
				prevMode = targetStat.mode;
				file = targetStat;
			} else {
				prevMode = st.mode;
			}
			// A file with other names is read between two writes of it and not in the middle of one (`linked`). A
			// save by another of its names empties the file before it fills it: read just then it had no mark and no
			// bytes to tell its encoding by, and this save wrote a UTF-16 file back as plain UTF-8.
			const whole = async () => new Uint8Array(await Bun.file(full).arrayBuffer());
			bytesNow = await (file.nlink > 1 ? linked.run(linkedKey(file), whole) : whole());
		} catch (e: any) {
			if (e?.code !== "ENOENT") throw e;
			// ENOENT: new file, write as UTF-8.
		}
		// What is read as bytes has no text here, and text written over it would be the end of it.
		// Other bytes are let be, unless what is written is known to be the file's own text
		// (a zero byte typed into it, and saved, makes it look like bytes from then on).
		if (bytesNow && looksBinary(bytesNow) && !asText) {
			throw new Error(`${relative(this.root, full)} is not text: it is not written over from here.`);
		}
		// In the encoding the text was read in, where the editor says which: VS Code keeps a file's too. Worked out
		// again from the bytes on disk, a Windows-1252 file that a save had left plain ASCII was written as UTF-8 at
		// the next, its "µ" two bytes, while the editor still said Windows-1252.
		if (isEncoding(wanted)) encoding = wanted;
		else if (bytesNow) encoding = encodingOf(bytesNow);
		let bytes: Uint8Array;
		try {
			bytes = encode(text, encoding);
		} catch (e: any) {
			throw new Error(`${relative(this.root, full)}: ${e?.message ?? e}`);
		}
		await this.atomicWriteFile(full, bytes, prevMode);
		return { mtime: statSync(full).mtimeMs };
	}

	async create(path: string, kind: "file" | "dir") {
		const full = this.inside(path);
		await writes.run(fileKey(full), async () => {
			this.inside(full);
			let exists = false;
			try {
				lstatSync(full);
				exists = true;
			} catch (e: any) {
				if (e?.code !== "ENOENT") throw e;
			}
			if (exists) throw new Error(`already exists: ${relative(this.root, full)}`);
			if (kind === "dir") {
				mkdirSync(dirname(full), { recursive: true });
				try {
					mkdirSync(full);
				} catch (e: any) {
					if (e?.code === "EEXIST") throw new Error(`already exists: ${relative(this.root, full)}`);
					throw e;
				}
			} else {
				mkdirSync(dirname(full), { recursive: true });
				try {
					await writeFile(full, "", { flag: "wx" });
				} catch (e: any) {
					if (e?.code === "EEXIST") throw new Error(`already exists: ${relative(this.root, full)}`);
					throw e;
				}
			}
		});
	}

	/**
	 * After any save that is under way of the file, or of what has the name it is to take: renamed in the middle of
	 * a save of it, the save would have put the old name back beside the new; renamed onto a name being saved for
	 * the first time, the save would have written the renamed file away.
	 */
	async rename(from: string, to: string) {
		const source = this.inside(from);
		const target = this.inside(to);
		const rootKey = fileKey(this.root);
		const srcKey = fileKey(source);
		const dstKey = fileKey(target);
		if (srcKey === rootKey || dstKey === rootKey) {
			throw new Error("cannot rename the workspace root");
		}
		if (dstKey.startsWith(withSep(srcKey))) {
			throw new Error(`${relative(this.root, source)} cannot be moved into itself`);
		}
		await this.held([source, target], async () => {
			this.inside(source);
			this.inside(target);
			// A change of case alone is a rename of the file onto itself only where the two names are one file. That
			// is asked of the files, not of the platform: on a case-sensitive volume `Report.ssl` and `report.ssl` are
			// two, and renaming one to the other's name without the check below replaced the other.
			let caseOnly = false;
			if (source !== target && source.toLowerCase() === target.toLowerCase()) {
				try {
					const from = lstatSync(source);
					const to = lstatSync(target);
					caseOnly = from.dev === to.dev && from.ino === to.ino;
				} catch {
					// No file of the new name: an ordinary rename.
				}
			}
			if (!caseOnly) {
				let targetExists = false;
				try {
					lstatSync(target);
					targetExists = true;
				} catch (e: any) {
					if (e?.code !== "ENOENT") throw e;
				}
				if (targetExists) throw new Error(`already exists: ${relative(this.root, target)}`);
			}
			// A name with a folder in it moves the file there, and the folder is made if it is not there yet.
			mkdirSync(dirname(target), { recursive: true });
			// A folder is moved in this one turn, with no second try. That nothing in it is being saved was looked at
			// in this turn (`quiet`), and holds only until the turn ends: tried again after a wait, as a file's rename is
			// on Windows, a save asked for in between brought the old folder back with that one file in it, and both
			// the rename and the save said they had been done. A file's own name is held while it is renamed, so its
			// rename can wait and try again.
			if (isFolder(source)) WorkspaceFiles.moveFolder(source, target);
			else await renameReplacing(source, target);
		});
	}

	/** A picture's bytes, to be shown. Only what is a picture by its name, and not one too large to send. */
	async image(path: string) {
		const full = this.inside(path);
		const type = imageType(full);
		if (!type) throw new Error(`${relative(this.root, full)} is not a picture this can show.`);
		const st = statSync(full);
		if (!st.isFile()) throw new Error(`${relative(this.root, full)} is not a file.`);
		if (st.size > IMAGE_MAX_BYTES) throw new Error(`${relative(this.root, full)} is ${sizeText(st.size)}: too large to show here (the most is ${sizeText(IMAGE_MAX_BYTES)}).`);
		return { type, base64: Buffer.from(await Bun.file(full).arrayBuffer()).toString("base64") };
	}

	/** Saves a pasted or dropped picture inside the workspace atomically, refusing non-image extensions or oversized payloads. */
	async writeImage(path: string, base64: string) {
		const full = this.inside(path);
		if (!imageType(full)) throw new Error(`${relative(this.root, full)} is not a supported image format.`);
		const maxB64 = Math.ceil((IMAGE_MAX_BYTES * 4) / 3) + 4;
		if (base64.length > maxB64 * 2) {
			throw new Error(`${relative(this.root, full)} is too large to save (the most is ${sizeText(IMAGE_MAX_BYTES)}).`);
		}
		const compact = /\s/.test(base64) ? base64.replace(/\s+/g, "") : base64;
		const pad = compact.endsWith("==") ? 2 : compact.endsWith("=") ? 1 : 0;
		const estimated = Math.floor((compact.length * 3) / 4) - pad;
		if (estimated > IMAGE_MAX_BYTES) {
			throw new Error(`${relative(this.root, full)} is ${sizeText(estimated)}: too large to save (the most is ${sizeText(IMAGE_MAX_BYTES)}).`);
		}
		const bytes = Buffer.from(compact, "base64");
		if (bytes.length > IMAGE_MAX_BYTES) throw new Error(`${relative(this.root, full)} is ${sizeText(bytes.length)}: too large to save (the most is ${sizeText(IMAGE_MAX_BYTES)}).`);
		return writes.run(fileKey(full), async () => {
			this.inside(full);
			await this.atomicWriteFile(full, bytes);
			return { path: full, size: bytes.length };
		});
	}

	/**
	 * A copy of a file, or of a folder and everything in it, under a name nothing has yet. A copy that fails part
	 * of the way is taken away again: nothing was there before it, so nothing is lost by that.
	 */
	async copy(from: string, to: string) {
		const source = this.inside(from);
		const target = this.inside(to);
		const srcKey = fileKey(source);
		const dstKey = fileKey(target);
		// A folder copied into itself would be copied into its own copy, without end.
		if (dstKey === srcKey || dstKey.startsWith(withSep(srcKey))) {
			throw new Error(`${relative(this.root, source)} cannot be copied into itself`);
		}
		// After a save of the file that is under way, so that the copy is of what was saved; and with the name the
		// copy is to take held too, so that whether it is taken is asked when the copy is made, and what is taken
		// away when a copy fails is only ever what the copy itself put there.
		await this.held([source, target], async () => {
			this.inside(source);
			this.inside(target);
			let targetExists = false;
			try {
				lstatSync(target);
				targetExists = true;
			} catch (e: any) {
				if (e?.code !== "ENOENT") throw e;
			}
			if (targetExists) throw new Error(`already exists: ${relative(this.root, target)}`);
			mkdirSync(dirname(target), { recursive: true });
			try {
				await cp(source, target, { recursive: true, errorOnExist: true, force: false });
			} catch (e: any) {
				if (e?.code !== "EEXIST" && e?.code !== "ERR_FS_CP_EEXIST") {
					try {
						await rm(target, { recursive: true, force: true });
					} catch {
						// Ignore cleanup errors.
					}
				}
				throw e;
			}
		});
	}

	/**
	 * The files of a folder and of the folders in it. The folder asked for is held to the workspace as every other
	 * path is: `docs`, `src` or another folder of the project may be a link, and one that leads out of the workspace
	 * was listed through, so the Docs panel showed the titles and summaries of documents outside it. A link that
	 * stays inside is followed. Below the folder asked for no link is followed at all (a link is neither a folder
	 * nor a file to the walk), so it cannot go round.
	 */
	*files(dir = this.root): Generator<string> {
		try {
			this.inside(dir);
		} catch {
			return;
		}
		yield* this.walk(dir);
	}

	private *walk(dir: string): Generator<string> {
		let entries;
		try {
			entries = readdirSync(dir, { withFileTypes: true });
		} catch {
			return;
		}
		for (const d of entries) {
			if (SKIP.has(d.name) || d.name.endsWith(TMP_SUFFIX)) continue;
			const path = join(dir, d.name);
			if (d.isDirectory()) yield* this.walk(path);
			else if (d.isFile()) yield path;
		}
	}

	/** A scan's hits alone, for a caller that lists them and has no use for whether the scan ran out of time. */
	async search(query: string, options: SearchOptions): Promise<SearchHit[]> {
		return (await this.searchScan(query, options)).hits;
	}

	/**
	 * The search, and whether its time budget ran out before every file was read. The hits of a scan that timed out
	 * are only those of the files it got to: given back as a bare list they read as all there is, and a replace made
	 * from them left the rest of the workspace as it was without a word.
	 *
	 * `open` is given by the caller that replaces from the hits (the Search panel): the open files with unsaved
	 * changes, as they are in the editor. Each is searched here in place of the file of its name on disk, first and
	 * under the same budget. They used to be searched in the window, with no budget at all: a regular expression
	 * that takes minutes over one line froze the window for as long, and nothing could stop it. With `open`, even
	 * empty, the answer also has `marks`, for each file something was found in a mark of its text as it was searched
	 * (`replaced` holds a replace to it), and a regular expression's hits say where their groups lie. Which open
	 * files are among the files asked for is the caller's to say: every text given is searched.
	 *
	 * The budget is looked at between lines, and for a regular expression between the matches of a line. One match
	 * cannot be cut short: while the expression runs nothing else does, here as anywhere.
	 */
	async searchScan(query: string, options: SearchOptions, open?: readonly OpenText[]): Promise<{ hits: SearchHit[]; timedOut: boolean; marks?: Record<string, string> }> {
		const marks: Record<string, string> | undefined = open ? {} : undefined;
		const answer = (hits: SearchHit[], timedOut: boolean) => (marks ? { hits, timedOut, marks } : { hits, timedOut });
		if (!query) return answer([], false);
		// A text too large to search is searched no more for being open than the file is on disk (`SEARCH_MAX_BYTES`).
		const named = (open ?? []).filter((each) => typeof each?.path === "string");
		const texts = named.filter((each): each is { path: string; text: string } => typeof each.text === "string" && each.text.length <= SEARCH_MAX_TEXT);
		const noFiles = options.paths !== undefined && options.paths.length === 0;
		if (noFiles && !texts.length) return answer([], false);
		const isRegex = Boolean(options.regex);
		const pattern = open && isRegex ? withGroups(searchPattern(query, options)) : searchPattern(query, options);
		const filter = createFileFilter(options.include, options.exclude);
		const normRel = (p: string) => p.replace(/\\/g, "/").replace(/^(?:\.\/)+/, "").replace(/^\/+/, "");
		const pathSet =
			options.paths !== undefined
				? new Set(options.paths.map((p) => foldPath(normRel(p))))
				: null;
		// The files that are open with unsaved changes, by where they are in the folder: what is on disk of them is
		// not what the editor shows, and is not read.
		const openRel = new Set(named.filter((each) => isAbsolute(each.path)).map((each) => foldPath(normRel(relative(this.root, resolve(each.path))))));
		const hits: SearchHit[] = [];
		const unsaved: SearchHit[] = [];
		const deadline = performance.now() + WorkspaceFiles.searchTimeoutMs;
		const clock = isRegex ? { until: deadline, late: false } : undefined;
		/** One text's lines, its hits added to `into`. Says why it stopped short: the budget ran out, or the list is full. */
		const scan = (path: string, text: string, into: SearchHit[]): "time" | "full" | undefined => {
			const before = into.length;
			try {
				const lines = text.split(/\r?\n/);
				for (let i = 0; i < lines.length; i++) {
					if ((isRegex || (i & 63) === 0) && performance.now() > deadline) return "time";
					const line = lines[i]!;
					if (isRegex && line.length > REGEX_MAX_LINE_LENGTH) continue;
					// The same walk a replace makes over the line: what is listed is what would be replaced.
					for (const match of matchesOn(line, pattern, "", false, SEARCH_LIMIT - into.length, clock)) {
						const { text: excerpt, textOffset } = excerptForMatch(line, match.column, match.length);
						into.push({
							path,
							line: i + 1,
							column: match.column,
							length: match.length,
							text: excerpt,
							...(textOffset > 0 ? { textOffset } : {}),
							...(match.groups ? { groups: match.groups } : {}),
							...(match.named ? { named: match.named } : {}),
						});
						if (into.length >= SEARCH_LIMIT) return "full";
					}
					if (clock?.late) return "time";
				}
				return undefined;
			} finally {
				if (marks && into.length > before) marks[path] = textMark(text);
			}
		};
		// As the window listed them when it searched them itself: after the files on disk, and as many again at most.
		const all = () => (unsaved.length ? [...hits, ...unsaved] : hits);
		for (const each of texts) {
			if (performance.now() > deadline) return answer(all(), true);
			const cut = scan(each.path, each.text, unsaved);
			if (cut === "time") return answer(all(), true);
			if (cut === "full") break;
		}
		if (noFiles) return answer(all(), false);
		for (const path of this.files()) {
			if (performance.now() > deadline) return answer(all(), true);
			if (imageType(path)) continue;
			const relPath = normRel(relative(this.root, path));
			if (pathSet !== null && !pathSet.has(foldPath(relPath))) continue;
			if (!filter(relPath)) continue;
			if (openRel.size && openRel.has(foldPath(relPath))) continue;
			try {
				const st = statSync(path);
				if (!st.isFile() || st.size > SEARCH_MAX_BYTES) continue;
			} catch {
				continue;
			}
			let sniff: Uint8Array;
			try {
				sniff = new Uint8Array(await Bun.file(path).slice(0, SNIFF_BYTES).arrayBuffer());
			} catch {
				continue;
			}
			if (looksBinary(sniff, true)) continue;
			const text = await textOf(path);
			if (text.includes("\u0000")) continue;
			const cut = scan(path, text, hits);
			if (cut) return answer(all(), cut === "time");
		}
		return answer(all(), false);
	}

	/**
	 * What a replace holds for one file in a list keyed by path (`linesByPath`, `asSearched`): by the name it was
	 * asked under, by its whole path or by its path in the folder, and where names fold, by any name of the file.
	 */
	private forPath<T>(byPath: Record<string, T>, path: string, full: string): T | undefined {
		const relNorm = relative(this.root, full).replace(/\\/g, "/");
		const direct = byPath[path] ?? byPath[full] ?? byPath[relNorm];
		if (direct !== undefined) return direct;
		if (process.platform === "win32" || process.platform === "darwin") {
			const targetKey = fileKey(full);
			for (const [k, v] of Object.entries(byPath)) {
				try {
					if (fileKey(this.inside(k)) === targetKey) return v;
				} catch {
					if (k.replace(/\\/g, "/").toLowerCase() === relNorm.toLowerCase()) return v;
				}
			}
		}
		return undefined;
	}

	/**
	 * One file as it would be with every match replaced: its text before and after, and how many matches. Null
	 * when it has none, or is a file the search does not look in (too large, or not text).
	 *
	 * With `options.asSearched` the file is held to the text that was searched: where its text now has another
	 * mark, or the file is gone or is no longer text to search, it comes back `changed` with nothing to write. The
	 * lines a replace is allowed on (`linesByPath`) are line numbers of the text that was searched: with a line
	 * added above them since, they named other lines, and a match the user had taken out of the replace was
	 * replaced while the ones kept were left.
	 */
	async replaced(
		path: string,
		query: string,
		replacement: string,
		options: SearchOptions,
	): Promise<{ before: string; after: string; count: number; skippedProtected?: number; invalidJson?: boolean; changed?: boolean } | null> {
		const full = this.inside(path);
		if (!query) return null;
		const held = options.asSearched !== undefined;
		const changed = { before: "", after: "", count: 0, changed: true };
		let size: number;
		try {
			size = statSync(full).size;
		} catch (e: any) {
			if (held && (e?.code === "ENOENT" || e?.code === "ENOTDIR")) return changed;
			throw e;
		}
		if (size > SEARCH_MAX_BYTES) return held ? changed : null;
		const file = await this.read(full);
		if (file.binary || file.text.includes("\u0000")) return held ? changed : null;
		// A file with no mark in a replace that gives marks was not searched: it is left as it is too.
		if (held && this.forPath(options.asSearched!, path, full) !== textMark(file.text)) return changed;

		const listed = options.linesByPath ? this.forPath(options.linesByPath, path, full) : undefined;
		const allowedLines: ReadonlySet<number> | undefined = listed ? new Set(listed) : undefined;

		const isMd = /\.(md|markdown)$/i.test(full);
		const isPlan = /\.plan\.json$/i.test(full);
		const needsSafe = Boolean(options.safeDocs && (isMd || isPlan));

		if (allowedLines || needsSafe) {
			const pattern = searchPattern(query, options);
			const res = replaceSafeInText(file.text, pattern, replacement, Boolean(options.regex), {
				allowedLines,
				isMarkdown: isMd,
				isPlanJson: isPlan,
				safeDocs: Boolean(options.safeDocs),
				maxSamples: 0,
			});
			if (res.invalidJson) {
				return {
					before: file.text,
					after: file.text,
					count: 0,
					invalidJson: true,
					...(res.skippedProtected ? { skippedProtected: res.skippedProtected } : {}),
				};
			}
			if (!res.count) {
				return res.skippedProtected ? { before: file.text, after: file.text, count: 0, skippedProtected: res.skippedProtected } : null;
			}
			return {
				before: file.text,
				after: res.text,
				count: res.count,
				...(res.skippedProtected ? { skippedProtected: res.skippedProtected } : {}),
			};
		}

		const done = replaceIn(file.text, query, replacement, options);
		return done.count ? { before: file.text, after: done.text, count: done.count } : null;
	}

	watch(onChange: (path: string) => void) {
		this.watcher?.close();
		this.watcher = undefined;
		try {
			const watcher = watch(this.root, { recursive: true }, (event, name) => {
				if (!name) return;
				const rel = String(name);
				// The `.git` folder itself appearing or going (git init, a clone, a repository removed) is told of, so
				// that source control asks git again; what changes inside it is not.
				const repository = event === "rename" && rel === ".git";
				if (!repository && (rel.split(/[\\/]/).some((part) => SKIP.has(part)) || rel.endsWith(TMP_SUFFIX))) return;
				const path = join(this.root, rel);
				const own = this.ownWrites.get(fileKey(path));
				if (own && Date.now() - own < 1500) return;
				onChange(path);
			});
			watcher.on("error", () => {
				// Async watcher errors must never crash the host process.
			});
			this.watcher = watcher;
		} catch {
			// No recursive watch here: external changes show on the next open.
		}
	}

	close() {
		this.watcher?.close();
		this.watcher = undefined;
		this.ownWrites.clear();
	}
}
