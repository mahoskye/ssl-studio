// A save does not depend on the language server: format on save waits for the server's formatting no longer than a
// set time, the file is then written as it was typed, and it is said once. Seen on 2026-11-26 with an old
// starlims-lsp taken from the PATH: it answered `initialize`, asked the client to register a file watcher, and read
// nothing after that. Ctrl+S then wrote nothing and said nothing for as long as the server ran.
// The view's side runs the real state module and the real LSP session against a backend that is a function here,
// with Monaco and the dialogs replaced. The language server is that function too: it answers what a test lets it
// answer, and otherwise says nothing. The set-up is test/viewWithFakeServer.ts.
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { flush, snapshot } from "solid-js";
import { DEFAULT_SETTINGS } from "../src/shared/protocol";
import {
	FORMAT,
	FORMATTED,
	PROCEDURE,
	SILENT,
	TYPED,
	answer,
	asked,
	connectTestRpc,
	dirty,
	disconnectTestRpc,
	files,
	formatOnSaveWait,
	formatsTheLine,
	handshake,
	lsp,
	openChanged,
	pushed,
	readsRanges,
	resetAll,
	save,
	saveAll,
	serverRuns,
	session,
	setState,
	sleep,
	state,
	textOf,
	timed,
	topLine,
	typeInto,
	until,
} from "./viewWithFakeServer";

const NOTICE = "The language server is not answering: files are saved without formatting until it does.";
/** The notice, by the number of each time it was said. */
const said = () => snapshot(state).messages.filter((m) => m.text === NOTICE).map((m) => m.id);
const skips = () => snapshot(state).output.filter((line) => line.includes("format on save skipped"));

