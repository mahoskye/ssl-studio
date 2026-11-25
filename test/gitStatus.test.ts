import { describe, expect, test } from "bun:test";
import { branchLabel, changeLetter, commitProblem, GIT_ACTIONS, parseStatus, rowActions, stagedOf, unstagedOf } from "../src/shared/gitStatus";
import { lineChanges } from "../src/shared/lineDiff";

const said = (...entries: string[]) => entries.join("\0") + "\0";
const H = "0000000000000000000000000000000000000000";

describe("what git says of the branch", () => {
	test("its name, the branch it follows and how far apart they are", () => {
		const status = parseStatus(said("# branch.oid 1234567890abcdef", "# branch.head main", "# branch.upstream origin/main", "# branch.ab +2 -1"));
		expect(status).toMatchObject({ branch: "main", detached: false, initial: false, upstream: "origin/main", ahead: 2, behind: 1, files: [] });
		expect(branchLabel(status)).toBe("main ↑2 ↓1");
	});

	test("a branch that follows nothing is just its name", () => {
		expect(branchLabel(parseStatus(said("# branch.oid abc", "# branch.head work")))).toBe("work");
	});

	test("a commit checked out by itself is named by the start of its id", () => {
		const status = parseStatus(said("# branch.oid 1234567890abcdef", "# branch.head (detached)"));
		expect(status.detached).toBe(true);
		expect(status.branch).toBe("1234567");
	});

	test("a repository with no commit yet says so", () => {
		expect(parseStatus(said("# branch.oid (initial)", "# branch.head main")).initial).toBe(true);
	});
});

describe("what git says of the files", () => {
	test("a file changed and not staged, one staged, one both", () => {
		const status = parseStatus(said("# branch.head main", `1 .M N... 100644 100644 100644 ${H} ${H} src/a.ssl`, `1 M. N... 100644 100644 100644 ${H} ${H} src/b.ssl`, `1 MM N... 100644 100644 100644 ${H} ${H} src/c.ssl`));
		expect(status.files).toEqual([
			{ path: "src/a.ssl", staged: null, unstaged: "modified" },
			{ path: "src/b.ssl", staged: "modified", unstaged: null },
			{ path: "src/c.ssl", staged: "modified", unstaged: "modified" },
		]);
		expect(stagedOf(status).map((file) => file.path)).toEqual(["src/b.ssl", "src/c.ssl"]);
		expect(unstagedOf(status).map((file) => file.path)).toEqual(["src/a.ssl", "src/c.ssl"]);
	});

	test("new, removed and not yet followed", () => {
		const status = parseStatus(said(`1 A. N... 000000 100644 100644 ${H} ${H} new.ssl`, `1 .D N... 100644 100644 000000 ${H} ${H} gone.ssl`, `1 D. N... 100644 000000 000000 ${H} ${H} staged-gone.ssl`, "? notes.md"));
		expect(status.files).toEqual([
			{ path: "new.ssl", staged: "added", unstaged: null },
			{ path: "gone.ssl", staged: null, unstaged: "deleted" },
			{ path: "staged-gone.ssl", staged: "deleted", unstaged: null },
			{ path: "notes.md", staged: null, unstaged: "untracked" },
		]);
	});

	test("a name with spaces is the whole of what is left", () => {
		const status = parseStatus(said(`1 .M N... 100644 100644 100644 ${H} ${H} docs/Due dates and holidays.md`, "? a new file.txt"));
		expect(status.files.map((file) => file.path)).toEqual(["docs/Due dates and holidays.md", "a new file.txt"]);
	});

	test("a renamed file has the name it had, from the entry after it", () => {
		const status = parseStatus(said(`2 R. N... 100644 100644 100644 ${H} ${H} R100 src/New name.ssl`, "src/Old name.ssl", "? after.md"));
		expect(status.files).toEqual([
			{ path: "src/New name.ssl", staged: "renamed", unstaged: null, from: "src/Old name.ssl" },
			{ path: "after.md", staged: null, unstaged: "untracked" },
		]);
	});

	test("a merge git could not finish is a conflict, not staged", () => {
		const status = parseStatus(said(`u UU N... 100644 100644 100644 100644 ${H} ${H} ${H} src/both.ssl`));
		expect(status.files).toEqual([{ path: "src/both.ssl", staged: null, unstaged: "conflict" }]);
	});

	test("what is ignored, and lines of a kind not known here, are passed over", () => {
		expect(parseStatus(said("# stash 3", "! build/out.txt", "x something new", "")).files).toEqual([]);
		expect(parseStatus("").files).toEqual([]);
	});

	test("one letter for each change", () => {
		expect((["added", "modified", "deleted", "renamed", "untracked", "conflict"] as const).map(changeLetter)).toEqual(["A", "M", "D", "R", "U", "!"]);
	});
});

