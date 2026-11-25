import { afterAll, describe, expect, mock, test } from "bun:test";
import { resolve } from "node:path";
import { coveredLines, neighbour, treeFromSyntax, type SyntaxNodeIn } from "../src/view/blocks/model";
import { zoomAt } from "../src/view/graph/canvas";
import { assemble, foldId, fromCallGraph, procId, scriptOf, visible, type Graph } from "../src/view/graph/model";

// --- Compatible headless browser & Monaco shims (mirrors r2aLspAndMonaco / r2cEditorTabsState) ---
const savedGlobals = {
	window: (globalThis as any).window,
	document: (globalThis as any).document,
	self: (globalThis as any).self,
	getComputedStyle: (globalThis as any).getComputedStyle,
	XMLSerializer: (globalThis as any).XMLSerializer,
};

if (typeof (globalThis as any).window === "undefined") {
	(globalThis as any).window = {
		Error,
		Map,
		Set,
		addEventListener() {},
		removeEventListener() {},
		location: { href: "http://localhost/", protocol: "http:", host: "127.0.0.1:5190" },
		matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
	};
} else {
	if (!(globalThis as any).window.Error) (globalThis as any).window.Error = Error;
	if (!(globalThis as any).window.Map) (globalThis as any).window.Map = Map;
	if (!(globalThis as any).window.Set) (globalThis as any).window.Set = Set;
}
if (typeof (globalThis as any).document === "undefined") {
	(globalThis as any).document = {
		documentElement: { dataset: {}, style: {} },
		createElement: () => ({ style: {} }),
		querySelector: () => null,
	};
}
if (typeof (globalThis as any).self === "undefined") {
	(globalThis as any).self = globalThis;
}

class MockRange {
	constructor(
		public startLineNumber: number,
		public startColumn: number,
		public endLineNumber: number,
		public endColumn: number,
	) {}
}

class MockUri {
	readonly scheme: string;
	readonly path: string;
	readonly fsPath: string;
	constructor(scheme: string, path: string) {
		this.scheme = scheme;
		this.path = path;
		this.fsPath = path;
	}
	toString() {
		return this.scheme === "file" ? `file://${encodeURI(this.path)}` : `${this.scheme}:${this.path}`;
	}
	static file(p: string) {
		return new MockUri("file", p.replace(/\\/g, "/"));
	}
	static parse(raw: string) {
		if (raw.startsWith("file://")) return new MockUri("file", decodeURI(raw.slice("file://".length)));
		const idx = raw.indexOf(":");
		return idx >= 0 ? new MockUri(raw.slice(0, idx), raw.slice(idx + 1)) : new MockUri("file", raw);
	}
	static from(parts: { scheme: string; path?: string }) {
		return new MockUri(parts.scheme, parts.path ?? "/");
	}
}

const noopProxy = (extra: Record<string, any> = {}) =>
	new Proxy(extra, { get: (target, prop) => (prop in target ? target[prop as any] : () => ({ dispose() {} })) });

mock.module("monaco-editor/editor/editor.api", () => ({
	Range: MockRange,
	Position: class {
		constructor(
			public lineNumber: number,
			public column: number,
		) {}
	},
	Emitter: class {
		event = () => ({ dispose() {} });
		fire() {}
		dispose() {}
	},
	Uri: MockUri,
	MarkerSeverity: { Hint: 1, Info: 2, Warning: 4, Error: 8 },
	KeyMod: { CtrlCmd: 2048, Shift: 1024, Alt: 512 },
	KeyCode: {},
	languages: noopProxy({
		CompletionItemKind: { Text: 0, Method: 1, Function: 2, Constructor: 3, Field: 4, Variable: 5, Class: 6, Interface: 7, Module: 8, Property: 9, Unit: 10, Value: 11, Enum: 12, Keyword: 13, Snippet: 14, Color: 15, File: 16, Reference: 17, Folder: 18, EnumMember: 19, Constant: 20, Struct: 21, Event: 22, Operator: 23, TypeParameter: 24 },
		CompletionItemInsertTextRule: { InsertAsSnippet: 4 },
		FoldingRangeKind: { Comment: { value: "comment" }, Imports: { value: "imports" }, Region: { value: "region" } },
		SymbolKind: { Namespace: 2, Class: 4, Method: 5, Function: 11 },
	}),
	editor: noopProxy({
		getEditors: () => [],
		ScrollType: { Immediate: 1 },
		getModels: () => [],
		getModel: () => null,
		setModelMarkers: () => {},
		getModelMarkers: () => [],
	}),
}));
mock.module("monaco-editor/features/register.all", () => ({}));
mock.module("monaco-editor/editor/contrib/semanticTokens/browser/documentSemanticTokens", () => ({}));
mock.module("monaco-editor/editor/editor.worker?worker", () => ({ default: class {} }));
mock.module(`${resolve(import.meta.dir, "../src/view/editor/markdownLive.worker.ts")}?worker`, () => ({ default: class {} }));

