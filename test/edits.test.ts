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

import { minimalReplace } from "../src/view/lsp/edits";

describe("minimalReplace", () => {
	const apply = (before: string, after: string) => {
		const e = minimalReplace(before, after);
		return e ? before.slice(0, e.start) + e.text + before.slice(e.end) : before;
	};
	for (const [a, b] of [["abc", "abc"], ["abc", "aXc"], ["abc", "ab"], ["", "x"], ["x", ""], ["aaa", "aaaa"], ["line1\nline2\n", "line1\nnew\nline2\n"]])
		test(`${JSON.stringify(a)} → ${JSON.stringify(b)}`, () => expect(apply(a!, b!)).toBe(b!));
	test("small span", () => expect(minimalReplace("hello world", "hello there world")).toEqual({ start: 6, end: 6, text: "there " }));
});

import { applyTextEdits } from "../src/view/lsp/edits";

test("the server's edits are applied to text that is in no editor", () => {
	const at = (line: number, character: number) => ({ line, character });
	const text = "a:=1;\nb:=2;\n";
	// Two edits, given first to last: the later one is not moved by the earlier.
	expect(
		applyTextEdits(text, [
			{ range: { start: at(0, 1), end: at(0, 3) }, newText: " := " },
			{ range: { start: at(1, 1), end: at(1, 3) }, newText: " := " },
		]),
	).toBe("a := 1;\nb := 2;\n");
	// A whole-document replacement, whose end is past the last line.
	expect(applyTextEdits(text, [{ range: { start: at(0, 0), end: at(9, 0) }, newText: "x;\n" }])).toBe("x;\n");
	// A column past the end of its line stops at the line's end.
	expect(applyTextEdits("ab\ncd", [{ range: { start: at(0, 99), end: at(0, 99) }, newText: "!" }])).toBe("ab!\ncd");
	expect(applyTextEdits(text, [])).toBe(text);
});

import { smallEdits, typedLead, type SmallEdit } from "../src/view/lsp/edits";

describe("typedLead", () => {
	test("punctuation typed before the word, which the text opens with, is counted", () => {
		expect(typedLead(":", ":WHILE")).toBe(1);
		expect(typedLead("\tx := 1;\n:", ":WHILE")).toBe(1);
		expect(typedLead("x := .", ".T.")).toBe(1);
		expect(typedLead("a ::", "::b")).toBe(2);
	});
	test("the longest repeat is taken, and only as much as was typed", () => {
		expect(typedLead("x -", "->y")).toBe(1);
		expect(typedLead("x ->", "->y")).toBe(2);
		expect(typedLead("x >", "->y")).toBe(0);
	});
	test("nothing is counted where the text opens with a word, or nothing of it was typed", () => {
		expect(typedLead(":", "WHILE")).toBe(0);
		expect(typedLead("x := ", ":WHILE")).toBe(0);
		expect(typedLead("", ":WHILE")).toBe(0);
		expect(typedLead("sName", "sName")).toBe(0);
	});
	test("a snippet's placeholder is not text that was typed", () => {
		expect(typedLead("$", "${1:name}", true)).toBe(0);
		expect(typedLead(":", ":WHILE ${1:condition};", true)).toBe(1);
		expect(typedLead("$", "$name")).toBe(1);
	});
	test("half of a character of two units is never counted", () => {
		expect(typedLead("\ud83d", "🔴x")).toBe(0);
	});
});

