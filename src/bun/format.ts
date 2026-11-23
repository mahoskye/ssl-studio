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
import { dirname, join, resolve } from "node:path";
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
	type SqlKeywordCase,
} from "../shared/format";

const pluginXml: Plugin = ((pluginXmlModule as { default?: Plugin }).default ?? pluginXmlModule) as Plugin;

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
		if (PRETTIER_OPTION_KEYS.has(k) && v !== undefined) out[k] = v;
	}
	return out;
}

/**
 * Parses a JSON (or simple flat key: value YAML) .prettierrc file without executing JS.
 */
function parseRcText(text: string): Record<string, unknown> | null {
	const trimmed = text.trim();
	if (!trimmed) return {};
	try {
		return pickPrettierOptions(JSON.parse(trimmed));
	} catch {
		// Fall through to simple key: value YAML parsing (covers typical .prettierrc YAML files).
	}
	const out: Record<string, unknown> = {};
	for (const rawLine of trimmed.split(/\r?\n/)) {
		const line = rawLine.replace(/#.*$/, "").trim();
		if (!line) continue;
		const match = line.match(/^([A-Za-z][A-Za-z0-9_]*)\s*:\s*(.+)$/);
		if (!match) continue;
		const key = match[1]!;
		if (!PRETTIER_OPTION_KEYS.has(key)) continue;
		let val: string = match[2]!.trim();
		if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
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

/**
 * Walks up from `filePath` to `workspaceRoot` looking for static Prettier config
 * (.prettierrc, .prettierrc.json, .prettierrc.yml, .prettierrc.yaml, or package.json#prettier).
 * Never executes arbitrary JS configs from untrusted workspaces.
 */
export function loadProjectPrettierConfig(filePath: string, workspaceRoot?: string | null): Record<string, unknown> {
	if (!filePath || filePath.startsWith("untitled:")) return {};
	const absFile = resolve(filePath);
	const root = workspaceRoot ? resolve(workspaceRoot) : null;
	if (root && absFile !== root && !absFile.startsWith(root + "/") && !absFile.startsWith(root + "\\")) {
		return {};
	}
	let dir = dirname(absFile);
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
		if (root && dir === root) break;
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

export async function formatDocument(
	req: FormatDocumentRequest,
	workspaceRoot?: string | null,
): Promise<FormatDocumentResult> {
	const path = req.path ?? "";
	const languageId = req.languageId ?? "";
	const text = req.text ?? "";

	// ADR 0003 & ADR 0015: starlims-lsp owns SSL formatting exclusively.
	if (languageId === "ssl" || /\.(ssl|srvscr|ds)$/i.test(path)) {
		return { ok: false, error: "SSL files are formatted by starlims-lsp." };
	}

	// Plans (.plan.json) use their own deterministic line-per-node printer.
	if (/\.plan\.json$/i.test(path)) {
		return { ok: true, text, changed: false, formatter: "prettier" };
	}

	const eol = text.includes("\r\n") ? "\r\n" : "\n";
	const tabWidth = Math.max(1, Math.min(16, Math.round(req.tabSize ?? 4)));
	const useTabs = req.insertSpaces === false;
	const printWidth = Math.max(40, Math.min(240, Math.round(req.printWidth ?? 90)));

	if (languageId === "sql") {
		if (!text.trim()) {
			return { ok: true, text, changed: false, formatter: "sql-formatter" };
		}
		const language: SqlLanguage = isSqlDialect(req.sqlDialect) ? req.sqlDialect : DEFAULT_SQL_DIALECT;
		const keywordCase = normalizeKeywordCase(req.sqlKeywordCase);
		const rc = loadProjectPrettierConfig(path, workspaceRoot);
		const rcTabWidth = typeof rc.tabWidth === "number" ? Math.max(1, Math.min(16, Math.round(rc.tabWidth))) : tabWidth;
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
					xmlWhitespaceSensitivity: "ignore",
					xmlSelfClosingSpace: true,
					xmlQuoteAttributes: "preserve",
				}
			: {}),
		...rc,
	};

	try {
		const formatted = await prettier.format(text, options);
		return { ok: true, text: formatted, changed: formatted !== text, formatter: "prettier" };
	} catch (err) {
		return { ok: false, error: conciseError(err) };
	}
}
