// Pure Markdown block diffing (LCS block alignment + inline word-level <del>/<ins>
// highlighting) and deterministic Git commit-message / ticket-changelog helpers.
// Kept free of DOM, SolidJS, and Monaco so tests run directly under Bun.

import { baseName, relativeTo } from "./paths";
import type { TicketGitCommit } from "./protocol";

export type MarkdownBlockKind = "heading" | "paragraph" | "list-item" | "table" | "code" | "callout" | "blockquote" | "hr";
export type MarkdownDiffKind = "same" | "added" | "removed" | "modified";

export type MarkdownBlock = {
	kind: MarkdownBlockKind;
	raw: string;
	normalized: string;
};

export type MarkdownDiffRow = {
	kind: MarkdownDiffKind;
	blockKind: MarkdownBlockKind;
	before?: string;
	after?: string;
	/** Left-pane Markdown (or HTML when `preRendered` is true) annotated with `<del class="md-diff-del">…</del>`. */
	beforeHighlighted?: string;
	/** Right-pane Markdown (or HTML when `preRendered` is true) annotated with `<ins class="md-diff-ins">…</ins>`. */
	afterHighlighted?: string;
	/** True for fenced code blocks whose highlighted output is already safe `<pre><code>` HTML. */
	preRendered?: boolean;
};

export type MarkdownDiffResult = {
	rows: MarkdownDiffRow[];
	stats: { same: number; added: number; removed: number; modified: number };
};

