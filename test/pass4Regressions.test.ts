// The regressions the pass 4 audit found in this branch, each held by the code it names. The browser host's
// outbox (H2) and the folder name Windows forbids (M7) are in pass3LowsBackendProcesses.test.ts, the Word table
// cell (M2) in pass3LowsImportShared.test.ts, and the ways of leaving a tab (M6) in solid2AuditCore.test.ts,
// beside the tests they correct. The SSL here is written for these tests.
import { afterAll, describe, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { parser as markdownParser } from "@lezer/markdown";
import { LSP_PIN } from "../src/bun/tools";
import { foldVolume, WorkspaceFiles } from "../src/bun/workspace";
import { cutOut, editedLines, formatStaysWithin, keepDepth, linesWithEdits, rawSpans, spanAfterSwap, type Node, type RangeEdit } from "../src/view/blocks/model";

const root = join(import.meta.dir, "..");
const readSrc = (path: string) => readFileSync(join(root, path), "utf8");
const base = mkdtempSync(join(tmpdir(), "ssl-studio-p4-"));
afterAll(() => rmSync(base, { recursive: true, force: true }));

// ---------------------------------------------------------------------------------------------------------------
// H1. The type check runs under Node on every system
// ---------------------------------------------------------------------------------------------------------------

describe("H1 — the type check", () => {
	test("is run by Node, not through Hutch's own runtime, which on Windows cannot find the compiler", async () => {
		const config = (await import("../hutch.config")).default;
		expect(config.scripts.check).toBe("node node_modules/typescript/bin/tsc --noEmit -p .");
		expect(Object.values(config.scripts).flat().join("\n")).not.toContain("pm exec");
		// The launcher it names is there, and is a script for Node.
		expect(readSrc("node_modules/typescript/bin/tsc").startsWith("#!/usr/bin/env node")).toBe(true);
	});

	test("CI runs the tests when the type check fails too, as a step of their own", () => {
		const ci = readSrc(".github/workflows/build.yml");
		const steps = ci.split(/\n {6}- /).map((step) => step.trim());
		const check = steps.find((step) => step.startsWith("name: Type check"))!;
		const tests = steps.find((step) => step.includes("name: Tests"))!;
		expect(check).toContain("id: check");
		expect(check).toContain("run: hutch run check");
		expect(check).not.toContain("bun test");
		expect(tests).toContain("run: bun test");
		expect(tests).toContain("if: ${{ !cancelled() && steps.check.conclusion != 'skipped' }}");
	});
});

// ---------------------------------------------------------------------------------------------------------------
// M1. Blocks: the range format after an edit changes the lines it was asked for, and no others
// ---------------------------------------------------------------------------------------------------------------

const edit = (startLine: number, startColumn: number, endLine: number, endColumn: number, text: string | null): RangeEdit => ({ range: { startLineNumber: startLine, startColumn, endLineNumber: endLine, endColumn }, text });

describe("M1 — the lines of a text with edits made to it", () => {
	const lines = ["one", "two", "three", "four"];
	test("a replacement in a line, of whole lines, an insertion and a deletion", () => {
		expect(linesWithEdits(lines, [edit(2, 1, 2, 4, "TWO")])).toEqual(["one", "TWO", "three", "four"]);
		expect(linesWithEdits(lines, [edit(2, 2, 3, 3, "-")])).toEqual(["one", "t-ree", "four"]);
		expect(linesWithEdits(lines, [edit(3, 1, 3, 1, "new\n")])).toEqual(["one", "two", "new", "three", "four"]);
		expect(linesWithEdits(lines, [edit(2, 1, 3, 1, "")])).toEqual(["one", "three", "four"]);
		// After the last line, as an insertion at the end of the text is written; and with the line ends of Windows.
		expect(linesWithEdits(lines, [edit(4, 5, 4, 5, "\r\nfive")])).toEqual(["one", "two", "three", "four", "five"]);
		expect(linesWithEdits(lines, [edit(1, 1, 1, 4, null)])).toEqual(["", "two", "three", "four"]);
	});

	test("several edits are made as one, in whatever order they are given, and the lines given stay as they were", () => {
		const given = [...lines];
		expect(linesWithEdits(given, [edit(1, 1, 1, 4, "1"), edit(4, 1, 4, 5, "4"), edit(2, 1, 2, 4, "2")])).toEqual(["1", "2", "three", "4"]);
		expect(given).toEqual(lines);
		// A place past the text is the text's end, not an error.
		expect(linesWithEdits(lines, [edit(9, 1, 9, 9, "!")])).toEqual(["one", "two", "three", "four!"]);
	});
});

describe("M1 — an answer that stays within the lines asked for", () => {
	const before = ["a", "b", "c", "d", "e"];
	test("lines changed in the span, added to it or taken from it, are within", () => {
		expect(formatStaysWithin(before, ["a", "B", "c", "d", "e"], { start: 2, end: 2 })).toBe(true);
		expect(formatStaysWithin(before, ["a", "B", "C", "d", "e"], { start: 2, end: 3 })).toBe(true);
		expect(formatStaysWithin(before, ["a", "B", "", "c", "d", "e"], { start: 2, end: 2 })).toBe(true);
		expect(formatStaysWithin(before, ["a", "bc", "d", "e"], { start: 2, end: 3 })).toBe(true);
		// The span's one line taken away, a blank line the format has no use for.
		expect(formatStaysWithin(before, ["a", "c", "d", "e"], { start: 2, end: 2 })).toBe(true);
		expect(formatStaysWithin(before, [...before], { start: 2, end: 2 })).toBe(true);
	});

	test("a line changed above the span or below it is not, however much of the span changed with it", () => {
		expect(formatStaysWithin(before, ["a", "B", "C", "d", "e"], { start: 2, end: 2 })).toBe(false);
		expect(formatStaysWithin(before, ["A", "B", "c", "d", "e"], { start: 2, end: 2 })).toBe(false);
		expect(formatStaysWithin(before, ["a", "b", "c", "d", "E"], { start: 2, end: 3 })).toBe(false);
		// Every line below pushed in, the line asked for as it was: what the server answered for an open bracket.
		expect(formatStaysWithin(before, ["a", "b", "  c", "  d", "  e"], { start: 2, end: 2 })).toBe(false);
		// More lines gone than the span has.
		expect(formatStaysWithin(before, ["a", "d", "e"], { start: 2, end: 2 })).toBe(false);
		// A line joined to the one below the span.
		expect(formatStaysWithin(before, ["a", "bc", "d", "e"], { start: 2, end: 2 })).toBe(false);
	});
});

describe("M1 — code the server could not read is cut out of what is asked", () => {
	const leaf = (kind: Node["kind"], start: number, end = start): Node => ({ kind, start, end, children: [], key: `${kind}:${start}` });
	const tree: Node = {
		kind: "file",
		start: 1,
		end: 12,
		key: "file",
		children: [
			{ kind: "procedure", start: 1, end: 10, key: "procedure:Run:1", name: "Run", children: [leaf("text", 2), leaf("raw", 3, 4), leaf("text", 5), { kind: "block", start: 6, end: 8, key: "block::6", children: [leaf("raw", 7), leaf("text", 8)] }, leaf("text", 9), leaf("text", 10)] },
			leaf("blank", 11),
			leaf("raw", 12),
		],
	};

	test("the raw lines within a span, in order, cut to the span, in whatever block they are", () => {
		expect(rawSpans(tree, { start: 1, end: 12 })).toEqual([{ start: 3, end: 4 }, { start: 7, end: 7 }, { start: 12, end: 12 }]);
		expect(rawSpans(tree, { start: 4, end: 7 })).toEqual([{ start: 4, end: 4 }, { start: 7, end: 7 }]);
		expect(rawSpans(tree, { start: 5, end: 6 })).toEqual([]);
		expect(rawSpans(tree, { start: 0, end: 0 })).toEqual([]);
		expect(rawSpans(tree, { start: 13, end: 13 })).toEqual([]);
		expect(rawSpans(null, { start: 1, end: 12 })).toEqual([]);
	});

	test("the runs of lines that are left of a span", () => {
		expect(cutOut({ start: 2, end: 9 }, [{ start: 3, end: 4 }, { start: 7, end: 7 }])).toEqual([{ start: 2, end: 2 }, { start: 5, end: 6 }, { start: 8, end: 9 }]);
		expect(cutOut({ start: 2, end: 9 }, [])).toEqual([{ start: 2, end: 9 }]);
		// At the span's edges, over all of it, outside it, given out of order and overlapping.
		expect(cutOut({ start: 3, end: 7 }, [{ start: 7, end: 9 }, { start: 1, end: 3 }])).toEqual([{ start: 4, end: 6 }]);
		expect(cutOut({ start: 3, end: 4 }, [{ start: 1, end: 9 }])).toEqual([]);
		expect(cutOut({ start: 3, end: 4 }, [{ start: 8, end: 9 }, { start: 1, end: 1 }])).toEqual([{ start: 3, end: 4 }]);
		expect(cutOut({ start: 1, end: 9 }, [{ start: 2, end: 5 }, { start: 4, end: 6 }])).toEqual([{ start: 1, end: 1 }, { start: 7, end: 9 }]);
	});

	test("where a run of lines stands once two cards are swapped", () => {
		// `a` is lines 2-3, `b` lines 6-8, lines 4-5 between them: after the swap b is 2-4, the two between 5-6, a 7-8.
		const [a, b] = [{ start: 2, end: 3 }, { start: 6, end: 8 }];
		expect(spanAfterSwap({ start: 7, end: 7 }, a, b)).toEqual({ start: 3, end: 3 });
		expect(spanAfterSwap({ start: 6, end: 8 }, a, b)).toEqual({ start: 2, end: 4 });
		expect(spanAfterSwap({ start: 2, end: 2 }, a, b)).toEqual({ start: 7, end: 7 });
		expect(spanAfterSwap({ start: 3, end: 3 }, a, b)).toEqual({ start: 8, end: 8 });
		expect(spanAfterSwap({ start: 4, end: 5 }, a, b)).toEqual({ start: 5, end: 6 });
		// What is in neither stays.
		expect(spanAfterSwap({ start: 9, end: 9 }, a, b)).toEqual({ start: 9, end: 9 });
		expect(spanAfterSwap({ start: 1, end: 1 }, a, b)).toEqual({ start: 1, end: 1 });
	});

	test("BlocksView gives each edit the raw lines as they stand after it (source only: the view is not mounted in a test)", () => {
		const src = readSrc("src/view/blocks/BlocksView.tsx");
		expect(src).toContain("const raw = rawSpans(tree.root, swapped).map((span) => spanAfterSwap(span, step.a, step.b));");
		expect(src).toContain("await formatLines(swapped.start, swapped.end, raw);");
		expect(src).toContain("const raw = rawSpans(tree.root, card).map((span) => ({ start: span.start + 1, end: span.end + 1 }));");
		expect(src).toContain("await formatLines(card.start, card.end + 2, raw);");
		expect(src).toContain("...rawSpans(tree.root, { start: card.start - 1, end: card.start - 1 }),");
		expect(src).toContain("...rawSpans(tree.root, { start: card.end + 1, end: card.end + 1 }).map(() => ({ start: card.start, end: card.start })),");
		// The raw lines are taken from the tree before the text is changed: after it the tree's lines are no longer the text's.
		for (const [first, then] of [
			["const raw = rawSpans(tree.root, swapped)", 'replaceLines(swapped.start, swapped.end, swapped.lines.join("\\n"), false);'],
			["const raw = rawSpans(tree.root, card)", "replaceLines(card.start, card.end, `/* region"],
			["...rawSpans(tree.root, { start: card.end + 1", "replaceLines(card.start, card.end, null, false);"],
		] as const) {
			expect(src.indexOf(first)).toBeGreaterThan(0);
			expect(src.indexOf(first)).toBeLessThan(src.indexOf(then));
		}
	});
});

describe("M1 — a statement typed anew keeps the depth it stood at", () => {
	test("typed without its indentation, each line of it is put back in by as much", () => {
		expect(keepDepth("\toErr := GetLastSSLError();", "oErr:=GetLastSSLError( );")).toBe("\toErr:=GetLastSSLError( );");
		expect(keepDepth("\t\tnSum := Add(nA,\n\t\t\tnB);", "nSum := Add(nA,\n\tnB,\n\n\tnC);")).toBe("\t\tnSum := Add(nA,\n\t\t\tnB,\n\n\t\t\tnC);");
		expect(keepDepth("    x := 1;", "x := 2;")).toBe("    x := 2;");
	});

	test("typed with indentation of its own, at the left edge already, or empty, it is taken as it is", () => {
		expect(keepDepth("\tx := 1;", "\t\tx := 2;")).toBe("\t\tx := 2;");
		expect(keepDepth("\tx := 1;", "  x := 2;")).toBe("  x := 2;");
		expect(keepDepth("x := 1;", "x := 2;")).toBe("x := 2;");
		expect(keepDepth("\tx := 1;", "")).toBe("");
		expect(keepDepth("\tx := 1;", "\n")).toBe("\n");
		// A blank first line does not decide it: the first line with text does.
		expect(keepDepth("\tx := 1;", "\nx := 2;")).toBe("\n\tx := 2;");
	});

	test("BlocksView puts what was typed in at that depth, and code the server could not read exactly as typed (source only)", () => {
		const src = readSrc("src/view/blocks/BlocksView.tsx");
		expect(src).toContain("const put = keepDepth(was, text);");
		expect(src).toContain("replaceLines(n.start, n.end, put, false);");
		expect(src).toContain('if (n.kind === "raw") {\n\t\t\treplaceLines(n.start, n.end, text, true);');
	});
});

// The server itself: what it answers for the three cases the audit ran, and what is made of the answer.
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

type LspEdit = { range: { start: { line: number; character: number }; end: { line: number; character: number } }; newText: string };

/** The language server over its standard streams, asked one thing at a time. */
function lspClient(path: string) {
	const child = spawn(path, ["--stdio"], { stdio: ["pipe", "pipe", "ignore"] });
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

describe("M1 — against the language server's own answers", () => {
	const procedure = [":PROCEDURE Run;", ":PARAMETERS nA, nB;", ":DECLARE nSum;", "nSum := nA + nB;", ":IF nSum > 10;", "\tnSum := 10;", ":ENDIF;", 'DoProc("Audit", {nSum});', ":RETURN nSum;", ":ENDPROC;"];
	const put = (at: number, count: number, ...text: string[]) => {
		const copy = [...procedure];
		copy.splice(at - 1, count, ...text);
		return copy;
	};

	test.skipIf(!server)(`starlims-lsp ${LSP_PIN}: an answer that reaches past the lines asked for is not applied, one that stays within them is`, async () => {
		const folder = join(base, "format");
		mkdirSync(folder, { recursive: true });
		writeFileSync(join(folder, "d.ssl"), procedure.join("\n"));
		const uri = pathToFileURL(join(folder, "d.ssl")).href;
		const lsp = lspClient(server!);
		try {
			await lsp.request("initialize", { processId: process.pid, rootUri: pathToFileURL(folder).href, capabilities: {}, workspaceFolders: [{ uri: pathToFileURL(folder).href, name: "format" }] });
			lsp.notify("initialized", {});
			let version = 0;
			/** The text after a Blocks edit, the lines the view then asks for, and what it would make of the answer. */
			const formatted = async (lines: string[], asked: { start: number; end: number }) => {
				const text = lines.join("\n");
				version++;
				if (version === 1) lsp.notify("textDocument/didOpen", { textDocument: { uri, languageId: "ssl", version, text } });
				else lsp.notify("textDocument/didChange", { textDocument: { uri, version }, contentChanges: [{ text }] });
				const answer: LspEdit[] =
					(await lsp.request("textDocument/rangeFormatting", {
						textDocument: { uri },
						range: { start: { line: asked.start - 1, character: 0 }, end: { line: asked.end - 1, character: lines[asked.end - 1]!.length } },
						options: { tabSize: 4, insertSpaces: false },
					})) ?? [];
				const after = linesWithEdits(lines, answer.map((e) => edit(e.range.start.line + 1, e.range.start.character + 1, e.range.end.line + 1, e.range.end.character + 1, e.newText)));
				return { after, within: formatStaysWithin(lines, after, asked) };
			};

			// A chip confirmed with a bracket left open. Until 0.32.0 the server found no end of the statement, and its
			// answer pushed every later line of the procedure in. A `;` now ends the brackets its statement left open
			// (L10 in docs/LSP-REQUESTS.md): the answer keeps to the line, and is applied.
			const open = put(4, 1, "nSum := Max(nA, nB;");
			const kept = await formatted(open, editedLines(4, "nSum := Max(nA, nB;", open.length));
			expect(kept.after).toEqual(open);
			expect(kept.within).toBe(true);

			// A statement with no `;` at all does run on into the next line, for the server as for STARLIMS. The answer
			// reaches into that line and pushes it in. Nothing of it is applied: the check is still needed.
			const endless = put(4, 1, "nSum := Max(nA, nB");
			const reached = await formatted(endless, editedLines(4, "nSum := Max(nA, nB", endless.length));
			expect(reached.after.slice(4)).not.toEqual(endless.slice(4));
			expect(reached.within).toBe(false);

			// A chip deleted under a line the server cannot read. Asked for both lines that meet, the server writes the
			// unreadable one anew. With that line cut out of what is asked, the answer is for the one line left, and
			// the unreadable line stays as it was written.
			const raw = put(4, 1, "nSum   :=   ((nA  +  nB ;");
			const both = await formatted(raw, editedLines(5, null, raw.length));
			expect(both.after[3]).not.toBe(raw[3]);
			const runs = cutOut(editedLines(5, null, raw.length), [{ start: 4, end: 4 }]);
			expect(runs).toEqual([{ start: 5, end: 5 }]);
			const rest = await formatted(raw, runs[0]!);
			expect(rest.within).toBe(true);
			expect(rest.after[3]).toBe(raw[3]);

			// A readable edit of the same chip is formatted, as before.
			const readable = put(4, 1, "nSum := nA+nB;");
			const fine = await formatted(readable, editedLines(4, "nSum := nA+nB;", readable.length));
			expect(fine.within).toBe(true);
			expect(fine.after).toEqual(procedure);
		} finally {
			lsp.stop();
		}
	}, 30_000);
});

// ---------------------------------------------------------------------------------------------------------------
// M3. Live Preview: a backslash escape's backslash is syntax, not text
// ---------------------------------------------------------------------------------------------------------------

describe("M3 — what the Word import escapes is read as an escape", () => {
	const escapes = (text: string) => {
		const found: string[] = [];
		markdownParser.parse(text).iterate({ enter: (node) => void (node.name === "Escape" && found.push(text.slice(node.from, node.to))) });
		return found;
	};

	test("each sign the import writes a backslash before is an Escape of two characters in the editor's own parser", () => {
		expect(escapes("1\\. Not a list item")).toEqual(["\\."]);
		expect(escapes("\\# Not a heading")).toEqual(["\\#"]);
		expect(escapes("\\- not a bullet")).toEqual(["\\-"]);
		expect(escapes("a \\*x\\* and \\[x\\] and \\=\\=x\\=\\= and \\#tag")).toEqual(["\\*", "\\*", "\\[", "\\]", "\\=", "\\=", "\\=", "\\=", "\\#"]);
		// A backslash before a letter is a backslash, and code is not read for escapes.
		expect(escapes("C:\\dev and `a\\*b`")).toEqual([]);
	});

	test("the Live plugin hides that backslash as it hides any mark, and shows it at the cursor; not in a table edited as text (source only: the plugin needs a drawn editor)", () => {
		const src = readSrc("src/view/editor/cmLivePlugin.ts");
		const at = src.indexOf('if (node.name === "Escape") {');
		expect(at).toBeGreaterThan(0);
		const branch = src.slice(at, src.indexOf("// ATX Headings", at));
		expect(branch).toContain('if (up.name === "Table") return false;');
		expect(branch).toContain("hideOrDim(node.from, node.from + 1, selectionTouches(state, node.from, node.to));");
		expect(branch).toContain("if (!isSkipped(node.from, node.to))");
	});
});

// ---------------------------------------------------------------------------------------------------------------
// M4. Windows: the drive's letter is one drive in either case
// ---------------------------------------------------------------------------------------------------------------

describe("M4 — the part of a Windows path that case never tells apart", () => {
	test("a drive's letter, and a network path's server and share, are folded; the rest is as written", () => {
		expect(foldVolume("C:\\Dev\\Proj\\A.ssl", true)).toBe("c:\\Dev\\Proj\\A.ssl");
		expect(foldVolume("c:\\Dev\\Proj\\A.ssl", true)).toBe("c:\\Dev\\Proj\\A.ssl");
		expect(foldVolume("D:", true)).toBe("d:");
		expect(foldVolume("\\\\SERVER\\Share\\Dir\\A.ssl", true)).toBe("\\\\server\\share\\Dir\\A.ssl");
		expect(foldVolume("//Server/Share/Dir", true)).toBe("//server/share/Dir");
		// The editor's path and the folder's own then compare as one, where compared as written they did not.
		const [rootPath, fromEditor] = ["C:\\Dev\\Proj", "c:\\Dev\\Proj\\src\\A.ssl"];
		expect(fromEditor.startsWith(`${rootPath}\\`)).toBe(false);
		expect(foldVolume(fromEditor, true).startsWith(`${foldVolume(rootPath, true)}\\`)).toBe(true);
		// A folder whose name differs by case is still another folder there.
		expect(foldVolume("c:\\Dev\\PROJ\\src\\A.ssl", true).startsWith(`${foldVolume(rootPath, true)}\\`)).toBe(false);
	});

	test("a path with no such part, and any path on another system, comes back as it is", () => {
		expect(foldVolume("\\Dev\\x", true)).toBe("\\Dev\\x");
		expect(foldVolume("relative\\C:\\x", true)).toBe("relative\\C:\\x");
		expect(foldVolume("/home/User/C:/x", true)).toBe("/home/User/C:/x");
		expect(foldVolume("C:\\Dev", false)).toBe("C:\\Dev");
		expect(foldVolume("/home/User/x", false)).toBe("/home/User/x");
		expect(foldVolume("/home/User/x")).toBe(process.platform === "win32" ? "/home/User/x" : "/home/User/x");
	});

	test("every compare of a path with the workspace's folder goes through it (source only: the paths are Windows's)", () => {
		const src = readSrc("src/bun/workspace.ts");
		expect(src).toContain("const folding = (root: string) => (foldsCase(root) ? (p: string) => p.toLowerCase() : (p: string) => foldVolume(p));");
		expect(src.match(/const fold = folding\(/g)?.length).toBe(3);
		expect(src).not.toContain(": (p: string) => p;");
	});
});

// ---------------------------------------------------------------------------------------------------------------
// M5. A folder is moved in one try
// ---------------------------------------------------------------------------------------------------------------

describe("M5 — a folder's rename is not tried again after a wait", () => {
	test("a rename the system refuses fails at once, the folder stays, and a save asked for next lands in it", async () => {
		const folder = join(base, "move");
		mkdirSync(join(folder, "src"), { recursive: true });
		writeFileSync(join(folder, "src", "A.ssl"), ":RETURN 1;\n");
		const ws = new WorkspaceFiles(folder);
		const real = WorkspaceFiles.moveFolder;
		const tried: string[] = [];
		// As Windows refuses while a scanner or an indexer holds the folder: once, and the next try would succeed.
		WorkspaceFiles.moveFolder = (from, to) => {
			tried.push(from);
			if (tried.length === 1) throw Object.assign(new Error("EPERM: operation not permitted, rename"), { code: "EPERM" });
			real(from, to);
		};
		try {
			const renamed = ws.rename(join(folder, "src"), join(folder, "lib"));
			// The view still shows src/A.ssl: a save of it, asked for before the rename has answered.
			const saved = ws.write(join(folder, "src", "A.ssl"), ":RETURN 2;\n");
			const [rename, save] = await Promise.allSettled([renamed, saved]);
			expect(rename.status).toBe("rejected");
			expect(String((rename as PromiseRejectedResult).reason?.message)).toContain("EPERM");
			expect(save.status).toBe("fulfilled");
			// One try, and one folder, with the text that was saved: not the old folder beside the new with half each.
			expect(tried).toEqual([join(folder, "src")]);
			expect(existsSync(join(folder, "lib"))).toBe(false);
			expect(readFileSync(join(folder, "src", "A.ssl"), "utf8")).toBe(":RETURN 2;\n");

			// Asked again, it is moved, with what is in it.
			await ws.rename(join(folder, "src"), join(folder, "lib"));
			expect(existsSync(join(folder, "src"))).toBe(false);
			expect(readFileSync(join(folder, "lib", "A.ssl"), "utf8")).toBe(":RETURN 2;\n");
		} finally {
			WorkspaceFiles.moveFolder = real;
		}
	});

	test("a file's rename still goes through the rename that waits and tries again", () => {
		const src = readSrc("src/bun/workspace.ts");
		expect(src).toContain("if (isFolder(source)) WorkspaceFiles.moveFolder(source, target);\n\t\t\telse await renameReplacing(source, target);");
	});
});
