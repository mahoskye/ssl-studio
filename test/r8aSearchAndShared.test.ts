import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createBackend, type Host } from "../src/bun/backend";
import { WorkspaceFiles } from "../src/bun/workspace";
import { createFileFilter, fileChosen, globMatcher } from "../src/shared/fileGlob";
import { mergeManifest } from "../src/shared/manifest";
import { overlapsProtectedSpan, protectedMarkdownSpans, replaceSafeInText } from "../src/shared/menuBar";
import {
	canDropSection,
	createdObjects,
	markdownSectionTree,
	maxSectionLevel,
	moveMarkdownSection,
	moveMarkdownSectionTo,
	outline,
	planStageOutline,
} from "../src/shared/outline";
import { dirName, isInside, relativePath, relativeTo } from "../src/shared/paths";
import { excerptForMatch, SEARCH_LINE_WINDOW, searchPattern } from "../src/shared/searchPattern";
import { byLine, markedColumns, parseDocFilterTokens, resolveSearchQuery, segments, stripTokenSpans } from "../src/view/panels/searchLines";

const tmpRoot = mkdtempSync(join(tmpdir(), "ssl-studio-r8a-"));
afterAll(() => rmSync(tmpRoot, { recursive: true, force: true }));

describe("R8A Defect 1 — fileGlob ReDoS, nested braces, leading slashes & workspace path allowlist", () => {
	test("collapses consecutive stars and repeated **/ runs without exponential backtracking", () => {
		const evilGlob = `${"**/".repeat(30)}target.ssl`;
		const matcher = globMatcher(evilGlob);
		const deepPath = `${"a/".repeat(40)}miss.ssl`;
		const t0 = performance.now();
		expect(matcher(deepPath)).toBe(false);
		expect(matcher(`${"a/".repeat(40)}target.ssl`)).toBe(true);
		expect(performance.now() - t0).toBeLessThan(200);

		const stars = globMatcher(`${"*".repeat(40)}needle`);
		const t1 = performance.now();
		expect(stars(`${"x".repeat(80)}miss`)).toBe(false);
		expect(stars(`${"x".repeat(80)}needle`)).toBe(true);
		expect(performance.now() - t1).toBeLessThan(200);
	});

	test("parses nested braces with balanced depth", () => {
		const nested = globMatcher("docs/{specs,{tickets,plans}}/*.md");
		expect(nested("docs/specs/a.md")).toBe(true);
		expect(nested("docs/tickets/b.md")).toBe(true);
		expect(nested("docs/plans/c.md")).toBe(true);
		expect(nested("docs/knowledge/d.md")).toBe(false);

		const ext = globMatcher("*.{ssl,{ds,sql}}");
		expect(ext("src/a.ssl")).toBe(true);
		expect(ext("src/a.ds")).toBe(true);
		expect(ext("src/a.sql")).toBe(true);
		expect(ext("src/a.md")).toBe(false);

		// Unbalanced opening brace is escaped as literal `{` without throwing.
		expect(globMatcher("foo{bar")("src/foo{bar")).toBe(true);
	});

	test("strips multiple leading slashes on normalized patterns", () => {
		expect(globMatcher("//src")("src/a.ssl")).toBe(true);
		expect(globMatcher("//src")("other/src/a.ssl")).toBe(false);
		expect(globMatcher("///src/DueDates/")("src/DueDates/Rule.ssl")).toBe(true);
		expect(globMatcher("\\\\src\\DueDates")("src/DueDates/Rule.ssl")).toBe(true);
	});

	test("createFileFilter precompiles include/exclude once and matches fileChosen", () => {
		const filter = createFileFilter("src/{a,{b,c}}/*.ssl", "src/c/**");
		expect(filter("src/a/x.ssl")).toBe(true);
		expect(filter("src/b/x.ssl")).toBe(true);
		expect(filter("src/c/x.ssl")).toBe(false);
		expect(filter("src/b/x.md")).toBe(false);
		expect(fileChosen("src/b/x.ssl", "src/{a,{b,c}}/*.ssl", "src/c/**")).toBe(true);
		expect(fileChosen("src/c/x.ssl", "src/{a,{b,c}}/*.ssl", "src/c/**")).toBe(false);
	});

	test("workspace.search supports exact paths allowlist including commas and braces in filenames", async () => {
		const wsDir = join(tmpRoot, "allowlist-ws");
		mkdirSync(join(wsDir, "docs"), { recursive: true });
		writeFileSync(join(wsDir, "docs", "report,q1.md"), "NEEDLE in comma file\n");
		writeFileSync(join(wsDir, "docs", "item{a,b}.md"), "NEEDLE in brace file\n");
		writeFileSync(join(wsDir, "docs", "other.md"), "NEEDLE in other file\n");

		const ws = new WorkspaceFiles(wsDir);
		const hits = await ws.search("NEEDLE", { paths: ["docs/report,q1.md", "docs/item{a,b}.md"] });
		const rels = hits.map((h) => relativeTo(wsDir, h.path)).sort();
		expect(rels).toEqual(["docs/item{a,b}.md", "docs/report,q1.md"]);

		// Empty allowlist returns zero hits.
		expect(await ws.search("NEEDLE", { paths: [] })).toEqual([]);
	});

	test("workspace.search enforces safety time budget and skips huge lines in regex mode", async () => {
		const wsDir = join(tmpRoot, "budget-ws");
		mkdirSync(wsDir, { recursive: true });
		// Huge single-line minified file (> 20k chars) + normal file
		writeFileSync(join(wsDir, "minified.js"), `${"a".repeat(30_000)}NEEDLE`);
		writeFileSync(join(wsDir, "normal.txt"), "NEEDLE here\n");
		// Slow catastrophic lines for budget test
		writeFileSync(join(wsDir, "slow.txt"), `${`${"a".repeat(25)}!\n`.repeat(120)}NEEDLE`);

		const ws = new WorkspaceFiles(wsDir);
		// Regex mode skips >20k single line cleanly and still finds normal line.
		const regexHits = await ws.search("NEEDLE", { regex: true, paths: ["minified.js", "normal.txt"] });
		expect(regexHits.map((h) => relativeTo(wsDir, h.path))).toEqual(["normal.txt"]);

		// Literal mode still searches long lines safely.
		const litHits = await ws.search("NEEDLE", { paths: ["minified.js"] });
		expect(litHits).toHaveLength(1);
		expect(litHits[0]!.column).toBe(30_001);

		// Safety time budget stops catastrophic regex promptly.
		const origTimeout = WorkspaceFiles.searchTimeoutMs;
		WorkspaceFiles.searchTimeoutMs = 80;
		try {
			const t0 = performance.now();
			await ws.search("(a+)+$", { regex: true, paths: ["slow.txt"] });
			expect(performance.now() - t0).toBeLessThan(1000);
		} finally {
			WorkspaceFiles.searchTimeoutMs = origTimeout;
		}
	});
});

