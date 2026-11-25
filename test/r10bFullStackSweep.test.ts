import { afterAll, describe, expect, mock, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createBackend, parseOpencodeCommandEnv, type Host } from "../src/bun/backend";
import { dirs } from "../src/bun/paths";
import { SettingsStore } from "../src/bun/settings";
import { WorkspaceFiles } from "../src/bun/workspace";
import { replaceSafeInText } from "../src/shared/menuBar";
import type { BackendEvents, Info, LspState, Settings } from "../src/shared/protocol";
import { DEFAULT_SETTINGS } from "../src/shared/protocol";
import { REGEX_MAX_LINE_LENGTH, replaceIn, searchPattern } from "../src/shared/searchPattern";

// Minimal browser & Monaco shims so view modules load cleanly under Bun tests.
const origLocation = (globalThis as any).location;
const origLocalStorage = (globalThis as any).localStorage;
const memStorage = new Map<string, string>();
if (typeof (globalThis as any).localStorage === "undefined") {
	(globalThis as any).localStorage = {
		getItem: (k: string) => (memStorage.has(k) ? memStorage.get(k)! : null),
		setItem: (k: string, v: string) => void memStorage.set(k, String(v)),
		removeItem: (k: string) => void memStorage.delete(k),
		clear: () => memStorage.clear(),
	};
}
if (typeof (globalThis as any).window === "undefined") {
	(globalThis as any).window = {
		Error,
		Map,
		Set,
		addEventListener() {},
		removeEventListener() {},
		location: { protocol: "http:", host: "127.0.0.1:0", href: "http://127.0.0.1:0/" },
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
		createElement: () => ({ style: {} }),
		querySelector: () => null,
	};
}
if (typeof (globalThis as any).self === "undefined") {
	(globalThis as any).self = globalThis;
}

class MockRange {
	constructor(
		public startLineNumber: number,
		public startColumn: number,
		public endLineNumber: number,
		public endColumn: number,
	) {}
}

class MockUri {
	readonly scheme: string;
	readonly path: string;
	readonly fsPath: string;
	constructor(scheme: string, path: string) {
		this.scheme = scheme;
		this.path = path;
		this.fsPath = path;
	}
	toString() {
		return this.scheme === "file" ? `file://${encodeURI(this.path)}` : `${this.scheme}:${this.path}`;
	}
	static file(p: string) {
		return new MockUri("file", p.replace(/\\/g, "/"));
	}
	static parse(raw: string) {
		if (raw.startsWith("file://")) return new MockUri("file", decodeURI(raw.slice("file://".length)));
		const idx = raw.indexOf(":");
		return idx >= 0 ? new MockUri(raw.slice(0, idx), raw.slice(idx + 1)) : new MockUri("file", raw);
	}
	static from(parts: { scheme: string; path?: string }) {
		return new MockUri(parts.scheme, parts.path ?? "/");
	}
}

const mockModels = new Map<string, any>();
const mockMarkers = new Map<string, Map<string, any[]>>();
const noopProxy = (extra: Record<string, any> = {}) =>
	new Proxy(extra, { get: (target, prop) => (prop in target ? target[prop as any] : () => ({ dispose() {} })) });

mock.module("monaco-editor/editor/editor.api", () => ({
	Range: MockRange,
	Emitter: class {
		event = () => ({ dispose() {} });
		fire() {}
		dispose() {}
	},
	Uri: MockUri,
	MarkerSeverity: { Hint: 1, Info: 2, Warning: 4, Error: 8 },
	KeyMod: { CtrlCmd: 2048, Shift: 1024, Alt: 512 },
	KeyCode: {},
	languages: noopProxy({
		CompletionItemKind: {
			Text: 0,
			Method: 1,
			Function: 2,
			Constructor: 3,
			Field: 4,
			Variable: 5,
			Class: 6,
			Interface: 7,
			Module: 8,
			Property: 9,
			Unit: 10,
			Value: 11,
			Enum: 12,
			Keyword: 13,
			Snippet: 14,
			Color: 15,
			File: 16,
			Reference: 17,
			Folder: 18,
			EnumMember: 19,
			Constant: 20,
			Struct: 21,
			Event: 22,
			Operator: 23,
			TypeParameter: 24,
		},
		CompletionItemInsertTextRule: { InsertAsSnippet: 4 },
		FoldingRangeKind: { Comment: { value: "comment" }, Imports: { value: "imports" }, Region: { value: "region" } },
		SymbolKind: { Namespace: 2, Class: 4, Method: 5, Function: 11 },
	}),
	editor: noopProxy({
		getEditors: () => [],
		ScrollType: { Immediate: 1 },
		getModels: () => [...mockModels.values()],
		getModel: (uri: MockUri) => mockModels.get(uri.toString()) ?? null,
		setModelMarkers: (model: any, owner: string, markers: any[]) => {
			const key = model.uri.toString();
			let byOwner = mockMarkers.get(key);
			if (!byOwner) {
				byOwner = new Map();
				mockMarkers.set(key, byOwner);
			}
			byOwner.set(owner, markers);
		},
		getModelMarkers: (filter?: { resource?: MockUri }) => {
			if (filter?.resource) {
				const byOwner = mockMarkers.get(filter.resource.toString());
				return byOwner ? [...byOwner.values()].flat() : [];
			}
			return [...mockMarkers.values()].flatMap((m) => [...m.values()].flat());
		},
	}),
}));
mock.module("monaco-editor/features/register.all", () => ({}));
mock.module("monaco-editor/editor/contrib/semanticTokens/browser/documentSemanticTokens", () => ({}));
mock.module("monaco-editor/editor/editor.worker?worker", () => ({ default: class {} }));
mock.module(`${resolve(import.meta.dir, "../src/view/editor/markdownLive.worker.ts")}?worker`, () => ({ default: class {} }));

