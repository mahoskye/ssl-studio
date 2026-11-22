// Unified Document outline panel (internal id "objects"): shows the open
// file's structure — SSL comment regions & procedures from starlims-lsp, live
// scrollspy headings for rendered Markdown Read view, outlines for Markdown
// text / TOML / INI / JSON / SQL / YAML (shared/outline.ts), and workspace
// procedures when editing a Plan chart.
import { Icon, type IconName } from "../Icon";
import { createEffect, createResource, createSignal, For, on, onCleanup, Show } from "solid-js";
import { monaco } from "../editor/monaco";
import { mdOutline } from "../editor/MarkdownView";
import { session } from "../lsp/session";
import { activeDoc, activePath, markdownMode, openFile, state } from "../state";
import { cycleRegionColor, isRegion, regionColor, symbolPath } from "../editor/regions";
import { isPlanPath, PROCEDURE_DRAG } from "../plan/model";
import { isMarkdown } from "../project";
import { hasOutline, outline, outlineOf, type OutlineItem } from "../../shared/outline";
import { baseName, dirName, relativeTo } from "../../shared/paths";
import { recall, remember } from "../graph/canvas";
import { Menu, type MenuItem } from "../Menu";
import { focusRowsBelow, IconButton, Row, RowGroup, Rows } from "./Rows";
import { serverDown } from "./server";

type Sym = monaco.languages.DocumentSymbol;
// By Monaco's SymbolKind: Module, Namespace (a region), Class, Method, Function, Variable, Constant, String.
// And for an outline: Package (a heading), Object (a table or section), Key, Struct (a statement).
const ICONS: Record<number, IconName> = { 1: "symbol-namespace", 2: "symbol-namespace", 3: "symbol-string", 4: "symbol-class", 5: "symbol-method", 11: "symbol-method", 12: "symbol-variable", 13: "symbol-constant", 14: "symbol-string", 18: "symbol-namespace", 19: "symbol-key", 22: "symbol-structure" };
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

export type OutlineSort = "position" | "name" | "kind";
const savedSort = recall("outline.sort");
const [outlineSort, setOutlineSortSignal] = createSignal<OutlineSort>(savedSort === "name" || savedSort === "kind" ? savedSort : "position");
const [outlineFollow, setOutlineFollowSignal] = createSignal<boolean>(recall("outline.follow") !== "off");
const [outlineClosed, setOutlineClosed] = createSignal<Set<string>>(new Set());

export const setOutlineSort = (next: OutlineSort) => {
	setOutlineSortSignal(next);
	remember("outline.sort", next);
};
export const setOutlineFollow = (next: boolean) => {
	setOutlineFollowSignal(next);
	remember("outline.follow", next ? "on" : "off");
};

const collectExpandableKeys = (list: Sym[], parent = ""): string[] => {
	const keys: string[] = [];
	for (const s of list) {
		const key = `${parent}/${s.name}`;
		if (s.children?.length) {
			keys.push(key);
			keys.push(...collectExpandableKeys(s.children, key));
		}
	}
	return keys;
};

export const outlineHasExpandable = () => collectExpandableKeys(symbols()).length > 0;
export const outlineAnyOpen = () => {
	const all = collectExpandableKeys(symbols());
	return all.some((k) => !outlineClosed().has(k));
};
export const toggleOutlineCollapseAll = () => {
	const all = collectExpandableKeys(symbols());
	if (!all.length) return;
	if (outlineAnyOpen()) setOutlineClosed(new Set(all));
	else setOutlineClosed(new Set<string>());
};

/** VS Code-style outline options shared by Explorer's Outline drawer and the Document outline panel. */
export const outlineMenuItems = (): MenuItem[] => [
	{
		label: "Follow cursor",
		checked: outlineFollow(),
		run: () => setOutlineFollow(!outlineFollow()),
	},
	"separator",
	{
		label: "Sort by: Position",
		checked: outlineSort() === "position",
		run: () => setOutlineSort("position"),
	},
	{
		label: "Sort by: Name",
		checked: outlineSort() === "name",
		run: () => setOutlineSort("name"),
	},
	{
		label: "Sort by: Type",
		checked: outlineSort() === "kind",
		run: () => setOutlineSort("kind"),
	},
];

const sortSymbols = (list: Sym[], mode: OutlineSort): Sym[] => {
	if (mode === "position") return list;
	return [...list].sort((a, b) =>
		mode === "name"
			? a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: "base" })
			: a.kind - b.kind || a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: "base" }),
	);
};

