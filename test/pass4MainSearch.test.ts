// Two medium findings of the pass 4 audit in the Search panel, both there before this branch.
//
// P6. "Replace all" with a row dismissed replaced by line numbers taken when the search ran: with a line added
// above them since, the dismissed match was replaced and the ones kept were left. A replace is now held to the
// text that was searched (`textMark`): on disk by the backend, under the file's write lock, and in an open file
// by the window. The backend side runs here against a real backend on real folders.
//
// P7. An open file with unsaved changes was searched in the window, and a replace in an open file was worked out
// there, with the expression the user typed and no time limit: "(a+)+$" on thirty letters froze the window. The
// backend searches the open texts now, under its budget, and the window works out a replace from what was found.
//
// What cannot be run here is the panel itself (it needs a DOM and the real Monaco): how it calls these functions
// is held by its source text, in the last block, and said so there.
import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createBackend, type Host } from "../src/bun/backend";
import { WorkspaceFiles } from "../src/bun/workspace";
import { overlapsProtectedSpan, protectedMarkdownSpans, replaceSafeInText, type TextSpan } from "../src/shared/menuBar";
import type { SearchHit } from "../src/shared/protocol";
import {
	becomesFound,
	changedSinceSearch,
	excerptForMatch,
	matchesOn,
	openBatches,
	REGEX_MAX_LINE_LENGTH,
	replaceFound,
	replaceIn,
	replaceSearched,
	SEARCH_LIMIT,
	SEARCH_MAX_TEXT,
	searchPattern,
	textMark,
	withGroups,
	type ReplaceEdit,
	type SearchOptions,
} from "../src/shared/searchPattern";
import { searchShortfall, shortfallBlocksReplace } from "../src/view/panels/searchLines";

const base = mkdtempSync(join(tmpdir(), "ssl-studio-p4m-search-"));
afterAll(() => rmSync(base, { recursive: true, force: true }));
const fresh = (name: string) => {
	const dir = join(base, name);
	mkdirSync(dir, { recursive: true });
	return dir;
};
const host: Host = { app: "test", kind: "browser", pick: async () => null, trash: async () => {}, emit: () => {}, quit: () => {} };
const readSrc = (rel: string) => readFileSync(join(import.meta.dir, "..", rel), "utf8").replace(/\r\n/g, "\n");
const between = (text: string, from: string, to: string) => {
	const start = text.indexOf(from);
	const end = text.indexOf(to, start + from.length);
	if (start < 0 || end < 0) throw new Error(`not found: ${start < 0 ? from : to}`);
	return text.slice(start, end);
};

/** The same numbers every run. */
const rng = (seed: number) => () => {
	seed |= 0;
	seed = (seed + 0x6d2b79f5) | 0;
	let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
	t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
	return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};

/** A hit without where its groups lie: what a search gave before it was asked for them. */
const bare = (hits: readonly SearchHit[]) => hits.map(({ groups: _groups, named: _named, ...hit }) => hit);

// --- What the window did before, copied from Search.tsx as it was at 6bf5b41, to compare with ------------------

/** `scanTextBuffer`: the walk the window made over an open file's unsaved text. */
function scanTextBufferBefore(path: string, text: string, pattern: RegExp, isRegex: boolean, limit: number): SearchHit[] {
	const out: SearchHit[] = [];
	const lines = text.split(/\r?\n/);
	for (let i = 0; i < lines.length && out.length < limit; i++) {
		const line = lines[i]!;
		if (isRegex && line.length > REGEX_MAX_LINE_LENGTH) continue;
		const found = matchesOn(line, pattern, "", isRegex, limit - out.length);
		for (const m of found) {
			const { text: excerpt, textOffset } = excerptForMatch(line, m.column, m.length);
			out.push({ path, line: i + 1, column: m.column, length: m.length, text: excerpt, ...(textOffset > 0 ? { textOffset } : {}) });
			if (out.length >= limit) break;
		}
	}
	return out;
}

/** `replaceInModel`: the edits the window made in an open file, walking the text as it was at that moment. */
function editsBefore(text: string, pattern: RegExp, with_: string, regex: boolean, allowedLines?: ReadonlySet<number>, protectedSpans?: ReadonlyMap<number, TextSpan[]>): ReplaceEdit[] {
	const edits: ReplaceEdit[] = [];
	// As the editor has the lines: a line is ended by "\r\n" or "\n".
	const lines = text.split(/\r?\n/);
	for (let line = 1; line <= lines.length; line++) {
		if (allowedLines && !allowedLines.has(line)) continue;
		const content = lines[line - 1]!;
		if (regex && content.length > REGEX_MAX_LINE_LENGTH) continue;
		const spans = protectedSpans?.get(line);
		for (const match of matchesOn(content, pattern, with_, regex)) {
			if (overlapsProtectedSpan(match.column, match.length, spans)) continue;
			edits.push({ line, column: match.column, length: match.length, text: match.becomes });
		}
	}
	return edits;
}

/** A text with edits made in it, the last first, as an editor makes them: each is a place in the text as it was. */
function withEdits(text: string, edits: readonly ReplaceEdit[]): string {
	const parts = text.split(/(\r?\n)/);
	for (const edit of [...edits].sort((a, b) => b.line - a.line || b.column - a.column)) {
		const line = parts[(edit.line - 1) * 2]!;
		parts[(edit.line - 1) * 2] = line.slice(0, edit.column - 1) + edit.text + line.slice(edit.column - 1 + edit.length);
	}
	return parts.join("");
}

// --- Generated texts -------------------------------------------------------------------------------------------

const WORDS = ["sName", "sname", "SNAME", "nDue", "DueDate", "Is_Due", "sOrdNo", "GetDue", "aaa", "aab", "x", "Due", "name", "übung", "naïve", "𝒳due", "a1", "_a"];
const MARKS = [" := ", "(", ")", ";", ", ", " ", "\t", '"', ".", " + ", ":", "/* ", " */", "[", "]", "$", "\\"];

