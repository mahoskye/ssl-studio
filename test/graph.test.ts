import { expect, test } from "bun:test";
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

test("a call graph from the server (L2, provisional shape)", () => {
	const r = (l: number) => ({ start: { line: l, character: 0 }, end: { line: l + 5, character: 0 } });
	const g = fromCallGraph(
		{
			nodes: [
				{ id: "s1", kind: "script", name: "Orders", uri: "file:///w/Orders.ssl" },
				{ id: "s2", kind: "script", name: "Report", uri: "file:///w/Report.ssl" },
				{ id: "p1", kind: "procedure", name: "Count", uri: "file:///w/Orders.ssl", range: r(28), region: "Queries" },
				{ id: "p2", kind: "procedure", name: "Summary", uri: "file:///w/Report.ssl", range: r(22) },
				{ id: "d1", kind: "dataSource", name: "Orders.GetOpen", uri: "file:///w/GetOpen.ds" },
				{ id: "u1", kind: "unresolved", name: "Gone.Missing" },
			],
			edges: [
				{ from: "p2", to: "p1", kind: "ExecFunction", uri: "file:///w/Report.ssl", range: r(26), resolved: true },
				{ from: "p1", to: "d1", kind: "RunDS", uri: "file:///w/Orders.ssl", range: r(30), resolved: true },
				{ from: "p2", to: "u1", kind: "DoProc", resolved: false },
				{ from: "s2", to: "s1", kind: ":INCLUDE" },
			],
		},
		(uri) => uri.replace("file://", ""),
	);
	expect(g.nodes.map((n) => `${n.kind}:${n.name}`)).toEqual(["procedure:Count", "procedure:Summary", "datasource:Orders.GetOpen", "unresolved:Gone.Missing"]);
	expect(g.edges.map((e) => e.kind)).toEqual(["ExecFunction", "RunDS", "DoProc", ":INCLUDE"]);
	expect(g.edges.find((e) => e.kind === ":INCLUDE")).toMatchObject({ from: "/w/Report.ssl#", to: "/w/Orders.ssl#" });
	expect(g.topLevel.sort()).toEqual(["/w/Orders.ssl", "/w/Report.ssl"]);
	expect(g.nodes.find((n) => n.name === "Count")!.region).toBe("Queries");
});
