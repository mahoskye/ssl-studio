// Obsidian-grade CodeMirror 6 Live Preview editor for Markdown (ADR 0028).
// Synced 1:1 with the open document's Monaco ITextModel (ADR 0002: plain text
// stays the single source of truth for saves, undo across views, Git, Search,
// Diagnostics, Agent, and Document Outline).
import { history } from "@codemirror/commands";
import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { EditorSelection, EditorState, type Transaction } from "@codemirror/state";
import { drawSelection, dropCursor, EditorView, highlightSpecialChars } from "@codemirror/view";
import DOMPurify from "dompurify";
import { marked } from "marked";
import { createEffect, createMemo, createResource, createSignal, For, on, onCleanup, onMount, Show } from "solid-js";
import { linkLeads } from "../../shared/docLinks";
import { frontMatter } from "../../shared/frontMatter";
import { findHeadingLine } from "../../shared/markdownEdit";
import { docByName, linkedFrom, namedLink } from "../../shared/namedLinks";
import { baseName, dirName, isInside, joinPath, relativeTo } from "../../shared/paths";
import { DOC_FOLDERS, registryTitle, statusChoices, toneOf } from "../../shared/projectDocs";
import { rowsLine } from "../../shared/registryTickets";
import { ticketWork } from "../../shared/workContext";
import { backend } from "../backend";
import { choose } from "../dialogs";
import { Icon } from "../Icon";
import { Menu } from "../Menu";
import { noteCursor } from "../navigation";
import { chooseFromMenu } from "../panels/RowMenu";
import { searchFor } from "../panels/Search";
import { docs } from "../project";
import { setStatus } from "../projectDocs";
import {
	canonical,
	documents,
	notify,
	openFile,
	openedForALook,
	revealSignal,
	setMarkdownMode,
	setState,
	state,
	takeReveal,
} from "../state";
import { cmMarkdownCompletion } from "./cmCompletion";
import { cmAutoWrapExtension, cmMarkdownKeymap, cmSearchTop, cmSmartPasteExtension, historyFallbackFacet, runCmAction } from "./cmKeymap";
import "./cmLive.css";
import {
	editYamlField,
	linkAtOffset,
	liveBlockField,
	liveCallbacksFacet,
	liveInlinePlugin,
	liveInteractionExtension,
	markdownFoldService,
	refreshLiveEffect,
	setEditYamlEffect,
	type HoverTarget,
} from "./cmLivePlugin";
import { cmMarkdownHighlight, cmStudioTheme } from "./cmTheme";
import { registerLiveEditor, type LiveEditorHandle } from "./liveBridge";
import { monaco } from "./monaco";
import { askRows } from "./tableRows";

type SavedLiveView = { anchor: number; head: number; scrollTop: number };
const savedLiveViews = new Map<string, SavedLiveView>();

type HoverCard = {
	title: string;
	relPath: string;
	html: string;
	x: number;
	y: number;
};

async function readFileText(path: string): Promise<string> {
	const key = canonical(path);
	const open = documents.get(key);
	if (open) return open.model.getValue();
	try {
		return (await backend.read(path)).text;
	} catch {
		return "";
	}
}

