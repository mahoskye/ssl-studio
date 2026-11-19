import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFrameReader, frame } from "../src/bun/frames";
import { History } from "../src/bun/history";
import { merge } from "../src/bun/settings";
import { compareVersions } from "../src/bun/tools";
import { WorkspaceFiles } from "../src/bun/workspace";
import { fitWindow } from "../src/bun/window";

const dir = mkdtempSync(join(tmpdir(), "ssl-studio-test-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe("LSP framing", () => {
	test("splits messages across and within chunks", () => {
		const got: string[] = [];
		const read = createFrameReader((m) => got.push(m));
		const bytes = new TextEncoder().encode(frame('{"a":"é"}') + frame('{"b":2}'));
		read(bytes.subarray(0, 7));
		read(bytes.subarray(7, 30));
		read(bytes.subarray(30));
		expect(got).toEqual(['{"a":"é"}', '{"b":2}']);
	});
});

describe("workspace files", () => {
	const root = join(dir, "ws");
	mkdirSync(join(root, "sub"), { recursive: true });
	mkdirSync(join(root, "node_modules"), { recursive: true });
	writeFileSync(join(root, "sub", "A.ssl"), ":RETURN 1;\n");
	writeFileSync(join(root, "b.ssl"), "x := 1;\nfind me\n");
	const files = new WorkspaceFiles(root);

	test("refuses paths outside the root", () => {
		expect(() => files.inside(join(root, "..", "elsewhere"))).toThrow(/outside/);
		expect(() => files.inside(root + "-sibling")).toThrow(/outside/);
		expect(files.inside(join(root, "sub", "..", "b.ssl"))).toBe(join(root, "b.ssl"));
	});
	test("lists folders first and skips tool folders", () => {
		expect(files.list(root).map((e) => e.name)).toEqual(["sub", "b.ssl"]);
	});
	test("writes atomically and reads back", async () => {
		await files.write(join(root, "b.ssl"), "new text\n");
		expect((await files.read(join(root, "b.ssl"))).text).toBe("new text\n");
	});
	test("searches", async () => {
		await files.write(join(root, "b.ssl"), "x := 1;\nfind me\n");
		const hits = await files.search("FIND", {});
		expect(hits).toEqual([{ path: join(root, "b.ssl"), line: 2, column: 1, length: 4, text: "find me" }]);
		expect(await files.search("FIND", { caseSensitive: true })).toEqual([]);
	});
});

describe("copying in the workspace", () => {
	const root = join(dir, "copy-ws");
	mkdirSync(join(root, "src", "deep"), { recursive: true });
	writeFileSync(join(root, "src", "a.ssl"), ":RETURN 1;\n");
	writeFileSync(join(root, "src", "deep", "b.ssl"), ":RETURN 2;\n");
	const files = new WorkspaceFiles(root);

	test("a file is copied, and the original stays", async () => {
		files.copy(join(root, "src", "a.ssl"), join(root, "src", "a copy.ssl"));
		expect((await files.read(join(root, "src", "a copy.ssl"))).text).toBe(":RETURN 1;\n");
		expect((await files.read(join(root, "src", "a.ssl"))).text).toBe(":RETURN 1;\n");
	});
	test("a folder is copied with everything in it", async () => {
		files.copy(join(root, "src"), join(root, "src copy"));
		expect((await files.read(join(root, "src copy", "deep", "b.ssl"))).text).toBe(":RETURN 2;\n");
	});
	test("a copy into a folder that is not there yet makes the folder", async () => {
		files.copy(join(root, "src", "a.ssl"), join(root, "new", "a.ssl"));
		expect((await files.read(join(root, "new", "a.ssl"))).text).toBe(":RETURN 1;\n");
	});
	test("nothing is written over", () => {
		expect(() => files.copy(join(root, "src", "a.ssl"), join(root, "src", "deep", "b.ssl"))).toThrow(/already exists/);
	});
	test("a folder is not copied into itself", () => {
		expect(() => files.copy(join(root, "src"), join(root, "src", "deep", "src"))).toThrow(/into itself/);
	});
	test("nothing is copied from or to outside the workspace", () => {
		expect(() => files.copy(join(root, "..", "ws", "b.ssl"), join(root, "b.ssl"))).toThrow(/outside/);
		expect(() => files.copy(join(root, "src", "a.ssl"), join(root, "..", "a.ssl"))).toThrow(/outside/);
	});
});

