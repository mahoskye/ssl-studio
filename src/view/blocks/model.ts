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

export type NodeKind = "file" | "region" | "procedure" | "block" | "comment" | "text" | "blank" | "raw";
export type Node = {
	kind: NodeKind;
	start: number;
	end: number;
	name?: string;
	params?: string[];
	/** A block's opening statement, when the server gives it on one line (L1). */
	header?: Header;
	children: Node[];
	/** Stable across edits that do not move the node: kind, name and start. */
	key: string;
};

/** A one-line statement's place: 1-based line, Monaco columns (end exclusive), and its keyword. */
export type Header = { line: number; startColumn: number; endColumn: number; keyword: string };

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

const LEAVES = new Set<NodeKind>(["text", "blank", "raw"]);

/** Fills the lines no child covers with text and blank leaves. */
function fill(node: Node, lines: string[]) {
	if (LEAVES.has(node.kind)) return;
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
	if (LEAVES.has(node.kind)) return Array.from({ length: node.end - node.start + 1 }, (_, i) => node.start + i);
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

// --- From the server's syntax tree (L1, docs/LSP-REQUESTS.md) ------------------
//
// starlims-lsp's ssl/syntaxTree, shape version 1 (its catalog entry
// feature.syntax_tree). Kinds a later server adds degrade to a plain block or
// chip rather than breaking the view.

export type Position = { line: number; character: number };
type RangeIn = { start: Position; end: Position };
export type SyntaxNodeIn = { kind: string; range: RangeIn; keyword?: string; name?: string; headerRange?: RangeIn; closerRange?: RangeIn; children?: SyntaxNodeIn[] };

function viewKind(kind: string, hasChildren: boolean): NodeKind {
	const k = kind.toLowerCase().replace(/[^a-z]/g, "");
	if (k === "region" || k === "commentregion") return "region";
	if (k === "procedure") return "procedure";
	if (k.includes("banner") || k.includes("docblock") || k === "comment") return "comment";
	if (k === "blank" || k.includes("blankline")) return "blank";
	if (k === "error" || k.includes("unparsed") || k === "raw") return "raw";
	// Statements are chips even when the server details their parts.
	if (k === "statement" || k === "parameters" || k === "default" || k === "declare" || k === "parameter") return "text";
	return hasChildren ? "block" : "text";
}

const lastLine = (r: { start: Position; end: Position }) => (r.end.character === 0 && r.end.line > r.start.line ? r.end.line - 1 : r.end.line);

/** The blocks tree from a syntax tree; gaps the tree leaves are filled, so coverage still holds. */
export function treeFromSyntax(lines: string[], nodes: SyntaxNodeIn[], paramsOf?: (procedure: string) => string[] | undefined): Node {
	const count = lines.length;
	const root: Node = { kind: "file", start: 1, end: count, children: [], key: "file" };
	const convert = (n: SyntaxNodeIn, parent: Node) => {
		// `if` and `try` hold only branches, and the first one opens on the block's
		// own first line: its body is the block's body, the later arms nest inside.
		if ((n.kind === "if" || n.kind === "try") && n.children?.[0]?.kind === "branch" && n.children[0].range.start.line === n.range.start.line) {
			const [first, ...rest] = n.children;
			n = { ...n, keyword: first!.keyword, headerRange: first!.headerRange, children: [...(first!.children ?? []), ...rest] };
		}
		const start = n.range.start.line + 1;
		const end = Math.min(count, lastLine(n.range) + 1);
		if (start < 1 || end < start || start < parent.start || end > parent.end) return;
		// A container's first line is its header; a child must start after it.
		if (parent.kind !== "file" && start <= parent.start) return;
		const previous = parent.children.at(-1);
		if (previous && start <= previous.end) return;
		const children = n.children ?? [];
		const kind = viewKind(n.kind, children.length > 0);
		const params = kind === "procedure" ? paramsOf?.(n.name ?? "") : undefined;
		const node: Node = { kind, start, end, name: n.name, params, children: [], key: `${kind}:${n.name ?? ""}:${start}` };
		const h = n.headerRange;
		if (kind === "block" && h && n.keyword && h.start.line === h.end.line && h.start.line + 1 === start)
			node.header = { line: start, startColumn: h.start.character + 1, endColumn: h.end.character + 1, keyword: n.keyword };
		parent.children.push(node);
		if (!LEAVES.has(kind) && kind !== "comment") for (const c of children) convert(c, node);
	};
	for (const n of nodes) convert(n, root);
	fill(root, lines);
	return root;
}

/**
 * A header statement split around what follows its keyword, the part a block
 * edits as a field: `:IF ` · `a > b` · `;`. The server's range ends at the
 * statement's own `;`, so one inside a string stays in the condition. Null
 * when nothing follows the keyword (`:ELSE;`, `:BEGINCASE;`).
 */
export function splitHeader(text: string, keyword: string): { before: string; condition: string; after: string } | null {
	const open = new RegExp(`^:${keyword.replace(/[^A-Za-z]/g, "")}(?![A-Za-z0-9_])\\s*`, "i").exec(text);
	if (!open || !text.endsWith(";")) return null;
	const condition = text.slice(open[0].length, -1).trimEnd();
	if (!condition || /[\r\n]/.test(condition)) return null;
	return { before: open[0], condition, after: text.slice(open[0].length + condition.length) };
}
