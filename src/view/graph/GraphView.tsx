// Graph mode: scripts as boxes, regions inside them, procedures as nodes,
// calls as edges, laid out by ELK. A large workspace opens with its scripts
// folded, each one node, and a script unfolds to its procedures. Pointing at a
// node, or moving to it with the keys, lights its calls and dims the rest.
// Click a procedure, or press F on it, to focus its neighbourhood;
// double-click it, or press Enter, to open it. The same calls can be read as
// a plain list.
import ELK from "elkjs/lib/elk.bundled.js";
import { createEffect, createMemo, createSignal, createUniqueId, For, on, Show } from "solid-js";
import { level } from "../../shared/houseStyle";
import { backend } from "../backend";
import { regionColor } from "../editor/regions";
import { openFile, setState, state } from "../state";
import { canvasMeasure, clearOf, fitShare, fitView, legibleScale, mapArea, outOfSight, nearest, recall, remember, reveal, splinePath, splinePoint, zoomAt, type Point } from "./canvas";
import { loadGraph } from "./load";
import { Minimap, type MapBox } from "./Minimap";
import { Finder } from "./Finder";
import { Menu, type MenuItem } from "../Menu";
import { savePicture } from "./picture";
import { session } from "../lsp/session";
import { callList, choices, dirId, keptFolds, withoutUnresolved, fold, FOLD_ABOVE, FOLD_DIRS_ABOVE, foldId, isDir, isFold, RELATION_WORDS, scriptOf, topLabel, UNRESOLVED, visible, type Direction, type Filter, type Graph, type ListedProc, relationOf, type Relation } from "./model";
import { baseName, dirName, relativeTo } from "../../shared/paths";

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
type Line = { id: string; d: string; from: string; to: string; cross: boolean; count: number; relation: Relation; title: string; /** Where the number of places is written, when it is more than one. */ badge?: { x: number; y: number; width: number; height: number } };
type Mode = "graph" | "list";

const elk = new ELK();
// The size the style sheet gives the graph's words (.graph-canvas text), and a script's name in bold.
const FONT_PX = 13;
const measure = canvasMeasure(`${FONT_PX}px system-ui, sans-serif`, FONT_PX);
const measureBold = canvasMeasure(`600 ${FONT_PX}px system-ui, sans-serif`, FONT_PX);
const textWidth = (s: string) => Math.max(60, Math.ceil(measure(s)) + 24);
/** Fit never draws the words smaller than can be read; a larger graph is panned. */
const FIT_FLOOR = legibleScale(FONT_PX);
const MIN_ZOOM = 0.15;
const MAX_ZOOM = 3;
const MODE_KEY = "graph.view";
const FOLDS_KEY = "graph.folds";
const UNRESOLVED_KEY = "graph.unresolved";
/** A folded script's node: room for its name and, under it, what is inside. */
const FOLD_HEIGHT = 46;
/** A line's width for the number of places it stands for: each doubling adds the same, up to a limit that stays a line. */
const lineWidth = (count: number) => Math.min(3.4, 1 + Math.log2(Math.max(1, count)) * 0.6);
/** The graph's keys and what the pointer does, as its Keys button lists them. */
const GRAPH_KEYS: readonly (readonly [keys: string, what: string])[] = [
	["Arrow keys", "Move between nodes; the calls of the one you are on are lit"],
	["Enter", "Open a procedure; unfold a folded script or folder"],
	["F", "Show only the node's callers and callees"],
	["X", "Fold a script to one node, or unfold it"],
	["Shift+X", "Fold the script's folder to one node, or unfold it"],
	["+, −, 0", "Zoom in, zoom out, fit"],
	["?", "Show or hide this list"],
	["Pointer", "Point at a node or a line to light it; click a node to focus on it, double-click to open it; drag to move, the wheel zooms"],
];
/** A picture of up to this many nodes is laid out both across and down, to keep the one that fits the view better. */
const BOTH_WAYS_UP_TO = 150;
/** How far along a line its number of places is written. */
const BADGE_AT = 30;
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

const KIND_WORDS: Record<string, string> = { procedure: "procedure", datasource: "data source", unresolved: "a target the language server could not resolve", top: "code outside any procedure", class: "the class itself" };

