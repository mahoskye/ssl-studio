// The Agent panel: opencode status and model, the tidy sequence for the
// current file, and a conversation that can include the selection.
import { Icon, type IconName } from "../Icon";
import { Menu, type MenuItem } from "../Menu";
import { showPanel } from "../panels/registry";
import { createEffect, createMemo, createSignal, For, onCleanup, onMount, Show } from "solid-js";
import { activeEditor } from "../editor/EditorGroup";
import { activeLiveEditor } from "../editor/liveBridge";
import { review, openReview } from "../editor/Review";
import { activeDoc, activePath, applyText, canonical, documents, notify, state } from "../state";
import { addEntry, agent, ask, chooseModel, clearEntries, currentModel, interrupt, resume, safely, setAgent, start, stop, type Entry } from "./store";
import { groupModels, composeQuestion, composerSend, modelRef, stepAction } from "./logic";
import { followReplyLink, renderReply } from "./markdown";
import { notePath, proposalOf, runStep, showReview, startTidy, STEPS, tidy } from "./tidy";
import { baseName, isInside, relativeTo, resolvePath } from "../../shared/paths";
import { isCatalog, promptText, registryTitle } from "../../shared/projectDocs";
import type { DocFile } from "../../shared/protocol";
import { ticketForFile, type WorkTextOptions } from "../../shared/workContext";
import { backend } from "../backend";
import { choose } from "../dialogs";
import { docs } from "../project";
import { appendNoteToTicket, promoteToKnowledge, staleCatalogSummary, staleCatalogSummaryAsync, ticketAtHand, updateCatalogs, workPrompt } from "../projectDocs";
import { languageFor } from "../editor/languages";
import { recall, remember } from "../graph/canvas";

/** Pending draft handed into AgentPanel from another panel (e.g. stale catalog reconciliation). */
const [pendingDraft, setPendingDraft] = createSignal<{ text: string; cleanContext?: boolean; seq: number } | null>(null);
let draftSeq = 0;

/** Opens the Agent panel and pre-fills the composer box with `text` (never auto-sends). */
export function openAgentWithDraft(text: string, opts?: { cleanContext?: boolean }) {
	setPendingDraft({ text, cleanContext: opts?.cleanContext, seq: ++draftSeq });
	showPanel("agent");
}

// Module-level Agent context controls so `Ctrl+Shift+H` (`commands.ts`) and `AgentPanel` share the exact same selections.
const [withWork, setWithWork] = createSignal(recall("agent.withWork") !== "no");
const [pickedTicket, setPickedTicket] = createSignal<string | null>(null);
const [withSchema, setWithSchema] = createSignal(false);
const [withRegistries, setWithRegistries] = createSignal(false);
const [withState, setWithState] = createSignal(false);
const [attachedFiles, setAttachedFiles] = createSignal<{ path: string; rel: string }[]>([]);

/** Current ticket & extra-context options configured in the Agent panel (honored by `Ctrl+Shift+H` too). */
export function currentAgentContext(): { includeWork: boolean; ticket: string; workOptions: WorkTextOptions } {
	const picked = pickedTicket();
	const auto = ticketForFile(docs(), activePath(), state.workspace?.root) || ticketAtHand();
	const ticket = picked === null ? auto : picked;
	const includeWork = Boolean(ticket) && (picked !== null || withWork());
	return {
		includeWork,
		ticket,
		workOptions: {
			includeSchema: withSchema(),
			includeRegistries: withRegistries(),
			includeState: withState(),
			ticketFiles: attachedFiles(),
		},
	};
}

/** A step's state as a mark: not yet, under way, waiting to be looked at, taken, turned down, nothing to change, failed. */
const STEP_ICON: Record<string, IconName> = { pending: "circle-outline", running: "sync", review: "eye", accepted: "pass-filled", rejected: "close", unchanged: "dash", failed: "error" };
const NEW_CONVERSATION = "New conversation: the next question starts fresh. The agent will not see the earlier ones.";
/** How near the end of the conversation counts as "at the end", in pixels. */
const NEAR_END = 24;

