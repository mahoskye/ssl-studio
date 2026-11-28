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

/**
 * A formatter's words about a piece of a file, with the lines it names counted in the whole file: the SQL of a
 * data source is formatted below its directives, and its "line 1" was the line under them.
 */
export const linesInFile = (said: string, linesAbove: number) => (linesAbove ? said.replace(/\bline (\d+)/g, (_, n: string) => `line ${Number(n) + linesAbove}`) : said);

/** Files that are Oracle's whatever dialect is chosen: package specs and bodies, and PL/SQL scripts. */
export const ORACLE_ONLY_FILE = /\.(pks|pkb|pls)$/i;

/** The dialect a SQL file is formatted in: the one chosen, except that an Oracle package is always Oracle's. */
export function sqlDialectFor(path: string, chosen: SqlDialect): SqlDialect {
	return ORACLE_ONLY_FILE.test(path) ? "plsql" : chosen;
}

/**
 * What a format of SQL must give back as it found it: an operator of two characters, and a name bound with a colon
 * (":nId"). A formatter that reads another dialect than the file's cuts them, and what it prints does something
 * else or nothing: T-SQL's reader made "v_due := SYSDATE" into "v_due: = SYSDATE" and "id = :nId" into
 * "id =: nId". Only spaces and the case of keywords are a formatter's to change, so neither can be fewer after it.
 * Null when every one is there still; else the first that is not, as written.
 */
export function sqlTokenLost(before: string, after: string): string | null {
	const count = (text: string, token: string) => text.split(token).length - 1;
	for (const token of [":=", "=>", "<>", "!=", "<=", ">=", "||", "::"]) if (count(after, token) < count(before, token)) return token;
	const binds = (text: string) => text.match(/:[A-Za-z_][A-Za-z0-9_$#]*/g) ?? [];
	const kept = new Map<string, number>();
	for (const bind of binds(after)) kept.set(bind, (kept.get(bind) ?? 0) + 1);
	for (const bind of binds(before)) {
		const left = kept.get(bind) ?? 0;
		if (!left) return bind;
		kept.set(bind, left - 1);
	}
	return null;
}

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

const SQL_LANGUAGE_IDS = new Set(["sql", "pgsql", "mysql"]);
/** Whether a language mode is one of SQL's. */
export const isSqlLanguage = (languageId: string | undefined): boolean => Boolean(languageId && SQL_LANGUAGE_IDS.has(languageId));

/** A data source by its name: `.ds`, or `.ds.txt`. It is SSL, or SQL, and its name does not say which. */
const DATA_SOURCE_NAME = /\.ds(?:\.txt)?$/i;

/**
 * Whether the IDE's built-in non-SSL formatter handles this language/path. A script is never its to format,
 * whatever mode it is shown in. A data source is, where it is shown as SQL: the IDE has read it as an SQL data
 * source (shared/sqlDataSource.ts), and formats its SQL and nothing above it.
 */
export function canFormatNonSsl(languageId: string | undefined, path?: string): boolean {
	if (!languageId || languageId === "ssl") return false;
	if (path && (/\.(ssl|srvscr)(?:\.txt)?$/i.test(path) || /\.plan\.json$/i.test(path))) return false;
	if (path && DATA_SOURCE_NAME.test(path)) return isSqlLanguage(languageId);
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
