// Graph mode's data: scripts, their regions and procedures, and the calls
// between procedures. Built from the language server's workspace symbols,
// document symbols and references: the server resolves DoProc and
// ExecFunction targets, so a reference from another procedure is a call.
// Data sources and :INCLUDE edges wait for the server's call graph (L2).

export type ProcIn = { name: string; region?: string; startLine: number; endLine: number };
export type ScriptIn = { path: string; bytes: number; procedures: ProcIn[]; /** A class file, as the server says. */ isClass?: boolean; /** The script's name, as the server gives it. */ name?: string };
export type CallIn = { callee: string; path: string; line: number };

export type GraphNodeKind = "procedure" | "datasource" | "unresolved";
export type GraphNode = { id: string; name: string; path: string; region?: string; line: number; kind?: GraphNodeKind };
export type GraphEdge = { from: string; to: string; crossScript: boolean; sites: { path: string; line: number }[]; kind?: string; resolved?: boolean };
export type Graph = { scripts: ScriptIn[]; nodes: GraphNode[]; edges: GraphEdge[]; topLevel: string[] };

export const procId = (path: string, name: string) => `${path}#${name}`;

/**
 * What an edge says, from the server's kind for it. DoProc, ExecFunction,
 * RunDS and Include are calls. CreateUdObject, Method and Inherit are the
 * three class relations, sent since starlims-lsp 0.31.0 (L4 in
 * docs/LSP-REQUESTS.md). An older server sends none, and none is drawn.
 */
export type Relation = "call" | "inherits" | "creates" | "method";
export const relationOf = (kind?: string): Relation => {
	const k = (kind ?? "").toLowerCase();
	return k.startsWith("inherit") ? "inherits" : k.startsWith("create") ? "creates" : k.startsWith("method") ? "method" : "call";
};
export const RELATION_WORDS: Record<Relation, string> = { call: "calls", inherits: "inherits", creates: "creates an object of", method: "calls the method" };

/** Joins call sites to the procedures that contain them. A site outside any procedure counts as its script's top level. */
export function assemble(scripts: ScriptIn[], calls: CallIn[]): Graph {
	const nodes: GraphNode[] = scripts.flatMap((s) => s.procedures.map((p) => ({ id: procId(s.path, p.name), name: p.name, path: s.path, region: p.region, line: p.startLine })));
	const byPath = new Map(scripts.map((s) => [s.path, s]));
	const edges = new Map<string, GraphEdge>();
	const topLevel = new Set<string>();
	for (const call of calls) {
		const script = byPath.get(call.path);
		const caller = script?.procedures.find((p) => p.startLine <= call.line && call.line <= p.endLine);
		const from = caller ? procId(call.path, caller.name) : `${call.path}#`;
		if (!caller) topLevel.add(call.path);
		if (from === call.callee) continue; // recursion, or the declaration itself
		const key = `${from}→${call.callee}`;
		const edge = edges.get(key) ?? { from, to: call.callee, crossScript: scriptOf(call.callee) !== call.path, sites: [] };
		edge.sites.push({ path: call.path, line: call.line });
		edges.set(key, edge);
	}
	const extra = [...topLevel].filter((path) => !byPath.has(path)).sort((a, b) => a.localeCompare(b));
	const allScripts = extra.length ? [...scripts, ...extra.map((path): ScriptIn => ({ path, bytes: 0, procedures: [] }))] : scripts;
	return { scripts: allScripts, nodes, edges: [...edges.values()], topLevel: [...topLevel] };
}

/** Around a focus: what it calls, what calls it, or both (when nothing is said). */
export type Direction = "both" | "callers" | "callees";
export type Filter = { mode: "all" | "cross" | "around"; focus?: string; depth: number; direction?: Direction };

/** The ids a filter keeps: everything, cross-script calls only, or a focus and its neighbourhood. */
export function visible(graph: Graph, filter: Filter): { nodes: Set<string>; edges: GraphEdge[] } {
	if (filter.mode === "all") return { nodes: new Set([...graph.nodes.map((n) => n.id), ...graph.topLevel.map((p) => `${p}#`)]), edges: graph.edges };
	if (filter.mode === "cross") {
		const edges = graph.edges.filter((e) => e.crossScript);
		return { nodes: new Set(edges.flatMap((e) => [e.from, e.to])), edges };
	}
	const keep = new Set<string>();
	if (filter.focus) {
		keep.add(filter.focus);
		// A script focus ("path#") seeds all of that script's procedures before walking out.
		if (filter.focus.endsWith("#")) {
			const focusPath = filter.focus.slice(0, -1);
			for (const n of graph.nodes) if (n.id.includes("#") && scriptOf(n.id) === focusPath) keep.add(n.id);
		}
	}
	const maxDepth = Math.max(0, Math.min(20, Math.floor(filter.depth) || 0));
	let frontier = new Set(keep);
	for (let d = 0; d < maxDepth && frontier.size > 0; d++) {
		const next = new Set<string>();
		for (const e of graph.edges) {
			// Outwards along a line is to what is called; back along it is to what calls.
			if (filter.direction !== "callers" && frontier.has(e.from) && !keep.has(e.to)) (keep.add(e.to), next.add(e.to));
			if (filter.direction !== "callees" && frontier.has(e.to) && !keep.has(e.from)) (keep.add(e.from), next.add(e.from));
		}
		frontier = next;
	}
	return { nodes: keep, edges: graph.edges.filter((e) => keep.has(e.from) && keep.has(e.to)) };
}