/** The selection, or the procedure around the cursor when nothing is selected. */
export function selectionContext(): { label: string; code: string } | null {
	const live = activeLiveEditor();
	if (live) {
		const sel = live.getSelection();
		if (!sel.isEmpty()) return { label: `lines ${sel.startLineNumber}-${sel.endLineNumber}`, code: live.getSelectedText() };
		return null;
	}
	const editor = activeEditor();
	const model = editor?.getModel();
	if (!editor || !model) return null;
	const selection = editor.getSelection();
	if (selection && !selection.isEmpty()) return { label: `lines ${selection.startLineNumber}-${selection.endLineNumber}`, code: model.getValueInRange(selection) };
	return null;
}

/** Per-session tracker of already-sent context slices so toggling a chip mid-chat sends ONLY the delta. */
let sentContext: { session: string | null; keys: Set<string> } = { session: null, keys: new Set() };

async function readForPrompt(path: string): Promise<string | null> {
	const open = documents.get(canonical(path));
	if (open) return open.model.getValue();
	return backend.read(path).then((f) => f.text, () => null);
}

/** Builds standalone optional context blocks (Schema, Registries, STATE.md, attached files) even when no ticket is active. */
async function buildStandaloneExtras(
	workOpts: WorkTextOptions,
	alreadySent: ReadonlySet<string>,
): Promise<{ text: string; labels: string[]; addedKeys: string[] }> {
	const parts: string[] = [];
	const labels: string[] = [];
	const addedKeys: string[] = [];
	const all = docs().filter((d) => d.exists && !isCatalog(d));
	const cut = (s: string, max: number) => (s.length <= max ? s : `${s.slice(0, max)} … (cut short)`);

	if (workOpts.includeState && !alreadySent.has("state")) {
		const stDoc = all.find((d) => d.group === "project" && /^state\.md$/i.test(d.name));
		if (stDoc) {
			const txt = await readForPrompt(stDoc.path);
			if (txt?.trim()) {
				parts.push("PROJECT STATE (STATE.md):\n" + cut(txt.replace(/\r\n/g, "\n").trim(), 1800));
				labels.push("STATE.md");
				addedKeys.push("state");
			}
		}
	}
	if (workOpts.includeSchema && !alreadySent.has("schema")) {
		const schemas = all.filter((d) => d.group === "schema");
		if (schemas.length) {
			parts.push(
				"PROJECT SCHEMA (summary):\n" +
					schemas
						.slice(0, 25)
						.map((d) => `- ${d.title || d.name}${d.status ? ` (${d.status})` : ""}${d.summary ? `. ${d.summary}` : ""}`)
						.join("\n"),
			);
			labels.push("schema");
			addedKeys.push("schema");
		}
	}
	if (workOpts.includeRegistries && !alreadySent.has("registries:all")) {
		const regs = all.filter((d) => d.group === "registries" && /\.(csv|tsv)$/i.test(d.name));
		if (regs.length) {
			parts.push(
				"PROJECT REGISTRIES:\n" +
					regs
						.slice(0, 10)
						.map((d) => `- ${registryTitle(d.name)} (${d.rows ?? 0} rows)`)
						.join("\n"),
			);
			labels.push("registries");
			addedKeys.push("registries:all");
		}
	}
	for (const tf of workOpts.ticketFiles ?? []) {
		const k = `file:${canonical(tf.path)}`;
		if (alreadySent.has(k)) continue;
		const content = await readForPrompt(tf.path);
		if (content !== null) {
			parts.push(`ATTACHED FILE ${tf.rel}:\n${cut(content.replace(/\r\n/g, "\n"), 3500)}`);
			labels.push(baseName(tf.rel));
			addedKeys.push(k);
		}
	}
	return { text: parts.join("\n\n"), labels, addedKeys };
}

