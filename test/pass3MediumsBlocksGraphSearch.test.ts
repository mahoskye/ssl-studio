// The medium findings of the third audit pass in the Blocks view, the call graph's unfolding and the workspace
// search's time budget. The pure parts (src/view/blocks/model.ts, src/view/graph/unfold.ts,
// src/view/panels/searchLines.ts) and the backend's search are run for real. The three views themselves
// (BlocksView.tsx, GraphView.tsx, Search.tsx) need a DOM and the real Monaco to be mounted, which the suite does
// not have: what is checked of them is only that they are wired to the tested parts, by reading their source, and
// each such test says so in its name.
import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createBackend, type Host } from "../src/bun/backend";
import { WorkspaceFiles } from "../src/bun/workspace";
import { SEARCH_LIMIT } from "../src/shared/searchPattern";
import { cardMove, cardOf, coveredLines, neighbour, pathTo, procedureGroups, staleNotice, staleReason, swapLines, treeFromSyntax, type Node, type SyntaxNodeIn } from "../src/view/blocks/model";
import { assemble, procId, type CallIn, type ScriptIn } from "../src/view/graph/model";
import { ASK_ABOVE, asksFirst, openedFoldedNote, openingFolds, pictureSize, unfoldQuestion } from "../src/view/graph/unfold";
import { searchShortfall, shortfallBlocksReplace, shortfallCount, timedOutEmpty } from "../src/view/panels/searchLines";

const readSrc = (rel: string) => readFileSync(join(import.meta.dir, "..", rel), "utf8").replace(/\r\n/g, "\n");
const between = (src: string, from: string, to: string) => {
	const start = src.indexOf(from);
	const end = src.indexOf(to, start + from.length);
	expect(start).toBeGreaterThan(0);
	expect(end).toBeGreaterThan(start);
	return src.slice(start, end);
};

// --- Blocks: a card moves, is wrapped and is deleted as it is drawn ----------------------------------------

const span = (from: number, to: number) => ({ start: { line: from - 1, character: 0 }, end: { line: to - 1, character: 200 } });
/** The text after a move, as BlocksView makes it: one replacement of the lines from the first card to the second. */
const moved = (lines: string[], step: { a: { start: number; end: number }; b: { start: number; end: number } }) => {
	const s = swapLines(lines, step.a, step.b);
	return [...lines.slice(0, s.start - 1), ...s.lines, ...lines.slice(s.end)];
};

describe("Blocks — a documented procedure is one card (finding 2)", () => {
	// The auditors' file: two procedures, each under its own doc block, a blank line between them.
	const text = [
		"/* Returns the due date of sample A;", //        1 doc block of DueDateA
		":PROCEDURE DueDateA;", //                         2
		"    :RETURN Today() + 1;", //                     3
		":ENDPROC;", //                                    4
		"", //                                             5
		"/* Deletes every sample older than a year;", //  6 doc block of PurgeOld
		"/*@private;", //                                  7 the annotation between them
		":PROCEDURE PurgeOld;", //                         8
		'    RunSQL("DELETE ...");', //                    9
		":ENDPROC;", //                                   10
	];
	const syntax: SyntaxNodeIn[] = [
		{ kind: "docBlock", range: span(1, 1) },
		{ kind: "procedure", name: "DueDateA", range: span(2, 4), closerRange: span(4, 4), children: [{ kind: "statement", keyword: "RETURN", range: span(3, 3) }] },
		{ kind: "docBlock", range: span(6, 6) },
		{ kind: "comment", range: span(7, 7) },
		{ kind: "procedure", name: "PurgeOld", range: span(8, 10), closerRange: span(10, 10), children: [{ kind: "statement", range: span(9, 9) }] },
	];
	const root = () => treeFromSyntax(text, syntax, () => []);
	const named = (r: Node, name: string) => r.children.find((c) => c.name === name)!;
	const swappedOrder = [...text.slice(5, 10), "", ...text.slice(0, 4)];

	test("the node next to a documented procedure is a doc block, which is why moves are worked out by card", () => {
		const r = root();
		// What the view used to swap with: the next procedure's doc block, which left that doc block above this one.
		expect(neighbour(r, named(r, "DueDateA"), 1)).toMatchObject({ kind: "comment", doc: true, start: 6 });
		expect(procedureGroups(r.children).map((g) => g.map((n) => n.start))).toEqual([[1, 2], [5], [6, 7, 8]]);
	});

	test("moving a procedure down swaps its whole card with the next whole card", () => {
		const r = root();
		const step = cardMove(r, named(r, "DueDateA"), 1)!;
		expect(step).toEqual({ a: { start: 1, end: 4 }, b: { start: 6, end: 10 }, line: 8 });
		const after = moved(text, step);
		expect(after).toEqual(swappedOrder);
		// Where the procedure's own first line landed: the line the cursor is put on, so it stays the selected block.
		expect(after[step.line - 1]).toBe(":PROCEDURE DueDateA;");
	});

	test("moving a procedure up does the same from the other side", () => {
		const r = root();
		const step = cardMove(r, named(r, "PurgeOld"), -1)!;
		expect(step).toEqual({ a: { start: 1, end: 4 }, b: { start: 6, end: 10 }, line: 3 });
		const after = moved(text, step);
		expect(after).toEqual(swappedOrder);
		expect(after[step.line - 1]).toBe(":PROCEDURE PurgeOld;");
	});

	test("a move asked of the doc block or the annotation moves the card they are drawn in", () => {
		const r = root();
		const [doc, annotation] = [r.children.find((c) => c.start === 6)!, r.children.find((c) => c.start === 7)!];
		expect(cardMove(r, doc, -1)).toEqual({ a: { start: 1, end: 4 }, b: { start: 6, end: 10 }, line: 1 });
		expect(cardMove(r, annotation, -1)).toEqual({ a: { start: 1, end: 4 }, b: { start: 6, end: 10 }, line: 2 });
		// Inside the card there is nothing to move past: a doc block does not go under its own procedure.
		expect(cardMove(r, r.children.find((c) => c.start === 1)!, -1)).toBeUndefined();
		expect(cardMove(r, named(r, "PurgeOld"), 1)).toBeUndefined();
	});

	test("the card's lines are the doc block's first to the procedure's last, for delete and wrap", () => {
		const r = root();
		expect(cardOf(r, named(r, "DueDateA"))).toEqual({ start: 1, end: 4 });
		expect(cardOf(r, named(r, "PurgeOld"))).toEqual({ start: 6, end: 10 });
		expect(cardOf(r, r.children.find((c) => c.start === 7)!)).toEqual({ start: 6, end: 10 });
		// Deleting the card of DueDateA leaves no doc block behind above the blank line.
		const card = cardOf(r, named(r, "DueDateA"));
		expect([...text.slice(0, card.start - 1), ...text.slice(card.end)]).toEqual(text.slice(4));
		// A node that is not part of a procedure's card is its own lines.
		const statement = named(r, "DueDateA").children.find((c) => c.kind === "text" && !c.closer)!;
		expect(cardOf(named(r, "DueDateA"), statement)).toEqual({ start: 3, end: 3 });
	});

	test("blank lines and closing lines are not moved, and nothing is moved past them", () => {
		const r = root();
		const proc = named(r, "DueDateA");
		const closer = proc.children.find((c) => c.closer)!;
		expect(cardMove(proc, closer, -1)).toBeUndefined();
		expect(cardMove(r, r.children.find((c) => c.kind === "blank")!, 1)).toBeUndefined();
		// The one statement of the procedure has only its closing line after it.
		expect(cardMove(proc, proc.children.find((c) => c.kind === "text" && !c.closer)!, 1)).toBeUndefined();
	});
});

