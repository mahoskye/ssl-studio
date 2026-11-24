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

/**
 * Strips `--` line comments and `/* ... *\/` block comments while preserving SQL
 * single-quoted strings (`'-- keep --'`, `'it''s'`) and quoted identifiers.
 * When `maskStrings` is true, replaces single-quoted string contents with spaces
 * so dynamic SQL like `EXEC('CREATE TABLE ...')` never triggers false object hits.
 */
function sanitizeSql(sql: string, maskStrings = false): string {
	let out = "";
	let i = 0;
	const n = sql.length;
	while (i < n) {
		const ch = sql[i]!;
		const next = sql[i + 1];
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
		// Double-quoted or bracketed identifier (preserved verbatim)
		if (ch === '"' || ch === "[") {
			const endCh = ch === "[" ? "]" : '"';
			out += ch;
			i++;
			while (i < n && sql[i] !== endCh) {
				out += sql[i++];
			}
			if (i < n) out += sql[i++];
			continue;
		}
		// Line comment `-- ...`
		if (ch === "-" && next === "-") {
			while (i < n && sql[i] !== "\n") i++;
			continue;
		}
		// Block comment `/* ... */`
		if (ch === "/" && next === "*") {
			i += 2;
			while (i < n && !(sql[i] === "*" && sql[i + 1] === "/")) {
				if (sql[i] === "\n") out += "\n";
				i++;
			}
			if (i < n) i += 2;
			out += " ";
			continue;
		}
		out += ch;
		i++;
	}
	return out;
}