describe("R8A Defect 2 — Search truncation windowing and textOffset rendering", () => {
	test("excerptForMatch windows long lines around matches near or beyond 400 chars", () => {
		const shortLine = "short NEEDLE line";
		expect(excerptForMatch(shortLine, 7, 6)).toEqual({ text: shortLine, textOffset: 0 });

		const midLine = `${"a".repeat(600)}NEEDLE${"b".repeat(500)}`;
		const midWin = excerptForMatch(midLine, 601, 6);
		expect(midWin.text.length).toBe(SEARCH_LINE_WINDOW);
		expect(midWin.textOffset).toBe(500);
		expect(midWin.text.slice(601 - 1 - midWin.textOffset, 601 - 1 - midWin.textOffset + 6)).toBe("NEEDLE");

		// Near end of line: clamps offset to `line.length - maxLen` so a full 400-char window is preserved.
		const tailLine = `${"a".repeat(600)}NEEDLE${"b".repeat(200)}`;
		const tailWin = excerptForMatch(tailLine, 601, 6);
		expect(tailWin.text.length).toBe(SEARCH_LINE_WINDOW);
		expect(tailWin.textOffset).toBe(406);
		expect(tailWin.text.slice(601 - 1 - tailWin.textOffset, 601 - 1 - tailWin.textOffset + 6)).toBe("NEEDLE");
	});

	test("workspace.search windows matches beyond column 400 and searchLines renders marked segments", async () => {
		const wsDir = join(tmpRoot, "window-ws");
		mkdirSync(wsDir, { recursive: true });
		const longLine = `${"p".repeat(520)}TARGET_TOKEN${"q".repeat(150)}`;
		writeFileSync(join(wsDir, "long.txt"), `${longLine}\n`);

		const ws = new WorkspaceFiles(wsDir);
		const hits = await ws.search("TARGET_TOKEN", {});
		expect(hits).toHaveLength(1);
		const hit = hits[0]!;
		expect(hit.column).toBe(521);
		expect(hit.text.length).toBe(SEARCH_LINE_WINDOW);
		expect(hit.textOffset).toBeGreaterThan(0);

		const [lineHit] = byLine(hits);
		expect(lineHit!.textOffset).toBe(hit.textOffset);
		const parts = segments(lineHit!, 12, 20);
		expect(parts[0]!.text.startsWith("…")).toBe(true);
		expect(parts.filter((p) => p.match).map((p) => p.text)).toEqual(["TARGET_TOKEN"]);
		expect(markedColumns(lineHit!)).toEqual([521]);
	});

	test("searchLines handles multiple matches on one long line without breaking markedColumns alignment", () => {
		const full = `${"x".repeat(10)}ONE${"y".repeat(500)}TWO${"z".repeat(20)}`;
		const h1 = excerptForMatch(full, 11, 3);
		const h2 = excerptForMatch(full, 514, 3);
		const [lineHit] = byLine([
			{ path: "a.txt", line: 1, column: 11, length: 3, text: h1.text, ...(h1.textOffset ? { textOffset: h1.textOffset } : {}) },
			{ path: "a.txt", line: 1, column: 514, length: 3, text: h2.text, ...(h2.textOffset ? { textOffset: h2.textOffset } : {}) },
		]);
		const parts = segments(lineHit!, 12, 20);
		const marked = parts.filter((p) => p.match);
		expect(marked.map((p) => p.text)).toEqual(["ONE"]);
		expect(markedColumns(lineHit!)).toEqual([11]);
		expect(marked.length).toBe(markedColumns(lineHit!).length);
	});
});

