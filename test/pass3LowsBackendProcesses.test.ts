// The low findings of the pass 3 audit in the backend's processes and transport (the browser host, the language
// server's process and its frames, the agent's event stream, git) and in the History panel. Each test runs the
// code it names: a real host with real WebSocket clients, real child processes, a real git in a repository made
// for the test. The stand-ins (a language server, an opencode server) are started here, listen on 127.0.0.1 at a
// port the system gives, and are stopped by the test that started them. No model is asked anything.
// What is for Windows alone (Explorer's command line) is tested as far as the building of the line goes.
import { afterAll, beforeAll, describe, expect, mock, test } from "bun:test";
import { randomBytes } from "node:crypto";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createRoot, createSignal, flush, untrack } from "solid-js";
import { Agent } from "../src/bun/agent";
import { createFrameReader, frame, MAX_HEADER_BYTES, MAX_MESSAGE_BYTES } from "../src/bun/frames";
import { Git, unquoteGitPath } from "../src/bun/git";
import { LspProcess } from "../src/bun/lsp";
import { explorerSelectArgument, revealFileCommand } from "../src/bun/system";
import { agentEventSession, createLspRoutes, createOutbox, startWebHost } from "../src/bun/web";
import { createAsyncQuery } from "../src/view/asyncQuery";

const base = mkdtempSync(join(tmpdir(), "ssl-studio-p3l-proc-"));
afterAll(() => rmSync(base, { recursive: true, force: true }));
const fresh = (name: string) => {
	const dir = join(base, name);
	mkdirSync(dir, { recursive: true });
	return dir;
};
const posix = process.platform !== "win32";

async function until(what: () => boolean | Promise<boolean>, ms = 5000): Promise<boolean> {
	const end = Date.now() + ms;
	for (;;) {
		if (await what()) return true;
		if (Date.now() >= end) return false;
		await Bun.sleep(10);
	}
}

/** A program made of a script run by this same Bun, as a language server's path is: one file to start. */
function program(dir: string, name: string, js: string): string {
	const script = join(dir, `${name}.js`);
	writeFileSync(script, js);
	const path = join(dir, posix ? `${name}.sh` : `${name}.cmd`);
	if (posix) {
		writeFileSync(path, `#!/bin/sh\nexec "${process.execPath}" "${script}" "$@"\n`);
		chmodSync(path, 0o755);
	} else {
		writeFileSync(path, `@echo off\r\n"${process.execPath}" "${script}" %*\r\n`);
	}
	return path;
}

const alive = (pid: number) => {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
};

/** Sets variables of the process for as long as the work takes, and puts them back. */
async function withEnv<T>(vars: Record<string, string>, work: () => Promise<T>): Promise<T> {
	const before = Object.fromEntries(Object.keys(vars).map((name) => [name, process.env[name]]));
	Object.assign(process.env, vars);
	try {
		return await work();
	} finally {
		for (const [name, value] of Object.entries(before)) {
			if (value === undefined) delete process.env[name];
			else process.env[name] = value;
		}
	}
}

/** A browser host over a folder made for the test. */
function webHost(name: string) {
	const dir = fresh(name);
	const dist = join(dir, "dist");
	const folder = join(dir, "ws");
	mkdirSync(dist, { recursive: true });
	mkdirSync(folder, { recursive: true });
	writeFileSync(join(dist, "index.html"), "<!doctype html><html><head><title>SSL Studio</title></head><body></body></html>");
	writeFileSync(join(folder, "hello.ssl"), ":RETURN 1;\n");
	return { host: startWebHost({ port: 0, dist, folder, quit: () => {} }), folder };
}

type TabPush = { event: string; payload: any };

/** A browser tab as the host sees one: a WebSocket with the page's origin and the host's token. */
async function openTab(host: { server: { port?: number }; token: string }) {
	const port = host.server.port!;
	const ws = new WebSocket(`ws://127.0.0.1:${port}/backend?token=${encodeURIComponent(host.token)}`, { headers: { Origin: `http://127.0.0.1:${port}` } } as any);
	await new Promise<void>((done, failed) => {
		ws.addEventListener("open", () => done(), { once: true });
		ws.addEventListener("error", () => failed(new Error("the tab could not connect")), { once: true });
	});
	const waiting = new Map<number, (reply: any) => void>();
	const pushes: TabPush[] = [];
	ws.addEventListener("message", (event) => {
		const message = JSON.parse(String(event.data));
		if ("event" in message) pushes.push(message);
		else waiting.get(message.id)?.(message);
	});
	let next = 0;
	return {
		pushes,
		call: (method: string, ...args: unknown[]) =>
			new Promise<any>((done) => {
				const id = ++next;
				waiting.set(id, done);
				ws.send(JSON.stringify({ id, method, args }));
			}),
		/** What the language server said to this tab. */
		lsp: () => pushes.filter((p) => p.event === "lsp").map((p) => JSON.parse(p.payload)),
		/** The agent's events this tab was sent. */
		agent: () => pushes.filter((p) => p.event === "agent").map((p) => p.payload as { type: string; data: any }),
		close: () => ws.close(),
	};
}

// ---------------------------------------------------------------------------------------------------------------
// 1. The browser host: no reply is dropped while a large one is on its way
// ---------------------------------------------------------------------------------------------------------------

/** A socket as Bun's behaves: what it is given past its limit it drops, and says so only in what `send` returns. */
function socket(limit = 16) {
	return {
		readyState: 1,
		held: 0,
		sent: [] as string[],
		closedWith: undefined as [number | undefined, string | undefined] | undefined,
		throws: false,
		send(text: string): number {
			if (this.throws) throw new Error("socket is gone");
			if (this.held > limit) return 0;
			this.sent.push(text);
			return this.held > 0 ? -1 : text.length;
		},
		getBufferedAmount() {
			return this.held;
		},
		close(code?: number, reason?: string) {
			this.closedWith = [code, reason];
			this.readyState = 3;
		},
	};
}

/** One turn of the event loop: what the outbox put off until after the socket's `drain` call has run by then. */
const turn = () => new Promise<void>((done) => setImmediate(done));

