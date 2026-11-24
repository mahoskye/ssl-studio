import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Agent, firstUrl, isLocalModelRef, parseModelRef, validateAgentServerUrl } from "../src/bun/agent";
import { createBackend, type Host } from "../src/bun/backend";
import { Git } from "../src/bun/git";
import { dirs } from "../src/bun/paths";
import { projectSettings, readProject } from "../src/bun/project";
import { SettingsStore, USER_ONLY_SETTINGS } from "../src/bun/settings";

const rootTmp = mkdtempSync(join(tmpdir(), "ssl-studio-r6a-"));
const gitCfgDir = mkdtempSync(join(tmpdir(), "ssl-studio-r6a-gitconfig-"));
const emptyGitConfig = join(gitCfgDir, "config");
writeFileSync(emptyGitConfig, "");
const gitIdentity: Record<string, string> = {
	GIT_AUTHOR_NAME: "R6A Tester",
	GIT_AUTHOR_EMAIL: "r6a@example.test",
	GIT_COMMITTER_NAME: "R6A Tester",
	GIT_COMMITTER_EMAIL: "r6a@example.test",
	GIT_CONFIG_GLOBAL: emptyGitConfig,
	GIT_CONFIG_NOSYSTEM: "1",
};
const hasGit = Bun.spawnSync(["git", "--version"]).exitCode === 0;
const savedGitEnv = Object.fromEntries(Object.keys(gitIdentity).map((k) => [k, process.env[k]]));

beforeAll(() => void Object.assign(process.env, gitIdentity));
afterAll(() => {
	for (const [k, v] of Object.entries(savedGitEnv)) {
		if (v === undefined) delete process.env[k];
		else process.env[k] = v;
	}
	rmSync(rootTmp, { recursive: true, force: true });
	rmSync(gitCfgDir, { recursive: true, force: true });
});

function makeHost(): Host {
	return {
		app: "test",
		kind: "app",
		emit: () => {},
		pick: async () => null,
		trash: async () => {},
		quit: () => {},
	};
}

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

