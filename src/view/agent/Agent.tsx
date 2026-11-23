// The Agent panel: opencode status and model, the tidy sequence for the
// current file, and a conversation that can include the selection.
import { Icon, type IconName } from "../Icon";
import { Menu, type MenuItem } from "../Menu";
import { showPanel } from "../panels/registry";
import { createEffect, createMemo, createResource, createSignal, For, onCleanup, onMount, Show } from "solid-js";
import { activeEditor } from "../editor/EditorGroup";
import { activeLiveEditor, liveSelectionVersion } from "../editor/liveBridge";
import { review, openReview } from "../editor/Review";
import { activeDoc, activePath, applyText, canonical, documents, notify, openFile, save, scriptsCameTo, setState, state } from "../state";
import { addEntry, agent, ask, chooseModel, clearEntries, currentModel, interrupt, resume, safely, setAgent, start, stop, type Entry } from "./store";
import { groupModels, composeQuestion, composerSend, modelRef, stepAction } from "./logic";
import { followReplyLink, renderReply } from "./markdown";
import { notePath, proposalOf, runStep, showReview, startTidy, STEPS, tidy } from "./tidy";
import { parseCsv } from "../../shared/csv";
import { frontMatter, withFrontMatter } from "../../shared/frontMatter";
import { baseName, dirName, isInside, joinPath, relativeTo } from "../../shared/paths";
import { DOC_FOLDERS, frontValue, isCatalog, promptText, registryTitle, slug } from "../../shared/projectDocs";
import type { DocFile } from "../../shared/protocol";
import { keysIn, ticketColumn } from "../../shared/registryTickets";
import { extractSchemaPreview, referencedSchemaTables } from "../../shared/schemaIndex";
import { renderTemplate } from "../../shared/templater";
import { cut, docsGoverningFile, MAX_WORK_PROMPT_CHARS, ticketForFile, ticketWork, workFor, type WorkTextOptions } from "../../shared/workContext";
import { backend } from "../backend";
import { ask as askDialog, browseWorkspaceFile, choose } from "../dialogs";
import { refreshDocAudit } from "../docAudit";
import { gitStatus, gitVersion } from "../git";
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
	const root = state.workspace?.root;
	if (!root || !isInside(root, path)) return notify("That file is not in this workspace.", "error");
	const key = canonical(path);
	const rel = relativeTo(root, path).replace(/\\/g, "/");
	setAttachedFiles((prev) => (prev.some((f) => canonical(f.path) === key) ? prev : [...prev, { path, rel }]));
	showPanel("agent");
	notify(`Attached ${baseName(path)} to Agent context.`);
}

// Module-level Agent context controls so `Ctrl+Shift+H` (`commands.ts`) and `AgentPanel` share the exact same selections.
const [withWork, setWithWork] = createSignal(recall("agent.withWork") !== "no");
const [pickedTicket, setPickedTicket] = createSignal<string | null>(null);
const [withSchema, setWithSchema] = createSignal(false);
const [withRefTables, setWithRefTables] = createSignal(false);
const [withRegistries, setWithRegistries] = createSignal(false);
const [withState, setWithState] = createSignal(false);
const [withGitDiff, setWithGitDiff] = createSignal(false);
const [withGoverningDocs, setWithGoverningDocs] = createSignal(false);
const [attachedFiles, setAttachedFiles] = createSignal<{ path: string; rel: string }[]>([]);
const [sentTick, setSentTick] = createSignal(0);

const CODE_FILE_RE = /\.(ssl|srvscr|ds|sql|ddl|pks|pkb|xfd|xml|js|ts|css|html)$/i;

/** Fast deterministic content fingerprint so mid-session edits to tickets/specs/files trigger an automatic delta re-send. */
function hashText(s: string): string {
	let h = 2166136261 >>> 0;
	for (let i = 0; i < s.length; i++) {
		h ^= s.charCodeAt(i);
		h = Math.imul(h, 16777619) >>> 0;
	}
	return `${s.length}:${h.toString(36)}`;
}

