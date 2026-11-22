// Pure Obsidian-style Markdown editing primitives, heading extraction, and callout
// parsing. Zero editor or DOM dependencies so every behavior can be unit-tested directly
// (ADR 0002: every edit is a direct transformation of the plain text).
import { fenced } from "./catalog";
import { headingAnchor } from "./docTables";
import { frontMatter } from "./frontMatter";

export type TextEditResult = {
	/** Replacement text for [changeFrom, changeTo]. */
	changeFrom: number;
	changeTo: number;
	insert: string;
	/** Resulting selection [selFrom, selTo] after applying the edit. */
	selFrom: number;
	selTo: number;
};

const WORD_CHAR = /[\p{L}\p{N}_-]/u;

/**
 * Toggles an inline Markdown marker (`**`, `*`, `~~`, `` ` ``, `==`) around the
 * selection, matching Obsidian's behavior:
 * - If the selection (or the characters immediately flanking it) is already wrapped
 *   in `marker`, removes the markers and keeps the inner text selected.
 * - If the selection is empty and the cursor sits inside a word, toggles wrapping
 *   around that word.
 * - If the selection is empty on whitespace/punctuation, inserts `marker + marker`
 *   with the cursor centered between them.
 */
export function toggleInlineWrap(text: string, from: number, to: number, marker: string): TextEditResult {
	const m = marker.length;
	const a = Math.min(from, to);
	const b = Math.max(from, to);

	// 1. Selected text itself starts and ends with marker (e.g. user selected `**word**`).
	if (b - a >= m * 2 && text.slice(a, a + m) === marker && text.slice(b - m, b) === marker) {
		const inner = text.slice(a + m, b - m);
		// Guard against `*` matching inside `**word**` when marker is `*` and inner starts/ends with `*`.
		if (!(marker === "*" && inner.startsWith("*") && inner.endsWith("*"))) {
			return { changeFrom: a, changeTo: b, insert: inner, selFrom: a, selTo: a + inner.length };
		}
	}

	// 2. Markers sit directly outside the selection (`**|word|**`).
	const before = a >= m ? text.slice(a - m, a) : "";
	const after = b + m <= text.length ? text.slice(b, b + m) : "";
	const extraStar = marker === "*" && text[a - 2] === "*" && text[b + 1] === "*" && !(text[a - 3] === "*" && text[b + 2] === "*");
	if (before === marker && after === marker && !extraStar) {
		return { changeFrom: a - m, changeTo: b + m, insert: text.slice(a, b), selFrom: a - m, selTo: b - m };
	}

	// 3. Non-empty selection: trim leading/trailing spaces outside the markers (just like Obsidian).
	if (b > a) {
		const selected = text.slice(a, b);
		const lead = /^[ \t]*/.exec(selected)![0];
		const trail = /[ \t]*$/.exec(selected)![0];
		const core = selected.slice(lead.length, selected.length - trail.length);
		if (core) {
			const insert = `${lead}${marker}${core}${marker}${trail}`;
			return {
				changeFrom: a,
				changeTo: b,
				insert,
				selFrom: a + lead.length + m,
				selTo: a + lead.length + m + core.length,
			};
		}
	}

	// 4. Collapsed cursor inside a word: expand to word and toggle wrap on it.
	if (a === b) {
		let ws = a;
		let we = a;
		while (ws > 0 && WORD_CHAR.test(text[ws - 1]!)) ws--;
		while (we < text.length && WORD_CHAR.test(text[we]!)) we++;
		if (we > ws) {
			// Check if that word is already flanked by `marker`.
			const wBefore = ws >= m ? text.slice(ws - m, ws) : "";
			const wAfter = we + m <= text.length ? text.slice(we, we + m) : "";
			const wExtraStar = marker === "*" && text[ws - 2] === "*" && text[we + 1] === "*" && !(text[ws - 3] === "*" && text[we + 2] === "*");
			if (wBefore === marker && wAfter === marker && !wExtraStar) {
				const word = text.slice(ws, we);
				const pos = Math.max(ws - m, a - m);
				return { changeFrom: ws - m, changeTo: we + m, insert: word, selFrom: pos, selTo: pos };
			}
			const word = text.slice(ws, we);
			return { changeFrom: ws, changeTo: we, insert: `${marker}${word}${marker}`, selFrom: a + m, selTo: a + m };
		}
		// Empty line / whitespace: insert paired markers and place cursor inside.
		return { changeFrom: a, changeTo: b, insert: `${marker}${marker}`, selFrom: a + m, selTo: a + m };
	}

	// Fallback for whitespace-only selection.
	const insert = `${marker}${text.slice(a, b)}${marker}`;
	return { changeFrom: a, changeTo: b, insert, selFrom: a + m, selTo: b + m };
}

