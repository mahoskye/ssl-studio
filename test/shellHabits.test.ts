import { describe, expect, test } from "bun:test";
import { searchPattern } from "../src/shared/searchPattern";
import { ofOpen, stepped, used } from "../src/shared/tabOrder";

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
