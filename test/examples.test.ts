// The demo project (examples/due-dates) against the pinned language server.
// It is the example of a well-made project, so it must stay one as the server
// changes: every script is valid and draws nothing under --strict, except
// the one script left rough on purpose, which must still draw findings (it is
// there to give Problems, Health and the tidy sequence something to do).
//
// Needs vendor/starlims-lsp (bun scripts/bundle-lsp.ts) or STARLIMS_LSP. With
// neither at the pinned version the checks are skipped, and say so.
import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { join, relative } from "node:path";
import { LSP_PIN } from "../src/bun/tools";

const root = join(import.meta.dir, "..");
const project = join(root, "examples", "due-dates");
/** Left rough on purpose: tidy material, called by nothing. */
const ROUGH = /^src\/Legacy\//;

type Result = { file: string; valid: boolean; diagnostics: { line: number; severity: string; code: string; message: string }[] };

function pinnedServer(): string | null {
	const suffix = process.platform === "win32" ? ".exe" : "";
	for (const path of [process.env.STARLIMS_LSP, join(root, "vendor", `starlims-lsp${suffix}`)]) {
		if (!path || !existsSync(path)) continue;
		const out = Bun.spawnSync([path, "--version"]).stdout.toString();
		if (/starlims-lsp version (\S+)/.exec(out)?.[1] === LSP_PIN) return path;
	}
	return null;
}

const server = pinnedServer();
const files = [...new Bun.Glob("{src,tests}/**/*.{ssl,ds}").scanSync({ cwd: project })].map((f) => f.split("\\").join("/")).sort();

function validate(list: string[]): Map<string, Result> {
	const run = Bun.spawnSync([server!, "--validate", "--strict", ...list.map((f) => join(project, f))]);
	const results = JSON.parse(run.stdout.toString()) as Result[];
	// The server names a file as it was given; key by the project-relative path.
	return new Map(list.map((file, i) => [file, results[i]!]));
}

describe("the demo project", () => {
	test("has scripts, tests, a data source and the rough script", () => {
		expect(files.filter((f) => f.startsWith("src/") && !ROUGH.test(f)).length).toBeGreaterThanOrEqual(6);
		expect(files.filter((f) => f.startsWith("tests/")).length).toBeGreaterThanOrEqual(3);
		expect(files.some((f) => f.endsWith(".ds"))).toBe(true);
		expect(files.filter((f) => ROUGH.test(f)).length).toBe(1);
	});

	test("every file stays small enough to read in one sitting", async () => {
		const long: string[] = [];
		for (const file of files) {
			const lines = (await Bun.file(join(project, file)).text()).split("\n").length;
			if (lines > 200) long.push(`${file}: ${lines} lines`);
		}
		expect(long).toEqual([]);
	});

	test.skipIf(!server)(`is clean under starlims-lsp ${LSP_PIN} --validate --strict`, () => {
		const clean = files.filter((f) => !ROUGH.test(f));
		const found = [...validate(clean)].flatMap(([file, r]) => [...(r.valid ? [] : [`${file}: not valid SSL`]), ...r.diagnostics.map((d) => `${file}:${d.line} ${d.severity} ${d.code}: ${d.message}`)]);
		expect(found).toEqual([]);
	});

	test.skipIf(!server)("the rough script parses, and still gives the IDE findings to show", () => {
		const rough = files.filter((f) => ROUGH.test(f));
		const [result] = [...validate(rough).values()];
		expect(result!.valid).toBe(true);
		expect(result!.diagnostics.some((d) => d.severity === "error")).toBe(false);
		expect(new Set(result!.diagnostics.map((d) => d.code)).size).toBeGreaterThanOrEqual(2);
	});

	test.skipIf(!server)("the formatter leaves every clean file as it is", async () => {
		const changed: string[] = [];
		for (const file of files.filter((f) => !ROUGH.test(f))) {
			const formatted = Bun.spawnSync([server!, "--format", join(project, file)]).stdout.toString();
			if (formatted !== (await Bun.file(join(project, file)).text())) changed.push(file);
		}
		expect(changed).toEqual([]);
	});

	test("says when the server is missing, so a skip is not read as a pass", () => {
		if (!server) console.warn(`examples.test.ts: no starlims-lsp ${LSP_PIN} in vendor/ or STARLIMS_LSP; the demo project was NOT checked (${relative(root, project)}).`);
		expect(typeof LSP_PIN).toBe("string");
	});
});
