// The tidy sequence (the style guide's six ssl-tidy-* skills) on one file,
// one reviewed step at a time. The skills expect to read the file, search
// the project and keep a context note; the agent here has no file tools
// (M0), so SSL Studio supplies the file, the note and the callers it finds
// through the language server, and keeps the note at the skills' own path,
// design/<name>.tidy.md. Each step's result is checked as the cleanup
// runner did: no new findings, procedures and parameters unchanged, and the
// comments step changing comments only.
import { createStore, snapshot } from "solid-js";
import { localDay } from "../../shared/dates";
import { backend } from "../backend";
import { openReview, type Check, type Review } from "../editor/Review";
import { monaco } from "../editor/monaco";
import { codeOnly } from "../editor/textmate";
import { session } from "../lsp/session";
import { applyText, canonical, documents, keepTab, notify, save, state } from "../state";
import { isAllowedContextPath } from "../plan/assist";
import { addEntry, ask, safely } from "./store";
import type { StepState } from "./logic";
import { baseName, isInside, joinPath, relativeTo } from "../../shared/paths";
import { ticketForFile } from "../../shared/workContext";
import { docs } from "../project";
import { workPrompt } from "../projectDocs";

export type StepKind = "note" | "code" | "report";
export const STEPS: { skill: string; title: string; kind: StepKind; commentsOnly?: boolean }[] = [
	{ skill: "ssl-tidy-context", title: "Context", kind: "note" },
	{ skill: "ssl-tidy-guards", title: "Guards", kind: "code" },
	{ skill: "ssl-tidy-structure", title: "Structure", kind: "code" },
	{ skill: "ssl-tidy-clarity", title: "Clarity", kind: "code" },
	{ skill: "ssl-tidy-comments", title: "Comments", kind: "code", commentsOnly: true },
	{ skill: "ssl-tidy-verify", title: "Verify", kind: "report" },
];
export type { StepState };

export const [tidy, setTidy] = createStore({
	path: null as string | null,
	steps: STEPS.map(() => "pending" as StepState),
	/** Why a step failed, or what it is waiting for; empty otherwise. */
	problems: STEPS.map(() => ""),
});

/** Each step's proposal while it is under review, so it can be shown again if another review took its place. */
const proposals = new Map<number, Review>();
/** Counts the tidy runs: a step that finishes after "Restart" must not mark the new run's steps. */
let generation = 0;

const rel = (path: string, root: string | undefined = state.workspace?.root) => relativeTo(root, path);
const base = (path: string) => baseName(path).replace(/\.[^.]+$/, "");

/** Disambiguates tidy note paths by the script's relative path under `design/` so `src/A/Util.ssl` and `src/B/Util.ssl` never collide. */
export const notePath = (path: string, root: string | undefined = state.workspace?.root): string => {
	const relPath = root && isInside(root, path) ? relativeTo(root, path).replace(/\\/g, "/") : baseName(path);
	const parts = relPath.split("/").filter((p) => p && p !== "." && p !== "..");
	if (!parts.length) parts.push(baseName(path));
	parts[parts.length - 1] = `${parts[parts.length - 1]!.replace(/\.[^.]+$/, "")}.tidy.md`;
	return root ? joinPath(root, "design", ...parts) : joinPath("design", ...parts);
};

export function startTidy() {
	const cur = snapshot(state);
	const path = cur.groups[cur.activeGroup]?.active ?? null;
	const root = cur.workspace?.root;
	if (!path || documents.get(path)?.model.getLanguageId() !== "ssl") return notify("Open an SSL file to tidy.");
	if (!root || !isInside(root, path)) return notify("Open an SSL file inside the workspace to tidy.");
	generation++;
	// The steps are proposed for this file: its tab stays while they are.
	keepTab(path);
	proposals.clear();
	setTidy((s) => {
		s.path = path;
		s.steps = STEPS.map(() => "pending");
		s.problems = STEPS.map(() => "");
	});
}

/** Clears tidy state and pending step proposals (e.g. when switching workspaces). */
export function resetTidy() {
	generation++;
	proposals.clear();
	setTidy((s) => {
		s.path = null;
		s.steps = STEPS.map(() => "pending");
		s.problems = STEPS.map(() => "");
	});
}

/** The proposal a step has under review, if any: the panel compares it with the review that is open. */
export const proposalOf = (index: number) => proposals.get(index);

/** Opens a step's proposal again, after another review was kept in its place. */
export async function showReview(index: number) {
	const proposal = proposals.get(index);
	if (proposal) await present(index, proposal);
}

