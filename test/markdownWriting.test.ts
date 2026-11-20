// Writing a document as a notebook is written in: what Enter does in a list, and where a link leads when followed.
import { describe, expect, test } from "bun:test";
import { hrefWritten, linkLeads } from "../src/shared/docLinks";
import { listEnter } from "../src/shared/markdownText";

/** Enter at the end of the line. */
const atEnd = (line: string) => listEnter(line, line.length);

describe("Enter after an item's words starts the next item", () => {
	test("with the same sign", () => {
		expect(atEnd("- milk")).toEqual({ start: "- " });
		expect(atEnd("* milk")).toEqual({ start: "* " });
		expect(atEnd("+ milk")).toEqual({ start: "+ " });
	});
	test("with the next number, and the same mark after it", () => {
		expect(atEnd("1. first")).toEqual({ start: "2. " });
		expect(atEnd("9) ninth")).toEqual({ start: "10) " });
	});
	test("with a task's box empty, whatever this one's is", () => {
		expect(atEnd("- [ ] to do")).toEqual({ start: "- [ ] " });
		expect(atEnd("- [x] done")).toEqual({ start: "- [ ] " });
		expect(atEnd("3. [X] done")).toEqual({ start: "4. [ ] " });
	});
	test("set in as this one is, and inside the quote this one is in", () => {
		expect(atEnd("    - nested")).toEqual({ start: "    - " });
		expect(atEnd("\t- nested")).toEqual({ start: "\t- " });
		expect(atEnd("> - quoted")).toEqual({ start: "> - " });
		expect(atEnd("> > 1. deep")).toEqual({ start: "> > 2. " });
	});
	test("with the space after the sign kept as it is", () => {
		expect(atEnd("-   wide")).toEqual({ start: "-   " });
	});
	test("from the middle of its words too: the rest goes to the new item", () => {
		expect(listEnter("- milk and eggs", 6)).toEqual({ start: "- " });
	});
	test("with no box when what looks like one runs into the words: that is no task", () => {
		expect(atEnd("- [x]done")).toEqual({ start: "- " });
	});
});

describe("Enter on an item with no words ends the list", () => {
	test("the line is left empty", () => {
		expect(atEnd("- ")).toEqual({ keep: 0 });
		expect(atEnd("2. ")).toEqual({ keep: 0 });
		expect(atEnd("- [ ] ")).toEqual({ keep: 0 });
		expect(atEnd("- [ ]")).toEqual({ keep: 0 });
		expect(atEnd("    - ")).toEqual({ keep: 0 });
	});
	test("but for the marks of the quote it is in", () => {
		expect(atEnd("> - ")).toEqual({ keep: 2 });
		expect(atEnd(">   - ")).toEqual({ keep: 2 });
		expect(atEnd("> > 1. ")).toEqual({ keep: 4 });
	});
});

describe("Enter is only Enter", () => {
	test("on a line that is no item", () => {
		expect(atEnd("milk")).toBeNull();
		expect(atEnd("")).toBeNull();
		expect(atEnd("-milk")).toBeNull();
		expect(atEnd("1.5 litres")).toBeNull();
		expect(atEnd("# - heading")).toBeNull();
		expect(atEnd("**bold** words")).toBeNull();
	});
	test("on a rule drawn across the page", () => {
		expect(atEnd("---")).toBeNull();
		expect(atEnd("- - -")).toBeNull();
		expect(atEnd("* * *")).toBeNull();
		expect(atEnd("***")).toBeNull();
	});
	test("with the cursor before or in the item's sign", () => {
		expect(listEnter("- milk", 0)).toBeNull();
		expect(listEnter("- milk", 1)).toBeNull();
		expect(listEnter("- [ ] to do", 4)).toBeNull();
		expect(listEnter("    - nested", 2)).toBeNull();
	});
});

describe("where a link leads", () => {
	const root = "/work/project";
	const from = "/work/project/docs/tickets/DEMO-1.md";
	test("to the web, as written", () => {
		expect(linkLeads("https://example.com/a?b#c", from, root)).toEqual({ web: "https://example.com/a?b#c" });
		expect(linkLeads("HTTP://example.com", from, root)).toEqual({ web: "HTTP://example.com" });
	});
	test("to a heading of its own document", () => {
		expect(linkLeads("#what-is-here", from, root)).toEqual({ heading: "what-is-here" });
		expect(linkLeads("#caf%C3%A9", from, root)).toEqual({ heading: "café" });
		expect(linkLeads("#100%", from, root)).toEqual({ heading: "100%" });
	});
	test("to a file, from the document's own folder", () => {
		expect(linkLeads("DEMO-2.md", from, root)).toEqual({ file: "/work/project/docs/tickets/DEMO-2.md" });
		expect(linkLeads("../specs/late%20samples.md", from, root)).toEqual({ file: "/work/project/docs/specs/late samples.md" });
	});
	test("to a file, from the project's top when the path starts there", () => {
		expect(linkLeads("/src/Due/Rules.ssl", from, root)).toEqual({ file: "/work/project/src/Due/Rules.ssl" });
	});
	test("to lines of a file", () => {
		expect(linkLeads("../../src/Rules.ssl#L12", from, root)).toEqual({ file: "/work/project/src/Rules.ssl", lines: { line: 12 } });
		expect(linkLeads("../../src/Rules.ssl#L12-L18", from, root)).toEqual({ file: "/work/project/src/Rules.ssl", lines: { line: 12, endLine: 18 } });
	});
	test("nowhere, when it leaves the project or names no file", () => {
		expect(linkLeads("../../../elsewhere/notes.md", from, root)).toBeNull();
		expect(linkLeads("mailto:someone@example.com", from, root)).toBeNull();
		expect(linkLeads("//host/share/file.md", from, root)).toBeNull();
		expect(linkLeads("", from, root)).toBeNull();
		expect(linkLeads("DEMO-2.md", from, null)).toBeNull();
	});
});

describe("a link's address, from how it is written", () => {
	test("is itself when written plainly", () => {
		expect(hrefWritten("guide.md")).toBe("guide.md");
		expect(hrefWritten("  ../a/b.md#L3  ")).toBe("../a/b.md#L3");
	});
	test("is what angle brackets hold, a space and all", () => {
		expect(hrefWritten("<my file.md>")).toBe("my file.md");
		expect(linkLeads(hrefWritten("<my file.md>"), "/work/project/docs/a.md", "/work/project")).toEqual({ file: "/work/project/docs/my file.md" });
	});
	test("has a mark of punctuation after a backslash as the mark alone", () => {
		expect(hrefWritten("b\\(1\\).md")).toBe("b(1).md");
		expect(hrefWritten("a\\_b.md")).toBe("a_b.md");
	});
	test("keeps a backslash that is before a letter", () => {
		expect(hrefWritten("docs\\file.md")).toBe("docs\\file.md");
	});
});
