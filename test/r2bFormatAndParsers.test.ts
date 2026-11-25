import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { formatDocument, loadProjectPrettierConfig } from "../src/bun/format";
import { isFenceClose, parseFenceOpen, scanQuotePrefix, stripQuotePrefix } from "../src/shared/codeTokens";
import {
	findMarkdownCodeFences,
	formatFenceBodyForMarkdown,
	replaceFencesInMarkdown,
} from "../src/shared/fencedFormat";
import { canFormatNonSsl, FORMATTABLE_NON_SSL_LANGUAGES } from "../src/shared/format";
import { level } from "../src/shared/houseStyle";
import { parseJsonc } from "../src/shared/jsonc";
import { jsonProblem } from "../src/shared/jsonCheck";
import { formatJson } from "../src/shared/jsonFormat";
import { getPath, HOUSE_STYLE, setPath } from "../src/shared/styleProfile";
import { xmlProblem } from "../src/shared/xmlCheck";

describe("R2B: codeTokens & fencedFormat (ReDoS and CommonMark accuracy)", () => {
	test("parseFenceOpen runs in linear time on 1000+ leading quote markers", () => {
		const nonFence = `${"> ".repeat(2000)}not a fence`;
		const quotedFence = `${"> ".repeat(1500)}\`\`\`js`;
		const start = performance.now();
		expect(parseFenceOpen(nonFence)).toBeNull();
		const parsed = parseFenceOpen(quotedFence);
		const elapsedMs = performance.now() - start;

		expect(parsed).not.toBeNull();
		expect(parsed?.lang).toBe("js");
		expect(scanQuotePrefix(parsed!.quotePrefix).depth).toBe(1500);
		expect(elapsedMs).toBeLessThan(200);
	});

	test("captures full info-string token and rejects backticks only on backtick fences", () => {
		expect(parseFenceOpen("~~~foo~bar")).toEqual({
			quotePrefix: "",
			fence: "~~~",
			fenceChar: "~",
			fenceLen: 3,
			lang: "foo~bar",
		});
		expect(parseFenceOpen("~~~foo`bar `baz`")).toEqual({
			quotePrefix: "",
			fence: "~~~",
			fenceChar: "~",
			fenceLen: 3,
			lang: "foo`bar",
		});
		expect(parseFenceOpen("```js`bad")).toBeNull();
		expect(parseFenceOpen("```sql``` is a tag")).toBeNull();
		expect(parseFenceOpen("```js `bad`")).toBeNull();
	});

	test("isFenceClose enforces exact quoteDepth and caps leading spaces at 0..3", () => {
		expect(isFenceClose("   ```   ", "`", 3, 0)).toBe(true);
		expect(isFenceClose("    ```", "`", 3, 0)).toBe(false);
		expect(isFenceClose("\t```", "`", 3, 0)).toBe(false);

		expect(isFenceClose("> ```", "`", 3, 1)).toBe(true);
		expect(isFenceClose(">    ```", "`", 3, 1)).toBe(true);
		expect(isFenceClose(">     ```", "`", 3, 1)).toBe(false);
		expect(isFenceClose("```", "`", 3, 1)).toBe(false);

		expect(isFenceClose("> ```", "`", 3, 2)).toBe(false);
		expect(isFenceClose("> > ```", "`", 3, 2)).toBe(true);
		expect(isFenceClose("> > > ```", "`", 3, 2)).toBe(false);
		expect(stripQuotePrefix("> > > code", 2)).toEqual({ text: "> code", offset: 4 });
	});

	test("indented ``` inside code strings does not prematurely close a fence", () => {
		const md = [
			"```js",
			"const sample = `",
			"    ```",
			"    not a closing fence",
			"`;",
			"```",
			"",
		].join("\n");
		const fences = findMarkdownCodeFences(md);
		expect(fences).toHaveLength(1);
		expect(fences[0]).toMatchObject({
			openLine: 1,
			closeLine: 6,
			bodyStartLine: 2,
			bodyEndLine: 5,
		});
		expect(fences[0]!.code).toContain("    ```");
		expect(fences[0]!.code).toContain("not a closing fence");
	});

	test("leaving a blockquote closes an unclosed quoted fence without consuming the next line", () => {
		const md = [
			"> ```js",
			"> const a = 1;",
			"```sql",
			"select 1;",
			"```",
			"",
		].join("\n");
		const fences = findMarkdownCodeFences(md);
		expect(fences).toHaveLength(2);
		expect(fences[0]).toMatchObject({
			openLine: 1,
			closeLine: null,
			bodyStartLine: 2,
			bodyEndLine: 2,
			rawLang: "js",
			code: "const a = 1;",
		});
		expect(fences[1]).toMatchObject({
			openLine: 3,
			closeLine: 5,
			bodyStartLine: 4,
			bodyEndLine: 4,
			rawLang: "sql",
			code: "select 1;",
		});

		// Depth-2 blockquote exited by depth-1 line
		const nested = [
			"> > ```js",
			"> > const x = 2;",
			"> back to depth 1",
			"",
		].join("\n");
		const nestedFences = findMarkdownCodeFences(nested);
		expect(nestedFences).toHaveLength(1);
		expect(nestedFences[0]).toMatchObject({
			openLine: 1,
			closeLine: null,
			bodyStartLine: 2,
			bodyEndLine: 2,
			code: "const x = 2;",
		});
	});

	test("unclosed fence at EOF excludes synthetic trailing empty line and preserves trailing newline", () => {
		const mdLf = "```js\nconst x=1\n";
		const fencesLf = findMarkdownCodeFences(mdLf);
		expect(fencesLf).toHaveLength(1);
		expect(fencesLf[0]).toMatchObject({
			openLine: 1,
			closeLine: null,
			bodyStartLine: 2,
			bodyEndLine: 2,
			code: "const x=1",
		});
		const replacedLf = replaceFencesInMarkdown(
			mdLf,
			fencesLf,
			new Map([[1, formatFenceBodyForMarkdown("const x = 1;\n", "", "\n")]]),
		);
		expect(replacedLf).toBe("```js\nconst x = 1;\n");

		const mdCrlf = "```js\r\nconst x=1\r\n";
		const fencesCrlf = findMarkdownCodeFences(mdCrlf);
		expect(fencesCrlf).toHaveLength(1);
		const replacedCrlf = replaceFencesInMarkdown(
			mdCrlf,
			fencesCrlf,
			new Map([[1, formatFenceBodyForMarkdown("const x = 1;\n", "", "\r\n")]]),
		);
		expect(replacedCrlf).toBe("```js\r\nconst x = 1;\r\n");
	});
});