describe("Blocks — the moved block stays the selected one (finding 1)", () => {
	// One statement to a line, as the server gives them. The selected block is the one the text cursor is in.
	const statements = (lines: string[]) => treeFromSyntax(lines, lines.map((l, i) => ({ kind: "statement", range: { start: { line: i, character: 0 }, end: { line: i, character: l.length } } })), () => []);
	/** One press of Alt+Up or Alt+Down: the block the cursor is in moves, in the tree read from the text as it stands. */
	const press = (lines: string[], cursorLine: number, direction: -1 | 1) => {
		const root = statements(lines);
		return cardMove(root, pathTo(root, cursorLine).at(-1)!, direction)!;
	};

	test("Alt+Down twice moves the same statement two places, with the cursor put on its new line", () => {
		let lines = ["a := 1;", "bbbbbbbbbbbb := 22222;", "c := 3;", "d := 4;"];
		let cursor = 1;
		for (let times = 0; times < 2; times++) {
			const step = press(lines, cursor, 1);
			lines = moved(lines, step);
			cursor = step.line;
			expect(lines[cursor - 1]).toBe("a := 1;");
		}
		expect(lines).toEqual(["bbbbbbbbbbbb := 22222;", "c := 3;", "a := 1;", "d := 4;"]);
	});

	test("Alt+Up twice likewise", () => {
		let lines = ["a := 1;", "b := 2;", "ccccccccccccccc := 3;", "d := 4;"];
		let cursor = 3;
		for (let times = 0; times < 2; times++) {
			const step = press(lines, cursor, -1);
			lines = moved(lines, step);
			cursor = step.line;
		}
		expect(lines).toEqual(["ccccccccccccccc := 3;", "a := 1;", "b := 2;", "d := 4;"]);
	});

	test("with the cursor left on the old line, as it was, the second press undoes the first", () => {
		// What happened before: the cursor stayed where the block had been, which is now its neighbour.
		let lines = ["a := 1;", "b := 2;", "ccccccccccccccc := 3;", "d := 4;"];
		const original = [...lines];
		const cursor = 3;
		for (let times = 0; times < 2; times++) lines = moved(lines, press(lines, cursor, -1));
		expect(lines).toEqual(original);
	});

	test("a container moved keeps its own first line as the selected line", () => {
		const lines = ["x := 1;", ":IF a;", "y := 2;", ":ENDIF;", "z := 3;"];
		const syntax: SyntaxNodeIn[] = [
			{ kind: "statement", range: span(1, 1) },
			{ kind: "while", keyword: "IF", range: span(2, 4), headerRange: span(2, 2), closerRange: span(4, 4), children: [{ kind: "statement", range: span(3, 3) }] },
			{ kind: "statement", range: span(5, 5) },
		];
		const root = treeFromSyntax(lines, syntax);
		const block = root.children.find((c) => c.kind === "block")!;
		const step = cardMove(root, block, 1)!;
		const after = moved(lines, step);
		expect(after).toEqual(["x := 1;", "z := 3;", ":IF a;", "y := 2;", ":ENDIF;"]);
		expect(step.line).toBe(3);
		expect(after[step.line - 1]).toBe(":IF a;");
	});
});

