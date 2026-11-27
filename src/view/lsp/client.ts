// A thin LSP client wired straight to Monaco (ARCHITECTURE: monaco-languageclient
// needs the whole VS Code workbench). It knows the protocol, not SSL.
import { backend, on } from "../backend";

type Pending = { resolve: (value: any) => void; reject: (error: any) => void; method: string; asked: number };

/**
 * How long the server may leave a request unanswered before it counts as not answering, in milliseconds. A server
 * that works answers in milliseconds; this is long enough for a slow start and a large file, and short enough that
 * a panel does not read "Reading…" for good. (An object, so that a test can shorten the wait.)
 */
export const answerWait = { ms: 5000 };

export type LspTransport = {
	send: (message: string) => Promise<void>;
	onMessage: (listener: (text: string) => void) => void;
};

export class LspClient {
	private nextId = 1;
	private pending = new Map<number, Pending>();
	private handlers = new Map<string, ((params: any) => void)[]>();
	private requestHandlers = new Map<string, (params: any) => any>();
	private sendRaw: (message: string) => Promise<void>;
	/** The first request asked after the server last answered anything: only those from here on can show it silent. */
	private since = 1;
	private watch: ReturnType<typeof setTimeout> | undefined;
	private silent = false;
	private silenceCount = 0;
	private answeringListeners: ((answering: boolean) => void)[] = [];

	constructor(transport?: LspTransport) {
		this.sendRaw = transport?.send ?? ((text) => backend.lspSend(text));
		if (transport) transport.onMessage((text) => this.receive(text));
		else on("lsp", (text) => this.receive(text));
	}

	private receive(text: string) {
		let message: any;
		try {
			message = JSON.parse(text);
		} catch {
			return;
		}
		if (!message || typeof message !== "object") return;
		if (message.id !== undefined && !message.method) {
			this.heardAnswer();
			const waiter = this.pending.get(message.id);
			if (!waiter) return;
			this.pending.delete(message.id);
			if (message.error) waiter.reject(Object.assign(new Error(message.error.message), { code: message.error.code }));
			else waiter.resolve(message.result);
		} else if (message.method && message.id !== undefined) {
			// A request from the server: answer what we know, null otherwise.
			const handler = this.requestHandlers.get(message.method);
			Promise.resolve()
				.then(() => (handler ? handler(message.params) : null))
				.then(
					(result) => this.send({ id: message.id, result: result ?? null }).catch(() => {}),
					(err: any) =>
						this.send({
							id: message.id,
							error: { code: -32603, message: String(err?.message ?? err) },
						}).catch(() => {}),
				);
		} else if (message.method) {
			for (const handler of this.handlers.get(message.method) ?? []) handler(message.params);
		}
	}

	private send(message: object): Promise<void> {
		try {
			return Promise.resolve(this.sendRaw(JSON.stringify({ jsonrpc: "2.0", ...message })));
		} catch (err) {
			return Promise.reject(err);
		}
	}

	notify(method: string, params: unknown) {
		void this.send({ method, params }).catch(() => {});
	}

	request<T = any>(method: string, params: unknown): Promise<T> {
		const id = this.nextId++;
		return new Promise<T>((resolve, reject) => {
			this.pending.set(id, { resolve, reject, method, asked: performance.now() });
			if (!this.watch) this.watchOldest();
			this.send({ id, method, params }).catch((err) => {
				const waiter = this.pending.get(id);
				if (!waiter) return;
				this.pending.delete(id);
				// It never reached the server: its wait says nothing about the server.
				this.watchOldest();
				waiter.reject(err instanceof Error ? err : new Error(String(err)));
			});
		});
	}

	/** Fails every request in flight, e.g. when the server restarts. */
	rejectAll(reason: string) {
		for (const waiter of this.pending.values()) waiter.reject(new Error(`${waiter.method}: ${reason}`));
		this.pending.clear();
		// Nothing is owed any more, so nothing shows a silence: the next server is judged by what it is asked.
		this.heardAnswer();
	}

	// --- Whether the server answers ------------------------------------------------
	// The server is not answering when a request has waited `answerWait` and the server has answered nothing since
	// it was asked. Only an answer counts: a build was seen that went on sending requests of its own and read
	// nothing (starlims-lsp 0.2.0, 2026-11-26). Any answer, to any request, late or a refusal, ends it; a request
	// asked before that answer no longer counts, so one slow request does not show a server silent that answers
	// the others. Requests are not failed when the time is up: an answer that comes late is still delivered.

	/** False while the server leaves what it was asked unanswered. */
	get answering(): boolean {
		return !this.silent;
	}

	/** How many times the server has stopped answering: which silence this is, for what is said once in each. */
	get silences(): number {
		return this.silenceCount;
	}

	/** Told each time the server stops answering (false) and answers again (true). */
	onAnswering(listener: (answering: boolean) => void) {
		this.answeringListeners.push(listener);
	}

	/**
	 * Said by a caller that has waited as long as it would for what it asked (a save waits less than `answerWait`).
	 * If the server has answered nothing since a request still owed was asked, it counts as not answering from now.
	 */
	noAnswer() {
		if (this.silent || !this.oldestUnanswered()) return;
		this.setSilent(true);
	}

	/** The request that has waited longest among those asked since the server last answered. */
	private oldestUnanswered(): Pending | undefined {
		// A Map keeps the order the requests were asked in, and their numbers rise.
		for (const [id, waiter] of this.pending) if (id >= this.since) return waiter;
		return undefined;
	}

	private setSilent(silent: boolean) {
		clearTimeout(this.watch);
		this.watch = undefined;
		if (this.silent === silent) return;
		this.silent = silent;
		if (silent) this.silenceCount++;
		for (const listener of this.answeringListeners) listener(!silent);
	}

	private heardAnswer() {
		this.since = this.nextId;
		this.setSilent(false);
	}

	/** Sets the clock for the request that has waited longest; with none owed, or the silence already known, none. */
	private watchOldest() {
		clearTimeout(this.watch);
		this.watch = undefined;
		const oldest = this.silent ? undefined : this.oldestUnanswered();
		if (!oldest) return;
		const left = oldest.asked + answerWait.ms - performance.now();
		if (left <= 0) return this.setSilent(true);
		this.watch = setTimeout(() => {
			this.watch = undefined;
			this.watchOldest();
		}, left);
		// The clock alone does not keep a process running (a test's run; a browser has no such thing).
		(this.watch as { unref?: () => void }).unref?.();
	}

	on(method: string, handler: (params: any) => void) {
		this.handlers.set(method, [...(this.handlers.get(method) ?? []), handler]);
	}

	onRequest(method: string, handler: (params: any) => any) {
		this.requestHandlers.set(method, handler);
	}
}
