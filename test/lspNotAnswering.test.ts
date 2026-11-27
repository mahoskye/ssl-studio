// A language server that runs and does not answer is shown as not answering, in one place for everything that
// reads it. Seen on 2026-11-26 with an old starlims-lsp taken from the PATH: it answered `initialize`, asked the
// client to register a file watcher, and read nothing after that. The status bar went on saying it ran, and the
// Outline read "Reading this file's outline…" for as long as the server did.
// The rule is the LSP client's (`answerWait`), the fact is the session's (`lspAnswering`), and the status bar, the
// panels and format on save read it there. The second half runs the real state module and the real session against
// a server that answers what a test lets it answer (test/viewWithFakeServer.ts).
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { flush, snapshot } from "solid-js";
import { lspIndicator } from "../src/shared/statusBar";
import { staleNotice, staleReason } from "../src/view/blocks/model";
import { graphIdle } from "../src/view/graph/model";
import {
	FORMAT,
	LspClient,
	PROCEDURE,
	SILENT,
	answer,
	answerWait,
	asked,
	connectTestRpc,
	disconnectTestRpc,
	documents,
	files,
	formatOnSaveWait,
	handshake,
	loadGraph,
	lsp,
	lspAnswering,
	openChanged,
	openFile,
	pushed,
	refuse,
	resetAll,
	save,
	serverDown,
	serverRuns,
	serverSays,
	serverSilent,
	session,
	sleep,
	sslOutlineEmpty,
	state,
	timed,
	typeInto,
	until,
} from "./viewWithFakeServer";

const shippedAnswerWait = { ...answerWait };
const shippedSaveWait = { ...formatOnSaveWait };
/** The session's own wait in these tests, in milliseconds. */
const WAIT = 80;