describe("R8A Defect 3 — Doc filter token parsing, Code scope isolation & synthetic regex guard", () => {
	test("parseDocFilterTokens never mutates raw whitespace or scrambles unmatched key:val tokens", () => {
		expect(parseDocFilterTokens("   ").text).toBe("   ");
		expect(parseDocFilterTokens("foo  bar ").text).toBe("foo  bar ");
		const untouched = parseDocFilterTokens("foo unknown:val bar");
		expect(untouched.text).toBe("foo unknown:val bar");
		expect(untouched.consumedSpans).toEqual([]);

		// Consuming a recognized filter leaves unmatched `unknown:val` in its original position.
		const mixed = parseDocFilterTokens("foo unknown:val status:open bar");
		expect(mixed.statuses).toEqual(["open"]);
		expect(mixed.text).toBe("foo unknown:val bar");
		expect(stripTokenSpans("foo  bar", [])).toBe("foo  bar");
	});

	test("resolveSearchQuery disables doc filter hijacking in Code scope", () => {
		const codeRes = resolveSearchQuery({
			rawQuery: 'status:"Active" tag:due',
			regex: false,
			caseSensitive: false,
			wholeWord: false,
			scope: "code",
		});
		expect(codeRes.effectiveQuery).toBe('status:"Active" tag:due');
		expect(codeRes.effectiveRegex).toBe(false);
		expect(codeRes.syntheticQuery).toBe(false);
		expect(codeRes.parsed.statuses).toEqual([]);
		expect(codeRes.parsed.tags).toEqual([]);
		expect(codeRes.hasDocMetaFilters).toBe(false);
	});

	test("whitespace-only queries stay literal and never promote to synthetic regex mode", () => {
		const wsRes = resolveSearchQuery({
			rawQuery: "   ",
			regex: false,
			caseSensitive: false,
			wholeWord: false,
			scope: "all",
		});
		expect(wsRes.effectiveQuery).toBe("   ");
		expect(wsRes.effectiveRegex).toBe(false);
		expect(wsRes.syntheticQuery).toBe(false);
	});

	test("filter-only doc queries flag syntheticQuery: true while filter+text queries keep literal replace mode", () => {
		const filterOnly = resolveSearchQuery({
			rawQuery: "status:open",
			regex: false,
			caseSensitive: false,
			wholeWord: false,
			scope: "docs",
		});
		expect(filterOnly.syntheticQuery).toBe(true);
		expect(filterOnly.effectiveRegex).toBe(true);
		expect(filterOnly.hasDocMetaFilters).toBe(true);

		const filterAndText = resolveSearchQuery({
			rawQuery: "status:open DueDate",
			regex: false,
			caseSensitive: false,
			wholeWord: false,
			scope: "docs",
		});
		expect(filterAndText.syntheticQuery).toBe(false);
		expect(filterAndText.effectiveRegex).toBe(false);
		expect(filterAndText.effectiveQuery).toBe("DueDate");
		expect(filterAndText.parsed.statuses).toEqual(["open"]);
	});
});

