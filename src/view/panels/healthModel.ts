// Pure scoping, triage, and accordion state helpers for the Health panel.
// Separates active-document telemetry from workspace-wide project governance so
// the panel stays calm, scannable, and immediately relevant to the open file.
import { createSignal } from "solid-js";
import type { DocCheck } from "../../shared/docChecks";
import { baseName } from "../../shared/paths";
import type { AuditCitationIssue, DocFile, OpenTaskItem, SchemaDriftItem, UndocumentedSchemaRef, WorkspaceDocIssue } from "../../shared/protocol";

export type HealthScope = "file" | "project";

export type ActiveFileKind = "ssl" | "markdown" | "sql" | "registry" | "other" | "none";

export type ProjectSectionId =
	| "truncated"
	| "drift"
	| "work"
	| "citations"
	| "docIssues"
	| "tasks"
	| "undoc"
	| "orphans"
	| "registries"
	| "projectFiles";

export type HealthTone = "ok" | "warn" | "error" | "note";

export type ProjectSectionCounts = {
	truncated: number;
	drift: number;
	workTotal: number;
	workWarnings: number;
	citationsTotal: number;
	citationWarnings: number;
	docIssuesTotal: number;
	docIssueWarnings: number;
	tasks: number;
	undoc: number;
	orphans: number;
	registries: number;
	projectFilesTotal: number;
	projectFilesAttention: number;
};

export type ProjectHealthSummary = {
	warnings: number;
	tasks: number;
	notes: number;
	/** Total attention count excluding normal completed project files and registries. */
	attention: number;
	clean: boolean;
};

export type ActiveFileHealthInput = {
	path: string | null | undefined;
	canonicalize: (p: string) => string;
	hasSslSize: boolean;
	isRegistry: boolean;
	sizeAlert: "ok" | "near" | "over";
	findingsCount: number;
	findingErrors: number;
	findingWarnings: number;
	checks: readonly DocCheck[];
	docIssues: readonly WorkspaceDocIssue[];
	citations: readonly AuditCitationIssue[];
	schemaDrift: readonly SchemaDriftItem[];
	undocRefs: readonly UndocumentedSchemaRef[];
	openTasks: readonly OpenTaskItem[];
};

export type ActiveFileHealthSlice = {
	kind: ActiveFileKind;
	checks: DocCheck[];
	docIssues: WorkspaceDocIssue[];
	citations: AuditCitationIssue[];
	schemaDrift: SchemaDriftItem[];
	undocRefs: UndocumentedSchemaRef[];
	openTasks: OpenTaskItem[];
	warnings: number;
	errors: number;
	notes: number;
	/** Count shown on the Current File scope tab badge (0 hides badge). */
	badgeCount: number;
	tone: HealthTone;
	statusLabel: string;
	clean: boolean;
};

/**
 * Reactive request bridge so shell chrome (StatusBar size badge, EditorGroup banners,
 * and selftests) can focus the exact Health scope tab without circular imports.
 */
const [healthScopeReq, setHealthScopeReq] = createSignal<{ scope: HealthScope; seq: number } | null>(null);
let scopeSeq = 0;

export { healthScopeReq };

export function requestHealthScope(scope: HealthScope): void {
	setHealthScopeReq({ scope, seq: ++scopeSeq });
}

/** Classifies the currently active file for tailored active-document health sections. */
export function classifyHealthFile(
	path: string | null | undefined,
	opts: { hasSslSize?: boolean; isRegistry?: boolean } = {},
): ActiveFileKind {
	if (!path) return "none";
	const name = baseName(path).toLowerCase();
	if (opts.hasSslSize || /\.ssl$/i.test(name)) return "ssl";
	if (/\.(md|markdown)$/i.test(name)) return "markdown";
	if (/\.(sql|ds)$/i.test(name)) return "sql";
	if (opts.isRegistry || /\.(csv|tsv)$/i.test(name)) return "registry";
	return "other";
}

/** Counts workspace-wide warnings, open tasks, and notes for the Project overview strip and tab badge. */
export function summarizeProjectHealth(counts: ProjectSectionCounts): ProjectHealthSummary {
	const warnings =
		counts.truncated +
		counts.drift +
		counts.workWarnings +
		counts.citationWarnings +
		counts.docIssueWarnings +
		counts.projectFilesAttention;
	const notes =
		Math.max(0, counts.workTotal - counts.workWarnings) +
		Math.max(0, counts.citationsTotal - counts.citationWarnings) +
		Math.max(0, counts.docIssuesTotal - counts.docIssueWarnings) +
		counts.undoc +
		counts.orphans;
	const tasks = counts.tasks;
	const attention = warnings + notes + tasks;
	return { warnings, tasks, notes, attention, clean: attention === 0 };
}

/**
 * Computes calm, high-signal default expansion state for each Project accordion section.
 * Only sections carrying active warnings open by default; informational lists stay collapsed
 * with their count badges visible until expanded (or revealed automatically while filtering).
 */
