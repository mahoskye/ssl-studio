// Live `#L10-L20` code citation drift detection and 1-click re-anchoring (ADR 0002).
// Inspects links like `[src/DueDates/SetSampleDueDates.ssl, lines 10 to 25](...#L10-L25)`
// and any immediately following quoted code fence against the live file on disk.
import { fenced } from "./catalog";
import { frontMatter } from "./frontMatter";
import { dirName, isInside, joinPath, resolvePath } from "./paths";

export type CodeCitation = {
	/** 1-based line number of the link in the Markdown document. */
	line: number;
	/** Raw href inside `(...)`. */
	href: string;
	/** File portion of href (before `#L...`). */
	file: string;
	/** 1-based start line cited. */
	from: number;
	/** 1-based end line cited. */
	to: number;
	/** Immediately following fenced code snippet, if present. */
	snippet?: string;
};

export type CitationIssue = {
	docPath: string;
	docLine: number;
	targetPath: string;
	citation: CodeCitation;
	kind: "out-of-range" | "shifted" | "drifted";
	level: "warn" | "note";
	text: string;
	reanchor?: { from: number; to: number };
};

import { CODE_LINES_KEPT } from "./projectDocs";

const LINK_LINE_RE = /\[[^\]]+\]\(([^)\s#]+)(#L(\d+)(?:-L?(\d+))?)\)/gi;
const NON_CODE_FENCE_LANGS = new Set(["mermaid", "mmd", "markdown", "md", "text", "txt", "csv", "tsv"]);

function inlineCodeSpans(line: string): [number, number][] {
	const ranges: [number, number][] = [];
	let i = 0;
	while (i < line.length) {
		if (line[i] !== "`") {
			i++;
			continue;
		}
		let run = 0;
		while (i + run < line.length && line[i + run] === "`") run++;
		let j = i + run;
		let closed = -1;
		while (j < line.length) {
			if (line[j] !== "`") {
				j++;
				continue;
			}
			let cRun = 0;
			while (j + cRun < line.length && line[j + cRun] === "`") cRun++;
			if (cRun === run) {
				closed = j + cRun;
				break;
			}
			j += cRun;
		}
		if (closed >= 0) {
			ranges.push([i, closed]);
			i = closed;
		} else i += run;
	}
	return ranges;
}

/** Finds all `#L<from>` / `#L<from>-L<to>` workspace file citations in a Markdown document (outside code fences & inline code). */
export function findCodeCitations(markdown: string): CodeCitation[] {
	const lines = markdown.split(/\r?\n/);
	const fences = fenced(markdown);
	const fmLines = frontMatter(markdown).lines;
	const out: CodeCitation[] = [];

	let offset = 0;
	const lineOffsets: number[] = [];
	for (let i = 0; i < lines.length; i++) {
		lineOffsets.push(offset);
		offset += lines[i]!.length + (markdown[offset + lines[i]!.length] === "\r" ? 2 : 1);
	}

	const inFence = (lineIdx: number) => {
		const start = lineOffsets[lineIdx] ?? 0;
		return fences.some(([a, b]) => start >= a && start < b);
	};

	for (let i = fmLines; i < lines.length; i++) {
		const lineText = lines[i]!;
		if (!/#l\d/i.test(lineText) || inFence(i)) continue;
		const codeSpans = lineText.includes("`") ? inlineCodeSpans(lineText) : [];
		const matches = [...lineText.matchAll(LINK_LINE_RE)].filter((m) => {
			const idx = m.index ?? 0;
			return !codeSpans.some(([a, b]) => idx >= a && idx < b);
		});
		if (!matches.length) continue;

		// Look ahead across at most blank lines (no arbitrary multi-line prose skipping) for an immediately following quoted code block.
		// Only bind that fence when there is a single citation on the preceding line (avoiding binding two citations to one fence).
		let followingSnippet: string | undefined;
		if (matches.length === 1) {
			for (let j = i + 1; j < Math.min(lines.length, i + 4); j++) {
				const nextLine = lines[j]!.trim();
				if (!nextLine) continue;
				const open = /^(`{3,}|~{3,})[ \t]*([A-Za-z0-9_+-]*)/.exec(nextLine);
				if (open) {
					const lang = (open[2] ?? "").toLowerCase();
					if (NON_CODE_FENCE_LANGS.has(lang)) break;
					const ch = open[1]![0]!;
					const len = open[1]!.length;
					const closeRe = new RegExp(`^[ \\t]{0,3}${ch}{${len},}[ \\t]*$`);
					const block: string[] = [];
					for (let k = j + 1; k < lines.length; k++) {
						if (closeRe.test(lines[k]!)) {
							followingSnippet = block.join("\n");
							break;
						}
						block.push(lines[k]!);
					}
				}
				break;
			}
		}

		for (const m of matches) {
			const file = m[1]!;
			if (/^https?:/i.test(file)) continue;
			const rawAnchor = m[2]!;
			const from = Number(m[3]);
			const to = m[4] ? Number(m[4]) : from;
			if (!Number.isFinite(from) || from < 1 || to < from) continue;

			out.push({
				line: i + 1,
				href: `${file}${rawAnchor}`,
				file,
				from,
				to,
				...(followingSnippet !== undefined ? { snippet: followingSnippet } : {}),
			});
		}
	}
	return out;
}

const normLine = (s: string) => s.trim().replace(/\s+/g, " ");

/** Searches `targetLines` for an exact normalized match of `snippetLines`, returning 1-based `[from, to]`. */
function locateSnippet(targetLines: readonly string[], snippetLines: readonly string[]): { from: number; to: number } | null {
	const clean = snippetLines.map(normLine);
	const nonEmpty = clean.filter(Boolean);
	if (!nonEmpty.length || clean.length > targetLines.length) return null;

	// 1. Try exact normalized multi-line match.
	const normTarget = targetLines.map(normLine);
	for (let i = 0; i <= normTarget.length - clean.length; i++) {
		let ok = true;
		for (let j = 0; j < clean.length; j++) {
			if (normTarget[i + j] !== clean[j]) {
				ok = false;
				break;
			}
		}
		if (ok) return { from: i + 1, to: i + clean.length };
	}

	// 2. Fallback: match first 2 non-empty anchor lines if unique in file.
	if (nonEmpty.length >= 2) {
		const hits: number[] = [];
		for (let i = 0; i < normTarget.length - 1; i++) {
			if (normTarget[i] === nonEmpty[0] && normTarget[i + 1] === nonEmpty[1]) hits.push(i);
		}
		if (hits.length === 1) {
			const start = hits[0]!;
			return { from: start + 1, to: Math.min(targetLines.length, start + clean.length) };
		}
	}
	return null;
}

/** Checks all code citations in `docPath` against current workspace files on disk. */
export async function checkCodeCitations(
	docPath: string,
	markdown: string,
	root: string,
	readFile: (path: string) => Promise<string | null>,
): Promise<CitationIssue[]> {
	const citations = findCodeCitations(markdown);
	if (!citations.length) return [];
	const issues: CitationIssue[] = [];
	const cache = new Map<string, string[] | null>();

	for (const cit of citations) {
		const decoded = (() => {
			try {
				return decodeURIComponent(cit.file);
			} catch {
				return cit.file;
			}
		})();
		const targetPath = decoded.startsWith("/")
			? joinPath(root, ...decoded.split("/").filter(Boolean))
			: resolvePath(dirName(docPath), decoded);
		if (!isInside(root, targetPath)) continue;

		if (!cache.has(targetPath)) {
			const txt = await readFile(targetPath);
			cache.set(targetPath, txt === null ? null : txt.split(/\r?\n/));
		}
		const targetLines = cache.get(targetPath);
		if (!targetLines) continue; // Missing file is already caught by broken-link check.

		const snippetLines = cit.snippet ? cit.snippet.split(/\r?\n/) : null;
		const relFile = cit.file.replace(/^(?:\.\.\/)+/, "");

		if (cit.from > targetLines.length || cit.to > targetLines.length) {
			const rawFound = snippetLines ? locateSnippet(targetLines, snippetLines) : null;
			const origSpan = Math.max(0, cit.to - cit.from);
			const isTrunc = Boolean(snippetLines && snippetLines.length === CODE_LINES_KEPT && origSpan >= CODE_LINES_KEPT);
			const found = rawFound
				? { from: rawFound.from, to: isTrunc ? Math.min(targetLines.length, rawFound.from + origSpan) : rawFound.to }
				: null;
			issues.push({
				docPath,
				docLine: cit.line,
				targetPath,
				citation: cit,
				kind: "out-of-range",
				level: "warn",
				text: found
					? `Citation ${relFile}#L${cit.from}-L${cit.to} is out of range (file has ${targetLines.length} lines; snippet found at L${found.from}-L${found.to}).`
					: `Citation ${relFile}#L${cit.from}-L${cit.to} exceeds file length (${targetLines.length} lines).`,
				...(found ? { reanchor: found } : {}),
			});
			continue;
		}

		if (snippetLines && snippetLines.some((l) => l.trim().length > 0)) {
			const currentSlice = targetLines.slice(cit.from - 1, cit.to);
			// Accept exact match OR prefix match when `codeSection()` truncated a >40-line excerpt at `CODE_LINES_KEPT`.
			const truncatedExcerpt = snippetLines.length === CODE_LINES_KEPT && currentSlice.length > CODE_LINES_KEPT;
			const matchesNow =
				(currentSlice.length === snippetLines.length || truncatedExcerpt) &&
				snippetLines.every((line, idx) => normLine(currentSlice[idx] ?? "") === normLine(line));
			if (!matchesNow) {
				const rawMoved = locateSnippet(targetLines, snippetLines);
				const origSpan = Math.max(0, cit.to - cit.from);
				const moved = rawMoved
					? {
							from: rawMoved.from,
							to: truncatedExcerpt ? Math.min(targetLines.length, rawMoved.from + origSpan) : rawMoved.to,
						}
					: null;
				if (moved && (moved.from !== cit.from || moved.to !== cit.to)) {
					issues.push({
						docPath,
						docLine: cit.line,
						targetPath,
						citation: cit,
						kind: "shifted",
						level: "note",
						text: `Citation ${relFile}#L${cit.from}-L${cit.to} moved to L${moved.from}-L${moved.to}.`,
						reanchor: moved,
					});
				} else if (!moved) {
					issues.push({
						docPath,
						docLine: cit.line,
						targetPath,
						citation: cit,
						kind: "drifted",
						level: "note",
						text: `Quoted code at ${relFile}#L${cit.from}-L${cit.to} has changed since it was captured.`,
					});
				}
			}
		}
	}
	return issues;
}

/** Surgically re-anchors a citation line `#L<from>-L<to>` (and `lines <from> to <to>` label) to new line numbers. */
export function reanchorCitation(markdown: string, citation: CodeCitation, newFrom: number, newTo: number): string {
	const parts = markdown.split(/(\r?\n)/);
	const idx = (citation.line - 1) * 2;
	const line = parts[idx];
	if (line === undefined) return markdown;
	const newAnchor = newFrom === newTo ? `#L${newFrom}` : `#L${newFrom}-L${newTo}`;
	const oldHrefEsc = citation.href.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	let next = line.replace(new RegExp(`\\(${oldHrefEsc}\\)`), `(${citation.file}${newAnchor})`);
	// Also update human-readable `lines X to Y` / `line X` phrasing on the same line if present.
	if (citation.from !== citation.to) {
		next = next.replace(new RegExp(`\\blines\\s+${citation.from}\\s+to\\s+${citation.to}\\b`, "i"), newFrom === newTo ? `line ${newFrom}` : `lines ${newFrom} to ${newTo}`);
	} else {
		next = next.replace(new RegExp(`\\bline\\s+${citation.from}\\b`, "i"), newFrom === newTo ? `line ${newFrom}` : `lines ${newFrom} to ${newTo}`);
	}
	parts[idx] = next;
	return parts.join("");
}

/**
 * Replaces the quoted fenced code snippet immediately following a drifted citation
 * with the live lines (`citation.from..citation.to`, capped at `CODE_LINES_KEPT`)
 * from `targetText`, preserving surrounding prose and EOLs (ADR 0002).
 */
export function refreshCitationExcerpt(markdown: string, citation: CodeCitation, targetText: string): string | null {
	const eol = markdown.includes("\r\n") ? "\r\n" : "\n";
	const lines = markdown.split(/\r?\n/);
	const targetLines = targetText.split(/\r?\n/);
	if (citation.from < 1 || citation.from > targetLines.length) return null;
	const endLine = Math.min(citation.to, targetLines.length);
	const excerpt = targetLines.slice(citation.from - 1, Math.min(endLine, citation.from - 1 + CODE_LINES_KEPT));

	// Locate the immediately following fenced code block (within 3 lines of citation.line).
	let fenceStart = -1;
	let fenceChar = "`";
	let fenceLen = 3;
	for (let j = citation.line; j < Math.min(lines.length, citation.line + 4); j++) {
		const trimmed = lines[j]!.trim();
		if (!trimmed) continue;
		const open = /^([`~]{3,})([^\s`]*)/.exec(trimmed);
		if (open) {
			fenceStart = j;
			fenceChar = open[1]![0]!;
			fenceLen = open[1]!.length;
		}
		break;
	}
	if (fenceStart < 0) return null;
	let fenceEnd = -1;
	for (let j = fenceStart + 1; j < lines.length; j++) {
		const close = new RegExp(`^\\s*${fenceChar === "`" ? "`" : "~"}{${fenceLen},}\\s*$`);
		if (close.test(lines[j]!)) {
			fenceEnd = j;
			break;
		}
	}
	if (fenceEnd < 0) return null;
	const updated = [...lines.slice(0, fenceStart + 1), ...excerpt, ...lines.slice(fenceEnd)];
	return updated.join(eol);
}
