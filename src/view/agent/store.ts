// The Agent panel's state: opencode's status, models, the conversation.
import { createStore, produce } from "solid-js/store";
import type { AgentModel, AgentReply, AgentStatus } from "../../shared/protocol";
import { backend, on } from "../backend";
import { log, notify, saveSetting, state } from "../state";
import { choose } from "../dialogs";
import { looksCut } from "../plan/assist";
import { attempt, cutNote, decideModel, errorText, Turns } from "./logic";

export type EntryMeta = {
	ticket?: string;
	codePath?: string;
	isCatalogPrompt?: boolean;
};

export type Entry = {
	id: number;
	role: "user" | "agent" | "note";
	text: string;
	sessionID?: string;
	streaming?: boolean;
	meta?: string;
	turn?: EntryMeta;
};

export type SavedThreadEntry = Omit<Entry, "id" | "streaming">;

export type SavedThread = {
	id: string;
	title: string;
	updatedAt: number;
	ticket?: string;
	entries: SavedThreadEntry[];
};

const MAX_THREADS = 5;
const MAX_THREAD_ENTRIES = 40;
const threadStorageKey = (canonRoot: string) => `agent.threads.v1:${canonRoot}`;

let activeWorkspaceKey: string | null = null;

function readSavedThreads(canonRoot: string): SavedThread[] {
	try {
		const raw = localStorage.getItem(threadStorageKey(canonRoot));
		if (!raw) return [];
		const parsed = JSON.parse(raw);
		if (!Array.isArray(parsed)) return [];
		const out: SavedThread[] = [];
		for (const item of parsed) {
			if (!item || typeof item !== "object") continue;
			const id = typeof item.id === "string" && item.id.trim() ? item.id.trim() : "";
			const title = typeof item.title === "string" && item.title.trim() ? item.title.trim() : "Agent conversation";
			const updatedAt = typeof item.updatedAt === "number" && Number.isFinite(item.updatedAt) ? item.updatedAt : Date.now();
			const ticket = typeof item.ticket === "string" && item.ticket.trim() ? item.ticket.trim() : undefined;
			const rawEntries = Array.isArray(item.entries) ? item.entries : [];
			const entries: SavedThreadEntry[] = [];
			for (const e of rawEntries.slice(-MAX_THREAD_ENTRIES)) {
				if (!e || typeof e !== "object") continue;
				if (e.role !== "user" && e.role !== "agent" && e.role !== "note") continue;
				if (typeof e.text !== "string") continue;
				const turn =
					e.turn && typeof e.turn === "object"
						? {
								...(typeof e.turn.ticket === "string" ? { ticket: e.turn.ticket } : {}),
								...(typeof e.turn.codePath === "string" ? { codePath: e.turn.codePath } : {}),
								...(typeof e.turn.isCatalogPrompt === "boolean" ? { isCatalogPrompt: e.turn.isCatalogPrompt } : {}),
							}
						: undefined;
				entries.push({
					role: e.role,
					text: e.text,
					...(typeof e.meta === "string" ? { meta: e.meta } : {}),
					...(turn && Object.keys(turn).length ? { turn } : {}),
				});
			}
			if (id && entries.length) {
				out.push({ id, title, updatedAt, ...(ticket ? { ticket } : {}), entries });
			}
		}
		return out.sort((a, b) => b.updatedAt - a.updatedAt).slice(0, MAX_THREADS);
	} catch {
		return [];
	}
}

function writeSavedThreads(canonRoot: string, threads: readonly SavedThread[]) {
	try {
		const trimmed = threads.slice(0, MAX_THREADS).map((t) => ({
			...t,
			entries: t.entries.slice(-MAX_THREAD_ENTRIES),
		}));
		localStorage.setItem(threadStorageKey(canonRoot), JSON.stringify(trimmed));
	} catch {
		// localStorage unavailable or quota reached: ignore cleanly.
	}
}

