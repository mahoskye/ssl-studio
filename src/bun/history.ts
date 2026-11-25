// Local history: a snapshot of a file on every save that changes it, kept
// outside the workspace (ARCHITECTURE, "Settings and state").
import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, rmSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import type { Snapshot } from "../shared/protocol";
import { renameReplacing } from "./atomic";
import { dirs } from "./paths";
import { Serial } from "./serial";

const KEEP = 100;
export const MAX_SNAPSHOT_BYTES = 2 * 1024 * 1024;
const SNAPSHOT_FILE = /^(\d+)-(\d+)\.txt$/;
const CASE_INSENSITIVE = process.platform === "win32" || process.platform === "darwin";

const hash = (text: string) => createHash("sha1").update(text).digest("hex").slice(0, 16);
const historySerial = new Serial();

async function atomicWrite(path: string, content: string): Promise<void> {
	mkdirSync(dirname(path), { recursive: true });
	const temp = `${path}.${process.pid}.${randomUUID().slice(0, 8)}.tmp`;
	try {
		await Bun.write(temp, content);
		await renameReplacing(temp, path);
	} catch (err) {
		try {
			rmSync(temp, { force: true });
		} catch {
			// Best-effort cleanup of temp file.
		}
		throw err;
	}
}

export function historyKey(root: string, path: string, caseInsensitive = CASE_INSENSITIVE): { rootKey: string; relKey: string; rel: string } {
	const normRoot = resolve(root).replace(/\\/g, "/").replace(/\/+$/, "") || "/";
	const normPath = resolve(path).replace(/\\/g, "/");
	const rootCmp = caseInsensitive ? normRoot.toLowerCase() : normRoot;
	const pathCmp = caseInsensitive ? normPath.toLowerCase() : normPath;
	const prefix = rootCmp === "/" ? "/" : `${rootCmp}/`;
	const rel =
		pathCmp === rootCmp
			? ""
			: pathCmp.startsWith(prefix)
				? normPath.slice(prefix.length)
				: relative(rootCmp, pathCmp).replace(/\\/g, "/");
	const relForHash = caseInsensitive ? rel.toLowerCase() : rel;
	return { rootKey: hash(rootCmp), relKey: hash(relForHash), rel };
}

export class History {
	private normalizedRoot: string;

	constructor(
		root: string,
		private base = join(dirs.data, "history"),
	) {
		this.normalizedRoot = resolve(root);
	}

	private bucket(path: string) {
		const { rootKey, relKey, rel } = historyKey(this.normalizedRoot, path);
		return { dir: join(this.base, rootKey, relKey), rel };
	}

	private dir(path: string) {
		return this.bucket(path).dir;
	}

	list(path: string): Snapshot[] {
		const dir = this.dir(path);
		if (!existsSync(dir)) return [];
		let names: string[];
		try {
			names = readdirSync(dir);
		} catch (e: any) {
			if (e?.code === "ENOENT") return [];
			throw e;
		}
		const entries: Array<Snapshot & { seq: number }> = [];
		for (const f of names) {
			const m = SNAPSHOT_FILE.exec(f);
			if (!m) continue;
			const time = Number(m[1]);
			const seq = Number(m[2]);
			if (!Number.isSafeInteger(time) || !Number.isSafeInteger(seq)) continue;
			try {
				const size = statSync(join(dir, f)).size;
				entries.push({ id: `${m[1]}-${m[2]}`, time, size, seq });
			} catch (e: any) {
				if (e?.code === "ENOENT") continue;
				throw e;
			}
		}
		entries.sort((a, b) => b.time - a.time || b.seq - a.seq);
		return entries.map(({ id, time, size }) => ({ id, time, size }));
	}

	async read(path: string, id: string): Promise<string> {
		if (!/^\d+-\d+$/.test(id)) throw new Error("bad snapshot id");
		return Bun.file(join(this.dir(path), `${id}.txt`)).text();
	}

	/** Saves `text` unless it equals the newest snapshot or exceeds the byte cap. */
	async record(path: string, text: string, now = Date.now()) {
		if (Buffer.byteLength(text, "utf8") > MAX_SNAPSHOT_BYTES) return;
		const { dir, rel } = this.bucket(path);
		await historySerial.run(dir, async () => {
			mkdirSync(dir, { recursive: true });
			const list = this.list(path);
			if (list.length) {
				try {
					if ((await this.read(path, list[0]!.id)) === text) return;
				} catch {
					// Newest snapshot was removed concurrently; continue recording.
				}
			}
			const sameMsSeqs = list
				.filter((s) => s.time === now)
				.map((s) => Number(s.id.slice(s.id.indexOf("-") + 1)))
				.filter(Number.isSafeInteger);
			const nextSeq = Math.max(-1, ...sameMsSeqs) + 1;
			await atomicWrite(join(dir, `${now}-${nextSeq}.txt`), text);
			await atomicWrite(join(dir, "PATH"), rel);
			for (const old of this.list(path).slice(KEEP)) rmSync(join(dir, `${old.id}.txt`), { force: true });
		});
	}
}
