// Shared types and helpers for formatting non-SSL companion files
// (SQL, JavaScript, TypeScript, HTML, CSS/SCSS/Less, XML/XFD/XSD/XSL/config,
// JSON/JSONC, YAML, Markdown). SSL files (.ssl, .srvscr, .ds) remain owned
// strictly by starlims-lsp (ADR 0003, ADR 0015, ADR 0029).

export const SQL_DIALECTS = [
	{ id: "tsql", short: "T-SQL", label: "SQL Server (T-SQL)" },
	{ id: "plsql", short: "PL/SQL", label: "Oracle (PL/SQL)" },
	{ id: "sql", short: "SQL", label: "Standard SQL" },
	{ id: "postgresql", short: "PostgreSQL", label: "PostgreSQL" },
	{ id: "mysql", short: "MySQL", label: "MySQL" },
	{ id: "sqlite", short: "SQLite", label: "SQLite" },
] as const;

export type SqlDialect = (typeof SQL_DIALECTS)[number]["id"];

export const DEFAULT_SQL_DIALECT: SqlDialect = "tsql";

export type SqlKeywordCase = "upper" | "lower" | "preserve";

export const FORMATTABLE_NON_SSL_LANGUAGES = new Set([
	"sql",
	"pgsql",
	"mysql",
	"javascript",
	"typescript",
	"html",
	"css",
	"scss",
	"less",
	"xml",
	"json",
	"yaml",
	"markdown",
]);

export function isSqlDialect(value: unknown): value is SqlDialect {
	return typeof value === "string" && SQL_DIALECTS.some((d) => d.id === value);
}

export function sqlDialectInfo(id: SqlDialect | undefined) {
	return SQL_DIALECTS.find((d) => d.id === id) ?? SQL_DIALECTS[0];
}

/** Whether the IDE's built-in non-SSL formatter handles this language/path. */
export function canFormatNonSsl(languageId: string | undefined, path?: string): boolean {
	if (!languageId || languageId === "ssl") return false;
	if (path && (/\.(ssl|srvscr|ds)$/i.test(path) || /\.plan\.json$/i.test(path))) return false;
	return FORMATTABLE_NON_SSL_LANGUAGES.has(languageId);
}

export type FormatDocumentRequest = {
	path: string;
	text: string;
	languageId: string;
	tabSize?: number;
	insertSpaces?: boolean;
	printWidth?: number;
	sqlDialect?: SqlDialect;
	sqlKeywordCase?: SqlKeywordCase;
};

export type FormatDocumentResult =
	| { ok: true; text: string; changed: boolean; formatter: "prettier" | "sql-formatter" }
	| { ok: false; error: string };
