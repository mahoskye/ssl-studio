import { expect, test } from "bun:test";
import { moveIndex, restoreIndex, ringStep, stopIndex, treeStep, typeAhead, isMoveKey, type TreeRow } from "../src/view/panels/rowMoves";
import { COPY, COPY_PATH, COPY_RELATIVE, CUT, folderFor, holdsRoot, menuFor, nameProblem, NEW_FILE, NEW_FOLDER, PASTE, RENAME, retarget, TRASH, without } from "../src/view/panels/explorerMenu";
import { byLine, segments } from "../src/view/panels/searchLines";
import { snippetAsText, TEMPLATES } from "../src/shared/houseStyle";
import { patternsFrom } from "../src/view/plan/build";

// --- rows: the keyboard in a list ---------------------------------------------

test("Up and Down move one row and stop at the ends of a list", () => {
	expect(moveIndex(5, 2, "ArrowDown")).toBe(3);
	expect(moveIndex(5, 2, "ArrowUp")).toBe(1);
	expect(moveIndex(5, 4, "ArrowDown")).toBe(4);
	expect(moveIndex(5, 0, "ArrowUp")).toBe(0);
});

test("Home, End and the page keys", () => {
	expect(moveIndex(50, 20, "Home")).toBe(0);
	expect(moveIndex(50, 20, "End")).toBe(49);
	expect(moveIndex(50, 20, "PageDown", { page: 12 })).toBe(32);
	expect(moveIndex(50, 5, "PageUp", { page: 12 })).toBe(0);
	expect(moveIndex(50, 45, "PageDown", { page: 12 })).toBe(49);
	// A page is never less than a row, whatever the list measured.
	expect(moveIndex(50, 20, "PageDown", { page: 0 })).toBe(21);
});

test("with no row focused yet, Down starts at the top and Up at the bottom", () => {
	expect(moveIndex(5, -1, "ArrowDown")).toBe(0);
	expect(moveIndex(5, -1, "ArrowUp")).toBe(4);
	expect(moveIndex(5, 9, "ArrowDown")).toBe(0);
});

test("an empty list has no row to move to", () => {
	expect(moveIndex(0, -1, "ArrowDown")).toBe(-1);
	expect(moveIndex(0, 0, "End")).toBe(-1);
});

test("a menu goes round, a list does not", () => {
	expect(moveIndex(3, 2, "ArrowDown", { wrap: true })).toBe(0);
	expect(moveIndex(3, 0, "ArrowUp", { wrap: true })).toBe(2);
	expect(moveIndex(3, 1, "ArrowDown", { wrap: true })).toBe(2);
	expect(moveIndex(3, 2, "ArrowDown")).toBe(2);
});

test("only movement keys are movement keys", () => {
	expect(isMoveKey("ArrowDown")).toBe(true);
	expect(isMoveKey("PageUp")).toBe(true);
	expect(isMoveKey("ArrowLeft")).toBe(false);
	expect(isMoveKey("Enter")).toBe(false);
});

// A folder (open) with a file and a closed folder in it, then a file beside it.
const TREE: TreeRow[] = [
	{ level: 1, expanded: true },
	{ level: 2 },
	{ level: 2, expanded: false },
	{ level: 1 },
];

test("Right opens a closed row, then steps into an open one", () => {
	expect(treeStep(TREE, 2, "ArrowRight")).toEqual({ toggle: true, index: 2 });
	expect(treeStep(TREE, 0, "ArrowRight")).toEqual({ toggle: false, index: 1 });
	// A leaf has nowhere to go.
	expect(treeStep(TREE, 1, "ArrowRight")).toEqual({ toggle: false, index: 1 });
	expect(treeStep(TREE, 3, "ArrowRight")).toEqual({ toggle: false, index: 3 });
});

test("Left closes an open row, then steps out to the parent", () => {
	expect(treeStep(TREE, 0, "ArrowLeft")).toEqual({ toggle: true, index: 0 });
	expect(treeStep(TREE, 1, "ArrowLeft")).toEqual({ toggle: false, index: 0 });
	expect(treeStep(TREE, 2, "ArrowLeft")).toEqual({ toggle: false, index: 0 });
	// A top-level leaf has no parent.
	expect(treeStep(TREE, 3, "ArrowLeft")).toEqual({ toggle: false, index: 3 });
	expect(treeStep(TREE, 9, "ArrowLeft")).toEqual({ toggle: false, index: 9 });
});