/** A text of made-up SSL-like lines: short and long ones, empty ones, both kinds of line end. */
function generated(seed: number, lines: number, options: { long?: boolean; huge?: boolean } = {}): string {
	const next = rng(seed);
	const pick = <T>(list: readonly T[]) => list[Math.floor(next() * list.length)]!;
	let text = "";
	for (let i = 0; i < lines; i++) {
		let line = "";
		const parts = next() < 0.1 ? 0 : 1 + Math.floor(next() * 12);
		for (let p = 0; p < parts; p++) line += pick(WORDS) + pick(MARKS);
		// A line longer than a row shows (its hits are windowed), and one a regular expression is not run over.
		if (options.long && i % 17 === 5) line = `${"filler ".repeat(90)}${line}${" tail".repeat(40)}`;
		if (options.huge && i === 3) line = `${"z".repeat(REGEX_MAX_LINE_LENGTH + 5)} ${line}`;
		text += line + (i === lines - 1 ? "" : next() < 0.3 ? "\r\n" : "\n");
	}
	return text;
}

const LITERALS = ["sName", "name", "Due", ":=", "a", "(", "übung", "𝒳due", "$", "\\", "x"];
const EXPRESSIONS = ["s\\w+", "Due\\b", "^\\s*\\w+", "(\\w+) := (\\w+)", "(?<left>\\w+)\\s*:=\\s*(?<right>\\w+)?", "x*", "$", "\\d+", "[A-Z]\\w*(?=\\()", "(a)|(b)", "\\bDue(Date)?\\b", "(s)(N)(a)(m)(e)(\\W)?(\\W)?(\\W)?(\\W)?(\\W)?(\\W)?(\\W)?"];
const SWITCHES: Pick<SearchOptions, "caseSensitive" | "wholeWord">[] = [{}, { caseSensitive: true }, { wholeWord: true }, { caseSensitive: true, wholeWord: true }];

// ================================================================================================================
// P6
// ================================================================================================================

describe("P6: the mark of a text that was searched", () => {
	const text = ':PROCEDURE DueDate;\nsName := "first";\nsName := "second";\nsName := "third";\n:ENDPROC;\n';

	test("is the same for the same lines, whatever ends them", () => {
		expect(textMark(text)).toBe(textMark(text));
		expect(textMark(text.replace(/\n/g, "\r\n"))).toBe(textMark(text));
		// The editor keeps one kind of line end where a file has both: the two are still one text to a search.
		expect(textMark(text.replace("\n", "\r\n"))).toBe(textMark(text));
		expect(textMark("")).toBe(textMark(""));
	});

	test("is another for a line added above, a line removed, a match edited, and another text of the same size", () => {
		const others = [
			`/* added */\n${text}`,
			text.replace(":PROCEDURE DueDate;\n", ""),
			text.replace('sName := "third"', 'sTitle := "third"'),
			text.replace('"first"', '"FIRST"'),
			text.replace('sName := "first";\nsName := "second";', 'sName := "second";\nsName := "first";'),
			`${text}\n`,
			text.slice(0, -1),
			// A "\r" with no "\n" after it ends no line here: it is part of the line's own text.
			text.replace('"first"', '"fi\rrst"'),
		];
		for (const other of others) expect(textMark(other)).not.toBe(textMark(text));
		expect(new Set(others.map(textMark)).size).toBe(others.length);
	});

	test("tells apart every pair of 4,000 generated texts and of their one-letter changes", () => {
		const seen = new Map<string, string>();
		const next = rng(77);
		for (let i = 0; i < 2000; i++) {
			const one = generated(1000 + i, 1 + (i % 9));
			const at = Math.floor(next() * (one.length + 1));
			const two = `${one.slice(0, at)}q${one.slice(at)}`;
			for (const each of [one, two]) {
				const mark = textMark(each);
				const plain = each.replace(/\r\n/g, "\n");
				if (seen.has(mark)) expect(seen.get(mark)).toBe(plain);
				seen.set(mark, plain);
			}
		}
	});
});

