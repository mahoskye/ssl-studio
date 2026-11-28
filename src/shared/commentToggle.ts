// Turning code into comments and back, for a language whose one form of comment ends at the first close token:
// SSL's `/* … ;`, where the token that ends a comment is the one that ends every statement.
//
// An editor's own "toggle comment" takes such a pair for brackets round the selection. With two statements selected
// it put one opener before the first and one closer after the last: the comment ended at the first statement's
// own `;`, and the second statement was still code, with a stray `;` after it.
//
// Nothing here reads the language. The two tokens are the language configuration's, and where the comments
// already are is the grammar's (`sslCommentSpans`). The rule is only this: text put after an opener is comment up
// to the next close token, whatever it was before, so a new opener is needed after each close token.
//
// The comments made are the ones written by hand in STARLIMS, and the ones the VS Code extension's
// `ssl.toggleComment` makes and takes away, so a file goes between the two editors: `/* statement;`, the
// statement's own `;` ending the comment, and `/* text ;` where the text had no `;` of its own. The space before
// that last `;` is the mark that the `;` was added: taking the comment away takes it away too.

/** The tokens a comment opens and closes with, from the language configuration's `comments.blockComment`. */
export type CommentTokens = { open: string; close: string };
/** A stretch of one line the grammar reads as comment. */
export type Span = { from: number; to: number };
/** A place in the text: a line and a UTF-16 column, both from 0. */
export type Place = { line: number; column: number };
export type TextRange = { start: Place; end: Place };
export type CommentEdit = TextRange & { text: string };
/**
 * One comment: from its first character to just after its close token, or to the end of what the grammar reads
 * as comment where it has none (`closed` false). `opened` is false for a comment that does not begin with the
 * open token: it is another form, which is not made here and not taken away.
 */
export type Comment = TextRange & { closed: boolean; opened: boolean };

const blank = (text: string) => text.trim() === "";
const before = (a: Place, b: Place) => a.line < b.line || (a.line === b.line && a.column < b.column);

/**
 * The comments of a text, each on its own, from the stretches the grammar reads as comment. The grammar says
 * where comment is; that a comment ends at the first close token after its opener says where one ends and the
 * next begins, which matters where two stand end to end.
 */
export function findComments(lines: readonly string[], spans: readonly (readonly Span[])[], tokens: CommentTokens): Comment[] {
	const found: Comment[] = [];
	let open: Comment | null = null;
	lines.forEach((text, line) => {
		let covered = 0;
		for (const span of spans[line] ?? []) {
			// Text the grammar does not read as comment stands between: whatever was open has ended.
			if (open && !blank(text.slice(covered, span.from))) open = null;
			let at = span.from;
			while (at < span.to) {
				if (!open) {
					while (at < span.to && blank(text[at]!)) at++;
					if (at >= span.to) break;
					const opened = text.startsWith(tokens.open, at);
					open = { start: { line, column: at }, end: { line, column: span.to }, closed: false, opened };
					found.push(open);
					if (opened) at += tokens.open.length;
				}
				const close = text.indexOf(tokens.close, at);
				if (close < 0 || close + tokens.close.length > span.to) {
					open.end = { line, column: span.to };
					at = span.to;
				} else {
					open.end = { line, column: close + tokens.close.length };
					open.closed = true;
					open = null;
					at = close + tokens.close.length;
				}
			}
			covered = span.to;
		}
		if (open && !blank(text.slice(covered))) open = null;
	});
	return found;
}

/** The comment a place is in, if any. One with no close token runs to where the grammar's comment ends. */
const commentAt = (comments: readonly Comment[], at: Place) => comments.find((c) => !before(at, c.start) && before(at, c.end));

/** The part of each line a range takes in: `[from, to)` of line `line`. */
function* segments(lines: readonly string[], range: TextRange): Generator<{ line: number; from: number; to: number }> {
	for (let line = range.start.line; line <= range.end.line && line < lines.length; line++) {
		const from = line === range.start.line ? range.start.column : 0;
		const to = line === range.end.line ? Math.min(range.end.column, lines[line]!.length) : lines[line]!.length;
		if (to > from) yield { line, from, to };
	}
}