const rootTmp = realpathSync.native(mkdtempSync(join(tmpdir(), "ssl-studio-r10b-")));
afterAll(() => {
	rmSync(rootTmp, { recursive: true, force: true });
	if (origLocation === undefined) delete (globalThis as any).location;
	else (globalThis as any).location = origLocation;
	if (origLocalStorage === undefined) delete (globalThis as any).localStorage;
	else (globalThis as any).localStorage = origLocalStorage;
});

const readSrc = (rel: string) => readFileSync(resolve(import.meta.dir, "..", rel), "utf8").replace(/\r\n/g, "\n");

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

function makeFakeLspScript(dir: string, name: string, version: string, markerFile: string): string {
	const stem = name.replace(/\.(sh|cmd|bat|js)$/i, "");
	const jsPath = join(dir, `${stem}.js`);
	writeFileSync(
		jsPath,
		`const fs = require("node:fs");
if (process.argv[2] === "--version") {
  process.stdout.write("starlims-lsp version ${version}\\n");
  process.exit(0);
}
fs.appendFileSync(${JSON.stringify(markerFile)}, "${version}\\n");
process.stdin.resume();
process.stdin.on("end", () => process.exit(0));
setTimeout(() => process.exit(0), 10000);
`,
		"utf8",
	);
	if (process.platform === "win32") {
		const cmdPath = join(dir, `${stem}.cmd`);
		writeFileSync(cmdPath, `@echo off\r\n"${process.execPath}" "${jsPath}" %*\r\n`, "utf8");
		return cmdPath;
	}
	const shPath = join(dir, `${stem}.sh`);
	writeFileSync(shPath, `#!/bin/sh\nexec "${process.execPath}" "${jsPath}" "$@"\n`, "utf8");
	chmodSync(shPath, 0o755);
	return shPath;
}

/** Spins up a lightweight in-process WS server speaking src/view/backend.ts's Call/Reply/Push wire protocol. */
async function withMockBackendWs<T>(
	handler: (method: string, args: unknown[]) => unknown | Promise<unknown>,
	fn: (ctx: { push: <K extends keyof BackendEvents>(event: K, payload: BackendEvents[K]) => void }) => Promise<T>,
): Promise<T> {
	const clients = new Set<any>();
	const server = Bun.serve({
		port: 0,
		fetch(req, srv) {
			if (srv.upgrade(req)) return undefined;
			return new Response("ok");
		},
		websocket: {
			open(ws) {
				clients.add(ws);
			},
			close(ws) {
				clients.delete(ws);
			},
			async message(ws, raw) {
				const call = JSON.parse(String(raw)) as { id: number; method: string; args: unknown[] };
				try {
					const result = await handler(call.method, call.args);
					ws.send(JSON.stringify({ id: call.id, result }));
				} catch (err: any) {
					ws.send(JSON.stringify({ id: call.id, error: String(err?.message ?? err) }));
				}
			},
		},
	});
	const prevLoc = (globalThis as any).location;
	(globalThis as any).location = {
		protocol: "http:",
		host: `127.0.0.1:${server.port}`,
		href: `http://127.0.0.1:${server.port}/`,
	};
	try {
		const { connect } = await import("../src/view/backend");
		await connect();
		return await fn({
			push(event, payload) {
				const frame = JSON.stringify({ event, payload });
				for (const ws of clients) ws.send(frame);
			},
		});
	} finally {
		for (const ws of clients) ws.close();
		server.stop(true);
		if (prevLoc === undefined) delete (globalThis as any).location;
		else (globalThis as any).location = prevLoc;
	}
}

