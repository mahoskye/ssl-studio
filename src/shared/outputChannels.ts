// Shared Output panel channel definitions, inference, ANSI stripping,
// filtering, and copy formatting for SSL Studio (VS Code Output precedent).

export type OutputChannelId = "studio" | "lsp" | "agent" | "git" | "docs";
export type OutputChannelSelection = "all" | OutputChannelId;
export type OutputLevel = "info" | "warn" | "error";

export type OutputChannelMeta = {
	id: OutputChannelId;
	/** Full label shown in the VS Code-style channel dropdown. */
	label: string;
	/** Short prefix badge shown on lines when viewing All Channels. */
	shortLabel: string;
	/** Empty-channel hint text. */
	description: string;
};

export const OUTPUT_CHANNELS: readonly OutputChannelMeta[] = [
	{
		id: "studio",
		label: "SSL Studio",
		shortLabel: "Studio",
		description: "Workspace events, file reloads, recovery notices, and application errors.",
	},
	{
		id: "lsp",
		label: "STARLIMS Language Server",
		shortLabel: "LSP",
		description: "starlims-lsp lifecycle, stderr output, server log messages, and format-on-save.",
	},
	{
		id: "agent",
		label: "Agent & MCP",
		shortLabel: "Agent",
		description: "opencode server status, MCP configuration, and agent turn events.",
	},
	{
		id: "git",
		label: "Git",
		shortLabel: "Git",
		description: "Source Control status refreshes, staging, commits, and repository errors.",
	},
	{
		id: "docs",
		label: "Documents & Audit",
		shortLabel: "Docs",
		description: "Workspace document audit summaries, schema syncs, exports, and local history.",
	},
] as const;

export const OUTPUT_CHANNEL_MAP: Readonly<Record<OutputChannelId, OutputChannelMeta>> = Object.fromEntries(
	OUTPUT_CHANNELS.map((c) => [c.id, c]),
) as Record<OutputChannelId, OutputChannelMeta>;

export type OutputEntry = {
	id: number;
	time: string;
	channel: OutputChannelId;
	level: OutputLevel;
	text: string;
};

export type OutputLevelFilter = {
	error: boolean;
	warn: boolean;
	info: boolean;
};

export const DEFAULT_OUTPUT_LEVEL_FILTER: OutputLevelFilter = {
	error: true,
	warn: true,
	info: true,
};

/** Strips ANSI CSI/OSC escape sequences so subprocess stderr renders cleanly in plain monospace. */
export function stripAnsi(text: string): string {
	return text
		.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, "")
		.replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, "");
}

/** Splits an arbitrary stderr chunk into trimmed non-empty sanitized lines. */
export function splitLogLines(chunk: string): string[] {
	return stripAnsi(chunk)
		.replace(/\r\n/g, "\n")
		.replace(/\r/g, "\n")
		.split("\n")
		.map((l) => l.trimEnd())
		.filter((l) => l.trim().length > 0);
}

/** Infers the best Output channel when legacy `log(line)` callers omit an explicit channel. */
export function inferOutputChannel(text: string): OutputChannelId {
	const t = text.toLowerCase();
	if (
		t.includes("starlims-lsp") ||
		t.includes("language server") ||
		t.includes("format on save") ||
		/\blsp\b/.test(t)
	) {
		return "lsp";
	}
	if (t.includes("opencode") || /\bagent\b/.test(t) || /\bmcp\b/.test(t)) {
		return "agent";
	}
	if (/\bgit\b/.test(t) || t.includes("repository")) {
		return "git";
	}
	if (
		t.includes("local history") ||
		t.includes("document audit") ||
		t.includes("catalog") ||
		t.includes("schema")
	) {
		return "docs";
	}
	return "studio";
}

/** Infers a log line's severity level from explicit prefixes or common error/warning wording. */
export function inferOutputLevel(text: string): OutputLevel {
	const t = text.trimStart().toLowerCase();
	if (
		t.startsWith("error:") ||
		t.startsWith("[error]") ||
		t.startsWith("uncaught:") ||
		t.startsWith("display error") ||
		/\b(failed|fatal|panic|exception|eacces|enoent)\b/.test(t)
	) {
		return "error";
	}
	if (
		t.startsWith("warn:") ||
		t.startsWith("warning:") ||
		t.startsWith("[warn]") ||
		/\b(skipped|restarting|did not answer|timed out|warning)\b/.test(t)
	) {
		return "warn";
	}
	return "info";
}

export function isOutputLevelFiltered(filter: OutputLevelFilter): boolean {
	return !(filter.error && filter.warn && filter.info);
}

/** Counts entries per channel plus total across all channels for dropdown badges. */
export function countOutputByChannel(entries: readonly OutputEntry[]): Record<OutputChannelSelection, number> {
	const counts: Record<OutputChannelSelection, number> = {
		all: entries.length,
		studio: 0,
		lsp: 0,
		agent: 0,
		git: 0,
		docs: 0,
	};
	for (const e of entries) counts[e.channel]++;
	return counts;
}

/** Filters Output entries by selected channel, severity checkboxes, and multi-word query. */
export function filterOutputEntries(
	entries: readonly OutputEntry[],
	opts: {
		channel: OutputChannelSelection;
		levels: OutputLevelFilter;
		query: string;
	},
): OutputEntry[] {
	const q = opts.query.trim().toLowerCase();
	const words = q ? q.split(/\s+/) : [];
	return entries.filter((e) => {
		if (opts.channel !== "all" && e.channel !== opts.channel) return false;
		if (!opts.levels[e.level]) return false;
		if (words.length) {
			const hay = `${e.time} ${OUTPUT_CHANNEL_MAP[e.channel].label} ${OUTPUT_CHANNEL_MAP[e.channel].shortLabel} ${e.level} ${e.text}`.toLowerCase();
			if (!words.every((w) => hay.includes(w))) return false;
		}
		return true;
	});
}

/** Formats visible Output entries as plain text for "Copy Output". */
export function formatOutputForCopy(
	entries: readonly OutputEntry[],
	opts: { showTimestamps: boolean; showChannelTag: boolean },
): string {
	return entries
		.map((e) => {
			const parts: string[] = [];
			if (opts.showTimestamps && e.time) parts.push(e.time);
			if (opts.showChannelTag) parts.push(`[${OUTPUT_CHANNEL_MAP[e.channel].shortLabel}]`);
			parts.push(e.text);
			return parts.join("  ");
		})
		.join("\n");
}
