// Pure cross-IDE doc helper utilities (comment doc-ref scanner, Blocks ticket segments,
// and Reference workspace knowledge matching) — zero DOM/Monaco dependencies so unit tests run cleanly.
import { buildDocNameIndex, lookupInIndex, namedLinksIn, type DocNameIndex } from "./namedLinks";
import { relativeTo } from "./paths";
import { isCatalog } from "./projectDocs";
import type { DocFile } from "./protocol";
import { ticketMatcher } from "./ticketRefs";

export type CommentSpan = { from: number; to: number };

export type CommentDocRef = {
	/** 1-based line number. */
	line: number;
	/** 0-based start column on that line. */
	from: number;
	/** 0-based end column (exclusive) on that line. */
	to: number;
	kind: "wikilink" | "path";
	doc: DocFile;
	targetLine?: number;
	targetEndLine?: number;
	heading?: string;
	raw: string;
};

/**
 * Extracts character spans of comment text per line for SSL (`/* ... ;`, `/* ... *\/`, `// ...`)
 * and SQL (`-- ...`, `/* ... *\/`), ignoring comment openers inside quoted string literals.
 */
export function extractCommentSpans(lines: readonly string[], lang: "ssl" | "sql"): CommentSpan[][] {
	const out: CommentSpan[][] = [];
	let inBlock = false;

	for (const line of lines) {
		const spans: CommentSpan[] = [];
		const n = line.length;
		let i = 0;
		let quote: string | null = null;

		while (i < n) {
			if (inBlock) {
				const start = i;
				while (i < n) {
					if (line[i] === "*" && line[i + 1] === "/") {
						i += 2;
						inBlock = false;
						break;
					}
					if (lang === "ssl" && line[i] === ";") {
						i++;
						inBlock = false;
						break;
					}
					i++;
				}
				if (i > start) spans.push({ from: start, to: i });
				continue;
			}

			const ch = line[i]!;
			const next = line[i + 1];

			if (quote) {
				if (ch === "\\" && lang === "ssl" && i + 1 < n) {
					i += 2;
					continue;
				}
				if (ch === quote) {
					if (lang === "sql" && next === quote) {
						i += 2;
						continue;
					}
					quote = null;
				}
				i++;
				continue;
			}

			if (ch === "'" || ch === '"') {
				quote = ch;
				i++;
				continue;
			}

			if (lang === "sql" && ch === "-" && next === "-") {
				spans.push({ from: i, to: n });
				break;
			}
			if (lang === "ssl" && ch === "/" && next === "/") {
				spans.push({ from: i, to: n });
				break;
			}
			if (ch === "/" && next === "*") {
				const start = i;
				i += 2;
				inBlock = true;
				while (i < n) {
					if (line[i] === "*" && line[i + 1] === "/") {
						i += 2;
						inBlock = false;
						break;
					}
					if (lang === "ssl" && line[i] === ";") {
						i++;
						inBlock = false;
						break;
					}
					i++;
				}
				spans.push({ from: start, to: i });
				continue;
			}
			i++;
		}
		out.push(spans);
	}
	return out;
}