const FENCE_OPEN_RE = /^[ \t]{0,3}(`{3,}|~{3,})([^\n]*)$/;
const ATX_HEADING_RE = /^[ \t]{0,3}(#{1,6})(?:[ \t]+|$)(.*)$/;
const SETEXT_UNDERLINE_RE = /^[ \t]{0,3}(=+|-+)[ \t]*$/;
const HR_RE = /^[ \t]{0,3}([-*_])(?:[ \t]*\1){2,}[ \t]*$/;
const LIST_ITEM_RE = /^([ \t]*)([-*+]|\d+[.)])[ \t]+/;
const BLOCKQUOTE_RE = /^[ \t]{0,3}>/;
const CALLOUT_HEAD_RE = /^([ \t]{0,3}>[ \t]*\[![A-Za-z0-9_-]+\][+-]?[ \t]*)(.*)$/;
const TABLE_SEP_RE = /^[ \t]{0,3}\|?[ \t]*:?-{3,}:?[ \t]*(?:\|[ \t]*:?-{3,}:?[ \t]*)*\|?[ \t]*$/;

const normalizeBlock = (raw: string) =>
	raw
		.split("\n")
		.map((l) => l.replace(/[ \t]+$/, ""))
		.join("\n")
		.trim();

const isFenceOpen = (line: string): { ch: string; len: number; info: string } | null => {
	const m = FENCE_OPEN_RE.exec(line);
	if (!m) return null;
	const ch = m[1]![0]!;
	const info = m[2]!.trim();
	if (ch === "`" && info.includes("`")) return null;
	return { ch, len: m[1]!.length, info };
};

const isTableStart = (lines: readonly string[], i: number): boolean => {
	if (i + 1 >= lines.length) return false;
	const head = lines[i]!;
	const sep = lines[i + 1]!;
	if (!head.includes("|") || !sep.includes("-")) return false;
	if (!TABLE_SEP_RE.test(sep)) return false;
	// Require at least one pipe in the separator or at least two columns in header.
	return sep.includes("|") || head.split("|").length >= 2;
};

/** Segments Markdown text into logical structural blocks for aligned diffing. */
export function segmentMarkdownBlocks(md: string): MarkdownBlock[] {
	const clean = md.replace(/\r\n/g, "\n");
	if (!clean.trim()) return [];
	const lines = clean.split("\n");
	const blocks: MarkdownBlock[] = [];
	const push = (kind: MarkdownBlockKind, rawLines: string[]) => {
		const raw = rawLines.join("\n");
		const normalized = normalizeBlock(raw);
		if (normalized) blocks.push({ kind, raw, normalized });
	};

	let i = 0;
	while (i < lines.length) {
		const line = lines[i]!;
		if (!line.trim()) {
			i++;
			continue;
		}

		// 1. Fenced code block
		const fence = isFenceOpen(line);
		if (fence) {
			const buf = [line];
			i++;
			const closeRe = new RegExp(`^[ \\t]{0,3}${fence.ch}{${fence.len},}[ \\t]*$`);
			while (i < lines.length) {
				buf.push(lines[i]!);
				if (closeRe.test(lines[i]!)) {
					i++;
					break;
				}
				i++;
			}
			push("code", buf);
			continue;
		}

		// 2. ATX heading
		if (ATX_HEADING_RE.test(line)) {
			push("heading", [line]);
			i++;
			continue;
		}

		// 3. Horizontal rule (must check before list items because `---` or `***` could look list-like)
		if (HR_RE.test(line)) {
			push("hr", [line]);
			i++;
			continue;
		}

		// 4. Callout or blockquote
		if (BLOCKQUOTE_RE.test(line)) {
			const buf = [line];
			const isCallout = CALLOUT_HEAD_RE.test(line);
			i++;
			while (i < lines.length && BLOCKQUOTE_RE.test(lines[i]!)) {
				buf.push(lines[i]!);
				i++;
			}
			push(isCallout ? "callout" : "blockquote", buf);
			continue;
		}

		// 5. Pipe table
		if (isTableStart(lines, i)) {
			const buf = [line, lines[i + 1]!];
			i += 2;
			while (i < lines.length && lines[i]!.trim() && lines[i]!.includes("|")) {
				buf.push(lines[i]!);
				i++;
			}
			push("table", buf);
			continue;
		}

		// 6. List item (individual item + any indented continuation/sub-items)
		const listMatch = LIST_ITEM_RE.exec(line);
		if (listMatch) {
			const baseIndent = listMatch[1]!.replace(/\t/g, "    ").length;
			const buf = [line];
			i++;
			while (i < lines.length) {
				const next = lines[i]!;
				if (!next.trim()) break;
				const nextList = LIST_ITEM_RE.exec(next);
				const nextIndent = (next.match(/^[ \t]*/)![0] ?? "").replace(/\t/g, "    ").length;
				if (nextList && nextIndent <= baseIndent) break;
				if (!nextList && nextIndent <= baseIndent && (isFenceOpen(next) || ATX_HEADING_RE.test(next) || BLOCKQUOTE_RE.test(next) || HR_RE.test(next) || isTableStart(lines, i))) {
					break;
				}
				buf.push(next);
				i++;
			}
			push("list-item", buf);
			continue;
		}

		// 7. Setext heading (`Title\n===`)
		if (i + 1 < lines.length && SETEXT_UNDERLINE_RE.test(lines[i + 1]!) && !HR_RE.test(line)) {
			push("heading", [line, lines[i + 1]!]);
			i += 2;
			continue;
		}

		// 8. Paragraph
		const buf = [line];
		i++;
		while (i < lines.length) {
			const next = lines[i]!;
			if (!next.trim()) break;
			if (isFenceOpen(next) || ATX_HEADING_RE.test(next) || BLOCKQUOTE_RE.test(next) || HR_RE.test(next) || LIST_ITEM_RE.test(next) || isTableStart(lines, i)) {
				break;
			}
			buf.push(next);
			i++;
		}
		push("paragraph", buf);
	}
	return blocks;
}

/** Exact LCS index pairs for two string arrays, with common-prefix/suffix trimming and size guard. */
function lcsAnchors(a: readonly string[], b: readonly string[], maxCells = 200_000): [number, number][] {
	let start = 0;
	let endA = a.length;
	let endB = b.length;
	const prefix: [number, number][] = [];
	const suffix: [number, number][] = [];

	while (start < endA && start < endB && a[start] === b[start]) {
		prefix.push([start, start]);
		start++;
	}
	while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
		endA--;
		endB--;
		suffix.push([endA, endB]);
	}
	suffix.reverse();

	const m = endA - start;
	const n = endB - start;
	if (m === 0 || n === 0) return [...prefix, ...suffix];

	if (m * n > maxCells) {
		// Fast linear fallback on very large documents: match unique items in order.
		const posB = new Map<string, number[]>();
		for (let j = 0; j < n; j++) {
			const val = b[start + j]!;
			const list = posB.get(val);
			if (list) list.push(j);
			else posB.set(val, [j]);
		}
		const mid: [number, number][] = [];
		let lastJ = -1;
		for (let i = 0; i < m; i++) {
			const list = posB.get(a[start + i]!);
			if (!list) continue;
			const nextJ = list.find((j) => j > lastJ);
			if (nextJ !== undefined) {
				mid.push([start + i, start + nextJ]);
				lastJ = nextJ;
			}
		}
		return [...prefix, ...mid, ...suffix];
	}

	const width = n + 1;
	const dp = new Uint32Array((m + 1) * width);
	for (let i = m - 1; i >= 0; i--) {
		const ai = a[start + i]!;
		const row = i * width;
		const nextRow = (i + 1) * width;
		for (let j = n - 1; j >= 0; j--) {
			if (ai === b[start + j]) dp[row + j] = dp[nextRow + j + 1]! + 1;
			else dp[row + j] = Math.max(dp[nextRow + j]!, dp[row + j + 1]!);
		}
	}

	const mid: [number, number][] = [];
	let i = 0;
	let j = 0;
	while (i < m && j < n) {
		if (a[start + i] === b[start + j]) {
			mid.push([start + i, start + j]);
			i++;
			j++;
		} else if (dp[(i + 1) * width + j]! >= dp[i * width + j + 1]!) {
			i++;
		} else {
			j++;
		}
	}
	return [...prefix, ...mid, ...suffix];
}

function escapeHtml(text: string): string {
	return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

const WORD_TOKEN_RE = /`[^`\n]+`|!?\[[^\]]*\]\([^)]*\)|\*\*|__|~~|\s+|[A-Za-z0-9_'-]+|[^\sA-Za-z0-9_'-]/g;