describe("R10B #1 — chooseModel() persists agentModel to 'user' scope even when project.toml sets [agent] model", () => {
	test("SettingsStore persists agentModel in user scope while stripping workspace scope even with project.toml [agent] model", async () => {
		await withTempDirs(async () => {
			const ws = join(rootTmp, "ws-model");
			mkdirSync(join(ws, ".ssl-studio"), { recursive: true });
			writeFileSync(join(ws, ".ssl-studio", "project.toml"), '[agent]\nmodel = "ollama/qwen3:8b"\n');

			const store = new SettingsStore(() => ws);
			// Workspace save strips USER_ONLY_SETTINGS.agentModel: what shows through is the local model project.toml names.
			const wsEffective = await store.save("workspace", { agentModel: "ollama/llama3:8b" });
			expect(wsEffective.agentModel).toBe("ollama/qwen3:8b");

			// User save persists agentModel cleanly.
			const userEffective = await store.save("user", { agentModel: "ollama/llama3:8b" });
			expect(userEffective.agentModel).toBe("ollama/llama3:8b");

			// Clearing via null removes the user's own choice, and the project's shows through again.
			const cleared = await store.save("user", { agentModel: null });
			expect(cleared.agentModel).toBe("ollama/qwen3:8b");
		});
	});

	test("chooseModel() saves agentModel with 'user' scope even when state.project.agentModel is set", async () => {
		const calls: { method: string; args: unknown[] }[] = [];
		const currentSettings: Settings = structuredClone(DEFAULT_SETTINGS);

		await withMockBackendWs(
			(method, args) => {
				calls.push({ method, args });
				if (method === "saveSettings") {
					const [_scope, patch] = args as [string, Partial<Settings>];
					if (patch.agentModel === null) delete currentSettings.agentModel;
					else if (patch.agentModel !== undefined) currentSettings.agentModel = patch.agentModel;
					return structuredClone(currentSettings);
				}
				if (method === "agent" && args[0] === "models") {
					return [{ providerID: "ollama", id: "llama3:8b", name: "Llama 3", local: true, tools: true, variants: [] }];
				}
				return null;
			},
			async () => {
				const { flush } = await import("solid-js");
				const { setState } = await import("../src/view/state");
				const { chooseModel, setAgent } = await import("../src/view/agent/store");
				setState((s) => {
					s.project = {
						configured: true,
						path: "/ws/.ssl-studio/project.toml",
						name: "Demo",
						description: "",
						docs: "docs",
						schema: "schema",
						tests: "tests",
						code: ".",
						plans: "design",
						agentModel: "ollama/qwen3:8b",
					};
				});
				setAgent((s) => {
					s.models = [{ providerID: "ollama", id: "llama3:8b", name: "Llama 3", local: true, tools: true, variants: [] }];
				});
				flush();

				const ok = await chooseModel("ollama/llama3:8b");
				expect(ok).toBe(true);
				const saveCall = calls.find((c) => c.method === "saveSettings");
				expect(saveCall).toBeDefined();
				expect(saveCall!.args).toEqual(["user", { agentModel: "ollama/llama3:8b" }]);
			},
		);

		const storeSrc = readSrc("src/view/agent/store.ts");
		expect(storeSrc).toContain('await saveSetting({ agentModel: chosen || null }, "user")');
		expect(storeSrc).not.toContain('state.project?.agentModel ? "workspace" : "user"');
	});
});

