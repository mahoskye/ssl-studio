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
};

export type SqlForeignKeyDef = {
	column: string;
	refTable: string;
	refColumn?: string;
};

export type SqlTableDef = {
	tableName: string;
	columns: SqlColumnDef[];
	foreignKeys?: SqlForeignKeyDef[];
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

	// Apply ALTER TABLE ADD / DROP COLUMN / ALTER COLUMN / MODIFY statements in exact source order.
	const alterRe = new RegExp(`\\bALTER\\s+TABLE\\s+(${QUALIFIED_NAME})\\s+(ADD|DROP|ALTER|MODIFY)\\b`, "gi");
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

	for (const m of masked.matchAll(alterRe)) {
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

/** Formats parsed `CREATE TABLE` definitions into a clean Markdown schema document. */
export function sqlTablesToMarkdown(tables: readonly SqlTableDef[], sourceLabel?: string): string {
	if (!tables.length) return "";
	const blocks: string[] = [];
	for (const t of tables) {
		const lines: string[] = [`## ${t.tableName}`, ""];
		if (sourceLabel) lines.push(`Generated from \`${sourceLabel}\`.`, "");
		lines.push("| Column | Type | Constraints | Notes |");
		lines.push("| --- | --- | --- | --- |");
		for (const col of t.columns) {
			const esc = (s: string) => s.replace(/\|/g, "\\|");
			lines.push(`| \`${esc(col.name)}\` | \`${esc(col.type)}\` | ${esc(col.constraints || "—")} |  |`);
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

const stripMarkdownCell = (s: string) => s.trim().replace(/^`|`$/g, "").trim();

/**
 * Non-destructively merges SQL DDL column definitions into an existing Markdown schema doc
 * while preserving frontmatter, surrounding prose, and hand-written `Notes` cells (ADR 0002).
 * Columns absent from SQL are preserved and clearly tagged `[deprecated / dropped in SQL]`.
 */
export function mergeSqlTablesIntoMarkdown(
	existingMarkdown: string,
	tables: readonly SqlTableDef[],
	sourceLabel?: string,
): { text: string; addedColumns: number; updatedColumns: number; addedTables: number; droppedColumns: number } {
	if (!tables.length) return { text: existingMarkdown, addedColumns: 0, updatedColumns: 0, addedTables: 0, droppedColumns: 0 };
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
			if (headLine >= 0 && /^#{1,2}\s+/.test(lines[i]!)) break;
			if (!lines[i]!.trim().startsWith("|")) continue;
			const hdr = splitMarkdownRow(lines[i]!).map((c) => c.toLowerCase());
			if (!hdr[0]?.includes("column")) continue;
			if (i + 1 >= lines.length || !/^\s*\|?\s*:?-{2,}/.test(lines[i + 1]!)) continue;
			let end = i + 2;
			while (end < lines.length && lines[end]!.trim().startsWith("|")) end++;
			return { headLine, tableStart: i, tableEnd: end };
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
			const note = rawNote.replace(/\s*\[deprecated\s*\/\s*dropped in sql\]/gi, "").trim();
			const newType = `\`${esc(col.type)}\``;
			const newCons = esc(col.constraints || "—");
			if (!prev) {
				addedColumns++;
			} else if (stripMarkdownCell(prev.cells[1] ?? "") !== col.type || (prev.cells[2] ?? "").trim() !== newCons || rawNote !== note) {
				updatedColumns++;
			}
			nextRows.push(`| \`${esc(col.name)}\` | ${newType} | ${newCons} | ${note} |`);
		}
		for (const key of existingOrder) {
			if (!seen.has(key)) {
				const prev = existingByCol.get(key)!;
				const alreadyMarked = prev.cells.some((c) => DROPPED_NOTE_RE.test(c));
				if (alreadyMarked) {
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
	}
	return { text: lines.join(eol), addedColumns, updatedColumns, addedTables, droppedColumns };
}

type DocTableCols = {
	tableName: string;
	hasConstraintsCol: boolean;
	hasNullCol: boolean;
	columns: Map<string, { name: string; type: string; constraints: string; notes: string }>;
};

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
	let inFence = false;
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
			currentTable = hm[1]!.trim();
			continue;
		}
		if (!trimmed.startsWith("|")) continue;
		const hdr = splitMarkdownRow(raw).map((c) => c.toLowerCase());
		const colIdx = hdr.findIndex((c) => c === "column" || c === "field" || c === "name");
		if (colIdx < 0 || i + 1 >= lines.length || !/^\s*\|?\s*:?-{2,}/.test(lines[i + 1]!)) continue;
		const typeIdx = hdr.findIndex((c) => c.includes("type"));
		const consIdx = hdr.findIndex((c) => c.includes("constraint") || c.includes("key") || c.includes("null"));
		const noteIdx = hdr.findIndex((c) => c.includes("note") || c.includes("desc") || c.includes("meaning"));
		const hasNullCol = consIdx >= 0 && hdr[consIdx]!.includes("null");
		const hasConstraintsCol = consIdx >= 0 && !hasNullCol;
		const cols = new Map<string, { name: string; type: string; constraints: string; notes: string }>();
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
		}
		i--;
		out.push({ tableName: currentTable, hasConstraintsCol, hasNullCol, columns: cols });
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
 * Compares effective SQL DDL columns (after `CREATE TABLE` + `ALTER TABLE ADD/DROP/ALTER/MODIFY`)
 * against documented Markdown schema table columns, returning tables with any drift.
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

	for (const sqlTbl of sqlTables) {
		const docTbl = findDocTable(sqlTbl.tableName);
		if (!docTbl) {
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

/** Extracts SQL strings embedded inside STARLIMS SSL `.ds` files while preserving exact line numbers. */
function extractSslEmbeddedSql(text: string): string {
	let out = "";
	let i = 0;
	const n = text.length;
	while (i < n) {
		const ch = text[i]!;
		const next = text[i + 1];
		// SSL comment `/* ... ;` (or `/* ... */` whichever terminates first).
		if (ch === "/" && next === "*") {
			out += "  ";
			i += 2;
			while (i < n) {
				if (text[i] === "*" && text[i + 1] === "/") {
					out += "  ";
					i += 2;
					break;
				}
				if (text[i] === ";") {
					out += " ";
					i++;
					break;
				}
				out += text[i] === "\n" ? "\n" : " ";
				i++;
			}
			continue;
		}
		if (ch === "/" && next === "/") {
			while (i < n && text[i] !== "\n") {
				out += " ";
				i++;
			}
			continue;
		}
		if (ch === '"' || ch === "'") {
			const q = ch;
			out += " ";
			i++;
			while (i < n && text[i] !== q) {
				if (text[i] === "\\" && i + 1 < n) {
					out += text[i + 1] === "\n" ? "\n" : "  ";
					i += 2;
					continue;
				}
				out += text[i]!;
				i++;
			}
			if (i < n) {
				out += " ";
				i++;
			}
			continue;
		}
		out += ch === "\n" ? "\n" : " ";
		i++;
	}
	return out;
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

/**
 * Extracts queried/mutated table names after `FROM` / `JOIN` / `INTO` / `UPDATE` in `.sql`
 * and STARLIMS `.ds` Data Sources, ignoring CTE names, `#temp` tables, SQL keywords,
 * system catalogs (`sys.*`, `information_schema.*`), and comments.
 */
export function extractQueriedTablesFromSql(text: string): { object: string; line: number }[] {
	if (!text.trim()) return [];
	const looksLikeSslDs = /^\s*:(?:PARAMETERS|DECLARE|RETURN|IF|FOR|PROCEDURE)\b/im.test(text) || /\bSQLExecute\s*\(/i.test(text);
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
	const clauseRe = new RegExp(`\\b(FROM|JOIN|INTO|UPDATE)\\s+(${QUALIFIED_NAME})`, "gi");

	for (const m of cleaned.matchAll(clauseRe)) {
		const kw = m[1]!.toUpperCase();
		const rawName = m[2]!;
		const matchStart = m.index ?? 0;
		const matchEnd = matchStart + m[0].length;
		const before = cleaned.slice(Math.max(0, matchStart - 48), matchStart);
		const after = cleaned.slice(matchEnd, matchEnd + 16);

		// Skip `FOR UPDATE`, `ON UPDATE CASCADE`, `EXTRACT(x FROM y)`, `TRIM(x FROM y)`, `SUBSTRING(x FROM y)`, `FETCH ... INTO`.
		if (kw === "UPDATE" && /\b(?:FOR|ON)\s+$/i.test(before)) continue;
		if (kw === "FROM" && /\b(?:EXTRACT|TRIM|SUBSTRING)\s*\([^)]*$/i.test(before)) continue;
		if (kw === "INTO" && /\b(?:FETCH|BULK\s+COLLECT)\b[^;]*$/i.test(before)) continue;
		// Skip STARLIMS parameter placeholders (`?sTable?`) and table-valued functions (`FROM dbo.fn_Split(...)`).
		if (before.endsWith("?") || after.startsWith("?")) continue;
		if ((kw === "FROM" || kw === "JOIN") && /^\s*\(/.test(after)) continue;

		const partRe = new RegExp(IDENT_PART, "g");
		const parts = [...rawName.matchAll(partRe)].map((p) => cleanIdent(p[0]!)).filter(Boolean);
		if (!parts.length) continue;
		const bareName = parts[parts.length - 1]!;
		const schemaName = parts.length >= 2 ? parts[parts.length - 2]!.toLowerCase() : "";

		if (!bareName || bareName.length < 2) continue;
		if (bareName.startsWith("#") || bareName.startsWith("@")) continue;
		if (schemaName && SYSTEM_SCHEMAS.has(schemaName)) continue;
		const low = bareName.toLowerCase();
		if (SQL_QUERY_KEYWORDS.has(low) || cteNames.has(low)) continue;

		if (seen.has(low)) continue;
		seen.add(low);
		out.push({ object: bareName, line: lineAt(matchStart) });
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
