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
	note: { type: "note", label: "Note", tone: "info", icon: "\uea74" },
	info: { type: "info", label: "Info", tone: "info", icon: "\uea74" },
	todo: { type: "todo", label: "Todo", tone: "info", icon: "\ueab2" },
	tip: { type: "tip", label: "Tip", tone: "ok", icon: "\uea61" },
	hint: { type: "hint", label: "Hint", tone: "ok", icon: "\uea61" },
	success: { type: "success", label: "Success", tone: "ok", icon: "\ueab2" },
	important: { type: "important", label: "Important", tone: "accent", icon: "\ueb32" },
	abstract: { type: "abstract", label: "Summary", tone: "accent", icon: "\ueb26" },
	summary: { type: "summary", label: "Summary", tone: "accent", icon: "\ueb26" },
	example: { type: "example", label: "Example", tone: "accent", icon: "\ueb84" },
	question: { type: "question", label: "Question", tone: "warning", icon: "\ueb32" },
	warning: { type: "warning", label: "Warning", tone: "warning", icon: "\uea6c" },
	caution: { type: "caution", label: "Caution", tone: "error", icon: "\uea87" },
	danger: { type: "danger", label: "Danger", tone: "error", icon: "\uea87" },
	failure: { type: "failure", label: "Failure", tone: "error", icon: "\uea87" },
	bug: { type: "bug", label: "Bug", tone: "error", icon: "\uea87" },
	quote: { type: "quote", label: "Quote", tone: "muted", icon: "\ueb26" },
};

export type ParsedCallout = {
	spec: CalloutSpec;
	title: string;
	fold: "+" | "-" | null;
};

/** Parses the first line of an Obsidian / GitHub callout (`> [!NOTE] Custom title` or `> [!TIP]- Folded`). */
export function parseCalloutHeader(line: string): ParsedCallout | null {
	const m = /^[ \t]{0,3}>[ \t]*\[!([A-Za-z0-9_-]+)\]([+-])?(?:[ \t]+(.*))?$/.exec(line);
	if (!m) return null;
	const key = m[1]!.toLowerCase();
	const spec = CALLOUT_SPECS[key] ?? { type: key, label: key.slice(0, 1).toUpperCase() + key.slice(1), tone: "info", icon: "\uea74" };
	const fold = (m[2] as "+" | "-" | undefined) ?? null;
	const title = m[3]?.trim() || spec.label;
	return { spec, title, fold };
}