describe("the browser host's outbox", () => {
	test("what the socket has no room for waits, and goes in order when it has drained", async () => {
		const ws = socket();
		const outbox = createOutbox(ws);
		outbox.send("picture");
		// The picture is on its way: far more is held back than the socket takes anything on top of.
		ws.held = 20 * 1024 * 1024;
		outbox.send("reply 1");
		outbox.send("reply 2");
		expect(ws.sent).toEqual(["picture"]);
		expect(outbox.waiting).toBe(2);
		// Some of it has gone, not enough: nothing is handed over to be dropped.
		ws.held = 5 * 1024 * 1024;
		outbox.drained();
		await turn();
		expect(ws.sent).toEqual(["picture"]);
		// A reply that comes now goes after the two that wait, not before them.
		outbox.send("reply 3");
		ws.held = 0;
		outbox.drained();
		await turn();
		expect(ws.sent).toEqual(["picture", "reply 1", "reply 2", "reply 3"]);
		expect(outbox.waiting).toBe(0);
	});

	test("what waits is never sent from inside the socket's drain call, and goes on the next turn", async () => {
		const ws = socket();
		const outbox = createOutbox(ws);
		outbox.send("picture 1");
		ws.held = 20 * 1024 * 1024;
		outbox.send("picture 2");
		outbox.send("reply");
		ws.held = 0;
		// As Bun calls it: from inside its own drain. A large message given to the socket in there is held for good.
		outbox.drained();
		expect(ws.sent).toEqual(["picture 1"]);
		// A microtask still runs inside that call.
		await Promise.resolve();
		expect(ws.sent).toEqual(["picture 1"]);
		// A reply that comes before the turn is over keeps its place behind what waits.
		outbox.send("reply 2");
		// A second drain before the turn is over sends nothing twice.
		outbox.drained();
		await turn();
		expect(ws.sent).toEqual(["picture 1", "picture 2", "reply", "reply 2"]);
		expect(outbox.waiting).toBe(0);
	});

	test("what waits goes after a while when the socket never says that it drained", async () => {
		const ws = socket();
		const outbox = createOutbox(ws, undefined, 20);
		outbox.send("picture");
		ws.held = 20 * 1024 * 1024;
		outbox.send("reply 1");
		outbox.send("reply 2");
		await Bun.sleep(60);
		// No room yet: it goes on waiting, and is looked at again.
		expect(ws.sent).toEqual(["picture"]);
		ws.held = 0;
		expect(await until(() => ws.sent.length === 3, 2000)).toBe(true);
		expect(ws.sent).toEqual(["picture", "reply 1", "reply 2"]);
		expect(outbox.waiting).toBe(0);

		// A tab that closed is not looked at again.
		const gone = socket();
		const other = createOutbox(gone, undefined, 20);
		gone.held = 20 * 1024 * 1024;
		other.send("kept");
		other.closed();
		gone.held = 0;
		await Bun.sleep(60);
		expect(gone.sent).toEqual([]);
	});

	test("a message the socket says it dropped is kept and sent again", async () => {
		const ws = socket();
		const outbox = createOutbox(ws);
		const real = ws.send.bind(ws);
		let drops = 1;
		ws.send = (text: string) => (drops-- > 0 ? 0 : real(text));
		outbox.send("reply");
		expect(ws.sent).toEqual([]);
		expect(outbox.waiting).toBe(1);
		outbox.drained();
		await turn();
		expect(ws.sent).toEqual(["reply"]);
	});

	test("a tab that is too far behind, or cannot be sent to, is closed: its calls fail, they do not wait", async () => {
		const behind = socket();
		const outbox = createOutbox(behind, 10);
		behind.held = 20 * 1024 * 1024;
		outbox.send("123456");
		expect(behind.closedWith).toBeUndefined();
		outbox.send("7890123");
		expect(behind.closedWith?.[0]).toBe(1013);
		expect(outbox.waiting).toBe(0);

		const gone = socket();
		const other = createOutbox(gone);
		gone.throws = true;
		other.send("reply");
		expect(gone.closedWith?.[0]).toBe(1013);

		// A socket that has closed is sent nothing, and nothing is kept for it.
		const closed = socket();
		const third = createOutbox(closed);
		closed.held = 20 * 1024 * 1024;
		third.send("kept");
		third.closed();
		closed.held = 0;
		third.drained();
		await turn();
		expect(closed.sent).toEqual([]);
		expect(third.waiting).toBe(0);
	});

	test("a real tab gets every reply while pictures of 19 MB are on their way", async () => {
		const { host, folder } = webHost("outbox-live");
		try {
			await host.backend.ready;
			const picture = join(folder, "big.png");
			writeFileSync(picture, randomBytes(19 * 1024 * 1024));
			const tab = await openTab(host);
			// Three large replies at once, and small calls all the while: before, the socket dropped what came while it held
			// more than 16 MB back, a second picture or a small reply, and those calls never settled.
			const calls: Promise<any>[] = [tab.call("image", picture), tab.call("image", picture), tab.call("image", picture)];
			const end = Date.now() + 400;
			while (Date.now() < end) {
				calls.push(tab.call("workspace"));
				await Bun.sleep(1);
			}
			const replies = await Promise.race([Promise.all(calls), Bun.sleep(20_000).then(() => null)]);
			expect(replies).not.toBeNull();
			for (const reply of replies!.slice(0, 3)) expect(reply.result.base64.length).toBeGreaterThan(25_000_000);
			expect(replies!.slice(3).every((reply) => typeof reply.result?.root === "string")).toBe(true);
			tab.close();
		} finally {
			host.stop();
		}
	}, 40_000);

	test("a real tab that asks for three pictures and then only waits gets all three", async () => {
		const { host, folder } = webHost("outbox-waits");
		try {
			await host.backend.ready;
			const picture = join(folder, "big.png");
			writeFileSync(picture, randomBytes(4 * 1024 * 1024));
			const tab = await openTab(host);
			// As a Markdown preview with three pictures asks: all at once, and then nothing more from the tab. Each call a
			// tab makes stirs its socket, so a test that keeps calling (the one above) cannot see a socket that has stopped
			// sending: the second picture, given to the socket from inside its drain call, stayed there, and the third
			// behind it, until the tab's next call.
			const calls = [tab.call("image", picture), tab.call("image", picture), tab.call("image", picture), tab.call("workspace")];
			const replies = await Promise.race([Promise.all(calls), Bun.sleep(15_000).then(() => null)]);
			expect(replies).not.toBeNull();
			for (const reply of replies!.slice(0, 3)) expect(reply.result.base64.length).toBeGreaterThan(5_000_000);
			expect(typeof replies![3].result?.root).toBe("string");
			tab.close();
		} finally {
			host.stop();
		}
	}, 40_000);
});

// ---------------------------------------------------------------------------------------------------------------
// 2. The browser host with two tabs: each is sent what is its own
// ---------------------------------------------------------------------------------------------------------------

/** A stand-in language server: answers a request with what it was asked, says a note to all, and counts the answers it is given. */
const FAKE_LSP = `
if (process.argv.includes("--version")) { console.log("starlims-lsp version 0.31.0"); process.exit(0); }
const say = (m) => { const body = JSON.stringify({ jsonrpc: "2.0", ...m }); process.stdout.write("Content-Length: " + Buffer.byteLength(body) + "\\r\\n\\r\\n" + body); };
let buffer = Buffer.alloc(0);
let answers = 0;
process.stdin.on("data", (chunk) => {
	buffer = Buffer.concat([buffer, chunk]);
	for (;;) {
		const end = buffer.indexOf("\\r\\n\\r\\n");
		if (end < 0) return;
		const length = Number(/Content-Length: (\\d+)/i.exec(buffer.subarray(0, end).toString())[1]);
		if (buffer.length < end + 4 + length) return;
		const m = JSON.parse(buffer.subarray(end + 4, end + 4 + length).toString());
		buffer = buffer.subarray(end + 4 + length);
		if (m.method === "test/ask") say({ id: "cfg-1", method: "workspace/configuration", params: { items: [] } });
		else if (m.method === "test/answers") say({ id: m.id, result: { answers } });
		else if (m.method && m.id !== undefined) { say({ id: m.id, result: { echo: m.params } }); say({ method: "test/note", params: m.params }); }
		else if (m.id !== undefined) answers++;
	}
});
process.stdin.on("end", () => process.exit(0));
`;

