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

const xmlEsc = (s: string) =>
	s
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;")
		.replace(/'/g, "&apos;");

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
			return Number.isFinite(n) && n > 0 ? String.fromCodePoint(n) : m;
		}
		if (lower.startsWith("#")) {
			const n = Number.parseInt(lower.slice(1), 10);
			return Number.isFinite(n) && n > 0 ? String.fromCodePoint(n) : m;
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

/** Pure-TypeScript ZIP central-directory reader supporting Stored (0) and Deflate (8) entries. */
function readZipEntries(bytes: Uint8Array): Map<string, Uint8Array> {
	const entries = new Map<string, Uint8Array>();
	if (bytes.length < 22) return entries;
	const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	const dec = new TextDecoder();

	// Locate End of Central Directory record (0x06054b50), scanning backwards up to 64 KiB + 22 bytes.
	const minEocd = Math.max(0, bytes.length - 65557);
	let eocdPos = -1;
	for (let p = bytes.length - 22; p >= minEocd; p--) {
		if (view.getUint32(p, true) === 0x06054b50) {
			eocdPos = p;
			break;
		}
	}

	const extractAtLocal = (localOffset: number, method: number, compSize: number): Uint8Array | null => {
		if (localOffset < 0 || localOffset + 30 > bytes.length) return null;
		if (view.getUint32(localOffset, true) !== 0x04034b50) return null;
		const localNameLen = view.getUint16(localOffset + 26, true);
		const localExtraLen = view.getUint16(localOffset + 28, true);
		const dataStart = localOffset + 30 + localNameLen + localExtraLen;
		const dataEnd = dataStart + compSize;
		if (dataEnd > bytes.length || compSize > MAX_ZIP_ENTRY_BYTES) return null;
		const slice = bytes.subarray(dataStart, dataEnd);
		if (method === 0) return new Uint8Array(slice);
		if (method === 8) {
			try {
				const inflated = inflateRawSync(slice);
				return inflated.length <= MAX_ZIP_ENTRY_BYTES ? new Uint8Array(inflated) : null;
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
		let pos = cdOffset;
		const cdEnd = Math.min(bytes.length, cdOffset + cdSize);
		for (let i = 0; i < entryCount && pos + 46 <= cdEnd; i++) {
			if (view.getUint32(pos, true) !== 0x02014b50) break;
			const method = view.getUint16(pos + 10, true);
			const compSize = view.getUint32(pos + 20, true);
			const nameLen = view.getUint16(pos + 28, true);
			const extraLen = view.getUint16(pos + 30, true);
			const commentLen = view.getUint16(pos + 32, true);
			const localOffset = view.getUint32(pos + 42, true);
			if (pos + 46 + nameLen > bytes.length) break;
			const rawName = dec.decode(bytes.subarray(pos + 46, pos + 46 + nameLen)).replace(/\\/g, "/");
			pos += 46 + nameLen + extraLen + commentLen;
			if (!rawName || rawName.endsWith("/")) continue;
			const payload = extractAtLocal(localOffset, method, compSize);
			if (payload) entries.set(rawName, payload);
		}
		return entries;
	}

	// Fallback: local header sequential walk when EOCD is absent.
	let pos = 0;
	while (pos + 30 <= bytes.length && view.getUint32(pos, true) === 0x04034b50) {
		const method = view.getUint16(pos + 8, true);
		const compSize = view.getUint32(pos + 18, true);
		const nameLen = view.getUint16(pos + 26, true);
		const extraLen = view.getUint16(pos + 28, true);
		const rawName = dec.decode(bytes.subarray(pos + 30, pos + 30 + nameLen)).replace(/\\/g, "/");
		const dataStart = pos + 30 + nameLen + extraLen;
		const payload = extractAtLocal(pos, method, compSize);
		if (payload && rawName && !rawName.endsWith("/")) entries.set(rawName, payload);
		pos = dataStart + compSize;
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

function isWithinRoot(rootDir: string, candidate: string): boolean {
	const resolvedRoot = resolve(rootDir);
	const resolvedCand = resolve(candidate);
	const rel = relative(resolvedRoot, resolvedCand);
	if (rel.startsWith("..") || isAbsolute(rel)) return false;
	try {
		const realRoot = realpathSync(resolvedRoot);
		const realCand = realpathSync(resolvedCand);
		const realRel = relative(realRoot, realCand);
		if (realRel.startsWith("..") || isAbsolute(realRel)) return false;
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

type DocxContext = {
	baseDir?: string;
	workspaceRoot?: string;
	mermaidPngs?: Record<string, string>;
	mermaidIndex: number;
	rels: DocxRel[];
	hyperlinkRelByUrl: Map<string, string>;
	mediaEntries: { name: string; data: Uint8Array; ext: string }[];
	mediaRelByKey: Map<string, { rId: string; fileName: string; natural: { width: number; height: number } | null }>;
	nextRelNum: number;
	nextDrawingId: number;
	footnotes: Map<string, string>;
	footnoteOrder: string[];
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

function createDocxContext(
	options: DocxBuildOptions,
	footnotes: Map<string, string>,
): DocxContext {
	const ctx: DocxContext = {
		baseDir: options.baseDir,
		workspaceRoot: options.workspaceRoot,
		mermaidPngs: options.mermaidPngs,
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

		addHyperlink(url: string): string {
			const existing = ctx.hyperlinkRelByUrl.get(url);
			if (existing) return existing;
			const id = `rId${ctx.nextRelNum++}`;
			ctx.rels.push({
				id,
				type: "http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink",
				target: url,
				external: true,
			});
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
			if (!trimmed || /^https?:\/\//i.test(trimmed)) return null;

			// Support inline base64 data URLs (`data:image/png;base64,...`).
			const dataMatch = /^data:image\/(png|jpe?g|gif|bmp);base64,([A-Za-z0-9+/=\s]+)$/i.exec(trimmed);
			if (dataMatch) {
				try {
					const bytes = Uint8Array.from(Buffer.from(dataMatch[2]!.replace(/\s+/g, ""), "base64"));
					return ctx.embedImageBytes(bytes, `inline.${dataMatch[1]!.toLowerCase()}`, alt, widthPx, heightPx);
				} catch {
					return null;
				}
			}

			const boundary = ctx.workspaceRoot || ctx.baseDir;
			if (!boundary) return null;

			const withoutFrag = trimmed.split(/[?#]/)[0] ?? trimmed;
			let decoded = withoutFrag;
			try {
				decoded = decodeURIComponent(withoutFrag);
			} catch {
				// Keep raw string when percent-encoding is partial.
			}
			const clean = decoded.replace(/\\/g, "/").trim();
			if (!clean) return null;

			const candidates: string[] = [];
			if (clean.startsWith("/")) {
				if (ctx.workspaceRoot) candidates.push(join(ctx.workspaceRoot, clean.slice(1)));
			} else {
				if (ctx.baseDir) {
					candidates.push(resolve(ctx.baseDir, clean));
					candidates.push(join(ctx.baseDir, "attachments", clean));
					candidates.push(join(ctx.baseDir, "assets", clean));
				}
				if (ctx.workspaceRoot) {
					candidates.push(join(ctx.workspaceRoot, "docs", "attachments", clean));
					candidates.push(join(ctx.workspaceRoot, "docs", "attachments", basename(clean)));
					candidates.push(join(ctx.workspaceRoot, clean));
					candidates.push(join(ctx.workspaceRoot, "assets", clean));
				}
			}

			for (const cand of candidates) {
				if (!isWithinRoot(boundary, cand)) continue;
				try {
					if (!existsSync(cand) || !statSync(cand).isFile()) continue;
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
			if (!b64) return null;
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
	if (style.code) {
		parts.push('<w:rFonts w:ascii="Consolas" w:hAnsi="Consolas"/>');
		parts.push('<w:sz w:val="19"/>');
		parts.push('<w:shd w:val="clear" w:color="auto" w:fill="F4F4F5"/>');
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
		if (ch === "\\" && i + 1 < text.length && /[\\`*_{}[\]()#+\-.!~|=<>]/.test(text[i + 1]!)) {
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
					else out.push(textRun(`[Image: ${fallbackLabel}]`, baseStyle));
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
					else out.push(textRun(fallbackLabel ? `[Image: ${fallbackLabel}]` : "[Image]", baseStyle));
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
	return `<w:tbl><w:tblPr><w:tblW w:w="9360" w:type="dxa"/><w:tblBorders><w:top w:val="single" w:sz="4" w:color="CBD5E1"/><w:bottom w:val="single" w:sz="4" w:color="CBD5E1"/><w:right w:val="single" w:sz="4" w:color="CBD5E1"/><w:left w:val="single" w:sz="24" w:color="${border}"/></w:tblBorders><w:tblCellMar><w:top w:w="100" w:type="dxa"/><w:bottom w:w="100" w:type="dxa"/><w:left w:w="160" w:type="dxa"/><w:right w:w="140" w:type="dxa"/></w:tblCellMar></w:tblPr><w:tr><w:tc><w:tcPr><w:shd w:val="clear" w:color="auto" w:fill="${fill}"/></w:tcPr>${titleP}${bodyXml || paragraph("")}</w:tc></w:tr></w:tbl>${paragraph("", undefined, `<w:spacing w:before="0" w:after="80"/>`)}`;
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
	return `<w:tbl><w:tblPr><w:tblW w:w="${widthDxa}" w:type="dxa"/><w:tblBorders><w:top w:val="single" w:sz="4" w:color="E2E8F0"/><w:bottom w:val="single" w:sz="4" w:color="E2E8F0"/><w:left w:val="single" w:sz="4" w:color="E2E8F0"/><w:right w:val="single" w:sz="4" w:color="E2E8F0"/></w:tblBorders><w:tblCellMar><w:top w:w="90" w:type="dxa"/><w:bottom w:w="90" w:type="dxa"/><w:left w:w="140" w:type="dxa"/><w:right w:w="140" w:type="dxa"/></w:tblCellMar></w:tblPr><w:tr><w:tc><w:tcPr><w:shd w:val="clear" w:color="auto" w:fill="F8FAFC"/></w:tcPr>${ps || paragraph("")}</w:tc></w:tr></w:tbl>${paragraph("", undefined, `<w:spacing w:before="0" w:after="80"/>`)}`;
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

function tableXml(headers: string[], rows: string[][], ctx: DocxContext, compactMeta = false): string {
	const cols = Math.max(1, headers.length);
	const colW = compactMeta && cols === 2 ? [2400, 6960] : Array.from({ length: cols }, () => Math.floor(9360 / cols));
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
		: `<w:tr><w:trPr><w:tblHeader/></w:trPr>${headers.map((h, ci) => makeCell(h, ci, true)).join("")}</w:tr>`;
	const bodyTrs = rows
		.map((r) => `<w:tr>${headers.map((_, ci) => makeCell(r[ci] ?? "", ci, false, compactMeta && ci === 0)).join("")}</w:tr>`)
		.join("");
	return `<w:tbl><w:tblPr><w:tblW w:w="9360" w:type="dxa"/><w:tblBorders><w:top w:val="single" w:sz="4" w:color="D4D4D8"/><w:bottom w:val="single" w:sz="4" w:color="D4D4D8"/><w:left w:val="single" w:sz="4" w:color="D4D4D8"/><w:right w:val="single" w:sz="4" w:color="D4D4D8"/><w:insideH w:val="single" w:sz="4" w:color="E4E4E7"/><w:insideV w:val="single" w:sz="4" w:color="E4E4E7"/></w:tblBorders><w:tblCellMar><w:top w:w="60" w:type="dxa"/><w:bottom w:w="60" w:type="dxa"/><w:left w:w="100" w:type="dxa"/><w:right w:w="100" w:type="dxa"/></w:tblCellMar></w:tblPr>${headerTr}${bodyTrs}</w:tbl>${paragraph("", undefined, `<w:spacing w:before="0" w:after="80"/>`)}`;
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
	const baseStyle = opts.baseStyle ?? {};
	let i = 0;

	while (i < lines.length) {
		const line = lines[i]!;
		if (!line.trim()) {
			i++;
			continue;
		}
		// Skip HTML comments
		if (/^[ \t]*<!--/.test(line)) {
			if (!/-->[ \t]*$/.test(line)) {
				i++;
				while (i < lines.length && !/-->/.test(lines[i]!)) i++;
			}
			i++;
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
			const body: string[] = [];
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
					`${quotePPr}<w:ind w:left="${indent}" w:hanging="240"/><w:spacing w:before="20" w:after="40"/>`,
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
					`${quotePPr}<w:ind w:left="${indent}" w:hanging="240"/><w:spacing w:before="20" w:after="40"/>`,
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
					`${quotePPr}<w:ind w:left="${indent}" w:hanging="280"/><w:spacing w:before="20" w:after="40"/>`,
				),
			);
			i++;
			continue;
		}
		// Standalone image line (`![alt](path)` or `![[img.png|400]]`)
		if (/^[ \t]*(?:!\[[^\]]*\]\([^)]+\)|!\[\[[^[\]]+\]\])[ \t]*$/.test(line)) {
			blocks.push(paragraph(inlineRuns(line.trim(), ctx, baseStyle), undefined, `${quotePPr}<w:spacing w:before="80" w:after="120"/>`));
			i++;
			continue;
		}
		// Plain paragraph (coalesce consecutive plain lines)
		const paraLines: string[] = [line.trim()];
		i++;
		while (
			i < lines.length &&
			lines[i]!.trim() &&
			!/^[ \t]{0,3}(?:#{1,6}\s|>|`{3,}|~{3,}|[-*+]\s|\d+\.\s|<!--)/.test(lines[i]!) &&
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

export type DocxBuildOptions = {
	title: string;
	subtitle?: string;
	markdown: string;
	baseDir?: string;
	workspaceRoot?: string;
	meta?: Record<string, string>;
	mermaidPngs?: Record<string, string>;
};

export type DocxParsedResult = {
	markdown: string;
	images: { name: string; bytes: Uint8Array }[];
};

/** Builds a valid `.docx` OpenXML binary archive from Markdown content. */
export function markdownToDocx(options: DocxBuildOptions): Uint8Array {
	const rawBody = frontMatter(options.markdown).body.replace(/\r\n/g, "\n");
	const { bodyLines, footnotes } = extractFootnoteDefs(rawBody.split("\n"));
	const ctx = createDocxContext(options, footnotes);
	const blocks: string[] = [];

	const metaRows = collectMetaRows(options.markdown, options.meta);
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

	const documentXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture">
<w:body>
${blocks.join("\n")}
<w:sectPr><w:pgSz w:w="12240" w:h="15840"/><w:pgMar w:top="1080" w:right="1080" w:bottom="1080" w:left="1080"/></w:sectPr>
</w:body>
</w:document>`;

	const stylesXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
<w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:ascii="Calibri" w:hAnsi="Calibri"/><w:sz w:val="21"/><w:color w:val="18181B"/></w:rPr></w:rPrDefault></w:docDefaults>
<w:style w:type="paragraph" w:styleId="Title"><w:name w:val="Title"/><w:pPr><w:spacing w:before="0" w:after="80"/></w:pPr><w:rPr><w:b/><w:sz w:val="36"/><w:color w:val="09090B"/></w:rPr></w:style>
<w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="heading 1"/><w:pPr><w:keepNext/><w:spacing w:before="260" w:after="100"/><w:pBdr><w:bottom w:val="single" w:sz="4" w:space="4" w:color="E4E4E7"/></w:pBdr></w:pPr><w:rPr><w:b/><w:sz w:val="32"/><w:color w:val="09090B"/></w:rPr></w:style>
<w:style w:type="paragraph" w:styleId="Heading2"><w:name w:val="heading 2"/><w:pPr><w:keepNext/><w:spacing w:before="220" w:after="80"/></w:pPr><w:rPr><w:b/><w:sz w:val="26"/><w:color w:val="18181B"/></w:rPr></w:style>
<w:style w:type="paragraph" w:styleId="Heading3"><w:name w:val="heading 3"/><w:pPr><w:keepNext/><w:spacing w:before="180" w:after="60"/></w:pPr><w:rPr><w:b/><w:sz w:val="23"/><w:color w:val="27272A"/></w:rPr></w:style>
<w:style w:type="paragraph" w:styleId="Heading4"><w:name w:val="heading 4"/><w:pPr><w:keepNext/><w:spacing w:before="140" w:after="40"/></w:pPr><w:rPr><w:b/><w:sz w:val="21"/><w:color w:val="3F3F46"/></w:rPr></w:style>
<w:style w:type="paragraph" w:styleId="Heading5"><w:name w:val="heading 5"/><w:pPr><w:keepNext/><w:spacing w:before="120" w:after="40"/></w:pPr><w:rPr><w:b/><w:sz w:val="20"/><w:color w:val="52525B"/></w:rPr></w:style>
<w:style w:type="paragraph" w:styleId="Heading6"><w:name w:val="heading 6"/><w:pPr><w:keepNext/><w:spacing w:before="100" w:after="40"/></w:pPr><w:rPr><w:b/><w:i/><w:sz w:val="20"/><w:color w:val="52525B"/></w:rPr></w:style>
</w:styles>`;

	const usedImageExts = [...new Set(ctx.mediaEntries.map((m) => m.ext))].sort();
	const imageDefaults = usedImageExts
		.filter((ext) => ext in IMAGE_MIME_BY_EXT)
		.map((ext) => `<Default Extension="${ext}" ContentType="${IMAGE_MIME_BY_EXT[ext]}"/>`)
		.join("\n");

	const contentTypesXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="xml" ContentType="application/xml"/>${imageDefaults ? `\n${imageDefaults}` : ""}
<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
<Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>
</Types>`;

	const rootRelsXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
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

	const enc = new TextEncoder();
	return buildZip([
		{ name: "[Content_Types].xml", data: enc.encode(contentTypesXml) },
		{ name: "_rels/.rels", data: enc.encode(rootRelsXml) },
		{ name: "word/_rels/document.xml.rels", data: enc.encode(docRelsXml) },
		{ name: "word/styles.xml", data: enc.encode(stylesXml) },
		{ name: "word/document.xml", data: enc.encode(documentXml) },
		...ctx.mediaEntries.map((m) => ({ name: m.name, data: m.data })),
	]);
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
				const fence = out.includes("`") ? "``" : "`";
				out = `${fence}${out}${fence}`;
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

/** Parses a `.docx` binary archive into clean Markdown + extracted image payloads. */
export function parseDocxToMarkdown(bytes: Uint8Array): DocxParsedResult {
	const entries = readZipEntries(bytes);
	const byLower = new Map<string, { name: string; data: Uint8Array }>();
	for (const [name, data] of entries) byLower.set(name.toLowerCase(), { name, data });

	const dec = new TextDecoder();
	const docEntry = byLower.get("word/document.xml");
	if (!docEntry) return { markdown: "", images: [] };
	const docXml = dec.decode(docEntry.data);

	const relsEntry = byLower.get("word/_rels/document.xml.rels");
	const rels = relsEntry ? parseRelationships(dec.decode(relsEntry.data)) : new Map<string, ParsedRel>();

	const extractedImages = new Map<string, Uint8Array>();

	const resolveImageRel = (rId: string): string | null => {
		const rel = rels.get(rId);
		if (!rel) return null;
		const cleanTarget = rel.target.replace(/\\/g, "/").replace(/^\/+/, "");
		const candidates = [
			cleanTarget.startsWith("word/") ? cleanTarget : `word/${cleanTarget.replace(/^\.\.\//, "")}`,
			cleanTarget,
		];
		for (const cand of candidates) {
			const hit = byLower.get(cand.toLowerCase());
			if (hit) {
				const imgName = basename(hit.name);
				if (!extractedImages.has(imgName)) extractedImages.set(imgName, hit.data);
				return imgName;
			}
		}
		return null;
	};

	const parseRun = (runInner: string): StyledSegment[] => {
		const segs: StyledSegment[] = [];
		const rPrEl = extractDirectElements(runInner, ["w:rPr"])[0];
		const rPr = rPrEl?.inner ?? "";
		const bold = hasEnabledFlag(rPr, "b");
		const italic = hasEnabledFlag(rPr, "i");
		const strike = hasEnabledFlag(rPr, "strike");
		const highlight = hasEnabledFlag(rPr, "highlight");
		const codeFont = /<w:rFonts\b[^>]*(?:Consolas|Courier|Menlo|Monaco|monospace)/i.test(rPr);

		// Check embedded images (`<a:blip r:embed="rId..."/>`) inside `<w:drawing>` or `<w:pict>`.
		for (const blip of runInner.matchAll(/<a:blip\b[^>]*>/gi)) {
			const rId = xmlAttr(blip[0], "r:embed") || xmlAttr(blip[0], "r:link");
			if (!rId) continue;
			const imgName = resolveImageRel(rId);
			if (imgName) {
				segs.push({ text: `{{DOCX_IMG:${imgName}}}`, bold: false, italic: false, strike: false, code: false, highlight: false, raw: true });
			}
		}

		// Extract text, breaks, and tabs in order.
		const tokenRe = /<w:t\b[^>]*>([\s\S]*?)<\/w:t>|<w:br\b[^>]*\/?>|<w:tab\b[^>]*\/?>/gi;
		let m: RegExpExecArray | null;
		while ((m = tokenRe.exec(runInner)) !== null) {
			const whole = m[0];
			if (/^<w:br\b/i.test(whole)) {
				segs.push({ text: "\n", bold: false, italic: false, strike: false, code: false, highlight: false, raw: true });
			} else if (/^<w:tab\b/i.test(whole)) {
				segs.push({ text: "\t", bold: false, italic: false, strike: false, code: false, highlight: false, raw: true });
			} else {
				const txt = xmlUnesc(m[1] ?? "");
				if (txt) segs.push({ text: txt, bold, italic, strike, code: codeFont, highlight });
			}
		}
		return segs;
	};

	const parseParagraph = (pInner: string, inTableCell = false, suppressBoldCell = false): { text: string; isList: boolean } => {
		const pPr = extractDirectElements(pInner, ["w:pPr"])[0]?.inner ?? "";
		const styleMatch = /<w:pStyle\b[^>]*>/i.exec(pPr);
		const styleVal = styleMatch ? xmlAttr(styleMatch[0], "w:val") : "";
		let headingLevel = 0;
		if (/^title$/i.test(styleVal)) headingLevel = 1;
		else {
			const hm = /^heading\s*([1-6])$/i.exec(styleVal);
			if (hm) headingLevel = Number(hm[1]);
		}

		const hasNumPr = /<w:numPr\b/i.test(pPr);
		const ilvlMatch = /<w:ilvl\b[^>]*>/i.exec(pPr);
		const ilvl = ilvlMatch ? Math.max(0, Number(xmlAttr(ilvlMatch[0], "w:val")) || 0) : 0;

		const segments: StyledSegment[] = [];
		const children = extractDirectElements(pInner, ["w:r", "w:hyperlink"]);
		for (const child of children) {
			if (child.tag === "w:r") {
				segments.push(...parseRun(child.inner));
			} else if (child.tag === "w:hyperlink") {
				const rId = xmlAttr(child.openTag, "r:id");
				const url = rId ? rels.get(rId)?.target : "";
				const innerSegs: StyledSegment[] = [];
				for (const r of extractDirectElements(child.inner, ["w:r"])) {
					innerSegs.push(...parseRun(r.inner));
				}
				const label = formatSegments(innerSegs, headingLevel > 0 || suppressBoldCell).trim();
				if (url && label) {
					const formatted = label === url ? `<${url}>` : `[${label}](${url})`;
					segments.push({ text: formatted, bold: false, italic: false, strike: false, code: false, highlight: false, raw: true });
				} else if (label) {
					segments.push({ text: label, bold: false, italic: false, strike: false, code: false, highlight: false, raw: true });
				}
			}
		}

		let text = formatSegments(segments, headingLevel > 0 || suppressBoldCell).trim();
		if (!text) return { text: "", isList: false };

		if (headingLevel > 0 && !inTableCell) {
			return { text: `${"#".repeat(headingLevel)} ${text}`, isList: false };
		}
		if (hasNumPr && !inTableCell) {
			return { text: `${"  ".repeat(ilvl)}- ${text}`, isList: true };
		}
		if (!inTableCell) {
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

	const bodyMatch = /<w:body\b[^>]*>([\s\S]*)<\/w:body>/i.exec(docXml);
	const bodyXml = bodyMatch ? bodyMatch[1]! : docXml;
	const topBlocks = extractDirectElements(bodyXml, ["w:p", "w:tbl"]);

	const mdLines: string[] = [];
	let prevWasList = false;
	for (const block of topBlocks) {
		if (block.tag === "w:tbl") {
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

	const images = [...extractedImages.entries()].map(([name, imgBytes]) => ({ name, bytes: imgBytes }));
	return { markdown: mdLines.join("\n").replace(/\n{3,}/g, "\n\n").trim(), images };
}
