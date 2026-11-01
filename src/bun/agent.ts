// The opencode adapter (ADR 0004): a private `opencode serve --stdio` the IDE
// starts, or a server it attaches to, driven through its HTTP API and SSE.
// The rest of the IDE sees only `call(method, args)` and "agent" events.
//
// Every session sets its model and starts with deny rules (shell, web,
// outside the workspace, questions). Prompts carry the code; replies come
// back as text the UI turns into reviewed edits (ADR 0002). The service
// password is generated here, held in memory and never logged or stored.
import { randomBytes } from "node:crypto";
import type { Subprocess } from "bun";
import type { AgentModel, AgentReply, AgentStatus } from "../shared/protocol";
import { compareVersions, OPENCODE_RANGE } from "./tools";

const DENY = ["shell", "webfetch", "websearch", "external_directory", "question"];
/** Providers that run on the user's own machines. Anything else may bill. */
const LOCAL_PROVIDERS = new Set(["ollama", "lmstudio", "llama.cpp", "llamacpp", "local"]);
const TURN_TIMEOUT_MS = 15 * 60_000;
/**
 * Code-mode helpers that opencode 2.2.5 runs without any permission check, so
 * no rule can deny them (they do not call the permission service, which is
 * also where config policies apply). The adapter interrupts a turn whose code
 * names one, before or while it runs: best effort, not a sandbox.
 */
export const UNGUARDED_TOOLS = ["worktree_create", "session_move"];
const UNGUARDED = new RegExp(`\\b(${UNGUARDED_TOOLS.join("|")})\\b`);

type Options = { serverConfig?: string; serverUrl?: string; model?: string };
type Waiter = { resolve: (outcome: AgentReply["outcome"]) => void; blocked?: string };

export class Agent {
	private proc?: Subprocess<"pipe", "pipe", "pipe">;
	private base = "";
	private auth = "";
	private status: AgentStatus = { state: "off" };
	private starting?: Promise<void>;
	private sessions = new Set<string>();
	private waiters = new Map<string, Waiter>();
	private events?: AbortController;
	private options: Options = {};

	constructor(
		readonly emit: (type: string, data: unknown) => void,
		readonly root: () => string | null,
		/** For tests: the opencode command. */
		private command = ["opencode", "serve", "--stdio", "--port", "0"],
	) {}

	configure(options: Options) {
		const changed = options.serverConfig !== this.options.serverConfig || options.serverUrl !== this.options.serverUrl;
		this.options = options;
		if (changed && this.status.state !== "off") this.stop();
	}

	async workspaceChanged() {
		for (const id of this.sessions) void this.api("DELETE", `/api/session/${id}`).catch(() => {});
		this.sessions.clear();
	}

	private setStatus(status: AgentStatus) {
		this.status = status;
		this.emit("status", status);
	}

	async call(method: string, args: unknown[]): Promise<unknown> {
		switch (method) {
			case "status":
				return this.status;
			case "start":
				await this.ensure();
				return this.status;
			case "stop":
				this.stop();
				return this.status;
			case "models":
				return this.models();
			case "skills":
				return this.skills();
			case "ask":
				return this.ask(args[0] as AskInput);
			case "interrupt":
				return this.api("POST", `/api/session/${args[0]}/interrupt`);
			default:
				throw new Error(`unknown agent call: ${method}`);
		}
	}

	private async ensure() {
		if (this.status.state === "ready") return;
		if (this.status.state === "failed" && !this.starting) this.stop();
		this.starting ??= this.start().finally(() => (this.starting = undefined));
		return this.starting;
	}

	private async start() {
		this.setStatus({ state: "starting" });
		try {
			if (this.options.serverUrl) {
				this.base = this.options.serverUrl.replace(/\/$/, "");
				this.auth = `Basic ${btoa(`opencode:${process.env.OPENCODE_SERVER_PASSWORD ?? ""}`)}`;
			} else {
				const password = randomBytes(24).toString("base64url");
				const env: Record<string, string> = { ...(process.env as Record<string, string>), OPENCODE_PASSWORD: password };
				if (this.options.serverConfig) env.OPENCODE_CONFIG_CONTENT = this.options.serverConfig;
				const proc = Bun.spawn(this.command, { env, stdin: "pipe", stdout: "pipe", stderr: "pipe", cwd: this.root() ?? undefined });
				this.proc = proc;
				this.base = (await firstUrl(proc)).replace(/\/$/, "");
				this.auth = `Basic ${btoa(`opencode:${password}`)}`;
				proc.exited.then(() => {
					if (this.proc === proc) this.setStatus({ state: "failed", message: "opencode stopped." });
				});
			}
			const info = await this.api("GET", "/api/info");
			const version: string = info?.data?.version ?? info?.version;
			if (!version || compareVersions(version, OPENCODE_RANGE.min) < 0 || compareVersions(version, OPENCODE_RANGE.below) >= 0)
				throw new Error(`opencode ${version ?? "(unknown version)"} is outside the supported range ${OPENCODE_RANGE.min} to below ${OPENCODE_RANGE.below}.`);
			this.subscribe();
			this.setStatus({ state: "ready", version });
		} catch (e: any) {
			this.stop();
			this.setStatus({ state: "failed", message: String(e?.message ?? e) });
			throw e;
		}
	}

