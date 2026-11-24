import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Agent } from "../src/bun/agent";
import { createFrameReader, frame, MAX_HEADER_BYTES, MAX_MESSAGE_BYTES } from "../src/bun/frames";
import { History, historyKey, MAX_SNAPSHOT_BYTES } from "../src/bun/history";
import { LspProcess } from "../src/bun/lsp";
import { dirs, resolveDirs } from "../src/bun/paths";
import { merge, recent, SettingsStore, USER_ONLY_SETTINGS } from "../src/bun/settings";
import { fileUriForDbus, openFileCommand } from "../src/bun/system";
import { compareVersions } from "../src/bun/tools";
import { fitWindow } from "../src/bun/window";
import { HOUSE_STYLE } from "../src/shared/styleProfile";

const rootTmp = mkdtempSync(join(tmpdir(), "ssl-studio-r1b-"));
afterAll(() => rmSync(rootTmp, { recursive: true, force: true }));

function withTempDirs<T>(fn: (d: { config: string; data: string; state: string }) => Promise<T> | T): Promise<T> {
	const prev = { ...dirs };
	const sandbox = mkdtempSync(join(rootTmp, "dirs-"));
	const next = {
		config: join(sandbox, "config"),
		data: join(sandbox, "data"),
		state: join(sandbox, "state"),
	};
	dirs.config = next.config;
	dirs.data = next.data;
	dirs.state = next.state;
	return Promise.resolve()
		.then(() => fn(next))
		.finally(() => {
			dirs.config = prev.config;
			dirs.data = prev.data;
			dirs.state = prev.state;
		});
}

