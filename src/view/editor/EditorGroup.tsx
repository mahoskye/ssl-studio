// One editor group: a tab strip over one Monaco editor that shows the
// group's active document. Two groups side by side make a split.
import { DEFAULT_CODE_FONT, resolveFontStack } from "../../shared/fonts";
import { canFormatNonSsl, SQL_DIALECTS, sqlDialectInfo } from "../../shared/format";
import { createMiddleCloseTracker } from "../../shared/middleClickGuard";
import { continueLists } from "./markdownKeys";
import { liveEditorAt } from "./liveBridge";
import { MarkdownLiveEditor } from "./MarkdownLiveEditor";
import { Icon } from "../Icon";
import { tabShown } from "../recentTabs";
import { createEffect, createMemo, createResource, createSignal, For, onCleanup, onMount, Show } from "solid-js";
import { monaco } from "./monaco";
import { activePath, closeAllTabs, closeOtherTabs, closeTab, closeTabsToRight, displayName, documents, focusRequest, isUntitled, keepTab, markdownMode, moveTab, newUntitled, notify, openFile, openToSide, planMode, revealSignal, revert, save, saveAll, saveSetting, setMarkdownMode, setPlanMode, setState, setTableTextMode, split, state, tabLeaving, tableTextMode, takeReveal, togglePin, openedForALook } from "../state";
import { landsBefore } from "../../shared/tabOrder";
import { othersOf, rightOf } from "../../shared/tabOrder";
import { chooseFromMenu } from "../panels/RowMenu";
import type { Point } from "../panels/Rows";
import { symbols } from "../panels/Objects";
import { flatRegions, regionColor, symbolPath } from "./regions";
import { BlocksView } from "../blocks/BlocksView";
import { isPlanPath } from "../plan/model";
import { PlanView } from "../plan/PlanView";
import { dirName, isInside, relativeTo } from "../../shared/paths";
import { tabLabels } from "./tabs";
import { Menu, type MenuItem } from "../Menu";
import { backend } from "../backend";
import { docs, isMarkdown, isTable } from "../project";
import { registryTitle } from "../../shared/projectDocs";
import { docsGoverningFile, ticketForFile } from "../../shared/workContext";
import { TableView } from "./TableView";
import { FileView } from "./FileView";
import { useGitMarks } from "./gitMarks";
import { Start } from "../Start";
import { FileMark } from "../FileMark";
import { size as scriptSize } from "../StatusBar";
import { getPath, SERVER_DEFAULTS } from "../../shared/styleProfile";
import { level, RULER_MARGIN, rulerColumns } from "../../shared/houseStyle";
import { noteCursor } from "../navigation";

/**
 * Where the cursor and the scroll were in each file a group showed, by the group's place in the row and the file's
 * path. By place, since the groups are made again each time a review or a comparison closes, and are the same
 * groups to the user.
 */
const viewStates = new Map<string, monaco.editor.ICodeEditorViewState | null>();
/** The same by the file alone, as it was last left in any group: what a tab moved to another group opens with. */
const lastViews = new Map<string, monaco.editor.ICodeEditorViewState | null>();
/** The editor width, in pixels, from which the minimap is shown: under it, code at the line length would run beneath the map. */
const MINIMAP_FROM = 640;
export const editors: monaco.editor.IStandaloneCodeEditor[] = [];
/** The tab being dragged, and the group it is in. One at a time, whichever group it is over. */
let dragged: { path: string; group: number } | null = null;
/** Where it would land: in which group, and before which tab (last, with null). */
const [dropAt, setDropAt] = createSignal<{ group: number; before: string | null } | null>(null);
/** Most recently active Markdown tab path (used by code-citation commands to compute relative paths cleanly). */
const [lastMarkdownPath, setLastMarkdownPath] = createSignal<string | null>(null);
export const lastActiveMarkdownPath = () => lastMarkdownPath();

const base = displayName;

