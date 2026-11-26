import { describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { canFormatNonSsl, DEFAULT_SQL_DIALECT, isSqlDialect, sqlDialectInfo } from "../src/shared/format";
import {
	fenceAtLine,
	fenceFormatTarget,
	findMarkdownCodeFences,
	formatFenceBodyForMarkdown,
	replaceFencesInMarkdown,
	sqlDialectFromFenceLang,
	virtualFencePath,
} from "../src/shared/fencedFormat";
import { formatDocument, loadProjectPrettierConfig } from "../src/bun/format";

describe("shared formatting guards and dialect helpers", () => {
	test("allows non-SSL companion languages and excludes SSL and plans", () => {
		expect(canFormatNonSsl("sql", "schema/database/demo.sql")).toBe(true);
		expect(canFormatNonSsl("javascript", "forms/Login.js")).toBe(true);
		expect(canFormatNonSsl("typescript", "tools/check.ts")).toBe(true);
		expect(canFormatNonSsl("html", "forms/SampleEntry.html")).toBe(true);
		expect(canFormatNonSsl("css", "forms/SampleEntry.css")).toBe(true);
		expect(canFormatNonSsl("scss", "forms/SampleEntry.scss")).toBe(true);
		expect(canFormatNonSsl("less", "forms/SampleEntry.less")).toBe(true);
		expect(canFormatNonSsl("xml", "forms/SampleEntry.xfd")).toBe(true);
		expect(canFormatNonSsl("json", "schema/interfaces/order.json")).toBe(true);
		expect(canFormatNonSsl("yaml", "schema/interfaces/api.yaml")).toBe(true);
		expect(canFormatNonSsl("markdown", "docs/README.md")).toBe(true);

		// ADR 0003: starlims-lsp owns SSL exclusively.
		expect(canFormatNonSsl("ssl", "Sample/Release.ssl")).toBe(false);
		// A data source is the server's as SSL, and in any mode but SQL; shown as SQL it has been read as an SQL
		// data source (ADR 0038), and its SQL is formatted as SQL.
		expect(canFormatNonSsl("ssl", "Sample/Query.ds")).toBe(false);
		expect(canFormatNonSsl("javascript", "Sample/Query.ds")).toBe(false);
		expect(canFormatNonSsl("sql", "Sample/Query.ds")).toBe(true);
		expect(canFormatNonSsl("javascript", "Sample/Run.srvscr")).toBe(false);

		// Plans keep their own deterministic line-per-node printer.
		expect(canFormatNonSsl("json", "design/Release.plan.json")).toBe(false);

		// Unsupported languages stay untouched.
		expect(canFormatNonSsl("plaintext", "notes.txt")).toBe(false);
		expect(canFormatNonSsl("toml", ".ssl-studio/project.toml")).toBe(false);
		expect(canFormatNonSsl("csv", "docs/registries/tables.csv")).toBe(false);
		expect(canFormatNonSsl("csharp", "bridge/Helper.cs")).toBe(false);
	});

	test("recognizes SQL dialects and defaults to T-SQL", () => {
		expect(DEFAULT_SQL_DIALECT).toBe("tsql");
		expect(isSqlDialect("tsql")).toBe(true);
		expect(isSqlDialect("plsql")).toBe(true);
		expect(isSqlDialect("postgresql")).toBe(true);
		expect(isSqlDialect("bogus")).toBe(false);
		expect(sqlDialectInfo(undefined).id).toBe("tsql");
		expect(sqlDialectInfo("plsql").short).toBe("PL/SQL");
	});
});

describe("backend formatDocument", () => {
	test("refuses SSL files so starlims-lsp stays the sole SSL formatter", async () => {
		const byLang = await formatDocument({ path: "a.ssl", text: ":PROCEDURE Test;\n:ENDPROC;\n", languageId: "ssl" });
		expect(byLang.ok).toBe(false);
		const byExt = await formatDocument({ path: "Query.ds", text: ":DECLARE x;", languageId: "ssl" });
		expect(byExt.ok).toBe(false);
		// A data source in a mode that is neither SSL nor SQL is still not for that mode's formatter.
		const otherMode = await formatDocument({ path: "Query.ds", text: "x = 1", languageId: "javascript" });
		expect(otherMode.ok).toBe(false);
		const bySrvscr = await formatDocument({ path: "Run.srvscr", text: "x := 1;", languageId: "javascript" });
		expect(bySrvscr.ok).toBe(false);
		// A script shown as SQL by hand is a script still.
		const scriptAsSql = await formatDocument({ path: "Run.ssl", text: "select 1", languageId: "sql" });
		expect(scriptAsSql.ok).toBe(false);
	});

	test("formats the SQL of a data source the view has read as SQL (ADR 0038)", async () => {
		const sql = await formatDocument({ path: "src/Orders/OpenSamples.ds", text: "select s.sample_id from demo_samples s where s.due_on < @dFrom\n", languageId: "sql" });
		expect(sql.ok).toBe(true);
		if (!sql.ok) return;
		expect(sql.formatter).toBe("sql-formatter");
		expect(sql.text).toContain("SELECT");
		expect(sql.text).toContain("@dFrom");
		// No `;` is added: a data source's SQL runs as one command, and STARLIMS refuses one with a `;` in it.
		expect(sql.text).not.toContain(";");
	});

	test("formats SQL Server T-SQL and preserves idempotency and CRLF", async () => {
		const messy = "select top 5 s.sample_id, isnull(s.instrument_id, 'NONE') as inst from demo_samples s where s.received_on >= @StartDate order by s.received_on desc;";
		const first = await formatDocument({
			path: "schema/database/query.sql",
			text: messy,
			languageId: "sql",
			tabSize: 4,
			insertSpaces: true,
			sqlDialect: "tsql",
			sqlKeywordCase: "upper",
		});
		expect(first.ok).toBe(true);
		if (!first.ok) return;
		expect(first.formatter).toBe("sql-formatter");
		expect(first.changed).toBe(true);
		expect(first.text).toContain("SELECT\n");
		expect(first.text).toContain("FROM\n    demo_samples s");
		expect(first.text).toContain("WHERE\n    s.received_on >= @StartDate");
		expect(first.text.endsWith("\n")).toBe(true);

		// Formatting a second time produces identical output.
		const second = await formatDocument({
			path: "schema/database/query.sql",
			text: first.text,
			languageId: "sql",
			tabSize: 4,
			insertSpaces: true,
			sqlDialect: "tsql",
			sqlKeywordCase: "upper",
		});
		expect(second).toEqual({ ok: true, text: first.text, changed: false, formatter: "sql-formatter" });

		// CRLF line endings and tabs are preserved when requested.
		const crlf = await formatDocument({
			path: "schema/database/query.sql",
			text: "select a, b\r\nfrom demo_samples\r\nwhere a = 1;",
			languageId: "sql",
			insertSpaces: false,
			sqlDialect: "tsql",
			sqlKeywordCase: "lower",
		});
		expect(crlf.ok).toBe(true);
		if (!crlf.ok) return;
		expect(crlf.text).toContain("\r\n");
		expect(crlf.text).toContain("select\r\n\ta,");
	});

	test("formats Oracle PL/SQL and the demo.sql example cleanly", async () => {
		const plsql = await formatDocument({
			path: "schema/database/ora.sql",
			text: "select s.sample_id, nvl(s.instrument_id, 'NONE') from demo_samples s where s.received_on >= :start_date and rownum <= 10;",
			languageId: "sql",
			sqlDialect: "plsql",
			sqlKeywordCase: "upper",
		});
		expect(plsql.ok).toBe(true);
		if (!plsql.ok) return;
		expect(plsql.text).toContain(":start_date");
		expect(plsql.text).toContain("SELECT");

		const demoPath = join(import.meta.dir, "../examples/due-dates/schema/database/DEMO_SAMPLES.sql");
		const demoText = await Bun.file(demoPath).text();
		const res = await formatDocument({
			path: demoPath,
			text: demoText,
			languageId: "sql",
			tabSize: 4,
			insertSpaces: true,
			sqlDialect: "tsql",
		});
		expect(res.ok).toBe(true);
		if (!res.ok) return;
		expect(res.text).toContain("CREATE TABLE DEMO_SAMPLES (");

		const seedPath = join(import.meta.dir, "../examples/due-dates/schema/database/demo-seed.sql");
		const seedRes = await formatDocument({
			path: seedPath,
			text: await Bun.file(seedPath).text(),
			languageId: "sql",
			tabSize: 4,
			insertSpaces: true,
			sqlDialect: "tsql",
		});
		expect(seedRes.ok).toBe(true);
		if (!seedRes.ok) return;
		expect(seedRes.text).toContain("INSERT INTO");
		expect(seedRes.text).toContain("'S-1007'");
		const again = await formatDocument({
			path: demoPath,
			text: res.text,
			languageId: "sql",
			tabSize: 4,
			insertSpaces: true,
			sqlDialect: "tsql",
		});
		expect(again.ok && !again.changed).toBe(true);
	});

	test("returns a clear error on broken SQL without throwing", async () => {
		const res = await formatDocument({
			path: "broken.sql",
			text: "SELECT (1 + 2 FROM demo_samples",
			languageId: "sql",
			sqlDialect: "tsql",
		});
		expect(res.ok).toBe(false);
		if (!res.ok) expect(res.error.length).toBeGreaterThan(0);
	});

	test("formats JavaScript, TypeScript, HTML, CSS, SCSS, and Less via Prettier", async () => {
		const js = await formatDocument({ path: "forms/grid.js", text: "function onLoad(e){const x=1+2;return x}", languageId: "javascript", tabSize: 2, insertSpaces: true });
		expect(js.ok).toBe(true);
		if (js.ok) expect(js.text).toBe("function onLoad(e) {\n  const x = 1 + 2;\n  return x;\n}\n");

		const ts = await formatDocument({ path: "tools/helper.ts", text: "export const add=(a:number,b:number):number=>a+b", languageId: "typescript", tabSize: 2, insertSpaces: true });
		expect(ts.ok).toBe(true);
		if (ts.ok) expect(ts.text).toBe("export const add = (a: number, b: number): number => a + b;\n");

		const html = await formatDocument({ path: "forms/view.html", text: "<div><span class=\"a\">Hi</span><script>const x=1</script></div>", languageId: "html", tabSize: 2, insertSpaces: true });
		expect(html.ok).toBe(true);
		if (html.ok) {
			expect(html.text).toContain('<span class="a">Hi</span>');
			expect(html.text).toContain("const x = 1;");
		}

		const css = await formatDocument({ path: "forms/view.css", text: ".card{color:red;padding:4px 8px}", languageId: "css", tabSize: 2, insertSpaces: true });
		expect(css.ok).toBe(true);
		if (css.ok) expect(css.text).toBe(".card {\n  color: red;\n  padding: 4px 8px;\n}\n");

		const scss = await formatDocument({ path: "forms/view.scss", text: "$c:#333;.a{.b{color:$c}}", languageId: "scss", tabSize: 2, insertSpaces: true });
		expect(scss.ok).toBe(true);
		if (scss.ok) expect(scss.text).toContain("color: $c;");

		const less = await formatDocument({ path: "forms/view.less", text: "@c:#333;.a{.b{color:@c}}", languageId: "less", tabSize: 2, insertSpaces: true });
		expect(less.ok).toBe(true);
		if (less.ok) expect(less.text).toContain("color: @c;");
	});

	test("formats STARLIMS XML / XFD / config files via @prettier/plugin-xml", async () => {
		const xfd = '<Form id="DEMO_ENTRY" version="1.0"><Controls><TextBox name="txtSample" label=\'Sample ID\'>S-1001</TextBox><Button name="btnSave"/></Controls></Form>';
		const res = await formatDocument({ path: "forms/DEMO_ENTRY.xfd", text: xfd, languageId: "xml", tabSize: 2, insertSpaces: true });
		expect(res.ok).toBe(true);
		if (!res.ok) return;
		expect(res.formatter).toBe("prettier");
		expect(res.text).toContain('<Form id="DEMO_ENTRY" version="1.0">\n  <Controls>');
		// Preserves attribute quotes and element text values (ADR 0015).
		expect(res.text).toContain("label='Sample ID'");
		expect(res.text).toContain(">S-1001</TextBox>");
		expect(res.text).toContain('<Button name="btnSave" />');

		const broken = await formatDocument({ path: "Web.config", text: "<configuration><appSettings></configuration>", languageId: "xml" });
		expect(broken.ok).toBe(false);
	});

	test("formats JSON and JSONC without trailing commas and leaves .plan.json untouched", async () => {
		const json = await formatDocument({ path: "schema/interfaces/order.json", text: '{"sample":"S-1","items":[1,2,3]}', languageId: "json", tabSize: 2, insertSpaces: true });
		expect(json.ok).toBe(true);
		if (json.ok) {
			expect(() => JSON.parse(json.text)).not.toThrow();
			expect(json.text).toBe('{ "sample": "S-1", "items": [1, 2, 3] }\n');
		}

		const jsonc = await formatDocument({ path: "settings.jsonc", text: '{\n// comment\n"a":1,\n"b":2\n}', languageId: "json", tabSize: 2, insertSpaces: true });
		expect(jsonc.ok).toBe(true);
		if (jsonc.ok) {
			expect(jsonc.text).toContain("// comment");
			expect(jsonc.text).not.toContain('"b": 2,');
		}

		const planRaw = '{"version":1,"title":"T","nodes":[{"id":"n1","kind":"start","text":"Go"}],"edges":[]}\n';
		const plan = await formatDocument({ path: "design/T.plan.json", text: planRaw, languageId: "json" });
		expect(plan).toEqual({ ok: true, text: planRaw, changed: false, formatter: "prettier" });
	});

	test("formats YAML and Markdown while preserving frontmatter, callouts, wikilinks, and catalog comments", async () => {
		const yaml = await formatDocument({ path: "schema/interfaces/api.yaml", text: "openapi:   3.0.0\ninfo:\n  title:   Due dates\n", languageId: "yaml", tabSize: 2, insertSpaces: true });
		expect(yaml.ok).toBe(true);
		if (yaml.ok) expect(yaml.text).toBe("openapi: 3.0.0\ninfo:\n  title: Due dates\n");

		const md = [
			"---",
			"ticket: DEMO-103",
			"status: in progress",
			"---",
			"",
			"> [!IMPORTANT]",
			"> See [[Due-dates]] for details.",
			"",
			"<!-- catalog -->",
			"- [Item](docs/item.md)",
			"<!-- /catalog -->",
			"",
			"|Col|Val|",
			"|---|---|",
			"|a|123|",
			"",
		].join("\n");
		const res = await formatDocument({ path: "docs/notes.md", text: md, languageId: "markdown" });
		expect(res.ok).toBe(true);
		if (!res.ok) return;
		expect(res.text).toContain("ticket: DEMO-103\nstatus: in progress");
		expect(res.text).toContain("> [!IMPORTANT]");
		expect(res.text).toContain("[[Due-dates]]");
		expect(res.text).toContain("<!-- catalog -->");
		expect(res.text).toContain("| Col | Val |");
	});

	test("honors workspace .prettierrc.json and does not escape workspaceRoot", async () => {
		const dir = mkdtempSync(join(tmpdir(), "ssl-studio-fmt-"));
		const inner = join(dir, "workspace");
		const nested = join(inner, "forms");
		mkdirSync(nested, { recursive: true });
		try {
			// Outside workspace: should NOT be read when workspaceRoot is `inner`.
			writeFileSync(join(dir, ".prettierrc.json"), JSON.stringify({ singleQuote: true, semi: false }));
			expect(loadProjectPrettierConfig(join(nested, "app.js"), inner)).toEqual({});

			// Inside workspace: honored.
			writeFileSync(join(inner, ".prettierrc.json"), JSON.stringify({ singleQuote: true, semi: false, tabWidth: 2 }));
			const res = await formatDocument(
				{ path: join(nested, "app.js"), text: 'const msg = "hello";\n', languageId: "javascript", tabSize: 4, insertSpaces: true },
				inner,
			);
			expect(res.ok).toBe(true);
			if (res.ok) expect(res.text).toBe("const msg = 'hello'\n");
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});

describe("Markdown fenced code block formatting helpers", () => {
	test("resolves SSL, SQL dialect overrides, and STARLIMS companion fence languages", () => {
		expect(fenceFormatTarget("ssl")).toEqual({ languageId: "ssl" });
		expect(fenceFormatTarget("srvscr")).toEqual({ languageId: "ssl" });
		expect(fenceFormatTarget("ds")).toEqual({ languageId: "ssl" });
		expect(fenceFormatTarget("starlims")).toEqual({ languageId: "ssl" });

		expect(fenceFormatTarget("sql")).toEqual({ languageId: "sql", sqlDialectOverride: undefined });
		expect(fenceFormatTarget("tsql")).toEqual({ languageId: "sql", sqlDialectOverride: "tsql" });
		expect(fenceFormatTarget("plsql")).toEqual({ languageId: "sql", sqlDialectOverride: "plsql" });
		expect(fenceFormatTarget("postgres")).toEqual({ languageId: "sql", sqlDialectOverride: "postgresql" });
		expect(fenceFormatTarget("mysql")).toEqual({ languageId: "sql", sqlDialectOverride: "mysql" });
		expect(fenceFormatTarget("sqlite")).toEqual({ languageId: "sql", sqlDialectOverride: "sqlite" });
		expect(sqlDialectFromFenceLang("pgsql")).toBe("postgresql");

		expect(fenceFormatTarget("xfd")).toEqual({ languageId: "xml", sqlDialectOverride: undefined });
		expect(fenceFormatTarget("wsdl")).toEqual({ languageId: "xml", sqlDialectOverride: undefined });
		expect(fenceFormatTarget("jsonc")).toEqual({ languageId: "json", sqlDialectOverride: undefined });
		expect(fenceFormatTarget("js")).toEqual({ languageId: "javascript", sqlDialectOverride: undefined });
		expect(fenceFormatTarget("ts")).toEqual({ languageId: "typescript", sqlDialectOverride: undefined });
		expect(fenceFormatTarget("scss")).toEqual({ languageId: "scss", sqlDialectOverride: undefined });
		expect(fenceFormatTarget("less")).toEqual({ languageId: "less", sqlDialectOverride: undefined });

		// Unsupported or recursive markdown fences are not formatted as embedded blocks.
		expect(fenceFormatTarget("")).toBeNull();
		expect(fenceFormatTarget("markdown")).toBeNull();
		expect(fenceFormatTarget("plaintext")).toBeNull();
		expect(fenceFormatTarget("python")).toBeNull();
	});

	test("locates top-level, list-indented, and blockquoted fences while skipping YAML frontmatter", () => {
		const md = [
			"---",
			"title: Snippet demo",
			"---",
			"",
			"```ssl",
			":PROCEDURE Run;",
			"sVal:=1;",
			":ENDPROC;",
			"```",
			"",
			"- Item:",
			"",
			"  ```sql",
			"  select a,b from demo_samples;",
			"  ```",
			"",
			"> ~~~xfd",
			"> <Form><Button/></Form>",
			"> ~~~",
			"",
		].join("\n");

		const fences = findMarkdownCodeFences(md);
		expect(fences.length).toBe(3);

		expect(fences[0]).toMatchObject({
			openLine: 5,
			closeLine: 9,
			bodyStartLine: 6,
			bodyEndLine: 8,
			rawLang: "ssl",
			languageId: "ssl",
			linePrefix: "",
			code: ":PROCEDURE Run;\nsVal:=1;\n:ENDPROC;",
		});

		expect(fences[1]).toMatchObject({
			openLine: 13,
			closeLine: 15,
			bodyStartLine: 14,
			bodyEndLine: 14,
			rawLang: "sql",
			languageId: "sql",
			linePrefix: "  ",
			code: "select a,b from demo_samples;",
		});

		expect(fences[2]).toMatchObject({
			openLine: 17,
			closeLine: 19,
			bodyStartLine: 18,
			bodyEndLine: 18,
			rawLang: "xfd",
			languageId: "xml",
			linePrefix: "> ",
			code: "<Form><Button/></Form>",
		});

		expect(fenceAtLine(md, 1)).toBeNull();
		expect(fenceAtLine(md, 6)?.rawLang).toBe("ssl");
		expect(fenceAtLine(md, 14)?.rawLang).toBe("sql");
		expect(fenceAtLine(md, 18)?.rawLang).toBe("xfd");
		expect(fenceAtLine(md, 10)).toBeNull();
	});

	test("replaces formatted code fence bodies cleanly with preserved prefixes, CRLF, and end-to-end backend formatting", async () => {
		const md = [
			"# Query note",
			"",
			"- Query:",
			"",
			"  ```plsql",
			"  select s.sample_id,nvl(s.instrument_id,'NONE') from demo_samples s where rownum<=5;",
			"  ```",
			"",
			"> ```xfd",
			"> <Form id=\"F1\"><Control name=\"c1\"/></Form>",
			"> ```",
			"",
		].join("\r\n");

		const fences = findMarkdownCodeFences(md);
		const replacements = new Map<number, string>();
		for (const fence of fences) {
			const res = await formatDocument({
				path: virtualFencePath("docs/note.md", fence),
				text: fence.code,
				languageId: fence.languageId,
				tabSize: fence.languageId === "sql" ? 4 : 2,
				insertSpaces: true,
				sqlDialect: fence.sqlDialectOverride ?? "tsql",
			});
			expect(res.ok).toBe(true);
			if (res.ok) {
				replacements.set(fence.openLine, formatFenceBodyForMarkdown(res.text, fence.linePrefix, "\r\n"));
			}
		}

		const updated = replaceFencesInMarkdown(md, fences, replacements);
		expect(updated).toContain("  ```plsql\r\n  SELECT\r\n      s.sample_id,");
		expect(updated).toContain("  FROM\r\n      demo_samples s\r\n  WHERE\r\n      rownum <= 5;\r\n  ```");
		expect(updated).toContain('> ```xfd\r\n> <Form id="F1">\r\n>   <Control name="c1" />\r\n> </Form>\r\n> ```');
		// Surrounding Markdown heading and list item remain completely untouched.
		expect(updated.startsWith("# Query note\r\n\r\n- Query:\r\n")).toBe(true);
	});

	test("Markdown Prettier formatting leaves fenced code intact for the unified fence pass", async () => {
		const md = [
			"# Note",
			"",
			"```ssl",
			":PROCEDURE   Foo;",
			"x:=1;",
			":ENDPROC;",
			"```",
			"",
			"```js",
			"const x=1",
			"```",
			"",
		].join("\n");
		const res = await formatDocument({ path: "docs/note.md", text: md, languageId: "markdown" });
		expect(res.ok).toBe(true);
		if (!res.ok) return;
		// embeddedLanguageFormatting: "off" leaves both fences verbatim so the unified fence pass owns them.
		expect(res.text).toContain(":PROCEDURE   Foo;\nx:=1;\n:ENDPROC;");
		expect(res.text).toContain("const x=1");
	});
});