describe("whether a commit can be made", () => {
	const clean = parseStatus(said("# branch.head main"));
	const staged = parseStatus(said("# branch.head main", `1 M. N... 100644 100644 100644 ${H} ${H} a.ssl`));
	const conflict = parseStatus(said("# branch.head main", `1 M. N... 100644 100644 100644 ${H} ${H} a.ssl`, `u UU N... 100644 100644 100644 100644 ${H} ${H} ${H} b.ssl`));

	test("it needs a repository, something staged and a message", () => {
		expect(commitProblem(null, "x")).toContain("not in a git repository");
		expect(commitProblem(clean, "x")).toContain("Nothing is staged");
		expect(commitProblem(staged, "  ")).toContain("Say what the commit does");
		expect(commitProblem(staged, "Count rush work on Saturdays")).toBe("");
	});

	test("a conflict comes first", () => {
		expect(commitProblem(conflict, "x")).toContain("conflict");
	});
});

describe("what a changed file's row offers", () => {
	const A = GIT_ACTIONS;
	test("a change that is not staged can be staged or let go", () => {
		expect(rowActions({ path: "a", staged: null, unstaged: "modified" }, false)).toEqual([A.show, A.open, A.stage, A.discard]);
	});
	test("a file git does not follow goes to the trash, not out of existence", () => {
		expect(rowActions({ path: "a", staged: null, unstaged: "untracked" }, false)).toEqual([A.show, A.open, A.stage, A.trash]);
	});
	test("a removed file has nothing to open", () => {
		expect(rowActions({ path: "a", staged: null, unstaged: "deleted" }, false)).toEqual([A.show, A.stage, A.discard]);
		expect(rowActions({ path: "a", staged: "deleted", unstaged: null }, true)).toEqual([A.show, A.unstage]);
	});
	test("what is staged is only taken out again: letting go is for what is not staged", () => {
		expect(rowActions({ path: "a", staged: "modified", unstaged: "modified" }, true)).toEqual([A.show, A.open, A.unstage]);
	});
	test("a file in conflict is not let go from here", () => {
		expect(rowActions({ path: "a", staged: null, unstaged: "conflict" }, false)).toEqual([A.show, A.open, A.stage]);
	});
});

describe("which lines differ", () => {
	const lines = (text: string) => text.split("\n");

	test("nothing, between a text and itself", () => {
		expect(lineChanges(lines("a\nb\nc"), lines("a\nb\nc"))).toEqual([]);
		expect(lineChanges([], [])).toEqual([]);
	});

	test("lines that are new", () => {
		expect(lineChanges(lines("a\nc"), lines("a\nb\nc"))).toEqual([{ kind: "added", line: 2, endLine: 2 }]);
		expect(lineChanges(lines("a"), lines("a\nb\nc"))).toEqual([{ kind: "added", line: 2, endLine: 3 }]);
		expect(lineChanges(lines("c"), lines("a\nb\nc"))).toEqual([{ kind: "added", line: 1, endLine: 2 }]);
	});

	test("lines that were changed", () => {
		expect(lineChanges(lines("a\nb\nc"), lines("a\nB\nc"))).toEqual([{ kind: "modified", line: 2, endLine: 2 }]);
		// Two lines where one was: both are the change.
		expect(lineChanges(lines("a\nb\nc"), lines("a\nB1\nB2\nc"))).toEqual([{ kind: "modified", line: 2, endLine: 3 }]);
	});

	test("a place where lines were taken out is marked on the line before it", () => {
		expect(lineChanges(lines("a\nb\nc"), lines("a\nc"))).toEqual([{ kind: "removed", line: 1, endLine: 1 }]);
		expect(lineChanges(lines("a\nb\nc"), lines("b\nc"))).toEqual([{ kind: "removed", line: 0, endLine: 0 }]);
		expect(lineChanges(lines("a\nb\nc"), lines("a\nb"))).toEqual([{ kind: "removed", line: 2, endLine: 2 }]);
	});

	test("several changes, each where it is", () => {
		expect(lineChanges(lines("a\nb\nc\nd\ne"), lines("a\nB\nc\ne\nf"))).toEqual([
			{ kind: "modified", line: 2, endLine: 2 },
			{ kind: "removed", line: 3, endLine: 3 },
			{ kind: "added", line: 5, endLine: 5 },
		]);
	});

	test("a whole new file is all new, and an emptied one has one place where everything went", () => {
		expect(lineChanges([], lines("a\nb"))).toEqual([{ kind: "added", line: 1, endLine: 2 }]);
		expect(lineChanges(lines("a\nb"), [])).toEqual([{ kind: "removed", line: 0, endLine: 0 }]);
	});

	test("a text too large to compare line by line is one changed block between its unchanged ends", () => {
		expect(lineChanges(lines("a\nb\nc\nd\nz"), lines("a\nx\ny\nz"), 1)).toEqual([{ kind: "modified", line: 2, endLine: 3 }]);
	});
});
