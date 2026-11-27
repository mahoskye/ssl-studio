// Multi-language formatter for non-SSL project files, running in the Bun
// backend (ADR 0015, ADR 0029).
//
// Uses Prettier's standalone engine with statically imported plugins (including
// @prettier/plugin-xml for XML/XFD/XSD/XSL/config files) so single-file desktop
// bundling via Electrobun/bun build works without dynamic plugin loading, plus
// sql-formatter for standalone .sql files (T-SQL, Oracle PL/SQL, standard SQL,
// PostgreSQL, MySQL, SQLite).
//
// SSL (.ssl, .srvscr, .ds) is never formatted here: starlims-lsp owns SSL
// formatting exclusively (ADR 0003).

import { existsSync, readFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve, sep } from "node:path";
import * as prettier from "prettier/standalone";
import type { Options as PrettierOptions, Plugin } from "prettier";
import * as pluginBabel from "prettier/plugins/babel";
import * as pluginEstree from "prettier/plugins/estree";
import * as pluginHtml from "prettier/plugins/html";
import * as pluginMarkdown from "prettier/plugins/markdown";
import * as pluginPostcss from "prettier/plugins/postcss";
import * as pluginTypescript from "prettier/plugins/typescript";
import * as pluginYaml from "prettier/plugins/yaml";
import * as pluginXmlModule from "@prettier/plugin-xml";
import { format as formatSql, type KeywordCase, type SqlLanguage } from "sql-formatter";
import {
	DEFAULT_SQL_DIALECT,
	isSqlDialect,
	type FormatDocumentRequest,
	type FormatDocumentResult,
	type SqlDialect,
	type SqlKeywordCase,
	isSqlLanguage,
	sqlDialectFor,
	sqlDialectInfo,
	sqlTokenLost,
} from "../shared/format";
import { keepCodeBlockSpaces } from "../shared/fencedFormat";

const pluginXml: Plugin = ((pluginXmlModule as { default?: Plugin }).default ?? pluginXmlModule) as Plugin;