describe("P6: a replace across files is held to the text that was searched (a real backend, real folders)", () => {
	const FILE = ':PROCEDURE DueDate;\nsName := "first";\nsName := "second";\nsName := "third";\n:ENDPROC;\n';
	const OTHER = 'sName := "other";\n';

	/**
	 * What the Search panel sends when "Replace all" is confirmed: the files with a row still listed; for a file
	 * with a row dismissed, the lines still listed in it (`allowedLinesFor`); and the marks the scan gave.
	 */
	const asThePanelSends = (scan: { hits: SearchHit[]; marks?: Record<string, string> }, dismissed: { path: string; line: number }[]) => {
		const isOut = (hit: SearchHit) => dismissed.some((row) => row.path === hit.path && row.line === hit.line);
		const listed = scan.hits.filter((hit) => !isOut(hit));
		const paths = [...new Set(listed.map((hit) => hit.path))];
		const linesByPath: Record<string, number[]> = {};
		for (const path of paths) {
			if (dismissed.some((row) => row.path === path)) linesByPath[path] = [...new Set(listed.filter((hit) => hit.path === path).map((hit) => hit.line))];
		}
		return { paths, options: { asSearched: scan.marks ?? {}, ...(Object.keys(linesByPath).length ? { linesByPath } : {}) } satisfies SearchOptions };
	};

	const setUp = async (name: string) => {
		const root = fresh(name);
		const file = join(root, "a.ssl");
		const other = join(root, "other.ssl");
		writeFileSync(file, FILE);
		writeFileSync(other, OTHER);
		const backend = createBackend(host, root);
		await backend.ready;
		const scan = await backend.api.searchScan("sName", {}, []);
		expect(scan.hits.map((hit) => `${hit.path === file ? "a" : "other"}:${hit.line}`).sort()).toEqual(["a:2", "a:3", "a:4", "other:1"]);
		return { root, file, other, backend, scan };
	};

	/** The ways a file changes between the search and the replace. Each gives what the file is afterwards, or null when it is gone. */
	const CHANGES: [string, (file: string) => string | null][] = [
		["a line added above", (file) => (writeFileSync(file, `/* added by another tool */\n${FILE}`), readFileSync(file, "utf8"))],
		["a line removed", (file) => (writeFileSync(file, FILE.replace(":PROCEDURE DueDate;\n", "")), readFileSync(file, "utf8"))],
		["the match itself edited", (file) => (writeFileSync(file, FILE.replace('sName := "third"', 'sTitle := "third"')), readFileSync(file, "utf8"))],
		["the file deleted", (file) => (rmSync(file), null)],
		[
			"another text of the same size, with the same date",
			(file) => {
				const was = statSync(file);
				const swapped = FILE.replace('sName := "first";\nsName := "second";', 'sName := "secnd";\nsName := "ffirst";');
				expect(Buffer.byteLength(swapped)).toBe(was.size);
				writeFileSync(file, swapped);
				utimesSync(file, was.atime, was.mtime);
				expect(statSync(file).size).toBe(was.size);
				// To the millisecond, which is as fine as a date can be set: the runtime the app ships with (Bun 1.4)
				// reads back the whole millisecond where 1.3 read back the fraction it had before.
				expect(Math.abs(statSync(file).mtimeMs - was.mtimeMs)).toBeLessThan(1);
				return swapped;
			},
		],
	];

	for (const [how, change] of CHANGES) {
		for (const dismissedRow of [true, false]) {
			test(`${how}, ${dismissedRow ? "with a row dismissed" : "with every match kept"}: the file is left as it is and said to have changed; the other file is replaced`, async () => {
				const { file, other, backend, scan } = await setUp(`closed-${CHANGES.findIndex((c) => c[0] === how)}-${dismissedRow ? "row" : "all"}`);
				try {
					const now = change(file);
					const { paths, options } = asThePanelSends(scan, dismissedRow ? [{ path: file, line: 3 }] : []);
					const results = await backend.api.replace("sName", "sOther", options, paths);
					expect(results.find((r) => r.path === file)).toEqual({ path: file, count: 0, changed: true });
					expect(results.find((r) => r.path === other)).toEqual({ path: other, count: 1 });
					// Not a letter of it written, and a file that is gone is not made again.
					if (now === null) expect(existsSync(file)).toBe(false);
					else expect(readFileSync(file, "utf8")).toBe(now);
					expect(readFileSync(other, "utf8")).toBe('sOther := "other";\n');
					// What is counted is what was replaced.
					expect(results.reduce((n, r) => n + r.count, 0)).toBe(1);
				} finally {
					backend.dispose();
				}
			});
		}
	}

	test("a file that is still the text that was searched is replaced on the rows kept, and the dismissed one is left", async () => {
		const { file, other, backend, scan } = await setUp("closed-same");
		try {
			const { paths, options } = asThePanelSends(scan, [{ path: file, line: 3 }]);
			expect(options.linesByPath).toEqual({ [file]: [2, 4] });
			const results = await backend.api.replace("sName", "sOther", options, paths);
			expect(results).toEqual([
				{ path: file, count: 2 },
				{ path: other, count: 1 },
			]);
			expect(readFileSync(file, "utf8")).toBe(':PROCEDURE DueDate;\nsOther := "first";\nsName := "second";\nsOther := "third";\n:ENDPROC;\n');
			// It is kept as it was in local history, and as it is now.
			expect((await backend.api.history(file)).length).toBeGreaterThanOrEqual(2);
		} finally {
			backend.dispose();
		}
	});

	test("a file saved again with the same text, or with other line ends, is still the text that was searched", async () => {
		const { file, backend, scan } = await setUp("closed-line-ends");
		try {
			writeFileSync(file, FILE.replace(/\n/g, "\r\n"));
			const { paths, options } = asThePanelSends(scan, [{ path: file, line: 3 }]);
			const results = await backend.api.replace("sName", "sOther", options, paths);
			expect(results.find((r) => r.path === file)).toEqual({ path: file, count: 2 });
			expect(readFileSync(file, "utf8")).toBe(':PROCEDURE DueDate;\r\nsOther := "first";\r\nsName := "second";\r\nsOther := "third";\r\n:ENDPROC;\r\n');
		} finally {
			backend.dispose();
		}
	});

	test("a save of the file that is asked for just before the replace lands first, and the replace sees the saved text", async () => {
		// The mark is compared in the same step as the write, under the file's lock: a save of the file that is under
		// way when the replace is asked for lands first, and the replace then sees the saved text.
		const { file, backend, scan } = await setUp("closed-save-first");
		try {
			const { paths, options } = asThePanelSends(scan, [{ path: file, line: 3 }]);
			const saved = backend.api.write(file, `/* saved meanwhile */\n${FILE}`);
			const replaced = backend.api.replace("sName", "sOther", options, paths);
			await saved;
			const results = await replaced;
			expect(results.find((r) => r.path === file)).toEqual({ path: file, count: 0, changed: true });
			expect(readFileSync(file, "utf8")).toBe(`/* saved meanwhile */\n${FILE}`);
		} finally {
			backend.dispose();
		}
	});

	test("a replace that gives marks leaves a file it has no mark for; one that gives none replaces as it always did", async () => {
		const { file, other, backend } = await setUp("closed-no-mark");
		try {
			expect(await backend.api.replace("sName", "sOther", { asSearched: {} }, [file])).toEqual([{ path: file, count: 0, changed: true }]);
			expect(readFileSync(file, "utf8")).toBe(FILE);
			// The callers that replace without a search of their own (no `asSearched`) are as they were.
			expect(await backend.api.replace("sName", "sOther", {}, [other])).toEqual([{ path: other, count: 1 }]);
			expect(await backend.api.replace("sName", "sOther", { linesByPath: { [file]: [2] } }, [file])).toEqual([{ path: file, count: 1 }]);
		} finally {
			backend.dispose();
		}
	});

	test("WorkspaceFiles.replaced says `changed` and gives nothing to write; a file grown past what is searched, or no longer text, has changed too", async () => {
		const root = fresh("replaced-direct");
		const file = join(root, "a.ssl");
		writeFileSync(file, FILE);
		const files = new WorkspaceFiles(root);
		const scan = await files.searchScan("sName", {}, []);
		expect(scan.marks).toEqual({ [file]: textMark(FILE) });
		const held = { asSearched: scan.marks! };
		expect((await files.replaced(file, "sName", "sOther", held))!.count).toBe(3);
		// By the name it was asked under, by its whole path, or by its path in the folder.
		expect((await files.replaced(file, "sName", "sOther", { asSearched: { "a.ssl": textMark(FILE) } }))!.count).toBe(3);
		writeFileSync(file, Buffer.from([0x73, 0x4e, 0x00, 0x61, 0x6d, 0x65]));
		expect(await files.replaced(file, "sName", "sOther", held)).toEqual({ before: "", after: "", count: 0, changed: true });
		expect(await files.replaced(file, "sName", "sOther", {})).toBeNull();
		writeFileSync(file, `${FILE}${"x".repeat(4 * 1024 * 1024)}`);
		expect(await files.replaced(file, "sName", "sOther", held)).toEqual({ before: "", after: "", count: 0, changed: true });
		expect(await files.replaced(file, "sName", "sOther", {})).toBeNull();
		rmSync(file);
		expect(await files.replaced(file, "sName", "sOther", held)).toEqual({ before: "", after: "", count: 0, changed: true });
		await expect(files.replaced(file, "sName", "sOther", {})).rejects.toThrow(/ENOENT/);
	});
});