export async function askAbout(
	question: string,
	includeSelection: boolean,
	includeWork = false,
	extra?: { ticket?: string; workOptions?: WorkTextOptions },
) {
	const path = activePath();
	const context = includeSelection ? selectionContext() : null;
	const file = path ? relativeTo(state.workspace?.root, path) : "";
	const ticket = includeWork ? (extra?.ticket ?? (ticketForFile(docs(), path, state.workspace?.root) || ticketAtHand())) : "";
	const workOpts = extra?.workOptions ?? {};

	// Reset delta tracker whenever starting a brand-new conversation session.
	if (!agent.chatSession || sentContext.session !== agent.chatSession) {
		sentContext = { session: agent.chatSession, keys: new Set() };
	}

	const already = sentContext.keys;
	const ticketSent = Boolean(ticket && already.has(`ticket:${ticket.toLowerCase()}`));
	const newlyAddedKeys: string[] = [];
	let workBlock = "";
	const labelParts: string[] = [];

	if (ticket && !ticketSent) {
		const freshOpts: WorkTextOptions = {
			includeSchema: Boolean(workOpts.includeSchema) && !already.has("schema"),
			includeRegistries: Boolean(workOpts.includeRegistries) && !already.has(`registries:${ticket.toLowerCase()}`),
			includeState: Boolean(workOpts.includeState) && !already.has("state"),
			ticketFiles: (workOpts.ticketFiles ?? []).filter((f) => !already.has(`file:${canonical(f.path)}`)),
		};
		const work = await workPrompt(ticket, freshOpts);
		if (work) {
			workBlock = work.text;
			labelParts.push(work.label);
			newlyAddedKeys.push(`ticket:${ticket.toLowerCase()}`);
			if (freshOpts.includeSchema) newlyAddedKeys.push("schema");
			if (freshOpts.includeRegistries) newlyAddedKeys.push(`registries:${ticket.toLowerCase()}`);
			if (freshOpts.includeState) newlyAddedKeys.push("state");
			for (const f of freshOpts.ticketFiles ?? []) newlyAddedKeys.push(`file:${canonical(f.path)}`);
		}
	} else {
		// Mid-conversation delta or no-ticket standalone extras: send ONLY newly enabled extras without repeating the ticket!
		const delta = await buildStandaloneExtras(workOpts, already);
		if (delta.text) {
			workBlock = delta.text;
			labelParts.push(...delta.labels);
			newlyAddedKeys.push(...delta.addedKeys);
		}
	}

	const text = composeQuestion(question, context && { ...context, file }, workBlock || undefined);
	const withWhat = [context ? `${file} ${context.label}` : "", ...labelParts].filter(Boolean).join("; ");
	const isCatalogPrompt = /INDEX\.md|Update catalogs/i.test(question);
	const reply = await ask(text, {
		title: "SSL Studio chat",
		keep: true,
		sessionID: agent.chatSession ?? undefined,
		show: withWhat ? `${question}  (with ${withWhat})` : question,
		turn: {
			ticket: ticket || undefined,
			codePath: path && !/\.(md|markdown)$/i.test(path) ? path : undefined,
			isCatalogPrompt,
		},
	});
	if (reply) {
		setAgent("chatSession", reply.sessionID);
		if (sentContext.session !== reply.sessionID) {
			sentContext = { session: reply.sessionID, keys: new Set([...already, ...newlyAddedKeys]) };
		} else {
			for (const k of newlyAddedKeys) sentContext.keys.add(k);
		}
	}
}

