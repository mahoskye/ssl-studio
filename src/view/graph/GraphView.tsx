// Graph mode: scripts as boxes, regions inside them, procedures as nodes,
// calls as edges, laid out by ELK. Click a procedure to focus its
// neighbourhood; double-click to open it.
import ELK from "elkjs/lib/elk.bundled.js";
import { createEffect, createSignal, For, on, Show } from "solid-js";
import { level } from "../../shared/houseStyle";
import { regionColor } from "../editor/regions";
import { openFile, setState, state } from "../state";
import { loadGraph } from "./load";
import { session } from "../lsp/session";
import { visible, type Filter, type Graph } from "./model";
import { baseName, relativeTo } from "../../shared/paths";

type Box = { id: string; x: number; y: number; width: number; height: number; label: string; kind: "script" | "region" | "proc" | "top"; path?: string; line?: number; region?: string; bytes?: number; nodeKind?: string };
type Line = { id: string; points: { x: number; y: number }[]; cross: boolean; count: number };

const elk = new ELK();
const textWidth = (s: string) => Math.max(60, s.length * 7.2 + 24);

export function GraphView() {
	const [graph, setGraph] = createSignal<(Graph & { truncated: boolean }) | null>(null);
	const [progress, setProgress] = createSignal("");
	const [filter, setFilter] = createSignal<Filter>({ mode: "all", depth: 1 });
	const [layout, setLayout] = createSignal<{ boxes: Box[]; lines: Line[]; width: number; height: number } | null>(null);
	const [view, setView] = createSignal({ x: 20, y: 20, scale: 1 });
	const rel = (path: string) => relativeTo(state.workspace?.root, path);

	const refresh = async () => {
		setProgress("Reading the workspace…");
		try {
			setGraph(await loadGraph((done, total) => setProgress(`Finding calls: ${done} of ${total} procedures`)));
			setProgress("");
		} catch (e: any) {
			setProgress(`Could not read the workspace: ${e?.message ?? e}`);
		}
	};
	createEffect(on(() => [state.workspace?.root, state.lsp.state] as const, ([root, lsp]) => root && lsp === "running" && void refresh()));

	createEffect(
		on([graph, filter], async ([g, f]) => {
			if (!g) return;
			const keep = visible(g, f);
			const scripts = g.scripts
				.map((s) => {
					const procs = g.nodes.filter((n) => n.path === s.path && keep.nodes.has(n.id));
					const top = keep.nodes.has(`${s.path}#`) && g.topLevel.includes(s.path);
					if (!procs.length && !top) return null;
					const regions = [...new Set(procs.map((p) => p.region).filter(Boolean))] as string[];
					const leaf = (p: (typeof procs)[number]) => ({ id: p.id, width: textWidth(p.name), height: 26, labels: [{ text: p.name }] });
					return {
						id: `script:${s.path}`,
						labels: [{ text: rel(s.path) }],
						layoutOptions: { "elk.padding": "[top=30,left=12,bottom=12,right=12]" },
						children: [
							...(top ? [{ id: `${s.path}#`, width: 90, height: 26, labels: [{ text: "(top level)" }] }] : []),
							...procs.filter((p) => !p.region).map(leaf),
							...regions.map((r) => ({
								id: `region:${s.path}:${r}`,
								labels: [{ text: r }],
								layoutOptions: { "elk.padding": "[top=26,left=10,bottom=10,right=10]" },
								children: procs.filter((p) => p.region === r).map(leaf),
							})),
						],
					};
				})
				.filter(Boolean) as any[];
			const edges = keep.edges.map((e, i) => ({ id: `e${i}`, sources: [e.from], targets: [e.to] }));
			try {
				const result: any = await elk.layout({
					id: "root",
					layoutOptions: {
						"elk.algorithm": "layered",
						"elk.direction": "RIGHT",
						"elk.hierarchyHandling": "INCLUDE_CHILDREN",
						"elk.spacing.nodeNode": "18",
						"elk.layered.spacing.nodeNodeBetweenLayers": "40",
						"elk.json.edgeCoords": "ROOT",
						"elk.edgeRouting": "SPLINES",
					},
					children: scripts,
					edges,
				});
				const boxes: Box[] = [];
				const walk = (n: any, ox: number, oy: number, depth: number) => {
					const x = ox + (n.x ?? 0);
					const y = oy + (n.y ?? 0);
					const id: string = n.id;
					if (id !== "root") {
						const script = id.startsWith("script:") ? g.scripts.find((s) => `script:${s.path}` === id) : undefined;
						const node = g.nodes.find((p) => p.id === id);
						boxes.push({
							id,
							x,
							y,
							width: n.width,
							height: n.height,
							label: n.labels?.[0]?.text ?? "",
							kind: script ? "script" : id.startsWith("region:") ? "region" : id.endsWith("#") ? "top" : "proc",
							path: script?.path ?? node?.path,
							line: node?.line,
							nodeKind: node?.kind,
							region: id.startsWith("region:") ? n.labels?.[0]?.text : undefined,
							bytes: script?.bytes,
						});
					}
					for (const c of n.children ?? []) walk(c, x, y, depth + 1);
				};
				walk(result, 0, 0, 0);
				const lines: Line[] = (result.edges ?? []).map((e: any, i: number) => {
					const section = e.sections?.[0];
					return {
						id: e.id,
						points: section ? [section.startPoint, ...(section.bendPoints ?? []), section.endPoint] : [],
						cross: keep.edges[i]!.crossScript,
						count: keep.edges[i]!.sites.length,
					};
				});
				setLayout({ boxes, lines, width: result.width, height: result.height });
			} catch (e: any) {
				setProgress(`Layout failed: ${e?.message ?? e}`);
			}
		}),
	);

	const path = (points: { x: number; y: number }[]) => (points.length ? `M${points.map((p) => `${p.x},${p.y}`).join(" L")}` : "");
	const focus = (id: string) => setFilter({ mode: "around", focus: id, depth: filter().depth });
	let dragging: { x: number; y: number } | null = null;

	return (
		<div class="graph">
			<div class="graph-bar">
				<strong>Graph</strong>
				<select value={filter().mode} onChange={(e) => setFilter({ ...filter(), mode: e.currentTarget.value as Filter["mode"] })}>
					<option value="all">Every call</option>
					<option value="cross">Calls between scripts</option>
					<option value="around" disabled={!filter().focus}>
						Around the focus
					</option>
				</select>
				<Show when={filter().mode === "around"}>
					<label>
						depth <input type="number" min="1" max="6" value={filter().depth} onChange={(e) => setFilter({ ...filter(), depth: Number(e.currentTarget.value) || 1 })} />
					</label>
					<span class="hint">{filter().focus ? baseName(filter().focus!) : ""}</span>
				</Show>
				<span class="spacer" />
				<span class="hint">{progress() || (graph() ? `${graph()!.nodes.length} procedures, ${graph()!.edges.length} calls${graph()!.truncated ? " (truncated)" : ""}` : "")}</span>
				<button onClick={() => void refresh()}>Refresh</button>
				<button onClick={() => setView({ x: 20, y: 20, scale: 1 })}>Fit</button>
				<button onClick={() => setState("centerView", "editors")}>Close</button>
			</div>
			<p class="hint graph-help">
				Click a procedure to focus its callers and callees; double-click to open it. Scripts over the size ceiling are marked (decision 0006).{" "}
				{session.supports("ssl/callGraph") ? "Data sources and unresolved targets come from the server's call graph." : "Data sources and :INCLUDEs appear once the server offers its call graph."}
			</p>
			<svg
				class="graph-canvas"
				onWheel={(e) => {
					e.preventDefault();
					const v = view();
					const scale = Math.min(3, Math.max(0.15, v.scale * (e.deltaY < 0 ? 1.1 : 0.9)));
					setView({ ...v, scale });
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
					<marker id="arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
						<path d="M0,0 L10,5 L0,10 z" class="arrow" />
					</marker>
				</defs>
				<Show when={layout()}>
					{(l) => (
						<g transform={`translate(${view().x},${view().y}) scale(${view().scale})`}>
							<For each={l().boxes.filter((b) => b.kind === "script" || b.kind === "region")}>
								{(b) => (
									<g class={`g-${b.kind}`} classList={{ [level(b.bytes ?? 0, state.settings.limits.bytes)]: b.kind === "script" }}>
										<rect x={b.x} y={b.y} width={b.width} height={b.height} rx="6" style={b.region ? { stroke: regionColor(b.region), fill: `color-mix(in srgb, ${regionColor(b.region)} 8%, transparent)` } : undefined} />
										<text x={b.x + 8} y={b.y + 17} style={b.region ? { fill: regionColor(b.region) } : undefined} onClick={() => b.kind === "script" && focus(`${b.path}#`)}>
											{b.label}
											{b.kind === "script" ? `  ${((b.bytes ?? 0) / 1024).toFixed(1)} KB` : ""}
										</text>
									</g>
								)}
							</For>
							<For each={l().lines}>{(e) => <path d={path(e.points)} class="g-edge" classList={{ cross: e.cross }} marker-end="url(#arrow)" stroke-width={Math.min(4, 1 + e.count / 2)} />}</For>
							<For each={l().boxes.filter((b) => b.kind === "proc" || b.kind === "top")}>
								{(b) => (
									<g
										class={`g-${b.kind} ${b.nodeKind ?? ""}`}
										classList={{ focus: filter().focus === b.id }}
										onClick={(e) => (e.stopPropagation(), focus(b.id))}
										onDblClick={() => b.path && (setState("centerView", "editors"), void openFile(b.path, { reveal: { line: (b.line ?? 0) + 1 } }))}
									>
										<rect x={b.x} y={b.y} width={b.width} height={b.height} rx="4" />
										<text x={b.x + b.width / 2} y={b.y + 17} text-anchor="middle">
											{b.label}
										</text>
									</g>
								)}
							</For>
						</g>
					)}
				</Show>
			</svg>
		</div>
	);
}
