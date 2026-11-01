// Graph mode's data: scripts, their regions and procedures, and the calls
// between procedures. Built from the language server's workspace symbols,
// document symbols and references: the server resolves DoProc and
// ExecFunction targets, so a reference from another procedure is a call.
// Data sources and :INCLUDE edges wait for the server's call graph (L2).

export type ProcIn = { name: string; region?: string; startLine: number; endLine: number };
export type ScriptIn = { path: string; bytes: number; procedures: ProcIn[] };
export type CallIn = { callee: string; path: string; line: number };

export type GraphNode = { id: string; name: string; path: string; region?: string; line: number };
export type GraphEdge = { from: string; to: string; crossScript: boolean; sites: { path: string; line: number }[] };
export type Graph = { scripts: ScriptIn[]; nodes: GraphNode[]; edges: GraphEdge[]; topLevel: string[] };

export const procId = (path: string, name: string) => `${path}#${name}`;

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
