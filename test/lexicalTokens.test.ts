// starlims-lsp 0.32.0 (L9 in docs/LSP-REQUESTS.md): where a script's comments are, and which of its words are the
// language's own, are asked of the server (`ssl/lexicalTokens`, semantic tokens). The IDE's own readers of both
// are gone: `stripCodeComments` in the schema index and the declaration line check of the schema hover (ADR 0003).
import { afterAll, describe, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { LSP_PIN } from "../src/bun/tools";
import {
	decodeNameTokens,
	isDataSourceName,
	isSslOwnWord,
	lineStarts,
	namesByLine,
	NO_FACTS,
	offsetAt,
	tokenAt,
	withoutComments,
	withoutSpans,
	withoutTokens,
	type LexToken,
	type SslFacts,
} from "../src/shared/lexicalTokens";
import type { DocFile } from "../src/shared/protocol";
import { hasSchemaTables, referencedSchemaTables } from "../src/shared/schemaIndex";
import { LEGEND, tokenStyle, translateTokens } from "../src/view/editor/semantic";
import { fromCallGraph } from "../src/view/graph/model";

const root = resolve(import.meta.dir, "..");
const readSrc = (path: string) => readFileSync(join(root, path), "utf8");
const base = mkdtempSync(join(tmpdir(), "ssl-studio-lex-"));
afterAll(() => rmSync(base, { recursive: true, force: true }));

const token = (kind: string, startLine: number, startCharacter: number, endLine: number, endCharacter: number): LexToken => ({
	kind,
	range: { start: { line: startLine, character: startCharacter }, end: { line: endLine, character: endCharacter } },
});
const table = (name: string): DocFile => ({ path: `/ws/schema/database/${name}.md`, name: `database/${name}.md`, group: "schema", kind: "database", exists: true, title: name });

describe("the server's ranges, placed in the text they were read from", () => {
	test("lines end at \\r\\n, \\n and a lone \\r, and a position past a line's end is the line's end", () => {
		const text = "ab\r\ncd\nef\rgh";
		const starts = lineStarts(text);
		expect(starts).toEqual([0, 4, 7, 10]);
		expect(offsetAt(text, starts, { line: 1, character: 1 })).toBe(5);
		expect(offsetAt(text, starts, { line: 0, character: 99 })).toBe(4);
		expect(offsetAt(text, starts, { line: 3, character: 99 })).toBe(text.length);
		expect(offsetAt(text, starts, { line: 9, character: 0 })).toBe(text.length);
		expect(offsetAt(text, starts, { line: -1, character: 5 })).toBe(0);
	});

	test("a comment is written over with spaces: the text is as long as it was and its lines end where they did", () => {
		const text = 'nA := 1; /* a note\r\n   that runs on;\r\nsB := "kept";';
		const out = withoutTokens(text, [token("comment", 0, 9, 1, 16), token("string", 2, 6, 2, 12)]);
		expect(out).toBe(`nA := 1; ${" ".repeat(9)}\r\n${" ".repeat(16)}\r\nsB := "kept";`);
		expect(out.length).toBe(text.length);
		expect(lineStarts(out)).toEqual(lineStarts(text));
		// Other kinds on request, and a kind this version does not know is left alone.
		expect(withoutTokens('sB := "x";', [token("string", 0, 6, 0, 9), token("somethingNew", 0, 0, 0, 2)], ["string"])).toBe("sB :=    ;");
		expect(withoutTokens("plain", [])).toBe("plain");
	});

	test("spans of each line are written over the same way, and a reader that has nothing to say leaves the text", () => {
		const text = "a -- one\r\nb\nc /* two */ d";
		expect(withoutSpans(text, () => [[{ from: 2, to: 8 }], [], [{ from: 2, to: 11 }]])).toBe("a       \r\nb\nc           d");
		expect(withoutSpans(text, () => null)).toBe(text);
		// A span past the line's end stops at it.
		expect(withoutSpans("ab", () => [[{ from: 1, to: 99 }]])).toBe("a ");
	});

	test("the token a place lies in, from its first character up to its end", () => {
		const tokens = [token("comment", 0, 0, 0, 10), token("keyword", 1, 0, 1, 3), token("string", 1, 8, 3, 2), token("keyword", 4, 1, 4, 7)];
		expect(tokenAt(tokens, 0, 0)?.kind).toBe("comment");
		expect(tokenAt(tokens, 0, 9)?.kind).toBe("comment");
		expect(tokenAt(tokens, 0, 10)).toBeUndefined();
		expect(tokenAt(tokens, 1, 1)?.kind).toBe("keyword");
		expect(tokenAt(tokens, 1, 5)).toBeUndefined();
		expect(tokenAt(tokens, 2, 40)?.kind).toBe("string");
		expect(tokenAt(tokens, 3, 1)?.kind).toBe("string");
		expect(tokenAt(tokens, 3, 2)).toBeUndefined();
		expect(tokenAt(tokens, 4, 6)?.kind).toBe("keyword");
		expect(tokenAt([], 0, 0)).toBeUndefined();
	});
});

describe("comments by language", () => {
	const grammar = (lines: readonly string[]) => lines.map((line) => (line.startsWith("/*") ? [{ from: 0, to: line.length }] : []));

	test("SSL's are the server's; where it could not say, the grammar's; and with neither, the text as it is", () => {
		const text = "/* reads ORDERS;\nnA := 1;";
		expect(withoutComments(text, "ssl", [token("comment", 0, 0, 0, 16)], grammar)).toBe(`${" ".repeat(16)}\nnA := 1;`);
		expect(withoutComments(text, "ssl", null, grammar)).toBe(`${" ".repeat(16)}\nnA := 1;`);
		expect(withoutComments(text, "ssl", undefined)).toBe(text);
		// The server's answer stands where it found nothing: the grammar is not asked for a second opinion.
		expect(withoutComments(text, "ssl", [], grammar)).toBe(text);
	});

	test("SQL's are its own two kinds, a quote's contents kept; any other text has none", () => {
		const sql = "select ID -- from OLD_ORDERS\nfrom ORDERS /* not\nHOLIDAYS */ where NAME = '--x'";
		const out = withoutComments(sql, "sql", null);
		expect(out).not.toContain("OLD_ORDERS");
		expect(out).not.toContain("HOLIDAYS");
		expect(out).toContain("from ORDERS");
		expect(out).toContain("'--x'");
		expect(out.length).toBe(sql.length);
		const prose = "ORDERS -- the table of orders, see /* HOLIDAYS */";
		expect(withoutComments(prose, "markdown", null)).toBe(prose);
	});
});

describe("a data source's SQL: its comments are the IDE's own to find", () => {
	const tables = ["ORDERS", "OLD_ORDERS", "HOLIDAYS", "SAMPLES", "NOTED"].map(table);
	const found = (searched: string) => referencedSchemaTables(searched, tables, 16).map((d) => d.title).sort();

	test("a data source is one by its name", () => {
		expect(["Orders.ds", "/ws/Data Sources/Lab/Orders.DS", "Old.ds.txt"].every(isDataSourceName)).toBe(true);
		expect(["Orders.ssl", "Orders.dsx", "ds", "Orders.ds.md"].some(isDataSourceName)).toBe(false);
	});

	test("a body that is SQL: the server reports nothing in it, and SQL's two kinds of comment are taken out", () => {
		const sql = "select ID -- was OLD_ORDERS\r\nfrom ORDERS /* not\r\nHOLIDAYS */ where NOTE = '-- NOTED'";
		const out = withoutComments(sql, "ssl", [], undefined, true);
		expect(found(out)).toEqual(["NOTED", "ORDERS"]);
		expect(out.length).toBe(sql.length);
		expect(lineStarts(out)).toEqual(lineStarts(sql));
		// The same file read as a script, which it is not: nothing in it is a comment the server knows of.
		expect(withoutComments(sql, "ssl", [])).toBe(sql);
	});

	test("an SSL header above SQL: the header's tokens are the server's, the body's comments SQL's", () => {
		const text = ":PARAMETERS sKey;\n/* by SAMPLES;\nselect ID from ORDERS -- not HOLIDAYS\nwhere KEY = ?sKey?";
		const lexical = [token("keyword", 0, 0, 0, 11), token("comment", 1, 0, 1, 14)];
		expect(found(withoutComments(text, "ssl", lexical, undefined, true))).toEqual(["ORDERS"]);
	});

	test("a body that is SSL: a mark inside what the server read is never taken for one of SQL's", () => {
		const text = ['sSql := "select ID from ORDERS -- and SAMPLES";', "sMore := [/* HOLIDAYS */];", "/* reads NOTED;"].join("\n");
		const lexical = [token("string", 0, 8, 0, 46), token("string", 1, 9, 1, 25), token("comment", 2, 0, 2, 15)];
		const out = withoutComments(text, "ssl", lexical, undefined, true);
		// The SSL comment is gone; the two strings are whole, SQL marks and all.
		expect(found(out)).toEqual(["HOLIDAYS", "ORDERS", "SAMPLES"]);
		expect(out.slice(0, text.indexOf("/* reads"))).toBe(text.slice(0, text.indexOf("/* reads")));
	});

	test("with no server, the grammar's comments first and SQL's in the rest", () => {
		const grammar = (lines: readonly string[]) => lines.map((line) => (line.startsWith("/*") ? [{ from: 0, to: line.length }] : []));
		const text = "/* by SAMPLES;\nselect ID from ORDERS -- not HOLIDAYS";
		expect(found(withoutComments(text, "ssl", null, grammar, true))).toEqual(["ORDERS"]);
	});
});

describe("table information is an extra: a project without it is put to no work for it", () => {
	const doc = (name: string, group: DocFile["group"], extra: Partial<DocFile> = {}): DocFile => ({ path: `/ws/${name}`, name, group, exists: true, ...extra });

	test("a project describes a table, or it does not", () => {
		expect(hasSchemaTables([])).toBe(false);
		expect(hasSchemaTables([doc("docs/notes.md", "docs"), doc("docs/tickets/T-1.md", "tickets")])).toBe(false);
		expect(hasSchemaTables([{ ...table("ORDERS"), exists: false }])).toBe(false);
		expect(hasSchemaTables([doc("docs/notes.md", "docs"), table("ORDERS")])).toBe(true);
		// What the search itself goes by: the two cannot disagree.
		expect(referencedSchemaTables("select * from ORDERS", [doc("docs/notes.md", "docs")])).toEqual([]);
	});

	test("the language server is asked about a text only where there is a table to look for (source only)", () => {
		const hover = readSrc("src/view/editor/schemaHover.ts");
		expect(hover.match(/!hasSchemaTables\(allDocs\) \|\| \(lang === "ssl" && isSslOwnWord\(await sslFacts\(model\)/g)?.length).toBe(2);
		expect(hover).toContain("if (model.getValueLength() <= 200_000 && hasSchemaTables(allDocs)) {");
		expect(hover).toContain('const facts = lang === "ssl" && schemaRe ? await sslFacts(model) : NO_FACTS;');
		const agent = readSrc("src/view/agent/Agent.tsx");
		expect(agent).toContain("const place = hasSchemaTables(all) ? tableSearchPlace(activeDocNow) : null;");
		expect(agent).toContain("if (!hasSchemaTables(all)) return [] as DocFile[];");
		const graph = readSrc("src/view/graph/GraphView.tsx");
		expect(graph.match(/hasSchemaTables\(allDocs\)/g)?.length).toBe(3);
		// Every search of a file's text for tables comes after one of those three checks.
		expect(graph.match(/await searchableFileText\(/g)?.length).toBe(3);
	});
});

describe("which words are the language's own", () => {
	const legend = { tokenTypes: ["function", "method", "parameter", "variable", "property", "class", "label"], tokenModifiers: ["declaration", "defaultLibrary", "readonly", "public", "unknown"] };

	test("the server's five numbers a token become a name with its type and modifiers", () => {
		// `:DECLARE ORDERS, nCount;` then `oRule:Status := ORDERS;` on the next line.
		const names = decodeNameTokens([0, 9, 6, 3, 1, 0, 8, 6, 3, 1, 1, 0, 5, 3, 16, 0, 6, 6, 4, 0, 0, 10, 6, 3, 0], legend);
		expect(names).toEqual([
			{ line: 0, character: 9, length: 6, type: "variable", modifiers: ["declaration"] },
			{ line: 0, character: 17, length: 6, type: "variable", modifiers: ["declaration"] },
			{ line: 1, character: 0, length: 5, type: "variable", modifiers: ["unknown"] },
			{ line: 1, character: 6, length: 6, type: "property", modifiers: [] },
			{ line: 1, character: 16, length: 6, type: "variable", modifiers: [] },
		]);
		expect([...namesByLine(names).keys()]).toEqual([0, 1]);
		expect(namesByLine(names).get(1)?.length).toBe(3);
		// A type the legend does not have is no type, and half a token at the end is not one.
		expect(decodeNameTokens([0, 0, 2, 9, 0, 1, 0], legend)).toEqual([{ line: 0, character: 0, length: 2, type: "", modifiers: [] }]);
	});

	test("a keyword, a member and a name being declared are; a name in use is not; and with nothing known, nothing is", () => {
		const facts: SslFacts = {
			lexical: [token("keyword", 0, 0, 0, 8), token("keyword", 2, 0, 2, 7)],
			names: decodeNameTokens([0, 9, 6, 3, 1, 1, 0, 5, 3, 0, 0, 6, 6, 4, 0, 0, 10, 6, 3, 0], legend),
		};
		expect(isSslOwnWord(facts, 0, 1)).toBe(true); // DECLARE, after its colon
		expect(isSslOwnWord(facts, 0, 9)).toBe(true); // ORDERS, declared
		expect(isSslOwnWord(facts, 1, 6)).toBe(true); // Status, a member
		expect(isSslOwnWord(facts, 1, 16)).toBe(false); // ORDERS, in use
		expect(isSslOwnWord(facts, 2, 1)).toBe(true); // REGION, a keyword that a table may be called too
		expect(isSslOwnWord(facts, 3, 4)).toBe(false); // a line the server named nothing on
		// One line's names given: the same answers, and an empty line's list is not taken for "not known".
		const byLine = namesByLine(facts.names!);
		expect(isSslOwnWord(facts, 0, 9, byLine.get(0))).toBe(true);
		expect(isSslOwnWord(facts, 1, 16, byLine.get(1))).toBe(false);
		expect(isSslOwnWord(facts, 0, 9, [])).toBe(false);
		expect(isSslOwnWord(NO_FACTS, 0, 9)).toBe(false);
		expect(isSslOwnWord({ lexical: null, names: facts.names }, 0, 9)).toBe(true);
		expect(isSslOwnWord({ lexical: facts.lexical, names: null }, 0, 1)).toBe(true);
	});

	test("the readers the IDE had of its own are gone (ADR 0003)", () => {
		expect(readSrc("src/shared/schemaIndex.ts")).not.toContain("function stripCodeComments");
		const hover = readSrc("src/view/editor/schemaHover.ts");
		expect(hover).not.toContain("SSL_DECL_LINE_RE");
		expect(hover).not.toContain("isSslDeclarationTarget");
		expect(hover).toContain("isSslOwnWord(await sslFacts(model)");
		expect(hover).toContain("referencedSchemaTables(await searchableText(model)");
		// The Call Graph and the agent give the search a text without its comments too.
		expect(readSrc("src/view/graph/GraphView.tsx").match(/await searchableFileText\(/g)?.length).toBe(3);
		const agent = readSrc("src/view/agent/Agent.tsx");
		expect(agent).toContain("await searchableText(place.model, place.selection)");
		expect(agent).toContain("searchableTextNow(place.model, place.selection)");
	});
});

describe("the label a :LABEL declares, as a semantic token", () => {
	test("is in the legend, last, and is coloured as the grammar colours one unless the theme has a rule for it", () => {
		expect(LEGEND.tokenTypes.at(-1)).toBe("label");
		const theme = { tokenColors: [{ scope: "entity.name.label", settings: { foreground: "#aa5500" } }] };
		expect(tokenStyle(theme, "label", ["declaration"])).toEqual({ foreground: "#aa5500", fontStyle: undefined });
		expect(tokenStyle({ ...theme, semanticTokenColors: { label: "#112233" } }, "label", ["declaration"])?.foreground).toBe("#112233");
		// A theme that colours no label: no token, so the grammar's colour stands.
		expect(tokenStyle({ tokenColors: [] }, "label", ["declaration"])).toBeNull();
	});

	test("comes through from the server's legend, where it is last too", () => {
		const server = { tokenTypes: ["function", "method", "parameter", "variable", "property", "class", "label"], tokenModifiers: ["declaration", "defaultLibrary", "readonly", "public", "unknown"] };
		const out = translateTokens([10, 8, 5, 6, 1], server, () => true);
		expect([...out]).toEqual([10, 8, 5, LEGEND.tokenTypes.indexOf("label"), 1 << LEGEND.tokenModifiers.indexOf("declaration")]);
	});
});

describe("the Call Graph and the IDE's own scratch documents", () => {
	test("a document the IDE has open at the server for a question is not drawn as a script, nor are the lines to it", () => {
		const uri = (path: string) => `file://${path}`;
		const at = (path: string) => ({ uri: uri(path), range: { start: { line: 0, character: 0 }, end: { line: 2, character: 0 } } });
		const input = {
			nodes: [
				{ id: "s1", kind: "script", name: "Real", location: at("/ws/Real.ssl") },
				{ id: "p1", kind: "procedure", name: "Run", container: uri("/ws/Real.ssl"), location: at("/ws/Real.ssl") },
				{ id: "s2", kind: "script", name: "lexical-7", location: at("/ws/.ssl-studio/lexical-7.ssl") },
				{ id: "p2", kind: "procedure", name: "Phantom", container: uri("/ws/.ssl-studio/lexical-7.ssl"), location: at("/ws/.ssl-studio/lexical-7.ssl") },
			],
			edges: [{ from: "p2", to: "p1", kind: "DoProc", resolved: true, location: at("/ws/.ssl-studio/lexical-7.ssl") }],
		};
		const toPath = (value: string) => value.replace("file://", "");
		const all = fromCallGraph(input, toPath);
		expect(all.scripts.map((s) => s.path)).toEqual(["/ws/.ssl-studio/lexical-7.ssl", "/ws/Real.ssl"]);
		const drawn = fromCallGraph(input, toPath, new Map(), (path) => /[\\/]\.ssl-studio[\\/]/.test(path));
		expect(drawn.scripts.map((s) => s.path)).toEqual(["/ws/Real.ssl"]);
		expect(drawn.nodes.map((n) => n.name)).toEqual(["Run"]);
		expect(drawn.edges).toEqual([]);
		expect(readSrc("src/view/graph/load.ts")).toContain("fromCallGraph({ nodes: result?.nodes ?? [], edges: result?.edges ?? [] }, toPath, sizes, scratch)");
	});
});

// --- The server itself -------------------------------------------------------------------------------------------

function pinnedServer(): string | null {
	const suffix = process.platform === "win32" ? ".exe" : "";
	for (const path of [process.env.STARLIMS_LSP, join(root, "vendor", `starlims-lsp${suffix}`)]) {
		if (!path || !existsSync(path)) continue;
		try {
			const out = Bun.spawnSync([path, "--version"]).stdout.toString();
			if (/starlims-lsp version (\S+)/.exec(out)?.[1] === LSP_PIN) return path;
		} catch {
			// Not a program this system can start.
		}
	}
	return null;
}
const server = pinnedServer();

/** The language server over its standard streams. */
function lspClient(path: string) {
	const child = spawn(path, [], { stdio: ["pipe", "pipe", "ignore"] });
	let buffer = Buffer.alloc(0);
	let next = 0;
	const waiting = new Map<number, (message: any) => void>();
	const send = (message: object) => {
		const body = Buffer.from(JSON.stringify({ jsonrpc: "2.0", ...message }));
		child.stdin.write(Buffer.concat([Buffer.from(`Content-Length: ${body.length}\r\n\r\n`), body]));
	};
	child.stdout.on("data", (chunk: Buffer) => {
		buffer = Buffer.concat([buffer, chunk]);
		for (;;) {
			const head = buffer.indexOf("\r\n\r\n");
			if (head < 0) return;
			const length = Number(/Content-Length: (\d+)/i.exec(buffer.subarray(0, head).toString())?.[1]);
			if (buffer.length < head + 4 + length) return;
			const message = JSON.parse(buffer.subarray(head + 4, head + 4 + length).toString());
			buffer = buffer.subarray(head + 4 + length);
			if (message.id !== undefined && message.method) send({ id: message.id, result: null });
			else if (message.id !== undefined) waiting.get(message.id)?.(message);
		}
	});
	const request = (method: string, params: object) =>
		new Promise<any>((done, failed) => {
			const id = ++next;
			const timer = setTimeout(() => failed(new Error(`the language server did not answer ${method}`)), 15_000);
			waiting.set(id, (message) => {
				clearTimeout(timer);
				waiting.delete(id);
				if (message.error) failed(new Error(JSON.stringify(message.error)));
				else done(message.result);
			});
			send({ id, method, params });
		});
	return { request, notify: (method: string, params: object) => send({ method, params }), stop: () => void child.kill() };
}

describe("against the language server's own answers", () => {
	test.skipIf(!server)(`starlims-lsp ${LSP_PIN}: a table named only in a comment is not one the script uses, and a declared name or a keyword is no table`, async () => {
		const folder = join(base, "ws");
		mkdirSync(join(folder, ".ssl-studio"), { recursive: true });
		const lsp = lspClient(server!);
		try {
			const started = await lsp.request("initialize", {
				processId: process.pid,
				rootUri: pathToFileURL(folder).href,
				capabilities: { textDocument: { semanticTokens: { requests: { full: true }, tokenTypes: LEGEND.tokenTypes, tokenModifiers: LEGEND.tokenModifiers, formats: ["relative"] } } },
				workspaceFolders: [{ uri: pathToFileURL(folder).href, name: "ws" }],
			});
			lsp.notify("initialized", {});
			// What `session.supports` reads.
			expect(started.capabilities.experimental.ssl.lexicalTokens).toBe(1);
			expect(started.capabilities.semanticTokensProvider.legend.tokenTypes.at(-1)).toBe("label");

			const lines = [
				"/* Not OUTAGES */ nor HOLIDAYS; sLate := LATE_SAMPLES;", // 0: the comment ends at its `;`, whatever `*/` is in it
				':DECLARE ORDERS, sPath;', // 1: a variable that a table is called too
				'sPath := "C:\\exports\\"; /* not ARCHIVE either;', // 2: a string has no escapes, so this is a comment
				'aRows := SQLExecute("select ID from SAMPLES', // 3
				'	where STATUS = ?sKey?");', // 4
				"/* :DECLARE CUSTOMERS;", // 5: no declaration, a comment
				":REGION Template;", // 6: a keyword that a table is called too
				"select NAME from /* REGION_TEXT", // 7: a region's body is text the script keeps, and nothing in it is a comment
				":ENDREGION;", // 8
				"nCount := Len(ORDERS);", // 9
			];
			const text = lines.join("\n");
			const uri = pathToFileURL(join(folder, "Sampler.ssl")).href;
			lsp.notify("textDocument/didOpen", { textDocument: { uri, languageId: "ssl", version: 3, text } });
			const answer = await lsp.request("ssl/lexicalTokens", { textDocument: { uri } });
			// What `session.lexicalTokens` checks before it believes the ranges.
			expect(answer.version).toBe(3);
			const lexical: LexToken[] = answer.tokens;

			const tables = ["OUTAGES", "HOLIDAYS", "LATE_SAMPLES", "ARCHIVE", "SAMPLES", "ORDERS", "CUSTOMERS", "REGION_TEXT"].map(table);
			const found = (searched: string) => referencedSchemaTables(searched, tables, 16).map((d) => d.title).sort();
			// Every one of them is somewhere in the text.
			expect(found(text)).toEqual(["ARCHIVE", "CUSTOMERS", "HOLIDAYS", "LATE_SAMPLES", "ORDERS", "OUTAGES", "REGION_TEXT", "SAMPLES"]);
			// Without its comments: the one after the first comment's `;`, the one in the SQL, the variable, and the
			// one in the text a region keeps.
			// The reader the IDE had ended the first comment at `*/`, so it counted HOLIDAYS; and it read `\"` as a
			// quote inside the string, so the comment after it was string to it and ARCHIVE counted too.
			const searched = withoutTokens(text, lexical);
			expect(searched.length).toBe(text.length);
			expect(found(searched)).toEqual(["LATE_SAMPLES", "ORDERS", "REGION_TEXT", "SAMPLES"]);
			expect(lexical.filter((t) => t.kind === "text").length).toBe(1);

			const semantic = await lsp.request("textDocument/semanticTokens/full", { textDocument: { uri } });
			const facts: SslFacts = { lexical, names: decodeNameTokens(semantic.data, started.capabilities.semanticTokensProvider.legend) };
			const own = (line: number, word: string, from = 0) => isSslOwnWord(facts, line, lines[line]!.indexOf(word, from));
			expect(own(1, "ORDERS")).toBe(true); // being declared
			expect(own(1, "DECLARE")).toBe(true); // a keyword
			expect(own(6, "REGION")).toBe(true); // a keyword
			expect(own(3, "SAMPLES")).toBe(false); // in the SQL of a string
			expect(own(9, "ORDERS")).toBe(false); // in use: the hover may still say what the table is
			// A comment that looks like a declaration declares nothing. The line check the hover had said it did.
			expect(own(5, "CUSTOMERS")).toBe(false);
			expect(own(5, "DECLARE")).toBe(false);

			// A file that is not open is asked about under a scratch name with the file's own ending
			// (`session.scratchLexical`): the server reads a data source that is SQL as no SSL at all.
			const scratch = (name: string) => pathToFileURL(join(folder, ".ssl-studio", name)).href;
			const sqlSource = "select ID from ORDERS -- not ARCHIVE\nwhere STATUS = 'A' /* nor OUTAGES */\n";
			lsp.notify("textDocument/didOpen", { textDocument: { uri: scratch("lexical-1.ds"), languageId: "ssl", version: 1, text: sqlSource } });
			const none = (await lsp.request("ssl/lexicalTokens", { textDocument: { uri: scratch("lexical-1.ds") } })).tokens as LexToken[];
			expect(none).toEqual([]);
			// So the SQL's comments are found here, in the IDE: the server is not asked about SQL.
			expect(found(withoutComments(sqlSource, "ssl", none))).toEqual(["ARCHIVE", "ORDERS", "OUTAGES"]);
			expect(found(withoutComments(sqlSource, "ssl", none, undefined, true))).toEqual(["ORDERS"]);
			// A header above the SQL: the server's tokens end with the header.
			const headed = ":PARAMETERS sKey;\nselect ID from SAMPLES -- not ARCHIVE\nwhere STATUS = ?sKey?\n";
			lsp.notify("textDocument/didOpen", { textDocument: { uri: scratch("lexical-3.ds"), languageId: "ssl", version: 1, text: headed } });
			const header = (await lsp.request("ssl/lexicalTokens", { textDocument: { uri: scratch("lexical-3.ds") } })).tokens as LexToken[];
			expect(header.every((t) => t.range.end.line === 0)).toBe(true);
			expect(found(withoutComments(headed, "ssl", header, undefined, true))).toEqual(["SAMPLES"]);
			lsp.notify("textDocument/didOpen", { textDocument: { uri: scratch("lexical-2.ssl"), languageId: "ssl", version: 1, text: "/* reads ORDERS;\nnA := 1;\n" } });
			const closed = (await lsp.request("ssl/lexicalTokens", { textDocument: { uri: scratch("lexical-2.ssl") } })).tokens as LexToken[];
			expect(closed.map((t) => t.kind)).toEqual(["comment"]);
			// And a document the server does not hold has no answer.
			expect(await lsp.request("ssl/lexicalTokens", { textDocument: { uri: scratch("never-opened.ssl") } })).toBeNull();
		} finally {
			lsp.stop();
		}
	}, 30_000);
});
