// The low findings of the pass 3 audit in the backend's files and settings: listing, reading, saving, and the two
// settings files. Each test runs the code it names, in folders made for it and removed after. What needs a link
// is passed over where links cannot be made, and what needs a file's permissions to hold where they do not (root).
import { afterAll, describe, expect, test } from "bun:test";
import { chmodSync, linkSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, truncateSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createBackend, type Host } from "../src/bun/backend";
import { dirs } from "../src/bun/paths";
import { catalogFilesOf, listDocs, readProject } from "../src/bun/project";
import { checked, merge, SettingsStore } from "../src/bun/settings";
import { READ_MAX_BYTES, WorkspaceFiles } from "../src/bun/workspace";

const base = mkdtempSync(join(tmpdir(), "ssl-studio-p3l-files-"));
afterAll(() => rmSync(base, { recursive: true, force: true }));
const fresh = (name: string) => {
	const dir = join(base, name);
	mkdirSync(dir, { recursive: true });
	return dir;
};
const posix = process.platform !== "win32";
const root0 = posix && process.getuid?.() === 0;
const modeOf = (path: string) => statSync(path).mode & 0o777;
const leftovers = (dir: string) => readdirSync(dir).filter((name) => name.endsWith(".ssl-studio-tmp") || name.endsWith(".tmp"));

/** A link, or false where this system does not let one be made (the test is then passed over). */
const link = (target: string, at: string) => {
	try {
		symlinkSync(target, at);
		return true;
	} catch {
		return false;
	}
};

const makeHost = (): Host => ({
	app: "test",
	kind: "app",
	emit: () => {},
	pick: async () => null,
	trash: async () => {},
	quit: () => {},
});

/** The app's own folders somewhere of the test's, for as long as the work takes. */
async function withDirs<T>(name: string, work: (d: { config: string; data: string; state: string }) => Promise<T>): Promise<T> {
	const before = { ...dirs };
	const sandbox = fresh(name);
	Object.assign(dirs, { config: join(sandbox, "config"), data: join(sandbox, "data"), state: join(sandbox, "state") });
	try {
		return await work({ config: dirs.config, data: dirs.data, state: dirs.state });
	} finally {
		Object.assign(dirs, before);
	}
}

/** What is written to the log while the work runs. */
async function logged(work: () => Promise<void>): Promise<string[]> {
	const said = console.error;
	const lines: string[] = [];
	console.error = (...args: unknown[]) => void lines.push(args.map(String).join(" "));
	try {
		await work();
	} finally {
		console.error = said;
	}
	return lines;
}