function initRepo(name: string): { root: string; runGit: (...args: string[]) => string } {
	const root = join(rootTmp, name);
	mkdirSync(root, { recursive: true });
	const runGit = (...args: string[]) => {
		const res = Bun.spawnSync(["git", "-C", root, ...args], { env: { ...process.env, ...gitIdentity } });
		if (res.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${res.stderr.toString()}`);
		return res.stdout.toString();
	};
	runGit("init", "-q");
	runGit("symbolic-ref", "HEAD", "refs/heads/main");
	runGit("config", "core.autocrlf", "false");
	runGit("config", "commit.gpgsign", "false");
	return { root, runGit };
}

describe("Paid-model gate, USER_ONLY_SETTINGS, and URL validation", () => {
	test("validateAgentServerUrl enforces loopback/https rules and blocks userinfo, query, fragment, and SSRF", () => {
		expect(validateAgentServerUrl("http://127.0.0.1:4096/", true)).toBe("http://127.0.0.1:4096");
		expect(validateAgentServerUrl("http://localhost:4096", true)).toBe("http://localhost:4096");
		expect(validateAgentServerUrl("http://[::1]:4096/", true)).toBe("http://[::1]:4096");
		expect(validateAgentServerUrl("https://127.0.0.1:4096", true)).toBe("https://127.0.0.1:4096");
		expect(validateAgentServerUrl("https://opencode.internal/api/", false)).toBe("https://opencode.internal/api");

		// Remote HTTPS rejected when requireLoopback is true (child stdout firstUrl).
		expect(() => validateAgentServerUrl("https://opencode.internal", true)).toThrow(/loopback/i);
		// Remote HTTP rejected even when requireLoopback is false.
		expect(() => validateAgentServerUrl("http://opencode.internal:4096", false)).toThrow(/https/i);
		expect(() => validateAgentServerUrl("http://169.254.169.254/latest", false)).toThrow(/https/i);
		expect(() => validateAgentServerUrl("http://0.0.0.0:4096", false)).toThrow(/https/i);
		// Userinfo, query, fragment, and non-HTTP schemes rejected.
		expect(() => validateAgentServerUrl("http://user:pass@127.0.0.1:4096", false)).toThrow(/credentials/i);
		expect(() => validateAgentServerUrl("http://@127.0.0.1:4096", false)).toThrow(/credentials/i);
		expect(() => validateAgentServerUrl("http://127.0.0.1:4096?x=1", false)).toThrow(/query|fragment/i);
		expect(() => validateAgentServerUrl("http://127.0.0.1:4096?", false)).toThrow(/query|fragment/i);
		expect(() => validateAgentServerUrl("http://127.0.0.1:4096#frag", false)).toThrow(/query|fragment/i);
		expect(() => validateAgentServerUrl("http://127.0.0.1:4096#", false)).toThrow(/query|fragment/i);
		expect(() => validateAgentServerUrl("file:///etc/passwd", false)).toThrow(/protocol/i);
		expect(() => validateAgentServerUrl("not a url", false)).toThrow(/Invalid/i);
		expect(() => validateAgentServerUrl("   ", false)).toThrow(/empty/i);
	});

	test("USER_ONLY_SETTINGS includes agentModel and blocks untrusted workspace/project paid-model overrides", async () => {
		expect(USER_ONLY_SETTINGS.has("agentModel")).toBe(true);

		await withTempDirs(async ({ config }) => {
			const ws = join(rootTmp, "ws-paid-guard");
			mkdirSync(join(ws, ".ssl-studio"), { recursive: true });
			mkdirSync(config, { recursive: true });

			writeFileSync(join(config, "settings.json"), JSON.stringify({ agentModel: "ollama/qwen3:14b" }));
			writeFileSync(
				join(ws, ".ssl-studio", "project.toml"),
				'[project]\nname = "Untrusted"\n[agent]\nmodel = "openrouter/expensive-model"\n[style]\npreset = "server"\n',
			);
			writeFileSync(
				join(ws, ".ssl-studio", "settings.json"),
				JSON.stringify({ agentModel: "openai/gpt-5", fontSize: 15 }),
			);

			// project.toml metadata keeps agentModel visible for inspection, but projectSettings refuses non-local models.
			const proj = await readProject(ws);
			expect(proj.agentModel).toBe("openrouter/expensive-model");
			expect(projectSettings(proj)).toEqual({ stylePreset: "server" });

			// Local project.toml model is permitted in projectSettings directly...
			const localProj = { ...proj, agentModel: "ollama/qwen3:14b" };
			expect(projectSettings(localProj)).toEqual({ agentModel: "ollama/qwen3:14b", stylePreset: "server" });

			// ...while SettingsStore strips agentModel from both workspace and project layers, honoring only user scope.
			const store = new SettingsStore(() => ws);
			const loaded = await store.load();
			expect(loaded.workspace).toEqual({ fontSize: 15 });
			expect(loaded.effective.agentModel).toBe("ollama/qwen3:14b");
			expect(loaded.effective.stylePreset).toBe("server");

			// Saving agentModel into workspace scope is stripped.
			const afterWsSave = await store.save("workspace", { agentModel: "anthropic/claude-opus", fontSize: 16 });
			expect(afterWsSave.agentModel).toBe("ollama/qwen3:14b");
			expect(JSON.parse(readFileSync(join(ws, ".ssl-studio", "settings.json"), "utf8"))).toEqual({ fontSize: 16 });
		});
	});

	test("parseModelRef and isLocalModelRef normalize case and whitespace strictly", () => {
		expect(parseModelRef("  Ollama / Qwen3:14B  ")).toEqual({
			providerID: "Ollama",
			id: "Qwen3:14B",
			normalized: "ollama/qwen3:14b",
		});
		expect(parseModelRef("ollama/")).toBeNull();
		expect(parseModelRef("/qwen")).toBeNull();
		expect(parseModelRef("just-name")).toBeNull();
		expect(isLocalModelRef("OLLAMA/qwen3:14b")).toBe(true);
		expect(isLocalModelRef("openrouter/paid-model")).toBe(false);
		expect(isLocalModelRef("openrouter/paid-model", ["  OpenRouter / PAID-MODEL "])).toBe(true);
	});
});

describe("Agent backend security, SSE parser, lifecycle, and 200+ message sessions", () => {
	const servers: ReturnType<typeof Bun.serve>[] = [];
	const agents: Agent[] = [];
	const origServerPassword = process.env.OPENCODE_SERVER_PASSWORD;

	afterEach(() => {
		for (const a of agents.splice(0)) a.dispose();
		for (const s of servers.splice(0)) s.stop(true);
		if (origServerPassword === undefined) delete process.env.OPENCODE_SERVER_PASSWORD;
		else process.env.OPENCODE_SERVER_PASSWORD = origServerPassword;
	});

	function trackServer(srv: ReturnType<typeof Bun.serve>) {
		servers.push(srv);
		return srv;
	}
	function trackAgent(a: Agent) {
		agents.push(a);
		return a;
	}

	test("handles CRLF SSE frames, multi-line data:, non-Latin1 passwords, malformed frames, null guards, interrupt validation, and model confirmation", async () => {
		const ws = join(rootTmp, "agent-sse-ws");
		mkdirSync(ws, { recursive: true });
		process.env.OPENCODE_SERVER_PASSWORD = "pässwörd-🔑";
		const expectedAuth = `Basic ${Buffer.from("opencode:pässwörd-🔑", "utf8").toString("base64")}`;

		const sseStreams = new Set<ReadableStreamDefaultController<Uint8Array>>();
		const deletedForms: string[] = [];
		const interruptedPaths: string[] = [];
		const createdModels: { providerID: string; id: string }[] = [];
		let msgSeq = 0;
		const sessions = new Map<string, any[]>();
		const enc = new TextEncoder();

		const srv = trackServer(
			Bun.serve({
				hostname: "127.0.0.1",
				port: 0,
				idleTimeout: 0,
				async fetch(req) {
					if (req.headers.get("authorization") !== expectedAuth) return new Response("unauthorized", { status: 401 });
					const url = new URL(req.url);
					const path = url.pathname;
					if (path === "/api/info") return Response.json({ data: { version: "2.3.2" } });
					if (path === "/api/model") {
						return Response.json({
							data: [
								{ providerID: " openrouter ", modelID: " Paid-Model ", name: "Paid", capabilities: { tools: true }, variants: null },
								{ providerID: "ollama", modelID: "qwen3:14b", name: "Qwen3", capabilities: { tools: true }, variants: [] },
								{ providerID: "  ", modelID: "broken", name: "Broken", capabilities: { tools: true } },
							],
						});
					}
					if (path === "/api/event") {
						return new Response(
							new ReadableStream<Uint8Array>({
								start(ctrl) {
									sseStreams.add(ctrl);
									// CRLF event frame without space after `data:`
									ctrl.enqueue(enc.encode('data:{"type":"server.connected","data":{}}\r\n\r\n'));
								},
								cancel(ctrl) {
									sseStreams.delete(ctrl as any);
								},
							}),
							{ headers: { "content-type": "text/event-stream" } },
						);
					}
					if (path === "/api/session" && req.method === "POST") {
						const body = await req.json();
						createdModels.push(body.model);
						// Session ID with special chars to verify encodeURIComponent everywhere.
						const id = "ses/special#1";
						sessions.set(id, []);
						return Response.json({ data: { id } });
					}
					const formMatch = /^\/api\/session\/([^/]+)\/form\/([^/]+)$/.exec(path);
					if (formMatch && req.method === "DELETE") {
						deletedForms.push(path);
						return new Response(null, { status: 204 });
					}
					const sessMatch = /^\/api\/session\/([^/]+)(\/.*)?$/.exec(path);
					if (sessMatch) {
						const id = decodeURIComponent(sessMatch[1]!);
						const msgs = sessions.get(id);
						if (!msgs) return new Response("missing", { status: 404 });
						if (sessMatch[2] === "/interrupt") {
							interruptedPaths.push(path);
							return Response.json({ ok: true });
						}
						if (sessMatch[2] === "/message") {
							return Response.json({ data: [...msgs].reverse() });
						}
						if (sessMatch[2] === "/prompt") {
							const body = await req.json();
							setTimeout(() => {
								const push = (raw: string) => {
									for (const s of sseStreams) s.enqueue(enc.encode(raw));
								};
								// 1. Malformed JSON frame (must not crash stream)
								push("data: {not-valid-json\r\n\r\n");
								// 2. form.created with missing form.id (must not crash dispatch)
								push(`data: ${JSON.stringify({ type: "form.created", data: { sessionID: id, form: {} } })}\r\n\r\n`);
								// 3. form.created with special-char form.id (must URL-encode both IDs)
								push(`data: ${JSON.stringify({ type: "form.created", data: { sessionID: id, form: { id: "frm/9?x" } } })}\r\n\r\n`);
								// 4. session.tool.progress with non-array toolCalls (must not crash guard)
								push(`data: ${JSON.stringify({ type: "session.tool.progress", data: { sessionID: id, metadata: { toolCalls: "not-an-array" } } })}\r\n\r\n`);
								// 5. Multi-line `data:` block with CRLF line endings
								const deltaLines = JSON.stringify({ type: "session.text.delta", data: { sessionID: id, delta: "hello" } }, null, 2).split("\n");
								push(`${deltaLines.map((ln) => `data: ${ln}`).join("\r\n")}\r\n\r\n`);
								msgs.push(
									{ id: `m_${++msgSeq}`, type: "user", text: body.text },
									{ id: `m_${++msgSeq}`, type: "assistant", content: [{ type: "text", text: "CRLF reply ok" }], tokens: { input: 10, output: 5 }, cost: 0 },
									{ id: `m_${++msgSeq}`, type: "idle", outcome: "succeeded" },
								);
								push(`data: ${JSON.stringify({ type: "session.execution.succeeded", data: { sessionID: id } })}\r\n\r\n`);
							}, 15);
							return Response.json({ data: { id: "inb_1" } });
						}
						if (!sessMatch[2] && req.method === "DELETE") {
							sessions.delete(id);
							return new Response(null, { status: 204 });
						}
					}
					return new Response("not found", { status: 404 });
				},
			}),
		);

		const events: { type: string; data: any }[] = [];
		const agent = trackAgent(new Agent((type, data) => events.push({ type, data }), () => ws));

		// Unconfirmed paid model must be refused before creating any session.
		agent.configure({ serverUrl: `http://127.0.0.1:${srv.port}`, model: "openrouter/paid-model" });
		await expect(agent.ask({ text: "should refuse" })).rejects.toThrow(/not a local model and has not been confirmed/i);
		expect(createdModels).toEqual([]);

		// Malformed model ref must be refused.
		agent.configure({ serverUrl: `http://127.0.0.1:${srv.port}`, model: "ollama/" });
		await expect(agent.ask({ text: "bad ref" })).rejects.toThrow(/Invalid agent model/i);

		// Case-insensitive + whitespace-trimmed ownModels allowlist works cleanly.
		agent.configure({
			serverUrl: `http://127.0.0.1:${srv.port}`,
			model: "  OPENROUTER / paid-model ",
			ownModels: [" OpenRouter / PAID-MODEL "],
		});
		const catalog = await agent.models();
		expect(catalog.map((m) => `${m.providerID}/${m.id}`)).toEqual(["ollama/qwen3:14b", "openrouter/Paid-Model"]);
		expect(catalog.every((m) => m.local)).toBe(true);

		const reply = await agent.ask({ text: "ping", keep: true });
		expect(reply.outcome).toBe("succeeded");
		expect(reply.text).toBe("CRLF reply ok");
		expect(createdModels).toEqual([{ providerID: "openrouter", id: "Paid-Model" }]);
		expect(events.some((e) => e.type === "session.text.delta" && e.data?.delta === "hello")).toBe(true);
		await Bun.sleep(20);
		expect(deletedForms).toEqual(["/api/session/ses%2Fspecial%231/form/frm%2F9%3Fx"]);

		// Interrupt rejects unknown / traversal / non-string IDs and URL-encodes valid session IDs.
		await expect(agent.call("interrupt", ["../model"])).rejects.toThrow(/unknown agent session/i);
		await expect(agent.call("interrupt", ["ses_does_not_exist"])).rejects.toThrow(/unknown agent session/i);
		await expect(agent.call("interrupt", [123 as any])).rejects.toThrow(/unknown agent session/i);
		await agent.call("interrupt", ["ses/special#1"]);
		expect(interruptedPaths).toEqual(["/api/session/ses%2Fspecial%231/interrupt"]);
	});

	test("HTTP 500 on /api/event does not infinite-loop and HTTP 302 redirects are rejected", async () => {
		const ws = join(rootTmp, "agent-sse-500-ws");
		mkdirSync(ws, { recursive: true });
		let eventHits = 0;

		const srv500 = trackServer(
			Bun.serve({
				hostname: "127.0.0.1",
				port: 0,
				fetch(req) {
					const path = new URL(req.url).pathname;
					if (path === "/api/info") return Response.json({ data: { version: "2.2.5" } });
					if (path === "/api/event") {
						eventHits++;
						return new Response("Internal Server Error body that used to reset attempt=0", { status: 500 });
					}
					return new Response("not found", { status: 404 });
				},
			}),
		);

		const statuses: string[] = [];
		const agent = trackAgent(
			new Agent((type, data: any) => {
				if (type === "status") statuses.push(data.state);
			}, () => ws),
		);
		agent.configure({ serverUrl: `http://127.0.0.1:${srv500.port}`, reconnectDelayMs: 15 });
		await agent.call("start", []);
		await Bun.sleep(200);
		// Initial attempt + 3 retries = 4 hits, then permanently stops in "failed" state (no infinite loop).
		expect(eventHits).toBe(4);
		expect(statuses.at(-1)).toBe("failed");

		// Redirect rejection (`redirect: "error"`).
		const srvRedirect = trackServer(
			Bun.serve({
				hostname: "127.0.0.1",
				port: 0,
				fetch() {
					return new Response(null, { status: 302, headers: { Location: "http://127.0.0.1:1/steal" } });
				},
			}),
		);
		const redirAgent = trackAgent(new Agent(() => {}, () => ws));
		redirAgent.configure({ serverUrl: `http://127.0.0.1:${srvRedirect.port}` });
		await expect(redirAgent.call("start", [])).rejects.toThrow();
	});

	test("startEpoch prevents stop() race from resurrecting, workspaceChanged resolves waiters, concurrent ask is rejected, and dead server does not mask failure", async () => {
		const ws = join(rootTmp, "agent-lifecycle-ws");
		mkdirSync(ws, { recursive: true });
		let slowInfo = true;
		const dropStreams: (() => void)[] = [];
		let killAfterDrop = false;

		const srv = trackServer(
			Bun.serve({
				hostname: "127.0.0.1",
				port: 0,
				idleTimeout: 0,
				async fetch(req) {
					const path = new URL(req.url).pathname;
					if (path === "/api/info") {
						if (slowInfo) await Bun.sleep(80);
						return Response.json({ data: { version: "2.2.5" } });
					}
					if (path === "/api/model") {
						return Response.json({
							data: [{ providerID: "ollama", modelID: "qwen3:14b", name: "Qwen3", capabilities: { tools: true }, variants: [] }],
						});
					}
					if (path === "/api/event") {
						return new Response(
							new ReadableStream<Uint8Array>({
								start(ctrl) {
									ctrl.enqueue(new TextEncoder().encode('data: {"type":"server.connected","data":{}}\n\n'));
									dropStreams.push(() => {
										try {
											ctrl.close();
										} catch {
											// already closed
										}
										if (killAfterDrop) srv.stop(true);
									});
								},
							}),
							{ headers: { "content-type": "text/event-stream" } },
						);
					}
					if (path === "/api/session" && req.method === "POST") {
						return Response.json({ data: { id: "ses_live" } });
					}
					if (path === "/api/session/ses_live/message") {
						return Response.json({ data: [] });
					}
					if (path === "/api/session/ses_live/prompt") {
						return Response.json({ data: { id: "inb_1" } });
					}
					if (path === "/api/session/ses_live" && req.method === "DELETE") {
						return new Response(null, { status: 204 });
					}
					return new Response("not found", { status: 404 });
				},
			}),
		);

		// 1. start() racing with stop() must never transition to "ready".
		const raceStates: string[] = [];
		const raceAgent = trackAgent(
			new Agent((type, data: any) => {
				if (type === "status") raceStates.push(data.state);
			}, () => ws),
		);
		raceAgent.configure({ serverUrl: `http://127.0.0.1:${srv.port}` });
		const starting = raceAgent.call("start", []).catch(() => "cancelled");
		await Bun.sleep(20);
		raceAgent.stop();
		await starting;
		await Bun.sleep(100);
		expect(raceStates).not.toContain("ready");
		expect((await raceAgent.call("status", [])) as any).toMatchObject({ state: "off" });

		// 2. Concurrent ask() on same session rejected; workspaceChanged() resolves pending waiter immediately.
		slowInfo = false;
		const agent = trackAgent(new Agent(() => {}, () => ws));
		agent.configure({ serverUrl: `http://127.0.0.1:${srv.port}`, reconnectDelayMs: 5000 });
		await agent.call("start", []);

		const inFlight = agent.ask({ text: "first turn", keep: true });
		await Bun.sleep(30);
		await expect(agent.ask({ text: "second concurrent", sessionID: "ses_live", keep: true })).rejects.toThrow(/already in progress/i);

		await agent.workspaceChanged();
		const interruptedReply = await inFlight;
		expect(interruptedReply.outcome).toBe("interrupted");

		// 3. Dropped SSE + dead server (ECONNREFUSED on /message) preserves outcome: "failed" & real error.
		const failingTurn = agent.ask({ text: "turn before crash", keep: true });
		await Bun.sleep(30);
		killAfterDrop = true;
		for (const drop of dropStreams) drop();
		const failedReply = await failingTurn;
		expect(failedReply.outcome).toBe("failed");
		expect(failedReply.error).toMatch(/Lost opencode's event stream/i);
	});

	test("handles 200+ message kept sessions without hitting the 200-message cliff", async () => {
		const ws = join(rootTmp, "agent-200msg-ws");
		mkdirSync(ws, { recursive: true });
		const streams = new Set<ReadableStreamDefaultController<Uint8Array>>();
		const enc = new TextEncoder();

		// Pre-populate 230 messages on the kept session.
		const messages: any[] = [];
		for (let i = 1; i <= 230; i++) {
			messages.push({
				id: `msg_${i}`,
				type: i % 2 === 1 ? "user" : "assistant",
				content: i % 2 === 0 ? [{ type: "text", text: `old-${i}` }] : undefined,
				tokens: { input: 1, output: 1 },
				cost: 0,
			});
		}
		let seq = 230;

		const srv = trackServer(
			Bun.serve({
				hostname: "127.0.0.1",
				port: 0,
				idleTimeout: 0,
				async fetch(req) {
					const url = new URL(req.url);
					const path = url.pathname;
					if (path === "/api/info") return Response.json({ data: { version: "2.3.2" } });
					if (path === "/api/model") {
						return Response.json({
							data: [{ providerID: "ollama", modelID: "qwen3:14b", name: "Qwen3", capabilities: { tools: true }, variants: [] }],
						});
					}
					if (path === "/api/event") {
						return new Response(
							new ReadableStream<Uint8Array>({
								start(ctrl) {
									streams.add(ctrl);
									ctrl.enqueue(enc.encode('data: {"type":"server.connected","data":{}}\n\n'));
								},
								cancel(ctrl) {
									streams.delete(ctrl as any);
								},
							}),
							{ headers: { "content-type": "text/event-stream" } },
						);
					}
					if (path === "/api/session" && req.method === "POST") {
						return Response.json({ data: { id: "ses_long" } });
					}
					if (path === "/api/session/ses_long/message") {
						const limit = Number(url.searchParams.get("limit") ?? 50);
						const order = url.searchParams.get("order") ?? "asc";
						const ordered = order === "desc" ? [...messages].reverse() : [...messages];
						return Response.json({ data: ordered.slice(0, limit) });
					}
					if (path === "/api/session/ses_long/prompt") {
						const body = await req.json();
						setTimeout(() => {
							messages.push(
								{ id: `msg_${++seq}`, type: "user", text: body.text },
								{ id: `msg_${++seq}`, type: "assistant", content: [{ type: "text", text: `Part 1 (${body.text})` }], tokens: { input: 12, output: 4 }, cost: 0 },
								{ id: `msg_${++seq}`, type: "assistant", content: [{ type: "text", text: `Part 2 (${body.text})` }], tokens: { input: 8, output: 6 }, cost: 0 },
								{ id: `msg_${++seq}`, type: "idle", outcome: "succeeded" },
							);
							for (const s of streams) {
								s.enqueue(enc.encode(`data: ${JSON.stringify({ type: "session.execution.succeeded", data: { sessionID: "ses_long" } })}\n\n`));
							}
						}, 10);
						return Response.json({ data: { id: "inb_ok" } });
					}
					return new Response("not found", { status: 404 });
				},
			}),
		);

		const agent = trackAgent(new Agent(() => {}, () => ws));
		agent.configure({ serverUrl: `http://127.0.0.1:${srv.port}` });

		const r1 = await agent.ask({ text: "turn-231", keep: true });
		expect(r1.outcome).toBe("succeeded");
		expect(r1.text).toBe("Part 1 (turn-231)\nPart 2 (turn-231)");
		expect(r1.tokens).toEqual({ input: 20, output: 10 });

		const r2 = await agent.ask({ text: "turn-232", sessionID: r1.sessionID, keep: true });
		expect(r2.outcome).toBe("succeeded");
		expect(r2.text).toBe("Part 1 (turn-232)\nPart 2 (turn-232)");
	});

	test("firstUrl times out and kills hung children, rejects non-loopback stdout URLs, and drains heavy stderr without deadlock", async () => {
		// 1. Hung child process times out cleanly and is killed.
		const hung = Bun.spawn(["bun", "-e", "await Bun.sleep(60_000)"], { stdin: "pipe", stdout: "pipe", stderr: "pipe" });
		const t0 = Date.now();
		await expect(firstUrl(hung, 150)).rejects.toThrow(/did not start within/i);
		expect(Date.now() - t0).toBeLessThan(2000);
		await Promise.race([hung.exited, Bun.sleep(1000)]);
		expect(hung.killed || hung.exitCode !== null || hung.signalCode !== null).toBe(true);

		// 2. Non-loopback URL on stdout is rejected and process killed.
		const ssrfProc = Bun.spawn(["bun", "-e", 'console.log(JSON.stringify({ url: "https://evil.example:443" })); await Bun.sleep(10_000);'], {
			stdin: "pipe",
			stdout: "pipe",
			stderr: "pipe",
		});
		await expect(firstUrl(ssrfProc, 2000)).rejects.toThrow(/loopback/i);
		await Promise.race([ssrfProc.exited, Bun.sleep(1000)]);
		expect(ssrfProc.killed || ssrfProc.exitCode !== null || ssrfProc.signalCode !== null).toBe(true);

		// 3. Heavy stderr (> 256 KB, exceeding OS pipe buffer) does not deadlock startup.
		const noisyScript = `
			const chunk = "E".repeat(4096) + "\\n";
			for (let i = 0; i < 70; i++) process.stderr.write(chunk);
			console.log(JSON.stringify({ url: "http://127.0.0.1:43210" }));
			for (let i = 0; i < 30; i++) process.stderr.write(chunk);
		`;
		const noisy = Bun.spawn(["bun", "-e", noisyScript], { stdin: "pipe", stdout: "pipe", stderr: "pipe" });
		try {
			const url = await firstUrl(noisy, 5000);
			expect(url).toBe("http://127.0.0.1:43210");
			await Promise.race([noisy.exited, Bun.sleep(2000)]);
			expect(noisy.exitCode).toBe(0);
		} finally {
			noisy.kill();
		}
	});
});

