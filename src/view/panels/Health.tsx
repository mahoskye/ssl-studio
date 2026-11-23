// The project's documents and what the documents of the work need from
// someone, and the current script against the house style: size, procedures,
// findings.
import { Icon } from "../Icon";
import { createResource, For, Show } from "solid-js";
import { checkCodeCitations, reanchorCitation, type CitationIssue } from "../../shared/codeCitations";
import { level } from "../../shared/houseStyle";
import type { OpenTaskItem } from "../../shared/protocol";
import { tasks } from "../../shared/tasks";
import { backend } from "../backend";
import { choose } from "../dialogs";
import { docAuditData, refreshDocAudit } from "../docAudit";
import { monaco } from "../editor/monaco";
import { diagnostics } from "../lsp/session";
import { size } from "../StatusBar";
import { activeDoc, activePath, applyText, canonical, documents, notify, openFile, setState, state } from "../state";
import { baseName, relativeTo } from "../../shared/paths";
import { symbols } from "./Objects";
import { SeverityMark, SEVERITY } from "./Problems";
import { IconButton, Row, Rows, type Point } from "./Rows";
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
	const checks = () => docChecks(docs(), areas());
	// Async live checks: #L10-L20 code-citation drift detection + orphaned docs/attachments/ image audit.
	const [citationIssues, { refetch: refetchCitations }] = createResource(
		() => {
			const root = state.workspace?.root;
			const mdDocs = docs().filter((d) => d.exists && !isCatalog(d) && /\.(md|markdown)$/i.test(d.path));
			return root && mdDocs.length ? { root, version: state.treeVersion, mdDocs } : null;
		},
		async ({ root, mdDocs }) => {
			const readCached = async (p: string) => {
				const open = documents.get(canonical(p));
				if (open) return open.model.getValue();
				return backend.read(p).then((r) => (r.binary ? null : r.text), () => null);
			};
			const issues: CitationIssue[] = [];
			for (const d of mdDocs.slice(0, 120)) {
				const txt = await readCached(d.path);
				if (!txt || !txt.includes("#L")) continue;
				const found = await checkCodeCitations(d.path, txt, root, readCached);
				issues.push(...found);
			}
			return issues;
		},
	);
	const auditResult = docAuditData;
	const orphanAttachments = () => auditResult().unusedAttachments;
	const openTasks = () => auditResult().openTasks;
	const docAuditIssues = () => auditResult().issues;
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
		if (open) {
			applyText(key, next);
		} else {
			await backend.historyKeep(task.path).catch(() => {});
			await backend.write(task.path, next);
		}
		setState("treeVersion", (v) => v + 1);
		refreshDocAudit();
		notify(`Ticked off task in ${task.ticket ?? task.title ?? baseName(task.path)}.`);
	};
	const reanchorIssue = async (issue: CitationIssue) => {
		if (!issue.reanchor) return;
		const key = canonical(issue.docPath);
		const open = documents.get(key);
		const cur = open ? open.model.getValue() : await backend.read(issue.docPath).then((r) => r.text, () => null);
		if (cur === null) return notify("Could not read the document.", "error");
		const next = reanchorCitation(cur, issue.citation, issue.reanchor.from, issue.reanchor.to);
		if (next === cur) return;
		if (open) {
			applyText(key, next);
		} else {
			await backend.historyKeep(issue.docPath).catch(() => {});
			await backend.write(issue.docPath, next);
		}
		setState("treeVersion", (v) => v + 1);
		void refetchCitations();
		notify(`Re-anchored citation to L${issue.reanchor.from}-L${issue.reanchor.to}.`);
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
				<IconButton label="Style profile" title="Open the style profile" icon="gear" onClick={() => openStyleProfile()} />
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
						Work <span class="meta">{checksSummary(checks()) || "in order"}</span>
					</h3>
					<Show when={checks().length} fallback={<p class="hint">Every catalog says what its folder holds, every registry reads as a table, and nothing is named that is not there.</p>}>
						<Rows class="health-rows" role="listbox" label="What the working documents need">
							<For each={checks()}>
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
			<Show when={docAuditIssues().length > 0}>
				<section>
					<h3 title="Workspace-wide Markdown checks: broken #heading anchors, malformed YAML frontmatter, and ADR 0008 table readability">
						Document checks <span class="meta">{docAuditIssues().length}</span>
					</h3>
					<Rows class="health-rows" role="listbox" label="Workspace document checks">
						<For each={docAuditIssues().slice(0, 60)}>
							{(issue) => (
								<Row
									class="check-row clickable"
									key={`${issue.path}:${issue.line}:${issue.kind}:${issue.message}`}
									label={issue.message}
									title={`${relativeTo(state.workspace?.root, issue.path)}:${issue.line} — ${issue.message}\nClick to open.`}
									onActivate={() => void openFile(issue.path, { reveal: { line: issue.line, column: issue.column } })}
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
					<Show when={docAuditIssues().length > 60}>
						<p class="hint">Showing first 60 of {docAuditIssues().length} document checks (all appear in Problems → Docs).</p>
					</Show>
				</section>
			</Show>
			<Show when={openTasks().length > 0}>
				<section>
					<h3 title="Unchecked - [ ] tasks across active tickets, specs, and project notes">
						Open tasks <span class="meta">{openTasks().length}</span>
					</h3>
					<Rows class="health-rows" role="listbox" label="Open checklist tasks across workspace">
						<For each={openTasks().slice(0, 50)}>
							{(task) => (
								<Row
									class="check-row task-check-row clickable"
									key={`${task.path}:${task.line}:${task.offset}`}
									label={task.text}
									title={`${task.ticket ? `${task.ticket} — ` : ""}${relativeTo(state.workspace?.root, task.path)}:${task.line}\nClick to open at line ${task.line}, or tick the box to mark complete.`}
									onActivate={() => void openFile(task.path, { reveal: { line: task.line } })}
								>
									<button
										type="button"
										class="task-tick-btn"
										tabindex={-1}
										title="Mark task done"
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
					<Show when={openTasks().length > 50}>
						<p class="hint">Showing first 50 of {openTasks().length} open tasks.</p>
					</Show>
				</section>
			</Show>
			<Show when={(citationIssues()?.length ?? 0) > 0}>
				<section>
					<h3 title="Markdown #L10-L20 code citations whose line numbers drifted or went out of range">
						Code citations <span class="meta">{citationIssues()!.length}</span>
					</h3>
					<Rows class="health-rows" role="listbox" label="Drifted code citations">
						<For each={citationIssues()}>
							{(issue) => (
								<Row
									class="check-row clickable"
									key={`${issue.docPath}:${issue.docLine}:${issue.citation.href}`}
									label={issue.text}
									title={`${issue.text}\nClick to open ${baseName(issue.docPath)} at line ${issue.docLine}.`}
									onActivate={() => void openFile(issue.docPath, { reveal: { line: issue.docLine } })}
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
								</Row>
							)}
						</For>
					</Rows>
				</section>
			</Show>
			<Show when={(orphanAttachments()?.length ?? 0) > 0}>
				<section>
					<h3 title="Images in docs/attachments/ not referenced by any Markdown document">
						Unused attachments <span class="meta">{orphanAttachments()!.length}</span>
					</h3>
					<Rows class="health-rows" role="listbox" label="Unused attachment images">
						<For each={orphanAttachments()}>
							{(imgPath) => (
								<Row
									class="check-row clickable"
									key={imgPath}
									label={baseName(imgPath)}
									title={`Unused attachment ${relativeTo(state.workspace?.root, imgPath)}. Click to preview.`}
									onActivate={() => void openFile(imgPath)}
								>
									<span class="check-mark note" aria-hidden="true">
										<Icon name="file-media" />
									</span>
									<span class="label">{baseName(imgPath)}</span>
									<button
										class="link"
										tabindex={-1}
										title={`Move ${baseName(imgPath)} to trash`}
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
