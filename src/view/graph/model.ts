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
 * RunDS and Include are calls. The three class relations (CreateUdObject,
 * Method, Inherit) come from a server that sends them (L4 in
 * docs/LSP-REQUESTS.md); for one that does not, "inherits" is worked out
 * here, from the `:INHERIT` statement its syntax tree marks (graph/load.ts).
 */
export type Relation = "call" | "inherits" | "creates" | "method";
export const relationOf = (kind?: string): Relation => {
	const k = (kind ?? "").toLowerCase();
	return k.startsWith("inherit") ? "inherits" : k.startsWith("create") ? "creates" : k.startsWith("method") ? "method" : "call";
};
export const RELATION_WORDS: Record<Relation, string> = { call: "calls", inherits: "inherits", creates: "creates an object of", method: "calls the method" };

/**
 * Adds "this class inherits that one" to a graph, between the two scripts.
 * `parents` is each class file's path and the name it inherits, as written;
 * `scripts` is every script's name, as the server gives it, and its path. A
 * parent that is not in the workspace is left out: there is nothing to point at.
 */
export function addInheritance(graph: Graph, parents: Map<string, string>, scripts: Map<string, string>): Graph {
	const byName = new Map([...scripts].map(([name, path]) => [name.toLowerCase(), path]));
	// Outside a canonical layout the server names a script by its file alone, and :INHERIT still
	// names the category: the last part is then the name, as in the server's own resolution, when one script has it.
	const last = (name: string) => name.toLowerCase().split(".").pop()!;
	const byLast = new Map<string, string[]>();
	for (const [name, path] of scripts) byLast.set(last(name), [...(byLast.get(last(name)) ?? []), path]);
	const edges = [...graph.edges];
	const topLevel = new Set(graph.topLevel);
	for (const [path, parent] of parents) {
		const named = parent.trim().toLowerCase();
		const sameLast = byLast.get(last(named)) ?? [];
		const to = byName.get(named) ?? (sameLast.length === 1 ? sameLast[0] : undefined);
		if (!to || to === path || edges.some((e) => e.from === `${path}#` && e.to === `${to}#` && relationOf(e.kind) === "inherits")) continue;
		edges.push({ from: `${path}#`, to: `${to}#`, crossScript: true, sites: [], kind: "Inherit", resolved: true });
		topLevel.add(path).add(to);
	}
	return { ...graph, edges, topLevel: [...topLevel] };
}

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

export type Filter = { mode: "all" | "cross" | "around"; focus?: string; depth: number };

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
			if (focusIsScript(e.from) && !keep.has(e.to)) (keep.add(e.to), next.push(e.to));
			if (focusIsScript(e.to) && !keep.has(e.from)) (keep.add(e.from), next.push(e.from));
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
// procedure. Include edges run between scripts' top levels here. A server
// after 0.30.0 adds the class edges: CreateUdObject and Inherit end at a
// class file, which is that script's top level here, and Method at a method.

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
