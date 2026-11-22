// Smart Markdown image resolution, caching, SVG sanitization, and clipboard/drop attachment saving.
// Supports remote URLs, data URLs, relative paths, root-relative paths, Obsidian bare attachment names
// (`![[diagram.png]]` resolved across relative folder, attachments/, assets/, and workspace files),
// and safe sanitized local SVG diagrams.
import DOMPurify from "dompurify";
import { imageType } from "../../shared/fileKind";
import { baseName, dirName, isInside, joinPath, relativePath, resolvePath } from "../../shared/paths";
import { backend } from "../backend";
import { notify, setState, state } from "../state";

const dataUrlCache = new Map<string, string>();
let workspaceFilesCache: { root: string; at: number; files: string[] } | null = null;

export const IMAGE_FILE_RE = /\.(png|jpe?g|gif|webp|svg|bmp|ico|avif)$/i;

/** Clears cached image data URL (e.g. if an image file changes on disk). */
export function invalidateImageCache(path?: string) {
	if (path) dataUrlCache.delete(path);
	else dataUrlCache.clear();
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

	const direct = decoded.startsWith("/")
		? joinPath(root, ...decoded.split("/").filter(Boolean))
		: resolvePath(dirName(docPath), decoded);

	const files = await listWorkspaceFiles();
	const byLower = new Map(files.map((f) => [f.toLowerCase(), f]));

	if (isInside(root, direct)) {
		const exact = byLower.get(direct.toLowerCase());
		if (exact) return { filePath: exact };
	}

	// Obsidian bare attachment resolution: check local attachments/assets, project attachmentsFolder, then workspace basename.
	const wantedName = baseName(decoded).toLowerCase();
	const docDir = dirName(docPath);
	const docsRoot = joinPath(root, ...(state.project?.docs ?? "docs").split(/[\\/]/).filter((p) => p && p !== "."));
	const configured = state.settings.attachmentsFolder?.trim();
	const candidateDirs = [
		...(configured ? [joinPath(root, ...configured.split(/[\\/]/).filter(Boolean))] : []),
		joinPath(docDir, "attachments"),
		joinPath(docDir, "assets"),
		joinPath(docDir, "images"),
		joinPath(docsRoot, "attachments"),
		joinPath(docsRoot, "assets"),
		joinPath(docsRoot, "images"),
		joinPath(root, "assets"),
		joinPath(root, "images"),
	];

	for (const dir of candidateDirs) {
		const cand = joinPath(dir, decoded);
		if (isInside(root, cand)) {
			const hit = byLower.get(cand.toLowerCase());
			if (hit) return { filePath: hit };
		}
	}

	// Fallback: first image in workspace matching basename (preferring closer path).
	const matches = files.filter((f) => baseName(f).toLowerCase() === wantedName);
	if (matches.length) {
		matches.sort((a, b) => relativePath(docDir, a).length - relativePath(docDir, b).length);
		return { filePath: matches[0]! };
	}

	// If direct path is inside workspace even if workspace cache was slightly stale, let backend try it.
	if (isInside(root, direct)) return { filePath: direct };
	return null;
}

/** Loads a workspace or remote image source into a displayable `src` string (cached). */
export async function loadImageUrl(src: string, docPath: string): Promise<{ url: string; filePath?: string } | null> {
	const resolved = await resolveImageTarget(src, docPath);
	if (!resolved) return null;
	if (resolved.url) return { url: resolved.url };
	const target = resolved.filePath;
	if (!target) return null;

	const cached = dataUrlCache.get(target);
	if (cached) return { url: cached, filePath: target };

	if (/\.svg$/i.test(target)) {
		try {
			const res = await backend.read(target);
			if (!res.text.trim()) return null;
			const cleanSvg = DOMPurify.sanitize(res.text, { USE_PROFILES: { svg: true, svgFilters: true } });
			const dataUrl = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(cleanSvg)}`;
			dataUrlCache.set(target, dataUrl);
			return { url: dataUrl, filePath: target };
		} catch {
			return null;
		}
	}

	if (!imageType(target)) return null;
	try {
		const { type, base64 } = await backend.image(target);
		const dataUrl = `data:${type};base64,${base64}`;
		dataUrlCache.set(target, dataUrl);
		return { url: dataUrl, filePath: target };
	} catch {
		return null;
	}
}

/** Hydrates any local workspace `<img src="...">` elements rendered inside callouts, tables, or hover cards. */
export function hydrateImagesInElement(container: HTMLElement, docPath: string) {
	for (const img of container.querySelectorAll<HTMLImageElement>("img")) {
		const rawSrc = img.getAttribute("src")?.trim() ?? "";
		if (!rawSrc || /^https?:\/\//i.test(rawSrc) || /^data:image\//i.test(rawSrc)) continue;
		void loadImageUrl(rawSrc, docPath).then((loaded) => {
			if (!img.isConnected) return;
			if (loaded) img.src = loaded.url;
		});
	}
}

const MIME_EXT: Record<string, string> = {
	"image/png": "png",
	"image/jpeg": "jpg",
	"image/jpg": "jpg",
	"image/gif": "gif",
	"image/webp": "webp",
	"image/bmp": "bmp",
	"image/x-icon": "ico",
};

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

	const rawName = file instanceof File ? file.name : "";
	const extFromName = rawName.includes(".") ? rawName.split(".").pop()!.toLowerCase() : "";
	const ext = MIME_EXT[file.type.toLowerCase()] ?? (imageType(`a.${extFromName}`) ? extFromName : "png");
	const stem = sanitizeImageBaseName(rawName) || `pasted-image-${timestampSlug()}`;

	const docsRoot = joinPath(root, ...(state.project?.docs ?? "docs").split(/[\\/]/).filter((p) => p && p !== "."));
	const configured = state.settings.attachmentsFolder?.trim();
	const destDir = configured
		? joinPath(root, ...configured.split(/[\\/]/).filter(Boolean))
		: isInside(docsRoot, docPath)
			? joinPath(docsRoot, "attachments")
			: joinPath(dirName(docPath), "attachments");

	const existing = new Set((await listWorkspaceFiles()).map((f) => f.toLowerCase()));
	let candidate = joinPath(destDir, `${stem}.${ext}`);
	let n = 2;
	while (existing.has(candidate.toLowerCase())) {
		candidate = joinPath(destDir, `${stem}-${n++}.${ext}`);
	}

	try {
		const base64 = arrayBufferToBase64(await file.arrayBuffer());
		const saved = await backend.writeImage(candidate, base64);
		const dataUrl = `data:${file.type || `image/${ext === "jpg" ? "jpeg" : ext}`};base64,${base64}`;
		dataUrlCache.set(saved.path, dataUrl);
		workspaceFilesCache = null;
		setState("treeVersion", (v) => v + 1);
		const rel = relativePath(dirName(docPath), saved.path);
		const alt = rawName && !/^image\./i.test(rawName) ? sanitizeImageBaseName(rawName).replace(/[-_]+/g, " ") : "";
		const encodedRel = rel
			.split("/")
			.map((seg) => encodeURIComponent(seg))
			.join("/");
		return { markdown: `![${alt}](${encodedRel})`, path: saved.path, rel };
	} catch (e: any) {
		notify(`Could not save image: ${e?.message ?? e}`, "error");
		return null;
	}
}