	stop() {
		this.events?.abort();
		this.events = undefined;
		for (const waiter of this.waiters.values()) waiter.resolve("interrupted");
		this.waiters.clear();
		this.sessions.clear();
		if (this.proc) {
			// Closing stdin stops a `serve --stdio` server.
			this.proc.stdin.end();
			const proc = this.proc;
			setTimeout(() => proc.kill(), 3000);
			this.proc = undefined;
		}
		if (this.status.state !== "failed") this.setStatus({ state: "off" });
	}

	dispose() {
		this.stop();
	}

	private async api(method: string, path: string, body?: unknown): Promise<any> {
		const response = await fetch(this.base + path, {
			method,
			headers: { Authorization: this.auth, ...(body ? { "content-type": "application/json" } : {}) },
			body: body ? JSON.stringify(body) : undefined,
		});
		const text = await response.text();
		if (!response.ok) throw new Error(`opencode ${method} ${path.split("?")[0]}: ${response.status} ${text.slice(0, 300)}`);
		return text ? JSON.parse(text) : null;
	}

	/**
	 * One SSE connection; events for the IDE's own sessions go to the UI. The
	 * stream does not replay (M0), so a reconnect cannot recover a turn in
	 * flight: those turns fail, and the stream comes back for the next ones.
	 */
	private subscribe(attempt = 0) {
		const controller = new AbortController();
		this.events = controller;
		(async () => {
			try {
				const response = await fetch(`${this.base}/api/event`, { headers: { Authorization: this.auth }, signal: controller.signal });
				const decoder = new TextDecoder();
				let buffer = "";
				for await (const chunk of response.body!) {
					attempt = 0; // A live stream resets the retry count.
					buffer += decoder.decode(chunk, { stream: true });
					let cut: number;
					while ((cut = buffer.indexOf("\n\n")) >= 0) {
						const block = buffer.slice(0, cut);
						buffer = buffer.slice(cut + 2);
						const line = block.split("\n").find((l) => l.startsWith("data: "));
						if (line) this.dispatch(JSON.parse(line.slice(6)));
					}
				}
			} catch {
				// Aborted or dropped; a dropped stream fails the waiting turns below.
			}
			if (!controller.signal.aborted) {
				for (const waiter of this.waiters.values()) waiter.resolve("failed");
				this.waiters.clear();
				const alive = this.options.serverUrl || (this.proc && this.proc.exitCode === null);
				if (alive && attempt < 3) setTimeout(() => this.events === controller && this.subscribe(attempt + 1), 1000);
				else this.setStatus({ state: "failed", message: "Lost opencode's event stream." });
			}
		})();
	}

	private dispatch(event: { type: string; data?: any }) {
		const sessionID = event.data?.sessionID ?? event.data?.form?.sessionID;
		if (!sessionID || !this.sessions.has(sessionID)) return;
		this.emit(event.type, event.data);
		this.guard(sessionID, event);
		const end = /^session\.execution\.(succeeded|failed|interrupted)$/.exec(event.type);
		if (end) {
			this.waiters.get(sessionID)?.resolve(end[1] as AgentReply["outcome"]);
			this.waiters.delete(sessionID);
		}
		// A form would hold the turn forever (M0); `question` is denied, so cancel any other.
		if (event.type === "form.created") void this.api("DELETE", `/api/session/${sessionID}/form/${event.data.form.id}`).catch(() => {});
	}

	/** Stops a turn that reaches for a tool no permission rule can deny (UNGUARDED_TOOLS). */
	private guard(sessionID: string, event: { type: string; data?: any }) {
		let hit: string | undefined;
		if (event.type === "session.tool.called") hit = UNGUARDED.exec(JSON.stringify(event.data?.input ?? ""))?.[1];
		if (event.type === "session.tool.progress") hit = (event.data?.metadata?.toolCalls ?? []).map((c: any) => String(c.tool)).find((t: string) => UNGUARDED.test(t));
		if (event.type === "session.moved") hit = "session_move";
		if (!hit) return;
		const waiter = this.waiters.get(sessionID);
		if (waiter && !waiter.blocked) waiter.blocked = hit;
		this.emit("guard", { sessionID, tool: hit });
		void this.api("POST", `/api/session/${sessionID}/interrupt`).catch(() => {});
	}

	async models(): Promise<AgentModel[]> {
		await this.ensure();
		const list = ((await this.api("GET", "/api/model"))?.data ?? []) as any[];
		return list
			.map((m) => ({
				providerID: m.providerID,
				id: m.modelID ?? m.id,
				name: m.name ?? m.modelID ?? m.id,
				local: LOCAL_PROVIDERS.has(String(m.providerID).toLowerCase()),
				tools: Boolean(m.capabilities?.tools),
				variants: (m.variants ?? []).map((v: any) => v.id),
			}))
			.sort((a, b) => Number(b.local) - Number(a.local) || a.providerID.localeCompare(b.providerID) || a.name.localeCompare(b.name));
	}