/** Shows a proposal. If the user keeps another review open instead, it waits behind the step's "Show review". */
async function present(index: number, proposal: Review) {
	const shown = await openReview(proposal);
	if (proposals.get(index) !== proposal) return;
	setTidy((s) => {
		s.problems[index] = shown ? "" : "Its proposal is waiting: press Show review when the other review is closed.";
	});
	if (!shown) notify(`${STEPS[index]!.title}: the proposal is kept. Press Show review in the Agent panel to see it.`);
}

async function readNote(path: string, root: string | undefined = state.workspace?.root): Promise<string | null> {
	const target = notePath(path, root);
	const open = documents.get(canonical(target));
	if (open) return open.model.getValue();
	try {
		return (await backend.read(target)).text;
	} catch {
		return null;
	}
}

async function writeNoteFile(noteFile: string, content: string) {
	const key = canonical(noteFile);
	const open = documents.get(key);
	if (open && !open.model.isDisposed()) {
		const clean = !state.dirty[key];
		if (applyText(key, content)) {
			if (clean) await save(key, { format: false });
			return;
		}
	}
	await backend.write(noteFile, content);
}

function matchesFenceLanguage(actual: string, wanted: string): boolean {
	const a = actual.toLowerCase();
	const w = wanted.toLowerCase();
	if (a === w) return true;
	return (w === "markdown" || w === "md") && (a === "markdown" || a === "md");
}

/**
 * Fence-depth-aware CommonMark extractor for blocks of one language from a reply
 * (`markdown`/`md` aliased, supports ``` and ~~~ of any length >= 3, and only
 * closes on standalone line-start fences so ``` inside SSL comments/strings never truncates).
 */
export function fenced(text: string, language: string): string[] {
	const lines = text.replace(/\r\n/g, "\n").split("\n");
	const blocks: string[] = [];
	let active: { ch: string; len: number; lang: string; closeRe: RegExp; lines: string[] } | null = null;
	for (const line of lines) {
		if (!active) {
			const m = /^[ \t]{0,3}(`{3,}|~{3,})([^\n]*)$/.exec(line);
			if (m) {
				const ch = m[1]![0]!;
				const info = m[2]!.trim();
				if (ch === "`" && info.includes("`")) continue;
				const len = m[1]!.length;
				active = {
					ch,
					len,
					lang: (info.split(/\s+/)[0] ?? "").toLowerCase(),
					closeRe: new RegExp(`^[ \\t]{0,3}${ch}{${len},}[ \\t]*$`),
					lines: [],
				};
			}
		} else if (active.closeRe.test(line)) {
			if (matchesFenceLanguage(active.lang, language)) {
				blocks.push(active.lines.join("\n"));
			}
			active = null;
		} else {
			active.lines.push(line);
		}
	}
	return blocks;
}

/**
 * Picks the primary/full-file SSL block from a tidy reply rather than blindly
 * taking a tiny trailing illustrative `.at(-1)` snippet.
 */
export function pickPrimarySslBlock(blocks: readonly string[], originalText: string): string | undefined {
	if (!blocks.length) return undefined;
	if (blocks.length === 1) return blocks[0];
	const maxLen = Math.max(...blocks.map((b) => b.length));
	const substantial = blocks.filter((b) => b.length >= maxLen * 0.5);
	const origNorm = originalText.replace(/\r\n/g, "\n").trim();
	const modified = substantial.filter((b) => b.trim() !== origNorm);
	const pool = modified.length ? modified : substantial;
	const nonEmptyLines = (s: string) => s.split("\n").filter((l) => l.trim().length > 0).length;
	return [...pool].sort((a, b) => b.length - a.length || nonEmptyLines(b) - nonEmptyLines(a))[0];
}

/** True only when the reply explicitly states `UNCHANGED` on its own line outside fenced code blocks. */
export function isExplicitUnchanged(replyText: string): boolean {
	const lines = replyText.replace(/\r\n/g, "\n").split("\n");
	const prose: string[] = [];
	let active: { ch: string; len: number; closeRe: RegExp } | null = null;
	for (const line of lines) {
		if (!active) {
			const m = /^[ \t]{0,3}(`{3,}|~{3,})([^\n]*)$/.exec(line);
			if (m) {
				const ch = m[1]![0]!;
				const info = m[2]!.trim();
				if (!(ch === "`" && info.includes("`"))) {
					const len = m[1]!.length;
					active = { ch, len, closeRe: new RegExp(`^[ \\t]{0,3}${ch}{${len},}[ \\t]*$`) };
					continue;
				}
			}
			prose.push(line);
		} else if (active.closeRe.test(line)) {
			active = null;
		}
	}
	return /^[ \t]*(?:[*_`]*unchanged[*_`]*)[\t .!]*$/im.test(prose.join("\n"));
}

