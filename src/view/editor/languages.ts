// The languages of a project's documents: Markdown, SQL, YAML, XML and INI
// from the editor's own grammars, and JSON, TOML and CSV from the small ones
// here. None of this is SSL: that comes from the language server and the
// formatter's grammar (ADR 0003). These colour a file and pair its brackets,
// and nothing more.
import { formatJson } from "../../shared/jsonFormat";
import { monaco } from "./monaco";
import "monaco-editor/languages/definitions/markdown/register";
import "monaco-editor/languages/definitions/sql/register";
import "monaco-editor/languages/definitions/yaml/register";
import "monaco-editor/languages/definitions/xml/register";
import "monaco-editor/languages/definitions/ini/register";

type Language = { id: string; name: string; extensions: RegExp };

/** Each language a file can be in, with the name the status bar gives it. The first whose extensions match is the file's. */
export const LANGUAGES: readonly Language[] = [
	{ id: "ssl", name: "SSL", extensions: /\.(ssl|srvscr|ds)$/i },
	{ id: "markdown", name: "Markdown", extensions: /\.(md|markdown)$/i },
	{ id: "json", name: "JSON", extensions: /\.(json|jsonc)$/i },
	{ id: "toml", name: "TOML", extensions: /\.toml$/i },
	{ id: "sql", name: "SQL", extensions: /\.sql$/i },
	{ id: "csv", name: "CSV", extensions: /\.(csv|tsv)$/i },
	{ id: "yaml", name: "YAML", extensions: /\.(ya?ml)$/i },
	{ id: "xml", name: "XML", extensions: /\.(xml|xsd|xsl|xslt|config)$/i },
	{ id: "ini", name: "INI", extensions: /\.(ini|cfg|conf|properties)$/i },
];

export const languageFor = (path: string) => LANGUAGES.find((l) => l.extensions.test(path))?.id ?? "plaintext";
/** A language by the name a person would call it: "TOML", not "toml"; a file in none of them is plain text. */
export const languageName = (id: string | undefined) => LANGUAGES.find((l) => l.id === id)?.name ?? "Plain text";

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
export const DOCUMENT_POSTFIXES: readonly string[] = ["md", "sql", "yaml", "xml", "ini", "json", "toml", "csv"];

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
	keyword: "keyword.control",
	"keyword.md": "markup.heading",
	"keyword.table": "punctuation.definition.table",
	number: "constant.numeric",
	constant: "constant.language",
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
	variable: "variable.other.property",
	"variable.md": "markup.inline.raw",
	"variable.source": "markup.inline.raw",
	strong: "markup.bold",
	emphasis: "markup.italic",
	"meta.separator": "comment",
	// The columns of a table of values, in turn.
	column0: "entity.name.function",
	column1: "string",
	column2: "support.function",
	column3: "constant.numeric",
	column4: "variable.parameter",
	column5: "support.function.method",
};

// "Format document" for JSON: the layout only, every value written as it was (shared/jsonFormat.ts). A plan is laid out
// by its own printer, a row to a line, and is left alone here.
monaco.languages.registerDocumentFormattingEditProvider("json", {
	provideDocumentFormattingEdits(model, options) {
		if (/\.plan\.json$/i.test(model.uri.path)) return [];
		const formatted = formatJson(model.getValue(), options.insertSpaces ? " ".repeat(options.tabSize) : "\t");
		return formatted === null || formatted === model.getValue() ? [] : [{ range: model.getFullModelRange(), text: formatted }];
	},
});

// How a line is commented out in each kind of document: what Ctrl+/ writes. The grammars for these come with the
// editor; their comment marks are said here, so the key works whether or not the grammar has been asked for yet.
for (const [id, comments] of [
	["sql", { lineComment: "--", blockComment: ["/*", "*/"] }],
	["yaml", { lineComment: "#" }],
	["ini", { lineComment: ";" }],
	["xml", { blockComment: ["<!--", "-->"] }],
	["markdown", { blockComment: ["<!--", "-->"] }],
] as const) {
	monaco.languages.setLanguageConfiguration(id, { comments: comments as monaco.languages.CommentRule });
}

