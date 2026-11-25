// Pure helpers for locating and replacing fenced code blocks inside Markdown
// documents so individual blocks or whole documents can format embedded SQL,
// SSL (via starlims-lsp), JavaScript/TypeScript, HTML, CSS/SCSS/Less, XML/XFD,
// JSON/JSONC, and YAML without disturbing surrounding prose or markers.

import { isFenceClose, normalizeFenceLang, parseFenceOpen, scanQuotePrefix } from "./codeTokens";
import { canFormatNonSsl, type SqlDialect } from "./format";
import { frontMatter } from "./frontMatter";

const FENCE_SQL_DIALECTS: Readonly<Record<string, SqlDialect>> = {
	tsql: "tsql",
	plsql: "plsql",
	mysql: "mysql",
	pgsql: "postgresql",
	postgres: "postgresql",
	postgresql: "postgresql",
	sqlite: "sqlite",
};

export type FenceFormatTarget = {
	languageId: string;
	sqlDialectOverride?: SqlDialect;
};

/** Maps a raw SQL fence tag (e.g. "plsql", "postgres", "tsql") to its explicit dialect, or undefined for generic "sql". */
export function sqlDialectFromFenceLang(rawLang: string | null | undefined): SqlDialect | undefined {
	const token = (rawLang ?? "").trim().split(/\s+/)[0]?.toLowerCase() ?? "";
	return token ? FENCE_SQL_DIALECTS[token] : undefined;
}

/**
 * Resolves a Markdown fence info-string language to a formattable target, or null if unsupported.
 * SSL fences (`ssl`, `srvscr`, `ds`, `starlims`) route to `starlims-lsp` (ADR 0003);
 * non-SSL languages route to Prettier / `@prettier/plugin-xml` / `sql-formatter`.
 */
export function fenceFormatTarget(rawLang: string | null | undefined): FenceFormatTarget | null {
	const token = (rawLang ?? "").trim().split(/\s+/)[0]?.toLowerCase() ?? "";
	if (!token) return null;
	const languageId = normalizeFenceLang(token);
	if (!languageId) return null;
	if (languageId === "ssl") return { languageId: "ssl" };
	// Avoid recursively formatting markdown fences inside markdown documents.
	if (languageId === "markdown") return null;
	if (!canFormatNonSsl(languageId)) return null;
	const sqlDialectOverride = languageId === "sql" ? sqlDialectFromFenceLang(token) : undefined;
	return { languageId, sqlDialectOverride };
}

export type MarkdownCodeFence = {
	/** 1-based line number of the opening fence line. */
	openLine: number;
	/** 1-based line number of the closing fence line, or null when unclosed at EOF. */
	closeLine: number | null;
	/** 1-based first line number of the code body. */
	bodyStartLine: number;
	/** 1-based last line number of the code body (less than bodyStartLine when empty). */
	bodyEndLine: number;
	/** 0-based UTF-16 offset where the body text starts (at start of bodyStartLine). */
	bodyFrom: number;
	/** 0-based UTF-16 offset where the body text ends (end of bodyEndLine, before its newline). */
	bodyTo: number;
	/** Raw first info-string token (e.g. "ssl", "plsql", "xfd", "jsonc"). */
	rawLang: string;
	/** Canonical language id (e.g. "ssl", "sql", "xml", "json"), or "" when untagged. */
	languageId: string;
	/** Explicit SQL dialect implied by the fence tag, if any. */
	sqlDialectOverride?: SqlDialect;
	/** Leading blockquote + space indentation prefix inherited from the opening fence line. */
	linePrefix: string;
	/** Unprefixed body text joined with `\n`. */
	code: string;
};

