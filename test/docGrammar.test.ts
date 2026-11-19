import { describe, expect, test } from "bun:test";
import { looksLikeXml, xmlProblem } from "../src/shared/xmlCheck";

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