describe("R10B #2 — Startup workspace syncWorkspaceThreads & ask() defense-in-depth", () => {
	test("ask() initializes activeWorkspaceKey from state.workspace.root so mid-turn syncWorkspaceThreads never drops replies", async () => {
		let releaseAsk!: () => void;
		const askGate = new Promise<void>((r) => (releaseAsk = r));

		await withMockBackendWs(
			async (method, args) => {
				if (method === "agent" && args[0] === "ask") {
					await askGate;
					return {
						sessionID: "sess-startup-1",
						text: "Startup turn answer",
						outcome: "succeeded",
						tokens: { input: 20, output: 10 },
					};
				}
				return null;
			},
			async () => {
				const { flush } = await import("solid-js");
				const { canonical, setState } = await import("../src/view/state");
				const { agent, ask, setAgent, syncWorkspaceThreads } = await import("../src/view/agent/store");
				const startupRoot = "/ws/startup-demo";
				syncWorkspaceThreads(null);
				setState((s) => {
					s.workspace = { root: startupRoot, name: "startup-demo" };
				});
				setAgent((s) => {
					s.status = { state: "ready" };
					s.busy = false;
					s.entries = [];
				});
				flush();

				const turnPromise = ask("Explain startup sync");
				// Calling syncWorkspaceThreads for the same startup root mid-turn must be a no-op and NOT bump turnEpoch.
				syncWorkspaceThreads(canonical(startupRoot));
				releaseAsk();

				const reply = await turnPromise;
				flush();
				expect(reply).not.toBeNull();
				expect(reply!.text).toBe("Startup turn answer");
				expect(agent.entries.some((e) => e.role === "agent" && e.text === "Startup turn answer")).toBe(true);
			},
		);
	});

	test("main.tsx syncs workspace threads immediately on startup workspace load", () => {
		const mainSrc = readSrc("src/view/main.tsx");
		expect(mainSrc).toContain('import { syncWorkspaceThreads } from "./agent/store";');
		expect(mainSrc).toMatch(/setState\(\(s\)\s*=>\s*\{\s*s\.workspace = workspace;\s*\}\);\s*syncWorkspaceThreads\(canonical\(workspace\.root\)\);/);
	});
});