// --- The calls shown, as a list -------------------------------------------------
//
// What the picture shows, for a keyboard or a screen reader: each script, its
// callers in the order the script has them, and under each what it calls.

export type ListedProc = { id: string; name: string; path: string; line: number; kind: GraphNodeKind | "top" | "class" };
export type ListedCall = ListedProc & { crossScript: boolean; count: number; relation: Relation };
export type ListedCaller = ListedProc & { calls: ListedCall[] };
export type ListedScript = { path: string; callers: ListedCaller[] };

export const TOP_LEVEL = "(top level)";
/** What stands for a class file's own top level: the class, which is what gets created and inherited. */
export const CLASS_ITSELF = "(class)";
/** The label of a script's top-level node in the picture, where the box around it already names the file. */
export const topLabel = (script?: ScriptIn) => (script?.isClass ? CLASS_ITSELF : TOP_LEVEL);
/** The box that holds every target the server could not resolve: not a file, so nothing opens from it. */
export const UNRESOLVED = "(unresolved)";

/** A node as a list names it, for any id an edge can end at. */
function lister(graph: Pick<Graph, "nodes" | "scripts">): (id: string) => ListedProc {
	const byId = new Map(graph.nodes.map((n) => [n.id, n]));
	const byPath = new Map(graph.scripts.map((s) => [s.path, s]));
	return (id) => {
		const node = byId.get(id);
		if (node) return { id, name: node.name, path: node.path, line: node.line, kind: node.kind ?? "procedure" };
		const at = id.lastIndexOf("#");
		const name = id.slice(at + 1);
		if (name) return { id, name, path: id.slice(0, at), line: 0, kind: "procedure" };
		const script = byPath.get(id.slice(0, at));
		// In a sentence a class goes by its name: "creates an object of DueDates.DueRule".
		return { id, name: script?.isClass ? (script.name ?? CLASS_ITSELF) : TOP_LEVEL, path: id.slice(0, at), line: 0, kind: script?.isClass ? "class" : "top" };
	};
}

/** One line into or out of a focus: the node at the other end, the focus's own end (a script has several), and how it is related. */
export type FocusLink = { other: ListedProc; own: ListedProc; count: number; relation: Relation };
export type Around = { callers: FocusLink[]; callees: FocusLink[] };

/**
 * What calls a focus and what it calls, one step out: the answer the focus was
 * asked for, before the rest of what is shown. A focus on a script (`path#`)
 * is on every procedure of it, and the lines inside it are neither.
 */
export function aroundFocus(graph: Pick<Graph, "nodes" | "scripts">, edges: readonly GraphEdge[], focus: string): Around {
	const proc = lister(graph);
	const whole = focus.endsWith("#");
	const inFocus = (id: string) => (whole ? scriptOf(id) === focus.slice(0, -1) : id === focus);
	const link = (e: GraphEdge, other: string, own: string): FocusLink => ({ other: proc(other), own: proc(own), count: Math.max(1, e.sites.length), relation: relationOf(e.kind) });
	const order = (a: FocusLink, b: FocusLink) => a.other.path.localeCompare(b.other.path) || a.other.name.localeCompare(b.other.name) || a.own.name.localeCompare(b.own.name) || a.relation.localeCompare(b.relation);
	return {
		callers: edges.filter((e) => inFocus(e.to) && !inFocus(e.from)).map((e) => link(e, e.from, e.to)).sort(order),
		callees: edges.filter((e) => inFocus(e.from) && !inFocus(e.to)).map((e) => link(e, e.to, e.from)).sort(order),
	};
}

export function callList(graph: Graph, edges: GraphEdge[]): ListedScript[] {
	const proc = lister(graph);
	const scripts = new Map<string, Map<string, ListedCaller>>();
	for (const e of edges) {
		const from = proc(e.from);
		if (!scripts.has(from.path)) scripts.set(from.path, new Map());
		const callers = scripts.get(from.path)!;
		if (!callers.has(from.id)) callers.set(from.id, { ...from, calls: [] });
		callers.get(from.id)!.calls.push({ ...proc(e.to), crossScript: e.crossScript, count: Math.max(1, e.sites.length), relation: relationOf(e.kind) });
	}
	const byName = (a: ListedProc, b: ListedProc) => a.name.localeCompare(b.name);
	return [...scripts]
		.sort(([a], [b]) => a.localeCompare(b))
		.map(([path, callers]) => ({
			path,
			callers: [...callers.values()].sort((a, b) => a.line - b.line || byName(a, b)).map((c) => ({ ...c, calls: [...c.calls].sort((a, b) => byName(a, b) || a.relation.localeCompare(b.relation)) })),
		}));
}

// --- From the server's call graph -------------------------------------------
//
// starlims-lsp's ssl/callGraph, shape version 1 (its catalog entry
// feature.call_graph): nodes are scripts, procedures, data sources and
// unresolved targets; edges are DoProc, ExecFunction, RunDS and Include, from
// the procedure holding the call or from the file for code outside every
// procedure. Include edges run between scripts' top levels here. The class
// edges (since 0.31.0): CreateUdObject and Inherit end at a class file,
// which is that script's top level here, and Method at a method.

