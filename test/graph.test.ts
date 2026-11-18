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

// Classes: the server marks a class file (isClass) and, once it sends them (L4), class relations as edge kinds.
import { addInheritance, relationOf } from "../src/view/graph/model";

describe("classes in the graph", () => {
	const uri = (name: string) => `file:///w/src/DueDates/${name}.ssl`;
	const toPath = (u: string) => u.replace("file://", "");
	const loc = (name: string) => ({ uri: uri(name), range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } } });
	const nodes = [
		{ id: uri("DueRule"), kind: "script", name: "DueDates.DueRule", isClass: true, location: loc("DueRule") },
		{ id: uri("RushDueRule"), kind: "script", name: "DueDates.RushDueRule", isClass: true, location: loc("RushDueRule") },
		{ id: uri("SetSampleDueDates"), kind: "script", name: "DueDates.SetSampleDueDates", location: loc("SetSampleDueDates") },
	];
	const names = new Map(nodes.map((n) => [n.name, toPath(n.location.uri)]));

	test("a class file is marked as one", () => {
		const g = fromCallGraph({ nodes, edges: [] }, toPath);
		expect(g.scripts.map((s) => [s.path.split("/").pop(), Boolean(s.isClass)])).toEqual([
			["DueRule.ssl", true],
			["RushDueRule.ssl", true],
			["SetSampleDueDates.ssl", false],
		]);
	});

	test("a class inherits its parent: one edge between the two scripts, whatever the case of the name", () => {
		const g = addInheritance(fromCallGraph({ nodes, edges: [] }, toPath), new Map([[toPath(uri("RushDueRule")), "duedates.DUERULE"]]), names);
		expect(g.edges).toEqual([{ from: `${toPath(uri("RushDueRule"))}#`, to: `${toPath(uri("DueRule"))}#`, crossScript: true, sites: [], kind: "Inherit", resolved: true }]);
		expect(relationOf(g.edges[0]!.kind)).toBe("inherits");
		// Both scripts need a top-level node for the edge to land on.
		expect(g.topLevel.sort()).toEqual([toPath(uri("DueRule")), toPath(uri("RushDueRule"))].sort());
	});

	test("a parent outside the workspace, or a class that names itself, adds nothing", () => {
		const base = fromCallGraph({ nodes, edges: [] }, toPath);
		expect(addInheritance(base, new Map([[toPath(uri("RushDueRule")), "Other.Base"]]), names).edges).toEqual([]);
		expect(addInheritance(base, new Map([[toPath(uri("DueRule")), "DueDates.DueRule"]]), names).edges).toEqual([]);
	});

	test("outside a canonical layout the parent is found by the last part of its name, when one script has it", () => {
		const base = fromCallGraph({ nodes, edges: [] }, toPath);
		const flat = new Map([["DueRule", toPath(uri("DueRule"))], ["RushDueRule", toPath(uri("RushDueRule"))]]);
		const parents = new Map([[toPath(uri("RushDueRule")), "DueDates.DueRule"]]);
		expect(addInheritance(base, parents, flat).edges.map((e) => [e.from, e.to])).toEqual([[`${toPath(uri("RushDueRule"))}#`, `${toPath(uri("DueRule"))}#`]]);
		// Two scripts of that name: which one is meant cannot be told, so no line is drawn.
		const two = new Map([...flat, ["Other.DueRule", "/w/other/DueRule.ssl"]]);
		expect(addInheritance(base, parents, two).edges).toEqual([]);
	});

	test("adding the same inheritance twice gives one edge", () => {
		const parents = new Map([[toPath(uri("RushDueRule")), "DueDates.DueRule"]]);
		const once = addInheritance(fromCallGraph({ nodes, edges: [] }, toPath), parents, names);
		expect(addInheritance(once, parents, names).edges.length).toBe(1);
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
	});

	test("the kinds the server sends today are all calls", () => {
		expect(["DoProc", "ExecFunction", "RunDS", "Include", undefined].map(relationOf)).toEqual(["call", "call", "call", "call", "call"]);
	});
});
