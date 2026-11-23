// Pure ticket-bundle classification for `docs/tickets/` (ADR 0030):
//
// Supports both flat tickets (`docs/tickets/LIMS-123.md`) and self-contained
// ticket bundle folders (`docs/tickets/LIMS-123/LIMS-123.md` plus any reference
// docs, existing code samples, and fixtures beside it), as well as a flat ticket
// paired with a sibling folder of the same key (`docs/tickets/LIMS-123.md` +
// `docs/tickets/LIMS-123/...`).
//
// Companion Markdown notes, code samples, and fixtures inside a ticket's folder
// attach to that ticket's `ticketFiles` instead of turning into fake separate
// tickets in the Docs -> Work panel.

import { CATALOG_FILE } from "./catalog";
import type { TicketFile } from "./protocol";

const MARKDOWN_RE = /\.(md|markdown)$/i;

/** Maximum companion file paths returned on DocFile for agent prompts; Explorer lists folders lazily on demand. */
export const TICKET_FILES_MAX = 25;

export type ScannedTicketEntry = {
	/** Absolute path on disk. */
	path: string;
	/** Path relative to `docs/tickets/`, using `/` separators (e.g. "LIMS-123/notes.md"). */
	rel: string;
	/** File size in bytes. */
	size: number;
	/** Explicit `ticket:` frontmatter value if this is a Markdown file, else empty. */
	frontTicket?: string;
};

export type ResolvedTicket = {
	/** The primary ticket Markdown file. */
	entry: ScannedTicketEntry;
	/** Whether this entry is the top-level `docs/tickets/INDEX.md` catalog. */
	isCatalog: boolean;
	/** Folder relative to `docs/tickets/` (e.g. "LIMS-123") when this ticket owns a bundle folder. */
	folderRel?: string;
	/** Exact uncapped count of companion files inside `folderRel`. */
	fileCount: number;
	/** Sample of companion files inside `folderRel` (capped at TICKET_FILES_MAX). */
	files: TicketFile[];
};

const stem = (name: string) => name.replace(MARKDOWN_RE, "");
const fold = (s: string) => s.trim().toLowerCase();
const byRel = (a: { rel: string }, b: { rel: string }) => a.rel.localeCompare(b.rel, undefined, { sensitivity: "base", numeric: true });

function isDotPath(rel: string): boolean {
	return rel.split("/").some((part) => part.startsWith(".")) || rel.endsWith(".ssl-studio-tmp");
}

function toTicketFiles(entries: readonly ScannedTicketEntry[], folderPrefix: string, excludePath?: string): { total: number; files: TicketFile[] } {
	const all: TicketFile[] = [];
	const prefix = `${folderPrefix}/`;
	for (const e of entries) {
		if (e.path === excludePath) continue;
		if (isDotPath(e.rel)) continue;
		const rel = e.rel.startsWith(prefix) ? e.rel.slice(prefix.length) : e.rel;
		all.push({ path: e.path, rel, size: e.size });
	}
	all.sort(byRel);
	return { total: all.length, files: all.slice(0, TICKET_FILES_MAX) };
}

const GROUPING_FOLDER_RE = /^(?:archive|archived|done|closed|backlog|inbox|trash|old|legacy|\d{4}|q[1-4](?:[-_]\d{2,4})?|sprint[-_\s]?\d+|iteration[-_\s]?\d+|epic[-_\s]?group)$/i;

/**
 * Picks the primary ticket Markdown file inside a candidate bundle folder, or `undefined`
 * if the folder looks like a grouping folder (e.g. `2026/`, `archive/`, `sprint-12/`).
 */
function pickPrimaryTicket(folderName: string, directMd: readonly ScannedTicketEntry[]): ScannedTicketEntry | undefined {
	const base = (e: ScannedTicketEntry) => {
		const idx = e.rel.lastIndexOf("/");
		return idx < 0 ? e.rel : e.rel.slice(idx + 1);
	};
	const nonCatalogMd = directMd.filter((e) => fold(base(e)) !== fold(CATALOG_FILE));
	const explicitMatch =
		nonCatalogMd.find((e) => fold(stem(base(e))) === fold(folderName)) ??
		nonCatalogMd.find((e) => e.frontTicket && fold(e.frontTicket) === fold(folderName)) ??
		nonCatalogMd.find((e) => fold(stem(base(e))) === "ticket" || fold(stem(base(e))) === "readme");
	if (explicitMatch) return explicitMatch;
	// Rule (d): a lone direct .md with explicit `ticket:` frontmatter claims the folder,
	// EXCEPT when the folder name is a generic grouping/archive bucket (`archive/`, `2026/`, `sprint-12/`).
	if (GROUPING_FOLDER_RE.test(folderName.trim())) return undefined;
	const withKey = nonCatalogMd.filter((e) => Boolean(e.frontTicket?.trim()));
	return withKey.length === 1 ? withKey[0] : undefined;
}

/**
 * Classifies every file under `docs/tickets/` into top-level catalog, real ticket documents
 * (flat or bundled), and each ticket's companion `files`.
 */
