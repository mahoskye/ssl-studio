// Blocks mode: the open file as region frames, procedure cards, control-flow
// blocks and code chips. A view of the text, never a copy: every action here
// is a text edit on the model the text editor shows, so one undo stack serves
// both modes (ADR 0002).
import { Icon } from "../Icon";
import { createEffect, createMemo, createSignal, createStore, For, Match, onCleanup, reconcile, Show, Switch, untrack } from "solid-js";
import { createAsyncQuery } from "../asyncQuery";
import { findCodeCitations } from "../../shared/codeCitations";
import { dirName, isInside, joinPath, relativeTo, resolvePath } from "../../shared/paths";
import { isCatalog } from "../../shared/projectDocs";
import type { DocFile } from "../../shared/protocol";
import { codeMatchesRef, docsGoverningFile } from "../../shared/workContext";
import { backend } from "../backend";
import { docAuditData } from "../docAudit";
import { monaco } from "../editor/monaco";
import { editors } from "../editor/EditorGroup";
import { regionColor } from "../editor/regions";
import { lspAnswering, session } from "../lsp/session";
import { ask, choose, quickPick, type QuickPickOption } from "../dialogs";
import { docs, isMarkdown } from "../project";
import { canonical, documents, notify, openFile, setState, state } from "../state";
import { buildTree, cardMove, cardOf, cutOut, dropLine, editBoxHeight, editedLines, foldsOf, formatStaysWithin, keepDepth, linesWithEdits, openFolds, pathTo, procedureGroups, rawSpans, regionNameRefusal, spanAfterSwap, splitHeader, staleNotice, staleReason, swapLines, treeFromSyntax, type FoldMemory, type Node, type Span, type SymbolIn } from "./model";

import { ticketRefsIn, type TicketSegment } from "../../shared/editorDocHelpers";
export { ticketRefsIn, type TicketSegment };

type BlockPlanBadge = { path: string; title: string; steps: number };
type BlockDocCitation = { docPath: string; docTitle: string; docLine: number; from: number; to: number; drifted?: boolean };

async function readWorkspaceText(path: string): Promise<string> {
	const open = documents.get(canonical(path));
	if (open) return open.model.getValue();
	return backend.read(path).then((r) => (r.binary ? "" : r.text), () => "");
}

function collectProcedureNames(node: Node): string[] {
	const names: string[] = [];
	const walk = (n: Node) => {
		if (n.kind === "procedure" && n.name) names.push(n.name.toLowerCase());
		for (const c of n.children) walk(c);
	};
	walk(node);
	return names;
}

// What is folded outlives the view, which is made anew for each tab and each switch to Blocks (`FoldMemory`, model.ts).
const collapsedByPath: FoldMemory = new Map();
let collapsedRoot: string | undefined;

function toSymbols(list: monaco.languages.DocumentSymbol[]): SymbolIn[] {
	return list.map((s) => ({
		name: s.name,
		kind: s.kind + 1,
		startLine: s.range.startLineNumber - 1,
		endLine: s.range.endLineNumber - 1,
		children: toSymbols(s.children ?? []),
	}));
}

/** Theme-coloured HTML for a few lines of SSL, through the same tokenizer as the editor. */
function Code(props: { text: string }) {
	// One string for the source: text that reads the same is not coloured again, however often it is asked for.
	const [html] = createAsyncQuery(
		() => `${state.settings.theme}\u0000${state.settings.themeMaterial ?? ""}\u0000${props.text}`,
		(source) => monaco.editor.colorize(source.slice(source.indexOf("\u0000", source.indexOf("\u0000") + 1) + 1), "ssl", { tabSize: 4 }),
	);
	return <code class="block-code" innerHTML={html() ?? ""} />;
}

