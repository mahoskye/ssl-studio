// Files inside one workspace folder. Every path the UI sends is absolute
// and must stay inside the root.
import {
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
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import type { Entry, FileText, SearchHit } from "../shared/protocol";
import { excerptForMatch, matchesOn, REGEX_MAX_LINE_LENGTH, replaceIn, SEARCH_LIMIT, searchPattern, type SearchOptions } from "../shared/searchPattern";
import { createFileFilter } from "../shared/fileGlob";
import { replaceSafeInText } from "../shared/menuBar";
import { renameReplacing } from "./atomic";
import { decode, encode, encodingOf, looksBinary, textOf, type Encoding } from "./encoding";
import { imageType, sizeText, SNIFF_BYTES } from "../shared/fileKind";
import { UNLISTED } from "../shared/paths";
import { Serial } from "./serial";

const SKIP = new Set<string>(UNLISTED);
const TMP_SUFFIX = ".ssl-studio-tmp";
const OWN_WRITE_TTL_MS = 5000;
const MAX_SYMLINK_DEPTH = 40;

/** Ensures a trailing path separator without doubling root paths like `/` or `C:\`. */
export function withSep(p: string): string {
	return p.endsWith(sep) ? p : p + sep;
}

/**
 * The work on each file, one after another. One for the whole process, not for each open folder: a folder opened
 * again is the same files.
 */
const writes = new Serial();

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
		// A link that leads nowhere has no other name to be reached by.
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

export class WorkspaceFiles {
	readonly root: string;
	private readonly realRoot: string;
	private watcher?: FSWatcher;
	/** How long work on a folder waits for the saves inside it to stop coming, in milliseconds. */
	static quietMs = 10_000;
	/** Safety time budget (ms) for `search()` across workspace files. */
	static searchTimeoutMs = SEARCH_TIMEOUT_MS;
	/** Paths (normalized via fileKey) this process wrote recently; their watch events are not external changes. */
	private ownWrites = new Map<string, number>();

	constructor(root: string) {
		this.root = resolve(root);
		if (!statSync(this.root).isDirectory()) throw new Error(`not a folder: ${root}`);
		this.realRoot = realpathSync.native(this.root);
	}

	private resolveReal(target: string, origPath: string, depth = 0): string {
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
				const parentReal = this.resolveReal(dirname(target), origPath, depth + 1);
				return this.resolveReal(resolve(parentReal, linkTarget), origPath, depth + 1);
			}
		} catch (e: any) {
			if (e?.code !== "ENOENT" && e?.code !== "ENOTDIR") throw e;
		}
		if (realErr?.code === "EACCES") throw realErr;
		const parent = dirname(target);
		if (parent === target) return target;
		const parentReal = this.resolveReal(parent, origPath, depth + 1);
		return resolve(parentReal, basename(target));
	}

	inside(path: string): string {
		const full = resolve(path);
		// Windows paths compare without case (drive letters come both ways).
		const fold = (p: string) => (process.platform === "win32" ? p.toLowerCase() : p);
		const fullF = fold(full);
		const rootF = fold(this.root);
		if (fullF !== rootF && !fullF.startsWith(withSep(rootF))) {
			throw new Error(`outside the workspace: ${path}`);
		}
		// Resolve real path through symlinks (including dangling symlinks and non-existent descendants).
		const resolvedReal = this.resolveReal(full, path);
		const cmp = (p: string) => (process.platform === "win32" || process.platform === "darwin" ? p.toLowerCase() : p);
		const realF = cmp(resolvedReal);
		const realRootF = cmp(this.realRoot);
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
			const bytes = st.size <= SNIFF_BYTES && sniff.length === st.size ? sniff : new Uint8Array(await file.arrayBuffer());
			const { text, encoding } = decode(bytes);
			return { path: full, text, mtime, encoding };
		} catch (e: any) {
			// What the file system says is left as it says it; what the reading found names the file.
			throw e instanceof Error && !("code" in e) ? new Error(`${relative(this.root, full)}: ${e.message}`) : e;
		}
	}

	/**
	 * Writes through a temporary file, so a crash never leaves half a script. A file is written in what it is
	 * written in now, mark and all; a new file in UTF-8. Writes of one file go one after another, in the order
	 * they were asked for: asked for at once (Ctrl+S twice), they used to share the temporary file, and one failed
	 * or the file was left with the older text.
	 */
	async write(path: string, text: string, asText = false) {
		const full = this.inside(path);
		return writes.run(fileKey(full), () => this.writeNow(full, text, asText));
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
	async alone<T>(path: string, work: (write: (text: string, asText?: boolean) => Promise<{ mtime: number }>) => Promise<T> | T): Promise<T> {
		const full = this.inside(path);
		return this.held([full], () => work((text, asText = false) => this.writeNow(full, text, asText)));
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

	private async atomicWriteFile(full: string, bytes: Uint8Array, mode?: number) {
		this.inside(full);
		mkdirSync(dirname(full), { recursive: true });
		const temp = join(dirname(full), `.${basename(full)}.${process.pid}.${randomBytes(6).toString("hex")}${TMP_SUFFIX}`);
		const flags =
			process.platform === "win32"
				? "wx"
				: constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0);
		let created = false;
		try {
			const fh = await open(temp, flags, 0o666);
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

	private async writeNow(full: string, text: string, asText: boolean) {
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
			if (st.isSymbolicLink()) {
				const targetStat = statSync(full);
				if (targetStat.isDirectory()) {
					const err = new Error(`EISDIR: illegal operation on a directory, open '${full}'`) as NodeJS.ErrnoException;
					err.code = "EISDIR";
					throw err;
				}
				prevMode = targetStat.mode;
			} else {
				prevMode = st.mode;
			}
			bytesNow = new Uint8Array(await Bun.file(full).arrayBuffer());
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
		if (bytesNow) encoding = encodingOf(bytesNow);
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
		await this.held([source, target], () => {
			this.inside(source);
			this.inside(target);
			const caseOnly = srcKey === dstKey && source !== target;
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
			renameSync(source, target);
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

	*files(dir = this.root): Generator<string> {
		let entries;
		try {
			entries = readdirSync(dir, { withFileTypes: true });
		} catch {
			return;
		}
		for (const d of entries) {
			if (SKIP.has(d.name) || d.name.endsWith(TMP_SUFFIX)) continue;
			const path = join(dir, d.name);
			if (d.isDirectory()) yield* this.files(path);
			else if (d.isFile()) yield path;
		}
	}

	async search(query: string, options: SearchOptions): Promise<SearchHit[]> {
		if (!query) return [];
		if (options.paths !== undefined && options.paths.length === 0) return [];
		const pattern = searchPattern(query, options);
		const filter = createFileFilter(options.include, options.exclude);
		const normRel = (p: string) => p.replace(/\\/g, "/").replace(/^(?:\.\/)+/, "").replace(/^\/+/, "");
		const pathSet =
			options.paths !== undefined
				? new Set(options.paths.map((p) => (process.platform === "win32" ? normRel(p).toLowerCase() : normRel(p))))
				: null;
		const hits: SearchHit[] = [];
		const deadline = performance.now() + WorkspaceFiles.searchTimeoutMs;
		const isRegex = Boolean(options.regex);
		for (const path of this.files()) {
			if (performance.now() > deadline) return hits;
			if (imageType(path)) continue;
			const relPath = normRel(relative(this.root, path));
			if (pathSet !== null && !pathSet.has(process.platform === "win32" ? relPath.toLowerCase() : relPath)) continue;
			if (!filter(relPath)) continue;
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
			const lines = text.split(/\r?\n/);
			for (let i = 0; i < lines.length; i++) {
				if ((isRegex || (i & 63) === 0) && performance.now() > deadline) return hits;
				const line = lines[i]!;
				if (isRegex && line.length > REGEX_MAX_LINE_LENGTH) continue;
				// The same walk a replace makes over the line: what is listed is what would be replaced.
				for (const match of matchesOn(line, pattern, "", false, SEARCH_LIMIT - hits.length)) {
					const { text: excerpt, textOffset } = excerptForMatch(line, match.column, match.length);
					hits.push({
						path,
						line: i + 1,
						column: match.column,
						length: match.length,
						text: excerpt,
						...(textOffset > 0 ? { textOffset } : {}),
					});
					if (hits.length >= SEARCH_LIMIT) return hits;
				}
			}
		}
		return hits;
	}

	/**
	 * One file as it would be with every match replaced: its text before and after, and how many matches. Null
	 * when it has none, or is a file the search does not look in (too large, or not text).
	 */
	async replaced(
		path: string,
		query: string,
		replacement: string,
		options: SearchOptions,
	): Promise<{ before: string; after: string; count: number; skippedProtected?: number; invalidJson?: boolean } | null> {
		const full = this.inside(path);
		if (!query || statSync(full).size > SEARCH_MAX_BYTES) return null;
		const file = await this.read(full);
		if (file.binary || file.text.includes("\u0000")) return null;

		const relNorm = relative(this.root, full).replace(/\\/g, "/");
		let allowedLines: ReadonlySet<number> | undefined;
		if (options.linesByPath) {
			const direct = options.linesByPath[path] ?? options.linesByPath[full] ?? options.linesByPath[relNorm];
			if (direct) {
				allowedLines = new Set(direct);
			} else if (process.platform === "win32" || process.platform === "darwin") {
				const targetKey = fileKey(full);
				for (const [k, v] of Object.entries(options.linesByPath)) {
					try {
						if (fileKey(this.inside(k)) === targetKey) {
							allowedLines = new Set(v);
							break;
						}
					} catch {
						if (k.replace(/\\/g, "/").toLowerCase() === relNorm.toLowerCase()) {
							allowedLines = new Set(v);
							break;
						}
					}
				}
			}
		}

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
			const watcher = watch(this.root, { recursive: true }, (_event, name) => {
				if (!name) return;
				const rel = String(name);
				if (rel.split(/[\\/]/).some((part) => SKIP.has(part)) || rel.endsWith(TMP_SUFFIX)) return;
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
