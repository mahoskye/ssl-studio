// Pure workspace Schema <-> Code bridge helpers (ADR 0003 compliant: matches identifiers
// strictly against the project's documented schema files and DDL, never parsing SSL).
import { frontMatter } from "./frontMatter";
import { isCatalog } from "./projectDocs";
import type { DocFile } from "./protocol";
import { extractQueriedTablesFromSql, parseCreateTables, sqlTablesToMarkdown } from "./sqlSchema";

const SCHEMA_EXT_RE = /\.(md|markdown|sql|ddl|pks|pkb)$/i;

/** Returns canonical lookup names (table stem, title, qualified/bare names, and multi-table `schemaObjects`) for one schema DocFile. */
export function schemaDocKeys(file: DocFile): string[] {
	if (!file.exists || file.group !== "schema" || isCatalog(file)) return [];
	const keys = new Set<string>();
	const addIdent = (raw: string) => {
		const t = raw.trim();
		if (!t || t.length < 2) return;
		keys.add(t.toLowerCase());
		if (t.includes(".")) {
			const bare = t.split(".").pop()!.trim();
			if (bare.length >= 2) keys.add(bare.toLowerCase());
		}
	};
	const base = file.name.split(/[\\/]/).pop() ?? file.name;
	const stem = base.replace(SCHEMA_EXT_RE, "").trim();
	if (stem && stem.length >= 2) keys.add(stem.toLowerCase());
	if (file.title?.trim()) {
		const t = file.title.trim();
		// Add single-token or SQL-identifier titles (e.g. `DEMO_HOLIDAYS`, `dbo.DEMO_HOLIDAYS`).
		if (/^[A-Za-z_][\w$.-]{1,64}$/.test(t)) addIdent(t);
	}
	for (const obj of file.schemaObjects ?? []) addIdent(obj);
	return [...keys];
}

export type SchemaColumnInfo = {
	table: string;
	name: string;
	type: string;
	constraints: string;
	notes: string;
	docPath: string;
};

/**
 * Extracts structured column definitions from a schema Markdown doc or SQL DDL file
 * for column-level hover cards and SQL/SSL editor completion (ADR 0003 compliant).
 */
export function extractSchemaColumns(doc: DocFile, content: string): SchemaColumnInfo[] {
	const out: SchemaColumnInfo[] = [];
	if (/\.(sql|ddl|pks|pkb)$/i.test(doc.name)) {
		for (const tbl of parseCreateTables(content, { includeStandaloneAlter: true })) {
			for (const col of tbl.columns) {
				out.push({ table: tbl.tableName, name: col.name, type: col.type, constraints: col.constraints, notes: "", docPath: doc.path });
			}
		}
		return out;
	}
	const body = frontMatter(content).body.replace(/\r\n/g, "\n");
	const lines = body.split("\n");
	const base = (doc.name.split(/[\\/]/).pop() ?? doc.name).replace(SCHEMA_EXT_RE, "");
	let currentTable = (doc.title && /^[A-Za-z_][\w$.]{1,64}$/.test(doc.title.trim()) ? doc.title.trim() : base) || base;
	const strip = (s: string) => s.trim().replace(/^`|`$/g, "").trim();
	const splitCells = (line: string) =>
		line
			.trim()
			.replace(/^\|/, "")
			.replace(/\|$/, "")
			.split(/(?<!\\)\|/)
			.map((c) => c.replace(/\\\|/g, "|").trim());

	for (let i = 0; i < lines.length; i++) {
		const line = lines[i]!;
		const hm = /^#{1,3}\s+`?([A-Za-z_][\w$.]{1,64})`?\s*$/.exec(line.trim());
		if (hm) {
			currentTable = hm[1]!;
			continue;
		}
		if (!line.trim().startsWith("|")) continue;
		const hdr = splitCells(line).map((c) => c.toLowerCase());
		const colIdx = hdr.findIndex((c) => c === "column" || c === "field" || c === "name");
		if (colIdx < 0 || i + 1 >= lines.length || !/^\s*\|?\s*:?-{2,}/.test(lines[i + 1]!)) continue;
		const typeIdx = hdr.findIndex((c) => c.includes("type"));
		const consIdx = hdr.findIndex((c) => c.includes("constraint") || c.includes("key") || c.includes("null"));
		const noteIdx = hdr.findIndex((c) => c.includes("note") || c.includes("desc") || c.includes("meaning"));
		i += 2;
		for (; i < lines.length && lines[i]!.trim().startsWith("|"); i++) {
			const cells = splitCells(lines[i]!);
			const colName = strip(cells[colIdx] ?? "");
			if (!colName || colName === "…" || colName.startsWith("(")) continue;
			out.push({
				table: currentTable,
				name: colName,
				type: typeIdx >= 0 ? strip(cells[typeIdx] ?? "") : "",
				constraints: consIdx >= 0 ? (cells[consIdx] ?? "") : "",
				notes: noteIdx >= 0 ? (cells[noteIdx] ?? "") : "",
				docPath: doc.path,
			});
		}
		i--;
	}
	return out;
}

