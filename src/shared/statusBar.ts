// Pure status-bar logic: compact service indicators (LSP, Agent), view-aware
// editor surface resolution (hiding text/JSON metadata in visual modes),
// non-default encoding/EOL checks, and warning-only SSL size alerts.
import { parseCsv } from "./csv";
import { encodingName } from "./fileKind";
import { level, type SizeReport } from "./houseStyle";
import type { AgentStatus, LspState, Settings, ToolStatus } from "./protocol";
import type { MarkdownViewMode, PlanViewMode } from "./viewModes";

export type ServiceTone = "ok" | "busy" | "warn" | "error" | "idle";

export type ServiceIndicator = {
	tone: ServiceTone;
	label: string;
	detail: string;
	ariaLabel: string;
	actionable: boolean;
};

/** Compact indicator state for the STARLIMS language server (`● LSP`). */
export function lspIndicator(
	lsp: LspState,
	info: ToolStatus | undefined,
	hasWorkspace: boolean,
): ServiceIndicator {
	const version = info?.version ? ` ${info.version}` : "";
	const note = lsp.message ?? info?.message;
	const restartDetail = hasWorkspace ? "\nClick to restart." : "";
	const restartAria = hasWorkspace ? " Click to restart." : "";

	if (!hasWorkspace && lsp.state === "stopped" && !note) {
		return {
			tone: "idle",
			label: "LSP",
			detail: `Language server${version} starts when a folder is opened.`,
			ariaLabel: `Language server${version} idle. Open a folder to start.`,
			actionable: false,
		};
	}

	if (lsp.state === "starting") {
		return {
			tone: "busy",
			label: "LSP",
			detail: `Language server${version} is starting…${restartDetail}`,
			ariaLabel: `Language server${version} starting.${restartAria}`,
			actionable: hasWorkspace,
		};
	}

	if (lsp.state === "running") {
		if (note) {
			return {
				tone: "warn",
				label: "LSP",
				detail: `Language server${version}: ${note}${restartDetail}`,
				ariaLabel: `Language server${version} running with warning: ${note}.${restartAria}`,
				actionable: hasWorkspace,
			};
		}
		return {
			tone: "ok",
			label: "LSP",
			detail: `Language server${version} running.${restartDetail}`,
			ariaLabel: `Language server${version} running.${restartAria}`,
			actionable: hasWorkspace,
		};
	}

	const statusWord = lsp.state === "failed" ? "failed" : "stopped";
	return {
		tone: "error",
		label: "LSP",
		detail: `${note ? `${note}${restartDetail}` : `Language server${version} ${statusWord}.${restartDetail}`}`,
		ariaLabel: `Language server${version} ${statusWord}${note ? `: ${note}` : ""}.${restartAria}`,
		actionable: hasWorkspace,
	};
}

/** Compact indicator state for the opencode Agent runtime (`● Agent`). */
export function agentIndicator(
	agentStatus: Pick<AgentStatus, "state" | "version" | "message">,
	info: ToolStatus | undefined,
): ServiceIndicator {
	if (info && !info.ok) {
		const msg = info.message ?? "opencode was not found. The Agent panel needs opencode 2.2.5 or 2.3.x on PATH.";
		return {
			tone: "warn",
			label: "Agent",
			detail: `${msg}\nClick for details.`,
			ariaLabel: `Agent unavailable: ${msg}`,
			actionable: true,
		};
	}

	const version = agentStatus.version ?? info?.version;
	const verText = version ? `opencode ${version}` : "opencode";

	if (agentStatus.state === "ready") {
		return {
			tone: "ok",
			label: "Agent",
			detail: `Agent ready (${verText}).\nClick to open Agent.`,
			ariaLabel: `Agent ready with ${verText}. Open Agent panel.`,
			actionable: true,
		};
	}

	if (agentStatus.state === "starting") {
		return {
			tone: "busy",
			label: "Agent",
			detail: `Starting ${verText}…\nClick to open Agent.`,
			ariaLabel: `Agent starting ${verText}. Open Agent panel.`,
			actionable: true,
		};
	}

	if (agentStatus.state === "failed") {
		const msg = agentStatus.message || `${verText} failed.`;
		return {
			tone: "error",
			label: "Agent",
			detail: `${msg}\nClick to open Agent.`,
			ariaLabel: `Agent error: ${msg}. Open Agent panel.`,
			actionable: true,
		};
	}

	return {
		tone: "idle",
		label: "Agent",
		detail: info?.ok ? `Agent idle (${verText} available).\nClick to open Agent.` : "Agent idle.\nClick to open Agent.",
		ariaLabel: `Agent idle${info?.ok ? ` (${verText} available)` : ""}. Open Agent panel.`,
		actionable: true,
	};
}

export type StatusSurfaceKind =
	| "none"
	| "welcome"
	| "graph"
	| "review"
	| "binary"
	| "plan-chart"
	| "plan-outline"
	| "table-grid"
	| "ssl-blocks"
	| "markdown-read"
	| "markdown-live"
	| "text";

export type StatusSurface = {
	kind: StatusSurfaceKind;
	/** True only when an active text cursor & Go-to-Line exist on screen. */
	showCursor: boolean;
	/** True when text encoding (UTF-8, etc.) and line endings (LF/CRLF) belong on the bar. */
	showTextMeta: boolean;
	/** True when the rightmost language item should open the VS Code Language Mode selector. */
	showLanguagePicker: boolean;
	/** True when Markdown word & task stats should be shown. */
	showWordCount: boolean;
	/** True when SSL size-limit warnings should be surfaced. */
	showSizeWarning: boolean;
	/** Explicit mode label for non-text views, or null to fall back to the file's language name. */
	modeLabel: string | null;
};

