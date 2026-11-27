// Unsaved text, kept while a folder is not open (ADR 0042): what each open document had that was not on disk, so
// that the window can close, and another folder be opened, without a question and without a loss. It is held in
// the app's own state folder, never in the workspace: one file for a document, in a folder for each workspace.
import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, readdirSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import type { KeptText } from "../shared/protocol";
import { renameReplacing } from "./atomic";
import { historyKey } from "./history";
import { dirs } from "./paths";
import { Serial } from "./serial";
import { isPathInsideRoot } from "./workspace";

/** What a document with no file yet is called: `untitled:Untitled-1`. */
const UNTITLED = /^untitled:[^/\\\0]{1,200}$/;
const KEPT_FILE = /^[fu]-[0-9a-f]{16}\.json$/;

const hash = (text: string) => createHash("sha1").update(text).digest("hex").slice(0, 16);

/** One folder's kept texts are written one after another, in the order they were asked for. */
const stores = new Serial();

/** What one kept file holds. `path` is the file's place in its folder, as it is written there. */
type Stored = { v: 1; path?: string; untitled?: string; text: string; saved?: { text: string; mtime: number }; language?: string };

async function atomicWrite(path: string, content: string): Promise<void> {
	mkdirSync(dirname(path), { recursive: true });
	const temp = `${path}.${process.pid}.${randomUUID().slice(0, 8)}.tmp`;
	try {
		await Bun.write(temp, content);
		await renameReplacing(temp, path);
	} catch (err) {
		rmSync(temp, { force: true });
		throw err;
	}
}

/**
 * What the person is told when unsaved text could not be kept: the app then asks before a window closes or
 * another folder is opened, as it did before it kept any (ADR 0009), since closing would lose the text.
 */
export function unsavedNotKept(folder: string, reason: string): string {
	// The system names the file it could not write, which here is a temporary one in the folder already named.
	reason = reason.replace(/,\s*[a-z]+\s+'[^']*'(?:\s*->\s*'[^']*')?\s*$/, "");
	return `Unsaved text is not being kept: it could not be written to ${folder} (${reason}). Until that folder can be written, closing the window or opening another folder asks first what to do with unsaved changes. This is said once, not at every change.`;
}

/** A kept file as it reads, or nothing where it does not. */
async function readStored(file: string): Promise<Stored | undefined> {
	try {
		const stored = JSON.parse(await Bun.file(file).text()) as Stored;
		return stored?.v === 1 && typeof stored.text === "string" ? stored : undefined;
	} catch {
		return undefined;
	}
}

const savedOf = (from: { saved?: { text: string; mtime: number } } | undefined) =>
	from?.saved && typeof from.saved.text === "string" ? { text: from.saved.text, mtime: Number(from.saved.mtime) || 0 } : undefined;

export class Unsaved {
	/**
	 * The file each kept text was made over, as it was last given, by where the text is kept. The view sends it
	 * once and then only the text, which changes at every key; it is written with each text all the same, so that
	 * a kept file is whole by itself.
	 */
	private bases = new Map<string, { text: string; mtime: number }>();

	constructor(
		/** The folder the kept texts of every workspace are in. */
		readonly base = join(dirs.state, "unsaved"),
	) {}

	/** Where the kept texts of a workspace are. */
	dir(root: string): string {
		return join(this.base, historyKey(resolve(root), resolve(root)).rootKey);
	}

	/** Where a document's text is kept, and the name it is known by there. A path that is neither in the folder nor a document without a file has no place. */
	private place(root: string, path: string): { file: string; name: { path: string } | { untitled: string } } {
		if (typeof path !== "string" || !path) throw new Error("unsaved text was given no document to be kept for");
		if (UNTITLED.test(path)) return { file: join(this.dir(root), `u-${hash(path)}.json`), name: { untitled: path } };
		if (!isPathInsideRoot(root, path, true)) throw new Error(`outside the workspace: ${path}`);
		const { relKey, rel } = historyKey(resolve(root), path);
		return { file: join(this.dir(root), `f-${relKey}.json`), name: { path: rel } };
	}

	/**
	 * Keeps the text of each document in `keep`, and forgets what was kept for each path in `drop`. Done when all
	 * of it is on disk; throws when a text could not be written, with the rest written all the same.
	 */
	keep(root: string, keep: readonly KeptText[], drop: readonly string[]): Promise<void> {
		const dir = this.dir(root);
		return stores.run(dir, async () => {
			let failed: unknown;
			for (const doc of keep) {
				try {
					const { file, name } = this.place(root, doc.path);
					if (typeof doc.text !== "string") throw new Error(`unsaved text of ${doc.path} is not text`);
					// Not given this time: the one given before, from here or, after a restart, from the kept file.
					const saved = "path" in name ? (savedOf(doc) ?? this.bases.get(file) ?? savedOf(await readStored(file))) : undefined;
					if (saved) this.bases.set(file, saved);
					const stored: Stored = {
						v: 1,
						...name,
						text: doc.text,
						...(saved ? { saved } : {}),
						...(typeof doc.language === "string" ? { language: doc.language } : {}),
					};
					await atomicWrite(file, JSON.stringify(stored));
				} catch (e) {
					failed ??= e;
				}
			}
			for (const path of drop) {
				try {
					const { file } = this.place(root, path);
					this.bases.delete(file);
					rmSync(file, { force: true });
				} catch (e) {
					failed ??= e;
				}
			}
			if (failed) throw failed;
		});
	}

	/**
	 * The texts kept for a workspace, each with the file's own path. A kept file that does not read (cut short,
	 * or written by hand) is passed over and left where it is: it is not this app's to throw away unread.
	 */
	list(root: string): Promise<KeptText[]> {
		const dir = this.dir(root);
		return stores.run(dir, async () => {
			let names: string[];
			try {
				names = readdirSync(dir);
			} catch {
				return [];
			}
			const kept: KeptText[] = [];
			for (const name of names.filter((n) => KEPT_FILE.test(n)).sort()) {
				const stored = await readStored(join(dir, name));
				if (!stored) continue;
				const untitled = name.startsWith("u-");
				const path = untitled ? stored.untitled : typeof stored.path === "string" && stored.path ? join(resolve(root), stored.path) : undefined;
				if (!path || (untitled ? !UNTITLED.test(path) : !isPathInsideRoot(root, path, true))) continue;
				const saved = untitled ? undefined : savedOf(stored);
				kept.push({ path, text: stored.text, ...(saved ? { saved } : {}), ...(typeof stored.language === "string" ? { language: stored.language } : {}) });
			}
			return kept;
		});
	}
}
