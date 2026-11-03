// The desktop app: one Electrobun window, the backend over Electrobun's RPC.
//
//   hutch run start [folder]
import { BrowserView, BrowserWindow, Screen, Utils } from "electrobun/main";
import type { ElectrobunRPCSchema, RPCSchema } from "electrobun/main";
import type { BackendEvents } from "../shared/protocol";
import { createBackend, dispatch } from "./backend";
import { fitWindow } from "./window";
import { homedir } from "node:os";

type Schema = {
	bun: RPCSchema<{ requests: { invoke: { params: { method: string; args: unknown[] }; response: unknown } }; messages: {} }>;
	webview: RPCSchema<{ requests: {}; messages: { event: { event: keyof BackendEvents; payload: unknown } } }>;
} & ElectrobunRPCSchema;

const folder = process.argv.slice(2).find((a) => !a.startsWith("-")) ?? process.env.SSL_STUDIO_FOLDER;

const backend = createBackend(
	{
		app: "0.1.0",
		kind: "app",
		quit: () => Utils.quit(),
		emit: (event, payload) => rpc.send.event({ event, payload }),
		pick: async (kind) => {
			const paths = await Utils.openFileDialog({
				startingFolder: homedir(),
				canChooseFiles: kind === "file",
				canChooseDirectory: kind === "folder",
				allowsMultipleSelection: false,
				allowedFileTypes: kind === "file" ? "json,jsonc" : "*",
			});
			return paths.find((p) => p) ?? null;
		},
		trash: async (path) => {
			Utils.moveToTrash(path);
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
			invoke: (params: unknown) => {
				const { method, args } = params as { method: string; args: unknown[] };
				return dispatch(backend.api, method, args);
			},
		},
	},
});

new BrowserWindow({
	title: "SSL Studio",
	url: "views://main/index.html",
	rpc,
	frame: fitWindow(Screen.getPrimaryDisplay().workArea),
});

process.on("exit", () => backend.dispose());