describe("smallEdits", () => {
	/** The block with the edits applied, each at its place in the block as it was. */
	const apply = (lines: string[], edits: SmallEdit[]) => {
		const text = lines.join("\n");
		const starts = [0];
		for (let i = 0; i < text.length; i++) if (text[i] === "\n") starts.push(i + 1);
		let out = text;
		for (const e of [...edits].reverse()) out = out.slice(0, starts[e.startLine]! + e.startColumn) + e.text + out.slice(starts[e.endLine]! + e.endColumn);
		return out.split("\n");
	};
	/** Edits in order, none reaching into or touching the next, each within the block. */
	const wellFormed = (lines: string[], edits: SmallEdit[]) => {
		let line = 0;
		let column = -1;
		for (const e of edits) {
			expect(e.startLine > line || (e.startLine === line && e.startColumn > column)).toBe(true);
			expect(e.endLine > e.startLine || e.endColumn >= e.startColumn).toBe(true);
			expect(e.endLine).toBeLessThan(lines.length);
			expect(e.endColumn).toBeLessThanOrEqual(lines[e.endLine]!.length);
			line = e.endLine;
			column = e.endColumn;
		}
	};
	const check = (before: string[], after: string[]) => {
		const edits = smallEdits(before, after);
		wellFormed(before, edits);
		expect(apply(before, edits)).toEqual(after);
		return edits;
	};

	test("a line the formatter kept is changed only where it differs", () => {
		const edits = check(["x:=5 ;"], ["\tx := 5;"]);
		// Nothing at or after the semicolon: a cursor at the line's end stays there.
		expect(edits.every((e) => e.startLine === 0 && e.endLine === 0 && e.endColumn <= 5)).toBe(true);
		expect(edits.length).toBeGreaterThan(1);
	});
	test("a procedure reformatted leaves the lines that did not change alone", () => {
		const before = [":PROCEDURE  foo ;", ":PARAMETERS a,b;", ":DECLARE x;", "x:=a+b ;", ":IF x>1;", "x := 1;", ":ELSE;", "      x:=0;", ":ENDIF;", "x:=5 ;", ":RETURN x;", ":ENDPROC;"];
		const after = [":PROCEDURE foo;", "\t:PARAMETERS a, b;", "\t:DECLARE x;", "", "\tx := a + b;", "", "\t:IF x > 1;", "\t\tx := 1;", "\t:ELSE;", "\t\tx := 0;", "\t:ENDIF;", "", "\tx := 5;", "\t:RETURN x;", ":ENDPROC;"];
		const edits = check(before, after);
		// The last line is the same in both: no edit reaches it.
		expect(edits.every((e) => e.endLine < before.length - 1)).toBe(true);
		// The line typed last ("x:=5 ;", line 9) is changed within itself, by edits that end before its semicolon.
		const onTyped = edits.filter((e) => e.endLine === 9);
		expect(onTyped.length).toBeGreaterThan(0);
		expect(onTyped.every((e) => e.endColumn <= 5)).toBe(true);
	});
	test("letter case changed by the formatter is a change within the line", () => {
		const edits = check(['\tx := sqlexecute("select 1");'], ['\tx := SQLExecute("select 1");']);
		expect(edits.every((e) => e.startLine === 0 && e.endLine === 0)).toBe(true);
	});
	test("lines added and taken out, at the start, in the middle and at the end", () => {
		check(["a;", "b;"], ["", "a;", "b;"]);
		check(["a;", "b;"], ["a;", "", "b;"]);
		check(["a;", "b;"], ["a;", "b;", "", "c;"]);
		check(["", "a;", "b;"], ["a;", "b;"]);
		check(["a;", "", "", "b;"], ["a;", "b;"]);
		check(["a;", "b;", "", ""], ["a;", "b;"]);
		check(["a ;", "", ""], ["a;"]);
		check(["a ;"], ["", "a;", ""]);
	});
	test("lines the formatter rewrote are replaced whole", () => {
		const edits = check(["x := Foo(1, 2, 3);"], ["x := Foo(1,", "\t2, 3);"]);
		expect(edits).toEqual([{ startLine: 0, startColumn: 0, endLine: 0, endColumn: 18, text: "x := Foo(1,\n\t2, 3);" }]);
		check(["a;", "one two", "b;"], ["a;", "three", "four", "b;"]);
	});
	test("nothing to change gives no edits", () => {
		expect(smallEdits(["a;", "b;"], ["a;", "b;"])).toEqual([]);
	});
	test("a character of two units is never cut", () => {
		const edits = check(['s:="🔴" ;'], ['s := "🟢";']);
		for (const e of edits) for (const at of [e.startColumn, e.endColumn]) expect(at > 0 && 's:="🔴" ;'.charCodeAt(at - 1) >= 0xd800 && 's:="🔴" ;'.charCodeAt(at - 1) <= 0xdbff).toBe(false);
	});
	test("a block too large for the table, or a line too long for one, is changed in one piece", () => {
		const before = Array.from({ length: 40 }, (_, i) => `x${i}:=1 ;`);
		const after = before.map((l) => l.replace(":=1 ;", " := 1;"));
		expect(smallEdits(before, after, 100)).toEqual([{ startLine: 0, startColumn: 0, endLine: 39, endColumn: before[39]!.length, text: after.join("\n") }]);
		const long = `x := "${"a".repeat(300)}" ;`;
		const edits = smallEdits([long], [long.replace('" ;', '";')]);
		expect(edits.length).toBe(1);
		expect(apply([long], edits)).toEqual([long.replace('" ;', '";')]);
	});
	test("any two blocks: the edits make the one from the other", () => {
		// A fixed sequence in place of a random one, so that a failure is the same failure every run.
		let seed = 7;
		const next = (n: number) => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) % n;
		const pieces = ["x := 1;", "x:=1 ;", "\tx := 1;", "", "  ", ":IF a;", "\t:IF A;", ":ENDIF;", "y := Foo( 1 );", "y := foo(1);", "/* note;"];
		for (let round = 0; round < 300; round++) {
			const before = Array.from({ length: 1 + next(7) }, () => pieces[next(pieces.length)]!);
			const after = Array.from({ length: 1 + next(7) }, () => pieces[next(pieces.length)]!);
			check(before, after);
		}
	});
});

