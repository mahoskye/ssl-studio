// The tidy sequence (the style guide's six ssl-tidy-* skills) on one file,
// one reviewed step at a time. The skills expect to read the file, search
// the project and keep a context note; the agent here has no file tools
// (M0), so SSL Studio supplies the file, the note and the callers it finds
// through the language server, and keeps the note at the skills' own path,
// design/<name>.tidy.md. Each step's result is checked as the cleanup
// runner did: no new findings, procedures and parameters unchanged, and the
// comments step changing comments only.
import { createStore } from "solid-js/store";
import { localDay } from "../../shared/dates";
import { backend } from "../backend";
import { openReview, type Check, type Review } from "../editor/Review";
import { monaco } from "../editor/monaco";
import { codeOnly } from "../editor/textmate";
import { session } from "../lsp/session";
import { activePath, applyText, documents, keepTab, notify, state } from "../state";
import { addEntry, ask, safely } from "./store";
import type { StepState } from "./logic";
import { baseName, joinPath, relativeTo } from "../../shared/paths";
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

const rel = (path: string) => relativeTo(state.workspace?.root, path);
const base = (path: string) => baseName(path).replace(/\.[^.]+$/, "");
export const notePath = (path: string) => joinPath(state.workspace!.root, "design", `${base(path)}.tidy.md`);

export function startTidy() {
	const path = activePath();
	if (!path || documents.get(path)?.model.getLanguageId() !== "ssl") return notify("Open an SSL file to tidy.");
	generation++;
	// The steps are proposed for this file: its tab stays while they are.
	keepTab(path);
	proposals.clear();
	setTidy({ path, steps: STEPS.map(() => "pending"), problems: STEPS.map(() => "") });
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
	setTidy("problems", index, shown ? "" : "Its proposal is waiting: press Show review when the other review is closed.");
	if (!shown) notify(`${STEPS[index]!.title}: the proposal is kept. Press Show review in the Agent panel to see it.`);
}

async function readNote(path: string): Promise<string | null> {
	try {
		return (await backend.read(notePath(path))).text;
	} catch {
		return null;
	}
}

/** Blocks of one language from a reply: ```ssl … ``` and so on. */
export function fenced(text: string, language: string): string[] {
	const blocks: string[] = [];
	const pattern = /```([\w-]*)[^\n]*\n([\s\S]*?)```/g;
	let m: RegExpExecArray | null;
	while ((m = pattern.exec(text))) if (m[1]!.toLowerCase() === language) blocks.push(m[2]!.replace(/\n$/, ""));
	return blocks;
}

/** Call sites in other files, from the language server's references, plus a text search for the script's name. */
async function callers(path: string, model: monaco.editor.ITextModel): Promise<string> {
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
			if (relativeTo(state.workspace?.root, file) === relativeTo(state.workspace?.root, path)) continue;
			const target = await session.ensureModel(r.uri);
			lines.push(`${p.name} ← ${rel(file)}:${r.range.start.line + 1}: ${target?.getLineContent(r.range.start.line + 1).trim() ?? ""}`);
		}
	}
	for (const hit of (await backend.search(base(path), { caseSensitive: false }).catch(() => [])).filter((h) => h.path !== path).slice(0, 60))
		lines.push(`text "${base(path)}" ← ${rel(hit.path)}:${hit.line}: ${hit.text.trim()}`);
	return lines.length ? lines.join("\n") : "(none found in the workspace)";
}