/** Splits a document into lines while recording exact 0-based start/end offsets (excluding `\r?\n`). */
function scanLines(text: string): { text: string; from: number; to: number }[] {
	const lines: { text: string; from: number; to: number }[] = [];
	let i = 0;
	while (i <= text.length) {
		const nl = text.indexOf("\n", i);
		if (nl < 0) {
			const end = text.endsWith("\r") && text.length > i ? text.length - 1 : text.length;
			lines.push({ text: text.slice(i, end), from: i, to: end });
			break;
		}
		const end = nl > i && text[nl - 1] === "\r" ? nl - 1 : nl;
		lines.push({ text: text.slice(i, end), from: i, to: end });
		i = nl + 1;
	}
	return lines;
}

/** Extracts the leading blockquote + space/tab indentation before the opening fence delimiter. */
function openingLinePrefix(line: string, quotePrefix: string): string {
	const rest = line.slice(quotePrefix.length);
	const indentMatch = /^[ \t]*/.exec(rest);
	return quotePrefix + (indentMatch ? indentMatch[0] : "");
}

/** Strips a blockquoted or list-indented fence's prefix from one body line. */
function stripFenceLinePrefix(line: string, quoteDepth: number, indent: string): string {
	let rest = line;
	if (quoteDepth > 0) {
		const q = scanQuotePrefix(rest, quoteDepth);
		if (q.offset > 0) rest = rest.slice(q.offset);
	}
	if (indent.length > 0 && rest.startsWith(indent)) {
		rest = rest.slice(indent.length);
	} else if (indent.length > 0) {
		// CommonMark strips up to `indent.length` leading spaces if a line has fewer.
		let strip = 0;
		while (strip < indent.length && strip < rest.length && rest[strip] === " ") strip++;
		rest = rest.slice(strip);
	}
	return rest;
}

/** Finds every fenced code block in a Markdown document, skipping YAML frontmatter. */
export function findMarkdownCodeFences(text: string): MarkdownCodeFence[] {
	const lines = scanLines(text);
	// Exclude the synthetic trailing empty line produced after a final `\n` so unclosed
	// fences at EOF never include (and on replacement, delete) the document's trailing newline.
	const lineCount = text.endsWith("\n") && lines.length > 0 ? lines.length - 1 : lines.length;
	const fm = frontMatter(text);
	const startIdx = fm.lines > 0 ? Math.min(fm.lines, lineCount) : 0;

	const out: MarkdownCodeFence[] = [];
	let active: {
		openIdx: number;
		fenceChar: "`" | "~";
		fenceLen: number;
		quotePrefix: string;
		quoteDepth: number;
		indent: string;
		linePrefix: string;
		rawLang: string;
	} | null = null;

	const finish = (closeIdx: number | null, implicitEndIdx?: number) => {
		if (!active) return;
		const bodyStartIdx = active.openIdx + 1;
		const bodyEndIdx = closeIdx !== null ? closeIdx - 1 : (implicitEndIdx ?? lineCount - 1);
		const bodyLines: string[] = [];
		for (let i = bodyStartIdx; i <= bodyEndIdx; i++) {
			bodyLines.push(stripFenceLinePrefix(lines[i]!.text, active.quoteDepth, active.indent));
		}
		const hasBody = bodyStartIdx <= bodyEndIdx;
		const bodyFrom = hasBody ? lines[bodyStartIdx]!.from : lines[active.openIdx]!.to;
		const bodyTo = hasBody ? lines[bodyEndIdx]!.to : bodyFrom;
		const target = fenceFormatTarget(active.rawLang);
		out.push({
			openLine: active.openIdx + 1,
			closeLine: closeIdx !== null ? closeIdx + 1 : null,
			bodyStartLine: bodyStartIdx + 1,
			bodyEndLine: bodyEndIdx + 1,
			bodyFrom,
			bodyTo,
			rawLang: active.rawLang,
			languageId: target?.languageId ?? normalizeFenceLang(active.rawLang),
			sqlDialectOverride: target?.sqlDialectOverride,
			linePrefix: active.linePrefix,
			code: bodyLines.join("\n"),
		});
		active = null;
	};

	for (let i = startIdx; i < lineCount; i++) {
		const line = lines[i]!.text;
		if (active) {
			if (active.quoteDepth > 0 && scanQuotePrefix(line, active.quoteDepth).depth < active.quoteDepth) {
				// Leaving the enclosing blockquote closes the fence before this line without consuming it.
				finish(null, i - 1);
			} else if (isFenceClose(line, active.fenceChar, active.fenceLen, active.quoteDepth, active.indent)) {
				finish(i);
				continue;
			} else {
				continue;
			}
		}
		const open = parseFenceOpen(line);
		if (open) {
			const linePrefix = openingLinePrefix(line, open.quotePrefix);
			const indent = linePrefix.slice(open.quotePrefix.length);
			active = {
				openIdx: i,
				fenceChar: open.fenceChar,
				fenceLen: open.fenceLen,
				quotePrefix: open.quotePrefix,
				quoteDepth: scanQuotePrefix(open.quotePrefix).depth,
				indent,
				linePrefix,
				rawLang: open.lang,
			};
		}
	}
	if (active) finish(null, lineCount - 1);
	return out;
}