/** Shared symbol tree used by both the Document outline panel and Explorer's collapsible Outline drawer. */
export function SymbolOutline(props: { filter?: string; compact?: boolean; label?: string }) {
	const filter = () => props.filter ?? "";
	const toggle = (key: string) =>
		setOutlineClosed((set) => {
			const next = new Set(set);
			next.has(key) ? next.delete(key) : next.add(key);
			return next;
		});
	const matches = (s: Sym): boolean => !filter() || s.name.toLowerCase().includes(filter().toLowerCase()) || (s.children ?? []).some(matches);
	/** The innermost region or procedure the editor's cursor is in: its row says "you are here" when Follow cursor is on. */
	const here = () => {
		if (!outlineFollow()) return undefined;
		const path = symbolPath(symbols(), state.cursor.line).filter((s) => !isVariable(s));
		return path[path.length - 1];
	};
	const TreeRow = (rowProps: { symbol: Sym; depth: number; parent: string }) => {
		const key = () => `${rowProps.parent}/${rowProps.symbol.name}`;
		const parameter = () => isParameter(rowProps.symbol);
		const children = () => sortSymbols((rowProps.symbol.children ?? []).filter(matches), outlineSort());
		// A filter shows what it found, whatever was closed.
		const open = () => Boolean(filter()) || !outlineClosed().has(key());
		// The server's word for the symbol ("region", "parameter", "public variable"); a procedure's detail is its parameter list.
		const what = () => (rowProps.symbol.detail ?? "").replace(/^\(.*\)$/, "");
		const title = () => {
			const name = `${rowProps.symbol.name}${what() ? `: a ${what()}` : ""}`;
			return isVariable(rowProps.symbol) ? `${name}, line ${rowProps.symbol.range.startLineNumber}` : `${name}, ${count(lines(rowProps.symbol), "line")} from line ${rowProps.symbol.range.startLineNumber}`;
		};
		return (
			<Show when={matches(rowProps.symbol)}>
				<Row
					role="treeitem"
					key={key()}
					class={`tree-row kind-${rowProps.symbol.kind}`}
					classList={{ param: parameter(), here: here() === rowProps.symbol }}
					level={rowProps.depth + 1}
					expanded={children().length ? open() : undefined}
					style={{ "padding-left": `${8 + rowProps.depth * 14}px` }}
					title={title()}
					onActivate={() => {
						const path = activePath();
						const r = rowProps.symbol.selectionRange;
						if (path) void openFile(path, { reveal: { line: r.startLineNumber, column: r.startColumn, endLine: r.endLineNumber, endColumn: r.endColumn } });
					}}
					onToggle={() => toggle(key())}
					onKey={(e) => {
						if (!isRegion(rowProps.symbol) || (e.key !== "]" && e.key !== "[")) return false;
						stepRegionColor(rowProps.symbol.name, e.key === "]" ? 1 : -1);
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
						<Show when={children().length}>
							<Icon name={open() ? "chevron-down" : "chevron-right"} />
						</Show>
					</span>
					<Show
						when={isRegion(rowProps.symbol)}
						fallback={
							<Icon name={parameter() ? "circle-small-filled" : (ICONS[rowProps.symbol.kind] ?? "circle-small-filled")} class="icon" />
						}
					>
						<button
							class="swatch"
							tabindex={-1}
							aria-label={`Colour of the region ${rowProps.symbol.name}: change it`}
							title="Region colour. Click for the next one, Shift+click for the one before. From the keyboard, on the row: ] and [. Kept in the workspace's settings."
							style={{ background: regionColor(rowProps.symbol.name) }}
							onClick={(e) => (e.stopPropagation(), stepRegionColor(rowProps.symbol.name, e.shiftKey ? -1 : 1))}
						/>
					</Show>
					<span class="label">{rowProps.symbol.name}</span>
					<Show when={here() === rowProps.symbol}>
						<span class="here-mark" title="The cursor is in here">
							<Icon name="arrow-left" />
							<span class="visually-hidden">The cursor is in here</span>
						</span>
					</Show>
					<Show when={!isVariable(rowProps.symbol) && !(OUTLINE_KINDS.has(rowProps.symbol.kind) && lines(rowProps.symbol) === 1)}>
						<span class="meta">{lines(rowProps.symbol)}</span>
					</Show>
				</Row>
				<Show when={children().length && open()}>
					<div role="group">
						<For each={children()}>{(child) => <TreeRow symbol={child} depth={rowProps.depth + 1} parent={key()} />}</For>
					</div>
				</Show>
			</Show>
		);
	};
	/** Why the list is empty, and what to do next. */
	const empty = () => {
		const doc = activeDoc();
		if (!activePath()) return props.compact ? "No file open." : "No file open. Open a script or document to see its outline.";
		const language = doc?.model.getLanguageId();
		if (doc && hasOutline(language) && !filter()) return `This file has no ${outlineOf[language!] ?? "outline"} yet.`;
		if (doc && hasOutline(language)) return `Nothing here matches “${filter()}”. Clear the filter to see everything.`;
		if (!doc || language !== "ssl") return props.compact ? "No outline for this file." : "This kind of file has no outline: SSL, Markdown, TOML, INI, JSON, SQL and YAML files do.";
		if (serverDown()) return `${serverDown()} This file's outline comes from it.`;
		if (reading() === "failed") return `The language server could not list this file's outline: ${failure()}`;
		if (reading() !== "read") return "Reading this file's outline…";
		if (!symbols().length) return props.compact ? "No regions or procedures yet." : "This file has no regions, procedures or public variables yet.";
		return `Nothing here matches “${filter()}”. Clear the filter to see everything.`;
	};
	const top = () => sortSymbols(symbols().filter(matches), outlineSort());
	return (
		<Show when={top().length} fallback={<p class="hint">{empty()}</p>}>
			<Rows role="tree" label={props.label ?? "Outline of this file"}>
				<For each={top()}>{(s) => <TreeRow symbol={s} depth={0} parent="" />}</For>
			</Rows>
		</Show>
	);
}

/** Unified Document outline panel (replaces separate Objects + Document outline panels). */
export function Objects() {
	const [filter, setFilter] = createSignal("");
	const currentMdRead = () => {
		const path = activePath();
		if (!path || !isMarkdown(path) || markdownMode(path) !== "read") return null;
		const info = mdOutline();
		return info && info.path === path ? info : null;
	};
	const filteredHeadings = () => {
		const md = currentMdRead();
		if (!md) return [];
		const q = filter().trim().toLowerCase();
		return q ? md.headings.filter((h) => h.text.toLowerCase().includes(q)) : md.headings;
	};
	return (
		<div class="panel-body doc-outline-panel" data-panel="objects">
			<div class="panel-title">
				<span>Document outline</span>
				<Show when={!currentMdRead() && !isPlanPath(activePath())}>
					<Menu floating label="Outline options" title="Outline options: follow cursor, sort order" class="outline-more" items={outlineMenuItems}>
						<Icon name="ellipsis" />
					</Menu>
					<Show when={outlineHasExpandable()}>
						<IconButton
							label={outlineAnyOpen() ? "Collapse all outline items" : "Expand all outline items"}
							title={outlineAnyOpen() ? "Collapse all" : "Expand all"}
							icon={outlineAnyOpen() ? "collapse-all" : "expand-all"}
							onClick={toggleOutlineCollapseAll}
						/>
					</Show>
				</Show>
			</div>
			<input
				class="filter"
				data-autofocus=""
				aria-label={isPlanPath(activePath()) ? "Filter the workspace's procedures" : "Filter this document's outline"}
				placeholder="Filter"
				value={filter()}
				onInput={(e) => setFilter(e.currentTarget.value)}
				onKeyDown={(e) => e.key === "ArrowDown" && focusRowsBelow(e.currentTarget) && e.preventDefault()}
			/>
			<Show
				when={!isPlanPath(activePath())}
				fallback={<Procedures filter={filter()} />}
			>
				<Show
					when={currentMdRead()}
					fallback={<SymbolOutline filter={filter()} />}
				>
					{(md) => (
						<Show
							when={filteredHeadings().length}
							fallback={<p class="hint">{filter() ? `No heading matches “${filter()}”.` : "This document has no headings yet."}</p>}
						>
							<nav
								class="doc-outline-nav"
								aria-label="On this page"
								onKeyDown={(e) => {
									if (e.key !== "ArrowDown" && e.key !== "ArrowUp" && e.key !== "Home" && e.key !== "End") return;
									const items = [...e.currentTarget.querySelectorAll<HTMLButtonElement>("button[data-row]")];
									if (!items.length) return;
									const at = items.indexOf(document.activeElement as HTMLButtonElement);
									const next = e.key === "Home" ? 0 : e.key === "End" ? items.length - 1 : Math.max(0, Math.min(items.length - 1, at + (e.key === "ArrowDown" ? 1 : -1)));
									e.preventDefault();
									items[next]?.focus();
								}}
							>
								<ul>
									<For each={filteredHeadings()}>
										{(h) => {
											const active = () => (md().activeId || md().headings[0]?.id) === h.id;
											return (
												<li class={`level-${h.level}`}>
													<button
														data-row={h.id}
														classList={{ on: active() }}
														aria-current={active() ? "location" : undefined}
														title={h.text}
														onClick={() => md().goTo(h.id)}
													>
														{h.text}
													</button>
												</li>
											);
										}}
									</For>
								</ul>
							</nav>
						</Show>
					)}
				</Show>
			</Show>
		</div>
	);
}
