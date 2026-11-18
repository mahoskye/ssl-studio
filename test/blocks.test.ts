import { describe, expect, test } from "bun:test";
import { buildTree, coveredLines, neighbour, pathTo, swapLines, type FoldIn, type Node, type SymbolIn } from "../src/view/blocks/model";
import data from "./data/structure.json";

const toSymbols = (list: any[]): SymbolIn[] =>
	list.map((s) => ({ name: s.name, kind: s.kind, startLine: s.range.start.line, endLine: s.range.end.line, children: toSymbols(s.children ?? []) }));

const tree = (name: string) => {
	const f = (data as any).files[name];
	const lines = f.text.split(/\r?\n/);
	return { lines, root: buildTree(lines, toSymbols(f.symbols), f.folds as FoldIn[]) };
};

const kinds = (n: Node): any => {
	const label = `${n.kind} ${n.name ?? ""}`.trim();
	const inner = n.children.filter((c) => c.kind !== "blank" && c.kind !== "text");
	return inner.length ? { [label]: inner.map(kinds) } : label;
};

describe("blocks tree from the recorded server data", () => {
	for (const name of Object.keys((data as any).files))
		test(`${name}: every line, once, in order`, () => {
			const { lines, root } = tree(name);
			expect(coveredLines(root)).toEqual(lines.map((_: string, i: number) => i + 1));
		});

	test("regions hold procedures, procedures hold control flow", () => {
		const { root } = tree("Regions.ssl");
		expect(kinds(root)).toEqual({
			file: [
				"comment",
				{ "region Validation": ["comment", { "procedure IsUsableId": ["block"] }] },
				{ "region Labels": ["comment", { "procedure StatusLabel": ["block"] }] },
				"block",
			],
		});
		const proc = root.children.find((c) => c.name === "Validation")!.children.find((c) => c.kind === "procedure")!;
		expect(proc.params).toEqual(["sSampleId"]);
	});

	test("the path to a line", () => {
		const { lines, root } = tree("Regions.ssl");
		const line = lines.findIndex((l: string) => l.includes(":RETURN .F.")) + 1;
		expect(pathTo(root, line).map((n) => n.kind)).toEqual(["region", "procedure", "block", "text"]);
	});
});

test("overlapping ranges do not break coverage", () => {
	const lines = ["a", "b", "c", "d", "e"];
	const root = buildTree(lines, [], [
		{ startLine: 0, endLine: 2 },
		{ startLine: 1, endLine: 3 },
		{ startLine: 4, endLine: 9 },
	]);
	expect(coveredLines(root)).toEqual([1, 2, 3, 4, 5]);
});

test("swapping siblings keeps what is between them", () => {
	const lines = ["p1", "p1 end", "", "p2", "p2 end"];
	expect(swapLines(lines, { start: 1, end: 2 }, { start: 4, end: 5 })).toEqual({ start: 1, end: 5, lines: ["p2", "p2 end", "", "p1", "p1 end"] });
	const { root } = tree("Regions.ssl");
	const [, validation, labels] = root.children.filter((c) => c.kind !== "blank");
	expect(neighbour(root, validation!, 1)).toBe(labels);
});

import { procedureGroups, splitHeader, treeFromSyntax, type SyntaxNodeIn } from "../src/view/blocks/model";