type Pos = { line: number; character: number };
type Location = { uri: string; range: { start: Pos; end: Pos } };
export type CallGraphIn = {
	nodes: { id: string; kind: string; name: string; container?: string; regions?: string[]; location?: Location; isClass?: boolean }[];
	edges: { from: string; to: string; kind?: string; target?: string; resolved?: boolean; ambiguous?: boolean; location?: Location }[];
	indexing?: boolean;
};

/**
 * `notAScript` names the paths that are not the project's: the IDE's own scratch documents. The server counts every
 * document it has open, and one that is open for the length of a question (a check of proposed code, the comments
 * of a file that is not open) was drawn as a script if the graph was asked for just then.
 */
export function fromCallGraph(input: CallGraphIn, toPath: (uri: string) => string, sizes: Map<string, number> = new Map(), notAScript: (path: string) => boolean = () => false): Graph {
	const scriptsByPath = new Map<string, ScriptIn>();
	const ids = new Map<string, string>(); // server id -> graph id
	const script = (path: string) => {
		if (!scriptsByPath.has(path)) scriptsByPath.set(path, { path, bytes: sizes.get(path) ?? 0, procedures: [] });
		return scriptsByPath.get(path)!;
	};
	const nodes: GraphNode[] = [];
	const drawn = new Set<string>();
	const topLevel = new Set<string>();
	for (const n of input.nodes) {
		const uri = n.location?.uri ?? n.container;
		const path = uri ? toPath(uri) : "";
		// Not given an id, so the lines to and from it are left out with it.
		if (path && notAScript(path)) continue;
		if (n.kind === "script") {
			if (n.isClass) script(path).isClass = true;
			script(path).name = n.name;
			ids.set(n.id, `${path}#`);
			continue;
		}
		const kind: GraphNodeKind = n.kind === "dataSource" ? "datasource" : n.kind === "unresolved" ? "unresolved" : "procedure";
		// Procedures sit in their script; a data source is its own file; unresolved targets share one box.
		const box = kind === "unresolved" ? UNRESOLVED : n.container ? toPath(n.container) : path;
		const id = procId(box, n.name);
		ids.set(n.id, id);
		// The server gives a target it could not resolve once for each kind of call to it; in the one
		// box they share, a name is one node, and every line to it ends there.
		if (drawn.has(id)) continue;
		drawn.add(id);
		const line = n.location?.range.start.line ?? 0;
		script(box).procedures.push({ name: n.name, region: n.regions?.[0], startLine: line, endLine: n.location?.range.end.line ?? line });
		nodes.push({ id, name: n.name, path: box, region: n.regions?.[0], line, kind });
	}
	const edges = new Map<string, GraphEdge>();
	for (const e of input.edges) {
		const from = ids.get(e.from);
		const to = ids.get(e.to);
		if (!from || !to || from === to) continue;
		if (from.endsWith("#")) topLevel.add(from.slice(0, -1));
		if (to.endsWith("#")) topLevel.add(to.slice(0, -1));
		// A call and a class relation between the same two are two edges: they say different things.
		const key = `${from}→${to}→${relationOf(e.kind)}`;
		const edge = edges.get(key) ?? { from, to, crossScript: scriptOf(from) !== scriptOf(to), sites: [], kind: e.kind, resolved: e.resolved };
		if (e.location) edge.sites.push({ path: toPath(e.location.uri), line: e.location.range.start.line });
		edges.set(key, edge);
	}
	return { scripts: [...scriptsByPath.values()].sort((a, b) => a.path.localeCompare(b.path)), nodes, edges: [...edges.values()], topLevel: [...topLevel] };
}

// --- Scripts folded to one node ------------------------------------------------
//
// A workspace's every procedure and call at once is a picture nobody can
// follow. A folded script is drawn as one node: the calls into and out of it
// end at the script, those between the same two scripts become one line, and
// the calls wholly inside it are counted, not drawn.

/** The id a folded script's node has. No procedure's id can be it: theirs start with the path. */
export const foldId = (path: string) => `fold:${path}`;
export const isFold = (id: string) => id.startsWith("fold:");
/** The script (or the box of unresolved targets) a node is in, from its id. */
export const scriptOf = (id: string) => {
	if (isFold(id)) return id.slice(5);
	const at = id.lastIndexOf("#");
	return at >= 0 ? id.slice(0, at) : id;
};

/** The id a folded folder's node has: every script in the folder drawn as one node. */
export const dirId = (folder: string) => `dir:${folder}`;
export const isDir = (id: string) => id.startsWith("dir:");

/** What a folded node stands for: how many scripts (a folder only), procedures, and lines that run inside it. */
export type Inside = { scripts: number; procedures: number; calls: number };
export type Folded = {
	nodes: Set<string>;
	edges: GraphEdge[];
	/** Per folded node that is drawn, by the script's path or the folder's id. */
	inside: Map<string, Inside>;
};
/** The folders that are folded, and the folder each script is in ("" for one in no folder). */
export type FoldedDirs = { folded: ReadonlySet<string>; of: (path: string) => string };