/** Finds the fenced code block enclosing the given 1-based line number (including its fence lines). */
export function fenceAtLine(text: string, lineNumber: number): MarkdownCodeFence | null {
	for (const fence of findMarkdownCodeFences(text)) {
		const end = fence.closeLine ?? Math.max(fence.openLine, fence.bodyEndLine);
		if (lineNumber >= fence.openLine && lineNumber <= end) return fence;
	}
	return null;
}

/**
 * Formats a code block's formatted text for insertion back into its Markdown fence:
 * strips trailing blank newlines (the closing fence sits on the next line), re-applies
 * any blockquote/list prefix cleanly, and joins using the document's line ending.
 */
export function formatFenceBodyForMarkdown(formattedCode: string, linePrefix: string, eol: string): string {
	const trimmed = formattedCode.replace(/(?:\r?\n)+$/, "");
	if (!trimmed) return "";
	const hasQuote = linePrefix.includes(">");
	const emptyLinePrefix = hasQuote ? linePrefix.replace(/[ \t]+$/, "") : "";
	return trimmed
		.split(/\r?\n/)
		.map((line) => (line.length === 0 ? emptyLinePrefix : linePrefix + line))
		.join(eol);
}

/**
 * Replaces the body slices of one or more fenced code blocks in a Markdown document
 * from bottom to top in a single pass. `replacements` maps `fence.openLine` to the
 * already-prefixed body string (from `formatFenceBodyForMarkdown`).
 */
export function replaceFencesInMarkdown(text: string, fences: readonly MarkdownCodeFence[], replacements: ReadonlyMap<number, string>): string {
	const targets = fences
		.filter((f) => replacements.has(f.openLine) && f.bodyStartLine <= f.bodyEndLine)
		.sort((a, b) => b.bodyFrom - a.bodyFrom);
	let out = text;
	for (const f of targets) {
		const nextBody = replacements.get(f.openLine)!;
		out = out.slice(0, f.bodyFrom) + nextBody + out.slice(f.bodyTo);
	}
	return out;
}

/** Synthetic file name inside the Markdown document's folder so `.prettierrc` and JSONC/XML rules resolve cleanly. */
export function virtualFencePath(markdownPath: string, fence: Pick<MarkdownCodeFence, "rawLang" | "languageId">): string {
	const slash = Math.max(markdownPath.lastIndexOf("/"), markdownPath.lastIndexOf("\\"));
	const dir = slash >= 0 ? markdownPath.slice(0, slash + 1) : "";
	const raw = fence.rawLang.toLowerCase();
	const extByLang: Record<string, string> = {
		sql: "sql",
		javascript: raw === "jsx" ? "jsx" : "js",
		typescript: raw === "tsx" ? "tsx" : "ts",
		html: "html",
		css: "css",
		scss: "scss",
		less: "less",
		xml: raw === "xfd" ? "xfd" : "xml",
		json: raw === "jsonc" ? "jsonc" : "json",
		yaml: "yaml",
	};
	const ext = extByLang[fence.languageId] ?? "txt";
	return `${dir}__fence__.${ext}`;
}
