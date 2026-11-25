// Zero-dependency OpenXML (.docx) writer and pure-TypeScript reader for STARLIMS
// stakeholder documents, Ticket Release Packets, Deployment Manifests, and legacy
// Word document imports.
// Writer: produces standard OOXML readable by Microsoft Word, LibreOffice Writer,
// and Google Docs — with embedded local images, rasterized Mermaid PNGs, clickable
// hyperlinks, GFM footnotes, compact metadata tables, styled callouts, muted
// blockquotes, pipe tables (safe with inline code pipes), fenced code, checklists,
// and full inline formatting (bold, italic, bold-italic, code, strike, highlight).
// Reader: pure-TS ZIP central-directory + WordprocessingML parser converting .docx
// archives back into clean Markdown + extracted image payloads.
import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { basename, extname, isAbsolute, join, relative, resolve } from "node:path";
import { deflateRawSync, inflateRawSync } from "node:zlib";
import { frontMatter, one } from "../shared/frontMatter";

const ILLEGAL_XML_RE =
	/[\u0000-\u0008\u000B\u000C\u000E-\u001F\uFFFE\uFFFF]|[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g;

const xmlEsc = (s: string) =>
	s
		.replace(ILLEGAL_XML_RE, "")
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;")
		.replace(/'/g, "&apos;");

const isValidXmlCodePoint = (n: number) =>
	Number.isFinite(n) && n > 0 && n <= 0x10ffff && (n < 0xd800 || n > 0xdfff);

const xmlUnesc = (s: string) =>
	s.replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos);/gi, (m, code: string) => {
		const lower = code.toLowerCase();
		if (lower === "amp") return "&";
		if (lower === "lt") return "<";
		if (lower === "gt") return ">";
		if (lower === "quot") return '"';
		if (lower === "apos") return "'";
		if (lower.startsWith("#x")) {
			const n = Number.parseInt(lower.slice(2), 16);
			return isValidXmlCodePoint(n) ? String.fromCodePoint(n) : m;
		}
		if (lower.startsWith("#")) {
			const n = Number.parseInt(lower.slice(1), 10);
			return isValidXmlCodePoint(n) ? String.fromCodePoint(n) : m;
		}
		return m;
	});

// --- Minimal ZIP writer & reader (CRC32 + raw deflate/inflate) ---------------

const CRC_TABLE = (() => {
	const table = new Uint32Array(256);
	for (let i = 0; i < 256; i++) {
		let c = i;
		for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
		table[i] = c >>> 0;
	}
	return table;
})();

function crc32(buf: Uint8Array): number {
	let c = 0xffffffff;
	for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]!) & 0xff]! ^ (c >>> 8);
	return (c ^ 0xffffffff) >>> 0;
}

function buildZip(entries: { name: string; data: Uint8Array }[]): Uint8Array {
	const enc = new TextEncoder();
	const locals: Uint8Array[] = [];
	const centrals: Uint8Array[] = [];
	let offset = 0;

	for (const entry of entries) {
		const nameBytes = enc.encode(entry.name);
		const raw = entry.data;
		const compressed = new Uint8Array(deflateRawSync(raw));
		const crc = crc32(raw);

		const local = new Uint8Array(30 + nameBytes.length + compressed.length);
		const lv = new DataView(local.buffer);
		lv.setUint32(0, 0x04034b50, true); // Local file header signature
		lv.setUint16(4, 20, true); // Version needed (2.0)
		lv.setUint16(6, 0x0800, true); // UTF-8 filename flag
		lv.setUint16(8, 8, true); // Deflate compression
		lv.setUint16(10, 0, true);
		lv.setUint16(12, 0, true);
		lv.setUint32(14, crc, true);
		lv.setUint32(18, compressed.length, true);
		lv.setUint32(22, raw.length, true);
		lv.setUint16(26, nameBytes.length, true);
		lv.setUint16(28, 0, true);
		local.set(nameBytes, 30);
		local.set(compressed, 30 + nameBytes.length);
		locals.push(local);

		const central = new Uint8Array(46 + nameBytes.length);
		const cv = new DataView(central.buffer);
		cv.setUint32(0, 0x02014b50, true); // Central directory signature
		cv.setUint16(4, 20, true);
		cv.setUint16(6, 20, true);
		cv.setUint16(8, 0x0800, true);
		cv.setUint16(10, 8, true);
		cv.setUint16(12, 0, true);
		cv.setUint16(14, 0, true);
		cv.setUint32(16, crc, true);
		cv.setUint32(20, compressed.length, true);
		cv.setUint32(24, raw.length, true);
		cv.setUint16(28, nameBytes.length, true);
		cv.setUint16(30, 0, true);
		cv.setUint16(32, 0, true);
		cv.setUint16(34, 0, true);
		cv.setUint16(36, 0, true);
		cv.setUint32(38, 0, true);
		cv.setUint32(42, offset, true);
		central.set(nameBytes, 46);
		centrals.push(central);

		offset += local.length;
	}

	const centralSize = centrals.reduce((sum, b) => sum + b.length, 0);
	const eocd = new Uint8Array(22);
	const ev = new DataView(eocd.buffer);
	ev.setUint32(0, 0x06054b50, true);
	ev.setUint16(4, 0, true);
	ev.setUint16(6, 0, true);
	ev.setUint16(8, entries.length, true);
	ev.setUint16(10, entries.length, true);
	ev.setUint32(12, centralSize, true);
	ev.setUint32(16, offset, true);
	ev.setUint16(20, 0, true);

	const out = new Uint8Array(offset + centralSize + eocd.length);
	let pos = 0;
	for (const b of locals) (out.set(b, pos), (pos += b.length));
	for (const b of centrals) (out.set(b, pos), (pos += b.length));
	out.set(eocd, pos);
	return out;
}

const MAX_ZIP_ENTRY_BYTES = 32 * 1024 * 1024;
const MAX_ZIP_TOTAL_BYTES = 64 * 1024 * 1024;
const MAX_ZIP_ENTRIES = 2048;

/** Pure-TypeScript ZIP central-directory reader supporting Stored (0) and Deflate (8) entries. */
function readZipEntries(bytes: Uint8Array): Map<string, Uint8Array> {
	const entries = new Map<string, Uint8Array>();
	if (bytes.length < 22) return entries;
	const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	const dec = new TextDecoder();

	// Locate End of Central Directory record (0x06054b50), scanning backwards up to 64 KiB + 22 bytes,
	// verifying comment bounds match archive end so signatures inside payloads/comments are ignored.
	const minEocd = Math.max(0, bytes.length - 65557);
	let eocdPos = -1;
	for (let p = bytes.length - 22; p >= minEocd; p--) {
		if (view.getUint32(p, true) === 0x06054b50) {
			const commentLen = view.getUint16(p + 20, true);
			if (p + 22 + commentLen === bytes.length) {
				eocdPos = p;
				break;
			}
		}
	}

	let totalBytes = 0;
	let extractedCount = 0;
	const seenOffsets = new Set<number>();
	const seenSpans: [number, number][] = [];

	const extractAtLocal = (localOffset: number, method: number, compSize: number): Uint8Array | null => {
		if (extractedCount >= MAX_ZIP_ENTRIES) return null;
		if (seenOffsets.has(localOffset)) return null;
		if (localOffset < 0 || localOffset + 30 > bytes.length) return null;
		if (view.getUint32(localOffset, true) !== 0x04034b50) return null;
		const localNameLen = view.getUint16(localOffset + 26, true);
		const localExtraLen = view.getUint16(localOffset + 28, true);
		const dataStart = localOffset + 30 + localNameLen + localExtraLen;
		const dataEnd = dataStart + compSize;
		if (dataStart > bytes.length || dataEnd > bytes.length || compSize > MAX_ZIP_ENTRY_BYTES) return null;
		// Reject overlapping local entry ranges (prevents overlapping-entry ZIP bombs).
		if (seenSpans.some(([s, e]) => localOffset < e && dataEnd > s)) return null;
		seenOffsets.add(localOffset);
		seenSpans.push([localOffset, dataEnd]);
		extractedCount++;
		const remaining = MAX_ZIP_TOTAL_BYTES - totalBytes;
		if (remaining <= 0) return null;
		const maxOut = Math.min(MAX_ZIP_ENTRY_BYTES, remaining);
		const slice = bytes.subarray(dataStart, dataEnd);
		if (method === 0) {
			if (slice.length > maxOut) return null;
			totalBytes += slice.length;
			return new Uint8Array(slice);
		}
		if (method === 8) {
			try {
				const inflated = inflateRawSync(slice, { maxOutputLength: maxOut });
				if (inflated.length > maxOut) return null;
				totalBytes += inflated.length;
				return new Uint8Array(inflated);
			} catch {
				return null;
			}
		}
		return null;
	};

	if (eocdPos >= 0) {
		const entryCount = view.getUint16(eocdPos + 10, true);
		const cdSize = view.getUint32(eocdPos + 12, true);
		const cdOffset = view.getUint32(eocdPos + 16, true);
		if (cdOffset > eocdPos) return entries;
		let pos = cdOffset;
		const cdEnd = Math.min(eocdPos, cdOffset + cdSize);
		const maxLoop = Math.min(entryCount, MAX_ZIP_ENTRIES);
		for (let i = 0; i < maxLoop && pos + 46 <= cdEnd; i++) {
			if (view.getUint32(pos, true) !== 0x02014b50) break;
			const method = view.getUint16(pos + 10, true);
			const compSize = view.getUint32(pos + 20, true);
			const nameLen = view.getUint16(pos + 28, true);
			const extraLen = view.getUint16(pos + 30, true);
			const commentLen = view.getUint16(pos + 32, true);
			const localOffset = view.getUint32(pos + 42, true);
			if (pos + 46 + nameLen > cdEnd) break;
			const nextPos = pos + 46 + nameLen + extraLen + commentLen;
			if (nextPos > cdEnd) break;
			const rawName = dec.decode(bytes.subarray(pos + 46, pos + 46 + nameLen)).replace(/\\/g, "/");
			pos = nextPos;
			if (!rawName || rawName.endsWith("/")) continue;
			const payload = extractAtLocal(localOffset, method, compSize);
			if (payload) entries.set(rawName, payload);
		}
		return entries;
	}

	// Fallback: local header sequential walk when EOCD is absent.
	let pos = 0;
	while (pos + 30 <= bytes.length && extractedCount < MAX_ZIP_ENTRIES && view.getUint32(pos, true) === 0x04034b50) {
		const method = view.getUint16(pos + 8, true);
		const compSize = view.getUint32(pos + 18, true);
		const nameLen = view.getUint16(pos + 26, true);
		const extraLen = view.getUint16(pos + 28, true);
		if (pos + 30 + nameLen > bytes.length) break;
		const dataStart = pos + 30 + nameLen + extraLen;
		if (dataStart > bytes.length || dataStart + compSize > bytes.length) break;
		const rawName = dec.decode(bytes.subarray(pos + 30, pos + 30 + nameLen)).replace(/\\/g, "/");
		if (rawName && !rawName.endsWith("/")) {
			const payload = extractAtLocal(pos, method, compSize);
			if (payload) entries.set(rawName, payload);
		}
		const nextPos = dataStart + compSize;
		if (nextPos <= pos) break;
		pos = nextPos;
	}
	return entries;
}

// --- Image dimension inspection & workspace-safe resolution ------------------

const EMU_PER_PX = 9525; // 914400 EMU/in at 96 DPI
const MAX_IMAGE_EMU_W = 5943600; // ~6.5 inches (letter page minus margins)
const MAX_IMAGE_EMU_H = 7772400; // ~8.5 inches

const IMAGE_MIME_BY_EXT: Record<string, string> = {
	png: "image/png",
	jpg: "image/jpeg",
	jpeg: "image/jpeg",
	gif: "image/gif",
	bmp: "image/bmp",
};

const EMBED_IMAGE_EXT_RE = /\.(?:png|jpe?g|gif|bmp|webp|svg|ico|avif)$/i;

