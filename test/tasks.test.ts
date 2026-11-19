import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { listDocs, readProject } from "../src/bun/project";
import { WorkspaceFiles } from "../src/bun/workspace";
import { docChecks } from "../src/shared/docChecks";
import { specTemplate, ticketTemplate } from "../src/shared/projectDocs";
import type { DocFile } from "../src/shared/protocol";
import { taskTally, tasks, toggleTask } from "../src/shared/tasks";

describe("a document's task list", () => {
	const text = ["---", "title: T", "note: - [ ] not a task", "---", "# T", "", "- [ ] first", "- [x] second, done", "* [X] third", "1. [ ] numbered", "> - [ ] quoted", "- [ ]", "- not a task", "```", "- [ ] in code", "```", "- [ ] last"].join("\n");

	test("is every item with a box and words after it, outside code and the front matter", () => {
		expect(tasks(text).map((task) => [task.line, task.done, task.text])).toEqual([
			[7, false, "first"],
			[8, true, "second, done"],
			[9, true, "third"],
			[10, false, "numbered"],
			[11, false, "quoted"],
			[17, false, "last"],
		]);
		expect(taskTally(text)).toEqual({ done: 2, total: 6 });
		expect(taskTally("# No lists\n\n- a bullet\n")).toBeNull();
	});

	test("an item is ticked by changing one character, and unticked the same way", () => {
		const ticked = toggleTask(text, 0)!;
		expect(ticked).toBe(text.replace("- [ ] first", "- [x] first"));
		expect(toggleTask(ticked, 0)).toBe(text);
		expect(toggleTask(text, 2)).toBe(text.replace("* [X] third", "* [ ] third"));
		expect(toggleTask(text, 5)).toBe(text.replace("- [ ] last", "- [x] last"));
		expect(toggleTask(text, 6)).toBeNull();
		const dos = text.replace(/\n/g, "\r\n");
		expect(toggleTask(dos, 3)).toBe(dos.replace("1. [ ] numbered", "1. [x] numbered"));
	});

	test("a new ticket and a new spec start with one item to tick", () => {
		expect(taskTally(ticketTemplate({ key: "A-1", title: "T" }))).toEqual({ done: 0, total: 1 });
		expect(taskTally(specTemplate({ title: "T" }))).toEqual({ done: 0, total: 1 });
	});

	test("the demo's tickets say how far through their lists they are", async () => {
		const root = join(import.meta.dir, "..", "examples", "due-dates");
		const docs = await listDocs(new WorkspaceFiles(root), await readProject(root));
		expect(docs.filter((d) => d.group === "tickets" && d.ticket).map((d) => [d.ticket, d.tasks])).toEqual([
			["DEMO-101", { done: 3, total: 3 }],
			["DEMO-102", { done: 2, total: 2 }],
			["DEMO-103", { done: 2, total: 3 }],
		]);
		expect(docs.find((d) => d.name === "Due-soon-report.md")?.tasks).toEqual({ done: 2, total: 2 });
	});

	test("a finished ticket with something not ticked is worth knowing", () => {
		const file = (more: Partial<DocFile>): DocFile => ({ path: "/p/docs/tickets/A-1.md", name: "A-1.md", group: "tickets", exists: true, ticket: "A-1", ...more });
		const catalog: DocFile = { path: "/p/docs/tickets/INDEX.md", name: "INDEX.md", group: "tickets", exists: true, catalog: { stale: false } };
		expect(docChecks([catalog, file({ status: "done", tasks: { done: 1, total: 3 } })]).map((check) => check.text)).toEqual(["A-1 is done, with 2 of its 3 items not ticked."]);
		expect(docChecks([catalog, file({ status: "done", tasks: { done: 3, total: 3 } })])).toEqual([]);
		expect(docChecks([catalog, file({ status: "in progress", tasks: { done: 1, total: 3 } })])).toEqual([]);
	});
});