/** Whether everything written in a range is comment already. False for a range with nothing written in it. */
function allComment(lines: readonly string[], comments: readonly Comment[], range: TextRange): boolean {
	let written = false;
	for (const { line, from, to } of segments(lines, range)) {
		for (let column = from; column < to; column++) {
			if (blank(lines[line]![column]!)) continue;
			written = true;
			if (!commentAt(comments, { line, column })) return false;
		}
	}
	return written;
}

/**
 * The edits that make a range comment. An opener goes before the first thing written, and before the first thing
 * written after each close token, since that token ended the comment before it. Lines with nothing on them are
 * left alone. A range that ends with its last comment still open is closed there with a space and the close
 * token: without that the comment would run on into the lines below, and code that was never selected would stop
 * being code.
 */
function commented(lines: readonly string[], comments: readonly Comment[], tokens: CommentTokens, range: TextRange): CommentEdit[] {
	const edits: CommentEdit[] = [];
	// A range that starts inside a comment is comment until that one closes; an opener there would be its text.
	// One that starts where a comment starts is not inside it: that comment is commented like anything else.
	const around = commentAt(comments, range.start);
	let open = Boolean(around && before(around.start, range.start));
	let ours = false;
	let last: Place | null = null;
	for (const { line, from, to } of segments(lines, range)) {
		const text = lines[line]!;
		let at = from;
		while (at < to) {
			if (!open) {
				while (at < to && blank(text[at]!)) at++;
				if (at >= to) break;
				edits.push({ start: { line, column: at }, end: { line, column: at }, text: `${tokens.open} ` });
				open = true;
				ours = true;
			}
			const close = text.indexOf(tokens.close, at);
			if (close < 0 || close + tokens.close.length > to) {
				// Where the comment's text ends on this line, if any of it is on this line.
				const written = text.slice(0, to).trimEnd().length;
				if (written > at) last = { line, column: written };
				break;
			}
			at = close + tokens.close.length;
			open = false;
			ours = false;
		}
	}
	if (open && ours && last) edits.push({ start: last, end: last, text: ` ${tokens.close}` });
	return edits;
}

/** The whole of a line, with the line break that ends it, or the one before it where it is the last line. */
function wholeLine(lines: readonly string[], line: number): TextRange {
	if (line + 1 < lines.length) return { start: { line, column: 0 }, end: { line: line + 1, column: 0 } };
	if (line === 0) return { start: { line, column: 0 }, end: { line, column: lines[line]!.length } };
	return { start: { line: line - 1, column: lines[line - 1]!.length }, end: { line, column: lines[line]!.length } };
}

/**
 * The edits that take one comment away: its opener with the space after it, and its close token where that was
 * added (a space stands before it). A statement's own `;` stays: `/* x := 1;` is `x := 1;` again.
 *
 * A comment whose opener stands alone on its line, or whose close token does, is a block written round lines
 * with no `;` in them: the line goes with the token, as it came.
 */
function uncommented(lines: readonly string[], tokens: CommentTokens, comment: Comment): CommentEdit[] {
	if (!comment.opened) return [];
	const { start, end } = comment;
	const first = lines[start.line]!;
	const inner = start.column + tokens.open.length;
	const closeAt = end.column - tokens.close.length;
	if (comment.closed && start.line === end.line) {
		// On one line it is one edit: the opener and a close token that was added stand too close for two.
		let text = first.slice(inner, closeAt);
		if (text.startsWith(" ")) text = text.slice(1);
		if (blank(text)) text = "";
		else if (text.endsWith(" ")) text = text.slice(0, -1);
		else text += tokens.close;
		return [{ start, end, text }];
	}
	const edits: CommentEdit[] = [];
	const alone = blank(first.slice(0, start.column)) && blank(first.slice(inner));
	if (alone && end.line > start.line) edits.push({ ...wholeLine(lines, start.line), text: "" });
	else edits.push({ start, end: { line: start.line, column: inner + (first[inner] === " " ? 1 : 0) }, text: "" });
	if (!comment.closed) return edits;
	const lastLine = lines[end.line]!;
	if (!blank(lastLine.slice(end.column))) return edits;
	const lead = lastLine.slice(0, closeAt);
	// The line of an opener that stood alone is gone already; a close token alone on the next line goes with its
	// own line, unless both are the same stretch of text (the last two lines of the file).
	if (blank(lead)) {
		const gone = wholeLine(lines, end.line);
		const taken = edits[0]!;
		if (!before(gone.start, taken.end)) edits.push({ ...gone, text: "" });
		else edits.push({ start: taken.end, end: { line: end.line, column: lastLine.length }, text: "" });
	} else if (lead.endsWith(" ")) edits.push({ start: { line: end.line, column: closeAt - 1 }, end, text: "" });
	return edits;
}

