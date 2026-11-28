import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { decode, decodePart, encode, encodingOf } from "../src/bun/encoding";
import { listDocs, readExport, readProject } from "../src/bun/project";
import { WorkspaceFiles } from "../src/bun/workspace";

// A fifth review (2026-11-19): a file is written back in what it was written in.

describe("what a file is written in", () => {
	test("is told by its mark, and failing a mark by whether it reads as UTF-8", () => {
		expect(encodingOf(Buffer.from("plain"))).toBe("utf-8");
		expect(encodingOf(Buffer.from("café"))).toBe("utf-8");
		expect(encodingOf(Buffer.from([0xef, 0xbb, 0xbf, 0x61]))).toBe("utf-8-bom");
		expect(encodingOf(Buffer.from([0xff, 0xfe, 0x61, 0x00]))).toBe("utf-16le");
		expect(encodingOf(Buffer.from([0xfe, 0xff, 0x00, 0x61]))).toBe("utf-16be");
		expect(encodingOf(Buffer.from([0x63, 0x61, 0x66, 0xe9]))).toBe("windows-1252");
		expect(encodingOf(new Uint8Array())).toBe("utf-8");
	});
	test("every encoding reads back what it wrote, byte for byte", () => {
		const text = "SELECT 'café – “x”' -- €\n";
		for (const encoding of ["utf-8", "utf-8-bom", "utf-16le", "utf-16be", "windows-1252"] as const) {
			const bytes = encode(text, encoding);
			expect(decode(bytes)).toEqual({ text, encoding });
			expect(Buffer.from(encode(decode(bytes).text, encoding)).equals(Buffer.from(bytes))).toBe(true);
		}
	});
	test("a mark alone is an empty text, and a mark the person typed is part of the text", () => {
		expect(decode(Buffer.from([0xff, 0xfe]))).toEqual({ text: "", encoding: "utf-16le" });
		expect(decode(Buffer.from([0xef, 0xbb, 0xbf]))).toEqual({ text: "", encoding: "utf-8-bom" });
		const twice = Buffer.from([0xef, 0xbb, 0xbf, 0xef, 0xbb, 0xbf, 0x61]);
		expect(decode(twice).text).toBe("﻿a");
		expect(Buffer.from(encode(decode(twice).text, "utf-8-bom")).equals(twice)).toBe(true);
	});
	test("UTF-16 with a byte left over is said to be cut short, not read as something else", () => {
		expect(() => decode(Buffer.from([0xfe, 0xff, 0x00, 0x61, 0x00]))).toThrow("has a byte left over");
		expect(() => decode(Buffer.from([0xff, 0xfe, 0x61]))).toThrow("has a byte left over");
	});
	test("a character the one-byte encoding cannot write is refused, by name", () => {
		expect(() => encode("an arrow → here", "windows-1252")).toThrow("has no way to write “→”");
	});
});