import { formattedParts } from "../src/view/lsp/edits";

describe("formattedParts: the lines a format of the whole document has in place of some of its lines", () => {
	const OLD = [":PROCEDURE one;", "x:=sqlexecute(a) ;", ":RETURN x;", ":ENDPROC;", ":PROCEDURE two;", "y:=1 ;", ":ENDPROC;"];
	const NEW = [":PROCEDURE one;", "\tx := SQLExecute(a);", "", "\t:RETURN x;", ":ENDPROC;", "", ":PROCEDURE two;", "\ty := 1;", ":ENDPROC;"];

	test("one procedure: its lines as the formatter has them, the blank line it adds inside included", () => {
		expect(formattedParts(OLD, NEW, [[0, 3]])).toEqual([{ start: 0, oldLines: OLD.slice(0, 4), newLines: [...NEW.slice(0, 5), ""] }]);
	});

	test("a blank line added between two procedures goes with the one that is asked for, on either side of it", () => {
		// After the first procedure, and before the second.
		expect(formattedParts(OLD, NEW, [[0, 3]])![0]!.newLines.at(-1)).toBe("");
		expect(formattedParts(OLD, NEW, [[4, 6]])).toEqual([{ start: 4, oldLines: OLD.slice(4), newLines: NEW.slice(5) }]);
	});

	test("lines that are not asked for are in no part, whatever the formatter would do to them", () => {
		const parts = formattedParts(OLD, NEW, [[5, 5]])!;
		expect(parts).toEqual([{ start: 5, oldLines: ["y:=1 ;"], newLines: ["\ty := 1;"] }]);
	});

	test("ranges that touch are one part, so the lines added between them are taken once", () => {
		const parts = formattedParts(OLD, NEW, [[4, 6], [0, 3]])!;
		expect(parts.length).toBe(1);
		expect(parts[0]!.newLines).toEqual(NEW);
		expect(parts[0]!.oldLines).toEqual(OLD);
	});

	test("lines the formatter takes out: the part has fewer lines, or none", () => {
		const old = ["a := 1;", "", "", "", "b := 2;"];
		const formatted = ["a := 1;", "", "b := 2;"];
		expect(formattedParts(old, formatted, [[0, 4]])).toEqual([{ start: 0, oldLines: old, newLines: formatted }]);
		// The second and third blank lines alone: the formatter keeps one of the three, and which is its own affair.
		const taken = formattedParts(old, formatted, [[2, 3]])!;
		expect(taken[0]!.oldLines).toEqual(["", ""]);
		expect(taken[0]!.newLines.every((line) => line === "")).toBe(true);
		expect(taken[0]!.newLines.length).toBeLessThan(2);
	});

	test("a text the formatter leaves alone gives each part its own lines back", () => {
		expect(formattedParts(NEW, NEW, [[1, 3]])).toEqual([{ start: 1, oldLines: NEW.slice(1, 4), newLines: NEW.slice(1, 4) }]);
	});

	test("ranges past the end are cut to the text, and two texts too unlike to set side by side give null", () => {
		expect(formattedParts(OLD, NEW, [[5, 99]])![0]!.oldLines).toEqual(OLD.slice(5));
		const a = Array.from({ length: 400 }, (_, i) => `a${i};`);
		const b = Array.from({ length: 400 }, (_, i) => `b${i};`);
		expect(formattedParts(a, b, [[0, 10]], 1000)).toBeNull();
	});
});
