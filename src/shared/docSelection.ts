// Pure helpers for Docs panel intuitive Ctrl/Shift multi-select and unified
// document issue aggregation (DocFile flags + docChecks + workspace docAudit).
import type { DocCheck } from "./docChecks";
import type { DocAuditResult, DocFile } from "./protocol";

export type MultiSelectResult = {
	selected: Set<string>;
	anchor: string | null;
};

/**
 * Applies a VS Code / OS file-explorer style modifier click onto `selected`:
 * - `Ctrl+Click` / `Cmd+Click`: toggles `clicked` in selection and updates anchor to `clicked`.
 * - `Shift+Click`: selects the contiguous visual slice from `anchor` through `clicked` (keeping `anchor` fixed);
 *   combining `Ctrl+Shift+Click` unions that slice into the existing selection.
 */
export function applyMultiSelectClick(
	current: ReadonlySet<string>,
	orderedSelectable: readonly string[],
	anchor: string | null,
	clicked: string,
	modifiers: { ctrl: boolean; shift: boolean },
): MultiSelectResult {
	if (modifiers.shift) {
		const clickedIdx = orderedSelectable.indexOf(clicked);
		const anchorIdx = anchor ? orderedSelectable.indexOf(anchor) : -1;
		if (clickedIdx >= 0 && anchorIdx >= 0) {
			const start = Math.min(anchorIdx, clickedIdx);
			const end = Math.max(anchorIdx, clickedIdx);
			const next = modifiers.ctrl ? new Set(current) : new Set<string>();
			for (let i = start; i <= end; i++) next.add(orderedSelectable[i]!);
			return { selected: next, anchor };
		}
		const next = modifiers.ctrl ? new Set(current) : new Set<string>();
		next.add(clicked);
		return { selected: next, anchor: clicked };
	}

	if (modifiers.ctrl) {
		const next = new Set(current);
		if (next.has(clicked)) next.delete(clicked);
		else next.add(clicked);
		return { selected: next, anchor: clicked };
	}

	return { selected: new Set<string>(), anchor: clicked };
}

export type DocIssueSummary = {
	/** Total distinct issues associated with this document path. */
	total: number;
	/** Issues from checks/audit that are not already covered by DocRow/ItemRow's built-in broken/stale/template/missing badges. */
	extraCount: number;
	/** Warning-level issues specifically from checks/audit (warranting an inline warning marker). */
	extraWarn: number;
	/** Warning-level issues count. */
	warn: number;
	/** Deduplicated human-readable messages for tooltips. */
	messages: string[];
	/** Deduplicated messages specifically from checks/audit (for tooltip and extra badge). */
	extraMessages: string[];
};

const defaultNorm = (p: string) => p.replace(/\\/g, "/").toLowerCase();

/** True when a `DocFile` carries direct structural flags surfaced inline by the Docs list. */
export function hasDirectDocIssue(d: DocFile): boolean {
	return Boolean(
		!d.exists ||
			d.broken?.length ||
			d.missing?.length ||
			d.missingSource ||
			d.problems?.length ||
			d.catalog?.stale ||
			d.untouched,
	);
}

/**
 * Aggregates every document issue across `DocFile` metadata, `docChecks()`, and `docAudit`
 * (broken `#anchors`, ADR 0008 tables, malformed YAML, duplicate headings, drifted `#L` citations,
 * schema drift, orphans, and stale/review-due governance issues) keyed by normalized file path.
 */