function tokenizeInline(text: string): string[] {
	return text.match(WORD_TOKEN_RE) ?? [];
}

function wordSet(text: string): Set<string> {
	const words = text.toLowerCase().match(/[a-z0-9_]+/g);
	return new Set(words ?? []);
}

function tokenSimilarity(a: string, b: string): number {
	const sa = wordSet(a);
	const sb = wordSet(b);
	if (!sa.size && !sb.size) return 1;
	if (!sa.size || !sb.size) return 0;
	let inter = 0;
	for (const w of sa) if (sb.has(w)) inter++;
	return (2 * inter) / (sa.size + sb.size);
}

/** Wraps a contiguous changed slice in `<del>` or `<ins>`, keeping outer whitespace outside the tag when possible. */
function wrapDiffSpan(tokens: readonly string[], tag: "del" | "ins", cls: string): string {
	if (!tokens.length) return "";
	let first = 0;
	let last = tokens.length - 1;
	while (first <= last && /^\s+$/.test(tokens[first]!)) first++;
	while (last >= first && /^\s+$/.test(tokens[last]!)) last--;
	if (first > last) {
		// Pure whitespace change: leave unadorned so Markdown structure doesn't break.
		return tokens.join("");
	}
	const lead = tokens.slice(0, first).join("");
	const core = tokens.slice(first, last + 1).join("");
	const tail = tokens.slice(last + 1).join("");
	return `${lead}<${tag} class="${cls}">${core}</${tag}>${tail}`;
}

/** Computes word-level `<del class="md-diff-del">` / `<ins class="md-diff-ins">` annotated strings for two texts. */
export function diffInlineWords(beforeText: string, afterText: string): { before: string; after: string } {
	if (beforeText === afterText) return { before: beforeText, after: afterText };
	const a = tokenizeInline(beforeText);
	const b = tokenizeInline(afterText);
	const anchors = lcsAnchors(a, b, 80_000);

	const outA: string[] = [];
	const outB: string[] = [];
	let ai = 0;
	let bi = 0;

	const flushGap = (nextA: number, nextB: number) => {
		if (nextA > ai) outA.push(wrapDiffSpan(a.slice(ai, nextA), "del", "md-diff-del"));
		if (nextB > bi) outB.push(wrapDiffSpan(b.slice(bi, nextB), "ins", "md-diff-ins"));
	};

	for (const [ma, mb] of anchors) {
		flushGap(ma, mb);
		outA.push(a[ma]!);
		outB.push(b[mb]!);
		ai = ma + 1;
		bi = mb + 1;
	}
	flushGap(a.length, b.length);
	return { before: outA.join(""), after: outB.join("") };
}

