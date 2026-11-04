import { describe, expect, test } from "bun:test";
import { planHash, unaccounted, specPrompt, type SpecUnit } from "../src/view/plan/assist";
import { assembleScript, newRun, nextUnit, nodeStatuses, procedureSpans, procedureText, reviewPrompt, unbuiltNodes, unitPrompt, type BuildRun, type BuildUnit } from "../src/view/plan/build";
import { anyChanges, builtOf, changesSince, changeText, chartChanges, classifyUnits, driftFindings, driftOf, nodePrint, pathLine, pathsMissing, planPaths, recordBuilt, recordTests, revisionText, settleBuilt, settledNodes, testsPrompt, unitsOfNode, type Reading } from "../src/view/plan/built";
import { checkPlan, parsePlan, printPlan, setText, type Plan } from "../src/view/plan/model";

const plan = (): Plan => ({
	version: 1,
	title: "Release a sample",
	targets: ["Sample/Release.ssl"],
	groups: [],
	nodes: [
		{ id: "n1", kind: "start", text: "A sample id arrives" },
		{ id: "n2", kind: "call", text: "Check the id", ref: "Regions.IsUsableId" },
		{ id: "n3", kind: "decision", text: "Usable?" },
		{ id: "n4", kind: "step", text: "Mark released" },
		{ id: "n5", kind: "step", text: "Tell the lab" },
		{ id: "n6", kind: "end", text: "Return" },
	],
	edges: [
		{ from: "n1", to: "n2" },
		{ from: "n2", to: "n3" },
		{ from: "n3", to: "n4", label: "yes" },
		{ from: "n3", to: "n6", label: "no" },
		{ from: "n4", to: "n5" },
		{ from: "n5", to: "n6" },
	],
});
const specUnits = (): SpecUnit[] => [
	{ name: "Mark", script: "Sample/Release.ssl", parameters: ["sId"], nodes: ["n4"], calls: [] },
	{ name: "Notify", script: "Sample/Other.ssl", parameters: ["sId"], nodes: ["n5"], calls: [] },
	{ name: "Release", script: "Sample/Release.ssl", parameters: ["sId"], nodes: ["n1", "n2", "n3", "n6"], calls: ["Mark", "Notify", "Regions.IsUsableId", "Len"] },
];
const asUnits = (list = specUnits()): BuildUnit[] => list.map((u) => ({ ...u, status: "passed", attempts: 1, code: `:PROCEDURE ${u.name};\n:ENDPROC;` }));
const built = () => recordBuilt(plan(), asUnits(), specUnits());
const runOf = (p: Plan, units = specUnits(), map: { node: string; becomes: string }[] = []): BuildRun => newRun({ hash: planHash(p), model: "m" }, units, map);