describe("1. a project folder that is a link out of the workspace", () => {
	/** A workspace beside a folder that is not part of it, which holds documents and code. */
	const beside = (name: string) => {
		const top = fresh(name);
		const root = join(top, "ws");
		const outside = join(top, "outside");
		mkdirSync(root);
		mkdirSync(join(outside, "docs", "specs"), { recursive: true });
		mkdirSync(join(outside, "src"));
		writeFileSync(join(outside, "docs", "specs", "Elsewhere.md"), "# A spec kept elsewhere\n\nIts summary is not this project's.\n");
		writeFileSync(join(outside, "docs", "Notes.md"), "# Notes kept elsewhere\n\nNot this project's either.\n");
		writeFileSync(join(outside, "src", "Elsewhere.ssl"), ":PROCEDURE Elsewhere;\n:ENDPROC;\n");
		return { root, outside };
	};

	test("is not listed through: not its files, not its documents' titles, not its code", async () => {
		const { root, outside } = beside("docs-out");
		if (!link(join(outside, "docs"), join(root, "docs")) || !link(join(outside, "src"), join(root, "src"))) return;
		const ws = new WorkspaceFiles(root);
		expect([...ws.files(join(root, "docs"))]).toEqual([]);
		expect([...ws.files(join(root, "docs", "specs"))]).toEqual([]);
		expect([...ws.files(join(root, "src"))]).toEqual([]);
		expect([...ws.files()]).toEqual([]);
		const project = await readProject(root);
		const listed = await listDocs(ws, project);
		expect(listed.filter((doc) => doc.group === "specs" || doc.group === "docs")).toEqual([]);
		expect(JSON.stringify(listed)).not.toContain("kept elsewhere");
		expect(catalogFilesOf(ws, project, "code")).toEqual([]);
	});

	test("a link that stays inside the workspace is followed, once", () => {
		const root = fresh("docs-in");
		mkdirSync(join(root, "handbook", "specs"), { recursive: true });
		writeFileSync(join(root, "handbook", "specs", "Login.md"), "# Login\n");
		writeFileSync(join(root, "handbook", "Notes.md"), "# Notes\n");
		if (!link("handbook", join(root, "docs"))) return;
		const ws = new WorkspaceFiles(root);
		expect([...ws.files(join(root, "docs"))].sort()).toEqual([join(root, "docs", "Notes.md"), join(root, "docs", "specs", "Login.md")]);
		// From the top the link is not a folder to the walk: the files are listed under their own folder only.
		expect([...ws.files()].sort()).toEqual([join(root, "handbook", "Notes.md"), join(root, "handbook", "specs", "Login.md")]);
	});

	test("links that lead round end the listing, they do not hang it", () => {
		const root = fresh("docs-round");
		writeFileSync(join(root, "Top.md"), "# Top\n");
		// The folder itself under its own name, and two links that are each other.
		if (!link(".", join(root, "docs")) || !link("b", join(root, "a")) || !link("a", join(root, "b"))) return;
		const ws = new WorkspaceFiles(root);
		expect([...ws.files(join(root, "docs"))]).toEqual([join(root, "docs", "Top.md")]);
		expect([...ws.files(join(root, "a"))]).toEqual([]);
		expect([...ws.files()]).toEqual([join(root, "Top.md")]);
	});

	test("a folder asked for from outside the workspace is not listed", () => {
		const { root, outside } = beside("docs-other");
		const ws = new WorkspaceFiles(root);
		expect([...ws.files(outside)]).toEqual([]);
		expect([...ws.files(join(root, "..", "outside", "docs"))]).toEqual([]);
	});
});

describe("2. a file whose name is as long as a name may be", () => {
	test.skipIf(!posix)("is saved, again and again, and nothing is left beside it", async () => {
		const root = fresh("long-name");
		const ws = new WorkspaceFiles(root);
		// 255 bytes, the most a name may have on the usual file systems; and one of letters that take two bytes each.
		const names = [`${"N".repeat(251)}.ssl`, `${"é".repeat(125)}.ssl`];
		for (const name of names) {
			expect(Buffer.byteLength(name)).toBeGreaterThan(216);
			const path = join(root, name);
			await ws.create(path, "file");
			await ws.write(path, "first\n");
			await ws.write(path, "second\n");
			expect(readFileSync(path, "utf8")).toBe("second\n");
			await ws.writeBytes(path, new TextEncoder().encode("bytes\n"));
			expect(readFileSync(path, "utf8")).toBe("bytes\n");
		}
		expect(readdirSync(root).sort()).toEqual([...names].sort());
	});

	test("the temporary file of a write that fails is taken away, and one left behind is not listed", async () => {
		const root = fresh("long-leftover");
		const ws = new WorkspaceFiles(root);
		mkdirSync(join(root, "taken"));
		// Bytes cannot take the place of a folder: the write fails after its temporary file was made.
		await expect(ws.writeBytes(join(root, "taken"), new Uint8Array([1, 2, 3]))).rejects.toThrow();
		expect(leftovers(root)).toEqual([]);
		// One a crash left, under a name of the shape now made.
		writeFileSync(join(root, ".4242.0a1b2c3d4e5f.ssl-studio-tmp"), "half\n");
		writeFileSync(join(root, "Kept.ssl"), ":RETURN 1;\n");
		expect(ws.list(root).map((entry) => entry.name)).toEqual(["taken", "Kept.ssl"]);
		expect([...ws.files()]).toEqual([join(root, "Kept.ssl")]);
	});
});