function diffHeading(beforeRaw: string, afterRaw: string): { before: string; after: string } {
	const ma = ATX_HEADING_RE.exec(beforeRaw);
	const mb = ATX_HEADING_RE.exec(afterRaw);
	if (ma && mb) {
		const prefixA = `${ma[1]} `;
		const prefixB = `${mb[1]} `;
		const inner = diffInlineWords(ma[2] ?? "", mb[2] ?? "");
		return { before: `${prefixA}${inner.before}`, after: `${prefixB}${inner.after}` };
	}
	const aLines = beforeRaw.split("\n");
	const bLines = afterRaw.split("\n");
	if (aLines.length === 2 && bLines.length === 2 && SETEXT_UNDERLINE_RE.test(aLines[1]!) && SETEXT_UNDERLINE_RE.test(bLines[1]!)) {
		const inner = diffInlineWords(aLines[0]!, bLines[0]!);
		return { before: `${inner.before}\n${aLines[1]}`, after: `${inner.after}\n${bLines[1]}` };
	}
	return diffInlineWords(beforeRaw, afterRaw);
}

const LIST_PREFIX_RE = /^([ \t]*(?:[-*+]|\d+[.)])[ \t]+(?:\[[ xX]\][ \t]+)?)([\s\S]*)$/;

function diffListItem(beforeRaw: string, afterRaw: string): { before: string; after: string } {
	const ma = LIST_PREFIX_RE.exec(beforeRaw);
	const mb = LIST_PREFIX_RE.exec(afterRaw);
	if (ma && mb) {
		const inner = diffInlineWords(ma[2] ?? "", mb[2] ?? "");
		return { before: `${ma[1]}${inner.before}`, after: `${mb[1]}${inner.after}` };
	}
	return diffInlineWords(beforeRaw, afterRaw);
}

function diffQuoteLines(beforeRaw: string, afterRaw: string): { before: string; after: string } {
	const aLines = beforeRaw.split("\n");
	const bLines = afterRaw.split("\n");
	const stripQuote = (l: string) => {
		const call = CALLOUT_HEAD_RE.exec(l);
		if (call) return { prefix: call[1]!, body: call[2]! };
		const m = /^([ \t]{0,3}>[ \t]?)(.*)$/.exec(l);
		return m ? { prefix: m[1]!, body: m[2]! } : { prefix: "", body: l };
	};
	const aParts = aLines.map(stripQuote);
	const bParts = bLines.map(stripQuote);
	const max = Math.max(aParts.length, bParts.length);
	const outA: string[] = [];
	const outB: string[] = [];
	for (let i = 0; i < max; i++) {
		const pa = aParts[i];
		const pb = bParts[i];
		if (pa && pb) {
			const d = diffInlineWords(pa.body, pb.body);
			outA.push(`${pa.prefix}${d.before}`);
			outB.push(`${pb.prefix}${d.after}`);
		} else if (pa) {
			outA.push(`${pa.prefix}${pa.body.trim() ? `<del class="md-diff-del">${pa.body}</del>` : pa.body}`);
		} else if (pb) {
			outB.push(`${pb.prefix}${pb.body.trim() ? `<ins class="md-diff-ins">${pb.body}</ins>` : pb.body}`);
		}
	}
	return { before: outA.join("\n"), after: outB.join("\n") };
}

function splitTableRow(row: string): string[] {
	const trimmed = row.trim().replace(/^\|/, "").replace(/\|$/, "");
	return trimmed.split("|").map((c) => c.trim());
}

function formatTableRow(cells: readonly string[]): string {
	return `| ${cells.join(" | ")} |`;
}