function deriveThreadTitle(entries: readonly Entry[]): string {
	const firstUser = entries.find((e) => e.role === "user" && e.text.trim());
	if (!firstUser) return "Agent conversation";
	const clean = firstUser.text.replace(/\s{2}\(with [^)]+\)\s*$/, "").replace(/\s+/g, " ").trim();
	return clean.length > 64 ? `${clean.slice(0, 63)}…` : clean || "Agent conversation";
}

function deriveThreadTicket(entries: readonly Entry[]): string | undefined {
	for (let i = entries.length - 1; i >= 0; i--) {
		const t = entries[i]!.turn?.ticket?.trim();
		if (t) return t;
	}
	return undefined;
}

export const [agent, setAgent] = createStore({
	status: { state: "off" } as AgentStatus,
	models: [] as AgentModel[],
	entries: [] as Entry[],
	threads: [] as SavedThread[],
	activeThreadId: null as string | null,
	busy: false,
	/** Stop was asked for, and the turn has not ended yet. */
	stopping: false,
	/** The kept session the chat continues, if any. */
	chatSession: null as string | null,
});

let nextEntry = 1;
/** The reply being written, by session: the entry its text goes into. */
const streaming = new Map<string, number>();
/** Metadata for the turn currently in flight so streamed agent replies bind to their own turn's ticket/file. */
let activeTurnMeta: EntryMeta | undefined;
/** The turn in flight, from the moment it is asked for (logic.ts). */
const turns = new Turns((sessionID) => backend.agent("interrupt", [sessionID]));

export function addEntry(entry: Omit<Entry, "id">) {
	const id = nextEntry++;
	setAgent("entries", (list) => [...list.slice(-199), { ...entry, id }]);
	return id;
}