	async skills(): Promise<{ id: string; name: string; description?: string }[]> {
		await this.ensure();
		const list = ((await this.api("GET", "/api/skill"))?.data ?? []) as any[];
		return list.map((s) => ({ id: s.id, name: s.name ?? s.id, description: s.description }));
	}

	/** The model for new sessions: the chosen one, else the first local one. Never a paid default. */
	private async model(): Promise<{ providerID: string; id: string }> {
		if (this.options.model) {
			const [providerID, ...rest] = this.options.model.split("/");
			return { providerID: providerID!, id: rest.join("/") };
		}
		const local = (await this.models()).find((m) => m.local && m.tools);
		if (!local) throw new Error("No local model found. Choose a model in the Agent panel (a paid provider asks first).");
		return { providerID: local.providerID, id: local.id };
	}

	/** A fresh session, one prompt, the whole reply. */
	async ask(input: AskInput): Promise<AgentReply> {
		await this.ensure();
		const root = this.root();
		if (!root) throw new Error("Open a folder first.");
		let sessionID = input.sessionID && this.sessions.has(input.sessionID) ? input.sessionID : "";
		if (!sessionID) {
			const model = await this.model();
			this.setStatus({ ...this.status, model: `${model.providerID}/${model.id}` });
			const created = await this.api("POST", "/api/session", {
				title: input.title ?? "SSL Studio",
				location: { directory: root },
				model,
				permissions: DENY.map((action) => ({ action, resource: "*", effect: "deny" })),
			});
			sessionID = created.data.id;
			this.sessions.add(sessionID);
			this.emit("session", { sessionID, title: input.title, model });
		}
		const seen = ((await this.api("GET", `/api/session/${sessionID}/message?limit=200&order=asc`))?.data ?? []).length;
		const waiter: Waiter = { resolve: () => {} };
		const done = new Promise<AgentReply["outcome"]>((resolve) => {
			waiter.resolve = resolve;
			this.waiters.set(sessionID, waiter);
			setTimeout(() => resolve("timeout"), input.timeoutMs ?? TURN_TIMEOUT_MS);
		});
		await this.api("POST", `/api/session/${sessionID}/prompt`, { text: input.text, ...(input.skills?.length ? { skills: input.skills.map((id) => ({ id })) } : {}) });
		const outcome = await done;
		if (outcome === "timeout") await this.api("POST", `/api/session/${sessionID}/interrupt`).catch(() => {});
		const messages = ((await this.api("GET", `/api/session/${sessionID}/message?limit=200&order=asc`))?.data ?? []) as any[];
		const assistant = messages.slice(seen).filter((m) => m.type === "assistant");
		const text = assistant.flatMap((m) => (m.content ?? []).filter((p: any) => p.type === "text").map((p: any) => p.text)).join("\n");
		const tokens = assistant.reduce((t, m) => ({ input: t.input + (m.tokens?.input ?? 0), output: t.output + (m.tokens?.output ?? 0) }), { input: 0, output: 0 });
		const cost = assistant.reduce((c, m) => c + (m.cost ?? 0), 0);
		const error = waiter.blocked
			? { message: `Stopped: the agent tried ${waiter.blocked}, which opencode runs without a permission check.` }
			: assistant.map((m) => m.error).find(Boolean);
		if (!input.keep) {
			this.sessions.delete(sessionID);
			void this.api("DELETE", `/api/session/${sessionID}`).catch(() => {});
		}
		return { sessionID, text: waiter.blocked ? "" : text, outcome: waiter.blocked ? "interrupted" : outcome, tokens, cost, error: error ? String(error.message ?? JSON.stringify(error)) : undefined };
	}
}

/** `sessionID` continues a kept session; otherwise each ask is a fresh one. */
export type AskInput = { text: string; title?: string; skills?: string[]; keep?: boolean; sessionID?: string; timeoutMs?: number };

/** `serve --stdio` prints `{"url": ...}` as its first line. */
async function firstUrl(proc: Subprocess<"pipe", "pipe", "pipe">): Promise<string> {
	const reader = proc.stdout.getReader();
	const decoder = new TextDecoder();
	let text = "";
	const deadline = Date.now() + 30_000;
	while (!text.includes("\n")) {
		if (Date.now() > deadline) throw new Error("opencode did not start within 30 s.");
		const { value, done } = await reader.read();
		if (done) throw new Error(`opencode exited before it was ready. ${await new Response(proc.stderr).text().catch(() => "")}`.trim());
		text += decoder.decode(value);
	}
	reader.releaseLock();
	// Keep draining stdout so the pipe never fills.
	(async () => {
		for await (const _ of proc.stdout) {
		}
	})();
	return JSON.parse(text.split("\n")[0]!).url;
}
