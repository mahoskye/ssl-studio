import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { bundleLsp } from "../scripts/bundle-lsp";
import { buildNotices, NOTICE_FILENAMES } from "../scripts/notices";
import { collectSslFiles, recordStructure, toPosixRelative } from "../scripts/record-structure";
import { SELFTEST_XDG_DIRS, selftestEnv, wipeSelftestScratch } from "../scripts/selftest";
import { fileManifest, readProject } from "../src/bun/project";
import { LSP_PIN } from "../src/bun/tools";
import { WorkspaceFiles } from "../src/bun/workspace";
import { parseCsv } from "../src/shared/csv";

const root = join(import.meta.dir, "..");
const readRepo = (rel: string) => readFileSync(join(root, rel), "utf8");

describe("R10A: selftestCycle and selftestDocs structural invariants", () => {
	test("selftestCycle opens Palette on the assistant tab and targets visible .plan-assist", () => {
		const src = readRepo("src/view/selftestCycle.ts");
		expect(src).toMatch(/import\s+\{[^}]*\bshowPanel\b[^}]*\}\s+from\s+"\.\/panels\/registry"/);
		expect(src).toMatch(/import\s+\{[^}]*\brequestPlanPaletteTab\b[^}]*\}\s+from\s+"\.\/plan\/planBridge"/);
		expect(src).toContain('showPanel("palette")');
		expect(src).toContain('requestPlanPaletteTab("assistant")');
		expect(src).toContain(".plan-assist:not([hidden])");
		expect(src).not.toMatch(/querySelector(?:<[^>]+>)?\(\s*["']\.plan-assist["']\s*\)/);
		expect(src).toContain('!b.closest("[hidden]")');
		expect(src).toContain("pressAssistant(/^Write plan doc$/)");
		expect(src).toContain("pressAssistant(start)");
		expect(src).toContain("pressAssistant(/^Review /)");
		expect(src).toContain("pressAssistant(/^Write the test script$/)");
	});

	test("selftestDocs strips HeadingCopyLinkWidget, switches to Read mode, checks menuitemcheckbox, updates schema catalog, and selects Outline tab", () => {
		const src = readRepo("src/view/selftestDocs.ts");
		// HeadingCopyLinkWidget `#` button stripped via clone
		expect(src).toContain("cloneNode(true)");
		expect(src).toContain(".cm-md-heading-link");
		expect(src).toContain(".remove()");

		// Default Live mode handled by switching to Read mode for rendered checks and taskTickedFromPage
		expect(src).toContain('switchButton("Read")');
		for (const stepName of ["readmeOpensRendered", "rowOpensDocument", "healthRowOpens", "taskTickedFromPage"]) {
			const idx = src.indexOf(`step("${stepName}"`);
			expect(idx).toBeGreaterThan(-1);
			const slice = src.slice(idx, idx + 450);
			expect(slice).toContain("ensureRead()");
		}
		expect(src).toContain('.cm-md-host.cm-md-read input[type="checkbox"]');

		// Set status submenu uses role="menuitemcheckbox"
		expect(src).toContain(".row-submenu [role=menuitem], .row-submenu [role=menuitemcheckbox]");

		// ADR 0031 manual catalog update before schemaCatalogKept assertion
		const schemaIdx = src.indexOf('step("schemaCatalogKept"');
		expect(schemaIdx).toBeGreaterThan(-1);
		expect(src.slice(schemaIdx, schemaIdx + 250)).toContain("await updateCatalogs()");

		// Document outline switches Document panel from Info to Outline
		expect(src).toMatch(/import\s+\{[^}]*\brequestMarkdownPanelTab\b[^}]*\}\s+from\s+"\.\/panels\/markdownBridge"/);
		const outlineIdx = src.indexOf('step("documentOutlined"');
		expect(outlineIdx).toBeGreaterThan(-1);
		const outlineSlice = src.slice(outlineIdx, outlineIdx + 300);
		expect(outlineSlice.indexOf("await openFile(question)")).toBeLessThan(outlineSlice.indexOf('requestMarkdownPanelTab("outline")'));
	});
});

