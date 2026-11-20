// What a Markdown text is made of, line by line, for the editor to draw as it
// is written ("live preview"): a heading larger, strong words strong, a
// link's words as a link, and the markup itself (the #s, the stars, a link's
// brackets and address) put out of the way on the lines the cursor is not on.
//
// This reads the text and changes nothing in it (ADR 0002): the marks say
// where things are, by line and column, and the editor styles those places.
//
// A mark of kind "syntax" makes characters the user wrote disappear from the
// lines they are not writing on, so it is given only where the rendered page
// would not show those characters either. Which lines are a block of code, a
// block of HTML or a table is asked of the renderer itself. Stars and
// underscores are paired by the rules the renderer pairs them by; an address
// is not looked into; and a line is never left with nothing to see. Inside a
// list or a quote the renderer's reading cannot be laid back over the lines,
// and the blocks there are found by rules of this file's own, which know a
// fence and code set in under a bullet. The two readings can still differ
// there, and on runs of mixed marks; where they do, the Read view is right.

/** What a stretch of text is. "syntax" is markup: the characters that say what the text beside them is. */
export type LiveKind =
	| "h1"
	| "h2"
	| "h3"
	| "h4"
	| "h5"
	| "h6"
	| "strong"
	| "em"
	| "code"
	| "strike"
	| "link"
	| "quote"
	| "bullet"
	| "box"
	| "done"
	| "codeblock"
	| "table"
	| "rule"
	| "front"
	| "syntax";

import { marked } from "marked";

/** One stretch of one line. Columns count from 1, as the editor's do; `end` is the column after the last character. */
export type LiveMark = { line: number; start: number; end: number; kind: LiveKind; /** Where a link leads, as written. */ href?: string };

/**
 * How much larger than the text a heading is drawn, largest first: the steps a first, second, third and fourth
 * heading start from, and the text's own size, which a fifth and a sixth have and a longer heading may come down to.
 */
export const HEADING_SIZES = [1.8, 1.5, 1.25, 1.1, 1] as const;

/**
 * The step a heading is drawn at: its own, or the next smaller one that fits. `room` is how many times larger than
 * the text the line could be drawn before it ran past the editor's edge: where a line wraps is worked out at the
 * text's own size, so a heading enlarged past its room would run off the side.
 */
export function headingStep(level: number, room: number): number {
	let step = Math.min(Math.max(level, 1), HEADING_SIZES.length) - 1;
	while (step < HEADING_SIZES.length - 1 && HEADING_SIZES[step]! > room) step++;
	return step;
}

/** A line longer than this has its words left unread: nobody writes one, and reading it for marks must not hold the window up. */
export const LONGEST_LINE = 5000;
/**
 * A text longer than this is read without the renderer's lexer, by this file's own rules for blocks. The lexer's
 * time grows faster than the text: in the engine the app's window runs, it is a tenth of a second at 35,000
 * characters and a second or two at 60,000. The editor reads a long text aside from the window, so the time is
 * not felt at the keys; this is where even a reading aside comes too late to be of use.
 */
export const LONGEST_LEXED = 60_000;
/** How far back a closing mark looks for the one that opened it. */
const LOOK_BACK = 64;

