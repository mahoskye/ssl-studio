// Unified, pure SQL DDL inspection helpers for STARLIMS schema docs and
// `docs/registries/database.csv` reconciliation. Handles SQL Server (T-SQL / SSMS)
// and Oracle (PL/SQL / DBMS_METADATA) DDL cleanly without executing anything.

export type SqlObjectEntry = {
	/** Schema-qualified name when present (`dbo.FOLDERS`), else bare name (`FOLDERS`). */
	name: string;
	/** Bare object name without schema prefix (`FOLDERS`). */
	bareName: string;
	kind: "table" | "view" | "procedure" | "function" | "trigger" | "sequence" | "package" | "index";
};

export type SqlColumnDef = {
	name: string;
	type: string;
	constraints: string;
};

export type SqlTableDef = {
	tableName: string;
	columns: SqlColumnDef[];
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
 * Extracts created database object names and kinds from SQL Server (T-SQL) and Oracle (PL/SQL) DDL.
 * Excludes indexes by default (matching `database.csv` conventions), and preserves 2-part schema prefixes.
 */
export function extractSqlObjects(sql: string, options: { includeIndexes?: boolean } = {}): SqlObjectEntry[] {
	const cleaned = sanitizeSql(sql, true);
	const out: SqlObjectEntry[] = [];
	const seen = new Set<string>();
	const modifiers =
		"(?:OR\\s+(?:REPLACE|ALTER)|UNIQUE|CLUSTERED|NONCLUSTERED|BITMAP|COLUMNSTORE|MATERIALIZED|GLOBAL\\s+TEMPORARY|PRIVATE\\s+TEMPORARY|LOCAL\\s+TEMPORARY|TEMPORARY|TEMP|FORCE|NOFORCE|EDITIONABLE|NONEDITIONABLE)";
	const re = new RegExp(
		`\\bCREATE\\s+(?:${modifiers}\\s+)*(TABLE|VIEW|PROC(?:EDURE)?|FUNCTION|TRIGGER|SEQUENCE|PACKAGE(?:\\s+BODY)?|INDEX)\\s+(?:IF\\s+NOT\\s+EXISTS\\s+)?(${QUALIFIED_NAME})`,
		"gi",
	);
	for (const m of cleaned.matchAll(re)) {
		const rawKind = m[1]!.toUpperCase();
		let kind: SqlObjectEntry["kind"] = "table";
		if (rawKind.startsWith("VIEW")) kind = "view";
		else if (rawKind.startsWith("PROC")) kind = "procedure";
		else if (rawKind.startsWith("FUNC")) kind = "function";
		else if (rawKind.startsWith("TRIG")) kind = "trigger";
		else if (rawKind.startsWith("SEQ")) kind = "sequence";
		else if (rawKind.startsWith("PACK")) kind = "package";
		else if (rawKind.startsWith("INDEX")) kind = "index";
		if (kind === "index" && !options.includeIndexes) continue;

		const { name, bareName } = normalizeObjectName(m[2]!);
		// Skip SQL Server local/global temp tables (`#Temp`, `##Temp`) declared inside procedures/scripts.
		if (!name || bareName.startsWith("#")) continue;
		const key = `${kind}:${name.toLowerCase()}`;
		if (seen.has(key)) continue;
		seen.add(key);
		out.push({ name, bareName, kind });
	}
	return out;
}

/** Splits a parenthesized SQL column list on top-level commas (respecting nested parens and quotes). */
function splitTopLevelCommas(body: string): string[] {
	const parts: string[] = [];
	let cur = "";
	let depth = 0;
	let quote: string | null = null;
	for (let i = 0; i < body.length; i++) {
		const ch = body[i]!;
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

/** Extracts `CREATE TABLE` definitions (plus any `ALTER TABLE ... ADD` columns) from SQL DDL text. */
export function parseCreateTables(sql: string): SqlTableDef[] {
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
		const bodyStart = (m.index ?? 0) + m[0].length;
		let depth = 1;
		let i = bodyStart;
		let quote: string | null = null;
		while (i < cleaned.length && depth > 0) {
			const ch = cleaned[i]!;
			if (quote) {
				if (ch === quote) {
					if (cleaned[i + 1] === quote) i++;
					else quote = null;
				}
			} else if (ch === "'" || ch === '"') {
				quote = ch;
			} else if (ch === "(") {
				depth++;
			} else if (ch === ")") {
				depth--;
			}
			i++;
		}
		if (depth !== 0) continue;
		const body = cleaned.slice(bodyStart, i - 1);
		const columns: SqlColumnDef[] = [];
		for (const item of splitTopLevelCommas(body)) {
			const parsed = parseColumnClause(item);
			if (parsed) columns.push(parsed);
		}
		const def: SqlTableDef = { tableName, columns };
		tables.push(def);
		byKey.set(name.toLowerCase(), def);
		if (!byKey.has(bareName.toLowerCase())) byKey.set(bareName.toLowerCase(), def);
	}

	// Enrich matching tables with columns added via `ALTER TABLE <name> ADD (...)` (Oracle balanced parens)
	// or unparenthesized `ALTER TABLE <name> ADD col type` (T-SQL ending at `;`, standalone `GO`, or next DDL statement).
	const alterHeadRe = new RegExp(`\\bALTER\\s+TABLE\\s+(${QUALIFIED_NAME})\\s+ADD\\s+(?:COLUMN\\s+)?`, "gi");
	for (const m of masked.matchAll(alterHeadRe)) {
		const { name, bareName } = normalizeObjectName(m[1]!);
		const target = byKey.get(name.toLowerCase()) ?? byKey.get(bareName.toLowerCase());
		if (!target) continue;
		let pos = (m.index ?? 0) + m[0].length;
		while (pos < cleaned.length && /\s/.test(cleaned[pos]!)) pos++;
		let rawSpec = "";
		if (cleaned[pos] === "(") {
			// Balanced-paren scan so `NUMBER(10,2)` / `VARCHAR2(20 BYTE)` inside Oracle `ADD (...)` never truncates early.
			let depth = 1;
			let i = pos + 1;
			let quote: string | null = null;
			while (i < cleaned.length && depth > 0) {
				const ch = cleaned[i]!;
				if (quote) {
					if (ch === quote) {
						if (cleaned[i + 1] === quote) i++;
						else quote = null;
					}
				} else if (ch === "'" || ch === '"') {
					quote = ch;
				} else if (ch === "(") {
					depth++;
				} else if (ch === ")") {
					depth--;
				}
				i++;
			}
			if (depth === 0) rawSpec = cleaned.slice(pos + 1, i - 1).trim();
		} else {
			// Unparenthesized T-SQL/ANSI `ADD col1 type1, col2 type2`: terminate at `;`, standalone `GO`, or next DDL keyword.
			const restMasked = masked.slice(pos);
			const stopMatch = /;|(?:^|\r?\n)[ \t]*GO[ \t]*(?=\r?\n|$)|(?:\r?\n[ \t]*|\b)(?:CREATE|ALTER|DROP|GRANT|REVOKE|EXEC(?:UTE)?)\b/i.exec(restMasked);
			const end = stopMatch ? pos + stopMatch.index : cleaned.length;
			rawSpec = cleaned.slice(pos, end).trim();
		}
		if (!rawSpec) continue;
		for (const item of splitTopLevelCommas(rawSpec)) {
			const col = parseColumnClause(item);
			if (col && !target.columns.some((c) => c.name.toLowerCase() === col.name.toLowerCase())) {
				target.columns.push(col);
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