describe("a save does not wait on a language server that does not answer", () => {
	// The waits as they ship are the bound a person meets; the tests run on shorter ones.
	const shipped = { ...formatOnSaveWait };
	const LONG = 300;
	const SHORT = 20;
	beforeAll(async () => {
		await connectTestRpc();
		Object.assign(formatOnSaveWait, { answering: LONG, silent: SHORT });
	});
	beforeEach(async () => {
		resetAll();
		// The refusals reach the saves that waited, and the silence of the test before is over.
		await sleep(0);
	});
	// The state module is one for the whole run: the waits and the silence are put back for the test files after this one.
	afterAll(async () => {
		resetAll();
		await sleep(0);
		Object.assign(formatOnSaveWait, shipped);
		await disconnectTestRpc();
	});

	test("the wait that ships is two seconds, and a quarter of a second while the server is silent", () => {
		expect(shipped).toEqual({ answering: 2000, silent: 250 });
		expect(DEFAULT_SETTINGS.formatOnSave).toBe(true);
	});

	test("a server that never finishes starting: the file is written when the wait is up, as typed, and it is said", async () => {
		const path = "/ws/Demo.ssl";
		await serverRuns(() => SILENT);
		await openChanged(path);

		const first = await timed(save(path));
		expect(first.result).toBe(true);
		// It did wait for the server, and no longer than it says.
		expect(first.ms).toBeGreaterThanOrEqual(LONG - 20);
		expect(files.written).toEqual([{ path, text: `${TYPED}\n${PROCEDURE}` }]);
		flush();
		expect(dirty(path)).toBe(false);
		expect(textOf(path)).toBe(`${TYPED}\n${PROCEDURE}`);
		// Said in a notice, with the way out of it, and in Output where it can be read again.
		expect(said().length).toBe(1);
		const notice = snapshot(state).messages.find((m) => m.text === NOTICE)!;
		expect(notice.kind).toBe("info");
		expect(notice.action?.label).toBe("Restart");
		expect(skips().length).toBe(1);
		expect(skips()[0]).toContain(`format on save skipped: the language server did not answer in ${LONG / 1000} s`);
		// The handshake was never answered, so nothing else was asked of the server.
		expect(lsp.sent.filter((m) => m.id !== undefined).map((m) => m.method)).toEqual(["initialize"]);

		// The button restarts the server, as the status bar's does.
		notice.action!.run();
		await until(() => files.restarts === 1);
	});

	test("the build that was seen (the handshake answered, then nothing): saved all the same, and said once for the silence", async () => {
		const path = "/ws/Demo.ssl";
		await serverRuns((request) => (request.method === "initialize" ? handshake : SILENT));
		await session.waitReady();
		await openChanged(path);

		const first = await timed(save(path));
		expect(first.result).toBe(true);
		expect(first.ms).toBeGreaterThanOrEqual(LONG - 20);
		expect(files.written.map((w) => w.text)).toEqual([`${TYPED}\n${PROCEDURE}`]);
		expect(asked("textDocument/documentSymbol").length).toBe(1);
		const once = said();
		expect(once.length).toBe(1);

		// Saved again while the server still says nothing: the short wait, the file written, and no second notice.
		typeInto(path, "/* more; */\n");
		flush();
		const second = await timed(save(path));
		expect(second.result).toBe(true);
		expect(second.ms).toBeLessThan(LONG - 50);
		expect(files.written.length).toBe(2);
		expect(files.written[1]!.text).toBe(`/* more; */\n${TYPED}\n${PROCEDURE}`);
		flush();
		expect(dirty(path)).toBe(false);
		expect(said()).toEqual(once);
		// Output has each.
		expect(skips().length).toBe(2);
		expect(skips()[1]).toContain(`did not answer in ${SHORT / 1000} s`);
	});

	test("an answer that comes after the file is written is not put into it", async () => {
		const path = "/ws/Demo.ssl";
		// The outline is answered; the formatting is not, until the test answers it.
		await serverRuns((request) => (request.method === "initialize" ? handshake : request.method === "textDocument/documentSymbol" ? [] : SILENT));
		await session.waitReady();
		await openChanged(path);
		readsRanges(path);

		expect((await timed(save(path))).result).toBe(true);
		expect(files.written.map((w) => w.text)).toEqual([`${TYPED}\n${PROCEDURE}`]);
		const late = asked(FORMAT);
		expect(late.length).toBe(1);
		expect(late[0]!.params.textDocument.uri).toContain("Demo.ssl");
		const once = said();
		expect(once.length).toBe(1);

		// The server answers now, with the line formatted. The file on disk is as typed, and so the document stays.
		answer(late[0]!.id!, formatsTheLine(late[0]!));
		await sleep(5);
		flush();
		expect(textOf(path)).toBe(`${TYPED}\n${PROCEDURE}`);
		expect(dirty(path)).toBe(false);
		expect(files.written.length).toBe(1);

		// It answers again, so the next save waits the long time for it once more, and gets its formatting.
		lsp.answers = (request) => (request.method === "textDocument/documentSymbol" ? [] : request.method === FORMAT ? [{ range: topLine("nTotal:=2;".length), newText: "nTotal := 2;" }] : SILENT);
		typeInto(path, "nTotal:=2;\n");
		flush();
		const next = await timed(save(path));
		expect(next.result).toBe(true);
		expect(next.ms).toBeLessThan(LONG - 50);
		expect(files.written.at(-1)!.text).toBe(`nTotal := 2;\n${TYPED}\n${PROCEDURE}`);
		expect(textOf(path)).toBe(`nTotal := 2;\n${TYPED}\n${PROCEDURE}`);
		expect(said()).toEqual(once);
		expect(skips().length).toBe(1);
	});

	test("a server that answers formats the changed lines before the file is written, and nothing is said", async () => {
		const path = "/ws/Demo.ssl";
		await serverRuns((request) => (request.method === "initialize" ? handshake : request.method === "textDocument/documentSymbol" ? [] : request.method === FORMAT ? formatsTheLine(request) : SILENT));
		await session.waitReady();
		await openChanged(path);
		readsRanges(path);

		const saved = await timed(save(path));
		expect(saved.result).toBe(true);
		expect(saved.ms).toBeLessThan(LONG - 50);
		expect(files.written).toEqual([{ path, text: `${FORMATTED}\n${PROCEDURE}` }]);
		flush();
		expect(dirty(path)).toBe(false);
		expect(said()).toEqual([]);
		expect(skips()).toEqual([]);

		// With the setting off the server is not asked at all.
		setState((s) => {
			s.settings.formatOnSave = false;
		});
		flush();
		const before = asked(FORMAT).length;
		typeInto(path, "nTotal:=2;\n");
		flush();
		expect(await save(path)).toBe(true);
		expect(files.written.at(-1)!.text).toBe(`nTotal:=2;\n${FORMATTED}\n${PROCEDURE}`);
		expect(asked(FORMAT).length).toBe(before);
	});

	test("“Save all” over a silent server waits the long time once, not once for every file", async () => {
		const paths = ["/ws/One.ssl", "/ws/Two.ssl", "/ws/Three.ssl", "/ws/Four.ssl"];
		await serverRuns((request) => (request.method === "initialize" ? handshake : SILENT));
		await session.waitReady();
		for (const path of paths) await openChanged(path);

		const all = await timed(saveAll());
		expect(all.result).toBe(true);
		expect(files.written.map((w) => w.path)).toEqual(paths);
		expect(all.ms).toBeGreaterThanOrEqual(LONG - 20);
		expect(all.ms).toBeLessThan(2 * LONG);
		flush();
		for (const path of paths) expect(dirty(path)).toBe(false);
		expect(said().length).toBe(1);
		expect(skips().length).toBe(paths.length);
	});

	test("a restart ends the silence: the new server is waited for the long time, and its silence is said anew", async () => {
		const path = "/ws/Demo.ssl";
		await serverRuns((request) => (request.method === "initialize" ? handshake : SILENT));
		await session.waitReady();
		await openChanged(path);
		expect((await timed(save(path))).result).toBe(true);
		const first = said();
		expect(first.length).toBe(1);

		// The server is restarted from the status bar: what was asked of the old one is refused, and a new one starts.
		pushed("lspState", { state: "restarting" });
		pushed("lspState", { state: "running" });
		await until(() => asked("initialize").length === 2);
		await session.waitReady();
		// The refusal of what the save had asked is not a second "skipped" in Output: that save was told of already.
		expect(skips().length).toBe(1);

		// The new one is as silent. A save gives it the long wait, and says so again.
		typeInto(path, "/* more; */\n");
		flush();
		const again = await timed(save(path));
		expect(again.result).toBe(true);
		expect(again.ms).toBeGreaterThanOrEqual(LONG - 20);
		expect(files.written.length).toBe(2);
		const second = said();
		expect(second.length).toBe(1);
		expect(second[0]).not.toBe(first[0]);
	});
});