describe("P6: a replace in an open file with unsaved changes is held to the text that was searched", () => {
	const ON_DISK = ':PROCEDURE DueDate;\nsName := "saved";\n:ENDPROC;\n';
	const UNSAVED = ':PROCEDURE DueDate;\nsName := "first";\nsName := "second";\nsName := "third";\n:ENDPROC;\n';

	/** The search of a folder with one file open and unsaved: its hits, and what the window keeps of it for the replace. */
	const searched = async (name: string, query = "sName", options: SearchOptions = {}) => {
		const root = fresh(name);
		const file = join(root, "a.ssl");
		writeFileSync(file, ON_DISK);
		const backend = createBackend(host, root);
		await backend.ready;
		const scan = await backend.api.searchScan(query, options, [{ path: file, text: UNSAVED }]);
		backend.dispose();
		return { file, scan, mark: scan.marks![file] };
	};

	test("the unsaved text is what is searched, and its mark is what is kept", async () => {
		const { file, scan, mark } = await searched("open-searched");
		expect(scan.hits.map((hit) => [hit.path, hit.line, hit.text])).toEqual([
			[file, 2, 'sName := "first";'],
			[file, 3, 'sName := "second";'],
			[file, 4, 'sName := "third";'],
		]);
		expect(mark).toBe(textMark(UNSAVED));
		expect(mark).not.toBe(textMark(ON_DISK));
	});

	const NOW: [string, string][] = [
		["a line typed above", `/* typed since */\n${UNSAVED}`],
		["a line removed", UNSAVED.replace(":PROCEDURE DueDate;\n", "")],
		["the match itself edited", UNSAVED.replace('sName := "third"', 'sTitle := "third"')],
		["another text of the same size", UNSAVED.replace('sName := "first";\nsName := "second";', 'sName := "secnd";\nsName := "ffirst";')],
		["the file as it is on disk (its unsaved changes thrown away)", ON_DISK],
	];

	for (const [how, now] of NOW) {
		test(`${how}: nothing is replaced in it, with a row dismissed or with none`, async () => {
			const { scan, mark } = await searched(`open-${NOW.findIndex((n) => n[0] === how)}`);
			const kept = scan.hits.filter((hit) => hit.line !== 3);
			expect(replaceSearched(now, mark, kept, "sOther", false)).toBeNull();
			expect(replaceSearched(now, mark, scan.hits, "sOther", false)).toBeNull();
			// What the window did before, for the record: the lines still allowed, as numbers, in the text as it is
			// now. The dismissed match ("second") was replaced and the two that were kept were left.
			if (how === "a line typed above") {
				const before = withEdits(now, editsBefore(now, searchPattern("sName", {}), "sOther", false, new Set(kept.map((hit) => hit.line))));
				expect(before).toBe('/* typed since */\n:PROCEDURE DueDate;\nsName := "first";\nsOther := "second";\nsName := "third";\n:ENDPROC;\n');
			}
		});
	}

	test("the text that was searched is replaced on the rows kept, by edits at the matches listed", async () => {
		const { scan, mark } = await searched("open-same");
		const kept = scan.hits.filter((hit) => hit.line !== 3);
		const done = replaceSearched(UNSAVED, mark, kept, "sOther", false)!;
		expect(done.count).toBe(2);
		expect(done.edits).toEqual([
			{ line: 2, column: 1, length: 5, text: "sOther" },
			{ line: 4, column: 1, length: 5, text: "sOther" },
		]);
		expect(done.text).toBe(':PROCEDURE DueDate;\nsOther := "first";\nsName := "second";\nsOther := "third";\n:ENDPROC;\n');
		expect(withEdits(UNSAVED, done.edits)).toBe(done.text);
		// Typed and taken back again (the same text once more) is the text that was searched.
		expect(replaceSearched(`${UNSAVED}`, mark, kept, "sOther", false)!.count).toBe(2);
		// And with the editor's own line ends in place of the file's.
		expect(replaceSearched(UNSAVED.replace(/\n/g, "\r\n"), mark, kept, "sOther", false)!.text).toBe(done.text.replace(/\n/g, "\r\n"));
	});

	test("a file with no mark (it was not in the search) is not replaced in, and matches that do not lie in the text are refused", () => {
		const hits: SearchHit[] = [{ path: "/w/a.ssl", line: 2, column: 1, length: 5, text: 'sName := "first";' }];
		expect(replaceSearched(UNSAVED, undefined, hits, "sOther", false)).toBeNull();
		expect(replaceSearched(UNSAVED, textMark(UNSAVED), undefined, "sOther", false)!.count).toBe(0);
		// The mark is what tells; this is the second line of defence, for places that are in no line of the text.
		expect(replaceFound(UNSAVED, [{ line: 99, column: 1, length: 5 }], "x", false)).toBeNull();
		expect(replaceFound(UNSAVED, [{ line: 2, column: 15, length: 9 }], "x", false)).toBeNull();
		expect(replaceFound(UNSAVED, [{ line: 0, column: 1, length: 1 }], "x", false)).toBeNull();
		expect(
			replaceFound(
				UNSAVED,
				[
					{ line: 2, column: 1, length: 5 },
					{ line: 2, column: 3, length: 5 },
				],
				"x",
				false,
			),
		).toBeNull();
	});

	test("what is said of the files left as they are names them and says what to do", () => {
		expect(changedSinceSearch(["a.ssl"])).toBe("Not replaced in a.ssl: it has changed since the search. Search again to replace in it.");
		expect(changedSinceSearch(["a.ssl", "b.md"])).toBe("Not replaced in 2 files (a.ssl, b.md): they have changed since the search. Search again to replace in them.");
		expect(changedSinceSearch(["1", "2", "3", "4", "5", "6", "7"])).toBe("Not replaced in 7 files (1, 2, 3, 4, 5, …): they have changed since the search. Search again to replace in them.");
	});
});

// ================================================================================================================
// P7
// ================================================================================================================