const { pictureOf } = await import("../src/view/graph/picture");
const { loadGraph } = await import("../src/view/graph/load");
const { LspSession } = await import("../src/view/lsp/session");

afterAll(() => {
	(globalThis as any).getComputedStyle = savedGlobals.getComputedStyle;
	(globalThis as any).XMLSerializer = savedGlobals.XMLSerializer;
});

// --- 1. Blocks model repairs -----------------------------------------------------

describe("R3A blocks/model — closer lines and neighbour()", () => {
	const r = (a: number, b: number, endChar = 12) => ({
		start: { line: a, character: 0 },
		end: { line: b, character: endChar },
	});

	const lines = [
		"/* region Core;", // 0 (line 1)
		":PROCEDURE Compute;", // 1 (line 2)
		":IF nVal > 0;", // 2 (line 3)
		"nVal := nVal + 1;", // 3 (line 4)
		":ENDIF;", // 4 (line 5)
		":WHILE nVal > 0;", // 5 (line 6)
		"nVal := nVal - 1;", // 6 (line 7)
		":ENDWHILE;", // 7 (line 8)
		":RETURN nVal;", // 8 (line 9)
		":ENDPROC;", // 9 (line 10)
		"/* endregion;", // 10 (line 11)
	];

	const syntax: SyntaxNodeIn[] = [
		{
			kind: "region",
			name: "Core",
			range: r(0, 10),
			closerRange: r(10, 10),
			children: [
				{
					kind: "procedure",
					keyword: "PROCEDURE",
					name: "Compute",
					range: r(1, 9),
					closerRange: r(9, 9),
					children: [
						{
							kind: "if",
							range: r(2, 4),
							closerRange: r(4, 4),
							children: [
								{
									kind: "branch",
									keyword: "IF",
									range: r(2, 3),
									headerRange: r(2, 2),
									children: [{ kind: "statement", range: r(3, 3) }],
								},
							],
						},
						{
							kind: "while",
							keyword: "WHILE",
							range: r(5, 7),
							headerRange: r(5, 5),
							closerRange: r(7, 7),
							children: [{ kind: "statement", range: r(6, 6) }],
						},
						{ kind: "statement", keyword: "RETURN", range: r(8, 8) },
					],
				},
			],
		},
	];

	test("marks closerRange lines as closer: true while preserving exact line coverage", () => {
		const root = treeFromSyntax(lines, syntax);
		expect(coveredLines(root)).toEqual(lines.map((_, i) => i + 1));

		const region = root.children[0]!;
		const endRegion = region.children.at(-1)!;
		expect(endRegion).toMatchObject({ kind: "text", start: 11, end: 11, closer: true });

		const proc = region.children.find((c) => c.kind === "procedure")!;
		const endProc = proc.children.at(-1)!;
		expect(endProc).toMatchObject({ kind: "text", start: 10, end: 10, closer: true });

		const ifBlock = proc.children.find((c) => c.kind === "block" && c.start === 3)!;
		const endIf = ifBlock.children.at(-1)!;
		expect(endIf).toMatchObject({ kind: "text", start: 5, end: 5, closer: true });

		const whileBlock = proc.children.find((c) => c.kind === "block" && c.start === 6)!;
		const endWhile = whileBlock.children.at(-1)!;
		expect(endWhile).toMatchObject({ kind: "text", start: 8, end: 8, closer: true });
	});

	test("neighbour() refuses to swap any sibling past a closer line or move a closer itself", () => {
		const root = treeFromSyntax(lines, syntax);
		const region = root.children[0]!;
		const proc = region.children.find((c) => c.kind === "procedure")!;
		const endRegion = region.children.at(-1)!;
		const endProc = proc.children.at(-1)!;
		const retStmt = proc.children.find((c) => c.start === 9)!;
		const whileBlock = proc.children.find((c) => c.kind === "block" && c.start === 6)!;
		const whileBody = whileBlock.children.find((c) => c.start === 7)!;
		const endWhile = whileBlock.children.at(-1)!;
		const ifBlock = proc.children.find((c) => c.kind === "block" && c.start === 3)!;
		const ifBody = ifBlock.children.find((c) => c.start === 4)!;
		const endIf = ifBlock.children.at(-1)!;

		// Moving the last real child down must never cross the container's closer.
		expect(neighbour(region, proc, 1)).toBeUndefined();
		expect(neighbour(proc, retStmt, 1)).toBeUndefined();
		expect(neighbour(whileBlock, whileBody, 1)).toBeUndefined();
		expect(neighbour(ifBlock, ifBody, 1)).toBeUndefined();

		// Moving a closer node itself in either direction must always be refused (no index === -1 wraparound!).
		for (const [parent, closer] of [
			[region, endRegion],
			[proc, endProc],
			[whileBlock, endWhile],
			[ifBlock, endIf],
		] as const) {
			expect(neighbour(parent, closer, -1)).toBeUndefined();
			expect(neighbour(parent, closer, 1)).toBeUndefined();
		}

		// Normal siblings above the closer can still swap with each other.
		expect(neighbour(proc, retStmt, -1)).toBe(whileBlock);
		expect(neighbour(proc, whileBlock, 1)).toBe(retStmt);
		expect(neighbour(proc, ifBlock, 1)).toBe(whileBlock);
	});

	test("keeps an uncovered statement before a closer line separate from the closer leaf", () => {
		const gapLines = [":PROCEDURE Demo;", "nA := 1;", "nB := 2;", ":ENDPROC;"];
		// Server omits statement children so lines 2..4 are all filled by gap(), with closerRange on line 4.
		const root = treeFromSyntax(gapLines, [
			{
				kind: "procedure",
				name: "Demo",
				range: r(0, 3),
				closerRange: r(3, 3),
				children: [],
			},
		]);
		const proc = root.children[0]!;
		expect(coveredLines(root)).toEqual([1, 2, 3, 4]);
		expect(proc.children).toHaveLength(2);
		expect(proc.children[0]).toMatchObject({ kind: "text", start: 2, end: 3 });
		expect(proc.children[0]!.closer).toBeUndefined();
		expect(proc.children[1]).toMatchObject({ kind: "text", start: 4, end: 4, closer: true });
		expect(neighbour(proc, proc.children[0]!, 1)).toBeUndefined();
	});
});

