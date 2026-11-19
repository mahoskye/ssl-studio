// The current file's objects from the language server's document symbols:
// comment regions (Namespace symbols) with their procedures inside, and each
// procedure's parameters under it. A file that is not SSL has an outline of
// its own kind (shared/outline.ts): a document's headings, a settings file's
// tables and keys, a SQL file's statements.
import { createEffect, createResource, createSignal, For, on, onCleanup, Show } from "solid-js";
import { monaco } from "../editor/monaco";
import { session } from "../lsp/session";
import { activeDoc, activePath, openFile, state } from "../state";
import { cycleRegionColor, isRegion, regionColor, symbolPath } from "../editor/regions";
import { isPlanPath, PROCEDURE_DRAG } from "../plan/model";
import { hasOutline, outline, outlineOf, type OutlineItem } from "../../shared/outline";
import { baseName, dirName, relativeTo } from "../../shared/paths";
import { focusRowsBelow, Row, RowGroup, Rows } from "./Rows";
import { serverDown } from "./server";

type Sym = monaco.languages.DocumentSymbol;
// By Monaco's SymbolKind: Module, Namespace (a region), Class, Method, Function, Variable, Constant, String.
const ICONS: Record<number, string> = { 1: "▣", 2: "▣", 3: "§", 4: "◆", 5: "◆", 11: "ƒ", 12: "•", 13: "·", 14: "π", 18: "▣", 19: "·", 22: "▤" };
/** An outline's kinds as the symbols the panel draws: a heading, a table or section, a key, a statement. */
const OUTLINE_KIND: Record<OutlineItem["kind"], number> = { heading: monaco.languages.SymbolKind.Package, section: monaco.languages.SymbolKind.Object, key: monaco.languages.SymbolKind.Key, statement: monaco.languages.SymbolKind.Struct };
const OUTLINE_KINDS = new Set(Object.values(OUTLINE_KIND));
const asSymbol = (item: OutlineItem, model: monaco.editor.ITextModel): Sym => {
	const line = Math.min(item.line, model.getLineCount());
	const endLine = Math.min(Math.max(item.endLine, line), model.getLineCount());
	return {
		name: item.name,
		detail: item.kind === "section" && model.getLanguageId() === "toml" ? "table" : item.kind,
		kind: OUTLINE_KIND[item.kind],
		tags: [],
		range: { startLineNumber: line, startColumn: 1, endLineNumber: endLine, endColumn: model.getLineMaxColumn(endLine) },
		selectionRange: { startLineNumber: line, startColumn: 1, endLineNumber: line, endColumn: model.getLineMaxColumn(line) },
		children: item.children.map((child) => asSymbol(child, model)),
	};
};
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
			if (!doc) return;
			// A document that is not SSL is outlined here, from its own text: nothing is asked of the language server.
			// A plan is JSON, and is read as its chart: the panel lists the workspace's procedures for it instead.
			if (hasOutline(doc.model.getLanguageId()) && !isPlanPath(activePath())) {
				const read = () => (setSymbols(outline(doc.model.getLanguageId(), doc.model.getValue()).map((item) => asSymbol(item, doc.model))), setReading("read"));
				read();
				const sub = doc.model.onDidChangeContent(() => {
					clearTimeout(timer);
					timer = setTimeout(read, 300);
				});
				onCleanup(() => (clearTimeout(timer), sub.dispose()));
				return;
			}
			if (doc.model.getLanguageId() !== "ssl") return;
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
	/** The procedures under the script each is in: the path is said once, and a row is a name. */
	const scripts = () => {
		const groups = new Map<string, ReturnType<typeof list>>();
		for (const s of list()) groups.set(fileOf(s.location.uri), [...(groups.get(fileOf(s.location.uri)) ?? []), s]);
		return [...groups].sort(([a], [b]) => a.localeCompare(b)).map(([file, items]) => ({ file, items: [...items].sort((a, b) => a.location.range.start.line - b.location.range.start.line) }));
	};
	return (
		<Show when={list().length} fallback={<p class="hint">{empty()}</p>}>
			<p class="hint">Drag a procedure into the chart to call it. Enter opens it.</p>
			<Rows label="Procedures in the workspace, by script">
				<For each={scripts()}>
					{(script) => (
						<RowGroup
							title={script.file}
							headClass="group-head proc-script"
							head={
								<>
									<span class="proc-script-name">{baseName(script.file)}</span>
									{/* A long folder keeps its end, the part that tells two scripts of one name apart. */}
									<span class="meta">
										<bdi>{dirName(script.file)}</bdi>
									</span>
								</>
							}
						>
							<For each={script.items}>
								{(s) => (
									<Row
										key={`${s.location.uri}#${s.name}`}
										draggable={true}
										title={`${s.name} in ${script.file}`}
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
									</Row>
								)}
							</For>
						</RowGroup>
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
	/** The innermost region or procedure the editor's cursor is in: its row says "you are here". */
	const here = () => {
		const path = symbolPath(symbols(), state.cursor.line).filter((s) => !isVariable(s));
		return path[path.length - 1];
	};
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
					classList={{ param: parameter(), here: here() === props.symbol }}
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
					<Show when={here() === props.symbol}>
						<span class="here-mark" title="The cursor is in here">
							<span aria-hidden="true">◂</span>
							<span class="visually-hidden">The cursor is in here</span>
						</span>
					</Show>
					<Show when={!isVariable(props.symbol) && !(OUTLINE_KINDS.has(props.symbol.kind) && lines(props.symbol) === 1)}>
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
		const language = doc?.model.getLanguageId();
		if (doc && hasOutline(language) && !filter()) return `This file has no ${outlineOf[language!] ?? "outline"} yet.`;
		if (doc && hasOutline(language)) return `Nothing here matches “${filter()}”. Clear the filter to see everything.`;
		if (!doc || language !== "ssl") return "This kind of file has no outline: SSL, Markdown, TOML, INI, JSON, SQL and YAML files do.";
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