describe.skipIf(!hasGit)("Git & Backend Round 6A+6B repairs", () => {
	test("rangeLog rejects option/range injection (-G., .., control chars) and annotates repoPath/inWorkspace via -z", async () => {
		const { root, runGit } = initRepo("git-rangelog");
		const app = join(root, "app");
		mkdirSync(app, { recursive: true });
		writeFileSync(join(root, "outside.md"), "v1\n");
		writeFileSync(join(app, " leading.ssl"), ":RETURN 1;\n");
		runGit("add", "-A");
		runGit("commit", "-m", "Initial commit");
		runGit("tag", "v1.0");

		writeFileSync(join(root, "outside.md"), "v2\n");
		writeFileSync(join(app, " leading.ssl"), ":RETURN 2;\n");
		writeFileSync(join(app, "café.ssl"), ":RETURN 3;\n");
		runGit("add", "-A");
		runGit("commit", "-m", "DEMO-1: Update workspace & outside files");

		const git = new Git(app);
		try {
			// Option / argument / range injection attempts must be rejected cleanly.
			expect(await git.rangeLog("-G.", "HEAD")).toEqual([]);
			expect(await git.rangeLog("--all", "HEAD")).toEqual([]);
			expect(await git.rangeLog("v1.0..HEAD", "HEAD")).toEqual([]);
			expect(await git.rangeLog("v1.0", "-n1")).toEqual([]);
			expect(await git.rangeLog("v1.0\x00--all", "HEAD")).toEqual([]);

			const commits = await git.rangeLog("v1.0", "HEAD");
			expect(commits).toHaveLength(1);
			const byRepoPath = new Map(commits[0]!.files.map((f) => [f.repoPath, f]));
			expect(byRepoPath.get("app/ leading.ssl")).toEqual({
				status: "M",
				path: " leading.ssl",
				repoPath: "app/ leading.ssl",
				inWorkspace: true,
			});
			expect(byRepoPath.get("app/café.ssl")).toEqual({
				status: "A",
				path: "café.ssl",
				repoPath: "app/café.ssl",
				inWorkspace: true,
			});
			expect(byRepoPath.get("outside.md")).toEqual({
				status: "M",
				path: "outside.md",
				repoPath: "outside.md",
				inWorkspace: false,
			});

			// ticketLog preserves filenames with leading spaces, avoids DEMO-1 matching DEMO-101, and sets repoPath/inWorkspace.
			writeFileSync(join(app, "other.ssl"), ":RETURN 9;\n");
			runGit("add", "-A");
			runGit("commit", "-m", "DEMO-101: Unrelated longer ticket key");

			const tCommits = await git.ticketLog("DEMO-1");
			expect(tCommits.map((c) => c.subject)).toEqual(["DEMO-1: Update workspace & outside files"]);
			expect(tCommits[0]!.files.find((f) => f.repoPath === "app/ leading.ssl")?.inWorkspace).toBe(true);
			expect(tCommits[0]!.files.find((f) => f.repoPath === "outside.md")?.inWorkspace).toBe(false);
		} finally {
			git.dispose();
		}
	});

	test("repository() deduplicates concurrent init and preserves leading spaces in subdir prefix", async () => {
		const { root, runGit } = initRepo("git-repo-race");
		const spaced = join(root, " spaced-app");
		mkdirSync(spaced, { recursive: true });
		const file = join(spaced, "a.ssl");
		writeFileSync(file, "v1\n");
		runGit("add", "-A");
		runGit("commit", "-m", "init");
		writeFileSync(file, "v2\n");

		const git = new Git(spaced);
		try {
			// Fire concurrent calls on a brand-new Git instance before repository() has resolved.
			const [b1, b2, st, diffText] = await Promise.all([
				git.base(file, "head"),
				git.base(file, "index"),
				git.status(),
				git.diff(),
			]);
			expect(b1).toBe("v1\n");
			expect(b2).toBe("v1\n");
			expect(st?.files).toEqual([{ path: file, staged: null, unstaged: "modified" }]);
			expect(diffText).toContain("+v2");
		} finally {
			git.dispose();
		}
	});

	test("unstage and base handle same-dir and cross-subdir staged renames while preserving workspace boundary for unrelated files", async () => {
		const { root, runGit } = initRepo("git-rename-unstage");
		const app = join(root, "app");
		const outside = join(root, "outside");
		mkdirSync(app, { recursive: true });
		mkdirSync(outside, { recursive: true });

		const oldSame = join(app, "old.ssl");
		const newSame = join(app, "new.ssl");
		const oldOutside = join(outside, "moved.ssl");
		const newInside = join(app, "moved.ssl");
		const secretOutside = join(outside, "secret.env");

		writeFileSync(oldSame, ":RETURN 'same';\n");
		writeFileSync(oldOutside, ":RETURN 'moved';\n");
		writeFileSync(secretOutside, "SECRET=1\n");
		runGit("add", "-A");
		runGit("commit", "-m", "initial");

		// 1. Same-directory staged rename: unstage([newSame]) must unstage BOTH old and new.
		renameSync(oldSame, newSame);
		runGit("add", "-A");
		const git = new Git(app);
		try {
			expect((await git.status())!.files.find((f) => f.path === newSame)).toMatchObject({ staged: "renamed", from: oldSame });
			await git.unstage([newSame]);
			const afterUnstage = (await git.status())!;
			expect(afterUnstage.files.filter((f) => f.staged)).toEqual([]);
			expect(existsSync(newSame)).toBe(true);
		} finally {
			git.dispose();
		}

		// 2. Cross-subdir staged rename (outside/moved.ssl -> app/moved.ssl) through BackendApi.
		renameSync(oldOutside, newInside);
		runGit("add", "-A", "--", "outside/moved.ssl", "app/moved.ssl");
		const backend = createBackend(makeHost(), app);
		await backend.ready;
		try {
			const status = (await backend.api.gitStatus())!;
			const renamed = status.files.find((f) => f.path === newInside)!;
			expect(renamed.staged).toBe("renamed");
			expect(renamed.from).toBe(oldOutside);

			// gitBase allows reading the staged rename's `from` path inside the repo...
			expect(await backend.api.gitBase(oldOutside, "head")).toBe(":RETURN 'moved';\n");
			// ...but STILL rejects unrelated files outside the workspace!
			await expect(backend.api.gitBase(secretOutside, "head")).rejects.toThrow(/outside/i);
			await expect(backend.api.gitUnstage([secretOutside])).rejects.toThrow(/outside/i);

			// gitUnstage accepts `[newInside, oldOutside]` and unstages both sides cleanly.
			await backend.api.gitUnstage([newInside, oldOutside]);
			const afterBoth = (await backend.api.gitStatus())!;
			expect(afterBoth.files.filter((f) => f.staged)).toEqual([]);
			expect(afterBoth.stagedOutside).toBeUndefined();

			// Re-stage and verify passing ONLY `[newInside]` also auto-unstages `outside/moved.ssl`.
			runGit("add", "-A", "--", "outside/moved.ssl", "app/moved.ssl");
			await backend.api.gitUnstage([newInside]);
			const afterAuto = (await backend.api.gitStatus())!;
			expect(afterAuto.files.filter((f) => f.staged)).toEqual([]);
			expect(afterAuto.stagedOutside).toBeUndefined();
		} finally {
			backend.dispose();
		}
	});

	test("checkout handles folder/branch name collision ('docs') and extended branch names ('fix/issue#42', 'dev@lab/café')", async () => {
		const { root, runGit } = initRepo("git-checkout");
		mkdirSync(join(root, "docs"), { recursive: true });
		writeFileSync(join(root, "docs", "readme.md"), "# Docs\n");
		runGit("add", "-A");
		runGit("commit", "-m", "init");

		runGit("branch", "docs");
		runGit("branch", "fix/issue#42");
		runGit("branch", "dev@lab/café");

		const git = new Git(root);
		try {
			expect((await git.checkout("docs")).ok).toBe(true);
			expect((await git.branches())!.current).toBe("docs");

			expect((await git.checkout("fix/issue#42")).ok).toBe(true);
			expect((await git.branches())!.current).toBe("fix/issue#42");

			expect((await git.checkout("dev@lab/café")).ok).toBe(true);
			expect((await git.branches())!.current).toBe("dev@lab/café");

			// Invalid / injection names still rejected.
			for (const bad of ["--detach", "-b", "a..b", "@", "a@{0}", "bad.lock", "bad\x07"]) {
				expect((await git.checkout(bad)).ok).toBe(false);
			}
		} finally {
			git.dispose();
		}
	});

	test("commitFile follows renames for before/after diffs and blameLine returns historical filename", async () => {
		const { root, runGit } = initRepo("git-commitfile-blame");
		const oldFile = join(root, "LegacyRule.ssl");
		const newFile = join(root, "TurnaroundRule.ssl");
		const original = ":PROCEDURE Calc;\n:LOCAL nDays := 3;\n:LOCAL nPad := 1;\n:RETURN nDays + nPad;\n:ENDPROC;\n";
		const updated = ":PROCEDURE Calc;\n:LOCAL nDays := 3;\n:LOCAL nPad := 1;\n:RETURN nDays + nPad + 2;\n:ENDPROC;\n";

		writeFileSync(oldFile, original);
		runGit("add", "-A");
		runGit("commit", "-m", "LIMS-10: Add LegacyRule");

		renameSync(oldFile, newFile);
		writeFileSync(newFile, updated);
		runGit("add", "-A");
		runGit("commit", "-m", "LIMS-11: Rename LegacyRule to TurnaroundRule");
		const renameSha = runGit("rev-parse", "HEAD").trim();

		const git = new Git(root);
		try {
			const diff = await git.commitFile(newFile, renameSha);
			expect(diff.before).toBe(original);
			expect(diff.after).toBe(updated);

			// Line 1 originated in LegacyRule.ssl before the rename; blameLine returns filename.
			const blame1 = await git.blameLine(newFile, 1);
			expect(blame1?.filename).toBe("LegacyRule.ssl");
			expect(blame1?.ticket).toBe("LIMS-10");

			// Line 4 was modified in TurnaroundRule.ssl.
			const blame4 = await git.blameLine(newFile, 4);
			expect(blame4?.filename).toBe("TurnaroundRule.ssl");
			expect(blame4?.ticket).toBe("LIMS-11");
		} finally {
			git.dispose();
		}
	});

	test("diff() scopes to subdirectory workspace and enforces binary UTF-32 detection and stdout byte cap", async () => {
		const { root, runGit } = initRepo("git-diff-scope");
		const app = join(root, "app");
		mkdirSync(app, { recursive: true });
		const insideFile = join(app, "inside.ssl");
		const outsideFile = join(root, "outside.md");
		const utf32File = join(app, "utf32.bin");

		writeFileSync(insideFile, "inside-v1\n");
		writeFileSync(outsideFile, "outside-v1\n");
		writeFileSync(utf32File, Buffer.from([0xff, 0xfe, 0x00, 0x00, 0x41, 0x00, 0x00, 0x00]));
		runGit("add", "-A");
		runGit("commit", "-m", "init");

		writeFileSync(insideFile, "inside-v2\n");
		writeFileSync(outsideFile, "outside-v2\n");

		const git = new Git(app);
		try {
			const workDiff = await git.diff();
			expect(workDiff).toContain("inside-v2");
			expect(workDiff).not.toContain("outside-v2");

			// Staged diff is also scoped to `.`.
			runGit("add", "-A");
			const stagedDiff = await git.diff({ staged: true });
			expect(stagedDiff).toContain("inside-v2");
			expect(stagedDiff).not.toContain("outside-v2");

			// UTF-32 LE BOM file is treated as binary by `./encoding`'s looksBinary.
			expect(await git.base(utf32File, "head")).toBeNull();
			const head = (await git.headSha())!;
			expect(await git.show(utf32File, head)).toBeNull();
		} finally {
			git.dispose();
		}

		// Stdout cap prevents giant blobs from OOMing Bun.
		const bigFile = join(app, "big.txt");
		writeFileSync(bigFile, "A".repeat(20_000));
		runGit("add", "-A");
		runGit("commit", "-m", "add big");
		const cappedGit = new Git(app, 30_000, 4096);
		try {
			expect(await cappedGit.base(bigFile, "head")).toBeNull();
		} finally {
			cappedGit.dispose();
		}

		// Backend gitDiff rejects paths outside the workspace.
		const backend = createBackend(makeHost(), app);
		await backend.ready;
		try {
			await expect(backend.api.gitDiff({ paths: [outsideFile] })).rejects.toThrow(/outside/i);
		} finally {
			backend.dispose();
		}
	});

	test.skipIf(process.platform === "win32")("Git.spawn() enforces timeouts and kills hung child processes", async () => {
		const { root, runGit } = initRepo("git-timeout");
		const slowFile = join(root, "data.slow");
		writeFileSync(slowFile, "v1\n");
		writeFileSync(join(root, ".gitattributes"), "*.slow diff=slow\n");
		const sleeper = join(root, "sleep-filter.sh");
		writeFileSync(sleeper, "#!/bin/sh\nsleep 15\ncat \"$1\"\n");
		chmodSync(sleeper, 0o755);
		runGit("add", "-A");
		runGit("commit", "-m", "init slow");
		runGit("config", "diff.slow.textconv", sleeper);
		writeFileSync(slowFile, "v2\n");

		const git = new Git(root, 200);
		try {
			const t0 = Date.now();
			await expect(git.diff()).rejects.toThrow(/timed out/i);
			expect(Date.now() - t0).toBeLessThan(3000);

			// Subsequent non-hung commands still succeed after a timeout (queue is not jammed).
			expect(await git.headSha()).toMatch(/^[0-9a-f]{40}$/);
		} finally {
			git.dispose();
		}
	});
});