/**
 * What is drawn of the shown nodes and edges when the scripts in `folded` are
 * each one node, and every script of a folded folder is one node together.
 */
export function fold(shown: { nodes: ReadonlySet<string>; edges: readonly GraphEdge[] }, folded: ReadonlySet<string>, dirs?: FoldedDirs): Folded {
	const dirOf = (path: string) => {
		const folder = dirs?.of(path);
		return folder && dirs!.folded.has(folder) ? dirId(folder) : null;
	};
	const end = (id: string) => dirOf(scriptOf(id)) ?? (folded.has(scriptOf(id)) ? foldId(scriptOf(id)) : id);
	const inside = new Map<string, Inside>();
	const count = (key: string) => inside.get(key) ?? inside.set(key, { scripts: 0, procedures: 0, calls: 0 }).get(key)!;
	const scripts = new Map<string, Set<string>>();
	const nodes = new Set<string>();
	for (const id of shown.nodes) {
		const to = end(id);
		nodes.add(to);
		if (to === id) continue;
		const key = isDir(to) ? to : scriptOf(id);
		// The script's own top level is not one of its procedures.
		if (!id.endsWith("#")) count(key).procedures++;
		else count(key);
		if (isDir(to)) scripts.set(to, (scripts.get(to) ?? new Set()).add(scriptOf(id)));
	}
	for (const [dir, paths] of scripts) count(dir).scripts = paths.size;
	const edges = new Map<string, GraphEdge>();
	for (const e of shown.edges) {
		const [from, to] = [end(e.from), end(e.to)];
		if (from === to) {
			if (isDir(from)) count(from).calls++;
			else if (isFold(from)) count(scriptOf(from)).calls++;
			continue;
		}
		const key = `${from}→${to}→${relationOf(e.kind)}`;
		const known = edges.get(key);
		if (known) known.sites.push(...e.sites);
		else edges.set(key, { ...e, from, to, sites: [...e.sites], crossScript: isDir(from) || isDir(to) || scriptOf(from) !== scriptOf(to) });
	}
	return { nodes, edges: [...edges.values()], inside };
}

// --- Lines gathered at a folder's edge ------------------------------------------

/** A folder drawn open, as the end of a line gathered at its edge. */
export const folderEnd = (folder: string) => `folder:${folder}`;
export const isFolderEnd = (id: string) => id.startsWith("folder:");
/** This many lines between one node and the nodes of one folder, and they are drawn as one line to the folder's edge. */
export const GATHER_FROM = 3;
/** A line as it is drawn: one edge, or several gathered. `froms` and `tos` are the nodes a gathered end stands for. */
export type DrawnEdge = GraphEdge & { froms?: string[]; tos?: string[] };

/**
 * Gathers lines at the edges of the folders that are drawn open. A node that
 * calls several nodes of another folder is the usual reason a picture cannot
 * be followed: its lines cross everything on the way in. Those are drawn as
 * one line to the folder's edge, and so are the lines of several nodes of a
 * folder that all go to one node outside it. Nothing is lost: each gathered
 * line keeps the nodes it stands for and every place it was called from.
 * `folderOf` gives the open folder a node is drawn in, if it is in one.
 */
export function gather(edges: readonly GraphEdge[], folderOf: (id: string) => string | undefined, atLeast = GATHER_FROM): DrawnEdge[] {
	const home = (id: string) => (isFolderEnd(id) ? id.slice(7) : folderOf(id));
	const pass = (list: DrawnEdge[], into: boolean): DrawnEdge[] => {
		// The near end stays a node; the far end is the one that may be gathered into its folder.
		const ends = (e: DrawnEdge) => (into ? ([e.from, e.to] as const) : ([e.to, e.from] as const));
		const keyOf = (e: DrawnEdge) => {
			const [near, far] = ends(e);
			const folder = isFolderEnd(far) ? undefined : folderOf(far);
			return folder && folder !== home(near) ? `${near}→${folder}→${relationOf(e.kind)}` : null;
		};
		const groups = new Map<string, DrawnEdge[]>();
		for (const e of list) {
			const key = keyOf(e);
			if (key) groups.set(key, [...(groups.get(key) ?? []), e]);
		}
		const done = new Set<string>();
		const out: DrawnEdge[] = [];
		for (const e of list) {
			const key = keyOf(e);
			const group = key ? groups.get(key)! : [];
			if (!key || group.length < atLeast) out.push(e);
			else if (!done.has(key)) {
				done.add(key);
				const [near, far] = ends(e);
				const folder = folderEnd(folderOf(far)!);
				const inside = group.map((g) => ends(g)[1]);
				// What the near end already stands for, when it was gathered on the first pass.
				const kept = [...new Set(group.flatMap((g) => (into ? (g.froms ?? []) : (g.tos ?? []))))];
				const sites = group.flatMap((g) => g.sites);
				out.push(into ? { ...e, from: near, to: folder, sites, crossScript: true, tos: inside, ...(kept.length ? { froms: kept } : {}) } : { ...e, from: folder, to: near, sites, crossScript: true, froms: inside, ...(kept.length ? { tos: kept } : {}) });
			}
		}
		return out;
	};
	return pass(pass([...edges], true), false);
}

