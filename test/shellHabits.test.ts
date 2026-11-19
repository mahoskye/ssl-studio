import { describe, expect, test } from "bun:test";
import { searchPattern } from "../src/shared/searchPattern";
import { ofOpen, othersOf, rightOf, stepped, used, walkHolds, withPin } from "../src/shared/tabOrder";

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
