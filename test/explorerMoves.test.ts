import { describe, expect, test } from "bun:test";
import { copyName, copyProblem, folderOf, moveProblem } from "../src/view/panels/explorerMoves";

const none = () => false;
const taken = (...names: string[]) => (name: string) => names.includes(name);

describe("the name of a copy", () => {
	test("says it is a copy, before what the file is", () => {
		expect(copyName("DueRules.ssl", none)).toBe("DueRules copy.ssl");
		expect(copyName("Notes", none)).toBe("Notes copy");
	});

	test("counts on when the name is taken", () => {
		expect(copyName("DueRules.ssl", taken("DueRules copy.ssl"))).toBe("DueRules copy 2.ssl");
		expect(copyName("DueRules.ssl", taken("DueRules copy.ssl", "DueRules copy 2.ssl"))).toBe("DueRules copy 3.ssl");
	});

	test("keeps what a file is whole when that is two words", () => {
		expect(copyName("SetDates.plan.json", none)).toBe("SetDates copy.plan.json");
		expect(copyName("DueDates.spec.md", none)).toBe("DueDates copy.spec.md");
	});

	test("a name that begins with a dot keeps it", () => {
		expect(copyName(".env", none)).toBe(".env copy");
		expect(copyName(".editorconfig.bak", none)).toBe(".editorconfig copy.bak");
	});
});

describe("where a paste or a drop goes", () => {
	test("into a folder, or beside a file", () => {
		expect(folderOf({ path: "/w/src", kind: "dir" })).toBe("/w/src");
		expect(folderOf({ path: "/w/src/a.ssl", kind: "file" })).toBe("/w/src");
	});
});

describe("what is refused", () => {
	test("a move to where it already is", () => {
		expect(moveProblem("/w/src/a.ssl", "/w/src", "/w")).toBe("a.ssl is already in src.");
		expect(moveProblem("/w/src/a.ssl", "/w/tests", "/w")).toBe("");
		expect(moveProblem("/w/src/a.ssl", "/w", "/w")).toBe("");
	});

	test("a folder into itself, or into a folder inside it", () => {
		expect(moveProblem("/w/src", "/w/src", "/w")).toBe("src cannot be moved into itself.");
		expect(moveProblem("/w/src", "/w/src/deep/er", "/w")).toBe("src cannot be moved into itself.");
		expect(copyProblem("/w/src", "/w/src/deep", "/w")).toBe("src cannot be copied into itself.");
		// A folder whose name only begins the same is another folder.
		expect(moveProblem("/w/src", "/w/src2", "/w")).toBe("");
	});

	test("the workspace folder, and anything that holds it", () => {
		expect(moveProblem("/w", "/w/src", "/w")).toContain("workspace folder");
		expect(copyProblem("/", "/w/src", "/w")).toContain("workspace folder");
	});

	test("a folder outside the workspace", () => {
		expect(moveProblem("/w/a.ssl", "/elsewhere", "/w")).toBe("That folder is outside the workspace.");
		expect(copyProblem("/w/a.ssl", "/elsewhere", "/w")).toBe("That folder is outside the workspace.");
	});

	test("a copy beside the original is allowed: it gets another name", () => {
		expect(copyProblem("/w/src/a.ssl", "/w/src", "/w")).toBe("");
	});
});