/** Finds the best documented schema file (`schema/database/*.md` preferred over `.sql`) matching SQL/SSL identifier `word`. */
export function findSchemaDocForIdentifier(word: string, files: readonly DocFile[]): DocFile | null {
	const raw = word.trim().replace(/^[[`"]|[\]`"]$/g, "");
	if (!raw || raw.length < 2) return null;
	const lower = raw.toLowerCase();
	const bare = lower.includes(".") ? lower.split(".").pop()! : lower;
	const candidates = files.filter((f) => f.exists && f.group === "schema" && !isCatalog(f));
	let sqlFallback: DocFile | null = null;
	for (const doc of candidates) {
		const keys = schemaDocKeys(doc);
		if (!keys.includes(lower) && !keys.includes(bare)) continue;
		if (/\.(md|markdown)$/i.test(doc.name)) return doc;
		if (!sqlFallback) sqlFallback = doc;
	}
	return sqlFallback;
}

/**
 * Extracts a compact Markdown preview (summary + column table, up to `maxRows` rows) from a schema
 * Markdown file or SQL DDL file for inline hover cards and targeted Agent context injection.
 */
export function extractSchemaPreview(doc: DocFile, content: string, maxRows = 16): string {
	if (/\.(sql|ddl|pks|pkb)$/i.test(doc.name)) {
		const tables = parseCreateTables(content);
		if (!tables.length) return doc.summary ? `${doc.title || doc.name}: ${doc.summary}` : doc.title || doc.name;
		const md = sqlTablesToMarkdown(tables.slice(0, 3));
		return md.split(/\r?\n/).slice(0, maxRows + 8).join("\n").trim();
	}
	const body = frontMatter(content).body.replace(/\r\n/g, "\n").trim();
	const lines = body.split("\n");
	const out: string[] = [];
	let tableRows = 0;
	let inTable = false;
	for (const line of lines) {
		const trimmed = line.trim();
		if (trimmed.startsWith("|")) {
			inTable = true;
			tableRows++;
			if (tableRows <= maxRows + 2) out.push(line);
			else if (tableRows === maxRows + 3) out.push(`| … | (${lines.filter((l) => l.trim().startsWith("|")).length - maxRows - 2} more rows) | | |`);
			continue;
		}
		if (inTable) {
			// Stop after the first column table so hover cards stay concise.
			break;
		}
		if (out.length < 8) out.push(line);
	}
	return out.join("\n").trim();
}

/**
 * Scans `codeText` (an SSL/SQL script or selection) for whole-word references to documented
 * schema tables/objects (e.g. `DEMO_HOLIDAYS`, `DEMO_OUTAGES`) so the Agent can inject their
 * exact column definitions instead of a generic 25-table summary.
 */
export function referencedSchemaTables(codeText: string, files: readonly DocFile[], limit = 8): DocFile[] {
	if (!codeText.trim()) return [];
	const schemaDocs = files.filter((f) => f.exists && f.group === "schema" && !isCatalog(f) && /\.(md|markdown|sql|ddl|pks|pkb)$/i.test(f.name));
	if (!schemaDocs.length) return [];
	// Prefer Markdown docs over SQL when both share a stem.
	const ordered = [...schemaDocs].sort((a, b) => {
		const aMd = /\.(md|markdown)$/i.test(a.name) ? 0 : 1;
		const bMd = /\.(md|markdown)$/i.test(b.name) ? 0 : 1;
		return aMd - bMd || a.name.localeCompare(b.name, undefined, { sensitivity: "base" });
	});
	const found: DocFile[] = [];
	const seenKeys = new Set<string>();
	for (const doc of ordered) {
		const keys = schemaDocKeys(doc).filter((k) => k.length >= 3);
		if (!keys.length) continue;
		const matched = keys.find((k) => {
			if (seenKeys.has(k)) return false;
			const esc = k.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
			return new RegExp(`(?<![A-Za-z0-9_])${esc}(?![A-Za-z0-9_])`, "i").test(codeText);
		});
		if (matched) {
			for (const k of keys) seenKeys.add(k);
			found.push(doc);
			if (found.length >= limit) break;
		}
	}
	return found;
}

const BUILTIN_SQL_OBJECTS = new Set([
	"dual",
	"inserted",
	"deleted",
	"sysobjects",
	"syscolumns",
	"systypes",
	"sysindexes",
	"sysusers",
	"sysdatabases",
	"syscomments",
	"sysfiles",
	"sysprocesses",
]);

const SYSTEM_OBJECT_PREFIX_RE = /^(?:sys_|dba_|all_|user_|v\$|gv\$|cdb_|nls_|pg_|sqlite_)/i;

/**
 * Flags `.sql` and STARLIMS `.ds` references to tables that are not documented in `schema/`
 * or `database.csv`, filtering out standard SQL built-ins, CTEs, temp `#tables`, `dual`,
 * and database system catalog tables.
 */
export function findUndocumentedSqlRefs(
	files: readonly { path: string; text: string }[],
	knownTables: ReadonlySet<string>,
): { path: string; line: number; object: string; kind: "table" }[] {
	const knownLower = new Set<string>();
	for (const entry of knownTables) {
		const t = entry.trim().toLowerCase();
		if (!t) continue;
		knownLower.add(t);
		if (t.includes(".")) {
			const bare = t.split(".").pop()!.trim();
			if (bare) knownLower.add(bare);
		}
	}
	const out: { path: string; line: number; object: string; kind: "table" }[] = [];
	for (const file of files) {
		if (!file.text.trim()) continue;
		for (const hit of extractQueriedTablesFromSql(file.text)) {
			const low = hit.object.toLowerCase();
			const bare = low.includes(".") ? low.split(".").pop()! : low;
			if (!bare || bare.length < 2) continue;
			if (bare.startsWith("#") || bare.startsWith("@") || bare.startsWith("?")) continue;
			if (BUILTIN_SQL_OBJECTS.has(bare) || SYSTEM_OBJECT_PREFIX_RE.test(bare)) continue;
			if (knownLower.has(low) || knownLower.has(bare)) continue;
			out.push({ path: file.path, line: hit.line, object: hit.object, kind: "table" });
		}
	}
	return out;
}