describe("the client's rule: a request unanswered for the set time, and nothing answered since it was asked", () => {
	beforeAll(() => {
		answerWait.ms = WAIT;
	});
	afterAll(() => {
		Object.assign(answerWait, shippedAnswerWait);
	});

	/** A client on its own, with what it sent and a way to say things to it as the server would. */
	function client(send: (raw: string) => Promise<void> = async () => {}) {
		const sent: any[] = [];
		let deliver!: (text: string) => void;
		const made = new LspClient({
			send: (raw) => (sent.push(JSON.parse(raw)), send(raw)),
			onMessage: (listener) => {
				deliver = listener;
			},
		});
		const told: boolean[] = [];
		made.onAnswering((answering) => told.push(answering));
		return { client: made, sent, told, says: (message: object) => deliver(JSON.stringify({ jsonrpc: "2.0", ...message })) };
	}
	const quiet = <T>(work: Promise<T>) => work.then(
		(value) => ({ value }),
		(error: Error) => ({ error: error.message }),
	);

	test("the wait that ships is five seconds", () => {
		expect(shippedAnswerWait).toEqual({ ms: 5000 });
	});

	test("no answer in the set time: not answering, said once; the request stays asked and a late answer ends it", async () => {
		const { client: c, told, says } = client();
		expect(c.answering).toBe(true);
		const start = performance.now();
		const outline = quiet(c.request("textDocument/documentSymbol", {}));
		await until(() => !c.answering);
		// Not before the time it says.
		expect(performance.now() - start).toBeGreaterThanOrEqual(WAIT - 5);
		expect(told).toEqual([false]);
		expect(c.silences).toBe(1);
		// More asked of a silent server changes nothing, and is not said again.
		void quiet(c.request("textDocument/foldingRange", {}));
		await sleep(WAIT + 30);
		expect(told).toEqual([false]);
		expect(c.silences).toBe(1);

		// The answer comes after all: it is delivered, and the server answers again.
		says({ id: 1, result: [{ name: "Demo" }] });
		expect(await outline).toEqual({ value: [{ name: "Demo" }] });
		expect(c.answering).toBe(true);
		expect(told).toEqual([false, true]);
		// The request that is still owed was asked before that answer: it does not bring the silence back.
		await sleep(WAIT + 30);
		expect(c.answering).toBe(true);
		expect(told).toEqual([false, true]);
	});

	test("only an answer counts: the server's own requests and notifications do not show that it reads", async () => {
		const { client: c, sent, told, says } = client();
		void quiet(c.request("textDocument/documentSymbol", {}));
		// What the build that was seen did: it went on talking, and read nothing.
		says({ id: 0, method: "client/registerCapability", params: { registrations: [] } });
		says({ method: "textDocument/publishDiagnostics", params: { uri: "file:///ws/Demo.ssl", diagnostics: [] } });
		await sleep(WAIT / 2);
		says({ method: "window/logMessage", params: { type: 3, message: "still here" } });
		await until(() => !c.answering);
		expect(told).toEqual([false]);
		// Its request was answered all the same.
		expect(sent.some((m) => m.id === 0 && !m.method)).toBe(true);
		// And saying more of its own does not end the silence.
		says({ method: "window/logMessage", params: { type: 3, message: "and still" } });
		expect(c.answering).toBe(false);
	});

	test("a refusal is an answer, and so is an answer to a request no longer waited for", async () => {
		const { client: c, told, says } = client();
		const first = quiet(c.request("textDocument/documentHighlight", {}));
		await until(() => !c.answering);
		says({ id: 1, error: { code: -32601, message: "method not supported" } });
		expect(await first).toEqual({ error: "method not supported" });
		expect(c.answering).toBe(true);

		void quiet(c.request("textDocument/hover", {}));
		await until(() => !c.answering);
		// An answer that names no request of this client's: the server answered something.
		says({ id: 999, result: null });
		expect(c.answering).toBe(true);
		expect(told).toEqual([false, true, false, true]);
		expect(c.silences).toBe(2);
	});

	test("one slow request beside answered ones is not a silence; the next unanswered one is", async () => {
		const { client: c, told, says } = client();
		// A long piece of work, asked first.
		void quiet(c.request("ssl/callGraph", {}));
		await sleep(WAIT / 2);
		const quick = quiet(c.request("textDocument/hover", {}));
		says({ id: 2, result: null });
		await quick;
		// The slow one has now waited longer than the time, and the server answered after it was asked.
		await sleep(WAIT + 40);
		expect(c.answering).toBe(true);
		expect(told).toEqual([]);

		// Asked after that answer and left unanswered: this one shows it.
		const start = performance.now();
		void quiet(c.request("textDocument/documentSymbol", {}));
		await until(() => !c.answering);
		expect(performance.now() - start).toBeGreaterThanOrEqual(WAIT - 5);
		expect(told).toEqual([false]);
	});

	test("an answered server is never silent, however long nothing is asked of it", async () => {
		const { client: c, told, says } = client();
		const one = quiet(c.request("textDocument/hover", {}));
		says({ id: 1, result: null });
		await one;
		await sleep(WAIT + 40);
		expect(c.answering).toBe(true);
		expect(told).toEqual([]);
	});

	test("a request that never reached the server says nothing about the server", async () => {
		const { client: c, told } = client(() => Promise.reject(new Error("pipe closed")));
		expect(await quiet(c.request("textDocument/hover", {}))).toEqual({ error: "pipe closed" });
		await sleep(WAIT + 40);
		expect(c.answering).toBe(true);
		expect(told).toEqual([]);
	});

	test("refusing all that is owed (a restart) ends the silence, and the next server is judged by what it is asked", async () => {
		const { client: c, told } = client();
		const owed = quiet(c.request("textDocument/documentSymbol", {}));
		await until(() => !c.answering);
		c.rejectAll("restarting");
		expect(await owed).toEqual({ error: "textDocument/documentSymbol: restarting" });
		expect(c.answering).toBe(true);
		expect(told).toEqual([false, true]);
		// Nothing is owed: no silence comes of the old requests.
		await sleep(WAIT + 40);
		expect(c.answering).toBe(true);
		// The new server is as silent: its own count.
		void quiet(c.request("initialize", {}));
		await until(() => !c.answering);
		expect(c.silences).toBe(2);
		expect(told).toEqual([false, true, false]);
	});

	test("a caller that gives up sooner says so: silent from then, if something asked since the last answer is owed", async () => {
		const { client: c, told, says } = client();
		// Nothing owed: nothing to conclude.
		c.noAnswer();
		expect(c.answering).toBe(true);

		// Owed, and asked before the server last answered: the server is there, and slow over that one.
		void quiet(c.request("textDocument/rangeFormatting", {}));
		const quick = quiet(c.request("textDocument/hover", {}));
		says({ id: 2, result: null });
		await quick;
		c.noAnswer();
		expect(c.answering).toBe(true);
		expect(told).toEqual([]);

		// Owed and nothing answered since: silent now, well before the client's own time.
		const start = performance.now();
		void quiet(c.request("textDocument/documentSymbol", {}));
		c.noAnswer();
		expect(performance.now() - start).toBeLessThan(WAIT / 2);
		expect(c.answering).toBe(false);
		expect(told).toEqual([false]);
		expect(c.silences).toBe(1);
		// Said again while it lasts: the same silence. The client's own clock does not count it twice either.
		c.noAnswer();
		await sleep(WAIT + 40);
		expect(c.silences).toBe(1);
		expect(told).toEqual([false]);
	});
});