export function defaultProjectSectionOpen(section: ProjectSectionId, counts: ProjectSectionCounts): boolean {
	const hasAnyWarning =
		counts.truncated > 0 ||
		counts.drift > 0 ||
		counts.workWarnings > 0 ||
		counts.citationWarnings > 0 ||
		counts.docIssueWarnings > 0 ||
		counts.projectFilesAttention > 0;

	switch (section) {
		case "truncated":
			return counts.truncated > 0;
		case "drift":
			return counts.drift > 0;
		case "work":
			return counts.workTotal > 0;
		case "citations":
			return counts.citationWarnings > 0;
		case "docIssues":
			return counts.docIssueWarnings > 0;
		case "projectFiles":
			return counts.projectFilesAttention > 0;
		case "registries":
			return counts.registries > 0 && !hasAnyWarning;
		case "tasks":
		case "undoc":
		case "orphans":
			return false;
	}
}

/**
 * Resolves whether a Project accordion section should be expanded right now.
 * Explicit user toggles win; active text search or ticket/warnings filtering auto-expands
 * non-empty sections so matching results are never hidden behind a closed chevron.
 */
export function isProjectSectionOpen(
	section: ProjectSectionId,
	counts: ProjectSectionCounts,
	overrides: Readonly<Partial<Record<ProjectSectionId, boolean>>>,
	isFiltering: boolean,
): boolean {
	const explicit = overrides[section];
	if (typeof explicit === "boolean") return explicit;
	if (isFiltering) return true;
	return defaultProjectSectionOpen(section, counts);
}

/** Counts project root files needing setup (missing or untouched template). */
export function countProjectFileAttention(projectFiles: readonly Pick<DocFile, "exists" | "untouched">[]): number {
	return projectFiles.filter((f) => !f.exists || Boolean(f.untouched)).length;
}

/** Slices workspace checks and audit items down to only what pertains to the currently open file. */
export function sliceActiveFileHealth(input: ActiveFileHealthInput): ActiveFileHealthSlice {
	const kind = classifyHealthFile(input.path, {
		hasSslSize: input.hasSslSize,
		isRegistry: input.isRegistry,
	});
	if (!input.path || kind === "none") {
		return {
			kind: "none",
			checks: [],
			docIssues: [],
			citations: [],
			schemaDrift: [],
			undocRefs: [],
			openTasks: [],
			warnings: 0,
			errors: 0,
			notes: 0,
			badgeCount: 0,
			tone: "ok",
			statusLabel: "No file open",
			clean: true,
		};
	}

	const targetKey = input.canonicalize(input.path);
	const samePath = (p: string | undefined) => Boolean(p && input.canonicalize(p) === targetKey);

	const checks = input.checks.filter((c) => samePath(c.path));
	const docIssues = input.docIssues.filter((i) => samePath(i.path));
	const citations = input.citations.filter((c) => samePath(c.docPath) || samePath(c.targetPath));
	const schemaDrift = input.schemaDrift.filter((d) => samePath(d.schemaPath) || samePath(d.sqlPath));
	const undocRefs = input.undocRefs.filter((r) => samePath(r.path));
	const openTasks = input.openTasks.filter((t) => samePath(t.path));

	const errors = input.findingErrors + (input.sizeAlert === "over" ? 1 : 0);
	const warnings =
		input.findingWarnings +
		(input.sizeAlert === "near" ? 1 : 0) +
		checks.filter((c) => c.level === "warn").length +
		docIssues.filter((i) => i.level === "warn").length +
		citations.filter((c) => c.level === "warn").length +
		schemaDrift.length;
	const otherFindings = Math.max(0, input.findingsCount - input.findingErrors - input.findingWarnings);
	const notes =
		otherFindings +
		checks.filter((c) => c.level !== "warn").length +
		docIssues.filter((i) => i.level !== "warn").length +
		citations.filter((c) => c.level !== "warn").length +
		undocRefs.length;

	const badgeCount = errors + warnings > 0 ? errors + warnings : notes + openTasks.length;
	const clean = errors === 0 && warnings === 0 && notes === 0 && openTasks.length === 0;

	let tone: HealthTone = "ok";
	let statusLabel = "Healthy";
	if (input.sizeAlert === "over") {
		tone = "error";
		statusLabel = errors > 1 ? `Over limit · ${errors} errors` : "Over size limit";
	} else if (errors > 0) {
		tone = "error";
		statusLabel = `${errors} ${errors === 1 ? "error" : "errors"}`;
	} else if (input.sizeAlert === "near") {
		tone = "warn";
		statusLabel = warnings > 1 ? `Near limit · ${warnings} warnings` : "Near size limit";
	} else if (warnings > 0) {
		tone = "warn";
		statusLabel = `${warnings} ${warnings === 1 ? "warning" : "warnings"}`;
	} else if (notes > 0) {
		tone = "note";
		statusLabel = `${notes} ${notes === 1 ? "note" : "notes"}`;
	} else if (openTasks.length > 0) {
		tone = "note";
		statusLabel = `${openTasks.length} open ${openTasks.length === 1 ? "task" : "tasks"}`;
	}

	return {
		kind,
		checks,
		docIssues,
		citations,
		schemaDrift,
		undocRefs,
		openTasks,
		warnings,
		errors,
		notes,
		badgeCount,
		tone,
		statusLabel,
		clean,
	};
}

/** Computes worst house-style size alert across Bytes, Code lines, and Banner changes. */
export function worstSizeAlert(
	levels: readonly ("ok" | "near" | "over")[],
): "ok" | "near" | "over" {
	if (levels.includes("over")) return "over";
	if (levels.includes("near")) return "near";
	return "ok";
}
