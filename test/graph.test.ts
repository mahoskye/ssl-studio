import { describe, expect, test } from "bun:test";
import { assemble, procId, visible } from "../src/view/graph/model";

const scripts = [
	{ path: "/w/Orders.ssl", bytes: 1800, procedures: [{ name: "Count", region: "Queries", startLine: 28, endLine: 42 }, { name: "Title", startLine: 50, endLine: 70 }] },
	{ path: "/w/Report.ssl", bytes: 900, procedures: [{ name: "Summary", startLine: 22, endLine: 31 }, { name: "ReportTitle", startLine: 40, endLine: 44 }] },
];
const calls = [
	{ callee: procId("/w/Orders.ssl", "Count"), path: "/w/Report.ssl", line: 26 },
	{ callee: procId("/w/Report.ssl", "ReportTitle"), path: "/w/Report.ssl", line: 27 },
	{ callee: procId("/w/Report.ssl", "ReportTitle"), path: "/w/Report.ssl", line: 29 },
	{ callee: procId("/w/Orders.ssl", "Title"), path: "/w/Orders.ssl", line: 5 },
];

test("call sites become edges from their procedures", () => {
	const g = assemble(scripts, calls);
	expect(g.nodes.map((n) => n.name)).toEqual(["Count", "Title", "Summary", "ReportTitle"]);
	const summary = procId("/w/Report.ssl", "Summary");
	expect(g.edges.find((e) => e.to === procId("/w/Orders.ssl", "Count"))).toEqual({ from: summary, to: procId("/w/Orders.ssl", "Count"), crossScript: true, sites: [{ path: "/w/Report.ssl", line: 26 }] });
	expect(g.edges.find((e) => e.to.endsWith("ReportTitle"))!.sites.length).toBe(2);
	expect(g.topLevel).toEqual(["/w/Orders.ssl"]);
});

test("filters", () => {
	const g = assemble(scripts, calls);
	expect(visible(g, { mode: "cross", depth: 1 }).edges.length).toBe(1);
	const around = visible(g, { mode: "around", focus: procId("/w/Orders.ssl", "Count"), depth: 1 });
	expect([...around.nodes].sort()).toEqual([procId("/w/Orders.ssl", "Count"), procId("/w/Report.ssl", "Summary")]);
	const two = visible(g, { mode: "around", focus: procId("/w/Orders.ssl", "Count"), depth: 2 });
	expect(two.nodes.has(procId("/w/Report.ssl", "ReportTitle"))).toBe(true);
	const script = visible(g, { mode: "around", focus: "/w/Report.ssl#", depth: 1 });
	expect(script.nodes.has(procId("/w/Orders.ssl", "Count"))).toBe(true);
	expect(script.nodes.has(procId("/w/Report.ssl", "ReportTitle"))).toBe(true);
});

import { fromCallGraph } from "../src/view/graph/model";

test("a call graph from ssl/callGraph (shape version 1)", () => {
	const loc = (uri: string, l: number) => ({ uri, range: { start: { line: l, character: 0 }, end: { line: l + 5, character: 0 } } });
	const O = "file:///w/Orders.ssl";
	const R = "file:///w/Report.ssl";
	const g = fromCallGraph(
		{
			nodes: [
				{ id: O, kind: "script", name: "Sample.Orders", location: loc(O, 0) },
				{ id: R, kind: "script", name: "Sample.Report", location: loc(R, 0) },
				{ id: `${O}#count`, kind: "procedure", name: "Count", container: O, regions: ["Queries"], location: loc(O, 28) },
				{ id: `${R}#summary`, kind: "procedure", name: "Summary", container: R, location: loc(R, 22) },
				{ id: "file:///w/GetOpen.ds", kind: "dataSource", name: "Orders.GetOpen", location: loc("file:///w/GetOpen.ds", 0) },
				{ id: "unresolved:Gone.Missing", kind: "unresolved", name: "Gone.Missing" },
			],
			edges: [
				{ from: `${R}#summary`, to: `${O}#count`, kind: "ExecFunction", target: "Sample.Orders.Count", resolved: true, location: loc(R, 26) },
				{ from: `${O}#count`, to: "file:///w/GetOpen.ds", kind: "RunDS", resolved: true, location: loc(O, 30) },
				{ from: `${R}#summary`, to: "unresolved:Gone.Missing", kind: "DoProc", resolved: false, location: loc(R, 27) },
				{ from: R, to: O, kind: "Include", resolved: true, location: loc(R, 1) },
			],
			indexing: false,
		},
		(uri) => uri.replace("file://", ""),
	);
	expect(g.nodes.map((n) => `${n.kind}:${n.name}:${n.path}`)).toEqual([
		"procedure:Count:/w/Orders.ssl",
		"procedure:Summary:/w/Report.ssl",
		"datasource:Orders.GetOpen:/w/GetOpen.ds",
		"unresolved:Gone.Missing:(unresolved)",
	]);
	expect(g.edges.map((e) => e.kind)).toEqual(["ExecFunction", "RunDS", "DoProc", "Include"]);
	expect(g.edges.find((e) => e.kind === "Include")).toMatchObject({ from: "/w/Report.ssl#", to: "/w/Orders.ssl#", sites: [{ path: "/w/Report.ssl", line: 1 }] });
	expect(g.topLevel.sort()).toEqual(["/w/Orders.ssl", "/w/Report.ssl"]);
	expect(g.nodes.find((n) => n.name === "Count")!.region).toBe("Queries");
});

