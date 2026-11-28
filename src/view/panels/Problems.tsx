// VS Code-aligned Problems panel: Tree view & Table view toggle, active file
// promoted to the top as a normal collapsible file group with clean hairline
// delineation from other project files, and single-bar header actions (ADR 0050).
import { Icon, type IconName } from "../Icon";
import { createEffect, createMemo, createSignal, For, Show } from "solid-js";
import { monaco } from "../editor/monaco";
import { docAuditData } from "../docAudit";
import { diagnostics, type Diagnostic } from "../lsp/session";
import { activePath, canonical, displayName, isUntitled, openFile, state } from "../state";
import { docIssueCode } from "../../shared/contextMenu";
import { baseName, dirName, isInside, relativeTo } from "../../shared/paths";
import { FilterBox, filterKey, filterMenuItem, filterToggle } from "../FilterBox";
import { Menu } from "../Menu";
import { focusRowsBelow, Row, Rows } from "./Rows";
import { serverDown, serverSilent } from "./server";
import { FileMark } from "../FileMark";
import {
	buildProblemTableRows,
	DEFAULT_SEVERITY_FILTER,
	diagnosticMatchesQuery,
	isProjectProblemsOpen,
	isSeverityFiltered,
	nextTableSort,
	partitionProblems,
	severityAllowed,
	tallyDiagnostics,
	type ProblemFileGroup,
	type ProblemsSeverityFilter,
	type ProblemsSourceScope,
	type ProblemsTableSort,
	type ProblemsTableSortKey,
	type ProblemsViewMode,
	type ProblemTally,
} from "./problemsModel";

const MARK: (IconName | null)[] = [null, "error", "warning", "info", "circle-small-filled"];
const CLASS = ["", "error", "warning", "info", "hint"];
/** What a severity mark means, in a word: read out, and shown on hover. */
export const SEVERITY = ["", "Error", "Warning", "Note", "Hint"];

/** Resolves a diagnostic URI to a path `openFile()` understands, preserving `untitled:` buffers verbatim. */
export function problemPath(uri: string): string {
	return isUntitled(uri) ? uri : monaco.Uri.parse(uri).fsPath;
}

/** Collision-free dedup key incorporating file, line, column, code, and message so same-line findings never drop each other. */
export function problemDedupKey(fsPath: string, line: number, column: number, code: string, message: string): string {
	return `${fsPath}:${line}:${column}:${code}:${message}`;
}

/** Stable Row key for a diagnostic, disambiguated across multiple findings on the same line. */
export function problemRowKey(uri: string, d: Pick<Diagnostic, "line" | "column" | "code" | "message">): string {
	return `${uri}#${d.line}:${d.column}:${d.code ?? ""}:${d.message}`;
}

function collectMergedProblems(): { uri: string; path: string; canonPath: string; list: Diagnostic[] }[] {
	const byPath = new Map<string, { uri: string; path: string; canonPath: string; list: Diagnostic[] }>();
	const seenKeys = new Set<string>();
	for (const [uri, list] of Object.entries(diagnostics)) {
		if (!list?.length) continue;
		const path = problemPath(uri);
		const fsPath = canonical(path);
		const entry = byPath.get(fsPath) ?? { uri, path, canonPath: fsPath, list: [] };
		for (const d of list) {
			entry.list.push(d);
			seenKeys.add(problemDedupKey(fsPath, d.line, d.column ?? 1, d.code ?? "", d.message));
		}
		byPath.set(fsPath, entry);
	}
	// Fold workspace-wide doc audit issues (broken #heading anchors, malformed YAML, ADR 0008 tables,
	// code citations, duplicate headings, schema drift, orphan & stale docs) into Problems under
	// `source: "docs"`, deduplicated against already-open file diagnostics.
	for (const issue of docAuditData().issues) {
		const fsPath = canonical(issue.path);
		const code = docIssueCode(issue.kind);
		const col = issue.column ?? 1;
		const dedupKey = problemDedupKey(fsPath, issue.line, col, code, issue.message);
		if (seenKeys.has(dedupKey)) continue;
		seenKeys.add(dedupKey);
		const uri = monaco.Uri.file(issue.path).toString();
		const entry = byPath.get(fsPath) ?? { uri, path: issue.path, canonPath: fsPath, list: [] };
		entry.list.push({
			uri,
			line: issue.line,
			column: col,
			endLine: issue.line,
			endColumn: col + 1,
			severity: issue.level === "warn" ? 2 : 3,
			message: issue.message,
			code,
			source: "docs",
		});
		byPath.set(fsPath, entry);
	}
	return [...byPath.values()];
}

