// The Agent panel's state: opencode's status, models, the conversation.
import { createStore, produce } from "solid-js/store";
import type { AgentModel, AgentReply, AgentStatus } from "../../shared/protocol";
import { backend, on } from "../backend";
import { log, notify, saveSetting, state } from "../state";
import { choose } from "../dialogs";
import { attempt, decideModel, errorText, Turns } from "./logic";

export type Entry = { id: number; role: "user" | "agent" | "note"; text: string; sessionID?: string; streaming?: boolean; meta?: string };

export const [agent, setAgent] = createStore({
	status: { state: "off" } as AgentStatus,
	models: [] as AgentModel[],
	entries: [] as Entry[],
	busy: false,
	/** Stop was asked for, and the turn has not ended yet. */
	stopping: false,
	/** The kept session the chat continues, if any. */
	chatSession: null as string | null,
});

let nextEntry = 1;
/** The reply being written, by session: the entry its text goes into. */
const streaming = new Map<string, number>();
/** The turn in flight, from the moment it is asked for (logic.ts). */
const turns = new Turns((sessionID) => backend.agent("interrupt", [sessionID]));

export function addEntry(entry: Omit<Entry, "id">) {
	const id = nextEntry++;
	setAgent("entries", (list) => [...list.slice(-199), { ...entry, id }]);
	return id;
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
			id = addEntry({ role: "agent", text: "", sessionID: d.sessionID, streaming: true });
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
export async function ask(text: string, options: { title?: string; skills?: string[]; show?: string; keep?: boolean; sessionID?: string; toolLimit?: number } = {}): Promise<AgentReply | null> {
	if (agent.busy) {
		notify("The agent is still working on the last request.");
		return null;
	}
	setAgent("busy", true);
	turns.begin(options.sessionID);
	addEntry({ role: "user", text: options.show ?? text });
	try {
		if (agent.status.state !== "ready") await start();
		const reply = (await backend.agent("ask", [{ text, title: options.title, skills: options.skills, keep: options.keep, sessionID: options.sessionID, toolLimit: options.toolLimit }])) as AgentReply;
		const cost = reply.cost ? `, cost ${reply.cost}` : "";
		const outcome = reply.outcome === "interrupted" && turns.stopping ? "stopped by you" : reply.outcome;
		addEntry({ role: "note", text: `${outcome} · ${reply.tokens?.input ?? 0} in / ${reply.tokens?.output ?? 0} out tokens${cost}${reply.error ? ` · ${reply.error}` : ""}` });
		// A turn that did not finish is kept in Output too: the conversation can be cleared, and the reason is what gets fixed.
		if (reply.outcome !== "succeeded" && outcome !== "stopped by you") log(`agent turn ${reply.outcome}${reply.error ? `: ${reply.error}` : ""}`);
		return reply;
	} catch (e) {
		addEntry({ role: "note", text: `failed: ${errorText(e)}` });
		log(`agent request failed: ${errorText(e)}`);
		return null;
	} finally {
		turns.end();
		// A turn that ended without its closing event (a lost stream) must not stay marked as being written.
		for (const id of streaming.values()) setAgent("entries", (e) => e.id === id, "streaming", false);
		streaming.clear();
		setAgent({ busy: false, stopping: false });
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