describe("R10B #3 — LSP recovery from initial failure, lspRestart() lspPath pickup & JSON-array SSL_STUDIO_OPENCODE", () => {
	test("parseOpencodeCommandEnv parses JSON string arrays with spaces and falls back to space-splitting", () => {
		expect(parseOpencodeCommandEnv(undefined)).toBeUndefined();
		expect(parseOpencodeCommandEnv("")).toBeUndefined();
		expect(parseOpencodeCommandEnv("   ")).toBeUndefined();
		expect(parseOpencodeCommandEnv('["bun","/Users/Jane Doe/My Projects/ssl-studio/test/fake-opencode.ts"]')).toEqual([
			"bun",
			"/Users/Jane Doe/My Projects/ssl-studio/test/fake-opencode.ts",
		]);
		expect(parseOpencodeCommandEnv("bun /tmp/fake-opencode.ts")).toEqual(["bun", "/tmp/fake-opencode.ts"]);
		expect(parseOpencodeCommandEnv("[not-json arg2")).toEqual(["[not-json", "arg2"]);
	});

	test("backend.lspRestart() re-reads effective.lspPath to recover from initial failure, swap binaries, and fail cleanly", async () => {
		await withTempDirs(async () => {
			const ws = join(rootTmp, "ws-lsp-restart");
			const binDir = join(rootTmp, "fake-lsp-bins");
			mkdirSync(ws, { recursive: true });
			mkdirSync(binDir, { recursive: true });

			const marker1 = join(rootTmp, "lsp1.log");
			const marker2 = join(rootTmp, "lsp2.log");
			const lsp1 = makeFakeLspScript(binDir, "lsp-1.sh", "0.31.0", marker1);
			const lsp2 = makeFakeLspScript(binDir, "lsp-2.sh", "0.32.0", marker2);

			const states: LspState[] = [];
			const host: Host = {
				emit(event, payload) {
					if (event === "lspState") states.push(payload as LspState);
				},
				pick: async () => null,
				trash: async () => {},
				app: "test",
				kind: "app",
				quit: () => {},
			};

			// Temporarily clear PATH & STARLIMS_LSP so auto-discovery only finds our configured lspPath.
			const prevPath = process.env.PATH;
			const prevStarlimsLsp = process.env.STARLIMS_LSP;
			const backend = createBackend(host);
			try {
				// Before any workspace is open (`!files`), lspRestart() refreshes info and returns cleanly without starting LSP.
				await backend.api.saveSettings("user", { lspPath: lsp1 });
				await backend.api.lspRestart();
				expect((await backend.api.info()).lsp.path).toBe(lsp1);
				expect((await backend.api.lspState()).state).toBe("stopped");

				// Open workspace with lsp1 -> verify it starts.
				await backend.api.openFolder(ws);
				expect((await backend.api.info()).lsp.path).toBe(lsp1);
				expect((await backend.api.lspState()).state).toBe("running");

				// Swap lspPath to fake binary #2 and call lspRestart() -> must spawn binary #2, not restart #1!
				states.length = 0;
				await backend.api.saveSettings("user", { lspPath: lsp2 });
				await backend.api.lspRestart();
				expect((await backend.api.info()).lsp.path).toBe(lsp2);
				expect((await backend.api.info()).lsp.version).toBe("0.32.0");
				expect((await backend.api.lspState()).state).toBe("running");
				// Give the spawned shell a moment to append to marker2.
				for (let i = 0; i < 20; i++) {
					try {
						if (readFileSync(marker2, "utf8").includes("0.32.0")) break;
					} catch {
						// wait
					}
					await Bun.sleep(25);
				}
				expect(readFileSync(marker2, "utf8")).toContain("0.32.0");
				expect(states.map((s) => s.state)).toContain("stopped");
				expect(states.at(-1)?.state).toBe("running");

				// Calling lspRestart() with same resolved path calls lsp.restart() (same binary).
				states.length = 0;
				await backend.api.lspRestart();
				expect(states.map((s) => s.state)).toEqual(["stopped", "starting", "running"]);
			} finally {
				backend.dispose();
				process.env.PATH = prevPath;
				if (prevStarlimsLsp === undefined) delete process.env.STARLIMS_LSP;
				else process.env.STARLIMS_LSP = prevStarlimsLsp;
			}
		});
	});

	test("LspSession.setRoot() enables initialization when lspState later transitions from failed to running", async () => {
		const sentLsp: string[] = [];
		await withMockBackendWs(
			(method, args) => {
				if (method === "lspSend") sentLsp.push(String(args[0]));
				return null;
			},
			async ({ push }) => {
				const { LspSession, session } = await import("../src/view/lsp/session");
				// Ensure the module singleton does not emit an initialize for a stale root from an earlier test file.
				session.reset();
				const s = new LspSession();
				// Simulate initial failure: root is recorded via setRoot(), start() was NOT called.
				s.setRoot("/ws/recovered-folder");
				push("lspState", { state: "running" });
				await Bun.sleep(20);

				const initMsgs = sentLsp.map((m) => JSON.parse(m)).filter((m) => m.method === "initialize");
				const initMsg = initMsgs.find((m) => m.params?.rootUri === "file:///ws/recovered-folder");
				expect(initMsg).toBeDefined();
				expect(initMsg.params.rootUri).toBe("file:///ws/recovered-folder");

				// Clean up listeners/pending requests.
				s.reset();
			},
		);
	});

	test("restartLsp() refreshes state.info after backend.lspRestart() and is wired into commands, StatusBar & Settings", async () => {
		let restartCount = 0;
		const refreshedInfo: Info = {
			app: "0.1.0",
			host: "app",
			selftest: false,
			lsp: { ok: true, path: "/opt/bin/starlims-lsp", version: "0.31.0" },
			opencode: { ok: false },
		};

		await withMockBackendWs(
			(method) => {
				if (method === "lspRestart") {
					restartCount++;
					return undefined;
				}
				if (method === "info") return refreshedInfo;
				return null;
			},
			async () => {
				const { flush } = await import("solid-js");
				const { restartLsp, setState, state } = await import("../src/view/state");
				setState((s) => {
					s.info = {
						app: "0.1.0",
						host: "app",
						selftest: false,
						lsp: { ok: false, message: "not found" },
						opencode: { ok: false },
					};
				});
				flush();
				await restartLsp();
				flush();
				expect(restartCount).toBe(1);
				expect(state.info?.lsp.ok).toBe(true);
				expect(state.info?.lsp.path).toBe("/opt/bin/starlims-lsp");
			},
		);

		expect(readSrc("src/view/main.tsx")).toContain("session.setRoot(workspace.root);");
		expect(readSrc("src/view/state.ts")).toContain("session.setRoot(workspace.root);");
		expect(readSrc("src/view/commands.ts")).toContain("void restartLsp()");
		expect(readSrc("src/view/StatusBar.tsx")).toContain("void restartLsp()");
		expect(readSrc("src/view/Settings.tsx")).toContain('if (key === "lspPath" && saved) await restartLsp();');
	});
});

describe("R10B #4 — resetTidy() clears tidy store and proposals across workspace switch A -> B", () => {
	test("resetTidy() resets tidy.path, all step states, all problems, and clears cached proposals", async () => {
		const { flush } = await import("solid-js");
		const { proposalOf, resetTidy, setTidy, STEPS, tidy } = await import("../src/view/agent/tidy");
		setTidy((s) => {
			s.path = "/ws-a/src/Order.ssl";
			s.steps = STEPS.map((_, idx) => (idx === 0 ? "accepted" : idx === 1 ? "review" : "pending"));
			s.problems = STEPS.map((_, idx) => (idx === 1 ? "Waiting on review" : ""));
		});
		flush();
		expect(tidy.path).toBe("/ws-a/src/Order.ssl");
		expect(tidy.steps[1]).toBe("review");

		resetTidy();
		flush();
		expect(tidy.path).toBeNull();
		expect([...tidy.steps]).toEqual(STEPS.map(() => "pending"));
		expect([...tidy.problems]).toEqual(STEPS.map(() => ""));
		for (let i = 0; i < STEPS.length; i++) {
			expect(proposalOf(i)).toBeUndefined();
		}

		// Verify openFolder() invokes resetTidy() beside closeReview() and syncWorkspaceThreads().
		const stateSrc = readSrc("src/view/state.ts");
		expect(stateSrc).toMatch(/closeReview\(\);\s*resetTidy\(\);\s*syncWorkspaceThreads\(canonical\(workspace\.root\)\);/);
	});
});