test("an open row with nothing listed under it stays put on Right", () => {
	expect(treeStep([{ level: 1, expanded: true }, { level: 1 }], 0, "ArrowRight")).toEqual({ toggle: false, index: 0 });
});

test("typed letters jump to the next row that starts with them", () => {
	const labels = ["Availability.ssl", "DueRule.ssl", "docs", "RushDueRule.ssl", "  design"];
	expect(typeAhead(labels, 0, "d")).toBe(1);
	// The same letter again steps on, and goes round.
	expect(typeAhead(labels, 1, "d")).toBe(2);
	expect(typeAhead(labels, 2, "dd")).toBe(4);
	expect(typeAhead(labels, 4, "d")).toBe(1);
	// More letters narrow it, starting from the row the keyboard is on.
	expect(typeAhead(labels, 1, "do")).toBe(2);
	expect(typeAhead(labels, 0, "RU")).toBe(3);
	expect(typeAhead(labels, 0, "x")).toBe(-1);
	expect(typeAhead([], 0, "a")).toBe(-1);
	expect(typeAhead(labels, 0, "")).toBe(-1);
});

test("the Tab stop is the row that had it, else the selected row, else the first", () => {
	const rows = [
		{ key: "a", selected: false },
		{ key: "b", selected: true },
		{ key: "c", selected: false },
	];
	expect(stopIndex(rows, "c")).toBe(2);
	expect(stopIndex(rows, "gone")).toBe(1);
	expect(stopIndex(rows, null)).toBe(1);
	expect(stopIndex([{ key: "a", selected: false }], null)).toBe(0);
	expect(stopIndex([], "a")).toBe(-1);
});

test("focus follows a redrawn row by its key, else takes the row now in its place", () => {
	expect(restoreIndex(["a", "b", "c"], "c", 0)).toBe(2);
	// The row is gone: the one that moved up into its place.
	expect(restoreIndex(["a", "c"], "b", 1)).toBe(1);
	// It was the last: the new last.
	expect(restoreIndex(["a", "b"], "c", 2)).toBe(1);
	expect(restoreIndex(["a", "b"], "", 0)).toBe(0);
	expect(restoreIndex([], "a", 0)).toBe(-1);
});

test("a ring steps both ways and takes a stranger in at its ends", () => {
	expect(ringStep(0, 1, 8)).toBe(1);
	expect(ringStep(7, 1, 8)).toBe(0);
	expect(ringStep(0, -1, 8)).toBe(7);
	expect(ringStep(3, -1, 8)).toBe(2);
	// A colour that is not in the palette: forward to the first, back to the last.
	expect(ringStep(-1, 1, 8)).toBe(0);
	expect(ringStep(-1, -1, 8)).toBe(7);
	expect(ringStep(0, 1, 0)).toBe(-1);
	// Back and forward undo each other.
	for (let i = 0; i < 8; i++) expect(ringStep(ringStep(i, 1, 8), -1, 8)).toBe(i);
});

// --- the Explorer's menu ---------------------------------------------------------

test("the workspace folder is offered what adds to it and its path, never a rename or the trash", () => {
	expect(menuFor("dir", "/w", "/w")).toEqual([NEW_FILE, NEW_FOLDER, COPY_PATH]);
	expect(menuFor("dir", "/w/", "/w")).toEqual([NEW_FILE, NEW_FOLDER, COPY_PATH]);
	// Nor a folder that holds the workspace.
	expect(menuFor("dir", "/", "/w")).not.toContain(TRASH);
	expect(menuFor("dir", "C:\\Work", "c:/work")).toEqual([NEW_FILE, NEW_FOLDER, COPY_PATH]);
});

test("a folder and a file get their menus, with one wording for the trash", () => {
	expect(menuFor("dir", "/w/Sample", "/w")).toEqual([NEW_FILE, NEW_FOLDER, CUT, COPY, COPY_PATH, COPY_RELATIVE, RENAME, TRASH]);
	expect(menuFor("file", "/w/Sample/Orders.ssl", "/w")).toEqual([CUT, COPY, COPY_PATH, COPY_RELATIVE, RENAME, TRASH]);
	expect(TRASH).toBe("Move to trash");
	for (const kind of ["file", "dir"] as const) expect(menuFor(kind, "/w/x", "/w")).not.toContain("Delete");
});

