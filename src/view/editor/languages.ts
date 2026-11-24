// The languages of a project's documents and companion STARLIMS files:
// Markdown, SQL, YAML, XML/XFD/config, INI, JavaScript, TypeScript, HTML,
// CSS/SCSS/Less, C#, PowerShell, Shell, Python from the editor's own grammars,
// and JSON, TOML and CSV from the small ones here. None of this is SSL: that
// comes from the language server and the formatter's grammar (ADR 0003).
// Non-SSL formatting runs through the backend's Prettier + XML + sql-formatter
// pipeline (ADR 0015, ADR 0029).
import { canFormatNonSsl, DEFAULT_SQL_DIALECT, FORMATTABLE_NON_SSL_LANGUAGES, type SqlDialect, type SqlKeywordCase } from "../../shared/format";
import {
	fenceAtLine,
	fenceFormatTarget,
	findMarkdownCodeFences,
	formatFenceBodyForMarkdown,
	replaceFencesInMarkdown,
	virtualFencePath,
	type MarkdownCodeFence,
} from "../../shared/fencedFormat";
import { formatJson } from "../../shared/jsonFormat";
import { LANGUAGES, languageFor, languageName, type LanguageDef } from "../../shared/languages";
import { backend } from "../backend";
import { monaco } from "./monaco";
import "monaco-editor/languages/definitions/markdown/register";
import "monaco-editor/languages/definitions/sql/register";
import "monaco-editor/languages/definitions/yaml/register";
import "monaco-editor/languages/definitions/xml/register";
import "monaco-editor/languages/definitions/ini/register";
// Common STARLIMS companion & fenced-code languages (lazy-loaded on first use by Monaco).
import "monaco-editor/languages/definitions/shell/register";
import "monaco-editor/languages/definitions/powershell/register";
import "monaco-editor/languages/definitions/bat/register";
import "monaco-editor/languages/definitions/javascript/register";
import "monaco-editor/languages/definitions/typescript/register";
import "monaco-editor/languages/definitions/html/register";
import "monaco-editor/languages/definitions/css/register";
import "monaco-editor/languages/definitions/scss/register";
import "monaco-editor/languages/definitions/less/register";
import "monaco-editor/languages/definitions/csharp/register";
import "monaco-editor/languages/definitions/vb/register";
import "monaco-editor/languages/definitions/razor/register";
import "monaco-editor/languages/definitions/pgsql/register";
import "monaco-editor/languages/definitions/mysql/register";
import "monaco-editor/languages/definitions/python/register";
import "monaco-editor/languages/definitions/java/register";
import "monaco-editor/languages/definitions/cpp/register";
import "monaco-editor/languages/definitions/php/register";
import "monaco-editor/languages/definitions/dockerfile/register";
import "monaco-editor/languages/definitions/graphql/register";
import "monaco-editor/languages/definitions/r/register";
import "monaco-editor/languages/definitions/perl/register";
import "monaco-editor/languages/definitions/ruby/register";
import "monaco-editor/languages/definitions/go/register";
import "monaco-editor/languages/definitions/rust/register";
import "monaco-editor/languages/definitions/fsharp/register";

export { LANGUAGES, languageFor, languageName, type LanguageDef };

const BRACKETS: monaco.languages.LanguageConfiguration = {
	brackets: [
		["{", "}"],
		["[", "]"],
	],
	autoClosingPairs: [
		{ open: "{", close: "}" },
		{ open: "[", close: "]" },
		{ open: '"', close: '"', notIn: ["string"] },
	],
	surroundingPairs: [
		{ open: "{", close: "}" },
		{ open: "[", close: "]" },
		{ open: '"', close: '"' },
	],
};