export function EditorGroup(props: { index: number }) {
	let host!: HTMLDivElement;
	let editor: monaco.editor.IStandaloneCodeEditor;
	const group = () => state.groups[props.index]!;
	let shown: string | null = null;
	const [lineCount, setLineCount] = createSignal(0);
	// A picture, or other bytes: shown for what it is, never as text, and never as what its name would make it.
	const showFile = () => Boolean(state.kindVersion >= 0 && group().active && documents.get(group().active!)?.binary);
	const isPlan = () => isPlanPath(group().active) && !showFile();
	const planViewMode = () => (group().active && isPlan() ? planMode(group().active!, props.index) : "chart");
	const showChart = () => isPlan() && planViewMode() !== "source";
	const isSsl = () => Boolean(group().active && documents.get(group().active!)?.model.getLanguageId() === "ssl");
	const activeLang = () => (group().active ? documents.get(group().active!)?.model.getLanguageId() : undefined);
	const isSql = () => activeLang() === "sql" && !showFile();
	const canFormat = () => {
		const path = group().active;
		const lang = activeLang();
		if (!path || !lang || showFile() || isPlan()) return false;
		return lang === "ssl" || canFormatNonSsl(lang, path);
	};
	const formatDisabled = () => activeLang() === "ssl" && state.lsp.state !== "running";
	const sqlDialect = () => sqlDialectInfo(state.settings.sqlDialect);
	const pickSqlDialect = async (e: MouseEvent) => {
		const box = (e.currentTarget as HTMLElement).getBoundingClientRect();
		const labels = SQL_DIALECTS.map((d) => d.label);
		const picked = await chooseFromMenu("SQL formatting dialect", labels, { x: box.left, y: box.bottom + 4 });
		if (!picked) return;
		const found = SQL_DIALECTS.find((d) => d.label === picked);
		if (!found || found.id === sqlDialect().id) return;
		await saveSetting({ sqlDialect: found.id });
		notify(`SQL formatting dialect set to ${found.label}.`);
	};
	const runFormat = () => {
		setState("activeGroup", props.index);
		void import("../commands").then((all) => all.runCommand("format"));
	};
	// Blocks are a view of SSL only. The group remembers the choice, so the next
	// script opens as blocks again, but a Markdown or SQL file never does.
	const showBlocks = () => group().mode === "blocks" && isSsl() && !isPlan() && !showFile();
	const isDoc = () => isMarkdown(group().active) && !showFile();
	const mdViewMode = () => (group().active && isDoc() ? markdownMode(group().active!, props.index) : "read");
	const showRendered = () => isDoc() && mdViewMode() === "read";
	/** Obsidian-grade CodeMirror 6 Live Preview when the Markdown file is in Live mode. */
	const showLive = () => isDoc() && mdViewMode() === "live";
	// A table of values opens as a table, with the same switch to its text as a document has.
	const isTabular = () => isTable(group().active) && !showFile();
	const showTable = () => isTabular() && !tableTextMode(group().active!, props.index);

	// Horizontal tab-strip overflow detection + wheel scrolling (C9).
	let tabsHost: HTMLDivElement | undefined;
	const [canScrollLeft, setCanScrollLeft] = createSignal(false);
	const [canScrollRight, setCanScrollRight] = createSignal(false);
	const updateTabOverflow = () => {
		const el = tabsHost;
		if (!el) return (setCanScrollLeft(false), setCanScrollRight(false));
		setCanScrollLeft(el.scrollLeft > 2);
		setCanScrollRight(el.scrollLeft + el.clientWidth < el.scrollWidth - 2);
	};
	const scrollTabsBy = (delta: number) => {
		if (!tabsHost) return;
		tabsHost.scrollBy({ left: delta, behavior: "smooth" });
		setTimeout(updateTabOverflow, 180);
	};
	const bindTabsHost = (el: HTMLDivElement) => {
		tabsHost = el;
		const ro = typeof ResizeObserver !== "undefined" ? new ResizeObserver(() => updateTabOverflow()) : null;
		ro?.observe(el);
		queueMicrotask(updateTabOverflow);
		onCleanup(() => {
			ro?.disconnect();
			if (tabsHost === el) tabsHost = undefined;
		});
	};
	createEffect(() => {
		// Re-check overflow & keep the active tab scrolled into view whenever tabs or selection change.
		const active = group().active;
		void group().tabs.length;
		queueMicrotask(() => {
			if (active) tabs.get(active)?.scrollIntoView({ inline: "nearest", block: "nearest" });
			updateTabOverflow();
		});
	});

	/** The ruler at the style's line length, and the fainter ones the chosen number of columns to each side of it. */
	const rulers = () =>
		rulerColumns(state.settings.rulers !== false, Number(getPath(state.settings.ssl, "format.maxLineLength") ?? SERVER_DEFAULTS.format.maxLineLength), state.settings.rulerMargin ?? RULER_MARGIN).map((ruler) => ({
			column: ruler.column,
			// Barely there: a ruler is for the eye to find when it looks, not to see all the time.
			color: ruler.main ? "color-mix(in srgb, var(--fg) 13%, transparent)" : "color-mix(in srgb, var(--fg) 6%, transparent)",
		}));

	// A narrow editor has no room to give: the map would lie over the code it is a map of.
	const [roomy, setRoomy] = createSignal(true);
	const minimap = () => state.settings.minimap && roomy();
	// Scroll-collapsing Folio header state with hysteresis (ADR 0027): >22px compacts, <6px expands.
	const [scrolled, setScrolled] = createSignal(false);
	const [shortWindow, setShortWindow] = createSignal(window.innerHeight <= 760);
	const onWinResize = () => setShortWindow(window.innerHeight <= 760);
	window.addEventListener("resize", onWinResize);
	onCleanup(() => window.removeEventListener("resize", onWinResize));
	const folioCompact = () => scrolled() || shortWindow() || state.groups.length > 1 || showBlocks();
	const folioFolder = () => {
		const path = group().active;
		if (!path || isUntitled(path)) return "";
		const rel = relativeTo(state.workspace?.root, dirName(path));
		return rel === "." ? "" : rel;
	};
	const folioCrumbs = () => (group().active && group().active === activePath() && symbols().length ? symbolPath(symbols(), state.cursor.line) : []);
	const folioAlert = (): { kind: "near" | "over"; text: string } | null => {
		const path = group().active;
		if (!path) return null;
		if (state.conflicts[path]) return { kind: "over", text: "Changed on disk" };
		if (path !== activePath() || !isSsl()) return null;
		const s = scriptSize();
		if (!s) return null;
		const limits = state.settings.limits;
		const levels = [level(s.bytes, limits.bytes), level(s.codeLines, limits.codeLines), level(s.historyEntries, limits.historyEntries, 1)];
		if (levels.includes("over")) return { kind: "over", text: "Over size limit" };
		if (levels.includes("near")) return { kind: "near", text: "Near size limit" };
		return null;
	};

	onMount(() => {
		editor = monaco.editor.create(host, {
			model: null,
			theme: "studio",
			automaticLayout: true,
			fontSize: state.settings.fontSize,
			minimap: { enabled: minimap() },
			wordWrap: state.settings.wordWrap ? "on" : "off",
			renderWhitespace: "selection",
			"semanticHighlighting.enabled": true,
			inlayHints: { enabled: state.settings.inlayHints === false ? "off" : "on" },
			fixedOverflowWidgets: true,
			// The last lines can be brought up to the top of the view, to be read there and not at the window's foot.
			scrollBeyondLastLine: true,
			rulers: rulers(),
			// A document drawn as it is written has headings larger than its text and code in another face: the editor
			// is told that a line may be taller than its neighbours, and a stretch of it in another size or face.
			allowVariableLineHeights: true,
			allowVariableFonts: true,
			allowVariableFontsInAccessibilityMode: true,
			// Prevent Linux X11 middle-click primary-selection paste into code/docs.
			selectionClipboard: false,
		});
		// The editor is filed under the group's place in the row, and filed again when that place changes (the group
		// before it closed): "the active editor" is looked up by place.
		createEffect(() => {
			const at = props.index;
			editors[at] = editor;
			onCleanup(() => editors[at] === editor && delete editors[at]);
		});
		// The app's own commands for the code at hand, on the editor's right-click menu beside the editor's own.
		for (const [order, [id, label]] of (
			[
				["agent-ask", "Ask the Agent About This…"],
				["open-schema-at-cursor", "Open Schema Doc for Table at Cursor"],
				["find-in-docs", "Find References in Docs"],
				["copy-code-citation", "Copy Markdown Code Citation"],
				["copy-code-citation-excerpt", "Copy Markdown Code Citation + Excerpt"],
				["add-selection-to-registry", "Add Selection to Registry…"],
				["new-question", "New Question About This Code…"],
				["new-decision", "New Decision About This Code…"],
				["copy-designer", "Copy for Designer"],
				["wrap-region", "Wrap in Region…"],
			] as const
		).entries()) {
			editor.addAction({ id: `app.${id}`, label, contextMenuGroupId: "9_app", contextMenuOrder: order, run: () => void import("../commands").then((all) => all.runCommand(id)) });
		}
		useGitMarks(editor, () => group().active);
		// The editor keeps Ctrl+F12 for "Go to definition" to where it is told it is in a web view, where F12 alone
		// may be the browser's. It was never told, so the key the Go menu shows (the last the editor lists) did
		// nothing. Told here: Ctrl+F12 goes to the definition, and F12 goes on doing so where the window has it.
		editor.createContextKey("isWeb", true);
		// The code's own face, read before any custom font overrides.
		codeFont = editor.getOption(monaco.editor.EditorOption.fontFamily);
		const listKeys = continueLists(editor);
		onCleanup(() => listKeys.dispose());
		setRoomy(editor.getLayoutInfo().width >= MINIMAP_FROM);
		editor.onDidLayoutChange((layout) => setRoomy(layout.width >= MINIMAP_FROM));
		editor.onDidFocusEditorText(() => setState("activeGroup", props.index));
		editor.onDidScrollChange((e) => {
			if (!e.scrollTopChanged) return;
			if (e.scrollTop > 22 && !scrolled()) setScrolled(true);
			else if (e.scrollTop < 6 && scrolled()) setScrolled(false);
		});
		editor.onDidChangeModelContent(() => setLineCount(editor.getModel()?.getLineCount() ?? 0));
		editor.onDidChangeModel(() => {
			setLineCount(editor.getModel()?.getLineCount() ?? 0);
			setScrolled(editor.getScrollTop() > 22);
			// A file taken up with the cursor where the editor already had it moves no cursor: without this the status bar
			// would go on saying the last file's line.
			const at = editor.getPosition();
			if (at && state.activeGroup === props.index) setState("cursor", { line: at.lineNumber, column: at.column });
		});
		editor.onDidChangeCursorPosition((e) => {
			if (state.activeGroup !== props.index) return;
			setState("cursor", { line: e.position.lineNumber, column: e.position.column });
			// Where the cursor comes to rest is somewhere to go back to. Not where the editor puts it as it takes a file
			// up or puts it back as it was: the file coming to the front says that, once it is where it was asked to be.
			if (shown && e.source !== "model" && e.source !== "restoreState") noteCursor({ path: shown, line: e.position.lineNumber, column: e.position.column });
		});
		const stop = revealSignal.listen((path) => {
			if (path === group().active && shown === path && !showLive() && !showRendered()) reveal(path);
		});
		// "Focus editor": the text editor, or whichever view of the file is showing in its place.
		const stopFocus = focusRequest.listen((target) => {
			if (target !== "editor" || state.activeGroup !== props.index) return;
			if (showLive()) return void liveEditorAt(props.index)?.focus();
			if (!showBlocks() && !showChart() && !showRendered() && !showTable() && !showFile()) return editor.focus();
			section.querySelector<HTMLElement>(".blocks-scroll, .plan [tabindex], .cm-md-host, .md-view, .table-view td.cell-selected, .table-view, .file-view")?.focus();
		});
		onCleanup(() => {
			stop();
			stopFocus();
			if (shown) keepView(shown);
			editor.dispose();
		});
	});

	/** Keeps where the cursor and the scroll are in the file that is showing, before it stops showing. */
	function keepView(path: string) {
		const view = editor.saveViewState();
		viewStates.set(`${props.index}:${path}`, view);
		lastViews.set(path, view);
	}
	// A tab about to leave for another group: where it was is kept now, since the group it goes to may ask first.
	const leaving = (index: number, path: string) => index === props.index && path === shown && editor && keepView(path);
	tabLeaving.add(leaving);
	onCleanup(() => tabLeaving.delete(leaving));

	function reveal(path: string) {
		const r = takeReveal(path);
		if (!r) return;
		const model = editor.getModel();
		const endLine = r.endLine ?? r.line;
		const endCol =
			r.endColumn ??
			(r.endLine && r.endLine > r.line && model
				? model.getLineMaxColumn(Math.min(endLine, model.getLineCount()))
				: r.column ?? 1);
		const range = new monaco.Range(r.line, r.column ?? 1, endLine, endCol);
		editor.setSelection(range);
		editor.revealRangeInCenterIfOutsideViewport(range, monaco.editor.ScrollType.Immediate);
		editor.focus();
	}

	/** The code's own font, as the editor had it when it was made. */
	let codeFont = "";
	/**
	 * The file that is showing, and how the Monaco editor is configured for it (all code files
	 * plus Markdown in raw Source mode; Markdown Live Preview renders in CodeMirror 6).
	 */
	createEffect(() => {
		const path = group().active;
		const inLive = showLive();
		const activeCodeFont = state.settings.codeFont?.trim() ? resolveFontStack(state.settings.codeFont, DEFAULT_CODE_FONT) : codeFont || undefined;
		const options: monaco.editor.IEditorOptions & monaco.editor.IGlobalEditorOptions = {
			fontSize: state.settings.fontSize,
			fontFamily: activeCodeFont,
			minimap: { enabled: minimap() },
			wordWrap: state.settings.wordWrap ? "on" : "off",
			inlayHints: { enabled: state.settings.inlayHints === false ? "off" : "on" },
			rulers: rulers(),
			lineNumbers: "on",
			lineDecorationsWidth: 10,
			renderLineHighlight: "line",
			guides: { indentation: true },
			wordBasedSuggestions: "matchingDocuments",
			stickyScroll: { enabled: true },
			wrappingStrategy: "simple",
			padding: { top: 0, bottom: 0 },
			selectionClipboard: false,
		};
		if (!editor) return;
		if (path === shown) {
			editor.updateOptions(options);
			return;
		}
		if (shown) keepView(shown);
		const doc = path ? documents.get(path) : undefined;
		editor.setModel(null);
		editor.updateOptions(options);
		editor.setModel(doc?.model ?? null);
		shown = doc ? path : null;
		if (doc) {
			const view = viewStates.get(`${props.index}:${path}`) ?? lastViews.get(path!);
			if (view) editor.restoreViewState(view);
			if (!inLive) reveal(path!);
			if (state.activeGroup === props.index && !openedForALook(path!) && !inLive && !showRendered()) editor.focus();
		}
	});

	// The order tabs were used in: what Ctrl+Tab goes back through. Also track the most recent Markdown tab.
	createEffect(() => {
		const path = group().active;
		if (path) {
			tabShown(props.index, path);
			if (isMarkdown(path)) setLastMarkdownPath(path);
		}
	});

	// The active tab is always in view, however many are open.
	const tabs = new Map<string, HTMLElement>();
	/** Closes tabs on middle-button release (`auxclick`/macrotask fallback) instead of mousedown so Linux primary-selection paste cannot leak into the revealed editor. */
	const middleClose = createMiddleCloseTracker();
	onCleanup(() => middleClose.dispose());
	createEffect(() => {
		const path = group().active;
		// Where it stands in the row matters too: a tab that is pinned moves to the front.
		const at = path ? group().tabs.indexOf(path) : -1;
		if (path && at >= 0) queueMicrotask(() => tabs.get(path)?.scrollIntoView({ block: "nearest", inline: "nearest" }));
	});
	const labels = () => tabLabels(group().tabs, state.workspace?.root);
	const activate = (path: string, focus = false) => {
		setState("groups", props.index, "active", path);
		if (focus) queueMicrotask(() => tabs.get(path)?.focus());
	};
	/** Left and Right walk the tabs, as in any tab strip; Delete closes one. */
	const onTabKey = (e: KeyboardEvent, path: string) => {
		const list = group().tabs;
		const at = list.indexOf(path);
		const to = ({ ArrowLeft: at - 1, ArrowRight: at + 1, Home: 0, End: list.length - 1 } as Record<string, number>)[e.key];
		if (to !== undefined) {
			e.preventDefault();
			activate(list[(to + list.length) % list.length]!, true);
		} else if (e.key === "Enter" || e.key === " ") {
			e.preventDefault();
			// Enter on a tab opened for a look keeps it, as a double click does.
			keepTab(path, props.index);
			activate(path);
			if (showLive()) liveEditorAt(props.index)?.focus();
			else editor.focus();
		} else if (e.key === "Delete") {
			e.preventDefault();
			void closeTab(path, props.index);
		} else if (e.key === "ContextMenu" || (e.key === "F10" && e.shiftKey)) {
			// The menu key, or Shift+F10: the tab's menu, under the tab.
			e.preventDefault();
			const box = (e.currentTarget as HTMLElement).getBoundingClientRect();
			void tabMenu(path, { x: box.left + 8, y: box.bottom });
		}
	};
	/** A tab's own menu: what a right-click on it offers. */
	const tabMenu = async (path: string, at: Point) => {
		const pinned = () => Boolean(group().pinned?.includes(path));
		const g = group();
		const CLOSE = "Close";
		const OTHERS = "Close others";
		const RIGHT = "Close to the right";
		const ALL = "Close all";
		const PIN = pinned() ? "Unpin" : "Pin";
		const KEEP = "Keep open";
		const PATH = "Copy path";
		const RELATIVE = "Copy path in the project";
		const NAME = "Copy file name";
		const SHOW = "Show in the Explorer";
		const SIDE = "Open to the side";
		const SIDE_READ = isMarkdown(path) ? "Open Read preview to the side" : "";
		const untitled = isUntitled(path);
		const inFolder = !untitled && Boolean(state.workspace && isInside(state.workspace.root, path));
		// Only what would do something: a tab with nothing to its right has no "close to the right".
		const items = [
			// A tab opened for a look: the way to keep it that needs no pointer.
			...(g.preview === path ? [KEEP] : []),
			...(pinned() ? [] : [CLOSE]),
			...(othersOf(g.tabs, g.pinned ?? [], path).length ? [OTHERS] : []),
			...(rightOf(g.tabs, g.pinned ?? [], path).length ? [RIGHT] : []),
			ALL,
			PIN,
			...(untitled ? [] : [PATH]),
			...(inFolder ? [RELATIVE] : []),
			NAME,
			...(inFolder ? [SHOW] : []),
			SIDE,
			...(SIDE_READ ? [SIDE_READ] : []),
		];
		const picked = await chooseFromMenu(`Actions for the tab ${base(path)}`, items, at);
		if (picked === CLOSE) await closeTab(path, props.index);
		else if (picked === KEEP) keepTab(path, props.index);
		else if (picked === OTHERS) await closeOtherTabs(path, props.index);
		else if (picked === RIGHT) await closeTabsToRight(path, props.index);
		// This row's tabs, as its neighbours in the menu are: the command "Close all tabs" closes every group's.
		else if (picked === ALL) await closeAllTabs(props.index);
		else if (picked === PIN) togglePin(path, props.index);
		else if (picked === PATH || picked === RELATIVE || picked === NAME) await (await import("../commands")).copyPath(picked === PATH ? "whole" : picked === NAME ? "name" : "relative", path);
		else if (picked === SHOW) (await import("../panels/Explorer")).showInExplorer(path);
		else if (picked === SIDE) {
			// This group is the one at hand, even when the keyboard came to its tabs without a click.
			setState("activeGroup", props.index);
			activate(path);
			split();
		} else if (picked === SIDE_READ) {
			const otherGroup = props.index === 0 ? 1 : 0;
			setState("activeGroup", props.index);
			activate(path);
			await openToSide(path);
			setMarkdownMode(path, "read", otherGroup);
		}
		// The tab the menu was opened on may be gone, and the keyboard with it: it goes to what is showing now.
		if (picked === CLOSE || picked === OTHERS || picked === RIGHT || picked === ALL) queueMicrotask(() => (!document.activeElement || document.activeElement === document.body) && focusRequest.fire("editor"));
	};
	const onStripKey = (e: KeyboardEvent) => {
		if (e.key !== "ArrowUp" && e.key !== "ArrowDown") return;
		e.preventDefault();
		const bands = [...(e.currentTarget as HTMLElement).querySelectorAll<HTMLElement>(".region-band")];
		bands[(bands.indexOf(document.activeElement as HTMLElement) + (e.key === "ArrowDown" ? 1 : -1) + bands.length) % bands.length]?.focus();
	};
	let section!: HTMLElement;
	/** Where the dragged tab would land in this group if it were let go over `before`. */
	const markDrop = (index: number, before: string | null) => {
		if (!dragged) return;
		const g = state.groups[index]!;
		const lands = landsBefore(g.tabs, g.pinned ?? [], dragged.path, before);
		// Let go where it already stands, it would not move: no mark.
		const stays = dragged.group === index && lands === (g.tabs[g.tabs.indexOf(dragged.path) + 1] ?? null);
		setDropAt(stays ? null : { group: index, before: lands });
	};
	const drop = (e: DragEvent) => {
		const tab = dragged;
		if (!tab) return;
		e.preventDefault();
		e.stopPropagation();
		const at = dropAt();
		dragged = null;
		setDropAt(null);
		if (at) moveTab(tab.path, tab.group, at.group, at.before);
	};
	/**
	 * What can be done with the file in front: until now these were only in the
	 * command palette. The commands are loaded when the menu opens, because
	 * commands.ts imports this file.
	 */
	const fileActions = async (): Promise<MenuItem[]> => {
		const { commands, keysFor } = await import("../commands");
		const path = group().active;
		const none = "Open a file first";
		const command = (id: string, label: string): MenuItem => {
			const found = commands.find((c) => c.id === id);
			return { label, keys: keysFor(id) || undefined, run: () => found?.run(), disabled: !found || !path, why: found ? none : "Not available" };
		};
		const untitled = isUntitled(path);
		return [
			{ label: "Save", keys: keysFor("save") || undefined, run: () => void save(path), disabled: !path || (!state.dirty[path] && !untitled), why: path ? "Nothing to save" : none },
			{ label: "Save all", keys: keysFor("save-all") || undefined, run: () => void saveAll(), disabled: !Object.values(state.dirty).some(Boolean), why: "Nothing to save" },
			{ label: "Revert to the file on disk", run: () => path && void revert(path), disabled: !path || untitled || !state.dirty[path], why: !path ? none : untitled ? "Not saved on disk yet" : "No unsaved changes" },
			"separator",
			command("format", "Format document"),
			command("copy-designer", "Copy for Designer"),
			command("wrap-region", "Wrap the selected lines in a region…"),
			command("tidy", "Tidy this file with the agent"),
			"separator",
			{ label: "Split editor", keys: keysFor("split") || undefined, run: split, disabled: !path, why: none },
			{ label: "Close other tabs", run: () => void closeOtherTabs(), disabled: group().tabs.length < 2, why: "No other tabs" },
			{ label: "Close all tabs", run: () => void closeAllTabs(props.index), disabled: !group().tabs.length, why: "No tabs" },
		];
	};

	// Reverse Code -> Docs ("Governed by"): unified lookup combining plans, specs, tickets, decisions,
	// questions, schema docs (`source:`), CSV registries (`files.csv`, `settings.csv`, `database.csv`),
	// and incoming Markdown links. Uses a fingerprint of `docs()` so unrelated code saves don't spam `linksTo`.
	const docsFingerprint = createMemo(() => {
		const list = docs()
			.filter((d) => d.exists)
			.map(
				(d) =>
					`${d.path}|${d.source ?? ""}|${(d.codeRefs ?? []).join(",")}|${(d.tickets ?? []).join(",")}|${(d.specs ?? []).join(",")}|${(d.plans ?? []).join(",")}`,
			)
			.join("\0");
		return `${state.treeVersion}:${list}`;
	});
	const isGovernableFile = () => {
		const p = group().active;
		return Boolean(p && !isUntitled(p) && !isMarkdown(p) && !isTable(p) && !isPlanPath(p) && state.workspace?.root);
	};
	const [governingLinks] = createResource(
		() => {
			if (!isGovernableFile()) return null;
			return { path: group().active!, fp: docsFingerprint() };
		},
		({ path }) => backend.linksTo(path).catch(() => []),
	);
	const governingDocs = createMemo(() => {
		const p = group().active;
		if (!isGovernableFile() || !p) return [];
		const list = docsGoverningFile(docs(), p, state.workspace?.root, governingLinks() ?? []);
		return list.map(({ file: d, reason, line }) => {
			const label =
				d.group === "registries"
					? registryTitle(d.name)
					: d.ticket && d.title && !d.title.startsWith(d.ticket)
						? `${d.ticket}: ${d.title}`
						: d.title || d.heading || d.name;
			const kind = d.group === "knowledge" && d.kind ? d.kind : d.group;
			return { path: d.path, line, label, kind, reason };
		});
	});
	const governingMenu = (): MenuItem[] => {
		const list = governingDocs();
		const items: MenuItem[] = list.map((g) => ({
			label: `${g.label} (${g.kind} · ${g.reason})`,
			run: () => void openFile(g.path, g.line ? { reveal: { line: g.line } } : {}),
		}));
		if (items.length) items.push("separator");
		const codePath = group().active ?? undefined;
		const codeLine = editor?.getPosition()?.lineNumber;
		const govTicket =
			(codePath ? ticketForFile(docs(), codePath, state.workspace?.root, governingLinks() ?? []) : undefined) ??
			state.settings.activeTicket?.trim() ??
			undefined;
		const citeOpts = { ticket: govTicket, codePath, codeLine, allowEmptySelection: true };
		items.push(
			{ label: "New decision about this code…", run: () => void import("../projectDocs").then((m) => m.newKnowledge("decisions", citeOpts)) },
			{ label: "New question about this code…", run: () => void import("../projectDocs").then((m) => m.newKnowledge("questions", citeOpts)) },
		);
		return items;
	};

	return (
		<section
			ref={section}
			class="group"
			classList={{
				active: state.activeGroup === props.index,
				empty: !group().active,
				"first-tab-active": Boolean(group().tabs.length && group().tabs[0] === group().active),
			}}
			onMouseDown={() => setState("activeGroup", props.index)}
		>
			<Show when={group().tabs.length > 0}>
				<div class="tabs-row">
					<Show when={canScrollLeft() || canScrollRight()}>
						<button
							class="tabs-scroll-btn"
							disabled={!canScrollLeft()}
							title="Scroll tabs left"
							aria-label="Scroll tabs left"
							onClick={() => scrollTabsBy(-180)}
						>
							<Icon name="chevron-left" />
						</button>
					</Show>
					<div class="tabs-scroll-wrap" classList={{ "can-left": canScrollLeft(), "can-right": canScrollRight() }}>
						<div
							ref={bindTabsHost}
							class="tabs"
							role="tablist"
							aria-label="Open files"
							classList={{ "drop-end": dropAt()?.group === props.index && dropAt()?.before === null }}
							title="Double-click empty space to open a new untitled file"
							onScroll={updateTabOverflow}
							onWheel={(e) => {
								if (!tabsHost || tabsHost.scrollWidth <= tabsHost.clientWidth) return;
								if (Math.abs(e.deltaY) >= Math.abs(e.deltaX)) {
									e.preventDefault();
									tabsHost.scrollLeft += e.deltaY;
									updateTabOverflow();
								}
							}}
							onDblClick={(e) => {
								if (e.target === e.currentTarget) void newUntitled(props.index);
							}}
							// Past the last tab: the dragged one would stand last.
							onDragOver={(e) => dragged && (e.preventDefault(), markDrop(props.index, null))}
							onDragLeave={(e) => !e.currentTarget.contains(e.relatedTarget as Node | null) && setDropAt(null)}
							onDrop={drop}
						>
					<For each={group().tabs}>
						{(path) => (
							<div
								class="tab"
								role="tab"
								draggable={true}
								onDragStart={(e) => {
									dragged = { path, group: props.index };
									// The tab's own kind of thing: dropped on the text, or outside the app, it is nothing.
									e.dataTransfer?.setData("application/x-ssl-studio-tab", path);
									if (e.dataTransfer) e.dataTransfer.effectAllowed = "move";
								}}
								onDragEnd={() => {
									dragged = null;
									setDropAt(null);
								}}
								onDragOver={(e) => {
									if (!dragged) return;
									e.preventDefault();
									e.stopPropagation();
									// Over a tab's first half it would stand before that tab, over its second half after it.
									const box = e.currentTarget.getBoundingClientRect();
									const row = group().tabs;
									markDrop(props.index, e.clientX > box.left + box.width / 2 ? (row[row.indexOf(path) + 1] ?? null) : path);
								}}
								ref={(el) => (tabs.set(path, el), onCleanup(() => tabs.delete(path)))}
								title={`${isUntitled(path) ? `${base(path)} (unsaved buffer)` : path}${state.conflicts[path] ? "\nChanged on disk since you opened it" : state.dirty[path] ? "\nUnsaved changes" : ""}${group().preview === path ? "\nOpened for a look: the next file clicked takes this tab. Double-click the tab, or press Enter on it, to keep it." : ""}`}
								tabindex={group().active === path ? 0 : -1}
								aria-label={`${labels().get(path) ?? base(path)}${group().preview === path ? ", opened for a look" : ""}${group().pinned?.includes(path) ? ", pinned" : ""}${state.conflicts[path] ? ", changed on disk" : state.dirty[path] ? ", unsaved changes" : ""}`}
								aria-selected={group().active === path}
								classList={{
									active: group().active === path,
									dirty: Boolean(state.dirty[path]),
									conflict: Boolean(state.conflicts[path]),
									pinned: Boolean(group().pinned?.includes(path)),
									// Opened for a look by one click in a list: its name is in italics until it is kept.
									preview: group().preview === path,
									"drop-before": dropAt()?.group === props.index && dropAt()?.before === path,
								}}
								aria-haspopup="menu"
								onKeyDown={(e) => e.target === e.currentTarget && onTabKey(e, path)}
								onDblClick={() => keepTab(path, props.index)}
								onContextMenu={(e) => {
									e.preventDefault();
									void tabMenu(path, { x: e.clientX, y: e.clientY });
								}}
								onMouseDown={(e) => {
									if (e.button === 1) {
										e.preventDefault();
										e.stopPropagation();
										middleClose.press(path);
									} else {
										middleClose.cancel();
										activate(path);
									}
								}}
								onMouseLeave={() => middleClose.cancel(path)}
								onMouseUp={(e) => {
									if (e.button !== 1) return;
									e.preventDefault();
									e.stopPropagation();
									middleClose.release(path, () => void closeTab(path, props.index));
								}}
								onAuxClick={(e) => {
									if (e.button !== 1) return;
									e.preventDefault();
									e.stopPropagation();
									middleClose.auxClick(path, () => void closeTab(path, props.index));
								}}
							>
								<FileMark name={base(path)} />
								<span class="name">{labels().get(path) ?? base(path)}</span>
								<Show when={state.conflicts[path]}>
									<span class="conflict-mark" aria-label="changed on disk">
										!
									</span>
								</Show>
								<Show when={group().pinned?.includes(path) && state.dirty[path]}>
									{/* The cross that turns into a dot is not on a pinned tab: its unsaved changes have a dot of their own. */}
									<span class="pinned-dot" aria-hidden="true">
										<span class="dot" />
									</span>
								</Show>
								<Show when={group().pinned?.includes(path)}>
									{/* A pinned tab has a pin where the others have a cross: pressing it lets the tab go. */}
									<button class="pin" tabindex={-1} title="Pinned. Unpin" aria-label={`Unpin ${base(path)}${state.dirty[path] ? " (unsaved changes)" : ""}`} onMouseDown={(e) => e.button !== 1 && e.stopPropagation()} onClick={() => togglePin(path, props.index)}>
										<span class="pin-mark" aria-hidden="true" />
									</button>
								</Show>
								<button class="close" tabindex={-1} title="Close (Ctrl+W)" aria-label={`Close ${base(path)}${state.dirty[path] ? " (unsaved changes)" : ""}`} onMouseDown={(e) => e.button !== 1 && e.stopPropagation()} onClick={() => void closeTab(path, props.index)}>
									<span class="dot" aria-hidden="true" />
									<Icon name="close" class="x" />
								</button>
							</div>
						)}
					</For>
						</div>
					</div>
					<Show when={canScrollLeft() || canScrollRight()}>
						<button
							class="tabs-scroll-btn"
							disabled={!canScrollRight()}
							title="Scroll tabs right"
							aria-label="Scroll tabs right"
							onClick={() => scrollTabsBy(180)}
						>
							<Icon name="chevron-right" />
						</button>
					</Show>
				<Show when={group().active}>
					<Menu label="File actions" title="File actions: save, format, split, close…" class="tab-menu" items={fileActions}>
						<Icon name="ellipsis" />
					</Menu>
				</Show>
				<Show when={isSsl() && !isPlan() && !showFile()}>
					<div class="mode-switch" role="group" aria-label="View of this script">
						<button classList={{ on: group().mode !== "blocks" }} aria-pressed={group().mode !== "blocks"} onClick={() => setState("groups", props.index, "mode", "text")}>
							Text
						</button>
						<button classList={{ on: group().mode === "blocks" }} aria-pressed={group().mode === "blocks"} onClick={() => setState("groups", props.index, "mode", "blocks")}>
							Blocks
						</button>
					</div>
				</Show>
				<Show when={isPlan()}>
					<div class="mode-switch" role="group" aria-label="View of this plan">
						<button
							classList={{ on: planViewMode() === "source" }}
							aria-pressed={planViewMode() === "source"}
							title="Raw JSON source of this plan"
							onClick={() => {
								setPlanMode(group().active!, "source", props.index);
								queueMicrotask(() => focusRequest.fire("editor"));
							}}
						>
							Source
						</button>
						<button
							classList={{ on: planViewMode() === "text" }}
							aria-pressed={planViewMode() === "text"}
							title="Readable structured list and Focus view of the process"
							onClick={() => setPlanMode(group().active!, "text", props.index)}
						>
							Text
						</button>
						<button
							classList={{ on: planViewMode() === "chart" }}
							aria-pressed={planViewMode() === "chart"}
							title="Visual interactive flowchart"
							onClick={() => setPlanMode(group().active!, "chart", props.index)}
						>
							Chart
						</button>
					</div>
				</Show>
				<Show when={isTabular()}>
					<div class="mode-switch" role="group" aria-label="View of this table">
						<button classList={{ on: !showTable() }} aria-pressed={!showTable()} onClick={() => setTableTextMode(group().active!, true, props.index)}>
							Text
						</button>
						<button classList={{ on: showTable() }} aria-pressed={showTable()} onClick={() => setTableTextMode(group().active!, false, props.index)}>
							Table
						</button>
					</div>
				</Show>
				<Show when={isDoc()}>
					<div class="mode-switch" role="group" aria-label="View of this document">
						<button
							classList={{ on: mdViewMode() === "source" }}
							aria-pressed={mdViewMode() === "source"}
							title="Raw unformatted Markdown text"
							onClick={() => {
								setMarkdownMode(group().active!, "source", props.index);
								queueMicrotask(() => focusRequest.fire("editor"));
							}}
						>
							Source
						</button>
						<button
							classList={{ on: mdViewMode() === "live" }}
							aria-pressed={mdViewMode() === "live"}
							title="Live Preview while editing (Ctrl+E toggles Live and Read)"
							onClick={() => {
								setMarkdownMode(group().active!, "live", props.index);
								queueMicrotask(() => focusRequest.fire("editor"));
							}}
						>
							Live
						</button>
						<button
							classList={{ on: mdViewMode() === "read" }}
							aria-pressed={mdViewMode() === "read"}
							title="Finished reading view (Ctrl+E toggles Live and Read)"
							onClick={() => setMarkdownMode(group().active!, "read", props.index)}
						>
							Read
						</button>
					</div>
				</Show>
				</div>
			</Show>
			<div class="editor-sheet">
				{/* Smooth scroll-collapsing Folio header (ADR 0027): one persistent DOM node, pure sans-serif, clickable breadcrumbs. */}
				<Show when={group().active && !showRendered() && !showLive() && !showTable() && !showChart() && !showFile()}>
					<nav class="folio-hdr" classList={{ "is-compact": folioCompact() }} aria-label="File header and breadcrumbs">
						<div class="folio-title-row">
							<div class="folio-title-left">
								<Show when={folioFolder()}>
									<span class="folio-crumb-prefix">
										<span>{folioFolder()}</span>
										<span class="sep">›</span>
									</span>
								</Show>
								<span class="folio-filename">{base(group().active!)}</span>
								<Show when={folioCrumbs().length}>
									<span class="folio-crumb-suffix">
										<For each={folioCrumbs()}>
											{(s) => (
												<>
													<span class="sep">›</span>
													<button class={`crumb kind-${s.kind}`} onClick={() => void openFile(group().active!, { reveal: { line: s.selectionRange.startLineNumber, column: s.selectionRange.startColumn } })}>
														{s.name}
													</button>
												</>
											)}
										</For>
									</span>
								</Show>
							</div>
							<div class="folio-actions">
								<Show when={folioAlert()}>
									{(alert) => <span class={`folio-alert ${alert().kind}`}>{alert().text}</span>}
								</Show>
								<Show when={isGovernableFile()}>
									<Menu
										floating
										class="folio-docs-menu"
										label={
											governingDocs().length
												? `Governed by ${governingDocs().length} project ${governingDocs().length === 1 ? "document" : "documents"}`
												: "Documents for this file"
										}
										title={
											governingDocs().length
												? `Plans, specs, tickets, and registries for this file (${governingDocs().length})`
												: "No governing docs linked yet — create a decision or question for this code"
										}
										items={governingMenu}
									>
										<Icon name="references" />
										<span>
											{governingDocs().length === 0
												? "Docs"
												: governingDocs().length === 1
													? "1 doc"
													: `${governingDocs().length} docs`}
										</span>
										<Icon name="chevron-down" />
									</Menu>
								</Show>
								<Show when={isSql()}>
									<button
										type="button"
										class="folio-btn folio-dialect-btn"
										title={`SQL formatting dialect: ${sqlDialect().label}. Click to switch.`}
										aria-label={`SQL formatting dialect: ${sqlDialect().label}`}
										aria-haspopup="menu"
										onClick={(e) => void pickSqlDialect(e)}
									>
										<Icon name="database" />
										<span>{sqlDialect().short}</span>
										<Icon name="chevron-down" />
									</button>
								</Show>
								<Show when={canFormat()}>
									<button
										type="button"
										class="folio-btn"
										disabled={formatDisabled()}
										title={formatDisabled() ? "Start or restart the language server to format SSL files" : "Format document (Ctrl+Shift+I)"}
										aria-label="Format document"
										onClick={runFormat}
									>
										<Icon name="wand" />
										<span>Format</span>
									</button>
								</Show>
							</div>
						</div>
						<div class="folio-sub-wrap">
							<div class="folio-sub-inner">
								<Show when={folioFolder()}>
									<span class="folio-sub-path">{folioFolder()}</span>
								</Show>
								<For each={folioCrumbs()}>
									{(s, i) => (
										<>
											<Show when={folioFolder() || i() > 0}>
												<span class="sep">›</span>
											</Show>
											<button class={`crumb kind-${s.kind}`} onClick={() => void openFile(group().active!, { reveal: { line: s.selectionRange.startLineNumber, column: s.selectionRange.startColumn } })}>
												{s.name}
											</button>
										</>
									)}
								</For>
							</div>
						</div>
					</nav>
				</Show>
				{/* Keyed by the file: a view built for one script is never reused for the next. */}
				<Show when={showBlocks() && group().active} keyed>
					{(path) => <BlocksView path={path} group={props.index} />}
				</Show>
				<Show when={showChart() && group().active} keyed>
					{(path) => <PlanView path={path} group={props.index} mode={planViewMode() === "text" ? "text" : "chart"} />}
				</Show>
				<Show when={(showRendered() || showLive()) && group().active} keyed>
					{(path) => <MarkdownLiveEditor path={path} group={props.index} mode={showRendered() ? "read" : "live"} />}
				</Show>
				<Show when={showFile() && group().active} keyed>
					{(path) => <FileView path={path} />}
				</Show>
				<Show when={showTable() && group().active} keyed>
					{(path) => <TableView path={path} />}
				</Show>
				<div class="editor-row" classList={{ hidden: showBlocks() || showChart() || showRendered() || showLive() || showTable() || showFile() }}>
					{/* An overview of the whole file, top to bottom, to the left of the line numbers: not marks on the lines in view. */}
					<Show when={group().active && group().active === activePath() && lineCount() > 0 && flatRegions(symbols()).length}>
						<nav class="region-strip" aria-label="Regions in this file, top to bottom" onKeyDown={onStripKey}>
							<For each={flatRegions(symbols())}>
								{({ symbol, depth }, i) => (
									<button
										class="region-band"
										tabindex={i() === 0 ? 0 : -1}
										title={`Region ${symbol.name}: lines ${symbol.range.startLineNumber} to ${symbol.range.endLineNumber}. Click to go there.`}
										aria-label={`Go to region ${symbol.name}, lines ${symbol.range.startLineNumber} to ${symbol.range.endLineNumber}`}
										style={{
											top: `${((symbol.range.startLineNumber - 1) / lineCount()) * 100}%`,
											height: `${Math.max(0.5, ((symbol.range.endLineNumber - symbol.range.startLineNumber + 1) / lineCount()) * 100)}%`,
											// A step in for each region it is inside, up to what the strip has room for.
											left: `${Math.min(depth, 3) * 3}px`,
											background: regionColor(symbol.name),
										}}
										onClick={() => void openFile(group().active!, { reveal: { line: symbol.selectionRange.startLineNumber, column: 1 } })}
									/>
								)}
							</For>
						</nav>
					</Show>
					<div class="editor-host" ref={host} />
				</div>
				<Show when={!group().active}>
					<div
						class="empty-group"
						onDblClick={(e) => {
							if (e.target === e.currentTarget) void newUntitled(props.index);
						}}
					>
						<Start />
					</div>
				</Show>
			</div>
		</section>
	);
}

export const activeEditor = () => editors[state.activeGroup];
export { activePath };
