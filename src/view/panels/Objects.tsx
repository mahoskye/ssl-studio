// Unified Document outline panel (internal id "objects"): shows the open
// file's structure — SSL comment regions & procedures from starlims-lsp,
// collapsible Markdown heading trees with task counts & section refactoring
// (working across Live, Source, and Read modes), CSV/TSV column outlines,
// Plan (.plan.json) stages & steps + drag-to-chart SSL procedures, and
// outlines for TOML / INI / JSON / SQL / YAML (shared/outline.ts).
import { Icon, type IconName } from "../Icon";
import { createEffect, createMemo, createResource, createSignal, For, on, onCleanup, Show } from "solid-js";
import { backend } from "../backend";
import { activeLiveEditor, jumpToTableColumn, liveSelectionVersion, onSplitScrollSync } from "../editor/liveBridge";
import { mdOutline } from "../editor/mdOutline";
import { monaco } from "../editor/monaco";
import { session } from "../lsp/session";
import { activeDoc, activePath, canonical, documents, markdownMode, notify, openFile, setState, state } from "../state";
import { cycleRegionColor, isRegion, regionColor, symbolPath } from "../editor/regions";
import { isPlanPath, PROCEDURE_DRAG } from "../plan/model";
import { docs, isMarkdown, isTable } from "../project";
import { parseCsv } from "../../shared/csv";
import { frontMatter } from "../../shared/frontMatter";
import {
	csvColumnOutline,
	demoteMarkdownSection,
	hasOutline,
	markdownSectionTree,
	moveMarkdownSection,
	moveMarkdownSectionTo,
	outline,
	outlineOf,
	planStageOutline,
	promoteMarkdownSection,
	type CsvColumnSummary,
	type MarkdownSection,
	type OutlineItem,
	type PlanOutlineNode,
	type PlanOutlineStage,
} from "../../shared/outline";
import { baseName, dirName, relativeTo } from "../../shared/paths";
import { recall, remember } from "../graph/canvas";
import { Menu, type MenuItem } from "../Menu";
import {
	activeMarkdownTab,
	chooseMarkdownPanelTab,
	defaultMarkdownPanelTab,
	hasSavedMarkdownTab,
	markdownLinksSummary,
	markdownPanelTabRequest,
	registerMarkdownPanelOpener,
	setActiveMarkdownTab,
} from "./markdownBridge";
import { MarkdownInspector } from "./MarkdownInspector";
import { showPanel } from "./registry";
import { chooseFromMenu, type RowMenuEntry } from "./RowMenu";
import { focusRowsBelow, IconButton, Row, RowGroup, Rows, type Point, type RowsApi } from "./Rows";
import { serverDown } from "./server";

registerMarkdownPanelOpener(() => showPanel("objects"));

let lastAutoDefaultMdPath = "";
let lastHandledMdTabReqSeq = 0;

type Sym = monaco.languages.DocumentSymbol;
// By Monaco's SymbolKind: Module, Namespace (a region), Class, Method, Function, Variable, Constant, String.
// And for an outline: Package (a heading), Object (a table or section), Key, Struct (a statement).
const ICONS: Record<number, IconName> = {
	1: "symbol-namespace",
	2: "symbol-namespace",
	3: "symbol-string",
	4: "symbol-class",
	5: "symbol-method",
	11: "symbol-method",
	12: "symbol-variable",
	13: "symbol-constant",
	14: "symbol-string",
	18: "symbol-namespace",
	19: "symbol-key",
	22: "symbol-structure",
};
/** An outline's kinds as the symbols the panel draws: a heading, a table or section, a key, a statement. */
const OUTLINE_KIND: Record<OutlineItem["kind"], number> = {
	heading: monaco.languages.SymbolKind.Package,
	section: monaco.languages.SymbolKind.Object,
	key: monaco.languages.SymbolKind.Key,
	statement: monaco.languages.SymbolKind.Struct,
};
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
const [mdSections, setMdSections] = createSignal<MarkdownSection[]>([]);
const [csvColumns, setCsvColumns] = createSignal<CsvColumnSummary[]>([]);
const [planStages, setPlanStages] = createSignal<PlanOutlineStage[]>([]);
export { symbols, mdSections, csvColumns, planStages };

/** Where the list for the current file stands, so the panel can say which. */
const [reading, setReading] = createSignal<"idle" | "reading" | "read" | "failed">("idle");
const [failure, setFailure] = createSignal("");

const isActiveCsv = () => {
	void state.kindVersion;
	const path = activePath();
	const doc = activeDoc();
	return Boolean(doc && !doc.binary && (isTable(path) || doc.model.getLanguageId() === "csv"));
};

