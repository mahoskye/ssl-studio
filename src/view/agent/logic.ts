// The Agent panel's decisions, kept free of the DOM, Monaco and the app's
// state, so the tests can run them against the recorded fake of opencode
// (test/agentPanel.test.ts). store.ts, tidy.ts and Agent.tsx supply the
// dialogs, the toasts and the backend.

export const errorText = (e: unknown) => String((e as { message?: unknown } | null)?.message ?? e);

const ENDED = /^session\.execution\.(succeeded|failed|interrupted)$/;

/**
 * The turn in flight, known from the moment a prompt is sent and not from its
 * first token: a local model can think for minutes before it writes anything,
 * and that wait has to be something the user can stop.
 */
export class Turns {
	private asking = 0;
	private live = new Set<string>();
	private wanted = false;

	constructor(private interrupt: (sessionID: string) => Promise<unknown>) {}

	/** A prompt is on its way, or its turn is running. */
	get busy() {
		return this.asking > 0;
	}

	/** Stop was asked for and the turn has not ended yet. */
	get stopping() {
		return this.wanted;
	}

	/** An ask starts. A kept session is known at once; a new one when the adapter reports it. */
	begin(sessionID?: string) {
		this.asking++;
		if (sessionID) this.live.add(sessionID);
	}

	/** The ask returned, however it went. */
	end() {
		this.asking = Math.max(0, this.asking - 1);
		if (this.asking) return;
		this.live.clear();
		this.wanted = false;
	}

	/** One of the adapter's events (src/bun/agent.ts sends them for the IDE's own sessions only). */
	event(type: string, data: { sessionID?: string } | null | undefined) {
		const sessionID = data?.sessionID;
		if (!sessionID || !this.asking) return;
		if (ENDED.test(type)) return void this.live.delete(sessionID);
		if (type !== "session" && !type.startsWith("session.")) return;
		const fresh = !this.live.has(sessionID);
		this.live.add(sessionID);
		// Stop was pressed before there was anything to stop. An interrupt that
		// lands before the prompt does nothing, so it is sent again when the turn starts.
		if (this.wanted && (fresh || /\.started$/.test(type))) void this.interrupt(sessionID).catch(() => {});
	}

	/**
	 * Stops the turn. "waiting" means opencode has no session for it yet (it is
	 * starting, or checking skills): the turn is stopped as soon as it has one.
	 */
	async stop(): Promise<"stopped" | "waiting" | "idle"> {
		if (!this.asking) return "idle";
		this.wanted = true;
		const sessions = [...this.live];
		await Promise.all(sessions.map((sessionID) => this.interrupt(sessionID).catch(() => {})));
		return sessions.length ? "stopped" : "waiting";
	}
}

export const USE_IT = "Use it";
export const MINE = "It runs on my own machine";

type ModelLike = { providerID: string; id: string; name: string; local: boolean };
export const modelRef = (m: { providerID: string; id: string }) => `${m.providerID}/${m.id}`;

/** The models of one heading in the list to choose from. */
export type ModelGroup<M> = { label: string; local: boolean; models: M[] };

/**
 * The models under headings, for a list that may be hundreds long: those on
 * this machine first, under one heading whichever provider serves them, then
 * each other provider by name with its own. Within a heading, by name.
 */
export function groupModels<M extends ModelLike>(models: readonly M[]): ModelGroup<M>[] {
	const byName = (a: M, b: M) => a.name.localeCompare(b.name, undefined, { sensitivity: "base", numeric: true });
	const local = models.filter((m) => m.local).sort(byName);
	const providers = [...new Set(models.filter((m) => !m.local).map((m) => m.providerID))].sort((a, b) => a.localeCompare(b));
	return [
		...(local.length ? [{ label: "On this machine", local: true, models: local }] : []),
		...providers.map((id) => ({ label: `${id}: may cost money`, local: false, models: models.filter((m) => !m.local && m.providerID === id).sort(byName) })),
	];
}

/**
 * What choosing a model comes to: the model to save, or null when the user
 * backed out of a paid one, in which case nothing is saved and the list must
 * go back to showing the model still in use.
 */
export async function decideModel(ref: string, models: ModelLike[], choose: (title: string, buttons: string[], options?: { danger?: string }) => Promise<string | null>): Promise<{ model: string; own: boolean } | null> {
	const model = models.find((m) => modelRef(m) === ref);
	if (!model || model.local) return { model: ref, own: false };
	const answer = await choose(`${model.name} (${model.providerID}) is not a local model and may cost money. Use it for new agent sessions?`, [USE_IT, MINE], { danger: USE_IT });
	if (answer !== USE_IT && answer !== MINE) return null;
	// Remembered for this user: the model counts as local from now on, and is not asked about again.
	return { model: ref, own: answer === MINE };
}

