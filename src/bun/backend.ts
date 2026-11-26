// The BackendApi (src/shared/protocol.ts), whichever host carries it.
import { openInSystemApp, revealPathInFileManager, systemPrefersDark } from "./system";
import { homedir } from "node:os";
import { basename, dirname, extname, isAbsolute, join, relative, sep } from "node:path";
import { lstatSync, statSync } from "node:fs";
import type { BackendApi, BackendEvents, Info, LspState, Workspace } from "../shared/protocol";
import { linkWritten } from "../shared/docLinks";
import { htmlToMarkdown, openTags } from "../shared/htmlToMarkdown";
import { markdownToDocx, parseDocxToMarkdown } from "./docx";
import { decode } from "./encoding";
import { copyNotKept, History, historyNotKept } from "./history";
import { LspProcess } from "./lsp";
import { catalogFilesOf, docAudit, docsTruncated, EXPORT_TYPES, fileManifest, linksTo, listDocs, namesIn, readExport, readProject, setupProject, tomlProblem, undoSetup } from "./project";
import { recent, SettingsStore } from "./settings";
import { findLsp, findOpencode } from "./tools";
import { fileKey, WorkspaceFiles } from "./workspace";
import { Git } from "./git";
import { Agent } from "./agent";
import { formatDocument } from "./format";

const IMPORT_MAX_BYTES = 20 * 1024 * 1024;
const ALLOWED_IMPORT_EXTS = new Set([".docx", ".html", ".htm", ".md", ".markdown"]);
/**
 * How long the view has to answer a close that only text being typed stands in the way of, in milliseconds. It
 * answers in a few (it counts the unsaved files, or closes the app): one that has not by now will not.
 */
export const VIEW_ANSWERS_WITHIN = 2000;

/** Parses `SSL_STUDIO_OPENCODE` as a JSON string array when it starts with `[` (supporting spaces in paths), falling back to space-splitting. */
export function parseOpencodeCommandEnv(raw: string | undefined): string[] | undefined {
	if (!raw) return undefined;
	const trimmed = raw.trim();
	if (!trimmed) return undefined;
	if (trimmed.startsWith("[")) {
		try {
			const parsed = JSON.parse(trimmed);
			if (Array.isArray(parsed) && parsed.length > 0 && parsed.every((item) => typeof item === "string" && item.length > 0)) {
				return parsed;
			}
		} catch {
			// Fall back to space-delimited parsing when not valid JSON.
		}
	}
	return trimmed.split(/\s+/);
}

function pathTaken(p: string): boolean {
	try {
		lstatSync(p);
		return true;
	} catch {
		return false;
	}
}

function decodeBase64Capped(base64: string, maxBytes: number, label: string): Uint8Array {
	const raw = base64 ?? "";
	const maxB64 = Math.ceil((maxBytes * 4) / 3) + 4;
	if (raw.length > maxB64 * 2) {
		throw new Error(`${label} is too large to import (maximum is 20 MB).`);
	}
	const compact = /\s/.test(raw) ? raw.replace(/\s+/g, "") : raw;
	const pad = compact.endsWith("==") ? 2 : compact.endsWith("=") ? 1 : 0;
	const estimated = Math.floor((compact.length * 3) / 4) - pad;
	if (estimated > maxBytes) {
		throw new Error(`${label} is too large to import (maximum is 20 MB).`);
	}
	const bytes = Uint8Array.from(Buffer.from(compact, "base64"));
	if (bytes.byteLength > maxBytes) {
		throw new Error(`${label} is too large to import (maximum is 20 MB).`);
	}
	return bytes;
}

export type Host = {
	emit<K extends keyof BackendEvents>(event: K, payload: BackendEvents[K]): void;
	/** A native folder or file dialog; null when cancelled or unavailable. */
	pick(kind: "folder" | "file", types?: string): Promise<string | null>;
	trash(path: string): Promise<void>;
	clipboard?(text: string): void;
	/** When true (or when kind === "browser"), restrict readExport and importDocFile sourcePath to the open workspace. */
	restrictPaths?: boolean;
	isWebHost?: boolean;
	app: string;
	kind: "app" | "browser";
	quit(): void;
};