describe("what the status bar item says of it", () => {
	const info = { ok: true, version: "0.32.0" };

	test("running and not answering: said in the label, red, with what waits and the restart", () => {
		const silent = lspIndicator({ state: "running" }, info, true, false);
		expect(silent).toMatchObject({ tone: "error", label: "LSP not answering", actionable: true });
		expect(silent.detail).toContain("Language server 0.32.0 is running and not answering");
		expect(silent.detail).toContain("the outline, checks, completions and formatting wait for it");
		expect(silent.detail).toEndWith("\nClick to restart.");
		expect(silent.ariaLabel).toBe("Language server 0.32.0 not answering. Click to restart.");
		// Answering, it is as it was; the argument left out is a server that answers.
		expect(lspIndicator({ state: "running" }, info, true, true)).toMatchObject({ tone: "ok", label: "LSP" });
		expect(lspIndicator({ state: "running" }, info, true)).toEqual(lspIndicator({ state: "running" }, info, true, true));
	});

	test("what is known of the build is kept: the build that was seen was not the tested one", () => {
		const note = "Language server dev found; SSL Studio is tested with 0.32.0.";
		const silent = lspIndicator({ state: "running" }, { ok: true, version: "dev", message: note }, true, false);
		expect(silent.tone).toBe("error");
		expect(silent.label).toBe("LSP not answering");
		expect(silent.detail).toContain(note);
		// The note alone is orange and still says LSP: the two are told apart by colour and by word.
		expect(lspIndicator({ state: "running" }, { ok: true, version: "dev", message: note }, true, true)).toMatchObject({ tone: "warn", label: "LSP" });
	});

	test("only a running server can be not answering: starting, stopped and failed say their own", () => {
		expect(lspIndicator({ state: "starting" }, info, true, false)).toEqual(lspIndicator({ state: "starting" }, info, true));
		expect(lspIndicator({ state: "stopped" }, info, true, false)).toEqual(lspIndicator({ state: "stopped" }, info, true));
		expect(lspIndicator({ state: "failed", message: "crashed" }, info, true, false)).toEqual(lspIndicator({ state: "failed", message: "crashed" }, info, true));
		expect(lspIndicator({ state: "stopped" }, info, false, false).tone).toBe("idle");
	});
});

describe("what the blocks view says when a change cannot be made", () => {
	test("a server that runs and does not answer is not “try again in a moment”", () => {
		expect(staleReason("running")).toBe("reading");
		expect(staleReason("running", true)).toBe("reading");
		expect(staleReason("running", false)).toBe("silent");
		// Whether it answers matters only while it runs.
		expect(staleReason("starting", false)).toBe("starting");
		expect(staleReason("failed", false)).toBe("stopped");
		expect(staleNotice("silent", "change")).toBe("The language server is not answering, and blocks cannot be changed without it. Nothing was changed: restart it from the status bar, or switch to Text.");
		expect(staleNotice("silent", "edit")).toContain("The language server is not answering, so the edit is not made yet. It is kept open");
		expect(staleNotice("silent", "edit")).toContain("Escape");
	});
});

