// Pure Obsidian-style Markdown editing primitives, heading extraction, and callout
// parsing. Zero editor or DOM dependencies so every behavior can be unit-tested directly
// (ADR 0002: every edit is a direct transformation of the plain text).
import { fenced } from "./catalog";
import { scanQuotePrefix } from "./codeTokens";
import { headingAnchor } from "./docTables";
import { bodyOffset, frontMatter, plainMarkdown } from "./frontMatter";

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

/** True when `inner` contains an internal delimiter that would close `marker` early (e.g. `a** and **b`). */
function hasClosingMarkerInside(inner: string, marker: string): boolean {
	if (!inner) return false;
	if (marker === "*") {
		// Any odd-length run of `*` inside `inner` toggles italic state (`*a* and *b*`, `***a*** and ***b***`),
		// whereas even-length `**` runs (`***word***`, `*a **b** c*`) belong to bold.
		let i = 0;
		while (i < inner.length) {
			if (inner[i] === "*") {
				let run = 1;
				while (i + run < inner.length && inner[i + run] === "*") run++;
				if (run % 2 === 1) return true;
				i += run;
			} else {
				i++;
			}
		}
		return false;
	}
	if (marker === "**") return /\*{2,}/.test(inner);
	return inner.includes(marker);
}

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

	// 1. Selected text itself starts and ends with marker (e.g. user selected `**word**` or `***word***`).
	if (b - a >= m * 2 && text.slice(a, a + m) === marker && text.slice(b - m, b) === marker) {
		const selected = text.slice(a, b);
		const inner = text.slice(a + m, b - m);
		let pureBold = false;
		if (marker === "*") {
			const leadStars = /^\*+/.exec(selected)?.[0].length ?? 0;
			const trailStars = /\*+$/.exec(selected)?.[0].length ?? 0;
			// `**word**` (even stars on both sides) is bold-only, not italic; `***word***` (3 stars) IS bold+italic.
			pureBold = leadStars % 2 === 0 && trailStars % 2 === 0;
		}
		if (!pureBold && !hasClosingMarkerInside(inner, marker)) {
			return { changeFrom: a, changeTo: b, insert: inner, selFrom: a, selTo: a + inner.length };
		}
	}

	// 2. Markers sit directly outside the selection (`**|word|**`).
	const before = a >= m ? text.slice(a - m, a) : "";
	const after = b + m <= text.length ? text.slice(b, b + m) : "";
	const extraStar = marker === "*" && text[a - 2] === "*" && text[b + 1] === "*" && !(text[a - 3] === "*" && text[b + 2] === "*");
	if (before === marker && after === marker && !extraStar && !hasClosingMarkerInside(text.slice(a, b), marker)) {
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
	const { prefix: quotePrefix, offset } = scanQuotePrefix(line);
	const afterQuote = line.slice(offset);
	const task = /^([ \t]*(?:[-*+]|\d{1,9}[.)])[ \t]+)\[([ xX])\]((?=[ \t]|$).*)$/.exec(afterQuote);
	if (task) {
		const [, listPrefix, mark, rest] = task;
		const next = mark === " " ? "x" : " ";
		return `${quotePrefix}${listPrefix}[${next}]${rest}`;
	}
	const bullet = /^([ \t]*(?:[-*+]|\d{1,9}[.)])[ \t]+)(.*)$/.exec(afterQuote);
	if (bullet) {
		const [, listPrefix, rest] = bullet;
		return `${quotePrefix}${listPrefix}[ ] ${rest}`;
	}
	const indent = /^([ \t]*)(.*)$/.exec(afterQuote)!;
	return `${quotePrefix}${indent[1]}- [ ] ${indent[2]}`;
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

const LIST_LINE_REST = /^([ \t]*)([-*+]|\d{1,9}[.)])([ \t]+(?:\[[ xX]\](?:[ \t]+|$))?)/;

/**
 * Smart Tab / Shift+Tab on a Markdown list line from anywhere on the line.
 * Returns null if the line is not a list item (so default Tab applies).
 */