describe("settings security, shape safety, atomic saves, and themes", () => {
	test("USER_ONLY_SETTINGS contains executable, server, billing trust, and keybinding keys", () => {
		expect([...USER_ONLY_SETTINGS].sort()).toEqual(["agentModel", "agentOwnModels", "agentServerConfig", "agentServerUrl", "keys", "lspPath"]);
	});

	test("load() strips USER_ONLY_SETTINGS from workspace layer while honoring user layer", async () => {
		await withTempDirs(async ({ config }) => {
			const ws = join(rootTmp, "ws-untrusted");
			mkdirSync(join(ws, ".ssl-studio"), { recursive: true });
			mkdirSync(config, { recursive: true });
			writeFileSync(
				join(config, "settings.json"),
				JSON.stringify({
					lspPath: "/safe/user/starlims-lsp",
					agentServerUrl: "http://127.0.0.1:4096",
					fontSize: 14,
				}),
			);
			writeFileSync(
				join(ws, ".ssl-studio", "settings.json"),
				JSON.stringify({
					lspPath: "/evil/workspace/pwn.sh",
					agentServerUrl: "https://attacker.invalid",
					agentServerConfig: '{"provider":"evil"}',
					agentOwnModels: ["openai/gpt-5"],
					fontSize: 16,
				}),
			);
			const store = new SettingsStore(() => ws);
			const loaded = await store.load();
			expect(loaded.workspace).toEqual({ fontSize: 16 });
			expect(loaded.effective.fontSize).toBe(16);
			expect(loaded.effective.lspPath).toBe("/safe/user/starlims-lsp");
			expect(loaded.effective.agentServerUrl).toBe("http://127.0.0.1:4096");
			expect(loaded.effective.agentServerConfig).toBeUndefined();
			expect(loaded.effective.agentOwnModels).toBeUndefined();
		});
	});

	test("save() strips USER_ONLY_SETTINGS for workspace scope and allows them for user scope", async () => {
		await withTempDirs(async ({ config }) => {
			const ws = join(rootTmp, "ws-save-strip");
			mkdirSync(ws, { recursive: true });
			const store = new SettingsStore(() => ws);

			const effectiveWs = await store.save("workspace", {
				lspPath: "/evil/lsp",
				agentServerUrl: "https://evil.invalid",
				agentServerConfig: '{"bad":true}',
				agentOwnModels: ["openrouter/paid"],
				fontSize: 15,
			});
			expect(effectiveWs.fontSize).toBe(15);
			expect(effectiveWs.lspPath).toBeUndefined();
			expect(effectiveWs.agentServerUrl).toBeUndefined();
			expect(effectiveWs.agentServerConfig).toBeUndefined();
			expect(effectiveWs.agentOwnModels).toBeUndefined();
			expect(JSON.parse(readFileSync(join(ws, ".ssl-studio", "settings.json"), "utf8"))).toEqual({ fontSize: 15 });

			const effectiveUser = await store.save("user", {
				lspPath: "/usr/local/bin/starlims-lsp",
				agentOwnModels: ["local/qwen3"],
			});
			expect(effectiveUser.lspPath).toBe("/usr/local/bin/starlims-lsp");
			expect(effectiveUser.agentOwnModels).toEqual(["local/qwen3"]);
			expect(JSON.parse(readFileSync(join(config, "settings.json"), "utf8"))).toEqual({
				lspPath: "/usr/local/bin/starlims-lsp",
				agentOwnModels: ["local/qwen3"],
			});
		});
	});

	test("load() ignores non-object JSON files (null, arrays, primitives)", async () => {
		await withTempDirs(async ({ config }) => {
			const ws = join(rootTmp, "ws-bad-json-shape");
			mkdirSync(join(ws, ".ssl-studio"), { recursive: true });
			mkdirSync(config, { recursive: true });
			const store = new SettingsStore(() => ws);

			for (const bad of ["null", "[1, 2, 3]", '"hello"', "42", "true"]) {
				writeFileSync(join(config, "settings.json"), bad);
				writeFileSync(join(ws, ".ssl-studio", "settings.json"), bad);
				const loaded = await store.load();
				expect(loaded.user).toEqual({});
				expect(loaded.workspace).toEqual({});
				expect(loaded.effective.theme).toBe("system");
				expect(loaded.effective.layout.left).toBe(true);
				expect(loaded.effective.limits.codeLines).toBe(400);
			}
		});
	});

	test("merge() resists prototype pollution, null values, and wrong-typed top-level fields", () => {
		const poisoned = JSON.parse(
			'{"__proto__":{"polluted":true},"constructor":{"prototype":{"polluted2":true}},"ssl":{"__proto__":{"pollutedSsl":true},"format":{"indentStyle":"space"}},"layout":{"__proto__":{"pollutedLayout":true},"left":false}}',
		);
		const merged = merge(
			{ theme: "dark", fontSize: 15, regionColors: { Init: "#112233" }, keys: { "ctrl+s": "save" }, limits: { bytes: 100, codeLines: 50, historyEntries: 5 } },
			{ theme: null, layout: null, limits: null, regionColors: null, keys: null, ssl: null } as any,
			{ theme: 123, layout: "bad", limits: [1], regionColors: "red", keys: 99, ssl: "nope", fontSize: "huge", stylePreset: "unknown" } as any,
			poisoned,
		);
		expect(({} as any).polluted).toBeUndefined();
		expect(({} as any).polluted2).toBeUndefined();
		expect(({} as any).pollutedSsl).toBeUndefined();
		expect(({} as any).pollutedLayout).toBeUndefined();
		expect(Object.getPrototypeOf(merged)).toBe(Object.prototype);
		expect(Object.getPrototypeOf(merged.ssl)).toBe(Object.prototype);
		expect(Object.getPrototypeOf(merged.layout)).toBe(Object.prototype);
		expect(merged.theme).toBe("dark");
		expect(merged.fontSize).toBe(15);
		expect(merged.stylePreset).toBe("house");
		expect(merged.layout.left).toBe(false);
		expect(merged.layout.leftWidth).toBe(260);
		expect(merged.limits).toEqual({ bytes: 100, codeLines: 50, historyEntries: 5 });
		expect(merged.regionColors).toEqual({ Init: "#112233" });
		expect(merged.keys).toEqual({ "ctrl+s": "save" });
		expect(merged.ssl.format.indentStyle).toBe("space");
	});

	test("merge() deep-merges layout.dock and does not mutate HOUSE_STYLE", () => {
		const merged = merge(
			{ layout: { left: true, right: false, bottom: true, leftWidth: 260, rightWidth: 360, bottomHeight: 200, dock: { outline: "left", git: "right" } } },
			{ layout: { left: false, dock: { git: "left", search: "right" } } as any },
		);
		expect(merged.layout.left).toBe(false);
		expect(merged.layout.dock).toEqual({ outline: "left", git: "left", search: "right" });

		const invalidDock = merge(
			{ layout: { left: true, right: false, bottom: true, leftWidth: 260, rightWidth: 360, bottomHeight: 200, dock: { outline: "left" } } },
			{ layout: { dock: "bad" } as any },
		);
		expect(invalidDock.layout.dock).toEqual({ outline: "left" });

		// Mutating merged.ssl must never mutate the shared HOUSE_STYLE constant.
		const origIndent = HOUSE_STYLE.format.indentStyle;
		const origSqlEnabled = HOUSE_STYLE.format.sql.enabled;
		const origRule = HOUSE_STYLE.diagnostics.rules.c_style_comment_closer;
		const copy = merge({});
		copy.ssl.format.indentStyle = "space";
		copy.ssl.format.sql.enabled = false;
		copy.ssl.diagnostics.rules.c_style_comment_closer = "error";
		expect(HOUSE_STYLE.format.indentStyle).toBe(origIndent);
		expect(HOUSE_STYLE.format.sql.enabled).toBe(origSqlEnabled);
		expect(HOUSE_STYLE.diagnostics.rules.c_style_comment_closer).toBe(origRule);
	});

	test("recent() filters malformed shapes/non-strings and writes atomically under concurrency", async () => {
		await withTempDirs(async ({ state }) => {
			const dirA = join(rootTmp, "recent-a");
			const dirB = join(rootTmp, "recent-b");
			mkdirSync(dirA, { recursive: true });
			mkdirSync(dirB, { recursive: true });
			mkdirSync(state, { recursive: true });

			writeFileSync(join(state, "recent.json"), JSON.stringify({ not: "an array" }));
			expect(await recent()).toEqual([]);

			writeFileSync(join(state, "recent.json"), JSON.stringify([null, 42, {}, dirA, join(rootTmp, "missing-dir")]));
			expect(await recent()).toEqual([dirA]);

			await Promise.all([recent(dirA), recent(dirB), recent(dirA)]);
			expect(await recent()).toEqual([dirA, dirB]);
			expect(readdirSync(state)).toEqual(["recent.json"]);
		});
	});

	test("themes() skips non-files and unreadable entries; importTheme() sanitizes IDs and validates JSONC objects", async () => {
		await withTempDirs(async ({ config }) => {
			const themesDir = join(config, "themes");
			mkdirSync(join(themesDir, "subdir.json"), { recursive: true });
			writeFileSync(join(themesDir, "good.json"), '{"name":"Good Theme","colors":{}}\n');

			const unreadable = join(themesDir, "locked.json");
			writeFileSync(unreadable, '{"name":"Locked"}\n');
			if (process.platform !== "win32") chmodSync(unreadable, 0o000);

			const store = new SettingsStore(() => null);
			try {
				const loaded = await store.themes();
				const ids = loaded.map((t) => t.id);
				expect(ids).toContain("custom:good");
				expect(ids).not.toContain("custom:subdir");
			} finally {
				if (process.platform !== "win32") chmodSync(unreadable, 0o644);
			}

			const srcDir = join(rootTmp, "theme-src");
			mkdirSync(srcDir, { recursive: true });

			const dotSource = join(srcDir, ".hidden.jsonc");
			writeFileSync(dotSource, '{\n // comment\n "name": "Hidden",\n "colors": {},\n}\n');
			const importedHidden = await store.importTheme(dotSource);
			expect(importedHidden.id).toBe("custom:hidden");
			expect(importedHidden.name).toBe("Hidden");

			const dotsOnly = join(srcDir, "...json");
			writeFileSync(dotsOnly, '{"name":"Dots","colors":{}}');
			const importedDots = await store.importTheme(dotsOnly);
			expect(importedDots.id).toBe("custom:theme");

			const badArray = join(srcDir, "array.json");
			writeFileSync(badArray, "[1, 2, 3]");
			await expect(store.importTheme(badArray)).rejects.toThrow(/JSON object/);

			const badSyntax = join(srcDir, "broken.json");
			writeFileSync(badSyntax, "{ not json");
			await expect(store.importTheme(badSyntax)).rejects.toThrow(/not valid JSON/);

			// Atomic writes leave no temp files behind.
			expect(readdirSync(themesDir).filter((f) => f.endsWith(".tmp"))).toEqual([]);
		});
	});
});

