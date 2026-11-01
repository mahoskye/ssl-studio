import { expect, test } from "bun:test";
import { baseName, dirName, isInside, joinPath, relativeTo } from "../src/shared/paths";

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
