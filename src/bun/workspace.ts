// Files inside one workspace folder. Every path the UI sends is absolute
// and must stay inside the root.
import { chmodSync, mkdirSync, readdirSync, realpathSync, renameSync, statSync, watch, existsSync, type FSWatcher } from "node:fs";
import { cp, rm } from "node:fs/promises";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import type { Entry, FileText, SearchHit } from "../shared/protocol";
import { matchesOn, replaceIn, SEARCH_LIMIT, searchPattern, type SearchOptions } from "../shared/searchPattern";
import { fileChosen } from "../shared/fileGlob";
import { decode, encode, encodingOf, textOf, type Encoding } from "./encoding";
import { imageType, looksBinary, sizeText } from "../shared/fileKind";
import { UNLISTED } from "../shared/paths";
import { Serial } from "./serial";

const SKIP = new Set<string>(UNLISTED);
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
/** The largest picture that is sent to the window to be shown. */
const IMAGE_MAX_BYTES = 20 * 1024 * 1024;

export class WorkspaceFiles {
	readonly root: string;
	private watcher?: FSWatcher;
	/** How long work on a folder waits for the saves inside it to stop coming, in milliseconds. */
	static quietMs = 10_000;
	/** Paths this process wrote recently; their watch events are not external changes. */
	private ownWrites = new Map<string, number>();

	constructor(root: string) {
		this.root = resolve(root);
		if (!statSync(this.root).isDirectory()) throw new Error(`not a folder: ${root}`);
	}

	inside(path: string): string {
		const full = resolve(path);
		// Windows paths compare without case (drive letters come both ways).
		const fold = (p: string) => (process.platform === "win32" ? p.toLowerCase() : p);
		if (fold(full) !== fold(this.root) && !fold(full).startsWith(fold(this.root) + sep)) throw new Error(`outside the workspace: ${path}`);
		return full;
	}

	list(dir: string): Entry[] {
		const full = this.inside(dir);
		return readdirSync(full, { withFileTypes: true })
			.filter((d) => !SKIP.has(d.name) && (d.isDirectory() || d.isFile()))
			.map((d) => {
				const path = join(full, d.name);
				return { name: d.name, path, kind: d.isDirectory() ? "dir" : "file", size: d.isFile() ? statSync(path).size : 0 } as Entry;
			})
			.sort((a, b) => (a.kind === b.kind ? a.name.localeCompare(b.name, undefined, { sensitivity: "base" }) : a.kind === "dir" ? -1 : 1));
	}