export function createBackend(host: Host, initial?: string) {
	let files: WorkspaceFiles | null = null;
	let history: History | null = null;
	let lsp: LspProcess | null = null;
	let lspPath = "";
	let lspRestartSeq = 0;
	let info: Info | null = null;
	let infoSeq = 0;
	let lspState: LspState = { state: "stopped" };
	let openSeq = 0;
	let closing = false;
	let disposed = false;

	const restricted = () => host.kind === "browser" || Boolean(host.restrictPaths) || Boolean(host.isWebHost);

	const emitLspState = (state: LspState) => {
		lspState = state;
		host.emit("lspState", state);
	};
	const settings = new SettingsStore(() => files?.root ?? null);
	// SSL_STUDIO_OPENCODE replaces the opencode command (tests use test/fake-opencode.ts).
	const command = parseOpencodeCommandEnv(process.env.SSL_STUDIO_OPENCODE);
	const agent = new Agent((type, data) => host.emit("agent", { type, data }), () => files?.root ?? null, command);

	const need = () => {
		if (!files) throw new Error("no workspace open");
		return files;
	};
	const rejectRoot = (ws: WorkspaceFiles, full: string, action: string) => {
		if (fileKey(full) === fileKey(ws.root)) {
			throw new Error(`cannot ${action} the workspace root`);
		}
	};
	/** git for the open workspace: one for as long as the folder is open, so that what it learned of the repository is asked once. */
	let asked: { root: string; git: Git } | null = null;
	const git = () => {
		const root = need().root;
		if (asked?.root !== root) {
			asked?.git.dispose();
			asked = { root, git: new Git(root) };
		}
		return asked.git;
	};
	/** Validates a path inside the workspace, or (for staged rename `from` paths in a subdir repo) inside the enclosing git repo. */
	const insideWorkspaceOrStagedRenameSource = async (ws: WorkspaceFiles, g: Git, path: string): Promise<string> => {
		try {
			return ws.inside(path);
		} catch (err) {
			if (await g.isStagedRenameSource(path)) {
				return g.insideRepo(path);
			}
			throw err;
		}
	};
	/** What keeping local history last failed with, so that it is said once and not at every save; null while it works. */
	let historyFailed: string | null = null;
	/**
	 * Local history of a file that has just been written. The file is on disk by then, and that is what the save
	 * answers: where the snapshot could not be kept (the history folder full, or not to be written), the save was
	 * reported as failed with the file written, and its tab stayed unsaved. The failure goes to the log, and to the
	 * person as a notice: with the log alone nobody at the window knew that the copies a discard or a look at the
	 * History panel counts on were not being made. Once for a cause, and again when it comes back after history was
	 * kept in between.
	 */
	const keepWritten = async (hist: History, full: string, text: string) => {
		try {
			// A snapshot that was written shows the folder takes them again. One that was passed over (the same text as
			// the last, a text too large to keep) wrote nothing, and shows nothing.
			if (await hist.record(full, text)) historyFailed = null;
		} catch (e: any) {
			const why = String(e?.code ?? e?.message ?? e);
			if (why !== historyFailed) {
				console.error(`Local history is not being kept (${full} was saved, its snapshot was not): ${e?.message ?? e}`);
				host.emit("notice", { kind: "error", text: historyNotKept(hist.base, basename(full), String(e?.message ?? e)) });
			}
			historyFailed = why;
		}
	};
	/** How many open files have edits that are not on disk, as the view last said. */
	let unsaved = 0;
	/**
	 * Whether a view is open that may hold text still being typed, as the view last said (a table's open cell, a
	 * field of a plan step). That text is in no document until the view puts it there, so the count above is 0 for
	 * it: the window closed at once on that count, and the text went with it, unasked.
	 */
	let typing = false;
	/** When the view was asked about a close that only such text stood in the way of, and has said nothing since; 0 otherwise. */
	let askedOfTyping = 0;

	async function loadInfo(): Promise<Info> {
		const seq = ++infoSeq;
		const { effective } = await settings.load();
		const [lspStatus, opencode, systemDark] = await Promise.all([findLsp(effective.lspPath), findOpencode(), systemPrefersDark()]);
		const next: Info = { systemDark, app: host.app, lsp: lspStatus, opencode, host: host.kind, selftest: Boolean(process.env.SSL_STUDIO_SELFTEST), selftestCycle: Boolean(process.env.SSL_STUDIO_SELFTEST_CYCLE), selftestClose: Boolean(process.env.SSL_STUDIO_SELFTEST_CLOSE) };
		if (!disposed && seq === infoSeq) info = next;
		return next;
	}

	async function open(path: string): Promise<Workspace> {
		if (disposed) throw new Error("backend is disposed");
		// Validate and construct BEFORE tearing down the active workspace so a bad path leaves it intact.
		const nextFiles = new WorkspaceFiles(path);
		const nextHistory = new History(nextFiles.root);
		const seq = ++openSeq;

		const prevFiles = files;
		const prevLsp = lsp;
		const prevAsked = asked;
		files = nextFiles;
		history = nextHistory;
		lsp = null;
		lspPath = "";
		const restartSeq = ++lspRestartSeq;
		asked = null;
		prevFiles?.close();
		prevLsp?.stop();
		if (prevLsp || lspState.state !== "stopped") emitLspState({ state: "stopped" });
		prevAsked?.git.dispose();

		const isStale = () => disposed || seq !== openSeq;
		nextFiles.watch((changed) => {
			if (!isStale()) host.emit("fileChanged", { path: changed });
		});

		let startedLsp: LspProcess | null = null;
		// From here the folder is open: the files, the history and the watcher are the new folder's and the old one's
		// are closed. So nothing below fails the open, unless a later open has overtaken it. Each step that can fail
		// says so in its own place (the log, the language server's state), and the view is told of the folder the
		// backend is on. The list of recent folders used to fail it: where the list could not be written (a state
		// folder that is full, or read-only) the view stayed on the old folder with the backend on the new one, every
		// save "outside the workspace".
		try {
			await recent(nextFiles.root).catch((e) => console.error(`The list of recent folders was not written: ${e?.message ?? e}`));
			if (isStale()) {
				nextFiles.close();
				return { root: nextFiles.root, name: basename(nextFiles.root) };
			}
			if (restartSeq === lspRestartSeq) {
				const { lsp: status } = await loadInfo().catch((e): Pick<Info, "lsp"> => ({ lsp: { ok: false, message: `The language server was not looked for: ${e?.message ?? e}` } }));
				if (isStale()) {
					nextFiles.close();
					return { root: nextFiles.root, name: basename(nextFiles.root) };
				}
				if (restartSeq === lspRestartSeq) {
					if (status.ok && status.path) {
						const nextLsp = new LspProcess(
							status.path,
							(m) => {
								if (!isStale() && lsp === nextLsp) host.emit("lsp", m);
							},
							(s) => {
								if (!isStale() && lsp === nextLsp) emitLspState(s);
							},
						);
						startedLsp = nextLsp;
						lsp = nextLsp;
						lspPath = status.path;
						nextLsp.start();
					} else {
						emitLspState({ state: "failed", message: status.message });
					}
				}
			}
			await agent.workspaceChanged().catch((e) => console.error(`The agent's sessions of the folder before were not ended: ${e?.message ?? e}`));
			if (isStale()) {
				nextFiles.close();
				startedLsp?.stop();
				return { root: nextFiles.root, name: basename(nextFiles.root) };
			}
			return { root: nextFiles.root, name: basename(nextFiles.root) };
		} catch (e) {
			if (isStale()) {
				nextFiles.close();
				startedLsp?.stop();
				throw e;
			}
			// What is left to fail is the start of the language server: said as its state, with the folder open.
			console.error(e);
			if (lsp === startedLsp) emitLspState({ state: "failed", message: `The language server was not started: ${(e as any)?.message ?? e}` });
			return { root: nextFiles.root, name: basename(nextFiles.root) };
		}
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
			const ws = need();
			const out: Record<string, number> = {};
			for (const path of paths) {
				try {
					out[path] = statSync(ws.inside(path)).size;
				} catch {
					// Outside the workspace or gone.
				}
			}
			return out;
		},
		write: async (path, text, asText) => {
			const ws = need();
			const hist = history!;
			const full = ws.inside(path);
			return ws.alone(full, async (writeNow) => {
				const result = await writeNow(text, asText);
				await keepWritten(hist, full, text);
				return result;
			});
		},
		create: (path, kind) => need().create(path, kind),
		rename: async (from, to) => need().rename(from, to),
		copy: async (from, to) => need().copy(from, to),
		image: (path) => need().image(path),
		writeImage: (path, base64) => need().writeImage(path, base64),
		historyKeep: async (path) => {
			const ws = need();
			const hist = history!;
			const full = ws.inside(path);
			const now = await ws.read(full);
			// Kept whatever its size: this is asked for before something writes over the file, and is then its way back.
			if (!now.binary) await hist.keep(full, now.text);
		},
		gitStatus: async () => (files ? git().status() : null),
		gitBase: async (path, from) => {
			const ws = need();
			const g = git();
			return g.base(await insideWorkspaceOrStagedRenameSource(ws, g, path), from);
		},
		gitLog: async (path, limit) => (files ? git().log(need().inside(path), limit) : []),
		gitTicketLog: (ticketKey, limit) => (files ? git().ticketLog(ticketKey, limit) : Promise.resolve([])),
		gitShow: async (path, sha, repoPath) => (files ? git().show(need().inside(path), sha, repoPath) : null),
		gitDiff: async (options) => {
			if (!files) return "";
			const ws = need();
			const scoped = options?.paths?.length ? { ...options, paths: options.paths.map((p) => ws.inside(p)) } : options;
			return git().diff(scoped);
		},
		gitTags: () => (files ? git().tags() : Promise.resolve([])),
		gitHeadSha: () => (files ? git().headSha() : Promise.resolve(null)),
		gitRangeLog: (from, to, limit) => (files ? git().rangeLog(from, to, limit) : Promise.resolve([])),
		gitCommitFile: async (path, sha, repoPath) => (files ? git().commitFile(need().inside(path), sha, repoPath) : { before: null, after: null }),
		gitBlameLine: async (path, line) => (files ? git().blameLine(need().inside(path), line) : null),
		gitBranches: () => (files ? git().branches() : Promise.resolve(null)),
		gitCheckout: (branch) => (files ? git().checkout(branch) : Promise.resolve({ ok: false, message: "No workspace open." })),
		gitStash: (action, message) => (files ? git().stash(action, message) : Promise.resolve({ ok: false, message: "No workspace open." })),
		gitStage: async (paths) => git().stage(paths.map((path) => need().inside(path))),
		gitUnstage: async (paths) => {
			const ws = need();
			const g = git();
			const validated = await Promise.all(paths.map((path) => insideWorkspaceOrStagedRenameSource(ws, g, path)));
			return g.unstage(validated);
		},
		gitCommit: (message) => git().commit(message),
		// A discard and a trash wait for a save of the file that is under way, and the saves asked for after them
		// wait in turn: thrown away in the middle of a save, the file would have come back.
		gitDiscard: async (path) => {
			const ws = need();
			const hist = history!;
			const full = ws.inside(path);
			rejectRoot(ws, full, "discard");
			await ws.alone(full, async () => {
				// A file git does not follow has nothing to go back to: it goes to the trash, not out of existence.
				const followed = await git().follows(full);
				// What is about to go is kept first, where it is text and whatever its size: a discard by mistake has a
				// way back. For a file git follows that copy is the only way back, so where it cannot be made nothing is
				// discarded: the discard used to go on without it, having said that the file is kept. A file that goes
				// to the trash is still there, and goes whether or not its copy was made.
				let text: string | null = null;
				try {
					const now = await ws.read(full);
					if (!now.binary) text = now.text;
				} catch (e: any) {
					// Not there to read (it was removed): there is nothing of it to keep.
					if (followed && e?.code !== "ENOENT") throw new Error(copyNotKept(basename(full), String(e?.message ?? e)));
				}
				if (text !== null) {
					await hist.keep(full, text).catch((e: any) => {
						if (followed) throw new Error(copyNotKept(basename(full), String(e?.message ?? e)));
					});
				}
				if (followed) await git().discard(full);
				else await host.trash(full);
			});
		},
		trash: async (path) => {
			const ws = need();
			const full = ws.inside(path);
			rejectRoot(ws, full, "trash");
			await ws.alone(full, () => host.trash(full));
		},
		search: (query, options) => need().search(query, options),
		searchScan: (query, options, open) => need().searchScan(query, options, open),
		replace: async (query, replacement, options, paths) => {
			const ws = need();
			const hist = history!;
			const done: { path: string; count: number; error?: string; skippedProtected?: number; invalidJson?: boolean; changed?: boolean }[] = [];
			for (const path of paths) {
				// One file that cannot be written (its encoding has no way to write the replacement, say) does not
				// stop the others: it is left as it was, and says why.
				try {
					const full = ws.inside(path);
					// Read and written as one step: a save of the file that landed between the two would have been
					// written away by text worked out from the file as it was before it. Whether the file is still the
					// text that was searched (`asSearched`) is looked at in the same step, for the same reason.
					const outcome = await ws.alone(full, async (write) => {
						const change = await ws.replaced(path, query, replacement, options);
						if (!change) return null;
						if (change.changed) return { count: 0, changed: true };
						if (change.invalidJson || !change.count) {
							return { count: 0, skippedProtected: change.skippedProtected, invalidJson: change.invalidJson };
						}
						// The file as it was goes into local history first, so that there is a way back.
						await hist.keep(full, change.before);
						await write(change.after, false);
						await keepWritten(hist, full, change.after);
						return { count: change.count, skippedProtected: change.skippedProtected, invalidJson: false };
					});
					if (outcome && "changed" in outcome) done.push({ path: full, count: 0, changed: true });
					else if (outcome && (outcome.count || outcome.skippedProtected || outcome.invalidJson)) {
						done.push({
							path: full,
							count: outcome.count,
							...(outcome.skippedProtected ? { skippedProtected: outcome.skippedProtected } : {}),
							...(outcome.invalidJson ? { invalidJson: true } : {}),
						});
					}
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
			if (closing) return;
			askedOfTyping = 0;
			unsaved = Math.max(0, Number(count) || 0);
		},
		typingChanged: async (held) => {
			if (closing) return;
			askedOfTyping = 0;
			typing = held === true;
		},
		closeWindow: async () => {
			closing = true;
			unsaved = 0;
			setTimeout(() => host.quit(), 50);
		},
		docs: async (options) => {
			const ws = need();
			const effective = options?.templatesFolder !== undefined ? options.templatesFolder : (await settings.load()).effective.templatesFolder;
			return listDocs(ws, await readProject(ws.root), { templatesFolder: effective });
		},
		docsTruncated: async () => {
			const ws = need();
			const effective = (await settings.load()).effective.templatesFolder;
			return docsTruncated(ws, await readProject(ws.root), { templatesFolder: effective });
		},
		docAudit: async (attachmentsFolder, options) => {
			const ws = need();
			const effective = options?.templatesFolder !== undefined ? options.templatesFolder : (await settings.load()).effective.templatesFolder;
			return docAudit(ws, await readProject(ws.root), attachmentsFolder, { ...options, templatesFolder: effective });
		},
		openExternal: async (path) => {
			const full = need().inside(path);
			await openInSystemApp(full);
		},
		revealInFileManager: async (path) => {
			const full = need().inside(path);
			await revealPathInFileManager(full);
		},
		exportDocx: async (request) => {
			const ws = need();
			const full = ws.inside(request.path);
			if (extname(full).toLowerCase() !== ".docx") {
				throw new Error(`Export path must end with .docx: ${relative(ws.root, full)}`);
			}
			const baseDir = request.baseDir ? ws.inside(request.baseDir) : dirname(full);
			const opts: Parameters<typeof markdownToDocx>[0] & {
				attachmentsFolder?: string;
				docsFolder?: string;
				rasterizedImages?: Record<string, string>;
				toc?: boolean;
				headerFooter?: boolean;
			} = {
				title: request.title,
				subtitle: request.subtitle,
				markdown: request.markdown,
				baseDir,
				workspaceRoot: ws.root,
				meta: request.meta,
				mermaidPngs: request.mermaidPngs,
				...(request.attachmentsFolder !== undefined ? { attachmentsFolder: request.attachmentsFolder } : {}),
				...(request.docsFolder !== undefined ? { docsFolder: request.docsFolder } : {}),
				...(request.rasterizedImages !== undefined ? { rasterizedImages: request.rasterizedImages } : {}),
				...(request.toc !== undefined ? { toc: request.toc } : {}),
				...(request.headerFooter !== undefined ? { headerFooter: request.headerFooter } : {}),
			};
			const bytes = markdownToDocx(opts);
			const written = await ws.writeBytes(full, bytes);
			return { path: written.path, bytes: written.size };
		},
		importDocFile: async (request) => {
			const ws = need();
			const hist = history!;
			const rawSrc = request.sourcePath?.trim() || (await host.pick("file", "docx,html,htm,md,markdown"));
			if (!rawSrc) return null;
			const src = restricted() ? ws.inside(rawSrc) : rawSrc;
			const ext = extname(src).toLowerCase();
			if (!ALLOWED_IMPORT_EXTS.has(ext)) {
				throw new Error(`Unsupported document format: ${ext || "(none)"}. Only .docx, .html, .htm, .md, and .markdown files can be imported.`);
			}
			let srcStat;
			try {
				srcStat = statSync(src);
			} catch (e: any) {
				throw new Error(`Cannot read ${src}: ${e?.message ?? e}`);
			}
			if (!srcStat.isFile()) {
				throw new Error(`${src} is not a regular file.`);
			}
			if (srcStat.size > IMPORT_MAX_BYTES) {
				throw new Error(`${basename(src)} is too large to import (maximum is 20 MB).`);
			}

			const destDir = ws.inside(request.destDir);
			const attachDir = request.attachmentsDir ? ws.inside(request.attachmentsDir) : ws.inside(join(ws.root, "docs", "attachments"));
			const kind: "docx" | "html" | "md" = ext === ".docx" ? "docx" : ext === ".html" || ext === ".htm" ? "html" : "md";
			const rawStem = basename(src, extname(src)).replace(/[\\/:*?"<>|]+/g, "-").trim() || "imported";
			const baseDestPath = ws.inside(join(destDir, `${rawStem}.md`));
			const mode = request.onConflict ?? "copy";

			const reserveUniquePath = (dir: string, stem: string, fileExt: string, reserved?: Set<string>): string => {
				let candidate = ws.inside(join(dir, `${stem}${fileExt}`));
				let n = 2;
				while (pathTaken(candidate) || reserved?.has(candidate.toLowerCase())) {
					candidate = ws.inside(join(dir, `${stem}-${n}${fileExt}`));
					n++;
				}
				reserved?.add(candidate.toLowerCase());
				return candidate;
			};

			// A Word document is read before anything is asked or touched. A file that is not one (an old .doc under
			// the name, one behind a password, half a download) used to import as an empty document, and with
			// Overwrite it took the place of the Markdown that was there, after a history snapshot nobody asked for.
			const docx = kind === "docx" ? (parseDocxToMarkdown(new Uint8Array(await Bun.file(src).arrayBuffer()), basename(src)) as ReturnType<typeof parseDocxToMarkdown> & { warnings?: string[] }) : null;

			let destPath = baseDestPath;
			if (pathTaken(baseDestPath)) {
				if (mode === "prompt") {
					return { path: baseDestPath, images: [], kind, conflict: true, existingPath: baseDestPath, sourcePath: src };
				}
				if (mode === "copy") {
					destPath = reserveUniquePath(destDir, rawStem, ".md");
				} else if (mode === "overwrite") {
					try {
						const before = await ws.read(baseDestPath);
						if (!before.binary) await hist.record(baseDestPath, before.text);
					} catch {
						// Ignore if unreadable before snapshot.
					}
				}
			}

			const savedImages: string[] = [];
			const reservedImgs = new Set<string>();
			if (docx) {
				const parsed = docx;
				let md = parsed.markdown;
				if (parsed.images.length) {
					for (const img of parsed.images) {
						const safeImg = `${rawStem}-${img.name.replace(/[^A-Za-z0-9._-]+/g, "-")}`;
						const imgExt = extname(safeImg);
						const imgStem = imgExt ? safeImg.slice(0, -imgExt.length) : safeImg;
						const imgPath = reserveUniquePath(attachDir, imgStem, imgExt, reservedImgs);
						const finalName = basename(imgPath);
						await ws.writeBytes(imgPath, img.bytes);
						savedImages.push(imgPath);
						md = md.split(`{{DOCX_IMG:${img.name}}}`).join(`![[${finalName}]]`);
					}
				}
				await ws.write(destPath, md.endsWith("\n") ? md : `${md}\n`);
				return { path: destPath, images: savedImages, kind: "docx", ...(parsed.warnings?.length ? { warnings: parsed.warnings } : {}) };
			}

			const rawBytes = new Uint8Array(await Bun.file(src).arrayBuffer());
			const rawText = decode(rawBytes).text;
			if (kind === "html") {
				const DATA_SRC_RE =
					/(\bsrc\s*=\s*)(?:"data:image\/(png|jpeg|jpg|gif|webp|svg\+xml);base64,([^"]+)"|'data:image\/(png|jpeg|jpg|gif|webp|svg\+xml);base64,([^']+)'|data:image\/(png|jpeg|jpg|gif|webp|svg\+xml);base64,([^\s>]+))/i;
				const EXT_MAP: Record<string, string> = {
					png: ".png",
					jpeg: ".jpg",
					jpg: ".jpg",
					gif: ".gif",
					webp: ".webp",
					"svg+xml": ".svg",
				};
				let rewritten = "";
				let lastIdx = 0;
				let imgIdx = 0;
				// Each `<img …>` up to its ">", looked for once. As the pattern `<img\b[^>]*>`, every "<img " of a page with
				// no ">" left was read to the end of the page: 100 KB of them took seven seconds, 400 KB over a minute,
				// and a save asked for in that time waited (the backend has one thread).
				for (const m of openTags(rawText, "img")) {
					const idx = m.index;
					const tag = m.tag;
					rewritten += rawText.slice(lastIdx, idx);
					const srcMatch = DATA_SRC_RE.exec(tag);
					if (srcMatch) {
						const subtype = (srcMatch[2] ?? srcMatch[4] ?? srcMatch[6] ?? "png").toLowerCase();
						const b64 = (srcMatch[3] ?? srcMatch[5] ?? srcMatch[7] ?? "").replace(/\s+/g, "");
						const imgExt = EXT_MAP[subtype] ?? ".png";
						const imgPath = reserveUniquePath(attachDir, `${rawStem}-image-${++imgIdx}`, imgExt, reservedImgs);
						const imgBytes = decodeBase64Capped(b64, IMPORT_MAX_BYTES, basename(imgPath));
						await ws.writeBytes(imgPath, imgBytes);
						savedImages.push(imgPath);
						const relImg = linkWritten(relative(dirname(destPath), imgPath).split(sep).join("/"));
						const updatedTag = `${tag.slice(0, srcMatch.index)}${srcMatch[1]}"${relImg}"${tag.slice(srcMatch.index + srcMatch[0].length)}`;
						rewritten += updatedTag;
					} else {
						rewritten += tag;
					}
					lastIdx = idx + tag.length;
				}
				rewritten += rawText.slice(lastIdx);
				const md = htmlToMarkdown(rewritten);
				await ws.write(destPath, md.endsWith("\n") ? md : `${md}\n`);
				return { path: destPath, images: savedImages, kind: "html" };
			}
			await ws.write(destPath, rawText.endsWith("\n") ? rawText : `${rawText}\n`);
			return { path: destPath, images: [], kind: "md" };
		},
		importDocxBytes: async (request) => {
			const ws = need();
			const hist = history!;
			const bytes = decodeBase64Capped(request.base64, IMPORT_MAX_BYTES, request.fileName || "document.docx");
			const destDir = ws.inside(request.destDir);
			const attachDir = request.attachmentsDir ? ws.inside(request.attachmentsDir) : ws.inside(join(ws.root, "docs", "attachments"));
			const ext = extname(request.fileName);
			const rawStem = basename(request.fileName, ext).replace(/[\\/:*?"<>|]+/g, "-").trim() || "imported";
			const baseDestPath = ws.inside(join(destDir, `${rawStem}.md`));
			const mode = request.onConflict ?? "copy";

			const reserveUniquePath = (dir: string, stem: string, fileExt: string, reserved?: Set<string>): string => {
				let candidate = ws.inside(join(dir, `${stem}${fileExt}`));
				let n = 2;
				while (pathTaken(candidate) || reserved?.has(candidate.toLowerCase())) {
					candidate = ws.inside(join(dir, `${stem}-${n}${fileExt}`));
					n++;
				}
				reserved?.add(candidate.toLowerCase());
				return candidate;
			};

			// Read before anything is asked or touched, as in `importDocFile`: what is not a Word document fails here.
			const parsed = parseDocxToMarkdown(bytes, request.fileName || "document.docx") as ReturnType<typeof parseDocxToMarkdown> & { warnings?: string[] };

			let destPath = baseDestPath;
			if (pathTaken(baseDestPath)) {
				if (mode === "prompt") {
					return { path: baseDestPath, images: [], conflict: true, existingPath: baseDestPath };
				}
				if (mode === "copy") {
					destPath = reserveUniquePath(destDir, rawStem, ".md");
				} else if (mode === "overwrite") {
					try {
						const before = await ws.read(baseDestPath);
						if (!before.binary) await hist.record(baseDestPath, before.text);
					} catch {
						// Ignore if unreadable before snapshot.
					}
				}
			}

			let md = parsed.markdown;
			const savedImages: string[] = [];
			const reservedImgs = new Set<string>();
			if (parsed.images.length) {
				for (const img of parsed.images) {
					const safeImg = `${rawStem}-${img.name.replace(/[^A-Za-z0-9._-]+/g, "-")}`;
					const imgExt = extname(safeImg);
					const imgStem = imgExt ? safeImg.slice(0, -imgExt.length) : safeImg;
					const imgPath = reserveUniquePath(attachDir, imgStem, imgExt, reservedImgs);
					const finalName = basename(imgPath);
					await ws.writeBytes(imgPath, img.bytes);
					savedImages.push(imgPath);
					md = md.split(`{{DOCX_IMG:${img.name}}}`).join(`![[${finalName}]]`);
				}
			}
			await ws.write(destPath, md.endsWith("\n") ? md : `${md}\n`);
			return { path: destPath, images: savedImages, ...(parsed.warnings?.length ? { warnings: parsed.warnings } : {}) };
		},
		manifest: async () => fileManifest(need(), await readProject(need().root)),
		catalogFiles: async (area) => catalogFilesOf(need(), await readProject(need().root), area),
		tomlProblem: async (text) => tomlProblem(text),
		formatDocument: (request) => formatDocument(request, files?.root ?? null),
		linksTo: async (path) => linksTo(need(), path),
		namesIn: async () => namesIn(need()),
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
		readExport: async (path) => {
			if (restricted()) {
				let cleaned = path.trim().replace(/^(["'])(.*)\1$/, "$2");
				if (/^~[\\/]/.test(cleaned)) cleaned = join(homedir(), cleaned.slice(2));
				if (!isAbsolute(cleaned)) throw new Error(`${path} is not a whole path.`);
				need().inside(cleaned);
			}
			return readExport(path);
		},
		lspSend: async (message) => lsp?.send(message),
		lspRestart: async () => {
			if (disposed) return;
			const seq = openSeq;
			const restartSeq = ++lspRestartSeq;
			const isStale = () => disposed || seq !== openSeq || restartSeq !== lspRestartSeq;
			const { lsp: status } = await loadInfo();
			if (isStale() || !files) return;
			if (!status.ok || !status.path) {
				const prev = lsp;
				lsp = null;
				lspPath = "";
				prev?.stop();
				emitLspState({ state: "failed", message: status.message });
				return;
			}
			if (lsp && lspPath === status.path) {
				lsp.restart();
				return;
			}
			const prev = lsp;
			lsp = null;
			lspPath = "";
			if (prev) {
				prev.stop();
				emitLspState({ state: "stopped" });
			}
			const nextLsp = new LspProcess(
				status.path,
				(m) => {
					if (!disposed && seq === openSeq && lsp === nextLsp) host.emit("lsp", m);
				},
				(s) => {
					if (!disposed && seq === openSeq && lsp === nextLsp) emitLspState(s);
				},
			);
			lsp = nextLsp;
			lspPath = status.path;
			nextLsp.start();
		},
		lspState: async () => lspState,
		agent: async (method, args) => {
			const { effective, user } = await settings.load();
			const confirmedModels = typeof user.agentModel === "string" && user.agentModel.trim() ? [user.agentModel.trim()] : [];
			agent.configure({
				serverConfig: effective.agentServerConfig,
				serverUrl: effective.agentServerUrl,
				model: effective.agentModel,
				ownModels: effective.agentOwnModels,
				confirmedModels,
			});
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
			// The run is over and nobody is there to answer, so what it left unsaved is not asked about, as it is not after
			// "Discard changes". The long run leaves two files unsaved (the plan it rebuilt, and the script built from
			// it): its quit was refused, and the app stood with the question until the runner's time limit stopped it,
			// whether its steps had passed or not.
			closing = true;
			unsaved = 0;
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
		 *
		 * The answer is also no while a view may hold text still being typed: this cannot wait for the view, so the
		 * count it answers from is the one from before that text is in its document. The view puts it there and counts
		 * again: with nothing unsaved then, it closes the app at once and asks nothing. With no such view open the
		 * window closes on the count as before, without that detour.
		 */
		mayClose: () => {
			if (closing || (!unsaved && !typing)) return true;
			if (!unsaved) {
				// Nothing is unsaved by the count, and the view was asked about this a while ago and has said nothing
				// since: it is not there to answer (it crashed, or hangs). The window is let go on a second request,
				// as it was on the first before typed text was asked about at all.
				if (askedOfTyping && Date.now() - askedOfTyping > VIEW_ANSWERS_WITHIN) return true;
				askedOfTyping ||= Date.now();
			}
			host.emit("closeRequested", {});
			return false;
		},
		dispose: () => {
			if (disposed) return;
			disposed = true;
			openSeq++;
			lspRestartSeq++;
			infoSeq++;
			info = null;
			files?.close();
			files = null;
			lsp?.stop();
			lsp = null;
			lspPath = "";
			asked?.git.dispose();
			asked = null;
			agent.dispose();
		},
	};
}

/** Runs one call from the UI and returns a reply, errors included. */
export async function dispatch(api: BackendApi, method: string, args: unknown[]) {
	if (typeof method !== "string" || !Object.hasOwn(api, method)) {
		throw new Error(`unknown method: ${String(method)}`);
	}
	if (!Array.isArray(args)) {
		throw new Error(`invalid arguments for ${method}`);
	}
	const fn = (api as unknown as Record<string, unknown>)[method];
	if (typeof fn !== "function") throw new Error(`unknown method: ${method}`);
	return fn(...args);
}