describe("recording a build", () => {
	test("links each node to the procedure that carries it", () => {
		const p = built();
		expect(unitsOfNode(p, "n4").map((u) => u.name)).toEqual(["Mark"]);
		expect(unitsOfNode(p, "n2").map((u) => [u.name, u.script])).toEqual([["Release", "Sample/Release.ssl"]]);
		expect(unitsOfNode(p, "nope")).toEqual([]);
	});
	test("keeps calls between units only: a built-in is not the chart's business, and call nodes are read live", () => {
		expect(builtOf(built())!.units.find((u) => u.name === "Release")!.calls).toEqual(["Mark", "Notify"]);
	});
	test("does not make the spec stale, and survives the plan's text", () => {
		expect(planHash(built())).toBe(planHash(plan()));
		const again = parsePlan(printPlan(built())).plan!;
		expect(builtOf(again)).toEqual(builtOf(built()));
		expect(checkPlan(again).filter((f) => f.severity === "error")).toEqual([]);
	});
	test("prints a unit a line, so a rebuild shows as a small diff", () => {
		const text = printPlan(recordTests(built(), "T.ssl"));
		expect(text).toContain('      { "name": "Mark", "script": "Sample/Release.ssl", "parameters": ["sId"], "nodes": ["n4"], "calls": [] },\n');
		expect(text).toContain('      "n4": "');
		expect(text).toContain('"tests": {');
		expect(printPlan(parsePlan(text).plan!)).toBe(text);
		expect(parsePlan(printPlan({ ...plan(), built: "oops" })).plan!.built).toBe("oops");
	});
	test("one script at a time, and a node goes to whichever unit built it last", () => {
		const first = recordBuilt(plan(), asUnits(specUnits().slice(0, 1)), specUnits());
		expect(builtOf(first)!.units.map((u) => u.name)).toEqual(["Mark"]);
		const moved = recordBuilt(first, asUnits([{ name: "Other", script: "A.ssl", nodes: ["n4"] }]), specUnits());
		expect(unitsOfNode(moved, "n4").map((u) => u.name)).toEqual(["Other"]);
	});
	test("a plan with nothing readable under built has nothing built", () => {
		expect(builtOf(plan())).toBeNull();
		expect(builtOf({ ...plan(), built: "oops" })).toBeNull();
		expect(builtOf({ ...plan(), built: { units: [{ nope: 1 }], nodes: {} } })).toBeNull();
		expect(changesSince(plan())).toEqual({ changed: [], added: [], removed: [] });
	});
	test("settling covers what the spec only described, and forgets removed nodes", () => {
		const p = built();
		const removed = { ...p, nodes: p.nodes.filter((n) => n.id !== "n5"), edges: p.edges.filter((e) => e.from !== "n5" && e.to !== "n5") };
		const settled = settleBuilt(removed, runOf(removed, [], [{ node: "n1", becomes: "parameters" }]));
		expect(builtOf(settled)!.nodes.n5).toBeUndefined();
		expect(builtOf(settled)!.units.find((u) => u.name === "Notify")!.nodes).toEqual([]);
		expect(builtOf(settled)!.nodes.n1).toBe(nodePrint(removed, "n1"));
	});
});

describe("what changed on the chart", () => {
	test("nothing, straight after a build", () => {
		expect(anyChanges(changesSince(built()))).toBe(false);
	});
	test("words, notes and a way out each count; a group or an answer does not", () => {
		const p = built();
		expect(changesSince(setText(p, "n4", "Mark it")).changed).toEqual(["n4"]);
		expect(changesSince({ ...p, nodes: p.nodes.map((n) => (n.id === "n5" ? { ...n, notes: "by email" } : n)) }).changed).toEqual(["n5"]);
		expect(changesSince({ ...p, edges: p.edges.map((e) => (e.from === "n4" ? { ...e, to: "n6" } : e)) }).changed).toEqual(["n4"]);
		expect(changesSince({ ...p, decisions: [{ question: "How?", node: "n5" }] }).changed).toEqual([]);
		expect(changesSince({ ...p, decisions: [{ question: "How?", node: "n5", answer: "Leave it" }] }).changed).toEqual([]);
		expect(changesSince({ ...p, nodes: p.nodes.map((n) => (n.id === "n5" ? { ...n, group: "g1" } : n)) }).changed).toEqual([]);
	});
	test("a new node and a removed one", () => {
		const p = built();
		const c = changesSince({ ...p, nodes: [...p.nodes.filter((n) => n.id !== "n5"), { id: "n7", kind: "step", text: "Log it" }] });
		expect(c.added).toEqual(["n7"]);
		expect(c.removed).toEqual(["n5"]);
	});
	test("a run of this very chart is not a change, while it is still being reviewed", () => {
		const first = recordBuilt(plan(), asUnits(specUnits().slice(0, 1)), specUnits());
		expect(anyChanges(changesSince(first))).toBe(true);
		expect(anyChanges(chartChanges(first, runOf(first)))).toBe(false);
		const later = setText(first, "n4", "Mark it");
		expect(chartChanges(later, runOf(first)).changed).toEqual(["n4"]);
	});
	test("untouched built nodes need not be said again in a spec", () => {
		const p = setText(built(), "n4", "Mark it");
		expect(unaccounted(p, [], [], settledNodes(p)).map((n) => n.id)).toEqual(["n4"]);
		expect(unaccounted(p, [], [{ node: "n4", becomes: "the update" }], settledNodes(p))).toEqual([]);
	});
});

