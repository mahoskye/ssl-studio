// Pure partitioning, priority sorting, severity filtering, and smart collapse
// helpers for the Problems panel. Always prioritizes the active file at the top
// with clear delineation from workspace-wide project findings.
import type { Diagnostic } from "../lsp/session";

export type ProblemsSourceScope = "all" | "code" | "docs";

export type ProblemsViewMode = "tree" | "table";

export type ProblemsTableSortKey = "priority" | "severity" | "code" | "message" | "file";

export type ProblemsTableSort = {
	key: ProblemsTableSortKey;
	dir: "asc" | "desc";
};

export type ProblemTableRow = {
	uri: string;
	path: string;
	fileName: string;
	relPath: string;
	isCurrent: boolean;
	diagnostic: Diagnostic;
};

export type ProblemsSeverityFilter = {
	errors: boolean;
	warnings: boolean;
	info: boolean;
};

export const DEFAULT_SEVERITY_FILTER: ProblemsSeverityFilter = {
	errors: true,
	warnings: true,
	info: true,
};

export type ProblemTally = {
	errors: number;
	warnings: number;
	other: number;
	total: number;
};

export type ProblemFileGroup = {
	uri: string;
	path: string;
	canonPath: string;
	list: Diagnostic[];
	tally: ProblemTally;
};

export type PartitionedProblems = {
	activePath: string | null;
	activeFile: ProblemFileGroup | null;
	activeTally: ProblemTally;
	projectFiles: ProblemFileGroup[];
	projectTally: ProblemTally;
	totalTally: ProblemTally;
};

export function tallyDiagnostics(list: readonly Pick<Diagnostic, "severity">[]): ProblemTally {
	let errors = 0;
	let warnings = 0;
	let other = 0;
	for (const d of list) {
		if (d.severity === 1) errors++;
		else if (d.severity === 2) warnings++;
		else other++;
	}
	return { errors, warnings, other, total: errors + warnings + other };
}

export function addTallies(a: ProblemTally, b: ProblemTally): ProblemTally {
	return {
		errors: a.errors + b.errors,
		warnings: a.warnings + b.warnings,
		other: a.other + b.other,
		total: a.total + b.total,
	};
}

export function severityAllowed(severity: number, filter: ProblemsSeverityFilter): boolean {
	if (severity === 1) return filter.errors;
	if (severity === 2) return filter.warnings;
	return filter.info;
}

export function isSeverityFiltered(filter: ProblemsSeverityFilter): boolean {
	return !(filter.errors && filter.warnings && filter.info);
}

/** Matches multi-word search text against a diagnostic's message, code, source, and file path. */
export function diagnosticMatchesQuery(
	d: Pick<Diagnostic, "message" | "code" | "source">,
	displayPath: string,
	query: string,
): boolean {
	const q = query.trim().toLowerCase();
	if (!q) return true;
	const hay = `${d.message} ${d.code ?? ""} ${d.source ?? ""} ${displayPath}`.toLowerCase();
	return q.split(/\s+/).every((word) => hay.includes(word));
}

/** Sorts diagnostics inside one file: errors -> warnings -> notes -> hints, then line -> column. */
export function sortFileDiagnostics(list: readonly Diagnostic[]): Diagnostic[] {
	return [...list].sort(
		(a, b) => a.severity - b.severity || a.line - b.line || (a.column ?? 0) - (b.column ?? 0),
	);
}

/**
 * Sorts project (non-active) problem file groups strictly by priority:
 * 1. Files with errors first (more errors first)
 * 2. Files with warnings next (more warnings first)
 * 3. Currently open editor tabs before closed workspace doc-audit files
 * 4. Higher total count first
 * 5. Alphabetical display path tiebreaker
 */
export function sortProjectProblemFiles(
	files: readonly ProblemFileGroup[],
	openCanonPaths: ReadonlySet<string>,
	displayPath: (g: ProblemFileGroup) => string,
): ProblemFileGroup[] {
	return [...files].sort((a, b) => {
		const aHasErr = a.tally.errors > 0 ? 1 : 0;
		const bHasErr = b.tally.errors > 0 ? 1 : 0;
		if (bHasErr !== aHasErr) return bHasErr - aHasErr;
		if (b.tally.errors !== a.tally.errors) return b.tally.errors - a.tally.errors;

		const aHasWarn = a.tally.warnings > 0 ? 1 : 0;
		const bHasWarn = b.tally.warnings > 0 ? 1 : 0;
		if (bHasWarn !== aHasWarn) return bHasWarn - aHasWarn;
		if (b.tally.warnings !== a.tally.warnings) return b.tally.warnings - a.tally.warnings;

		const aOpen = openCanonPaths.has(a.canonPath) ? 1 : 0;
		const bOpen = openCanonPaths.has(b.canonPath) ? 1 : 0;
		if (bOpen !== aOpen) return bOpen - aOpen;

		if (b.tally.total !== a.tally.total) return b.tally.total - a.tally.total;
		return displayPath(a).localeCompare(displayPath(b), undefined, { sensitivity: "base" });
	});
}

/**
 * Separates merged file diagnostics into Current File (pinned at top) vs Project (other files),
 * applying priority ordering to project files and computing independent tallies for each zone.
 */
