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

import { choices, matching } from "../src/view/graph/model";

describe("finding a node by name", () => {
	const node = (name: string, path: string, kind?: "procedure" | "datasource" | "unresolved") => ({ id: `${path}#${name}`, name, path, line: 0, kind });
	const graph = { nodes: [node("Run", "/w/B.ssl"), node("calc", "/w/A.ssl"), node("Run", "/w/A.ssl"), node("Samples", "/w/Samples.ds", "datasource"), node("Gone", "(unresolved)", "unresolved")] };
	const list = choices(graph, (path) => path.replace("/w/", ""));

	test("each procedure and data source is listed once, by name then script; what did not resolve is not", () => {
		expect(list.map((c) => `${c.name} in ${c.where}`)).toEqual(["calc in A.ssl", "Run in A.ssl", "Run in B.ssl", "Samples in Samples.ds"]);
		expect(list[1]!.id).toBe("/w/A.ssl#Run");
	});

	test("the matches are the names with the typed text in them, those that start with it first", () => {
		const names = [{ name: "PlanDueDate" }, { name: "DueDate" }, { name: "Due" }, { name: "Other" }];
		expect(matching(names, "due").map((c) => c.name)).toEqual(["DueDate", "Due", "PlanDueDate"]);
		expect(matching(names, " DUE ", 2).map((c) => c.name)).toEqual(["DueDate", "Due"]);
		expect(matching(names, "")).toEqual([]);
		expect(matching(names, "zzz")).toEqual([]);
	});
});

describe("around a focus", () => {
	const edge = (from: string, to: string) => ({ from, to, crossScript: false, sites: [] });
	const node = (id: string) => ({ id, name: id, path: "/w/A.ssl", line: 0 });
	// a calls b, b calls c: around b, both ways, or one.
	const graph = { scripts: [], nodes: [node("a"), node("b"), node("c")], edges: [edge("a", "b"), edge("b", "c")], topLevel: [] };
	const around = (direction?: "both" | "callers" | "callees") => [...visible(graph, { mode: "around", focus: "b", depth: 1, direction }).nodes].sort();

	test("what it calls, what calls it, or both", () => {
		expect(around()).toEqual(["a", "b", "c"]);
		expect(around("both")).toEqual(["a", "b", "c"]);
		expect(around("callees")).toEqual(["b", "c"]);
		expect(around("callers")).toEqual(["a", "b"]);
	});

	test("the direction holds at every step of the depth", () => {
		const far = { ...graph, nodes: [...graph.nodes, node("d")], edges: [...graph.edges, edge("c", "d"), edge("d", "a")] };
		expect([...visible(far, { mode: "around", focus: "b", depth: 2, direction: "callees" }).nodes].sort()).toEqual(["b", "c", "d"]);
	});
});

import { keptFolds } from "../src/view/graph/model";

test("what was kept of the folded scripts and folders is read with suspicion", () => {
	expect(keptFolds(JSON.stringify({ scripts: ["/w/A.ssl", 3], folders: ["src"] }))).toEqual({ scripts: ["/w/A.ssl"], folders: ["src"] });
	// Nothing folded is a choice too, and is kept as one.
	expect(keptFolds(JSON.stringify({ scripts: [], folders: [] }))).toEqual({ scripts: [], folders: [] });
	for (const bad of [null, "", "not json", "[]", JSON.stringify({ scripts: "all" }), JSON.stringify({ scripts: [] })]) expect(keptFolds(bad)).toBeNull();
});

import { withoutUnresolved } from "../src/view/graph/model";

test("the targets that did not resolve can be put aside, with the lines to them", () => {
	const node = (id: string, kind?: "unresolved") => ({ id, name: id, path: "/w/A.ssl", line: 0, kind });
	const edge = (from: string, to: string) => ({ from, to, crossScript: false, sites: [] });
	const graph = { nodes: [node("a"), node("b"), node("gone", "unresolved")] };
	const left = withoutUnresolved(graph, { nodes: new Set(["a", "b", "gone"]), edges: [edge("a", "b"), edge("a", "gone"), edge("b", "gone")] });
	expect([...left.nodes]).toEqual(["a", "b"]);
	expect(left.edges.map((e) => [e.from, e.to])).toEqual([["a", "b"]]);
});

import { folderEnd, gather, type GraphEdge } from "../src/view/graph/model";

