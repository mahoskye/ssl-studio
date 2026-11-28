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
import { mergeMcpIntoOpencodeConfig, type McpServerEntry } from "../shared/agentCustomizations";
import { compareVersions, OPENCODE_RANGE, opencodeCommand, verbatim } from "./tools";
import { isLocalModelRef, LOCAL_PROVIDERS, parseModelRef } from "../shared/agentModels";

/**
 * opencode 2.2.5 gave a model no tools of its own, only code mode; 2.3 gives
 * it `read`, `glob`, `grep`, `subagent` and `skill`. The IDE puts what a turn
 * needs in its prompt and says so there (ADR 0004). Tried on 2.3.2 with a
 * local model: left the file tools, it searched the folder for what it had
 * already been sent and filled its context; left only `skill`, it loaded a
 * skill that had nothing to do with the question. Denied, 2.3 falls back to
 * the code mode of 2.2.5 and a turn is what its prompt says it is. A skill
 * attached to a prompt still arrives: that is not the `skill` tool.
 */
const NO_TOOLS_OF_ITS_OWN = ["read", "glob", "grep", "subagent", "skill"];

/**
 * What every session is denied. From `browser` on, added for opencode 2.3:
 * its image tool calls a connected provider's image model, which may bill and
 * writes a file; its MCP resource tools read from whatever servers the user
 * has connected, which is outside the workspace; `browser` is the web by
 * another name. A rule for an action a server does not have denies nothing.
 */
const MCP_RESOURCE_TOOLS = new Set(["opencode_list_mcp_resources", "opencode_read_mcp_resource", "opencode_watch_mcp_event"]);
const DENY = ["shell", "webfetch", "websearch", "external_directory", "question", "edit", "browser", "experimental_image_generate", "opencode_list_mcp_resources", "opencode_read_mcp_resource", "opencode_watch_mcp_event", ...NO_TOOLS_OF_ITS_OWN];
/** Providers that run on the user's own machines. Anything else may bill. */
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]", "::1"]);
const TURN_TIMEOUT_MS = 15 * 60_000;
const API_TIMEOUT_MS = 60_000;
const PROMPT_TIMEOUT_MS = 5 * 60_000;
const FIRST_URL_TIMEOUT_MS = 30_000;
const SSE_READY_TIMEOUT_MS = 5_000;
const STDERR_TAIL_BYTES = 8 * 1024;
const MAX_SSE_BUFFER_CHARS = 8 * 1024 * 1024;
const MAX_SEEN_MESSAGES = 10_000;
const SKILLS_WAIT_MS = 5_000;
const SKILLS_STEADY_MS = 2_000;
/**
 * Code-mode helpers that opencode 2.2.5 runs without any permission check, so
 * no rule can deny them (they do not call the permission service, which is
 * also where config policies apply). The adapter interrupts a turn whose code
 * names one, before or while it runs: best effort, not a sandbox.
 */
export const UNGUARDED_TOOLS = ["worktree_create", "session_move"];
const UNGUARDED = new RegExp(`\\b(${UNGUARDED_TOOLS.join("|")})\\b`);

export type AgentOptions = {
	serverConfig?: string;
	serverUrl?: string;
	model?: string;
	ownModels?: string[];
	/** Explicitly user-confirmed model refs (e.g. from user settings) permitted even when non-local. */
	confirmedModels?: string[];
	/** Explicitly permits the configured non-local model for this adapter instance. */
	allowPaidModel?: boolean;
	/** Trusted/configured MCP servers discovered by CustomizationsStore (only trusted & enabled servers are passed to opencode). */
	mcpServers?: McpServerEntry[];
	/** For tests: overrides startup URL wait timeout (default 30 s). */
	startupTimeoutMs?: number;
	/** For tests: overrides per-request API timeout (default 60 s). */
	apiTimeoutMs?: number;
	/** For tests: overrides SSE reconnect delay (default 1000 ms). */
	reconnectDelayMs?: number;
};

type Waiter = {
	resolve: (outcome: AgentReply["outcome"]) => void;
	blocked?: string;
	tools: number;
	toolLimit?: number;
	overLimit?: boolean;
	/** Why the turn failed, when opencode says so on the event and not on a message. */
	failure?: string;
	/** The session's messages as they were before the turn's prompt was sent: what is new after them is the turn's. */
	before?: { seen: ReadonlySet<string>; count: number };
};

/**
 * Validates an opencode server URL before sending credentials or requests.
 * Rejects userinfo, query strings, and fragments; requires `http:`/`https:` on loopback
 * (`127.0.0.1`, `localhost`, `[::1]`) or `https:` for remote hosts. When `requireLoopback`
 * is true (used for child stdout `firstUrl`), non-loopback hosts are always rejected.
 */