export function smartListIndent(line: string, direction: "indent" | "outdent", indent = "  "): { text: string; delta: number } | null {
	const { prefix: quotePrefix, offset } = scanQuotePrefix(line);
	const rest = line.slice(offset);
	if (!LIST_LINE_REST.test(rest)) return null;
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
	const q = scanQuotePrefix(before);
	const afterQuote = before.slice(q.offset);
	// Task marker `- [ ] ` or `- [x] ` -> strip checkbox down to `- ` (or remove whole bullet if already bare).
	const task = /^([ \t]*(?:[-*+]|\d{1,9}[.)])[ \t]+)\[[ xX]\][ \t]$/.exec(afterQuote);
	if (task) return { from: q.offset + task[1]!.length, to: col };
	// Bullet / ordered list marker `- `, `1. ` -> strip marker keeping indent/quote.
	const bullet = /^([ \t]*)(?:[-*+]|\d{1,9}[.)])[ \t]+$/.exec(afterQuote);
	if (bullet) return { from: q.offset + bullet[1]!.length, to: col };
	// Heading `### ` -> strip heading hashes + space.
	if (q.depth === 0 && /^#{1,6}[ \t]$/.test(afterQuote)) return { from: 0, to: col };
	// Blockquote `> ` -> strip one quote level.
	if (q.depth > 0 && afterQuote === "") {
		const prev = scanQuotePrefix(before, q.depth - 1);
		return { from: prev.offset, to: col };
	}
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
		const eolLen = text[lineStart + raw.length] === "\r" ? 2 : 1;
		offset += raw.length + eolLen;
		if (i < fm.lines) continue;
		if (fences.some(([from, to]) => lineStart >= from && lineStart < to)) continue;
		const m = /^[ \t]{0,3}(#{1,6})[ \t]+(.+?)(?:[ \t]+#+)?[ \t]*$/.exec(raw);
		if (!m) continue;
		const level = m[1]!.length;
		const title = m[2]!.trim();
		const base = headingAnchor(plainMarkdown(title));
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
	const slug = headingAnchor(plainMarkdown(wanted));
	const list = documentHeadings(text);
	const exact = list.find(
		(h) =>
			h.anchor === wanted.toLowerCase() ||
			h.text.toLowerCase() === wanted.toLowerCase() ||
			plainMarkdown(h.text).toLowerCase() === wanted.toLowerCase(),
	);
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
	title?: string;
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

/** Parses the destination + optional title inside `![alt]( ... )` with balanced parens and `<...>` support. */
function parseMdImageDest(rawInner: string): { src: string; angle: boolean; rawTitle: string; title?: string } | null {
	const inner = rawInner.trim();
	if (!inner) return null;

	const parseOptionalTitle = (rest: string): { rawTitle: string; title?: string } | null => {
		const t = rest.trim();
		if (!t) return { rawTitle: "" };
		const first = t[0]!;
		const close = first === '"' ? '"' : first === "'" ? "'" : first === "(" ? ")" : "";
		if (!close) return null;
		let p = 1;
		while (p < t.length) {
			if (t[p] === "\\" && p + 1 < t.length) {
				p += 2;
				continue;
			}
			if (first === "(" && t[p] === "(") return null;
			if (t[p] === close) {
				if (p !== t.length - 1) return null;
				const unescaped = t.slice(1, p).replace(/\\(.)/g, "$1");
				return { rawTitle: t, title: unescaped };
			}
			p++;
		}
		return null;
	};

	if (inner.startsWith("<")) {
		let gt = 1;
		while (gt < inner.length) {
			if (inner[gt] === "\\" && gt + 1 < inner.length) {
				gt += 2;
				continue;
			}
			if (inner[gt] === "<") return null;
			if (inner[gt] === ">") break;
			gt++;
		}
		if (gt >= inner.length || inner[gt] !== ">") return null;
		const src = inner.slice(1, gt);
		if (!src) return null;
		const after = inner.slice(gt + 1);
		if (after.length > 0 && !/^[ \t]/.test(after)) return null;
		const titleRes = parseOptionalTitle(after);
		if (!titleRes) return null;
		return { src, angle: true, ...titleRes };
	}

	let pos = 0;
	let parenDepth = 0;
	while (pos < inner.length) {
		const ch = inner[pos]!;
		if (ch === "\\" && pos + 1 < inner.length) {
			pos += 2;
			continue;
		}
		if (ch === "(") {
			parenDepth++;
		} else if (ch === ")") {
			if (parenDepth === 0) return null;
			parenDepth--;
		} else if (ch === " " || ch === "\t") {
			if (parenDepth !== 0) return null;
			break;
		}
		pos++;
	}
	if (parenDepth !== 0) return null;
	const src = inner.slice(0, pos);
	if (!src) return null;
	const titleRes = parseOptionalTitle(inner.slice(pos));
	if (!titleRes) return null;
	return { src, angle: false, ...titleRes };
}

/** Parses a standalone Markdown `![alt|300](src)` or Obsidian `![[img.png|Caption|300]]` image expression. */
export function parseImageExpression(raw: string): ParsedImageSpec | null {
	const trimmed = raw.trim();
	const md = /^!\[([^\]]*)\]\(([^\n]+)\)$/.exec(trimmed);
	if (md) {
		const dest = parseMdImageDest(md[2]!);
		if (!dest) return null;
		const { alt, width, height } = parseImageAltSize(md[1]!);
		return { src: dest.src, alt, width, height, ...(dest.title !== undefined ? { title: dest.title } : {}), kind: "md" };
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
	const trimmed = raw.trim();
	const md = /^!\[([^\]]*)\]\(([^\n]+)\)$/.exec(trimmed);
	const dest = md ? parseMdImageDest(md[2]!) : null;
	const altPart = [parsed.alt, width !== null ? String(width) : ""].filter(Boolean).join("|");
	const srcFormatted = dest && (dest.angle || /\s/.test(dest.src)) ? `<${dest.src}>` : parsed.src;
	const titleSuffix = dest?.rawTitle ? ` ${dest.rawTitle}` : "";
	return `${lead}![${altPart}](${srcFormatted}${titleSuffix})${trail}`;
}

/** Generates a nested GFM Table of Contents list from document headings (`minLevel..maxLevel`). */
export function generateToc(markdown: string, minLevel = 2, maxLevel = 4): string {
	const headings = documentHeadings(markdown).filter((h) => h.level >= minLevel && h.level <= maxLevel);
	if (!headings.length) return "";
	const baseLevel = Math.min(...headings.map((h) => h.level));
	return headings
		.map((h) => {
			const indent = "  ".repeat(Math.max(0, h.level - baseLevel));
			return `${indent}- [${h.text}](#${h.anchor})`;
		})
		.join("\n");
}

const TOC_START = "<!-- toc -->";
const TOC_END = "<!-- /toc -->";

/** Finds a standalone `<!-- toc -->` / `<!-- /toc -->` marker line outside fenced code blocks. */
function tocMarkerAt(text: string, marker: string, from: number, fences: readonly [number, number][]): number {
	const escaped = marker.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	const pattern = new RegExp(`^[ \\t]*${escaped}[ \\t]*\\r?$`, "gm");
	pattern.lastIndex = from;
	for (let found = pattern.exec(text); found; found = pattern.exec(text)) {
		const at = found.index + found[0].indexOf(marker);
		if (!fences.some(([start, end]) => at >= start && at < end)) return at;
	}
	return -1;
}

/**
 * Updates an existing `<!-- toc --> ... <!-- /toc -->` block in place, or inserts one
 * right after the first H1 heading (or YAML frontmatter) when none exists yet.
 */
export function upsertTocBlock(markdown: string): { text: string; updated: boolean } {
	const toc = generateToc(markdown);
	if (!toc) return { text: markdown, updated: false };
	const eol = markdown.includes("\r\n") ? "\r\n" : "\n";
	// Blank lines around the list match Prettier's Markdown HTML-comment formatting so Format doesn't churn on save.
	const block = `${TOC_START}${eol}${eol}${toc.replace(/\n/g, eol)}${eol}${eol}${TOC_END}`;

	const fmStart = bodyOffset(markdown);
	const fences = fenced(markdown);
	const start = tocMarkerAt(markdown, TOC_START, fmStart, fences);
	const end = start >= 0 ? tocMarkerAt(markdown, TOC_END, start + TOC_START.length, fences) : -1;
	if (start >= 0 && end >= 0) {
		const next = markdown.slice(0, start) + block + markdown.slice(end + TOC_END.length);
		return { text: next, updated: next !== markdown };
	}

	const fm = frontMatter(markdown);
	const lines = markdown.split(/\r?\n/);
	let insertAfter = fm.lines;
	for (let i = fm.lines; i < lines.length; i++) {
		if (/^#\s+\S/.test(lines[i]!)) {
			insertAfter = i + 1;
			break;
		}
		if (lines[i]!.trim()) break;
	}
	const head = lines.slice(0, insertAfter).join(eol);
	const tail = lines.slice(insertAfter).join(eol).replace(/^(?:\r?\n)+/, "");
	const next = head ? `${head}${eol}${eol}${block}${tail ? `${eol}${eol}${tail}` : eol}` : `${block}${tail ? `${eol}${eol}${tail}` : eol}`;
	return { text: next, updated: true };
}

/** Counts words (excluding YAML frontmatter & code fence syntax) and Markdown task checklist progress. */
export function markdownStats(markdown: string): { words: number; tasksDone: number; tasksTotal: number } {
	const body = frontMatter(markdown).body;
	const lines = body.split(/\r?\n/);
	let inFence: { ch: string; len: number } | null = null;
	let words = 0;
	let tasksDone = 0;
	let tasksTotal = 0;
	for (const line of lines) {
		const fm = /^[ \t]{0,3}(`{3,}|~{3,})(.*)$/.exec(line);
		if (fm) {
			const ch = fm[1]![0]!;
			const len = fm[1]!.length;
			const info = fm[2]!;
			if (!inFence) {
				// Per CommonMark §4.5, a backtick fence info string cannot contain backticks (` ```inline``` ` is inline code).
				if (!(ch === "`" && info.includes("`"))) {
					inFence = { ch, len };
					continue;
				}
			} else if (ch === inFence.ch && len >= inFence.len && info.trim() === "") {
				inFence = null;
				continue;
			}
		}
		if (!inFence) {
			const task = /^[ \t]*[-*+]\s+\[([ xX])\]\s/.exec(line);
			if (task) {
				tasksTotal++;
				if (task[1]!.toLowerCase() === "x") tasksDone++;
			}
		}
		const clean = line
			.replace(/!\[[^\]]*\]\([^)]*\)/g, " ")
			.replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
			.replace(/[#*_`~>|]/g, " ");
		const tokens = clean.trim().split(/\s+/).filter((w) => /[A-Za-z0-9]/.test(w));
		words += tokens.length;
	}
	return { words, tasksDone, tasksTotal };
}

/**
 * The parts of `from`..`to` that each lie on one line, given where the line a position is on ends. The live
 * editor hides markup by replacing it, and an editor plugin may not replace a line break: a link whose
 * `(address "title")` wraps onto the next line is hidden as these parts, with the break between them left alone.
 */
export function lineSegments(from: number, to: number, lineEndAt: (pos: number) => number): [number, number][] {
	const parts: [number, number][] = [];
	for (let pos = from; pos < to; ) {
		const lineEnd = lineEndAt(pos);
		const end = Math.min(to, lineEnd);
		if (pos < end) parts.push([pos, end]);
		// Past the break; a line end that does not move on (it should not happen) ends the walk, not the editor.
		pos = Math.max(lineEnd + 1, pos + 1);
	}
	return parts;
}
