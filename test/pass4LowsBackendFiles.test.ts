// The low findings of the pass 4 audit in the backend's files and settings: a file with two names saved by both at
// once, a save into a folder that takes no new file, and a settings file the user may not write. Each test runs the
// code it names, in folders made for it and removed after. What needs a link is passed over where links cannot be
// made, and what needs a file's permissions to hold where they do not (Windows, root).
import { afterAll, describe, expect, test } from "bun:test";
import { chmodSync, linkSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { createBackend, type Host } from "../src/bun/backend";
import { dirs } from "../src/bun/paths";
import { recent, SettingsStore } from "../src/bun/settings";
import { WorkspaceFiles } from "../src/bun/workspace";
import { plainFileError } from "../src/shared/paths";

const base = mkdtempSync(join(tmpdir(), "ssl-studio-p4l-files-"));
afterAll(() => rmSync(base, { recursive: true, force: true }));
const fresh = (name: string) => {
	const dir = join(base, name);
	mkdirSync(dir, { recursive: true });
	return dir;
};
const posix = process.platform !== "win32";
const root0 = posix && process.getuid?.() === 0;
const modeOf = (path: string) => statSync(path).mode & 0o777;

/** A link to a file's place, or false where this system does not let one be made (the test is then passed over). */
const link = (target: string, at: string) => {
	try {
		symlinkSync(target, at);
		return true;
	} catch {
		return false;
	}
};

/** A second name for a file (a hard link), or false where one cannot be made. */
const secondName = (file: string, name: string) => {
	try {
		linkSync(file, name);
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

/** The runs that went wrong, short enough to read when there are hundreds: how many, and the first of them. */
const few = (wrong: string[]) => ({ runs: wrong.length, first: wrong.slice(0, 3) });
const none = { runs: 0, first: [] as string[] };

/** What a refused piece of work said. */
const refusal = async (work: Promise<unknown>): Promise<string> =>
	work.then(
		() => "it was done",
		(e) => String(e?.message ?? e),
	);

describe("1. a file with two names, saved by both at once", () => {
	const long = `/* ${"a long remark ".repeat(200)}*/\n:RETURN 1;\n`;
	const short = ":RETURN 2;\n";

	test("is left as one of the two texts, whole, every time", async () => {
		const root = fresh("two-names");
		const one = join(root, "One.ssl");
		const other = join(root, "Other.ssl");
		writeFileSync(one, ":RETURN 0;\n");
		if (!secondName(one, other)) return;
		const inode = statSync(one).ino;
		const ws = new WorkspaceFiles(root);
		// Each save emptied the file and wrote into it, and the two ran at once (each waited only for saves by its
		// own name): about every second pair left the long text's length with the short text at its start.
		const mixed: string[] = [];
		for (let run = 0; run < 300; run++) {
			await Promise.all(run % 2 ? [ws.write(one, long), ws.write(other, short)] : [ws.write(other, short), ws.write(one, long)]);
			const got = readFileSync(one, "utf8");
			if (got !== long && got !== short) mixed.push(`run ${run}: ${got.length} characters, starting ${JSON.stringify(got.slice(0, 14))}`);
		}
		expect(few(mixed)).toEqual(none);
		// Still one file under both names.
		expect(statSync(one).nlink).toBe(2);
		expect(statSync(other).ino).toBe(inode);
		ws.close();
	});

	test("by its bytes, and through a link to one of its names, as well", async () => {
		const root = fresh("two-names-bytes");
		const one = join(root, "One.ssl");
		const other = join(root, "Other.ssl");
		writeFileSync(one, ":RETURN 0;\n");
		if (!secondName(one, other)) return;
		const ws = new WorkspaceFiles(root);
		const longBytes = new TextEncoder().encode(long);
		const shortBytes = new TextEncoder().encode(short);
		const mixed: string[] = [];
		for (let run = 0; run < 150; run++) {
			await Promise.all(run % 2 ? [ws.writeBytes(one, longBytes), ws.writeBytes(other, shortBytes)] : [ws.writeBytes(other, shortBytes), ws.writeBytes(one, longBytes)]);
			const got = readFileSync(one, "utf8");
			if (got !== long && got !== short) mixed.push(`bytes, run ${run}: ${got.length} characters`);
		}
		// A link to the first name is a third way to the file, in the line of the first name's saves: with a save by
		// the second name it is the same two lines.
		if (link("One.ssl", join(root, "Link.ssl"))) {
			for (let run = 0; run < 150; run++) {
				await Promise.all(run % 2 ? [ws.write(join(root, "Link.ssl"), long), ws.write(other, short)] : [ws.write(other, short), ws.write(join(root, "Link.ssl"), long)]);
				const got = readFileSync(one, "utf8");
				if (got !== long && got !== short) mixed.push(`link, run ${run}: ${got.length} characters`);
			}
			expect(lstatSync(join(root, "Link.ssl")).isSymbolicLink()).toBe(true);
		}
		expect(few(mixed)).toEqual(none);
		expect(statSync(one).nlink).toBe(2);
		ws.close();
	});

	test("stays in what it is written in: a save does not read the file while the other has it emptied", async () => {
		const root = fresh("two-names-encoding");
		const one = join(root, "One.ssl");
		const other = join(root, "Other.ssl");
		const utf16 = (text: string) => Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(text, "utf16le")]);
		const first = "/* erste Fassung: geprüft */\n".repeat(200);
		const second = "/* zweite Fassung: geprüft */\n";
		writeFileSync(one, utf16(":RETURN 0;\n"));
		if (!secondName(one, other)) return;
		const ws = new WorkspaceFiles(root);
		// The second save is asked for a little after the first, by a number of turns that changes from run to run:
		// where it read the file just as the first had emptied it, it found no mark at its start, took the file for
		// plain UTF-8 and wrote it so (about one run in twenty here), and before that the two texts were mixed.
		const wrong: string[] = [];
		for (let run = 0; run < 300; run++) {
			rmSync(one, { force: true });
			rmSync(other, { force: true });
			writeFileSync(one, utf16(":RETURN 0;\n"));
			linkSync(one, other);
			const saved = ws.write(one, first);
			for (let turn = 0; turn < run % 40; turn++) await Promise.resolve();
			if (run % 3 === 2) await new Promise((done) => setImmediate(done));
			await Promise.all([saved, ws.write(other, second)]);
			const got = readFileSync(one);
			if (got.equals(utf16(first)) || got.equals(utf16(second))) continue;
			wrong.push(`run ${run}: ${got.equals(Buffer.from(second)) || got.equals(Buffer.from(first)) ? "written as UTF-8, its mark gone" : `${got.length} bytes of neither text`}`);
		}
		expect(few(wrong)).toEqual(none);
		ws.close();
	});

	test("work that holds the file, or moves its folder, still ends while saves by both names are under way", async () => {
		const root = fresh("two-names-held");
		mkdirSync(join(root, "one"));
		mkdirSync(join(root, "two"));
		const first = join(root, "one", "A.ssl");
		const second = join(root, "two", "B.ssl");
		writeFileSync(first, ":RETURN 0;\n");
		if (!secondName(first, second)) return;
		const ws = new WorkspaceFiles(root);
		const texts = [1, 2, 3, 4, 5].map((n) => `/* ${"remark ".repeat(n * 300)}*/\n:RETURN ${n};\n`);
		// The file's own line is taken from inside a name's line. Were a name's line ever waited for from inside the
		// file's, two of these would wait for each other and none of this would end.
		const all = Promise.all([
			ws.write(first, texts[0]!),
			ws.write(second, texts[1]!),
			ws.alone(first, (write) => write(texts[2]!)),
			ws.alone(second, (write) => write(texts[3]!)),
			ws.rename(join(root, "two"), join(root, "three")),
			ws.write(first, texts[4]!),
			ws.copy(first, join(root, "one", "Copy.ssl")),
		]);
		let timer: ReturnType<typeof setTimeout> | undefined;
		const ended = await Promise.race([all.then(() => "ended"), new Promise<string>((done) => (timer = setTimeout(() => done("still waiting"), 3000)))]);
		clearTimeout(timer);
		expect(ended).toBe("ended");
		const got = readFileSync(first, "utf8");
		expect(texts.includes(got)).toBe(true);
		// The folder was moved with the second name in it, and it is still the same file.
		expect(readFileSync(join(root, "three", "B.ssl"), "utf8")).toBe(got);
		expect(statSync(first).nlink).toBe(2);
		expect(readdirSync(root).sort()).toEqual(["one", "three"]);
		ws.close();
	});
});

describe("2. a save into a folder that takes no new file", () => {
	const said = (file: string, folder: string) => `${file} cannot be saved: the folder ${folder} does not take new files, and a save is written to a new file first. Make the folder writable, then save again.`;

	test.skipIf(!posix || root0)("names the file that was to be saved and what stands in the way, not the temporary file", async () => {
		const root = fresh("no-new-files");
		mkdirSync(join(root, "lib"));
		const file = join(root, "lib", "Kept.ssl");
		writeFileSync(file, ":RETURN 1;\n");
		const linked = link(join("lib", "Kept.ssl"), join(root, "Link.ssl"));
		const ws = new WorkspaceFiles(root);
		chmodSync(join(root, "lib"), 0o555);
		try {
			// A file that is there and may be written: it was the temporary file beside it that could not be made, and
			// what was said was "EACCES: permission denied, open '…/lib/.4242.0a1b2c3d4e5f.ssl-studio-tmp'".
			const message = await refusal(ws.write(file, ":RETURN 2;\n"));
			expect(message).toBe(said(join("lib", "Kept.ssl"), "lib"));
			expect(message).not.toContain("ssl-studio-tmp");
			// The view shows it as it is said: it is not what the file system says of opening a file, reworded.
			expect(plainFileError(message, root)).toBe(message);
			// A file that is not there yet, bytes, and a picture: each by its own name.
			expect(await refusal(ws.write(join(root, "lib", "New.ssl"), ":RETURN 3;\n"))).toBe(said(join("lib", "New.ssl"), "lib"));
			expect(await refusal(ws.writeBytes(join(root, "lib", "Report.docx"), new Uint8Array([1, 2])))).toBe(said(join("lib", "Report.docx"), "lib"));
			expect(await refusal(ws.writeImage(join(root, "lib", "Chart.png"), Buffer.from("PNG").toString("base64")))).toBe(said(join("lib", "Chart.png"), "lib"));
			// Through a link in a folder that does take files: the name asked for, and the folder the file is in.
			if (linked) expect(await refusal(ws.write(join(root, "Link.ssl"), ":RETURN 2;\n"))).toBe(said("Link.ssl", "lib"));
			// Nothing was written, and nothing is left.
			expect(readFileSync(file, "utf8")).toBe(":RETURN 1;\n");
			expect(readdirSync(join(root, "lib"))).toEqual(["Kept.ssl"]);
		} finally {
			chmodSync(join(root, "lib"), 0o755);
		}
		// Made writable, the folder is saved into as before.
		await ws.write(file, ":RETURN 2;\n");
		expect(readFileSync(file, "utf8")).toBe(":RETURN 2;\n");
		expect(readdirSync(join(root, "lib"))).toEqual(["Kept.ssl"]);
		ws.close();
	});

	test.skipIf(!posix || root0)("the workspace's own folder is named by its name", async () => {
		const root = fresh("no-new-files-root");
		writeFileSync(join(root, "Top.ssl"), ":RETURN 1;\n");
		const ws = new WorkspaceFiles(root);
		chmodSync(root, 0o555);
		try {
			expect(await refusal(ws.write(join(root, "Top.ssl"), ":RETURN 2;\n"))).toBe(said("Top.ssl", basename(root)));
		} finally {
			chmodSync(root, 0o755);
		}
		expect(readFileSync(join(root, "Top.ssl"), "utf8")).toBe(":RETURN 1;\n");
		ws.close();
	});

	test.skipIf(!posix || root0)("in a workspace opened through a link, a linked file's folder is named as the workspace has it", async () => {
		const real = fresh("no-new-files-real");
		mkdirSync(join(real, "lib"));
		writeFileSync(join(real, "lib", "Kept.ssl"), ":RETURN 1;\n");
		const root = join(base, "no-new-files-by-link");
		if (!link(real, root) || !link(join("lib", "Kept.ssl"), join(root, "Link.ssl"))) return;
		const ws = new WorkspaceFiles(root);
		chmodSync(join(real, "lib"), 0o555);
		try {
			expect(await refusal(ws.write(join(root, "Link.ssl"), ":RETURN 2;\n"))).toBe(said("Link.ssl", "lib"));
			expect(await refusal(ws.write(join(root, "lib", "Kept.ssl"), ":RETURN 2;\n"))).toBe(said(join("lib", "Kept.ssl"), "lib"));
		} finally {
			chmodSync(join(real, "lib"), 0o755);
		}
		expect(readFileSync(join(real, "lib", "Kept.ssl"), "utf8")).toBe(":RETURN 1;\n");
		ws.close();
	});

	test.skipIf(!posix || root0)("the backend's save fails with those words, which the view shows", async () => {
		await withDirs("dirs-no-new-files", async () => {
			const root = fresh("no-new-files-backend");
			mkdirSync(join(root, "lib"));
			const file = join(root, "lib", "Kept.ssl");
			writeFileSync(file, ":RETURN 1;\n");
			const backend = createBackend(makeHost(), root);
			await backend.ready;
			chmodSync(join(root, "lib"), 0o555);
			try {
				expect(await refusal(backend.api.write(file, ":RETURN 2;\n", true))).toBe(said(join("lib", "Kept.ssl"), "lib"));
				expect(readFileSync(file, "utf8")).toBe(":RETURN 1;\n");
			} finally {
				chmodSync(join(root, "lib"), 0o755);
				backend.dispose();
			}
		});
	});
});

describe("3. a settings file the user may not write", () => {
	const readOnly = (file: string, again: string) => `${file} is read-only, so it is not written over. Make the file writable, ${again}.`;

	test.skipIf(!posix || root0)("the user's is not written over, is still read, and is saved into once it is writable", async () => {
		await withDirs("dirs-settings-read-only", async ({ config }) => {
			mkdirSync(config, { recursive: true });
			const file = join(config, "settings.json");
			const byHand = '{ "fontSize": 15 }\n';
			writeFileSync(file, byHand);
			chmodSync(file, 0o444);
			const store = new SettingsStore(() => null);
			try {
				// The temporary file was renamed over it: the folder was asked, not the file, and a writable file of the
				// app's took its place.
				expect(await refusal(store.save("user", { minimap: false }))).toBe(readOnly(file, "and change the setting again"));
				expect(readFileSync(file, "utf8")).toBe(byHand);
				expect(modeOf(file)).toBe(0o444);
				expect(readdirSync(config)).toEqual(["settings.json"]);
				// It is read as any settings file is, and reading it finds nothing wrong with it.
				const loaded = await store.load();
				expect(loaded.problems).toBeUndefined();
				expect(loaded.user).toEqual({ fontSize: 15 });
				expect(loaded.effective.minimap).toBe(true);
			} finally {
				chmodSync(file, 0o644);
			}
			const effective = await store.save("user", { minimap: false });
			expect(effective.minimap).toBe(false);
			expect(JSON.parse(readFileSync(file, "utf8"))).toEqual({ fontSize: 15, minimap: false });
		});
	});

	test.skipIf(!posix || root0)("the workspace's is not written over by a save of the layout alone, however often it is asked", async () => {
		await withDirs("dirs-settings-read-only-ws", async () => {
			const root = fresh("settings-read-only-ws");
			mkdirSync(join(root, ".ssl-studio"));
			const file = join(root, ".ssl-studio", "settings.json");
			const shared = '{\n  "rulers": false\n}\n';
			writeFileSync(file, shared);
			chmodSync(file, 0o444);
			const store = new SettingsStore(() => root);
			const layout = (leftWidth: number) => ({ layout: { left: true, right: false, bottom: true, leftWidth, rightWidth: 360, bottomHeight: 200 } });
			try {
				// What a panel's move asks for, a moment after it: each is refused in the same words (the view says them
				// once for a folder, App.tsx), and the file stays as it was shared.
				for (const width of [260, 300, 340]) expect(await refusal(store.save("workspace", layout(width)))).toBe(readOnly(file, "and change the setting again"));
				expect(readFileSync(file, "utf8")).toBe(shared);
				expect(modeOf(file)).toBe(0o444);
				expect(readdirSync(join(root, ".ssl-studio"))).toEqual(["settings.json"]);
				expect((await store.load()).workspace).toEqual({ rulers: false });
			} finally {
				chmodSync(file, 0o644);
			}
			await store.save("workspace", layout(300));
			expect(JSON.parse(readFileSync(file, "utf8"))).toEqual({ rulers: false, ...layout(300) });
		});
	});

	test.skipIf(!posix || root0)("through a link, the file the link leads to is not written over, and the link is what is named", async () => {
		await withDirs("dirs-settings-read-only-link", async ({ config }) => {
			const dotfiles = fresh("dotfiles-read-only");
			mkdirSync(config, { recursive: true });
			writeFileSync(join(dotfiles, "studio.json"), '{ "fontSize": 15 }\n');
			const file = join(config, "settings.json");
			if (!link(join(dotfiles, "studio.json"), file)) return;
			chmodSync(join(dotfiles, "studio.json"), 0o444);
			try {
				expect(await refusal(new SettingsStore(() => null).save("user", { minimap: false }))).toBe(readOnly(file, "and change the setting again"));
				expect(readFileSync(join(dotfiles, "studio.json"), "utf8")).toBe('{ "fontSize": 15 }\n');
				expect(modeOf(join(dotfiles, "studio.json"))).toBe(0o444);
				expect(lstatSync(file).isSymbolicLink()).toBe(true);
				expect(readdirSync(dotfiles)).toEqual(["studio.json"]);
			} finally {
				chmodSync(join(dotfiles, "studio.json"), 0o644);
			}
		});
	});

	test.skipIf(!posix || root0)("a theme and the list of recent folders are written the same way, and are not written over either", async () => {
		await withDirs("dirs-others-read-only", async ({ config, state }) => {
			const from = fresh("theme-read-only");
			writeFileSync(join(from, "dusk.json"), '{ "name": "Dusk, changed", "colors": {} }\n');
			mkdirSync(join(config, "themes"), { recursive: true });
			const theme = join(config, "themes", "dusk.json");
			writeFileSync(theme, '{ "name": "Dusk", "colors": {} }\n');
			chmodSync(theme, 0o444);
			const opened = fresh("recent-read-only");
			mkdirSync(state, { recursive: true });
			const list = join(state, "recent.json");
			writeFileSync(list, "[]\n");
			chmodSync(list, 0o444);
			try {
				expect(await refusal(new SettingsStore(() => null).importTheme(join(from, "dusk.json")))).toBe(readOnly(theme, "then try again"));
				expect(readFileSync(theme, "utf8")).toBe('{ "name": "Dusk", "colors": {} }\n');
				expect(await refusal(recent(opened))).toBe(readOnly(list, "then try again"));
				expect(readFileSync(list, "utf8")).toBe("[]\n");
				// The list is still read.
				expect(await recent()).toEqual([]);
			} finally {
				chmodSync(theme, 0o644);
				chmodSync(list, 0o644);
			}
		});
	});

	test.skipIf(!posix || root0)("a folder of settings that takes no new file: the settings file is named, not the temporary one", async () => {
		await withDirs("dirs-settings-no-new-files", async () => {
			const root = fresh("settings-no-new-files");
			const folder = join(root, ".ssl-studio");
			mkdirSync(folder);
			const file = join(folder, "settings.json");
			writeFileSync(file, '{ "rulers": false }\n');
			const store = new SettingsStore(() => root);
			chmodSync(folder, 0o555);
			try {
				// It said "EACCES: permission denied, open '…/.ssl-studio/.ssl-studio.4242.0a1b2c3d.tmp'".
				expect(await refusal(store.save("workspace", { minimap: false }))).toBe(`${file} cannot be saved: its folder does not take new files, and a save is written to a new file first. Make the folder writable, and change the setting again.`);
				expect(readFileSync(file, "utf8")).toBe('{ "rulers": false }\n');
				expect(readdirSync(folder)).toEqual(["settings.json"]);
			} finally {
				chmodSync(folder, 0o755);
			}
			await store.save("workspace", { minimap: false });
			expect(JSON.parse(readFileSync(file, "utf8"))).toEqual({ rulers: false, minimap: false });
		});
	});
});