export function validateAgentServerUrl(rawUrl: string, requireLoopback = false): string {
	if (typeof rawUrl !== "string" || !rawUrl.trim()) {
		throw new Error("Agent server URL is empty.");
	}
	const trimmed = rawUrl.trim();
	if (trimmed.includes("?") || trimmed.includes("#")) {
		throw new Error("Agent server URL must not contain query parameters or fragments.");
	}
	if (/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\/[^/]*@/.test(trimmed)) {
		throw new Error("Agent server URL must not contain credentials.");
	}
	let url: URL;
	try {
		url = new URL(trimmed);
	} catch {
		throw new Error(`Invalid agent server URL: ${trimmed.slice(0, 120)}`);
	}
	if (url.protocol !== "http:" && url.protocol !== "https:") {
		throw new Error(`Unsupported agent server URL protocol: ${url.protocol}`);
	}
	if (url.username || url.password) {
		throw new Error("Agent server URL must not contain credentials.");
	}
	if (url.search || url.hash) {
		throw new Error("Agent server URL must not contain query parameters or fragments.");
	}
	const host = url.hostname.toLowerCase();
	const isLoopback = LOOPBACK_HOSTS.has(host);
	if (requireLoopback && !isLoopback) {
		throw new Error(`Agent server URL must use a loopback address (127.0.0.1, localhost, or [::1]); got ${url.hostname}.`);
	}
	if (!isLoopback && url.protocol !== "https:") {
		throw new Error("Remote agent server URL must use https: (http: is only permitted on loopback).");
	}
	const path = url.pathname === "/" ? "" : url.pathname.replace(/\/+$/, "");
	return `${url.origin}${path}`;
}

// Which models are local is the view's to know too: the rule is in src/shared/agentModels.ts.
export { isLocalModelRef, parseModelRef };

/**
 * The reason on a failed turn's event, in words. opencode puts it in different
 * places for different failures (a model that is not there, a provider that
 * does not answer); only short text is taken, never a whole object, which may
 * hold a provider's settings.
 */
export function failureText(data: any): string | undefined {
	for (const value of [data?.error?.message, data?.error?.data?.message, data?.error?.name, data?.error, data?.message, data?.reason]) {
		if (typeof value !== "string" || !value.trim()) continue;
		const text = value.trim().replace(/:$/, "").slice(0, 400);
		const hint = HINTS[String(data?.error?.type)];
		return hint ? `${text}. ${hint}` : text;
	}
	return undefined;
}

const NO_REASON = "opencode gave no reason. The model may not be installed, or its provider may not be reachable: choose another model.";

/** What to do about a failure opencode names by type, where its own words do not say. */
const HINTS: Record<string, string> = {
	"provider.no-route": "opencode cannot reach this model's provider: check the provider's entry in opencode's configuration (its package and address), or choose another model.",
};

function basicAuth(password: string): string {
	return `Basic ${Buffer.from(`opencode:${password}`, "utf8").toString("base64")}`;
}

function isProcAlive(proc: Subprocess<"pipe", "pipe", "pipe"> | undefined): boolean {
	return Boolean(proc && proc.exitCode === null && proc.signalCode === null && !proc.killed);
}

function killQuietly(proc: Subprocess<"pipe", "pipe", "pipe"> | undefined) {
	if (!proc) return;
	try {
		proc.stdin.end();
	} catch {
		// Already closed.
	}
	if (!isProcAlive(proc)) return;
	try {
		proc.kill();
	} catch {
		// Already exited.
	}
}

/** Continuously drains child stderr into a bounded tail buffer so the pipe never fills and deadlocks opencode. */
function drainStderr(proc: Subprocess<"pipe", "pipe", "pipe">): { tail: () => string; done: Promise<void> } {
	const decoder = new TextDecoder();
	let buf = "";
	const done = (async () => {
		try {
			for await (const chunk of proc.stderr) {
				buf += decoder.decode(chunk, { stream: true });
				if (buf.length > STDERR_TAIL_BYTES) buf = buf.slice(buf.length - STDERR_TAIL_BYTES);
			}
			buf += decoder.decode();
			if (buf.length > STDERR_TAIL_BYTES) buf = buf.slice(buf.length - STDERR_TAIL_BYTES);
		} catch {
			// Stream closed or process killed.
		}
	})();
	return { tail: () => buf, done };
}

/**
 * Extracts newly added messages from a post-turn `/message?limit=50&order=desc` response in chronological order,
 * avoiding the 200-message cliff on long sessions while remaining compatible with servers that omit message IDs.
 */
