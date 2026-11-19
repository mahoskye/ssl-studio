// Files inside one workspace folder. Every path the UI sends is absolute
// and must stay inside the root.
import { chmodSync, mkdirSync, readdirSync, renameSync, statSync, watch, existsSync, type FSWatcher } from "node:fs";
import { cp, rm } from "node:fs/promises";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import type { Entry, FileText, SearchHit } from "../shared/protocol";
import { matchesOn, replaceIn, SEARCH_LIMIT, searchPattern, type SearchOptions } from "../shared/searchPattern";
import { fileChosen } from "../shared/fileGlob";
import { decode, encode, encodingOf, textOf, type Encoding } from "./encoding";
import { imageType, looksBinary, sizeText } from "../shared/fileKind";

const SKIP = new Set([".git", "node_modules", ".ssl-studio", ".hutch", "dist", "build"]);
const SEARCH_MAX_BYTES = 4 * 1024 * 1024;
/** The largest picture that is sent to the window to be shown. */
const IMAGE_MAX_BYTES = 20 * 1024 * 1024;

export class WorkspaceFiles {
	readonly root: string;
	private watcher?: FSWatcher;
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
	 * written in now, mark and all; a new file in UTF-8.
	 */
	async write(path: string, text: string, asText = false) {
		const full = this.inside(path);
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

	rename(from: string, to: string) {
		const target = this.inside(to);
		if (existsSync(target)) throw new Error(`already exists: ${relative(this.root, target)}`);
		// A name with a folder in it moves the file there, and the folder is made if it is not there yet.
		mkdirSync(dirname(target), { recursive: true });
		renameSync(this.inside(from), target);
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

	/**
	 * A copy of a file, or of a folder and everything in it, under a name nothing has yet. A copy that fails part
	 * of the way is taken away again: nothing was there before it, so nothing is lost by that.
	 */
	async copy(from: string, to: string) {
		const source = this.inside(from);
		const target = this.inside(to);
		if (existsSync(target)) throw new Error(`already exists: ${relative(this.root, target)}`);
		// A folder copied into itself would be copied into its own copy, without end.
		if (target === source || target.startsWith(source + sep)) throw new Error(`${relative(this.root, source)} cannot be copied into itself`);
		mkdirSync(dirname(target), { recursive: true });
		try {
			await cp(source, target, { recursive: true, errorOnExist: true, force: false });
		} catch (e) {
			await rm(target, { recursive: true, force: true });
			throw e;
		}
	}

	*files(dir = this.root): Generator<string> {
		for (const d of readdirSync(dir, { withFileTypes: true })) {
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
			if (statSync(path).size > SEARCH_MAX_BYTES) continue;
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
