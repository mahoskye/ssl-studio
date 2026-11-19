// One editor group: a tab strip over one Monaco editor that shows the
// group's active document. Two groups side by side make a split.
import { createEffect, createSignal, For, onCleanup, onMount, Show } from "solid-js";
import { monaco } from "./monaco";
import { activePath, closeAllTabs, closeOtherTabs, closeTab, documents, focusRequest, openFile, revealSignal, revert, save, saveAll, setState, split, state, takeReveal } from "../state";
import { symbols } from "../panels/Objects";
import { flatRegions, regionColor, symbolPath } from "./regions";
import { BlocksView } from "../blocks/BlocksView";
import { isPlanPath } from "../plan/model";
import { PlanView } from "../plan/PlanView";
import { baseName } from "../../shared/paths";
import { tabLabels } from "./tabs";
import { Menu, type MenuItem } from "../Menu";
import { isMarkdown } from "../project";
import { MarkdownView } from "./MarkdownView";
import { Start } from "../Start";
import { FileMark } from "../FileMark";
import { getPath, SERVER_DEFAULTS } from "../../shared/styleProfile";
import { RULER_MARGIN, rulerColumns } from "../../shared/houseStyle";

const viewStates = new Map<string, monaco.editor.ICodeEditorViewState | null>();
/** The editor width, in pixels, from which the minimap is shown: under it, code at the line length would run beneath the map. */
const MINIMAP_FROM = 640;
export const editors: monaco.editor.IStandaloneCodeEditor[] = [];

const base = baseName;

export function EditorGroup(props: { index: number }) {
	let host!: HTMLDivElement;
	let editor: monaco.editor.IStandaloneCodeEditor;
	const group = () => state.groups[props.index]!;
	let shown: string | null = null;
	const [lineCount, setLineCount] = createSignal(0);
	const isPlan = () => isPlanPath(group().active);
	const showChart = () => isPlan() && !state.planText[group().active!];
	const isSsl = () => Boolean(group().active && documents.get(group().active!)?.model.getLanguageId() === "ssl");
	// Blocks are a view of SSL only. The group remembers the choice, so the next
	// script opens as blocks again, but a Markdown or SQL file never does.
	const showBlocks = () => group().mode === "blocks" && isSsl() && !isPlan();
	const isDoc = () => isMarkdown(group().active);
	const showRendered = () => isDoc() && !state.mdText[group().active!];

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
			renderWhitespace: "selection",
			"semanticHighlighting.enabled": true,
			inlayHints: { enabled: state.settings.inlayHints === false ? "off" : "on" },
			fixedOverflowWidgets: true,
			scrollBeyondLastLine: false,
			rulers: rulers(),
		});
		editors[props.index] = editor;
		setRoomy(editor.getLayoutInfo().width >= MINIMAP_FROM);
		editor.onDidLayoutChange((layout) => setRoomy(layout.width >= MINIMAP_FROM));
		editor.onDidFocusEditorText(() => setState("activeGroup", props.index));
		editor.onDidChangeModelContent(() => setLineCount(editor.getModel()?.getLineCount() ?? 0));
		editor.onDidChangeModel(() => setLineCount(editor.getModel()?.getLineCount() ?? 0));
		editor.onDidChangeCursorPosition((e) => {
			if (state.activeGroup === props.index) setState("cursor", { line: e.position.lineNumber, column: e.position.column });
		});
		const stop = revealSignal.listen((path) => {
			if (path === group().active && shown === path) reveal(path);
		});
		// "Focus editor": the text editor, or whichever view of the file is showing in its place.
		const stopFocus = focusRequest.listen((target) => {
			if (target !== "editor" || state.activeGroup !== props.index) return;
			if (!showBlocks() && !showChart() && !showRendered()) return editor.focus();
			section.querySelector<HTMLElement>(".blocks-scroll, .plan [tabindex], .md-view")?.focus();
		});
		onCleanup(() => {
			stop();
			stopFocus();
			if (shown) viewStates.set(`${props.index}:${shown}`, editor.saveViewState());
			editor.dispose();
			delete editors[props.index];
		});
	});

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
		if (shown) viewStates.set(`${props.index}:${shown}`, editor.saveViewState());
		const doc = path ? documents.get(path) : undefined;
		editor.setModel(doc?.model ?? null);
		shown = doc ? path : null;
		if (doc) {
			const view = viewStates.get(`${props.index}:${path}`);
			if (view) editor.restoreViewState(view);
			reveal(path!);
			if (state.activeGroup === props.index) editor.focus();
		}
	});

	createEffect(() =>
		editor?.updateOptions({
			fontSize: state.settings.fontSize,
			minimap: { enabled: minimap() },
			inlayHints: { enabled: state.settings.inlayHints === false ? "off" : "on" },
			rulers: rulers(),
		}),
	);

	// The active tab is always in view, however many are open.
	const tabs = new Map<string, HTMLElement>();
	createEffect(() => {
		const path = group().active;
		if (path) tabs.get(path)?.scrollIntoView({ block: "nearest", inline: "nearest" });
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
		}
	};
	const onStripKey = (e: KeyboardEvent) => {
		if (e.key !== "ArrowUp" && e.key !== "ArrowDown") return;
		e.preventDefault();
		const bands = [...(e.currentTarget as HTMLElement).querySelectorAll<HTMLElement>(".region-band")];
		bands[(bands.indexOf(document.activeElement as HTMLElement) + (e.key === "ArrowDown" ? 1 : -1) + bands.length) % bands.length]?.focus();
	};
	let section!: HTMLElement;
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
			{ label: "Close all tabs", run: () => void closeAllTabs(), disabled: !group().tabs.length, why: "No tabs" },
		];
	};

	return (
		<section ref={section} class="group" classList={{ active: state.activeGroup === props.index }} onMouseDown={() => setState("activeGroup", props.index)}>
			<div class="tabs-row">
				<div class="tabs" role="tablist" aria-label="Open files">
					<For each={group().tabs}>
						{(path) => (
							<div
								class="tab"
								role="tab"
								ref={(el) => (tabs.set(path, el), onCleanup(() => tabs.delete(path)))}
								title={`${path}${state.conflicts[path] ? "\nChanged on disk since you opened it" : state.dirty[path] ? "\nUnsaved changes" : ""}`}
								tabindex={group().active === path ? 0 : -1}
								aria-selected={group().active === path}
								classList={{ active: group().active === path, dirty: Boolean(state.dirty[path]), conflict: Boolean(state.conflicts[path]) }}
								onKeyDown={(e) => e.target === e.currentTarget && onTabKey(e, path)}
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
								<button class="close" tabindex={-1} title="Close (Ctrl+W)" aria-label={`Close ${base(path)}${state.dirty[path] ? " (unsaved changes)" : ""}`} onMouseDown={(e) => e.stopPropagation()} onClick={() => void closeTab(path, props.index)}>
									<span class="dot" aria-hidden="true">
										●
									</span>
									<span class="x" aria-hidden="true">
										×
									</span>
								</button>
							</div>
						)}
					</For>
				</div>
				<Show when={group().active}>
					<Menu label="File actions" title="File actions: save, format, split, close…" class="tab-menu" items={fileActions}>
						<span aria-hidden="true">⋯</span>
					</Menu>
				</Show>
				<Show when={isSsl() && !isPlan()}>
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
			<Show when={group().active && group().active === activePath() && symbols().length}>
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
			<div class="editor-row" classList={{ hidden: showBlocks() || showChart() || showRendered() }}>
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
