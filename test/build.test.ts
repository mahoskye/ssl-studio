import { describe, expect, test } from "bun:test";
import { printSpec, type SpecUnit } from "../src/view/plan/assist";
import { assembleScript, judgeUnit, newRun, nextUnit, nodeStatuses, overBudget, patternsFrom, placeholderIn, questionIn, readSpecFile, requiredCalls, retryPrompt, reviewPrompt, scriptOf, unbuiltNodes, unitPrompt, type BuildUnit, type Judged } from "../src/view/plan/build";
import type { Plan } from "../src/view/plan/model";

const plan = (): Plan => ({
	version: 1,
	title: "Release a sample",
	targets: ["Sample/Release.ssl"],
	groups: [{ id: "g1", name: "Validation" }],
	nodes: [
		{ id: "n1", kind: "start", text: "A sample id arrives" },
		{ id: "n2", kind: "call", text: "Check the id", ref: "IsUsableId", group: "g1" },
		{ id: "n3", kind: "step", text: "Mark released", notes: "Inside a transaction." },
		{ id: "n4", kind: "step", text: "Tell the lab" },
		{ id: "n5", kind: "end", text: "Return" },
	],
	edges: [],
	decisions: [{ question: "Which table?", answer: "SAMPLES" }],
});
const units = (): SpecUnit[] => [
	{ name: "Mark", script: "Sample/Release.ssl", parameters: ["sId"], nodes: ["n3"], calls: [] },
	{ name: "Notify", script: "Sample/Release.ssl", parameters: ["sId"], nodes: ["n4"], calls: [] },
	{ name: "Release", script: "Sample/Release.ssl", parameters: ["sId"], nodes: ["n1", "n2", "n5"], calls: ["Mark", "Notify", "IsUsableId", "Len"] },
];
const map = () => [{ node: "n1", becomes: "parameters" }];

const judged = (over: Partial<Judged> = {}): Judged => ({
	unit: { name: "Release", parameters: ["sId"], calls: [] },
	code: ":PROCEDURE Release;\n:PARAMETERS sId;\n:ENDPROC;",
	before: [],
	after: [],
	existing: [],
	symbols: [{ name: "Release", parameters: ["sId"] }],
	edges: [],
	planned: [],
	mustCall: [],
	size: { bytes: 100, codeLines: 3 },
	limits: { bytes: 51200, codeLines: 400 },
	...over,
});

