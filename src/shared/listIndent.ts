// Pure Markdown list-line prefix parser and hanging-indent calculator for CodeMirror 6
// Live & Read modes. Computes exact visual indentation (`indentEm`) and marker column
// width (`hangEm`) so wrapped continuation lines align cleanly under the item's text start.

const RULE_RE = /^[ \t]*([-*_])(?:[ \t]*\1){2,}[ \t]*$/;
const TASK_RE = /^((?:[ \t]*>[ \t]?)*)([ \t]*)([-*+]|\d{1,9}[.)])([ \t]+)\[([ xX])\]([ \t]*)/;
const BULLET_RE = /^((?:[ \t]*>[ \t]?)*)([ \t]*)([-*+])([ \t]+)/;
const ORDERED_RE = /^((?:[ \t]*>[ \t]?)*)([ \t]*)(\d{1,9}[.)])([ \t]+)/;

export type ListLineInfo = {
	kind: "task" | "bullet" | "ordered";
	/** Character length of any leading blockquote prefix (`> `). */
	quoteLen: number;
	/** Character length of leading list indentation spaces/tabs after `quoteLen`. */
	wsLen: number;
	/** Start offset within the line of the list marker (`-`, `1.`). */
	markerFrom: number;
	/** End offset within the line of the marker + trailing space (and `[ ] ` for tasks). */
	markerTo: number;
	/** Raw marker text (e.g. `-`, `1.`, `10)`). */
	markerText: string;
	/** Offset within the line of `[` for task checkboxes. */
	bracketOffset?: number;
	/** Checked state for task checkboxes. */
	checked?: boolean;
	/** Visual nesting indent in `em` (2 spaces = 1.4em, tab = 2.8em). */
	indentEm: number;
	/** Visual width of the marker gutter in `em` (applied as hanging text-indent). */
	hangEm: number;
};

/** Counts visual indentation columns for leading list whitespace (space = 1, tab = 4). */
export function countIndentCols(ws: string): number {
	let cols = 0;
	for (let i = 0; i < ws.length; i++) {
		cols += ws[i] === "\t" ? 4 : 1;
	}
	return cols;
}

const round2 = (n: number) => Math.round(n * 100) / 100;

/** Parses a Markdown line into structured list geometry for hanging-indent alignment, or `null` if not a list item. */
export function parseListLine(text: string): ListLineInfo | null {
	const taskMatch = TASK_RE.exec(text);
	if (taskMatch) {
		const quote = taskMatch[1]!;
		const ws = taskMatch[2]!;
		const marker = taskMatch[3]!;
		const gap = taskMatch[4]!;
		const mark = taskMatch[5]!;
		const trail = taskMatch[6]!;
		const quoteLen = quote.length;
		const wsLen = ws.length;
		const markerFrom = quoteLen + wsLen;
		const bracketOffset = markerFrom + marker.length + gap.length;
		const markerTo = bracketOffset + 3 + trail.length;
		const cols = countIndentCols(ws);
		return {
			kind: "task",
			quoteLen,
			wsLen,
			markerFrom,
			markerTo,
			markerText: marker,
			bracketOffset,
			checked: mark.toLowerCase() === "x",
			indentEm: round2(cols * 0.7),
			hangEm: 1.7,
		};
	}

	if (RULE_RE.test(text)) return null;

	const bMatch = BULLET_RE.exec(text);
	if (bMatch) {
		const quote = bMatch[1]!;
		const ws = bMatch[2]!;
		const marker = bMatch[3]!;
		const gap = bMatch[4]!;
		const quoteLen = quote.length;
		const wsLen = ws.length;
		const markerFrom = quoteLen + wsLen;
		const markerTo = markerFrom + marker.length + gap.length;
		const cols = countIndentCols(ws);
		return {
			kind: "bullet",
			quoteLen,
			wsLen,
			markerFrom,
			markerTo,
			markerText: marker,
			indentEm: round2(cols * 0.7),
			hangEm: 1.5,
		};
	}

	const oMatch = ORDERED_RE.exec(text);
	if (oMatch) {
		const quote = oMatch[1]!;
		const ws = oMatch[2]!;
		const marker = oMatch[3]!;
		const gap = oMatch[4]!;
		const quoteLen = quote.length;
		const wsLen = ws.length;
		const markerFrom = quoteLen + wsLen;
		const markerTo = markerFrom + marker.length + gap.length;
		const cols = countIndentCols(ws);
		const hangEm = Math.max(1.75, round2(marker.length * 0.62 + 0.55));
		return {
			kind: "ordered",
			quoteLen,
			wsLen,
			markerFrom,
			markerTo,
			markerText: marker,
			indentEm: round2(cols * 0.7),
			hangEm,
		};
	}

	return null;
}