// Classes: the server marks a class file (isClass) and sends class relations as edge kinds (L4).
import { relationOf } from "../src/view/graph/model";

describe("classes in the graph", () => {
	const uri = (name: string) => `file:///w/src/DueDates/${name}.ssl`;
	const toPath = (u: string) => u.replace("file://", "");
	const loc = (name: string) => ({ uri: uri(name), range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } } });
	const nodes = [
		{ id: uri("DueRule"), kind: "script", name: "DueDates.DueRule", isClass: true, location: loc("DueRule") },
		{ id: uri("RushDueRule"), kind: "script", name: "DueDates.RushDueRule", isClass: true, location: loc("RushDueRule") },
		{ id: uri("SetSampleDueDates"), kind: "script", name: "DueDates.SetSampleDueDates", location: loc("SetSampleDueDates") },
	];

	test("a class file is marked as one", () => {
		const g = fromCallGraph({ nodes, edges: [] }, toPath);
		expect(g.scripts.map((s) => [s.path.split("/").pop(), Boolean(s.isClass)])).toEqual([
			["DueRule.ssl", true],
			["RushDueRule.ssl", true],
			["SetSampleDueDates.ssl", false],
		]);
	});

	test("when the server sends class relations, they are read as what they are, beside any call between the same two", () => {
		const g = fromCallGraph(
			{
				nodes,
				edges: [
					{ from: uri("RushDueRule"), to: uri("DueRule"), kind: "Inherit", resolved: true },
					{ from: uri("SetSampleDueDates"), to: uri("DueRule"), kind: "CreateUdObject", resolved: true },
					{ from: uri("SetSampleDueDates"), to: uri("DueRule"), kind: "Method", resolved: true },
					{ from: uri("SetSampleDueDates"), to: uri("DueRule"), kind: "ExecFunction", resolved: true },
				],
			},
			toPath,
		);
		expect(g.edges.map((e) => relationOf(e.kind)).sort()).toEqual(["call", "creates", "inherits", "method"]);
		// An edge between two files lands on their top levels, so each needs that node.
		const inherits = g.edges.find((e) => relationOf(e.kind) === "inherits")!;
		expect([inherits.from, inherits.to]).toEqual([`${toPath(uri("RushDueRule"))}#`, `${toPath(uri("DueRule"))}#`]);
		expect(g.topLevel.sort()).toEqual([toPath(uri("DueRule")), toPath(uri("RushDueRule")), toPath(uri("SetSampleDueDates"))].sort());
	});

	test("the four call kinds, and no kind at all, are calls", () => {
		expect(["DoProc", "ExecFunction", "RunDS", "Include", undefined].map(relationOf)).toEqual(["call", "call", "call", "call", "call"]);
	});
});

import { dirId, fold, foldId, isDir, isFold, scriptOf } from "../src/view/graph/model";

