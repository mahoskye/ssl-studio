import { describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { classifyTicketEntries, type ScannedTicketEntry } from "../src/shared/ticketBundle";
import { docLinkedTickets, workFor, workText } from "../src/shared/workContext";
import { workList } from "../src/shared/workList";
import { catalogItems } from "../src/shared/projectDocs";
import { docByName } from "../src/shared/namedLinks";
import { fileManifest, listDocs, readProject } from "../src/bun/project";
import { WorkspaceFiles } from "../src/bun/workspace";

const entry = (rel: string, opts: { frontTicket?: string; size?: number } = {}): ScannedTicketEntry => ({
	path: `/proj/docs/tickets/${rel}`,
	rel,
	size: opts.size ?? 120,
	...(opts.frontTicket ? { frontTicket: opts.frontTicket } : {}),
});

describe("classifyTicketEntries (ticket bundle folders)", () => {
	test("keeps flat tickets and top-level INDEX.md catalog unchanged", () => {
		const out = classifyTicketEntries([
			entry("INDEX.md"),
			entry("DEMO-101.md", { frontTicket: "DEMO-101" }),
			entry("DEMO-102.md", { frontTicket: "DEMO-102" }),
		]);
		expect(out.map((r) => [r.entry.rel, r.isCatalog, r.folderRel, r.files.length])).toEqual([
			["DEMO-101.md", false, undefined, 0],
			["DEMO-102.md", false, undefined, 0],
			["INDEX.md", true, undefined, 0],
		]);
	});

	test("resolves a canonical ticket bundle folder without turning companion notes into fake tickets", () => {
		const out = classifyTicketEntries([
			entry("INDEX.md"),
			entry("LIMS-123/LIMS-123.md", { frontTicket: "LIMS-123" }),
			entry("LIMS-123/vendor-notes.md"),
			entry("LIMS-123/samples/LegacyCalc.ssl", { size: 4096 }),
			entry("LIMS-123/fixtures/payload.json", { size: 512 }),
			entry("LIMS-123/.DS_Store"),
		]);
		expect(out.length).toBe(2);
		const ticket = out.find((r) => !r.isCatalog)!;
		expect(ticket.entry.rel).toBe("LIMS-123/LIMS-123.md");
		expect(ticket.folderRel).toBe("LIMS-123");
		expect(ticket.fileCount).toBe(3);
		expect(ticket.files.map((f) => [f.rel, f.size])).toEqual([
			["fixtures/payload.json", 512],
			["samples/LegacyCalc.ssl", 4096],
			["vendor-notes.md", 120],
		]);
	});

	test("supports README.md / ticket.md primary file inside a ticket bundle folder", () => {
		const out = classifyTicketEntries([
			entry("LIMS-456/README.md", { frontTicket: "LIMS-456" }),
			entry("LIMS-456/extra.md"),
			entry("LIMS-456/query.sql"),
		]);
		expect(out.length).toBe(1);
		expect(out[0]!.entry.rel).toBe("LIMS-456/README.md");
		expect(out[0]!.folderRel).toBe("LIMS-456");
		expect(out[0]!.files.map((f) => f.rel)).toEqual(["extra.md", "query.sql"]);
	});

	test("pairs a flat ticket with a matching sibling folder of the same key", () => {
		const out = classifyTicketEntries([
			entry("LIMS-789.md", { frontTicket: "LIMS-789" }),
			entry("LIMS-789/meeting-notes.md"),
			entry("LIMS-789/fixtures/sample.xml"),
		]);
		expect(out.length).toBe(1);
		expect(out[0]!.entry.rel).toBe("LIMS-789.md");
		expect(out[0]!.folderRel).toBe("LIMS-789");
		expect(out[0]!.files.map((f) => f.rel)).toEqual(["fixtures/sample.xml", "meeting-notes.md"]);
	});

	test("still recognizes explicit tickets inside a grouping subfolder like 2026/", () => {
		const out = classifyTicketEntries([
			entry("2026/LIMS-200.md", { frontTicket: "LIMS-200" }),
			entry("2026/LIMS-201.md", { frontTicket: "LIMS-201" }),
			entry("2026/random-notes.md"),
		]);
		expect(out.map((r) => r.entry.rel)).toEqual(["2026/LIMS-200.md", "2026/LIMS-201.md"]);
	});

	test("keeps exact fileCount while capping the inline sample list for large ticket folders", () => {
		const entries: ScannedTicketEntry[] = [entry("LIMS-999/LIMS-999.md", { frontTicket: "LIMS-999" })];
		for (let i = 1; i <= 40; i++) {
			entries.push(entry(`LIMS-999/fixtures/case-${String(i).padStart(3, "0")}.xml`));
		}
		const out = classifyTicketEntries(entries);
		expect(out.length).toBe(1);
		expect(out[0]!.fileCount).toBe(40);
		expect(out[0]!.files.length).toBe(25);
		expect(out[0]!.files[0]!.rel).toBe("fixtures/case-001.xml");
		expect(out[0]!.files[24]!.rel).toBe("fixtures/case-025.xml");
	});
});

describe("end-to-end ticket bundle integration", () => {
	test("listDocs, workList, catalogItems, docByName, docLinkedTickets, workText, and fileManifest cooperate cleanly", async () => {
		const dir = mkdtempSync(join(tmpdir(), "ssl-studio-ticket-bundle-"));
		try {
			mkdirSync(join(dir, ".ssl-studio"), { recursive: true });
			writeFileSync(join(dir, ".ssl-studio/project.toml"), '[project]\nname = "Bundle test"\n');
			mkdirSync(join(dir, "docs/tickets/EPIC-1"), { recursive: true });
			mkdirSync(join(dir, "docs/tickets/LIMS-42/samples"), { recursive: true });
			mkdirSync(join(dir, "docs/tickets/LIMS-42/fixtures"), { recursive: true });
			mkdirSync(join(dir, "src"), { recursive: true });

			writeFileSync(
				join(dir, "docs/tickets/EPIC-1/EPIC-1.md"),
				"---\nticket: EPIC-1\ntitle: Lab turnaround overhaul\nstatus: in progress\n---\n\n# EPIC-1\n",
			);
			writeFileSync(
				join(dir, "docs/tickets/LIMS-42/LIMS-42.md"),
				"---\nticket: LIMS-42\nparent: EPIC-1\ntitle: Parse vendor instrument export\nstatus: in progress\n---\n\n# LIMS-42\n\nParse the new XML format.\n",
			);
			writeFileSync(join(dir, "docs/tickets/LIMS-42/vendor-notes.md"), "# Vendor notes\n\nFields may omit timezone.\n");
			writeFileSync(join(dir, "docs/tickets/LIMS-42/samples/legacy.sql"), "SELECT 1;\n");
			writeFileSync(join(dir, "docs/tickets/LIMS-42/fixtures/message.xml"), "<Result id=\"1\"/>\n");
			writeFileSync(join(dir, "src/Parser.ssl"), ":PROCEDURE Parse;\n:ENDPROC;\n");

			const files = new WorkspaceFiles(dir);
			try {
				const project = await readProject(dir);
				const docs = await listDocs(files, project);
				const tickets = docs.filter((d) => d.group === "tickets");

				// Only EPIC-1 and LIMS-42 appear as tickets; vendor-notes.md is NOT a fake ticket.
				expect(tickets.map((t) => t.ticket)).toEqual(["EPIC-1", "LIMS-42"]);

				const lims = tickets.find((t) => t.ticket === "LIMS-42")!;
				expect(lims.ticketFolder).toBe(join(dir, "docs/tickets/LIMS-42"));
				expect(lims.ticketFileCount).toBe(3);
				expect(lims.ticketFiles?.map((f) => f.rel)).toEqual([
					"fixtures/message.xml",
					"samples/legacy.sql",
					"vendor-notes.md",
				]);

				// EPIC-1 has an empty companion list, still recognizing its bundle folder.
				const epic = tickets.find((t) => t.ticket === "EPIC-1")!;
				expect(epic.ticketFolder).toBe(join(dir, "docs/tickets/EPIC-1"));
				expect(epic.ticketFileCount).toBe(0);
				expect(epic.ticketFiles).toEqual([]);

				// Work list nests LIMS-42 cleanly under EPIC-1 with zero stray rows.
				const wl = workList(docs, dir);
				expect(wl.rows.map((r) => [r.file.ticket, r.depth])).toEqual([
					["EPIC-1", 0],
					["LIMS-42", 1],
				]);

				// Tickets catalog links straight to bundled ticket files and omits companion files.
				const cat = catalogItems("tickets", docs, { docs: join(dir, "docs"), schema: join(dir, "schema") });
				expect(cat.map((c) => c.path)).toEqual(["EPIC-1/EPIC-1.md", "LIMS-42/LIMS-42.md"]);

				// [[LIMS-42]] resolves straight to the bundled ticket doc.
				expect(docByName("LIMS-42", docs, dir)?.path).toBe(lims.path);

				// Opening vendor-notes.md automatically links back to LIMS-42 via "in ticket folder".
				const back = docLinkedTickets(docs, join(dir, "docs/tickets/LIMS-42/vendor-notes.md"));
				expect(back.map((b) => [b.key, b.reason])).toEqual([["LIMS-42", "in ticket folder"]]);

				// Agent workText lists the ticket folder's companion files concisely and reflects true totals when truncated.
				const work = workFor(docs, "LIMS-42")!;
				const prompt = await workText(work, async (p) => (await Bun.file(p).exists() ? Bun.file(p).text() : null));
				expect(prompt).toContain("TICKET FOLDER FILES");
				expect(prompt).toContain("- fixtures/message.xml");
				expect(prompt).toContain("- samples/legacy.sql");
				expect(prompt).toContain("- vendor-notes.md");

				const bigPrompt = await workText(
					{ ...work, ticket: { ...work.ticket, ticketFileCount: 140 } },
					async (p) => (await Bun.file(p).exists() ? Bun.file(p).text() : null),
				);
				expect(bigPrompt).toContain("… and 137 more");

				// Ticket bundle files under docs/ stay excluded from the migration file manifest.
				const manifest = await fileManifest(files, project);
				expect(manifest.map((m) => m.path)).toEqual(["src/Parser.ssl"]);
			} finally {
				files.close();
			}
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});