/** JSON, and JSON with comments: a name before a colon is a key, and is told apart from a string that is a value. */
const JSON_GRAMMAR: monaco.languages.IMonarchLanguage = {
	tokenPostfix: ".json",
	tokenizer: {
		root: [
			[/\s+/, "white"],
			[/\/\/.*$/, "comment"],
			[/\/\*/, "comment", "@comment"],
			[/"(?:[^"\\]|\\.)*"(?=\s*:)/, "key"],
			[/"/, "string", "@string"],
			[/-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/, "number"],
			[/\b(?:true|false|null)\b/, "constant"],
			[/[{}[\]]/, "@brackets"],
			[/[,:]/, "delimiter"],
		],
		string: [
			[/[^\\"]+/, "string"],
			[/\\./, "string.escape"],
			[/"/, "string", "@pop"],
		],
		comment: [
			[/[^*/]+/, "comment"],
			[/\*\//, "comment", "@pop"],
			[/[*/]/, "comment"],
		],
	},
};

const BARE_KEY = /(?:[A-Za-z0-9_-]+|"[^"\n]*"|'[^'\n]*')/.source;

/** TOML: a table's heading, a key before its equals sign, and the kinds of value. */
const TOML_GRAMMAR: monaco.languages.IMonarchLanguage = {
	tokenPostfix: ".toml",
	tokenizer: {
		root: [
			[/\s+/, "white"],
			[/#.*$/, "comment"],
			[/^\s*\[\[[^\]\n]*\]\]/, "metatag"],
			[/^\s*\[[^\]\n]*\]/, "metatag"],
			[new RegExp(`${BARE_KEY}(?:\\s*\\.\\s*${BARE_KEY})*(?=\\s*=)`), "key"],
			[/"""/, "string", "@longBasic"],
			[/'''/, "string", "@longLiteral"],
			[/"/, "string", "@basic"],
			[/'[^'\n]*'/, "string"],
			[/\d{4}-\d{2}-\d{2}(?:[Tt ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:[Zz]|[+-]\d{2}:\d{2})?)?/, "number.date"],
			[/\d{2}:\d{2}:\d{2}(?:\.\d+)?/, "number.date"],
			[/[+-]?(?:0x[0-9A-Fa-f_]+|0o[0-7_]+|0b[01_]+|\d[\d_]*(?:\.\d[\d_]*)?(?:[eE][+-]?\d+)?|inf|nan)\b/, "number"],
			[/\b(?:true|false)\b/, "constant"],
			[/[{}[\]]/, "@brackets"],
			[/[=,.]/, "delimiter"],
		],
		basic: [
			[/[^\\"]+/, "string"],
			[/\\./, "string.escape"],
			[/"/, "string", "@pop"],
		],
		longBasic: [
			[/"""/, "string", "@pop"],
			[/\\./, "string.escape"],
			[/[^\\"]+|"/, "string"],
		],
		longLiteral: [
			[/'''/, "string", "@pop"],
			[/[^']+|'/, "string"],
		],
	},
};

/** How many colours the columns of a table of values take turns in. */
const CSV_COLOURS = 6;

/** CSV: each column in its own colour, taking turns, so that a value can be followed down its column. */
const CSV_GRAMMAR: monaco.languages.IMonarchLanguage = {
	tokenPostfix: ".csv",
	tokenizer: Object.fromEntries(
		Array.from({ length: CSV_COLOURS }, (_, column) => [
			column ? `c${column}` : "root",
			[
				// What ends the line gives the turn back to the first column. A rule that matches nothing at a
				// line's end is never tried, so each of these takes the line's last cell, or its last separator.
				[/"(?:[^"]|"")*"?$/, { token: `column${column}`, switchTo: "@root" }],
				[/[^,\t"]+$/, { token: `column${column}`, switchTo: "@root" }],
				[/[,\t]$/, { token: "delimiter", switchTo: "@root" }],
				[/"(?:[^"]|"")*"?/, `column${column}`],
				[/[^,\t"]+/, `column${column}`],
				// The next column.
				[/[,\t]/, { token: "delimiter", switchTo: column + 1 < CSV_COLOURS ? `@c${column + 1}` : "@root" }],
			] as monaco.languages.IMonarchLanguageRule[],
		]),
	),
};

for (const [id, grammar, configuration] of [
	["json", JSON_GRAMMAR, { ...BRACKETS, comments: { lineComment: "//", blockComment: ["/*", "*/"] } }],
	["toml", TOML_GRAMMAR, { ...BRACKETS, comments: { lineComment: "#" } }],
	["csv", CSV_GRAMMAR, {}],
] as const) {
	monaco.languages.register({ id });
	monaco.languages.setMonarchTokensProvider(id, grammar);
	monaco.languages.setLanguageConfiguration(id, configuration as monaco.languages.LanguageConfiguration);
}

/** What each grammar puts after its tokens' names: "string.sql", "key.toml". */
export const DOCUMENT_POSTFIXES: readonly string[] = [
	"md",
	"sql",
	"yaml",
	"xml",
	"ini",
	"json",
	"toml",
	"csv",
	"shell",
	"ps1",
	"bat",
	"js",
	"ts",
	"html",
	"css",
	"scss",
	"less",
	"cs",
	"vb",
	"python",
	"java",
	"cpp",
	"dockerfile",
	"gql",
	"r",
	"perl",
	"ruby",
	"go",
	"rust",
	"fs",
];

/**
 * What each kind of token in those grammars is to a theme: the TextMate scope
 * whose colour it takes. A theme written for VS Code colours these documents
 * as it colours SSL, through the same matching (see `applyTokenTheme`). A
 * longer name wins over a shorter one: "keyword.md" is a heading, "keyword" a
 * keyword.
 */
export const DOCUMENT_SCOPES: Readonly<Record<string, string>> = {
	comment: "comment",
	string: "string",
	"string.escape": "constant.character.escape",
	"string.link": "markup.underline.link",
	"string.target": "markup.underline.link",
	regexp: "string.regexp",
	keyword: "keyword.control",
	"keyword.md": "markup.heading",
	"keyword.table": "punctuation.definition.table",
	number: "constant.numeric",
	constant: "constant.language",
	constants: "constant.language",
	true: "constant.language",
	false: "constant.language",
	null: "constant.language",
	predefined: "support.function",
	operator: "keyword.operator",
	operators: "keyword.operator",
	type: "entity.name.type",
	"type.yaml": "entity.name.tag",
	tag: "entity.name.tag",
	metatag: "entity.name.section",
	namespace: "entity.name.type",
	key: "support.type.property-name",
	"attribute.name": "entity.other.attribute-name",
	"attribute.value": "string",
	"attribute.value.number": "constant.numeric",
	"attribute.value.hex": "constant.numeric",
	"attribute.value.unit": "keyword.operator",
	variable: "variable.other.property",
	"variable.md": "markup.inline.raw",
	"variable.source": "markup.inline.raw",
	strong: "markup.bold",
	emphasis: "markup.italic",
	invalid: "invalid",
	"meta.separator": "comment",
	// The columns of a table of values, in turn.
	column0: "entity.name.function",
	column1: "string",
	column2: "support.function",
	column3: "constant.numeric",
	column4: "variable.parameter",
	column5: "support.function.method",
};

type FormattingOptions = {
	printWidth?: number;
	sqlDialect?: SqlDialect;
	sqlKeywordCase?: SqlKeywordCase;
};

type FormattingHost = {
	options(): FormattingOptions;
	formatSsl(code: string): Promise<{ ok: true; text: string } | { ok: false; error: string; lspOffline?: boolean }>;
	onError(error: string, path: string): void;
	onNotice?(message: string): void;
};

let formattingHost: FormattingHost = {
	options: () => ({ sqlDialect: DEFAULT_SQL_DIALECT, sqlKeywordCase: "upper" }),
	formatSsl: async () => ({ ok: false, error: "The language server is not running; restart it to format SSL code.", lspOffline: true }),
	onError: () => {},
};

let lastFormatError: { uri: string; at: number } | null = null;

export function setFormattingHost(host: FormattingHost) {
	formattingHost = host;
}

export function hadRecentFormatError(model: monaco.editor.ITextModel, withinMs = 2000): boolean {
	return Boolean(lastFormatError && lastFormatError.uri === model.uri.toString() && Date.now() - lastFormatError.at <= withinMs);
}

/** Formats a single fenced code block's body (SSL via starlims-lsp; SQL/JS/TS/XML/JSON/HTML/CSS/YAML via backend). */
export async function formatCodeFence(
	fence: MarkdownCodeFence,
	markdownPath: string,
	eol: string,
): Promise<{ ok: true; body: string; changed: boolean } | { ok: false; error: string; lspOffline?: boolean }> {
	const target = fenceFormatTarget(fence.rawLang);
	if (!target) {
		return { ok: false, error: `No formatter is configured for \`${fence.rawLang || "plain"}\` code blocks.` };
	}
	if (!fence.code.trim() || fence.bodyStartLine > fence.bodyEndLine) {
		return { ok: true, body: "", changed: false };
	}
	const currentBody = formatFenceBodyForMarkdown(fence.code, fence.linePrefix, eol);

	if (target.languageId === "ssl") {
		const res = await formattingHost.formatSsl(fence.code);
		if (!res.ok) return res;
		const nextBody = formatFenceBodyForMarkdown(res.text, fence.linePrefix, eol);
		return { ok: true, body: nextBody, changed: nextBody !== currentBody };
	}

	const extra = formattingHost.options();
	try {
		const res = await backend.formatDocument({
			path: virtualFencePath(markdownPath, { rawLang: fence.rawLang, languageId: target.languageId }),
			text: fence.code,
			languageId: target.languageId,
			tabSize: target.languageId === "sql" ? 4 : 2,
			insertSpaces: true,
			printWidth: extra.printWidth,
			sqlDialect: target.sqlDialectOverride ?? extra.sqlDialect,
			sqlKeywordCase: extra.sqlKeywordCase,
		});
		if (!res.ok) return { ok: false, error: res.error };
		const nextBody = formatFenceBodyForMarkdown(res.text, fence.linePrefix, eol);
		return { ok: true, body: nextBody, changed: nextBody !== currentBody };
	} catch (err: any) {
		return { ok: false, error: String(err?.message ?? err) };
	}
}

/** Formats every formattable fenced code block inside a Markdown text, leaving broken blocks intact (ADR 0002). */
async function formatAllMarkdownFences(
	markdownText: string,
	markdownPath: string,
): Promise<{ text: string; skippedErrors: string[]; skippedSslOffline: number }> {
	const eol = markdownText.includes("\r\n") ? "\r\n" : "\n";
	const fences = findMarkdownCodeFences(markdownText);
	const replacements = new Map<number, string>();
	const skippedErrors: string[] = [];
	let skippedSslOffline = 0;

	for (const fence of fences) {
		if (!fenceFormatTarget(fence.rawLang)) continue;
		if (!fence.code.trim() || fence.bodyStartLine > fence.bodyEndLine) continue;
		const res = await formatCodeFence(fence, markdownPath, eol);
		if (res.ok) {
			if (res.changed) replacements.set(fence.openLine, res.body);
		} else if (res.lspOffline) {
			skippedSslOffline++;
		} else {
			skippedErrors.push(`${fence.rawLang || fence.languageId} block at line ${fence.openLine} (${res.error})`);
		}
	}

	if (!replacements.size) return { text: markdownText, skippedErrors, skippedSslOffline };
	return {
		text: replaceFencesInMarkdown(markdownText, fences, replacements),
		skippedErrors,
		skippedSslOffline,
	};
}

/** Formats the single fenced code block at 1-based `lineNumber` inside a Markdown Monaco model. */
export async function formatFenceInModel(
	model: monaco.editor.ITextModel,
	lineNumber: number,
): Promise<"changed" | "unchanged" | "error" | "none"> {
	const path = model.uri.fsPath || model.uri.path;
	const text = model.getValue();
	const fence = fenceAtLine(text, lineNumber);
	if (!fence) return "none";
	if (!fenceFormatTarget(fence.rawLang)) {
		formattingHost.onError(`No formatter is configured for \`${fence.rawLang || "untagged"}\` code blocks.`, path);
		return "error";
	}
	if (fence.bodyStartLine > fence.bodyEndLine || !fence.code.trim()) return "unchanged";
	const eol = model.getEOL();
	const res = await formatCodeFence(fence, path, eol);
	if (!res.ok) {
		lastFormatError = { uri: model.uri.toString(), at: Date.now() };
		formattingHost.onError(res.error, path);
		return "error";
	}
	if (!res.changed) return "unchanged";
	const endCol = model.getLineMaxColumn(fence.bodyEndLine);
	const range = new monaco.Range(fence.bodyStartLine, 1, fence.bodyEndLine, endCol);
	model.pushStackElement();
	model.pushEditOperations([], [{ range, text: res.body }], () => null);
	model.pushStackElement();
	return "changed";
}

async function computeNonSslFormat(
	model: monaco.editor.ITextModel,
	indent: { tabSize: number; insertSpaces: boolean },
): Promise<{ ok: true; text: string; changed: boolean } | { ok: false }> {
	const languageId = model.getLanguageId();
	const path = model.uri.fsPath || model.uri.path;
	if (!canFormatNonSsl(languageId, path)) return { ok: true, text: model.getValue(), changed: false };
	const text = model.getValue();
	const extra = formattingHost.options();
	try {
		const result = await backend.formatDocument({
			path,
			text,
			languageId,
			tabSize: indent.tabSize,
			insertSpaces: indent.insertSpaces,
			printWidth: extra.printWidth,
			sqlDialect: extra.sqlDialect,
			sqlKeywordCase: extra.sqlKeywordCase,
		});
		if (!result.ok) {
			lastFormatError = { uri: model.uri.toString(), at: Date.now() };
			formattingHost.onError(result.error, path);
			return { ok: false };
		}
		let finalText = result.text;
		if (languageId === "markdown") {
			const embedded = await formatAllMarkdownFences(finalText, path);
			finalText = embedded.text;
			if (embedded.skippedErrors.length) {
				formattingHost.onError(`Skipped unformattable code block: ${embedded.skippedErrors[0]}`, path);
			} else if (embedded.skippedSslOffline > 0) {
				formattingHost.onNotice?.(
					`Skipped ${embedded.skippedSslOffline} SSL code ${embedded.skippedSslOffline === 1 ? "block" : "blocks"} because the language server is not running.`,
				);
			}
		}
		return { ok: true, text: finalText, changed: finalText !== text };
	} catch (err: any) {
		// If the backend is unreachable for plain JSON, keep the local zero-dependency JSON formatter working.
		if (languageId === "json" && !/\.jsonc$/i.test(path) && !/\.plan\.json$/i.test(path)) {
			const fallback = formatJson(text, indent.insertSpaces ? " ".repeat(indent.tabSize) : "\t");
			if (fallback !== null) return { ok: true, text: fallback, changed: fallback !== text };
		}
		lastFormatError = { uri: model.uri.toString(), at: Date.now() };
		formattingHost.onError(String(err?.message ?? err), path);
		return { ok: false };
	}
}

/** Formats a non-SSL model directly (used for Markdown Live mode where Monaco is hidden). */
export async function formatNonSslModel(model: monaco.editor.ITextModel): Promise<"changed" | "unchanged" | "error"> {
	const opts = model.getOptions();
	const res = await computeNonSslFormat(model, { tabSize: opts.tabSize, insertSpaces: opts.insertSpaces });
	if (!res.ok) return "error";
	if (!res.changed) return "unchanged";
	model.pushStackElement();
	model.pushEditOperations([], [{ range: model.getFullModelRange(), text: res.text }], () => null);
	model.pushStackElement();
	return "changed";
}

// "Format document" for non-SSL companion files via the backend Prettier + XML + sql-formatter
// pipeline (ADR 0015, ADR 0029). SSL stays owned exclusively by starlims-lsp (ADR 0003), and
// .plan.json keeps its own deterministic line-per-node layout.
for (const languageId of FORMATTABLE_NON_SSL_LANGUAGES) {
	monaco.languages.registerDocumentFormattingEditProvider(languageId, {
		async provideDocumentFormattingEdits(model, options) {
			const res = await computeNonSslFormat(model, options);
			if (!res.ok || !res.changed) return [];
			return [{ range: model.getFullModelRange(), text: res.text }];
		},
	});
}

// Secondary schema-table hover provider bridging SSL/SQL identifiers to `schema/` Markdown & DDL docs (ADR 0003).
void import("./schemaHover").then((m) => m.registerSchemaHoverProviders());

