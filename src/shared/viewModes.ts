// File-type editor view modes: Markdown (Source | Live | Read), Plans (Source | Text | Chart),
// and Tables (Text | Table). Persisted by file type rather than per individual file so switching
// documents keeps the user's chosen view mode, while still allowing independent split groups.

export type MarkdownViewMode = "source" | "live" | "read";
export type PlanViewMode = "source" | "text" | "chart";

export const MARKDOWN_MODE_KEY = "view.markdown.mode";
export const PLAN_MODE_KEY = "view.plan.mode";
export const TABLE_TEXT_MODE_KEY = "view.table.text";

export function parseMarkdownViewMode(raw: string | null | undefined): MarkdownViewMode | null {
	return raw === "source" || raw === "live" || raw === "read" ? raw : null;
}

export function parsePlanViewMode(raw: string | null | undefined): PlanViewMode | null {
	return raw === "source" || raw === "text" || raw === "chart" ? raw : null;
}

export function parseTableTextMode(raw: string | null | undefined): boolean | null {
	if (raw === "true") return true;
	if (raw === "false") return false;
	return null;
}

/** Resolves the effective Markdown view mode for a group, falling back to the persisted file-type default and Settings. */
export function resolveMarkdownMode(
	groupMode: MarkdownViewMode | undefined,
	savedDefault: MarkdownViewMode | null,
	livePreviewSetting: boolean | undefined,
): MarkdownViewMode {
	if (groupMode) return groupMode;
	if (savedDefault) return savedDefault;
	return livePreviewSetting === false ? "source" : "live";
}

/** Resolves the effective Plan view mode for a group, falling back to the persisted file-type default ("chart"). */
export function resolvePlanMode(
	groupMode: PlanViewMode | undefined,
	savedDefault: PlanViewMode | null,
): PlanViewMode {
	return groupMode ?? savedDefault ?? "chart";
}

/** Resolves whether CSV/TSV tables render as plain text for a group (defaults to interactive Table view). */
export function resolveTableTextMode(
	groupText: boolean | undefined,
	savedDefault: boolean | null,
): boolean {
	if (groupText !== undefined) return groupText;
	if (savedDefault !== null) return savedDefault;
	return false;
}

/**
 * Whether changing a view mode in `group` should also update the global file-type default.
 * Primary group (`0`), unspecified group, or a single-group layout updates the default;
 * secondary split groups (`group > 0` when split) stay independent (e.g. side-by-side Live + Read).
 */
export function shouldUpdateDefaultMode(group: number | undefined, groupCount: number): boolean {
	return group === undefined || group === 0 || groupCount <= 1;
}
