// Search results by line: a line with two matches is one row with both
// marked, not two rows that read the same. Pure, so it can be tested.
import type { SearchHit } from "../../shared/protocol";

export type LineHit = { path: string; line: number; text: string; matches: { column: number; length: number }[] };

/** One entry for each line, in the order the hits came, with that line's matches from left to right. */
export function byLine(hits: SearchHit[]): LineHit[] {
	const lines = new Map<string, LineHit>();
	for (const hit of hits) {
		const key = `${hit.path}\n${hit.line}`;
		const line = lines.get(key) ?? { path: hit.path, line: hit.line, text: hit.text, matches: [] };
		line.matches.push({ column: hit.column, length: hit.length });
		lines.set(key, line);
	}
	for (const line of lines.values()) line.matches.sort((a, b) => a.column - b.column);
	return [...lines.values()];
}

export type Segment = { text: string; match: boolean };

/**
 * A line cut to what a row can show: a little before the first match, every
 * match marked, and some of what follows the last. Indentation is dropped,
 * and "…" stands for text cut from the front.
 */
export function segments(line: LineHit, before = 30, after = 80): Segment[] {
	const first = line.matches[0];
	if (!first) return [{ text: line.text.trim(), match: false }];
	const out: Segment[] = [];
	const start = Math.max(0, first.column - 1 - before);
	let at = start;
	for (const m of line.matches) {
		const from = m.column - 1;
		// A match inside the one before it is already marked.
		if (from < at || m.length <= 0) continue;
		if (from > at) out.push({ text: line.text.slice(at, from), match: false });
		out.push({ text: line.text.slice(from, from + m.length), match: true });
		at = from + m.length;
	}
	if (at < line.text.length) out.push({ text: line.text.slice(at, at + after), match: false });
	const lead = out[0];
	if (lead && !lead.match) {
		lead.text = (start > 0 ? "…" : "") + lead.text.trimStart();
		if (!lead.text) out.shift();
	} else if (start > 0) out.unshift({ text: "…", match: false });
	return out;
}