const HEADING = /^(#{1,6})([ \t]+)/;
const RULE = /^[ \t]{0,3}([-*_])(?:[ \t]*\1){2,}[ \t]*$/;
const QUOTE = /^(?:[ \t]{0,3}>[ \t]?)+/;
const BULLET = /^([ \t]*)([-*+]|\d{1,9}[.)])([ \t]+)/;
const BOX = /^\[([ xX])\](?=[ \t]|$)/;
/** The kinds of HTML that end only at their own closing tag, wherever a blank line falls. */
const HTML_RAW = /^[ \t>]*<(pre|script|style|textarea)\b/i;
const SPACE = /\s/;
const PUNCTUATION = /[\p{P}\p{S}]/u;
const WORD = /[\p{L}\p{N}]/u;
const ADDRESS = /^(?:https?:\/\/|www\.)/i;
/** What may stand between a link's round brackets: an address with no space in it, and after it perhaps a title in quotes. */
const DESTINATION = /^(?:<[^<>]*>|[^\s<]\S*)?(?:\s+(?:"[^"]*"|'[^']*'|\([^()]*\)))?$/;

/**
 * What a line belongs to, as the renderer's own reading of the text has it. The renderer says which lines are a
 * block of code, a block of HTML or a table, and it is taken at its word: those are the blocks where a wrong guess
 * would hide what was written. Inside a list or a quote its reading is of text with the indent taken off, which
 * cannot be laid back over the lines; there the lines are read here ("nested").
 */
type Block = "code" | "html" | "table" | "prose" | "nested" | `h${1 | 2}` | "underline";

/**
 * The block each line of the text is in, from line `from` on; null when the renderer's pieces cannot be found in
 * the text, and the lines are then read by this file's own rules.
 */
function blocksOf(lines: readonly string[], from: number): Block[] | null {
	// The renderer is not asked about a text with a line nobody writes: its reading of one can take very long.
	for (let at = from; at < lines.length; at++) if (lines[at]!.length > LONGEST_LINE) return null;
	// Tabs at a line's start as the renderer will make them, so that its pieces are found as it gives them. No line
	// is added or taken away by it, and only lines are counted here.
	const body = lines
		.slice(from)
		.join("\n")
		.replace(/^( *)(\t+)/gm, (_, leading: string, tabs: string) => leading + "    ".repeat(tabs.length));
	if (body.length > LONGEST_LEXED) return null;
	let tokens: { type: string; raw: string; depth?: number }[];
	try {
		// The blocks only: what is inside a paragraph is read here, and the renderer's reading of it is not needed.
		tokens = new marked.Lexer({ gfm: true }).blockTokens(body, []);
	} catch {
		return null;
	}
	const blocks: Block[] = new Array(lines.length).fill("prose");
	/** Where each line of the body starts, to turn a place in it into a line. */
	const starts: number[] = [0];
	for (let i = body.indexOf("\n"); i >= 0; i = body.indexOf("\n", i + 1)) starts.push(i + 1);
	let line = 0;
	let at = 0;
	for (const token of tokens) {
		// A piece is placed where it is found, not where the one before it ended: the renderer takes some lines for
		// itself and gives no piece for them (what a link written by name stands for).
		const found = token.raw ? body.indexOf(token.raw, at) : at;
		if (found < 0) return null;
		const end = found + token.raw.length;
		while (line + 1 < starts.length && starts[line + 1]! <= found) line++;
		// The lines the piece has something on: a line end at its very end only ends its last line.
		const last = token.raw.endsWith("\n") ? end - 1 : end;
		const setext = token.type === "heading" && !/^ {0,3}#/.test(token.raw);
		const under = setext ? found + token.raw.trimEnd().lastIndexOf("\n") + 1 : -1;
		// A piece that starts inside a line leaves that line to the piece before it.
		for (let k = found === starts[line] ? line : line + 1; k < starts.length && starts[k]! < Math.max(last, found + 1); k++) {
			blocks[from + k] =
				token.type === "code" || token.type === "html" || token.type === "table"
					? token.type
					: token.type === "list" || token.type === "blockquote"
						? "nested"
						: setext
							? starts[k]! >= under
								? "underline"
								: (`h${Math.min(token.depth ?? 1, 2)}` as Block)
							: "prose";
		}
		at = end;
	}
	return blocks;
}

/** A fence at a line's start, after any indent and any quote marks: its character, its length, and what follows it on the line. */
function fenceOf(line: string): { ch: string; length: number; rest: string } | null {
	let i = 0;
	while (i < line.length && (line[i] === " " || line[i] === "\t" || line[i] === ">")) i++;
	const ch = line[i];
	if (ch !== "`" && ch !== "~") return null;
	let end = i;
	while (line[end] === ch) end++;
	return end - i >= 3 ? { ch, length: end - i, rest: line.slice(end) } : null;
}

/** How far a line is set in, a tab counting as four. */
function indentOf(line: string): number {
	let width = 0;
	for (const ch of line) {
		if (ch === " ") width++;
		else if (ch === "\t") width += 4;
		else break;
	}
	return width;
}

/** The marks of a whole text, in the order of its lines, and along each line from its start. */
export function liveMarks(text: string): LiveMark[] {
	const out: LiveMark[] = [];
	const lines = text.split(/\r?\n/);
	let at = 0;
	// The lines a document opens with to say things of itself: left as they are written, and marked as such.
	if (lines[0]?.trim() === "---") {
		const close = lines.findIndex((line, index) => index > 0 && (line.trim() === "---" || line.trim() === "..."));
		if (close > 0) {
			for (let index = 0; index <= close; index++) if (lines[index]!.length) out.push({ line: index + 1, start: 1, end: lines[index]!.length + 1, kind: "front" });
			at = close + 1;
		}
	}
	// With no reading from the renderer every line is read here, as a list's are.
	const blocks = blocksOf(lines, at);
	/** Inside a list or a quote: the fence a block of code was opened with, while inside one. */
	let fence: { ch: string; length: number } | null = null;
	/** Inside a list or a quote: the tag of a block of HTML that ends only at its own closing tag. */
	let raw = "";
	/** How far the words of the bullet above are set in: a line set in four more, after a blank line, is code. */
	let bulletIndent = -1;
	/** The line before was blank, or was such code. */
	let afterBlank = true;
	for (; at < lines.length; at++) {
		const line = lines[at]!;
		const n = at + 1;
		const marks: LiveMark[] = [];
		const whole = (kind: LiveKind) => line.length && marks.push({ line: n, start: 1, end: line.length + 1, kind });
		const done = () => out.push(...settled(line, marks));
		const block = blocks ? blocks[at]! : "nested";
		if (block !== "nested") {
			fence = null;
			raw = "";
			bulletIndent = -1;
			afterBlank = true;
		}
		if (block === "code") {
			whole("codeblock");
			done();
			continue;
		}
		// A block of HTML is written for the page as it stands: nothing in it is markup of this kind.
		if (block === "html") continue;
		if (block === "table") {
			whole("table");
			cells(line, 0, n, marks);
			done();
			continue;
		}
		if (block === "h1" || block === "h2") {
			// A heading said by the line under it: its words are drawn as one, and nothing of them is markup.
			whole(block);
			inline(line, 0, line.length, n, marks);
			done();
			continue;
		}
		if (block === "underline") {
			whole("rule");
			done();
			continue;
		}
		if (block === "nested") {
			const fenced = fenceOf(line);
			if (fence) {
				whole("codeblock");
				// Closed by a fence of the same character, at least as long, with nothing after it.
				if (fenced && fenced.ch === fence.ch && fenced.length >= fence.length && !fenced.rest.trim()) fence = null;
				done();
				continue;
			}
			if (raw) {
				if (new RegExp(`</${raw}>`, "i").test(line)) raw = "";
				continue;
			}
			// A fence of backticks has no backtick after it on its line: with one, it is code within a line.
			if (fenced && !(fenced.ch === "`" && fenced.rest.includes("`"))) {
				fence = fenced;
				whole("codeblock");
				done();
				continue;
			}
			if (!line.trim()) {
				afterBlank = true;
				continue;
			}
			const tag = HTML_RAW.exec(line)?.[1];
			if (tag) {
				if (!new RegExp(`</${tag}>`, "i").test(line)) raw = tag;
				continue;
			}
			// Set in four past the bullet's words, after a blank line: code, as the renderer has it.
			if (afterBlank && bulletIndent >= 0 && indentOf(line) >= bulletIndent + 4 && !BULLET.test(line)) {
				whole("codeblock");
				done();
				continue;
			}
			afterBlank = false;
		}
		if (!line.trim()) continue;
		if (RULE.test(line)) {
			whole("rule");
			done();
			continue;
		}
		const heading = HEADING.exec(line);
		if (heading) {
			const from = heading[0].length;
			// The words end before any spaces at the line's end, and before closing #s that a space sets off.
			let to = line.length;
			while (to > from && (line[to - 1] === " " || line[to - 1] === "\t")) to--;
			let hashes = to;
			while (hashes > from && line[hashes - 1] === "#") hashes--;
			const closed = hashes < to && hashes > from && (line[hashes - 1] === " " || line[hashes - 1] === "\t");
			if (closed) {
				to = hashes;
				while (to > from && (line[to - 1] === " " || line[to - 1] === "\t")) to--;
			}
			whole(`h${heading[1]!.length}` as LiveKind);
			// A heading with no words keeps its #s: they are all there is of it.
			if (to > from) {
				marks.push({ line: n, start: 1, end: from + 1, kind: "syntax" });
				if (closed) marks.push({ line: n, start: to + 1, end: line.length + 1, kind: "syntax" });
				inline(line, from, to, n, marks);
			}
			done();
			continue;
		}
		let from = 0;
		const quote = QUOTE.exec(line);
		if (quote) {
			whole("quote");
			marks.push({ line: n, start: 1, end: quote[0].length + 1, kind: "syntax" });
			from = quote[0].length;
		}
		const bullet = BULLET.exec(line.slice(from));
		if (bullet) {
			const mark = from + bullet[1]!.length;
			marks.push({ line: n, start: mark + 1, end: mark + bullet[2]!.length + 1, kind: "bullet" });
			from += bullet[0].length;
			bulletIndent = indentOf(line.slice(0, from).replace(/[^ \t]/g, " "));
			const box = BOX.exec(line.slice(from));
			if (box) {
				marks.push({ line: n, start: from + 1, end: from + 4, kind: "box" });
				// What is ticked is done with: its words are quieter.
				if (box[1] !== " " && line.length > from + 3) marks.push({ line: n, start: from + 4, end: line.length + 1, kind: "done" });
				from += 3;
			}
		}
		// A table inside a list or a quote: each cell by itself, as at the edge.
		const pipe = block === "nested" && /^[ \t]*\|/.test(line.slice(from)) ? line.indexOf("|", from) : -1;
		if (pipe >= 0) {
			marks.push({ line: n, start: pipe + 1, end: line.length + 1, kind: "table" });
			cells(line, pipe, n, marks);
		} else inline(line, from, line.length, n, marks);
		done();
	}
	return out;
}

/**
 * A line's marks, in order along the line, and never hiding the whole of it: when the markup is all the line has
 * that can be seen, it stays in sight.
 */
function settled(line: string, marks: LiveMark[]): LiveMark[] {
	const syntax = marks.filter((mark) => mark.kind === "syntax");
	if (syntax.length) {
		const hidden = new Uint8Array(line.length);
		for (const mark of syntax) hidden.fill(1, mark.start - 1, mark.end - 1);
		let seen = false;
		for (let i = 0; i < line.length && !seen; i++) seen = !hidden[i] && !SPACE.test(line[i]!);
		if (!seen) marks = marks.filter((mark) => mark.kind !== "syntax");
	}
	return marks.sort((a, b) => a.start - b.start || b.end - a.end);
}

/** A table row's cells, each read by itself: a star in one cell has nothing to do with a star in the next. */
function cells(line: string, start: number, n: number, out: LiveMark[]) {
	// With no bar at its start, the row's first cell is from the start.
	let from = /^[ \t]*\|/.test(line.slice(start)) ? line.indexOf("|", start) + 1 : start;
	for (let i = from; i <= line.length; i++) {
		if (line[i] === "\\") {
			i++;
			continue;
		}
		if (i < line.length && line[i] !== "|") continue;
		inline(line, from, i, n, out);
		from = i + 1;
	}
}

/** A run of stars, underscores or tildes: where it is, and whether it can open or close a stretch. `end` shrinks and `start` grows as it is used. */
type Run = { ch: string; start: number; end: number; open: boolean; close: boolean };

/** The marks inside one stretch of a line: code, strong and emphasised words, struck words, links. */
function inline(line: string, from: number, to: number, n: number, out: LiveMark[]) {
	if (to - from > LONGEST_LINE) return;
	const push = (start: number, end: number, kind: LiveKind, href?: string) => end > start && out.push({ line: n, start: start + 1, end: end + 1, kind, ...(href === undefined ? {} : { href }) });
	const runs: Run[] = [];
	/** Where "]]" was last looked for and not found: it is not there further on either. */
	let noDouble = false;
	let i = from;
	while (i < to) {
		const ch = line[i]!;
		if (ch === "\\") {
			i += 2;
			continue;
		}
		if (ch === "`") {
			let run = i;
			while (run < to && line[run] === "`") run++;
			const ticks = run - i;
			// Closed by a run of the same length, and no longer or shorter.
			let close = run;
			let found = -1;
			while (close < to && found < 0) {
				if (line[close] !== "`") {
					close++;
					continue;
				}
				let end = close;
				while (end < to && line[end] === "`") end++;
				if (end - close === ticks) found = close;
				close = end;
			}
			if (found < 0) {
				i = run;
				continue;
			}
			// Code with nothing but spaces in it keeps its ticks: there would be nothing to see.
			if (line.slice(run, found).trim()) {
				push(i, run, "syntax");
				push(run, found, "code");
				push(found, found + ticks, "syntax");
			}
			i = found + ticks;
			continue;
		}
		// A tag, or an address between angle brackets: written for the page as it stands.
		if (ch === "<" && /[A-Za-z/!?]/.test(line[i + 1] ?? "")) {
			const shut = line.indexOf(">", i + 1);
			if (shut > 0 && shut < to) {
				i = shut + 1;
				continue;
			}
		}
		// An address written out: every character of it is the address.
		if ((ch === "h" || ch === "H" || ch === "w" || ch === "W") && (i === from || !WORD.test(line[i - 1]!)) && ADDRESS.test(line.slice(i, i + 8))) {
			while (i < to && !SPACE.test(line[i]!) && line[i] !== "<") i++;
			continue;
		}
		if (ch === "[" || (ch === "!" && line[i + 1] === "[")) {
			const open = ch === "!" ? i + 1 : i;
			// A link between two pairs of brackets, as a notebook writes it: [[where]] or [[where|the words shown]].
			if (ch === "[" && line[i + 1] === "[" && !noDouble) {
				const close = line.indexOf("]]", i + 2);
				if (close < 0 || close + 2 > to) noDouble = true;
				const inner = close < 0 || close + 2 > to ? "" : line.slice(i + 2, close);
				if (inner && !inner.includes("[")) {
					const bar = inner.indexOf("|");
					const words = bar < 0 ? i + 2 : i + 2 + bar + 1;
					// With no words to show it stays as written.
					if (line.slice(words, close).trim()) {
						push(i, words, "syntax");
						push(words, close, "link", (bar < 0 ? inner : inner.slice(0, bar)).trim());
						push(close, close + 2, "syntax");
					}
					i = close + 2;
					continue;
				}
			}
			const shut = bracketEnd(line, open, to);
			const paren = shut > 0 && line[shut + 1] === "(" ? parenEnd(line, shut + 1, to) : -1;
			// Round brackets after square ones are a link's only when an address could stand in them: one with no space.
			if (paren > 0 && DESTINATION.test(line.slice(shut + 2, paren).trim())) {
				// A link with no words (a picture with no description) stays as written: there would be nothing to see.
				if (line.slice(open + 1, shut).trim()) {
					push(i, open + 1, "syntax");
					push(open + 1, shut, "link", line.slice(shut + 2, paren).trim().split(/\s+/)[0] ?? "");
					inline(line, open + 1, shut, n, out);
					push(shut, paren + 1, "syntax");
				}
				i = paren + 1;
				continue;
			}
			i = open + 1;
			continue;
		}
		if (ch === "*" || ch === "_" || ch === "~") {
			let run = i;
			while (run < to && line[run] === ch) run++;
			// The start and the end of the stretch count as space, as the start and the end of a line do.
			const before = i === from ? " " : line[i - 1]!;
			const after = run >= to ? " " : line[run]!;
			// The renderer's own rule for which runs can open and which can close.
			const left = !SPACE.test(after) && (!PUNCTUATION.test(after) || SPACE.test(before) || PUNCTUATION.test(before));
			const right = !SPACE.test(before) && (!PUNCTUATION.test(before) || SPACE.test(after) || PUNCTUATION.test(after));
			const open = ch === "_" ? left && (!right || PUNCTUATION.test(before)) : left;
			const close = ch === "_" ? right && (!left || PUNCTUATION.test(after)) : right;
			// Words are struck by two tildes, no more and no fewer.
			if (ch !== "~" || run - i === 2) runs.push({ ch, start: i, end: run, open, close });
			i = run;
			continue;
		}
		i++;
	}
	pair(runs, push);
}

/**
 * Pairs the runs as the renderer does: each run that can close is matched with the nearest run before it that can
 * open, two characters at a time for strong words and one for emphasised ones. A run that finds no partner is
 * the characters it is.
 */
function pair(runs: Run[], push: (start: number, end: number, kind: LiveKind) => void) {
	for (let c = 0; c < runs.length; c++) {
		const closer = runs[c]!;
		if (!closer.close) continue;
		while (closer.end > closer.start) {
			let o = -1;
			for (let k = c - 1; k >= 0 && k >= c - LOOK_BACK; k--) {
				const run = runs[k]!;
				if (run.ch !== closer.ch || !run.open || run.end <= run.start) continue;
				const opens = run.end - run.start;
				const closes = closer.end - closer.start;
				// A run that could do both is not paired where the lengths would leave a stray mark.
				if (closer.ch !== "~" && (run.close || closer.open) && (opens + closes) % 3 === 0 && (opens % 3 !== 0 || closes % 3 !== 0)) continue;
				o = k;
				break;
			}
			if (o < 0) break;
			const opener = runs[o]!;
			const use = closer.ch === "~" || (opener.end - opener.start >= 2 && closer.end - closer.start >= 2) ? 2 : 1;
			push(opener.end - use, opener.end, "syntax");
			push(opener.end, closer.start, closer.ch === "~" ? "strike" : use === 2 ? "strong" : "em");
			push(closer.start, closer.start + use, "syntax");
			opener.end -= use;
			closer.start += use;
			// What stands between the two and found no partner is text.
			for (let k = o + 1; k < c; k++) runs[k]!.end = runs[k]!.start;
		}
	}
}

/** The "]" that closes the "[" at `open`, brackets inside it counted; -1 when it is not closed before `to`. */
function bracketEnd(line: string, open: number, to: number): number {
	let depth = 0;
	for (let i = open; i < to; i++) {
		if (line[i] === "\\") i++;
		else if (line[i] === "[") depth++;
		else if (line[i] === "]" && --depth === 0) return i;
	}
	return -1;
}

/** The ")" that closes the "(" at `open`, round brackets inside the address counted; -1 when it is not closed before `to`. */
function parenEnd(line: string, open: number, to: number): number {
	let depth = 0;
	for (let i = open; i < to; i++) {
		if (line[i] === "\\") i++;
		else if (line[i] === "(") depth++;
		else if (line[i] === ")" && --depth === 0) return i;
	}
	return -1;
}