describe("3. a text too large to open", () => {
	/** A text of this many bytes that takes no room on disk: lines at its start, and nothing after them. */
	const sized = (path: string, bytes: number) => {
		writeFileSync(path, "INSERT INTO results VALUES (1, 'a', 42.0);\n".repeat(400));
		truncateSync(path, bytes);
	};

	test("is refused with its name, its size and the most that is read", async () => {
		const root = fresh("large");
		mkdirSync(join(root, "data"));
		const ws = new WorkspaceFiles(root);
		sized(join(root, "data", "dump.sql"), 2 * READ_MAX_BYTES);
		await expect(ws.read(join(root, "data", "dump.sql"))).rejects.toThrow(`${join("data", "dump.sql")} is 40.0 MB: too large to open here (the most is 20.0 MB).`);
		sized(join(root, "over.csv"), READ_MAX_BYTES + 1);
		await expect(ws.read(join(root, "over.csv"))).rejects.toThrow(/^over\.csv is 20\.0 MB: too large to open here/);
	});

	// Where a file can be given a size without being given the bytes (not on Windows, where it would take the room).
	test.skipIf(!posix)("is refused by its size, before it is read", async () => {
		const root = fresh("large-unread");
		const ws = new WorkspaceFiles(root);
		sized(join(root, "dump.sql"), 3 * 1024 * 1024 * 1024);
		const started = performance.now();
		await expect(ws.read(join(root, "dump.sql"))).rejects.toThrow("dump.sql is 3072.0 MB: too large to open here (the most is 20.0 MB).");
		// Three gigabytes read into memory would have taken far longer than this, where they fit at all.
		expect(performance.now() - started).toBeLessThan(2000);
	});

	test("what the app opens today is still read: a text at the limit, a large registry, minified JSON", async () => {
		const root = fresh("large-ok");
		const ws = new WorkspaceFiles(root);
		expect(READ_MAX_BYTES).toBe(20 * 1024 * 1024);
		sized(join(root, "at-limit.sql"), READ_MAX_BYTES);
		expect((await ws.read(join(root, "at-limit.sql"))).text.length).toBe(READ_MAX_BYTES);
		const registry = `ID,Name,Status\n${Array.from({ length: 120_000 }, (_, row) => `${row},Analysis ${row},verified`).join("\n")}\n`;
		expect(Buffer.byteLength(registry)).toBeGreaterThan(3 * 1024 * 1024);
		writeFileSync(join(root, "registry.csv"), registry);
		expect((await ws.read(join(root, "registry.csv"))).text).toBe(registry);
		const minified = JSON.stringify(Array.from({ length: 60_000 }, (_, n) => ({ name: `package-${n}`, licence: "MIT" })));
		writeFileSync(join(root, "notices.json"), minified);
		expect((await ws.read(join(root, "notices.json"))).text).toBe(minified);
	});

	test("bytes that are not text are still answered without being read, however many", async () => {
		const root = fresh("large-bytes");
		const ws = new WorkspaceFiles(root);
		writeFileSync(join(root, "archive.bin"), new Uint8Array([0, 1, 2, 3]));
		truncateSync(join(root, "archive.bin"), 3 * READ_MAX_BYTES);
		const read = await ws.read(join(root, "archive.bin"));
		expect(read.text).toBe("");
		expect(read.binary).toEqual({ size: 3 * READ_MAX_BYTES });
	});
});