function extractNewMessages(afterMessages: any[], seenIds: ReadonlySet<string>, beforeCount: number): any[] {
	if (!afterMessages.length) return [];
	const hasIds = afterMessages.some((m) => typeof m?.id === "string" && m.id.length > 0);
	if (!hasIds) {
		return afterMessages.length >= beforeCount ? afterMessages.slice(beforeCount) : afterMessages;
	}
	const unseen = afterMessages.filter((m) => typeof m?.id === "string" && m.id.length > 0 && !seenIds.has(m.id));
	if (unseen.length <= 1) return unseen;

	let isDesc: boolean | null = null;
	const firstSeenIdx = afterMessages.findIndex((m) => typeof m?.id === "string" && seenIds.has(m.id));
	const firstUnseenIdx = afterMessages.findIndex((m) => typeof m?.id === "string" && !seenIds.has(m.id));
	if (firstSeenIdx >= 0 && firstUnseenIdx >= 0) {
		isDesc = firstUnseenIdx < firstSeenIdx;
	}
	if (isDesc === null) {
		const firstUser = unseen.findIndex((m) => m?.type === "user");
		const firstAssistant = unseen.findIndex((m) => m?.type === "assistant");
		const firstIdle = unseen.findIndex((m) => m?.type === "idle");
		if (firstUser >= 0 && firstAssistant >= 0) isDesc = firstAssistant < firstUser;
		else if (firstIdle >= 0 && firstAssistant >= 0) isDesc = firstIdle < firstAssistant;
	}
	if (isDesc === null) {
		const t0 = Number(unseen[0]?.created ?? unseen[0]?.createdAt ?? unseen[0]?.time);
		const tLast = Number(unseen.at(-1)?.created ?? unseen.at(-1)?.createdAt ?? unseen.at(-1)?.time);
		if (Number.isFinite(t0) && Number.isFinite(tLast) && t0 !== tLast) {
			isDesc = t0 > tLast;
		}
	}
	return isDesc ? [...unseen].reverse() : unseen;
}

export class Agent {
	private proc?: Subprocess<"pipe", "pipe", "pipe">;
	private base = "";
	private auth = "";
	private status: AgentStatus = { state: "off" };
	private starting?: Promise<void>;
	private startEpoch = 0;
	private sessions = new Set<string>();
	private seenMessages = new Map<string, Set<string>>();
	private waiters = new Map<string, Waiter>();
	private events?: AbortController;
	private reqAbort?: AbortController;
	private options: AgentOptions = {};

	constructor(
		readonly emit: (type: string, data: unknown) => void,
		readonly root: () => string | null,
		/** For tests: the opencode command. */
		private command = [...opencodeCommand(), "serve", "--stdio", "--port", "0"],
	) {}

	configure(options: AgentOptions) {
		const prevConfig = mergeMcpIntoOpencodeConfig(this.options.serverConfig, this.options.mcpServers ?? []).configJson;
		const nextConfig = mergeMcpIntoOpencodeConfig(options.serverConfig, options.mcpServers ?? []).configJson;
		const changed = prevConfig !== nextConfig || options.serverUrl !== this.options.serverUrl;
		this.options = options;
		if (changed && this.status.state !== "off") this.stop();
	}

