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
 *
 * Null where nothing can say (the grammar is not loaded). That was answered "no", which is an answer: see
 * `droppedFileNote` for what it wrote into a comment.
 */
export function writtenInComment(
	linesBefore: readonly string[],
	lineText: string,
	offset: number,
	spansOf: (lines: readonly string[]) => CommentSpan[][] | null,
): boolean | null {
	const upTo = [...linesBefore, `${lineText.slice(0, offset)}x`];
	const spans = spansOf(upTo)?.[upTo.length - 1];
	if (!spans) return null;
	return spans.some((s) => offset >= s.from && offset < s.to);
}

/**
 * Whose comments a file dropped on code of this language is written as: SSL's, SQL's, or none (its path alone).
 * Every SQL the editor has a language for is SQL here (`shared/languages.ts`): only `sql` was asked for, and on a
 * `.pgsql` or `.mysql` file the bare path was written into the code.
 */
export function droppedNoteLanguage(languageId: string): "ssl" | "sql" | null {
	if (languageId === "ssl") return "ssl";
	return languageId === "sql" || languageId === "pgsql" || languageId === "mysql" ? "sql" : null;
}

/**
 * As many lines of SSL as are read to learn whether one place is in a comment. A comment may have been opened
 * anywhere above, so the grammar reads from the first line, at some 25 ms for a thousand lines: half a second here.
 * The limit was 5,000, taken from the hover, which asks at every move of the mouse; a drop asks once.
 */
export const COMMENT_SCAN_LINES = 20_000;

/**
 * Whether a file dropped at a line (from 1) and a place in it (from 0) lands in a comment, or null where that is
 * not known: past the lines read for it, or with no grammar to read them.
 *
 * Past the limit the answer was "no", and so was it without the grammar. A drop into a long comment down there
 * then wrote a comment of its own into it, which in SSL ends the comment around it at the note's semicolon and
 * leaves the rest of that comment as code. SQL has no limit: its comments are found by a walk over the letters.
 */
export function droppedInComment(
	lang: "ssl" | "sql",
	lineNumber: number,
	lineAt: (lineNumber: number) => string,
	offset: number,
	spansOf: (lines: readonly string[]) => CommentSpan[][] | null,
): boolean | null {
	if (lang === "ssl" && lineNumber > COMMENT_SCAN_LINES) return null;
	const before: string[] = [];
	for (let n = 1; n < lineNumber; n++) before.push(lineAt(n));
	return writtenInComment(before, lineAt(lineNumber), offset, spansOf);
}

/**
 * What a file dropped on SSL or SQL leaves there: its path alone inside a comment, where it is a note already, and a
 * comment of its own in code.
 *
 * A comment in SSL runs from its opening mark to the first semicolon and ends there. It was written closed by a
 * semicolon and then by the mark that closes a comment in SQL, and that mark was left behind as code. Null where
 * the path has in it what ends a comment: written there, the comment would end inside the path and the rest of
 * the path would be code.
 *
 * `insideComment` is null where it is not known (`droppedInComment`). Then the path alone is written too: in code
 * it is plainly out of place and one undo away, while a comment written into a comment breaks that one without a
 * sign of it.
 */
export function droppedFileNote(rel: string, lang: "ssl" | "sql", insideComment: boolean | null): string | null {
	if (rel.includes(lang === "ssl" ? ";" : "*/")) return null;
	if (insideComment !== false) return rel;
	return lang === "ssl" ? `/* See ${rel};` : `/* See ${rel} */`;
}

// --- What is dragged inside the app, and where it may be let go -------------------------------------------------

/** Something dragged: a row of the Explorer, a row of the Docs panel, an editor tab, or files from outside the app. */
export type DragSource = "explorer-row" | "docs-row" | "tab" | "os-files";
/** Somewhere it is let go: a folder of the Explorer, the text of a code editor or of a Markdown editor, a row of tabs. */
export type DropTarget = "explorer-folder" | "code-editor" | "markdown-editor" | "tab-strip";
/** What the drop does: `move` moves the thing itself; `copy` leaves it where it is (a reference to it is written, or it is brought in). */
export type DragEffect = "copy" | "move";

/** The kind of data each drag carries: all that a target sees of what is over it. */
export const DRAG_TYPE: Record<DragSource, string> = {
	"explorer-row": "application/x-ssl-studio-file",
	"docs-row": "application/x-ssl-studio-file",
	tab: "application/x-ssl-studio-tab",
	"os-files": "Files",
};

/**
 * Every drag that is meant to end in a drop, and what the drop does there.
 *
 * A browser lets a drop happen only when the effect the target asks for (`dropEffect`) is one the source allowed
 * (`effectAllowed`); otherwise no `drop` event comes at all. Each side had its own word written where it was
 * needed. The Explorer's rows and the tabs allowed `move` alone and the editors asked for `copy`, so a file could
 * never be dropped from the Explorer on code or on a Markdown document, nor a tab on a Markdown document, though
 * both editors had the code for it; from the Docs panel, which allowed both, the same drop worked. Both sides now
 * read this one table, so what a source allows is what its targets ask for.
 */
export const DRAG_PAIRS: readonly (readonly [from: DragSource, onto: DropTarget, effect: DragEffect])[] = [
	// The file goes into the folder.
	["explorer-row", "explorer-folder", "move"],
	// A note of the file, or a link to it, is written into the text. The file stays where it is.
	["explorer-row", "code-editor", "copy"],
	["explorer-row", "markdown-editor", "copy"],
	["docs-row", "code-editor", "copy"],
	["docs-row", "markdown-editor", "copy"],
	// The tab goes to another place in its row, or to another group's row.
	["tab", "tab-strip", "move"],
	// A link to the tab's file is written into the document.
	["tab", "markdown-editor", "copy"],
	// Brought into the folder, or (a picture) into the document's folder with a link to it.
	["os-files", "explorer-folder", "copy"],
	["os-files", "markdown-editor", "copy"],
];

/**
 * What a source allows when its drag starts: every effect one of its targets asks for. (Files from outside the
 * app are not started here: what they allow is the system's to say.)
 */
export function effectAllowedFor(from: DragSource): "none" | "copy" | "move" | "copyMove" {
	const effects = new Set(DRAG_PAIRS.filter(([source]) => source === from).map(([, , effect]) => effect));
	return effects.has("copy") ? (effects.has("move") ? "copyMove" : "copy") : effects.has("move") ? "move" : "none";
}

/** What a target asks for while this source is over it: `none` where a drop of it there is not meant. */
export function dragEffect(from: DragSource, onto: DropTarget): DragEffect | "none" {
	return DRAG_PAIRS.find(([source, target]) => source === from && target === onto)?.[2] ?? "none";
}

/**
 * The same, for a target that sees only the kinds of data over it (`DataTransfer.types`) and not where they come
 * from: the Explorer's rows and the Docs panel's carry the same kind.
 */
export function dropEffectFor(onto: DropTarget, types: Iterable<string> | ArrayLike<string>): DragEffect | "none" {
	const carried = Array.from(types);
	return DRAG_PAIRS.find(([source, target]) => target === onto && carried.includes(DRAG_TYPE[source]))?.[2] ?? "none";
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