describe("the browser host with two tabs", () => {
	test("a request goes to the server under the host's number, and its answer back to the tab that asked, under the tab's", () => {
		const routes = createLspRoutes<string>();
		const fromA = JSON.parse(routes.fromTab("A", JSON.stringify({ jsonrpc: "2.0", id: 1, method: "textDocument/hover", params: { of: "A" } }))!);
		const fromB = JSON.parse(routes.fromTab("B", JSON.stringify({ jsonrpc: "2.0", id: 1, method: "textDocument/hover", params: { of: "B" } }))!);
		// Both tabs call their first request 1: the server is given two different numbers, and everything else as it was.
		expect(fromA.id).not.toBe(fromB.id);
		expect({ ...fromA, id: 1 }).toEqual({ jsonrpc: "2.0", id: 1, method: "textDocument/hover", params: { of: "A" } });

		const toB = routes.fromServer(JSON.stringify({ jsonrpc: "2.0", id: fromB.id, result: "for B" }))!;
		expect(toB.tab).toBe("B");
		expect(JSON.parse(toB.text)).toEqual({ jsonrpc: "2.0", id: 1, result: "for B" });
		const toA = routes.fromServer(JSON.stringify({ jsonrpc: "2.0", id: fromA.id, error: { code: -32603, message: "no" } }))!;
		expect(toA.tab).toBe("A");
		expect(JSON.parse(toA.text)).toEqual({ jsonrpc: "2.0", id: 1, error: { code: -32603, message: "no" } });
		// An answer is given once: the same number again is nobody's.
		expect(routes.fromServer(JSON.stringify({ jsonrpc: "2.0", id: fromA.id, result: "again" }))).toBeNull();
	});

	test("what the server says unasked is for every tab; what it asks is answered once", () => {
		const routes = createLspRoutes<string>();
		const note = JSON.stringify({ jsonrpc: "2.0", method: "textDocument/publishDiagnostics", params: { uri: "file:///ws/a.ssl", diagnostics: [] } });
		expect(routes.fromServer(note)).toEqual({ text: note });
		// A tab's own notes go to the server as they are.
		const opened = JSON.stringify({ jsonrpc: "2.0", method: "textDocument/didOpen", params: {} });
		expect(routes.fromTab("A", opened)).toBe(opened);

		const asks = JSON.stringify({ jsonrpc: "2.0", id: 0, method: "workspace/configuration", params: { items: [] } });
		expect(routes.fromServer(asks)).toEqual({ text: asks });
		const answer = JSON.stringify({ jsonrpc: "2.0", id: 0, result: [null] });
		expect(routes.fromTab("A", answer)).toBe(answer);
		// The second tab's answer to the same question is not sent on.
		expect(routes.fromTab("B", answer)).toBeNull();
		// Neither is an answer to something the server never asked.
		expect(routes.fromTab("B", JSON.stringify({ jsonrpc: "2.0", id: 99, result: null }))).toBeNull();
	});

	test("a tab that closed is owed nothing, and a server that started anew answers nothing asked before", () => {
		const routes = createLspRoutes<string>();
		const fromA = JSON.parse(routes.fromTab("A", JSON.stringify({ id: 7, method: "x" }))!);
		const fromB = JSON.parse(routes.fromTab("B", JSON.stringify({ id: 7, method: "x" }))!);
		routes.forget("A");
		// A's answer is not handed to B, whose own request has the same number.
		expect(routes.fromServer(JSON.stringify({ id: fromA.id, result: 1 }))).toBeNull();
		expect(routes.fromServer(JSON.stringify({ id: fromB.id, result: 2 }))!.tab).toBe("B");

		const pending = JSON.parse(routes.fromTab("B", JSON.stringify({ id: 8, method: "x" }))!);
		routes.fromServer(JSON.stringify({ id: 5, method: "workspace/configuration" }));
		routes.reset();
		expect(routes.fromServer(JSON.stringify({ id: pending.id, result: 3 }))).toBeNull();
		expect(routes.fromTab("B", JSON.stringify({ id: 5, result: null }))).toBeNull();
		// Text that is not a message is passed as it is, to the server and to every tab.
		expect(routes.fromTab("A", "not json")).toBe("not json");
		expect(routes.fromServer("not json")).toEqual({ text: "not json" });
	});

	test("two real tabs on one language server: each gets its own answer, both get the notes", async () => {
		const lsp = program(fresh("two-tabs-lsp"), "fake-lsp", FAKE_LSP);
		await withEnv({ STARLIMS_LSP: lsp }, async () => {
			const { host } = webHost("two-tabs");
			try {
				await host.backend.ready;
				const a = await openTab(host);
				const b = await openTab(host);
				expect(await until(async () => (await a.call("lspState")).result?.state === "running")).toBe(true);

				// Each tab's first request is its number 1.
				await Promise.all([
					a.call("lspSend", JSON.stringify({ jsonrpc: "2.0", id: 1, method: "test/echo", params: "from A" })),
					b.call("lspSend", JSON.stringify({ jsonrpc: "2.0", id: 1, method: "test/echo", params: "from B" })),
				]);
				const answers = (tab: typeof a) => tab.lsp().filter((m) => m.id !== undefined && !m.method);
				const notes = (tab: typeof a) => tab.lsp().filter((m) => m.method === "test/note").map((m) => m.params).sort();
				expect(await until(() => answers(a).length >= 1 && answers(b).length >= 1 && notes(a).length >= 2 && notes(b).length >= 2)).toBe(true);
				await Bun.sleep(50);
				expect(answers(a)).toEqual([{ jsonrpc: "2.0", id: 1, result: { echo: "from A" } }]);
				expect(answers(b)).toEqual([{ jsonrpc: "2.0", id: 1, result: { echo: "from B" } }]);
				expect(notes(a)).toEqual(["from A", "from B"]);
				expect(notes(b)).toEqual(["from A", "from B"]);

				// The server asks something of its clients: both tabs hear it, both answer, one answer reaches the server.
				await a.call("lspSend", JSON.stringify({ jsonrpc: "2.0", method: "test/ask" }));
				const asked = (tab: typeof a) => tab.lsp().some((m) => m.id === "cfg-1" && m.method === "workspace/configuration");
				expect(await until(() => asked(a) && asked(b))).toBe(true);
				const answer = JSON.stringify({ jsonrpc: "2.0", id: "cfg-1", result: [null] });
				await a.call("lspSend", answer);
				await b.call("lspSend", answer);
				await a.call("lspSend", JSON.stringify({ jsonrpc: "2.0", id: 2, method: "test/answers" }));
				expect(await until(() => answers(a).some((m) => m.id === 2))).toBe(true);
				expect(answers(a).find((m) => m.id === 2).result).toEqual({ answers: 1 });
				expect(answers(b).some((m) => m.id === 2)).toBe(false);
				a.close();
				b.close();
			} finally {
				host.stop();
			}
		});
	}, 20_000);

	test("the session an agent's event is about", () => {
		expect(agentEventSession({ type: "session.text.delta", data: { sessionID: "ses_1", delta: "x" } })).toBe("ses_1");
		expect(agentEventSession({ type: "form.created", data: { form: { id: "f", sessionID: "ses_2" } } })).toBe("ses_2");
		expect(agentEventSession({ type: "status", data: { state: "ready" } })).toBeUndefined();
		expect(agentEventSession({ type: "status", data: null })).toBeUndefined();
	});

	test("two real tabs on one opencode: a turn's events go to the tab that asked, opencode's state to both", async () => {
		const fake = JSON.stringify(["bun", join(import.meta.dir, "fake-opencode.ts")]);
		await withEnv({ SSL_STUDIO_OPENCODE: fake, FAKE_VERSION: "2.2.5", FAKE_MODE: "", FAKE_REPLY: "An answer to {prompt}, long enough to come in parts." }, async () => {
			const { host } = webHost("two-tabs-agent");
			try {
				await host.backend.ready;
				const a = await openTab(host);
				const b = await openTab(host);
				// Both ask at once: two sessions on the one opencode.
				const [fromA, fromB] = await Promise.all([a.call("agent", "ask", [{ text: "the question of A", keep: true }]), b.call("agent", "ask", [{ text: "the question of B", keep: true }])]);
				expect(fromA.error).toBeUndefined();
				expect(fromA.result.outcome).toBe("succeeded");
				expect(fromB.result.outcome).toBe("succeeded");
				expect(fromA.result.sessionID).not.toBe(fromB.result.sessionID);
				await Bun.sleep(50);
				const sessionsOf = (tab: typeof a) => [...new Set(tab.agent().map((event) => agentEventSession(event)).filter(Boolean))];
				const textOf = (tab: typeof a) =>
					tab
						.agent()
						.filter((event) => event.type === "session.text.delta")
						.map((event) => event.data.delta)
						.join("");
				expect(sessionsOf(a)).toEqual([fromA.result.sessionID]);
				expect(sessionsOf(b)).toEqual([fromB.result.sessionID]);
				expect(textOf(a)).toBe(fromA.result.text);
				expect(textOf(b)).toBe(fromB.result.text);
				expect(a.agent().some((event) => event.type === "session")).toBe(true);
				// What opencode itself is doing is told to every tab.
				for (const tab of [a, b]) expect(tab.agent().some((event) => event.type === "status" && event.data.state === "ready")).toBe(true);

				// A reloaded tab has a new connection: asking on its kept session makes the session's events its own again.
				a.close();
				const again = await openTab(host);
				const before = b.agent().length;
				const more = await again.call("agent", "ask", [{ text: "one more", keep: true, sessionID: fromA.result.sessionID }]);
				expect(more.result.outcome).toBe("succeeded");
				await Bun.sleep(50);
				expect(textOf(again)).toBe(more.result.text);
				expect(b.agent().slice(before).filter((event) => agentEventSession(event))).toEqual([]);
				again.close();
				b.close();
			} finally {
				host.stop();
			}
		});
	}, 30_000);
});