const DOC_PATH_RE =
	/(?:^|[\s([{"'`<,])((?:\.?\/)?(?:[A-Za-z0-9_.-]+\/)*[A-Za-z0-9_.-]+\.(?:md|markdown|plan\.json|sql|ddl|csv|tsv))(?:#([A-Za-z0-9_.-]+))?(?=$|[\s)\]}"'`>,;:!?])/gi;

function buildDocPathLookup(files: readonly DocFile[], root?: string | null): Map<string, DocFile> {
	const map = new Map<string, DocFile>();
	const norm = (s: string) => s.replace(/\\/g, "/").replace(/^\.\//, "").replace(/^\/+/, "").toLowerCase();
	for (const d of files) {
		if (!d.exists) continue;
		const rel = root ? relativeTo(root, d.path) : d.path;
		const relKey = norm(rel);
		if (relKey && !map.has(relKey)) map.set(relKey, d);
		const fullKey = norm(d.path);
		if (fullKey && !map.has(fullKey)) map.set(fullKey, d);
	}
	return map;
}

function resolveDocPath(rawPath: string, byPath: ReadonlyMap<string, DocFile>, files: readonly DocFile[]): DocFile | null {
	const clean = rawPath.replace(/\\/g, "/").replace(/^\.\//, "").replace(/^\/+/, "").toLowerCase();
	if (!clean) return null;
	const exact = byPath.get(clean);
	if (exact) return exact;
	if (clean.includes("/")) {
		const suffix = `/${clean}`;
		for (const d of files) {
			if (!d.exists) continue;
			const full = d.path.replace(/\\/g, "/").toLowerCase();
			if (full === clean || full.endsWith(suffix)) return d;
		}
	}
	return null;
}

function parseDocFragment(frag: string | undefined): { targetLine?: number; targetEndLine?: number; heading?: string } {
	if (!frag) return {};
	const lineMatch = /^L(\d+)(?:-L?(\d+))?$/i.exec(frag.trim());
	if (lineMatch) {
		const targetLine = Number(lineMatch[1]);
		const targetEndLine = lineMatch[2] ? Number(lineMatch[2]) : undefined;
		return { targetLine, ...(targetEndLine ? { targetEndLine } : {}) };
	}
	return { heading: frag.trim() };
}

/**
 * Finds clickable workspace doc paths (`docs/...md`, `design/...plan.json`, `schema/...md`)
 * and `[[wikilink]]` tokens inside SSL or SQL comments.
 */
export function findCommentDocRefsInLines(
	lines: readonly string[],
	lang: "ssl" | "sql",
	files: readonly DocFile[],
	root?: string | null,
	precomputed?: { nameIndex?: DocNameIndex; pathMap?: ReadonlyMap<string, DocFile> },
): CommentDocRef[] {
	const existing = files.filter((f) => f.exists);
	if (!existing.length || !lines.length) return [];
	const spansByLine = extractCommentSpans(lines, lang);
	const nameIndex = precomputed?.nameIndex ?? buildDocNameIndex(existing, root);
	const pathMap = precomputed?.pathMap ?? buildDocPathLookup(existing, root);
	const results: CommentDocRef[] = [];

	for (let lineIdx = 0; lineIdx < lines.length; lineIdx++) {
		const spans = spansByLine[lineIdx];
		if (!spans?.length) continue;
		const lineText = lines[lineIdx]!;
		const taken: [number, number][] = [];

		for (const span of spans) {
			const slice = lineText.slice(span.from, span.to);
			if (!slice.trim()) continue;

			if (slice.includes("[[")) {
				for (const m of namedLinksIn(slice)) {
					const doc = lookupInIndex(m.link.name, nameIndex);
					if (!doc) continue;
					const from = span.from + m.from;
					const to = span.from + m.to;
					taken.push([from, to]);
					results.push({
						line: lineIdx + 1,
						from,
						to,
						kind: "wikilink",
						doc,
						...(m.link.heading ? { heading: m.link.heading } : {}),
						raw: slice.slice(m.from, m.to),
					});
				}
			}

			if (slice.includes(".")) {
				DOC_PATH_RE.lastIndex = 0;
				for (let m = DOC_PATH_RE.exec(slice); m; m = DOC_PATH_RE.exec(slice)) {
					const rawPath = m[1]!;
					const frag = m[2];
					const fullToken = frag ? `${rawPath}#${frag}` : rawPath;
					const leadOffset = m[0].indexOf(rawPath);
					const from = span.from + m.index + leadOffset;
					const to = from + fullToken.length;
					if (taken.some(([a, b]) => from < b && to > a)) continue;
					const doc = resolveDocPath(rawPath, pathMap, existing);
					if (!doc) continue;
					taken.push([from, to]);
					results.push({
						line: lineIdx + 1,
						from,
						to,
						kind: "path",
						doc,
						...parseDocFragment(frag),
						raw: fullToken,
					});
				}
			}
		}
	}
	return results;
}

export type TicketSegment = { text: string; ticket?: string };

/** Splits file banner or comment text into plain runs and clickable workspace ticket key segments. */
export function ticketRefsIn(text: string, keys: readonly string[]): TicketSegment[] {
	if (!text) return [];
	if (!keys.length) return [{ text }];
	const mentions = ticketMatcher(keys)(text);
	if (!mentions.length) return [{ text }];
	const out: TicketSegment[] = [];
	let cursor = 0;
	for (const m of mentions) {
		if (m.from > cursor) out.push({ text: text.slice(cursor, m.from) });
		out.push({ text: text.slice(m.from, m.to), ticket: m.key });
		cursor = m.to;
	}
	if (cursor < text.length) out.push({ text: text.slice(cursor) });
	return out;
}

/** Finds kept snippets and decisions/reference notes in `docs()` mentioning a STARLIMS built-in. */
export function matchingProjectDocsForReference(
	label: string,
	allDocs: readonly DocFile[],
): { snippets: DocFile[]; notes: DocFile[] } {
	const term = label.trim();
	if (term.length < 2) return { snippets: [], notes: [] };
	const esc = term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	const re = new RegExp(`(?<![A-Za-z0-9_])${esc}(?![A-Za-z0-9_])`, "i");
	const snippets: DocFile[] = [];
	const notes: DocFile[] = [];
	for (const d of allDocs) {
		if (!d.exists || isCatalog(d) || d.group !== "knowledge") continue;
		if (d.kind !== "snippets" && d.kind !== "decisions" && d.kind !== "reference") continue;
		const stem = (d.name.split(/[\\/]/).pop() ?? d.name).replace(/\.[^.]+$/, "");
		const hay = [d.title ?? "", d.summary ?? "", stem, ...(d.codeRefs ?? [])].join(" ");
		if (!re.test(hay)) continue;
		if (d.kind === "snippets") snippets.push(d);
		else notes.push(d);
	}
	return { snippets, notes };
}
