// The current file's objects from the language server's document symbols:
// comment regions (Namespace symbols) with their procedures inside, and each
// procedure's parameters under it.
import { createEffect, createResource, createSignal, For, on, onCleanup, Show } from "solid-js";
import { monaco } from "../editor/monaco";
import { session } from "../lsp/session";
import { activeDoc, activePath, openFile, state } from "../state";
import { cycleRegionColor, isRegion, regionColor } from "../editor/regions";
import { isPlanPath, PROCEDURE_DRAG } from "../plan/model";
import { relativeTo } from "../../shared/paths";
import { focusRowsBelow, Row, Rows } from "./Rows";
import { serverDown } from "./server";

type Sym = monaco.languages.DocumentSymbol;
// By Monaco's SymbolKind: Module, Namespace (a region), Class, Method, Function, Variable, Constant, String.
const ICONS: Record<number, string> = { 1: "▣", 2: "▣", 4: "◆", 5: "◆", 11: "ƒ", 12: "•", 13: "·", 14: "π" };
/** The server's own word for a procedure's parameter, in the symbol's detail. */
const isParameter = (s: Sym) => s.detail === "parameter";
/** A name on one line (a parameter, a public variable): it has no length worth showing. */
const isVariable = (s: Sym) => s.kind === monaco.languages.SymbolKind.Variable;
const lines = (s: Sym) => s.range.endLineNumber - s.range.startLineNumber + 1;
const count = (n: number, one: string) => `${n} ${one}${n === 1 ? "" : "s"}`;

const [symbols, setSymbols] = createSignal<Sym[]>([]);
export { symbols };
/** Where the list for the current file stands, so the panel can say which. */
const [reading, setReading] = createSignal<"idle" | "reading" | "read" | "failed">("idle");
const [failure, setFailure] = createSignal("");

export function useSymbols() {
	let timer: ReturnType<typeof setTimeout> | undefined;
	createEffect(
		on([activePath, () => state.lsp.state], () => {
			const doc = activeDoc();
			setSymbols([]);
			setReading("idle");
			if (!doc || doc.model.getLanguageId() !== "ssl") return;
			let current = true;
			const load = () =>
				session.documentSymbols(doc.model).then(
					(list) => current && (setSymbols(list), setReading("read")),
					(e) => current && (setSymbols([]), setFailure(String(e?.message ?? e)), setReading("failed")),
				);
			setReading("reading");
			void load();
			const sub = doc.model.onDidChangeContent(() => {
				clearTimeout(timer);
				timer = setTimeout(load, 400);
			});
			onCleanup(() => {
				current = false;
				sub.dispose();
			});
		}),
	);
}

// LSP SymbolKind, as the server sends it: Method, Function.
const PROCEDURE_KINDS = new Set([6, 12]);

/** With a plan open: the workspace's procedures, to drag into the chart as calls. */
function Procedures(props: { filter: string }) {
	const [all] = createResource(
		() => state.lsp.state === "running" && (state.workspace?.root ?? false),
		() => session.workspaceSymbols("").then((list) => ({ list, error: "" }), (e) => ({ list: [], error: String(e?.message ?? e) })),
	);
	const procedures = () => (all()?.list ?? []).filter((s) => PROCEDURE_KINDS.has(s.kind));
	const list = () => procedures().filter((s) => s.name.toLowerCase().includes(props.filter.toLowerCase())).slice(0, 300);
	const fileOf = (uri: string) => relativeTo(state.workspace?.root, monaco.Uri.parse(uri).fsPath);
	const empty = () => {
		if (serverDown()) return `${serverDown()} The workspace's procedures come from it.`;
		if (all.loading && !all()) return "Reading the workspace's procedures…";
		if (all()?.error) return `The language server could not list the workspace's procedures: ${all()!.error}`;
		if (!procedures().length) return "The language server found no procedures in the workspace.";
		return `No procedure matches “${props.filter}”. Clear the filter to see them all.`;
	};
	return (
		<Show when={list().length} fallback={<p class="hint">{empty()}</p>}>
			<p class="hint">Drag a procedure into the chart to call it. Enter opens it.</p>
			<Rows role="listbox" label="Procedures in the workspace">
				<For each={list()}>
					{(s) => (
						<Row
							key={`${s.location.uri}#${s.name}`}
							draggable={true}
							title={`${s.name} in ${fileOf(s.location.uri)}`}
							onDragStart={(e) => {
								e.dataTransfer?.setData(PROCEDURE_DRAG, s.name);
								if (e.dataTransfer) e.dataTransfer.effectAllowed = "copy";
							}}
							onActivate={() => void openFile(monaco.Uri.parse(s.location.uri).fsPath, { reveal: { line: s.location.range.start.line + 1, column: s.location.range.start.character + 1 } })}
						>
							<span class="icon" aria-hidden="true">
								ƒ
							</span>
							<span class="label">{s.name}</span>
							<span class="meta">{fileOf(s.location.uri)}</span>
						</Row>
					)}
				</For>
			</Rows>
		</Show>
	);
}

const stepRegionColor = cycleRegionColor;

