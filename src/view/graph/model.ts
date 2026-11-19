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
		const edge = edges.get(key) ?? { from, to: call.callee, crossScript: call.callee.split("#")[0] !== call.path, sites: [] };
		edge.sites.push({ path: call.path, line: call.line });
		edges.set(key, edge);
	}
	return { scripts, nodes, edges: [...edges.values()], topLevel: [...topLevel] };
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
	const keep = new Set<string>(filter.focus ? [filter.focus] : []);
	let frontier = [...keep];
	for (let d = 0; d < filter.depth; d++) {
		const next: string[] = [];
		for (const e of graph.edges) {
			const focusIsScript = (id: string) => frontier.some((f) => (f.endsWith("#") ? id.startsWith(f) : id === f));
			// Outwards along a line is to what is called; back along it is to what calls.
			if (filter.direction !== "callers" && focusIsScript(e.from) && !keep.has(e.to)) (keep.add(e.to), next.push(e.to));
			if (filter.direction !== "callees" && focusIsScript(e.to) && !keep.has(e.from)) (keep.add(e.from), next.push(e.from));
		}
		frontier = next;
	}
	// A script focus ("path#") keeps all of that script's procedures.
	if (filter.focus?.endsWith("#")) for (const n of graph.nodes) if (n.id.startsWith(filter.focus)) keep.add(n.id);
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

export function callList(graph: Graph, edges: GraphEdge[]): ListedScript[] {
	const byId = new Map(graph.nodes.map((n) => [n.id, n]));
	const byPath = new Map(graph.scripts.map((s) => [s.path, s]));
	const proc = (id: string): ListedProc => {
		const node = byId.get(id);
		if (node) return { id, name: node.name, path: node.path, line: node.line, kind: node.kind ?? "procedure" };
		const at = id.lastIndexOf("#");
		const name = id.slice(at + 1);
		if (name) return { id, name, path: id.slice(0, at), line: 0, kind: "procedure" };
		const script = byPath.get(id.slice(0, at));
		// In a sentence a class goes by its name: "creates an object of DueDates.DueRule".
		return { id, name: script?.isClass ? (script.name ?? CLASS_ITSELF) : TOP_LEVEL, path: id.slice(0, at), line: 0, kind: script?.isClass ? "class" : "top" };
	};
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

export function fromCallGraph(input: CallGraphIn, toPath: (uri: string) => string, sizes: Map<string, number> = new Map()): Graph {
	const scriptsByPath = new Map<string, ScriptIn>();
	const ids = new Map<string, string>(); // server id -> graph id
	const script = (path: string) => {
		if (!scriptsByPath.has(path)) scriptsByPath.set(path, { path, bytes: sizes.get(path) ?? 0, procedures: [] });
		return scriptsByPath.get(path)!;
	};
	const nodes: GraphNode[] = [];
	const topLevel = new Set<string>();
	for (const n of input.nodes) {
		const uri = n.location?.uri ?? n.container;
		const path = uri ? toPath(uri) : "";
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
		const edge = edges.get(key) ?? { from, to, crossScript: from.split("#")[0] !== to.split("#")[0], sites: [], kind: e.kind, resolved: e.resolved };
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
export const scriptOf = (id: string) => (isFold(id) ? id.slice(5) : id.slice(0, id.lastIndexOf("#")));

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
