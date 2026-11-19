import { describe, expect, test } from "bun:test";
import { matchesOn, replaceIn, replacementFor, searchPattern } from "../src/shared/searchPattern";
import { landsBefore, movedAcross, ofOpen, othersOf, placed, rightOf, stepped, used, walkHolds, withPin } from "../src/shared/tabOrder";

const found = (text: string, pattern: RegExp) => [...text.matchAll(pattern)].map((match) => match[0]);

describe("what a search looks for", () => {
	test("words as typed are found as typed, in any case unless the case is asked for", () => {
		expect(found("a.b and aXb and A.B", searchPattern("a.b"))).toEqual(["a.b", "A.B"]);
		expect(found("a.b and A.B", searchPattern("a.b", { caseSensitive: true }))).toEqual(["a.b"]);
	});
	test("a regular expression is read as one", () => {
		expect(found("Due1 Due22 Due", searchPattern("Due\\d+", { regex: true }))).toEqual(["Due1", "Due22"]);
		expect(() => searchPattern("(", { regex: true })).toThrow();
	});
	test("a whole word has no letter, digit or underscore beside it", () => {
		expect(found("Due DueDate Is_Due (Due) Due2 due", searchPattern("Due", { wholeWord: true }))).toEqual(["Due", "Due", "due"]);
		expect(found("café cafés", searchPattern("café", { wholeWord: true }))).toEqual(["café"]);
	});
	test("a whole word that begins or ends with a mark is still found", () => {
		expect(found("x := :RETURN; y:RETURN", searchPattern(":RETURN", { wholeWord: true }))).toEqual([":RETURN", ":RETURN"]);
		expect(found("a|b|c a|bc", searchPattern("a|b", { wholeWord: true, regex: true }))).toEqual(["a", "b", "a"]);
	});
});

describe("the order tabs were used in", () => {
	test("a tab used now is first, and once", () => {
		expect(used(["a", "b", "c"], "c")).toEqual(["c", "a", "b"]);
		expect(used([], "a")).toEqual(["a"]);
	});
	test("a closed tab drops out, and one opened behind its back goes last", () => {
		expect(ofOpen(["a", "b", "c"], ["c", "d", "a"])).toEqual(["a", "c", "d"]);
	});
	test("stepping goes to the one used before, then the one before that, round and round", () => {
		const order = ["now", "before", "earlier"];
		expect(stepped(order, 0, 1)).toEqual({ path: "before", at: 1 });
		expect(stepped(order, 1, 1)).toEqual({ path: "earlier", at: 2 });
		expect(stepped(order, 2, 1)).toEqual({ path: "now", at: 0 });
		expect(stepped(order, 0, -1)).toEqual({ path: "earlier", at: 2 });
		expect(stepped(["only"], 0, 1)).toBeNull();
	});
});

describe("pinned tabs", () => {
	test("a pinned tab stands first, after those pinned before it", () => {
		expect(withPin(["a", "b", "c", "d"], [], "c", true)).toEqual({ tabs: ["c", "a", "b", "d"], pinned: ["c"] });
		expect(withPin(["c", "a", "b", "d"], ["c"], "d", true)).toEqual({ tabs: ["c", "d", "a", "b"], pinned: ["c", "d"] });
	});
	test("a tab let go stands first among the others", () => {
		expect(withPin(["c", "d", "a", "b"], ["c", "d"], "c", false)).toEqual({ tabs: ["d", "c", "a", "b"], pinned: ["d"] });
	});
	test("pinning a tab that is pinned, or one that is not open, changes nothing but what is stale", () => {
		expect(withPin(["c", "a"], ["c"], "c", true)).toEqual({ tabs: ["c", "a"], pinned: ["c"] });
		expect(withPin(["a", "b"], ["gone"], "x", true)).toEqual({ tabs: ["a", "b"], pinned: [] });
	});
	test("close others and close to the right leave the pinned alone", () => {
		expect(othersOf(["p", "a", "b", "c"], ["p"], "b")).toEqual(["a", "c"]);
		expect(othersOf(["p", "a"], ["p"], null)).toEqual(["a"]);
		expect(rightOf(["a", "b", "p", "c"], ["p"], "a")).toEqual(["b", "c"]);
		expect(rightOf(["a", "b"], [], "b")).toEqual([]);
		expect(rightOf(["a", "b"], [], "x")).toEqual([]);
	});
});