describe("local history serialization, numeric sorting, stray file safety, and byte cap", () => {
	test("concurrent saves serialize cleanly, sort >10 same-ms numerically, ignore stray .txt, and avoid seq overwrite", async () => {
		const ws = join(rootTmp, "hist-ws");
		const base = join(rootTmp, "hist-base");
		mkdirSync(ws, { recursive: true });
		const file = join(ws, "Script.ssl");
		const history = new History(ws, base);

		// 13 distinct snapshots at the exact same millisecond, requested concurrently.
		await Promise.all(Array.from({ length: 13 }, (_, i) => history.record(file, `version-${i}`, 5000)));
		const list = history.list(file);
		expect(list.length).toBe(13);
		expect(list.map((s) => s.id)).toEqual([
			"5000-12",
			"5000-11",
			"5000-10",
			"5000-9",
			"5000-8",
			"5000-7",
			"5000-6",
			"5000-5",
			"5000-4",
			"5000-3",
			"5000-2",
			"5000-1",
			"5000-0",
		]);
		expect(await history.read(file, "5000-12")).toBe("version-12");

		// Place stray .txt files and remove 5000-0.txt; next seq for 5000 must be 13, not 12.
		const { rootKey, relKey } = historyKey(ws, file);
		const bucketDir = join(base, rootKey, relKey);
		writeFileSync(join(bucketDir, "notes.txt"), "stray");
		writeFileSync(join(bucketDir, "bad-seq.txt"), "stray");
		rmSync(join(bucketDir, "5000-0.txt"), { force: true });

		await history.record(file, "version-13", 5000);
		const after = history.list(file);
		expect(after[0]?.id).toBe("5000-13");
		expect(after.some((s) => s.id === "notes" || s.id === "bad-seq")).toBe(false);
		expect(await history.read(file, "5000-12")).toBe("version-12");
		expect(await history.read(file, "5000-13")).toBe("version-13");
		expect(readdirSync(bucketDir).filter((f) => f.endsWith(".tmp"))).toEqual([]);
	});

	test("skips snapshots exceeding MAX_SNAPSHOT_BYTES (2 MB)", async () => {
		const ws = join(rootTmp, "hist-cap-ws");
		const base = join(rootTmp, "hist-cap-base");
		mkdirSync(ws, { recursive: true });
		const file = join(ws, "Big.ssl");
		const history = new History(ws, base);

		const over = "a".repeat(MAX_SNAPSHOT_BYTES + 1);
		await history.record(file, over, 1000);
		expect(history.list(file)).toEqual([]);

		// Multi-byte UTF-8 under 2M characters but over 2 MB bytes must also be skipped.
		const overUtf8 = "é".repeat(Math.floor(MAX_SNAPSHOT_BYTES / 2) + 1);
		await history.record(file, overUtf8, 2000);
		expect(history.list(file)).toEqual([]);

		await history.record(file, "small", 3000);
		expect(history.list(file).length).toBe(1);
	});

	test("historyKey normalizes separators, relative segments, and case when caseInsensitive", () => {
		const a = historyKey("/work/demo/", "/work/demo/src/../src/Foo.ssl", true);
		const b = historyKey("/WORK/DEMO", "/work/demo/src/foo.ssl", true);
		expect(a.rootKey).toBe(b.rootKey);
		expect(a.relKey).toBe(b.relKey);
	});
});

