// ADR 0034: unsaved text is kept by the app while its folder is not open, so that closing asks nothing and loses
// nothing. Here: where it is kept and for which folder (src/bun/unsaved.ts), and the two calls the view has for it
// (the real backend, in folders made for the test). The view's side is in pass4LowsViewCore.test.ts (B9-4), and
// the desktop window's in `hutch run selftest-close`.
import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createBackend, type Host } from "../src/bun/backend";
import { dirs } from "../src/bun/paths";
import { Unsaved, unsavedNotKept } from "../src/bun/unsaved";

const base = mkdtempSync(join(tmpdir(), "ssl-studio-unsaved-"));
afterAll(() => rmSync(base, { recursive: true, force: true }));

let made = 0;
/** A workspace of its own, with one file, and a folder to keep unsaved text in. */
function place() {
	const dir = join(base, `case-${++made}`);
	const root = join(dir, "ws");
	mkdirSync(join(root, "scripts"), { recursive: true });
	writeFileSync(join(root, "scripts", "a.ssl"), "one\n");
	return { root, store: join(dir, "kept"), file: join(root, "scripts", "a.ssl") };
}

/** Every file under a folder, by its path from there. */
function filesUnder(dir: string, from = dir): string[] {
	if (!existsSync(dir)) return [];
	return readdirSync(dir, { withFileTypes: true }).flatMap((each) => (each.isDirectory() ? filesUnder(join(dir, each.name), from) : [join(dir, each.name).slice(from.length + 1)]));
}

describe("unsaved text, kept for a folder", () => {
	test("what is kept comes back as it was: the text, the file it was made over, a document with no file yet", async () => {
		const { root, store, file } = place();
		const kept = new Unsaved(store);
		await kept.keep(
			root,
			[
				{ path: file, text: "one\ntwo\n", saved: { text: "one\n", mtime: 42 } },
				{ path: "untitled:Untitled-1", text: ":PROCEDURE Draft;\n", language: "ssl" },
			],
			[],
		);
		const back = await kept.list(root);
		expect(back.find((each) => each.path === file)).toEqual({ path: file, text: "one\ntwo\n", saved: { text: "one\n", mtime: 42 } });
		expect(back.find((each) => each.path === "untitled:Untitled-1")).toEqual({ path: "untitled:Untitled-1", text: ":PROCEDURE Draft;\n", language: "ssl" });
		expect(back.length).toBe(2);
	});

	test("it is kept in the app's own folder, and nothing is written in the workspace", async () => {
		const { root, store, file } = place();
		const before = filesUnder(root);
		await new Unsaved(store).keep(root, [{ path: file, text: "changed\n", saved: { text: "one\n", mtime: 1 } }], []);
		expect(filesUnder(root)).toEqual(before);
		expect(readFileSync(file, "utf8")).toBe("one\n");
		expect(filesUnder(store).length).toBe(1);
		// By default: under the state folder, which the tests have for themselves (test/setupSolid.ts).
		expect(new Unsaved().base).toBe(join(dirs.state, "unsaved"));
	});

	test("each folder has its own: one folder's unsaved text is not another's", async () => {
		const first = place();
		const second = place();
		const kept = new Unsaved(first.store);
		await kept.keep(first.root, [{ path: first.file, text: "first\n", saved: { text: "one\n", mtime: 1 } }], []);
		await kept.keep(second.root, [{ path: second.file, text: "second\n", saved: { text: "one\n", mtime: 1 } }], []);
		expect((await kept.list(first.root)).map((each) => each.text)).toEqual(["first\n"]);
		expect((await kept.list(second.root)).map((each) => each.text)).toEqual(["second\n"]);
		expect(kept.dir(first.root)).not.toBe(kept.dir(second.root));
	});

	test("a later text takes the earlier one's place, and keeps the file it was made over without being given it again", async () => {
		const { root, store, file } = place();
		const kept = new Unsaved(store);
		await kept.keep(root, [{ path: file, text: "a", saved: { text: "one\n", mtime: 7 } }], []);
		await kept.keep(root, [{ path: file, text: "ab" }], []);
		expect(await kept.list(root)).toEqual([{ path: file, text: "ab", saved: { text: "one\n", mtime: 7 } }]);
		// Also after a restart, when only the kept file knows it.
		await new Unsaved(store).keep(root, [{ path: file, text: "abc" }], []);
		expect(await new Unsaved(store).list(root)).toEqual([{ path: file, text: "abc", saved: { text: "one\n", mtime: 7 } }]);
		// Given another (the file was saved, and edited again): that one from then on.
		await kept.keep(root, [{ path: file, text: "abcd", saved: { text: "abc", mtime: 9 } }], []);
		expect(await kept.list(root)).toEqual([{ path: file, text: "abcd", saved: { text: "abc", mtime: 9 } }]);
	});

	test("what is no longer unsaved is forgotten, and forgetting what was never kept is nothing", async () => {
		const { root, store, file } = place();
		const kept = new Unsaved(store);
		await kept.keep(root, [{ path: file, text: "x", saved: { text: "one\n", mtime: 1 } }, { path: "untitled:Untitled-1", text: "y" }], []);
		await kept.keep(root, [], [file, join(root, "never.ssl")]);
		expect((await kept.list(root)).map((each) => each.path)).toEqual(["untitled:Untitled-1"]);
		await kept.keep(root, [], ["untitled:Untitled-1"]);
		expect(await kept.list(root)).toEqual([]);
		// The file it was made over went with it: kept again without one, it has none.
		await kept.keep(root, [{ path: file, text: "z" }], []);
		expect(await kept.list(root)).toEqual([{ path: file, text: "z" }]);
	});

	test("text is kept only for a file of the folder: one outside is refused, and the rest is kept all the same", async () => {
		const { root, store, file } = place();
		const kept = new Unsaved(store);
		const outside = join(base, "elsewhere.ssl");
		await expect(kept.keep(root, [{ path: outside, text: "no", saved: { text: "", mtime: 0 } }, { path: file, text: "yes", saved: { text: "one\n", mtime: 1 } }], [])).rejects.toThrow("outside the workspace");
		await expect(kept.keep(root, [{ path: join(root, "..", "elsewhere.ssl"), text: "no" }], [])).rejects.toThrow("outside the workspace");
		await expect(kept.keep(root, [{ path: "untitled:../../x", text: "no" }], [])).rejects.toThrow("outside the workspace");
		expect(await kept.list(root)).toEqual([{ path: file, text: "yes", saved: { text: "one\n", mtime: 1 } }]);
	});

	test("a kept file that does not read is passed over and left where it is", async () => {
		const { root, store, file } = place();
		const kept = new Unsaved(store);
		await kept.keep(root, [{ path: file, text: "good", saved: { text: "one\n", mtime: 1 } }], []);
		const broken = join(kept.dir(root), "f-0123456789abcdef.json");
		writeFileSync(broken, '{"v":1,"path":"scripts/b.ssl","text":"cut sho');
		writeFileSync(join(kept.dir(root), "f-fedcba9876543210.json"), JSON.stringify({ v: 1, path: "../outside.ssl", text: "not of this folder" }));
		expect((await kept.list(root)).map((each) => each.text)).toEqual(["good"]);
		expect(existsSync(broken)).toBe(true);
	});

	test("a folder with nothing kept has nothing, and asking makes no folder for it", async () => {
		const { root, store } = place();
		expect(await new Unsaved(store).list(root)).toEqual([]);
		expect(existsSync(store)).toBe(false);
	});

	test("what the person is told when it cannot be kept says where, why, and what follows from it", () => {
		const text = unsavedNotKept("/state/unsaved", "ENOSPC: no space left on device");
		expect(text).toContain("/state/unsaved");
		expect(text).toContain("ENOSPC: no space left on device");
		expect(text).toContain("asks first");
		// The temporary file the system names is left out: the folder is said once.
		const long = unsavedNotKept("/state/unsaved", "EACCES: permission denied, open '/state/unsaved/99a8/u-f73097.json.1081009.c3e5917d.tmp'");
		expect(long).toContain("(EACCES: permission denied)");
		expect(long).not.toContain(".tmp");
		expect(unsavedNotKept("/s", "EXDEV: cross-device link not permitted, rename '/s/a.tmp' -> '/s/a.json'")).toContain("(EXDEV: cross-device link not permitted)");
	});
});