describe("R3A blocks/model — multi-line error nodes starting on previous node's end line", () => {
	test("emits a raw node for lines previous.end + 1 .. end instead of downgrading to text", () => {
		const lines = [
			":PROCEDURE Broken;", // 0 (line 1)
			"nX := 1; ???", // 1 (line 2) — statement ends on line 2, error starts on line 2
			"still broken ((", // 2 (line 3)
			"more junk ))", // 3 (line 4)
			":RETURN nX;", // 4 (line 5)
			":ENDPROC;", // 5 (line 6)
		];
		const syntax: SyntaxNodeIn[] = [
			{
				kind: "procedure",
				name: "Broken",
				range: { start: { line: 0, character: 0 }, end: { line: 5, character: 9 } },
				closerRange: { start: { line: 5, character: 0 }, end: { line: 5, character: 9 } },
				children: [
					{ kind: "statement", range: { start: { line: 1, character: 0 }, end: { line: 1, character: 8 } } },
					{ kind: "error", range: { start: { line: 1, character: 9 }, end: { line: 3, character: 12 } } },
					{ kind: "statement", keyword: "RETURN", range: { start: { line: 4, character: 0 }, end: { line: 4, character: 11 } } },
				],
			},
		];

		const root = treeFromSyntax(lines, syntax);
		expect(coveredLines(root)).toEqual([1, 2, 3, 4, 5, 6]);
		const proc = root.children[0]!;
		const rawNode = proc.children.find((c) => c.kind === "raw");
		expect(rawNode).toBeDefined();
		expect(rawNode).toMatchObject({ kind: "raw", start: 3, end: 4, key: "raw::3" });
		// Every child kind in order: statement (line 2), raw (lines 3..4), statement (line 5), closer text (line 6).
		expect(proc.children.map((c) => `${c.kind}:${c.start}-${c.end}`)).toEqual(["text:2-2", "raw:3-4", "text:5-5", "text:6-6"]);
	});

	test("drops a single-line error wholly on previous node's end line without breaking coverage", () => {
		const lines = ["nX := 1; ???", "nY := 2;"];
		const syntax: SyntaxNodeIn[] = [
			{ kind: "statement", range: { start: { line: 0, character: 0 }, end: { line: 0, character: 8 } } },
			{ kind: "error", range: { start: { line: 0, character: 9 }, end: { line: 0, character: 12 } } },
			{ kind: "statement", range: { start: { line: 1, character: 0 }, end: { line: 1, character: 8 } } },
		];
		const root = treeFromSyntax(lines, syntax);
		expect(coveredLines(root)).toEqual([1, 2]);
		expect(root.children.map((c) => `${c.kind}:${c.start}-${c.end}`)).toEqual(["text:1-1", "text:2-2"]);
	});
});