describe("R10B #5 — Markdown image & Mermaid lightboxes wrapped in <Modal> isolation", () => {
	test("MarkdownLiveEditor renders both lightboxes via <Modal> and cmLive.css styles .md-lightbox-modal at modal tier", () => {
		const editorSrc = readSrc("src/view/editor/MarkdownLiveEditor.tsx");
		expect(editorSrc).toContain('import { Modal, modalOpen } from "../modal";');
		// Both image and Mermaid lightboxes render inside <Modal class="md-lightbox-modal">.
		const modalMatches = editorSrc.match(/<Modal\s+class="md-lightbox-modal"/g) ?? [];
		expect(modalMatches.length).toBe(2);
		expect(editorSrc).not.toContain('class="md-lightbox-backdrop"');
		// Global key handler stands down when a modal is open, and Mermaid lightbox uses Modal's onKey for zoom/pan.
		expect(editorSrc).toContain("if (modalOpen()) return;");
		expect(editorSrc).toContain("onKey={(e) => {");
		expect(editorSrc).toContain('e.key === "+" || e.key === "="');
		expect(editorSrc).toContain('e.key === "ArrowLeft" || e.key === "ArrowRight"');
		expect(editorSrc).toContain("data-autofocus");

		const css = readSrc("src/view/editor/cmLive.css");
		expect(css).toContain(".md-lightbox-modal {");
		expect(css).toContain("z-index: 80;");
		expect(css).toContain("min-width: 0;");
		expect(css).toContain("min-height: 0;");
		expect(css).not.toContain(".md-lightbox-backdrop");
	});
});