function prompt(step: (typeof STEPS)[number], index: number, path: string, text: string, note: string | null, found?: string, workContext?: string) {
	const reply =
		step.kind === "note"
			? "Reply with the complete context note in one ```markdown block, and nothing else."
			: step.kind === "code"
				? "Reply with the whole file after this step's changes in one ```ssl block (or the single word UNCHANGED when nothing should change), then this step's change-log entry for the context note in one ```markdown block."
				: "Reply with the verification report in one ```markdown block.";
	return [
		`Run step ${index + 1} of 6 of the SSL cleanup sequence (skill ${step.skill}) on the file below.`,
		"You are inside SSL Studio. In this session you cannot read, search or write files: everything the step needs is below, and SSL Studio will save what you return after the user reviews it. Work only from this message.",
		reply,
		"",
		`FILE ${rel(path)} (${text.split("\n").length} lines, complete):`,
		"```ssl",
		text,
		"```",
		...(note ? ["", `CONTEXT NOTE design/${base(path)}.tidy.md:`, "```markdown", note, "```"] : []),
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

async function checks(before: string, after: string, commentsOnly: boolean): Promise<Check[]> {
	const [a, b] = await Promise.all([session.analyze(before), session.analyze(after)]);
	const count = (list: { code?: string }[]) => list.reduce((m, d) => m.set(d.code ?? "?", (m.get(d.code ?? "?") ?? 0) + 1), new Map<string, number>());
	const ca = count(a.diagnostics);
	const added = [...count(b.diagnostics)].filter(([code, n]) => n > (ca.get(code) ?? 0)).map(([code, n]) => `${code} +${n - (ca.get(code) ?? 0)}`);
	const shapeA = procedureShape(a.symbols).join("; ");
	const shapeB = procedureShape(b.symbols).join("; ");
	// A server that did not answer has found nothing because it said nothing: that is not a pass.
	const silent = a.timedOut || b.timedOut;
	const result: Check[] = [
		silent
			? { label: "The language server did not answer", ok: null, detail: "new findings could not be checked. Reject and run the step again when the server is ready, or check the result yourself." }
			: { label: "No new findings", ok: !added.length, detail: added.join(", ") || `${b.diagnostics.length} findings after, ${a.diagnostics.length} before` },
		{ label: "Procedures and parameters unchanged", ok: shapeA === shapeB, detail: shapeA === shapeB ? undefined : `before: ${shapeA} · after: ${shapeB}` },
	];
	if (commentsOnly) result.push({ label: "Only comments changed", ok: codeOnly(before) === codeOnly(after) });
	const kb = (s: string) => (new TextEncoder().encode(s).length / 1024).toFixed(1);
	result.push({ label: "Size", ok: null, detail: `${kb(before)} KB → ${kb(after)} KB` });
	return result;
}

async function appendToNote(path: string, heading: string, entry: string) {
	const note = (await readNote(path)) ?? `# Tidy notes: ${rel(path)}\n`;
	await backend.write(notePath(path), `${note.replace(/\s*$/, "")}\n\n## ${heading} (${localDay()})\n\n${entry.trim()}\n`);
}

/** Runs one step. Whatever goes wrong, the step ends in a state it can be run again from. */
export async function runStep(index: number) {
	const path = tidy.path;
	const doc = path ? documents.get(path) : undefined;
	if (!path || !doc) return notify("The file being tidied is not open.");
	const step = STEPS[index]!;
	const mine = generation;
	/** Moves the step on, unless the tidy was restarted meanwhile. */
	const mark = (to: StepState, problem = "") => {
		if (mine !== generation) return;
		if (to !== "review") proposals.delete(index);
		setTidy("steps", index, to);
		setTidy("problems", index, problem);
	};
	/** Puts a proposal up for review and remembers it until it is accepted or rejected. */
	const propose = async (proposal: Review) => {
		if (mine !== generation) return;
		proposals.set(index, proposal);
		mark("review");
		await present(index, proposal);
	};
	await safely(
		`Tidy step ${index + 1} (${step.title}) did not finish`,
		async () => {
			const note = await readNote(path);
			if (index > 0 && !note && step.kind !== "note") return notify("Run the context step first: the later steps rely on its note.");
			mark("running");
			const text = doc.model.getValue();
			const found = step.kind === "note" ? await callers(path, doc.model) : undefined;
			// Only attach governing ticket context on Step 0 (Context) using this script's actual linked ticket — never an unrelated active ticket!
			const scriptTicket = index === 0 ? ticketForFile(docs(), path, state.workspace?.root) : "";
			const work = scriptTicket ? await workPrompt(scriptTicket, { specs: false }).catch(() => null) : null;
			const reply = await ask(prompt(step, index, path, text, note, found, work?.text), { title: `Tidy ${step.title}: ${rel(path)}`, skills: [step.skill], show: `Tidy step ${index + 1}, ${step.title.toLowerCase()}: ${rel(path)}` });
			if (!reply) return mark("failed", "The request did not go through: the conversation below says why.");
			if (reply.outcome !== "succeeded") return mark("failed", reply.outcome === "interrupted" ? `Stopped before it finished${reply.error ? `: ${reply.error}` : "."}` : `The reply ${reply.outcome === "timeout" ? "timed out" : "failed"}${reply.error ? `: ${reply.error}` : "."}`);
			const markdown = fenced(reply.text, "markdown").join("\n\n") || (step.kind === "code" ? "" : reply.text.trim());

			if (step.kind === "note" || step.kind === "report") {
				const current = note ?? "";
				const proposed = step.kind === "note" ? markdown : `${current.replace(/\s*$/, "")}\n\n## Verify (${localDay()})\n\n${markdown}\n`;
				return propose({
					title: `Tidy ${index + 1}/6 ${step.title}`,
					path: notePath(path),
					original: current,
					proposed,
					language: "markdown",
					effect: `Accepting saves the right side as the context note, ${rel(notePath(path))}.`,
					onAccept: async (final) => {
						await backend.write(notePath(path), final.replace(/\s*$/, "") + "\n");
						mark("accepted");
					},
					onReject: () => mark("rejected"),
				});
			}

			const code = fenced(reply.text, "ssl").at(-1);
			if (!code) {
				mark("unchanged");
				if (markdown) await appendToNote(path, `Step ${index + 1}: ${step.title}`, markdown);
				addEntry({ role: "note", text: `${step.title}: no changes proposed.` });
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
					// The note first: if it cannot be written, nothing has been applied and the review is still open.
					if (!documents.get(path)) throw new Error(`${rel(path)} is no longer open. Open it again, then accept`);
					if (markdown) await appendToNote(path, `Step ${index + 1}: ${step.title}`, markdown);
					applyText(path, final);
					mark("accepted");
					notify(`${step.title} applied. Review and save the file; undo reverts it.`);
				},
				onReject: () => mark("rejected"),
			});
		},
		(message) => mark("failed", message),
	);
}
