// The Agent panel: opencode status and model, the tidy sequence for the
// current file, and a conversation that can include the selection.
import { Icon, type IconName } from "../Icon";
import { createEffect, createMemo, createSignal, For, onCleanup, onMount, Show } from "solid-js";
import { activeEditor } from "../editor/EditorGroup";
import { review } from "../editor/Review";
import { activeDoc, activePath, canonical, documents, notify, state } from "../state";
import { addEntry, agent, ask, chooseModel, currentModel, interrupt, resume, safely, setAgent, start, stop, type Entry } from "./store";
import { groupModels, composeQuestion, composerSend, modelRef, stepAction } from "./logic";
import { followReplyLink, renderReply } from "./markdown";
import { notePath, proposalOf, runStep, showReview, startTidy, STEPS, tidy } from "./tidy";
import { relativeTo } from "../../shared/paths";
import { isCatalog, promptText } from "../../shared/projectDocs";
import type { DocFile } from "../../shared/protocol";
import { backend } from "../backend";
import { docs } from "../project";
import { ticketAtHand, workPrompt } from "../projectDocs";
import { recall, remember } from "../graph/canvas";

/** A step's state as a mark: not yet, under way, waiting to be looked at, taken, turned down, nothing to change, failed. */
const STEP_ICON: Record<string, IconName> = { pending: "circle-outline", running: "sync", review: "eye", accepted: "pass-filled", rejected: "close", unchanged: "dash", failed: "error" };
const NEW_CONVERSATION = "New conversation: the next question starts fresh. The agent will not see the earlier ones.";
/** How near the end of the conversation counts as "at the end", in pixels. */
const NEAR_END = 24;

/** The selection, or the procedure around the cursor when nothing is selected. */
export function selectionContext(): { label: string; code: string } | null {
	const editor = activeEditor();
	const model = editor?.getModel();
	if (!editor || !model) return null;
	const selection = editor.getSelection();
	if (selection && !selection.isEmpty()) return { label: `lines ${selection.startLineNumber}-${selection.endLineNumber}`, code: model.getValueInRange(selection) };
	return null;
}

/** The ticket whose work the conversation in flight was last told of: it is said once, not with every question. */
let toldOf: { session: string | null; ticket: string } | null = null;

export async function askAbout(question: string, includeSelection: boolean, includeWork = false) {
	const path = activePath();
	const context = includeSelection ? selectionContext() : null;
	const file = path ? relativeTo(state.workspace?.root, path) : "";
	// The ticket and what bears on it: the agent cannot read the folder, so it is sent, once in a conversation.
	const ticket = includeWork ? ticketAtHand() : "";
	const told = toldOf && toldOf.session === agent.chatSession && toldOf.ticket === ticket && agent.chatSession !== null;
	const work = ticket && !told ? await workPrompt(ticket) : null;
	const text = composeQuestion(question, context && { ...context, file }, work?.text);
	const withWhat = [context ? `${file} ${context.label}` : "", work ? work.label : ""].filter(Boolean).join("; ");
	const reply = await ask(text, { title: "SSL Studio chat", keep: true, sessionID: agent.chatSession ?? undefined, show: withWhat ? `${question}  (with ${withWhat})` : question });
	if (reply) setAgent("chatSession", reply.sessionID);
	if (reply && work) toldOf = { session: reply.sessionID, ticket };
}

/** One entry of the conversation. A reply is Markdown; the user's words and the notes are shown as written. */
function EntryView(props: { entry: Entry }) {
	const html = createMemo(() => (props.entry.role === "agent" ? renderReply(props.entry.text) : ""));
	return (
		<div class={`entry ${props.entry.role}`} classList={{ streaming: Boolean(props.entry.streaming) }} aria-busy={props.entry.streaming ? "true" : undefined}>
			<Show when={props.entry.role === "agent"} fallback={<pre>{props.entry.text}</pre>}>
				<div class="md" innerHTML={html()} onClick={followReplyLink} />
			</Show>
		</div>
	);
}

/**
 * The prompts the project keeps in its knowledge base (ADR 0026): what its own people ask the agent again and again.
 * One still as its template has no words to offer.
 */
