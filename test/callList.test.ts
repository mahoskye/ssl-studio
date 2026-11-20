import { expect, test } from "bun:test";
import { assemble, callList, fromCallGraph, procId, TOP_LEVEL, UNRESOLVED, visible } from "../src/view/graph/model";

const scripts = [
	{ path: "/w/Orders.ssl", bytes: 1800, procedures: [{ name: "Count", region: "Queries", startLine: 28, endLine: 42 }, { name: "Title", startLine: 50, endLine: 70 }] },
	{ path: "/w/Report.ssl", bytes: 900, procedures: [{ name: "Summary", startLine: 22, endLine: 31 }, { name: "ReportTitle", startLine: 40, endLine: 44 }, { name: "Footer", startLine: 10, endLine: 14 }] },
];
const calls = [
	{ callee: procId("/w/Orders.ssl", "Count"), path: "/w/Report.ssl", line: 26 },
	{ callee: procId("/w/Report.ssl", "ReportTitle"), path: "/w/Report.ssl", line: 27 },
	{ callee: procId("/w/Report.ssl", "ReportTitle"), path: "/w/Report.ssl", line: 29 },
	{ callee: procId("/w/Report.ssl", "ReportTitle"), path: "/w/Report.ssl", line: 12 },
	{ callee: procId("/w/Orders.ssl", "Title"), path: "/w/Orders.ssl", line: 5 },
];

test("the calls shown, by script, then by caller in the script's order, then by callee", () => {
	const g = assemble(scripts, calls);
	const list = callList(g, g.edges);
	expect(list.map((s) => s.path)).toEqual(["/w/Orders.ssl", "/w/Report.ssl"]);
	expect(list[1]!.callers.map((c) => c.name)).toEqual(["Footer", "Summary"]);
	expect(list[1]!.callers[1]!.calls.map((c) => [c.name, c.crossScript, c.count])).toEqual([
		["Count", true, 1],
		["ReportTitle", false, 2],
	]);
});

test("a call from outside every procedure is the script's top level, and opens at its first line", () => {
	const g = assemble(scripts, calls);
	const top = callList(g, g.edges)[0]!.callers[0]!;
	expect(top).toMatchObject({ name: TOP_LEVEL, kind: "top", path: "/w/Orders.ssl", line: 0 });
	expect(top.calls.map((c) => c.name)).toEqual(["Title"]);
});

test("every call shown is in the list once, and none that is filtered out", () => {
	const g = assemble(scripts, calls);
	const count = (edges: typeof g.edges) => callList(g, edges).flatMap((s) => s.callers.flatMap((c) => c.calls)).length;
	expect(count(g.edges)).toBe(g.edges.length);
	const cross = visible(g, { mode: "cross", depth: 1 }).edges;
	expect(count(cross)).toBe(1);
	expect(callList(g, cross)[0]!.callers[0]!.calls[0]).toMatchObject({ name: "Count", path: "/w/Orders.ssl", line: 28 });
	expect(callList(g, [])).toEqual([]);
});

test("a data source and a target the server could not resolve say what they are", () => {
	const at = (line: number) => ({ uri: "file:///w/A.ssl", range: { start: { line, character: 0 }, end: { line: line + 3, character: 0 } } });
	const g = fromCallGraph(
		{
			nodes: [
				{ id: "s", kind: "script", name: "A.ssl", location: at(0) },
				{ id: "p", kind: "procedure", name: "Load", container: "file:///w/A.ssl", location: at(4) },
				{ id: "d", kind: "dataSource", name: "Samples", location: { ...at(0), uri: "file:///w/Samples.sql" } },
				{ id: "u", kind: "unresolved", name: "Missing" },
			],
			edges: [
				{ from: "p", to: "d", kind: "RunDS", resolved: true, location: at(5) },
				{ from: "p", to: "u", kind: "DoProc", resolved: false, location: at(6) },
			],
		},
		(uri) => uri.replace("file://", ""),
	);
	const calls = callList(g, g.edges)[0]!.callers[0]!.calls;
	expect(calls.map((c) => [c.name, c.kind, c.path])).toEqual([
		["Missing", "unresolved", UNRESOLVED],
		["Samples", "datasource", "/w/Samples.sql"],
	]);
});

test("a class relation says what it is, and a class is named as one", () => {
	const at = (file: string, line: number) => ({ uri: `file:///w/${file}.ssl`, range: { start: { line, character: 0 }, end: { line: line + 3, character: 0 } } });
	const g = fromCallGraph(
		{
			nodes: [
				{ id: "rules", kind: "script", name: "DueDates.DueRules", location: at("DueRules", 0) },
				{ id: "for", kind: "procedure", name: "RuleFor", container: "file:///w/DueRules.ssl", location: at("DueRules", 4) },
				{ id: "due", kind: "script", name: "DueDates.DueRule", isClass: true, location: at("DueRule", 0) },
				{ id: "date", kind: "procedure", name: "DueDate", container: "file:///w/DueRule.ssl", location: at("DueRule", 9) },
				{ id: "rush", kind: "script", name: "DueDates.RushDueRule", isClass: true, location: at("RushDueRule", 0) },
			],
			edges: [
				{ from: "for", to: "due", kind: "CreateUdObject", resolved: true, location: at("DueRules", 5) },
				{ from: "for", to: "date", kind: "Method", resolved: true, location: at("DueRules", 6) },
				{ from: "for", to: "date", kind: "ExecFunction", resolved: true, location: at("DueRules", 7) },
				{ from: "rush", to: "due", kind: "Inherit", resolved: true, location: at("RushDueRule", 1) },
			],
		},
		(uri) => uri.replace("file://", ""),
	);
	expect(g.scripts.map((s) => s.name)).toEqual(["DueDates.DueRule", "DueDates.DueRules", "DueDates.RushDueRule"]);
	const list = callList(g, g.edges);
	const from = (path: string) => list.find((s) => s.path === path)!.callers[0]!;
	// The same procedure reached by a call and by a method call is listed twice: they say different things.
	expect(from("/w/DueRules.ssl").calls.map((c) => [c.relation, c.name, c.kind])).toEqual([
		["call", "DueDate", "procedure"],
		["method", "DueDate", "procedure"],
		["creates", "DueDates.DueRule", "class"],
	]);
	// The class that inherits is named as a class too, not as code outside a procedure.
	const rush = from("/w/RushDueRule.ssl");
	expect([rush.name, rush.kind]).toEqual(["DueDates.RushDueRule", "class"]);
	expect(rush.calls.map((c) => [c.relation, c.name, c.path])).toEqual([["inherits", "DueDates.DueRule", "/w/DueRule.ssl"]]);
});

test("a script that is not a class keeps its top level", () => {
	const g = assemble([{ path: "/w/A.ssl", bytes: 1, procedures: [{ name: "P", startLine: 2, endLine: 4 }] }], [{ callee: procId("/w/A.ssl", "P"), path: "/w/A.ssl", line: 0 }]);
	const top = callList(g, g.edges)[0]!.callers[0]!;
	expect([top.name, top.kind]).toEqual([TOP_LEVEL, "top"]);
	expect(top.calls[0]!.relation).toBe("call");
});
