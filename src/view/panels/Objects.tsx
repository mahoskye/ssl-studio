// The current file's objects from the language server's document symbols:
// comment regions (Namespace symbols) with their procedures inside.
import { createEffect, createSignal, For, on, onCleanup, Show } from "solid-js";
import { monaco } from "../editor/monaco";
import { session } from "../lsp/session";
import { activeDoc, activePath, openFile, state } from "../state";
import { cycleRegionColor, isRegion, regionColor } from "../editor/regions";

type Sym = monaco.languages.DocumentSymbol;
const ICONS: Record<number, string> = { 1: "▣", 2: "▣", 4: "◆", 5: "◆", 11: "ƒ", 12: "ƒ", 13: "·", 14: "π" };
const [symbols, setSymbols] = createSignal<Sym[]>([]);
export { symbols };

export function useSymbols() {
	let timer: ReturnType<typeof setTimeout> | undefined;
	createEffect(
		on([activePath, () => state.lsp.state], () => {
			const doc = activeDoc();
			setSymbols([]);
			if (!doc || doc.model.getLanguageId() !== "ssl") return;
			const load = () => session.documentSymbols(doc.model).then(setSymbols, () => setSymbols([]));
			void load();
			const sub = doc.model.onDidChangeContent(() => {
				clearTimeout(timer);
				timer = setTimeout(load, 400);
			});
			onCleanup(() => sub.dispose());
		}),
	);
}

export function Objects() {
	const [filter, setFilter] = createSignal("");
	const matches = (s: Sym): boolean => !filter() || s.name.toLowerCase().includes(filter().toLowerCase()) || (s.children ?? []).some(matches);
	const Row = (props: { symbol: Sym; depth: number }) => (
		<Show when={matches(props.symbol)}>
			<div
				class={`tree-row kind-${props.symbol.kind}`}
				style={{ "padding-left": `${8 + props.depth * 14}px` }}
				title={`${props.symbol.range.endLineNumber - props.symbol.range.startLineNumber + 1} lines`}
				onClick={() => {
					const path = activePath();
					const r = props.symbol.selectionRange;
					if (path) void openFile(path, { reveal: { line: r.startLineNumber, column: r.startColumn, endLine: r.endLineNumber, endColumn: r.endColumn } });
				}}
			>
				<Show when={isRegion(props.symbol)} fallback={<span class="icon">{ICONS[props.symbol.kind] ?? "•"}</span>}>
					<button
						class="swatch"
						title="Region colour: click to change (kept in workspace settings)"
						style={{ background: regionColor(props.symbol.name) }}
						onClick={(e) => (e.stopPropagation(), cycleRegionColor(props.symbol.name))}
					/>
				</Show>
				<span class="label">{props.symbol.name}</span>
				<span class="meta">{props.symbol.range.endLineNumber - props.symbol.range.startLineNumber + 1}</span>
			</div>
			<For each={props.symbol.children ?? []}>{(child) => <Row symbol={child} depth={props.depth + 1} />}</For>
		</Show>
	);
	return (
		<div class="panel-body">
			<div class="panel-title">
				<span>Objects</span>
			</div>
			<input class="filter" placeholder="Filter" value={filter()} onInput={(e) => setFilter(e.currentTarget.value)} />
			<div class="tree">
				<Show when={symbols().length} fallback={<p class="hint">{activePath() ? "No objects (or the language server is not running)." : "No file open."}</p>}>
					<For each={symbols()}>{(s) => <Row symbol={s} depth={0} />}</For>
				</Show>
			</div>
		</div>
	);
}
