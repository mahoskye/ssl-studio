// Smart Markdown image resolution, caching, SVG sanitization, and clipboard/drop attachment saving.
// Supports remote URLs, data URLs, relative paths, root-relative paths, Obsidian bare attachment names
// (`![[diagram.png]]` resolved across relative folder, attachments/, assets/, and workspace files),
// and safe sanitized local SVG diagrams.
import DOMPurify from "dompurify";
import { pictureFolders } from "../../shared/docLinks";
import { imageType } from "../../shared/fileKind";
import { baseName, dirName, isInside, joinPath, relativePath, relativeTo, resolvePath } from "../../shared/paths";
import { backend } from "../backend";
import { docs } from "../project";
import { canonical, notify, setState, state } from "../state";

const IMAGE_CACHE_MAX_ENTRIES = 40;
const IMAGE_CACHE_MAX_CHARS = 40 * 1024 * 1024;
const dataUrlCache = new Map<string, string>();
let dataUrlCacheChars = 0;
let workspaceFilesCache: { root: string; at: number; files: string[] } | null = null;

/**
 * What is known of a picture a document shows, kept under the document's path and the address as written: the
 * file it was read from, or that none was found and how many times the workspace's files had changed by then
 * (`state.treeVersion`); and `again`, how many times it has since had cause to be drawn again. A picture's address
 * on the network, or its own data, is nothing a file changes, and is not kept.
 */
type PictureSeen = { again: number; file?: string; missingAt?: number; missing?: boolean };
const PICTURES_SEEN_MAX = 500;
const picturesSeen = new Map<string, PictureSeen>();
const pictureKey = (src: string, docPath: string) => `${docPath}\n${src}`;

/** Keeps how a picture was last answered: `filesThen` is the workspace's count of changes when it was asked for. */
function pictureAnswered(src: string, docPath: string, loaded: { url: string; filePath?: string } | null, filesThen: number) {
	const key = pictureKey(src, docPath);
	const again = picturesSeen.get(key)?.again ?? 0;
	picturesSeen.delete(key);
	if (loaded && !loaded.filePath) return;
	picturesSeen.set(key, loaded?.filePath ? { again, file: canonical(loaded.filePath) } : { again, missingAt: filesThen, missing: true });
	while (picturesSeen.size > PICTURES_SEEN_MAX) {
		const oldest = picturesSeen.keys().next().value;
		if (oldest === undefined) break;
		picturesSeen.delete(oldest);
	}
}

/**
 * How many times a picture has had cause to be drawn again: a number that is part of what a drawn picture is
 * (`ImageWidget.eq` in cmLivePlugin.ts), so that the editor draws it afresh, and asks for it afresh, when the
 * number has grown. A drawn picture is compared at every update of the editor, and nothing in the comparison
 * changed with the file: "Image not found" stayed after the file was put there, and a picture stayed as it was
 * after its file was written again. It grows:
 *
 * - for a picture that was not found, once each time the workspace's files have changed since (a file written,
 *   made, moved or removed, in the app or outside it, or the Explorer read again). It is then asked for once, and
 *   is neither found nor missing until that is answered, so a second look before the answer asks nothing more;
 * - for a picture read from a file, when that file changed (`invalidateImageCache` is told which).
 *
 * It does not grow with what is typed: a picture that was found asks for nothing until its own file changes.
 */
export function pictureDrawnAgain(src: string, docPath: string, filesNow: number = state.treeVersion): number {
	const seen = picturesSeen.get(pictureKey(src, docPath));
	if (!seen) return 0;
	if (seen.missingAt !== undefined && seen.missingAt !== filesNow) {
		seen.missingAt = undefined;
		seen.again += 1;
		// The list of the workspace's files is kept for a few seconds: the one that says the file is not there is old now.
		workspaceFilesCache = null;
	}
	return seen.again;
}