/** Persists the active thread (capped to 5 threads × 40 entries) to per-workspace localStorage only. */
export function persistCurrentThread() {
	if (!activeWorkspaceKey) return;
	const hasContent = agent.entries.some((e) => (e.role === "user" || e.role === "agent") && e.text.trim().length > 0);
	if (!hasContent) return;
	const cleanEntries: SavedThreadEntry[] = agent.entries
		.filter((e) => e.text.trim().length > 0)
		.slice(-MAX_THREAD_ENTRIES)
		.map(({ id: _id, streaming: _s, sessionID: _sid, ...rest }) => ({
			role: rest.role,
			text: rest.text,
			...(rest.meta ? { meta: rest.meta } : {}),
			...(rest.turn ? { turn: { ...rest.turn } } : {}),
		}));
	if (!cleanEntries.length) return;
	const id = agent.activeThreadId ?? `thr_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
	const ticket = deriveThreadTicket(agent.entries);
	const saved: SavedThread = {
		id,
		title: deriveThreadTitle(agent.entries),
		updatedAt: Date.now(),
		...(ticket ? { ticket } : {}),
		entries: cleanEntries,
	};
	const others = agent.threads.filter((t) => t.id !== id);
	const next = [saved, ...others].slice(0, MAX_THREADS);
	setAgent({ activeThreadId: id, threads: next });
	writeSavedThreads(activeWorkspaceKey, next);
}

/** Loads saved conversation threads for `canonRoot` on workspace open/switch (saving any outgoing thread first). */
export function syncWorkspaceThreads(canonRoot: string | null) {
	if (canonRoot === activeWorkspaceKey) return;
	persistCurrentThread();
	activeWorkspaceKey = canonRoot;
	if (!canonRoot) {
		setAgent({ threads: [], activeThreadId: null, entries: [], chatSession: null });
		return;
	}
	const loaded = readSavedThreads(canonRoot);
	if (loaded.length > 0) {
		const latest = loaded[0]!;
		const restored: Entry[] = latest.entries.map((e) => ({ ...e, id: nextEntry++ }));
		setAgent({ threads: loaded, activeThreadId: latest.id, entries: restored, chatSession: null });
	} else {
		setAgent({ threads: [], activeThreadId: null, entries: [], chatSession: null });
	}
}

/** Switches the conversation view to a previously saved thread from this workspace's History. */
export function switchThread(threadId: string) {
	if (agent.busy) return;
	persistCurrentThread();
	const target = agent.threads.find((t) => t.id === threadId);
	if (!target) return;
	const restored: Entry[] = target.entries.map((e) => ({ ...e, id: nextEntry++ }));
	setAgent({ entries: restored, activeThreadId: target.id, chatSession: null });
}

/** Archives the current thread into History and starts a fresh conversation thread. */
export function startNewThread(noteText?: string) {
	if (agent.busy) return;
	persistCurrentThread();
	const entries: Entry[] = noteText ? [{ id: nextEntry++, role: "note", text: noteText }] : [];
	setAgent({ entries, activeThreadId: null, chatSession: null });
}

/** Removes all saved threads for the current workspace from localStorage. */
export function clearSavedThreads() {
	if (agent.busy) return;
	if (activeWorkspaceKey) {
		try {
			localStorage.removeItem(threadStorageKey(activeWorkspaceKey));
		} catch {
			// ignore
		}
	}
	setAgent({ threads: [], activeThreadId: null, entries: [], chatSession: null });
}

export function clearEntries() {
	setAgent({ entries: [], activeThreadId: null, chatSession: null });
}

/** For work nobody waits for: a failure is shown and written to Output, never dropped. */
export const safely = <T>(what: string, work: () => T | Promise<T>, failed?: (message: string) => void) => attempt(what, work, { notify, log }, failed);

on("agent", ({ type, data }) => {
	const d = data as any;
	turns.event(type, d);
	if (type === "status") setAgent("status", d as AgentStatus);
	else if (type === "guard") addEntry({ role: "note", text: `Stopped the turn: the agent reached for ${d.tool}, which opencode runs without asking permission.`, sessionID: d.sessionID });
	else if (type === "session.text.delta") {
		let id = streaming.get(d.sessionID);
		if (id === undefined) {
			id = addEntry({ role: "agent", text: "", sessionID: d.sessionID, streaming: true, ...(activeTurnMeta ? { turn: activeTurnMeta } : {}) });
			streaming.set(d.sessionID, id);
		}
		setAgent("entries", (e) => e.id === id, produce((e: Entry) => void (e.text += d.delta)));
	} else if (type === "session.tool.called") {
		addEntry({ role: "note", text: `tool: ${d.input?.code ? "execute (code)" : JSON.stringify(d.input).slice(0, 120)}`, sessionID: d.sessionID });
	} else if (/^session\.execution\.(succeeded|failed|interrupted)$/.test(type)) {
		const id = streaming.get(d.sessionID);
		if (id !== undefined) setAgent("entries", (e) => e.id === id, "streaming", false);
		streaming.delete(d.sessionID);
	}
});

/**
 * What the panel shows when it opens is what is so: a page that was reloaded,
 * or a second window, finds opencode as the app left it, already running or not.
 */
export async function resume() {
	if (agent.status.state !== "off") return;
	await safely("opencode's state could not be read", async () => {
		const status = (await backend.agent("status", [])) as AgentStatus;
		// A turn may have started it meanwhile; what that set stands.
		if (agent.status.state !== "off" || status.state === "off") return;
		setAgent("status", status);
		if (status.state === "ready") setAgent("models", (await backend.agent("models", [])) as AgentModel[]);
	});
}

export async function start() {
	try {
		setAgent("status", (await backend.agent("start", [])) as AgentStatus);
		setAgent("models", (await backend.agent("models", [])) as AgentModel[]);
	} catch (e) {
		// The panel shows the message under the status line; Output keeps it.
		setAgent("status", { state: "failed", message: errorText(e) });
		log(`opencode did not start: ${errorText(e)}`);
	}
}

/** Stops the opencode server (not one reply: that is `interrupt`). */
export async function stop() {
	await safely("opencode did not stop", async () => setAgent("status", (await backend.agent("stop", [])) as AgentStatus));
}

export const currentModel = () => {
	if (state.settings.agentModel) return state.settings.agentModel;
	const local = agent.models.find((m) => m.local && m.tools);
	return local ? `${local.providerID}/${local.id}` : "";
};

/** Says whether the model was saved. False: the user backed out, and the model in use has not changed. */
export async function chooseModel(ref: string): Promise<boolean> {
	const decision = await decideModel(ref, agent.models, choose);
	if (!decision) return false;
	if (decision.own) await saveSetting({ agentOwnModels: [...new Set([...(state.settings.agentOwnModels ?? []), ref])] });
	// A project that names its model wins over the user's own setting, so the choice is kept with the workspace there.
	// An empty choice takes the setting out, so the default model shows through.
	await saveSetting({ agentModel: ref || null }, state.project?.agentModel ? "workspace" : "user");
	setAgent("models", (await backend.agent("models", [])) as AgentModel[]);
	setAgent("chatSession", null);
	return true;
}

/** One prompt; streams into the conversation; returns the reply. */
export async function ask(text: string, options: { title?: string; skills?: string[]; show?: string; keep?: boolean; sessionID?: string; toolLimit?: number; turn?: EntryMeta } = {}): Promise<AgentReply | null> {
	if (agent.busy) {
		notify("The agent is still working on the last request.");
		return null;
	}
	setAgent("busy", true);
	activeTurnMeta = options.turn;
	turns.begin(options.sessionID);
	addEntry({ role: "user", text: options.show ?? text, ...(options.turn ? { turn: options.turn } : {}) });
	try {
		if (agent.status.state !== "ready") await start();
		const reply = (await backend.agent("ask", [{ text, title: options.title, skills: options.skills, keep: options.keep, sessionID: options.sessionID, toolLimit: options.toolLimit }])) as AgentReply;
		const cost = reply.cost ? `, cost ${reply.cost}` : "";
		const outcome = reply.outcome === "interrupted" && turns.stopping ? "stopped by you" : reply.outcome;
		addEntry({ role: "note", text: `${outcome} · ${reply.tokens?.input ?? 0} in / ${reply.tokens?.output ?? 0} out tokens${cost}${reply.error ? ` · ${reply.error}` : ""}` });
		// A local model's context drops what does not fit without a word: the reply then answers a question it only half saw.
		const cut = cutNote(looksCut(text.length, reply.tokens?.input ?? 0), Boolean(options.sessionID));
		if (cut) addEntry({ role: "note", text: cut });
		// A turn that did not finish is kept in Output too: the conversation can be cleared, and the reason is what gets fixed.
		if (reply.outcome !== "succeeded" && outcome !== "stopped by you") log(`agent turn ${reply.outcome}${reply.error ? `: ${reply.error}` : ""}`);
		return reply;
	} catch (e) {
		addEntry({ role: "note", text: `failed: ${errorText(e)}` });
		log(`agent request failed: ${errorText(e)}`);
		return null;
	} finally {
		turns.end();
		activeTurnMeta = undefined;
		// A turn that ended without its closing event (a lost stream) must not stay marked as being written.
		for (const id of streaming.values()) setAgent("entries", (e) => e.id === id, "streaming", false);
		streaming.clear();
		setAgent({ busy: false, stopping: false });
		persistCurrentThread();
	}
}

/**
 * Stops the reply in flight, from the moment it was asked for: before opencode
 * has a session for it, the stop is remembered and sent as soon as it has one.
 */
export async function interrupt() {
	if (!turns.busy) return;
	const first = !turns.stopping;
	setAgent("stopping", true);
	const result = await turns.stop();
	// The turn may have ended while the interrupt was on its way.
	setAgent("stopping", turns.stopping);
	if (result === "waiting" && first && turns.stopping) addEntry({ role: "note", text: "Stopping: opencode has not started on this request yet. It will be stopped as soon as it does." });
}
