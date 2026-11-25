import { describe, expect, test } from "bun:test";
import { closedHtmlCommentSpans, commentBlockHideLines, isStandaloneHtmlComment } from "../src/shared/htmlComments";

describe("isStandaloneHtmlComment", () => {
	test("matches single-line, multi-line, and multiple standalone closed HTML comments", () => {
		expect(isStandaloneHtmlComment("<!-- plan d1003418 -->")).toBe(true);
		expect(isStandaloneHtmlComment("  <!-- catalog -->  ")).toBe(true);
		expect(isStandaloneHtmlComment("<!-- /catalog -->")).toBe(true);
		expect(isStandaloneHtmlComment("<!--\nmulti\nline\n-->")).toBe(true);
		expect(isStandaloneHtmlComment("<!-- a --> <!-- b -->")).toBe(true);
		expect(isStandaloneHtmlComment("<!-- a -->\n<!-- b -->")).toBe(true);
		expect(isStandaloneHtmlComment("<!---->")).toBe(true);
	});

	test("rejects unclosed comments, blockquoted comments, and lines containing prose", () => {
		expect(isStandaloneHtmlComment("<!-- note --> hello")).toBe(false);
		expect(isStandaloneHtmlComment("hello <!-- note -->")).toBe(false);
		expect(isStandaloneHtmlComment("> <!-- quoted -->")).toBe(false);
		expect(isStandaloneHtmlComment("<!-- unclosed")).toBe(false);
		expect(isStandaloneHtmlComment("<!-- ok --> <!-- unclosed")).toBe(false);
		expect(isStandaloneHtmlComment("<!-->")).toBe(false);
		expect(isStandaloneHtmlComment("<!--->")).toBe(false);
		expect(isStandaloneHtmlComment("")).toBe(false);
	});
});

describe("closedHtmlCommentSpans", () => {
	test("finds exact spans for inline and mixed comments without touching adjacent text", () => {
		const mixed = "<!-- note --> hello <!-- second -->!";
		const spans = closedHtmlCommentSpans(mixed);
		expect(spans).toEqual([
			{ from: 0, to: 13 },
			{ from: 20, to: 35 },
		]);
		expect(mixed.slice(spans[0]!.from, spans[0]!.to)).toBe("<!-- note -->");
		expect(mixed.slice(spans[1]!.from, spans[1]!.to)).toBe("<!-- second -->");
	});

	test("ignores unclosed comments so stray <!-- never hides the rest of a document", () => {
		expect(closedHtmlCommentSpans("hello <!-- unclosed text")).toEqual([]);
	});
});

describe("commentBlockHideLines", () => {
	test("in Live mode, hides only the comment's own lines so cursor navigation lands cleanly", () => {
		const lines = ["Intro", "", "<!-- catalog -->", "", "- item", "", "<!-- /catalog -->", ""];
		expect(commentBlockHideLines(lines, 3, 3, false)).toEqual({ startLine: 3, endLine: 3 });
		expect(commentBlockHideLines(lines, 7, 7, false)).toEqual({ startLine: 7, endLine: 7 });
	});

	test("in Read mode, absorbs duplicate blank separator around mid-doc markers and trailing blanks around EOF markers", () => {
		const lines = ["Intro", "", "<!-- catalog -->", "", "- item", "", "<!-- /catalog -->", ""];
		// Mid-document marker between two blank lines absorbs the following blank line (leaves line 2 as single separator).
		expect(commentBlockHideLines(lines, 3, 3, true)).toEqual({ startLine: 3, endLine: 4 });
		// End-of-file marker (with trailing newline empty line 8) absorbs preceding blank line 6 and empty line 8.
		expect(commentBlockHideLines(lines, 7, 7, true)).toEqual({ startLine: 6, endLine: 8 });
	});

	test("in Read mode, hides EOF <!-- plan ... --> marker with or without trailing newline", () => {
		expect(commentBlockHideLines(["```", "", "<!-- plan d1003418 -->"], 3, 3, true)).toEqual({ startLine: 2, endLine: 3 });
		expect(commentBlockHideLines(["```", "", "<!-- plan d1003418 -->", ""], 3, 3, true)).toEqual({ startLine: 2, endLine: 4 });
	});

	test("in Read mode, preserves surrounding non-blank lines when no blank separator exists", () => {
		const lines = ["Line 1", "<!-- note -->", "Line 3"];
		expect(commentBlockHideLines(lines, 2, 2, true)).toEqual({ startLine: 2, endLine: 2 });
	});
});
