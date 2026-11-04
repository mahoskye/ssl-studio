// The chart supplies the cases: every path through its decisions is one. The agent writes
// them as an SSL test script for you to run in STARLIMS (skill ssl-unit-test), checked and
// reviewed like anything else it writes. Nothing here runs SSL, and the review says so.
import { backend } from "../backend";
import { agent, currentModel } from "../agent/store";
import { fenced } from "../agent/tidy";
import { openReview, type Check } from "../editor/Review";
import { monaco } from "../editor/monaco";
import { session } from "../lsp/session";
import { applyText, notify, openFile, setState, state } from "../state";
import { baseName, joinPath } from "../../shared/paths";
import { TEMPLATES } from "../../shared/houseStyle";
import { MAX_ATTEMPTS, patternsFrom, placeholderIn, procedureText, retryPrompt } from "./build";
import { builtOf, MAX_PATHS, pathsMissing, planPaths, recordTests, testsPrompt } from "./built";
import { readingOf } from "./drift";
import { read, readScript, spansIn } from "./buildRun";
import type { Plan } from "./model";
import { askAgent, begin, planOf, savePlan, specPath, updateAssist } from "./run";

const TOOL_LIMIT = 2;

/** Beside the code it tests: Release.plan.json with Sample/Release.ssl gives Sample/ReleaseTests.ssl. */
function testFile(path: string, plan: Plan) {
	const script = builtOf(plan)!.units[0]!.script;
	const at = Math.max(script.lastIndexOf("/"), script.lastIndexOf("\\"));
	return `${script.slice(0, at + 1)}${baseName(path).replace(/\.plan\.json$/i, "")}Tests.ssl`;
}

async function codeUnderTest(plan: Plan) {
	const code: { name: string; callAs: string; text: string }[] = [];
	for (const unit of builtOf(plan)!.units) {
		const text = await readScript(unit.script);
		const found = text === null ? null : procedureText(text, await spansIn(text), unit.name);
		if (!found) continue;
		const script = (await readingOf(unit.script))?.name;
		code.push({ name: unit.name, callAs: script ? `${script}.${unit.name}` : unit.name, text: found });
	}
	return code;
}

function problemsIn(code: string | null, reading: Awaited<ReturnType<typeof read>> | null, count: number): string[] {
	if (!code || !reading) return ["Your reply had no ```ssl block, so nothing was written."];
	const problems = reading.findings.filter((f) => f.severity <= 2).map((f) => `Line ${f.line}: ${f.code ?? "finding"}: ${f.message}`);
	const placeholder = placeholderIn(code);
	if (placeholder) problems.push(`This is a placeholder, not a test: ${placeholder}`);
	if (!reading.symbols.some((s) => s.name.toLowerCase() === "runtests")) problems.push("The script has no RunTests procedure.");
	const missing = pathsMissing(code, count);
	if (missing.length) problems.push(`Nothing says it tests ${missing.map((n) => `Path ${n}`).join(", ")}: each test's first comment says which path it covers.`);
	for (const target of new Set(reading.edges.filter((e) => !e.resolved).map((e) => e.target))) problems.push(`It calls ${target}, which does not exist in the workspace.`);
	return problems;
}

export function writeTests(path: string) {
	return begin(path, "tests", async () => {
		const plan = planOf(path);
		if (!plan) return notify("Fix the plan's text first.");
		if (!builtOf(plan)?.units.length) return notify("Accept a build first: the tests are written from its code.");
		const { paths, truncated } = planPaths(plan);
		if (!paths.length) return notify("Nothing leads from a start through this chart.");
		const skills = ((await backend.agent("skills", []).catch(() => [])) as { id: string }[]).map((s) => s.id);
		if (!skills.includes("ssl-unit-test")) return notify("The style guide's ssl-unit-test skill is not installed, and writing the tests needs it.", "error");
		updateAssist(path, { progress: "Reading the code under test…" });
		const code = await codeUnderTest(plan);
		if (!code.length) return notify("The procedures this chart built are not there now.");
		const spec = await backend.read(specPath(path)).then(
			(f) => f.text.split("\n## Units")[0]!.trim(),
			() => "",
		);
		const file = testFile(path, plan);
		const base = testsPrompt(plan, baseName(file), paths, code, spec, patternsFrom(TEMPLATES));
		let prompt = base;
		let best: string | null = null;
		let reading: Awaited<ReturnType<typeof read>> | null = null;
		let problems: string[] = [];
		for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
			const reply = await askAgent(path, `Write the tests (try ${attempt} of ${MAX_ATTEMPTS})`, prompt, ["ssl-unit-test"], TOOL_LIMIT);
			if (reply === null) {
				problems = ["The agent did not finish its turn."];
				continue;
			}
			const attemptCode = fenced(reply, "ssl").at(-1) ?? null;
			const attemptReading = attemptCode ? await read(attemptCode) : null;
			problems = problemsIn(attemptCode, attemptReading, paths.length);
			if (attemptCode) (best = attemptCode), (reading = attemptReading);
			if (!problems.length) break;
			prompt = retryPrompt(base, attemptCode, problems);
		}
		if (!best || !reading) return notify(`The agent did not write a test script: ${problems[0] ?? "it gave no code."}`, "error");
		const proposed = await session.formatText(best, { tabSize: 4, insertSpaces: false }).catch(() => best!);
		const missing = pathsMissing(best, paths.length);
		const unresolved = [...new Set(reading.edges.filter((e) => !e.resolved).map((e) => e.target))];
		const local = agent.models.find((m) => `${m.providerID}/${m.id}` === currentModel())?.local ?? true;
		const checks: Check[] = [
			{ label: "A test for every path", ok: !missing.length, detail: missing.length ? `nothing for ${missing.map((n) => `Path ${n}`).join(", ")}` : `${paths.length} ${paths.length === 1 ? "path" : "paths"}` },
			...(truncated ? [{ label: "Every path was asked for", ok: false, detail: `the chart has more than ${MAX_PATHS} paths; these are the first` }] : []),
			{ label: "Every call resolves", ok: !unresolved.length, detail: unresolved.length ? unresolved.join(", ") : undefined },
			{ label: "No errors", ok: !reading.findings.some((f) => f.severity === 1), detail: `${reading.findings.filter((f) => f.severity <= 2).length} errors and warnings` },
			{ label: "These tests have not been run", ok: null, detail: "SSL Studio cannot run SSL. Call RunTests in STARLIMS and read the server log." },
			...(local ? [{ label: "A draft from a local model", ok: null, detail: "check that each test really tests its path" }] : []),
		];
		const existing = await readScript(file);
		openReview({
			title: `Tests: ${file}`,
			original: existing ?? "",
			proposed,
			language: "ssl",
			checks,
			note: problems.length ? `The agent did not get these right in ${MAX_ATTEMPTS} tries:\n\n${problems.map((p) => `- ${p}`).join("\n")}` : undefined,
			acceptLabel: existing === null ? "Accept and create the file" : "Accept into the editor",
			onAccept: async (final) => {
				if (!planOf(path)) await openFile(path);
				const full = joinPath(state.workspace!.root, file);
				if (existing === null) {
					await backend.write(full, final);
					setState("treeVersion", (v) => v + 1);
					await openFile(full);
				} else {
					await openFile(full);
					applyText(monaco.Uri.file(full).fsPath, final);
				}
				const latest = planOf(path);
				if (latest) savePlan(path, recordTests(latest, file));
				notify(`Wrote ${file}. These tests have not been run: run them in STARLIMS.`);
			},
		});
	});
}