export const counts = () => {
	const c = { errors: 0, warnings: 0, other: 0 };
	for (const { list } of collectMergedProblems()) {
		for (const d of list) d.severity === 1 ? c.errors++ : d.severity === 2 ? c.warnings++ : c.other++;
	}
	return c;
};

/** Independent problem counts split between the currently active file and all other project files. */
export const scopedCounts = (): { active: ProblemTally; project: ProblemTally; total: ProblemTally; activeLabel: string | null } => {
	const current = activePath();
	const activeCanon = current ? canonical(current) : null;
	let activeList: Diagnostic[] = [];
	const projectList: Diagnostic[] = [];
	for (const entry of collectMergedProblems()) {
		if (activeCanon && entry.canonPath === activeCanon) activeList = entry.list;
		else projectList.push(...entry.list);
	}
	const active = tallyDiagnostics(activeList);
	const project = tallyDiagnostics(projectList);
	return {
		active,
		project,
		total: {
			errors: active.errors + project.errors,
			warnings: active.warnings + project.warnings,
			other: active.other + project.other,
			total: active.total + project.total,
		},
		activeLabel: current ? (isUntitled(current) ? displayName(current) : baseName(current)) : null,
	};
};

/** The mark for a severity, named for assistive tech. */
export function SeverityMark(props: { severity: number }) {
	return (
		<span class={`sev ${CLASS[props.severity]}`} role="img" aria-label={SEVERITY[props.severity]} title={SEVERITY[props.severity]}>
			<Show when={MARK[props.severity]}>{(name) => <Icon name={name()} />}</Show>
		</span>
	);
}

// Shared reactive state between bottom-tabs header actions and the Problems body.
const [problemsScope, setProblemsScope] = createSignal<ProblemsSourceScope>("all");
const [activeFileOnly, setActiveFileOnly] = createSignal(false);
const [severityFilter, setSeverityFilter] = createSignal<ProblemsSeverityFilter>({ ...DEFAULT_SEVERITY_FILTER });
const [problemsQuery, setProblemsQuery] = createSignal("");
const [viewMode, setViewMode] = createSignal<ProblemsViewMode>("tree");
const [tableSort, setTableSort] = createSignal<ProblemsTableSort>({ key: "priority", dir: "asc" });
const [currentCollapsed, setCurrentCollapsed] = createSignal(false);
const [collapsedProjectUris, setCollapsedProjectUris] = createSignal<ReadonlySet<string>>(new Set());
const [projectOpenOverride, setProjectOpenOverride] = createSignal<boolean | null>(null);
const problemsFilterBox = filterToggle(problemsQuery, setProblemsQuery);
let lastProblemsRoot: string | undefined;

const isDocDiag = (uri: string, d: Diagnostic): boolean => {
	if (d.source === "docs") return true;
	const p = problemPath(uri);
	return /\.(md|markdown|json|toml|xml|csv|tsv)$/i.test(p);
};

const isProblemsFiltering = () =>
	isSeverityFiltered(severityFilter()) ||
	Boolean(problemsQuery().trim()) ||
	activeFileOnly() ||
	problemsScope() !== "all";

const toggleSeverity = (key: keyof ProblemsSeverityFilter) => {
	setSeverityFilter((prev) => ({ ...prev, [key]: !prev[key] }));
};

const clearAllProblemsFilters = () => {
	problemsFilterBox.clear();
	setSeverityFilter({ ...DEFAULT_SEVERITY_FILTER });
	setActiveFileOnly(false);
	setProblemsScope("all");
};

const collapseAllProblems = () => {
	const merged = collectMergedProblems();
	const next = new Set<string>();
	for (const e of merged) next.add(e.uri);
	setCurrentCollapsed(true);
	setCollapsedProjectUris(next);
};

const expandAllProblems = () => {
	setCurrentCollapsed(false);
	setCollapsedProjectUris(new Set<string>());
	setProjectOpenOverride(true);
};

/**
 * Compact VS Code-style Problems controls mounted directly in the single `.bottom-tabs`
 * header bar (Filter funnel, Collapse All in Tree view, and View as Tree / Table toggle).
 */
