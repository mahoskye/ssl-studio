// The BackendApi (src/shared/protocol.ts), whichever host carries it.
import { openInSystemApp, revealPathInFileManager, systemPrefersDark } from "./system";
import { homedir } from "node:os";
import { basename, dirname, extname, isAbsolute, join, relative, sep } from "node:path";
import { lstatSync, statSync } from "node:fs";
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
import { fileKey, WorkspaceFiles } from "./workspace";
import { Git } from "./git";
import { Agent } from "./agent";
import { formatDocument } from "./format";

const IMPORT_MAX_BYTES = 20 * 1024 * 1024;
const ALLOWED_IMPORT_EXTS = new Set([".docx", ".html", ".htm", ".md", ".markdown"]);

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
	return raw.split(" ");
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
	/** How many open files have edits that are not on disk, as the view last said. */
	let unsaved = 0;

	async function loadInfo(): Promise<Info> {
		const { effective } = await settings.load();
		const [lspStatus, opencode, systemDark] = await Promise.all([findLsp(effective.lspPath), findOpencode(), systemPrefersDark()]);
		info = { systemDark, app: host.app, lsp: lspStatus, opencode, host: host.kind, selftest: Boolean(process.env.SSL_STUDIO_SELFTEST), selftestCycle: Boolean(process.env.SSL_STUDIO_SELFTEST_CYCLE), selftestClose: Boolean(process.env.SSL_STUDIO_SELFTEST_CLOSE) };
		return info;
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
		lspRestartSeq++;
		asked = null;
		prevFiles?.close();
		prevLsp?.stop();
		prevAsked?.git.dispose();

		const isStale = () => disposed || seq !== openSeq;
		nextFiles.watch((changed) => {
			if (!isStale()) host.emit("fileChanged", { path: changed });
		});

		let startedLsp: LspProcess | null = null;
		try {
			await recent(nextFiles.root);
			if (isStale()) {
				nextFiles.close();
				return { root: nextFiles.root, name: basename(nextFiles.root) };
			}
			const { lsp: status } = await loadInfo();
			if (isStale()) {
				nextFiles.close();
				return { root: nextFiles.root, name: basename(nextFiles.root) };
			}
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
			await agent.workspaceChanged();
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
			}
			throw e;
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
				await hist.record(full, text);
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
			if (!now.binary) await hist.record(full, now.text);
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
				// What is about to go is kept first, where it is text: a discard by mistake has a way back.
				try {
					const now = await ws.read(full);
					if (!now.binary) await hist.record(full, now.text);
				} catch {
					// Not there to read (it was removed): there is nothing of it to keep.
				}
				// A file git does not follow has nothing to go back to: it goes to the trash, not out of existence.
				if (await git().follows(full)) await git().discard(full);
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
		replace: async (query, replacement, options, paths) => {
			const ws = need();
			const hist = history!;
			const done: { path: string; count: number; error?: string; skippedProtected?: number; invalidJson?: boolean }[] = [];
			for (const path of paths) {
				// One file that cannot be written (its encoding has no way to write the replacement, say) does not
				// stop the others: it is left as it was, and says why.
				try {
					const full = ws.inside(path);
					// Read and written as one step: a save of the file that landed between the two would have been
					// written away by text worked out from the file as it was before it.
					const outcome = await ws.alone(full, async (write) => {
						const change = await ws.replaced(path, query, replacement, options);
						if (!change) return null;
						if (change.invalidJson || !change.count) {
							return { count: 0, skippedProtected: change.skippedProtected, invalidJson: change.invalidJson };
						}
						// The file as it was goes into local history first, so that there is a way back.
						await hist.record(full, change.before);
						await write(change.after, false);
						await hist.record(full, change.after);
						return { count: change.count, skippedProtected: change.skippedProtected, invalidJson: false };
					});
					if (outcome && (outcome.count || outcome.skippedProtected || outcome.invalidJson)) {
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
			unsaved = Math.max(0, Number(count) || 0);
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
			const rawStem = basename(src, ext).replace(/[\\/:*?"<>|]+/g, "-").trim() || "imported";
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
			if (kind === "docx") {
				const bytes = new Uint8Array(await Bun.file(src).arrayBuffer());
				const parsed = parseDocxToMarkdown(bytes) as ReturnType<typeof parseDocxToMarkdown> & { warnings?: string[] };
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

			const parsed = parseDocxToMarkdown(bytes) as ReturnType<typeof parseDocxToMarkdown> & { warnings?: string[] };
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
			if (closing || !unsaved) return true;
			host.emit("closeRequested", {});
			return false;
		},
		dispose: () => {
			if (disposed) return;
			disposed = true;
			openSeq++;
			lspRestartSeq++;
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
