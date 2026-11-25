// Pure cross-IDE doc helper utilities (comment doc-ref scanner, Blocks ticket segments,
// and Reference workspace knowledge matching) — zero DOM/Monaco dependencies so unit tests run cleanly.
import { buildDocNameIndex, lookupInIndex, namedLinksIn, type DocNameIndex } from "./namedLinks";
import { dirName, isInside, relativeTo, resolvePath } from "./paths";
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
 * Extracts character spans of comment text per line of SQL (`-- ...`, `/* ... *\/`), ignoring comment openers
 * inside quoted string literals.
 *
 * SQL only. Where a comment is in SSL is the grammar's to say (`sslCommentSpans`, ADR 0003): this used to take a
 * language and read SSL for itself (`//`, an end at `*\/`, a backslash before a quote), which is not how SSL reads.
 */
export function extractCommentSpans(lines: readonly string[]): CommentSpan[][] {
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
					i++;
				}
				if (i > start) spans.push({ from: start, to: i });
				continue;
			}

			const ch = line[i]!;
			const next = line[i + 1];

			if (quote) {
				if (ch === quote) {
					if (next === quote) {
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

			if (ch === "-" && next === "-") {
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

/**
 * Whether what is written at a place in a text would be inside a comment. `spansOf` gives each line's comments:
 * for SSL the grammar's, which highlighting reads, and never a reading of SSL made here (ADR 0003).
 *
 * It is asked of the text up to that place with a letter put there: the letter is in a comment exactly when what is
 * written there would be. Asked of the line as it stands, the place just after a comment's end counted as inside
 * it, and so did the place just before its start.
 */
export function writtenInComment(
	linesBefore: readonly string[],
	lineText: string,
	offset: number,
	spansOf: (lines: readonly string[]) => CommentSpan[][] | null,
): boolean {
	const upTo = [...linesBefore, `${lineText.slice(0, offset)}x`];
	const spans = spansOf(upTo)?.[upTo.length - 1];
	return Boolean(spans?.some((s) => offset >= s.from && offset < s.to));
}

/**
 * What a file dropped on SSL or SQL leaves there: its path alone inside a comment, where it is a note already, and a
 * comment of its own in code.
 *
 * A comment in SSL runs from its opening mark to the first semicolon and ends there. It was written closed by a
 * semicolon and then by the mark that closes a comment in SQL, and that mark was left behind as code. Null where
 * the path has in it what ends a comment: written there, the comment would end inside the path and the rest of
 * the path would be code.
 */
export function droppedFileNote(rel: string, lang: "ssl" | "sql", insideComment: boolean): string | null {
	if (rel.includes(lang === "ssl" ? ";" : "*/")) return null;
	if (insideComment) return rel;
	return lang === "ssl" ? `/* See ${rel};` : `/* See ${rel} */`;
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

function normalizeDocSegments(raw: string): string {
	const parts = raw.replace(/\\/g, "/").split("/");
	const stack: string[] = [];
	for (const part of parts) {
		if (!part || part === ".") continue;
		if (part === "..") {
			if (stack.length) stack.pop();
		} else {
			stack.push(part);
		}
	}
	return stack.join("/").toLowerCase();
}

function resolveDocPath(
	rawPath: string,
	byPath: ReadonlyMap<string, DocFile>,
	files: readonly DocFile[],
	root?: string | null,
	sourcePath?: string | null,
): DocFile | null {
	const forward = rawPath.replace(/\\/g, "/");
	if (sourcePath && /^\.{1,2}\//.test(forward)) {
		const resolved = resolvePath(dirName(sourcePath), forward);
		if (root && !isInside(root, resolved)) return null;
		const relKey = (root ? relativeTo(root, resolved) : resolved).replace(/\\/g, "/").replace(/^\.\//, "").replace(/^\/+/, "").toLowerCase();
		const byRel = byPath.get(relKey);
		if (byRel) return byRel;
		const fullKey = resolved.replace(/\\/g, "/").replace(/^\/+/, "").toLowerCase();
		return byPath.get(fullKey) ?? null;
	}
	const clean = normalizeDocSegments(forward);
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
	const trimmed = frag.trim();
	const lineMatch = /^L(\d+)(?:-L?(\d+))?$/i.exec(trimmed);
	if (lineMatch) {
		const targetLine = Number(lineMatch[1]);
		if (!Number.isFinite(targetLine) || targetLine < 1) return {};
		const rawEnd = lineMatch[2] ? Number(lineMatch[2]) : undefined;
		const targetEndLine = rawEnd !== undefined && Number.isFinite(rawEnd) && rawEnd >= targetLine ? rawEnd : undefined;
		return { targetLine, ...(targetEndLine ? { targetEndLine } : {}) };
	}
	return trimmed ? { heading: trimmed } : {};
}

/**
 * The document references in comments that are given as spans, for a language whose comments are not read here:
 * for SSL the spans are the grammar's (`sslCommentSpans`). Each span is read as the text of one comment, and what
 * is found in it is put back at its place in the line.
 */
export function findCommentDocRefsInSpans(
	lines: readonly string[],
	spansByLine: readonly (readonly CommentSpan[])[],
	files: readonly DocFile[],
	root?: string | null,
): CommentDocRef[] {
	const synthetic: string[] = [];
	const meta: { line: number; spanFrom: number }[] = [];
	for (let lineIdx = 0; lineIdx < lines.length; lineIdx++) {
		const spans = spansByLine[lineIdx];
		if (!spans?.length) continue;
		const lineText = lines[lineIdx]!;
		for (const span of spans) {
			const slice = lineText.slice(span.from, span.to);
			if (!slice.trim()) continue;
			synthetic.push(`-- ${slice}`);
			meta.push({ line: lineIdx + 1, spanFrom: span.from });
		}
	}
	if (!synthetic.length) return [];
	const raw = findCommentDocRefsInLines(synthetic, files, root);
	const out: CommentDocRef[] = [];
	for (const r of raw) {
		const m = meta[r.line - 1];
		if (!m || r.from < 3) continue;
		out.push({
			...r,
			line: m.line,
			from: m.spanFrom + (r.from - 3),
			to: m.spanFrom + (r.to - 3),
		});
	}
	return out;
}

/**
 * Finds clickable workspace doc paths (`docs/...md`, `design/...plan.json`, `schema/...md`)
 * and `[[wikilink]]` tokens inside the comments of SQL lines.
 */
export function findCommentDocRefsInLines(
	lines: readonly string[],
	files: readonly DocFile[],
	root?: string | null,
	precomputed?: { nameIndex?: DocNameIndex; pathMap?: ReadonlyMap<string, DocFile>; sourcePath?: string },
): CommentDocRef[] {
	const existing = files.filter((f) => f.exists);
	if (!existing.length || !lines.length) return [];
	const spansByLine = extractCommentSpans(lines);
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
					const doc = resolveDocPath(rawPath, pathMap, existing, root, precomputed?.sourcePath);
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