/** Extracts the best fenced code/Markdown block (or full reply text) and opens side-by-side ReviewView against a workspace file. */
async function reviewProposedEdit(replyText: string, preferredPath?: string) {
	const root = state.workspace?.root;
	if (!root) return notify("Open a folder first.");
	const codeBlocks = [...replyText.replace(/\r\n/g, "\n").matchAll(/```[^\n]*\n([\s\S]*?)```/g)].map((m) => m[1]!).filter((s) => s.trim().length > 0);
	const proposed = (codeBlocks.length ? codeBlocks[codeBlocks.length - 1]! : replyText).trim() + "\n";

	const openCur = preferredPath || activePath() || "";
	const candidates: { label: string; path: string }[] = [];
	if (openCur && isInside(root, openCur)) {
		candidates.push({ label: `${relativeTo(root, openCur)} (active file)`, path: openCur });
	}
	const PICK_OTHER = "Choose another workspace file…";
	let targetPath = openCur;
	if (candidates.length) {
		const picked = await choose("Compare proposed reply against which file?", [candidates[0]!.label, PICK_OTHER]);
		if (!picked) return;
		if (picked === PICK_OTHER) targetPath = "";
	}
	if (!targetPath) {
		const files = await backend.files().catch(() => []);
		const rels = files.slice(0, 200).map((p) => relativeTo(root, p).replace(/\\/g, "/"));
		const chosen = await choose("Select workspace file to diff against", rels);
		if (!chosen) return;
		targetPath = resolvePath(root, chosen);
		if (!isInside(root, targetPath)) return;
	}

	const original = (await readForPrompt(targetPath)) ?? "";
	const rel = relativeTo(root, targetPath).replace(/\\/g, "/");
	openReview({
		title: `Agent proposal: ${rel}`,
		path: targetPath,
		original,
		proposed,
		language: languageFor(targetPath),
		effect: documents.get(canonical(targetPath))
			? `Accepting puts the right side into ${rel} as one undoable editor edit (not saved yet).`
			: `Accepting saves the right side to ${rel} on disk.`,
		onAccept: async (final) => {
			if (documents.get(canonical(targetPath))) {
				applyText(targetPath, final);
			} else {
				await backend.historyKeep(targetPath).catch(() => {});
				await backend.write(targetPath, final);
			}
			notify(`Applied reviewed edit to ${rel}.`);
		},
	});
}