describe("lines gathered at a folder's edge", () => {
	const edge = (from: string, to: string, kind?: string): GraphEdge => ({ from, to, crossScript: true, sites: [{ path: from, line: 1 }], ...(kind ? { kind } : {}) });
	// Nodes are named folder/name; a name with no folder is drawn outside every folder.
	const folderOf = (id: string) => (id.includes("/") ? id.slice(0, id.indexOf("/")) : undefined);

	test("a node's calls to several nodes of one folder are one line to the folder", () => {
		const out = gather([edge("tests", "app/a"), edge("tests", "app/b"), edge("tests", "app/c"), edge("app/a", "app/b")], folderOf);
		expect(out.map((e) => `${e.from}>${e.to}`)).toEqual([`tests>${folderEnd("app")}`, "app/a>app/b"]);
		expect(out[0]!.tos).toEqual(["app/a", "app/b", "app/c"]);
		expect(out[0]!.sites.length).toBe(3);
	});

	test("fewer than the number that gathers stay as they are, and so do lines inside a folder", () => {
		const edges = [edge("tests", "app/a"), edge("tests", "app/b"), edge("app/a", "app/b"), edge("app/a", "app/c"), edge("app/a", "app/d")];
		expect(gather(edges, folderOf)).toEqual(edges);
	});

	test("several nodes of a folder that go to one node outside are one line from the folder", () => {
		const out = gather([edge("app/a", "log"), edge("app/b", "log"), edge("app/c", "log")], folderOf);
		expect(out.map((e) => `${e.from}>${e.to}`)).toEqual([`${folderEnd("app")}>log`]);
		expect(out[0]!.froms).toEqual(["app/a", "app/b", "app/c"]);
	});

	test("a call is not gathered with an inheritance", () => {
		const edges = [edge("tests", "app/a"), edge("tests", "app/b"), edge("tests", "app/c", "Inherit")];
		expect(gather(edges, folderOf)).toEqual(edges);
	});

	test("between two folders, lines gathered at one end are gathered at the other", () => {
		const edges = ["x", "y", "z"].flatMap((from) => ["a", "b", "c"].map((to) => edge(`lib/${from}`, `app/${to}`)));
		const out = gather(edges, folderOf);
		expect(out.map((e) => `${e.from}>${e.to}`)).toEqual([`${folderEnd("lib")}>${folderEnd("app")}`]);
		expect(out[0]!.froms).toEqual(["lib/x", "lib/y", "lib/z"]);
		expect(out[0]!.tos).toEqual(["app/a", "app/b", "app/c"]);
		expect(out[0]!.sites.length).toBe(9);
	});

	test("with no folder drawn open, nothing is gathered", () => {
		const edges = [edge("tests", "app/a"), edge("tests", "app/b"), edge("tests", "app/c")];
		expect(gather(edges, () => undefined)).toEqual(edges);
	});
});

import { aroundFocus } from "../src/view/graph/model";

describe("what calls a focus, and what it calls", () => {
	const edge = (from: string, to: string, sites = 1, kind?: string): GraphEdge => ({ from, to, crossScript: true, sites: Array.from({ length: sites }, (_, line) => ({ path: from, line })), ...(kind ? { kind } : {}) });
	const node = (path: string, name: string) => ({ id: `${path}#${name}`, name, path, line: 0 });
	const graph = { scripts: [{ path: "/w/A.ssl", bytes: 0, procedures: [] }, { path: "/w/B.ssl", bytes: 0, procedures: [] }], nodes: [node("/w/A.ssl", "a1"), node("/w/A.ssl", "a2"), node("/w/B.ssl", "b1"), node("/w/B.ssl", "b2")] };
	const edges = [edge("/w/A.ssl#a1", "/w/B.ssl#b1", 3), edge("/w/A.ssl#a2", "/w/B.ssl#b1"), edge("/w/B.ssl#b1", "/w/B.ssl#b2"), edge("/w/B.ssl#b2", "/w/A.ssl#a1", 1, "Method")];

	test("a procedure's callers and callees, each with its places and how it is related", () => {
		const { callers, callees } = aroundFocus(graph, edges, "/w/B.ssl#b1");
		expect(callers.map((c) => [c.other.name, c.count])).toEqual([["a1", 3], ["a2", 1]]);
		expect(callees.map((c) => [c.other.name, c.relation])).toEqual([["b2", "call"]]);
	});

	test("a script's are what comes into it and goes out of it, not what stays inside", () => {
		const { callers, callees } = aroundFocus(graph, edges, "/w/B.ssl#");
		expect(callers.map((c) => `${c.other.name}>${c.own.name}`)).toEqual(["a1>b1", "a2>b1"]);
		expect(callees.map((c) => `${c.own.name}>${c.other.name} ${c.relation}`)).toEqual(["b2>a1 method"]);
	});

	test("a focus nothing calls has no callers", () => {
		expect(aroundFocus(graph, edges, "/w/A.ssl#a2").callers).toEqual([]);
	});
});