describe("only what changed is rebuilt", () => {
	const statuses = (run: BuildRun) => Object.fromEntries(run.units.map((u) => [u.name, u.change ? "change" : u.status]));
	test("a changed node's unit is an edit, the others are kept, listed in the spec or not", () => {
		const p = setText(built(), "n4", "Mark it, in a transaction");
		const run = runOf(p, [specUnits()[0]!]);
		classifyUnits(run, p);
		expect(statuses(run)).toEqual({ Mark: "change", Notify: "kept", Release: "kept" });
		expect(nextUnit(run)!.name).toBe("Mark");
	});
	test("a unit the agent lists needlessly is kept: SSL Studio decides, not the agent", () => {
		const p = setText(built(), "n4", "Mark it");
		const run = runOf(p);
		classifyUnits(run, p);
		expect(statuses(run)).toEqual({ Mark: "change", Notify: "kept", Release: "kept" });
	});
	test("a new unit is new; a touched unit the spec leaves out is left alone, as the prompt promises", () => {
		const b = built();
		const p: Plan = { ...b, nodes: [...b.nodes, { id: "n7", kind: "step", text: "Log it" }], edges: [...b.edges.filter((e) => e.from !== "n5"), { from: "n5", to: "n7" }, { from: "n7", to: "n6" }] };
		const run = runOf(p, [{ name: "LogIt", script: "Sample/Release.ssl", nodes: ["n7"] }]);
		classifyUnits(run, p);
		expect(statuses(run)).toEqual({ LogIt: "pending", Mark: "kept", Notify: "kept", Release: "kept" });
	});
	test("a new parameter or a new call needs an edit too", () => {
		const b = built();
		for (const unit of [{ ...specUnits()[0]!, parameters: ["sId", "nMore"] }, { ...specUnits()[0]!, calls: ["Notify"] }]) {
			const run = runOf(b, [unit]);
			classifyUnits(run, b);
			expect(statuses(run).Mark).toBe("change");
		}
	});
	test("a procedure moved by hand is edited where it is now", () => {
		const p = setText(built(), "n4", "Mark it");
		const run = runOf(p, [specUnits()[0]!]);
		classifyUnits(run, p, { Mark: "Elsewhere.ssl" });
		expect(run.units[0]!.script).toBe("Elsewhere.ssl");
	});
	test("kept units count as built for the chart, and first builds are left alone", () => {
		const p = setText(built(), "n4", "Mark it");
		const run = runOf(p, [specUnits()[0]!], [{ node: "n1", becomes: "x" }]);
		classifyUnits(run, p);
		expect(nodeStatuses(run).get("n5")).toBe("kept");
		expect(unbuiltNodes(p, run)).toEqual(["Mark it"]);
	});
	test("a node settled earlier with no unit of its own stays accounted for", () => {
		const first = recordBuilt(plan(), asUnits(specUnits().slice(0, 1)), specUnits());
		const settled = settleBuilt(first, runOf(first, [], plan().nodes.map((n) => ({ node: n.id, becomes: "x" }))));
		const p = setText(settled, "n4", "Mark it");
		const run = runOf(p, [specUnits()[0]!]);
		classifyUnits(run, p);
		run.units[0]!.status = "passed";
		expect(unbuiltNodes(p, run)).toEqual([]);
	});
	test("a first build is left alone", () => {
		const fresh = runOf(plan());
		classifyUnits(fresh, plan());
		expect(fresh.units.map((u) => u.status)).toEqual(["pending", "pending", "pending"]);
	});
});