describe("the judge, on what went wrong in the spike", () => {
	test("a clean unit passes", () => {
		expect(judgeUnit(judged())).toEqual([]);
	});
	test("no code is a failure, not zero findings", () => {
		expect(judgeUnit(judged({ code: null }))[0]).toContain("no ```ssl block");
		expect(judgeUnit(judged({ code: "  " }))[0]).toContain("no ```ssl block");
	});
	test("a comment in place of a step fails", () => {
		for (const line of ["/* Placeholder for notification logic;", "/* Publish the notification (implement actual logic here) ;", "/* TODO: send it;", "/* Placeholder: Replace with actual database update logic */"]) {
			expect(judgeUnit(judged({ code: `:PROCEDURE Release;\n:PARAMETERS sId;\n${line}\n:ENDPROC;` })).join()).toContain("placeholder");
		}
	});
	test("words that only look alike do not", () => {
		expect(placeholderIn("sStubborn := 1;\n/* Mark the sample released;")).toBeNull();
		expect(placeholderIn("nTodo := 1;")).toBeNull();
	});
	test("a call to something that exists nowhere fails", () => {
		const edges = [{ from: "Release", target: "UpdateSampleStatus", resolved: false }];
		expect(judgeUnit(judged({ edges }))[0]).toContain("UpdateSampleStatus, which does not exist");
	});
	test("a call to a later unit of this run is allowed", () => {
		const edges = [{ from: "Release", target: "Notify", resolved: false }];
		expect(judgeUnit(judged({ edges, planned: ["Notify"] }))).toEqual([]);
	});
	test("a resolved call passes, and another procedure's calls are not this one's", () => {
		expect(judgeUnit(judged({ edges: [{ from: "Release", target: "Sample.Orders.Count", resolved: true }] }))).toEqual([]);
		expect(judgeUnit(judged({ edges: [{ from: "Other", target: "Gone", resolved: false }] }))).toEqual([]);
	});
	test("a call the spec promises must be there, written whole or not", () => {
		expect(judgeUnit(judged({ mustCall: ["IsUsableId"] }))[0]).toContain("says it calls IsUsableId");
		expect(judgeUnit(judged({ mustCall: ["IsUsableId"], edges: [{ from: "Release", target: "Regions.IsUsableId", resolved: true }] }))).toEqual([]);
	});
	test("only new findings count, by kind", () => {
		const old = { code: "a", severity: 2, message: "old", line: 1 };
		expect(judgeUnit(judged({ before: [old], after: [old] }))).toEqual([]);
		const problems = judgeUnit(judged({ before: [old], after: [old, { code: "b", severity: 1, message: "new", line: 9 }] }));
		expect(problems.length).toBe(1);
		expect(problems[0]).toContain("Line 9: b: new");
	});
	test("info-level findings do not stop it", () => {
		expect(judgeUnit(judged({ after: [{ code: "c", severity: 3, message: "style", line: 1 }, { code: "d", severity: 4, message: "hint", line: 1 }] }))).toEqual([]);
	});
	test("a signature that differs from the spec fails", () => {
		expect(judgeUnit(judged({ symbols: [{ name: "Release", parameters: ["sId", "nStatus"] }] }))[0]).toContain("should take (sId), not (sId, nStatus)");
		expect(judgeUnit(judged({ symbols: [{ name: "release", parameters: ["SID"] }] }))).toEqual([]);
		expect(judgeUnit(judged({ symbols: [] }))[0]).toContain("does not define");
	});
	test("rewriting what is already in the script fails", () => {
		expect(judgeUnit(judged({ existing: [{ name: "release", parameters: [] }] }))[0]).toContain("already exists");
	});
	test("going over either size limit fails", () => {
		expect(judgeUnit(judged({ size: { bytes: 60000, codeLines: 3 } }))[0]).toContain("59 KB");
		expect(judgeUnit(judged({ size: { bytes: 100, codeLines: 401 } }))[0]).toContain("401 code lines");
	});
});

describe("a run", () => {
	const make = () => newRun({ hash: "h", model: "ollama/x" }, units(), map());
	test("starts with every unit pending, within a token budget", () => {
		const run = make();
		expect(run.units.map((u) => u.status)).toEqual(["pending", "pending", "pending"]);
		expect(run.budget.tokens).toBeGreaterThan(0);
		expect(overBudget(run)).toBe(false);
	});
	test("goes in order", () => {
		const run = make();
		expect(nextUnit(run)!.name).toBe("Mark");
		run.units[0]!.status = "passed";
		expect(nextUnit(run)!.name).toBe("Notify");
	});
	test("carries on past a stuck unit, skipping what waits on it", () => {
		const run = make();
		run.units[0]!.status = "stuck";
		expect(nextUnit(run)!.name).toBe("Notify");
		run.units[1]!.status = "passed";
		expect(nextUnit(run)).toBeNull();
		expect(run.units[2]!.status).toBe("skipped");
		expect(run.units[2]!.problems![0]).toContain("Mark");
	});
	test("ends", () => {
		const run = make();
		for (const u of run.units) u.status = "passed";
		expect(nextUnit(run)).toBeNull();
	});
	test("stops at its budget, tokens or cost", () => {
		const run = newRun({ hash: "h", model: "paid" }, units(), map(), { cost: 1, tokens: 100 });
		run.tokens = 100;
		expect(overBudget(run)).toBe(true);
		run.tokens = 0;
		run.cost = 1;
		expect(overBudget(run)).toBe(true);
		run.cost = 0.5;
		expect(overBudget(run)).toBe(false);
	});
	test("survives being saved and read back", () => {
		const run = make();
		run.units[0]!.code = "x";
		expect(JSON.parse(JSON.stringify(run))).toEqual(run);
	});
});