/** Call sites in other files, from the language server's references, plus a text search for the script's name. */
async function callers(path: string, model: monaco.editor.ITextModel, root: string): Promise<string> {
	const selfKey = canonical(path);
	const isAllowedCaller = (filePath: string) => {
		if (!root || !isInside(root, filePath)) return false;
		if (canonical(filePath) === selfKey) return false;
		return isAllowedContextPath(relativeTo(root, filePath));
	};
	const lines: string[] = [];
	const procedures: monaco.languages.DocumentSymbol[] = [];
	const walk = (list: monaco.languages.DocumentSymbol[]) =>
		list.forEach((s) => (s.kind === monaco.languages.SymbolKind.Function || s.kind === monaco.languages.SymbolKind.Method ? procedures.push(s) : walk(s.children ?? [])));
	walk(await session.documentSymbols(model).catch(() => []));
	for (const p of procedures) {
		const refs = (await session
			.request("textDocument/references", { textDocument: { uri: model.uri.toString() }, position: { line: p.selectionRange.startLineNumber - 1, character: p.selectionRange.startColumn - 1 }, context: { includeDeclaration: false } })
			.catch(() => [])) as { uri: string; range: any }[];
		for (const r of refs ?? []) {
			const file = monaco.Uri.parse(r.uri).fsPath;
			if (!isAllowedCaller(file)) continue;
			const target = await session.ensureModel(r.uri);
			lines.push(`${p.name} ← ${rel(file, root)}:${r.range.start.line + 1}: ${target?.getLineContent(r.range.start.line + 1).trim() ?? ""}`);
		}
	}
	for (const hit of (await backend.search(base(path), { caseSensitive: false }).catch(() => [])).filter((h) => isAllowedCaller(h.path)).slice(0, 60))
		lines.push(`text "${base(path)}" ← ${rel(hit.path, root)}:${hit.line}: ${hit.text.trim()}`);
	return lines.length ? lines.join("\n") : "(none found in the workspace)";
}

function prompt(step: (typeof STEPS)[number], index: number, path: string, root: string, text: string, note: string | null, found?: string, workContext?: string) {
	const reply =
		step.kind === "note"
			? "Reply with the complete context note in one ```markdown block, and nothing else."
			: step.kind === "code"
				? "Reply with the whole file after this step's changes in one ```ssl block (or the single word UNCHANGED when nothing should change), then this step's change-log entry for the context note in one ```markdown block."
				: "Reply with the verification report in one ```markdown block.";
	const noteRel = rel(notePath(path, root), root).replace(/\\/g, "/");
	return [
		`Run step ${index + 1} of 6 of the SSL cleanup sequence (skill ${step.skill}) on the file below.`,
		"You are inside SSL Studio. In this session you cannot read, search or write files: everything the step needs is below, and SSL Studio will save what you return after the user reviews it. Work only from this message.",
		reply,
		"",
		`FILE ${rel(path, root)} (${text.split("\n").length} lines, complete):`,
		"```ssl",
		text,
		"```",
		...(note ? ["", `CONTEXT NOTE ${noteRel}:`, "```markdown", note, "```"] : []),
		...(found ? ["", "CALLERS SSL Studio found (language server references, and a text search for the script name; scope: the open workspace):", "```", found, "```"] : []),
		...(workContext ? ["", workContext] : []),
	].join("\n");
}

function procedureShape(symbols: monaco.languages.DocumentSymbol[]): string[] {
	const out: string[] = [];
	const walk = (list: monaco.languages.DocumentSymbol[]) =>
		list.forEach((s) =>
			s.kind === monaco.languages.SymbolKind.Function || s.kind === monaco.languages.SymbolKind.Method ? out.push(`${s.name}(${(s.children ?? []).map((c) => c.name).join(", ")})`) : walk(s.children ?? []),
		);
	walk(symbols);
	return out.sort();
}

export type AnalyzeSnapshot = {
	diagnostics: { code?: string }[];
	symbols: monaco.languages.DocumentSymbol[];
	timedOut: boolean;
};

