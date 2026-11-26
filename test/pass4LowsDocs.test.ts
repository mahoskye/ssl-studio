// Pass 4, the low findings in the project documents: a listing that still read through links out of the workspace
// (B4-1), ticket front matter that was half quoted (B4-2, B4-3), a ticket column added with commas to a .tsv of one
// column (B4-5), the wrong reason given for front matter that is never closed (B4-7), and the raw YAML box of the
// Inspector, whose hold on a line of three dashes began one key too late (B5-1).
// Each test runs the code it names. Three things are in code that cannot be run here and are read as source, each
// said where it is: the notices of the flows that ask something first (a picker needs the app), the Inspector's
// box (a textarea over an open editor document: what it writes, holds and says is `yamlBoxStep`, which is run),
// and the stylesheet.
import { afterAll, describe, expect, mock, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { flush, snapshot } from "solid-js";
import { listDocs, readProject } from "../src/bun/project";
import { WorkspaceFiles } from "../src/bun/workspace";
import { parseCsv } from "../src/shared/csv";
import {
	formatFrontMatterInnerReplacement,
	frontMatter,
	frontMatterInnerSpan,
	frontMatterRefusal,
	quoteYamlScalar,
	quoteYamlText,
	withFrontMatter,
	yamlBoxStep,
} from "../src/shared/frontMatter";
import { decisionTemplate, frontValue, questionTemplate, specTemplate, ticketKey, ticketTemplate } from "../src/shared/projectDocs";

const base = mkdtempSync(join(tmpdir(), "ssl-studio-p4l-docs-"));
afterAll(() => rmSync(base, { recursive: true, force: true }));
const readSrc = (rel: string) => readFileSync(join(import.meta.dir, rel), "utf8").replace(/\r\n/g, "\n");

// --- The few browser and Monaco names the view's modules ask for when they are loaded (as test/pass3LowsDocs.test.ts has them) ---
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
const noopProxy = (target: Record<string, any> = {}): any =>
	new Proxy(target, {
		get(held, prop) {
			if (prop in held) return held[prop as any];
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

const { registryTextWithRow, setStatus } = await import("../src/view/projectDocs");
const { canonical, dismiss, documents, state } = await import("../src/view/state");

// ---------------------------------------------------------------------------------------------------------------
// B4-1. Listing the documents reads no file through a link that leads out of the workspace
// ---------------------------------------------------------------------------------------------------------------

describe("B4-1 — the listing and links out of the workspace", () => {
	/** A link, or false where this system does not let one be made (the test is then passed over). */
	const link = (target: string, at: string) => {
		try {
			symlinkSync(target, at);
			return true;
		} catch {
			return false;
		}
	};
	/** A workspace beside a folder that is not part of it, with what another project keeps there. */
	const beside = (name: string) => {
		const root = join(base, name, "ws");
		const outside = join(base, name, "outside");
		for (const dir of [join(root, "docs"), join(root, "design"), join(root, "src"), outside]) mkdirSync(dir, { recursive: true });
		writeFileSync(join(outside, "notes.md"), "# Kept elsewhere\n\nSee [[Elsewhere-Only-Name]] and ![[elsewhere-only.png]].\n\n[gone](docs/elsewhere-gone.md)\n");
		writeFileSync(join(outside, "chart.json"), JSON.stringify({ title: "ELSEWHERE PLAN", ticket: "ELSE-1", status: "draft", targets: ["src/ElsewhereOnly.ssl"] }));
		writeFileSync(join(outside, "INDEX.md"), "# Elsewhere\n\n<!-- catalog -->\n\n- [a](a.ssl)\n\n<!-- /catalog -->\n\n[gone](elsewhere-private.md)\n");
		writeFileSync(join(root, "src", "a.ssl"), ":PROCEDURE A;\n:ENDPROC;\n");
		return { root, outside };
	};
	const listed = async (root: string) => listDocs(new WorkspaceFiles(root), await readProject(root));

	test("a README and an AGENTS.md that lead out are listed by name: not their links by name, not when they were changed", async () => {
		const { root, outside } = beside("readme-out");
		if (!link(join(outside, "notes.md"), join(root, "README.md")) || !link(join(outside, "notes.md"), join(root, "AGENTS.md"))) return;
		const list = await listed(root);
		for (const name of ["README.md", "AGENTS.md"]) {
			const doc = list.find((entry) => entry.name === name)!;
			expect(doc.exists).toBe(true);
			// Before: broken held [[Elsewhere-Only-Name]] and ![[elsewhere-only.png]], read from the other file.
			expect(doc.broken).toBeUndefined();
			expect(doc.headings).toBeUndefined();
			expect(doc.mtime).toBeUndefined();
		}
		expect(JSON.stringify(list).toLowerCase()).not.toContain("elsewhere");
	});

	test("a plan document's chart that leads out is named as its pair and not read", async () => {
		const { root, outside } = beside("chart-out");
		writeFileSync(join(root, "design", "Due.plan.md"), "What the plan is for.\n");
		if (!link(join(outside, "chart.json"), join(root, "design", "Due.plan.json"))) return;
		const doc = (await listed(root)).find((entry) => entry.name === "Due.plan.md")!;
		expect(doc.pairedPlan).toEqual({ name: "Due.plan.json" });
		// Before: title "ELSEWHERE PLAN", tickets ["ELSE-1"], codeRefs ["src/ElsewhereOnly.ssl"].
		expect(doc.title).toBeUndefined();
		expect(doc.tickets).toBeUndefined();
		expect(doc.codeRefs).toBeUndefined();
		expect(JSON.stringify(doc)).not.toContain("ELSE");
	});

	test("a code folder's catalog that leads out is not read, and so not listed as a catalog", async () => {
		const { root, outside } = beside("catalog-out");
		if (!link(join(outside, "INDEX.md"), join(root, "src", "INDEX.md"))) return;
		const list = await listed(root);
		// Before: listed in the project group as out of date for good, with the other file's broken link.
		expect(list.some((entry) => entry.catalog?.area === "code")).toBe(false);
		expect(JSON.stringify(list)).not.toContain("elsewhere-private");
	});

	test("a catalog in a code folder that is itself a link out is not read either", async () => {
		const { root, outside } = beside("code-folder-out");
		rmSync(join(root, "src"), { recursive: true });
		mkdirSync(join(outside, "code"));
		writeFileSync(join(outside, "code", "INDEX.md"), "<!-- catalog -->\n\n<!-- /catalog -->\n\n[gone](elsewhere-private.md)\n");
		if (!link(join(outside, "code"), join(root, "src"))) return;
		const list = await listed(root);
		expect(list.some((entry) => entry.catalog?.area === "code")).toBe(false);
		expect(JSON.stringify(list)).not.toContain("elsewhere-private");
	});

	test("links that stay inside the workspace are read as before", async () => {
		const { root } = beside("inside");
		mkdirSync(join(root, "kept"));
		writeFileSync(join(root, "kept", "readme.md"), "# This project\n\n## Getting started\n\nSee [[Nowhere-At-All]].\n");
		writeFileSync(join(root, "kept", "chart.json"), JSON.stringify({ title: "The plan", ticket: "DEMO-7", targets: ["src/a.ssl"] }));
		writeFileSync(join(root, "kept", "INDEX.md"), "# Code\n\n<!-- catalog -->\n\n<!-- /catalog -->\n\n[gone](not-there.md)\n");
		writeFileSync(join(root, "design", "Due.plan.md"), "What the plan is for.\n");
		if (!link(join(root, "kept", "readme.md"), join(root, "README.md"))) return;
		if (!link(join(root, "kept", "chart.json"), join(root, "design", "Due.plan.json"))) return;
		if (!link(join(root, "kept", "INDEX.md"), join(root, "src", "INDEX.md"))) return;
		const list = await listed(root);
		const readme = list.find((entry) => entry.name === "README.md")!;
		expect(readme.headings?.map((heading) => heading.text)).toEqual(["This project", "Getting started"]);
		expect(readme.broken?.map((b) => b.href)).toEqual(["[[Nowhere-At-All]]"]);
		expect(typeof readme.mtime).toBe("number");
		const plan = list.find((entry) => entry.name === "Due.plan.md")!;
		expect(plan.title).toBe("The plan");
		expect(plan.tickets).toEqual(["DEMO-7"]);
		expect(plan.codeRefs).toEqual(["src/a.ssl"]);
		const catalog = list.find((entry) => entry.catalog?.area === "code")!;
		expect(catalog.name).toBe("src/INDEX.md");
		expect(catalog.catalog?.stale).toBe(true);
		expect(catalog.broken?.map((b) => b.href)).toEqual(["not-there.md"]);
	});
});

// ---------------------------------------------------------------------------------------------------------------
// B4-2, B4-3. Every value the ticket template writes is quoted by one rule, and reads back as it was written
// ---------------------------------------------------------------------------------------------------------------

/**
 * What a YAML reader makes of a scalar written bare after `key: ` (or, with `inList`, as an item of `[a, b]`),
 * reasoned from the specification and not from this app's reader: "text" when it is read as the same string, or
 * the reason it is not. The plain-scalar rules are YAML 1.2's (7.3.3: what may open one, `: ` and ` #` inside,
 * the flow indicators inside a flow collection); the types are the 1.2 core schema's (10.3.2) and YAML 1.1's
 * (booleans, numbers with `_`, base 2, base 8 and base 60, dates, `=` and `<<`).
 */
function bareYamlReads(v: string, inList = false): string {
	if (v === "") return "nothing (null)";
	if (/[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u2028\u2029\ufeff\ufffe\uffff]/.test(v) || /[\t\n\r]/.test(v)) return "a character no plain scalar may hold, or a line end";
	if (v !== v.trim()) return "space at an end, which is dropped";
	if (/^[,[\]{}#&*!|>'"%@`]/.test(v)) return "an indicator at the start";
	if (/^[-?:](\s|$)/.test(v)) return "a list item, a key or a value mark";
	if (inList && /^[-?:]/.test(v)) return "an indicator at the start of a flow item";
	if (/:(\s|$)/.test(v) || /\s#/.test(v)) return "a key or a comment inside";
	if (inList && /[,[\]{}]/.test(v)) return "a flow indicator inside";
	if (inList && /:/.test(v)) return "a colon in a flow item";
	if (/^(---|\.\.\.)(\s|$)/.test(v)) return "a document mark";
	if (/^(~|null|Null|NULL)$/.test(v)) return "null";
	if (/^(true|True|TRUE|false|False|FALSE)$/.test(v)) return "a boolean (1.2)";
	if (/^(y|Y|yes|Yes|YES|n|N|no|No|NO|on|On|ON|off|Off|OFF)$/.test(v)) return "a boolean (1.1)";
	if (/^[-+]?[0-9]+$/.test(v) || /^0o[0-7]+$/.test(v) || /^0x[0-9a-fA-F]+$/.test(v)) return "an integer (1.2)";
	if (/^[-+]?(\.[0-9]+|[0-9]+(\.[0-9]*)?)([eE][-+]?[0-9]+)?$/.test(v) || /^[-+]?\.(inf|Inf|INF)$/.test(v) || /^\.(nan|NaN|NAN)$/.test(v)) return "a float (1.2)";
	if (/^[-+]?(0b[0-1_]+|0[0-7_]+|(0|[1-9][0-9_]*)|0x[0-9a-fA-F_]+|[1-9][0-9_]*(:[0-5]?[0-9])+)$/.test(v)) return "an integer (1.1)";
	if (/^[-+]?([0-9][0-9_]*)?\.[0-9.]*([eE][-+][0-9]+)?$/.test(v) || /^[-+]?[0-9][0-9_]*(:[0-5]?[0-9])+\.[0-9_]*$/.test(v)) return "a float (1.1)";
	if (/^[0-9]{4}-[0-9]{1,2}-[0-9]{1,2}([Tt ][0-9:.]+.*)?$/.test(v)) return "a date (1.1)";
	if (v === "=" || v === "<<") return "a value or merge mark (1.1)";
	return "text";
}

/** What a YAML reader makes of a value as this app wrote it: its text, or why not. A quoted one is JSON's string, which YAML's double-quoted scalar reads the same. */
function yamlReads(written: string, inList = false): string {
	if (written.startsWith('"')) {
		// No character a YAML reader refuses or folds, even between quotes (1.1 takes U+0085, U+2028 and U+2029 for line ends).
		if (/[\u0000-\u001f\u007f-\u009f\u2028\u2029\ufeff\ufffe\uffff]/.test(written)) return "ERROR: a raw control character or line separator between the quotes";
		return JSON.parse(written) as string;
	}
	const how = bareYamlReads(written, inList);
	return how === "text" ? written : `ERROR: read as ${how}`;
}

/** The runtime's own YAML reader, where it has one: a second opinion beside the rules above. */
const runtimeYaml: ((text: string) => any) | undefined = typeof (Bun as any).YAML?.parse === "function" ? (text: string) => (Bun as any).YAML.parse(text) : undefined;

const TRAPS = [
	// what B4-3 names
	"@team", "*star", "&anchor", "!bang", "%pct", "|pipe", ">gt", "- dash", "NO", "ON", "NULL", "12", "1E3",
	// the rest of the words and numbers a reader types
	"yes", "no", "on", "off", "null", "~", "true", "False", "Y", "n", "123", "0123", "1e3", "1_000", "0x1F", "0o17", "0b101", "-5", "+5", "3.14", ".5", "5.", ".inf", "-.INF", ".NaN", "2026-11-25", "12:30", "1-2", "=", "<<",
	// marks at the start, in the middle and at the end
	"`tick", "-dash", "?q", "? q", "key:", "a: b", "a #b", "a#b", "it's", '"q"', "back\\slash", "#12", "[x]", "{x}", "a,b", "a, b", "---", "...", ":x", "x:y", "https://tracker.example/browse/DEMO-1",
	// characters
	"a\tb", "a\u2028b", "a\u2029b", "a\u0085b", "a\u007fb", "ÅÄÖ-12", "Fünf mal: nein",
];
const PLAIN = ["LIMS-123", "DEMO_1", "ÅÄÖ-12", "Sub-task", "in progress", "open", "Bug", "Add a due date", "No way back", "on hold", "12 monkeys", "v1.2", "x12", "e5", "docs/specs/Due-dates.md"];

describe("B4-2, B4-3 — ticket front matter is quoted by one rule", () => {
	test("the four fields that were written raw read back as they were given", () => {
		const text = ticketTemplate({ key: "#12", title: "T: x", parent: "#11", related: ["#13", "a, b"], blocks: ["[x]"], blockedBy: ["@team", "NO"] });
		const { values } = frontMatter(text);
		// Before: parent "" (`parent: #11` is a comment), related ["#13", "a", "b"], blocks the string "[[x]]".
		expect(values.parent).toBe("#11");
		expect(values.related).toEqual(["#13", "a, b"]);
		expect(values.blocks).toEqual(["[x]"]);
		expect(values["blocked-by"]).toEqual(["@team", "NO"]);
		expect(values.ticket).toBe("#12");
		expect(values.title).toBe("T: x");
		// An item that is nothing is no item, and a parent that is nothing is no parent.
		const sparse = ticketTemplate({ key: "LIMS-1", title: "One", parent: "  ", related: ["", "  ", "LIMS-2"] });
		expect(sparse).toContain("\nrelated: [LIMS-2]\n");
		expect(sparse).not.toContain("parent:");
	});

	test.each(TRAPS)("%p in every field: this app reads it back, and so does a YAML reader", (raw) => {
		const text = ticketTemplate({ key: raw, title: raw, type: raw, source: raw, status: raw, parent: raw, related: [raw, "DEMO-2", raw], blocks: [raw], blockedBy: ["DEMO-3", raw] });
		const head = text.slice(4, text.indexOf("\n---\n"));
		// This app's reader.
		const { values } = frontMatter(text);
		for (const key of ["ticket", "title", "type", "source", "status", "parent"]) expect([key, values[key]]).toEqual([key, raw]);
		expect(values.related).toEqual([raw, "DEMO-2", raw]);
		expect(values.blocks).toEqual([raw]);
		expect(values["blocked-by"]).toEqual(["DEMO-3", raw]);
		// A YAML reader's rules, line by line: a scalar after `key: `, or the items of a list on one line.
		for (const line of head.split("\n")) {
			const [, key, value] = /^([a-z-]+): (.*)$/.exec(line)!;
			if (key === "related" || key === "blocks" || key === "blocked-by") {
				const items = [...value!.slice(1, -1).matchAll(/\s*("(?:[^"\\]|\\.)*"|[^,"][^,]*)\s*(?:,|$)/g)].map((m) => m[1]!.trim());
				expect([key, ...items.map((item) => yamlReads(item, true))]).toEqual([key, ...(key === "related" ? [raw, "DEMO-2", raw] : key === "blocks" ? [raw] : ["DEMO-3", raw])]);
			} else expect([key, yamlReads(value!)]).toEqual([key, raw]);
		}
		// And the runtime's own reader, where there is one.
		if (runtimeYaml) {
			const read = runtimeYaml(head);
			expect(read).toEqual({ ticket: raw, title: raw, type: raw, source: raw, status: raw, parent: raw, related: [raw, "DEMO-2", raw], blocks: [raw], "blocked-by": ["DEMO-3", raw] });
		}
	});

	test("a ticket's key as the app makes it from what was typed is read as that key", () => {
		for (const typed of ["#12", "123", "no", "on", "null", "1e3", "-5", "0x1f", "2026-11-25", "lims 9"]) {
			const key = ticketKey(typed);
			const text = ticketTemplate({ key, title: "A title" });
			expect(frontMatter(text).values.ticket).toBe(key);
			expect(yamlReads(/^ticket: (.*)$/m.exec(text)![1]!)).toBe(key);
		}
	});

	test("what needs no quotes stays bare: a ticket file as it always was", () => {
		for (const value of PLAIN) expect(frontValue(value)).toBe(value);
		expect(ticketTemplate({ key: "LIMS-123", title: "Add a due date", type: "Sub-task", source: "tracker", status: "in progress", parent: "LIMS-100", related: ["LIMS-1", "LIMS-2"], blocks: ["LIMS-3"], blockedBy: ["LIMS-4"] }).split("\n---\n")[0]).toBe(
			["---", "ticket: LIMS-123", "title: Add a due date", "type: Sub-task", "source: tracker", "status: in progress", "parent: LIMS-100", "related: [LIMS-1, LIMS-2]", "blocks: [LIMS-3]", "blocked-by: [LIMS-4]"].join("\n"),
		);
		expect(ticketTemplate({ key: "LIMS-1", title: "One" }).split("\n---\n")[0]).toBe("---\nticket: LIMS-1\ntitle: One\nstatus: open\nrelated: []");
		// What was quoted before is quoted still, the same way.
		expect(frontValue("T: x")).toBe('"T: x"');
		expect(frontValue("it's")).toBe('"it\'s"');
		expect(frontValue("a,b")).toBe('"a,b"');
		expect(frontValue("two\nlines")).toBe("two lines");
	});

	test("the two writers agree: whatever a property's value is quoted for, a template's value is quoted for", () => {
		for (const value of [...TRAPS, ...PLAIN]) {
			const asProperty = quoteYamlScalar(value);
			if (asProperty !== value.trim()) expect([value, quoteYamlText(value)]).toEqual([value, asProperty]);
		}
		// The other templates write their values by the same rule.
		expect(frontMatter(specTemplate({ title: "@home", ticket: "12" })).values).toMatchObject({ title: "@home", ticket: "12" });
		expect(specTemplate({ title: "@home", ticket: "12" })).toContain('title: "@home"\nticket: "12"\n');
		expect(decisionTemplate({ title: "NO", date: "2026-11-25", ticket: "*" })).toContain('title: "NO"\n');
		expect(questionTemplate({ title: "- why", date: "2026-11-25" })).toContain('title: "- why"\n');
		// A property set in the Inspector is written as it was: a version is a number there if the person writes one.
		expect(withFrontMatter("---\ntitle: T\n---\n", "version", "2")).toBe("---\ntitle: T\nversion: 2\n---\n");
	});

	test("a character a YAML reader refuses or folds is written as an escape, and read back", () => {
		expect(quoteYamlText("a\u0085b")).toBe('"a\\u0085b"');
		expect(quoteYamlText("a\u007fb")).toBe('"a\\u007fb"');
		expect(quoteYamlText("a\tb")).toBe('"a\\tb"');
		expect(frontMatter(`---\ntitle: ${quoteYamlText("a\u0085b")}\n---\n`).values.title).toBe("a\u0085b");
	});
});

// ---------------------------------------------------------------------------------------------------------------
// B4-5. A ticket column and row added to a registry of one column are written with the file's own delimiter
// ---------------------------------------------------------------------------------------------------------------

describe("B4-5 — a registry of one column", () => {
	test("a .tsv is given its ticket column and its row with tabs", () => {
		// Before: "name,ticket\na,\nNEW,DEMO-1\n", which every reader of a .tsv takes for one column.
		const after = registryTextWithRow("name\na\n", "docs/registries/jobs.tsv", "NEW", "DEMO-1", true)!;
		expect(after).toBe("name\tticket\na\t\nNEW\tDEMO-1\n");
		const table = parseCsv(after, { prefer: "\t" });
		expect(table.header.map((cell) => cell.text)).toEqual(["name", "ticket"]);
		expect(table.rows.map((row) => row.map((cell) => cell.text))).toEqual([["a", ""], ["NEW", "DEMO-1"]]);
		expect(table.problems).toEqual([]);
	});

	test("so is a .TSV, a .tab, one with Windows line ends, and one whose values hold commas", () => {
		expect(registryTextWithRow("name\na\n", "docs/registries/JOBS.TSV", "NEW", "DEMO-1", true)).toBe("name\tticket\na\t\nNEW\tDEMO-1\n");
		expect(registryTextWithRow("name\na\n", "docs/registries/jobs.tab", "NEW", "DEMO-1", true)).toBe("name\tticket\na\t\nNEW\tDEMO-1\n");
		expect(registryTextWithRow("name\r\na\r\n", "docs/registries/jobs.tsv", "NEW", "DEMO-1", true)).toBe("name\tticket\r\na\t\r\nNEW\tDEMO-1\r\n");
		// A comma in a value of a .tsv is a comma: the value is one cell, before and after.
		expect(registryTextWithRow("name\nDoe, Jo\n", "docs/registries/people.tsv", "Roe, Al", "DEMO-1", true)).toBe("name\tticket\nDoe, Jo\t\nRoe, Al\tDEMO-1\n");
		// A row alone, where the one column is the tickets': no column is added, and none is needed to say so.
		expect(registryTextWithRow("name\na\n", "docs/registries/jobs.tsv", "NEW", "DEMO-1", false)).toBe("name\na\nNEW\n");
	});

	test("a .csv of one column takes commas, and a .tsv of several columns is read as before", () => {
		expect(registryTextWithRow("name\na\n", "docs/registries/jobs.csv", "NEW", "DEMO-1", true)).toBe("name,ticket\na,\nNEW,DEMO-1\n");
		expect(registryTextWithRow("name\tstatus\na\tdone\n", "docs/registries/jobs.tsv", "NEW", "DEMO-1", true)).toBe("name\tstatus\tticket\na\tdone\t\nNEW\tfound\tDEMO-1\n");
		expect(registryTextWithRow("name;status\na;done\n", "docs/registries/jobs.csv", "NEW", "DEMO-1", true)).toBe("name;status;ticket\na;done;\nNEW;found;DEMO-1\n");
	});
});

// ---------------------------------------------------------------------------------------------------------------
// B4-7. A front matter that is never closed is said to be that, not "written over several lines"
// ---------------------------------------------------------------------------------------------------------------

describe("B4-7 — the reason a front-matter edit was refused", () => {
	const unclosed = "---\ntitle: Due dates\nstatus: draft\n\n# Due dates\n\nNo closing fence above.\n";
	const folded = "---\ntitle: Due dates\nstatus: >\n  draft\n---\n\n# Due dates\n";
	/** A document open in the editor, as far as the flows here ask: its text, and that it is still there. */
	const open = (name: string, text: string) => {
		const path = join(base, "notices", name);
		documents.set(canonical(path), { binary: false, model: { isDisposed: () => false, getValue: () => text } } as any);
		return path;
	};
	const notices = () => {
		flush();
		return snapshot(state).messages.map((message) => message.text);
	};
	// The documents and the notices are the app's own state: both are taken back when these tests are done.
	afterAll(() => {
		for (const name of ["Unclosed.md", "Folded.md"]) documents.delete(canonical(join(base, "notices", name)));
		flush();
		for (const message of snapshot(state).messages) dismiss(message.id);
		flush();
	});

	test("Set status on a document whose front matter is never closed says so (the flow is run)", async () => {
		const path = open("Unclosed.md", unclosed);
		await setStatus(path, "done");
		// Before: "The status could not be set here: it is written over several lines. Change it in the text."
		expect(notices()).toContain("Could not set the status of Unclosed.md: its front matter is not closed (no closing ---). Close it in the text.");
		expect(notices().join("\n")).not.toContain("several lines");
	});

	test("Set status on a status that is written over several lines still says that", async () => {
		const path = open("Folded.md", folded);
		await setStatus(path, "done");
		expect(notices()).toContain("Could not set the status of Folded.md: its status: is written over several lines. Change it in the text.");
	});

	test("the reason is the writer's own (the function every notice below asks)", () => {
		expect(withFrontMatter(unclosed, "status", "done")).toBeNull();
		expect(frontMatterRefusal(unclosed, "status")).toBe("its front matter is not closed (no closing ---). Close it in the text.");
		expect(withFrontMatter(folded, "status", "done")).toBeNull();
		expect(frontMatterRefusal(folded, "status")).toBe("its status: is written over several lines. Change it in the text.");
	});

	test("the other notices ask it too, each with the text its writer refused (source read: each follows a picker)", () => {
		const src = readSrc("../src/view/projectDocs.ts");
		for (const asked of [
			'if (updatedOld === null) left.push(`${baseName(path)}: ${frontMatterRefusal(oldText, "superseded-by")}`);',
			'if (updatedTarget === null) left.push(`${baseName(targetDecision.path)}: ${frontMatterRefusal(targetText, "supersedes")}`);',
			'if (updatedOld === null) notify(`Could not write superseded-by: ${newStem} in ${baseName(path)}: ${frontMatterRefusal(oldText, "superseded-by")}`, "error");',
			'notify(`Could not set parent: ${key} in ${baseName(target.path)}: ${frontMatterRefusal(before, "parent")}`, "error");',
			"notify(`Could not add ${otherKey} to ${field}: in ${baseName(ticketPath)}: ${frontMatterRefusal(before, field)}`, \"error\");",
			"notify(`Could not add ${entry} to ${field}: in ${baseName(ticketPath)}: ${frontMatterRefusal(before, field)}`, \"error\");",
			"notify(`Could not link ${baseName(target.path)} to ${key}: ${frontMatterRefusal(before, field)}`, \"error\");",
			"notify(`Could not link ${baseName(docPath)} to ${ticket.ticket}: ${frontMatterRefusal(fresh, field)}`, \"error\");",
			'if (next === null) return notify(`Could not set source: in ${baseName(mdPath)}: ${frontMatterRefusal(freshCur, "source")}`, "error");',
		]) {
			expect(src).toContain(asked);
		}
		// None is left that names no reason, or one reason for both.
		expect(src).not.toContain("automatically in");
		expect(src).not.toContain("it is written over several lines");
		expect(src).not.toContain('"they are"} written over several lines');
		// An import of tickets names a file whose front matter is not closed apart from a value over several lines.
		expect(src).toContain("if (frontMatter(now).lines) unset.add(`${ticket.key} ${field}`);\n\t\t\t\t\telse unclosed.add(ticket.key);");
		expect(src).toContain("Not updated, because the file's front matter is not closed (no closing ---): ");
	});
});

// ---------------------------------------------------------------------------------------------------------------
// B5-1. The raw YAML box: nothing of a line on its way to three dashes is written, and what is held is said
// ---------------------------------------------------------------------------------------------------------------

describe("B5-1 — the Inspector's raw YAML box", () => {
	/**
	 * The box over a document, as the Inspector drives it: each input is a step from the text before to the text
	 * after, and what the step says to write goes between the document's fences, as `writeYamlInner` puts it there.
	 */
	const boxOver = (doc: string) => {
		const inner = () => frontMatterInnerSpan(doc)!.inner;
		let text = inner();
		let written = text;
		let said: string | null = null;
		const lost: string[] = [];
		const put = (next: string | null, over?: string) => {
			if (next === null) return;
			const span = frontMatterInnerSpan(doc)!;
			if (over !== undefined && span.inner !== over) return;
			doc = `${doc.slice(0, span.start)}${formatFrontMatterInnerReplacement(next, span.eol)}${doc.slice(span.end)}`;
			written = next;
		};
		return {
			/** The box's text becomes `next` in one input event. */
			input(next: string) {
				const step = yamlBoxStep(written, text, next);
				text = next;
				said = step.say;
				put(step.write);
				return step;
			},
			/** Keys typed one after another at the end of the box. */
			type(keys: string) {
				for (const key of keys) this.input(text + key);
			},
			backspace(times = 1) {
				for (let i = 0; i < times; i++) this.input(text.slice(0, -1));
			},
			/** Focus goes elsewhere, or a save asks for what is pending. */
			leave() {
				put(yamlBoxStep(written, text, text, "leave").write, written);
			},
			/** Escape, or the box is taken away. */
			close() {
				const step = yamlBoxStep(written, text, text, "close");
				said = null;
				if (step.lost) lost.push(step.lost);
				put(step.write, written);
			},
			/** The document's front matter is changed from elsewhere, and not yet shown in the box. */
			changedElsewhere(nextInner: string) {
				const span = frontMatterInnerSpan(doc)!;
				doc = `${doc.slice(0, span.start)}${formatFrontMatterInnerReplacement(nextInner, span.eol)}${doc.slice(span.end)}`;
			},
			get doc() {
				return doc;
			},
			get inner() {
				return inner();
			},
			get text() {
				return text;
			},
			get said() {
				return said;
			},
			get refused() {
				return said !== null;
			},
			lost,
		};
	};
	const DOC = "---\ntitle: T\n---\n\n# T\n\nBody.\n";

	test("three dashes typed as three keys: none of them reaches the document, and the box says so", () => {
		const box = boxOver(DOC);
		box.type("\n");
		expect(box.doc).toBe("---\ntitle: T\n\n---\n\n# T\n\nBody.\n");
		const before = box.doc;
		box.type("-");
		expect([box.doc, box.refused]).toEqual([before, false]);
		box.type("-");
		// Before: the document had a line `--` here, and kept it when the third dash was refused.
		expect([box.doc, box.refused]).toEqual([before, false]);
		box.type("-");
		expect(box.doc).toBe(before);
		expect(box.said).toBe("Line 2 is ---, which would end the front matter there. The box is not written to the document until that line is changed.");
		// What is typed under it is held with it.
		box.type("\nreviewer: you");
		expect(box.doc).toBe(before);
		expect(box.text).toBe("title: T\n---\nreviewer: you");
		expect(box.said).toContain("Line 2 is ---");
		expect(frontMatter(box.doc).values).toEqual({ title: "T" });
	});

	test("three dashes pasted in one event are refused the same", () => {
		const box = boxOver(DOC);
		const step = box.input("title: T\n---\nreviewer: you");
		expect(step).toEqual({ write: null, held: true, say: "Line 2 is ---, which would end the front matter there. The box is not written to the document until that line is changed.", lost: null });
		expect(box.doc).toBe(DOC);
		// Three dots end a front matter too, and are typed through one and two.
		const dots = boxOver(DOC);
		dots.type("\n.");
		dots.type(".");
		expect(dots.doc).toBe("---\ntitle: T\n\n---\n\n# T\n\nBody.\n");
		dots.type(".");
		expect(dots.said).toContain("Line 2 is ...");
		expect(dots.doc).toBe("---\ntitle: T\n\n---\n\n# T\n\nBody.\n");
	});

	test("mended, the box is written whole and says nothing more", () => {
		const box = boxOver(DOC);
		box.input("title: T\n---\nreviewer: you");
		expect(box.refused).toBe(true);
		// The line is made something else.
		box.input("title: T\n--- x\nreviewer: you");
		expect(box.refused).toBe(false);
		expect(box.inner).toBe("title: T\n--- x\nreviewer: you");
		// Or taken out, a key at a time: the box stops saying it is refused with the first, and is written when the line is gone.
		const other = boxOver(DOC);
		other.type("\n---");
		expect(other.refused).toBe(true);
		other.backspace();
		expect([other.refused, other.inner]).toEqual([false, "title: T\n"]);
		other.backspace(2);
		expect([other.refused, other.inner, other.text]).toEqual([false, "title: T\n", "title: T\n"]);
		other.type("owner: me");
		expect(other.inner).toBe("title: T\nowner: me");
	});

	test("one or two dashes are written once they become something else, or are left", () => {
		// A list item: the dash is held for the one key it may yet become three by, and no error is shown for it.
		const list = boxOver(DOC);
		list.type("\ntags:\n-");
		expect([list.inner, list.refused]).toEqual(["title: T\ntags:\n", false]);
		list.type(" a");
		expect(list.inner).toBe("title: T\ntags:\n- a");
		expect(frontMatter(list.doc).values.tags).toEqual(["a"]);
		// Left with Enter, a line of two dashes is a line like any other.
		const typo = boxOver(DOC);
		typo.type("\n--");
		expect(typo.inner).toBe("title: T\n");
		typo.type("\n");
		expect(typo.inner).toBe("title: T\n--\n");
		// So is one that another line is edited after.
		const elsewhere = boxOver(DOC);
		elsewhere.type("\n-");
		elsewhere.input("title: T2\n-");
		expect(elsewhere.inner).toBe("title: T2\n-");
		// A dash that was there before is no reason to hold an edit of another line.
		const had = boxOver("---\ntitle: T\ntags:\n-\n---\nBody\n");
		had.input("title: T2\ntags:\n-");
		expect(had.inner).toBe("title: T2\ntags:\n-");
	});

	test("leaving the box writes what can be written", () => {
		const box = boxOver(DOC);
		box.type("\n--");
		expect(box.inner).toBe("title: T\n");
		box.leave();
		expect(box.inner).toBe("title: T\n--");
		// With a line of three dashes there is nothing that can be: the box stays as it is, saying so.
		const held = boxOver(DOC);
		held.type("\n---\nreviewer: you");
		held.leave();
		expect(held.doc).toBe("---\ntitle: T\n\n---\n\n# T\n\nBody.\n");
		expect(held.said).toContain("is not written to the document");
		expect(held.lost).toEqual([]);
	});

	test("Escape with held text writes it, or says that it was not written", () => {
		const pending = boxOver(DOC);
		pending.type("\n-");
		pending.close();
		expect([pending.inner, pending.lost]).toEqual(["title: T\n-", []]);
		// Before: the box closed, and `---` and `reviewer: you` went with it without a word.
		const held = boxOver(DOC);
		held.type("\n---\nreviewer: you");
		held.close();
		expect(held.doc).toBe("---\ntitle: T\n\n---\n\n# T\n\nBody.\n");
		expect(held.lost).toEqual(["Line 2 of the raw YAML was still ---: what was typed in the box while that line stood was not written."]);
		// A box with nothing held closes without a word and without a write.
		expect(yamlBoxStep("title: T", "title: T", "title: T", "close")).toEqual({ write: null, held: false, say: null, lost: null });
		expect(yamlBoxStep("title: T", "title: T", "title: T", "leave")).toEqual({ write: null, held: false, say: null, lost: null });
	});

	test("what the box held back is not written over a front matter changed from elsewhere since", () => {
		const box = boxOver(DOC);
		box.type("\n-");
		box.changedElsewhere("title: T\nstatus: done");
		box.close();
		expect(box.inner).toBe("title: T\nstatus: done");
	});

	test("the Inspector asks at every way in and out of the box, and shows the refusal on it (source read)", () => {
		const src = readSrc("../src/view/panels/MarkdownInspector.tsx");
		const box = src.slice(src.indexOf("<Show when={!isRead() && editYaml() && yamlSpan()}>"), src.indexOf("{/* Section 2: Ticket Work & Readiness */}"));
		// Each input: typing, a completion taken, Tab.
		expect(box.match(/stepYamlBox\(el\.value\);/g)).toHaveLength(2);
		expect(box).toContain("stepYamlBox(next);");
		// Leaving: focus, and a save or a change of tab (state.ts asks every view that holds text).
		expect(box).toContain('if (e.currentTarget.isConnected) stepYamlBox(e.currentTarget.value, "leave");');
		expect(box).toMatch(/const release = holdsPendingEdit\(\s*\(\) => \{\s*if \(box\) stepYamlBox\(box\.value, "leave"\);\s*\},/);
		// And says whether it holds any: only then is a close of the desktop window asked of the view first.
		expect(box).toContain("() => Boolean(box && box.value !== yamlBoxWritten),");
		// Taken away, by any way: the cleanup of the box itself.
		expect(box).toMatch(/onCleanup\(\(\) => \{\s*release\(\);\s*const el = box;\s*const written = yamlBoxWritten;\s*const d = yamlBoxDoc;\s*if \(el\) queueMicrotask\(\(\) => closeYamlBox\(el\.value, written, d\)\);\s*\}\);/);
		// The refusal is on the box and under it for as long as it is said, and no longer.
		expect(box).toContain('aria-invalid={yamlRefusal() ? "true" : "false"}');
		expect(box).toMatch(/<Show when=\{yamlRefusal\(\)\}>\s*\{\(said\) => \(\s*<p class="cm-md-props-yaml-refused" role="alert">\s*\{said\(\)\}\s*<\/p>\s*\)\}\s*<\/Show>/);
		expect(src).toContain('if (event === "input") setYamlRefusal(step.say);');
		// No notice is raised for a line that can still be mended: an error notice stays until it is dismissed.
		expect(src.slice(src.indexOf("const stepYamlBox = "), src.indexOf("const closeYamlBox = "))).not.toContain("notify(");
	});

	test("a refused box has the border of an invalid field, from a colour both themes define (source read)", () => {
		const css = readSrc("../src/view/style.css");
		expect(css).toMatch(/\.md-inspector \.cm-md-props-yaml\[aria-invalid="true"\],\n\.md-inspector \.cm-md-props-yaml\[aria-invalid="true"\]:focus \{\n\tborder-color: var\(--error\);/);
		expect(css).toMatch(/\.md-inspector \.cm-md-props-yaml-refused \{[^}]*color: var\(--error\);/);
		// The dark theme's and the light theme's own value of it.
		expect(css.match(/^\t--error: #[0-9a-f]{6};$/gm)?.length).toBeGreaterThanOrEqual(1);
		expect(css.match(/^\t\t--error: #[0-9a-f]{6};$/gm)?.length).toBeGreaterThanOrEqual(1);
	});
});