describe("scripts folded to one node", () => {
	const edge = (from: string, to: string, kind = "DoProc", line = 1) => ({ from, to, kind, resolved: true, crossScript: from.split("#")[0] !== to.split("#")[0], sites: [{ path: from.split("#")[0]!, line }] });
	const shown = {
		nodes: new Set(["/w/A.ssl#", "/w/A.ssl#Main", "/w/A.ssl#Help", "/w/B.ssl#Calc", "/w/B.ssl#Round", "/w/C.ssl#Only"]),
		edges: [
			edge("/w/A.ssl#Main", "/w/A.ssl#Help"),
			edge("/w/A.ssl#Main", "/w/B.ssl#Calc", "ExecFunction", 3),
			edge("/w/A.ssl#Help", "/w/B.ssl#Round", "ExecFunction", 9),
			edge("/w/A.ssl#Help", "/w/B.ssl#Calc", "Method", 10),
			edge("/w/B.ssl#Calc", "/w/B.ssl#Round"),
			edge("/w/B.ssl#Calc", "/w/C.ssl#Only", "ExecFunction"),
		],
	};

	test("nothing folded is the picture as it was", () => {
		const drawn = fold(shown, new Set());
		expect([...drawn.nodes].sort()).toEqual([...shown.nodes].sort());
		expect(drawn.edges.map((e) => [e.from, e.to])).toEqual(shown.edges.map((e) => [e.from, e.to]));
		expect(drawn.inside.size).toBe(0);
	});

	test("a folded script is one node, and its calls end at it", () => {
		const drawn = fold(shown, new Set(["/w/B.ssl"]));
		expect([...drawn.nodes].sort()).toEqual(["/w/A.ssl#", "/w/A.ssl#Help", "/w/A.ssl#Main", "/w/C.ssl#Only", foldId("/w/B.ssl")].sort());
		// Help calls two of B's procedures: one line, with both places. Its method call stays a line of its own.
		const out = drawn.edges.filter((e) => e.from === "/w/A.ssl#Help").map((e) => [e.to, relationOf(e.kind), e.sites.length]);
		expect(out).toEqual([
			[foldId("/w/B.ssl"), "call", 1],
			[foldId("/w/B.ssl"), "method", 1],
		]);
		expect(drawn.edges.find((e) => e.from === foldId("/w/B.ssl"))).toMatchObject({ to: "/w/C.ssl#Only", crossScript: true });
		// The call inside B is counted, not drawn.
		expect(drawn.inside.get("/w/B.ssl")).toEqual({ scripts: 0, procedures: 2, calls: 1 });
	});

	test("two folded scripts are joined by one line that keeps every place", () => {
		const drawn = fold(shown, new Set(["/w/A.ssl", "/w/B.ssl", "/w/C.ssl"]));
		expect([...drawn.nodes].sort()).toEqual([foldId("/w/A.ssl"), foldId("/w/B.ssl"), foldId("/w/C.ssl")]);
		const calls = drawn.edges.find((e) => e.from === foldId("/w/A.ssl") && relationOf(e.kind) === "call")!;
		expect([calls.to, calls.sites.map((s) => s.line)]).toEqual([foldId("/w/B.ssl"), [3, 9]]);
		// A's top level is not one of its procedures.
		expect(drawn.inside.get("/w/A.ssl")).toEqual({ scripts: 0, procedures: 2, calls: 1 });
		// The edges given are left as they were.
		expect(shown.edges[1]!.sites.length).toBe(1);
	});

	test("a folded folder is one node for every script in it", () => {
		// A and B are in src; C is in lib. src is folded, and so is A by itself: the folder wins.
		const of = (path: string) => (path === "/w/C.ssl" ? "lib" : "src");
		const drawn = fold(shown, new Set(["/w/A.ssl"]), { folded: new Set(["src"]), of });
		expect([...drawn.nodes].sort()).toEqual(["/w/C.ssl#Only", dirId("src")].sort());
		// Every call between A and B is inside the folder now: five lines, counted, not drawn.
		expect(drawn.inside.get(dirId("src"))).toEqual({ scripts: 2, procedures: 4, calls: 5 });
		expect(drawn.edges.map((e) => [e.from, e.to, e.crossScript])).toEqual([[dirId("src"), "/w/C.ssl#Only", true]]);
		expect([isDir(dirId("src")), isDir(foldId("/w/A.ssl"))]).toEqual([true, false]);
		// A folder that is not folded leaves its scripts as they are.
		expect([...fold(shown, new Set(), { folded: new Set(["lib"]), of }).nodes].filter((id) => id.startsWith("/w/A"))).toHaveLength(3);
	});

	test("an id says which script it is in", () => {
		expect([scriptOf("/w/A.ssl#Main"), scriptOf("/w/A.ssl#"), scriptOf(foldId("/w/A.ssl"))]).toEqual(["/w/A.ssl", "/w/A.ssl", "/w/A.ssl"]);
		expect([isFold(foldId("/w/A.ssl")), isFold("/w/A.ssl#Main")]).toEqual([true, false]);
	});
});
