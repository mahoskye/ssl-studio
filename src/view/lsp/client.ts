// A thin LSP client wired straight to Monaco (ARCHITECTURE: monaco-languageclient
// needs the whole VS Code workbench). It knows the protocol, not SSL.
import { backend, on } from "../backend";

type Pending = { resolve: (value: any) => void; reject: (error: any) => void; method: string };

export class LspClient {
	private nextId = 1;
	private pending = new Map<number, Pending>();
	private handlers = new Map<string, ((params: any) => void)[]>();
	private requestHandlers = new Map<string, (params: any) => any>();

	constructor() {
		on("lsp", (text) => this.receive(text));
	}

	private receive(text: string) {
		const message = JSON.parse(text);
		if (message.id !== undefined && !message.method) {
			const waiter = this.pending.get(message.id);
			if (!waiter) return;
			this.pending.delete(message.id);
			if (message.error) waiter.reject(Object.assign(new Error(message.error.message), { code: message.error.code }));
			else waiter.resolve(message.result);
		} else if (message.method && message.id !== undefined) {
			// A request from the server: answer what we know, null otherwise.
			Promise.resolve(this.requestHandlers.get(message.method)?.(message.params) ?? null).then((result) =>
				this.send({ id: message.id, result }),
			);
		} else if (message.method) {
			for (const handler of this.handlers.get(message.method) ?? []) handler(message.params);
		}
	}

	private send(message: object) {
		backend.lspSend(JSON.stringify({ jsonrpc: "2.0", ...message }));
	}

	notify(method: string, params: unknown) {
		this.send({ method, params });
	}

	request<T = any>(method: string, params: unknown): Promise<T> {
		const id = this.nextId++;
		this.send({ id, method, params });
		return new Promise<T>((resolve, reject) => this.pending.set(id, { resolve, reject, method }));
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
