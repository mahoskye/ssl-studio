// The BackendApi (src/shared/protocol.ts), whichever host carries it.
import { systemPrefersDark } from "./system";
import { basename } from "node:path";
import { statSync } from "node:fs";
import type { BackendApi, BackendEvents, Info, LspState, Workspace } from "../shared/protocol";
import { History } from "./history";
import { LspProcess } from "./lsp";
import { EXPORT_TYPES, fileManifest, linksTo, listDocs, readExport, readProject, setupProject, tomlProblem, undoSetup } from "./project";
import { recent, SettingsStore } from "./settings";
import { findLsp, findOpencode } from "./tools";
import { WorkspaceFiles } from "./workspace";
import { Git } from "./git";
import { Agent } from "./agent";

export type Host = {
	emit<K extends keyof BackendEvents>(event: K, payload: BackendEvents[K]): void;
	/** A native folder or file dialog; null when cancelled or unavailable. */
	pick(kind: "folder" | "file", types?: string): Promise<string | null>;
	trash(path: string): Promise<void>;
	clipboard?(text: string): void;
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
	// SSL_STUDIO_OPENCODE replaces the opencode command (tests use test/fake-opencode.ts).
	const command = process.env.SSL_STUDIO_OPENCODE?.split(" ");
	const agent = new Agent((type, data) => host.emit("agent", { type, data }), () => files?.root ?? null, command);

	const need = () => {
		if (!files) throw new Error("no workspace open");
		return files;
	};
	/** How many open files have edits that are not on disk, as the view last said. */
	let unsaved = 0;

	async function loadInfo(): Promise<Info> {
		const { effective } = await settings.load();
		const [lspStatus, opencode, systemDark] = await Promise.all([findLsp(effective.lspPath), findOpencode(), systemPrefersDark()]);
		info = { systemDark, app: host.app, lsp: lspStatus, opencode, host: host.kind, selftest: Boolean(process.env.SSL_STUDIO_SELFTEST), selftestCycle: Boolean(process.env.SSL_STUDIO_SELFTEST_CYCLE), selftestClose: Boolean(process.env.SSL_STUDIO_SELFTEST_CLOSE) };
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
		sizes: async (paths) => {
			const out: Record<string, number> = {};
			for (const path of paths) {
				try {
					out[path] = statSync(need().inside(path)).size;
				} catch {
					// Outside the workspace or gone.
				}
			}
			return out;
		},
		write: async (path, text, asText) => {
			const result = await need().write(path, text, asText);
			await history!.record(need().inside(path), text);
			return result;
		},
		create: (path, kind) => need().create(path, kind),
		rename: async (from, to) => need().rename(from, to),
		copy: async (from, to) => need().copy(from, to),
		image: (path) => need().image(path),
		gitStatus: async () => (files ? new Git(files.root).status() : null),
		gitBase: (path, from) => new Git(need().root).base(need().inside(path), from),
		gitStage: (paths) => new Git(need().root).stage(paths.map((path) => need().inside(path))),
		gitUnstage: (paths) => new Git(need().root).unstage(paths.map((path) => need().inside(path))),
		gitCommit: (message) => new Git(need().root).commit(message),
		gitDiscard: async (path) => {
			const full = need().inside(path);
			const git = new Git(need().root);
			// What is about to go is kept first, where it is text: a discard by mistake has a way back.
			try {
				const now = await need().read(full);
				if (!now.binary) await history!.record(full, now.text);
			} catch {
				// Not there to read (it was removed): there is nothing of it to keep.
			}
			// A file git does not follow has nothing to go back to: it goes to the trash, not out of existence.
			if (await git.follows(full)) await git.discard(full);
			else await host.trash(full);
		},
		trash: async (path) => host.trash(need().inside(path)),
		search: (query, options) => need().search(query, options),
		replace: async (query, replacement, options, paths) => {
			const done: { path: string; count: number; error?: string }[] = [];
			for (const path of paths) {
				// One file that cannot be written (its encoding has no way to write the replacement, say) does not
				// stop the others: it is left as it was, and says why.
				try {
					const full = need().inside(path);
					const change = await need().replaced(full, query, replacement, options);
					if (!change) continue;
					// The file as it was goes into local history first, so that there is a way back.
					await history!.record(full, change.before);
					await need().write(full, change.after);
					await history!.record(full, change.after);
					done.push({ path: full, count: change.count });
				} catch (e: any) {
					done.push({ path, count: 0, error: String(e?.message ?? e) });
				}
			}
			return done;
		},
		history: async (path) => history?.list(need().inside(path)) ?? [],
		snapshot: (path, id) => history!.read(need().inside(path), id),
		project: async () => readProject(need().root),
		setupProject: async () => setupProject(need().root),
		setupPreview: async () => setupProject(need().root, true),
		setupUndo: async () => undoSetup(need().root),
		unsavedChanged: async (count) => {
			unsaved = Math.max(0, Number(count) || 0);
		},
		closeWindow: async () => {
			unsaved = 0;
			setTimeout(() => host.quit(), 50);
		},
		docs: async () => listDocs(need(), await readProject(need().root)),
		manifest: async () => fileManifest(need(), await readProject(need().root)),
		tomlProblem: async (text) => tomlProblem(text),
		linksTo: async (path) => linksTo(need(), path),
		settings: () => settings.load(),
		saveSettings: (scope, patch) => settings.save(scope, patch),
		themes: () => settings.themes(),
		importTheme: async () => {
			const path = await host.pick("file");
			return path ? settings.importTheme(path) : null;
		},
		// An export is read from where the person says it is: a download is not in the project's folder.
		pickExport: async () => {
			const path = await host.pick("file", EXPORT_TYPES);
			return path ? { path, text: await readExport(path) } : null;
		},
		readExport: async (path) => readExport(path),
		lspSend: async (message) => lsp?.send(message),
		lspRestart: async () => {
			if (lsp) lsp.restart();
			else if (files) await open(files.root);
		},
		lspState: async () => lspState,
		agent: async (method, args) => {
			const { effective } = await settings.load();
			agent.configure({ serverConfig: effective.agentServerConfig, serverUrl: effective.agentServerUrl, model: effective.agentModel, ownModels: effective.agentOwnModels });
			return agent.call(method, args);
		},
		clipboard: async (text) => {
			if (!host.clipboard) return false;
			host.clipboard(text);
			return true;
		},
		selftestNote: async (report) => {
			const path = process.env.SSL_STUDIO_SELFTEST;
			if (path) await Bun.write(path, JSON.stringify(report, null, 2) + "\n");
		},
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
		/**
		 * Asked when the window is about to close. With unsaved edits the answer is
		 * no, and the view is told to ask the user; it closes the app itself once
		 * they have saved or chosen to discard (ADR 0009).
		 */
		mayClose: () => {
			if (!unsaved) return true;
			host.emit("closeRequested", {});
			return false;
		},
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
