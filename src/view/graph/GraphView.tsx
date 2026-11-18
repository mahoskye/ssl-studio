// Graph mode: scripts as boxes, regions inside them, procedures as nodes,
// calls as edges, laid out by ELK. Click a procedure, or press F on it, to
// focus its neighbourhood; double-click it, or press Enter, to open it. The
// same calls can be read as a plain list.
import ELK from "elkjs/lib/elk.bundled.js";
import { createEffect, createMemo, createSignal, For, on, Show } from "solid-js";
import { level } from "../../shared/houseStyle";
import { backend } from "../backend";
import { regionColor } from "../editor/regions";
import { openFile, setState, state } from "../state";
import { canvasMeasure, fitView, legibleScale, nearest, recall, remember, reveal, zoomAt, type Point } from "./canvas";
import { loadGraph } from "./load";
import { session } from "../lsp/session";
import { callList, RELATION_WORDS, topLabel, UNRESOLVED, visible, type Filter, type Graph, type ListedProc, relationOf, type Relation } from "./model";
import { baseName, relativeTo } from "../../shared/paths";

type Box = { id: string; x: number; y: number; width: number; height: number; label: string; kind: "script" | "region" | "proc" | "top"; path?: string; line?: number; region?: string; bytes?: number; nodeKind?: string };
type Line = { id: string; points: { x: number; y: number }[]; cross: boolean; count: number; relation: Relation };
type Mode = "graph" | "list";

