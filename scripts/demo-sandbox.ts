// Runs the demo project's tests (examples/due-dates) in the SSL sandbox
// runner, which is a separate, private project: a compatibility runtime for
// SSL, not STARLIMS itself. Nothing of it is in this repository. Point at it:
//
//   SSL_RUNNER_DIR=../ssl-cs bun scripts/demo-sandbox.ts
//
// The runner finds scripts by the export's layout (Server Scripts/<Category>/
// <Name>.srvscr, Data Sources/<Category>/<Name>.ds), so the project is copied
// into that shape under .sandbox/ first, with the schema/database/ DDL + seed files as the database.
// Every *Tests script's RunTests is run, each in a runner process of its own, so
// each on a fresh copy of the database (the cases of one manifest share one).
// Prints what passed and what did not, and says when a test script left the
// database changed. Exits 1 unless everything passed and nothing was left.
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";

const root = resolve(import.meta.dir, "..");
const project = join(root, "examples", "due-dates");
const runner = resolve(process.env.SSL_RUNNER_DIR ?? join(root, "..", "ssl-cs"));
const python = [join(runner, ".venv", "bin", "python"), join(runner, ".venv", "Scripts", "python.exe")].find(existsSync);
if (!python) {
	console.error(`No SSL runner at ${runner} (set SSL_RUNNER_DIR). The demo project was NOT run.`);
	process.exit(2);
}

const out = join(root, ".sandbox");
rmSync(out, { recursive: true, force: true });
const copy = (from: string, to: string, ext: string, as: string) => {
	if (!existsSync(from)) return [];
	mkdirSync(to, { recursive: true });
	const names = readdirSync(from).filter((f) => f.endsWith(ext));
	for (const name of names) cpSync(join(from, name), join(to, basename(name, ext) + as));
	return names.map((n) => basename(n, ext));
};
copy(join(project, "src", "DueDates"), join(out, "Server Scripts", "DueDates"), ".ssl", ".srvscr");
copy(join(project, "src", "Legacy"), join(out, "Server Scripts", "Legacy"), ".ssl", ".srvscr");
const tests = copy(join(project, "tests", "DueDatesTests"), join(out, "Server Scripts", "DueDatesTests"), ".ssl", ".srvscr").filter((n) => /Tests$/.test(n));
const sources = copy(join(project, "src", "DueDates"), join(out, "Data Sources", "DueDates"), ".ds", ".ds");
mkdirSync(join(out, "fixtures"), { recursive: true });
const demoFixture = ["DEMO_INSTRUMENTS.sql", "DEMO_HOLIDAYS.sql", "DEMO_OUTAGES.sql", "DEMO_SAMPLES.sql", "demo-seed.sql"]
	.map((f) => readFileSync(join(project, "schema", "database", f), "utf8").trimEnd())
	.join("\n\n");
writeFileSync(join(out, "fixtures", "demo.sql"), `${demoFixture}\n`);

// A data source's language is catalog metadata in STARLIMS; here it is read from the file's banner.
const sql = sources.filter((name) => /DATA SOURCE: \w+ \(SQL\)/.test(readFileSync(join(project, "src", "DueDates", `${name}.ds`), "utf8")));
const only = process.argv.slice(2).filter((a) => !a.startsWith("-"));
// max_steps: the runner stops a request after 100,000 statements unless told otherwise. A whole
// test script is one request, and the day-limit tests of AddWorkingDaysTests walk 730 days against
// 730 holidays (about 400,000 statements).
const config = { clock: "2026-11-18T12:00:00", max_steps: 1_000_000, user_data: "DEMO", session_id: "DUE-DATES", data_source_languages: Object.fromEntries(sql.map((name) => [`Data Sources/DueDates/${name}.ds`, "SQL"])) };
mkdirSync(join(out, "manifests"), { recursive: true });
const cases: any[] = [];
for (const t of tests.filter((t) => !only.length || only.includes(t)).sort()) {
	// One manifest for each test script: the fixture is loaded once for a manifest.
	const manifest = { schema_version: 1, script_root: "..", fixture: "../fixtures/demo.sql", config, case_defaults: { trace: false }, cases: [{ name: t, script: `Server Scripts/DueDatesTests/${t}.srvscr`, procedure_calls: [{ procedure: "RunTests", args: [] }] }] };
	writeFileSync(join(out, "manifests", `${t}.json`), JSON.stringify(manifest, null, 1));
	const run = Bun.spawnSync([python, "-m", "ssl_runner", "corpus-test", "--manifest", join(out, "manifests", `${t}.json`)], { cwd: runner, stdout: "pipe", stderr: "pipe" });
	try {
		cases.push(...JSON.parse(run.stdout.toString()).cases);
	} catch {
		console.error(run.stderr.toString() || run.stdout.toString().slice(0, 2000));
		process.exit(2);
	}
}

let passed = 0;
let total = 0;
let broken = 0;
let dirty = 0;
const short = (path: string) => path.replace(out + "/", "").replace(/^Server Scripts\//, "");
for (const item of cases) {
	const response = item.response ?? {};
	// A manifest with procedure calls answers with one result for each call.
	const result = Array.isArray(response.procedure_results) ? response.procedure_results[0]?.result : response.result;
	if (!response.ok || !Array.isArray(result)) {
		broken++;
		const e = response.error ?? {};
		console.log(`✖ ${item.name}: did not run. ${e.code ?? ""} ${e.message ?? JSON.stringify(response).slice(0, 300)}${e.script ? ` (${short(e.script)}:${e.line})` : ""}`);
	} else {
		const [ok, count, rows] = result as [number, number, [string, boolean][]];
		passed += ok;
		total += count;
		console.log(`${ok === count ? "✔" : "✖"} ${item.name}: ${ok} of ${count}`);
		for (const [label, good] of rows ?? []) if (!good) console.log(`    failed: ${label}`);
	}
	for (const w of response.warnings ?? []) console.log(`    warning: ${w.message}${w.script ? ` (${short(w.script)}:${w.line})` : ""}`);
	// Every test promises to leave the rows as it found them. The runner's evidence says whether it did.
	const database = response.evidence?.database;
	if (database && database.before_digest !== database.after_digest) {
		dirty++;
		console.log(`    left the database changed: ${Object.keys(database.tables ?? {}).join(", ")}`);
	}
}
console.log(`\n${passed} of ${total} tests passed in the sandbox runner${broken ? `; ${broken} test script${broken === 1 ? "" : "s"} did not run` : ""}${dirty ? `; ${dirty} left the database changed` : ""}.`);
process.exit(broken || dirty || passed !== total || !total ? 1 : 0);
