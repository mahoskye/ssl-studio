import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFrameReader, frame } from "../src/bun/frames";
import { History } from "../src/bun/history";
import { merge } from "../src/bun/settings";
import { compareVersions } from "../src/bun/tools";
import { WorkspaceFiles } from "../src/bun/workspace";

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