/**
 * Whether a picture was not found when it was last asked for. One that is drawn again for a change in the
 * workspace (see above) is then drawn as not found from the start, and changes only if the answer is another:
 * drawn empty first, "Image not found" went and came back at every save of any file.
 */
export function pictureWasMissing(src: string, docPath: string): boolean {
	return picturesSeen.get(pictureKey(src, docPath))?.missing === true;
}

export const IMAGE_FILE_RE = /\.(png|jpe?g|gif|webp|svg|bmp|ico|avif)$/i;

function cacheGetImage(key: string): string | undefined {
	const hit = dataUrlCache.get(key);
	if (hit === undefined) return undefined;
	dataUrlCache.delete(key);
	dataUrlCache.set(key, hit);
	return hit;
}

function cacheSetImage(key: string, value: string) {
	const prev = dataUrlCache.get(key);
	if (prev !== undefined) {
		dataUrlCacheChars -= prev.length;
		dataUrlCache.delete(key);
	}
	if (value.length > IMAGE_CACHE_MAX_CHARS) return;
	dataUrlCache.set(key, value);
	dataUrlCacheChars += value.length;
	while (dataUrlCache.size > IMAGE_CACHE_MAX_ENTRIES || dataUrlCacheChars > IMAGE_CACHE_MAX_CHARS) {
		const oldestKey = dataUrlCache.keys().next().value;
		if (oldestKey === undefined) break;
		const oldestVal = dataUrlCache.get(oldestKey);
		dataUrlCache.delete(oldestKey);
		if (oldestVal !== undefined) dataUrlCacheChars -= oldestVal.length;
	}
}

/** Reports current image data-URL cache size (used for diagnostics and regression tests). */
export function imageCacheStats(): { entries: number; chars: number } {
	return { entries: dataUrlCache.size, chars: dataUrlCacheChars };
}

/** Clears cached image data URL (e.g. if an image file changes on disk or a new folder opens). */
export function invalidateImageCache(path?: string) {
	if (path) {
		const prev = dataUrlCache.get(path);
		if (prev !== undefined) {
			dataUrlCacheChars -= prev.length;
			dataUrlCache.delete(path);
		}
		const canon = canonical(path);
		for (const [k, v] of [...dataUrlCache.entries()]) {
			if (canonical(k) === canon) {
				dataUrlCacheChars -= v.length;
				dataUrlCache.delete(k);
			}
		}
		workspaceFilesCache = null;
		// A picture drawn from this file is drawn again (see pictureDrawnAgain): dropping what was read of it is not seen by itself.
		for (const seen of picturesSeen.values()) if (seen.file === canon) seen.again += 1;
	} else {
		dataUrlCache.clear();
		dataUrlCacheChars = 0;
		workspaceFilesCache = null;
		picturesSeen.clear();
	}
}

async function listWorkspaceFiles(): Promise<string[]> {
	const root = state.workspace?.root;
	if (!root) return [];
	if (workspaceFilesCache && workspaceFilesCache.root === root && Date.now() - workspaceFilesCache.at < 6000) {
		return workspaceFilesCache.files;
	}
	try {
		const files = await backend.files();
		workspaceFilesCache = { root, at: Date.now(), files };
		return files;
	} catch {
		return [];
	}
}

/** Lists all image files in the current workspace (for autocomplete and Insert Image picker). */
export async function listWorkspaceImages(): Promise<string[]> {
	const files = await listWorkspaceFiles();
	return files.filter((f) => IMAGE_FILE_RE.test(f));
}

/**
 * Resolves a Markdown or Obsidian image target (`./shot.png`, `/assets/a.png`, `diagram.png`)
 * to either a remote/data URL or an absolute workspace path.
 */
