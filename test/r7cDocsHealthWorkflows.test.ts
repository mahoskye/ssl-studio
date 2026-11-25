import { describe, expect, mock, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { frontMatter, one, withFrontMatter } from "../src/shared/frontMatter";

// --- Minimal headless browser, CSS & Monaco shims so exported pure helpers from view/.tsx modules load under Bun ---
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
		innerWidth: 1280,
		innerHeight: 900,
		addEventListener() {},
		removeEventListener() {},
		location: { href: "http://localhost/", protocol: "http:", host: "127.0.0.1:5190" },
		matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
	};
} else if (!(globalThis as any).window.Error) {
	(globalThis as any).window.Error = Error;
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
if (typeof (globalThis as any).self === "undefined") {
	(globalThis as any).self = globalThis;
}

const makeUri = (scheme: string, fsPath: string) => {
	const normalized = fsPath.replace(/\\/g, "/");
	const raw = scheme === "file" ? `file://${normalized.startsWith("/") ? "" : "/"}${normalized}` : `${scheme}:${fsPath}`;
	return { scheme, fsPath, path: normalized, toString: () => raw };
};

mock.module(`${resolve(import.meta.dir, "../src/view/editor/markdownLive.worker.ts")}?worker`, () => ({
	default: class {},
}));
mock.module("monaco-editor/editor/editor.worker?worker", () => ({ default: class {} }));
mock.module("monaco-editor/features/register.all", () => ({}));
mock.module("monaco-editor/editor/contrib/semanticTokens/browser/documentSemanticTokens", () => ({}));
for (const lang of [
	"markdown",
	"sql",
	"yaml",
	"xml",
	"ini",
	"shell",
	"powershell",
	"bat",
	"javascript",
	"typescript",
	"html",
	"css",
	"scss",
	"less",
	"csharp",
	"vb",
	"razor",
	"pgsql",
	"mysql",
	"python",
	"java",
	"cpp",
	"php",
	"dockerfile",
	"graphql",
	"r",
	"perl",
	"ruby",
	"go",
	"rust",
	"fsharp",
]) {
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

const {
	catalogLineRange,
	excludeCatalogBlockMatches,
	renameProseTagInMarkdown,
} = await import("../src/view/projectDocs");
const { applyCombinedLinkMends, findOpenTaskOffset } = await import("../src/view/panels/Health");

const readSrc = (rel: string) => readFileSync(join(import.meta.dir, rel), "utf8").replace(/\r\n/g, "\n");

describe("Round 7B P1-18 — renameProseTagInMarkdown", () => {
	test("renames prose #auth while preserving Markdown anchor links, HTML attributes, wikilinks, inline code, and headings", () => {
		const input = [
			"---",
			"title: Auth Spec",
			"tags: [auth]",
			"---",
			"",
			"# #auth Overview",
			"",
			"Track #auth changes, (#auth), and \"#auth\" here. Multiple: #auth #Auth.",
			"See [See section](#auth) and [Spec](../specs/login.md#auth) for details.",
			'Jump via <a href="#auth">anchor</a> or <div data-ref="foo #auth bar">box</div>.',
			'Bare attribute href="#auth" and data="prefix #auth suffix" stay intact.',
			"Skip inline `#auth`, ``nested `#auth` code``, [[Spec#auth]], and https://example.test/x#auth.",
			"Do not rename partial #auth-v2, #auth/login, or #authentication.",
			"[ref]: #auth",
			"<!-- inline comment #auth -->",
			"<!--",
			"multi-line comment #auth",
			"-->",
			"Final prose #auth!",
		].join("\n");

		const out = renameProseTagInMarkdown(input, "auth", "identity");

		// Frontmatter untouched (YAML is updated by replaceInFrontMatterList)
		expect(out).toContain("tags: [auth]");
		// ATX heading untouched
		expect(out).toContain("# #auth Overview");
		// Prose occurrences renamed
		expect(out).toContain('Track #identity changes, (#identity), and "#identity" here. Multiple: #identity #identity.');
		expect(out).toContain("Final prose #identity!");
		// Markdown link anchors preserved
		expect(out).toContain("[See section](#auth)");
		expect(out).toContain("[Spec](../specs/login.md#auth)");
		// HTML tags & attributes preserved
		expect(out).toContain('<a href="#auth">anchor</a>');
		expect(out).toContain('<div data-ref="foo #auth bar">box</div>');
		expect(out).toContain('Bare attribute href="#auth" and data="prefix #auth suffix" stay intact.');
		// Inline code, wikilinks, URLs, reference defs, comments, partial tags preserved
		expect(out).toContain("`#auth`");
		expect(out).toContain("``nested `#auth` code``");
		expect(out).toContain("[[Spec#auth]]");
		expect(out).toContain("https://example.test/x#auth");
		expect(out).toContain("#auth-v2, #auth/login, or #authentication");
		expect(out).toContain("[ref]: #auth");
		expect(out).toContain("<!-- inline comment #auth -->");
		expect(out).toContain("multi-line comment #auth");
	});

	test("skips 4-backtick fences containing ```ts and requires whitespace-only after closing fences", () => {
		const input = [
			"Before #auth.",
			"````md",
			"```ts",
			"// #auth inside nested 3-backtick fence",
			"```",
			"````ts",
			"#auth still inside 4-backtick fence because ````ts has info string",
			"````",
			"After #auth.",
			"~~~sql",
			"-- #auth inside tilde fence",
			"~~~notclosing",
			"-- #auth still inside tilde fence",
			"~~~   ",
			"End #auth.",
		].join("\r\n");

		const out = renameProseTagInMarkdown(input, "#auth", "security");

		expect(out).toContain("Before #security.\r\n");
		expect(out).toContain("// #auth inside nested 3-backtick fence\r\n");
		expect(out).toContain("#auth still inside 4-backtick fence because ````ts has info string\r\n");
		expect(out).toContain("After #security.\r\n");
		expect(out).toContain("-- #auth inside tilde fence\r\n");
		expect(out).toContain("-- #auth still inside tilde fence\r\n");
		expect(out).toContain("End #security.");
	});
});

describe("Round 7B P2-19 & P2-23 — Health.tsx pure helpers", () => {
	test("findOpenTaskOffset matches exact (offset, text), falls back to (line, text) on offset shift, and refuses stale mismatches", () => {
		const md = [
			"# Ticket LIMS-1",
			"",
			"- [ ] Check barcode",
			"- [ ] Verify turnaround",
			"- [x] Already done",
			"",
		].join("\n");

		const offset1 = md.indexOf("Check barcode") - 3;
		const offset2 = md.indexOf("Verify turnaround") - 3;
		expect(md[offset1]).toBe(" ");
		expect(md[offset2]).toBe(" ");

		// Exact (offset, text) match
		expect(findOpenTaskOffset(md, { offset: offset1, line: 3, text: "Check barcode" })).toBe(offset1);

		// Earlier heading grew by 6 chars -> offset shifted, line stayed 3 -> (line, text) fallback locates new offset
		const editedHeading = md.replace("# Ticket LIMS-1", "# Ticket LIMS-1 (QA)");
		const shiftedOffset1 = editedHeading.indexOf("Check barcode") - 3;
		expect(shiftedOffset1).not.toBe(offset1);
		expect(findOpenTaskOffset(editedHeading, { offset: offset1, line: 3, text: "Check barcode" })).toBe(shiftedOffset1);

		// Stale offset now lands on a DIFFERENT task's `[ ]` -> refuses to corrupt the wrong task!
		expect(findOpenTaskOffset(md, { offset: offset2, line: 4, text: "Check barcode" })).toBe(-1);

		// Stale offset pointing to `[ ]` inside prose or a fenced block -> returns -1
		const codeBlockDoc = "# Title\n\n```md\n- [ ] Check barcode\n```\n";
		const fakeOffset = codeBlockDoc.indexOf("[ ]") + 1;
		expect(findOpenTaskOffset(codeBlockDoc, { offset: fakeOffset, line: 4, text: "Check barcode" })).toBe(-1);

		// Already-done task -> returns -1
		const doneOffset = md.indexOf("Already done") - 3;
		expect(findOpenTaskOffset(md, { offset: doneOffset, line: 5, text: "Already done" })).toBe(-1);
	});

	test("applyCombinedLinkMends rewrites path links and wikilinks on the same line in reverse column order without column drift", () => {
		const line3 = "See [Old Spec](../old.md#sec) and [[OldNote#Top|Alias]] and [Ref](a.md).";
		const doc = `# Notes\n\n${line3}\n`;

		const pathCol1 = line3.indexOf("../old.md#sec");
		const wikiCol = line3.indexOf("OldNote");
		const pathCol2 = line3.indexOf("a.md");

		const res = applyCombinedLinkMends(doc, [
			{ kind: "path", edit: { line: 3, column: pathCol1, href: "../old.md#sec", instead: "../specs/very-long-renamed-spec.md" } },
			{ kind: "wiki", edit: { line: 3, column: wikiCol, name: "OldNote", href: "[[OldNote]]", instead: "RenamedLongerNote" } },
			{ kind: "path", edit: { line: 3, column: pathCol2, href: "a.md", instead: "dir/renamed-ref.md" } },
			// Duplicate entry should be safely deduplicated
			{ kind: "wiki", edit: { line: 3, column: wikiCol, name: "OldNote", href: "[[OldNote]]", instead: "RenamedLongerNote" } },
		]);

		expect(res.done).toBe(3);
		expect(res.text).toBe(
			"# Notes\n\nSee [Old Spec](../specs/very-long-renamed-spec.md#sec) and [[RenamedLongerNote#Top|Alias]] and [Ref](dir/renamed-ref.md).\n",
		);
	});
});

describe("Round 7B P1-10 — ADR 0031 catalog-block exclusion for followNames", () => {
	test("excludes wikilinks inside <!-- catalog --> ... <!-- /catalog --> in INDEX.md while preserving outside matches and non-catalog docs", () => {
		const indexText = [
			"# Tickets",
			"",
			"Pinned note: [[OldName]]", // line 3 (outside catalog -> KEEP)
			"",
			"<!-- catalog -->", // line 5
			"",
			"- [Old](Old.md): mentions [[OldName]]", // line 7 (inside catalog -> DROP)
			"",
			"<!-- /catalog -->", // line 9
			"",
			"Footer reference: [[OldName]]", // line 11 (outside catalog -> KEEP)
		].join("\n");

		const range = catalogLineRange(indexText);
		expect(range).toEqual({ from: 5, to: 9 });

		const otherDocText = [
			"# Regular Doc",
			"<!-- catalog -->",
			"See [[OldName]]",
			"<!-- /catalog -->",
		].join("\n");

		const textByPath = new Map<string, string>([
			["/ws/docs/tickets/INDEX.md", indexText],
			["/ws/docs/notes.md", otherDocText],
		]);

		const places = [
			{ path: "/ws/docs/tickets/INDEX.md", line: 3, column: 15, name: "OldName" },
			{ path: "/ws/docs/tickets/INDEX.md", line: 7, column: 28, name: "OldName" },
			{ path: "/ws/docs/tickets/INDEX.md", line: 11, column: 20, name: "OldName" },
			{ path: "/ws/docs/notes.md", line: 3, column: 6, name: "OldName" },
		];

		const kept = excludeCatalogBlockMatches(places, textByPath);
		expect(kept.map((p) => `${p.path}:${p.line}`)).toEqual([
			"/ws/docs/tickets/INDEX.md:3",
			"/ws/docs/tickets/INDEX.md:11",
			"/ws/docs/notes.md:3",
		]);
	});
});

describe("Round 7B P0-4 — YAML scalar round-trip without double-quoting", () => {
	test("withFrontMatter quotes special YAML characters once so values with :, ', #, , round-trip cleanly", () => {
		const base = "---\ntitle: Spec\nstatus: draft\n---\n\n# Spec\n";
		const specialStatus = "review: QA's #1, pass";
		const specialRelease = "R2026:12 #rc1, 'hotfix'";
		const specialCc = "CC:2026 #42, 'urgent'";

		let next = withFrontMatter(base, "status", specialStatus)!;
		next = withFrontMatter(next, "release", specialRelease)!;
		next = withFrontMatter(next, "change-control", specialCc)!;

		const parsed = frontMatter(next).values;
		expect(one(parsed.status)).toBe(specialStatus);
		expect(one(parsed.release)).toBe(specialRelease);
		expect(one(parsed["change-control"])).toBe(specialCc);
		// Ensure values were NOT double-quoted with escaped outer quotes like `"\"...\""`
		expect(next).not.toContain('\\"');
	});
});

describe("Round 7B source invariants across Docs.tsx, Health.tsx, project.ts, docAudit.ts, and projectDocs.ts", () => {
	test("Docs.tsx enforces P0-4, P1-11, P1-12, P1-16, and P2-24", () => {
		const src = readSrc("../src/view/panels/Docs.tsx");

		// P0-4: no frontValue import or wrapper inside withFrontMatter
		expect(src).not.toContain("frontValue");

		// P1-11: editDocFrontMatter checks binary/disposed & save() return value; selection pruned against visibleSelectablePaths / shown()
		expect(src).toContain("!open.binary && !open.model.isDisposed()");
		expect(src).toContain("await save(key, { format: false })");
		expect(src).toContain("const valid = new Set(visibleSelectablePaths())");
		expect(src).toContain("return shown().filter((d) => sel.has(d.path) && isBulkSelectable(d))");

		// P1-12: archiveSpecOrDecision renames first and updates status on moved path without setStatus wizard
		const archStart = src.indexOf("async function archiveSpecOrDecision");
		const archEnd = src.indexOf("async function archiveAllDoneTickets");
		const archFn = src.slice(archStart, archEnd);
		expect(archFn).not.toContain("setStatus(");
		expect(archFn.indexOf("backend.rename(file.path, dest)")).toBeLessThan(archFn.indexOf("editDocFrontMatter(dest"));

		// P1-16: prevRoot resets truncated and selectedPaths on workspace switch
		expect(src).toContain("let prevRoot: string | undefined");
		expect(src).toContain("root !== prevRoot");
		expect(src).toContain("setTruncated([])");

		// P2-24: archiveAllDoneTickets & bulkArchive clear activeTicket, record archived++ before followRename, and guard followRename
		const doneStart = src.indexOf("async function archiveAllDoneTickets");
		const doneEnd = src.indexOf("async function rowMenu");
		const doneFn = src.slice(doneStart, doneEnd);
		expect(doneFn).toContain("saveSetting({ activeTicket: null }");
		expect(doneFn.indexOf("archived++")).toBeLessThan(doneFn.indexOf("followRename("));

		const bulkStart = src.indexOf("const bulkArchive = async () =>");
		const bulkEnd = src.indexOf("const focusedTicketPaths =");
		const bulkFn = src.slice(bulkStart, bulkEnd);
		expect(bulkFn).toContain("saveSetting({ activeTicket: null }");
		expect(bulkFn.indexOf("archived++")).toBeLessThan(bulkFn.indexOf("followRename("));
	});

	test("Health.tsx enforces P1-11, P2-19, P2-20, P2-22, and P2-23", () => {
		const src = readSrc("../src/view/panels/Health.tsx");

		// P1-11: writeDocEdit checks binary/disposed and save() return value
		expect(src).toContain("!open.binary && !open.model.isDisposed()");
		expect(src).toContain("!(await save(key, { format: false }))");

		// P2-19: tickOpenTask uses findOpenTaskOffset instead of blind offset flip
		expect(src).toContain("const offset = findOpenTaskOffset(cur, task)");

		// P2-20: refreshExcerptIssue re-reads buffers after confirmation modal
		const refStart = src.indexOf("const refreshExcerptIssue = async");
		const refEnd = src.indexOf("const reanchorAll = async");
		const refFn = src.slice(refStart, refEnd);
		expect(refFn.indexOf("await choose(")).toBeLessThan(refFn.indexOf("const [freshDoc, freshTarget] = await Promise.all"));

		// P2-22: trashOrphanAttachment & trashAllOrphans call fileRemoved
		const trashStart = src.indexOf("const trashOrphanAttachment = async");
		const trashEnd = src.indexOf("const mendWikiLinks = async");
		const trashFn = src.slice(trashStart, trashEnd);
		expect((trashFn.match(/fileRemoved\(/g) ?? []).length).toBeGreaterThanOrEqual(2);

		// P2-23: mendAllBrokenLinks groups by canonical(check.path), shows byPath.size, and uses applyCombinedLinkMends
		const mendStart = src.indexOf("const mendAllBrokenLinks = async");
		const mendEnd = src.indexOf("const syncSchemaFromSql = async");
		const mendFn = src.slice(mendStart, mendEnd);
		expect(mendFn).toContain("byPath.size");
		expect(mendFn).toContain("applyCombinedLinkMends(");
	});

	test("project.ts and docAudit.ts enforce P1-16 and P2-26", () => {
		const projSrc = readSrc("../src/view/project.ts");
		expect(projSrc).toContain("let prevRoot: string | undefined");
		expect(projSrc).toContain("root !== prevRoot");
		expect(projSrc).toContain("onCleanup(");
		// P2-26: startRoot guard in setUpProject, newDocIn, and newFolderIn
		expect((projSrc.match(/const startRoot = state\.workspace\.root/g) ?? []).length).toBe(3);

		const auditSrc = readSrc("../src/view/docAudit.ts");
		expect(auditSrc).toContain("let prevRoot: string | undefined");
		expect(auditSrc).toContain("root !== prevRoot");
		expect(auditSrc).toContain("onCleanup(() => {\n\t\tseq++;");
	});

	test("projectDocs.ts enforces P0-5, P1-9..P1-18, P2-20, and P2-26", () => {
		const src = readSrc("../src/view/projectDocs.ts");

		// P0-5: importLegacyDoc passes res.sourcePath ?? sourcePath on conflict retry
		expect(src).toContain("sourcePath: res.sourcePath ?? sourcePath");

		// P1-9: renameTicket confirms refactoring edits via choose() and updates activeTicket right after rename
		const renStart = src.indexOf("export async function renameTicket");
		const renEnd = src.indexOf("export async function archiveTicket");
		const renFn = src.slice(renStart, renEnd);
		expect(renFn.indexOf("saveSetting({ activeTicket: newKey }")).toBeLessThan(renFn.indexOf("followRename("));
		expect(renFn).toContain("await choose(");

		// P1-10: followRename passes allPairs to followNames and followNames calls withoutCatalogLists
		expect(src).toContain("await followNames(allPairs, listed)");
		const fnStart = src.indexOf("async function followNames(");
		const fnEnd = src.indexOf("export async function newState(");
		expect(src.slice(fnStart, fnEnd)).toContain("withoutCatalogLists(places)");

		// P1-12: archiveTicket & unarchiveTicket rename before updating status on movedTicketPath
		const arcStart = src.indexOf("export async function archiveTicket");
		const arcEnd = src.indexOf("export function isArchivedTicket");
		const arcFn = src.slice(arcStart, arcEnd);
		expect(arcFn.indexOf("backend.rename(fromPrimary, toPrimary)")).toBeLessThan(arcFn.indexOf('setStatus(movedTicketPath, "done")'));

		const unarcStart = src.indexOf("export async function unarchiveTicket");
		const unarcEnd = src.indexOf("export async function promoteToKnowledge");
		const unarcFn = src.slice(unarcStart, unarcEnd);
		expect(unarcFn.indexOf("backend.rename(fromPrimary, toPrimary)")).toBeLessThan(unarcFn.indexOf('setStatus(movedTicketPath, "in progress")'));

		// P1-13: generateSqlFromSchemaDoc danger confirm, isInside check, backend.create, and post-choose re-read
		const sqlStart = src.indexOf("export async function generateSqlFromSchemaDoc");
		const sqlEnd = src.indexOf("export async function unlinkSchemaDocSql");
		const sqlFn = src.slice(sqlStart, sqlEnd);
		expect(sqlFn).toContain("{ danger: OVERWRITE }");
		expect(sqlFn).toContain("isInside(startRoot,");
		expect(sqlFn).toContain('await backend.create(dest, "file")');
		expect(sqlFn.indexOf("await choose(")).toBeLessThan(sqlFn.indexOf("const freshMd = await current(mdPath)"));

		// P1-14: syncImportedBuffer uses changingOnDisk + revert; saveExportFile computes payload before create and reverts open buffers
		const syncStart = src.indexOf("async function syncImportedBuffer");
		const syncEnd = src.indexOf("async function promptImportConflict");
		const syncFn = src.slice(syncStart, syncEnd);
		expect(syncFn).toContain("changingOnDisk(");
		expect(syncFn).toContain("revert(");

		const expStart = src.indexOf("async function saveExportFile");
		const expEnd = src.indexOf("async function rasterizeVectorAndWebpImagesForDocx");
		const expFn = src.slice(expStart, expEnd);
		expect(expFn.indexOf("const payload =")).toBeLessThan(expFn.indexOf('backend.create(dest, "file")'));
		expect(expFn).toContain("changingOnDisk(dest");
		expect(expFn).toContain("await revert(openKey)");

		// P1-15: importTickets guards startRoot and re-reads current(dest) after choose()
		const impStart = src.indexOf("export async function importTickets");
		const impEnd = src.indexOf("export async function newSpec");
		const impFn = src.slice(impStart, impEnd);
		expect(impFn).toContain("const startRoot = root()");
		expect(impFn.indexOf("const destPath =")).toBeLessThan(impFn.indexOf("const was = await current(dest)"));

		// P1-17: closeoutTicket checks fresh backend.docs() for catalog staleness and isolates STATE/README errors
		const clsStart = src.indexOf("export async function closeoutTicket");
		const clsEnd = src.indexOf("function protectedProseRanges");
		const clsFn = src.slice(clsStart, clsEnd);
		expect(clsFn).toContain("const freshDocs = await backend.docs()");
		expect(clsFn).toContain("staleCatalogSummary(freshDocs)");

		// P2-20 / P2-26: onboardBrownfieldWorkspace previews setupPreview() & trashTicket guards primaryTrashed
		const onbStart = src.indexOf("export async function onboardBrownfieldWorkspace");
		const onbEnd = src.indexOf("function computeVersionBump");
		expect(src.slice(onbStart, onbEnd)).toContain("backend.setupPreview()");

		const trStart = src.indexOf("export async function trashTicket");
		const trEnd = src.indexOf("export async function renameTicket");
		const trFn = src.slice(trStart, trEnd);
		expect(trFn).toContain("let primaryTrashed = false");
		expect(trFn).toContain("if (primaryTrashed)");
	});
});
