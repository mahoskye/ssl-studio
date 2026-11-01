// The Agent panel: opencode status and model, the tidy sequence for the
// current file, and a conversation that can include the selection.
import { createSignal, For, Show } from "solid-js";
import { activeEditor } from "../editor/EditorGroup";
import { activeDoc, activePath, state } from "../state";
import { agent, ask, chooseModel, currentModel, interrupt, setAgent, start } from "./store";
import { notePath, runStep, startTidy, STEPS, tidy } from "./tidy";
import { backend } from "../backend";
import { baseName, relativeTo } from "../../shared/paths";

const ICON: Record<string, string> = { pending: "○", running: "◌", review: "◐", accepted: "●", rejected: "✗", unchanged: "–", failed: "!" };

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

export function AgentPanel() {
	const [draft, setDraft] = createSignal("");
	const [withSelection, setWithSelection] = createSignal(true);
	const send = () => {
		const q = draft().trim();
		if (!q) return;
		setDraft("");
		void askAbout(q, withSelection());
	};
	const modelLabel = (ref: string) => agent.models.find((m) => `${m.providerID}/${m.id}` === ref);
	return (
		<div class="panel-body agent">
			<div class="panel-title">
				<span>Agent</span>
				<Show when={agent.status.state === "ready"} fallback={<button onClick={() => void start()}>Start</button>}>
					<button title="Stop opencode" onClick={() => void backend.agent("stop", []).then((s: any) => setAgent("status", s))}>
						Stop
					</button>
				</Show>
			</div>
			<div class="agent-status">
				<span class={`dot ${agent.status.state}`} />
				<span>
					{agent.status.state === "ready" ? `opencode ${agent.status.version}` : agent.status.state === "starting" ? "Starting opencode…" : agent.status.state === "failed" ? "opencode failed" : state.info?.opencode.ok ? "opencode is not running" : "opencode not found"}
				</span>
			</div>
			<Show when={agent.status.message}>
				<p class="hint warn">{agent.status.message}</p>
			</Show>
			<Show when={agent.models.length}>
				<label class="agent-model">
					Model
					<select value={currentModel()} onChange={(e) => void chooseModel(e.currentTarget.value)}>
						<For each={agent.models.filter((m) => m.tools)}>
							{(m) => (
								<option value={`${m.providerID}/${m.id}`}>
									{m.local ? "" : "$ "}
									{m.name} · {m.providerID}
								</option>
							)}
						</For>
					</select>
				</label>
				<Show when={modelLabel(currentModel()) && !modelLabel(currentModel())!.local}>
					<p class="hint warn">Not a local model: prompts may cost money.</p>
				</Show>
			</Show>

			<section class="tidy">
				<div class="tidy-head">
					<strong>Tidy</strong>
					<span class="hint">{tidy.path ? baseName(tidy.path) : "the six ssl-tidy steps, reviewed one by one"}</span>
					<span class="spacer" />
					<button onClick={startTidy} disabled={!activeDoc() || agent.busy}>
						{tidy.path && tidy.path === activePath() ? "Restart" : "This file"}
					</button>
				</div>
				<Show when={tidy.path}>
					<For each={STEPS}>
						{(step, i) => (
							<div class={`tidy-step ${tidy.steps[i()]}`}>
								<span class="icon">{ICON[tidy.steps[i()]!]}</span>
								<span class="label">
									{i() + 1}. {step.title}
								</span>
								<span class="meta">{tidy.steps[i()]}</span>
								<button disabled={agent.busy || tidy.steps[i()] === "running" || tidy.steps[i()] === "review"} onClick={() => void runStep(i())}>
									{tidy.steps[i()] === "pending" ? "Run" : "Again"}
								</button>
							</div>
						)}
					</For>
					<p class="hint">Notes go to {relativeTo(state.workspace?.root, notePath(tidy.path!))}. Accepted steps are edits in the editor: save to keep them.</p>
				</Show>
			</section>

			<div class="conversation">
				<For each={agent.entries} fallback={<p class="hint">Ask about the selection, or run a tidy step. Shell, web and files outside the workspace are denied to the agent.</p>}>
					{(e) => (
						<div class={`entry ${e.role}`} classList={{ streaming: Boolean(e.streaming) }}>
							<pre>{e.text}</pre>
						</div>
					)}
				</For>
			</div>
			<form class="composer" onSubmit={(e) => (e.preventDefault(), send())}>
				<textarea
					placeholder="Ask about this code (Ctrl+Enter)"
					value={draft()}
					onInput={(e) => setDraft(e.currentTarget.value)}
					onKeyDown={(e) => e.key === "Enter" && (e.ctrlKey || e.metaKey) && (e.preventDefault(), send())}
				/>
				<div class="composer-bar">
					<label class="check">
						<input type="checkbox" checked={withSelection()} onChange={(e) => setWithSelection(e.currentTarget.checked)} /> include the selection
					</label>
					<span class="spacer" />
					<Show when={agent.busy}>
						<button type="button" onClick={() => void interrupt()}>
							Stop
						</button>
					</Show>
					<button type="button" title="Start a new conversation" onClick={() => setAgent("chatSession", null)}>
						New
					</button>
					<button class="primary" type="submit" disabled={agent.busy}>
						Send
					</button>
				</div>
			</form>
		</div>
	);
}
