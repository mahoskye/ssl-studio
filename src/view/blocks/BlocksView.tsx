// Blocks mode: the open file as region frames, procedure cards, control-flow
// blocks and code chips. A view of the text, never a copy: every action here
// is a text edit on the model the text editor shows, so one undo stack serves
// both modes (ADR 0002).
import { Icon } from "../Icon";
import { createEffect, createMemo, createResource, createSignal, For, Match, on, onCleanup, Show, Switch } from "solid-js";
import { createStore, reconcile } from "solid-js/store";
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
import { session } from "../lsp/session";
import { ask, choose, quickPick, type QuickPickOption } from "../dialogs";
import { docs, isMarkdown } from "../project";
import { canonical, documents, notify, openFile, setState, state } from "../state";
import { buildTree, neighbour, pathTo, procedureGroups, splitHeader, swapLines, treeFromSyntax, type Node, type SymbolIn } from "./model";

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

const collapsedByPath = new Map<string, Set<string>>();
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
	const [html] = createResource(
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
	const collapsed = () => {
		if (!collapsedByPath.has(props.path)) collapsedByPath.set(props.path, new Set());
		return collapsedByPath.get(props.path)!;
	};
	const [collapseVersion, setCollapseVersion] = createSignal(0);
	const isCollapsed = (n: Node) => (collapseVersion(), collapsed().has(n.key));
	const toggle = (n: Node) => {
		collapsed().has(n.key) ? collapsed().delete(n.key) : collapsed().add(n.key);
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
	createEffect(() => {
		const root = state.workspace?.root;
		if (collapsedRoot !== undefined && collapsedRoot !== root) {
			collapsedByPath.clear();
			setCollapseVersion((v) => v + 1);
		}
		collapsedRoot = root;
	});
	createEffect(
		on(
			() => [props.path, state.lsp.state] as const,
			() => {
				treeVersionId = -1;
				const model = doc()?.model;
				if (!model || model.isDisposed()) return;
				const sub = model.onDidChangeContent(() => {
					clearTimeout(timer);
					timer = setTimeout(() => setVersion((v) => v + 1), 300);
				});
				refreshNow();
				onCleanup(() => {
					clearTimeout(timer);
					timer = undefined;
					sub.dispose();
				});
			},
		),
	);
	createEffect(
		on(version, async () => {
			const req = ++reqSeq;
			const model = doc()?.model;
			if (!model || model.isDisposed()) return;
			if (state.lsp.state !== "running") {
				setFailed(null);
				return;
			}
			const startVersion = model.getVersionId();
			const stale = () => req !== reqSeq || model.isDisposed() || doc()?.model !== model || model.getVersionId() !== startVersion;
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
				const first = tree.root === null;
				treeVersionId = startVersion;
				setFailed(null);
				setTree("root", reconcile(root, { key: "key", merge: false }));
				setRead((v) => v + 1);
				// The banner opens folded; long files open as a region outline.
				if (first) {
					const banner = root.children.find((c) => c.kind === "comment" && c.start === 1);
					if (banner) collapsed().add(banner.key);
					if (model.getLineCount() > 300) {
						const walk = (n: Node) => n.children.forEach((c) => (c.kind === "procedure" || c.kind === "comment" ? collapsed().add(c.key) : walk(c)));
						walk(root);
					}
					setCollapseVersion((v) => v + 1);
				}
			} catch (e: any) {
				if (stale()) return;
				if (state.lsp.state !== "running") {
					setFailed(null);
					return;
				}
				treeVersionId = -1;
				setTree("root", null);
				setFailed(String(e?.message ?? e));
			}
		}),
	);

	// The tree is read a moment after the text changes, so a node can point past the
	// end of a file that just got shorter. Such a node shows nothing until the next read.
	const within = (n: Node) => {
		const model = doc()?.model;
		return Boolean(model && !model.isDisposed() && n.start >= 1 && n.end <= model.getLineCount());
	};
	const lines = (n: Node) => (read(), within(n) ? doc()!.model.getValueInRange(new monaco.Range(n.start, 1, n.end, doc()!.model.getLineMaxColumn(n.end))) : "");
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
	const select = (n: Node, focusText = false) => {
		const editor = editors[props.group];
		const model = doc()?.model;
		setState("activeGroup", props.group);
		if (model && !model.isDisposed()) {
			const lineCount = model.getLineCount();
			const start = Math.max(1, Math.min(n.start, lineCount));
			const end = Math.max(start, Math.min(n.end, lineCount));
			const maxCol = model.getLineMaxColumn(end);
			editor?.setSelection(new monaco.Range(start, 1, end, maxCol));
		} else {
			editor?.setSelection(new monaco.Range(n.start, 1, n.end, 1));
		}
		setState("cursor", { line: n.start, column: 1 });
		if (focusText) {
			setState("groups", props.group, "mode", "text");
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
		return `${props.path}|${state.treeVersion}|${gov.map((g) => g.file.path).join(",")}`;
	});
	const [traceData] = createResource(govFingerprint, async () => {
		const wsRoot = state.workspace?.root;
		const allDocs = docs();
		const gov = docsGoverningFile(allDocs, props.path, wsRoot);
		const planByProc = new Map<string, BlockPlanBadge[]>();
		const citations: BlockDocCitation[] = [];
		const canonSelf = canonical(props.path);

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
						if (u.script && !codeMatchesRef(props.path, u.script, wsRoot)) continue;
						addProc(u.name, Array.isArray(u.nodes) ? u.nodes.length : 0);
					}
					for (const t of parsed.targets ?? []) {
						if (typeof t === "object" && t && Array.isArray(t.procedures)) {
							const scriptRef = t.script ?? t.path ?? "";
							if (scriptRef && !codeMatchesRef(props.path, scriptRef, wsRoot)) continue;
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
					let matches = codeMatchesRef(props.path, cit.file, wsRoot);
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
	const formatLines = async (start: number, end: number) => {
		const model = doc()?.model;
		if (!model || model.isDisposed()) return;
		try {
			const edits = await session.formatRanges(model, [[start - 1, Math.min(end, model.getLineCount()) - 1]], model.getOptions());
			if (!model.isDisposed() && edits.length) model.pushEditOperations([], edits, () => null);
		} catch {
			// The move stands unformatted; format on save will tidy it.
		} finally {
			if (!model.isDisposed()) model.pushStackElement();
		}
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
		if (!isTreeFresh(model) || !within(n)) return;
		const parent = parentOf(n);
		const other = parent && neighbour(parent, n, direction);
		if (!other || !within(other)) return;
		const [a, b] = direction < 0 ? [other, n] : [n, other];
		const swapped = swapLines(model.getLinesContent(), a, b);
		replaceLines(swapped.start, swapped.end, swapped.lines.join("\n"), false);
		await formatLines(swapped.start, swapped.end);
		refreshNow();
	};
	const wrap = async (n: Node) => {
		const model = doc()?.model;
		if (!isTreeFresh(model) || !within(n)) return;
		const beforeVer = model.getVersionId();
		const name = await ask("Name of the new region");
		if (!name) return;
		if (model.isDisposed() || doc()?.model !== model || model.getVersionId() !== beforeVer || !within(n)) return;
		const body = lines(n);
		replaceLines(n.start, n.end, `/* region ${name};\n${body}\n/* endregion;`, false);
		await formatLines(n.start, n.end + 2);
		refreshNow();
	};
	const remove = async (n: Node) => {
		const model = doc()?.model;
		if (!isTreeFresh(model) || !within(n)) return;
		const beforeVer = model.getVersionId();
		if ((await choose(`Delete ${n.name ?? `lines ${n.start}-${n.end}`}? Undo brings it back.`, ["Delete"], { danger: "Delete" })) !== "Delete") return;
		if (model.isDisposed() || doc()?.model !== model || model.getVersionId() !== beforeVer || !within(n)) return;
		replaceLines(n.start, n.end, null);
		refreshNow();
	};
	/**
	 * An in-place editor's text, set once as it opens: bound reactively, a tree
	 * refresh while it is open would write the old text over what is typed.
	 */
	const opened = (el: HTMLInputElement | HTMLTextAreaElement, text: string, select = false) => {
		el.value = text;
		queueMicrotask(() => (el.focus(), select && el.select()));
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
	/** Replaces only the condition, as one undoable edit; keyword, spacing and `;` stay as written. */
	const commitCondition = (n: Node, value: string) => {
		if (editing() !== conditionKey(n)) return;
		setEditing(null);
		const model = doc()?.model;
		if (!isTreeFresh(model)) return;
		const parts = headerParts(n);
		const condition = value.trim();
		if (!parts || condition === parts.condition) return;
		if (!condition) return notify("A condition cannot be empty; edit the statement in text to remove it.");
		const h = n.header!;
		const from = h.startColumn + parts.before.length;
		model.pushStackElement();
		model.pushEditOperations([], [{ range: new monaco.Range(h.line, from, h.line, from + parts.condition.length), text: condition }], () => null);
		model.pushStackElement();
		refreshNow();
	};
	const commitEdit = (n: Node, text: string) => {
		if (editing() !== n.key) return;
		setEditing(null);
		const model = doc()?.model;
		if (!isTreeFresh(model) || !within(n)) return;
		if (text !== lines(n).replace(/\r\n/g, "\n")) {
			replaceLines(n.start, n.end, text);
			refreshNow();
		}
	};
	const drop = (e: DragEvent, line: number) => {
		e.preventDefault();
		setDropAt(null);
		const model = doc()?.model;
		if (!isTreeFresh(model)) return;
		const text = e.dataTransfer?.getData("text/plain");
		if (!text) return;
		const targetLine = Math.max(1, Math.min(line, model.getLineCount()));
		const eol = model.getEOL();
		model.pushStackElement();
		model.pushEditOperations([], [{ range: new monaco.Range(targetLine, 1, targetLine, 1), text: text.replace(/\r?\n/g, "\n").replace(/\n?$/, "\n").replace(/\n/g, eol) }], () => null);
		model.pushStackElement();
		notify("Inserted. Format or save to settle its layout.");
		refreshNow();
	};
	const dropZone = (line: number) => ({
		onDragOver: (e: DragEvent) => (e.preventDefault(), setDropAt(line)),
		onDragLeave: () => setDropAt(null),
		onDrop: (e: DragEvent) => drop(e, line),
	});

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
	createEffect(() => {
		if (selectedKey()) queueMicrotask(() => scroller?.querySelector(".selected")?.scrollIntoView({ block: "nearest" }));
	});
	// Leaving an edit gives the keys back to the view.
	createEffect(on(editing, (now, before) => before && !now && scroller?.focus({ preventScroll: true }), { defer: true }));

	/** A block's first line: keyword, an editable condition field, and the rest as written. */
	const HeadLine = (props: { node: Node }) => {
		const n = props.node;
		return (
			<Show when={headerParts(n)} fallback={<Code text={firstLine(n).trim()} />}>
				{(parts) => (
					<span class="b-head-line">
						<Code text={parts().before.trim()} />
						<Show
							when={editing() === conditionKey(n)}
							fallback={
								<span class="b-cond" title="Double-click, or Enter, to edit the condition" onDblClick={(e) => (e.stopPropagation(), setEditing(conditionKey(n)))}>
									<Code text={parts().condition} />
								</span>
							}
						>
							<input
								class="b-cond-edit"
								ref={(el) => opened(el, parts().condition, true)}
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
										commitCondition(n, e.currentTarget.value);
									}
								}}
								onBlur={(e) => commitCondition(n, e.currentTarget.value)}
							/>
						</Show>
						{/* What closes the line stands against the condition, as it does in the text: "DueRule;", not "DueRule ;". */}
						<span classList={{ "b-tight": /^[;),]/.test((parts().after + parts().rest).trim()) }}>
							<Code text={(parts().after + parts().rest).trim()} />
						</span>
					</span>
				)}
			</Show>
		);
	};

	// A procedure is drawn with its doc block, and the annotation between them, as one card.
	const Children = (props: { node: Node }) => (
		<For each={procedureGroups(props.node.children)}>
			{(group) => (
				<Show when={group.length > 1} fallback={<Block node={group[0]!} />}>
					<div class="b-proc-group">
						<For each={group}>{(child) => <Block node={child} />}</For>
					</div>
				</Show>
			)}
		</For>
	);

	function Block(p: { node: Node }) {
		const n = p.node;
		const badges = () => badgesFor(n);
		const bannerTickets = () => {
			if (n.kind !== "comment" || n.start !== 1) return [];
			const seen = new Set<string>();
			const found: DocFile[] = [];
			for (const seg of ticketRefsIn(lines(n), ticketLookup().keys)) {
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
		const header = (label: any, meta?: () => string | undefined) => (
			<div class="block-head" {...dropZone(n.start)} classList={{ drop: dropAt() === n.start }} onClick={() => select(n)} onDblClick={() => toggle(n)}>
				<button class="twisty" tabindex={-1} aria-label={isCollapsed(n) ? "Unfold" : "Fold"} aria-expanded={!isCollapsed(n)} onClick={(e) => (e.stopPropagation(), toggle(n))}>
					<Icon name={isCollapsed(n) ? "chevron-right" : "chevron-down"} />
				</button>
				<span class="block-label">{label}</span>
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
									title: `Open governing plan for ${n.name || "block"}`,
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
											title: `Open citing document for ${n.name || "block"}`,
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
				<Tools node={n} />
			</div>
		);
		const size = () => `${n.end - n.start + 1} lines`;
		// Where it starts in the text, so that a block here and a line number in Problems or a diff are the same place.
		const from = () => `line ${n.start}`;
		return (
			<Switch>
				<Match when={n.kind === "region"}>
					<section class="b-region" classList={{ selected: selectedKey() === n.key }} style={{ "--region": regionColor(n.name!) }}>
						{header(<strong>{n.name}</strong>, () => `${from()} · ${size()} · ${n.children.filter((c) => c.kind === "procedure").length} procedures`)}
						<Show when={!isCollapsed(n)}>
							<div class="block-body">
								<Children node={n} />
							</div>
						</Show>
					</section>
				</Match>
				<Match when={n.kind === "procedure"}>
					<section class="b-procedure" classList={{ selected: selectedKey() === n.key }}>
						{header(
							<>
								<span class="proc-icon">ƒ</span> <strong>{n.name}</strong>
								<span class="params">({n.params?.join(", ")})</span>
							</>,
							() => `${from()} · ${size()}`,
						)}
						<Show when={!isCollapsed(n)}>
							<div class="block-body">
								<Children node={n} />
							</div>
						</Show>
					</section>
				</Match>
				<Match when={n.kind === "block"}>
					<section class="b-block" classList={{ selected: selectedKey() === n.key, "b-class": Boolean(n.classHead) }}>
						{header(
							<>
								<Show when={n.classHead}>
									<span class="class-mark" title="A class: its name, what it inherits and its fields">
										class
									</span>{" "}
								</Show>
								<HeadLine node={n} />
							</>,
							() => (n.end - n.start > 1 ? size() : undefined),
						)}
						<Show when={!isCollapsed(n)}>
							<div class="block-body">
								<Children node={n} />
							</div>
						</Show>
					</section>
				</Match>
				<Match when={n.kind === "comment"}>
					<section class="b-comment" classList={{ selected: selectedKey() === n.key, banner: n.start === 1, "b-doc": Boolean(n.doc) }}>
						{header(
							n.start === 1 ? (
								<strong>File banner</strong>
							) : n.doc ? (
								<span class="doc-mark">Doc block</span>
							) : (
								<span class="comment-first">
									<TicketLinkedText text={firstLine(n).trim()} />
								</span>
							),
							size,
						)}
						<Show when={!isCollapsed(n)}>
							<div class="block-body">
								<pre class="comment-text">
									<TicketLinkedText text={lines(n).split(/\r?\n/).slice(1).join("\n")} />
								</pre>
							</div>
						</Show>
					</section>
				</Match>
				<Match when={n.kind === "text"}>
					<Show
						when={editing() === n.key}
						fallback={
							<div class="b-text" {...dropZone(n.start)} classList={{ selected: selectedKey() === n.key, drop: dropAt() === n.start }} title="Double-click, or Enter, to edit" onClick={() => select(n)} onDblClick={() => setEditing(n.key)}>
								<Code text={lines(n)} />
							</div>
						}
					>
						<textarea
							class="b-edit"
							ref={(el) => opened(el, lines(n))}
							rows={n.end - n.start + 1}
							onKeyDown={(e) => {
								if (e.key === "Escape") {
									e.preventDefault();
									e.stopPropagation();
									setEditing(null);
								}
								if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
									e.preventDefault();
									e.stopPropagation();
									commitEdit(n, e.currentTarget.value);
								}
							}}
							onBlur={(e) => commitEdit(n, e.currentTarget.value)}
						/>
					</Show>
				</Match>
				<Match when={n.kind === "raw"}>
					<div class="b-text b-raw" classList={{ selected: selectedKey() === n.key }} title="The language server could not read this; it is kept as written. Double-click, or Enter, to edit." onClick={() => select(n)} onDblClick={() => setEditing(n.key)}>
						<Show when={editing() === n.key} fallback={<Code text={lines(n)} />}>
							<textarea
								class="b-edit"
								ref={(el) => opened(el, lines(n))}
								rows={n.end - n.start + 1}
								onKeyDown={(e) => {
									if (e.key === "Escape") {
										e.preventDefault();
										e.stopPropagation();
										setEditing(null);
									}
									if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
										e.preventDefault();
										e.stopPropagation();
										commitEdit(n, e.currentTarget.value);
									}
								}}
								onBlur={(e) => commitEdit(n, e.currentTarget.value)}
							/>
						</Show>
					</div>
				</Match>
				<Match when={n.kind === "blank"}>
					<div class="b-blank" {...dropZone(n.start)} classList={{ drop: dropAt() === n.start }} />
				</Match>
			</Switch>
		);
	}

	const collapseAll = (all: boolean) => {
		const walk = (n: Node) =>
			n.children.forEach((c) => {
				if (c.kind === "procedure" || c.kind === "block" || c.kind === "comment") all ? collapsed().add(c.key) : collapsed().delete(c.key);
				if (c.kind === "region" && !all) collapsed().delete(c.key);
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
					<Show when={failed()} fallback={<p class="hint">{state.lsp.state === "running" ? "Reading the structure…" : "Blocks need the language server, which is not running. Restart it from the status bar, or switch to Text."}</p>}>
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
