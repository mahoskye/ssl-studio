// Format on save leaves the changed lines as "Format document" would (state.ts `formatChanged`,
// session.ts `formatRangesAsDocument`): the lines are taken from a format of the whole document. Asked here of
// the pinned language server, since it is its two formats, of a document and of a range, that differed.
import { afterAll, describe, expect, test } from "bun:test";
import { LSP_PIN } from "../src/bun/tools";
import { formattedParts, smallEdits } from "../src/view/lsp/edits";
import { formatter, pinnedServer } from "./pinnedFormatter";

const server = pinnedServer();

describe.skipIf(!server)(`starlims-lsp ${LSP_PIN}: the changed lines of a save are as "Format document" leaves them`, () => {
	const lsp = server ? formatter(server) : null;
	afterAll(() => lsp?.stop());

	/** A text with the lines of `ranges` replaced by what a format of the whole text has for them, as a save does it. */
	async function saved(lines: string[], ranges: [number, number][]) {
		const whole = (await lsp!.format(`${lines.join("\n")}\n`)).replace(/\n$/, "").split("\n");
		const parts = formattedParts(lines, whole, ranges)!;
		const out = [...lines];
		// From the last part to the first, so that a part's lines keep their numbers until it is put in.
		for (const part of [...parts].reverse()) {
			// The edits made are the small ones; they give the part's new lines, which is what is put in here.
			expect(smallEdits(part.oldLines, part.newLines).length).toBeGreaterThanOrEqual(0);
			out.splice(part.start, part.oldLines.length, ...part.newLines);
		}
		return { out, whole };
	}

	const FIRST = [":PROCEDURE first;", ":PARAMETERS nA;", ":DECLARE aRows;", 'aRows:=sqlexecute("SELECT 1") ;', ":IF nA>1;", "nA:=1 ;", ":ENDIF;", ":RETURN aRows;", ":ENDPROC;"];
	const SECOND = [":PROCEDURE second;", ":PARAMETERS nB;", "nB:=len( nB ) ;", ":RETURN nB;", ":ENDPROC;"];

	test("the procedure that changed is as a format of the document has it; the one that did not is as it was", async () => {
		const doc = [...FIRST, ...SECOND];
		const { out, whole } = await saved(doc, [[0, FIRST.length - 1]]);
		// What a range format leaves out is there: the built-in function's letter case, and the blank lines between blocks.
		expect(out.some((line) => line.includes("SQLExecute("))).toBe(true);
		expect(out.indexOf("\t:IF nA > 1;")).toBeGreaterThan(0);
		expect(out[out.indexOf("\t:IF nA > 1;") - 1]).toBe("");
		// The second procedure, line for line, is untouched.
		expect(out.slice(-SECOND.length)).toEqual(SECOND);
		// And the first is the formatter's own text of it: the lines of the whole format up to the second procedure.
		const upTo = whole.indexOf(":PROCEDURE second;");
		expect(out.slice(0, out.length - SECOND.length)).toEqual(whole.slice(0, upTo));
	});

	test('"Format document" after such a save changes nothing in the lines that were saved', async () => {
		const doc = [...FIRST, ...SECOND];
		const { out } = await saved(doc, [[0, FIRST.length - 1]]);
		const again = (await lsp!.format(`${out.join("\n")}\n`)).replace(/\n$/, "").split("\n");
		const mine = out.length - SECOND.length;
		expect(again.slice(0, mine)).toEqual(out.slice(0, mine));
	});

	test("one changed line outside any procedure is formatted alone, with the blank line the formatter puts beside it", async () => {
		const doc = [":DECLARE nA, nB;", "nA:=1 ;", "nB  :=  len( nA ) ;", ":RETURN nB;"];
		const { out } = await saved(doc, [[2, 2]]);
		// The line before it, which did not change, keeps its spacing. The blank line before :RETURN is the
		// formatter's, and stands next to the changed line: "Format document" would find nothing left to do there.
		expect(out).toEqual([":DECLARE nA, nB;", "nA:=1 ;", "nB := Len(nA);", "", ":RETURN nB;"]);
	});

	test("a document that is formatted already is left as it is", async () => {
		const formatted = (await lsp!.format(`${[...FIRST, ...SECOND].join("\n")}\n`)).replace(/\n$/, "").split("\n");
		const { out } = await saved(formatted, [[0, formatted.length - 1]]);
		expect(out).toEqual(formatted);
	});
});