	async workspaceChanged() {
		// Resolve and clear all pending waiters BEFORE clearing sessions so in-flight turns never hang.
		for (const waiter of this.waiters.values()) waiter.resolve("interrupted");
		this.waiters.clear();
		const ids = [...this.sessions];
		this.sessions.clear();
		this.seenMessages.clear();
		for (const id of ids) {
			void this.api("DELETE", `/api/session/${encodeURIComponent(id)}`).catch(() => {});
		}
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
			case "interrupt": {
				const sessionID = args[0];
				if (typeof sessionID !== "string" || !this.sessions.has(sessionID)) {
					throw new Error("unknown agent session");
				}
				return this.api("POST", `/api/session/${encodeURIComponent(sessionID)}/interrupt`);
			}
			default:
				throw new Error(`unknown agent call: ${method}`);
		}
	}

	private async ensure() {
		if (this.status.state === "ready") return;
		if (this.status.state === "failed" && !this.starting) this.stop();
		const starting = (this.starting ??= this.start().finally(() => {
			if (this.starting === starting) this.starting = undefined;
		}));
		await starting;
		const after: AgentStatus = this.status;
		if (after.state !== "ready") {
			throw new Error(after.message || "opencode is not ready.");
		}
	}

	private async start() {
		const epoch = ++this.startEpoch;
		const stale = () => epoch !== this.startEpoch;
		const reqAbort = new AbortController();
		this.reqAbort = reqAbort;
		this.setStatus({ state: "starting" });
		let spawned: Subprocess<"pipe", "pipe", "pipe"> | undefined;
		try {
			if (this.options.serverUrl) {
				this.base = validateAgentServerUrl(this.options.serverUrl, false);
				this.auth = basicAuth(process.env.OPENCODE_SERVER_PASSWORD ?? "");
			} else {
				const password = randomBytes(24).toString("base64url");
				const env: Record<string, string> = { ...(process.env as Record<string, string>), OPENCODE_PASSWORD: password };
				const merged = mergeMcpIntoOpencodeConfig(this.options.serverConfig, this.options.mcpServers ?? []);
				if (merged.configJson) env.OPENCODE_CONFIG_CONTENT = merged.configJson;
				// The npm shim under a path with a space is a line written out for cmd.exe: Windows is given it as written.
				const proc = Bun.spawn(this.command, { env, stdin: "pipe", stdout: "pipe", stderr: "pipe", cwd: this.root() ?? undefined, windowsVerbatimArguments: verbatim(this.command) });
				spawned = proc;
				if (stale()) {
					killQuietly(proc);
					throw new Error("opencode start cancelled.");
				}
				this.proc = proc;
				const stderr = drainStderr(proc);
				this.base = await firstUrl(proc, this.options.startupTimeoutMs ?? FIRST_URL_TIMEOUT_MS, reqAbort.signal, stderr);
				if (stale()) {
					killQuietly(proc);
					throw new Error("opencode start cancelled.");
				}
				this.auth = basicAuth(password);
				proc.exited.then(() => {
					if (this.proc === proc && epoch === this.startEpoch) {
						this.proc = undefined;
						this.setStatus({ state: "failed", message: "opencode stopped." });
					}
				});
			}
			const info = await this.api("GET", "/api/info");
			if (stale()) {
				killQuietly(spawned);
				throw new Error("opencode start cancelled.");
			}
			const version: string = info?.data?.version ?? info?.version;
			if (!version || !(compareVersions(version, OPENCODE_RANGE.min) >= 0) || !(compareVersions(version, OPENCODE_RANGE.below) < 0)) {
				throw new Error(`opencode ${version ?? "(unknown version)"} is outside the supported range ${OPENCODE_RANGE.min} to below ${OPENCODE_RANGE.below}.`);
			}
			// Await initial SSE headers acceptance (with clean fallback on error or stall) before reporting ready.
			await Promise.race([this.subscribe(0, epoch), Bun.sleep(SSE_READY_TIMEOUT_MS)]);
			if (stale()) {
				killQuietly(spawned);
				throw new Error("opencode start cancelled.");
			}
			if (this.status.state === "starting") {
				this.setStatus({ state: "ready", version });
			}
		} catch (e: any) {
			if (stale()) {
				if (spawned && this.proc !== spawned) killQuietly(spawned);
				throw e;
			}
			this.stop();
			this.setStatus({ state: "failed", message: String(e?.message ?? e) });
			throw e;
		}
	}

	stop() {
		this.startEpoch++;
		this.starting = undefined;
		this.events?.abort();
		this.events = undefined;
		this.reqAbort?.abort();
		this.reqAbort = undefined;
		for (const waiter of this.waiters.values()) waiter.resolve("interrupted");
		this.waiters.clear();
		this.sessions.clear();
		this.seenMessages.clear();
		if (this.proc) {
			// Closing stdin stops a `serve --stdio` server.
			const proc = this.proc;
			this.proc = undefined;
			try {
				proc.stdin.end();
			} catch {
				// Already closed.
			}
			const timer = setTimeout(() => {
				try {
					proc.kill();
				} catch {
					// Already exited.
				}
			}, 3000);
			void proc.exited.finally(() => clearTimeout(timer));
		}
		if (this.status.state !== "failed") this.setStatus({ state: "off" });
	}

	dispose() {
		const proc = this.proc;
		this.proc = undefined;
		this.stop();
		if (!proc) return;
		try {
			proc.stdin.end();
		} catch {
			// Already closed.
		}
		if (!isProcAlive(proc)) return;
		if (process.platform === "win32" && this.command[0]?.toLowerCase() === "cmd.exe" && proc.pid) {
			try {
				Bun.spawnSync(["taskkill", "/T", "/F", "/PID", String(proc.pid)], { stdout: "ignore", stderr: "ignore" });
				return;
			} catch {
				// Fall through to direct kill.
			}
		}
		try {
			proc.kill();
		} catch {
			// Already exited.
		}
	}

	private async api(method: string, path: string, body?: unknown, timeoutMs = this.options.apiTimeoutMs ?? API_TIMEOUT_MS): Promise<any> {
		const controller = new AbortController();
		const parentSignal = this.reqAbort?.signal;
		let timedOut = false;
		const onParentAbort = () => controller.abort();
		if (parentSignal) {
			if (parentSignal.aborted) controller.abort();
			else parentSignal.addEventListener("abort", onParentAbort, { once: true });
		}
		const timer = setTimeout(() => {
			timedOut = true;
			controller.abort();
		}, timeoutMs);
		try {
			const response = await fetch(this.base + path, {
				method,
				headers: { Authorization: this.auth, ...(body !== undefined ? { "content-type": "application/json" } : {}) },
				body: body !== undefined ? JSON.stringify(body) : undefined,
				redirect: "error",
				signal: controller.signal,
			});
			const text = await response.text();
			if (!response.ok) throw new Error(`opencode ${method} ${path.split("?")[0]}: ${response.status} ${text.slice(0, 300)}`);
			return text ? JSON.parse(text) : null;
		} catch (e: any) {
			if (timedOut) {
				throw new Error(`opencode ${method} ${path.split("?")[0]} timed out after ${timeoutMs >= 1000 ? `${Math.round(timeoutMs / 1000)} s` : `${timeoutMs} ms`}.`);
			}
			throw e;
		} finally {
			clearTimeout(timer);
			if (parentSignal) parentSignal.removeEventListener("abort", onParentAbort);
		}
	}

	/**
	 * One SSE connection; events for the IDE's own sessions go to the UI. The
	 * stream does not replay (M0), so a reconnect cannot recover a turn in
	 * flight: those turns fail, and the stream comes back for the next ones.
	 * Resolves once response headers are accepted (or cleanly falls back on error).
	 */
	private subscribe(attempt = 0, epoch = this.startEpoch): Promise<void> {
		const controller = new AbortController();
		this.events = controller;
		let resolveReady!: () => void;
		const ready = new Promise<void>((r) => (resolveReady = r));
		let nonRetryable = false;

		(async () => {
			try {
				const response = await fetch(`${this.base}/api/event`, {
					headers: { Authorization: this.auth },
					redirect: "error",
					signal: controller.signal,
				});
				if (!response.ok || !response.body) {
					if (response.status === 401 || response.status === 403) nonRetryable = true;
					throw new Error(`opencode GET /api/event: ${response.status}`);
				}
				resolveReady();
				void this.catchUp(epoch);

				const decoder = new TextDecoder();
				let buffer = "";
				const drainFrames = () => {
					for (;;) {
						const match = /\r?\n\r?\n/.exec(buffer);
						if (!match) break;
						const block = buffer.slice(0, match.index);
						buffer = buffer.slice(match.index + match[0].length);
						const dataLines: string[] = [];
						for (const line of block.split(/\r?\n/)) {
							if (/^data:/.test(line)) {
								dataLines.push(line.replace(/^data:\s?/, ""));
							}
						}
						if (!dataLines.length) continue;
						const payload = dataLines.join("\n");
						try {
							const parsed = JSON.parse(payload);
							if (parsed && typeof parsed === "object" && typeof parsed.type === "string") {
								// Reset retries ONLY after receiving a valid SSE event frame.
								attempt = 0;
								this.dispatch(parsed);
							}
						} catch {
							// Ignore malformed SSE frame or dispatch failure without dropping the stream.
						}
					}
				};

				for await (const chunk of response.body) {
					buffer += decoder.decode(chunk, { stream: true });
					if (buffer.length > MAX_SSE_BUFFER_CHARS) {
						throw new Error("opencode event stream buffer exceeded limit.");
					}
					drainFrames();
				}
				buffer += decoder.decode();
				drainFrames();
			} catch {
				// Aborted, HTTP error, or dropped; resolved cleanly below.
				resolveReady();
			}

			if (!controller.signal.aborted && epoch === this.startEpoch) {
				for (const waiter of this.waiters.values()) {
					waiter.failure = "Lost opencode's event stream before the turn ended.";
					waiter.resolve("failed");
				}
				this.waiters.clear();
				const alive = Boolean(this.options.serverUrl) || isProcAlive(this.proc);
				if (!nonRetryable && alive && attempt < 3) {
					const delay = this.options.reconnectDelayMs ?? 1000;
					const timer = setTimeout(() => {
						if (this.events === controller && epoch === this.startEpoch) {
							void this.subscribe(attempt + 1, epoch);
						}
					}, delay);
					controller.signal.addEventListener("abort", () => clearTimeout(timer), { once: true });
				} else {
					this.setStatus({ state: "failed", message: "Lost opencode's event stream." });
				}
			}
		})();

		return ready;
	}

	/**
	 * What the turns that are waiting missed while there was no stream. The stream does not replay: a turn that
	 * was asked for while it was down, and ended before it was back, waited for an event that had been sent to
	 * no one, until its own time ran out (fifteen minutes). With the stream up again the server is asked: a
	 * session's messages end with an `idle` message, which has the outcome, once its turn is over. A turn that is
	 * still running has none, and its end comes over the stream.
	 */
	private async catchUp(epoch: number) {
		for (const [sessionID, waiter] of [...this.waiters]) {
			// Nothing was sent for it yet, so nothing can have ended.
			if (!waiter.before) continue;
			try {
				const messages = ((await this.api("GET", `/api/session/${encodeURIComponent(sessionID)}/message?limit=50&order=desc`))?.data ?? []) as any[];
				if (epoch !== this.startEpoch || this.waiters.get(sessionID) !== waiter) continue;
				const idle = extractNewMessages(messages, waiter.before.seen, waiter.before.count)
					.reverse()
					.find((m) => m?.type === "idle");
				const outcome = /^(succeeded|failed|interrupted)$/.exec(String(idle?.outcome))?.[1] as AgentReply["outcome"] | undefined;
				if (!outcome) continue;
				if (outcome === "failed") waiter.failure = failureText(idle);
				waiter.resolve(outcome);
				this.waiters.delete(sessionID);
			} catch {
				// The server did not answer: the turn goes on waiting, and a stream that drops again fails it.
			}
		}
	}

	private dispatch(event: { type: string; data?: any }) {
		const sessionID = event.data?.sessionID ?? event.data?.form?.sessionID;
		if (typeof sessionID !== "string" || !sessionID || !this.sessions.has(sessionID)) return;
		this.emit(event.type, event.data);
		this.guard(sessionID, event);
		const end = /^session\.execution\.(succeeded|failed|interrupted)$/.exec(event.type);
		if (end) {
			const waiting = this.waiters.get(sessionID);
			if (waiting && end[1] === "failed") waiting.failure = failureText(event.data);
			waiting?.resolve(end[1] as AgentReply["outcome"]);
			this.waiters.delete(sessionID);
		}
		// A form would hold the turn forever (M0); `question` is denied, so cancel any other.
		if (event.type === "form.created") {
			const formID = event.data?.form?.id;
			if (typeof formID === "string" && formID.length > 0) {
				void this.api("DELETE", `/api/session/${encodeURIComponent(sessionID)}/form/${encodeURIComponent(formID)}`).catch(() => {});
			}
		}
	}

	/** Stops a turn that reaches for a tool no permission rule can deny (UNGUARDED_TOOLS). */
	private guard(sessionID: string, event: { type: string; data?: any }) {
		let hit: string | undefined;
		if (event.type === "session.tool.called") hit = UNGUARDED.exec(JSON.stringify(event.data?.input ?? ""))?.[1];
		if (event.type === "session.tool.progress") {
			const toolCalls = event.data?.metadata?.toolCalls;
			if (Array.isArray(toolCalls)) {
				hit = toolCalls.map((c: any) => String(c?.tool ?? "")).find((t: string) => UNGUARDED.test(t));
			}
		}
		if (event.type === "session.moved") hit = "session_move";
		const waiter = this.waiters.get(sessionID);
		// A model with nothing useful to call can still loop on it, at the turn's expense.
		if (!hit && event.type === "session.tool.called" && waiter?.toolLimit !== undefined && ++waiter.tools > waiter.toolLimit && !waiter.overLimit) {
			waiter.overLimit = true;
			void this.api("POST", `/api/session/${encodeURIComponent(sessionID)}/interrupt`).catch(() => {});
		}
		if (!hit) return;
		if (waiter && !waiter.blocked) waiter.blocked = hit;
		this.emit("guard", { sessionID, tool: hit });
		void this.api("POST", `/api/session/${encodeURIComponent(sessionID)}/interrupt`).catch(() => {});
	}

	async models(): Promise<AgentModel[]> {
		await this.ensure();
		const list = ((await this.api("GET", "/api/model"))?.data ?? []) as any[];
		// Models the user says run on their own machines, whatever the provider (case-insensitive, trimmed).
		const own = new Set(
			(this.options.ownModels ?? [])
				.map((ref) => parseModelRef(ref)?.normalized)
				.filter((ref): ref is string => Boolean(ref)),
		);
		return list
			.map((m) => {
				const providerID = String(m?.providerID ?? "").trim();
				const id = String(m?.modelID ?? m?.id ?? "").trim();
				const normalized = providerID && id ? `${providerID.toLowerCase()}/${id.toLowerCase()}` : "";
				return {
					providerID,
					id,
					name: String(m?.name ?? m?.modelID ?? m?.id ?? "").trim() || id,
					local: LOCAL_PROVIDERS.has(providerID.toLowerCase()) || (Boolean(normalized) && own.has(normalized)),
					tools: Boolean(m?.capabilities?.tools),
					variants: Array.isArray(m?.variants) ? m.variants.map((v: any) => String(v?.id ?? "")).filter(Boolean) : [],
				};
			})
			.filter((m) => Boolean(m.providerID && m.id))
			.sort((a, b) => Number(b.local) - Number(a.local) || a.providerID.localeCompare(b.providerID) || a.name.localeCompare(b.name));
	}

	/**
	 * A server that has just started fills its skill list in stages (on 2.2.5:
	 * none, then the two built-ins, then all, within about 1.5 s), so the list
	 * counts once it stops growing, or holds the skills asked for.
	 */
	async skills(wanted: string[] = []): Promise<{ id: string; name: string; description?: string }[]> {
		await this.ensure();
		const end = Date.now() + SKILLS_WAIT_MS;
		let last = -1;
		let steadySince = Date.now();
		for (;;) {
			const list = ((await this.api("GET", "/api/skill"))?.data ?? []) as any[];
			if (list.length !== last) {
				last = list.length;
				steadySince = Date.now();
			}
			const found = wanted.length > 0 && wanted.every((id) => list.some((s) => s.id === id));
			// A list that has stopped growing will not get what it lacks.
			const settled = list.length > 0 && Date.now() - steadySince >= SKILLS_STEADY_MS;
			if (found || settled || Date.now() >= end) return list.map((s) => ({ id: s.id, name: s.name ?? s.id, description: s.description }));
			await Bun.sleep(100);
		}
	}

	/** The model for new sessions: the chosen one (verified local or user-confirmed), else the first local one. Never an unconfirmed paid model. */
	private async model(): Promise<{ providerID: string; id: string }> {
		if (this.options.model?.trim()) {
			const parsed = parseModelRef(this.options.model);
			if (!parsed) {
				throw new Error(`Invalid agent model "${this.options.model}". Expected "provider/model".`);
			}
			const confirmed = new Set(
				(this.options.confirmedModels ?? [])
					.map((ref) => parseModelRef(ref)?.normalized)
					.filter((ref): ref is string => Boolean(ref)),
			);
			const isLocal = isLocalModelRef(this.options.model, this.options.ownModels);
			const isConfirmed = this.options.allowPaidModel === true || confirmed.has(parsed.normalized);
			const catalog = await this.models().catch(() => null);
			const matched = catalog?.find((m) => `${m.providerID.toLowerCase()}/${m.id.toLowerCase()}` === parsed.normalized);
			if (!isLocal && !matched?.local && !isConfirmed) {
				throw new Error(`Model "${parsed.providerID}/${parsed.id}" is not a local model and has not been confirmed. Choose it in the Agent panel (or add it to agentOwnModels) first.`);
			}
			return matched ? { providerID: matched.providerID, id: matched.id } : { providerID: parsed.providerID, id: parsed.id };
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
		// A step without its skill would still answer, from nothing but the model's guesses.
		if (input.skills?.length) {
			const known = new Set((await this.skills(input.skills)).map((s) => s.id));
			const missing = input.skills.filter((id) => !known.has(id));
			if (missing.length) throw new Error(`opencode does not have the skill ${missing.join(", ")}. Install the style guide's skills on this machine (ssl-style-guide).`);
		}
		let sessionID = input.sessionID && this.sessions.has(input.sessionID) ? input.sessionID : "";
		if (sessionID && this.waiters.has(sessionID)) {
			throw new Error("A request is already in progress on this session.");
		}
		if (!sessionID) {
			const model = await this.model();
			this.setStatus({ ...this.status, model: `${model.providerID}/${model.id}` });
			const allowMcpTools = (this.options.mcpServers ?? []).some((s) => s.trusted && !s.disabled && s.allowTools);
			const sessionDeny = allowMcpTools ? DENY.filter((action) => !MCP_RESOURCE_TOOLS.has(action)) : DENY;
			const created = await this.api("POST", "/api/session", {
				title: input.title ?? "SSL Studio",
				location: { directory: root },
				model,
				permissions: sessionDeny.map((action) => ({ action, resource: "*", effect: "deny" })),
			});
			const createdID = created?.data?.id;
			if (typeof createdID !== "string" || !createdID.trim()) {
				throw new Error("opencode returned an invalid session ID.");
			}
			sessionID = createdID;
			this.sessions.add(sessionID);
			this.emit("session", { sessionID, title: input.title, model });
		}
		if (this.waiters.has(sessionID)) {
			throw new Error("A request is already in progress on this session.");
		}

		const encSession = encodeURIComponent(sessionID);
		let resolveDone!: (outcome: AgentReply["outcome"]) => void;
		let settled = false;
		const waiter: Waiter = {
			resolve: (outcome) => {
				if (settled) return;
				settled = true;
				resolveDone(outcome);
			},
			tools: 0,
			toolLimit: input.toolLimit,
		};
		const done = new Promise<AgentReply["outcome"]>((resolve) => {
			resolveDone = resolve;
		});
		this.waiters.set(sessionID, waiter);

		let turnTimer: ReturnType<typeof setTimeout> | undefined;
		try {
			const beforeMessages = ((await this.api("GET", `/api/session/${encSession}/message?limit=50&order=desc`))?.data ?? []) as any[];
			let seenIds = this.seenMessages.get(sessionID);
			if (!seenIds) {
				seenIds = new Set<string>();
				this.seenMessages.set(sessionID, seenIds);
			}
			for (const m of beforeMessages) {
				if (typeof m?.id === "string" && m.id) seenIds.add(m.id);
			}
			const beforeCount = beforeMessages.length;
			// A copy: the session's own set grows with the turn's messages once it is over.
			waiter.before = { seen: new Set(seenIds), count: beforeCount };

			const turnTimeout = input.timeoutMs ?? TURN_TIMEOUT_MS;
			turnTimer = setTimeout(() => waiter.resolve("timeout"), turnTimeout);

			await this.api(
				"POST",
				`/api/session/${encSession}/prompt`,
				{ text: input.text, ...(input.skills?.length ? { skills: input.skills.map((id) => ({ id })) } : {}) },
				Math.max(PROMPT_TIMEOUT_MS, turnTimeout),
			);

			const outcome = await done;
			clearTimeout(turnTimer);
			turnTimer = undefined;

			if (outcome === "timeout") {
				await this.api("POST", `/api/session/${encSession}/interrupt`).catch(() => {});
			}

			let afterMessages: any[] = [];
			if (outcome === "interrupted" || outcome === "failed") {
				if (this.sessions.has(sessionID)) {
					try {
						afterMessages = ((await this.api("GET", `/api/session/${encSession}/message?limit=50&order=desc`))?.data ?? []) as any[];
					} catch {
						// Server may have stopped or dropped the connection; never mask the real outcome/failure.
						afterMessages = [];
					}
				}
			} else {
				afterMessages = ((await this.api("GET", `/api/session/${encSession}/message?limit=50&order=desc`))?.data ?? []) as any[];
			}

			const newMessages = extractNewMessages(afterMessages, seenIds, beforeCount);
			for (const m of newMessages) {
				if (typeof m?.id === "string" && m.id) {
					seenIds.add(m.id);
					if (seenIds.size > MAX_SEEN_MESSAGES) {
						const oldest = seenIds.values().next().value;
						if (oldest !== undefined) seenIds.delete(oldest);
					}
				}
			}

			const assistant = newMessages.filter((m) => m?.type === "assistant");
			const text = assistant
				.flatMap((m) => (Array.isArray(m.content) ? m.content : []).filter((p: any) => p?.type === "text" && typeof p.text === "string").map((p: any) => p.text))
				.join("\n");
			const tokens = assistant.reduce((t, m) => ({ input: t.input + (m.tokens?.input ?? 0), output: t.output + (m.tokens?.output ?? 0) }), { input: 0, output: 0 });
			const cost = assistant.reduce((c, m) => c + (m.cost ?? 0), 0);
			const error = waiter.blocked
				? { message: `Stopped: the agent tried ${waiter.blocked}, which opencode runs without a permission check.` }
				: waiter.overLimit
					? { message: `Stopped: the agent kept calling tools (more than ${waiter.toolLimit}), which can only waste the turn here.` }
					: (assistant.map((m) => m.error).find(Boolean) ??
						// A turn can fail before the model says anything: the model is not there, or its provider does not answer.
						(outcome === "failed" ? { message: waiter.failure ?? NO_REASON } : undefined));

			return {
				sessionID,
				text: waiter.blocked ? "" : text,
				outcome: waiter.blocked || waiter.overLimit ? "interrupted" : outcome,
				tokens,
				cost,
				error: error ? String(error.message ?? JSON.stringify(error)) : undefined,
			};
		} finally {
			clearTimeout(turnTimer);
			if (this.waiters.get(sessionID) === waiter) {
				this.waiters.delete(sessionID);
			}
			if (!input.keep) {
				this.sessions.delete(sessionID);
				this.seenMessages.delete(sessionID);
				void this.api("DELETE", `/api/session/${encSession}`).catch(() => {});
			}
		}
	}
}

