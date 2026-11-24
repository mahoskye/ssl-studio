// Search results by line: a line with two matches is one row with both
// marked, not two rows that read the same. Pure, so it can be tested.
import type { SearchHit } from "../../shared/protocol";
import { tagSearchPattern } from "../../shared/tags";

export type LineHit = { path: string; line: number; text: string; textOffset?: number; matches: { column: number; length: number }[] };

/** One entry for each line, in the order the hits came, with that line's matches from left to right. */
export function byLine(hits: SearchHit[]): LineHit[] {
	const lines = new Map<string, LineHit>();
	for (const hit of hits) {
		const key = `${hit.path}\n${hit.line}`;
		let line = lines.get(key);
		if (!line) {
			line = {
				path: hit.path,
				line: hit.line,
				text: hit.text,
				...(hit.textOffset ? { textOffset: hit.textOffset } : {}),
				matches: [],
			};
			lines.set(key, line);
		} else if ((hit.textOffset ?? 0) < (line.textOffset ?? 0)) {
			// Prefer the earliest window so sorted `matches[0]` falls inside `line.text`.
			line.text = hit.text;
			if (hit.textOffset) line.textOffset = hit.textOffset;
			else delete line.textOffset;
		}
		line.matches.push({ column: hit.column, length: hit.length });
	}
	for (const line of lines.values()) line.matches.sort((a, b) => a.column - b.column);
	return [...lines.values()];
}

export type Segment = { text: string; match: boolean };

/**
 * A line cut to what a row can show: a little before the first match, every
 * match marked, and some of what follows the last. Indentation is dropped,
 * and "…" stands for text cut from the front (including windowed excerpts
 * with `textOffset > 0`).
 */
export function segments(line: LineHit, before = 30, after = 80): Segment[] {
	const offset = line.textOffset ?? 0;
	const first = line.matches[0];
	if (!first) return [{ text: (offset > 0 ? "…" : "") + line.text.trim(), match: false }];
	const out: Segment[] = [];
	const firstFrom = Math.max(0, first.column - 1 - offset);
	const start = Math.max(0, Math.min(firstFrom - before, line.text.length));
	let at = start;
	for (const m of line.matches) {
		const from = m.column - 1 - offset;
		// A match inside the one before it is already marked; a match outside this excerpt window cannot be sliced here.
		if (from < at || m.length <= 0) continue;
		if (from >= line.text.length) break;
		const end = Math.min(line.text.length, from + m.length);
		if (end <= from) continue;
		if (from > at) out.push({ text: line.text.slice(at, from), match: false });
		out.push({ text: line.text.slice(from, end), match: true });
		at = end;
	}
	if (at < line.text.length) out.push({ text: line.text.slice(at, at + after), match: false });
	const cutFront = offset > 0 || start > 0;
	const lead = out[0];
	if (lead && !lead.match) {
		lead.text = (cutFront ? "…" : "") + lead.text.trimStart();
		if (!lead.text) out.shift();
	} else if (cutFront) out.unshift({ text: "…", match: false });
	return out;
}

/**
 * The columns of the matches that `segments` marks, in the order it marks
 * them: a match inside the one before it, of nothing, or outside the excerpt
 * window has no mark and no column here. For telling which mark is which match.
 */
export function markedColumns(line: LineHit): number[] {
	const out: number[] = [];
	const first = line.matches[0];
	if (!first) return out;
	const offset = line.textOffset ?? 0;
	let at = 0;
	for (const m of line.matches) {
		const from = m.column - 1 - offset;
		if (from < at || m.length <= 0) continue;
		if (from >= line.text.length) break;
		const end = Math.min(line.text.length, from + m.length);
		if (end <= from) continue;
		out.push(m.column);
		at = end;
	}
	return out;
}

// --- Pure doc-metadata search grammar & query resolution ----------------------

export type TokenSpan = { start: number; end: number };

export type ParsedDocFilters = {
	text: string;
	tags: string[];
	statuses: string[];
	tickets: string[];
	parents: string[];
	groups: string[];
	kinds: string[];
	headings: string[];
	tasks: ("open" | "done" | "all")[];
	props: { key: string; value: string }[];
	/** Unknown lowercase `key:val` tokens that might be custom YAML frontmatter properties. */
	customProps: { key: string; value: string; raw: string; start: number; end: number }[];
	/** Character spans in `raw` consumed as recognized doc-filter tokens. */
	consumedSpans: TokenSpan[];
};

const KNOWN_DOC_PROP_KEYS = new Set([
	"owner",
	"reviewer",
	"release",
	"priority",
	"version",
	"approved-by",
	"approvedby",
	"approved-date",
	"approveddate",
	"change-control",
	"changecontrol",
	"gxp-impact",
	"gxpimpact",
	"source",
	"blocks",
	"blocked-by",
	"blockedby",
	"supersedes",
	"superseded-by",
	"supersededby",
]);

const NON_PROP_SCHEMES = new Set(["http", "https", "file", "mailto", "data", "ftp", "ssh", "git"]);
const escapeRegex = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * Strips only the consumed token spans from `raw` without disturbing untouched text,
 * literal spaces, or unmatched `key:val` token positions.
 */