describe("LSP framing safety and LspProcess resilience", () => {
	test("advances buffer before invoking a throwing onMessage callback (no re-delivery)", () => {
		const seen: string[] = [];
		let threw = false;
		const read = createFrameReader((body) => {
			seen.push(body);
			if (!threw) {
				threw = true;
				throw new Error("boom");
			}
		});
		const enc = new TextEncoder();
		expect(() => read(enc.encode(frame('{"id":1}')))).toThrow("boom");
		read(enc.encode(frame('{"id":2}')));
		expect(seen).toEqual(['{"id":1}', '{"id":2}']);
	});

	test("rejects unanchored X-Content-Length and oversized Content-Length cleanly", () => {
		const got: string[] = [];
		const read = createFrameReader((body) => got.push(body));
		const enc = new TextEncoder();

		// Unanchored X-Content-Length followed by real Content-Length on next line:
		read(enc.encode("X-Content-Length: 999\r\nContent-Length: 2\r\n\r\n{}"));
		expect(got).toEqual(["{}"]);

		// Standalone X-Content-Length header block is discarded:
		read(enc.encode("X-Content-Length: 5\r\n\r\n" + frame('{"ok":1}')));
		expect(got).toEqual(["{}", '{"ok":1}']);

		// Oversized Content-Length (> MAX_MESSAGE_BYTES and unsafe integer) is discarded without OOM/stall:
		read(enc.encode(`Content-Length: ${MAX_MESSAGE_BYTES + 1}\r\n\r\n` + frame('{"after":true}')));
		read(enc.encode("Content-Length: 999999999999999999999\r\n\r\n" + frame('{"afterBig":true}')));
		expect(got).toEqual(["{}", '{"ok":1}', '{"after":true}', '{"afterBig":true}']);

		// Oversized header block (> MAX_HEADER_BYTES) is dropped and parser resyncs:
		read(enc.encode("X-Junk: " + "a".repeat(MAX_HEADER_BYTES + 100) + "\r\n\r\n" + frame('{"resynced":1}')));
		expect(got.at(-1)).toBe('{"resynced":1}');
	});

	test("LspProcess survives a throwing onMessage callback and keeps delivering later frames", async () => {
		const fakeJs = join(rootTmp, "fake-lsp.js");
		writeFileSync(
			fakeJs,
			`process.stdout.write('Content-Length: 8\\r\\n\\r\\n{"id":1}Content-Length: 8\\r\\n\\r\\n{"id":2}');\nsetTimeout(() => {}, 250);\n`,
		);
		const fakeLsp = join(rootTmp, process.platform === "win32" ? "fake-lsp.cmd" : "fake-lsp.sh");
		if (process.platform === "win32") {
			writeFileSync(fakeLsp, `@echo off\r\n"${process.execPath}" "${fakeJs}" %*\r\n`);
		} else {
			writeFileSync(fakeLsp, `#!/bin/sh\nexec "${process.execPath}" "${fakeJs}" "$@"\n`);
			chmodSync(fakeLsp, 0o755);
		}

		const received: string[] = [];
		let doneResolve!: () => void;
		const done = new Promise<void>((r) => (doneResolve = r));
		const proc = new LspProcess(
			fakeLsp,
			(msg) => {
				received.push(msg);
				if (received.length === 1) throw new Error("handler error");
				if (received.length >= 2) doneResolve();
			},
			() => {},
		);
		try {
			proc.start();
			await Promise.race([done, new Promise((_, rej) => setTimeout(() => rej(new Error("timed out")), 3000))]);
			expect(received).toEqual(['{"id":1}', '{"id":2}']);
		} finally {
			proc.stop();
		}
	});
});

