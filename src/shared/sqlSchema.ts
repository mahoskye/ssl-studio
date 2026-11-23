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

/** Extracts `CREATE TABLE` definitions (plus any `ALTER TABLE ... ADD` columns) from SQL DDL text. */
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
		const bodyStart = (m.index ?? 0) + m[0].length;
		let depth = 1;
		let i = bodyStart;
		let quote: string | null = null;
		let bracket = false;
		while (i < cleaned.length && depth > 0) {
			const ch = cleaned[i]!;
			if (bracket) {
				if (ch === "]") {
					if (cleaned[i + 1] === "]") i++;
					else bracket = false;
				}
			} else if (quote) {
				if (ch === quote) {
					if (cleaned[i + 1] === quote) i++;
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
	// Also creates a stub SqlTableDef for standalone ALTER-only migration scripts when `options.includeStandaloneAlter` is enabled.
	const alterHeadRe = new RegExp(`\\bALTER\\s+TABLE\\s+(${QUALIFIED_NAME})\\s+ADD\\s+(?:COLUMN\\s+)?`, "gi");
	for (const m of masked.matchAll(alterHeadRe)) {
		const { name, bareName } = normalizeObjectName(m[1]!);
		let target = byKey.get(name.toLowerCase()) ?? byKey.get(bareName.toLowerCase());
		if (!target) {
			if (!options?.includeStandaloneAlter || !bareName || bareName.startsWith("#")) continue;
			target = { tableName: bareName || name, columns: [] };
			tables.push(target);
			byKey.set(name.toLowerCase(), target);
			if (!byKey.has(bareName.toLowerCase())) byKey.set(bareName.toLowerCase(), target);
		}
		let pos = (m.index ?? 0) + m[0].length;
		while (pos < cleaned.length && /\s/.test(cleaned[pos]!)) pos++;
		let rawSpec = "";
		if (cleaned[pos] === "(") {
			// Balanced-paren scan so `NUMBER(10,2)` / `VARCHAR2(20 BYTE)` inside Oracle `ADD (...)` never truncates early.
			let depth = 1;
			let i = pos + 1;
			let quote: string | null = null;
			let bracket = false;
			while (i < cleaned.length && depth > 0) {
				const ch = cleaned[i]!;
				if (bracket) {
					if (ch === "]") {
						if (cleaned[i + 1] === "]") i++;
						else bracket = false;
					}
				} else if (quote) {
					if (ch === quote) {
						if (cleaned[i + 1] === quote) i++;
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

/**
 * Non-destructively merges SQL DDL column definitions into an existing Markdown schema doc
 * while preserving frontmatter, surrounding prose, and hand-written `Notes` cells (ADR 0002).
 */
export function mergeSqlTablesIntoMarkdown(
	existingMarkdown: string,
	tables: readonly SqlTableDef[],
	sourceLabel?: string,
): { text: string; addedColumns: number; updatedColumns: number; addedTables: number } {
	if (!tables.length) return { text: existingMarkdown, addedColumns: 0, updatedColumns: 0, addedTables: 0 };
	const eol = existingMarkdown.includes("\r\n") ? "\r\n" : "\n";
	const lines = existingMarkdown.split(/\r?\n/);
	let addedColumns = 0;
	let updatedColumns = 0;
	let addedTables = 0;
	const esc = (s: string) => s.replace(/\|/g, "\\|");
	const stripCell = (s: string) => s.trim().replace(/^`|`$/g, "").trim();

	const splitRow = (line: string): string[] => {
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
	};

	const findTableBlock = (tableName: string): { headLine: number; tableStart: number; tableEnd: number } | null => {
		const target = tableName.toLowerCase();
		let startSearch = 0;
		let headLine = -1;
		for (let i = 0; i < lines.length; i++) {
			const hm = /^#{1,3}\s+`?([A-Za-z_][\w$.]*)`?\s*$/.exec(lines[i]!.trim());
			if (hm) {
				const hName = hm[1]!.toLowerCase();
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
			const hdr = splitRow(lines[i]!).map((c) => c.toLowerCase());
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
		const hdr = splitRow(lines[block.tableStart]!);
		const notesCol = Math.max(3, hdr.length - 1);
		const existingByCol = new Map<string, { cells: string[]; index: number }>();
		const dataLines = lines.slice(block.tableStart + 2, block.tableEnd);
		const existingOrder: string[] = [];
		dataLines.forEach((raw, idx) => {
			const cells = splitRow(raw);
			const colKey = stripCell(cells[0] ?? "").toLowerCase();
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
			const note = prev?.cells[notesCol] ?? "";
			const newType = `\`${esc(col.type)}\``;
			const newCons = esc(col.constraints || "—");
			if (!prev) {
				addedColumns++;
			} else if (stripCell(prev.cells[1] ?? "") !== col.type || (prev.cells[2] ?? "").trim() !== newCons) {
				updatedColumns++;
			}
			nextRows.push(`| \`${esc(col.name)}\` | ${newType} | ${newCons} | ${note} |`);
		}
		for (const key of existingOrder) {
			if (!seen.has(key)) {
				const prev = existingByCol.get(key)!;
				nextRows.push(dataLines[prev.index]!);
			}
		}
		lines.splice(block.tableStart + 2, block.tableEnd - (block.tableStart + 2), ...nextRows);
	}
	return { text: lines.join(eol), addedColumns, updatedColumns, addedTables };
}
