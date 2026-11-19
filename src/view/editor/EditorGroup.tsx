// One editor group: a tab strip over one Monaco editor that shows the
// group's active document. Two groups side by side make a split.
import { Icon } from "../Icon";
import { tabShown } from "../recentTabs";
import { createEffect, createSignal, For, onCleanup, onMount, Show } from "solid-js";
import { monaco } from "./monaco";
import { activePath, closeAllTabs, closeOtherTabs, closeTab, closeTabsToRight, documents, focusRequest, moveTab, openFile, revealSignal, revert, save, saveAll, setState, split, state, tabLeaving, takeReveal, togglePin } from "../state";
import { landsBefore } from "../../shared/tabOrder";
import { othersOf, rightOf } from "../../shared/tabOrder";
import { chooseFromMenu } from "../panels/RowMenu";
import type { Point } from "../panels/Rows";
import { symbols } from "../panels/Objects";
import { flatRegions, regionColor, symbolPath } from "./regions";
import { BlocksView } from "../blocks/BlocksView";
import { isPlanPath } from "../plan/model";
import { PlanView } from "../plan/PlanView";
import { baseName, isInside } from "../../shared/paths";
import { tabLabels } from "./tabs";
import { Menu, type MenuItem } from "../Menu";
import { isMarkdown, isTable } from "../project";
import { MarkdownView } from "./MarkdownView";
import { TableView } from "./TableView";
import { FileView } from "./FileView";
import { useGitMarks } from "./gitMarks";
import { Start } from "../Start";
import { FileMark } from "../FileMark";
import { getPath, SERVER_DEFAULTS } from "../../shared/styleProfile";
import { RULER_MARGIN, rulerColumns } from "../../shared/houseStyle";
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

const base = baseName;

