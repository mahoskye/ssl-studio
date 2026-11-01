// Local history: a snapshot of a file on every save that changes it, kept
// outside the workspace (ARCHITECTURE, "Settings and state").
import { createHash } from "node:crypto";
import { mkdirSync, readdirSync, rmSync, existsSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import type { Snapshot } from "../shared/protocol";
import { dirs } from "./paths";

const KEEP = 100;
const hash = (text: string) => createHash("sha1").update(text).digest("hex").slice(0, 16);

export class History {
	constructor(
		private root: string,
		private base = join(dirs.data, "history"),
	) {}

	private dir(path: string) {
		return join(this.base, hash(this.root), hash(relative(this.root, path)));
	}

	list(path: string): Snapshot[] {
		const dir = this.dir(path);
		if (!existsSync(dir)) return [];
		return readdirSync(dir)
			.filter((f) => f.endsWith(".txt"))
			.map((f) => ({ id: f.slice(0, -4), time: Number(f.split("-")[0]), size: statSync(join(dir, f)).size }))
			.sort((a, b) => b.time - a.time || b.id.localeCompare(a.id));
	}

	async read(path: string, id: string): Promise<string> {
		if (!/^\d+-\d+$/.test(id)) throw new Error("bad snapshot id");
		return Bun.file(join(this.dir(path), `${id}.txt`)).text();
	}

	/** Saves `text` unless it equals the newest snapshot. */
	async record(path: string, text: string, now = Date.now()) {
		const dir = this.dir(path);
		mkdirSync(dir, { recursive: true });
		const list = this.list(path);
		if (list.length && (await this.read(path, list[0]!.id)) === text) return;
		const sameMs = list.filter((s) => s.time === now).length;
		await Bun.write(join(dir, `${now}-${sameMs}.txt`), text);
		await Bun.write(join(dir, "PATH"), relative(this.root, path));
		for (const old of this.list(path).slice(KEEP)) rmSync(join(dir, `${old.id}.txt`));
	}
}