export type StatusSurfaceInput = {
	centerView: "editors" | "graph" | "welcome";
	inReview: boolean;
	reviewLanguage?: string | null;
	path: string | null;
	binary?: { size: number; image?: string };
	languageId?: string;
	isPlan: boolean;
	planMode: PlanViewMode;
	isMarkdown: boolean;
	mdMode: MarkdownViewMode;
	isTable: boolean;
	tableText: boolean;
	groupMode?: "text" | "blocks";
};

/** Resolves which right-side metadata belongs on the status bar for the active view. */
export function resolveStatusSurface(input: StatusSurfaceInput): StatusSurface {
	const quiet = (kind: StatusSurfaceKind, modeLabel: string | null): StatusSurface => ({
		kind,
		showCursor: false,
		showTextMeta: false,
		showLanguagePicker: false,
		showWordCount: false,
		showSizeWarning: false,
		modeLabel,
	});

	if (input.centerView === "welcome") return quiet("welcome", null);
	if (input.centerView === "graph") return quiet("graph", "Call Graph");
	if (input.inReview) return quiet("review", input.reviewLanguage ?? null);
	if (!input.path) return quiet("none", null);
	if (input.binary) return quiet("binary", input.binary.image ? "Picture" : "Not text");

	if (input.isPlan) {
		if (input.planMode === "chart") return quiet("plan-chart", "Flowchart");
		if (input.planMode === "text") return quiet("plan-outline", "Plan Outline");
	}

	if (input.isTable && !input.tableText) return quiet("table-grid", "Table");

	if (input.groupMode === "blocks" && input.languageId === "ssl") {
		return {
			kind: "ssl-blocks",
			showCursor: false,
			showTextMeta: false,
			showLanguagePicker: false,
			showWordCount: false,
			showSizeWarning: true,
			modeLabel: "SSL Blocks",
		};
	}

	if (input.isMarkdown) {
		if (input.mdMode === "read") {
			return {
				kind: "markdown-read",
				showCursor: false,
				showTextMeta: false,
				showLanguagePicker: false,
				showWordCount: true,
				showSizeWarning: false,
				modeLabel: "Read",
			};
		}
		if (input.mdMode === "live") {
			return {
				kind: "markdown-live",
				showCursor: true,
				showTextMeta: true,
				showLanguagePicker: false,
				showWordCount: true,
				showSizeWarning: false,
				modeLabel: "Markdown",
			};
		}
	}

	return {
		kind: "text",
		showCursor: true,
		showTextMeta: true,
		showLanguagePicker: true,
		showWordCount: input.isMarkdown,
		showSizeWarning: input.languageId === "ssl",
		modeLabel: null,
	};
}

/** Returns a human-readable encoding label only when the file is not standard UTF-8. */
export function nonDefaultEncoding(encoding: string | undefined): string | null {
	if (!encoding || encoding.toLowerCase() === "utf-8") return null;
	return encodingName(encoding);
}

/** Returns `"CRLF"` only when the file uses Windows line endings; standard LF stays quiet. */
export function nonDefaultEol(eol: string): "CRLF" | null {
	return eol === "\r\n" ? "CRLF" : null;
}

export type SslSizeAlertItem = {
	text: string;
	severity: "near" | "over";
};

/** Surfaces SSL house-style size metrics only when near or over a limit (healthy scripts stay quiet). */
export function sslSizeAlerts(
	report: SizeReport,
	limits: Settings["limits"],
): { alerts: SslSizeAlertItem[]; tooltip: string } {
	const alerts: SslSizeAlertItem[] = [];
	const push = (value: number, limit: number, text: string, near?: number) => {
		const at = level(value, limit, near);
		if (at !== "ok") alerts.push({ text: `${text} (${at})`, severity: at });
	};
	push(report.bytes, limits.bytes, `${(report.bytes / 1024).toFixed(1)} KB`);
	push(report.codeLines, limits.codeLines, `${report.codeLines} code lines`);
	push(
		report.historyEntries,
		limits.historyEntries,
		`${report.historyEntries} banner ${report.historyEntries === 1 ? "change" : "changes"}`,
		1,
	);
	const kb = `${(report.bytes / 1024).toFixed(1)} KB`;
	const changes = `${report.historyEntries} banner ${report.historyEntries === 1 ? "change" : "changes"}`;
	const tooltip = `${kb} · ${report.codeLines} code lines · ${changes} (limits: ${limits.bytes / 1024} KB, ${limits.codeLines} lines, ${limits.historyEntries} changes). Click to open Health.`;
	return { alerts, tooltip };
}

/** Formats an Activity Bar numeric badge, capping large counts cleanly. */
export function badgeText(count: number): string {
	if (count <= 0) return "";
	return count > 99 ? "99+" : String(count);
}

/** Counts steps in a `.plan.json` document for visual mode summaries (`22 steps`), or null if unreadable. */
export function planStepSummary(text: string): string | null {
	try {
		const parsed = JSON.parse(text) as { nodes?: unknown };
		if (!Array.isArray(parsed?.nodes)) return null;
		const n = parsed.nodes.length;
		return `${n} ${n === 1 ? "step" : "steps"}`;
	} catch {
		return null;
	}
}

/** Summarizes CSV/TSV grid dimensions (`12 rows × 5 cols`) for Table mode. */
export function tableGridSummary(text: string): string | null {
	const table = parseCsv(text);
	const cols = table.header.length;
	if (!cols) return null;
	const rows = table.rows.length;
	return `${rows} ${rows === 1 ? "row" : "rows"} × ${cols} ${cols === 1 ? "col" : "cols"}`;
}
