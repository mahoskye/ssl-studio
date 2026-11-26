// The Agent panel: opencode status and model, the tidy sequence for the
// current file, and a conversation that can include the selection.
import { Icon, type IconName } from "../Icon";
import { Menu, type MenuItem } from "../Menu";
import { showPanel } from "../panels/registry";
import { createEffect, createMemo, createSignal, createStore, For, onCleanup, onSettled, Show, snapshot, untrack } from "solid-js";
import { createAsyncQuery } from "../asyncQuery";
import { activeEditor } from "../editor/EditorGroup";
import { activeLiveEditor, liveSelectionVersion } from "../editor/liveBridge";
import type { monaco } from "../editor/monaco";
import { searchableText, searchableTextNow } from "../lsp/facts";
import { review, openReview, type Check } from "../editor/Review";
import { activeDoc, activePath, applyText, canonical, documents, notify, openFile, save, scriptsCameTo, setState, state } from "../state";
import { agent, ask, chatSessionEpoch, chooseModel, clearEntries, clearSavedThreads, currentModel, interrupt, isSessionBreak, resume, safely, setAgent, start, startNewThread, stop, switchThread, syncWorkspaceThreads, type Entry } from "./store";
import {
	applySimpleUnifiedDiff,
	composeQuestion,
	composerSend,
	createContextAccumulator,
	extractFencedBlocks,
	groupModels,
	modelRef,
	stepAction,
	type FencedBlock,
	type PreparedContextResult,
} from "./logic";
import { followReplyLink, renderReply } from "./markdown";
import { notePath, proposalOf, runStep, showReview, startTidy, STEPS, tidy } from "./tidy";
import { isAllowedContextPath } from "../plan/assist";
import { parseCsv } from "../../shared/csv";
import { checkTables } from "../../shared/docTables";
import { frontMatter, many, withFrontMatter } from "../../shared/frontMatter";
import { extractPlanTestCasesFromMarkdown, formatAgentThreadMarkdown, planMarkdownReviewExtraction, type ExtractedPlanTestCase } from "../../shared/menuBar";
import { baseName, dirName, isInside, joinPath, relativeTo } from "../../shared/paths";
import { summarizePlanForPrompt } from "../../shared/planSummary";
import { DOC_FOLDERS, frontValue, isCatalog, promptText, registryTitle, slug } from "../../shared/projectDocs";
import type { DocFile } from "../../shared/protocol";
import { keysIn, ticketColumn } from "../../shared/registryTickets";
import { extractSchemaPreview, referencedSchemaTables } from "../../shared/schemaIndex";
import { renderTemplate } from "../../shared/templater";
import { cut, docsGoverningFile, MAX_WORK_PROMPT_CHARS, ticketAtHand as listedTicketAtHand, ticketForFile, ticketWork, workFor, type WorkTextOptions } from "../../shared/workContext";
import { backend } from "../backend";
import { ask as askDialog, browseWorkspaceFile, choose, quickPick, quickPickMany } from "../dialogs";
import { refreshDocAudit } from "../docAudit";
import { gitStatus, gitVersion } from "../git";
import { addPlanTest, parsePlan, planTestsOf, printPlan } from "../plan/model";
import { docs } from "../project";
import { appendNoteToTicket, promoteToKnowledge, saveAsSnippet, staleCatalogSummary, staleCatalogSummaryAsync, ticketAtHand, updateCatalogs, workPrompt } from "../projectDocs";
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

/** Attaches a workspace text file to the next Agent turn context and focuses the Agent panel. */
export function attachFileToAgent(path: string) {
	ensureAgentWorkspace();
	const root = snapshot(state).workspace?.root;
	if (!root || !isInside(root, path)) return notify("That file is not in this workspace.", "error");
	const rel = relativeTo(root, path).replace(/\\/g, "/");
	if (!isAllowedContextPath(rel)) return notify("Hidden files and dotfiles cannot be attached to Agent context.", "error");
	const key = canonical(path);
	setAgentCtx((s) => {
		if (!s.attachedFiles.some((f) => canonical(f.path) === key)) {
			s.attachedFiles.push({ path, rel });
		}
	});
	showPanel("agent");
	notify(`Attached ${baseName(path)} to Agent context.`);
}

// Module-level Agent context controls so `Ctrl+Shift+H` (`commands.ts`) and `AgentPanel` share the exact same selections.
const [withWork, setWithWork] = createSignal(recall("agent.withWork") !== "no");
type AgentContextState = {
	root: string | null;
	pickedTicket: string | null;
	withSchema: boolean;
	withRefTables: boolean;
	withRegistries: boolean;
	withState: boolean;
	withGitDiff: boolean;
	withGoverningDocs: boolean;
	attachedFiles: { path: string; rel: string }[];
};
const [agentCtx, setAgentCtx] = createStore<AgentContextState>({
	root: null,
	pickedTicket: null,
	withSchema: false,
	withRefTables: false,
	withRegistries: false,
	withState: false,
	withGitDiff: false,
	withGoverningDocs: false,
	attachedFiles: [],
});
const [sentTick, setSentTick] = createSignal(0);
/** Synchronous preparing lock held across async context assembly before `ask()` sets `agent.busy`. */
const [preparing, setPreparing] = createSignal(false);
let preparingLock = false;

const CODE_FILE_RE = /\.(ssl|srvscr|ds|sql|ddl|pks|pkb|xfd|xml|js|ts|css|html)$/i;

/** Per-session tracker of already-sent context slices (key -> contentHash) so unchanged context is skipped and edited context re-sends cleanly. */
let sentContext: { session: string | null; root: string | null; hashes: Map<string, string> } = {
	session: null,
	root: null,
	hashes: new Map(),
};
let lastWorkspaceRoot: string | null = null;

/** Resets all workspace-scoped Agent context & session state whenever the user opens a different folder. */
function ensureAgentWorkspace(): boolean {
	const rawRoot = snapshot(state).workspace?.root;
	const curRoot = rawRoot ? canonical(rawRoot) : null;
	if (curRoot === lastWorkspaceRoot) return false;
	lastWorkspaceRoot = curRoot;
	setAgentCtx((s) => {
		s.root = curRoot;
		s.pickedTicket = null;
		s.withSchema = false;
		s.withRefTables = false;
		s.withRegistries = false;
		s.withState = false;
		s.withGitDiff = false;
		s.withGoverningDocs = false;
		s.attachedFiles = [];
	});
	sentContext = { session: null, root: curRoot, hashes: new Map() };
	syncWorkspaceThreads(curRoot);
	setSentTick((n) => n + 1);
	return true;
}

/** Auto-detected ticket (reactive): explicit workspace activeTicket > file-specific ticket > single in-progress ticket. */
function resolvedAutoTicket(): string {
	return state.settings.activeTicket?.trim() || ticketForFile(docs(), activePath(), state.workspace?.root) || ticketAtHand();
}

/** Auto-detected ticket (imperative): reads unflushed `snapshot(state)` so workspace/tab/setting switches are seen immediately. */
function resolvedAutoTicketNow(): string {
	const cur = snapshot(state);
	const root = cur.workspace?.root;
	const curPath = cur.groups[cur.activeGroup]?.active ?? null;
	const explicit = cur.settings.activeTicket?.trim();
	if (explicit) return explicit;
	const allDocs = untrack(docs);
	const scopedDocs = root ? allDocs.filter((d) => isInside(root, d.path)) : allDocs;
	const byFile = ticketForFile(scopedDocs, curPath, root);
	if (byFile) return byFile;
	if (curPath) {
		const openDoc = documents.get(curPath);
		if (openDoc && !openDoc.binary) {
			if (curPath.toLowerCase().endsWith(".plan.json")) {
				const t = parsePlan(openDoc.model.getValue()).plan?.ticket;
				if (typeof t === "string" && t.trim()) return t.trim();
			} else if (/\.(md|markdown)$/i.test(curPath)) {
				const { values } = frontMatter(openDoc.model.getValue());
				const fromOpen = many(values.ticket)[0] ?? many(values.tickets)[0] ?? "";
				if (fromOpen) return fromOpen;
			}
		}
	}
	return listedTicketAtHand(scopedDocs, curPath);
}

