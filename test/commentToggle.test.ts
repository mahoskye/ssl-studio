// "Toggle comment" for SSL (shared/commentToggle.ts), over the grammar the editor colours with: what is comment
// after an edit is asked of that grammar, not of the rule under test.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import * as oniguruma from "vscode-oniguruma";
import { INITIAL, Registry } from "vscode-textmate";
import { findComments, lineRange, toggleComments, withEdits, type CommentEdit, type Span, type TextRange } from "../src/shared/commentToggle";

const wasm = readFileSync(join(import.meta.dir, "../src/view/public/onig.wasm"));
await oniguruma.loadWASM({ data: wasm.buffer.slice(wasm.byteOffset, wasm.byteOffset + wasm.byteLength) });
const rawGrammar = JSON.parse(readFileSync(join(import.meta.dir, "../src/view/public/grammar/ssl.tmLanguage.json"), "utf8"));
const registry = new Registry({
	onigLib: Promise.resolve({
		createOnigScanner: (patterns) => new oniguruma.OnigScanner(patterns),
		createOnigString: (text) => new oniguruma.OnigString(text),
	}),
	loadGrammar: async (scope) => (scope === "source.ssl" ? rawGrammar : null),
});
const grammar = (await registry.loadGrammar("source.ssl"))!;
/**
 * The stretches of each line the grammar reads as comment, as `sslCommentSpans` (view/editor/textmate.ts) gives
 * them to the editor's command: read here from the grammar directly, since that module brings the editor with it.
 */
function spansOf(lines: readonly string[]): Span[][] {
	let stack = INITIAL;
	return lines.map((line) => {
		const result = grammar.tokenizeLine2(line, stack, 500);
		stack = result.ruleStack;
		const spans: Span[] = [];
		for (let i = 0; i < result.tokens.length; i += 2) {
			// vscode-textmate's standard token type, in bits 8 and 9: 1 is a comment.
			if ((result.tokens[i + 1]! & 0x300) >>> 8 !== 1) continue;
			const from = result.tokens[i]!;
			const to = i + 2 < result.tokens.length ? result.tokens[i + 2]! : line.length;
			const last = spans.at(-1);
			if (last && last.to === from) last.to = to;
			else if (to > from) spans.push({ from, to });
		}
		return spans;
	});
}

/** The tokens as the language configuration the app ships has them. */
const config = JSON.parse(readFileSync(join(import.meta.dir, "../src/view/public/grammar/language-configuration.json"), "utf8"));
const TOKENS = { open: config.comments.blockComment[0] as string, close: config.comments.blockComment[1] as string };

/** A text with edits applied, each at its place in the text as it was. */
function apply(lines: readonly string[], edits: readonly CommentEdit[]): string[] {
	const text = lines.join("\n");
	const starts = [0];
	for (let i = 0; i < text.length; i++) if (text[i] === "\n") starts.push(i + 1);
	const at = (p: { line: number; column: number }) => starts[p.line]! + p.column;
	const placed = edits.map((e) => ({ from: at(e.start), to: at(e.end), text: e.text })).sort((a, b) => b.from - a.from || b.to - a.to);
	// None reaches into another: the editor refuses edits that do.
	for (let i = 1; i < placed.length; i++) expect(placed[i]!.to).toBeLessThanOrEqual(placed[i - 1]!.from);
	let out = text;
	for (const e of placed) out = out.slice(0, e.from) + e.text + out.slice(e.to);
	return out.split("\n");
}
/** Each line, with whether everything written on it is comment: "c", "-" for code, " " for a blank line. */
const kinds = (lines: readonly string[]) => {
	const spans = spansOf(lines);
	return lines
		.map((text, line) => {
			if (!text.trim()) return " ";
			for (let column = 0; column < text.length; column++) if (text[column]!.trim() && !spans[line]!.some((s) => s.from <= column && column < s.to)) return "-";
			return "c";
		})
		.join("");
};
const linesOf = (lines: readonly string[], first: number, last = first): TextRange => lineRange(lines, { start: { line: first, column: 0 }, end: { line: last, column: lines[last]!.length } });
const toggle = (lines: readonly string[], range: TextRange, how?: "toggle" | "comment" | "uncomment") => apply(lines, toggleComments(lines, spansOf(lines), TOKENS, range, how));

