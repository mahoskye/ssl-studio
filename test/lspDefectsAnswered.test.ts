// The three defects the second review of the editor reported to the language server (L11 to L13 in
// docs/LSP-REQUESTS.md, mahoskye/starlims-lsp#378, #379 and #380), asked of the pinned server for real. The IDE
// applies what the server answers and guards none of them itself, so these tests are what says they are gone.
import { afterAll, describe, expect, test } from "bun:test";
import { LSP_PIN } from "../src/bun/tools";
import { formatter, pinnedServer } from "./pinnedFormatter";

const server = pinnedServer();
const lsp = server ? formatter(server) : null;
afterAll(() => lsp?.stop());

/** The place just after `before` on the given line. Every text here is in the Basic Multilingual Plane, so a character is one UTF-16 unit. */
const after = (text: string, line: number, before: string) => ({ line, character: text.split("\n")[line].indexOf(before) + before.length });

describe("L11 — no rename of .T., .F., .AND., .OR. or .NOT. (#378)", () => {
	test.skipIf(!lsp)(`starlims-lsp ${LSP_PIN}: the letters of a dotted literal or operator are no name to rename`, async () => {
		const text = ":DECLARE bDone, bOther;\nbDone := .T.;\nbOther := .NOT. bDone .AND. .F.;\n";
		for (const [line, word] of [[1, ".T"], [2, ".NO"], [2, ".AN"], [2, ".F"]] as const) {
			const at = after(text, line, word);
			expect(await lsp!.at("textDocument/prepareRename", text, at)).toBeNull();
			expect(await lsp!.rename(text, at, "Z")).toBeNull();
		}
	});

	test.skipIf(!lsp)(`starlims-lsp ${LSP_PIN}: a variable spelled like one of them is renamed alone`, async () => {
		const text = ":DECLARE t;\nt := .T.;\n:IF t .AND. .T.;\n:ENDIF;\n";
		const answer = await lsp!.rename(text, { line: 1, character: 0 }, "bOk");
		const edits = Object.values(answer.changes as Record<string, { range: { start: { line: number; character: number } }; newText: string }[]>).flat();
		expect(edits.map((edit) => [edit.range.start.line, edit.range.start.character])).toEqual([
			[0, 9],
			[1, 0],
			[2, 4],
		]);
	});
});

describe("L12 — one unit for columns and token lengths (#379)", () => {
	test.skipIf(!lsp)(`starlims-lsp ${LSP_PIN}: after a string holding °, the comma itself moves signature help to the next parameter`, async () => {
		const text = ':DECLARE s;\ns := Left("25 °C",2);\n';
		const help = await lsp!.at("textDocument/signatureHelp", text, after(text, 1, '"25 °C",'));
		expect(help.signatures[0].label).toStartWith("Left(");
		expect(help.activeParameter).toBe(1);
	});

	test.skipIf(!lsp)(`starlims-lsp ${LSP_PIN}: a SQL placeholder after non-ASCII text hovers from its first letter`, async () => {
		const text = ":DECLARE sId, aRows;\naRows := SQLExecute(\"select '°C → µg/L' from t1 where c2 = ?sId?\", \"DB\");\n";
		const hover = await lsp!.at("textDocument/hover", text, after(text, 1, "?"));
		expect(hover?.contents?.value).toContain("?sId?");
	});

	test.skipIf(!lsp)(`starlims-lsp ${LSP_PIN}: a SQL placeholder hovers on a later line of a multi-line string`, async () => {
		const text = ':DECLARE sId, aRows;\naRows := SQLExecute("select c1\n  from t1 where c2 = ?sId?", "DB");\n';
		const hover = await lsp!.at("textDocument/hover", text, after(text, 2, "?s"));
		expect(hover?.contents?.value).toContain("?sId?");
	});
});

describe("L13 — Me: lists the class's own members (#380)", () => {
	test.skipIf(!lsp)(`starlims-lsp ${LSP_PIN}: Me: in a class of the workspace offers its fields and its methods, a method as a snippet`, async () => {
		const text = ":CLASS Counter;\n:DECLARE nCount;\n\n:PROCEDURE Bump;\n:PARAMETERS nBy;\nMe:nCount := Me:nCount + nBy;\n:ENDPROC;\n\n:PROCEDURE Reset;\nMe:\n:ENDPROC;\n";
		const answer = await lsp!.at("textDocument/completion", text, { line: 9, character: 3 }, { context: { triggerKind: 2, triggerCharacter: ":" } });
		const items: { label: string; insertText?: string; insertTextFormat?: number }[] = Array.isArray(answer) ? answer : answer.items;
		expect(items.map((item) => item.label).sort()).toEqual(["Bump", "Reset", "nCount"]);
		const bump = items.find((item) => item.label === "Bump")!;
		// The editor inserts it as a snippet (insertTextFormat 2, `LspSession`'s completion provider).
		expect([bump.insertText, bump.insertTextFormat]).toEqual(["Bump(${1:nBy})", 2]);
	});
});
