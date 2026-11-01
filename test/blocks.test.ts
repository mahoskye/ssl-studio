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
