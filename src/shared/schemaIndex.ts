// Pure workspace Schema <-> Code bridge helpers (ADR 0003 compliant: matches identifiers
// strictly against the project's documented schema files and DDL, never parsing SSL).
import { frontMatter } from "./frontMatter";
import { isCatalog } from "./projectDocs";
import type { DocFile } from "./protocol";
import { extractQueriedTablesFromSql, parseCreateTables, sqlTablesToMarkdown } from "./sqlSchema";

const SCHEMA_EXT_RE = /\.(md|markdown|sql|ddl|pks|pkb)$/i;
const DROPPED_NOTE_RE = /\[deprecated\s*\/\s*dropped in sql\]/i;

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

/** Returns canonical lookup names (table stem, title, qualified/bare names, and multi-table `schemaObjects`) for one schema DocFile. */
export function schemaDocKeys(file: DocFile): string[] {
	if (!file.exists || file.group !== "schema" || isCatalog(file) || !SCHEMA_EXT_RE.test(file.name)) return [];
	const keys = new Set<string>();
	const addIdent = (raw: string) => {
		const t = raw.trim();
		if (!t || t.length < 2 || /^readme$/i.test(t)) return;
		keys.add(t.toLowerCase());
		if (t.includes(".")) {
			const bare = t.split(".").pop()!.trim();
			if (bare.length >= 2 && !/^readme$/i.test(bare)) keys.add(bare.toLowerCase());
		}
	};
	const base = file.name.split(/[\\/]/).pop() ?? file.name;
	const stem = base.replace(SCHEMA_EXT_RE, "").trim();
	if (/^readme$/i.test(stem)) return [];
	if (stem) addIdent(stem);
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
				out.push({
					table: tbl.tableName,
					name: col.name,
					type: col.type,
					constraints: col.constraints,
					notes: col.comment ?? "",
					docPath: doc.path,
				});
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

	const subHeadingRe = /^(?:columns?|fields?|foreign\s+keys?|indexes?|indices|keys?|constraints?|triggers?|notes?|rules?|usage|examples?|history|relationships?)$/i;
	let inNonColumnSub = false;
	let fence: FenceState = null;
	for (let i = 0; i < lines.length; i++) {
		const line = lines[i]!;
		const nextFence = updateFenceState(line, fence);
		if (nextFence !== fence) {
			fence = nextFence;
			continue;
		}
		if (fence) continue;
		const hm = /^#{1,3}\s+`?([A-Za-z_][\w$. ]{1,64})`?\s*$/.exec(line.trim());
		if (hm) {
			const hText = hm[1]!.trim();
			if (/^columns?$|^fields?$/i.test(hText)) {
				inNonColumnSub = false;
			} else if (subHeadingRe.test(hText)) {
				inNonColumnSub = true;
			} else if (/^[A-Za-z_][\w$.]{1,64}$/.test(hText)) {
				currentTable = hText;
				inNonColumnSub = false;
			}
			continue;
		}
		if (inNonColumnSub || !line.trim().startsWith("|")) continue;
		if (i + 1 >= lines.length || !/^\s*\|?\s*:?-{2,}/.test(lines[i + 1]!)) continue;
		const hdr = splitCells(line).map((c) => strip(c).toLowerCase());
		const isFkOrIdx =
			!hdr.some((c) => c.includes("type")) &&
			(hdr.some((c) => c.includes("reference") || c.includes("target")) ||
				(hdr.some((c) => c === "columns" || c === "column" || c === "fields") &&
					hdr.some((c) => c === "unique" || c === "uniqueness" || c === "index" || c === "index name" || c === "name")));
		if (isFkOrIdx) {
			i += 2;
			while (i < lines.length && lines[i]!.trim().startsWith("|")) i++;
			i--;
			continue;
		}
		const colIdx = hdr.findIndex((c) => c === "column" || c === "field" || c === "name");
		const typeIdx = hdr.findIndex((c, ci) => ci !== colIdx && c.includes("type"));
		const consIdx = hdr.findIndex((c, ci) => ci !== colIdx && ci !== typeIdx && (c.includes("constraint") || c.includes("key") || c.includes("null")));
		if (colIdx < 0 || (hdr[colIdx] === "name" && typeIdx < 0 && consIdx < 0)) {
			i += 2;
			while (i < lines.length && lines[i]!.trim().startsWith("|")) i++;
			i--;
			continue;
		}
		const noteIdx = hdr.findIndex(
			(c, ci) =>
				ci !== colIdx &&
				ci !== typeIdx &&
				ci !== consIdx &&
				(c.includes("note") || c.includes("desc") || c.includes("meaning") || c.includes("holds") || c.includes("what")),
		);
		i += 2;
		for (; i < lines.length && lines[i]!.trim().startsWith("|"); i++) {
			const cells = splitCells(lines[i]!);
			const colName = strip(cells[colIdx] ?? "");
			if (!colName || colName === "…" || colName.startsWith("(")) continue;
			const constraints = consIdx >= 0 ? (cells[consIdx] ?? "") : "";
			const notes = noteIdx >= 0 ? (cells[noteIdx] ?? "") : "";
			if (DROPPED_NOTE_RE.test(notes) || DROPPED_NOTE_RE.test(constraints)) continue;
			out.push({
				table: currentTable,
				name: colName,
				type: typeIdx >= 0 ? strip(cells[typeIdx] ?? "") : "",
				constraints,
				notes,
				docPath: doc.path,
			});
		}
		i--;
	}
	return out;
}