export function BlocksView(props: { path: string; group: number }) {
	const doc = () => documents.get(props.path);
	const [tree, setTree] = createStore<{ root: Node | null }>({ root: null });
	const [version, setVersion] = createSignal(0);
	/**
	 * Bumped each time the tree is read again. A block's text is cut from the
	 * document by the block's lines; when an edit changes the words and not the
	 * lines, the tree comes back the same, and without this the block would go
	 * on showing what it said before.
	 */
	const [read, setRead] = createSignal(0);
	const [editing, setEditing] = createSignal<string | null>(null);
	const [dropAt, setDropAt] = createSignal<number | null>(null);
	/** Why the structure could not be read, when it could not: said in the view, with a way to try again. */
	const [failed, setFailed] = createSignal<string | null>(null);
	const collapsed = () => foldsOf(collapsedByPath, props.path);
	const [collapseVersion, setCollapseVersion] = createSignal(0);
	// A fold is kept by the block's place in the structure (`fold`, model.ts), not by its line: kept by line, the
	// folds sat on other blocks as soon as a line was added or removed above them. A leaf has no fold to keep.
	const isCollapsed = (n: Node) => (collapseVersion(), Boolean(n.fold && collapsed().has(n.fold)));
	const toggle = (n: Node) => {
		if (!n.fold) return;
		collapsed().has(n.fold) ? collapsed().delete(n.fold) : collapsed().add(n.fold);
		setCollapseVersion((v) => v + 1);
	};

	let timer: ReturnType<typeof setTimeout> | undefined;
	let reqSeq = 0;
	let treeVersionId = -1;
	const refreshNow = () => {
		clearTimeout(timer);
		timer = undefined;
		setVersion((v) => v + 1);
	};
	onCleanup(() => {
		reqSeq++;
		clearTimeout(timer);
		timer = undefined;
	});
	// Clear per-file fold memory when switching workspaces.
	const workspaceRoot = createMemo(() => state.workspace?.root);
	createEffect(
		() => workspaceRoot(),
		(root) => {
			if (collapsedRoot !== undefined && collapsedRoot !== root) {
				collapsedByPath.clear();
				setCollapseVersion((v) => v + 1);
			}
			collapsedRoot = root;
		},
	);
	const pathAndLsp = createMemo(() => `${props.path}\u0000${state.lsp.state}`);
	createEffect(
		() => ({ key: pathAndLsp(), path: props.path }),
		({ path }) => {
			treeVersionId = -1;
			const model = documents.get(path)?.model;
			if (!model || model.isDisposed()) return;
			const sub = model.onDidChangeContent(() => {
				clearTimeout(timer);
				timer = setTimeout(() => setVersion((v) => v + 1), 300);
			});
			refreshNow();
			return () => {
				clearTimeout(timer);
				timer = undefined;
				sub.dispose();
			};
		},
	);
	createEffect(
		() => ({ version: version(), path: props.path, lspRunning: state.lsp.state === "running" }),
		({ path, lspRunning }) => {
			const req = ++reqSeq;
			const model = documents.get(path)?.model;
			if (!model || model.isDisposed()) return;
			if (!lspRunning) {
				setFailed(null);
				return;
			}
			const startVersion = model.getVersionId();
			const stale = () => req !== reqSeq || model.isDisposed() || untrack(doc)?.model !== model || model.getVersionId() !== startVersion;
			void (async () => {
				try {
					await session.waitReady().catch(() => {});
					if (stale()) return;
					if (state.lsp.state !== "running") {
						setFailed(null);
						return;
					}
					let root: Node;
					if (session.supports("ssl/syntaxTree")) {
						// The server's own parse (L1): statement-level chips, arms, unreadable spans.
						const [result, symbols] = await Promise.all([
							session.request("ssl/syntaxTree", { textDocument: { uri: model.uri.toString() } }),
							session.documentSymbols(model).catch(() => []),
						]);
						if (stale()) return;
						// Parameter names come from the outline, which lists them per procedure.
						const params = new Map<string, string[]>();
						const walk = (list: monaco.languages.DocumentSymbol[]) =>
							list.forEach((s) => (s.kind === monaco.languages.SymbolKind.Function || s.kind === monaco.languages.SymbolKind.Method ? params.set(s.name, (s.children ?? []).map((c) => c.name)) : walk(s.children ?? [])));
						walk(symbols);
						root = treeFromSyntax(model.getLinesContent(), result?.nodes ?? [], (name) => params.get(name));
					} else {
						const [symbols, folds] = await Promise.all([
							session.documentSymbols(model),
							session.request("textDocument/foldingRange", { textDocument: { uri: model.uri.toString() } }).then((f) => f ?? []),
						]);
						if (stale()) return;
						root = buildTree(model.getLinesContent(), toSymbols(symbols), folds);
					}
					// The answer is for the text as it was when asked: a file closed, edited, or swapped since is not this one.
					if (stale()) return;
					treeVersionId = startVersion;
					setFailed(null);
					setTree((s) => {
						if (s.root && s.root.key === root.key) reconcile(root, "key")(s.root);
						else s.root = root;
					});
					setRead((v) => v + 1);
					// The banner opens folded; long files open as a region outline. Once for a file, the first time it is
					// read: set by each new view, as it was, the folds the user had opened were closed again on every way back.
					if (openFolds(collapsedByPath, path, root, model.getLineCount())) setCollapseVersion((v) => v + 1);
				} catch (e: any) {
					if (stale()) return;
					if (state.lsp.state !== "running") {
						setFailed(null);
						return;
					}
					treeVersionId = -1;
					setTree((s) => {
						s.root = null;
					});
					setFailed(String(e?.message ?? e));
				}
			})();
		},
	);

	// The tree is read a moment after the text changes, so a node can point past the
	// end of a file that just got shorter. Such a node shows nothing until the next read.
	const within = (n: Span) => {
		const model = doc()?.model;
		return Boolean(model && !model.isDisposed() && n.start >= 1 && n.end <= model.getLineCount());
	};
	const lines = (n: Span) => (read(), within(n) ? doc()!.model.getValueInRange(new monaco.Range(n.start, 1, n.end, doc()!.model.getLineMaxColumn(n.end))) : "");
	const firstLine = (n: Node) => (read(), within(n) ? doc()!.model.getLineContent(n.start) : "");
	const selectedKey = () => {
		// Follows the text cursor of whichever group shows this file: side by side, the blocks track the text.
		const active = state.groups[state.activeGroup]?.active;
		if (!tree.root || active !== props.path) return null;
		const path = pathTo(tree.root, state.cursor.line);
		// A comment is drawn as one block: a cursor on any of its lines selects the comment.
		const comment = path.findIndex((n) => n.kind === "comment");
		return (comment >= 0 ? path[comment] : path.at(-1))?.key ?? null;
	};
	const select = (n: Span, focusText = false) => {
		const editor = editors[props.group];
		const model = doc()?.model;
		if (model && !model.isDisposed()) {
			const lineCount = model.getLineCount();
			const start = Math.max(1, Math.min(n.start, lineCount));
			const end = Math.max(start, Math.min(n.end, lineCount));
			const maxCol = model.getLineMaxColumn(end);
			editor?.setSelection(new monaco.Range(start, 1, end, maxCol));
		} else {
			editor?.setSelection(new monaco.Range(n.start, 1, n.end, 1));
		}
		setState((s) => {
			s.activeGroup = props.group;
			s.cursor = { line: n.start, column: 1 };
			if (focusText && s.groups[props.group]) s.groups[props.group]!.mode = "text";
		});
		if (focusText) {
			queueMicrotask(() => {
				editor?.revealLineInCenter(n.start);
				editor?.focus();
			});
		}
	};

	const runBlockCommand = (n: Node, commandId: string) => {
		select(n);
		void import("../commands").then((m) => m.runCommand(commandId));
	};

	// Workspace ticket lookup for clickable ticket pills in file banners & comments.
	const ticketLookup = createMemo(() => {
		const byKey = new Map<string, DocFile>();
		const keys: string[] = [];
		for (const d of docs()) {
			if (!d.exists || d.group !== "tickets" || isCatalog(d) || !d.ticket) continue;
			byKey.set(d.ticket.toLowerCase(), d);
			keys.push(d.ticket);
		}
		return { byKey, keys };
	});

	const TicketLinkedText = (p: { text: string }) => (
		<For each={ticketRefsIn(p.text, ticketLookup().keys)}>
			{(seg) => {
				if (!seg.ticket) return seg.text;
				const ticketDoc = () => ticketLookup().byKey.get(seg.ticket!.toLowerCase());
				return (
					<Show when={ticketDoc()} fallback={seg.text}>
						{(td) => (
							<button
								type="button"
								class="block-ticket-pill"
								title={`${td().ticket}${td().title ? `: ${td().title}` : ""}${td().status ? ` (${td().status})` : ""} — click to open ticket`}
								onClick={(e) => {
									e.stopPropagation();
									void openFile(td().path);
								}}
								style={{
									display: "inline-flex",
									"align-items": "center",
									padding: "0 6px",
									margin: "0 1px",
									"border-radius": "999px",
									border: "1px solid color-mix(in srgb, var(--accent) 36%, transparent)",
									background: "color-mix(in srgb, var(--accent) 12%, transparent)",
									color: "var(--accent)",
									"font-family": "var(--ui-font)",
									"font-size": "var(--text-xs)",
									"font-style": "normal",
									"font-weight": "600",
									"line-height": "1.45",
									cursor: "pointer",
									"vertical-align": "baseline",
								}}
							>
								{seg.text}
							</button>
						)}
					</Show>
				);
			}}
		</For>
	);

	// Governing Plan & Doc citation trace data for subtle badges on procedure and region cards.
	const govFingerprint = createMemo(() => {
		const gov = docsGoverningFile(docs(), props.path, state.workspace?.root);
		return `${props.path}|${state.workspace?.root ?? ""}|${state.treeVersion}|${gov.map((g) => g.file.path).join(",")}`;
	});
	const [traceData] = createAsyncQuery(govFingerprint, async () => {
		const { path, wsRoot, allDocs } = untrack(() => ({
			path: props.path,
			wsRoot: state.workspace?.root,
			allDocs: docs(),
		}));
		const gov = docsGoverningFile(allDocs, path, wsRoot);
		const planByProc = new Map<string, BlockPlanBadge[]>();
		const citations: BlockDocCitation[] = [];
		const canonSelf = canonical(path);

		for (const g of gov) {
			if (g.file.group === "plans") {
				const raw = await readWorkspaceText(g.file.path);
				if (!raw) continue;
				try {
					const parsed = JSON.parse(raw) as {
						title?: string;
						nodes?: { id?: string; text?: string; ref?: string }[];
						targets?: (string | { script?: string; path?: string; procedures?: string[] })[];
						built?: { units?: { name?: string; script?: string; nodes?: string[] }[] };
					};
					const title = parsed.title || g.file.title || g.file.name.replace(/\.plan\.json$/i, "");
					const addProc = (procName: string, steps: number) => {
						const k = procName.toLowerCase();
						const arr = planByProc.get(k) ?? [];
						const existing = arr.find((x) => canonical(x.path) === canonical(g.file.path));
						if (existing) existing.steps = Math.max(existing.steps, steps);
						else arr.push({ path: g.file.path, title, steps });
						planByProc.set(k, arr);
					};
					for (const u of parsed.built?.units ?? []) {
						if (!u?.name) continue;
						if (u.script && !codeMatchesRef(path, u.script, wsRoot)) continue;
						addProc(u.name, Array.isArray(u.nodes) ? u.nodes.length : 0);
					}
					for (const t of parsed.targets ?? []) {
						if (typeof t === "object" && t && Array.isArray(t.procedures)) {
							const scriptRef = t.script ?? t.path ?? "";
							if (scriptRef && !codeMatchesRef(path, scriptRef, wsRoot)) continue;
							for (const pName of t.procedures) if (typeof pName === "string") addProc(pName, 0);
						}
					}
					for (const node of parsed.nodes ?? []) {
						if (!node?.ref) continue;
						const tail = node.ref.split(".").pop();
						if (tail) addProc(tail, 1);
					}
				} catch {
					// Ignore malformed plan JSON.
				}
			} else if (isMarkdown(g.file.path)) {
				const text = await readWorkspaceText(g.file.path);
				if (!text) continue;
				const docTitle =
					g.file.ticket && g.file.title && !g.file.title.startsWith(g.file.ticket)
						? `${g.file.ticket}: ${g.file.title}`
						: g.file.title || g.file.name;
				for (const cit of findCodeCitations(text)) {
					if (!cit.file) continue;
					let matches = codeMatchesRef(path, cit.file, wsRoot);
					if (!matches && wsRoot) {
						const resolved = cit.file.startsWith("/")
							? joinPath(wsRoot, ...cit.file.split("/").filter(Boolean))
							: resolvePath(dirName(g.file.path), cit.file);
						if (isInside(wsRoot, resolved) && canonical(resolved) === canonSelf) matches = true;
					}
					if (matches) {
						citations.push({ docPath: g.file.path, docTitle, docLine: cit.line, from: cit.from, to: cit.to });
					}
				}
			}
		}
		return { planByProc, citations };
	});

	const allFileCitations = createMemo<BlockDocCitation[]>(() => {
		const base = traceData()?.citations ?? [];
		const canonSelf = canonical(props.path);
		const auditIssues = (docAuditData().citationIssues ?? []).filter((c) => canonical(c.targetPath) === canonSelf);
		if (!auditIssues.length) return base;
		const merged = base.map((c) => {
			const drifted = auditIssues.some((i) => canonical(i.docPath) === canonical(c.docPath) && i.docLine === c.docLine);
			return drifted ? { ...c, drifted: true } : c;
		});
		const allDocs = docs();
		for (const issue of auditIssues) {
			const exists = merged.some((c) => canonical(c.docPath) === canonical(issue.docPath) && c.docLine === issue.docLine);
			if (!exists) {
				const d = allDocs.find((f) => canonical(f.path) === canonical(issue.docPath));
				merged.push({
					docPath: issue.docPath,
					docTitle: d?.title || d?.name || issue.docPath,
					docLine: issue.docLine,
					from: issue.citation.from,
					to: issue.citation.to,
					drifted: true,
				});
			}
		}
		return merged;
	});

	const badgesFor = (n: Node): { plans: BlockPlanBadge[]; docs: BlockDocCitation[] } => {
		if (n.kind !== "procedure" && n.kind !== "region") return { plans: [], docs: [] };
		const planMap = traceData()?.planByProc;
		const planSeen = new Map<string, BlockPlanBadge>();
		if (planMap) {
			const procNames = n.kind === "procedure" ? (n.name ? [n.name.toLowerCase()] : []) : collectProcedureNames(n);
			for (const name of procNames) {
				for (const badge of planMap.get(name) ?? []) {
					const k = canonical(badge.path);
					if (!planSeen.has(k)) planSeen.set(k, badge);
				}
			}
		}
		const docSeen = new Map<string, BlockDocCitation>();
		for (const cit of allFileCitations()) {
			if (cit.from > n.end || cit.to < n.start) continue;
			const k = canonical(cit.docPath);
			const prev = docSeen.get(k);
			if (!prev || (cit.drifted && !prev.drifted)) docSeen.set(k, cit);
		}
		return { plans: [...planSeen.values()], docs: [...docSeen.values()] };
	};

	const isTreeFresh = (model: monaco.editor.ITextModel | undefined): model is monaco.editor.ITextModel =>
		Boolean(model && !model.isDisposed() && model.getVersionId() === treeVersionId);
	/**
	 * Whether the blocks can be changed now, saying why when they cannot: the tree is not of the text as it stands
	 * (the language server is starting or stopped, or an edit has not been read yet), so the lines it names may not
	 * be the block's. Said, because a move, a delete, a wrap or a drop that did nothing without a word read as broken.
	 */
	const canChange = (model: monaco.editor.ITextModel | undefined): model is monaco.editor.ITextModel => {
		// A file that is closed has no blocks to change, and nothing to say.
		const open = Boolean(model && !model.isDisposed());
		if (isTreeFresh(model)) return true;
		if (open) notify(staleNotice(staleReason(state.lsp.state, session.answering), "change"));
		return false;
	};
	/** The text's version as this view's own last edit left it, and when: a tree behind only that is already being read again. */
	let ownEditVersion = -1;
	let ownEditAt = 0;
	/** How long a tree is taken to be on its way after an edit made here; one not read by then is said to be behind. */
	const READ_WITHIN_MS = 2000;
	const noteOwnEdit = () => {
		ownEditVersion = doc()?.model.getVersionId() ?? -1;
		ownEditAt = performance.now();
	};
	/** Reads the tree again after an edit made here. */
	const editedHere = () => {
		noteOwnEdit();
		refreshNow();
	};

	/** Replaces lines start..end (1-based) with `text`, as one undoable edit (or open for a following `formatLines`). */
	const replaceLines = (start: number, end: number, text: string | null, closeUndo = true) => {
		const model = doc()?.model;
		if (!model || model.isDisposed()) return;
		const eol = model.getEOL();
		const lineCount = model.getLineCount();
		let range: monaco.Range;
		let replacement = text ?? "";
		if (text === null) {
			// Delete whole lines, with their line break.
			if (start <= 1 && end >= lineCount) {
				range = new monaco.Range(1, 1, lineCount, model.getLineMaxColumn(lineCount));
			} else if (end < lineCount) {
				range = new monaco.Range(start, 1, end + 1, 1);
			} else {
				range = new monaco.Range(start - 1, model.getLineMaxColumn(start - 1), end, model.getLineMaxColumn(end));
			}
			replacement = "";
		} else range = new monaco.Range(start, 1, end, model.getLineMaxColumn(end));
		model.pushStackElement();
		model.pushEditOperations([], [{ range, text: replacement.replace(/\r?\n/g, eol) }], () => null);
		if (closeUndo) model.pushStackElement();
	};
	/**
	 * The range format that follows an edit made here (ADR 0002), over the lines the edit touched and no others.
	 * The edit was pushed with its undo step left open, and this closes it: one undo takes back both.
	 *
	 * "No others" is held to here, not left to the server. `raw` is the code the server could not read among the
	 * lines, as they stand after the edit: it is cut out of what is asked, each run of lines that is left is asked
	 * on its own, and an answer that changes any line outside its run is not applied at all (`formatStaysWithin`).
	 * No view may rewrite code it does not understand, and a statement the server finds no end of reaches as far
	 * as the procedure does.
	 */
	const formatLines = async (start: number, end: number, raw: Span[] = []) => {
		const model = doc()?.model;
		if (!model || model.isDisposed()) return;
		try {
			// Asked only of a server that is running. One that is starting would be waited for, with the undo step
			// open all the while, and one that is stopped has no answer: the edit then stands as it was written.
			if (state.lsp.state !== "running") return;
			const version = model.getVersionId();
			const kept: monaco.editor.IIdentifiedSingleEditOperation[] = [];
			for (const run of cutOut({ start: Math.max(1, start), end: Math.min(end, model.getLineCount()) }, raw)) {
				const edits = await session.formatRanges(model, [[run.start - 1, run.end - 1]], model.getOptions());
				if (model.isDisposed() || model.getVersionId() !== version) return;
				const before = model.getLinesContent();
				if (edits.length && formatStaysWithin(before, linesWithEdits(before, edits), run)) kept.push(...edits);
			}
			if (kept.length) model.pushEditOperations([], kept, () => null);
		} catch {
			// The edit stands unformatted; format on save will tidy it.
		} finally {
			if (!model.isDisposed()) model.pushStackElement();
		}
	};
	/** Formats the lines an edit made here left (`editedLines`, model.ts), then reads the tree again. */
	const formatEdited = async (span: Span, raw: Span[] = []) => {
		noteOwnEdit();
		await formatLines(span.start, span.end, raw);
		editedHere();
	};
	const parentOf = (target: Node, from: Node | null = tree.root): Node | null => {
		if (!from) return null;
		for (const c of from.children) {
			if (c === target) return from;
			const found = parentOf(target, c);
			if (found) return found;
		}
		return null;
	};
	const move = async (n: Node, direction: -1 | 1) => {
		const model = doc()?.model;
		// A key that comes while this view's own last move is still being read is early, not refused: holding
		// Alt+Down moves the block as fast as the tree is read, and says nothing in between.
		const early = Boolean(model && !model.isDisposed() && model.getVersionId() === ownEditVersion && state.lsp.state === "running" && performance.now() - ownEditAt < READ_WITHIN_MS);
		if (early && !isTreeFresh(model)) return;
		if (!canChange(model) || !within(n)) return;
		// The card as it is drawn moves past the card next to it: a procedure with its doc block, not past it.
		const parent = parentOf(n);
		const step = parent && cardMove(parent, n, direction);
		if (!step || !within(step.a) || !within(step.b)) return;
		const height = n.end - n.start;
		const linesBefore = model.getLineCount();
		const swapped = swapLines(model.getLinesContent(), step.a, step.b);
		// Code the server could not read moves as it is written, and is not formatted where it lands.
		const raw = rawSpans(tree.root, swapped).map((span) => spanAfterSwap(span, step.a, step.b));
		replaceLines(swapped.start, swapped.end, swapped.lines.join("\n"), false);
		noteOwnEdit();
		await formatLines(swapped.start, swapped.end, raw);
		if (model.isDisposed() || doc()?.model !== model) return;
		// The block that was moved stays the selected one. The selected block is the one the text cursor is in,
		// and the one edit that swaps the two left the cursor where the block used to be, inside its neighbour:
		// a second Alt+Up or Alt+Down then moved the neighbour, which put the first block back. Moved down, the
		// block ends where the swapped lines end, so lines the format added or took above it move it with them.
		const line = step.line + (direction > 0 ? model.getLineCount() - linesBefore : 0);
		select({ start: line, end: line + height });
		editedHere();
	};
	const wrap = async (n: Node) => {
		const model = doc()?.model;
		if (!canChange(model) || !within(n)) return;
		const beforeVer = model.getVersionId();
		// The card goes into the region whole: a doc block left outside it would no longer be its procedure's.
		const parent = parentOf(n);
		const card = parent ? cardOf(parent, n) : { start: n.start, end: n.end };
		// A name that cannot be a region's name is refused before anything is changed (`regionNameRefusal`), and
		// asked for again with what was typed, so that only what is in the way has to go.
		let name = await ask("Name of the new region");
		while (name && regionNameRefusal(name)) {
			notify(regionNameRefusal(name)!);
			name = await ask("Name of the new region", name);
		}
		if (!name) return;
		if (model.isDisposed() || doc()?.model !== model) return;
		if (model.getVersionId() !== beforeVer || !within(card)) return notify("The text changed while the name was asked for. Nothing was wrapped: try again.");
		const body = lines(card);
		// What the server could not read in the card is a line further down under the region's first line.
		const raw = rawSpans(tree.root, card).map((span) => ({ start: span.start + 1, end: span.end + 1 }));
		replaceLines(card.start, card.end, `/* region ${name};\n${body}\n/* endregion;`, false);
		await formatLines(card.start, card.end + 2, raw);
		editedHere();
	};
	const remove = async (n: Node) => {
		const model = doc()?.model;
		if (!canChange(model) || !within(n)) return;
		const beforeVer = model.getVersionId();
		// A procedure goes with the doc block and the annotation drawn as part of its card: left behind, they
		// stood above whatever came next. A doc block or an annotation asked to go on its own goes alone.
		const parent = parentOf(n);
		const card = n.kind === "procedure" && parent ? cardOf(parent, n) : { start: n.start, end: n.end };
		const what = n.name ? `${n.name}${card.start < n.start ? " and its doc block" : ""}` : `lines ${n.start}-${n.end}`;
		if ((await choose(`Delete ${what}? Undo brings it back.`, ["Delete"], { danger: "Delete" })) !== "Delete") return;
		if (model.isDisposed() || doc()?.model !== model) return;
		if (model.getVersionId() !== beforeVer || !within(card)) return notify("The text changed while this was asked. Nothing was deleted: try again.");
		// The two lines that meet once the card is gone are formatted, but not one the server could not read: the
		// line above stays where it was, the line below moves up to where the card began.
		const raw = [
			...rawSpans(tree.root, { start: card.start - 1, end: card.start - 1 }),
			...rawSpans(tree.root, { start: card.end + 1, end: card.end + 1 }).map(() => ({ start: card.start, end: card.start })),
		];
		replaceLines(card.start, card.end, null, false);
		await formatEdited(editedLines(card.start, null, model.getLineCount()), raw);
	};
	/**
	 * An in-place editor's text, set once as it opens: bound reactively, a tree
	 * refresh while it is open would write the old text over what is typed.
	 */
	const opened = (el: HTMLInputElement | HTMLTextAreaElement, text: string, select = false) => {
		el.value = text;
		queueMicrotask(() => (el.focus(), select && el.select(), el instanceof HTMLTextAreaElement && fitEdit(el)));
	};
	/**
	 * Lets the box a block is edited in grow with its text, as it opens and as it is typed in (`editBoxHeight`,
	 * model.ts). Only when some of the text is out of sight, and only ever taller. The box is then brought whole
	 * into the view: it has just grown downwards, and the line being typed on is most often its last.
	 */
	const fitEdit = (el: HTMLTextAreaElement) => {
		if (!scroller || el.scrollHeight <= el.clientHeight) return;
		const now = el.offsetHeight;
		// What shows all of the text: the text's own height, and the box's border around it.
		const height = editBoxHeight(now, el.scrollHeight + (now - el.clientHeight), scroller.clientHeight);
		if (height <= now) return;
		el.style.height = `${height}px`;
		el.scrollIntoView({ block: "nearest" });
	};
	/** A block header's condition (`:IF a > b;` → `a > b`), read fresh from the text. */
	const headerParts = (n: Node) => {
		read();
		const h = n.header;
		if (!h) return null;
		const model = doc()?.model;
		if (!model || model.isDisposed() || h.line < 1 || h.line > model.getLineCount()) return null;
		const maxCol = model.getLineMaxColumn(h.line);
		const startCol = Math.max(1, Math.min(h.startColumn, maxCol));
		const endCol = Math.max(startCol, Math.min(h.endColumn, maxCol));
		const split = splitHeader(model.getValueInRange(new monaco.Range(h.line, startCol, h.line, endCol)), h.keyword);
		return split && { ...split, rest: model.getLineContent(h.line).slice(endCol - 1) };
	};
	const conditionKey = (n: Node) => `${n.key}:condition`;
	/**
	 * Opens a block's in-place editor. Not while another is open: one is only still open here when its edit could
	 * not be made yet and was kept, and opening the next would close it with what was typed in it.
	 */
	const beginEdit = (key: string) => {
		const open = editing();
		if (open && open !== key) return notify("Another edit is still open here. Confirm it, or press Escape to drop it, first.");
		setEditing(key);
	};
	/** Replaces only the condition, then formats the statement's own line: one undo takes back both. */
	const commitCondition = (n: Node, value: string) => {
		if (editing() !== conditionKey(n)) return;
		const model = doc()?.model;
		// The field stays open with what was typed when the edit cannot be made now, and says why. Closed first,
		// as it was, what was typed was gone without a word whenever the language server was stopped or restarting.
		// A field nothing was changed in has nothing to keep, and closes; so does one whose file has been closed.
		const gone = !model || model.isDisposed();
		if (!isTreeFresh(model)) return void (gone || value.trim() === headerParts(n)?.condition ? setEditing(null) : notify(staleNotice(staleReason(state.lsp.state, session.answering), "edit")));
		setEditing(null);
		const parts = headerParts(n);
		const condition = value.trim();
		if (!parts || condition === parts.condition) return;
		if (!condition) return notify("A condition cannot be empty; edit the statement in text to remove it.");
		const h = n.header!;
		const from = h.startColumn + parts.before.length;
		model.pushStackElement();
		model.pushEditOperations([], [{ range: new monaco.Range(h.line, from, h.line, from + parts.condition.length), text: condition }], () => null);
		void formatEdited({ start: h.line, end: h.line });
	};
	const commitEdit = (n: Node, text: string) => {
		if (editing() !== n.key) return;
		const model = doc()?.model;
		// As for a condition: the editor stays open with what was typed, and says why the edit is not made yet.
		const gone = !model || model.isDisposed();
		if (!isTreeFresh(model) || !within(n)) {
			const unchanged = within(n) && text === lines(n).replace(/\r\n/g, "\n");
			return void (gone || unchanged ? setEditing(null) : notify(staleNotice(staleReason(state.lsp.state, session.answering), "edit")));
		}
		setEditing(null);
		const was = lines(n).replace(/\r\n/g, "\n");
		if (text === was) return;
		// Code the language server could not read is kept exactly as it is typed: no format follows it.
		if (n.kind === "raw") {
			replaceLines(n.start, n.end, text, true);
			return editedHere();
		}
		// A statement typed anew without its indentation stays at the depth it stood at (`keepDepth`).
		const put = keepDepth(was, text);
		if (put === was) return;
		replaceLines(n.start, n.end, put, false);
		void formatEdited(editedLines(n.start, put, model.getLineCount()));
	};
	const drop = (e: DragEvent, line: number) => {
		e.preventDefault();
		setDropAt(null);
		const model = doc()?.model;
		if (!canChange(model)) return;
		const text = e.dataTransfer?.getData("text/plain");
		if (!text) return;
		const targetLine = Math.max(1, Math.min(line, model.getLineCount()));
		const eol = model.getEOL();
		const inserted = text.replace(/\r?\n/g, "\n").replace(/\n?$/, "\n");
		model.pushStackElement();
		model.pushEditOperations([], [{ range: new monaco.Range(targetLine, 1, targetLine, 1), text: inserted.replace(/\n/g, eol) }], () => null);
		// The lines put in are formatted where they stand. How deep they sit in the block they were dropped into is
		// not theirs alone to say: a format of the procedure, or the save, settles that.
		notify("Inserted. Format or save to settle its layout.");
		void formatEdited(editedLines(targetLine, inserted, model.getLineCount()));
	};
	/**
	 * What makes a block a place to drop on. The drop goes in above the block, and above the whole card when the
	 * block is part of one (`dropLine`, model.ts): never between a doc block and its procedure, whichever of the
	 * card's parts the pointer is over. The line is marked on the block that starts there, so over a documented
	 * procedure's header the mark shows above its doc block, where the text will land.
	 */
	const dropZone = (node: () => Node) => {
		const line = () => {
			const n = node();
			const parent = parentOf(n);
			return parent ? dropLine(parent, n) : n.start;
		};
		return {
			onDragOver: (e: DragEvent) => (e.preventDefault(), setDropAt(line())),
			onDragLeave: () => setDropAt(null),
			onDrop: (e: DragEvent) => drop(e, line()),
		};
	};

	// Out of the Tab order: the keys on the view do the same (see onKey), and the buttons show for the selected block.
	const Tools = (t: { node: Node }) => (
		<span class="block-tools" onClick={(e) => e.stopPropagation()}>
			<Show when={t.node.kind === "procedure"}>
				<button
					tabindex={-1}
					title={`Show ${t.node.name || "procedure"} in Call Graph`}
					aria-label="Show in Call Graph"
					onClick={() => void import("../graph/GraphView").then((m) => m.openGraphFocusedOn(props.path, t.node.name))}
				>
					<Icon name="references" />
				</button>
			</Show>
			<button tabindex={-1} title="Copy Markdown code citation" aria-label="Copy Markdown code citation" onClick={() => runBlockCommand(t.node, "copy-code-citation")}>
				<Icon name="quote" />
			</button>
			<button tabindex={-1} title="New decision about this block…" aria-label="New decision about this block" onClick={() => runBlockCommand(t.node, "new-decision")}>
				<Icon name="lightbulb" />
			</button>
			<button tabindex={-1} title="Ask the Agent about this block…" aria-label="Ask the Agent about this block" onClick={() => runBlockCommand(t.node, "agent-ask")}>
				<Icon name="sparkle" />
			</button>
			<button tabindex={-1} title="Move up (Alt+Up)" aria-label="Move up" onClick={() => void move(t.node, -1)}>
				<Icon name="arrow-up" />
			</button>
			<button tabindex={-1} title="Move down (Alt+Down)" aria-label="Move down" onClick={() => void move(t.node, 1)}>
				<Icon name="arrow-down" />
			</button>
			<button tabindex={-1} title="Wrap in a region" aria-label="Wrap in a region" onClick={() => void wrap(t.node)}>
				<Icon name="symbol-namespace" />
			</button>
			<button tabindex={-1} title="Show in text" aria-label="Show in text" onClick={() => select(t.node, true)}>
				<Icon name="go-to-file" />
			</button>
			<button tabindex={-1} title="Delete (Delete)" aria-label="Delete this block" onClick={() => void remove(t.node)}>
				<Icon name="trash" />
			</button>
		</span>
	);

	// --- the keyboard: the selected block is the one the text cursor is in -------------

	/** Every block that is showing, top to bottom: a folded block hides what is in it. */
	const visible = () => {
		const out: Node[] = [];
		const walk = (n: Node) => {
			for (const child of n.children) {
				if (child.kind === "blank") continue;
				out.push(child);
				// A comment's lines are not blocks of their own: the keys step over them.
				if (!isCollapsed(child) && child.kind !== "comment") walk(child);
			}
		};
		if (tree.root) walk(tree.root);
		return out;
	};
	const selectedNode = () => {
		const key = selectedKey();
		return key ? visible().find((n) => n.key === key) ?? null : null;
	};
	const editable = (n: Node) => n.kind === "text" || n.kind === "raw";
	const onKey = (e: KeyboardEvent) => {
		// An edit kept open because it could not be made yet is dropped with Escape from anywhere in the view, as
		// its notice says: the editor's own Escape only hears the key while the keyboard is in it.
		if (editing() && e.key === "Escape") return e.preventDefault(), e.stopPropagation(), void setEditing(null);
		// An open editor has its own keys, and its own undo; interactive badges handle their own Enter/Space.
		if (editing() || (e.target as HTMLElement | null)?.closest("input, textarea, button, a")) return;
		const mod = e.ctrlKey || e.metaKey;
		const key = e.key.length === 1 ? e.key.toLowerCase() : e.key;
		const editor = editors[props.group];
		const done = () => (e.preventDefault(), e.stopPropagation());
		// Undo and redo are the text's own: one history for both views.
		if (mod && key === "z") return done(), void editor?.trigger("blocks", e.shiftKey ? "redo" : "undo", null);
		if (mod && key === "y") return done(), void editor?.trigger("blocks", "redo", null);
		if (mod) return;
		const list = visible();
		const node = selectedNode();
		const at = node ? list.indexOf(node) : -1;
		if (e.altKey && node && (key === "ArrowUp" || key === "ArrowDown")) return done(), void move(node, key === "ArrowUp" ? -1 : 1);
		if (e.altKey) return;
		const go = (to: Node | undefined) => to && select(to);
		if (key === "ArrowDown") return done(), go(list[Math.min(at + 1, list.length - 1)]);
		if (key === "ArrowUp") return done(), go(list[Math.max(at - 1, 0)]);
		if (key === "Home") return done(), go(list[0]);
		if (key === "End") return done(), go(list.at(-1));
		if (!node) return;
		if (key === "ArrowLeft" && node.children.length && !isCollapsed(node)) return done(), toggle(node);
		if (key === "ArrowRight" && node.children.length && isCollapsed(node)) return done(), toggle(node);
		if (key === "Enter" || key === "F2") return done(), editable(node) ? setEditing(node.key) : headerParts(node) ? setEditing(conditionKey(node)) : toggle(node);
		if (key === " ") return done(), toggle(node);
		if (key === "Delete") return done(), void remove(node);
	};
	let scroller: HTMLDivElement | undefined;
	// The selected block is kept in view, whether the keys here moved it or the text cursor did.
	const selectedKeyMemo = createMemo(selectedKey);
	createEffect(
		() => selectedKeyMemo(),
		(key) => {
			if (key) queueMicrotask(() => scroller?.querySelector(".selected")?.scrollIntoView({ block: "nearest" }));
		},
	);
	// Leaving an edit gives the keys back to the view.
	createEffect(
		() => editing(),
		(now, before) => {
			if (before && !now) scroller?.focus({ preventScroll: true });
		},
		{ defer: true },
	);

	/** A block's first line: keyword, an editable condition field, and the rest as written. */
	const HeadLine = (props: { node: Node }) => (
		<Show when={headerParts(props.node)} fallback={<Code text={firstLine(props.node).trim()} />}>
			{(parts) => (
				<span class="b-head-line">
					<Code text={parts().before.trim()} />
					<Show
						when={editing() === conditionKey(props.node)}
						fallback={
							<span class="b-cond" title="Double-click, or Enter, to edit the condition" onDblClick={(e) => (e.stopPropagation(), beginEdit(conditionKey(props.node)))}>
								<Code text={parts().condition} />
							</span>
						}
					>
						<input
							class="b-cond-edit"
							ref={(el) => opened(el, untrack(() => parts().condition), true)}
							size={Math.max(8, parts().condition.length + 2)}
							onClick={(e) => e.stopPropagation()}
							onDblClick={(e) => e.stopPropagation()}
							onKeyDown={(e) => {
								if (e.key === "Escape") {
									e.preventDefault();
									e.stopPropagation();
									setEditing(null);
								}
								if (e.key === "Enter") {
									e.preventDefault();
									e.stopPropagation();
									commitCondition(props.node, e.currentTarget.value);
								}
							}}
							onBlur={(e) => commitCondition(props.node, e.currentTarget.value)}
						/>
					</Show>
					{/* What closes the line stands against the condition, as it does in the text: "DueRule;", not "DueRule ;". */}
					<span class={{ "b-tight": /^[;),]/.test((parts().after + parts().rest).trim()) }}>
						<Code text={(parts().after + parts().rest).trim()} />
					</span>
				</span>
			)}
		</Show>
	);

	// A procedure is drawn with its doc block, and the annotation between them, as one card.
	const Children = (props: { node: Node }) => (
		<For each={procedureGroups(props.node.children)} keyed={(g) => (g.find((c) => c.kind === "procedure") ?? g[0]!).key}>
			{(group) => (
				<Show when={group().length > 1} fallback={<Block node={group()[0]!} />}>
					<div class="b-proc-group">
						<For each={group()}>{(child) => <Block node={child} />}</For>
					</div>
				</Show>
			)}
		</For>
	);

	function Block(p: { node: Node }) {
		const badges = () => badgesFor(p.node);
		const bannerTickets = () => {
			if (p.node.kind !== "comment" || p.node.start !== 1) return [];
			const seen = new Set<string>();
			const found: DocFile[] = [];
			for (const seg of ticketRefsIn(lines(p.node), ticketLookup().keys)) {
				if (!seg.ticket) continue;
				const k = seg.ticket.toLowerCase();
				if (seen.has(k)) continue;
				const td = ticketLookup().byKey.get(k);
				if (td) {
					seen.add(k);
					found.push(td);
				}
			}
			return found.slice(0, 4);
		};
		const badgeStyle = (warn = false) => ({
			display: "inline-flex",
			"align-items": "center",
			gap: "3px",
			padding: "1px 7px",
			"border-radius": "999px",
			border: warn
				? "1px solid color-mix(in srgb, var(--warning) 45%, transparent)"
				: "1px solid var(--border)",
			background: warn
				? "color-mix(in srgb, var(--warning) 14%, transparent)"
				: "color-mix(in srgb, var(--accent) 10%, transparent)",
			color: warn ? "var(--warning)" : "var(--accent)",
			"font-family": "var(--ui-font)",
			"font-size": "var(--text-xs)",
			"font-weight": "500",
			"white-space": "nowrap",
			cursor: "pointer",
			flex: "none",
		});
		const header = (label: () => any, meta?: () => string | undefined) => (
			<div class={["block-head", { drop: dropAt() === p.node.start }]} {...dropZone(() => p.node)} onClick={() => select(p.node)} onDblClick={() => toggle(p.node)}>
				<button class="twisty" tabindex={-1} aria-label={isCollapsed(p.node) ? "Unfold" : "Fold"} aria-expanded={!isCollapsed(p.node) ? "true" : "false"} onClick={(e) => (e.stopPropagation(), toggle(p.node))}>
					<Icon name={isCollapsed(p.node) ? "chevron-right" : "chevron-down"} />
				</button>
				<span class="block-label">{label()}</span>
				<Show when={badges().plans.length}>
					<button
						type="button"
						class="block-plan-badge"
						title={`Linked plan: ${badges().plans.map((pl) => pl.title).join(", ")} — click to open`}
						style={badgeStyle(false)}
						onClick={(e) => {
							e.stopPropagation();
							const list = badges().plans;
							if (list.length === 1) {
								void openFile(list[0]!.path);
								return;
							}
							void (async () => {
								const items: QuickPickOption<BlockPlanBadge>[] = list.map((pl) => ({
									value: pl,
									label: pl.title,
									icon: "graph",
									badge: pl.steps ? { text: `${pl.steps} ${pl.steps === 1 ? "step" : "steps"}` } : undefined,
									detail: relativeTo(state.workspace?.root, pl.path).replace(/\\/g, "/"),
								}));
								const picked = await quickPick<BlockPlanBadge>({
									title: `Open governing plan for ${p.node.name || "block"}`,
									placeholder: "Filter governing plans…",
									items,
								});
								if (picked) void openFile(picked.path);
							})();
						}}
					>
						<Icon name="graph" />
						<span>{badges().plans.length === 1 ? "Plan" : `${badges().plans.length} plans`}</span>
					</button>
				</Show>
				<Show when={badges().docs.length}>
					{(() => {
						const list = () => badges().docs;
						const drifted = () => list().some((c) => c.drifted);
						return (
							<button
								type="button"
								class="block-doc-badge"
								title={`Cited by: ${list().map((c) => `${c.docTitle} (line ${c.docLine}${c.drifted ? ", drifted" : ""})`).join(", ")} — click to open`}
								style={badgeStyle(drifted())}
								onClick={(e) => {
									e.stopPropagation();
									const cur = list();
									if (cur.length === 1) {
										const first = cur[0]!;
										void openFile(first.docPath, { reveal: { line: first.docLine } });
										return;
									}
									void (async () => {
										const items: QuickPickOption<BlockDocCitation>[] = cur.map((c) => ({
											value: c,
											label: c.docTitle,
											icon: c.drifted ? "warning" : "references",
											description: `Line ${c.docLine}`,
											badge: c.drifted ? { text: "drifted", tone: "waiting" } : undefined,
											detail: relativeTo(state.workspace?.root, c.docPath).replace(/\\/g, "/"),
										}));
										const picked = await quickPick<BlockDocCitation>({
											title: `Open citing document for ${p.node.name || "block"}`,
											placeholder: "Filter citing documents…",
											items,
										});
										if (picked) void openFile(picked.docPath, { reveal: { line: picked.docLine } });
									})();
								}}
							>
								<Icon name={drifted() ? "warning" : "references"} />
								<span>{list().length === 1 ? "Doc" : `${list().length} docs`}</span>
							</button>
						);
					})()}
				</Show>
				<Show when={bannerTickets().length}>
					<For each={bannerTickets()}>
						{(td) => (
							<button
								type="button"
								class="block-ticket-pill"
								title={`${td.ticket}${td.title ? `: ${td.title}` : ""}${td.status ? ` (${td.status})` : ""} — click to open ticket`}
								style={badgeStyle(false)}
								onClick={(e) => {
									e.stopPropagation();
									void openFile(td.path);
								}}
							>
								<Icon name="tag" />
								<span>{td.ticket}</span>
							</button>
						)}
					</For>
				</Show>
				<Show when={meta?.()}>
					{(text) => <span class="meta">{text()}</span>}
				</Show>
				<Tools node={p.node} />
			</div>
		);
		const size = () => `${p.node.end - p.node.start + 1} lines`;
		// Where it starts in the text, so that a block here and a line number in Problems or a diff are the same place.
		const from = () => `line ${p.node.start}`;
		return (
			<Switch>
				<Match when={p.node.kind === "region"}>
					<section class={["b-region", { selected: selectedKey() === p.node.key }]} style={{ "--region": regionColor(p.node.name!) }}>
						{header(() => <strong>{p.node.name}</strong>, () => `${from()} · ${size()} · ${p.node.children.filter((c) => c.kind === "procedure").length} procedures`)}
						<Show when={!isCollapsed(p.node)}>
							<div class="block-body">
								<Children node={p.node} />
							</div>
						</Show>
					</section>
				</Match>
				<Match when={p.node.kind === "procedure"}>
					<section class={["b-procedure", { selected: selectedKey() === p.node.key }]}>
						{header(
							() => (
								<>
									<span class="proc-icon">ƒ</span> <strong>{p.node.name}</strong>
									<span class="params">({p.node.params?.join(", ")})</span>
								</>
							),
							() => `${from()} · ${size()}`,
						)}
						<Show when={!isCollapsed(p.node)}>
							<div class="block-body">
								<Children node={p.node} />
							</div>
						</Show>
					</section>
				</Match>
				<Match when={p.node.kind === "block"}>
					<section class={["b-block", { selected: selectedKey() === p.node.key, "b-class": Boolean(p.node.classHead) }]}>
						{header(
							() => (
								<>
									<Show when={p.node.classHead}>
										<span class="class-mark" title="A class: its name, what it inherits and its fields">
											class
										</span>{" "}
									</Show>
									<HeadLine node={p.node} />
								</>
							),
							() => (p.node.end - p.node.start > 1 ? size() : undefined),
						)}
						<Show when={!isCollapsed(p.node)}>
							<div class="block-body">
								<Children node={p.node} />
							</div>
						</Show>
					</section>
				</Match>
				<Match when={p.node.kind === "comment"}>
					<section class={["b-comment", { selected: selectedKey() === p.node.key, banner: p.node.start === 1, "b-doc": Boolean(p.node.doc) }]}>
						{header(
							() => (
								<Switch
									fallback={
										<span class="comment-first">
											<TicketLinkedText text={firstLine(p.node).trim()} />
										</span>
									}
								>
									<Match when={p.node.start === 1}>
										<strong>File banner</strong>
									</Match>
									<Match when={p.node.doc}>
										<span class="doc-mark">Doc block</span>
									</Match>
								</Switch>
							),
							size,
						)}
						<Show when={!isCollapsed(p.node)}>
							<div class="block-body">
								<pre class="comment-text">
									<TicketLinkedText text={lines(p.node).split(/\r?\n/).slice(1).join("\n")} />
								</pre>
							</div>
						</Show>
					</section>
				</Match>
				<Match when={p.node.kind === "text"}>
					<Show
						when={editing() === p.node.key}
						fallback={
							<div class={["b-text", { selected: selectedKey() === p.node.key, drop: dropAt() === p.node.start }]} {...dropZone(() => p.node)} title="Double-click, or Enter, to edit" onClick={() => select(p.node)} onDblClick={() => beginEdit(p.node.key)}>
								<Code text={lines(p.node)} />
							</div>
						}
					>
						<textarea
							class="b-edit"
							ref={(el) => opened(el, untrack(() => lines(p.node)))}
							rows={p.node.end - p.node.start + 1}
							onInput={(e) => fitEdit(e.currentTarget)}
							onKeyDown={(e) => {
								if (e.key === "Escape") {
									e.preventDefault();
									e.stopPropagation();
									setEditing(null);
								}
								if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
									e.preventDefault();
									e.stopPropagation();
									commitEdit(p.node, e.currentTarget.value);
								}
							}}
							onBlur={(e) => commitEdit(p.node, e.currentTarget.value)}
						/>
					</Show>
				</Match>
				<Match when={p.node.kind === "raw"}>
					<div class={["b-text b-raw", { selected: selectedKey() === p.node.key }]} title="The language server could not read this; it is kept as written. Double-click, or Enter, to edit." onClick={() => select(p.node)} onDblClick={() => beginEdit(p.node.key)}>
						<Show when={editing() === p.node.key} fallback={<Code text={lines(p.node)} />}>
							<textarea
								class="b-edit"
								ref={(el) => opened(el, untrack(() => lines(p.node)))}
								rows={p.node.end - p.node.start + 1}
								onInput={(e) => fitEdit(e.currentTarget)}
								onKeyDown={(e) => {
									if (e.key === "Escape") {
										e.preventDefault();
										e.stopPropagation();
										setEditing(null);
									}
									if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
										e.preventDefault();
										e.stopPropagation();
										commitEdit(p.node, e.currentTarget.value);
									}
								}}
								onBlur={(e) => commitEdit(p.node, e.currentTarget.value)}
							/>
						</Show>
					</div>
				</Match>
				<Match when={p.node.kind === "blank"}>
					<div class={["b-blank", { drop: dropAt() === p.node.start }]} {...dropZone(() => p.node)} />
				</Match>
			</Switch>
		);
	}

	const collapseAll = (all: boolean) => {
		const walk = (n: Node) =>
			n.children.forEach((c) => {
				if (!c.fold) return;
				if (c.kind === "procedure" || c.kind === "block" || c.kind === "comment") all ? collapsed().add(c.fold) : collapsed().delete(c.fold);
				if (c.kind === "region" && !all) collapsed().delete(c.fold);
				walk(c);
			});
		if (tree.root) walk(tree.root);
		setCollapseVersion((v) => v + 1);
	};

	return (
		<div class="blocks">
			<div class="blocks-bar">
				<span class="hint" title="Up and Down move between blocks. Left and Right fold and unfold. Enter edits. Alt+Up and Alt+Down move a block. Delete removes it. Ctrl+Z undoes.">
					Blocks: a view of the text. Arrows move, Enter edits, Ctrl+Z undoes here and in Text.
				</span>
				<button onClick={() => collapseAll(true)}>Collapse to signatures</button>
				<button onClick={() => collapseAll(false)}>Expand all</button>
			</div>
			<Show
				when={tree.root}
				fallback={
					<Show when={failed()} fallback={<p class="hint">{state.lsp.state !== "running" ? "Blocks need the language server, which is not running. Restart it from the status bar, or switch to Text." : lspAnswering() ? "Reading the structure…" : "Blocks need the language server, which is not answering. Restart it from the status bar, or switch to Text."}</p>}>
						<div class="hint" role="alert">
							<p>The language server could not give this file's structure: {failed()}</p>
							<button class="link" onClick={() => (setFailed(null), setVersion((v) => v + 1))}>
								Try again
							</button>
						</div>
					</Show>
				}
			>
				<div class="blocks-scroll" ref={scroller} tabindex={0} role="group" aria-label="Blocks of this script. Arrow keys move between blocks." onKeyDown={onKey}>
					<Children node={tree.root!} />
				</div>
			</Show>
		</div>
	);
}