export function MarkdownLiveEditor(props: { path: string; group: number }) {
	const doc = documents.get(props.path);
	const model = doc?.model;
	const [text, setText] = createSignal(model?.getValue() ?? "");
	const [propsOpen, setPropsOpen] = createSignal(true);
	const [editYaml, setEditYaml] = createSignal(false);
	const [backlinksOpen, setBacklinksOpen] = createSignal(true);
	const [hoverCard, setHoverCard] = createSignal<HoverCard | null>(null);

	let hostEl!: HTMLDivElement;
	let cmMountEl!: HTMLDivElement;
	let cmView: EditorView | undefined;
	let syncingFromCm = false;
	let syncingFromModel = false;
	let refreshSeq = 0;

	// --- Frontmatter Properties, Ticket Work & Backlinks ---------------------
	const front = createMemo(() => frontMatter(text()));
	const facts = createMemo(() =>
		Object.entries(front().values)
			.filter(([key, value]) => key !== "title" && (Array.isArray(value) ? value.length : value))
			.map(([key, value]) => ({ key, values: Array.isArray(value) ? value : [value] })),
	);
	const ticketFile = (key: string) =>
		state.workspace && state.project ? joinPath(state.workspace.root, ...state.project.docs.split(/[\\/]/), DOC_FOLDERS.tickets, `${key}.md`) : "";
	const targetOf = (key: string, value: string): { file?: string; web?: string } => {
		if (/^https?:\/\//i.test(value)) return { web: value };
		if (["ticket", "tickets", "related", "parent", "blocks", "blocked-by"].includes(key)) return { file: ticketFile(value) };
		if (["specs", "spec", "plan", "plans"].includes(key) && state.workspace) return { file: joinPath(state.workspace.root, ...value.split("/")) };
		return {};
	};
	const go = (target: { file?: string; web?: string }) =>
		target.web ? void window.open(target.web, "_blank", "noopener") : target.file ? void openFile(target.file) : undefined;

	const ticket = createMemo(() => {
		const file = docs().find((d) => d.group === "tickets" && d.ticket && canonical(d.path) === props.path);
		return file?.ticket ?? "";
	});
	const work = createMemo(() => (ticket() ? ticketWork(docs(), ticket()) : []));
	const listed = createMemo(() => docs().find((d) => ["tickets", "specs", "knowledge"].includes(d.group) && canonical(d.path) === props.path));

	const [linked] = createResource(
		() => ({ path: props.path, files: docs(), root: state.workspace?.root }),
		async ({ path, files, root }) => {
			if (!root) return [];
			try {
				const [byPath, byName] = await Promise.all([backend.linksTo(path), backend.namesIn()]);
				return linkedFrom(
					canonical(path),
					byPath.map((link) => ({ path: canonical(link.path), line: link.line })),
					byName.map((place) => ({ ...place, path: canonical(place.path) })),
					files.map((file) => ({ ...file, path: canonical(file.path) })),
					root,
				);
			} catch {
				return [];
			}
		},
	);

	const called = (path: string) => {
		const file = docs().find((d) => canonical(d.path) === path);
		if (!file) return relativeTo(state.workspace?.root, path);
		const title = file.title || file.name;
		return file.ticket && !title.toLowerCase().startsWith(file.ticket.toLowerCase()) ? `${file.ticket}: ${title}` : title;
	};

	// --- Navigation, Link Following & Note Creation --------------------------
	const jumpToLine = (line: number, column = 1, endLine?: number, endColumn?: number) => {
		if (!cmView) return;
		const docObj = cmView.state.doc;
		const ln = Math.max(1, Math.min(line, docObj.lines));
		const startLine = docObj.line(ln);
		const from = Math.min(startLine.to, startLine.from + Math.max(0, column - 1));
		let to = from;
		if (endLine !== undefined) {
			const eln = Math.max(1, Math.min(endLine, docObj.lines));
			const endLineObj = docObj.line(eln);
			to = Math.min(endLineObj.to, endLineObj.from + Math.max(0, (endColumn ?? 1) - 1));
		}
		cmView.dispatch({
			selection: EditorSelection.range(from, to),
			effects: EditorView.scrollIntoView(from, { y: "center" }),
		});
		cmView.focus();
	};

	const followHeadingInFile = async (targetPath: string, heading: string) => {
		const content = await readFileText(targetPath);
		const line = findHeadingLine(content, heading);
		if (canonical(targetPath) === props.path && line) {
			jumpToLine(line);
			return;
		}
		await openFile(targetPath, line ? { reveal: { line } } : {});
	};

	const followLink = async (href: string) => {
		const leads = linkLeads(href, props.path, state.workspace?.root);
		if (!leads) return;
		if ("web" in leads) return void window.open(leads.web, "_blank", "noopener");
		if ("heading" in leads) {
			const line = findHeadingLine(cmView?.state.doc.toString() ?? text(), leads.heading);
			if (line) jumpToLine(line);
			return;
		}
		if (!leads.lines && href.includes("#")) {
			const hash = decodeURIComponent(href.slice(href.indexOf("#") + 1));
			if (hash) return void followHeadingInFile(leads.file, hash);
		}
		await openFile(leads.file, leads.lines ? { reveal: leads.lines } : {});
	};

	const followWiki = async (innerRaw: string) => {
		const bar = innerRaw.indexOf("|");
		const targetPart = (bar < 0 ? innerRaw : innerRaw.slice(0, bar)).trim();
		if (targetPart.startsWith("#")) {
			const heading = targetPart.slice(1).trim();
			const line = findHeadingLine(cmView?.state.doc.toString() ?? text(), heading);
			if (line) jumpToLine(line);
			return;
		}
		const parsed = namedLink(innerRaw.replace(/\\\|/g, "|"));
		if (!parsed) return;
		const root = state.workspace?.root;
		const found = docByName(parsed.name, docs(), root);
		if (found) {
			if (parsed.heading) return void followHeadingInFile(found.path, parsed.heading);
			await openFile(found.path);
			return;
		}
		// Unresolved wikilink: offer to create the note right away (Obsidian workflow).
		if (!root) return;
		const safeName = parsed.name.replace(/[\\/:*?"<>|]+/g, "-").trim();
		if (!safeName) return;
		const fileName = /\.md$/i.test(safeName) ? safeName : `${safeName}.md`;
		const dest = joinPath(dirName(props.path), fileName);
		if (!isInside(root, dest)) return;
		const picked = await choose(`No note named “${parsed.name}” exists yet. Create ${relativeTo(root, dest)}?`, ["Create note"]);
		if (picked !== "Create note") return;
		try {
			await backend.create(dest, "file");
			await backend.write(dest, `# ${parsed.name.replace(/\.md$/i, "")}\n\n`);
			setState("treeVersion", (v) => v + 1);
			await openFile(dest);
		} catch (e: any) {
			notify(`Could not create note: ${e?.message ?? e}`, "error");
		}
	};

	const followTicket = (key: string) => {
		const found = docs().find((d) => d.group === "tickets" && d.exists && d.ticket?.toLowerCase() === key.toLowerCase());
		if (found) void openFile(found.path);
	};

	// --- Obsidian Hover Page Preview -----------------------------------------
	let hoverTimer: ReturnType<typeof setTimeout> | undefined;
	let hideTimer: ReturnType<typeof setTimeout> | undefined;
	let cardHovered = false;

	const cancelHover = () => {
		clearTimeout(hoverTimer);
		clearTimeout(hideTimer);
	};

	const scheduleHideHover = () => {
		clearTimeout(hoverTimer);
		clearTimeout(hideTimer);
		hideTimer = setTimeout(() => {
			if (!cardHovered) setHoverCard(null);
		}, 180);
	};

	const resolveHoverPath = (target: HoverTarget): { path: string; heading?: string } | null => {
		const root = state.workspace?.root;
		if (target.kind === "ticket") {
			const found = docs().find((d) => d.group === "tickets" && d.exists && d.ticket?.toLowerCase() === target.key.toLowerCase());
			return found ? { path: found.path } : null;
		}
		if (target.kind === "wiki") {
			const bar = target.inner.indexOf("|");
			const part = (bar < 0 ? target.inner : target.inner.slice(0, bar)).trim();
			if (part.startsWith("#")) return { path: props.path, heading: part.slice(1).trim() };
			const parsed = namedLink(target.inner.replace(/\\\|/g, "|"));
			if (!parsed) return null;
			const found = docByName(parsed.name, docs(), root);
			return found ? { path: found.path, heading: parsed.heading } : null;
		}
		const leads = linkLeads(target.href, props.path, root);
		if (!leads || "web" in leads) return null;
		if ("heading" in leads) return { path: props.path, heading: leads.heading };
		return { path: leads.file };
	};

	const handleHoverLink = (target: HoverTarget) => {
		clearTimeout(hideTimer);
		clearTimeout(hoverTimer);
		const rect = target.anchor.getBoundingClientRect();
		hoverTimer = setTimeout(async () => {
			const resolved = resolveHoverPath(target);
			if (!resolved || !/\.(md|markdown)$/i.test(resolved.path)) return;
			const raw = await readFileText(resolved.path);
			if (!raw.trim()) return;
			const fm = frontMatter(raw);
			let snippet = fm.body;
			if (resolved.heading) {
				const ln = findHeadingLine(raw, resolved.heading);
				if (ln) snippet = raw.split(/\r?\n/).slice(ln - 1).join("\n");
			}
			const previewMd = snippet.split(/\r?\n/).slice(0, 28).join("\n");
			const html = DOMPurify.sanitize(marked.parse(previewMd, { async: false, gfm: true }) as string);
			const cardWidth = Math.min(440, window.innerWidth - 32);
			const x = Math.max(16, Math.min(rect.left, window.innerWidth - cardWidth - 16));
			const preferBelow = rect.bottom + 10;
			const y = preferBelow + 240 < window.innerHeight ? preferBelow : Math.max(16, rect.top - 260);
			const fmTitle = typeof fm.values.title === "string" ? fm.values.title : "";
			setHoverCard({
				title: fmTitle || baseName(resolved.path),
				relPath: relativeTo(state.workspace?.root, resolved.path),
				html,
				x,
				y,
			});
		}, 380);
	};

	// --- Right-Click Context Menu --------------------------------------------
	const onContextMenu = async (e: MouseEvent) => {
		const target = e.target instanceof Element ? e.target : null;
		if (target?.closest("input, textarea, .menu-pop")) return;
		e.preventDefault();
		if (!cmView) return;

		const linkEl = target?.closest<HTMLElement>("[data-md-href], [data-md-wiki], [data-md-ticket]") ?? null;
		const main = cmView.state.selection.main;
		const hasSelection = !main.empty;
		const inFolder = Boolean(state.workspace && isInside(state.workspace.root, props.path));

		const OPEN_LINK = "Open link";
		const CUT = "Cut";
		const COPY = "Copy";
		const PASTE = "Paste";
		const SELECT_ALL = "Select all";
		const BOLD = "Bold (Ctrl+B)";
		const ITALIC = "Italic (Ctrl+I)";
		const CODE = "Inline code (Ctrl+`)";
		const STRIKE = "Strikethrough (Ctrl+Shift+X)";
		const HIGHLIGHT = "Highlight (Ctrl+Alt+H)";
		const LINK = "Insert link (Ctrl+K)";
		const CHECKBOX = "Toggle checkbox (Ctrl+L)";
		const ASK_AGENT = "Ask the Agent About This…";
		const TO_READ = "Switch to Read view (Ctrl+E)";
		const TO_SOURCE = "Switch to Source view";
		const SHOW = "Show in the Explorer";

		const items = [
			...(linkEl ? [OPEN_LINK] : []),
			...(hasSelection ? [CUT, COPY] : []),
			PASTE,
			SELECT_ALL,
			BOLD,
			ITALIC,
			CODE,
			STRIKE,
			HIGHLIGHT,
			LINK,
			CHECKBOX,
			ASK_AGENT,
			TO_READ,
			TO_SOURCE,
			...(inFolder ? [SHOW] : []),
		];

		const box = hostEl.getBoundingClientRect();
		const at = e.clientX || e.clientY ? { x: e.clientX, y: e.clientY } : { x: box.left + 24, y: box.top + 24 };
		const picked = await chooseFromMenu(`Actions for ${baseName(props.path)}`, items, at);
		if (!picked || !cmView) return;

		if (picked === OPEN_LINK && linkEl) {
			if (linkEl.dataset.mdWiki) void followWiki(linkEl.dataset.mdWiki);
			else if (linkEl.dataset.mdHref) void followLink(linkEl.dataset.mdHref);
			else if (linkEl.dataset.mdTicket) followTicket(linkEl.dataset.mdTicket);
		} else if (picked === CUT) runCmAction(cmView, "editor.action.clipboardCutAction");
		else if (picked === COPY) runCmAction(cmView, "editor.action.clipboardCopyAction");
		else if (picked === PASTE) runCmAction(cmView, "editor.action.clipboardPasteAction");
		else if (picked === SELECT_ALL) runCmAction(cmView, "editor.action.selectAll");
		else if (picked === BOLD) runCmAction(cmView, "md-bold");
		else if (picked === ITALIC) runCmAction(cmView, "md-italic");
		else if (picked === CODE) runCmAction(cmView, "md-code");
		else if (picked === STRIKE) runCmAction(cmView, "md-strike");
		else if (picked === HIGHLIGHT) runCmAction(cmView, "md-highlight");
		else if (picked === LINK) runCmAction(cmView, "md-link");
		else if (picked === CHECKBOX) runCmAction(cmView, "md-checkbox");
		else if (picked === ASK_AGENT) void import("../commands").then((m) => m.runCommand("agent-ask"));
		else if (picked === TO_READ) setMarkdownMode(props.path, "read");
		else if (picked === TO_SOURCE) setMarkdownMode(props.path, "source");
		else if (picked === SHOW) void import("../panels/Explorer").then((m) => m.showInExplorer(props.path));
	};

	// --- Sync CM6 Transaction -> Monaco ITextModel (CRLF-safe) ---------------
	const pushTransactionToModel = (tr: Transaction) => {
		if (!model || !tr.docChanged || syncingFromModel) return;
		const startDoc = tr.startState.doc;
		const edits: monaco.editor.IIdentifiedSingleEditOperation[] = [];
		tr.changes.iterChanges((fromA, toA, _fromB, _toB, inserted) => {
			const sLine = startDoc.lineAt(fromA);
			const eLine = startDoc.lineAt(toA);
			edits.push({
				range: new monaco.Range(sLine.number, fromA - sLine.from + 1, eLine.number, toA - eLine.from + 1),
				text: inserted.toString(),
				forceMoveMarkers: true,
			});
		});
		if (!edits.length) return;
		syncingFromCm = true;
		try {
			model.pushStackElement();
			model.pushEditOperations([], edits, () => null);
			model.pushStackElement();
			setText(model.getValue());
		} finally {
			syncingFromCm = false;
		}
	};

	const syncCursorState = (view: EditorView, userMoved: boolean) => {
		const head = view.state.selection.main.head;
		const line = view.state.doc.lineAt(head);
		const lineNumber = line.number;
		const column = head - line.from + 1;
		if (state.activeGroup === props.group) {
			setState("cursor", { line: lineNumber, column });
			if (userMoved) noteCursor({ path: props.path, line: lineNumber, column });
		}
	};

	const saveView = () => {
		if (!cmView) return;
		const main = cmView.state.selection.main;
		savedLiveViews.set(`${props.group}:${props.path}`, {
			anchor: main.anchor,
			head: main.head,
			scrollTop: hostEl?.scrollTop ?? 0,
		});
	};

	const applyReveal = () => {
		const r = takeReveal(props.path);
		if (!r) return;
		jumpToLine(r.line, r.column ?? 1, r.endLine, r.endColumn);
	};

	const toggleEditYaml = () => {
		const next = !editYaml();
		setEditYaml(next);
		if (!cmView) return;
		cmView.dispatch({ effects: setEditYamlEffect.of(next) });
		if (next) {
			const fm = front();
			const targetLine = Math.min(cmView.state.doc.lines, fm.lines > 1 ? 2 : 1);
			jumpToLine(targetLine, 1);
		}
	};

	// --- Lifecycle & Bidirectional Binding -----------------------------------
	onMount(() => {
		const initial = (model?.getValue() ?? "").replace(/\r\n/g, "\n");
		const saved = savedLiveViews.get(`${props.group}:${props.path}`);
		const fm = frontMatter(initial);
		const initialLines = initial.split("\n");
		const defaultCursor = fm.lines > 0 && fm.lines < initialLines.length ? (() => {
			let pos = 0;
			let startIdx = fm.lines;
			// Skip leading blank line right after `---` so cursor lands on the first prose/heading line.
			while (startIdx < initialLines.length - 1 && !initialLines[startIdx]!.trim()) startIdx++;
			for (let i = 0; i < startIdx && i < initialLines.length; i++) pos += initialLines[i]!.length + 1;
			return Math.min(pos, initial.length);
		})() : 0;

		const anchor = saved ? Math.min(saved.anchor, initial.length) : defaultCursor;
		const head = saved ? Math.min(saved.head, initial.length) : defaultCursor;

		const editorState = EditorState.create({
			doc: initial,
			selection: EditorSelection.range(anchor, head),
			extensions: [
				history(),
				historyFallbackFacet.of({
					undo: () => {
						if (!model) return false;
						const before = model.getValue();
						model.undo();
						return model.getValue() !== before;
					},
					redo: () => {
						if (!model) return false;
						const before = model.getValue();
						model.redo();
						return model.getValue() !== before;
					},
				}),
				cmSearchTop,
				drawSelection(),
				dropCursor(),
				highlightSpecialChars(),
				EditorView.lineWrapping,
				markdown({ base: markdownLanguage }),
				cmStudioTheme,
				cmMarkdownHighlight,
				editYamlField,
				liveCallbacksFacet.of({
					filePath: () => props.path,
					onFollowLink: (href) => void followLink(href),
					onFollowWiki: (inner) => void followWiki(inner),
					onFollowTicket: followTicket,
					onTagClick: (tag) => searchFor(tag),
					onHoverLink: handleHoverLink,
					onHoverLeave: scheduleHideHover,
					onCopyCode: (code) => {
						void import("../commands").then((m) => m.copyText(code, "Copied code block."));
					},
				}),
				liveBlockField,
				liveInlinePlugin,
				liveInteractionExtension,
				markdownFoldService,
				cmMarkdownCompletion(() => props.path),
				cmAutoWrapExtension,
				cmSmartPasteExtension,
				cmMarkdownKeymap,
				EditorView.domEventHandlers({
					focus: () => {
						setState("activeGroup", props.group);
					},
				}),
				EditorView.updateListener.of((update) => {
					for (const tr of update.transactions) {
						if (tr.docChanged) pushTransactionToModel(tr);
					}
					if (update.selectionSet || update.focusChanged) {
						const userMoved = update.transactions.some((tr) => tr.isUserEvent("select") || tr.isUserEvent("input") || tr.isUserEvent("delete"));
						syncCursorState(update.view, userMoved);
					}
				}),
			],
		});

		cmView = new EditorView({ state: editorState, parent: cmMountEl });

		if (saved && hostEl) {
			queueMicrotask(() => {
				if (hostEl) hostEl.scrollTop = saved.scrollTop;
			});
		}

		// Register handle so MenuBar, commands, StatusBar, Agent, Palette, Reference, and Navigation all work seamlessly.
		const handle: LiveEditorHandle = {
			path: props.path,
			focus: () => cmView?.focus(),
			hasFocus: () => Boolean(cmView?.hasFocus),
			getPosition: () => {
				if (!cmView) return { lineNumber: 1, column: 1 };
				const headPos = cmView.state.selection.main.head;
				const ln = cmView.state.doc.lineAt(headPos);
				return { lineNumber: ln.number, column: headPos - ln.from + 1 };
			},
			getSelection: () => {
				if (!cmView) return { startLineNumber: 1, startColumn: 1, endLineNumber: 1, endColumn: 1, isEmpty: () => true };
				const r = cmView.state.selection.main;
				const s = cmView.state.doc.lineAt(r.from);
				const e = cmView.state.doc.lineAt(r.to);
				return {
					startLineNumber: s.number,
					startColumn: r.from - s.from + 1,
					endLineNumber: e.number,
					endColumn: r.to - e.from + 1,
					isEmpty: () => r.empty,
				};
			},
			getSelectedText: () => {
				if (!cmView) return "";
				const r = cmView.state.selection.main;
				return cmView.state.sliceDoc(r.from, r.to);
			},
			reveal: (range) => jumpToLine(range.line, range.column ?? 1, range.endLine, range.endColumn),
			runAction: (id) => (cmView ? runCmAction(cmView, id) : false),
			openLinkAtCursor: () => {
				if (!cmView) return false;
				const found = linkAtOffset(cmView.state, cmView.state.selection.main.head);
				if (!found) return false;
				if (found.kind === "wiki") void followWiki(found.inner);
				else if (found.kind === "href") void followLink(found.href);
				else followTicket(found.key);
				return true;
			},
			insertText: (str) => {
				if (!cmView) return;
				const r = cmView.state.selection.main;
				cmView.focus();
				cmView.dispatch({
					changes: { from: r.from, to: r.to, insert: str },
					selection: EditorSelection.cursor(r.from + str.length),
					scrollIntoView: true,
					userEvent: "input",
				});
			},
		};
		registerLiveEditor(props.group, handle);

		// Reflect external Monaco model edits (Revert, Status menu, Rename links, Search & Replace) back into CM6.
		const modelSub = model?.onDidChangeContent(() => {
			if (syncingFromCm || !cmView) return;
			const next = model.getValue().replace(/\r\n/g, "\n");
			setText(model.getValue());
			const cur = cmView.state.doc.toString();
			if (next === cur) return;
			syncingFromModel = true;
			try {
				const main = cmView.state.selection.main;
				cmView.dispatch({
					changes: { from: 0, to: cur.length, insert: next },
					selection: EditorSelection.range(Math.min(main.anchor, next.length), Math.min(main.head, next.length)),
				});
			} finally {
				syncingFromModel = false;
			}
		});

		const stopReveal = revealSignal.listen((path) => {
			if (path === props.path) applyReveal();
		});

		syncCursorState(cmView, false);
		applyReveal();
		if (state.activeGroup === props.group && !openedForALook(props.path)) {
			queueMicrotask(() => cmView?.focus());
		}

		onCleanup(() => {
			cancelHover();
			saveView();
			registerLiveEditor(props.group, undefined);
			modelSub?.dispose();
			stopReveal();
			cmView?.destroy();
			cmView = undefined;
		});
	});

	// Refresh Live Preview decorations whenever workspace docs / broken-link status updates.
	createEffect(
		on(
			docs,
			() => {
				if (cmView) cmView.dispatch({ effects: refreshLiveEffect.of(++refreshSeq) });
			},
			{ defer: true },
		),
	);

	// Re-register handle if group index shifts (e.g. closing an earlier split group).
	createEffect(
		on(
			() => props.group,
			() => {
				if (!cmView) return;
				const cur = cmView;
				registerLiveEditor(props.group, {
					path: props.path,
					focus: () => cur.focus(),
					hasFocus: () => cur.hasFocus,
					getPosition: () => {
						const headPos = cur.state.selection.main.head;
						const ln = cur.state.doc.lineAt(headPos);
						return { lineNumber: ln.number, column: headPos - ln.from + 1 };
					},
					getSelection: () => {
						const r = cur.state.selection.main;
						const s = cur.state.doc.lineAt(r.from);
						const e = cur.state.doc.lineAt(r.to);
						return {
							startLineNumber: s.number,
							startColumn: r.from - s.from + 1,
							endLineNumber: e.number,
							endColumn: r.to - e.from + 1,
							isEmpty: () => r.empty,
						};
					},
					getSelectedText: () => {
						const r = cur.state.selection.main;
						return cur.state.sliceDoc(r.from, r.to);
					},
					reveal: (range) => jumpToLine(range.line, range.column ?? 1, range.endLine, range.endColumn),
					runAction: (id) => runCmAction(cur, id),
					openLinkAtCursor: () => {
						const found = linkAtOffset(cur.state, cur.state.selection.main.head);
						if (!found) return false;
						if (found.kind === "wiki") void followWiki(found.inner);
						else if (found.kind === "href") void followLink(found.href);
						else followTicket(found.key);
						return true;
					},
					insertText: (str) => {
						const r = cur.state.selection.main;
						cur.focus();
						cur.dispatch({
							changes: { from: r.from, to: r.to, insert: str },
							selection: EditorSelection.cursor(r.from + str.length),
							scrollIntoView: true,
							userEvent: "input",
						});
					},
				});
			},
			{ defer: true },
		),
	);

	return (
		<div
			ref={hostEl}
			class="cm-md-host"
			aria-label={`${baseName(props.path)}, live preview`}
			onContextMenu={(e) => void onContextMenu(e)}
			onMouseDown={(e) => {
				setState("activeGroup", props.group);
				// Clicking empty page margin below editor puts cursor at the end (Obsidian feel).
				if (e.target === hostEl || e.target === hostEl.firstElementChild) {
					if (!cmView) return;
					const rect = cmMountEl.getBoundingClientRect();
					if (e.clientY > rect.bottom) {
						e.preventDefault();
						cmView.focus();
						cmView.dispatch({ selection: EditorSelection.cursor(cmView.state.doc.length) });
					}
				}
			}}
		>
			<div class="cm-md-page">
				{/* Inline Obsidian Properties card for YAML frontmatter. */}
				<Show when={facts().length > 0}>
					<section class="cm-md-props" aria-label="Document properties">
						<div class="cm-md-props-head">
							<button
								type="button"
								class="cm-md-props-toggle"
								aria-expanded={propsOpen()}
								onClick={() => setPropsOpen((v) => !v)}
							>
								<Icon name={propsOpen() ? "chevron-down" : "chevron-right"} />
								<span>Properties</span>
							</button>
							<button
								type="button"
								class="cm-md-props-edit"
								title={editYaml() ? "Hide raw YAML frontmatter" : "Edit raw YAML frontmatter"}
								onClick={toggleEditYaml}
							>
								{editYaml() ? "Hide YAML" : "Edit YAML"}
							</button>
						</div>
						<Show when={propsOpen()}>
							<dl class="cm-md-props-list">
								<For each={facts()}>
									{(fact) => (
										<div>
											<dt>{fact.key}</dt>
											<dd>
												<For each={fact.values}>
													{(value) => {
														const target = targetOf(fact.key, value);
														return (
															<Show
																when={target.file || target.web}
																fallback={
																	<Show
																		when={fact.key === "status" && listed()}
																		fallback={
																			<span classList={{ "doc-status": fact.key === "status", [`tone-${toneOf(value)}`]: fact.key === "status" }}>
																				{value}
																			</span>
																		}
																	>
																		<Menu
																			class="md-status"
																			label={`Status: ${value}. Change it`}
																			title="Change the status"
																			items={() =>
																				statusChoices(listed()).map((status) => ({
																					label: status,
																					disabled: status.toLowerCase() === value.toLowerCase(),
																					why: "It is this already",
																					run: () => void setStatus(props.path, status),
																				}))
																			}
																		>
																			<span class={`doc-status tone-${toneOf(value)}`}>{value}</span>
																			<Icon name="chevron-down" />
																		</Menu>
																	</Show>
																}
															>
																<button class="link" title={target.web ?? target.file} onClick={() => go(target)}>
																	{value}
																</button>
															</Show>
														);
													}}
												</For>
											</dd>
										</div>
									)}
								</For>
							</dl>
						</Show>
					</section>
				</Show>

				{/* Ticket work summary (specs, plans, registries, decisions, questions tied to this ticket). */}
				<Show when={work().length > 0}>
					<section class="md-work" aria-label={`The work for ${ticket()}`}>
						<h2>The work for {ticket()}</h2>
						<For each={work()}>
							{(group) => (
								<div class="md-work-group">
									<h3>{group.name}</h3>
									<ul>
										<For each={group.files}>
											{(file) => (
												<li>
													<button
														class="link"
														title={[file.path, group.kind === "registry" ? `Opens the table at the rows for ${ticket()}.` : ""].filter(Boolean).join("\n")}
														onClick={() => {
															if (group.kind === "registry") askRows(file.path, ticket());
															void openFile(file.path);
														}}
													>
														{file.ticket && !file.title?.startsWith(file.ticket) ? `${file.ticket}: ` : ""}
														{group.kind === "registry" ? registryTitle(file.name) : file.title || file.name.replace(/\.plan\.json$/i, "")}
													</button>
													<Show when={group.kind === "registry" && file.forTickets?.find((rows) => rows.key.toLowerCase() === ticket().toLowerCase())}>
														{(rows) => <span class="md-work-note">{rowsLine(rows())}</span>}
													</Show>
													<Show when={file.status}>
														<span class={`doc-status tone-${toneOf(file.status)}`}>{file.status}</span>
													</Show>
												</li>
											)}
										</For>
									</ul>
								</div>
							)}
						</For>
					</section>
				</Show>

				{/* Live CodeMirror 6 surface. */}
				<div ref={cmMountEl} class="cm-md-editor-wrap" />

				{/* Collapsible Backlinks footer ("Linked from"). */}
				<Show when={(linked()?.length ?? 0) > 0}>
					<section class="cm-md-backlinks" aria-label="Linked from">
						<button
							type="button"
							class="cm-md-backlinks-toggle"
							aria-expanded={backlinksOpen()}
							onClick={() => setBacklinksOpen((v) => !v)}
						>
							<Icon name={backlinksOpen() ? "chevron-down" : "chevron-right"} />
							<span>Linked from ({linked()!.length})</span>
						</button>
						<Show when={backlinksOpen()}>
							<ul>
								<For each={linked()}>
									{(from) => (
										<li>
											<button
												class="link"
												title={relativeTo(state.workspace?.root, from.path)}
												onClick={() => void openFile(from.path, { reveal: { line: from.line } })}
											>
												{called(from.path)}
											</button>
											<Show when={from.places > 1}>
												<span class="md-work-note">{from.places} places</span>
											</Show>
										</li>
									)}
								</For>
							</ul>
						</Show>
					</section>
				</Show>
			</div>

			{/* Obsidian-style Hover Page Preview popover. */}
			<Show when={hoverCard()}>
				{(card) => (
					<div
						class="md-hover-card"
						style={{ left: `${card().x}px`, top: `${card().y}px` }}
						onMouseEnter={() => {
							cardHovered = true;
							clearTimeout(hideTimer);
						}}
						onMouseLeave={() => {
							cardHovered = false;
							scheduleHideHover();
						}}
					>
						<div class="md-hover-head">
							<span class="md-hover-title">{card().title}</span>
							<span class="md-hover-path">{card().relPath}</span>
						</div>
						<div class="md-hover-body md" innerHTML={card().html} />
					</div>
				)}
			</Show>
		</div>
	);
}