// ---------------------------------------------------------------------------------------------------------------
// 3. The frame reader finds the next frame after bytes that are not one
// ---------------------------------------------------------------------------------------------------------------

describe("the LSP frame reader after a bad header", () => {
	const enc = new TextEncoder();
	const message = (id: number) => frame(JSON.stringify({ id }));
	const read = (chunks: (string | Uint8Array)[]) => {
		const got: string[] = [];
		const feed = createFrameReader((body) => got.push(body));
		for (const chunk of chunks) feed(typeof chunk === "string" ? enc.encode(chunk) : chunk);
		return got;
	};
	const ids = (bodies: string[]) => bodies.map((body) => JSON.parse(body).id);
	const bytewise = (text: string) => [...enc.encode(text)].map((byte) => new Uint8Array([byte]));
	const pieces = (text: string, size: number) => {
		const bytes = enc.encode(text);
		const out: Uint8Array[] = [];
		for (let at = 0; at < bytes.length; at += size) out.push(bytes.subarray(at, at + size));
		return out;
	};

	test("a bad header between two good frames loses its own message and no other", () => {
		const stream = message(1) + 'Content-Length: abc\r\n\r\n{"id":0}' + message(2) + message(3);
		expect(ids(read([stream]))).toEqual([1, 2, 3]);
		// However the bytes arrive: one at a time, or in pieces that cut the next header's name in two.
		expect(ids(read(bytewise(stream)))).toEqual([1, 2, 3]);
		for (const size of [3, 7, 13, 16, 17]) expect(ids(read(pieces(stream, size)))).toEqual([1, 2, 3]);
	});

	test("a line that is not a frame, before the first one, costs no message", () => {
		expect(ids(read(["fake-lsp: listening\n" + message(1) + message(2) + message(3)]))).toEqual([1, 2, 3]);
		expect(ids(read(bytewise("fake-lsp: listening\n" + message(1) + message(2))))).toEqual([1, 2]);
		// A header with a space before its colon is not one; the frame after it is.
		expect(ids(read(['Content-Length : 8\r\n\r\n{"id":0}' + message(2)]))).toEqual([2]);
	});

	test("a declared length too large to hold is not waited for: the frames after it are read", () => {
		const huge = `Content-Length: ${MAX_MESSAGE_BYTES + 1}\r\n\r\n{"big":true}`;
		expect(ids(read([huge + message(1) + message(2)]))).toEqual([1, 2]);
		expect(ids(read(["Content-Length: 999999999999999999999\r\n\r\n" + message(1)]))).toEqual([1]);
		expect(ids(read(pieces(message(1) + huge + message(2) + message(3), 11)))).toEqual([1, 2, 3]);
	});

	test("a good header split across chunks is one header; another header's name is not taken for the length", () => {
		expect(read(["Content-Le", "ngth: 8\r", '\n\r\n{"a":1} '])).toEqual(['{"a":1} ']);
		// X-Content-Length is not Content-Length, alone or after a bad frame's body.
		expect(ids(read(["X-Content-Length: 5\r\n\r\n" + message(1)]))).toEqual([1]);
		expect(ids(read(['Content-Length: abc\r\n\r\n{"id":0}X-Content-Length: 4\r\n\r\n' + message(2) + message(3)]))).toEqual([2, 3]);
		expect(ids(read(bytewise("X-Content-Length: 5\r\n\r\n" + message(1) + message(2))))).toEqual([1, 2]);
	});

	test("megabytes that are no frame are neither kept nor looped over, and the frame after them is read", () => {
		const noise = "x".repeat(1024 * 1024);
		const started = Date.now();
		// With no end of headers in it, with one after more than headers may be, and with many.
		expect(ids(read([noise, noise, noise, message(1)]))).toEqual([1]);
		expect(ids(read([noise + "\r\n\r\n" + message(1) + message(2)]))).toEqual([1, 2]);
		expect(ids(read(["junk\r\n\r\n".repeat(50_000) + message(1)]))).toEqual([1]);
		expect(ids(read(["Content-Length: x\r\n\r\n".repeat(20_000) + message(1)]))).toEqual([1]);
		// Headers longer than headers may be, ending in a frame's own: the frame is read.
		expect(ids(read(["X-Junk: " + "a".repeat(MAX_HEADER_BYTES + 100) + "\r\n\r\n" + message(1)]))).toEqual([1]);
		expect(ids(read(["a".repeat(MAX_HEADER_BYTES + 100) + message(1) + message(2)]))).toEqual([1, 2]);
		expect(Date.now() - started).toBeLessThan(5000);
	});
});

// ---------------------------------------------------------------------------------------------------------------
// 4. A language server that ignores the request to stop
// ---------------------------------------------------------------------------------------------------------------

/**
 * Says its process id in a frame, then ignores SIGTERM and the end of its input (or, asked to be "polite", does
 * not). It ends by itself after half a minute, so that a test that fails cannot leave it behind for good.
 */
const STUBBORN = `
if (process.argv.includes("--polite")) process.stdin.on("end", () => process.exit(0)).resume();
else process.on("SIGTERM", () => {});
const body = JSON.stringify({ pid: process.pid });
process.stdout.write("Content-Length: " + Buffer.byteLength(body) + "\\r\\n\\r\\n" + body);
setInterval(() => {}, 1000);
setTimeout(() => process.exit(0), 30_000);
`;

describe.skipIf(!posix)("LspProcess.stop()", () => {
	// Every server these tests start, from the moment it is started: none outlives them, however a test ends.
	const spawned: number[] = [];
	const track = (lsp: LspProcess) => {
		const pid = (lsp as any).proc?.pid;
		if (typeof pid === "number") spawned.push(pid);
	};
	afterAll(() => {
		for (const pid of spawned) if (alive(pid)) process.kill(pid, "SIGKILL");
	});
	const started = async (path: string, graceMs: number) => {
		let pid = 0;
		const lsp = new LspProcess(
			path,
			(body) => (pid = JSON.parse(body).pid),
			() => {},
			graceMs,
		);
		lsp.start();
		track(lsp);
		expect(await until(() => pid > 0)).toBe(true);
		return { lsp, pid };
	};

	test("a server that ignores SIGTERM is killed after the grace period, also after restarts", async () => {
		const path = program(fresh("stubborn-lsp"), "stubborn", STUBBORN);
		{
			const { lsp, pid } = await started(path, 200);
			lsp.stop();
			await Bun.sleep(60);
			// It was asked, and is still there: this is the server that lived on.
			expect(alive(pid)).toBe(true);
			expect(await until(() => !alive(pid), 4000)).toBe(true);

			// A restart stops one server and starts the next: the one it stopped goes the same way, the next one runs.
			let latest = 0;
			const again = new LspProcess(
				path,
				(body) => (latest = JSON.parse(body).pid),
				() => {},
				200,
			);
			again.start();
			track(again);
			expect(await until(() => latest > 0)).toBe(true);
			const first = latest;
			again.restart();
			track(again);
			expect(await until(() => latest !== first)).toBe(true);
			const second = latest;
			expect(await until(() => !alive(first), 4000)).toBe(true);
			expect(alive(second)).toBe(true);
			again.stop();
			expect(await until(() => !alive(second), 4000)).toBe(true);
		}
	}, 20_000);

	test("a server that stops when asked is signalled once, and never again after it has gone", async () => {
		const path = program(fresh("polite-lsp"), "polite", STUBBORN.replace('process.argv.includes("--polite")', "true"));
		const { lsp, pid } = await started(path, 150);
		const proc = (lsp as any).proc as { kill: (signal?: string) => void; exited: Promise<number> };
		const signals: (string | undefined)[] = [];
		const kill = proc.kill.bind(proc);
		proc.kill = (signal?: string) => {
			signals.push(signal);
			return kill(signal);
		};
		lsp.stop();
		await proc.exited;
		// Well past the grace period: the process id may be another's by now, and is sent nothing.
		await Bun.sleep(400);
		expect(signals).toEqual([undefined]);
		expect(alive(pid)).toBe(false);
	}, 20_000);

	test("the backend exiting inside the grace period takes the server with it", async () => {
		const dir = fresh("exit-lsp");
		const path = program(dir, "stubborn", STUBBORN);
		// Two ways a backend goes: it stops its server and exits at once (the browser host), or it stops it from its
		// own "exit" handler (the app), where no timer will ever run.
		const ways = {
			"stop, then exit": "lsp.stop();\n\tprocess.exit(0);",
			"stop in an exit handler": 'process.on("exit", () => lsp.stop());\n\tprocess.exit(0);',
		};
		for (const [way, ending] of Object.entries(ways)) {
			const pidFile = join(dir, `pid-${way.length}.txt`);
			const backend = join(dir, `backend-${way.length}.ts`);
			writeFileSync(
				backend,
				`import { writeFileSync } from "node:fs";
import { LspProcess } from ${JSON.stringify(resolve(import.meta.dir, "../src/bun/lsp.ts"))};
const lsp = new LspProcess(${JSON.stringify(path)}, (body) => {
	writeFileSync(${JSON.stringify(pidFile)}, String(JSON.parse(body).pid));
	${ending}
}, () => {}, 60_000);
lsp.start();
setTimeout(() => process.exit(3), 10_000);
`,
			);
			const ran = Bun.spawnSync([process.execPath, backend], { stdout: "ignore", stderr: "pipe" });
			expect(`${way}: exit ${ran.exitCode}`).toBe(`${way}: exit 0`);
			const pid = Number(readFileSync(pidFile, "utf8"));
			expect(pid).toBeGreaterThan(0);
			spawned.push(pid);
			expect(`${way}: ${(await until(() => !alive(pid), 3000)) ? "gone" : "still there"}`).toBe(`${way}: gone`);
		}
	}, 30_000);
});