// A file made of units whose every line that is not blank is written once, so that after a move the text can be
// read back into the same units without a parser: a unit is found by its first line.
type Unit = { id: string; kind: "stmt" | "comment" | "blank" | "proc" | "region"; head: string[]; children: Unit[]; tail: string[]; docLines: number; annotation: boolean; gap: boolean };
const flat = (u: Unit): string[] => [...u.head, ...u.children.flatMap(flat), ...u.tail];

function fuzzFile(seed: number) {
	let state = seed;
	const rnd = () => ((state = (state * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
	const ri = (n: number) => Math.floor(rnd() * n);
	let next = 0;
	const unit = (kind: Unit["kind"], head: string[], children: Unit[] = [], tail: string[] = [], extra: Partial<Unit> = {}): Unit => ({ id: `u${next}`, kind, head, children, tail, docLines: 0, annotation: false, gap: false, ...extra });
	const leaf = (): Unit => {
		const id = next++;
		const pick = ri(5);
		if (pick === 0) return unit("blank", Array.from({ length: 1 + ri(2) }, () => ""));
		if (pick === 1) return unit("comment", Array.from({ length: 1 + ri(2) }, (_, i) => `/* note ${id}.${i};`));
		return unit("stmt", [`s${id} := ${id};`]);
	};
	const proc = (): Unit => {
		const id = next++;
		const docLines = ri(3) === 0 ? 0 : 1 + ri(3);
		const annotation = docLines > 0 && ri(3) === 0;
		const gap = docLines > 0 && ri(4) === 0;
		const head = [...Array.from({ length: docLines }, (_, i) => `/* doc of P${id}, line ${i};`), ...(annotation ? [`/*@private P${id};`] : []), ...(gap ? [""] : []), `:PROCEDURE P${id};`];
		return unit("proc", head, Array.from({ length: ri(4) }, leaf), [`:ENDPROC; /* P${id}`], { docLines, annotation, gap });
	};
	const inner = (): Unit => (ri(2) ? proc() : leaf());
	const top = (): Unit => {
		if (ri(6) === 0) {
			const id = next++;
			return unit("region", [`/* region R${id};`], Array.from({ length: 1 + ri(4) }, inner), [`/* endregion R${id};`]);
		}
		return inner();
	};
	return { units: Array.from({ length: 2 + ri(7) }, top), ri };
}

/** The syntax tree the server would give for the units, starting at a 1-based line. */
function syntaxOf(units: Unit[], at: number): SyntaxNodeIn[] {
	const out: SyntaxNodeIn[] = [];
	let line = at;
	for (const u of units) {
		const size = flat(u).length;
		if (u.kind === "stmt") out.push({ kind: "statement", range: span(line, line) });
		else if (u.kind === "comment") out.push({ kind: "comment", range: span(line, line + size - 1) });
		else if (u.kind === "region") out.push({ kind: "region", name: u.head[0]!, range: span(line, line + size - 1), closerRange: span(line + size - 1, line + size - 1), children: syntaxOf(u.children, line + 1) });
		else if (u.kind === "proc") {
			let header = line;
			if (u.docLines) out.push({ kind: "docBlock", range: span(line, line + u.docLines - 1) });
			header += u.docLines;
			if (u.annotation) out.push({ kind: "comment", range: span(header, header) }), header++;
			if (u.gap) header++;
			out.push({ kind: "procedure", name: u.head.at(-1)!, range: span(header, line + size - 1), closerRange: span(line + size - 1, line + size - 1), children: syntaxOf(u.children, header + 1) });
		}
		line += size;
	}
	return out;
}

/**
 * The units as the text has them now, read back by each unit's first line. Throws when the text is no longer made
 * of the same units, each whole and in one piece: a doc block parted from its procedure, a line lost or doubled.
 */
function readBack(lines: string[], known: Map<string, Unit>): Unit[] {
	const out: Unit[] = [];
	let i = 0;
	while (i < lines.length) {
		if (lines[i] === "") {
			let j = i;
			while (j + 1 < lines.length && lines[j + 1] === "") j++;
			out.push({ id: `blank@${i}`, kind: "blank", head: lines.slice(i, j + 1), children: [], tail: [], docLines: 0, annotation: false, gap: false });
			i = j + 1;
			continue;
		}
		const unit = known.get(lines[i]!);
		if (!unit) throw new Error(`line ${i + 1} (${lines[i]}) does not start a unit: a card was taken apart`);
		const size = flat(unit).length;
		const own = lines.slice(i, i + size);
		if (own.slice(0, unit.head.length).join("\n") !== unit.head.join("\n")) throw new Error(`${unit.id}: its first lines are no longer together (${own.join(" | ")})`);
		if (unit.tail.length && own.slice(-unit.tail.length).join("\n") !== unit.tail.join("\n")) throw new Error(`${unit.id}: its closing line is not where it ends`);
		out.push({ ...unit, children: readBack(own.slice(unit.head.length, size - unit.tail.length), known) });
		i += size;
	}
	return out;
}

describe("Blocks — moves keep every line and every doc block with its procedure (finding 2, fuzzed)", () => {
	test("any run of moves, of any node in any direction, leaves the same units, each whole", () => {
		let moves = 0;
		let refused = 0;
		for (let seed = 1; seed <= 400; seed++) {
			const { units: made, ri } = fuzzFile(seed);
			let units = made;
			const known = new Map<string, Unit>();
			const learn = (u: Unit) => (u.kind !== "blank" && known.set(u.head[0]!, u), u.children.forEach(learn));
			units.forEach(learn);
			let lines = units.flatMap(flat);
			const sorted = [...lines].sort();
			for (let step = 0; step < 12; step++) {
				const root = treeFromSyntax(lines, syntaxOf(units, 1), () => []);
				expect(coveredLines(root)).toEqual(lines.map((_, i) => i + 1));
				// Every node that has a parent, with it: a move may be asked of any of them.
				const pairs: [Node, Node][] = [];
				const walk = (parent: Node) => parent.children.forEach((c) => (pairs.push([parent, c]), walk(c)));
				walk(root);
				const [parent, node] = pairs[ri(pairs.length)]!;
				const direction = ri(2) ? 1 : -1;
				const plan = cardMove(parent, node, direction);
				// A blank line or a closing line is not moved, unless it is the blank line inside a card, which goes with it.
				const inCard = procedureGroups(parent.children).some((g) => g.length > 1 && g.includes(node));
				if ((node.kind === "blank" || node.closer) && !inCard) expect(plan).toBeUndefined();
				if (!plan) {
					refused++;
					continue;
				}
				moves++;
				// The two cards are apart, in order, and inside the parent.
				expect(plan.a.end).toBeLessThan(plan.b.start);
				expect(plan.a.start).toBeGreaterThanOrEqual(parent.kind === "file" ? 1 : parent.start + 1);
				expect(plan.b.end).toBeLessThanOrEqual(parent.end);
				const first = lines[node.start - 1]!;
				const after = moved(lines, plan);
				// Every line is still there, once.
				expect([...after].sort()).toEqual(sorted);
				// The node's first line is where the move says it is: that is where the cursor goes.
				expect(after[plan.line - 1]).toBe(first);
				// And the text is still the same units, each in one piece: every doc block directly above the
				// procedure it was above, with the annotation and the blank line that stood between them.
				units = readBack(after, known);
				expect(units.flatMap(flat)).toEqual(after);
				// The card moved one place among its siblings, in the direction asked.
				expect(direction > 0 ? plan.line > node.start : plan.line < node.start).toBe(true);
				lines = after;
			}
		}
		// The fuzz does move things, and does meet nodes that cannot be moved.
		expect(moves).toBeGreaterThan(1000);
		expect(refused).toBeGreaterThan(200);
	});

	test("the same fuzz catches a move worked out node by node, as it was", () => {
		// The move as the view used to make it: the node's own lines swapped with the next node's.
		let broken = 0;
		for (let seed = 1; seed <= 400 && !broken; seed++) {
			const { units } = fuzzFile(seed);
			const known = new Map<string, Unit>();
			const learn = (u: Unit) => (u.kind !== "blank" && known.set(u.head[0]!, u), u.children.forEach(learn));
			units.forEach(learn);
			const lines = units.flatMap(flat);
			const root = treeFromSyntax(lines, syntaxOf(units, 1), () => []);
			for (const node of root.children.filter((c) => c.kind === "procedure")) {
				const other = neighbour(root, node, 1);
				if (!other) continue;
				try {
					readBack(moved(lines, { a: node, b: other }), known);
				} catch {
					broken++;
				}
			}
		}
		expect(broken).toBeGreaterThan(0);
	});
});

describe("Blocks — a change that cannot be made says why (finding 3)", () => {
	test("the reason follows the language server's state", () => {
		expect(staleReason("running")).toBe("reading");
		expect(staleReason("starting")).toBe("starting");
		expect(staleReason("restarting")).toBe("starting");
		expect(staleReason("stopped")).toBe("stopped");
		expect(staleReason("failed")).toBe("stopped");
	});

	test("an inline edit is said to be kept open, a move or a delete to have changed nothing", () => {
		for (const reason of ["starting", "stopped", "reading"] as const) {
			expect(staleNotice(reason, "edit")).toContain("It is kept open");
			expect(staleNotice(reason, "edit")).toContain("Escape");
			expect(staleNotice(reason, "change")).toContain("Nothing was changed");
			expect(staleNotice(reason, "change")).not.toContain("kept open");
		}
		expect(staleNotice("stopped", "change")).toContain("language server is not running");
		expect(staleNotice("stopped", "edit")).toContain("restart the server from the status bar");
		expect(staleNotice("starting", "change")).toContain("still starting");
		expect(staleNotice("reading", "edit")).toContain("still being read");
	});

	test("BlocksView is wired to it (source only: the view needs a DOM and Monaco to run)", () => {
		const src = readSrc("src/view/blocks/BlocksView.tsx");
		// An inline edit checks the tree before it closes the editor, and says why when it stays open.
		const edit = between(src, "const commitEdit = (n: Node, text: string) => {", "const drop = (e: DragEvent, line: number) => {");
		expect(edit.indexOf("if (!isTreeFresh(model) || !within(n)) {")).toBeGreaterThan(0);
		expect(edit.indexOf("if (!isTreeFresh(model) || !within(n)) {")).toBeLessThan(edit.indexOf("\n\t\tsetEditing(null);"));
		expect(edit).toContain('notify(staleNotice(staleReason(state.lsp.state, session.answering), "edit"))');
		const condition = between(src, "const commitCondition = (n: Node, value: string) => {", "const commitEdit = (n: Node, text: string) => {");
		expect(condition.indexOf("if (!isTreeFresh(model))")).toBeLessThan(condition.indexOf("\n\t\tsetEditing(null);"));
		expect(condition).toContain('notify(staleNotice(staleReason(state.lsp.state, session.answering), "edit"))');
		// An edit kept open is not closed by opening another, and Escape drops it from anywhere in the view.
		expect(src).toContain('if (open && open !== key) return notify("Another edit is still open here. Confirm it, or press Escape to drop it, first.");');
		expect(src).not.toContain("onDblClick={() => setEditing(p.node.key)}");
		expect(src).toContain('if (editing() && e.key === "Escape") return e.preventDefault(), e.stopPropagation(), void setEditing(null);');
		// Move, wrap, delete and drop go through the check that says why.
		expect(src).toContain('if (open) notify(staleNotice(staleReason(state.lsp.state, session.answering), "change"));');
		for (const [from, to] of [
			["const move = async (n: Node, direction: -1 | 1) => {", "const wrap = async (n: Node) => {"],
			["const wrap = async (n: Node) => {", "const remove = async (n: Node) => {"],
			["const remove = async (n: Node) => {", "const opened = ("],
			["const drop = (e: DragEvent, line: number) => {", "const dropZone = "],
		] as const) {
			expect(between(src, from, to)).toContain("if (!canChange(model)");
		}
	});

	test("BlocksView moves, wraps and deletes by card, and selects what it moved (source only, as above)", () => {
		const src = readSrc("src/view/blocks/BlocksView.tsx");
		const move = between(src, "const move = async (n: Node, direction: -1 | 1) => {", "const wrap = async (n: Node) => {");
		expect(move).toContain("cardMove(parent, n, direction)");
		expect(move).toContain("swapLines(model.getLinesContent(), step.a, step.b)");
		// The cursor is put on the moved block after the replace and its range format, before the tree is read again.
		const [format, select, reread] = [move.indexOf("await formatLines(swapped.start, swapped.end, raw);"), move.indexOf("select({ start: line, end: line + height });"), move.indexOf("editedHere();")];
		expect(format).toBeGreaterThan(0);
		expect(select).toBeGreaterThan(format);
		expect(reread).toBeGreaterThan(select);
		expect(move).toContain("const line = step.line + (direction > 0 ? model.getLineCount() - linesBefore : 0);");
		const wrap = between(src, "const wrap = async (n: Node) => {", "const remove = async (n: Node) => {");
		expect(wrap).toContain("cardOf(parent, n)");
		expect(wrap).toContain("replaceLines(card.start, card.end, `/* region ${name};\\n${body}\\n/* endregion;`, false);");
		const remove = between(src, "const remove = async (n: Node) => {", "const opened = (");
		expect(remove).toContain('n.kind === "procedure" && parent ? cardOf(parent, n)');
		expect(remove).toContain("replaceLines(card.start, card.end, null, false);");
	});
});

// --- Workspace search: a scan cut short by its time budget says so -------------------------------------------

const tmpRoot = mkdtempSync(join(tmpdir(), "ssl-studio-pass3-m5-"));
afterAll(() => rmSync(tmpRoot, { recursive: true, force: true }));

describe("Workspace search — running out of time is reported (finding 4)", () => {
	const FILES = 600;
	const ws = join(tmpRoot, "search-ws");
	for (let i = 0; i < FILES; i++) {
		const dir = join(ws, `d${i % 20}`);
		mkdirSync(dir, { recursive: true });
		writeFileSync(join(dir, `f${i}.ssl`), `:PROCEDURE P${i};\nOldName(${i});\n:ENDPROC;\n`);
	}
	const withBudget = async <T>(ms: number, work: () => Promise<T>): Promise<T> => {
		const before = WorkspaceFiles.searchTimeoutMs;
		WorkspaceFiles.searchTimeoutMs = ms;
		try {
			return await work();
		} finally {
			WorkspaceFiles.searchTimeoutMs = before;
		}
	};

	/**
	 * The search with a clock that moves one tick each time it is read, so that where the budget runs out does not
	 * depend on the machine: the scan reads it once to set its deadline, once before each file, and inside a file
	 * every 64 lines (every line for a regular expression).
	 */
	const withTicks = async <T>(budget: number, work: () => Promise<T>): Promise<T> => {
		const real = performance.now;
		let tick = 0;
		performance.now = () => tick++;
		try {
			return await withBudget(budget, work);
		} finally {
			performance.now = real;
		}
	};

	test("a scan that reads every file says it did not time out", async () => {
		const files = new WorkspaceFiles(ws);
		const scan = await files.searchScan("OldName", {});
		expect(scan.timedOut).toBe(false);
		expect(scan.hits).toHaveLength(FILES);
		expect(await files.searchScan("", {})).toEqual({ hits: [], timedOut: false });
		expect(await files.searchScan("OldName", { paths: [] })).toEqual({ hits: [], timedOut: false });
	});

	test("a scan whose budget is spent before the first file says it timed out, with nothing found", async () => {
		const files = new WorkspaceFiles(ws);
		expect(await withBudget(-1, () => files.searchScan("OldName", {}))).toEqual({ hits: [], timedOut: true });
	});

	test("a scan cut short part of the way gives what it found and says there is more", async () => {
		const files = new WorkspaceFiles(ws);
		const full = (await files.searchScan("OldName", {})).hits;
		// Two ticks a file (one before it, one at its first line): a budget of ten and a half is spent after five files.
		const scan = await withTicks(10.5, () => files.searchScan("OldName", {}));
		expect(scan.timedOut).toBe(true);
		expect(scan.hits).toEqual(full.slice(0, 5));
		// On the real clock too: a couple of milliseconds stand in for the five seconds of a workspace that needs longer.
		const short = await withBudget(2, () => files.searchScan("OldName", {}));
		expect(short.timedOut).toBe(true);
		expect(short.hits).toEqual(full.slice(0, short.hits.length));
		expect(short.hits.length).toBeLessThan(FILES);
	});

	test("a budget spent inside one long file is a time-out too", async () => {
		const one = join(tmpRoot, "one-file-ws");
		mkdirSync(one, { recursive: true });
		// A match on line 11 and another on line 201 of the one file.
		writeFileSync(join(one, "long.txt"), `${"filler line\n".repeat(10)}NEEDLE early\n${"filler line\n".repeat(189)}NEEDLE late\n`);
		const files = new WorkspaceFiles(one);
		expect((await files.searchScan("NEEDLE", {})).hits.map((h) => h.line)).toEqual([11, 201]);
		// The clock is read before the file and at lines 1, 65 and 129: a budget of two and a half ends at line 65.
		const scan = await withTicks(2.5, () => files.searchScan("NEEDLE", {}));
		expect(scan.timedOut).toBe(true);
		expect(scan.hits.map((h) => h.line)).toEqual([11]);
		// A regular expression reads it at every line: the same budget ends at the second line.
		expect(await withTicks(2.5, () => files.searchScan("NEEDLE", { regex: true }))).toEqual({ hits: [], timedOut: true });
	});

	test("reaching the most that is listed is not a time-out", async () => {
		const many = join(tmpRoot, "many-ws");
		mkdirSync(many, { recursive: true });
		writeFileSync(join(many, "all.txt"), "hit\n".repeat(SEARCH_LIMIT + 50));
		const scan = await new WorkspaceFiles(many).searchScan("hit", {});
		expect(scan.timedOut).toBe(false);
		expect(scan.hits).toHaveLength(SEARCH_LIMIT);
	});

	test("search() still gives the bare list, the same hits, for the callers that only list them", async () => {
		const files = new WorkspaceFiles(ws);
		const list = await files.search("OldName", {});
		expect(Array.isArray(list)).toBe(true);
		expect(list).toEqual((await files.searchScan("OldName", {})).hits);
		expect(await withBudget(-1, () => files.search("OldName", {}))).toEqual([]);
	});

	test("the backend offers both: search as a list, searchScan with whether it timed out", async () => {
		const host: Host = { app: "test", kind: "browser", pick: async () => null, trash: async () => {}, emit: () => {}, quit: () => {} };
		const backend = createBackend(host, ws);
		try {
			await backend.ready;
			const list = await backend.api.search("OldName", {});
			expect(Array.isArray(list)).toBe(true);
			expect(list).toHaveLength(FILES);
			expect(await backend.api.searchScan("OldName", {})).toEqual({ hits: list, timedOut: false });
			expect(await withBudget(-1, () => backend.api.searchScan("OldName", {}))).toEqual({ hits: [], timedOut: true });
		} finally {
			backend.dispose();
		}
	});
});

describe("Search panel — a list that falls short is said to, and is not replaced from (finding 4)", () => {
	const found = (hits: number, truncated: boolean, timedOut: boolean) => searchShortfall({ hits, limit: SEARCH_LIMIT, truncated, timedOut });

	test("a whole list, a list at the limit, and a list from a scan that ran out of time", () => {
		expect(found(12, false, false)).toBeNull();
		expect(found(12, false, true)).toBe("time");
		expect(found(12, true, false)).toBe("limit");
		expect(found(SEARCH_LIMIT, false, false)).toBe("limit");
		// Both at once: the limit is the stronger thing to say, and either refuses the replace.
		expect(found(SEARCH_LIMIT, true, true)).toBe("limit");
	});

	test("Replace all is refused on a timed-out list as on a truncated one, each with its reason", () => {
		expect(shortfallBlocksReplace(null, SEARCH_LIMIT)).toBe("");
		expect(shortfallBlocksReplace("limit", SEARCH_LIMIT)).toBe(`There are ${SEARCH_LIMIT} results or more, and only the first are listed: narrow the search before replacing`);
		const time = shortfallBlocksReplace("time", SEARCH_LIMIT);
		expect(time).toContain("ran out of time");
		expect(time).toContain("only part of what is there is listed");
		expect(time).toContain("narrow the search before replacing");
	});

	test("the summary says the list is partial and why", () => {
		expect(shortfallCount(null, "12 results", 12, SEARCH_LIMIT)).toBe("12 results");
		expect(shortfallCount("time", "12 results", 12, SEARCH_LIMIT)).toBe("Partial results (12 results shown; the search ran out of time before every file was read)");
		expect(shortfallCount("limit", "12 results", 12, SEARCH_LIMIT)).toBe(`Partial results (12 results shown; hit ${SEARCH_LIMIT}-match limit)`);
		expect(shortfallCount("limit", `${SEARCH_LIMIT} results`, SEARCH_LIMIT, SEARCH_LIMIT)).toBe(`The first ${SEARCH_LIMIT} results`);
	});

	test("nothing found by a scan that ran out of time is not said to be nothing there", () => {
		const said = timedOutEmpty("OldName", " [tag:qa (3 docs)]");
		expect(said).toContain("Nothing found for “OldName” [tag:qa (3 docs)] in the files read before the search ran out of time");
		expect(said).toContain("did not get to every file");
		expect(said).not.toContain("Check the spelling");
	});

	test("Search.tsx is wired to it (source only: the panel needs a DOM to run)", () => {
		const src = readSrc("src/view/panels/Search.tsx");
		const run = between(src, "const run = async (overrides: RunOverrides = {}) => {", "// A search asked for from elsewhere is put in the box and run");
		expect(run).toContain("const scan = await backend.searchScan(effectiveQuery, index ? { ...backendOptions, paths: [] } : backendOptions, batch);");
		expect(run).toContain("ranOutOfTime = scan.timedOut;");
		expect(run).not.toContain("backend.search(");
		expect(run).toContain("setTimedOut(ranOutOfTime);");
		// A new search, a failed one and a change of workspace all forget the last one's time-out.
		expect(src.match(/setTimedOut\(false\);/g)?.length).toBe(3);
		expect(src).toContain("const shortfall = () => searchShortfall({ hits: hits().length, limit: SEARCH_LIMIT, truncated: truncated(), timedOut: timedOut() });");
		// The one refusal serves "Replace all" and the preview's "Apply": both ask noReplace(true) first.
		const noReplace = between(src, "const noReplace = (ignoreReplaceActive = false) => {", "const executeReplace = async (skipConfirm: boolean) => {");
		expect(noReplace).toContain("return shortfallBlocksReplace(shortfall(), SEARCH_LIMIT);");
		expect(between(src, "const executeReplace = async (skipConfirm: boolean) => {", "const startRoot")).toContain("if (replaceBusy || noReplace(true)) return;");
		expect(between(src, "const previewReplace = async () => {", "const startRoot")).toContain("if (replaceBusy || noReplace(true)) return;");
		const summary = between(src, "const summary = () => {", "const HitRow =");
		expect(summary).toContain("if (timedOut()) return timedOutEmpty(asked(), filterTail);");
		expect(summary).toContain('shortfallCount(shortfall(), count(visibleHits().length, "result"), hits().length, SEARCH_LIMIT)');
	});
});

// --- Call graph: an unfolding too large to lay out in a moment is asked about, and is not what it opens with ----

describe("Call graph — how large a picture an unfolding draws (finding 5)", () => {
	/** A workspace of `scripts` scripts in `folders` folders, each of `each` procedures calling the next. */
	const workspace = (scripts: number, each: number, folders = 4) => {
		const list: ScriptIn[] = [];
		const calls: CallIn[] = [];
		for (let s = 0; s < scripts; s++) {
			const path = `/w/src/f${s % folders}/S${s}.ssl`;
			list.push({ path, bytes: 100, procedures: Array.from({ length: each }, (_, p) => ({ name: `P${p}`, startLine: p * 10, endLine: p * 10 + 5 })) });
			for (let p = 0; p + 1 < each; p++) calls.push({ callee: procId(path, `P${p + 1}`), path, line: p * 10 + 2 });
		}
		return assemble(list, calls);
	};
	const folderOf = (path: string) => path.slice("/w/".length, path.lastIndexOf("/"));
	const all = (g: ReturnType<typeof workspace>) => ({ nodes: new Set(g.nodes.map((n) => n.id)), edges: g.edges });

	test("everything unfolded is every procedure; folded scripts and folders are one node each", () => {
		const g = workspace(30, 10);
		const shown = all(g);
		expect(pictureSize(shown, new Set())).toEqual({ nodes: 300, procedures: 300 });
		expect(pictureSize(shown, new Set(g.scripts.map((s) => s.path)))).toEqual({ nodes: 30, procedures: 0 });
		// One script unfolded among folded ones.
		const others = new Set(g.scripts.slice(1).map((s) => s.path));
		expect(pictureSize(shown, others)).toEqual({ nodes: 29 + 10, procedures: 10 });
		// Folded folders stand for their scripts, folded or not.
		expect(pictureSize(shown, new Set(), { folded: new Set(["src/f0", "src/f1", "src/f2", "src/f3"]), of: folderOf })).toEqual({ nodes: 4, procedures: 0 });
		expect(pictureSize(shown, new Set(), { folded: new Set(["src/f0"]), of: folderOf }).nodes).toBe(1 + 220);
	});

	test("a script's top level is drawn, and is not counted as a procedure", () => {
		const g = assemble([{ path: "/w/A.ssl", bytes: 1, procedures: [{ name: "P", startLine: 5, endLine: 9 }] }], [{ callee: procId("/w/A.ssl", "P"), path: "/w/A.ssl", line: 1 }]);
		const shown = { nodes: new Set([...g.nodes.map((n) => n.id), ...g.topLevel.map((p) => `${p}#`)]), edges: g.edges };
		expect(pictureSize(shown, new Set())).toEqual({ nodes: 2, procedures: 1 });
	});

	test("more than the limit is asked about first, unless as much was already said yes to", () => {
		expect(asksFirst(ASK_ABOVE)).toBe(false);
		expect(asksFirst(ASK_ABOVE + 1)).toBe(true);
		expect(asksFirst(40)).toBe(false);
		// Said yes to 720: unfolding within that picture does not ask again, a larger one does.
		expect(asksFirst(720, 720)).toBe(false);
		expect(asksFirst(700, 720)).toBe(false);
		expect(asksFirst(721, 720)).toBe(true);
		// What was agreed never lowers the limit.
		expect(asksFirst(ASK_ABOVE, 10)).toBe(false);
		expect(asksFirst(ASK_ABOVE + 1, 10)).toBe(true);
	});

	test("the question says how much would be drawn and that it may take a while", () => {
		const asked = unfoldQuestion("Unfold all", { nodes: 1442, procedures: 1440 });
		expect(asked).toBe("Unfold all? That draws 1442 nodes at once, 1440 of them procedures. Laying them out may take a while, and the window does not answer until it is done.");
		expect(unfoldQuestion("Unfold src", { nodes: 300, procedures: 0 })).toBe("Unfold src? That draws 300 nodes at once. Laying them out may take a while, and the window does not answer until it is done.");
	});

	test("kept folds that draw no more than the limit are what the graph opens with", () => {
		const g = workspace(30, 10);
		const kept = { scripts: g.scripts.slice(5).map((s) => s.path), folders: [] };
		// Five scripts open: 50 procedures and 25 folded scripts.
		expect(openingFolds(g, kept, folderOf)).toEqual(kept);
		expect(openingFolds(g, { scripts: [], folders: ["src/f0", "src/f1", "src/f2"] }, folderOf)).toEqual({ scripts: [], folders: ["src/f0", "src/f1", "src/f2"] });
	});

	test("kept folds that would draw more are not taken up: everything is folded, and how much was left is said", () => {
		const g = workspace(30, 10);
		// "Unfold all" was kept: 300 procedures at once, at every visit.
		const opening = openingFolds(g, { scripts: [], folders: [] }, folderOf);
		expect(opening.refused).toEqual({ nodes: 300, procedures: 300 });
		expect(opening.scripts).toEqual(g.scripts.map((s) => s.path));
		expect(opening.folders.sort()).toEqual(["src/f0", "src/f1", "src/f2", "src/f3"]);
		// What it opens with instead is small.
		expect(pictureSize(all(g), new Set(opening.scripts), { folded: new Set(opening.folders), of: folderOf })).toEqual({ nodes: 4, procedures: 0 });
		expect(openedFoldedNote(opening.refused!)).toBe("The call graph was left unfolded to 300 nodes, 300 of them procedures: more than is laid out without asking. It is opened folded; unfold what you need.");
		// In one folder there are no folders to fold: the scripts are.
		const flatWs = workspace(30, 10, 1);
		expect(openingFolds(flatWs, { scripts: [], folders: [] }, folderOf)).toMatchObject({ scripts: flatWs.scripts.map((s) => s.path), folders: [] });
	});

	test("with nothing kept, the opening picture is as it was: a large workspace folded, a small one open", () => {
		const small = workspace(4, 5);
		expect(openingFolds(small, null, folderOf)).toEqual({ scripts: [], folders: [] });
		// More than 40 procedures: the scripts are folded; 24 scripts or fewer: the folders are not.
		const mid = workspace(10, 10);
		expect(openingFolds(mid, null, folderOf)).toEqual({ scripts: mid.scripts.map((s) => s.path), folders: [] });
		const large = workspace(30, 10);
		const opening = openingFolds(large, null, folderOf);
		expect(opening.scripts).toHaveLength(30);
		expect(opening.folders.sort()).toEqual(["src/f0", "src/f1", "src/f2", "src/f3"]);
		expect(opening.refused).toBeUndefined();
	});

	test("targets that are not shown are not counted against kept folds", () => {
		const g = workspace(25, 10);
		// 250 procedures and one target the server could not resolve: over the limit only when it is drawn.
		const withTarget = { ...g, nodes: [...g.nodes, { id: "(unresolved)#Gone", name: "Gone", path: "(unresolved)", line: 0, kind: "unresolved" as const }] };
		const kept = { scripts: [], folders: [] };
		expect(openingFolds(withTarget, kept, folderOf, false).refused).toBeUndefined();
		expect(openingFolds(withTarget, kept, folderOf, true).refused).toEqual({ nodes: 251, procedures: 251 });
	});

	test("GraphView is wired to it (source only: the view needs a DOM and a layout to run)", () => {
		const src = readSrc("src/view/graph/GraphView.tsx");
		// Unfolding asks first: all at once, one script, one folder.
		const ask = between(src, "const unfoldAsk = (", "const toggleFold = (");
		expect(ask).toContain("const size = pictureSize(keep, scripts, { folded: dirs, of: folderOf });");
		expect(ask).toContain("if (!asksFirst(size.nodes, agreedNodes)) return null;");
		expect(ask).toContain('chooseAnswer(unfoldQuestion(what, size), ["Unfold"])');
		expect(between(src, "const foldAll = (all: boolean, asked = false) => {", "fittedFor = \"\";")).toContain('unfoldAsk("Unfold all", new Set(), new Set())');
		expect(between(src, "const toggleFold = (", "const toggleDir = (")).toContain("unfoldAsk(`Unfold ${baseName(path)}`, next, foldedDirs())");
		expect(between(src, "const toggleDir = (", "const folderAt = ")).toContain("unfoldAsk(`Unfold ${folder}`, folded(), next)");
		// The folds are kept in one place only: after the picture drawn with them has been laid out.
		expect(src.match(/remember\(`\$\{FOLDS_KEY\}:\$\{root\}`/g)?.length).toBe(1);
		const laidOut = between(src, "setLayout({ boxes, lines, width: result.width, height: result.height, key: layoutKey });", "showNext = null;");
		expect(laidOut).toContain("if (canFold && root && foldedFor === root) remember(`${FOLDS_KEY}:${root}`, drewFolds);");
		expect(src).toContain("const drewFolds = untrack(() => JSON.stringify({ scripts: [...folded()], folders: [...foldedDirs()] }));");
		// And what was kept is weighed before it is taken up.
		expect(src).toContain("const opening = openingFolds(read, keptFolds(recall(`${FOLDS_KEY}:${startRoot}`)), folderOf, unresolved());");
		expect(src).toContain("if (opening.refused) notify(openedFoldedNote(opening.refused));");
	});
});