describe("R10B #6 — REGEX_MAX_LINE_LENGTH consistency across Search/Replace & BackendApi.replace type sync", () => {
	test("replaceIn() and replaceSafeInText() skip >20,000-char lines in regex mode while keeping <=20,000 and literal mode", () => {
		expect(REGEX_MAX_LINE_LENGTH).toBe(20_000);
		const overLine = `${"a".repeat(REGEX_MAX_LINE_LENGTH - 3)}NEEDLE`;
		expect(overLine.length).toBeGreaterThan(REGEX_MAX_LINE_LENGTH);
		const exactLine = `${"b".repeat(REGEX_MAX_LINE_LENGTH - 6)}NEEDLE`;
		expect(exactLine.length).toBe(REGEX_MAX_LINE_LENGTH);
		const shortLine = "hello NEEDLE world";
		const doc = `${overLine}\n${exactLine}\n${shortLine}`;

		// Regex mode skips overLine (> 20,000) and replaces exactLine (== 20,000) + shortLine.
		const reOut = replaceIn(doc, "NEEDLE", "FOUND", { regex: true });
		expect(reOut.count).toBe(2);
		const reLines = reOut.text.split("\n");
		expect(reLines[0]).toBe(overLine);
		expect(reLines[1]!.endsWith("FOUND")).toBe(true);
		expect(reLines[2]).toBe("hello FOUND world");

		// Literal mode replaces all 3 lines regardless of line length.
		const litOut = replaceIn(doc, "NEEDLE", "FOUND", { regex: false });
		expect(litOut.count).toBe(3);
		expect(litOut.text.split("\n")[0]!.endsWith("FOUND")).toBe(true);

		// replaceSafeInText enforces the exact same REGEX_MAX_LINE_LENGTH rule.
		const safeRegex = replaceSafeInText(doc, searchPattern("NEEDLE", { regex: true }), "FOUND", true, { isMarkdown: true, safeDocs: true });
		expect(safeRegex.count).toBe(2);
		expect(safeRegex.text.split("\n")[0]).toBe(overLine);
		expect(safeRegex.text.split("\n")[2]).toBe("hello FOUND world");

		const safeLit = replaceSafeInText(doc, searchPattern("NEEDLE", { regex: false }), "FOUND", false, { isMarkdown: true, safeDocs: true });
		expect(safeLit.count).toBe(3);
		expect(safeLit.text.split("\n")[0]!.endsWith("FOUND")).toBe(true);
	});

	test("WorkspaceFiles.search() and replaced() agree on >20,000-char lines in regex and literal modes", async () => {
		const wsDir = join(rootTmp, "ws-regex-limit");
		mkdirSync(wsDir, { recursive: true });
		const overLine = `${"x".repeat(REGEX_MAX_LINE_LENGTH + 5)}TARGET`;
		const normalLine = "call TARGET()";
		const filePath = join(wsDir, "minified.ssl");
		writeFileSync(filePath, `${overLine}\n${normalLine}\n`, "utf8");

		const ws = new WorkspaceFiles(wsDir);
		const reHits = await ws.search("TARGET", { regex: true });
		expect(reHits.length).toBe(1);
		expect(reHits[0]!.line).toBe(2);

		const reRep = await ws.replaced(filePath, "TARGET", "UPDATED", { regex: true });
		expect(reRep).not.toBeNull();
		expect(reRep!.count).toBe(1);
		expect(reRep!.after.split("\n")[0]).toBe(overLine);
		expect(reRep!.after.split("\n")[1]).toBe("call UPDATED()");

		const litHits = await ws.search("TARGET", { regex: false });
		expect(litHits.length).toBe(2);
		const litRep = await ws.replaced(filePath, "TARGET", "UPDATED", { regex: false });
		expect(litRep!.count).toBe(2);
	});

	test("Search.tsx scanTextBuffer() and replaceInModel() enforce REGEX_MAX_LINE_LENGTH and drop backend.replace cast", async () => {
		const { replaceInModel, scanTextBuffer } = await import("../src/view/panels/Search");
		const overLine = `${"z".repeat(REGEX_MAX_LINE_LENGTH + 10)}TOKEN`;
		const shortLine = "let TOKEN = 1;";
		const text = `${overLine}\n${shortLine}`;

		const regexHits = scanTextBuffer("/ws/a.ssl", text, searchPattern("TOKEN", { regex: true }), true, 100);
		expect(regexHits.length).toBe(1);
		expect(regexHits[0]!.line).toBe(2);

		const litHits = scanTextBuffer("/ws/a.ssl", text, searchPattern("TOKEN", { regex: false }), false, 100);
		expect(litHits.length).toBe(2);

		const lines = [overLine, shortLine];
		const applied: { range: any; text: string }[] = [];
		const fakeModel = {
			getLineCount: () => lines.length,
			getLineContent: (n: number) => lines[n - 1]!,
			pushStackElement() {},
			pushEditOperations(_s: any, edits: any[]) {
				applied.push(...edits);
				return null;
			},
		} as any;

		const changedRegex = replaceInModel(fakeModel, searchPattern("TOKEN", { regex: true }), "VALUE", true);
		expect(changedRegex).toBe(1);
		expect(applied.length).toBe(1);
		expect(applied[0]!.range.startLineNumber).toBe(2);

		applied.length = 0;
		const changedLit = replaceInModel(fakeModel, searchPattern("TOKEN", { regex: false }), "VALUE", false);
		expect(changedLit).toBe(2);
		expect(applied.length).toBe(2);

		// Verify BackendApi.replace type sync and cast removal.
		const protocolSrc = readSrc("src/shared/protocol.ts");
		expect(protocolSrc).toContain("skippedProtected?: number; invalidJson?: boolean; error?: string");
		const searchSrc = readSrc("src/view/panels/Search.tsx");
		expect(searchSrc).toContain("const results = await backend.replace(query, with_, replaceOptions, onDiskPaths);");
		expect(readSrc("src/bun/workspace.ts")).not.toContain("const REGEX_MAX_LINE_LENGTH");
	});
});

describe("R10B #7 — Stale lastMarkdownPath cleared on workspace switch/close & copyCodeCitation containment check", () => {
	test("EditorGroup.clearEditorViewStates clears lastMarkdownPath on workspace reset or matching file close, and commands.ts validates workspace containment", async () => {
		const { clearEditorViewStates, lastActiveMarkdownPath } = await import("../src/view/editor/EditorGroup");
		// Clearing with no path always resets lastActiveMarkdownPath to null cleanly.
		clearEditorViewStates();
		expect(lastActiveMarkdownPath()).toBeNull();

		const egSrc = readSrc("src/view/editor/EditorGroup.tsx");
		expect(egSrc).toMatch(/export function clearEditorViewStates[\s\S]*?if \(!path\)[\s\S]*?setLastMarkdownPath\(null\)/);
		expect(egSrc).toMatch(/const lastMd = lastMarkdownPath\(\);\s*if \(lastMd && canonical\(path\) === canonical\(lastMd\)\)/);

		const cmdSrc = readSrc("src/view/commands.ts");
		expect(cmdSrc).toContain("(!wsRoot || isInside(wsRoot, lastMd))");
	});
});