describe("toggle comment: statements become comments, and come back as they were", () => {
	test("the tokens are the language configuration's", () => expect(TOKENS).toEqual({ open: "/*", close: ";" }));

	test("one statement: its own semicolon ends the comment, and nothing is added after it", () => {
		const code = ["\tdResult := dStart + nCount;"];
		const off = toggle(code, linesOf(code, 0));
		expect(off).toEqual(["\t/* dResult := dStart + nCount;"]);
		expect(toggle(off, linesOf(off, 0))).toEqual(code);
	});

	test("two statements selected: both are comment, where the editor's own command left the second as code", () => {
		const code = [":DECLARE dResult;", "\tdResult := dStart + nCount;", "\t:RETURN dResult;", ":ENDPROC;"];
		const off = toggle(code, linesOf(code, 1, 2));
		expect(off).toEqual([":DECLARE dResult;", "\t/* dResult := dStart + nCount;", "\t/* :RETURN dResult;", ":ENDPROC;"]);
		expect(kinds(off)).toBe("-cc-");
		expect(toggle(off, linesOf(off, 1, 2))).toEqual(code);
	});

	test("two statements on one line each get an opener: the first one's semicolon ended the comment", () => {
		const code = ["a := 1; b := 2;"];
		const off = toggle(code, linesOf(code, 0));
		expect(off).toEqual(["/* a := 1; /* b := 2;"]);
		expect(kinds(off)).toBe("c");
		expect(toggle(off, linesOf(off, 0))).toEqual(code);
	});

	test("a semicolon in a string ends the comment as any other does, so what follows it is opened again", () => {
		const code = ['sText := "one;two";'];
		const off = toggle(code, linesOf(code, 0));
		expect(off).toEqual(['/* sText := "one;/* two";']);
		expect(kinds(off)).toBe("c");
		expect(toggle(off, linesOf(off, 0))).toEqual(code);
	});

	test("a statement over several lines is one comment: one opener, and its own semicolon", () => {
		const code = ["aRows := SQLExecute(\"", "\tSELECT SAMPLE_ID", "\tFROM DEMO_SAMPLES", "\", \"DB\");", "x := 1;"];
		const off = toggle(code, linesOf(code, 0, 3));
		expect(off).toEqual(["/* aRows := SQLExecute(\"", "\tSELECT SAMPLE_ID", "\tFROM DEMO_SAMPLES", "\", \"DB\");", "x := 1;"]);
		expect(kinds(off)).toBe("cccc-");
		expect(toggle(off, linesOf(off, 0, 3))).toEqual(code);
		// From any of its lines the comment is taken away whole.
		expect(toggle(off, linesOf(off, 2))).toEqual(code);
	});

	test("a selection that stops inside a statement is closed there: the lines below stay code", () => {
		const code = ["x := Foo(a,", "\tb);", "y := 2;"];
		const off = toggle(code, linesOf(code, 0));
		expect(off).toEqual(["/* x := Foo(a, ;", "\tb);", "y := 2;"]);
		expect(kinds(off)).toBe("c--");
		expect(toggle(off, linesOf(off, 0))).toEqual(code);
	});

	test("words with no semicolon are closed with a space and a semicolon, which goes when the comment does", () => {
		const code = ["\tcheck this with the lab", "x := 1;"];
		const off = toggle(code, linesOf(code, 0));
		expect(off).toEqual(["\t/* check this with the lab ;", "x := 1;"]);
		expect(kinds(off)).toBe("c-");
		expect(toggle(off, linesOf(off, 0))).toEqual(code);
	});

	test("blank lines are left alone, and an opener stands after a line's indentation", () => {
		const code = ["\t:IF nA > 1;", "", "\t\tnA := 1;", "   ", "\t:ENDIF;"];
		const off = toggle(code, linesOf(code, 0, 4));
		expect(off).toEqual(["\t/* :IF nA > 1;", "", "\t\t/* nA := 1;", "   ", "\t/* :ENDIF;"]);
		expect(toggle(off, linesOf(off, 0, 4))).toEqual(code);
	});

	test("a selection with code and comments in it is made comment throughout, and one toggle takes one level away", () => {
		const code = ["/* the day it is due;", "dDue := Today();"];
		const off = toggle(code, linesOf(code, 0, 1));
		expect(off).toEqual(["/* /* the day it is due;", "/* dDue := Today();"]);
		expect(kinds(off)).toBe("cc");
		expect(toggle(off, linesOf(off, 0, 1))).toEqual(code);
	});

	test("a selection that starts inside a comment leaves that comment alone", () => {
		const code = ["/* a note that runs", "   over two lines;", "x := 1;"];
		const off = toggle(code, linesOf(code, 1, 2));
		expect(off).toEqual(["/* a note that runs", "   over two lines;", "/* x := 1;"]);
		expect(toggle(off, linesOf(off, 1, 2))).toEqual(code);
	});

	test("a selection that ends at the start of a line does not take that line in", () => {
		const code = ["a := 1;", "b := 2;"];
		const range = lineRange(code, { start: { line: 0, column: 3 }, end: { line: 1, column: 0 } });
		expect(apply(code, toggleComments(code, spansOf(code), TOKENS, range))).toEqual(["/* a := 1;", "b := 2;"]);
	});
});