function diffTable(beforeRaw: string, afterRaw: string): { before: string; after: string } {
	const aLines = beforeRaw.split("\n");
	const bLines = afterRaw.split("\n");
	if (aLines.length < 2 || bLines.length < 2) return diffInlineWords(beforeRaw, afterRaw);

	const outA: string[] = [];
	const outB: string[] = [];

	// Diff header row cell by cell.
	const aHead = splitTableRow(aLines[0]!);
	const bHead = splitTableRow(bLines[0]!);
	if (aHead.length === bHead.length) {
		const hA: string[] = [];
		const hB: string[] = [];
		for (let c = 0; c < aHead.length; c++) {
			const d = diffInlineWords(aHead[c]!, bHead[c]!);
			hA.push(d.before);
			hB.push(d.after);
		}
		outA.push(formatTableRow(hA), aLines[1]!);
		outB.push(formatTableRow(hB), bLines[1]!);
	} else {
		outA.push(aLines[0]!, aLines[1]!);
		outB.push(bLines[0]!, bLines[1]!);
	}

	const aBody = aLines.slice(2);
	const bBody = bLines.slice(2);
	const anchors = lcsAnchors(aBody, bBody, 20_000);
	let ai = 0;
	let bi = 0;

	const emitGap = (nextA: number, nextB: number) => {
		const countA = nextA - ai;
		const countB = nextB - bi;
		const paired = Math.min(countA, countB);
		for (let k = 0; k < paired; k++) {
			const ra = splitTableRow(aBody[ai + k]!);
			const rb = splitTableRow(bBody[bi + k]!);
			if (ra.length === rb.length) {
				const cA: string[] = [];
				const cB: string[] = [];
				for (let c = 0; c < ra.length; c++) {
					const d = diffInlineWords(ra[c]!, rb[c]!);
					cA.push(d.before);
					cB.push(d.after);
				}
				outA.push(formatTableRow(cA));
				outB.push(formatTableRow(cB));
			} else {
				outA.push(formatTableRow(ra.map((cell) => (cell ? `<del class="md-diff-del">${cell}</del>` : ""))));
				outB.push(formatTableRow(rb.map((cell) => (cell ? `<ins class="md-diff-ins">${cell}</ins>` : ""))));
			}
		}
		for (let k = paired; k < countA; k++) {
			const ra = splitTableRow(aBody[ai + k]!);
			outA.push(formatTableRow(ra.map((cell) => (cell ? `<del class="md-diff-del">${cell}</del>` : ""))));
		}
		for (let k = paired; k < countB; k++) {
			const rb = splitTableRow(bBody[bi + k]!);
			outB.push(formatTableRow(rb.map((cell) => (cell ? `<ins class="md-diff-ins">${cell}</ins>` : ""))));
		}
	};

	for (const [ma, mb] of anchors) {
		emitGap(ma, mb);
		outA.push(aBody[ma]!);
		outB.push(bBody[mb]!);
		ai = ma + 1;
		bi = mb + 1;
	}
	emitGap(aBody.length, bBody.length);
	return { before: outA.join("\n"), after: outB.join("\n") };
}

function unpackFence(raw: string): { lang: string; bodyLines: string[] } {
	const lines = raw.split("\n");
	const open = isFenceOpen(lines[0] ?? "");
	if (!open) return { lang: "", bodyLines: lines };
	const lang = (open.info.split(/\s+/)[0] ?? "").replace(/[^A-Za-z0-9_+-]/g, "");
	const closeRe = new RegExp(`^[ \\t]{0,3}${open.ch}{${open.len},}[ \\t]*$`);
	const hasClose = lines.length > 1 && closeRe.test(lines[lines.length - 1]!);
	return { lang, bodyLines: lines.slice(1, hasClose ? -1 : undefined) };
}

function diffEscapedCodeLine(aLine: string, bLine: string): { before: string; after: string } {
	const tokRe = /\s+|[A-Za-z0-9_]+|[^\sA-Za-z0-9_]/g;
	const a = aLine.match(tokRe) ?? [];
	const b = bLine.match(tokRe) ?? [];
	const anchors = lcsAnchors(a, b, 20_000);
	const outA: string[] = [];
	const outB: string[] = [];
	let ai = 0;
	let bi = 0;
	const flush = (na: number, nb: number) => {
		if (na > ai) {
			const chunk = a.slice(ai, na).map(escapeHtml);
			outA.push(wrapDiffSpan(chunk, "del", "md-diff-del"));
		}
		if (nb > bi) {
			const chunk = b.slice(bi, nb).map(escapeHtml);
			outB.push(wrapDiffSpan(chunk, "ins", "md-diff-ins"));
		}
	};
	for (const [ma, mb] of anchors) {
		flush(ma, mb);
		outA.push(escapeHtml(a[ma]!));
		outB.push(escapeHtml(b[mb]!));
		ai = ma + 1;
		bi = mb + 1;
	}
	flush(a.length, b.length);
	return { before: outA.join(""), after: outB.join("") };
}

