// Indentation asked of the formatter (shared/formatterIndent.ts, ADR 0036): the question and the reading of the
// answer on their own, and then the pinned language server asked for real, since it is its answers this rests on.
import { afterAll, describe, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { LSP_PIN } from "../src/bun/tools";
import { applyTextEdits } from "../src/view/lsp/edits";
import { columnAfterIndent, INDENT_PROBE, newLineIndent, newLineQuestion, ownLineIndent, ownLineQuestion, typedForIndent } from "../src/shared/formatterIndent";

describe("the question put to the formatter, and its answer read", () => {
	test("a new line: the text above it, then a line of the probe's own", () => {
		const question = newLineQuestion(":IF nA > 1;\r\n");
		expect(question.split("\n")).toEqual([":IF nA > 1;", ` \t \t ${INDENT_PROBE}`, ""]);
		// Text above with no line break at its end is given one; none above is the probe alone.
		expect(newLineQuestion(":IF nA > 1;")).toBe(question);
		expect(newLineQuestion("").split("\n").length).toBe(2);
	});

	test("where the formatter put the probe is the new line's indentation", () => {
		expect(newLineIndent(`:IF nA > 1;\n\t${INDENT_PROBE}\n`)).toBe("\t");
		expect(newLineIndent(`:ENDPROC;\n\n${INDENT_PROBE}\n`)).toBe("");
		expect(newLineIndent(`x := Foo(a,\n\t         ${INDENT_PROBE}\n`)).toBe("\t         ");
	});

	test("a probe the formatter left as it was given stood in a string or a comment: no indentation", () => {
		expect(newLineIndent(`sSql := "\n \t \t ${INDENT_PROBE}\n`)).toBeNull();
		// Nor where the probe is not a line of its own any more, or the answer is empty.
		expect(newLineIndent(`x := Foo(a, ${INDENT_PROBE}\n`)).toBeNull();
		expect(newLineIndent("")).toBeNull();
	});

	test("a line's own indentation is that of the formatter's last line, where that is still the line", () => {
		expect(ownLineQuestion("a;\r\n\t\t:ENDIF;")).toBe("a;\n\t\t:ENDIF;\n");
		expect(ownLineIndent(":IF a;\n\tb := 1;\n:ENDIF;\n", "\t\t:endif;")).toBe("");
		expect(ownLineIndent("\t:IF a;\n\t\tb := 1;\n\t:ENDIF;\n\n", "\t\t:ENDIF;")).toBe("\t");
		// Spacing and letter case are the formatter's to change; anything else is another line.
		expect(ownLineIndent("\tx := Foo(a, b);\n", "x:=foo( a,b ) ;")).toBe("\t");
		expect(ownLineIndent("\tx := Foo(a,\n\t         b);\n", "x := Foo(a, b);")).toBeNull();
		expect(ownLineIndent("\t:ENDIF;\n", "   ")).toBeNull();
	});

	test("a cursor keeps its place in the text when the indentation before it changes", () => {
		// At the end of the old indentation: at the end of the new.
		expect(columnAfterIndent(3, "\t\t", "\t")).toBe(2);
		expect(columnAfterIndent(1, "", "\t\t")).toBe(3);
		// Further along, in the text: as far along it as before.
		expect(columnAfterIndent(10, "\t\t", "\t")).toBe(9);
		expect(columnAfterIndent(8, "", "\t")).toBe(9);
		// Within the old indentation: within the new.
		expect(columnAfterIndent(2, "\t\t\t", "\t")).toBe(2);
		expect(columnAfterIndent(3, "\t\t\t", "\t")).toBe(2);
	});

	test("what was typed is read from the changes a keystroke makes", () => {
		expect(typedForIndent([{ text: ";", rangeLength: 0 }])).toBe("end");
		expect(typedForIndent([{ text: "\n\t", rangeLength: 0 }])).toBe("line");
		expect(typedForIndent([{ text: "\r\n", rangeLength: 0 }])).toBe("line");
		// Enter after an Enter takes the first one's spaces away as well.
		expect(typedForIndent([{ text: "", rangeLength: 2 }, { text: "\n\t\t", rangeLength: 0 }])).toBe("line");
		// A letter, a paste with text in it, a ";" put over a selection, two cursors each typing ";".
		expect(typedForIndent([{ text: "a", rangeLength: 0 }])).toBeNull();
		expect(typedForIndent([{ text: "\n\tx := 1;", rangeLength: 0 }])).toBeNull();
		expect(typedForIndent([{ text: ";", rangeLength: 4 }])).toBeNull();
		expect(typedForIndent([{ text: ";", rangeLength: 0 }, { text: ";", rangeLength: 0 }])).toBeNull();
		expect(typedForIndent([])).toBeNull();
	});
});

// The server itself.
function pinnedServer(): string | null {
	const suffix = process.platform === "win32" ? ".exe" : "";
	for (const path of [process.env.STARLIMS_LSP, join(import.meta.dir, "..", "vendor", `starlims-lsp${suffix}`)]) {
		if (!path || !existsSync(path)) continue;
		try {
			if (/starlims-lsp version (\S+)/.exec(Bun.spawnSync([path, "--version"]).stdout.toString())?.[1] === LSP_PIN) return path;
		} catch {
			// Not a program this system can start.
		}
	}
	return null;
}
const server = pinnedServer();

/** The language server over its standard streams, asked to format one text at a time. */
function formatter(path: string) {
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
	let count = 0;
	const started = request("initialize", { processId: null, rootUri: "file:///ws", capabilities: {} }).then(() => send({ method: "initialized", params: {} }));
	return {
		/** As `LspSession.formatText` does it: the text opened under a name of its own, formatted, closed. */
		async format(text: string, ending = ".ssl"): Promise<string> {
			await started;
			const uri = `file:///ws/.ssl-studio/format-${++count}${ending}`;
			send({ method: "textDocument/didOpen", params: { textDocument: { uri, languageId: "ssl", version: 1, text } } });
			const edits = (await request("textDocument/formatting", { textDocument: { uri }, options: { tabSize: 4, insertSpaces: false } })) ?? [];
			send({ method: "textDocument/didClose", params: { textDocument: { uri } } });
			return applyTextEdits(text, edits);
		},
		stop: () => void child.kill(),
	};
}

describe.skipIf(!server)(`starlims-lsp ${LSP_PIN}: the indentation its formatter gives`, () => {
	const lsp = server ? formatter(server) : null;
	afterAll(() => lsp?.stop());
	const under = async (above: string[], ending?: string) => newLineIndent(await lsp!.format(newLineQuestion(above.join("\n")), ending));
	const own = async (lines: string[]) => ownLineIndent(await lsp!.format(ownLineQuestion(lines.join("\n"))), lines.at(-1)!);
	const PROC = [":PROCEDURE Run;", ":PARAMETERS nA;"];

	test("a new line goes in under what opens a block, and stays out after what closes one", async () => {
		expect(await under([":PROCEDURE Run;"])).toBe("\t");
		expect(await under([...PROC, ":IF nA > 1;"])).toBe("\t\t");
		expect(await under([...PROC, ":IF nA > 1;", "nA := 1;", ":ELSE;"])).toBe("\t\t");
		expect(await under([...PROC, ":IF nA > 1;", "nA := 1;", ":ENDIF;"])).toBe("\t");
		expect(await under([...PROC, ":WHILE nA < 5;", ":FOR nI := 1 :TO 3;"])).toBe("\t\t\t");
		expect(await under([...PROC, ":TRY;", "nA := 1;", ":CATCH;"])).toBe("\t\t");
		expect(await under([...PROC, ":ENDPROC;"])).toBe("");
		expect(await under([])).toBe("");
	});

	test("the cases of a :BEGINCASE, which no pair of patterns could say", async () => {
		expect(await under([...PROC, ":BEGINCASE;"])).toBe("\t\t");
		expect(await under([...PROC, ":BEGINCASE;", ":CASE nA == 1;"])).toBe("\t\t");
		expect(await under([...PROC, ":BEGINCASE;", ":CASE nA == 1;", "nA := 2;", ":OTHERWISE;"])).toBe("\t\t");
		expect(await under([...PROC, ":BEGINCASE;", ":CASE nA == 1;", "nA := 2;", ":ENDCASE;"])).toBe("\t");
	});

	test("a statement that runs on is lined up as the formatter lines it up", async () => {
		const indent = await under([...PROC, "nA := Max(nA,"]);
		expect(indent).not.toBeNull();
		expect(indent!.startsWith("\t")).toBe(true);
		expect(indent!.length).toBeGreaterThan(1);
	});

	test("inside a string or a comment there is no indentation to give", async () => {
		expect(await under([...PROC, 'aRows := SQLExecute("', "\tSELECT 1"])).toBeNull();
		expect(await under([...PROC, "/* a note that is not closed"])).toBeNull();
	});

	test("a statement as it is ended goes where the formatter puts it: the closing keyword comes back out", async () => {
		expect(await own([...PROC, ":IF nA > 1;", "\t\tnA := 1;", "\t\t:ENDIF;"])).toBe("\t");
		expect(await own([...PROC, ":IF nA > 1;", "\t\tnA := 1;", "\t\t:ELSE;"])).toBe("\t");
		expect(await own([...PROC, ":BEGINCASE;", ":CASE nA == 1;", "nA := 2;", "\t\t\t:ENDCASE;"])).toBe("\t");
		expect(await own([...PROC, "\t\t\tnA := 1;"])).toBe("\t");
		expect(await own([...PROC, "\t\t:ENDPROC;"])).toBe("");
	});

	test("an SQL data source is not indented as SSL: the server, told the file's name, leaves it as it is", async () => {
		expect(await under(["SELECT SAMPLE_ID", "FROM DEMO_SAMPLES"], ".ds")).toBeNull();
	});
});