describe("R10B #8 — Redundant no-op buttons dropped beside Dialog's automatic Cancel", () => {
	test("Agent.tsx and commands.ts omit redundant 'Keep current' and 'Done' choices", () => {
		const agentSrc = readSrc("src/view/agent/Agent.tsx");
		expect(agentSrc).toContain('await choose("Replace your current Agent draft?", [REPLACE])');
		expect(agentSrc).not.toContain('[REPLACE, "Keep current"]');

		const cmdSrc = readSrc("src/view/commands.ts");
		expect(cmdSrc).toContain("await choose(`Created ticket folder for ${target.ticket || baseName(target.path)}.`, [ADD_FILE])");
		expect(cmdSrc).not.toContain('[ADD_FILE, "Done"]');
	});
});

describe("R11 — Final Clean-Sweep Verification Fixes", () => {
	test("parseOpencodeCommandEnv trims and collapses whitespace on fallback splitting", () => {
		expect(parseOpencodeCommandEnv("  bun   /tmp/fake-opencode.ts  ")).toEqual(["bun", "/tmp/fake-opencode.ts"]);
		expect(parseOpencodeCommandEnv("\tbun\t--flag\tscript.ts\n")).toEqual(["bun", "--flag", "script.ts"]);
		expect(parseOpencodeCommandEnv("   ")).toBeUndefined();
	});

	test("backend open() captures restartSeq and yields LSP ownership to concurrent lspRestart()", async () => {
		const backendSrc = readSrc("src/bun/backend.ts");
		expect(backendSrc).toContain("const restartSeq = ++lspRestartSeq;");
		expect(backendSrc).toContain("if (restartSeq === lspRestartSeq) {");

		// Live concurrency check: open() + immediate lspRestart() never orphans two processes on the old binary.
		await withTempDirs(async () => {
			const wsDir = mkdtempSync(join(rootTmp, "ws-r11-"));
			const binDir = mkdtempSync(join(rootTmp, "bin-r11-"));
			const marker = join(binDir, "started.log");
			const lspV1 = makeFakeLspScript(binDir, "lsp-v1.sh", "0.31.0", marker);
			const lspV2 = makeFakeLspScript(binDir, "lsp-v2.sh", "0.32.0", marker);

			const host = {
				emit: () => {},
				pick: async () => null,
				trash: async () => {},
				app: "test",
				kind: "browser" as const,
				quit: () => {},
			};
			const b = createBackend(host);
			try {
				await b.api.saveSettings("user", { lspPath: lspV1 });
				const opening = b.api.openFolder(wsDir);
				// Immediately switch lspPath and trigger lspRestart() while open() is in flight.
				await b.api.saveSettings("user", { lspPath: lspV2 });
				const restarting = b.api.lspRestart();
				await Promise.all([opening, restarting]);
				await new Promise((r) => setTimeout(r, 80));
				const info = await b.api.info();
				expect(info.lsp.path).toBe(lspV2);
				expect(info.lsp.version).toBe("0.32.0");
			} finally {
				b.dispose();
			}
		});
	});

	test("state.ts openFolder() cancel restarts LSP via restartLsp() rather than double-initializing", () => {
		const stateSrc = readSrc("src/view/state.ts");
		expect(stateSrc).toMatch(/if \(!workspace\) \{[\s\S]*?session\.setRoot\(prevRoot\);[\s\S]*?void restartLsp\(\);/);
		expect(stateSrc).toMatch(/export async function restartLsp\(\)[\s\S]*?const seq = openSeq;[\s\S]*?if \(next && seq === openSeq\) setState\(\(s\) => \{ s\.info = next; \}\);/);
	});

	test("R12: loadInfo() monotonic infoSeq, open() emits stopped on teardown, readAuthToken guards partial document, and GraphView uses restartLsp()", () => {
		const backendSrc = readSrc("src/bun/backend.ts");
		expect(backendSrc).toContain("const seq = ++infoSeq;");
		expect(backendSrc).toContain("if (!disposed && seq === infoSeq) info = next;");
		expect(backendSrc).toContain('if (prevLsp || lspState.state !== "stopped") emitLspState({ state: "stopped" });');

		const viewBackendSrc = readSrc("src/view/backend.ts");
		expect(viewBackendSrc).toContain('typeof document.querySelector !== "function"');

		const graphSrc = readSrc("src/view/graph/GraphView.tsx");
		expect(graphSrc).toContain("void restartLsp()");
		expect(graphSrc).not.toContain("backend.lspRestart()");
	});
});
