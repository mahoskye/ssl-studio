// Runs the desktop app on fixtures/workspace in self-test mode, on any OS:
// it checks the editor and the language server, writes selftest.json and
// quits. Settings and history go to .selftest/, not the user's own.
//
//   bun scripts/selftest.ts      (after the build steps in `hutch run selftest`)
//   bun scripts/selftest.ts --cycle   also a plan's whole life, on a copy of the workspace,
//                                     with the recorded fake in place of a model
//   bun scripts/selftest.ts --close   the close guard instead (ADR 0009): an edit left unsaved, then
//                                     the window's close button, twice. Linux (X11, xdotool) and Windows.
import { join } from "node:path";
import { cpSync, readFileSync, rmSync } from "node:fs";
import { closeUnsupported, requestClose, windowsTitled } from "./window-close";

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
// The close check saves a file, so it also works on a copy.
const folder = cycle || close ? join(scratch, "workspace") : join(root, "fixtures", "workspace");
if (cycle || close) {
	rmSync(folder, { recursive: true, force: true });
	cpSync(join(root, "fixtures", "workspace"), folder, { recursive: true });
}
const TITLE = "SSL Studio";
const before = close ? new Set(windowsTitled(TITLE)) : new Set<number>();
const hutch = Bun.which("hutch") ?? process.env.HUTCH ?? "hutch";
const proc = Bun.spawn([hutch, "electrobun", "dev"], {
	cwd: root,
	stdout: "inherit",
	stderr: "inherit",
	env: {
		...process.env,
		XDG_CONFIG_HOME: join(scratch, "config"),
		XDG_DATA_HOME: join(scratch, "data"),
		XDG_STATE_HOME: join(scratch, "state"),
		SSL_STUDIO_SELFTEST: report,
		SSL_STUDIO_FOLDER: folder,
		...(close ? { SSL_STUDIO_SELFTEST_CLOSE: "1" } : {}),
		...(cycle ? { SSL_STUDIO_SELFTEST_CYCLE: "1", SSL_STUDIO_OPENCODE: `bun ${join(root, "test", "fake-opencode.ts")}`, FAKE_MODE: "plan" } : {}),
	},
});
let timedOut = false;
const timer = setTimeout(() => ((timedOut = true), proc.kill()), cycle ? 300_000 : 180_000);
if (close) process.exit(await closeCheck());
await proc.exited;
clearTimeout(timer);
const file = Bun.file(report);
if (!(await file.exists())) {
	console.error("selftest: no report (the app did not finish)");
	process.exit(1);
}
const result = await file.json();
console.log(JSON.stringify({ docs: result.docs }));
if (cycle) console.log(JSON.stringify({ cycle: result.cycle, docsSetup: result.docsSetup }));
console.log(`selftest: ${result.ok ? "ok" : "FAILED"}${result.errors?.length ? ` (${result.errors.length} errors)` : ""}`);
process.exit(result.ok ? 0 : 1);

/**
 * The close guard, from outside: waits for the view to say it has an unsaved
 * edit, presses the window's close button, checks the window stayed and asked,
 * presses it again, and checks the app saved the file and closed itself.
 */
async function closeCheck(): Promise<number> {
	const read = () => {
		try {
			return JSON.parse(readFileSync(report, "utf8")) as Record<string, any>;
		} catch {
			return {};
		}
	};
	const stage = async (name: string) => {
		while (proc.exitCode === null && !timedOut) {
			const now = read();
			if (now.stage === name || now.stage === "failed") return now;
			await Bun.sleep(200);
		}
		return read();
	};
	const pressClose = () => {
		const mine = windowsTitled(TITLE).filter((id) => !before.has(id));
		return mine.length > 0 && mine.map(requestClose).every(Boolean);
	};
	const problems: string[] = [];
	const check = (ok: unknown, what: string) => ok || problems.push(what);

	const unsaved = await stage("unsaved");
	check(unsaved.stage === "unsaved", `the view did not get to an unsaved edit (${unsaved.error ?? unsaved.stage ?? "no report"})`);
	if (!problems.length) {
		check(pressClose(), "the app's window was not found, so its close button was not pressed");
		const kept = await stage("kept");
		check(kept.stage === "kept", `the window did not stay and ask (${kept.error ?? (proc.exitCode === null ? kept.stage : "the app closed")})`);
		check(/^1 file has unsaved changes \(.+\)\. Closing the window would lose them\.$/.test(kept.question ?? ""), `the question was: ${kept.question}`);
		check(["Save all", "Discard changes", "Cancel"].every((b) => (kept.offered ?? []).includes(b)), `the question offered: ${kept.offered}`);
		check(kept.stillUnsaved && kept.editKept, "the edit did not survive the cancelled close");
		check(proc.exitCode === null, "the app closed although the question was cancelled");
		if (!problems.length) {
			check(pressClose(), "the window was gone before the second close");
			const saving = await stage("saving");
			check(saving.stage === "saving", `the second close did not ask (${saving.error ?? saving.stage})`);
			const exited = await Promise.race([proc.exited.then(() => true), Bun.sleep(20_000).then(() => false)]);
			check(exited && !timedOut, "the app did not close itself after “Save all”");
			const file = String(saving.file ?? unsaved.file ?? "");
			check(file && readFileSync(file, "utf8").includes("selftest: an edit left unsaved"), "the file on disk does not have the edit that was saved");
		}
	}
	clearTimeout(timer);
	if (proc.exitCode === null) proc.kill();
	console.log(JSON.stringify({ close: read() }));
	for (const problem of problems) console.error(`selftest --close: ${problem}`);
	console.log(`selftest --close: ${problems.length ? "FAILED" : "ok"}`);
	return problems.length ? 1 : 0;
}
