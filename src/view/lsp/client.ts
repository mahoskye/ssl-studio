// A thin LSP client wired straight to Monaco (ARCHITECTURE: monaco-languageclient
// needs the whole VS Code workbench). It knows the protocol, not SSL.
import { backend, on } from "../backend";

type Pending = { resolve: (value: any) => void; reject: (error: any) => void; method: string };

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
			this.pending.set(id, { resolve, reject, method });
			this.send({ id, method, params }).catch((err) => {
				const waiter = this.pending.get(id);
				if (!waiter) return;
				this.pending.delete(id);
				waiter.reject(err instanceof Error ? err : new Error(String(err)));
			});
		});
	}

	/** Fails every request in flight, e.g. when the server restarts. */
	rejectAll(reason: string) {
		for (const waiter of this.pending.values()) waiter.reject(new Error(`${waiter.method}: ${reason}`));
		this.pending.clear();
	}

	on(method: string, handler: (params: any) => void) {
		this.handlers.set(method, [...(this.handlers.get(method) ?? []), handler]);
	}

	onRequest(method: string, handler: (params: any) => any) {
		this.requestHandlers.set(method, handler);
	}
}
