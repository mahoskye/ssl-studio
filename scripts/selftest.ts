// Runs the desktop app on fixtures/workspace in self-test mode, on any OS:
// it checks the editor and the language server, writes selftest.json and
// quits. Settings and history go to .selftest/, not the user's own.
//
//   bun scripts/selftest.ts      (after the build steps in `hutch run selftest`)
//   bun scripts/selftest.ts --cycle   also a plan's whole life, on a copy of the workspace,
//                                     with the recorded fake in place of a model
//   bun scripts/selftest.ts --close   closing over unsaved text instead (ADR 0042): edits left unsaved, the
//                                     window's close button, and the app started again to find them.
//                                     Linux (X11, xdotool) and Windows.
import { join } from "node:path";
import { cpSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { closeUnsupported, requestClose, windowsTitled } from "./window-close";

export const SELFTEST_XDG_DIRS = ["config", "data", "state", "cache"] as const;

export function selftestEnv(opts: { root: string; scratch: string; report: string; folder: string; close: boolean; cycle: boolean; baseEnv?: NodeJS.ProcessEnv }) {
	return {
		...(opts.baseEnv ?? process.env),
		XDG_CONFIG_HOME: join(opts.scratch, "config"),
		XDG_DATA_HOME: join(opts.scratch, "data"),
		XDG_STATE_HOME: join(opts.scratch, "state"),
		XDG_CACHE_HOME: join(opts.scratch, "cache"),
		SSL_STUDIO_SELFTEST: opts.report,
		SSL_STUDIO_FOLDER: opts.folder,
		...(opts.close ? { SSL_STUDIO_SELFTEST_CLOSE: "1" } : {}),
		...(opts.cycle ? { SSL_STUDIO_SELFTEST_CYCLE: "1", SSL_STUDIO_OPENCODE: JSON.stringify(["bun", join(opts.root, "test", "fake-opencode.ts")]), FAKE_MODE: "plan" } : {}),
	};
}

/**
 * Stops what is left of the app when a run is over and it is still there. The launcher starts the app as a process
 * of its own, which outlives the one that was started here: a run that failed, or ran out of time, left the app
 * standing on the screen with its window. Only an app from this checkout's own build is stopped.
 */
export function stopLeftoverApp(root: string) {
	const built = join(root, "build");
	if (process.platform === "win32") {
		Bun.spawnSync(["powershell.exe", "-NoProfile", "-Command", `Get-Process | Where-Object { $_.Path -like '${built.replace(/'/g, "''")}\\*' } | Stop-Process -Force`]);
	} else {
		// From the start of the command line: this script's own does not begin with the build folder.
		Bun.spawnSync(["pkill", "-KILL", "-f", `^${built.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}/`]);
	}
}

export function wipeSelftestScratch(scratch: string) {
	for (const dir of SELFTEST_XDG_DIRS) {
		rmSync(join(scratch, dir), { recursive: true, force: true });
	}
}

async function main() {
	const root = join(import.meta.dir, "..");
	const scratch = join(root, ".selftest");
	const report = join(root, "selftest.json");
	rmSync(report, { force: true });
	const cycle = process.argv.includes("--cycle");
	const close = process.argv.includes("--close");
	if (close && closeUnsupported()) {
		console.error(`selftest --close: the window's close button cannot be pressed from outside here: ${closeUnsupported()}.`);
		process.exit(2);
	}
	wipeSelftestScratch(scratch);
	// The close check saves a file, so it also works on a copy.
	const folder = cycle || close ? join(scratch, "workspace") : join(root, "fixtures", "workspace");
	if (cycle || close) {
		rmSync(folder, { recursive: true, force: true });
		cpSync(join(root, "fixtures", "workspace"), folder, { recursive: true });
	}
	const TITLE = "SSL Studio";
	const hutch = Bun.which("hutch") ?? process.env.HUTCH ?? "hutch";
	const start = () =>
		Bun.spawn([hutch, "electrobun", "dev"], {
			cwd: root,
			stdout: "inherit",
			stderr: "inherit",
			env: selftestEnv({ root, scratch, report, folder, close, cycle }),
		});
	if (close) process.exit(await closeCheck());
	const proc = start();
	const timer = setTimeout(() => {
		proc.kill();
		stopLeftoverApp(root);
	}, cycle ? 300_000 : 180_000);
	await proc.exited;
	clearTimeout(timer);
	const file = Bun.file(report);
	if (!(await file.exists())) {
		console.error("selftest: no report (the app did not finish)");
		process.exit(1);
	}
	const result = await file.json();
	console.log(JSON.stringify({ docs: result.docs }));
	if (cycle) console.log(JSON.stringify({ cycle: result.cycle, docsSetup: result.docsSetup, work: result.work, writing: result.writing }));
	console.log(`selftest: ${result.ok ? "ok" : "FAILED"}${result.errors?.length ? ` (${result.errors.length} errors)` : ""}`);
	process.exit(result.ok ? 0 : 1);

	/**
	 * Closing over unsaved text, from outside (ADR 0042). The app is started twice on the same copy of the
	 * workspace, and its own files are kept between the two.
	 *
	 * First: the view leaves a file and a document with no file yet unsaved. Their text has to be kept as it was
	 * typed, with nothing closed. Then one more line is typed and the window's close button pressed at once: the
	 * app has to close by itself, ask nothing, and leave the file on disk as it was.
	 *
	 * Again: both documents have to be back, unsaved, with every line they were left with. The file is saved, which
	 * has to put it on disk and end what was kept of it; and the window closes once more over what is still unsaved.
	 */
	async function closeCheck(): Promise<number> {
		const MARK = "selftest: an edit left unsaved";
		const MARK_LATE = "selftest: typed just before the close";
		const UNTITLED = "selftest: a document with no file yet";
		const problems: string[] = [];
		const check = (ok: unknown, what: string) => ok || problems.push(what);
		const read = () => {
			try {
				return JSON.parse(readFileSync(report, "utf8")) as Record<string, any>;
			} catch {
				return {};
			}
		};
		/** The texts the app keeps for the workspace, as they are in its state folder now. */
		const kept = () => {
			const base = join(scratch, "state", "ssl-studio", "unsaved");
			const texts: { untitled: boolean; text: string }[] = [];
			try {
				for (const dir of readdirSync(base)) {
					for (const name of readdirSync(join(base, dir)).filter((n) => n.endsWith(".json"))) {
						try {
							texts.push({ untitled: name.startsWith("u-"), text: String(JSON.parse(readFileSync(join(base, dir, name), "utf8")).text ?? "") });
						} catch {
							// Being written just now.
						}
					}
				}
			} catch {
				// Nothing kept yet.
			}
			return texts;
		};
		const keptFile = () => kept().find((each) => !each.untitled)?.text ?? "";
		const keptUntitled = () => kept().find((each) => each.untitled)?.text ?? "";
		const within = async (ms: number, ok: () => unknown) => {
			for (const end = Date.now() + ms; Date.now() < end; await Bun.sleep(200)) if (ok()) return true;
			return Boolean(ok());
		};

		/** One run of the app: started, with its window's close button to press, and stopped if it is still there at the end. */
		const run = async (work: (app: { stage: (name: string) => Promise<Record<string, any>>; pressClose: () => boolean; closed: (ms: number) => Promise<boolean> }) => Promise<void>) => {
			const before = new Set(windowsTitled(TITLE));
			rmSync(report, { force: true });
			const proc = start();
			let timedOut = false;
			const timer = setTimeout(() => {
				timedOut = true;
				proc.kill();
			}, 120_000);
			try {
				await work({
					stage: async (name) => {
						while (proc.exitCode === null && !timedOut) {
							const now = read();
							if (now.stage === name || now.stage === "failed") return now;
							await Bun.sleep(200);
						}
						return read();
					},
					pressClose: () => {
						const mine = windowsTitled(TITLE).filter((id) => !before.has(id));
						return mine.length > 0 && mine.map(requestClose).every(Boolean);
					},
					closed: (ms) => Promise.race([proc.exited.then(() => !timedOut), Bun.sleep(ms).then(() => false)]),
				});
			} finally {
				clearTimeout(timer);
				if (proc.exitCode === null) {
					proc.kill();
					await proc.exited;
					stopLeftoverApp(root);
				}
			}
		};

		let file = "";
		let original = "";
		await run(async (app) => {
			const unsaved = await app.stage("unsaved");
			check(unsaved.stage === "unsaved", `the view did not get to its unsaved edits (${unsaved.error ?? unsaved.stage ?? "no report"})`);
			if (problems.length) return;
			file = String(unsaved.file ?? "");
			original = readFileSync(file, "utf8");
			check(!original.includes(MARK), "the edit is on disk before anything saved it");
			// Kept as it is typed: within a few seconds, with the window open and nothing asked of it.
			check(await within(10_000, () => keptFile().includes(MARK) && keptUntitled().includes(UNTITLED)), `the unsaved text was not kept as it was typed (kept: ${JSON.stringify(kept().map((each) => each.text.slice(0, 60)))})`);
			if (problems.length) return;
			// The view is told, types one more line, and the close button is pressed at once.
			writeFileSync(`${file}.selftest-kept`, "");
			const typed = await app.stage("typed");
			check(typed.stage === "typed", `the view did not type its last line (${typed.error ?? typed.stage})`);
			if (problems.length) return;
			check(app.pressClose(), "the app's window was not found, so its close button was not pressed");
			check(await app.closed(20_000), `the app did not close by itself${read().asked ? `: it asked “${read().asked}”` : ""}`);
			check(!read().asked, `the app asked before it closed: ${read().asked}`);
			check(readFileSync(file, "utf8") === original, "the file on disk was changed by the close");
			check(keptFile().includes(MARK_LATE) && keptFile().includes(MARK), `the line typed just before the close was not kept (kept: ${JSON.stringify(keptFile().slice(0, 120))})`);
			check(keptUntitled().includes(UNTITLED), "the document with no file yet was not kept");
		});
		if (file) rmSync(`${file}.selftest-kept`, { force: true });

		if (!problems.length) {
			await run(async (app) => {
				const restored = await app.stage("restored");
				check(restored.stage === "restored", `the unsaved documents did not come back (${restored.error ?? (restored.stage === "unsaved" ? "the app started with nothing unsaved" : (restored.stage ?? "no report"))})`);
				if (problems.length) return;
				check((restored.unsaved ?? []).length === 2, `unsaved after the restart: ${JSON.stringify(restored.unsaved)}`);
				check(String(restored.fileText ?? "").includes(MARK) && String(restored.fileText ?? "").includes(MARK_LATE), `the file came back with: ${JSON.stringify(restored.fileText)}`);
				check(String(restored.untitledText ?? "").includes(UNTITLED), `the document with no file came back with: ${JSON.stringify(restored.untitledText)}`);
				check((restored.unsaved ?? []).every((path: string) => (restored.tabs ?? []).includes(path)), `the tabs after the restart: ${JSON.stringify(restored.tabs)}`);
				check(!(restored.conflicts ?? []).length, `a file that had not changed on disk came back as changed: ${JSON.stringify(restored.conflicts)}`);
				check(!restored.asked, `the app asked as it started: ${restored.asked}`);
				check(readFileSync(file, "utf8") === original, "the file on disk was changed by the restart");
				// Seen as it was: the view is told, and saves.
				writeFileSync(`${file}.selftest-kept`, "");
				const saved = await app.stage("saved");
				check(saved.stage === "saved" && saved.saved === true, `the file that came back was not saved (${saved.error ?? saved.stage})`);
				if (problems.length) return;
				const onDisk = readFileSync(file, "utf8");
				check(onDisk.includes(MARK) && onDisk.includes(MARK_LATE), "the file on disk does not have the edits that were saved");
				check(await within(10_000, () => !kept().some((each) => !each.untitled)), "the saved file's text is still kept as unsaved");
				// Once more, over the document that still has no file.
				check(app.pressClose(), "the window was gone before the second close");
				check(await app.closed(20_000), `the app did not close by itself the second time${read().asked ? `: it asked “${read().asked}”` : ""}`);
				check(!read().asked, `the app asked before it closed the second time: ${read().asked}`);
				check(keptUntitled().includes(UNTITLED), "the document with no file yet was not kept by the second close");
			});
		}
		console.log(JSON.stringify({ close: read() }));
		for (const problem of problems) console.error(`selftest --close: ${problem}`);
		console.log(`selftest --close: ${problems.length ? "FAILED" : "ok"}`);
		return problems.length ? 1 : 0;
	}
}

if (import.meta.main) {
	await main();
}
