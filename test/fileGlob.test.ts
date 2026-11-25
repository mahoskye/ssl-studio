import { describe, expect, test } from "bun:test";
import { fileChosen, globMatcher, patternsOf } from "../src/shared/fileGlob";

describe("a list of patterns", () => {
	test("is split at its commas, blanks dropped", () => {
		expect(patternsOf("*.ssl, *.md ,, tests")).toEqual(["*.ssl", "*.md", "tests"]);
		expect(patternsOf("")).toEqual([]);
		expect(patternsOf("  ")).toEqual([]);
	});

	test("a comma inside braces is part of the pattern", () => {
		expect(patternsOf("docs/{specs,tickets}, *.md")).toEqual(["docs/{specs,tickets}", "*.md"]);
	});
});

describe("a name with no slash", () => {
	test("is a file of that kind wherever it is", () => {
		const ssl = globMatcher("*.ssl");
		expect(ssl("a.ssl")).toBe(true);
		expect(ssl("src/DueDates/DueRules.ssl")).toBe(true);
		expect(ssl("src/DueDates/Holidays.ds")).toBe(false);
		expect(ssl("notes.ssl.md")).toBe(false);
	});

	test("is a folder of that name wherever it is, with all that is in it", () => {
		const legacy = globMatcher("Legacy");
		expect(legacy("src/Legacy/Old.ssl")).toBe(true);
		expect(legacy("Legacy/deep/er/Old.ssl")).toBe(true);
		expect(legacy("src/LegacyNotes/Old.ssl")).toBe(false);
	});

	test("does not tell case apart", () => {
		expect(globMatcher("*.SSL")("src/a.ssl")).toBe(true);
		expect(globMatcher("legacy")("src/Legacy/a.ssl")).toBe(true);
	});

	test("a question mark is one character", () => {
		expect(globMatcher("DEMO-10?.md")("docs/tickets/DEMO-101.md")).toBe(true);
		expect(globMatcher("DEMO-10?.md")("docs/tickets/DEMO-1011.md")).toBe(false);
	});
});

describe("a path with a slash", () => {
	test("is read from the workspace's folder: itself and what is in it", () => {
		const due = globMatcher("src/DueDates");
		expect(due("src/DueDates/DueRules.ssl")).toBe(true);
		expect(due("src/DueDates/deep/x.ssl")).toBe(true);
		expect(due("tests/src/DueDates/x.ssl")).toBe(false);
		expect(due("src/DueDatesOld/x.ssl")).toBe(false);
	});

	test("a star stays inside one folder, two stars go through any", () => {
		expect(globMatcher("src/*.md")("src/README.md")).toBe(true);
		expect(globMatcher("src/*.md")("src/deep/README.md")).toBe(false);
		expect(globMatcher("src/**/*.md")("src/deep/er/README.md")).toBe(true);
		expect(globMatcher("src/**/*.md")("src/README.md")).toBe(true);
		expect(globMatcher("**/tests/**")("a/tests/b.ssl")).toBe(true);
		expect(globMatcher("**/tests/**")("tests/b.ssl")).toBe(true);
	});

	test("braces are either of what is in them", () => {
		const docs = globMatcher("docs/{specs,tickets}/*.md");
		expect(docs("docs/specs/a.md")).toBe(true);
		expect(docs("docs/tickets/b.md")).toBe(true);
		expect(docs("docs/knowledge/c.md")).toBe(false);
		expect(globMatcher("*.{ssl,ds}")("src/a.ds")).toBe(true);
	});

	test("a slash at either end, a dot before it, and the other kind of slash are all the same path", () => {
		expect(globMatcher("./src/DueDates/")("src/DueDates/a.ssl")).toBe(true);
		expect(globMatcher("/src")("src/a.ssl")).toBe(true);
		expect(globMatcher("src\\DueDates")("src/DueDates/a.ssl")).toBe(true);
		expect(globMatcher("src/DueDates")("src\\DueDates\\a.ssl")).toBe(true);
	});

	test("marks that mean something to an expression are only themselves", () => {
		expect(globMatcher("a+b (1).ssl")("x/a+b (1).ssl")).toBe(true);
		expect(globMatcher("a.ssl")("x/abssl")).toBe(false);
		expect(globMatcher("src/[old]")("src/[old]/a.ssl")).toBe(true);
	});
});

describe("which files a search looks in", () => {
	test("every file, with nothing said", () => {
		expect(fileChosen("src/a.ssl")).toBe(true);
		expect(fileChosen("src/a.ssl", "", "")).toBe(true);
		expect(fileChosen("src/a.ssl", " , ", " ")).toBe(true);
	});

	test("only the included, when any are named", () => {
		expect(fileChosen("src/a.ssl", "*.ssl")).toBe(true);
		expect(fileChosen("src/a.md", "*.ssl")).toBe(false);
		expect(fileChosen("src/a.md", "*.ssl, *.md")).toBe(true);
	});

	test("never the excluded, and they win over the included", () => {
		expect(fileChosen("tests/a.ssl", "", "tests")).toBe(false);
		expect(fileChosen("tests/a.ssl", "*.ssl", "tests")).toBe(false);
		expect(fileChosen("src/a.ssl", "*.ssl", "tests")).toBe(true);
	});
});
