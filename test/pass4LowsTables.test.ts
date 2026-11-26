// Audit pass 4, low findings in the table editor and in what asked "is this file there?" by reading it.
// The backend reads no text over 20 MB (6bf5b41). What took a refused read for a missing file then wrote over the
// file without asking, or took everything that came from it for gone.
import { afterAll, beforeAll, describe, expect, mock, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { flush } from "solid-js";
import { createBackend, dispatch } from "../src/bun/backend";
import { READ_MAX_BYTES } from "../src/bun/workspace";
import { DEFAULT_SETTINGS } from "../src/shared/protocol";
import { extractSqlObjects } from "../src/shared/sqlSchema";
import * as power from "../src/shared/tablePower";
import { generateFillSeries } from "../src/shared/tablePower";
import { existsBy } from "../src/view/backend";

const base = realpathSync(mkdtempSync(join(tmpdir(), "ssl-studio-p4l-tables-")));
afterAll(() => rmSync(base, { recursive: true, force: true }));

const readSrc = (rel: string) => readFileSync(join(import.meta.dir, rel), "utf8").replace(/\r\n/g, "\n");

/** A text file a megabyte over what the backend opens: `head`, then comment lines to the size. */
const BIG_BYTES = READ_MAX_BYTES + 1024 * 1024;
function writeBig(path: string, head: string) {
	const bytes = Buffer.alloc(BIG_BYTES, "-- padding line of a script that is too large to open\n");
	bytes.write(head, 0, "utf8");
	writeFileSync(path, bytes);
}

/** A folder of its own under the run's folder, with these files in it. */
function workspace(name: string, files: Record<string, string> = {}): string {
	const root = join(base, name);
	for (const [rel, text] of Object.entries(files)) {
		mkdirSync(join(root, rel, ".."), { recursive: true });
		writeFileSync(join(root, rel), text);
	}
	mkdirSync(root, { recursive: true });
	return root;
}

/** What was put on the clipboard, and what was put in the trash (taken away, as the app's own trash does). */
const copied: string[] = [];
const trashed: string[] = [];
const makeHost = (canTrash = true) => ({
	app: "test",
	kind: "app" as const,
	emit: () => {},
	pick: async () => null,
	quit: () => {},
	clipboard: (text: string) => void copied.push(text),
	trash: async (path: string) => {
		if (!canTrash) throw new Error("delete is only available in the app");
		trashed.push(path);
		rmSync(path, { recursive: true, force: true });
	},
});

/** A real backend with this folder open. */
async function backendOn(root: string, canTrash = true) {
	const backend = createBackend(makeHost(canTrash), root);
	await backend.ready;
	return backend;
}

// ---------------------------------------------------------------------------------------------------------------
// B3-5. The fill handle: a monthly or yearly series of dates goes on by the calendar
// ---------------------------------------------------------------------------------------------------------------

describe("B3-5: dates a whole number of months apart are filled by months, not by the days between them", () => {
	test("ISO dates on the same day of the month stay on it, also across a year end", () => {
		// It went on 03-04, 04-04, 05-05: the 31 days of January, again and again.
		expect(generateFillSeries(["2026-01-01", "2026-02-01"], 3)).toEqual(["2026-03-01", "2026-04-01", "2026-05-01"]);
		expect(generateFillSeries(["2026-11-15", "2026-12-15"], 3)).toEqual(["2027-01-15", "2027-02-15", "2027-03-15"]);
		// Every third month.
		expect(generateFillSeries(["2026-01-10", "2026-04-10"], 3)).toEqual(["2026-07-10", "2026-10-10", "2027-01-10"]);
		// Three seeds, the same step between each.
		expect(generateFillSeries(["2026-10-05", "2026-11-05", "2026-12-05"], 2)).toEqual(["2027-01-05", "2027-02-05"]);
		// February to March is 28 days and a month: the month it is.
		expect(generateFillSeries(["2026-02-01", "2026-03-01"], 2)).toEqual(["2026-04-01", "2026-05-01"]);
	});

	test("month ends stay month ends, through a leap February too", () => {
		expect(generateFillSeries(["2026-01-31", "2026-02-28"], 4)).toEqual(["2026-03-31", "2026-04-30", "2026-05-31", "2026-06-30"]);
		expect(generateFillSeries(["2028-01-31", "2028-02-29"], 2)).toEqual(["2028-03-31", "2028-04-30"]);
		expect(generateFillSeries(["2026-02-28", "2026-03-31"], 2)).toEqual(["2026-04-30", "2026-05-31"]);
		// Every second month end.
		expect(generateFillSeries(["2026-02-28", "2026-04-30"], 2)).toEqual(["2026-06-30", "2026-08-31"]);
		// Across the year end and into a leap February.
		expect(generateFillSeries(["2027-11-30", "2027-12-31"], 3)).toEqual(["2028-01-31", "2028-02-29", "2028-03-31"]);
	});

	test("a month too short for the day gives its last day, and the day is back in the month after", () => {
		expect(generateFillSeries(["2025-11-30", "2025-12-30"], 4)).toEqual(["2026-01-30", "2026-02-28", "2026-03-30", "2026-04-30"]);
		expect(generateFillSeries(["2026-11-29", "2026-12-29"], 3)).toEqual(["2027-01-29", "2027-02-28", "2027-03-29"]);
		// The 29th is there in a leap February.
		expect(generateFillSeries(["2027-11-29", "2027-12-29"], 3)).toEqual(["2028-01-29", "2028-02-29", "2028-03-29"]);
	});

	test("whole years go on by years", () => {
		// It went on 2027-06-01, 2028-05-31, 2029-05-31: 365 days, a day lost at the leap year.
		expect(generateFillSeries(["2025-06-01", "2026-06-01"], 3)).toEqual(["2027-06-01", "2028-06-01", "2029-06-01"]);
		expect(generateFillSeries(["2026-12-31", "2027-12-31"], 2)).toEqual(["2028-12-31", "2029-12-31"]);
		// The last day of February, year by year: the 29th where the year has one.
		expect(generateFillSeries(["2024-02-29", "2025-02-28"], 4)).toEqual(["2026-02-28", "2027-02-28", "2028-02-29", "2029-02-28"]);
		// Leap day to leap day.
		expect(generateFillSeries(["2024-02-29", "2028-02-29"], 2)).toEqual(["2032-02-29", "2036-02-29"]);
		// The 28th of two Februaries is the 28th: the same day, not the month's end.
		expect(generateFillSeries(["2026-02-28", "2027-02-28"], 2)).toEqual(["2028-02-28", "2029-02-28"]);
	});

	test("a series that goes down, and a fill dragged up or left", () => {
		expect(generateFillSeries(["2026-03-01", "2026-02-01"], 3)).toEqual(["2026-01-01", "2025-12-01", "2025-11-01"]);
		expect(generateFillSeries(["2026-06-01", "2025-06-01"], 2)).toEqual(["2024-06-01", "2023-06-01"]);
		expect(generateFillSeries(["2026-03-31", "2026-02-28"], 2)).toEqual(["2026-01-31", "2025-12-31"]);
		// Dragged up: what comes before the first seed.
		expect(generateFillSeries(["2026-01-01", "2026-02-01"], 3, { reverse: true })).toEqual(["2025-12-01", "2025-11-01", "2025-10-01"]);
		expect(generateFillSeries(["2026-03-31", "2026-04-30"], 3, { reverse: true })).toEqual(["2026-02-28", "2026-01-31", "2025-12-31"]);
		expect(generateFillSeries(["2028-03-15", "2029-03-15"], 2, { reverse: true })).toEqual(["2027-03-15", "2026-03-15"]);
	});

	test("slash dates do the same, in the order they are written in", () => {
		// The month first. These repeated on main, and drifted (03/04, 04/04, 05/05) once slash dates were filled.
		expect(generateFillSeries(["01/01/2026", "02/01/2026"], 3, { dayFirst: false })).toEqual(["03/01/2026", "04/01/2026", "05/01/2026"]);
		// The day first: the same cells read the other way are a day apart, and stay so.
		expect(generateFillSeries(["01/01/2026", "02/01/2026"], 2, { dayFirst: true })).toEqual(["03/01/2026", "04/01/2026"]);
		expect(generateFillSeries(["01/01/2026", "01/02/2026"], 3, { dayFirst: true })).toEqual(["01/03/2026", "01/04/2026", "01/05/2026"]);
		expect(generateFillSeries(["01/01/2026", "01/02/2026"], 2, { dayFirst: false })).toEqual(["01/03/2026", "01/04/2026"]);
		// The seeds say which is the day: a number over twelve.
		expect(generateFillSeries(["31/01/2026", "28/02/2026"], 3)).toEqual(["31/03/2026", "30/04/2026", "31/05/2026"]);
		expect(generateFillSeries(["01/31/2026", "02/28/2026"], 3)).toEqual(["03/31/2026", "04/30/2026", "05/31/2026"]);
		expect(generateFillSeries(["15/11/2026", "15/12/2026"], 2)).toEqual(["15/01/2027", "15/02/2027"]);
		expect(generateFillSeries(["11/15/2026", "12/15/2026"], 2)).toEqual(["01/15/2027", "02/15/2027"]);
		// The year first, with dashes and the year last, and written without leading zeros.
		expect(generateFillSeries(["2026/01/01", "2026/02/01"], 3)).toEqual(["2026/03/01", "2026/04/01", "2026/05/01"]);
		expect(generateFillSeries(["15-11-2026", "15-12-2026"], 2)).toEqual(["15-01-2027", "15-02-2027"]);
		expect(generateFillSeries(["1/1/2026", "2/1/2026"], 2, { dayFirst: false })).toEqual(["3/1/2026", "4/1/2026"]);
		// Years, a leap day, and a series going down.
		expect(generateFillSeries(["29/02/2024", "28/02/2025"], 4)).toEqual(["28/02/2026", "28/02/2027", "29/02/2028", "28/02/2029"]);
		expect(generateFillSeries(["06/01/2025", "06/01/2026"], 2, { dayFirst: false })).toEqual(["06/01/2027", "06/01/2028"]);
		expect(generateFillSeries(["2026/03/01", "2026/02/01"], 2)).toEqual(["2026/01/01", "2025/12/01"]);
		expect(generateFillSeries(["03/01/2026", "02/01/2026"], 2, { dayFirst: false, reverse: true })).toEqual(["04/01/2026", "05/01/2026"]);
	});

	test("seeds that are not whole months apart keep a constant step in days", () => {
		expect(generateFillSeries(["2026-11-01", "2026-11-08"], 2)).toEqual(["2026-11-15", "2026-11-22"]);
		expect(generateFillSeries(["2026-01-25", "2026-02-04"], 3)).toEqual(["2026-02-14", "2026-02-24", "2026-03-06"]);
		// A month on, but neither the same day nor two month ends: 30 days it is.
		expect(generateFillSeries(["2026-01-15", "2026-02-14"], 2)).toEqual(["2026-03-16", "2026-04-15"]);
		expect(generateFillSeries(["2026-01-30", "2026-02-28"], 2)).toEqual(["2026-03-29", "2026-04-27"]);
		expect(generateFillSeries(["02/29/2028", "03/07/2028"], 2)).toEqual(["03/14/2028", "03/21/2028"]);
		// The same date twice has no step: it is repeated.
		expect(generateFillSeries(["2026-01-05", "2026-01-05"], 2)).toEqual(["2026-01-05", "2026-01-05"]);
		// Months apart, but not by the same number of months, and no one step in days either: the seeds are copied.
		expect(generateFillSeries(["2026-01-01", "2026-02-01", "2026-04-01"], 3)).toEqual(["2026-01-01", "2026-02-01", "2026-04-01"]);
	});

	test("what the fill did right before, it still does", () => {
		expect(generateFillSeries(["TC-009"], 2)).toEqual(["TC-010", "TC-011"]);
		expect(generateFillSeries(["TC-003"], 5, { reverse: true })).toEqual(["TC-002", "TC-001", "TC-000"]);
		expect(generateFillSeries(["2026/11/30"], 2)).toEqual(["2026/12/01", "2026/12/02"]);
		expect(generateFillSeries(["2028/02/28"], 2)).toEqual(["2028/02/29", "2028/03/01"]);
		expect(generateFillSeries(["2026-12-30"], 3)).toEqual(["2026-12-31", "2027-01-01", "2027-01-02"]);
		expect(generateFillSeries(["2026-01-01", "2026-02-01"], 2, { literal: true })).toEqual(["2026-01-01", "2026-02-01"]);
	});

	test("every month a monthly series is filled to is the month a calendar counted by hand gives, for years each way", () => {
		const leap = (y: number) => (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
		const lastDay = (y: number, m: number) => (m === 2 ? (leap(y) ? 29 : 28) : [4, 6, 9, 11].includes(m) ? 30 : 31);
		const two = (n: number) => String(n).padStart(2, "0");
		const written = {
			iso: (y: number, m: number, d: number) => `${y}-${two(m)}-${two(d)}`,
			monthFirst: (y: number, m: number, d: number) => `${two(m)}/${two(d)}/${y}`,
			dayFirst: (y: number, m: number, d: number) => `${two(d)}/${two(m)}/${y}`,
		};
		let checked = 0;
		for (const [form, write] of Object.entries(written)) {
			for (const step of [1, 2, 3, 5, 12, 13, 24]) {
				for (const day of [1, 15, 28, 29, 30, 31, "end"] as const) {
					for (const startMonth of [1, 2, 7, 11, 12]) {
						for (const down of [false, true]) {
							for (const reverse of [false, true]) {
								// The seeds: two months `step` apart, on `day` (where both months have it) or on their last days.
								const at = (k: number) => {
									const months = 2027 * 12 + (startMonth - 1) + k * step * (down ? -1 : 1);
									const y = Math.floor(months / 12);
									const m = (months % 12) + 1;
									return { y, m, d: day === "end" ? lastDay(y, m) : Math.min(day, lastDay(y, m)) };
								};
								const seeds = [at(0), at(1)];
								// A seed cut short by its month is not on the day of the series: such seeds are not this test's.
								if (day !== "end" && seeds.some((s) => s.d !== day)) continue;
								// Two seeds on the same day that are both month ends go on by the day, as written above.
								const byEnd = day === "end" && seeds[0]!.d !== seeds[1]!.d;
								const options = { reverse, dayFirst: form === "dayFirst" };
								const series = generateFillSeries(seeds.map((s) => write(s.y, s.m, s.d)), 30, options);
								const expected = Array.from({ length: 30 }, (_, i) => {
									const { y, m } = at(reverse ? -(i + 1) : i + 2);
									const d = byEnd ? lastDay(y, m) : Math.min(seeds[0]!.d, lastDay(y, m));
									return write(y, m, d);
								});
								expect([form, step, day, startMonth, down, reverse, series]).toEqual([form, step, day, startMonth, down, reverse, expected]);
								checked++;
							}
						}
					}
				}
			}
		}
		expect(checked).toBeGreaterThan(1000);
	});
});

// ---------------------------------------------------------------------------------------------------------------
// B9-2. Export visible rows: a file too large to open is still a file that is there
// ---------------------------------------------------------------------------------------------------------------

describe("B9-2: the table's export asks before it writes over a text file too large to open", () => {
	test("such a file is there by the question the export now asks, and was not by the read it asked before", async () => {
		const root = workspace("export", { "samples.csv": "id,name\n1,alpha\n" });
		const dest = join(root, "samples-export.csv");
		writeBig(dest, "id,name\n");
		const backend = await backendOn(root);
		try {
			const { api } = backend;
			// The question as it was asked: `backend.read(dest).then(() => true, () => false)`.
			expect(await api.read(dest).then(() => true, () => false)).toBe(false);
			await expect(api.read(dest)).rejects.toThrow("samples-export.csv is 21.0 MB: too large to open here (the most is 20.0 MB).");
			// The question as `fileExists` asks it.
			expect(await existsBy(api.sizes, api.read, dest)).toBe(true);
			expect(await existsBy(api.sizes, api.read, join(root, "not-there.csv"))).toBe(false);
			// And the write the export goes on to, were it not asked about, does replace the file.
			await api.write(join(root, "samples-export.csv"), "id,name\n1,alpha\n");
			expect(statSync(dest).size).toBe(16);
		} finally {
			backend.dispose();
		}
	});

	test("the export asks it so (held by source text: the table view is not mounted in any test)", () => {
		const src = readSrc("../src/view/editor/TableView.tsx");
		const fn = src.slice(src.indexOf("const exportVisibleToFile = async"), src.indexOf("const convertDelimiterInteractive = async"));
		expect(fn).toContain("const exists = await fileExists(dest);");
		expect(fn).not.toContain("backend.read(");
		expect(fn.indexOf("await fileExists(dest)")).toBeGreaterThan(-1);
		expect(fn.indexOf("await fileExists(dest)")).toBeLessThan(fn.indexOf("Overwrite existing file"));
		expect(fn.indexOf("Overwrite existing file")).toBeLessThan(fn.indexOf("await backend.write(dest, content)"));
	});
});

// ---------------------------------------------------------------------------------------------------------------
// B11-3. A schema file that could not be read is not a file that is gone, and not an empty one
// ---------------------------------------------------------------------------------------------------------------

describe("B11-3: a schema SQL file that is there and could not be read", () => {
	const TABLES_SQL = "CREATE TABLE samples (\n\tid INT PRIMARY KEY,\n\tname VARCHAR(40)\n);\n";
	const BIG_HEAD = "CREATE TABLE batches (\n\tid INT PRIMARY KEY,\n\tsample_id INT REFERENCES samples(id)\n);\n";

	test("reading it gives why, in words that name it; a file that is read gives its text", async () => {
		const root = workspace("schema-read", { "schema/tables.sql": TABLES_SQL });
		writeBig(join(root, "schema", "big.sql"), BIG_HEAD);
		writeFileSync(join(root, "schema", "blob.sql"), Buffer.from([0x43, 0x52, 0x00, 0x00, 0x01, 0x02, 0x00, 0xff]));
		const backend = await backendOn(root);
		try {
			const read = (rel: string) => power.textOrWhy(() => backend.api.read(join(root, rel)), rel, root);
			expect(await read("schema/tables.sql")).toEqual({ text: TABLES_SQL });
			expect(await read("schema/big.sql")).toEqual({ why: "schema/big.sql is 21.0 MB: too large to open here (the most is 20.0 MB)." });
			expect(await read("schema/blob.sql")).toEqual({ why: "schema/blob.sql is not text." });
			// A file gone since it was listed: what the file system said of it (reworded where `plainFileError` knows it).
			expect(await read("schema/none.sql")).toEqual({ why: expect.stringMatching(/none\.sql/) });
		} finally {
			backend.dispose();
		}
	});

	test("the notice says each file as its refusal names it, and counts what is over three", () => {
		const big = { file: "schema/big.sql", why: "schema/big.sql is 21.0 MB: too large to open here (the most is 20.0 MB)." };
		expect(power.unreadFilesSaid([big])).toBe("schema/big.sql is 21.0 MB: too large to open here (the most is 20.0 MB).");
		// A refusal that does not name the file is put after its name; one with no words is said plainly.
		expect(power.unreadFilesSaid([{ file: "schema/a.sql", why: "The connection to SSL Studio was lost." }])).toBe("schema/a.sql could not be read (The connection to SSL Studio was lost).");
		expect(power.unreadFilesSaid([{ file: "schema/a.sql", why: "" }])).toBe("schema/a.sql could not be read.");
		// Named with the other slash (the backend on Windows), it is still the file's own name.
		expect(power.unreadFilesSaid([{ file: "schema/a.sql", why: "schema\\a.sql is not a file" }])).toBe("schema\\a.sql is not a file.");
		const not = (n: number) => ({ file: `schema/${n}.sql`, why: `schema/${n}.sql is not text.` });
		expect(power.unreadFilesSaid([big, not(1)])).toBe(`${big.why} schema/1.sql is not text.`);
		expect(power.unreadFilesSaid([not(1), not(2), not(3), not(4)])).toBe("schema/1.sql is not text. schema/2.sql is not text. schema/3.sql is not text. 1 more file could not be read either.");
		expect(power.unreadFilesSaid([not(1), not(2), not(3), not(4), not(5)])).toEndWith("2 more files could not be read either.");
	});

	test("B11-3a: the rows that came from such a file are not offered as gone", async () => {
		const root = workspace("schema-sync", { "schema/tables.sql": TABLES_SQL });
		writeBig(join(root, "schema", "big.sql"), BIG_HEAD);
		const backend = await backendOn(root);
		try {
			// The sync's own reading of the schema folder, with the registry's rows as the table view hands them over.
			const names = new Set<string>();
			const unread: power.UnreadFile[] = [];
			for (const rel of ["schema/big.sql", "schema/tables.sql"]) {
				const got = await power.textOrWhy(() => backend.api.read(join(root, rel)), rel, root);
				if ("why" in got) {
					unread.push({ file: rel, why: got.why });
					continue;
				}
				for (const obj of extractSqlObjects(got.text, { includeAlter: true })) {
					names.add(obj.name.toLowerCase());
					names.add(obj.bareName.toLowerCase());
				}
			}
			expect(unread.map((u) => u.file)).toEqual(["schema/big.sql"]);
			const rows = [
				{ name: "samples", note: "From schema/tables.sql", status: "found" },
				{ name: "batches", note: "From schema/big.sql", status: "found" },
				{ name: "dbo.results", note: "From schema/big.sql", status: "" },
				{ name: "old_runs", note: "From schema/tables.sql", status: "found" },
				{ name: "old_marked", note: "From schema/tables.sql", status: "gone" },
				{ name: "by_hand", note: "kept by the lab", status: "" },
			];
			// As it was: nothing was known of the file but that no object came out of it, and its rows were "no longer
			// in schema SQL".
			expect(power.registryRowsGone(rows, names, []).map((r) => r.name)).toEqual(["batches", "dbo.results", "old_runs"]);
			// As it is: only the row whose own file was read and no longer holds it.
			expect(power.registryRowsGone(rows, names, unread.map((u) => u.file)).map((r) => r.name)).toEqual(["old_runs"]);
			expect(`${power.unreadFilesSaid(unread)} Rows from that file were left as they were.`).toBe(
				"schema/big.sql is 21.0 MB: too large to open here (the most is 20.0 MB). Rows from that file were left as they were.",
			);
		} finally {
			backend.dispose();
		}
	});

	test("a note names a file whatever its slashes and letters, alone or with more written after it", () => {
		const unread = ["schema/tables/Big.sql"];
		expect(power.noteNamesFile("From schema/tables/Big.sql", unread)).toBe(true);
		expect(power.noteNamesFile("from  schema\\tables\\big.sql", unread)).toBe(true);
		expect(power.noteNamesFile("From schema/tables/Big.sql (checked in March)", unread)).toBe(true);
		expect(power.noteNamesFile("From schema/tables/Big.sql.bak", unread)).toBe(false);
		expect(power.noteNamesFile("From schema/tables/Bigger.sql", unread)).toBe(false);
		expect(power.noteNamesFile("See schema/tables/Big.sql", unread)).toBe(false);
		expect(power.noteNamesFile("From schema/tables/Big.sql", [])).toBe(false);
		// What the sync asked about before is still what it asks about when every file was read.
		const rows = [
			{ name: "dbo.SAMPLES", note: "From schema/a.sql", status: "found" },
			{ name: "dbo.BATCHES", note: "From schema/a.sql", status: "found" },
			{ name: "", note: "From schema/a.sql", status: "" },
		];
		expect(power.registryRowsGone(rows, new Set(["samples"]), []).map((r) => r.name)).toEqual(["dbo.BATCHES"]);
		expect(power.registryRowsGone(rows, new Set(["dbo.batches", "dbo.samples"]), [])).toEqual([]);
	});

	test("the sync reads, tells and marks by these (held by source text: the table view is not mounted in any test)", () => {
		const src = readSrc("../src/view/editor/TableView.tsx");
		const fn = src.slice(src.indexOf("const syncDatabaseRegistryFromSchema = async"), src.indexOf("const pasteGridAt = async"));
		expect(fn).toContain("await textOrWhy(() => backend.read(file), relFile, root)");
		expect(fn).not.toContain("backend.read(file).catch(");
		expect(fn).toContain("unread.push({ file: relFile, why: res.why })");
		// Told once, before the first thing the sync says or asks.
		expect(fn.match(/unreadFilesSaid\(/g)?.length).toBe(1);
		expect(fn.indexOf("unreadFilesSaid(unread)")).toBeLessThan(fn.indexOf("already matches every object"));
		expect(fn.indexOf("unreadFilesSaid(unread)")).toBeLessThan(fn.indexOf("await choose("));
		expect(fn).toContain("const dropped = registryRowsGone(");
		// A row of the same name from an unread file is not marked with the others.
		expect(fn).toContain("!droppedNameSet.has(name) || noteNamesFile(note, unreadFiles)");
	});
});

// ---------------------------------------------------------------------------------------------------------------
// The view's own modules, with the few browser and Monaco names they ask for when they are loaded (as
// test/pass3LowsDocs.test.ts has them), the dialogs answered by the test, and the calls to the backend taken to a
// real one over the socket the browser host uses (as test/r8cStateKeysQuickPick.test.ts does it).
// ---------------------------------------------------------------------------------------------------------------

const storage = new Map<string, string>();
if (typeof (globalThis as any).localStorage === "undefined") {
	(globalThis as any).localStorage = {
		getItem: (k: string) => storage.get(k) ?? null,
		setItem: (k: string, v: string) => void storage.set(k, String(v)),
		removeItem: (k: string) => void storage.delete(k),
		clear: () => storage.clear(),
	};
}
if (typeof (globalThis as any).window === "undefined") {
	(globalThis as any).window = {
		Error,
		Map,
		Set,
		innerWidth: 1280,
		innerHeight: 900,
		addEventListener() {},
		removeEventListener() {},
		location: { href: "http://localhost/", protocol: "http:", host: "127.0.0.1:5196" },
		matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
	};
} else {
	if (!(globalThis as any).window.Error) (globalThis as any).window.Error = Error;
	if (!(globalThis as any).window.Map) (globalThis as any).window.Map = Map;
	if (!(globalThis as any).window.Set) (globalThis as any).window.Set = Set;
}
if (typeof (globalThis as any).document === "undefined") {
	(globalThis as any).document = {
		documentElement: { dataset: {}, style: {} },
		head: { appendChild() {} },
		activeElement: null,
		getElementById: () => null,
		createElement: () => ({ style: {}, getContext: () => null }),
		querySelector: () => null,
	};
} else if (typeof (globalThis as any).document.querySelector !== "function") {
	(globalThis as any).document.querySelector = () => null;
}
if (typeof (globalThis as any).self === "undefined") (globalThis as any).self = globalThis;

const makeUri = (scheme: string, fsPath: string) => {
	const normalized = fsPath.replace(/\\/g, "/");
	const raw = scheme === "file" ? `file://${normalized.startsWith("/") ? "" : "/"}${normalized}` : `${scheme}:${fsPath}`;
	return { scheme, fsPath, path: normalized, toString: () => raw };
};
mock.module(`${resolve(import.meta.dir, "../src/view/editor/markdownLive.worker.ts")}?worker`, () => ({ default: class {} }));
mock.module("monaco-editor/editor/editor.worker?worker", () => ({ default: class {} }));
mock.module("monaco-editor/features/register.all", () => ({}));
mock.module("monaco-editor/editor/contrib/semanticTokens/browser/documentSemanticTokens", () => ({}));
for (const lang of ["markdown", "sql", "yaml", "xml", "ini", "shell", "powershell", "bat", "javascript", "typescript", "html", "css", "scss", "less", "csharp", "vb", "razor", "pgsql", "mysql", "python", "java", "cpp", "php", "dockerfile", "graphql", "r", "perl", "ruby", "go", "rust", "fsharp"]) {
	mock.module(`monaco-editor/languages/definitions/${lang}/register`, () => ({}));
}
const noopProxy = (extra: Record<string, any> = {}): any => new Proxy(extra, { get: (target, prop) => (prop in target ? target[prop as any] : () => ({ dispose() {} })) });
mock.module("monaco-editor/editor/editor.api", () => ({
	Range: class {
		constructor(
			public startLineNumber: number,
			public startColumn: number,
			public endLineNumber: number,
			public endColumn: number,
		) {}
	},
	Position: class {
		constructor(
			public lineNumber: number,
			public column: number,
		) {}
	},
	Emitter: class {
		event = () => ({ dispose() {} });
		fire() {}
		dispose() {}
	},
	Uri: {
		from: () => ({}),
		file: (p: string) => makeUri("file", p),
		parse: (raw: string) => (raw.startsWith("file://") ? makeUri("file", raw.slice("file://".length)) : makeUri("untitled", raw)),
	},
	MarkerSeverity: { Hint: 1, Info: 2, Warning: 4, Error: 8 },
	KeyMod: { CtrlCmd: 2048, Shift: 1024, Alt: 512 },
	KeyCode: {},
	languages: noopProxy({
		CompletionItemKind: { File: 1, Keyword: 2, Text: 3, Snippet: 4, Field: 5, Struct: 6 },
		SymbolKind: { Function: 11, Method: 5, Constructor: 8, Namespace: 2 },
		FoldingRangeKind: { Comment: "comment", Imports: "imports", Region: "region" },
		CompletionItemInsertTextRule: { InsertAsSnippet: 4 },
	}),
	editor: noopProxy({
		EndOfLineSequence: { LF: 0, CRLF: 1 },
		ScrollType: { Immediate: 1 },
		getEditors: () => [],
		getModels: () => [],
		getModel: () => null,
		createModel: () => null,
		onDidCreateModel: () => ({ dispose() {} }),
		setModelMarkers() {},
		getModelMarkers: () => [],
		registerEditorOpener: () => ({ dispose() {} }),
	}),
}));

/** What the dialogs were asked, in order, and what the test answers. */
let asked: string[] = [];
let askHandler: (prompt: string, initial?: string) => string | null = () => null;
let quickPickHandler: (options: { title?: string }) => unknown = () => null;
mock.module(resolve(import.meta.dir, "../src/view/dialogs.tsx"), () => ({
	ask: async (prompt: string, initial?: string) => {
		asked.push(prompt);
		return askHandler(prompt, initial);
	},
	choose: async (prompt: string) => {
		asked.push(prompt);
		return null;
	},
	quickPick: async (options: { title?: string }) => {
		asked.push(String(options.title));
		return quickPickHandler(options);
	},
	quickPickMany: async () => null,
	browseWorkspaceFile: async () => null,
}));

const { connect } = await import("../src/view/backend");
const { documents, setState, state } = await import("../src/view/state");
const { runCommand } = await import("../src/view/commands");
const templater = await import("../src/view/templater");

type RpcHandler = (method: string, args: unknown[]) => unknown | Promise<unknown>;
let rpcHandler: RpcHandler = () => null;
let failNextConnect = false;

class TestRpcSocket extends EventTarget {
	static CONNECTING = 0;
	static OPEN = 1;
	static CLOSING = 2;
	static CLOSED = 3;
	readyState = 0;
	constructor(_url: string) {
		super();
		queueMicrotask(() => {
			if (this.readyState === 3) return;
			if (failNextConnect) {
				this.readyState = 3;
				this.dispatchEvent(Object.assign(new Event("close"), { code: 1006 }));
			} else {
				this.readyState = 1;
				this.dispatchEvent(new Event("open"));
			}
		});
	}
	send(raw: string) {
		const { id, method, args } = JSON.parse(raw) as { id: number; method: string; args: unknown[] };
		Promise.resolve()
			.then(() => rpcHandler(method, args))
			.then(
				(result) => {
					if (this.readyState !== 1) return;
					this.dispatchEvent(new MessageEvent("message", { data: JSON.stringify({ id, result }) }));
				},
				(err: any) => {
					if (this.readyState !== 1) return;
					// As src/bun/web.ts answers a call that failed: the message, and nothing else of the error.
					this.dispatchEvent(new MessageEvent("message", { data: JSON.stringify({ id, error: String(err?.message ?? err) }) }));
				},
			);
	}
	close() {
		this.readyState = 3;
	}
}

let savedWebSocket: typeof globalThis.WebSocket;
let savedLocation: unknown;

async function connectTestRpc() {
	savedWebSocket = globalThis.WebSocket;
	savedLocation = (globalThis as any).location;
	(globalThis as any).WebSocket = TestRpcSocket;
	(globalThis as any).location = { protocol: "http:", host: "127.0.0.1:5196" };
	failNextConnect = false;
	await connect();
}

async function disconnectTestRpc() {
	failNextConnect = true;
	await connect().catch(() => {});
	failNextConnect = false;
	rpcHandler = () => null;
	(globalThis as any).WebSocket = savedWebSocket;
	(globalThis as any).location = savedLocation;
}

/** The window as it is with this folder open and no tab: its calls go to `backend`. */
function windowOn(root: string, backend: { api: Parameters<typeof dispatch>[0] }) {
	for (const doc of [...documents.values()]) doc.model?.dispose?.();
	documents.clear();
	asked = [];
	copied.length = 0;
	trashed.length = 0;
	askHandler = () => null;
	quickPickHandler = () => null;
	rpcHandler = (method, args) => dispatch(backend.api, method, args);
	setState((s) => {
		s.workspace = { root, name: "ws" };
		s.project = { root, path: join(root, ".ssl-studio", "project.toml"), configured: true, docs: "docs", plans: "design", schema: "schema" } as any;
		s.groups = [{ tabs: [], active: null }];
		s.activeGroup = 0;
		s.dirty = {};
		s.conflicts = {};
		s.messages = [];
		s.settings = structuredClone(DEFAULT_SETTINGS);
		s.centerView = "editors";
	});
	flush();
}

/** What the notices say now, each with its kind. */
function notices(): string[] {
	flush();
	return state.messages.map((m) => `${m.kind}: ${m.text}`);
}

/** Waits for what a command started and did not wait for. */
async function until(what: () => boolean, said: string) {
	for (let i = 0; i < 400; i++) {
		if (what()) return;
		await new Promise((r) => setTimeout(r, 5));
	}
	throw new Error(`waited two seconds for ${said}; the notices are ${JSON.stringify(notices())}`);
}

// ---------------------------------------------------------------------------------------------------------------
// B11-3b. The ER diagram command says which files it could not read
// ---------------------------------------------------------------------------------------------------------------

describe("B11-3b: the ER diagram is not drawn without a file's tables without a word", () => {
	beforeAll(connectTestRpc);
	afterAll(disconnectTestRpc);

	const TABLES_SQL = "CREATE TABLE samples (\n\tid INT PRIMARY KEY,\n\tname VARCHAR(40)\n);\n";
	const BIG_HEAD = "CREATE TABLE batches (\n\tid INT PRIMARY KEY,\n\tsample_id INT REFERENCES samples(id)\n);\n";
	const TOO_LARGE = "schema/big.sql is 21.0 MB: too large to open here (the most is 20.0 MB).";

	test("with one file too large to open, the diagram of the rest is offered and the notice names the file and why", async () => {
		const root = workspace("er-some", { "schema/tables.sql": TABLES_SQL });
		writeBig(join(root, "schema", "big.sql"), BIG_HEAD);
		const backend = await backendOn(root);
		try {
			windowOn(root, backend);
			quickPickHandler = () => "copy";
			runCommand("generate-er-diagram");
			await until(() => copied.length > 0, "the diagram to be copied");
			// The diagram is of what could be read: one table, and not the one in the large file.
			expect(asked).toEqual(["Mermaid ER diagram (1 table)"]);
			expect(copied[0]).toContain("samples {");
			expect(copied[0]).not.toContain("batches");
			await until(() => notices().some((n) => n.includes("Copied Mermaid ER diagram")), "the copy to be said");
			// It was drawn so without a word. The notice is an error's: it stays until it is dismissed.
			expect(notices()).toContain(`error: ${TOO_LARGE} The diagram is drawn without that file.`);
		} finally {
			backend.dispose();
		}
	});

	test("with no file that could be read, the notice says why and not only that nothing was found", async () => {
		const root = workspace("er-none");
		mkdirSync(join(root, "schema"), { recursive: true });
		writeBig(join(root, "schema", "big.sql"), BIG_HEAD);
		const backend = await backendOn(root);
		try {
			windowOn(root, backend);
			runCommand("generate-er-diagram");
			await until(() => notices().length > 0, "a notice");
			expect(notices()).toEqual([`error: ${TOO_LARGE} No readable SQL content was found in the selected files.`]);
			expect(asked).toEqual([]);
			expect(copied).toEqual([]);
		} finally {
			backend.dispose();
		}
	});

	test("with every file read, nothing more is said than before", async () => {
		const root = workspace("er-all", { "schema/tables.sql": TABLES_SQL, "schema/more.sql": BIG_HEAD });
		const backend = await backendOn(root);
		try {
			windowOn(root, backend);
			quickPickHandler = () => "copy";
			runCommand("generate-er-diagram");
			await until(() => notices().some((n) => n.includes("Copied Mermaid ER diagram")), "the copy to be said");
			expect(asked).toEqual(["Mermaid ER diagram (2 tables)"]);
			expect(notices()).toEqual(["info: Copied Mermaid ER diagram (2 tables)."]);
		} finally {
			backend.dispose();
		}
	});

	test("an ER-Diagram.md that is there and too large to open is not written over: nothing is saved", async () => {
		const root = workspace("er-save", { "schema/tables.sql": TABLES_SQL });
		const dest = join(root, "schema", "database", "ER-Diagram.md");
		mkdirSync(join(root, "schema", "database"), { recursive: true });
		writeBig(dest, "# Database ER Diagram\n\nNotes kept by hand.\n");
		const backend = await backendOn(root);
		try {
			windowOn(root, backend);
			quickPickHandler = () => "save";
			runCommand("generate-er-diagram");
			await until(() => notices().length > 0, "a notice");
			// It was taken for no file, and the new diagram was written over the whole of it.
			expect(statSync(dest).size).toBe(BIG_BYTES);
			expect(notices()).toEqual(["error: schema/database/ER-Diagram.md is 21.0 MB: too large to open here (the most is 20.0 MB). The diagram was not saved: nothing was written."]);
		} finally {
			backend.dispose();
		}
	});
});

// ---------------------------------------------------------------------------------------------------------------
// B5-6. New from template: a target that is there is found before the template's questions are asked
// ---------------------------------------------------------------------------------------------------------------

describe("B5-6: a new note from a template", () => {
	beforeAll(connectTestRpc);
	afterAll(disconnectTestRpc);

	const template = {
		id: "probe",
		name: "Probe",
		description: "A template that asks one thing of its own",
		group: "Custom" as const,
		source: "workspace" as const,
		content: '# <% tp.file.title %>\n\nOwner: <% tp.system.prompt("Owner of the note") %>\n',
	};
	const answers = (target: string) => (prompt: string) => (prompt.startsWith("Title for new") ? "Big note" : prompt.startsWith("Where to save") ? target : "the lab");

	test("a target too large to open is there: the template's own question is not asked, and nothing is made", async () => {
		const root = workspace("note-big");
		const dest = join(root, "docs", "big-note.md");
		mkdirSync(join(root, "docs"), { recursive: true });
		writeBig(dest, "# A note that grew\n");
		const backend = await backendOn(root);
		try {
			windowOn(root, backend);
			askHandler = answers("docs/big-note.md");
			await templater.newNoteFromTemplate(template);
			// The owner was asked for, and only then did making the file fail with "already exists".
			expect(asked).toEqual(["Title for new Probe", "Where to save the new note (path in workspace)"]);
			expect(notices()).toContain("info: docs/big-note.md already exists — opened it instead.");
			expect(notices().some((n) => n.includes("Could not create note from template"))).toBe(false);
			expect(statSync(dest).size).toBe(BIG_BYTES);
		} finally {
			backend.dispose();
		}
	});

	test("a folder of the target's name is there too", async () => {
		const root = workspace("note-folder");
		mkdirSync(join(root, "docs", "big-note.md"), { recursive: true });
		const backend = await backendOn(root);
		try {
			windowOn(root, backend);
			askHandler = answers("docs/big-note.md");
			await templater.newNoteFromTemplate(template);
			expect(asked).toEqual(["Title for new Probe", "Where to save the new note (path in workspace)"]);
			expect(notices()).toContain("info: docs/big-note.md already exists — opened it instead.");
		} finally {
			backend.dispose();
		}
	});

	test("a target that is not there is made, with the template's question answered", async () => {
		const root = workspace("note-new");
		const backend = await backendOn(root);
		try {
			windowOn(root, backend);
			askHandler = answers("docs/notes/big-note");
			await templater.newNoteFromTemplate(template);
			expect(asked).toEqual(["Title for new Probe", "Where to save the new note (path in workspace)", "Owner of the note"]);
			expect(readFileSync(join(root, "docs", "notes", "big-note.md"), "utf8")).toBe("# Big note\n\nOwner: the lab\n");
			expect(notices().filter((n) => n.includes("already exists") || n.includes("Could not create"))).toEqual([]);
		} finally {
			backend.dispose();
		}
	});
});

describe("B5-6: a file made for a text is not left empty when the text could not be written", () => {
	const diskFull = () => Promise.reject(new Error("ENOSPC: no space left on device, write"));

	test("the empty file is taken away again, and the write's error is the one told", async () => {
		const root = workspace("make-fails");
		const dest = join(root, "docs", "templates", "ticket.md");
		const backend = await backendOn(root);
		try {
			trashed.length = 0;
			// The two calls as they were made: the file is left, empty, to be found by the next try.
			const left = join(root, "docs", "templates", "left.md");
			await backend.api.create(left, "file");
			await diskFull().catch(() => {});
			expect(statSync(left).size).toBe(0);

			await expect(templater.createWithText({ ...backend.api, write: diskFull }, dest, "# Ticket\n")).rejects.toThrow("ENOSPC: no space left on device, write");
			expect(existsSync(dest)).toBe(false);
			expect(trashed).toEqual([dest]);
			// So the next try is not told "already exists", and makes it.
			await templater.createWithText(backend.api, dest, "# Ticket\n");
			expect(readFileSync(dest, "utf8")).toBe("# Ticket\n");
		} finally {
			backend.dispose();
		}
	});

	test("what is already there is refused before anything is written, and stays as it is", async () => {
		const root = workspace("make-there", { "docs/templates/ticket.md": "# Mine\n" });
		const dest = join(root, "docs", "templates", "ticket.md");
		const backend = await backendOn(root);
		try {
			trashed.length = 0;
			await expect(templater.createWithText(backend.api, dest, "# Ticket\n")).rejects.toThrow("already exists: docs/templates/ticket.md");
			expect(readFileSync(dest, "utf8")).toBe("# Mine\n");
			expect(trashed).toEqual([]);
		} finally {
			backend.dispose();
		}
	});

	test("a file that holds something after a write that said it failed is not taken away", async () => {
		const root = workspace("make-half");
		const dest = join(root, "docs", "note.md");
		const backend = await backendOn(root);
		try {
			trashed.length = 0;
			// The text got there, and what failed came after it (the local history of it, say).
			const wroteThenFailed = async (path: string, text: string) => {
				await backend.api.write(path, text);
				throw new Error("the history could not be kept");
			};
			await expect(templater.createWithText({ ...backend.api, write: wroteThenFailed }, dest, "# Note\n")).rejects.toThrow("the history could not be kept");
			expect(readFileSync(dest, "utf8")).toBe("# Note\n");
			expect(trashed).toEqual([]);
		} finally {
			backend.dispose();
		}
	});

	test("where nothing can be put in the trash (the browser host) the write's error is still the one told", async () => {
		const root = workspace("make-web");
		const dest = join(root, "docs", "note.md");
		const backend = await backendOn(root, false);
		try {
			await expect(templater.createWithText({ ...backend.api, write: diskFull }, dest, "# Note\n")).rejects.toThrow("ENOSPC: no space left on device, write");
			// Left as before: there is no call that takes a file away there.
			expect(statSync(dest).size).toBe(0);
		} finally {
			backend.dispose();
		}
	});

	test("all three places that make a file from a template go through it (held by source text)", () => {
		const src = readSrc("../src/view/templater.ts");
		expect(src.match(/await createWithText\(backend, dest, /g)?.length).toBe(3);
		// The only `create` left is the one inside it.
		expect(src.match(/\.create\(/g)?.length).toBe(1);
		const fn = src.slice(src.indexOf("export async function newNoteFromTemplate"), src.indexOf("export async function manageTemplates"));
		expect(fn).toContain("const alreadyExists = await fileExists(dest);");
		expect(fn).not.toContain(".read(dest)");
		expect(fn.indexOf("await fileExists(dest)")).toBeLessThan(fn.indexOf("renderTemplate(tpl.content"));
	});
});