describe("toggle comment: comments written by hand, and by the VS Code extension", () => {
	test("a note with its semicolon after a space loses both; a blank line the extension commented is blank again", () => {
		const made = ["\t/* x := Foo(a, ;", "\t/* ;", "\t/* b);"];
		expect(toggle(made, linesOf(made, 0, 2))).toEqual(["\tx := Foo(a,", "\t", "\tb);"]);
	});

	test("a block written round lines, the opener and the semicolon each on a line of its own: those two lines go", () => {
		const made = ["x := 1;", "\t/*", "\tfirst line", "\tsecond line", "\t;", "y := 2;"];
		expect(kinds(made)).toBe("-cccc-");
		expect(toggle(made, linesOf(made, 1, 4))).toEqual(["x := 1;", "\tfirst line", "\tsecond line", "y := 2;"]);
		// At the end of the file there is no line break after the last line to take with it.
		const atEnd = ["/*", "words", ";"];
		expect(toggle(atEnd, linesOf(atEnd, 0, 2))).toEqual(["words"]);
		const two = ["/*", ";"];
		expect(toggle(two, linesOf(two, 0, 1))).toEqual([""]);
	});

	test("an access modifier is a comment like any other", () => {
		const code = ["/*@private;", ":PROCEDURE Hidden;"];
		expect(kinds(code)).toBe("c-");
		expect(toggle(code, linesOf(code, 0))).toEqual(["@private;", ":PROCEDURE Hidden;"]);
	});
});

describe("toggle comment: what is asked for", () => {
	test("'add' comments what is comment already, and 'remove' does nothing to code", () => {
		const code = ["/* a note;", "x := 1;"];
		expect(toggle(code, linesOf(code, 0), "comment")).toEqual(["/* /* a note;", "x := 1;"]);
		expect(toggle(code, linesOf(code, 1), "uncomment")).toEqual(code);
		expect(toggle(code, linesOf(code, 0, 1), "uncomment")).toEqual(["a note;", "x := 1;"]);
	});

	test("a part of a line: closed where the selection ends, so the rest of the statement stays code", () => {
		const code = ["x := a + b + c;"];
		const picked: TextRange = { start: { line: 0, column: 9 }, end: { line: 0, column: 10 } };
		const off = apply(code, toggleComments(code, spansOf(code), TOKENS, picked));
		expect(off).toEqual(["x := a + /* b ; + c;"]);
		const again: TextRange = { start: { line: 0, column: 9 }, end: { line: 0, column: 15 } };
		expect(apply(off, toggleComments(off, spansOf(off), TOKENS, again))).toEqual(code);
	});

	test("nothing written in the range: nothing to do", () => {
		const code = ["", "   ", "x := 1;"];
		expect(toggleComments(code, spansOf(code), TOKENS, linesOf(code, 0, 1))).toEqual([]);
	});
});