describe("a file in the folder is written back as it was", () => {
	test("a file from an older tool on Windows keeps its bytes, and an edit changes only what was edited", async () => {
		const root = mkdtempSync(join(tmpdir(), "ssl-studio-ansi-"));
		try {
			const files = new WorkspaceFiles(root);
			// "café – x" in Windows-1252: é is E9, the dash is 96.
			writeFileSync(join(root, "old.sql"), Buffer.from([0x63, 0x61, 0x66, 0xe9, 0x20, 0x96, 0x20, 0x78, 0x0a]));
			const read = (await files.read(join(root, "old.sql"))).text;
			expect(read).toBe("café – x\n");
			await files.write(join(root, "old.sql"), read.replace("x", "y"));
			expect([...readFileSync(join(root, "old.sql"))]).toEqual([0x63, 0x61, 0x66, 0xe9, 0x20, 0x96, 0x20, 0x79, 0x0a]);
			// What it cannot hold is refused, and the file is left as it was.
			await expect(files.write(join(root, "old.sql"), "café → x\n")).rejects.toThrow("old.sql: It is saved in Windows-1252");
			expect([...readFileSync(join(root, "old.sql"))]).toEqual([0x63, 0x61, 0x66, 0xe9, 0x20, 0x96, 0x20, 0x79, 0x0a]);
			// A new file, and one that is UTF-8, are UTF-8.
			await files.write(join(root, "new.md"), "café → x\n");
			expect(readFileSync(join(root, "new.md"), "utf8")).toBe("café → x\n");
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});
	test("a file that is not text says so with its name, and is not opened as something else", async () => {
		const root = mkdtempSync(join(tmpdir(), "ssl-studio-odd-"));
		try {
			writeFileSync(join(root, "cut.sql"), Buffer.from([0xfe, 0xff, 0x00, 0x61, 0x00]));
			await expect(new WorkspaceFiles(root).read(join(root, "cut.sql"))).rejects.toThrow("cut.sql: It opens as UTF-16 and has a byte left over");
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});
});

describe("an export as a spreadsheet on Windows saves it", () => {
	test("is read in what it was written in, from a path written as a person writes one", async () => {
		const dir = mkdtempSync(join(tmpdir(), "ssl-studio-export-enc-"));
		try {
			// "Key,Summary\nA-1,Café" in Windows-1252, and the same in UTF-16 with its high byte first.
			writeFileSync(join(dir, "ansi.csv"), Buffer.from([...Buffer.from("Key,Summary\nA-1,Caf"), 0xe9, 0x0a]));
			writeFileSync(join(dir, "wide.csv"), encode("Key,Summary\nA-1,Café\n", "utf-16be"));
			expect(await readExport(join(dir, "ansi.csv"))).toBe("Key,Summary\nA-1,Café\n");
			expect(await readExport(join(dir, "wide.csv"))).toBe("Key,Summary\nA-1,Café\n");
			expect(await readExport(`"${join(dir, "ansi.csv")}"`)).toBe("Key,Summary\nA-1,Café\n");
			await expect(readExport("~/no-such-folder-ssl-studio/x.csv")).rejects.toThrow("is not there.");
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});

// A sixth review (2026-11-19).
describe("a file read for a listing is read as the editor reads it", () => {
	test("a mark for UTF-8 over bytes that are not UTF-8 saves back as it was", async () => {
		const root = mkdtempSync(join(tmpdir(), "ssl-studio-bom-"));
		try {
			const bytes = [0xef, 0xbb, 0xbf, 0x2f, 0x2a, 0x20, 0xe9, 0x20, 0x2a, 0x2f];
			writeFileSync(join(root, "odd.ssl"), Buffer.from(bytes));
			expect(encodingOf(Buffer.from(bytes))).toBe("windows-1252");
			const files = new WorkspaceFiles(root);
			await files.write(join(root, "odd.ssl"), (await files.read(join(root, "odd.ssl"))).text);
			expect([...readFileSync(join(root, "odd.ssl"))]).toEqual(bytes);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});
	test("a save is written in the encoding the text was read in, though the file on disk has come to say nothing of it", async () => {
		const root = mkdtempSync(join(tmpdir(), "ssl-studio-kept-encoding-"));
		try {
			const path = join(root, "temp.ssl");
			// "/* 37°C ;" in Windows-1252: the degree sign is one byte, 0xB0.
			writeFileSync(path, Buffer.from([...Buffer.from("/* 37"), 0xb0, ...Buffer.from("C ;\n")]));
			const files = new WorkspaceFiles(root);
			const read = await files.read(path);
			expect(read.encoding).toBe("windows-1252");
			// The degree sign taken out and saved: the file is plain ASCII, which reads as UTF-8 too.
			await files.write(path, "/* 37 C ;\n", true, read.encoding);
			expect(encodingOf(readFileSync(path))).toBe("utf-8");
			// Saved again with a micro sign: one byte, as the editor said it would be, and not UTF-8's two.
			await files.write(path, "/* 5 µL ;\n", true, read.encoding);
			expect([...readFileSync(path)]).toEqual([...Buffer.from("/* 5 "), 0xb5, ...Buffer.from("L ;\n")]);
			// With no encoding said, the file's is worked out from its bytes, as before: these are Windows-1252's.
			await files.write(path, "/* 6 µL ;\n", true);
			expect([...readFileSync(path)]).toEqual([...Buffer.from("/* 6 "), 0xb5, ...Buffer.from("L ;\n")]);
			// A name that is no encoding is passed over.
			await files.write(path, "/* 7 µL ;\n", true, "latin-9");
			expect(readFileSync(path)[5]).toBe(0xb5);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});
	test("the start of a file may end in the middle of a character", () => {
		const whole = Buffer.from("# Café au lait");
		expect(decodePart(whole.subarray(0, 6))).toBe("# Caf");
		expect(decodePart(whole)).toBe("# Café au lait");
		// A whole file that ends on such a byte is in the one-byte encoding, and the byte is its last letter.
		expect(decodePart(Buffer.from([0x23, 0x20, 0x43, 0x61, 0x66, 0xe9]), false)).toBe("# Café");
		expect(decodePart(encode("# Café", "utf-16be"), false)).toBe("# Café");
	});
	test("a ticket in the one-byte Windows encoding is listed and found by its own letters", async () => {
		const root = mkdtempSync(join(tmpdir(), "ssl-studio-listing-"));
		try {
			mkdirSync(join(root, "docs", "tickets"), { recursive: true });
			writeFileSync(join(root, "docs", "tickets", "T-1.md"), Buffer.from([...Buffer.from("# Caf"), 0xe9, ...Buffer.from(" hours\n\nOpen at eight.\n")]));
			const files = new WorkspaceFiles(root);
			const list = await listDocs(files, await readProject(root));
			expect(list.find((file) => file.name === "T-1.md")?.title).toBe("Café hours");
			expect((await files.search("café", {})).map((hit) => hit.text)).toEqual(["# Café hours"]);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});
});