/**
 * Obsidian `Ctrl+L` checkbox cycle on a single line:
 * - Plain line `"Task"` → `"- [ ] Task"` (preserving leading indent / blockquote prefix)
 * - Bullet `"- Task"` / `"* Task"` / `"1. Task"` → `"- [ ] Task"` (keeping marker style)
 * - Unchecked task `"- [ ] Task"` → `"- [x] Task"`
 * - Checked task `"- [x] Task"` → `"- [ ] Task"`
 */
export function toggleCheckboxLine(line: string): string {
	const task = /^((?:[ \t]*>[ \t]?)*[ \t]*(?:[-*+]|\d{1,9}[.)])[ \t]+)\[([ xX])\]([ \t]?.*)$/.exec(line);
	if (task) {
		const [, prefix, mark, rest] = task;
		const next = mark === " " ? "x" : " ";
		return `${prefix}[${next}]${rest}`;
	}
	const bullet = /^((?:[ \t]*>[ \t]?)*[ \t]*(?:[-*+]|\d{1,9}[.)])[ \t]+)(.*)$/.exec(line);
	if (bullet) {
		const [, prefix, rest] = bullet;
		return `${prefix}[ ] ${rest}`;
	}
	const quoteOrIndent = /^((?:[ \t]*>[ \t]?)*[ \t]*)(.*)$/.exec(line)!;
	return `${quoteOrIndent[1]}- [ ] ${quoteOrIndent[2]}`;
}

const IS_URL = /^https?:\/\/\S+$/i;

/**
 * Obsidian `Ctrl+K` insert link:
 * - Selected URL → `[](url)` with cursor inside `[]`
 * - Selected text → `[text]()` with cursor inside `()`
 * - Empty cursor → `[]()` with cursor inside `[]`
 */
export function insertLinkEdit(text: string, from: number, to: number): TextEditResult {
	const a = Math.min(from, to);
	const b = Math.max(from, to);
	const selected = text.slice(a, b);
	if (selected && IS_URL.test(selected.trim())) {
		const url = selected.trim();
		const insert = `[](${url})`;
		return { changeFrom: a, changeTo: b, insert, selFrom: a + 1, selTo: a + 1 };
	}
	if (selected) {
		const insert = `[${selected}]()`;
		const pos = a + selected.length + 3;
		return { changeFrom: a, changeTo: b, insert, selFrom: pos, selTo: pos };
	}
	return { changeFrom: a, changeTo: b, insert: "[]()", selFrom: a + 1, selTo: a + 1 };
}

/**
 * Obsidian smart URL paste: pasting an `http://` or `https://` URL over non-empty,
 * non-URL selected prose wraps the selection as `[selected](url)`. Returns null when
 * normal paste should proceed.
 */
export function pasteUrlOverSelection(selected: string, pasted: string): string | null {
	const url = pasted.trim();
	if (!selected || !selected.trim() || selected.includes("\n")) return null;
	if (!IS_URL.test(url)) return null;
	if (IS_URL.test(selected.trim())) return null;
	return `[${selected}](${url})`;
}

/** Auto-wrap character pairs when typing a delimiter over a non-empty selection. */
export const WRAP_PAIRS: Record<string, [string, string]> = {
	"*": ["*", "*"],
	_: ["_", "_"],
	"`": ["`", "`"],
	"~": ["~", "~"],
	"=": ["=", "="],
	"[": ["[", "]"],
	"(": ["(", ")"],
};