// --- 2. Graph model repairs ------------------------------------------------------

describe("R3A graph/model — assemble(), scriptOf(), and visible()", () => {
	test("assemble() adds ScriptIn for top-level-only caller scripts missing from scripts", () => {
		const inputScripts = [
			{
				path: "/w/Orders.ssl",
				bytes: 512,
				procedures: [{ name: "Count", startLine: 1, endLine: 10 }],
			},
		];
		const calls = [{ callee: procId("/w/Orders.ssl", "Count"), path: "/w/Runner.ssl", line: 2 }];

		const g = assemble(inputScripts, calls);
		// Does not mutate input array.
		expect(inputScripts).toHaveLength(1);
		expect(g.topLevel).toEqual(["/w/Runner.ssl"]);
		expect(g.scripts.map((s) => s.path)).toEqual(["/w/Orders.ssl", "/w/Runner.ssl"]);
		expect(g.scripts.find((s) => s.path === "/w/Runner.ssl")).toEqual({ path: "/w/Runner.ssl", bytes: 0, procedures: [] });
		expect(g.edges).toHaveLength(1);
		expect(g.edges[0]).toMatchObject({ from: "/w/Runner.ssl#", to: "/w/Orders.ssl#Count", crossScript: true });
	});

	test("scriptOf() handles '#' inside workspace paths and hash-less IDs without truncating", () => {
		expect(scriptOf("/ws/C#Lab/v#2/Orders.ssl#Count")).toBe("/ws/C#Lab/v#2/Orders.ssl");
		expect(scriptOf("/ws/C#Lab/v#2/Orders.ssl#")).toBe("/ws/C#Lab/v#2/Orders.ssl");
		expect(scriptOf(foldId("/ws/C#Lab/v#2/Orders.ssl"))).toBe("/ws/C#Lab/v#2/Orders.ssl");
		expect(scriptOf("/ws/Orders.ssl")).toBe("/ws/Orders.ssl");
		expect(scriptOf("")).toBe("");

		// crossScript in assemble() and fromCallGraph() uses scriptOf() instead of split('#')[0].
		const pathWithHash = "/ws/Team#1/Alpha.ssl";
		const otherWithHash = "/ws/Team#1/Beta.ssl";
		const assembled = assemble(
			[
				{
					path: pathWithHash,
					bytes: 100,
					procedures: [
						{ name: "Caller", startLine: 0, endLine: 5 },
						{ name: "Callee", startLine: 7, endLine: 12 },
					],
				},
				{
					path: otherWithHash,
					bytes: 100,
					procedures: [{ name: "Remote", startLine: 0, endLine: 5 }],
				},
			],
			[
				{ callee: procId(pathWithHash, "Callee"), path: pathWithHash, line: 2 },
				{ callee: procId(otherWithHash, "Remote"), path: pathWithHash, line: 3 },
			],
		);
		expect(assembled.edges.find((e) => e.to === procId(pathWithHash, "Callee"))?.crossScript).toBe(false);
		expect(assembled.edges.find((e) => e.to === procId(otherWithHash, "Remote"))?.crossScript).toBe(true);

		const fromCg = fromCallGraph(
			{
				nodes: [
					{ id: "s1", kind: "script", name: "Alpha", location: { uri: "file:///ws/Team%231/Alpha.ssl", range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } } } },
					{ id: "p1", kind: "procedure", name: "Caller", container: "file:///ws/Team%231/Alpha.ssl" },
					{ id: "p2", kind: "procedure", name: "Callee", container: "file:///ws/Team%231/Alpha.ssl" },
					{ id: "s2", kind: "script", name: "Beta", location: { uri: "file:///ws/Team%231/Beta.ssl", range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } } } },
					{ id: "p3", kind: "procedure", name: "Remote", container: "file:///ws/Team%231/Beta.ssl" },
				],
				edges: [
					{ from: "p1", to: "p2", kind: "DoProc", resolved: true },
					{ from: "p1", to: "p3", kind: "ExecFunction", resolved: true },
				],
			},
			(uri) => decodeURIComponent(uri.replace("file://", "")),
		);
		expect(fromCg.edges.find((e) => e.to.endsWith("#Callee"))?.crossScript).toBe(false);
		expect(fromCg.edges.find((e) => e.to.endsWith("#Remote"))?.crossScript).toBe(true);
	});

	test("visible() clamps extreme depths, terminates immediately on empty frontier, and never pulls disconnected orphans from B#", () => {
		const graph: Graph = {
			scripts: [
				{ path: "/w/A.ssl", bytes: 100, procedures: [{ name: "Main", startLine: 0, endLine: 5 }] },
				{ path: "/w/B.ssl", bytes: 100, procedures: [{ name: "Unrelated", startLine: 0, endLine: 5 }] },
				{ path: "/w/C.ssl", bytes: 100, procedures: [{ name: "Orphan", startLine: 0, endLine: 5 }] },
				{ path: "/w/Base.ssl", bytes: 100, procedures: [] },
			],
			nodes: [
				{ id: "/w/A.ssl#Main", name: "Main", path: "/w/A.ssl", line: 0 },
				{ id: "/w/B.ssl#Unrelated", name: "Unrelated", path: "/w/B.ssl", line: 0 },
				{ id: "/w/C.ssl#Orphan", name: "Orphan", path: "/w/C.ssl", line: 0 },
			],
			edges: [
				// A#Main creates/includes B#, and B# inherits Base#; meanwhile B#Unrelated calls C#Orphan.
				{ from: "/w/A.ssl#Main", to: "/w/B.ssl#", crossScript: true, kind: "CreateUdObject", sites: [] },
				{ from: "/w/B.ssl#", to: "/w/Base.ssl#", crossScript: true, kind: "Inherit", sites: [] },
				{ from: "/w/B.ssl#Unrelated", to: "/w/C.ssl#Orphan", crossScript: true, kind: "ExecFunction", sites: [] },
			],
			topLevel: ["/w/B.ssl", "/w/Base.ssl"],
		};

		// Depth 2 around A#Main must reach B# (hop 1) and Base# (hop 2), NOT C#Orphan via B# prefix-matching B#Unrelated!
		const aroundMain = visible(graph, { mode: "around", focus: "/w/A.ssl#Main", depth: 2 });
		expect([...aroundMain.nodes].sort()).toEqual(["/w/A.ssl#Main", "/w/B.ssl#", "/w/Base.ssl#"]);
		expect(aroundMain.nodes.has("/w/C.ssl#Orphan")).toBe(false);
		expect(aroundMain.nodes.has("/w/B.ssl#Unrelated")).toBe(false);

		// Focusing whole script B# DOES seed B's procedures before BFS, so C#Orphan IS reached at depth 1.
		const aroundScriptB = visible(graph, { mode: "around", focus: "/w/B.ssl#", depth: 1 });
		expect([...aroundScriptB.nodes].sort()).toEqual(["/w/A.ssl#Main", "/w/B.ssl#", "/w/B.ssl#Unrelated", "/w/Base.ssl#", "/w/C.ssl#Orphan"]);

		// Huge / infinite / negative / NaN depths must not hang or blow up.
		const t0 = performance.now();
		const huge = visible(graph, { mode: "around", focus: "/w/A.ssl#Main", depth: 1e9 });
		const inf = visible(graph, { mode: "around", focus: "/w/A.ssl#Main", depth: Number.POSITIVE_INFINITY });
		const neg = visible(graph, { mode: "around", focus: "/w/A.ssl#Main", depth: -5 });
		const nan = visible(graph, { mode: "around", focus: "/w/A.ssl#Main", depth: Number.NaN });
		expect(performance.now() - t0).toBeLessThan(200);

		expect([...huge.nodes].sort()).toEqual(["/w/A.ssl#Main", "/w/B.ssl#", "/w/Base.ssl#"]);
		expect([...inf.nodes].sort()).toEqual(["/w/A.ssl#Main", "/w/B.ssl#", "/w/Base.ssl#"]);
		expect([...neg.nodes]).toEqual(["/w/A.ssl#Main"]);
		expect([...nan.nodes]).toEqual(["/w/A.ssl#Main"]);
	});
});

