// The self-test's console: the ERR blocks Monaco's WebKit clipboard workaround logs for a click or key press the
// self-test sends by script are explained once and counted; any other ERR block is passed on whole and said to be
// unexplained (scripts/selftestConsole.ts). The blocks are written here in the shape the Linux app logs them.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { CLIPBOARD_NOTE, consoleNotes, passOn, readErrBlock, UNEXPLAINED_NOTE } from "../scripts/selftestConsole";

const ERR = "[webview:1] [console.error] %c  ERR color: #f33 write@[native code]";
const MONACO = "e@views://main/assets/editor.api-SLXcqcUo.js:473:79629";
/** A key press the self-test dispatched. */
const KEY = [ERR, MONACO, "dispatchEvent@[native code]", "b@views://main/assets/selftest-CAsyEbYj.js:2:2072", "E@views://main/assets/selftest-CAsyEbYj.js:2:2312"];
/** A click the cycle self-test made with `element.click()`. */
const CLICK = [ERR, MONACO, "click@[native code]", "g@views://main/assets/selftestCycle-CEWYo-dX.js:1:721"];
/** The same refusal with no self-test frame: from a click or key press of a person. */
const REAL = [ERR, MONACO];
/** Another error the editor logged while the self-test was driving it: not a clipboard write. */
const OTHER = ["[webview:1] [console.error] %c  ERR color: #f33 setValue@views://main/assets/editor.api-SLXcqcUo.js:12:34", "f@views://main/assets/selftestDocs-CEObBXgC.js:1:99"];

const run = (lines: string[]) => {
	const notes = consoleNotes();
	const reader = notes.reader();
	const out = [...lines.flatMap((line) => reader.push(line)), ...reader.end()];
	return { out, summary: notes.summary() };
};

describe("an ERR block's stack", () => {
	test("says a clipboard write was refused, and which self-test file sent the event", () => {
		expect(readErrBlock(KEY)).toEqual({ clipboard: true, scriptedBy: "selftest" });
		expect(readErrBlock(CLICK)).toEqual({ clipboard: true, scriptedBy: "selftestCycle" });
		expect(readErrBlock(REAL)).toEqual({ clipboard: true, scriptedBy: null });
		expect(readErrBlock(OTHER)).toEqual({ clipboard: false, scriptedBy: "selftestDocs" });
	});
});

describe("the self-test's console", () => {
	test("the first clipboard ERR from a scripted event is shown by its first line and explained; the rest are counted", () => {
		const { out, summary } = run(["before", ...KEY, "between", ...CLICK, ...KEY, "after"]);
		expect(out).toEqual(["before", ERR, CLIPBOARD_NOTE, "between", "after"]);
		expect(summary).toEqual(["selftest: 3 clipboard ERR blocks from clicks and key presses the self-test sent by script (selftest 2, selftestCycle 1): expected, not a failure."]);
	});

	test("one that did not come from the self-test is passed on whole, said to be unexplained, and counted apart", () => {
		const { out, summary } = run([...KEY, ...REAL, "next"]);
		expect(out).toEqual([ERR, CLIPBOARD_NOTE, ...REAL, UNEXPLAINED_NOTE, "next"]);
		expect(summary).toEqual([
			"selftest: 1 clipboard ERR block from clicks and key presses the self-test sent by script (selftest 1): expected, not a failure.",
			"selftest: 1 editor ERR block not explained: read it above.",
		]);
	});

	test("an ERR that is no refused clipboard write is not explained away, even when the self-test caused it", () => {
		const { out, summary } = run(OTHER);
		expect(out).toEqual([...OTHER, UNEXPLAINED_NOTE]);
		expect(summary).toEqual(["selftest: 1 editor ERR block not explained: read it above."]);
	});

	test("every other line goes through as it came, a frame-like one too, and a run with no ERR says nothing at its end", () => {
		const lines = ["selftest: ok", "dispatchEvent@[native code]", "[webview:1] [console.log] ready", ""];
		expect(run(lines)).toEqual({ out: lines, summary: [] });
	});

	test("a block the stream ends in is closed at its end; Windows line ends are read too", () => {
		expect(run(KEY.map((line) => `${line}\r`)).out).toEqual([ERR, CLIPBOARD_NOTE]);
	});

	test("the close check's two runs are counted together, each stream with a reader of its own", () => {
		const notes = consoleNotes();
		const out = notes.reader();
		const err = notes.reader();
		out.push(KEY[0]);
		err.push("an error line of its own");
		for (const line of KEY.slice(1)) out.push(line);
		out.end();
		for (const line of CLICK) notes.reader().push(line);
		expect(notes.summary()[0]).toStartWith("selftest: 1 clipboard ERR block");
	});
});

describe("passing a stream on", () => {
	test("a block split across chunks, in the middle of a line, is read as one", async () => {
		const text = ["start", ...KEY, ...CLICK, "end"].join("\n") + "\n";
		const bytes = new TextEncoder().encode(text);
		const cuts = [7, 30, 61, 120, 121, 200, bytes.length];
		const stream = new ReadableStream<Uint8Array>({
			start(controller) {
				let from = 0;
				for (const to of cuts) {
					controller.enqueue(bytes.slice(from, to));
					from = to;
				}
				controller.close();
			},
		});
		const notes = consoleNotes();
		let written = "";
		await passOn(stream, notes.reader(), (chunk) => (written += chunk));
		expect(written).toBe(["start", ERR, CLIPBOARD_NOTE, "end", ""].join("\n"));
		expect(notes.summary()[0]).toContain("(selftest 1, selftestCycle 1)");
	});

	test("the runner passes the app's output through it, and says the summary once the app is gone", () => {
		const runner = readFileSync(join(import.meta.dir, "..", "scripts", "selftest.ts"), "utf8");
		expect(runner).toContain('stdout: "pipe"');
		expect(runner).not.toContain('stdout: "inherit"');
		expect(runner.match(/await settle\(\);/g)?.length).toBe(2);
	});
});