describe("whole words in a regular expression", () => {
	test("an expression that reads only the older way is still searched, by plain letters", () => {
		for (const source of ["a\\-b", "a\\_b", "\\:x", "a{", "a]"]) expect(() => searchPattern(source, { regex: true, wholeWord: true })).not.toThrow();
		expect(found("a-b xa-b a-bx", searchPattern("a\\-b", { regex: true, wholeWord: true }))).toEqual(["a-b"]);
	});

	test("an expression that reads either way knows every alphabet's letters", () => {
		expect(found("Übung Übungen", searchPattern("Übung", { regex: true, wholeWord: true }))).toEqual(["Übung"]);
		expect(found("Due DueDate", searchPattern("D[a-z]+", { regex: true, wholeWord: true, caseSensitive: true }))).toEqual(["Due"]);
	});

	test("an expression that cannot be read at all says so, as it does without whole words", () => {
		expect(() => searchPattern("a(", { regex: true, wholeWord: true })).toThrow();
		expect(() => searchPattern("a(", { regex: true })).toThrow();
	});
});

describe("a walk through the tabs with Ctrl held", () => {
	test("stands while its tabs are open and the one it stopped at is showing", () => {
		expect(walkHolds(["a", "b", "c"], 1, ["c", "b", "a"], "b")).toBe(true);
	});

	test("is over when a tab of it was closed", () => {
		expect(walkHolds(["a", "b", "c"], 2, ["a", "c"], "c")).toBe(false);
	});

	test("is over when another tab was shown some other way", () => {
		expect(walkHolds(["a", "b", "c"], 1, ["a", "b", "c"], "c")).toBe(false);
		expect(walkHolds(["a", "b", "c"], 1, ["a", "b", "c"], null)).toBe(false);
	});
});

// --- tabs moved by hand ------------------------------------------------------------------------

describe("a tab dragged along its row", () => {
	const tabs = ["a", "b", "c", "d"];

	test("stands before the tab it was dropped on", () => {
		expect(placed(tabs, [], "d", "b")).toEqual(["a", "d", "b", "c"]);
		expect(placed(tabs, [], "a", "d")).toEqual(["b", "c", "a", "d"]);
	});

	test("stands last when dropped past the end", () => {
		expect(placed(tabs, [], "a", null)).toEqual(["b", "c", "d", "a"]);
		expect(placed(tabs, [], "a", "gone")).toEqual(["b", "c", "d", "a"]);
	});

	test("dropped on itself stays where it is", () => {
		expect(placed(tabs, [], "b", "b")).toEqual(tabs);
		expect(placed(tabs, [], "b", "c")).toEqual(tabs);
	});

	test("the pinned stay first: another tab goes no further left than after them", () => {
		expect(placed(tabs, ["a", "b"], "d", "a")).toEqual(["a", "b", "d", "c"]);
	});

	test("a pinned tab moves among the pinned, and no further right", () => {
		expect(placed(tabs, ["a", "b"], "a", null)).toEqual(["b", "a", "c", "d"]);
		expect(placed(tabs, ["a", "b"], "b", "a")).toEqual(["b", "a", "c", "d"]);
	});
});

describe("a tab dragged to the other group", () => {
	const two = () => [
		{ tabs: ["a", "b", "c"], active: "b" as string | null, pinned: ["a"], mode: "text" as const },
		{ tabs: ["x", "y"], active: "x" as string | null },
	];

	test("leaves its group and is shown in the other, where it was dropped", () => {
		const moved = movedAcross(two(), "b", 0, 1, "y");
		expect(moved.groups[0]).toEqual({ tabs: ["a", "c"], active: "c", pinned: ["a"], mode: "text" });
		expect(moved.groups[1]).toEqual({ tabs: ["x", "b", "y"], active: "b" });
		expect(moved.active).toBe(1);
	});

	test("a pinned tab is not pinned where it lands", () => {
		const moved = movedAcross(two(), "a", 0, 1, null);
		expect(moved.groups[0]!.pinned).toEqual([]);
		expect(moved.groups[1]).toEqual({ tabs: ["x", "y", "a"], active: "a" });
	});

	test("a tab that was not the one shown leaves the shown one alone", () => {
		expect(movedAcross(two(), "c", 0, 1, null).groups[0]!.active).toBe("b");
	});

	test("a file the other group already shows is not shown twice", () => {
		const groups = [
			{ tabs: ["a", "b"], active: "a" as string | null },
			{ tabs: ["x", "a"], active: "x" as string | null },
		];
		const moved = movedAcross(groups, "a", 0, 1, "x");
		expect(moved.groups[0]).toEqual({ tabs: ["b"], active: "b" });
		expect(moved.groups[1]).toEqual({ tabs: ["x", "a"], active: "a" });
	});

	test("a group left with nothing goes, and the other is the one at hand", () => {
		const groups = [
			{ tabs: ["a"], active: "a" as string | null },
			{ tabs: ["x"], active: "x" as string | null },
		];
		expect(movedAcross(groups, "a", 0, 1, null)).toEqual({ groups: [{ tabs: ["x", "a"], active: "a" }], active: 0 });
		expect(movedAcross(groups, "x", 1, 0, "a")).toEqual({ groups: [{ tabs: ["x", "a"], active: "x" }], active: 0 });
	});

	test("within one group it is a move along the row", () => {
		expect(movedAcross(two(), "c", 0, 0, "b").groups[0]!.tabs).toEqual(["a", "c", "b"]);
	});

	test("a tab that is not there moves nothing", () => {
		const groups = two();
		expect(movedAcross(groups, "nope", 0, 1, null).groups).toEqual(groups);
		expect(movedAcross(groups, "a", 5, 1, null).groups).toEqual(groups);
	});
});