describe("blocks tree from ssl/syntaxTree (shape version 1)", () => {
	const r = (a: number, b: number, endChar = 9) => ({ start: { line: a, character: 0 }, end: { line: b, character: endChar } });
	const lines = [
		"/* banner;", // 0
		"", // 1
		"/* region R;", // 2
		":PROCEDURE P;", // 3
		":PARAMETERS a, b;", // 4
		":IF a > b;", // 5
		"x := a;", // 6
		":ELSE;", // 7
		"x := b;", // 8
		":ENDIF;", // 9
		":RETURN x;", // 10
		":ENDPROC;", // 11
		"/* endregion;", // 12
		"junk (((", // 13
	];
	// As the server builds it: if holds branches, the IF branch opening on the if's line.
	const tree: SyntaxNodeIn[] = [
		{ kind: "banner", range: r(0, 0) },
		{ kind: "blankLines", range: r(1, 1, 0) },
		{
			kind: "region",
			name: "R",
			range: r(2, 12),
			children: [
				{
					kind: "procedure",
					keyword: "PROCEDURE",
					name: "P",
					range: r(3, 11),
					children: [
						{ kind: "parameters", keyword: "PARAMETERS", range: r(4, 4) },
						{
							kind: "if",
							range: r(5, 9),
							closerRange: r(9, 9),
							children: [
								{ kind: "branch", keyword: "IF", range: r(5, 6), headerRange: r(5, 5), children: [{ kind: "statement", range: r(6, 6) }] },
								{ kind: "branch", keyword: "ELSE", range: r(7, 8), headerRange: r(7, 7), children: [{ kind: "statement", range: r(8, 8) }] },
							],
						},
						{ kind: "statement", range: r(10, 10) },
					],
				},
			],
		},
		{ kind: "error", range: r(13, 13) },
	];
	const params = (name: string) => (name === "P" ? ["a", "b"] : undefined);
	test("covers every line once", () => {
		expect(coveredLines(treeFromSyntax(lines, tree, params))).toEqual(lines.map((_, i) => i + 1));
	});
	test("statements, arms and errors become their own blocks", () => {
		const root = treeFromSyntax(lines, tree, params);
		expect(root.children.map((c) => c.kind)).toEqual(["comment", "blank", "region", "raw"]);
		const proc = root.children.find((c) => c.kind === "region")!.children.find((c) => c.kind === "procedure")!;
		expect(proc.params).toEqual(["a", "b"]);
		expect(proc.children.filter((c) => c.kind !== "blank").map((c) => c.kind)).toEqual(["text", "block", "text", "text"]);
		const ifBlock = proc.children.find((c) => c.kind === "block")!;
		// IF body, the ELSE arm, then the :ENDIF line.
		expect(ifBlock.children.map((c) => `${c.kind}:${c.start}`)).toEqual(["text:7", "block:8", "text:10"]);
	});
	test("blocks carry their one-line header, the IF's from its first branch", () => {
		const root = treeFromSyntax(lines, tree, params);
		const proc = root.children.find((c) => c.kind === "region")!.children.find((c) => c.kind === "procedure")!;
		const ifBlock = proc.children.find((c) => c.kind === "block")!;
		expect(ifBlock.header).toEqual({ line: 6, startColumn: 1, endColumn: 10, keyword: "IF" });
		expect(ifBlock.children.find((c) => c.kind === "block")!.header?.keyword).toBe("ELSE");
		expect(proc.header).toBeUndefined();
	});
	test("an unknown kind degrades to a block or a chip", () => {
		const root = treeFromSyntax(["a", "b", "c"], [{ kind: "somethingNew", range: r(0, 2), children: [{ kind: "alsoNew", range: r(1, 1) }] }]);
		expect(root.children[0]!.kind).toBe("block");
		expect(coveredLines(root)).toEqual([1, 2, 3]);
	});
});

describe("a block header's condition", () => {
	// Header texts as starlims-lsp 0.29.0 reports them (headerRange, end exclusive).
	test("splits around what follows the keyword", () => {
		expect(splitHeader(":IF a > b;", "IF")).toEqual({ before: ":IF ", condition: "a > b", after: ";" });
		expect(splitHeader(":WHILE  nI < 10 ;", "WHILE")).toEqual({ before: ":WHILE  ", condition: "nI < 10", after: " ;" });
		expect(splitHeader(":FOR nI := 1 :TO 10;", "FOR")?.condition).toBe("nI := 1 :TO 10");
		expect(splitHeader(":if lower_case;", "IF")?.condition).toBe("lower_case");
	});
	test("keeps a semicolon inside a string", () => {
		expect(splitHeader(':IF a > b .AND. s = "x;y";', "IF")?.condition).toBe('a > b .AND. s = "x;y"');
	});
	test("has nothing to edit after :ELSE, :OTHERWISE or :BEGINCASE", () => {
		expect(splitHeader(":ELSE;", "ELSE")).toBeNull();
		expect(splitHeader(":OTHERWISE;", "OTHERWISE")).toBeNull();
		expect(splitHeader(":BEGINCASE;", "BEGINCASE")).toBeNull();
	});
	test("refuses text that is not that keyword's statement", () => {
		expect(splitHeader(":IFX a;", "IF")).toBeNull();
		expect(splitHeader(":IF a", "IF")).toBeNull();
	});
});