export function Objects() {
	const [filter, setFilter] = createSignal("");
	/** Rows closed by the user, by their place in the tree. */
	const [closed, setClosed] = createSignal<Set<string>>(new Set());
	const toggle = (key: string) =>
		setClosed((set) => {
			const next = new Set(set);
			next.has(key) ? next.delete(key) : next.add(key);
			return next;
		});
	const matches = (s: Sym): boolean => !filter() || s.name.toLowerCase().includes(filter().toLowerCase()) || (s.children ?? []).some(matches);
	const TreeRow = (props: { symbol: Sym; depth: number; parent: string }) => {
		const key = () => `${props.parent}/${props.symbol.name}`;
		const parameter = () => isParameter(props.symbol);
		const children = () => (props.symbol.children ?? []).filter(matches);
		// A filter shows what it found, whatever was closed.
		const open = () => Boolean(filter()) || !closed().has(key());
		// The server's word for the symbol ("region", "parameter", "public variable"); a procedure's detail is its parameter list.
		const what = () => (props.symbol.detail ?? "").replace(/^\(.*\)$/, "");
		const title = () => {
			const name = `${props.symbol.name}${what() ? `: a ${what()}` : ""}`;
			return isVariable(props.symbol) ? `${name}, line ${props.symbol.range.startLineNumber}` : `${name}, ${count(lines(props.symbol), "line")} from line ${props.symbol.range.startLineNumber}`;
		};
		return (
			<Show when={matches(props.symbol)}>
				<Row
					role="treeitem"
					key={key()}
					class={`tree-row kind-${props.symbol.kind}`}
					classList={{ param: parameter() }}
					level={props.depth + 1}
					expanded={children().length ? open() : undefined}
					style={{ "padding-left": `${8 + props.depth * 14}px` }}
					title={title()}
					onActivate={() => {
						const path = activePath();
						const r = props.symbol.selectionRange;
						if (path) void openFile(path, { reveal: { line: r.startLineNumber, column: r.startColumn, endLine: r.endLineNumber, endColumn: r.endColumn } });
					}}
					onToggle={() => toggle(key())}
					onKey={(e) => {
						if (!isRegion(props.symbol) || (e.key !== "]" && e.key !== "[")) return false;
						stepRegionColor(props.symbol.name, e.key === "]" ? 1 : -1);
						return true;
					}}
				>
					<span
						class="twisty"
						aria-hidden="true"
						onClick={(e) => {
							if (!children().length) return;
							e.stopPropagation();
							toggle(key());
						}}
					>
						{children().length ? (open() ? "▾" : "▸") : ""}
					</span>
					<Show
						when={isRegion(props.symbol)}
						fallback={
							<span class="icon" aria-hidden="true">
								{parameter() ? "·" : (ICONS[props.symbol.kind] ?? "•")}
							</span>
						}
					>
						<button
							class="swatch"
							tabindex={-1}
							aria-label={`Colour of the region ${props.symbol.name}: change it`}
							title="Region colour. Click for the next one, Shift+click for the one before. From the keyboard, on the row: ] and [. Kept in the workspace's settings."
							style={{ background: regionColor(props.symbol.name) }}
							onClick={(e) => (e.stopPropagation(), stepRegionColor(props.symbol.name, e.shiftKey ? -1 : 1))}
						/>
					</Show>
					<span class="label">{props.symbol.name}</span>
					<Show when={!isVariable(props.symbol)}>
						<span class="meta">{lines(props.symbol)}</span>
					</Show>
				</Row>
				<Show when={children().length && open()}>
					<div role="group">
						<For each={props.symbol.children ?? []}>{(child) => <TreeRow symbol={child} depth={props.depth + 1} parent={key()} />}</For>
					</div>
				</Show>
			</Show>
		);
	};
	/** Why the list is empty, and what to do next. */
	const empty = () => {
		const doc = activeDoc();
		if (!activePath()) return "No file open. Open an SSL file to see its regions and procedures.";
		if (!doc || doc.model.getLanguageId() !== "ssl") return "Objects are listed for SSL files, and this is not one.";
		if (serverDown()) return `${serverDown()} This file's objects come from it.`;
		if (reading() === "failed") return `The language server could not list this file's objects: ${failure()}`;
		if (reading() !== "read") return "Reading this file's objects…";
		if (!symbols().length) return "This file has no regions, procedures or public variables yet.";
		return `Nothing here matches “${filter()}”. Clear the filter to see everything.`;
	};
	return (
		<div class="panel-body" data-panel="objects">
			<div class="panel-title">
				<span>Objects</span>
			</div>
			<input
				class="filter"
				data-autofocus=""
				aria-label={isPlanPath(activePath()) ? "Filter the workspace's procedures" : "Filter this file's objects"}
				placeholder="Filter"
				value={filter()}
				onInput={(e) => setFilter(e.currentTarget.value)}
				onKeyDown={(e) => e.key === "ArrowDown" && focusRowsBelow(e.currentTarget) && e.preventDefault()}
			/>
			<Show when={!isPlanPath(activePath())} fallback={<Procedures filter={filter()} />}>
				<Show when={symbols().some(matches)} fallback={<p class="hint">{empty()}</p>}>
					<Rows role="tree" label="Objects in this file">
						<For each={symbols()}>{(s) => <TreeRow symbol={s} depth={0} parent="" />}</For>
					</Rows>
				</Show>
			</Show>
		</div>
	);
}