export function stripTokenSpans(raw: string, spans: readonly TokenSpan[]): string {
	if (!spans.length) return raw;
	const sorted = [...spans].sort((a, b) => a.start - b.start);
	let out = "";
	let cursor = 0;
	for (const span of sorted) {
		if (span.start < cursor) continue;
		let before = raw.slice(cursor, span.start);
		let nextCursor = span.end;
		if (!out && !before.trim()) {
			before = "";
			while (nextCursor < raw.length && (raw[nextCursor] === " " || raw[nextCursor] === "\t")) nextCursor++;
		} else if (nextCursor === raw.length) {
			before = before.replace(/[ \t]+$/, "");
		} else if (raw[nextCursor] === " " || raw[nextCursor] === "\t") {
			nextCursor++;
		} else if (before.endsWith(" ") || before.endsWith("\t")) {
			before = before.slice(0, -1);
		}
		out += before;
		cursor = nextCursor;
	}
	out += raw.slice(cursor);
	return out.trim() ? out : "";
}

/** Extracts structured metadata filter tokens from a search query string (supports quoted values). */
export function parseDocFilterTokens(raw: string): ParsedDocFilters {
	const tags: string[] = [];
	const statuses: string[] = [];
	const tickets: string[] = [];
	const parents: string[] = [];
	const groups: string[] = [];
	const kinds: string[] = [];
	const headings: string[] = [];
	const tasks: ("open" | "done" | "all")[] = [];
	const props: { key: string; value: string }[] = [];
	const customProps: { key: string; value: string; raw: string; start: number; end: number }[] = [];
	const consumedSpans: TokenSpan[] = [];

	const tokenRe = /(?:^|\s)([A-Za-z][A-Za-z0-9_-]{1,}):(?:"([^"]+)"|'([^']+)'|(\S+))/g;
	let m: RegExpExecArray | null;
	while ((m = tokenRe.exec(raw))) {
		const full = m[0]!;
		const rawKey = m[1]!;
		const val = (m[2] ?? m[3] ?? m[4] ?? "").trim();
		if (!val) continue;
		const key = rawKey.toLowerCase();
		if (NON_PROP_SCHEMES.has(key) || val.startsWith("//") || val.startsWith("\\")) continue;
		const leadingSpace = /^\s/.test(full) ? 1 : 0;
		const start = m.index + leadingSpace;
		const end = m.index + full.length;

		if (key === "tag") {
			const clean = val.replace(/^#+/, "");
			if (!clean) continue;
			tags.push(clean);
			consumedSpans.push({ start, end });
			continue;
		}
		if (key === "status") {
			statuses.push(val);
			consumedSpans.push({ start, end });
			continue;
		}
		if (key === "ticket") {
			tickets.push(val);
			consumedSpans.push({ start, end });
			continue;
		}
		if (key === "parent") {
			parents.push(val);
			consumedSpans.push({ start, end });
			continue;
		}
		if (key === "group") {
			groups.push(val.toLowerCase());
			consumedSpans.push({ start, end });
			continue;
		}
		if (key === "kind") {
			kinds.push(val.toLowerCase());
			consumedSpans.push({ start, end });
			continue;
		}
		if (key === "heading") {
			headings.push(val);
			consumedSpans.push({ start, end });
			continue;
		}
		if (key === "task") {
			const v = val.toLowerCase();
			if (v === "open" || v === "todo" || v === "unchecked") tasks.push("open");
			else if (v === "done" || v === "closed" || v === "checked") tasks.push("done");
			else if (v === "all" || v === "any") tasks.push("all");
			else continue;
			consumedSpans.push({ start, end });
			continue;
		}
		if (KNOWN_DOC_PROP_KEYS.has(key)) {
			props.push({ key, value: val });
			consumedSpans.push({ start, end });
			continue;
		}
		// Keep arbitrary lowercase `prop:val` as a candidate custom frontmatter property (avoid SSL `Me:sField`).
		if (rawKey === key && !/[A-Z]/.test(rawKey)) {
			customProps.push({ key, value: val, raw: raw.slice(start, end), start, end });
		}
	}

	return {
		text: stripTokenSpans(raw, consumedSpans),
		tags,
		statuses,
		tickets,
		parents,
		groups,
		kinds,
		headings,
		tasks,
		props,
		customProps,
		consumedSpans,
	};
}

export type SearchScopeKind = "all" | "code" | "docs" | "ticket" | "custom";

export type ResolvedSearchQuery = {
	parsed: ParsedDocFilters;
	activeCustomProps: { key: string; value: string }[];
	freeText: string;
	effectiveQuery: string;
	effectiveRegex: boolean;
	effectiveCase: boolean;
	effectiveWhole: boolean;
	/** True when a doc-filter-only query synthesized a preview regex; Replace All must be disabled. */
	syntheticQuery: boolean;
	hasDocMetaFilters: boolean;
	hasHeadingFilter: boolean;
	hasTaskFilter: boolean;
};