describe("what the graph view says of it", () => {
	const SILENT_HINT = "Restart it here or from the status bar.";
	const running = { workspace: true, lsp: "running", answering: true, failed: "", nodes: null };

	test("running and not answering, nothing read yet: said in place of “Reading the workspace…”, with the restart", () => {
		// Answering, and the calls not yet given: nothing is said under the bar, which reads "Reading the workspace…".
		expect(graphIdle({ ...running, waiting: true })).toBeNull();
		expect(graphIdle({ ...running, answering: false, waiting: true })).toEqual({
			text: "The language server is not answering, so there are no calls to show: the graph is read from it.",
			hint: `${SILENT_HINT} If it is only busy, the calls appear when it answers.`,
			restart: true,
		});
	});

	test("with calls read before the silence: they stay, said to be as they were last read", () => {
		const stale = graphIdle({ ...running, answering: false, nodes: 12 });
		expect(stale).toEqual({ text: "The language server is not answering. These are the calls as they were last read.", hint: SILENT_HINT, restart: true });
		// Nothing is being asked for, so an answer brings nothing: that is promised only while the calls are waited for.
		expect(stale!.hint).not.toContain("busy");
		expect(graphIdle({ ...running, answering: false, waiting: true, nodes: 12 })!.hint).toContain("If it is only busy, the calls appear when it answers.");
		// A read that failed before the silence is not what is spoken of while the server says nothing.
		expect(graphIdle({ ...running, answering: false, failed: "Could not read the calls from the language server: boom" })!.text).toStartWith("The language server is not answering");
	});

	test("only a running server can be not answering, and the rest is said as it was", () => {
		expect(graphIdle({ ...running, workspace: false, answering: false })).toEqual({ text: "Open a folder to see the calls between its procedures." });
		for (const lsp of ["starting", "restarting", "stopped", "failed"]) expect(graphIdle({ ...running, lsp, answering: false })).toEqual(graphIdle({ ...running, lsp }));
		expect(graphIdle({ ...running, lsp: "starting" })).toEqual({ text: "The language server is starting. The graph is read from it, and appears when it is ready." });
		expect(graphIdle({ ...running, lsp: "restarting", nodes: 3 })).toEqual({ text: "The language server is starting. These are the calls as they were last read." });
		expect(graphIdle({ ...running, lsp: "failed", lspMessage: "exited with code 2" })).toEqual({
			text: "The language server is not running, so there are no calls to show: the graph is read from it. It said: exited with code 2",
			hint: "Restart it here or from the status bar. If it does not start, Settings has where to find it, under Language server program.",
			restart: true,
		});
		expect(graphIdle({ ...running, lsp: "stopped", nodes: 3 })!.text).toBe("The language server is not running. These are the calls as they were last read.");
		expect(graphIdle({ ...running, failed: "Could not read the calls from the language server: boom" })).toEqual({ text: "Could not read the calls from the language server: boom", hint: "Refresh tries again." });
		expect(graphIdle({ ...running, nodes: 0 })).toEqual({ text: "The language server found no procedures in this folder." });
		expect(graphIdle({ ...running, nodes: 12 })).toBeNull();
	});
});

