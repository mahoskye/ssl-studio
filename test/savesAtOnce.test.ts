import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Serial } from "../src/bun/serial";
import { SettingsStore } from "../src/bun/settings";
import { fileKey, WorkspaceFiles } from "../src/bun/workspace";

const dir = mkdtempSync(join(tmpdir(), "ssl-studio-saves-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const wait = (ms: number) => new Promise((done) => setTimeout(done, ms));

describe("work on one thing, one after another", () => {
	test("runs in the order it was asked for, each after the one before has finished", async () => {
		const serial = new Serial();
		const seen: string[] = [];
		// The first takes longest: at once, it would finish last.
		const work = (name: string, ms: number) => async () => {
			seen.push(`${name} starts`);
			await wait(ms);
			seen.push(`${name} ends`);
			return name;
		};
		const results = await Promise.all([serial.run("a", work("first", 30)), serial.run("a", work("second", 10)), serial.run("a", work("third", 0))]);
		expect(results).toEqual(["first", "second", "third"]);
		expect(seen).toEqual(["first starts", "first ends", "second starts", "second ends", "third starts", "third ends"]);
	});

	test("work that fails is heard of by who asked for it, and does not stop what was asked for after it", async () => {
		const serial = new Serial();
		const failed = serial.run("a", async () => {
			throw new Error("the disk is full");
		});
		const after = serial.run("a", async () => "landed");
		expect(await after).toBe("landed");
		await expect(failed).rejects.toThrow("the disk is full");
	});

	test("work on different things does not wait", async () => {
		const serial = new Serial();
		const seen: string[] = [];
		const slow = serial.run("a", async () => {
			await wait(30);
			seen.push("a");
		});
		const quick = serial.run("b", async () => void seen.push("b"));
		await Promise.all([slow, quick]);
		expect(seen).toEqual(["b", "a"]);
	});

	test("keeps nothing once the work is done", async () => {
		const serial = new Serial();
		await Promise.allSettled([serial.run("a", async () => 1), serial.run("a", () => Promise.reject(new Error("no"))), serial.run("b", async () => 2)]);
		await wait(0);
		expect(serial.busy).toBe(0);
	});
});

describe("saves of one file asked for at once", () => {
	test("each lands, none fails, and the file holds what was asked for last", async () => {
		const files = new WorkspaceFiles(dir);
		const path = join(dir, "Script.ssl");
		for (let round = 0; round < 60; round++) {
			// Texts of different lengths, so that a write cut short by another would show.
			const texts = [0, 1, 2, 3].map((n) => `/* round ${round}, save ${n} */\n${"x".repeat((4 - n) * 4000)}\n`);
			const results = await Promise.allSettled(texts.map((text) => files.write(path, text)));
			expect(results.map((result) => result.status)).toEqual(["fulfilled", "fulfilled", "fulfilled", "fulfilled"]);
			expect(readFileSync(path, "utf8")).toBe(texts[3]!);
		}
		// Nothing of the writing is left beside the file.
		expect(readdirSync(dir).filter((name) => name.endsWith(".ssl-studio-tmp"))).toEqual([]);
	});

	test("a save that fails does not hold up the one asked for after it", async () => {
		const files = new WorkspaceFiles(dir);
		const path = join(dir, "old.sql");
		// "café" in Windows-1252: a file kept in that cannot hold an arrow, and a save with one in it is refused.
		writeFileSync(path, Buffer.from([0x63, 0x61, 0x66, 0xe9, 0x0a]));
		const [refused, landed] = await Promise.allSettled([files.write(path, "café → x\n"), files.write(path, "café and more\n")]);
		expect(refused.status).toBe("rejected");
		expect(String((refused as PromiseRejectedResult).reason?.message)).toContain("Windows-1252");
		expect(landed.status).toBe("fulfilled");
		// The one that landed is in the file, written as the file is written.
		expect([...readFileSync(path)]).toEqual([...Buffer.from("caf"), 0xe9, ...Buffer.from(" and more\n")]);
	});

	test("a path outside the folder is still refused as a save that failed", async () => {
		const files = new WorkspaceFiles(dir);
		await expect(files.write(join(dir, "..", "outside.ssl"), "x")).rejects.toThrow();
	});

	test("saves of different files each land", async () => {
		const files = new WorkspaceFiles(dir);
		const results = await Promise.allSettled(["A.ssl", "B.ssl", "C.ssl"].map((name) => files.write(join(dir, "many", name), `${name}\n`)));
		expect(results.every((result) => result.status === "fulfilled")).toBe(true);
		expect(readFileSync(join(dir, "many", "B.ssl"), "utf8")).toBe("B.ssl\n");
	});
});

describe("one file by two names", () => {
	test("is one file to the saving: by a link to its folder, saves still go one after another", async () => {
		const root = mkdtempSync(join(tmpdir(), "ssl-studio-names-"));
		try {
			mkdirSync(join(root, "real"));
			try {
				symlinkSync(join(root, "real"), join(root, "linked"), "dir");
			} catch {
				// A system that does not let this user make links has no such second name to try.
				return;
			}
			const files = new WorkspaceFiles(root);
			expect(fileKey(join(root, "linked", "A.ssl"))).toBe(fileKey(join(root, "real", "A.ssl")));
			for (let round = 0; round < 40; round++) {
				const texts = [0, 1, 2, 3].map((n) => `/* round ${round}, save ${n} */\n${"y".repeat((4 - n) * 4000)}\n`);
				const results = await Promise.allSettled(texts.map((text, n) => files.write(join(root, n % 2 ? "linked" : "real", "A.ssl"), text)));
				expect(results.map((result) => result.status)).toEqual(["fulfilled", "fulfilled", "fulfilled", "fulfilled"]);
				expect(readFileSync(join(root, "real", "A.ssl"), "utf8")).toBe(texts[3]!);
			}
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	test("a folder opened twice is the same files: saves through both go one after another", async () => {
		const root = mkdtempSync(join(tmpdir(), "ssl-studio-twice-"));
		try {
			const [one, other] = [new WorkspaceFiles(root), new WorkspaceFiles(root)];
			for (let round = 0; round < 40; round++) {
				const texts = [0, 1, 2, 3].map((n) => `/* round ${round}, save ${n} */\n${"z".repeat((4 - n) * 4000)}\n`);
				const results = await Promise.allSettled(texts.map((text, n) => (n % 2 ? other : one).write(join(root, "B.ssl"), text)));
				expect(results.every((result) => result.status === "fulfilled")).toBe(true);
				expect(readFileSync(join(root, "B.ssl"), "utf8")).toBe(texts[3]!);
			}
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	test("a file that is not there yet is known by its folder's one name", () => {
		const root = mkdtempSync(join(tmpdir(), "ssl-studio-key-"));
		try {
			expect(fileKey(join(root, "New.ssl"))).toBe(fileKey(join(root, ".", "New.ssl")));
			// In a folder that is not there either, it is known by the nearest folder that is: the same name before the
			// folder is made and after.
			const before = fileKey(join(root, "none", "deep", "New.ssl"));
			mkdirSync(join(root, "none", "deep"), { recursive: true });
			expect(fileKey(join(root, "none", "deep", "New.ssl"))).toBe(before);
			// And through a link to a folder above it, though the folders below are not made yet.
			try {
				symlinkSync(join(root, "none"), join(root, "link"), "dir");
			} catch {
				return;
			}
			expect(fileKey(join(root, "link", "later", "New.ssl"))).toBe(fileKey(join(root, "none", "later", "New.ssl")));
			// A link that leads nowhere is known as the file it leads to: a save through it makes that file.
			symlinkSync(join(root, "nowhere"), join(root, "broken"));
			expect(fileKey(join(root, "broken"))).toBe(fileKey(join(root, "nowhere")));
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});
});

describe("other work on a file that is being saved", () => {
	test("a rename asked for while a save is under way leaves one file, under the new name, with what was saved", async () => {
		const root = mkdtempSync(join(tmpdir(), "ssl-studio-rename-"));
		try {
			const files = new WorkspaceFiles(root);
			for (let round = 0; round < 40; round++) {
				const from = join(root, `From${round}.ssl`);
				const to = join(root, `To${round}.ssl`);
				await files.write(from, "before\n");
				const text = `/* round ${round} */\n${"r".repeat(20000)}\n`;
				await Promise.all([files.write(from, text), files.rename(from, to)]);
				expect(existsSync(from)).toBe(false);
				expect(readFileSync(to, "utf8")).toBe(text);
			}
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	test("reading a file and writing it as one step is not cut into by a save, and the save after it lands on top", async () => {
		const root = mkdtempSync(join(tmpdir(), "ssl-studio-alone-"));
		try {
			const files = new WorkspaceFiles(root);
			const path = join(root, "Count.txt");
			await files.write(path, "0\n");
			// Twenty steps that each read the number and write one more, all asked for at once: at once for real, some
			// would read the same number.
			await Promise.all(
				Array.from({ length: 20 }, () =>
					files.alone(path, async (write) => {
						const now = Number((await files.read(path)).text);
						await write(`${now + 1}\n`);
					}),
				),
			);
			expect(readFileSync(path, "utf8")).toBe("20\n");
			const [, saved] = await Promise.all([files.alone(path, async (write) => void (await write("from the step\n"))), files.write(path, "from the save\n")]);
			expect(saved.mtime).toBeGreaterThan(0);
			expect(readFileSync(path, "utf8")).toBe("from the save\n");
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	test("work that fails is its asker's to hear of, and a path outside the folder is refused before any work", async () => {
		const root = mkdtempSync(join(tmpdir(), "ssl-studio-alone-"));
		try {
			const files = new WorkspaceFiles(root);
			const path = join(root, "A.txt");
			const failed = files.alone(path, () => {
				throw new Error("no");
			});
			const after = files.write(path, "after\n");
			await expect(failed).rejects.toThrow("no");
			await after;
			expect(readFileSync(path, "utf8")).toBe("after\n");
			let ran = false;
			await expect(files.alone(join(root, "..", "x"), () => void (ran = true))).rejects.toThrow();
			expect(ran).toBe(false);
			await expect(files.rename(join(root, "A.txt"), join(root, "A.txt"))).rejects.toThrow("already exists");
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	test("a rename onto a name that is being saved for the first time is refused or lands whole: neither writes the other away", async () => {
		const root = mkdtempSync(join(tmpdir(), "ssl-studio-onto-"));
		try {
			const files = new WorkspaceFiles(root);
			for (let round = 0; round < 40; round++) {
				const from = join(root, `Moved${round}.ssl`);
				const to = join(root, `Taken${round}.ssl`);
				await files.write(from, "the file that is moved\n");
				const text = `/* saved under the name, round ${round} */\n${"t".repeat(20000)}\n`;
				// The save was asked for first, so the name is taken by the time the rename has its turn: it is refused,
				// and both files are as they were asked to be.
				const [saved, renamed] = await Promise.allSettled([files.write(to, text), files.rename(from, to)]);
				expect(saved.status).toBe("fulfilled");
				expect(renamed.status).toBe("rejected");
				expect(readFileSync(to, "utf8")).toBe(text);
				expect(readFileSync(from, "utf8")).toBe("the file that is moved\n");
				// Asked for the other way about, whichever has its turn first, nothing is lost: the rename lands and the
				// save is then of the renamed file, or the save takes the name and the rename is refused.
				const other = join(root, `Other${round}.ssl`);
				const [moved, written] = await Promise.allSettled([files.rename(from, other), files.write(other, text)]);
				expect(written.status).toBe("fulfilled");
				expect(readFileSync(other, "utf8")).toBe(text);
				if (moved.status === "fulfilled") expect(existsSync(from)).toBe(false);
				else expect(readFileSync(from, "utf8")).toBe("the file that is moved\n");
			}
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	test("a folder renamed while a file in it is being saved does not come back: the file is in the folder's new place", async () => {
		const root = mkdtempSync(join(tmpdir(), "ssl-studio-folder-"));
		try {
			const files = new WorkspaceFiles(root);
			for (let round = 0; round < 30; round++) {
				const from = join(root, `old${round}`);
				const to = join(root, `new${round}`);
				await files.write(join(from, "deep", "A.ssl"), "before\n");
				const text = `/* round ${round} */\n${"f".repeat(20000)}\n`;
				await Promise.all([files.write(join(from, "deep", "A.ssl"), text), files.write(join(from, "B.ssl"), text), files.rename(from, to)]);
				expect(existsSync(from)).toBe(false);
				expect(readFileSync(join(to, "deep", "A.ssl"), "utf8")).toBe(text);
				expect(readFileSync(join(to, "B.ssl"), "utf8")).toBe(text);
			}
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	test("a save asked for just after another in the folder has answered is waited for, or is a save of its own after the rename", async () => {
		const root = mkdtempSync(join(tmpdir(), "ssl-studio-late-"));
		try {
			const files = new WorkspaceFiles(root);
			let waitedFor = 0;
			// The second save is asked for a turn or a few after the first answers, while the rename is waiting its turn.
			for (const turns of [0, 1, 2, 3, 4, 6, 9]) {
				for (let round = 0; round < 10; round++) {
					const from = join(root, `old-${turns}-${round}`);
					const to = join(root, `new-${turns}-${round}`);
					await files.write(join(from, "A.ssl"), "before\n");
					const text = `/* ${turns} turns, round ${round} */\n${"l".repeat(20000)}\n`;
					const late = files.write(join(from, "A.ssl"), "first\n").then(async () => {
						for (let turn = 0; turn < turns; turn++) await Promise.resolve();
						return files.write(join(from, "B.ssl"), text);
					});
					await Promise.all([late, files.rename(from, to)]);
					// The first save went with the folder, whole, and is nowhere else.
					expect(readFileSync(join(to, "A.ssl"), "utf8")).toBe("first\n");
					expect(existsSync(join(from, "A.ssl"))).toBe(false);
					// The late one was asked for before the rename was done, and went with the folder; or after it was
					// done, and is then a new file under the old name, whole. It is never in both, and never cut short.
					const went = existsSync(join(to, "B.ssl"));
					expect(existsSync(join(from, "B.ssl"))).toBe(!went);
					expect(readFileSync(join(went ? to : from, "B.ssl"), "utf8")).toBe(text);
					if (went) waitedFor++;
					expect(readdirSync(to).filter((name) => name.endsWith(".ssl-studio-tmp"))).toEqual([]);
				}
			}
			// Asked for in the same turn the first answered, it is always waited for.
			expect(waitedFor).toBeGreaterThanOrEqual(10);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	test("a folder saved into without a pause is said to be busy, and is left as it is", async () => {
		const root = mkdtempSync(join(tmpdir(), "ssl-studio-busy-"));
		const usual = WorkspaceFiles.quietMs;
		WorkspaceFiles.quietMs = 150;
		try {
			const files = new WorkspaceFiles(root);
			const from = join(root, "busy");
			await files.write(join(from, "A.ssl"), "0\n");
			let going = true;
			let saves = 0;
			// One save asked for as the last answers, over and over: the folder is never without one.
			const saving = (async () => {
				while (going) await files.write(join(from, "A.ssl"), `${++saves}\n`);
			})();
			await expect(files.rename(from, join(root, "moved"))).rejects.toThrow("is being saved into without a pause");
			going = false;
			await saving;
			expect(existsSync(join(root, "moved"))).toBe(false);
			expect(readFileSync(join(from, "A.ssl"), "utf8")).toBe(`${saves}\n`);
			// Once the saving has stopped, the same rename goes through.
			await files.rename(from, join(root, "moved"));
			expect(existsSync(from)).toBe(false);
		} finally {
			WorkspaceFiles.quietMs = usual;
			rmSync(root, { recursive: true, force: true });
		}
	});

	test("a folder renamed into itself, or named together with a file in it, answers and does not wait for itself", async () => {
		const root = mkdtempSync(join(tmpdir(), "ssl-studio-self-"));
		try {
			const files = new WorkspaceFiles(root);
			await files.write(join(root, "box", "A.ssl"), "a\n");
			const tried = await Promise.race([Promise.allSettled([files.rename(join(root, "box"), join(root, "box", "inner")), files.rename(join(root, "box", "A.ssl"), join(root, "A.ssl"))]), wait(3000).then(() => "stuck")]);
			expect(tried).not.toBe("stuck");
			expect((tried as PromiseSettledResult<void>[])[0]!.status).toBe("rejected");
			expect(readFileSync(join(root, "A.ssl"), "utf8")).toBe("a\n");
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	test("two folders moved into each other at once both answer, and nothing is left waiting behind them", async () => {
		const root = mkdtempSync(join(tmpdir(), "ssl-studio-into-"));
		const usual = WorkspaceFiles.quietMs;
		WorkspaceFiles.quietMs = 200;
		try {
			const files = new WorkspaceFiles(root);
			await files.write(join(root, "A", "a.ssl"), "a\n");
			await files.write(join(root, "B", "b.ssl"), "b\n");
			const crossed = await Promise.race([Promise.allSettled([files.rename(join(root, "A"), join(root, "B", "A")), files.rename(join(root, "B"), join(root, "A", "B"))]), wait(4000).then(() => "stuck")]);
			expect(crossed).not.toBe("stuck");
			// Whatever each came to, no file is lost, and each is in one place.
			const places = (name: string, under: string[]) => under.filter((folder) => existsSync(join(root, folder, name)));
			expect(places("a.ssl", ["A", join("B", "A")]).length).toBe(1);
			expect(places("b.ssl", ["B", join("A", "B"), join("B", "A", "B")]).length).toBe(1);
			// What is asked for afterwards is not stuck behind them: a save in each folder that is there, and a rename.
			const still = ["A", "B"].filter((folder) => existsSync(join(root, folder)));
			const after = await Promise.race([Promise.allSettled([...still.map((folder) => files.write(join(root, folder, "later.ssl"), "later\n")), files.rename(join(root, still[0]!), join(root, "C"))]), wait(4000).then(() => "stuck")]);
			expect(after).not.toBe("stuck");
			expect((after as PromiseSettledResult<unknown>[]).every((result) => result.status === "fulfilled")).toBe(true);
		} finally {
			WorkspaceFiles.quietMs = usual;
			rmSync(root, { recursive: true, force: true });
		}
	});

	test("a save, a rename and a save of one file asked for in one turn keep that order, whatever the names", async () => {
		const root = mkdtempSync(join(tmpdir(), "ssl-studio-order-"));
		try {
			const files = new WorkspaceFiles(root);
			// Once to a name that sorts after the file's, once to one that sorts before.
			for (const [from, to] of [
				["m.ssl", "z.ssl"],
				["z2.ssl", "a2.ssl"],
			] as const) {
				await files.write(join(root, from), "before\n");
				await Promise.all([files.write(join(root, from), "the first save\n"), files.rename(join(root, from), join(root, to)), files.write(join(root, from), "the second save\n")]);
				// The first save went with the file; the second was asked for after the rename, and is a file of its own.
				expect(readFileSync(join(root, to), "utf8")).toBe("the first save\n");
				expect(readFileSync(join(root, from), "utf8")).toBe("the second save\n");
			}
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	test("two renames that cross (each onto the other's name) both answer: neither waits for the other without end", async () => {
		const root = mkdtempSync(join(tmpdir(), "ssl-studio-cross-"));
		try {
			const files = new WorkspaceFiles(root);
			await files.write(join(root, "A.ssl"), "a\n");
			await files.write(join(root, "B.ssl"), "b\n");
			const crossed = await Promise.race([Promise.allSettled([files.rename(join(root, "A.ssl"), join(root, "B.ssl")), files.rename(join(root, "B.ssl"), join(root, "A.ssl"))]), wait(3000).then(() => "stuck")]);
			expect(crossed).not.toBe("stuck");
			// Each name was taken, so each was refused, and both files are as they were.
			expect((crossed as PromiseSettledResult<void>[]).map((result) => result.status)).toEqual(["rejected", "rejected"]);
			expect(readFileSync(join(root, "A.ssl"), "utf8")).toBe("a\n");
			expect(readFileSync(join(root, "B.ssl"), "utf8")).toBe("b\n");
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	test("a copy onto a name that is being saved is refused, and takes nothing away that it did not put there", async () => {
		const root = mkdtempSync(join(tmpdir(), "ssl-studio-copyonto-"));
		try {
			const files = new WorkspaceFiles(root);
			for (let round = 0; round < 40; round++) {
				const from = join(root, `Source${round}.ssl`);
				const to = join(root, `Target${round}.ssl`);
				await files.write(from, "source\n");
				const text = `/* the target's own text, round ${round} */\n${"k".repeat(20000)}\n`;
				const [, saved, copied] = await Promise.allSettled([files.write(from, "source, saved again\n"), files.write(to, text), files.copy(from, to)]);
				expect(saved!.status).toBe("fulfilled");
				expect(copied!.status).toBe("rejected");
				expect(String((copied as PromiseRejectedResult).reason?.message)).toContain("already exists");
				// What was saved under the name is still there, whole.
				expect(readFileSync(to, "utf8")).toBe(text);
			}
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	test("a copy asked for while a save is under way is a copy of what was saved", async () => {
		const root = mkdtempSync(join(tmpdir(), "ssl-studio-copy-"));
		try {
			const files = new WorkspaceFiles(root);
			const from = join(root, "Source.ssl");
			await files.write(from, "before\n");
			const text = `${"c".repeat(20000)}\n`;
			await Promise.all([files.write(from, text), files.copy(from, join(root, "Copy.ssl"))]);
			expect(readFileSync(join(root, "Copy.ssl"), "utf8")).toBe(text);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});
});

describe("settings saved at once", () => {
	test("each change is kept: one save does not write over what another just wrote", async () => {
		const root = mkdtempSync(join(tmpdir(), "ssl-studio-settings-"));
		try {
			const store = new SettingsStore(() => root);
			for (let round = 0; round < 40; round++) {
				await Promise.all([store.save("workspace", { fontSize: 10 + round }), store.save("workspace", { theme: `theme-${round}` }), store.save("workspace", { menuBar: round % 2 === 0 })]);
				const kept = JSON.parse(readFileSync(join(root, ".ssl-studio", "settings.json"), "utf8"));
				expect(kept).toEqual({ fontSize: 10 + round, theme: `theme-${round}`, menuBar: round % 2 === 0 });
			}
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	test("the last of two saves of one setting is the one that stands, and null still takes a setting out", async () => {
		const root = mkdtempSync(join(tmpdir(), "ssl-studio-settings-"));
		try {
			const store = new SettingsStore(() => root);
			await Promise.all([store.save("workspace", { fontSize: 11 }), store.save("workspace", { fontSize: 15 }), store.save("workspace", { theme: "dark" })]);
			expect(JSON.parse(readFileSync(join(root, ".ssl-studio", "settings.json"), "utf8"))).toEqual({ fontSize: 15, theme: "dark" });
			await Promise.all([store.save("workspace", { theme: null }), store.save("workspace", { fontSize: 12 })]);
			expect(JSON.parse(readFileSync(join(root, ".ssl-studio", "settings.json"), "utf8"))).toEqual({ fontSize: 12 });
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	test("each save answers with the settings as they then are, in the order the saves were asked for", async () => {
		const root = mkdtempSync(join(tmpdir(), "ssl-studio-settings-"));
		try {
			const store = new SettingsStore(() => root);
			const answers = await Promise.all([store.save("workspace", { fontSize: 11 }), store.save("workspace", { fontSize: 13 }), store.save("workspace", { fontSize: 17 })]);
			expect(answers.map((settings) => settings.fontSize)).toEqual([11, 13, 17]);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	test("the file is never half there: read while it is being saved, it is whole settings every time", async () => {
		const root = mkdtempSync(join(tmpdir(), "ssl-studio-settings-"));
		try {
			const store = new SettingsStore(() => root);
			const file = join(root, ".ssl-studio", "settings.json");
			// A value large enough that a write in place would be caught part of the way.
			await store.save("workspace", { regionColors: Object.fromEntries(Array.from({ length: 4000 }, (_, n) => [`Region ${n}`, "#123456"])) });
			let reads = 0;
			let saving = true;
			const reader = (async () => {
				while (saving) {
					const kept = JSON.parse(readFileSync(file, "utf8"));
					expect(Object.keys(kept.regionColors).length).toBe(4000);
					reads++;
					await wait(0);
				}
			})();
			for (let round = 0; round < 30; round++) await store.save("workspace", { fontSize: 10 + round });
			saving = false;
			await reader;
			expect(reads).toBeGreaterThan(0);
			expect(readdirSync(join(root, ".ssl-studio"))).toEqual(["settings.json"]);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	test("a file that does not read as settings is not written over, and says so by name", async () => {
		const root = mkdtempSync(join(tmpdir(), "ssl-studio-settings-"));
		try {
			const store = new SettingsStore(() => root);
			const file = join(root, ".ssl-studio", "settings.json");
			mkdirSync(join(root, ".ssl-studio"));
			const byHand = '{\n  // my own note\n  "fontSize": 14,\n  "theme": "dark"\n}\n';
			writeFileSync(file, byHand);
			await expect(store.save("workspace", { menuBar: true })).rejects.toThrow("does not read as settings");
			await expect(store.save("workspace", { menuBar: true })).rejects.toThrow(file);
			expect(readFileSync(file, "utf8")).toBe(byHand);
			// A list, or a word, is not settings either.
			writeFileSync(file, "[1, 2]\n");
			await expect(store.save("workspace", { menuBar: true })).rejects.toThrow("does not hold settings");
			expect(readFileSync(file, "utf8")).toBe("[1, 2]\n");
			// The save after a refused one still lands, once the file is mended.
			writeFileSync(file, '{ "fontSize": 14 }\n');
			await store.save("workspace", { menuBar: true });
			expect(JSON.parse(readFileSync(file, "utf8"))).toEqual({ fontSize: 14, menuBar: true });
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	test("a file that is not there, or is empty, is started from nothing", async () => {
		const root = mkdtempSync(join(tmpdir(), "ssl-studio-settings-"));
		try {
			const store = new SettingsStore(() => root);
			const file = join(root, ".ssl-studio", "settings.json");
			await store.save("workspace", { fontSize: 12 });
			expect(JSON.parse(readFileSync(file, "utf8"))).toEqual({ fontSize: 12 });
			writeFileSync(file, "  \n");
			await store.save("workspace", { theme: "dark" });
			expect(JSON.parse(readFileSync(file, "utf8"))).toEqual({ theme: "dark" });
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});
});
