import { describe, expect, test } from "bun:test";
import { fileAndLine, lineAsked, prefixFor, QUICK_PREFIXES, readQuick } from "../src/shared/quickPrefix";

describe("what the quick pick lists", () => {
	test("nothing before the words is a file's name", () => {
		expect(readQuick("")).toEqual({ mode: "files", query: "" });
		expect(readQuick("due rules")).toEqual({ mode: "files", query: "due rules" });
	});

	test("the first character says what else", () => {
		expect(readQuick(">save")).toEqual({ mode: "commands", query: "save" });
		expect(readQuick("> save all")).toEqual({ mode: "commands", query: "save all" });
		expect(readQuick("@RuleFor")).toEqual({ mode: "outline", query: "RuleFor" });
		expect(readQuick("#Rule")).toEqual({ mode: "symbols", query: "Rule" });
		expect(readQuick(":12")).toEqual({ mode: "line", query: "12" });
		expect(readQuick("?")).toEqual({ mode: "help", query: "" });
	});

	test("only the first character: one further in is part of the words", () => {
		expect(readQuick("a>b").mode).toBe("files");
		expect(readQuick(" >save").mode).toBe("files");
		expect(readQuick(">@x")).toEqual({ mode: "commands", query: "@x" });
	});

	test("each way of listing opens with its own character, and files with none", () => {
		expect(prefixFor("files")).toBe("");
		for (const each of QUICK_PREFIXES) {
			expect(prefixFor(each.mode)).toBe(each.prefix);
			expect(readQuick(each.prefix).mode).toBe(each.mode);
		}
		expect(new Set(QUICK_PREFIXES.map((each) => each.prefix)).size).toBe(QUICK_PREFIXES.length);
	});
});

describe("a line asked for", () => {
	test("a number is a line, at its first column", () => {
		expect(lineAsked("12", 40)).toEqual({ line: 12, column: 1 });
		expect(lineAsked(" 12 ", 40)).toEqual({ line: 12, column: 1 });
	});

	test("a second number is the column, after a colon or a comma", () => {
		expect(lineAsked("12:5", 40)).toEqual({ line: 12, column: 5 });
		expect(lineAsked("12,5", 40)).toEqual({ line: 12, column: 5 });
		// Still being typed: the line so far.
		expect(lineAsked("12:", 40)).toEqual({ line: 12, column: 1 });
	});

	test("a line past the end is the last, and none before the first", () => {
		expect(lineAsked("400", 40)).toEqual({ line: 40, column: 1 });
		expect(lineAsked("0", 40)).toEqual({ line: 1, column: 1 });
		expect(lineAsked("3", 0)).toEqual({ line: 1, column: 1 });
	});

	test("what is not a number is no line", () => {
		expect(lineAsked("", 40)).toBeNull();
		expect(lineAsked("twelve", 40)).toBeNull();
		expect(lineAsked("-3", 40)).toBeNull();
		expect(lineAsked("1.5", 40)).toBeNull();
	});
});

describe("a file with a line after its name", () => {
	test("the line is taken off the name", () => {
		expect(fileAndLine("DueRules.ssl:20")).toEqual({ query: "DueRules.ssl", at: { line: 20, column: 1 } });
		expect(fileAndLine("due rules:20:5")).toEqual({ query: "due rules", at: { line: 20, column: 5 } });
	});

	test("a name alone is a name", () => {
		expect(fileAndLine("DueRules.ssl")).toEqual({ query: "DueRules.ssl", at: null });
		expect(fileAndLine("")).toEqual({ query: "", at: null });
	});

	test("a colon that is not followed by a number to the end is part of the name", () => {
		expect(fileAndLine("C:\\work\\a.ssl").at).toBeNull();
		expect(fileAndLine("a:b").at).toBeNull();
		expect(fileAndLine("a.ssl:")).toEqual({ query: "a.ssl", at: null });
		expect(fileAndLine("a.ssl:12:")).toEqual({ query: "a.ssl", at: { line: 12, column: 1 } });
		expect(fileAndLine("C:\\work\\a.ssl:7")).toEqual({ query: "C:\\work\\a.ssl", at: { line: 7, column: 1 } });
	});

	test("a number alone is a name, not a line of nothing", () => {
		expect(fileAndLine(":20").at).toBeNull();
		expect(fileAndLine("20").at).toBeNull();
	});
});
