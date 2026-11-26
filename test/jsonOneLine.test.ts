// A JSON document on one line is laid out by "Format document" (shared/jsonFormat.ts `jsonOpenedOut`, ADR 0040):
// the sign it is handed to Prettier with, and then Prettier itself asked, since it is its reading of that sign
// the layout rests on.
import { describe, expect, test } from "bun:test";
import { formatDocument } from "../src/bun/format";
import { jsonOpenedOut } from "../src/shared/jsonFormat";

describe("a JSON document on one line, with each of its objects opened", () => {
	test("a line break goes in after each { that opens an object with something in it, and nothing else changes", () => {
		expect(jsonOpenedOut('{"a":1}')).toBe('{\n"a":1}');
		expect(jsonOpenedOut('{"a":{"b":[{"c":2},{ "d":3}]}}')).toBe('{\n"a":{\n"b":[{\n"c":2},{\n "d":3}]}}');
		expect(jsonOpenedOut('[{"a":1},{"a":2}]')).toBe('[{\n"a":1},{\n"a":2}]');
		// A line's end after the document is no second line.
		expect(jsonOpenedOut('  {"a":1}\r\n')).toBe('  {\n"a":1}\r\n');
		// Every opened document is the same document.
		const text = '{"a":{"b":[{"c":2},{}]},"s":"{ \\" { }"}';
		expect(JSON.parse(jsonOpenedOut(text)!)).toEqual(JSON.parse(text));
	});

	test("a { in a string is text, and an empty object stays shut", () => {
		expect(jsonOpenedOut('{"s":"{ not {\\" one }","e":{},"f":{ }}')).toBe('{\n"s":"{ not {\\" one }","e":{},"f":{ }}');
		expect(jsonOpenedOut('["{", "\\\\", {"a":"\\\\"}]')).toBe('["{", "\\\\", {\n"a":"\\\\"}]');
	});

	test("nothing to do: lines already, no object to open, or not JSON", () => {
		// A document somebody laid out keeps its layout: a row kept on one line is theirs.
		expect(jsonOpenedOut('{\n\t"points": [{ "x": 1, "y": 2 }]\n}\n')).toBeNull();
		expect(jsonOpenedOut('{"a":1,\n"b":2}')).toBeNull();
		expect(jsonOpenedOut("[1,2,3]")).toBeNull();
		expect(jsonOpenedOut('"alone"')).toBeNull();
		expect(jsonOpenedOut("{}")).toBeNull();
		expect(jsonOpenedOut("[{},{ }]")).toBeNull();
		expect(jsonOpenedOut("")).toBeNull();
		expect(jsonOpenedOut("  \n")).toBeNull();
		// Not JSON (a comment, a comma too many, a quote of another kind, cut short): left for the formatter to say.
		expect(jsonOpenedOut('{"a":1, /* note */ "b":2}')).toBeNull();
		expect(jsonOpenedOut('{"a":1,}')).toBeNull();
		expect(jsonOpenedOut("{'a':1}")).toBeNull();
		expect(jsonOpenedOut('{"a":{"b":1}')).toBeNull();
	});
});

describe('"Format document" on a JSON document, by the formatter itself', () => {
	const format = async (text: string, path = "payload.json") => {
		const result = await formatDocument({ path, text: jsonOpenedOut(text) ?? text, languageId: "json", tabSize: 4, insertSpaces: false, printWidth: 90 });
		if (!result.ok) throw new Error(result.error);
		return result.text;
	};

	test("a document on one line is laid out: a property to a line at every depth, a short list on its line", async () => {
		const text = '{"sampleId":"S-1","tests":[{"code":"PH","value":7.1},{"code":"TEMP","value":21}],"tags":["a","b"],"n":{"x":{"y":1}},"e":{},"l":[]}';
		const laidOut = await format(text);
		expect(laidOut.split("\n")).toEqual([
			"{",
			'\t"sampleId": "S-1",',
			'\t"tests": [',
			"\t\t{",
			'\t\t\t"code": "PH",',
			'\t\t\t"value": 7.1',
			"\t\t},",
			"\t\t{",
			'\t\t\t"code": "TEMP",',
			'\t\t\t"value": 21',
			"\t\t}",
			"\t],",
			'\t"tags": ["a", "b"],',
			'\t"n": {',
			'\t\t"x": {',
			'\t\t\t"y": 1',
			"\t\t}",
			"\t},",
			'\t"e": {},',
			'\t"l": []',
			"}",
			"",
		]);
		expect(JSON.parse(laidOut)).toEqual(JSON.parse(text));
		// Formatted again it is a document with lines, and stays as it is.
		expect(jsonOpenedOut(laidOut)).toBeNull();
		expect(await format(laidOut)).toBe(laidOut);
	});

	test("the smallest of them too, which fits any line", async () => {
		expect(await format('{"enabled":true}')).toBe('{\n\t"enabled": true\n}\n');
		expect(await format('[{"a":1},{"a":2}]')).toBe('[\n\t{\n\t\t"a": 1\n\t},\n\t{\n\t\t"a": 2\n\t}\n]\n');
		// With no object in it there is nothing to open: a list that fits stays on its line.
		expect(await format("[1,2,3]")).toBe("[1, 2, 3]\n");
	});

	test("a number and a string come out as they went in", async () => {
		expect(await format('{"n":1.0e10,"big":12345678901234567890,"u":"\\u00e9 {"}')).toBe('{\n\t"n": 1.0e10,\n\t"big": 12345678901234567890,\n\t"u": "\\u00e9 {"\n}\n');
	});

	test("a document somebody laid out keeps the rows they kept short", async () => {
		const rows = '{\n\t"points": [\n\t\t{ "x": 1, "y": 2 },\n\t\t{ "x": 3, "y": 4 }\n\t]\n}\n';
		expect(await format(rows)).toBe(rows);
	});

	test("a code block in a document is not a document: on one line it stays on it", async () => {
		// What "Format code block" sends: the block's text as it is.
		const block = await formatDocument({ path: "docs/api.md.fence.json", text: '{"ok":true,"items":[1,2]}', languageId: "json", tabSize: 2, insertSpaces: true });
		expect(block).toMatchObject({ ok: true, text: '{ "ok": true, "items": [1, 2] }\n' });
	});
});
