// Runs the desktop app on fixtures/workspace in self-test mode, on any OS:
// it checks the editor and the language server, writes selftest.json and
// quits. Settings and history go to .selftest/, not the user's own.
//
//   bun scripts/selftest.ts      (after the build steps in `hutch run selftest`)
//   bun scripts/selftest.ts --cycle   also a plan's whole life, on a copy of the workspace,
//                                     with the recorded fake in place of a model
import { join } from "node:path";
import { cpSync, rmSync } from "node:fs";

const root = join(import.meta.dir, "..");
const scratch = join(root, ".selftest");
const report = join(root, "selftest.json");
rmSync(report, { force: true });
const cycle = process.argv.includes("--cycle");
const folder = cycle ? join(scratch, "workspace") : join(root, "fixtures", "workspace");
if (cycle) {
	rmSync(folder, { recursive: true, force: true });
	cpSync(join(root, "fixtures", "workspace"), folder, { recursive: true });
}
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
		...(cycle ? { SSL_STUDIO_SELFTEST_CYCLE: "1", SSL_STUDIO_OPENCODE: `bun ${join(root, "test", "fake-opencode.ts")}`, FAKE_MODE: "plan" } : {}),
	},
});
const timer = setTimeout(() => proc.kill(), cycle ? 300_000 : 180_000);
await proc.exited;
clearTimeout(timer);
const file = Bun.file(report);
if (!(await file.exists())) {
	console.error("selftest: no report (the app did not finish)");
	process.exit(1);
}
const result = await file.json();
if (cycle) console.log(JSON.stringify(result.cycle));
console.log(`selftest: ${result.ok ? "ok" : "FAILED"}${result.errors?.length ? ` (${result.errors.length} errors)` : ""}`);
process.exit(result.ok ? 0 : 1);