export const keptPrompts = (): DocFile[] => docs().filter((d) => d.exists && d.group === "knowledge" && d.kind === "prompts" && !isCatalog(d) && !d.untouched && /\.(md|markdown)$/i.test(d.name) && !/(^|[\\/])readme\.(md|markdown)$/i.test(d.name));

/** A kept prompt's words as they stand: in the editor if it is open there, on disk otherwise. */
async function wordsOf(file: DocFile): Promise<string> {
	const open = documents.get(canonical(file.path));
	return promptText(open ? open.model.getValue() : (await backend.read(file.path)).text);
}

/** Questions someone reading SSL they did not write tends to have. Each is sent with the selection, like any other. */
const STARTERS = ["Explain what this does, step by step.", "What could go wrong here, and with which input?", "Which cases should a test of this cover?", "Is anything here against the house style?"];

export function AgentPanel() {
	onMount(() => void resume());
	const [draft, setDraft] = createSignal("");
	/** The box the question is typed in, for a starter to hand the keyboard to. */
	let box: HTMLTextAreaElement | undefined;
	const [notSent, setNotSent] = createSignal("");
	const [withSelection, setWithSelection] = createSignal(true);
	/** Whether the ticket at hand goes with the first question of a conversation. Kept, since it costs tokens. */
	const [withWork, setWithWork] = createSignal(recall("agent.withWork") !== "no");
	// The ticket at hand is read from the open document's text, which says nothing when it changes: this does.
	const [edited, setEdited] = createSignal(0);
	createEffect(() => {
		const listener = activeDoc()?.model.onDidChangeContent(() => setEdited((n) => n + 1));
		onCleanup(() => listener?.dispose());
	});
	const ticket = createMemo(() => (edited(), ticketAtHand()));
	const modelOf = (ref: string) => agent.models.find((m) => modelRef(m) === ref);
	const usable = () => agent.models.filter((m) => m.tools);

	// The conversation follows the reply as it is written, until the user scrolls up to read.
	let scroller!: HTMLDivElement;
	let pinned = true;
	const toEnd = () => {
		pinned = true;
		scroller.scrollTop = scroller.scrollHeight;
	};
	createEffect(() => {
		// Text arriving in any entry moves the end, as a new entry does.
		agent.entries.reduce((n, e) => n + e.text.length, agent.entries.length);
		agent.busy;
		if (pinned) scroller.scrollTop = scroller.scrollHeight;
	});
	// The reason goes when it no longer holds.
	createEffect(() => !agent.busy && setNotSent(""));

	const send = () => {
		const result = composerSend(draft(), agent.busy);
		setDraft(result.draft);
		setNotSent(result.why ?? "");
		if (result.send === null) return;
		toEnd();
		void safely("The question was not sent", () => askAbout(result.send!, withSelection(), withWork()));
	};
	const pickModel = async (select: HTMLSelectElement) => {
		const saved = await safely("The model was not changed", () => chooseModel(select.value));
		// Declined, or not saved: the list goes back to the model still in use.
		if (!saved) select.value = currentModel();
	};
	const newConversation = () => {
		setAgent("chatSession", null);
		if (agent.entries.at(-1)?.text !== NEW_CONVERSATION) addEntry({ role: "note", text: NEW_CONVERSATION });
		toEnd();
	};
	const tidyBlocked = () => {
		const doc = activeDoc();
		if (!doc) return "Open an SSL file to tidy it.";
		if (doc.model.getLanguageId() !== "ssl") return "Tidy works on SSL files. This is not one.";
		if (agent.busy) return "The agent is still working on the last request.";
		if (tidy.steps.includes("review")) return "A step is under review. Accept or reject it first.";
		return "";
	};

	return (
		<div class="panel-body agent">
			<div class="panel-title">
				<span>Agent</span>
				<Show
					when={agent.status.state === "ready"}
					fallback={
						<button disabled={agent.status.state === "starting"} title={agent.status.state === "starting" ? "opencode is starting." : "Start the opencode server"} onClick={() => void start()}>
							Start opencode
						</button>
					}
				>
					<button title="Stop the opencode server. A reply in progress ends with it." onClick={() => void stop()}>
						Stop opencode
					</button>
				</Show>
			</div>
			<div class="agent-status">
				<span class={`dot ${agent.status.state}`} aria-hidden="true" />
				<span>
					{agent.status.state === "ready" ? `opencode ${agent.status.version}` : agent.status.state === "starting" ? "Starting opencode…" : agent.status.state === "failed" ? "opencode failed" : state.info?.opencode.ok ? "opencode is not running" : state.info?.opencode.version ? `opencode ${state.info.opencode.version} cannot be used` : "opencode not found"}
				</span>
			</div>
			{/* Why it is off, when it is there and cannot be used: a version outside the range the adapter was written for. */}
			<Show when={agent.status.message || (state.info && !state.info.opencode.ok && state.info.opencode.message)}>
				<p class="agent-note warn">{agent.status.message || state.info?.opencode.message}</p>
			</Show>
			<Show
				when={usable().length}
				fallback={
					<p class="agent-note">
						Model for a new session: <strong>{state.settings.agentModel || "the first local model opencode offers"}</strong>
						{agent.models.length ? ". opencode offers no model that can use tools." : ". The list to choose from appears when opencode has started."}
					</p>
				}
			>
				<label class="agent-model">
					Model for a new session
					<select value={currentModel()} onChange={(e) => void pickModel(e.currentTarget)}>
						{/* A saved model opencode does not list must not read as the first one in the list. */}
						<Show when={!modelOf(currentModel())?.tools}>
							<option value={currentModel()} selected disabled>
								{currentModel() ? `${currentModel()} (not in the list below)` : "No model chosen"}
							</option>
						</Show>
						{/* Under headings: a provider may offer hundreds, and the ones on this machine come first. */}
						<For each={groupModels(usable())}>
							{(group) => (
								<optgroup label={group.label}>
									<For each={group.models}>
										{(m) => (
											<option value={modelRef(m)} selected={modelRef(m) === currentModel()}>
												{m.local ? `${m.name} · ${m.providerID}` : `$ ${m.name}`}
											</option>
										)}
									</For>
								</optgroup>
							)}
						</For>
					</select>
				</label>
				<Show when={usable().some((m) => !m.local)}>
					<p class="agent-note">$ marks a model that is not local. Its prompts may cost money, and choosing one asks first.</p>
				</Show>
				<Show when={modelOf(currentModel()) && !modelOf(currentModel())!.local}>
					<p class="agent-note warn">The chosen model is not local: prompts may cost money.</p>
				</Show>
			</Show>

			<section class="tidy" aria-label="Tidy">
				<div class="tidy-head">
					<strong>Tidy</strong>
					<span class="spacer" />
					<button onClick={() => void safely("Tidy did not start", startTidy)} disabled={Boolean(tidyBlocked())} title={tidyBlocked() || (tidy.path && tidy.path === activePath() ? "Start again from step 1" : "Tidy the file in the editor, one reviewed step at a time")}>
						{tidy.path && tidy.path === activePath() ? "Restart" : "This file"}
					</button>
				</div>
				<p class="tidy-about">{tidy.path ? relativeTo(state.workspace?.root, tidy.path) : "The six ssl-tidy steps, each reviewed before anything changes."}</p>
				<Show when={tidy.path}>
					<For each={STEPS}>
						{(step, i) => {
							const action = () => stepAction(tidy.steps[i()]!, { busy: agent.busy, reviewOpen: review() !== null && review() === proposalOf(i()) });
							return (
								<>
									<div class={`tidy-step ${tidy.steps[i()]}`}>
										<Icon name={STEP_ICON[tidy.steps[i()]!] ?? "circle-outline"} class="icon" />
										<span class="label">
											{i() + 1}. {step.title}
										</span>
										<span class="meta">{tidy.steps[i()]}</span>
										<button disabled={action().disabled} title={action().title} onClick={() => void (tidy.steps[i()] === "review" ? safely("The review did not open", () => showReview(i())) : runStep(i()))}>
											{action().label}
										</button>
									</div>
									<Show when={tidy.problems[i()]}>
										<p class="tidy-problem">{tidy.problems[i()]}</p>
									</Show>
								</>
							);
						}}
					</For>
					<p class="tidy-about">Notes go to {relativeTo(state.workspace?.root, notePath(tidy.path!))}. Accepted steps are edits in the editor: save to keep them.</p>
				</Show>
			</section>

			<div class="conversation" ref={scroller} role="log" aria-live="polite" aria-label="Conversation with the agent" onScroll={() => (pinned = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < NEAR_END)}>
				<For
					each={agent.entries}
					fallback={
						<div class="agent-start">
							<p class="agent-note">Ask about the selection, or run a tidy step. Shell, web and files outside the workspace are denied to the agent.</p>
							{/* Questions to start from: one puts its words in the box, to send as they are or to change first. */}
							<ul class="agent-starters" aria-label="Questions to start from">
								<For each={STARTERS}>
									{(text) => (
										<li>
											<button title="Put this in the box below" onClick={() => (setDraft(text), setNotSent(""), box?.focus())}>
												{text}
											</button>
										</li>
									)}
								</For>
							</ul>
							{/* The project's own: what it keeps under its knowledge base's prompts. Put in the box like the others, never sent from here. */}
							<Show when={keptPrompts().length}>
								<p class="agent-kept">Kept in this project</p>
								<ul class="agent-starters" aria-label="Prompts kept in this project">
									<For each={keptPrompts()}>
										{(file) => (
											<li>
												<button
													title={`Put this prompt in the box below${file.summary ? `: ${file.summary}` : ""}`}
													onClick={() =>
														void wordsOf(file).then(
															(words) => (words ? (setDraft(words), setNotSent(""), box?.focus()) : notify(`${file.title || file.name} has no words in it yet.`)),
															(e) => notify(String(e?.message ?? e), "error"),
														)
													}
												>
													{file.title || file.name}
												</button>
											</li>
										)}
									</For>
								</ul>
							</Show>
						</div>
					}
				>
					{(e) => <EntryView entry={e} />}
				</For>
				<Show when={agent.busy && !agent.entries.some((e) => e.streaming)}>
					<p class="agent-waiting">{agent.stopping ? "Stopping…" : "Waiting for the agent. A local model can take a while before its first words."}</p>
				</Show>
			</div>
			<form class="composer" onSubmit={(e) => (e.preventDefault(), send())}>
				<textarea
					ref={box}
					aria-label="Question for the agent"
					placeholder="Ask about this code (Ctrl+Enter)"
					value={draft()}
					onInput={(e) => (setDraft(e.currentTarget.value), setNotSent(""))}
					onKeyDown={(e) => e.key === "Enter" && (e.ctrlKey || e.metaKey) && (e.preventDefault(), send())}
				/>
				<Show when={notSent()}>
					<p class="composer-note" role="status">
						{notSent()}
					</p>
				</Show>
				<label class="check">
					<input type="checkbox" checked={withSelection()} onChange={(e) => setWithSelection(e.currentTarget.checked)} /> include the selection
				</label>
				<Show when={ticket()}>
					<label class="check" title={`Sends ${ticket()} with the first question of a conversation: what it asks, the tickets it is related to, the open questions and the decisions already made. The agent cannot read the folder itself.`}>
						<input type="checkbox" checked={withWork()} onChange={(e) => (setWithWork(e.currentTarget.checked), remember("agent.withWork", e.currentTarget.checked ? "yes" : "no"))} /> include the ticket, {ticket()}
					</label>
				</Show>
				<div class="composer-bar">
					<button type="button" aria-label="Start a new conversation" disabled={agent.busy} title={agent.busy ? "Wait for this reply, or stop it, before starting a new conversation." : "Start a new conversation: the agent will not see the earlier questions"} onClick={newConversation}>
						New
					</button>
					<span class="spacer" />
					<Show when={agent.busy}>
						<button type="button" title={agent.stopping ? "opencode was asked to stop this reply. Press again to ask once more." : "Stop this reply. opencode keeps running."} onClick={() => void safely("The reply was not stopped", interrupt)}>
							{agent.stopping ? "Stopping…" : "Stop this reply"}
						</button>
					</Show>
					<button class="primary" type="submit" disabled={agent.busy} title={agent.busy ? "The agent is still working on the last request. Stop this reply to send another." : "Send (Ctrl+Enter)"}>
						Send
					</button>
				</div>
			</form>
		</div>
	);
}
