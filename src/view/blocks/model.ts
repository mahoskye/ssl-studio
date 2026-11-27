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
	/** A statement's leading keyword, uppercase without its colon, as the server names it ("DECLARE", "INHERIT"). */
	keyword?: string;
	/** A comment the server says is the doc block of the procedure below it. */
	doc?: boolean;
	/** The head of a class file: `:CLASS`, with the `:INHERIT` and field `:DECLARE` lines under it. */
	classHead?: boolean;
	/** A container's closing line (`:ENDPROC;`, `:ENDIF;`, `/* endregion;`, etc.), kept in place. */
	closer?: boolean;
	children: Node[];
	/** Stable across edits that do not move the node: kind, name and start. */
	key: string;
	/** What the block's fold is remembered by (`nameFolds`): its place in the structure, not its line. Leaves have none. */
	fold?: string;
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
	nameFolds(root);
	return root;
}

const LEAVES = new Set<NodeKind>(["text", "blank", "raw"]);

/** Fills the lines no child covers with text and blank leaves. */
function fill(node: Node, lines: string[], closers?: WeakMap<Node, { start: number; end: number }>) {
	if (LEAVES.has(node.kind)) return;
	const filled: Node[] = [];
	const closer = closers?.get(node);
	// A container's own first line is its header; leaves start after it.
	let line = node.kind === "file" ? node.start : node.start + 1;
	const gap = (from: number, to: number) => {
		let i = from;
		while (i <= to) {
			const blank = !lines[i - 1]!.trim();
			const isCloser = Boolean(closer && i >= closer.start && i <= closer.end);
			let j = i;
			while (
				j + 1 <= to &&
				!lines[j]!.trim() === blank &&
				Boolean(closer && j + 1 >= closer.start && j + 1 <= closer.end) === isCloser
			)
				j++;
			const leaf: Node = { kind: blank ? "blank" : "text", start: i, end: j, children: [], key: `${blank ? "blank" : "text"}:${i}` };
			if (isCloser && !blank) leaf.closer = true;
			filled.push(leaf);
			i = j + 1;
		}
	};
	for (const child of node.children) {
		if (child.start > line) gap(line, child.start - 1);
		fill(child, lines, closers);
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

/** Siblings a node can swap with: skipping blank leaves and container closing lines. */
export function neighbour(parent: Node, node: Node, direction: -1 | 1): Node | undefined {
	const movable = parent.children.filter((c) => c.kind !== "blank" && !c.closer);
	const index = movable.indexOf(node);
	if (index < 0) return undefined;
	return movable[index + direction];
}

/** A run of whole lines, 1-based and inclusive. */
export type Span = { start: number; end: number };

/**
 * The lines a node is drawn in as one card: for a procedure, its doc block and the annotation between them
 * (`procedureGroups`), from the doc block's first line to the procedure's last. Any other node is its own lines.
 * A card is moved and wrapped whole, whichever of its parts is asked: taken apart, a doc block is left above
 * another procedure, or under its own.
 */
export function cardOf(parent: Node, node: Node): Span {
	const group = procedureGroups(parent.children).find((g) => g.includes(node));
	return group ? { start: group[0]!.start, end: group.at(-1)!.end } : { start: node.start, end: node.end };
}

/**
 * The line a drop on a node goes in at. A drop lands above what it is dropped on, and above the whole card when
 * that is part of one (`cardOf`): above the doc block, for a procedure that has one. Dropped on such a
 * procedure's header, text went in at the procedure's own first line, between it and its doc block; so did text
 * dropped on the blank line or the annotation that stands between the two. Whichever part of a card's head is
 * dropped on, nothing goes in between a doc block and its procedure.
 */
export function dropLine(parent: Node, node: Node): number {
	return cardOf(parent, node).start;
}

/**
 * A move of a node's card past the card next to it: the two runs of lines to swap (`a` above `b`), and the line
 * the node's own first line is on once they are swapped. The neighbour is the next card, not the next node: a
 * procedure's doc block is not something to swap it with. Blank lines and container closing lines are stepped
 * over and stay where they are, as `neighbour` has it. Undefined when there is nothing that way to move past.
 */
export function cardMove(parent: Node, node: Node, direction: -1 | 1): { a: Span; b: Span; line: number } | undefined {
	const movable = procedureGroups(parent.children).filter((g) => g.length > 1 || (g[0]!.kind !== "blank" && !g[0]!.closer));
	const index = movable.findIndex((g) => g.includes(node));
	const other = index < 0 ? undefined : movable[index + direction];
	if (!other) return undefined;
	const span = (g: Node[]): Span => ({ start: g[0]!.start, end: g.at(-1)!.end });
	const [own, there] = [span(movable[index]!), span(other)];
	// Moved up, the card starts where the other did; moved down, it ends where the other did.
	const start = direction < 0 ? there.start : there.end - (own.end - own.start);
	const line = start + (node.start - own.start);
	return direction < 0 ? { a: there, b: own, line } : { a: own, b: there, line };
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

/**
 * The lines an edit made in the blocks leaves to be formatted (ADR 0002: an edit, then a range format of what it
 * touched), in the text as it is after the edit. `text` is what was put at line `start`, in place of the lines
 * that were there or between two lines: those are its own lines. Null is a deletion of whole lines from `start`:
 * what it touched is where the text now joins, the line before and the line that moved up, as far as there are
 * such lines. `lineCount` is the text's after the edit.
 */
export function editedLines(start: number, text: string | null, lineCount: number): Span {
	const last = Math.max(1, lineCount);
	const within = (line: number) => Math.min(Math.max(1, line), last);
	if (text === null) return { start: within(start - 1), end: within(start) };
	// A line break that ends the text ends its last line: it does not begin another.
	const count = text.replace(/\r\n/g, "\n").replace(/\n$/, "").split("\n").length;
	return { start: within(start), end: within(start + count - 1) };
}

/** An edit as Monaco has one: 1-based lines and columns, the end not included. */
export type RangeEdit = { range: { startLineNumber: number; startColumn: number; endLineNumber: number; endColumn: number }; text: string | null };

/** A text's lines as they would be with edits made to it. The edits do not overlap; the lines given are not changed. */
export function linesWithEdits(lines: string[], edits: RangeEdit[]): string[] {
	const starts: number[] = [];
	let offset = 0;
	for (const line of lines) {
		starts.push(offset);
		offset += line.length + 1;
	}
	// A place before the text is its start and one past it its end, as the editor's model has it.
	const at = (line: number, column: number) => {
		if (line < 1) return 0;
		if (line > lines.length) return Math.max(0, offset - 1);
		return starts[line - 1]! + Math.min(Math.max(1, column) - 1, lines[line - 1]!.length);
	};
	let text = lines.join("\n");
	const placed = edits
		.map((edit) => ({ from: at(edit.range.startLineNumber, edit.range.startColumn), to: at(edit.range.endLineNumber, edit.range.endColumn), text: (edit.text ?? "").replace(/\r\n?/g, "\n") }))
		.sort((a, b) => b.from - a.from || b.to - a.to);
	for (const edit of placed) text = text.slice(0, edit.from) + edit.text + text.slice(edit.to);
	return text.split("\n");
}

/**
 * True when what a range format answered changes lines of the span it was asked for and no others: every line
 * above the span and every line below it stands as it did. The server formats whole statements, and a statement
 * it cannot find the end of (a bracket left open) reaches to the end of its procedure: asked for one line, it
 * answered for seven, and each of them was pushed in by a dozen spaces. `before` and `after` are the text's
 * lines without the answer and with it.
 */
export function formatStaysWithin(before: string[], after: string[], span: Span): boolean {
	const moved = after.length - before.length;
	// No more lines can go than the span has.
	if (span.end + moved < span.start - 1) return false;
	for (let i = 0; i < span.start - 1; i++) if (before[i] !== after[i]) return false;
	for (let i = span.end; i < before.length; i++) if (before[i] !== after[i + moved]) return false;
	return true;
}

/** The lines within a span that are code the server could not read (raw leaves), as spans in order. */
export function rawSpans(node: Node | null, within: Span): Span[] {
	if (!node || node.end < within.start || node.start > within.end) return [];
	if (node.kind === "raw") return [{ start: Math.max(node.start, within.start), end: Math.min(node.end, within.end) }];
	return node.children.flatMap((child) => rawSpans(child, within));
}

/** A span with others cut out of it: the runs of lines that are left, in order. */
export function cutOut(span: Span, holes: Span[]): Span[] {
	const runs: Span[] = [];
	let from = span.start;
	for (const hole of [...holes].sort((a, b) => a.start - b.start)) {
		if (hole.end < from || hole.start > span.end) continue;
		if (hole.start > from) runs.push({ start: from, end: hole.start - 1 });
		from = Math.max(from, hole.end + 1);
	}
	if (from <= span.end) runs.push({ start: from, end: span.end });
	return runs;
}

/**
 * Where a run of lines stands once the runs `a` and `b` are swapped (`swapLines`): one in `b` moves up to where
 * `a` began, one in `a` down to where `b` ended, one between the two by the difference of their lengths.
 */
export function spanAfterSwap(span: Span, a: Span, b: Span): Span {
	const inside = (outer: Span) => span.start >= outer.start && span.end <= outer.end;
	const by = inside(b) ? a.start - b.start : inside(a) ? b.end - a.end : span.start > a.end && span.end < b.start ? b.end - b.start - (a.end - a.start) : 0;
	return { start: span.start + by, end: span.end + by };
}

/**
 * What was typed in place of a statement, at the depth the statement stood at. The edit box shows the statement
 * with its indentation, and one typed anew without it went into the text at the left edge, inside a block whose
 * other lines are a tab in. The range format that follows settles spacing, not depth, and a save did not either.
 * Typed with any indentation of its own, the text is taken as it is. Only white space at line starts is read.
 */
export function keepDepth(original: string, typed: string): string {
	const depth = /^[ \t]*/.exec(original)![0];
	const lines = typed.split("\n");
	const first = lines.find((line) => line.trim());
	if (!depth || first === undefined || /^[ \t]/.test(first)) return typed;
	return lines.map((line) => (line.trim() ? depth + line : line)).join("\n");
}

/**
 * Why a name cannot be written as a region's name, or null when it can. "Wrap in a region" writes the name into
 * a comment (`/* region Name;`), and a comment in SSL runs to its first semicolon and ends there: a name with one
 * in it ended the comment early, and the rest of the name was left in the text as a statement. A name with a line
 * break in it broke the region's line in two. That one fact about a comment is all that is read here, the same
 * one a file dropped on code is refused by (`droppedFileNote`); what else a name may hold is not this view's to say.
 */
export function regionNameRefusal(name: string): string | null {
	if (name.includes(";")) return "Nothing was wrapped: the name has “;” in it, which ends a comment in SSL.";
	if (/[\r\n]/.test(name)) return "Nothing was wrapped: the name has a line break in it, and a region's name is one line.";
	return null;
}

/** The most of the view's height the box a block is edited in grows to by what is typed in it. */
export const EDIT_BOX_SHARE = 0.6;

/**
 * How tall the box a block is edited in is to stand, in pixels. The box opened as tall as the block's lines and
 * stayed so: Enter in a one-line block scrolled the line just typed on out of sight, in a box one line tall. It
 * grows with its text, so that all of it shows, up to a share of the view's height (`EDIT_BOX_SHARE`); past that
 * it scrolls in itself, and the view keeps room for the blocks around it. It is never made smaller: not under the
 * height it opened with, which a long block's is, and not under one the user dragged it to.
 *
 * `now` is the box's height, `text` the height that shows all of its text, `view` the height of the view.
 */
export function editBoxHeight(now: number, text: number, view: number): number {
	return Math.max(now, Math.min(text, Math.floor(view * EDIT_BOX_SHARE)));
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
	const statementRanges = new WeakMap<Node, RangeIn>();
	const closers = new WeakMap<Node, { start: number; end: number }>();
	const convert = (n: SyntaxNodeIn, parent: Node) => {
		// `if` and `try` hold only branches, and the first one opens on the block's
		// own first line: its body is the block's body, the later arms nest inside.
		if ((n.kind === "if" || n.kind === "try") && n.children?.[0]?.kind === "branch" && n.children[0].range.start.line === n.range.start.line) {
			const [first, ...rest] = n.children;
			n = { ...n, keyword: first!.keyword, headerRange: first!.headerRange, children: [...(first!.children ?? []), ...rest] };
		}
		let start = n.range.start.line + 1;
		const end = Math.min(count, lastLine(n.range) + 1);
		if (start < 1 || end < start || start < parent.start || end > parent.end) return;
		// A container's first line is its header; a child must start after it.
		if (parent.kind !== "file" && start <= parent.start) return;
		const children = n.children ?? [];
		const kind = viewKind(n.kind, children.length > 0);
		const previous = parent.children.at(-1);
		if (previous && start <= previous.end) {
			if (kind === "raw" && end > previous.end) start = previous.end + 1;
			else return;
		}
		const params = kind === "procedure" ? paramsOf?.(n.name ?? "") : undefined;
		const node: Node = { kind, start, end, name: n.name, params, children: [], key: `${kind}:${n.name ?? ""}:${start}` };
		if (kind === "text" && n.keyword) {
			node.keyword = n.keyword.toUpperCase();
			statementRanges.set(node, n.range);
		}
		if (kind === "comment" && n.kind.toLowerCase() === "docblock") node.doc = true;
		const h = n.headerRange;
		if (kind === "block" && h && n.keyword && h.start.line === h.end.line && h.start.line + 1 === start)
			node.header = { line: start, startColumn: h.start.character + 1, endColumn: h.end.character + 1, keyword: n.keyword };
		if (!LEAVES.has(kind) && kind !== "comment" && n.closerRange) {
			const cStart = n.closerRange.start.line + 1;
			const cEnd = Math.min(count, lastLine(n.closerRange) + 1);
			if (cStart > start && cEnd >= cStart && cEnd <= end) closers.set(node, { start: cStart, end: cEnd });
		}
		parent.children.push(node);
		if (!LEAVES.has(kind) && kind !== "comment") for (const c of children) convert(c, node);
	};
	for (const n of nodes) convert(n, root);
	groupClassHead(root, statementRanges);
	fill(root, lines, closers);
	nameFolds(root);
	return root;
}

/** What may sit under `:CLASS` in a class's head. */
const CLASS_HEAD = new Set(["INHERIT", "DECLARE"]);

/**
 * A class file opens with `:CLASS Name;`, then perhaps `:INHERIT` and the
 * `:DECLARE`s of its fields. The server gives each as a statement with its
 * keyword; here they become one block, headed by the `:CLASS` line, so that a
 * class reads as a class. Nothing is read from the text: the grouping is by
 * the server's own keywords, and blank lines between them go along.
 */
function groupClassHead(root: Node, ranges: WeakMap<Node, RangeIn>) {
	const at = root.children.findIndex((c) => c.kind === "text" && c.keyword === "CLASS" && c.start === c.end);
	if (at < 0) return;
	const head = root.children[at]!;
	let last = at;
	for (let i = at + 1; i < root.children.length; i++) {
		const c = root.children[i]!;
		if (c.kind === "blank") continue;
		if (c.kind !== "text" || !c.keyword || !CLASS_HEAD.has(c.keyword)) break;
		last = i;
	}
	const inside = root.children.slice(at + 1, last + 1);
	const range = ranges.get(head);
	const node: Node = { kind: "block", start: head.start, end: inside.at(-1)?.end ?? head.end, classHead: true, children: inside, key: `class:${head.start}` };
	if (range && range.start.line === range.end.line) node.header = { line: head.start, startColumn: range.start.character + 1, endColumn: range.end.character + 1, keyword: "CLASS" };
	root.children.splice(at, last - at + 1, node);
}

/**
 * What a view draws as one card: a procedure with the doc block the server
 * says is its own, and whatever sits between the two (a visibility
 * annotation, blank lines). Every other node is a group of one. The tree is
 * not changed: each line still belongs to the node it did.
 */
export function procedureGroups(children: Node[]): Node[][] {
	const groups: Node[][] = [];
	for (let i = 0; i < children.length; i++) {
		const child = children[i]!;
		if (child.kind === "comment" && child.doc) {
			let j = i + 1;
			// Between a doc block and its procedure: blank lines, and comments of one line (the annotation).
			while (j < children.length && (children[j]!.kind === "blank" || (children[j]!.kind === "comment" && !children[j]!.doc && children[j]!.start === children[j]!.end))) j++;
			if (children[j]?.kind === "procedure") {
				groups.push(children.slice(i, j + 1));
				i = j;
				continue;
			}
		}
		groups.push([child]);
	}
	return groups;
}

/**
 * Gives every block that can be folded the name its fold is remembered by. The name is the block's place in the
 * structure, never the line it starts on: remembered by line, a fold sat on whichever block had come to start
 * there once a line was added or removed above, and the block that had been folded sprang open.
 *
 * - A procedure is known by its name, wherever in the file it is: moved, or wrapped in a region, it stays folded.
 * - A doc block is known by the procedure it is drawn with.
 * - Anything else (a region, a control-flow block, a comment, a class's head) is known by what it is, under what
 *   it is in: `procedure:Run/block:IF#2` is the second `:IF` block directly in Run.
 *
 * All of it is the language server's own: names, kinds, keywords, and the order of a node's children. What it
 * cannot tell apart, this cannot either. A procedure or a region that is renamed is a new one: its fold, and the
 * folds in it, are not carried over, and it shows unfolded. And when a block is added or removed before another
 * of its kind under the same parent, the folds of the later ones of that kind there move on by one. Nothing else
 * moves a fold, and a name whose block is gone is kept: the block is folded again if it comes back (an undo).
 */
function nameFolds(root: Node) {
	const taken = new Set<string>();
	// One name, one block: a name that is taken (the second `:IF` of its parent, a second procedure of one name) is counted on.
	const unique = (name: string) => {
		let key = name;
		for (let n = 2; taken.has(key); n++) key = `${name}#${n}`;
		taken.add(key);
		return key;
	};
	const label = (node: Node) => {
		if (node.kind === "region") return `region:${node.name ?? ""}`;
		if (node.kind === "block") return node.classHead ? "class" : `block:${node.header?.keyword.toUpperCase() ?? ""}`;
		return node.kind;
	};
	const walk = (parent: Node, path: string) => {
		for (const group of procedureGroups(parent.children)) {
			const procedure = group.length > 1 ? group.at(-1)! : group[0]!.kind === "procedure" ? group[0]! : undefined;
			if (procedure) procedure.fold = unique(`procedure:${procedure.name ?? ""}`);
			for (const child of group) {
				if (LEAVES.has(child.kind)) continue;
				if (child !== procedure) child.fold = unique(procedure && child.doc ? `doc:${procedure.fold}` : `${path}${label(child)}`);
				walk(child, `${child.fold}/`);
			}
		}
	};
	walk(root, "");
}

/** A file longer than this opens as an outline. */
const OUTLINE_OVER_LINES = 300;

/** The folds a file is first shown with: its banner folded, and a long file as an outline, every procedure and comment in it folded. */
export function openingFolds(root: Node, lineCount: number): string[] {
	// A set: in a long file the banner is one of the comments too.
	const folds = new Set<string>();
	const banner = root.children.find((c) => c.kind === "comment" && c.start === 1);
	if (banner?.fold) folds.add(banner.fold);
	if (lineCount > OUTLINE_OVER_LINES) {
		const walk = (n: Node) => n.children.forEach((c) => (c.kind === "procedure" || c.kind === "comment" ? c.fold && folds.add(c.fold) : walk(c)));
		walk(root);
	}
	return [...folds];
}

/**
 * Which blocks are folded, by file, for as long as the app runs: each file's folded blocks by fold name
 * (`nameFolds`), and whether the file's opening folds have been set. It is the view's own and no part of the
 * text (ADR 0002), and it is kept apart from the view, which is made anew each time its tab or the Blocks mode
 * is switched to.
 */
export type FoldMemory = Map<string, { folded: Set<string>; opened: boolean }>;

/** A file's folded blocks, by fold name. */
export function foldsOf(memory: FoldMemory, path: string): Set<string> {
	let file = memory.get(path);
	if (!file) memory.set(path, (file = { folded: new Set(), opened: false }));
	return file.folded;
}

/**
 * Sets the folds a file opens with (`openingFolds`), the first time its blocks are read and never again: true
 * when they were set now. Each new view set them anew, so a banner the user had unfolded was folded again on the
 * way back from Text or from another tab, and in a long file every procedure was. After the first time a file is
 * as the user left it.
 */
export function openFolds(memory: FoldMemory, path: string, root: Node, lineCount: number): boolean {
	const folded = foldsOf(memory, path);
	const file = memory.get(path)!;
	if (file.opened) return false;
	file.opened = true;
	for (const fold of openingFolds(root, lineCount)) folded.add(fold);
	return true;
}

/**
 * Why the blocks cannot be changed just now. The tree says which lines a block is, and it is only trusted for the
 * text it was read from: with the language server starting or stopped there is no such tree, and just after an
 * edit it is still being read.
 */
export type Stale = "starting" | "stopped" | "silent" | "reading";

/**
 * The reason, from the language server's state: with the server running and answering, the tree is merely behind
 * the text. One that runs and does not answer (`answering` false) will not catch up "in a moment".
 */
export function staleReason(lspState: string, answering = true): Stale {
	if (lspState === "running") return answering ? "reading" : "silent";
	return lspState === "starting" || lspState === "restarting" ? "starting" : "stopped";
}

/**
 * What is said when a change is not made because of it: for a move, a delete, a wrap or a drop, that nothing was
 * changed; for an inline edit, that it is kept open with what was typed. Said, because a click or a key that did
 * nothing read as a broken view, and an edit closed without being made was text lost without a word.
 */
export function staleNotice(reason: Stale, what: "change" | "edit"): string {
	if (what === "edit") {
		if (reason === "starting") return "The language server is still starting, so the edit is not made yet. It is kept open: confirm it again in a moment, or press Escape to drop it.";
		if (reason === "stopped") return "The language server is not running, so the edit is not made yet. It is kept open: restart the server from the status bar and confirm it again, or press Escape to drop it.";
		if (reason === "silent") return "The language server is not answering, so the edit is not made yet. It is kept open: restart the server from the status bar and confirm it again, or press Escape to drop it.";
		return "The blocks are still being read from the text, so the edit is not made yet. It is kept open: confirm it again in a moment, or press Escape to drop it.";
	}
	if (reason === "starting") return "The language server is still starting, and blocks cannot be changed until it is running. Nothing was changed.";
	if (reason === "stopped") return "The language server is not running, and blocks cannot be changed without it. Nothing was changed: restart it from the status bar, or switch to Text.";
	if (reason === "silent") return "The language server is not answering, and blocks cannot be changed without it. Nothing was changed: restart it from the status bar, or switch to Text.";
	return "The blocks are still being read from the text. Nothing was changed: try again in a moment.";
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