/**
 * The nodes in groups that stand at the same step of the calls among them: a
 * node's step is one more than the latest of its callers', and a call that
 * closes a circle is passed over. A layered layout lays each group in one
 * line; no call runs between two nodes of a group, so they can be set out
 * otherwise. Groups come in the order of their steps, nodes in the order given.
 */
export function sameStep(ids: readonly string[], callers: ReadonlyMap<string, ReadonlySet<string>>): string[][] {
	const step = new Map<string, number>();
	const walking = new Set<string>();
	const at = (id: string): number => {
		const known = step.get(id);
		if (known !== undefined) return known;
		if (walking.has(id)) return -1;
		walking.add(id);
		let depth = 0;
		for (const caller of callers.get(id) ?? []) depth = Math.max(depth, at(caller) + 1);
		walking.delete(id);
		step.set(id, depth);
		return depth;
	};
	const groups = new Map<number, string[]>();
	for (const id of ids) groups.set(at(id), [...(groups.get(at(id)) ?? []), id]);
	return [...groups].sort(([a], [b]) => a - b).map(([, group]) => group);
}

/** More procedures than this, and the graph opens with its scripts folded: the picture is of the scripts first. */
export const FOLD_ABOVE = 40;
/** More scripts than this, in more than one folder, and it opens with its folders folded too: the picture is of the folders first. */
export const FOLD_DIRS_ABOVE = 24;

// --- Finding a node by name ----------------------------------------------------

/** Something a finder can go to: its name, where it is, and the id to go to it by. */
export type Choice = { id: string; name: string; where: string };

/**
 * The procedures and data sources a graph can be asked to show, each with the
 * script it is in. Targets the server could not resolve are left out; there
 * is nothing of them to go to.
 */
export function choices(graph: Pick<Graph, "nodes">, rel: (path: string) => string): Choice[] {
	return graph.nodes
		.filter((n) => n.kind !== "unresolved")
		.map((n) => ({ id: n.id, name: n.name, where: rel(n.path) }))
		.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" }) || a.where.localeCompare(b.where));
}

/** The first few choices whose name has the typed text in it, whatever its case: names that start with it come first. */
export function matching<T extends { name: string }>(list: readonly T[], typed: string, limit = 8): T[] {
	const text = typed.trim().toLowerCase();
	if (!text) return [];
	const starts = (c: T) => c.name.toLowerCase().startsWith(text);
	return list
		.filter((c) => c.name.toLowerCase().includes(text))
		.sort((a, b) => Number(starts(b)) - Number(starts(a)))
		.slice(0, limit);
}

/** What was kept of the folded scripts and folders, read with suspicion; null when there is nothing usable. */
export function keptFolds(text: string | null): { scripts: string[]; folders: string[] } | null {
	try {
		const raw: any = JSON.parse(text ?? "null");
		const strings = (list: unknown) => (Array.isArray(list) ? list.filter((item): item is string => typeof item === "string") : null);
		const scripts = strings(raw?.scripts);
		const folders = strings(raw?.folders);
		return scripts && folders ? { scripts, folders } : null;
	} catch {
		return null;
	}
}

/**
 * What is shown, without the targets the server could not resolve and the
 * lines to them. They are worth seeing once; after that they are every
 * picture's thickest lines, and can be put aside.
 */
export function withoutUnresolved(graph: Pick<Graph, "nodes">, shown: { nodes: ReadonlySet<string>; edges: readonly GraphEdge[] }): { nodes: Set<string>; edges: GraphEdge[] } {
	const gone = new Set(graph.nodes.filter((n) => n.kind === "unresolved").map((n) => n.id));
	return { nodes: new Set([...shown.nodes].filter((id) => !gone.has(id))), edges: shown.edges.filter((e) => !gone.has(e.from) && !gone.has(e.to)) };
}

// --- Transitive Blast-Radius / Impact Analysis & Ticket Subgraph (Wave 4.1) ---

export type ImpactNode = ListedProc & {
	/** Shortest hop distance from any seed node (1 = direct caller or callee). */
	hop: number;
	/** For upstream callers: true when no node in the graph calls this node (an entry point). */
	entryPoint?: boolean;
	/** Edge relation(s) reaching this node at its shortest hop. */
	relations: Relation[];
};

export type ImpactDocSummary = {
	label: string;
	group: string;
	path: string;
	reason?: string;
	ticket?: string;
};

export type ImpactReport = {
	targetLabel?: string;
	seeds: ListedProc[];
	seedScripts: string[];
	maxHops: number;
	upstream: ImpactNode[];
	upstreamByHop: { hop: number; nodes: ImpactNode[] }[];
	entryPoints: ImpactNode[];
	downstream: ImpactNode[];
	downstreamByHop: { hop: number; nodes: ImpactNode[] }[];
	dataSources: ImpactNode[];
	affectedScripts: string[];
	schemaTables?: { name: string; path?: string }[];
	governingDocs?: ImpactDocSummary[];
	testScripts?: string[];
};

const normGraphPath = (p: string) => p.replace(/\\/g, "/").toLowerCase();

