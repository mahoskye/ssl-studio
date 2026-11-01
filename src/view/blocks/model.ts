// The blocks view's tree, built from what the language server already
// gives: document symbols (comment regions, procedures and their
// parameters) and folding ranges (control flow, comments, :REGION text).
// No SSL is parsed here (ADR 0003). When the server offers a syntax tree
// (L1 in docs/LSP-REQUESTS.md) it replaces these two sources.
//
// Everything is line ranges, 1-based and inclusive. The tree covers the
// file exactly: every line belongs to one leaf, in order (ADR 0002).

export type SymbolIn = { name: string; kind: number; startLine: number; endLine: number; children?: SymbolIn[] };
export type FoldIn = { startLine: number; endLine: number; kind?: string };

export type NodeKind = "file" | "region" | "procedure" | "block" | "comment" | "text" | "blank";
export type Node = {
	kind: NodeKind;
	start: number;
	end: number;
	name?: string;
	params?: string[];
	children: Node[];
	/** Stable across edits that do not move the node: kind, name and start. */
	key: string;
};

// LSP SymbolKind, 1-based as the server sends it.
const NAMESPACE = 3;
const PROCEDURE_KINDS = new Set([6, 9, 12]); // Method, Constructor, Function

type Container = { kind: Exclude<NodeKind, "file" | "text" | "blank">; start: number; end: number; name?: string; params?: string[] };

function containers(symbols: SymbolIn[], folds: FoldIn[]): Container[] {
	const out: Container[] = [];
	const walk = (list: SymbolIn[]) => {
		for (const s of list) {
			if (s.kind === NAMESPACE) out.push({ kind: "region", start: s.startLine, end: s.endLine, name: s.name });
			else if (PROCEDURE_KINDS.has(s.kind))
				out.push({ kind: "procedure", start: s.startLine, end: s.endLine, name: s.name, params: (s.children ?? []).map((c) => c.name) });
			walk(s.children ?? []);
		}
	};
	walk(symbols);
	for (const f of folds) {
		if (f.endLine <= f.startLine) continue;
		// A fold that is a symbol's own range adds nothing.
		if (out.some((c) => c.start === f.startLine && Math.abs(c.end - f.endLine) <= 1)) continue;
		out.push({ kind: f.kind === "comment" ? "comment" : "block", start: f.startLine, end: f.endLine });
	}
	// Outer first: earlier start, then longer.
	return out.sort((a, b) => a.start - b.start || b.end - a.end);
}

/** Lines are 1-based here; symbol and fold lines come 0-based from the server. */
export function buildTree(lines: string[], symbols: SymbolIn[], folds: FoldIn[]): Node {
	const count = lines.length;
	const root: Node = { kind: "file", start: 1, end: count, children: [], key: "file" };
	const list = containers(symbols, folds)
		.map((c) => ({ ...c, start: c.start + 1, end: Math.min(count, c.end + 1) }))
		.filter((c) => c.start >= 1 && c.start <= count && c.end >= c.start);

	// Nest by containment; a range that overlaps without nesting is dropped.
	const stack: Node[] = [root];
	for (const c of list) {
		while (stack.length > 1 && c.start > stack.at(-1)!.end) stack.pop();
		const parent = stack.at(-1)!;
		if (c.end > parent.end) continue;
		const last = parent.children.at(-1);
		if (last && c.start <= last.end) continue;
		const node: Node = { ...c, children: [], key: `${c.kind}:${c.name ?? ""}:${c.start}` };
		parent.children.push(node);
		stack.push(node);
	}
	fill(root, lines);
	return root;
}

/** Fills the lines no child covers with text and blank leaves. */
function fill(node: Node, lines: string[]) {
	const filled: Node[] = [];
	// A container's own first line is its header; leaves start after it.
	let line = node.kind === "file" ? node.start : node.start + 1;
	const gap = (from: number, to: number) => {
		let i = from;
		while (i <= to) {
			const blank = !lines[i - 1]!.trim();
			let j = i;
			while (j + 1 <= to && !lines[j]!.trim() === blank) j++;
			filled.push({ kind: blank ? "blank" : "text", start: i, end: j, children: [], key: `${blank ? "blank" : "text"}:${i}` });
			i = j + 1;
		}
	};
	for (const child of node.children) {
		if (child.start > line) gap(line, child.start - 1);
		fill(child, lines);
		filled.push(child);
		line = child.end + 1;
	}
	if (line <= node.end) gap(line, node.end);
	node.children = filled;
}

/** Each line's leaf, in order: the coverage property's witness. */
export function coveredLines(node: Node): number[] {
	if (node.kind === "text" || node.kind === "blank") return Array.from({ length: node.end - node.start + 1 }, (_, i) => node.start + i);
	return [...(node.kind === "file" ? [] : [node.start]), ...node.children.flatMap(coveredLines)];
}

/** The innermost node holding a line, with its ancestors. */
export function pathTo(node: Node, line: number): Node[] {
	for (const child of node.children) if (child.start <= line && line <= child.end) return [child, ...pathTo(child, line)];
	return [];
}

/** Siblings a node can swap with: containers only, skipping blank and text leaves. */
export function neighbour(parent: Node, node: Node, direction: -1 | 1): Node | undefined {
	const movable = parent.children.filter((c) => c.kind !== "blank");
	const index = movable.indexOf(node);
	return movable[index + direction];
}

/**
 * The text after swapping two sibling ranges, as one replacement of the span
 * from the first's start to the second's end (1-based lines, a before b).
 */
export function swapLines(lines: string[], a: { start: number; end: number }, b: { start: number; end: number }) {
	const first = lines.slice(a.start - 1, a.end);
	const between = lines.slice(a.end, b.start - 1);
	const second = lines.slice(b.start - 1, b.end);
	return { start: a.start, end: b.end, lines: [...second, ...between, ...first] };
}
