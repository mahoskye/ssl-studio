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

import { treeFromSyntax, type SyntaxNodeIn } from "../src/view/blocks/model";

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
	test("an unknown kind degrades to a block or a chip", () => {
		const root = treeFromSyntax(["a", "b", "c"], [{ kind: "somethingNew", range: r(0, 2), children: [{ kind: "alsoNew", range: r(1, 1) }] }]);
		expect(root.children[0]!.kind).toBe("block");
		expect(coveredLines(root)).toEqual([1, 2, 3]);
	});
});