describe("the backend keeps unsaved text for the view", () => {
	function hostOf() {
		const notices: string[] = [];
		const host: Host = {
			app: "test",
			kind: "app",
			emit: (event, payload) => void (event === "notice" && notices.push((payload as { text: string }).text)),
			pick: async () => null,
			trash: async () => undefined,
			quit: () => undefined,
		};
		return { host, notices };
	}

	test("for the open folder, and gives it back when that folder is open again", async () => {
		const { root, file } = place();
		const first = createBackend(hostOf().host, root);
		await first.ready;
		const opened = (await first.api.workspace())!.root;
		await first.api.unsavedKeep(opened, [{ path: file, text: "edited\n", saved: { text: "one\n", mtime: 3 } }], []);
		first.dispose();
		// The app, started again on the same folder.
		const again = createBackend(hostOf().host, root);
		await again.ready;
		expect(await again.api.unsavedKept()).toEqual([{ path: file, text: "edited\n", saved: { text: "one\n", mtime: 3 } }]);
		await again.api.unsavedKeep(opened, [], [file]);
		expect(await again.api.unsavedKept()).toEqual([]);
		again.dispose();
	});

	test("for a folder that was open in this run, after another has been opened: what was typed meanwhile is the first folder's", async () => {
		const first = place();
		const second = place();
		const backend = createBackend(hostOf().host, first.root);
		await backend.ready;
		const firstRoot = (await backend.api.workspace())!.root;
		await backend.api.openFolder(second.root);
		await backend.api.unsavedKeep(firstRoot, [{ path: first.file, text: "typed while the other opened\n", saved: { text: "one\n", mtime: 1 } }], []);
		// Not among the folder's that is open now.
		expect(await backend.api.unsavedKept()).toEqual([]);
		await backend.api.openFolder(first.root);
		expect((await backend.api.unsavedKept()).map((each) => each.text)).toEqual(["typed while the other opened\n"]);
		backend.dispose();
	});

	test("not for a folder that was never opened here, whatever a caller names", async () => {
		const open = place();
		const other = place();
		const backend = createBackend(hostOf().host, open.root);
		await backend.ready;
		await expect(backend.api.unsavedKeep(other.root, [{ path: other.file, text: "planted\n" }], [])).rejects.toThrow("only for a folder that was opened here");
		await expect(backend.api.unsavedKeep("", [], [])).rejects.toThrow("only for a folder that was opened here");
		await backend.api.openFolder(other.root);
		expect(await backend.api.unsavedKept()).toEqual([]);
		backend.dispose();
	});

	test("with no folder open there is nothing kept to ask for", async () => {
		const backend = createBackend(hostOf().host);
		await expect(backend.api.unsavedKept()).rejects.toThrow("no workspace open");
		backend.dispose();
	});
});