export function classifyTicketEntries(entries: readonly ScannedTicketEntry[]): ResolvedTicket[] {
	const clean = entries.filter((e) => !isDotPath(e.rel)).sort(byRel);
	const topFiles: ScannedTicketEntry[] = [];
	const byFolder = new Map<string, ScannedTicketEntry[]>();

	for (const entry of clean) {
		const slash = entry.rel.indexOf("/");
		if (slash < 0) {
			topFiles.push(entry);
		} else {
			const folder = entry.rel.slice(0, slash);
			const bucket = byFolder.get(folder) ?? [];
			bucket.push(entry);
			byFolder.set(folder, bucket);
		}
	}

	const resolved: ResolvedTicket[] = [];
	const claimedFolders = new Set<string>();

	// 1. Top-level Markdown files in `docs/tickets/` (catalog + flat tickets).
	for (const entry of topFiles) {
		if (!MARKDOWN_RE.test(entry.rel)) continue;
		if (fold(entry.rel) === fold(CATALOG_FILE)) {
			resolved.push({ entry, isCatalog: true, fileCount: 0, files: [] });
			continue;
		}
		const key = entry.frontTicket?.trim() || stem(entry.rel);
		// Check if a sibling folder matches the file stem or explicit ticket key (Layout 2).
		let matchedFolder: string | undefined;
		for (const folder of byFolder.keys()) {
			if (claimedFolders.has(folder)) continue;
			if (fold(folder) === fold(stem(entry.rel)) || fold(folder) === fold(key)) {
				matchedFolder = folder;
				break;
			}
		}
		if (matchedFolder) {
			claimedFolders.add(matchedFolder);
			const bundled = toTicketFiles(byFolder.get(matchedFolder)!, matchedFolder);
			resolved.push({
				entry,
				isCatalog: false,
				folderRel: matchedFolder,
				fileCount: bundled.total,
				files: bundled.files,
			});
		} else {
			resolved.push({ entry, isCatalog: false, fileCount: 0, files: [] });
		}
	}

	// 2. Remaining subfolders under `docs/tickets/<folder>/`.
	for (const [folder, group] of [...byFolder.entries()].sort(([a], [b]) => a.localeCompare(b, undefined, { sensitivity: "base", numeric: true }))) {
		if (claimedFolders.has(folder)) continue;
		const directMd = group.filter((e) => !e.rel.slice(folder.length + 1).includes("/") && MARKDOWN_RE.test(e.rel));
		const primary = pickPrimaryTicket(folder, directMd);

		if (primary) {
			const bundled = toTicketFiles(group, folder, primary.path);
			resolved.push({
				entry: primary,
				isCatalog: false,
				folderRel: folder,
				fileCount: bundled.total,
				files: bundled.files,
			});
			continue;
		}

		// Grouping subfolder (e.g. `docs/tickets/2026/`, `docs/tickets/sprint-12/`, `docs/tickets/archive/`):
		// Support BOTH direct flat tickets (`2026/LIMS-200.md`) AND nested depth-2 bundle folders (`sprint-12/LIMS-200/LIMS-200.md`).
		const subFolders = new Map<string, ScannedTicketEntry[]>();
		const directInGroup: ScannedTicketEntry[] = [];
		for (const e of group) {
			const rest = e.rel.slice(folder.length + 1);
			const slash = rest.indexOf("/");
			if (slash < 0) directInGroup.push(e);
			else {
				const sub = rest.slice(0, slash);
				const bucket = subFolders.get(sub) ?? [];
				bucket.push(e);
				subFolders.set(sub, bucket);
			}
		}
		const claimedSub = new Set<string>();
		const TICKET_STEM_RE = /^[A-Za-z][A-Za-z0-9]*-\d+$/;
		for (const md of directInGroup.filter(
			(e) => MARKDOWN_RE.test(e.rel) && (Boolean(e.frontTicket?.trim()) || TICKET_STEM_RE.test(stem(e.rel.slice(folder.length + 1)))),
		)) {
			const mdBase = md.rel.slice(folder.length + 1);
			const key = md.frontTicket?.trim() || stem(mdBase);
			let matchedSub: string | undefined;
			for (const sub of subFolders.keys()) {
				if (claimedSub.has(sub)) continue;
				if (fold(sub) === fold(stem(mdBase)) || fold(sub) === fold(key)) {
					matchedSub = sub;
					break;
				}
			}
			if (matchedSub) {
				claimedSub.add(matchedSub);
				const prefix = `${folder}/${matchedSub}`;
				const bundled = toTicketFiles(subFolders.get(matchedSub)!, prefix);
				resolved.push({ entry: md, isCatalog: false, folderRel: prefix, fileCount: bundled.total, files: bundled.files });
			} else {
				resolved.push({ entry: md, isCatalog: false, fileCount: 0, files: [] });
			}
		}
		for (const [sub, subGroup] of [...subFolders.entries()].sort(([a], [b]) => a.localeCompare(b, undefined, { sensitivity: "base", numeric: true }))) {
			if (claimedSub.has(sub)) continue;
			const subPrefix = `${folder}/${sub}`;
			const subDirectMd = subGroup.filter((e) => !e.rel.slice(subPrefix.length + 1).includes("/") && MARKDOWN_RE.test(e.rel));
			const subPrimary = pickPrimaryTicket(sub, subDirectMd);
			if (subPrimary) {
				const bundled = toTicketFiles(subGroup, subPrefix, subPrimary.path);
				resolved.push({ entry: subPrimary, isCatalog: false, folderRel: subPrefix, fileCount: bundled.total, files: bundled.files });
			} else {
				for (const md of subGroup.filter((e) => MARKDOWN_RE.test(e.rel) && Boolean(e.frontTicket?.trim()))) {
					resolved.push({ entry: md, isCatalog: false, fileCount: 0, files: [] });
				}
			}
		}
	}

	return resolved.sort((a, b) => a.entry.rel.localeCompare(b.entry.rel, undefined, { sensitivity: "base", numeric: true }));
}