export function useSymbols() {
	let timer: ReturnType<typeof setTimeout> | undefined;
	createEffect(
		on([activePath, () => state.lsp.state, () => state.kindVersion], () => {
			const path = activePath();
			const doc = activeDoc();
			setSymbols([]);
			setMdSections([]);
			setCsvColumns([]);
			setPlanStages([]);
			setReading("idle");
			if (!doc || doc.binary) return;

			if (isPlanPath(path)) {
				const readPlan = () => {
					setPlanStages(planStageOutline(doc.model.getValue()));
					setReading("read");
				};
				readPlan();
				const sub = doc.model.onDidChangeContent(() => {
					clearTimeout(timer);
					timer = setTimeout(readPlan, 250);
				});
				onCleanup(() => (clearTimeout(timer), sub.dispose()));
				return;
			}

			if (isMarkdown(path)) {
				const readMd = () => {
					const val = doc.model.getValue();
					setMdSections(markdownSectionTree(val));
					setSymbols(outline("markdown", val).map((item) => asSymbol(item, doc.model)));
					setReading("read");
				};
				readMd();
				const sub = doc.model.onDidChangeContent(() => {
					clearTimeout(timer);
					timer = setTimeout(readMd, 250);
				});
				onCleanup(() => (clearTimeout(timer), sub.dispose()));
				return;
			}

			if (isTable(path) || doc.model.getLanguageId() === "csv") {
				const readCsv = () => {
					const val = doc.model.getValue();
					setCsvColumns(csvColumnOutline(val));
					setSymbols(outline("csv", val).map((item) => asSymbol(item, doc.model)));
					setReading("read");
				};
				readCsv();
				const sub = doc.model.onDidChangeContent(() => {
					clearTimeout(timer);
					timer = setTimeout(readCsv, 250);
				});
				onCleanup(() => (clearTimeout(timer), sub.dispose()));
				return;
			}

			// A document that is not SSL is outlined here, from its own text: nothing is asked of the language server.
			if (hasOutline(doc.model.getLanguageId())) {
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
										<Icon name="symbol-method" class="icon" />
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

const mdCollapseKey = (path: string | null | undefined, slug: string) => `${canonical(path ?? "")}:md:${slug}`;

const collectMdExpandableKeys = (list: MarkdownSection[], path?: string | null): string[] => {
	const keys: string[] = [];
	for (const s of list) {
		if (s.children.length) {
			keys.push(mdCollapseKey(path, s.slug));
			keys.push(...collectMdExpandableKeys(s.children, path));
		}
	}
	return keys;
};

const collectActiveExpandableKeys = (): string[] => {
	const path = activePath();
	if (isMarkdown(path)) return collectMdExpandableKeys(mdSections(), path);
	if (isPlanPath(path)) return planStages().filter((st) => st.nodes.length > 0).map((st) => `plan:${st.id}`);
	return collectExpandableKeys(symbols());
};

export const outlineHasExpandable = () => collectActiveExpandableKeys().length > 0;
export const outlineAnyOpen = () => {
	const all = collectActiveExpandableKeys();
	return all.some((k) => !outlineClosed().has(k));
};
export const toggleOutlineCollapseAll = () => {
	const all = collectActiveExpandableKeys();
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

const sortSections = (list: MarkdownSection[], mode: OutlineSort): MarkdownSection[] => {
	if (mode === "position") return list;
	return [...list].sort((a, b) =>
		mode === "name"
			? a.text.localeCompare(b.text, undefined, { numeric: true, sensitivity: "base" })
			: a.level - b.level || a.text.localeCompare(b.text, undefined, { numeric: true, sensitivity: "base" }),
	);
};

/** Applies a minimal-range single undoable edit to the active Monaco model (ADR 0002). */
function applyMinimalModelEdit(model: monaco.editor.ITextModel, nextText: string): boolean {
	const prev = model.getValue();
	if (prev === nextText) return false;
	let start = 0;
	const minLen = Math.min(prev.length, nextText.length);
	while (start < minLen && prev.charCodeAt(start) === nextText.charCodeAt(start)) start++;
	let oldEnd = prev.length;
	let newEnd = nextText.length;
	while (oldEnd > start && newEnd > start && prev.charCodeAt(oldEnd - 1) === nextText.charCodeAt(newEnd - 1)) {
		oldEnd--;
		newEnd--;
	}
	const fromPos = model.getPositionAt(start);
	const toPos = model.getPositionAt(oldEnd);
	const range = new monaco.Range(fromPos.lineNumber, fromPos.column, toPos.lineNumber, toPos.column);
	model.pushStackElement();
	model.pushEditOperations([], [{ range, text: nextText.slice(start, newEnd) }], () => null);
	model.pushStackElement();
	return true;
}

/** Finds a section in the tree by slug or line, together with its parent sibling array and index. */
function findSectionInfo(
	list: MarkdownSection[],
	predicate: (s: MarkdownSection) => boolean,
): { section: MarkdownSection; siblings: MarkdownSection[]; index: number } | null {
	for (let i = 0; i < list.length; i++) {
		const s = list[i]!;
		if (predicate(s)) return { section: s, siblings: list, index: i };
		if (s.children.length) {
			const hit = findSectionInfo(s.children, predicate);
			if (hit) return hit;
		}
	}
	return null;
}

/** Finds the innermost Markdown section whose line range holds `line`. */
function innermostSectionAtLine(list: MarkdownSection[], line: number): MarkdownSection | null {
	for (const s of list) {
		if (line >= s.line && line <= s.endLine) {
			return innermostSectionAtLine(s.children, line) ?? s;
		}
	}
	return null;
}

/** Finds a Markdown section matching an anchor slug. */
function findSectionBySlug(list: MarkdownSection[], slug: string): MarkdownSection | null {
	for (const s of list) {
		if (s.slug === slug) return s;
		const hit = findSectionBySlug(s.children, slug);
		if (hit) return hit;
	}
	return null;
}

async function copyClipboardText(text: string, message: string) {
	try {
		const copied = await backend.clipboard(text);
		if (!copied) await navigator.clipboard?.writeText(text);
		notify(message);
	} catch {
		notify("Could not copy to the clipboard.", "error");
	}
}

/** Maximum heading level present in a section or any of its descendants. */
function maxSectionLevel(sec: MarkdownSection): number {
	let max = sec.level;
	for (const child of sec.children) {
		const sub = maxSectionLevel(child);
		if (sub > max) max = sub;
	}
	return max;
}

/** Collapsible Markdown heading tree with task counts, active tracking, context menu, Alt+Up/Down/Shift+Left/Right & cross-parent drag reordering. */
function MarkdownOutline(props: { filter?: string; compact?: boolean; label?: string }) {
	const filter = () => props.filter ?? "";
	let rowsApi: RowsApi | undefined;
	let draggingLine: number | null = null;
	const [dropTarget, setDropTarget] = createSignal<{ line: number; place: "before" | "after" | "inside" } | null>(null);
	const [trackSource, setTrackSource] = createSignal<"cursor" | "scroll">("cursor");
	const [sourceScrollLine, setSourceScrollLine] = createSignal<{ path: string; line: number } | null>(null);

	createEffect(on(() => state.cursor.line, () => setTrackSource("cursor"), { defer: true }));
	createEffect(on(() => liveSelectionVersion(), () => setTrackSource("cursor"), { defer: true }));
	createEffect(on(() => mdOutline()?.activeId, () => setTrackSource("scroll"), { defer: true }));
	createEffect(() => {
		const unsub = onSplitScrollSync((payload) => {
			const p = activePath();
			if (!p || !isMarkdown(p) || canonical(payload.path) !== canonical(p)) return;
			if (markdownMode(p) !== "source") return;
			setSourceScrollLine({ path: payload.path, line: payload.topLine });
			setTrackSource("scroll");
		});
		onCleanup(unsub);
	});

	const toggle = (key: string) =>
		setOutlineClosed((set) => {
			const next = new Set(set);
			next.has(key) ? next.delete(key) : next.add(key);
			return next;
		});

	const matches = (s: MarkdownSection): boolean => !filter() || s.text.toLowerCase().includes(filter().toLowerCase()) || s.children.some(matches);

	const activeSection = createMemo<MarkdownSection | null>(() => {
		if (!outlineFollow()) return null;
		const path = activePath();
		const list = mdSections();
		if (!path || !isMarkdown(path) || !list.length) return null;
		const mode = markdownMode(path);
		const liveInfo = mdOutline();
		const hasLiveInfo = Boolean(liveInfo && canonical(liveInfo.path) === canonical(path));

		const fromScrollspy = (): MarkdownSection | null => {
			if (!hasLiveInfo || !liveInfo?.activeId) return null;
			const hit = liveInfo.headings.find((h) => h.id === liveInfo.activeId);
			if (hit?.line) return innermostSectionAtLine(list, hit.line);
			return findSectionBySlug(list, liveInfo.activeId);
		};

		if (mode === "read") {
			return fromScrollspy() ?? list[0] ?? null;
		}
		if (mode === "live") {
			if (trackSource() === "scroll") {
				const scrolled = fromScrollspy();
				if (scrolled) return scrolled;
			}
			liveSelectionVersion();
			const live = activeLiveEditor();
			const line = live && canonical(live.path) === canonical(path) ? live.getPosition().lineNumber : state.cursor.line;
			return innermostSectionAtLine(list, line) ?? fromScrollspy();
		}
		// Source mode: track Monaco viewport scrollspy when scrolling, cursor line otherwise.
		if (trackSource() === "scroll") {
			const scrolled = sourceScrollLine();
			if (scrolled && canonical(scrolled.path) === canonical(path)) {
				const hit = innermostSectionAtLine(list, scrolled.line);
				if (hit) return hit;
			}
		}
		return innermostSectionAtLine(list, state.cursor.line);
	});

	const jumpToSection = (sec: MarkdownSection) => {
		const path = activePath();
		if (!path) return;
		const liveInfo = mdOutline();
		if (markdownMode(path) !== "source" && liveInfo && canonical(liveInfo.path) === canonical(path)) {
			const hit = liveInfo.headings.find((h) => h.line === sec.line) ?? liveInfo.headings.find((h) => h.id === sec.slug);
			if (hit) {
				liveInfo.goTo(hit.id);
				return;
			}
		}
		void openFile(path, { reveal: { line: sec.line, column: 1 } });
	};

	const commitSectionTransform = (path: string, nextText: string, newLine: number) => {
		const doc = activeDoc();
		if (!doc) return;
		if (!applyMinimalModelEdit(doc.model, nextText)) return;
		const nextTree = markdownSectionTree(nextText);
		setMdSections(nextTree);
		const movedSec = findSectionInfo(nextTree, (s) => s.line === newLine)?.section;
		if (movedSec) rowsApi?.focus(mdCollapseKey(path, movedSec.slug));
		const live = activeLiveEditor();
		if (live && canonical(live.path) === canonical(path)) {
			live.reveal({ line: newLine, column: 1 });
		} else {
			setState("cursor", { line: newLine, column: 1 });
			if (markdownMode(path) === "source") void openFile(path, { reveal: { line: newLine, column: 1 } });
		}
	};

	const moveSection = (sec: MarkdownSection, direction: "up" | "down") => {
		const doc = activeDoc();
		const path = activePath();
		if (!doc || !path || !isMarkdown(path)) return;
		const moved = moveMarkdownSection(doc.model.getValue(), sec.line, direction);
		if (!moved) return;
		commitSectionTransform(path, moved.text, moved.newLine);
	};

	const moveSectionTo = (fromLine: number, toLine: number, place: "before" | "after" | "inside") => {
		const doc = activeDoc();
		const path = activePath();
		if (!doc || !path || !isMarkdown(path)) return;
		const moved = moveMarkdownSectionTo(doc.model.getValue(), fromLine, toLine, place);
		if (!moved.changed) return;
		commitSectionTransform(path, moved.text, moved.newLine);
	};

	const shiftSectionLevel = (sec: MarkdownSection, action: "promote" | "demote") => {
		const doc = activeDoc();
		const path = activePath();
		if (!doc || !path || !isMarkdown(path)) return;
		const text = doc.model.getValue();
		const res = action === "promote" ? promoteMarkdownSection(text, sec.line) : demoteMarkdownSection(text, sec.line);
		if (!res.changed) return;
		commitSectionTransform(path, res.text, res.newLine);
	};

	const openSectionMenu = async (sec: MarkdownSection, at: Point) => {
		const path = activePath();
		if (!path) return;
		const info = findSectionInfo(mdSections(), (s) => s.line === sec.line);
		const canMoveUp = Boolean(info && info.index > 0);
		const canMoveDown = Boolean(info && info.index < info.siblings.length - 1);
		const canPromote = sec.level > 1;
		const canDemote = maxSectionLevel(sec) < 6;
		const stem = baseName(path).replace(/\.(md|markdown)$/i, "");
		const entries: RowMenuEntry[] = [
			{ label: "Jump to section", value: "jump" },
			"separator",
			{ label: `Copy link ([[${stem}#${sec.text}]])`, value: "copy-link" },
			{ label: "Rename heading across workspace…", value: "rename-heading" },
			"separator",
			{ label: "Promote heading (#)", value: "promote", keys: "Alt+Shift+Left", disabled: !canPromote },
			{ label: "Demote heading (#)", value: "demote", keys: "Alt+Shift+Right", disabled: !canDemote },
			"separator",
			{ label: "Move section up", value: "move-up", keys: "Alt+Up", disabled: !canMoveUp },
			{ label: "Move section down", value: "move-down", keys: "Alt+Down", disabled: !canMoveDown },
		];
		const picked = await chooseFromMenu(`Actions for ${sec.text}`, entries, at);
		if (!picked) return;
		if (picked === "jump") {
			jumpToSection(sec);
		} else if (picked === "copy-link") {
			await copyClipboardText(`[[${stem}#${sec.text}]]`, `Copied [[${stem}#${sec.text}]].`);
		} else if (picked === "rename-heading") {
			// Position cursor on this exact heading before invoking the rename-heading command.
			const live = activeLiveEditor();
			if (live && canonical(live.path) === canonical(path)) {
				live.reveal({ line: sec.line, column: 1 });
			} else {
				await openFile(path, { reveal: { line: sec.line, column: 1 } });
			}
			(await import("../commands")).runCommand("rename-heading");
		} else if (picked === "promote") {
			shiftSectionLevel(sec, "promote");
		} else if (picked === "demote") {
			shiftSectionLevel(sec, "demote");
		} else if (picked === "move-up") {
			moveSection(sec, "up");
		} else if (picked === "move-down") {
			moveSection(sec, "down");
		}
	};

	const canReorder = () => !filter() && outlineSort() === "position";

	const canDropSection = (fromLine: number, target: MarkdownSection, place: "before" | "after" | "inside"): boolean => {
		if (fromLine === target.line) return false;
		const src = findSectionInfo(mdSections(), (s) => s.line === fromLine)?.section;
		if (!src) return false;
		// Reject drops onto self or anywhere inside own descendant subtree.
		if (target.line >= src.line && target.line <= src.endLine) return false;
		// Cannot nest inside an H6 heading.
		if (place === "inside" && target.level >= 6) return false;
		return true;
	};

	const SectionRow = (rowProps: { section: MarkdownSection; depth: number }) => {
		const key = () => mdCollapseKey(activePath(), rowProps.section.slug);
		const children = () => sortSections(rowProps.section.children.filter(matches), outlineSort());
		const open = () => Boolean(filter()) || !outlineClosed().has(key());
		const isHere = () => activeSection()?.line === rowProps.section.line;
		const drop = () => {
			const d = dropTarget();
			return d && d.line === rowProps.section.line ? d.place : null;
		};
		const title = () => {
			const s = rowProps.section;
			const taskNote = s.tasksTotal > 0 ? ` · ${s.tasksDone}/${s.tasksTotal} tasks done` : "";
			return `H${s.level}: ${s.text} (line ${s.line}${taskNote})`;
		};
		return (
			<Show when={matches(rowProps.section)}>
				<Row
					role="treeitem"
					key={key()}
					class={`tree-row md-outline-row level-${rowProps.section.level}`}
					classList={{ here: isHere() }}
					level={rowProps.depth + 1}
					expanded={children().length ? open() : undefined}
					style={{
						"padding-left": `${8 + rowProps.depth * 14}px`,
						...(drop() === "before"
							? { "box-shadow": "inset 0 2px 0 var(--accent)" }
							: drop() === "after"
								? { "box-shadow": "inset 0 -2px 0 var(--accent)" }
								: drop() === "inside"
									? {
											outline: "1px solid var(--accent)",
											background: "color-mix(in srgb, var(--accent) 14%, transparent)",
										}
									: {}),
					}}
					title={title()}
					draggable={canReorder()}
					onDragStart={(e) => {
						if (!canReorder()) return;
						draggingLine = rowProps.section.line;
						e.dataTransfer?.setData("application/x-ssl-md-section", String(rowProps.section.line));
						if (e.dataTransfer) e.dataTransfer.effectAllowed = "move";
					}}
					onDragEnd={() => {
						draggingLine = null;
						setDropTarget(null);
					}}
					onDragOver={(e) => {
						if (draggingLine === null || !canReorder()) return;
						const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
						const relY = e.clientY - rect.top;
						let place: "before" | "after" | "inside";
						if (relY < rect.height * 0.25) place = "before";
						else if (relY > rect.height * 0.75) place = "after";
						else place = rowProps.section.level < 6 ? "inside" : relY < rect.height / 2 ? "before" : "after";
						if (!canDropSection(draggingLine, rowProps.section, place)) {
							setDropTarget(null);
							return;
						}
						e.preventDefault();
						if (e.dataTransfer) e.dataTransfer.dropEffect = "move";
						setDropTarget({ line: rowProps.section.line, place });
					}}
					onDrop={(e) => {
						const from = draggingLine;
						const currentDrop = dropTarget();
						draggingLine = null;
						setDropTarget(null);
						const place = currentDrop?.line === rowProps.section.line ? currentDrop.place : "before";
						if (from === null || !canReorder() || !canDropSection(from, rowProps.section, place)) return;
						e.preventDefault();
						moveSectionTo(from, rowProps.section.line, place);
					}}
					onActivate={() => jumpToSection(rowProps.section)}
					onToggle={() => toggle(key())}
					onMenu={(at) => void openSectionMenu(rowProps.section, at)}
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
					<span class="label" style={rowProps.section.level === 1 ? { "font-weight": "600" } : undefined}>
						{rowProps.section.text}
					</span>
					<Show when={isHere()}>
						<span class="here-mark" title="Current section">
							<Icon name="arrow-left" />
							<span class="visually-hidden">Current section</span>
						</span>
					</Show>
					<Show when={rowProps.section.tasksTotal > 0}>
						<span
							class="meta"
							style={rowProps.section.tasksDone === rowProps.section.tasksTotal ? { color: "var(--ok)" } : undefined}
							title={`${rowProps.section.tasksDone} of ${rowProps.section.tasksTotal} tasks done in this section`}
						>
							{rowProps.section.tasksDone}/{rowProps.section.tasksTotal}
						</span>
					</Show>
				</Row>
				<Show when={children().length && open()}>
					<div role="group">
						<For each={children()}>{(child) => <SectionRow section={child} depth={rowProps.depth + 1} />}</For>
					</div>
				</Show>
			</Show>
		);
	};

	const top = () => sortSections(mdSections().filter(matches), outlineSort());
	const empty = () =>
		filter()
			? `No heading matches “${filter()}”. Clear the filter to see everything.`
			: "This document has no headings yet.";

	return (
		<Show when={top().length} fallback={<p class="hint">{empty()}</p>}>
			<div
				style={{ display: "flex", "flex-direction": "column", flex: "1", "min-height": "0" }}
				onKeyDown={(e) => {
					if (!e.altKey || e.ctrlKey || e.metaKey) return;
					const rowEl = (e.target as Element | null)?.closest<HTMLElement>("[data-row]");
					const rowKey = rowEl?.dataset.row ?? "";
					const sep = rowKey.lastIndexOf(":md:");
					if (sep < 0) return;
					const slug = rowKey.slice(sep + 4);
					const sec = findSectionBySlug(mdSections(), slug);
					if (!sec) return;
					if (!e.shiftKey && (e.key === "ArrowUp" || e.key === "ArrowDown")) {
						e.preventDefault();
						e.stopPropagation();
						moveSection(sec, e.key === "ArrowUp" ? "up" : "down");
					} else if (e.shiftKey && (e.key === "ArrowLeft" || e.key === "ArrowRight")) {
						e.preventDefault();
						e.stopPropagation();
						shiftSectionLevel(sec, e.key === "ArrowLeft" ? "promote" : "demote");
					}
				}}
			>
				<Rows role="tree" label={props.label ?? "Outline of this document"} api={(api) => (rowsApi = api)}>
					<For each={top()}>{(sec) => <SectionRow section={sec} depth={0} />}</For>
				</Rows>
			</div>
		</Show>
	);
}

/** CSV/TSV column outline: lists columns with non-empty & distinct counts and jumps directly to the column in TableView. */
function CsvOutline(props: { filter?: string; compact?: boolean; label?: string }) {
	const filter = () => (props.filter ?? "").trim().toLowerCase();
	const list = createMemo(() => {
		const q = filter();
		let cols = csvColumns().filter((c) => !q || c.name.toLowerCase().includes(q) || c.sampleType.includes(q));
		if (outlineSort() === "name") {
			cols = [...cols].sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: "base" }));
		} else if (outlineSort() === "kind") {
			cols = [...cols].sort((a, b) => a.sampleType.localeCompare(b.sampleType) || a.index - b.index);
		}
		return cols;
	});

	const activateColumn = (col: CsvColumnSummary) => {
		if (jumpToTableColumn(col.index)) return;
		const path = activePath();
		const doc = activeDoc();
		if (!path || !doc) return;
		// Fallback for raw CSV text view: reveal the column's header cell on line 1.
		const table = parseCsv(doc.model.getValue());
		const cell = table.header[col.index];
		const column = cell ? cell.start + 1 : 1;
		void openFile(path, { reveal: { line: 1, column } });
	};

	const empty = () =>
		filter()
			? `No column matches “${props.filter}”. Clear the filter to see everything.`
			: "This file has no columns yet.";

	return (
		<Show when={list().length} fallback={<p class="hint">{empty()}</p>}>
			<Rows role="listbox" label={props.label ?? "Columns in this table"}>
				<For each={list()}>
					{(col) => (
						<Row
							role="option"
							key={`csv:${col.index}`}
							title={`${col.name}: ${col.nonEmpty} of ${col.totalRows} non-empty, ${col.distinct} distinct (${col.sampleType})`}
							onActivate={() => activateColumn(col)}
						>
							<Icon name="table" class="icon" />
							<span class="label">{col.name}</span>
							<span class="meta">
								{col.nonEmpty}/{col.totalRows} · {col.distinct}
							</span>
						</Row>
					)}
				</For>
			</Rows>
		</Show>
	);
}

const planNodeIcon = (kind: string): IconName => {
	switch (kind) {
		case "start":
			return "play";
		case "end":
			return "pass";
		case "decision":
			return "question";
		case "call":
			return "symbol-method";
		default:
			return "circle-small-filled";
	}
};

/** Plan (.plan.json) outline: collapsible stages (`groups`) and their navigable steps, decisions, and calls. */
function PlanOutline(props: { filter?: string; compact?: boolean; label?: string }) {
	const filter = () => (props.filter ?? "").trim().toLowerCase();
	const toggle = (key: string) =>
		setOutlineClosed((set) => {
			const next = new Set(set);
			next.has(key) ? next.delete(key) : next.add(key);
			return next;
		});

	const nodeMatches = (n: PlanOutlineNode) =>
		!filter() || n.text.toLowerCase().includes(filter()) || n.kind.toLowerCase().includes(filter()) || (n.ref ?? "").toLowerCase().includes(filter());

	const visibleStages = createMemo(() => {
		const q = filter();
		return planStages()
			.map((stage) => {
				const stageHit = !q || stage.name.toLowerCase().includes(q);
				const nodes = stageHit ? stage.nodes : stage.nodes.filter(nodeMatches);
				const sortedNodes =
					outlineSort() === "name"
						? [...nodes].sort((a, b) => a.text.localeCompare(b.text, undefined, { numeric: true, sensitivity: "base" }))
						: outlineSort() === "kind"
							? [...nodes].sort((a, b) => a.kind.localeCompare(b.kind) || a.text.localeCompare(b.text, undefined, { numeric: true, sensitivity: "base" }))
							: nodes;
				return { ...stage, nodes: sortedNodes, matched: stageHit || sortedNodes.length > 0 };
			})
			.filter((s) => s.matched);
	});

	/** Active node matching the editor/chart cursor line when Follow cursor is on. */
	const activeNodeId = createMemo<string | null>(() => {
		if (!outlineFollow()) return null;
		const line = state.cursor.line;
		let bestId: string | null = null;
		let bestLine = 0;
		for (const st of planStages()) {
			for (const n of st.nodes) {
				if (n.line <= line && n.line >= bestLine) {
					bestLine = n.line;
					bestId = n.id;
				}
			}
		}
		return bestId;
	});

	const jumpToLine = (line: number) => {
		const path = activePath();
		if (!path) return;
		setState("cursor", { line, column: 1 });
		void openFile(path, { reveal: { line, column: 1 } });
	};

	const empty = () =>
		filter()
			? `Nothing in this plan matches “${props.filter}”. Clear the filter to see everything.`
			: "This plan has no stages or steps yet.";

	return (
		<Show when={visibleStages().length} fallback={<p class="hint">{empty()}</p>}>
			<Rows role="tree" label={props.label ?? "Outline of this plan"}>
				<For each={visibleStages()}>
					{(stage) => {
						const key = () => `plan:${stage.id}`;
						const open = () => Boolean(filter()) || !outlineClosed().has(key());
						return (
							<>
								<Row
									role="treeitem"
									key={key()}
									level={1}
									expanded={stage.nodes.length ? open() : undefined}
									style={{ "padding-left": "8px" }}
									title={`${stage.name} (${count(stage.nodes.length, "step")})`}
									onActivate={() => jumpToLine(stage.nodes[0]?.line ?? stage.line)}
									onToggle={() => toggle(key())}
								>
									<span
										class="twisty"
										aria-hidden="true"
										onClick={(e) => {
											if (!stage.nodes.length) return;
											e.stopPropagation();
											toggle(key());
										}}
									>
										<Show when={stage.nodes.length}>
											<Icon name={open() ? "chevron-down" : "chevron-right"} />
										</Show>
									</span>
									<Icon name="layers" class="icon" />
									<span class="label" style={{ "font-weight": "600" }}>
										{stage.name}
									</span>
									<span class="meta">{stage.nodes.length}</span>
								</Row>
								<Show when={stage.nodes.length && open()}>
									<div role="group">
										<For each={stage.nodes}>
											{(node) => {
												const here = () => activeNodeId() === node.id;
												return (
													<Row
														role="treeitem"
														key={`plan-node:${node.id}`}
														classList={{ here: here() }}
														level={2}
														style={{ "padding-left": "22px" }}
														title={`${node.kind}: ${node.text}${node.ref ? ` (${node.ref})` : ""} — line ${node.line}`}
														onActivate={() => jumpToLine(node.line)}
													>
														<span class="twisty" aria-hidden="true" />
														<Icon name={planNodeIcon(node.kind)} class="icon" />
														<span class="label">{node.text}</span>
														<Show when={here()}>
															<span class="here-mark" title="Selected step">
																<Icon name="arrow-left" />
																<span class="visually-hidden">Selected step</span>
															</span>
														</Show>
														<span class="meta">{node.kind}</span>
													</Row>
												);
											}}
										</For>
									</div>
								</Show>
							</>
						);
					}}
				</For>
			</Rows>
		</Show>
	);
}

/** Shared symbol tree used by both the Document outline panel and Explorer's collapsible Outline drawer. */
export function SymbolOutline(props: { filter?: string; compact?: boolean; label?: string }) {
	const path = () => activePath();
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
		const p = symbolPath(symbols(), state.cursor.line).filter((s) => !isVariable(s));
		return p[p.length - 1];
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
						const p = activePath();
						const r = rowProps.symbol.selectionRange;
						if (p) void openFile(p, { reveal: { line: r.startLineNumber, column: r.startColumn, endLine: r.endLineNumber, endColumn: r.endColumn } });
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
						fallback={<Icon name={parameter() ? "circle-small-filled" : (ICONS[rowProps.symbol.kind] ?? "circle-small-filled")} class="icon" />}
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
		if (!doc || language !== "ssl") return props.compact ? "No outline for this file." : "This kind of file has no outline: SSL, Markdown, CSV, Plan, TOML, INI, JSON, SQL and YAML files do.";
		if (serverDown()) return `${serverDown()} This file's outline comes from it.`;
		if (reading() === "failed") return `The language server could not list this file's outline: ${failure()}`;
		if (reading() !== "read") return "Reading this file's outline…";
		if (!symbols().length) return props.compact ? "No regions or procedures yet." : "This file has no regions, procedures or public variables yet.";
		return `Nothing here matches “${filter()}”. Clear the filter to see everything.`;
	};
	const top = () => sortSymbols(symbols().filter(matches), outlineSort());
	return (
		<Show
			when={!isMarkdown(path())}
			fallback={<MarkdownOutline filter={props.filter} compact={props.compact} label={props.label} />}
		>
			<Show
				when={!isActiveCsv()}
				fallback={<CsvOutline filter={props.filter} compact={props.compact} label={props.label} />}
			>
				<Show
					when={!isPlanPath(path())}
					fallback={<PlanOutline filter={props.filter} compact={props.compact} label={props.label} />}
				>
					<Show when={top().length} fallback={<p class="hint">{empty()}</p>}>
						<Rows role="tree" label={props.label ?? "Outline of this file"}>
							<For each={top()}>{(s) => <TreeRow symbol={s} depth={0} parent="" />}</For>
						</Rows>
					</Show>
				</Show>
			</Show>
		</Show>
	);
}

/** Unified Document panel (internal id "objects"): shares Info | Outline for Markdown, Outline for all other files. */
export function Objects() {
	const [filter, setFilter] = createSignal("");
	const [planTab, setPlanTab] = createSignal<"outline" | "procedures">("outline");
	const isPlan = () => isPlanPath(activePath());
	const isMd = () => isMarkdown(activePath());
	const mdTab = activeMarkdownTab;
	const showMdInfo = () => isMd() && mdTab() === "info";
	const showOutlineControls = () => !(isPlan() && planTab() === "procedures") && !showMdInfo();
	const showFilterInput = () => !showMdInfo();

	let mdInfoTabEl: HTMLButtonElement | undefined;
	let mdOutlineTabEl: HTMLButtonElement | undefined;

	// Default to Info for Markdown files with frontmatter or ticket metadata when user hasn't pinned a preference yet.
	createEffect(
		on(activePath, (p) => {
			if (!p || !isMarkdown(p) || hasSavedMarkdownTab()) return;
			const key = canonical(p);
			if (key === lastAutoDefaultMdPath) return;
			lastAutoDefaultMdPath = key;
			const d = documents.get(key);
			const hasFm = Boolean(d && !d.binary && frontMatter(d.model.getValue()).lines > 0);
			const isTicketDoc = docs().some((f) => f.group === "tickets" && f.ticket && canonical(f.path) === key);
			setActiveMarkdownTab(defaultMarkdownPanelTab(hasFm || isTicketDoc, null));
		}),
	);

	// Honor explicit tab-switch requests from the Markdown editor (Info / Links / Edit YAML).
	createEffect(
		on(markdownPanelTabRequest, (req) => {
			if (!req || req.seq <= lastHandledMdTabReqSeq) return;
			lastHandledMdTabReqSeq = req.seq;
			setActiveMarkdownTab(req.tab);
		}),
	);

	const mdBrokenCount = createMemo(() => {
		const p = activePath();
		if (!p || !isMarkdown(p)) return 0;
		const key = canonical(p);
		const summary = markdownLinksSummary();
		if (summary && summary.path === key) return summary.broken;
		return docs().find((d) => canonical(d.path) === key)?.broken?.length ?? 0;
	});

	return (
		<div class="panel-body doc-outline-panel" data-panel="objects">
			<div class="panel-title">
				<span>{isMd() ? "Document" : "Document outline"}</span>
				<Show when={showOutlineControls()}>
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
			<Show when={isMd()}>
				<div
					class="plan-palette-tabs"
					role="tablist"
					aria-label="Markdown document panel"
					onKeyDown={(e) => {
						if (e.key === "ArrowLeft" || e.key === "ArrowRight" || e.key === "Home" || e.key === "End") {
							e.preventDefault();
							const next =
								e.key === "Home"
									? "info"
									: e.key === "End"
										? "outline"
										: mdTab() === "info"
											? "outline"
											: "info";
							chooseMarkdownPanelTab(next);
							(next === "info" ? mdInfoTabEl : mdOutlineTabEl)?.focus();
						}
					}}
				>
					<button
						ref={mdInfoTabEl}
						type="button"
						role="tab"
						aria-selected={mdTab() === "info"}
						classList={{ on: mdTab() === "info" }}
						onClick={() => chooseMarkdownPanelTab("info")}
					>
						<span>Info</span>
						<Show when={mdBrokenCount() > 0}>
							<span
								class="md-tab-warn-dot"
								title={`${mdBrokenCount()} broken outgoing ${mdBrokenCount() === 1 ? "link" : "links"}`}
								aria-label={`${mdBrokenCount()} broken links`}
							/>
						</Show>
					</button>
					<button
						ref={mdOutlineTabEl}
						type="button"
						role="tab"
						aria-selected={mdTab() === "outline"}
						classList={{ on: mdTab() === "outline" }}
						onClick={() => chooseMarkdownPanelTab("outline")}
					>
						Outline
					</button>
				</div>
			</Show>
			<Show when={isPlan()}>
				<div
					class="mode-switch"
					role="tablist"
					aria-label="Plan outline mode"
					style={{ margin: "0 var(--space-4) var(--space-2)" }}
				>
					<button
						type="button"
						role="tab"
						aria-selected={planTab() === "outline"}
						classList={{ on: planTab() === "outline" }}
						onClick={() => setPlanTab("outline")}
					>
						Plan Outline
					</button>
					<button
						type="button"
						role="tab"
						aria-selected={planTab() === "procedures"}
						classList={{ on: planTab() === "procedures" }}
						onClick={() => setPlanTab("procedures")}
					>
						SSL Procedures
					</button>
				</div>
			</Show>
			<Show when={showFilterInput()}>
				<input
					class="filter"
					data-autofocus=""
					aria-label={isPlan() && planTab() === "procedures" ? "Filter the workspace's procedures" : "Filter this document's outline"}
					placeholder="Filter"
					value={filter()}
					onInput={(e) => setFilter(e.currentTarget.value)}
					onKeyDown={(e) => e.key === "ArrowDown" && focusRowsBelow(e.currentTarget) && e.preventDefault()}
				/>
			</Show>
			<Show
				when={showMdInfo()}
				fallback={
					<Show
						when={isPlan() && planTab() === "procedures"}
						fallback={<SymbolOutline filter={filter()} />}
					>
						<Procedures filter={filter()} />
					</Show>
				}
			>
				<MarkdownInspector />
			</Show>
		</div>
	);
}