export function GraphView() {
	const [graph, setGraph] = createSignal<(Graph & { truncated: boolean }) | null>(null);
	const [progress, setProgress] = createSignal("");
	const [failed, setFailed] = createSignal("");
	const [filter, setFilter] = createSignal<Filter>({ mode: "all", depth: 1 });
	const [layout, setLayout] = createSignal<{ boxes: Box[]; lines: Line[]; width: number; height: number } | null>(null);
	const [view, setView] = createSignal({ x: 20, y: 20, scale: 1 });
	const [mode, setMode] = createSignal<Mode>(recall(MODE_KEY) === "list" ? "list" : "graph");
	/** The node the keyboard is on: the one Tab lands on, and the arrow keys move from. */
	const [current, setCurrent] = createSignal<string | null>(null);
	const rel = (path: string) => relativeTo(state.workspace?.root, path);
	const nodeEls = new Map<string, SVGGElement>();
	let svg: SVGSVGElement | undefined;
	let fittedFor = "";
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
	const find = (id: string) => {
		setCurrent(id);
		setMode("graph");
		focus(id);
	};
	/** Whether the list of the graph's keys is showing. */
	const [keysOpen, setKeysOpen] = createSignal(false);
	const keysId = createUniqueId();
	/** A script to bring into sight once the picture is laid out again: the one just folded or unfolded. */
	let showNext: string | null = null;

	const refresh = async () => {
		setProgress("Reading the workspace…");
		setFailed("");
		try {
			const read = await loadGraph((done, total) => setProgress(`Finding calls: ${done} of ${total} procedures`));
			// The first picture of a large workspace is of its scripts: every one folded.
			const root = state.workspace?.root ?? "";
			if (foldedFor !== root) {
				const kept = keptFolds(recall(`${FOLDS_KEY}:${root}`));
				// What was folded here last time, if anything was kept; otherwise the opening picture.
				setFolded(new Set(kept?.scripts ?? (read.nodes.length > FOLD_ABOVE ? read.scripts.map((s) => s.path) : [])));
				// And of a workspace of many scripts, its folders: a picture that fits a screen, to unfold from.
				const folders = foldersOf(read);
				setFoldedDirs(new Set(kept?.folders ?? (read.scripts.length > FOLD_DIRS_ABOVE && folders.size > 1 ? folders : [])));
			}
			foldedFor = root;
			setGraph(read);
		} catch (e: any) {
			setFailed(`Could not read the calls from the language server: ${e?.message ?? e}`);
		}
		setProgress("");
	};
	createEffect(on(() => [state.workspace?.root, state.lsp.state] as const, ([root, lsp]) => root && lsp === "running" && void refresh()));

	/** Whether the targets the server could not resolve are drawn: a choice the view remembers. */
	const [unresolved, setUnresolved] = createSignal(recall(UNRESOLVED_KEY) !== "hidden");
	const unresolvedCount = () => graph()?.nodes.filter((n) => n.kind === "unresolved").length ?? 0;
	const shown = createMemo(() => {
		const g = graph();
		if (!g) return null;
		const keep = visible(g, filter());
		return unresolved() ? keep : withoutUnresolved(g, keep);
	});
	// What is folded is kept with the workspace, so the graph opens next time as it was left.
	createEffect(() => {
		const root = state.workspace?.root ?? "";
		const kept = JSON.stringify({ scripts: [...folded()], folders: [...foldedDirs()] });
		if (root && foldedFor === root) remember(`${FOLDS_KEY}:${root}`, kept);
	});
	/** What is drawn of it: around a focus the neighbourhood is small, and is shown procedure by procedure. */
	const drawn = createMemo(() => {
		const keep = shown();
		return keep ? (filter().mode === "around" ? fold(keep, new Set()) : fold(keep, folded(), { folded: foldedDirs(), of: folderOf })) : null;
	});
	const sizeNote = (bytes: number) => {
		// A size that is not known (a data source's file, the box of unresolved targets) is not written as 0.
		if (!bytes) return "";
		const at = level(bytes, state.settings.limits.bytes);
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
	const nameOf = (g: Graph, id: string) => {
		if (isDir(id)) return id.slice(4);
		if (isFold(id)) return rel(scriptOf(id));
		const node = g.nodes.find((n) => n.id === id);
		if (node) return node.name;
		const script = g.scripts.find((s) => s.path === scriptOf(id));
		return `${topLabel(script)} of ${rel(scriptOf(id))}`;
	};

	createEffect(
		on([graph, drawn, mode], async ([g, keep, as]) => {
			// The list needs no layout, and a large one takes a while.
			if (!g || !keep || as !== "graph") return;
			const sized = (label: string, bold = false) => ({ "elk.nodeSize.constraints": "MINIMUM_SIZE", "elk.nodeSize.minimum": `(${Math.ceil((bold ? measureBold : measure)(label)) + 44},30)` });
			const notes = new Map<string, string>();
			// Scripts are drawn in their folders when there is more than one folder: the folder's box
			// carries the path once, and each script goes by its file's name.
			const drawnScripts = g.scripts.filter((s) => keep.nodes.has(foldId(s.path)) || keep.nodes.has(`${s.path}#`) || g.nodes.some((n) => n.path === s.path && keep.nodes.has(n.id)));
			const dirNodes = [...keep.nodes].filter(isDir).sort();
			const inFolders = new Set([...drawnScripts.map((s) => folderOf(s.path)).filter(Boolean), ...dirNodes.map((id) => id.slice(4))]).size > 1;
			const nameIn = (path: string) => (inFolders && folderOf(path) ? baseName(path) : rel(path));
			const scriptNodes = g.scripts
				.map((s) => {
					if (keep.nodes.has(foldId(s.path))) {
						const note = `${s.isClass ? "class, " : ""}${foldNote(g, s.path, keep.inside.get(s.path))}`;
						notes.set(s.path, note);
						const name = nameIn(s.path);
						return { id: foldId(s.path), width: Math.ceil(Math.max(measureBold(name), measure(note))) + 46, height: FOLD_HEIGHT, labels: [{ text: name }] };
					}
					const procs = g.nodes.filter((n) => n.path === s.path && keep.nodes.has(n.id));
					const top = keep.nodes.has(`${s.path}#`) && g.topLevel.includes(s.path);
					if (!procs.length && !top) return null;
					const regions = [...new Set(procs.map((p) => p.region).filter(Boolean))] as string[];
					const leaf = (p: (typeof procs)[number]) => ({ id: p.id, width: textWidth(p.name), height: 28, labels: [{ text: p.name }] });
					return {
						id: `script:${s.path}`,
						labels: [{ text: s.isClass ? `class  ${nameIn(s.path)}` : nameIn(s.path) }],
						// Wide enough for its own name and size, so the label never runs over the next box.
						layoutOptions: { "elk.padding": "[top=34,left=14,bottom=14,right=14]", ...sized(`${s.isClass ? "class  " : ""}${nameIn(s.path)}  ${sizeNote(s.bytes)}`, true) },
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
			const folders = inFolders ? [...new Set(scriptNodes.map((n) => folderOf(pathOfNode(n.id))).filter(Boolean))].sort() : [];
			const scripts = [
				...folders.map((folder) => ({
					id: `folder:${folder}`,
					labels: [{ text: folder }],
					layoutOptions: { "elk.padding": "[top=34,left=16,bottom=16,right=16]", ...sized(folder, true) },
					children: scriptNodes.filter((n) => folderOf(pathOfNode(n.id)) === folder),
				})),
				...scriptNodes.filter((n) => !inFolders || !folderOf(pathOfNode(n.id))),
				// A folded folder: its path, and under it what is inside.
				...dirNodes.map((id) => {
					const inside = keep.inside.get(id);
					const note = `${plural(inside?.scripts ?? 0, "script")}, ${plural(inside?.procedures ?? 0, "procedure")}${inside?.calls ? `, ${plural(inside.calls, "call")} inside` : ""}`;
					notes.set(id, note);
					return { id, width: Math.ceil(Math.max(measureBold(id.slice(4)), measure(note))) + 46, height: FOLD_HEIGHT, labels: [{ text: id.slice(4) }] };
				}),
			];
			const edges = keep.edges.map((e, i) => ({ id: `e${i}`, sources: [e.from], targets: [e.to] }));
			try {
				const lay = (direction: "RIGHT" | "DOWN"): Promise<any> =>
					elk.layout({
						id: "root",
						layoutOptions: {
							"elk.algorithm": "layered",
							"elk.direction": direction,
							"elk.hierarchyHandling": "INCLUDE_CHILDREN",
							"elk.spacing.nodeNode": direction === "DOWN" ? "12" : "22",
							// Room between the layers for the lines to turn in, and between lines that run together.
							"elk.layered.spacing.nodeNodeBetweenLayers": direction === "DOWN" ? "50" : "72",
							"elk.layered.spacing.edgeNodeBetweenLayers": direction === "DOWN" ? "12" : "18",
							"elk.spacing.edgeNode": direction === "DOWN" ? "10" : "14",
							"elk.spacing.edgeEdge": "9",
							"elk.layered.nodePlacement.strategy": "NETWORK_SIMPLEX",
							"elk.layered.thoroughness": "24",
							"elk.json.edgeCoords": "ROOT",
							// Curves, which the eye follows through a crossing where right angles merge into a grid.
							"elk.edgeRouting": "SPLINES",
							// The order the scripts come in is kept where it costs no crossing, so folding one moves the others little.
							"elk.layered.considerModelOrder.strategy": "NODES_AND_EDGES",
						},
						children: JSON.parse(JSON.stringify(scripts)),
						edges: JSON.parse(JSON.stringify(edges)),
					});
				// Calls run left to right. A picture small enough to lay out twice is also tried top to
				// bottom, and that is kept when the view shows clearly more of it: wide nodes in few
				// layers stack lower than they spread.
				let result = await lay("RIGHT");
				if (keep.nodes.size <= BOTH_WAYS_UP_TO) {
					const down = await lay("DOWN");
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
				const lines: Line[] = (result.edges ?? []).map((e: any) => {
					const edge = keep.edges[Number(String(e.id).slice(1))]!;
					const section = e.sections?.[0];
					const relation = relationOf(edge.kind);
					const count = Math.max(1, edge.sites.length);
					const points: Point[] = section ? [section.startPoint, ...(section.bendPoints ?? []), section.endPoint] : [];
					// A line that stands for several places says how many, just after it leaves: there each line still has its own room.
					const width = Math.ceil(measure(String(count))) + 12;
					const near = splinePoint(points, BADGE_AT);
					return {
						badge: count > 1 && points.length ? { x: near.x - width / 2, y: near.y - 8, width, height: 16 } : undefined,
						id: e.id,
						d: splinePath(points),
						from: edge.from,
						to: edge.to,
						cross: edge.crossScript,
						count,
						relation,
						title: `${nameOf(g, edge.from)} ${RELATION_WORDS[relation]} ${nameOf(g, edge.to)}${count > 1 ? `, from ${count} places` : ""}`,
					};
				});
				// The nodes are drawn afresh: the one the keyboard was on takes the focus again.
				const hadFocus = Boolean(svg && svg.contains(document.activeElement));
				nodeEls.clear();
				setPointed(null);
				setPointedLine(null);
				setLayout({ boxes, lines, width: result.width, height: result.height });
				// A different set of calls is a different picture: show it whole. A refresh keeps the view,
				// and folding one script keeps it too, moved only as far as brings that script into sight.
				const key = JSON.stringify(filter());
				if (fittedFor !== key) fit();
				else if (showNext !== null) {
					const box = boxes.find((b) => ((b.kind === "fold" || b.kind === "script") && b.path === showNext) || ((b.kind === "dir" || b.kind === "folder") && b.folder === showNext));
					if (box) setView((v) => reveal(v, box, size()));
				}
				fittedFor = key;
				showNext = null;
				if (hadFocus) queueMicrotask(() => nodeEls.get(cursor() ?? "")?.focus());
			} catch (e: any) {
				setProgress(`Layout failed: ${e?.message ?? e}`);
			}
		}),
	);

	const focus = (id: string) => setFilter({ mode: "around", focus: id, depth: filter().depth, direction: filter().direction });
	const open = (at: { path?: string; line?: number }) => {
		if (!at.path || at.path === UNRESOLVED) return;
		setState("centerView", "editors");
		void openFile(at.path, { reveal: { line: (at.line ?? 0) + 1 } });
	};
	const procs = () => layout()?.boxes.filter((b) => b.kind === "proc" || b.kind === "top" || b.kind === "fold" || b.kind === "dir") ?? [];
	/** Whether scripts can be folded now: around a focus they are not. */
	const folding = () => filter().mode !== "around";
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
		for (const e of l?.lines ?? []) {
			if (e.id === line) ids.add(e.from).add(e.to);
			else if (on && e.from === on) ids.add(e.to);
			else if (on && e.to === on) ids.add(e.from);
		}
		return ids;
	});
	const isHot = (e: Line) => e.id === pointedLine() || (lit() !== null && (e.from === lit() || e.to === lit()));
	const arrowOf = (e: Line) => `url(#arrow-${isHot(e) ? "hot" : e.relation !== "call" ? "class" : e.cross ? "cross" : "plain"})`;
	/** Where the keyboard is: the node last focused if it is still shown, or else the focus, or the first. */
	const cursor = createMemo(() => {
		const list = procs();
		return (list.find((b) => b.id === current()) ?? list.find((b) => b.id === filter().focus) ?? list[0])?.id ?? null;
	});
	const size = () => svg?.getBoundingClientRect() ?? { width: 0, height: 0 };
	const centreOf = (b: Box) => ({ x: b.x + b.width / 2, y: b.y + b.height / 2 });

	/** The whole graph, or as much as stays legible around the node the keyboard or the focus is on. */
	const fit = () => {
		const l = layout();
		if (!l || !svg) return;
		const here = procs().find((b) => b.id === cursor());
		setView(fitView(l, size(), { floor: FIT_FLOOR, anchor: current() || filter().focus ? here && centreOf(here) : undefined }));
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
		if (e.ctrlKey || e.metaKey || e.altKey) return;
		const here = procs().find((b) => b.id === cursor());
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
			"0": fit,
			"?": () => setKeysOpen((open) => !open),
			Escape: () => setKeysOpen(false),
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
	const titleOf = (b: Box) => {
		if (b.kind === "dir") return `${b.label}: folder, ${b.note}, folded`;
		if (b.kind === "fold") return `${b.label}: ${b.path === UNRESOLVED ? "what the language server could not resolve" : "script"}, ${b.note}, folded${filter().focus === `${b.path}#` ? ", the focus" : ""}`;
		const kind = KIND_WORDS[b.kind === "top" ? (graph()?.scripts.find((s) => s.path === b.path)?.isClass ? "class" : "top") : (b.nodeKind ?? "procedure")];
		const where = b.path && b.path !== UNRESOLVED ? `${kind} in ${rel(b.path)}` : kind;
		return `${b.label}: ${where}${filter().focus === b.id ? ", the focus" : ""}`;
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
			{ label: keysOpen() ? "Hide the keys" : "Keys and what the pointer does", keys: "?", run: () => setKeysOpen((open) => !open), disabled: !inGraph, why: "The keys are the graph's" },
			"separator",
			{ label: "Save picture…", run: () => void savePicture(svg, layout(), "docs/call-graph.svg"), disabled: !inGraph || !layout(), why: "There is no picture in the list" },
			{ label: "Refresh", run: () => void refresh(), disabled: state.lsp.state !== "running", why: "Needs the language server" },
		];
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
			[line((e) => e.relation === "inherits"), "line", "g-edge inherits", "Dashed: a class inherits another"],
			[line((e) => e.relation === "creates"), "line", "g-edge creates", "Dotted: creates an object of a class"],
			[line((e) => e.relation === "method"), "line", "g-edge method", "Dash and dot: calls a method"],
			[box((b) => sizeOf(b) === "near"), "box", "g-script near", "Script near its size limit"],
			[box((b) => sizeOf(b) === "over"), "box", "g-script over", "Script over its size limit"],
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

	const list = createMemo(() => {
		const g = graph();
		const keep = shown();
		return g && keep ? callList(g, keep.edges) : [];
	});
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
			<button class="graph-list-focus" title={`Show only the callers and callees of ${p.proc.name}`} aria-label={`Focus ${p.proc.name}`} aria-pressed={filter().mode === "around" && filter().focus === p.proc.id} onClick={() => focus(p.proc.id)}>
				Focus
			</button>
		</>
	);
	let dragging: { x: number; y: number } | null = null;

	return (
		<div class="graph">
			<div class="graph-bar">
				<strong>Graph</strong>
				<div class="mode-switch" role="group" aria-label="Show the calls as">
					<button classList={{ on: mode() === "graph" }} aria-pressed={mode() === "graph"} onClick={() => choose("graph")}>
						Graph
					</button>
					<button classList={{ on: mode() === "list" }} aria-pressed={mode() === "list"} title="The same calls as a list, for the keyboard or a screen reader" onClick={() => choose("list")}>
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
						Depth <input type="number" min="1" max="6" value={filter().depth} onChange={(e) => setFilter({ ...filter(), depth: Number(e.currentTarget.value) || 1 })} />
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
						title="Type a procedure's name: the graph shows the one you choose with what calls it and what it calls"
						placeholder="Find a procedure…"
						none={(typed) => `No procedure's name has “${typed}” in it.`}
						onChoose={find}
					/>
				</Show>
				<span class="spacer" />
				{/* How much there is: in the bar while it is being read or listed, beside the key under the picture otherwise. */}
				<Show when={progress() || mode() === "list" || !graph()?.nodes.length}>
					<span class="hint" role="status">
						{progress() || tally()}
					</span>
				</Show>
				<Show when={mode() === "graph"}>
					<div class="graph-zoom" role="group" aria-label="Zoom">
						<button title="Zoom out (−)" aria-label="Zoom out" onClick={() => zoomBy(1 / 1.2)}>
							−
						</button>
						<button title="Reset the zoom to 100%" aria-label={`Zoom ${Math.round(view().scale * 100)}%. Reset to 100%`} onClick={() => zoomBy(1 / view().scale)}>
							{Math.round(view().scale * 100)}%
						</button>
						<button title="Zoom in (+)" aria-label="Zoom in" onClick={() => zoomBy(1.2)}>
							+
						</button>
					</div>
					<button title="The whole graph, or as much as stays legible (0)" onClick={fit}>
						Fit
					</button>
				</Show>
				{/* What is used now and then goes in a menu, so that the bar stays one row: folding, the key, the picture, reading again. */}
				<Menu label="More for the graph" title="More: fold, unresolved targets, keys, save picture, refresh" class="graph-more" items={more}>
					<span aria-hidden="true">⋯</span>
				</Menu>
				<button onClick={() => setState("centerView", "editors")}>Close</button>
			</div>
			<Show when={idle()}>
				{(why) => (
					<div class="graph-idle" role="status">
						<p>{why().text}</p>
						<Show when={why().hint}>
							<p class="hint">{why().hint}</p>
						</Show>
						<Show when={why().restart}>
							<button class="primary" onClick={() => void backend.lspRestart()}>
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
					<div class="graph-under">
					<ul class="graph-legend" aria-label="What the graph's shapes and lines mean">
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
									{entry.words}
								</li>
							)}
						</For>
					</ul>
						<Show when={!progress()}>
							<span class="hint graph-tally" role="status">
								{tally()}
							</span>
						</Show>
					</div>
					<div class="graph-stage">
					<svg
						class="graph-canvas"
						ref={svg}
						role="group"
						aria-label="Call graph. The arrow keys move between nodes; the Keys button lists the rest."
						aria-describedby={keysOpen() ? keysId : undefined}
						onFocusOut={(e) => !e.currentTarget.contains(e.relatedTarget as Node | null) && setWalked(null)}
						onKeyDown={onKey}
						onWheel={(e) => {
							e.preventDefault();
							const box = e.currentTarget.getBoundingClientRect();
							zoomBy(e.deltaY < 0 ? 1.1 : 0.9, { x: e.clientX - box.left, y: e.clientY - box.top });
						}}
						onMouseDown={(e) => (dragging = { x: e.clientX, y: e.clientY })}
						onMouseMove={(e) => {
							if (!dragging) return;
							const v = view();
							setView({ ...v, x: v.x + e.clientX - dragging.x, y: v.y + e.clientY - dragging.y });
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
								<g class="g-root" classList={{ lit: lit() !== null || pointedLine() !== null }} transform={`translate(${view().x},${view().y}) scale(${view().scale})`}>
									<For each={l().boxes.filter((b) => b.kind === "folder" || b.kind === "script" || b.kind === "region")}>
										{(b) => (
											<g class={`g-${b.kind}`} classList={{ [level(b.bytes ?? 0, state.settings.limits.bytes)]: b.kind === "script" }}>
												<Show when={b.kind === "script"}>
													<title>{`${[b.path ?? b.label, sizeNote(b.bytes ?? 0)].filter(Boolean).join(": ")}. Click its name to show only this script's calls.`}</title>
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
												<text x={b.x + (b.kind === "script" && folding() ? 26 : b.kind === "folder" ? (folding() ? 30 : 14) : 10)} y={b.y + (b.kind === "folder" ? 21 : 18)} onClick={() => b.kind === "script" && focus(`${b.path}#`)}>
													{b.label}
													<Show when={b.kind === "script"}>
														<tspan class="g-size">{`  ${sizeNote(b.bytes ?? 0)}`}</tspan>
													</Show>
												</text>
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
													class="g-edge"
													classList={{ cross: e.cross && e.relation === "call", [e.relation]: e.relation !== "call", hot: isHot(e) }}
													marker-end={arrowOf(e)}
													style={{ "--w": `${lineWidth(e.count)}px` }}
												/>
												<Show when={e.badge}>
													{(at) => (
														<g class="g-count" classList={{ hot: isHot(e) }}>
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
												class={b.kind === "dir" ? "g-fold g-dir" : `g-${b.kind} ${b.nodeKind ?? ""}`}
												classList={{
													focus: filter().focus === b.id || (b.kind === "fold" && filter().focus === `${b.path}#`),
													lit: lit() === b.id,
													beside: beside().has(b.id),
													class: Boolean(b.isClass),
													[b.kind === "fold" ? level(b.bytes ?? 0, state.settings.limits.bytes) : ""]: b.kind === "fold",
												}}
												ref={(el) => nodeEls.set(b.id, el)}
												tabindex={cursor() === b.id ? 0 : -1}
												role="button"
												aria-label={titleOf(b)}
												aria-expanded={b.kind === "fold" || b.kind === "dir" ? false : undefined}
												onFocus={() => setCurrent(b.id)}
												onMouseEnter={() => setPointed(b.id)}
												onMouseLeave={() => setPointed(null)}
												onClick={(e) => (e.stopPropagation(), b.kind === "dir" ? toggleDir(b.folder) : b.kind === "fold" ? toggleFold(b.path) : focus(b.id))}
												onDblClick={() => b.kind !== "fold" && b.kind !== "dir" && open(b)}
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
												</Show>
											</g>
										)}
									</For>
								</g>
							)}
						</Show>
					</svg>
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
						<p class="hint">Each script, its callers, and what each calls, creates or inherits. A name opens the code; Focus shows only that procedure's callers and callees.</p>
						<Show when={list().length} fallback={<p>No calls to show. Choose "Every call" above to see them all.</p>}>
							<For each={list()}>
								{(script) => (
									<section>
										<h3>
											{rel(script.path)}
											<Show when={graph()!.scripts.find((s) => s.path === script.path)}>{(s) => <span class="hint">{sizeNote(s().bytes)}</span>}</Show>
											<button class="graph-list-focus" title={`Show only the calls into and out of ${rel(script.path)}`} aria-label={`Focus ${rel(script.path)}`} onClick={() => focus(`${script.path}#`)}>
												Focus
											</button>
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
								)}
							</For>
						</Show>
					</div>
				</Show>
			</Show>
		</div>
	);
}