describe("R2B: bun/format & shared/format", () => {
	test("supports pgsql and mysql languages with matching default dialects", async () => {
		expect(FORMATTABLE_NON_SSL_LANGUAGES.has("pgsql")).toBe(true);
		expect(FORMATTABLE_NON_SSL_LANGUAGES.has("mysql")).toBe(true);
		expect(canFormatNonSsl("pgsql", "queries/report.pgsql")).toBe(true);
		expect(canFormatNonSsl("mysql", "queries/report.mysql")).toBe(true);

		const pg = await formatDocument({
			path: "queries/report.sql",
			text: "select id::text, name from demo_samples where name ilike $1;",
			languageId: "pgsql",
			tabSize: 2,
			insertSpaces: true,
		});
		expect(pg.ok).toBe(true);
		if (pg.ok) {
			expect(pg.formatter).toBe("sql-formatter");
			expect(pg.text).toContain("id::text");
			expect(pg.text).toContain("$1");
			expect(pg.text).toContain("ILIKE");
		}

		const my = await formatDocument({
			path: "queries/report.sql",
			text: "select `sample_id`, `status` from `demo_samples` where `active` = 1;",
			languageId: "mysql",
			tabSize: 2,
			insertSpaces: true,
		});
		expect(my.ok).toBe(true);
		if (my.ok) {
			expect(my.formatter).toBe("sql-formatter");
			expect(my.text).toContain("`sample_id`");
			expect(my.text).toContain("SELECT");
		}
	});

	test("rejects malformed XML with mismatched, unclosed, or unexpected closing tags", async () => {
		for (const bad of [
			"<a></b>",
			"<a><b></a></b>",
			"<root><item>x</wrong></root>",
			"<root><child></root>",
			"<root><child/></root></extra>",
			"<root><!-- unclosed comment</root>",
			"<root><![CDATA[unclosed</root>",
		]) {
			const res = await formatDocument({ path: "bad.xml", text: bad, languageId: "xml" });
			expect(res.ok).toBe(false);
		}

		// Valid XML with comments, CDATA, PI, DOCTYPE, and self-closing tags still formats.
		const good = [
			'<?xml version="1.0" encoding="UTF-8"?>',
			'<!DOCTYPE note SYSTEM "note.dtd">',
			'<note id="a>b"><!-- </fake> --><to>Lab</to><![CDATA[<unbalanced>]]><empty/></note>',
		].join("");
		const res = await formatDocument({ path: "good.xml", text: good, languageId: "xml", tabSize: 2, insertSpaces: true });
		expect(res.ok).toBe(true);
		if (res.ok) {
			expect(res.text).toContain("<to>Lab</to>");
			expect(res.text).toContain("<![CDATA[<unbalanced>]]>");
			expect(res.text).toContain("<empty />");
		}
	});

	test("preserves uppercase TEMPLATE comment before trailing-space --- frontmatter and normalizes EOL to options.endOfLine", async () => {
		const dir = mkdtempSync(join(tmpdir(), "ssl-studio-r2b-md-"));
		try {
			// Force LF via .prettierrc.json while input uses CRLF.
			writeFileSync(join(dir, ".prettierrc.json"), JSON.stringify({ endOfLine: "lf" }));
			const md = [
				"<!-- TEMPLATE: ticket-note -->",
				"---   ",
				"ticket: DEMO-104",
				"status: open",
				"---",
				"",
				"|Col|Val|",
				"|---|---|",
				"|a|1|",
				"",
			].join("\r\n");
			const res = await formatDocument(
				{ path: join(dir, "note.md"), text: md, languageId: "markdown" },
				dir,
			);
			expect(res.ok).toBe(true);
			if (!res.ok) return;
			expect(res.text).not.toContain("\r\n");
			expect(res.text.startsWith("<!-- TEMPLATE: ticket-note -->\n---")).toBe(true);
			expect(res.text).toContain("ticket: DEMO-104\nstatus: open");
			expect(res.text).toContain("| Col | Val |");
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test(".prettierrc.yml ignores indented overrides, strips comments outside quotes, and guards single-char quotes", () => {
		const dir = mkdtempSync(join(tmpdir(), "ssl-studio-r2b-rc-"));
		try {
			writeFileSync(
				join(dir, ".prettierrc.yml"),
				[
					"singleQuote: true # top-level comment",
					"tabWidth: 2",
					'endOfLine: "lf" # quoted value with trailing comment',
					'quoteProps: "',
					"overrides:",
					'  - files: "*.md"',
					"    options:",
					"      tabWidth: 8",
					"      singleQuote: false",
					"",
				].join("\n"),
			);
			const cfg = loadProjectPrettierConfig(join(dir, "index.js"), dir);
			expect(cfg.singleQuote).toBe(true);
			expect(cfg.tabWidth).toBe(2);
			expect(cfg.endOfLine).toBe("lf");
			expect(cfg.quoteProps).toBe('"');
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("loadProjectPrettierConfig rejects relative/untitled paths and handles root workspace", () => {
		expect(loadProjectPrettierConfig("Untitled-1")).toEqual({});
		expect(loadProjectPrettierConfig("__fence__.js")).toEqual({});
		expect(loadProjectPrettierConfig("relative/file.js")).toEqual({});
		expect(loadProjectPrettierConfig("untitled:Untitled-1")).toEqual({});

		const dir = mkdtempSync(join(tmpdir(), "ssl-studio-r2b-root-"));
		try {
			writeFileSync(join(dir, ".prettierrc.json"), JSON.stringify({ semi: false }));
			// With root `/` on POSIX, files inside tmpdir are still inside root.
			if (process.platform !== "win32") {
				expect(loadProjectPrettierConfig(join(dir, "app.js"), "/")).toEqual({ semi: false });
			}
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("guards NaN and Infinity tabSize/printWidth for both Prettier and SQL", async () => {
		const js = await formatDocument({
			path: "a.js",
			text: "function f(){return 1}",
			languageId: "javascript",
			tabSize: Number.NaN,
			printWidth: Number.NaN,
			insertSpaces: true,
		});
		expect(js.ok).toBe(true);
		if (js.ok) expect(js.text).toBe("function f() {\n    return 1;\n}\n");

		const sql = await formatDocument({
			path: "a.sql",
			text: "select a, b from t where a = 1;",
			languageId: "sql",
			tabSize: Number.NaN,
			printWidth: Number.POSITIVE_INFINITY,
			insertSpaces: true,
		});
		expect(sql.ok).toBe(true);
		if (sql.ok) expect(sql.text).toContain("SELECT\n    a,");
	});
});

describe("R2B: parseJsonc", () => {
	test("strips leading UTF-8 BOM", () => {
		expect(parseJsonc('\uFEFF{"a": 1, /* ok */ "b": 2,}')).toEqual({ a: 1, b: 2 });
	});

	test("never pastes tokens across block or line comments", () => {
		expect(() => parseJsonc("[1/*c*/2]")).toThrow(SyntaxError);
		expect(() => parseJsonc("[tru/*c*/e]")).toThrow(SyntaxError);
		expect(() => parseJsonc("[1//c\n2]")).toThrow(SyntaxError);
	});

	test("rejects trailing comma at EOF", () => {
		expect(() => parseJsonc('{"a": 1},')).toThrow(SyntaxError);
		expect(() => parseJsonc("[1, 2],")).toThrow(SyntaxError);
		expect(() => parseJsonc('{"a": 1}, // trailing comment')).toThrow(SyntaxError);
	});

	test("throws SyntaxError on unterminated block comment", () => {
		expect(() => parseJsonc('{"a": 1} /* unclosed')).toThrow("Unterminated block comment");
		expect(() => parseJsonc('{"a": 1, /* unclosed')).toThrow("Unterminated block comment");
		expect(() => parseJsonc("/*/")).toThrow("Unterminated block comment");
	});
});

describe("R2B: jsonCheck & jsonFormat deep nesting", () => {
	test("reports invalid deeply nested JSON instead of returning null on stack overflow", () => {
		const broken = "[".repeat(50_000) + "BROKEN";
		const problem = jsonProblem(broken);
		expect(problem).not.toBeNull();
		expect(problem?.offset).toBe(50_000);
		expect(problem?.length).toBe(6);
		expect(problem?.message).toContain("BROKEN");

		const unclosed = "[".repeat(5_000) + "1";
		const unclosedProblem = jsonProblem(unclosed);
		expect(unclosedProblem).not.toBeNull();
		expect(unclosedProblem?.message).toContain("never closed");

		// Valid deeply nested JSON still parses iteratively without overflowing the call stack.
		expect(jsonProblem("[".repeat(50_000) + "]".repeat(50_000))).toBeNull();
	});

	test("formatJson safely returns null without OOM on deeply nested valid or invalid JSON", () => {
		expect(formatJson("[".repeat(50_000) + "BROKEN")).toBeNull();
		expect(formatJson("[".repeat(5_000) + "]".repeat(5_000))).toBeNull();
	});
});

describe("R2B: xmlProblem Gecko/Firefox DOMParser errors", () => {
	test("extracts line, column, and message from Gecko DOMParser errors", () => {
		const gecko = [
			"XML Parsing Error: mismatched tag. Expected: </appSettings>.",
			"Location: http://localhost/",
			"Line Number 3, Column 7:",
			"<configuration><appSettings></configuration>",
			"----------------------------^",
		].join("\n");
		expect(xmlProblem(gecko)).toEqual({
			line: 3,
			column: 7,
			message: "Mismatched tag. Expected: </appSettings>.",
		});

		const noPeriod = "XML Parsing Error: not well-formed\nLine Number 12, Column 4:";
		expect(xmlProblem(noPeriod)).toEqual({
			line: 12,
			column: 4,
			message: "Not well-formed.",
		});
	});
});

describe("R2B: houseStyle.level & styleProfile paths", () => {
	test("houseStyle.level treats limit <= 0 or NaN as off ('ok')", () => {
		expect(level(100, 0)).toBe("ok");
		expect(level(0, 0)).toBe("ok");
		expect(level(500, -10)).toBe("ok");
		expect(level(100, Number.NaN)).toBe("ok");
		expect(level(370, 400)).toBe("near");
		expect(level(401, 400)).toBe("over");
	});

	test("styleProfile.setPath prunes empty parent objects when deleting leaves", () => {
		const single = setPath({}, "format.sql.style", "expanded");
		expect(single).toEqual({ format: { sql: { style: "expanded" } } });
		expect(setPath(single, "format.sql.style", undefined)).toEqual({});

		// Sibling keys prevent pruning non-empty parents.
		const two = setPath(single, "format.indentSize", 2);
		expect(setPath(two, "format.sql.style", undefined)).toEqual({ format: { indentSize: 2 } });

		// Deleting a non-existent path does not fabricate empty parent containers.
		expect(setPath({}, "format.sql.style", undefined)).toEqual({});
	});

	test("styleProfile getPath & setPath support segment arrays for dotted rule keys", () => {
		const dottedPath = ["diagnostics", "rules", "ssl.naming.hungarian"] as const;
		const updated = setPath({}, dottedPath, "warning");
		expect(updated).toEqual({
			diagnostics: {
				rules: {
					"ssl.naming.hungarian": "warning",
				},
			},
		});
		expect(getPath(updated, dottedPath)).toBe("warning");
		// Dotted key must not be split into nested objects.
		expect(getPath(updated, "diagnostics.rules.ssl")).toBeUndefined();
		// Deleting prunes empty parents cleanly.
		expect(setPath(updated, dottedPath, undefined)).toEqual({});

		// Explicit "default" can override a HOUSE_STYLE "off" rule without deleting it.
		const resetHouseRule = setPath({}, ["diagnostics", "rules", "c_style_comment_closer"], "default");
		expect(getPath(HOUSE_STYLE, ["diagnostics", "rules", "c_style_comment_closer"])).toBe("off");
		expect(getPath(resetHouseRule, ["diagnostics", "rules", "c_style_comment_closer"])).toBe("default");
	});
});