test("paste is offered once something was cut or copied, and into the workspace folder too", () => {
	expect(menuFor("file", "/w/a.ssl", "/w")).not.toContain(PASTE);
	expect(menuFor("file", "/w/a.ssl", "/w", true)).toEqual([CUT, COPY, PASTE, COPY_PATH, COPY_RELATIVE, RENAME, TRASH]);
	expect(menuFor("dir", "/w/Sample", "/w", true)).toEqual([NEW_FILE, NEW_FOLDER, CUT, COPY, PASTE, COPY_PATH, COPY_RELATIVE, RENAME, TRASH]);
	expect(menuFor("dir", "/w", "/w", true)).toEqual([NEW_FILE, NEW_FOLDER, PASTE, COPY_PATH]);
	// The workspace folder itself is never cut or copied.
	expect(menuFor("dir", "/w", "/w", true)).not.toContain(CUT);
	expect(menuFor("dir", "/w", "/w", true)).not.toContain(COPY);
});

test("the workspace folder is refused, and what is in it is not", () => {
	expect(holdsRoot("/w", "/w")).toBe(true);
	expect(holdsRoot("/w", "/")).toBe(true);
	expect(holdsRoot("/w", "/w/x")).toBe(false);
	expect(holdsRoot("/w", "/w2")).toBe(false);
	expect(holdsRoot("/home/me/w", "/home/me")).toBe(true);
});

test("a name must be a name", () => {
	expect(nameProblem("Orders.ssl")).toBe("");
	expect(nameProblem("sub/Orders.ssl")).toBe("");
	expect(nameProblem("  ")).not.toBe("");
	expect(nameProblem("..")).not.toBe("");
	expect(nameProblem("../outside.ssl")).not.toBe("");
	expect(nameProblem("a//b")).not.toBe("");
});

test("a new file goes beside the focused row, inside it when it is a folder, else beside the active file", () => {
	expect(folderFor({ path: "/w/Sample", kind: "dir" }, "/w/other/x.ssl", "/w")).toBe("/w/Sample");
	expect(folderFor({ path: "/w/Sample/Orders.ssl", kind: "file" }, "/w/other/x.ssl", "/w")).toBe("/w/Sample");
	expect(folderFor(null, "/w/other/x.ssl", "/w")).toBe("/w/other");
	expect(folderFor(null, null, "/w")).toBe("/w");
	// A file open from outside the workspace does not take new files with it.
	expect(folderFor(null, "/elsewhere/x.ssl", "/w")).toBe("/w");
});

test("open folders follow a rename and go with the trash", () => {
	const open = ["/w/Sample", "/w/Sample/Deep", "/w/SampleOther", "/w/docs"];
	expect(retarget(open, "/w/Sample", "/w/Lab")).toEqual(["/w/Lab", "/w/Lab/Deep", "/w/SampleOther", "/w/docs"]);
	expect(without(open, "/w/Sample")).toEqual(["/w/SampleOther", "/w/docs"]);
});

// --- search results ----------------------------------------------------------------

const hit = (line: number, column: number, length: number, text: string, path = "/w/a.ssl") => ({ path, line, column, length, text });

test("a line with two matches is one row with both matches", () => {
	const text = "\tnTotal := nTotal + 1;";
	const lines = byLine([hit(4, 12, 6, text), hit(4, 2, 6, text), hit(9, 1, 6, "nTotal"), hit(4, 2, 6, text, "/w/b.ssl")]);
	expect(lines.map((l) => [l.path, l.line, l.matches.length])).toEqual([
		["/w/a.ssl", 4, 2],
		["/w/a.ssl", 9, 1],
		["/w/b.ssl", 4, 1],
	]);
	// Left to right, whatever order they came in.
	expect(lines[0]!.matches.map((m) => m.column)).toEqual([2, 12]);
});

test("every match on the line is marked, and nothing of the line is lost between them", () => {
	const text = "\tnTotal := nTotal + 1;";
	const [line] = byLine([hit(4, 2, 6, text), hit(4, 12, 6, text)]);
	const parts = segments(line!);
	expect(parts).toEqual([
		{ text: "nTotal", match: true },
		{ text: " := ", match: false },
		{ text: "nTotal", match: true },
		{ text: " + 1;", match: false },
	]);
	expect(parts.map((p) => p.text).join("")).toBe(text.trim());
});