/** Per-session tracker of already-sent context slices (key -> contentHash) so unchanged context is skipped and edited context re-sends cleanly. */
let sentContext: { session: string | null; root: string | null; hashes: Map<string, string> } = {
	session: null,
	root: null,
	hashes: new Map(),
};
let lastWorkspaceRoot: string | null = null;

/** Resets all workspace-scoped Agent context & session state whenever the user opens a different folder. */
function ensureAgentWorkspace(): void {
	const curRoot = state.workspace?.root ? canonical(state.workspace.root) : null;
	if (curRoot === lastWorkspaceRoot) return;
	lastWorkspaceRoot = curRoot;
	setPickedTicket(null);
	setWithSchema(false);
	setWithRefTables(false);
	setWithRegistries(false);
	setWithState(false);
	setWithGitDiff(false);
	setWithGoverningDocs(false);
	setAttachedFiles([]);
	sentContext = { session: null, root: curRoot, hashes: new Map() };
	setAgent("chatSession", null);
	setSentTick((n) => n + 1);
}

/** Auto-detected ticket: explicit workspace activeTicket > file-specific ticket > single in-progress ticket. */
function resolvedAutoTicket(): string {
	return state.settings.activeTicket?.trim() || ticketForFile(docs(), activePath(), state.workspace?.root) || ticketAtHand();
}