/**
 * Multi-root BFS transitive impact / blast-radius analysis across the call graph.
 * Walks upstream (callers by hop 1..maxHops, flagging 0-in-degree entry points)
 * and downstream (callees + `.ds` data sources). Accepts procedure IDs (`path#Proc`),
 * script sentinels (`path#`), folded script IDs (`fold:path`), or raw script paths.
 */
export function computeImpactAnalysis(graph: Graph, seedNodeIds: string[], maxHops = 4): ImpactReport {
	const hopsLimit = Math.max(1, Math.floor(maxHops));
	const proc = lister(graph);
	const byId = new Map(graph.nodes.map((n) => [n.id, n]));
	const isUnresolved = (id: string) => {
		const n = byId.get(id);
		return n?.kind === "unresolved" || scriptOf(id) === UNRESOLVED;
	};

	const scriptByNorm = new Map(graph.scripts.map((s) => [normGraphPath(s.path), s.path]));
	const topLevelSet = new Set(graph.topLevel);
	const edgeTouchedTop = new Set<string>();
	for (const e of graph.edges) {
		if (e.from.endsWith("#")) edgeTouchedTop.add(e.from);
		if (e.to.endsWith("#")) edgeTouchedTop.add(e.to);
	}

	const seedSet = new Set<string>();
	const addScriptSeeds = (scriptPath: string) => {
		const matched = scriptByNorm.get(normGraphPath(scriptPath)) ?? scriptPath;
		let addedAny = false;
		for (const n of graph.nodes) {
			if (n.path === matched && n.kind !== "unresolved") {
				seedSet.add(n.id);
				addedAny = true;
			}
		}
		const topId = `${matched}#`;
		if (topLevelSet.has(matched) || edgeTouchedTop.has(topId) || !addedAny) {
			seedSet.add(topId);
		}
	};

	for (const raw of seedNodeIds) {
		const id = raw.trim();
		if (!id) continue;
		if (isFold(id)) {
			addScriptSeeds(scriptOf(id));
		} else if (id.endsWith("#")) {
			addScriptSeeds(id.slice(0, -1));
		} else if (!id.includes("#") && scriptByNorm.has(normGraphPath(id))) {
			addScriptSeeds(id);
		} else if (!isUnresolved(id)) {
			seedSet.add(id);
		}
	}

	const incoming = new Map<string, { from: string; relation: Relation }[]>();
	const outgoing = new Map<string, { to: string; relation: Relation }[]>();
	const callersOf = new Map<string, Set<string>>();

	for (const e of graph.edges) {
		if (e.from === e.to) continue;
		if (isUnresolved(e.from) || isUnresolved(e.to)) continue;
		const relation = relationOf(e.kind);
		const inc = incoming.get(e.to) ?? [];
		inc.push({ from: e.from, relation });
		incoming.set(e.to, inc);

		const out = outgoing.get(e.from) ?? [];
		out.push({ to: e.to, relation });
		outgoing.set(e.from, out);

		const set = callersOf.get(e.to) ?? new Set<string>();
		set.add(e.from);
		callersOf.set(e.to, set);
	}

	const sortImpact = (a: ImpactNode, b: ImpactNode) =>
		a.hop - b.hop || a.path.localeCompare(b.path) || a.name.localeCompare(b.name);

	// 1. Multi-root upstream BFS (callers by hop 1..N)
	const visitedUp = new Set<string>(seedSet);
	let upFrontier = [...seedSet];
	const upstream: ImpactNode[] = [];
	for (let hop = 1; hop <= hopsLimit && upFrontier.length > 0; hop++) {
		const nextMap = new Map<string, Set<Relation>>();
		for (const cur of upFrontier) {
			for (const edge of incoming.get(cur) ?? []) {
				if (visitedUp.has(edge.from)) continue;
				const rels = nextMap.get(edge.from) ?? new Set<Relation>();
				rels.add(edge.relation);
				nextMap.set(edge.from, rels);
			}
		}
		if (!nextMap.size) break;
		const nextIds: string[] = [];
		for (const [id, rels] of nextMap) {
			visitedUp.add(id);
			nextIds.push(id);
			upstream.push({
				...proc(id),
				hop,
				entryPoint: (callersOf.get(id)?.size ?? 0) === 0,
				relations: [...rels].sort(),
			});
		}
		upFrontier = nextIds;
	}
	upstream.sort(sortImpact);

	// 2. Multi-root downstream BFS (callees + data sources by hop 1..N)
	const visitedDown = new Set<string>(seedSet);
	let downFrontier = [...seedSet];
	const downstream: ImpactNode[] = [];
	const dataSources: ImpactNode[] = [];
	for (let hop = 1; hop <= hopsLimit && downFrontier.length > 0; hop++) {
		const nextMap = new Map<string, Set<Relation>>();
		for (const cur of downFrontier) {
			for (const edge of outgoing.get(cur) ?? []) {
				if (visitedDown.has(edge.to)) continue;
				const rels = nextMap.get(edge.to) ?? new Set<Relation>();
				rels.add(edge.relation);
				nextMap.set(edge.to, rels);
			}
		}
		if (!nextMap.size) break;
		const nextIds: string[] = [];
		for (const [id, rels] of nextMap) {
			visitedDown.add(id);
			nextIds.push(id);
			const info = proc(id);
			const item: ImpactNode = { ...info, hop, relations: [...rels].sort() };
			if (info.kind === "datasource") dataSources.push(item);
			else downstream.push(item);
		}
		downFrontier = nextIds;
	}
	downstream.sort(sortImpact);
	dataSources.sort(sortImpact);

	const groupByHop = (nodes: readonly ImpactNode[]) => {
		const map = new Map<number, ImpactNode[]>();
		for (const n of nodes) {
			const bucket = map.get(n.hop) ?? [];
			bucket.push(n);
			map.set(n.hop, bucket);
		}
		return [...map.entries()].sort(([a], [b]) => a - b).map(([hop, list]) => ({ hop, nodes: list }));
	};

	const seeds = [...seedSet]
		.map((id) => proc(id))
		.sort((a, b) => a.path.localeCompare(b.path) || a.line - b.line || a.name.localeCompare(b.name));
	const uniquePaths = (list: readonly { path: string }[]) =>
		[...new Set(list.map((x) => x.path).filter((p) => Boolean(p) && p !== UNRESOLVED))].sort((a, b) => a.localeCompare(b));

	const seedScripts = uniquePaths(seeds);
	const affectedScripts = uniquePaths([...seeds, ...upstream, ...downstream, ...dataSources]);
	const entryPoints = upstream.filter((n) => n.entryPoint);

	return {
		seeds,
		seedScripts,
		maxHops: hopsLimit,
		upstream,
		upstreamByHop: groupByHop(upstream),
		entryPoints,
		downstream,
		downstreamByHop: groupByHop(downstream),
		dataSources,
		affectedScripts,
	};
}