const LIST_LINE = /^((?:[ \t]*>[ \t]?)*)([ \t]*)([-*+]|\d{1,9}[.)])([ \t]+(?:\[[ xX]\][ \t]+)?)/;

/**
 * Smart Tab / Shift+Tab on a Markdown list line from anywhere on the line.
 * Returns null if the line is not a list item (so default Tab applies).
 */
export function smartListIndent(line: string, direction: "indent" | "outdent", indent = "  "): { text: string; delta: number } | null {
	const m = LIST_LINE.exec(line);
	if (!m) return null;
	const quotePrefix = m[1]!;
	const rest = line.slice(quotePrefix.length);
	if (direction === "indent") {
		return { text: `${quotePrefix}${indent}${rest}`, delta: indent.length };
	}
	if (rest.startsWith("\t")) {
		return { text: `${quotePrefix}${rest.slice(1)}`, delta: -1 };
	}
	const spaces = /^ +/.exec(rest)?.[0].length ?? 0;
	if (spaces === 0) return { text: line, delta: 0 };
	const remove = Math.min(spaces, indent.length);
	return { text: `${quotePrefix}${rest.slice(remove)}`, delta: -remove };
}

/**
 * Smart Backspace right at the end of a Markdown block marker (`- `, `- [ ] `, `1. `,
 * `## `, `> `): strips the marker cleanly in one stroke (Obsidian behavior).
 * `col` is 0-based offset within `line`. Returns the replacement prefix length to delete
 * from `from` to `col`, or null when normal Backspace should run.
 */
export function smartListBackspace(line: string, col: number): { from: number; to: number } | null {
	if (col <= 0) return null;
	const before = line.slice(0, col);
	// Task marker `- [ ] ` or `- [x] ` -> strip checkbox down to `- ` (or remove whole bullet if already bare).
	const task = /^((?:[ \t]*>[ \t]?)*[ \t]*(?:[-*+]|\d{1,9}[.)])[ \t]+)\[[ xX]\][ \t]$/.exec(before);
	if (task) return { from: task[1]!.length, to: col };
	// Bullet / ordered list marker `- `, `1. ` -> strip marker keeping indent/quote.
	const bullet = /^((?:[ \t]*>[ \t]?)*[ \t]*)(?:[-*+]|\d{1,9}[.)])[ \t]+$/.exec(before);
	if (bullet) return { from: bullet[1]!.length, to: col };
	// Heading `### ` -> strip heading hashes + space.
	const heading = /^#{1,6}[ \t]$/.exec(before);
	if (heading) return { from: 0, to: col };
	// Blockquote `> ` -> strip one quote level.
	const quote = /^((?:[ \t]*>[ \t]?)*)([ \t]*>[ \t]?)$/.exec(before);
	if (quote && quote[2]) return { from: quote[1]!.length, to: col };
	return null;
}

export type DocHeading = {
	level: number;
	text: string;
	anchor: string;
	/** 1-based line number. */
	line: number;
};

/**
 * Extracts all ATX headings (`#`..`######`) in a Markdown document outside YAML
 * frontmatter and fenced code blocks, with GitHub/Obsidian-compatible unique anchors.
 */
