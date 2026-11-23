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

const LINK_LINE_RE = /\[[^\]]+\]\(([^)\s#]+)#L(\d+)(?:-L?(\d+))?\)/g;

/** Finds all `#L<from>` / `#L<from>-L<to>` workspace file citations in a Markdown document (outside code fences). */
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
		if (!lineText.includes("#L") || inFence(i)) continue;
		for (const m of lineText.matchAll(LINK_LINE_RE)) {
			const file = m[1]!;
			if (/^https?:/i.test(file)) continue;
			const from = Number(m[2]);
			const to = m[3] ? Number(m[3]) : from;
			if (!Number.isFinite(from) || from < 1 || to < from) continue;

			// Look ahead up to 4 blank/prose lines for an immediately following quoted fenced code block.
			let snippet: string | undefined;
			for (let j = i + 1; j < Math.min(lines.length, i + 6); j++) {
				const nextLine = lines[j]!.trim();
				if (!nextLine) continue;
				if (/^#{1,6}\s/.test(nextLine)) break;
				const open = /^(`{3,}|~{3,})/.exec(nextLine);
				if (open) {
					const ch = open[1]![0]!;
					const len = open[1]!.length;
					const closeRe = new RegExp(`^[ \\t]{0,3}${ch}{${len},}[ \\t]*$`);
					const block: string[] = [];
					for (let k = j + 1; k < lines.length; k++) {
						if (closeRe.test(lines[k]!)) {
							snippet = block.join("\n");
							break;
						}
						block.push(lines[k]!);
					}
					break;
				}
			}

			out.push({
				line: i + 1,
				href: `${file}#L${m[2]}${m[3] ? `-L${m[3]}` : ""}`,
				file,
				from,
				to,
				...(snippet !== undefined ? { snippet } : {}),
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
			const found = snippetLines ? locateSnippet(targetLines, snippetLines) : null;
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
			const matchesNow =
				currentSlice.length === snippetLines.length &&
				currentSlice.every((line, idx) => normLine(line) === normLine(snippetLines[idx]!));
			if (!matchesNow) {
				const moved = locateSnippet(targetLines, snippetLines);
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