function fenceLangFor(file: string): string {
	const lower = file.toLowerCase();
	if (/\.(ssl|srvscr|ds)$/.test(lower)) return "ssl";
	if (/\.sql$/.test(lower)) return "sql";
	if (/\.(md|markdown)$/.test(lower)) return "markdown";
	if (/\.(json|jsonc)$/.test(lower)) return "json";
	if (/\.(xml|xfd|xsd|xsl|wsdl|config|svg)$/.test(lower)) return "xml";
	if (/\.(csv|tsv)$/.test(lower)) return "csv";
	if (/\.ya?ml$/.test(lower)) return "yaml";
	if (/\.toml$/.test(lower)) return "toml";
	if (/\.tsx?$/.test(lower)) return "typescript";
	if (/\.jsx?$/.test(lower)) return "javascript";
	if (/\.html?$/.test(lower)) return "html";
	if (/\.css$/.test(lower)) return "css";
	return "ssl";
}

/**
 * A question as it is sent: the work it is for, then the question, then the
 * code it is about. The agent has no file tools here, and is told so.
 */
export function composeQuestion(question: string, code?: { file: string; label: string; code: string } | null, work?: string): string {
	const parts = [...(work ? [work, "", "THE QUESTION:"] : []), question];
	if (code) parts.push("", `About this code from ${code.file}, ${code.label}:`, `\`\`\`${fenceLangFor(code.file)}`, code.code, "```");
	if (code || work) parts.push("", `You cannot read files in this session; answer from ${code && work ? "the code and the documents above" : code ? "the code above" : "the documents above"}.`);
	return parts.join("\n");
}

/**
 * What to say when a prompt looks cut: a model's context limit drops what
 * does not fit with no error, and the count of tokens it took gives it away.
 * In a kept conversation it is the start that goes: the ticket, the earlier
 * questions. Null when nothing looks cut.
 */
export function cutNote(cut: boolean, kept: boolean): string | null {
	if (!cut) return null;
	return `This prompt looks cut off: the model took in exactly as much as its context holds, or less than it was sent, so it missed part of it${kept ? ", most likely the start of this conversation: the ticket and the earlier questions" : ""}. With Ollama, set a larger context (docs/INSTALL.md)${kept ? ", or start a new conversation" : ""}.`;
}

export const NOT_SENT = "Not sent: the agent is still working on the last request. Your question is kept here. Send it when the reply ends, or stop the reply.";

/** What Send does with the draft. The draft is cleared only when it goes out. */
export function composerSend(draft: string, busy: boolean): { send: string | null; draft: string; why?: string } {
	const question = draft.trim();
	if (!question) return { send: null, draft };
	if (busy) return { send: null, draft, why: NOT_SENT };
	return { send: question, draft: "" };
}

export type StepState = "pending" | "running" | "review" | "accepted" | "rejected" | "unchanged" | "failed";

/** A tidy step's button: what it says, and why it cannot be pressed when it cannot. */
export function stepAction(step: StepState, at: { busy: boolean; reviewOpen: boolean }): { label: string; disabled: boolean; title?: string } {
	if (step === "running") return { label: "Running…", disabled: true, title: "This step is running. Stop this reply to cancel it." };
	if (step === "review")
		return at.reviewOpen
			? { label: "In review", disabled: true, title: "This step's proposal is open for review. Accept or reject it there." }
			: { label: "Show review", disabled: false, title: "Open this step's proposal for review again" };
	const label = step === "pending" ? "Run" : step === "failed" || step === "rejected" ? "Try again" : "Run again";
	return at.busy ? { label, disabled: true, title: "The agent is still working on the last request." } : { label, disabled: false };
}

export type Reporter = { notify: (text: string, kind: "info" | "error") => void; log: (line: string) => void };

/**
 * Runs work whose promise nobody waits for (a button's handler). A failure is
 * shown, written to Output, and handed to `failed`, which puts whatever was
 * "running" into a state the user can try again from.
 */
export async function attempt<T>(what: string, work: () => T | Promise<T>, io: Reporter, failed?: (message: string) => void): Promise<T | undefined> {
	try {
		return await work();
	} catch (e) {
		const message = errorText(e);
		failed?.(message);
		// An error toast is written to Output by `notify` itself. What is added here is where it
		// came from, on one line: the first frames of the stack, when there is one.
		io.notify(`${what}: ${message}`, "error");
		const frames = e instanceof Error && e.stack ? e.stack.split("\n").map((line) => line.trim()).filter((line) => line && !line.includes(message)).slice(0, 3) : [];
		io.log(`${what}${frames.length ? ` (${frames.join(" < ")})` : ""}`);
		return undefined;
	}
}
