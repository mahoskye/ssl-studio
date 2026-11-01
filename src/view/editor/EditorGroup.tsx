// One editor group: a tab strip over one Monaco editor that shows the
// group's active document. Two groups side by side make a split.
import { createEffect, createSignal, For, onCleanup, onMount, Show } from "solid-js";
import { monaco } from "./monaco";
import { activePath, closeTab, documents, openFile, revealSignal, setState, state, takeReveal } from "../state";
import { symbols } from "../panels/Objects";
import { flatRegions, regionColor, symbolPath } from "./regions";
import { BlocksView } from "../blocks/BlocksView";

const viewStates = new Map<string, monaco.editor.ICodeEditorViewState | null>();
export const editors: monaco.editor.IStandaloneCodeEditor[] = [];

const base = (path: string) => path.split("/").pop()!;

export function EditorGroup(props: { index: number }) {
	let host!: HTMLDivElement;
	let editor: monaco.editor.IStandaloneCodeEditor;
	const group = () => state.groups[props.index]!;
	let shown: string | null = null;
	const [lineCount, setLineCount] = createSignal(0);

	onMount(() => {
		editor = monaco.editor.create(host, {
			model: null,
			theme: "studio",
			automaticLayout: true,
			fontSize: state.settings.fontSize,
			minimap: { enabled: state.settings.minimap },
			renderWhitespace: "selection",
			"semanticHighlighting.enabled": false,
			inlayHints: { enabled: "on" },
			fixedOverflowWidgets: true,
			scrollBeyondLastLine: false,
		});
		editors[props.index] = editor;
		editor.onDidFocusEditorText(() => setState("activeGroup", props.index));
		editor.onDidChangeModelContent(() => setLineCount(editor.getModel()?.getLineCount() ?? 0));
		editor.onDidChangeModel(() => setLineCount(editor.getModel()?.getLineCount() ?? 0));
		editor.onDidChangeCursorPosition((e) => {
			if (state.activeGroup === props.index) setState("cursor", { line: e.position.lineNumber, column: e.position.column });
		});
		const stop = revealSignal.listen((path) => {
			if (path === group().active && shown === path) reveal(path);
		});
		onCleanup(() => {
			stop();
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

	createEffect(() => editor?.updateOptions({ fontSize: state.settings.fontSize, minimap: { enabled: state.settings.minimap } }));

	return (
		<section class="group" classList={{ active: state.activeGroup === props.index }} onMouseDown={() => setState("activeGroup", props.index)}>
			<div class="tabs-row">
			<div class="tabs" role="tablist">
				<For each={group().tabs}>
					{(path) => (
						<div
							class="tab"
							role="tab"
							title={path}
							classList={{ active: group().active === path, dirty: Boolean(state.dirty[path]), conflict: Boolean(state.conflicts[path]) }}
							onMouseDown={(e) => {
								if (e.button === 1) {
									e.preventDefault();
									void closeTab(path, props.index);
								} else setState("groups", props.index, "active", path);
							}}
						>
							<span class="name">{base(path)}</span>
							<button class="close" title="Close (Ctrl+W)" onMouseDown={(e) => e.stopPropagation()} onClick={() => void closeTab(path, props.index)}>
								<span class="dot">●</span>
								<span class="x">×</span>
							</button>
						</div>
					)}
				</For>
			</div>
				<Show when={group().active && documents.get(group().active!)?.model.getLanguageId() === "ssl"}>
					<div class="mode-switch" role="group" aria-label="View">
						<button classList={{ on: group().mode !== "blocks" }} onClick={() => setState("groups", props.index, "mode", "text")}>
							Text
						</button>
						<button classList={{ on: group().mode === "blocks" }} onClick={() => setState("groups", props.index, "mode", "blocks")}>
							Blocks
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
			<Show when={group().mode === "blocks" && group().active}>
				<BlocksView path={group().active!} group={props.index} />
			</Show>
			<div class="editor-row" classList={{ hidden: group().mode === "blocks" }}>
				<Show when={group().active && group().active === activePath() && lineCount() > 0}>
					<div class="region-strip" aria-label="Regions">
						<For each={flatRegions(symbols())}>
							{({ symbol, depth }) => (
								<div
									class="region-band"
									title={`${symbol.name}: ${symbol.range.endLineNumber - symbol.range.startLineNumber + 1} lines`}
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
					</div>
				</Show>
				<div class="editor-host" ref={host} />
			</div>
			<Show when={!group().active}>
				<div class="empty-group">
					<p>Open a file from the Explorer, or press Ctrl+P.</p>
				</div>
			</Show>
		</section>
	);
}

export const activeEditor = () => editors[state.activeGroup];
export { activePath };
