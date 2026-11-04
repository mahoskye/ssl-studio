// The Agent panel's state: opencode's status, models, the conversation.
import { createStore, produce } from "solid-js/store";
import type { AgentModel, AgentReply, AgentStatus } from "../../shared/protocol";
import { backend, on } from "../backend";
import { notify, saveSetting, state } from "../state";
import { choose } from "../dialogs";

export type Entry = { id: number; role: "user" | "agent" | "note"; text: string; sessionID?: string; streaming?: boolean; meta?: string };

export const [agent, setAgent] = createStore({
	status: { state: "off" } as AgentStatus,
	models: [] as AgentModel[],
	entries: [] as Entry[],
	busy: false,
	/** The kept session the chat continues, if any. */
	chatSession: null as string | null,
});

let nextEntry = 1;
const streaming = new Map<string, number>();

export function addEntry(entry: Omit<Entry, "id">) {
	const id = nextEntry++;
	setAgent("entries", (list) => [...list.slice(-199), { ...entry, id }]);
	return id;
}

on("agent", ({ type, data }) => {
	const d = data as any;
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

export async function start() {
	try {
		setAgent("status", (await backend.agent("start", [])) as AgentStatus);
		setAgent("models", (await backend.agent("models", [])) as AgentModel[]);
	} catch (e: any) {
		setAgent("status", { state: "failed", message: String(e?.message ?? e) });
	}
}

export const currentModel = () => {
	if (state.settings.agentModel) return state.settings.agentModel;
	const local = agent.models.find((m) => m.local && m.tools);
	return local ? `${local.providerID}/${local.id}` : "";
};

export async function chooseModel(ref: string) {
	const model = agent.models.find((m) => `${m.providerID}/${m.id}` === ref);
	if (model && !model.local) {
		const answer = await choose(`${model.name} (${model.providerID}) is not a local model and may cost money. Use it for new agent sessions?`, ["Use it"]);
		if (answer !== "Use it") return;
	}
	await saveSetting({ agentModel: ref || undefined });
	setAgent("chatSession", null);
}

/** One prompt; streams into the conversation; returns the reply. */
export async function ask(text: string, options: { title?: string; skills?: string[]; show?: string; keep?: boolean; sessionID?: string; toolLimit?: number } = {}): Promise<AgentReply | null> {
	if (agent.busy) {
		notify("The agent is still working on the last request.");
		return null;
	}
	setAgent("busy", true);
	addEntry({ role: "user", text: options.show ?? text });
	try {
		if (agent.status.state !== "ready") await start();
		const reply = (await backend.agent("ask", [{ text, title: options.title, skills: options.skills, keep: options.keep, sessionID: options.sessionID, toolLimit: options.toolLimit }])) as AgentReply;
		const cost = reply.cost ? `, cost ${reply.cost}` : "";
		addEntry({ role: "note", text: `${reply.outcome} · ${reply.tokens?.input ?? 0} in / ${reply.tokens?.output ?? 0} out tokens${cost}${reply.error ? ` · ${reply.error}` : ""}` });
		return reply;
	} catch (e: any) {
		addEntry({ role: "note", text: `failed: ${e?.message ?? e}` });
		return null;
	} finally {
		setAgent("busy", false);
	}
}

export async function interrupt() {
	for (const sessionID of streaming.keys()) await backend.agent("interrupt", [sessionID]).catch(() => {});
}
