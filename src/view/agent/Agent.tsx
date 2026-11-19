// The Agent panel: opencode status and model, the tidy sequence for the
// current file, and a conversation that can include the selection.
import { createEffect, createMemo, createSignal, For, onMount, Show } from "solid-js";
import { activeEditor } from "../editor/EditorGroup";
import { review } from "../editor/Review";
import { activeDoc, activePath, state } from "../state";
import { addEntry, agent, ask, chooseModel, currentModel, interrupt, resume, safely, setAgent, start, stop, type Entry } from "./store";
import { composerSend, modelRef, stepAction } from "./logic";
import { followReplyLink, renderReply } from "./markdown";
import { notePath, proposalOf, runStep, showReview, startTidy, STEPS, tidy } from "./tidy";
import { relativeTo } from "../../shared/paths";

const ICON: Record<string, string> = { pending: "○", running: "◌", review: "◐", accepted: "●", rejected: "✗", unchanged: "–", failed: "!" };
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

export async function askAbout(question: string, includeSelection: boolean) {
	const path = activePath();
	const context = includeSelection ? selectionContext() : null;
	const file = path ? relativeTo(state.workspace?.root, path) : "";
	const text = context
		? `${question}\n\nAbout this code from ${file}, ${context.label}:\n\`\`\`ssl\n${context.code}\n\`\`\`\n\nYou cannot read files in this session; answer from the code above.`
		: question;
	const reply = await ask(text, { title: "SSL Studio chat", keep: true, sessionID: agent.chatSession ?? undefined, show: context ? `${question}  (with ${file} ${context.label})` : question });
	if (reply) setAgent("chatSession", reply.sessionID);
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

/** Questions someone reading SSL they did not write tends to have. Each is sent with the selection, like any other. */
const STARTERS = ["Explain what this does, step by step.", "What could go wrong here, and with which input?", "Which cases should a test of this cover?", "Is anything here against the house style?"];

export function AgentPanel() {
	onMount(() => void resume());
	const [draft, setDraft] = createSignal("");
	/** The box the question is typed in, for a starter to hand the keyboard to. */
	let box: HTMLTextAreaElement | undefined;
	const [notSent, setNotSent] = createSignal("");
	const [withSelection, setWithSelection] = createSignal(true);
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
		void safely("The question was not sent", () => askAbout(result.send!, withSelection()));
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
					{agent.status.state === "ready" ? `opencode ${agent.status.version}` : agent.status.state === "starting" ? "Starting opencode…" : agent.status.state === "failed" ? "opencode failed" : state.info?.opencode.ok ? "opencode is not running" : "opencode not found"}
				</span>
			</div>
			<Show when={agent.status.message}>
				<p class="agent-note warn">{agent.status.message}</p>
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
						<For each={usable()}>
							{(m) => (
								<option value={modelRef(m)} selected={modelRef(m) === currentModel()}>
									{m.local ? "" : "$ "}
									{m.name} · {m.providerID}
								</option>
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
										<span class="icon" aria-hidden="true">
											{ICON[tidy.steps[i()]!]}
										</span>
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
