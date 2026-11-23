// The project's documents and what the documents of the work need from
// someone, and the current script against the house style: size, procedures,
// findings.
import { Icon } from "../Icon";
import { createEffect, createMemo, createSignal, For, onCleanup, Show } from "solid-js";
import { reanchorCitation, refreshCitationExcerpt } from "../../shared/codeCitations";
import { level } from "../../shared/houseStyle";
import type { AuditCitationIssue, OpenTaskItem, WorkspaceDocIssue } from "../../shared/protocol";
import { tasks } from "../../shared/tasks";
import { descendantTickets, ticketWork } from "../../shared/workContext";
import { backend } from "../backend";
import { choose } from "../dialogs";
import { docAuditData, refreshDocAudit } from "../docAudit";
import { monaco } from "../editor/monaco";
import { diagnostics } from "../lsp/session";
import { size } from "../StatusBar";
import { activeDoc, activePath, applyText, canonical, documents, notify, openFile, save, setState, state } from "../state";
import { baseName, isInside, relativeTo } from "../../shared/paths";
import { symbols } from "./Objects";
import { SeverityMark, SEVERITY } from "./Problems";
import { focusRowsBelow, IconButton, Row, Rows, type Point } from "./Rows";
import { chooseFromMenu } from "./RowMenu";
import { serverDown } from "./server";
import { openStyleProfile } from "../StyleProfile";
import { docs, setUpProject } from "../project";
import { checksSummary, docChecks, type DocCheck, type LinkMend } from "../../shared/docChecks";
import { folderParts } from "../../shared/docSections";
import { CATALOG_AREAS, isCatalog, registryTitle, toneOf } from "../../shared/projectDocs";
import { mendLinks, newTicket, updateCatalogs } from "../projectDocs";

const PROCEDURE = new Set([monaco.languages.SymbolKind.Function, monaco.languages.SymbolKind.Method]);

function procedures(list = symbols()): monaco.languages.DocumentSymbol[] {
	return list.flatMap((s) => (PROCEDURE.has(s.kind) ? [s] : procedures(s.children ?? [])));
}