describe("paths XDG / AppData spec compliance", () => {
	test("ignores empty and relative XDG / AppData variables and honors absolute ones", () => {
		const linuxFallback = resolveDirs(
			{ XDG_CONFIG_HOME: "", XDG_DATA_HOME: "relative/data", XDG_STATE_HOME: "./state" },
			"linux",
			"/home/alice",
		);
		expect(linuxFallback).toEqual({
			config: "/home/alice/.config/ssl-studio",
			data: "/home/alice/.local/share/ssl-studio",
			state: "/home/alice/.local/state/ssl-studio",
		});

		const linuxAbs = resolveDirs(
			{ XDG_CONFIG_HOME: "/etc/xdg-custom", XDG_DATA_HOME: "/var/data", XDG_STATE_HOME: "/var/state" },
			"linux",
			"/home/alice",
		);
		expect(linuxAbs).toEqual({
			config: "/etc/xdg-custom/ssl-studio",
			data: "/var/data/ssl-studio",
			state: "/var/state/ssl-studio",
		});

		const winFallback = resolveDirs(
			{ APPDATA: "relative\\roaming", LOCALAPPDATA: "" },
			"win32",
			"C:\\Users\\alice",
		);
		expect(winFallback).toEqual({
			config: "C:\\Users\\alice\\AppData\\Roaming\\ssl-studio",
			data: "C:\\Users\\alice\\AppData\\Local\\ssl-studio",
			state: "C:\\Users\\alice\\AppData\\Local\\ssl-studio\\state",
		});

		const winAbs = resolveDirs(
			{ APPDATA: "D:\\Roaming", LOCALAPPDATA: "D:\\Local" },
			"win32",
			"C:\\Users\\alice",
		);
		expect(winAbs).toEqual({
			config: "D:\\Roaming\\ssl-studio",
			data: "D:\\Local\\ssl-studio",
			state: "D:\\Local\\ssl-studio\\state",
		});
	});
});

