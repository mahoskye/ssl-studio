// The project's documents and what the documents of the work need from
// someone, and the current script against the house style: size, procedures,
// findings.
import { Icon } from "../Icon";
import { createEffect, createMemo, createSignal, For, onCleanup, Show } from "solid-js";
import { reanchorCitation, refreshCitationExcerpt } from "../../shared/codeCitations";
import { withLinkFiles } from "../../shared/docLinks";
import { addToFrontMatterList, frontMatter, many, withFrontMatter } from "../../shared/frontMatter";
import { level } from "../../shared/houseStyle";
import { withNames } from "../../shared/namedLinks";
import type { AuditCitationIssue, OpenTaskItem, SchemaDriftItem, UndocumentedSchemaRef, WorkspaceDocIssue } from "../../shared/protocol";
import { tasks } from "../../shared/tasks";
import { descendantTickets, ticketWork } from "../../shared/workContext";
import { backend } from "../backend";
import { choose } from "../dialogs";
import { docAuditData, refreshDocAudit } from "../docAudit";
import { monaco } from "../editor/monaco";
import { diagnostics } from "../lsp/session";
import { size } from "../StatusBar";
import { activeDoc, activePath, applyText, canonical, documents, fileRemoved, notify, openFile, save, setState, state } from "../state";
import { baseName, isInside, relativeTo } from "../../shared/paths";
import { symbols } from "./Objects";
import { SeverityMark, SEVERITY } from "./Problems";
import { focusRowsBelow, IconButton, Row, Rows, type Point } from "./Rows";
import { chooseFromMenu, type RowMenuEntry } from "./RowMenu";
import { serverDown } from "./server";
import { openStyleProfile } from "../StyleProfile";
import { docs, setUpProject } from "../project";
import { checksSummary, docChecks, mendKeepsName, type DocCheck, type LinkMend, type WikiLinkMend } from "../../shared/docChecks";
import { folderParts } from "../../shared/docSections";
import { CATALOG_AREAS, isCatalog, projectDocLabel, registryTitle, toneOf } from "../../shared/projectDocs";
import { addDatabaseRegistryRow, generateSchemaDocFromSql, mendLinks, newSchema, newTicket, recordDocApproval, updateCatalogs } from "../projectDocs";

const PROCEDURE = new Set([monaco.languages.SymbolKind.Function, monaco.languages.SymbolKind.Method]);

function procedures(list = symbols()): monaco.languages.DocumentSymbol[] {
	return list.flatMap((s) => (PROCEDURE.has(s.kind) ? [s] : procedures(s.children ?? [])));
}

/** How many of the longest procedures are listed. */
const LONGEST = 8;
const count = (n: number, one: string) => `${n} ${one}${n === 1 ? "" : "s"}`;

/**
 * Locates an unchecked Markdown checklist box (`[ ]`) in live document text via `tasks(text)`,
 * matching `(offset, text)` first and falling back to `(line, text)` so stale offsets after edits
 * never corrupt another task or prose text.
 */
export function findOpenTaskOffset(text: string, task: Pick<OpenTaskItem, "offset" | "line" | "text">): number {
	const list = tasks(text);
	const exact = list.find((t) => !t.done && t.offset === task.offset && t.text === task.text && t.offset > 0);
	if (exact && text[exact.offset] === " ") return exact.offset;
	const byLine = list.find((t) => !t.done && t.line === task.line && t.text === task.text && t.offset > 0);
	if (byLine && text[byLine.offset] === " ") return byLine.offset;
	return -1;
}

export type CombinedLinkMend =
	| { kind: "path"; edit: LinkMend }
	| { kind: "wiki"; edit: WikiLinkMend };

/**
 * Applies mixed path-link and wikilink mends to one document in reverse `(line, column)` order
 * so earlier edits on the same line never shift columns of later edits.
 */
export function applyCombinedLinkMends(
	text: string,
	mends: readonly CombinedLinkMend[],
): { text: string; done: number } {
	const seen = new Set<string>();
	const unique: CombinedLinkMend[] = [];
	for (const m of mends) {
		const key =
			m.kind === "wiki"
				? `wiki:${m.edit.line}:${m.edit.column}:${m.edit.name}`
				: `path:${m.edit.line}:${m.edit.column ?? ""}:${m.edit.href}`;
		if (seen.has(key)) continue;
		seen.add(key);
		unique.push(m);
	}
	unique.sort((a, b) => b.edit.line - a.edit.line || (b.edit.column ?? 0) - (a.edit.column ?? 0));
	let cur = text;
	let done = 0;
	for (const m of unique) {
		const res = m.kind === "wiki" ? withNames(cur, [m.edit]) : withLinkFiles(cur, [m.edit]);
		if (res.done > 0 && res.text !== cur) {
			cur = res.text;
			done += res.done;
		}
	}
	return { text: cur, done };
}

/**
 * A document's wikilink mends, apart: the ones that keep the link's name (the same file, at the place it moved
 * to) and the ones that would give the link another note's name. The second kind is a guess from the likeness
 * of two names, and the link may be to a note nobody has written yet.
 */
export function splitWikiMends(mends: readonly WikiLinkMend[]): { moved: WikiLinkMend[]; guessed: WikiLinkMend[] } {
	return { moved: mends.filter((m) => mendKeepsName(m)), guessed: mends.filter((m) => !mendKeepsName(m)) };
}

/** What is asked before links are given another note's name: each link as it is written, and as it would be. */
export function guessedMendQuestion(docName: string, guessed: readonly WikiLinkMend[]): string {
	const shown = guessed.slice(0, 3).map((m) => `[[${m.name}]] → [[${m.instead}]]`);
	const more = guessed.length - shown.length;
	const pairs = `${shown.join(", ")}${more > 0 ? ` and ${more} more` : ""}`;
	return guessed.length === 1
		? `Rewrite ${pairs} in ${docName}? No note has the name as written. The new name is the closest there is, and may be a different note.`
		: `Rewrite ${guessed.length} wikilinks in ${docName}: ${pairs}? No note has these names as written. The new names are the closest there are, and may be different notes.`;
}

/**
 * What "Mend all broken links" makes: the mends of every link whose file moved, by document. A wikilink that
 * would be given another note's name is not among them, since nobody has looked at it: `guessed` counts the ones
 * left for their own rows, and `checks` the checks that have something for the bulk mend.
 */
export function movedLinkMends(
	checks: readonly { path: string; fix: { kind: "links"; mends: LinkMend[] } | { kind: "mend-wikilinks"; mends: WikiLinkMend[] } }[],
): { byPath: Map<string, { path: string; mends: CombinedLinkMend[] }>; links: number; checks: number; guessed: number } {
	const byPath = new Map<string, { path: string; mends: CombinedLinkMend[] }>();
	let links = 0;
	let withMends = 0;
	let guessed = 0;
	for (const check of checks) {
		const mends: CombinedLinkMend[] =
			check.fix.kind === "mend-wikilinks"
				? splitWikiMends(check.fix.mends).moved.map((edit) => ({ kind: "wiki", edit }))
				: check.fix.mends.map((edit) => ({ kind: "path", edit }));
		if (check.fix.kind === "mend-wikilinks") guessed += check.fix.mends.length - mends.length;
		if (!mends.length) continue;
		const key = canonical(check.path);
		const entry = byPath.get(key) ?? { path: check.path, mends: [] };
		entry.mends.push(...mends);
		byPath.set(key, entry);
		links += mends.length;
		withMends++;
	}
	return { byPath, links, checks: withMends, guessed };
}