/** `sessionID` continues a kept session; otherwise each ask is a fresh one. */
export type AskInput = { text: string; title?: string; skills?: string[]; keep?: boolean; sessionID?: string; timeoutMs?: number; toolLimit?: number };

/** `serve --stdio` prints `{"url": ...}` as its first line. */
export async function firstUrl(
	proc: Subprocess<"pipe", "pipe", "pipe">,
	timeoutMs = FIRST_URL_TIMEOUT_MS,
	signal?: AbortSignal,
	stderr?: { tail: () => string; done: Promise<void> },
): Promise<string> {
	const stderrDrain = stderr ?? drainStderr(proc);
	const reader = proc.stdout.getReader();
	const decoder = new TextDecoder();
	let text = "";
	let timedOut = false;
	let aborted = false;
	let timer: ReturnType<typeof setTimeout> | undefined;
	let onAbort: (() => void) | undefined;

	const cancelAndKill = () => {
		void reader.cancel().catch(() => {});
		killQuietly(proc);
	};

	const timeoutPromise = new Promise<never>((_, reject) => {
		timer = setTimeout(() => {
			timedOut = true;
			cancelAndKill();
			reject(new Error(`opencode did not start within ${timeoutMs >= 1000 ? `${Math.round(timeoutMs / 1000)} s` : `${timeoutMs} ms`}.`));
		}, timeoutMs);
	});

	const abortPromise = signal
		? new Promise<never>((_, reject) => {
				onAbort = () => {
					aborted = true;
					cancelAndKill();
					reject(new Error("opencode start cancelled."));
				};
				if (signal.aborted) onAbort();
				else signal.addEventListener("abort", onAbort, { once: true });
			})
		: null;

	const readLine = (async () => {
		while (!text.includes("\n")) {
			if (text.length > 64 * 1024) {
				cancelAndKill();
				throw new Error("opencode wrote an oversized startup line before becoming ready.");
			}
			const { value, done } = await reader.read();
			if (done) {
				if (timedOut || aborted) return "";
				await Promise.race([stderrDrain.done, Bun.sleep(200)]);
				const tail = stderrDrain.tail().trim();
				throw new Error(`opencode exited before it was ready.${tail ? ` ${tail}` : ""}`.trim());
			}
			text += decoder.decode(value, { stream: true });
		}
		return text.split("\n")[0]!.replace(/\r$/, "");
	})();

	let line: string;
	try {
		line = await Promise.race([readLine, timeoutPromise, ...(abortPromise ? [abortPromise] : [])]);
	} finally {
		clearTimeout(timer);
		if (signal && onAbort) signal.removeEventListener("abort", onAbort);
		readLine.catch(() => {});
	}

	reader.releaseLock();
	// Keep draining stdout so the pipe never fills.
	(async () => {
		try {
			for await (const _ of proc.stdout) {
			}
		} catch {
			// Pipe closed.
		}
	})();

	let parsed: any;
	try {
		parsed = JSON.parse(line);
	} catch {
		killQuietly(proc);
		throw new Error(`opencode returned invalid startup JSON: ${line.slice(0, 200)}`);
	}
	if (typeof parsed?.url !== "string" || !parsed.url.trim()) {
		killQuietly(proc);
		throw new Error("opencode did not report a server URL.");
	}
	try {
		return validateAgentServerUrl(parsed.url, true);
	} catch (e) {
		killQuietly(proc);
		throw e;
	}
}