// --- 3. Canvas zoomAt guard ------------------------------------------------------

describe("R3A graph/canvas — zoomAt() non-positive/non-finite scale guard", () => {
	test("returns view unchanged when view.scale is 0, negative, NaN, or Infinity", () => {
		for (const badScale of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
			const view = { x: 40, y: 80, scale: badScale };
			const out = zoomAt(view, { x: 200, y: 150 }, 1.2, 0.05, 3);
			expect(out).toBe(view);
		}
	});
});

// --- 4. pictureOf() hardening ----------------------------------------------------

class FakeElement {
	tagName: string;
	attrs = new Map<string, string>();
	children: FakeElement[] = [];
	parentElement: FakeElement | null = null;
	textContent = "";

	constructor(tagName: string, attrs: Record<string, string> = {}, textContent = "") {
		this.tagName = tagName;
		for (const [k, v] of Object.entries(attrs)) this.attrs.set(k, v);
		this.textContent = textContent;
	}

	appendChild(child: FakeElement) {
		child.parentElement = this;
		this.children.push(child);
		return child;
	}

	setAttribute(name: string, value: string) {
		this.attrs.set(name, value);
	}

	removeAttribute(name: string) {
		this.attrs.delete(name);
	}

	remove() {
		if (!this.parentElement) return;
		const idx = this.parentElement.children.indexOf(this);
		if (idx >= 0) this.parentElement.children.splice(idx, 1);
		this.parentElement = null;
	}