describe("where a dragged tab would land", () => {
	test("before the tab the pointer is over", () => {
		expect(landsBefore(["a", "b", "c"], [], "c", "a")).toBe("a");
		expect(landsBefore(["a", "b", "c"], [], "a", null)).toBeNull();
	});

	test("after the pinned, whatever the pointer is over", () => {
		expect(landsBefore(["a", "b", "c"], ["a"], "c", "a")).toBe("b");
	});

	test("a tab from another group comes in after the pinned, and is not pinned itself", () => {
		expect(landsBefore(["a", "b"], ["a"], "x", "a")).toBe("b");
		expect(landsBefore(["a", "b"], ["a"], "x", null)).toBeNull();
		// Pinned where it came from, by the same name: still not pinned here.
		expect(landsBefore(["a", "b"], ["a", "x"], "x", "a")).toBe("b");
	});
});

// --- replacing what a search found --------------------------------------------------------------

describe("what a match becomes", () => {
	const first = (text: string, source: string, flags = "g") => new RegExp(source, flags).exec(text)!;

	test("words as typed become the replacement as typed, dollars and all", () => {
		expect(replacementFor(first("Due", "Due"), "$1 costs $&", false)).toBe("$1 costs $&");
	});

	test("a regular expression fills in its groups, the whole match and a dollar", () => {
		const match = first("DueDate", "(Due)(Date)");
		expect(replacementFor(match, "$2$1", true)).toBe("DateDue");
		expect(replacementFor(match, "[$&]", true)).toBe("[DueDate]");
		expect(replacementFor(match, "$$1", true)).toBe("$1");
	});

	test("a named group by its name", () => {
		expect(replacementFor(first("n := 5", "(?<name>\\w+) := (?<value>\\d+)"), "$<value> -> $<name>", true)).toBe("5 -> n");
	});

	test("a group the expression does not have is left as written", () => {
		const match = first("Due", "(Due)");
		expect(replacementFor(match, "$3", true)).toBe("$3");
		expect(replacementFor(match, "$<none>", true)).toBe("$<none>");
		// "$12" with one group is group 1 and a "2".
		expect(replacementFor(match, "$12", true)).toBe("Due2");
		expect(replacementFor(match, "$0", true)).toBe("$0");
	});
});

describe("replacing in a text", () => {
	test("every match is replaced and counted", () => {
		expect(replaceIn("a Due b Due\nDue", "Due", "Late")).toEqual({ text: "a Late b Late\nLate", count: 3 });
	});

	test("the line ends stay as they are, each as it was", () => {
		expect(replaceIn("Due\r\nDue\nDue\r\n", "Due", "x").text).toBe("x\r\nx\nx\r\n");
	});

	test("nothing found changes nothing", () => {
		expect(replaceIn("a\r\nb", "Due", "x")).toEqual({ text: "a\r\nb", count: 0 });
		expect(replaceIn("", "Due", "x")).toEqual({ text: "", count: 0 });
	});

	test("the switches are the search's own: case, whole word, a regular expression", () => {
		expect(replaceIn("due Due", "Due", "x", { caseSensitive: true }).text).toBe("due x");
		expect(replaceIn("Due DueDate", "Due", "x", { wholeWord: true }).text).toBe("x DueDate");
		expect(replaceIn("nDays := 1;", "(\\w+) := (\\d+)", "$1 := $2 + 1", { regex: true }).text).toBe("nDays := 1 + 1;");
	});

	test("words as typed are put in as typed", () => {
		expect(replaceIn("cost", "cost", "$& and $1").text).toBe("$& and $1");
		expect(replaceIn("a.b axb", "a.b", "c").text).toBe("c axb");
	});

	test("a match of nothing puts the replacement there: a mark before every line", () => {
		expect(replaceIn("a\nb", "^", "> ", { regex: true })).toEqual({ text: "> a\n> b", count: 2 });
	});

	test("replacing with nothing takes the matches out", () => {
		expect(replaceIn("a  b", " ", "").text).toBe("ab");
	});

	test("what is replaced is what a search finds, match for match", () => {
		const text = "aaa\nDue Due\n";
		for (const [query, options] of [["aa", {}], ["a*", { regex: true }], ["Due", { wholeWord: true }]] as const) {
			const pattern = searchPattern(query, options);
			const found = text.split(/\r?\n/).flatMap((line) => matchesOn(line, pattern, "", Boolean((options as { regex?: boolean }).regex)));
			expect(replaceIn(text, query, "", options).count).toBe(found.length);
		}
	});
});