describe("system commands and file URI encoding", () => {
	test("Windows openFileCommand uses rundll32.exe instead of cmd.exe", () => {
		const tricky = "C:\\Work\\a & calc.exe | %TEMP%^test.pdf";
		const cmd = openFileCommand("win32", tricky);
		expect(cmd).toEqual(["rundll32.exe", "url.dll,FileProtocolHandler", tricky]);
		expect(cmd[0]!.toLowerCase()).not.toContain("cmd");
		expect(openFileCommand("darwin", "/tmp/a.pdf")).toEqual(["open", "/tmp/a.pdf"]);
		expect(openFileCommand("linux", "/tmp/a.pdf")).toEqual(["xdg-open", "/tmp/a.pdf"]);
	});

	test("fileUriForDbus encodes #, ?, %, spaces, and single quotes", () => {
		const uri = fileUriForDbus("/tmp/report #1?v=2's 100%.txt");
		expect(uri).toBe("file:///tmp/report%20%231%3Fv=2%27s%20100%25.txt");
		expect(uri).not.toContain("'");
		expect(uri).not.toContain("#");
		expect(uri).not.toContain("?");
	});
});

describe("version comparison and Agent startup / synchronous dispose", () => {
	const fakeOpencode = ["bun", join(import.meta.dir, "fake-opencode.ts")];
	let activeAgent: Agent | undefined;
	const origFakeVersion = process.env.FAKE_VERSION;

	afterEach(() => {
		activeAgent?.dispose();
		activeAgent = undefined;
		if (origFakeVersion === undefined) delete process.env.FAKE_VERSION;
		else process.env.FAKE_VERSION = origFakeVersion;
	});

	test("compareVersions returns NaN for pre-release and non-numeric inputs", () => {
		expect(Number.isNaN(compareVersions("2.2.0-beta", "2.2.5"))).toBe(true);
		expect(Number.isNaN(compareVersions("2.2.5-rc.1", "2.2.5"))).toBe(true);
		expect(Number.isNaN(compareVersions("dev", "2.2.5"))).toBe(true);
		expect(Number.isNaN(compareVersions("", "2.2.5"))).toBe(true);
		expect(Number.isNaN(compareVersions("v2.2.5", "2.2.5"))).toBe(true);
		expect(compareVersions("2.2.5", "2.2.5")).toBe(0);
		expect(compareVersions("2.2.5", "2.4.0")).toBeLessThan(0);
		expect(compareVersions("2.10.0", "2.4.0")).toBeGreaterThan(0);
	});

	test("Agent rejects pre-release and dev versions instead of letting NaN bypass OPENCODE_RANGE", async () => {
		for (const badVersion of ["2.2.0-beta", "2.2.5-beta", "dev"]) {
			process.env.FAKE_VERSION = badVersion;
			activeAgent = new Agent(() => {}, () => rootTmp, fakeOpencode);
			await expect(activeAgent.call("start", [])).rejects.toThrow(/outside the supported range/);
			activeAgent.dispose();
			activeAgent = undefined;
		}
	});

	test("Agent.dispose() kills its subprocess synchronously without waiting for a 3s timer", async () => {
		process.env.FAKE_VERSION = "2.2.5";
		activeAgent = new Agent(() => {}, () => rootTmp, fakeOpencode);
		await activeAgent.call("start", []);
		const proc = (activeAgent as any).proc;
		expect(proc).toBeDefined();
		const startedAt = Date.now();
		activeAgent.dispose();
		activeAgent = undefined;
		await Promise.race([proc.exited, new Promise((_, rej) => setTimeout(() => rej(new Error("child process was not killed synchronously")), 1000))]);
		expect(Date.now() - startedAt).toBeLessThan(1000);
	});
});

describe("window frame clamping with non-finite workArea", () => {
	test("fitWindow falls back to the wanted frame for NaN and Infinity values", () => {
		const wanted = { x: 80, y: 60, width: 1400, height: 900 };
		expect(fitWindow({ x: Number.NaN, y: 0, width: 1920, height: 1080 })).toEqual(wanted);
		expect(fitWindow({ x: 0, y: Number.POSITIVE_INFINITY, width: 1920, height: 1080 })).toEqual(wanted);
		expect(fitWindow({ x: 0, y: 0, width: Number.POSITIVE_INFINITY, height: 1080 })).toEqual(wanted);
		expect(fitWindow({ x: 0, y: 0, width: 1920, height: Number.NEGATIVE_INFINITY })).toEqual(wanted);
		expect(fitWindow({ x: 0, y: 0, width: Number.NaN, height: Number.NaN })).toEqual(wanted);
	});
});