/** Evaluates tidy verification checks; marks LSP-dependent and grammar-dependent checks as `ok: null` whenever unverified. */
export function evaluateTidyChecks(
	a: AnalyzeSnapshot,
	b: AnalyzeSnapshot,
	before: string,
	after: string,
	commentsOnly: boolean,
	codeOnlyFn: (text: string) => string | null = codeOnly,
): Check[] {
	const count = (list: { code?: string }[]) => list.reduce((m, d) => m.set(d.code ?? "?", (m.get(d.code ?? "?") ?? 0) + 1), new Map<string, number>());
	const ca = count(a.diagnostics);
	const added = [...count(b.diagnostics)].filter(([code, n]) => n > (ca.get(code) ?? 0)).map(([code, n]) => `${code} +${n - (ca.get(code) ?? 0)}`);
	const shapeA = procedureShape(a.symbols).join("; ");
	const shapeB = procedureShape(b.symbols).join("; ");
	// A server that did not answer has found nothing because it said nothing: neither findings nor procedure shapes are verified.
	const silent = a.timedOut || b.timedOut;
	const result: Check[] = [
		silent
			? { label: "The language server did not answer", ok: null, detail: "new findings could not be checked. Reject and run the step again when the server is ready, or check the result yourself." }
			: { label: "No new findings", ok: !added.length, detail: added.join(", ") || `${b.diagnostics.length} findings after, ${a.diagnostics.length} before` },
		silent
			? { label: "Procedures and parameters unchanged", ok: null, detail: "could not be checked because the language server did not answer." }
			: { label: "Procedures and parameters unchanged", ok: shapeA === shapeB, detail: shapeA === shapeB ? undefined : `before: ${shapeA} · after: ${shapeB}` },
	];
	if (commentsOnly) {
		const codeA = codeOnlyFn(before);
		const codeB = codeOnlyFn(after);
		result.push(
			codeA === null || codeB === null
				? { label: "Only comments changed", ok: null, detail: "SSL grammar is not loaded yet; verify manually that only comments changed." }
				: { label: "Only comments changed", ok: codeA === codeB },
		);
	}
	const kb = (s: string) => (new TextEncoder().encode(s).length / 1024).toFixed(1);
	result.push({ label: "Size", ok: null, detail: `${kb(before)} KB → ${kb(after)} KB` });
	return result;
}

async function checks(before: string, after: string, commentsOnly: boolean): Promise<Check[]> {
	const [a, b] = await Promise.all([session.analyze(before), session.analyze(after)]);
	return evaluateTidyChecks(a, b, before, after, commentsOnly);
}

async function appendToNote(path: string, heading: string, entry: string, root: string | undefined = state.workspace?.root) {
	const target = notePath(path, root);
	const note = (await readNote(path, root)) ?? `# Tidy notes: ${rel(path, root)}\n`;
	await writeNoteFile(target, `${note.replace(/\s*$/, "")}\n\n## ${heading} (${localDay()})\n\n${entry.trim()}\n`);
}