	/**
	 * A file's text, read as what the file is written in. A picture, or other bytes that are not text, is not read
	 * as text: it comes back with no text, and says what it is.
	 */
	async read(path: string): Promise<FileText> {
		const full = this.inside(path);
		try {
			const bytes = new Uint8Array(await Bun.file(full).arrayBuffer());
			const mtime = statSync(full).mtimeMs;
			const image = imageType(full);
			if (image || looksBinary(bytes)) return { path: full, text: "", mtime, binary: { size: bytes.length, ...(image ? { image } : {}) } };
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
		const inside = folders.map((folder) => fileKey(folder) + sep);
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

	private async writeNow(full: string, text: string, asText: boolean) {
		mkdirSync(dirname(full), { recursive: true });
		const temp = join(dirname(full), `.${basename(full)}.ssl-studio-tmp`);
		let encoding: Encoding = "utf-8";
		let bytesNow: Uint8Array | null = null;
		try {
			if (existsSync(full)) bytesNow = new Uint8Array(await Bun.file(full).arrayBuffer());
		} catch {
			// A file that cannot be read now is written as a new one would be.
		}
		// What is read as bytes has no text here, and text written over it would be the end of it.
		// A picture by its name is never text. Other bytes are let be, unless what is written is known to be the
		// file's own text (a zero byte typed into it, and saved, makes it look like bytes from then on).
		if (bytesNow && (imageType(full) || (looksBinary(bytesNow) && !asText))) throw new Error(`${relative(this.root, full)} is not text: it is not written over from here.`);
		if (bytesNow) encoding = encodingOf(bytesNow);
		let bytes: Uint8Array;
		try {
			bytes = encode(text, encoding);
		} catch (e: any) {
			throw new Error(`${relative(this.root, full)}: ${e?.message ?? e}`);
		}
		this.ownWrites.set(full, Date.now());
		await Bun.write(temp, bytes);
		// The file that takes its place has what the file had: who may read it, and whether it may be run.
		if (bytesNow) {
			try {
				chmodSync(temp, statSync(full).mode);
			} catch {
				// A system that keeps no such thing has nothing to carry over.
			}
		}
		renameSync(temp, full);
		return { mtime: statSync(full).mtimeMs };
	}

	async create(path: string, kind: "file" | "dir") {
		const full = this.inside(path);
		if (existsSync(full)) throw new Error(`already exists: ${relative(this.root, full)}`);
		if (kind === "dir") mkdirSync(full, { recursive: true });
		else {
			mkdirSync(dirname(full), { recursive: true });
			await Bun.write(full, "");
		}
	}

	/**
	 * After any save that is under way of the file, or of what has the name it is to take: renamed in the middle of
	 * a save of it, the save would have put the old name back beside the new; renamed onto a name being saved for
	 * the first time, the save would have written the renamed file away.
	 */
	async rename(from: string, to: string) {
		const source = this.inside(from);
		const target = this.inside(to);
		await this.held([source, target], () => {
			if (existsSync(target)) throw new Error(`already exists: ${relative(this.root, target)}`);
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
		const size = statSync(full).size;
		if (size > IMAGE_MAX_BYTES) throw new Error(`${relative(this.root, full)} is ${sizeText(size)}: too large to show here (the most is ${sizeText(IMAGE_MAX_BYTES)}).`);
		return { type, base64: Buffer.from(await Bun.file(full).arrayBuffer()).toString("base64") };
	}

	/** Saves a pasted or dropped picture inside the workspace atomically, refusing non-image extensions or oversized payloads. */
	async writeImage(path: string, base64: string) {
		const full = this.inside(path);
		if (!imageType(full)) throw new Error(`${relative(this.root, full)} is not a supported image format.`);
		const bytes = Buffer.from(base64, "base64");
		if (bytes.length > IMAGE_MAX_BYTES) throw new Error(`${relative(this.root, full)} is ${sizeText(bytes.length)}: too large to save (the most is ${sizeText(IMAGE_MAX_BYTES)}).`);
		return writes.run(fileKey(full), async () => {
			mkdirSync(dirname(full), { recursive: true });
			const temp = join(dirname(full), `.${basename(full)}.ssl-studio-tmp`);
			this.ownWrites.set(full, Date.now());
			await Bun.write(temp, bytes);
			renameSync(temp, full);
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
		// A folder copied into itself would be copied into its own copy, without end.
		if (target === source || target.startsWith(source + sep)) throw new Error(`${relative(this.root, source)} cannot be copied into itself`);
		// After a save of the file that is under way, so that the copy is of what was saved; and with the name the
		// copy is to take held too, so that whether it is taken is asked when the copy is made, and what is taken
		// away when a copy fails is only ever what the copy itself put there.
		await this.held([source, target], async () => {
			if (existsSync(target)) throw new Error(`already exists: ${relative(this.root, target)}`);
			mkdirSync(dirname(target), { recursive: true });
			try {
				await cp(source, target, { recursive: true, errorOnExist: true, force: false });
			} catch (e) {
				await rm(target, { recursive: true, force: true });
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
			if (SKIP.has(d.name)) continue;
			const path = join(dir, d.name);
			if (d.isDirectory()) yield* this.files(path);
			else if (d.isFile()) yield path;
		}
	}

	async search(query: string, options: SearchOptions): Promise<SearchHit[]> {
		if (!query) return [];
		const pattern = searchPattern(query, options);
		const hits: SearchHit[] = [];
		for (const path of this.files()) {
			if (!fileChosen(relative(this.root, path), options.include, options.exclude)) continue;
			try {
				if (statSync(path).size > SEARCH_MAX_BYTES) continue;
			} catch {
				continue;
			}
			const text = await textOf(path);
			if (text.includes("\u0000")) continue;
			const lines = text.split(/\r?\n/);
			for (let i = 0; i < lines.length; i++) {
				// The same walk a replace makes over the line: what is listed is what would be replaced.
				for (const match of matchesOn(lines[i]!, pattern, "", false)) {
					hits.push({ path, line: i + 1, column: match.column, length: match.length, text: lines[i]!.slice(0, 400) });
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
	async replaced(path: string, query: string, replacement: string, options: SearchOptions): Promise<{ before: string; after: string; count: number } | null> {
		const full = this.inside(path);
		if (!query || statSync(full).size > SEARCH_MAX_BYTES) return null;
		const file = await this.read(full);
		if (file.binary || file.text.includes("\u0000")) return null;
		const done = replaceIn(file.text, query, replacement, options);
		return done.count ? { before: file.text, after: done.text, count: done.count } : null;
	}

	watch(onChange: (path: string) => void) {
		try {
			this.watcher = watch(this.root, { recursive: true }, (_event, name) => {
				if (!name) return;
				const path = join(this.root, String(name));
				if (path.split(sep).some((part) => SKIP.has(part)) || path.endsWith(".ssl-studio-tmp")) return;
				const own = this.ownWrites.get(path);
				if (own && Date.now() - own < 1500) return;
				onChange(path);
			});
		} catch {
			// No recursive watch here: external changes show on the next open.
		}
	}

	close() {
		this.watcher?.close();
	}
}
