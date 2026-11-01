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
