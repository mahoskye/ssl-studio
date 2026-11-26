// Three low findings of the fourth audit pass in the Blocks view that were on main before this branch: the edit
// box that did not grow (L5), the folds that each new view set anew (B8-5), and the region name written into a
// comment unchecked (B8-9). The decisions are in src/view/blocks/model.ts and are run here as the view runs
// them; the region names are also given to the language server itself, to read what the view would write.
// BlocksView.tsx needs a DOM, a layout and the real Monaco to be mounted, which the suite does not have: what is
// checked of it is only that it is wired to the tested parts, by reading its source, and each such test says so
// in its name. The SSL here is written for these tests.
import { afterAll, describe, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { LSP_PIN } from "../src/bun/tools";
import { EDIT_BOX_SHARE, editBoxHeight, foldsOf, openFolds, openingFolds, regionNameRefusal, treeFromSyntax, type FoldMemory, type Node, type SyntaxNodeIn } from "../src/view/blocks/model";

const root = join(import.meta.dir, "..");
const readSrc = (rel: string) => readFileSync(join(root, rel), "utf8").replace(/\r\n/g, "\n");
const between = (src: string, from: string, to: string) => {
	const start = src.indexOf(from);
	const end = src.indexOf(to, start + from.length);
	expect(start).toBeGreaterThan(0);
	expect(end).toBeGreaterThan(start);
	return src.slice(start, end);
};

// --- L5. The box a block is edited in grows with what is typed ------------------------------------------------

describe("Blocks — the edit box shows all of its text while it is typed in (L5)", () => {
	// A box as the view measures one: a line of text is 20 px, and padding and border add 10 px to any height.
	const LINE = 20;
	const FRAME = 10;
	const tall = (lines: number) => lines * LINE + FRAME;
	const VIEW = 600;
	const most = Math.floor(VIEW * EDIT_BOX_SHARE);

	test("Enter in a one-line block: the box becomes two lines tall, where it stayed one and scrolled the first line away", () => {
		expect(editBoxHeight(tall(1), tall(2), VIEW)).toBe(tall(2));
		expect(editBoxHeight(tall(2), tall(3), VIEW)).toBe(tall(3));
	});

	test("it grows line by line up to a share of the view's height, and no further: past that it scrolls in itself", () => {
		let box = tall(1);
		const heights: number[] = [];
		for (let lines = 2; lines <= 40; lines++) {
			box = editBoxHeight(box, tall(lines), VIEW);
			heights.push(box);
		}
		// Every line shows while the text is shorter than the share.
		const fits = Math.floor((most - FRAME) / LINE);
		expect(heights.slice(0, fits - 1)).toEqual(Array.from({ length: fits - 1 }, (_, i) => tall(i + 2)));
		// From there on the box is the share of the view, whatever is typed.
		expect(new Set(heights.slice(fits - 1))).toEqual(new Set([most]));
		expect(most).toBeLessThan(VIEW);
		expect(EDIT_BOX_SHARE).toBeGreaterThan(0.3);
		expect(EDIT_BOX_SHARE).toBeLessThan(0.8);
	});

	test("it is never made smaller: not when lines are deleted, not under the height a long block opened with, not under one it was dragged to", () => {
		// Three lines typed, two deleted again.
		expect(editBoxHeight(tall(3), tall(1), VIEW)).toBe(tall(3));
		// A block of forty lines opens forty lines tall, as it always did: taller than the share, and left so.
		expect(tall(40)).toBeGreaterThan(most);
		expect(editBoxHeight(tall(40), tall(41), VIEW)).toBe(tall(40));
		// Dragged taller than its text by its corner.
		expect(editBoxHeight(300, tall(2), VIEW)).toBe(300);
	});

	test("a small view gives the box less, and a view whose height is not known leaves the box as it is", () => {
		expect(editBoxHeight(tall(1), tall(12), 200)).toBe(Math.floor(200 * EDIT_BOX_SHARE));
		expect(editBoxHeight(tall(1), tall(12), 0)).toBe(tall(1));
	});

	test("BlocksView fits both edit boxes as they open and as they are typed in, from the height they opened with (source only: the view needs a DOM and a layout to run)", () => {
		const src = readSrc("src/view/blocks/BlocksView.tsx");
		// The box for a statement and the one for code the server could not read.
		const boxes = src.split('class="b-edit"').slice(1);
		expect(boxes.length).toBe(2);
		for (const box of boxes) {
			const attributes = box.slice(0, box.indexOf("/>"));
			expect(attributes).toContain("rows={p.node.end - p.node.start + 1}");
			expect(attributes).toContain("onInput={(e) => fitEdit(e.currentTarget)}");
		}
		expect(src).toContain("queueMicrotask(() => (el.focus(), select && el.select(), el instanceof HTMLTextAreaElement && fitEdit(el)));");
		const fit = between(src, "const fitEdit = (el: HTMLTextAreaElement) => {", "\n\t};");
		// Only when some of the text is out of sight, by the height that shows it, against the view's own height.
		expect(fit).toContain("if (!scroller || el.scrollHeight <= el.clientHeight) return;");
		expect(fit).toContain("editBoxHeight(now, el.scrollHeight + (now - el.clientHeight), scroller.clientHeight)");
		expect(fit.indexOf("if (height <= now) return;")).toBeGreaterThan(0);
		expect(fit.indexOf("if (height <= now) return;")).toBeLessThan(fit.indexOf("el.style.height = `${height}px`;"));
	});
});

// --- B8-5. Blocks: what is folded outlives the view -----------------------------------------------------------

const span = (start: number, end: number, endCharacter = 200) => ({ start: { line: start - 1, character: 0 }, end: { line: end - 1, character: endCharacter } });

/** A script with a banner and procedures of four lines each, `above` lines added under the banner. */
const script = (procedures: string[], above = 0) => {
	const lines = ["/* Due dates for samples;", ...Array(above).fill("nCount := 0;")];
	const nodes: SyntaxNodeIn[] = [{ kind: "banner", range: span(1, 1) }, ...Array.from({ length: above }, (_, i) => ({ kind: "statement", range: span(i + 2, i + 2) }))];
	for (const name of procedures) {
		const at = lines.length + 1;
		lines.push(`:PROCEDURE ${name};`, ":IF bMore;", "nCount := nCount + 1;", ":ENDIF;", ":ENDPROC;");
		nodes.push({
			kind: "procedure",
			name,
			range: span(at, at + 4),
			children: [{ kind: "if", keyword: "IF", range: span(at + 1, at + 3), headerRange: { start: { line: at, character: 0 }, end: { line: at, character: 10 } }, children: [{ kind: "statement", range: span(at + 2, at + 2) }] }],
		});
	}
	return { lines, nodes };
};

/**
 * A view of a file, as BlocksView is one: made anew, it reads the tree, and the file's opening folds are set if
 * they never were. What it then shows folded is the memory's, and a fold is opened or closed in the memory.
 */
const view = (memory: FoldMemory, path: string, file: { lines: string[]; nodes: SyntaxNodeIn[] }, lineCount = file.lines.length) => {
	const tree = treeFromSyntax(file.lines, file.nodes, () => []);
	const set = openFolds(memory, path, tree, lineCount);
	const named = (kind: string, name?: string): Node => {
		const walk = (n: Node): Node | undefined => (n.kind === kind && (name === undefined || n.name === name) ? n : n.children.map(walk).find(Boolean));
		return tree.children.map(walk).find(Boolean)!;
	};
	const folded = () => {
		const out: string[] = [];
		const walk = (n: Node) => n.children.forEach((c) => (c.fold && foldsOf(memory, path).has(c.fold) && out.push(c.fold), walk(c)));
		walk(tree);
		return out;
	};
	const toggle = (n: Node) => void (foldsOf(memory, path).has(n.fold!) ? foldsOf(memory, path).delete(n.fold!) : foldsOf(memory, path).add(n.fold!));
	return { tree, set, named, folded, toggle };
};

describe("Blocks — folds the user opened or closed are there again when the view is shown again (B8-5)", () => {
	const A = "/ws/src/DueDates.ssl";
	const B = "/ws/src/Holidays.ssl";

	test("a file opens with its banner folded; unfolded by the user, the banner is still unfolded in the next view of the file", () => {
		const memory: FoldMemory = new Map();
		const first = view(memory, A, script(["CountDue", "PurgeOld"]));
		expect(first.set).toBe(true);
		expect(first.folded()).toEqual(["comment"]);
		first.toggle(first.named("comment"));
		expect(first.folded()).toEqual([]);
		// To Text and back, or to another tab and back: a new view, a tree read anew.
		const second = view(memory, A, script(["CountDue", "PurgeOld"]));
		expect(second.set).toBe(false);
		expect(second.folded()).toEqual([]);
	});

	test("set by each new view, as they were, the opening folds closed again what the user had opened", () => {
		const file = script(["CountDue", "PurgeOld"]);
		const memory: FoldMemory = new Map();
		const first = view(memory, A, file);
		first.toggle(first.named("comment"));
		// What the view did each time it was made: the opening folds, added to what was kept.
		for (const fold of openingFolds(treeFromSyntax(file.lines, file.nodes, () => []), file.lines.length)) foldsOf(memory, A).add(fold);
		expect([...foldsOf(memory, A)]).toEqual(["comment"]);
	});

	test("a block the user folded is still folded in the next view, and after lines were added above it in Text", () => {
		const memory: FoldMemory = new Map();
		const first = view(memory, A, script(["CountDue", "PurgeOld"]));
		first.toggle(first.named("procedure", "PurgeOld"));
		first.toggle(first.named("block"));
		expect(first.folded()).toEqual(["comment", "procedure:CountDue/block:IF", "procedure:PurgeOld"]);
		const second = view(memory, A, script(["CountDue", "PurgeOld"], 3));
		expect(second.folded()).toEqual(["comment", "procedure:CountDue/block:IF", "procedure:PurgeOld"]);
		expect(second.named("procedure", "PurgeOld").start).toBe(first.named("procedure", "PurgeOld").start + 3);
	});

	test("a long file opens as an outline, once: the procedures the user unfolded stay unfolded, the others folded", () => {
		const memory: FoldMemory = new Map();
		const file = script(["CountDue", "PurgeOld", "SetDue"]);
		// The view gives the text's own line count: the file is taken to be long, as one of more than 300 lines is.
		const first = view(memory, A, file, 301);
		expect(first.folded()).toEqual(["comment", "procedure:CountDue", "procedure:PurgeOld", "procedure:SetDue"]);
		first.toggle(first.named("procedure", "PurgeOld"));
		const second = view(memory, A, file, 301);
		expect(second.folded()).toEqual(["comment", "procedure:CountDue", "procedure:SetDue"]);
		// "Expand all", then away and back: nothing is folded again.
		foldsOf(memory, A).clear();
		expect(view(memory, A, file, 301).folded()).toEqual([]);
		// A file of 300 lines is not long.
		expect(openingFolds(first.tree, 300)).toEqual(["comment"]);
		expect(openingFolds(first.tree, 301)).toEqual(["comment", "procedure:CountDue", "procedure:PurgeOld", "procedure:SetDue"]);
	});

	test("each file has its own folds, and one not shown before opens with its opening folds", () => {
		const memory: FoldMemory = new Map();
		const a = view(memory, A, script(["CountDue"]));
		a.toggle(a.named("comment"));
		a.toggle(a.named("procedure", "CountDue"));
		const b = view(memory, B, script(["CountDue"]));
		expect(b.set).toBe(true);
		expect(b.folded()).toEqual(["comment"]);
		expect(view(memory, A, script(["CountDue"])).folded()).toEqual(["procedure:CountDue"]);
	});

	test("a fold asked about before the blocks were read does not stand for the opening folds", () => {
		const memory: FoldMemory = new Map();
		// The view asks what is folded as it draws; asked early, the file is known and has nothing folded yet.
		expect([...foldsOf(memory, A)]).toEqual([]);
		expect(view(memory, A, script(["CountDue"])).folded()).toEqual(["comment"]);
	});

	test("another workspace forgets them all, as it did: a file is then shown as new", () => {
		const memory: FoldMemory = new Map();
		const first = view(memory, A, script(["CountDue"]));
		first.toggle(first.named("comment"));
		memory.clear();
		const again = view(memory, A, script(["CountDue"]));
		expect(again.set).toBe(true);
		expect(again.folded()).toEqual(["comment"]);
	});

	test("BlocksView keeps the folds outside itself and sets the opening folds through the memory (source only: the view needs a DOM and Monaco to run)", () => {
		const src = readSrc("src/view/blocks/BlocksView.tsx");
		// One memory for the session, made where the module is loaded and not where a view is.
		expect(src.indexOf("const collapsedByPath: FoldMemory = new Map();")).toBeGreaterThan(0);
		expect(src.indexOf("const collapsedByPath: FoldMemory = new Map();")).toBeLessThan(src.indexOf("export function BlocksView("));
		expect(src).toContain("const collapsed = () => foldsOf(collapsedByPath, props.path);");
		// Each read of the tree asks the memory; nothing is decided by whether this view has shown a tree before.
		expect(src).toContain("if (openFolds(collapsedByPath, path, root, model.getLineCount())) setCollapseVersion((v) => v + 1);");
		expect(src).not.toContain("first = s.root === null");
		expect(src).not.toMatch(/collapsed\(\)\.add\(banner/);
	});
});

// --- B8-9. Blocks: a region's name is one that a comment can hold ---------------------------------------------

// Names a region can be given, and names it cannot.
const GOOD_NAMES = ["Setup helpers", "Setup */ helpers", "Due dates: A/B", `the "quoted" 'names'`, "x /* y", "a, b (c) [d] {e}"];
const BAD_NAMES = ["Setup; helpers", ";", "Setup;", "Setup\nhelpers", "Setup\r\nhelpers"];
/** What "Wrap in a region" writes round a block. */
const wrapped = (name: string, body: string) => `/* region ${name};\n${body}\n/* endregion;`;

describe("Blocks — a region is not given a name that ends its comment early (B8-9)", () => {
	test("a name with a semicolon or a line break in it is refused, in plain words; any other name is taken as typed", () => {
		for (const name of GOOD_NAMES) expect(regionNameRefusal(name)).toBeNull();
		for (const name of BAD_NAMES) expect(regionNameRefusal(name)).toBeString();
		// As a file dropped on code is refused: what is in the way, and why it is.
		expect(regionNameRefusal("Setup; helpers")).toBe("Nothing was wrapped: the name has “;” in it, which ends a comment in SSL.");
		expect(regionNameRefusal("Setup\nhelpers")).toBe("Nothing was wrapped: the name has a line break in it, and a region's name is one line.");
	});

	test("a name is taken exactly when the region's line is one line that ends at its first semicolon", () => {
		for (const name of [...GOOD_NAMES, ...BAD_NAMES]) {
			const line = `/* region ${name};`;
			const oneComment = !/[\r\n]/.test(line) && line.indexOf(";") === line.length - 1;
			expect(regionNameRefusal(name) === null).toBe(oneComment);
		}
	});

	test("BlocksView asks the name again, with what was typed, before anything is changed (source only: the view is not mounted in a test)", () => {
		const src = readSrc("src/view/blocks/BlocksView.tsx");
		const wrap = between(src, "const wrap = async (n: Node) => {", "const remove = async (n: Node) => {");
		const refuse = wrap.indexOf("while (name && regionNameRefusal(name)) {\n\t\t\tnotify(regionNameRefusal(name)!);\n\t\t\tname = await ask(\"Name of the new region\", name);\n\t\t}\n\t\tif (!name) return;");
		expect(refuse).toBeGreaterThan(0);
		expect(refuse).toBeLessThan(wrap.indexOf("replaceLines("));
		expect(wrap.split("replaceLines(").length).toBe(2);
	});
});

// The server itself: how it reads what the view would write for each name.
function pinnedServer(): string | null {
	const suffix = process.platform === "win32" ? ".exe" : "";
	for (const path of [process.env.STARLIMS_LSP, join(root, "vendor", `starlims-lsp${suffix}`)]) {
		if (!path || !existsSync(path)) continue;
		try {
			const out = Bun.spawnSync([path, "--version"]).stdout.toString();
			if (/starlims-lsp version (\S+)/.exec(out)?.[1] === LSP_PIN) return path;
		} catch {
			// Not a program this system can start.
		}
	}
	return null;
}
const server = pinnedServer();
const base = mkdtempSync(join(tmpdir(), "ssl-studio-p4-blocks-"));
afterAll(() => rmSync(base, { recursive: true, force: true }));

type TreeNode = { kind: string; name?: string; children?: TreeNode[] };

/** The language server over its standard streams, asked one thing at a time. */
function lspClient(path: string) {
	const child = spawn(path, ["--stdio"], { stdio: ["pipe", "pipe", "ignore"] });
	let buffer = Buffer.alloc(0);
	let next = 0;
	const waiting = new Map<number, (message: any) => void>();
	const send = (message: object) => {
		const body = Buffer.from(JSON.stringify({ jsonrpc: "2.0", ...message }));
		child.stdin.write(Buffer.concat([Buffer.from(`Content-Length: ${body.length}\r\n\r\n`), body]));
	};
	child.stdout.on("data", (chunk: Buffer) => {
		buffer = Buffer.concat([buffer, chunk]);
		for (;;) {
			const head = buffer.indexOf("\r\n\r\n");
			if (head < 0) return;
			const length = Number(/Content-Length: (\d+)/i.exec(buffer.subarray(0, head).toString())?.[1]);
			if (buffer.length < head + 4 + length) return;
			const message = JSON.parse(buffer.subarray(head + 4, head + 4 + length).toString());
			buffer = buffer.subarray(head + 4 + length);
			if (message.id !== undefined && message.method) send({ id: message.id, result: null });
			else if (message.id !== undefined) waiting.get(message.id)?.(message);
		}
	});
	const request = (method: string, params: object) =>
		new Promise<any>((done, failed) => {
			const id = ++next;
			const timer = setTimeout(() => failed(new Error(`the language server did not answer ${method}`)), 15_000);
			waiting.set(id, (message) => {
				clearTimeout(timer);
				waiting.delete(id);
				if (message.error) failed(new Error(JSON.stringify(message.error)));
				else done(message.result);
			});
			send({ id, method, params });
		});
	return { request, notify: (method: string, params: object) => send({ method, params }), stop: () => void child.kill() };
}

describe("B8-9 — against the language server's own reading", () => {
	const body = ":PROCEDURE Run;\n:RETURN 1;\n:ENDPROC;";

	test.skipIf(!server)(`starlims-lsp ${LSP_PIN}: every name that is taken makes a region of that name round the block; every name that is refused would not have`, async () => {
		const lsp = lspClient(server!);
		try {
			await lsp.request("initialize", { processId: process.pid, rootUri: pathToFileURL(base).href, capabilities: {}, workspaceFolders: [{ uri: pathToFileURL(base).href, name: "regions" }] });
			lsp.notify("initialized", {});
			let files = 0;
			const read = async (name: string): Promise<TreeNode[]> => {
				const uri = pathToFileURL(join(base, `region-${++files}.ssl`)).href;
				lsp.notify("textDocument/didOpen", { textDocument: { uri, languageId: "ssl", version: 1, text: wrapped(name, body) } });
				return (await lsp.request("ssl/syntaxTree", { textDocument: { uri } }))?.nodes ?? [];
			};
			/** One region of that name, and in it the procedure alone. */
			const isRegionOf = (nodes: TreeNode[], name: string) => nodes.length === 1 && nodes[0]!.kind === "region" && nodes[0]!.name === name && (nodes[0]!.children ?? []).map((c) => c.kind).join() === "procedure";

			for (const name of GOOD_NAMES) {
				expect(regionNameRefusal(name)).toBeNull();
				expect({ name, region: isRegionOf(await read(name), name) }).toEqual({ name, region: true });
			}
			for (const name of BAD_NAMES) {
				expect(regionNameRefusal(name)).not.toBeNull();
				expect({ name, region: isRegionOf(await read(name), name) }).toEqual({ name, region: false });
			}
			// The auditor's case, as it was written before: the region is named "Setup", and " helpers;" is a statement in it.
			const cut = await read("Setup; helpers");
			expect(cut[0]!.name).toBe("Setup");
			expect((cut[0]!.children ?? []).map((c) => c.kind)).toEqual(["statement", "procedure"]);
		} finally {
			lsp.stop();
		}
	}, 30_000);
});