/** Current ticket & extra-context options configured in the Agent panel (honored by `Ctrl+Shift+H` too). */
export function currentAgentContext(): { includeWork: boolean; ticket: string; workOptions: WorkTextOptions } {
	ensureAgentWorkspace();
	const ctx = snapshot(agentCtx);
	const picked = ctx.pickedTicket;
	const auto = resolvedAutoTicketNow();
	const ticket = picked === null ? auto : picked;
	const includeWork = Boolean(ticket) && (picked !== null || untrack(withWork));
	const root = snapshot(state).workspace?.root ?? "";
	const safeFiles = !root
		? []
		: ctx.attachedFiles.filter((f) => isInside(root, f.path) && isAllowedContextPath(relativeTo(root, f.path)));
	return {
		includeWork,
		ticket,
		workOptions: {
			includeSchema: ctx.withSchema,
			includeRegistries: ctx.withRegistries,
			includeState: ctx.withState,
			ticketFiles: safeFiles,
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

/**
 * Where the names of tables are looked for: the selection where there is one, as `selectionContext` finds it, and
 * the whole of the document if not. A Markdown editor gives its text as it is; a code editor gives its model, so
 * that the text can be read without its comments (`searchableText`: a table named only in a comment is not used).
 */
function tableSearchPlace(doc: { model: monaco.editor.ITextModel; binary?: unknown } | undefined): { text: string } | { model: monaco.editor.ITextModel; selection: monaco.Selection | null } | null {
	const live = activeLiveEditor();
	if (live) {
		if (!live.getSelection().isEmpty()) return { text: live.getSelectedText() };
	} else {
		const editor = activeEditor();
		const model = editor?.getModel();
		const selection = editor?.getSelection();
		if (model && selection && !selection.isEmpty()) return { model, selection };
	}
	return doc && !doc.binary ? { model: doc.model, selection: null } : null;
}

async function readForPrompt(path: string): Promise<string | null> {
	const root = snapshot(state).workspace?.root;
	if (!root || !isInside(root, path)) return null;
	const rel = relativeTo(root, path).replace(/\\/g, "/");
	if (!isAllowedContextPath(rel)) return null;
	const open = documents.get(canonical(path));
	if (open) return open.model.getValue();
	return backend.read(path).then((f) => (f.binary ? null : f.text), () => null);
}

/** Builds ticket-filtered registry rows when a ticket is active, or a compact registry index when standalone. */
async function buildRegistrySlice(all: DocFile[], ticketKey: string): Promise<string> {
	const regs = all.filter((d) => d.group === "registries" && /\.(csv|tsv)$/i.test(d.name));
	if (!regs.length) return "";
	if (ticketKey) {
		const ticketLower = ticketKey.toLowerCase();
		const knownSet = new Set([ticketLower]);
		const parts: string[] = [];
		for (const reg of regs) {
			const csvText = await readForPrompt(reg.path);
			if (!csvText) continue;
			const parsed = parseCsv(csvText);
			const tCol = ticketColumn(parsed);
			if (tCol < 0) continue;
			const matched = parsed.rows.filter((cells) =>
				keysIn(cells[tCol]?.text ?? "", knownSet).some((k) => k.toLowerCase() === ticketLower),
			);
			if (!matched.length) continue;
			const headers = parsed.header.map((c) => c.text.trim());
			parts.push(
				`REGISTRY ${registryTitle(reg.name)} (rows for ${ticketKey}):\n` +
					headers.join(" | ") +
					"\n" +
					matched.slice(0, 15).map((r) => headers.map((_, i) => (r[i]?.text ?? "").replace(/\s+/g, " ")).join(" | ")).join("\n") +
					(matched.length > 15 ? `\n… and ${matched.length - 15} more rows` : ""),
			);
		}
		if (parts.length) return parts.join("\n\n");
	}
	return (
		"PROJECT REGISTRIES:\n" +
		regs
			.slice(0, 10)
			.map((d) => `- ${registryTitle(d.name)} (${d.rows ?? 0} rows)`)
			.join("\n") +
		(regs.length > 10 ? `\n- … and ${regs.length - 10} more registries` : "")
	);
}

type GoverningContextItem = {
	file: DocFile;
	reason: string;
	forFiles: string[];
};

/**
 * Collects unique governing docs (`docsGoverningFile()`) for the active code/SQL file and
 * modified Git code/SQL files — even when they belong to another ticket or when no ticket is active.
 */
function collectGoverningDocsForContext(
	allDocs: readonly DocFile[],
	root: string,
	activeFile: string | null | undefined,
	gitStatusOverride?: ReturnType<typeof gitStatus>,
): GoverningContextItem[] {
	if (!root) return [];
	const candidates: string[] = [];
	const seenCode = new Set<string>();
	const addCode = (p?: string | null) => {
		if (!p || !isInside(root, p)) return;
		const k = canonical(p);
		if (seenCode.has(k)) return;
		seenCode.add(k);
		candidates.push(p);
	};
	if (activeFile && CODE_FILE_RE.test(activeFile)) addCode(activeFile);
	const st = gitStatusOverride !== undefined ? gitStatusOverride : gitStatus();
	if (st) {
		for (const f of st.files) {
			if (CODE_FILE_RE.test(f.path)) addCode(f.path);
		}
	}
	if (!candidates.length && activeFile) addCode(activeFile);

	const byDoc = new Map<string, GoverningContextItem>();
	for (const codePath of candidates) {
		const relCode = relativeTo(root, codePath).replace(/\\/g, "/");
		for (const g of docsGoverningFile(allDocs, codePath, root)) {
			const dk = canonical(g.file.path);
			const prev = byDoc.get(dk);
			if (!prev) {
				byDoc.set(dk, { file: g.file, reason: g.reason, forFiles: [relCode] });
			} else if (!prev.forFiles.includes(relCode)) {
				prev.forFiles.push(relCode);
			}
		}
	}
	return [...byDoc.values()].slice(0, 6);
}

function formatGoverningDocExcerpt(doc: DocFile, raw: string): string {
	const clean = raw.replace(/\r\n/g, "\n").trim();
	if (doc.path.toLowerCase().endsWith(".plan.json")) {
		return summarizePlanForPrompt(clean) ?? cut(clean, 1400);
	}
	const body = frontMatter(clean).body.trim();
	return cut(body || clean, 1800);
}

function wrapDiffFence(body: string): string {
	let ticks = 3;
	for (const m of body.matchAll(/`{3,}/g)) {
		if (m[0].length >= ticks) ticks = m[0].length + 1;
	}
	const fence = "`".repeat(ticks);
	return `${fence}diff\n${body}\n${fence}`;
}

/** Fetches compact staged + unstaged unified diff via `backend.gitDiff` (falling back cleanly outside git). */
async function buildGitDiffSlice(): Promise<string> {
	const [stagedDiff, unstagedDiff] = await Promise.all([
		backend.gitDiff({ staged: true, maxBytes: 24000 }).catch(() => ""),
		backend.gitDiff({ maxBytes: 24000 }).catch(() => ""),
	]);
	const chunks: string[] = [];
	if (stagedDiff.trim()) chunks.push(`STAGED GIT DIFF:\n${wrapDiffFence(cut(stagedDiff.trim(), 5500))}`);
	if (unstagedDiff.trim()) chunks.push(`UNSTAGED GIT DIFF:\n${wrapDiffFence(cut(unstagedDiff.trim(), 5500))}`);
	if (!chunks.length) return "";
	return cut(chunks.join("\n\n"), 9500);
}

type PreparedContext = PreparedContextResult;
type ExtraContextFlags = {
	withGitDiff: boolean;
	withGoverningDocs: boolean;
	withRefTables: boolean;
};

type PreparedContextSnapshot = {
	root?: string;
	allDocs?: readonly DocFile[];
	activePath?: string | null;
	activeDoc?: ReturnType<typeof activeDoc>;
	gitStatus?: ReturnType<typeof gitStatus>;
};

/**
 * Computes the exact pending context delta (ticket work, Git diff, governing docs, schema,
 * referenced tables, registries, STATE.md, attached files) with content-hash change detection
 * and incremental `MAX_WORK_PROMPT_CHARS` budgeting so slices that don't fit are never marked sent.
 */
async function prepareContextDelta(
	ticket: string,
	workOpts: WorkTextOptions,
	alreadySent: ReadonlyMap<string, string>,
	flags: ExtraContextFlags = (() => {
		const ctx = snapshot(agentCtx);
		return {
			withGitDiff: ctx.withGitDiff,
			withGoverningDocs: ctx.withGoverningDocs,
			withRefTables: ctx.withRefTables,
		};
	})(),
	contextSnapshot?: PreparedContextSnapshot,
): Promise<PreparedContext> {
	const curState = snapshot(state);
	const root = contextSnapshot?.root ?? (curState.workspace?.root ?? "");
	const all = (contextSnapshot?.allDocs ?? untrack(docs)).filter((d) => d.exists && !isCatalog(d));
	const activePathNow = contextSnapshot !== undefined ? (contextSnapshot.activePath ?? null) : (curState.groups[curState.activeGroup]?.active ?? null);
	const activeDocNow = contextSnapshot !== undefined ? contextSnapshot.activeDoc : (activePathNow ? documents.get(activePathNow) : undefined);
	const gitStatusNow = contextSnapshot !== undefined ? contextSnapshot.gitStatus : untrack(gitStatus);
	const { addSlice, finish } = createContextAccumulator(alreadySent, MAX_WORK_PROMPT_CHARS, cut);

	// 1. Core ticket work (without standalone toggles so each slice is independently hash-tracked across Turn 1 and Turn 2+).
	const sentByTicket = new Set<string>();
	if (ticket) {
		const work = await untrack(() => workPrompt(ticket, { includeSchema: false, includeRegistries: false, includeState: false, ticketFiles: [] }));
		if (work) {
			if (addSlice(`ticket:${ticket.toLowerCase()}`, work.label, work.text)) {
				const wf = workFor(all, ticket);
				if (wf) {
					sentByTicket.add(canonical(wf.ticket.path));
					for (const s of wf.specs) sentByTicket.add(canonical(s.path));
					for (const p of wf.plans ?? []) sentByTicket.add(canonical(p.path));
				}
			}
		}
	}

	// 1b. Compact staged + unstaged Git diff (Wave 1.4).
	if (flags.withGitDiff) {
		const diffText = await buildGitDiffSlice();
		if (diffText) addSlice("git-diff", "git diff", diffText);
	}

	// 1c. Governing docs for active / changed code & SQL files (even across tickets or with Ticket=None).
	if (flags.withGoverningDocs && root) {
		const govItems = collectGoverningDocsForContext(all, root, activePathNow, gitStatusNow);
		for (const item of govItems) {
			const dk = canonical(item.file.path);
			if (sentByTicket.has(dk)) continue;
			const raw = await readForPrompt(item.file.path);
			if (raw === null) continue;
			const rel = relativeTo(root, item.file.path).replace(/\\/g, "/");
			const excerpt = formatGoverningDocExcerpt(item.file, raw);
			if (!excerpt) continue;
			addSlice(
				`gov:${dk}`,
				baseName(item.file.path),
				`GOVERNING DOC ${rel} (${item.reason}, for ${item.forFiles.slice(0, 3).join(", ")}):\n${excerpt}`,
			);
		}
	}

	// 2. STATE.md
	if (workOpts.includeState) {
		const stDoc = all.find((d) => d.group === "project" && /^state\.md$/i.test(d.name));
		if (stDoc) {
			const txt = await readForPrompt(stDoc.path);
			if (txt?.trim()) {
				addSlice("state", "STATE.md", "PROJECT STATE (STATE.md):\n" + cut(txt.replace(/\r\n/g, "\n").trim(), 1800));
			}
		}
	}

	// 3. Project Schema (with overflow notice past 25)
	if (workOpts.includeSchema) {
		const schemas = all.filter((d) => d.group === "schema");
		if (schemas.length) {
			const shown = schemas.slice(0, 25);
			const more = schemas.length - shown.length;
			const schemaText =
				"PROJECT SCHEMA (summary):\n" +
				shown.map((d) => `- ${d.title || d.name}${d.status ? ` (${d.status})` : ""}${d.summary ? `. ${d.summary}` : ""}`).join("\n") +
				(more > 0 ? `\n- … and ${more} more schema docs` : "");
			addSlice("schema", "schema", schemaText);
		}
	}

	// 3b. Targeted schema column tables referenced in the active SSL/SQL editor or selection (Wave 3.1).
	if (flags.withRefTables) {
		const place = tableSearchPlace(activeDocNow);
		const activeModelText = !place ? "" : "text" in place ? place.text : await searchableText(place.model, place.selection);
		const refTables = referencedSchemaTables(activeModelText, all, 6);
		if (refTables.length) {
			const blocks: string[] = [];
			for (const tDoc of refTables) {
				const raw = await readForPrompt(tDoc.path);
				if (raw !== null) {
					blocks.push(`### ${tDoc.title || tDoc.name}\n${extractSchemaPreview(tDoc, raw, 24)}`);
				}
			}
			if (blocks.length) {
				addSlice(
					`refTables:${refTables.map((d) => canonical(d.path)).join(",")}`,
					`${refTables.length} table ${refTables.length === 1 ? "schema" : "schemas"}`,
					`REFERENCED SCHEMA TABLES (columns):\n${cut(blocks.join("\n\n"), 4500)}`,
				);
			}
		}
	}

	// 4. Project Registries (unified across Turn 1 and Turn 2+: ticket-filtered rows when a ticket is active!).
	if (workOpts.includeRegistries) {
		const regKey = ticket ? `registries:${ticket.toLowerCase()}` : "registries:all";
		const regText = await buildRegistrySlice(all, ticket);
		if (regText) addSlice(regKey, "registries", regText);
	}

	// 5. Attached files (strictly guarded inside the active workspace root and excluding hidden dotfiles).
	for (const tf of workOpts.ticketFiles ?? []) {
		if (!root || !isInside(root, tf.path) || !isAllowedContextPath(relativeTo(root, tf.path))) continue;
		const content = await readForPrompt(tf.path);
		if (content !== null) {
			addSlice(
				`file:${canonical(tf.path)}`,
				baseName(tf.rel),
				`ATTACHED FILE ${tf.rel}:\n${cut(content.replace(/\r\n/g, "\n"), 3500)}`,
			);
		}
	}

	return finish();
}

async function runAskAbout(
	question: string,
	includeSelection: boolean,
	includeWork = false,
	extra?: { ticket?: string; workOptions?: WorkTextOptions },
) {
	ensureAgentWorkspace();
	const curState = snapshot(state);
	const path = curState.groups[curState.activeGroup]?.active ?? null;
	const root = curState.workspace?.root ?? "";
	const ctx = snapshot(agentCtx);
	const context = includeSelection ? selectionContext() : null;
	const file = path ? relativeTo(root, path) : "";
	const ticket = includeWork ? (extra?.ticket ?? resolvedAutoTicketNow()) : "";
	const workOpts = extra?.workOptions ?? {};

	// Reset delta tracker whenever starting a brand-new conversation session or switching workspaces.
	const curRoot = root ? canonical(root) : null;
	const sameWorkspace = () => {
		const r = snapshot(state).workspace?.root;
		return (r ? canonical(r) : null) === curRoot;
	};
	const chatSession = snapshot(agent).chatSession;
	const chatEpoch = chatSessionEpoch();
	if (!chatSession || sentContext.session !== chatSession || sentContext.root !== curRoot) {
		sentContext = { session: chatSession, root: curRoot, hashes: new Map() };
	}

	const prepared = await prepareContextDelta(
		ticket,
		workOpts,
		sentContext.hashes,
		{
			withGitDiff: ctx.withGitDiff,
			withGoverningDocs: ctx.withGoverningDocs,
			withRefTables: ctx.withRefTables,
		},
		{
			root,
			allDocs: untrack(docs),
			activePath: path,
			activeDoc: path ? documents.get(path) : undefined,
			gitStatus: untrack(gitStatus),
		},
	);
	if (!sameWorkspace()) return;
	// The conversation's session was ended while the context was being read (another model was picked, New, opencode
	// stopped). What was prepared is what that session had not seen yet, and asking with its id would carry on the
	// session that was just ended, on the model just changed away from: prepared again for the conversation as it is.
	if (chatSessionEpoch() !== chatEpoch) return runAskAbout(question, includeSelection, includeWork, extra);
	const text = composeQuestion(question, context && { ...context, file }, prepared.text || undefined);
	const withWhat = [context ? `${file} ${context.label}` : "", ...prepared.labels].filter(Boolean).join("; ");
	const isCatalogPrompt = /INDEX\.md|Update catalogs/i.test(question);
	const reply = await ask(text, {
		title: "SSL Studio chat",
		keep: true,
		sessionID: chatSession ?? undefined,
		show: withWhat ? `${question}  (with ${withWhat})` : question,
		turn: {
			ticket: ticket || undefined,
			codePath: path && root && isInside(root, path) ? path : undefined,
			isCatalogPrompt,
		},
	});
	// Discard post-await session & context hash updates if the workspace changed mid-turn.
	if (!sameWorkspace()) return;
	// Ended during the turn (see chatSessionEpoch): the reply's session is not the conversation's any more, so the
	// next question starts a new one, with the model the picker now shows and the whole context.
	if (reply && chatSessionEpoch() === chatEpoch) {
		setAgent((s) => {
			s.chatSession = reply.sessionID;
		});
		// Commit context slice hashes ONLY when the turn actually succeeded (never on failed/interrupted turns!).
		if (reply.outcome === "succeeded") {
			if (sentContext.session !== reply.sessionID) {
				// Brand-new session: populate ONLY from slices actually sent in this turn (never copy dead session hashes).
				sentContext = { session: reply.sessionID, root: curRoot, hashes: new Map(prepared.slices) };
			} else {
				for (const [k, v] of prepared.slices) sentContext.hashes.set(k, v);
			}
			setSentTick((n) => n + 1);
		}
	}
}

export async function askAbout(
	question: string,
	includeSelection: boolean,
	includeWork = false,
	extra?: { ticket?: string; workOptions?: WorkTextOptions },
) {
	if (snapshot(agent).busy || preparingLock) {
		notify("The agent is still working on the last request.");
		return;
	}
	preparingLock = true;
	setPreparing(true);
	try {
		await runAskAbout(question, includeSelection, includeWork, extra);
	} finally {
		preparingLock = false;
		setPreparing(false);
	}
}

/** A file a reply is compared with, as it was read: its text, or why it has none to compare with. */
export type ReviewTarget = { text: string } | { refused: "binary" | "unreadable"; reason?: string };

/** Reads the file a reply is to be compared with: from its editor when it is open (unsaved edits and all), else from disk. */
async function readReviewTarget(path: string): Promise<ReviewTarget> {
	const open = documents.get(canonical(path));
	if (open) return open.binary || open.model.isDisposed() ? { refused: "binary" } : { text: open.model.getValue() };
	try {
		const file = await backend.read(path);
		return file.binary ? { refused: "binary" } : { text: file.text };
	} catch (e: any) {
		return { refused: "unreadable", reason: String(e?.message ?? e) };
	}
}

/**
 * Why a reply cannot be compared with a file, or put into it, as the file is now; null when it can. `compared` is
 * the text the comparison was made against, when one has been made: a file that no longer holds that text was
 * changed since (in its editor or on disk), and the proposal, made for the text as it was, would write over the
 * change. The rule the tidy steps keep for their own proposals (tidy.ts), here for a file that need not be open.
 *
 * A file that could not be read, or is not text, used to be taken as empty: the comparison showed the whole reply
 * as new lines, and accepting it wrote the reply over the file.
 */
export function reviewTargetRefusal(rel: string, now: ReviewTarget, compared?: string): string | null {
	if ("refused" in now) {
		const reason = now.reason ? ` (${now.reason})` : "";
		if (compared === undefined) return `${rel} ${now.refused === "binary" ? "is not text" : `could not be read${reason}`}, so the reply was not compared with it. Nothing was changed.`;
		return `${rel} ${now.refused === "binary" ? "is no longer text" : `can no longer be read${reason}`}. Nothing was written: reject, and ask for Review diff again.`;
	}
	if (compared !== undefined && now.text !== compared) return `${rel} was changed after this proposal was made. Nothing was written: reject, and ask for Review diff again so the changes are not overwritten.`;
	return null;
}

/** Extracts the best fenced code/Markdown block (prompting when multiple blocks exist) and opens side-by-side ReviewView against a workspace file. */
export async function reviewProposedEdit(replyText: string, preferredPath?: string) {
	const root = state.workspace?.root;
	if (!root) return notify("Open a folder first.");

	const curActive = activePath() || "";
	const openCur = preferredPath || curActive;
	const candidates: { label: string; path: string }[] = [];
	if (openCur && isInside(root, openCur) && isAllowedContextPath(relativeTo(root, openCur))) {
		const tag = preferredPath && canonical(preferredPath) !== canonical(curActive) ? "(from turn)" : "(active file)";
		candidates.push({ label: `${relativeTo(root, openCur)} ${tag}`, path: openCur });
	}
	const PICK_OTHER = "Choose another workspace file…";
	let targetPath = candidates[0]?.path ?? "";
	if (candidates.length) {
		const picked = await choose("Compare proposed reply against which file?", [candidates[0]!.label, PICK_OTHER]);
		if (!picked) return;
		if (picked === PICK_OTHER) targetPath = "";
	}
	if (!targetPath) {
		const chosen = await browseWorkspaceFile({
			title: "Select workspace file to diff against",
			root,
		});
		if (!chosen || !isInside(root, chosen.path)) return;
		if (!isAllowedContextPath(relativeTo(root, chosen.path))) {
			return notify("Hidden files and dotfiles cannot be modified from an Agent diff proposal.", "error");
		}
		targetPath = chosen.path;
	}

	const rel = relativeTo(root, targetPath).replace(/\\/g, "/");
	const target = await readReviewTarget(targetPath);
	if ("refused" in target) return notify(reviewTargetRefusal(rel, target) ?? `${rel} could not be read.`, "error");
	const original = target.text;
	const targetLang = languageFor(targetPath).toLowerCase();
	const blocks = extractFencedBlocks(replyText);
	const extraction = planMarkdownReviewExtraction(targetLang, blocks);
	let chosenBlock: FencedBlock | null = null;
	if (extraction.mode === "use-block") {
		chosenBlock = extraction.block;
	} else if (extraction.mode === "pick") {
		const picked = await quickPick<number>({
			title:
				targetLang === "markdown"
					? "Compare Markdown reply (full reply or specific block)"
					: "This reply has multiple code blocks — choose what to diff",
			placeholder: "Choose block or full reply…",
			items: extraction.choices.map((c, idx) => ({
				label: c.label,
				value: idx,
				detail: c.detail,
				icon: c.block ? "file" : "note",
			})),
		});
		if (picked === null) return;
		chosenBlock = extraction.choices[picked]?.block ?? null;
	}

	const eol = original.includes("\r\n") ? "\r\n" : "\n";
	const rawProposed = chosenBlock
		? chosenBlock.code.replace(/^\r?\n/, "").replace(/\r?\n$/, "")
		: replyText.trim();
	let proposed = rawProposed.endsWith("\n") ? rawProposed : `${rawProposed}${eol}`;
	let blocked: string | undefined;
	const checks: Check[] = [];
	const isDiffBlock = Boolean(chosenBlock && (/^(diff|patch)$/i.test(chosenBlock.lang) || /^@@\s+-\d+/m.test(chosenBlock.code)));
	if (isDiffBlock && chosenBlock) {
		const patched = applySimpleUnifiedDiff(original, chosenBlock.code, targetPath);
		if (patched !== null) {
			proposed = patched.endsWith("\n") || !original.endsWith("\n") ? patched : `${patched}${eol}`;
		} else {
			blocked =
				"This unified diff patch could not be cleanly applied to the target file (mismatched target, multi-file diff, or invalid hunk). Accepting is blocked so raw diff syntax cannot overwrite the file.";
			checks.push({
				label: "Unified diff patch",
				ok: false,
				detail: "Could not apply cleanly to the target file; review manually instead of accepting raw diff syntax",
			});
			notify("The reply contains a unified diff patch that could not be cleanly applied; Accept is blocked.", "error");
		}
	}

	if (!blocked && (targetLang === "markdown" || /\.(md|markdown)$/i.test(targetPath))) {
		const tableFindings = checkTables(proposed);
		if (tableFindings.length) {
			checks.push({
				label: "Markdown tables (ADR 0008)",
				ok: false,
				detail: `${tableFindings.length} ${tableFindings.length === 1 ? "issue" : "issues"} — line ${tableFindings[0]!.line}: ${tableFindings[0]!.message}`,
			});
		} else {
			checks.push({
				label: "Markdown tables (ADR 0008)",
				ok: true,
				detail: "Within 4-column and cell-width limits",
			});
		}
	} else if (!blocked && /\.(csv|tsv)$/i.test(targetPath)) {
		const parsed = parseCsv(proposed);
		if (parsed.problems.length) {
			checks.push({
				label: "CSV/TSV column consistency",
				ok: false,
				detail: parsed.problems.join(" "),
			});
		} else {
			checks.push({
				label: "CSV/TSV column consistency",
				ok: true,
				detail: `${parsed.header.length} columns × ${parsed.rows.length} rows`,
			});
		}
	}

	await openReview({
		title: `Agent proposal: ${rel}`,
		path: targetPath,
		original,
		proposed,
		language: languageFor(targetPath),
		...(checks.length ? { checks } : {}),
		...(blocked ? { blocked } : {}),
		effect: documents.get(canonical(targetPath))
			? `Accepting puts the right side into ${rel} as one undoable editor edit (not saved yet).`
			: `Accepting saves the right side to ${rel} on disk.`,
		onAccept: async (final) => {
			if (blocked) throw new Error(blocked);
			const key = canonical(targetPath);
			// Read again, and held against what the proposal was compared with, before anything is written: the review
			// may have stood open a while, and the file may have been edited, saved over or opened since.
			const rootNow = snapshot(state).workspace?.root;
			if (!rootNow || canonical(rootNow) !== canonical(root)) throw new Error("The workspace changed while this proposal was open. Nothing was written.");
			const stale = reviewTargetRefusal(rel, await readReviewTarget(targetPath), original);
			if (stale) throw new Error(stale);
			if (documents.get(key)) {
				if (!applyText(key, final)) {
					throw new Error(`${rel} could not be updated because its editor was closed.`);
				}
			} else {
				await backend.historyKeep(targetPath).catch(() => {});
				await backend.write(targetPath, final);
				void scriptsCameTo(targetPath, targetPath, "file");
				setState((s) => { s.treeVersion += 1; });
			}
			notify(`Applied reviewed edit to ${rel}.`);
		},
	});
}

/** Inserts or appends `answerMd` into the `## Answer` section of a question document. */
function withQuestionAnswer(docText: string, answerMd: string): string {
	const eol = docText.includes("\r\n") ? "\r\n" : "\n";
	const cleanAnswer = answerMd.replace(/\r?\n/g, eol).trim();
	const headingRe = /^(##\s+Answer[^\r\n]*)(\r?\n|$)/im;
	const match = headingRe.exec(docText);
	if (!match) {
		const sep = docText.endsWith("\n") ? eol : `${eol}${eol}`;
		return `${docText}${sep}## Answer${eol}${eol}${cleanAnswer}${eol}`;
	}
	const afterHeading = match.index + match[0].length;
	const rest = docText.slice(afterHeading);
	const nextHeading = /^#{1,6}\s+/m.exec(rest);
	const sectionEnd = nextHeading ? afterHeading + nextHeading.index : docText.length;
	const existingSection = docText.slice(afterHeading, sectionEnd).trim();
	const before = docText.slice(0, afterHeading);
	const tail = docText.slice(sectionEnd);
	const body = existingSection ? `${existingSection}${eol}${eol}${cleanAnswer}` : cleanAnswer;
	return `${before}${eol}${body}${eol}${tail ? `${eol}${tail}` : ""}`;
}

/**
 * A question document with a reply written into its `## Answer`, and its status set to answered when that is asked
 * for. `unmarked` says the status could not be set: the front-matter writer leaves alone a value written over
 * several lines, and a block that is not closed, and answers null. The answer is written all the same, and the
 * caller says that the document was not marked: it used to say only that the answer was recorded.
 */
export function answeredQuestion(docText: string, answerMd: string, mark: boolean): { text: string; unmarked: boolean } {
	const text = withQuestionAnswer(docText, answerMd);
	if (!mark) return { text, unmarked: false };
	const marked = withFrontMatter(text, "status", "answered");
	return marked === null ? { text, unmarked: true } : { text: marked, unmarked: false };
}

/** Creates a new spec document in `docs/specs/` from an Agent reply, pre-linked to the active ticket. */
async function saveReplyAsSpec(replyText: string, ticketKey?: string): Promise<string | null> {
	const root = state.workspace?.root;
	if (!root || !state.project) {
		notify("Open a folder first.");
		return null;
	}
	const headingMatch = /^#\s+([^\r\n]+)/m.exec(replyText.trim());
	const defaultTitle = headingMatch ? headingMatch[1]!.trim() : "";
	const title = (await askDialog("Spec title", defaultTitle))?.trim();
	if (!title) return null;
	const fileSlug = slug(title);
	if (!fileSlug) {
		notify("Give the spec a title with at least one letter or digit.", "error");
		return null;
	}
	const docsParts = (state.project.docs ?? "docs").split(/[\\/]/).filter((part) => part && part !== ".");
	const specsDir = joinPath(root, ...docsParts, DOC_FOLDERS.specs);
	const dest = joinPath(specsDir, `${fileSlug}.md`);
	if ((await readForPrompt(dest)) !== null) {
		const OPEN_EXISTING = "Open existing spec";
		const picked = await choose(`${relativeTo(root, dest)} already exists.`, [OPEN_EXISTING]);
		if (picked === OPEN_EXISTING) {
			await openFile(dest, { keep: true });
			return dest;
		}
		return null;
	}
	const linkedTicket = ticketKey?.trim() || state.settings.activeTicket?.trim() || ticketAtHand() || "";
	const fmLines = [
		"---",
		`title: ${frontValue(title)}`,
		...(linkedTicket ? [`ticket: ${linkedTicket}`] : []),
		"status: draft",
		"---",
		"",
	];
	const cleanBody = replyText.trim().replace(/^#\s+[^\r\n]+\r?\n+/, "");
	const content = `${fmLines.join("\n")}# ${title}\n\n${cleanBody}\n`;
	try {
		await backend.create(dest, "file");
		await backend.write(dest, content);
	} catch (e: any) {
		notify(String(e?.message ?? e), "error");
		return null;
	}
	setState((s) => { s.treeVersion += 1; });
	refreshDocAudit();
	await openFile(dest, { keep: true });
	notify(`Saved spec ${baseName(dest)}${linkedTicket ? ` linked to ${linkedTicket}` : ""}.`);
	return dest;
}

/**
 * Where a session ended and the next question starts another (store.ts, SESSION_BREAK): a note like the thread's
 * other notes, under a rule drawn across the conversation. The rule is above the words, not to either side of
 * them: the panel is usually narrow, the words then take two lines, and rules beside them shrank to nothing.
 */
function SessionBreakLine(props: { text: string }) {
	return (
		<div class="entry note" style={{ "border-top": "1px solid var(--border)", "padding-top": "var(--space-3)", "text-align": "center" }}>
			<pre>{props.text}</pre>
		</div>
	);
}

/** One entry of the conversation. A reply is Markdown with 1-click actions to capture it into project docs or diff it in ReviewView. */
function EntryView(props: { entry: Entry }) {
	const html = createMemo(() => (props.entry.role === "agent" ? renderReply(props.entry.text) : ""));
	const entryTicket = () => props.entry.turn?.ticket;
	const entryCode = () => props.entry.turn?.codePath;
	const activeTicketForReply = () =>
		entryTicket() ||
		state.settings.activeTicket?.trim() ||
		(agentCtx.pickedTicket || "").trim() ||
		ticketForFile(docs(), entryCode(), state.workspace?.root) ||
		"";
	const openQuestionsForTicket = createMemo(() => {
		const key = activeTicketForReply();
		if (!key) return [] as DocFile[];
		return ticketWork(docs(), key).find((g) => g.kind === "question")?.files ?? [];
	});
	const hasCatalogDrift = () => {
		if (!props.entry.turn?.isCatalogPrompt && !/INDEX\.md/i.test(props.entry.text)) return false;
		const { stale, missing } = staleCatalogSummary();
		return stale.length > 0 || missing.length > 0;
	};
	const copyReply = () => {
		void import("../commands").then((m) => m.copyText(props.entry.text, "Copied agent reply."));
	};
	const replyCodeBlocks = createMemo(() => extractFencedBlocks(props.entry.text));
	const extractedTests = createMemo(() =>
		props.entry.role === "agent" && !props.entry.streaming ? extractPlanTestCasesFromMarkdown(props.entry.text) : [],
	);
	const addReplyToPlanTests = async () => {
		const root = state.workspace?.root;
		if (!root) return notify("Open a folder first.");
		const candidates = extractedTests();
		if (!candidates.length) return;

		const allDocs = docs().filter((d) => d.exists && !isCatalog(d));
		const plans = allDocs.filter((d) => d.group === "plans" && d.path.toLowerCase().endsWith(".plan.json"));
		if (!plans.length) return notify("No .plan.json files exist in this project yet. Create one with New plan… first.");

		const curTicket = activeTicketForReply().toLowerCase();
		const govPaths = new Set(
			(entryCode() || activePath() ? docsGoverningFile(allDocs, (entryCode() || activePath())!, root) : []).map((g) =>
				canonical(g.file.path),
			),
		);
		const orderedPlans = [...plans].sort((a, b) => {
			const aGov = govPaths.has(canonical(a.path)) ? 0 : 1;
			const bGov = govPaths.has(canonical(b.path)) ? 0 : 1;
			const aTkt = curTicket && (a.ticket?.toLowerCase() === curTicket || a.tickets?.some((t) => t.toLowerCase() === curTicket)) ? 0 : 1;
			const bTkt = curTicket && (b.ticket?.toLowerCase() === curTicket || b.tickets?.some((t) => t.toLowerCase() === curTicket)) ? 0 : 1;
			return aGov - bGov || aTkt - bTkt || (a.title || a.name).localeCompare(b.title || b.name);
		});

		const pickedPlan = await quickPick<DocFile>({
			title: `Add ${candidates.length} test ${candidates.length === 1 ? "case" : "cases"} to which Plan?`,
			placeholder: "Choose a .plan.json file…",
			items: orderedPlans.map((p) => ({
				label: p.title || p.name,
				value: p,
				detail: relativeTo(root, p.path).replace(/\\/g, "/"),
				badge: p.ticket ? { text: p.ticket, tone: "active" } : undefined,
				icon: "graph",
			})),
		});
		if (!pickedPlan) return;

		let selectedTests: ExtractedPlanTestCase[] = candidates;
		if (candidates.length > 1) {
			const picked = await quickPickMany<ExtractedPlanTestCase>({
				title: `Select test cases to add to ${pickedPlan.title || pickedPlan.name}`,
				placeholder: "Filter test cases…",
				items: candidates.map((tc) => ({
					label: tc.title,
					value: tc,
					detail: tc.node ? `node ${tc.node}` : undefined,
					description: [tc.given ? `Given: ${tc.given}` : "", tc.expect ? `Expect: ${tc.expect}` : ""].filter(Boolean).join(" · "),
					icon: "beaker",
				})),
				initialSelected: candidates,
				confirmLabel: "Add tests",
			});
			if (!picked || !picked.length) return;
			selectedTests = picked;
		}

		const key = canonical(pickedPlan.path);
		const open = documents.get(key);
		const raw = open ? open.model.getValue() : await backend.read(pickedPlan.path).then((r) => (r.binary ? null : r.text), () => null);
		if (raw === null) return notify(`Could not read ${baseName(pickedPlan.path)}.`, "error");
		const parsed = parsePlan(raw);
		if (!parsed.plan) return notify(`Could not parse ${baseName(pickedPlan.path)}: ${parsed.error}`, "error");

		const existingTitles = new Set(planTestsOf(parsed.plan).map((t) => t.title.trim().toLowerCase()));
		const validNodeIds = new Set(parsed.plan.nodes.map((n) => n.id));
		let updated = parsed.plan;
		let added = 0;
		for (const tc of selectedTests) {
			if (existingTitles.has(tc.title.trim().toLowerCase())) continue;
			existingTitles.add(tc.title.trim().toLowerCase());
			const resolvedNode = tc.node && validNodeIds.has(tc.node) ? tc.node : undefined;
			updated = addPlanTest(updated, {
				title: tc.title,
				...(resolvedNode ? { node: resolvedNode } : {}),
				...(tc.given ? { given: tc.given } : {}),
				...(tc.expect ? { expect: tc.expect } : {}),
				...(tc.notes ? { notes: tc.notes } : {}),
			});
			added++;
		}
		if (!added) {
			return notify(`All selected test cases are already present in ${baseName(pickedPlan.path)}.`);
		}
		const printed = printPlan(updated);
		if (open) {
			const clean = !state.dirty[key];
			applyText(key, printed);
			if (clean) await save(key, { format: false });
		} else {
			await backend.historyKeep(pickedPlan.path).catch(() => {});
			await backend.write(pickedPlan.path, printed);
		}
		setState((s) => { s.treeVersion += 1; });
		await openFile(pickedPlan.path, { keep: true });
		notify(`Added ${added} test ${added === 1 ? "case" : "cases"} to ${baseName(pickedPlan.path)}.`);
	};
	const saveReplySnippet = async () => {
		const blocks = replyCodeBlocks();
		if (!blocks.length) return;
		const chosen =
			blocks.length === 1
				? blocks[0]!
				: await quickPick<FencedBlock>({
						title: "Save which code block as a kept snippet?",
						placeholder: "Filter code blocks by language or preview…",
						items: blocks.map((b, i) => {
							const lines = b.code.split("\n");
							const firstLine = lines.find((l) => l.trim())?.trim() ?? "";
							return {
								label: `Block ${i + 1} (${b.lang || "code"})`,
								value: b,
								icon: "code" as const,
								detail: `${lines.length} ${lines.length === 1 ? "line" : "lines"}`,
								description: firstLine ? firstLine.slice(0, 96) : undefined,
								keywords: `${b.lang || "code"} ${firstLine}`,
							};
						}),
					});
		if (chosen) await saveAsSnippet(chosen.code, chosen.lang);
	};
	const answerOpenQuestion = async () => {
		const questions = openQuestionsForTicket();
		if (!questions.length) return;
		let target: DocFile | null = questions[0]!;
		if (questions.length > 1) {
			target = await quickPick<DocFile>({
				title: `Answer which open question for ${activeTicketForReply()}?`,
				placeholder: "Filter open questions by title or file name…",
				items: questions.map((q) => ({
					label: q.title || q.name,
					value: q,
					icon: "question" as const,
					detail: q.name,
					description: q.summary || undefined,
					keywords: `${q.title ?? ""} ${q.name} ${q.summary ?? ""}`,
				})),
			});
		}
		if (!target) return;
		const WRITE_MARK = "Write answer & mark answered";
		const WRITE_ONLY = "Write answer only";
		const action = await choose(`Write this reply into "## Answer" of ${target.title || target.name}?`, [WRITE_MARK, WRITE_ONLY]);
		if (!action) return;
		const key = canonical(target.path);
		const open = documents.get(key);
		const cur = open ? open.model.getValue() : await backend.read(target.path).then((r) => (r.binary ? null : r.text), () => null);
		if (cur === null) return notify("Could not read the question document.", "error");
		const { text: next, unmarked } = answeredQuestion(cur, props.entry.text, action === WRITE_MARK);
		if (open) {
			const clean = !state.dirty[key];
			applyText(key, next);
			if (clean) await save(key, { format: false });
		} else {
			await backend.historyKeep(target.path).catch(() => {});
			await backend.write(target.path, next);
		}
		setState((s) => { s.treeVersion += 1; });
		refreshDocAudit();
		await openFile(target.path, { keep: true });
		if (unmarked) notify(`Recorded answer in ${target.title || baseName(target.path)}, but it was not marked answered: its status is written over several lines, or its front matter is not closed. Change the status in the text.`, "error");
		else notify(`Recorded answer in ${target.title || baseName(target.path)}.`);
	};
	return (
		<div class={["entry", props.entry.role, { streaming: Boolean(props.entry.streaming) }]} aria-busy={props.entry.streaming ? "true" : undefined}>
			<Show when={props.entry.role === "agent"} fallback={<pre>{props.entry.text}</pre>}>
				<div class="md" innerHTML={html()} onClick={(e) => void followReplyLink(e)} />
				<Show when={!props.entry.streaming && props.entry.text.trim()}>
					<div class="agent-reply-actions" role="group" aria-label="Capture reply">
						<button type="button" class="link" title="Copy reply as Markdown" onClick={copyReply}>
							Copy
						</button>
						<button type="button" class="link" title="Compare this reply against a workspace file in ReviewView before applying" onClick={() => void safely("Could not open review diff", () => reviewProposedEdit(props.entry.text, entryCode()))}>
							Review diff…
						</button>
						<Show when={extractedTests().length > 0}>
							<button
								type="button"
								class="link"
								title={`Add ${extractedTests().length} extracted test ${extractedTests().length === 1 ? "case" : "cases"} to a .plan.json`}
								onClick={() => void safely("Could not add tests to plan", () => addReplyToPlanTests())}
							>
								Add to Plan tests…
							</button>
						</Show>
						<Show when={hasCatalogDrift()}>
							<button type="button" class="link" title="Apply Update catalogs now (manual ADR 0031 reconciliation)" onClick={() => void safely("Could not update catalogs", () => updateCatalogs())}>
								Update catalogs
							</button>
						</Show>
						<Show when={replyCodeBlocks().length > 0}>
							<button type="button" class="link" title="Save code block as a kept snippet in docs/knowledge/snippets/" onClick={() => void safely("Could not save snippet", () => saveReplySnippet())}>
								Save as Snippet
							</button>
						</Show>
						<button type="button" class="link" title="Save this reply as a Spec in docs/specs/ linked to the active ticket" onClick={() => void safely("Could not save spec", () => saveReplyAsSpec(props.entry.text, activeTicketForReply() || undefined))}>
							Save as Spec…
						</button>
						<button type="button" class="link" title="Save this reply as a Decision ADR" onClick={() => void safely("Could not save decision", () => promoteToKnowledge("decisions", { body: props.entry.text, ticket: activeTicketForReply() || undefined, codePath: entryCode() }))}>
							Save as Decision
						</button>
						<button type="button" class="link" title="Save this reply as a Question" onClick={() => void safely("Could not save question", () => promoteToKnowledge("questions", { body: props.entry.text, ticket: activeTicketForReply() || undefined, codePath: entryCode() }))}>
							Save as Question
						</button>
						<button type="button" class="link" title="Save this reply as a Reference note" onClick={() => void safely("Could not save note", () => promoteToKnowledge("reference", { body: props.entry.text, ticket: activeTicketForReply() || undefined, codePath: entryCode() }))}>
							Save as Note
						</button>
						<Show when={openQuestionsForTicket().length > 0}>
							<button
								type="button"
								class="link"
								title={`Write this reply into ## Answer for an open question on ${activeTicketForReply()}`}
								onClick={() => void safely("Could not record answer", () => answerOpenQuestion())}
							>
								Answer open question…
							</button>
						</Show>
						<Show when={activeTicketForReply()}>
							{(key) => (
								<button type="button" class="link" title={`Append this reply as a dated note on ${key()}`} onClick={() => void safely("Could not append note to ticket", () => appendNoteToTicket(key(), props.entry.text))}>
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
	let unmounted = false;
	onCleanup(() => {
		unmounted = true;
	});
	onSettled(() => {
		void resume();
	});
	createEffect(
		() => state.workspace?.root,
		() => {
			ensureAgentWorkspace();
		},
	);
	const [draft, setDraft] = createSignal("");
	/** The box the question is typed in, for a starter to hand the keyboard to. */
	let box: HTMLTextAreaElement | undefined;
	createEffect(
		() => pendingDraft(),
		(handed) => {
			if (!handed) return;
			let cancelled = false;
			void (async () => {
				const existing = untrack(draft).trim();
				if (existing && existing !== handed.text.trim()) {
					const REPLACE = "Replace draft";
					const picked = await choose("Replace your current Agent draft?", [REPLACE]);
					if (cancelled) return;
					if (picked !== REPLACE) {
						setPendingDraft((cur) => (cur?.seq === handed.seq ? null : cur));
						return;
					}
				}
				if (cancelled) return;
				setPendingDraft((cur) => (cur?.seq === handed.seq ? null : cur));
				if (handed.cleanContext) {
					setWithSelection(false);
					setAgentCtx((s) => {
						s.pickedTicket = "";
						s.withSchema = false;
						s.withRefTables = false;
						s.withRegistries = false;
						s.withState = false;
						s.withGitDiff = false;
						s.withGoverningDocs = false;
						s.attachedFiles = [];
					});
				}
				setDraft(handed.text);
				setNotSent("");
				queueMicrotask(() => {
					if (!unmounted) box?.focus();
				});
			})();
			return () => {
				cancelled = true;
			};
		},
	);
	const [notSent, setNotSent] = createSignal("");
	const [withSelection, setWithSelection] = createSignal(true);
	const isBusy = () => agent.busy || preparing();
	// Separate content edits from cursor-selection moves so moving the cursor never triggers gitDiff/disk reads.
	const [contentEdited, setContentEdited] = createSignal(0);
	const [selectionMoved, setSelectionMoved] = createSignal(0);
	const curDoc = createMemo(() => activeDoc());
	createEffect(
		() => [curDoc(), activeEditor()] as const,
		([doc, editor]) => {
			const d1 = doc?.model.onDidChangeContent(() => setContentEdited((n) => n + 1));
			const d2 = editor?.onDidChangeCursorSelection(() => setSelectionMoved((n) => n + 1));
			return () => {
				d1?.dispose();
				d2?.dispose();
			};
		},
	);
	const autoTicket = createMemo(() => (contentEdited(), resolvedAutoTicket()));
	const allTickets = createMemo(() =>
		docs()
			.filter((d) => d.exists && d.group === "tickets" && d.ticket)
			.sort((a, b) => (a.ticket ?? "").localeCompare(b.ticket ?? "", undefined, { numeric: true })),
	);
	const ticket = createMemo(() => {
		const picked = agentCtx.pickedTicket;
		return picked === null ? autoTicket() : picked;
	});
	const activeTicketDoc = createMemo(() => {
		const key = ticket();
		return key ? allTickets().find((d) => d.ticket?.toLowerCase() === key.toLowerCase()) : undefined;
	});
	const detectedRefTables = createMemo(() => {
		contentEdited();
		selectionMoved();
		liveSelectionVersion();
		const doc = activeDoc();
		if (!doc || doc.binary) return [] as DocFile[];
		const place = tableSearchPlace(doc);
		const txt = !place ? "" : "text" in place ? place.text : searchableTextNow(place.model, place.selection);
		return referencedSchemaTables(txt, docs(), 6);
	});
	const detectedGoverningDocs = createMemo(() => {
		const root = state.workspace?.root ?? "";
		if (!root) return [] as GoverningContextItem[];
		gitVersion();
		return collectGoverningDocsForContext(
			docs().filter((d) => d.exists && !isCatalog(d)),
			root,
			activePath(),
		);
	});
	// Real measured next-turn delta size & token budget (approx 1 token ≈ 4 chars), debounced (350ms) and decoupled from cursor-selection moves.
	const rawDeltaSrc = createMemo(() => {
		const rawRoot = state.workspace?.root;
		if (!rawRoot) return null;
		const curRoot = canonical(rawRoot);
		// Wait for ensureAgentWorkspace() to reset agentCtx before kicking off an initial or cross-workspace query.
		if (agentCtx.root !== curRoot) return null;
		const targetTicket = ticket();
		const sendWork = Boolean(targetTicket) && (agentCtx.pickedTicket !== null || withWork());
		const files = agentCtx.attachedFiles.map((f) => ({ path: f.path, rel: f.rel }));
		const allDocs = docs();
		const curPath = activePath() ?? "";
		const curDoc = activeDoc();
		const gitSt = gitStatus();
		return {
			root: rawRoot,
			ticket: sendWork ? targetTicket : "",
			schema: agentCtx.withSchema,
			refTables: agentCtx.withRefTables,
			refTableKey: agentCtx.withRefTables ? detectedRefTables().map((d) => canonical(d.path)).join(",") : "",
			regs: agentCtx.withRegistries,
			st: agentCtx.withState,
			gitDiff: agentCtx.withGitDiff,
			govDocs: agentCtx.withGoverningDocs,
			gitVer: gitVersion(),
			gitStatusSnapshot: gitSt,
			docsSnapshot: allDocs,
			docsSig: `${allDocs.length}:${allDocs.map((d) => `${d.path}|${d.exists ? 1 : 0}|${d.status ?? ""}|${d.rows ?? ""}`).join("\n")}`,
			curPath,
			activeDocSnapshot: curDoc,
			files,
			filesKey: files.map((f) => `${f.path}|${f.rel}`).join("\n"),
			tree: state.treeVersion,
			sent: sentTick(),
			ed: contentEdited(),
			session: agent.chatSession ?? "",
		};
	});
	const [debouncedDeltaSrc, setDebouncedDeltaSrc] = createSignal<ReturnType<typeof rawDeltaSrc>>(null);
	let deltaSrcInitialized = false;
	createEffect(
		() => rawDeltaSrc(),
		(next) => {
			if (!next) {
				deltaSrcInitialized = false;
				setDebouncedDeltaSrc(null);
				return;
			}
			if (!deltaSrcInitialized) {
				deltaSrcInitialized = true;
				setDebouncedDeltaSrc(next);
				return;
			}
			const timer = setTimeout(() => setDebouncedDeltaSrc(next), 350);
			return () => clearTimeout(timer);
		},
	);
	const [measuredDelta] = createAsyncQuery(debouncedDeltaSrc, (src) =>
		untrack(async () => {
			if (!src.root) return { chars: 0, breakdown: [] as PreparedContext["breakdown"] };
			const curRoot = canonical(src.root);
			const already = sentContext.session === (src.session || null) && sentContext.root === curRoot ? sentContext.hashes : new Map<string, string>();
			const prepared = await prepareContextDelta(
				src.ticket,
				{
					includeSchema: src.schema,
					includeRegistries: src.regs,
					includeState: src.st,
					ticketFiles: src.files,
				},
				already,
				{
					withGitDiff: src.gitDiff,
					withGoverningDocs: src.govDocs,
					withRefTables: src.refTables,
				},
				{
					root: src.root,
					allDocs: src.docsSnapshot,
					activePath: src.curPath || null,
					activeDoc: src.activeDocSnapshot,
					gitStatus: src.gitStatusSnapshot,
				},
			);
			return { chars: prepared.text.length, breakdown: prepared.breakdown };
		}),
	);
	const preSendEstimate = createMemo(() => {
		contentEdited();
		selectionMoved();
		liveSelectionVersion();
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
		const delta = measuredDelta();
		if (delta) {
			chars += delta.chars;
			for (const b of delta.breakdown) {
				if (b.status === "sent") parts.push(`${b.label} (sent)`);
				else if (b.status === "edited") parts.push(`${b.label} (updated ~${Math.ceil(b.chars / 4)} tok)`);
				else parts.push(`${b.label} (~${Math.ceil(b.chars / 4)} tok)`);
			}
		}
		const tokens = Math.ceil(chars / 4);
		const activeModel = agent.models.find((m) => modelRef(m) === currentModel());
		const warn = Boolean((!activeModel || activeModel.local) && tokens > 3500);
		return { tokens, chars, warn, summary: parts.length ? parts.join(" + ") : "No context attached yet" };
	});
	const pickContextFile = async () => {
		const root = snapshot(state).workspace?.root;
		if (!root) return notify("Open a folder first.");
		const curAttached = snapshot(agentCtx).attachedFiles;
		const already = new Set(curAttached.map((f) => canonical(f.path)));
		const ticketFiles = (activeTicketDoc()?.ticketFiles ?? []).filter(
			(f) => !already.has(canonical(f.path)) && isInside(root, f.path) && isAllowedContextPath(relativeTo(root, f.path)),
		);
		const picked = await browseWorkspaceFile({
			title: "Attach file to Agent",
			root,
			pinned: ticketFiles.map((f) => ({ path: f.path, rel: f.rel, detail: f.rel })),
			pinnedLabel: ticket() || "Ticket",
			exclude: curAttached.map((f) => f.path),
		});
		if (!picked || snapshot(state).workspace?.root !== root || !isInside(root, picked.path)) return;
		const rel = relativeTo(root, picked.path).replace(/\\/g, "/");
		if (!isAllowedContextPath(rel)) {
			notify("Hidden files and dotfiles cannot be attached to Agent context.", "error");
			return;
		}
		setAgentCtx((s) => {
			if (!s.attachedFiles.some((f) => canonical(f.path) === canonical(picked.path))) {
				s.attachedFiles.push({ path: picked.path, rel });
			}
		});
	};
	const modelOf = (ref: string) => agent.models.find((m) => modelRef(m) === ref);
	const usable = () => agent.models.filter((m) => m.tools);
	const pickedTicketMissing = createMemo(() => {
		const picked = agentCtx.pickedTicket;
		return Boolean(picked) && !allTickets().some((t) => t.ticket === picked);
	});
	let modelSelectEl: HTMLSelectElement | undefined;
	createEffect(
		() => [usable(), currentModel()] as const,
		([, model]) => {
			if (modelSelectEl && modelSelectEl.value !== model) modelSelectEl.value = model;
		},
	);
	let ticketSelectEl: HTMLSelectElement | undefined;
	createEffect(
		() => [allTickets(), agentCtx.pickedTicket] as const,
		([, picked]) => {
			const wanted = picked === null ? "__auto__" : picked;
			if (ticketSelectEl && ticketSelectEl.value !== wanted) ticketSelectEl.value = wanted;
		},
	);

	// The conversation follows the reply as it is written, until the user scrolls up to read.
	let scroller!: HTMLDivElement;
	let pinned = true;
	const toEnd = () => {
		pinned = true;
		scroller.scrollTop = scroller.scrollHeight;
	};
	createEffect(
		() => [agent.entries.reduce((n, e) => n + e.text.length, agent.entries.length), agent.busy] as const,
		() => {
			if (pinned && scroller) scroller.scrollTop = scroller.scrollHeight;
		},
	);
	// The reason goes when it no longer holds.
	createEffect(
		() => !isBusy(),
		(idle) => {
			if (idle) setNotSent("");
		},
	);

	const send = () => {
		const result = composerSend(untrack(draft), snapshot(agent).busy || preparingLock);
		setDraft(result.draft);
		setNotSent(result.why ?? "");
		if (result.send === null) return;
		preparingLock = true;
		setPreparing(true);
		toEnd();
		ensureAgentWorkspace();
		const ctx = snapshot(agentCtx);
		const targetTicket = ctx.pickedTicket === null ? resolvedAutoTicketNow() : ctx.pickedTicket;
		const sendWork = Boolean(targetTicket) && (ctx.pickedTicket !== null || untrack(withWork));
		void safely("The question was not sent", () =>
			runAskAbout(result.send!, untrack(withSelection), sendWork, {
				ticket: targetTicket,
				workOptions: {
					includeSchema: ctx.withSchema,
					includeRegistries: ctx.withRegistries,
					includeState: ctx.withState,
					ticketFiles: ctx.attachedFiles,
				},
			}),
		).finally(() => {
			preparingLock = false;
			setPreparing(false);
		});
	};
	const pickModel = async (select: HTMLSelectElement) => {
		const saved = await safely("The model was not changed", () => chooseModel(select.value));
		// Declined, or not saved: the list goes back to the model still in use.
		if (!saved) select.value = currentModel();
	};
	const newConversation = () => {
		sentContext = { session: null, root: lastWorkspaceRoot, hashes: new Map() };
		setSentTick((n) => n + 1);
		startNewThread(NEW_CONVERSATION);
		toEnd();
	};
	const clearConversation = () => {
		sentContext = { session: null, root: lastWorkspaceRoot, hashes: new Map() };
		setSentTick((n) => n + 1);
		clearEntries();
	};
	const hasExportableThread = createMemo(() =>
		agent.entries.some((e) => (e.role === "user" || e.role === "agent") && e.text.trim().length > 0),
	);
	const formatThreadDate = (ms: number) => {
		const d = new Date(ms);
		if (Number.isNaN(d.getTime())) return "";
		return d.toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
	};
	const openThreadHistory = async () => {
		if (agent.busy) return notify("Wait for the current reply to finish before switching conversations.");
		const threads = agent.threads;
		if (!threads.length) return notify("No saved conversations for this workspace yet.");
		const NEW_ID = "__new__";
		const CLEAR_ALL = "__clear_all__";
		const picked = await quickPick<string>({
			title: `Agent conversation history (${threads.length}/5)`,
			placeholder: "Switch to a recent workspace thread…",
			items: [
				...threads.map((t) => ({
					label: t.title,
					value: t.id,
					checked: t.id === agent.activeThreadId,
					badge: t.ticket ? { text: t.ticket, tone: "active" } : undefined,
					detail: `${t.entries.filter((e) => e.role === "user" || e.role === "agent").length} msgs · ${formatThreadDate(t.updatedAt)}`,
					icon: "note" as const,
				})),
				{ label: "Start new conversation", value: NEW_ID, icon: "add", divide: true },
				{ label: "Clear saved thread history", value: CLEAR_ALL, icon: "trash", danger: true },
			],
		});
		if (!picked) return;
		if (picked === NEW_ID) {
			newConversation();
			return;
		}
		if (picked === CLEAR_ALL) {
			const CONFIRM = "Clear history";
			if ((await choose("Clear all saved Agent conversation threads for this workspace?", [CONFIRM], { danger: CONFIRM })) !== CONFIRM) return;
			sentContext = { session: null, root: lastWorkspaceRoot, hashes: new Map() };
			setSentTick((n) => n + 1);
			clearSavedThreads();
			notify("Cleared saved Agent history for this workspace.");
			return;
		}
		sentContext = { session: null, root: lastWorkspaceRoot, hashes: new Map() };
		setSentTick((n) => n + 1);
		switchThread(picked);
		toEnd();
	};
	const exportThread = async () => {
		const key = ticket() || state.settings.activeTicket?.trim() || ticketAtHand() || "";
		const md = formatAgentThreadMarkdown(agent.entries, { ticket: key || undefined });
		if (!md) return notify("There is no conversation to export yet.");
		const picked = await quickPick<"question" | "decision" | "ticket" | "copy">({
			title: "Export Agent conversation",
			placeholder: "Choose where to save this conversation…",
			items: [
				{
					label: "Save as Question (docs/knowledge/questions/)",
					value: "question",
					detail: "Create a new knowledge-base Question note",
					icon: "question",
				},
				{
					label: "Save as Decision ADR (docs/knowledge/decisions/)",
					value: "decision",
					detail: "Create a numbered architecture/design Decision",
					icon: "lightbulb",
				},
				...(key
					? [
							{
								label: `Append to ${key} ticket notes`,
								value: "ticket" as const,
								detail: `Append dated Q&A summary to ${key}`,
								icon: "checklist" as const,
							},
						]
					: []),
				{
					label: "Copy formatted thread as Markdown",
					value: "copy",
					detail: "Copy clean Q&A Markdown to clipboard",
					icon: "copy",
					divide: true,
				},
			],
		});
		if (!picked) return;
		if (picked === "question") {
			await promoteToKnowledge("questions", { body: md, ticket: key || undefined });
		} else if (picked === "decision") {
			await promoteToKnowledge("decisions", { body: md, ticket: key || undefined });
		} else if (picked === "ticket" && key) {
			await appendNoteToTicket(key, md);
		} else if (picked === "copy") {
			await (await import("../commands")).copyText(md, "Copied formatted Agent thread.");
		}
	};
	const loadKeptPrompt = (file: DocFile) => {
		void (async () => {
			try {
				const words = await wordsOf(file);
				if (!words) return notify(`${file.title || file.name} has no words in it yet.`);
				let finalText = words;
				if (words.includes("<%") || words.includes("{{")) {
					const root = state.workspace?.root ?? "";
					const curPath = activePath() ?? "";
					const relPath = curPath && root ? relativeTo(root, curPath).replace(/\\/g, "/") : "";
					const fileName = curPath ? baseName(curPath) : "";
					const curDocMeta = curPath ? docs().find((d) => d.exists && canonical(d.path) === canonical(curPath)) : undefined;
					const title = curDocMeta?.title || (fileName ? fileName.replace(/\.[^.]+$/, "") : state.project?.name || state.workspace?.name || "Project");
					const folder = curPath && root ? relativeTo(root, dirName(curPath)).replace(/\\/g, "/") : "";
					const rendered = await renderTemplate(words, {
						title,
						fileName,
						relativePath: relPath,
						fullPath: curPath || undefined,
						folder: folder === "." ? "" : folder,
						projectName: state.project?.name || state.workspace?.name || "Project",
						ticket: ticket() || state.settings.activeTicket?.trim() || "",
						selection: selectionContext()?.code ?? "",
						prompt: (label, def) => askDialog(label, def),
						suggest: async (labels, values, placeholder) => {
							if (!labels.length) return null;
							const idx = await quickPick<number>({
								title: placeholder || "Choose an option",
								placeholder: "Filter options…",
								items: labels.map((label, i) => ({
									label,
									value: i,
									detail: values[i] !== undefined && values[i] !== label ? String(values[i]) : undefined,
								})),
							});
							if (idx === null) return null;
							return values[idx] ?? labels[idx] ?? null;
						},
						clipboard: () => navigator.clipboard?.readText().catch(() => "") ?? "",
					});
					if (rendered.cancelled) return;
					finalText = rendered.text;
				}
				setDraft(finalText);
				setNotSent("");
				box?.focus();
			} catch (e: any) {
				notify(String(e?.message ?? e), "error");
			}
		})();
	};
	/** Modified code/SQL files in Git that have governing specs, plans, schema docs, or tickets. */
	const changedCodeWithDocs = createMemo(() => {
		const st = gitStatus();
		const root = state.workspace?.root;
		if (!st || !root) return [] as { rel: string; docs: string[] }[];
		const allDocs = docs();
		const out: { rel: string; docs: string[] }[] = [];
		for (const f of st.files) {
			if (!/\.(ssl|srvscr|ds|sql|ddl|pks|pkb|xfd|xml|js|ts|css|html)$/i.test(f.path)) continue;
			const gov = docsGoverningFile(allDocs, f.path, root);
			if (!gov.length) continue;
			out.push({
				rel: relativeTo(root, f.path).replace(/\\/g, "/"),
				docs: gov.slice(0, 6).map((g) => relativeTo(root, g.file.path).replace(/\\/g, "/")),
			});
		}
		return out;
	});
	const docDriftStarterPrompt = () => {
		const changed = changedCodeWithDocs();
		if (!changed.length) return "";
		const lines = changed.slice(0, 10).map((c) => `- \`${c.rel}\` → governed by ${c.docs.map((d) => `\`${d}\``).join(", ")}`);
		return `Check whether the modified code files below have drifted from their governing project docs (specs, plans, schema docs, or #L code citations) and propose concise updates:\n\n${lines.join("\n")}`;
	};
	const releaseNotesStarterPrompt = () => {
		const key = ticket();
		if (!key) return "";
		const title = activeTicketDoc()?.title;
		return `Draft concise release notes and a dated STATE.md completion update for ${key}${title ? ` (${title})` : ""}, summarizing what changed, impacted STARLIMS objects, verification steps, and any rollback notes.`;
	};
	/** Grounds the doc-drift starter in actual Git diff + governing doc excerpts for tool-less local models. */
	const runDocDriftStarter = () => {
		const text = docDriftStarterPrompt();
		if (!text) return;
		setAgentCtx((s) => {
			s.withGitDiff = true;
			s.withGoverningDocs = true;
		});
		setWithSelection(false);
		setDraft(text);
		setNotSent("");
		const govCount = detectedGoverningDocs().length;
		notify(
			`Enabled + Git diff and + Governing docs (${govCount} ${govCount === 1 ? "doc" : "docs"}) for doc-drift review.`,
		);
		box?.focus();
	};
	/** Grounds release-notes drafting in local Git commits for the active ticket + current Git diff + STATE.md. */
	const runReleaseNotesStarter = async () => {
		const key = ticket();
		if (!key) return;
		setAgentCtx((s) => {
			s.withGitDiff = true;
			s.withState = true;
		});
		const commits = await backend.gitTicketLog(key, 25).catch(() => []);
		const basePrompt = releaseNotesStarterPrompt();
		let fullPrompt = basePrompt;
		if (commits.length) {
			const summaryLines = commits.slice(0, 15).map((c) => {
				const files = c.files
					.slice(0, 4)
					.map((f) => `${f.status[0] ?? "M"} ${f.path}`)
					.join(", ");
				const more = c.files.length > 4 ? ` (+${c.files.length - 4} more)` : "";
				return `- ${c.shortSha} ${c.subject}${files ? ` [${files}${more}]` : ""}`;
			});
			if (commits.length > 15) summaryLines.push(`- … and ${commits.length - 15} earlier commits`);
			fullPrompt = `${basePrompt}\n\nLocal commits mentioning ${key} (${commits.length}):\n${summaryLines.join("\n")}`;
		}
		setDraft(fullPrompt);
		setNotSent("");
		notify(
			commits.length
				? `Embedded ${commits.length} local ${commits.length === 1 ? "commit" : "commits"} for ${key} and enabled + Git diff & + STATE.md.`
				: `Enabled + Git diff & + STATE.md for ${key} release notes (no local commits mentioning ${key} yet).`,
		);
		box?.focus();
	};
	const promptMenuItems = (): MenuItem[] => {
		const items: MenuItem[] = [];
		const kept = keptPrompts();
		if (kept.length) {
			for (const file of kept) items.push({ label: file.title || file.name, run: () => loadKeptPrompt(file) });
			items.push("separator");
		}
		const contextual: MenuItem[] = [];
		if (changedCodeWithDocs().length) {
			contextual.push({
				label: `Check doc drift for ${changedCodeWithDocs().length} changed ${changedCodeWithDocs().length === 1 ? "file" : "files"}`,
				run: () => runDocDriftStarter(),
			});
		}
		if (ticket()) {
			contextual.push({
				label: `Draft release notes / STATE.md update (${ticket()})`,
				run: () => void runReleaseNotesStarter(),
			});
		}
		const curPath = activePath() ?? "";
		const root = state.workspace?.root ?? "";
		const activeIsSsl = Boolean(curPath && (activeDoc()?.model.getLanguageId() === "ssl" || /\.(ssl|srvscr|ds)$/i.test(curPath)));
		const govDocs = detectedGoverningDocs();
		if (activeIsSsl && (ticket() || govDocs.length > 0)) {
			const relSsl = root ? relativeTo(root, curPath).replace(/\\/g, "/") : baseName(curPath);
			contextual.push({
				label: "Review active SSL against spec & decisions",
				run: () => {
					if (govDocs.length > 0) setAgentCtx((s) => { s.withGoverningDocs = true; });
					setDraft(
						`Review \`${relSsl}\` against its governing spec, plan, and settled project decisions. List any behavioral mismatches, missing guardrails, or house-style issues with exact line references.`,
					);
					setNotSent("");
					box?.focus();
				},
			});
		}
		if (state.workspace) {
			contextual.push({
				label: "Draft an ADR decision record (Context / Decision / Consequences)",
				run: () => {
					const key = ticket();
					setDraft(
						`Draft a concise ADR decision record${key ? ` for ${key}` : ""} with YAML frontmatter (title, status: proposed${key ? `, ticket: ${key}` : ""}) and clear sections: ## Context, ## Decision, and ## Consequences.`,
					);
					setNotSent("");
					box?.focus();
				},
			});
		}
		const activeDocMeta = curPath ? docs().find((d) => d.exists && canonical(d.path) === canonical(curPath)) : undefined;
		const hasSpecOrTicket = Boolean(ticket() || activeDocMeta?.group === "specs" || govDocs.some((g) => g.file.group === "specs"));
		if (hasSpecOrTicket) {
			contextual.push({
				label: "Generate test cases from active spec / ticket",
				run: () => {
					if (!ticket() && govDocs.length > 0) setAgentCtx((s) => { s.withGoverningDocs = true; });
					const targetLabel = ticket()
						? `${ticket()} and its linked specs`
						: activeDocMeta?.title || baseName(curPath) || "the active spec";
					setDraft(
						`Generate concrete test cases (happy path, boundary conditions, null/empty inputs, and STARLIMS regression checks) from ${targetLabel}. Format each case with Given / When / Expect and a Markdown checklist.`,
					);
					setNotSent("");
					box?.focus();
				},
			});
		}
		const { stale, missing } = staleCatalogSummary();
		const totalCat = stale.length + missing.length;
		if (totalCat) {
			contextual.push({
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
		}
		if (contextual.length) {
			items.push(...contextual, "separator");
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
				<div class="agent-header-actions">
					<button
						type="button"
						class="agent-hdr-btn"
						disabled={isBusy()}
						title={agent.threads.length ? `Switch between ${agent.threads.length} saved workspace conversations` : "Conversation history (last 5 workspace threads)"}
						onClick={() => void safely("Could not open thread history", () => openThreadHistory())}
					>
						<Icon name="list-flat" />
						<span>History{agent.threads.length ? ` (${agent.threads.length})` : ""}</span>
					</button>
					<Show when={hasExportableThread()}>
						<button
							type="button"
							class="agent-hdr-btn"
							disabled={isBusy()}
							title="Export this conversation as a Question, Decision ADR, or active ticket note"
							onClick={() => void safely("Could not export conversation", () => exportThread())}
						>
							<Icon name="note" />
							<span>Export…</span>
						</button>
					</Show>
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
					<select ref={modelSelectEl} value={currentModel()} onChange={(e) => void pickModel(e.currentTarget)}>
						{/* A saved model opencode does not list must not read as the first one in the list. */}
						<Show when={!modelOf(currentModel())?.tools}>
							<option value={currentModel()} disabled>
								{currentModel() ? `${currentModel()} (not in the list below)` : "No model chosen"}
							</option>
						</Show>
						{/* Under headings: a provider may offer hundreds, and the ones on this machine come first. */}
						<For each={groupModels(usable())} keyed={(g) => g.label}>
							{(group) => (
								<optgroup label={group().label}>
									<For each={group().models} keyed={(m) => modelRef(m)}>
										{(m) => (
											<option value={modelRef(m())}>
												{m().local ? `${m().name} · ${m().providerID}` : `$ ${m().name}`}
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
								<Show when={changedCodeWithDocs().length > 0}>
									<li>
										<button title="Check governing docs for drift against your modified code files (attaches Git diff + governing docs)" onClick={() => runDocDriftStarter()}>
											Check doc drift for changed files ({changedCodeWithDocs().length})
										</button>
									</li>
								</Show>
								<Show when={ticket()}>
									<li>
										<button title={`Draft release notes and a STATE.md update for ${ticket()} grounded in local Git commits and diff`} onClick={() => void runReleaseNotesStarter()}>
											Draft release notes / STATE.md update ({ticket()})
										</button>
									</li>
								</Show>
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
													onClick={() => loadKeptPrompt(file)}
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
					{(e) => (
						<Show when={isSessionBreak(e)} fallback={<EntryView entry={e} />}>
							<SessionBreakLine text={e.text} />
						</Show>
					)}
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
				<Show when={allTickets().length > 0 || Boolean(agentCtx.pickedTicket)}>
					<div class="agent-context-bar">
						<label class="agent-ticket-picker" title="Choose which ticket's context (specs, decisions, open questions) goes with your question">
							<span class="agent-ticket-label">Ticket:</span>
							<select
								ref={ticketSelectEl}
								class="agent-ticket-select"
								aria-label="Ticket context for the agent"
								value={agentCtx.pickedTicket === null ? "__auto__" : agentCtx.pickedTicket}
								onChange={(e) => {
									const v = e.currentTarget.value;
									if (v === "__auto__") {
										setAgentCtx((s) => { s.pickedTicket = null; });
										setWithWork(true);
										remember("agent.withWork", "yes");
									} else if (v === "") {
										setAgentCtx((s) => { s.pickedTicket = ""; });
										setWithWork(false);
										remember("agent.withWork", "no");
									} else {
										setAgentCtx((s) => { s.pickedTicket = v; });
										setWithWork(true);
										remember("agent.withWork", "yes");
									}
								}}
							>
								<option value="__auto__">Auto{autoTicket() ? ` (${autoTicket()})` : " (none)"}</option>
								<option value="">None</option>
								<Show when={pickedTicketMissing()}>
									<option value={agentCtx.pickedTicket!} disabled>
										{agentCtx.pickedTicket} (not in list)
									</option>
								</Show>
								<For each={allTickets()} keyed={(t) => t.ticket!}>
									{(t) => (
										<option value={t().ticket!}>
											{t().ticket}
											{t().title ? ` — ${t().title?.slice(0, 32)}` : ""}
										</option>
									)}
								</For>
							</select>
						</label>
						<Show when={agentCtx.pickedTicket === null && autoTicket()}>
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
						<Show when={detectedRefTables().length > 0 || agentCtx.withRefTables}>
							<button
								type="button"
								class={["agent-ctx-chip", { active: agentCtx.withRefTables }]}
								aria-pressed={agentCtx.withRefTables ? "true" : "false"}
								title={
									detectedRefTables().length
										? `Inject exact column definitions for schema tables referenced in this file: ${detectedRefTables().map((d) => d.title || d.name).join(", ")}`
										: "Table schema injection is active (0 tables detected on the current tab). Click to disable."
								}
								onClick={() => setAgentCtx((s) => { s.withRefTables = !s.withRefTables; })}
							>
								+ Tables ({detectedRefTables().length})
							</button>
						</Show>
						<button
							type="button"
							class={["agent-ctx-chip", { active: agentCtx.withSchema }]}
							aria-pressed={agentCtx.withSchema ? "true" : "false"}
							title="Include project schema summaries in the next turn"
							onClick={() => setAgentCtx((s) => { s.withSchema = !s.withSchema; })}
						>
							+ Schema
						</button>
						<button
							type="button"
							class={["agent-ctx-chip", { active: agentCtx.withRegistries }]}
							aria-pressed={agentCtx.withRegistries ? "true" : "false"}
							title={ticket() ? `Include CSV registry rows mentioning ${ticket()}` : "Include project CSV registry summary"}
							onClick={() => setAgentCtx((s) => { s.withRegistries = !s.withRegistries; })}
						>
							+ Registries
						</button>
						<button
							type="button"
							class={["agent-ctx-chip", { active: agentCtx.withState }]}
							aria-pressed={agentCtx.withState ? "true" : "false"}
							title="Include project STATE.md summary"
							onClick={() => setAgentCtx((s) => { s.withState = !s.withState; })}
						>
							+ STATE.md
						</button>
						<button
							type="button"
							class={["agent-ctx-chip", { active: agentCtx.withGitDiff }]}
							aria-pressed={agentCtx.withGitDiff ? "true" : "false"}
							title={
								gitStatus()
									? `Include compact staged + unstaged Git diff (${gitStatus()!.files.length} changed ${gitStatus()!.files.length === 1 ? "file" : "files"})`
									: "Include compact staged + unstaged Git diff (no git repository detected)"
							}
							onClick={() => setAgentCtx((s) => { s.withGitDiff = !s.withGitDiff; })}
						>
							+ Git diff
						</button>
						<button
							type="button"
							class={["agent-ctx-chip", { active: agentCtx.withGoverningDocs }]}
							aria-pressed={agentCtx.withGoverningDocs ? "true" : "false"}
							title={
								detectedGoverningDocs().length
									? `Include compact excerpts of governing docs for active/changed code files: ${detectedGoverningDocs().map((g) => g.file.title || g.file.name).join(", ")}`
									: "Include compact excerpts of governing docs for active/changed code files (0 detected right now)"
							}
							onClick={() => setAgentCtx((s) => { s.withGoverningDocs = !s.withGoverningDocs; })}
						>
							+ Governing docs{detectedGoverningDocs().length ? ` (${detectedGoverningDocs().length})` : ""}
						</button>
						<button
							type="button"
							class="agent-ctx-chip"
							title={activeTicketDoc()?.ticketFiles?.length ? `Attach a file from ${ticket()}'s folder or anywhere in the workspace` : "Attach a workspace file to the next prompt"}
							onClick={() => void pickContextFile()}
						>
							+ File…
						</button>
						<For each={agentCtx.attachedFiles}>
							{(tf) => (
								<button
									type="button"
									class="agent-ctx-chip active"
									title={`Remove ${tf.rel} from prompt context`}
									onClick={() => setAgentCtx((s) => { s.attachedFiles = s.attachedFiles.filter((x) => x.path !== tf.path); })}
								>
									<span>{tf.rel.split("/").pop()}</span>
									<Icon name="close" />
								</button>
							)}
						</For>
					</div>
				</Show>
				<div class="composer-bar">
					<button type="button" aria-label="Start a new conversation" disabled={isBusy()} title={isBusy() ? "Wait for this reply, or stop it, before starting a new conversation." : "Start a new conversation: the agent will not see the earlier questions"} onClick={newConversation}>
						New
					</button>
					<Show when={agent.entries.length > 0}>
						<button type="button" aria-label="Clear conversation" disabled={isBusy()} title="Clear conversation history and return to starter prompts" onClick={clearConversation}>
							Clear
						</button>
					</Show>
					<Menu floating label="Insert a project prompt or starter question" title="Prompts kept in this project and starter questions" items={promptMenuItems}>
						Prompts
					</Menu>
					<span class="spacer" />
					<Show when={preSendEstimate().tokens > 0}>
						<span
							class={["agent-token-meter", { warn: preSendEstimate().warn }]}
							title={`Measured next-turn context: ${preSendEstimate().summary}${preSendEstimate().warn ? " (large for a 4K local model — consider trimming chips)" : ""}`}
						>
							~{preSendEstimate().tokens} tok
						</span>
					</Show>
					<Show when={agent.busy}>
						<button type="button" title={agent.stopping ? "opencode was asked to stop this reply. Press again to ask once more." : "Stop this reply. opencode keeps running."} onClick={() => void safely("The reply was not stopped", interrupt)}>
							{agent.stopping ? "Stopping…" : "Stop this reply"}
						</button>
					</Show>
					<button class="primary" type="submit" disabled={isBusy()} title={isBusy() ? "The agent is still working on the last request. Stop this reply to send another." : "Send (Ctrl+Enter)"}>
						Send
					</button>
				</div>
			</form>
		</div>
	);
}