export async function resolveImageTarget(src: string, docPath: string): Promise<{ url?: string; filePath?: string } | null> {
	const clean = src.trim();
	if (!clean) return null;
	if (/^https?:\/\//i.test(clean) || /^data:image\//i.test(clean)) return { url: clean };

	const root = state.workspace?.root;
	if (!root) return null;

	const decoded = (() => {
		try {
			return decodeURIComponent(clean);
		} catch {
			return clean;
		}
	})();

	const docInWorkspace = Boolean(docPath && !docPath.startsWith("untitled:") && isInside(root, docPath));
	const isWinAbs = /^[a-zA-Z]:[\\/]/.test(decoded);
	const hasTraversal = decoded.split(/[\\/]/).includes("..");
	const direct = decoded.startsWith("/")
		? resolvePath(root, decoded.replace(/^\/+/, ""))
		: isWinAbs
			? decoded
			: docInWorkspace
				? resolvePath(dirName(docPath), decoded)
				: resolvePath(root, decoded);

	// Reject explicit path traversal or rooted paths that escape the workspace root.
	if ((decoded.startsWith("/") || isWinAbs || hasTraversal) && !isInside(root, direct)) {
		return null;
	}

	const files = await listWorkspaceFiles();
	const byLower = new Map(files.map((f) => [f.toLowerCase(), f]));

	if (isInside(root, direct)) {
		const exact = byLower.get(direct.toLowerCase());
		if (exact) return { filePath: exact };
	}

	// Obsidian bare attachment resolution: check local attachments/assets, project attachmentsFolder, then workspace basename.
	const wantedName = baseName(decoded).toLowerCase();
	const docDir = docInWorkspace ? dirName(docPath) : root;
	// The order of the folders is the one a rename follows a bare name by (`bareNameTarget`): both read it from one list.
	const candidateDirs = pictureFolders(docInWorkspace ? docDir : null, { root, docs: state.project?.docs, attachments: state.settings.attachmentsFolder });

	for (const dir of candidateDirs) {
		const cand = resolvePath(dir, decoded);
		if (isInside(root, cand)) {
			const hit = byLower.get(cand.toLowerCase());
			if (hit) return { filePath: hit };
		}
	}

	// Fallback: first image in workspace matching basename (preferring closer path), never for traversal/rooted paths.
	if (!decoded.startsWith("/") && !isWinAbs && !hasTraversal) {
		const matches = files.filter((f) => baseName(f).toLowerCase() === wantedName);
		if (matches.length) {
			matches.sort((a, b) => relativePath(docDir, a).length - relativePath(docDir, b).length);
			return { filePath: matches[0]! };
		}
	}

	// If direct path is inside workspace even if workspace cache was slightly stale, let backend try it.
	if (isInside(root, direct)) return { filePath: direct };
	return null;
}

/** Loads a workspace or remote image source into a displayable `src` string (cached). */
export async function loadImageUrl(src: string, docPath: string): Promise<{ url: string; filePath?: string } | null> {
	// Counted before it is asked for: a file that changes while the answer is on its way is a change since.
	const filesThen = state.treeVersion;
	const loaded = await readImageUrl(src, docPath);
	pictureAnswered(src, docPath, loaded, filesThen);
	return loaded;
}

async function readImageUrl(src: string, docPath: string): Promise<{ url: string; filePath?: string } | null> {
	const resolved = await resolveImageTarget(src, docPath);
	if (!resolved) return null;
	if (resolved.url) return { url: resolved.url };
	const target = resolved.filePath;
	if (!target) return null;

	const cached = cacheGetImage(target);
	if (cached) return { url: cached, filePath: target };

	if (/\.svg$/i.test(target)) {
		try {
			const res = await backend.read(target);
			if (!res.text.trim()) return null;
			const cleanSvg = DOMPurify.sanitize(res.text, { USE_PROFILES: { svg: true, svgFilters: true } });
			const dataUrl = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(cleanSvg)}`;
			cacheSetImage(target, dataUrl);
			return { url: dataUrl, filePath: target };
		} catch {
			return null;
		}
	}

	if (!imageType(target)) return null;
	try {
		const { type, base64 } = await backend.image(target);
		const dataUrl = `data:${type};base64,${base64}`;
		cacheSetImage(target, dataUrl);
		return { url: dataUrl, filePath: target };
	} catch {
		return null;
	}
}

/** The pictures put into cards below: the address each was written with, its document, and the count of causes it was asked for at. */
const hydratedImages = new WeakMap<HTMLImageElement, { src: string; docPath: string; again: number }>();

/** Hydrates any local workspace `<img src="...">` elements rendered inside callouts, tables, or hover cards. */
export function hydrateImagesInElement(container: HTMLElement, docPath: string) {
	for (const img of container.querySelectorAll<HTMLImageElement>("img")) {
		const rawSrc = img.getAttribute("src")?.trim() ?? "";
		if (!rawSrc || /^https?:\/\//i.test(rawSrc) || /^data:image\//i.test(rawSrc)) continue;
		hydratedImages.set(img, { src: rawSrc, docPath, again: pictureDrawnAgain(rawSrc, docPath) });
		void loadImageUrl(rawSrc, docPath).then((loaded) => {
			if (!img.isConnected) return;
			if (loaded) img.src = loaded.url;
		});
	}
}

/**
 * Asks again for the pictures in the cards under `root` that have had cause (`pictureDrawnAgain`): a picture in a
 * callout, a table cell, a `<details>` block, an embedded note or a hover card is put there once, when its card is
 * drawn, and a card is not drawn again because a file appeared or changed. The editor calls this when the
 * workspace's files change; a picture that has had no cause asks for nothing.
 */
export function rehydrateImages(root: ParentNode = document) {
	for (const img of root.querySelectorAll<HTMLImageElement>("img")) {
		const drawn = hydratedImages.get(img);
		if (!drawn) continue;
		const again = pictureDrawnAgain(drawn.src, drawn.docPath);
		if (again === drawn.again) continue;
		drawn.again = again;
		void loadImageUrl(drawn.src, drawn.docPath).then((loaded) => {
			if (img.isConnected && loaded) img.src = loaded.url;
		});
	}
}

const MIME_EXT: Record<string, string> = {
	"image/png": "png",
	"image/jpeg": "jpg",
	"image/jpg": "jpg",
	"image/gif": "gif",
	"image/webp": "webp",
	"image/svg+xml": "svg",
	"image/bmp": "bmp",
	"image/x-icon": "ico",
	"image/avif": "avif",
};

/** Generic browser clipboard filenames like `image.png` get timestamped so pastes stay descriptive and unique. */
const GENERIC_CLIPBOARD_NAME_RE = /^image\.(png|jpe?g|webp|gif|bmp|avif)$/i;

function sanitizeImageBaseName(name: string): string {
	return name
		.replace(/\.[^.]+$/, "")
		.replace(/[^A-Za-z0-9._-]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, 60);
}

function timestampSlug(): string {
	const d = new Date();
	const p = (n: number) => String(n).padStart(2, "0");
	return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

function arrayBufferToBase64(buf: ArrayBuffer): string {
	const bytes = new Uint8Array(buf);
	let binary = "";
	const chunk = 0x8000;
	for (let i = 0; i < bytes.length; i += chunk) {
		binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
	}
	return btoa(binary);
}

/**
 * Saves a pasted or dropped browser `File` / `Blob` image into the workspace attachments folder
 * and returns a clean relative Markdown link `![alt](relative/path.png)`.
 */
export async function saveImageAttachment(file: File | Blob, docPath: string): Promise<{ markdown: string; path: string; rel: string } | null> {
	const root = state.workspace?.root;
	if (!root) {
		notify("Open a folder before pasting images.", "error");
		return null;
	}

	const rawName = file instanceof File ? baseName(file.name) : "";
	const extFromName = rawName.includes(".") ? rawName.split(".").pop()!.toLowerCase() : "";
	const ext = MIME_EXT[file.type.toLowerCase()] ?? (extFromName === "svg" ? "svg" : imageType(`a.${extFromName}`) ? extFromName : "png");
	const sanitized = rawName && !GENERIC_CLIPBOARD_NAME_RE.test(rawName.trim()) ? sanitizeImageBaseName(rawName) : "";
	const meaningfulName = sanitized && sanitized !== "." && sanitized !== ".." ? sanitized : "";
	const stem = meaningfulName || `pasted-image-${timestampSlug()}`;

	const rawDocsRoot = resolvePath(root, state.project?.docs ?? "docs");
	const docsRoot = isInside(root, rawDocsRoot) ? rawDocsRoot : joinPath(root, "docs");
	const fallbackDestDir = joinPath(docsRoot, "attachments");
	const configured = state.settings.attachmentsFolder?.trim();
	const docInWorkspace = Boolean(docPath && !docPath.startsWith("untitled:") && isInside(root, docPath));
	const docCanon = docInWorkspace ? canonical(docPath) : "";
	const ownerTicket = docInWorkspace
		? docs().find(
				(d) =>
					d.exists &&
					d.group === "tickets" &&
					d.ticketFolder &&
					(canonical(d.path) === docCanon || isInside(d.ticketFolder, docPath)),
			)
		: undefined;
	let destDir: string;
	if (configured) {
		destDir = resolvePath(root, configured);
		if (!isInside(root, destDir)) {
			notify("Attachments folder must stay inside the workspace.", "error");
			return null;
		}
	} else if (ownerTicket?.ticketFolder && isInside(root, ownerTicket.ticketFolder)) {
		destDir = joinPath(ownerTicket.ticketFolder, "attachments");
	} else if (!docInWorkspace || isInside(docsRoot, docPath)) {
		destDir = fallbackDestDir;
	} else {
		destDir = joinPath(dirName(docPath), "attachments");
	}
	if (!isInside(root, destDir)) {
		notify("Attachments folder must stay inside the workspace.", "error");
		return null;
	}

	const existing = new Set((await listWorkspaceFiles()).map((f) => f.toLowerCase()));
	let candidate = resolvePath(destDir, `${stem}.${ext}`);
	let n = 2;
	while (existing.has(candidate.toLowerCase())) {
		candidate = resolvePath(destDir, `${stem}-${n++}.${ext}`);
	}
	if (!isInside(root, candidate)) {
		notify("Attachment path must stay inside the workspace.", "error");
		return null;
	}

	try {
		let savedPath = candidate;
		if (ext === "svg") {
			const rawSvg = await file.text();
			const cleanSvg = DOMPurify.sanitize(rawSvg, { USE_PROFILES: { svg: true, svgFilters: true } });
			if (!cleanSvg.trim()) {
				notify("The dropped SVG was empty after sanitization.", "error");
				return null;
			}
			await backend.create(candidate, "file");
			await backend.write(candidate, cleanSvg);
			cacheSetImage(candidate, `data:image/svg+xml;charset=utf-8,${encodeURIComponent(cleanSvg)}`);
		} else {
			const base64 = arrayBufferToBase64(await file.arrayBuffer());
			const saved = await backend.writeImage(candidate, base64);
			savedPath = saved.path;
			const dataUrl = `data:${file.type || `image/${ext === "jpg" ? "jpeg" : ext}`};base64,${base64}`;
			cacheSetImage(savedPath, dataUrl);
		}
		workspaceFilesCache = null;
		setState((s) => {
			s.treeVersion += 1;
		});
		const rel = docInWorkspace ? relativePath(dirName(docPath), savedPath) : `/${relativeTo(root, savedPath)}`;
		const alt = meaningfulName ? meaningfulName.replace(/[-_]+/g, " ") : "";
		const encodedRel = rel
			.split("/")
			.map((seg) => (seg ? encodeURIComponent(seg) : ""))
			.join("/");
		return { markdown: `![${alt}](${encodedRel})`, path: savedPath, rel };
	} catch (e: any) {
		notify(`Could not save image: ${e?.message ?? e}`, "error");
		return null;
	}
}
