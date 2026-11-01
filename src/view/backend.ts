// The UI's handle on the Bun process. In the app it rides Electrobun's RPC;
// in a browser tab it rides the WebSocket of src/bun/web.ts.
import type { BackendApi, BackendEvents, Call, Push, Reply } from "../shared/protocol";

type Listener<K extends keyof BackendEvents> = (payload: BackendEvents[K]) => void;
const listeners: { [K in keyof BackendEvents]?: Listener<K>[] } = {};

function deliver(push: Push) {
	for (const listener of listeners[push.event] ?? []) (listener as (p: unknown) => void)(push.payload);
}

export function on<K extends keyof BackendEvents>(event: K, listener: Listener<K>) {
	((listeners[event] ??= []) as Listener<K>[]).push(listener);
	return () => {
		listeners[event] = (listeners[event] as Listener<K>[]).filter((l) => l !== listener) as any;
	};
}

type Caller = (method: string, args: unknown[]) => Promise<unknown>;

export const inApp = typeof (window as any).__electrobun !== "undefined";

async function connectElectrobun(): Promise<Caller> {
	const { Electroview } = await import("electrobun/view");
	const rpc = Electroview.defineRPC<any>({
		maxRequestTime: Infinity,
		handlers: { messages: { event: (push: Push) => deliver(push) } },
	});
	new Electroview({ rpc });
	return (method, args) => (rpc as any).request.invoke({ method, args });
}

async function connectSocket(): Promise<Caller> {
	const socket = new WebSocket(`ws://${location.host}/backend`);
	const pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
	let next = 1;
	socket.addEventListener("message", (event) => {
		const message = JSON.parse(event.data) as Reply | Push;
		if ("event" in message) return deliver(message);
		const waiter = pending.get(message.id);
		pending.delete(message.id);
		if (message.error !== undefined) waiter?.reject(new Error(message.error));
		else waiter?.resolve(message.result);
	});
	await new Promise((resolve, reject) => {
		socket.addEventListener("open", resolve);
		socket.addEventListener("error", reject);
	});
	return (method, args) =>
		new Promise((resolve, reject) => {
			const id = next++;
			pending.set(id, { resolve, reject });
			socket.send(JSON.stringify({ id, method, args } as Call));
		});
}

let caller: Caller | undefined;

export async function connect() {
	caller = inApp ? await connectElectrobun() : await connectSocket();
}

/** `backend.read(path)` and so on: every BackendApi method, called remotely. */
export const backend = new Proxy({} as BackendApi, {
	get: (_target, method: string) => (...args: unknown[]) => {
		if (!caller) throw new Error("backend not connected");
		return caller(method, args);
	},
});