/** How many of the longest procedures are listed. */
const LONGEST = 8;
const count = (n: number, one: string) => `${n} ${one}${n === 1 ? "" : "s"}`;

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
	// Citation issues have their own dedicated section below with 1-click Re-anchor and Refresh excerpt.
	const docAuditIssues = () => auditResult().issues.filter((i) => i.kind !== "citation");

	// Compact Health filter bar (All / Active ticket / Warnings + text search).
	const [healthMode, setHealthMode] = createSignal<"all" | "ticket" | "warnings">("all");
	const [healthQuery, setHealthQuery] = createSignal("");
	const activeTicketKey = () => state.settings.activeTicket?.trim() || "";
	createEffect(() => {
		if (!activeTicketKey() && healthMode() === "ticket") setHealthMode("all");
	});
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
	const reanchorableCitations = createMemo(() => filteredCitations().filter((c) => Boolean(c.reanchor)));

	/** Applies an edit to an open or closed document: clean open buffers save to disk; dirty buffers stay unsaved (ADR 0009). */
	const writeDocEdit = async (path: string, next: string) => {
		const key = canonical(path);
		const open = documents.get(key);
		if (open) {
			const clean = !state.dirty[key];
			applyText(key, next);
			if (clean) await save(key, { format: false });
		} else {
			await backend.historyKeep(path).catch(() => {});
			await backend.write(path, next);
		}
	};

	const tickOpenTask = async (task: OpenTaskItem) => {
		const key = canonical(task.path);
		const open = documents.get(key);
		const cur = open ? open.model.getValue() : await backend.read(task.path).then((r) => (r.binary ? null : r.text), () => null);
		if (cur === null) return notify("Could not read the document.", "error");
		let offset = -1;
		if (task.offset > 0 && cur[task.offset] === " " && cur[task.offset - 1] === "[" && cur[task.offset + 1] === "]") {
			offset = task.offset;
		} else {
			const hit = tasks(cur).find((t) => !t.done && t.line === task.line && t.text === task.text && t.offset > 0);
			if (hit) offset = hit.offset;
		}
		if (offset < 0) return notify("Could not locate that task box — the document changed. Open it to tick it.", "error");
		const next = `${cur.slice(0, offset)}x${cur.slice(offset + 1)}`;
		await writeDocEdit(task.path, next);
		setState("treeVersion", (v) => v + 1);
		refreshDocAudit();
		notify(`Ticked off task in ${task.ticket ?? task.title ?? baseName(task.path)}.`);
	};

	const reanchorIssue = async (issue: AuditCitationIssue) => {
		if (!issue.reanchor) return;
		const key = canonical(issue.docPath);
		const open = documents.get(key);
		const cur = open ? open.model.getValue() : await backend.read(issue.docPath).then((r) => (r.binary ? null : r.text), () => null);
		if (cur === null) return notify("Could not read the document.", "error");
		const next = reanchorCitation(cur, issue.citation, issue.reanchor.from, issue.reanchor.to);
		if (next === cur) return;
		await writeDocEdit(issue.docPath, next);
		setState("treeVersion", (v) => v + 1);
		refreshDocAudit();
		notify(`Re-anchored citation to L${issue.reanchor.from}-L${issue.reanchor.to}.`);
	};

	const refreshExcerptIssue = async (issue: AuditCitationIssue) => {
		if (issue.kind !== "drifted") return;
		const readCurrent = async (p: string) => {
			const open = documents.get(canonical(p));
			if (open) return open.model.getValue();
			return backend.read(p).then((r) => (r.binary ? null : r.text), () => null);
		};
		const [docText, targetText] = await Promise.all([readCurrent(issue.docPath), readCurrent(issue.targetPath)]);
		if (docText === null || targetText === null) return notify("Could not read the document or cited file.", "error");
		const next = refreshCitationExcerpt(docText, issue.citation, targetText);
		if (!next || next === docText) return notify("Could not find a following fenced code block to refresh.", "error");
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
		await writeDocEdit(issue.docPath, next);
		setState("treeVersion", (v) => v + 1);
		refreshDocAudit();
		notify(`Refreshed quoted excerpt in ${baseName(issue.docPath)}.`);
	};

	const reanchorAll = async () => {
		const list = reanchorableCitations();
		if (!list.length) return;
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
		if (answer !== GO) return;
		let updated = 0;
		for (const [, docItems] of byDoc) {
			const docPath = docItems[0]!.docPath;
			const open = documents.get(canonical(docPath));
			let cur = open ? open.model.getValue() : await backend.read(docPath).then((r) => (r.binary ? null : r.text), () => null);
			if (cur === null) continue;
			let changed = false;
			for (const item of docItems) {
				if (!item.reanchor) continue;
				const next = reanchorCitation(cur, item.citation, item.reanchor.from, item.reanchor.to);
				if (next !== cur) {
					cur = next;
					changed = true;
					updated++;
				}
			}
			if (changed) await writeDocEdit(docPath, cur);
		}
		setState("treeVersion", (v) => v + 1);
		refreshDocAudit();
		notify(updated ? `Re-anchored ${count(updated, "citation")}.` : "Citations were already up to date.");
	};

	const trashOrphanAttachment = async (path: string) => {
		const root = state.workspace?.root ?? "";
		const rel = root ? relativeTo(root, path).split("\\").join("/") : baseName(path);
		const TRASH = "Move to trash";
		if ((await choose(`Move unused attachment ${rel} to the trash?`, [TRASH], { danger: TRASH })) !== TRASH) return;
		try {
			await backend.trash(path);
			setState("treeVersion", (v) => v + 1);
			refreshDocAudit();
			notify(`Moved unused attachment ${baseName(path)} to trash.`);
		} catch (e: any) {
			notify(`Could not move to trash: ${e?.message ?? e}`, "error");
		}
	};

	const trashAllOrphans = async () => {
		const list = filteredOrphans();
		if (!list.length) return;
		const TRASH_ALL = `Trash ${list.length} unused`;
		const preview = list.slice(0, 4).map(baseName).join(", ") + (list.length > 4 ? ` and ${list.length - 4} more` : "");
		const picked = await choose(
			`Move ${count(list.length, "unused attachment")} (${preview}) to the trash?`,
			[TRASH_ALL],
			{ danger: TRASH_ALL },
		);
		if (picked !== TRASH_ALL) return;
		let trashed = 0;
		for (const p of list) {
			try {
				await backend.trash(p);
				trashed++;
			} catch {
				// continue remaining
			}
		}
		setState("treeVersion", (v) => v + 1);
		refreshDocAudit();
		notify(`Moved ${count(trashed, "unused attachment")} to trash.`);
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

	const docIssueMenu = async (issue: WorkspaceDocIssue, at: Point) => {
		const OPEN = "Open at line";
		const picked = await chooseFromMenu(baseName(issue.path), [OPEN], at);
		if (picked === OPEN) await openFile(issue.path, { reveal: { line: issue.line, column: issue.column } });
	};
	const openTaskMenu = async (task: OpenTaskItem, at: Point) => {
		const OPEN = "Open at line";
		const TICK = "Mark task done";
		const picked = await chooseFromMenu(task.ticket ? `${task.ticket} task` : baseName(task.path), [OPEN, TICK], at);
		if (picked === OPEN) await openFile(task.path, { reveal: { line: task.line } });
		else if (picked === TICK) await tickOpenTask(task);
	};
	const citationMenu = async (issue: AuditCitationIssue, at: Point) => {
		const OPEN_DOC = "Open document at citation";
		const OPEN_TARGET = `Open ${baseName(issue.targetPath)} at L${issue.citation.from}`;
		const REANCHOR = issue.reanchor ? `Re-anchor to L${issue.reanchor.from}-L${issue.reanchor.to}` : "";
		const REFRESH = issue.kind === "drifted" ? "Refresh excerpt from live file…" : "";
		const items = [OPEN_DOC, OPEN_TARGET, ...(REANCHOR ? [REANCHOR] : []), ...(REFRESH ? [REFRESH] : [])];
		const picked = await chooseFromMenu("Code citation", items, at);
		if (picked === OPEN_DOC) await openFile(issue.docPath, { reveal: { line: issue.docLine } });
		else if (picked === OPEN_TARGET) await openFile(issue.targetPath, { reveal: { line: issue.citation.from } });
		else if (REANCHOR && picked === REANCHOR) await reanchorIssue(issue);
		else if (REFRESH && picked === REFRESH) await refreshExcerptIssue(issue);
	};
	const orphanMenu = async (imgPath: string, at: Point) => {
		const PREVIEW = "Preview image";
		const TRASH = "Move to trash…";
		const picked = await chooseFromMenu(baseName(imgPath), [PREVIEW, TRASH], at);
		if (picked === PREVIEW) await openFile(imgPath);
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
	const fixLabel = (check: DocCheck) => (check.fix?.kind === "catalogs" ? "Update" : check.fix?.kind === "links" ? "Mend" : "Start it");
	/** What mending a document's links does, in a line: where the one link will lead, or how many will be pointed where their files are. */
	const mendTitle = (mends: LinkMend[]) => (mends.length === 1 ? `Point the link at ${mends[0]!.instead}, where a file of that name is` : `Point ${mends.length} links at where files of their names are`);
	const fixTitle = (check: DocCheck) =>
		check.fix?.kind === "catalogs" ? "Write every catalog afresh from the documents in its folder" : check.fix?.kind === "ticket" ? `Start ${check.fix.key} as a ticket of its own` : check.fix?.kind === "links" ? mendTitle(check.fix.mends) : "";
	const fix = (check: DocCheck) =>
		check.fix?.kind === "catalogs" ? void updateCatalogs() : check.fix?.kind === "ticket" ? void newTicket(check.fix.key, check.fix.related) : check.fix?.kind === "links" ? void mendLinks(check.path, check.fix.mends) : undefined;
	/** A check's document, at the place the check is about where it is about one. */
	const openCheck = (check: DocCheck) => openFile(check.path, check.line ? { reveal: { line: check.line } } : {});
	/** A check's menu: open its document, or put it right where the IDE can. */
	const checkMenu = async (check: DocCheck, at: Point) => {
		const open = "Open the document";
		const put = check.fix?.kind === "catalogs" ? "Update the catalogs" : check.fix?.kind === "ticket" ? `Start ${check.fix.key} as a ticket` : check.fix?.kind === "links" ? mendTitle(check.fix.mends) : "";
		const picked = await chooseFromMenu("What to do about it", [open, ...(put ? [put] : [])], at);
		if (picked === open) await openCheck(check);
		else if (picked && picked === put) fix(check);
	};
	const fileState = (file: { exists: boolean; untouched?: boolean }) => (!file.exists ? "missing" : file.untouched ? "still the template text" : "written");
	return (
		<div class="panel-body health" data-panel="health">
			<div class="panel-title">
				<span>Health</span>
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
					<button type="button" classList={{ on: healthMode() === "all" }} onClick={() => setHealthMode("all")}>
						All
					</button>
					<Show when={activeTicketKey()}>
						<button
							type="button"
							classList={{ on: healthMode() === "ticket" }}
							title={`Show only Health items for ${activeTicketKey()} and its linked work`}
							onClick={() => setHealthMode("ticket")}
						>
							Active ticket
						</button>
					</Show>
					<button
						type="button"
						classList={{ on: healthMode() === "warnings" }}
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
						{(file) => (
							<Row
								class="meter-row compact clickable"
								key={file.name}
								title={file.exists ? `${file.name}: ${fileState(file)}. ${file.path}` : `${file.name} is missing. Click it, or press Enter on it, to create it.`}
								onActivate={() => (file.exists ? void openFile(file.path) : void setUpProject())}
							>
								<span>{file.name}</span>
								<Show when={file.exists && !file.untouched} fallback={<span class="meta warn">
										<Icon name="warning" /> {file.exists ? "template" : "missing"}
									</span>}>
									<span class="meta">
										<Icon name="check" />
										<span class="visually-hidden">written</span>
									</span>
								</Show>
							</Row>
						)}
					</For>
				</Rows>
			</section>
			<Show when={hasWork()}>
				<section>
					<h3 title="The tickets, specs, knowledge base and registries under the docs folder: what is out of date, not written, or named and not there">
						Work <span class="meta">{checksSummary(filteredChecks()) || (isFiltering() ? "0 matches" : "in order")}</span>
					</h3>
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
									title={`${relativeTo(state.workspace?.root, issue.path)}:${issue.line} — ${issue.message}\nClick or press Enter to open.`}
									onActivate={() => void openFile(issue.path, { reveal: { line: issue.line, column: issue.column } })}
									onMenu={(at) => void docIssueMenu(issue, at)}
								>
									<span class={`check-mark ${issue.level}`} aria-hidden="true">
										<Icon name={issue.level === "warn" ? "warning" : "circle-small-filled"} />
									</span>
									<span class="label">
										{issue.message} <span class="meta">({baseName(issue.path)}:{issue.line})</span>
									</span>
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
				<section
					ref={(el) => {
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
						el.addEventListener("keydown", onTaskSpace, true);
						onCleanup(() => el.removeEventListener("keydown", onTaskSpace, true));
					}}
				>
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
										onActivate={() => (setState("bottomView", "problems"), setState("settings", "layout", "bottom", true))}
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
