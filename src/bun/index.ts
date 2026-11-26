// The desktop app: one Electrobun window, the backend over Electrobun's RPC.
//
//   hutch run start [folder]
import Electrobun, { BrowserView, BrowserWindow, Screen, Utils } from "electrobun/main";
import type { ElectrobunEvent, ElectrobunRPCSchema, RPCSchema } from "electrobun/main";
import type { BackendEvents } from "../shared/protocol";
import { createBackend, dispatch } from "./backend";
import { fitWindow } from "./window";
import { homedir } from "node:os";

type Schema = {
	bun: RPCSchema<{ requests: { invoke: { params: { method: string; args: unknown[] }; response: unknown } }; messages: {} }>;
	webview: RPCSchema<{ requests: {}; messages: { event: { event: keyof BackendEvents; payload: unknown } } }>;
} & ElectrobunRPCSchema;

const folder = process.argv.slice(2).find((a) => !a.startsWith("-")) ?? process.env.SSL_STUDIO_FOLDER;

let rpcReady = false;

const backend = createBackend(
	{
		app: "0.1.0",
		kind: "app",
		quit: () => Utils.quit(),
		emit: (event, payload) => {
			if (!rpcReady) return;
			try {
				rpc.send.event({ event, payload });
			} catch {
				// Transport not ready or already torn down.
			}
		},
		pick: async (kind, types) => {
			const paths = await Utils.openFileDialog({
				startingFolder: homedir(),
				canChooseFiles: kind === "file",
				canChooseDirectory: kind === "folder",
				allowsMultipleSelection: false,
				allowedFileTypes: types ?? (kind === "file" ? "json,jsonc" : "*"),
			});
			return paths.find((p) => p) ?? null;
		},
		trash: async (path) => {
			if (!Utils.moveToTrash(path)) throw new Error(`Could not move ${path} to Trash.`);
		},
		clipboard: (text) => Utils.clipboardWriteText(text),
	},
	folder,
);

const rpc = BrowserView.defineRPC<Schema>({
	maxRequestTime: Infinity,
	handlers: {
		requests: {
			// Not "call": the request proxy is a function, and .call is Function.prototype.call.
			invoke: async (params: unknown) => {
				const { method, args } = params as { method: string; args: unknown[] };
				try {
					return await dispatch(backend.api, method, args);
				} catch (err) {
					throw err instanceof Error ? err : new Error(String(err));
				}
			},
		},
	},
});

const window = new BrowserWindow({
	title: "SSL Studio",
	url: "views://main/index.html",
	rpc,
	frame: fitWindow(Screen.getPrimaryDisplay().workArea),
});
rpcReady = true;

let disposed = false;
const disposeOnce = () => {
	if (disposed) return;
	disposed = true;
	rpcReady = false;
	backend.dispose();
};

// Electrobun asks before a window closes, and takes no for an answer: with
// unsaved edits the window stays for the moment it takes the view to have
// their text kept, and the view then closes the app. Nothing is asked (ADR 0034).
window.on("will-close", (event: unknown) => {
	if (!backend.mayClose()) (event as { response?: { allow: boolean } }).response = { allow: false };
});

window.on("close", () => {
	disposeOnce();
});

// Cmd+Q / Dock Quit / Utils.quit() also have unsaved work kept first, and clean up synchronously when allowed.
Electrobun.events.on("before-quit", (event: ElectrobunEvent<{}, { allow: boolean }>) => {
	if (!backend.mayClose()) {
		event.response = { allow: false };
		return;
	}
	disposeOnce();
});

process.on("exit", disposeOnce);