const elk = new ELK();
// The size the style sheet gives the graph's words (.graph-canvas text), and a script's name in bold.
const FONT_PX = 12;
const measure = canvasMeasure(`${FONT_PX}px system-ui, sans-serif`, FONT_PX);
const measureBold = canvasMeasure(`600 ${FONT_PX}px system-ui, sans-serif`, FONT_PX);
const textWidth = (s: string) => Math.max(60, Math.ceil(measure(s)) + 24);
/** Fit never draws the words smaller than can be read; a larger graph is panned. */
const FIT_FLOOR = legibleScale(FONT_PX);
const MIN_ZOOM = 0.15;
const MAX_ZOOM = 3;
const MODE_KEY = "graph.view";

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

	const refresh = async () => {
		setProgress("Reading the workspace…");
		setFailed("");
		try {
			setGraph(await loadGraph((done, total) => setProgress(`Finding calls: ${done} of ${total} procedures`)));
		} catch (e: any) {
			setFailed(`Could not read the calls from the language server: ${e?.message ?? e}`);
		}
		setProgress("");
	};
	createEffect(on(() => [state.workspace?.root, state.lsp.state] as const, ([root, lsp]) => root && lsp === "running" && void refresh()));

	const shown = createMemo(() => {
		const g = graph();
		return g ? visible(g, filter()) : null;
	});
	const sizeNote = (bytes: number) => {
		const at = level(bytes, state.settings.limits.bytes);
		return `${(bytes / 1024).toFixed(1)} KB${at === "over" ? " (over the limit)" : at === "near" ? " (near the limit)" : ""}`;
	};

	createEffect(
		on([graph, shown, mode], async ([g, keep, as]) => {
			// The list needs no layout, and a large one takes a while.
			if (!g || !keep || as !== "graph") return;
			const sized = (label: string, bold = false) => ({ "elk.nodeSize.constraints": "MINIMUM_SIZE", "elk.nodeSize.minimum": `(${Math.ceil((bold ? measureBold : measure)(label)) + 20},30)` });
			const scripts = g.scripts
				.map((s) => {
					const procs = g.nodes.filter((n) => n.path === s.path && keep.nodes.has(n.id));
					const top = keep.nodes.has(`${s.path}#`) && g.topLevel.includes(s.path);
					if (!procs.length && !top) return null;
					const regions = [...new Set(procs.map((p) => p.region).filter(Boolean))] as string[];
					const leaf = (p: (typeof procs)[number]) => ({ id: p.id, width: textWidth(p.name), height: 26, labels: [{ text: p.name }] });
					return {
						id: `script:${s.path}`,
						labels: [{ text: s.isClass ? `class  ${rel(s.path)}` : rel(s.path) }],
						// Wide enough for its own name and size, so the label never runs over the next box.
						layoutOptions: { "elk.padding": "[top=30,left=12,bottom=12,right=12]", ...sized(`${rel(s.path)}  ${sizeNote(s.bytes)}`, true) },
						children: [
							...(top ? [{ id: `${s.path}#`, width: textWidth(topLabel(s)), height: 26, labels: [{ text: topLabel(s) }] }] : []),
							...procs.filter((p) => !p.region).map(leaf),
							...regions.map((r) => ({
								id: `region:${s.path}:${r}`,
								labels: [{ text: r }],
								layoutOptions: { "elk.padding": "[top=26,left=10,bottom=10,right=10]", ...sized(r) },
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
							path: script?.path ?? node?.path ?? (id.endsWith("#") ? id.slice(0, -1) : undefined),
							line: node?.line,
							nodeKind: node?.kind,
							region: id.startsWith("region:") ? n.labels?.[0]?.text : undefined,
							bytes: script?.bytes,
						});
					}
					for (const c of n.children ?? []) walk(c, x, y, depth + 1);
				};
				walk(result, 0, 0, 0);
				const lines: Line[] = (result.edges ?? []).map((e: any) => {
					const edge = keep.edges[Number(String(e.id).slice(1))]!;
					const section = e.sections?.[0];
					return {
						id: e.id,
						points: section ? [section.startPoint, ...(section.bendPoints ?? []), section.endPoint] : [],
						cross: edge.crossScript,
						count: edge.sites.length,
						relation: relationOf(edge.kind),
					};
				});
				// The nodes are drawn afresh: the one the keyboard was on takes the focus again.
				const hadFocus = Boolean(svg && svg.contains(document.activeElement));
				nodeEls.clear();
				setLayout({ boxes, lines, width: result.width, height: result.height });
				// A different set of calls is a different picture: show it whole. A refresh keeps the view.
				const key = JSON.stringify(filter());
				if (fittedFor !== key) fit();
				fittedFor = key;
				if (hadFocus) queueMicrotask(() => nodeEls.get(cursor() ?? "")?.focus());
			} catch (e: any) {
				setProgress(`Layout failed: ${e?.message ?? e}`);
			}
		}),
	);

	const path = (points: { x: number; y: number }[]) => (points.length ? `M${points.map((p) => `${p.x},${p.y}`).join(" L")}` : "");
	const focus = (id: string) => setFilter({ mode: "around", focus: id, depth: filter().depth });
	const open = (at: { path?: string; line?: number }) => {
		if (!at.path || at.path === UNRESOLVED) return;
		setState("centerView", "editors");
		void openFile(at.path, { reveal: { line: (at.line ?? 0) + 1 } });
	};
	const procs = () => layout()?.boxes.filter((b) => b.kind === "proc" || b.kind === "top") ?? [];
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
		nodeEls.get(b.id)?.focus();
		setView((v) => reveal(v, b, size()));
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
			Enter: () => here && open(here),
			f: () => here && focus(here.id),
			"+": () => zoomBy(1.2),
			"=": () => zoomBy(1.2),
			"-": () => zoomBy(1 / 1.2),
			"0": fit,
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
		const kind = KIND_WORDS[b.kind === "top" ? (graph()?.scripts.find((s) => s.path === b.path)?.isClass ? "class" : "top") : (b.nodeKind ?? "procedure")];
		const where = b.path && b.path !== UNRESOLVED ? `${kind} in ${rel(b.path)}` : kind;
		return `${b.label}: ${where}${filter().focus === b.id ? ", the focus" : ""}`;
	};

	/** Whether the graph has an edge of this relation: the key explains only the lines that can be seen. */
	const has = (relation: Relation) => Boolean(graph()?.edges.some((e) => relationOf(e.kind) === relation));

	/** A method call is a call; creating an object and inheriting are not, and are counted as what they are. */
	const counted = () => {
		const edges = graph()?.edges ?? [];
		const classes = edges.filter((e) => ["creates", "inherits"].includes(relationOf(e.kind))).length;
		return `${edges.length - classes} calls${classes ? `, ${classes} class relations` : ""}`;
	};

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
				<label>
					Show
					<select value={filter().mode} onChange={(e) => setFilter({ ...filter(), mode: e.currentTarget.value as Filter["mode"] })}>
						<option value="all">Every call</option>
						<option value="cross">Calls between scripts</option>
						<option value="around" disabled={!filter().focus}>
							Around the focus
						</option>
					</select>
				</label>
				<Show when={filter().mode === "around"}>
					<label>
						Depth <input type="number" min="1" max="6" value={filter().depth} onChange={(e) => setFilter({ ...filter(), depth: Number(e.currentTarget.value) || 1 })} />
					</label>
					<span class="hint">{filter().focus ? baseName(filter().focus!) : ""}</span>
				</Show>
				<span class="spacer" />
				<span class="hint" role="status">
					{progress() || (graph() ? `${graph()!.nodes.length} procedures, ${counted()}${graph()!.truncated ? " (incomplete: refresh when indexing ends)" : ""}` : "")}
				</span>
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
				<button disabled={state.lsp.state !== "running"} title={state.lsp.state === "running" ? "Read the calls again" : "Needs the language server"} onClick={() => void refresh()}>
					Refresh
				</button>
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
					<p class="hint graph-help">
						The arrow keys move between procedures. Enter or a double-click opens one; F or a click shows only its callers and callees.
						{session.supports("ssl/callGraph") ? "" : " Data sources and :INCLUDEs appear once the server offers its call graph."}
					</p>
					<ul class="graph-legend" aria-label="What the graph's shapes and lines mean">
						<li>
							<svg class="graph-key" viewBox="0 0 26 14" aria-hidden="true">
								<g class="g-proc">
									<rect x="1" y="1" width="24" height="12" rx="3" />
								</g>
							</svg>
							Procedure
						</li>
						<li>
							<svg class="graph-key" viewBox="0 0 26 14" aria-hidden="true">
								<g class="g-proc datasource">
									<rect x="1" y="1" width="24" height="12" rx="3" />
								</g>
							</svg>
							Data source
						</li>
						<li>
							<svg class="graph-key" viewBox="0 0 26 14" aria-hidden="true">
								<g class="g-proc unresolved">
									<rect x="1" y="1" width="24" height="12" rx="3" />
								</g>
							</svg>
							Target not resolved
						</li>
						<li>
							<svg class="graph-key" viewBox="0 0 26 14" aria-hidden="true">
								<g class="g-top">
									<rect x="1" y="1" width="24" height="12" rx="3" />
								</g>
							</svg>
							Code outside any procedure
						</li>
						<li>
							<svg class="graph-key" viewBox="0 0 26 14" aria-hidden="true">
								<path class="g-edge" d="M1,7 L25,7" />
							</svg>
							Call within a script
						</li>
						<li>
							<svg class="graph-key" viewBox="0 0 26 14" aria-hidden="true">
								<path class="g-edge cross" d="M1,7 L25,7" />
							</svg>
							Call between scripts
						</li>
						<li>
							<svg class="graph-key" viewBox="0 0 26 14" aria-hidden="true">
								<path class="g-edge" d="M1,7 L25,7" stroke-width="4" />
							</svg>
							Thicker: called from more places
						</li>
						<li>
							<svg class="graph-key" viewBox="0 0 26 14" aria-hidden="true">
								<path class="g-edge inherits" d="M1,7 L25,7" />
							</svg>
							Dashed: a class inherits another
						</li>
						<Show when={has("creates")}>
							<li>
								<svg class="graph-key" viewBox="0 0 26 14" aria-hidden="true">
									<path class="g-edge creates" d="M1,7 L25,7" />
								</svg>
								Dotted: creates an object of a class
							</li>
						</Show>
						<Show when={has("method")}>
							<li>
								<svg class="graph-key" viewBox="0 0 26 14" aria-hidden="true">
									<path class="g-edge method" d="M1,7 L25,7" />
								</svg>
								Dash and dot: calls a method
							</li>
						</Show>
						<li>
							<svg class="graph-key" viewBox="0 0 26 14" aria-hidden="true">
								<g class="g-script near">
									<rect x="2" y="2" width="22" height="10" rx="3" />
								</g>
							</svg>
							Script near its size limit
						</li>
						<li>
							<svg class="graph-key" viewBox="0 0 26 14" aria-hidden="true">
								<g class="g-script over">
									<rect x="2" y="2" width="22" height="10" rx="3" />
								</g>
							</svg>
							Script over its size limit
						</li>
					</ul>
					<svg
						class="graph-canvas"
						ref={svg}
						role="group"
						aria-label="Call graph. The arrow keys move between procedures, Enter opens one, F shows only its callers and callees."
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
												<Show when={b.kind === "script"}>
													<title>{`${b.path ?? b.label}: ${sizeNote(b.bytes ?? 0)}. Click its name to show only this script's calls.`}</title>
												</Show>
												<rect x={b.x} y={b.y} width={b.width} height={b.height} rx="6" style={b.region ? { stroke: regionColor(b.region), fill: `color-mix(in srgb, ${regionColor(b.region)} 8%, transparent)` } : undefined} />
												<text x={b.x + 8} y={b.y + 17} onClick={() => b.kind === "script" && focus(`${b.path}#`)}>
													{b.label}
													{b.kind === "script" ? `  ${sizeNote(b.bytes ?? 0)}` : ""}
												</text>
											</g>
										)}
									</For>
									<For each={l().lines}>{(e) => <path d={path(e.points)} class="g-edge" classList={{ cross: e.cross && e.relation === "call", [e.relation]: e.relation !== "call" }} marker-end="url(#arrow)" stroke-width={Math.min(4, 1 + e.count / 2)} />}</For>
									<For each={l().boxes.filter((b) => b.kind === "proc" || b.kind === "top")}>
										{(b) => (
											<g
												class={`g-${b.kind} ${b.nodeKind ?? ""}`}
												classList={{ focus: filter().focus === b.id }}
												ref={(el) => nodeEls.set(b.id, el)}
												tabindex={cursor() === b.id ? 0 : -1}
												role="button"
												aria-label={titleOf(b)}
												onFocus={() => setCurrent(b.id)}
												onClick={(e) => (e.stopPropagation(), focus(b.id))}
												onDblClick={() => open(b)}
											>
												<title>{`${titleOf(b)}. Enter or a double-click opens it; F or a click shows only its callers and callees.`}</title>
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