/** Runs one step. Whatever goes wrong, the step ends in a state it can be run again from. */
export async function runStep(index: number) {
	const pinnedRoot = snapshot(state).workspace?.root;
	const path = snapshot(tidy).path;
	const doc = path ? documents.get(path) : undefined;
	if (!pinnedRoot || !path || !doc) return notify("The file being tidied is not open.");
	if (!isInside(pinnedRoot, path)) return notify("The file being tidied is outside the open workspace.");
	const pinnedRootCanon = canonical(pinnedRoot);
	const startVersion = doc.model.getAlternativeVersionId();
	const targetNote = notePath(path, pinnedRoot);
	const stillSameWorkspace = () => {
		const root = snapshot(state).workspace?.root;
		return Boolean(root && canonical(root) === pinnedRootCanon);
	};
	const step = STEPS[index]!;
	const mine = generation;
	/** Moves the step on, unless the tidy was restarted or the workspace changed meanwhile. */
	const mark = (to: StepState, problem = "") => {
		if (mine !== generation || !stillSameWorkspace()) return;
		if (to !== "review") proposals.delete(index);
		setTidy((s) => {
			s.steps[index] = to;
			s.problems[index] = problem;
		});
	};
	/** Puts a proposal up for review and remembers it until it is accepted or rejected. */
	const propose = async (proposal: Review) => {
		if (mine !== generation || !stillSameWorkspace()) return;
		proposals.set(index, proposal);
		mark("review");
		await present(index, proposal);
	};
	await safely(
		`Tidy step ${index + 1} (${step.title}) did not finish`,
		async () => {
			const note = await readNote(path, pinnedRoot);
			if (index > 0 && !note && step.kind !== "note") return notify("Run the context step first: the later steps rely on its note.");
			mark("running");
			const text = doc.model.getValue();
			const found = step.kind === "note" ? await callers(path, doc.model, pinnedRoot) : undefined;
			// Only attach governing ticket context on Step 0 (Context) using this script's actual linked ticket — never an unrelated active ticket!
			const scriptTicket = index === 0 ? ticketForFile(docs(), path, pinnedRoot) : "";
			const work = scriptTicket ? await workPrompt(scriptTicket, { specs: false }).catch(() => null) : null;
			const reply = await ask(prompt(step, index, path, pinnedRoot, text, note, found, work?.text), { title: `Tidy ${step.title}: ${rel(path, pinnedRoot)}`, skills: [step.skill], show: `Tidy step ${index + 1}, ${step.title.toLowerCase()}: ${rel(path, pinnedRoot)}` });
			if (mine !== generation || !stillSameWorkspace()) return;
			if (!reply) return mark("failed", "The request did not go through: the conversation below says why.");
			if (reply.outcome !== "succeeded") return mark("failed", reply.outcome === "interrupted" ? `Stopped before it finished${reply.error ? `: ${reply.error}` : "."}` : `The reply ${reply.outcome === "timeout" ? "timed out" : "failed"}${reply.error ? `: ${reply.error}` : "."}`);
			const markdown = fenced(reply.text, "markdown").join("\n\n") || (step.kind === "code" ? "" : reply.text.trim());

			if (step.kind === "note" || step.kind === "report") {
				const current = note ?? "";
				const proposed = step.kind === "note" ? markdown : `${current.replace(/\s*$/, "")}\n\n## Verify (${localDay()})\n\n${markdown}\n`;
				return propose({
					title: `Tidy ${index + 1}/6 ${step.title}`,
					path: targetNote,
					original: current,
					proposed,
					language: "markdown",
					effect: `Accepting saves the right side as the context note, ${rel(targetNote, pinnedRoot)}.`,
					onAccept: async (final) => {
						if (!stillSameWorkspace()) throw new Error("The workspace changed while this tidy step was running.");
						await writeNoteFile(targetNote, final.replace(/\s*$/, "") + "\n");
						mark("accepted");
					},
					onReject: () => mark("rejected"),
				});
			}

			const code = pickPrimarySslBlock(fenced(reply.text, "ssl"), text);
			if (!code) {
				if (isExplicitUnchanged(reply.text)) {
					mark("unchanged");
					if (markdown) await appendToNote(path, `Step ${index + 1}: ${step.title}`, markdown, pinnedRoot);
					addEntry({ role: "note", text: `${step.title}: no changes proposed (UNCHANGED).` });
					return;
				}
				mark("failed", "The reply contained neither an ```ssl block nor UNCHANGED. Review the conversation and try again.");
				addEntry({ role: "note", text: `${step.title}: reply did not contain an \`\`\`ssl block or UNCHANGED.` });
				return;
			}
			const proposed = code.endsWith("\n") || !text.endsWith("\n") ? code : code + "\n";
			await propose({
				title: `Tidy ${index + 1}/6 ${step.title}`,
				path,
				original: text,
				proposed,
				language: "ssl",
				checks: await checks(text, proposed, Boolean(step.commentsOnly)),
				note: markdown || undefined,
				effect: "Accepting puts the right side into the editor as one edit you can undo. The file is not saved.",
				onAccept: async (final) => {
					if (!stillSameWorkspace()) throw new Error("The workspace changed while this tidy step was running.");
					const currentDoc = documents.get(path);
					if (!currentDoc) throw new Error(`${rel(path, pinnedRoot)} is no longer open. Open it again, then accept`);
					if (currentDoc.model.getAlternativeVersionId() !== startVersion) {
						throw new Error(`${rel(path, pinnedRoot)} was edited after this tidy step started. Reject and run the step again so your edits are not overwritten.`);
					}
					// The note first: if it cannot be written, nothing has been applied and the review is still open.
					if (markdown) await appendToNote(path, `Step ${index + 1}: ${step.title}`, markdown, pinnedRoot);
					if (!applyText(path, final)) {
						throw new Error(`${rel(path, pinnedRoot)} could not be updated because its editor was closed.`);
					}
					mark("accepted");
					notify(`${step.title} applied. Review and save the file; undo reverts it.`);
				},
				onReject: () => mark("rejected"),
			});
		},
		(message) => mark("failed", message),
	);
}
