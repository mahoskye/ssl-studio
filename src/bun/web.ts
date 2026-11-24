// The browser host: serves the built UI and carries the backend over a
// WebSocket, on 127.0.0.1 only. For development and UI checks; the app
// uses Electrobun's RPC (index.ts).
//
//   hutch run web [folder]      then open http://127.0.0.1:5190
import { randomUUID, timingSafeEqual } from "node:crypto";
import { lstatSync, realpathSync, statSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import type { ServerWebSocket } from "bun";
import type { Call, Push, Reply } from "../shared/protocol";
import { createBackend, dispatch } from "./backend";

const MAX_WS_PAYLOAD = 32 * 1024 * 1024;
export const HTML_CSP =
	"default-src 'self'; script-src 'self' 'unsafe-eval' 'wasm-unsafe-eval' blob:; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data:; connect-src 'self' ws: wss:; worker-src 'self' blob:; object-src 'none'; base-uri 'self'; frame-ancestors 'none'";

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

function safeSend(ws: ServerWebSocket<unknown>, text: string, sockets?: Set<ServerWebSocket<unknown>>) {
	if (ws.readyState !== 1) return;
	try {
		ws.send(text);
	} catch {
		sockets?.delete(ws);
	}
}

export function startWebHost(options?: { port?: number; dist?: string; folder?: string; token?: string; quit?: () => void }) {
	const port = options?.port ?? Number(process.env.PORT ?? 5190);
	const dist = resolve(options?.dist ?? join(import.meta.dir, "../../dist"));
	const folder = options?.folder;
	const token = options?.token ?? randomUUID();
	const sockets = new Set<ServerWebSocket<unknown>>();

	const backend = createBackend(
		{
			app: "0.1.0 (browser host)",
			kind: "browser",
			isWebHost: true,
			restrictPaths: true,
			quit: options?.quit ?? (() => process.exit(0)),
			emit: (event, payload) => {
				const text = JSON.stringify({ event, payload } satisfies Push);
				for (const ws of sockets) safeSend(ws, text, sockets);
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
			open: (ws) => void sockets.add(ws),
			close: (ws) => {
				sockets.delete(ws);
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
						safeSend(ws, JSON.stringify({ id: (raw as any).id, error: "invalid RPC call" } satisfies Reply), sockets);
					}
					return;
				}
				const call = raw as Call;
				let reply: Reply;
				try {
					reply = { id: call.id, result: await dispatch(backend.api, call.method, call.args) };
				} catch (e: any) {
					reply = { id: call.id, error: String(e?.message ?? e) };
				}
				safeSend(ws, JSON.stringify(reply), sockets);
			},
		},
	});

	const stop = () => {
		for (const ws of sockets) {
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

	return { server, backend, token, stop };
}

if (import.meta.main) {
	const folder = process.argv[2] ?? process.env.SSL_STUDIO_FOLDER;
	const { server, backend } = startWebHost({ folder });
	let shuttingDown = false;
	const shutdown = () => {
		if (shuttingDown) return;
		shuttingDown = true;
		backend.dispose();
		server.stop();
		process.exit(0);
	};
	process.on("SIGINT", shutdown);
	process.on("SIGTERM", shutdown);
	console.log(`SSL Studio (browser host) on http://127.0.0.1:${server.port}/${folder ? ` with ${folder}` : ""}`);
}