// ---------------------------------------------------------------------------------------------------------------
// 5. An agent turn that ends while the event stream is down
// ---------------------------------------------------------------------------------------------------------------

/**
 * A stand-in for opencode's HTTP API, with the shapes recorded in docs/spikes/opencode-api.md: a turn's end is an
 * event on the stream, which does not replay, and an `idle` message with the outcome at the end of the session's
 * messages. Its stream can be dropped.
 */
function fakeOpencode(turn: { ms: number; outcome?: "succeeded" | "failed" }) {
	const enc = new TextEncoder();
	const streams = new Set<ReadableStreamDefaultController<Uint8Array>>();
	const sessions = new Map<string, any[]>();
	let n = 0;
	let subscriptions = 0;
	const send = (type: string, data: unknown) => {
		const bytes = enc.encode(`data: ${JSON.stringify({ type, data })}\n\n`);
		for (const stream of streams) stream.enqueue(bytes);
	};
	const server = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		idleTimeout: 0,
		async fetch(req) {
			const path = new URL(req.url).pathname;
			if (path === "/api/info") return Response.json({ data: { version: "2.2.5" } });
			if (path === "/api/model") return Response.json({ data: [{ providerID: "ollama", modelID: "qwen3:14b", name: "Qwen3", capabilities: { tools: true }, variants: [] }] });
			if (path === "/api/event") {
				subscriptions++;
				let mine: ReadableStreamDefaultController<Uint8Array>;
				return new Response(
					new ReadableStream<Uint8Array>({
						start(controller) {
							mine = controller;
							streams.add(controller);
							controller.enqueue(enc.encode('data: {"type":"server.connected","data":{}}\n\n'));
						},
						cancel() {
							streams.delete(mine);
						},
					}),
					{ headers: { "content-type": "text/event-stream" } },
				);
			}
			if (path === "/api/session" && req.method === "POST") {
				const id = `ses_${++n}`;
				sessions.set(id, []);
				return Response.json({ data: { id } });
			}
			const match = /^\/api\/session\/([^/]+)(\/.*)?$/.exec(path);
			const messages = match && sessions.get(match[1]!);
			if (!match || !messages) return new Response("not found", { status: 404 });
			const sessionID = match[1]!;
			if (match[2] === "/message") return Response.json({ data: [...messages].reverse() });
			if (match[2] === "/prompt") {
				const { text } = (await req.json()) as { text: string };
				setTimeout(() => {
					send("session.execution.started", { sessionID });
					messages.push({ id: `msg_${++n}`, type: "user", text });
					if (turn.outcome === "failed") {
						messages.push({ id: `msg_${++n}`, type: "idle", outcome: "failed", error: { message: "The provider did not answer" } });
						send("session.execution.failed", { sessionID, error: { message: "The provider did not answer" } });
						return;
					}
					messages.push({ id: `msg_${++n}`, type: "assistant", content: [{ type: "text", text: `answer to: ${text}` }], tokens: { input: 3, output: 2 }, cost: 0 }, { id: `msg_${++n}`, type: "idle", outcome: "succeeded" });
					send("session.execution.succeeded", { sessionID });
				}, turn.ms);
				return Response.json({ data: { id: `inb_${++n}` } });
			}
			if (match[2] === "/interrupt") return Response.json({ interrupted: false });
			if (!match[2] && req.method === "DELETE") return new Response(null, { status: 204 });
			return new Response("not found", { status: 404 });
		},
	});
	return {
		url: `http://127.0.0.1:${server.port}`,
		/** Ends every event stream, as a dropped connection does. */
		drop() {
			for (const stream of streams) stream.close();
			streams.clear();
		},
		subscriptions: () => subscriptions,
		stop: () => server.stop(true),
	};
}

describe("an agent turn while the event stream is down", () => {
	const root = fresh("agent-gap-ws");
	const asked = async (turn: { ms: number; outcome?: "succeeded" | "failed" }, timeoutMs: number) => {
		const fake = fakeOpencode(turn);
		const agent = new Agent(
			() => {},
			() => root,
		);
		try {
			agent.configure({ serverUrl: fake.url, reconnectDelayMs: 400 });
			await agent.call("start", []);
			fake.drop();
			// The adapter has seen the stream end, and comes back for it in 400 ms. The turn is asked for now.
			await Bun.sleep(100);
			const from = Date.now();
			const reply = await agent.ask({ text: "during the gap", timeoutMs });
			return { reply, took: Date.now() - from, subscriptions: fake.subscriptions() };
		} finally {
			agent.dispose();
			fake.stop();
		}
	};

	test("a turn that ended in the gap is seen as ended when the stream is back, not when its time runs out", async () => {
		const { reply, took, subscriptions } = await asked({ ms: 40 }, 3500);
		// Before: "timeout" after the whole 3.5 s (fifteen minutes in the app), with the answer long since there.
		expect(reply.outcome).toBe("succeeded");
		expect(reply.text).toBe("answer to: during the gap");
		expect(reply.tokens).toEqual({ input: 3, output: 2 });
		expect(took).toBeLessThan(2500);
		expect(subscriptions).toBe(2);
	}, 15_000);

	test("a turn that failed in the gap says how it failed", async () => {
		const { reply, took } = await asked({ ms: 40, outcome: "failed" }, 3500);
		expect(reply.outcome).toBe("failed");
		expect(reply.error).toMatch(/The provider did not answer/);
		expect(took).toBeLessThan(2500);
	}, 15_000);

	test("a turn still running when the stream is back ends by its event, as ever", async () => {
		const { reply, took } = await asked({ ms: 900 }, 3500);
		expect(reply.outcome).toBe("succeeded");
		expect(reply.text).toBe("answer to: during the gap");
		// Not before the turn was over: asking the server did not end it early.
		expect(took).toBeGreaterThanOrEqual(850);
	}, 15_000);
});

// ---------------------------------------------------------------------------------------------------------------
// 6. Reveal in Explorer (Windows): the building of the line only
// ---------------------------------------------------------------------------------------------------------------