export function Health() {
	const limits = () => state.settings.limits;
	const findings = () => {
		const doc = activeDoc();
		return doc ? (diagnostics[doc.model.uri.toString()] ?? []) : [];
	};
	const byRule = () => {
		const map = new Map<string, { count: number; severity: number }>();
		for (const d of findings()) {
			const key = d.code ?? "(no code)";
			const entry = map.get(key) ?? { count: 0, severity: d.severity };
			entry.count++;
			entry.severity = Math.min(entry.severity, d.severity);
			map.set(key, entry);
		}
		return [...map].sort((a, b) => a[1].severity - b[1].severity || b[1].count - a[1].count);
	};
	const procs = () =>
		procedures()
			.map((p) => ({ name: p.name, line: p.selectionRange.startLineNumber, lines: p.range.endLineNumber - p.range.startLineNumber + 1 }))
			.sort((a, b) => b.lines - a.lines);
	/** Each procedure's length against the longest: the bars show where the script's weight is. */
	const share = (lines: number) => `${Math.max(3, Math.round((lines / Math.max(1, procs()[0]?.lines ?? 1)) * 100))}%`;
	const Meter = (props: { label: string; title?: string; value: number; limit: number; unit?: string; near?: number }) => (
		<div class="meter-row" title={props.title}>
			<span>{props.label}</span>
			<span class={level(props.value, props.limit, props.near)}>
				{props.unit === "KB" ? (props.value / 1024).toFixed(1) : props.value} / {props.unit === "KB" ? props.limit / 1024 : props.limit} {props.unit ?? ""}
			</span>
			<div class="bar">
				<div class={`fill ${level(props.value, props.limit, props.near)}`} style={{ width: `${Math.min(100, (props.value / props.limit) * 100)}%` }} />
			</div>
		</div>
	);
	/** What the tickets, specs, knowledge base and registries need from someone. */
	// A schema folder that is the project's own folder is no folder of descriptions: it has no catalog to ask for.
	const areas = () => CATALOG_AREAS.filter((area) => area !== "schema" || folderParts(state.project?.schema ?? "schema").length > 0);
	const checks = createMemo(() => docChecks(docs(), areas()));
	const auditResult = docAuditData;
	const citationIssues = () => auditResult().citationIssues ?? [];
	const orphanAttachments = () => auditResult().unusedAttachments;
	const openTasks = () => auditResult().openTasks;
	const schemaDrift = () => auditResult().schemaDrift ?? [];
	const undocumentedRefs = () => auditResult().undocumentedRefs ?? [];
	const truncatedFolders = () => auditResult().truncatedFolders ?? [];
	// Citation & schema-drift issues have dedicated actionable sections below.
	const docAuditIssues = () => auditResult().issues.filter((i) => i.kind !== "citation" && i.kind !== "schema-drift");

	const [driftOpen, setDriftOpen] = createSignal(true);
	const [undocOpen, setUndocOpen] = createSignal(true);
	const [truncOpen, setTruncOpen] = createSignal(true);

	// Compact Health filter bar (All / Active ticket / Warnings + text search).
	const [healthMode, setHealthMode] = createSignal<"all" | "ticket" | "warnings">("all");
	const [healthQuery, setHealthQuery] = createSignal("");
	const activeTicketKey = () => state.settings.activeTicket?.trim() || "";
	createEffect(
		() => !activeTicketKey() && healthMode() === "ticket",
		(shouldReset) => {
			if (shouldReset) setHealthMode("all");
		},
	);
	const activeTicketScope = createMemo(() => {
		const key = activeTicketKey();
		if (!key) return { paths: new Set<string>(), folders: [] as string[], keys: new Set<string>() };
		const allDocs = docs();
		const desc = descendantTickets(allDocs, key);
		const keys = new Set<string>([key.toLowerCase()]);
		const paths = new Set<string>();
		const folders: string[] = [];
		const addTicket = (k: string) => {
			keys.add(k.toLowerCase());
			const tDoc = allDocs.find((d) => d.exists && d.group === "tickets" && d.ticket?.toLowerCase() === k.toLowerCase());
			if (tDoc) {
				paths.add(canonical(tDoc.path));
				if (tDoc.ticketFolder) folders.push(tDoc.ticketFolder);
			}
			for (const g of ticketWork(allDocs, k)) {
				if (g.kind === "ticket") continue;
				for (const f of g.files) {
					paths.add(canonical(f.path));
					if (f.ticketFolder) folders.push(f.ticketFolder);
				}
			}
		};
		addTicket(key);
		for (const d of desc) if (d.ticket) addTicket(d.ticket);
		return { paths, folders, keys };
	});
	const inActiveTicket = (filePath: string, ticket?: string) => {
		const scope = activeTicketScope();
		if (ticket && scope.keys.has(ticket.toLowerCase())) return true;
		const c = canonical(filePath);
		if (scope.paths.has(c)) return true;
		return scope.folders.some((f) => isInside(f, filePath));
	};
	const matchesQuery = (...parts: (string | undefined)[]) => {
		const q = healthQuery().trim().toLowerCase();
		if (!q) return true;
		const hay = parts.filter(Boolean).join(" ").toLowerCase();
		return q.split(/\s+/).every((w) => hay.includes(w));
	};
	const isFiltering = () => healthMode() !== "all" || Boolean(healthQuery().trim());

	const filteredChecks = createMemo(() =>
		checks().filter((c) => {
			if (healthMode() === "warnings" && c.level !== "warn") return false;
			if (healthMode() === "ticket" && !inActiveTicket(c.path)) return false;
			return matchesQuery(c.text, c.path, baseName(c.path));
		}),
	);
	const filteredDocIssues = createMemo(() =>
		docAuditIssues().filter((i) => {
			if (healthMode() === "warnings" && i.level !== "warn") return false;
			if (healthMode() === "ticket" && !inActiveTicket(i.path)) return false;
			return matchesQuery(i.message, i.path, baseName(i.path), i.kind);
		}),
	);
	const filteredOpenTasks = createMemo(() =>
		openTasks().filter((t) => {
			if (healthMode() === "warnings") return false;
			if (healthMode() === "ticket" && !inActiveTicket(t.path, t.ticket)) return false;
			return matchesQuery(t.text, t.ticket, t.title, t.path, baseName(t.path));
		}),
	);
	const filteredCitations = createMemo(() =>
		citationIssues().filter((c) => {
			if (healthMode() === "warnings" && c.level !== "warn") return false;
			if (healthMode() === "ticket" && !inActiveTicket(c.docPath) && !inActiveTicket(c.targetPath)) return false;
			return matchesQuery(c.text, c.docPath, c.targetPath, baseName(c.docPath), c.kind);
		}),
	);
	const filteredOrphans = createMemo(() =>
		orphanAttachments().filter((p) => {
			if (healthMode() === "warnings") return false;
			if (healthMode() === "ticket" && !inActiveTicket(p)) return false;
			return matchesQuery(p, baseName(p));
		}),
	);
	const filteredSchemaDrift = createMemo(() =>
		schemaDrift().filter((item) => {
			if (healthMode() === "ticket" && !inActiveTicket(item.schemaPath) && !inActiveTicket(item.sqlPath)) return false;
			return matchesQuery(item.table, item.schemaPath, item.sqlPath, baseName(item.schemaPath), ...item.added, ...item.modified, ...item.dropped);
		}),
	);
	const filteredUndocRefs = createMemo(() =>
		undocumentedRefs().filter((ref) => {
			if (healthMode() === "warnings") return false;
			if (healthMode() === "ticket" && !inActiveTicket(ref.path)) return false;
			return matchesQuery(ref.object, ref.path, baseName(ref.path));
		}),
	);
	const filteredTruncated = createMemo(() =>
		truncatedFolders().filter((t) => matchesQuery(t.folder, String(t.limit))),
	);
	const mendableChecks = createMemo(() =>
		filteredChecks().filter(
			(c): c is DocCheck & { fix: { kind: "links"; mends: LinkMend[] } | { kind: "mend-wikilinks"; mends: WikiLinkMend[] } } =>
				(c.fix?.kind === "links" || c.fix?.kind === "mend-wikilinks") && c.fix.mends.length > 0,
		),
	);
	/** What "Mend all broken links" would make: only the links whose files moved, never a guess at another note's name. */
	const bulkMends = createMemo(() => movedLinkMends(mendableChecks()));
	const mendableDocCount = createMemo(() => bulkMends().byPath.size);
	const reanchorableCitations = createMemo(() => filteredCitations().filter((c) => Boolean(c.reanchor)));

	/** Reads live editor text when open as a non-disposed text buffer, otherwise reads from disk. */
	const readDocText = async (path: string): Promise<string | null> => {
		const open = documents.get(canonical(path));
		if (open?.binary) return null;
		if (open && !open.binary && !open.model.isDisposed()) return open.model.getValue();
		return backend.read(path).then((r) => (r.binary ? null : r.text), () => null);
	};

	/** Applies an edit to an open or closed document: clean open buffers save to disk; dirty buffers stay unsaved (ADR 0009). */
	const writeDocEdit = async (path: string, next: string) => {
		const key = canonical(path);
		const open = documents.get(key);
		if (open?.binary) throw new Error(`${baseName(path)} is a binary file and cannot be edited as text.`);
		if (open && !open.binary && !open.model.isDisposed()) {
			const clean = !state.dirty[key];
			if (!applyText(key, next)) throw new Error(`Could not update open buffer for ${baseName(path)}.`);
			if (clean && !(await save(key, { format: false }))) {
				throw new Error(`${baseName(path)} was changed in the editor and could not be saved.`);
			}
		} else {
			await backend.historyKeep(path).catch(() => {});
			await backend.write(path, next);
		}
	};

	const tickOpenTask = async (task: OpenTaskItem) => {
		const cur = await readDocText(task.path);
		if (cur === null) return notify("Could not read the document.", "error");
		const offset = findOpenTaskOffset(cur, task);
		if (offset < 0) return notify("Could not locate that task box — the document changed. Open it to tick it.", "error");
		const next = `${cur.slice(0, offset)}x${cur.slice(offset + 1)}`;
		try {
			await writeDocEdit(task.path, next);
			setState((s) => { s.treeVersion += 1; });
			refreshDocAudit();
			notify(`Ticked off task in ${task.ticket ?? task.title ?? baseName(task.path)}.`);
		} catch (e: any) {
			notify(`Could not update ${baseName(task.path)}: ${e?.message ?? e}`, "error");
		}
	};

	const reanchorIssue = async (issue: AuditCitationIssue) => {
		if (!issue.reanchor) return;
		const cur = await readDocText(issue.docPath);
		if (cur === null) return notify("Could not read the document.", "error");
		const next = reanchorCitation(cur, issue.citation, issue.reanchor.from, issue.reanchor.to);
		if (next === cur) return;
		try {
			await writeDocEdit(issue.docPath, next);
			setState((s) => { s.treeVersion += 1; });
			refreshDocAudit();
			notify(`Re-anchored citation to L${issue.reanchor.from}-L${issue.reanchor.to}.`);
		} catch (e: any) {
			notify(`Could not update ${baseName(issue.docPath)}: ${e?.message ?? e}`, "error");
		}
	};

	const refreshExcerptIssue = async (issue: AuditCitationIssue) => {
		if (issue.kind !== "drifted") return;
		const startRoot = state.workspace?.root;
		const [docText, targetText] = await Promise.all([readDocText(issue.docPath), readDocText(issue.targetPath)]);
		if (docText === null || targetText === null) return notify("Could not read the document or cited file.", "error");
		const previewNext = refreshCitationExcerpt(docText, issue.citation, targetText);
		if (!previewNext || previewNext === docText) return notify("Could not find a following fenced code block to refresh.", "error");
		const REFRESH = "Refresh excerpt";
		const rangeLabel = issue.citation.from === issue.citation.to ? `L${issue.citation.from}` : `L${issue.citation.from}-L${issue.citation.to}`;
		if (
			(await choose(
				`Replace the quoted snippet in ${baseName(issue.docPath)} (line ${issue.docLine}) with current lines ${rangeLabel} from ${baseName(issue.targetPath)}?`,
				[REFRESH],
			)) !== REFRESH
		) {
			return;
		}
		if (state.workspace?.root !== startRoot) return;
		// Re-read both buffers after confirmation so concurrent edits are never overwritten.
		const [freshDoc, freshTarget] = await Promise.all([readDocText(issue.docPath), readDocText(issue.targetPath)]);
		if (freshDoc === null || freshTarget === null) return notify("Could not read the document or cited file.", "error");
		const next = refreshCitationExcerpt(freshDoc, issue.citation, freshTarget);
		if (!next || next === freshDoc) return notify("Could not refresh excerpt — the document changed since.", "error");
		try {
			await writeDocEdit(issue.docPath, next);
			setState((s) => { s.treeVersion += 1; });
			refreshDocAudit();
			notify(`Refreshed quoted excerpt in ${baseName(issue.docPath)}.`);
		} catch (e: any) {
			notify(`Could not update ${baseName(issue.docPath)}: ${e?.message ?? e}`, "error");
		}
	};

	const reanchorAll = async () => {
		const list = reanchorableCitations();
		if (!list.length) return;
		const startRoot = state.workspace?.root;
		const byDoc = new Map<string, AuditCitationIssue[]>();
		for (const item of list) {
			const k = canonical(item.docPath);
			byDoc.set(k, [...(byDoc.get(k) ?? []), item]);
		}
		const GO = "Re-anchor all";
		const answer = await choose(
			`Re-anchor ${count(list.length, "code citation")} across ${count(byDoc.size, "document")}?`,
			[GO],
		);
		if (answer !== GO || state.workspace?.root !== startRoot) return;
		let updated = 0;
		let changedFiles = 0;
		let failed = 0;
		for (const [, docItems] of byDoc) {
			if (state.workspace?.root !== startRoot) break;
			const docPath = docItems[0]!.docPath;
			let cur = await readDocText(docPath);
			if (cur === null) continue;
			let docUpdated = 0;
			for (const item of docItems) {
				if (!item.reanchor) continue;
				const next = reanchorCitation(cur, item.citation, item.reanchor.from, item.reanchor.to);
				if (next !== cur) {
					cur = next;
					docUpdated++;
				}
			}
			if (docUpdated > 0) {
				try {
					await writeDocEdit(docPath, cur);
					updated += docUpdated;
					changedFiles++;
				} catch (e: any) {
					failed++;
					notify(`Could not update ${baseName(docPath)}: ${e?.message ?? e}`, "error");
				}
			}
		}
		if (changedFiles) {
			setState((s) => { s.treeVersion += 1; });
			refreshDocAudit();
		}
		if (updated) {
			notify(`Re-anchored ${count(updated, "citation")}${failed ? ` (${failed} ${failed === 1 ? "file" : "files"} failed)` : ""}.`);
		} else if (!failed) {
			notify("Citations were already up to date.");
		}
	};

	const trashOrphanAttachment = async (path: string) => {
		const root = state.workspace?.root ?? "";
		const rel = root ? relativeTo(root, path).split("\\").join("/") : baseName(path);
		const TRASH = "Move to trash";
		if ((await choose(`Move unused attachment ${rel} to the trash?`, [TRASH], { danger: TRASH })) !== TRASH) return;
		if ((state.workspace?.root ?? "") !== root) return;
		try {
			await backend.trash(path);
			fileRemoved(path);
			setState((s) => { s.treeVersion += 1; });
			refreshDocAudit();
			notify(`Moved unused attachment ${baseName(path)} to trash.`);
		} catch (e: any) {
			notify(`Could not move to trash: ${e?.message ?? e}`, "error");
		}
	};

	const trashAllOrphans = async () => {
		const list = filteredOrphans();
		if (!list.length) return;
		const startRoot = state.workspace?.root;
		const TRASH_ALL = `Trash ${list.length} unused`;
		const preview = list.slice(0, 4).map(baseName).join(", ") + (list.length > 4 ? ` and ${list.length - 4} more` : "");
		const picked = await choose(
			`Move ${count(list.length, "unused attachment")} (${preview}) to the trash?`,
			[TRASH_ALL],
			{ danger: TRASH_ALL },
		);
		if (picked !== TRASH_ALL || state.workspace?.root !== startRoot) return;
		let trashed = 0;
		let failed = 0;
		for (const p of list) {
			if (state.workspace?.root !== startRoot) break;
			try {
				await backend.trash(p);
				fileRemoved(p);
				trashed++;
			} catch (e: any) {
				failed++;
				notify(`Could not move ${baseName(p)} to trash: ${e?.message ?? e}`, "error");
			}
		}
		if (trashed) {
			setState((s) => { s.treeVersion += 1; });
			refreshDocAudit();
			notify(`Moved ${count(trashed, "unused attachment")} to trash${failed ? ` (${failed} failed)` : ""}.`);
		}
	};

	const mendWikiLinks = async (path: string, all: WikiLinkMend[]) => {
		// A mend that gives a link another note's name is a guess: `[[Release 2.1 notes]]` may be a note not written
		// yet, and not a slip for `Release-2.0-notes`. It is shown, old name and new, and made only on the person's word.
		const { moved, guessed } = splitWikiMends(all);
		let mends = all;
		if (guessed.length) {
			const startRoot = state.workspace?.root;
			const REWRITE = guessed.length === 1 ? "Rewrite link" : `Rewrite ${guessed.length} links`;
			const MOVED_ONLY = `Mend ${count(moved.length, "moved link")} only`;
			const picked = await choose(guessedMendQuestion(baseName(path), guessed), moved.length ? [REWRITE, MOVED_ONLY] : [REWRITE]);
			if (!picked || state.workspace?.root !== startRoot) return;
			if (picked === MOVED_ONLY) mends = moved;
		}
		const before = await readDocText(path);
		if (before === null) return notify("Could not read the document.", "error");
		const { text: after, done } = withNames(before, mends);
		if (!done || after === before) return notify("Those wikilinks could not be mended — the document may have already changed.");
		try {
			await writeDocEdit(path, after);
			setState((s) => { s.treeVersion += 1; });
			refreshDocAudit();
			notify(`Mended ${count(done, "wikilink")} in ${baseName(path)}.`);
		} catch (e: any) {
			notify(`Could not update ${baseName(path)}: ${e?.message ?? e}`, "error");
		}
	};

	const fixReciprocalAdr = async (fixSpec: { path: string; field: "supersedes" | "superseded-by"; value: string }) => {
		const before = await readDocText(fixSpec.path);
		if (before === null) return notify("Could not read the decision document.", "error");
		const fm = frontMatter(before);
		const existing = many(fm.values[fixSpec.field]);
		const next = existing.length
			? addToFrontMatterList(before, fixSpec.field, fixSpec.value)
			: withFrontMatter(before, fixSpec.field, fixSpec.value);
		// Null says the field is laid out over several lines and was left alone: it is not said to list the value already.
		if (next === null) return notify(`Could not add ${fixSpec.field}: ${fixSpec.value} to ${baseName(fixSpec.path)}: the field is written over several lines. Add it in the text.`, "error");
		if (next === before) return notify(`${baseName(fixSpec.path)} already lists ${fixSpec.field}: ${fixSpec.value}.`);
		try {
			await writeDocEdit(fixSpec.path, next);
			setState((s) => { s.treeVersion += 1; });
			refreshDocAudit();
			notify(`Added ${fixSpec.field}: ${fixSpec.value} to ${baseName(fixSpec.path)}.`);
		} catch (e: any) {
			notify(`Could not update ${baseName(fixSpec.path)}: ${e?.message ?? e}`, "error");
		}
	};

	const runRecordApproval = async (path: string) => {
		await recordDocApproval(path);
		refreshDocAudit();
	};

	const mendAllBrokenLinks = async () => {
		// Only the links whose files moved, grouped by canonical(check.path): the prompt says "where their files
		// moved", and a wikilink that would be given another note's name is left to its own row, which asks.
		const { byPath, links: totalLinks, checks: withMends, guessed } = bulkMends();
		if (withMends < 2) return;
		const startRoot = state.workspace?.root;
		const uniquePaths = [...byPath.values()].map((e) => e.path);
		const preview =
			uniquePaths
				.slice(0, 4)
				.map((p) => baseName(p))
				.join(", ") + (uniquePaths.length > 4 ? ` and ${uniquePaths.length - 4} more` : "");
		const GO = "Mend all links";
		const picked = await choose(
			`Rewrite ${count(totalLinks, "broken link")} across ${count(byPath.size, "document")} (${preview}) to point at where their files moved?${
				guessed ? ` ${count(guessed, "wikilink")} that would be given a different note's name ${guessed === 1 ? "is" : "are"} not among them: mend ${guessed === 1 ? "it" : "them"} one at a time.` : ""
			}`,
			[GO],
		);
		if (picked !== GO || state.workspace?.root !== startRoot) return;
		const mendedPaths = new Set<string>();
		let mendedLinks = 0;
		let failed = 0;
		for (const [key, entry] of byPath) {
			if (state.workspace?.root !== startRoot) break;
			const before = await readDocText(entry.path);
			if (before === null) continue;
			const { text: after, done } = applyCombinedLinkMends(before, entry.mends);
			if (!done || after === before) continue;
			try {
				await writeDocEdit(entry.path, after);
				mendedPaths.add(key);
				mendedLinks += done;
			} catch (e: any) {
				failed++;
				notify(`Could not update ${baseName(entry.path)}: ${e?.message ?? e}`, "error");
			}
		}
		if (mendedPaths.size) {
			setState((s) => { s.treeVersion += 1; });
			refreshDocAudit();
		}
		if (mendedLinks) {
			notify(`Mended ${count(mendedLinks, "link")} across ${count(mendedPaths.size, "document")}${failed ? ` (${failed} failed)` : ""}.`);
		} else if (!failed) {
			notify("No links needed mending — the documents may have already changed.");
		}
	};

	const syncSchemaFromSql = async (sqlPath: string, schemaPath?: string) => {
		try {
			await generateSchemaDocFromSql(sqlPath, schemaPath);
			refreshDocAudit();
		} catch (e: any) {
			notify(String(e?.message ?? e), "error");
		}
	};

	const createSchemaForUndocRef = async (ref: UndocumentedSchemaRef) => {
		try {
			await newSchema("database", undefined, ref.object);
			refreshDocAudit();
		} catch (e: any) {
			notify(String(e?.message ?? e), "error");
		}
	};

	const addUndocRefToDatabaseCsv = async (ref: UndocumentedSchemaRef) => {
		try {
			await addDatabaseRegistryRow(ref.object, ref.path, ref.line);
			refreshDocAudit();
		} catch (e: any) {
			notify(String(e?.message ?? e), "error");
		}
	};

	const exportRtmFromHealth = async () => {
		try {
			const mod = (await import("../projectDocs")) as { exportRtm?: () => Promise<void> };
			if (typeof mod.exportRtm === "function") await mod.exportRtm();
			else notify("Export Traceability Matrix (RTM) is not available yet.", "error");
		} catch (e: any) {
			notify(String(e?.message ?? e), "error");
		}
	};

	const driftCountsLabel = (item: SchemaDriftItem) =>
		[
			item.added.length ? `+${item.added.length} added` : "",
			item.modified.length ? `~${item.modified.length} modified` : "",
			item.dropped.length ? `-${item.dropped.length} dropped` : "",
		]
			.filter(Boolean)
			.join(" / ");

	const driftTooltip = (item: SchemaDriftItem) => {
		const root = state.workspace?.root ?? "";
		const rel = (p: string) => (root ? relativeTo(root, p).split("\\").join("/") : baseName(p));
		return [
			`${item.table}: ${rel(item.schemaPath)} vs ${rel(item.sqlPath)}`,
			item.added.length ? `Added in SQL: ${item.added.join(", ")}` : "",
			item.modified.length ? `Modified in SQL: ${item.modified.join(", ")}` : "",
			item.dropped.length ? `Dropped in SQL: ${item.dropped.join(", ")}` : "",
			"Click or press Enter to open the schema doc.",
		]
			.filter(Boolean)
			.join("\n");
	};

	const driftMenu = async (item: SchemaDriftItem, at: Point) => {
		const OPEN_DOC = "Open schema document";
		const OPEN_SQL = `Open ${baseName(item.sqlPath)}`;
		const SYNC = "Sync from SQL…";
		const picked = await chooseFromMenu(item.table, [OPEN_DOC, OPEN_SQL, "separator", SYNC], at);
		if (picked === OPEN_DOC) await openFile(item.schemaPath);
		else if (picked === OPEN_SQL) await openFile(item.sqlPath);
		else if (picked === SYNC) await syncSchemaFromSql(item.sqlPath, item.schemaPath);
	};

	const undocRefMenu = async (ref: UndocumentedSchemaRef, at: Point) => {
		const OPEN = `Open at line ${ref.line}`;
		const CREATE_DOC = "Create schema doc…";
		const ADD_CSV = "Add to database.csv";
		const SHOW = "Show in the Explorer";
		const inWs = Boolean(state.workspace && isInside(state.workspace.root, ref.path));
		const items: RowMenuEntry[] = [OPEN, "separator", CREATE_DOC, ADD_CSV, ...(inWs ? (["separator", SHOW] as RowMenuEntry[]) : [])];
		const picked = await chooseFromMenu(ref.object, items, at);
		if (picked === OPEN) await openFile(ref.path, { reveal: { line: ref.line } });
		else if (picked === CREATE_DOC) await createSchemaForUndocRef(ref);
		else if (picked === ADD_CSV) await addUndocRefToDatabaseCsv(ref);
		else if (picked === SHOW) (await import("./Explorer")).showInExplorer(ref.path);
	};

	const copyHealthReport = async () => {
		const root = state.workspace?.root ?? "";
		const rel = (p: string) => (root ? relativeTo(root, p).split("\\").join("/") : baseName(p));
		const name = state.project?.name || state.workspace?.name || "Workspace";
		const lines: string[] = [`# Health Report — ${name}`, ""];
		if (healthMode() !== "all" || healthQuery().trim()) {
			lines.push(
				`> Filter: ${healthMode() === "ticket" ? `Active ticket (${activeTicketKey()})` : healthMode() === "warnings" ? "Warnings only" : "All"}${healthQuery().trim() ? ` · "${healthQuery().trim()}"` : ""}`,
				"",
			);
		}
		const projectFiles = docs().filter((d) => d.group === "project");
		if (projectFiles.length) {
			lines.push("## Project files", "");
			for (const f of projectFiles) lines.push(`- ${f.name}: ${fileState(f)}`);
			lines.push("");
		}
		if (filteredChecks().length) {
			lines.push(`## Work checks (${filteredChecks().length})`, "");
			for (const c of filteredChecks()) lines.push(`- [${c.level}] ${c.text}`);
			lines.push("");
		}
		if (filteredDocIssues().length) {
			lines.push(`## Document checks (${filteredDocIssues().length})`, "");
			for (const i of filteredDocIssues()) lines.push(`- [${i.level}] \`${rel(i.path)}:${i.line}\` — ${i.message}`);
			lines.push("");
		}
		if (filteredSchemaDrift().length) {
			lines.push(`## Schema drift (${filteredSchemaDrift().length})`, "");
			for (const d of filteredSchemaDrift()) lines.push(`- **${d.table}** (\`${rel(d.schemaPath)}\` vs \`${rel(d.sqlPath)}\`): ${driftCountsLabel(d)}`);
			lines.push("");
		}
		if (filteredUndocRefs().length) {
			lines.push(`## Undocumented SQL / .ds tables (${filteredUndocRefs().length})`, "");
			for (const r of filteredUndocRefs()) lines.push(`- \`${r.object}\` in \`${rel(r.path)}:${r.line}\``);
			lines.push("");
		}
		if (filteredTruncated().length) {
			lines.push(`## Truncated doc folders (${filteredTruncated().length})`, "");
			for (const t of filteredTruncated()) lines.push(`- \`${t.folder}/\` reached the ${t.limit}-file scan limit`);
			lines.push("");
		}
		if (filteredOpenTasks().length) {
			lines.push(`## Open tasks (${filteredOpenTasks().length})`, "");
			for (const t of filteredOpenTasks()) lines.push(`- [ ] ${t.ticket ? `**${t.ticket}** ` : ""}${t.text} (\`${rel(t.path)}:${t.line}\`)`);
			lines.push("");
		}
		if (filteredCitations().length) {
			lines.push(`## Code citations (${filteredCitations().length})`, "");
			for (const c of filteredCitations()) lines.push(`- [${c.kind}] \`${rel(c.docPath)}:${c.docLine}\` — ${c.text}`);
			lines.push("");
		}
		if (filteredOrphans().length) {
			lines.push(`## Unused attachments (${filteredOrphans().length})`, "");
			for (const p of filteredOrphans()) lines.push(`- \`${rel(p)}\``);
			lines.push("");
		}
		if (registries().length) {
			lines.push("## Registries", "");
			for (const r of registries()) lines.push(`- ${r.title}: ${r.counted ? `${r.done} of ${r.total} done` : count(r.total, "row")}`);
			lines.push("");
		}
		if (activePath() && size()) {
			const s = size()!;
			lines.push(`## Active script (${rel(activePath()!)})`, "");
			lines.push(`- Size: ${(s.bytes / 1024).toFixed(1)} / ${limits().bytes / 1024} KB`);
			lines.push(`- Code lines: ${s.codeLines} / ${limits().codeLines}`);
			lines.push(`- Banner changes: ${s.historyEntries} / ${limits().historyEntries}`);
			lines.push(`- Findings: ${findings().length}`);
			lines.push("");
		}
		const { copyText } = await import("../commands");
		await copyText(lines.join("\n").trimEnd() + "\n", "Copied Health report as Markdown.");
	};

	const docIssueFixLabel = (issue: WorkspaceDocIssue) =>
		issue.fix?.kind === "record-approval"
			? "Approve…"
			: issue.fix?.kind === "reciprocal-adr"
				? `Add ${issue.fix.field}`
				: "";
	const docIssueFixTitle = (issue: WorkspaceDocIssue) =>
		issue.fix?.kind === "record-approval"
			? `Record approval metadata on ${baseName(issue.fix.path)}`
			: issue.fix?.kind === "reciprocal-adr"
				? `Add ${issue.fix.field}: ${issue.fix.value} to ${baseName(issue.fix.path)}`
				: "";
	const runDocIssueFix = (issue: WorkspaceDocIssue) => {
		if (!issue.fix) return;
		if (issue.fix.kind === "record-approval") void runRecordApproval(issue.fix.path);
		else if (issue.fix.kind === "reciprocal-adr") void fixReciprocalAdr(issue.fix);
	};

	const docIssueMenu = async (issue: WorkspaceDocIssue, at: Point) => {
		const OPEN = "Open at line";
		const SHOW = "Show in the Explorer";
		const FIX =
			issue.fix?.kind === "record-approval"
				? "Record approval…"
				: issue.fix?.kind === "reciprocal-adr"
					? `Add ${issue.fix.field}: ${issue.fix.value}`
					: "";
		const inWs = Boolean(state.workspace && isInside(state.workspace.root, issue.path));
		const items: RowMenuEntry[] = [
			OPEN,
			...(FIX ? (["separator", FIX] as RowMenuEntry[]) : []),
			...(inWs ? (["separator", SHOW] as RowMenuEntry[]) : []),
		];
		const picked = await chooseFromMenu(baseName(issue.path), items, at);
		if (picked === OPEN) await openFile(issue.path, { reveal: { line: issue.line, column: issue.column } });
		else if (FIX && picked === FIX) runDocIssueFix(issue);
		else if (picked === SHOW) (await import("./Explorer")).showInExplorer(issue.path);
	};
	const openTaskMenu = async (task: OpenTaskItem, at: Point) => {
		const OPEN = "Open at line";
		const TICK = "Mark task done";
		const picked = await chooseFromMenu(task.ticket ? `${task.ticket} task` : baseName(task.path), [OPEN, "separator", TICK], at);
		if (picked === OPEN) await openFile(task.path, { reveal: { line: task.line } });
		else if (picked === TICK) await tickOpenTask(task);
	};
	const citationMenu = async (issue: AuditCitationIssue, at: Point) => {
		const OPEN_DOC = "Open document at citation";
		const OPEN_TARGET = `Open ${baseName(issue.targetPath)} at L${issue.citation.from}`;
		const REANCHOR = issue.reanchor ? `Re-anchor to L${issue.reanchor.from}-L${issue.reanchor.to}` : "";
		const REFRESH = issue.kind === "drifted" ? "Refresh excerpt from live file…" : "";
		const fixes = [...(REANCHOR ? [REANCHOR] : []), ...(REFRESH ? [REFRESH] : [])];
		const items: RowMenuEntry[] = [OPEN_DOC, OPEN_TARGET, ...(fixes.length ? (["separator", ...fixes] as RowMenuEntry[]) : [])];
		const picked = await chooseFromMenu("Code citation", items, at);
		if (picked === OPEN_DOC) await openFile(issue.docPath, { reveal: { line: issue.docLine } });
		else if (picked === OPEN_TARGET) await openFile(issue.targetPath, { reveal: { line: issue.citation.from } });
		else if (REANCHOR && picked === REANCHOR) await reanchorIssue(issue);
		else if (REFRESH && picked === REFRESH) await refreshExcerptIssue(issue);
	};
	const orphanMenu = async (imgPath: string, at: Point) => {
		const PREVIEW = "Preview image";
		const SHOW = "Show in the Explorer";
		const TRASH = "Move to trash…";
		const inWs = Boolean(state.workspace && isInside(state.workspace.root, imgPath));
		const items: RowMenuEntry[] = [PREVIEW, ...(inWs ? [SHOW] : []), "separator", { label: TRASH, value: TRASH, danger: true }];
		const picked = await chooseFromMenu(baseName(imgPath), items, at);
		if (picked === PREVIEW) await openFile(imgPath);
		else if (picked === SHOW) (await import("./Explorer")).showInExplorer(imgPath);
		else if (picked === TRASH) await trashOrphanAttachment(imgPath);
	};
	// The working documents, or a catalog the app keeps: a project with scripts and a code catalog has that to check.
	const hasWork = () => docs().some((d) => d.exists && (d.group === "tickets" || d.group === "specs" || d.group === "knowledge" || d.group === "registries" || Boolean(d.catalog)));
	/** Each registry with how many of its rows are done: how far a migration has come, list by list. */
	const registries = () =>
		docs()
			.filter((d) => d.exists && d.group === "registries" && !isCatalog(d) && d.rows !== undefined)
			.map((d) => {
				const total = d.tally?.total ?? d.rows ?? 0;
				const done = d.tally ? d.tally.by.filter(([status]) => toneOf(status) === "done").reduce((n, [, count]) => n + count, 0) : 0;
				const left = d.tally ? d.tally.by.filter(([status]) => toneOf(status) !== "done").map(([status, count]) => `${count} ${status || "with no status"}`) : [];
				return { file: d, title: registryTitle(d.name), total, done, counted: Boolean(d.tally), left };
			});
	/** A mend that asks before it is made: one of its wikilinks would be given another note's name. */
	const asksFirst = (check: DocCheck) => check.fix?.kind === "mend-wikilinks" && splitWikiMends(check.fix.mends).guessed.length > 0;
	const fixLabel = (check: DocCheck) =>
		check.fix?.kind === "catalogs"
			? "Update"
			: check.fix?.kind === "links" || check.fix?.kind === "mend-wikilinks"
				? asksFirst(check)
					? "Mend…"
					: "Mend"
				: check.fix?.kind === "reciprocal-adr"
					? `Add ${check.fix.field}`
					: check.fix?.kind === "record-approval"
						? "Approve…"
						: "Start it";
	/** What mending a document's links does, in a line: where the one link will lead, or how many will be pointed where their files are. */
	const mendTitle = (mends: LinkMend[]) => (mends.length === 1 ? `Point the link at ${mends[0]!.instead}, where a file of that name is` : `Point ${mends.length} links at where files of their names are`);
	const wikiMendTitle = (mends: WikiLinkMend[]) => {
		// Where a link would be given another note's name, the title says it is a likeness and that it asks.
		const guessed = splitWikiMends(mends).guessed.length;
		if (mends.length === 1) return `Point [[${mends[0]!.name}]] at [[${mends[0]!.instead}]]${guessed ? ", the closest name there is: asks first" : ""}`;
		return guessed ? `Point ${mends.length} wikilinks at notes, ${guessed} of them at the closest name there is: asks first` : `Point ${mends.length} wikilinks at matching notes`;
	};
	const fixTitle = (check: DocCheck) =>
		check.fix?.kind === "catalogs"
			? "Write every catalog afresh from the documents in its folder"
			: check.fix?.kind === "ticket"
				? `Start ${check.fix.key} as a ticket of its own`
				: check.fix?.kind === "links"
					? mendTitle(check.fix.mends)
					: check.fix?.kind === "mend-wikilinks"
						? wikiMendTitle(check.fix.mends)
						: check.fix?.kind === "reciprocal-adr"
							? `Add ${check.fix.field}: ${check.fix.value} to ${baseName(check.fix.path)}`
							: check.fix?.kind === "record-approval"
								? `Record approval metadata on ${baseName(check.fix.path)}`
								: "";
	const fix = (check: DocCheck) => {
		if (!check.fix) return;
		if (check.fix.kind === "catalogs") void updateCatalogs();
		else if (check.fix.kind === "ticket") void newTicket(check.fix.key, check.fix.related);
		else if (check.fix.kind === "links") void mendLinks(check.path, check.fix.mends);
		else if (check.fix.kind === "mend-wikilinks") void mendWikiLinks(check.path, check.fix.mends);
		else if (check.fix.kind === "reciprocal-adr") void fixReciprocalAdr(check.fix);
		else if (check.fix.kind === "record-approval") void runRecordApproval(check.fix.path);
	};
	/** A check's document, at the place the check is about where it is about one. */
	const openCheck = (check: DocCheck) => openFile(check.path, check.line ? { reveal: { line: check.line } } : {});
	/** A check's menu: open its document, or put it right where the IDE can. */
	const checkMenu = async (check: DocCheck, at: Point) => {
		const open = "Open the document";
		const put =
			check.fix?.kind === "catalogs"
				? "Update the catalogs"
				: check.fix?.kind === "ticket"
					? `Start ${check.fix.key} as a ticket`
					: check.fix?.kind === "links"
						? mendTitle(check.fix.mends)
						: check.fix?.kind === "mend-wikilinks"
							? wikiMendTitle(check.fix.mends)
							: check.fix?.kind === "reciprocal-adr"
								? `Add ${check.fix.field}: ${check.fix.value}`
								: check.fix?.kind === "record-approval"
									? "Record approval…"
									: "";
		const picked = await chooseFromMenu("What to do about it", [open, ...(put ? (["separator", put] as RowMenuEntry[]) : [])], at);
		if (picked === open) await openCheck(check);
		else if (picked && picked === put) fix(check);
	};
	const bindTaskSpace = () => {
		let boundEl: HTMLElement | undefined;
		const onTaskSpace = (e: KeyboardEvent) => {
			if (e.key !== " " || e.ctrlKey || e.metaKey || e.altKey || e.shiftKey) return;
			const row = (e.target as HTMLElement | null)?.closest<HTMLElement>("[data-row]");
			const rowKey = row?.dataset.row;
			if (!rowKey) return;
			const task = filteredOpenTasks().find((t) => `${t.path}:${t.line}:${t.offset}` === rowKey);
			if (!task) return;
			e.preventDefault();
			e.stopPropagation();
			void tickOpenTask(task);
		};
		onCleanup(() => boundEl?.removeEventListener("keydown", onTaskSpace, true));
		return (el: HTMLElement) => {
			boundEl?.removeEventListener("keydown", onTaskSpace, true);
			boundEl = el;
			el.addEventListener("keydown", onTaskSpace, true);
		};
	};
	const fileState = (file: { exists: boolean; untouched?: boolean }) => (!file.exists ? "missing" : file.untouched ? "still the template text" : "written");
	return (
		<div class="panel-body health" data-panel="health">
			<div class="panel-title">
				<span>Health</span>
				<IconButton
					label="Export Traceability Matrix (RTM)"
					title="Export Traceability Matrix (RTM)…"
					icon="table"
					onClick={() => void exportRtmFromHealth()}
				/>
				<IconButton label="Copy Health report as Markdown" title="Copy Health report (Markdown)" icon="copy" onClick={() => void copyHealthReport()} />
				<IconButton label="Style profile" title="Open the style profile" icon="gear" onClick={() => openStyleProfile()} />
			</div>
			<div class="health-filter-bar">
				<input
					class="filter"
					type="search"
					aria-label="Filter Health findings, tasks, citations, and attachments"
					placeholder="Filter health"
					value={healthQuery()}
					onInput={(e) => setHealthQuery(e.currentTarget.value)}
					onKeyDown={(e) => e.key === "ArrowDown" && focusRowsBelow(e.currentTarget) && e.preventDefault()}
				/>
				<div class="docs-filter-pills" role="group" aria-label="Health filter mode">
					<button type="button" class={{ on: healthMode() === "all" }} onClick={() => setHealthMode("all")}>
						All
					</button>
					<Show when={activeTicketKey()}>
						<button
							type="button"
							class={{ on: healthMode() === "ticket" }}
							title={`Show only Health items for ${activeTicketKey()} and its linked work`}
							onClick={() => setHealthMode("ticket")}
						>
							Active ticket
						</button>
					</Show>
					<button
						type="button"
						class={{ on: healthMode() === "warnings" }}
						title="Show only warning-level checks and citations"
						onClick={() => setHealthMode("warnings")}
					>
						Warnings
					</button>
				</div>
			</div>
			<div class="health-scroll">
				<section>
				<h3>Project</h3>
				<Rows class="health-rows" role="listbox" label="The project's files">
					<For each={docs().filter((d) => d.group === "project")}>
						{(file) => {
							const info = projectDocLabel(file);
							const label = info?.label ?? file.name;
							return (
								<Row
									class="meter-row compact clickable"
									key={file.name}
									title={file.exists ? `${label} (${file.name}): ${fileState(file)}. ${file.path}` : `${label} (${file.name}) is missing. Click it, or press Enter on it, to create it.`}
									onActivate={() => (file.exists ? void openFile(file.path) : void setUpProject())}
								>
									<span class="health-project-label">
										<span>{label}</span>
										<Show when={info?.fileMeta}>
											<span class="project-file-meta">{info!.fileMeta}</span>
										</Show>
									</span>
									<Show when={file.exists && !file.untouched} fallback={<span class="meta warn">
											<Icon name="warning" /> {file.exists ? "template" : "missing"}
										</span>}>
										<span class="meta">
											<Icon name="check" />
											<span class="visually-hidden">written</span>
										</span>
									</Show>
								</Row>
							);
						}}
					</For>
				</Rows>
			</section>
			<Show when={hasWork()}>
				<section>
					<div class="health-sec-head">
						<h3 title="The tickets, specs, knowledge base and registries under the docs folder: what is out of date, not written, or named and not there">
							Work <span class="meta">{checksSummary(filteredChecks()) || (isFiltering() ? "0 matches" : "in order")}</span>
						</h3>
						<Show when={bulkMends().checks >= 2}>
							<button
								type="button"
								class="link health-sec-action"
								title={`Mend broken links across ${count(mendableDocCount(), "document")}`}
								onClick={() => void mendAllBrokenLinks()}
							>
								Mend all broken links
							</button>
						</Show>
					</div>
					<Show
						when={filteredChecks().length}
						fallback={
							<p class="hint">
								{isFiltering()
									? "No matching work checks."
									: "Every catalog says what its folder holds, every registry reads as a table, and nothing is named that is not there."}
							</p>
						}
					>
						<Rows class="health-rows" role="listbox" label="What the working documents need">
							<For each={filteredChecks()}>
								{(check) => (
									<Row
										class="check-row clickable"
										key={check.text}
										label={check.text}
										title={`${check.text}\nClick it, or press Enter on it, to open the document.${check.fix ? ` The menu key, or a right-click, offers: ${fixTitle(check).toLowerCase()}.` : ""}`}
										onActivate={() => void openCheck(check)}
										onMenu={(at) => void checkMenu(check, at)}
									>
										<span class={`check-mark ${check.level}`} aria-hidden="true">
											<Icon name={check.level === "warn" ? "warning" : "circle-small-filled"} />
										</span>
										<span class="label">{check.text}</span>
										<Show when={check.fix}>
											{/* For the pointer. From the keyboard the row's menu has it: a control inside a row is not a stop of its own (ADR 0010). */}
											<button class="link" tabindex={-1} title={fixTitle(check)} onClick={(e) => (e.stopPropagation(), fix(check))}>
												{fixLabel(check)}
											</button>
										</Show>
									</Row>
								)}
							</For>
						</Rows>
					</Show>
				</section>
			</Show>
			<Show when={filteredTruncated().length > 0}>
				<section>
					<div class="health-sec-head">
						<h3 style={{ display: "flex", "align-items": "center", gap: "4px" }}>
							<button
								type="button"
								aria-expanded={truncOpen() ? "true" : "false"}
								title={truncOpen() ? "Collapse truncated folders warning" : "Expand truncated folders warning"}
								style={{ display: "inline-flex", "align-items": "center", gap: "4px", background: "transparent", border: "none", padding: "0", color: "inherit", font: "inherit", cursor: "pointer" }}
								onClick={() => setTruncOpen((v) => !v)}
							>
								<Icon name={truncOpen() ? "chevron-down" : "chevron-right"} />
								<span>Truncated doc folders</span>
								<span class="meta">{filteredTruncated().length}</span>
							</button>
						</h3>
					</div>
					<Show when={truncOpen()}>
						<Rows class="health-rows" role="listbox" label="Truncated documentation folders">
							<For each={filteredTruncated()}>
								{(item) => (
									<Row
										class="check-row"
										key={`trunc:${item.folder}`}
										label={`${item.folder} reached ${item.limit} files`}
										title={`Folder ${item.folder}/ has more than ${item.limit} files. Only the first ${item.limit} files are indexed.`}
									>
										<span class="check-mark warn" aria-hidden="true">
											<Icon name="warning" />
										</span>
										<span class="label">
											Folder <code>{item.folder}/</code> reached the {item.limit}-file scan limit; additional files were not indexed.
										</span>
									</Row>
								)}
							</For>
						</Rows>
					</Show>
				</section>
			</Show>
			<Show when={filteredSchemaDrift().length > 0}>
				<section>
					<div class="health-sec-head">
						<h3 title="Schema Markdown documents whose column tables differ from their source SQL DDL">
							<button
								type="button"
								aria-expanded={driftOpen() ? "true" : "false"}
								title={driftOpen() ? "Collapse schema drift" : "Expand schema drift"}
								style={{ display: "inline-flex", "align-items": "center", gap: "4px", background: "transparent", border: "none", padding: "0", color: "inherit", font: "inherit", cursor: "pointer" }}
								onClick={() => setDriftOpen((v) => !v)}
							>
								<Icon name={driftOpen() ? "chevron-down" : "chevron-right"} />
								<span>Schema drift</span>
								<span class="meta">{filteredSchemaDrift().length}</span>
							</button>
						</h3>
					</div>
					<Show when={driftOpen()}>
						<Rows class="health-rows" role="listbox" label="Schema drift between SQL DDL and Markdown docs">
							<For each={filteredSchemaDrift()}>
								{(item) => (
									<Row
										class="check-row clickable"
										key={`drift:${item.schemaPath}:${item.table}`}
										label={`${item.table} ${driftCountsLabel(item)}`}
										title={driftTooltip(item)}
										onActivate={() => void openFile(item.schemaPath)}
										onMenu={(at) => void driftMenu(item, at)}
									>
										<span class="check-mark warn" aria-hidden="true">
											<Icon name="warning" />
										</span>
										<span class="label">
											<strong>{item.table}</strong> <span class="meta">{driftCountsLabel(item)}</span>
										</span>
										<button
											type="button"
											class="link"
											tabindex={-1}
											title={`Sync ${baseName(item.schemaPath)} from ${baseName(item.sqlPath)}`}
											onClick={(e) => (e.stopPropagation(), void syncSchemaFromSql(item.sqlPath, item.schemaPath))}
										>
											Sync from SQL
										</button>
									</Row>
								)}
							</For>
						</Rows>
					</Show>
				</section>
			</Show>
			<Show when={filteredUndocRefs().length > 0}>
				<section>
					<div class="health-sec-head">
						<h3 title="Tables queried in .sql and .ds files that are not documented in schema/ or database.csv">
							<button
								type="button"
								aria-expanded={undocOpen() ? "true" : "false"}
								title={undocOpen() ? "Collapse undocumented SQL tables" : "Expand undocumented SQL tables"}
								style={{ display: "inline-flex", "align-items": "center", gap: "4px", background: "transparent", border: "none", padding: "0", color: "inherit", font: "inherit", cursor: "pointer" }}
								onClick={() => setUndocOpen((v) => !v)}
							>
								<Icon name={undocOpen() ? "chevron-down" : "chevron-right"} />
								<span>Undocumented SQL / .ds tables</span>
								<span class="meta">{filteredUndocRefs().length}</span>
							</button>
						</h3>
					</div>
					<Show when={undocOpen()}>
						<Rows class="health-rows" role="listbox" label="Undocumented tables queried in SQL and data source files">
							<For each={filteredUndocRefs().slice(0, 60)}>
								{(ref) => (
									<Row
										class="check-row clickable"
										key={`undoc:${ref.path}:${ref.line}:${ref.object}`}
										label={`${ref.object} (${baseName(ref.path)}:${ref.line})`}
										title={`Undocumented table ${ref.object} queried at ${relativeTo(state.workspace?.root, ref.path)}:${ref.line}.\nClick or press Enter to open. Menu key offers Create schema doc or Add to database.csv.`}
										onActivate={() => void openFile(ref.path, { reveal: { line: ref.line } })}
										onMenu={(at) => void undocRefMenu(ref, at)}
									>
										<span class="check-mark note" aria-hidden="true">
											<Icon name="database" />
										</span>
										<span class="label">
											<strong>{ref.object}</strong> <span class="meta">({baseName(ref.path)}:{ref.line})</span>
										</span>
										<button
											type="button"
											class="link"
											tabindex={-1}
											title={`Create a database schema doc for ${ref.object}`}
											onClick={(e) => (e.stopPropagation(), void createSchemaForUndocRef(ref))}
										>
											Create schema doc…
										</button>
										<button
											type="button"
											class="link"
											tabindex={-1}
											title={`Add ${ref.object} to registries/database.csv citing ${relativeTo(state.workspace?.root, ref.path)}`}
											onClick={(e) => (e.stopPropagation(), void addUndocRefToDatabaseCsv(ref))}
										>
											Add to database.csv
										</button>
									</Row>
								)}
							</For>
						</Rows>
						<Show when={filteredUndocRefs().length > 60}>
							<p class="hint">Showing first 60 of {filteredUndocRefs().length} undocumented SQL table references.</p>
						</Show>
					</Show>
				</section>
			</Show>
			<Show when={filteredDocIssues().length > 0}>
				<section>
					<h3 title="Workspace-wide Markdown checks: broken #heading anchors, malformed YAML frontmatter, and ADR 0008 table readability">
						Document checks <span class="meta">{filteredDocIssues().length}</span>
					</h3>
					<Rows class="health-rows" role="listbox" label="Workspace document checks">
						<For each={filteredDocIssues().slice(0, 60)}>
							{(issue) => (
								<Row
									class="check-row clickable"
									key={`${issue.path}:${issue.line}:${issue.kind}:${issue.message}`}
									label={issue.message}
									title={`${relativeTo(state.workspace?.root, issue.path)}:${issue.line} — ${issue.message}\nClick or press Enter to open.${issue.fix ? ` Menu key offers: ${docIssueFixTitle(issue).toLowerCase()}.` : ""}`}
									onActivate={() => void openFile(issue.path, { reveal: { line: issue.line, column: issue.column } })}
									onMenu={(at) => void docIssueMenu(issue, at)}
								>
									<span class={`check-mark ${issue.level}`} aria-hidden="true">
										<Icon name={issue.level === "warn" ? "warning" : "circle-small-filled"} />
									</span>
									<span class="label">
										{issue.message} <span class="meta">({baseName(issue.path)}:{issue.line})</span>
									</span>
									<Show when={issue.fix}>
										<button
											type="button"
											class="link"
											tabindex={-1}
											title={docIssueFixTitle(issue)}
											onClick={(e) => (e.stopPropagation(), runDocIssueFix(issue))}
										>
											{docIssueFixLabel(issue)}
										</button>
									</Show>
								</Row>
							)}
						</For>
					</Rows>
					<Show when={filteredDocIssues().length > 60}>
						<p class="hint">Showing first 60 of {filteredDocIssues().length} document checks (all appear in Problems → Docs).</p>
					</Show>
				</section>
			</Show>
			<Show when={filteredOpenTasks().length > 0}>
				<section ref={bindTaskSpace()}>
					<h3 title="Unchecked - [ ] tasks across active tickets, specs, and project notes">
						Open tasks <span class="meta">{filteredOpenTasks().length}</span>
					</h3>
					<Rows class="health-rows" role="listbox" label="Open checklist tasks across workspace">
						<For each={filteredOpenTasks().slice(0, 50)}>
							{(task) => (
								<Row
									class="check-row task-check-row clickable"
									key={`${task.path}:${task.line}:${task.offset}`}
									label={task.text}
									title={`${task.ticket ? `${task.ticket} — ` : ""}${relativeTo(state.workspace?.root, task.path)}:${task.line}\nEnter opens at line ${task.line}; Space ticks the box; menu key has both.`}
									onActivate={() => void openFile(task.path, { reveal: { line: task.line } })}
									onKeep={() => void openFile(task.path, { keep: true, reveal: { line: task.line } })}
									onMenu={(at) => void openTaskMenu(task, at)}
								>
									<button
										type="button"
										class="task-tick-btn"
										tabindex={-1}
										title="Mark task done (Space)"
										aria-label={`Mark done: ${task.text}`}
										onClick={(e) => (e.stopPropagation(), void tickOpenTask(task))}
									>
										<Icon name="circle-outline" />
									</button>
									<span class="label">
										<Show when={task.ticket}>
											<strong class="doc-key">{task.ticket}</strong>{" "}
										</Show>
										{task.text}
										<Show when={!task.ticket}>
											{" "}
											<span class="meta">({baseName(task.path)})</span>
										</Show>
									</span>
								</Row>
							)}
						</For>
					</Rows>
					<Show when={filteredOpenTasks().length > 50}>
						<p class="hint">Showing first 50 of {filteredOpenTasks().length} open tasks.</p>
					</Show>
				</section>
			</Show>
			<Show when={filteredCitations().length > 0}>
				<section>
					<div class="health-sec-head">
						<h3 title="Markdown #L10-L20 code citations whose line numbers drifted or went out of range">
							Code citations <span class="meta">{filteredCitations().length}</span>
						</h3>
						<Show when={reanchorableCitations().length > 0}>
							<button
								type="button"
								class="link health-sec-action"
								title={`Re-anchor all ${reanchorableCitations().length} shifted code citations`}
								onClick={() => void reanchorAll()}
							>
								Re-anchor all
							</button>
						</Show>
					</div>
					<Rows class="health-rows" role="listbox" label="Drifted code citations">
						<For each={filteredCitations()}>
							{(issue) => (
								<Row
									class="check-row clickable"
									key={`${issue.docPath}:${issue.docLine}:${issue.citation.href}`}
									label={issue.text}
									title={`${issue.text}\nClick or Enter to open ${baseName(issue.docPath)} at line ${issue.docLine}. Menu key has Re-anchor / Refresh excerpt.`}
									onActivate={() => void openFile(issue.docPath, { reveal: { line: issue.docLine } })}
									onMenu={(at) => void citationMenu(issue, at)}
								>
									<span class={`check-mark ${issue.level}`} aria-hidden="true">
										<Icon name={issue.level === "warn" ? "warning" : "circle-small-filled"} />
									</span>
									<span class="label">{issue.text}</span>
									<Show when={issue.reanchor}>
										<button
											class="link"
											tabindex={-1}
											title={`Update citation to #L${issue.reanchor!.from}-L${issue.reanchor!.to}`}
											onClick={(e) => (e.stopPropagation(), void reanchorIssue(issue))}
										>
											Re-anchor
										</button>
									</Show>
									<Show when={issue.kind === "drifted"}>
										<button
											class="link"
											tabindex={-1}
											title={`Replace quoted snippet with current lines from ${baseName(issue.targetPath)}`}
											onClick={(e) => (e.stopPropagation(), void refreshExcerptIssue(issue))}
										>
											Refresh excerpt
										</button>
									</Show>
								</Row>
							)}
						</For>
					</Rows>
				</section>
			</Show>
			<Show when={filteredOrphans().length > 0}>
				<section>
					<div class="health-sec-head">
						<h3 title="Images in attachments folders not referenced by any Markdown document">
							Unused attachments <span class="meta">{filteredOrphans().length}</span>
						</h3>
						<button
							type="button"
							class="link health-sec-action"
							title={`Move all ${filteredOrphans().length} unused attachments to the trash`}
							onClick={() => void trashAllOrphans()}
						>
							Trash all unused…
						</button>
					</div>
					<Rows class="health-rows" role="listbox" label="Unused attachment images">
						<For each={filteredOrphans()}>
							{(imgPath) => (
								<Row
									class="check-row clickable"
									key={imgPath}
									label={baseName(imgPath)}
									title={`Unused attachment ${relativeTo(state.workspace?.root, imgPath)}. Click to preview; Delete moves to trash.`}
									onActivate={() => void openFile(imgPath)}
									onMenu={(at) => void orphanMenu(imgPath, at)}
									onKey={(e) => {
										if (e.key !== "Delete") return false;
										void trashOrphanAttachment(imgPath);
										return true;
									}}
								>
									<span class="check-mark note" aria-hidden="true">
										<Icon name="file-media" />
									</span>
									<span class="label">{baseName(imgPath)}</span>
									<button
										class="link"
										tabindex={-1}
										title={`Move ${baseName(imgPath)} to trash (Delete)`}
										onClick={(e) => (e.stopPropagation(), void trashOrphanAttachment(imgPath))}
									>
										Trash
									</button>
								</Row>
							)}
						</For>
					</Rows>
				</section>
			</Show>
			<Show when={registries().length}>
				<section>
					<h3 title="Each registry under the docs folder, with how many of its rows are done: verified, migrated, or another word that comes to finished">Registries</h3>
					<Rows class="health-rows" role="listbox" label="How far each registry has come">
						<For each={registries()}>
							{(r) => (
								<Row
									class="meter-row sized clickable"
									key={r.file.path}
									label={r.title}
									title={r.counted ? `${r.title}: ${r.done} of ${r.total} done.${r.left.length ? ` Left: ${r.left.join(", ")}.` : ""} Click it, or press Enter on it, to open it.` : `${r.title}: ${count(r.total, "row")}. It has no status column, so how far it is cannot be told.`}
									onActivate={() => void openFile(r.file.path)}
								>
									<span class="label">{r.title}</span>
									<span class="meta">{r.counted ? `${r.done} of ${r.total}` : count(r.total, "row")}</span>
									<Show when={r.counted}>
										<span class="bar" aria-hidden="true">
											<span class="fill" style={{ display: "block", width: `${r.total ? Math.round((r.done / r.total) * 100) : 0}%` }} />
										</span>
									</Show>
								</Row>
							)}
						</For>
					</Rows>
				</section>
			</Show>
			<Show when={activePath() && size()} fallback={<p class="hint">Open an SSL file to see its size, procedures and findings.</p>}>
				<section>
					<h3 title="The house limits for one script (program decision 0006)">Size limits</h3>
					<Meter label="Bytes" value={size()!.bytes} limit={limits().bytes} unit="KB" />
					<Meter label="Code lines" value={size()!.codeLines} limit={limits().codeLines} />
					<Meter
						label="Banner changes"
						title="Modification entries in the file's banner, against the house limit (program decision 0006). These are not the snapshots in Local history."
						value={size()!.historyEntries}
						limit={limits().historyEntries}
						near={1}
					/>
				</section>
				<section>
					<h3>
						Procedures <span class="meta">{procs().length}</span>
					</h3>
					<Show when={procs().length > LONGEST}>
						<p class="hint">The {LONGEST} longest:</p>
					</Show>
					<Rows class="health-rows" role="listbox" label="The longest procedures">
						<For each={procs().slice(0, LONGEST)}>
							{(p) => (
								<Row
									class="meter-row sized clickable"
									key={p.name}
									label={`${p.name}, ${count(p.lines, "line")}`}
									title={`${p.name}: ${count(p.lines, "line")}. Click it, or press Enter on it, to go to it.`}
									onActivate={() => activePath() && void openFile(activePath()!, { reveal: { line: p.line } })}
								>
									<span class="label">{p.name}</span>
									<span class="meta">{count(p.lines, "line")}</span>
									<span class="bar" aria-hidden="true">
										<span class="fill plain" style={{ width: share(p.lines) }} />
									</span>
								</Row>
							)}
						</For>
					</Rows>
				</section>
				<section>
					<h3>
						Findings <span class="meta">{findings().length}</span>
					</h3>
					<Show when={byRule().length} fallback={<p class="hint">{serverDown() ? `${serverDown()} This file is not checked until it runs.` : "No findings in this file."}</p>}>
						<Rows class="health-rows" role="listbox" label="Findings in this file, by rule">
							<For each={byRule()}>
								{([rule, entry]) => (
									<Row
										class="meter-row compact clickable"
										key={rule}
										label={rule}
										title={`${rule}: ${count(entry.count, "finding")} (${SEVERITY[entry.severity]!.toLowerCase()}). Click, or press Enter, to see them in Problems.`}
										onActivate={() =>
											setState((s) => {
												s.bottomView = "problems";
												s.settings.layout.bottom = true;
											})
										}
									>
										<SeverityMark severity={entry.severity} />
										<span class="label">{rule}</span>
										<span class="meta">{entry.count}</span>
									</Row>
								)}
							</For>
						</Rows>
					</Show>
				</section>
			</Show>
			</div>
		</div>
	);
}
