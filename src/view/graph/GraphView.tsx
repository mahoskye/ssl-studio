// Graph mode: scripts as boxes, regions inside them, procedures as nodes,
// calls as edges, laid out by ELK. A large workspace opens with its scripts
// folded, each one node, and a script unfolds to its procedures. Pointing at a
// node, or moving to it with the keys, lights its calls and dims the rest.
// Click a procedure, or press F on it, to focus its neighbourhood;
// double-click it, or press Enter, to open it. The same calls can be read as
// a plain list.
import { docs } from "../project";
import { codeMatchesRef, docsGoverningFile, scriptsForTicket } from "../../shared/workContext";
import { referencedSchemaTables } from "../../shared/schemaIndex";
import { registryTitle, toneOf } from "../../shared/projectDocs";
import type { DocFile } from "../../shared/protocol";
import "./graphExtra.css";
import { Icon } from "../Icon";
import { ICON } from "../icons";
import { CenterTabStrip } from "../editor/CenterTabStrip";
import { quickPick, type QuickPickOption } from "../dialogs";
import { findMatchingPlanNodeLine } from "../plan/assist";
import { isPlanPath } from "../plan/model";
import ELK from "elkjs/lib/elk.bundled.js";
import { createEffect, createMemo, createSignal, createUniqueId, flush, For, onCleanup, Show, untrack } from "solid-js";
import { level } from "../../shared/houseStyle";
import { backend } from "../backend";
import { regionColor } from "../editor/regions";
import { canonical, documents, notify, openFile, openToSide, restartLsp, setState, state } from "../state";
import { canvasMeasure, clearLabels, clearOf, fitShare, fitView, legibleScale, mapArea, outOfSight, nearest, recall, remember, reveal, smoothEdgePath, smoothEdgePoint, zoomAt, type Point } from "./canvas";
import { loadGraph } from "./load";
import { Minimap, type MapBox } from "./Minimap";
import { Finder } from "./Finder";
import { Menu, type MenuItem } from "../Menu";
import { savePicture } from "./picture";
import { registerGraphBridge } from "./graphBridge";
import { session } from "../lsp/session";
import { aroundFocus, callList, choices, computeImpactAnalysis, formatImpactMarkdown, sameStep, dirId, keptFolds, withoutUnresolved, fold, gather, isFolderEnd, FOLD_ABOVE, FOLD_DIRS_ABOVE, foldId, isDir, isFold, RELATION_WORDS, scriptOf, ticketSubgraphFilter, topLabel, UNRESOLVED, visible, type Direction, type DrawnEdge, type Filter, type FocusLink, type Graph, type ImpactDocSummary, type ImpactNode, type ImpactReport, type ListedProc, relationOf, type Relation } from "./model";
import { baseName, dirName, isInside, joinPath, relativeTo } from "../../shared/paths";
import { submenuOrInline, type RowMenuEntry } from "../../shared/contextMenu";

type Box = {
	id: string;
	x: number;
	y: number;
	width: number;
	height: number;
	label: string;
	/** "fold" is a script drawn as one node, its procedures folded away. */
	/** "dir" is a folder drawn as one node, its scripts folded away. */
	kind: "folder" | "script" | "region" | "proc" | "top" | "fold" | "dir";
	/** The folder a folder's frame or node stands for. */
	folder?: string;
	path?: string;
	line?: number;
	region?: string;
	bytes?: number;
	nodeKind?: string;
	isClass?: boolean;
	/** A folded script's second line: what is inside it. */
	note?: string;
};
type Line = { id: string; d: string; from: string; to: string; cross: boolean; count: number; relation: Relation; title: string; /** The nodes a line gathered at a folder's edge stands for, at each end. */ froms?: string[]; tos?: string[]; /** Where the number of places is written, when it is more than one. */ badge?: { x: number; y: number; width: number; height: number } };
type Mode = "graph" | "list";

const elk = new ELK();
// The size the style sheet gives the graph's words (.graph-canvas text), and a script's name in bold.
const FONT_PX = 13;
const measure = canvasMeasure(`${FONT_PX}px system-ui, sans-serif`, FONT_PX);
const measureBold = canvasMeasure(`600 ${FONT_PX}px system-ui, sans-serif`, FONT_PX);
const textWidth = (s: string) => Math.max(60, Math.ceil(measure(s)) + 24);
/** Fit never draws the words smaller than can be read; a larger graph is panned. */
const FIT_FLOOR = legibleScale(FONT_PX);
const MIN_ZOOM = 0.05;
/** Zoomed out past this, a procedure's name cannot be read: the picture is of scripts and folders, named at a size that can. */
const FAR_UNDER = 0.6;
/** The size, on screen, of a name in that far picture. */
const FAR_NAME_PX = 11;
/** Added to a folder's weight there: a folder is named before any script, and a larger folder before a smaller. */
const FOLDER_FIRST = 1e15;
const MAX_ZOOM = 3;
const MODE_KEY = "graph.view";
const FOLDS_KEY = "graph.folds";
const UNRESOLVED_KEY = "graph.unresolved";
const GATHER_KEY = "graph.gather";
/** A folded script's node: room for its name and, under it, what is inside. */
const FOLD_HEIGHT = 46;
/** A line's width for the number of places it stands for: each doubling adds the same, up to a limit that stays a line. */
const lineWidth = (count: number) => Math.min(3.4, 1 + Math.log2(Math.max(1, count)) * 0.6);
/** The graph's keys and what the pointer does, as its menu lists them. */
const GRAPH_KEYS: readonly (readonly [keys: string, what: string])[] = [
	["Arrow keys", "Move between nodes; the calls of the one you are on are lit"],
	["Enter", "Open a procedure; unfold a folded script or folder"],
	["F", "Show only the node's callers and callees"],
	["X", "Fold a script to one node, or unfold it"],
	["Shift+X", "Fold the script's folder to one node, or unfold it"],
	["Shift+F10", "Open the node's menu (script, focus, governing docs)"],
	["+, −, 0", "Zoom in, zoom out, fit; 0 again shows the whole picture"],
	["?", "Show or hide this list"],
	["Pointer", "Point at a node or a line to light it; click a node to focus on it, double-click to open it; drag to move, the wheel zooms. Far out, a click comes in on that script or folder"],
];
/** A picture of up to this many nodes is laid out both across and down, to keep the one that fits the view better. */
const BOTH_WAYS_UP_TO = 250;
/** This many scripts of one folder with no line between them, and they are set out as a block, not in one line. */
const BLOCK_FROM = 6;
/** A graph narrower than this keeps its zoom buttons in the menu: in the bar they cost it a second row. */
const NARROW_UNDER = 740;
/** How far along a line its number of places is written. */
const BADGE_AT = 30;
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

const KIND_WORDS: Record<string, string> = { procedure: "procedure", datasource: "data source", unresolved: "a target the language server could not resolve", top: "code outside any procedure", class: "the class itself" };

const [ticketHighlightKey, setTicketHighlightKeySignal] = createSignal<string | null>(null);
const [ticketHighlightCount, setTicketHighlightCount] = createSignal(0);
const [ticketSubgraphOnly, setTicketSubgraphOnlySignal] = createSignal(false);
const [ticketImpactRequest, setTicketImpactRequest] = createSignal<{ key?: string; seq: number } | null>(null);
let ticketImpactSeq = 0;
const [graphFocusRequest, setGraphFocusRequest] = createSignal<{ scriptPath: string; procName?: string; seq: number } | null>(null);
let graphFocusSeq = 0;
let activeGraphFinderFocus: (() => void) | null = null;

/** Switches center view to Call Graph and focuses the matching script or procedure node once loaded. */
export function openGraphFocusedOn(scriptPath: string, procName?: string): void {
	const cleaned = scriptPath.trim();
	if (!cleaned) return;
	setGraphFocusRequest({ scriptPath: cleaned, procName: procName?.trim() || undefined, seq: ++graphFocusSeq });
	setState((s) => {
		s.centerView = "graph";
	});
}

/** Focuses the active Call Graph Finder input (returns false when Call Graph is not active or has no Finder). */
export function focusActiveGraphFinder(): boolean {
	if (state.centerView !== "graph" || !activeGraphFinderFocus) return false;
	activeGraphFinderFocus();
	return true;
}

/** Currently highlighted ticket key in Call Graph (shared with Palette's Ticket overlay). */
export const graphTicketHighlight = ticketHighlightKey;
/** Number of Call Graph scripts matched by the current ticket highlight. */
export const graphHighlightedCount = ticketHighlightCount;
/** Whether Call Graph is filtered to the highlighted ticket's scripts + 1-hop callers/callees. */
export const graphTicketSubgraph = ticketSubgraphOnly;
/** Sets or clears the Call Graph ticket overlay highlight. */
export function setGraphTicketHighlight(key: string | null) {
	const next = key?.trim() || null;
	setTicketHighlightKeySignal(next);
	if (!next) setTicketSubgraphOnlySignal(false);
}
/** Toggles isolating Call Graph to the ticket's architectural slice (+ 1-hop neighbors). */
export function setGraphTicketSubgraph(on: boolean) {
	if (on && !ticketHighlightKey()) {
		const active = state.settings.activeTicket?.trim() || "";
		if (active) setTicketHighlightKeySignal(active);
	}
	setTicketSubgraphOnlySignal(on);
}
/** Requests a ticket-wide Impact / Blast-Radius Analysis from Palette or external controls. */
export function requestGraphTicketImpact(key?: string) {
	setTicketImpactRequest({ key: key?.trim() || undefined, seq: ++ticketImpactSeq });
}
/** Resets module-level Call Graph highlight and pending navigation requests (e.g. on workspace switch). */
export function resetGraphState(): void {
	setTicketHighlightKeySignal(null);
	setTicketHighlightCount(0);
	setTicketSubgraphOnlySignal(false);
	setGraphFocusRequest(null);
	setTicketImpactRequest(null);
}