function diffCodeBlockHtml(beforeRaw: string, afterRaw: string): { before: string; after: string } {
	const a = unpackFence(beforeRaw);
	const b = unpackFence(afterRaw);
	const anchors = lcsAnchors(a.bodyLines, b.bodyLines, 30_000);
	const outA: string[] = [];
	const outB: string[] = [];
	let ai = 0;
	let bi = 0;
	const flush = (na: number, nb: number) => {
		const countA = na - ai;
		const countB = nb - bi;
		const paired = Math.min(countA, countB);
		for (let k = 0; k < paired; k++) {
			const d = diffEscapedCodeLine(a.bodyLines[ai + k]!, b.bodyLines[bi + k]!);
			outA.push(d.before);
			outB.push(d.after);
		}
		for (let k = paired; k < countA; k++) {
			const line = escapeHtml(a.bodyLines[ai + k]!);
			outA.push(line ? `<del class="md-diff-del">${line}</del>` : "");
		}
		for (let k = paired; k < countB; k++) {
			const line = escapeHtml(b.bodyLines[bi + k]!);
			outB.push(line ? `<ins class="md-diff-ins">${line}</ins>` : "");
		}
	};
	for (const [ma, mb] of anchors) {
		flush(ma, mb);
		outA.push(escapeHtml(a.bodyLines[ma]!));
		outB.push(escapeHtml(b.bodyLines[mb]!));
		ai = ma + 1;
		bi = mb + 1;
	}
	flush(a.bodyLines.length, b.bodyLines.length);
	const clsA = a.lang ? ` class="language-${a.lang}"` : "";
	const clsB = b.lang ? ` class="language-${b.lang}"` : "";
	return {
		before: `<pre><code${clsA}>${outA.join("\n")}</code></pre>`,
		after: `<pre><code${clsB}>${outB.join("\n")}</code></pre>`,
	};
}

function highlightModifiedBlock(before: MarkdownBlock, after: MarkdownBlock): Pick<MarkdownDiffRow, "beforeHighlighted" | "afterHighlighted" | "preRendered"> {
	if (before.kind === "code" && after.kind === "code") {
		const html = diffCodeBlockHtml(before.raw, after.raw);
		return { beforeHighlighted: html.before, afterHighlighted: html.after, preRendered: true };
	}
	if (before.kind === "heading" && after.kind === "heading") {
		const d = diffHeading(before.raw, after.raw);
		return { beforeHighlighted: d.before, afterHighlighted: d.after };
	}
	if (before.kind === "list-item" && after.kind === "list-item") {
		const d = diffListItem(before.raw, after.raw);
		return { beforeHighlighted: d.before, afterHighlighted: d.after };
	}
	if ((before.kind === "callout" || before.kind === "blockquote") && (after.kind === "callout" || after.kind === "blockquote")) {
		const d = diffQuoteLines(before.raw, after.raw);
		return { beforeHighlighted: d.before, afterHighlighted: d.after };
	}
	if (before.kind === "table" && after.kind === "table") {
		const d = diffTable(before.raw, after.raw);
		return { beforeHighlighted: d.before, afterHighlighted: d.after };
	}
	const d = diffInlineWords(before.raw, after.raw);
	return { beforeHighlighted: d.before, afterHighlighted: d.after };
}

const areCompatible = (a: MarkdownBlock, b: MarkdownBlock) =>
	a.kind === b.kind ||
	((a.kind === "callout" || a.kind === "blockquote") && (b.kind === "callout" || b.kind === "blockquote"));

/**
 * Segments two Markdown documents into logical blocks, aligns them via LCS, classifies each row
 * as `same | added | removed | modified`, and computes inline `<del class="md-diff-del">` /
 * `<ins class="md-diff-ins">` highlights for modified blocks.
 */