/** Parses natural pixel dimensions from PNG, JPEG, GIF, or BMP binary headers. */
function parseImageDimensions(bytes: Uint8Array): { width: number; height: number } | null {
	if (bytes.length < 10) return null;
	const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

	// PNG: 89 50 4E 47 0D 0A 1A 0A, IHDR width@16 BE, height@20 BE
	if (
		bytes.length >= 24 &&
		bytes[0] === 0x89 &&
		bytes[1] === 0x50 &&
		bytes[2] === 0x4e &&
		bytes[3] === 0x47 &&
		bytes[4] === 0x0d &&
		bytes[5] === 0x0a &&
		bytes[6] === 0x1a &&
		bytes[7] === 0x0a
	) {
		const width = dv.getUint32(16, false);
		const height = dv.getUint32(20, false);
		return width > 0 && height > 0 ? { width, height } : null;
	}

	// GIF: GIF87a / GIF89a, width@6 LE, height@8 LE
	if (bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x38) {
		const width = dv.getUint16(6, true);
		const height = dv.getUint16(8, true);
		return width > 0 && height > 0 ? { width, height } : null;
	}

	// BMP: BM, DIB header at 14
	if (bytes.length >= 26 && bytes[0] === 0x42 && bytes[1] === 0x4d) {
		const dibSize = dv.getUint32(14, true);
		if (dibSize >= 40) {
			const width = Math.abs(dv.getInt32(18, true));
			const height = Math.abs(dv.getInt32(22, true));
			return width > 0 && height > 0 ? { width, height } : null;
		}
		if (dibSize === 12) {
			const width = dv.getUint16(18, true);
			const height = dv.getUint16(20, true);
			return width > 0 && height > 0 ? { width, height } : null;
		}
	}

	// JPEG: FF D8 ... SOF0..SOF15 (except DHT=C4, JPG=C8, DAC=CC)
	if (bytes[0] === 0xff && bytes[1] === 0xd8) {
		let pos = 2;
		while (pos + 3 < bytes.length) {
			if (bytes[pos] !== 0xff) {
				pos++;
				continue;
			}
			while (pos < bytes.length && bytes[pos] === 0xff) pos++;
			if (pos >= bytes.length) break;
			const marker = bytes[pos++]!;
			if (marker === 0xd8 || marker === 0xd9 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;
			if (pos + 1 >= bytes.length) break;
			const segLen = dv.getUint16(pos, false);
			if (segLen < 2) break;
			const isSof =
				(marker >= 0xc0 && marker <= 0xc3) ||
				(marker >= 0xc5 && marker <= 0xc7) ||
				(marker >= 0xc9 && marker <= 0xcb) ||
				(marker >= 0xcd && marker <= 0xcf);
			if (isSof && pos + 6 < bytes.length) {
				const height = dv.getUint16(pos + 3, false);
				const width = dv.getUint16(pos + 5, false);
				if (width > 0 && height > 0) return { width, height };
			}
			pos += segLen;
		}
	}

	return null;
}

/** Detects canonical image extension from binary header (or falls back to filename extension). */
function detectImageExt(bytes: Uint8Array, fallbackName: string): string | null {
	if (bytes.length >= 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return "png";
	if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "jpg";
	if (bytes.length >= 4 && bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x38) return "gif";
	if (bytes.length >= 2 && bytes[0] === 0x42 && bytes[1] === 0x4d) return "bmp";
	const rawExt = extname(fallbackName).replace(/^\./, "").toLowerCase();
	if (rawExt in IMAGE_MIME_BY_EXT) return rawExt === "jpeg" ? "jpg" : rawExt;
	return null;
}

function computeImageEmu(
	natural: { width: number; height: number } | null,
	widthPx?: number,
	heightPx?: number,
): { cx: number; cy: number } {
	const natW = natural && natural.width > 0 ? natural.width : 640;
	const natH = natural && natural.height > 0 ? natural.height : 400;
	let cx: number;
	let cy: number;
	if (widthPx && heightPx) {
		cx = widthPx * EMU_PER_PX;
		cy = heightPx * EMU_PER_PX;
	} else if (widthPx) {
		cx = widthPx * EMU_PER_PX;
		cy = Math.round(cx * (natH / natW));
	} else if (heightPx) {
		cy = heightPx * EMU_PER_PX;
		cx = Math.round(cy * (natW / natH));
	} else {
		cx = natW * EMU_PER_PX;
		cy = natH * EMU_PER_PX;
	}
	if (cx > MAX_IMAGE_EMU_W) {
		const ratio = MAX_IMAGE_EMU_W / cx;
		cx = MAX_IMAGE_EMU_W;
		cy = Math.round(cy * ratio);
	}
	if (cy > MAX_IMAGE_EMU_H) {
		const ratio = MAX_IMAGE_EMU_H / cy;
		cy = MAX_IMAGE_EMU_H;
		cx = Math.round(cx * ratio);
	}
	return { cx: Math.max(EMU_PER_PX, Math.round(cx)), cy: Math.max(EMU_PER_PX, Math.round(cy)) };
}

/** Parses optional Obsidian sizing suffix (`400`, `400x250`, `My caption|400`) without treating bare width numbers as alt text. */
function parseSizeAndAlt(raw: string): { alt: string; width?: number; height?: number } {
	const trimmed = raw.trim();
	if (!trimmed) return { alt: "" };
	const direct = /^(\d{1,5})(?:x(\d{1,5}))?$/i.exec(trimmed);
	if (direct) {
		const width = Number(direct[1]);
		const height = direct[2] ? Number(direct[2]) : undefined;
		return { alt: "", width: width > 0 ? width : undefined, height: height && height > 0 ? height : undefined };
	}
	const pipeAt = trimmed.lastIndexOf("|");
	if (pipeAt >= 0) {
		const tail = trimmed.slice(pipeAt + 1).trim();
		const m = /^(\d{1,5})(?:x(\d{1,5}))?$/i.exec(tail);
		if (m) {
			const width = Number(m[1]);
			const height = m[2] ? Number(m[2]) : undefined;
			return {
				alt: trimmed.slice(0, pipeAt).trim(),
				width: width > 0 ? width : undefined,
				height: height && height > 0 ? height : undefined,
			};
		}
	}
	return { alt: trimmed };
}

const ESCAPES_RELATIVE = /^\.\.(?:[\\/]|$)/;

export function isWithinRoot(rootDir: string, candidate: string): boolean {
	const resolvedRoot = resolve(rootDir);
	const resolvedCand = resolve(candidate);
	const rel = relative(resolvedRoot, resolvedCand);
	if (ESCAPES_RELATIVE.test(rel) || isAbsolute(rel)) return false;
	try {
		const realRoot = realpathSync(resolvedRoot);
		const realCand = realpathSync(resolvedCand);
		const realRel = relative(realRoot, realCand);
		if (ESCAPES_RELATIVE.test(realRel) || isAbsolute(realRel)) return false;
	} catch {
		// Fall back to lexical check when realpathSync isn't applicable.
	}
	return true;
}

// --- Docx build context (relationships, media, footnotes) --------------------

type RunStyle = {
	bold?: boolean;
	italic?: boolean;
	strike?: boolean;
	highlight?: boolean;
	code?: boolean;
	math?: boolean;
	color?: string;
	underline?: boolean;
	superscript?: boolean;
};

type DocxRel = {
	id: string;
	type: string;
	target: string;
	external?: boolean;
};

const SVG_WEBP_EXT_RE = /\.(?:svg|webp)$/i;
const SVG_WEBP_DATA_RE = /^data:image\/(?:svg\+xml|webp)[;,]/i;

function isUnrasterizedVectorOrWebp(rawRef: string): boolean {
	const trimmed = rawRef.trim();
	if (SVG_WEBP_DATA_RE.test(trimmed)) return true;
	const clean = (trimmed.split(/[?#]/)[0] ?? trimmed).trim();
	return SVG_WEBP_EXT_RE.test(clean);
}

function resolveFolderUnderRoot(workspaceRoot: string | undefined, folder: string | undefined): string | null {
	const clean = folder?.trim();
	if (!clean) return null;
	if (isAbsolute(clean)) return resolve(clean);
	if (workspaceRoot) return resolve(workspaceRoot, clean);
	return null;
}

type DocxContext = {
	baseDir?: string;
	workspaceRoot?: string;
	attachmentsFolder?: string;
	docsFolder?: string;
	mermaidPngs?: Record<string, string>;
	rasterizedImages?: Record<string, string>;
	mermaidIndex: number;
	rels: DocxRel[];
	hyperlinkRelByUrl: Map<string, string>;
	mediaEntries: { name: string; data: Uint8Array; ext: string }[];
	mediaRelByKey: Map<string, { rId: string; fileName: string; natural: { width: number; height: number } | null }>;
	nextRelNum: number;
	nextDrawingId: number;
	footnotes: Map<string, string>;
	footnoteOrder: string[];
	addRel(type: string, target: string, external?: boolean): string;
	addHyperlink(url: string): string;
	refFootnote(id: string): number;
	embedImageBytes(
		bytes: Uint8Array,
		nameHint: string,
		alt: string,
		widthPx?: number,
		heightPx?: number,
		dedupeKey?: string,
	): string | null;
	embedLocalImage(rawRef: string, alt: string, widthPx?: number, heightPx?: number): string | null;
	embedMermaid(source: string): string | null;
};

function lookupRasterizedPayload(
	map: Record<string, string> | undefined,
	rawRef: string,
	cleanPath: string,
): string | null {
	if (!map) return null;
	const base = basename(cleanPath);
	const direct = map[rawRef] ?? map[cleanPath] ?? map[base];
	if (direct) return direct;
	const targets = new Set([rawRef.toLowerCase(), cleanPath.toLowerCase(), base.toLowerCase()]);
	for (const [k, v] of Object.entries(map)) {
		if (!v) continue;
		const normK = k.trim().replace(/\\/g, "/").toLowerCase();
		if (targets.has(normK) || targets.has(basename(normK))) return v;
	}
	return null;
}

const MAX_EMBED_IMAGE_BYTES = 20 * 1024 * 1024;
const MAX_EMBED_BASE64_CHARS = Math.ceil((MAX_EMBED_IMAGE_BYTES * 4) / 3) + 64;

function createDocxContext(
	options: DocxBuildOptions,
	footnotes: Map<string, string>,
): DocxContext {
	const ctx: DocxContext = {
		baseDir: options.baseDir,
		workspaceRoot: options.workspaceRoot,
		attachmentsFolder: options.attachmentsFolder,
		docsFolder: options.docsFolder,
		mermaidPngs: options.mermaidPngs,
		rasterizedImages: options.rasterizedImages,
		mermaidIndex: 0,
		rels: [
			{
				id: "rId1",
				type: "http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles",
				target: "styles.xml",
			},
		],
		hyperlinkRelByUrl: new Map(),
		mediaEntries: [],
		mediaRelByKey: new Map(),
		nextRelNum: 2,
		nextDrawingId: 1,
		footnotes,
		footnoteOrder: [],

		addRel(type: string, target: string, external = false): string {
			const id = `rId${ctx.nextRelNum++}`;
			ctx.rels.push({ id, type, target, ...(external ? { external: true } : {}) });
			return id;
		},

		addHyperlink(url: string): string {
			const existing = ctx.hyperlinkRelByUrl.get(url);
			if (existing) return existing;
			const id = ctx.addRel("http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink", url, true);
			ctx.hyperlinkRelByUrl.set(url, id);
			return id;
		},

		refFootnote(id: string): number {
			let idx = ctx.footnoteOrder.indexOf(id);
			if (idx < 0) {
				ctx.footnoteOrder.push(id);
				idx = ctx.footnoteOrder.length - 1;
			}
			return idx + 1;
		},

		embedImageBytes(bytes, nameHint, alt, widthPx, heightPx, dedupeKey) {
			if (!bytes.length || bytes.length > MAX_EMBED_IMAGE_BYTES) return null;
			const ext = detectImageExt(bytes, nameHint);
			if (!ext) return null;
			let rec = dedupeKey ? ctx.mediaRelByKey.get(dedupeKey) : undefined;
			if (!rec) {
				const mediaNum = ctx.mediaEntries.length + 1;
				const fileName = `image${mediaNum}.${ext}`;
				const rId = `rId${ctx.nextRelNum++}`;
				const natural = parseImageDimensions(bytes);
				ctx.mediaEntries.push({ name: `word/media/${fileName}`, data: bytes, ext });
				ctx.rels.push({
					id: rId,
					type: "http://schemas.openxmlformats.org/officeDocument/2006/relationships/image",
					target: `media/${fileName}`,
				});
				rec = { rId, fileName, natural };
				if (dedupeKey) ctx.mediaRelByKey.set(dedupeKey, rec);
			}
			const { cx, cy } = computeImageEmu(rec.natural, widthPx, heightPx);
			const docPrId = ctx.nextDrawingId++;
			const picId = ctx.nextDrawingId++;
			const safeName = xmlEsc(rec.fileName);
			const safeAlt = xmlEsc(alt || rec.fileName);
			return `<w:r><w:drawing><wp:inline distT="0" distB="0" distL="0" distR="0"><wp:extent cx="${cx}" cy="${cy}"/><wp:effectExtent l="0" t="0" r="0" b="0"/><wp:docPr id="${docPrId}" name="${safeName}" descr="${safeAlt}"/><wp:cNvGraphicFramePr><a:graphicFrameLocks noChangeAspect="1"/></wp:cNvGraphicFramePr><a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:pic><pic:nvPicPr><pic:cNvPr id="${picId}" name="${safeName}" descr="${safeAlt}"/><pic:cNvPicPr/></pic:nvPicPr><pic:blipFill><a:blip r:embed="${rec.rId}"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill><pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="${cx}" cy="${cy}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></pic:spPr></pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing></w:r>`;
		},

		embedLocalImage(rawRef, alt, widthPx, heightPx) {
			const trimmed = rawRef.trim();
			if (!trimmed) return null;

			const withoutFrag = trimmed.split(/[?#]/)[0] ?? trimmed;
			let decoded = withoutFrag;
			try {
				decoded = decodeURIComponent(withoutFrag);
			} catch {
				// Keep raw string when percent-encoding is partial.
			}
			const clean = decoded.replace(/\\/g, "/").trim();

			// Consult pre-rasterized PNG payloads first (essential for `.svg` / `.webp` images).
			const rasterRaw = lookupRasterizedPayload(ctx.rasterizedImages, trimmed, clean);
			if (rasterRaw) {
				const b64 = rasterRaw.replace(/^data:image\/[a-z0-9.+-]+;base64,/i, "").replace(/\s+/g, "");
				if (b64 && b64.length <= MAX_EMBED_BASE64_CHARS) {
					try {
						const bytes = Uint8Array.from(Buffer.from(b64, "base64"));
						const embedded = ctx.embedImageBytes(
							bytes,
							`${basename(clean) || "image"}.png`,
							alt,
							widthPx,
							heightPx,
							`raster:${clean.toLowerCase()}`,
						);
						if (embedded) return embedded;
					} catch {
						// Fall through to disk resolution.
					}
				}
			}

			if (/^https?:\/\//i.test(trimmed)) return null;

			// Support inline base64 data URLs (`data:image/png;base64,...`).
			const dataMatch = /^data:image\/(png|jpe?g|gif|bmp);base64,([A-Za-z0-9+/=\s]+)$/i.exec(trimmed);
			if (dataMatch) {
				try {
					const cleanB64 = dataMatch[2]!.replace(/\s+/g, "");
					if (!cleanB64 || cleanB64.length > MAX_EMBED_BASE64_CHARS) return null;
					const bytes = Uint8Array.from(Buffer.from(cleanB64, "base64"));
					return ctx.embedImageBytes(bytes, `inline.${dataMatch[1]!.toLowerCase()}`, alt, widthPx, heightPx);
				} catch {
					return null;
				}
			}

			const boundary = ctx.workspaceRoot || ctx.baseDir;
			if (!boundary || !clean) return null;

			const attachDir = resolveFolderUnderRoot(ctx.workspaceRoot, ctx.attachmentsFolder);
			const docsDir = resolveFolderUnderRoot(ctx.workspaceRoot, ctx.docsFolder);

			const candidates: string[] = [];
			const pushCand = (p: string) => {
				const resolved = resolve(p);
				if (!candidates.includes(resolved)) candidates.push(resolved);
			};

			if (clean.startsWith("/")) {
				if (ctx.workspaceRoot) pushCand(join(ctx.workspaceRoot, clean.slice(1)));
			} else {
				if (ctx.baseDir) {
					pushCand(resolve(ctx.baseDir, clean));
					pushCand(join(ctx.baseDir, "attachments", clean));
					pushCand(join(ctx.baseDir, "assets", clean));
				}
				if (attachDir) {
					pushCand(resolve(attachDir, clean));
					pushCand(join(attachDir, basename(clean)));
				}
				if (docsDir) {
					pushCand(resolve(docsDir, clean));
					pushCand(join(docsDir, "attachments", clean));
					pushCand(join(docsDir, "attachments", basename(clean)));
				}
				if (ctx.workspaceRoot) {
					pushCand(join(ctx.workspaceRoot, "docs", "attachments", clean));
					pushCand(join(ctx.workspaceRoot, "docs", "attachments", basename(clean)));
					pushCand(join(ctx.workspaceRoot, clean));
					pushCand(join(ctx.workspaceRoot, "assets", clean));
				}
			}

			for (const cand of candidates) {
				if (!isWithinRoot(boundary, cand)) continue;
				try {
					if (!existsSync(cand)) continue;
					const st = statSync(cand);
					if (!st.isFile() || st.size > MAX_EMBED_IMAGE_BYTES) continue;
					const bytes = new Uint8Array(readFileSync(cand));
					return ctx.embedImageBytes(bytes, basename(cand), alt, widthPx, heightPx, `file:${resolve(cand)}`);
				} catch {
					// Try next candidate.
				}
			}
			return null;
		},

		embedMermaid(source) {
			const idx = ctx.mermaidIndex++;
			const map = ctx.mermaidPngs;
			if (!map) return null;
			const trimmed = source.trim();
			const raw = map[trimmed] ?? map[`mermaid-${idx}`];
			if (!raw) return null;
			const b64 = raw.replace(/^data:image\/png;base64,/i, "").replace(/\s+/g, "");
			if (!b64 || b64.length > MAX_EMBED_BASE64_CHARS) return null;
			try {
				const bytes = Uint8Array.from(Buffer.from(b64, "base64"));
				return ctx.embedImageBytes(bytes, `mermaid-${idx}.png`, `Diagram ${idx + 1}`, undefined, undefined, `mermaid:${idx}`);
			} catch {
				return null;
			}
		},
	};
	return ctx;
}

// --- Markdown -> WordprocessingML runs & blocks ------------------------------

function buildRPr(style: RunStyle): string {
	const parts: string[] = [];
	if (style.code || style.math) {
		parts.push('<w:rFonts w:ascii="Consolas" w:hAnsi="Consolas"/>');
		parts.push(`<w:sz w:val="${style.math ? "20" : "19"}"/>`);
		parts.push(`<w:shd w:val="clear" w:color="auto" w:fill="${style.math ? "F8FAFC" : "F4F4F5"}"/>`);
	}
	if (style.bold) parts.push("<w:b/>");
	if (style.italic) parts.push("<w:i/>");
	if (style.strike) parts.push("<w:strike/>");
	if (style.color) parts.push(`<w:color w:val="${style.color}"/>`);
	if (style.underline) parts.push('<w:u w:val="single"/>');
	if (style.highlight) parts.push('<w:highlight w:val="yellow"/>');
	if (style.superscript) {
		parts.push('<w:vertAlign w:val="superscript"/>');
		parts.push('<w:sz w:val="16"/>');
	}
	return parts.length ? `<w:rPr>${parts.join("")}</w:rPr>` : "";
}

function textRun(text: string, style: RunStyle = {}): string {
	if (!text) return "";
	return `<w:r>${buildRPr(style)}<w:t xml:space="preserve">${xmlEsc(text)}</w:t></w:r>`;
}

const isWordChar = (ch: string | undefined) => Boolean(ch && /[A-Za-z0-9_]/.test(ch));

/** Finds closing index of inline `$...$` or `$$...$$` math starting at `openIdx`, or -1 if not a valid math span. */
function findMathClose(text: string, openIdx: number): { close: number; delimLen: 1 | 2 } | null {
	if (text[openIdx] !== "$") return null;
	if (text[openIdx + 1] === "$") {
		let j = openIdx + 2;
		while (j < text.length - 1) {
			if (text[j] === "\\" && j + 1 < text.length) {
				j += 2;
				continue;
			}
			if (text[j] === "$" && text[j + 1] === "$") {
				return j > openIdx + 2 ? { close: j, delimLen: 2 } : null;
			}
			j++;
		}
		return null;
	}
	// Single-dollar inline math: opening `$` cannot be followed by whitespace, closing `$` cannot be preceded by whitespace or followed by a digit (currency safe).
	if (openIdx + 1 >= text.length || /\s/.test(text[openIdx + 1]!)) return null;
	let j = openIdx + 1;
	while (j < text.length) {
		if (text[j] === "\\" && j + 1 < text.length) {
			j += 2;
			continue;
		}
		if (text[j] === "$") {
			if (text[j + 1] === "$") {
				j += 2;
				continue;
			}
			if (j > openIdx + 1 && !/\s/.test(text[j - 1]!) && !/\d/.test(text[j + 1] ?? "")) {
				return { close: j, delimLen: 1 };
			}
			return null;
		}
		j++;
	}
	return null;
}

/** Finds the closing delimiter `delim` starting at `start`, enforcing CommonMark non-space & optional word boundaries. */
function findDelimClose(text: string, start: number, delim: string, wordBounded = false): number {
	if (start >= text.length || /\s/.test(text[start]!)) return -1;
	let i = start;
	while (i <= text.length - delim.length) {
		if (text[i] === "\\" && i + 1 < text.length) {
			i += 2;
			continue;
		}
		if (text[i] === "`") {
			let run = 0;
			while (i + run < text.length && text[i + run] === "`") run++;
			const endCode = text.indexOf("`".repeat(run), i + run);
			if (endCode >= 0) {
				i = endCode + run;
				continue;
			}
			i += run;
			continue;
		}
		if (text[i] === "$") {
			const math = findMathClose(text, i);
			if (math) {
				i = math.close + math.delimLen;
				continue;
			}
		}
		if (text.startsWith(delim, i) && i > start && !/\s/.test(text[i - 1]!)) {
			// Avoid matching `***` as closing `**` or `*` when extra delimiter chars follow, unless exact.
			const after = text[i + delim.length];
			if (wordBounded && isWordChar(after)) {
				i++;
				continue;
			}
			return i;
		}
		i++;
	}
	return -1;
}

/** Finds matching `]` accounting for nested `[...]` and backslash escapes. */
function findBracketClose(text: string, openIdx: number): number {
	let depth = 0;
	for (let i = openIdx; i < text.length; i++) {
		if (text[i] === "\\" && i + 1 < text.length) {
			i++;
			continue;
		}
		if (text[i] === "[") depth++;
		else if (text[i] === "]") {
			depth--;
			if (depth === 0) return i;
		}
	}
	return -1;
}

/** Finds matching `)` for Markdown link destinations (handling balanced inner parens and optional `"title"`). */
function parseLinkDest(text: string, openParenIdx: number): { url: string; end: number } | null {
	if (text[openParenIdx] !== "(") return null;
	let i = openParenIdx + 1;
	while (i < text.length && /\s/.test(text[i]!)) i++;
	if (i >= text.length) return null;
	let url = "";
	if (text[i] === "<") {
		const closeAngle = text.indexOf(">", i + 1);
		if (closeAngle < 0) return null;
		url = text.slice(i + 1, closeAngle).trim();
		i = closeAngle + 1;
	} else {
		let depth = 0;
		const start = i;
		while (i < text.length) {
			const ch = text[i]!;
			if (ch === "\\" && i + 1 < text.length) {
				i += 2;
				continue;
			}
			if (ch === "(") depth++;
			else if (ch === ")") {
				if (depth === 0) break;
				depth--;
			} else if (/\s/.test(ch) && depth === 0) break;
			i++;
		}
		url = text.slice(start, i).trim();
	}
	while (i < text.length && /\s/.test(text[i]!)) i++;
	// Optional title `"..."` or `'...'`
	if (text[i] === '"' || text[i] === "'") {
		const q = text[i]!;
		i++;
		while (i < text.length && text[i] !== q) {
			if (text[i] === "\\" && i + 1 < text.length) i += 2;
			else i++;
		}
		if (i < text.length) i++;
		while (i < text.length && /\s/.test(text[i]!)) i++;
	}
	if (text[i] !== ")") return null;
	return { url, end: i + 1 };
}

function inlineRuns(text: string, ctx: DocxContext, baseStyle: RunStyle = {}): string {
	const out: string[] = [];
	let plain = "";
	const flush = () => {
		if (plain) {
			out.push(textRun(plain, baseStyle));
			plain = "";
		}
	};

	let i = 0;
	while (i < text.length) {
		const ch = text[i]!;

		// Backslash escape
		if (ch === "\\" && i + 1 < text.length && /[\\`*_{}[\]()#+\-.!~|=<>\\$]/.test(text[i + 1]!)) {
			plain += text[i + 1]!;
			i += 2;
			continue;
		}

		// Inline code span (any backtick run length)
		if (ch === "`") {
			let run = 0;
			while (i + run < text.length && text[i + run] === "`") run++;
			let j = i + run;
			let close = -1;
			while (j < text.length) {
				if (text[j] !== "`") {
					j++;
					continue;
				}
				let cRun = 0;
				while (j + cRun < text.length && text[j + cRun] === "`") cRun++;
				if (cRun === run) {
					close = j;
					break;
				}
				j += cRun;
			}
			if (close >= 0) {
				let inner = text.slice(i + run, close);
				if (inner.length >= 2 && inner.startsWith(" ") && inner.endsWith(" ") && /[^ ]/.test(inner)) {
					inner = inner.slice(1, -1);
				}
				flush();
				out.push(textRun(inner, { ...baseStyle, code: true }));
				i = close + run;
				continue;
			}
			plain += text.slice(i, i + run);
			i += run;
			continue;
		}

		// Inline `$...$` and `$$...$$` math — protected BEFORE `*`/`_` emphasis parsing!
		if (ch === "$") {
			const math = findMathClose(text, i);
			if (math) {
				const inner = text.slice(i + math.delimLen, math.close).trim();
				if (inner) {
					flush();
					out.push(textRun(inner, { ...baseStyle, math: true, italic: false }));
					i = math.close + math.delimLen;
					continue;
				}
			}
		}

		// Obsidian embed `![[target|spec]]`
		if (ch === "!" && text[i + 1] === "[" && text[i + 2] === "[") {
			const end = text.indexOf("]]", i + 3);
			if (end >= 0) {
				const inner = text.slice(i + 3, end).replace(/\\\|/g, "|");
				const pipe = inner.indexOf("|");
				const targetPart = (pipe >= 0 ? inner.slice(0, pipe) : inner).trim();
				const specPart = pipe >= 0 ? inner.slice(pipe + 1).trim() : "";
				const hashAt = targetPart.indexOf("#");
				const cleanTarget = (hashAt >= 0 ? targetPart.slice(0, hashAt) : targetPart).trim();
				const headingPart = hashAt >= 0 ? targetPart.slice(hashAt + 1).trim() : "";
				flush();
				if (EMBED_IMAGE_EXT_RE.test(cleanTarget)) {
					const parsed = parseSizeAndAlt(specPart);
					const fallbackLabel = parsed.alt || basename(cleanTarget);
					const drawing = ctx.embedLocalImage(cleanTarget, fallbackLabel, parsed.width, parsed.height);
					if (drawing) out.push(drawing);
					else if (isUnrasterizedVectorOrWebp(cleanTarget)) {
						out.push(textRun(`[Embedded vector/WebP: ${fallbackLabel}]`, { ...baseStyle, code: true, color: "52525B" }));
					} else out.push(textRun(`[Image: ${fallbackLabel}]`, baseStyle));
				} else {
					const parsed = parseSizeAndAlt(specPart);
					const label = parsed.alt || (headingPart ? `${cleanTarget} › ${headingPart}` : cleanTarget);
					out.push(textRun(label, baseStyle));
				}
				i = end + 2;
				continue;
			}
		}

		// Markdown image `![alt](url)`
		if (ch === "!" && text[i + 1] === "[") {
			const closeBr = findBracketClose(text, i + 1);
			if (closeBr >= 0 && text[closeBr + 1] === "(") {
				const dest = parseLinkDest(text, closeBr + 1);
				if (dest) {
					const rawAlt = text.slice(i + 2, closeBr);
					const parsed = parseSizeAndAlt(rawAlt);
					flush();
					const fallbackLabel = parsed.alt || basename(dest.url.split(/[?#]/)[0] ?? "");
					const drawing = ctx.embedLocalImage(dest.url, fallbackLabel, parsed.width, parsed.height);
					if (drawing) out.push(drawing);
					else if (isUnrasterizedVectorOrWebp(dest.url)) {
						out.push(textRun(`[Embedded vector/WebP: ${fallbackLabel || "image"}]`, { ...baseStyle, code: true, color: "52525B" }));
					} else out.push(textRun(fallbackLabel ? `[Image: ${fallbackLabel}]` : "[Image]", baseStyle));
					i = dest.end;
					continue;
				}
			}
		}

		// Wikilink `[[Target#Heading|Alias]]`
		if (ch === "[" && text[i + 1] === "[") {
			const end = text.indexOf("]]", i + 2);
			if (end >= 0) {
				const inner = text.slice(i + 2, end).replace(/\\\|/g, "|");
				const pipe = inner.indexOf("|");
				const targetPart = (pipe >= 0 ? inner.slice(0, pipe) : inner).trim();
				const alias = pipe >= 0 ? inner.slice(pipe + 1).trim() : "";
				const hashAt = targetPart.indexOf("#");
				const target = (hashAt >= 0 ? targetPart.slice(0, hashAt) : targetPart).trim();
				const heading = hashAt >= 0 ? targetPart.slice(hashAt + 1).trim() : "";
				const label = alias || (heading ? (target ? `${target} › ${heading}` : heading) : target);
				plain += label;
				i = end + 2;
				continue;
			}
		}

		// Footnote reference `[^id]`
		if (ch === "[" && text[i + 1] === "^") {
			const m = /^\[\^([^\]\s]+)\]/.exec(text.slice(i));
			if (m && ctx.footnotes.has(m[1]!)) {
				const n = ctx.refFootnote(m[1]!);
				flush();
				out.push(textRun(`[${n}]`, { ...baseStyle, superscript: true, color: "1D4ED8" }));
				i += m[0].length;
				continue;
			}
		}

		// Markdown link `[label](url)`
		if (ch === "[") {
			const closeBr = findBracketClose(text, i);
			if (closeBr >= 0 && text[closeBr + 1] === "(") {
				const dest = parseLinkDest(text, closeBr + 1);
				if (dest) {
					const label = text.slice(i + 1, closeBr);
					flush();
					if (/^(?:https?:|mailto:)/i.test(dest.url)) {
						const rId = ctx.addHyperlink(dest.url);
						const linkRuns = inlineRuns(label, ctx, { ...baseStyle, color: "1D4ED8", underline: true });
						out.push(`<w:hyperlink r:id="${rId}">${linkRuns}</w:hyperlink>`);
					} else {
						out.push(inlineRuns(label, ctx, baseStyle));
					}
					i = dest.end;
					continue;
				}
			}
		}

		// Autolink `<https://...>` or `<mailto:...>`
		if (ch === "<") {
			const m = /^<((?:https?:\/\/|mailto:)[^>\s]+)>/.exec(text.slice(i));
			if (m) {
				const url = m[1]!;
				const label = url.startsWith("mailto:") ? url.slice(7) : url;
				flush();
				const rId = ctx.addHyperlink(url);
				out.push(`<w:hyperlink r:id="${rId}">${textRun(label, { ...baseStyle, color: "1D4ED8", underline: true })}</w:hyperlink>`);
				i += m[0].length;
				continue;
			}
		}

		// Bold-italic `***...***` or `___...___`
		if ((ch === "*" && text.startsWith("***", i)) || (ch === "_" && text.startsWith("___", i) && !isWordChar(text[i - 1]))) {
			const delim = ch.repeat(3);
			const close = findDelimClose(text, i + 3, delim, ch === "_");
			if (close >= 0) {
				flush();
				out.push(inlineRuns(text.slice(i + 3, close), ctx, { ...baseStyle, bold: true, italic: true }));
				i = close + 3;
				continue;
			}
		}

		// Bold `**...**` or `__...__`
		if ((ch === "*" && text.startsWith("**", i)) || (ch === "_" && text.startsWith("__", i) && !isWordChar(text[i - 1]))) {
			const delim = ch.repeat(2);
			const close = findDelimClose(text, i + 2, delim, ch === "_");
			if (close >= 0) {
				flush();
				out.push(inlineRuns(text.slice(i + 2, close), ctx, { ...baseStyle, bold: true }));
				i = close + 2;
				continue;
			}
		}

		// Strikethrough `~~...~~`
		if (ch === "~" && text.startsWith("~~", i)) {
			const close = findDelimClose(text, i + 2, "~~");
			if (close >= 0) {
				flush();
				out.push(inlineRuns(text.slice(i + 2, close), ctx, { ...baseStyle, strike: true }));
				i = close + 2;
				continue;
			}
		}

		// Highlight `==...==`
		if (ch === "=" && text.startsWith("==", i)) {
			const close = findDelimClose(text, i + 2, "==");
			if (close >= 0) {
				flush();
				out.push(inlineRuns(text.slice(i + 2, close), ctx, { ...baseStyle, highlight: true }));
				i = close + 2;
				continue;
			}
		}

		// Italic `*...*` or `_..._`
		if (ch === "*" || (ch === "_" && !isWordChar(text[i - 1]))) {
			const close = findDelimClose(text, i + 1, ch, ch === "_");
			if (close >= 0) {
				flush();
				out.push(inlineRuns(text.slice(i + 1, close), ctx, { ...baseStyle, italic: true }));
				i = close + 1;
				continue;
			}
		}

		plain += ch;
		i++;
	}

	flush();
	return out.join("");
}

function paragraph(runs: string, style?: string, extraPPr = ""): string {
	const pPr = style || extraPPr ? `<w:pPr>${style ? `<w:pStyle w:val="${style}"/>` : ""}${extraPPr}</w:pPr>` : "";
	return `<w:p>${pPr}${runs}</w:p>`;
}

function calloutBox(kind: string, title: string, bodyLines: string[], ctx: DocxContext): string {
	const k = kind.toLowerCase();
	let border = "2563EB";
	let fill = "EFF6FF";
	if (/warn|caution|attention/.test(k)) (border = "D97706"), (fill = "FFFBEB");
	else if (/danger|error|bug|fail/.test(k)) (border = "DC2626"), (fill = "FEF2F2");
	else if (/tip|hint|success|check|done|ok/.test(k)) (border = "16A34A"), (fill = "F0FDF4");
	else if (/important|abstract|summary/.test(k)) (border = "7C3AED"), (fill = "F5F3FF");
	else if (/quote|cite/.test(k)) (border = "64748B"), (fill = "F8FAFC");

	const titleP = paragraph(
		`<w:r><w:rPr><w:b/><w:color w:val="${border}"/></w:rPr><w:t xml:space="preserve">${xmlEsc(title || kind.toUpperCase())}</w:t></w:r>`,
		undefined,
		`<w:spacing w:before="60" w:after="60"/>`,
	);
	const bodyXml = renderMarkdownBlocks(bodyLines, ctx, { compact: true }).join("");
	return `<w:tbl><w:tblPr><w:tblW w:w="9360" w:type="dxa"/><w:tblBorders><w:top w:val="single" w:sz="4" w:color="CBD5E1"/><w:bottom w:val="single" w:sz="4" w:color="CBD5E1"/><w:right w:val="single" w:sz="4" w:color="CBD5E1"/><w:left w:val="single" w:sz="24" w:color="${border}"/></w:tblBorders><w:tblCellMar><w:top w:w="100" w:type="dxa"/><w:bottom w:w="100" w:type="dxa"/><w:left w:w="160" w:type="dxa"/><w:right w:w="140" w:type="dxa"/></w:tblCellMar></w:tblPr><w:tblGrid><w:gridCol w:w="9360"/></w:tblGrid><w:tr><w:tc><w:tcPr><w:shd w:val="clear" w:color="auto" w:fill="${fill}"/></w:tcPr>${titleP}${bodyXml || paragraph("")}</w:tc></w:tr></w:tbl>${paragraph("", undefined, `<w:spacing w:before="0" w:after="80"/>`)}`;
}

/** Ordinary `> blockquote`: clean left-bordered muted paragraphs (never a blue "Note" callout). */
function blockquoteXml(bodyLines: string[], ctx: DocxContext): string {
	const quotePPr = `<w:pBdr><w:left w:val="single" w:sz="18" w:space="12" w:color="94A3B8"/></w:pBdr><w:shd w:val="clear" w:color="auto" w:fill="F8FAFC"/><w:ind w:left="360" w:right="180"/>`;
	const inner = renderMarkdownBlocks(bodyLines, ctx, {
		compact: true,
		quotePPr,
		baseStyle: { color: "475569" },
	});
	return `${inner.join("\n")}\n${paragraph("", undefined, `<w:spacing w:before="0" w:after="80"/>`)}`;
}

function codeBox(codeLines: string[], widthDxa = 9360): string {
	const ps = codeLines
		.map(
			(l) =>
				`<w:p><w:pPr><w:spacing w:before="0" w:after="0" w:line="240" w:lineRule="auto"/></w:pPr><w:r><w:rPr><w:rFonts w:ascii="Consolas" w:hAnsi="Consolas"/><w:sz w:val="18"/></w:rPr><w:t xml:space="preserve">${xmlEsc(l || " ")}</w:t></w:r></w:p>`,
		)
		.join("");
	return `<w:tbl><w:tblPr><w:tblW w:w="${widthDxa}" w:type="dxa"/><w:tblBorders><w:top w:val="single" w:sz="4" w:color="E2E8F0"/><w:bottom w:val="single" w:sz="4" w:color="E2E8F0"/><w:left w:val="single" w:sz="4" w:color="E2E8F0"/><w:right w:val="single" w:sz="4" w:color="E2E8F0"/></w:tblBorders><w:tblCellMar><w:top w:w="90" w:type="dxa"/><w:bottom w:w="90" w:type="dxa"/><w:left w:w="140" w:type="dxa"/><w:right w:w="140" w:type="dxa"/></w:tblCellMar></w:tblPr><w:tblGrid><w:gridCol w:w="${widthDxa}"/></w:tblGrid><w:tr><w:tc><w:tcPr><w:shd w:val="clear" w:color="auto" w:fill="F8FAFC"/></w:tcPr>${ps || paragraph("")}</w:tc></w:tr></w:tbl>${paragraph("", undefined, `<w:spacing w:before="0" w:after="80"/>`)}`;
}

/** Splits a GFM pipe table row on unescaped `|` outside backtick code spans of any run length. */
function splitPipeRow(line: string): string[] {
	let s = line.trim();
	if (s.startsWith("|")) s = s.slice(1);
	if (s.endsWith("|") && !s.endsWith("\\|")) s = s.slice(0, -1);
	const cells: string[] = [];
	let cur = "";
	let codeRun = 0;
	for (let i = 0; i < s.length; i++) {
		const ch = s[i]!;
		if (codeRun === 0 && ch === "\\" && s[i + 1] === "|") {
			cur += "|";
			i++;
			continue;
		}
		if (ch === "`") {
			let run = 0;
			while (i + run < s.length && s[i + run] === "`") run++;
			cur += "`".repeat(run);
			if (codeRun === 0) codeRun = run;
			else if (codeRun === run) codeRun = 0;
			i += run - 1;
			continue;
		}
		if (ch === "|" && codeRun === 0) {
			cells.push(cur.trim());
			cur = "";
			continue;
		}
		cur += ch;
	}
	cells.push(cur.trim());
	return cells;
}

function mathDisplayBlock(mathLines: string[]): string {
	const cleanLines = mathLines.map((l) => l.trim()).filter((l) => l.length > 0);
	const runs = cleanLines
		.map(
			(l, idx) =>
				`${idx > 0 ? "<w:r><w:br/></w:r>" : ""}<w:r><w:rPr><w:rFonts w:ascii="Consolas" w:hAnsi="Consolas"/><w:sz w:val="21"/><w:color w:val="1E293B"/></w:rPr><w:t xml:space="preserve">${xmlEsc(l)}</w:t></w:r>`,
		)
		.join("");
	return paragraph(
		runs,
		undefined,
		`<w:jc w:val="center"/><w:shd w:val="clear" w:color="auto" w:fill="F8FAFC"/><w:pBdr><w:top w:val="single" w:sz="4" w:space="6" w:color="E2E8F0"/><w:bottom w:val="single" w:sz="4" w:space="6" w:color="E2E8F0"/></w:pBdr><w:spacing w:before="100" w:after="120"/>`,
	);
}

function unrasterizedImageBox(label: string, rawRef: string): string {
	const ext = extname((rawRef.split(/[?#]/)[0] ?? rawRef).trim()).replace(/^\./, "").toUpperCase() || "IMAGE";
	const titleP = paragraph(
		`<w:r><w:rPr><w:b/><w:color w:val="475569"/></w:rPr><w:t xml:space="preserve">${xmlEsc(`Image (${ext}): ${label}`)}</w:t></w:r>`,
		undefined,
		`<w:spacing w:before="40" w:after="40"/>`,
	);
	const noteP = paragraph(
		`<w:r><w:rPr><w:color w:val="64748B"/><w:sz w:val="19"/></w:rPr><w:t xml:space="preserve">${xmlEsc(`Source: ${rawRef} — pre-rasterize to PNG to embed inline in Word.`)}</w:t></w:r>`,
		undefined,
		`<w:spacing w:before="0" w:after="40"/>`,
	);
	return `<w:tbl><w:tblPr><w:tblW w:w="9360" w:type="dxa"/><w:tblBorders><w:top w:val="single" w:sz="4" w:color="CBD5E1"/><w:bottom w:val="single" w:sz="4" w:color="CBD5E1"/><w:right w:val="single" w:sz="4" w:color="CBD5E1"/><w:left w:val="single" w:sz="18" w:color="64748B"/></w:tblBorders><w:tblCellMar><w:top w:w="90" w:type="dxa"/><w:bottom w:w="90" w:type="dxa"/><w:left w:w="150" w:type="dxa"/><w:right w:w="140" w:type="dxa"/></w:tblCellMar></w:tblPr><w:tblGrid><w:gridCol w:w="9360"/></w:tblGrid><w:tr><w:trPr><w:cantSplit/></w:trPr><w:tc><w:tcPr><w:shd w:val="clear" w:color="auto" w:fill="F8FAFC"/></w:tcPr>${titleP}${noteP}</w:tc></w:tr></w:tbl>${paragraph("", undefined, `<w:spacing w:before="0" w:after="80"/>`)}`;
}

function tableXml(headers: string[], rows: string[][], ctx: DocxContext, compactMeta = false): string {
	const cols = Math.max(1, headers.length);
	const colW = compactMeta && cols === 2 ? [2400, 6960] : Array.from({ length: cols }, () => Math.floor(9360 / cols));
	const tblGrid = `<w:tblGrid>${colW.map((w) => `<w:gridCol w:w="${w}"/>`).join("")}</w:tblGrid>`;
	const makeCell = (text: string, colIdx: number, isHeader: boolean, shadedKey = false) =>
		`<w:tc><w:tcPr><w:tcW w:w="${colW[colIdx] ?? Math.floor(9360 / cols)}" w:type="dxa"/>${isHeader || shadedKey ? '<w:shd w:val="clear" w:color="auto" w:fill="F4F4F5"/>' : ""}</w:tcPr>${paragraph(
			isHeader
				? inlineRuns(text, ctx, { bold: true })
				: shadedKey
					? textRun(text, { bold: true, color: "3F3F46" })
					: inlineRuns(text, ctx),
			undefined,
			`<w:spacing w:before="40" w:after="40"/>`,
		)}</w:tc>`;

	const headerTr = compactMeta
		? ""
		: `<w:tr><w:trPr><w:tblHeader/><w:cantSplit/></w:trPr>${headers.map((h, ci) => makeCell(h, ci, true)).join("")}</w:tr>`;
	const bodyTrs = rows
		.map((r) => `<w:tr><w:trPr><w:cantSplit/></w:trPr>${headers.map((_, ci) => makeCell(r[ci] ?? "", ci, false, compactMeta && ci === 0)).join("")}</w:tr>`)
		.join("");
	return `<w:tbl><w:tblPr><w:tblW w:w="9360" w:type="dxa"/><w:tblBorders><w:top w:val="single" w:sz="4" w:color="D4D4D8"/><w:bottom w:val="single" w:sz="4" w:color="D4D4D8"/><w:left w:val="single" w:sz="4" w:color="D4D4D8"/><w:right w:val="single" w:sz="4" w:color="D4D4D8"/><w:insideH w:val="single" w:sz="4" w:color="E4E4E7"/><w:insideV w:val="single" w:sz="4" w:color="E4E4E7"/></w:tblBorders><w:tblCellMar><w:top w:w="60" w:type="dxa"/><w:bottom w:w="60" w:type="dxa"/><w:left w:w="100" w:type="dxa"/><w:right w:w="100" w:type="dxa"/></w:tblCellMar></w:tblPr>${tblGrid}${headerTr}${bodyTrs}</w:tbl>${paragraph("", undefined, `<w:spacing w:before="0" w:after="80"/>`)}`;
}

/** Strips GFM footnote definitions (`[^id]: text`) outside fenced code blocks and returns them in a Map. */
function extractFootnoteDefs(lines: string[]): { bodyLines: string[]; footnotes: Map<string, string> } {
	const footnotes = new Map<string, string>();
	const bodyLines: string[] = [];
	let fenceChar = "";
	let fenceLen = 0;
	for (let i = 0; i < lines.length; i++) {
		const line = lines[i]!;
		const f = /^[ \t]{0,3}(`{3,}|~{3,})/.exec(line);
		if (f) {
			if (!fenceChar) {
				fenceChar = f[1]![0]!;
				fenceLen = f[1]!.length;
			} else if (f[1]![0] === fenceChar && f[1]!.length >= fenceLen && /^[ \t]*$/.test(line.slice(f[0].length))) {
				fenceChar = "";
				fenceLen = 0;
			}
			bodyLines.push(line);
			continue;
		}
		if (fenceChar) {
			bodyLines.push(line);
			continue;
		}
		const dm = /^\[\^([^\]\s]+)\]:[ \t]*(.*)$/.exec(line);
		if (dm) {
			const id = dm[1]!;
			const parts = [dm[2]!.trim()];
			while (i + 1 < lines.length && /^(?: {2,}|\t)\S/.test(lines[i + 1]!)) {
				parts.push(lines[++i]!.trim());
			}
			footnotes.set(id, parts.filter(Boolean).join(" "));
			continue;
		}
		bodyLines.push(line);
	}
	return { bodyLines, footnotes };
}

type RenderBlockOptions = {
	compact?: boolean;
	quotePPr?: string;
	baseStyle?: RunStyle;
};

function renderMarkdownBlocks(lines: string[], ctx: DocxContext, opts: RenderBlockOptions = {}): string[] {
	const blocks: string[] = [];
	const quotePPr = opts.quotePPr ?? "";
	const quotePPrNoInd = quotePPr.replace(/<w:ind\b[^>]*\/>/g, "");
	const quoteRightAttr = quotePPr ? ' w:right="180"' : "";
	const baseStyle = opts.baseStyle ?? {};
	let i = 0;

	while (i < lines.length) {
		let line = lines[i]!;
		if (!line.trim()) {
			i++;
			continue;
		}
		// Strip HTML comments (preserving any trailing prose after closed `-->` on the same line)
		if (/^[ \t]*<!--/.test(line)) {
			const stripped = line.replace(/<!--[\s\S]*?-->/g, "");
			const openAt = stripped.indexOf("<!--");
			if (openAt >= 0) {
				const beforeOpen = stripped.slice(0, openAt).trim();
				i++;
				let trailing = "";
				while (i < lines.length) {
					const closeAt = lines[i]!.indexOf("-->");
					if (closeAt >= 0) {
						trailing = lines[i]!.slice(closeAt + 3).replace(/<!--[\s\S]*?-->/g, "").trim();
						i++;
						break;
					}
					i++;
				}
				const remainder = [beforeOpen, trailing].filter(Boolean).join(" ").trim();
				if (remainder) {
					const spacing = opts.compact ? `<w:spacing w:before="20" w:after="60"/>` : `<w:spacing w:before="40" w:after="120"/>`;
					blocks.push(paragraph(inlineRuns(remainder, ctx, baseStyle), undefined, `${quotePPr}${spacing}`));
				}
				continue;
			}
			if (!stripped.trim()) {
				i++;
				continue;
			}
			line = stripped.replace(/^[ \t]+/, "");
		}
		// Display math block (`$$...$$` single-line or multi-line `$$\n...\n$$`)
		const singleMath = /^[ \t]{0,3}\$\$(.+?)\$\$[ \t]*$/.exec(line);
		if (singleMath && singleMath[1]!.trim()) {
			blocks.push(mathDisplayBlock([singleMath[1]!.trim()]));
			i++;
			continue;
		}
		if (/^[ \t]{0,3}\$\$[ \t]*$/.test(line)) {
			i++;
			const mathLines: string[] = [];
			while (i < lines.length) {
				if (/^[ \t]{0,3}\$\$[ \t]*$/.test(lines[i]!)) {
					i++;
					break;
				}
				mathLines.push(lines[i]!);
				i++;
			}
			blocks.push(mathDisplayBlock(mathLines));
			continue;
		}
		// Fenced code block (including Mermaid PNG embedding!)
		const fence = /^[ \t]{0,3}(`{3,}|~{3,})[ \t]*([A-Za-z0-9_+-]*)(?:[ \t]+.*)?$/.exec(line);
		if (fence && !(fence[1]![0] === "`" && line.slice(line.indexOf(fence[1]!) + fence[1]!.length).includes("`"))) {
			const delim = fence[1]![0]!;
			const len = fence[1]!.length;
			const lang = fence[2]!.toLowerCase();
			i++;
			const code: string[] = [];
			while (i < lines.length) {
				if (new RegExp(`^[ \\t]{0,3}${delim}{${len},}[ \\t]*$`).test(lines[i]!)) {
					i++;
					break;
				}
				code.push(lines[i]!);
				i++;
			}
			if (lang === "mermaid" || lang === "mmd") {
				const drawing = ctx.embedMermaid(code.join("\n"));
				if (drawing) {
					blocks.push(paragraph(drawing, undefined, `<w:jc w:val="center"/><w:spacing w:before="80" w:after="120"/>`));
					continue;
				}
			}
			blocks.push(codeBox(code, opts.compact ? 8800 : 9360));
			continue;
		}
		// Callout block `> [!type] Title`
		const callout = /^[ \t]{0,3}>[ \t]*\[!([A-Za-z0-9_-]+)\][+-]?[ \t]*(.*)$/.exec(line);
		if (callout) {
			const kind = callout[1]!;
			const title = callout[2]!.trim() || kind;
			i++;
			const body: string[] = [];
			while (i < lines.length && /^[ \t]{0,3}>/.test(lines[i]!)) {
				body.push(lines[i]!.replace(/^[ \t]{0,3}>[ \t]?/, ""));
				i++;
			}
			blocks.push(calloutBox(kind, title, body, ctx));
			continue;
		}
		// Ordinary blockquote `> ...` (muted left-bordered, NEVER a blue "Note" callout)
		if (/^[ \t]{0,3}>/.test(line)) {
			const body: string[] = [line.replace(/^[ \t]{0,3}>[ \t]?/, "")];
			i++;
			while (i < lines.length && /^[ \t]{0,3}>/.test(lines[i]!)) {
				body.push(lines[i]!.replace(/^[ \t]{0,3}>[ \t]?/, ""));
				i++;
			}
			blocks.push(blockquoteXml(body, ctx));
			continue;
		}
		// Pipe table
		if (line.includes("|") && i + 1 < lines.length && /^[ \t]*\|?[ \t:|-]+\|[ \t:|-]*$/.test(lines[i + 1]!)) {
			const headers = splitPipeRow(line);
			i += 2;
			const rows: string[][] = [];
			while (i < lines.length && lines[i]!.includes("|") && lines[i]!.trim()) {
				rows.push(splitPipeRow(lines[i]!));
				i++;
			}
			blocks.push(tableXml(headers, rows, ctx));
			continue;
		}
		// Heading
		const heading = /^[ \t]{0,3}(#{1,6})[ \t]+(.+?)[ \t]*#*[ \t]*$/.exec(line);
		if (heading) {
			const lvl = Math.min(6, heading[1]!.length);
			blocks.push(paragraph(inlineRuns(heading[2]!.trim(), ctx), `Heading${lvl}`));
			i++;
			continue;
		}
		// Horizontal rule
		if (/^[ \t]*(?:[-*_][ \t]*){3,}$/.test(line)) {
			blocks.push(
				paragraph(
					"",
					undefined,
					`<w:pBdr><w:bottom w:val="single" w:sz="6" w:space="4" w:color="D4D4D8"/></w:pBdr><w:spacing w:before="120" w:after="120"/>`,
				),
			);
			i++;
			continue;
		}
		// Checklist item
		const task = /^([ \t]*)[-*+][ \t]+\[([ xX])\][ \t]+(.*)$/.exec(line);
		if (task) {
			const baseIndent = opts.quotePPr ? 540 : 360;
			const indent = Math.floor(task[1]!.length / 2) * 360 + baseIndent;
			const mark = task[2]!.toLowerCase() === "x" ? "☑ " : "☐ ";
			blocks.push(
				paragraph(
					inlineRuns(`${mark}${task[3]!}`, ctx, baseStyle),
					undefined,
					`${quotePPrNoInd}<w:ind w:left="${indent}"${quoteRightAttr} w:hanging="240"/><w:spacing w:before="20" w:after="40"/>`,
				),
			);
			i++;
			continue;
		}
		// Bullet item
		const bullet = /^([ \t]*)[-*+][ \t]+(.*)$/.exec(line);
		if (bullet) {
			const baseIndent = opts.quotePPr ? 540 : 360;
			const indent = Math.floor(bullet[1]!.length / 2) * 360 + baseIndent;
			blocks.push(
				paragraph(
					inlineRuns(`• ${bullet[2]!}`, ctx, baseStyle),
					undefined,
					`${quotePPrNoInd}<w:ind w:left="${indent}"${quoteRightAttr} w:hanging="240"/><w:spacing w:before="20" w:after="40"/>`,
				),
			);
			i++;
			continue;
		}
		// Numbered list item
		const ordered = /^([ \t]*)(\d+\.)[ \t]+(.*)$/.exec(line);
		if (ordered) {
			const baseIndent = opts.quotePPr ? 540 : 360;
			const indent = Math.floor(ordered[1]!.length / 2) * 360 + baseIndent;
			blocks.push(
				paragraph(
					inlineRuns(`${ordered[2]!} ${ordered[3]!}`, ctx, baseStyle),
					undefined,
					`${quotePPrNoInd}<w:ind w:left="${indent}"${quoteRightAttr} w:hanging="280"/><w:spacing w:before="20" w:after="40"/>`,
				),
			);
			i++;
			continue;
		}
		// Standalone image line (`![alt](path)` or `![[img.png|400]]`)
		if (/^[ \t]*(?:!\[[^\]]*\]\([^)]+\)|!\[\[[^[\]]+\]\])[ \t]*$/.test(line)) {
			const trimmedLine = line.trim();
			let handledBox = false;
			if (trimmedLine.startsWith("![[") && trimmedLine.endsWith("]]")) {
				const inner = trimmedLine.slice(3, -2).replace(/\\\|/g, "|");
				const pipe = inner.indexOf("|");
				const targetPart = (pipe >= 0 ? inner.slice(0, pipe) : inner).trim();
				const specPart = pipe >= 0 ? inner.slice(pipe + 1).trim() : "";
				const hashAt = targetPart.indexOf("#");
				const cleanTarget = (hashAt >= 0 ? targetPart.slice(0, hashAt) : targetPart).trim();
				if (EMBED_IMAGE_EXT_RE.test(cleanTarget) && isUnrasterizedVectorOrWebp(cleanTarget)) {
					const parsed = parseSizeAndAlt(specPart);
					const fallbackLabel = parsed.alt || basename(cleanTarget);
					const drawing = ctx.embedLocalImage(cleanTarget, fallbackLabel, parsed.width, parsed.height);
					if (drawing) {
						blocks.push(paragraph(drawing, undefined, `${quotePPr}<w:spacing w:before="80" w:after="120"/>`));
					} else {
						blocks.push(unrasterizedImageBox(fallbackLabel, cleanTarget));
					}
					handledBox = true;
				}
			} else if (trimmedLine.startsWith("![")) {
				const closeBr = findBracketClose(trimmedLine, 1);
				if (closeBr >= 0 && trimmedLine[closeBr + 1] === "(") {
					const dest = parseLinkDest(trimmedLine, closeBr + 1);
					if (dest && isUnrasterizedVectorOrWebp(dest.url)) {
						const parsed = parseSizeAndAlt(trimmedLine.slice(2, closeBr));
						const fallbackLabel = parsed.alt || basename(dest.url.split(/[?#]/)[0] ?? "") || "image";
						const drawing = ctx.embedLocalImage(dest.url, fallbackLabel, parsed.width, parsed.height);
						if (drawing) {
							blocks.push(paragraph(drawing, undefined, `${quotePPr}<w:spacing w:before="80" w:after="120"/>`));
						} else {
							blocks.push(unrasterizedImageBox(fallbackLabel, dest.url));
						}
						handledBox = true;
					}
				}
			}
			if (!handledBox) {
				blocks.push(paragraph(inlineRuns(trimmedLine, ctx, baseStyle), undefined, `${quotePPr}<w:spacing w:before="80" w:after="120"/>`));
			}
			i++;
			continue;
		}
		// Plain paragraph (coalesce consecutive plain lines)
		const paraLines: string[] = [line.trim()];
		i++;
		while (
			i < lines.length &&
			lines[i]!.trim() &&
			!/^[ \t]{0,3}(?:#{1,6}\s|>|`{3,}|~{3,}|\$\$|[-*+]\s|\d+\.\s|<!--)/.test(lines[i]!) &&
			!/^[ \t]*(?:!\[[^\]]*\]\([^)]+\)|!\[\[[^[\]]+\]\])[ \t]*$/.test(lines[i]!) &&
			!(lines[i]!.includes("|") && i + 1 < lines.length && /^[ \t]*\|?[ \t:|-]+\|[ \t:|-]*$/.test(lines[i + 1]!))
		) {
			paraLines.push(lines[i]!.trim());
			i++;
		}
		const spacing = opts.compact ? `<w:spacing w:before="20" w:after="60"/>` : `<w:spacing w:before="40" w:after="120"/>`;
		blocks.push(paragraph(inlineRuns(paraLines.join(" "), ctx, baseStyle), undefined, `${quotePPr}${spacing}`));
	}
	return blocks;
}

const META_FRONTMATTER_FIELDS: readonly [string, string][] = [
	["ticket", "Ticket"],
	["status", "Status"],
	["type", "Type"],
	["priority", "Priority"],
	["release", "Release"],
	["version", "Version"],
	["owner", "Owner"],
	["reviewer", "Reviewer"],
	["approved-by", "Approved by"],
	["approved-date", "Approved date"],
	["change-control", "Change control"],
	["gxp-impact", "GxP impact"],
	["parent", "Parent"],
	["with", "System"],
	["direction", "Direction"],
	["tags", "Tags"],
	["date", "Date"],
	["asked", "Asked"],
	["answered", "Answered"],
	["supersedes", "Supersedes"],
	["superseded-by", "Superseded by"],
];

function collectMetaRows(markdown: string, explicitMeta?: Record<string, string>): [string, string][] {
	const fmValues = frontMatter(markdown).values;
	const rows = new Map<string, [string, string]>();
	for (const [key, label] of META_FRONTMATTER_FIELDS) {
		const val = one(fmValues[key]);
		if (val) rows.set(label.toLowerCase(), [label, val]);
	}
	if (explicitMeta) {
		for (const [label, val] of Object.entries(explicitMeta)) {
			const cleanLabel = label.trim();
			const cleanVal = (val ?? "").trim();
			if (!cleanLabel || !cleanVal) continue;
			rows.set(cleanLabel.toLowerCase(), [cleanLabel, cleanVal]);
		}
	}
	return [...rows.values()];
}

function buildNormalizedMetaLookup(metaRows: readonly [string, string][], explicitMeta?: Record<string, string>): Map<string, string> {
	const normKey = (k: string) => k.trim().toLowerCase().replace(/[\s_-]+/g, "");
	const map = new Map<string, string>();
	for (const [k, v] of metaRows) {
		if (v.trim()) map.set(normKey(k), v.trim());
	}
	if (explicitMeta) {
		for (const [k, v] of Object.entries(explicitMeta)) {
			if ((v ?? "").trim()) map.set(normKey(k), v.trim());
		}
	}
	return map;
}

function buildHeaderXml(title: string, metaLookup: Map<string, string>): string {
	const ver = metaLookup.get("version") ?? "";
	const status = metaLookup.get("status") ?? "";
	const cc = metaLookup.get("changecontrol") ?? "";
	const verLabel = ver ? (/^v/i.test(ver) ? ver : `v${ver}`) : "";
	const rightText = [verLabel, status, cc].filter(Boolean).join(" · ");
	const rPr = `<w:rPr><w:color w:val="71717A"/><w:sz w:val="17"/></w:rPr>`;
	const rightRuns = rightText
		? `<w:r>${rPr}<w:tab/></w:r><w:r>${rPr}<w:t xml:space="preserve">${xmlEsc(rightText)}</w:t></w:r>`
		: "";
	return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:hdr xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
<w:p><w:pPr><w:tabs><w:tab w:val="right" w:pos="9360"/></w:tabs><w:pBdr><w:bottom w:val="single" w:sz="4" w:space="4" w:color="E4E4E7"/></w:pBdr><w:spacing w:before="0" w:after="60"/></w:pPr><w:r>${rPr}<w:t xml:space="preserve">${xmlEsc(title)}</w:t></w:r>${rightRuns}</w:p>
</w:hdr>`;
}

function buildFooterXml(generatedDate: string): string {
	const rPr = `<w:rPr><w:color w:val="71717A"/><w:sz w:val="17"/></w:rPr>`;
	const leftRun = generatedDate
		? `<w:r>${rPr}<w:t xml:space="preserve">${xmlEsc(`Generated ${generatedDate}`)}</w:t></w:r>`
		: "";
	return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:ftr xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
<w:p><w:pPr><w:tabs><w:tab w:val="right" w:pos="9360"/></w:tabs><w:pBdr><w:top w:val="single" w:sz="4" w:space="4" w:color="E4E4E7"/></w:pBdr><w:spacing w:before="60" w:after="0"/></w:pPr>${leftRun}<w:r>${rPr}<w:tab/></w:r><w:r>${rPr}<w:t xml:space="preserve">Page </w:t></w:r><w:r><w:fldChar w:fldCharType="begin"/></w:r><w:r>${rPr}<w:instrText xml:space="preserve"> PAGE </w:instrText></w:r><w:r><w:fldChar w:fldCharType="separate"/></w:r><w:r>${rPr}<w:t>1</w:t></w:r><w:r><w:fldChar w:fldCharType="end"/></w:r><w:r>${rPr}<w:t xml:space="preserve"> of </w:t></w:r><w:r><w:fldChar w:fldCharType="begin"/></w:r><w:r>${rPr}<w:instrText xml:space="preserve"> NUMPAGES </w:instrText></w:r><w:r><w:fldChar w:fldCharType="separate"/></w:r><w:r>${rPr}<w:t>1</w:t></w:r><w:r><w:fldChar w:fldCharType="end"/></w:r></w:p>
</w:ftr>`;
}

function buildCorePropsXml(title: string, metaLookup: Map<string, string>, createdDate: string): string {
	const creator = metaLookup.get("owner") || metaLookup.get("author") || metaLookup.get("approvedby") || "SSL Studio";
	const keywords = [
		metaLookup.get("tags") ?? "",
		metaLookup.get("ticket") ?? "",
		metaLookup.get("release") ?? "",
		metaLookup.get("changecontrol") ?? "",
	]
		.map((s) => s.trim())
		.filter(Boolean)
		.join(", ");
	const isoCreated = /^\d{4}-\d{2}-\d{2}$/.test(createdDate)
		? `${createdDate}T00:00:00Z`
		: new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
	return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:dcmitype="http://purl.org/dc/dcmitype/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
<dc:title>${xmlEsc(title)}</dc:title>
<dc:creator>${xmlEsc(creator)}</dc:creator>
<cp:keywords>${xmlEsc(keywords)}</cp:keywords>
<dcterms:created xsi:type="dcterms:W3CDTF">${xmlEsc(isoCreated)}</dcterms:created>
</cp:coreProperties>`;
}

function buildTocBlockXml(): string {
	const titleP = paragraph(
		textRun("Table of Contents", { bold: true, color: "18181B" }),
		undefined,
		`<w:pBdr><w:bottom w:val="single" w:sz="4" w:space="4" w:color="E4E4E7"/></w:pBdr><w:spacing w:before="120" w:after="80"/>`,
	);
	const fieldP = `<w:p><w:pPr><w:spacing w:before="40" w:after="160"/></w:pPr><w:r><w:fldChar w:fldCharType="begin"/></w:r><w:r><w:instrText xml:space="preserve"> TOC \\o "1-3" \\h \\z \\u </w:instrText></w:r><w:r><w:fldChar w:fldCharType="separate"/></w:r><w:r><w:rPr><w:i/><w:color w:val="71717A"/></w:rPr><w:t xml:space="preserve">Right-click and select Update Field in Word to populate table of contents.</w:t></w:r><w:r><w:fldChar w:fldCharType="end"/></w:r></w:p>`;
	return `${titleP}\n${fieldP}`;
}

export type DocxBuildOptions = {
	title: string;
	subtitle?: string;
	markdown: string;
	baseDir?: string;
	workspaceRoot?: string;
	attachmentsFolder?: string;
	docsFolder?: string;
	meta?: Record<string, string>;
	mermaidPngs?: Record<string, string>;
	rasterizedImages?: Record<string, string>;
	toc?: boolean;
	headerFooter?: boolean;
};

export type DocxParsedResult = {
	markdown: string;
	images: { name: string; bytes: Uint8Array }[];
	warnings?: string[];
};

/** Builds a valid `.docx` OpenXML binary archive from Markdown content. */
export function markdownToDocx(options: DocxBuildOptions): Uint8Array {
	const rawBody = frontMatter(options.markdown).body.replace(/\r\n/g, "\n");
	const { bodyLines, footnotes } = extractFootnoteDefs(rawBody.split("\n"));
	const ctx = createDocxContext(options, footnotes);
	const blocks: string[] = [];

	const metaRows = collectMetaRows(options.markdown, options.meta);
	const metaLookup = buildNormalizedMetaLookup(metaRows, options.meta);
	const firstNonEmpty = bodyLines.find((l) => l.trim().length > 0) ?? "";
	const bodyStartsWithH1 = /^[ \t]{0,3}#[ \t]+/.test(firstNonEmpty);

	if (options.subtitle) {
		blocks.push(paragraph(`<w:r><w:t xml:space="preserve">${xmlEsc(options.title)}</w:t></w:r>`, "Title"));
		blocks.push(
			paragraph(
				`<w:r><w:rPr><w:color w:val="52525B"/><w:sz w:val="20"/></w:rPr><w:t xml:space="preserve">${xmlEsc(options.subtitle)}</w:t></w:r>`,
				undefined,
				`<w:pBdr><w:bottom w:val="single" w:sz="6" w:space="6" w:color="E4E4E7"/></w:pBdr><w:spacing w:after="200"/>`,
			),
		);
	} else if (metaRows.length > 0 && options.title && !bodyStartsWithH1) {
		blocks.push(paragraph(`<w:r><w:t xml:space="preserve">${xmlEsc(options.title)}</w:t></w:r>`, "Title"));
	}

	if (metaRows.length > 0) {
		blocks.push(tableXml(["Property", "Value"], metaRows, ctx, true));
	}

	if (options.toc === true) {
		blocks.push(buildTocBlockXml());
	}

	blocks.push(...renderMarkdownBlocks(bodyLines, ctx));

	// Render GFM footnote definitions at the bottom when present.
	if (ctx.footnotes.size > 0) {
		for (const id of ctx.footnotes.keys()) ctx.refFootnote(id);
		blocks.push(
			paragraph(
				"",
				undefined,
				`<w:pBdr><w:bottom w:val="single" w:sz="6" w:space="4" w:color="D4D4D8"/></w:pBdr><w:spacing w:before="180" w:after="100"/>`,
			),
		);
		blocks.push(paragraph(textRun("Footnotes", { bold: true, color: "3F3F46" }), undefined, `<w:spacing w:before="40" w:after="80"/>`));
		ctx.footnoteOrder.forEach((id, idx) => {
			const defText = ctx.footnotes.get(id) ?? "";
			blocks.push(
				paragraph(
					`${textRun(`${idx + 1}. `, { bold: true, color: "52525B" })}${inlineRuns(defText, ctx, { color: "3F3F46" })}`,
					undefined,
					`<w:ind w:left="360" w:hanging="240"/><w:spacing w:before="20" w:after="40"/>`,
				),
			);
		});
	}

	const includeHeaderFooter = options.headerFooter !== false;
	const includeToc = options.toc === true;
	const dateFromSubtitle = /\b(\d{4}-\d{2}-\d{2})\b/.exec(options.subtitle ?? "")?.[1] ?? "";
	const generatedDate = metaLookup.get("date") || metaLookup.get("generated") || dateFromSubtitle || new Date().toISOString().slice(0, 10);

	let headerRelId = "";
	let footerRelId = "";
	if (includeHeaderFooter) {
		headerRelId = ctx.addRel("http://schemas.openxmlformats.org/officeDocument/2006/relationships/header", "header1.xml");
		footerRelId = ctx.addRel("http://schemas.openxmlformats.org/officeDocument/2006/relationships/footer", "footer1.xml");
	}
	if (includeToc) {
		ctx.addRel("http://schemas.openxmlformats.org/officeDocument/2006/relationships/settings", "settings.xml");
	}

	const sectHeaderFooter = includeHeaderFooter
		? `<w:headerReference w:type="default" r:id="${headerRelId}"/><w:footerReference w:type="default" r:id="${footerRelId}"/>`
		: "";
	const sectPgMar = includeHeaderFooter
		? `<w:pgMar w:top="1080" w:right="1080" w:bottom="1080" w:left="1080" w:header="540" w:footer="540"/>`
		: `<w:pgMar w:top="1080" w:right="1080" w:bottom="1080" w:left="1080"/>`;

	const documentXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture">
<w:body>
${blocks.join("\n")}
<w:sectPr>${sectHeaderFooter}<w:pgSz w:w="12240" w:h="15840"/>${sectPgMar}</w:sectPr>
</w:body>
</w:document>`;

	const stylesXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
<w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:ascii="Calibri" w:hAnsi="Calibri"/><w:sz w:val="21"/><w:color w:val="18181B"/></w:rPr></w:rPrDefault></w:docDefaults>
<w:style w:type="paragraph" w:styleId="Title"><w:name w:val="Title"/><w:pPr><w:spacing w:before="0" w:after="80"/></w:pPr><w:rPr><w:b/><w:sz w:val="36"/><w:color w:val="09090B"/></w:rPr></w:style>
<w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="heading 1"/><w:pPr><w:keepNext/><w:outlineLvl w:val="0"/><w:spacing w:before="260" w:after="100"/><w:pBdr><w:bottom w:val="single" w:sz="4" w:space="4" w:color="E4E4E7"/></w:pBdr></w:pPr><w:rPr><w:b/><w:sz w:val="32"/><w:color w:val="09090B"/></w:rPr></w:style>
<w:style w:type="paragraph" w:styleId="Heading2"><w:name w:val="heading 2"/><w:pPr><w:keepNext/><w:outlineLvl w:val="1"/><w:spacing w:before="220" w:after="80"/></w:pPr><w:rPr><w:b/><w:sz w:val="26"/><w:color w:val="18181B"/></w:rPr></w:style>
<w:style w:type="paragraph" w:styleId="Heading3"><w:name w:val="heading 3"/><w:pPr><w:keepNext/><w:outlineLvl w:val="2"/><w:spacing w:before="180" w:after="60"/></w:pPr><w:rPr><w:b/><w:sz w:val="23"/><w:color w:val="27272A"/></w:rPr></w:style>
<w:style w:type="paragraph" w:styleId="Heading4"><w:name w:val="heading 4"/><w:pPr><w:keepNext/><w:outlineLvl w:val="3"/><w:spacing w:before="140" w:after="40"/></w:pPr><w:rPr><w:b/><w:sz w:val="21"/><w:color w:val="3F3F46"/></w:rPr></w:style>
<w:style w:type="paragraph" w:styleId="Heading5"><w:name w:val="heading 5"/><w:pPr><w:keepNext/><w:outlineLvl w:val="4"/><w:spacing w:before="120" w:after="40"/></w:pPr><w:rPr><w:b/><w:sz w:val="20"/><w:color w:val="52525B"/></w:rPr></w:style>
<w:style w:type="paragraph" w:styleId="Heading6"><w:name w:val="heading 6"/><w:pPr><w:keepNext/><w:outlineLvl w:val="5"/><w:spacing w:before="100" w:after="40"/></w:pPr><w:rPr><w:b/><w:i/><w:sz w:val="20"/><w:color w:val="52525B"/></w:rPr></w:style>
</w:styles>`;

	const usedImageExts = [...new Set(ctx.mediaEntries.map((m) => m.ext))].sort();
	const imageDefaults = usedImageExts
		.filter((ext) => ext in IMAGE_MIME_BY_EXT)
		.map((ext) => `<Default Extension="${ext}" ContentType="${IMAGE_MIME_BY_EXT[ext]}"/>`)
		.join("\n");

	const overrides: string[] = [
		'<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>',
		'<Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>',
		'<Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>',
	];
	if (includeHeaderFooter) {
		overrides.push(
			'<Override PartName="/word/header1.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.header+xml"/>',
			'<Override PartName="/word/footer1.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.footer+xml"/>',
		);
	}
	if (includeToc) {
		overrides.push(
			'<Override PartName="/word/settings.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.settings+xml"/>',
		);
	}

	const contentTypesXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="xml" ContentType="application/xml"/>${imageDefaults ? `\n${imageDefaults}` : ""}
${overrides.join("\n")}
</Types>`;

	const rootRelsXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/>
</Relationships>`;

	const docRelsItems = ctx.rels
		.map(
			(rel) =>
				`<Relationship Id="${xmlEsc(rel.id)}" Type="${xmlEsc(rel.type)}" Target="${xmlEsc(rel.target)}"${rel.external ? ' TargetMode="External"' : ""}/>`,
		)
		.join("\n");

	const docRelsXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
${docRelsItems}
</Relationships>`;

	const coreXml = buildCorePropsXml(options.title, metaLookup, generatedDate);
	const enc = new TextEncoder();
	const zipEntries: { name: string; data: Uint8Array }[] = [
		{ name: "[Content_Types].xml", data: enc.encode(contentTypesXml) },
		{ name: "_rels/.rels", data: enc.encode(rootRelsXml) },
		{ name: "docProps/core.xml", data: enc.encode(coreXml) },
		{ name: "word/_rels/document.xml.rels", data: enc.encode(docRelsXml) },
		{ name: "word/styles.xml", data: enc.encode(stylesXml) },
		{ name: "word/document.xml", data: enc.encode(documentXml) },
	];
	if (includeHeaderFooter) {
		zipEntries.push(
			{ name: "word/header1.xml", data: enc.encode(buildHeaderXml(options.title, metaLookup)) },
			{ name: "word/footer1.xml", data: enc.encode(buildFooterXml(generatedDate)) },
		);
	}
	if (includeToc) {
		const settingsXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:settings xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
<w:updateFields w:val="true"/>
</w:settings>`;
		zipEntries.push({ name: "word/settings.xml", data: enc.encode(settingsXml) });
	}
	zipEntries.push(...ctx.mediaEntries.map((m) => ({ name: m.name, data: m.data })));
	return buildZip(zipEntries);
}

// --- Pure-TypeScript .docx -> Markdown reader --------------------------------

function xmlAttr(tag: string, name: string): string {
	const esc = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	const m = new RegExp(`\\b${esc}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`, "i").exec(tag);
	return xmlUnesc(m?.[1] ?? m?.[2] ?? "");
}

/**
 * Balanced-tag top-level child scanner for WordprocessingML.
 * Matches only exact element names (so `<w:p>` never matches `<w:pPr>` and `<w:tbl>` never matches `<w:tblPr>`).
 */
function extractDirectElements(xml: string, tagNames: readonly string[]): { tag: string; openTag: string; inner: string }[] {
	const out: { tag: string; openTag: string; inner: string }[] = [];
	const wanted = new Set(tagNames);
	let pos = 0;

	while (pos < xml.length) {
		const lt = xml.indexOf("<", pos);
		if (lt < 0) break;
		if (xml.startsWith("<!--", lt)) {
			const endComment = xml.indexOf("-->", lt + 4);
			pos = endComment < 0 ? xml.length : endComment + 3;
			continue;
		}
		if (xml.startsWith("<?", lt) || xml.startsWith("<!", lt)) {
			const gt = xml.indexOf(">", lt + 2);
			pos = gt < 0 ? xml.length : gt + 1;
			continue;
		}
		if (xml[lt + 1] === "/") {
			const gt = xml.indexOf(">", lt + 2);
			pos = gt < 0 ? xml.length : gt + 1;
			continue;
		}

		// Read element name up to whitespace, `>`, or `/`
		let nameEnd = lt + 1;
		while (nameEnd < xml.length && !/[\s/>]/.test(xml[nameEnd]!)) nameEnd++;
		const tagName = xml.slice(lt + 1, nameEnd);
		const gt = xml.indexOf(">", nameEnd);
		if (gt < 0) break;
		const selfClosing = xml[gt - 1] === "/";
		const openTag = xml.slice(lt, gt + 1);

		if (!wanted.has(tagName)) {
			pos = gt + 1;
			continue;
		}
		if (selfClosing) {
			out.push({ tag: tagName, openTag, inner: "" });
			pos = gt + 1;
			continue;
		}

		// Scan forward counting nested `<tagName ...>` vs `</tagName>`
		let depth = 1;
		let scan = gt + 1;
		let closeStart = -1;
		let closeEnd = -1;
		while (scan < xml.length && depth > 0) {
			const nextLt = xml.indexOf("<", scan);
			if (nextLt < 0) break;
			if (xml.startsWith("<!--", nextLt)) {
				const ec = xml.indexOf("-->", nextLt + 4);
				scan = ec < 0 ? xml.length : ec + 3;
				continue;
			}
			const nextGt = xml.indexOf(">", nextLt + 1);
			if (nextGt < 0) break;
			if (xml[nextLt + 1] === "/") {
				const closeName = xml.slice(nextLt + 2, nextGt).trim();
				if (closeName === tagName) {
					depth--;
					if (depth === 0) {
						closeStart = nextLt;
						closeEnd = nextGt + 1;
						break;
					}
				}
			} else if (xml[nextGt - 1] !== "/") {
				let innerNameEnd = nextLt + 1;
				while (innerNameEnd < nextGt && !/[\s/>]/.test(xml[innerNameEnd]!)) innerNameEnd++;
				if (xml.slice(nextLt + 1, innerNameEnd) === tagName) depth++;
			}
			scan = nextGt + 1;
		}
		if (closeStart < 0) {
			out.push({ tag: tagName, openTag, inner: xml.slice(gt + 1) });
			break;
		}
		out.push({ tag: tagName, openTag, inner: xml.slice(gt + 1, closeStart) });
		pos = closeEnd;
	}
	return out;
}

type ParsedRel = { target: string; type: string };

function parseRelationships(relsXml: string): Map<string, ParsedRel> {
	const map = new Map<string, ParsedRel>();
	for (const m of relsXml.matchAll(/<Relationship\b[^>]*\/?>/gi)) {
		const tag = m[0];
		const id = xmlAttr(tag, "Id");
		const target = xmlAttr(tag, "Target");
		const type = xmlAttr(tag, "Type");
		if (id && target) map.set(id, { target, type });
	}
	return map;
}

function hasEnabledFlag(rPr: string, tag: string): boolean {
	const re = new RegExp(`<w:${tag}(?:\\s+([^>]*))?\\s*/?>`, "i");
	const m = re.exec(rPr);
	if (!m) return false;
	const attrs = m[1] ?? "";
	const val = xmlAttr(`<x ${attrs}>`, "w:val").toLowerCase();
	if (val === "0" || val === "false" || val === "none") return false;
	return true;
}

type StyledSegment = {
	text: string;
	bold: boolean;
	italic: boolean;
	strike: boolean;
	code: boolean;
	highlight: boolean;
	raw?: boolean;
};

function formatSegments(segments: StyledSegment[], suppressBold = false): string {
	// Merge adjacent text segments with identical styles (Word splits runs on rsid/spellcheck).
	const merged: StyledSegment[] = [];
	for (const seg of segments) {
		if (!seg.text) continue;
		const prev = merged[merged.length - 1];
		if (
			prev &&
			!prev.raw &&
			!seg.raw &&
			prev.bold === seg.bold &&
			prev.italic === seg.italic &&
			prev.strike === seg.strike &&
			prev.code === seg.code &&
			prev.highlight === seg.highlight
		) {
			prev.text += seg.text;
		} else {
			merged.push({ ...seg });
		}
	}

	return merged
		.map((seg) => {
			if (seg.raw) return seg.text;
			const lead = /^\s*/.exec(seg.text)?.[0] ?? "";
			const trail = /\s*$/.exec(seg.text)?.[0] ?? "";
			const core = seg.text.slice(lead.length, seg.text.length - trail.length);
			if (!core) return seg.text;
			let out = core;
			if (seg.code) {
				let maxRun = 0;
				for (const m of out.matchAll(/`+/g)) {
					if (m[0].length > maxRun) maxRun = m[0].length;
				}
				const fence = "`".repeat(maxRun + 1);
				const padded = out.startsWith("`") || out.endsWith("`") ? ` ${out} ` : out;
				out = `${fence}${padded}${fence}`;
			} else {
				const bold = seg.bold && !suppressBold;
				if (bold && seg.italic) out = `***${out}***`;
				else if (bold) out = `**${out}**`;
				else if (seg.italic) out = `*${out}*`;
				if (seg.strike) out = `~~${out}~~`;
				if (seg.highlight) out = `==${out}==`;
			}
			return `${lead}${out}${trail}`;
		})
		.join("");
}

/**
 * Resolves OOXML `<mc:AlternateContent>` blocks so that when `<mc:Choice>` is present,
 * ONLY `<mc:Choice>` is retained and `<mc:Fallback>` is skipped — preventing duplicated
 * shapes, drawings, equations, or text boxes. Falls back to `<mc:Fallback>` when no Choice exists.
 */
function resolveAlternateContent(xml: string): string {
	if (!xml.includes("AlternateContent")) return xml;
	let out = "";
	let pos = 0;
	while (pos < xml.length) {
		const lt = xml.indexOf("<", pos);
		if (lt < 0) {
			out += xml.slice(pos);
			break;
		}
		if (xml.startsWith("<!--", lt)) {
			const ec = xml.indexOf("-->", lt + 4);
			const end = ec < 0 ? xml.length : ec + 3;
			out += xml.slice(pos, end);
			pos = end;
			continue;
		}
		if (xml[lt + 1] === "/" || xml[lt + 1] === "?" || xml[lt + 1] === "!") {
			const gt = xml.indexOf(">", lt + 1);
			const end = gt < 0 ? xml.length : gt + 1;
			out += xml.slice(pos, end);
			pos = end;
			continue;
		}
		let nameEnd = lt + 1;
		while (nameEnd < xml.length && !/[\s/>]/.test(xml[nameEnd]!)) nameEnd++;
		const tagName = xml.slice(lt + 1, nameEnd);
		const localName = tagName.includes(":") ? tagName.slice(tagName.indexOf(":") + 1) : tagName;
		const gt = xml.indexOf(">", nameEnd);
		if (gt < 0) {
			out += xml.slice(pos);
			break;
		}
		if (localName !== "AlternateContent") {
			out += xml.slice(pos, gt + 1);
			pos = gt + 1;
			continue;
		}
		out += xml.slice(pos, lt);
		if (xml[gt - 1] === "/") {
			pos = gt + 1;
			continue;
		}
		// Find balanced closing `</tagName>`
		let depth = 1;
		let scan = gt + 1;
		let closeStart = -1;
		let closeEnd = -1;
		while (scan < xml.length && depth > 0) {
			const nextLt = xml.indexOf("<", scan);
			if (nextLt < 0) break;
			if (xml.startsWith("<!--", nextLt)) {
				const ec = xml.indexOf("-->", nextLt + 4);
				scan = ec < 0 ? xml.length : ec + 3;
				continue;
			}
			const nextGt = xml.indexOf(">", nextLt + 1);
			if (nextGt < 0) break;
			if (xml[nextLt + 1] === "/") {
				const closeName = xml.slice(nextLt + 2, nextGt).trim();
				if (closeName === tagName) {
					depth--;
					if (depth === 0) {
						closeStart = nextLt;
						closeEnd = nextGt + 1;
						break;
					}
				}
			} else if (xml[nextGt - 1] !== "/") {
				let innerNameEnd = nextLt + 1;
				while (innerNameEnd < nextGt && !/[\s/>]/.test(xml[innerNameEnd]!)) innerNameEnd++;
				if (xml.slice(nextLt + 1, innerNameEnd) === tagName) depth++;
			}
			scan = nextGt + 1;
		}
		const inner = closeStart >= 0 ? xml.slice(gt + 1, closeStart) : xml.slice(gt + 1);
		const prefix = tagName.includes(":") ? tagName.slice(0, tagName.indexOf(":") + 1) : "";
		const choiceTag = `${prefix}Choice`;
		const fallbackTag = `${prefix}Fallback`;
		const branches = extractDirectElements(inner, [choiceTag, fallbackTag]);
		const choice = branches.find((b) => b.tag === choiceTag);
		const fallback = branches.find((b) => b.tag === fallbackTag);
		const chosen = choice ? choice.inner : fallback ? fallback.inner : "";
		out += resolveAlternateContent(chosen);
		pos = closeEnd >= 0 ? closeEnd : xml.length;
	}
	return out;
}

/** Strips balanced `<tagName>...</tagName>` occurrences (e.g. `<w:pPr>`) so metadata children never leak into inline text parsing. */
function stripDirectElement(xml: string, tagName: string): string {
	if (!xml.includes(`<${tagName}`)) return xml;
	let out = "";
	let pos = 0;
	while (pos < xml.length) {
		const lt = xml.indexOf("<", pos);
		if (lt < 0) {
			out += xml.slice(pos);
			break;
		}
		if (xml.startsWith("<!--", lt)) {
			const ec = xml.indexOf("-->", lt + 4);
			const end = ec < 0 ? xml.length : ec + 3;
			out += xml.slice(pos, end);
			pos = end;
			continue;
		}
		let nameEnd = lt + 1;
		while (nameEnd < xml.length && !/[\s/>]/.test(xml[nameEnd]!)) nameEnd++;
		const curTag = xml.slice(lt + 1, nameEnd);
		const gt = xml.indexOf(">", nameEnd);
		if (gt < 0) {
			out += xml.slice(pos);
			break;
		}
		if (curTag !== tagName) {
			out += xml.slice(pos, gt + 1);
			pos = gt + 1;
			continue;
		}
		out += xml.slice(pos, lt);
		if (xml[gt - 1] === "/") {
			pos = gt + 1;
			continue;
		}
		let depth = 1;
		let scan = gt + 1;
		let closeEnd = xml.length;
		while (scan < xml.length && depth > 0) {
			const nextLt = xml.indexOf("<", scan);
			if (nextLt < 0) break;
			const nextGt = xml.indexOf(">", nextLt + 1);
			if (nextGt < 0) break;
			if (xml[nextLt + 1] === "/") {
				if (xml.slice(nextLt + 2, nextGt).trim() === tagName) {
					depth--;
					if (depth === 0) {
						closeEnd = nextGt + 1;
						break;
					}
				}
			} else if (xml[nextGt - 1] !== "/") {
				let innerNameEnd = nextLt + 1;
				while (innerNameEnd < nextGt && !/[\s/>]/.test(xml[innerNameEnd]!)) innerNameEnd++;
				if (xml.slice(nextLt + 1, innerNameEnd) === tagName) depth++;
			}
			scan = nextGt + 1;
		}
		pos = closeEnd;
	}
	return out;
}

type ParsedStyleDef = {
	id: string;
	name: string;
	basedOn: string;
	outlineLvl?: number;
	numId?: string;
	ilvl?: number;
};

function parseStylesXml(stylesXml: string): Map<string, ParsedStyleDef> {
	const map = new Map<string, ParsedStyleDef>();
	for (const el of extractDirectElements(stylesXml, ["w:style"])) {
		const type = xmlAttr(el.openTag, "w:type").toLowerCase();
		if (type && type !== "paragraph") continue;
		const id = xmlAttr(el.openTag, "w:styleId");
		if (!id) continue;
		const nameTag = /<w:name\b[^>]*>/i.exec(el.inner)?.[0] ?? "";
		const basedOnTag = /<w:basedOn\b[^>]*>/i.exec(el.inner)?.[0] ?? "";
		const pPr = extractDirectElements(el.inner, ["w:pPr"])[0]?.inner ?? "";
		const outlineTag = /<w:outlineLvl\b[^>]*>/i.exec(pPr)?.[0] ?? "";
		const rawOutline = outlineTag ? xmlAttr(outlineTag, "w:val") : "";
		const parsedOutline = rawOutline !== "" ? Number(rawOutline) : Number.NaN;
		const outlineLvl = Number.isInteger(parsedOutline) && parsedOutline >= 0 && parsedOutline <= 5 ? parsedOutline : undefined;
		const numPr = extractDirectElements(pPr, ["w:numPr"])[0]?.inner ?? "";
		const numIdTag = /<w:numId\b[^>]*>/i.exec(numPr)?.[0] ?? "";
		const ilvlTag = /<w:ilvl\b[^>]*>/i.exec(numPr)?.[0] ?? "";
		const numId = numIdTag ? xmlAttr(numIdTag, "w:val") : undefined;
		const ilvlRaw = ilvlTag ? xmlAttr(ilvlTag, "w:val") : "";
		const parsedIlvl = ilvlRaw !== "" ? Math.floor(Number(ilvlRaw)) : Number.NaN;
		const ilvl = Number.isFinite(parsedIlvl) ? Math.min(8, Math.max(0, parsedIlvl)) : undefined;
		map.set(id.toLowerCase(), {
			id,
			name: nameTag ? xmlAttr(nameTag, "w:val") : "",
			basedOn: basedOnTag ? xmlAttr(basedOnTag, "w:val") : "",
			outlineLvl,
			numId: numId || undefined,
			ilvl,
		});
	}
	return map;
}

type NumberingLevelDef = { ordered: boolean; start: number };

const UNORDERED_NUM_FMTS = new Set(["bullet", "none"]);

function parseNumberingXml(numberingXml: string): Map<string, Map<number, NumberingLevelDef>> {
	const abstractLevels = new Map<string, Map<number, NumberingLevelDef>>();
	for (const abs of extractDirectElements(numberingXml, ["w:abstractNum"])) {
		const absId = xmlAttr(abs.openTag, "w:abstractNumId");
		if (!absId) continue;
		const lvls = new Map<number, NumberingLevelDef>();
		for (const lvl of extractDirectElements(abs.inner, ["w:lvl"])) {
			const ilvl = Number(xmlAttr(lvl.openTag, "w:ilvl"));
			if (!Number.isInteger(ilvl) || ilvl < 0) continue;
			const fmtTag = /<w:numFmt\b[^>]*>/i.exec(lvl.inner)?.[0] ?? "";
			const fmt = fmtTag ? xmlAttr(fmtTag, "w:val").trim().toLowerCase() : "";
			const startTag = /<w:start\b[^>]*>/i.exec(lvl.inner)?.[0] ?? "";
			const startRaw = startTag ? Number(xmlAttr(startTag, "w:val")) : 1;
			const start = Number.isInteger(startRaw) && startRaw >= 0 ? startRaw : 1;
			lvls.set(ilvl, { ordered: Boolean(fmt) && !UNORDERED_NUM_FMTS.has(fmt), start });
		}
		abstractLevels.set(absId, lvls);
	}

	const numMap = new Map<string, Map<number, NumberingLevelDef>>();
	for (const num of extractDirectElements(numberingXml, ["w:num"])) {
		const numId = xmlAttr(num.openTag, "w:numId");
		if (!numId) continue;
		const absRefTag = /<w:abstractNumId\b[^>]*>/i.exec(num.inner)?.[0] ?? "";
		const absId = absRefTag ? xmlAttr(absRefTag, "w:val") : "";
		const base = absId ? abstractLevels.get(absId) : undefined;
		const merged = new Map<number, NumberingLevelDef>();
		if (base) {
			for (const [k, v] of base) merged.set(k, { ...v });
		}
		for (const ov of extractDirectElements(num.inner, ["w:lvlOverride"])) {
			const ilvl = Number(xmlAttr(ov.openTag, "w:ilvl"));
			if (!Number.isInteger(ilvl) || ilvl < 0) continue;
			const startOvTag = /<w:startOverride\b[^>]*>/i.exec(ov.inner)?.[0] ?? "";
			const startOvRaw = startOvTag ? Number(xmlAttr(startOvTag, "w:val")) : Number.NaN;
			const innerLvl = extractDirectElements(ov.inner, ["w:lvl"])[0];
			if (innerLvl) {
				const fmtTag = /<w:numFmt\b[^>]*>/i.exec(innerLvl.inner)?.[0] ?? "";
				const fmt = fmtTag ? xmlAttr(fmtTag, "w:val").trim().toLowerCase() : "";
				const startTag = /<w:start\b[^>]*>/i.exec(innerLvl.inner)?.[0] ?? "";
				const startRaw = startTag ? Number(xmlAttr(startTag, "w:val")) : 1;
				const start = Number.isInteger(startOvRaw) ? startOvRaw : Number.isInteger(startRaw) && startRaw >= 0 ? startRaw : 1;
				merged.set(ilvl, { ordered: Boolean(fmt) && !UNORDERED_NUM_FMTS.has(fmt), start });
			} else if (Number.isInteger(startOvRaw)) {
				const prev = merged.get(ilvl) ?? { ordered: false, start: 1 };
				merged.set(ilvl, { ...prev, start: startOvRaw });
			}
		}
		numMap.set(numId, merged);
	}
	return numMap;
}

function wrapAnnotatedMarkdown(text: string, prefix: string, suffix: string): string {
	const lead = /^\s*/.exec(text)?.[0] ?? "";
	const trail = /\s*$/.exec(text)?.[0] ?? "";
	const core = text.slice(lead.length, text.length - trail.length);
	if (!core) return text;
	return `${lead}${prefix}${core}${suffix}${trail}`;
}

function safeDocxLinkUrl(rawUrl: string): string | null {
	const cleaned = rawUrl.replace(/[\u0000-\u001f\u007f]+/g, "").trim();
	if (!cleaned) return null;
	const scheme = /^([a-zA-Z][a-zA-Z0-9+.-]*):/.exec(cleaned);
	if (scheme) {
		if (!/^(?:https?|mailto)$/i.test(scheme[1]!)) return null;
	} else if (cleaned.startsWith("//")) {
		return null;
	}
	return cleaned.replace(/[()\s<>]/g, (ch) => `%${ch.charCodeAt(0).toString(16).toUpperCase().padStart(2, "0")}`);
}

/**
 * Parses a `.docx` binary archive into clean Markdown + extracted image payloads (+ optional import warnings).
 * Throws, naming the file as `fileName`, when the bytes hold no document that can be read. A document with nothing
 * written in it is still a document, and reads as no text.
 */
export function parseDocxToMarkdown(bytes: Uint8Array, fileName = "This file"): DocxParsedResult {
	const entries = readZipEntries(bytes);
	const byLower = new Map<string, { name: string; data: Uint8Array }>();
	for (const [name, data] of entries) byLower.set(name.toLowerCase(), { name, data });

	const dec = new TextDecoder();
	const docEntry = byLower.get("word/document.xml");
	// Bytes with no `word/document.xml` to open are not a document with nothing in it. Read as one, an import of
	// them made an empty Markdown file, and with Overwrite put it in the place of the one that was there.
	if (!docEntry) {
		throw new Error(`${fileName} is not a Word document that can be read here. It may be an older .doc file with a .docx name, protected by a password, or incomplete (a download that was cut short).`);
	}
	const docXml = resolveAlternateContent(dec.decode(docEntry.data));

	const relsEntry = byLower.get("word/_rels/document.xml.rels");
	const docRels = relsEntry ? parseRelationships(dec.decode(relsEntry.data)) : new Map<string, ParsedRel>();

	const stylesEntry = byLower.get("word/styles.xml");
	const stylesMap = stylesEntry ? parseStylesXml(dec.decode(stylesEntry.data)) : new Map<string, ParsedStyleDef>();

	const numberingEntry = byLower.get("word/numbering.xml");
	const numberingMap = numberingEntry ? parseNumberingXml(dec.decode(numberingEntry.data)) : new Map<string, Map<number, NumberingLevelDef>>();

	const resolveStyleHeadingLevel = (styleVal: string): number => {
		if (!styleVal) return 0;
		const visited = new Set<string>();
		let cur: string | undefined = styleVal.toLowerCase();
		while (cur && !visited.has(cur)) {
			visited.add(cur);
			const def = stylesMap.get(cur);
			if (!def) break;
			if (def.outlineLvl !== undefined) return def.outlineLvl + 1;
			if (/^title$/i.test(def.name)) return 1;
			const nm = /^heading\s*([1-6])$/i.exec(def.name);
			if (nm) return Number(nm[1]);
			cur = def.basedOn ? def.basedOn.toLowerCase() : undefined;
		}
		if (/^title$/i.test(styleVal)) return 1;
		const hm = /^heading\s*([1-6])$/i.exec(styleVal);
		if (hm) return Number(hm[1]);
		return 0;
	};

	const resolveStyleNumPr = (styleVal: string): { numId?: string; ilvl?: number } => {
		if (!styleVal) return {};
		const visited = new Set<string>();
		let cur: string | undefined = styleVal.toLowerCase();
		while (cur && !visited.has(cur)) {
			visited.add(cur);
			const def = stylesMap.get(cur);
			if (!def) break;
			if (def.numId) return { numId: def.numId, ilvl: def.ilvl };
			cur = def.basedOn ? def.basedOn.toLowerCase() : undefined;
		}
		return {};
	};

	const extractedImages = new Map<string, Uint8Array>();
	const extractedByZipPath = new Map<string, string>();
	const usedImgNames = new Set<string>();

	const resolveImageRel = (rId: string, activeRels: Map<string, ParsedRel>): string | null => {
		const rel = activeRels.get(rId) ?? docRels.get(rId);
		if (!rel) return null;
		const cleanTarget = rel.target.replace(/\\/g, "/").replace(/^\/+/, "");
		const candidates = [
			cleanTarget.startsWith("word/") ? cleanTarget : `word/${cleanTarget.replace(/^\.\.\//, "")}`,
			cleanTarget,
		];
		for (const cand of candidates) {
			const hit = byLower.get(cand.toLowerCase());
			if (hit) {
				const zipKey = hit.name.toLowerCase();
				const existing = extractedByZipPath.get(zipKey);
				if (existing) return existing;
				const base = basename(hit.name) || "image.png";
				const ext = extname(base);
				const stem = ext ? base.slice(0, -ext.length) : base;
				let imgName = base;
				let suffix = 2;
				while (usedImgNames.has(imgName.toLowerCase())) {
					imgName = `${stem}-${suffix++}${ext}`;
				}
				usedImgNames.add(imgName.toLowerCase());
				extractedByZipPath.set(zipKey, imgName);
				extractedImages.set(imgName, hit.data);
				return imgName;
			}
		}
		return null;
	};

	let hadTrackChanges = false;
	const footnoteDefs = new Map<string, string>();
	const commentDefs = new Map<string, string>();
	const referencedFootnotes: string[] = [];
	const referencedComments: string[] = [];
	const emittedCommentRefs = new Set<string>();

	const bodyMatch = /<w:body\b[^>]*>([\s\S]*)<\/w:body>/i.exec(docXml);
	const bodyXml = bodyMatch ? bodyMatch[1]! : docXml;

	// Track which comment IDs have explicit `<w:commentReference>` runs so `<w:commentRangeEnd>` doesn't double-emit them.
	const explicitCommentRefs = new Set<string>();
	for (const cm of bodyXml.matchAll(/<w:commentReference\b[^>]*>/gi)) {
		const id = xmlAttr(cm[0], "w:id");
		if (id) explicitCommentRefs.add(id);
	}

	const parseRun = (
		runInner: string,
		activeRels: Map<string, ParsedRel>,
		opts: { inDel?: boolean; emitRefs?: boolean } = {},
	): StyledSegment[] => {
		const segs: StyledSegment[] = [];
		const rPrEl = extractDirectElements(runInner, ["w:rPr"])[0];
		const rPr = rPrEl?.inner ?? "";
		const bold = hasEnabledFlag(rPr, "b");
		const italic = hasEnabledFlag(rPr, "i");
		const strike = hasEnabledFlag(rPr, "strike");
		const highlight = hasEnabledFlag(rPr, "highlight");
		const codeFont = /<w:rFonts\b[^>]*(?:Consolas|Courier|Menlo|Monaco|monospace)/i.test(rPr);

		const runBody = stripDirectElement(runInner, "w:rPr");

		// Embedded DrawingML (`<a:blip r:embed="..."/>`) and legacy VML (`<v:imagedata r:id="..."/>`) images.
		const emittedImgIds = new Set<string>();
		for (const imgTag of runBody.matchAll(/<a:blip\b[^>]*>|<v:imagedata\b[^>]*>/gi)) {
			const tag = imgTag[0];
			const rId = /^<v:imagedata\b/i.test(tag)
				? xmlAttr(tag, "r:id") || xmlAttr(tag, "o:relid")
				: xmlAttr(tag, "r:embed") || xmlAttr(tag, "r:link");
			if (!rId || emittedImgIds.has(rId)) continue;
			const imgName = resolveImageRel(rId, activeRels);
			if (imgName) {
				emittedImgIds.add(rId);
				segs.push({ text: `{{DOCX_IMG:${imgName}}}`, bold: false, italic: false, strike: false, code: false, highlight: false, raw: true });
			}
		}

		// Extract text (`<w:t>`), deleted text (`<w:delText>`), footnote/comment refs, breaks, and tabs in exact order.
		// Exclude self-closing `<w:t/>` and `<w:delText/>` so they never swallow subsequent XML up to the next closing tag.
		const tokenRe =
			/<w:t\b[^>]*(?<!\/)>([\s\S]*?)<\/w:t>|<w:delText\b[^>]*(?<!\/)>([\s\S]*?)<\/w:delText>|<w:footnoteReference\b[^>]*\/?>|<w:commentReference\b[^>]*\/?>|<w:br\b[^>]*\/?>|<w:tab\b[^>]*\/?>/gi;
		let m: RegExpExecArray | null;
		while ((m = tokenRe.exec(runBody)) !== null) {
			const whole = m[0];
			if (/^<w:br\b/i.test(whole)) {
				segs.push({ text: "\n", bold: false, italic: false, strike: false, code: false, highlight: false, raw: true });
			} else if (/^<w:tab\b/i.test(whole)) {
				segs.push({ text: "\t", bold: false, italic: false, strike: false, code: false, highlight: false, raw: true });
			} else if (/^<w:footnoteReference\b/i.test(whole)) {
				if (opts.emitRefs !== false) {
					const id = xmlAttr(whole, "w:id");
					if (id) {
						if (!referencedFootnotes.includes(id)) referencedFootnotes.push(id);
						segs.push({ text: `[^${id}]`, bold: false, italic: false, strike: false, code: false, highlight: false, raw: true });
					}
				}
			} else if (/^<w:commentReference\b/i.test(whole)) {
				if (opts.emitRefs !== false) {
					const id = xmlAttr(whole, "w:id");
					if (id && commentDefs.has(id) && !emittedCommentRefs.has(id)) {
						emittedCommentRefs.add(id);
						if (!referencedComments.includes(id)) referencedComments.push(id);
						segs.push({ text: `[^comment-${id}]`, bold: false, italic: false, strike: false, code: false, highlight: false, raw: true });
					}
				}
			} else if (m[2] !== undefined) {
				const txt = xmlUnesc(m[2]);
				if (txt) {
					hadTrackChanges = true;
					segs.push({ text: txt, bold, italic, strike: opts.inDel ? false : true, code: codeFont, highlight });
				}
			} else {
				const txt = xmlUnesc(m[1] ?? "");
				if (txt) segs.push({ text: txt, bold, italic, strike, code: codeFont, highlight });
			}
		}
		return segs;
	};

	const parseInlineChildren = (
		xml: string,
		activeRels: Map<string, ParsedRel>,
		suppressBold: boolean,
		opts: { inDel?: boolean; emitRefs?: boolean } = {},
	): StyledSegment[] => {
		const segments: StyledSegment[] = [];
		const children = extractDirectElements(xml, ["w:r", "w:hyperlink", "w:ins", "w:del", "w:commentRangeEnd"]);
		for (const child of children) {
			if (child.tag === "w:r") {
				segments.push(...parseRun(child.inner, activeRels, opts));
			} else if (child.tag === "w:hyperlink") {
				const rId = xmlAttr(child.openTag, "r:id");
				const rawUrl = rId ? (activeRels.get(rId)?.target ?? docRels.get(rId)?.target ?? "") : "";
				const safeUrl = rawUrl ? safeDocxLinkUrl(rawUrl) : null;
				const innerSegs = parseInlineChildren(child.inner, activeRels, suppressBold, opts);
				const label = formatSegments(innerSegs, suppressBold).trim();
				if (safeUrl && label) {
					const formatted =
						label === safeUrl && /^(?:https?:\/\/|mailto:)/i.test(safeUrl) ? `<${safeUrl}>` : `[${label}](${safeUrl})`;
					segments.push({ text: formatted, bold: false, italic: false, strike: false, code: false, highlight: false, raw: true });
				} else if (label) {
					segments.push({ text: label, bold: false, italic: false, strike: false, code: false, highlight: false, raw: true });
				}
			} else if (child.tag === "w:ins") {
				const innerSegs = parseInlineChildren(child.inner, activeRels, suppressBold, opts);
				const formatted = formatSegments(innerSegs, suppressBold);
				if (formatted.trim()) {
					hadTrackChanges = true;
					segments.push({
						text: wrapAnnotatedMarkdown(formatted, "==", "=="),
						bold: false,
						italic: false,
						strike: false,
						code: false,
						highlight: false,
						raw: true,
					});
				}
			} else if (child.tag === "w:del") {
				const innerSegs = parseInlineChildren(child.inner, activeRels, suppressBold, { ...opts, inDel: true });
				const formatted = formatSegments(innerSegs, suppressBold);
				if (formatted.trim()) {
					hadTrackChanges = true;
					segments.push({
						text: wrapAnnotatedMarkdown(formatted, "~~", "~~"),
						bold: false,
						italic: false,
						strike: false,
						code: false,
						highlight: false,
						raw: true,
					});
				}
			} else if (child.tag === "w:commentRangeEnd" && opts.emitRefs !== false) {
				const id = xmlAttr(child.openTag, "w:id");
				if (id && commentDefs.has(id) && !explicitCommentRefs.has(id) && !emittedCommentRefs.has(id)) {
					emittedCommentRefs.add(id);
					if (!referencedComments.includes(id)) referencedComments.push(id);
					segments.push({ text: `[^comment-${id}]`, bold: false, italic: false, strike: false, code: false, highlight: false, raw: true });
				}
			}
		}
		return segments;
	};

	// Pre-parse `word/footnotes.xml` and `word/comments.xml` before walking `word/document.xml`
	// so comment/footnote references resolve cleanly in reading order.
	const parseSimpleParagraphText = (pInner: string, activeRels: Map<string, ParsedRel>): string => {
		const cleanInner = stripDirectElement(pInner, "w:pPr");
		const segs = parseInlineChildren(cleanInner, activeRels, false, { emitRefs: false });
		return formatSegments(segs, false).trim();
	};

	const footnotesEntry = byLower.get("word/footnotes.xml");
	if (footnotesEntry) {
		const fnRelsEntry = byLower.get("word/_rels/footnotes.xml.rels");
		const fnRels = fnRelsEntry ? parseRelationships(dec.decode(fnRelsEntry.data)) : docRels;
		const fnXml = resolveAlternateContent(dec.decode(footnotesEntry.data));
		for (const fnEl of extractDirectElements(fnXml, ["w:footnote"])) {
			const fnType = xmlAttr(fnEl.openTag, "w:type").toLowerCase();
			if (fnType === "separator" || fnType === "continuationseparator" || fnType === "continuationnotice") continue;
			const id = xmlAttr(fnEl.openTag, "w:id");
			if (!id) continue;
			const ps = extractDirectElements(fnEl.inner, ["w:p"])
				.map((p) => parseSimpleParagraphText(p.inner, fnRels))
				.filter(Boolean);
			const text = ps.join(" ").trim();
			if (text) footnoteDefs.set(id, text);
		}
	}

	const commentsEntry = byLower.get("word/comments.xml");
	if (commentsEntry) {
		const cmRelsEntry = byLower.get("word/_rels/comments.xml.rels");
		const cmRels = cmRelsEntry ? parseRelationships(dec.decode(cmRelsEntry.data)) : docRels;
		const cmXml = resolveAlternateContent(dec.decode(commentsEntry.data));
		for (const cmEl of extractDirectElements(cmXml, ["w:comment"])) {
			const id = xmlAttr(cmEl.openTag, "w:id");
			if (!id) continue;
			const author = xmlAttr(cmEl.openTag, "w:author").trim();
			const rawDate = xmlAttr(cmEl.openTag, "w:date").trim();
			const shortDate = /^\d{4}-\d{2}-\d{2}/.exec(rawDate)?.[0] ?? rawDate;
			const ps = extractDirectElements(cmEl.inner, ["w:p"])
				.map((p) => parseSimpleParagraphText(p.inner, cmRels))
				.filter(Boolean);
			const body = ps.join(" ").trim();
			if (!body) continue;
			const who = [author, shortDate].filter(Boolean).join(", ");
			commentDefs.set(id, `[QA Comment${who ? ` — ${who}` : ""}]: ${body}`);
		}
	}

	// Track active ordered list counters keyed by `${numId}:${ilvl}` so ordered lists emit `1. `, `2. `, ...
	const orderedCounters = new Map<string, number>();
	let lastListNumId: string | null = null;
	const resetOrderedCounters = () => {
		orderedCounters.clear();
		lastListNumId = null;
	};

	const parseParagraph = (
		pInner: string,
		inTableCell = false,
		suppressBoldCell = false,
	): { text: string; isList: boolean } => {
		const pPr = extractDirectElements(pInner, ["w:pPr"])[0]?.inner ?? "";
		const directOutlineTag = /<w:outlineLvl\b[^>]*>/i.exec(pPr)?.[0] ?? "";
		const directOutlineRaw = directOutlineTag ? xmlAttr(directOutlineTag, "w:val") : "";
		const directOutlineNum = directOutlineRaw !== "" ? Number(directOutlineRaw) : Number.NaN;
		const styleMatch = /<w:pStyle\b[^>]*>/i.exec(pPr);
		const styleVal = styleMatch ? xmlAttr(styleMatch[0], "w:val") : "";
		let headingLevel = 0;
		if (Number.isInteger(directOutlineNum) && directOutlineNum >= 0 && directOutlineNum <= 5) {
			headingLevel = directOutlineNum + 1;
		} else {
			headingLevel = resolveStyleHeadingLevel(styleVal);
		}

		const numPrEl = extractDirectElements(pPr, ["w:numPr"])[0];
		const styleNum = !numPrEl && styleVal ? resolveStyleNumPr(styleVal) : {};
		const numIdMatch = numPrEl ? /<w:numId\b[^>]*>/i.exec(numPrEl.inner) : null;
		const ilvlMatch = numPrEl ? /<w:ilvl\b[^>]*>/i.exec(numPrEl.inner) : null;
		const numId = (numIdMatch ? xmlAttr(numIdMatch[0], "w:val") : undefined) ?? styleNum.numId;
		const hasNumPr = Boolean((numPrEl && numId !== "0") || (styleNum.numId && styleNum.numId !== "0"));
		const rawIlvl = ilvlMatch ? Number(xmlAttr(ilvlMatch[0], "w:val")) : styleNum.ilvl;
		const ilvl = rawIlvl !== undefined && Number.isFinite(rawIlvl) ? Math.min(8, Math.max(0, Math.floor(rawIlvl))) : 0;

		const contentXml = stripDirectElement(pInner, "w:pPr");
		const segments = parseInlineChildren(contentXml, docRels, headingLevel > 0 || suppressBoldCell);
		const text = formatSegments(segments, headingLevel > 0 || suppressBoldCell).trim();
		if (!text) return { text: "", isList: false };

		if (headingLevel > 0 && !inTableCell) {
			resetOrderedCounters();
			return { text: `${"#".repeat(headingLevel)} ${text}`, isList: false };
		}
		if (hasNumPr && !inTableCell) {
			const lvlDef = numId ? numberingMap.get(numId)?.get(ilvl) : undefined;
			if (lvlDef?.ordered && numId) {
				if (ilvl === 0 && lastListNumId !== numId) {
					orderedCounters.clear();
					lastListNumId = numId;
				} else if (lastListNumId === null) {
					lastListNumId = numId;
				}
				// Reset any deeper sub-level counters when returning to a shallower level.
				for (const k of [...orderedCounters.keys()]) {
					const lvl = Number(k.slice(k.lastIndexOf(":") + 1));
					if (lvl > ilvl) orderedCounters.delete(k);
				}
				const cKey = `${numId}:${ilvl}`;
				const nextNum = orderedCounters.has(cKey) ? orderedCounters.get(cKey)! + 1 : lvlDef.start;
				orderedCounters.set(cKey, nextNum);
				return { text: `${"  ".repeat(ilvl)}${nextNum}. ${text}`, isList: true };
			}
			if (ilvl === 0) {
				resetOrderedCounters();
			} else {
				for (const k of [...orderedCounters.keys()]) {
					const lvl = Number(k.slice(k.lastIndexOf(":") + 1));
					if (lvl >= ilvl) orderedCounters.delete(k);
				}
			}
			return { text: `${"  ".repeat(ilvl)}- ${text}`, isList: true };
		}
		if (!inTableCell) {
			resetOrderedCounters();
			if (text.startsWith("• ")) return { text: `- ${text.slice(2)}`, isList: true };
			if (text.startsWith("☑ ")) return { text: `- [x] ${text.slice(2)}`, isList: true };
			if (text.startsWith("☐ ")) return { text: `- [ ] ${text.slice(2)}`, isList: true };
		}
		return { text, isList: false };
	};

	const escapeTableCell = (cell: string) =>
		cell
			.replace(/\r\n?/g, "\n")
			.replace(/\n+/g, "<br>")
			.replace(/(?<!\\)\|/g, "\\|")
			.trim();

	const parseTable = (tblInner: string): string => {
		const trs = extractDirectElements(tblInner, ["w:tr"]);
		const rows: string[][] = [];
		trs.forEach((tr, rowIdx) => {
			const isHeaderRow = rowIdx === 0 || /<w:tblHeader\b/i.test(tr.inner);
			const tcs = extractDirectElements(tr.inner, ["w:tc"]);
			const cells: string[] = [];
			for (const tc of tcs) {
				const ps = extractDirectElements(tc.inner, ["w:p"]);
				const cellParts = ps
					.map((p) => parseParagraph(p.inner, true, isHeaderRow).text)
					.filter((t) => t.length > 0);
				cells.push(escapeTableCell(cellParts.join("<br>")));
			}
			if (cells.length) rows.push(cells);
		});
		if (!rows.length) return "";
		const width = Math.max(...rows.map((r) => r.length));
		const pad = (cells: string[]) => {
			const copy = cells.slice();
			while (copy.length < width) copy.push("");
			return `| ${copy.join(" | ")} |`;
		};
		const header = pad(rows[0]!);
		const sep = `| ${Array.from({ length: width }, () => "---").join(" | ")} |`;
		const body = rows.slice(1).map(pad);
		return [header, sep, ...body].join("\n");
	};

	const topBlocks = extractDirectElements(bodyXml, ["w:p", "w:tbl"]);

	const mdLines: string[] = [];
	let prevWasList = false;
	for (const block of topBlocks) {
		if (block.tag === "w:tbl") {
			resetOrderedCounters();
			const tblMd = parseTable(block.inner);
			if (tblMd) {
				if (mdLines.length) mdLines.push("");
				mdLines.push(tblMd);
				prevWasList = false;
			}
			continue;
		}
		const parsed = parseParagraph(block.inner, false);
		if (!parsed.text) continue;
		if (mdLines.length && !(prevWasList && parsed.isList)) mdLines.push("");
		mdLines.push(parsed.text);
		prevWasList = parsed.isList;
	}

	// Append footnote definitions (from `word/footnotes.xml`) and QA review comment footnotes (from `word/comments.xml`).
	for (const id of footnoteDefs.keys()) {
		if (!referencedFootnotes.includes(id)) referencedFootnotes.push(id);
	}
	for (const id of commentDefs.keys()) {
		if (!referencedComments.includes(id)) referencedComments.push(id);
	}
	const footerNotes: string[] = [];
	for (const id of referencedFootnotes) {
		const def = footnoteDefs.get(id);
		if (def) footerNotes.push(`[^${id}]: ${def}`);
	}
	for (const id of referencedComments) {
		const def = commentDefs.get(id);
		if (def) footerNotes.push(`[^comment-${id}]: ${def}`);
	}
	if (footerNotes.length) {
		if (mdLines.length) mdLines.push("");
		mdLines.push(...footerNotes);
	}

	const warnings: string[] = [];
	if (hadTrackChanges) {
		warnings.push("Imported document contained unaccepted Word Track Changes — marked with ==ins== / ~~del~~ for review.");
	}
	if (commentDefs.size > 0) {
		warnings.push(`Imported ${commentDefs.size} Word QA review comment(s) as footnotes.`);
	}

	const images = [...extractedImages.entries()].map(([name, imgBytes]) => ({ name, bytes: imgBytes }));
	return {
		markdown: mdLines.join("\n").replace(/\n{3,}/g, "\n\n").trim(),
		images,
		...(warnings.length ? { warnings } : {}),
	};
}