describe("R8A Defect 4 — Safe-Docs zero-length $, locked backend replace, and Search.tsx invariants", () => {
	test("overlapsProtectedSpan blocks zero-length regex $ on YAML frontmatter --- delimiters and bare keys", () => {
		expect(overlapsProtectedSpan(4, 0, [{ start: 0, end: 3 }])).toBe(true);
		expect(overlapsProtectedSpan(1, 0, [{ start: 0, end: 3 }])).toBe(true);
		expect(overlapsProtectedSpan(8, 0, [{ start: 0, end: 7 }])).toBe(true);
		expect(overlapsProtectedSpan(14, 0, [{ start: 0, end: 7 }])).toBe(false);

		const md = ["---", "status: draft", "tags:", "  - qa", "---", "", "Body line"].join("\n");
		const spans = protectedMarkdownSpans(md);
		expect(spans.get(1)).toEqual([{ start: 0, end: 3 }]);
		expect(spans.get(5)).toEqual([{ start: 0, end: 3 }]);

		const endRe = searchPattern("$", { regex: true });
		const res = replaceSafeInText(md, endRe, "!", true, { isMarkdown: true, safeDocs: true });
		const outLines = res.text.split("\n");
		// Frontmatter delimiters and bare `tags:` key line are never corrupted by `$`!
		expect(outLines[0]).toBe("---");
		expect(outLines[2]).toBe("tags:");
		expect(outLines[4]).toBe("---");
		// Value lines and body lines still update normally.
		expect(outLines[1]).toBe("status: draft!");
		expect(outLines[6]).toBe("Body line!");
	});

	test("workspace.replaced and backend.replace enforce safeDocs, linesByPath, binary guard, and local history", async () => {
		const wsDir = join(tmpRoot, "replace-locked-ws");
		mkdirSync(wsDir, { recursive: true });
		const mdPath = join(wsDir, "doc.md");
		const planPath = join(wsDir, "flow.plan.json");
		const sslPath = join(wsDir, "code.ssl");
		const binPath = join(wsDir, "data.bin");

		const origMd = [
			"---",
			"status: draft",
			"---",
			"",
			"Line 5 status with [status](docs/status.md)",
			"Line 6 status skipped",
			"",
		].join("\n");
		const origPlan = '{\n  "version": 1,\n  "title": "Due Dates",\n  "groups": [],\n  "nodes": [],\n  "edges": []\n}\n';
		const origSsl = "a := 1;\na := 2;\na := 3;\n";
		const origBin = Buffer.from([0x61, 0x00, 0x62, 0x63]);

		writeFileSync(mdPath, origMd);
		writeFileSync(planPath, origPlan);
		writeFileSync(sslPath, origSsl);
		writeFileSync(binPath, origBin);

		const host: Host = {
			app: "test",
			kind: "browser",
			pick: async () => null,
			trash: async () => {},
			emit: () => {},
			quit: () => {},
		};
		const backend = createBackend(host, wsDir);
		try {
			await backend.ready;

			// 1. Safe Docs + partial linesByPath via locked backend.replace
			const mdResults = (await backend.api.replace(
				"status",
				"state",
				{ safeDocs: true, linesByPath: { [mdPath]: [2, 5] } },
				[mdPath],
			)) as { path: string; count: number; skippedProtected?: number; invalidJson?: boolean }[];
			expect(mdResults).toHaveLength(1);
			expect(mdResults[0]!.count).toBe(2); // line 5 prose `status` and `[status]`
			expect(mdResults[0]!.skippedProtected).toBe(2); // line 2 `status:` and line 5 `(docs/status.md)`
			const nextMd = readFileSync(mdPath, "utf8");
			expect(nextMd).toContain("status: draft");
			expect(nextMd).toContain("Line 5 state with [state](docs/status.md)");
			expect(nextMd).toContain("Line 6 status skipped"); // not in linesByPath!
			// Local history kept snapshots before & after
			const hist = await backend.api.history(mdPath);
			expect(hist.length).toBeGreaterThanOrEqual(2);

			// 2. Safe Docs blocks invalid .plan.json edit without writing disk
			const planResults = (await backend.api.replace(
				"Due Dates",
				'Bad "Quote',
				{ safeDocs: true },
				[planPath],
			)) as { path: string; count: number; invalidJson?: boolean }[];
			expect(planResults).toHaveLength(1);
			expect(planResults[0]!.invalidJson).toBe(true);
			expect(planResults[0]!.count).toBe(0);
			expect(readFileSync(planPath, "utf8")).toBe(origPlan);

			// 3. Partial-line replacement on SSL file using relative path key in linesByPath
			const sslResults = await backend.api.replace("a :=", "b :=", { linesByPath: { "code.ssl": [2] } }, [sslPath]);
			expect(sslResults).toEqual([{ path: sslPath, count: 1 }]);
			expect(readFileSync(sslPath, "utf8")).toBe("a := 1;\nb := 2;\na := 3;\n");

			// 4. Binary file is never modified
			const binResults = await backend.api.replace("a", "z", { safeDocs: true }, [binPath]);
			expect(binResults).toEqual([]);
			expect(Buffer.from(readFileSync(binPath)).equals(origBin)).toBe(true);
		} finally {
			backend.dispose();
		}
	});

	test("Search.tsx enforces scratchSymbols, locked backend.replace, doc-level spans, and form guards", () => {
		const src = readFileSync(join(import.meta.dir, "..", "src", "view", "panels", "Search.tsx"), "utf8");
		expect(src).not.toContain("session.ensureModel(");
		expect(src).toContain("session.scratchSymbols(");
		expect(src).not.toContain("backend.write(path, res.text, true)");
		expect(src).not.toContain("protectedMarkdownSpans(line.text).get(1)");
		expect(src).toContain("onCleanup(() => placesSeq++)");
		expect(src).toContain("syntheticQuery");
		expect(src).toContain("data-replace-input");
		expect(src).toContain('e.target.type === "checkbox"');
		expect(src).toContain("resetSearchState()");
	});
});

