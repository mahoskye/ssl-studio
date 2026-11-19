import { describe, expect, test } from "bun:test";
import { yamlProblem } from "../src/bun/project";
import { looksLikeXml, xmlProblem } from "../src/shared/xmlCheck";

describe("a YAML document that cannot be read", () => {
	test("one that reads has nothing said of it", () => {
		expect(yamlProblem("name: Due dates\nfolders:\n  - docs\n  - schema: [a, b]\n")).toBeNull();
		expect(yamlProblem("")).toBeNull();
		expect(yamlProblem("# only a comment\n")).toBeNull();
		expect(yamlProblem("a: 1\n---\nb: 2\n")).toBeNull();
	});
	test("says about where: the line after the longest start that still reads", () => {
		expect(yamlProblem("a: 1\n b: 2\n")?.line).toBe(2);
		expect(yamlProblem("name: x\nitems: [1, 2\nother: 3\n")?.line).toBe(2);
		expect(yamlProblem('name: "x\nother: 3\n')?.line).toBe(1);
		expect(yamlProblem("a: 1\nb: 2\nc: *nope\n")?.line).toBe(3);
	});
	test("a list that spans lines and is closed is not where a later fault is", () => {
		expect(yamlProblem("items: [1,\n  2,\n  3]\nname: x\n bad: 1\n")?.line).toBe(5);
	});
	test("says it in a sentence, and that the place is near", () => {
		expect(yamlProblem("a: *nope\n")?.message).toBe("An alias (*name) names an anchor that is not there. The reader stopped at or near this line.");
		expect(yamlProblem("a: 1\n b: 2\n")?.message).toContain("check the indentation");
	});
	test("Windows line ends count the same lines", () => {
		expect(yamlProblem("a: 1\r\n b: 2\r\n")?.line).toBe(2);
	});
	test("a long document is said to be unreadable, at its start", () => {
		const long = `${Array.from({ length: 1200 }, (_, i) => `k${i}: ${i}`).join("\n")}\n bad: 1\n`;
		expect(yamlProblem(long)?.line).toBe(1);
	});
});

describe("what the XML reader said", () => {
	test("is a place and a sentence", () => {
		expect(xmlProblem("This page contains the following errors:error on line 3 at column 7: Opening and ending tag mismatch: a line 1 and b\nBelow is a rendering of the page up to the first error.")).toEqual({ line: 3, column: 7, message: "The closing tag </b> does not match <a>, opened on line 1." });
		expect(xmlProblem("This page contains the following errors:error on line 4 at column 44: Unexpected closing tag: settng != settingBelow is a rendering of the page up to the first error.")).toEqual({ line: 4, column: 44, message: "The closing tag </settng> does not match <setting>, which is open here." });
		expect(xmlProblem("error on line 2 at column 1: Extra content at the end of the document\n")).toEqual({ line: 2, column: 1, message: "Extra content at the end of the document." });
	});
	test("an error with no place is at the start", () => {
		expect(xmlProblem("XML Parsing Error")).toEqual({ line: 1, column: 1, message: "This is not well-formed XML." });
	});
	test("only a text that opens as XML does is judged", () => {
		expect(looksLikeXml('<?xml version="1.0"?>\n<a/>')).toBe(true);
		expect(looksLikeXml("\uFEFF  <!-- note -->\n<a/>")).toBe(true);
		expect(looksLikeXml("key = value\n<not xml>")).toBe(false);
		expect(looksLikeXml("")).toBe(false);
	});
});