export function diffMarkdownBlocks(beforeMd: string, afterMd: string): MarkdownDiffResult {
	const aBlocks = segmentMarkdownBlocks(beforeMd);
	const bBlocks = segmentMarkdownBlocks(afterMd);
	const anchors = lcsAnchors(
		aBlocks.map((b) => b.normalized),
		bBlocks.map((b) => b.normalized),
	);

	const rows: MarkdownDiffRow[] = [];
	const stats = { same: 0, added: 0, removed: 0, modified: 0 };

	const emitGap = (aFrom: number, aTo: number, bFrom: number, bTo: number) => {
		const left = aBlocks.slice(aFrom, aTo);
		const right = bBlocks.slice(bFrom, bTo);
		if (!left.length && !right.length) return;
		if (!left.length) {
			for (const b of right) {
				rows.push({ kind: "added", blockKind: b.kind, after: b.raw });
				stats.added++;
			}
			return;
		}
		if (!right.length) {
			for (const a of left) {
				rows.push({ kind: "removed", blockKind: a.kind, before: a.raw });
				stats.removed++;
			}
			return;
		}

		// Single-block replacement of compatible kind is always paired as modified.
		if (left.length === 1 && right.length === 1 && areCompatible(left[0]!, right[0]!)) {
			const hl = highlightModifiedBlock(left[0]!, right[0]!);
			rows.push({ kind: "modified", blockKind: right[0]!.kind, before: left[0]!.raw, after: right[0]!.raw, ...hl });
			stats.modified++;
			return;
		}

		// Monotonic greedy pairing by kind compatibility + token similarity.
		const pairs: [number, number][] = [];
		let rCursor = 0;
		for (let li = 0; li < left.length; li++) {
			let bestRi = -1;
			let bestScore = 0.25;
			for (let ri = rCursor; ri < right.length; ri++) {
				if (!areCompatible(left[li]!, right[ri]!)) continue;
				const score = tokenSimilarity(left[li]!.raw, right[ri]!.raw);
				if (score >= bestScore) {
					bestScore = score;
					bestRi = ri;
				}
			}
			if (bestRi >= 0) {
				pairs.push([li, bestRi]);
				rCursor = bestRi + 1;
			}
		}

		let lPos = 0;
		let rPos = 0;
		for (const [li, ri] of pairs) {
			while (lPos < li) {
				rows.push({ kind: "removed", blockKind: left[lPos]!.kind, before: left[lPos]!.raw });
				stats.removed++;
				lPos++;
			}
			while (rPos < ri) {
				rows.push({ kind: "added", blockKind: right[rPos]!.kind, after: right[rPos]!.raw });
				stats.added++;
				rPos++;
			}
			const hl = highlightModifiedBlock(left[li]!, right[ri]!);
			rows.push({ kind: "modified", blockKind: right[ri]!.kind, before: left[li]!.raw, after: right[ri]!.raw, ...hl });
			stats.modified++;
			lPos = li + 1;
			rPos = ri + 1;
		}
		while (lPos < left.length) {
			rows.push({ kind: "removed", blockKind: left[lPos]!.kind, before: left[lPos]!.raw });
			stats.removed++;
			lPos++;
		}
		while (rPos < right.length) {
			rows.push({ kind: "added", blockKind: right[rPos]!.kind, after: right[rPos]!.raw });
			stats.added++;
			rPos++;
		}
	};

	let ai = 0;
	let bi = 0;
	for (const [ma, mb] of anchors) {
		emitGap(ai, ma, bi, mb);
		rows.push({ kind: "same", blockKind: bBlocks[mb]!.kind, before: aBlocks[ma]!.raw, after: bBlocks[mb]!.raw });
		stats.same++;
		ai = ma + 1;
		bi = mb + 1;
	}
	emitGap(ai, aBlocks.length, bi, bBlocks.length);

	return { rows, stats };
}

// --- Deterministic Git Commit-Message & Ticket Changelog Helpers -------------

export type StagedChangeLike = {
	path: string;
	staged: string | null;
};

type FileGroupKind = "ssl" | "sql" | "plan" | "spec" | "ticket" | "decision" | "question" | "registry" | "schema" | "doc" | "other";