/**
 * Resolves a raw user query into its parsed doc filters, literal free-text query,
 * and (for filter-only doc queries) synthetic preview pattern.
 * - Disables doc filter parsing in `"code"` scope and in regex mode.
 * - Never mutates literal whitespace queries like `"   "` or promotes them to regex mode.
 */
export function resolveSearchQuery(params: {
	rawQuery: string;
	regex: boolean;
	caseSensitive: boolean;
	wholeWord: boolean;
	scope: SearchScopeKind;
	knownCustomKeys?: ReadonlySet<string>;
	parsed?: ParsedDocFilters;
}): ResolvedSearchQuery {
	const { rawQuery, regex, caseSensitive, wholeWord, scope, knownCustomKeys } = params;
	const emptyParsed: ParsedDocFilters = {
		text: rawQuery,
		tags: [],
		statuses: [],
		tickets: [],
		parents: [],
		groups: [],
		kinds: [],
		headings: [],
		tasks: [],
		props: [],
		customProps: [],
		consumedSpans: [],
	};

	const parsed = !regex && scope !== "code" ? (params.parsed ?? parseDocFilterTokens(rawQuery)) : emptyParsed;
	const activeCustomProps: { key: string; value: string }[] = [];
	const allConsumedSpans: TokenSpan[] = [...parsed.consumedSpans];

	if (!regex && scope !== "code" && parsed.customProps.length) {
		for (const cp of parsed.customProps) {
			if (scope === "docs" || Boolean(knownCustomKeys?.has(cp.key))) {
				activeCustomProps.push({ key: cp.key, value: cp.value });
				allConsumedSpans.push({ start: cp.start, end: cp.end });
			}
		}
	}

	const freeText = allConsumedSpans.length ? stripTokenSpans(rawQuery, allConsumedSpans) : rawQuery;
	const hasKnownDocFilters = Boolean(
		parsed.tags.length ||
			parsed.statuses.length ||
			parsed.tickets.length ||
			parsed.parents.length ||
			parsed.groups.length ||
			parsed.kinds.length ||
			parsed.props.length,
	);
	const hasDocMetaFilters = hasKnownDocFilters || activeCustomProps.length > 0;
	const hasHeadingFilter = parsed.headings.length > 0;
	const hasTaskFilter = parsed.tasks.length > 0;
	const hasAnyFilter = hasDocMetaFilters || hasHeadingFilter || hasTaskFilter;

	let effectiveQuery = freeText;
	let effectiveRegex = regex;
	let effectiveCase = caseSensitive;
	let effectiveWhole = wholeWord;
	let syntheticQuery = false;

	if (!effectiveQuery && hasAnyFilter) {
		syntheticQuery = true;
		if (hasHeadingFilter) {
			const first = parsed.headings[0]!;
			effectiveQuery = first === "*" ? "^\\s{0,3}#{1,6}\\s+\\S" : `^\\s{0,3}#{1,6}\\s+.*${escapeRegex(first)}`;
			effectiveRegex = true;
			effectiveWhole = false;
		} else if (hasTaskFilter) {
			const mode = parsed.tasks[0]!;
			effectiveQuery =
				mode === "open"
					? "^\\s*(?:>\\s*)*(?:(?:[-*+]|\\d+[.)])\\s+)+\\[ \\]"
					: mode === "done"
						? "^\\s*(?:>\\s*)*(?:(?:[-*+]|\\d+[.)])\\s+)+\\[[xX]\\]"
						: "^\\s*(?:>\\s*)*(?:(?:[-*+]|\\d+[.)])\\s+)+\\[[ xX]\\]";
			effectiveRegex = true;
			effectiveWhole = false;
		} else if (parsed.tags.length) {
			effectiveQuery = tagSearchPattern(parsed.tags[0]!);
			effectiveRegex = true;
			effectiveWhole = false;
		} else if (parsed.statuses.length) {
			effectiveQuery = "^status\\s*:";
			effectiveRegex = true;
			effectiveCase = false;
			effectiveWhole = false;
		} else if (parsed.tickets.length) {
			effectiveQuery = escapeRegex(parsed.tickets[0]!);
			effectiveRegex = true;
			effectiveCase = false;
			effectiveWhole = false;
		} else if (parsed.parents.length) {
			effectiveQuery = "^parent\\s*:";
			effectiveRegex = true;
			effectiveCase = false;
			effectiveWhole = false;
		} else if (parsed.props.length || activeCustomProps.length) {
			const firstKey = (parsed.props[0] ?? activeCustomProps[0])!.key;
			effectiveQuery = `^${escapeRegex(firstKey)}\\s*:`;
			effectiveRegex = true;
			effectiveCase = false;
			effectiveWhole = false;
		} else {
			effectiveQuery = "^(?:title\\s*:|#{1,6}\\s+)";
			effectiveRegex = true;
			effectiveCase = false;
			effectiveWhole = false;
		}
	}

	return {
		parsed,
		activeCustomProps,
		freeText,
		effectiveQuery,
		effectiveRegex,
		effectiveCase,
		effectiveWhole,
		syntheticQuery,
		hasDocMetaFilters,
		hasHeadingFilter,
		hasTaskFilter,
	};
}