describe("P7: an open file's unsaved text is searched by the backend's scan, and gives the hits it gave", () => {
	const root = fresh("open-scan");
	const files = new WorkspaceFiles(root);
	const at = join(root, "open.ssl");
	const TEXTS = [generated(1, 60), generated(2, 80, { long: true }), generated(3, 40, { long: true, huge: true }), generated(4, 1), "", "\n\n", "sName", "x\r\nx\nx\r\n"];

	test("words as typed and regular expressions, with each of the switches, over generated texts", async () => {
		let compared = 0;
		let found = 0;
		for (const text of TEXTS) {
			for (const regex of [false, true]) {
				for (const query of regex ? EXPRESSIONS : LITERALS) {
					for (const switches of SWITCHES) {
						const options = { regex, ...switches };
						const before = scanTextBufferBefore(at, text, searchPattern(query, options), regex, SEARCH_LIMIT);
						const now = await files.searchScan(query, options, [{ path: at, text }]);
						expect(now.timedOut).toBe(false);
						expect(bare(now.hits)).toEqual(before);
						// A mark for a text something was found in, and none for one nothing was.
						expect(now.marks).toEqual(before.length ? { [at]: textMark(text) } : {});
						compared++;
						found += before.length;
					}
				}
			}
		}
		expect(compared).toBe(TEXTS.length * (LITERALS.length + EXPRESSIONS.length) * SWITCHES.length);
		// The comparison is of lists with something in them.
		expect(found).toBeGreaterThan(20_000);
	});

	test("as many as are listed at most, over one text and over several, as the window counted them", async () => {
		const many = "hit\n".repeat(SEARCH_LIMIT + 50);
		const pattern = searchPattern("hit", {});
		expect(bare((await files.searchScan("hit", {}, [{ path: at, text: many }])).hits)).toEqual(scanTextBufferBefore(at, many, pattern, false, SEARCH_LIMIT));
		// Several: the second is searched for what is left of the most, and the third not at all.
		const second = join(root, "second.ssl");
		const third = join(root, "third.ssl");
		const half = "hit\n".repeat(SEARCH_LIMIT - 10);
		const before: SearchHit[] = [];
		for (const [path, text] of [
			[at, half],
			[second, half],
			[third, half],
		] as const) {
			const left = Math.max(0, SEARCH_LIMIT - before.length);
			if (left > 0) before.push(...scanTextBufferBefore(path, text, pattern, false, left));
		}
		const now = await files.searchScan("hit", {}, [
			{ path: at, text: half },
			{ path: second, text: half },
			{ path: third, text: half },
		]);
		expect(bare(now.hits)).toEqual(before);
		expect(now.hits).toHaveLength(SEARCH_LIMIT);
		expect(Object.keys(now.marks!).sort()).toEqual([at, second].sort());
	});

	test("the open text stands in for the file of its name on disk, and is listed after the files, as the window merged them", async () => {
		const ws = fresh("open-merge");
		const a = join(ws, "a.ssl");
		const b = join(ws, "src", "b.ssl");
		const c = join(ws, "c.ssl");
		mkdirSync(join(ws, "src"));
		writeFileSync(a, "sName := 1; /* on disk */\n");
		writeFileSync(b, "sName := 2;\n");
		writeFileSync(c, "sName := 3;\n");
		const backend = createBackend(host, ws);
		try {
			await backend.ready;
			const unsaved = "/* typed */\nsName := 10;\nsName := 11;\n";
			// Before: every file on disk, then the hits on disk of the open file taken out and its own put last.
			const disk = await backend.api.searchScan("sName", {});
			const before = [...disk.hits.filter((hit) => hit.path !== a), ...scanTextBufferBefore(a, unsaved, searchPattern("sName", {}), false, SEARCH_LIMIT)];
			const now = await backend.api.searchScan("sName", {}, [{ path: a, text: unsaved }]);
			expect(now.hits).toEqual(before);
			expect(now.hits.map((hit) => hit.text)).toEqual(expect.arrayContaining(["sName := 2;", "sName := 3;", "sName := 10;", "sName := 11;"]));
			expect(now.hits.some((hit) => hit.text.includes("on disk"))).toBe(false);
			expect(now.marks).toEqual({ [b]: textMark("sName := 2;\n"), [c]: textMark("sName := 3;\n"), [a]: textMark(unsaved) });
			// Named without a text (too large to send, or sent in a call of its own): only left out of what is read from disk.
			const named = await backend.api.searchScan("sName", {}, [{ path: a }]);
			expect(named.hits.map((hit) => hit.path).sort()).toEqual([b, c].sort());
			// A call that reads no file (`paths: []`) still searches the texts it is given: how the rest of them are sent.
			const rest = await backend.api.searchScan("sName", { paths: [] }, [{ path: a, text: unsaved }]);
			expect(rest.hits.map((hit) => hit.line)).toEqual([2, 3]);
			expect(await backend.api.searchScan("sName", { paths: [] }, [])).toEqual({ hits: [], timedOut: false, marks: {} });
			// A text that has no file (not saved yet) is searched too, and takes no file's place.
			const untitled = await backend.api.searchScan("sName", {}, [{ path: "untitled:1", text: "sName := 99;" }]);
			expect(untitled.hits.map((hit) => hit.path)).toEqual([...disk.hits.map((hit) => hit.path), "untitled:1"]);
			// A text too large to search is searched no more for being open than a file of that size is on disk.
			const large = await backend.api.searchScan("sName", { paths: [] }, [{ path: a, text: `sName\n${"x".repeat(SEARCH_MAX_TEXT)}` }]);
			expect(large.hits).toEqual([]);
		} finally {
			backend.dispose();
		}
	});

	test("the callers that only list hits are given what they were given: no marks, and no groups on a regular expression's hits", async () => {
		const ws = fresh("open-none");
		writeFileSync(join(ws, "a.ssl"), "sName := 1;\n");
		const one = new WorkspaceFiles(ws);
		const plain = await one.searchScan("(s)(Name)", { regex: true });
		expect(Object.keys(plain).sort()).toEqual(["hits", "timedOut"]);
		expect(Object.keys(plain.hits[0]!).sort()).toEqual(["column", "length", "line", "path", "text"]);
		expect(await one.search("(s)(Name)", { regex: true })).toEqual(plain.hits);
		// Asked for by the Search panel, the same hits say where their groups lie.
		const forReplace = await one.searchScan("(s)(Name)", { regex: true }, []);
		expect(bare(forReplace.hits)).toEqual(plain.hits);
		expect(forReplace.hits[0]!.groups).toEqual([
			[0, 1],
			[1, 5],
		]);
	});

	test("the texts go in as many calls as keeps each within what a message carries; the first names every open file", () => {
		const text = (n: number) => "x".repeat(n);
		expect(openBatches([])).toEqual([[]]);
		expect(openBatches([{ path: "a", text: "one" }])).toEqual([[{ path: "a", text: "one" }]]);
		const open = [
			{ path: "a", text: text(6) },
			{ path: "b", text: text(6) },
			{ path: "c", text: text(3) },
			{ path: "d", text: text(9) },
		];
		expect(openBatches(open, 10)).toEqual([
			[{ path: "a", text: text(6) }, { path: "b" }, { path: "c" }, { path: "d" }],
			[
				{ path: "b", text: text(6) },
				{ path: "c", text: text(3) },
			],
			[{ path: "d", text: text(9) }],
		]);
		// One too large to search is in no call, and is still named in the first.
		const large = openBatches([{ path: "big", text: text(SEARCH_MAX_TEXT + 1) }, { path: "a", text: "one" }, { path: "named" }]);
		expect(large).toEqual([[{ path: "a", text: "one" }, { path: "big" }, { path: "named" }]]);
		// Every text within the most there is of text in a call, and every text in exactly one.
		const many = Array.from({ length: 40 }, (_, i) => ({ path: `p${i}`, text: text(1 + ((i * 7919) % 5000)) }));
		const batches = openBatches(many, 6000);
		for (const batch of batches) expect(batch.reduce((n, each) => n + (each.text?.length ?? 0), 0)).toBeLessThanOrEqual(6000);
		expect(batches.flatMap((batch) => batch.filter((each) => each.text !== undefined).map((each) => each.path))).toEqual(many.map((each) => each.path));
		expect(batches[0]!.map((each) => each.path).sort()).toEqual(many.map((each) => each.path).sort());
	});
});

