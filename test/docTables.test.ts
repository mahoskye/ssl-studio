// ADR 0008: tables in documentation. The documents written under the rule are
// held to all of it; every other Markdown file here to the column limit.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { agents, readme } from "../src/bun/project";
import { MAX_COLUMNS, checkTables } from "../src/shared/docTables";
import type { Project } from "../src/shared/protocol";

const root = join(import.meta.dir, "..");
// Ignored folders hold copies of the repository (a session's worktree, a sandbox): their documents are not this one's.
const SKIP = /^(node_modules|dist|build|artifacts|vendor|third-party|\.hutch|\.selftest|\.cottontail-tmp|\.git|\.claude\/worktrees|\.sandbox)\//;
// Windows lists a path with backslashes: every test below reads it with forward ones.
const files = [...new Bun.Glob("**/*.{md,markdown}").scanSync({ cwd: root, dot: true })]
	.map((f) => f.split("\\").join("/"))
	.filter((f) => !SKIP.test(f) && !f.includes("/node_modules/"))
	.sort();
/** Written under the rule, so held to all of it. A document joins this list when it is next edited. */
const governed = (file: string) => file.startsWith("examples/") || file.startsWith("docs/adr/0007") || file.startsWith("docs/adr/0008") || file === "docs/AGENT-INTEGRATION.md";
const said = (file: string, text: string) => checkTables(text).map((f) => `${file}:${f.line} ${f.message}`);

describe("checkTables", () => {
	const table = (head: string, row: string) => `# T\n\n${head}\n${head.replace(/[^|]+/g, " --- ")}\n${row}\n`;

	test("a table within the rule says nothing", () => {
		expect(checkTables(table("| Name | Type | What it holds |", "| `SAMPLE_ID` | varchar(20) | The sample's id. |"))).toEqual([]);
	});

	test("a fifth column is reported, on the table's heading row", () => {
		const found = checkTables(table("| A | B | C | D | E |", "| 1 | 2 | 3 | 4 | 5 |"));
		expect(found).toEqual([{ line: 3, message: "A table has at most 4 columns; this one has 5." }]);
	});

	test("text belongs in the last column only", () => {
		const found = checkTables(table("| Name | Rule | Where |", "| Days | Not a weekend and not a holiday either | here |"));
		expect(found.map((f) => f.message)).toEqual(['"Rule" holds a value of 38 characters; only the last column holds text, and the others at most 20.']);
	});

	test("a cell is measured as it reads: code and links count as their text", () => {
		expect(checkTables(table("| Table | Use |", "| [DEMO_SAMPLES](some/long/path/to/DEMO_SAMPLES.md) | `x` |"))).toEqual([]);
	});

	test("a long heading and an over-long cell are reported", () => {
		const found = checkTables(table("| Name | What this column is for |", `| a | ${"word ".repeat(21)}|`));
		expect(found.map((f) => f.message)).toEqual([
			'The heading "What this column is for" is 23 characters; a heading has at most 16.',
			'"What this column is for" holds 104 characters in one cell; a cell has at most 100.',
		]);
	});
});

describe("this repository's documents", () => {
	test("there are documents to check", () => {
		expect(files.some(governed)).toBe(true);
		expect(files.length).toBeGreaterThan(10);
	});

	test("documents written under the rule keep all of it", () => {
		expect(files.filter(governed).flatMap((file) => said(file, readFileSync(join(root, file), "utf8")))).toEqual([]);
	});

	test("the project templates keep all of it", () => {
		const project: Project = { configured: true, path: "", name: "A project", description: "", docs: "docs", schema: "schema", tests: "tests", code: "src", plans: "design" };
		expect([...said("README.md template", readme(project)), ...said("AGENTS.md template", agents(project))]).toEqual([]);
	});

	test(`no document has a table of more than ${MAX_COLUMNS} columns`, () => {
		const wide = files.flatMap((file) => said(file, readFileSync(join(root, file), "utf8"))).filter((line) => line.includes("at most 4 columns"));
		expect(wide).toEqual([]);
	});
});