describe("the chart during a run", () => {
	test("a node shows the worst of its units", () => {
		const run = newRun({ hash: "h", model: "m" }, [...units(), { name: "Extra", nodes: ["n3"] }], map());
		run.units[0]!.status = "passed";
		run.units[3]!.status = "stuck";
		const statuses = nodeStatuses(run);
		expect(statuses.get("n3")).toBe("stuck");
		expect(statuses.get("n1")).toBe("pending");
		expect(nodeStatuses(null).size).toBe(0);
	});
	test("no success while a node has nothing to show", () => {
		const run = newRun({ hash: "h", model: "m" }, units(), map());
		for (const u of run.units) u.status = "passed";
		expect(unbuiltNodes(plan(), run)).toEqual([]);
		run.units[1]!.status = "stuck";
		expect(unbuiltNodes(plan(), run)).toEqual(["Tell the lab"]);
	});
	test("a node the map explains, with no unit, counts as said", () => {
		const p = { ...plan(), nodes: [{ id: "n1", kind: "start" as const, text: "s" }, { id: "n9", kind: "step" as const, text: "Forgotten" }] };
		expect(unbuiltNodes(p, newRun({ hash: "h", model: "m" }, [], map()))).toEqual(["Forgotten"]);
	});
});

describe("what must show as a call", () => {
	test("units and chart calls, not built-ins or nonsense", () => {
		expect(requiredCalls(units()[2]!, plan(), units())).toEqual(["Mark", "Notify", "IsUsableId"]);
		expect(requiredCalls({ name: "x", calls: [{ proc: "Mark" }] as any }, plan(), units())).toEqual([]);
		expect(requiredCalls({ name: "x" }, plan(), units())).toEqual([]);
	});
});

describe("the script a run proposes", () => {
	const built = (over: Partial<BuildUnit>): BuildUnit => ({ name: "U", status: "passed", attempts: 1, code: ":PROCEDURE U;", ...over });
	test("a new one gets the banner, then the units", () => {
		expect(assembleScript(null, "/* banner;\n", [built({})], plan())).toBe("/* banner;\n\n:PROCEDURE U;\n");
	});
	test("an existing one keeps its text, with the units after it", () => {
		expect(assembleScript(":PROCEDURE Old;\n:ENDPROC;\n\n", "/* banner;", [built({})], plan())).toBe(":PROCEDURE Old;\n:ENDPROC;\n\n:PROCEDURE U;\n");
	});
	test("a chart group becomes a region round its units", () => {
		const text = assembleScript(null, "", [built({ name: "A", code: "A;", nodes: ["n2"] }), built({ name: "B", code: "B;", nodes: ["n2"] }), built({ name: "C", code: "C;", nodes: ["n3"] })], plan());
		expect(text).toBe("/* region Validation;\n\nA;\n\nB;\n\n/* endregion;\n\nC;\n");
	});
	test("only what has code goes in", () => {
		expect(assembleScript(null, "", [built({ code: undefined, status: "stuck" }), built({ code: "ok;" })], plan())).toBe("ok;\n");
	});
	test("a unit names its script, or the plan does", () => {
		expect(scriptOf({ name: "x", script: "a.ssl" }, plan())).toBe("a.ssl");
		expect(scriptOf({ name: "x" }, plan())).toBe("Sample/Release.ssl");
		expect(scriptOf({ name: "x" }, { ...plan(), targets: undefined })).toBe("Releaseasample.ssl");
	});
});

describe("an approved spec's file", () => {
	test("gives back its units and map", () => {
		const text = printSpec("# Spec\n```ssl\nx\n```", units(), map(), "abc");
		const read = readSpecFile(text);
		expect(read.units.map((u) => u.name)).toEqual(["Mark", "Notify", "Release"]);
		expect(read.map).toEqual(map());
	});
	test("a hand-edited one that no longer parses gives nothing, not an error", () => {
		expect(readSpecFile("## Units\n```json\n[oops\n```")).toEqual({ units: [], map: [] });
		expect(readSpecFile("no sections")).toEqual({ units: [], map: [] });
	});
});