/** An indented code block of a Markdown document, as Prettier's own reader finds it: its first line, and its code. */
async function indentedCodeBlocks(text: string): Promise<{ line: number; code: string }[] | null> {
	const reader = (pluginMarkdown as unknown as { parsers?: Record<string, { parse(text: string, options: object): unknown }> }).parsers?.markdown;
	if (!reader) return null;
	try {
		const tree = (await reader.parse(text, { parser: "markdown" })) as { type?: string; value?: string; position?: { start: { line: number } }; children?: unknown[] };
		const lines = text.split(/\r?\n/);
		const found: { line: number; code: string }[] = [];
		const walk = (node: typeof tree) => {
			if (node.type === "code" && node.position && typeof node.value === "string") {
				const line = node.position.start.line - 1;
				// A fenced block opens with its fence; keepCodeBlockSpaces has those.
				if (!/^[\s>]*(```|~~~)/.test(lines[line] ?? "")) found.push({ line, code: node.value });
			}
			for (const child of node.children ?? []) walk(child as typeof tree);
		};
		walk(tree);
		return found;
	} catch {
		return null;
	}
}

/**
 * keepCodeBlockSpaces for indented code blocks (four spaces, no fence): the spaces at the end of their lines, which
 * Prettier's printer trims, are put back where the block came out the same but for them (ADR 0045).
 */
async function keepIndentedCodeSpaces(before: string, after: string): Promise<string> {
	const was = await indentedCodeBlocks(before);
	if (!was?.length) return after;
	const now = await indentedCodeBlocks(after);
	if (!now || now.length !== was.length) return after;
	const eol = after.includes("\r\n") ? "\r\n" : "\n";
	const lines = after.split(/\r?\n/);
	const trimEnd = (line: string) => line.replace(/[ \t]+$/, "");
	let changed = false;
	now.forEach((block, index) => {
		const old = was[index]!;
		if (old.code === block.code) return;
		const oldLines = old.code.split(/\r?\n/);
		const newLines = block.code.split(/\r?\n/);
		if (oldLines.length !== newLines.length || oldLines.some((line, i) => trimEnd(line) !== trimEnd(newLines[i]!))) return;
		// What stands before the code on a printed line: the block's indent, and a list's or a quote's before it.
		const first = newLines.findIndex(Boolean);
		const printedFirst = lines[block.line + Math.max(0, first)] ?? "";
		const lead = first >= 0 ? printedFirst.slice(0, printedFirst.length - newLines[first]!.length) : "    ";
		newLines.forEach((line, i) => {
			if (oldLines[i] === line) return;
			const at = block.line + i;
			const printed = lines[at] ?? "";
			lines[at] = (line ? printed.slice(0, printed.length - line.length) : lead) + oldLines[i];
			changed = true;
		});
	});
	return changed ? lines.join(eol) : after;
}

const PRETTIER_PLUGINS: Plugin[] = [
	pluginBabel as Plugin,
	pluginEstree as Plugin,
	pluginTypescript as Plugin,
	pluginHtml as Plugin,
	pluginPostcss as Plugin,
	pluginYaml as Plugin,
	pluginMarkdown as Plugin,
	pluginXml,
];

/** Safe Prettier configuration keys accepted from a workspace's .prettierrc / package.json. */
const PRETTIER_OPTION_KEYS = new Set([
	"printWidth",
	"tabWidth",
	"useTabs",
	"semi",
	"singleQuote",
	"quoteProps",
	"jsxSingleQuote",
	"trailingComma",
	"bracketSpacing",
	"bracketSameLine",
	"arrowParens",
	"proseWrap",
	"htmlWhitespaceSensitivity",
	"endOfLine",
	"singleAttributePerLine",
	"xmlWhitespaceSensitivity",
	"xmlSelfClosingSpace",
	"xmlQuoteAttributes",
	"xmlSortAttributesByKey",
]);

function pickPrettierOptions(raw: unknown): Record<string, unknown> {
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
	const out: Record<string, unknown> = {};
	for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
		if (!PRETTIER_OPTION_KEYS.has(k) || v === undefined) continue;
		if ((k === "tabWidth" || k === "printWidth") && (typeof v !== "number" || !Number.isFinite(v))) continue;
		out[k] = v;
	}
	return out;
}

/** Strips YAML `#` comments only when outside single or double quotes. */
function stripYamlComment(line: string): string {
	let quote: '"' | "'" | null = null;
	for (let i = 0; i < line.length; i++) {
		const ch = line[i]!;
		if (quote === '"') {
			if (ch === "\\" && i + 1 < line.length) {
				i++;
				continue;
			}
			if (ch === '"') quote = null;
		} else if (quote === "'") {
			if (ch === "'" && line[i + 1] === "'") {
				i++;
				continue;
			}
			if (ch === "'") quote = null;
		} else {
			if (ch === '"' || ch === "'") quote = ch;
			else if (ch === "#") return line.slice(0, i);
		}
	}
	return line;
}

/**
 * Parses a JSON (or simple flat key: value YAML) .prettierrc file without executing JS.
 */
function parseRcText(text: string): Record<string, unknown> | null {
	const cleaned = text.startsWith("\uFEFF") ? text.slice(1) : text;
	const trimmed = cleaned.trim();
	if (!trimmed) return {};
	try {
		return pickPrettierOptions(JSON.parse(trimmed));
	} catch {
		// Fall through to simple top-level key: value YAML parsing (covers typical .prettierrc YAML files).
	}
	const out: Record<string, unknown> = {};
	for (const rawLine of cleaned.split(/\r?\n/)) {
		// Skip indented lines so YAML `overrides:` blocks never overwrite top-level options.
		if (/^[ \t]/.test(rawLine)) continue;
		const line = stripYamlComment(rawLine).trim();
		if (!line) continue;
		const match = line.match(/^([A-Za-z][A-Za-z0-9_]*)\s*:\s*(.+)$/);
		if (!match) continue;
		const key = match[1]!;
		if (!PRETTIER_OPTION_KEYS.has(key)) continue;
		const val: string = match[2]!.trim();
		if (val.length >= 2 && ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'")))) {
			out[key] = val.slice(1, -1);
		} else if (val === "true") {
			out[key] = true;
		} else if (val === "false") {
			out[key] = false;
		} else if (/^\d+$/.test(val)) {
			out[key] = Number(val);
		} else {
			out[key] = val;
		}
	}
	return out;
}

const isWin = process.platform === "win32";
const foldPath = (p: string) => (isWin ? p.toLowerCase() : p);
const withSep = (p: string) => (p.endsWith(sep) || p.endsWith("/") || p.endsWith("\\") ? p : `${p}${sep}`);

/**
 * Walks up from `filePath` to `workspaceRoot` looking for static Prettier config
 * (.prettierrc, .prettierrc.json, .prettierrc.yml, .prettierrc.yaml, or package.json#prettier).
 * Never executes arbitrary JS configs from untrusted workspaces.
 */
export function loadProjectPrettierConfig(filePath: string, workspaceRoot?: string | null): Record<string, unknown> {
	if (!filePath || filePath.startsWith("untitled:") || !isAbsolute(filePath)) return {};
	const absFile = resolve(filePath);
	const root = workspaceRoot ? resolve(workspaceRoot) : null;
	const foldedFile = foldPath(absFile);
	const foldedRoot = root ? foldPath(root) : null;
	if (foldedRoot && foldedFile !== foldedRoot && !foldedFile.startsWith(withSep(foldedRoot))) {
		return {};
	}
	let dir = foldedRoot && foldedFile === foldedRoot ? absFile : dirname(absFile);
	for (let depth = 0; depth < 32; depth++) {
		for (const name of [".prettierrc.json", ".prettierrc", ".prettierrc.yml", ".prettierrc.yaml"]) {
			const candidate = join(dir, name);
			if (existsSync(candidate)) {
				try {
					const parsed = parseRcText(readFileSync(candidate, "utf8"));
					if (parsed) return parsed;
				} catch {
					// Ignore unreadable rc file and continue.
				}
			}
		}
		const pkgPath = join(dir, "package.json");
		if (existsSync(pkgPath)) {
			try {
				const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as { prettier?: unknown };
				if (pkg?.prettier && typeof pkg.prettier === "object") {
					return pickPrettierOptions(pkg.prettier);
				}
			} catch {
				// Ignore invalid package.json.
			}
		}
		if (foldedRoot && foldPath(dir) === foldedRoot) break;
		const parent = dirname(dir);
		if (parent === dir) break;
		dir = parent;
	}
	return {};
}

function normalizeKeywordCase(value: SqlKeywordCase | undefined): KeywordCase {
	if (value === "lower" || value === "preserve" || value === "upper") return value;
	return "upper";
}

function prettierParserFor(languageId: string, path: string): string | null {
	switch (languageId) {
		case "javascript":
			return "babel";
		case "typescript":
			return "typescript";
		case "html":
			return "html";
		case "css":
			return "css";
		case "scss":
			return "scss";
		case "less":
			return "less";
		case "xml":
			return "xml";
		case "json":
			return /\.jsonc$/i.test(path) ? "jsonc" : "json";
		case "yaml":
			return "yaml";
		case "markdown":
			return "markdown";
		default:
			return null;
	}
}

function conciseError(err: unknown): string {
	const raw = err instanceof Error ? err.message : String(err);
	const firstLine = raw
		.split(/\r?\n/)
		.map((l) => l.trim())
		.find((l) => l.length > 0);
	return firstLine ?? "Could not format this document.";
}

/**
 * Fast XML tag-balance guard run before `@prettier/plugin-xml`, which otherwise silently
 * drops or rewrites mismatched closing tags on malformed XML.
 */
function checkXmlTagBalance(text: string): string | null {
	const stack: string[] = [];
	const len = text.length;
	let i = 0;
	while (i < len) {
		const lt = text.indexOf("<", i);
		if (lt < 0) break;
		i = lt;
		if (text.startsWith("<!--", i)) {
			const end = text.indexOf("-->", i + 4);
			if (end < 0) return "Unclosed XML comment.";
			i = end + 3;
			continue;
		}
		if (text.startsWith("<![CDATA[", i)) {
			const end = text.indexOf("]]>", i + 9);
			if (end < 0) return "Unclosed CDATA section.";
			i = end + 3;
			continue;
		}
		if (text.startsWith("<?", i)) {
			const end = text.indexOf("?>", i + 2);
			if (end < 0) return "Unclosed XML processing instruction.";
			i = end + 2;
			continue;
		}
		if (text.startsWith("<!", i)) {
			let j = i + 2;
			let quote: string | null = null;
			let bracketDepth = 0;
			let closed = false;
			while (j < len) {
				if (!quote && bracketDepth > 0 && text.startsWith("<!--", j)) {
					const cEnd = text.indexOf("-->", j + 4);
					if (cEnd < 0) return "Unclosed XML comment in declaration.";
					j = cEnd + 3;
					continue;
				}
				const ch = text[j]!;
				if (quote) {
					if (ch === quote) quote = null;
					j++;
					continue;
				}
				if (ch === '"' || ch === "'") {
					quote = ch;
				} else if (ch === "[") {
					bracketDepth++;
				} else if (ch === "]" && bracketDepth > 0) {
					bracketDepth--;
				} else if (ch === ">" && bracketDepth === 0) {
					j++;
					closed = true;
					break;
				}
				j++;
			}
			if (!closed) return "Unclosed XML declaration.";
			i = j;
			continue;
		}
		if (text.startsWith("</", i)) {
			let j = i + 2;
			while (j < len && !/[\s>]/.test(text[j]!)) j++;
			const name = text.slice(i + 2, j);
			while (j < len && /\s/.test(text[j]!)) j++;
			if (!name || text[j] !== ">") return `Malformed closing tag </${name}>.`;
			if (stack.length === 0) return `Unexpected closing tag </${name}> with no matching opening tag.`;
			const expected = stack.pop()!;
			if (expected !== name) return `Mismatched closing tag </${name}> (expected </${expected}>).`;
			i = j + 1;
			continue;
		}
		// Opening or self-closing tag: `<name ...>` / `<name .../>`
		let j = i + 1;
		while (j < len && !/[\s/>]/.test(text[j]!)) j++;
		const name = text.slice(i + 1, j);
		if (!name) return "Malformed XML opening tag.";
		let quote: string | null = null;
		let selfClosing = false;
		let closed = false;
		while (j < len) {
			const ch = text[j]!;
			if (quote) {
				if (ch === quote) quote = null;
				j++;
				continue;
			}
			if (ch === '"' || ch === "'") {
				quote = ch;
				j++;
				continue;
			}
			if (ch === "<") return `Unclosed tag <${name}>.`;
			if (ch === ">") {
				selfClosing = j > i + 1 && text[j - 1] === "/";
				j++;
				closed = true;
				break;
			}
			j++;
		}
		if (!closed || quote !== null) return `Unclosed tag <${name}>.`;
		if (!selfClosing) stack.push(name);
		i = j;
	}
	if (stack.length > 0) return `Unclosed XML tag <${stack[stack.length - 1]}>.`;
	return null;
}

/**
 * An element that holds no other element and whose text the XML printer does not take for text: spaces or tabs
 * alone (`<Text> </Text>`), or character references alone (`<Operator>&lt;</Operator>`), with or without space
 * about them. Told to keep text as it is, the printer still empties the first and sets the second on a line of its
 * own between two indents, and either is a change to what the element says. The open tag is matched whole, quoted
 * values and all, and the text must run up to the close tag of the same name: space between two elements is layout.
 */
const XML_QUIET_LEAF = /(<([^\s<>\/!?=]+)(?:\s+[^\s=<>\/]+\s*=\s*(?:"[^"<]*"|'[^'<]*'))*\s*>)((?:[ \t\r\n]|&[^;<&\s]+;)+)(?=<\/\2\s*>)/g;

/** Characters no file is likely to hold: the first one this text does not hold marks the text of `XML_QUIET_LEAF`. */
const XML_MARKS = Array.from({ length: 16 }, (_, i) => String.fromCharCode(0xe000 + i));

/**
 * The text with a mark put before the text of each such element, for the printer to see text there and leave it
 * as it is; the mark is taken out of what it prints. An element with nothing in it but the break between its two
 * tags is left to the printer: that is layout, and it closes the element in one tag.
 */
function markXmlQuietLeaves(text: string): { text: string; mark: string | null } {
	const mark = XML_MARKS.find((ch) => !text.includes(ch));
	if (!mark) return { text, mark: null };
	const marked = text.replace(XML_QUIET_LEAF, (whole: string, open: string, _name: string, content: string) =>
		content.includes("&") || !/[\r\n]/.test(content) ? `${open}${mark}${content}` : whole,
	);
	return marked === text ? { text, mark: null } : { text: marked, mark };
}

export async function formatDocument(
	req: FormatDocumentRequest,
	workspaceRoot?: string | null,
): Promise<FormatDocumentResult> {
	const path = req.path ?? "";
	const languageId = req.languageId ?? "";
	const text = req.text ?? "";

	// ADR 0003 & ADR 0015: starlims-lsp owns SSL formatting exclusively. A data source is formatted here only as
	// SQL: the view sends the SQL of one it has read as an SQL data source, and nothing of its header (ADR 0038).
	const script = /\.(ssl|srvscr)(?:\.txt)?$/i.test(path);
	const dataSource = /\.ds(?:\.txt)?$/i.test(path);
	if (languageId === "ssl" || script || (dataSource && !isSqlLanguage(languageId))) {
		return { ok: false, error: "SSL files are formatted by starlims-lsp." };
	}

	// Plans (.plan.json) use their own deterministic line-per-node printer.
	if (/\.plan\.json$/i.test(path)) {
		return { ok: true, text, changed: false, formatter: "prettier" };
	}

	const eol = text.includes("\r\n") ? "\r\n" : "\n";
	const rawTabSize = typeof req.tabSize === "number" && Number.isFinite(req.tabSize) ? req.tabSize : 4;
	const tabWidth = Math.max(1, Math.min(16, Math.round(rawTabSize)));
	const useTabs = req.insertSpaces === false;
	const rawPrintWidth = typeof req.printWidth === "number" && Number.isFinite(req.printWidth) ? req.printWidth : 90;
	const printWidth = Math.max(40, Math.min(240, Math.round(rawPrintWidth)));

	if (languageId === "sql" || languageId === "pgsql" || languageId === "mysql") {
		if (!text.trim()) {
			return { ok: true, text, changed: false, formatter: "sql-formatter" };
		}
		const defaultDialect: SqlDialect =
			languageId === "pgsql" ? "postgresql" : languageId === "mysql" ? "mysql" : DEFAULT_SQL_DIALECT;
		const dialect = sqlDialectFor(path, isSqlDialect(req.sqlDialect) ? req.sqlDialect : defaultDialect);
		const language: SqlLanguage = dialect;
		const keywordCase = normalizeKeywordCase(req.sqlKeywordCase);
		const rc = loadProjectPrettierConfig(path, workspaceRoot);
		const rcTabWidth =
			typeof rc.tabWidth === "number" && Number.isFinite(rc.tabWidth)
				? Math.max(1, Math.min(16, Math.round(rc.tabWidth)))
				: tabWidth;
		const rcUseTabs = typeof rc.useTabs === "boolean" ? rc.useTabs : useTabs;
		try {
			const formattedBody = formatSql(text, {
				language,
				keywordCase,
				tabWidth: rcTabWidth,
				useTabs: rcUseTabs,
				linesBetweenQueries: 1,
				expressionWidth: Math.max(40, Math.min(printWidth, 60)),
			});
			const lost = sqlTokenLost(text, formattedBody);
			if (lost) {
				return {
					ok: false,
					error: `formatting it as ${sqlDialectInfo(dialect).label} would break up “${lost}”, so nothing was changed. If it is written for another database, choose that one under SQL dialect in Settings.`,
				};
			}
			const normalized = formattedBody.replace(/\r?\n/g, eol) + eol;
			return { ok: true, text: normalized, changed: normalized !== text, formatter: "sql-formatter" };
		} catch (err) {
			return { ok: false, error: conciseError(err) };
		}
	}

	const parser = prettierParserFor(languageId, path);
	if (!parser) {
		return { ok: false, error: `No formatter is configured for ${languageId || "this file"}.` };
	}

	if (!text.trim()) {
		return { ok: true, text, changed: false, formatter: "prettier" };
	}

	if (parser === "xml") {
		const xmlErr = checkXmlTagBalance(text);
		if (xmlErr) return { ok: false, error: xmlErr };
	}

	const rc = loadProjectPrettierConfig(path, workspaceRoot);
	const options: PrettierOptions & Record<string, unknown> = {
		parser,
		plugins: PRETTIER_PLUGINS,
		tabWidth,
		useTabs,
		printWidth,
		endOfLine: eol === "\r\n" ? "crlf" : "lf",
		...(parser === "jsonc" ? { trailingComma: "none" } : {}),
		...(parser === "markdown" ? { proseWrap: "preserve", embeddedLanguageFormatting: "off" } : {}),
		...(parser === "xml"
			? {
					// Formatting changes the layout, not what the file says. "ignore" was the setting here, and it
					// rewrote the text of elements: runs of spaces became one, the space at either end went, in a
					// form's captions and inside the string literals of its scripts. "preserve" prints text as it
					// is written and still indents elements that hold only elements. A project that wants the
					// printer's own way with text asks for it in its Prettier config, which is laid over this.
					xmlWhitespaceSensitivity: "preserve",
					xmlSelfClosingSpace: true,
					xmlQuoteAttributes: "preserve",
				}
			: {}),
		...rc,
	};

	try {
		// Preserve leading Templater metadata comment (`<!-- template: ... -->`) before YAML frontmatter
		// so Prettier still recognizes line 1 `---` as YAML frontmatter instead of corrupting it as Markdown.
		if (parser === "markdown") {
			const tplMatch = /^(\uFEFF?[ \t]*<!--\s*template\b[\s\S]*?-->[ \t]*(?:\r?\n[ \t]*)*\r?\n)(---[ \t]*\r?\n)/i.exec(text);
			if (tplMatch) {
				const header = tplMatch[1]!;
				const rest = text.slice(header.length);
				const formattedRest = await prettier.format(rest, options);
				const effectiveEol =
					options.endOfLine === "crlf" ? "\r\n" : options.endOfLine === "cr" ? "\r" : options.endOfLine === "lf" ? "\n" : eol;
				const cleanHeader = header.replace(/(?:\r?\n[ \t]*)+$/, "\n").replace(/\r?\n/g, effectiveEol);
				const formatted = await keepIndentedCodeSpaces(text, keepCodeBlockSpaces(text, `${cleanHeader}${formattedRest}`));
				return { ok: true, text: formatted, changed: formatted !== text, formatter: "prettier" };
			}
		}
		if (parser === "xml" && options.xmlWhitespaceSensitivity === "preserve") {
			const marked = markXmlQuietLeaves(text);
			const printed = await prettier.format(marked.text, options);
			const formatted = marked.mark ? printed.split(marked.mark).join("") : printed;
			return { ok: true, text: formatted, changed: formatted !== text, formatter: "prettier" };
		}
		const printed = await prettier.format(text, options);
		const formatted = parser === "markdown" ? await keepIndentedCodeSpaces(text, keepCodeBlockSpaces(text, printed)) : printed;
		return { ok: true, text: formatted, changed: formatted !== text, formatter: "prettier" };
	} catch (err) {
		return { ok: false, error: conciseError(err) };
	}
}
