// The browser host: serves the built UI and carries the backend over a
// WebSocket, on 127.0.0.1 only. For development and UI checks; the app
// uses Electrobun's RPC (index.ts).
//
//   hutch run web [folder]      then open http://127.0.0.1:5190
import { resolve } from "node:path";
import type { ServerWebSocket } from "bun";
import type { Call, Push, Reply } from "../shared/protocol";
import { createBackend, dispatch } from "./backend";

const port = Number(process.env.PORT ?? 5190);
const dist = resolve(import.meta.dir, "../../dist");
const folder = process.argv[2] ?? process.env.SSL_STUDIO_FOLDER;
const sockets = new Set<ServerWebSocket<unknown>>();

const backend = createBackend(
	{
		app: "0.1.0 (browser host)",
		kind: "browser",
		quit: () => process.exit(0),
		emit: (event, payload) => {
			const text = JSON.stringify({ event, payload } satisfies Push);
			for (const ws of sockets) ws.send(text);
		},
		// No native dialogs in a browser tab: the UI asks for a path instead.
		pick: async () => null,
		trash: async () => {
			throw new Error("delete is only available in the app");
		},
	},
	folder,
);

Bun.serve({
	hostname: "127.0.0.1",
	port,
	async fetch(req, server) {
		const url = new URL(req.url);
		if (url.pathname === "/backend") {
			return server.upgrade(req, { data: undefined }) ? undefined : new Response("upgrade failed", { status: 400 });
		}
		const path = url.pathname === "/" ? "/index.html" : decodeURIComponent(url.pathname);
		const file = Bun.file(resolve(dist, "." + path));
		if (!resolve(dist, "." + path).startsWith(dist)) return new Response("no", { status: 403 });
		return (await file.exists()) ? new Response(file) : new Response("not found", { status: 404 });
	},
	websocket: {
		open: (ws) => void sockets.add(ws),
		close: (ws) => void sockets.delete(ws),
		async message(ws, message) {
			const call = JSON.parse(String(message)) as Call;
			let reply: Reply;
			try {
				reply = { id: call.id, result: await dispatch(backend.api, call.method, call.args) };
			} catch (e: any) {
				reply = { id: call.id, error: String(e?.message ?? e) };
			}
			ws.send(JSON.stringify(reply));
		},
	},
});

console.log(`SSL Studio (browser host) on http://127.0.0.1:${port}/${folder ? ` with ${folder}` : ""}`);
