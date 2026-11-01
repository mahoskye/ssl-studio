import { expect, test } from "bun:test";
import { parseJsonc } from "../src/shared/jsonc";

test("theme files with comments and trailing commas parse", () => {
	expect(parseJsonc(`{ // c\n "a": "x // not a comment", /* b */ "b": [1, 2,], }`)).toEqual({ a: "x // not a comment", b: [1, 2] });
	expect(parseJsonc(`{ "s": "quote \\" inside", }`)).toEqual({ s: 'quote " inside' });
});

test("a trailing comma inside a string is kept", () => {
	expect(parseJsonc(`{ "s": "a, }" }`)).toEqual({ s: "a, }" });
});
