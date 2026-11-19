import { describe, expect, test } from "bun:test";
import { parseCsv } from "../src/shared/csv";
import { docChecks } from "../src/shared/docChecks";
import type { DocFile } from "../src/shared/protocol";
import { keyOf, keysIn, rowsByTicket, rowsLine, ticketColumn } from "../src/shared/registryTickets";
import { ticketAtHand, ticketWork } from "../src/shared/workContext";
import { listDocs, readProject } from "../src/bun/project";
import { WorkspaceFiles } from "../src/bun/workspace";

const table = parseCsv("name,status,ticket,note\nA,migrated,T-1,\nB,found,T-1,\nC,verified,\"T-2, t-1\",\nD,found,,\n");

describe("the tickets a registry's rows name", () => {
	test("are read from its ticket column, each with its rows and how many are done", () => {
		expect(ticketColumn(table)).toBe(2);
		expect(rowsByTicket(table)).toEqual([
			{ key: "T-1", rows: 3, done: 2 },
			{ key: "T-2", rows: 1, done: 1 },
		]);
	});
	test("a cell names one key or several, and the same key twice in a row is that row once", () => {
		expect(keysIn("T-1, T-2;T-3  T-4")).toEqual(["T-1", "T-2", "T-3", "T-4"]);
		expect(rowsByTicket(parseCsv("name,ticket\nA,T-1 t-1\n"))).toEqual([{ key: "T-1", rows: 1 }]);
	});
	test("a registry with no status column counts rows only, and one with no ticket column names none", () => {
		expect(rowsByTicket(parseCsv("name,tickets\nA,T-1\nB,T-1\n"))).toEqual([{ key: "T-1", rows: 2 }]);
		expect(rowsByTicket(parseCsv("name,status\nA,found\n"))).toEqual([]);
		expect(ticketColumn(parseCsv("name,status\nA,found\n"))).toBe(-1);
	});
	test("are said in a line", () => {
		expect(rowsLine({ key: "T-1", rows: 3, done: 2 })).toBe("3 rows, 2 done");
		expect(rowsLine({ key: "T-1", rows: 1 })).toBe("1 row");
	});
});

describe("a ticket and what it has to carry across", () => {
	const ticket: DocFile = { path: "/p/docs/tickets/T-1.md", name: "T-1.md", group: "tickets", exists: true, ticket: "T-1", status: "in progress" };
	const registry: DocFile = { path: "/p/docs/registries/settings.csv", name: "settings.csv", group: "registries", exists: true, rows: 4, tickets: ["T-1", "T-9"], forTickets: [{ key: "T-1", rows: 3, done: 2 }, { key: "T-9", rows: 1, done: 0 }] };
	const other: DocFile = { path: "/p/docs/registries/database.csv", name: "database.csv", group: "registries", exists: true, rows: 2 };
	test("the ticket's page lists the registries with rows that name it", () => {
		const groups = ticketWork([ticket, registry, other], "T-1");
		expect(groups.map((group) => [group.kind, group.name, group.files.map((file) => file.name)])).toEqual([["registry", "To carry across", ["settings.csv"]]]);
	});
	test("a ticket a row names that is not in the folder is said, by the registry's name", () => {
		const check = docChecks([ticket, registry]).find((c) => c.text.includes("T-9"));
		expect(check).toMatchObject({ level: "note", text: "T-9 is not among the tickets; Application settings names it.", path: registry.path, fix: { kind: "ticket", key: "T-9" } });
	});
	test("a registry is not about the first ticket it names", () => {
		const second: DocFile = { ...ticket, path: "/p/docs/tickets/T-2.md", name: "T-2.md", ticket: "T-2" };
		expect(ticketAtHand([ticket, second, registry], registry.path)).toBe("");
	});
});

describe("the demo project's settings say which ticket carries each", () => {
	test("and the listing has them", async () => {
		const root = `${import.meta.dir}/../examples/due-dates`;
		const list = await listDocs(new WorkspaceFiles(root), await readProject(root));
		const settings = list.find((file) => file.group === "registries" && file.name === "settings.csv");
		expect(settings?.forTickets).toEqual([
			{ key: "DEMO-101", rows: 6, done: 6 },
			{ key: "DEMO-102", rows: 1, done: 1 },
			{ key: "DEMO-103", rows: 3, done: 0 },
		]);
		expect(docChecks(list).filter((check) => check.level === "warn")).toEqual([]);
		expect(list.filter((file) => file.catalog?.stale)).toEqual([]);
	});
});

// A fourth review (2026-11-19).
describe("only what is written as a key is a ticket", () => {
	test("the words a person writes where there is no ticket are passed over", () => {
		const rows = rowsByTicket(parseCsv("name,ticket\nA,n/a\nB,-\nC,TBD\nD,DEMO-1 (partly)\nE,\"#12, 13\"\nF,see DEMO-2\n"));
		expect(rows).toEqual([
			{ key: "DEMO-1", rows: 1 },
			{ key: "12", rows: 1 },
			{ key: "13", rows: 1 },
			{ key: "DEMO-2", rows: 1 },
		]);
	});
	test("a number with its mark is the ticket of that number", () => {
		expect(keyOf("#12")).toBe("12");
		expect(keyOf("12")).toBe("12");
		expect(keyOf("DEMO-12")).toBe("DEMO-12");
		for (const word of ["n/a", "-", "TBD", "(partly)", "DEMO", "12a", ""]) expect(keyOf(word)).toBe("");
	});
});

// A fifth review (2026-11-19): a key the project's tickets have is a key, however it is written.
describe("a project's own ticket keys in a registry", () => {
	const known = new Set(["rel-2024-07", "login-rework", "t12", "lims-123a"]);
	test("are found whatever their shape, and words that are no ticket's are still passed over", () => {
		const rows = rowsByTicket(parseCsv("name,ticket\nA,REL-2024-07\nB,LOGIN-REWORK\nC,T12\nD,LIMS-123A\nE,TBD\nF,n/a\nG,login-rework\n"), known);
		expect(rows).toEqual([
			{ key: "REL-2024-07", rows: 1 },
			{ key: "LOGIN-REWORK", rows: 2 },
			{ key: "T12", rows: 1 },
			{ key: "LIMS-123A", rows: 1 },
		]);
	});
	test("a word with a number in it is written as a key is, known or not; one with none is a key only when known", () => {
		expect(keyOf("REL-2024-07")).toBe("REL-2024-07");
		expect(keyOf("T12")).toBe("T12");
		expect(keyOf("LIMS-123A")).toBe("LIMS-123A");
		expect(keyOf("LOGIN-REWORK")).toBe("");
		expect(keyOf("LOGIN-REWORK", known)).toBe("LOGIN-REWORK");
		expect(keyOf("2026-11-19")).toBe("");
		expect(keyOf("DEMO-1.")).toBe("");
	});
});