export function partitionProblems(input: {
	entries: readonly { uri: string; path: string; canonPath: string; list: Diagnostic[] }[];
	activePath: string | null | undefined;
	activeCanonPath: string | null | undefined;
	openCanonPaths: ReadonlySet<string>;
	displayPath: (g: ProblemFileGroup) => string;
}): PartitionedProblems {
	let activeFile: ProblemFileGroup | null = null;
	const projectRaw: ProblemFileGroup[] = [];

	for (const entry of input.entries) {
		if (!entry.list.length) continue;
		const group: ProblemFileGroup = {
			uri: entry.uri,
			path: entry.path,
			canonPath: entry.canonPath,
			list: sortFileDiagnostics(entry.list),
			tally: tallyDiagnostics(entry.list),
		};
		if (input.activeCanonPath && entry.canonPath === input.activeCanonPath) {
			activeFile = group;
		} else {
			projectRaw.push(group);
		}
	}

	const projectFiles = sortProjectProblemFiles(projectRaw, input.openCanonPaths, input.displayPath);
	const activeTally = activeFile ? activeFile.tally : { errors: 0, warnings: 0, other: 0, total: 0 };
	const projectTally = projectFiles.reduce(
		(acc, f) => addTallies(acc, f.tally),
		{ errors: 0, warnings: 0, other: 0, total: 0 },
	);
	const totalTally = addTallies(activeTally, projectTally);

	return {
		activePath: input.activePath ?? null,
		activeFile,
		activeTally,
		projectFiles,
		projectTally,
		totalTally,
	};
}

/**
 * Calm default expansion rule for the Project (Other Files) section:
 * - If the current file has errors or warnings, is expanded (`currentOpen`), AND the project
 *   section only has info/notes (zero project errors/warnings), fold Project by default so
 *   active-file fixes stay front and center.
 * - If the user collapses the current file (`currentOpen === false`), surface Project automatically.
 */
export function defaultProjectProblemsOpen(partition: PartitionedProblems, currentOpen = true): boolean {
	if (!partition.projectFiles.length) return false;
	if (!currentOpen) return true;
	const activeHasUrgent = partition.activeTally.errors > 0 || partition.activeTally.warnings > 0;
	const projectHasUrgent = partition.projectTally.errors > 0 || partition.projectTally.warnings > 0;
	if (activeHasUrgent && !projectHasUrgent) return false;
	return true;
}

/** Resolves whether the Project section should currently be expanded. */
export function isProjectProblemsOpen(
	partition: PartitionedProblems,
	userOverride: boolean | null,
	isFiltering: boolean,
	currentOpen = true,
): boolean {
	if (userOverride !== null) return userOverride;
	if (isFiltering) return true;
	return defaultProjectProblemsOpen(partition, currentOpen);
}

/** Cycles a table column header sort (asc -> desc -> default priority). */
export function nextTableSort(current: ProblemsTableSort, clicked: Exclude<ProblemsTableSortKey, "priority">): ProblemsTableSort {
	if (current.key !== clicked) return { key: clicked, dir: "asc" };
	if (current.dir === "asc") return { key: clicked, dir: "desc" };
	return { key: "priority", dir: "asc" };
}

/**
 * Flattens partitioned diagnostics into VS Code-style Table rows.
 * Default `"priority"` sort promotes the current file first (sorted worst-first by severity/line),
 * followed by priority-ordered project files. Explicit column sorts order across all visible rows
 * while retaining `isCurrent` for subtle visual delineation.
 */
export function buildProblemTableRows(
	partition: PartitionedProblems,
	opts: {
		activeOnly: boolean;
		displayPath: (g: ProblemFileGroup) => string;
		fileName: (g: ProblemFileGroup) => string;
		sort: ProblemsTableSort;
	},
): ProblemTableRow[] {
	const rows: ProblemTableRow[] = [];
	const pushGroup = (g: ProblemFileGroup, isCurrent: boolean) => {
		const relPath = opts.displayPath(g);
		const fileName = opts.fileName(g);
		for (const diagnostic of g.list) {
			rows.push({ uri: g.uri, path: g.path, fileName, relPath, isCurrent, diagnostic });
		}
	};
	if (partition.activeFile) pushGroup(partition.activeFile, true);
	if (!opts.activeOnly) {
		for (const g of partition.projectFiles) pushGroup(g, false);
	}
	if (opts.sort.key === "priority") return rows;

	const factor = opts.sort.dir === "asc" ? 1 : -1;
	return [...rows].sort((a, b) => {
		let cmp = 0;
		switch (opts.sort.key) {
			case "severity":
				cmp = a.diagnostic.severity - b.diagnostic.severity;
				break;
			case "code":
				cmp = (a.diagnostic.code ?? "").localeCompare(b.diagnostic.code ?? "", undefined, { sensitivity: "base" });
				break;
			case "message":
				cmp = a.diagnostic.message.localeCompare(b.diagnostic.message, undefined, { sensitivity: "base" });
				break;
			case "file":
				cmp = a.relPath.localeCompare(b.relPath, undefined, { sensitivity: "base" }) || a.diagnostic.line - b.diagnostic.line;
				break;
		}
		if (cmp !== 0) return cmp * factor;
		if (a.isCurrent !== b.isCurrent) return a.isCurrent ? -1 : 1;
		return a.diagnostic.severity - b.diagnostic.severity || a.diagnostic.line - b.diagnostic.line;
	});
}

/** Formats a compact human-readable breakdown for bottom tab & status bar tooltips. */
export function formatScopedProblemsTooltip(
	activeLabel: string | null,
	activeTally: ProblemTally,
	projectTally: ProblemTally,
): string {
	const fmt = (t: ProblemTally) => {
		const parts: string[] = [];
		if (t.errors) parts.push(`${t.errors} ${t.errors === 1 ? "error" : "errors"}`);
		if (t.warnings) parts.push(`${t.warnings} ${t.warnings === 1 ? "warning" : "warnings"}`);
		if (t.other) parts.push(`${t.other} ${t.other === 1 ? "note" : "notes"}`);
		return parts.length ? parts.join(", ") : "no problems";
	};
	if (!activeLabel) return `Project: ${fmt(projectTally)}`;
	return `Current file (${activeLabel}): ${fmt(activeTally)} · Other project files: ${fmt(projectTally)}`;
}
