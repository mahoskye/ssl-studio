// Pure workspace Schema <-> Code bridge helpers (ADR 0003 compliant: matches identifiers
// strictly against the project's documented schema files and DDL, never parsing SSL).
import { frontMatter } from "./frontMatter";
import { isCatalog } from "./projectDocs";
import type { DocFile } from "./protocol";
import { parseCreateTables, sqlTablesToMarkdown } from "./sqlSchema";

const SCHEMA_EXT_RE = /\.(md|markdown|sql|ddl|pks|pkb)$/i;

/** Returns canonical lookup names (table stem, title, qualified/bare name) for one schema DocFile. */
export function schemaDocKeys(file: DocFile): string[] {
	if (!file.exists || file.group !== "schema" || isCatalog(file)) return [];
	const keys = new Set<string>();
	const base = file.name.split(/[\\/]/).pop() ?? file.name;
	const stem = base.replace(SCHEMA_EXT_RE, "").trim();
	if (stem && stem.length >= 2) keys.add(stem.toLowerCase());
	if (file.title?.trim()) {
		const t = file.title.trim();
		// Add single-token or SQL-identifier titles (e.g. `DEMO_HOLIDAYS`, `dbo.DEMO_HOLIDAYS`).
		if (/^[A-Za-z_][\w$.-]{1,64}$/.test(t)) {
			keys.add(t.toLowerCase());
			if (t.includes(".")) keys.add(t.split(".").pop()!.toLowerCase());
		}
	}
	return [...keys];
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
