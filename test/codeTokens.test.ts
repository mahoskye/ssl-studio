import { describe, expect, test } from "bun:test";
import {
	isFenceClose,
	normalizeFenceLang,
	parseFenceOpen,
	parseMonacoColorizedHtml,
	stripQuotePrefix,
} from "../src/shared/codeTokens";

describe("parseMonacoColorizedHtml", () => {
	test("extracts exact UTF-16 column spans and mtk classes per line", () => {
		const html =
			'<span><span class="mtk6 mtkb">:DECLARE</span><span class="mtk1">&nbsp;sMsg;</span></span><br/>' +
			'<span><span class="mtk1">sMsg&nbsp;</span><span class="mtk8">:=</span><span class="mtk1">&nbsp;</span><span class="mtk5">&quot;hi&quot;</span><span class="mtk1">;</span></span><br/>';
		expect(parseMonacoColorizedHtml(html)).toEqual([
			[
				{ from: 0, to: 8, className: "mtk6 mtkb" },
				{ from: 8, to: 14, className: "mtk1" },
			],
			[
				{ from: 0, to: 5, className: "mtk1" },
				{ from: 5, to: 7, className: "mtk8" },
				{ from: 7, to: 8, className: "mtk1" },
				{ from: 8, to: 12, className: "mtk5" },
				{ from: 12, to: 13, className: "mtk1" },
			],
		]);
	});

	test("counts decoded HTML entities accurately (<, >, &, quotes, null, astral)", () => {
		// Original line: `if (a < b && c > 0) // 😀`
		const html =
			'<span><span class="mtk6">if</span><span class="mtk1">&nbsp;(a&nbsp;&lt;&nbsp;b&nbsp;&amp;&amp;&nbsp;c&nbsp;&gt;&nbsp;0)&nbsp;</span><span class="mtk4 mtki">//&nbsp;😀</span></span><br/>';
		const [line] = parseMonacoColorizedHtml(html);
		expect(line).toEqual([
			{ from: 0, to: 2, className: "mtk6" },
			{ from: 2, to: 20, className: "mtk1" },
			{ from: 20, to: 25, className: "mtk4 mtki" },
		]);
		expect("if (a < b && c > 0) // 😀".length).toBe(25);
	});

	test("handles RTL style attribute before class, filters non-mtk classes, and merges adjacent runs", () => {
		const html =
			'<span><span style="unicode-bidi:isolate" class="mtk5 mtkfullwidth">abc</span><span class="mtk5">def</span><span class="mtkoverflow">x</span><span class="mtk7 mtku mtks">yz</span></span><br/>';
		expect(parseMonacoColorizedHtml(html)).toEqual([
			[
				{ from: 0, to: 6, className: "mtk5" },
				{ from: 7, to: 9, className: "mtk7 mtku mtks" },
			],
		]);
	});

	test("preserves empty lines and applies bomPrefix offset only on line 0", () => {
		const html =
			'<span><span class="mtk6">SELECT</span></span><br/>' +
			"<span><span></span></span><br/>" +
			'<span><span class="mtk1">1;</span></span><br/>';
		expect(parseMonacoColorizedHtml(html, { bomPrefix: true })).toEqual([
			[{ from: 1, to: 7, className: "mtk6" }],
			[],
			[{ from: 0, to: 2, className: "mtk1" }],
		]);
	});
});

describe("fenced code header, closer, and quote helpers", () => {
	test("parses backtick, tilde, indented, and blockquoted fence openings", () => {
		expect(parseFenceOpen("```ssl")).toEqual({ quotePrefix: "", fence: "```", fenceChar: "`", fenceLen: 3, lang: "ssl" });
		expect(parseFenceOpen("  ~~~~sql title=query")).toEqual({ quotePrefix: "", fence: "~~~~", fenceChar: "~", fenceLen: 4, lang: "sql" });
		expect(parseFenceOpen("> ```SSL")).toEqual({ quotePrefix: "> ", fence: "```", fenceChar: "`", fenceLen: 3, lang: "SSL" });
		expect(parseFenceOpen("```js `bad`")).toBeNull();
	});

	test("matches closing fences by delimiter character and minimum length", () => {
		expect(isFenceClose("```", "`", 3, false)).toBe(true);
		expect(isFenceClose("````", "`", 3, false)).toBe(true);
		expect(isFenceClose("```", "`", 4, false)).toBe(false);
		expect(isFenceClose("~~~", "`", 3, false)).toBe(false);
		expect(isFenceClose("> ```  ", "`", 3, true)).toBe(true);
	});

	test("strips blockquote prefixes only for quoted fences", () => {
		expect(stripQuotePrefix("> :DECLARE n;", true)).toEqual({ text: ":DECLARE n;", offset: 2 });
		expect(stripQuotePrefix("> 0", false)).toEqual({ text: "> 0", offset: 0 });
	});

	test("normalizes fence language aliases", () => {
		expect(normalizeFenceLang("SSL")).toBe("ssl");
		expect(normalizeFenceLang("srvscr")).toBe("ssl");
		expect(normalizeFenceLang("yml")).toBe("yaml");
		expect(normalizeFenceLang("bash")).toBe("shell");
		expect(normalizeFenceLang("jsonc")).toBe("json");
		expect(normalizeFenceLang("tsv")).toBe("csv");
		expect(normalizeFenceLang("ps1")).toBe("powershell");
		expect(normalizeFenceLang("py")).toBe("python");
		expect(normalizeFenceLang("c#")).toBe("csharp");
		expect(normalizeFenceLang("ts title=example")).toBe("typescript");
	});
});