export function EditorGroup(props: { index: number }) {
	let host!: HTMLDivElement;
	let editor: monaco.editor.IStandaloneCodeEditor;
	const group = () => state.groups[props.index]!;
	let shown: string | null = null;
	const [lineCount, setLineCount] = createSignal(0);
	// A picture, or other bytes: shown for what it is, never as text, and never as what its name would make it.
	const showFile = () => Boolean(state.kindVersion >= 0 && group().active && documents.get(group().active!)?.binary);
	const isPlan = () => isPlanPath(group().active) && !showFile();
	const showChart = () => isPlan() && !state.planText[group().active!];
	const isSsl = () => Boolean(group().active && documents.get(group().active!)?.model.getLanguageId() === "ssl");
	// Blocks are a view of SSL only. The group remembers the choice, so the next
	// script opens as blocks again, but a Markdown or SQL file never does.
	const showBlocks = () => group().mode === "blocks" && isSsl() && !isPlan() && !showFile();
	const isDoc = () => isMarkdown(group().active) && !showFile();
	const showRendered = () => isDoc() && !state.mdText[group().active!];
	// A table of values opens as a table, with the same switch to its text as a document has.
	const isTabular = () => isTable(group().active) && !showFile();
	const showTable = () => isTabular() && !state.mdText[group().active!];

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
				["new-question", "New Question About This Code…"],
				["new-decision", "New Decision About This Code…"],
				["copy-designer", "Copy for Designer"],
				["wrap-region", "Wrap in Region…"],
			] as const
		).entries()) {
			editor.addAction({ id: `app.${id}`, label, contextMenuGroupId: "9_app", contextMenuOrder: order, run: () => void import("../commands").then((all) => all.runCommand(id)) });
		}
		useGitMarks(editor, () => group().active);
		setRoomy(editor.getLayoutInfo().width >= MINIMAP_FROM);
		editor.onDidLayoutChange((layout) => setRoomy(layout.width >= MINIMAP_FROM));
		editor.onDidFocusEditorText(() => setState("activeGroup", props.index));
		editor.onDidChangeModelContent(() => setLineCount(editor.getModel()?.getLineCount() ?? 0));
		editor.onDidChangeModel(() => {
			setLineCount(editor.getModel()?.getLineCount() ?? 0);
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
			if (path === group().active && shown === path) reveal(path);
		});
		// "Focus editor": the text editor, or whichever view of the file is showing in its place.
		const stopFocus = focusRequest.listen((target) => {
			if (target !== "editor" || state.activeGroup !== props.index) return;
			if (!showBlocks() && !showChart() && !showRendered() && !showTable() && !showFile()) return editor.focus();
			section.querySelector<HTMLElement>(".blocks-scroll, .plan [tabindex], .md-view, .table-view input, .file-view")?.focus();
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
		const range = new monaco.Range(r.line, r.column ?? 1, r.endLine ?? r.line, r.endColumn ?? r.column ?? 1);
		editor.setSelection(range);
		editor.revealRangeInCenterIfOutsideViewport(range, monaco.editor.ScrollType.Immediate);
		editor.focus();
	}

	createEffect(() => {
		const path = group().active;
		if (!editor || path === shown) return;
		if (shown) keepView(shown);
		const doc = path ? documents.get(path) : undefined;
		editor.setModel(doc?.model ?? null);
		shown = doc ? path : null;
		if (doc) {
			// As this group left it; failing that, as any group last left it (a tab that came from the other group).
			const view = viewStates.get(`${props.index}:${path}`) ?? lastViews.get(path!);
			if (view) editor.restoreViewState(view);
			reveal(path!);
			if (state.activeGroup === props.index) editor.focus();
		}
	});

	createEffect(() =>
		editor?.updateOptions({
			fontSize: state.settings.fontSize,
			minimap: { enabled: minimap() },
			wordWrap: state.settings.wordWrap ? "on" : "off",
			inlayHints: { enabled: state.settings.inlayHints === false ? "off" : "on" },
			rulers: rulers(),
		}),
	);

	// The order tabs were used in: what Ctrl+Tab goes back through.
	createEffect(() => {
		const path = group().active;
		if (path) tabShown(props.index, path);
	});

	// The active tab is always in view, however many are open.
	const tabs = new Map<string, HTMLElement>();
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
			activate(path);
			editor.focus();
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
		const PATH = "Copy path";
		const RELATIVE = "Copy path in the project";
		const NAME = "Copy file name";
		const SHOW = "Show in the Explorer";
		const SIDE = "Open to the side";
		const inFolder = Boolean(state.workspace && isInside(state.workspace.root, path));
		// Only what would do something: a tab with nothing to its right has no "close to the right".
		const items = [
			...(pinned() ? [] : [CLOSE]),
			...(othersOf(g.tabs, g.pinned ?? [], path).length ? [OTHERS] : []),
			...(rightOf(g.tabs, g.pinned ?? [], path).length ? [RIGHT] : []),
			ALL,
			PIN,
			PATH,
			...(inFolder ? [RELATIVE] : []),
			NAME,
			...(inFolder ? [SHOW] : []),
			SIDE,
		];
		const picked = await chooseFromMenu(`Actions for the tab ${base(path)}`, items, at);
		if (picked === CLOSE) await closeTab(path, props.index);
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
		return [
			{ label: "Save", keys: keysFor("save") || undefined, run: () => void save(path), disabled: !path || !state.dirty[path], why: path ? "Nothing to save" : none },
			{ label: "Save all", keys: keysFor("save-all") || undefined, run: () => void saveAll(), disabled: !Object.values(state.dirty).some(Boolean), why: "Nothing to save" },
			{ label: "Revert to the file on disk", run: () => path && void revert(path), disabled: !path || !state.dirty[path], why: path ? "No unsaved changes" : none },
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

	return (
		<section ref={section} class="group" classList={{ active: state.activeGroup === props.index }} onMouseDown={() => setState("activeGroup", props.index)}>
			<div class="tabs-row">
				<div
					class="tabs"
					role="tablist"
					aria-label="Open files"
					classList={{ "drop-end": dropAt()?.group === props.index && dropAt()?.before === null }}
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
								title={`${path}${state.conflicts[path] ? "\nChanged on disk since you opened it" : state.dirty[path] ? "\nUnsaved changes" : ""}`}
								tabindex={group().active === path ? 0 : -1}
								aria-label={`${labels().get(path) ?? base(path)}${group().pinned?.includes(path) ? ", pinned" : ""}${state.conflicts[path] ? ", changed on disk" : state.dirty[path] ? ", unsaved changes" : ""}`}
								aria-selected={group().active === path}
								classList={{
									active: group().active === path,
									dirty: Boolean(state.dirty[path]),
									conflict: Boolean(state.conflicts[path]),
									pinned: Boolean(group().pinned?.includes(path)),
									"drop-before": dropAt()?.group === props.index && dropAt()?.before === path,
								}}
								aria-haspopup="menu"
								onKeyDown={(e) => e.target === e.currentTarget && onTabKey(e, path)}
								onContextMenu={(e) => {
									e.preventDefault();
									void tabMenu(path, { x: e.clientX, y: e.clientY });
								}}
								onMouseDown={(e) => {
									if (e.button === 1) {
										e.preventDefault();
										void closeTab(path, props.index);
									} else activate(path);
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
									<button class="pin" tabindex={-1} title="Pinned. Unpin" aria-label={`Unpin ${base(path)}${state.dirty[path] ? " (unsaved changes)" : ""}`} onMouseDown={(e) => e.stopPropagation()} onClick={() => togglePin(path, props.index)}>
										<span class="pin-mark" aria-hidden="true" />
									</button>
								</Show>
								<button class="close" tabindex={-1} title="Close (Ctrl+W)" aria-label={`Close ${base(path)}${state.dirty[path] ? " (unsaved changes)" : ""}`} onMouseDown={(e) => e.stopPropagation()} onClick={() => void closeTab(path, props.index)}>
									<span class="dot" aria-hidden="true" />
									<Icon name="close" class="x" />
								</button>
							</div>
						)}
					</For>
				</div>
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
						<button classList={{ on: !showChart() }} aria-pressed={!showChart()} onClick={() => setState("planText", group().active!, true)}>
							Text
						</button>
						<button classList={{ on: showChart() }} aria-pressed={showChart()} onClick={() => setState("planText", group().active!, false)}>
							Chart
						</button>
					</div>
				</Show>
				<Show when={isTabular()}>
					<div class="mode-switch" role="group" aria-label="View of this table">
						<button classList={{ on: !showTable() }} aria-pressed={!showTable()} onClick={() => setState("mdText", group().active!, true)}>
							Text
						</button>
						<button classList={{ on: showTable() }} aria-pressed={showTable()} onClick={() => setState("mdText", group().active!, false)}>
							Table
						</button>
					</div>
				</Show>
				<Show when={isDoc()}>
					<div class="mode-switch" role="group" aria-label="View of this document">
						<button classList={{ on: !showRendered() }} aria-pressed={!showRendered()} onClick={() => setState("mdText", group().active!, true)}>
							Text
						</button>
						<button classList={{ on: showRendered() }} aria-pressed={showRendered()} onClick={() => setState("mdText", group().active!, false)}>
							Read
						</button>
					</div>
				</Show>
			</div>
			{/* Where the cursor is in the text: not shown over a view of the file that has no cursor line. */}
			<Show when={group().active && group().active === activePath() && symbols().length && !showRendered() && !showTable() && !showChart()}>
				<nav class="breadcrumbs" aria-label="Breadcrumbs">
					<For each={symbolPath(symbols(), state.cursor.line)}>
						{(s, i) => (
							<>
								<Show when={i() > 0}>
									<span class="sep">›</span>
								</Show>
								<button class={`crumb kind-${s.kind}`} onClick={() => void openFile(group().active!, { reveal: { line: s.selectionRange.startLineNumber, column: s.selectionRange.startColumn } })}>
									{s.name}
								</button>
							</>
						)}
					</For>
				</nav>
			</Show>
			{/* Keyed by the file: a view built for one script is never reused for the next. */}
			<Show when={showBlocks() && group().active} keyed>
				{(path) => <BlocksView path={path} group={props.index} />}
			</Show>
			<Show when={showChart() && group().active} keyed>
				{(path) => <PlanView path={path} group={props.index} />}
			</Show>
			<Show when={showRendered() && group().active} keyed>
				{(path) => <MarkdownView path={path} />}
			</Show>
			<Show when={showFile() && group().active} keyed>
				{(path) => <FileView path={path} />}
			</Show>
			<Show when={showTable() && group().active} keyed>
				{(path) => <TableView path={path} />}
			</Show>
			<div class="editor-row" classList={{ hidden: showBlocks() || showChart() || showRendered() || showTable() || showFile() }}>
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
										left: `${depth * 3}px`,
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
				<div class="empty-group">
					<Start />
				</div>
			</Show>
		</section>
	);
}

export const activeEditor = () => editors[state.activeGroup];
export { activePath };