describe("4. a settings file edited by hand", () => {
	const slip = '{\n  "fontSize": 20,\n  "theme": "dark",\n}\n';

	test("a slip in the user's file is said with the file and the place, its text is kept, and the other file is still used", async () => {
		await withDirs("dirs-slip-user", async ({ config }) => {
			const root = fresh("slip-user");
			mkdirSync(config, { recursive: true });
			mkdirSync(join(root, ".ssl-studio"));
			const file = join(config, "settings.json");
			writeFileSync(file, slip);
			writeFileSync(join(root, ".ssl-studio", "settings.json"), '{ "minimap": false }\n');
			const store = new SettingsStore(() => root);
			let loaded!: Awaited<ReturnType<SettingsStore["load"]>>;
			const lines = await logged(async () => {
				loaded = await store.load();
				// Read again and again (every listing of the documents reads the settings): said in the log once.
				await store.load();
				await store.load();
			});
			expect(loaded.user).toEqual({});
			expect(loaded.effective.fontSize).toBe(13);
			expect(loaded.effective.minimap).toBe(false);
			expect(loaded.problems).toEqual([`${file} does not read as settings (line 4, column 1: A comma is followed by another name, not by }.), so none of its settings are used. It is not written over until it is mended by hand, or removed.`]);
			expect(lines).toEqual(loaded.problems!);
			// The save is refused in the same words, and the file is as the user left it.
			await expect(store.save("user", { minimap: true })).rejects.toThrow(`${file} does not read as settings (line 4, column 1: A comma is followed by another name, not by }.), so it is not written over.`);
			expect(readFileSync(file, "utf8")).toBe(slip);
			expect(readdirSync(config)).toEqual(["settings.json"]);
			// Mended, it is read whole, nothing is said of it, and it is saved into.
			writeFileSync(file, slip.replace('"dark",', '"dark"'));
			const mended = await store.load();
			expect(mended.problems).toBeUndefined();
			expect(mended.user).toEqual({ fontSize: 20, theme: "dark" });
			await store.save("user", { wordWrap: true });
			expect(JSON.parse(readFileSync(file, "utf8"))).toEqual({ fontSize: 20, theme: "dark", wordWrap: true });
		});
	});

	test("a slip in the workspace's file is said too, and the user's settings still hold", async () => {
		await withDirs("dirs-slip-ws", async ({ config }) => {
			const root = fresh("slip-ws");
			mkdirSync(config, { recursive: true });
			mkdirSync(join(root, ".ssl-studio"));
			writeFileSync(join(config, "settings.json"), '{ "fontSize": 18 }\n');
			const file = join(root, ".ssl-studio", "settings.json");
			const byHand = '{\n  "minimap": false\n  "wordWrap": true\n}\n';
			writeFileSync(file, byHand);
			const store = new SettingsStore(() => root);
			let loaded!: Awaited<ReturnType<SettingsStore["load"]>>;
			await logged(async () => void (loaded = await store.load()));
			expect(loaded.workspace).toEqual({});
			expect(loaded.effective.fontSize).toBe(18);
			expect(loaded.effective.minimap).toBe(true);
			expect(loaded.problems?.length).toBe(1);
			expect(loaded.problems![0]).toStartWith(`${file} does not read as settings (line 3, column 3: `);
			await expect(store.save("workspace", { layout: { left: false, right: false, bottom: true, leftWidth: 260, rightWidth: 360, bottomHeight: 200 } })).rejects.toThrow(/settings\.json does not read as settings \(line 3, column 3: /);
			expect(readFileSync(file, "utf8")).toBe(byHand);
			// What is not names and values is said as that.
			writeFileSync(file, "[1, 2]\n");
			await logged(async () => void (loaded = await store.load()));
			expect(loaded.problems).toEqual([`${file} does not hold settings (it is not a list of names and values), so none of its settings are used. It is not written over until it is mended by hand, or removed.`]);
		});
	});

	test("a file that is not there, or is empty, is no problem", async () => {
		await withDirs("dirs-slip-none", async ({ config }) => {
			const root = fresh("slip-none");
			const store = new SettingsStore(() => root);
			expect((await store.load()).problems).toBeUndefined();
			mkdirSync(config, { recursive: true });
			writeFileSync(join(config, "settings.json"), "  \n");
			expect((await store.load()).problems).toBeUndefined();
		});
	});

	test("a value of the wrong kind is not taken, by one rule to each kind of setting", () => {
		// As whatever it is, for the comparisons: what is written in a file by hand has no type to hold it to.
		const taken = (layer: unknown): unknown => checked(layer);
		// A string.
		expect(taken({ templatesFolder: ["docs/templates"], lspPath: 123, theme: { dark: true }, uiFont: "Inter" })).toEqual({ uiFont: "Inter" });
		// A boolean.
		expect(taken({ wordWrap: "yes", minimap: 1, formatOnSave: false })).toEqual({ formatOnSave: false });
		// A number, held to its range.
		expect(taken({ fontSize: "20", uiScale: Number.NaN, rulerMargin: null })).toEqual({});
		expect(taken({ fontSize: 900, uiScale: 0.1, rulerMargin: 12 })).toEqual({ fontSize: 40, uiScale: 0.8, rulerMargin: 12 });
		// One of its words.
		expect(taken({ stylePreset: "mine", sqlDialect: "nope" })).toEqual({});
		expect(taken({ stylePreset: "server", sqlDialect: "plsql" })).toEqual({ stylePreset: "server", sqlDialect: "plsql" });
		// A list of strings.
		expect(taken({ agentOwnModels: "ollama/one" })).toEqual({});
		expect(taken({ agentOwnModels: ["ollama/one", 7, null, "ollama/two"] })).toEqual({ agentOwnModels: ["ollama/one", "ollama/two"] });
		// Names and values: each value by its rule, the rest of the object kept.
		expect(taken({ limits: { bytes: "many", codeLines: 300 }, layout: { left: "no", leftWidth: "wide", rightWidth: 400, dock: { agent: "left", git: "up" } }, keys: { "ctrl+s": 7, "ctrl+k": "quick-open" }, regionColors: "red" })).toEqual({
			limits: { codeLines: 300 },
			layout: { rightWidth: 400, dock: { agent: "left" } },
			keys: { "ctrl+k": "quick-open" },
		});
		expect(taken({ ssl: "tabs", csvTable: [1] })).toEqual({});
		expect(taken({ ssl: { format: { indentStyle: "space" } } })).toEqual({ ssl: { format: { indentStyle: "space" } } });
		// A setting this version does not know is taken as it is written; what is no settings at all gives none.
		expect(taken({ fromLater: [1, 2] })).toEqual({ fromLater: [1, 2] });
		expect(taken("theme")).toEqual({});
		// The settings in force take each layer by the same rules: the default, or the layer below, shows through.
		const effective = merge({ fontSize: 16, templatesFolder: "docs/templates" }, { fontSize: "big", templatesFolder: 5, limits: { bytes: "many" } } as never);
		expect(effective.fontSize).toBe(16);
		expect(effective.templatesFolder).toBe("docs/templates");
		expect(effective.limits).toEqual({ bytes: 50 * 1024, codeLines: 400, historyEntries: 3 });
	});

	test("in both files: wrong values do not reach the app, and stay in the file when another setting is saved", async () => {
		await withDirs("dirs-kinds", async ({ config }) => {
			const root = fresh("kinds");
			mkdirSync(config, { recursive: true });
			mkdirSync(join(root, ".ssl-studio"));
			mkdirSync(join(root, "docs"));
			writeFileSync(join(root, "docs", "Notes.md"), "# Notes\n");
			const userFile = join(config, "settings.json");
			const wsFile = join(root, ".ssl-studio", "settings.json");
			writeFileSync(userFile, JSON.stringify({ lspPath: 123, uiScale: "big", keys: { "ctrl+s": 7 }, agentModel: ["x"], fontSize: 15 }));
			writeFileSync(wsFile, JSON.stringify({ templatesFolder: ["docs/templates"], wordWrap: "yes", limits: { bytes: "many" }, minimap: false }));
			const store = new SettingsStore(() => root);
			const loaded = await store.load();
			expect(loaded.problems).toBeUndefined();
			expect(loaded.user).toEqual({ keys: {}, fontSize: 15 });
			expect(loaded.workspace as unknown).toEqual({ limits: {}, minimap: false });
			expect(loaded.effective.lspPath).toBeUndefined();
			expect(loaded.effective.uiScale).toBeUndefined();
			expect(loaded.effective.agentModel).toBeUndefined();
			expect(loaded.effective.templatesFolder).toBeUndefined();
			expect(loaded.effective.wordWrap).toBeUndefined();
			expect(loaded.effective.limits.bytes).toBe(50 * 1024);
			// The list of documents is given the folder as the settings have it: a list for a name used to stop it.
			const ws = new WorkspaceFiles(root);
			const listed = await listDocs(ws, await readProject(root), { templatesFolder: loaded.effective.templatesFolder });
			expect(listed.some((doc) => doc.name === "Notes.md")).toBe(true);
			// What the user wrote is theirs: another setting saved leaves it in the file.
			await store.save("workspace", { rulers: false });
			expect(JSON.parse(readFileSync(wsFile, "utf8"))).toEqual({ templatesFolder: ["docs/templates"], wordWrap: "yes", limits: { bytes: "many" }, minimap: false, rulers: false });
		});
	});
});

describe("5. a settings file that is a link", () => {
	test("the user's: the save lands in the file the link leads to, and the link stays", async () => {
		await withDirs("dirs-link-user", async ({ config }) => {
			const dotfiles = fresh("dotfiles");
			mkdirSync(config, { recursive: true });
			writeFileSync(join(dotfiles, "studio.json"), '{ "fontSize": 15 }\n');
			if (posix) chmodSync(join(dotfiles, "studio.json"), 0o640);
			const file = join(config, "settings.json");
			if (!link(join(dotfiles, "studio.json"), file)) return;
			const store = new SettingsStore(() => null);
			const effective = await store.save("user", { minimap: false });
			expect(effective.fontSize).toBe(15);
			expect(effective.minimap).toBe(false);
			expect(lstatSync(file).isSymbolicLink()).toBe(true);
			expect(JSON.parse(readFileSync(join(dotfiles, "studio.json"), "utf8"))).toEqual({ fontSize: 15, minimap: false });
			if (posix) expect(modeOf(join(dotfiles, "studio.json"))).toBe(0o640);
			// Nothing is left beside the link or beside its file.
			expect(readdirSync(config)).toEqual(["settings.json"]);
			expect(readdirSync(dotfiles)).toEqual(["studio.json"]);
		});
	});

	test("a link to a file that is not there yet makes that file", async () => {
		await withDirs("dirs-link-new", async ({ config }) => {
			const dotfiles = fresh("dotfiles-new");
			mkdirSync(config, { recursive: true });
			const file = join(config, "settings.json");
			if (!link(join(dotfiles, "later.json"), file)) return;
			await new SettingsStore(() => null).save("user", { wordWrap: true });
			expect(lstatSync(file).isSymbolicLink()).toBe(true);
			expect(JSON.parse(readFileSync(join(dotfiles, "later.json"), "utf8"))).toEqual({ wordWrap: true });
		});
	});

	test("the workspace's: a link inside the workspace is kept, one that leads out of it is still refused", async () => {
		await withDirs("dirs-link-ws", async () => {
			const root = fresh("link-ws");
			mkdirSync(join(root, ".ssl-studio"));
			mkdirSync(join(root, "shared"));
			writeFileSync(join(root, "shared", "studio.json"), '{ "fontSize": 16 }\n');
			const file = join(root, ".ssl-studio", "settings.json");
			if (!link(join("..", "shared", "studio.json"), file)) return;
			const store = new SettingsStore(() => root);
			await store.save("workspace", { minimap: false });
			expect(lstatSync(file).isSymbolicLink()).toBe(true);
			expect(JSON.parse(readFileSync(join(root, "shared", "studio.json"), "utf8"))).toEqual({ fontSize: 16, minimap: false });
			expect(readdirSync(join(root, ".ssl-studio"))).toEqual(["settings.json"]);
			expect(readdirSync(join(root, "shared"))).toEqual(["studio.json"]);

			const outside = fresh("link-ws-outside");
			writeFileSync(join(outside, "theirs.json"), '{ "fontSize": 30 }\n');
			rmSync(file);
			symlinkSync(join(outside, "theirs.json"), file);
			await expect(store.save("workspace", { minimap: true })).rejects.toThrow(/outside the workspace/);
			expect(readFileSync(join(outside, "theirs.json"), "utf8")).toBe('{ "fontSize": 30 }\n');
		});
	});

	test.skipIf(!posix)("a theme whose name is as long as a name may be is kept", async () => {
		await withDirs("dirs-theme-long", async ({ config }) => {
			const from = fresh("theme-long");
			const name = `${"t".repeat(250)}.json`;
			writeFileSync(join(from, name), '{ "name": "Long", "colors": {} }\n');
			const theme = await new SettingsStore(() => null).importTheme(join(from, name));
			expect(theme.name).toBe("Long");
			expect(readdirSync(join(config, "themes"))).toEqual([name]);
		});
	});
});

describe("6. a save whose local history cannot be kept", () => {
	test("is a save: the file is written, the answer says so, and the log says the history was not kept, once", async () => {
		await withDirs("dirs-history", async ({ data }) => {
			const root = fresh("history");
			const file = join(root, "Script.ssl");
			writeFileSync(file, ":RETURN 1;\n");
			// Where the history is kept there is a file: no snapshot can be made (as with a full or read-only folder).
			mkdirSync(data, { recursive: true });
			writeFileSync(join(data, "history"), "in the way\n");
			const backend = createBackend(makeHost(), root);
			await backend.ready;
			try {
				let first!: { mtime: number };
				let second!: { mtime: number };
				const lines = await logged(async () => {
					first = await backend.api.write(file, ":RETURN 2;\n");
					second = await backend.api.write(file, ":RETURN 3;\n");
				});
				expect(readFileSync(file, "utf8")).toBe(":RETURN 3;\n");
				expect(first.mtime).toBeGreaterThan(0);
				expect(second.mtime).toBe(statSync(file).mtimeMs);
				const said = lines.filter((line) => line.startsWith("Local history is not being kept"));
				expect(said.length).toBe(1);
				expect(said[0]).toContain(file);
				expect(await backend.api.history(file)).toEqual([]);
				// Once the history can be kept again it is, and a later failure is said anew.
				rmSync(join(data, "history"));
				await backend.api.write(file, ":RETURN 4;\n");
				expect((await backend.api.history(file)).length).toBe(1);
			} finally {
				backend.dispose();
			}
		});
	});
});

describe("7. a file with other names, and a read-only file", () => {
	test("a save of a file with a hard link is seen under both names, and they stay one file", async () => {
		const root = fresh("hard");
		writeFileSync(join(root, "One.ssl"), ":RETURN 1;\n");
		try {
			linkSync(join(root, "One.ssl"), join(root, "Other.ssl"));
		} catch {
			return;
		}
		if (posix) chmodSync(join(root, "One.ssl"), 0o640);
		const inode = statSync(join(root, "One.ssl")).ino;
		const ws = new WorkspaceFiles(root);
		const saved = await ws.write(join(root, "One.ssl"), ":RETURN 2;\n/* longer than it was */\n");
		expect(readFileSync(join(root, "Other.ssl"), "utf8")).toBe(":RETURN 2;\n/* longer than it was */\n");
		expect(saved.mtime).toBe(statSync(join(root, "Other.ssl")).mtimeMs);
		// A shorter text leaves nothing of the longer one behind.
		await ws.write(join(root, "Other.ssl"), ":RETURN 3;\n");
		expect(readFileSync(join(root, "One.ssl"), "utf8")).toBe(":RETURN 3;\n");
		await ws.writeBytes(join(root, "One.ssl"), new TextEncoder().encode("bytes\n"));
		expect(readFileSync(join(root, "Other.ssl"), "utf8")).toBe("bytes\n");
		expect(statSync(join(root, "One.ssl")).nlink).toBe(2);
		expect(statSync(join(root, "One.ssl")).ino).toBe(inode);
		expect(statSync(join(root, "Other.ssl")).ino).toBe(inode);
		if (posix) expect(modeOf(join(root, "Other.ssl"))).toBe(0o640);
		expect(readdirSync(root).sort()).toEqual(["One.ssl", "Other.ssl"]);
	});

	test("a file with one name is still replaced whole, by a rename", async () => {
		const root = fresh("single");
		writeFileSync(join(root, "One.ssl"), ":RETURN 1;\n");
		const inode = statSync(join(root, "One.ssl")).ino;
		const ws = new WorkspaceFiles(root);
		await ws.write(join(root, "One.ssl"), ":RETURN 2;\n");
		expect(readFileSync(join(root, "One.ssl"), "utf8")).toBe(":RETURN 2;\n");
		if (posix) expect(statSync(join(root, "One.ssl")).ino).not.toBe(inode);
	});

	test.skipIf(!posix || root0)("a read-only file is not written over, by text, by bytes, or through a link, and stays read-only", async () => {
		const root = fresh("read-only");
		mkdirSync(join(root, "lib"));
		const file = join(root, "lib", "Frozen.ssl");
		writeFileSync(file, ":RETURN 1;\n");
		chmodSync(file, 0o444);
		const ws = new WorkspaceFiles(root);
		try {
			await expect(ws.write(file, ":RETURN 2;\n")).rejects.toThrow(`${join("lib", "Frozen.ssl")} is read-only: it is not written over from here. Make the file writable, then save again.`);
			await expect(ws.writeBytes(file, new Uint8Array([1, 2]))).rejects.toThrow(/Frozen\.ssl is read-only/);
			if (link(join("lib", "Frozen.ssl"), join(root, "Link.ssl"))) {
				await expect(ws.write(join(root, "Link.ssl"), ":RETURN 2;\n")).rejects.toThrow(/^Link\.ssl is read-only/);
				expect(lstatSync(join(root, "Link.ssl")).isSymbolicLink()).toBe(true);
			}
			expect(readFileSync(file, "utf8")).toBe(":RETURN 1;\n");
			expect(modeOf(file)).toBe(0o444);
			expect(leftovers(join(root, "lib"))).toEqual([]);
			// Made writable by the user, it is saved.
			chmodSync(file, 0o644);
			await ws.write(file, ":RETURN 2;\n");
			expect(readFileSync(file, "utf8")).toBe(":RETURN 2;\n");
			expect(modeOf(file)).toBe(0o644);
		} finally {
			chmodSync(file, 0o644);
		}
	});

	test.skipIf(!posix || root0)("the backend's save of a read-only file fails with those words, which the view shows", async () => {
		await withDirs("dirs-read-only", async () => {
			const root = fresh("read-only-backend");
			const file = join(root, "Frozen.ssl");
			writeFileSync(file, ":RETURN 1;\n");
			chmodSync(file, 0o444);
			const backend = createBackend(makeHost(), root);
			await backend.ready;
			try {
				await expect(backend.api.write(file, ":RETURN 2;\n", true)).rejects.toThrow("Frozen.ssl is read-only: it is not written over from here.");
				expect(readFileSync(file, "utf8")).toBe(":RETURN 1;\n");
				expect(await backend.api.history(file)).toEqual([]);
			} finally {
				chmodSync(file, 0o644);
				backend.dispose();
			}
		});
	});
});
