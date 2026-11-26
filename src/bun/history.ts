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
/** As many copies larger than that as are kept of one file (`keep`): each is as large as the file was. */
const KEEP_LARGE = 5;
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

/**
 * What the person is told when a file was saved and its snapshot could not be written: what is not kept, where
 * and why in the system's own words, and that the save itself worked. A save does not fail for it, so without
 * these words nobody knew, and a discard went on promising a copy in local history that was not made.
 */
export function historyNotKept(folder: string, saved: string, reason: string): string {
	return `Local history is not being kept: a copy of ${saved} could not be written to ${folder} (${reason}). The file itself was saved. Until that folder can be written there are no earlier versions to go back to, also not of a file that is discarded. This is said once, not at every save.`;
}

/**
 * What the person is told when a step that cannot be taken back (a discard, a replace) is refused because the copy
 * of the file for local history could not be made: the step was offered with the words that the file as it was is
 * kept there, and without the copy there is no way back from it.
 */
export function copyNotKept(name: string, reason: string): string {
	return `no copy of ${name} could be kept in local history (${reason}): the file is left as it is`;
}

export class History {
	private normalizedRoot: string;

	constructor(
		root: string,
		/** The folder the snapshots of every workspace are kept in. */
		readonly base = join(dirs.data, "history"),
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

	/**
	 * Saves `text` unless it equals the newest snapshot or exceeds the byte cap. Says whether a snapshot was
	 * written: one passed over wrote nothing, and so does not show that the folder can be written.
	 */
	async record(path: string, text: string, now = Date.now()): Promise<boolean> {
		if (Buffer.byteLength(text, "utf8") > MAX_SNAPSHOT_BYTES) return false;
		return this.snapshot(path, text, now);
	}

	/**
	 * Keeps `text` whatever its size: the copy of a file as it is, made before a step that cannot be taken back (a
	 * discard, a replace across files). Done when the text is in local history, written now or there already as the
	 * newest snapshot; throws when it could not be written. The byte cap is for saves, each of which leaves the
	 * file itself behind: a discard and a replace said that the file as it was is kept, and for a text over the cap
	 * (`record`) nothing was, with nothing said. Such a step is rare, and its copy is the only way back from it.
	 */
	async keep(path: string, text: string, now = Date.now()): Promise<void> {
		await this.snapshot(path, text, now);
	}

	/** Writes `text` as the newest snapshot, unless it is that already. Says whether it wrote one. */
	private async snapshot(path: string, text: string, now: number): Promise<boolean> {
		const { dir, rel } = this.bucket(path);
		return historySerial.run(dir, async () => {
			mkdirSync(dir, { recursive: true });
			const list = this.list(path);
			if (list.length) {
				try {
					if ((await this.read(path, list[0]!.id)) === text) return false;
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
			const kept = this.list(path);
			// Of the copies over the cap only the last few stay: a hundred of them would be a hundred times the file.
			const large = kept.filter((each) => each.size > MAX_SNAPSHOT_BYTES).slice(KEEP_LARGE);
			for (const old of [...kept.slice(KEEP), ...large]) rmSync(join(dir, `${old.id}.txt`), { force: true });
			return true;
		});
	}
}