export function ProblemsHeaderActions() {
	const hasDocIssues = createMemo(() =>
		collectMergedProblems().some(({ uri, list }) => list.some((d) => isDocDiag(uri, d))),
	);
	const scopeCounts = createMemo(() => {
		let code = 0;
		let docsN = 0;
		for (const { uri, list } of collectMergedProblems()) {
			for (const d of list) {
				if (isDocDiag(uri, d)) docsN++;
				else code++;
			}
		}
		return { all: code + docsN, code, docs: docsN };
	});

	return (
		<div class="bottom-problems-acts">
			<Menu
				floating
				class={isProblemsFiltering() ? "bottom-action docs-filter-menu on" : "bottom-action docs-filter-menu"}
				label={isProblemsFiltering() ? "Filter Problems: a filter is on" : "Filter Problems"}
				title="Filter Problems by text, active file, severity, or source (Ctrl+F)"
				items={() => [
					filterMenuItem(problemsFilterBox, undefined, "Filter by Text…"),
					...(activePath()
						? [
								"separator" as const,
								{ label: "Show Active File Only", checked: activeFileOnly(), run: () => setActiveFileOnly((v) => !v) },
							]
						: []),
					"separator",
					{ label: "Show Errors", checked: severityFilter().errors, run: () => toggleSeverity("errors") },
					{ label: "Show Warnings", checked: severityFilter().warnings, run: () => toggleSeverity("warnings") },
					{ label: "Show Notes & Hints", checked: severityFilter().info, run: () => toggleSeverity("info") },
					...(hasDocIssues()
						? [
								"separator" as const,
								{ label: `All Sources (${scopeCounts().all})`, checked: problemsScope() === "all", run: () => setProblemsScope("all") },
								{ label: `Code Only (${scopeCounts().code})`, checked: problemsScope() === "code", run: () => setProblemsScope("code") },
								{ label: `Docs Only (${scopeCounts().docs})`, checked: problemsScope() === "docs", run: () => setProblemsScope("docs") },
							]
						: []),
					...(viewMode() === "tree"
						? [
								"separator" as const,
								{ label: "Expand All Files", run: expandAllProblems },
								{ label: "Collapse All Files", run: collapseAllProblems },
							]
						: []),
					...(isProblemsFiltering()
						? [
								"separator" as const,
								{ label: "Clear Filters", run: clearAllProblemsFilters },
							]
						: []),
				]}
			>
				<Icon name={isProblemsFiltering() ? "filter-filled" : "filter"} />
			</Menu>
			<Show when={viewMode() === "tree"}>
				<button
					type="button"
					class="bottom-action"
					title="Collapse All"
					aria-label="Collapse all problem file groups"
					onClick={collapseAllProblems}
				>
					<Icon name="collapse-all" />
				</button>
			</Show>
			<button
				type="button"
				data-problems-view-toggle="true"
				class={`bottom-action${viewMode() === "table" ? " active" : ""}`}
				title={viewMode() === "tree" ? "View as Table" : "View as Tree"}
				aria-label={viewMode() === "tree" ? "View problems as Table" : "View problems as Tree"}
				aria-pressed={viewMode() === "table" ? "true" : "false"}
				onClick={() => setViewMode((m) => (m === "tree" ? "table" : "tree"))}
			>
				<Icon name={viewMode() === "tree" ? "table" : "list-tree"} />
			</button>
			<span class="bottom-tab-sep" aria-hidden="true" />
		</div>
	);
}

