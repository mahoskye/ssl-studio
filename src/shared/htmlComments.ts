// Pure helpers for recognizing and bounding Markdown HTML comments (`<!-- ... -->`)
// so Read mode hides them completely (like CommonMark/HTML rendering) and Live mode
// reveals them only when the cursor touches them (ADR 0028).

export type TextSpan = { from: number; to: number };

/**
 * True when `text` consists exclusively of one or more closed HTML comments
 * (`<!-- ... -->`) plus surrounding whitespace—never matching unclosed comments,
 * blockquoted comments (`> <!-- ...`), or lines with adjacent prose.
 */
export function isStandaloneHtmlComment(text: string): boolean {
	const len = text.length;
	let i = 0;
	// Only horizontal whitespace ([ \t]) is allowed before the first comment.
	while (i < len && (text[i] === " " || text[i] === "\t")) i++;
	let count = 0;
	while (i < len) {
		if (!text.startsWith("<!--", i)) return false;
		const close = text.indexOf("-->", i + 4);
		if (close < 0) return false;
		count++;
		i = close + 3;
		while (i < len && (text[i] === " " || text[i] === "\t" || text[i] === "\r" || text[i] === "\n")) i++;
	}
	return count > 0;
}

/** Returns relative `[from, to]` ranges of every closed `<!-- ... -->` comment inside `text`. */
export function closedHtmlCommentSpans(text: string): TextSpan[] {
	const spans: TextSpan[] = [];
	let pos = 0;
	while (pos < text.length) {
		const open = text.indexOf("<!--", pos);
		if (open < 0) break;
		const close = text.indexOf("-->", open + 4);
		if (close < 0) break;
		const to = close + 3;
		spans.push({ from: open, to });
		pos = to;
	}
	return spans;
}

/**
 * Computes the 1-based inclusive line span to hide for a standalone HTML comment block.
 * - In Live mode (`isRead === false`), only the comment's own lines are hidden so cursor
 *   navigation lands cleanly on the comment line and reveals it.
 * - In Read mode (`isRead === true`), absorbs a duplicate adjacent blank line (or trailing
 *   blank lines around an end-of-file marker such as `<!-- plan ... -->` or `<!-- /catalog -->`)
 *   so hidden metadata comments leave no empty vertical gaps.
 */
export function commentBlockHideLines(
	lines: readonly string[],
	startLine: number,
	endLine: number,
	isRead: boolean,
): { startLine: number; endLine: number } {
	if (!isRead) return { startLine, endLine };
	const prevBlank = startLine > 1 && !lines[startLine - 2]!.trim();
	const nextBlank = endLine < lines.length && !lines[endLine]!.trim();
	let allAfterBlank = true;
	for (let n = endLine + 1; n <= lines.length; n++) {
		if (lines[n - 1]!.trim()) {
			allAfterBlank = false;
			break;
		}
	}
	if (allAfterBlank) {
		return {
			startLine: prevBlank ? startLine - 1 : startLine,
			endLine: lines.length,
		};
	}
	if (nextBlank && (startLine === 1 || prevBlank)) {
		return { startLine, endLine: endLine + 1 };
	}
	return { startLine, endLine };
}