function escapeMdCell(raw: string): string {
	return raw.replace(/\r?\n/g, " ").replace(/\s+/g, " ").replace(/\|/g, "\\|").trim();
}

function clipMdText(raw: string, max: number): string {
	if (raw.length <= max) return raw;
	return `${raw.slice(0, Math.max(1, max - 1)).trimEnd()}…`;
}

function formatImpactTargetCell(node: Pick<ListedProc, "name" | "path">): string {
	const file = node.path ? node.path.split(/[\\/]/).pop() ?? node.path : "";
	const name = escapeMdCell(node.name);
	const cleanFile = escapeMdCell(file);
	const plain = cleanFile && cleanFile.toLowerCase() !== name.toLowerCase() ? `${name} (${cleanFile})` : name;
	if (plain.length > 94) return clipMdText(plain, 94);
	return cleanFile && cleanFile.toLowerCase() !== name.toLowerCase() ? `\`${name}\` (${cleanFile})` : `\`${name}\``;
}

const IMPACT_KIND_LABEL: Record<ListedProc["kind"], string> = {
	procedure: "Procedure",
	datasource: "Data source",
	unresolved: "Unresolved",
	top: "Top level",
	class: "Class",
};

const DOC_GROUP_LABEL: Record<string, string> = {
	tickets: "Ticket",
	specs: "Spec",
	plans: "Plan",
	knowledge: "Knowledge",
	schema: "Schema",
	registries: "Registry",
	docs: "Doc",
	project: "Project",
};

/**
 * Formats an `ImpactReport` into crisp, ADR 0008-compliant Markdown
 * (every table has <= 4 columns, headings <= 16 chars, non-last cells <= 20 chars, last cell <= 100 chars).
 */
export function formatImpactMarkdown(analysis: ImpactReport): string {
	const target =
		analysis.targetLabel?.trim() ||
		(analysis.seeds.length === 1
			? analysis.seeds[0]!.name
			: analysis.seedScripts.length === 1
				? analysis.seedScripts[0]!.split(/[\\/]/).pop() ?? analysis.seedScripts[0]!
				: `${analysis.seedScripts.length} scripts`);

	const lines: string[] = [
		`## Impact Analysis: ${target}`,
		"",
		`- **Target**: ${target} (${analysis.seeds.length} ${analysis.seeds.length === 1 ? "node" : "nodes"} across ${analysis.seedScripts.length} ${analysis.seedScripts.length === 1 ? "script" : "scripts"})`,
		`- **Blast radius**: ${analysis.upstream.length} upstream ${analysis.upstream.length === 1 ? "caller" : "callers"} (${analysis.entryPoints.length} entry ${analysis.entryPoints.length === 1 ? "point" : "points"}), ${analysis.downstream.length} downstream ${analysis.downstream.length === 1 ? "callee" : "callees"}, ${analysis.dataSources.length} data ${analysis.dataSources.length === 1 ? "source" : "sources"} (max ${analysis.maxHops} hops)`,
		`- **Affected scripts**: ${analysis.affectedScripts.length}`,
	];

	lines.push("", "### Upstream Callers", "");
	if (!analysis.upstream.length) {
		lines.push("None found in the call graph.");
	} else {
		lines.push("| Hop | Role | Caller |", "| --- | --- | --- |");
		for (const n of analysis.upstream) {
			const role = n.entryPoint ? "Entry point" : "Caller";
			lines.push(`| ${n.hop} | ${role} | ${formatImpactTargetCell(n)} |`);
		}
	}

	const downAll = [...analysis.downstream, ...analysis.dataSources].sort(
		(a, b) => a.hop - b.hop || Number(a.kind === "datasource") - Number(b.kind === "datasource") || a.path.localeCompare(b.path) || a.name.localeCompare(b.name),
	);
	lines.push("", "### Downstream Callees & Data Sources", "");
	if (!downAll.length) {
		lines.push("None found in the call graph.");
	} else {
		lines.push("| Hop | Kind | Target |", "| --- | --- | --- |");
		for (const n of downAll) {
			const kind = IMPACT_KIND_LABEL[n.kind] ?? "Procedure";
			lines.push(`| ${n.hop} | ${kind} | ${formatImpactTargetCell(n)} |`);
		}
	}

	lines.push("", "### Schema Tables", "");
	if (!analysis.schemaTables?.length) {
		lines.push("None referenced.");
	} else {
		for (const t of analysis.schemaTables) {
			lines.push(`- \`${t.name}\`${t.path ? ` (${t.path})` : ""}`);
		}
	}

	lines.push("", "### Governing Docs & Tickets", "");
	if (!analysis.governingDocs?.length) {
		lines.push("None linked.");
	} else {
		lines.push("| Kind | Document |", "| --- | --- |");
		for (const doc of analysis.governingDocs) {
			const kind = clipMdText(escapeMdCell(DOC_GROUP_LABEL[doc.group] ?? doc.group ?? "Doc"), 18);
			const desc = clipMdText(escapeMdCell(doc.reason ? `${doc.label} (${doc.reason})` : doc.label), 94);
			lines.push(`| ${kind} | ${desc} |`);
		}
	}

	lines.push("", "### Test Scripts", "");
	if (!analysis.testScripts?.length) {
		lines.push("None linked.");
	} else {
		for (const ts of analysis.testScripts) {
			lines.push(`- \`${ts}\``);
		}
	}

	return lines.join("\n");
}

