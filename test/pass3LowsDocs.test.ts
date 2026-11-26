// Pass 3, the low findings in the project-documents engine, the Markdown Inspector and the templates: the day a
// review is due, how long a table cell reads, a reply saved as a note, a registry row with a new ticket column, a
// catalog whose end marker is gone, Unlink of a path written from the ticket's folder, three dashes typed in the
// raw YAML box, separator characters in a value, a ticket key in a template's front matter, a refused front-matter
// edit in the Docs panel, and the one list of folders a picture is looked for in.
// Each test runs the code it names. Two things sit in component code that cannot be run here (the raw YAML box
// needs a textarea and an open editor document; the Docs panel's edit needs the backend): for those the decision
// was pulled out into a function that is run, and the source is read only to see that the component asks it.
import { describe, expect, mock, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { catalogEndMissing, catalogList, catalogStale, withCatalog, CATALOG_END, CATALOG_START } from "../src/shared/catalog";
import { parseCsv } from "../src/shared/csv";
import { daysBetween, staleDocChecks } from "../src/shared/docChecks";
import { bareNameTarget, pictureFolders } from "../src/shared/docLinks";
import { cellText, checkTables, shownLength } from "../src/shared/docTables";
import {
	addToFrontMatterList,
	formatFrontMatterInnerReplacement,
	frontMatter,
	frontMatterInnerSpan,
	frontMatterRefusal,
	innerLineEndingFrontMatter,
	many,
	quoteYamlScalar,
	removeFromFrontMatterList,
	replaceInFrontMatterList,
	summaryOf,
	withFrontMatter,
} from "../src/shared/frontMatter";
import { isPrompt, PROMPTS, questionTemplate, referenceTemplate, snippetTemplate } from "../src/shared/projectDocs";
import type { DocFile } from "../src/shared/protocol";
import { ticketColumn } from "../src/shared/registryTickets";
import { DEFAULT_TEMPLATES, renderTemplate, type TemplaterContext } from "../src/shared/templater";

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

const { questionHolding, referenceNoteHolding, refsNaming, registryTextWithRow, snippetHolding } = await import("../src/view/projectDocs");

const readSrc = (rel: string) => readFileSync(join(import.meta.dir, rel), "utf8").replace(/\r\n/g, "\n");
const root = resolve(import.meta.dir, "..");

// ---------------------------------------------------------------------------------------------------------------
describe("1. a review is due by the day it is where the person is", () => {
	const sop = (reviewDue: string) => ({ path: "/w/docs/specs/sop.md", name: "sop.md", group: "specs", exists: true, title: "SOP", status: "approved", approvedBy: "QA", approvedDate: "2026-01-01", reviewDue }) as DocFile;
	const said = (docs: DocFile[], now: string, today: string) => staleDocChecks(docs, Date.parse(now), today).map((issue) => `${issue.level}: ${issue.message}`);

	test("two written days are a whole number of days apart, whatever the hour", () => {
		expect(daysBetween("2026-11-24", "2026-11-24")).toBe(0);
		expect(daysBetween("2026-11-24", "2026-11-25")).toBe(1);
		expect(daysBetween("2026-11-25", "2026-11-24")).toBe(-1);
		// Across the night the clocks change: still two days.
		expect(daysBetween("2026-03-07", "2026-03-09")).toBe(2);
		expect(daysBetween("2026-12-31", "2027-01-01")).toBe(1);
		expect(daysBetween("2026-11-24", "soon")).toBeNull();
		expect(daysBetween("2026-11-24", undefined)).toBeNull();
		expect(daysBetween("2026-11-24", "2026-02-30")).toBeNull();
	});

	test("an evening west of UTC: a review due today is due today, not a day past due", () => {
		// 17:30 on the 24th where UTC is eight hours ahead: the UTC day is already the 25th.
		// Before: "warn: Review past due by 1 day (2026-11-24): SOP."
		expect(said([sop("2026-11-24")], "2026-11-25T01:30:00Z", "2026-11-24")).toEqual(["note: Review due today (2026-11-24): SOP."]);
		expect(said([sop("2026-11-25")], "2026-11-25T01:30:00Z", "2026-11-24")).toEqual(["note: Review due in 1 day (2026-11-25): SOP."]);
	});

	test("a morning east of UTC: a review due yesterday is a day past due, not due today", () => {
		// 08:00 on the 25th where UTC is twelve hours behind: the UTC day is still the 24th.
		// Before: "note: Review due today (2026-11-24): SOP."
		expect(said([sop("2026-11-24")], "2026-11-24T20:00:00Z", "2026-11-25")).toEqual(["warn: Review past due by 1 day (2026-11-24): SOP."]);
	});

	test("with no day handed in, today is the local day, and an age is counted from local midnight (run in a time zone of its own)", () => {
		// A process of its own: the time zone of this one is the whole run's, and is left alone.
		const script = `
			import { staleDocChecks } from ${JSON.stringify(join(root, "src/shared/docChecks.ts"))};
			const now = Date.parse("2026-11-25T01:30:00Z");
			const sop = { path: "/w/docs/specs/sop.md", name: "sop.md", group: "specs", exists: true, title: "SOP", status: "approved", approvedBy: "QA", approvedDate: "2026-01-01", reviewDue: "2026-11-24" };
			const question = { path: "/w/docs/knowledge/questions/q.md", name: "q.md", group: "knowledge", kind: "questions", exists: true, title: "Q", status: "open", asked: "2026-10-25" };
			console.log(JSON.stringify(staleDocChecks([sop, question], now).map((issue) => issue.message)));
		`;
		const run = (zone: string) => {
			const done = Bun.spawnSync([process.execPath, "--no-install", "-e", script], { cwd: root, env: { ...process.env, TZ: zone } });
			expect(done.exitCode).toBe(0);
			return JSON.parse(done.stdout.toString()) as string[];
		};
		// In Los Angeles it is 17:30 on the 24th: the review is due today, and the question was asked 30 days ago.
		// Before: "Review past due by 1 day ..." and "Open question untouched for 31 days: Q."
		expect(run("America/Los_Angeles")).toEqual(["Review due today (2026-11-24): SOP.", "Open question untouched for 30 days: Q."]);
		// In Auckland it is 14:30 on the 25th: a day past due, and 31 days.
		expect(run("Pacific/Auckland")).toEqual(["Review past due by 1 day (2026-11-24): SOP.", "Open question untouched for 31 days: Q."]);
	});
});

// ---------------------------------------------------------------------------------------------------------------
describe("2. a table cell is measured as it reads", () => {
	const table = (cell: string) => `| Name | What |\n| --- | --- |\n| ${cell} | x |\n`;
	const found = (cell: string) => checkTables(table(cell)).map((finding) => finding.message);

	test("an underscore, a star or a tilde that is shown is counted", () => {
		// Before: "SAMPLEDUEDATEOVERRIDEAT", four characters short of what is read.
		expect(cellText("SAMPLE_DUE_DATE_OVERRIDE_AT")).toBe("SAMPLE_DUE_DATE_OVERRIDE_AT");
		expect(cellText("`DUE_SOON_AT`")).toBe("DUE_SOON_AT");
		expect(cellText("`SELECT * FROM t`")).toBe("SELECT * FROM t");
		expect(cellText("5 * 3 * 2")).toBe("5 * 3 * 2");
		expect(cellText("~/work")).toBe("~/work");
		expect(cellText("\\_private\\_")).toBe("_private_");
		// The marks of emphasis are still no part of what is read.
		expect(cellText("*em*, **strong**, _em_ and ~~gone~~")).toBe("em, strong, em and gone");
		expect(cellText("[DEMO_SAMPLES](some/long/path/to/DEMO_SAMPLES.md)")).toBe("DEMO_SAMPLES");
	});

	test("a name of 22 characters with underscores is too long for a short column", () => {
		// Before: nothing was said, the name counted as 19.
		expect(found("DUE_SOON_THRESHOLD_HRS")).toEqual(['"Name" holds a value of 22 characters; only the last column holds text, and the others at most 20.']);
		expect(found("`DUE_SOON_THRESHOLD_HRS`")).toEqual(['"Name" holds a value of 22 characters; only the last column holds text, and the others at most 20.']);
		expect(found("DUE_SOON_THRESHOLD_H")).toEqual([]);
	});

	test("an entity is the one character it shows as", () => {
		expect(cellText("a &amp; b &lt; c &gt; d")).toBe("a & b < c > d");
		expect(cellText("&#65;&#x42;&rarr;")).toBe("AB\u2192");
		// A name outside the short list here still shows as one character.
		expect(shownLength(cellText("&Dagger;"))).toBe(1);
		// Inside code an entity is not read: the five characters are shown.
		expect(cellText("`&amp;`")).toBe("&amp;");
		// Before: reported as 27 characters; it reads as 17.
		expect(found("a &amp; b &lt; c &gt; d e f")).toEqual([]);
	});

	test("a character made of several code units is one character", () => {
		expect(shownLength("plain text")).toBe(10);
		expect(shownLength("\u{1F600}")).toBe(1);
		expect(shownLength("e\u0301")).toBe(1);
		expect(found("\u{1F600}".repeat(20))).toEqual([]);
		expect(found("\u{1F600}".repeat(21))).toEqual(['"Name" holds a value of 21 characters; only the last column holds text, and the others at most 20.']);
	});

	test("a tag is not read, and a line break parts two words", () => {
		expect(cellText("<kbd>Ctrl</kbd>+<kbd>S</kbd>")).toBe("Ctrl+S");
		expect(cellText("one<br>two")).toBe("one two");
	});
});

// ---------------------------------------------------------------------------------------------------------------
describe("3. a reply saved as a note takes the place of the template's prompt", () => {
	test("a reference note opens with the reply, under its heading when it has one", () => {
		expect(referenceNoteHolding(referenceTemplate({ title: "How holidays are read" }), "Holidays come from WORK_CALENDAR.", "Answer")).toBe(
			"# How holidays are read\n\n## Answer\n\nHolidays come from WORK_CALENDAR.\n",
		);
		const withTicket = withFrontMatter(referenceTemplate({ title: "How holidays are read" }), "ticket", "LIMS-7")!;
		const note = referenceNoteHolding(withTicket, "Holidays come from the WORK_CALENDAR table.\n\nMore detail.\n");
		// Before: "# How holidays are read\n\nOne sentence on what this explains.\nHolidays come from ..." (one paragraph).
		expect(note).toBe("---\nticket: LIMS-7\n---\n\n# How holidays are read\n\nHolidays come from the WORK_CALENDAR table.\n\nMore detail.\n");
		expect(note).not.toContain(PROMPTS.reference);
		// The listing takes a document whose summary is a prompt for one not written yet.
		expect(summaryOf(note)).toBe("Holidays come from the WORK_CALENDAR table.");
		expect(isPrompt(summaryOf(note))).toBe(false);
	});

	test("a question holds the reply as why it matters, and its answer is left to write", () => {
		const question = questionHolding(questionTemplate({ title: "Do holidays move due dates?", date: "2026-11-24", ticket: "LIMS-7" }), "The reply could not tell whether holidays are skipped.\n");
		expect(question).not.toContain(PROMPTS.question);
		expect(question.endsWith("# Do holidays move due dates?\n\n## Why it matters\n\nThe reply could not tell whether holidays are skipped.\n\n## Answer\n\n")).toBe(true);
		expect(frontMatter(question).values).toMatchObject({ status: "open", asked: "2026-11-24", ticket: "LIMS-7" });
		expect(isPrompt(summaryOf(question))).toBe(false);
	});

	test("the reply is put in as it is, and a template with no prompt has it after its last line", () => {
		expect(referenceNoteHolding(referenceTemplate({ title: "T" }), "Costs $1 or $& more.")).toBe("# T\n\nCosts $1 or $& more.\n");
		expect(referenceNoteHolding("# T\n\nOur own opening.\n", "The reply.")).toBe("# T\n\nOur own opening.\n\nThe reply.\n");
		expect(questionHolding("# Q\n\n## Why it matters\n\nOur own words.\n\n## Answer\n\nNone yet.\n", "The reply.")).toBe("# Q\n\n## Why it matters\n\nOur own words.\n\nThe reply.\n\n## Answer\n\n");
	});
});

describe("3 (beside it). code saved as a snippet is not left under the template's stand-ins", () => {
	test("the SQL template's prompt and its SELECT 1; are not written above the code", () => {
		const sql = snippetHolding(snippetTemplate({ title: "Samples due today", language: "sql" }), "SELECT SAMPLE_ID\nFROM SAMPLES;");
		// Before: "-- Samples due today\n-- What it is for, ...\n\nSELECT 1;\n\nSELECT SAMPLE_ID ..."
		expect(sql).toBe("-- Samples due today\n\nSELECT SAMPLE_ID\nFROM SAMPLES;\n");
	});

	test("the SSL template's comment closes on the line of its name", () => {
		const ssl = snippetHolding(snippetTemplate({ title: "Find a sample; fast", language: "ssl" }), ":RETURN .T.;");
		expect(ssl).toBe("/* Find a sample, fast;\n\n:RETURN .T.;\n");
		for (const line of ssl.split("\n")) expect(isPrompt(line.replace(/^\s*(?:--|\/\*)?\s*/, ""))).toBe(false);
	});
});

// ---------------------------------------------------------------------------------------------------------------
describe("4. a registry row with a new ticket column is an edit of the text", () => {
	const before = ["job,runs,calls,status,note", '"Nightly","02:00",DueDates.Recalc,done,"ok"', "", "Weekly,Mon,Reports.Run,open", "Hourly,*:00,Sync.Pull,open,first note,legacy extra cell", ""].join("\n");

	test("the column goes on the end of each row's own line: quoting, blank lines and the cells of ragged rows stay", () => {
		const after = registryTextWithRow(before, "docs/registries/jobs.csv", "Monthly", "LIMS-9", true)!;
		// Before: every row was printed again from its cells (the quotes and the blank line gone), the short row's empty
		// ticket cell stood under "note", and the long row's "legacy extra cell" under "ticket".
		expect(after).toBe(
			[
				"job,runs,calls,status,note,ticket",
				'"Nightly","02:00",DueDates.Recalc,done,"ok",',
				"",
				"Weekly,Mon,Reports.Run,open,,",
				"Hourly,*:00,Sync.Pull,open,first note,,legacy extra cell",
				"Monthly,,,found,,LIMS-9",
				"",
			].join("\n"),
		);
		const was = parseCsv(before);
		const now = parseCsv(after);
		const ticket = ticketColumn(now);
		expect(ticket).toBe(5);
		expect(now.rows.map((row) => row[ticket]?.text)).toEqual(["", "", "", "LIMS-9"]);
		// No cell there was has moved to another column.
		for (const [r, row] of was.rows.entries()) for (let c = 0; c < was.header.length; c++) expect(now.rows[r]![c]?.text ?? "").toBe(row[c]?.text ?? "");
		expect(now.rows[2]![6]!.text).toBe("legacy extra cell");
	});

	test("the file's own line ends are kept, and a row alone is added where the column is there already", () => {
		const dos = before.replace(/\n/g, "\r\n");
		const after = registryTextWithRow(dos, "docs/registries/jobs.csv", "Monthly", "LIMS-9", true)!;
		expect(after.replace(/\r\n/g, "")).not.toMatch(/[\r\n]/);
		expect(after.endsWith("Monthly,,,found,,LIMS-9\r\n")).toBe(true);
		const has = 'object,ticket,status\n"a, b",LIMS-1,done\n\nlone';
		// Nothing above the new row changes: not the quoted cell, not the blank line, not the short row.
		expect(registryTextWithRow(has, "docs/registries/database.csv", "c, d", "LIMS-9", true)).toBe(`${has}\n"c, d",LIMS-9,found\n`);
		expect(registryTextWithRow(has, "docs/registries/database.csv", "e", "LIMS-9", false)).toBe(`${has}\ne,LIMS-9,found\n`);
	});

	test("a tab-separated registry is read by its name, and a file with no header row is left", () => {
		const tsv = "job\tLast, First\tstatus\nNightly\tDoe, Jo\tdone\n";
		expect(registryTextWithRow(tsv, "docs/registries/jobs.tsv", "Weekly", "LIMS-9", true)).toBe("job\tLast, First\tstatus\tticket\nNightly\tDoe, Jo\tdone\t\nWeekly\t\tfound\tLIMS-9\n");
		expect(registryTextWithRow("", "docs/registries/jobs.csv", "Weekly", "LIMS-9", true)).toBeNull();
	});
});

// ---------------------------------------------------------------------------------------------------------------
describe("5. a catalog whose end marker is gone loses nothing a person wrote", () => {
	const items = [{ path: "A.md", title: "A", status: "draft" }];
	const broken = "# Specs\n\nIntro.\n\n<!-- catalog -->\n\n- [Old](Old.md): draft.\n\n### Reading order\n\n- [Start here](Old.md) then the rest\n\nProse the person wrote.\n";

	test("every line under the start marker that the new list does not say again is kept, below the new list", () => {
		const after = withCatalog(broken, items);
		// Before: "### Reading order" and "- [Start here](Old.md) then the rest" were taken for the old list and gone.
		expect(after).toBe(
			`# Specs\n\nIntro.\n\n${CATALOG_START}\n\n- [A](A.md): draft.\n\n${CATALOG_END}\n\n- [Old](Old.md): draft.\n\n### Reading order\n\n- [Start here](Old.md) then the rest\n\nProse the person wrote.\n`,
		);
		expect(after.split(CATALOG_START).length).toBe(2);
		expect(catalogStale(after, items)).toBe(false);
		expect(withCatalog(after, items)).toBe(after);
	});

	test("the lines the new list says again are taken up, so an up-to-date list is not written twice", () => {
		const sections = [
			{ path: "a.md", title: "A", section: "Decisions" },
			{ path: "b.md", title: "B", section: "Questions" },
		];
		const upToDate = `# K\n\n${CATALOG_START}\n\n${catalogList(sections)}\n\n### Mine\n\n- [A](a.md)\n`;
		const after = withCatalog(upToDate, sections);
		expect(after).toBe(`# K\n\n${CATALOG_START}\n\n${catalogList(sections)}\n\n${CATALOG_END}\n\n### Mine\n\n- [A](a.md)\n`);
		// The words for an empty list are the list's own, and go when there is something to list.
		expect(withCatalog(`${CATALOG_START}\n\nNothing here yet.\n\nMine.\n`, items)).toBe(`${CATALOG_START}\n\n- [A](A.md): draft.\n\n${CATALOG_END}\n\nMine.\n`);
	});

	test("the file's line ends are kept, and the writer can tell that the end marker is gone", () => {
		const dos = broken.replace(/\n/g, "\r\n");
		const after = withCatalog(dos, items);
		expect(after.replace(/\r\n/g, "")).not.toMatch(/[\r\n]/);
		for (const kept of ["- [Old](Old.md): draft.", "### Reading order", "- [Start here](Old.md) then the rest", "Prose the person wrote."]) expect(after).toContain(kept);
		expect(catalogEndMissing(broken)).toBe(true);
		expect(catalogEndMissing(withCatalog(broken, items))).toBe(false);
		expect(catalogEndMissing("# My own index\n")).toBe(false);
	});

	test("whoever writes the catalog says so (source read: writeCatalog needs the backend and the project's listing)", () => {
		const src = readSrc("../src/view/projectDocs.ts");
		const write = src.slice(src.indexOf("async function writeCatalog("), src.indexOf("export async function catalogsKeptFor"));
		expect(write).toMatch(/if \(before !== null && catalogEndMissing\(before\)\) \{\s*notify\(/);
	});
});

// ---------------------------------------------------------------------------------------------------------------
describe("6a. Unlink finds a path written from the ticket's own folder", () => {
	const spec = "/w/docs/specs/Due-dates.md";
	const ticketPath = "/w/docs/tickets/LIMS-1.md";

	test("a value names the document by the rule that lists it under the ticket", () => {
		// Before: nothing matched, and Unlink said the link was inferred.
		expect(refsNaming(["../specs/Due-dates.md"], spec, ticketPath, "/w")).toEqual(["../specs/Due-dates.md"]);
		const written = ["docs/specs/Due-dates.md", "./docs/specs/due-dates.md", "specs/Due-dates.md", "Due-dates.md", "..\\specs\\Due-dates.md"];
		expect(refsNaming(written, spec, ticketPath, "/w")).toEqual(written);
		// The same name in another folder is another document.
		expect(refsNaming(["../specs/Other.md", "docs/specs/Other.md", "../../other/specs/Due-dates.md", "../Due-dates.md"], spec, ticketPath, "/w")).toEqual([]);
	});

	test("and the value is then taken out of a flow list written on one line", () => {
		const ticket = "---\nticket: LIMS-1\nspecs: [../specs/Due-dates.md, docs/specs/Other.md]\n---\n# LIMS-1\n";
		let next = ticket;
		for (const value of refsNaming(many(frontMatter(ticket).values.specs), spec, ticketPath, "/w")) next = removeFromFrontMatterList(next, "specs", value)!;
		expect(next).toBe("---\nticket: LIMS-1\nspecs: [docs/specs/Other.md]\n---\n# LIMS-1\n");
		const only = "---\nticket: LIMS-1\nspecs: [../specs/Due-dates.md]\n---\n# LIMS-1\n";
		expect(removeFromFrontMatterList(only, "specs", refsNaming(many(frontMatter(only).values.specs), spec, ticketPath, "/w")[0]!)).toBe("---\nticket: LIMS-1\n---\n# LIMS-1\n");
	});
});

// ---------------------------------------------------------------------------------------------------------------
describe("6b. the raw YAML box does not write a line that ends the front matter", () => {
	const write = (doc: string, typed: string) => {
		const span = frontMatterInnerSpan(doc)!;
		return `${doc.slice(0, span.start)}${formatFrontMatterInnerReplacement(typed, span.eol)}${doc.slice(span.end)}`;
	};

	test("three dashes or three dots on a line of their own are found, with their line", () => {
		expect(innerLineEndingFrontMatter("title: x\n---\nstatus: open")).toEqual({ line: 2, text: "---" });
		expect(innerLineEndingFrontMatter("...")).toEqual({ line: 1, text: "..." });
		expect(innerLineEndingFrontMatter("title: x\r\n--- \r\n")).toEqual({ line: 2, text: "---" });
		expect(innerLineEndingFrontMatter("a: 1\nb: 2\n...\t")).toEqual({ line: 3, text: "..." });
		for (const fine of ["", "title: x", " ---", "----", "--- x", "- --", "....", "tags:\n  - a\n  - b", "note: |\n  ---\n  text"]) expect(innerLineEndingFrontMatter(fine)).toBeNull();
	});

	test("what it lets through is read back as typed; what it stops would have gone into the document's text", () => {
		const lines = ["title: x", "", "  ", "tags: [a, b]", "# c", "- item", "key:", "...", "---", "--- ", "... ", " ---", "----", "a: |", "  text", "\t"];
		let seed = 99;
		const pick = () => lines[Math.floor(((seed = (seed * 48271) % 2147483647) / 2147483647) * lines.length)]!;
		let stopped = 0;
		for (const eol of ["\n", "\r\n"]) {
			const doc = `---${eol}title: old${eol}---${eol}${eol}# Body${eol}`;
			for (let i = 0; i < 3000; i++) {
				const typed = Array.from({ length: i % 5 }, pick).join("\n");
				const back = frontMatterInnerSpan(write(doc, typed))?.inner;
				if (innerLineEndingFrontMatter(typed)) {
					stopped++;
					// Written in, the box would have been set back to less than was typed, the rest gone into the body.
					expect(back).not.toBe(typed);
				} else expect(back).toBe(typed);
			}
		}
		expect(stopped).toBeGreaterThan(500);
	});

	test("the box asks before it writes (source read: the box is a textarea over an open editor document; what it is told is run in test/pass4LowsDocs.test.ts)", () => {
		const src = readSrc("../src/view/panels/MarkdownInspector.tsx");
		const step = src.slice(src.indexOf('const stepYamlBox = (boxText: string, event: "input" | "leave" = "input") => {'), src.indexOf("const closeYamlBox = "));
		const asked = step.indexOf("const step = yamlBoxStep(yamlBoxWritten, yamlBoxText, boxText, event);");
		expect(asked).toBeGreaterThan(-1);
		// Written only where the step says so, and only what it says.
		expect(step.slice(asked)).toContain("if (step.write !== null && yamlBoxDoc && writeYamlInner(yamlBoxDoc, step.write, ");
		expect(src.match(/writeYamlInner\(/g)).toHaveLength(2);
		expect(src).toContain("if (step.write !== null && d) writeYamlInner(d, step.write, written);");
	});
});

// ---------------------------------------------------------------------------------------------------------------
describe("6c. a value with a line or paragraph separator in it is written so that it is read again", () => {
	const doc = "---\ntitle: T\nstatus: open\n---\nBody\n";

	test.each([
		["U+2028", "\u2028"],
		["U+2029", "\u2029"],
	])("a scalar with %s", (_name, sep) => {
		const value = `first${sep}second`;
		const written = withFrontMatter(doc, "summary", value)!;
		// Before: `summary: first<sep>second`, bare, and no summary at all on the next read.
		expect(written).toBe(`---\ntitle: T\nstatus: open\nsummary: "first\\u${sep.charCodeAt(0).toString(16)}second"\n---\nBody\n`);
		expect(written).not.toContain(sep);
		expect(frontMatter(written).values).toEqual({ title: "T", status: "open", summary: value });
		expect(quoteYamlScalar(value)).toBe(`"first\\u${sep.charCodeAt(0).toString(16)}second"`);
		// Set a second time it is the same line: nothing drifts.
		expect(withFrontMatter(written, "summary", value)).toBe(written);
	});

	test("a list item with one, in a flow list and as a dash", () => {
		const item = "one\u2028two";
		const flow = addToFrontMatterList(doc, "tags", item)!;
		expect(flow).not.toContain("\u2028");
		expect(frontMatter(flow).values.tags).toEqual([item]);
		expect(removeFromFrontMatterList(flow, "tags", item)).toBe(doc);
		const dashes = addToFrontMatterList("---\ntags:\n  - a\n---\n", "tags", item)!;
		expect(dashes).toBe('---\ntags:\n  - a\n  - "one\\u2028two"\n---\n');
		expect(frontMatter(dashes).values.tags).toEqual(["a", item]);
	});

	test("one left bare in a file, typed or pasted there, is a character of the value and not the end of its line", () => {
		// Before: the key was not read at all.
		expect(frontMatter("---\nsummary: x\u2028y\nstatus: open\n---\n").values).toEqual({ summary: "x\u2028y", status: "open" });
		const dashes = "---\ntags:\n  - a\n  - b\u2029c\n---\n";
		expect(frontMatter(dashes).values.tags).toEqual(["a", "b\u2029c"]);
		expect(removeFromFrontMatterList(dashes, "tags", "b\u2029c")).toBe("---\ntags:\n  - a\n---\n");
		expect(replaceInFrontMatterList(dashes, "tags", "b\u2029c", "z")).toBe("---\ntags:\n  - a\n  - z\n---\n");
	});
});

// ---------------------------------------------------------------------------------------------------------------
describe("7. a built-in template writes the ticket's key as the front-matter writers do", () => {
	const context = (key: string): TemplaterContext => ({
		title: "A title",
		fileName: "A-title.md",
		relativePath: "docs/A-title.md",
		folder: "docs",
		projectName: "Demo",
		ticket: key,
		now: new Date(2026, 10, 24, 9, 0, 0),
		prompt: async (label, initial) => (/ticket key/i.test(label) ? key : (initial ?? "")),
		suggest: async (_labels, values) => values[0] ?? null,
	});
	const withTicket = DEFAULT_TEMPLATES.filter((template) => /^ticket:/m.test(template.content));

	test("every template with a ticket line is covered", () => {
		expect(withTicket.length).toBeGreaterThanOrEqual(10);
		// Not one writes the key bare: each goes through tp.yaml(...).
		for (const template of withTicket) expect(template.content.match(/^ticket: .*$/m)![0]).toMatch(/^ticket: <% tp\.yaml\(.+\) %>$/);
	});

	test.each(["#123", "A: B", "[QA] 7", "- z", "x # y", "@me", "'q", "{a}", "LIMS-7"])("the key %p is read back as it was given, from every template", async (key) => {
		for (const template of withTicket) {
			const rendered = await renderTemplate(template.content, context(key));
			const front = frontMatter(rendered.text);
			// Before, for "#123": `ticket: #123`, read as a comment, and the document had no ticket.
			expect(`${template.id}: ${JSON.stringify(front.values.ticket)}`).toBe(`${template.id}: ${JSON.stringify(key)}`);
			expect(rendered.text.match(/^ticket: .*$/m)![0]).toBe(`ticket: ${quoteYamlScalar(key)}`);
			// Every line of the block is still read: a key that broke the block took the lines after it along.
			const written = rendered.text.split("\n").slice(1, front.lines - 1).flatMap((line) => /^([A-Za-z0-9_-]+):/.exec(line)?.[1]?.toLowerCase() ?? []);
			expect(Object.keys(front.values).sort()).toEqual([...new Set(written)].sort());
		}
	});

	test("a key that needs no quotes is written bare, and no ticket is an empty value", async () => {
		const spec = withTicket.find((template) => template.id === "change-spec")!;
		expect((await renderTemplate(spec.content, context("DEMO-101"))).text).toContain("\nticket: DEMO-101\n");
		const none = await renderTemplate(spec.content, context(""));
		expect(none.text).toContain('\nticket: ""\n');
		expect(frontMatter(none.text).values.ticket).toBe("");
		// The ticket template's heading takes the key as it is: the quotes are for the front matter alone.
		const ticket = await renderTemplate(DEFAULT_TEMPLATES.find((template) => template.id === "ticket")!.content, context("A: B"));
		expect(ticket.text).toContain('\nticket: "A: B"\n');
		expect(ticket.text).toContain("\n# A: B: A title\n");
	});
});

// ---------------------------------------------------------------------------------------------------------------
describe("8. the Docs panel says when a front-matter edit is refused", () => {
	test("the reason is the writer's: a value over several lines, or a block that is never closed", () => {
		const folded = "---\ntitle: T\nstatus: >\n  waiting\n  on QA\n---\n\n# T\n";
		expect(withFrontMatter(folded, "status", "done")).toBeNull();
		expect(frontMatterRefusal(folded, "status")).toBe("its status: is written over several lines. Change it in the text.");
		const prettier = "---\ntags:\n  [\n    a,\n    b,\n  ]\n---\n";
		expect(addToFrontMatterList(prettier, "tags", "c")).toBeNull();
		expect(frontMatterRefusal(prettier, "tags")).toBe("its tags: is written over several lines. Change it in the text.");
		const open = "---\nstatus: open\n\n# Never closed\n";
		expect(withFrontMatter(open, "status", "done")).toBeNull();
		expect(frontMatterRefusal(open, "status")).toBe("its front matter is not closed (no closing ---). Close it in the text.");
	});

	test("a refusal is raised to the caller's own notice, and is not taken for a value already set (source read: the edit needs the backend or an open editor document)", () => {
		const src = readSrc("../src/view/panels/Docs.tsx");
		const edit = src.slice(src.indexOf("async function editDocFrontMatter("), src.indexOf("function gitKindOf("));
		// Before: `if (next === null || next === cur) return false;`, and the selection "already had" the value.
		expect(edit).toContain("if (next === null) throw new Error(frontMatterRefusal(cur, field));");
		expect(edit).not.toContain("next === null || next === cur");
		// Every call names the field it sets, and stands in a try whose catch notifies.
		const calls = [...src.matchAll(/editDocFrontMatter\((?!path: string)[^,]+, ([^,]+),/g)].map((call) => call[1]!.trim());
		expect(calls).toEqual(['"status"', '"status"', '"tags"', '"release"', "field"]);
		expect(src).not.toMatch(/withFrontMatter\([^)]*\) \?\? /);
	});
});

// ---------------------------------------------------------------------------------------------------------------
describe("9. one list of the folders a picture is looked for in", () => {
	const where = { root: "/w", docs: "docs", attachments: "media" };

	test("the order: the configured folder, the document's own, the docs folder's, the project's", () => {
		expect(pictureFolders("/w/docs/tickets/T-1", where)).toEqual([
			"/w/media",
			"/w/docs/tickets/T-1/attachments",
			"/w/docs/tickets/T-1/assets",
			"/w/docs/tickets/T-1/images",
			"/w/docs/attachments",
			"/w/docs/assets",
			"/w/docs/images",
			"/w/assets",
			"/w/images",
		]);
		// A document that is not in the project has no folders of its own.
		expect(pictureFolders(null, { root: "/w" })).toEqual(["/w/docs/attachments", "/w/docs/assets", "/w/docs/images", "/w/assets", "/w/images"]);
		// A configured folder outside the project is not looked in; a docs folder outside it is taken as "docs".
		expect(pictureFolders(null, { root: "/w", docs: "../elsewhere", attachments: "../out" })).toEqual(["/w/docs/attachments", "/w/docs/assets", "/w/docs/images", "/w/assets", "/w/images"]);
		expect(pictureFolders("C:\\w\\docs", { root: "C:\\w", docs: "wiki" }).slice(0, 4)).toEqual(["C:\\w\\docs\\attachments", "C:\\w\\docs\\assets", "C:\\w\\docs\\images", "C:\\w\\wiki\\attachments"]);
	});

	test("a bare name is found by that order: of two folders that hold it, the earlier one's file is meant", () => {
		const holder = "/w/docs/tickets/T-1/T-1.md";
		const folders = pictureFolders("/w/docs/tickets/T-1", where);
		for (let i = 0; i + 1 < folders.length; i++) {
			expect(bareNameTarget("shot.png", holder, [`${folders[i + 1]}/shot.png`, `${folders[i]}/shot.png`], where)).toBe(`${folders[i]}/shot.png`);
		}
		// Beside the document comes before any folder, and the nearest of the name after them all.
		expect(bareNameTarget("shot.png", holder, ["/w/media/shot.png", "/w/docs/tickets/T-1/shot.png"], where)).toBe("/w/docs/tickets/T-1/shot.png");
		expect(bareNameTarget("shot.png", holder, ["/w/far/away/shot.png", "/w/docs/tickets/shot.png"], where)).toBe("/w/docs/tickets/shot.png");
	});

	test("the page reads the same list (source read: resolveImageTarget needs the view's state and the backend's file list)", () => {
		const src = readSrc("../src/view/editor/imageResolve.ts");
		const resolveTarget = src.slice(src.indexOf("export async function resolveImageTarget("), src.indexOf("export async function loadImageUrl("));
		expect(resolveTarget).toContain("const candidateDirs = pictureFolders(docInWorkspace ? docDir : null, { root, docs: state.project?.docs, attachments: state.settings.attachmentsFolder });");
		expect(resolveTarget).not.toContain('"attachments"');
	});
});