	cloneNode(deep = false): FakeElement {
		const copy = new FakeElement(this.tagName, Object.fromEntries(this.attrs), this.textContent);
		if (deep) {
			for (const c of this.children) copy.appendChild(c.cloneNode(true));
		}
		return copy;
	}

	matchesSimpleSelector(sel: string): boolean {
		const trimmed = sel.trim();
		if (trimmed.startsWith(".")) {
			const cls = trimmed.slice(1);
			return (this.attrs.get("class") ?? "").split(/\s+/).includes(cls);
		}
		return false;
	}

	querySelector(selector: string): FakeElement | null {
		if (selector === ":scope > g[transform]") {
			return this.children.find((c) => c.tagName === "g" && c.attrs.has("transform")) ?? null;
		}
		if (selector === ":scope > defs") {
			return this.children.find((c) => c.tagName === "defs") ?? null;
		}
		return null;
	}

	querySelectorAll(selectorList: string): FakeElement[] {
		const selectors = selectorList.split(",").map((s) => s.trim()).filter(Boolean);
		const out: FakeElement[] = [];
		const walk = (node: FakeElement) => {
			for (const c of node.children) {
				if (selectors.some((s) => c.matchesSimpleSelector(s))) out.push(c);
				walk(c);
			}
		};
		walk(this);
		return out;
	}