describe("a language server that runs and does not answer is shown as not answering", () => {
	const SAVE_NOTICE = "The language server is not answering: files are saved without formatting until it does.";
	const SILENT_SENTENCE = "The language server is not answering. Click “LSP not answering” in the status bar to restart it.";
	const OUTLINE_SILENT = `${SILENT_SENTENCE} This file's outline comes from it.`;
	/** The outline the panel has asked for and not yet been given. */
	const unread = { reading: "reading" as const, failure: "", count: 0, filter: "" };
	const symbol = { name: "Demo", kind: 12, range: { start: { line: 0, character: 0 }, end: { line: 2, character: 9 } }, selectionRange: { start: { line: 0, character: 11 }, end: { line: 0, character: 15 } } };
	const info = { ok: true, version: "dev", message: "Language server dev found; SSL Studio is tested with 0.32.0." };

	/** What the status bar item is made from, as the component makes it. */
	const item = () => (flush(), lspIndicator(snapshot(state).lsp, info, Boolean(snapshot(state).workspace), lspAnswering()));
	const shownAnswering = () => (flush(), lspAnswering());
	const said = (text: string) => snapshot(state).messages.filter((m) => m.text === text).map((m) => m.id);

	/** An SSL file open, as the Outline panel has it: the panel asks the session for its symbols. */
	async function openSsl(path: string) {
		files.disk.set(path, { text: PROCEDURE, mtime: 1 });
		await openFile(path, { keep: true });
		flush();
		return documents.get(path)!.model;
	}
	/** The build that was seen: the handshake, then a request of its own, and nothing read after that. */
	async function theBuildThatWasSeen() {
		await serverRuns((request) => (request.method === "initialize" ? handshake : SILENT));
		await session.waitReady();
		serverSays("client/registerCapability", { registrations: [{ id: "watch", method: "workspace/didChangeWatchedFiles" }] }, 0);
	}

	beforeAll(async () => {
		await connectTestRpc();
	});
	beforeEach(async () => {
		resetAll();
		Object.assign(answerWait, { ms: WAIT });
		// A save's own wait is longer than the session's here, unless a test says otherwise.
		Object.assign(formatOnSaveWait, { answering: 400, silent: 20 });
		// The refusals of what the test before left asked reach whoever waited.
		await sleep(0);
	});
	// The state module and the session are one for the whole run: the waits are put back for the files after this one.
	afterAll(async () => {
		resetAll();
		await sleep(0);
		Object.assign(answerWait, shippedAnswerWait);
		Object.assign(formatOnSaveWait, shippedSaveWait);
		await disconnectTestRpc();
	});

	test("the build that was seen: the status bar and the Outline say it, where they said running and “Reading…”", async () => {
		await theBuildThatWasSeen();
		const model = await openSsl("/ws/Demo.ssl");
		// It runs, the handshake is done, and nothing is owed: all is as with a server that works.
		expect(shownAnswering()).toBe(true);
		expect(item()).toMatchObject({ tone: "warn", label: "LSP" });
		expect(serverSilent()).toBe("");

		// The Outline asks for the file's symbols, as the panel does.
		let outline: unknown = "not answered";
		const start = performance.now();
		void session.documentSymbols(model as any).then(
			(list) => (outline = list),
			(e) => (outline = e),
		);
		await until(() => asked("textDocument/documentSymbol").length === 1);
		expect(sslOutlineEmpty(unread)).toBe("Reading this file's outline…");

		await until(() => !session.answering);
		expect(performance.now() - start).toBeGreaterThanOrEqual(WAIT - 5);
		// One fact, read by all of it.
		expect(shownAnswering()).toBe(false);
		expect(item()).toMatchObject({ tone: "error", label: "LSP not answering", actionable: true });
		expect(item().detail).toContain("is running and not answering");
		expect(item().detail).toContain("Click to restart.");
		expect(serverDown()).toBe("");
		expect(serverSilent()).toBe(SILENT_SENTENCE);
		expect(sslOutlineEmpty(unread)).toBe(OUTLINE_SILENT);
		expect(sslOutlineEmpty({ ...unread, compact: true })).toBe(OUTLINE_SILENT);
		// An empty list read before the silence may be out of date: the server is spoken of, not the file.
		expect(sslOutlineEmpty({ reading: "read", failure: "", count: 0, filter: "" })).toBe(OUTLINE_SILENT);
		// Rows that are there stay, and a filter that hides them all is what is spoken of.
		expect(sslOutlineEmpty({ reading: "read", failure: "", count: 3, filter: "zz" })).toBe("Nothing here matches “zz”. Clear the filter to see everything.");
		// The request is not failed: it is still owed.
		expect(outline).toBe("not answered");
	});

	test("a server that never finishes starting is shown the same way", async () => {
		await serverRuns(() => SILENT);
		const model = await openSsl("/ws/Demo.ssl");
		let outline: unknown = "not answered";
		void session.documentSymbols(model as any).then(
			(list) => (outline = list),
			(e) => (outline = e),
		);
		await until(() => !session.answering);
		expect(item()).toMatchObject({ tone: "error", label: "LSP not answering" });
		expect(sslOutlineEmpty(unread)).toBe(OUTLINE_SILENT);
		// Only the handshake was asked: the outline waits behind it.
		expect(lsp.sent.filter((m) => m.id !== undefined && m.method).map((m) => m.method)).toEqual(["initialize"]);
		expect(outline).toBe("not answered");

		// The handshake is answered at last: the session starts, the outline is asked for, and is given.
		lsp.answers = (request) => (request.method === "textDocument/documentSymbol" ? [symbol] : SILENT);
		answer(asked("initialize")[0]!.id!, handshake);
		await until(() => Array.isArray(outline));
		expect((outline as any[]).map((s) => s.name)).toEqual(["Demo"]);
		expect(shownAnswering()).toBe(true);
		expect(item()).toMatchObject({ tone: "warn", label: "LSP" });
		expect(serverSilent()).toBe("");
	});

	test("it recovers by itself: an answer that comes late gives the Outline its list, and all says running again", async () => {
		await theBuildThatWasSeen();
		const model = await openSsl("/ws/Demo.ssl");
		let outline: unknown = "not answered";
		void session.documentSymbols(model as any).then(
			(list) => (outline = list),
			(e) => (outline = e),
		);
		await until(() => !session.answering);
		expect(sslOutlineEmpty(unread)).toBe(OUTLINE_SILENT);

		answer(asked("textDocument/documentSymbol")[0]!.id!, [symbol]);
		await until(() => Array.isArray(outline));
		expect((outline as any[]).map((s) => s.name)).toEqual(["Demo"]);
		expect(session.answering).toBe(true);
		expect(shownAnswering()).toBe(true);
		expect(item()).toMatchObject({ tone: "warn", label: "LSP" });
		expect(serverSilent()).toBe("");
		expect(sslOutlineEmpty(unread)).toBe("Reading this file's outline…");
		// And it stays so while nothing more is asked.
		await sleep(WAIT + 40);
		expect(shownAnswering()).toBe(true);

		// A refusal is an answer too: the panel says the server could not, not that it is silent.
		void session.request("textDocument/documentHighlight", {}).catch(() => {});
		await until(() => !session.answering);
		refuse(asked("textDocument/documentHighlight")[0]!.id!, "method not supported: textDocument/documentHighlight");
		await until(() => session.answering);
		expect(sslOutlineEmpty({ reading: "failed", failure: "method not supported", count: 0, filter: "" })).toBe("The language server could not list this file's outline: method not supported");
	});

	test("a restart ends it: what was asked is refused, and the new server is judged by what it is asked", async () => {
		await theBuildThatWasSeen();
		const model = await openSsl("/ws/Demo.ssl");
		let outline: unknown = "not answered";
		void session.documentSymbols(model as any).then(
			(list) => (outline = list),
			(e) => (outline = e),
		);
		await until(() => !session.answering);
		expect(item().label).toBe("LSP not answering");

		// The status bar item is clicked: the backend stops the server and starts another.
		pushed("lspState", { state: "restarting" });
		await until(() => snapshot(state).lsp.state === "restarting");
		expect(session.answering).toBe(true);
		expect(shownAnswering()).toBe(true);
		expect(item()).toMatchObject({ tone: "error", label: "LSP" });
		expect(serverSilent()).toBe("");
		expect(serverDown()).toBe("The language server is starting.");
		await until(() => outline instanceof Error);
		expect((outline as Error).message).toBe("textDocument/documentSymbol: restarting");

		// The new one answers: nothing is said of the old one's silence.
		lsp.answers = (request) => (request.method === "initialize" ? handshake : request.method === "textDocument/documentSymbol" ? [symbol] : SILENT);
		pushed("lspState", { state: "running" });
		await until(() => asked("initialize").length === 2);
		await session.waitReady();
		expect((await session.documentSymbols(model as any)).map((s) => s.name)).toEqual(["Demo"]);
		await sleep(WAIT + 40);
		expect(shownAnswering()).toBe(true);
		expect(item()).toMatchObject({ tone: "warn", label: "LSP" });

		// A new server that is as silent is found out by the same rule, as a silence of its own.
		const before = session.silences;
		lsp.answers = () => SILENT;
		void session.documentSymbols(model as any).catch(() => {});
		await until(() => !session.answering);
		expect(session.silences).toBe(before + 1);
		expect(item().label).toBe("LSP not answering");
	});

	test("closing the folder, or the server stopping, is not a silence", async () => {
		await theBuildThatWasSeen();
		const model = await openSsl("/ws/Demo.ssl");
		void session.documentSymbols(model as any).catch(() => {});
		await until(() => !session.answering);
		pushed("lspState", { state: "failed", message: "starlims-lsp exited with code 2" });
		await until(() => snapshot(state).lsp.state === "failed");
		expect(shownAnswering()).toBe(true);
		expect(serverSilent()).toBe("");
		expect(item()).toMatchObject({ tone: "error", label: "LSP" });
		expect(sslOutlineEmpty(unread)).toBe("The language server has failed (starlims-lsp exited with code 2). Click “LSP” in the status bar to restart it. This file's outline comes from it.");
	});

	test("the graph's calls: asked and left unanswered, the view says so; an answer that comes late brings them", async () => {
		const withCallGraph = { ...handshake, capabilities: { ...handshake.capabilities, experimental: { ssl: { callGraph: 1 } } } };
		await serverRuns((request) => (request.method === "initialize" ? withCallGraph : SILENT));
		await session.waitReady();
		/** What the view says under its bar, made as the component makes it. */
		const says = (nodes: number | null, waiting: boolean) => (flush(), graphIdle({ workspace: true, lsp: snapshot(state).lsp.state, lspMessage: snapshot(state).lsp.message, answering: lspAnswering(), waiting, failed: "", nodes }));

		// The view reads the workspace's calls, as it does when it opens.
		let read: any = "not answered";
		void loadGraph(() => {}).then(
			(graph) => (read = graph),
			(e) => (read = e),
		);
		await until(() => asked("ssl/callGraph").length === 1);
		expect(says(null, true)).toBeNull();

		await until(() => !session.answering);
		expect(says(null, true)).toEqual({
			text: "The language server is not answering, so there are no calls to show: the graph is read from it.",
			hint: "Restart it here or from the status bar. If it is only busy, the calls appear when it answers.",
			restart: true,
		});
		// The read is not failed: it is still asked.
		expect(read).toBe("not answered");

		// The server answers at last: the calls are there, and nothing more is said.
		const at = { uri: "file:///ws/Demo.ssl", range: { start: { line: 0, character: 0 }, end: { line: 2, character: 9 } } };
		answer(asked("ssl/callGraph")[0]!.id!, {
			nodes: [
				{ id: "s", kind: "script", name: "Demo", location: at },
				{ id: "p", kind: "procedure", name: "RuleFor", container: at.uri, location: at },
			],
			edges: [],
		});
		await until(() => read !== "not answered");
		expect(read.nodes.map((n: { name: string; path: string }) => `${n.path}: ${n.name}`)).toEqual(["/ws/Demo.ssl: RuleFor"]);
		expect(session.answering).toBe(true);
		expect(says(read.nodes.length, false)).toBeNull();
	});

	test("a save that gives up says so to the session: the status bar turns with the notice, not seconds after it", async () => {
		// As shipped in proportion: a save waits less than the session does.
		Object.assign(answerWait, { ms: 2000 });
		Object.assign(formatOnSaveWait, { answering: 100, silent: 20 });
		await theBuildThatWasSeen();
		const path = "/ws/Demo.ssl";
		await openChanged(path);

		const first = await timed(save(path));
		expect(first.result).toBe(true);
		expect(first.ms).toBeGreaterThanOrEqual(100 - 20);
		expect(first.ms).toBeLessThan(1000);
		expect(files.written.length).toBe(1);
		// The notice and the status bar agree at once.
		expect(said(SAVE_NOTICE).length).toBe(1);
		expect(session.answering).toBe(false);
		expect(shownAnswering()).toBe(false);
		expect(item().label).toBe("LSP not answering");
		expect(sslOutlineEmpty(unread)).toBe(OUTLINE_SILENT);

		// The next save reads the same fact: the short wait, and nothing said again.
		typeInto(path, "/* more; */\n");
		flush();
		const second = await timed(save(path));
		expect(second.ms).toBeLessThan(100 - 20);
		expect(files.written.length).toBe(2);
		expect(said(SAVE_NOTICE).length).toBe(1);
	});

	test("a silence the session found first: the first save waits the short time only, and says it once", async () => {
		await theBuildThatWasSeen();
		const path = "/ws/Demo.ssl";
		await openChanged(path);
		// The Outline asked, and had no answer.
		void session.documentSymbols(documents.get(path)!.model as any).catch(() => {});
		await until(() => !session.answering);
		expect(said(SAVE_NOTICE)).toEqual([]);

		const first = await timed(save(path));
		expect(first.result).toBe(true);
		// Well short of a save's long wait (400 ms here).
		expect(first.ms).toBeLessThan(200);
		expect(files.written.length).toBe(1);
		const once = said(SAVE_NOTICE);
		expect(once.length).toBe(1);

		typeInto(path, "/* more; */\n");
		flush();
		expect((await timed(save(path))).result).toBe(true);
		expect(said(SAVE_NOTICE)).toEqual(once);
	});

	test("a server that answers the rest and is slow over one file's formatting is not called silent", async () => {
		Object.assign(answerWait, { ms: 2000 });
		Object.assign(formatOnSaveWait, { answering: 150, silent: 20 });
		// The outline and hovers are answered; the formatting is not.
		await serverRuns((request) => (request.method === "initialize" ? handshake : request.method === FORMAT ? SILENT : request.method === "textDocument/documentSymbol" ? [] : null));
		await session.waitReady();
		const path = "/ws/Demo.ssl";
		await openChanged(path);

		const saving = timed(save(path));
		await until(() => asked(FORMAT).length === 1);
		// While the save waits, something else is asked and answered.
		await session.request("textDocument/hover", {});
		const saved = await saving;
		expect(saved.result).toBe(true);
		expect(saved.ms).toBeGreaterThanOrEqual(150 - 20);
		expect(files.written.length).toBe(1);
		// The session does not say silent, so nothing else does: the notice is about this file.
		expect(session.answering).toBe(true);
		expect(shownAnswering()).toBe(true);
		expect(item().label).toBe("LSP");
		expect(said(SAVE_NOTICE)).toEqual([]);
		expect(said("Demo.ssl was saved without formatting: the language server took longer than 0.15 s over it.").length).toBe(1);

		// The next save gives the server the long wait again.
		typeInto(path, "/* more; */\n");
		flush();
		const next = await timed(save(path));
		expect(next.ms).toBeGreaterThanOrEqual(150 - 20);
	});

	test("a server that answers is never shown as not answering", async () => {
		await serverRuns((request) => (request.method === "initialize" ? handshake : request.method === "textDocument/documentSymbol" ? [symbol] : null));
		await session.waitReady();
		const model = await openSsl("/ws/Demo.ssl");
		const before = session.silences;
		expect((await session.documentSymbols(model as any)).map((s) => s.name)).toEqual(["Demo"]);
		// Its own notifications and requests come and go; nothing is asked for longer than the wait.
		serverSays("client/registerCapability", { registrations: [] }, 0);
		serverSays("textDocument/publishDiagnostics", { uri: "file:///ws/Demo.ssl", diagnostics: [] });
		await sleep(WAIT + 60);
		expect(session.answering).toBe(true);
		expect(session.silences).toBe(before);
		expect(shownAnswering()).toBe(true);
		expect(item()).toMatchObject({ tone: "warn", label: "LSP" });
		expect(serverSilent()).toBe("");
		expect(sslOutlineEmpty({ reading: "read", failure: "", count: 0, filter: "" })).toBe("This file has no regions, procedures or public variables yet.");
	});
});
