import { describe, expect, test } from "bun:test";
import { fileTier, filterCommands, matchWords, noteUsed, orderCommands, rankFiles, wordStarts } from "../src/view/quickRank";

const rank = (query: string, paths: string[]) => rankFiles(query, paths, (p) => p);

describe("Go to file ranking", () => {
	test("a script comes before the plan of the same name", () => {
		const files = ["design/SetSampleDueDates.plan.json", "Scripts/SetSampleDueDates.ssl", "docs/notes.md"];
		expect(rank("SetSample", files)).toEqual(["Scripts/SetSampleDueDates.ssl", "design/SetSampleDueDates.plan.json"]);
		// The same with the whole name: both are exact matches, the script first.
		expect(rank("setsampleduedates", files)[0]).toBe("Scripts/SetSampleDueDates.ssl");
	});

	test("exact name, then start of name, then a word of it, then anywhere in it", () => {
		const files = ["a/ReleaseOrders.ssl", "a/OrdersRelease.ssl", "a/Orders.ssl", "a/Reorders.ssl", "a/Orders/Other.ssl"];
		expect(rank("orders", files)).toEqual(["a/Orders.ssl", "a/OrdersRelease.ssl", "a/ReleaseOrders.ssl", "a/Reorders.ssl", "a/Orders/Other.ssl"]);
	});

	test("the tiers by number", () => {
		expect(fileTier("Orders.ssl", "x/Orders.ssl")).toBe(0);
		expect(fileTier("orders", "x/Orders.ssl")).toBe(0);
		expect(fileTier("ord", "x/Orders.ssl")).toBe(1);
		expect(fileTier("dates", "x/SetSampleDueDates.ssl")).toBe(2);
		expect(fileTier("ssdd", "x/SetSampleDueDates.ssl")).toBe(2);
		expect(fileTier("due", "x/set_sample_due_dates.ssl")).toBe(2);
		expect(fileTier("ample", "x/SetSampleDueDates.ssl")).toBe(3);
		expect(fileTier("scripts", "Scripts/Orders.ssl")).toBe(4);
		expect(fileTier("sco", "Scripts/Orders.ssl")).toBe(5);
		expect(fileTier("zzz", "Scripts/Orders.ssl")).toBeNull();
	});

	test("among equal matches: scripts, then shorter paths, then the alphabet", () => {
		const files = ["lib/deep/Sample.md", "Sample.json", "lib/deep/Sample.ssl", "b/Sample.srvscr", "a/Sample.ds", "Sample.ssl.txt"];
		expect(rank("sample", files)).toEqual(["a/Sample.ds", "Sample.ssl.txt", "b/Sample.srvscr", "lib/deep/Sample.ssl", "Sample.json", "lib/deep/Sample.md"]);
	});

	test("a folder in the query narrows to that folder", () => {
		const files = ["design/Set.plan.json", "Scripts/Set.ssl", "Scripts/Other.ssl"];
		expect(rank("design/set", files)).toEqual(["design/Set.plan.json"]);
		expect(rank("scripts/", files)).toEqual(["Scripts/Set.ssl", "Scripts/Other.ssl"]);
		expect(rank("Scripts\\Set", ["Scripts\\Set.ssl"])).toEqual(["Scripts\\Set.ssl"]);
	});

	test("no query lists everything, scripts first; the limit holds", () => {
		expect(rank("", ["b.md", "a.ssl"])).toEqual(["a.ssl", "b.md"]);
		expect(rankFiles("", ["a.ssl", "b.ssl", "c.ssl"], (p) => p, 2)).toHaveLength(2);
	});

	test("where the words of a name begin", () => {
		expect(wordStarts("SetSampleDueDates")).toEqual([0, 3, 9, 12]);
		expect(wordStarts("set_sample-due.dates")).toEqual([0, 4, 11, 15]);
		expect(wordStarts("SQLQuery2Run")).toEqual([0, 3, 8, 9]);
	});
});

describe("the command list", () => {
	const commands = [
		{ id: "save", label: "Save" },
		{ id: "blocks", label: "Toggle blocks view", detail: "A plan shows its chart; Markdown shows rendered" },
		{ id: "explorer", label: "Show Explorer" },
		{ id: "agent", label: "Show Agent" },
		{ id: "move-panel", label: "Move left panel to the right" },
	];

	test("recently used first, newest first, then the alphabet", () => {
		const { list, recent } = orderCommands(commands, ["explorer", "save", "gone"]);
		expect(list.map((c) => c.id)).toEqual(["explorer", "save", "move-panel", "agent", "blocks"]);
		expect(recent).toBe(2);
		expect(orderCommands(commands, []).list.map((c) => c.label)).toEqual(["Move left panel to the right", "Save", "Show Agent", "Show Explorer", "Toggle blocks view"]);
	});

	test("the last ten used are kept, without repeats", () => {
		let recent: string[] = [];
		for (const id of ["a", "b", "a", "c"]) recent = noteUsed(recent, id);
		expect(recent).toEqual(["c", "a", "b"]);
		for (let i = 0; i < 12; i++) recent = noteUsed(recent, `n${i}`);
		expect(recent).toHaveLength(10);
		expect(recent[0]).toBe("n11");
	});

	test("words match in any order", () => {
		expect(matchWords("panel left", "Move left panel to the right")).toBeGreaterThan(0);
		expect(matchWords("left panel", "Move left panel to the right")).toBe(matchWords("panel left", "Move left panel to the right"));
		expect(matchWords("panel up", "Move left panel to the right")).toBe(0);
		expect(matchWords("", "Save")).toBeGreaterThan(0);
		expect(matchWords("  ", "Save")).toBeGreaterThan(0);
	});

	test("the start of a word beats the middle of one, which beats the second line", () => {
		const start = matchWords("ex", "Show Explorer");
		const middle = matchWords("plor", "Show Explorer");
		const second = matchWords("chart", "Toggle blocks view", "A plan shows its chart");
		expect(start).toBeGreaterThan(middle);
		expect(middle).toBeGreaterThan(second);
		expect(second).toBeGreaterThan(0);
	});

	test("filtering keeps the given order among equal matches", () => {
		const { list } = orderCommands(commands, ["explorer"]);
		// "Show…" twice in the order given; "shows" in a second line comes last.
		expect(filterCommands("show", list).map((c) => c.id)).toEqual(["explorer", "agent", "blocks"]);
		expect(filterCommands("markdown", list).map((c) => c.id)).toEqual(["blocks"]);
		expect(filterCommands("  ", list)).toEqual(list);
		expect(filterCommands("nothing here", list)).toEqual([]);
	});
});