describe("editing a procedure where it stands", () => {
	// As the server's syntax tree has it: a procedure starts at its keyword, its doc comment is a node before it.
	const text = "/* banner;\n\n/* region V;\n\n/*\n    Mark it.\n;\n:PROCEDURE Mark;\n:RETURN 1;\n:ENDPROC;\n\n/* Keep me;\n\n:PROCEDURE Notify;\n:RETURN 2;\n:ENDPROC;\n/* endregion;\n";
	const r = (a: number, b: number) => ({ range: { start: { line: a, character: 0 }, end: { line: b, character: 9 } } });
	const tree = [
		{ kind: "banner", ...r(0, 0) },
		{ kind: "blankLines", ...r(1, 1) },
		{ kind: "region", name: "V", ...r(2, 16), children: [{ kind: "blankLines", ...r(3, 3) }, { kind: "docBlock", ...r(4, 6) }, { kind: "procedure", name: "Mark", ...r(7, 9) }, { kind: "blankLines", ...r(10, 10) }, { kind: "comment", ...r(11, 11) }, { kind: "blankLines", ...r(12, 12) }, { kind: "procedure", name: "Notify", ...r(13, 15) }] },
	];
	const spans = procedureSpans(tree);
	test("a procedure's span takes the doc comment directly above it, and no comment further off", () => {
		expect(spans).toEqual([{ name: "Mark", startLine: 4, endLine: 9 }, { name: "Notify", startLine: 13, endLine: 15 }]);
		expect(procedureText(text, spans, "mark")).toBe("/*\n    Mark it.\n;\n:PROCEDURE Mark;\n:RETURN 1;\n:ENDPROC;");
		expect(procedureText(text, spans, "Gone")).toBeNull();
	});
	test("only that procedure's lines change", () => {
		const unit: BuildUnit = { name: "Mark", status: "passed", attempts: 1, change: true, code: "/* New;\n:PROCEDURE Mark;\n:RETURN 9;\n:ENDPROC;" };
		const out = assembleScript(text, "", [unit], plan(), spans);
		expect(out).toBe(text.replace("/*\n    Mark it.\n;\n:PROCEDURE Mark;\n:RETURN 1;\n:ENDPROC;", unit.code!));
	});
	test("two edits and a new unit, whichever order they come in", () => {
		const units: BuildUnit[] = [
			{ name: "Notify", status: "passed", attempts: 1, change: true, code: ":PROCEDURE Notify;\n:RETURN 22;\n:ENDPROC;" },
			{ name: "Fresh", status: "passed", attempts: 1, code: ":PROCEDURE Fresh;\n:ENDPROC;" },
			{ name: "Mark", status: "passed", attempts: 1, change: true, code: ":PROCEDURE Mark;\n:RETURN 11;\n:ENDPROC;" },
		];
		const out = assembleScript(text, "", units, plan(), spans);
		expect(out).toContain("/* Keep me;\n\n:PROCEDURE Notify;\n:RETURN 22;");
		expect(out).toContain("/* region V;\n\n:PROCEDURE Mark;\n:RETURN 11;");
		expect(out).not.toContain("Mark it.");
		expect(out.endsWith("/* endregion;\n\n:PROCEDURE Fresh;\n:ENDPROC;\n")).toBe(true);
	});
	test("a procedure taken away by hand is added, not lost", () => {
		const unit: BuildUnit = { name: "Gone", status: "passed", attempts: 1, change: true, code: ":PROCEDURE Gone;\n:ENDPROC;" };
		expect(assembleScript(text, "", [unit], plan(), spans)).toContain(":PROCEDURE Gone;");
	});
	test("kept units are not reprinted, having no code", () => {
		expect(assembleScript(text, "", [{ name: "Mark", status: "kept", attempts: 0 }], plan(), spans)).toBe(text);
	});
	test("a new script still gets its banner", () => {
		expect(assembleScript(null, "/* Banner;", [{ name: "A", status: "passed", attempts: 1, code: ":PROCEDURE A;\n:ENDPROC;" }], plan())).toBe("/* Banner;\n\n:PROCEDURE A;\n:ENDPROC;\n");
	});
});

