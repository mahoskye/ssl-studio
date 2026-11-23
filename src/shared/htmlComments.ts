// Pure helpers for recognizing and bounding Markdown HTML comments (`<!-- ... -->`)
// so Read mode hides them completely (like CommonMark/HTML rendering) and Live mode
// reveals them only when the cursor touches them (ADR 0028).

export type TextSpan = { from: number; to: number };

const CLOSED_HTML_COMMENT_RE = /<!--[\s\S]*?-->/g;
const STANDALONE_HTML_COMMENTS_RE = /^[ \t]*(?:<!--[\s\S]*?-->[\t \r\n]*)+$/;

/**
 * True when `text` consists exclusively of one or more closed HTML comments
 * (`<!-- ... -->`) plus surrounding whitespace—never matching unclosed comments,
 * blockquoted comments (`> <!-- ...`), or lines with adjacent prose.
 */
export function isStandaloneHtmlComment(text: string): boolean {
	return STANDALONE_HTML_COMMENTS_RE.test(text);
}

/** Returns relative `[from, to]` ranges of every closed `<!-- ... -->` comment inside `text`. */
export function closedHtmlCommentSpans(text: string): TextSpan[] {
	const spans: TextSpan[] = [];
	CLOSED_HTML_COMMENT_RE.lastIndex = 0;
	let match: RegExpExecArray | null;
	while ((match = CLOSED_HTML_COMMENT_RE.exec(text))) {
		spans.push({ from: match.index, to: match.index + match[0].length });
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