const cleanIdent = (raw: string) => raw.trim().replace(/^[[`"]|[\]`"]$/g, "");

const IDENT_PART = String.raw`(?:\[[^\]]+\]|"[^"]+"|` + "`[^`]+`" + String.raw`|[A-Za-z_][\w$#]*)`;
const QUALIFIED_NAME = String.raw`(?:${IDENT_PART}\s*\.\s*){0,2}${IDENT_PART}`;

/** Formats 1-, 2-, or 3-part SQL names (`[db].[dbo].[My.Table]` -> `{ name: "dbo.My.Table", bareName: "My.Table" }`). */
function normalizeObjectName(raw: string): { name: string; bareName: string } {
	// Tokenize by IDENT_PART so dots inside bracketed/quoted names (`[dbo].[My.Special.Table]`) stay intact.
	const partRe = new RegExp(IDENT_PART, "g");
	const parts = [...raw.matchAll(partRe)].map((m) => cleanIdent(m[0]!)).filter(Boolean);
	if (!parts.length) return { name: "", bareName: "" };
	const bareName = parts[parts.length - 1]!;
	// For 3-part names (`db.schema.object`), drop the database prefix so `dbo.object` stays portable across DEV/QA/PROD.
	const name = parts.length >= 2 ? `${parts[parts.length - 2]}.${bareName}` : bareName;
	return { name, bareName };
}

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
		"(?:OR\\s+(?:REPLACE|ALTER)|UNIQUE|CLUSTERED|NONCLUSTERED|BITMAP|COLUMNSTORE|MATERIALIZED|GLOBAL\\s+TEMPORARY|PRIVATE\\s+TEMPORARY|LOCAL\\s+TEMPORARY|TEMPORARY|TEMP|FORCE|NOFORCE|EDITIONABLE|NONEDITIONABLE|PUBLIC)";
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
	const addMatch = (rawKind: string, rawName: string, action: "create" | "alter") => {
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

	const createRe = new RegExp(`\\bCREATE\\s+(?:${modifiers}\\s+)*(${kinds})\\s+(?:IF\\s+NOT\\s+EXISTS\\s+)?(${QUALIFIED_NAME})`, "gi");
	for (const m of cleaned.matchAll(createRe)) addMatch(m[1]!, m[2]!, "create");

	if (options.includeAlter) {
		const alterRe = new RegExp(`\\bALTER\\s+(?:${modifiers}\\s+)*(${kinds})\\s+(?:IF\\s+EXISTS\\s+)?(${QUALIFIED_NAME})`, "gi");
		for (const m of cleaned.matchAll(alterRe)) addMatch(m[1]!, m[2]!, "alter");
	}
	return out;
}

/** Splits a parenthesized SQL column list on top-level commas (respecting nested parens, quotes, and `[bracketed]` identifiers). */
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
		if (ch === "[") {
			bracket = true;
			cur += ch;
			continue;
		}
		if (ch === "'" || ch === '"') {
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

/** Parses one column definition line from a `CREATE TABLE` or `ALTER TABLE ADD` list. */
function parseColumnClause(rawClause: string): SqlColumnDef | null {
	const line = rawClause.replace(/\s+/g, " ").trim();
	if (!line) return null;
	// Skip table-level constraints and SQL Server temporal table PERIOD clauses.
	if (/^(?:CONSTRAINT|PRIMARY\s+KEY|FOREIGN\s+KEY|UNIQUE|CHECK|PERIOD\s+FOR\s+SYSTEM_TIME)\b/i.test(line)) return null;
	// Skip MySQL-style table-level `INDEX idx_name (col)` / `KEY (col)` while keeping real columns named `KEY VARCHAR(50)`.
	if (/^(?:INDEX|KEY)\s+(?:[A-Za-z_][\w$#]*\s*)?\(/i.test(line)) return null;

	// Column name
	const nameMatch = new RegExp(`^(${IDENT_PART})\\s+([\\s\\S]+)$`).exec(line);
	if (!nameMatch) return null;
	const colName = cleanIdent(nameMatch[1]!);
	const rest = nameMatch[2]!.trim();

	// Computed column: `FULL_NAME AS (A + B) PERSISTED`
	const computedMatch = /^AS\s+(\([\s\S]*?\))(.*)$/i.exec(rest);
	if (computedMatch) {
		return {
			name: colName,
			type: "COMPUTED",
			constraints: `AS ${computedMatch[1]!}${computedMatch[2]!.trim() ? ` ${computedMatch[2]!.trim()}` : ""}`,
		};
	}

	// Data type: handles SSMS bracketed types `[varchar](20)`, schema-qualified `[sys].[xml]`,
	// multi-word types `CHARACTER VARYING(100)`, `DOUBLE PRECISION`, `LONG RAW`, `TIMESTAMP(6) WITH LOCAL TIME ZONE`.
	const typeRe = new RegExp(
		`^((?:${IDENT_PART}\\s*\\.\\s*)?${IDENT_PART}(?:\\s+(?:VARYING|PRECISION|RAW|OBJECT))?(?:\\s*\\([^)]*\\))?(?:\\s+(?:WITH(?:OUT)?\\s+(?:LOCAL\\s+)?TIME\\s+ZONE|CHAR|BYTE))?)(.*)$`,
		"i",
	);
	const typeMatch = typeRe.exec(rest);
	if (!typeMatch) return null;
	const cleanType = typeMatch[1]!.replace(/\[([^\]]+)\]/g, "$1").replace(/\s+/g, " ").trim();
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
		} else if (ch === "[") {
			bracket = true;
		} else if (ch === "'" || ch === '"') {
			quote = ch;
		} else if (ch === "(") {
			depth++;
		} else if (ch === ")") {
			depth--;
		}
		i++;
	}
	if (depth !== 0) return null;
	return { inner: text.slice(openParenPos + 1, i - 1), end: i };
}

/** Extracts an `ALTER TABLE` clause body: balanced `(...)` when parenthesized, otherwise up to `;`, `GO`, or next DDL keyword. */
function extractAlterBody(cleaned: string, masked: string, pos: number): string {
	while (pos < cleaned.length && /\s/.test(cleaned[pos]!)) pos++;
	if (pos >= cleaned.length) return "";
	if (cleaned[pos] === "(") {
		const scanned = scanBalancedParens(cleaned, pos);
		return scanned ? scanned.inner.trim() : "";
	}
	const restMasked = masked.slice(pos);
	const stopMatch = /;|(?:^|\r?\n)[ \t]*GO[ \t]*(?=\r?\n|$)|(?:\r?\n[ \t]*|\b)(?:CREATE|ALTER|DROP|GRANT|REVOKE|EXEC(?:UTE)?)\b/i.exec(restMasked);
	const end = stopMatch ? pos + stopMatch.index : cleaned.length;
	return cleaned.slice(pos, end).trim();
}

/** Parses a table-level `[CONSTRAINT name] FOREIGN KEY (col1, ...) REFERENCES refTable[(refCol1, ...)]` clause. */
function parseTableForeignKeys(rawClause: string): SqlForeignKeyDef[] {
	const line = rawClause.replace(/\s+/g, " ").trim();
	const fkRe = new RegExp(
		`^(?:CONSTRAINT\\s+${IDENT_PART}\\s+)?FOREIGN\\s+KEY\\s*\\(([^)]+)\\)\\s+REFERENCES\\s+(${QUALIFIED_NAME})(?:\\s*\\(([^)]+)\\))?`,
		"i",
	);
	const m = fkRe.exec(line);
	if (!m) return [];
	const localCols = m[1]!.split(",").map((c) => cleanIdent(c)).filter(Boolean);
	const { bareName, name } = normalizeObjectName(m[2]!);
	const refTable = bareName || name;
	if (!refTable || !localCols.length) return [];
	const refCols = m[3] ? m[3].split(",").map((c) => cleanIdent(c)).filter(Boolean) : [];
	return localCols.map((column, idx) => {
		const refColumn = refCols[idx] || refCols[0];
		return { column, refTable, ...(refColumn ? { refColumn } : {}) };
	});
}

/** Parses an inline column-level `REFERENCES refTable[(refCol)]` constraint. */
function parseInlineForeignKey(col: SqlColumnDef): SqlForeignKeyDef | null {
	if (!col.constraints || !/\bREFERENCES\b/i.test(col.constraints)) return null;
	const refRe = new RegExp(`\\bREFERENCES\\s+(${QUALIFIED_NAME})(?:\\s*\\(([^)]+)\\))?`, "i");
	const m = refRe.exec(col.constraints);
	if (!m) return null;
	const { bareName, name } = normalizeObjectName(m[1]!);
	const refTable = bareName || name;
	if (!refTable) return null;
	const refColumn = m[2] ? cleanIdent(m[2].split(",")[0]!) : undefined;
	return { column: col.name, refTable, ...(refColumn ? { refColumn } : {}) };
}

/** Parses a table-level `[CONSTRAINT name] PRIMARY KEY (col1, ...)` clause. */
function parseTablePrimaryKeyCols(rawClause: string): string[] {
	const line = rawClause.replace(/\s+/g, " ").trim();
	const pkRe = new RegExp(
		`^(?:CONSTRAINT\\s+${IDENT_PART}\\s+)?PRIMARY\\s+KEY\\s*(?:CLUSTERED|NONCLUSTERED)?\\s*\\(([^)]+)\\)`,
		"i",
	);
	const m = pkRe.exec(line);
	if (!m) return [];
	return m[1]!
		.split(",")
		.map((part) => {
			const ident = new RegExp(`^\\s*(${IDENT_PART})`).exec(part);
			return ident ? cleanIdent(ident[1]!) : "";
		})
		.filter(Boolean);
}

function addForeignKey(target: SqlTableDef, fk: SqlForeignKeyDef) {
	if (!target.foreignKeys) target.foreignKeys = [];
	const exists = target.foreignKeys.some(
		(e) =>
			e.column.toLowerCase() === fk.column.toLowerCase() &&
			e.refTable.toLowerCase() === fk.refTable.toLowerCase() &&
			(e.refColumn ?? "").toLowerCase() === (fk.refColumn ?? "").toLowerCase(),
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
 * Extracts effective `CREATE TABLE` definitions from SQL DDL text, applying in-order
 * `ALTER TABLE ... ADD`, `DROP COLUMN`, `ALTER COLUMN` (T-SQL/ANSI), Oracle `MODIFY`,
 * and inline / table-level `FOREIGN KEY` constraints.
 */
export function parseCreateTables(sql: string, options?: { includeStandaloneAlter?: boolean }): SqlTableDef[] {
	// `cleaned` preserves string literal values (like `DEFAULT '-- none --'`);
	// `masked` blanks single-quoted strings at identical character offsets so `EXEC('CREATE TABLE ...')` never matches.
	const cleaned = sanitizeSql(sql, false);
	const masked = sanitizeSql(sql, true);
	const tables: SqlTableDef[] = [];
	const byKey = new Map<string, SqlTableDef>();
	const headRe = new RegExp(
		`\\bCREATE\\s+(?:(?:OR\\s+REPLACE|GLOBAL\\s+TEMPORARY|PRIVATE\\s+TEMPORARY|LOCAL\\s+TEMPORARY|TEMPORARY|TEMP)\\s+)*TABLE\\s+(?:IF\\s+NOT\\s+EXISTS\\s+)?(${QUALIFIED_NAME})\\s*\\(`,
		"gi",
	);

	for (const m of masked.matchAll(headRe)) {
		const { name, bareName } = normalizeObjectName(m[1]!);
		if (!bareName || bareName.startsWith("#")) continue;
		const tableName = bareName || name;
		const parenPos = (m.index ?? 0) + m[0].length - 1;
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
				if (pkCols.has(col.name.toLowerCase()) && !/\bPRIMARY\s+KEY\b/i.test(col.constraints)) {
					col.constraints = col.constraints ? `${col.constraints} PRIMARY KEY` : "PRIMARY KEY";
				}
			}
		}
		tables.push(def);
		byKey.set(name.toLowerCase(), def);
		if (!byKey.has(bareName.toLowerCase())) byKey.set(bareName.toLowerCase(), def);
	}

	// Apply ALTER TABLE (ADD / WITH [NO]CHECK ADD / DROP COLUMN / ALTER COLUMN / MODIFY / RENAME COLUMN)
	// and Oracle/ANSI COMMENT ON COLUMN statements in exact source order.
	const alterRe = new RegExp(
		`\\bALTER\\s+TABLE\\s+(${QUALIFIED_NAME})\\s+(?:WITH\\s+(?:NO)?CHECK\\s+)?(ADD|DROP|ALTER|MODIFY|RENAME)\\b`,
		"gi",
	);
	const commentColRe = new RegExp(
		`\\bCOMMENT\\s+ON\\s+COLUMN\\s+((?:${IDENT_PART}\\s*\\.\\s*){1,3}${IDENT_PART})\\s+IS\\s+'`,
		"gi",
	);
	const indexRe = new RegExp(
		`\\bCREATE\\s+(?:(UNIQUE)\\s+)?(?:(?:CLUSTERED|NONCLUSTERED|BITMAP|FULLTEXT|SPATIAL)\\s+)*INDEX\\s+(?:IF\\s+NOT\\s+EXISTS\\s+)?(${QUALIFIED_NAME})\\s+ON\\s+(${QUALIFIED_NAME})\\s*\\(`,
		"gi",
	);
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

	const readSingleQuoted = (src: string, openQuotePos: number): string => {
		if (src[openQuotePos] !== "'") return "";
		let val = "";
		let i = openQuotePos + 1;
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

	const upsertModifiedColumn = (target: SqlTableDef, rawItem: string, allowInsert: boolean) => {
		const trimmed = rawItem.replace(/\s+/g, " ").trim();
		if (!trimmed) return;
		// PostgreSQL `ALTER COLUMN col SET NOT NULL` / `DROP NOT NULL`
		const pgNull = new RegExp(`^(${IDENT_PART})\\s+(SET|DROP)\\s+NOT\\s+NULL\\b`, "i").exec(trimmed);
		if (pgNull) {
			const colName = cleanIdent(pgNull[1]!).toLowerCase();
			const existing = target.columns.find((c) => c.name.toLowerCase() === colName);
			if (existing) {
				if (pgNull[2]!.toUpperCase() === "SET") {
					if (!/\bNOT\s+NULL\b/i.test(existing.constraints)) {
						existing.constraints = existing.constraints ? `${existing.constraints} NOT NULL` : "NOT NULL";
					}
				} else {
					existing.constraints = existing.constraints.replace(/\bNOT\s+NULL\b/gi, "").replace(/\s+/g, " ").trim();
				}
			}
			return;
		}
		// Oracle constraint-only MODIFY (`MODIFY (COL NOT NULL)` / `MODIFY COL DEFAULT 0`)
		const constraintOnly = new RegExp(`^(${IDENT_PART})\\s+((?:NOT\\s+)?NULL\\b[\\s\\S]*|DEFAULT\\b[\\s\\S]*)$`, "i").exec(trimmed);
		if (constraintOnly) {
			const colName = cleanIdent(constraintOnly[1]!).toLowerCase();
			const existing = target.columns.find((c) => c.name.toLowerCase() === colName);
			if (existing) {
				existing.constraints = constraintOnly[2]!.trim();
			}
			return;
		}
		// Normalize PostgreSQL `col TYPE newType` -> `col newType`
		const normalized = trimmed.replace(new RegExp(`^(${IDENT_PART})\\s+TYPE\\s+`, "i"), "$1 ");
		const parsed = parseColumnClause(normalized);
		if (!parsed) return;
		const existing = target.columns.find((c) => c.name.toLowerCase() === parsed.name.toLowerCase());
		if (existing) {
			existing.type = parsed.type;
			existing.constraints = parsed.constraints;
		} else if (allowInsert) {
			target.columns.push(parsed);
		}
		const inlineFk = parseInlineForeignKey(parsed);
		if (inlineFk) addForeignKey(target, inlineFk);
	};

	type DdlEvent =
		| { index: number; kind: "alter"; match: RegExpExecArray }
		| { index: number; kind: "comment"; match: RegExpExecArray }
		| { index: number; kind: "index"; match: RegExpExecArray };
	const events: DdlEvent[] = [];
	for (const m of masked.matchAll(alterRe)) events.push({ index: m.index ?? 0, kind: "alter", match: m });
	for (const m of masked.matchAll(commentColRe)) events.push({ index: m.index ?? 0, kind: "comment", match: m });
	for (const m of masked.matchAll(indexRe)) events.push({ index: m.index ?? 0, kind: "index", match: m });
	events.sort((a, b) => a.index - b.index);

	for (const ev of events) {
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
					const ident = new RegExp(`^\\s*(${IDENT_PART})`).exec(part);
					return ident ? cleanIdent(ident[1]!) : "";
				})
				.filter(Boolean);
			addIndex(target, { name: idxBare || idxName, columns: cols, ...(unique ? { unique: true } : {}) });
			continue;
		}
		if (ev.kind === "comment") {
			const m = ev.match;
			const partRe = new RegExp(IDENT_PART, "g");
			const parts = [...m[1]!.matchAll(partRe)].map((p) => cleanIdent(p[0]!)).filter(Boolean);
			if (parts.length < 2) continue;
			const colName = parts[parts.length - 1]!;
			const tblRaw = parts.length >= 3 ? `${parts[parts.length - 3]}.${parts[parts.length - 2]}` : parts[parts.length - 2]!;
			const target = ensureTarget(tblRaw, false);
			if (!target) continue;
			const col = target.columns.find((c) => c.name.toLowerCase() === colName.toLowerCase());
			if (!col) continue;
			const quotePos = ev.index + m[0].length - 1;
			const commentText = readSingleQuoted(cleaned, quotePos);
			if (commentText) col.comment = commentText;
			continue;
		}

		const m = ev.match;
		const op = m[2]!.toUpperCase();
		let pos = (m.index ?? 0) + m[0].length;
		while (pos < cleaned.length && /\s/.test(cleaned[pos]!)) pos++;

		if (op === "ADD") {
			const target = ensureTarget(m[1]!, true);
			if (!target) continue;
			const colKw = /^COLUMN\b\s*/i.exec(masked.slice(pos));
			if (colKw) pos += colKw[0].length;
			const rawSpec = extractAlterBody(cleaned, masked, pos);
			if (!rawSpec) continue;
			for (const item of splitTopLevelCommas(rawSpec)) {
				const tableFks = parseTableForeignKeys(item);
				if (tableFks.length) {
					for (const fk of tableFks) addForeignKey(target, fk);
					continue;
				}
				const pkList = parseTablePrimaryKeyCols(item);
				if (pkList.length) {
					for (const pk of pkList) {
						const col = target.columns.find((c) => c.name.toLowerCase() === pk.toLowerCase());
						if (col && !/\bPRIMARY\s+KEY\b/i.test(col.constraints)) {
							col.constraints = col.constraints ? `${col.constraints} PRIMARY KEY` : "PRIMARY KEY";
						}
					}
					continue;
				}
				const col = parseColumnClause(item);
				if (col && !target.columns.some((c) => c.name.toLowerCase() === col.name.toLowerCase())) {
					target.columns.push(col);
					const inlineFk = parseInlineForeignKey(col);
					if (inlineFk) addForeignKey(target, inlineFk);
				}
			}
			continue;
		}

		if (op === "RENAME") {
			const target = ensureTarget(m[1]!, false);
			if (!target) continue;
			const colKw = /^COLUMN\b\s*/i.exec(masked.slice(pos));
			if (!colKw) continue;
			const rawSpec = extractAlterBody(cleaned, masked, pos + colKw[0].length);
			const renMatch = new RegExp(`^(${IDENT_PART})\\s+TO\\s+(${IDENT_PART})`, "i").exec(rawSpec);
			if (!renMatch) continue;
			const oldName = cleanIdent(renMatch[1]!);
			const newName = cleanIdent(renMatch[2]!);
			if (!oldName || !newName) continue;
			const existing = target.columns.find((c) => c.name.toLowerCase() === oldName.toLowerCase());
			if (existing) existing.name = newName;
			if (target.foreignKeys?.length) {
				for (const fk of target.foreignKeys) {
					if (fk.column.toLowerCase() === oldName.toLowerCase()) fk.column = newName;
				}
			}
			if (target.indexes?.length) {
				for (const ix of target.indexes) {
					ix.columns = ix.columns.map((c) => (c.toLowerCase() === oldName.toLowerCase() ? newName : c));
				}
			}
			for (const other of tables) {
				for (const fk of other.foreignKeys ?? []) {
					if (fk.refTable.toLowerCase() === target.tableName.toLowerCase() && fk.refColumn?.toLowerCase() === oldName.toLowerCase()) {
						fk.refColumn = newName;
					}
				}
			}
			continue;
		}

		if (op === "DROP") {
			const target = ensureTarget(m[1]!, false);
			if (!target) continue;
			const restMasked = masked.slice(pos);
			// Ignore `DROP CONSTRAINT`, `DROP PRIMARY KEY`, `DROP INDEX`, etc.
			if (/^(?:CONSTRAINT|PRIMARY\s+KEY|FOREIGN\s+KEY|UNIQUE|INDEX|CHECK|TRIGGER)\b/i.test(restMasked)) continue;
			const colKw = /^COLUMN\b\s*/i.exec(restMasked);
			let rawSpec = "";
			if (colKw) {
				rawSpec = extractAlterBody(cleaned, masked, pos + colKw[0].length);
			} else if (cleaned[pos] === "(") {
				// Oracle `ALTER TABLE tbl DROP (col1, col2)`
				rawSpec = extractAlterBody(cleaned, masked, pos);
			} else {
				continue;
			}
			if (!rawSpec) continue;
			for (const item of splitTopLevelCommas(rawSpec)) {
				const stripped = item
					.replace(/^(?:COLUMN\s+)?(?:IF\s+EXISTS\s+)?/i, "")
					.trim();
				const identMatch = new RegExp(`^(${IDENT_PART})`).exec(stripped);
				if (!identMatch) continue;
				const dropKey = cleanIdent(identMatch[1]!).toLowerCase();
				const idx = target.columns.findIndex((c) => c.name.toLowerCase() === dropKey);
				if (idx >= 0) target.columns.splice(idx, 1);
				if (target.foreignKeys?.length) {
					target.foreignKeys = target.foreignKeys.filter((fk) => fk.column.toLowerCase() !== dropKey);
					if (!target.foreignKeys.length) delete target.foreignKeys;
				}
				if (target.indexes?.length) {
					target.indexes = target.indexes
						.map((ix) => ({ ...ix, columns: ix.columns.filter((c) => c.toLowerCase() !== dropKey) }))
						.filter((ix) => ix.columns.length > 0);
					if (!target.indexes.length) delete target.indexes;
				}
			}
			continue;
		}

		if (op === "ALTER") {
			const colKw = /^COLUMN\b\s*/i.exec(masked.slice(pos));
			if (!colKw) continue;
			const target = ensureTarget(m[1]!, Boolean(options?.includeStandaloneAlter));
			if (!target) continue;
			const rawSpec = extractAlterBody(cleaned, masked, pos + colKw[0].length);
			if (!rawSpec) continue;
			upsertModifiedColumn(target, rawSpec, Boolean(options?.includeStandaloneAlter));
			continue;
		}

		if (op === "MODIFY") {
			const target = ensureTarget(m[1]!, Boolean(options?.includeStandaloneAlter));
			if (!target) continue;
			const colKw = /^COLUMN\b\s*/i.exec(masked.slice(pos));
			if (colKw) pos += colKw[0].length;
			const rawSpec = extractAlterBody(cleaned, masked, pos);
			if (!rawSpec) continue;
			for (const item of splitTopLevelCommas(rawSpec)) {
				upsertModifiedColumn(target, item, Boolean(options?.includeStandaloneAlter));
			}
		}
	}

	return tables;
}

const SCHEMA_SUBSECTION_RE =
	/^(?:columns?|fields?|foreign\s+keys?|indexes?|indices|keys?|constraints?|triggers?|notes?|rules?|usage|examples?|history|relationships?)$/i;

const formatMarkdownIndexCols = (cols: readonly string[], esc: (s: string) => string) =>
	cols.map((c) => `\`${esc(c)}\``).join(", ");

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
			const note = col.comment ? esc(col.comment) : "";
			lines.push(`| \`${esc(col.name)}\` | \`${esc(col.type)}\` | ${esc(col.constraints || "—")} | ${note} |`);
		}
		if (t.foreignKeys?.length) {
			lines.push("", "## Foreign keys", "");
			lines.push("| Column | Target table | Target column | Notes |");
			lines.push("| --- | --- | --- | --- |");
			for (const fk of t.foreignKeys) {
				const refCol = fk.refColumn || fk.column;
				lines.push(`| \`${esc(fk.column)}\` | \`${esc(fk.refTable)}\` | \`${esc(refCol)}\` |  |`);
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

const stripMarkdownCell = (s: string) =>
	s
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

/**
 * Non-destructively merges SQL DDL column, foreign-key, and index definitions into an existing
 * Markdown schema doc while preserving frontmatter, surrounding prose, and hand-written `Notes` cells (ADR 0002).
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

	const findTableBlock = (tableName: string): { headLine: number; tableStart: number; tableEnd: number } | null => {
		const target = tableName.toLowerCase();
		let startSearch = 0;
		let headLine = -1;
		for (let i = 0; i < lines.length; i++) {
			const hm = /^#{1,3}\s+`?([A-Za-z_][\w$. ]*?)`?\s*$/.exec(lines[i]!.trim());
			if (hm) {
				const hName = hm[1]!.trim().toLowerCase();
				const bare = hName.includes(".") ? hName.split(".").pop()! : hName;
				if (hName === target || bare === target) {
					headLine = i;
					startSearch = i + 1;
					break;
				}
			}
		}
		if (headLine < 0 && tables.length > 1) return null;
		for (let i = startSearch; i < lines.length; i++) {
			const trimmed = lines[i]!.trim();
			const hm = /^#{1,3}\s+`?([A-Za-z_][\w$. ]*?)`?\s*$/.exec(trimmed);
			if (headLine >= 0 && hm && !SCHEMA_SUBSECTION_RE.test(hm[1]!.trim())) break;
			if (!trimmed.startsWith("|")) continue;
			const hdr = splitMarkdownRow(lines[i]!).map((c) => c.toLowerCase());
			if (!hdr[0]?.includes("column") || isForeignKeysHeader(hdr) || isIndexesHeader(hdr)) continue;
			if (i + 1 >= lines.length || !/^\s*\|?\s*:?-{2,}/.test(lines[i + 1]!)) continue;
			let end = i + 2;
			while (end < lines.length && lines[end]!.trim().startsWith("|")) end++;
			return { headLine, tableStart: i, tableEnd: end };
		}
		return null;
	};

	const findTableScopeEnd = (afterLine: number): number => {
		for (let i = afterLine; i < lines.length; i++) {
			const hm = /^#{1,2}\s+`?([A-Za-z_][\w$. ]*?)`?\s*$/.exec(lines[i]!.trim());
			if (hm && !SCHEMA_SUBSECTION_RE.test(hm[1]!.trim())) return i;
		}
		return lines.length;
	};

	const findSubsectionTable = (
		fromLine: number,
		scopeEnd: number,
		headingRe: RegExp,
	): { headLine: number; tableStart: number; tableEnd: number } | null => {
		let subHead = -1;
		for (let i = fromLine; i < scopeEnd; i++) {
			const hm = /^#{2,3}\s+(.+?)\s*$/.exec(lines[i]!.trim());
			if (hm) {
				if (subHead >= 0) break;
				if (headingRe.test(hm[1]!.trim())) subHead = i;
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
		const hdrLow = hdr.map((c) => c.toLowerCase());
		const isNullCol = Boolean(hdrLow[2]?.includes("null"));
		const notesCol = Math.max(3, hdr.length - 1);
		const existingByCol = new Map<string, { cells: string[]; index: number }>();
		const dataLines = lines.slice(block.tableStart + 2, block.tableEnd);
		const existingOrder: string[] = [];
		dataLines.forEach((raw, idx) => {
			const cells = splitMarkdownRow(raw);
			const colKey = stripMarkdownCell(cells[0] ?? "").toLowerCase();
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
			const rawNote = prev?.cells[notesCol] ?? "";
			const cleanedNote = rawNote.replace(/\s*\[deprecated\s*\/\s*dropped in sql\]/gi, "").trim();
			const note = cleanedNote || (col.comment ? esc(col.comment) : "");
			const newType = isNullCol ? esc(col.type.toLowerCase()) : `\`${esc(col.type)}\``;
			const newCons = isNullCol
				? /\b(?:not\s+null|primary\s+key)\b/i.test(col.constraints)
					? "no"
					: "yes"
				: esc(col.constraints || "—");
			if (!prev) {
				addedColumns++;
			} else if (
				stripMarkdownCell(prev.cells[1] ?? "").toLowerCase() !== col.type.toLowerCase() ||
				(prev.cells[2] ?? "").trim() !== newCons ||
				rawNote.trim() !== note
			) {
				updatedColumns++;
			}
			nextRows.push(`| \`${esc(col.name)}\` | ${newType} | ${newCons} | ${note} |`);
		}
		for (const key of existingOrder) {
			if (!seen.has(key)) {
				const prev = existingByCol.get(key)!;
				const alreadyMarked = prev.cells.some((c) => DROPPED_NOTE_RE.test(c));
				if (!markDropped || alreadyMarked) {
					nextRows.push(dataLines[prev.index]!);
				} else {
					const cells = [...prev.cells];
					while (cells.length <= notesCol) cells.push("");
					const curNote = cells[notesCol]!.trim();
					cells[notesCol] = curNote ? `${curNote} ${DROPPED_NOTE_TAG}` : DROPPED_NOTE_TAG;
					droppedColumns++;
					nextRows.push(`| ${cells.join(" | ")} |`);
				}
			}
		}
		lines.splice(block.tableStart + 2, block.tableEnd - (block.tableStart + 2), ...nextRows);
		let afterCols = block.tableStart + 2 + nextRows.length;

		// Merge or append `## Foreign keys` when SQL defines foreign keys or the doc already has a Foreign keys table.
		const scopeEndAfterCols = findTableScopeEnd(afterCols);
		const existingFkSub = findSubsectionTable(afterCols, scopeEndAfterCols, /^foreign\s+keys?$/i);
		if (tbl.foreignKeys?.length) {
			if (existingFkSub) {
				const fkHdr = splitMarkdownRow(lines[existingFkSub.tableStart]!).map((c) => c.toLowerCase());
				const fkNoteCol = fkHdr.findIndex((c) => c.includes("note") || c.includes("desc") || c.includes("purpose"));
				const oldFkNotes = new Map<string, string>();
				for (const raw of lines.slice(existingFkSub.tableStart + 2, existingFkSub.tableEnd)) {
					const c = splitMarkdownRow(raw);
					const k = `${stripMarkdownCell(c[0] ?? "").toLowerCase()}->${stripMarkdownCell(c[1] ?? "").toLowerCase()}`;
					if (fkNoteCol >= 0 && c[fkNoteCol]) oldFkNotes.set(k, c[fkNoteCol]!.trim());
				}
				const fkRows = tbl.foreignKeys.map((fk) => {
					const refCol = fk.refColumn || fk.column;
					const note = oldFkNotes.get(`${fk.column.toLowerCase()}->${fk.refTable.toLowerCase()}`) ?? "";
					return `| \`${esc(fk.column)}\` | \`${esc(fk.refTable)}\` | \`${esc(refCol)}\` | ${note} |`;
				});
				lines.splice(existingFkSub.tableStart + 2, existingFkSub.tableEnd - (existingFkSub.tableStart + 2), ...fkRows);
				afterCols = existingFkSub.tableStart + 2 + fkRows.length;
			} else if (existingFkSub === null && findTableScopeEnd(afterCols) === scopeEndAfterCols) {
				// Only append a new `## Foreign keys` section if the doc does not already have one; keep existing section-less docs
				// clean unless the table actually has FKs and is newly synced with `sqlTablesToMarkdown`, OR insert before `## Indexes`.
				const insertAt = findSubsectionTable(afterCols, scopeEndAfterCols, /^index(?:es)?$|^indices$/i)?.headLine ?? scopeEndAfterCols;
				const fkBlock = [
					...(insertAt > 0 && lines[insertAt - 1]?.trim() !== "" ? [""] : []),
					"## Foreign keys",
					"",
					"| Column | Target table | Target column | Notes |",
					"| --- | --- | --- | --- |",
					...tbl.foreignKeys.map((fk) => `| \`${esc(fk.column)}\` | \`${esc(fk.refTable)}\` | \`${esc(fk.refColumn || fk.column)}\` |  |`),
					...(insertAt < lines.length && lines[insertAt]?.trim() !== "" ? [""] : []),
				];
				lines.splice(insertAt, 0, ...fkBlock);
				afterCols = insertAt + fkBlock.length;
			}
		} else if (existingFkSub) {
			const start = existingFkSub.headLine > 0 && lines[existingFkSub.headLine - 1]?.trim() === "" ? existingFkSub.headLine - 1 : existingFkSub.headLine;
			lines.splice(start, existingFkSub.tableEnd - start);
		}

		// Merge or append `## Indexes` when SQL defines indexes or the doc already has an Indexes table.
		const scopeEndAfterFks = findTableScopeEnd(afterCols);
		const existingIdxSub = findSubsectionTable(block.tableStart + 2 + nextRows.length, scopeEndAfterFks, /^index(?:es)?$|^indices$/i);
		if (tbl.indexes?.length) {
			if (existingIdxSub) {
				const ixHdr = splitMarkdownRow(lines[existingIdxSub.tableStart]!).map((c) => c.toLowerCase());
				const ixNoteCol = ixHdr.findIndex((c) => c.includes("purpose") || c.includes("note") || c.includes("desc"));
				const colsFirst = ixHdr[1] === "columns" || ixHdr[1] === "column";
				const oldIxNotes = new Map<string, string>();
				for (const raw of lines.slice(existingIdxSub.tableStart + 2, existingIdxSub.tableEnd)) {
					const c = splitMarkdownRow(raw);
					const k = stripMarkdownCell(c[0] ?? "").toLowerCase();
					if (ixNoteCol >= 0 && c[ixNoteCol]) oldIxNotes.set(k, c[ixNoteCol]!.trim());
				}
				const ixRows = tbl.indexes.map((ix) => {
					const colsText = formatMarkdownIndexCols(ix.columns, esc);
					const uniqText = ix.unique ? "yes" : "no";
					if (ixNoteCol >= 0 && colsFirst) {
						const note = oldIxNotes.get(ix.name.toLowerCase()) ?? "";
						return `| \`${esc(ix.name)}\` | ${colsText} | ${uniqText} | ${note} |`;
					}
					return `| \`${esc(ix.name)}\` | ${uniqText} | ${colsText} |`;
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
			const start = existingIdxSub.headLine > 0 && lines[existingIdxSub.headLine - 1]?.trim() === "" ? existingIdxSub.headLine - 1 : existingIdxSub.headLine;
			lines.splice(start, existingIdxSub.tableEnd - start);
		}
	}
	return { text: lines.join(eol), addedColumns, updatedColumns, addedTables, droppedColumns };
}

type DocForeignKey = SqlForeignKeyDef & { onDelete?: string };

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

function parseInlineDocFk(column: string, constraints: string): DocForeignKey | null {
	const text = constraints.replace(/`/g, "").trim();
	if (!text) return null;
	const refMatch =
		/(?:\bREFERENCES\s+|(?:\bFK\b|foreign\s+key)\s*(?:->|→|to)\s*)([A-Za-z_][\w$.]*)(?:\s*\(\s*([A-Za-z_][\w$]*)\s*\))?/i.exec(text);
	if (!refMatch) return null;
	let refTable = refMatch[1]!;
	let refColumn = refMatch[2];
	if (!refColumn && refTable.includes(".")) {
		const parts = refTable.split(".");
		if (parts.length === 2) {
			refTable = parts[0]!;
			refColumn = parts[1]!;
		}
	}
	const onDel = /\bON\s+DELETE\s+(CASCADE|SET\s+NULL|SET\s+DEFAULT|RESTRICT|NO\s+ACTION)\b/i.exec(text)?.[1];
	return {
		column,
		refTable,
		...(refColumn ? { refColumn } : {}),
		...(onDel ? { onDelete: onDel.replace(/\s+/g, " ").toUpperCase() } : {}),
	};
}

function parseMarkdownSchemaTables(schemaMd: string): DocTableCols[] {
	const lines = schemaMd.replace(/^\uFEFF/, "").split(/\r?\n/);
	let idx = 0;
	let fmTitle = "";
	if (lines[0]?.trim() === "---") {
		const end = lines.findIndex((l, i) => i > 0 && /^(---|\.\.\.)\s*$/.test(l));
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
	let inFence = false;
	const addDocFk = (target: DocTableCols, fk: DocForeignKey) => {
		const exists = target.foreignKeys.some(
			(e) =>
				e.column.toLowerCase() === fk.column.toLowerCase() &&
				e.refTable.toLowerCase() === fk.refTable.toLowerCase() &&
				(e.refColumn ?? e.column).toLowerCase() === (fk.refColumn ?? fk.column).toLowerCase(),
		);
		if (!exists) target.foreignKeys.push(fk);
	};

	for (let i = idx; i < lines.length; i++) {
		const raw = lines[i]!;
		const trimmed = raw.trim();
		if (/^(`{3,}|~{3,})/.test(trimmed)) {
			inFence = !inFence;
			continue;
		}
		if (inFence) continue;
		const hm = /^#{1,3}\s+`?([A-Za-z_][\w$. ]*?)`?\s*$/.exec(trimmed);
		if (hm) {
			const hText = hm[1]!.trim();
			if (/^foreign\s+keys?$/i.test(hText)) {
				sectionKind = "fks";
			} else if (/^index(?:es)?$|^indices$/i.test(hText)) {
				sectionKind = "indexes";
			} else if (/^columns?$|^fields?$/i.test(hText)) {
				sectionKind = "columns";
			} else if (SCHEMA_SUBSECTION_RE.test(hText)) {
				sectionKind = "other";
			} else {
				currentTable = hText;
				currentDoc = null;
				sectionKind = "columns";
			}
			continue;
		}
		if (!trimmed.startsWith("|")) continue;
		if (i + 1 >= lines.length || !/^\s*\|?\s*:?-{2,}/.test(lines[i + 1]!)) continue;
		const hdr = splitMarkdownRow(raw).map((c) => c.toLowerCase());

		// Foreign keys table
		if (sectionKind === "fks" || isForeignKeysHeader(hdr)) {
			const target = currentDoc ?? out[out.length - 1];
			const fkColIdx = hdr.findIndex((c) => c === "column" || c === "local column" || c === "field");
			const refTblIdx = hdr.findIndex((c) => c === "target table" || c === "referenced table" || c === "table" || c.includes("reference"));
			const refColIdx = hdr.findIndex((c) => c === "target column" || c === "referenced column");
			const onDelIdx = hdr.findIndex((c) => c.includes("delete"));
			const noteIdx = hdr.findIndex((c) => c.includes("note") || c.includes("desc") || c.includes("purpose"));
			i += 2;
			if (target && fkColIdx >= 0 && refTblIdx >= 0) {
				target.hasForeignKeysSection = true;
				for (; i < lines.length && lines[i]!.trim().startsWith("|"); i++) {
					const cells = splitMarkdownRow(lines[i]!);
					const colName = stripMarkdownCell(cells[fkColIdx] ?? "");
					const rawRef = stripMarkdownCell(cells[refTblIdx] ?? "");
					if (!colName || !rawRef || colName === "…") continue;
					let refTable = rawRef;
					let refColumn = refColIdx >= 0 ? stripMarkdownCell(cells[refColIdx] ?? "") : "";
					if (!refColumn) {
						const paren = /^([A-Za-z_][\w$.]*)\s*\(\s*([A-Za-z_][\w$]*)\s*\)$/.exec(rawRef);
						if (paren) {
							refTable = paren[1]!;
							refColumn = paren[2]!;
						} else if (rawRef.includes(".")) {
							const parts = rawRef.split(".");
							if (parts.length === 2) {
								refTable = parts[0]!;
								refColumn = parts[1]!;
							}
						}
					}
					const rawDel = onDelIdx >= 0 ? stripMarkdownCell(cells[onDelIdx] ?? "") : "";
					const noteText = noteIdx >= 0 ? (cells[noteIdx] ?? "") : "";
					const delMatch =
						/^(CASCADE|SET\s+NULL|SET\s+DEFAULT|RESTRICT|NO\s+ACTION)$/i.exec(rawDel) ??
						/\bON\s+DELETE\s+(CASCADE|SET\s+NULL|SET\s+DEFAULT|RESTRICT|NO\s+ACTION)\b/i.exec(noteText);
					addDocFk(target, {
						column: colName,
						refTable,
						...(refColumn ? { refColumn } : {}),
						...(delMatch ? { onDelete: delMatch[1]!.replace(/\s+/g, " ").toUpperCase() } : {}),
					});
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
					const rawCols = (cells[colsIdx] ?? "").trim();
					if (!ixName || !rawCols || ixName === "…") continue;
					const cols = rawCols
						.split(",")
						.map((p) =>
							stripMarkdownCell(p)
								.replace(/^\(|\)$/g, "")
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

		const colIdx = hdr.findIndex((c) => c === "column" || c === "field" || c === "name");
		if (colIdx < 0) continue;
		const typeIdx = hdr.findIndex((c) => c.includes("type"));
		const consIdx = hdr.findIndex((c) => c.includes("constraint") || c.includes("key") || c.includes("null"));
		const noteIdx = hdr.findIndex((c) => c.includes("note") || c.includes("desc") || c.includes("meaning") || c.includes("holds") || c.includes("what"));
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
			const notes = noteIdx >= 0 ? (cells[noteIdx] ?? "").trim() : "";
			const constraints = consIdx >= 0 ? (cells[consIdx] ?? "").trim() : "";
			// Already-acknowledged dropped columns no longer masquerade as live schema drift.
			if (DROPPED_NOTE_RE.test(notes) || DROPPED_NOTE_RE.test(constraints)) continue;
			cols.set(colName.toLowerCase(), {
				name: colName,
				type: typeIdx >= 0 ? stripMarkdownCell(cells[typeIdx] ?? "") : "",
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
		.replace(/\s+/g, " ");

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
 * Generates clean, formatted `CREATE TABLE` (+ `FOREIGN KEY` constraints and `CREATE [UNIQUE ]INDEX`)
 * SQL DDL directly from a Markdown schema document's column, foreign-key, and index tables.
 * Output round-trips cleanly against `diffSqlAgainstSchemaMarkdown()` with zero drift.
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
			const isPk = /\b(?:primary\s+key|pk)\b/i.test(col.constraints) || /\bprimary\s+key\b/i.test(col.notes);
			const isUnique = /\bunique\b/i.test(col.constraints) || /\bunique\b/i.test(col.notes);
			return [notNull || isPk ? "NOT NULL" : "", isPk ? "PRIMARY KEY" : "", !isPk && isUnique ? "UNIQUE" : ""]
				.filter(Boolean)
				.join(" ");
		}
		if (docTbl.hasConstraintsCol) {
			const raw = col.constraints.replace(/`/g, "").trim();
			if (!raw || raw === "—" || raw === "-" || /^null$/i.test(raw)) return "";
			return raw
				.replace(/\bpk\b/gi, "PRIMARY KEY")
				.replace(/\bnn\b/gi, "NOT NULL")
				.replace(/\s+/g, " ")
				.trim();
		}
		return /\bprimary\s+key\b/i.test(col.notes) ? "NOT NULL PRIMARY KEY" : "";
	};

	const blocks: string[] = [];
	const tableNames: string[] = [];
	for (const docTbl of docTables) {
		const rawName = (docTbl.tableName || options?.fallbackTableName || "").trim();
		const tableName = rawName.replace(/\s+/g, "_").replace(/[^A-Za-z0-9_.$]/g, "");
		if (!tableName) continue;
		tableNames.push(tableName);
		const rows = [...docTbl.columns.values()].map((col) => ({
			name: col.name,
			type: formatType(col.type),
			constraints: formatConstraints(docTbl, col),
		}));
		const maxName = Math.max(...rows.map((r) => r.name.length));
		const maxType = Math.max(...rows.map((r) => r.type.length));
		// Skip table-level FK clause if the column already carries an inline `REFERENCES ...` constraint.
		const inlineFkCols = new Set(
			rows.filter((r) => /\bREFERENCES\b/i.test(r.constraints)).map((r) => r.name.toLowerCase()),
		);
		const fkLines = docTbl.foreignKeys
			.filter((fk) => !inlineFkCols.has(fk.column.toLowerCase()))
			.map((fk) => {
				const fkName = `FK_${tableName}_${fk.column}`.replace(/[^A-Za-z0-9_]/g, "_");
				const target = fk.refColumn ? `${fk.refTable} (${fk.refColumn})` : fk.refTable;
				const onDel = fk.onDelete ? ` ON DELETE ${fk.onDelete}` : "";
				return `    CONSTRAINT ${fkName} FOREIGN KEY (${fk.column}) REFERENCES ${target}${onDel}`;
			});
		const bodyLines = [
			...rows.map((r) =>
				r.constraints
					? `    ${r.name.padEnd(maxName)} ${r.type.padEnd(maxType)} ${r.constraints}`
					: `    ${r.name.padEnd(maxName)} ${r.type}`,
			),
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
	const fkKey = (fk: SqlForeignKeyDef) =>
		`${fk.column.toLowerCase()}->${fk.refTable.toLowerCase()}(${(fk.refColumn || fk.column).toLowerCase()})`;

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
			const typeChanged = Boolean(docCol.type) && normalizeSqlType(col.type) !== normalizeSqlType(docCol.type);
			let nullChanged = false;
			if (docTbl.hasConstraintsCol || docTbl.hasNullCol) {
				const sqlNotNull = /\b(?:not\s+null|primary\s+key)\b/i.test(col.constraints);
				const docNotNull = docTbl.hasNullCol
					? /^(?:no|false|not\s*null|nn|pk|primary\s*key)$/i.test(docCol.constraints)
					: /\b(?:not\s+null|primary\s+key|pk)\b/i.test(docCol.constraints);
				nullChanged = sqlNotNull !== docNotNull;
			}
			if (typeChanged || nullChanged) {
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
				if (!docFks.has(k)) added.push(`FK: ${fk.column} -> ${fk.refTable}`);
			}
			for (const [k, fk] of docFks) {
				if (!sqlFks.has(k)) dropped.push(`FK: ${fk.column} -> ${fk.refTable}`);
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
	"inserted", "deleted", "values",
]);

const SYSTEM_SCHEMAS = new Set(["sys", "information_schema", "pg_catalog", "mysql", "performance_schema"]);

const looksLikeSqlStatement = (s: string) =>
	(/\b(?:SELECT|INSERT|UPDATE|DELETE|MERGE)\b/i.test(s) && /\b(?:FROM|SET|INTO|VALUES)\b/i.test(s)) ||
	/\bDELETE\s+(?:TOP\s*\([^)]*\)\s*(?:PERCENT\s+)?)?(?:[A-Za-z_[\]"`][\w$#.[\]"`]*)\s+WHERE\b/i.test(s);

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

/**
 * Extracts SQL string literals embedded inside STARLIMS SSL `.ds` files while preserving exact
 * character offsets and line numbers. Non-SQL English error/log strings (e.g. "Failed reading
 * from config", "Update status failed") are masked out so they never produce bogus table hits.
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

	// Group string literals connected via `+` or sequential `<var> +=` / `<var> := <var> +` concatenation.
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
		const isPlusConcat = /^\s*\+\s*$/.test(gap);
		const appendMatch = curVar
			? /^\s*;\s*([A-Za-z_]\w*)\s*(?:\+=|:=\s*\1\s*\+)\s*$/i.exec(gap)
			: null;
		const isSameVarAppend = Boolean(appendMatch && appendMatch[1]!.toLowerCase() === curVar);
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
		for (const lit of group) {
			for (let k = 0; k < lit.content.length && lit.contentStart + k < n; k++) {
				chars[lit.contentStart + k] = lit.content[k]!;
			}
		}
		const lastEnd = group[group.length - 1]!.end - 1;
		if (lastEnd >= 0 && lastEnd < n && chars[lastEnd] !== "\n") {
			chars[lastEnd] = ";";
		}
	}
	return chars.join("");
}

/** Collects CTE names declared via `WITH [RECURSIVE] cte1 AS (...), cte2 AS (...)`. */
function extractCteNames(cleanedSql: string): Set<string> {
	const ctes = new Set<string>();
	const withRe = /\bWITH\s+(?:RECURSIVE\s+)?/gi;
	const cteItemRe = new RegExp(`^\\s*(${IDENT_PART})\\s*(?:\\([^)]*\\)\\s*)?AS\\s*(?:(?:NOT\\s+)?MATERIALIZED\\s+)?\\(`, "i");
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
	const asRe = new RegExp(`^AS\\s+(${IDENT_PART})`, "i");
	const asMatch = asRe.exec(sql.slice(pos));
	if (asMatch) {
		alias = cleanIdent(asMatch[1]!);
		pos += asMatch[0].length;
	} else {
		const bareRe = new RegExp(`^(${IDENT_PART})`);
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

/**
 * Extracts depth-0 table aliases declared in the `FROM` / `JOIN` clauses of the current
 * `UPDATE` or `DELETE` statement (starting after `UPDATE <target>` or `DELETE <target>`),
 * so T-SQL `UPDATE smp SET ... FROM dbo.SAMPLES smp` never treats `smp` as a table name.
 */
function statementFromAliases(cleaned: string, startPos: number): Set<string> {
	// Build a depth-0 slice of the statement up to `;`, `GO`, or next top-level DML statement.
	let depth0 = "";
	let i = startPos;
	let depth = 0;
	const n = cleaned.length;
	const stmtBoundaryRe = /^(?:SELECT|INSERT|UPDATE|DELETE|MERGE|CREATE|ALTER|DROP|EXEC(?:UTE)?)\b/i;
	while (i < n) {
		const ch = cleaned[i]!;
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
		if ((i === startPos || !/[\w$]/.test(cleaned[i - 1]!)) && stmtBoundaryRe.test(cleaned.slice(i))) {
			const prev = cleaned.slice(Math.max(startPos, i - 16), i);
			if (!/\b(?:FOR|ON)\s+$/i.test(prev)) break;
		}
		depth0 += ch;
		i++;
	}

	const aliases = new Set<string>();
	const realTables = new Set<string>();
	const fromJoinRe = new RegExp(`\\b(FROM|JOIN)\\s+(${QUALIFIED_NAME})`, "gi");
	const qualAtStartRe = new RegExp(`^(${QUALIFIED_NAME})`);
	const partRe = new RegExp(IDENT_PART, "g");
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
 * Extracts queried/mutated table names after `FROM` (including ANSI-89 comma joins), `JOIN`,
 * `INTO`, `UPDATE` (excluding T-SQL `FROM` aliases), and `DELETE` (with or without `FROM`)
 * in `.sql` and STARLIMS `.ds` Data Sources, ignoring CTE names, `#temp` tables, SQL keywords,
 * system catalogs (`sys.*`, `information_schema.*`), non-SQL SSL strings, and comments.
 */
export function extractQueriedTablesFromSql(text: string): { object: string; line: number }[] {
	if (!text.trim()) return [];
	const looksLikeSslDs =
		/^\s*:(?:PARAMETERS|DECLARE|RETURN|IF|FOR|PROCEDURE)\b/im.test(text) ||
		/\b(?:SQLExecute(?:Ex)?|RunSQL|LSelect|LimSelect)\s*\(/i.test(text);
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

	const out: { object: string; line: number }[] = [];
	const seen = new Set<string>();
	const partRe = new RegExp(IDENT_PART, "g");
	const qualAtStartRe = new RegExp(`^(${QUALIFIED_NAME})`);

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
		if (seen.has(low)) return;
		seen.add(low);
		out.push({ object: bareName, line: lineAt(offset) });
	};

	const clauseRe = new RegExp(
		`\\b(?:(FROM|JOIN|INTO|UPDATE)\\s+(${QUALIFIED_NAME})|(DELETE)\\s+(?:TOP\\s*\\([^)]*\\)\\s*(?:PERCENT\\s+)?)?(?!FROM\\b)(${QUALIFIED_NAME}))`,
		"gi",
	);

	for (const m of cleaned.matchAll(clauseRe)) {
		const kw = (m[1] ?? m[3])!.toUpperCase();
		const rawName = (m[2] ?? m[4])!;
		const matchStart = m.index ?? 0;
		const matchEnd = matchStart + m[0].length;
		const before = cleaned.slice(Math.max(0, matchStart - 48), matchStart);
		const after = cleaned.slice(matchEnd, matchEnd + 16);

		// Skip `FOR UPDATE`, `ON UPDATE CASCADE`, `ON DELETE CASCADE`, `EXTRACT(x FROM y)`, `TRIM(x FROM y)`, `SUBSTRING(x FROM y)`, `FETCH ... INTO`.
		if (kw === "UPDATE" && /\b(?:FOR|ON)\s+$/i.test(before)) continue;
		if (kw === "DELETE" && /\bON\s+$/i.test(before)) continue;
		if (kw === "FROM" && /\b(?:EXTRACT|TRIM|SUBSTRING)\s*\([^)]*$/i.test(before)) continue;
		if (kw === "INTO" && /\b(?:FETCH|BULK\s+COLLECT)\b[^;]*$/i.test(before)) continue;

		// Exclude T-SQL `FROM` table aliases from `UPDATE <alias> SET ... FROM dbo.SAMPLES <alias>` and `DELETE <alias> FROM dbo.SAMPLES <alias>`.
		if (kw === "UPDATE" || kw === "DELETE") {
			const parts = [...rawName.matchAll(partRe)].map((p) => cleanIdent(p[0]!)).filter(Boolean);
			if (parts.length === 1) {
				const fromAliases = statementFromAliases(cleaned, matchEnd);
				if (fromAliases.has(parts[0]!.toLowerCase())) continue;
			}
		}

		pushTable(rawName, matchStart, after, before, kw === "FROM" || kw === "JOIN");

		// Support ANSI-89 comma joins (`FROM FOLDERS f, SAMPLES s, RESULTS r WHERE ...`).
		if (kw === "FROM") {
			let pos = consumeOptionalAliasAndHint(cleaned, matchEnd).end;
			while (pos < cleaned.length) {
				while (pos < cleaned.length && /\s/.test(cleaned[pos]!)) pos++;
				if (cleaned[pos] !== ",") break;
				pos++;
				while (pos < cleaned.length && /\s/.test(cleaned[pos]!)) pos++;
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
		}
	}
	return out;
}

/** Generates a clean fenced Mermaid `erDiagram` block from parsed SQL tables and their FK relationships. */
export function generateMermaidErDiagram(tables: readonly SqlTableDef[]): string {
	if (!tables.length) return "";
	const sanitizeIdent = (raw: string) => {
		const cleaned = raw.trim().replace(/[^A-Za-z0-9_-]+/g, "_").replace(/^_+|_+$/g, "");
		return cleaned && /^[A-Za-z_]/.test(cleaned) ? cleaned : `T_${cleaned || "TABLE"}`;
	};
	const sanitizeType = (raw: string) => {
		const compact = raw
			.trim()
			.replace(/\s*\(\s*/g, "(")
			.replace(/\s*\)/g, ")")
			.replace(/\s*,\s*/g, "_")
			.replace(/\s+/g, "_")
			.replace(/[^A-Za-z0-9_()_-]/g, "");
		return compact || "TEXT";
	};

	const lines: string[] = [];
	const rels: string[] = [];
	const seenRel = new Set<string>();

	for (const tbl of tables) {
		const entity = sanitizeIdent(tbl.tableName);
		const fkCols = new Set((tbl.foreignKeys ?? []).map((fk) => fk.column.toLowerCase()));
		lines.push(`    ${entity} {`);
		for (const col of tbl.columns) {
			const keys: string[] = [];
			if (/\bPRIMARY\s+KEY\b/i.test(col.constraints)) keys.push("PK");
			if (fkCols.has(col.name.toLowerCase())) keys.push("FK");
			if (/\bUNIQUE\b/i.test(col.constraints) && !keys.includes("PK")) keys.push("UK");
			const keySuffix = keys.length ? ` ${keys.join(",")}` : "";
			lines.push(`        ${sanitizeType(col.type)} ${sanitizeIdent(col.name)}${keySuffix}`);
		}
		lines.push("    }");
		for (const fk of tbl.foreignKeys ?? []) {
			const parent = sanitizeIdent(fk.refTable);
			const label = fk.refColumn && fk.refColumn.toLowerCase() !== fk.column.toLowerCase() ? `${fk.column} to ${fk.refColumn}` : fk.column;
			const relLine = `    ${parent} ||--o{ ${entity} : "${label.replace(/"/g, "'")}"`;
			if (!seenRel.has(relLine)) {
				seenRel.add(relLine);
				rels.push(relLine);
			}
		}
	}

	return ["```mermaid", "erDiagram", ...lines, ...rels, "```"].join("\n");
}
