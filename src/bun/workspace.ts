// Files inside one workspace folder. Every path the UI sends is absolute
// and must stay inside the root.
import { mkdirSync, readdirSync, renameSync, statSync, watch, existsSync, type FSWatcher } from "node:fs";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import type { Entry, SearchHit } from "../shared/protocol";

const SKIP = new Set([".git", "node_modules", ".ssl-studio", ".hutch", "dist", "build"]);
const SEARCH_LIMIT = 2000;
const SEARCH_MAX_BYTES = 4 * 1024 * 1024;

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
		if (full !== this.root && !full.startsWith(this.root + sep)) throw new Error(`outside the workspace: ${path}`);
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

	async read(path: string) {
		const full = this.inside(path);
		return { path: full, text: await Bun.file(full).text(), mtime: statSync(full).mtimeMs };
	}

	/** Writes through a temporary file, so a crash never leaves half a script. */
	async write(path: string, text: string) {
		const full = this.inside(path);
		const temp = join(dirname(full), `.${basename(full)}.ssl-studio-tmp`);
		this.ownWrites.set(full, Date.now());
		await Bun.write(temp, text);
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
		renameSync(this.inside(from), target);
	}

	*files(dir = this.root): Generator<string> {
		for (const d of readdirSync(dir, { withFileTypes: true })) {
			if (SKIP.has(d.name)) continue;
			const path = join(dir, d.name);
			if (d.isDirectory()) yield* this.files(path);
			else if (d.isFile()) yield path;
		}
	}

	async search(query: string, options: { regex?: boolean; caseSensitive?: boolean }): Promise<SearchHit[]> {
		if (!query) return [];
		const flags = options.caseSensitive ? "g" : "gi";
		const pattern = new RegExp(options.regex ? query : query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), flags);
		const hits: SearchHit[] = [];
		for (const path of this.files()) {
			if (statSync(path).size > SEARCH_MAX_BYTES) continue;
			const text = await Bun.file(path).text();
			if (text.includes("\u0000")) continue;
			const lines = text.split(/\r?\n/);
			for (let i = 0; i < lines.length; i++) {
				pattern.lastIndex = 0;
				let match: RegExpExecArray | null;
				while ((match = pattern.exec(lines[i]!))) {
					hits.push({ path, line: i + 1, column: match.index + 1, length: match[0].length, text: lines[i]!.slice(0, 400) });
					if (hits.length >= SEARCH_LIMIT) return hits;
					if (!match[0].length) pattern.lastIndex++;
				}
			}
		}
		return hits;
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
