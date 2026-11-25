// Unified, pure SQL DDL inspection helpers for STARLIMS schema docs and
// `docs/registries/database.csv` reconciliation. Handles SQL Server (T-SQL / SSMS)
// and Oracle (PL/SQL / DBMS_METADATA) DDL cleanly without executing anything.

export type SqlObjectEntry = {
	/** Schema-qualified name when present (`dbo.FOLDERS`), else bare name (`FOLDERS`). */
	name: string;
	/** Bare object name without schema prefix (`FOLDERS`). */
	bareName: string;
	kind: "table" | "view" | "procedure" | "function" | "trigger" | "sequence" | "package" | "index" | "synonym" | "type";
	/** Whether the object was extracted from a `CREATE` or standalone `ALTER` statement. */
	action?: "create" | "alter";
};

export type SqlColumnDef = {
	name: string;
	type: string;
	constraints: string;
	/** Optional column comment from Oracle/ANSI `COMMENT ON COLUMN [schema.]tbl.col IS '...'`. */
	comment?: string;
};

export type SqlForeignKeyDef = {
	column: string;
	refTable: string;
	refColumn?: string;
	/** Local column list when this is a composite foreign key (`FOREIGN KEY (c1, c2)`). */
	columns?: string[];
	/** Referenced column list when this is a composite foreign key (`REFERENCES tbl (r1, r2)`). */
	refColumns?: string[];
	/** Optional `ON DELETE` referential action (e.g. `CASCADE`, `SET NULL`). */
	onDelete?: string;
};

export type SqlIndexDef = {
	name: string;
	columns: string[];
	unique?: boolean;
};

export type SqlTableDef = {
	tableName: string;
	columns: SqlColumnDef[];
	foreignKeys?: SqlForeignKeyDef[];
	indexes?: SqlIndexDef[];
};

export type ParsedSqlTable = SqlTableDef;

export type SqlSchemaDrift = {
	table: string;
	added: string[];
	modified: string[];
	dropped: string[];
};