describe("files that are not text", () => {
	const root = join(dir, "kinds-ws");
	mkdirSync(root, { recursive: true });
	// The smallest picture there is: one clear pixel.
	const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==", "base64");
	writeFileSync(join(root, "dot.png"), png);
	writeFileSync(join(root, "blob.bin"), Buffer.from([1, 2, 0, 3, 4]));
	writeFileSync(join(root, "a.ssl"), ":RETURN 1;\r\n");
	writeFileSync(join(root, "wide.sql"), Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from("SELECT 1", "utf16le")]));
	const files = new WorkspaceFiles(root);

	test("text says what it is written in", async () => {
		expect(await files.read(join(root, "a.ssl"))).toMatchObject({ text: ":RETURN 1;\r\n", encoding: "utf-8" });
		expect(await files.read(join(root, "wide.sql"))).toMatchObject({ text: "SELECT 1", encoding: "utf-16le" });
		expect((await files.read(join(root, "a.ssl"))).binary).toBeUndefined();
	});
	test("a picture is not read as text, and says it is a picture", async () => {
		const read = await files.read(join(root, "dot.png"));
		expect(read.text).toBe("");
		expect(read.binary).toEqual({ size: png.length, image: "image/png" });
	});
	test("other bytes are not read as text either", async () => {
		const read = await files.read(join(root, "blob.bin"));
		expect(read.text).toBe("");
		expect(read.binary).toEqual({ size: 5 });
	});
	test("a picture's bytes are given to be shown", async () => {
		expect(await files.image(join(root, "dot.png"))).toEqual({ type: "image/png", base64: png.toString("base64") });
	});
	test("only a picture is given that way, and only from inside the workspace", async () => {
		await expect(files.image(join(root, "a.ssl"))).rejects.toThrow(/not a picture/);
		await expect(files.image(join(root, "blob.bin"))).rejects.toThrow(/not a picture/);
		expect(() => files.inside(join(root, "..", "dot.png"))).toThrow(/outside/);
	});
	test("text is never written over a file that is not text", async () => {
		await expect(files.write(join(root, "dot.png"), "")).rejects.toThrow(/not text/);
		await expect(files.write(join(root, "blob.bin"), "oops")).rejects.toThrow(/not text/);
		expect(new Uint8Array(await Bun.file(join(root, "blob.bin")).arrayBuffer())).toEqual(new Uint8Array([1, 2, 0, 3, 4]));
		expect(Buffer.from(await Bun.file(join(root, "dot.png")).arrayBuffer()).equals(png)).toBe(true);
	});
});

describe("local history", () => {
	test("records changed saves only, newest first", async () => {
		const history = new History(join(dir, "ws"), join(dir, "history"));
		const path = join(dir, "ws", "b.ssl");
		await history.record(path, "one", 1000);
		await history.record(path, "one", 2000);
		await history.record(path, "two", 3000);
		const list = history.list(path);
		expect(list.map((s) => s.time)).toEqual([3000, 1000]);
		expect(await history.read(path, list[1]!.id)).toBe("one");
		await expect(history.read(path, "../x")).rejects.toThrow();
	});
});

describe("settings", () => {
	test("workspace overrides user, objects merge", () => {
		const s = merge({ fontSize: 15, limits: { bytes: 1, codeLines: 2, historyEntries: 3 } }, { fontSize: 11, layout: { left: false } as any });
		expect(s.fontSize).toBe(11);
		expect(s.limits.bytes).toBe(1);
		expect(s.layout.left).toBe(false);
		expect(s.layout.leftWidth).toBe(260);
	});
});

test("version comparison", () => {
	expect(compareVersions("2.2.5", "2.3.0")).toBeLessThan(0);
	expect(compareVersions("2.10.0", "2.3.0")).toBeGreaterThan(0);
	expect(compareVersions("0.28.2", "0.28.2")).toBe(0);
});

test("the style preset sits under the overrides", () => {
	const house = merge({ ssl: { format: { maxLineLength: 120 } } });
	expect(house.ssl.format.indentStyle).toBe("tab");
	expect(house.ssl.format.maxLineLength).toBe(120);
	const server = merge({ stylePreset: "server", ssl: { format: { maxLineLength: 120 } } });
	expect(server.ssl).toEqual({ format: { maxLineLength: 120 } });
});

describe("the first window frame", () => {
	test("keeps 1400 by 900 on a large screen", () => {
		expect(fitWindow({ x: 0, y: 0, width: 2560, height: 1400 })).toEqual({ x: 80, y: 60, width: 1400, height: 900 });
	});
	test("fills a small screen's work area", () => {
		expect(fitWindow({ x: 0, y: 0, width: 1280, height: 752 })).toEqual({ x: 0, y: 0, width: 1280, height: 752 });
	});
	test("moves in only as far as the screen allows", () => {
		expect(fitWindow({ x: 0, y: 30, width: 1440, height: 870 })).toEqual({ x: 40, y: 30, width: 1400, height: 870 });
	});
	test("an unknown screen keeps the wanted frame", () => {
		expect(fitWindow({ x: 0, y: 0, width: 0, height: 0 })).toEqual({ x: 80, y: 60, width: 1400, height: 900 });
	});
});
