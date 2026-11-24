// The BackendApi (src/shared/protocol.ts), whichever host carries it.
import { openInSystemApp, revealPathInFileManager, systemPrefersDark } from "./system";
import { basename, dirname, extname, join, relative, sep } from "node:path";
import { existsSync, mkdirSync, statSync } from "node:fs";
import type { BackendApi, BackendEvents, Info, LspState, Workspace } from "../shared/protocol";
import { linkWritten } from "../shared/docLinks";
import { htmlToMarkdown } from "../shared/htmlToMarkdown";
import { markdownToDocx, parseDocxToMarkdown } from "./docx";
import { decode } from "./encoding";
import { History } from "./history";
import { LspProcess } from "./lsp";
import { catalogFilesOf, docAudit, docsTruncated, EXPORT_TYPES, fileManifest, linksTo, listDocs, namesIn, readExport, readProject, setupProject, tomlProblem, undoSetup } from "./project";
import { recent, SettingsStore } from "./settings";
import { findLsp, findOpencode } from "./tools";
import { WorkspaceFiles } from "./workspace";
import { Git } from "./git";
import { Agent } from "./agent";
import { formatDocument } from "./format";

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
	/** git for the open workspace: one for as long as the folder is open, so that what it learned of the repository is asked once. */
	let asked: { root: string; git: Git } | null = null;
	const git = () => {
		const root = need().root;
		if (asked?.root !== root) asked = { root, git: new Git(root) };
		return asked.git;
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
		writeImage: (path, base64) => need().writeImage(path, base64),
		historyKeep: async (path) => {
			const full = need().inside(path);
			const now = await need().read(full);
			if (!now.binary) await history!.record(full, now.text);
		},
		gitStatus: async () => (files ? git().status() : null),
		gitBase: (path, from) => git().base(need().inside(path), from),
		gitLog: (path, limit) => (files ? git().log(need().inside(path), limit) : Promise.resolve([])),
		gitTicketLog: (ticketKey, limit) => (files ? git().ticketLog(ticketKey, limit) : Promise.resolve([])),
		gitShow: (path, sha, repoPath) => (files ? git().show(need().inside(path), sha, repoPath) : Promise.resolve(null)),
		gitDiff: (options) => (files ? git().diff(options) : Promise.resolve("")),
		gitTags: () => (files ? git().tags() : Promise.resolve([])),
		gitHeadSha: () => (files ? git().headSha() : Promise.resolve(null)),
		gitRangeLog: (from, to, limit) => (files ? git().rangeLog(from, to, limit) : Promise.resolve([])),
		gitCommitFile: (path, sha, repoPath) => (files ? git().commitFile(need().inside(path), sha, repoPath) : Promise.resolve({ before: null, after: null })),
		gitBlameLine: (path, line) => (files ? git().blameLine(need().inside(path), line) : Promise.resolve(null)),
		gitBranches: () => (files ? git().branches() : Promise.resolve(null)),
		gitCheckout: (branch) => (files ? git().checkout(branch) : Promise.resolve({ ok: false, message: "No workspace open." })),
		gitStash: (action, message) => (files ? git().stash(action, message) : Promise.resolve({ ok: false, message: "No workspace open." })),
		gitStage: (paths) => git().stage(paths.map((path) => need().inside(path))),
		gitUnstage: (paths) => git().unstage(paths.map((path) => need().inside(path))),
		gitCommit: (message) => git().commit(message),
		// A discard and a trash wait for a save of the file that is under way, and the saves asked for after them
		// wait in turn: thrown away in the middle of a save, the file would have come back.
		gitDiscard: async (path) => {
			const full = need().inside(path);
			await need().alone(full, async () => {
				// What is about to go is kept first, where it is text: a discard by mistake has a way back.
				try {
					const now = await need().read(full);
					if (!now.binary) await history!.record(full, now.text);
				} catch {
					// Not there to read (it was removed): there is nothing of it to keep.
				}
				// A file git does not follow has nothing to go back to: it goes to the trash, not out of existence.
				if (await git().follows(full)) await git().discard(full);
				else await host.trash(full);
			});
		},
		trash: async (path) => {
			const full = need().inside(path);
			await need().alone(full, () => host.trash(full));
		},
		search: (query, options) => need().search(query, options),
		replace: async (query, replacement, options, paths) => {
			const done: { path: string; count: number; error?: string }[] = [];
			for (const path of paths) {
				// One file that cannot be written (its encoding has no way to write the replacement, say) does not
				// stop the others: it is left as it was, and says why.
				try {
					const full = need().inside(path);
					// Read and written as one step: a save of the file that landed between the two would have been
					// written away by text worked out from the file as it was before it.
					const count = await need().alone(full, async (write) => {
						const change = await need().replaced(full, query, replacement, options);
						if (!change) return 0;
						// The file as it was goes into local history first, so that there is a way back.
						await history!.record(full, change.before);
						await write(change.after);
						await history!.record(full, change.after);
						return change.count;
					});
					if (count) done.push({ path: full, count });
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
		docs: async (options) => {
			const effective = options?.templatesFolder !== undefined ? options.templatesFolder : (await settings.load()).effective.templatesFolder;
			return listDocs(need(), await readProject(need().root), { templatesFolder: effective });
		},
		docsTruncated: async () => {
			const effective = (await settings.load()).effective.templatesFolder;
			return docsTruncated(need(), await readProject(need().root), { templatesFolder: effective });
		},
		docAudit: async (attachmentsFolder, options) => {
			const effective = options?.templatesFolder !== undefined ? options.templatesFolder : (await settings.load()).effective.templatesFolder;
			return docAudit(need(), await readProject(need().root), attachmentsFolder, { ...options, templatesFolder: effective });
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
			const full = need().inside(request.path);
			mkdirSync(dirname(full), { recursive: true });
			const baseDir = request.baseDir ? need().inside(request.baseDir) : dirname(full);
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
				workspaceRoot: need().root,
				meta: request.meta,
				mermaidPngs: request.mermaidPngs,
				...(request.attachmentsFolder !== undefined ? { attachmentsFolder: request.attachmentsFolder } : {}),
				...(request.docsFolder !== undefined ? { docsFolder: request.docsFolder } : {}),
				...(request.rasterizedImages !== undefined ? { rasterizedImages: request.rasterizedImages } : {}),
				...(request.toc !== undefined ? { toc: request.toc } : {}),
				...(request.headerFooter !== undefined ? { headerFooter: request.headerFooter } : {}),
			};
			const bytes = markdownToDocx(opts);
			await Bun.write(full, bytes);
			return { path: full, bytes: bytes.length };
		},
		importDocFile: async (request) => {
			const ws = need();
			const src = request.sourcePath?.trim() || (await host.pick("file", "docx,html,htm,md,markdown"));
			if (!src) return null;
			const destDir = ws.inside(request.destDir);
			const attachDir = request.attachmentsDir ? ws.inside(request.attachmentsDir) : join(ws.root, "docs", "attachments");
			mkdirSync(destDir, { recursive: true });
			const ext = extname(src).toLowerCase();
			const kind: "docx" | "html" | "md" = ext === ".docx" ? "docx" : ext === ".html" || ext === ".htm" ? "html" : "md";
			const rawStem = basename(src, ext).replace(/[\\/:*?"<>|]+/g, "-").trim() || "imported";
			const baseDestPath = ws.inside(join(destDir, `${rawStem}.md`));
			const mode = request.onConflict ?? "copy";

			const reserveUniquePath = (dir: string, stem: string, fileExt: string, reserved?: Set<string>): string => {
				let candidate = ws.inside(join(dir, `${stem}${fileExt}`));
				let n = 2;
				while (existsSync(candidate) || reserved?.has(candidate.toLowerCase())) {
					candidate = ws.inside(join(dir, `${stem}-${n}${fileExt}`));
					n++;
				}
				reserved?.add(candidate.toLowerCase());
				return candidate;
			};

			let destPath = baseDestPath;
			if (existsSync(baseDestPath)) {
				if (mode === "prompt") {
					return { path: baseDestPath, images: [], kind, conflict: true, existingPath: baseDestPath };
				}
				if (mode === "copy") {
					destPath = reserveUniquePath(destDir, rawStem, ".md");
				} else if (mode === "overwrite") {
					try {
						const before = await ws.read(baseDestPath);
						if (!before.binary) await history!.record(baseDestPath, before.text);
					} catch {
						// Ignore if unreadable before snapshot.
					}
				}
			}

			const savedImages: string[] = [];
			const reservedImgs = new Set<string>();
			if (kind === "docx") {
				const bytes = new Uint8Array(await Bun.file(src).arrayBuffer());
				const parsed = parseDocxToMarkdown(bytes) as ReturnType<typeof parseDocxToMarkdown> & { warnings?: string[] };
				let md = parsed.markdown;
				if (parsed.images.length) {
					mkdirSync(attachDir, { recursive: true });
					for (const img of parsed.images) {
						const safeImg = `${rawStem}-${img.name.replace(/[^A-Za-z0-9._-]+/g, "-")}`;
						const imgExt = extname(safeImg);
						const imgStem = imgExt ? safeImg.slice(0, -imgExt.length) : safeImg;
						const imgPath = reserveUniquePath(attachDir, imgStem, imgExt, reservedImgs);
						const finalName = basename(imgPath);
						await Bun.write(imgPath, img.bytes);
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
				const IMG_TAG_RE = /<img\b[^>]*>/gi;
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
				for (const m of rawText.matchAll(IMG_TAG_RE)) {
					const idx = m.index ?? 0;
					const tag = m[0]!;
					rewritten += rawText.slice(lastIdx, idx);
					const srcMatch = DATA_SRC_RE.exec(tag);
					if (srcMatch) {
						const subtype = (srcMatch[2] ?? srcMatch[4] ?? srcMatch[6] ?? "png").toLowerCase();
						const b64 = (srcMatch[3] ?? srcMatch[5] ?? srcMatch[7] ?? "").replace(/\s+/g, "");
						const imgExt = EXT_MAP[subtype] ?? ".png";
						mkdirSync(attachDir, { recursive: true });
						const imgPath = reserveUniquePath(attachDir, `${rawStem}-image-${++imgIdx}`, imgExt, reservedImgs);
						await Bun.write(imgPath, Uint8Array.from(Buffer.from(b64, "base64")));
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
			const destDir = ws.inside(request.destDir);
			const attachDir = request.attachmentsDir ? ws.inside(request.attachmentsDir) : join(ws.root, "docs", "attachments");
			mkdirSync(destDir, { recursive: true });
			const ext = extname(request.fileName);
			const rawStem = basename(request.fileName, ext).replace(/[\\/:*?"<>|]+/g, "-").trim() || "imported";
			const baseDestPath = ws.inside(join(destDir, `${rawStem}.md`));
			const mode = request.onConflict ?? "copy";

			const reserveUniquePath = (dir: string, stem: string, fileExt: string, reserved?: Set<string>): string => {
				let candidate = ws.inside(join(dir, `${stem}${fileExt}`));
				let n = 2;
				while (existsSync(candidate) || reserved?.has(candidate.toLowerCase())) {
					candidate = ws.inside(join(dir, `${stem}-${n}${fileExt}`));
					n++;
				}
				reserved?.add(candidate.toLowerCase());
				return candidate;
			};

			let destPath = baseDestPath;
			if (existsSync(baseDestPath)) {
				if (mode === "prompt") {
					return { path: baseDestPath, images: [], conflict: true, existingPath: baseDestPath };
				}
				if (mode === "copy") {
					destPath = reserveUniquePath(destDir, rawStem, ".md");
				} else if (mode === "overwrite") {
					try {
						const before = await ws.read(baseDestPath);
						if (!before.binary) await history!.record(baseDestPath, before.text);
					} catch {
						// Ignore if unreadable before snapshot.
					}
				}
			}

			const bytes = Uint8Array.from(Buffer.from(request.base64, "base64"));
			const parsed = parseDocxToMarkdown(bytes) as ReturnType<typeof parseDocxToMarkdown> & { warnings?: string[] };
			let md = parsed.markdown;
			const savedImages: string[] = [];
			const reservedImgs = new Set<string>();
			if (parsed.images.length) {
				mkdirSync(attachDir, { recursive: true });
				for (const img of parsed.images) {
					const safeImg = `${rawStem}-${img.name.replace(/[^A-Za-z0-9._-]+/g, "-")}`;
					const imgExt = extname(safeImg);
					const imgStem = imgExt ? safeImg.slice(0, -imgExt.length) : safeImg;
					const imgPath = reserveUniquePath(attachDir, imgStem, imgExt, reservedImgs);
					const finalName = basename(imgPath);
					await Bun.write(imgPath, img.bytes);
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