describe("findComments: each comment on its own", () => {
	test("two comments end to end are two; one over lines is one; one with no semicolon runs to the end", () => {
		const lines = ["/* one;/* two;", "x := 1; /* three", "   still three;", "/* never closed"];
		const found = findComments(lines, spansOf(lines), TOKENS);
		expect(found.map((c) => [c.start.line, c.start.column, c.end.line, c.end.column, c.closed])).toEqual([
			[0, 0, 0, 7, true],
			[0, 7, 0, 14, true],
			[1, 8, 2, 15, true],
			[3, 0, 3, 15, false],
		]);
		expect(found.every((c) => c.opened)).toBe(true);
	});
});

describe("toggle comment: any lines, any selection", () => {
	test("the selection becomes comment, nothing outside it changes, and toggling again gives the text back", () => {
		// A fixed sequence in place of a random one, so that a failure is the same failure every run.
		let seed = 11;
		const next = (n: number) => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) % n;
		const pieces: string[][] = [
			["x := 1;"],
			["\tnA := nB + 1;"],
			["a := 1; b := 2;"],
			['sText := "one;two";'],
			[""],
			["\t"],
			["/* a note;"],
			["/* a note", "   over two lines;"],
			["x := Foo(a,", "\tb);"],
			["aRows := SQLExecute(\"", "\tSELECT 1", "\");"],
			[":IF nA > 1;", "\tnA := 1;", ":ENDIF;"],
			["x := 1;  /* why;"],
		];
		let refused = 0;
		for (let round = 0; round < 400; round++) {
			const code = Array.from({ length: 1 + next(5) }, () => pieces[next(pieces.length)]!).flat();
			const first = next(code.length);
			const last = first + next(code.length - first);
			const range = linesOf(code, first, last);
			const before = kinds(code);
			const edits = toggleComments(code, spansOf(code), TOKENS, range, "comment");
			const off = apply(code, edits);
			// As the editor's command does: the grammar is asked whether each opener written is a comment where it
			// stands. Where the selection starts inside a string that runs over lines it is not, and the command
			// writes nothing (below, on its own).
			const written = withEdits(code, edits, TOKENS);
			expect(written.lines).toEqual(off);
			const spansAfter = spansOf(off);
			if (written.openers.some((p) => !spansAfter[p.line]!.some((s) => s.from <= p.column && p.column < s.to))) {
				refused++;
				continue;
			}
			const after = kinds(off);
			// A comment made adds no lines, so the lines keep their numbers.
			expect(off.length).toBe(code.length);
			for (let line = 0; line < code.length; line++) {
				if (line >= first && line <= last) expect(after[line] === "c" || after[line] === " ").toBe(true);
				else {
					expect(off[line]).toBe(code[line]!);
					expect(after[line]).toBe(before[line]!);
				}
			}
			// Toggled again over the same lines, where the first toggle made comments: the text as it was.
			if (off.join("\n") === code.join("\n")) continue;
			expect(apply(off, toggleComments(off, spansOf(off), TOKENS, linesOf(off, first, last), "uncomment"))).toEqual(code);
		}
		// Most selections can be commented: the ones that cannot are few.
		expect(refused).toBeLessThan(40);
	});

	test("an opener that would stand inside a string is seen for what it is: the grammar does not read it as a comment", () => {
		const code = ["aRows := SQLExecute(\"", "\tSELECT 1", "\");", "x := 1;"];
		const edits = toggleComments(code, spansOf(code), TOKENS, linesOf(code, 1, 3));
		const written = withEdits(code, edits, TOKENS);
		// The first opener is on the second line, inside the string; the editor's command writes none of them.
		expect(written.openers[0]).toEqual({ line: 1, column: 1 });
		const spans = spansOf(written.lines);
		expect(spans[1]!.some((s) => s.from <= 1 && 1 < s.to)).toBe(false);
		// From the start of the statement there is nothing in the way.
		const whole = withEdits(code, toggleComments(code, spansOf(code), TOKENS, linesOf(code, 0, 3)), TOKENS);
		const wholeSpans = spansOf(whole.lines);
		expect(whole.openers.every((p) => wholeSpans[p.line]!.some((s) => s.from <= p.column && p.column < s.to))).toBe(true);
	});
});
