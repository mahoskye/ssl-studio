// The UI's handle on the Bun process. In the app it rides Electrobun's RPC;
// in a browser tab it rides the WebSocket of src/bun/web.ts.
import type { BackendApi, BackendEvents, Call, Push, Reply } from "../shared/protocol";

type Listener<K extends keyof BackendEvents> = (payload: BackendEvents[K]) => void;
const listeners: { [K in keyof BackendEvents]?: Listener<K>[] } = {};

function deliver(push: Push) {
	const current = listeners[push.event];
	if (!current?.length) return;
	for (const listener of [...current]) {
		try {
			(listener as (p: unknown) => void)(push.payload);
		} catch {
			// One failing listener must not prevent delivery to others.
		}
	}
}

export function on<K extends keyof BackendEvents>(event: K, listener: Listener<K>) {
	((listeners[event] ??= []) as Listener<K>[]).push(listener);
	return () => {
		const list = listeners[event] as Listener<K>[] | undefined;
		if (!list) return;
		listeners[event] = list.filter((l) => l !== listener) as any;
	};
}

type Caller = (method: string, args: unknown[]) => Promise<unknown>;

/** Told when the browser host's connection drops: nothing works until the page is reloaded. */
const lost: (() => void)[] = [];
export function onConnectionLost(listener: () => void): () => void {
	lost.push(listener);
	return () => {
		const index = lost.indexOf(listener);
		if (index >= 0) lost.splice(index, 1);
	};
}

export const inApp = typeof window !== "undefined" && typeof (window as any).__electrobun !== "undefined";

async function connectElectrobun(): Promise<Caller> {
	const { Electroview } = await import("electrobun/view");
	const rpc = Electroview.defineRPC<any>({
		maxRequestTime: Infinity,
		handlers: { messages: { event: (push: Push) => deliver(push) } },
	});
	new Electroview({ rpc });
	return (method, args) => (rpc as any).request.invoke({ method, args });
}

let closeActiveSocket: (() => void) | null = null;

function readAuthToken(): string {
	if (typeof document === "undefined" || typeof document.querySelector !== "function") return "";
	return document.querySelector('meta[name="ssl-studio-token"]')?.getAttribute("content") ?? "";
}

async function connectSocket(): Promise<Caller> {
	// Close any prior browser-host socket cleanly before opening a new one.
	closeActiveSocket?.();
	closeActiveSocket = null;

	const protocol = location.protocol === "https:" ? "wss:" : "ws:";
	const token = readAuthToken();
	const query = token ? `?token=${encodeURIComponent(token)}` : "";
	const socket = new WebSocket(`${protocol}//${location.host}/backend${query}`);

	const pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
	let next = 1;
	let opened = false;
	let open = false;
	let replaced = false;

	const failAll = (reason: string) => {
		for (const waiter of pending.values()) waiter.reject(new Error(reason));
		pending.clear();
	};

	let handshakeSettled = false;
	let resolveHandshake!: () => void;
	let rejectHandshake!: (err: Error) => void;
	const handshake = new Promise<void>((resolve, reject) => {
		resolveHandshake = () => {
			if (handshakeSettled) return;
			handshakeSettled = true;
			resolve();
		};
		rejectHandshake = (err: Error) => {
			if (handshakeSettled) return;
			handshakeSettled = true;
			reject(err);
		};
	});

	const closeThis = () => {
		replaced = true;
		open = false;
		if (!opened) rejectHandshake(new Error("The connection to SSL Studio was replaced."));
		failAll("The connection to SSL Studio was replaced.");
		try {
			if (socket.readyState === WebSocket.CONNECTING || socket.readyState === WebSocket.OPEN) {
				socket.close();
			}
		} catch {
			// Ignore close errors on already-closed sockets.
		}
	};
	closeActiveSocket = closeThis;

	socket.addEventListener("message", (event) => {
		if (replaced) return;
		let message: Reply | Push;
		try {
			message = JSON.parse(String(event.data)) as Reply | Push;
		} catch {
			return;
		}
		if (!message || typeof message !== "object") return;
		if ("event" in message) return deliver(message);
		const waiter = pending.get(message.id);
		pending.delete(message.id);
		if (message.error !== undefined) waiter?.reject(new Error(message.error));
		else waiter?.resolve(message.result);
	});

	// Attach close listener BEFORE awaiting open so an early rejection/close never hangs the handshake.
	socket.addEventListener("close", (event) => {
		const wasOpen = open;
		open = false;
		if (closeActiveSocket === closeThis) closeActiveSocket = null;
		if (!opened) {
			rejectHandshake(new Error(`WebSocket closed before opening (code ${event.code})`));
			return;
		}
		failAll("The connection to SSL Studio was lost.");
		if (!replaced && wasOpen) {
			for (const listener of [...lost]) {
				try {
					listener();
				} catch {
					// One failing listener must not prevent notifying others.
				}
			}
		}
	});

	socket.addEventListener(
		"open",
		() => {
			if (replaced) return;
			opened = true;
			open = true;
			resolveHandshake();
		},
		{ once: true },
	);

	socket.addEventListener(
		"error",
		() => {
			if (!opened) rejectHandshake(new Error("WebSocket connection failed."));
		},
		{ once: true },
	);

	await handshake;

	return (method, args) =>
		new Promise((resolve, reject) => {
			if (replaced || !open || socket.readyState !== WebSocket.OPEN) {
				return reject(new Error("The connection to SSL Studio was lost. Reload the page."));
			}
			const id = next++;
			pending.set(id, { resolve, reject });
			try {
				const payload = JSON.stringify({ id, method, args } as Call);
				socket.send(payload);
			} catch (e: any) {
				pending.delete(id);
				reject(e instanceof Error ? e : new Error(String(e)));
			}
		});
}

let caller: Caller | undefined;
let electrobunConnecting: Promise<void> | null = null;
let connectSeq = 0;

export async function connect() {
	if (inApp) {
		if (caller) return;
		if (!electrobunConnecting) {
			electrobunConnecting = connectElectrobun()
				.then((next) => {
					caller = next;
				})
				.finally(() => {
					electrobunConnecting = null;
				});
		}
		return electrobunConnecting;
	}
	const seq = ++connectSeq;
	caller = undefined;
	const next = await connectSocket();
	if (seq !== connectSeq) return;
	caller = next;
}

/** Resets active RPC caller and socket state between isolated unit tests. */
export function disconnectForTest() {
	connectSeq++;
	caller = undefined;
	electrobunConnecting = null;
	closeActiveSocket?.();
	closeActiveSocket = null;
}

/** `backend.read(path)` and so on: every BackendApi method, called remotely. */
export const backend = new Proxy({} as BackendApi, {
	get: (_target, method) => {
		if (typeof method === "symbol" || method === "then" || method === "toJSON") return undefined;
		return (...args: unknown[]) => {
			if (!caller) return Promise.reject(new Error("backend not connected"));
			return caller(method, args);
		};
	},
});