/** Finds the best documented schema file (`schema/database/*.md` preferred over `.sql`, exact qualified match preferred over bare fallback) matching SQL/SSL identifier `word`. */
export function findSchemaDocForIdentifier(word: string, files: readonly DocFile[]): DocFile | null {
	const segRe = /(?:\[[^\]]+\]|"[^"]+"|`[^`]+`|[^.\s]+)/g;
	const segments = [...word.trim().matchAll(segRe)]
		.map((m) => m[0]!.trim().replace(/^[[`"]|[\]`"]$/g, "").trim())
		.filter(Boolean);
	if (!segments.length) return null;
	const bare = segments[segments.length - 1]!.toLowerCase();
	if (bare.length < 2) return null;
	const lower = segments.length >= 2 ? `${segments[segments.length - 2]!.toLowerCase()}.${bare}` : bare;

	const candidates = files.filter((f) => f.exists && f.group === "schema" && !isCatalog(f) && SCHEMA_EXT_RE.test(f.name));
	let exactSql: DocFile | null = null;
	let bareMd: DocFile | null = null;
	let bareSql: DocFile | null = null;
	for (const doc of candidates) {
		const keys = schemaDocKeys(doc);
		const isMd = /\.(md|markdown)$/i.test(doc.name);
		if (keys.includes(lower)) {
			if (isMd) return doc;
			if (!exactSql) exactSql = doc;
			continue;
		}
		if (bare !== lower && keys.includes(bare)) {
			if (isMd) {
				if (!bareMd) bareMd = doc;
			} else if (!bareSql) {
				bareSql = doc;
			}
		}
	}
	return exactSql ?? bareMd ?? bareSql;
}

/**
 * Extracts a compact Markdown preview (summary + column table, up to `maxRows` rows) from a schema
 * Markdown file or SQL DDL file for inline hover cards and targeted Agent context injection.
 */
export function extractSchemaPreview(doc: DocFile, content: string, maxRows = 16): string {
	if (/\.(sql|ddl|pks|pkb)$/i.test(doc.name)) {
		const tables = parseCreateTables(content, { includeStandaloneAlter: true });
		if (!tables.length) return doc.summary ? `${doc.title || doc.name}: ${doc.summary}` : doc.title || doc.name;
		const md = sqlTablesToMarkdown(tables.slice(0, 3));
		return md.split(/\r?\n/).slice(0, maxRows + 8).join("\n").trim();
	}
	const body = frontMatter(content).body.replace(/\r\n/g, "\n").trim();
	const lines = body.split("\n");
	const out: string[] = [];
	let tableRows = 0;
	let tableTotalRows = 0;
	let inTable = false;
	let fence: FenceState = null;
	for (let idx = 0; idx < lines.length; idx++) {
		const line = lines[idx]!;
		const nextFence = updateFenceState(line, fence);
		if (nextFence !== fence) {
			fence = nextFence;
			if (inTable) break;
			continue;
		}
		if (fence) continue;
		const trimmed = line.trim();
		if (trimmed.startsWith("|")) {
			if (!inTable) {
				inTable = true;
				let end = idx;
				while (end < lines.length && lines[end]!.trim().startsWith("|")) end++;
				tableTotalRows = end - idx;
			}
			tableRows++;
			if (tableRows <= maxRows + 2) out.push(line);
			else if (tableRows === maxRows + 3) {
				const remaining = tableTotalRows - maxRows - 2;
				if (remaining > 0) out.push(`| … | (${remaining} more ${remaining === 1 ? "row" : "rows"}) | | |`);
			}
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

const TWO_CHAR_STOP_WORDS = new Set([
	"if", "to", "in", "on", "as", "or", "by", "is", "of", "at", "no", "do", "go", "id",
	"an", "be", "he", "it", "me", "my", "so", "up", "us", "we", "ok", "eq", "ne", "gt", "lt", "ge", "le",
]);

/**
 * Scans `codeText` (an SSL/SQL script or selection) in O(N) time for whole-identifier references
 * to documented schema tables/objects (e.g. `DEMO_HOLIDAYS`, `DEMO_OUTAGES`) so the Agent can inject
 * their exact column definitions instead of a generic 25-table summary.
 *
 * The text is searched as it is given: a caller that does not want a name in a comment to count gives it without
 * its comments (`withoutComments` in `src/view/lsp/facts.ts`). This used to take the comments out itself, with one
 * reader for SQL and SSL at once that read SSL by hand (ADR 0003): it ended an SSL comment at a `*\/` where one
 * came later in the file and honoured a backslash in a string, neither of which SSL does. Where SSL's comments are
 * is now asked of the language server.
 */
export function referencedSchemaTables(codeText: string, files: readonly DocFile[], limit = 8): DocFile[] {
	if (!codeText.trim()) return [];
	const schemaDocs = files.filter((f) => f.exists && f.group === "schema" && !isCatalog(f) && SCHEMA_EXT_RE.test(f.name));
	if (!schemaDocs.length) return [];

	// Tokenize into a lowercase Set for O(1) per-key lookup.
	// Normalize bracketed/quoted dot-joins (`[dbo].[ORDERS]` -> `dbo.ORDERS`) without breaking `$`/`#` word boundaries.
	const stripped = codeText.replace(/[\]"`]\s*\.\s*[\["`]/g, ".");
	const tokens = new Set<string>();
	const tokenRe = /[A-Za-z_][A-Za-z0-9_$#]*(?:\.[A-Za-z_][A-Za-z0-9_$#]*)*/g;
	for (const m of stripped.matchAll(tokenRe)) {
		const low = m[0]!.toLowerCase();
		tokens.add(low);
		if (low.includes(".")) {
			const segs = low.split(".");
			for (const seg of segs) {
				if (seg) tokens.add(seg);
			}
			for (let s = 0; s + 1 < segs.length; s++) {
				tokens.add(`${segs[s]}.${segs[s + 1]}`);
			}
		}
	}
	if (!tokens.size) return [];

	// Prefer Markdown docs over SQL when both share a stem.
	const ordered = [...schemaDocs].sort((a, b) => {
		const aMd = /\.(md|markdown)$/i.test(a.name) ? 0 : 1;
		const bMd = /\.(md|markdown)$/i.test(b.name) ? 0 : 1;
		return aMd - bMd || a.name.localeCompare(b.name, undefined, { sensitivity: "base" });
	});
	const found: DocFile[] = [];
	const seenKeys = new Set<string>();
	for (const doc of ordered) {
		const keys = schemaDocKeys(doc).filter((k) => k.length >= 3 || (k.length === 2 && !TWO_CHAR_STOP_WORDS.has(k)));
		if (!keys.length) continue;
		const matched = keys.find((k) => !seenKeys.has(k) && tokens.has(k));
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

export type SchemaUsageCategory = "data-sources" | "scripts" | "tests" | "other" | "registries";

export type SchemaUsageHit = {
	line: number;
	text: string;
};

export type SchemaUsageEntry = {
	path: string;
	rel: string;
	/** Primary display label (`SaveDueDates.ssl` for code, or friendly title `Database objects` for registries). */
	name: string;
	/** Underlying filename with extension (used for file-type icons). */
	fileName: string;
	/** Secondary location metadata (`src/DueDates` for code, or `database.csv` for registries). */
	dir: string;
	category: SchemaUsageCategory;
	hits: SchemaUsageHit[];
	count: number;
};

export type SchemaUsageGroup = {
	id: SchemaUsageCategory;
	label: string;
	items: SchemaUsageEntry[];
	totalHits: number;
};

const USAGE_GROUP_META: readonly { id: SchemaUsageCategory; label: string }[] = [
	{ id: "data-sources", label: "Data sources" },
	{ id: "scripts", label: "Scripts" },
	{ id: "tests", label: "Tests" },
	{ id: "other", label: "Other files" },
	{ id: "registries", label: "Registries" },
];

const trimUsageSnippet = (raw: string, maxLen = 140): string => {
	const compact = raw.replace(/\s+/g, " ").trim();
	return compact.length > maxLen ? `${compact.slice(0, maxLen - 1).trimEnd()}…` : compact;
};

const classifyUsageCategory = (relPath: string, testsFolder?: string): SchemaUsageCategory => {
	const norm = relPath.replace(/\\/g, "/").replace(/^\/+/, "");
	const cleanTests = (testsFolder ?? "tests").replace(/^[./\\]+|[\\/]+$/g, "").replace(/\\/g, "/").toLowerCase();
	const low = norm.toLowerCase();
	if (
		(cleanTests && (low === cleanTests || low.startsWith(`${cleanTests}/`))) ||
		/(?:^|\/)(?:tests?|__tests__)\/|(?:\.test\.|\.spec\.|(?:[._-]tests?|\.spec)\.(?:ssl|srvscr|ts|js))$/i.test(norm)
	) {
		return "tests";
	}
	if (/\.ds(?:\.txt)?$/i.test(norm)) return "data-sources";
	if (/\.(?:ssl|srvscr|sql|ddl|pks|pkb|xfd|xml|js|jsx|ts|tsx|cs|vb|html|htm)$/i.test(norm)) return "scripts";
	return "other";
};

/**
 * Groups raw workspace search hits and matching registry documents into ordered,
 * collapsible categories (`Data sources`, `Scripts`, `Tests`, `Other files`, `Registries`),
 * deduplicating hits per file while retaining every matched line and trimmed code snippet.
 */
export function groupSchemaUsages(
	codeHits: readonly { path: string; rel: string; line: number; text?: string }[],
	registries: readonly { path: string; title: string; fileName: string; rel?: string }[],
	options?: { testsFolder?: string; canonicalize?: (p: string) => string },
): SchemaUsageGroup[] {
	const canon = options?.canonicalize ?? ((p: string) => p.replace(/\\/g, "/"));
	const byFile = new Map<string, SchemaUsageEntry & { seenLines: Map<number, SchemaUsageHit> }>();

	for (const h of codeHits) {
		const key = canon(h.path);
		const rel = h.rel.replace(/\\/g, "/");
		const slash = rel.lastIndexOf("/");
		const fileName = slash >= 0 ? rel.slice(slash + 1) : rel;
		const dir = slash >= 0 ? rel.slice(0, slash) : "";
		let entry = byFile.get(key);
		if (!entry) {
			entry = {
				path: h.path,
				rel,
				name: fileName,
				fileName,
				dir,
				category: classifyUsageCategory(rel, options?.testsFolder),
				hits: [],
				count: 0,
				seenLines: new Map<number, SchemaUsageHit>(),
			};
			byFile.set(key, entry);
		}
		entry.count++;
		const snippet = trimUsageSnippet(h.text ?? "");
		const existingHit = entry.seenLines.get(h.line);
		if (!existingHit) {
			const hit = { line: h.line, text: snippet };
			entry.seenLines.set(h.line, hit);
			entry.hits.push(hit);
		} else if (!existingHit.text && snippet) {
			existingHit.text = snippet;
		}
	}

	const buckets = new Map<SchemaUsageCategory, SchemaUsageEntry[]>();
	for (const entry of byFile.values()) {
		entry.hits.sort((a, b) => a.line - b.line);
		const { seenLines: _drop, ...clean } = entry;
		const list = buckets.get(clean.category) ?? [];
		list.push(clean);
		buckets.set(clean.category, list);
	}

	if (registries.length) {
		const seenReg = new Set<string>();
		const regItems: SchemaUsageEntry[] = [];
		for (const r of registries) {
			const regKey = canon(r.path);
			if (seenReg.has(regKey)) continue;
			seenReg.add(regKey);
			regItems.push({
				path: r.path,
				rel: (r.rel ?? r.fileName).replace(/\\/g, "/"),
				name: r.title,
				fileName: r.fileName,
				dir: r.fileName,
				category: "registries",
				hits: [],
				count: 1,
			});
		}
		if (regItems.length) buckets.set("registries", regItems);
	}

	const groups: SchemaUsageGroup[] = [];
	for (const meta of USAGE_GROUP_META) {
		const items = buckets.get(meta.id);
		if (!items?.length) continue;
		items.sort(
			(a, b) =>
				a.name.localeCompare(b.name, undefined, { sensitivity: "base", numeric: true }) ||
				a.dir.localeCompare(b.dir, undefined, { sensitivity: "base", numeric: true }) ||
				a.rel.localeCompare(b.rel, undefined, { sensitivity: "base", numeric: true }) ||
				a.rel.localeCompare(b.rel),
		);
		groups.push({
			id: meta.id,
			label: meta.label,
			items,
			totalHits: items.reduce((sum, item) => sum + item.count, 0),
		});
	}
	return groups;
}

/** Filters grouped schema usages by filename, folder, label, or matched line snippet. */
export function filterSchemaUsageGroups(groups: readonly SchemaUsageGroup[], query: string): SchemaUsageGroup[] {
	const needle = query.trim().toLowerCase();
	if (!needle) return [...groups];
	const pathNeedle = needle.replace(/\\/g, "/");
	const out: SchemaUsageGroup[] = [];
	for (const group of groups) {
		const matchedItems: SchemaUsageEntry[] = [];
		for (const item of group.items) {
			const normDir = item.dir.replace(/\\/g, "/").toLowerCase();
			const normRel = item.rel.replace(/\\/g, "/").toLowerCase();
			const metaMatch =
				item.name.toLowerCase().includes(pathNeedle) ||
				normDir.includes(pathNeedle) ||
				normRel.includes(pathNeedle) ||
				group.label.toLowerCase().includes(pathNeedle);
			if (metaMatch) {
				matchedItems.push(item);
				continue;
			}
			const matchedHits = item.hits.filter((h) => {
				const low = h.text.toLowerCase();
				return low.includes(needle) || low.includes(pathNeedle);
			});
			if (matchedHits.length) {
				matchedItems.push({ ...item, hits: matchedHits, count: matchedHits.length });
			}
		}
		if (matchedItems.length) {
			out.push({
				...group,
				items: matchedItems,
				totalHits: matchedItems.reduce((sum, i) => sum + i.count, 0),
			});
		}
	}
	return out;
}