// The shape the server gives for a class file (starlims-lsp 0.30.0, examples/due-dates RushDueRule):
// `:CLASS` and `:INHERIT` are statements with those keywords, and the comment above a procedure is a docBlock.
describe("a class file", () => {
	const span = (from: number, to: number, endChar = 0) => ({ start: { line: from - 1, character: 0 }, end: { line: to - 1, character: endChar } });
	const lines = [
		"/* A class;", //                    1 banner
		"", //                               2
		":CLASS RushDueRule;", //            3
		":INHERIT DueDates.DueRule;", //     4
		"", //                               5
		":DECLARE nDays;", //                6
		"", //                               7
		"/*", //                             8 doc block
		" * Procedure: CountsSaturday", //   9
		";", //                             10
		"/*@private;", //                   11
		":PROCEDURE CountsSaturday;", //    12
		"\t:RETURN .T.;", //               13
		":ENDPROC;", //                     14
		"", //                              15
		"/* a loose comment;", //           16
		":PROCEDURE Describe;", //          17
		":ENDPROC;", //                     18
	];
	const tree: SyntaxNodeIn[] = [
		{ kind: "banner", range: span(1, 1, 11) },
		{ kind: "blankLines", range: span(2, 2) },
		{ kind: "statement", keyword: "CLASS", range: span(3, 3, 19) },
		{ kind: "statement", keyword: "INHERIT", range: span(4, 4, 26) },
		{ kind: "blankLines", range: span(5, 5) },
		{ kind: "statement", keyword: "DECLARE", range: span(6, 6, 15) },
		{ kind: "blankLines", range: span(7, 7) },
		{ kind: "docBlock", range: span(8, 10, 1) },
		{ kind: "comment", range: span(11, 11, 11) },
		{ kind: "procedure", keyword: "PROCEDURE", name: "CountsSaturday", range: span(12, 14, 9), children: [{ kind: "statement", keyword: "RETURN", range: span(13, 13, 13) }] },
		{ kind: "blankLines", range: span(15, 15) },
		{ kind: "comment", range: span(16, 16, 19) },
		{ kind: "procedure", keyword: "PROCEDURE", name: "Describe", range: span(17, 18, 9) },
	];
	const root = () => treeFromSyntax(lines, tree);

	test("still covers every line once", () => {
		expect(coveredLines(root())).toEqual(lines.map((_, i) => i + 1));
	});

	test("the :CLASS line heads one block, holding what it inherits and its fields", () => {
		const head = root().children.find((c) => c.classHead)!;
		expect(head).toMatchObject({ kind: "block", start: 3, end: 6, header: { line: 3, startColumn: 1, endColumn: 20, keyword: "CLASS" } });
		expect(head.children.map((c) => `${c.kind}:${c.keyword ?? ""}:${c.start}`)).toEqual(["text:INHERIT:4", "blank::5", "text:DECLARE:6"]);
		// The blank line after the last field is not part of the head.
		expect(root().children.map((c) => c.kind)).toEqual(["comment", "blank", "block", "blank", "comment", "comment", "procedure", "blank", "comment", "procedure"]);
	});

	test("the head's name is the field after its keyword, as a block's condition is", () => {
		expect(splitHeader(lines[2]!, "CLASS")).toMatchObject({ before: ":CLASS ", condition: "RushDueRule" });
	});

	test("a doc block is drawn with its procedure, and the annotation between them", () => {
		const groups = procedureGroups(root().children).map((g) => g.map((n) => `${n.kind}${n.doc ? "(doc)" : ""}:${n.start}`));
		expect(groups).toContainEqual(["comment(doc):8", "comment:11", "procedure:12"]);
		// A comment the server does not call a doc block stays on its own, even right above a procedure.
		expect(groups).toContainEqual(["comment:16"]);
		expect(groups).toContainEqual(["procedure:17"]);
		// Grouping is for drawing only: every node is in exactly one group, in order.
		expect(procedureGroups(root().children).flat()).toEqual(root().children);
	});

	test("a script that is not a class has no class head", () => {
		expect(treeFromSyntax([":DECLARE a;", "a := 1;"], [{ kind: "statement", keyword: "DECLARE", range: span(1, 1, 11) }, { kind: "statement", range: span(2, 2, 7) }]).children.some((c) => c.classHead)).toBe(false);
	});
});