describe("P7: a regular expression that takes long over a line does not hold the search past its budget", () => {
	const BUDGET = 300;
	/** As long as one match may run on before the budget is looked at again: the engine's own limit to one match, with room for a slow machine. */
	const ONE_MATCH = 4000;
	const withBudget = async <T>(ms: number, work: () => Promise<T>): Promise<T> => {
		const before = WorkspaceFiles.searchTimeoutMs;
		WorkspaceFiles.searchTimeoutMs = ms;
		try {
			return await work();
		} finally {
			WorkspaceFiles.searchTimeoutMs = before;
		}
	};

	// Each line costs the old walk most of a second (the engine gives one match up at about 0.8 s), or for the last
	// expression some 70 ms: 40 and 200 such lines were half a minute and a quarter of one, in the window.
	const CASES: [string, string][] = [
		["(a+)+$", Array.from({ length: 40 }, (_, i) => `${"a".repeat(30 + (i % 7))}b`).join("\n")],
		["(a|aa)+$", Array.from({ length: 40 }, (_, i) => `${"a".repeat(40 + (i % 7))}b`).join("\r\n")],
		["(.*a){12}", Array.from({ length: 200 }, (_, i) => `a${"b".repeat(36 + (i % 3))}`.repeat(11)).join("\n")],
	];

	for (const [expression, text] of CASES) {
		test(`${expression} over an unsaved text: the call comes back within the budget and one match, and says it ran out of time`, async () => {
			const root = fresh(`redos-${CASES.findIndex((c) => c[0] === expression)}`);
			const backend = createBackend(host, root);
			try {
				await backend.ready;
				const started = performance.now();
				const scan = await withBudget(BUDGET, () => backend.api.searchScan(expression, { regex: true }, [{ path: join(root, "open.ssl"), text }]));
				const took = performance.now() - started;
				expect(scan.timedOut).toBe(true);
				expect(took).toBeLessThan(BUDGET + ONE_MATCH);
				// Nothing is listed as if it were all there is: the panel refuses to replace from a list like this one.
				const shortfall = searchShortfall({ hits: scan.hits.length, limit: SEARCH_LIMIT, truncated: false, timedOut: scan.timedOut });
				expect(shortfallBlocksReplace(shortfall, SEARCH_LIMIT)).toContain("The search ran out of time");
			} finally {
				backend.dispose();
			}
		});
	}

	test("the budget is looked at between the matches of one line too, for a regular expression", async () => {
		// A clock that moves one tick each time it is read: once for the deadline, once before the text, once at its
		// line, and then once after each match of a regular expression.
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
		const root = fresh("ticks");
		const files = new WorkspaceFiles(root);
		const line = "x x x x x x x x";
		const open = [{ path: join(root, "open.ssl"), text: line }];
		expect((await files.searchScan("x", { regex: true }, open)).hits).toHaveLength(8);
		const cut = await withTicks(4.5, () => files.searchScan("x", { regex: true }, open));
		expect(cut.timedOut).toBe(true);
		expect(cut.hits.map((hit) => hit.column)).toEqual([1, 3, 5]);
		// Words as typed have no match that is long in coming, and are looked at as they were: between lines.
		expect((await withTicks(4.5, () => files.searchScan("x", {}, open))).hits).toHaveLength(8);
		// The same for a file on disk, where one line of many slow matches held the scan as long.
		writeFileSync(join(root, "disk.ssl"), line);
		const onDisk = await withTicks(4.5, () => files.searchScan("x", { regex: true }));
		expect(onDisk).toEqual({ hits: cut.hits.map((hit) => ({ ...hit, path: join(root, "disk.ssl") })), timedOut: true });
	});

	test("matchesOn stops after the match that came late, and says so", () => {
		const real = performance.now;
		let tick = 0;
		performance.now = () => tick++;
		try {
			const clock = { until: 1.5, late: false };
			expect(matchesOn("x x x x x", /x/g, "", true, Infinity, clock).map((m) => m.column)).toEqual([1, 3, 5]);
			expect(clock.late).toBe(true);
			const inTime = { until: 100, late: false };
			expect(matchesOn("x x x x x", /x/g, "", true, Infinity, inTime)).toHaveLength(5);
			expect(inTime.late).toBe(false);
		} finally {
			performance.now = real;
		}
		// Without a clock, as every other caller has it, the clock is not read at all.
		let read = 0;
		performance.now = () => (read++, 0);
		try {
			expect(matchesOn("x x x", /x/g, "", true)).toHaveLength(3);
			expect(read).toBe(0);
		} finally {
			performance.now = real;
		}
	});

	test("an open text not got to before the time ran out is not listed as searched", async () => {
		const root = fresh("budget-spent");
		const files = new WorkspaceFiles(root);
		writeFileSync(join(root, "a.ssl"), "sName := 1;\n");
		const open = [{ path: join(root, "open.ssl"), text: "sName := 2;" }];
		expect(await withBudget(-1, () => files.searchScan("sName", {}, open))).toEqual({ hits: [], timedOut: true, marks: {} });
	});
});