export function documentHeadings(text: string): DocHeading[] {
	const lines = text.split(/\r?\n/);
	const fm = frontMatter(text);
	const fences = fenced(text);
	const out: DocHeading[] = [];
	const used = new Map<string, number>();
	let offset = 0;
	for (let i = 0; i < lines.length; i++) {
		const raw = lines[i]!;
		const lineStart = offset;
		offset += raw.length + 1;
		if (i < fm.lines) continue;
		if (fences.some(([from, to]) => lineStart >= from && lineStart < to)) continue;
		const m = /^[ \t]{0,3}(#{1,6})[ \t]+(.+?)[ \t]*#*[ \t]*$/.exec(raw);
		if (!m) continue;
		const level = m[1]!.length;
		const title = m[2]!.trim();
		const base = headingAnchor(title);
		if (!base) continue;
		const count = used.get(base) ?? 0;
		used.set(base, count + 1);
		out.push({ level, text: title, anchor: count ? `${base}-${count}` : base, line: i + 1 });
	}
	return out;
}

/** Finds the 1-based line number of a heading by its text or anchor slug, or null if not found. */
export function findHeadingLine(text: string, target: string): number | null {
	const wanted = target.trim();
	if (!wanted) return null;
	const slug = headingAnchor(wanted);
	const list = documentHeadings(text);
	const exact = list.find((h) => h.anchor === wanted.toLowerCase() || h.text.toLowerCase() === wanted.toLowerCase());
	if (exact) return exact.line;
	const bySlug = list.find((h) => h.anchor === slug);
	return bySlug?.line ?? null;
}

export type CalloutTone = "info" | "ok" | "accent" | "warning" | "error" | "muted";

export type CalloutSpec = {
	type: string;
	label: string;
	tone: CalloutTone;
	icon: string;
};

export const CALLOUT_SPECS: Record<string, CalloutSpec> = {
	note: { type: "note", label: "Note", tone: "info", icon: "\ueb26" },
	info: { type: "info", label: "Info", tone: "info", icon: "\uea74" },
	todo: { type: "todo", label: "Todo", tone: "info", icon: "\ueab3" },
	tip: { type: "tip", label: "Tip", tone: "ok", icon: "\uea61" },
	hint: { type: "hint", label: "Hint", tone: "ok", icon: "\uea61" },
	success: { type: "success", label: "Success", tone: "ok", icon: "\ueba4" },
	check: { type: "check", label: "Check", tone: "ok", icon: "\ueab2" },
	done: { type: "done", label: "Done", tone: "ok", icon: "\ueba4" },
	important: { type: "important", label: "Important", tone: "accent", icon: "\ueb1e" },
	action: { type: "action", label: "Action", tone: "accent", icon: "\ueb1e" },
	cta: { type: "cta", label: "Call to action", tone: "accent", icon: "\ueb1e" },
	abstract: { type: "abstract", label: "Abstract", tone: "accent", icon: "\ueb26" },
	summary: { type: "summary", label: "Summary", tone: "accent", icon: "\ueb26" },
	tldr: { type: "tldr", label: "TL;DR", tone: "accent", icon: "\ueb26" },
	example: { type: "example", label: "Example", tone: "accent", icon: "\uea79" },
	question: { type: "question", label: "Question", tone: "warning", icon: "\ueb32" },
	help: { type: "help", label: "Help", tone: "warning", icon: "\ueb32" },
	faq: { type: "faq", label: "FAQ", tone: "warning", icon: "\ueb32" },
	warning: { type: "warning", label: "Warning", tone: "warning", icon: "\uea6c" },
	attention: { type: "attention", label: "Attention", tone: "warning", icon: "\uea6c" },
	caution: { type: "caution", label: "Caution", tone: "error", icon: "\ueb42" },
	danger: { type: "danger", label: "Danger", tone: "error", icon: "\ueaf2" },
	error: { type: "error", label: "Error", tone: "error", icon: "\uea87" },
	failure: { type: "failure", label: "Failure", tone: "error", icon: "\uea87" },
	fail: { type: "fail", label: "Fail", tone: "error", icon: "\uea87" },
	bug: { type: "bug", label: "Bug", tone: "error", icon: "\ueaaf" },
	quote: { type: "quote", label: "Quote", tone: "muted", icon: "\ueb33" },
	cite: { type: "cite", label: "Cite", tone: "muted", icon: "\ueb33" },
};

/** Curated presets offered in Insert Callout menus and Palette. */
export const CALLOUT_PRESETS: readonly { type: string; label: string; about: string }[] = [
	{ type: "important", label: "Important", about: "Highlight critical decisions, requirements, or calls to action" },
	{ type: "note", label: "Note", about: "Add helpful background context or clarification" },
	{ type: "tip", label: "Tip", about: "Share a shortcut, best practice, or recommendation" },
	{ type: "warning", label: "Warning", about: "Flag a gotcha, edge case, or pre-flight check" },
	{ type: "caution", label: "Caution", about: "Warn about destructive changes, risks, or rollback needs" },
	{ type: "question", label: "Question", about: "Track an open question or stakeholder decision needed" },
	{ type: "todo", label: "Todo", about: "Call out a checklist of follow-up actions" },
	{ type: "summary", label: "Summary", about: "Summarize a long section or spec at a glance" },
	{ type: "bug", label: "Bug", about: "Document a defect symptom or reproduction note" },
	{ type: "example", label: "Example", about: "Show a concrete worked example" },
	{ type: "quote", label: "Quote", about: "Quote a requirement, email, or specification" },
];

export type ParsedCallout = {
	spec: CalloutSpec;
	title: string;
	fold: "+" | "-" | null;
};

/** Parses the first line of an Obsidian / GitHub callout (`> [!NOTE] Custom title`, `>[!important]`, or `> [!TIP]- Folded`). */
export function parseCalloutHeader(line: string): ParsedCallout | null {
	const m = /^[ \t]{0,3}>[ \t]*\[!([A-Za-z0-9_-]+)\]([+-])?(?:[ \t]+(.*))?$/.exec(line);
	if (!m) return null;
	const key = m[1]!.toLowerCase();
	const spec = CALLOUT_SPECS[key] ?? { type: key, label: key.slice(0, 1).toUpperCase() + key.slice(1), tone: "info", icon: "\uea74" };
	const fold = (m[2] as "+" | "-" | undefined) ?? null;
	const title = m[3]?.trim() || spec.label;
	return { spec, title, fold };
}

/**
 * Serializes a callout's type, title, fold flag, and unprefixed body back into standard
 * Obsidian/GitHub `> [!type]` Markdown lines (keeping blank lines prefixed with `>` so
 * multi-paragraph callouts stay one contiguous blockquote).
 */
export function serializeCalloutBlock(
	type: string,
	title: string,
	fold: "+" | "-" | null,
	bodyText: string,
	keepEmptyBodyLine = false,
): string {
	const cleanType = type.trim().toLowerCase() || "note";
	const spec = CALLOUT_SPECS[cleanType];
	const trimmedTitle = title.trim();
	const defaultLabel = spec?.label ?? cleanType.slice(0, 1).toUpperCase() + cleanType.slice(1);
	const titlePart = trimmedTitle && trimmedTitle.toLowerCase() !== defaultLabel.toLowerCase() ? ` ${trimmedTitle}` : "";
	const head = `> [!${cleanType}]${fold ?? ""}${titlePart}`;
	let normalizedBody = bodyText.replace(/\r\n/g, "\n");
	if (!keepEmptyBodyLine) normalizedBody = normalizedBody.replace(/(?:\n[ \t]*)+$/, "");
	if (!normalizedBody) return keepEmptyBodyLine ? `${head}\n> ` : head;
	const bodyLines = normalizedBody.split("\n").map((line) => (line.length ? `> ${line}` : ">"));
	return `${head}\n${bodyLines.join("\n")}`;
}

/**
 * Wraps `selectedText` (or inserts a fresh callout block) with `> [!type] title`.
 * Returns the inserted text and relative cursor offset ready for typing the body.
 */
export function buildCalloutBlock(type: string, title?: string, selectedText = ""): { insert: string; cursorOffset: number } {
	const spec = CALLOUT_SPECS[type.toLowerCase()];
	const head = title?.trim() ? `> [!${type.toLowerCase()}] ${title.trim()}` : `> [!${type.toLowerCase()}]${spec ? "" : ""}`;
	const clean = selectedText.replace(/\r\n/g, "\n").trimEnd();
	if (clean) {
		const body = clean
			.split("\n")
			.map((l) => (l ? `> ${l}` : ">"))
			.join("\n");
		const insert = `${head}\n${body}`;
		return { insert, cursorOffset: insert.length };
	}
	const insert = `${head}\n> `;
	return { insert, cursorOffset: insert.length };
}

/**
 * Smart Enter inside a callout or blockquote (`> [!important] Title` or `> text`):
 * - After non-empty blockquote / callout line → continues `> ` on next line.
 * - On an empty `> ` line → removes the `> ` prefix to exit the callout cleanly.
 */
export function blockquoteEnter(line: string, cursor: number): { start: string } | { keep: number } | null {
	const m = /^([ \t]{0,3}>[ \t]?)(.*)$/.exec(line);
	if (!m) return null;
	const prefix = m[1]!;
	const rest = m[2]!;
	if (cursor < prefix.length) return null;
	if (!rest.trim()) return { keep: 0 };
	const normalized = prefix.endsWith(" ") || prefix.endsWith("\t") ? prefix : `${prefix} `;
	return { start: normalized };
}

export type ParsedImageSpec = {
	src: string;
	alt: string;
	width?: number;
	height?: number;
	kind: "md" | "wiki";
};

const DIM_RE = /^(\d{2,4})(?:x(\d{2,4}))?$/i;

/**
 * Parses Obsidian / Markdown image alt+size notation:
 * - `"Caption|400"` → `{ alt: "Caption", width: 400 }`
 * - `"400x250"` → `{ alt: "", width: 400, height: 250 }`
 * - `"Caption|320x200"` → `{ alt: "Caption", width: 320, height: 200 }`
 */
export function parseImageAltSize(rawAlt: string): { alt: string; width?: number; height?: number } {
	const parts = rawAlt.split("|").map((p) => p.trim());
	if (parts.length >= 2) {
		const last = parts[parts.length - 1]!;
		const dim = DIM_RE.exec(last);
		if (dim) {
			return {
				alt: parts.slice(0, -1).join(" | ").trim(),
				width: Number(dim[1]),
				...(dim[2] ? { height: Number(dim[2]) } : {}),
			};
		}
	}
	const sole = DIM_RE.exec(rawAlt.trim());
	if (sole) {
		return { alt: "", width: Number(sole[1]), ...(sole[2] ? { height: Number(sole[2]) } : {}) };
	}
	return { alt: rawAlt.trim() };
}

/** Parses a standalone Markdown `![alt|300](src)` or Obsidian `![[img.png|Caption|300]]` image expression. */
export function parseImageExpression(raw: string): ParsedImageSpec | null {
	const trimmed = raw.trim();
	const md = /^!\[([^\]]*)\]\(([^)\n]+)\)$/.exec(trimmed);
	if (md) {
		const { alt, width, height } = parseImageAltSize(md[1]!);
		// Strip optional Markdown title `"..."` and angle brackets `<...>` from URL.
		const urlPart = md[2]!.trim().replace(/^<([^>]+)>$/, "$1").replace(/\s+["'][^"']*["']\s*$/, "").trim();
		if (!urlPart) return null;
		return { src: urlPart, alt, width, height, kind: "md" };
	}
	const wiki = /^!\[\[([^[\]\n]+)\]\]$/.exec(trimmed);
	if (wiki) {
		const parts = wiki[1]!.split("|").map((p) => p.trim());
		const target = parts[0]!;
		if (!target) return null;
		const rest = parts.slice(1).join("|");
		const { alt, width, height } = rest ? parseImageAltSize(rest) : { alt: "" };
		return { src: target, alt, width, height, kind: "wiki" };
	}
	return null;
}

/** Updates (or removes when `width` is null) the explicit width specifier on an image Markdown/wikilink expression. */
export function withImageWidth(raw: string, width: number | null): string {
	const parsed = parseImageExpression(raw);
	if (!parsed) return raw;
	const lead = /^[ \t]*/.exec(raw)![0];
	const trail = /[ \t]*$/.exec(raw)![0];
	if (parsed.kind === "wiki") {
		const segments = [parsed.src];
		if (parsed.alt) segments.push(parsed.alt);
		if (width !== null) segments.push(String(width));
		return `${lead}![[${segments.join("|")}]]${trail}`;
	}
	const altPart = [parsed.alt, width !== null ? String(width) : ""].filter(Boolean).join("|");
	return `${lead}![${altPart}](${parsed.src})${trail}`;
}