describe("prompts", () => {
	const unit: BuildUnit = { ...units()[1]!, status: "pending", attempts: 0 };
	test("a unit's carries its steps, notes, what you decided, and what exists", () => {
		const text = unitPrompt(plan(), "THE SPEC TEXT", { ...unit, nodes: ["n3"] }, [{ ...units()[0]!, status: "passed", attempts: 1 }], "CALLABLE");
		for (const part of ["PLAN STAGE: build Notify", "Mark released (Inside a transaction.)", "Which table? SAMPLES", "THE SPEC TEXT", "Mark(sId)", "CALLABLE", "no placeholder"]) expect(text).toContain(part);
	});
	test("carries your answer and your reason when there are some", () => {
		const text = unitPrompt(plan(), "s", { ...unit, question: "How?", answer: "By email", feedback: "Too long" }, [], "c");
		for (const part of ["YOU ASKED: How?", "THE USER SAID: By email", "REJECTED THE LAST VERSION: Too long"]) expect(text).toContain(part);
	});
	test("a retry shows the attempt and what is wrong", () => {
		const text = retryPrompt("BASE", "bad code", ["Line 1: x"]);
		for (const part of ["BASE", "bad code", "- Line 1: x"]) expect(text).toContain(part);
		expect(retryPrompt("BASE", null, ["no code"])).not.toContain("YOUR LAST ATTEMPT");
	});
	test("a second opinion gets everything, and is told not to ask for a file", () => {
		const text = reviewPrompt(plan(), "SPEC", [{ path: "a.ssl", text: "CODE" }]);
		for (const part of ["Do not ask for a file", "Tell the lab", "SPEC", "a.ssl", "CODE"]) expect(text).toContain(part);
	});
});

describe("worked examples for the agent", () => {
	test("come from the house's templates, with their placeholders filled in", () => {
		const text = patternsFrom([
			{ label: "RunSQL", group: "Data", body: () => 'RunSQL("${1:UPDATE T SET A = 1}");\n$0' },
			{ label: "Banner", group: "File", body: () => "not this" },
		]);
		expect(text).toContain('RunSQL("UPDATE T SET A = 1");');
		expect(text).not.toContain("$");
		expect(text).not.toContain("Banner");
	});
	test("reach the prompt, with the rule that SQL goes through them", () => {
		const unit: BuildUnit = { name: "U", status: "pending", attempts: 0 };
		expect(unitPrompt(plan(), "s", unit, [], "c", "EXAMPLES")).toContain("EXAMPLES");
		expect(unitPrompt(plan(), "s", unit, [], "c", "EXAMPLES")).toContain("never as a bare statement");
		expect(unitPrompt(plan(), "s", unit, [], "c")).not.toContain("HOW SSL DOES");
	});
	test("the prompt forbids tools, and writing files", () => {
		const text = unitPrompt(plan(), "s", { name: "U", status: "pending", attempts: 0 }, [], "c");
		expect(text).toContain("Do not call any tool");
	});
});

describe("a question in place of an answer", () => {
	test("is found", () => {
		expect(questionIn('<<<QUESTIONS\n[{"question":"Which table?"}]\n>>>QUESTIONS')).toBe("Which table?");
		expect(questionIn('<<<QUESTIONS\n```json\n[{"question":"Which?"}]\n```\n>>>QUESTIONS')).toBe("Which?");
	});
	test("an empty list or none is no question", () => {
		expect(questionIn("<<<QUESTIONS\n[]\n>>>QUESTIONS")).toBeNull();
		expect(questionIn("```ssl\ncode\n```")).toBeNull();
		expect(questionIn("<<<QUESTIONS\nnot json\n>>>QUESTIONS")).toBeNull();
	});
});