describe("P7: what a match becomes is worked out from where the search found it, with no second run of the expression", () => {
	const REPLACEMENTS = ["sOther", "", "$1", "[$1|$2]", "$&!", "$$", "$<left>=$<right>", "$<none>", "$12", "$3$9", "<$0>", "a$"];

	test("becomesFound gives what running the expression gave, for every match of generated lines", () => {
		let compared = 0;
		for (const text of [generated(11, 60), generated(12, 60, { long: true })]) {
			for (const query of EXPRESSIONS) {
				for (const switches of SWITCHES) {
					const pattern = withGroups(searchPattern(query, { regex: true, ...switches }));
					for (const line of text.split(/\r?\n/)) {
						for (const replacement of REPLACEMENTS) {
							for (const match of matchesOn(line, pattern, replacement, true)) {
								expect(becomesFound(line, 0, match, replacement, true)).toBe(match.becomes);
								compared++;
							}
						}
					}
				}
			}
		}
		expect(compared).toBeGreaterThan(50_000);
	});

	test("words as typed become the replacement as typed; a group that took no part is nothing; one the expression has not is left as written", () => {
		expect(becomesFound("sName := 1;", 0, { column: 1, length: 5 }, "$1 & $&", false)).toBe("$1 & $&");
		const [match] = matchesOn("ab", withGroups(/(a)|(b)/g), "", true);
		expect(match!.groups).toEqual([[0, 1], null]);
		expect(becomesFound("ab", 0, match!, "[$1][$2][$3]", true)).toBe("[a][][$3]");
		const [named] = matchesOn("sName := 1", withGroups(/(?<left>\w+)\s*:=\s*(?<right>x)?/g), "", true);
		expect(named!.named).toEqual({ left: [0, 5], right: null });
		expect(becomesFound("sName := 1", 0, named!, "$<right>|$<left>|$<other>", true)).toBe("|sName|$<other>");
	});

	test("from the part of a long line a row shows: what lies in it is worked out, what does not is not guessed", () => {
		const line = `${"filler ".repeat(100)}sName := nDue;${" tail".repeat(60)}`;
		const [match] = matchesOn(line, withGroups(/(\w+) := (\w+)/g), "", true);
		const { text, textOffset } = excerptForMatch(line, match!.column, match!.length);
		expect(textOffset).toBeGreaterThan(0);
		expect(becomesFound(text, textOffset, match!, "$2 := $1", true)).toBe("nDue := sName");
		expect(becomesFound(text.slice(0, 50), textOffset, match!, "$2 := $1", true)).toBeUndefined();
		expect(becomesFound(text, textOffset + 200, match!, "$2 := $1", true)).toBeUndefined();
	});

	test("replaceSearched gives the text replaceIn gives, from the hits of the backend's scan", async () => {
		const root = fresh("replace-equal");
		const files = new WorkspaceFiles(root);
		const at = join(root, "open.ssl");
		let compared = 0;
		let cut = 0;
		for (const text of [generated(21, 50), generated(22, 50, { long: true, huge: true })]) {
			for (const regex of [false, true]) {
				for (const query of regex ? EXPRESSIONS : LITERALS) {
					for (const switches of SWITCHES) {
						const options = { regex, ...switches };
						const { hits, marks } = await files.searchScan(query, options, [{ path: at, text }]);
						// A list cut at the most that is listed is not replaced from: the panel refuses it.
						if (hits.length >= SEARCH_LIMIT) {
							cut++;
							continue;
						}
						for (const replacement of regex ? REPLACEMENTS : ["sOther", "", "$1"]) {
							const whole = replaceIn(text, query, replacement, options);
							const now = replaceSearched(text, marks![at] ?? textMark(text), hits, replacement, regex)!;
							expect(now.text).toBe(whole.text);
							expect(now.count).toBe(whole.count);
							// The edits an open file is given are those the walk over its text made, and make that text of it.
							expect(now.edits).toEqual(editsBefore(text, searchPattern(query, options), replacement, regex));
							expect(withEdits(text, now.edits)).toBe(whole.text);
							compared++;
						}
					}
				}
			}
		}
		expect(compared).toBeGreaterThan(500);
		expect(cut).toBeLessThan(20);
	});

	test("with rows dismissed and under the Safe Docs guards it gives what replaceSafeInText gave", async () => {
		const root = fresh("replace-safe");
		const files = new WorkspaceFiles(root);
		const md = join(root, "doc.md");
		const text = ["---", "status: draft", "owner: status team", "---", "", "The status of [status](docs/status.md) and [[status|the status]].", "", "```", "status in code", "```", "status status", ""].join("\n");
		for (const [query, regex, replacement] of [
			["status", false, "state"],
			["(st)(atus)", true, "$2$1"],
			["\\bstatus\\b", true, "<$&>"],
		] as const) {
			const options = { regex };
			const { hits, marks } = await files.searchScan(query, options, [{ path: md, text }]);
			const pattern = searchPattern(query, options);
			for (const dismissed of [[], [2], [6, 11], [2, 3, 6, 9, 11]]) {
				const kept = hits.filter((hit) => !dismissed.includes(hit.line));
				const allowedLines = dismissed.length ? new Set(kept.map((hit) => hit.line)) : undefined;
				for (const safeDocs of [true, false]) {
					const before = replaceSafeInText(text, pattern, replacement, regex, { allowedLines, isMarkdown: true, safeDocs, maxSamples: 2 });
					const spans = safeDocs ? protectedMarkdownSpans(text) : null;
					const now = replaceSearched(text, marks![md], kept, replacement, regex, {
						skip: spans ? (match) => overlapsProtectedSpan(match.column, match.length, spans.get(match.line)) : undefined,
						maxSamples: 2,
					})!;
					expect({ text: now.text, count: now.count, skippedProtected: now.skippedProtected, invalidJson: now.invalidJson, samples: now.samples }).toEqual(before);
					expect(now.edits).toEqual(editsBefore(text, pattern, replacement, regex, allowedLines, spans ?? undefined));
				}
			}
		}
		// A plan that would no longer be JSON is left as it is, as before.
		const plan = '{\n  "version": 1,\n  "title": "Due Dates",\n  "nodes": []\n}\n';
		const at = join(root, "flow.plan.json");
		const scan = await files.searchScan("Due Dates", {}, [{ path: at, text: plan }]);
		const broken = replaceSearched(plan, scan.marks![at], scan.hits, 'Bad "Quote', false, { json: true })!;
		expect(broken).toEqual({ ...replaceSafeInText(plan, searchPattern("Due Dates", {}), 'Bad "Quote', false, { isPlanJson: true, safeDocs: true }), edits: [] });
		expect(broken.invalidJson).toBe(true);
		expect(replaceSearched(plan, scan.marks![at], scan.hits, "Due Days", false, { json: true })!.text).toBe(plan.replace("Due Dates", "Due Days"));
	});
});