	serialize(): string {
		const attrs = [...this.attrs.entries()]
			.map(([k, v]) => ` ${k}="${v.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;")}"`)
			.join("");
		if (!this.children.length && !this.textContent) return `<${this.tagName}${attrs}/>`;
		const body = this.children.map((c) => c.serialize()).join("") + this.textContent;
		return `<${this.tagName}${attrs}>${body}</${this.tagName}>`;
	}
}

describe("R3A graph/picture — pictureOf() guards, XML escaping, and .g-far stripping", () => {
	function makeGraphSvg() {
		const svg = new FakeElement("svg");
		const root = svg.appendChild(new FakeElement("g", { class: "g-root far", transform: "translate(10,10) scale(0.3)" }));
		const line = root.appendChild(new FakeElement("g", { class: "g-line" }));
		line.appendChild(new FakeElement("path", { class: "g-edge-hit", d: "M0,0 L10,10" }));
		line.appendChild(new FakeElement("path", { class: "g-edge", d: "M0,0 L10,10" }));
		const proc = root.appendChild(new FakeElement("g", { class: "g-proc" }));
		proc.appendChild(new FakeElement("rect", { x: "0", y: "0", width: "80", height: "28" }));
		proc.appendChild(new FakeElement("text", {}, "NormalLabel"));
		const far = root.appendChild(new FakeElement("g", { class: "g-far" }));
		far.appendChild(new FakeElement("text", { style: "font-size:40px" }, "GIANT_FAR_LABEL"));
		return svg as unknown as SVGSVGElement;
	}

	test("returns empty string for zero, negative, NaN, or Infinity content dimensions", () => {
		const svg = makeGraphSvg();
		expect(pictureOf(svg, { width: 0, height: 100 })).toBe("");
		expect(pictureOf(svg, { width: 100, height: 0 })).toBe("");
		expect(pictureOf(svg, { width: -50, height: 100 })).toBe("");
		expect(pictureOf(svg, { width: Number.NaN, height: 100 })).toBe("");
		expect(pictureOf(svg, { width: 100, height: Number.POSITIVE_INFINITY })).toBe("");
	});

	test("XML-escapes malicious --bg values and strips .g-far and .g-edge-hit from exported SVG", () => {
		const prevStyle = (globalThis as any).getComputedStyle;
		const prevSer = (globalThis as any).XMLSerializer;
		const maliciousBg = '#111"/><script>alert("a&b")</script><rect fill="x';

		(globalThis as any).getComputedStyle = (el: any) => ({
			getPropertyValue: (prop: string) => {
				if (el === (globalThis as any).document.documentElement && prop === "--bg") return maliciousBg;
				return "";
			},
		});
		(globalThis as any).XMLSerializer = class {
			serializeToString(node: FakeElement) {
				return node.serialize();
			}
		};

		try {
			const out = pictureOf(makeGraphSvg(), { width: 200, height: 120 });
			expect(out).toContain('width="240" height="160"');
			// Malicious background must be fully attribute-escaped with no raw breakout tag.
			expect(out).not.toContain("<script>");
			expect(out).toContain(
				'fill="#111&quot;/&gt;&lt;script&gt;alert(&quot;a&amp;b&quot;)&lt;/script&gt;&lt;rect fill=&quot;x"/>',
			);
			// .g-far giant labels and .g-edge-hit paths are stripped, while normal labels remain.
			expect(out).not.toContain("GIANT_FAR_LABEL");
			expect(out).toContain("NormalLabel");
			expect(out.match(/<path\b/g)?.length).toBe(1);
		} finally {
			(globalThis as any).getComputedStyle = prevStyle;
			(globalThis as any).XMLSerializer = prevSer;
		}
	});
});

// --- 5. LspSession.waitReady() & loadGraph abort signal --------------------------

describe("R3A session.waitReady() & loadGraph() abort handling", () => {
	test("LspSession.waitReady() rejects when session is not running", async () => {
		const fresh = new LspSession();
		await expect(fresh.waitReady()).rejects.toThrow("language server not running");
	});

	test("loadGraph() immediately rejects when passed an aborted AbortSignal", async () => {
		const controller = new AbortController();
		controller.abort();
		await expect(loadGraph(() => {}, controller.signal)).rejects.toThrow();
	});
});