/**
 * The edits that toggle the comments of a range: taken away where everything written in it is comment already,
 * made otherwise. `how` asks for one of the two whatever is there.
 *
 * Taken away are the comments that begin in the range, or, where none does, the one the range lies in: the cursor
 * on any line of a comment takes that comment away. No edits where there is nothing to do.
 */
export function toggleComments(
	lines: readonly string[],
	spans: readonly (readonly Span[])[],
	tokens: CommentTokens,
	range: TextRange,
	how: "toggle" | "comment" | "uncomment" = "toggle",
): CommentEdit[] {
	const comments = findComments(lines, spans, tokens);
	const remove = how === "uncomment" || (how === "toggle" && allComment(lines, comments, range));
	if (!remove) return commented(lines, comments, tokens, range);
	let targets = comments.filter((c) => !before(c.start, range.start) && before(c.start, range.end));
	if (!targets.length) {
		for (const { line, from, to } of segments(lines, range)) {
			const column = from + (lines[line]!.slice(from, to).length - lines[line]!.slice(from, to).trimStart().length);
			const inside = column < to ? commentAt(comments, { line, column }) : undefined;
			if (inside) targets = [inside];
			if (column < to) break;
		}
	}
	return targets.flatMap((comment) => uncommented(lines, tokens, comment));
}

/**
 * A text with edits applied, and where each opener the edits wrote stands in the text that results.
 *
 * For asking the grammar whether those openers are comments there. One written inside a string is not: it is
 * part of the string, the text after it is as much code as it was, and the string has been changed. That happens
 * where a selection starts on a line inside a string that runs over several lines, and only the grammar can say.
 */
export function withEdits(lines: readonly string[], edits: readonly CommentEdit[], tokens: CommentTokens): { lines: string[]; openers: Place[] } {
	const text = lines.join("\n");
	const starts = [0];
	for (let i = 0; i < text.length; i++) if (text[i] === "\n") starts.push(i + 1);
	const offset = (place: Place) => starts[place.line]! + place.column;
	const placed = edits.map((edit) => ({ from: offset(edit.start), to: offset(edit.end), text: edit.text })).sort((a, b) => a.from - b.from || a.to - b.to);
	let out = "";
	let done = 0;
	const written: number[] = [];
	for (const edit of placed) {
		out += text.slice(done, edit.from);
		if (edit.from === edit.to && edit.text.startsWith(tokens.open)) written.push(out.length);
		out += edit.text;
		done = edit.to;
	}
	out += text.slice(done);
	const result = out.split("\n");
	const lineStarts = [0];
	for (let i = 0; i < out.length; i++) if (out[i] === "\n") lineStarts.push(i + 1);
	const openers = written.map((at) => {
		let line = 0;
		while (line + 1 < lineStarts.length && lineStarts[line + 1]! <= at) line++;
		return { line, column: at - lineStarts[line]! };
	});
	return { lines: result, openers };
}

/** The whole lines a selection touches, as a range: a selection that ends at the start of a line does not take that line in. */
export function lineRange(lines: readonly string[], selection: TextRange): TextRange {
	const first = Math.min(selection.start.line, lines.length - 1);
	let last = Math.min(selection.end.line, lines.length - 1);
	if (last > first && selection.end.column === 0) last--;
	return { start: { line: first, column: 0 }, end: { line: last, column: lines[last]!.length } };
}