/** One entry of the conversation. A reply is Markdown with 1-click actions to capture it into project docs or diff it in ReviewView. */
function EntryView(props: { entry: Entry }) {
	const html = createMemo(() => (props.entry.role === "agent" ? renderReply(props.entry.text) : ""));
	const entryTicket = () => props.entry.turn?.ticket;
	const entryCode = () => props.entry.turn?.codePath;
	const hasCatalogDrift = () => {
		if (!props.entry.turn?.isCatalogPrompt && !/INDEX\.md/i.test(props.entry.text)) return false;
		const { stale, missing } = staleCatalogSummary();
		return stale.length > 0 || missing.length > 0;
	};
	const copyReply = () => {
		void import("../commands").then((m) => m.copyText(props.entry.text, "Copied agent reply."));
	};
	return (
		<div class={`entry ${props.entry.role}`} classList={{ streaming: Boolean(props.entry.streaming) }} aria-busy={props.entry.streaming ? "true" : undefined}>
			<Show when={props.entry.role === "agent"} fallback={<pre>{props.entry.text}</pre>}>
				<div class="md" innerHTML={html()} onClick={(e) => void followReplyLink(e)} />
				<Show when={!props.entry.streaming && props.entry.text.trim()}>
					<div class="agent-reply-actions" role="group" aria-label="Capture reply">
						<button type="button" class="link" title="Copy reply as Markdown" onClick={copyReply}>
							Copy
						</button>
						<button type="button" class="link" title="Compare this reply against a workspace file in ReviewView before applying" onClick={() => void reviewProposedEdit(props.entry.text, entryCode())}>
							Review diff…
						</button>
						<Show when={hasCatalogDrift()}>
							<button type="button" class="link" title="Apply Update catalogs now (manual ADR 0031 reconciliation)" onClick={() => void updateCatalogs()}>
								Update catalogs
							</button>
						</Show>
						<button type="button" class="link" title="Save this reply as a Decision ADR" onClick={() => void promoteToKnowledge("decisions", { body: props.entry.text, ticket: entryTicket(), codePath: entryCode() })}>
							Save as Decision
						</button>
						<button type="button" class="link" title="Save this reply as a Question" onClick={() => void promoteToKnowledge("questions", { body: props.entry.text, ticket: entryTicket() })}>
							Save as Question
						</button>
						<button type="button" class="link" title="Save this reply as a Reference note" onClick={() => void promoteToKnowledge("reference", { body: props.entry.text, ticket: entryTicket() })}>
							Save as Note
						</button>
						<Show when={entryTicket()}>
							{(key) => (
								<button type="button" class="link" title={`Append this reply as a dated note on ${key()}`} onClick={() => void appendNoteToTicket(key(), props.entry.text)}>
									Append to {key()}
								</button>
							)}
						</Show>
					</div>
				</Show>
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
	createEffect(() => {
		const handed = pendingDraft();
		if (!handed) return;
		setPendingDraft(null);
		void (async () => {
			const existing = draft().trim();
			if (existing && existing !== handed.text.trim()) {
				const REPLACE = "Replace draft";
				const picked = await choose("Replace your current Agent draft?", [REPLACE, "Keep current"]);
				if (picked !== REPLACE) return;
			}
			if (handed.cleanContext) setWithSelection(false);
			setDraft(handed.text);
			setNotSent("");
			queueMicrotask(() => box?.focus());
		})();
	});
	const [notSent, setNotSent] = createSignal("");
	const [withSelection, setWithSelection] = createSignal(true);
	// The ticket at hand is read from the open document's text, which says nothing when it changes: this does.
	const [edited, setEdited] = createSignal(0);
	createEffect(() => {
		const listener = activeDoc()?.model.onDidChangeContent(() => setEdited((n) => n + 1));
		onCleanup(() => listener?.dispose());
	});
	const autoTicket = createMemo(() => (edited(), ticketForFile(docs(), activePath(), state.workspace?.root) || ticketAtHand()));
	const allTickets = createMemo(() =>
		docs()
			.filter((d) => d.exists && d.group === "tickets" && d.ticket)
			.sort((a, b) => (a.ticket ?? "").localeCompare(b.ticket ?? "", undefined, { numeric: true })),
	);
	const ticket = createMemo(() => {
		const picked = pickedTicket();
		return picked === null ? autoTicket() : picked;
	});
	const activeTicketDoc = createMemo(() => {
		const key = ticket();
		return key ? allTickets().find((d) => d.ticket?.toLowerCase() === key.toLowerCase()) : undefined;
	});
	// Live pre-send token & size estimate (approx 1 token ≈ 4 chars) so local-model context budgets stay visible before hitting Send.
	const preSendEstimate = createMemo(() => {
		edited();
		let chars = draft().length;
		const parts: string[] = [];
		if (draft().trim()) parts.push(`prompt (~${Math.ceil(draft().length / 4)} tok)`);
		if (withSelection()) {
			const sel = selectionContext();
			if (sel?.code) {
				chars += sel.code.length;
				parts.push(`selection (~${Math.ceil(sel.code.length / 4)} tok)`);
			}
		}
		const targetTicket = ticket();
		const sendingWork = Boolean(targetTicket) && (pickedTicket() !== null || withWork());
		if (sendingWork) {
			chars += 2400;
			parts.push(`${targetTicket} work (~600 tok)`);
		}
		if (withSchema()) {
			chars += 900;
			parts.push("schema (~225 tok)");
		}
		if (withRegistries()) {
			chars += 800;
			parts.push("registries (~200 tok)");
		}
		if (withState()) {
			chars += 1200;
			parts.push("STATE.md (~300 tok)");
		}
		for (const f of attachedFiles()) {
			chars += 2000;
			parts.push(`${baseName(f.rel)} (~500 tok)`);
		}
		const tokens = Math.ceil(chars / 4);
		return { tokens, chars, summary: parts.length ? parts.join(" + ") : "No context attached yet" };
	});
	const pickContextFile = async () => {
		const root = state.workspace?.root;
		if (!root) return notify("Open a folder first.");
		const already = new Set(attachedFiles().map((f) => canonical(f.path)));
		const ticketFiles = (activeTicketDoc()?.ticketFiles ?? []).filter((f) => !already.has(canonical(f.path)));
		const BROWSE_ALL = "Pick any workspace file…";
		if (ticketFiles.length) {
			const picked = await choose(
				`Attach a file from ${ticket()}'s folder (or any workspace file)`,
				[...ticketFiles.map((f) => f.rel), BROWSE_ALL],
			);
			if (!picked) return;
			if (picked !== BROWSE_ALL) {
				const hit = ticketFiles.find((f) => f.rel === picked);
				if (hit) setAttachedFiles((prev) => [...prev, hit]);
				return;
			}
		}
		const allWs = (await backend.files().catch(() => [])).filter((p) => !already.has(canonical(p)));
		if (!allWs.length) return notify("No additional workspace files available to attach.");
		const rels = allWs.slice(0, 250).map((p) => relativeTo(root, p).replace(/\\/g, "/"));
		const picked = await choose("Attach a workspace file to the next prompt", rels);
		if (!picked) return;
		const full = resolvePath(root, picked);
		if (isInside(root, full)) setAttachedFiles((prev) => [...prev, { path: full, rel: picked }]);
	};
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
		const targetTicket = ticket();
		const sendWork = Boolean(targetTicket) && (pickedTicket() !== null || withWork());
		void safely("The question was not sent", () =>
			askAbout(result.send!, withSelection(), sendWork, {
				ticket: targetTicket,
				workOptions: {
					includeSchema: withSchema(),
					includeRegistries: withRegistries(),
					includeState: withState(),
					ticketFiles: attachedFiles(),
				},
			}),
		);
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
	const clearConversation = () => {
		sentContext = { session: null, keys: new Set() };
		clearEntries();
	};
	const loadKeptPrompt = (file: DocFile) => {
		void wordsOf(file).then(
			(words) => (words ? (setDraft(words), setNotSent(""), box?.focus()) : notify(`${file.title || file.name} has no words in it yet.`)),
			(e) => notify(String(e?.message ?? e), "error"),
		);
	};
	const promptMenuItems = (): MenuItem[] => {
		const items: MenuItem[] = [];
		const kept = keptPrompts();
		if (kept.length) {
			for (const file of kept) items.push({ label: file.title || file.name, run: () => loadKeptPrompt(file) });
			items.push("separator");
		}
		const { stale, missing } = staleCatalogSummary();
		const totalCat = stale.length + missing.length;
		if (totalCat) {
			items.push({
				label: `Reconcile ${totalCat === 1 ? "1 out-of-sync index" : `${totalCat} out-of-sync indexes`}`,
				run: () =>
					void staleCatalogSummaryAsync().then(({ prompt }) => {
						if (!prompt) return;
						setWithSelection(false);
						setDraft(prompt);
						setNotSent("");
						box?.focus();
					}),
			});
			items.push("separator");
		}
		for (const text of STARTERS) items.push({ label: text, run: () => (setDraft(text), setNotSent(""), box?.focus()) });
		return items;
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
		<div class="panel-body agent" data-panel="agent">
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
				<Show when={allTickets().length > 0}>
					<div class="agent-context-bar">
						<label class="agent-ticket-picker" title="Choose which ticket's context (specs, decisions, open questions) goes with your question">
							<span class="agent-ticket-label">Ticket:</span>
							<select
								class="agent-ticket-select"
								aria-label="Ticket context for the agent"
								value={pickedTicket() === null ? "__auto__" : pickedTicket()!}
								onChange={(e) => {
									const v = e.currentTarget.value;
									if (v === "__auto__") {
										setPickedTicket(null);
										setWithWork(true);
										remember("agent.withWork", "yes");
									} else if (v === "") {
										setPickedTicket("");
										setWithWork(false);
										remember("agent.withWork", "no");
									} else {
										setPickedTicket(v);
										setWithWork(true);
										remember("agent.withWork", "yes");
									}
								}}
							>
								<option value="__auto__">Auto{autoTicket() ? ` (${autoTicket()})` : " (none)"}</option>
								<option value="">None</option>
								<For each={allTickets()}>
									{(t) => (
										<option value={t.ticket!}>
											{t.ticket}
											{t.title ? ` — ${t.title.slice(0, 32)}` : ""}
										</option>
									)}
								</For>
							</select>
						</label>
						<Show when={pickedTicket() === null && autoTicket()}>
							<label class="check agent-work-toggle" title={`Include ${autoTicket()} context on the first turn`}>
								<input
									type="checkbox"
									checked={withWork()}
									onChange={(e) => (setWithWork(e.currentTarget.checked), remember("agent.withWork", e.currentTarget.checked ? "yes" : "no"))}
								/>
								<span>send</span>
							</label>
						</Show>
					</div>
				</Show>
				<Show when={Boolean(state.workspace)}>
					<div class="agent-ctx-chips" role="group" aria-label="Optional extra project context">
						<button
							type="button"
							class="agent-ctx-chip"
							classList={{ active: withSchema() }}
							aria-pressed={withSchema()}
							title="Include project schema summaries in the next turn"
							onClick={() => setWithSchema((v) => !v)}
						>
							+ Schema
						</button>
						<button
							type="button"
							class="agent-ctx-chip"
							classList={{ active: withRegistries() }}
							aria-pressed={withRegistries()}
							title={ticket() ? `Include CSV registry rows mentioning ${ticket()}` : "Include project CSV registry summary"}
							onClick={() => setWithRegistries((v) => !v)}
						>
							+ Registries
						</button>
						<button
							type="button"
							class="agent-ctx-chip"
							classList={{ active: withState() }}
							aria-pressed={withState()}
							title="Include project STATE.md summary"
							onClick={() => setWithState((v) => !v)}
						>
							+ STATE.md
						</button>
						<button
							type="button"
							class="agent-ctx-chip"
							title={activeTicketDoc()?.ticketFiles?.length ? `Attach a file from ${ticket()}'s folder or anywhere in the workspace` : "Attach a workspace file to the next prompt"}
							onClick={() => void pickContextFile()}
						>
							+ File…
						</button>
						<For each={attachedFiles()}>
							{(tf) => (
								<button
									type="button"
									class="agent-ctx-chip active"
									title={`Remove ${tf.rel} from prompt context`}
									onClick={() => setAttachedFiles((prev) => prev.filter((x) => x.path !== tf.path))}
								>
									<span>{tf.rel.split("/").pop()}</span>
									<Icon name="close" />
								</button>
							)}
						</For>
					</div>
				</Show>
				<div class="composer-bar">
					<button type="button" aria-label="Start a new conversation" disabled={agent.busy} title={agent.busy ? "Wait for this reply, or stop it, before starting a new conversation." : "Start a new conversation: the agent will not see the earlier questions"} onClick={newConversation}>
						New
					</button>
					<Show when={agent.entries.length > 0}>
						<button type="button" aria-label="Clear conversation" disabled={agent.busy} title="Clear conversation history and return to starter prompts" onClick={clearConversation}>
							Clear
						</button>
					</Show>
					<Menu floating label="Insert a project prompt or starter question" title="Prompts kept in this project and starter questions" items={promptMenuItems}>
						Prompts
					</Menu>
					<span class="spacer" />
					<Show when={preSendEstimate().tokens > 0}>
						<span class="agent-token-meter" title={`Estimated next-turn context: ${preSendEstimate().summary}`}>
							~{preSendEstimate().tokens} tok
						</span>
					</Show>
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
