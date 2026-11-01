// The BackendApi (src/shared/protocol.ts), whichever host carries it.
import { basename } from "node:path";
import type { BackendApi, BackendEvents, Info, LspState, Workspace } from "../shared/protocol";
import { History } from "./history";
import { LspProcess } from "./lsp";
import { recent, SettingsStore } from "./settings";
import { findLsp, findOpencode } from "./tools";
import { WorkspaceFiles } from "./workspace";
import { Agent } from "./agent";

export type Host = {
	emit<K extends keyof BackendEvents>(event: K, payload: BackendEvents[K]): void;
	/** A native folder or file dialog; null when cancelled or unavailable. */
	pick(kind: "folder" | "file"): Promise<string | null>;
	trash(path: string): Promise<void>;
	app: string;
	kind: "app" | "browser";
	quit(): void;
};

export function createBackend(host: Host, initial?: string) {
	let files: WorkspaceFiles | null = null;
	let history: History | null = null;
	let lsp: LspProcess | null = null;
	let info: Info | null = null;
	let lspState: LspState = { state: "stopped" };
	const emitLspState = (state: LspState) => {
		lspState = state;
		host.emit("lspState", state);
	};
	const settings = new SettingsStore(() => files?.root ?? null);
	const agent = new Agent((type, data) => host.emit("agent", { type, data }), () => files?.root ?? null);

	const need = () => {
		if (!files) throw new Error("no workspace open");
		return files;
	};

	async function loadInfo(): Promise<Info> {
		const { effective } = await settings.load();
		const [lspStatus, opencode] = await Promise.all([findLsp(effective.lspPath), findOpencode()]);
		info = { app: host.app, lsp: lspStatus, opencode, host: host.kind, selftest: Boolean(process.env.SSL_STUDIO_SELFTEST) };
		return info;
	}

	async function open(path: string): Promise<Workspace> {
		files?.close();
		lsp?.stop();
		files = new WorkspaceFiles(path);
		history = new History(files.root);
		await recent(files.root);
		files.watch((changed) => host.emit("fileChanged", { path: changed }));
		const { lsp: status } = await loadInfo();
		if (status.ok && status.path) {
			lsp = new LspProcess(status.path, (m) => host.emit("lsp", m), emitLspState);
			lsp.start();
		} else {
			emitLspState({ state: "failed", message: status.message });
		}
		await agent.workspaceChanged();
		return { root: files.root, name: basename(files.root) };
	}

	const api: BackendApi = {
		info: async () => info ?? loadInfo(),
		openFolder: async (path) => {
			const target = path ?? (await host.pick("folder"));
			return target ? open(target) : null;
		},
		workspace: async () => (files ? { root: files.root, name: basename(files.root) } : null),
		recent: () => recent(),
		list: async (dir) => need().list(dir),
		files: async () => {
			const all: string[] = [];
			for (const path of need().files()) if (all.push(path) >= 20_000) break;
			return all;
		},
		read: (path) => need().read(path),
		write: async (path, text) => {
			const result = await need().write(path, text);
			await history!.record(need().inside(path), text);
			return result;
		},
		create: (path, kind) => need().create(path, kind),
		rename: async (from, to) => need().rename(from, to),
		trash: async (path) => host.trash(need().inside(path)),
		search: (query, options) => need().search(query, options),
		history: async (path) => history?.list(need().inside(path)) ?? [],
		snapshot: (path, id) => history!.read(need().inside(path), id),
		settings: () => settings.load(),
		saveSettings: (scope, patch) => settings.save(scope, patch),
		themes: () => settings.themes(),
		importTheme: async () => {
			const path = await host.pick("file");
			return path ? settings.importTheme(path) : null;
		},
		lspSend: async (message) => lsp?.send(message),
		lspRestart: async () => {
			if (lsp) lsp.restart();
			else if (files) await open(files.root);
		},
		lspState: async () => lspState,
		agent: (method, args) => agent.call(method, args),
		selftestDone: async (report) => {
			const path = process.env.SSL_STUDIO_SELFTEST;
			if (!path) return;
			await Bun.write(path, JSON.stringify(report, null, 2) + "\n");
			setTimeout(() => host.quit(), 300);
		},
	};

	const ready = initial ? open(initial).catch((e) => console.error(e)) : Promise.resolve();
	return {
		api,
		ready,
		dispose: () => {
			files?.close();
			lsp?.stop();
			agent.dispose();
		},
	};
}

/** Runs one call from the UI and returns a reply, errors included. */
export async function dispatch(api: BackendApi, method: string, args: unknown[]) {
	const fn = (api as any)[method];
	if (typeof fn !== "function") throw new Error(`unknown method: ${method}`);
	return fn(...args);
}
