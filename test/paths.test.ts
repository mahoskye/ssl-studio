import { describe, expect, test } from "bun:test";
import { baseName, dirName, isInside, joinPath, plainFileError, relativeTo, resolvePath } from "../src/shared/paths";

test("POSIX paths", () => {
	expect(baseName("/w/Sample/Orders.ssl")).toBe("Orders.ssl");
	expect(dirName("/w/Sample/Orders.ssl")).toBe("/w/Sample");
	expect(isInside("/w", "/w/Sample/Orders.ssl")).toBe(true);
	expect(isInside("/w", "/w2/x")).toBe(false);
	expect(isInside("/W", "/w/x")).toBe(false);
	expect(relativeTo("/w", "/w/Sample/Orders.ssl")).toBe("Sample/Orders.ssl");
	expect(joinPath("/w/", "design", "x.md")).toBe("/w/design/x.md");
});

test("Windows paths from different sources", () => {
	const root = "C:\\Work\\Scripts";
	const fromMonaco = "c:\\Work\\Scripts\\Sample\\Orders.ssl";
	expect(baseName(fromMonaco)).toBe("Orders.ssl");
	expect(dirName(fromMonaco)).toBe("c:\\Work\\Scripts\\Sample");
	expect(isInside(root, fromMonaco)).toBe(true);
	expect(isInside(root, "c:/work/scripts/x.ssl")).toBe(true);
	expect(isInside(root, "C:\\Work\\ScriptsOld\\x.ssl")).toBe(false);
	expect(relativeTo(root, fromMonaco)).toBe("Sample/Orders.ssl");
	expect(joinPath(root, "design", "x.md")).toBe("C:\\Work\\Scripts\\design\\x.md");
	expect(dirName("C:\\x.ssl")).toBe("C:\\");
});

test("resolvePath applies . and .. with the folder's own separator", () => {
	expect(resolvePath("/w/docs", "../README.md")).toBe("/w/README.md");
	expect(resolvePath("/w/docs/", "./adr/0001.md")).toBe("/w/docs/adr/0001.md");
	expect(resolvePath("C:\\w\\docs", "..\\AGENTS.md")).toBe("C:\\w\\AGENTS.md");
	expect(resolvePath("C:\\w", "docs/a.md")).toBe("C:\\w\\docs\\a.md");
});

describe("what the file system said, in plain words", () => {
	test("a file that is not there is named as the project names it", () => {
		expect(plainFileError("ENOENT: no such file or directory, open '/work/demo/docs/specs/Notes.md'", "/work/demo")).toBe("docs/specs/Notes.md is not there.");
		expect(plainFileError("ENOENT: no such file or directory, open 'C:\\work\\demo\\docs\\Notes.md'", "C:\\work\\demo")).toBe("docs/Notes.md is not there.");
	});
	test("outside the project, or with no project, the whole path is said", () => {
		expect(plainFileError("ENOENT: no such file or directory, open '/elsewhere/Notes.md'", "/work/demo")).toBe("/elsewhere/Notes.md is not there.");
		expect(plainFileError("ENOENT: no such file or directory, open '/elsewhere/Notes.md'")).toBe("/elsewhere/Notes.md is not there.");
	});
	test("a folder and a refusal are said as what they are", () => {
		expect(plainFileError("EISDIR: illegal operation on a directory, read '/work/demo/docs'", "/work/demo")).toBe("docs is a folder, not a file.");
		expect(plainFileError("EACCES: permission denied, open '/work/demo/locked.md'", "/work/demo")).toBe("locked.md cannot be opened: permission was refused.");
	});
	test("a path with an apostrophe is said whole", () => {
		expect(plainFileError("ENOENT: no such file or directory, open '/home/x/Ben's project/docs/a.md'", "/home/x/Ben's project")).toBe("docs/a.md is not there.");
	});
	test("a message that says more than that sentence is left as it was said", () => {
		for (const said of [
			"The server said ENOENT and couldn't read 'x'",
			"The picture was not saved: EACCES: permission denied, open '/work/demo/a.png'",
			"ENOENT: no such file or directory, rename '/r/a.md' -> '/r/nofolder/a.md'",
			"EACCES: permission denied, mkdir '/work/demo/new'",
			"ENOENT: no such file or directory, unlink '/work/demo/a.md'",
			"ENOENT: no such file or directory, open '/work/demo/a.md'\n    at open (node:fs)",
		])
			expect(plainFileError(said, "/work/demo")).toBe(said);
	});
	test("anything else is left as it was said", () => {
		expect(plainFileError("The language server stopped.", "/work/demo")).toBe("The language server stopped.");
	});
});
