// Pass 3, the medium findings in the project-documents engine: front matter laid out over several lines, the
// split of a ticket's checklist, Health's wikilink mends, the rename of a heading that has a twin, the bare
// names a rename leaves behind, and the quick pick's workspace symbols.
// Each test runs the code it names. Three things are in component or backend-bound code that cannot be run here
// (the Inspector's notices, the dialog Health's "Mend" opens, the save `put()` makes): for those the source is
// read, and the test says so.
import { afterAll, describe, expect, mock, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { listDocs, readProject } from "../src/bun/project";
import { WorkspaceFiles } from "../src/bun/workspace";
import { docChecks, mendKeepsName, type WikiLinkMend } from "../src/shared/docChecks";
import { bareNameTarget, rewriteHeadingReferences } from "../src/shared/docLinks";
import { addToFrontMatterList, removeFromFrontMatterList, removeFrontMatterKey, replaceInFrontMatterList, withFrontMatter } from "../src/shared/frontMatter";
import { documentHeadings } from "../src/shared/markdownEdit";
import { withNames } from "../src/shared/namedLinks";

// --- The few browser and Monaco names the view's modules ask for when they are loaded (as test/r7cDocsHealthWorkflows.test.ts has them) ---
const storage = new Map<string, string>();
if (typeof (globalThis as any).localStorage === "undefined") {
	(globalThis as any).localStorage = {
		getItem: (k: string) => storage.get(k) ?? null,
		setItem: (k: string, v: string) => void storage.set(k, String(v)),
		removeItem: (k: string) => void storage.delete(k),
		clear: () => storage.clear(),
	};
}
if (typeof (globalThis as any).window === "undefined") {
	(globalThis as any).window = {
		Error,
		Map,
		Set,
		innerWidth: 1280,
		innerHeight: 900,
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
		head: { appendChild() {} },
		getElementById: () => null,
		createElement: () => ({ style: {}, getContext: () => null }),
		querySelector: () => null,
	};
}
if (typeof (globalThis as any).self === "undefined") (globalThis as any).self = globalThis;

const makeUri = (scheme: string, fsPath: string) => {
	const normalized = fsPath.replace(/\\/g, "/");
	const raw = scheme === "file" ? `file://${normalized.startsWith("/") ? "" : "/"}${normalized}` : `${scheme}:${fsPath}`;
	return { scheme, fsPath, path: normalized, toString: () => raw };
};
mock.module(`${resolve(import.meta.dir, "../src/view/editor/markdownLive.worker.ts")}?worker`, () => ({ default: class {} }));
mock.module("monaco-editor/editor/editor.worker?worker", () => ({ default: class {} }));
mock.module("monaco-editor/features/register.all", () => ({}));
mock.module("monaco-editor/editor/contrib/semanticTokens/browser/documentSemanticTokens", () => ({}));
for (const lang of ["markdown", "sql", "yaml", "xml", "ini", "shell", "powershell", "bat", "javascript", "typescript", "html", "css", "scss", "less", "csharp", "vb", "razor", "pgsql", "mysql", "python", "java", "cpp", "php", "dockerfile", "graphql", "r", "perl", "ruby", "go", "rust", "fsharp"]) {
	mock.module(`monaco-editor/languages/definitions/${lang}/register`, () => ({}));
}
const noopProxy = (base: Record<string, any> = {}): any =>
	new Proxy(base, {
		get(target, prop) {
			if (prop in target) return target[prop as any];
			return () => ({ dispose() {} });
		},
	});
mock.module("monaco-editor/editor/editor.api", () => ({
	Range: class {
		constructor(
			public startLineNumber: number,
			public startColumn: number,
			public endLineNumber: number,
			public endColumn: number,
		) {}
	},
	Emitter: class {
		event = () => ({ dispose() {} });
		fire() {}
		dispose() {}
	},
	Uri: {
		from: () => ({}),
		file: (p: string) => makeUri("file", p),
		parse: (raw: string) => (raw.startsWith("file://") ? makeUri("file", raw.slice("file://".length)) : makeUri("untitled", raw)),
	},
	MarkerSeverity: { Hint: 1, Info: 2, Warning: 4, Error: 8 },
	KeyMod: { CtrlCmd: 2048, Shift: 1024, Alt: 512 },
	KeyCode: { KeyF: 36, KeyZ: 56, KeyY: 55 },
	languages: noopProxy({
		CompletionItemKind: { File: 1, Keyword: 2, Text: 3, Snippet: 4, Field: 5, Struct: 6 },
		SymbolKind: { Function: 11, Method: 5, Constructor: 8, Namespace: 2 },
		FoldingRangeKind: { Comment: "comment", Imports: "imports", Region: "region" },
		CompletionItemInsertTextRule: { InsertAsSnippet: 4 },
	}),
	editor: noopProxy({
		EndOfLineSequence: { LF: 0, CRLF: 1 },
		ScrollType: { Immediate: 1 },
		getEditors: () => [],
		getModels: () => [],
		getModel: () => null,
		createModel: () => null,
		onDidCreateModel: () => ({ dispose() {} }),
		setModelMarkers() {},
		getModelMarkers: () => [],
		registerEditorOpener: () => ({ dispose() {} }),
	}),
}));

const { bareNameFollowed, renamedHeadingLine, splitParentTicketChecklist } = await import("../src/view/projectDocs");
const { guessedMendQuestion, movedLinkMends, splitWikiMends } = await import("../src/view/panels/Health");
const { symbolsFor } = await import("../src/view/QuickPick");

const readSrc = (rel: string) => readFileSync(join(import.meta.dir, rel), "utf8").replace(/\r\n/g, "\n");
const base = mkdtempSync(join(tmpdir(), "ssl-studio-pass3-docs-"));
afterAll(() => rmSync(base, { recursive: true, force: true }));

// ---------------------------------------------------------------------------------------------------------------
describe("1. front matter: a value laid out over several lines is edited whole or not at all", () => {
	const folded = "---\ntitle: Due dates\nsummary: >\n  How due dates are set\n  and when they move.\nstatus: open\n---\n\n# Body\n";
	const prettier = "---\ntitle: T\ntags:\n  [\n    migration,\n    due-dates,\n  ]\nstatus: open\n---\n\n# T\n";
	const twoLine = "---\nspecs: [docs/specs/A.md,\n  docs/specs/B.md]\nstatus: open\n---\n";
	const nested = "---\ntitle: T\nreview:\n  by: QA\n  due: 2026-12-01\nstatus: open\n---\n";
	const closedAtMargin = "---\ntags: [\n  a,\n  b\n]\nstatus: open\n---\n";

	test("a block scalar is not set on its first line, and goes whole when its key is removed", () => {
		// Before: `summary: Short` followed by the two indented lines, which YAML reads as more of the new value.
		expect(withFrontMatter(folded, "summary", "Short")).toBeNull();
		// Before: the two indented lines were left under `title:` and read as the title's continuation.
		expect(removeFrontMatterKey(folded, "summary")).toBe("---\ntitle: Due dates\nstatus: open\n---\n\n# Body\n");
		// A literal scalar's own lines may start with a hash: they are its text, and go with it.
		expect(removeFrontMatterKey("---\nnote: |\n  first\n\n  # not a comment\nstatus: open\n---\n", "note")).toBe("---\nstatus: open\n---\n");
	});

	test("a flow list broken over lines is refused, whichever way it is broken", () => {
		// Before: `tags: [urgent]` was written above the orphaned `[`, `migration,` ... lines (invalid YAML, the tags lost).
		expect(addToFrontMatterList(prettier, "tags", "urgent")).toBeNull();
		expect(withFrontMatter(prettier, "tags", "urgent")).toBeNull();
		expect(addToFrontMatterList(twoLine, "specs", "docs/specs/C.md")).toBeNull();
		// The one-line reader sees "[docs/specs/A.md," as the value: taking that out left `  docs/specs/B.md]` behind.
		expect(removeFromFrontMatterList(twoLine, "specs", "[docs/specs/A.md")).toBeNull();
		expect(replaceInFrontMatterList(twoLine, "specs", "[docs/specs/A.md", "docs/specs/Z.md")).toBeNull();
		expect(addToFrontMatterList(closedAtMargin, "tags", "c")).toBeNull();
		// Removing the key takes every line of the list, the closing bracket at the margin too.
		expect(removeFrontMatterKey(closedAtMargin, "tags")).toBe("---\nstatus: open\n---\n");
		expect(removeFrontMatterKey(prettier, "tags")).toBe("---\ntitle: T\nstatus: open\n---\n\n# T\n");
		expect(removeFrontMatterKey(twoLine, "specs")).toBe("---\nstatus: open\n---\n");
		// An apostrophe in an item is no quote, a bracket inside a quoted item closes nothing, a comment may stand at the margin.
		for (const list of ["tags: [\n  it's,\n# a note at the margin\n  a\n]\n", 'tags: [\n  "a]b", # note\n  "c"\n]\n', "tags: {a: 'x]', b: [1,\n  2]}\n"]) {
			expect(removeFrontMatterKey(`---\n${list}status: open\n---\n`, "tags")).toBe("---\nstatus: open\n---\n");
			expect(withFrontMatter(`---\n${list}status: open\n---\n`, "tags", "x")).toBeNull();
		}
	});

	test("a nested map is not overwritten by a value on its key's line", () => {
		// Before: `review: done` above `  by: QA`, which is no YAML at all.
		expect(withFrontMatter(nested, "review", "done")).toBeNull();
		expect(addToFrontMatterList(nested, "review", "done")).toBeNull();
		expect(removeFrontMatterKey(nested, "review")).toBe("---\ntitle: T\nstatus: open\n---\n");
	});

	test("a dash list whose items run on is refused; a plain one is edited as before", () => {
		const runOn = "---\nspecs:\n  - docs/specs/A.md\n    and more\n  - docs/specs/B.md\n---\n";
		// Before: the new dash went in between the item and its second line, which then belonged to the new item.
		expect(addToFrontMatterList(runOn, "specs", "docs/specs/C.md")).toBeNull();
		expect(removeFromFrontMatterList(runOn, "specs", "docs/specs/B.md")).toBeNull();
		expect(removeFrontMatterKey(runOn, "specs")).toBe("");

		const plain = "---\nspecs:\n  # main spec\n  - docs/specs/A.md\n  - docs/specs/B.md # second\nstatus: s\n---\n";
		expect(addToFrontMatterList(plain, "specs", "docs/specs/C.md")).toBe("---\nspecs:\n  # main spec\n  - docs/specs/A.md\n  - docs/specs/B.md # second\n  - docs/specs/C.md\nstatus: s\n---\n");
		expect(removeFromFrontMatterList(plain, "specs", "docs/specs/B.md")).toBe("---\nspecs:\n  # main spec\n  - docs/specs/A.md\nstatus: s\n---\n");
		expect(withFrontMatter(plain, "specs", "x")).toBeNull();
	});

	test("a dash list written at the margin gets its new item at the margin", () => {
		const out = addToFrontMatterList("---\nspecs:\n- a\n- b\nstatus: s\n---\n", "specs", "c");
		// Before: `  - c` under `- b`, which YAML reads as the one item "b - c".
		expect(out).toBe("---\nspecs:\n- a\n- b\n- c\nstatus: s\n---\n");
		expect(Bun.YAML.parse(out!.split("---\n")[1]!)).toEqual({ specs: ["a", "b", "c"], status: "s" });
	});

	test("a change of an item's case alone keeps the item in a dash list", () => {
		// Before: the item counted as "in the list already" and its line was dropped.
		expect(replaceInFrontMatterList("---\ntags:\n  - Foo\n  - bar\n---\n", "tags", "Foo", "foo")).toBe("---\ntags:\n  - foo\n  - bar\n---\n");
		expect(replaceInFrontMatterList("---\ntags:\n  - Foo\n  - bar\n---\n", "tags", "Foo", "bar")).toBe("---\ntags:\n  - bar\n---\n");
	});

	test("values on one line are written as they always were", () => {
		expect(withFrontMatter("---\nstatus: draft # waiting\ntitle: [WIP fix\n---\n", "status", "open")).toBe("---\nstatus: open\ntitle: [WIP fix\n---\n");
		// An unquoted value that opens with a bracket it never closes is one line, not a list that runs to the block's end.
		expect(withFrontMatter("---\ntitle: [WIP fix\nstatus: open\n---\n", "title", "Done")).toBe("---\ntitle: Done\nstatus: open\n---\n");
		expect(addToFrontMatterList("---\ntags: [a, 'b c'] # keep\n---\n", "tags", "z")).toBe("---\ntags: [a, b c, z]\n---\n");
		expect(removeFrontMatterKey("---\nstatus: open\n  # an indented comment\ntitle: T\n---\n", "status")).toBe("---\n  # an indented comment\ntitle: T\n---\n");
		expect(withFrontMatter("---\nrelated: [[Note A, part 2]]\n---\n", "related", "x")).toBe("---\nrelated: x\n---\n");
	});

	// The writers against Bun's own YAML reader, over one-line values, plain dash lists and nine shapes that run over
	// several lines, with LF and CRLF, a BOM and a template header. A result is null (refused), or the text as it
	// was where there was nothing to change, or a text that reads back as the values meant, with every line that is
	// not the key's own byte for byte as it was. Run against the code before the fix, the same fuzz finds orphaned
	// lines and unreadable YAML within its first hundred documents.
	test("fuzz: a result is null, or reads back as meant with every other line untouched", () => {
		type Shape = "plain" | "quoted" | "commented" | "inline" | "empty" | "dash" | "literal" | "prettier" | "flow2" | "flowMargin" | "flowMap" | "nested" | "wrapped" | "dashRunOn" | "dashMap" | "quotedWrap";
		const SINGLE: Shape[] = ["plain", "quoted", "commented", "inline", "empty"];
		const OTHER: Shape[] = ["literal", "prettier", "flow2", "flowMargin", "flowMap", "nested", "wrapped", "dashRunOn", "dashMap", "quotedWrap"];
		const SHAPES: Shape[] = [...SINGLE, "dash", ...OTHER];
		const POOL = ["alpha", "Beta gamma", "docs/specs/A.md", "LIMS-12", "it's", "a: b", "x #y", "50% done", "@owner", "- dash", "ünï", 'q"uote', "C#", "[wip] x"];
		const KEYS = ["status", "tags", "specs", "summary", "review", "related", "owner", "blocked-by", "plans", "release"];
		let a = 20261124;
		const rand = () => {
			a = (a + 0x6d2b79f5) >>> 0;
			let t = a;
			t = Math.imul(t ^ (t >>> 15), t | 1);
			t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
			return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
		};
		const pick = <T,>(xs: readonly T[]) => xs[Math.floor(rand() * xs.length)]!;
		const q = (v: string) => JSON.stringify(v);
		/** A value as YAML takes it plain, quoted where it must be. */
		const y = (v: string) => (/^[\w./-]+( [\w./-]+)*$/.test(v) && !/^-/.test(v) ? v : q(v));
		const some = (n: number) => Array.from({ length: n }, () => pick(POOL)).filter((v, i, all) => all.findIndex((o) => o.toLowerCase() === v.toLowerCase()) === i);
		type Entry = { key: string; shape: Shape | "filler"; lines: string[] };
		const entry = (key: string, shape: Shape): Entry => {
			const items = some(1 + Math.floor(rand() * 3));
			switch (shape) {
				case "plain":
					return { key, shape, lines: [`${key}: ${pick(["alpha", "Beta gamma", "docs/specs/A.md", "LIMS-12", "it's", "50% done", "C#"])}`] };
				case "quoted":
					return { key, shape, lines: [`${key}: ${rand() < 0.5 ? q(pick(POOL)) : `'${pick(POOL).replace(/'/g, "''")}'`}`] };
				case "commented":
					return { key, shape, lines: [`${key}: ${pick(["alpha", "Beta gamma", "LIMS-12"])} # waiting on QA`] };
				case "inline":
					return { key, shape, lines: [`${key}: [${items.map(y).join(", ")}]${rand() < 0.3 ? " # keep" : ""}`] };
				case "empty":
					return { key, shape, lines: [`${key}:${rand() < 0.3 ? " # none yet" : ""}`] };
				case "dash": {
					const indent = pick(["  ", "", "    "]);
					const lines = [`${key}:${rand() < 0.2 ? " # list" : ""}`];
					items.forEach((item, i) => {
						if (i && rand() < 0.2) lines.push(`${indent}# about the next one`);
						if (i && rand() < 0.1) lines.push("");
						lines.push(`${indent}- ${y(item)}${rand() < 0.2 ? " # note" : ""}`);
					});
					return { key, shape, lines };
				}
				case "literal": {
					const lines = [`${key}: ${pick(["|", ">", "|-", ">-", "|2"])}`, "  line one"];
					if (rand() < 0.5) lines.push("");
					if (rand() < 0.5) lines.push("  # not a comment");
					if (rand() < 0.8) lines.push("  line: two");
					return { key, shape, lines };
				}
				case "prettier":
					return { key, shape, lines: [`${key}:`, "  [", ...items.map((i) => `    ${y(i)},`), "  ]"] };
				case "flow2":
					return { key, shape, lines: [`${key}: [${y(items[0]!)},`, `  ${y(pick(POOL))}]`] };
				case "flowMargin":
					return { key, shape, lines: [`${key}: [`, ...(rand() < 0.3 ? ["  it's,"] : []), ...(rand() < 0.3 ? ["# a note at the margin"] : []), ...items.map((i, n) => `  ${y(i)}${n < items.length - 1 ? "," : ""}`), "]"] };
				case "flowMap":
					return { key, shape, lines: [`${key}: {by: QA,`, "  due: later}"] };
				case "nested":
					return { key, shape, lines: [`${key}:`, "  by: QA", ...(rand() < 0.5 ? ["  # when", ""] : []), "  due: later"] };
				case "wrapped":
					return { key, shape, lines: [`${key}: ${pick(["alpha", "Beta gamma"])}`, "  and more words"] };
				case "dashRunOn":
					return { key, shape, lines: [`${key}:`, `  - ${pick(["alpha", "Beta gamma"])}`, "    goes on", "  - last"] };
				case "dashMap":
					return { key, shape, lines: [`${key}:`, "  - name: a", "    path: b", "  - name: c"] };
				case "quotedWrap":
					return { key, shape, lines: [`${key}: "first`, '  second"'] };
			}
		};
		// Read with a key of the oracle's own after the block, so no value is the last thing in the text.
		const read = (inner: string) => {
			const all = (Bun.YAML.parse(`${inner}zz-last: 1\n`) ?? {}) as Record<string, unknown>;
			delete all["zz-last"];
			return all;
		};
		const asList = (v: unknown): string[] => (v === null || v === undefined ? [] : Array.isArray(v) ? v.map(String) : [String(v)]);
		const sameAs = (one: string, other: string) => one.trim().toLowerCase() === other.trim().toLowerCase();
		const failures: string[] = [];
		const seen = { refused: 0, edited: 0, multi: 0 };
		for (let n = 0; n < 20000 && failures.length < 5; n++) {
			const eol = rand() < 0.3 ? "\r\n" : "\n";
			const keys = [...KEYS].sort(() => rand() - 0.5).slice(0, 2 + Math.floor(rand() * 4));
			const entries: Entry[] = [];
			for (const key of keys) {
				if (rand() < 0.15) entries.push({ key: "", shape: "filler", lines: [pick(["# a comment", "", "# status: not this one"])] });
				entries.push(entry(key, rand() < 0.45 ? pick(SINGLE) : pick(SHAPES)));
			}
			if (rand() < 0.1) entries.push({ key: "", shape: "filler", lines: ["# last"] });
			const head = `${rand() < 0.1 ? "﻿" : ""}${rand() < 0.1 ? `<!-- template: note -->${eol}` : ""}---${eol}`;
			const tail = `---${eol}${eol}# Body${eol}${eol}status: prose${eol}${eol}---${eol}${eol}  [${eol}more${eol}`;
			const block = (es: readonly Entry[]) => es.map((e) => e.lines.map((l) => l + eol).join("")).join("");
			const text = head + block(entries) + tail;
			const before = read(block(entries));
			const target = rand() < 0.2 ? null : pick(entries.filter((e) => e.shape !== "filler"));
			const key = target?.key ?? KEYS.find((k) => !keys.includes(k))!;
			const shape = target?.shape ?? "new";
			const at = target ? entries.indexOf(target) : entries.length;
			const prefix = head + block(entries.slice(0, at));
			const suffix = block(entries.slice(at + 1)) + tail;
			const cur = asList(before[key]);
			const op = pick(["set", "add", "remove", "replace", "drop"] as const);
			// What is edited now was edited before: a value on one line, and a plain dash list a line at a time (a single value is not set over one).
			const editable = shape === "new" || SINGLE.includes(shape as Shape) || (shape === "dash" && op !== "set");
			const item = rand() < 0.5 && cur.length ? pick(cur) : pick(POOL);
			const other = pick(POOL);
			let out: string | null;
			// What the key reads as afterwards: its values, "unchanged" for the text as it was, null for no key.
			let want: string[] | "unchanged" | null;
			if (op === "set") {
				out = withFrontMatter(text, key, item);
				want = [item.trim()];
			} else if (op === "add") {
				out = addToFrontMatterList(text, key, item);
				want = cur.some((v) => sameAs(v, item)) ? "unchanged" : [...cur, item.trim()];
			} else if (op === "remove") {
				out = removeFromFrontMatterList(text, key, item);
				const kept = cur.filter((v) => !sameAs(v, item));
				want = kept.length === cur.length ? "unchanged" : kept.length ? kept : null;
			} else if (op === "replace") {
				out = replaceInFrontMatterList(text, key, item, other);
				want = cur.some((v) => sameAs(v, item)) ? cur.map((v) => (sameAs(v, item) ? other.trim() : v)).filter((v, i, all) => all.findIndex((o) => sameAs(o, v)) === i) : "unchanged";
			} else {
				out = removeFrontMatterKey(text, key);
				want = shape === "new" ? "unchanged" : null;
			}
			const where = `#${n} ${op} ${key} (${shape}) item=${JSON.stringify(item)} other=${JSON.stringify(other)}\n  before: ${JSON.stringify(text)}\n  after:  ${JSON.stringify(out)}`;
			if (!editable) seen.multi++;
			if (out === null) {
				seen.refused++;
				if (editable) failures.push(`refused a value that is edited in place: ${where}`);
				continue;
			}
			if (!editable && op !== "drop") {
				// Not refused: then nothing was there to change (the item is not one the key's own line shows).
				if (out !== text) failures.push(`edited a value that runs over several lines: ${where}`);
				continue;
			}
			if (want === "unchanged") {
				if (out !== text) failures.push(`changed a text there was nothing to change in: ${where}`);
				continue;
			}
			seen.edited++;
			if (!out.startsWith(prefix) || !out.endsWith(suffix) || prefix.length + suffix.length > out.length) {
				failures.push(`a line that was not the key's changed: ${where}`);
				continue;
			}
			let after: Record<string, unknown>;
			try {
				after = read(out.slice(head.length, out.length - tail.length));
			} catch (e) {
				failures.push(`left YAML that does not read (${e}): ${where}`);
				continue;
			}
			for (const k of new Set([...Object.keys(before), ...Object.keys(after)])) {
				if (k !== key && JSON.stringify(before[k]) !== JSON.stringify(after[k])) failures.push(`another key changed (${k}): ${where}`);
			}
			const got = key in after ? asList(after[key]) : null;
			// A dash list that has the new item already loses the old one's line; a list on one line has the new one take the old one's place.
			const same = op === "replace" && got && want ? JSON.stringify([...got].sort()) === JSON.stringify([...want].sort()) : JSON.stringify(got) === JSON.stringify(want);
			if (!same) failures.push(`read back ${JSON.stringify(got)}, wanted ${JSON.stringify(want)}: ${where}`);
		}
		expect(failures).toEqual([]);
		// The fuzz did meet the several-line shapes, refused among them, and made real edits.
		expect(seen.multi).toBeGreaterThan(3000);
		expect(seen.refused).toBeGreaterThan(1500);
		expect(seen.edited).toBeGreaterThan(5000);
	});

	test("the Inspector says so when a property is refused (source read: the handlers live in the component and need a DOM)", () => {
		const src = readSrc("../src/view/panels/MarkdownInspector.tsx");
		const from = src.indexOf("const commitInlinePropertyEdit =");
		const to = src.indexOf("const linkifyUnlinkedMention =");
		const handlers = src.slice(from, to);
		// Inline edit, the pick of a value, and the x on one value of a list: each tells the person, none falls through.
		expect((handlers.match(/if \(next === null\) (?:return void )?sayNotEditedHere\(key\)/g) ?? []).length).toBe(3);
		expect(handlers).not.toContain("if (next && next !== cur) applyDocTextUpdate(next)");
		expect(src).toContain("is written over several lines and was not changed - click YAML to edit its raw block.");
	});
});

// ---------------------------------------------------------------------------------------------------------------
describe("2. split into sub-ticket: only the picked items' lines leave the parent", () => {
	const doc = [
		"---", "ticket: LIMS-1", "---", "# LIMS-1: Importer", "",
		"## What is asked", "", "```python", "def a():", "    pass", "", "", "def b():", "    pass", "```", "",
		"## What done looks like", "", "- [ ] Build importer", "  - handles CSV", "  - handles JSON", "- [ ] Write docs", "",
		"## Notes", "", "```sh", "# deploy steps", "## not a heading", "make", "```", "", "tail", "",
	].join("\n");

	test("the code fence keeps its blank lines, the link goes after the section's last line, the sub-bullets go with their item", () => {
		const { text, moved } = splitParentTicketChecklist(doc, new Set([19]), "LIMS-1-1", "Build importer");
		const want = [
			"---", "ticket: LIMS-1", "---", "# LIMS-1: Importer", "",
			// Before: the two blank lines between the functions were collapsed to one, in a code block.
			"## What is asked", "", "```python", "def a():", "    pass", "", "", "def b():", "    pass", "```", "",
			// Before: `  - handles CSV` and `  - handles JSON` stayed behind, under "Write docs" in effect.
			"## What done looks like", "", "- [ ] Write docs", "",
			// Before: the link was spliced in after `# deploy steps`, inside the fenced script.
			"## Notes", "", "```sh", "# deploy steps", "## not a heading", "make", "```", "", "tail", "- Split to [[LIMS-1-1]]: Build importer", "",
		].join("\n");
		expect(text).toBe(want);
		expect(moved).toEqual(["- [ ] Build importer\n  - handles CSV\n  - handles JSON"]);
	});

	test("every line that is not moved is byte for byte as it was, CRLF and odd spacing included", () => {
		const crlf = "# T\r\n\r\n\r\n\r\ntext   \r\n\r\n* [ ]   First\r\n\tsub one\r\n\r\n\tsub two\r\n* [ ] Second\r\n\r\n\r\n## Notes\r\n\r\n- a note\r\n\r\n\r\n## After\r\n\r\n\r\nend";
		const { text, moved } = splitParentTicketChecklist(crlf, new Set([7]), "T-2", "First");
		expect(text).toBe("# T\r\n\r\n\r\n\r\ntext   \r\n\r\n* [ ] Second\r\n\r\n\r\n## Notes\r\n\r\n- a note\r\n- Split to [[T-2]]: First\r\n\r\n\r\n## After\r\n\r\n\r\nend");
		// The item goes to the child as a `- [ ]` line, its own lines under it without the item's indent.
		expect(moved).toEqual(["- [ ] First\n\tsub one\n\n\tsub two"]);
	});

	test("a ticket with no Notes section gets one at its end; an empty one is filled", () => {
		expect(splitParentTicketChecklist("# T\n\n- [ ] a\n- [ ] b\n", new Set([3]), "T-2", "a").text).toBe("# T\n\n- [ ] b\n\n## Notes\n\n- Split to [[T-2]]: a\n");
		expect(splitParentTicketChecklist("# T\n\n- [ ] a\n- [ ] b", new Set([4]), "T-2", "b").text).toBe("# T\n\n- [ ] a\n\n## Notes\n\n- Split to [[T-2]]: b\n");
		expect(splitParentTicketChecklist("# T\n\n- [ ] a\n\n## Notes\n\n## Next\n", new Set([3]), "T-2", "a").text).toBe("# T\n\n## Notes\n\n- Split to [[T-2]]: a\n\n## Next\n");
		// The only item of a list that stood between two blank lines takes one of them along: no gap of two is left.
		expect(splitParentTicketChecklist("# T\n\n## Done\n\n- [ ] a\n\n## Notes\n\nkept\n", new Set([5]), "T-2", "a").text).toBe("# T\n\n## Done\n\n## Notes\n\nkept\n- Split to [[T-2]]: a\n");
	});

	test("an item picked under one that is picked goes once, as part of it; one picked alone leaves its parent item", () => {
		const nestedDoc = "# T\n\n- [ ] outer\n  - [ ] inner\n    detail\n- [ ] other\n\n## Notes\n\nn\n";
		const both = splitParentTicketChecklist(nestedDoc, new Set([3, 4]), "T-2", "x");
		expect(both.moved).toEqual(["- [ ] outer\n  - [ ] inner\n    detail"]);
		expect(both.text).toBe("# T\n\n- [ ] other\n\n## Notes\n\nn\n- Split to [[T-2]]: x\n");
		const inner = splitParentTicketChecklist(nestedDoc, new Set([4]), "T-2", "x");
		expect(inner.moved).toEqual(["- [ ] inner\n  detail"]);
		expect(inner.text).toBe("# T\n\n- [ ] outer\n- [ ] other\n\n## Notes\n\nn\n- Split to [[T-2]]: x\n");
	});
});

// ---------------------------------------------------------------------------------------------------------------
describe("3. Health: a wikilink is not given another note's name without a word", () => {
	const mend = (name: string, instead: string, column = 0): WikiLinkMend => ({ line: 1, column, name, href: `[[${name}]]`, instead });

	test("a name that differs in a digit is not offered at all; a slip of the hand still is (the real listing)", async () => {
		const root = join(base, "wiki");
		const put = (rel: string, text: string) => {
			mkdirSync(dirname(join(root, rel)), { recursive: true });
			writeFileSync(join(root, rel), text);
		};
		put("docs/knowledge/reference/Release-2.0-notes.md", "# Release 2.0 notes\n\n## Shipped\n\nThings.\n");
		put("docs/knowledge/reference/Test-plan-1.md", "# Test plan 1\n\nSteps.\n");
		put("docs/specs/Importer.md", "---\ntitle: Importer\nstatus: draft\n---\n# Importer\n\nTo be written next sprint: [[Release 2.1 notes]] and [[Test plan 2]].\n\nA slip: [[Relase-2.0-notes]]. A move: [[old/Test-plan-1]].\n");
		const docs = await listDocs(new WorkspaceFiles(root), await readProject(root));
		const spec = docs.find((d) => d.name.endsWith("Importer.md"))!;
		const byHref = new Map((spec.broken ?? []).map((b) => [b.href, b.instead]));
		// Before: instead was "Release-2.0-notes" and "Test-plan-1", and one click on Mend wrote them.
		expect(byHref.has("[[Release 2.1 notes]]")).toBe(true);
		expect(byHref.get("[[Release 2.1 notes]]")).toBeUndefined();
		expect(byHref.has("[[Test plan 2]]")).toBe(true);
		expect(byHref.get("[[Test plan 2]]")).toBeUndefined();
		expect(byHref.get("[[Relase-2.0-notes]]")).toBe("Release-2.0-notes");
		expect(byHref.get("[[old/Test-plan-1]]")).toBe("Test-plan-1");

		// The check offers the two that have a name to offer, and they are told apart: one is the same file, one a guess.
		const check = docChecks(docs).find((c) => c.fix?.kind === "mend-wikilinks")!;
		const mends = check.fix?.kind === "mend-wikilinks" ? check.fix.mends : [];
		expect(mends.map((m) => m.name).sort()).toEqual(["Relase-2.0-notes", "old/Test-plan-1"]);
		const { moved, guessed } = splitWikiMends(mends);
		expect(moved.map((m) => m.name)).toEqual(["old/Test-plan-1"]);
		expect(guessed.map((m) => m.name)).toEqual(["Relase-2.0-notes"]);
		// What "Mend all" writes: the moved one alone; the forward links and the slip stay as written.
		const bulk = movedLinkMends([{ path: check.path, fix: { kind: "mend-wikilinks", mends } }]);
		const after = withNames(readFileSync(check.path, "utf8"), [...bulk.byPath.values()][0]!.mends.map((m) => m.edit as WikiLinkMend)).text;
		expect(after).toContain("[[Release 2.1 notes]] and [[Test plan 2]]");
		expect(after).toContain("[[Relase-2.0-notes]]. A move: [[Test-plan-1]].");
	});

	test("which mends keep the link's name", () => {
		expect(mendKeepsName({ name: "old-dir/Due-soon-report", instead: "Due-soon-report" })).toBe(true);
		expect(mendKeepsName({ name: "DueSoonReport", instead: "Due-soon-report" })).toBe(true);
		expect(mendKeepsName({ name: "due_soon_report.md", instead: "docs/specs/Due-soon-report" })).toBe(true);
		expect(mendKeepsName({ name: "old/query.sql", instead: "../samples/query.sql" })).toBe(true);
		expect(mendKeepsName({ name: "Release 2.1 notes", instead: "Release-2.0-notes" })).toBe(false);
		expect(mendKeepsName({ name: "Relase-notes", instead: "Release-notes" })).toBe(false);
		expect(mendKeepsName({ name: "Due soon report", instead: "0007-due-soon" })).toBe(false);
		expect(mendKeepsName({ name: "Plan é", instead: "Plan-è" })).toBe(false);
	});

	test("the question shows each link as written and as it would be", () => {
		const one = guessedMendQuestion("Importer.md", [mend("Relase-notes", "Release-notes")]);
		expect(one).toContain("[[Relase-notes]] → [[Release-notes]]");
		expect(one).toContain("Importer.md");
		expect(one).toContain("may be a different note");
		const many = guessedMendQuestion("Importer.md", [mend("A1", "B1"), mend("A2", "B2"), mend("A3", "B3"), mend("A4", "B4"), mend("A5", "B5")]);
		expect(many).toContain("Rewrite 5 wikilinks in Importer.md");
		expect(many).toContain("[[A1]] → [[B1]], [[A2]] → [[B2]], [[A3]] → [[B3]] and 2 more");
	});

	test("Mend all takes the links whose files moved, and counts the guesses it leaves", () => {
		const plan = movedLinkMends([
			{ path: "/w/docs/a.md", fix: { kind: "links", mends: [{ line: 3, column: 2, href: "../old/b.md", instead: "/w/docs/new/b.md" }] } },
			{ path: "/w/docs/a.md", fix: { kind: "mend-wikilinks", mends: [mend("old/Note", "Note"), mend("Relase-notes", "Release-notes")] } },
			{ path: "/w/docs/c.md", fix: { kind: "mend-wikilinks", mends: [mend("Plan 2", "Plan-1"), mend("Tset-plan", "Test-plan")] } },
		]);
		expect(plan.links).toBe(2);
		expect(plan.guessed).toBe(3);
		// The check whose every mend is a guess has nothing for the bulk mend: its document is not in the plan.
		expect(plan.checks).toBe(2);
		expect([...plan.byPath.keys()]).toEqual(["/w/docs/a.md"]);
		expect(plan.byPath.get("/w/docs/a.md")!.mends.map((m) => m.kind)).toEqual(["path", "wiki"]);
	});

	test("Mend asks before a guess is written (source read: the handler is inside the Health component and its dialog needs a DOM)", () => {
		const src = readSrc("../src/view/panels/Health.tsx");
		const one = src.slice(src.indexOf("const mendWikiLinks = async"), src.indexOf("const fixReciprocalAdr = async"));
		expect(one).toContain("await choose(guessedMendQuestion(baseName(path), guessed)");
		expect(one.indexOf("await choose(")).toBeLessThan(one.indexOf("withNames(before, mends)"));
		expect(one).toContain("if (!picked || state.workspace?.root !== startRoot) return;");
		const all = src.slice(src.indexOf("const mendAllBrokenLinks = async"), src.indexOf("const syncSchemaFromSql = async"));
		expect(all).toContain("= bulkMends()");
		expect(all).toContain("not among them");
		expect(src).toContain("const bulkMends = createMemo(() => movedLinkMends(mendableChecks()));");
	});
});

// ---------------------------------------------------------------------------------------------------------------
describe("4. renaming a heading that has a twin", () => {
	const doc = ["# Guide", "", "See [setup notes](#notes) and [teardown notes](#notes-1). Also [[#Notes]] and [[#notes-1]].", "", "## Setup", "", "### Notes", "", "first", "", "## Teardown", "", "### Notes", "", "second", ""].join("\n");
	const twins = documentHeadings(doc).filter((h) => h.text === "Notes");
	const rename = (heading: (typeof twins)[number], newHeading: string, newAnchor: string, text = doc) =>
		rewriteHeadingReferences(text, { isSameDoc: true, matchesDocHref: () => false, matchesWikiTarget: () => false, oldHeading: heading.text, oldAnchor: heading.anchor, newHeading, newAnchor });

	test("the second of two: only the links to its numbered anchor are rewritten", () => {
		expect(twins.map((h) => h.anchor)).toEqual(["notes", "notes-1"]);
		const res = rename(twins[1]!, "Cleanup remarks", "cleanup-remarks");
		// Before: all four were rewritten (count 4), the two that lead to the first heading among them.
		expect(res.count).toBe(2);
		expect(res.text.split("\n")[2]).toBe("See [setup notes](#notes) and [teardown notes](#cleanup-remarks). Also [[#Notes]] and [[#cleanup-remarks]].");
	});

	test("the first of two: the links by its words and by its plain anchor, not the ones to its twin", () => {
		const res = rename(twins[0]!, "Preparation", "preparation");
		expect(res.count).toBe(2);
		expect(res.text.split("\n")[2]).toBe("See [setup notes](#preparation) and [teardown notes](#notes-1). Also [[#Preparation]] and [[#notes-1]].");
	});

	test("renamed to words an earlier heading has: a link by name is written with the anchor, which alone says which", () => {
		const text = "# G\n\n[[#Second part]] and [x](#second-part)\n\n## Setup\n\n## Second part\n";
		const second = documentHeadings(text).find((h) => h.text === "Second part")!;
		const res = rename(second, "Setup", "setup-1", text);
		// `[[#Setup]]` would lead to the first Setup.
		expect(res.text.split("\n")[2]).toBe("[[#setup-1]] and [x](#setup-1)");
	});

	test("a heading whose words end in a sharp keeps no stray one", () => {
		// Before: "## Notes on .NET#": the sharp of "C#" was taken for a closing hash and kept.
		expect(renamedHeadingLine("## Notes on C#", "Notes on .NET")).toBe("## Notes on .NET");
		expect(documentHeadings(renamedHeadingLine("## Notes on C#", "Notes on .NET"))[0]?.text).toBe("Notes on .NET");
		expect(renamedHeadingLine("## Plain ##", "New")).toBe("## New ##");
		expect(renamedHeadingLine("## Plain", "New")).toBe("## New");
		expect(renamedHeadingLine("  ### Old words   ", "New $1 words")).toBe("  ### New $1 words   ");
		// A hash after a space is a closing one, here as where headings are read.
		expect(renamedHeadingLine("## Ticket #", "Ticket number")).toBe("## Ticket number #");
		expect(documentHeadings("## Ticket #")[0]?.text).toBe("Ticket");
	});
});

// ---------------------------------------------------------------------------------------------------------------
describe("5. a bare name is followed only where it led to the file that moved", () => {
	const root = "/w";
	const files = [
		"/w/docs/tickets/T-1/T-1.md",
		"/w/docs/tickets/T-1/attachments/shot.png",
		"/w/docs/tickets/T-2/T-2.md",
		"/w/docs/tickets/T-2/attachments/shot.png",
		"/w/docs/specs/Importer.md",
		"/w/docs/specs/query.sql",
		"/w/samples/query.sql",
		"/w/samples/Readme.md",
	];
	const docs = [
		{ path: "/w/docs/tickets/T-1/T-1.md", name: "T-1/T-1.md", group: "tickets", exists: true, ticket: "T-1" },
		{ path: "/w/docs/tickets/T-2/T-2.md", name: "T-2/T-2.md", group: "tickets", exists: true, ticket: "T-2" },
		{ path: "/w/docs/specs/Importer.md", name: "Importer.md", group: "specs", exists: true },
	] as any[];
	const before = { files, docs, root, docsFolder: "docs", attachments: null };
	const renamed = [{ fromCanon: "/w/docs/tickets/T-1/attachments/shot.png", toCanon: "/w/docs/tickets/T-1/attachments/login-error.png" }];
	const at = (path: string, embed = true) => ({ was: path, is: path, embed });

	test("each ticket's `![[shot.png]]` is its own picture: renaming T-1's leaves T-2's embed alone", () => {
		expect(bareNameTarget("shot.png", "/w/docs/tickets/T-2/T-2.md", files, { root })).toBe("/w/docs/tickets/T-2/attachments/shot.png");
		expect(bareNameTarget("shot.png", "/w/docs/tickets/T-1/T-1.md", files, { root })).toBe("/w/docs/tickets/T-1/attachments/shot.png");
		// Before: "login-error.png" was offered for T-2's embed too, which would then show T-1's picture or none.
		expect(bareNameFollowed("shot.png", at("/w/docs/tickets/T-2/T-2.md"), renamed, before)).toBeNull();
		expect(bareNameFollowed("shot.png", at("/w/docs/tickets/T-1/T-1.md"), renamed, before)).toBe("login-error.png");
	});

	test("a picture is found as the page finds it: beside the document, the attachment folders, then the nearest", () => {
		const where = { root, docs: "docs", attachments: "media" };
		const more = [...files, "/w/media/shot.png", "/w/docs/attachments/logo.png", "/w/assets/logo.png", "/w/docs/specs/near.png", "/w/far/away/deep/near.png"];
		// The configured folder comes before the document's own attachments, as in the view's resolveImageTarget.
		expect(bareNameTarget("shot.png", "/w/docs/tickets/T-2/T-2.md", more, where)).toBe("/w/media/shot.png");
		expect(bareNameTarget("logo.png", "/w/docs/specs/Importer.md", more, where)).toBe("/w/docs/attachments/logo.png");
		expect(bareNameTarget("near.png", "/w/docs/tickets/T-2/T-2.md", more, where)).toBe("/w/docs/specs/near.png");
		expect(bareNameTarget("SHOT.PNG", "/w/docs/tickets/T-2/T-2.md", files, { root })).toBe("/w/docs/tickets/T-2/attachments/shot.png");
		expect(bareNameTarget("none.png", "/w/docs/tickets/T-2/T-2.md", files, { root })).toBeNull();
		// From a document with no picture of that name near it, the nearest in the project is meant: that one is followed.
		expect(bareNameFollowed("shot.png", at("/w/docs/tickets/T-1/notes/Log.md"), renamed, before)).toBe("login-error.png");
	});

	test("a file that is no picture is the one beside the document or at the project's top, and a document's name means the document", () => {
		const sqlRenamed = [{ fromCanon: "/w/samples/query.sql", toCanon: "/w/samples/report.sql" }];
		// `![[query.sql]]` in a spec is the spec folder's own query.sql: the rename of the sample's is not followed there.
		expect(bareNameFollowed("query.sql", at("/w/docs/specs/Importer.md"), sqlRenamed, before)).toBeNull();
		expect(bareNameFollowed("query.sql", at("/w/samples/Readme.md"), sqlRenamed, before)).toBe("report.sql");
		// A name one of the project's documents answers to is that document, wherever a file of the name lies.
		const docRenamed = [{ fromCanon: "/w/samples/Importer.md", toCanon: "/w/samples/Exporter.md" }];
		expect(bareNameFollowed("Importer.md", at("/w/samples/Readme.md", false), docRenamed, { ...before, files: [...files, "/w/samples/Importer.md"] })).toBeNull();
	});

	test("the same name moved to another folder is written as the way there, only from the document it was beside", () => {
		const moved = [{ fromCanon: "/w/docs/specs/query.sql", toCanon: "/w/docs/archive/query.sql" }];
		expect(bareNameFollowed("query.sql", at("/w/docs/specs/Importer.md"), moved, before)).toBe("../archive/query.sql");
		expect(bareNameFollowed("query.sql", at("/w/samples/Readme.md"), moved, before)).toBeNull();
	});
});

// ---------------------------------------------------------------------------------------------------------------
describe("6. a write through the editor does not format the file", () => {
	test("put() saves with format off, as its twins do (source read: put() needs an open editor document, the backend and the language server)", () => {
		const src = readSrc("../src/view/projectDocs.ts");
		const put = src.slice(src.indexOf("async function put(path: string, text: string, existed: boolean)"), src.indexOf("/** Writes an area's catalog afresh"));
		expect(put).toContain("await save(open, { format: false })");
		expect(put).not.toContain("await save(open))");
	});
});

// ---------------------------------------------------------------------------------------------------------------
describe("7. quick pick: the workspace symbols listed are the ones of what is typed now", () => {
	const sym = (name: string) => ({ name });
	const forGet = { query: "Get", list: [sym("GetSample"), sym("GetUser"), sym("TargetList")] };

	test("the list for this very question is listed whole", () => {
		expect(symbolsFor(forGet, "Get")).toBe(forGet.list);
		expect(symbolsFor({ query: "", list: forGet.list }, "")).toBe(forGet.list);
	});

	test("a list held for an earlier question shows only what answers the new one", () => {
		// Before: all three rows stayed while "Save" was waited for, and Enter opened GetSample.
		expect(symbolsFor(forGet, "Save")).toEqual([]);
		expect(symbolsFor(forGet, "GetU").map((s) => s.name)).toEqual(["GetUser"]);
		expect(symbolsFor(forGet, "get sam").map((s) => s.name)).toEqual(["GetSample"]);
		// Nothing typed asks for nothing in particular: rows held for another question are not shown for it.
		expect(symbolsFor(forGet, "")).toEqual([]);
		// Ranked as file search is: a name that starts with it before one that has it inside, the shorter first.
		expect(symbolsFor(forGet, "Get ").map((s) => s.name)).toEqual(["GetUser", "GetSample", "TargetList"]);
		expect(symbolsFor(undefined, "Get")).toEqual([]);
	});

	test("the list is kept with its question, and Enter waits where no row answers (source read: the picker is a component)", () => {
		const src = readSrc("../src/view/QuickPick.tsx");
		expect(src).toContain("return { query: q, list: seq === symbolSeq ? list : [], capped: all.capped };");
		expect(src).toContain("symbolsFor(symbols(), query()).slice(0, 150)");
		expect(src).toContain("else if (loading()) setPendingEnter(true);");
	});
});