describe("drift", () => {
	const reading = (over: Partial<Record<string, Reading["edges"]>> = {}): Reading => ({
		name: "Sample.Release",
		procedures: [{ name: "Mark", line: 1 }, { name: "Release", line: 9 }],
		edges: over.edges ?? [
			{ from: "Release", target: "Mark", resolved: true },
			{ from: "Release", target: "Sample.Other.Notify", resolved: true },
			{ from: "Release", target: "Regions.IsUsableId", resolved: true },
		],
	});
	const other: Reading = { name: "Sample.Other", procedures: [{ name: "Notify", line: 1 }], edges: [] };
	const readings = (main = reading()) => new Map<string, Reading | null>([["Sample/Release.ssl", main], ["Sample/Other.ssl", other]]);
	test("nothing to report when the code says what the chart says", () => {
		expect(driftOf(built(), readings())).toEqual([]);
	});
	test("a chart's edge is order, not a call: Mark then Notify does not mean Mark calls Notify", () => {
		expect(driftOf(built(), readings()).some((d) => d.kind === "missing-call")).toBe(false);
	});
	test("a procedure gone is marked on the first node it carried", () => {
		const main = { ...reading(), procedures: [{ name: "Release", line: 9 }] };
		const found = driftOf(built(), readings(main));
		expect(found[0]).toMatchObject({ kind: "gone", unit: "Mark", node: "n4", severity: "warning" });
		expect(found[0]!.message).toBe('The chart\'s "Mark released" was built as Mark in Sample/Release.ssl, and that procedure has gone.');
	});
	test("a script that cannot be read is gone too", () => {
		expect(driftOf(built(), new Map([["Sample/Release.ssl", null], ["Sample/Other.ssl", other]])).map((d) => d.kind)).toEqual(["gone", "gone"]);
	});
	test("a call the code no longer makes, in the chart's words", () => {
		const main = reading({ edges: [{ from: "Release", target: "Mark", resolved: true }, { from: "Release", target: "Regions.IsUsableId", resolved: true }] });
		expect(driftOf(built(), readings(main)).map((d) => d.message)).toEqual(["The chart says Release calls Notify; the code does not."]);
	});
	test("a call node is read from the chart as it is now", () => {
		const main = reading({ edges: [{ from: "Release", target: "Mark", resolved: true }, { from: "Release", target: "Sample.Other.Notify", resolved: true }] });
		const found = driftOf(built(), readings(main));
		expect(found).toMatchObject([{ kind: "missing-call", node: "n2" }]);
		const off = { ...built(), nodes: built().nodes.filter((n) => n.id !== "n2") };
		expect(driftOf(off, readings(main))).toEqual([]);
	});
	test("a call the chart does not show is a note, and only for what resolves", () => {
		const main = reading({ edges: [...reading().edges, { from: "Release", target: "Audit", resolved: true }, { from: "Release", target: "Typo", resolved: false }] });
		expect(driftOf(built(), readings(main))).toMatchObject([{ kind: "extra-call", severity: "info", message: "Release also calls Audit, which the chart does not show." }]);
	});
	test("a procedure moved is a note, and is still compared", () => {
		const moved = new Map<string, Reading | null>([["Sample/Release.ssl", { ...reading(), procedures: [{ name: "Release", line: 1 }] }], ["Sample/Other.ssl", other], ["Elsewhere.ssl", { name: "Elsewhere", procedures: [{ name: "Mark", line: 3 }], edges: [] }]]);
		expect(driftOf(built(), moved, { Mark: "Elsewhere.ssl" })).toMatchObject([{ kind: "moved", severity: "info", message: "Mark is now in Elsewhere.ssl; the chart recorded Sample/Release.ssl." }]);
	});
	test("a procedure with no steps left is said so, and is not removed", () => {
		const p = built();
		const off = { ...p, nodes: p.nodes.filter((n) => n.id !== "n4"), edges: p.edges };
		expect(driftOf(off, readings())).toMatchObject([{ kind: "orphan", unit: "Mark" }]);
	});
	test("becomes findings on the node, as anything else on the chart", () => {
		const main = { ...reading(), procedures: [{ name: "Release", line: 9 }] };
		expect(driftFindings(driftOf(built(), readings(main)))[0]).toMatchObject({ severity: "warning", code: "plan-drift-gone", node: "n4" });
	});
});