/**
 * Returns the set of visible node IDs for a ticket's scripts (`ticketScriptPaths`),
 * plus optional 1-hop callers and callees when `includeNeighbors` is true.
 */
export function ticketSubgraphFilter(
	graph: Graph,
	ticketScriptPaths: Set<string>,
	includeNeighbors: boolean,
): Set<string> {
	const wanted = new Set<string>();
	for (const p of ticketScriptPaths) {
		const n = normGraphPath(p.trim());
		if (n) wanted.add(n);
	}
	if (!wanted.size) return new Set<string>();

	const keep = new Set<string>();
	for (const n of graph.nodes) {
		if (wanted.has(normGraphPath(n.path))) keep.add(n.id);
	}
	for (const top of graph.topLevel) {
		if (wanted.has(normGraphPath(top))) keep.add(`${top}#`);
	}
	for (const e of graph.edges) {
		if (e.from.endsWith("#") && wanted.has(normGraphPath(scriptOf(e.from)))) keep.add(e.from);
		if (e.to.endsWith("#") && wanted.has(normGraphPath(scriptOf(e.to)))) keep.add(e.to);
	}

	if (includeNeighbors) {
		const core = new Set(keep);
		for (const e of graph.edges) {
			const fromIn = core.has(e.from) || wanted.has(normGraphPath(scriptOf(e.from)));
			const toIn = core.has(e.to) || wanted.has(normGraphPath(scriptOf(e.to)));
			if (fromIn) keep.add(e.to);
			if (toIn) keep.add(e.from);
		}
	}

	return keep;
}

/** Why the graph view has nothing to show, or shows what it last read, and what to do about it. */
export type GraphIdle = { text: string; hint?: string; restart?: boolean };

/**
 * What the graph view says in place of the calls, or above the calls it last read; null when there is nothing to
 * say. The server comes first: the graph is read from it. `answering` is false while the server runs and leaves
 * what it was asked unanswered: the view once read "Reading the workspace…" for as long as such a server ran.
 * `nodes` is how many procedures the graph that was read has, null when none has been read. `waiting` says the
 * calls have been asked for and not yet given: only then does an answer bring them.
 */
export function graphIdle(o: { workspace: boolean; lsp: string; lspMessage?: string; answering: boolean; waiting?: boolean; failed: string; nodes: number | null }): GraphIdle | null {
	if (!o.workspace) return { text: "Open a folder to see the calls between its procedures." };
	const stale = o.nodes ? " These are the calls as they were last read." : "";
	if (o.lsp === "starting" || o.lsp === "restarting") return { text: `The language server is starting.${stale || " The graph is read from it, and appears when it is ready."}` };
	if (o.lsp !== "running")
		return {
			text: `The language server is not running${stale ? `.${stale}` : ", so there are no calls to show: the graph is read from it."}${o.lspMessage ? ` It said: ${o.lspMessage}` : ""}`,
			hint: "Restart it here or from the status bar. If it does not start, Settings has where to find it, under Language server program.",
			restart: true,
		};
	if (!o.answering)
		return {
			text: `The language server is not answering${stale ? `.${stale}` : ", so there are no calls to show: the graph is read from it."}`,
			hint: `Restart it here or from the status bar.${o.waiting ? " If it is only busy, the calls appear when it answers." : ""}`,
			restart: true,
		};
	if (o.failed) return { text: o.failed, hint: "Refresh tries again." };
	if (o.nodes === 0) return { text: "The language server found no procedures in this folder." };
	return null;
}