describe("R8A Defect 5 — paths.ts, manifest.ts, and outline.ts hardening", () => {
	test("paths.ts: relativeTo collapses .. and // while preserving suffix casing", () => {
		expect(relativeTo("/w/foo/../app", "/w/app/src/MyFile.ssl")).toBe("src/MyFile.ssl");
		expect(relativeTo("/w/app", "/w/app//src/./sub/../MyFile.ssl")).toBe("src/MyFile.ssl");
		expect(relativeTo("C:\\Work\\Sub\\..\\App", "c:/work/app//Docs/Spec.md")).toBe("Docs/Spec.md");
	});

	test("paths.ts: UNC //server/share is pinned as immutable prefix and matched consistently across slash/case styles", () => {
		expect(isInside("\\\\Server\\Share", "//server/share/Docs/Note.md")).toBe(true);
		expect(isInside("//Server/Share", "\\\\server\\share\\Docs\\Note.md")).toBe(true);
		expect(isInside("\\\\Server\\Share\\sub", "\\\\Server\\Share\\sub\\..\\..\\secret.txt")).toBe(false);
		expect(isInside("\\\\Server\\Share", "\\\\Server\\OtherShare\\a.ssl")).toBe(false);
		// `..` at UNC share root stays pinned inside `//server/share` (never escapes to `//server`).
		expect(relativeTo("\\\\Server\\Share", "//server/share/a/../../Docs/File.md")).toBe("Docs/File.md");
	});

	test("paths.ts: dirName strips trailing slashes while preserving /, C:/, and //server/share", () => {
		expect(dirName("/w/Sample/")).toBe("/w");
		expect(dirName("/w/Sample///")).toBe("/w");
		expect(dirName("/")).toBe("/");
		expect(dirName("///")).toBe("/");
		expect(dirName("C:/")).toBe("C:/");
		expect(dirName("C:\\")).toBe("C:\\");
		expect(dirName("C:/Work/")).toBe("C:/");
		expect(dirName("//server/share")).toBe("//server/share");
		expect(dirName("//server/share/")).toBe("//server/share");
		expect(dirName("//server/share/dir/")).toBe("//server/share");
		expect(dirName("\\\\server\\share\\dir\\")).toBe("\\\\server\\share");
	});

	test("paths.ts: relativePath compares Windows segments case-insensitively and returns to when drive letters differ", () => {
		expect(relativePath("C:\\Work\\Docs", "c:/work/src/Order.ssl")).toBe("../src/Order.ssl");
		expect(relativePath("C:\\Work\\Docs", "D:\\Other\\Order.ssl")).toBe("D:\\Other\\Order.ssl");
		expect(relativePath("\\\\Server\\ShareA\\docs", "\\\\Server\\ShareB\\a.ssl")).toBe("\\\\Server\\ShareB\\a.ssl");
		expect(relativePath("\\\\Server\\Share\\Docs", "//server/share/docs/Sub/A.md")).toBe("Sub/A.md");
	});

	test("manifest.ts: preserves ragged extra cells when missing standard columns are appended", () => {
		const existing = "path,status\nsrc/A.ssl,migrated,MY_EXTRA_CELL\n";
		const res = mergeManifest(existing, [{ path: "src/A.ssl", kind: "script", bytes: 42, lines: 3, sha256: "abc" }]);
		const rows = res.text.trim().split("\n");
		expect(rows[0]).toBe("path,status,kind,bytes,lines,sha256");
		expect(rows[1]).toBe("src/A.ssl,migrated,script,42,3,abc,MY_EXTRA_CELL");
	});

	test("manifest.ts: guards duplicate rows, normalizes backslashes, and preserves blank-path rows without marking gone", () => {
		const existing = [
			"path,kind,bytes,lines,sha256,status,note",
			"src\\A.ssl,script,10,1,oldsha,done,first",
			"src/A.ssl,script,10,1,oldsha,done,dup",
			",,,,,,separator",
			"",
		].join("\n");
		const res = mergeManifest(existing, [{ path: "src/A.ssl", kind: "script", bytes: 20, lines: 2, sha256: "newsha" }]);
		expect(res.changed).toBe(1);
		expect(res.same).toBe(0);
		expect(res.changedAfterDone).toEqual(["src/A.ssl"]);
		// Duplicate row becomes gone (1), blank-path row is NOT counted as gone and NOT stamped "gone"!
		expect(res.gone).toBe(1);
		const rows = res.text.trim().split("\n");
		expect(rows[1]).toBe("src/A.ssl,script,20,2,newsha,done,first");
		expect(rows[2]).toBe("src/A.ssl,script,10,1,oldsha,gone,dup");
		expect(rows[3]).toBe(",,,,,,separator");
	});

	test("outline.ts: canDropSection and moveMarkdownSectionTo reject drops where subtree would exceed H6", () => {
		const cleanDoc = [
			"# Part 1",
			"## Source",
			"### Child",
			"#### Grandchild",
			"",
			"# Part 2",
			"## B",
			"### C",
			"#### DeepTarget",
			"body",
			"",
		].join("\n");
		const cleanTree = markdownSectionTree(cleanDoc);
		const source = cleanTree[0]!.children[0]!; // H2 Source (max level 4)
		expect(maxSectionLevel(source)).toBe(4);
		const deepTarget = cleanTree[1]!.children[0]!.children[0]!.children[0]!; // H4 DeepTarget (line 9)
		// Dropping H2 Source (max 4) inside H4 DeepTarget -> desiredLevel=5, delta=+3 -> 4+3=7 > 6 -> REJECT!
		expect(canDropSection(source, deepTarget, "inside")).toBe(false);
		expect(moveMarkdownSectionTo(cleanDoc, source.line, deepTarget.line, "inside")).toEqual({
			text: cleanDoc,
			newLine: source.line,
			changed: false,
		});
		// Dropping H2 Source (max 4) after H4 DeepTarget -> desiredLevel=4, delta=+2 -> 4+2=6 <= 6 -> ALLOW!
		expect(canDropSection(source, deepTarget, "after")).toBe(true);
		const ok = moveMarkdownSectionTo(cleanDoc, source.line, deepTarget.line, "after");
		expect(ok.changed).toBe(true);
		expect(ok.text).toContain("#### Source\n##### Child\n###### Grandchild");
	});

	test("outline.ts: moveMarkdownSection swaps unequal-level siblings without swallowing deeper sibling", () => {
		const doc = [
			"# Root",
			"",
			"### A",
			"A body",
			"#### A1",
			"A1 body",
			"",
			"## B",
			"B body",
			"",
		].join("\n");
		const moved = moveMarkdownSection(doc, 3, "down");
		expect(moved).not.toBeNull();
		const tree = markdownSectionTree(moved!.text);
		// Both B and A must remain direct siblings under # Root!
		expect(tree[0]!.children.map((c) => [c.text, c.level])).toEqual([
			["B", 2],
			["A", 2],
		]);
		expect(tree[0]!.children[1]!.children.map((c) => [c.text, c.level])).toEqual([["A1", 3]]);
	});

	test("outline.ts: SQL Oracle / batch terminator works without semicolons while keeping division intact", () => {
		const oracle = [
			"CREATE TABLE DEMO_A (ID NUMBER)",
			"/",
			"CREATE VIEW DEMO_V AS SELECT ID FROM DEMO_A",
			"/",
		].join("\n");
		const items = outline("sql", oracle);
		expect(items.map((i) => [i.name, i.line, i.endLine])).toEqual([
			["CREATE TABLE DEMO_A", 1, 1],
			["CREATE VIEW DEMO_V", 3, 3],
		]);
		expect(createdObjects(oracle)).toEqual([
			{ object: "DEMO_A", kind: "table" },
			{ object: "DEMO_V", kind: "view" },
		]);
		// Division inside a statement remains a single statement.
		expect(outline("sql", "SELECT total\n/\ncount FROM DEMO_A;")).toHaveLength(1);
	});

	test("outline.ts: TOML multiline triple-quote handles escaped backslash before closing quotes", () => {
		const toml = [
			'a = """',
			'foo \\\\"""',
			"b = 1",
			'c = """',
			'still \\\\\\"""',
			"not_a_key = 2",
			'"""',
			"d = 3",
		].join("\n");
		expect(outline("toml", toml).map((i) => i.name)).toEqual(["a", "b", "c", "d"]);
	});

	test("outline.ts: JSON outline has no line drift when backslash precedes newline", () => {
		const brokenJson = '{\n  "a": "hello\\\n  "b": 1,\n  "c": 2\n}';
		const items = outline("json", brokenJson);
		expect(items.map((i) => [i.name, i.line])).toEqual([
			["a", 2],
			["b", 3],
			["c", 4],
		]);
	});

	test("outline.ts: planStageOutline tracks exact lines on tab-indented and 4-space-indented plans", () => {
		const planObj = {
			version: 1,
			title: "Tab indented plan",
			groups: [
				{ id: "g1", name: "Validate" },
				{ id: "g2", name: "Publish" },
			],
			nodes: [
				{ id: "n1", kind: "start", text: "Start", group: "g1" },
				{ id: "n2", kind: "step", text: "Process", group: "g2" },
			],
			edges: [{ from: "n1", to: "n2" }],
		};

		for (const indent of ["\t", "    "]) {
			const text = JSON.stringify(planObj, null, indent);
			const lines = text.split("\n");
			const stages = planStageOutline(text);
			expect(stages).toHaveLength(2);
			expect(stages[0]!.line).toBe(lines.findIndex((l) => l.includes('"id": "g1"')) + 1);
			expect(stages[1]!.line).toBe(lines.findIndex((l) => l.includes('"id": "g2"')) + 1);
			expect(stages[0]!.nodes[0]!.line).toBe(lines.findIndex((l) => l.includes('"id": "n1"')) + 1);
			expect(stages[1]!.nodes[0]!.line).toBe(lines.findIndex((l) => l.includes('"id": "n2"')) + 1);
		}
	});
});