/** Whether a character can stand in a bare name (see `IDENT_PART`). */
const isIdentChar = (ch: string | undefined) => Boolean(ch && /[\p{L}\p{M}\p{Nd}_$#]/u.test(ch));

/** Returns the closing delimiter for an Oracle Q-quoted string (`q'[...]'`, `q'(...)'`, `q'!...!'`). */
function oracleQCloseDelim(open: string): string {
	if (open === "[") return "]";
	if (open === "(") return ")";
	if (open === "{") return "}";
	if (open === "<") return ">";
	return open;
}

/** Detects an Oracle Q-quote opener (`[qQ]'<delim>`) at `pos` when not preceded by an identifier character. */
function matchOracleQQuote(src: string, pos: number): { closeDelim: string; bodyStart: number } | null {
	const ch = src[pos];
	if ((ch !== "q" && ch !== "Q") || src[pos + 1] !== "'" || pos + 2 >= src.length) return null;
	if (pos > 0) {
		const prev = src[pos - 1]!;
		const isNationalPrefix = (prev === "n" || prev === "N") && (pos < 2 || !isIdentChar(src[pos - 2]));
		if (isIdentChar(prev) && !isNationalPrefix) return null;
	}
	const delim = src[pos + 2]!;
	if (/\s/.test(delim)) return null;
	return { closeDelim: oracleQCloseDelim(delim), bodyStart: pos + 3 };
}

/** Detects a PostgreSQL dollar-quote opener (`$$` or `$tag$`) at `pos` when not preceded by an identifier character. */
function matchPgDollarTag(src: string, pos: number): string | null {
	if (src[pos] !== "$") return null;
	if (pos > 0 && isIdentChar(src[pos - 1])) return null;
	let j = pos + 1;
	while (j < src.length && /[A-Za-z0-9_]/.test(src[j]!)) j++;
	if (j < src.length && src[j] === "$") {
		return src.slice(pos, j + 1);
	}
	return null;
}

/**
 * Strips `--` line comments and nested `/* ... *\/` block comments while preserving SQL
 * single-quoted strings (`'-- keep --'`, `'it''s'`), Oracle Q-quoted strings (`q'[...]'`),
 * PostgreSQL dollar-quoted strings (`$$...$$`, `$tag$...$tag$`), and quoted/bracketed/backtick identifiers.
 * When `maskStrings` is true, replaces string literal contents with spaces (preserving `\n` and exact offsets)
 * so dynamic SQL like `EXEC('CREATE TABLE ...')` never triggers false object hits.
 */
function sanitizeSql(sql: string, maskStrings = false): string {
	let out = "";
	let i = 0;
	const n = sql.length;
	while (i < n) {
		const ch = sql[i]!;
		const next = sql[i + 1];
		// Oracle Q-quoted string literal (`q'[...]'`, `Q'!...!'`)
		const qOpen = matchOracleQQuote(sql, i);
		if (qOpen) {
			const { closeDelim, bodyStart } = qOpen;
			const closeSeq = `${closeDelim}'`;
			const closePos = sql.indexOf(closeSeq, bodyStart);
			const endPos = closePos >= 0 ? closePos + 2 : n;
			if (!maskStrings) {
				out += sql.slice(i, endPos);
			} else {
				// Preserve exact character offsets and newlines while neutralizing delimiters and contents.
				out += " ' ";
				const innerEnd = closePos >= 0 ? closePos : n;
				for (let k = bodyStart; k < innerEnd; k++) out += sql[k] === "\n" ? "\n" : " ";
				if (closePos >= 0) out += " '";
			}
			i = endPos;
			continue;
		}
		// PostgreSQL dollar-quoted string literal (`$$...$$`, `$tag$...$tag$`)
		const dollarTag = matchPgDollarTag(sql, i);
		if (dollarTag) {
			const bodyStart = i + dollarTag.length;
			const closePos = sql.indexOf(dollarTag, bodyStart);
			const endPos = closePos >= 0 ? closePos + dollarTag.length : n;
			if (!maskStrings) {
				out += sql.slice(i, endPos);
			} else {
				out += " ".repeat(dollarTag.length - 1) + "'";
				const innerEnd = closePos >= 0 ? closePos : n;
				for (let k = bodyStart; k < innerEnd; k++) out += sql[k] === "\n" ? "\n" : " ";
				if (closePos >= 0) out += "'" + " ".repeat(dollarTag.length - 1);
			}
			i = endPos;
			continue;
		}
		// Single-quoted string literal
		if (ch === "'") {
			out += ch;
			i++;
			while (i < n) {
				if (sql[i] === "'") {
					if (sql[i + 1] === "'") {
						out += maskStrings ? "  " : "''";
						i += 2;
						continue;
					}
					out += "'";
					i++;
					break;
				}
				out += maskStrings ? (sql[i] === "\n" ? "\n" : " ") : sql[i]!;
				i++;
			}
			continue;
		}
		// Double-quoted, backtick-quoted, or bracketed identifier (preserved verbatim)
		if (ch === '"' || ch === "[" || ch === "`") {
			const endCh = ch === "[" ? "]" : ch;
			out += ch;
			i++;
			while (i < n) {
				if (sql[i] === endCh) {
					out += sql[i++];
					if (i < n && sql[i] === endCh) {
						out += sql[i++];
						continue;
					}
					break;
				}
				out += sql[i++];
			}
			continue;
		}
		// Line comment `-- ...`
		if (ch === "-" && next === "-") {
			while (i < n && sql[i] !== "\n") i++;
			continue;
		}
		// Nested block comment `/* ... /* ... */ ... */`
		if (ch === "/" && next === "*") {
			let depth = 1;
			i += 2;
			while (i < n && depth > 0) {
				if (sql[i] === "/" && sql[i + 1] === "*") {
					depth++;
					i += 2;
					continue;
				}
				if (sql[i] === "*" && sql[i + 1] === "/") {
					depth--;
					i += 2;
					continue;
				}
				if (sql[i] === "\n") out += "\n";
				i++;
			}
			out += " ";
			continue;
		}
		out += ch;
		i++;
	}
	return out;
}

/** Replaces single-quoted, Oracle Q-quoted, and PG dollar-quoted string contents with spaces at identical offsets. */
function maskSingleQuoted(text: string): string {
	let out = "";
	let i = 0;
	const n = text.length;
	while (i < n) {
		const qOpen = matchOracleQQuote(text, i);
		if (qOpen) {
			const closePos = text.indexOf(`${qOpen.closeDelim}'`, qOpen.bodyStart);
			const endPos = closePos >= 0 ? closePos + 2 : n;
			out += " ' ";
			const innerEnd = closePos >= 0 ? closePos : n;
			for (let k = qOpen.bodyStart; k < innerEnd; k++) out += text[k] === "\n" ? "\n" : " ";
			if (closePos >= 0) out += " '";
			i = endPos;
			continue;
		}
		const dollarTag = matchPgDollarTag(text, i);
		if (dollarTag) {
			const bodyStart = i + dollarTag.length;
			const closePos = text.indexOf(dollarTag, bodyStart);
			const endPos = closePos >= 0 ? closePos + dollarTag.length : n;
			out += " ".repeat(dollarTag.length - 1) + "'";
			const innerEnd = closePos >= 0 ? closePos : n;
			for (let k = bodyStart; k < innerEnd; k++) out += text[k] === "\n" ? "\n" : " ";
			if (closePos >= 0) out += "'" + " ".repeat(dollarTag.length - 1);
			i = endPos;
			continue;
		}
		if (text[i] === "'") {
			out += "'";
			i++;
			while (i < n) {
				if (text[i] === "'") {
					if (text[i + 1] === "'") {
						out += "  ";
						i += 2;
						continue;
					}
					out += "'";
					i++;
					break;
				}
				out += text[i] === "\n" ? "\n" : " ";
				i++;
			}
			continue;
		}
		out += text[i++]!;
	}
	return out;
}

/** Masks single-quoted literals AND `CHECK (...)` expressions so constraint checks never match inside string defaults or CHECK clauses. */
function maskQuotedAndChecks(text: string): string {
	const masked = maskSingleQuoted(text);
	const chars = masked.split("");
	const checkRe = /\bCHECK\s*\(/gi;
	for (const m of masked.matchAll(checkRe)) {
		const start = m.index ?? 0;
		const openParen = start + m[0].length - 1;
		const scanned = scanBalancedParens(masked, openParen);
		const end = scanned ? scanned.end : masked.length;
		for (let k = start; k < end; k++) {
			if (chars[k] !== "\n") chars[k] = " ";
		}
	}
	return chars.join("");
}

/** Finds the start offset of the current SQL statement before `pos` on comment/string-masked SQL. */
function findStatementStart(maskedSql: string, pos: number): number {
	let i = pos - 1;
	while (i >= 0) {
		const ch = maskedSql[i]!;
		if (ch === ";") return i + 1;
		if (ch === "]" || ch === '"' || ch === "`") {
			const open = ch === "]" ? "[" : ch;
			i--;
			while (i >= 0 && maskedSql[i] !== open) i--;
			i--;
			continue;
		}
		if (ch === "\n") {
			const lineStart = maskedSql.lastIndexOf("\n", i - 1) + 1;
			if (/^[ \t]*GO[ \t]*\r?$/i.test(maskedSql.slice(lineStart, i))) {
				return i + 1;
			}
		}
		i--;
	}
	return 0;
}

const cleanIdent = (raw: string) => raw.trim().replace(/^[[`"]|[\]`"]$/g, "");

/**
 * One part of a name: in brackets, double quotes or backticks, or bare. A bare name is what SQL Server and Oracle
 * take without quotes: a letter or `_`, then letters, digits, `_`, `$` and `#`, where a letter is a letter of any
 * script and not one of the 26 alone. Read as those 26, `CREATE TABLE Prüfung (Größe INT)` ended its name at the
 * first letter outside them, and the table and its columns were left out without a word. `\p{L}` is a letter only
 * to a pattern with the `u` flag: every pattern built from this has it.
 *
 * Still not read bare: a name that starts with `#` or `@` (a temporary object, a variable: neither is schema), and
 * `@` inside a name, which SQL Server allows and Oracle reads as a table at a database link (`EMP@LINK`).
 */
const IDENT_PART = String.raw`(?:\[[^\]]+\]|"[^"]+"|` + "`[^`]+`" + String.raw`|[\p{L}_][\p{L}\p{M}\p{Nd}_$#]*)`;
const QUALIFIED_NAME = String.raw`(?:${IDENT_PART}\s*\.\s*){0,2}${IDENT_PART}`;

/** Formats 1-, 2-, or 3-part SQL names (`[db].[dbo].[My.Table]` -> `{ name: "dbo.My.Table", bareName: "My.Table" }`). */
function normalizeObjectName(raw: string): { name: string; bareName: string } {
	// Tokenize by IDENT_PART so dots inside bracketed/quoted names (`[dbo].[My.Special.Table]`) stay intact.
	const partRe = new RegExp(IDENT_PART, "gu");
	const parts = [...raw.matchAll(partRe)].map((m) => cleanIdent(m[0]!)).filter(Boolean);
	if (!parts.length) return { name: "", bareName: "" };
	const bareName = parts[parts.length - 1]!;
	// For 3-part names (`db.schema.object`), drop the database prefix so `dbo.object` stays portable across DEV/QA/PROD.
	const name = parts.length >= 2 ? `${parts[parts.length - 2]}.${bareName}` : bareName;
	return { name, bareName };
}

const bareTableKey = (raw: string): string => {
	const { bareName, name } = normalizeObjectName(raw);
	return (bareName || name || raw).trim().toLowerCase();
};

const fkLocalCols = (fk: SqlForeignKeyDef): string[] =>
	fk.columns?.length
		? fk.columns
		: fk.column
				.split(",")
				.map((c) => cleanIdent(c))
				.filter(Boolean);

const fkRefCols = (fk: SqlForeignKeyDef): string[] => {
	if (fk.refColumns?.length) return fk.refColumns;
	if (fk.refColumn) {
		return fk.refColumn
			.split(",")
			.map((c) => cleanIdent(c))
			.filter(Boolean);
	}
	return [];
};

/**
 * Extracts created (and optionally altered) database object names and kinds from
 * SQL Server (T-SQL) and Oracle (PL/SQL) DDL. Excludes indexes by default
 * (matching `database.csv` conventions), and preserves 2-part schema prefixes.
 */
export function extractSqlObjects(sql: string, options: { includeIndexes?: boolean; includeAlter?: boolean } = {}): SqlObjectEntry[] {
	const cleaned = sanitizeSql(sql, true);
	const out: SqlObjectEntry[] = [];
	const seen = new Set<string>();
	const modifiers =
		"(?:OR\\s+(?:REPLACE|ALTER)|UNIQUE|CLUSTERED|NONCLUSTERED|BITMAP|COLUMNSTORE|MATERIALIZED|GLOBAL\\s+TEMPORARY|PRIVATE\\s+TEMPORARY|LOCAL\\s+TEMPORARY|TEMPORARY|TEMP|UNLOGGED|FORCE|NOFORCE|EDITIONABLE|NONEDITIONABLE|PUBLIC|FULLTEXT|SPATIAL)";
	const kinds = "TABLE|VIEW|PROC(?:EDURE)?|FUNCTION|TRIGGER|SEQUENCE|PACKAGE(?:\\s+BODY)?|SYNONYM|TYPE|INDEX";
	const classifyKind = (rawKind: string): SqlObjectEntry["kind"] => {
		const u = rawKind.toUpperCase();
		if (u.startsWith("VIEW")) return "view";
		if (u.startsWith("PROC")) return "procedure";
		if (u.startsWith("FUNC")) return "function";
		if (u.startsWith("TRIG")) return "trigger";
		if (u.startsWith("SEQ")) return "sequence";
		if (u.startsWith("PACK")) return "package";
		if (u.startsWith("SYN")) return "synonym";
		if (u.startsWith("TYPE")) return "type";
		if (u.startsWith("INDEX")) return "index";
		return "table";
	};
	const addMatch = (rawKind: string, rawName: string, action: "create" | "alter", matchIndex: number) => {
		const stmtBefore = cleaned.slice(findStatementStart(cleaned, matchIndex), matchIndex).trimStart();
		if (/^(?:GRANT|REVOKE|DENY)\b/i.test(stmtBefore)) return;
		const kind = classifyKind(rawKind);
		if (kind === "index" && !options.includeIndexes) return;
		const { name, bareName } = normalizeObjectName(rawName);
		// Skip SQL Server local/global temp tables (`#Temp`, `##Temp`) declared inside procedures/scripts.
		if (!name || bareName.startsWith("#")) return;
		const key = `${kind}:${name.toLowerCase()}`;
		if (seen.has(key)) return;
		seen.add(key);
		out.push({ name, bareName, kind, ...(action === "alter" ? { action } : {}) });
	};

	const createRe = new RegExp(
		`\\bCREATE\\s+(?:${modifiers}\\s+)*(${kinds})\\s+(?:CONCURRENTLY\\s+)?(?:IF\\s+NOT\\s+EXISTS\\s+)?(${QUALIFIED_NAME})`,
		"giu",
	);
	for (const m of cleaned.matchAll(createRe)) addMatch(m[1]!, m[2]!, "create", m.index ?? 0);

	if (options.includeAlter) {
		const alterRe = new RegExp(`\\bALTER\\s+(?:${modifiers}\\s+)*(${kinds})\\s+(?:IF\\s+EXISTS\\s+)?(${QUALIFIED_NAME})`, "giu");
		for (const m of cleaned.matchAll(alterRe)) addMatch(m[1]!, m[2]!, "alter", m.index ?? 0);
	}
	return out;
}

/** Splits a parenthesized SQL column list on top-level commas (respecting nested parens, quotes, backticks, Q/dollar quotes, and `[bracketed]` identifiers). */
function splitTopLevelCommas(body: string): string[] {
	const parts: string[] = [];
	let cur = "";
	let depth = 0;
	let quote: string | null = null;
	let bracket = false;
	for (let i = 0; i < body.length; i++) {
		const ch = body[i]!;
		if (bracket) {
			cur += ch;
			if (ch === "]") {
				if (body[i + 1] === "]") cur += body[++i]!;
				else bracket = false;
			}
			continue;
		}
		if (quote) {
			cur += ch;
			if (ch === quote) {
				if (body[i + 1] === quote) {
					cur += body[++i]!;
				} else {
					quote = null;
				}
			}
			continue;
		}
		const qOpen = matchOracleQQuote(body, i);
		if (qOpen) {
			const closePos = body.indexOf(`${qOpen.closeDelim}'`, qOpen.bodyStart);
			const endPos = closePos >= 0 ? closePos + 2 : body.length;
			cur += body.slice(i, endPos);
			i = endPos - 1;
			continue;
		}
		const dollarTag = matchPgDollarTag(body, i);
		if (dollarTag) {
			const bodyStart = i + dollarTag.length;
			const closePos = body.indexOf(dollarTag, bodyStart);
			const endPos = closePos >= 0 ? closePos + dollarTag.length : body.length;
			cur += body.slice(i, endPos);
			i = endPos - 1;
			continue;
		}
		if (ch === "[") {
			bracket = true;
			cur += ch;
			continue;
		}
		if (ch === "'" || ch === '"' || ch === "`") {
			quote = ch;
			cur += ch;
			continue;
		}
		if (ch === "(") depth++;
		else if (ch === ")" && depth > 0) depth--;
		else if (ch === "," && depth === 0) {
			if (cur.trim()) parts.push(cur.trim());
			cur = "";
			continue;
		}
		cur += ch;
	}
	if (cur.trim()) parts.push(cur.trim());
	return parts;
}

const KNOWN_SQL_PARAM_TYPES = new Set([
	"varchar", "varchar2", "nvarchar", "nvarchar2", "char", "nchar", "character",
	"number", "numeric", "decimal", "dec", "float", "double", "real", "fixed",
	"int", "integer", "bigint", "smallint", "tinyint", "mediumint", "bit",
	"binary", "varbinary", "raw", "timestamp", "datetime", "datetime2", "datetimeoffset",
	"time", "interval", "year", "enum", "set", "vector", "string", "bytes", "bfile", "urowid",
]);

const COL_CONSTRAINT_START_RE =
	/^(?:(?:NOT\s+)?NULL|PRIMARY\s+KEY|UNIQUE|CHECK(?=\s*\()|DEFAULT|REFERENCES|CONSTRAINT|COLLATE|AUTOINCREMENT|IDENTITY|GENERATED)\b/i;

/** Parses one column definition line from a `CREATE TABLE` or `ALTER TABLE ADD` list. */
function parseColumnClause(rawClause: string): SqlColumnDef | null {
	const line = rawClause.replace(/\s+/g, " ").trim();
	if (!line) return null;
	// Skip table-level constraints, PostgreSQL EXCLUDE/LIKE clauses, and SQL Server temporal table PERIOD clauses.
	if (/^(?:CONSTRAINT|PRIMARY\s+KEY|FOREIGN\s+KEY|UNIQUE|CHECK|PERIOD\s+FOR\s+SYSTEM_TIME|EXCLUDE\s+USING|LIKE)\b/i.test(line)) {
		return null;
	}
	// Skip MySQL/SQL Server table-level index clauses (`INDEX [ix] (...)`, `INDEX ix NONCLUSTERED (...)`, `KEY (...)`)
	// while keeping real columns named `KEY VARCHAR(50)` / `KEY NUMBER(10,2)` / `INDEX VARCHAR(20)`.
	if (/^(?:(?:FULLTEXT|SPATIAL)\s+)?(?:INDEX|KEY)\s*\(/i.test(line)) return null;
	if (
		new RegExp(
			`^(?:(?:FULLTEXT|SPATIAL)\\s+)?(?:INDEX|KEY)\\s+(?:${IDENT_PART}\\s+)+(?:CLUSTERED|NONCLUSTERED|COLUMNSTORE|USING\\s+[A-Za-z_][\\w$]*|HASH|BTREE)\\b`,
			"iu",
		).test(line)
	) {
		return null;
	}
	const maybeTblIdx = new RegExp(`^(?:(?:FULLTEXT|SPATIAL)\\s+)?(?:INDEX|KEY)\\s+(${IDENT_PART})\\s*\\(([^)]*)\\)`, "iu").exec(line);
	if (maybeTblIdx) {
		const word = cleanIdent(maybeTblIdx[1]!).toLowerCase();
		const parenInner = maybeTblIdx[2]!.trim();
		const looksLikeTypeParam = /^(?:\d+(?:\s*,\s*\d+)?(?:\s+(?:CHAR|BYTE))?|MAX)$/i.test(parenInner);
		if (!KNOWN_SQL_PARAM_TYPES.has(word) && !looksLikeTypeParam) return null;
	}

	// Bare SQLite typeless column (`G`)
	const bareMatch = new RegExp(`^(${IDENT_PART})$`, "u").exec(line);
	if (bareMatch) {
		const bare = cleanIdent(bareMatch[1]!);
		if (!bare || COL_CONSTRAINT_START_RE.test(bare)) return null;
		return { name: bare, type: "", constraints: "" };
	}

	// Column name + remainder
	const nameMatch = new RegExp(`^(${IDENT_PART})\\s+([\\s\\S]+)$`, "u").exec(line);
	if (!nameMatch) return null;
	const colName = cleanIdent(nameMatch[1]!);
	if (!colName || (!/^[\["`]/.test(nameMatch[1]!) && /^(?:DEFAULT|ON|USING|WITH)$/i.test(colName))) return null;
	const rest = nameMatch[2]!.trim();

	// Computed column with balanced parens: `FULL_NAME AS (COALESCE(A, '') + B) PERSISTED`
	if (/^AS\s*\(/i.test(rest)) {
		const openPos = rest.indexOf("(");
		const scanned = scanBalancedParens(rest, openPos);
		if (scanned) {
			const expr = rest.slice(openPos, scanned.end);
			const tail = rest.slice(scanned.end).trim();
			return {
				name: colName,
				type: "COMPUTED",
				constraints: `AS ${expr}${tail ? ` ${tail}` : ""}`,
			};
		}
	}
	// Paren-less computed column: `TOTAL AS PRICE * QTY PERSISTED`
	if (/^AS\s+/i.test(rest)) {
		return { name: colName, type: "COMPUTED", constraints: rest };
	}
	// Typeless generated column: `TOTAL GENERATED ALWAYS AS (PRICE * QTY) VIRTUAL`
	if (/^GENERATED\s+(?:ALWAYS|BY\s+DEFAULT(?:\s+ON\s+NULL)?)\s+AS\b/i.test(rest)) {
		return { name: colName, type: "COMPUTED", constraints: rest };
	}

	// SQLite typeless column with constraints: `F NOT NULL`, `F PRIMARY KEY`, `F DEFAULT 0`
	if (COL_CONSTRAINT_START_RE.test(rest)) {
		return { name: colName, type: "", constraints: rest };
	}

	// ANSI/Oracle/PostgreSQL INTERVAL types (`INTERVAL YEAR TO MONTH`, `INTERVAL DAY(2) TO SECOND(6)`)
	const intervalMatch =
		/^(INTERVAL(?:\s+(?:YEAR|MONTH|DAY|HOUR|MINUTE|SECOND)(?:\s*\([^)]*\))?(?:\s+TO\s+(?:YEAR|MONTH|DAY|HOUR|MINUTE|SECOND)(?:\s*\([^)]*\))?)?|\s*\([^)]*\))?)(?=\s|$)([\s\S]*)$/i.exec(
			rest,
		);
	if (intervalMatch) {
		return {
			name: colName,
			type: intervalMatch[1]!.replace(/\s+/g, " ").trim(),
			constraints: intervalMatch[2]!.trim(),
		};
	}

	// Data type: handles SSMS bracketed types `[varchar](20)`, schema-qualified `[sys].[xml]`,
	// `NATIONAL CHARACTER VARYING(100)`, `CHARACTER VARYING(100)`, `DOUBLE PRECISION`, `LONG RAW`,
	// `TIMESTAMP(6) WITH LOCAL TIME ZONE`, Oracle `CHAR`/`BYTE` length semantics, MySQL `UNSIGNED`, and PG arrays `TEXT[]`.
	const typeRe = new RegExp(
		`^((?:NATIONAL\\s+)?(?:${IDENT_PART}\\s*\\.\\s*)?${IDENT_PART}(?:\\s+(?:CHARACTER|CHAR|VARCHAR|VARYING|PRECISION|RAW|OBJECT|INT|INTEGER)){0,2}(?:\\s*\\([^)]*\\))?(?:\\s+(?:WITH(?:OUT)?\\s+(?:LOCAL\\s+)?TIME\\s+ZONE|(?:CHAR|BYTE)\\b|UNSIGNED\\b|ZEROFILL\\b|ARRAY\\b))*(?:\\s*\\[\\s*\\d*\\s*\\])*)(?=\\s|$)([\\s\\S]*)$`,
		"iu",
	);
	const typeMatch = typeRe.exec(rest);
	if (!typeMatch) return null;
	const cleanType = typeMatch[1]!
		.replace(/\[([^\]]+)\]/g, (m, inner: string) => (/^\s*\d*\s*$/.test(inner) ? m : inner))
		.replace(/\s+/g, " ")
		.trim();
	return {
		name: colName,
		type: cleanType,
		constraints: typeMatch[2]!.trim(),
	};
}

const DROPPED_NOTE_TAG = "[deprecated / dropped in SQL]";
const DROPPED_NOTE_RE = /\[deprecated\s*\/\s*dropped in sql\]/i;

/** Scans balanced parentheses starting at `openParenPos` (where `text[openParenPos] === "("`), returning inner text and end index. */
function scanBalancedParens(text: string, openParenPos: number): { inner: string; end: number } | null {
	if (text[openParenPos] !== "(") return null;
	let depth = 1;
	let i = openParenPos + 1;
	let quote: string | null = null;
	let bracket = false;
	while (i < text.length && depth > 0) {
		const ch = text[i]!;
		if (bracket) {
			if (ch === "]") {
				if (text[i + 1] === "]") i++;
				else bracket = false;
			}
		} else if (quote) {
			if (ch === quote) {
				if (text[i + 1] === quote) i++;
				else quote = null;
			}
		} else {
			const qOpen = matchOracleQQuote(text, i);
			if (qOpen) {
				const closePos = text.indexOf(`${qOpen.closeDelim}'`, qOpen.bodyStart);
				i = closePos >= 0 ? closePos + 2 : text.length;
				continue;
			}
			const dollarTag = matchPgDollarTag(text, i);
			if (dollarTag) {
				const closePos = text.indexOf(dollarTag, i + dollarTag.length);
				i = closePos >= 0 ? closePos + dollarTag.length : text.length;
				continue;
			}
			if (ch === "[") {
				bracket = true;
			} else if (ch === "'" || ch === '"' || ch === "`") {
				quote = ch;
			} else if (ch === "(") {
				depth++;
			} else if (ch === ")") {
				depth--;
			}
		}
		i++;
	}
	if (depth !== 0) return null;
	return { inner: text.slice(openParenPos + 1, i - 1), end: i };
}

/**
 * Extracts an `ALTER TABLE` clause body: balanced `(...)` when parenthesized, otherwise scans outside
 * quotes, backticks, brackets, and parentheses up to `;`, `GO`, or the next top-level DDL/DML statement
 * (without cutting off PostgreSQL comma-chained `, ADD COLUMN ...` / `, DROP COLUMN ...` / `, ALTER COLUMN ...` actions).
 */
function extractAlterBody(cleaned: string, masked: string, pos: number): string {
	while (pos < cleaned.length && /\s/.test(cleaned[pos]!)) pos++;
	if (pos >= cleaned.length) return "";
	if (cleaned[pos] === "(") {
		const scanned = scanBalancedParens(cleaned, pos);
		return scanned ? scanned.inner.trim() : "";
	}
	const stmtStartKwRe =
		/^(?:CREATE\s+(?:OR\s+(?:REPLACE|ALTER)\s+)?|ALTER\s+(?:TABLE|INDEX|VIEW|PROC(?:EDURE)?|FUNCTION|TRIGGER|SEQUENCE|PACKAGE|SYNONYM|TYPE|SCHEMA|DATABASE)\b|DROP\s+(?:TABLE|INDEX|VIEW|PROC(?:EDURE)?|FUNCTION|TRIGGER|SEQUENCE|PACKAGE|SYNONYM|TYPE|SCHEMA|DATABASE)\b|GRANT\b|REVOKE\b|DENY\b|EXEC(?:UTE)?\b|COMMENT\s+ON\b|SELECT\b|INSERT\b|UPDATE\b|DELETE\b|MERGE\b)/i;
	let i = pos;
	const n = masked.length;
	let depth = 0;
	let quote: string | null = null;
	let bracket = false;
	let lastNonWs = "";
	while (i < n) {
		const ch = masked[i]!;
		if (bracket) {
			if (ch === "]") {
				if (masked[i + 1] === "]") i++;
				else bracket = false;
			}
			i++;
			continue;
		}
		if (quote) {
			if (ch === quote) {
				if (masked[i + 1] === quote) i++;
				else quote = null;
			}
			i++;
			continue;
		}
		if (ch === "[") {
			bracket = true;
			lastNonWs = ch;
			i++;
			continue;
		}
		if (ch === "'" || ch === '"' || ch === "`") {
			quote = ch;
			lastNonWs = ch;
			i++;
			continue;
		}
		if (ch === "(") {
			depth++;
			lastNonWs = ch;
			i++;
			continue;
		}
		if (ch === ")") {
			if (depth > 0) depth--;
			lastNonWs = ch;
			i++;
			continue;
		}
		if (depth === 0) {
			if (ch === ";") break;
			if ((i === pos || masked[i - 1] === "\n") && /^[ \t]*GO[ \t]*(?=\r?\n|$)/i.test(masked.slice(i))) break;
			if (
				i > pos &&
				lastNonWs !== "," &&
				(i === pos || !isIdentChar(masked[i - 1])) &&
				stmtStartKwRe.test(masked.slice(i))
			) {
				// Allow `ON DELETE CASCADE` / `ON UPDATE CASCADE` / `SET DEFAULT ...` inside column specs.
				const prevSlice = masked.slice(Math.max(pos, i - 16), i);
				if (!/\bON\s+$/i.test(prevSlice)) break;
			}
		}
		if (!/\s/.test(ch)) lastNonWs = ch;
		i++;
	}
	return cleaned.slice(pos, i).trim();
}

/** Parses a table-level `[CONSTRAINT name] FOREIGN KEY (col1, ...) REFERENCES refTable[(refCol1, ...)] [ON DELETE ...]`. */
function parseTableForeignKeys(rawClause: string): SqlForeignKeyDef[] {
	const line = rawClause.replace(/\s+/g, " ").trim();
	const fkRe = new RegExp(
		`^(?:CONSTRAINT\\s+${IDENT_PART}\\s+)?FOREIGN\\s+KEY\\s*\\(([^)]+)\\)\\s+REFERENCES\\s+(${QUALIFIED_NAME})(?:\\s*\\(([^)]+)\\))?`,
		"iu",
	);
	const m = fkRe.exec(line);
	if (!m) return [];
	const localCols = splitTopLevelCommas(m[1]!).map((c) => cleanIdent(c)).filter(Boolean);
	const { bareName, name } = normalizeObjectName(m[2]!);
	const refTable = bareName || name;
	if (!refTable || !localCols.length) return [];
	const refCols = m[3] ? splitTopLevelCommas(m[3]).map((c) => cleanIdent(c)).filter(Boolean) : [];
	const tail = maskSingleQuoted(line.slice(m[0].length));
	const onDelMatch = /\bON\s+DELETE\s+(CASCADE|SET\s+NULL|SET\s+DEFAULT|RESTRICT|NO\s+ACTION)\b/i.exec(tail);
	const onDelete = onDelMatch ? onDelMatch[1]!.replace(/\s+/g, " ").toUpperCase() : undefined;
	if (localCols.length === 1) {
		const refColumn = refCols[0];
		return [
			{
				column: localCols[0]!,
				refTable,
				...(refColumn ? { refColumn } : {}),
				...(onDelete ? { onDelete } : {}),
			},
		];
	}
	return [
		{
			column: localCols.join(", "),
			columns: localCols,
			refTable,
			...(refCols.length ? { refColumn: refCols.join(", "), refColumns: refCols } : {}),
			...(onDelete ? { onDelete } : {}),
		},
	];
}

/** Parses an inline column-level `REFERENCES refTable[(refCol)] [ON DELETE ...]` constraint. */
function parseInlineForeignKey(col: SqlColumnDef): SqlForeignKeyDef | null {
	if (!col.constraints) return null;
	const masked = maskSingleQuoted(col.constraints);
	if (!/\bREFERENCES\b/i.test(masked)) return null;
	const refRe = new RegExp(`\\bREFERENCES\\s+(${QUALIFIED_NAME})(?:\\s*\\(([^)]+)\\))?`, "iu");
	const m = refRe.exec(masked);
	if (!m) return null;
	const { bareName, name } = normalizeObjectName(m[1]!);
	const refTable = bareName || name;
	if (!refTable) return null;
	const refColumn = m[2] ? cleanIdent(splitTopLevelCommas(m[2])[0] ?? "") || undefined : undefined;
	const onDelMatch = /\bON\s+DELETE\s+(CASCADE|SET\s+NULL|SET\s+DEFAULT|RESTRICT|NO\s+ACTION)\b/i.exec(masked.slice((m.index ?? 0) + m[0].length));
	const onDelete = onDelMatch ? onDelMatch[1]!.replace(/\s+/g, " ").toUpperCase() : undefined;
	return {
		column: col.name,
		refTable,
		...(refColumn ? { refColumn } : {}),
		...(onDelete ? { onDelete } : {}),
	};
}

/** Parses a table-level `[CONSTRAINT name] PRIMARY KEY (col1, ...)` clause. */
function parseTablePrimaryKeyCols(rawClause: string): string[] {
	const line = rawClause.replace(/\s+/g, " ").trim();
	const pkRe = new RegExp(
		`^(?:CONSTRAINT\\s+${IDENT_PART}\\s+)?PRIMARY\\s+KEY\\s*(?:CLUSTERED|NONCLUSTERED)?\\s*\\(([^)]+)\\)`,
		"iu",
	);
	const m = pkRe.exec(line);
	if (!m) return [];
	return splitTopLevelCommas(m[1]!)
		.map((part) => {
			const ident = new RegExp(`^\\s*(${IDENT_PART})`, "u").exec(part);
			return ident ? cleanIdent(ident[1]!) : "";
		})
		.filter(Boolean);
}

function addForeignKey(target: SqlTableDef, fk: SqlForeignKeyDef) {
	if (!target.foreignKeys) target.foreignKeys = [];
	const localKey = fkLocalCols(fk).map((c) => c.toLowerCase()).join(",");
	const refTblKey = bareTableKey(fk.refTable);
	const refColKey = fkRefCols(fk).map((c) => c.toLowerCase()).join(",");
	const exists = target.foreignKeys.some(
		(e) =>
			fkLocalCols(e).map((c) => c.toLowerCase()).join(",") === localKey &&
			bareTableKey(e.refTable) === refTblKey &&
			fkRefCols(e).map((c) => c.toLowerCase()).join(",") === refColKey,
	);
	if (!exists) target.foreignKeys.push(fk);
}

function addIndex(target: SqlTableDef, idx: SqlIndexDef) {
	if (!idx.name || !idx.columns.length) return;
	if (!target.indexes) target.indexes = [];
	const existing = target.indexes.find((e) => e.name.toLowerCase() === idx.name.toLowerCase());
	if (existing) {
		existing.columns = idx.columns;
		if (idx.unique) existing.unique = true;
		else delete existing.unique;
		return;
	}
	target.indexes.push(idx.unique ? { name: idx.name, columns: idx.columns, unique: true } : { name: idx.name, columns: idx.columns });
}

/**
 * Extracts effective `CREATE TABLE` definitions from SQL DDL text, processing
 * `CREATE TABLE`, `DROP TABLE`, `DROP INDEX`, `ALTER TABLE` (`ADD`, `DROP COLUMN`,
 * `ALTER COLUMN`, Oracle `MODIFY`, `RENAME COLUMN`), `CREATE INDEX`, and
 * `COMMENT ON COLUMN` in exact source order.
 */
export function parseCreateTables(sql: string, options?: { includeStandaloneAlter?: boolean }): SqlTableDef[] {
	// `cleaned` preserves string literal values (like `DEFAULT '-- none --'`);
	// `masked` blanks string literals at identical character offsets so `EXEC('CREATE TABLE ...')` never matches.
	const cleaned = sanitizeSql(sql, false);
	const masked = sanitizeSql(sql, true);
	const tables: SqlTableDef[] = [];
	const byKey = new Map<string, SqlTableDef>();

	const removeTableDef = (existing: SqlTableDef) => {
		const idx = tables.indexOf(existing);
		if (idx >= 0) tables.splice(idx, 1);
		for (const [k, v] of byKey) {
			if (v === existing) byKey.delete(k);
		}
	};

	const registerTable = (name: string, bareName: string, def: SqlTableDef) => {
		const prev = byKey.get(name.toLowerCase());
		if (prev) removeTableDef(prev);
		tables.push(def);
		byKey.set(name.toLowerCase(), def);
		byKey.set(bareName.toLowerCase(), def);
	};

	const ensureTarget = (rawName: string, allowStub: boolean): SqlTableDef | undefined => {
		const { name, bareName } = normalizeObjectName(rawName);
		let target = byKey.get(name.toLowerCase()) ?? byKey.get(bareName.toLowerCase());
		if (!target && allowStub && options?.includeStandaloneAlter && bareName && !bareName.startsWith("#")) {
			target = { tableName: bareName || name, columns: [] };
			tables.push(target);
			byKey.set(name.toLowerCase(), target);
			if (!byKey.has(bareName.toLowerCase())) byKey.set(bareName.toLowerCase(), target);
		}
		return target;
	};

	const readCommentLiteral = (src: string, startPos: number): string => {
		const qOpen = matchOracleQQuote(src, startPos);
		if (qOpen) {
			const closePos = src.indexOf(`${qOpen.closeDelim}'`, qOpen.bodyStart);
			const inner = closePos >= 0 ? src.slice(qOpen.bodyStart, closePos) : src.slice(qOpen.bodyStart);
			return inner.replace(/\s+/g, " ").trim();
		}
		if (src[startPos] !== "'") return "";
		let val = "";
		let i = startPos + 1;
		while (i < src.length) {
			if (src[i] === "'") {
				if (src[i + 1] === "'") {
					val += "'";
					i += 2;
					continue;
				}
				break;
			}
			val += src[i]!;
			i++;
		}
		return val.replace(/\s+/g, " ").trim();
	};

	const stripDefaultClause = (constraints: string): string => {
		const m = maskSingleQuoted(constraints);
		const dm = /\bDEFAULT\b/i.exec(m);
		if (!dm) return constraints;
		const start = dm.index;
		let pos = start + dm[0].length;
		while (pos < constraints.length && /\s/.test(constraints[pos]!)) pos++;
		if (pos < constraints.length && constraints[pos] === "(") {
			const scanned = scanBalancedParens(constraints, pos);
			pos = scanned ? scanned.end : constraints.length;
		} else {
			const endRe = /\s+(?:NOT\s+NULL|NULL|PRIMARY\s+KEY|UNIQUE|CHECK\b|REFERENCES\b|CONSTRAINT\b|COLLATE\b|ON\s+DELETE\b|ON\s+UPDATE\b)/i;
			const em = endRe.exec(m.slice(pos));
			pos = em ? pos + em.index : constraints.length;
		}
		return `${constraints.slice(0, start)} ${constraints.slice(pos)}`.replace(/\s+/g, " ").trim();
	};

	const upsertModifiedColumn = (target: SqlTableDef, rawItem: string, allowInsert: boolean, isModifyOp: boolean) => {
		const trimmed = rawItem.replace(/\s+/g, " ").trim();
		if (!trimmed) return;
		// PostgreSQL `ALTER COLUMN col SET NOT NULL` / `DROP NOT NULL`
		const pgNull = new RegExp(`^(${IDENT_PART})\\s+(SET|DROP)\\s+NOT\\s+NULL\\b`, "iu").exec(trimmed);
		if (pgNull) {
			const colName = cleanIdent(pgNull[1]!).toLowerCase();
			const existing = target.columns.find((c) => c.name.toLowerCase() === colName);
			if (existing) {
				if (pgNull[2]!.toUpperCase() === "SET") {
					if (!/\bNOT\s+NULL\b/i.test(maskSingleQuoted(existing.constraints))) {
						existing.constraints = existing.constraints ? `${existing.constraints} NOT NULL` : "NOT NULL";
					}
				} else {
					existing.constraints = existing.constraints.replace(/\bNOT\s+NULL\b/gi, "").replace(/\s+/g, " ").trim();
				}
			}
			return;
		}
		// PostgreSQL `ALTER COLUMN col SET DEFAULT <expr>` / `DROP DEFAULT`
		const pgSetDefault = new RegExp(`^(${IDENT_PART})\\s+SET\\s+DEFAULT\\s+([\\s\\S]+)$`, "iu").exec(trimmed);
		if (pgSetDefault) {
			const colName = cleanIdent(pgSetDefault[1]!).toLowerCase();
			const existing = target.columns.find((c) => c.name.toLowerCase() === colName);
			if (existing) {
				const base = stripDefaultClause(existing.constraints);
				const defExpr = `DEFAULT ${pgSetDefault[2]!.trim()}`;
				existing.constraints = base ? `${base} ${defExpr}` : defExpr;
			}
			return;
		}
		const pgDropDefault = new RegExp(`^(${IDENT_PART})\\s+DROP\\s+DEFAULT\\b`, "iu").exec(trimmed);
		if (pgDropDefault) {
			const colName = cleanIdent(pgDropDefault[1]!).toLowerCase();
			const existing = target.columns.find((c) => c.name.toLowerCase() === colName);
			if (existing) {
				existing.constraints = stripDefaultClause(existing.constraints);
			}
			return;
		}
		// Ignore PostgreSQL metadata-only `ALTER COLUMN` operations (`SET STATISTICS`, `SET STORAGE`, `DROP EXPRESSION`, `DROP IDENTITY`, `ADD GENERATED`)
		if (
			new RegExp(
				`^(${IDENT_PART})\\s+(?:SET\\s+(?:STATISTICS|STORAGE|COMPRESSION|\\()|RESET\\s*\\(|DROP\\s+(?:EXPRESSION|IDENTITY)|ADD\\s+GENERATED|RESTART\\b)`,
				"iu",
			).test(trimmed)
		) {
			return;
		}
		// Oracle constraint-only MODIFY (`MODIFY (COL NOT NULL)` / `MODIFY COL NULL` / `MODIFY COL DEFAULT 0`)
		const constraintOnly = new RegExp(`^(${IDENT_PART})\\s+((?:NOT\\s+)?NULL\\b[\\s\\S]*|DEFAULT\\b[\\s\\S]*)$`, "iu").exec(trimmed);
		if (constraintOnly) {
			const colName = cleanIdent(constraintOnly[1]!).toLowerCase();
			const existing = target.columns.find((c) => c.name.toLowerCase() === colName);
			if (existing) {
				const clause = constraintOnly[2]!.trim();
				const clauseMask = maskSingleQuoted(clause);
				const prevMask = maskSingleQuoted(existing.constraints);
				if (/^DEFAULT\b/i.test(clauseMask)) {
					const base = stripDefaultClause(existing.constraints);
					existing.constraints = base ? `${base} ${clause}` : clause;
				} else if (/^NOT\s+NULL\b/i.test(clauseMask)) {
					const withoutNull = existing.constraints.replace(/(?:^|\s)NULL\b/gi, " ").replace(/\s+/g, " ").trim();
					existing.constraints = /\bNOT\s+NULL\b/i.test(prevMask)
						? existing.constraints
						: withoutNull
							? `NOT NULL ${withoutNull}`
							: clause;
				} else {
					// Explicit `NULL`
					const withoutNotNull = existing.constraints.replace(/\bNOT\s+NULL\b/gi, "").replace(/\s+/g, " ").trim();
					existing.constraints = withoutNotNull ? `${withoutNotNull} NULL` : "NULL";
				}
			}
			return;
		}
		// Normalize PostgreSQL `col [SET DATA] TYPE newType [USING expr]` -> `col newType`
		const pgTypeRe = new RegExp(`^(${IDENT_PART})\\s+(?:SET\\s+DATA\\s+)?TYPE\\s+`, "iu");
		const isPgType = pgTypeRe.test(trimmed);
		let normalized = isPgType ? trimmed.replace(pgTypeRe, "$1 ") : trimmed;
		if (isPgType) {
			const usingMatch = /\s+USING\s+[\s\S]*$/i.exec(maskSingleQuoted(normalized));
			if (usingMatch) normalized = normalized.slice(0, usingMatch.index).trim();
		}
		const parsed = parseColumnClause(normalized);
		if (!parsed) return;
		const existing = target.columns.find((c) => c.name.toLowerCase() === parsed.name.toLowerCase());
		if (existing) {
			if (parsed.type) existing.type = parsed.type;
			if (!isPgType) {
				const parsedMask = maskSingleQuoted(parsed.constraints);
				const prevMask = maskSingleQuoted(existing.constraints);
				const explicitNull = /(?:^|\s)NULL\b/i.test(parsedMask) && !/\bNOT\s+NULL\b/i.test(parsedMask);
				const explicitNotNull = /\bNOT\s+NULL\b/i.test(parsedMask);
				const explicitPk = /\bPRIMARY\s+KEY\b/i.test(parsedMask);
				const prevNotNull = /\bNOT\s+NULL\b/i.test(prevMask);
				const prevPk = /\bPRIMARY\s+KEY\b/i.test(prevMask);
				let nextCons = parsed.constraints;
				if (!explicitNull) {
					if (isModifyOp && prevNotNull && !explicitNotNull) {
						nextCons = nextCons ? `${nextCons} NOT NULL` : "NOT NULL";
					}
					if (prevPk && !explicitPk) {
						nextCons = nextCons ? `${nextCons} PRIMARY KEY` : "PRIMARY KEY";
					}
				}
				existing.constraints = nextCons;
			}
		} else if (allowInsert) {
			target.columns.push(parsed);
		}
		const inlineFk = parseInlineForeignKey(parsed);
		if (inlineFk) addForeignKey(target, inlineFk);
	};

	const applyDropColumn = (target: SqlTableDef, rawItem: string) => {
		const stripped = rawItem
			.replace(/^(?:DROP\s+)?(?:COLUMN\s+)?(?:IF\s+EXISTS\s+)?/i, "")
			.trim();
		if (/^(?:CONSTRAINT|PRIMARY\s+KEY|FOREIGN\s+KEY|UNIQUE|INDEX|CHECK|TRIGGER)\b/i.test(stripped)) return;
		const identMatch = new RegExp(`^(${IDENT_PART})`, "u").exec(stripped);
		if (!identMatch) return;
		const dropKey = cleanIdent(identMatch[1]!).toLowerCase();
		const idx = target.columns.findIndex((c) => c.name.toLowerCase() === dropKey);
		if (idx >= 0) target.columns.splice(idx, 1);
		if (target.foreignKeys?.length) {
			target.foreignKeys = target.foreignKeys.filter((fk) => !fkLocalCols(fk).some((c) => c.toLowerCase() === dropKey));
			if (!target.foreignKeys.length) delete target.foreignKeys;
		}
		if (target.indexes?.length) {
			target.indexes = target.indexes
				.map((ix) => ({ ...ix, columns: ix.columns.filter((c) => c.toLowerCase() !== dropKey) }))
				.filter((ix) => ix.columns.length > 0);
			if (!target.indexes.length) delete target.indexes;
		}
	};

	const applyAddItem = (target: SqlTableDef, rawItem: string) => {
		const stripped = rawItem
			.replace(/^(?:ADD\s+)?(?:COLUMN\s+)?(?:IF\s+NOT\s+EXISTS\s+)?/i, "")
			.trim();
		if (!stripped) return;
		// Reject T-SQL `ADD DEFAULT <val> FOR <col>` (not a column definition).
		if (/^DEFAULT\b/i.test(stripped)) return;
		const tableFks = parseTableForeignKeys(stripped);
		if (tableFks.length) {
			for (const fk of tableFks) addForeignKey(target, fk);
			return;
		}
		const pkList = parseTablePrimaryKeyCols(stripped);
		if (pkList.length) {
			for (const pk of pkList) {
				const col = target.columns.find((c) => c.name.toLowerCase() === pk.toLowerCase());
				if (col && !/\bPRIMARY\s+KEY\b/i.test(maskSingleQuoted(col.constraints))) {
					col.constraints = col.constraints ? `${col.constraints} PRIMARY KEY` : "PRIMARY KEY";
				}
			}
			return;
		}
		const col = parseColumnClause(stripped);
		if (col && !target.columns.some((c) => c.name.toLowerCase() === col.name.toLowerCase())) {
			target.columns.push(col);
			const inlineFk = parseInlineForeignKey(col);
			if (inlineFk) addForeignKey(target, inlineFk);
		}
	};

	const createTableRe = new RegExp(
		`\\bCREATE\\s+(?:(?:OR\\s+REPLACE|GLOBAL\\s+TEMPORARY|PRIVATE\\s+TEMPORARY|LOCAL\\s+TEMPORARY|TEMPORARY|TEMP|UNLOGGED)\\s+)*TABLE\\s+(?:IF\\s+NOT\\s+EXISTS\\s+)?(${QUALIFIED_NAME})\\s*\\(`,
		"giu",
	);
	const dropTableRe = new RegExp(`\\bDROP\\s+TABLE\\s+(?:IF\\s+EXISTS\\s+)?`, "gi");
	const dropIndexRe = new RegExp(
		`\\bDROP\\s+INDEX\\s+(?:CONCURRENTLY\\s+)?(?:IF\\s+EXISTS\\s+)?(${QUALIFIED_NAME})(?:\\s+ON\\s+(${QUALIFIED_NAME}))?`,
		"giu",
	);
	const alterRe = new RegExp(
		`\\bALTER\\s+TABLE\\s+(?:IF\\s+EXISTS\\s+)?(?:ONLY\\s+)?(${QUALIFIED_NAME})\\s+(?:WITH\\s+(?:NO)?CHECK\\s+)?(ADD|DROP|ALTER|MODIFY|RENAME)\\b`,
		"giu",
	);
	const commentColRe = new RegExp(
		`\\bCOMMENT\\s+ON\\s+COLUMN\\s+((?:${IDENT_PART}\\s*\\.\\s*){1,3}${IDENT_PART})\\s+IS\\s+(?:[qQ]?')`,
		"giu",
	);
	const indexRe = new RegExp(
		`\\bCREATE\\s+(?:(UNIQUE)\\s+)?(?:(?:CLUSTERED|NONCLUSTERED|COLUMNSTORE|BITMAP|FULLTEXT|SPATIAL)\\s+)*INDEX\\s+(?:CONCURRENTLY\\s+)?(?:IF\\s+NOT\\s+EXISTS\\s+)?(${QUALIFIED_NAME})\\s+ON\\s+(?:ONLY\\s+)?(${QUALIFIED_NAME})(?:\\s+USING\\s+[A-Za-z_][\\w$]*)?\\s*\\(`,
		"giu",
	);

	type DdlEvent =
		| { index: number; kind: "createTable"; match: RegExpExecArray }
		| { index: number; kind: "dropTable"; match: RegExpExecArray }
		| { index: number; kind: "dropIndex"; match: RegExpExecArray }
		| { index: number; kind: "alter"; match: RegExpExecArray }
		| { index: number; kind: "comment"; match: RegExpExecArray }
		| { index: number; kind: "index"; match: RegExpExecArray };
	const events: DdlEvent[] = [];
	for (const m of masked.matchAll(createTableRe)) events.push({ index: m.index ?? 0, kind: "createTable", match: m });
	for (const m of masked.matchAll(dropTableRe)) events.push({ index: m.index ?? 0, kind: "dropTable", match: m });
	for (const m of masked.matchAll(dropIndexRe)) events.push({ index: m.index ?? 0, kind: "dropIndex", match: m });
	for (const m of masked.matchAll(alterRe)) events.push({ index: m.index ?? 0, kind: "alter", match: m });
	for (const m of masked.matchAll(commentColRe)) events.push({ index: m.index ?? 0, kind: "comment", match: m });
	for (const m of masked.matchAll(indexRe)) events.push({ index: m.index ?? 0, kind: "index", match: m });
	events.sort((a, b) => a.index - b.index);

	for (const ev of events) {
		if (ev.kind === "createTable") {
			const m = ev.match;
			const stmtBefore = masked.slice(findStatementStart(masked, ev.index), ev.index).trimStart();
			if (/^(?:GRANT|REVOKE|DENY)\b/i.test(stmtBefore)) continue;
			const { name, bareName } = normalizeObjectName(m[1]!);
			if (!bareName || bareName.startsWith("#")) continue;
			const tableName = bareName || name;
			const parenPos = ev.index + m[0].length - 1;
			const scanned = scanBalancedParens(cleaned, parenPos);
			if (!scanned) continue;
			const columns: SqlColumnDef[] = [];
			const def: SqlTableDef = { tableName, columns };
			const pkCols = new Set<string>();
			for (const item of splitTopLevelCommas(scanned.inner)) {
				const tableFks = parseTableForeignKeys(item);
				if (tableFks.length) {
					for (const fk of tableFks) addForeignKey(def, fk);
					continue;
				}
				const pkList = parseTablePrimaryKeyCols(item);
				if (pkList.length) {
					for (const c of pkList) pkCols.add(c.toLowerCase());
					continue;
				}
				const parsed = parseColumnClause(item);
				if (parsed) {
					columns.push(parsed);
					const inlineFk = parseInlineForeignKey(parsed);
					if (inlineFk) addForeignKey(def, inlineFk);
				}
			}
			if (pkCols.size) {
				for (const col of columns) {
					if (pkCols.has(col.name.toLowerCase()) && !/\bPRIMARY\s+KEY\b/i.test(maskSingleQuoted(col.constraints))) {
						col.constraints = col.constraints ? `${col.constraints} PRIMARY KEY` : "PRIMARY KEY";
					}
				}
			}
			registerTable(name, bareName, def);
			continue;
		}

		if (ev.kind === "dropTable") {
			const m = ev.match;
			const stmtBefore = masked.slice(findStatementStart(masked, ev.index), ev.index).trimStart();
			if (/^(?:GRANT|REVOKE|DENY)\b/i.test(stmtBefore)) continue;
			const rawList = extractAlterBody(cleaned, masked, ev.index + m[0].length)
				.replace(/\s+(?:CASCADE(?:\s+CONSTRAINTS)?|RESTRICT|PURGE)\b[\s\S]*$/i, "")
				.trim();
			for (const part of splitTopLevelCommas(rawList)) {
				const { name, bareName } = normalizeObjectName(part);
				const existing = byKey.get(name.toLowerCase()) ?? byKey.get(bareName.toLowerCase());
				if (existing) removeTableDef(existing);
			}
			continue;
		}

		if (ev.kind === "dropIndex") {
			const m = ev.match;
			const stmtBefore = masked.slice(findStatementStart(masked, ev.index), ev.index).trimStart();
			if (/^(?:GRANT|REVOKE|DENY)\b/i.test(stmtBefore)) continue;
			const partRe = new RegExp(IDENT_PART, "gu");
			const ixParts = [...m[1]!.matchAll(partRe)].map((p) => cleanIdent(p[0]!)).filter(Boolean);
			const ixBare = (ixParts[ixParts.length - 1] ?? "").toLowerCase();
			if (!ixBare) continue;
			const removeIx = (target: SqlTableDef) => {
				if (!target.indexes?.length) return;
				target.indexes = target.indexes.filter((ix) => ix.name.toLowerCase() !== ixBare);
				if (!target.indexes.length) delete target.indexes;
			};
			if (m[2]) {
				const target = ensureTarget(m[2], false);
				if (target) removeIx(target);
			} else {
				const maybeTbl = ixParts.length >= 2 ? byKey.get(ixParts[ixParts.length - 2]!.toLowerCase()) : undefined;
				if (maybeTbl) {
					removeIx(maybeTbl);
				} else {
					for (const t of tables) removeIx(t);
				}
			}
			continue;
		}

		if (ev.kind === "index") {
			const m = ev.match;
			const unique = Boolean(m[1]);
			const { bareName: idxBare, name: idxName } = normalizeObjectName(m[2]!);
			const target = ensureTarget(m[3]!, false);
			if (!target) continue;
			const parenPos = ev.index + m[0].length - 1;
			const scanned = scanBalancedParens(cleaned, parenPos);
			if (!scanned) continue;
			const cols = splitTopLevelCommas(scanned.inner)
				.map((part) => {
					const noDir = part.trim().replace(/(?:\s+(?:ASC|DESC|NULLS\s+(?:FIRST|LAST)))+\s*$/i, "").trim();
					if (!noDir) return "";
					if (/[()]/.test(noDir) && !/^[\["`]/.test(noDir)) {
						return noDir.replace(/\s+/g, " ");
					}
					const ident = new RegExp(`^(${IDENT_PART})`, "u").exec(noDir);
					return ident ? cleanIdent(ident[1]!) : noDir;
				})
				.filter(Boolean);
			addIndex(target, { name: idxBare || idxName, columns: cols, ...(unique ? { unique: true } : {}) });
			continue;
		}

		if (ev.kind === "comment") {
			const m = ev.match;
			const partRe = new RegExp(IDENT_PART, "gu");
			const parts = [...m[1]!.matchAll(partRe)].map((p) => cleanIdent(p[0]!)).filter(Boolean);
			if (parts.length < 2) continue;
			const colName = parts[parts.length - 1]!;
			const bareTbl = parts[parts.length - 2]!;
			const qualTbl = parts.length >= 3 ? `${parts[parts.length - 3]}.${bareTbl}` : bareTbl;
			const target = byKey.get(qualTbl.toLowerCase()) ?? byKey.get(bareTbl.toLowerCase());
			if (!target) continue;
			const col = target.columns.find((c) => c.name.toLowerCase() === colName.toLowerCase());
			if (!col) continue;
			// Find the start of the string literal (`'` or `q'`) right after `IS `
			const matchEnd = ev.index + m[0].length;
			const litStart =
				matchEnd >= 2 && (cleaned[matchEnd - 2] === "q" || cleaned[matchEnd - 2] === "Q") && cleaned[matchEnd - 1] === "'"
					? matchEnd - 2
					: matchEnd - 1;
			const commentText = readCommentLiteral(cleaned, litStart);
			if (commentText) col.comment = commentText;
			continue;
		}

		const m = ev.match;
		const stmtBefore = masked.slice(findStatementStart(masked, ev.index), ev.index).trimStart();
		if (/^(?:GRANT|REVOKE|DENY)\b/i.test(stmtBefore)) continue;
		const initialOp = m[2]!.toUpperCase();
		let pos = (m.index ?? 0) + m[0].length;
		while (pos < cleaned.length && /\s/.test(cleaned[pos]!)) pos++;

		if (initialOp === "RENAME") {
			const target = ensureTarget(m[1]!, false);
			if (!target) continue;
			const colKw = /^COLUMN\b\s*/i.exec(masked.slice(pos));
			if (!colKw) continue;
			const rawSpec = extractAlterBody(cleaned, masked, pos + colKw[0].length);
			const renMatch = new RegExp(`^(${IDENT_PART})\\s+TO\\s+(${IDENT_PART})`, "iu").exec(rawSpec);
			if (!renMatch) continue;
			const oldName = cleanIdent(renMatch[1]!);
			const newName = cleanIdent(renMatch[2]!);
			if (!oldName || !newName) continue;
			const oldLow = oldName.toLowerCase();
			const existing = target.columns.find((c) => c.name.toLowerCase() === oldLow);
			if (existing) existing.name = newName;
			if (target.foreignKeys?.length) {
				for (const fk of target.foreignKeys) {
					if (fk.columns?.length) {
						fk.columns = fk.columns.map((c) => (c.toLowerCase() === oldLow ? newName : c));
						fk.column = fk.columns.join(", ");
					} else if (fk.column.toLowerCase() === oldLow) {
						fk.column = newName;
					}
				}
			}
			if (target.indexes?.length) {
				for (const ix of target.indexes) {
					ix.columns = ix.columns.map((c) => (c.toLowerCase() === oldLow ? newName : c));
				}
			}
			const targetBare = bareTableKey(target.tableName);
			for (const other of tables) {
				for (const fk of other.foreignKeys ?? []) {
					if (bareTableKey(fk.refTable) !== targetBare) continue;
					if (fk.refColumns?.length) {
						fk.refColumns = fk.refColumns.map((c) => (c.toLowerCase() === oldLow ? newName : c));
						fk.refColumn = fk.refColumns.join(", ");
					} else if (fk.refColumn?.toLowerCase() === oldLow) {
						fk.refColumn = newName;
					}
				}
			}
			continue;
		}

		// Handle single and comma-chained ALTER TABLE actions (`ADD`, `DROP`, `ALTER`, `MODIFY`).
		let activeOp = initialOp;
		if (activeOp === "ADD") {
			const colKw = /^COLUMN\b\s*/i.exec(masked.slice(pos));
			if (colKw) pos += colKw[0].length;
		} else if (activeOp === "DROP") {
			const restMasked = masked.slice(pos);
			const colKw = /^COLUMN\b\s*/i.exec(restMasked);
			if (colKw) {
				pos += colKw[0].length;
			} else if (cleaned[pos] !== "(") {
				// `DROP CONSTRAINT`, `DROP PRIMARY KEY`, `DROP INDEX`, etc. — still extract body in case chained PG actions follow.
				if (/^(?:CONSTRAINT|PRIMARY\s+KEY|FOREIGN\s+KEY|UNIQUE|INDEX|CHECK|TRIGGER)\b/i.test(restMasked)) {
					const restBody = extractAlterBody(cleaned, masked, pos);
					const items = splitTopLevelCommas(restBody).slice(1);
					if (!items.length) continue;
					for (const item of items) {
						const subOp = /^(ADD|DROP|ALTER|MODIFY)\b\s*/i.exec(item.trim());
						if (!subOp) continue;
						const nextOp = subOp[1]!.toUpperCase();
						const subRest = item.trim().slice(subOp[0].length).trim();
						if (nextOp === "ADD") {
							const t = ensureTarget(m[1]!, true);
							if (t) applyAddItem(t, subRest);
						} else if (nextOp === "DROP") {
							const t = ensureTarget(m[1]!, false);
							if (t) applyDropColumn(t, subRest);
						} else if (nextOp === "ALTER" || nextOp === "MODIFY") {
							const t = ensureTarget(m[1]!, Boolean(options?.includeStandaloneAlter));
							if (t) upsertModifiedColumn(t, subRest.replace(/^COLUMN\b\s*/i, ""), Boolean(options?.includeStandaloneAlter), nextOp === "MODIFY");
						}
					}
				}
				continue;
			}
		} else if (activeOp === "ALTER") {
			const colKw = /^COLUMN\b\s*/i.exec(masked.slice(pos));
			if (!colKw) continue;
			pos += colKw[0].length;
		} else if (activeOp === "MODIFY") {
			const colKw = /^COLUMN\b\s*/i.exec(masked.slice(pos));
			if (colKw) pos += colKw[0].length;
		}

		const rawSpec = extractAlterBody(cleaned, masked, pos);
		if (!rawSpec) continue;

		for (const rawItem of splitTopLevelCommas(rawSpec)) {
			const itemTrim = rawItem.trim();
			if (!itemTrim) continue;
			let itemOp = activeOp;
			let itemBody = itemTrim;
			// Detect PostgreSQL chained action switches (`ADD COLUMN ...`, `DROP COLUMN ...`, `ALTER COLUMN ...`, `MODIFY ...`)
			const chainedOp = /^(ADD|DROP|ALTER|MODIFY)\s+(?:(COLUMN)\s+)?([\s\S]+)$/i.exec(itemTrim);
			if (chainedOp) {
				const kw = chainedOp[1]!.toUpperCase();
				const hasColKw = Boolean(chainedOp[2]);
				if (kw === "ADD" && (hasColKw || /^(?:IF\s+NOT\s+EXISTS|CONSTRAINT|FOREIGN\s+KEY|PRIMARY\s+KEY)/i.test(chainedOp[3]!))) {
					itemOp = "ADD";
					itemBody = chainedOp[3]!.trim();
					activeOp = "ADD";
				} else if (kw === "DROP" && (hasColKw || /^(?:IF\s+EXISTS|CONSTRAINT|PRIMARY\s+KEY|FOREIGN\s+KEY|UNIQUE|INDEX|CHECK|TRIGGER)\b/i.test(chainedOp[3]!))) {
					itemOp = "DROP";
					itemBody = chainedOp[3]!.trim();
					activeOp = "DROP";
				} else if (kw === "ALTER" && hasColKw) {
					itemOp = "ALTER";
					itemBody = chainedOp[3]!.trim();
					activeOp = "ALTER";
				} else if (kw === "MODIFY") {
					itemOp = "MODIFY";
					itemBody = chainedOp[3]!.trim();
					activeOp = "MODIFY";
				}
			}

			if (itemOp === "ADD") {
				const target = ensureTarget(m[1]!, true);
				if (target) applyAddItem(target, itemBody);
			} else if (itemOp === "DROP") {
				const target = ensureTarget(m[1]!, false);
				if (target) applyDropColumn(target, itemBody);
			} else if (itemOp === "ALTER") {
				const target = ensureTarget(m[1]!, Boolean(options?.includeStandaloneAlter));
				if (target) upsertModifiedColumn(target, itemBody, Boolean(options?.includeStandaloneAlter), false);
			} else if (itemOp === "MODIFY") {
				const target = ensureTarget(m[1]!, Boolean(options?.includeStandaloneAlter));
				if (target) upsertModifiedColumn(target, itemBody, Boolean(options?.includeStandaloneAlter), true);
			}
		}
	}

	return tables;
}

const SCHEMA_SUBSECTION_RE =
	/^(?:columns?|fields?|foreign\s+keys?|indexes?|indices|keys?|constraints?|triggers?|notes?|rules?|usage|examples?|history|relationships?)$/i;

const formatMarkdownIndexCols = (cols: readonly string[], esc: (s: string) => string) =>
	cols.map((c) => `\`${esc(c)}\``).join(", ");

type FenceState = { ch: string; len: number } | null;

function updateFenceState(line: string, fence: FenceState): FenceState {
	const m = /^\s*(`{3,}|~{3,})(.*)$/.exec(line);
	if (!m) return fence;
	const marker = m[1]!;
	const rest = m[2]!.trim();
	if (!fence) {
		if (marker[0] === "`" && rest.includes("`")) return fence;
		return { ch: marker[0]!, len: marker.length };
	}
	if (marker[0] === fence.ch && marker.length >= fence.len && !rest) {
		return null;
	}
	return fence;
}

/** Strips matches of `re` that fall outside single-quoted string literals. */
function stripOutsideQuotes(text: string, re: RegExp): string {
	const masked = maskSingleQuoted(text);
	const flags = re.flags.includes("g") ? re.flags : `${re.flags}g`;
	const globalRe = new RegExp(re.source, flags);
	const chars = text.split("");
	for (const m of masked.matchAll(globalRe)) {
		const start = m.index ?? 0;
		for (let k = start; k < start + m[0].length && k < chars.length; k++) {
			chars[k] = " ";
		}
	}
	return chars.join("").replace(/\s+/g, " ").trim();
}

/** Compacts verbose SQL type names into ADR-0008-compliant short names (<= 20 chars) while preserving semantic equivalence. */
function compactSqlTypeForMarkdown(rawType: string): { display: string; overflow?: string } {
	const t = rawType.replace(/\s+/g, " ").trim();
	if (!t) return { display: "" };
	if (t.length <= 20) return { display: t };
	let compact = t
		.replace(/\bNATIONAL\s+CHAR(?:ACTER)?\s+VARYING\b/i, "NVARCHAR")
		.replace(/\bNATIONAL\s+CHARACTER\b/i, "NCHAR")
		.replace(/\bCHAR(?:ACTER)?\s+VARYING\b/i, "VARCHAR")
		.replace(/\bTIMESTAMP(\s*\([^)]*\))?\s+WITH\s+LOCAL\s+TIME\s+ZONE\b/i, "TIMESTAMPLTZ$1")
		.replace(/\bTIMESTAMP(\s*\([^)]*\))?\s+WITH\s+TIME\s+ZONE\b/i, "TIMESTAMPTZ$1")
		.replace(/\bTIMESTAMP(\s*\([^)]*\))?\s+WITHOUT\s+TIME\s+ZONE\b/i, "TIMESTAMP$1")
		.replace(/\bTIME(\s*\([^)]*\))?\s+WITH\s+TIME\s+ZONE\b/i, "TIMETZ$1")
		.replace(/\bTIME(\s*\([^)]*\))?\s+WITHOUT\s+TIME\s+ZONE\b/i, "TIME$1")
		.replace(/\bINTERVAL\s+YEAR(?:\s*\([^)]*\))?\s+TO\s+MONTH\b/i, "INTERVAL YM")
		.replace(/\bINTERVAL\s+DAY(?:\s*\([^)]*\))?\s+TO\s+SECOND(?:\s*\([^)]*\))?\b/i, "INTERVAL DS")
		.replace(/\s*\(\s*/g, "(")
		.replace(/\s*,\s*/g, ",")
		.replace(/\s+/g, " ")
		.trim();
	if (compact.length <= 20) return { display: compact };
	return { display: `${compact.slice(0, 19).trimEnd()}…`, overflow: `Type: ${t}` };
}

/** Formats column constraints + comments into ADR-0008-compliant `Constraints` (<= 20 chars) and `Notes` (<= 100 chars) cells. */
function formatColumnCellsForMarkdown(col: SqlColumnDef, esc: (s: string) => string): { typeCell: string; consCell: string; noteCell: string } {
	const { display: shortType, overflow: typeOverflow } = compactSqlTypeForMarkdown(col.type);
	const typeCell = shortType ? `\`${esc(shortType)}\`` : "—";
	const rawCons = (col.constraints || "").replace(/\s+/g, " ").trim();
	const overflowNotes: string[] = [];
	if (typeOverflow) overflowNotes.push(typeOverflow);

	let consCell = "—";
	if (rawCons) {
		if (rawCons.length <= 20) {
			consCell = esc(rawCons);
		} else {
			const maskedCons = maskQuotedAndChecks(rawCons);
			const isPk = /\bPRIMARY\s+KEY\b/i.test(maskedCons);
			const isNotNull = /\bNOT\s+NULL\b/i.test(maskedCons);
			const isUnique = /\bUNIQUE\b/i.test(maskedCons);
			const isNull = !isNotNull && !isPk && /(?:^|\s)NULL\b/i.test(maskedCons);
			const flags: string[] = [];
			if (isNotNull) flags.push("NOT NULL");
			if (isPk) flags.push("PRIMARY KEY");
			else if (isUnique) flags.push("UNIQUE");
			else if (isNull) flags.push("NULL");
			let compactFlags = flags.join(" ");
			if (compactFlags.length > 20) {
				compactFlags = [isNotNull ? "NN" : "", isPk ? "PK" : "", !isPk && isUnique ? "UNIQUE" : ""].filter(Boolean).join(" ");
			}
			consCell = compactFlags || "—";
			let detail = rawCons;
			if (isNotNull) detail = stripOutsideQuotes(detail, /\bNOT\s+NULL\b/gi);
			if (isPk) detail = stripOutsideQuotes(detail, /\bPRIMARY\s+KEY\b/gi);
			if (!isPk && isUnique) detail = stripOutsideQuotes(detail, /\bUNIQUE\b/gi);
			if (isNull) detail = stripOutsideQuotes(detail, /(?:^|\s)NULL\b/gi);
			detail = detail.replace(/\s+/g, " ").trim();
			if (detail) overflowNotes.push(detail);
		}
	}

	const noteParts: string[] = [];
	if (col.comment?.trim()) noteParts.push(col.comment.replace(/\s+/g, " ").trim());
	if (overflowNotes.length) noteParts.push(...overflowNotes);
	let rawNote = noteParts.join("; ").trim();
	if (rawNote.length > 100) rawNote = `${rawNote.slice(0, 99).trimEnd()}…`;
	return { typeCell, consCell, noteCell: rawNote ? esc(rawNote) : "" };
}

/** Formats parsed `CREATE TABLE` definitions (including foreign keys and indexes) into a clean ADR-0008-compliant Markdown schema document. */
export function sqlTablesToMarkdown(tables: readonly SqlTableDef[], sourceLabel?: string): string {
	if (!tables.length) return "";
	const esc = (s: string) => s.replace(/\|/g, "\\|");
	const blocks: string[] = [];
	for (const t of tables) {
		const lines: string[] = [`## ${t.tableName}`, ""];
		if (sourceLabel) lines.push(`Generated from \`${sourceLabel}\`.`, "");
		lines.push("| Column | Type | Constraints | Notes |");
		lines.push("| --- | --- | --- | --- |");
		for (const col of t.columns) {
			const { typeCell, consCell, noteCell } = formatColumnCellsForMarkdown(col, esc);
			lines.push(`| \`${esc(col.name)}\` | ${typeCell} | ${consCell} | ${noteCell} |`);
		}
		if (t.foreignKeys?.length) {
			lines.push("", "## Foreign keys", "");
			lines.push("| Column | Target table | Target column | Notes |");
			lines.push("| --- | --- | --- | --- |");
			for (const fk of t.foreignKeys) {
				const locals = fkLocalCols(fk);
				const refs = fkRefCols(fk);
				const refCols = refs.length ? refs : locals;
				const fkNote = fk.onDelete ? `ON DELETE ${esc(fk.onDelete)}` : "";
				lines.push(
					`| ${formatMarkdownIndexCols(locals, esc)} | \`${esc(fk.refTable)}\` | ${formatMarkdownIndexCols(refCols, esc)} | ${fkNote} |`,
				);
			}
		}
		if (t.indexes?.length) {
			lines.push("", "## Indexes", "");
			lines.push("| Name | Unique | Columns |");
			lines.push("| --- | --- | --- |");
			for (const ix of t.indexes) {
				lines.push(`| \`${esc(ix.name)}\` | ${ix.unique ? "yes" : "no"} | ${formatMarkdownIndexCols(ix.columns, esc)} |`);
			}
		}
		blocks.push(lines.join("\n"));
	}
	return blocks.join("\n\n") + "\n";
}

function splitMarkdownRow(line: string): string[] {
	const trimmed = line.trim().replace(/^\|/, "").replace(/\|$/, "");
	const cells: string[] = [];
	let cur = "";
	for (let i = 0; i < trimmed.length; i++) {
		if (trimmed[i] === "\\" && trimmed[i + 1] === "|") {
			cur += "\\|";
			i++;
		} else if (trimmed[i] === "|") {
			cells.push(cur.trim());
			cur = "";
		} else cur += trimmed[i]!;
	}
	cells.push(cur.trim());
	return cells;
}

const unescPipe = (s: string) => s.replace(/\\\|/g, "|");

const stripMarkdownCell = (s: string) =>
	unescPipe(s)
		.trim()
		.replace(/^\[([^\]]+)\]\([^)]*\)$/, "$1")
		.replace(/^\[\[[^[\]|]+\|([^\]]+)\]\]$/, "$1")
		.replace(/^\[\[([^\]]+)\]\]$/, "$1")
		.replace(/^`|`$/g, "")
		.trim();

const isForeignKeysHeader = (hdr: readonly string[]) =>
	!hdr.some((c) => c.includes("type")) && hdr.some((c) => c.includes("reference") || c.includes("target"));

const isIndexesHeader = (hdr: readonly string[]) =>
	!hdr.some((c) => c.includes("type")) &&
	hdr.some((c) => c === "columns" || c === "column" || c === "fields") &&
	hdr.some((c) => c === "unique" || c === "uniqueness" || c === "index" || c === "index name" || c === "name");

function parseSchemaHeading(line: string): { level: number; text: string; tableToken: string } | null {
	const hm = /^(#{1,3})\s+(.+?)\s*$/.exec(line.trim());
	if (!hm) return null;
	const level = hm[1]!.length;
	const text = hm[2]!.replace(/\s+#+\s*$/, "").replace(/^`|`$/g, "").trim();
	if (!text) return null;
	const lead = /^`?([A-Za-z_][\w$.]*(?:\s+[A-Za-z_][\w$.]*)*)`?(?:\s*(?:\(|—|–|-\s|:)|$)/.exec(text);
	const tableToken = lead ? lead[1]!.trim() : text;
	return { level, text, tableToken };
}

function findColumnHeaderIndex(hdr: readonly string[]): number {
	const colIdx = hdr.findIndex((c) => c === "column" || c === "field" || c === "name" || c.includes("column"));
	if (colIdx < 0) return -1;
	if (hdr[colIdx] === "name") {
		const hasSchemaCol = hdr.some((c, idx) => idx !== colIdx && (c.includes("type") || c.includes("null") || c.includes("constraint")));
		if (!hasSchemaCol) return -1;
	}
	return colIdx;
}

/**
 * Non-destructively merges SQL DDL column, foreign-key, and index definitions into an existing
 * Markdown schema doc while preserving frontmatter, fenced code blocks, surrounding prose,
 * table column layouts (3-col / 4-col), and hand-written `Notes` cells (ADR 0002).
 * Columns absent from SQL are preserved and clearly tagged `[deprecated / dropped in SQL]`.
 */
export function mergeSqlTablesIntoMarkdown(
	existingMarkdown: string,
	tables: readonly SqlTableDef[],
	sourceLabel?: string,
	options?: { markDropped?: boolean },
): { text: string; addedColumns: number; updatedColumns: number; addedTables: number; droppedColumns: number } {
	if (!tables.length) return { text: existingMarkdown, addedColumns: 0, updatedColumns: 0, addedTables: 0, droppedColumns: 0 };
	const markDropped = options?.markDropped !== false;
	const eol = existingMarkdown.includes("\r\n") ? "\r\n" : "\n";
	const lines = existingMarkdown.split(/\r?\n/);
	let addedColumns = 0;
	let updatedColumns = 0;
	let addedTables = 0;
	let droppedColumns = 0;
	const esc = (s: string) => s.replace(/\|/g, "\\|");

	const getBodyStart = (): number => {
		if (lines[0]?.replace(/^\uFEFF/, "").trim() === "---") {
			const end = lines.findIndex((l, i) => i > 0 && /^(---|\.\.\.)\s*$/.test(l.trim()));
			if (end > 0) return end + 1;
		}
		return 0;
	};

	const findTableBlock = (tableName: string): { headLine: number; tableStart: number; tableEnd: number } | null => {
		const target = tableName.toLowerCase();
		const targetBare = target.includes(".") ? target.split(".").pop()! : target;
		const bodyStart = getBodyStart();
		let startSearch = bodyStart;
		let headLine = -1;
		let fence: FenceState = null;
		for (let i = bodyStart; i < lines.length; i++) {
			const nextFence = updateFenceState(lines[i]!, fence);
			if (nextFence !== fence) {
				fence = nextFence;
				continue;
			}
			if (fence) continue;
			const hm = parseSchemaHeading(lines[i]!);
			if (hm) {
				const hName = hm.text.toLowerCase();
				const hBare = hName.includes(".") ? hName.split(".").pop()! : hName;
				const tok = hm.tableToken.toLowerCase();
				const tokBare = tok.includes(".") ? tok.split(".").pop()! : tok;
				if (hName === target || hBare === target || hBare === targetBare || tok === target || tokBare === target || tokBare === targetBare) {
					headLine = i;
					startSearch = i + 1;
					break;
				}
			}
		}
		if (headLine < 0 && tables.length > 1) return null;
		fence = null;
		for (let i = startSearch; i < lines.length; i++) {
			const nextFence = updateFenceState(lines[i]!, fence);
			if (nextFence !== fence) {
				fence = nextFence;
				continue;
			}
			if (fence) continue;
			const trimmed = lines[i]!.trim();
			const hm = parseSchemaHeading(trimmed);
			if (headLine >= 0 && hm && !SCHEMA_SUBSECTION_RE.test(hm.text)) break;
			if (!trimmed.startsWith("|")) continue;
			const hdr = splitMarkdownRow(lines[i]!).map((c) => stripMarkdownCell(c).toLowerCase());
			if (isForeignKeysHeader(hdr) || isIndexesHeader(hdr)) continue;
			if (findColumnHeaderIndex(hdr) < 0) continue;
			if (i + 1 >= lines.length || !/^\s*\|?\s*:?-{2,}/.test(lines[i + 1]!)) continue;
			let end = i + 2;
			while (end < lines.length && lines[end]!.trim().startsWith("|")) end++;
			return { headLine, tableStart: i, tableEnd: end };
		}
		return null;
	};

	const findTableScopeEnd = (afterLine: number): number => {
		let fence: FenceState = null;
		for (let i = afterLine; i < lines.length; i++) {
			const nextFence = updateFenceState(lines[i]!, fence);
			if (nextFence !== fence) {
				fence = nextFence;
				continue;
			}
			if (fence) continue;
			const hm = /^#{1,2}\s+(.+)$/.exec(lines[i]!.trim());
			if (hm) {
				const headingText = hm[1]!.replace(/\s+#+\s*$/, "").replace(/^`|`$/g, "").trim();
				if (headingText && !SCHEMA_SUBSECTION_RE.test(headingText)) return i;
			}
		}
		return lines.length;
	};

	const findSubsectionTable = (
		fromLine: number,
		scopeEnd: number,
		headingRe: RegExp,
	): { headLine: number; tableStart: number; tableEnd: number } | null => {
		let subHead = -1;
		let fence: FenceState = null;
		for (let i = fromLine; i < scopeEnd; i++) {
			const nextFence = updateFenceState(lines[i]!, fence);
			if (nextFence !== fence) {
				fence = nextFence;
				continue;
			}
			if (fence) continue;
			const hm = /^#{2,3}\s+(.+?)\s*$/.exec(lines[i]!.trim());
			if (hm) {
				if (subHead >= 0) break;
				const headingText = hm[1]!.replace(/\s+#+\s*$/, "").replace(/^`|`$/g, "").trim();
				if (headingRe.test(headingText)) subHead = i;
				continue;
			}
			if (subHead >= 0 && lines[i]!.trim().startsWith("|")) {
				if (i + 1 < scopeEnd && /^\s*\|?\s*:?-{2,}/.test(lines[i + 1]!)) {
					let end = i + 2;
					while (end < scopeEnd && lines[end]!.trim().startsWith("|")) end++;
					return { headLine: subHead, tableStart: i, tableEnd: end };
				}
			}
		}
		return null;
	};

	const removeEmptySubsectionTable = (sub: { headLine: number; tableStart: number; tableEnd: number }, scopeEnd: number) => {
		const hasProseBetween = lines.slice(sub.headLine + 1, sub.tableStart).some((l) => l.trim() !== "");
		let hasProseAfter = false;
		let fence: FenceState = null;
		for (let k = sub.tableEnd; k < scopeEnd; k++) {
			const nf = updateFenceState(lines[k]!, fence);
			if (nf !== fence) {
				hasProseAfter = true;
				break;
			}
			if (!fence && /^#{1,3}\s+/.test(lines[k]!.trim())) break;
			if (lines[k]!.trim() !== "") {
				hasProseAfter = true;
				break;
			}
		}
		if (hasProseBetween || hasProseAfter) {
			// Preserve the heading and all hand-written prose (ADR 0002); remove only the stale table lines.
			let delStart = sub.tableStart;
			const delEnd = sub.tableEnd;
			if (delStart > sub.headLine + 1 && lines[delStart - 1]?.trim() === "" && (delEnd >= lines.length || lines[delEnd]?.trim() === "")) {
				delStart--;
			}
			lines.splice(delStart, delEnd - delStart);
		} else {
			const start = sub.headLine > 0 && lines[sub.headLine - 1]?.trim() === "" ? sub.headLine - 1 : sub.headLine;
			lines.splice(start, sub.tableEnd - start);
		}
	};

	for (const tbl of tables) {
		const block = findTableBlock(tbl.tableName);
		if (!block) {
			const rendered = sqlTablesToMarkdown([tbl], sourceLabel).trimEnd().split("\n");
			if (lines.length && lines[lines.length - 1]!.trim() !== "") lines.push("");
			lines.push(...rendered);
			addedTables++;
			addedColumns += tbl.columns.length;
			continue;
		}
		const hdr = splitMarkdownRow(lines[block.tableStart]!);
		const hdrLow = hdr.map((c) => stripMarkdownCell(c).toLowerCase());
		const colCount = hdr.length;
		const colIdx = Math.max(0, findColumnHeaderIndex(hdrLow));
		const typeIdx = hdrLow.findIndex((c, idx) => idx !== colIdx && c.includes("type"));
		const consIdx = hdrLow.findIndex(
			(c, idx) => idx !== colIdx && idx !== typeIdx && (c.includes("constraint") || c.includes("key") || c.includes("null")),
		);
		const noteIdx = hdrLow.findIndex(
			(c, idx) =>
				idx !== colIdx &&
				idx !== typeIdx &&
				idx !== consIdx &&
				(c.includes("note") || c.includes("desc") || c.includes("meaning") || c.includes("holds") || c.includes("what") || c.includes("purpose") || c.includes("comment")),
		);
		const isNullCol = consIdx >= 0 && hdrLow[consIdx]!.includes("null");
		const existingByCol = new Map<string, { cells: string[]; index: number }>();
		const dataLines = lines.slice(block.tableStart + 2, block.tableEnd);
		const existingOrder: string[] = [];
		dataLines.forEach((raw, idx) => {
			const cells = splitMarkdownRow(raw);
			const colKey = stripMarkdownCell(cells[colIdx] ?? "").toLowerCase();
			if (colKey) {
				existingByCol.set(colKey, { cells, index: idx });
				existingOrder.push(colKey);
			}
		});

		const nextRows: string[] = [];
		const seen = new Set<string>();
		for (const col of tbl.columns) {
			const key = col.name.toLowerCase();
			seen.add(key);
			const prev = existingByCol.get(key);
			const cells = prev ? prev.cells.slice(0, colCount) : new Array<string>(colCount).fill("");
			while (cells.length < colCount) cells.push("");
			const rawNote = noteIdx >= 0 ? (prev?.cells[noteIdx] ?? "") : "";
			const cleanedNote = rawNote.replace(/\s*\[deprecated\s*\/\s*dropped in sql\]/gi, "").trim();
			const note = cleanedNote || (col.comment ? esc(col.comment) : "");
			const newType = !col.type ? "—" : isNullCol ? esc(col.type.toLowerCase()) : `\`${esc(col.type)}\``;
			let newCons = "";
			if (consIdx >= 0) {
				if (isNullCol) {
					const maskedSqlCons = maskQuotedAndChecks(col.constraints);
					const isSqlPk = /\bPRIMARY\s+KEY\b/i.test(maskedSqlCons);
					const isSqlNotNull = isSqlPk || /\bNOT\s+NULL\b/i.test(maskedSqlCons);
					const prevConsRaw = (prev?.cells[consIdx] ?? "").trim();
					const prevConsHasPk = /\b(?:primary\s+key|pk)\b/i.test(prevConsRaw);
					const noteMentionsPk = noteIdx >= 0 && /\b(?:primary\s+key|pk)\b/i.test(note);
					if (isSqlPk) {
						newCons = prev && !prevConsHasPk && noteMentionsPk ? "no" : "PK";
					} else {
						newCons = isSqlNotNull ? "no" : "yes";
					}
				} else {
					newCons = esc(col.constraints || "—");
				}
			}

			cells[colIdx] = `\`${esc(col.name)}\``;
			if (typeIdx >= 0) cells[typeIdx] = newType;
			if (consIdx >= 0) cells[consIdx] = newCons;
			if (noteIdx >= 0) cells[noteIdx] = note;

			if (!prev) {
				addedColumns++;
			} else if (
				(typeIdx >= 0 && stripMarkdownCell(prev.cells[typeIdx] ?? "").toLowerCase() !== col.type.toLowerCase()) ||
				(consIdx >= 0 && (prev.cells[consIdx] ?? "").trim() !== newCons) ||
				(noteIdx >= 0 && rawNote.trim() !== note)
			) {
				updatedColumns++;
			}
			nextRows.push(`| ${cells.join(" | ")} |`);
		}
		for (const key of existingOrder) {
			if (!seen.has(key)) {
				const prev = existingByCol.get(key)!;
				const alreadyMarked = prev.cells.some((c) => DROPPED_NOTE_RE.test(c));
				if (!markDropped || alreadyMarked) {
					nextRows.push(dataLines[prev.index]!);
				} else {
					const cells = prev.cells.slice(0, colCount);
					while (cells.length < colCount) cells.push("");
					const targetNoteCol = noteIdx >= 0 ? noteIdx : colCount - 1;
					const curNote = cells[targetNoteCol]!.trim();
					cells[targetNoteCol] = curNote ? `${curNote} ${DROPPED_NOTE_TAG}` : DROPPED_NOTE_TAG;
					droppedColumns++;
					nextRows.push(`| ${cells.join(" | ")} |`);
				}
			}
		}
		lines.splice(block.tableStart + 2, block.tableEnd - (block.tableStart + 2), ...nextRows);
		const afterColsBase = block.tableStart + 2 + nextRows.length;

		// Merge or append `## Foreign keys` when SQL defines foreign keys or the doc already has a Foreign keys table.
		const scopeEndAfterCols = findTableScopeEnd(afterColsBase);
		const existingFkSub = findSubsectionTable(afterColsBase, scopeEndAfterCols, /^foreign\s+keys?$/i);
		if (tbl.foreignKeys?.length) {
			if (existingFkSub) {
				const fkHdr = splitMarkdownRow(lines[existingFkSub.tableStart]!).map((c) => stripMarkdownCell(c).toLowerCase());
				const fkColIdx = Math.max(0, fkHdr.findIndex((c) => c === "column" || c === "columns" || c === "local column" || c === "field"));
				const refTblIdx = fkHdr.findIndex(
					(c, idx) => idx !== fkColIdx && (c === "target table" || c === "referenced table" || c === "table" || c.includes("reference") || c.includes("target")),
				);
				const refColIdx = fkHdr.findIndex(
					(c, idx) => idx !== fkColIdx && idx !== refTblIdx && (c === "target column" || c === "referenced column" || c.includes("target col") || c.includes("ref col")),
				);
				const onDelIdx = fkHdr.findIndex((c, idx) => idx !== fkColIdx && idx !== refTblIdx && idx !== refColIdx && c.includes("delete"));
				const fkNoteCol = fkHdr.findIndex(
					(c, idx) => idx !== fkColIdx && idx !== refTblIdx && idx !== refColIdx && idx !== onDelIdx && (c.includes("note") || c.includes("desc") || c.includes("purpose")),
				);
				const oldFkRows = new Map<string, string[]>();
				for (const raw of lines.slice(existingFkSub.tableStart + 2, existingFkSub.tableEnd)) {
					const c = splitMarkdownRow(raw);
					const localPart = (c[fkColIdx] ?? "")
						.split(",")
						.map((p) => stripMarkdownCell(p).toLowerCase())
						.filter(Boolean)
						.join(",");
					const rawRefCell = refTblIdx >= 0 ? stripMarkdownCell(c[refTblIdx] ?? "") : "";
					const refTblOnly = rawRefCell.replace(/\s*\([^)]*\)\s*$/, "");
					const k = `${localPart}->${bareTableKey(refTblOnly)}`;
					if (localPart) oldFkRows.set(k, c);
				}
				const fkRows = tbl.foreignKeys.map((fk) => {
					const locals = fkLocalCols(fk);
					const refs = fkRefCols(fk);
					const refCols = refs.length ? refs : locals;
					const k = `${locals.map((c) => c.toLowerCase()).join(",")}->${bareTableKey(fk.refTable)}`;
					const prevRow = oldFkRows.get(k);
					const cells = prevRow ? prevRow.slice(0, fkHdr.length) : new Array<string>(fkHdr.length).fill("");
					while (cells.length < fkHdr.length) cells.push("");
					cells[fkColIdx] = formatMarkdownIndexCols(locals, esc);
					if (refColIdx >= 0) {
						if (refTblIdx >= 0) cells[refTblIdx] = `\`${esc(fk.refTable)}\``;
						cells[refColIdx] = formatMarkdownIndexCols(refCols, esc);
					} else if (refTblIdx >= 0) {
						cells[refTblIdx] = refs.length
							? `\`${esc(fk.refTable)}(${refs.map(esc).join(", ")})\``
							: `\`${esc(fk.refTable)}\``;
					}
					if (onDelIdx >= 0) {
						cells[onDelIdx] = fk.onDelete ? esc(fk.onDelete) : (prevRow?.[onDelIdx]?.trim() ?? "");
					}
					if (fkNoteCol >= 0) {
						const prevNote = prevRow?.[fkNoteCol]?.trim() ?? "";
						cells[fkNoteCol] = prevNote || (onDelIdx < 0 && fk.onDelete ? `ON DELETE ${esc(fk.onDelete)}` : "");
					}
					return `| ${cells.join(" | ")} |`;
				});
				lines.splice(existingFkSub.tableStart + 2, existingFkSub.tableEnd - (existingFkSub.tableStart + 2), ...fkRows);
			} else {
				const insertAt = findSubsectionTable(afterColsBase, scopeEndAfterCols, /^index(?:es)?$|^indices$/i)?.headLine ?? scopeEndAfterCols;
				const fkBlock = [
					...(insertAt > 0 && lines[insertAt - 1]?.trim() !== "" ? [""] : []),
					"## Foreign keys",
					"",
					"| Column | Target table | Target column | Notes |",
					"| --- | --- | --- | --- |",
					...tbl.foreignKeys.map((fk) => {
						const locals = fkLocalCols(fk);
						const refs = fkRefCols(fk);
						const refCols = refs.length ? refs : locals;
						const note = fk.onDelete ? `ON DELETE ${esc(fk.onDelete)}` : "";
						return `| ${formatMarkdownIndexCols(locals, esc)} | \`${esc(fk.refTable)}\` | ${formatMarkdownIndexCols(refCols, esc)} | ${note} |`;
					}),
					...(insertAt < lines.length && lines[insertAt]?.trim() !== "" ? [""] : []),
				];
				lines.splice(insertAt, 0, ...fkBlock);
			}
		} else if (existingFkSub) {
			removeEmptySubsectionTable(existingFkSub, scopeEndAfterCols);
		}

		// Merge or append `## Indexes` when SQL defines indexes or the doc already has an Indexes table.
		const scopeEndAfterFks = findTableScopeEnd(afterColsBase);
		const existingIdxSub = findSubsectionTable(afterColsBase, scopeEndAfterFks, /^index(?:es)?$|^indices$/i);
		if (tbl.indexes?.length) {
			if (existingIdxSub) {
				const ixHdr = splitMarkdownRow(lines[existingIdxSub.tableStart]!).map((c) => stripMarkdownCell(c).toLowerCase());
				const nameIdx = Math.max(0, ixHdr.findIndex((c) => c === "name" || c === "index" || c === "index name"));
				const colsIdx = ixHdr.findIndex((c, idx) => idx !== nameIdx && (c === "columns" || c === "column" || c === "fields"));
				const uniqIdx = ixHdr.findIndex((c, idx) => idx !== nameIdx && idx !== colsIdx && (c === "unique" || c === "uniqueness" || c === "kind"));
				const ixNoteCol = ixHdr.findIndex(
					(c, idx) => idx !== nameIdx && idx !== colsIdx && idx !== uniqIdx && (c.includes("purpose") || c.includes("note") || c.includes("desc")),
				);
				const oldIxRows = new Map<string, string[]>();
				for (const raw of lines.slice(existingIdxSub.tableStart + 2, existingIdxSub.tableEnd)) {
					const c = splitMarkdownRow(raw);
					const k = stripMarkdownCell(c[nameIdx] ?? "").toLowerCase();
					if (k) oldIxRows.set(k, c);
				}
				const ixRows = tbl.indexes.map((ix) => {
					const prevRow = oldIxRows.get(ix.name.toLowerCase());
					const cells = prevRow ? prevRow.slice(0, ixHdr.length) : new Array<string>(ixHdr.length).fill("");
					while (cells.length < ixHdr.length) cells.push("");
					cells[nameIdx] = `\`${esc(ix.name)}\``;
					if (colsIdx >= 0) cells[colsIdx] = formatMarkdownIndexCols(ix.columns, esc);
					if (uniqIdx >= 0) cells[uniqIdx] = ix.unique ? "yes" : "no";
					if (ixNoteCol >= 0) cells[ixNoteCol] = prevRow?.[ixNoteCol]?.trim() ?? "";
					return `| ${cells.join(" | ")} |`;
				});
				lines.splice(existingIdxSub.tableStart + 2, existingIdxSub.tableEnd - (existingIdxSub.tableStart + 2), ...ixRows);
			} else {
				const insertAt = scopeEndAfterFks;
				const ixBlock = [
					...(insertAt > 0 && lines[insertAt - 1]?.trim() !== "" ? [""] : []),
					"## Indexes",
					"",
					"| Name | Unique | Columns |",
					"| --- | --- | --- |",
					...tbl.indexes.map((ix) => `| \`${esc(ix.name)}\` | ${ix.unique ? "yes" : "no"} | ${formatMarkdownIndexCols(ix.columns, esc)} |`),
					...(insertAt < lines.length && lines[insertAt]?.trim() !== "" ? [""] : []),
				];
				lines.splice(insertAt, 0, ...ixBlock);
			}
		} else if (existingIdxSub) {
			removeEmptySubsectionTable(existingIdxSub, scopeEndAfterFks);
		}
	}
	return { text: lines.join(eol), addedColumns, updatedColumns, addedTables, droppedColumns };
}

type DocForeignKey = SqlForeignKeyDef;

type DocTableCols = {
	tableName: string;
	hasConstraintsCol: boolean;
	hasNullCol: boolean;
	hasForeignKeysSection: boolean;
	hasIndexesSection: boolean;
	columns: Map<string, { name: string; type: string; constraints: string; notes: string }>;
	foreignKeys: DocForeignKey[];
	indexes: SqlIndexDef[];
};

const COMMON_SQL_SCHEMAS = new Set([
	"dbo", "public", "sys", "lims", "starlims", "app", "core", "audit", "stg", "staging",
	"ref", "admin", "hr", "fin", "ops", "lab", "qa", "dev", "prod", "master", "tempdb", "model", "msdb",
]);

/** Splits a dotted FK reference (`dbo.CUSTOMERS` vs `ORDERS.ORDNO` vs `dbo.CUSTOMERS.ID`) without misparsing `schema.TABLE` as `table.col`. */
function parseDottedFkTarget(rawRef: string, hasDedicatedRefCol: boolean): { refTable: string; refColumn?: string } {
	const parts = rawRef.split(".").map((p) => cleanIdent(p)).filter(Boolean);
	if (parts.length <= 1 || hasDedicatedRefCol) {
		return { refTable: rawRef };
	}
	if (parts.length >= 3) {
		return { refTable: `${parts[parts.length - 3]}.${parts[parts.length - 2]}`, refColumn: parts[parts.length - 1] };
	}
	const [first, second] = [parts[0]!, parts[1]!];
	// Known SQL schema prefixes (`dbo.CUSTOMERS`, `public.USERS`) or lowercase.UPPERCASE (`myschema.ORDERS`) are schema.table, NOT table.column.
	if (COMMON_SQL_SCHEMAS.has(first.toLowerCase()) || (/^[a-z_][a-z0-9_]*$/.test(first) && /^[A-Z_][A-Z0-9_]*$/.test(second))) {
		return { refTable: rawRef };
	}
	return { refTable: first, refColumn: second };
}

function parseInlineDocFk(column: string, constraints: string): DocForeignKey | null {
	const text = unescPipe(constraints).replace(/`/g, "").trim();
	if (!text) return null;
	const refMatch =
		/(?:\bREFERENCES\s+|(?:\bFK\b|foreign\s+key)\s*(?:->|→|to)\s*)([A-Za-z_][\w$.]*)(?:\s*\(\s*([A-Za-z_][\w$]*)\s*\))?/i.exec(text);
	if (!refMatch) return null;
	let refTable = refMatch[1]!;
	let refColumn: string | undefined = refMatch[2];
	if (!refColumn && refTable.includes(".")) {
		const parsed = parseDottedFkTarget(refTable, false);
		refTable = parsed.refTable;
		refColumn = parsed.refColumn;
	}
	const onDel = /\bON\s+DELETE\s+(CASCADE|SET\s+NULL|SET\s+DEFAULT|RESTRICT|NO\s+ACTION)\b/i.exec(text)?.[1];
	return {
		column,
		refTable,
		...(refColumn ? { refColumn } : {}),
		...(onDel ? { onDelete: onDel.replace(/\s+/g, " ").toUpperCase() } : {}),
	};
}

function stripOuterBalancedParens(s: string): string {
	const t = s.trim();
	if (!t.startsWith("(") || !t.endsWith(")")) return t;
	const scanned = scanBalancedParens(t, 0);
	return scanned && scanned.end === t.length ? scanned.inner.trim() : t;
}

function parseMarkdownSchemaTables(schemaMd: string): DocTableCols[] {
	const lines = schemaMd.replace(/^\uFEFF/, "").split(/\r?\n/);
	let idx = 0;
	let fmTitle = "";
	if (lines[0]?.trim() === "---") {
		const end = lines.findIndex((l, i) => i > 0 && /^(---|\.\.\.)\s*$/.test(l.trim()));
		if (end > 0) {
			for (let j = 1; j < end; j++) {
				const tm = /^title\s*:\s*(.+)$/i.exec(lines[j]!.trim());
				if (tm) fmTitle = tm[1]!.trim().replace(/^["']|["']$/g, "");
			}
			idx = end + 1;
		}
	}
	const out: DocTableCols[] = [];
	let currentTable = fmTitle;
	let currentDoc: DocTableCols | null = null;
	let sectionKind: "columns" | "fks" | "indexes" | "other" = "columns";
	let fence: FenceState = null;
	const addDocFk = (target: DocTableCols, fk: DocForeignKey) => {
		const localKey = fkLocalCols(fk).map((c) => c.toLowerCase()).join(",");
		const refTblKey = bareTableKey(fk.refTable);
		const refCols = fkRefCols(fk);
		const refColKey = (refCols.length ? refCols : fkLocalCols(fk)).map((c) => c.toLowerCase()).join(",");
		const exists = target.foreignKeys.some((e) => {
			const eRefCols = fkRefCols(e);
			return (
				fkLocalCols(e).map((c) => c.toLowerCase()).join(",") === localKey &&
				bareTableKey(e.refTable) === refTblKey &&
				(eRefCols.length ? eRefCols : fkLocalCols(e)).map((c) => c.toLowerCase()).join(",") === refColKey
			);
		});
		if (!exists) target.foreignKeys.push(fk);
	};

	for (let i = idx; i < lines.length; i++) {
		const raw = lines[i]!;
		const nextFence = updateFenceState(raw, fence);
		if (nextFence !== fence) {
			fence = nextFence;
			continue;
		}
		if (fence) continue;
		const trimmed = raw.trim();
		const hm = parseSchemaHeading(trimmed);
		if (hm) {
			const hText = hm.text;
			if (/^foreign\s+keys?$/i.test(hText)) {
				sectionKind = "fks";
			} else if (/^index(?:es)?$|^indices$/i.test(hText)) {
				sectionKind = "indexes";
			} else if (/^columns?$|^fields?$/i.test(hText)) {
				sectionKind = "columns";
			} else if (SCHEMA_SUBSECTION_RE.test(hText)) {
				sectionKind = "other";
			} else {
				currentTable = hm.tableToken;
				currentDoc = null;
				sectionKind = "columns";
			}
			continue;
		}
		if (!trimmed.startsWith("|")) continue;
		if (i + 1 >= lines.length || !/^\s*\|?\s*:?-{2,}/.test(lines[i + 1]!)) continue;
		const hdr = splitMarkdownRow(raw).map((c) => stripMarkdownCell(c).toLowerCase());

		// Foreign keys table
		if (sectionKind === "fks" || isForeignKeysHeader(hdr)) {
			const target = currentDoc ?? out[out.length - 1];
			const fkColIdx = hdr.findIndex((c) => c === "column" || c === "columns" || c === "local column" || c === "field");
			const refTblIdx = hdr.findIndex((c) => c === "target table" || c === "referenced table" || c === "table" || c.includes("reference"));
			const refColIdx = hdr.findIndex((c) => c === "target column" || c === "referenced column");
			const onDelIdx = hdr.findIndex((c) => c.includes("delete"));
			const noteIdx = hdr.findIndex((c) => c.includes("note") || c.includes("desc") || c.includes("purpose"));
			i += 2;
			if (target && fkColIdx >= 0 && refTblIdx >= 0) {
				target.hasForeignKeysSection = true;
				for (; i < lines.length && lines[i]!.trim().startsWith("|"); i++) {
					const cells = splitMarkdownRow(lines[i]!);
					const rawLocalCell = unescPipe(cells[fkColIdx] ?? "").trim();
					const localCols = splitTopLevelCommas(rawLocalCell)
						.map((p) => stripMarkdownCell(p))
						.filter((p) => Boolean(p) && p !== "…");
					const rawRef = stripMarkdownCell(cells[refTblIdx] ?? "");
					if (!localCols.length || !rawRef) continue;
					let refTable = rawRef;
					const rawRefColCell = refColIdx >= 0 ? unescPipe(cells[refColIdx] ?? "").trim() : "";
					let refCols = rawRefColCell
						? splitTopLevelCommas(rawRefColCell)
								.map((p) => stripMarkdownCell(p))
								.filter((p) => Boolean(p) && p !== "…")
						: [];
					if (!refCols.length) {
						const paren = /^([A-Za-z_][\w$.]*)\s*\(([^)]+)\)$/.exec(rawRef);
						if (paren) {
							refTable = paren[1]!;
							refCols = splitTopLevelCommas(paren[2]!)
								.map((p) => stripMarkdownCell(p))
								.filter(Boolean);
						} else if (rawRef.includes(".")) {
							const parsed = parseDottedFkTarget(rawRef, refColIdx >= 0);
							refTable = parsed.refTable;
							if (parsed.refColumn) refCols = [parsed.refColumn];
						}
					}
					const rawDel = onDelIdx >= 0 ? stripMarkdownCell(cells[onDelIdx] ?? "") : "";
					const noteText = noteIdx >= 0 ? unescPipe(cells[noteIdx] ?? "") : "";
					const delMatch =
						/^(CASCADE|SET\s+NULL|SET\s+DEFAULT|RESTRICT|NO\s+ACTION)$/i.exec(rawDel) ??
						/\bON\s+DELETE\s+(CASCADE|SET\s+NULL|SET\s+DEFAULT|RESTRICT|NO\s+ACTION)\b/i.exec(noteText);
					const onDelete = delMatch ? delMatch[1]!.replace(/\s+/g, " ").toUpperCase() : undefined;
					if (localCols.length === 1) {
						addDocFk(target, {
							column: localCols[0]!,
							refTable,
							...(refCols[0] ? { refColumn: refCols[0] } : {}),
							...(onDelete ? { onDelete } : {}),
						});
					} else {
						addDocFk(target, {
							column: localCols.join(", "),
							columns: localCols,
							refTable,
							...(refCols.length ? { refColumn: refCols.join(", "), refColumns: refCols } : {}),
							...(onDelete ? { onDelete } : {}),
						});
					}
				}
			} else {
				while (i < lines.length && lines[i]!.trim().startsWith("|")) i++;
			}
			i--;
			continue;
		}

		// Indexes table
		if (sectionKind === "indexes" || isIndexesHeader(hdr)) {
			const target = currentDoc ?? out[out.length - 1];
			const nameIdx = hdr.findIndex((c) => c === "name" || c === "index" || c === "index name");
			const colsIdx = hdr.findIndex((c) => c === "columns" || c === "column" || c === "fields");
			const uniqIdx = hdr.findIndex((c) => c === "unique" || c === "uniqueness" || c === "kind");
			i += 2;
			if (target && nameIdx >= 0 && colsIdx >= 0) {
				target.hasIndexesSection = true;
				for (; i < lines.length && lines[i]!.trim().startsWith("|"); i++) {
					const cells = splitMarkdownRow(lines[i]!);
					const ixName = stripMarkdownCell(cells[nameIdx] ?? "");
					const rawCols = unescPipe(cells[colsIdx] ?? "").trim();
					if (!ixName || !rawCols || ixName === "…") continue;
					const cols = splitTopLevelCommas(rawCols)
						.map((p) =>
							stripOuterBalancedParens(stripMarkdownCell(p))
								.replace(/\s+(?:ASC|DESC|NULLS\s+(?:FIRST|LAST))$/i, "")
								.trim(),
						)
						.filter(Boolean);
					if (!cols.length) continue;
					const uniqRaw = uniqIdx >= 0 ? stripMarkdownCell(cells[uniqIdx] ?? "") : "";
					const unique = /^(?:yes|true|unique|y|1)$/i.test(uniqRaw);
					if (!target.indexes.some((e) => e.name.toLowerCase() === ixName.toLowerCase())) {
						target.indexes.push(unique ? { name: ixName, columns: cols, unique: true } : { name: ixName, columns: cols });
					}
				}
			} else {
				while (i < lines.length && lines[i]!.trim().startsWith("|")) i++;
			}
			i--;
			continue;
		}

		if (sectionKind !== "columns") {
			i += 2;
			while (i < lines.length && lines[i]!.trim().startsWith("|")) i++;
			i--;
			continue;
		}

		const colIdx = findColumnHeaderIndex(hdr);
		if (colIdx < 0) {
			i += 2;
			while (i < lines.length && lines[i]!.trim().startsWith("|")) i++;
			i--;
			continue;
		}
		const typeIdx = hdr.findIndex((c, ci) => ci !== colIdx && c.includes("type"));
		const consIdx = hdr.findIndex((c, ci) => ci !== colIdx && ci !== typeIdx && (c.includes("constraint") || c.includes("key") || c.includes("null")));
		const noteIdx = hdr.findIndex(
			(c, ci) =>
				ci !== colIdx &&
				ci !== typeIdx &&
				ci !== consIdx &&
				(c.includes("note") || c.includes("desc") || c.includes("meaning") || c.includes("holds") || c.includes("what")),
		);
		const hasNullCol = consIdx >= 0 && hdr[consIdx]!.includes("null");
		const hasConstraintsCol = consIdx >= 0 && !hasNullCol;
		const cols = new Map<string, { name: string; type: string; constraints: string; notes: string }>();
		const docEntry: DocTableCols = {
			tableName: currentTable,
			hasConstraintsCol,
			hasNullCol,
			hasForeignKeysSection: false,
			hasIndexesSection: false,
			columns: cols,
			foreignKeys: [],
			indexes: [],
		};
		i += 2;
		for (; i < lines.length && lines[i]!.trim().startsWith("|"); i++) {
			const cells = splitMarkdownRow(lines[i]!);
			const colName = stripMarkdownCell(cells[colIdx] ?? "");
			if (!colName || colName === "…" || colName.startsWith("(")) continue;
			const notes = noteIdx >= 0 ? unescPipe(cells[noteIdx] ?? "").trim() : "";
			const constraints = consIdx >= 0 ? unescPipe(cells[consIdx] ?? "").trim() : "";
			// Already-acknowledged dropped columns no longer masquerade as live schema drift.
			if (DROPPED_NOTE_RE.test(notes) || DROPPED_NOTE_RE.test(constraints)) continue;
			const rawType = typeIdx >= 0 ? stripMarkdownCell(cells[typeIdx] ?? "") : "";
			cols.set(colName.toLowerCase(), {
				name: colName,
				type: rawType === "—" || rawType === "-" ? "" : rawType,
				constraints,
				notes,
			});
			const inlineFk = parseInlineDocFk(colName, constraints);
			if (inlineFk) addDocFk(docEntry, inlineFk);
		}
		i--;
		out.push(docEntry);
		currentDoc = docEntry;
	}
	return out;
}

const normalizeSqlType = (t: string) =>
	t
		.replace(/`/g, "")
		.trim()
		.toLowerCase()
		.replace(/\s*\(\s*/g, "(")
		.replace(/\s*\)/g, ")")
		.replace(/\s*,\s*/g, ",")
		.replace(/\s+/g, " ")
		.replace(/^national char(?:acter)? varying\b/, "nvarchar")
		.replace(/^national character\b/, "nchar")
		.replace(/^char(?:acter)? varying\b/, "varchar")
		.replace(/^timestamp(\([^)]*\))? with local time zone$/, "timestampltz$1")
		.replace(/^timestamp(\([^)]*\))? with time zone$/, "timestamptz$1")
		.replace(/^timestamp(\([^)]*\))? without time zone$/, "timestamp$1")
		.replace(/^time(\([^)]*\))? with time zone$/, "timetz$1")
		.replace(/^time(\([^)]*\))? without time zone$/, "time$1")
		.replace(/^interval year(?:\([^)]*\))? to month$/, "interval ym")
		.replace(/^interval day(?:\([^)]*\))? to second(?:\([^)]*\))?$/, "interval ds");

/** Replaces top-level commas (outside parentheses and single-quoted literals) with spaces. */
function replaceTopLevelCommasWithSpace(text: string): string {
	let out = "";
	let depth = 0;
	let inSingle = false;
	for (let i = 0; i < text.length; i++) {
		const ch = text[i]!;
		if (inSingle) {
			out += ch;
			if (ch === "'") {
				if (text[i + 1] === "'") out += text[++i]!;
				else inSingle = false;
			}
			continue;
		}
		if (ch === "'") {
			inSingle = true;
			out += ch;
			continue;
		}
		if (ch === "(") depth++;
		else if (ch === ")" && depth > 0) depth--;
		else if (ch === "," && depth === 0) {
			out += " ";
			continue;
		}
		out += ch;
	}
	return out.replace(/\s+/g, " ").trim();
}

/**
 * Filters a multi-table SQL DDL list down to the specific table(s) already documented
 * in `existingMarkdown`, preventing a shared `.sql` script from dumping unrelated
 * tables into a single-table Markdown schema doc.
 */
export function filterSqlTablesForMarkdown(tables: readonly SqlTableDef[], existingMarkdown: string): SqlTableDef[] {
	if (tables.length <= 1) return [...tables];
	const docTables = parseMarkdownSchemaTables(existingMarkdown);
	if (!docTables.length) return [...tables];
	const docNames = new Set<string>();
	for (const d of docTables) {
		const n = d.tableName.trim().toLowerCase();
		if (!n) continue;
		docNames.add(n);
		if (n.includes(".")) docNames.add(n.split(".").pop()!);
	}
	const matched = tables.filter((t) => {
		const full = t.tableName.trim().toLowerCase();
		const bare = full.includes(".") ? full.split(".").pop()! : full;
		return docNames.has(full) || docNames.has(bare);
	});
	return matched.length ? matched : [...tables];
}

/**
 * Generates clean, formatted `CREATE TABLE` (+ composite/single `PRIMARY KEY`, `FOREIGN KEY` constraints,
 * and `CREATE [UNIQUE ]INDEX`) SQL DDL directly from a Markdown schema document's column, foreign-key,
 * and index tables. Output round-trips cleanly against `diffSqlAgainstSchemaMarkdown()` with zero drift.
 */
export function schemaMarkdownToSql(
	schemaMd: string,
	options?: { sourceNote?: string; fallbackTableName?: string },
): { sql: string; tables: string[] } | null {
	const docTables = parseMarkdownSchemaTables(schemaMd).filter((t) => t.columns.size > 0);
	if (!docTables.length) return null;

	const formatType = (raw: string): string => {
		const clean = raw.replace(/`/g, "").trim();
		if (!clean) return "VARCHAR(255)";
		return clean.replace(/[a-zA-Z_]+/g, (word) => word.toUpperCase());
	};

	const formatConstraints = (
		docTbl: DocTableCols,
		col: { name: string; type: string; constraints: string; notes: string },
	): string => {
		if (docTbl.hasNullCol) {
			const notNull = /^(?:no|false|not\s*null|nn|pk|primary\s*key)$/i.test(col.constraints);
			const isPk = /\b(?:primary\s+key|pk)\b/i.test(col.constraints) || /\b(?:primary\s+key|pk)\b/i.test(col.notes);
			const isUnique = /\bunique\b/i.test(col.constraints) || /\bunique\b/i.test(col.notes);
			return [notNull || isPk ? "NOT NULL" : "", isPk ? "PRIMARY KEY" : "", !isPk && isUnique ? "UNIQUE" : ""]
				.filter(Boolean)
				.join(" ");
		}
		if (docTbl.hasConstraintsCol) {
			const raw = col.constraints.replace(/`/g, "").trim();
			if (!raw || raw === "—" || raw === "-" || /^null$/i.test(raw)) return "";
			// Strip shorthand `FK -> ...` / `foreign key to ...` phrases (emitted as table-level constraints).
			const withoutFkPhrase = raw.replace(
				/(?:^|[,;]\s*|\s+)(?:FK|foreign\s+key)\s*(?:->|→|to)\s*[A-Za-z_][\w$.]*(?:\s*\([^)]*\))?(?:\s+ON\s+DELETE\s+(?:CASCADE|SET\s+NULL|SET\s+DEFAULT|RESTRICT|NO\s+ACTION))?/gi,
				" ",
			);
			const expanded = withoutFkPhrase
				.replace(/\bpk\b/gi, "PRIMARY KEY")
				.replace(/\bnn\b/gi, "NOT NULL");
			return replaceTopLevelCommasWithSpace(expanded);
		}
		return /\bprimary\s+key\b/i.test(col.notes) ? "NOT NULL PRIMARY KEY" : "";
	};

	const blocks: string[] = [];
	const tableNames: string[] = [];
	for (const docTbl of docTables) {
		const rawName = (docTbl.tableName || options?.fallbackTableName || "").trim();
		// Letters of any script stay, as in `IDENT_PART`: `Prüfung` was written as `Prfung`, under a foreign key that still named `Prüfung`.
		const tableName = rawName.replace(/\s+/g, "_").replace(/[^\p{L}\p{M}\p{Nd}_.$]/gu, "");
		if (!tableName) continue;
		tableNames.push(tableName);
		const rows = [...docTbl.columns.values()].map((col) => ({
			name: col.name,
			type: formatType(col.type),
			constraints: formatConstraints(docTbl, col),
		}));

		// Composite primary key: when > 1 columns carry PRIMARY KEY, strip inline PRIMARY KEY and emit one table-level PK constraint.
		const pkCols = rows.filter((r) => /\bPRIMARY\s+KEY\b/i.test(maskQuotedAndChecks(r.constraints))).map((r) => r.name);
		const pkLines: string[] = [];
		if (pkCols.length > 1) {
			for (const r of rows) {
				if (/\bPRIMARY\s+KEY\b/i.test(maskQuotedAndChecks(r.constraints))) {
					r.constraints = stripOutsideQuotes(r.constraints, /\bPRIMARY\s+KEY\b/gi);
				}
			}
			const pkName = `PK_${tableName}`.replace(/[^A-Za-z0-9_]/g, "_");
			pkLines.push(`    CONSTRAINT ${pkName} PRIMARY KEY (${pkCols.join(", ")})`);
		}

		const maxName = Math.max(...rows.map((r) => r.name.length));
		const maxType = Math.max(...rows.map((r) => r.type.length));
		// Skip table-level FK clause if the column already carries an inline `REFERENCES ...` constraint.
		const inlineFkCols = new Set(
			rows.filter((r) => /\bREFERENCES\b/i.test(maskSingleQuoted(r.constraints))).map((r) => r.name.toLowerCase()),
		);
		const fkLines = docTbl.foreignKeys
			.filter((fk) => {
				const locals = fkLocalCols(fk);
				return !(locals.length === 1 && inlineFkCols.has(locals[0]!.toLowerCase()));
			})
			.map((fk) => {
				const locals = fkLocalCols(fk);
				const refs = fkRefCols(fk);
				const fkName = `FK_${tableName}_${locals.join("_")}`.replace(/[^A-Za-z0-9_]/g, "_");
				const target = refs.length ? `${fk.refTable} (${refs.join(", ")})` : fk.refTable;
				const onDel = fk.onDelete ? ` ON DELETE ${fk.onDelete}` : "";
				return `    CONSTRAINT ${fkName} FOREIGN KEY (${locals.join(", ")}) REFERENCES ${target}${onDel}`;
			});
		const bodyLines = [
			...rows.map((r) =>
				r.constraints
					? `    ${r.name.padEnd(maxName)} ${r.type.padEnd(maxType)} ${r.constraints}`
					: `    ${r.name.padEnd(maxName)} ${r.type}`,
			),
			...pkLines,
			...fkLines,
		].map((line, idx, all) => (idx < all.length - 1 ? `${line},` : line));
		let stmt = `CREATE TABLE ${tableName} (\n${bodyLines.join("\n")}\n);`;
		if (docTbl.indexes.length) {
			const ixLines = docTbl.indexes.map(
				(ix) => `CREATE ${ix.unique ? "UNIQUE " : ""}INDEX ${ix.name} ON ${tableName} (${ix.columns.join(", ")});`,
			);
			stmt += `\n\n${ixLines.join("\n")}`;
		}
		blocks.push(stmt);
	}
	if (!blocks.length) return null;
	const header = options?.sourceNote ? `-- Generated from ${options.sourceNote}\n\n` : "";
	return { sql: `${header}${blocks.join("\n\n")}\n`, tables: tableNames };
}

/**
 * Compares effective SQL DDL columns (plus foreign keys and indexes when documented)
 * against documented Markdown schema tables, returning tables with any drift.
 * When a Markdown doc documents specific table(s) that match a subset of a shared multi-table `.sql`
 * file, only those matching tables are compared (preventing false drift for unrelated tables).
 */
export function diffSqlAgainstSchemaMarkdown(sqlText: string, schemaMd: string): SqlSchemaDrift[] {
	const sqlTables = parseCreateTables(sqlText, { includeStandaloneAlter: true });
	if (!sqlTables.length) return [];
	const docTables = parseMarkdownSchemaTables(schemaMd);
	const out: SqlSchemaDrift[] = [];

	const findDocTable = (tableName: string): DocTableCols | undefined => {
		const target = tableName.toLowerCase();
		const exact = docTables.find((d) => {
			const n = d.tableName.toLowerCase();
			const bare = n.includes(".") ? n.split(".").pop()! : n;
			return n === target || bare === target;
		});
		if (exact) return exact;
		if (sqlTables.length === 1 && docTables.length === 1) return docTables[0];
		return undefined;
	};

	const matchedAnyDocTable = docTables.length > 0 && sqlTables.some((sqlTbl) => Boolean(findDocTable(sqlTbl.tableName)));
	const fkKey = (fk: SqlForeignKeyDef) => {
		const locals = fkLocalCols(fk).map((c) => c.toLowerCase());
		const refs = fkRefCols(fk).map((c) => c.toLowerCase());
		const effectiveRefs = refs.length ? refs : locals;
		return `${locals.join(",")}->${bareTableKey(fk.refTable)}(${effectiveRefs.join(",")})`;
	};

	for (const sqlTbl of sqlTables) {
		const docTbl = findDocTable(sqlTbl.tableName);
		if (!docTbl) {
			if (matchedAnyDocTable) continue;
			if (sqlTbl.columns.length) {
				out.push({
					table: sqlTbl.tableName,
					added: sqlTbl.columns.map((c) => c.name),
					modified: [],
					dropped: [],
				});
			}
			continue;
		}
		const added: string[] = [];
		const modified: string[] = [];
		const dropped: string[] = [];
		const sqlByKey = new Map<string, SqlColumnDef>();
		for (const col of sqlTbl.columns) {
			const key = col.name.toLowerCase();
			sqlByKey.set(key, col);
			const docCol = docTbl.columns.get(key);
			if (!docCol) {
				added.push(col.name);
				continue;
			}
			const normSqlType = normalizeSqlType(col.type);
			const normDocType = normalizeSqlType(docCol.type);
			const typeChanged =
				Boolean(normDocType) &&
				normSqlType !== normDocType &&
				!(normDocType.endsWith("…") && normSqlType.startsWith(normDocType.slice(0, -1)));
			let nullChanged = false;
			let pkChanged = false;
			if (docTbl.hasConstraintsCol || docTbl.hasNullCol) {
				const sqlConsMasked = maskQuotedAndChecks(col.constraints);
				const docConsMasked = maskQuotedAndChecks(docCol.constraints);
				const sqlIsPk = /\bPRIMARY\s+KEY\b/i.test(sqlConsMasked);
				const sqlNotNull = sqlIsPk || /\bNOT\s+NULL\b/i.test(sqlConsMasked);
				const docIsPk = docTbl.hasNullCol
					? /\b(?:primary\s+key|pk)\b/i.test(docConsMasked) || /\b(?:primary\s+key|pk)\b/i.test(docCol.notes)
					: /\b(?:primary\s+key|pk)\b/i.test(docConsMasked);
				const docNotNull = docTbl.hasNullCol
					? /^(?:no|false|not\s*null|nn|pk|primary\s*key)$/i.test(docConsMasked.trim()) || docIsPk
					: /\b(?:not\s+null|nn|primary\s+key|pk)\b/i.test(docConsMasked);
				nullChanged = sqlNotNull !== docNotNull;
				pkChanged = sqlIsPk !== docIsPk;
			}
			if (typeChanged || nullChanged || pkChanged) {
				modified.push(col.name);
			}
		}
		for (const [key, docCol] of docTbl.columns) {
			if (!sqlByKey.has(key)) dropped.push(docCol.name);
		}
		if (docTbl.hasForeignKeysSection || docTbl.foreignKeys.length > 0) {
			const sqlFks = new Map((sqlTbl.foreignKeys ?? []).map((fk) => [fkKey(fk), fk]));
			const docFks = new Map(docTbl.foreignKeys.map((fk) => [fkKey(fk), fk]));
			for (const [k, fk] of sqlFks) {
				if (!docFks.has(k)) added.push(`FK: ${fkLocalCols(fk).join(", ")} -> ${fk.refTable}`);
			}
			for (const [k, fk] of docFks) {
				if (!sqlFks.has(k)) dropped.push(`FK: ${fkLocalCols(fk).join(", ")} -> ${fk.refTable}`);
			}
		}
		if (docTbl.hasIndexesSection || docTbl.indexes.length > 0) {
			const sqlIdx = new Map((sqlTbl.indexes ?? []).map((ix) => [ix.name.toLowerCase(), ix]));
			const docIdx = new Map(docTbl.indexes.map((ix) => [ix.name.toLowerCase(), ix]));
			for (const [k, ix] of sqlIdx) {
				const d = docIdx.get(k);
				if (!d) {
					added.push(`INDEX: ${ix.name}`);
				} else if (
					Boolean(ix.unique) !== Boolean(d.unique) ||
					ix.columns.map((c) => c.toLowerCase()).join(",") !== d.columns.map((c) => c.toLowerCase()).join(",")
				) {
					modified.push(`INDEX: ${ix.name}`);
				}
			}
			for (const [k, ix] of docIdx) {
				if (!sqlIdx.has(k)) dropped.push(`INDEX: ${ix.name}`);
			}
		}
		if (added.length || modified.length || dropped.length) {
			out.push({ table: sqlTbl.tableName, added, modified, dropped });
		}
	}
	return out;
}

const SQL_QUERY_KEYWORDS = new Set([
	"select", "from", "where", "join", "inner", "left", "right", "full", "outer", "cross", "natural",
	"on", "using", "into", "update", "delete", "insert", "merge", "values", "set", "as", "and", "or",
	"not", "null", "true", "false", "is", "in", "exists", "between", "like", "case", "when", "then",
	"else", "end", "group", "order", "by", "having", "union", "intersect", "except", "all", "distinct",
	"top", "limit", "offset", "fetch", "next", "rows", "only", "with", "recursive", "lateral", "table",
	"unnest", "openjson", "openxml", "openquery", "openrowset", "xmltable", "json_table", "generate_series",
	"create", "alter", "drop", "exec", "execute", "declare", "begin", "commit", "rollback", "return",
	"if", "while", "try", "catch", "output", "default", "current", "timestamp", "date", "time",
	"year", "month", "day", "hour", "minute", "second", "both", "leading", "trailing", "dual",
	"inserted", "deleted", "of", "statistics",
]);

const SYSTEM_SCHEMAS = new Set(["sys", "information_schema", "pg_catalog", "mysql", "performance_schema"]);

const looksLikeSqlStatement = (s: string) =>
	(/\b(?:SELECT|INSERT|UPDATE|DELETE|MERGE)\b/i.test(s) && /\b(?:FROM|SET|INTO|VALUES|USING)\b/i.test(s)) ||
	/\bDELETE\s+(?:TOP\s*\([^)]*\)\s*(?:PERCENT\s+)?)?(?:[A-Za-z_[\]"`][\w$#.[\]"`]*)\s+WHERE\b/i.test(s);

/**
 * Strips SQL comments (`-- ...`, nested `/* ... *\/`) and SSL comments (`// ...`, unclosed `/* ... ;`)
 * while optionally masking both `'...'` and `"..."` string contents so SSL vs SQL classification
 * never trips over comments or string literals.
 */
function stripCommentsForModeDetect(text: string, maskAllStrings: boolean): string {
	let out = "";
	let i = 0;
	const n = text.length;
	const lastBlockClose = text.lastIndexOf("*/");
	while (i < n) {
		const ch = text[i]!;
		const next = text[i + 1];
		const qOpen = matchOracleQQuote(text, i);
		if (qOpen) {
			const closePos = text.indexOf(`${qOpen.closeDelim}'`, qOpen.bodyStart);
			const endPos = closePos >= 0 ? closePos + 2 : n;
			if (!maskAllStrings) {
				out += text.slice(i, endPos);
			} else {
				for (let k = i; k < endPos; k++) out += text[k] === "\n" ? "\n" : " ";
			}
			i = endPos;
			continue;
		}
		const dollarTag = matchPgDollarTag(text, i);
		if (dollarTag) {
			const closePos = text.indexOf(dollarTag, i + dollarTag.length);
			const endPos = closePos >= 0 ? closePos + dollarTag.length : n;
			if (!maskAllStrings) {
				out += text.slice(i, endPos);
			} else {
				for (let k = i; k < endPos; k++) out += text[k] === "\n" ? "\n" : " ";
			}
			i = endPos;
			continue;
		}
		if (ch === "'" || ch === '"') {
			const q = ch;
			out += maskAllStrings ? " " : ch;
			i++;
			while (i < n) {
				if (text[i] === "\\" && q === '"' && i + 1 < n) {
					out += maskAllStrings ? (text[i + 1] === "\n" ? "\n" : "  ") : text.slice(i, i + 2);
					i += 2;
					continue;
				}
				if (text[i] === q) {
					if (text[i + 1] === q && q === "'") {
						out += maskAllStrings ? "  " : "''";
						i += 2;
						continue;
					}
					out += maskAllStrings ? " " : q;
					i++;
					break;
				}
				out += maskAllStrings ? (text[i] === "\n" ? "\n" : " ") : text[i]!;
				i++;
			}
			continue;
		}
		if (ch === "-" && next === "-") {
			while (i < n && text[i] !== "\n") i++;
			continue;
		}
		if (ch === "/" && next === "/") {
			while (i < n && text[i] !== "\n") i++;
			continue;
		}
		if (ch === "/" && next === "*") {
			// Check whether this is a standard closed SQL block comment `/* ... */` or an SSL `/* ... ;` comment.
			if (lastBlockClose < i + 2) {
				let k = i + 2;
				while (k < n && text[k] !== ";") {
					if (text[k] === "\n") out += "\n";
					k++;
				}
				if (k < n) k++;
				out += " ";
				i = k;
				continue;
			}
			let j = i + 2;
			let depth = 1;
			let sslSemiEnd = -1;
			while (j < n && depth > 0) {
				if (text[j] === "/" && text[j + 1] === "*") {
					depth++;
					j += 2;
					continue;
				}
				if (text[j] === "*" && text[j + 1] === "/") {
					depth--;
					j += 2;
					continue;
				}
				if (depth === 1 && text[j] === ";" && sslSemiEnd < 0) {
					// If `;` sits at EOL followed by a new SSL directive (`:`) or another `/*`, treat as SSL `/* ... ;`.
					const tailLine = text.slice(j + 1, j + 48);
					if (/^[ \t]*\r?\n[ \t]*(?:\/\*|:[A-Za-z])/.test(tailLine)) {
						sslSemiEnd = j + 1;
						break;
					}
				}
				j++;
			}
			if (depth === 0 && sslSemiEnd < 0) {
				for (let k = i; k < j; k++) if (text[k] === "\n") out += "\n";
				out += " ";
				i = j;
			} else {
				// Unclosed `/*` (no `*/` before EOF) or SSL banner `;` -> close at first `;`.
				const endPos = sslSemiEnd >= 0 ? sslSemiEnd : (() => {
					let k = i + 2;
					while (k < n && text[k] !== ";") k++;
					return k < n ? k + 1 : n;
				})();
				for (let k = i; k < endPos; k++) if (text[k] === "\n") out += "\n";
				out += " ";
				i = endPos;
			}
			continue;
		}
		out += ch;
		i++;
	}
	return out;
}

/** Strips SSL comments (`/* ... ;`, `/* ... *\/`, `// ...`) from a short gap slice between string literals. */
function stripSslComments(gap: string): string {
	let out = "";
	let i = 0;
	const n = gap.length;
	while (i < n) {
		if (gap[i] === "/" && gap[i + 1] === "*") {
			i += 2;
			while (i < n) {
				if (gap[i] === "*" && gap[i + 1] === "/") {
					i += 2;
					break;
				}
				if (gap[i] === ";") {
					i++;
					break;
				}
				i++;
			}
			out += " ";
			continue;
		}
		if (gap[i] === "/" && gap[i + 1] === "/") {
			while (i < n && gap[i] !== "\n") i++;
			continue;
		}
		out += gap[i++];
	}
	return out;
}

/** Returns true when `rawGap` is an SSL string concatenation bridge (`+`, `+ CRLF +`, `+ Chr(13) + Chr(10) +`, `+ sVar +`). */
function isSslConcatBridge(rawGap: string): boolean {
	const g = rawGap.trim();
	if (!g.startsWith("+") || !g.endsWith("+")) return false;
	if (g.length === 1) return true;
	if (g.length > 240 || /[;{}]/.test(g)) return false;
	if (/(?:^|\s):[A-Za-z]/.test(g)) return false;
	let depth = 0;
	for (const ch of g) {
		if (ch === "(" || ch === "[") depth++;
		else if (ch === ")" || ch === "]") {
			depth--;
			if (depth < 0) return false;
		}
	}
	return depth === 0;
}

/**
 * Extracts SQL string literals embedded inside STARLIMS SSL `.ds` files while preserving exact
 * character offsets and line numbers. Bridges `+ CRLF +` / `+ Chr(13) +` / `+ var +` string concatenation,
 * balances/neutralizes unclosed single quotes or block comments per literal group so one query can never
 * swallow subsequent queries, and masks out non-SQL English log/error strings.
 */
function extractSslEmbeddedSql(text: string): string {
	type SslLit = { start: number; end: number; contentStart: number; contentEnd: number; content: string };
	const lits: SslLit[] = [];
	const n = text.length;
	let i = 0;
	while (i < n) {
		const ch = text[i]!;
		const next = text[i + 1];
		// SSL comment `/* ... ;` (or `/* ... */` whichever terminates first).
		if (ch === "/" && next === "*") {
			i += 2;
			while (i < n) {
				if (text[i] === "*" && text[i + 1] === "/") {
					i += 2;
					break;
				}
				if (text[i] === ";") {
					i++;
					break;
				}
				i++;
			}
			continue;
		}
		if (ch === "/" && next === "/") {
			while (i < n && text[i] !== "\n") i++;
			continue;
		}
		if (ch === '"' || ch === "'") {
			const q = ch;
			const start = i;
			const contentStart = i + 1;
			let content = "";
			i++;
			while (i < n && text[i] !== q) {
				if (text[i] === "\\" && i + 1 < n) {
					content += text[i + 1] === "\n" ? "\n" : "  ";
					i += 2;
					continue;
				}
				content += text[i]!;
				i++;
			}
			const contentEnd = i;
			if (i < n) i++;
			lits.push({ start, end: i, contentStart, contentEnd, content });
			continue;
		}
		i++;
	}

	// Group string literals connected via `+` (including `+ CRLF +`, `+ Chr(13) +`, `+ var +`) or `<var> +=` / `<var> := <var> +`.
	const groups: SslLit[][] = [];
	let curGroup: SslLit[] = [];
	let curVar = "";
	const leadingAssignVar = (startPos: number): string => {
		const before = stripSslComments(text.slice(Math.max(0, startPos - 80), startPos));
		const m = /\b([A-Za-z_]\w*)\s*:=\s*$/.exec(before);
		return m ? m[1]!.toLowerCase() : "";
	};
	for (const lit of lits) {
		if (!curGroup.length) {
			curGroup = [lit];
			curVar = leadingAssignVar(lit.start);
			continue;
		}
		const prev = curGroup[curGroup.length - 1]!;
		const gap = stripSslComments(text.slice(prev.end, lit.start));
		const isPlusConcat = isSslConcatBridge(gap);
		const appendMatch = curVar
			? /^\s*;\s*([A-Za-z_]\w*)\s*(?:\+=|:=\s*\1\s*\+)\s*([\s\S]*)$/i.exec(gap)
			: null;
		const appendTail = appendMatch ? appendMatch[2]!.trim() : "";
		const isSameVarAppend = Boolean(
			appendMatch &&
				appendMatch[1]!.toLowerCase() === curVar &&
				(!appendTail || isSslConcatBridge(`+${appendTail}`)),
		);
		if (isPlusConcat || isSameVarAppend) {
			curGroup.push(lit);
		} else {
			groups.push(curGroup);
			curGroup = [lit];
			curVar = leadingAssignVar(lit.start);
		}
	}
	if (curGroup.length) groups.push(curGroup);

	// Build a length-preserving, line-preserving output buffer containing only SQL-looking literal groups.
	const chars: string[] = new Array(n);
	for (let k = 0; k < n; k++) chars[k] = text[k] === "\n" ? "\n" : " ";
	for (const group of groups) {
		const combined = group.map((g) => g.content).join(" ");
		if (!looksLikeSqlStatement(combined)) continue;
		const groupStart = group[0]!.contentStart;
		const groupEnd = group[group.length - 1]!.contentEnd;
		for (const lit of group) {
			for (let k = 0; k < lit.content.length && lit.contentStart + k < n; k++) {
				chars[lit.contentStart + k] = lit.content[k]!;
			}
		}
		// Neutralize any unclosed single quote or unclosed `/*` within this group so it cannot swallow later queries.
		let inSingle = false;
		let openSinglePos = -1;
		let blockDepth = 0;
		const openBlockPositions: number[] = [];
		for (let p = groupStart; p < groupEnd && p < n; p++) {
			const c = chars[p]!;
			if (blockDepth > 0) {
				if (c === "/" && chars[p + 1] === "*") {
					blockDepth++;
					openBlockPositions.push(p);
					p++;
				} else if (c === "*" && chars[p + 1] === "/") {
					blockDepth--;
					openBlockPositions.pop();
					p++;
				}
				continue;
			}
			if (inSingle) {
				if (c === "'") {
					if (p + 1 < groupEnd && chars[p + 1] === "'") {
						p++;
					} else {
						inSingle = false;
						openSinglePos = -1;
					}
				}
				continue;
			}
			if (c === "'") {
				inSingle = true;
				openSinglePos = p;
			} else if (c === "/" && chars[p + 1] === "*") {
				blockDepth = 1;
				openBlockPositions.push(p);
				p++;
			}
		}
		if (inSingle && openSinglePos >= 0) {
			chars[openSinglePos] = " ";
		}
		for (const bp of openBlockPositions) {
			if (bp >= 0 && bp < n && chars[bp] !== "\n") chars[bp] = " ";
		}
		const lastLit = group[group.length - 1]!;
		const lastEnd = lastLit.end - 1;
		if (lastEnd >= lastLit.contentEnd && lastEnd < n && chars[lastEnd] !== "\n") {
			chars[lastEnd] = ";";
		}
	}
	return chars.join("");
}

/** Collects CTE names declared via `WITH [RECURSIVE] cte1 AS (...), cte2 AS (...)`. */
function extractCteNames(cleanedSql: string): Set<string> {
	const ctes = new Set<string>();
	const withRe = /\bWITH\s+(?:RECURSIVE\s+)?/gi;
	const cteItemRe = new RegExp(`^\\s*(${IDENT_PART})\\s*(?:\\([^)]*\\)\\s*)?AS\\s*(?:(?:NOT\\s+)?MATERIALIZED\\s+)?\\(`, "iu");
	for (const m of cleanedSql.matchAll(withRe)) {
		let pos = (m.index ?? 0) + m[0].length;
		while (pos < cleanedSql.length) {
			const sub = cleanedSql.slice(pos);
			const item = cteItemRe.exec(sub);
			if (!item) break;
			ctes.add(cleanIdent(item[1]!).toLowerCase());
			const openParen = pos + item[0].length - 1;
			const scanned = scanBalancedParens(cleanedSql, openParen);
			if (!scanned) break;
			pos = scanned.end;
			while (pos < cleanedSql.length && /\s/.test(cleanedSql[pos]!)) pos++;
			if (cleanedSql[pos] === ",") pos++;
			else break;
		}
	}
	return ctes;
}

const FROM_CLAUSE_STOPS = new Set([
	"where", "join", "inner", "left", "right", "full", "outer", "cross", "natural", "straight_join",
	"apply", "on", "using", "group", "order", "having", "union", "intersect", "except", "limit",
	"offset", "fetch", "set", "values", "for", "into", "option", "with", "select", "insert",
	"update", "delete", "merge", "go", "qualify", "window", "returning", "output", "when", "then",
	"else", "end",
]);

/** Scans an optional `[AS] <alias>` and SQL Server table hint (`WITH (NOLOCK)` / `(NOLOCK)`) at `pos`. */
function consumeOptionalAliasAndHint(sql: string, startPos: number): { end: number; alias?: string } {
	let pos = startPos;
	const skipWs = () => {
		while (pos < sql.length && /\s/.test(sql[pos]!)) pos++;
	};
	skipWs();
	let alias: string | undefined;
	const asRe = new RegExp(`^AS\\s+(${IDENT_PART})`, "iu");
	const asMatch = asRe.exec(sql.slice(pos));
	if (asMatch) {
		alias = cleanIdent(asMatch[1]!);
		pos += asMatch[0].length;
	} else {
		const bareRe = new RegExp(`^(${IDENT_PART})`, "u");
		const bareMatch = bareRe.exec(sql.slice(pos));
		if (bareMatch) {
			const candidate = cleanIdent(bareMatch[1]!);
			if (candidate && !FROM_CLAUSE_STOPS.has(candidate.toLowerCase())) {
				alias = candidate;
				pos += bareMatch[0].length;
			}
		}
	}
	skipWs();
	// Optional SQL Server `WITH (NOLOCK)` or `(NOLOCK)` table hint
	const withHint = /^WITH\s*\(/i.exec(sql.slice(pos));
	if (withHint) {
		const scanned = scanBalancedParens(sql, pos + withHint[0].length - 1);
		if (scanned) pos = scanned.end;
	} else if (sql[pos] === "(") {
		const scanned = scanBalancedParens(sql, pos);
		if (scanned) pos = scanned.end;
	}
	return { end: pos, ...(alias ? { alias } : {}) };
}

/** Returns true when `pos` sits immediately inside a function call matching `fnRe` (supporting arbitrary nested parens). */
function isInsideFunctionCall(sql: string, pos: number, fnRe: RegExp): boolean {
	let depth = 0;
	for (let i = pos - 1; i >= 0; i--) {
		const ch = sql[i]!;
		if (ch === ";") return false;
		if (ch === "]" || ch === '"' || ch === "`") {
			const open = ch === "]" ? "[" : ch;
			i--;
			while (i >= 0 && sql[i] !== open) i--;
			continue;
		}
		if (ch === ")") {
			depth++;
		} else if (ch === "(") {
			if (depth === 0) {
				const head = sql.slice(Math.max(0, i - 24), i);
				return fnRe.test(head);
			}
			depth--;
		}
	}
	return false;
}

/** Strips parenthesized sub-expressions from `sql` (preserving brackets/quotes) to inspect depth-0 statement verbs. */
function stripParenthesized(sql: string): string {
	let out = "";
	let depth = 0;
	let quote: string | null = null;
	let bracket = false;
	for (let i = 0; i < sql.length; i++) {
		const ch = sql[i]!;
		if (bracket) {
			if (depth === 0) out += ch;
			if (ch === "]") {
				if (sql[i + 1] === "]") {
					if (depth === 0) out += sql[++i]!;
					else i++;
				} else bracket = false;
			}
			continue;
		}
		if (quote) {
			if (depth === 0) out += ch;
			if (ch === quote) {
				if (sql[i + 1] === quote) {
					if (depth === 0) out += sql[++i]!;
					else i++;
				} else quote = null;
			}
			continue;
		}
		if (ch === "[") {
			bracket = true;
			if (depth === 0) out += ch;
			continue;
		}
		if (ch === "'" || ch === '"' || ch === "`") {
			quote = ch;
			if (depth === 0) out += ch;
			continue;
		}
		if (ch === "(") {
			depth++;
			out += " ";
		} else if (ch === ")") {
			if (depth > 0) depth--;
			out += " ";
		} else if (depth === 0) {
			out += ch;
		} else if (ch === "\n") {
			out += "\n";
		}
	}
	return out;
}

/**
 * Extracts depth-0 table aliases declared in the `FROM` / `JOIN` clauses of the current
 * `UPDATE` or `DELETE` statement (starting after `UPDATE <target>` or `DELETE <target>`),
 * so T-SQL `UPDATE smp SET ... FROM dbo.SAMPLES smp` never treats `smp` as a table name.
 */
function statementFromAliases(cleaned: string, startPos: number): Set<string> {
	// Build a depth-0 slice of the statement up to `;`, `GO`, or next top-level DML statement, respecting brackets and quotes.
	let depth0 = "";
	let i = startPos;
	let depth = 0;
	let quote: string | null = null;
	let bracket = false;
	const n = cleaned.length;
	const stmtBoundaryRe = /^(?:SELECT|INSERT|UPDATE|DELETE|MERGE|CREATE|ALTER|DROP|EXEC(?:UTE)?)\b/i;
	while (i < n) {
		const ch = cleaned[i]!;
		if (bracket) {
			if (depth === 0) depth0 += ch;
			else depth0 += " ";
			if (ch === "]") {
				if (cleaned[i + 1] === "]") {
					i++;
					if (depth === 0) depth0 += cleaned[i]!;
					else depth0 += " ";
				} else bracket = false;
			}
			i++;
			continue;
		}
		if (quote) {
			if (depth === 0) depth0 += ch;
			else depth0 += " ";
			if (ch === quote) {
				if (cleaned[i + 1] === quote) {
					i++;
					if (depth === 0) depth0 += cleaned[i]!;
					else depth0 += " ";
				} else quote = null;
			}
			i++;
			continue;
		}
		if (ch === "[") {
			bracket = true;
			depth0 += depth === 0 ? ch : " ";
			i++;
			continue;
		}
		if (ch === "'" || ch === '"' || ch === "`") {
			quote = ch;
			depth0 += depth === 0 ? ch : " ";
			i++;
			continue;
		}
		if (ch === "(") {
			depth++;
			depth0 += " ";
			i++;
			continue;
		}
		if (ch === ")") {
			if (depth > 0) depth--;
			depth0 += " ";
			i++;
			continue;
		}
		if (depth > 0) {
			depth0 += " ";
			i++;
			continue;
		}
		if (ch === ";") break;
		if ((i === startPos || cleaned[i - 1] === "\n") && /^[ \t]*GO[ \t]*(?=\r?\n|$)/i.test(cleaned.slice(i))) break;
		if ((i === startPos || !isIdentChar(cleaned[i - 1])) && stmtBoundaryRe.test(cleaned.slice(i))) {
			const prev = cleaned.slice(Math.max(startPos, i - 16), i);
			if (!/\b(?:FOR|ON)\s+$/i.test(prev)) break;
		}
		depth0 += ch;
		i++;
	}

	const aliases = new Set<string>();
	const realTables = new Set<string>();
	const fromJoinRe = new RegExp(`\\b(FROM|JOIN)\\s+(?:ONLY\\s+)?(${QUALIFIED_NAME})`, "giu");
	const qualAtStartRe = new RegExp(`^(?:ONLY\\s+)?(${QUALIFIED_NAME})`, "iu");
	const partRe = new RegExp(IDENT_PART, "gu");
	const recordName = (raw: string) => {
		const parts = [...raw.matchAll(partRe)].map((p) => cleanIdent(p[0]!)).filter(Boolean);
		if (parts.length) realTables.add(parts[parts.length - 1]!.toLowerCase());
	};

	for (const m of depth0.matchAll(fromJoinRe)) {
		const kw = m[1]!.toUpperCase();
		recordName(m[2]!);
		let pos = (m.index ?? 0) + m[0].length;
		const first = consumeOptionalAliasAndHint(depth0, pos);
		if (first.alias) aliases.add(first.alias.toLowerCase());
		pos = first.end;
		if (kw !== "FROM") continue;
		// Also walk ANSI-89 comma joins in the same `FROM` clause.
		while (pos < depth0.length) {
			while (pos < depth0.length && /\s/.test(depth0[pos]!)) pos++;
			if (depth0[pos] !== ",") break;
			pos++;
			while (pos < depth0.length && /\s/.test(depth0[pos]!)) pos++;
			const nextTbl = qualAtStartRe.exec(depth0.slice(pos));
			if (!nextTbl) break;
			recordName(nextTbl[1]!);
			pos += nextTbl[0].length;
			const nextAlias = consumeOptionalAliasAndHint(depth0, pos);
			if (nextAlias.alias) aliases.add(nextAlias.alias.toLowerCase());
			pos = nextAlias.end;
		}
	}
	for (const tbl of realTables) aliases.delete(tbl);
	return aliases;
}

/**
 * Extracts queried/mutated table names after `FROM` (including `FROM ONLY` and ANSI-89 comma joins
 * after tables or derived tables), `JOIN`, `INSERT [TOP (N)] [INTO]`, `MERGE [INTO] ... USING`,
 * `UPDATE [TOP (N) [PERCENT]]` (excluding T-SQL `FROM` aliases), and `DELETE` (with or without `FROM`)
 * in `.sql` and STARLIMS `.ds` Data Sources, ignoring CTE names, `#temp` tables, SQL keywords,
 * PL/SQL `SELECT/RETURNING ... INTO` targets, `REVOKE ... FROM`, `TRIM`/`EXTRACT` calls,
 * system catalogs (`sys.*`, `information_schema.*`), non-SQL SSL strings, and comments.
 */
export function extractQueriedTablesFromSql(text: string): { object: string; line: number }[] {
	if (!text.trim()) return [];
	const commentStripped = stripCommentsForModeDetect(text, false);
	const noCommentsNoStrings = stripCommentsForModeDetect(text, true);
	const hasTopLevelSql =
		/\b(?:SELECT\b[\s\S]{1,400}?\bFROM|INSERT\s+(?:TOP\s*(?:\([^)]*\)|\d+)\s*(?:PERCENT\s+)?)?INTO|UPDATE\s+(?:TOP\s*(?:\([^)]*\)|\d+)\s*(?:PERCENT\s+)?)?(?:ONLY\s+)?(?:\[[^\]]+\]|"[^"]+"|`[^`]+`|[A-Za-z_][\w$.#]*)\s+SET|DELETE\s+(?:TOP\s*(?:\([^)]*\)|\d+)\s*(?:PERCENT\s+)?)?FROM|MERGE\s+(?:TOP\s*(?:\([^)]*\)|\d+)\s*(?:PERCENT\s+)?)?(?:INTO\s+)?(?:\[[^\]]+\]|"[^"]+"|`[^`]+`|[A-Za-z_][\w$.#]*)\b[\s\S]{0,120}?\bUSING|CREATE\s+(?:OR\s+(?:REPLACE|ALTER)\s+)?(?:TABLE|VIEW|PROC(?:EDURE)?|FUNCTION))\b/i.test(
			noCommentsNoStrings,
		);
	const looksLikeSslDs =
		!hasTopLevelSql &&
		(/^\s*:(?:PARAMETERS|DECLARE|RETURN|IF|FOR|PROCEDURE)\b/im.test(commentStripped) ||
			/\b(?:SQLExecute(?:Ex)?|RunSQL|LSelect|LimSelect)\s*\(/i.test(commentStripped));
	const sqlSurface = looksLikeSslDs ? extractSslEmbeddedSql(text) : text;
	const cleaned = sanitizeSql(sqlSurface, true);
	const cteNames = extractCteNames(cleaned);

	const lineAt = (offset: number) => {
		let line = 1;
		for (let i = 0; i < offset && i < cleaned.length; i++) {
			if (cleaned[i] === "\n") line++;
		}
		return line;
	};

	const byLower = new Map<string, { object: string; line: number; offset: number }>();
	const partRe = new RegExp(IDENT_PART, "gu");
	const qualAtStartRe = new RegExp(`^(?:ONLY\\s+)?(${QUALIFIED_NAME})`, "iu");

	const pushTable = (rawName: string, offset: number, afterSlice: string, beforeSlice: string, skipTvf: boolean) => {
		if (beforeSlice.endsWith("?") || afterSlice.startsWith("?")) return;
		if (skipTvf && /^\s*\(/.test(afterSlice)) return;
		const parts = [...rawName.matchAll(partRe)].map((p) => cleanIdent(p[0]!)).filter(Boolean);
		if (!parts.length) return;
		const bareName = parts[parts.length - 1]!;
		const schemaName = parts.length >= 2 ? parts[parts.length - 2]!.toLowerCase() : "";
		if (!bareName || bareName.length < 2) return;
		if (bareName.startsWith("#") || bareName.startsWith("@")) return;
		if (schemaName && SYSTEM_SCHEMAS.has(schemaName)) return;
		const low = bareName.toLowerCase();
		if (SQL_QUERY_KEYWORDS.has(low) || cteNames.has(low)) return;
		const prev = byLower.get(low);
		if (!prev || offset < prev.offset) {
			byLower.set(low, { object: bareName, line: lineAt(offset), offset });
		}
	};

	const walkCommaJoins = (startPos: number) => {
		let pos = startPos;
		while (pos < cleaned.length) {
			while (pos < cleaned.length && /\s/.test(cleaned[pos]!)) pos++;
			if (cleaned[pos] !== ",") break;
			pos++;
			while (pos < cleaned.length && /\s/.test(cleaned[pos]!)) pos++;
			if (/^LATERAL\s*\(/i.test(cleaned.slice(pos))) {
				pos += cleaned.slice(pos).indexOf("(");
			}
			if (cleaned[pos] === "(") {
				const scanned = scanBalancedParens(cleaned, pos);
				if (!scanned) break;
				pos = consumeOptionalAliasAndHint(cleaned, scanned.end).end;
				continue;
			}
			const nextMatch = qualAtStartRe.exec(cleaned.slice(pos));
			if (!nextMatch) break;
			const nextRaw = nextMatch[1]!;
			const nextEnd = pos + nextMatch[0].length;
			const nextBefore = cleaned.slice(Math.max(0, pos - 8), pos);
			const nextAfter = cleaned.slice(nextEnd, nextEnd + 16);
			pushTable(nextRaw, pos, nextAfter, nextBefore, true);
			pos = consumeOptionalAliasAndHint(cleaned, nextEnd).end;
		}
	};

	const TOP_OPT = `(?:TOP\\s*(?:\\((?:[^()]*|\\([^()]*\\))*\\)|\\d+)\\s*(?:PERCENT\\s+)?)?`;
	const clauseRe = new RegExp(
		`\\b(?:` +
			`(FROM)\\s+(?:LATERAL\\s+)?\\(` +
			`|(FROM|JOIN)\\s+(?:ONLY\\s+)?(${QUALIFIED_NAME})` +
			`|(USING)\\s+(${QUALIFIED_NAME})` +
			`|(INTO)\\s+(${QUALIFIED_NAME})` +
			`|(INSERT)\\s+${TOP_OPT}(?:INTO\\s+)?(${QUALIFIED_NAME})` +
			`|(MERGE)\\s+${TOP_OPT}(?:INTO\\s+)?(${QUALIFIED_NAME})` +
			`|(UPDATE)\\s+${TOP_OPT}(?:ONLY\\s+)?(${QUALIFIED_NAME})` +
			`|(DELETE)\\s+${TOP_OPT}(?!FROM\\b)(?:ONLY\\s+)?(${QUALIFIED_NAME})` +
		`)`,
		"giu",
	);

	for (const m of cleaned.matchAll(clauseRe)) {
		const matchStart = m.index ?? 0;
		const matchEnd = matchStart + m[0].length;

		// Derived table in FROM (`FROM (SELECT 1) sub, OTHER_TBL`): walk any ANSI-89 comma joins that follow it.
		if (m[1]) {
			if (isInsideFunctionCall(cleaned, matchStart, /\b(?:EXTRACT|TRIM|SUBSTRING)\s*$/i)) continue;
			const stmtPrefix = cleaned.slice(findStatementStart(cleaned, matchStart), matchStart).trimStart();
			if (/^REVOKE\b/i.test(stmtPrefix)) continue;
			const openParenPos = matchEnd - 1;
			const scanned = scanBalancedParens(cleaned, openParenPos);
			if (scanned) {
				walkCommaJoins(consumeOptionalAliasAndHint(cleaned, scanned.end).end);
			}
			continue;
		}

		const kw = (m[2] ?? m[4] ?? m[6] ?? m[8] ?? m[10] ?? m[12] ?? m[14])!.toUpperCase();
		const rawName = (m[3] ?? m[5] ?? m[7] ?? m[9] ?? m[11] ?? m[13] ?? m[15])!;
		const before = cleaned.slice(Math.max(0, matchStart - 48), matchStart);
		const after = cleaned.slice(matchEnd, matchEnd + 16);

		// Skip `FOR UPDATE`, `ON UPDATE CASCADE`, `ON DELETE CASCADE`, `TRIM(... FROM ...)`, `EXTRACT(... FROM ...)`, `SUBSTRING(... FROM ...)`, `REVOKE ... FROM`.
		if (kw === "UPDATE" && /\b(?:FOR|ON)\s+$/i.test(before)) continue;
		if (kw === "DELETE" && /\bON\s+$/i.test(before)) continue;
		if (kw === "FROM") {
			if (isInsideFunctionCall(cleaned, matchStart, /\b(?:EXTRACT|TRIM|SUBSTRING)\s*$/i)) continue;
			const stmtPrefix = cleaned.slice(findStatementStart(cleaned, matchStart), matchStart).trimStart();
			if (/^REVOKE\b/i.test(stmtPrefix)) continue;
		}
		if (kw === "INTO") {
			const stmtPrefix = stripParenthesized(cleaned.slice(findStatementStart(cleaned, matchStart), matchStart));
			const verbs = [...stmtPrefix.matchAll(/\b(INSERT|MERGE|SELECT|RETURNING|FETCH|BULK\s+COLLECT|EXECUTE)\b/gi)];
			const lastVerb = verbs.length ? verbs[verbs.length - 1]![1]!.replace(/\s+/g, " ").toUpperCase() : "";
			if (!lastVerb || lastVerb === "SELECT" || lastVerb === "RETURNING" || lastVerb === "FETCH" || lastVerb === "BULK COLLECT" || lastVerb === "EXECUTE") {
				continue;
			}
		}
		if (kw === "USING") {
			const stmtPrefix = stripParenthesized(cleaned.slice(findStatementStart(cleaned, matchStart), matchStart));
			const verbs = [...stmtPrefix.matchAll(/\b(MERGE|DELETE|CREATE|ALTER|EXECUTE|EXEC)\b/gi)];
			const lastVerb = verbs.length ? verbs[verbs.length - 1]![1]!.toUpperCase() : "";
			if (lastVerb !== "MERGE" && lastVerb !== "DELETE") continue;
		}

		// Exclude T-SQL `FROM` table aliases from `UPDATE <alias> SET ... FROM dbo.SAMPLES <alias>` and `DELETE <alias> FROM dbo.SAMPLES <alias>`.
		if (kw === "UPDATE" || kw === "DELETE") {
			const parts = [...rawName.matchAll(partRe)].map((p) => cleanIdent(p[0]!)).filter(Boolean);
			if (parts.length === 1) {
				const fromAliases = statementFromAliases(cleaned, matchEnd);
				if (fromAliases.has(parts[0]!.toLowerCase())) continue;
			}
		}

		pushTable(rawName, matchStart, after, before, kw === "FROM" || kw === "JOIN" || kw === "USING");

		// Support ANSI-89 comma joins (`FROM FOLDERS f, SAMPLES s, RESULTS r WHERE ...`).
		if (kw === "FROM") {
			walkCommaJoins(consumeOptionalAliasAndHint(cleaned, matchEnd).end);
		}
	}

	return [...byLower.values()]
		.sort((a, b) => a.offset - b.offset)
		.map(({ object, line }) => ({ object, line }));
}

const MERMAID_RESERVED_ENTITIES = new Set([
	"end", "class", "style", "subgraph", "classdef", "one", "many", "to", "direction", "acctitle", "accdescr",
]);
const MERMAID_RESERVED_ATTRS = new Set(["pk", "fk", "uk"]);

/** Generates a clean fenced Mermaid `erDiagram` block from parsed SQL tables and their FK relationships. */
export function generateMermaidErDiagram(tables: readonly SqlTableDef[]): string {
	if (!tables.length) return "";
	const sanitizeIdent = (raw: string) => {
		const cleaned = raw.trim().replace(/[^A-Za-z0-9_-]+/g, "_").replace(/^_+|_+$/g, "");
		return cleaned && /^[A-Za-z_]/.test(cleaned) ? cleaned : `T_${cleaned || "TABLE"}`;
	};
	const formatEntity = (raw: string) => {
		const ident = sanitizeIdent(raw);
		return MERMAID_RESERVED_ENTITIES.has(ident.toLowerCase()) ? `"${ident}"` : ident;
	};
	const formatAttrName = (raw: string) => {
		const ident = sanitizeIdent(raw);
		return MERMAID_RESERVED_ATTRS.has(ident.toLowerCase()) ? `\`${ident}\`` : ident;
	};
	const sanitizeType = (raw: string) => {
		const compact = raw
			.trim()
			.replace(/\s*\(\s*/g, "(")
			.replace(/\s*\)/g, ")")
			.replace(/\s*,\s*/g, "_")
			.replace(/\s+/g, "_")
			.replace(/[^A-Za-z0-9_()[\]_-]/g, "");
		if (!compact) return "TEXT";
		return /^[A-Za-z_]/.test(compact) ? compact : `T_${compact}`;
	};

	const lines: string[] = [];
	const relOrder: string[] = [];
	const relByPair = new Map<string, { parent: string; entity: string; labels: string[]; seenLabels: Set<string> }>();

	for (const tbl of tables) {
		const entity = formatEntity(tbl.tableName);
		const fkCols = new Set<string>();
		for (const fk of tbl.foreignKeys ?? []) {
			for (const c of fkLocalCols(fk)) fkCols.add(c.toLowerCase());
		}
		lines.push(`    ${entity} {`);
		for (const col of tbl.columns) {
			const keys: string[] = [];
			const maskedCons = maskQuotedAndChecks(col.constraints);
			if (/\bPRIMARY\s+KEY\b/i.test(maskedCons)) keys.push("PK");
			if (fkCols.has(col.name.toLowerCase()) || /\bREFERENCES\b/i.test(maskedCons)) keys.push("FK");
			if (/\bUNIQUE\b/i.test(maskedCons) && !keys.includes("PK")) keys.push("UK");
			const keySuffix = keys.length ? ` ${keys.join(",")}` : "";
			lines.push(`        ${sanitizeType(col.type)} ${formatAttrName(col.name)}${keySuffix}`);
		}
		lines.push("    }");
		for (const fk of tbl.foreignKeys ?? []) {
			const parent = formatEntity(fk.refTable);
			const locals = fkLocalCols(fk);
			const refs = fkRefCols(fk);
			const localStr = locals.join(", ");
			const refStr = refs.join(", ");
			const label = refStr && refStr.toLowerCase() !== localStr.toLowerCase() ? `${localStr} to ${refStr}` : localStr;
			const pairKey = `${parent.toLowerCase()}->${entity.toLowerCase()}`;
			let entry = relByPair.get(pairKey);
			if (!entry) {
				entry = { parent, entity, labels: [], seenLabels: new Set() };
				relByPair.set(pairKey, entry);
				relOrder.push(pairKey);
			}
			const normLabel = label.toLowerCase();
			if (label && !entry.seenLabels.has(normLabel)) {
				entry.seenLabels.add(normLabel);
				entry.labels.push(label);
			}
		}
	}

	const rels = relOrder.map((pairKey) => {
		const { parent, entity, labels } = relByPair.get(pairKey)!;
		return `    ${parent} ||--o{ ${entity} : "${labels.join(", ").replace(/"/g, "'")}"`;
	});

	return ["```mermaid", "erDiagram", ...lines, ...rels, "```"].join("\n");
}