export function GraphView() {
	const [graph, setGraph] = createSignal<(Graph & { truncated: boolean }) | null>(null);
	const [progress, setProgress] = createSignal("");
	const [failed, setFailed] = createSignal("");
	const [filter, setFilter] = createSignal<Filter>({ mode: "all", depth: 1 });
	const [depthDraft, setDepthDraft] = createSignal(String(untrack(filter).depth));
	createEffect(
		() => filter().depth,
		(d) => {
			setDepthDraft(String(d));
		},
	);
	const [layout, setLayout] = createSignal<{ boxes: Box[]; lines: Line[]; width: number; height: number; key: string } | null>(null);
	const [view, setView] = createSignal({ x: 20, y: 20, scale: 1 });
	const [mode, setMode] = createSignal<Mode>(recall(MODE_KEY) === "list" ? "list" : "graph");
	/** The node the keyboard is on: the one Tab lands on, and the arrow keys move from. */
	const [current, setCurrent] = createSignal<string | null>(null);
	const rel = (path: string) => relativeTo(state.workspace?.root, path);
	const nodeEls = new Map<string, SVGGElement>();
	let svg: SVGSVGElement | undefined;
	let fittedFor = "";
	let layoutRun = 0;
	/** The view as the last fit left it: while it is still that, a change of the graph's size fits it again. */
	let fittedView: { x: number; y: number; scale: number } | null = null;
	/** Whether that fit was of the whole picture, however small, and not of as much as stays legible. */
	let fittedWhole = false;
	/** The scripts drawn as one node each, by path. */
	const [folded, setFolded] = createSignal<ReadonlySet<string>>(new Set());
	/** The folders drawn as one node each. */
	const [foldedDirs, setFoldedDirs] = createSignal<ReadonlySet<string>>(new Set());
	/** The folder a script is in, as the workspace has it; none for the box of unresolved targets. */
	const folderOf = (path: string) => (path === UNRESOLVED ? "" : dirName(rel(path)));
	const foldersOf = (g: Graph) => new Set(g.scripts.map((s) => folderOf(s.path)).filter(Boolean));
	/** The workspace whose opening picture has been chosen: a refresh keeps what the user folded since. */
	let foldedFor = "";
	/** The node the pointer is on, the node the keys last moved to, and the line the pointer is on. */
	const [pointed, setPointed] = createSignal<string | null>(null);
	const [walked, setWalked] = createSignal<string | null>(null);
	const [pointedLine, setPointedLine] = createSignal<string | null>(null);
	/** What the finder offers. */
	const findable = createMemo(() => (graph() ? choices(graph()!, rel) : []));
	// One change, so one picture is laid out: not the old one in the graph and then the new.
	const find = (id: string) => {
		setCurrent(id);
		setMode("graph");
		focus(id);
	};
	/** Whether the list of the graph's keys or the shape/edge legend popover is showing. */
	const [keysOpen, setKeysOpen] = createSignal(false);
	const [legendOpen, setLegendOpen] = createSignal(false);
	const [impactOpen, setImpactOpen] = createSignal(false);
	const [impactHops, setImpactHops] = createSignal(4);
	const [hopsDraft, setHopsDraft] = createSignal(String(untrack(impactHops)));
	createEffect(
		() => impactHops(),
		(h) => {
			setHopsDraft(String(h));
		},
	);
	const [impactSeeds, setImpactSeeds] = createSignal<{ ids: string[]; label: string; ticketKey?: string } | null>(null);
	const [impactReport, setImpactReport] = createSignal<ImpactReport | null>(null);
	const [impactScanning, setImpactScanning] = createSignal(false);
	let impactRunSeq = 0;
	let focusFinder: (() => void) | undefined;
	const [schemaTablesByScript, setSchemaTablesByScript] = createSignal<Map<string, DocFile[]>>(new Map());
	let schemaScanSeq = 0;

	const isGraphView = createMemo(() => state.centerView === "graph");
	createEffect(
		() => isGraphView(),
		(active) => {
			if (!active) return;
			const fn = () => focusFinder?.();
			activeGraphFinderFocus = fn;
			const onWindowKey = (e: KeyboardEvent) => {
				if (!(e.ctrlKey || e.metaKey) || e.shiftKey || e.altKey || e.key.toLowerCase() !== "f") return;
				if (document.querySelector(".overlay")) return;
				const target = e.target as HTMLElement | null;
				if (target?.closest(".sidebar, .right-panel, .bottom-panel") && target.matches("input, textarea, [contenteditable]")) return;
				if (!focusFinder) return;
				e.preventDefault();
				e.stopPropagation();
				focusFinder();
			};
			window.addEventListener("keydown", onWindowKey, true);
			return () => {
				window.removeEventListener("keydown", onWindowKey, true);
				if (activeGraphFinderFocus === fn) activeGraphFinderFocus = null;
			};
		},
	);

	const readScriptText = async (filePath: string): Promise<string> => {
		const openText = documents.get(canonical(filePath))?.model.getValue();
		if (openText !== undefined) return openText;
		return backend.read(filePath).then(
			(f) => f.text,
			() => "",
		);
	};

	const schemaTablesForScript = async (filePath: string): Promise<DocFile[]> => {
		const cached = schemaTablesByScript().get(filePath);
		if (cached) return cached;
		const allDocs = docs();
		if (!allDocs.some((d) => d.exists && d.group === "schema")) return [];
		const text = await readScriptText(filePath);
		if (!text) return [];
		const matched = referencedSchemaTables(text, allDocs, 16);
		if (matched.length) {
			setSchemaTablesByScript((prev) => {
				const next = new Map(prev);
				next.set(filePath, matched);
				return next;
			});
		}
		return matched;
	};

	createEffect(
		() => [graph(), docs()] as const,
		([g, allDocs]) => {
			if (!g || !allDocs.some((d) => d.exists && d.group === "schema")) {
				setSchemaTablesByScript(new Map());
				return;
			}
			const run = ++schemaScanSeq;
			const scripts = g.scripts.filter((s) => s.path && s.path !== UNRESOLVED).slice(0, 60);
			void (async () => {
				const map = new Map<string, DocFile[]>();
				for (const s of scripts) {
					if (run !== schemaScanSeq) return;
					const text = await readScriptText(s.path);
					if (!text) continue;
					const matched = referencedSchemaTables(text, allDocs, 12);
					if (matched.length) map.set(s.path, matched);
				}
				if (run === schemaScanSeq) setSchemaTablesByScript(map);
			})();
			return () => {
				schemaScanSeq++;
			};
		},
	);

	const pickTicketQuickPick = async (title: string, placeholder = "Filter tickets by key, title, or status…"): Promise<DocFile | null> => {
		const tickets = docs()
			.filter((d) => d.exists && d.group === "tickets" && d.ticket)
			.sort((a, b) => a.ticket!.localeCompare(b.ticket!, undefined, { numeric: true, sensitivity: "base" }));
		if (!tickets.length) return null;
		const items: QuickPickOption<DocFile>[] = tickets.map((t) => {
			const key = t.ticket!;
			const titleText = t.title && !t.title.toLowerCase().startsWith(key.toLowerCase()) ? t.title : "";
			return {
				value: t,
				label: titleText ? `${key}: ${titleText}` : key,
				icon: "tag",
				badge: t.status ? { text: t.status, tone: toneOf(t.status) } : undefined,
				detail: rel(t.path).replace(/\\/g, "/"),
				keywords: [key, t.title ?? "", t.status ?? ""].filter(Boolean).join(" "),
			};
		});
		return quickPick<DocFile>({ title, placeholder, items });
	};

	const openGoverningDoc = async (docPath: string, scriptPath?: string, procName?: string, explicitLine?: number) => {
		if (isPlanPath(docPath) && scriptPath) {
			const planText = await readScriptText(docPath);
			const nodeLine = planText ? findMatchingPlanNodeLine(planText, scriptPath, procName, state.workspace?.root) : null;
			if (nodeLine) {
				await openFile(docPath, { reveal: { line: nodeLine, column: 1 } });
				return;
			}
		}
		await openFile(docPath, explicitLine ? { reveal: { line: explicitLine } } : {});
	};

	let handledFocusReq = 0;
	createEffect(
		() => [graphFocusRequest(), graph()] as const,
		([req, g]) => {
			if (!req || !g || req.seq === handledFocusReq) return;
			handledFocusReq = req.seq;
			setGraphFocusRequest(null);
			untrack(() => {
				const targetCanon = canonical(req.scriptPath);
				const root = state.workspace?.root;
				const reqRel = root ? relativeTo(root, req.scriptPath).replace(/\\/g, "/").toLowerCase() : req.scriptPath.replace(/\\/g, "/").toLowerCase();
				const matchedScript = g.scripts.find((s) => {
					if (s.path === UNRESOLVED) return false;
					if (canonical(s.path) === targetCanon) return true;
					const sRel = rel(s.path).replace(/\\/g, "/").toLowerCase();
					return sRel === reqRel || sRel.endsWith(`/${reqRel}`);
				});
				if (!matchedScript) {
					notify(`Could not find ${baseName(req.scriptPath)} in the Call Graph yet.`);
					return;
				}
				let targetId = `${matchedScript.path}#`;
				if (req.procName) {
					const want = req.procName.toLowerCase();
					const matchedNode = g.nodes.find((n) => n.path === matchedScript.path && n.name.toLowerCase() === want);
					if (matchedNode) targetId = matchedNode.id;
				}
				setMode("graph");
				setCurrent(targetId);
				focus(targetId);
			});
		},
	);

	const workspaceRoot = createMemo(() => state.workspace?.root);
	createEffect(
		() => workspaceRoot(),
		() => {
			setGraphTicketHighlight(null);
			setImpactOpen(false);
			setImpactReport(null);
			setImpactSeeds(null);
		},
		{ defer: true },
	);
	const activeTicketKey = createMemo(() => state.settings.activeTicket?.trim() || "");
	createEffect(
		() => activeTicketKey(),
		(next, prev) => {
			const cur = untrack(ticketHighlightKey)?.trim() || "";
			if (!cur) return;
			if (prev && cur.toLowerCase() === prev.toLowerCase()) {
				setGraphTicketHighlight(next || null);
			}
		},
		{ defer: true },
	);
	const highlightedTicketPaths = createMemo(() => {
		const key = ticketHighlightKey()?.trim() || "";
		if (!key) return new Set<string>();
		const allDocs = docs();
		const refs = scriptsForTicket(allDocs, key, { includeDescendants: true });
		const root = state.workspace?.root;
		const matched = new Set<string>();
		for (const s of graph()?.scripts ?? []) {
			if (refs.some((r) => codeMatchesRef(s.path, r, root))) matched.add(s.path);
		}
		return matched;
	});
	const highlightedTicketFolders = createMemo(() => {
		const folders = new Set<string>();
		for (const path of highlightedTicketPaths()) {
			const folder = folderOf(path);
			if (folder) folders.add(folder);
		}
		return folders;
	});
	createEffect(
		() => highlightedTicketPaths().size,
		(count) => {
			setTicketHighlightCount(count);
		},
	);
	createEffect(
		() => [ticketSubgraphOnly(), ticketHighlightKey()] as const,
		([subOn]) => {
			fittedFor = "";
			if (subOn) {
				setFilter((f) => (f.mode === "around" ? { ...f, mode: "all" } : f));
			}
		},
		{ defer: true },
	);
	const isGraphMode = createMemo(() => mode() === "graph");
	createEffect(
		() => isGraphMode(),
		(inGraph) => {
			if (!inGraph) nodeEls.clear();
		},
	);
	const keysId = createUniqueId();
	const legendId = createUniqueId();
	const toggleKeys = () => {
		const next = !keysOpen();
		setKeysOpen(next);
		if (next) {
			setLegendOpen(false);
			setImpactOpen(false);
		}
	};
	const toggleLegend = () => {
		const next = !legendOpen();
		setLegendOpen(next);
		if (next) {
			setKeysOpen(false);
			setImpactOpen(false);
		}
	};

	/** Governing docs per script path, computed in both Canvas and List modes. */
	const governingDocsByScript = createMemo(() => {
		const map = new Map<string, ReturnType<typeof docsGoverningFile>>();
		const allDocs = docs();
		if (!allDocs.length) return map;
		const root = state.workspace?.root;
		for (const s of graph()?.scripts ?? []) {
			if (!s.path || s.path === UNRESOLVED) continue;
			const gov = docsGoverningFile(allDocs, s.path, root);
			if (gov.length) map.set(s.path, gov);
		}
		return map;
	});

	const runImpactAnalysis = (seedIds: string[], label: string, opts?: { ticketKey?: string; hops?: number }) => {
		const g = graph();
		if (!g || !seedIds.length) {
			notify("No call graph nodes available for impact analysis.");
			return;
		}
		const hops = opts?.hops ?? impactHops();
		const run = ++impactRunSeq;
		setImpactSeeds({ ids: seedIds, label, ticketKey: opts?.ticketKey });
		setImpactOpen(true);
		setKeysOpen(false);
		setLegendOpen(false);

		const base = computeImpactAnalysis(g, seedIds, hops);
		const allDocs = docs();
		const root = state.workspace?.root;

		// Aggregate governing docs across seed scripts first, then transitively affected scripts.
		const govMap = new Map<string, ImpactDocSummary>();
		const testScriptSet = new Set<string>();
		const orderedScripts = [...new Set([...base.seedScripts, ...base.affectedScripts])];
		for (const scriptPath of orderedScripts) {
			const gov = docsGoverningFile(allDocs, scriptPath, root);
			for (const entry of gov) {
				const key = canonical(entry.file.path);
				if (!govMap.has(key)) {
					const docLabel =
						entry.file.group === "registries"
							? registryTitle(entry.file.name)
							: entry.file.ticket && entry.file.title && !entry.file.title.toLowerCase().startsWith(entry.file.ticket.toLowerCase())
								? `${entry.file.ticket}: ${entry.file.title}`
								: entry.file.title || entry.file.heading || entry.file.name;
					govMap.set(key, {
						label: docLabel,
						group: entry.file.group,
						path: entry.file.path,
						reason: entry.reason,
						ticket: entry.file.ticket,
					});
				}
				for (const ts of entry.file.testScripts ?? []) {
					if (ts.trim()) testScriptSet.add(ts.trim());
				}
			}
		}

		// Also include any workspace test scripts in the call graph that directly call a seed script.
		const testFolder = (state.project?.tests || "tests").replace(/\\/g, "/").replace(/^\/+|\/+$/g, "").toLowerCase();
		for (const caller of base.upstream) {
			const relPath = rel(caller.path).replace(/\\/g, "/");
			if (testFolder && relPath.toLowerCase().startsWith(`${testFolder}/`)) {
				testScriptSet.add(relPath);
			}
		}

		const initialReport: ImpactReport = {
			...base,
			targetLabel: label,
			governingDocs: [...govMap.values()],
			testScripts: [...testScriptSet].sort((a, b) => a.localeCompare(b)),
			schemaTables: [],
		};
		setImpactReport(initialReport);

		// Async schema table scan across seed scripts, downstream SSL scripts, and `.ds` data sources.
		const scanFiles = [...new Set([...base.seedScripts, ...base.dataSources.map((d) => d.path), ...base.downstream.map((d) => d.path)])]
			.filter((p) => p && p !== UNRESOLVED)
			.slice(0, 24);
		if (!scanFiles.length || !allDocs.length) {
			setImpactScanning(false);
			return;
		}
		setImpactScanning(true);
		void (async () => {
			const chunks: string[] = [];
			for (const filePath of scanFiles) {
				if (run !== impactRunSeq) return;
				const openText = documents.get(canonical(filePath))?.model.getValue();
				if (openText !== undefined) {
					chunks.push(openText);
					continue;
				}
				const disk = await backend.read(filePath).then(
					(f) => f.text,
					() => "",
				);
				if (disk) chunks.push(disk);
			}
			if (run !== impactRunSeq) return;
			const tables = referencedSchemaTables(chunks.join("\n"), allDocs, 16).map((d) => ({
				name: d.title || baseName(d.path).replace(/\.[^.]+$/, ""),
				path: d.path,
			}));
			setImpactReport((prev) => (prev ? { ...prev, schemaTables: tables } : prev));
			setImpactScanning(false);
		})();
	};

	const runTicketImpactAnalysis = async (explicitKey?: string) => {
		const g = graph();
		if (!g) {
			notify("Build the call graph first.");
			return;
		}
		let key = explicitKey?.trim() || ticketHighlightKey()?.trim() || state.settings.activeTicket?.trim() || "";
		if (!key) {
			const hasTickets = docs().some((d) => d.exists && d.group === "tickets" && d.ticket);
			if (hasTickets) {
				const picked = await pickTicketQuickPick("Run Impact / Blast-Radius Analysis for ticket");
				if (!picked?.ticket) return;
				key = picked.ticket;
			} else if (filter().focus) {
				const focusId = filter().focus!;
				runImpactAnalysis([focusId], focusName() || focusId);
				return;
			}
		}
		if (!key) {
			notify("No active ticket or focused procedure to analyze.");
			return;
		}
		const refs = scriptsForTicket(docs(), key, { includeDescendants: true });
		const root = state.workspace?.root;
		const matches = g.scripts.filter((s) => refs.some((r) => codeMatchesRef(s.path, r, root)));
		if (!matches.length) {
			notify(`No Call Graph scripts matched ${key} yet.`);
			return;
		}
		runImpactAnalysis(
			matches.map((s) => `${s.path}#`),
			`${key} (${matches.length} ${matches.length === 1 ? "script" : "scripts"})`,
			{ ticketKey: key },
		);
	};

	let handledImpactReq = 0;
	createEffect(
		() => ticketImpactRequest(),
		(req) => {
			if (!req || req.seq === handledImpactReq) return;
			handledImpactReq = req.seq;
			setTicketImpactRequest(null);
			untrack(() => {
				void runTicketImpactAnalysis(req.key);
			});
		},
	);

	const copyImpactMarkdown = async () => {
		const report = impactReport();
		if (!report) return;
		const md = formatImpactMarkdown(report);
		const copied = (await backend.clipboard(md).catch(() => false)) || (await navigator.clipboard?.writeText(md).then(() => true, () => false));
		notify(copied ? "Copied Impact Analysis Markdown." : "Could not reach the clipboard.", copied ? "info" : "error");
	};

	const appendImpactToTicket = async () => {
		const report = impactReport();
		if (!report) return;
		let key = impactSeeds()?.ticketKey?.trim() || state.settings.activeTicket?.trim() || ticketHighlightKey()?.trim() || "";
		if (!key) {
			const hasTickets = docs().some((d) => d.exists && d.group === "tickets" && d.ticket);
			if (!hasTickets) {
				notify("No tickets found in docs/tickets/ to append to.");
				return;
			}
			const picked = await pickTicketQuickPick("Append Impact Analysis to ticket");
			if (!picked?.ticket) return;
			key = picked.ticket;
		}
		if (!key) return;
		const { appendNoteToTicket } = await import("../projectDocs");
		await appendNoteToTicket(key, formatImpactMarkdown(report));
	};

	const toggleTicketSubgraph = () => {
		const next = !ticketSubgraphOnly();
		if (next) {
			const key = ticketHighlightKey()?.trim() || state.settings.activeTicket?.trim() || "";
			if (!key) {
				notify("Highlight or activate a ticket first to filter the graph.");
				return;
			}
			if (!ticketHighlightKey()) setGraphTicketHighlight(key);
		}
		setGraphTicketSubgraph(next);
	};
	/** A script to bring into sight once the picture is laid out again: the one just folded or unfolded. */
	let showNext: string | null = null;

	let refreshSeq = 0;
	let refreshAbort: AbortController | null = null;
	onCleanup(() => {
		refreshSeq++;
		refreshAbort?.abort();
		refreshAbort = null;
		schemaScanSeq++;
		impactRunSeq++;
		layoutRun++;
		nodeEls.clear();
		setTicketHighlightCount(0);
	});

	const refresh = async (startRoot = state.workspace?.root ?? "") => {
		const run = ++refreshSeq;
		refreshAbort?.abort();
		const controller = new AbortController();
		refreshAbort = controller;
		setProgress("Reading the workspace…");
		setFailed("");
		try {
			const read = await loadGraph(
				(done, total) => {
					if (run === refreshSeq && !controller.signal.aborted) {
						setProgress(`Finding calls: ${done} of ${total} procedures`);
					}
				},
				controller.signal,
			);
			if (run !== refreshSeq || controller.signal.aborted || (state.workspace?.root ?? "") !== startRoot) return;
			// The first picture of a large workspace is of its scripts: every one folded.
			if (foldedFor !== startRoot) {
				const kept = keptFolds(recall(`${FOLDS_KEY}:${startRoot}`));
				// What was folded here last time, if anything was kept; otherwise the opening picture.
				setFolded(new Set(kept?.scripts ?? (read.nodes.length > FOLD_ABOVE ? read.scripts.map((s) => s.path) : [])));
				// And of a workspace of many scripts, its folders: a picture that fits a screen, to unfold from.
				const folders = foldersOf(read);
				setFoldedDirs(new Set(kept?.folders ?? (read.scripts.length > FOLD_DIRS_ABOVE && folders.size > 1 ? folders : [])));
			}
			foldedFor = startRoot;
			setGraph(read);
		} catch (e: any) {
			if (run !== refreshSeq || controller.signal.aborted || (state.workspace?.root ?? "") !== startRoot) return;
			setFailed(`Could not read the calls from the language server: ${e?.message ?? e}`);
		} finally {
			if (refreshAbort === controller) refreshAbort = null;
			if (run === refreshSeq && !controller.signal.aborted) setProgress("");
		}
	};
	const rootAndLsp = createMemo(() => [state.workspace?.root ?? "", state.lsp.state] as const, {
		equals: (a, b) => a[0] === b[0] && a[1] === b[1],
	});
	createEffect(
		() => rootAndLsp(),
		([root, lsp]) => {
			if (root && lsp === "running") {
				void refresh(root);
			} else {
				refreshSeq++;
				refreshAbort?.abort();
				refreshAbort = null;
				setProgress("");
			}
		},
	);

	/** Whether the targets the server could not resolve are drawn: a choice the view remembers. */
	const [unresolved, setUnresolved] = createSignal(recall(UNRESOLVED_KEY) !== "hidden");
	/** Whether calls into and out of an open folder are gathered at its edge: a choice the view remembers. */
	const [gathered, setGathered] = createSignal(recall(GATHER_KEY) !== "spread");
	const unresolvedCount = () => graph()?.nodes.filter((n) => n.kind === "unresolved").length ?? 0;
	const shown = createMemo(() => {
		const g = graph();
		if (!g) return null;
		let keep = visible(g, filter());
		if (ticketSubgraphOnly() && highlightedTicketPaths().size > 0 && filter().mode !== "around") {
			const subIds = ticketSubgraphFilter(g, highlightedTicketPaths(), true);
			const nodes = new Set([...keep.nodes].filter((id) => subIds.has(id)));
			const edges = keep.edges.filter((e) => nodes.has(e.from) && nodes.has(e.to));
			keep = { nodes, edges };
		}
		return unresolved() ? keep : withoutUnresolved(g, keep);
	});
	// What is folded is kept with the workspace, so the graph opens next time as it was left.
	createEffect(
		() => [state.workspace?.root ?? "", [...folded()], [...foldedDirs()]] as const,
		([root, scripts, folders]) => {
			const kept = JSON.stringify({ scripts, folders });
			if (root && foldedFor === root) remember(`${FOLDS_KEY}:${root}`, kept);
		},
	);
	/** What is drawn of it: around a focus (or a small ticket slice) the neighbourhood is shown procedure by procedure. */
	const drawn = createMemo(() => {
		const keep = shown();
		if (!keep) return null;
		const smallTicketSlice = ticketSubgraphOnly() && highlightedTicketPaths().size > 0 && keep.nodes.size <= FOLD_ABOVE;
		return filter().mode === "around" || smallTicketSlice ? fold(keep, new Set()) : fold(keep, folded(), { folded: foldedDirs(), of: folderOf });
	});
	const sizeNote = (bytes: number, byteLimit = state.settings.limits.bytes) => {
		// A size that is not known (a data source's file, the box of unresolved targets) is not written as 0.
		if (!bytes) return "";
		const at = level(bytes, byteLimit);
		return `${(bytes / 1024).toFixed(1)} KB${at === "over" ? " (over the limit)" : at === "near" ? " (near the limit)" : ""}`;
	};

	/** What a folded script holds, for the line under its name. */
	const foldNote = (g: Graph, path: string, inside: { procedures: number; calls: number } | undefined) => {
		const nodes = g.nodes.filter((n) => n.path === path);
		if (path === UNRESOLVED) return plural(nodes.length, "target not resolved", "targets not resolved");
		if (nodes.length && nodes.every((n) => n.kind === "datasource")) return "data source";
		const procedures = plural(inside?.procedures ?? 0, "procedure");
		return inside?.calls ? `${procedures}, ${plural(inside.calls, "call")} inside` : procedures;
	};
	/** A node's name in a sentence about a line: a procedure by its name, a script by its path. */
	const nameOf = (g: Graph, id: string, relFn = rel) => {
		if (isDir(id)) return id.slice(4);
		if (isFolderEnd(id)) return id.slice(7);
		if (isFold(id)) return scriptOf(id) === UNRESOLVED ? "a target that did not resolve" : relFn(scriptOf(id));
		const node = g.nodes.find((n) => n.id === id);
		if (node) return node.name;
		const script = g.scripts.find((s) => s.path === scriptOf(id));
		return `${topLabel(script)} of ${relFn(scriptOf(id))}`;
	};

	/** A line in words. A gathered line says how many of the folder it stands for. */
	const lineWords = (g: Graph, e: DrawnEdge, words: string, relFn = rel) => {
		const some = (ids: string[], folder: string) => `${ids.length} in ${folder.slice(7)}`;
		if (e.froms && e.tos) return `${some(e.froms, e.from)}: each ${words} several of ${some(e.tos, e.to)}`;
		if (e.tos) return `${nameOf(g, e.from, relFn)} ${words} ${some(e.tos, e.to)}`;
		if (e.froms) return `${some(e.froms, e.from)}: each ${words} ${nameOf(g, e.to, relFn)}`;
		return `${nameOf(g, e.from, relFn)} ${words} ${nameOf(g, e.to, relFn)}`;
	};

	/** Whether scripts can be folded now: around a focus (or a small ticket slice) they are not. */
	const folding = () => {
		const smallTicketSlice = ticketSubgraphOnly() && highlightedTicketPaths().size > 0 && (shown()?.nodes.size ?? 0) <= FOLD_ABOVE;
		return filter().mode !== "around" && !smallTicketSlice;
	};
	const govScriptState = createMemo(
		() => {
			const map = governingDocsByScript();
			return { key: [...map.keys()].sort().join("\n"), map };
		},
		{ equals: (a, b) => a.key === b.key },
	);
	const fitKey = () => JSON.stringify([filter(), ticketSubgraphOnly(), ticketSubgraphOnly() ? ticketHighlightKey() : null]);

	createEffect(
		() => [graph(), drawn(), mode(), gathered(), govScriptState().map, fitKey(), folding(), state.workspace?.root, state.settings.limits.bytes] as const,
		([g, keep, as, gathering, govMap, layoutKey, canFold, root, byteLimit]) => {
			// The list needs no layout, and a large one takes a while.
			if (!g || !keep || as !== "graph") {
				++layoutRun;
				return () => {
					++layoutRun;
				};
			}
			// A layout takes a while, and a later one may finish first: only the last one asked for is drawn.
			const run = ++layoutRun;
			const relFrom = (path: string) => relativeTo(root, path);
			const folderFrom = (path: string) => (path === UNRESOLVED ? "" : dirName(relFrom(path)));
			const sized = (label: string, bold = false, extra = 56) => ({
				"elk.nodeSize.constraints": "MINIMUM_SIZE",
				"elk.nodeSize.options": "MINIMUM_SIZE_ACCOUNTS_FOR_PADDING",
				"elk.nodeSize.minimum": `(${Math.ceil((bold ? measureBold : measure)(label)) + extra},30)`,
			});
			const notes = new Map<string, string>();
			// Scripts are drawn in their folders when there is more than one folder: the folder's box
			// carries the path once, and each script goes by its file's name.
			const drawnScripts = g.scripts.filter((s) => keep.nodes.has(foldId(s.path)) || keep.nodes.has(`${s.path}#`) || g.nodes.some((n) => n.path === s.path && keep.nodes.has(n.id)));
			const dirNodes = [...keep.nodes].filter(isDir).sort();
			const inFolders = new Set([...drawnScripts.map((s) => folderFrom(s.path)).filter(Boolean), ...dirNodes.map((id) => id.slice(4))]).size > 1;
			const nameIn = (path: string) => (inFolders && folderFrom(path) ? baseName(path) : relFrom(path));
			const scriptNodes = g.scripts
				.map((s) => {
					const hasGov = (govMap.get(s.path)?.length ?? 0) > 0;
					if (keep.nodes.has(foldId(s.path))) {
						const note = `${s.isClass ? "class, " : ""}${foldNote(g, s.path, keep.inside.get(s.path))}`;
						notes.set(s.path, note);
						const name = nameIn(s.path);
						return { id: foldId(s.path), width: Math.ceil(Math.max(measureBold(name) + (hasGov ? 34 : 0), measure(note))) + 46, height: FOLD_HEIGHT, labels: [{ text: name }] };
					}
					const procs = g.nodes.filter((n) => n.path === s.path && keep.nodes.has(n.id));
					const top = keep.nodes.has(`${s.path}#`) && g.topLevel.includes(s.path);
					if (!procs.length && !top) return null;
					const regions = [...new Set(procs.map((p) => p.region).filter(Boolean))] as string[];
					const leaf = (p: (typeof procs)[number]) => ({ id: p.id, width: textWidth(p.name), height: 28, labels: [{ text: p.name }] });
					return {
						id: `script:${s.path}`,
						labels: [{ text: s.isClass ? `class  ${nameIn(s.path)}` : nameIn(s.path) }],
						// Wide enough for its own name, size, fold button, and governing doc pill so labels never collide.
						layoutOptions: { "elk.padding": "[top=34,left=14,bottom=14,right=14]", ...sized(`${s.isClass ? "class  " : ""}${nameIn(s.path)}  ${sizeNote(s.bytes, byteLimit)}`, true, hasGov ? 94 : 62) },
						children: [
							...(top ? [{ id: `${s.path}#`, width: textWidth(topLabel(s)), height: 28, labels: [{ text: topLabel(s) }] }] : []),
							...procs.filter((p) => !p.region).map(leaf),
							...regions.map((r) => ({
								id: `region:${s.path}:${r}`,
								labels: [{ text: r }],
								layoutOptions: { "elk.padding": "[top=28,left=10,bottom=10,right=10]", ...sized(r) },
								children: procs.filter((p) => p.region === r).map(leaf),
							})),
						],
					};
				})
				.filter(Boolean) as any[];
			const pathOfNode = (id: string) => (id.startsWith("script:") ? id.slice(7) : scriptOf(id));
			const folders = inFolders ? [...new Set(scriptNodes.map((n) => folderFrom(pathOfNode(n.id))).filter(Boolean))].sort() : [];
			const scripts = [
				...folders.map((folder) => ({
					id: `folder:${folder}`,
					labels: [{ text: folder }],
					layoutOptions: { "elk.padding": "[top=34,left=16,bottom=16,right=16]", ...sized(folder, true) },
					children: scriptNodes.filter((n) => folderFrom(pathOfNode(n.id)) === folder),
				})),
				...scriptNodes.filter((n) => !inFolders || !folderFrom(pathOfNode(n.id))),
				// A folded folder: its path, and under it what is inside.
				...dirNodes.map((id) => {
					const inside = keep.inside.get(id);
					const note = `${plural(inside?.scripts ?? 0, "script")}, ${plural(inside?.procedures ?? 0, "procedure")}${inside?.calls ? `, ${plural(inside.calls, "call")} inside` : ""}`;
					notes.set(id, note);
					return { id, width: Math.ceil(Math.max(measureBold(id.slice(4)), measure(note))) + 46, height: FOLD_HEIGHT, labels: [{ text: id.slice(4) }] };
				}),
			];
			// Collect every node id actually emitted to ELK so dangling edges can never fail layout.
			const elkNodeIds = new Set<string>();
			const collectElkIds = (node: { id: string; children?: any[] }) => {
				elkNodeIds.add(node.id);
				for (const c of node.children ?? []) collectElkIds(c);
			};
			for (const s of scripts) collectElkIds(s);
			// Around a focus every call is drawn: there are few, and each is what was asked for.
			const openFolder = (id: string) => (isDir(id) ? undefined : folders.find((f) => f === folderFrom(scriptOf(id))));
			const rawDrawnEdges = gathering && canFold ? gather(keep.edges, openFolder) : keep.edges;
			const drawnEdges = rawDrawnEdges.filter((e) => elkNodeIds.has(e.from) && elkNodeIds.has(e.to));
			const edges = drawnEdges.map((e, i) => ({ id: `e${i}`, sources: [e.from], targets: [e.to] }));
			void (async () => {
				try {
					// The scripts of a folder that stand at the same step of its calls (the callers of one
					// helper, say, or scripts no line joins) would all be laid in one row or column, as long as
					// there are scripts. Lines the layout sees and nobody else does set them out as a block
					// instead, so many across and so many down.
					const abreast = folders.flatMap((folder) => {
						const own = scriptNodes.filter((n) => folderFrom(pathOfNode(n.id)) === folder);
						const holder = new Map<string, string>();
						const hold = (n: any, top: string) => (holder.set(n.id, top), (n.children ?? []).forEach((c: any) => hold(c, top)));
						for (const n of own) hold(n, n.id);
						const callers = new Map<string, Set<string>>();
						for (const e of drawnEdges) {
							const [a, b] = [holder.get(e.from), holder.get(e.to)];
							if (a && b && a !== b) callers.set(b, (callers.get(b) ?? new Set()).add(a));
						}
						return sameStep(own.map((n) => n.id as string), callers).filter((ids) => ids.length >= BLOCK_FROM);
					});
					const block = (direction: "RIGHT" | "DOWN") =>
						abreast.flatMap((ids, g) => {
							// Across the flow there is room for more than along it: a screen is wider than it is high.
							const perLayer = Math.ceil(Math.sqrt(direction === "RIGHT" ? ids.length / 2 : ids.length * 2));
							return ids.slice(perLayer).map((id, i) => ({ id: `b${g}:${i}`, sources: [ids[i]!], targets: [id] }));
						});
					const lay = (direction: "RIGHT" | "DOWN"): Promise<any> =>
						elk.layout({
							id: "root",
							layoutOptions: {
								"elk.algorithm": "layered",
								"elk.direction": direction,
								"elk.hierarchyHandling": "INCLUDE_CHILDREN",
								"elk.spacing.nodeNode": direction === "DOWN" ? "12" : "22",
								// Room between the layers for the lines to turn in, and between lines that run together.
								"elk.layered.spacing.nodeNodeBetweenLayers": direction === "DOWN" ? "54" : "76",
								"elk.layered.spacing.edgeNodeBetweenLayers": direction === "DOWN" ? "14" : "20",
								"elk.spacing.edgeNode": direction === "DOWN" ? "12" : "16",
								"elk.spacing.edgeEdge": "10",
								"elk.layered.nodePlacement.strategy": "NETWORK_SIMPLEX",
								"elk.layered.thoroughness": "24",
								"elk.json.edgeCoords": "ROOT",
								// POLYLINE waypoints rounded with smoothEdgePath: avoids ELK's SPLINES + INCLUDE_CHILDREN
								// mixed orthogonal/Bezier bendPoints bug that creates cusps and staircase kinks.
								"elk.edgeRouting": "POLYLINE",
								// The order the scripts come in is kept where it costs no crossing, so folding one moves the others little.
								"elk.layered.considerModelOrder.strategy": "NODES_AND_EDGES",
							},
							children: JSON.parse(JSON.stringify(scripts)),
							edges: [...JSON.parse(JSON.stringify(edges)), ...block(direction)],
						});
					// Calls run left to right. A picture small enough to lay out twice is also tried top to
					// bottom, and that is kept when the view shows clearly more of it: wide nodes in few
					// layers stack lower than they spread.
					let result = await lay("RIGHT");
					if (run !== layoutRun) return;
					if (keep.nodes.size <= BOTH_WAYS_UP_TO) {
						const down = await lay("DOWN");
						if (run !== layoutRun) return;
						if (fitShare(down, size()) > fitShare(result, size()) * 1.1) result = down;
					}
					const boxes: Box[] = [];
					const walk = (n: any, ox: number, oy: number) => {
						const x = ox + (n.x ?? 0);
						const y = oy + (n.y ?? 0);
						const id: string = n.id;
						if (id !== "root") {
							const scriptPath = id.startsWith("script:") ? id.slice(7) : isFold(id) ? scriptOf(id) : undefined;
							const folder = isDir(id) ? id.slice(4) : id.startsWith("folder:") ? id.slice(7) : undefined;
							const script = scriptPath === undefined ? undefined : g.scripts.find((s) => s.path === scriptPath);
							const node = g.nodes.find((p) => p.id === id);
							boxes.push({
								id,
								x,
								y,
								width: n.width,
								height: n.height,
								label: n.labels?.[0]?.text ?? "",
								kind: isDir(id) ? "dir" : id.startsWith("folder:") ? "folder" : isFold(id) ? "fold" : script ? "script" : id.startsWith("region:") ? "region" : id.endsWith("#") ? "top" : "proc",
								folder,
								path: folder !== undefined ? undefined : (script?.path ?? node?.path ?? (id.endsWith("#") ? id.slice(0, -1) : undefined)),
								line: node?.line,
								nodeKind: node?.kind,
								region: id.startsWith("region:") ? n.labels?.[0]?.text : undefined,
								bytes: script?.bytes,
								isClass: script?.isClass,
								note: isDir(id) ? notes.get(id) : isFold(id) ? notes.get(scriptOf(id)) : undefined,
							});
						}
						for (const c of n.children ?? []) walk(c, x, y);
					};
					walk(result, 0, 0);
					const lines: Line[] = (result.edges ?? []).filter((e: any) => String(e.id).startsWith("e")).map((e: any) => {
						const edge: DrawnEdge = drawnEdges[Number(String(e.id).slice(1))]!;
						const section = e.sections?.[0];
						const relation = relationOf(edge.kind);
						const count = Math.max(1, edge.sites.length);
						const points: Point[] = section ? [section.startPoint, ...(section.bendPoints ?? []), section.endPoint] : [];
						// A line that stands for several places says how many, just after it leaves: there each line still has its own room.
						const width = Math.ceil(measure(String(count))) + 12;
						const near = smoothEdgePoint(points, BADGE_AT);
						return {
							badge: count > 1 && points.length ? { x: near.x - width / 2, y: near.y - 8, width, height: 16 } : undefined,
							id: e.id,
							d: smoothEdgePath(points),
							from: edge.from,
							to: edge.to,
							cross: edge.crossScript,
							count,
							relation,
							froms: edge.froms,
							tos: edge.tos,
							title: `${lineWords(g, edge, RELATION_WORDS[relation], relFrom)}${count > 1 ? `, from ${count} places` : ""}${edge.froms || edge.tos ? ". Point at it to see which." : ""}`,
						};
					});
					// The nodes are drawn afresh: the one the keyboard was on takes the focus again.
					const hadFocus = Boolean(svg && svg.contains(document.activeElement));
					nodeEls.clear();
					setPointed(null);
					setPointedLine(null);
					setLayout({ boxes, lines, width: result.width, height: result.height, key: layoutKey });
					flush();
					// A different set of calls is a different picture: show it whole. A refresh keeps the view,
					// and folding one script keeps it too, moved only as far as brings that script into sight.
					if (fittedFor !== layoutKey) {
						if (fit()) fittedFor = layoutKey;
					} else if (showNext !== null) {
						const box = boxes.find((b) => ((b.kind === "fold" || b.kind === "script") && b.path === showNext) || ((b.kind === "dir" || b.kind === "folder") && b.folder === showNext));
						const curSize = size();
						if (box && curSize.width >= 10 && curSize.height >= 10) setView((v) => reveal(v, box, curSize));
					}
					showNext = null;
					if (hadFocus) queueMicrotask(() => nodeEls.get(cursor() ?? "")?.focus());
				} catch (e: any) {
					if (run !== layoutRun) return;
					setProgress(`Layout failed: ${e?.message ?? e}`);
				}
			})();
			return () => {
				++layoutRun;
			};
		},
	);

	const focus = (id: string) => setFilter((f) => ({ mode: "around", focus: id, depth: f.depth, direction: f.direction }));
	const open = (at: { path?: string; line?: number }) => {
		if (!at.path || at.path === UNRESOLVED) return;
		// Let openFile switch centerView="editors" atomically with g.active so navigation history
		// does not record the stale background tab between Call Graph and the opened script.
		void openFile(at.path, { reveal: { line: (at.line ?? 0) + 1 } });
	};
	const procs = () => layout()?.boxes.filter((b) => b.kind === "proc" || b.kind === "top" || b.kind === "fold" || b.kind === "dir") ?? [];
	/** Folds a script to one node, or unfolds it; the keyboard stays with it. */
	const toggleFold = (path: string | undefined) => {
		const g = graph();
		if (!g || path === undefined || !folding()) return;
		const next = new Set(folded());
		if (next.delete(path)) setCurrent(g.nodes.find((n) => n.path === path)?.id ?? `${path}#`);
		else {
			next.add(path);
			setCurrent(foldId(path));
		}
		showNext = path;
		setFolded(next);
	};
	/** Folds a folder's scripts to one node, or unfolds it. */
	const toggleDir = (folder: string | undefined) => {
		if (!folder || !folding()) return;
		const next = new Set(foldedDirs());
		if (!next.delete(folder)) {
			next.add(folder);
			setCurrent(dirId(folder));
		} else setCurrent(null);
		showNext = folder;
		setFoldedDirs(next);
	};
	/** The folder the node the keys are on is in. */
	const folderAt = (b: Box) => b.folder ?? (b.path === undefined ? undefined : folderOf(b.path) || undefined);
	/** Everything folded is the picture of the folders, where there is more than one, and of the scripts otherwise. */
	const allFolders = () => {
		const g = graph();
		const folders = g ? foldersOf(g) : new Set<string>();
		return folders.size > 1 ? folders : new Set<string>();
	};
	const allFolded = () => Boolean(graph()?.scripts.every((s) => folded().has(s.path))) && [...allFolders()].every((f) => foldedDirs().has(f));
	const foldAll = (all: boolean) => {
		fittedFor = "";
		setCurrent(null);
		setFolded(new Set(all ? (graph()?.scripts.map((s) => s.path) ?? []) : []));
		setFoldedDirs(all ? allFolders() : new Set<string>());
	};
	/** The node whose lines are lit: the one under the pointer, or failing that the one the keys moved to. */
	const lit = () => pointed() ?? walked();
	/** The nodes at the other end of a lit line. */
	const beside = createMemo(() => {
		const l = layout();
		const on = lit();
		const line = pointedLine();
		const ids = new Set<string>();
		// A gathered line's ends are the nodes it stands for, not the folder it is drawn to.
		for (const e of l?.lines ?? []) {
			const [froms, tos] = [e.froms ?? [e.from], e.tos ?? [e.to]];
			if (e.id === line) for (const id of [...froms, ...tos]) ids.add(id);
			else if (on && froms.includes(on)) for (const id of tos) ids.add(id);
			else if (on && tos.includes(on)) for (const id of froms) ids.add(id);
		}
		return ids;
	});
	const isHot = (e: Line) => e.id === pointedLine() || (lit() !== null && ((e.froms ?? [e.from]).includes(lit()!) || (e.tos ?? [e.to]).includes(lit()!)));
	const arrowOf = (e: Line) => `url(#arrow-${isHot(e) ? "hot" : e.relation !== "call" ? "class" : e.cross ? "cross" : "plain"})`;
	/**
	 * What the pointer or the keys are on, in words, said at once under the picture: a line by its
	 * two ends, a node by how many lines come in to it and go out. A tooltip says the same, but
	 * only after a wait, and following a line is done by moving along it.
	 */
	const said = createMemo(() => {
		const l = layout();
		if (!l) return "";
		const line = pointedLine();
		if (line) return (l.lines.find((e) => e.id === line)?.title ?? "").replace(/\. Point at it to see which\.$/, "");
		const on = lit();
		const box = on ? l.boxes.find((b) => b.id === on) : undefined;
		if (!box) return "";
		const ins = l.lines.filter((e) => (e.tos ?? [e.to]).includes(box.id)).length;
		const outs = l.lines.filter((e) => (e.froms ?? [e.from]).includes(box.id)).length;
		return `${titleOf(box)}. ${plural(ins, "line")} in, ${outs} out.`;
	});
	/** Where the keyboard is: the node last focused if it is still shown, or else the focus, or the first. */
	const cursor = createMemo(() => {
		const list = procs();
		return (list.find((b) => b.id === current()) ?? list.find((b) => b.id === filter().focus) ?? list[0])?.id ?? null;
	});
	const size = () => svg?.getBoundingClientRect() ?? { width: 0, height: 0 };
	const centreOf = (b: Box) => ({ x: b.x + b.width / 2, y: b.y + b.height / 2 });

	/** The whole graph, or as much as stays legible around the node the keyboard or the focus is on. */
	const fit = (): boolean => {
		const l = layout();
		if (!l || !svg) return false;
		const box = size();
		if (box.width < 10 || box.height < 10) return false;
		const here = procs().find((b) => b.id === cursor());
		fittedView = fitView(l, box, { floor: FIT_FLOOR, anchor: current() || filter().focus ? here && centreOf(here) : undefined });
		fittedWhole = false;
		setView(fittedView);
		return true;
	};
	/** Fit, and Fit again: as much as stays legible, then, where that left some out of sight, the whole picture however small. */
	const fitOrWhole = () => {
		const l = layout();
		const box = size();
		if (l && svg && box.width >= 10 && box.height >= 10 && view() === fittedView && !fittedWhole && outOfSight(l, view(), box)) whole();
		else fit();
	};
	const whole = (): boolean => {
		const l = layout();
		if (!l || !svg) return false;
		const box = size();
		if (box.width < 10 || box.height < 10) return false;
		fittedView = fitView(l, box, { floor: MIN_ZOOM });
		fittedWhole = true;
		setView(fittedView);
		return true;
	};
	// If layout completed while Call Graph was hidden (display: none), fit cleanly once visible again without touching already-fitted views.
	createEffect(
		() => [isGraphView(), isGraphMode(), layout(), fitKey()] as const,
		([inGraphView, inGraphMode, l, key]) => {
			if (!inGraphView || !inGraphMode || !l) return;
			if (l.key !== key || fittedFor === l.key) return;
			const frame = requestAnimationFrame(() => {
				const cur = layout();
				if (!cur || cur.key !== key || fittedFor === cur.key) return;
				if (fit()) fittedFor = cur.key;
			});
			return () => cancelAnimationFrame(frame);
		},
	);
	/** Zoomed far out: the words of the nodes give way to the names of scripts and folders, drawn to be read. */
	const far = () => view().scale < FAR_UNDER;
	/** The zoom of the far picture, or 0 while the view is nearer: moving the picture changes nothing a name depends on. */
	const farScale = createMemo(() => (far() ? view().scale : 0));
	/**
	 * The names of the far picture, as a map shows its names: every one shown is large enough to
	 * read, a folder's above it and a script's across its middle, and a name that would lie over
	 * another waits for a closer look, the larger script's kept before the smaller's.
	 */
	const farNames = createMemo(() => {
		const scale = farScale();
		const l = layout();
		if (!scale || !l) return [];
		const size = FAR_NAME_PX / scale;
		const wide = (b: Box) => (measureBold(b.label) * size) / FONT_PX;
		return clearLabels(
			l.boxes
				.filter((b) => b.kind === "script" || b.kind === "fold" || b.kind === "dir" || b.kind === "folder")
				.map((b) =>
					b.kind === "folder"
						? { item: b, x: b.x, y: b.y - size * 1.25, width: wide(b), height: size * 1.2, weight: FOLDER_FIRST + b.width * b.height }
						: { item: b, x: b.x + b.width / 2 - wide(b) / 2, y: b.y + b.height / 2 - size * 0.6, width: wide(b), height: size * 1.2, weight: b.width * b.height },
				)
				// A name stays inside the picture: one that ran past its edge would be cut off by the view's.
				.map((name) => ({ ...name, x: Math.max(0, Math.min(name.x, l.width - name.width)), y: Math.max(0, Math.min(name.y, l.height - name.height)) })),
			size * 0.3,
		).map((name) => ({ ...name, size }));
	});
	/** Far out, a click goes to what is clicked: the view comes in on that script or folder, as large as fits and its words can be read. */
	const comeIn = (b: Box) => {
		const own = b.kind === "proc" || b.kind === "top" ? layout()?.boxes.find((s) => s.kind === "script" && s.path === b.path) : undefined;
		const to = own ?? b;
		const box = size();
		if (box.width < 10 || box.height < 10) return;
		const toW = Math.max(1, to.width);
		const toH = Math.max(1, to.height);
		const scale = Math.max(FIT_FLOOR, Math.min(1, (box.width - 80) / toW, (box.height - 80) / toH));
		setView({ scale, x: box.width / 2 - (to.x + toW / 2) * scale, y: box.height / 2 - (to.y + toH / 2) * scale });
	};
	/** Zooms about a point of the canvas: the pointer, or its middle for the buttons and keys. */
	const zoomBy = (factor: number, at?: Point) => {
		const box = size();
		setView((v) => zoomAt(v, at ?? { x: box.width / 2, y: box.height / 2 }, factor, MIN_ZOOM, MAX_ZOOM));
	};
	const moveTo = (b: Box | undefined) => {
		if (!b) return;
		setCurrent(b.id);
		setWalked(b.id);
		nodeEls.get(b.id)?.focus();
		// In sight, and not under the map of the picture in the corner.
		setView((v) => {
			const l = layout();
			const shown = reveal(v, b, size());
			return l && outOfSight(l, shown, size()) ? clearOf(shown, b, mapArea(l, size())) : shown;
		});
	};
	const onKey = (e: KeyboardEvent) => {
		if ((e.ctrlKey || e.metaKey) && !e.altKey && e.key.toLowerCase() === "f") {
			e.preventDefault();
			e.stopPropagation();
			focusFinder?.();
			return;
		}
		if (e.ctrlKey || e.metaKey || e.altKey) return;
		const here = procs().find((b) => b.id === cursor());
		if ((e.key === "ContextMenu" || (e.shiftKey && e.key === "F10")) && here && here.kind !== "dir" && here.path && here.path !== UNRESOLVED) {
			e.preventDefault();
			const el = nodeEls.get(here.id);
			const rect = el?.getBoundingClientRect();
			const at = rect
				? { x: Math.round(rect.left + rect.width / 2), y: Math.round(rect.bottom + 2) }
				: (() => {
						const hostRect = svg?.getBoundingClientRect();
						const v = view();
						return {
							x: Math.round((hostRect?.left ?? 0) + (here.x + here.width / 2) * v.scale + v.x),
							y: Math.round((hostRect?.top ?? 0) + (here.y + here.height) * v.scale + v.y),
						};
					})();
			openGraphNodeMenu(here, at);
			return;
		}
		const key = e.key.length === 1 ? e.key.toLowerCase() : e.key;
		const step = (dx: number, dy: number) => moveTo(here ? nearest(procs(), here, dx, dy) : procs()[0]);
		const actions: Record<string, () => void> = {
			ArrowUp: () => step(0, -1),
			ArrowDown: () => step(0, 1),
			ArrowLeft: () => step(-1, 0),
			ArrowRight: () => step(1, 0),
			// On a folded script Enter unfolds it: there is no one procedure to open.
			Enter: () => here && (here.kind === "dir" ? toggleDir(here.folder) : here.kind === "fold" ? toggleFold(here.path) : open(here)),
			// A folder is not one script: there is nothing of it to focus on until it is unfolded.
			f: () => here && here.kind !== "dir" && focus(here.kind === "fold" ? `${here.path}#` : here.id),
			// X folds or unfolds the script; with Shift, or on a folded folder, the folder.
			x: () => here && (here.kind === "dir" || e.shiftKey ? toggleDir(folderAt(here)) : toggleFold(here.path)),
			"+": () => zoomBy(1.2),
			"=": () => zoomBy(1.2),
			"-": () => zoomBy(1 / 1.2),
			"0": fitOrWhole,
			"?": toggleKeys,
			Escape: () => {
				setKeysOpen(false);
				setLegendOpen(false);
				setImpactOpen(false);
			},
		};
		const action = actions[key];
		if (action) {
			e.preventDefault();
			action();
		}
	};
	const choose = (next: Mode) => {
		setMode(next);
		remember(MODE_KEY, next);
	};
	const schemaNoteOf = (path?: string) => {
		if (!path || path === UNRESOLVED) return "";
		const tables = schemaTablesByScript().get(path);
		if (!tables?.length) return "";
		const names = tables.slice(0, 6).map((t) => t.title || baseName(t.path).replace(/\.[^.]+$/, ""));
		return `, tables: ${names.join(", ")}${tables.length > 6 ? ` (+${tables.length - 6})` : ""}`;
	};
	const titleOf = (b: Box) => {
		const litKey = ticketHighlightKey();
		if (b.kind === "dir") return `${b.label}: folder, ${b.note}, folded${litKey && b.folder && highlightedTicketFolders().has(b.folder) ? `, contains scripts for ${litKey}` : ""}`;
		const ticketNote = litKey && b.path && highlightedTicketPaths().has(b.path) ? `, governed by ${litKey}` : "";
		const tablesNote = schemaNoteOf(b.path);
		if (b.kind === "fold") return `${b.label}: ${b.path === UNRESOLVED ? "what the language server could not resolve" : "script"}, ${b.note}, folded${filter().focus === `${b.path}#` ? ", the focus" : ""}${ticketNote}${tablesNote}`;
		const kind = KIND_WORDS[b.kind === "top" ? (graph()?.scripts.find((s) => s.path === b.path)?.isClass ? "class" : "top") : (b.nodeKind ?? "procedure")];
		const where = b.path && b.path !== UNRESOLVED ? `${kind} in ${rel(b.path)}` : kind;
		return `${b.label}: ${where}${filter().focus === b.id ? ", the focus" : ""}${ticketNote}${tablesNote}`;
	};

	/** The bar's menu: what is not needed at every look. */
	const more = (): MenuItem[] => {
		const inGraph = mode() === "graph";
		const none = "Nothing to fold in the list, or around a focus";
		return [
			{ label: "Fold all", run: () => foldAll(true), disabled: !inGraph || !folding() || allFolded(), why: allFolded() ? "Everything is folded" : none },
			{ label: "Unfold all", run: () => foldAll(false), disabled: !inGraph || !folding() || (folded().size === 0 && foldedDirs().size === 0), why: inGraph && folding() ? "Nothing is folded" : none },
			"separator",
			{
				label: `${unresolved() ? "Hide" : "Show"} unresolved targets (${unresolvedCount()})`,
				run: () => {
					const next = !unresolved();
					fittedFor = "";
					setUnresolved(next);
					remember(UNRESOLVED_KEY, next ? "shown" : "hidden");
				},
				disabled: !unresolvedCount(),
				why: "Every target resolved",
			},
			{
				label: gathered() ? "Draw each call across a folder's edge" : "Gather calls at a folder's edge",
				run: () => {
					const next = !gathered();
					fittedFor = "";
					setGathered(next);
					remember(GATHER_KEY, next ? "gathered" : "spread");
				},
				disabled: !inGraph || !folding(),
				why: "Around a focus, and in the list, every call is shown",
			},
			...(narrow() && inGraph
				? ([
						{ label: "Zoom in", keys: "+", run: () => zoomBy(1.2) },
						{ label: "Zoom out", keys: "−", run: () => zoomBy(1 / 1.2) },
						{ label: `Zoom to 100% (now ${Math.round(view().scale * 100)}%)`, run: () => zoomBy(1 / view().scale) },
						"separator",
					] satisfies MenuItem[])
				: []),
			{ label: legendOpen() ? "Hide legend" : "Show legend", run: toggleLegend, disabled: !inGraph || !legend().length, why: "The legend is for the graph" },
			{ label: keysOpen() ? "Hide the keys" : "Keys and what the pointer does", keys: "?", run: toggleKeys, disabled: !inGraph, why: "The keys are the graph's" },
			...(() => {
				const activeKey = state.settings.activeTicket?.trim() || "";
				const litKey = ticketHighlightKey()?.trim() || "";
				const targetKey = litKey || activeKey;
				const items: MenuItem[] = [];
				if (targetKey) {
					items.push({
						label: `Filter to ${targetKey} (+ 1-hop)`,
						checked: ticketSubgraphOnly(),
						run: toggleTicketSubgraph,
						disabled: !graph(),
						why: "Build the call graph first",
					});
				}
				if (litKey) {
					items.push({
						label: `Clear ${litKey} highlight`,
						run: () => setGraphTicketHighlight(null),
					});
				}
				if (activeKey && activeKey.toLowerCase() !== litKey.toLowerCase()) {
					items.push({
						label: `Highlight ${activeKey} scripts`,
						run: () => setGraphTicketHighlight(activeKey),
						disabled: !graph(),
						why: "Build the call graph first",
					});
				}
				return items;
			})(),
			{
				label: "Impact / Blast-Radius Analysis…",
				run: () => void runTicketImpactAnalysis(),
				disabled: !graph(),
				why: "Build the call graph first",
			},
			{
				label: "Focus script linked to a ticket…",
				run: () =>
					void (async () => {
						const hasTickets = docs().some((d) => d.exists && d.group === "tickets" && d.ticket);
						if (!hasTickets) return notify("No tickets found in docs/tickets/ yet.");
						const ticket = await pickTicketQuickPick("Focus Call Graph on scripts governed by ticket");
						if (!ticket?.ticket) return;
						const refs = scriptsForTicket(docs(), ticket.ticket, { includeDescendants: true });
						const root = state.workspace?.root;
						const g = graph();
						const matches = (g?.scripts ?? []).filter((s) => refs.some((r) => codeMatchesRef(s.path, r, root)));
						if (!matches.length) {
							notify(`No Call Graph scripts found for ${ticket.ticket} yet.`);
							return;
						}
						let chosen = matches[0]!;
						if (matches.length > 1) {
							const scriptItems: QuickPickOption<typeof chosen>[] = matches.map((m) => {
								const procCount = g?.nodes.filter((n) => n.path === m.path).length ?? 0;
								return {
									value: m,
									label: baseName(m.path),
									icon: /\.ds$/i.test(m.path) ? "database" : "file",
									detail: rel(m.path).replace(/\\/g, "/"),
									description: plural(procCount, "procedure"),
								};
							});
							const pickedScript = await quickPick({
								title: `${ticket.ticket} spans ${matches.length} scripts — focus which one?`,
								placeholder: "Filter scripts…",
								items: scriptItems,
							});
							if (!pickedScript) return;
							chosen = pickedScript;
						}
						focus(`${chosen.path}#`);
					})(),
				disabled: !graph(),
				why: "Build the call graph first",
			},
			"separator",
			{ label: "Save picture…", run: () => void savePicture(svg, layout(), "docs/call-graph.svg"), disabled: !inGraph || !layout(), why: "There is no picture in the list" },
			{ label: "Refresh", run: () => void refresh(), disabled: state.lsp.state !== "running", why: "Needs the language server" },
		];
	};

	/** Shared right-click / keyboard context menu for unfolded script boxes, procedure/folded nodes, and List view scripts. */
	const openGraphNodeMenu = (target: { kind?: string; path?: string; id?: string; label?: string }, at: { x: number; y: number }) => {
		const boxPath = target.path;
		if (target.kind === "dir" || target.kind === "folder" || target.kind === "region" || !boxPath || boxPath === "(unresolved)") return;
		const opener = document.activeElement instanceof SVGElement ? document.activeElement : null;
		void (async () => {
			const { chooseFromMenu } = await import("../panels/RowMenu");
			const [links, schemaTables] = await Promise.all([
				backend.linksTo(boxPath).catch(() => []),
				schemaTablesForScript(boxPath).catch(() => [] as DocFile[]),
			]);
			const gov = docsGoverningFile(docs(), boxPath, state.workspace?.root, links);
			const isDs = /\.ds$/i.test(boxPath);
			const OPEN_ITEM = isDs ? "Open data source" : "Open script";
			const OPEN_SIDE = "Open to the side";
			const FOCUS_NODE = "Focus callers & callees";
			const IMPACT = "Impact / Blast-Radius Analysis…";
			const PATH = "Copy path";
			const RELATIVE = "Copy path in the project";
			const NAME = "Copy name";
			const SHOW = "Show in the Explorer";
			const inWs = Boolean(state.workspace && isInside(state.workspace.root, boxPath));
			const rawLabels = gov.map((g) => {
				const base =
					g.file.group === "registries"
						? registryTitle(g.file.name)
						: g.file.ticket && g.file.title && !g.file.title.startsWith(g.file.ticket)
							? `${g.file.ticket}: ${g.file.title}`
							: g.file.title || g.file.heading || g.file.name;
				return base;
			});
			const counts = new Map<string, number>();
			for (const l of rawLabels) counts.set(l, (counts.get(l) ?? 0) + 1);
			const docChoices = gov.map((g, i) => ({
				value: `doc:${i}`,
				label: (counts.get(rawLabels[i]!) ?? 0) > 1 ? `${rawLabels[i]!} (${g.file.name})` : rawLabels[i]!,
				doc: g.file,
				line: g.line,
			}));
			const docSection: RowMenuEntry[] =
				docChoices.length === 1
					? [{ label: `Open doc: ${docChoices[0]!.label}`, value: docChoices[0]!.value }]
					: docChoices.length > 1
						? [
								{
									label: `Governing docs (${docChoices.length})`,
									children: docChoices.map((d) => ({ label: d.label, value: d.value })),
								},
							]
						: [];
			const schemaChoices = schemaTables.map((tbl, i) => ({
				value: `schema:${i}`,
				label: tbl.title || baseName(tbl.path).replace(/\.[^.]+$/, ""),
				doc: tbl,
			}));
			const schemaSection: RowMenuEntry[] =
				schemaChoices.length === 1
					? [{ label: `Open schema table: ${schemaChoices[0]!.label}`, value: schemaChoices[0]!.value }]
					: schemaChoices.length > 1
						? [
								{
									label: `Schema tables (${schemaChoices.length})`,
									children: schemaChoices.map((s) => ({ label: s.label, value: s.value })),
								},
							]
						: [];
			const items: RowMenuEntry[] = [
				OPEN_ITEM,
				OPEN_SIDE,
				FOCUS_NODE,
				IMPACT,
				...(docSection.length ? (["separator", ...docSection] as RowMenuEntry[]) : []),
				...(schemaSection.length ? (["separator", ...schemaSection] as RowMenuEntry[]) : []),
				"separator",
				...submenuOrInline("Copy path", [PATH, ...(inWs ? [RELATIVE] : []), NAME]),
				...(inWs ? [SHOW] : []),
			];
			const picked = await chooseFromMenu(target.label || rel(boxPath), items, at);
			if (!picked) {
				if (opener?.isConnected) opener.focus();
				return;
			}
			if (picked === OPEN_ITEM) {
				if (target.id && target.kind && target.kind !== "script" && target.kind !== "fold") open(target as Box);
				else void openFile(boxPath, { keep: true });
			} else if (picked === OPEN_SIDE) {
				void openToSide(boxPath);
			} else if (picked === FOCUS_NODE) {
				focus(!target.id || target.kind === "script" || target.kind === "fold" ? `${boxPath}#` : target.id);
				if (opener?.isConnected) queueMicrotask(() => nodeEls.get(cursor() ?? "")?.focus());
			} else if (picked === IMPACT) {
				const seedId = !target.id || target.kind === "script" || target.kind === "fold" ? `${boxPath}#` : target.id;
				const label =
					!target.id || target.kind === "script" || target.kind === "fold"
						? rel(boxPath)
						: `${target.label || target.id.slice(target.id.lastIndexOf("#") + 1)} (${baseName(boxPath)})`;
				runImpactAnalysis([seedId], label);
			} else if (picked === PATH || picked === RELATIVE || picked === NAME) {
				await (await import("../commands")).copyPath(picked === PATH ? "whole" : picked === NAME ? "name" : "relative", boxPath);
			} else if (picked === SHOW) {
				(await import("../panels/Explorer")).showInExplorer(boxPath);
			} else if (picked.startsWith("schema:")) {
				const hit = schemaChoices.find((s) => s.value === picked);
				if (hit) await openFile(hit.doc.path);
			} else {
				const hit = docChoices.find((d) => d.value === picked);
				const procName = target.kind === "proc" ? target.label : undefined;
				if (hit) await openGoverningDoc(hit.doc.path, boxPath, procName, hit.line);
				else notify("Could not open governing document.");
			}
		})();
	};

	/** The key explains only what can be seen: each entry is there while the picture has one of it. */
	const legend = createMemo(() => {
		const l = layout();
		if (!l) return [];
		const box = (test: (b: Box) => boolean) => l.boxes.some(test);
		const line = (test: (e: Line) => boolean) => l.lines.some(test);
		const sizeOf = (b: Box) => (b.kind === "script" || b.kind === "fold" ? level(b.bytes ?? 0, state.settings.limits.bytes) : "");
		const entries: [shown: boolean, shape: "box" | "line", cls: string, words: string][] = [
			[box((b) => b.kind === "dir"), "box", "g-fold g-dir", "Folder, folded"],
			[box((b) => b.kind === "fold"), "box", "g-fold", "Script, folded"],
			[box((b) => b.kind === "proc" && (b.nodeKind ?? "procedure") === "procedure"), "box", "g-proc", "Procedure"],
			[box((b) => b.nodeKind === "datasource"), "box", "g-proc datasource", "Data source"],
			[box((b) => b.nodeKind === "unresolved"), "box", "g-proc unresolved", "Target not resolved"],
			[box((b) => b.kind === "top"), "box", "g-top", "Code outside any procedure"],
			[line((e) => e.relation === "call" && !e.cross), "line", "g-edge", "Call within a script"],
			[line((e) => e.relation === "call" && e.cross), "line", "g-edge cross", "Call between scripts"],
			[line((e) => e.count > 1), "line", "g-edge thick", "Thicker, with a number: called from that many places"],
			[line((e) => Boolean(e.froms || e.tos)), "line", "g-edge cross gathered", "At a folder's edge: stands for several inside it"],
			[line((e) => e.relation === "inherits"), "line", "g-edge inherits", "Dashed: a class inherits another"],
			[line((e) => e.relation === "creates"), "line", "g-edge creates", "Dotted: creates an object of a class"],
			[line((e) => e.relation === "method"), "line", "g-edge method", "Dash and dot: calls a method"],
			[box((b) => sizeOf(b) === "near"), "box", "g-script near", "Script near its size limit"],
			[box((b) => sizeOf(b) === "over"), "box", "g-script over", "Script over its size limit"],
			[Boolean(ticketHighlightKey()), "box", "g-script ticket-lit", `Governed by ${ticketHighlightKey()}`],
		];
		return entries.filter(([shown]) => shown).map(([, shape, cls, words]) => ({ shape, cls, words }));
	});

	/** A method call is a call; creating an object and inheriting are not, and are counted as what they are. */
	const counted = () => {
		const edges = graph()?.edges ?? [];
		const classes = edges.filter((e) => ["creates", "inherits"].includes(relationOf(e.kind))).length;
		return `${edges.length - classes} calls${classes ? `, ${classes} class relations` : ""}`;
	};

	/** The focus as the bar names it: a procedure by its name, a script by its file. */
	const focusName = () => {
		const id = filter().focus ?? "";
		return id.endsWith("#") ? baseName(id.slice(0, -1)) : id.slice(id.lastIndexOf("#") + 1);
	};
	const tally = () => (graph() ? `${graph()!.nodes.length} procedures, ${counted()}${graph()!.truncated ? " (incomplete: refresh when indexing ends)" : ""}` : "");

	// Expose Call Graph controls, targets, and legend to the context-coupled Palette panel.
	createEffect(
		() => isGraphView(),
		(active) => {
			if (!active) return;
			return registerGraphBridge({
				mode,
				setMode: choose,
				filterMode: () => filter().mode,
				setFilterMode: (next) => setFilter({ ...filter(), mode: next }),
				folding,
				allFolded,
				anyFolded: () => folded().size > 0 || foldedDirs().size > 0,
				foldAll,
				gathered,
				toggleGathered: () => {
					const next = !gathered();
					fittedFor = "";
					setGathered(next);
					remember(GATHER_KEY, next ? "gathered" : "spread");
				},
				unresolved,
				unresolvedCount,
				toggleUnresolved: () => {
					const next = !unresolved();
					fittedFor = "";
					setUnresolved(next);
					remember(UNRESOLVED_KEY, next ? "shown" : "hidden");
				},
				fit: fitOrWhole,
				refresh: () => void refresh(),
				tally,
				legend,
				targets: () => {
					const g = graph();
					if (!g) return [];
					return g.scripts
						.filter((s) => s.path !== UNRESOLVED)
						.map((s) => {
							const procs = g.nodes.filter((n) => n.path === s.path).length;
							return { id: `${s.path}#`, label: rel(s.path), meta: `${procs}` };
						})
						.sort((a, b) => a.label.localeCompare(b.label));
				},
				focusTarget: (id) => focus(id),
			});
		},
	);

	const list = createMemo(() => {
		const g = graph();
		const keep = shown();
		return g && keep ? callList(g, keep.edges) : [];
	});
	/** Around a focus, the list starts with the answer: what calls it, and what it calls. */
	const around = createMemo(() => {
		const g = graph();
		const keep = shown();
		const f = filter();
		return g && keep && f.mode === "around" && f.focus ? aroundFocus(g, keep.edges, f.focus) : null;
	});
	/** What a line of that answer says after the name: how it is related, which procedure of a script, where, and from how many places. */
	const linkNote = (link: FocusLink) => {
		const focus = filter().focus ?? "";
		const elsewhere = link.other.path !== UNRESOLVED && link.other.path !== scriptOf(focus);
		return [link.relation === "call" ? "" : RELATION_WORDS[link.relation], focus.endsWith("#") ? `${link.own.name}` : "", elsewhere ? `in ${rel(link.other.path)}` : "", link.count > 1 ? `from ${link.count} places` : ""].filter(Boolean).join(", ");
	};
	/** Why there is nothing to see, and what to do about it. */
	const idle = (): { text: string; hint?: string; restart?: boolean } | null => {
		if (!state.workspace) return { text: "Open a folder to see the calls between its procedures." };
		const stale = graph()?.nodes.length ? " These are the calls as they were last read." : "";
		if (state.lsp.state === "starting" || state.lsp.state === "restarting") return { text: `The language server is starting.${stale || " The graph is read from it, and appears when it is ready."}` };
		if (state.lsp.state !== "running")
			return {
				text: `The language server is not running${stale ? `.${stale}` : ", so there are no calls to show: the graph is read from it."}${state.lsp.message ? ` It said: ${state.lsp.message}` : ""}`,
				hint: "Restart it here or from the status bar. If it does not start, Settings has where to find it, under Language server program.",
				restart: true,
			};
		if (failed()) return { text: failed(), hint: "Refresh tries again." };
		if (graph() && !graph()!.nodes.length) return { text: "The language server found no procedures in this folder." };
		return null;
	};
	const Proc = (p: { proc: ListedProc }) => (
		<>
			<Show when={p.proc.path !== UNRESOLVED} fallback={<span>{p.proc.name}</span>}>
				<button class="link" title={`Open ${p.proc.name}`} onClick={() => open(p.proc)}>
					{p.proc.name}
				</button>
			</Show>
			<button class="graph-list-focus" title={`Show only the callers and callees of ${p.proc.name}`} aria-label={`Focus ${p.proc.name}`} aria-pressed={filter().mode === "around" && filter().focus === p.proc.id ? "true" : "false"} onClick={() => focus(p.proc.id)}>
				Focus
			</button>
		</>
	);
	let dragging: { x: number; y: number } | null = null;
	/** How far the pointer has moved the picture since it was pressed. */
	let panned = 0;
	/** Too narrow for every button of the bar: the zoom buttons go to the menu. */
	const [narrow, setNarrow] = createSignal(false);
	let widthCleanup: (() => void) | undefined;
	onCleanup(() => {
		widthCleanup?.();
		widthCleanup = undefined;
	});
	const watchWidth = (el: HTMLDivElement) => {
		widthCleanup?.();
		widthCleanup = undefined;
		if (typeof ResizeObserver === "undefined") return;
		// The bar's height follows from this, and so the picture's: it waits for the next frame.
		let frame = 0;
		const observer = new ResizeObserver((entries) => {
			const rect = entries[0]?.contentRect;
			const width = rect?.width ?? 0;
			const height = rect?.height ?? 0;
			if (width < 10 || height < 10) return;
			cancelAnimationFrame(frame);
			frame = requestAnimationFrame(() => {
				setNarrow(width < NARROW_UNDER);
				// A picture nobody has moved since it was fitted stays fitted when the window or a panel changes its room.
				if (view() === fittedView) queueMicrotask(fittedWhole ? whole : fit);
			});
		});
		observer.observe(el);
		widthCleanup = () => {
			cancelAnimationFrame(frame);
			observer.disconnect();
		};
	};

	return (
		<CenterTabStrip title="Call graph" icon="references" onClose={() => setState((s) => { s.centerView = "editors"; })}>
			<div
				class="graph"
				ref={watchWidth}
				style={{ position: "relative" }}
				onKeyDown={(e) => {
					if ((e.ctrlKey || e.metaKey) && !e.altKey && e.key.toLowerCase() === "f") {
						e.preventDefault();
						e.stopPropagation();
						focusFinder?.();
						return;
					}
					if (e.key === "Escape" && (impactOpen() || legendOpen() || keysOpen())) {
						e.preventDefault();
						e.stopPropagation();
						setImpactOpen(false);
						setLegendOpen(false);
						setKeysOpen(false);
					}
				}}
			>
				<div class={["graph-bar", { narrow: narrow(), around: filter().mode === "around" }]}>
				{/* No title: the switch's first word is the view's name, and the bar needs the room. */}
				<div class="mode-switch" role="group" aria-label="Call graph: show the calls as">
					<button class={{ on: mode() === "graph" }} aria-pressed={mode() === "graph" ? "true" : "false"} onClick={() => choose("graph")}>
						Graph
					</button>
					<button class={{ on: mode() === "list" }} aria-pressed={mode() === "list" ? "true" : "false"} title="The same calls as a list, for the keyboard or a screen reader" onClick={() => choose("list")}>
						List
					</button>
				</div>
				{/* What is shown: the choice says so itself, so it needs no word beside it. */}
					<select class="graph-show" aria-label="Show" title={filter().focus && filter().mode === "around" ? `Around ${filter().focus}` : undefined} value={filter().mode} onChange={(e) => setFilter({ ...filter(), mode: e.currentTarget.value as Filter["mode"] })}>
						<option value="all">Every call</option>
						<option value="cross">Calls between scripts</option>
						{/* The focus goes by its name here, so the bar needs no second place to say it. */}
						<option value="around" disabled={!filter().focus}>
							{filter().focus ? `Around ${focusName()}` : "Around the focus"}
						</option>
					</select>
				<Show when={filter().mode === "around"}>
					<label>
						Depth{" "}
						<input
							type="number"
							min="1"
							max="6"
							value={depthDraft()}
							onInput={(e) => setDepthDraft(e.currentTarget.value)}
							onChange={(e) => {
								const next = Math.max(1, Math.min(6, Math.floor(Number(e.currentTarget.value)) || 1));
								setDepthDraft(String(next));
								e.currentTarget.value = String(next);
								setFilter((f) => ({ ...f, depth: next }));
							}}
						/>
					</label>
					<select aria-label="Which way from the focus" title="What the focus calls, what calls it, or both" value={filter().direction ?? "both"} onChange={(e) => setFilter({ ...filter(), direction: e.currentTarget.value as Direction })}>
						<option value="both">Callers and callees</option>
						<option value="callees">What it calls</option>
						<option value="callers">What calls it</option>
					</select>
				</Show>
				<Show when={graph()?.nodes.length}>
					{/* A procedure by name: the picture then shows it with what calls it and what it calls. */}
					<Finder
						choices={findable()}
						label="Find a procedure and show its callers and callees"
						title="Type a procedure's name: the graph shows the one you choose with what calls it and what it calls (Ctrl+F)"
						placeholder="Find a procedure…"
						none={(typed) => `No procedure's name has “${typed}” in it.`}
						onChoose={find}
						onRef={(fn) => (focusFinder = fn)}
						onEscape={() => {
							const el = nodeEls.get(cursor() ?? "");
							if (el?.isConnected) el.focus();
						}}
					/>
				</Show>
				<span class="spacer" />
				{/* How much there is: in the bar while it is being read or listed, beside the key under the picture otherwise. */}
				<Show when={progress() || mode() === "list" || !graph()?.nodes.length}>
					<span class="hint" role="status">
						{progress() || tally()}
					</span>
				</Show>
				<Show when={mode() === "graph" && !narrow()}>
					<div class="graph-zoom" role="group" aria-label="Zoom">
						<button title="Zoom out (−)" aria-label="Zoom out" onClick={() => zoomBy(1 / 1.2)}>
							<Icon name="remove" />
						</button>
						<button title="Reset the zoom to 100%" aria-label={`Zoom ${Math.round(view().scale * 100)}%. Reset to 100%`} onClick={() => zoomBy(1 / view().scale)}>
							{Math.round(view().scale * 100)}%
						</button>
						<button title="Zoom in (+)" aria-label="Zoom in" onClick={() => zoomBy(1.2)}>
							<Icon name="add" />
						</button>
					</div>
				</Show>
				<Show when={graph()?.nodes.length && (ticketHighlightKey() || state.settings.activeTicket?.trim())}>
					{(() => {
						const key = () => ticketHighlightKey()?.trim() || state.settings.activeTicket?.trim() || "";
						return (
							<button
								type="button"
								class={{ on: ticketSubgraphOnly() }}
								aria-pressed={ticketSubgraphOnly() ? "true" : "false"}
								title={
									ticketSubgraphOnly()
										? `Showing ${key()} scripts + 1-hop callers/callees. Click to show the full workspace graph.`
										: `Isolate ${key()} scripts plus 1-hop callers and callees`
								}
								onClick={toggleTicketSubgraph}
							>
								<Icon name={ticketSubgraphOnly() ? "filter-filled" : "filter"} />
								<Show when={!narrow()}>
									<span>{ticketSubgraphOnly() ? `${key()} (+1-hop)` : `Filter ${key()}`}</span>
								</Show>
							</button>
						);
					})()}
				</Show>
				<Show when={graph()?.nodes.length}>
					<button
						type="button"
						class={{ on: impactOpen() }}
						aria-expanded={impactOpen() ? "true" : "false"}
						title="Run transitive Impact / Blast-Radius Analysis across callers, callees, data sources, schemas, and docs"
						onClick={() => {
							if (impactOpen() && impactReport()) {
								setImpactOpen(false);
								return;
							}
							const key = ticketHighlightKey()?.trim() || state.settings.activeTicket?.trim() || "";
							if (key) void runTicketImpactAnalysis(key);
							else if (filter().focus) runImpactAnalysis([filter().focus!], focusName() || filter().focus!);
							else void runTicketImpactAnalysis();
						}}
					>
						<Icon name="flame" />
						<Show when={!narrow()}>
							<span>Impact</span>
						</Show>
					</button>
				</Show>
				<Show when={mode() === "graph" && legend().length}>
					<button
						class={["graph-legend-btn", { on: legendOpen() }]}
						aria-expanded={legendOpen() ? "true" : "false"}
						aria-controls={legendId}
						title="What the graph's shapes and lines mean"
						onClick={toggleLegend}
					>
						<Icon name="info" />
						<Show when={!narrow()}>
							<span>Legend</span>
						</Show>
					</button>
				</Show>
				<Show when={mode() === "graph"}>
					<button title="As much of the graph as stays legible; again for the whole of it, however small (0)" onClick={fitOrWhole}>
						Fit
					</button>
				</Show>
				{/* What is used now and then goes in a menu, so that the bar stays one row: folding, the key, the picture, reading again. */}
				<Menu label="More for the graph" title="More: fold, unresolved targets, keys, save picture, refresh" class="graph-more" items={more}>
					<Icon name="ellipsis" />
				</Menu>
			</div>
			<Show when={idle()}>
				{(why) => (
					<div class="graph-idle" role="status">
						<p>{why().text}</p>
						<Show when={why().hint}>
							<p class="hint">{why().hint}</p>
						</Show>
						<Show when={why().restart}>
							<button class="primary" onClick={() => void restartLsp()}>
								Restart the language server
							</button>
						</Show>
					</div>
				)}
			</Show>
			<Show when={graph()?.nodes.length}>
				<Show when={mode() === "graph"}>
					<Show when={!session.supports("ssl/callGraph")}>
						<p class="hint graph-help">Data sources and :INCLUDEs appear once the server offers its call graph.</p>
					</Show>
					<div class="graph-stage">
					<svg
						class="graph-canvas"
						ref={(el) => {
							svg = el;
							// The picture was moved by what the pointer was on: letting go of it there is not a click on it.
							el.addEventListener("click", (e) => panned > 3 && (e.stopPropagation(), (panned = 0)), true);
						}}
						role="group"
						aria-label="Call graph. The arrow keys move between nodes; the question mark key lists the rest."
						aria-describedby={keysOpen() ? keysId : undefined}
						onFocusOut={(e) => !e.currentTarget.contains(e.relatedTarget as Node | null) && setWalked(null)}
						onKeyDown={onKey}
						onWheel={(e) => {
							e.preventDefault();
							const box = e.currentTarget.getBoundingClientRect();
							zoomBy(e.deltaY < 0 ? 1.1 : 0.9, { x: e.clientX - box.left, y: e.clientY - box.top });
						}}
						onMouseDown={(e) => {
							if (e.button !== 0) return;
							dragging = { x: e.clientX, y: e.clientY };
							panned = 0;
						}}
						onMouseMove={(e) => {
							if (!dragging) return;
							if ((e.buttons & 1) === 0) {
								dragging = null;
								return;
							}
							const dx = e.clientX - dragging.x;
							const dy = e.clientY - dragging.y;
							panned += Math.abs(dx) + Math.abs(dy);
							setView((v) => ({ ...v, x: v.x + dx, y: v.y + dy }));
							dragging = { x: e.clientX, y: e.clientY };
						}}
						onMouseUp={() => (dragging = null)}
						onMouseLeave={() => (dragging = null)}
					>
						<defs>
							<For each={["plain", "cross", "class", "hot"]}>
								{(kind) => (
									<marker id={`arrow-${kind}`} viewBox="0 0 10 10" refX="9" refY="5" markerWidth="9" markerHeight="9" markerUnits="userSpaceOnUse" orient="auto-start-reverse">
										<path d="M0,1 L10,5 L0,9 z" class={`arrow ${kind}`} />
									</marker>
								)}
							</For>
						</defs>
						<Show when={layout()}>
							{(l) => (
								<g class={["g-root", { lit: lit() !== null || pointedLine() !== null, far: far() }]} transform={`translate(${view().x},${view().y}) scale(${view().scale})`}>
									<For each={l().boxes.filter((b) => b.kind === "folder" || b.kind === "script" || b.kind === "region")}>
										{(b) => (
											<g
												class={[
													`g-${b.kind}`,
													b.kind === "script" ? level(b.bytes ?? 0, state.settings.limits.bytes) : undefined,
													{ "ticket-lit": Boolean(b.kind === "script" && b.path && highlightedTicketPaths().has(b.path)) },
												]}
												onClick={(e) => far() && b.kind !== "region" && (e.stopPropagation(), comeIn(b))}
												onContextMenu={(e) => {
													if (b.kind !== "script" || !b.path || b.path === "(unresolved)") return;
													e.preventDefault();
													e.stopPropagation();
													openGraphNodeMenu(b, { x: e.clientX, y: e.clientY });
												}}
											>
												<Show when={b.kind === "script"}>
													{(() => {
														const gov = () => (b.path ? governingDocsByScript().get(b.path) : undefined);
														const tables = () => (b.path ? schemaTablesByScript().get(b.path) : undefined);
														return (
															<title>
																{`${[
																	b.path ?? b.label,
																	sizeNote(b.bytes ?? 0),
																	gov()?.length ? `${gov()!.length} governing ${gov()!.length === 1 ? "doc" : "docs"}` : "",
																	tables()?.length ? `tables: ${tables()!.slice(0, 6).map((t) => t.title || baseName(t.path).replace(/\.[^.]+$/, "")).join(", ")}` : "",
																]
																	.filter(Boolean)
																	.join(": ")}. Click its name to show only this script's calls.`}
															</title>
														);
													})()}
												</Show>
												<rect x={b.x} y={b.y} width={b.width} height={b.height} rx="8" style={b.region ? { stroke: `color-mix(in srgb, ${regionColor(b.region)} 55%, transparent)`, fill: `color-mix(in srgb, ${regionColor(b.region)} 7%, transparent)` } : undefined} />
												<Show when={b.kind === "folder" && folding()}>
													<g class="g-toggle" onClick={(e) => (e.stopPropagation(), toggleDir(b.folder))}>
														<title>Fold this folder to one node (Shift+X)</title>
														<rect x={b.x + 6} y={b.y + 7} width="18" height="18" rx="4" />
														<path d={`M${b.x + 11},${b.y + 14} l4,4 l4,-4`} />
													</g>
												</Show>
												<Show when={b.kind === "script" && folding()}>
													<g class="g-toggle" onClick={(e) => (e.stopPropagation(), toggleFold(b.path))}>
														<title>Fold this script to one node (X)</title>
														<rect x={b.x + 4} y={b.y + 5} width="18" height="18" rx="4" />
														<path d={`M${b.x + 9},${b.y + 12} l4,4 l4,-4`} />
													</g>
												</Show>
												{(() => {
													const leftPad = () => (b.kind === "script" && folding() ? 26 : b.kind === "folder" ? (folding() ? 30 : 14) : 10);
													const docCount = () => (!far() && b.kind === "script" && b.path ? (governingDocsByScript().get(b.path)?.length ?? 0) : 0);
													const rightReserve = () => (docCount() > 0 ? 24 + (String(docCount()).length - 1) * 5.5 + 14 : 10);
													const fitted = () => {
														const avail = Math.max(40, b.width - leftPad() - rightReserve());
														const sizeText = b.kind === "script" ? `  ${sizeNote(b.bytes ?? 0)}` : "";
														if (b.kind !== "script" || measureBold(b.label) + measure(sizeText) <= avail) {
															return { label: b.label, size: sizeText };
														}
														if (measureBold(b.label) <= avail) return { label: b.label, size: "" };
														// Truncate cleanly with ellipsis so header text never overlaps the doc pill or adjacent boxes.
														let lo = 1;
														let hi = b.label.length;
														while (lo < hi) {
															const mid = Math.ceil((lo + hi) / 2);
															if (measureBold(`${b.label.slice(0, mid)}…`) <= avail) lo = mid;
															else hi = mid - 1;
														}
														return { label: `${b.label.slice(0, Math.max(1, lo))}…`, size: "" };
													};
													return (
														<text x={b.x + leftPad()} y={b.y + (b.kind === "folder" ? 21 : 18)} onClick={() => b.kind === "script" && focus(`${b.path}#`)}>
															{fitted().label}
															<Show when={fitted().size}>
																<tspan class="g-size">{fitted().size}</tspan>
															</Show>
														</text>
													);
												})()}
												<Show when={!far() && b.kind === "script" && b.path && (governingDocsByScript().get(b.path)?.length ?? 0) > 0}>
													{(() => {
														const gov = () => governingDocsByScript().get(b.path!) ?? [];
														const count = () => gov().length;
														const pillW = () => 24 + (String(count()).length - 1) * 5.5;
														const px = () => b.x + b.width - pillW() - 6;
														const py = () => b.y + 5;
														return (
															<g
																class="g-doc-pill"
																style={{ cursor: "pointer" }}
																onMouseDown={(e) => e.stopPropagation()}
																onClick={(e) => {
																	e.stopPropagation();
																	const rect = (e.currentTarget as SVGGElement).getBoundingClientRect();
																	openGraphNodeMenu(b, { x: Math.round(rect.left), y: Math.round(rect.bottom + 2) });
																}}
															>
																<title>{`${count()} governing ${count() === 1 ? "doc" : "docs"}: ${gov().map((g) => g.file.title || g.file.name).join(", ")}. Click to open.`}</title>
																<rect
																	x={px()}
																	y={py()}
																	width={pillW()}
																	height="16"
																	rx="8"
																	style={{
																		fill: "color-mix(in srgb, var(--accent) 12%, var(--side-bg))",
																		stroke: "color-mix(in srgb, var(--accent) 45%, var(--border))",
																		"stroke-width": "1",
																	}}
																/>
																<text
																	x={px() + 5.5}
																	y={py() + 11.5}
																	style={{ font: "normal 10px/1 codicon", fill: "var(--accent)", "pointer-events": "none" }}
																>
																	{ICON.file}
																</text>
																<text
																	x={px() + pillW() - 5.5}
																	y={py() + 11.5}
																	text-anchor="end"
																	style={{ font: "600 10px var(--ui-font)", fill: "var(--accent)", "pointer-events": "none" }}
																>
																	{count()}
																</text>
															</g>
														);
													})()}
												</Show>
											</g>
										)}
									</For>
									<For each={l().lines}>
										{(e) => (
											<g class="g-line" onMouseEnter={() => setPointedLine(e.id)} onMouseLeave={() => setPointedLine(null)}>
												<title>{e.title}</title>
												<path d={e.d} class="g-edge-hit" />
												<path
													d={e.d}
													class={["g-edge", e.relation !== "call" ? e.relation : undefined, { cross: e.cross && e.relation === "call", hot: isHot(e) }]}
													marker-end={arrowOf(e)}
													style={{ "--w": `${lineWidth(e.count)}px` }}
												/>
												<Show when={e.badge}>
													{(at) => (
														<g class={["g-count", { hot: isHot(e) }]}>
															<rect x={at().x} y={at().y} width={at().width} height={at().height} rx="8" />
															<text x={at().x + at().width / 2} y={at().y + 12} text-anchor="middle">
																{e.count}
															</text>
														</g>
													)}
												</Show>
											</g>
										)}
									</For>
									<For each={l().boxes.filter((b) => b.kind === "proc" || b.kind === "top" || b.kind === "fold" || b.kind === "dir")}>
										{(b) => (
											<g
												class={[
													b.kind === "dir" ? "g-fold g-dir" : `g-${b.kind} ${b.nodeKind ?? ""}`,
													b.kind === "fold" ? level(b.bytes ?? 0, state.settings.limits.bytes) : undefined,
													{
														focus: filter().focus === b.id || (b.kind === "fold" && filter().focus === `${b.path}#`),
														lit: lit() === b.id,
														"ticket-lit": Boolean(
															(b.path && highlightedTicketPaths().has(b.path)) ||
																(b.kind === "dir" && b.folder && highlightedTicketFolders().has(b.folder)),
														),
														beside: beside().has(b.id),
														class: Boolean(b.isClass),
													},
												]}
												ref={(el) => nodeEls.set(b.id, el)}
												tabindex={cursor() === b.id ? 0 : -1}
												role="button"
												aria-label={titleOf(b)}
												aria-expanded={b.kind === "fold" || b.kind === "dir" ? "false" : undefined}
												onFocus={() => setCurrent(b.id)}
												onMouseEnter={() => setPointed(b.id)}
												onMouseLeave={() => setPointed(null)}
												onClick={(e) => (e.stopPropagation(), far() ? comeIn(b) : b.kind === "dir" ? toggleDir(b.folder) : b.kind === "fold" ? toggleFold(b.path) : focus(b.id))}
												onDblClick={() => b.kind !== "fold" && b.kind !== "dir" && open(b)}
												onContextMenu={(e) => {
													if (b.kind === "dir" || !b.path || b.path === "(unresolved)") return;
													e.preventDefault();
													e.stopPropagation();
													openGraphNodeMenu(b, { x: e.clientX, y: e.clientY });
												}}
											>
												<Show
													when={b.kind === "fold" || b.kind === "dir"}
													fallback={
														<>
															<title>{`${titleOf(b)}. Enter or a double-click opens it; F or a click shows only its callers and callees.`}</title>
															<rect x={b.x} y={b.y} width={b.width} height={b.height} rx="5" />
															<text x={b.x + b.width / 2} y={b.y + 18} text-anchor="middle">
																{b.label}
															</text>
														</>
													}
												>
													<title>{`${titleOf(b)}. Enter or a click unfolds it${b.kind === "dir" ? "" : "; F shows only its calls"}.`}</title>
													<rect x={b.x} y={b.y} width={b.width} height={b.height} rx="8" />
													<path class="g-chevron" d={`M${b.x + 12},${b.y + 13} l4,4 l-4,4`} />
													<text class="g-fold-name" x={b.x + 26} y={b.y + 20}>
														{b.label}
													</text>
													<text class="g-fold-note" x={b.x + 26} y={b.y + 36}>
														{b.note}
													</text>
													<Show when={!far() && b.kind === "fold" && b.path && (governingDocsByScript().get(b.path)?.length ?? 0) > 0}>
														{(() => {
															const gov = () => governingDocsByScript().get(b.path!) ?? [];
															const count = () => gov().length;
															const pillW = () => 24 + (String(count()).length - 1) * 5.5;
															const px = () => b.x + b.width - pillW() - 6;
															const py = () => b.y + 6;
															return (
																<g
																	class="g-doc-pill"
																	style={{ cursor: "pointer" }}
																	onMouseDown={(e) => e.stopPropagation()}
																	onClick={(e) => {
																		e.stopPropagation();
																		const rect = (e.currentTarget as SVGGElement).getBoundingClientRect();
																		openGraphNodeMenu(b, { x: Math.round(rect.left), y: Math.round(rect.bottom + 2) });
																	}}
																>
																	<title>{`${count()} governing ${count() === 1 ? "doc" : "docs"}: ${gov().map((g) => g.file.title || g.file.name).join(", ")}. Click to open.`}</title>
																	<rect
																		x={px()}
																		y={py()}
																		width={pillW()}
																		height="16"
																		rx="8"
																		style={{
																			fill: "color-mix(in srgb, var(--accent) 12%, var(--side-bg))",
																			stroke: "color-mix(in srgb, var(--accent) 45%, var(--border))",
																			"stroke-width": "1",
																		}}
																	/>
																	<text
																		x={px() + 5.5}
																		y={py() + 11.5}
																		style={{ font: "normal 10px/1 codicon", fill: "var(--accent)", "pointer-events": "none" }}
																	>
																		{ICON.file}
																	</text>
																	<text
																		x={px() + pillW() - 5.5}
																		y={py() + 11.5}
																		text-anchor="end"
																		style={{ font: "600 10px var(--ui-font)", fill: "var(--accent)", "pointer-events": "none" }}
																	>
																		{count()}
																	</text>
																</g>
															);
														})()}
													</Show>
												</Show>
											</g>
										)}
									</For>
									{/* Far out, the names of scripts and folders over the picture, at a size that reads: in a script's middle, and above a folder. */}
									<Show when={far()}>
										<g class="g-far" aria-hidden="true">
											<For each={farNames()}>
												{(name) => (
													<text
														class={{ folder: name.item.kind === "folder" }}
														x={name.item.kind === "folder" ? name.x : name.x + name.width / 2}
														y={name.y + name.size * 0.95}
														text-anchor={name.item.kind === "folder" ? "start" : "middle"}
														style={{ "font-size": `${name.size}px`, "stroke-width": `${name.size * 0.28}px` }}
													>
														{name.item.label}
													</text>
												)}
											</For>
										</g>
									</Show>
								</g>
							)}
						</Show>
					</svg>
					<div class="plan-keys graph-legend-pop" id={legendId} role="group" aria-label="What the graph's shapes and lines mean" hidden={!legendOpen()}>
						<div class="graph-legend-head">
							<strong>Legend</strong>
							<Show when={!progress() && tally()}>
								<span class="hint">{tally()}</span>
							</Show>
							<button class="graph-legend-close" aria-label="Close legend" onClick={() => setLegendOpen(false)}>
								<Icon name="close" />
							</button>
						</div>
						<ul class="graph-legend">
							<For each={legend()}>
								{(entry) => (
									<li>
										<svg class="graph-key" viewBox="0 0 26 14" aria-hidden="true">
											<Show when={entry.shape === "box"} fallback={<path class={entry.cls} d="M1,7 L25,7" />}>
												<g class={entry.cls}>
													<rect x="1.5" y="1.5" width="23" height="11" rx="3" />
												</g>
											</Show>
										</svg>
										<span>{entry.words}</span>
									</li>
								)}
							</For>
						</ul>
					</div>
					<Show when={keysOpen()}>
						<div class="plan-keys" id={keysId} role="group" aria-label="The graph's keys">
							<dl>
								<For each={GRAPH_KEYS}>
									{([keys, what]) => (
										<>
											<dt>{keys}</dt>
											<dd>{what}</dd>
										</>
									)}
								</For>
							</dl>
						</div>
					</Show>
					{/* Not read out: each node and line says the same of itself to a screen reader. */}
					<Show
						when={said()}
						fallback={
							<Show when={!progress() && tally()}>
								<p class="graph-said graph-tally-badge" role="status">
									{tally()}
								</p>
							</Show>
						}
					>
						<p class="graph-said" aria-hidden="true">
							{said()}
						</p>
					</Show>
					<Show when={layout()}>
						{(l) => (
							<Minimap
								content={l()}
								boxes={l().boxes.map((b): MapBox => ({ x: b.x, y: b.y, width: b.width, height: b.height, kind: b.kind === "folder" || b.kind === "script" || b.kind === "region" ? "frame" : filter().focus === b.id ? "mark" : "node" }))}
								view={view()}
								host={() => svg}
								onMove={setView}
							/>
						)}
					</Show>
					</div>
				</Show>
				<Show when={mode() === "list"}>
					<div class="graph-list">
						<p class="hint">{around() ? "What calls the focus, and what it calls. A name opens the code; Focus moves the focus to that procedure." : "Each script, its callers, and what each calls, creates or inherits. A name opens the code; Focus shows only that procedure's callers and callees."}</p>
						<Show when={around()}>
							{(a) => {
								const focusPath = () => scriptOf(filter().focus ?? "");
								const canMenu = () => Boolean(focusPath() && focusPath() !== UNRESOLVED);
								const govDocs = () => (canMenu() ? governingDocsByScript().get(focusPath()) : undefined);
								return (
									<div class="graph-around">
										<h3
											class="graph-list-head"
											tabindex={canMenu() ? 0 : undefined}
											onKeyDown={(e) => {
												if (!canMenu()) return;
												if (e.key === "ContextMenu" || (e.shiftKey && e.key === "F10")) {
													e.preventDefault();
													e.stopPropagation();
													const rect = e.currentTarget.getBoundingClientRect();
													openGraphNodeMenu(
														{ kind: "script", path: focusPath(), label: rel(focusPath()) },
														{ x: Math.round(rect.left + 16), y: Math.round(rect.bottom + 2) },
													);
												}
											}}
											onContextMenu={(e) => {
												if (!canMenu()) return;
												e.preventDefault();
												e.stopPropagation();
												openGraphNodeMenu({ kind: "script", path: focusPath(), label: rel(focusPath()) }, { x: e.clientX, y: e.clientY });
											}}
										>
											{focusName()}
											<span class="hint">{rel(focusPath())}</span>
											<Show when={canMenu() && highlightedTicketPaths().has(focusPath()) && ticketHighlightKey()}>
												<span class="graph-list-ticket-badge">{ticketHighlightKey()}</span>
											</Show>
											<Show when={govDocs()}>
												{(gov) => (
													<button
														type="button"
														class="graph-list-docs"
														title={`Open governing docs (${gov().length}) or script actions for ${rel(focusPath())}`}
														aria-label={`Docs (${gov().length}) for ${rel(focusPath())}`}
														onClick={(e) => {
															e.stopPropagation();
															const rect = e.currentTarget.getBoundingClientRect();
															openGraphNodeMenu(
																{ kind: "script", path: focusPath(), label: rel(focusPath()) },
																{ x: Math.round(rect.left), y: Math.round(rect.bottom + 2) },
															);
														}}
													>
														Docs ({gov().length})
													</button>
												)}
											</Show>
										</h3>
									<div class="graph-around-cols">
										<For each={[["Called by", a().callers, "callees", "Nothing shown here calls it."], ["Calls", a().callees, "callers", "It calls nothing shown here."]] as const}>
											{([title, links, hiddenBy, none]) => (
												<Show when={filter().direction !== hiddenBy}>
													<section>
														<h4>
															{title} <span class="count">{links.length}</span>
														</h4>
														<Show when={links.length} fallback={<p class="hint">{none}</p>}>
															<ul>
																<For each={links}>
																	{(link) => (
																		<li>
																			<Proc proc={link.other} />
																			<span class="hint">{linkNote(link)}</span>
																		</li>
																	)}
																</For>
															</ul>
														</Show>
													</section>
												</Show>
											)}
										</For>
									</div>
									<Show when={filter().depth > 1}>
										<h3 class="graph-around-rest">Every call within {filter().depth} steps</h3>
									</Show>
								</div>
								);
							}}
						</Show>
						<Show when={list().length} fallback={<p>No calls to show. Choose "Every call" above to see them all.</p>}>
							<For each={filter().mode === "around" && filter().depth <= 1 ? [] : list()}>
								{(script) => {
									const isRealScript = Boolean(script.path && script.path !== UNRESOLVED);
									const govDocs = () => (isRealScript ? governingDocsByScript().get(script.path) : undefined);
									return (
										<section class={{ "ticket-lit": isRealScript && highlightedTicketPaths().has(script.path) }}>
											<h3
												class="graph-list-head"
												tabindex={isRealScript ? 0 : undefined}
												aria-label={
													isRealScript
														? `${rel(script.path)}${highlightedTicketPaths().has(script.path) && ticketHighlightKey() ? `, governed by ${ticketHighlightKey()}` : ""}. Press Shift+F10 for script and document actions.`
														: undefined
												}
												onKeyDown={(e) => {
													if (!isRealScript) return;
													if (e.key === "ContextMenu" || (e.shiftKey && e.key === "F10")) {
														e.preventDefault();
														e.stopPropagation();
														const rect = e.currentTarget.getBoundingClientRect();
														openGraphNodeMenu(
															{ kind: "script", path: script.path, label: rel(script.path) },
															{ x: Math.round(rect.left + 16), y: Math.round(rect.bottom + 2) },
														);
													}
												}}
												onContextMenu={(e) => {
													if (!isRealScript) return;
													e.preventDefault();
													e.stopPropagation();
													openGraphNodeMenu({ kind: "script", path: script.path, label: rel(script.path) }, { x: e.clientX, y: e.clientY });
												}}
											>
												{rel(script.path)}
												<Show when={graph()!.scripts.find((s) => s.path === script.path)}>{(s) => <span class="hint">{sizeNote(s().bytes)}</span>}</Show>
												<Show when={isRealScript && highlightedTicketPaths().has(script.path) && ticketHighlightKey()}>
													<span class="graph-list-ticket-badge">{ticketHighlightKey()}</span>
												</Show>
												<button type="button" class="graph-list-focus" title={`Show only the calls into and out of ${rel(script.path)}`} aria-label={`Focus ${rel(script.path)}`} onClick={() => focus(`${script.path}#`)}>
													Focus
												</button>
												<Show when={govDocs()}>
													{(gov) => (
														<button
															type="button"
															class="graph-list-docs"
															title={`Open governing docs (${gov().length}) or script actions for ${rel(script.path)}`}
															aria-label={`Docs (${gov().length}) for ${rel(script.path)}`}
															onClick={(e) => {
																e.stopPropagation();
																const rect = e.currentTarget.getBoundingClientRect();
																openGraphNodeMenu(
																	{ kind: "script", path: script.path, label: rel(script.path) },
																	{ x: Math.round(rect.left), y: Math.round(rect.bottom + 2) },
																);
															}}
														>
															Docs ({gov().length})
														</button>
													)}
												</Show>
											</h3>
											<ul>
												<For each={script.callers}>
													{(caller) => (
														<li>
															<Proc proc={caller} />
															<ul>
																<For each={caller.calls}>
																	{(call) => (
																		<li>
																			<span class="hint">{RELATION_WORDS[call.relation]}</span> <Proc proc={call} />
																			<span class="hint">
																				{[call.kind === "procedure" || call.kind === "class" ? "" : KIND_WORDS[call.kind], call.crossScript && call.path !== UNRESOLVED ? `in ${rel(call.path)}` : "", call.count > 1 ? `from ${call.count} places` : ""].filter(Boolean).join(", ")}
																			</span>
																		</li>
																	)}
																</For>
															</ul>
														</li>
													)}
												</For>
											</ul>
										</section>
									);
								}}
							</For>
						</Show>
					</div>
				</Show>
			</Show>
			<Show when={impactOpen() && impactReport()} keyed>
				{(report) => {
					const targetTicket = () => impactSeeds()?.ticketKey?.trim() || state.settings.activeTicket?.trim() || ticketHighlightKey()?.trim() || "";
					const renderImpactRow = (n: ImpactNode) => (
						<li
							style={{
								display: "flex",
								"align-items": "center",
								gap: "6px",
								padding: "3px 0",
								"font-size": "var(--text-sm)",
							}}
						>
							<button
								type="button"
								class="link"
								style={{
									"min-width": "0",
									overflow: "hidden",
									"text-overflow": "ellipsis",
									"white-space": "nowrap",
									"text-align": "left",
								}}
								title={`Open ${n.name} in ${rel(n.path)}`}
								onClick={() => open(n)}
							>
								{n.name}
							</button>
							<Show when={n.entryPoint}>
								<span
									class="graph-list-ticket-badge"
									title="Entry point: no upstream callers in the workspace call graph"
								>
									Entry
								</span>
							</Show>
							<span
								class="hint"
								style={{
									"margin-left": "auto",
									"font-size": "var(--text-xs)",
									overflow: "hidden",
									"text-overflow": "ellipsis",
									"white-space": "nowrap",
									"max-width": "130px",
								}}
								title={rel(n.path)}
							>
								{baseName(n.path)}
							</span>
							<button
								type="button"
								class="graph-list-focus"
								title={`Focus ${n.name} in Call Graph`}
								onClick={() => {
									setMode("graph");
									focus(n.id);
								}}
							>
								Focus
							</button>
						</li>
					);
					return (
						<aside
							role="dialog"
							aria-label={`Impact analysis for ${report.targetLabel || "selection"}`}
							onKeyDown={(e) => {
								if (e.key === "Escape") {
									e.stopPropagation();
									setImpactOpen(false);
								}
							}}
							style={{
								position: "absolute",
								top: "46px",
								right: "12px",
								bottom: "12px",
								width: "min(400px, calc(100% - 24px))",
								"z-index": "15",
								display: "flex",
								"flex-direction": "column",
								background: "var(--side-bg)",
								color: "var(--side-fg, var(--fg))",
								border: "1px solid var(--input-border)",
								"border-radius": "var(--radius-lg)",
								"box-shadow": "var(--shadow)",
								overflow: "hidden",
							}}
						>
							<div
								style={{
									display: "flex",
									"align-items": "center",
									gap: "8px",
									padding: "10px 12px",
									"border-bottom": "1px solid var(--border)",
									background: "var(--panel-bg)",
								}}
							>
								<Icon name="flame" />
								<div style={{ "min-width": "0", flex: "1" }}>
									<div style={{ "font-weight": "600", "font-size": "var(--text-md)", color: "var(--strong-fg)" }}>
										Impact Analysis
									</div>
									<div
										class="hint"
										style={{
											"font-size": "var(--text-xs)",
											overflow: "hidden",
											"text-overflow": "ellipsis",
											"white-space": "nowrap",
										}}
										title={report.targetLabel}
									>
										{report.targetLabel || plural(report.seedScripts.length, "script")}
									</div>
								</div>
								<label
									style={{
										display: "inline-flex",
										"align-items": "center",
										gap: "4px",
										"font-size": "var(--text-xs)",
										color: "var(--muted)",
									}}
									title="Maximum transitive BFS hop depth"
								>
									Hops
									<input
										type="number"
										min="1"
										max="6"
										value={hopsDraft()}
										style={{ width: "42px", padding: "2px 4px", "font-size": "var(--text-xs)" }}
										onInput={(e) => setHopsDraft(e.currentTarget.value)}
										onChange={(e) => {
											const next = Math.max(1, Math.min(6, Math.floor(Number(e.currentTarget.value)) || 4));
											setHopsDraft(String(next));
											e.currentTarget.value = String(next);
											setImpactHops(next);
											const seeds = impactSeeds();
											if (seeds) runImpactAnalysis(seeds.ids, seeds.label, { ticketKey: seeds.ticketKey, hops: next });
										}}
									/>
								</label>
								<button
									type="button"
									class="graph-legend-close"
									aria-label="Close impact analysis"
									title="Close (Esc)"
									onClick={() => setImpactOpen(false)}
								>
									<Icon name="close" />
								</button>
							</div>

							<div
								style={{
									display: "flex",
									"flex-wrap": "wrap",
									"align-items": "center",
									gap: "6px",
									padding: "8px 12px",
									"border-bottom": "1px solid var(--border)",
								}}
							>
								<button
									type="button"
									class="graph-list-docs"
									style={{ "margin-left": "0", padding: "3px 8px" }}
									title="Copy ADR 0008-compliant Markdown impact summary to clipboard"
									onClick={() => void copyImpactMarkdown()}
								>
									<Icon name="copy" />
									<span>Copy Markdown</span>
								</button>
								<button
									type="button"
									class="graph-list-docs"
									style={{ "margin-left": "0", padding: "3px 8px" }}
									title={targetTicket() ? `Append Markdown impact summary to ${targetTicket()}` : "Pick a ticket to append this impact summary to"}
									onClick={() => void appendImpactToTicket()}
								>
									<Icon name="add" />
									<span>{targetTicket() ? `Append to ${targetTicket()}` : "Append to ticket…"}</span>
								</button>
							</div>

							<div
								style={{
									display: "flex",
									"flex-wrap": "wrap",
									gap: "6px",
									padding: "8px 12px",
									"border-bottom": "1px solid var(--border)",
									"font-size": "var(--text-xs)",
								}}
							>
								<span class="graph-list-ticket-badge">
									{plural(report.upstream.length, "caller")} ({plural(report.entryPoints.length, "entry", "entries")})
								</span>
								<span class="graph-list-docs" style={{ "margin-left": "0" }}>
									{plural(report.downstream.length, "callee")}
								</span>
								<span class="graph-list-docs" style={{ "margin-left": "0" }}>
									{plural(report.dataSources.length, "data source")}
								</span>
								<span class="graph-list-docs" style={{ "margin-left": "0" }}>
									{plural(report.affectedScripts.length, "script")}
								</span>
							</div>

							<div style={{ flex: "1", "overflow-y": "auto", padding: "10px 12px", display: "flex", "flex-direction": "column", gap: "12px" }}>
								<section>
									<h4 style={{ margin: "0 0 6px", "font-size": "var(--text-sm)", "font-weight": "600", color: "var(--strong-fg)", display: "flex", "align-items": "center", gap: "5px" }}>
										<Icon name="arrow-up" />
										<span>Upstream Callers ({report.upstream.length})</span>
									</h4>
									<Show when={report.upstreamByHop.length > 0} fallback={<p class="hint" style={{ margin: "0" }}>No upstream callers in the call graph.</p>}>
										<For each={report.upstreamByHop}>
											{(group) => (
												<div style={{ "margin-bottom": "6px" }}>
													<div class="hint" style={{ "font-size": "var(--text-xs)", "font-weight": "600", "margin-bottom": "2px" }}>
														Hop {group.hop} ({group.nodes.length})
													</div>
													<ul style={{ "list-style": "none", margin: "0", padding: "0" }}>
														<For each={group.nodes}>{renderImpactRow}</For>
													</ul>
												</div>
											)}
										</For>
									</Show>
								</section>

								<section>
									<h4 style={{ margin: "0 0 6px", "font-size": "var(--text-sm)", "font-weight": "600", color: "var(--strong-fg)", display: "flex", "align-items": "center", gap: "5px" }}>
										<Icon name="arrow-down" />
										<span>Downstream Callees ({report.downstream.length})</span>
									</h4>
									<Show when={report.downstreamByHop.length > 0} fallback={<p class="hint" style={{ margin: "0" }}>No downstream procedure callees.</p>}>
										<For each={report.downstreamByHop}>
											{(group) => (
												<div style={{ "margin-bottom": "6px" }}>
													<div class="hint" style={{ "font-size": "var(--text-xs)", "font-weight": "600", "margin-bottom": "2px" }}>
														Hop {group.hop} ({group.nodes.length})
													</div>
													<ul style={{ "list-style": "none", margin: "0", padding: "0" }}>
														<For each={group.nodes}>{renderImpactRow}</For>
													</ul>
												</div>
											)}
										</For>
									</Show>
								</section>

								<Show when={report.dataSources.length > 0}>
									<section>
										<h4 style={{ margin: "0 0 6px", "font-size": "var(--text-sm)", "font-weight": "600", color: "var(--strong-fg)", display: "flex", "align-items": "center", gap: "5px" }}>
											<Icon name="database" />
											<span>Data Sources ({report.dataSources.length})</span>
										</h4>
										<ul style={{ "list-style": "none", margin: "0", padding: "0" }}>
											<For each={report.dataSources}>{renderImpactRow}</For>
										</ul>
									</section>
								</Show>

								<section>
									<h4 style={{ margin: "0 0 6px", "font-size": "var(--text-sm)", "font-weight": "600", color: "var(--strong-fg)", display: "flex", "align-items": "center", gap: "5px" }}>
										<Icon name="table" />
										<span>Schema Tables ({report.schemaTables?.length ?? 0})</span>
									</h4>
									<Show
										when={(report.schemaTables?.length ?? 0) > 0}
										fallback={
											<p class="hint" style={{ margin: "0" }}>
												{impactScanning() ? "Scanning referenced schema tables…" : "No documented schema tables referenced."}
											</p>
										}
									>
										<div style={{ display: "flex", "flex-wrap": "wrap", gap: "4px" }}>
											<For each={report.schemaTables ?? []}>
												{(tbl) => (
													<button
														type="button"
														class="graph-list-docs"
														style={{ "margin-left": "0" }}
														title={tbl.path ? `Open schema doc: ${rel(tbl.path)}` : tbl.name}
														onClick={() => tbl.path && void openFile(tbl.path)}
													>
														<Icon name="database" />
														<span>{tbl.name}</span>
													</button>
												)}
											</For>
										</div>
									</Show>
								</section>

								<section>
									<h4 style={{ margin: "0 0 6px", "font-size": "var(--text-sm)", "font-weight": "600", color: "var(--strong-fg)", display: "flex", "align-items": "center", gap: "5px" }}>
										<Icon name="file" />
										<span>Governing Docs &amp; Tickets ({report.governingDocs?.length ?? 0})</span>
									</h4>
									<Show when={(report.governingDocs?.length ?? 0) > 0} fallback={<p class="hint" style={{ margin: "0" }}>No linked specs, decisions, or tickets.</p>}>
										<ul style={{ "list-style": "none", margin: "0", padding: "0", display: "flex", "flex-direction": "column", gap: "4px" }}>
											<For each={report.governingDocs ?? []}>
												{(doc) => (
													<li style={{ display: "flex", "align-items": "center", gap: "6px", "font-size": "var(--text-sm)" }}>
														<button
															type="button"
															class="link"
															style={{ "min-width": "0", overflow: "hidden", "text-overflow": "ellipsis", "white-space": "nowrap", "text-align": "left" }}
															title={`Open ${rel(doc.path)}`}
															onClick={() => void openGoverningDoc(doc.path, report.seedScripts[0])}
														>
															{doc.label}
														</button>
														<Show when={doc.reason}>
															<span class="hint" style={{ "margin-left": "auto", "font-size": "var(--text-xs)", "white-space": "nowrap" }}>
																{doc.reason}
															</span>
														</Show>
													</li>
												)}
											</For>
										</ul>
									</Show>
								</section>

								<Show when={(report.testScripts?.length ?? 0) > 0}>
									<section>
										<h4 style={{ margin: "0 0 6px", "font-size": "var(--text-sm)", "font-weight": "600", color: "var(--strong-fg)", display: "flex", "align-items": "center", gap: "5px" }}>
											<Icon name="beaker" />
											<span>Linked Test Scripts ({report.testScripts!.length})</span>
										</h4>
										<ul style={{ "list-style": "none", margin: "0", padding: "0", display: "flex", "flex-direction": "column", gap: "4px" }}>
											<For each={report.testScripts!}>
												{(ts) => (
													<li style={{ "font-size": "var(--text-sm)" }}>
														<button
															type="button"
															class="link"
															title={`Open test script ${ts}`}
															onClick={() => {
																if (!state.workspace?.root) return;
																const full = isInside(state.workspace.root, ts) ? ts : joinPath(state.workspace.root, ts);
																void openFile(full);
															}}
														>
															{ts}
														</button>
													</li>
												)}
											</For>
										</ul>
									</section>
								</Show>
							</div>
						</aside>
					);
				}}
			</Show>
			</div>
		</CenterTabStrip>
	);
}