function classifyStagedFile(rel: string): FileGroupKind {
	const norm = rel.replace(/\\/g, "/").toLowerCase();
	if (norm.endsWith(".plan.json")) return "plan";
	if (norm.endsWith(".spec.md") || /(^|\/)specs\//.test(norm)) return "spec";
	if (/(^|\/)tickets\//.test(norm)) return "ticket";
	if (/(^|\/)decisions\//.test(norm)) return "decision";
	if (/(^|\/)questions\//.test(norm)) return "question";
	if (/(^|\/)registries\/.+\.(csv|tsv)$/.test(norm)) return "registry";
	if (/\.(ssl|srvscr|ds)$/.test(norm)) return "ssl";
	if (/\.(sql|ddl|pks|pkb)$/.test(norm)) return "sql";
	if (/(^|\/)schema\//.test(norm)) return "schema";
	if (/\.(md|markdown)$/.test(norm)) return "doc";
	return "other";
}

const GROUP_LABELS: Record<FileGroupKind, [one: string, many: string]> = {
	ssl: ["SSL script", "SSL scripts"],
	sql: ["SQL file", "SQL files"],
	plan: ["plan", "plans"],
	spec: ["spec", "specs"],
	ticket: ["ticket doc", "ticket docs"],
	decision: ["decision ADR", "decision ADRs"],
	question: ["question doc", "question docs"],
	registry: ["registry", "registries"],
	schema: ["schema doc", "schema docs"],
	doc: ["doc", "docs"],
	other: ["file", "files"],
};

const GROUP_ORDER: readonly FileGroupKind[] = ["ssl", "sql", "plan", "spec", "schema", "registry", "decision", "question", "ticket", "doc", "other"];

function joinList(items: readonly string[]): string {
	if (items.length <= 1) return items[0] ?? "";
	if (items.length === 2) return `${items[0]} and ${items[1]}`;
	return `${items.slice(0, -1).join(", ")}, and ${items[items.length - 1]}`;
}

/**
 * Deterministically drafts a crisp `<TICKET>: <concise summary of staged changes>` commit message
 * from staged file groups and an optional active ticket key / title.
 */
export function draftCommitMessage(input: {
	staged: readonly StagedChangeLike[];
	root?: string;
	ticketKey?: string;
	ticketTitle?: string;
}): string {
	const files = input.staged.filter((f) => Boolean(f.staged));
	if (!files.length) return "";

	const statuses = new Set(files.map((f) => f.staged));
	const verb =
		statuses.size === 1 && statuses.has("added")
			? "Add"
			: statuses.size === 1 && statuses.has("deleted")
				? "Remove"
				: statuses.size === 1 && statuses.has("renamed")
					? "Rename"
					: "Update";

	const grouped = new Map<FileGroupKind, string[]>();
	for (const f of files) {
		const rel = input.root ? relativeTo(input.root, f.path).replace(/\\/g, "/") : f.path.replace(/\\/g, "/");
		const kind = classifyStagedFile(rel);
		const list = grouped.get(kind);
		if (list) list.push(rel);
		else grouped.set(kind, [rel]);
	}

	const orderedKinds = GROUP_ORDER.filter((k) => grouped.has(k));
	let summary: string;
	if (files.length === 1) {
		const only = files[0]!;
		const name = baseName(only.path);
		const kind = orderedKinds[0]!;
		if (kind === "spec") summary = `${verb} ${name} spec`;
		else if (kind === "decision") summary = `${verb} decision ${name}`;
		else summary = `${verb} ${name}`;
	} else {
		const clauses = orderedKinds.map((kind) => {
			const list = grouped.get(kind)!;
			if (list.length === 1 && orderedKinds.length <= 2 && (kind === "ssl" || kind === "sql" || kind === "registry")) {
				return baseName(list[0]!);
			}
			const [one, many] = GROUP_LABELS[kind];
			return list.length === 1 ? (kind === "ssl" || kind === "sql" ? `1 ${one}` : one) : `${list.length} ${many}`;
		});
		const shown = clauses.slice(0, 3);
		if (clauses.length > 3) shown.push(`${clauses.length - 3} more areas`);
		summary = `${verb} ${joinList(shown)}`;
	}

	const key = input.ticketKey?.trim() ?? "";
	const prefix = key ? `${key}: ` : "";
	const rawTitle = input.ticketTitle?.replace(/\s+/g, " ").trim() ?? "";
	let line = `${prefix}${summary}`;
	if (rawTitle) {
		const withTitle = `${line} (${rawTitle})`;
		if (withTitle.length <= 78) {
			line = withTitle;
		} else {
			const room = 78 - line.length - 4; // ` (…)`
			if (room >= 14) {
				line = `${line} (${rawTitle.slice(0, room - 1).trimEnd()}…)`;
			}
		}
	}
	return line;
}

/** Formats local commits mentioning a ticket into a clean Markdown bullet-list changelog. */
export function formatTicketChangelog(
	ticketKey: string,
	commits: readonly TicketGitCommit[],
	options?: { title?: string; maxFilesPerCommit?: number },
): string {
	if (!commits.length) return "";
	const key = ticketKey.trim();
	const heading = options?.title?.trim() ? `### ${key} — ${options.title.trim()}` : `### ${key} Changelog`;
	const maxFiles = Math.max(1, options?.maxFilesPerCommit ?? 4);
	const bullets = commits.map((c) => {
		const date = c.time > 0 && !Number.isNaN(new Date(c.time).getTime()) ? new Date(c.time).toISOString().slice(0, 10) : "";
		const datePart = date ? ` (${date})` : "";
		const shownFiles = c.files.slice(0, maxFiles).map((f) => `\`${f.path}\``);
		const extra = c.files.length > maxFiles ? ` +${c.files.length - maxFiles} more` : "";
		const filesPart = shownFiles.length ? ` — ${shownFiles.join(", ")}${extra}` : "";
		return `- \`${c.shortSha}\`${datePart} ${c.subject.trim()}${filesPart}`;
	});
	return `${heading}\n\n${bullets.join("\n")}\n`;
}
