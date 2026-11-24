// Pure helpers for parsing Monaco colorized HTML into per-line token spans and
// parsing Markdown fenced code block headers/closers consistently across Live
// and Read views (no DOM or Monaco runtime dependency, so unit-testable).

export type CodeTokenSpan = {
	/** 0-based UTF-16 start column within the code line. */
	from: number;
	/** 0-based UTF-16 exclusive end column within the code line. */
	to: number;
	/** Space-separated Monaco `.mtk*` token colour and font-style classes. */
	className: string;
};

/** Standard language aliases that may appear on a Markdown code fence. */
export const CODE_LANGUAGE_ALIASES: Readonly<Record<string, string>> = {
	ssl: "ssl",
	srvscr: "ssl",
	ds: "ssl",
	starlims: "ssl",
	md: "markdown",
	markdown: "markdown",
	sql: "sql",
	tsql: "sql",
	plsql: "sql",
	mysql: "sql",
	pgsql: "sql",
	postgres: "sql",
	postgresql: "sql",
	sqlite: "sql",
	json: "json",
	jsonc: "json",
	toml: "toml",
	csv: "csv",
	tsv: "csv",
	yml: "yaml",
	yaml: "yaml",
	xml: "xml",
	xfd: "xml",
	xsd: "xml",
	xsl: "xml",
	xslt: "xml",
	wsdl: "xml",
	csproj: "xml",
	svg: "xml",
	config: "xml",
	ini: "ini",
	conf: "ini",
	cfg: "ini",
	properties: "ini",
	sh: "shell",
	bash: "shell",
	zsh: "shell",
	shell: "shell",
	console: "shell",
	ps1: "powershell",
	pwsh: "powershell",
	powershell: "powershell",
	js: "javascript",
	jsx: "javascript",
	mjs: "javascript",
	cjs: "javascript",
	javascript: "javascript",
	ts: "typescript",
	tsx: "typescript",
	mts: "typescript",
	cts: "typescript",
	typescript: "typescript",
	html: "html",
	htm: "html",
	css: "css",
	scss: "scss",
	less: "less",
	cs: "csharp",
	csharp: "csharp",
	"c#": "csharp",
	py: "python",
	python: "python",
	mermaid: "mermaid",
	mmd: "mermaid",
};

/** Normalizes a raw fence info-string token to a lowercase language hint. */
export function normalizeFenceLang(raw: string | null | undefined): string {
	const token = (raw ?? "").trim().split(/\s+/)[0]?.toLowerCase() ?? "";
	return token ? (CODE_LANGUAGE_ALIASES[token] ?? token) : "";
}

export type FenceOpen = {
	/** Leading blockquote prefix (`> ` / `> > `), empty for top-level or list-indented fences. */
	quotePrefix: string;
	/** The fence delimiter characters (e.g. ```` ``` ```` or `~~~`). */
	fence: string;
	fenceChar: "`" | "~";
	fenceLen: number;
	/** First token of the info string (the language name), trimmed, original case preserved for display. */
	lang: string;
};

/** Linearly scans leading blockquote markers (`>` with optional surrounding spaces/tabs), avoiding regex backtracking. */
export function scanQuotePrefix(line: string, maxDepth = Infinity): { prefix: string; depth: number; offset: number } {
	let i = 0;
	let depth = 0;
	while (depth < maxDepth && i < line.length) {
		let j = i;
		while (j < line.length && (line[j] === " " || line[j] === "\t")) j++;
		if (line[j] !== ">") break;
		j++;
		if (j < line.length && (line[j] === " " || line[j] === "\t")) j++;
		i = j;
		depth++;
	}
	return { prefix: line.slice(0, i), depth, offset: i };
}

const FENCE_OPEN_REST_RE = /^[ \t]*(`{3,}|~{3,})[ \t]*(\S*)/;

/** Parses an opening fenced code line (supporting top-level, list-indented, and blockquoted fences). */
export function parseFenceOpen(line: string): FenceOpen | null {
	const { prefix: quotePrefix, offset } = scanQuotePrefix(line);
	const rest = line.slice(offset);
	const match = FENCE_OPEN_REST_RE.exec(rest);
	if (!match) return null;
	const fence = match[1]!;
	const fenceChar = fence[0] as "`" | "~";
	const lang = match[2] ?? "";
	// Per CommonMark, a backtick fence's info string cannot contain backticks anywhere on the opening line.
	if (fenceChar === "`" && (lang.includes("`") || rest.slice(match[0].length).includes("`"))) return null;
	return {
		quotePrefix,
		fence,
		fenceChar,
		fenceLen: fence.length,
		lang,
	};
}

/**
 * True when `line` closes a fence opened with `fenceChar` of length `fenceLen`.
 * `quoted` may be an exact blockquote nesting depth (`number`) or a `boolean` for legacy callers.
 * Leading indentation after the container prefix is capped at 0..3 spaces per CommonMark.
 */