describe("the word Explorer is given to select a file", () => {
	test("the path is in quotes whatever is in it: a comma, a space, both or neither", () => {
		expect(explorerSelectArgument("C:\\ws\\plain.ssl")).toBe('/select,"C:\\ws\\plain.ssl"');
		expect(explorerSelectArgument("C:\\ws\\with space.ssl")).toBe('/select,"C:\\ws\\with space.ssl"');
		// The one that failed: a comma and no space was given bare, and Explorer cut the path at the comma.
		expect(explorerSelectArgument("C:\\ws\\a,b.ssl")).toBe('/select,"C:\\ws\\a,b.ssl"');
		expect(explorerSelectArgument("C:\\my ws\\a, b.ssl")).toBe('/select,"C:\\my ws\\a, b.ssl"');
		expect(explorerSelectArgument("\\\\server\\share\\a,b.ssl")).toBe('/select,"\\\\server\\share\\a,b.ssl"');
	});

	test("no backslash stands before the closing quote, a quote is dropped, a forward slash is a backslash", () => {
		expect(explorerSelectArgument("C:\\ws\\folder\\")).toBe('/select,"C:\\ws\\folder"');
		expect(explorerSelectArgument("C:\\ws\\a,b\\\\")).toBe('/select,"C:\\ws\\a,b"');
		// A drive's root is the one path that ends in its backslash: it needs no quotes and gets none.
		expect(explorerSelectArgument("C:\\")).toBe("/select,C:\\");
		expect(explorerSelectArgument('C:\\ws\\"odd",name.ssl')).toBe('/select,"C:\\ws\\odd,name.ssl"');
		expect(explorerSelectArgument("C:/ws/a,b.ssl")).toBe('/select,"C:\\ws\\a,b.ssl"');
	});

	test("the command is Explorer and that one word; on macOS it is as it was", () => {
		const command = revealFileCommand("win32", "C:\\ws\\a,b c.ssl");
		expect(command).toEqual(["explorer.exe", '/select,"C:\\ws\\a,b c.ssl"']);
		// Passed as written, the words with a space between them are the line Explorer reads.
		expect(command.join(" ")).toBe('explorer.exe /select,"C:\\ws\\a,b c.ssl"');
		expect(revealFileCommand("darwin", "/ws/a,b c.ssl")).toEqual(["open", "-R", "/ws/a,b c.ssl"]);
	});
});

// ---------------------------------------------------------------------------------------------------------------
// 7 and 8. git: a stash from a sub-folder, and names as they are on disk
// ---------------------------------------------------------------------------------------------------------------

const hasGit = Bun.spawnSync(["git", "--version"]).exitCode === 0;
// The user's own settings are kept out by an empty file of settings, and the commits carry the test's own name.
const gitSettings = join(fresh("gitconfig"), "config");
writeFileSync(gitSettings, "");
const identity = { GIT_AUTHOR_NAME: "Test", GIT_AUTHOR_EMAIL: "test@example.test", GIT_COMMITTER_NAME: "Test", GIT_COMMITTER_EMAIL: "test@example.test", GIT_CONFIG_GLOBAL: gitSettings, GIT_CONFIG_NOSYSTEM: "1" };