export function aggregateDocIssues(
	files: readonly DocFile[],
	checks: readonly DocCheck[],
	audit: Pick<DocAuditResult, "issues" | "citationIssues" | "schemaDrift"> | null | undefined,
	normalize: (path: string) => string = defaultNorm,
): Map<string, DocIssueSummary> {
	const map = new Map<string, DocIssueSummary>();
	const directPaths = new Set<string>();

	const ensure = (rawPath: string) => {
		const key = normalize(rawPath);
		let entry = map.get(key);
		if (!entry) {
			entry = { total: 0, extraCount: 0, extraWarn: 0, warn: 0, messages: [], extraMessages: [] };
			map.set(key, entry);
		}
		return entry;
	};

	const pushMsg = (entry: DocIssueSummary, text: string, level: "warn" | "note", extra: boolean) => {
		const clean = text.trim();
		if (!clean || entry.messages.includes(clean)) return;
		entry.messages.push(clean);
		entry.total++;
		if (level === "warn") entry.warn++;
		if (extra) {
			entry.extraMessages.push(clean);
			entry.extraCount++;
			if (level === "warn") entry.extraWarn++;
		}
	};

	for (const d of files) {
		const key = normalize(d.path);
		if (hasDirectDocIssue(d)) directPaths.add(key);
		if (!d.exists) pushMsg(ensure(d.path), "Missing project document", "warn", false);
		if (d.catalog?.stale) pushMsg(ensure(d.path), "Catalog is out of date", "warn", false);
		if (d.untouched) pushMsg(ensure(d.path), "Still template text", "note", false);
		if (d.missingSource) pushMsg(ensure(d.path), "Referenced source file is missing", "warn", false);
		for (const m of d.missing ?? []) pushMsg(ensure(d.path), `Missing: ${m}`, "warn", false);
		for (const b of d.broken ?? []) pushMsg(ensure(d.path), `Broken link: ${b.href}`, "warn", false);
		for (const p of d.problems ?? []) pushMsg(ensure(d.path), p, "warn", false);
	}

	for (const chk of checks) {
		if (!chk.path) continue;
		// Plain open-question inventory notes belong in Active, not as document issues.
		if (chk.level === "note" && !chk.fix && /^\d+\s+questions?\s+(?:is|are)\s+open\b/i.test(chk.text)) continue;
		// Catalogs/broken-link checks on docs that already show inline badges are still merged into messages,
		// while non-redundant check messages (missing approvals, reciprocal ADR, open questions on done tickets, etc.) count as extra.
		const redundantDirect =
			chk.fix?.kind === "catalogs" ||
			chk.fix?.kind === "links" ||
			chk.fix?.kind === "mend-wikilinks" ||
			(directPaths.has(normalize(chk.path)) && /out of date|links to|not there|template/i.test(chk.text));
		pushMsg(ensure(chk.path), chk.text, chk.level, !redundantDirect);
	}

	const auditHasKind = new Set<string>();
	for (const iss of audit?.issues ?? []) {
		if (!iss.path) continue;
		// Standalone unlinked snippets, prompts, and reference docs ("orphan" notes) stay in Health hygiene,
		// rather than flagging healthy reusable files with warning icons in Docs -> Issues.
		if (iss.kind === "orphan") continue;
		auditHasKind.add(`${normalize(iss.path)}::${iss.kind}`);
		const loc = iss.line > 0 ? `L${iss.line}: ${iss.message}` : iss.message;
		pushMsg(ensure(iss.path), loc, iss.level, true);
	}

	for (const cit of audit?.citationIssues ?? []) {
		if (!cit.docPath || auditHasKind.has(`${normalize(cit.docPath)}::citation`)) continue;
		const loc = cit.docLine > 0 ? `L${cit.docLine}: ${cit.text}` : cit.text;
		pushMsg(ensure(cit.docPath), loc, cit.level, true);
	}

	for (const drift of audit?.schemaDrift ?? []) {
		if (!drift.schemaPath || auditHasKind.has(`${normalize(drift.schemaPath)}::schema-drift`)) continue;
		const parts: string[] = [];
		if (drift.added.length) parts.push(`+${drift.added.length} added`);
		if (drift.modified.length) parts.push(`~${drift.modified.length} modified`);
		if (drift.dropped.length) parts.push(`-${drift.dropped.length} dropped`);
		const summary = `Schema drift on ${drift.table}${parts.length ? ` (${parts.join(", ")})` : ""}`;
		pushMsg(ensure(drift.schemaPath), summary, "warn", true);
	}

	return map;
}

/** True when a document should appear under the Docs panel's "Issues" filter. */
export function hasAnyDocIssue(
	d: DocFile,
	issuesByPath: ReadonlyMap<string, DocIssueSummary>,
	normalize: (path: string) => string = defaultNorm,
): boolean {
	return hasDirectDocIssue(d) || issuesByPath.has(normalize(d.path));
}