describe("R10A: scripts/bundle-lsp.ts hardening", () => {
	test("early-exit fast path requires both STARLIMS-LSP-LICENSE and THIRD-PARTY-NOTICES.md", async () => {
		const dir = mkdtempSync(join(tmpdir(), "ssl-r10a-bundle-cache-"));
		try {
			const vendorDir = join(dir, "vendor");
			const repoDir = join(dir, "repo");
			mkdirSync(vendorDir, { recursive: true });
			mkdirSync(repoDir, { recursive: true });
			const binPath = join(vendorDir, "starlims-lsp");
			writeFileSync(binPath, "ORIGINAL-BIN");
			writeFileSync(join(vendorDir, "STARLIMS-LSP-LICENSE"), "MIT");
			writeFileSync(join(repoDir, "LICENSE"), "MIT");
			writeFileSync(join(repoDir, "THIRD-PARTY-NOTICES.md"), "NOTICES");

			// Missing THIRD-PARTY-NOTICES.md must NOT take cached fast path, must skip self-overwrite, and must copy notices
			let findCalls = 0;
			const first = await bundleLsp({
				vendorDir,
				repoDir,
				platform: "linux",
				getVersion: async () => LSP_PIN,
				findLocal: async () => {
					findCalls++;
					return { ok: true, version: LSP_PIN, path: binPath };
				},
			});
			expect(first.action).toBe("copied");
			expect(findCalls).toBe(1);
			expect(readFileSync(binPath, "utf8")).toBe("ORIGINAL-BIN");
			expect(existsSync(join(vendorDir, "starlims-lsp.new"))).toBe(false);
			expect(readFileSync(join(vendorDir, "THIRD-PARTY-NOTICES.md"), "utf8")).toBe("NOTICES");

			// With both license and notices present, fast path exits early without calling findLocal
			const second = await bundleLsp({
				vendorDir,
				repoDir,
				platform: "linux",
				getVersion: async () => LSP_PIN,
				findLocal: async () => {
					findCalls++;
					throw new Error("should not call findLocal when cached");
				},
			});
			expect(second.action).toBe("cached");
			expect(findCalls).toBe(1);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("copies local binary atomically via .new staging and fails loudly if STARLIMS-LSP-LICENSE is missing", async () => {
		const dir = mkdtempSync(join(tmpdir(), "ssl-r10a-bundle-atomic-"));
		try {
			const vendorDir = join(dir, "vendor");
			const localDir = join(dir, "local");
			const emptyRepo = join(dir, "empty-repo");
			const goodRepo = join(dir, "good-repo");
			mkdirSync(localDir, { recursive: true });
			mkdirSync(emptyRepo, { recursive: true });
			mkdirSync(goodRepo, { recursive: true });
			const localBin = join(localDir, "starlims-lsp");
			writeFileSync(localBin, "FRESH-BIN-PAYLOAD");
			writeFileSync(join(goodRepo, "LICENSE"), "MIT LICENSE");
			writeFileSync(join(goodRepo, "THIRD-PARTY-NOTICES.md"), "NOTICE TEXT");

			// Fails loudly when LICENSE is absent in repoDir and vendorDir
			await expect(
				bundleLsp({
					vendorDir,
					repoDir: emptyRepo,
					platform: "linux",
					getVersion: async () => undefined,
					findLocal: async () => ({ ok: true, version: LSP_PIN, path: localBin }),
				}),
			).rejects.toThrow(/STARLIMS-LSP-LICENSE/);

			// Succeeds when LICENSE is available and leaves no leftover .new file
			const res = await bundleLsp({
				vendorDir,
				repoDir: goodRepo,
				platform: "linux",
				getVersion: async () => undefined,
				findLocal: async () => ({ ok: true, version: LSP_PIN, path: localBin }),
			});
			expect(res.action).toBe("copied");
			expect(readFileSync(res.target, "utf8")).toBe("FRESH-BIN-PAYLOAD");
			expect(existsSync(`${res.target}.new`)).toBe(false);
			expect(readFileSync(join(vendorDir, "STARLIMS-LSP-LICENSE"), "utf8")).toBe("MIT LICENSE");
			expect(readFileSync(join(vendorDir, "THIRD-PARTY-NOTICES.md"), "utf8")).toBe("NOTICE TEXT");
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});

describe("R10A: scripts/notices.ts, scripts/selftest.ts, electrobun.config.ts, and package.json", () => {
	test("notices.ts includes THIRD-PARTY-NOTICES.md so Prettier bundled notices are captured", async () => {
		expect(NOTICE_FILENAMES).toContain("THIRD-PARTY-NOTICES.md");
		const { text } = await buildNotices(root);
		const prettierIdx = text.indexOf("## prettier ");
		expect(prettierIdx).toBeGreaterThan(-1);
		const nextPkgIdx = text.indexOf("\n## ", prettierIdx + 1);
		const prettierSection = text.slice(prettierIdx, nextPkgIdx === -1 ? undefined : nextPkgIdx);
		expect(prettierSection).toContain("### THIRD-PARTY-NOTICES.md");
	});

	test("selftest.ts wipes .selftest/{config,data,state,cache}, passes XDG_CACHE_HOME, and JSON-encodes SSL_STUDIO_OPENCODE", () => {
		expect([...SELFTEST_XDG_DIRS]).toEqual(["config", "data", "state", "cache"]);
		const scratch = mkdtempSync(join(tmpdir(), "ssl-r10a-selftest-"));
		try {
			for (const sub of SELFTEST_XDG_DIRS) {
				mkdirSync(join(scratch, sub), { recursive: true });
				writeFileSync(join(scratch, sub, "stale.txt"), "old");
			}
			wipeSelftestScratch(scratch);
			for (const sub of SELFTEST_XDG_DIRS) {
				expect(existsSync(join(scratch, sub))).toBe(false);
			}

			const spacedRoot = join(scratch, "path with spaces");
			const env = selftestEnv({
				root: spacedRoot,
				scratch,
				report: join(scratch, "selftest.json"),
				folder: join(scratch, "workspace"),
				close: false,
				cycle: true,
				baseEnv: {},
			});
			expect(env.XDG_CACHE_HOME).toBe(join(scratch, "cache"));
			expect(env.XDG_CONFIG_HOME).toBe(join(scratch, "config"));
			expect(env.XDG_DATA_HOME).toBe(join(scratch, "data"));
			expect(env.XDG_STATE_HOME).toBe(join(scratch, "state"));
			expect(JSON.parse(env.SSL_STUDIO_OPENCODE!)).toEqual(["bun", join(spacedRoot, "test", "fake-opencode.ts")]);
		} finally {
			rmSync(scratch, { recursive: true, force: true });
		}
	});

	test("electrobun.config.ts prefers the platform-native vendor starlims-lsp binary first", () => {
		const src = readRepo("electrobun.config.ts");
		expect(src).toContain('process.platform === "win32"');
		expect(src).toContain('["vendor/starlims-lsp.exe", "vendor/starlims-lsp"]');
		expect(src).toContain('["vendor/starlims-lsp", "vendor/starlims-lsp.exe"]');
	});

	test("package.json pins mermaid to exact 12.3.0 and has no caret/tilde ranges", () => {
		const pkg = JSON.parse(readRepo("package.json")) as {
			dependencies: Record<string, string>;
			devDependencies: Record<string, string>;
		};
		expect(pkg.dependencies.mermaid).toBe("12.3.0");
		for (const [name, ver] of [...Object.entries(pkg.dependencies), ...Object.entries(pkg.devDependencies)]) {
			expect(ver, `${name} should be pinned to an exact version`).toMatch(/^\d+\.\d+\.\d+$/);
		}
	});
});

describe("R10A: scripts/record-structure.ts determinism, URLs, and error handling", () => {
	test("collectSslFiles skips dot-directories, sorts deterministically, and toPosixRelative normalizes slashes", () => {
		const dir = mkdtempSync(join(tmpdir(), "ssl-r10a-collect-"));
		try {
			mkdirSync(join(dir, ".git", "hooks"), { recursive: true });
			mkdirSync(join(dir, ".hidden"), { recursive: true });
			mkdirSync(join(dir, "B"), { recursive: true });
			mkdirSync(join(dir, "A"), { recursive: true });
			writeFileSync(join(dir, ".git", "hooks", "Ignore.ssl"), ":RETURN 0;\n");
			writeFileSync(join(dir, ".hidden", "Skip.ssl"), ":RETURN 0;\n");
			writeFileSync(join(dir, "B", "Zeta.ssl"), ":RETURN 1;\n");
			writeFileSync(join(dir, "A", "Beta.ssl"), ":RETURN 2;\n");
			writeFileSync(join(dir, "A", "Alpha.ssl"), ":RETURN 3;\n");
			writeFileSync(join(dir, "A", "Notes.md"), "# ignore\n");

			const found = collectSslFiles(dir).map((p) => toPosixRelative(dir, p));
			expect(found).toEqual(["A/Alpha.ssl", "A/Beta.ssl", "B/Zeta.ssl"]);
			expect(toPosixRelative("a", "a\\b\\c.ssl").includes("\\")).toBe(false);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("recordStructure uses pathToFileURL, keys by POSIX relative path, and rejects on LSP error or unexpected exit", async () => {
		const dir = mkdtempSync(join(tmpdir(), "ssl-r10a-rec-"));
		try {
			const ws = join(dir, "ws with space");
			mkdirSync(join(ws, "Mod"), { recursive: true });
			mkdirSync(join(ws, ".dotdir"), { recursive: true });
			const alphaPath = join(ws, "Mod", "Alpha.ssl");
			writeFileSync(alphaPath, ":PROCEDURE Alpha;\n:ENDPROC;\n");
			writeFileSync(join(ws, ".dotdir", "Ignored.ssl"), ":PROCEDURE Skip;\n:ENDPROC;\n");

			// 1. Happy path fake LSP server verifying pathToFileURL URIs
			const okServer = join(dir, "ok-lsp.ts");
			writeFileSync(
				okServer,
				`
import { createFrameReader, frame } from ${JSON.stringify(join(root, "src/bun/frames.ts"))};
const seen: string[] = [];
const read = createFrameReader((body) => {
	const m = JSON.parse(body);
	if (m.method === "initialize") {
		seen.push(m.params.rootUri);
		process.stdout.write(frame(JSON.stringify({ jsonrpc: "2.0", id: m.id, result: { capabilities: {} } })));
	} else if (m.method === "textDocument/documentSymbol") {
		seen.push(m.params.textDocument.uri);
		process.stdout.write(frame(JSON.stringify({ jsonrpc: "2.0", id: m.id, result: [{ name: m.params.textDocument.uri, root: seen[0] }] })));
	} else if (m.method === "textDocument/foldingRange") {
		process.stdout.write(frame(JSON.stringify({ jsonrpc: "2.0", id: m.id, result: [{ startLine: 0, endLine: 1 }] })));
	}
});
for await (const chunk of Bun.stdin.stream()) read(chunk);
`,
			);
			const recorded = await recordStructure({ rootDir: ws, lspCommand: ["bun", okServer], lspVersion: "test-1.0" });
			expect(recorded.server).toBe("test-1.0");
			expect(Object.keys(recorded.files)).toEqual(["Mod/Alpha.ssl"]);
			const entry = recorded.files["Mod/Alpha.ssl"] as { symbols: { name: string; root: string }[]; folds: unknown[] };
			expect(entry.symbols[0]?.root).toBe(pathToFileURL(ws).href);
			expect(entry.symbols[0]?.name).toBe(pathToFileURL(alphaPath).href);

			// 2. JSON-RPC m.error rejects pending request
			const errServer = join(dir, "err-lsp.ts");
			writeFileSync(
				errServer,
				`
import { createFrameReader, frame } from ${JSON.stringify(join(root, "src/bun/frames.ts"))};
const read = createFrameReader((body) => {
	const m = JSON.parse(body);
	if (m.id !== undefined) {
		process.stdout.write(frame(JSON.stringify({ jsonrpc: "2.0", id: m.id, error: { code: -32603, message: "boom" } })));
	}
});
for await (const chunk of Bun.stdin.stream()) read(chunk);
`,
			);
			await expect(recordStructure({ rootDir: ws, lspCommand: ["bun", errServer], lspVersion: "test-1.0" })).rejects.toThrow(/boom/);

			// 3. Unexpected child process exit rejects pending request instead of hanging
			const crashServer = join(dir, "crash-lsp.ts");
			writeFileSync(crashServer, "process.exit(42);\n");
			await expect(recordStructure({ rootDir: ws, lspCommand: ["bun", crashServer], lspVersion: "test-1.0" })).rejects.toThrow(/exited unexpectedly.*42/);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});

describe("R10A: examples/due-dates consistency", () => {
	const demoRoot = join(root, "examples", "due-dates");

	test("files.csv matches live fileManifest byte counts, line counts, and SHA-256 hashes with zero drift", async () => {
		const actual = await fileManifest(new WorkspaceFiles(demoRoot), await readProject(demoRoot));
		const parsed = parseCsv(readFileSync(join(demoRoot, "docs/registries/files.csv"), "utf8"));
		expect(parsed.problems).toEqual([]);
		const byPath = new Map(actual.map((f) => [f.path, f]));
		expect(parsed.rows.length).toBe(actual.length);
		for (const row of parsed.rows) {
			const [path, kind, bytes, lines, sha256] = row.map((c) => c.text);
			const found = byPath.get(path!);
			expect(found, `missing file on disk for ${path}`).toBeDefined();
			expect({ path, kind, bytes: Number(bytes), lines: Number(lines), sha256 }).toEqual(found!);
		}
	});

	test("DEMO-103 due-soon-expected.json matches Worked-examples.md, demo-seed.sql, and DUE_ON/SAMPLE_ID ordering", () => {
		const fixture = JSON.parse(readFileSync(join(demoRoot, "docs/tickets/DEMO-103/fixtures/due-soon-expected.json"), "utf8")) as {
			asOf: string;
			windowDays: number;
			heading: string;
			rows: { sampleId: string; priority: string; instrumentId: string | null; dueOn: string; status: string; workingDaysLeft: number }[];
		};
		expect(fixture.asOf).toBe("2026-11-20");
		expect(fixture.windowDays).toBe(3);
		expect(fixture.rows).toEqual([
			{ sampleId: "S-1001", priority: "ROUTINE", instrumentId: null, dueOn: "2026-11-19", status: "DUE_LATE", workingDaysLeft: -1 },
			{ sampleId: "S-1004", priority: "RUSH", instrumentId: null, dueOn: "2026-11-21", status: "DUE_NEXT_DAY", workingDaysLeft: 1 },
			{ sampleId: "S-1002", priority: "ROUTINE", instrumentId: "BAL-01", dueOn: "2026-11-23", status: "DUE_NEXT_DAY", workingDaysLeft: 1 },
			{ sampleId: "S-1003", priority: "ROUTINE", instrumentId: null, dueOn: "2026-11-23", status: "DUE_NEXT_DAY", workingDaysLeft: 1 },
		]);
	});

	test("STATE.md, schema/INDEX.md, and README.md have consistent wording", () => {
		const stateMd = readFileSync(join(demoRoot, "docs/STATE.md"), "utf8");
		expect(stateMd).not.toContain("planned and not yet built");
		expect(stateMd).toContain("half-built");

		const schemaIndex = readFileSync(join(demoRoot, "schema/INDEX.md"), "utf8");
		expect(schemaIndex).toContain("all four tables");
		expect(schemaIndex).not.toContain("all three tables");

		const readme = readFileSync(join(demoRoot, "README.md"), "utf8");
		expect(readme).toContain("Document outline");
		expect(readme).not.toContain("Objects outline");
	});
});