export function isFenceClose(
	line: string,
	fenceChar: "`" | "~",
	fenceLen: number,
	quoted: boolean | number,
	containerIndent = "",
): boolean {
	let rest = line;
	if (typeof quoted === "number") {
		if (quoted > 0) {
			const q = scanQuotePrefix(line, quoted);
			if (q.depth < quoted) return false;
			rest = line.slice(q.offset);
		}
	} else if (quoted) {
		const q = scanQuotePrefix(line);
		if (q.depth === 0) return false;
		rest = line.slice(q.offset);
	}
	if (containerIndent && rest.startsWith(containerIndent)) {
		rest = rest.slice(containerIndent.length);
	}
	let spaces = 0;
	while (spaces < rest.length && rest[spaces] === " ") spaces++;
	if (spaces > 3) return false;
	let i = spaces;
	while (i < rest.length && rest[i] === fenceChar) i++;
	if (i - spaces < fenceLen) return false;
	while (i < rest.length && (rest[i] === " " || rest[i] === "\t" || rest[i] === "\r")) i++;
	return i === rest.length;
}

/** Strips a leading blockquote prefix from a code line only when its enclosing fence is quoted. */
export function stripQuotePrefix(line: string, quoted: boolean | number): { text: string; offset: number } {
	if (!quoted) return { text: line, offset: 0 };
	const { offset } = typeof quoted === "number" ? scanQuotePrefix(line, quoted) : scanQuotePrefix(line);
	return { text: line.slice(offset), offset };
}

const VALID_MTK_CLASS = /^mtk(?:\d+|[bius])$/;
const SPAN_RE = /<span\b([^>]*)>([^<]*)<\/span>/g;
const CLASS_ATTR_RE = /\bclass="([^"]*)"/;
const ENTITY_RE = /&(?:lt|gt|amp|quot|apos|nbsp|#(\d+)|#x([0-9a-fA-F]+));/g;

/** Counts UTF-16 code units represented by an HTML-escaped Monaco token slice. */
function decodedUtf16Length(raw: string): number {
	if (!raw) return 0;
	if (!raw.includes("&")) return raw.length;
	let len = raw.length;
	ENTITY_RE.lastIndex = 0;
	let m: RegExpExecArray | null;
	while ((m = ENTITY_RE.exec(raw))) {
		let charLen = 1;
		if (m[1] !== undefined) {
			const cp = Number.parseInt(m[1], 10);
			if (Number.isFinite(cp) && cp > 0xffff && cp <= 0x10ffff) charLen = 2;
		} else if (m[2] !== undefined) {
			const cp = Number.parseInt(m[2], 16);
			if (Number.isFinite(cp) && cp > 0xffff && cp <= 0x10ffff) charLen = 2;
		}
		len -= m[0].length - charLen;
	}
	return len;
}

/**
 * Parses HTML returned by `monaco.editor.colorize(code, lang, { tabSize: 1 })`
 * into exact per-line UTF-16 column spans carrying Monaco `.mtk*` token classes.
 *
 * Passing `tabSize: 1` to Monaco ensures every `\t`, space, entity, and BMP/astral
 * character occupies its exact UTF-16 code-unit length in the rendered HTML.
 */
export function parseMonacoColorizedHtml(html: string, options?: { bomPrefix?: boolean }): CodeTokenSpan[][] {
	if (!html) return [];
	const rawLines = html.split(/<br\s*\/?>/i);
	if (rawLines.length > 0 && rawLines[rawLines.length - 1] === "") rawLines.pop();

	const out: CodeTokenSpan[][] = [];
	for (let lineIdx = 0; lineIdx < rawLines.length; lineIdx++) {
		const rawLine = rawLines[lineIdx]!;
		const spans: CodeTokenSpan[] = [];
		let col = lineIdx === 0 && options?.bomPrefix ? 1 : 0;

		SPAN_RE.lastIndex = 0;
		let m: RegExpExecArray | null;
		while ((m = SPAN_RE.exec(rawLine))) {
			const attrs = m[1]!;
			const text = m[2]!;
			const len = decodedUtf16Length(text);
			if (len <= 0) continue;
			const clsMatch = CLASS_ATTR_RE.exec(attrs);
			const classes = clsMatch
				? clsMatch[1]!
						.trim()
						.split(/\s+/)
						.filter((c) => VALID_MTK_CLASS.test(c))
				: [];
			if (classes.length) {
				const className = classes.join(" ");
				const prev = spans[spans.length - 1];
				if (prev && prev.to === col && prev.className === className) {
					prev.to = col + len;
				} else {
					spans.push({ from: col, to: col + len, className });
				}
			}
			col += len;
		}
		out.push(spans);
	}
	return out;
}