function repository(name: string) {
	const top = fresh(name);
	const git = (...args: string[]) => {
		const ran = Bun.spawnSync(["git", "-C", top, ...args], { env: { ...process.env, ...identity } });
		if (ran.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${ran.stderr.toString()}`);
		return ran.stdout.toString();
	};
	git("init", "-q");
	git("symbolic-ref", "HEAD", "refs/heads/main");
	git("config", "core.autocrlf", "false");
	git("config", "commit.gpgsign", "false");
	return { top, git };
}

describe.skipIf(!hasGit)("git, asked from a workspace below the repository's top", () => {
	const before = Object.fromEntries(Object.keys(identity).map((name) => [name, process.env[name]]));
	beforeAll(() => void Object.assign(process.env, identity));
	afterAll(() => {
		for (const [name, value] of Object.entries(before)) {
			if (value === undefined) delete process.env[name];
			else process.env[name] = value;
		}
	});
	const text = (path: string) => readFileSync(path, "utf8");

	test("a stash holds the workspace's changes and leaves the rest of the repository as it is", async () => {
		const { top, git } = repository("stash-repo");
		const ws = join(top, "app");
		mkdirSync(join(top, "docs"), { recursive: true });
		mkdirSync(ws, { recursive: true });
		writeFileSync(join(top, "top.txt"), "top\n");
		writeFileSync(join(top, "docs", "note.md"), "note\n");
		writeFileSync(join(ws, "inside.ssl"), ":RETURN 1;\n");
		writeFileSync(join(ws, "staged.ssl"), ":RETURN 1;\n");
		git("add", "-A");
		git("commit", "-q", "-m", "one");

		writeFileSync(join(top, "top.txt"), "top, changed outside the workspace\n");
		writeFileSync(join(top, "docs", "note.md"), "note, staged outside the workspace\n");
		git("add", "docs/note.md");
		writeFileSync(join(ws, "inside.ssl"), ":RETURN 2;\n");
		writeFileSync(join(ws, "staged.ssl"), ":RETURN 2;\n");
		git("add", "app/staged.ssl");
		writeFileSync(join(ws, "new.ssl"), ":RETURN 3;\n");

		const g = new Git(ws);
		try {
			const pushed = await g.stash("push", "work in the app");
			expect(pushed.ok).toBe(true);
			// The workspace's followed files are back as committed; the file git does not follow stays where it is.
			expect(text(join(ws, "inside.ssl"))).toBe(":RETURN 1;\n");
			expect(text(join(ws, "staged.ssl"))).toBe(":RETURN 1;\n");
			expect(text(join(ws, "new.ssl"))).toBe(":RETURN 3;\n");
			// Outside the workspace nothing moved: before, both were taken into the stash and reverted.
			expect(text(join(top, "top.txt"))).toBe("top, changed outside the workspace\n");
			expect(text(join(top, "docs", "note.md"))).toBe("note, staged outside the workspace\n");
			expect(git("status", "--porcelain").split("\n").filter(Boolean).sort()).toEqual([" M top.txt", "?? app/new.ssl", "M  docs/note.md"].sort());
			// The entry holds the workspace's files and not the change outside it. (What is staged outside is in it as
			// well, as a copy: a stash records the index whole. It stays staged where it was, as the status above says.)
			const held = git("stash", "show", "--name-only", "stash@{0}").split("\n").filter(Boolean);
			expect(held).toContain("app/inside.ssl");
			expect(held).toContain("app/staged.ssl");
			expect(held).not.toContain("top.txt");
			expect((await g.stash("list")).entries?.[0]?.message).toContain("work in the app");

			// Nothing is left in the workspace to save, whatever is changed outside it.
			expect(await g.stash("push")).toEqual({ ok: false, message: "No local changes to save." });
			expect(text(join(top, "top.txt"))).toBe("top, changed outside the workspace\n");

			const popped = await g.stash("pop");
			expect(popped.ok).toBe(true);
			expect(text(join(ws, "inside.ssl"))).toBe(":RETURN 2;\n");
			expect(text(join(ws, "staged.ssl"))).toBe(":RETURN 2;\n");
			expect(text(join(top, "top.txt"))).toBe("top, changed outside the workspace\n");
			expect(text(join(top, "docs", "note.md"))).toBe("note, staged outside the workspace\n");
			// What was staged in the workspace is back as a change, no longer staged: a pop does not restore the index, as before.
			expect(git("status", "--porcelain").split("\n").filter(Boolean).sort()).toEqual([" M app/inside.ssl", " M app/staged.ssl", " M top.txt", "?? app/new.ssl", "M  docs/note.md"].sort());
			expect((await g.stash("list")).entries).toEqual([]);
		} finally {
			g.dispose();
		}
	});

	test("a workspace folder with an odd name, and one in which git follows nothing", async () => {
		const { top, git } = repository("stash-odd");
		// Every sign git reads as a pattern that the system lets a folder be named with: Windows allows no `*` in a name.
		const ws = join(top, posix ? "a[b]*c" : "a[b]c");
		const untracked = join(top, "only-new");
		mkdirSync(ws, { recursive: true });
		mkdirSync(untracked, { recursive: true });
		writeFileSync(join(top, "top.txt"), "top\n");
		writeFileSync(join(ws, "inside.ssl"), ":RETURN 1;\n");
		git("add", "-A");
		git("commit", "-q", "-m", "one");
		writeFileSync(join(top, "top.txt"), "top changed\n");
		writeFileSync(join(ws, "inside.ssl"), ":RETURN 2;\n");
		writeFileSync(join(untracked, "new.ssl"), ":RETURN 3;\n");

		const g = new Git(ws);
		const none = new Git(untracked);
		try {
			expect((await g.stash("push")).ok).toBe(true);
			expect(text(join(ws, "inside.ssl"))).toBe(":RETURN 1;\n");
			expect(text(join(top, "top.txt"))).toBe("top changed\n");
			expect((await g.stash("pop")).ok).toBe(true);
			expect(text(join(ws, "inside.ssl"))).toBe(":RETURN 2;\n");

			// A folder of new files only: there is nothing a stash could hold, and nothing is touched.
			expect(await none.stash("push")).toEqual({ ok: false, message: "No local changes to save." });
			expect(text(join(top, "top.txt"))).toBe("top changed\n");
			expect(text(join(ws, "inside.ssl"))).toBe(":RETURN 2;\n");
			expect(text(join(untracked, "new.ssl"))).toBe(":RETURN 3;\n");
		} finally {
			g.dispose();
			none.dispose();
		}
	});

	test("at the repository's top a stash takes every change, as before", async () => {
		const { top, git } = repository("stash-top");
		mkdirSync(join(top, "app"), { recursive: true });
		writeFileSync(join(top, "top.txt"), "top\n");
		writeFileSync(join(top, "app", "inside.ssl"), ":RETURN 1;\n");
		git("add", "-A");
		git("commit", "-q", "-m", "one");
		writeFileSync(join(top, "top.txt"), "top changed\n");
		writeFileSync(join(top, "app", "inside.ssl"), ":RETURN 2;\n");
		const g = new Git(top);
		try {
			expect((await g.stash("push")).ok).toBe(true);
			expect(text(join(top, "top.txt"))).toBe("top\n");
			expect(text(join(top, "app", "inside.ssl"))).toBe(":RETURN 1;\n");
			expect((await g.stash("pop")).ok).toBe(true);
			expect(text(join(top, "top.txt"))).toBe("top changed\n");
		} finally {
			g.dispose();
		}
	});

	test("a file's name comes back from the log and from blame as it is on disk, and reads the file at that commit", async () => {
		const { top, git } = repository("odd-names");
		const ws = join(top, "app");
		mkdirSync(ws, { recursive: true });
		const wanted = ["tab\there.ssl", 'quote"d.ssl', "new\nline.ssl", "back\\slash.ssl", "ünï 文.ssl", " lead.ssl", "plain.ssl"];
		// A name the file system refuses (a quote, a tab or a line break, on Windows) is left out.
		const odd = wanted.filter((name) => {
			try {
				writeFileSync(join(ws, name), `/* ${JSON.stringify(name)} first;\n:RETURN 1;\n`);
				return true;
			} catch {
				return false;
			}
		});
		expect(odd).toContain("plain.ssl");
		git("add", "-A");
		git("commit", "-q", "-m", "ABC-1 first");
		for (const name of odd) writeFileSync(join(ws, name), `/* ${JSON.stringify(name)} second;\n:RETURN 2;\n`);
		git("commit", "-q", "-a", "-m", "ABC-1 second");

		const g = new Git(ws);
		try {
			for (const name of odd) {
				const path = join(ws, name);
				const log = await g.log(path);
				expect(log.map((commit) => commit.subject)).toEqual(["ABC-1 second", "ABC-1 first"]);
				// Before: "app/tab\there.ssl" in quotes, with a backslash and a t, which is no file in the commit.
				expect(log.map((commit) => commit.path)).toEqual([`app/${name}`, `app/${name}`]);
				expect(await g.show(path, log[1]!.sha, log[1]!.path)).toBe(`/* ${JSON.stringify(name)} first;\n:RETURN 1;\n`);
				const blame = await g.blameLine(path, 2);
				expect(blame?.filename).toBe(`app/${name}`);
				const change = await g.commitFile(path, blame!.sha, blame!.filename);
				expect(change.after).toBe(`/* ${JSON.stringify(name)} second;\n:RETURN 2;\n`);
				expect(change.before).toBe(`/* ${JSON.stringify(name)} first;\n:RETURN 1;\n`);
			}
		} finally {
			g.dispose();
		}
	});

	test("the log follows a file to the name it had, odd or not, and a commit without a name of its own has the one after it", async () => {
		const { top, git } = repository("odd-rename");
		const ws = join(top, "app");
		mkdirSync(ws, { recursive: true });
		const body = Array.from({ length: 12 }, (_, i) => `:DECLARE n${i};`).join("\n");
		writeFileSync(join(ws, "old name.ssl"), `${body}\n`);
		git("add", "-A");
		git("commit", "-q", "-m", "one");
		let renamed = 'new "name".ssl';
		try {
			writeFileSync(join(ws, renamed), "");
			rmSync(join(ws, renamed));
		} catch {
			renamed = "new name.ssl";
		}
		git("mv", "app/old name.ssl", `app/${renamed}`);
		git("commit", "-q", "-m", "two: renamed");
		writeFileSync(join(ws, renamed), `${body}\n:RETURN 1;\n`);
		git("commit", "-q", "-a", "-m", "three");

		const g = new Git(ws);
		try {
			const log = await g.log(join(ws, renamed));
			expect(log.map((commit) => [commit.subject, commit.path])).toEqual([
				["three", `app/${renamed}`],
				["two: renamed", `app/${renamed}`],
				["one", "app/old name.ssl"],
			]);
			expect(await g.show(join(ws, renamed), log[2]!.sha, log[2]!.path)).toBe(`${body}\n`);
		} finally {
			g.dispose();
		}
	});

	test("a name as git prints it in quotes is read back", () => {
		expect(unquoteGitPath("app/plain.ssl")).toBe("app/plain.ssl");
		expect(unquoteGitPath('"app/tab\\there.ssl"')).toBe("app/tab\there.ssl");
		expect(unquoteGitPath('"app/quote\\"d.ssl"')).toBe('app/quote"d.ssl');
		expect(unquoteGitPath('"app/new\\nline.ssl"')).toBe("app/new\nline.ssl");
		expect(unquoteGitPath('"app/back\\\\slash.ssl"')).toBe("app/back\\slash.ssl");
		// Bytes written as octal, as git writes them where it is not told to leave them: two bytes are one letter.
		expect(unquoteGitPath('"app/\\303\\274n\\303\\257.ssl"')).toBe("app/ünï.ssl");
		expect(unquoteGitPath('"app/\\033[x \\346\\226\\207 and ü.ssl"')).toBe("app/\x1b[x 文 and ü.ssl");
		// A name that only looks begun in quotes is left alone.
		expect(unquoteGitPath('"')).toBe('"');
		expect(unquoteGitPath('app/"q".ssl')).toBe('app/"q".ssl');
	});
});

// ---------------------------------------------------------------------------------------------------------------
// 9. The History panel: rows belong to the file they are shown for
// ---------------------------------------------------------------------------------------------------------------

describe("the History panel's rows", () => {
	let stillFor: (loadedPath: string | null | undefined, activePath: string | null | undefined) => boolean;
	let rowsFor: <T>(loaded: { path: string; rows: T[] } | undefined, activePath: string | null | undefined) => T[];

	beforeAll(async () => {
		// The few browser and Monaco names the view's modules ask for when they are loaded (as test/pass3MediumsDocs.test.ts has them).
		const g = globalThis as any;
		const storage = new Map<string, string>();
		g.localStorage ??= { getItem: (k: string) => storage.get(k) ?? null, setItem: (k: string, v: string) => void storage.set(k, String(v)), removeItem: (k: string) => void storage.delete(k), clear: () => storage.clear() };
		g.window ??= { innerWidth: 1280, innerHeight: 900, addEventListener() {}, removeEventListener() {}, location: { href: "http://localhost/", protocol: "http:", host: "127.0.0.1:5190" }, matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }) };
		g.window.Error ??= Error;
		g.window.Map ??= Map;
		g.window.Set ??= Set;
		g.document ??= { documentElement: { dataset: {}, style: {} }, head: { appendChild() {} }, body: { style: {} }, activeElement: null, getElementById: () => null, createElement: () => ({ style: {}, getContext: () => null }), querySelector: () => null, addEventListener() {}, removeEventListener() {} };
		g.self ??= globalThis;
		const uri = (scheme: string, fsPath: string) => {
			const normalized = fsPath.replace(/\\/g, "/");
			const raw = scheme === "file" ? `file://${normalized.startsWith("/") ? "" : "/"}${normalized}` : `${scheme}:${fsPath}`;
			return { scheme, fsPath, path: normalized, toString: () => raw };
		};
		const noop = (known: Record<string, any> = {}): any => new Proxy(known, { get: (target, prop) => (prop in target ? target[prop as any] : () => ({ dispose() {} })) });
		mock.module(`${resolve(import.meta.dir, "../src/view/editor/markdownLive.worker.ts")}?worker`, () => ({ default: class {} }));
		mock.module("monaco-editor/editor/editor.worker?worker", () => ({ default: class {} }));
		mock.module("monaco-editor/features/register.all", () => ({}));
		mock.module("monaco-editor/editor/contrib/semanticTokens/browser/documentSemanticTokens", () => ({}));
		for (const lang of ["markdown", "sql", "yaml", "xml", "ini", "shell", "powershell", "bat", "javascript", "typescript", "html", "css", "scss", "less", "csharp", "vb", "razor", "pgsql", "mysql", "python", "java", "cpp", "php", "dockerfile", "graphql", "r", "perl", "ruby", "go", "rust", "fsharp"]) {
			mock.module(`monaco-editor/languages/definitions/${lang}/register`, () => ({}));
		}
		mock.module("monaco-editor/editor/editor.api", () => ({
			Range: class {
				constructor(
					public startLineNumber: number,
					public startColumn: number,
					public endLineNumber: number,
					public endColumn: number,
				) {}
			},
			Emitter: class {
				event = () => ({ dispose() {} });
				fire() {}
				dispose() {}
			},
			Uri: { from: () => ({}), file: (p: string) => uri("file", p), parse: (raw: string) => (raw.startsWith("file://") ? uri("file", raw.slice("file://".length)) : uri("untitled", raw)) },
			MarkerSeverity: { Hint: 1, Info: 2, Warning: 4, Error: 8 },
			KeyMod: { CtrlCmd: 2048, Shift: 1024, Alt: 512 },
			KeyCode: { KeyF: 36, KeyZ: 56, KeyY: 55 },
			languages: noop({ CompletionItemKind: { File: 1, Keyword: 2, Text: 3, Snippet: 4, Field: 5, Struct: 6 }, SymbolKind: { Function: 11, Method: 5, Constructor: 8, Namespace: 2 }, FoldingRangeKind: { Comment: "comment", Imports: "imports", Region: "region" }, CompletionItemInsertTextRule: { InsertAsSnippet: 4 } }),
			editor: noop({ EndOfLineSequence: { LF: 0, CRLF: 1 }, ScrollType: { Immediate: 1 }, getEditors: () => [], getModels: () => [], getModel: () => null, createModel: () => null, onDidCreateModel: () => ({ dispose() {} }), setModelMarkers() {}, getModelMarkers: () => [], registerEditorOpener: () => ({ dispose() {} }) }),
		}));
		({ stillFor, rowsFor } = await import("../src/view/panels/History"));
	});

	test("what was loaded is still for the file on screen only while that file is the one it was loaded for", () => {
		expect(stillFor("/ws/a.ssl", "/ws/a.ssl")).toBe(true);
		expect(stillFor("/ws/a.ssl", "/ws/b.ssl")).toBe(false);
		expect(stillFor("/ws/a.ssl", null)).toBe(false);
		expect(stillFor(undefined, "/ws/a.ssl")).toBe(false);
		// Nothing loaded for no file is not "for" no file.
		expect(stillFor("", "")).toBe(false);
		expect(stillFor(null, null)).toBe(false);

		const rows = ["commit 1", "commit 2"];
		expect(rowsFor({ path: "/ws/a.ssl", rows }, "/ws/a.ssl")).toBe(rows);
		expect(rowsFor({ path: "/ws/a.ssl", rows }, "/ws/b.ssl")).toEqual([]);
		expect(rowsFor({ path: "/ws/a.ssl", rows }, null)).toEqual([]);
		expect(rowsFor(undefined, "/ws/a.ssl")).toEqual([]);
	});

	test("the rows go the moment the file changes, a late reply for another file shows nothing, and the new file's rows come", async () => {
		// The panel's own arrangement: a query that reads the open file's history, and the rows taken from it for the open file.
		const replies = new Map<string, (rows: string[]) => void>();
		const settle = async () => {
			await Promise.resolve();
			await Promise.resolve();
			flush();
		};
		let path!: () => string;
		let open!: (path: string) => void;
		let loaded!: () => { path: string; rows: string[] } | undefined;
		const dispose = createRoot((dispose) => {
			const [active, setActive] = createSignal("/ws/a.ssl");
			path = active;
			open = (next) => void setActive(next);
			[loaded] = createAsyncQuery(
				() => [active()] as const,
				([file]) => new Promise<{ path: string; rows: string[] }>((done) => replies.set(file, (rows) => done({ path: file, rows }))),
			);
			return dispose;
		});
		const shown = () => untrack(() => rowsFor(loaded(), path()));
		try {
			flush();
			replies.get("/ws/a.ssl")!(["a: commit 2", "a: commit 1"]);
			await settle();
			expect(shown()).toEqual(["a: commit 2", "a: commit 1"]);

			// Another file is opened. The query still holds the first file's rows until the new ones are read:
			// those are the rows that stayed on screen, and acted on the new file.
			open("/ws/b.ssl");
			flush();
			expect(untrack(loaded)?.path).toBe("/ws/a.ssl");
			expect(shown()).toEqual([]);

			// A third file is opened before the second's history has come; the second's comes late.
			open("/ws/c.ssl");
			flush();
			replies.get("/ws/b.ssl")!(["b: commit 1"]);
			await settle();
			expect(shown()).toEqual([]);

			replies.get("/ws/c.ssl")!(["c: commit 1"]);
			await settle();
			expect(shown()).toEqual(["c: commit 1"]);
		} finally {
			dispose();
		}
	});

	test("each row acts on the file it was loaded for (read from the panel's text: its handlers cannot be run without a page)", () => {
		const src = readFileSync(join(import.meta.dir, "../src/view/panels/History.tsx"), "utf8").replace(/\r\n/g, "\n");
		// Every handler that takes a row gets its file from the row, never from whatever file is open at the click.
		for (const handler of ["showSnapshot", "showCommitVsCurrent", "showCommitDiff", "openSnapshotMenu", "openCommitMenu"]) {
			const body = src.slice(src.indexOf(`const ${handler} = async (`));
			expect(body.slice(0, body.indexOf("\n\t};"))).toMatch(/^const \w+ = async \((snap|commit): Loaded<\w+>[^)]*\) => \{\n\t\tconst path = fileOf\((snap|commit)\);/);
		}
		expect(src).toMatch(/const compareTwoRevs = async \(a: HistoryRev, b: HistoryRev\) => \{\n\t\tconst path = fileOf\(a\);\n\t\tif \(!path\) return;\n\t\tif \(b\.forPath !== path\) return notify\(/);
		expect(src).not.toMatch(/const path = activePath\(\);/);
	});
});