describe("prompts for a change", () => {
	test("a spec's says what is built, what changed, and to list only what must change", () => {
		const p = setText(built(), "n4", "Mark it");
		const text = revisionText({ ...p, nodes: [...p.nodes.filter((n) => n.id !== "n5"), { id: "n7", kind: "step", text: "Log it", notes: "Always." }] }, "THE OLD SPEC")!;
		for (const part of ["ALREADY BUILT", "Mark(sId) in Sample/Release.ssl", "n4: Mark it", "n7: Log it (Always.)", "NODES REMOVED: n5", "only the procedures to write or change", "THE OLD SPEC"]) expect(text).toContain(part);
		expect(revisionText(plan(), "x")).toBeUndefined();
	});
	test("the plan shown in a spec's prompt does not carry the record of the build", () => {
		expect(specPrompt(built(), "s", { codeLines: 400 })).not.toContain('"built"');
	});
	test("a unit's shows the code as it stands and what changed for it", () => {
		const p = setText(built(), "n4", "Mark it");
		const unit: BuildUnit = { ...specUnits()[0]!, status: "pending", attempts: 0, change: true };
		const text = unitPrompt(p, "s", unit, [], "c", "", changeText(p, unit, "THE CODE AS IT IS"));
		for (const part of ["Mark ALREADY EXISTS", "THE CODE AS IT IS", "n4: Mark it", "whole of this procedure"]) expect(text).toContain(part);
		expect(text).not.toContain("n5:");
	});
	test("a second opinion on part of a chart is told so", () => {
		const text = reviewPrompt(plan(), "s", [], ["n4"]);
		expect(text).toContain("already built");
		expect(text).toContain("Mark released");
		expect(text).not.toContain("Tell the lab");
	});
});

describe("paths through the chart", () => {
	test("one for each way through a decision", () => {
		const { paths, truncated } = planPaths(plan());
		expect(truncated).toBe(false);
		expect(paths.map((p) => p.steps.map((s) => s.id).join(">"))).toEqual(["n1>n2>n3>n4>n5>n6", "n1>n2>n3>n6"]);
		expect(pathLine(paths[1]!, 1)).toBe("Path 2: A sample id arrives -> Check the id -> Usable? -> (no) Return");
	});
	test("a loop is taken once, and does not go on for ever", () => {
		const p: Plan = { ...plan(), edges: [...plan().edges.filter((e) => e.from !== "n5"), { from: "n5", to: "n3" }] };
		expect(planPaths(p).paths.map((x) => x.steps.map((s) => s.id).join(">"))).toEqual(["n1>n2>n3>n4>n5>n3>n6", "n1>n2>n3>n6"]);
	});
	test("stops at a limit, and says so", () => {
		const nodes: Plan["nodes"] = [{ id: "s", kind: "start", text: "s" }, { id: "e", kind: "end", text: "e" }];
		const edges: Plan["edges"] = [];
		let last = "s";
		for (let i = 0; i < 6; i++) {
			nodes.push({ id: `d${i}`, kind: "decision", text: `d${i}` }, { id: `a${i}`, kind: "step", text: `a${i}` }, { id: `b${i}`, kind: "step", text: `b${i}` });
			edges.push({ from: last, to: `d${i}` }, { from: `d${i}`, to: `a${i}`, label: "a" }, { from: `d${i}`, to: `b${i}`, label: "b" });
			const next = i === 5 ? "e" : `j${i}`;
			if (i < 5) nodes.push({ id: next, kind: "step", text: next });
			edges.push({ from: `a${i}`, to: next }, { from: `b${i}`, to: next });
			last = next;
		}
		const found = planPaths({ ...plan(), nodes, edges }, 24);
		expect(found.paths.length).toBe(24);
		expect(found.truncated).toBe(true);
	});
	test("a chart with no start has no paths", () => {
		expect(planPaths({ ...plan(), nodes: plan().nodes.filter((n) => n.kind !== "start") }).paths).toEqual([]);
	});
	test("a script is asked about every path it does not mention", () => {
		expect(pathsMissing("/* Path 1: x;\n/* path 3: y;", 3)).toEqual([2]);
		expect(pathsMissing("/* Path 10: x;", 1)).toEqual([1]);
	});
	test("the prompt carries the paths, the code and how to call it, and says nothing runs here", () => {
		const text = testsPrompt(plan(), "ReleaseTests.ssl", planPaths(plan()).paths, [{ name: "Mark", callAs: "Sample.Release.Mark", text: "CODE" }], "SPEC");
		for (const part of ["PLAN STAGE: tests", "ReleaseTests.ssl", "ssl-unit-test", "Path 1: A sample id", "CODE", 'ExecFunction("Sample.Release.Mark"', "SPEC", "cannot run anything"]) expect(text).toContain(part);
	});
	test("the tests' file is remembered against the chart it was written from", () => {
		const p = recordTests(built(), "Sample/ReleaseTests.ssl");
		expect(builtOf(p)!.tests).toEqual({ script: "Sample/ReleaseTests.ssl", hash: planHash(plan()) });
	});
});