/** Current ticket & extra-context options configured in the Agent panel (honored by `Ctrl+Shift+H` too). */
export function currentAgentContext(): { includeWork: boolean; ticket: string; workOptions: WorkTextOptions } {
	ensureAgentWorkspace();
	const picked = pickedTicket();
	const auto = resolvedAutoTicket();
	const ticket = picked === null ? auto : picked;
	const includeWork = Boolean(ticket) && (picked !== null || withWork());
	const root = state.workspace?.root ?? "";
	const safeFiles = root ? attachedFiles().filter((f) => isInside(root, f.path)) : [];
	return {
		includeWork,
		ticket,
		workOptions: {
			includeSchema: withSchema(),
			includeRegistries: withRegistries(),
			includeState: withState(),
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

async function readForPrompt(path: string): Promise<string | null> {
	const root = state.workspace?.root;
	if (root && !isInside(root, path)) return null;
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
	const st = gitStatus();
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
		try {
			const parsed = JSON.parse(clean) as {
				title?: string;
				goal?: string;
				targets?: { script?: string; procedures?: string[] }[];
				nodes?: { label?: string }[];
				openQuestions?: string[];
			};
			const targets = (parsed.targets ?? [])
				.map((t) => [t.script, t.procedures?.length ? `(${t.procedures.join(", ")})` : ""].filter(Boolean).join(" "))
				.filter(Boolean);
			const steps = (parsed.nodes ?? [])
				.map((n) => n.label?.trim())
				.filter((l): l is string => Boolean(l))
				.slice(0, 12);
			return [
				parsed.title ? `Title: ${parsed.title}` : "",
				parsed.goal ? `Goal: ${cut(parsed.goal.replace(/\s+/g, " "), 300)}` : "",
				targets.length ? `Targets: ${targets.join("; ")}` : "",
				steps.length ? `Steps: ${steps.join(" -> ")}` : "",
				parsed.openQuestions?.length ? `Open questions: ${parsed.openQuestions.slice(0, 4).join("; ")}` : "",
			]
				.filter(Boolean)
				.join("\n");
		} catch {
			return cut(clean, 1400);
		}
	}
	const body = frontMatter(clean).body.trim();
	return cut(body || clean, 1800);
}

/** Fetches compact staged + unstaged unified diff via `backend.gitDiff` (falling back cleanly outside git). */
async function buildGitDiffSlice(): Promise<string> {
	const [stagedDiff, unstagedDiff] = await Promise.all([
		backend.gitDiff({ staged: true, maxBytes: 24000 }).catch(() => ""),
		backend.gitDiff({ maxBytes: 24000 }).catch(() => ""),
	]);
	const chunks: string[] = [];
	if (stagedDiff.trim()) chunks.push(`STAGED GIT DIFF:\n\`\`\`diff\n${cut(stagedDiff.trim(), 5500)}\n\`\`\``);
	if (unstagedDiff.trim()) chunks.push(`UNSTAGED GIT DIFF:\n\`\`\`diff\n${cut(unstagedDiff.trim(), 5500)}\n\`\`\``);
	if (!chunks.length) return "";
	return cut(chunks.join("\n\n"), 9500);
}

type PreparedContext = {
	text: string;
	labels: string[];
	slices: Map<string, string>;
	breakdown: { label: string; chars: number; status: "pending" | "edited" | "sent" }[];
};

/**
 * Computes the exact pending context delta (ticket work, Git diff, governing docs, schema,
 * referenced tables, registries, STATE.md, attached files) with content-hash change detection:
 * unchanged already-sent slices are skipped, while edited slices re-send automatically.
 */
async function prepareContextDelta(
	ticket: string,
	workOpts: WorkTextOptions,
	alreadySent: ReadonlyMap<string, string>,
): Promise<PreparedContext> {
	const root = state.workspace?.root ?? "";
	const all = docs().filter((d) => d.exists && !isCatalog(d));
	const parts: string[] = [];
	const labels: string[] = [];
	const slices = new Map<string, string>();
	const breakdown: PreparedContext["breakdown"] = [];

	const addSlice = (key: string, label: string, content: string) => {
		const trimmed = content.trim();
		if (!trimmed) return;
		const h = hashText(trimmed);
		const prev = alreadySent.get(key);
		if (prev === h) {
			breakdown.push({ label, chars: 0, status: "sent" });
			return;
		}
		parts.push(trimmed);
		labels.push(prev ? `${label} (updated)` : label);
		slices.set(key, h);
		breakdown.push({ label, chars: trimmed.length, status: prev ? "edited" : "pending" });
	};

	// 1. Core ticket work (without standalone toggles so each slice is independently hash-tracked across Turn 1 and Turn 2+).
	const sentByTicket = new Set<string>();
	if (ticket) {
		const work = await workPrompt(ticket, { includeSchema: false, includeRegistries: false, includeState: false, ticketFiles: [] });
		if (work) {
			addSlice(`ticket:${ticket.toLowerCase()}`, work.label, work.text);
			const wf = workFor(all, ticket);
			if (wf) {
				sentByTicket.add(canonical(wf.ticket.path));
				for (const s of wf.specs) sentByTicket.add(canonical(s.path));
				for (const p of wf.plans ?? []) sentByTicket.add(canonical(p.path));
			}
		}
	}

	// 1b. Compact staged + unstaged Git diff (Wave 1.4).
	if (withGitDiff()) {
		const diffText = await buildGitDiffSlice();
		if (diffText) addSlice("git-diff", "git diff", diffText);
	}

	// 1c. Governing docs for active / changed code & SQL files (even across tickets or with Ticket=None).
	if (withGoverningDocs() && root) {
		const govItems = collectGoverningDocsForContext(all, root, activePath());
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
	if (withRefTables()) {
		const sel = selectionContext();
		const activeModelText = sel?.code || activeDoc()?.model.getValue() || "";
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

	// 5. Attached files (strictly guarded inside the active workspace root).
	for (const tf of workOpts.ticketFiles ?? []) {
		if (root && !isInside(root, tf.path)) continue;
		const content = await readForPrompt(tf.path);
		if (content !== null) {
			addSlice(
				`file:${canonical(tf.path)}`,
				baseName(tf.rel),
				`ATTACHED FILE ${tf.rel}:\n${cut(content.replace(/\r\n/g, "\n"), 3500)}`,
			);
		}
	}

	const joined = parts.join("\n\n");
	const capped = joined.length <= MAX_WORK_PROMPT_CHARS ? joined : cut(joined, MAX_WORK_PROMPT_CHARS);
	return { text: capped, labels, slices, breakdown };
}

export async function askAbout(
	question: string,
	includeSelection: boolean,
	includeWork = false,
	extra?: { ticket?: string; workOptions?: WorkTextOptions },
) {
	ensureAgentWorkspace();
	const path = activePath();
	const root = state.workspace?.root ?? "";
	const context = includeSelection ? selectionContext() : null;
	const file = path ? relativeTo(root, path) : "";
	const ticket = includeWork ? (extra?.ticket ?? resolvedAutoTicket()) : "";
	const workOpts = extra?.workOptions ?? {};

	// Reset delta tracker whenever starting a brand-new conversation session or switching workspaces.
	const curRoot = root ? canonical(root) : null;
	if (!agent.chatSession || sentContext.session !== agent.chatSession || sentContext.root !== curRoot) {
		sentContext = { session: agent.chatSession, root: curRoot, hashes: new Map() };
	}

	const prepared = await prepareContextDelta(ticket, workOpts, sentContext.hashes);
	const text = composeQuestion(question, context && { ...context, file }, prepared.text || undefined);
	const withWhat = [context ? `${file} ${context.label}` : "", ...prepared.labels].filter(Boolean).join("; ");
	const isCatalogPrompt = /INDEX\.md|Update catalogs/i.test(question);
	const reply = await ask(text, {
		title: "SSL Studio chat",
		keep: true,
		sessionID: agent.chatSession ?? undefined,
		show: withWhat ? `${question}  (with ${withWhat})` : question,
		turn: {
			ticket: ticket || undefined,
			codePath: path && root && isInside(root, path) ? path : undefined,
			isCatalogPrompt,
		},
	});
	if (reply) {
		setAgent("chatSession", reply.sessionID);
		// Commit context slice hashes ONLY when the turn actually succeeded (never on failed/interrupted turns!).
		if (reply.outcome === "succeeded") {
			if (sentContext.session !== reply.sessionID) {
				const next = new Map(sentContext.hashes);
				for (const [k, v] of prepared.slices) next.set(k, v);
				sentContext = { session: reply.sessionID, root: curRoot, hashes: next };
			} else {
				for (const [k, v] of prepared.slices) sentContext.hashes.set(k, v);
			}
			setSentTick((n) => n + 1);
		}
	}
}

type FencedBlock = { lang: string; code: string };

/** Fence-depth-aware Markdown block extractor supporting ``` and ~~~ fences and nested blocks inside markdown replies. */
function extractFencedBlocks(markdown: string): FencedBlock[] {
	const lines = markdown.replace(/\r\n/g, "\n").split("\n");
	const blocks: FencedBlock[] = [];
	let active: { ch: string; len: number; lang: string; lines: string[] } | null = null;
	for (const line of lines) {
		if (!active) {
			const m = /^[ \t]{0,3}(`{3,}|~{3,})([^\n]*)$/.exec(line);
			if (m) {
				const ch = m[1]![0]!;
				const info = m[2]!.trim();
				if (ch === "`" && info.includes("`")) continue;
				active = { ch, len: m[1]!.length, lang: (info.split(/\s+/)[0] ?? "").toLowerCase(), lines: [] };
			}
		} else {
			const isClose = new RegExp(`^[ \\t]{0,3}${active.ch}{${active.len},}[ \\t]*$`).test(line);
			if (isClose) {
				const code = active.lines.join("\n").trim();
				if (code) blocks.push({ lang: active.lang, code });
				active = null;
			} else {
				active.lines.push(line);
			}
		}
	}
	return blocks;
}

/** Applies a simple unified diff hunk block onto `original`; returns `null` if hunks do not cleanly apply. */
function applySimpleUnifiedDiff(original: string, diffText: string): string | null {
	const origLines = original.replace(/\r\n/g, "\n").split("\n");
	const diffLines = diffText.replace(/\r\n/g, "\n").split("\n");
	const hunks: { oldStart: number; lines: string[] }[] = [];
	let cur: { oldStart: number; lines: string[] } | null = null;
	for (const line of diffLines) {
		const h = /^@@\s+-(\d+)(?:,\d+)?\s+\+\d+(?:,\d+)?\s+@@/.exec(line);
		if (h) {
			cur = { oldStart: Math.max(1, Number(h[1])), lines: [] };
			hunks.push(cur);
		} else if (cur && (/^[ +-]/.test(line) || line === "")) {
			cur.lines.push(line === "" ? " " : line);
		}
	}
	if (!hunks.length) return null;
	const result = [...origLines];
	let delta = 0;
	for (const hunk of hunks) {
		const expectedOld = hunk.lines.filter((l) => l[0] === " " || l[0] === "-").map((l) => l.slice(1));
		const nextNew = hunk.lines.filter((l) => l[0] === " " || l[0] === "+").map((l) => l.slice(1));
		const at = hunk.oldStart - 1 + delta;
		const matchesAt = (pos: number) =>
			pos >= 0 &&
			pos + expectedOld.length <= result.length &&
			expectedOld.every((line, i) => result[pos + i] === line);
		let pos = at;
		if (!matchesAt(pos)) {
			// Search within +/-15 lines for shifted hunk context.
			let found = -1;
			for (let off = 1; off <= 15; off++) {
				if (matchesAt(at - off)) {
					found = at - off;
					break;
				}
				if (matchesAt(at + off)) {
					found = at + off;
					break;
				}
			}
			if (found < 0) return null;
			pos = found;
		}
		result.splice(pos, expectedOld.length, ...nextNew);
		delta += nextNew.length - expectedOld.length;
	}
	return result.join("\n");
}

/** Extracts the best fenced code/Markdown block (prompting when multiple blocks exist) and opens side-by-side ReviewView against a workspace file. */
async function reviewProposedEdit(replyText: string, preferredPath?: string) {
	const root = state.workspace?.root;
	if (!root) return notify("Open a folder first.");

	const curActive = activePath() || "";
	const openCur = preferredPath || curActive;
	const candidates: { label: string; path: string }[] = [];
	if (openCur && isInside(root, openCur)) {
		const tag = preferredPath && canonical(preferredPath) !== canonical(curActive) ? "(from turn)" : "(active file)";
		candidates.push({ label: `${relativeTo(root, openCur)} ${tag}`, path: openCur });
	}
	const PICK_OTHER = "Choose another workspace file…";
	let targetPath = openCur;
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
		targetPath = chosen.path;
	}

	const original = (await readForPrompt(targetPath)) ?? "";
	const targetLang = languageFor(targetPath).toLowerCase();
	const blocks = extractFencedBlocks(replyText);
	let chosenBlock: FencedBlock | null = null;
	if (blocks.length === 1) {
		chosenBlock = blocks[0]!;
	} else if (blocks.length > 1) {
		// Prioritize blocks matching the target file's language (e.g. SSL over small SQL/example snippets).
		const ranked = [...blocks].sort((a, b) => {
			const aMatch = a.lang === targetLang ? 0 : 1;
			const bMatch = b.lang === targetLang ? 0 : 1;
			return aMatch - bMatch || b.code.length - a.code.length;
		});
		const labels = ranked.map((b, i) => {
			const lines = b.code.split("\n").length;
			const first = b.code.split("\n")[0]!.trim().slice(0, 48);
			return `Block ${i + 1} (${b.lang || "text"}, ${lines} lines): ${first}`;
		});
		const FULL_REPLY = "Use full reply text";
		const picked = await choose("This reply has multiple code blocks. Which one should be diffed?", [...labels, FULL_REPLY]);
		if (!picked) return;
		const idx = labels.indexOf(picked);
		chosenBlock = idx >= 0 ? ranked[idx]! : null;
	}

	let proposed = `${(chosenBlock ? chosenBlock.code : replyText).trim()}\n`;
	const isDiffBlock = Boolean(chosenBlock && (/^(diff|patch)$/i.test(chosenBlock.lang) || /^@@\s+-\d+/m.test(chosenBlock.code)));
	if (isDiffBlock && chosenBlock) {
		const patched = applySimpleUnifiedDiff(original, chosenBlock.code);
		if (patched !== null) {
			proposed = patched.endsWith("\n") ? patched : `${patched}\n`;
		} else {
			notify("The reply contains a unified diff patch that could not be cleanly applied automatically; inspect the right pane before accepting.", "error");
		}
	}

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
			const key = canonical(targetPath);
			if (documents.get(key)) {
				applyText(key, final);
			} else {
				await backend.historyKeep(targetPath).catch(() => {});
				await backend.write(targetPath, final);
				void scriptsCameTo(targetPath, targetPath, "file");
				setState("treeVersion", (v) => v + 1);
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
	setState("treeVersion", (v) => v + 1);
	setState("mdText", canonical(dest), true);
	refreshDocAudit();
	await openFile(dest, { keep: true });
	notify(`Saved spec ${baseName(dest)}${linkedTicket ? ` linked to ${linkedTicket}` : ""}.`);
	return dest;
}

/** One entry of the conversation. A reply is Markdown with 1-click actions to capture it into project docs or diff it in ReviewView. */
function EntryView(props: { entry: Entry }) {
	const html = createMemo(() => (props.entry.role === "agent" ? renderReply(props.entry.text) : ""));
	const entryTicket = () => props.entry.turn?.ticket;
	const entryCode = () => props.entry.turn?.codePath;
	const activeTicketForReply = () =>
		entryTicket() ||
		state.settings.activeTicket?.trim() ||
		(pickedTicket() || "").trim() ||
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
	const saveReplySnippet = async () => {
		const blocks = replyCodeBlocks();
		if (!blocks.length) return;
		const chosen =
			blocks.length === 1
				? blocks[0]!
				: await (async () => {
						const labels = blocks.map((b, i) => `Block ${i + 1} (${b.lang || "code"}, ${b.code.split("\n").length} lines)`);
						const picked = await choose("Save which code block as a kept snippet?", labels);
						const idx = picked ? labels.indexOf(picked) : -1;
						return idx >= 0 ? blocks[idx]! : null;
					})();
		if (chosen) await saveAsSnippet(chosen.code, chosen.lang);
	};
	const answerOpenQuestion = async () => {
		const questions = openQuestionsForTicket();
		if (!questions.length) return;
		let target: DocFile | null = questions[0]!;
		if (questions.length > 1) {
			const labels = questions.map((q) => q.title || q.name);
			const picked = await choose(`Write this reply as the answer to which open question for ${activeTicketForReply()}?`, labels);
			const idx = picked ? labels.indexOf(picked) : -1;
			target = idx >= 0 ? questions[idx]! : null;
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
		let next = withQuestionAnswer(cur, props.entry.text);
		if (action === WRITE_MARK) {
			next = withFrontMatter(next, "status", "answered") ?? next;
		}
		if (open) {
			const clean = !state.dirty[key];
			applyText(key, next);
			if (clean) await save(key, { format: false });
		} else {
			await backend.historyKeep(target.path).catch(() => {});
			await backend.write(target.path, next);
		}
		setState("treeVersion", (v) => v + 1);
		refreshDocAudit();
		await openFile(target.path, { keep: true });
		notify(`Recorded answer in ${target.title || baseName(target.path)}.`);
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
						<Show when={replyCodeBlocks().length > 0}>
							<button type="button" class="link" title="Save code block as a kept snippet in docs/knowledge/snippets/" onClick={() => void saveReplySnippet()}>
								Save as Snippet
							</button>
						</Show>
						<button type="button" class="link" title="Save this reply as a Spec in docs/specs/ linked to the active ticket" onClick={() => void saveReplyAsSpec(props.entry.text, activeTicketForReply() || undefined)}>
							Save as Spec…
						</button>
						<button type="button" class="link" title="Save this reply as a Decision ADR" onClick={() => void promoteToKnowledge("decisions", { body: props.entry.text, ticket: activeTicketForReply() || undefined, codePath: entryCode() })}>
							Save as Decision
						</button>
						<button type="button" class="link" title="Save this reply as a Question" onClick={() => void promoteToKnowledge("questions", { body: props.entry.text, ticket: activeTicketForReply() || undefined, codePath: entryCode() })}>
							Save as Question
						</button>
						<button type="button" class="link" title="Save this reply as a Reference note" onClick={() => void promoteToKnowledge("reference", { body: props.entry.text, ticket: activeTicketForReply() || undefined, codePath: entryCode() })}>
							Save as Note
						</button>
						<Show when={openQuestionsForTicket().length > 0}>
							<button
								type="button"
								class="link"
								title={`Write this reply into ## Answer for an open question on ${activeTicketForReply()}`}
								onClick={() => void answerOpenQuestion()}
							>
								Answer open question…
							</button>
						</Show>
						<Show when={activeTicketForReply()}>
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
	createEffect(() => {
		state.workspace?.root;
		ensureAgentWorkspace();
	});
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
			if (handed.cleanContext) {
				setWithSelection(false);
				setPickedTicket("");
				setWithSchema(false);
				setWithRefTables(false);
				setWithRegistries(false);
				setWithState(false);
				setWithGitDiff(false);
				setWithGoverningDocs(false);
				setAttachedFiles([]);
			}
			setDraft(handed.text);
			setNotSent("");
			queueMicrotask(() => box?.focus());
		})();
	});
	const [notSent, setNotSent] = createSignal("");
	const [withSelection, setWithSelection] = createSignal(true);
	// The ticket at hand and selection size react immediately to editor edits AND cursor selection changes.
	const [edited, setEdited] = createSignal(0);
	createEffect(() => {
		const doc = activeDoc();
		const editor = activeEditor();
		const d1 = doc?.model.onDidChangeContent(() => setEdited((n) => n + 1));
		const d2 = editor?.onDidChangeCursorSelection(() => setEdited((n) => n + 1));
		onCleanup(() => {
			d1?.dispose();
			d2?.dispose();
		});
	});
	const autoTicket = createMemo(() => (edited(), resolvedAutoTicket()));
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
	const detectedRefTables = createMemo(() => {
		edited();
		liveSelectionVersion();
		const doc = activeDoc();
		if (!doc || doc.binary) return [] as DocFile[];
		const txt = selectionContext()?.code || doc.model.getValue() || "";
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
	// Real measured next-turn delta size & token budget (approx 1 token ≈ 4 chars), reflecting sent/edited/pending slices.
	const [measuredDelta] = createResource(
		() => {
			const targetTicket = ticket();
			const sendWork = Boolean(targetTicket) && (pickedTicket() !== null || withWork());
			return {
				root: state.workspace?.root ?? "",
				ticket: sendWork ? targetTicket : "",
				schema: withSchema(),
				refTables: withRefTables(),
				regs: withRegistries(),
				st: withState(),
				gitDiff: withGitDiff(),
				govDocs: withGoverningDocs(),
				gitVer: gitVersion(),
				curPath: activePath() ?? "",
				files: attachedFiles().map((f) => `${f.path}|${f.rel}`),
				tree: state.treeVersion,
				sent: sentTick(),
				ed: edited(),
				liveSel: liveSelectionVersion(),
				session: agent.chatSession ?? "",
			};
		},
		async (src) => {
			if (!src.root) return { chars: 0, breakdown: [] as PreparedContext["breakdown"] };
			const curRoot = canonical(src.root);
			const already = sentContext.session === (src.session || null) && sentContext.root === curRoot ? sentContext.hashes : new Map<string, string>();
			const prepared = await prepareContextDelta(
				src.ticket,
				{
					includeSchema: src.schema,
					includeRegistries: src.regs,
					includeState: src.st,
					ticketFiles: attachedFiles(),
				},
				already,
			);
			return { chars: prepared.text.length, breakdown: prepared.breakdown };
		},
	);
	const preSendEstimate = createMemo(() => {
		edited();
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
		const root = state.workspace?.root;
		if (!root) return notify("Open a folder first.");
		const already = new Set(attachedFiles().map((f) => canonical(f.path)));
		const ticketFiles = (activeTicketDoc()?.ticketFiles ?? []).filter((f) => !already.has(canonical(f.path)));
		const picked = await browseWorkspaceFile({
			title: "Attach file to Agent",
			root,
			pinned: ticketFiles.map((f) => ({ path: f.path, rel: f.rel, detail: f.rel })),
			pinnedLabel: ticket() || "Ticket",
			exclude: attachedFiles().map((f) => f.path),
		});
		if (!picked || !isInside(root, picked.path)) return;
		setAttachedFiles((prev) =>
			prev.some((f) => canonical(f.path) === canonical(picked.path)) ? prev : [...prev, picked],
		);
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
		sentContext = { session: null, root: lastWorkspaceRoot, hashes: new Map() };
		setAgent("chatSession", null);
		setSentTick((n) => n + 1);
		if (agent.entries.at(-1)?.text !== NEW_CONVERSATION) addEntry({ role: "note", text: NEW_CONVERSATION });
		toEnd();
	};
	const clearConversation = () => {
		sentContext = { session: null, root: lastWorkspaceRoot, hashes: new Map() };
		setSentTick((n) => n + 1);
		clearEntries();
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
							const picked = await choose(placeholder || "Choose an option", labels);
							if (!picked) return null;
							const idx = labels.indexOf(picked);
							return idx >= 0 ? (values[idx] ?? picked) : picked;
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
		setWithGitDiff(true);
		setWithGoverningDocs(true);
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
		setWithGitDiff(true);
		setWithState(true);
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
					if (govDocs.length > 0) setWithGoverningDocs(true);
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
					if (!ticket() && govDocs.length > 0) setWithGoverningDocs(true);
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
						<Show when={detectedRefTables().length > 0 || withRefTables()}>
							<button
								type="button"
								class="agent-ctx-chip"
								classList={{ active: withRefTables() }}
								aria-pressed={withRefTables()}
								title={
									detectedRefTables().length
										? `Inject exact column definitions for schema tables referenced in this file: ${detectedRefTables().map((d) => d.title || d.name).join(", ")}`
										: "Table schema injection is active (0 tables detected on the current tab). Click to disable."
								}
								onClick={() => setWithRefTables((v) => !v)}
							>
								+ Tables ({detectedRefTables().length})
							</button>
						</Show>
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
							classList={{ active: withGitDiff() }}
							aria-pressed={withGitDiff()}
							title={
								gitStatus()
									? `Include compact staged + unstaged Git diff (${gitStatus()!.files.length} changed ${gitStatus()!.files.length === 1 ? "file" : "files"})`
									: "Include compact staged + unstaged Git diff (no git repository detected)"
							}
							onClick={() => setWithGitDiff((v) => !v)}
						>
							+ Git diff
						</button>
						<button
							type="button"
							class="agent-ctx-chip"
							classList={{ active: withGoverningDocs() }}
							aria-pressed={withGoverningDocs()}
							title={
								detectedGoverningDocs().length
									? `Include compact excerpts of governing docs for active/changed code files: ${detectedGoverningDocs().map((g) => g.file.title || g.file.name).join(", ")}`
									: "Include compact excerpts of governing docs for active/changed code files (0 detected right now)"
							}
							onClick={() => setWithGoverningDocs((v) => !v)}
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
						<span
							class="agent-token-meter"
							classList={{ warn: preSendEstimate().warn }}
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
					<button class="primary" type="submit" disabled={agent.busy} title={agent.busy ? "The agent is still working on the last request. Stop this reply to send another." : "Send (Ctrl+Enter)"}>
						Send
					</button>
				</div>
			</form>
		</div>
	);
}