describe("P6 and P7: how the panel is wired to this (source only: it needs a DOM and the real Monaco to run)", () => {
	const src = readSrc("src/view/panels/Search.tsx");

	test("the window runs no expression that was typed: it neither makes one nor walks a text with one", () => {
		expect(src).not.toContain("matchesOn(");
		expect(src).not.toContain("searchPattern(");
		expect(src).not.toContain("replaceSafeInText(");
		expect(src).not.toContain("replaceIn(");
		expect(src).not.toContain("scanTextBuffer");
		expect(src).not.toMatch(/import \{[^}]*\b(matchesOn|searchPattern|replaceIn|replaceSafeInText)\b[^}]*\} from/);
		// The expressions it does make are its own, of text it has escaped.
		expect(src.match(/new RegExp\(/g)?.length).toBe(2);
		expect(between(src, "const toggleQueryToken =", "const showDocChips")).toContain("new RegExp(`(?:^|\\\\s)${esc}(?=\\\\s|$)`");
	});

	test("the search sends the open files' unsaved texts, and keeps the marks with the hits", () => {
		const run = between(src, "const run = async (overrides: RunOverrides = {}) => {", "// A search asked for from elsewhere is put in the box and run");
		expect(run).toContain("open.push({ path: docPath, text: doc.model.getValue() });");
		expect(run).toContain("for (const [index, batch] of openBatches(open).entries()) {");
		expect(run).toContain("const scan = await backend.searchScan(effectiveQuery, index ? { ...backendOptions, paths: [] } : backendOptions, batch);");
		expect(run).toContain("Object.assign(found, scan.marks);");
		expect(run).toContain("if (ranOutOfTime) break;");
		expect(run).toContain("setMarks(found);\n\t\t\tsetHits(merged);");
		expect(between(src, "function resetSearchState() {", "// --- Search query history")).toContain("setMarks({});");
	});

	test("every replace the window works out goes through the one function that is held to the mark", () => {
		const guarded = between(src, "function replaceGuarded(", "/** The hits of each file");
		expect(guarded).toContain("return replaceSearched(text, mark, listed, with_, regex, {");
		expect(guarded).toContain("skip: spans ? (match) => overlapsProtectedSpan(match.column, match.length, spans.get(match.line)) : undefined,");
		expect(src.match(/replaceSearched\(/g)?.length).toBe(1);
		// The check of a plan, the replace in an open file, and the preview.
		expect(src.match(/replaceGuarded\(/g)?.length).toBe(4);
		expect(between(src, "const invalidPlanPaths = createMemo(() => {", "/** What each marked match")).toContain("replaceGuarded(path, text, marks()[path], listedBy().get(path), replacement(), Boolean(searched().regex), true, 0)");
		const replace = between(src, "const executeReplace = async (skipConfirm: boolean) => {", "const replaceAll = () => executeReplace(false);");
		expect(replace).toContain("const sim = replaceGuarded(path, currentValue, mark, listed.get(path), with_, Boolean(options.regex), protect, 0);");
		expect(replace).toContain("if (!sim) {\n\t\t\t\t\t\tchanged.push(path);\n\t\t\t\t\t\tcontinue;\n\t\t\t\t\t}");
		expect(replace).toContain("const replaced = replaceInModel(doc.model, sim.edits);");
		// Between the text that was looked at and the edits made in it, the one wait: the file is looked at again after it.
		expect(replace).toContain("if (doc.model.isDisposed() || doc.model.getVersionId() !== version) {\n\t\t\t\t\t\t\tchanged.push(path);");
		const preview = between(src, "const previewReplace = async () => {", "const summary = () => {");
		expect(preview).toContain("const res = replaceGuarded(path, text, searchedAs[path], listed.get(path), with_, Boolean(options.regex), protect, 1);");
		expect(preview).toContain('sampleSummary: "Skipped: changed since the search. Search again to replace in it",');
	});

	test("the files on disk are sent with the marks, and one that comes back changed is told of and not counted", () => {
		const replace = between(src, "const executeReplace = async (skipConfirm: boolean) => {", "const replaceAll = () => executeReplace(false);");
		expect(replace).toContain("if (mark !== undefined) asSearched[path] = mark;");
		expect(replace).toContain("\t\t\t\t\t\tsafeDocs: protect,\n\t\t\t\t\t\tasSearched,\n");
		expect(replace).toContain("if (result.changed) {\n\t\t\t\t\t\t\tchanged.push(result.path);\n\t\t\t\t\t\t\tcontinue;\n\t\t\t\t\t\t}");
		expect(replace).toContain('if (changed.length) notify(changedSinceSearch(changed.map(baseName)), "error");');
		// The count in the notice is of what was replaced: it is added to only where something was.
		expect(replace.match(/done \+= /g)?.length).toBe(2);
		expect(replace).toContain("done += replaced;");
		expect(replace).toContain("done += result.count;");
	});

	test("what a row's match would become is worked out from the hit, and the edits of an open file are made as one step", () => {
		const becomes = between(src, "const becomes = (line: LineHit) => {", "/** How the list on screen falls short");
		expect(becomes).toContain("becomesFound(line.text, line.textOffset ?? 0, where?.get(`${line.path}\\n${line.line}\\n${match.column}`) ?? match, replacement(), isRegex)");
		const inModel = between(src, "export function replaceInModel(", "/**\n * What a replace makes of one file's text");
		expect(inModel).toContain("edits.map((edit) => ({ range: new monaco.Range(edit.line, edit.column, edit.line, edit.column + edit.length), text: edit.text }))");
		expect(inModel.match(/model\.pushStackElement\(\);/g)?.length).toBe(2);
	});
});
