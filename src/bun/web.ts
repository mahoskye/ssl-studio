// The browser host: serves the built UI and carries the backend over a
// WebSocket, on 127.0.0.1 only. For development and UI checks; the app
// uses Electrobun's RPC (index.ts).
//
//   hutch run web [folder]      then open http://127.0.0.1:5190
import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID, timingSafeEqual } from "node:crypto";
import { lstatSync, realpathSync, statSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import type { ServerWebSocket } from "bun";
import type { BackendEvents, Call, LspState, Push, Reply } from "../shared/protocol";
import { createBackend, dispatch } from "./backend";

const MAX_WS_PAYLOAD = 32 * 1024 * 1024;
export const HTML_CSP =
	"default-src 'self'; script-src 'self' 'unsafe-eval' 'wasm-unsafe-eval' blob:; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data:; connect-src 'self' ws: wss:; worker-src 'self' blob:; object-src 'none'; base-uri 'self'; form-action 'none'; frame-ancestors 'none'";

function withSep(p: string): string {
	return p.endsWith(sep) ? p : p + sep;
}

/** Strict Host header allowlist: loopback only on the active port (mitigates DNS rebinding). */
export function isAllowedHost(host: string | null | undefined, port: number): boolean {
	if (!host) return false;
	const normalized = host.toLowerCase();
	return normalized === `127.0.0.1:${port}` || normalized === `localhost:${port}`;
}

/** Strict Origin header check for WebSocket upgrades (mitigates CSWSH). */
export function isAllowedOrigin(origin: string | null | undefined, host: string | null | undefined): boolean {
	if (!origin || !host) return false;
	const h = host.toLowerCase();
	if (/[\s/@?#]/.test(h)) return false;
	const o = origin.toLowerCase();
	return o === `http://${h}` || o === `https://${h}`;
}

/** Constant-time token comparison over equal-length UTF-8 byte buffers. */
export function tokensMatch(given: string | null | undefined, expected: string): boolean {
	if (!given || !expected) return false;
	const a = Buffer.from(given, "utf8");
	const b = Buffer.from(expected, "utf8");
	if (a.length !== b.length) return false;
	return timingSafeEqual(a, b);
}

export type StaticPathResult =
	| { ok: true; path: string; isIndex: boolean }
	| { ok: false; status: 400 | 403 | 404 };

/** Resolves a URL pathname safely inside `distDir`, rejecting malformed URIs, prefix collisions, and symlink escapes. */
export function resolveStaticPath(distDir: string, pathname: string): StaticPathResult {
	let decoded: string;
	try {
		decoded = pathname === "/" ? "/index.html" : decodeURIComponent(pathname);
	} catch {
		return { ok: false, status: 400 };
	}
	if (decoded.includes("\0")) return { ok: false, status: 400 };

	const dist = resolve(distDir);
	const safeDecoded = decoded.replace(/\\/g, "/");
	const rel = safeDecoded.startsWith("/") ? "." + safeDecoded : safeDecoded;
	const target = resolve(dist, rel);
	const fold = (p: string) => (process.platform === "win32" ? p.toLowerCase() : p);
	if (!fold(target).startsWith(withSep(fold(dist)))) {
		return { ok: false, status: 403 };
	}

	let realDist: string;
	try {
		realDist = realpathSync(dist);
	} catch {
		return { ok: false, status: 404 };
	}

	let realTarget: string;
	try {
		realTarget = realpathSync(target);
	} catch (e: any) {
		if (e?.code === "ENOENT" || e?.code === "ENOTDIR") {
			try {
				if (lstatSync(target).isSymbolicLink()) return { ok: false, status: 403 };
			} catch {
				// Not a symlink; genuinely missing.
			}
			return { ok: false, status: 404 };
		}
		return { ok: false, status: 403 };
	}

	const realCmp = (p: string) => (process.platform === "win32" || process.platform === "darwin" ? p.toLowerCase() : p);
	if (!realCmp(realTarget).startsWith(withSep(realCmp(realDist)))) {
		return { ok: false, status: 403 };
	}

	try {
		if (!statSync(realTarget).isFile()) return { ok: false, status: 404 };
	} catch {
		return { ok: false, status: 404 };
	}

	const isIndex = realCmp(realTarget) === realCmp(join(realDist, "index.html"));
	return { ok: true, path: realTarget, isIndex };
}

/** Injects the per-launch WebSocket authentication token meta tag into the `<head>` of index.html. */
export function injectTokenMeta(html: string, token: string): string {
	const meta = `<meta name="ssl-studio-token" content="${token}">`;
	if (/<head(\s[^>]*)?>/i.test(html)) {
		return html.replace(/<head(\s[^>]*)?>/i, (match) => `${match}\n\t\t${meta}`);
	}
	if (/<\/head>/i.test(html)) {
		return html.replace(/<\/head>/i, `${meta}</head>`);
	}
	return `${meta}\n${html}`;
}

/** What an outbox needs of a socket. Bun's `send` says how it went: the bytes sent, -1 for taken but held back, 0 for dropped. */
export type OutboxSocket = { readyState: number; send(text: string): number; getBufferedAmount(): number; close(code?: number, reason?: string): void };

/** With more than this held back in the socket, what comes next waits here: the socket drops what it is given past its own limit (16 MB). */
const SOCKET_LOW_WATER = 1024 * 1024;
/** As much as may wait for one tab, in characters. A tab that far behind is not reading, and is let go of. */
const MAX_WAITING_CHARS = 256 * 1024 * 1024;
/** How often what waits is looked at again, should the socket never say that it drained. */
const OUTBOX_RETRY_MS = 250;

/**
 * What one tab is sent, in order and none of it lost. A socket with a large reply still on its way (a picture)
 * drops what it is given next, and says so only in what `send` returns. Nobody read that: the reply was gone, and
 * the call it answered waited for ever. Here what the socket has no room for waits, and goes when the socket has
 * drained. A tab that cannot be sent to at all is closed: the view fails every call in flight when its
 * connection closes, which is an answer, where silence is none.
 *
 * What waits is never sent from inside the socket's own `drain` call. Bun's socket, given a large message
 * there, holds it and sends no more of it until something else stirs the connection: the tab's next call, or the
 * keep-alive ping more than a minute and a half later. A tab that had asked for three pictures and then only
 * waited (a Markdown preview does) got the first and nothing after it. So `drained()` sends on a later turn of
 * the event loop (`setImmediate`; a microtask still runs inside the call and stalls the same way).
 */
export function createOutbox(ws: OutboxSocket, limit = MAX_WAITING_CHARS, retryMs = OUTBOX_RETRY_MS) {
	const queue: string[] = [];
	let waiting = 0;
	let open = true;
	/** A send of what waits is due on a later turn. */
	let due = false;
	let retry: ReturnType<typeof setTimeout> | undefined;
	const rest = () => {
		queue.length = 0;
		waiting = 0;
		if (retry !== undefined) clearTimeout(retry);
		retry = undefined;
	};
	const giveUp = () => {
		open = false;
		rest();
		try {
			ws.close(1013, "SSL Studio could not send this tab its replies.");
		} catch {
			// Already closed.
		}
	};
	const room = () => ws.getBufferedAmount() <= SOCKET_LOW_WATER;
	/** True when the socket took the text: sent, or held back by the socket itself, which sends it on. */
	const give = (text: string): boolean => {
		try {
			return ws.send(text) !== 0;
		} catch {
			giveUp();
			return false;
		}
	};
	/** While anything waits it is looked at again after a while, drain or no drain: a reply must not hang on one event. */
	const watch = () => {
		if (retry !== undefined || !open || queue.length === 0) return;
		retry = setTimeout(() => {
			retry = undefined;
			flush();
		}, retryMs);
		(retry as { unref?: () => void }).unref?.();
	};
	/** What waits goes, oldest first, while there is room. Never called from inside the socket's `drain`. */
	const flush = () => {
		due = false;
		while (open && queue.length && room() && give(queue[0]!)) waiting -= queue.shift()!.length;
		watch();
	};
	return {
		send(text: string) {
			if (!open || ws.readyState !== 1) return;
			if (queue.length === 0 && room() && give(text)) return;
			if (!open) return;
			queue.push(text);
			waiting += text.length;
			if (waiting > limit) return giveUp();
			watch();
		},
		/** The socket has sent some of what it held back: what waited here goes on the next turn of the event loop. */
		drained() {
			if (due || !open || queue.length === 0) return;
			due = true;
			setImmediate(flush);
		},
		/** The socket closed: there is no one to send to. */
		closed() {
			open = false;
			rest();
		},
		/** How many messages wait for the socket to drain. */
		get waiting() {
			return queue.length;
		},
	};
}

function jsonObject(text: string): Record<string, unknown> | null {
	try {
		const value = JSON.parse(text);
		return value && typeof value === "object" && !Array.isArray(value) ? value : null;
	} catch {
		return null;
	}
}

/**
 * How the tabs of one host share its one language server. Each tab numbers its requests from 1, and every tab
 * was sent every answer: a tab took another's answer for its own request of the same number. Here a request
 * goes to the server under a number of the host's own, and its answer goes back, under the tab's number, to the
 * tab that asked and to no other. What the server says unasked (diagnostics, logs) concerns the workspace and
 * goes to every tab. What the server asks (its configuration) goes to every tab too, and the first answer is the
 * answer: the rest are not sent on. It reads the JSON-RPC envelope only, never what is in a message.
 */
export function createLspRoutes<Tab>() {
	let next = 1;
	/** Requests of the tabs that the server has yet to answer, by the number the server was given. */
	const asked = new Map<number, { tab: Tab; id: unknown }>();
	/** Requests of the server that no tab has answered yet. */
	const serverAsked = new Set<string>();
	const has = (id: unknown) => id !== undefined && id !== null;
	return {
		/** A tab's message as the server is to be given it, or null for one that is not sent on. */
		fromTab(tab: Tab, text: string): string | null {
			const message = jsonObject(text);
			if (!message || !has(message.id)) return text;
			if (typeof message.method === "string") {
				const id = next++;
				asked.set(id, { tab, id: message.id });
				return JSON.stringify({ ...message, id });
			}
			return serverAsked.delete(JSON.stringify(message.id)) ? text : null;
		},
		/** A server's message as a tab is to be given it: `tab` is the one it is for, absent when it is for all. Null when the tab that asked is gone. */
		fromServer(text: string): { text: string; tab?: Tab } | null {
			const message = jsonObject(text);
			if (!message || !has(message.id)) return { text };
			if (typeof message.method === "string") {
				serverAsked.add(JSON.stringify(message.id));
				return { text };
			}
			const route = typeof message.id === "number" ? asked.get(message.id) : undefined;
			if (!route) return null;
			asked.delete(message.id as number);
			return { text: JSON.stringify({ ...message, id: route.id }), tab: route.tab };
		},
		/** A tab closed: nothing is owed to it. */
		forget(tab: Tab) {
			for (const [id, route] of asked) if (route.tab === tab) asked.delete(id);
		},
		/** The server stopped or started anew: it answers nothing asked before, and numbers its own requests from the start. */
		reset() {
			asked.clear();
			serverAsked.clear();
		},
	};
}

/** The agent session an event is about, as the adapter itself reads it (src/bun/agent.ts, `dispatch`); undefined for one about no session (its status). */
export function agentEventSession(payload: BackendEvents["agent"]): string | undefined {
	const data = payload?.data as { sessionID?: unknown; form?: { sessionID?: unknown } } | null | undefined;
	const sessionID = data?.sessionID ?? data?.form?.sessionID;
	return typeof sessionID === "string" && sessionID ? sessionID : undefined;
}

/** As many agent sessions as the host remembers the tab of. */
const MAX_SESSION_OWNERS = 500;

export function startWebHost(options?: { port?: number; dist?: string; folder?: string; token?: string; quit?: () => void }) {
	const port = options?.port ?? Number(process.env.PORT ?? 5190);
	const dist = resolve(options?.dist ?? join(import.meta.dir, "../../dist"));
	const folder = options?.folder;
	const token = options?.token ?? randomUUID();
	const sockets = new Map<ServerWebSocket<unknown>, ReturnType<typeof createOutbox>>();
	const post = (ws: ServerWebSocket<unknown>, text: string) => sockets.get(ws)?.send(text);
	const lspRoutes = createLspRoutes<ServerWebSocket<unknown>>();
	/** The tab whose call is being answered, wherever in that call's work an event is sent from. */
	const calling = new AsyncLocalStorage<ServerWebSocket<unknown>>();
	/**
	 * The tab each agent session belongs to: the one whose call started it, or last asked on it. A turn's events
	 * went to every tab, and a tab that was itself waiting on a turn took another tab's for its own: it showed
	 * that text, and its Stop stopped that turn too.
	 */
	const sessionOwner = new Map<string, ServerWebSocket<unknown>>();
	const own = (sessionID: string, ws: ServerWebSocket<unknown>) => {
		sessionOwner.delete(sessionID);
		sessionOwner.set(sessionID, ws);
		if (sessionOwner.size > MAX_SESSION_OWNERS) sessionOwner.delete(sessionOwner.keys().next().value!);
	};
	/** An event as the tabs are sent it: to the one tab it belongs to, or, shared by all (the workspace, the servers' states), to every tab. */
	const push = (event: keyof BackendEvents, payload: unknown, only?: ServerWebSocket<unknown>) => {
		const text = JSON.stringify({ event, payload } satisfies Push);
		if (only) return void post(only, text);
		for (const outbox of sockets.values()) outbox.send(text);
	};
	let stopFn: (() => void) | undefined;

	const backend = createBackend(
		{
			app: "0.1.0 (browser host)",
			kind: "browser",
			isWebHost: true,
			restrictPaths: true,
			quit:
				options?.quit ??
				(() => {
					stopFn?.();
					process.exit(0);
				}),
			emit: (event, payload) => {
				if (event === "lsp") {
					const routed = lspRoutes.fromServer(payload as string);
					if (routed) push(event, routed.text, routed.tab);
					return;
				}
				if (event === "lspState" && (payload as LspState).state !== "running") lspRoutes.reset();
				if (event === "agent") {
					const agentEvent = payload as BackendEvents["agent"];
					const sessionID = agentEventSession(agentEvent);
					// A session is announced from inside the call that asked for it, so the tab of that call is its tab.
					const asker = agentEvent.type === "session" ? calling.getStore() : undefined;
					if (sessionID && asker) own(sessionID, asker);
					// opencode stopped: its sessions went with it.
					if (agentEvent.type === "status" && /^(off|failed)$/.test(String((agentEvent.data as { state?: unknown } | null)?.state))) sessionOwner.clear();
					// A session nobody is known to have asked for is told to every tab, as all events were before.
					return push(event, payload, sessionID ? sessionOwner.get(sessionID) : undefined);
				}
				push(event, payload);
			},
			// No native dialogs in a browser tab: the UI asks for a path instead.
			pick: async () => null,
			trash: async () => {
				throw new Error("delete is only available in the app");
			},
		},
		folder,
	);

	const server = Bun.serve({
		hostname: "127.0.0.1",
		port,
		async fetch(req, srv) {
			const activePort = srv.port ?? port;
			const host = req.headers.get("host");
			if (!isAllowedHost(host, activePort)) {
				return new Response("forbidden", { status: 403 });
			}
			let url: URL;
			try {
				url = new URL(req.url);
			} catch {
				return new Response("bad request", { status: 400 });
			}
			if (url.pathname === "/backend") {
				if (!isAllowedOrigin(req.headers.get("origin"), host) || !tokensMatch(url.searchParams.get("token"), token)) {
					return new Response("forbidden", { status: 403 });
				}
				return srv.upgrade(req, { data: undefined }) ? undefined : new Response("upgrade failed", { status: 400 });
			}
			const resolved = resolveStaticPath(dist, url.pathname);
			if (!resolved.ok) {
				const body = resolved.status === 400 ? "bad request" : resolved.status === 403 ? "forbidden" : "not found";
				return new Response(body, { status: resolved.status });
			}
			if (resolved.isIndex) {
				const html = await Bun.file(resolved.path).text();
				return new Response(injectTokenMeta(html, token), {
					headers: {
						"Content-Type": "text/html; charset=utf-8",
						"Cache-Control": "no-store",
						"Content-Security-Policy": HTML_CSP,
					},
				});
			}
			if (/\.html?$/i.test(resolved.path)) {
				return new Response(Bun.file(resolved.path), {
					headers: {
						"Content-Type": "text/html; charset=utf-8",
						"Content-Security-Policy": HTML_CSP,
					},
				});
			}
			return new Response(Bun.file(resolved.path));
		},
		websocket: {
			maxPayloadLength: MAX_WS_PAYLOAD,
			open: (ws) => void sockets.set(ws, createOutbox(ws)),
			// The outbox sends on a later turn, never from in here: see createOutbox.
			drain: (ws) => sockets.get(ws)?.drained(),
			close: (ws) => {
				sockets.get(ws)?.closed();
				sockets.delete(ws);
				lspRoutes.forget(ws);
				// Give a reloading browser tab a fresh LSP process so its new `initialize` handshake succeeds.
				if (sockets.size === 0) void backend.api.lspRestart().catch(() => {});
			},
			async message(ws, message) {
				let raw: unknown;
				try {
					raw = JSON.parse(typeof message === "string" ? message : Buffer.from(message).toString("utf8"));
				} catch {
					return;
				}
				if (
					typeof raw !== "object" ||
					raw === null ||
					typeof (raw as any).id !== "number" ||
					!Number.isFinite((raw as any).id) ||
					typeof (raw as any).method !== "string" ||
					!Array.isArray((raw as any).args)
				) {
					if (typeof raw === "object" && raw !== null && typeof (raw as any).id === "number" && Number.isFinite((raw as any).id)) {
						post(ws, JSON.stringify({ id: (raw as any).id, error: "invalid RPC call" } satisfies Reply));
					}
					return;
				}
				const call = raw as Call;
				let args = call.args;
				let reply: Reply | undefined;
				if (call.method === "lspSend" && typeof args[0] === "string") {
					const text = lspRoutes.fromTab(ws, args[0]);
					// An answer to the server that another tab has already given: taken, and not sent on.
					if (text === null) reply = { id: call.id };
					else args = [text, ...args.slice(1)];
				}
				if (call.method === "agent" && args[0] === "ask") {
					// A tab that asks on a kept session is the tab its events are for, also after a reload gave it a new connection.
					const sessionID = (args[1] as { sessionID?: unknown }[] | undefined)?.[0]?.sessionID;
					if (typeof sessionID === "string" && sessionID) own(sessionID, ws);
				}
				try {
					reply ??= { id: call.id, result: await calling.run(ws, () => dispatch(backend.api, call.method, args)) };
				} catch (e: any) {
					reply = { id: call.id, error: String(e?.message ?? e) };
				}
				post(ws, JSON.stringify(reply));
			},
		},
	});

	let stopped = false;
	const stop = () => {
		if (stopped) return;
		stopped = true;
		for (const ws of sockets.keys()) {
			try {
				ws.close();
			} catch {
				// Ignore close errors during shutdown.
			}
		}
		sockets.clear();
		backend.dispose();
		server.stop();
	};
	stopFn = stop;

	return { server, backend, token, stop };
}

if (import.meta.main) {
	const folder = process.argv[2] ?? process.env.SSL_STUDIO_FOLDER;
	const { server, stop } = startWebHost({ folder });
	let shuttingDown = false;
	const shutdown = () => {
		if (shuttingDown) return;
		shuttingDown = true;
		stop();
		process.exit(0);
	};
	process.on("SIGINT", shutdown);
	process.on("SIGTERM", shutdown);
	console.log(`SSL Studio (browser host) on http://127.0.0.1:${server.port}/${folder ? ` with ${folder}` : ""}`);
}