test("a long line is cut around its matches, and says so", () => {
	const text = `${"x".repeat(100)}NEEDLE${"y".repeat(200)}`;
	const parts = segments(byLine([hit(1, 101, 6, text)])[0]!);
	expect(parts[0]).toEqual({ text: `…${"x".repeat(30)}`, match: false });
	expect(parts[1]).toEqual({ text: "NEEDLE", match: true });
	expect(parts[2]!.text).toBe("y".repeat(80));
	// Cut right at a match: the mark still says text came before.
	expect(segments({ path: "p", line: 1, text, matches: [{ column: 101, length: 6 }] }, 0)[0]).toEqual({ text: "…", match: false });
});

test("matches that overlap are marked once", () => {
	const parts = segments({ path: "p", line: 1, text: "aaaa", matches: [{ column: 1, length: 3 }, { column: 2, length: 3 }] });
	expect(parts).toEqual([
		{ text: "aaa", match: true },
		{ text: "a", match: false },
	]);
});

// --- the palette's templates -------------------------------------------------------

test("the palette has a class and a data source, in the house forms", () => {
	const body = (id: string) => snippetAsText(TEMPLATES.find((t) => t.id === id)!.body());
	const cls = body("class");
	expect(cls).toContain(":CLASS Name;");
	expect(cls).toContain(":DECLARE sField;");
	expect(cls).toContain(":PROCEDURE Constructor;\n\t:PARAMETERS sField;");
	expect(cls).toContain("Me:sField := sField;");
	// The constructor is the last thing in the file, and a class has no closing keyword.
	expect(cls.trimEnd().endsWith(":ENDPROC;")).toBe(true);
	const ds = body("datasource");
	// A data source gives each parameter its default on the :PARAMETERS line, and names it ?so? in the SQL.
	expect(ds).toContain(':PARAMETERS sId := "";');
	expect(ds).toContain("WHERE ID = ?sId?");
	expect(ds).toContain("/* DATA SOURCE: Name (SSL);");
	expect(ds).not.toContain(":DEFAULT");
});

test("no tab stop is left in a template dropped as plain text", () => {
	for (const t of TEMPLATES) expect(snippetAsText(t.body())).not.toMatch(/\$\{?\d/);
	expect(snippetAsText("${1:vResult} := DoProc(\"${2:Procedure}\", {${3}});$0")).toBe('vResult := DoProc("Procedure", {});');
});

test("every statement and comment line of the new templates ends its statement", () => {
	for (const id of ["class", "datasource"]) {
		const text = snippetAsText(TEMPLATES.find((t) => t.id === id)!.body());
		// SSL comments end at the first semicolon: none may be left open at the end of the file.
		expect(text.trimEnd().endsWith(";")).toBe(true);
	}
});

test("a template says what it is in plain words; the decision number is kept for the tooltip", () => {
	for (const t of TEMPLATES) expect(`${t.label} ${t.detail}`).not.toMatch(/decision/i);
	expect(TEMPLATES.find((t) => t.id === "banner")!.detail).toBe("House file banner");
	expect(TEMPLATES.find((t) => t.id === "banner")!.note).toMatch(/decision 0005/);
	expect(new Set(TEMPLATES.map((t) => t.id)).size).toBe(TEMPLATES.length);
});

test("the file templates do not join the patterns given to a model", () => {
	const patterns = patternsFrom(TEMPLATES);
	expect(patterns).not.toContain(":CLASS");
	expect(patterns).not.toContain("DATA SOURCE");
});

import { openFolders } from "../src/view/panels/explorerMenu";

test("the Explorer's open folders are read with suspicion", () => {
	expect(openFolders(JSON.stringify(["/w/src", "/w/src/DueDates", "/elsewhere", 7]), "/w")).toEqual(["/w/src", "/w/src/DueDates"]);
	expect(openFolders(null, "/w")).toEqual([]);
	expect(openFolders("not json", "/w")).toEqual([]);
	expect(openFolders('{"a":1}', "/w")).toEqual([]);
});
