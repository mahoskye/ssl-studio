import { describe, expect, test } from "bun:test";
import { changedRanges, trimEdit } from "../src/view/lsp/edits";

const L = (s: string) => s.split("");

describe("trimEdit", () => {
	test("no change", () => expect(trimEdit(L("abc"), L("abc"))).toBeNull());
	test("middle change", () => expect(trimEdit(L("abcde"), L("abXde"))).toEqual({ startLine: 2, endLine: 2, lines: ["X"] }));
	test("insertion", () => expect(trimEdit(L("abc"), L("abXc"))).toEqual({ startLine: 2, endLine: 1, lines: ["X"] }));
	test("deletion", () => expect(trimEdit(L("abc"), L("ac"))).toEqual({ startLine: 1, endLine: 1, lines: [] }));
	test("repeated lines", () => expect(trimEdit(L("aaa"), L("aaaa"))).toEqual({ startLine: 3, endLine: 2, lines: ["a"] }));
});

describe("changedRanges", () => {
	test("none", () => expect(changedRanges(L("abc"), L("abc"))).toEqual([]));
	test("one edit", () => expect(changedRanges(L("abcdef"), L("abXdef"))).toEqual([[2, 2]]));
	test("two separate edits", () => expect(changedRanges(L("abcdefgh"), L("aXcdefYh"))).toEqual([[1, 1], [6, 6]]));
	test("insertion", () => expect(changedRanges(L("abcd"), L("abXYcd"))).toEqual([[2, 3]]));
	test("deletion in the middle marks a neighbour", () => {
		const ranges = changedRanges(L("abcd"), L("abd"));
		expect(ranges.length).toBe(1);
		expect(ranges[0]![0]).toBeGreaterThanOrEqual(1);
		expect(ranges[0]![1]).toBeLessThanOrEqual(2);
	});
	test("deletion at the end", () => expect(changedRanges(L("abcd"), L("ab"))).toEqual([[1, 1]]));
	test("edits at both ends", () => expect(changedRanges(L("abcdef"), L("XbcdeY"))).toEqual([[0, 0], [5, 5]]));
	test("large input falls back to one range", () => {
		const before = Array.from({ length: 1500 }, (_, i) => `line ${i}`);
		const after = before.map((l, i) => (i === 10 || i === 1400 ? l + "!" : l));
		expect(changedRanges(before, after, 1000)).toEqual([[10, 1400]]);
		expect(changedRanges(before, after)).toEqual([[10, 10], [1400, 1400]]);
	});
});