export function Problems() {
	const mergedFiles = createMemo(collectMergedProblems);

	const hasDocIssues = createMemo(() =>
		mergedFiles().some(({ uri, list }) => list.some((d) => isDocDiag(uri, d))),
	);
	createEffect(
		() => state.workspace?.root,
		(root) => {
			if (root !== lastProblemsRoot) {
				lastProblemsRoot = root;
				setProblemsScope("all");
				setActiveFileOnly(false);
				setSeverityFilter({ ...DEFAULT_SEVERITY_FILTER });
				setProblemsQuery("");
				setCurrentCollapsed(false);
				setCollapsedProjectUris(new Set<string>());
				setProjectOpenOverride(null);
			}
		},
	);
	createEffect(
		() => !hasDocIssues() && problemsScope() !== "all",
		(shouldReset) => {
			if (shouldReset) setProblemsScope("all");
		},
	);
	createEffect(
		() => !activePath() && activeFileOnly(),
		(shouldReset) => {
			if (shouldReset) setActiveFileOnly(false);
		},
	);
	// When switching to a different active file, expand its group so its diagnostics are immediately visible.
	createEffect(activePath, () => {
		setCurrentCollapsed(false);
	});

	const rel = (uri: string) => {
		if (isUntitled(uri)) return displayName(uri);
		return relativeTo(state.workspace?.root, problemPath(uri));
	};

	const openCanonPaths = createMemo(() => {
		const set = new Set<string>();
		for (const g of state.groups) {
			for (const t of g.tabs) set.add(canonical(t));
		}
		return set;
	});

	const filteredPartition = createMemo(() => {
		const scope = problemsScope();
		const sev = severityFilter();
		const q = problemsQuery();
		const cur = activePath();
		const filteredEntries = mergedFiles()
			.map((entry) => {
				const displayPath = rel(entry.uri);
				const list = entry.list.filter((d) => {
					if (scope === "docs" && !isDocDiag(entry.uri, d)) return false;
					if (scope === "code" && isDocDiag(entry.uri, d)) return false;
					if (!severityAllowed(d.severity, sev)) return false;
					if (!diagnosticMatchesQuery(d, displayPath, q)) return false;
					return true;
				});
				return { ...entry, list };
			})
			.filter((e) => e.list.length > 0);

		return partitionProblems({
			entries: filteredEntries,
			activePath: cur,
			activeCanonPath: cur ? canonical(cur) : null,
			openCanonPaths: openCanonPaths(),
			displayPath: (g: ProblemFileGroup) => rel(g.uri),
		});
	});

	const hasActiveTextOrSevFilter = () => Boolean(problemsQuery().trim()) || isSeverityFiltered(severityFilter());
	const currentOpen = () => !currentCollapsed() || Boolean(problemsQuery().trim());
	const projectSectionOpen = () =>
		isProjectProblemsOpen(filteredPartition(), projectOpenOverride(), hasActiveTextOrSevFilter(), currentOpen());

	const projectEntries = createMemo<[string, Diagnostic[]][]>(() =>
		filteredPartition().projectFiles.map((f) => [f.uri, f.list]),
	);

	const tableRows = createMemo(() =>
		buildProblemTableRows(filteredPartition(), {
			activeOnly: activeFileOnly(),
			displayPath: (g) => rel(g.uri),
			fileName: (g) => (isUntitled(g.uri) ? displayName(g.uri) : baseName(g.path)),
			sort: tableSort(),
		}),
	);

	const activeFileDisplay = createMemo(() => {
		const path = activePath();
		if (!path) return null;
		const name = isUntitled(path) ? displayName(path) : baseName(path);
		const root = state.workspace?.root;
		let dir = "";
		if (!isUntitled(path) && root && isInside(root, path)) {
			const r = relativeTo(root, path).split("\\").join("/");
			const d = dirName(r);
			dir = d === "." || d === r ? "" : d;
		}
		return { path, name, dir };
	});

	const isProjectFileCollapsed = (uri: string) => !problemsQuery().trim() && collapsedProjectUris().has(uri);
	const toggleProjectFile = (uri: string) => {
		setCollapsedProjectUris((prev) => {
			const next = new Set(prev);
			if (next.has(uri)) next.delete(uri);
			else next.add(uri);
			return next;
		});
	};

	const renderTally = (tally: ProblemTally) => (
		<span class="meta tally">
			<Show when={tally.errors > 0}>
				<span title={`${tally.errors} × error`}>
					<SeverityMark severity={1} /> {tally.errors}
				</span>
			</Show>
			<Show when={tally.warnings > 0}>
				<span title={`${tally.warnings} × warning`}>
					<SeverityMark severity={2} /> {tally.warnings}
				</span>
			</Show>
			<Show when={tally.other > 0}>
				<span title={`${tally.other} × note/hint`}>
					<SeverityMark severity={3} /> {tally.other}
				</span>
			</Show>
		</span>
	);

	const activeFilterChips = createMemo(() => {
		const chips: { id: string; label: string; clear: () => void }[] = [];
		if (activeFileOnly()) chips.push({ id: "active", label: "Active file only", clear: () => setActiveFileOnly(false) });
		if (problemsScope() === "code") chips.push({ id: "code", label: "Code only", clear: () => setProblemsScope("all") });
		if (problemsScope() === "docs") chips.push({ id: "docs", label: "Docs only", clear: () => setProblemsScope("all") });
		const sev = severityFilter();
		if (!sev.errors) chips.push({ id: "no-err", label: "Errors hidden", clear: () => toggleSeverity("errors") });
		if (!sev.warnings) chips.push({ id: "no-warn", label: "Warnings hidden", clear: () => toggleSeverity("warnings") });
		if (!sev.info) chips.push({ id: "no-info", label: "Notes hidden", clear: () => toggleSeverity("info") });
		return chips;
	});

	const onSortHeader = (col: Exclude<ProblemsTableSortKey, "priority">) => {
		setTableSort((cur) => nextTableSort(cur, col));
	};

	const sortArrow = (col: Exclude<ProblemsTableSortKey, "priority">): IconName | null => {
		const s = tableSort();
		if (s.key !== col) return null;
		return s.dir === "asc" ? "arrow-up" : "arrow-down";
	};

	return (
		<div class="problems-wrap" onKeyDown={(e) => filterKey(e, problemsFilterBox)}>
			{/* ADR 0050: Filter bar stays completely hidden until requested or a filter chip is active */}
			<Show when={problemsFilterBox.shown() || activeFilterChips().length > 0}>
				<div class="problems-filter-bar">
					<FilterBox
						toggle={problemsFilterBox}
						label="Filter problems by message, rule code, or file path"
						placeholder="Filter (e.g. text, rule code, file)…"
						value={problemsQuery()}
						onInput={setProblemsQuery}
						onKeyDown={(e) => e.key === "ArrowDown" && focusRowsBelow(e.currentTarget) && e.preventDefault()}
						onDismiss={(box) => focusRowsBelow(box)}
					/>
					<Show when={activeFilterChips().length > 0}>
						<div class="docs-filter-chips" role="group" aria-label="Active Problems filters">
							<For each={activeFilterChips()}>
								{(chip) => (
									<button type="button" class="docs-tag-active" title={`Remove filter: ${chip.label}`} onClick={chip.clear}>
										<span>{chip.label}</span>
										<Icon name="close" />
									</button>
								)}
							</For>
						</div>
					</Show>
				</div>
			</Show>

			<Rows class="problems" label="Problems in workspace">
				<Show when={serverDown()}>
					<p class="hint warn">{serverDown()} Open files are not checked until it runs.</p>
				</Show>
				<Show when={serverSilent()}>
					<p class="hint warn">{serverSilent()} Open files are not checked until it answers.</p>
				</Show>

				{/* ==================== TREE VIEW (VS CODE DEFAULT) ==================== */}
				<Show when={viewMode() === "tree"}>
					{/* Active file promoted cleanly to the top as a normal collapsible file group */}
					<Show when={activeFileDisplay()}>
						{(file) => {
							const curGroup = () => filteredPartition().activeFile;
							const curTally = () => filteredPartition().activeTally;
							const hasActiveProblems = () => Boolean(curGroup()?.list.length);
							return (
								<div class={`problems-active-group${hasActiveProblems() ? "" : " clean"}`} data-problems-zone="current">
									<Show
										when={hasActiveProblems()}
										fallback={
											<div class="tree-row file-head problems-file-row current clean" title={file().path}>
												<FileMark name={file().name} />
												<span class="label">{file().name}</span>
												<Show when={file().dir}>
													<span class="problems-file-dir">{file().dir}</span>
												</Show>
												<span class="problems-current-tag">Current</span>
												<span class="problems-clean-note">
													<Icon name="check" />
													<span>{isProblemsFiltering() ? "No matches" : "No problems"}</span>
												</span>
											</div>
										}
									>
										<button
											type="button"
											class="tree-row file-head problems-file-row current foldable"
											aria-expanded={currentOpen() ? "true" : "false"}
											title={`${file().path} (Current file — click to ${currentOpen() ? "collapse" : "expand"})`}
											onClick={() => setCurrentCollapsed((v) => !v)}
										>
											<Icon name={currentOpen() ? "chevron-down" : "chevron-right"} class="twisty" />
											<FileMark name={file().name} />
											<span class="label">{file().name}</span>
											<Show when={file().dir}>
												<span class="problems-file-dir">{file().dir}</span>
											</Show>
											<span class="problems-current-tag">Current</span>
											{renderTally(curTally())}
										</button>
										<Show when={currentOpen() && curGroup()}>
											{(group) => (
												<div role="listbox" aria-label={`Problems in ${file().name}`}>
													<For each={group().list} keyed={(d) => problemRowKey(group().uri, d)}>
														{(d) => (
															<Row
																class="tree-row problem"
																key={problemRowKey(group().uri, d())}
																style={{ "padding-left": "22px" }}
																title={`${SEVERITY[d().severity]}: ${d().message}${d().code ? ` [${d().code}]` : ""} (line ${d().line}, column ${d().column})`}
																onActivate={() => {
																	const diag = d();
																	void openFile(problemPath(group().uri), {
																		reveal: { line: diag.line, column: diag.column, endLine: diag.endLine, endColumn: diag.endColumn },
																	});
																}}
															>
																<SeverityMark severity={d().severity} />
																<span class="label">{d().message}</span>
																<Show when={d().code}>
																	<span class="code">{d().code}</span>
																</Show>
																<span class="meta">
																	{d().line}:{d().column}
																</span>
															</Row>
														)}
													</For>
												</div>
											)}
										</Show>
									</Show>
								</div>
							);
						}}
					</Show>

					{/* Other project files clearly separated underneath a slim collapsible divider */}
					<Show when={!activeFileOnly()}>
						<Show
							when={projectEntries().length > 0}
							fallback={
								<Show when={!activeFileDisplay()}>
									<p class="hint">
										{problemsScope() === "code"
											? "No code problems in open files."
											: problemsScope() === "docs"
												? "No document problems found."
												: isProblemsFiltering()
													? "No matching problems found."
													: "No problems in open files or workspace documents."}
									</p>
								</Show>
							}
						>
							<div class="problems-project-group" data-problems-zone="project">
								<Show when={activeFileDisplay()}>
									<button
										type="button"
										class="problems-divider"
										aria-expanded={projectSectionOpen() ? "true" : "false"}
										title={projectSectionOpen() ? "Collapse other project files" : "Expand other project files"}
										onClick={() => setProjectOpenOverride(!projectSectionOpen())}
									>
										<Icon name={projectSectionOpen() ? "chevron-down" : "chevron-right"} class="twisty" />
										<span class="problems-divider-label">Other project files</span>
										<span class="problems-divider-count">{projectEntries().length}</span>
										<span class="spacer" />
										{renderTally(filteredPartition().projectTally)}
									</button>
								</Show>
								<Show when={!activeFileDisplay() || projectSectionOpen()}>
									<For each={projectEntries()} keyed={([uri]) => uri}>
										{(entry) => {
											const uri = () => entry()[0];
											const list = () => entry()[1];
											const sorted = createMemo(() => [...list()].sort((a, b) => a.severity - b.severity || a.line - b.line));
											const fileOpen = () => !isProjectFileCollapsed(uri());
											const fileLabel = () => (isUntitled(uri()) ? displayName(uri()) : baseName(problemPath(uri())));
											const fileDir = () => {
												if (isUntitled(uri())) return "";
												const r = rel(uri()).split("\\").join("/");
												const d = dirName(r);
												return d === "." || d === r ? "" : d;
											};
											return (
												<div class="problems-file-group">
													<button
														type="button"
														class="tree-row file-head problems-file-row foldable"
														aria-expanded={fileOpen() ? "true" : "false"}
														title={isUntitled(uri()) ? displayName(uri()) : problemPath(uri())}
														onClick={() => toggleProjectFile(uri())}
													>
														<Icon name={fileOpen() ? "chevron-down" : "chevron-right"} class="twisty" />
														<FileMark name={rel(uri())} />
														<span class="label">{fileLabel()}</span>
														<Show when={fileDir()}>
															<span class="problems-file-dir">{fileDir()}</span>
														</Show>
														<span class="meta tally">
															<For each={[1, 2, 3, 4].filter((severity) => list().some((d) => d.severity === severity))}>
																{(severity) => (
																	<span title={`${list().filter((d) => d.severity === severity).length} × ${SEVERITY[severity]!.toLowerCase()}`}>
																		<SeverityMark severity={severity} /> {list().filter((d) => d.severity === severity).length}
																	</span>
																)}
															</For>
														</span>
													</button>
													<Show when={fileOpen()}>
														<div role="listbox" aria-label={rel(uri())}>
															<For each={sorted()} keyed={(d) => problemRowKey(uri(), d)}>
																{(d) => (
																	<Row
																		class="tree-row problem"
																		key={problemRowKey(uri(), d())}
																		style={{ "padding-left": "22px" }}
																		title={`${SEVERITY[d().severity]}: ${d().message}${d().code ? ` [${d().code}]` : ""} (line ${d().line}, column ${d().column})`}
																		onActivate={() => {
																			const diag = d();
																			void openFile(problemPath(uri()), {
																				reveal: { line: diag.line, column: diag.column, endLine: diag.endLine, endColumn: diag.endColumn },
																			});
																		}}
																	>
																		<SeverityMark severity={d().severity} />
																		<span class="label">{d().message}</span>
																		<Show when={d().code}>
																			<span class="code">{d().code}</span>
																		</Show>
																		<span class="meta">
																			{d().line}:{d().column}
																		</span>
																	</Row>
																)}
															</For>
														</div>
													</Show>
												</div>
											);
										}}
									</For>
								</Show>
							</div>
						</Show>
					</Show>
				</Show>

				{/* ==================== TABLE VIEW (VS CODE VIEW AS TABLE) ==================== */}
				<Show when={viewMode() === "table"}>
					<div class="problems-table" data-problems-view="table">
						<div class="problems-table-head" role="row">
							<button type="button" class="pt-col pt-sev" title="Sort by severity" onClick={() => onSortHeader("severity")}>
								<span class="visually-hidden">Severity</span>
								<Icon name={sortArrow("severity") ?? "info"} />
							</button>
							<button type="button" class="pt-col pt-code" title="Sort by code" onClick={() => onSortHeader("code")}>
								<span>Code</span>
								<Show when={sortArrow("code")}>{(ic) => <Icon name={ic()} />}</Show>
							</button>
							<button type="button" class="pt-col pt-msg" title="Sort by message" onClick={() => onSortHeader("message")}>
								<span>Message</span>
								<Show when={sortArrow("message")}>{(ic) => <Icon name={ic()} />}</Show>
							</button>
							<button type="button" class="pt-col pt-file" title="Sort by file" onClick={() => onSortHeader("file")}>
								<span>File</span>
								<Show when={sortArrow("file")}>{(ic) => <Icon name={ic()} />}</Show>
							</button>
						</div>

						<Show
							when={tableRows().length > 0}
							fallback={
								<p class="hint">
									{activeFileOnly() && activeFileDisplay()
										? `No problems in ${activeFileDisplay()!.name}.`
										: isProblemsFiltering()
											? "No matching problems found."
											: "No problems in open files or workspace documents."}
								</p>
							}
						>
							<div role="listbox" aria-label="Problems table">
								<For each={tableRows()}>
									{(item, index) => {
										const showProjectBreak = () =>
											tableSort().key === "priority" &&
											!item.isCurrent &&
											index() > 0 &&
											tableRows()[index() - 1]?.isCurrent;
										return (
											<>
												<Show when={showProjectBreak()}>
													<div class="problems-table-divider" role="separator">
														<span>Other project files</span>
													</div>
												</Show>
												<Row
													class={`problems-table-row${item.isCurrent ? " current" : ""}`}
													key={problemRowKey(item.uri, item.diagnostic)}
													title={`${SEVERITY[item.diagnostic.severity]}: ${item.diagnostic.message}${item.diagnostic.code ? ` [${item.diagnostic.code}]` : ""} — ${item.relPath}:${item.diagnostic.line}:${item.diagnostic.column}`}
													onActivate={() =>
														void openFile(problemPath(item.uri), {
															reveal: {
																line: item.diagnostic.line,
																column: item.diagnostic.column,
																endLine: item.diagnostic.endLine,
																endColumn: item.diagnostic.endColumn,
															},
														})
													}
												>
													<span class="pt-cell pt-sev">
														<SeverityMark severity={item.diagnostic.severity} />
													</span>
													<span class="pt-cell pt-code">{item.diagnostic.code ?? ""}</span>
													<span class="pt-cell pt-msg">{item.diagnostic.message}</span>
													<span class="pt-cell pt-file">
														<FileMark name={item.fileName} />
														<span class="pt-file-name">{item.fileName}</span>
														<span class="pt-file-loc">
															[{item.diagnostic.line}, {item.diagnostic.column}]
														</span>
													</span>
												</Row>
											</>
										);
									}}
								</For>
							</div>
						</Show>
					</div>
				</Show>
			</Rows>
		</div>
	);
}

export { endFollower, Output, OutputHeaderActions } from "./Output";
