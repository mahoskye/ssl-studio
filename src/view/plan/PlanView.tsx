// A plan as a flow chart, laid out by ELK. A view of the plan's text: every
// action is one undoable text edit on the model the text view shows, and the
// selected node is the one under the text cursor (ADR 0002, ADR 0005).
import ELK from "elkjs/lib/elk.bundled.js";
import { createEffect, createMemo, createSignal, For, on, onCleanup, onMount, Show, untrack } from "solid-js";
import { ask } from "../dialogs";
import { editors } from "../editor/EditorGroup";
import { monaco } from "../editor/monaco";
import { regionColor } from "../editor/regions";
import { diagnostics } from "../lsp/session";
import { documents, notify, setState, state, applyText } from "../state";
import { nodeStatuses } from "./build";
import { assistOf } from "./run";
import { PlanAssistant } from "./PlanAssistant";
import { previewPlan } from "./assist";
import { addAfter, addBranch, addCall, connect, nodeAtLine, nodeLines, parsePlan, printPlan, PROCEDURE_DRAG, removeEdge, removeNode, setDecision, setEdgeLabel, setGroup, setText, type Edit, type NodeKind, type Plan, type PlanEdge, type PlanNode } from "./model";

type Box = { id: string; x: number; y: number; width: number; height: number; node?: PlanNode; lines: string[]; group?: string };
type Line = { id: string; from: string; to: string; label?: string; points: { x: number; y: number }[]; at: { x: number; y: number }; missing: boolean; pending: boolean; removing: boolean };
type Layout = { boxes: Box[]; lines: Line[]; width: number; height: number };

const elk = new ELK();
const LINE = 17;
const SIZES: Record<NodeKind, { width: number; chars: number; pad: number }> = {
	start: { width: 170, chars: 22, pad: 18 },
	end: { width: 170, chars: 22, pad: 18 },
	step: { width: 190, chars: 25, pad: 20 },
	call: { width: 190, chars: 22, pad: 20 },
	decision: { width: 230, chars: 20, pad: 54 },
};

function wrap(text: string, chars: number): string[] {
	const lines: string[] = [];
	let line = "";
	for (const word of (text.trim() || "(no words yet)").split(/\s+/)) {
		if (line && line.length + word.length + 1 > chars) {
			lines.push(line);
			line = word;
		} else line = line ? `${line} ${word}` : word;
	}
	lines.push(line);
	return lines;
}

/** Where an edge's label sits: the middle of its longest stretch. */
function labelPoint(points: { x: number; y: number }[]) {
	let best = { x: 0, y: 0 };
	let length = -1;
	for (let i = 1; i < points.length; i++) {
		const [a, b] = [points[i - 1]!, points[i]!];
		const d = Math.abs(a.x - b.x) + Math.abs(a.y - b.y);
		if (d > length) (length = d), (best = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });
	}
	return best;
}

async function layoutPlan(plan: Plan): Promise<Layout> {
	const ids = new Set<string>();
	const nodes = plan.nodes.filter((n) => !ids.has(n.id) && ids.add(n.id));
	const sized = new Map(nodes.map((n) => [n.id, wrap(n.text, SIZES[n.kind].chars)]));
	const leaf = (n: PlanNode) => ({ id: n.id, width: SIZES[n.kind].width, height: sized.get(n.id)!.length * LINE + SIZES[n.kind].pad });
	const edges = plan.edges.filter((e) => ids.has(e.from) && ids.has(e.to));
	const groups = plan.groups.filter((g) => nodes.some((n) => n.group === g.id));
	const known = new Set(groups.map((g) => g.id));
	const result: any = await elk.layout({
		id: "root",
		layoutOptions: {
			"elk.algorithm": "layered",
			"elk.direction": "DOWN",
			"elk.hierarchyHandling": "INCLUDE_CHILDREN",
			"elk.edgeRouting": "ORTHOGONAL",
			"elk.spacing.nodeNode": "34",
			"elk.layered.spacing.nodeNodeBetweenLayers": "46",
			"elk.json.edgeCoords": "ROOT",
		},
		children: [
			...nodes.filter((n) => !n.group || !known.has(n.group)).map(leaf),
			...groups.map((g) => ({
				id: g.id,
				layoutOptions: { "elk.padding": "[top=30,left=16,bottom=16,right=16]" },
				children: nodes.filter((n) => n.group === g.id).map(leaf),
			})),
		],
		edges: edges.map((e, i) => ({ id: `e${i}`, sources: [e.from], targets: [e.to] })),
	});
	const boxes: Box[] = [];
	const walk = (n: any, ox: number, oy: number) => {
		const x = ox + (n.x ?? 0);
		const y = oy + (n.y ?? 0);
		if (n.id !== "root") {
			const node = nodes.find((p) => p.id === n.id);
			boxes.push({ id: n.id, x, y, width: n.width, height: n.height, node, lines: node ? sized.get(node.id)! : [], group: node ? undefined : groups.find((g) => g.id === n.id)?.name });
		}
		for (const c of n.children ?? []) walk(c, x, y);
	};
	walk(result, 0, 0);
	const decisions = new Set(nodes.filter((n) => n.kind === "decision").map((n) => n.id));
	const lines: Line[] = (result.edges ?? []).map((e: any, i: number) => {
		const edge: PlanEdge = edges[i]!;
		const section = e.sections?.[0];
		const points = section ? [section.startPoint, ...(section.bendPoints ?? []), section.endPoint] : [];
		return { id: e.id, from: edge.from, to: edge.to, label: edge.label, points, at: labelPoint(points), missing: decisions.has(edge.from) && !edge.label?.trim(), pending: Boolean(edge.pending), removing: Boolean(edge.removing) };
	});
	return { boxes, lines, width: result.width, height: result.height };
}

const pathOf = (points: { x: number; y: number }[]) => (points.length ? `M${points.map((p) => `${p.x},${p.y}`).join(" L")}` : "");

export function PlanView(props: { path: string; group: number }) {
	const doc = () => documents.get(props.path);
	const [text, setTextSignal] = createSignal(doc()?.model.getValue() ?? "");
	const parsed = createMemo(() => parsePlan(text()));
	const plan = () => parsed().plan;
	const [layout, setLayout] = createSignal<Layout | null>(null);
	const [view, setView] = createSignal({ x: 20, y: 20, scale: 1 });
	const [edge, setEdge] = createSignal<{ from: string; to: string } | null>(null);
	const [linking, setLinking] = createSignal<string | null>(null);
	const [assistant, setAssistant] = createSignal(true);
	/** What the small text box is editing, over the chart. */
	const [editing, setEditing] = createSignal<{ node: string } | { from: string; to: string } | null>(null);
	let canvas!: HTMLDivElement;
	let fitted = false;
	let seen = 0;

	onMount(() => {
		const model = doc()?.model;
		if (!model) return;
		const sub = model.onDidChangeContent(() => setTextSignal(model.getValue()));
		onCleanup(() => sub.dispose());
		queueMicrotask(() => canvas?.focus());
	});

	let layoutRun = 0;
	createEffect(
		on([parsed, () => assistOf(props.path).suggestions] as const, async ([result, suggestions]) => {
			if (!result.plan) return;
			const run = ++layoutRun;
			try {
				// What the agent proposes is drawn, marked, until you accept or decline it.
				const next = await layoutPlan(previewPlan(result.plan, suggestions));
				if (run !== layoutRun) return;
				setLayout(next);
				// New suggestions can grow the chart past the view.
				if (!fitted || suggestions.length !== seen) fit();
				fitted = true;
				seen = suggestions.length;
			} catch (e: any) {
				notify(`Could not lay out the chart: ${e?.message ?? e}`, "error");
			}
		}),
	);

	const fit = () => {
		const l = layout();
		if (!l || !canvas) return;
		const box = canvas.getBoundingClientRect();
		const scale = Math.min(1, Math.max(0.2, Math.min((box.width - 40) / (l.width || 1), (box.height - 40) / (l.height || 1))));
		setView({ x: Math.max(20, (box.width - l.width * scale) / 2), y: 20, scale });
	};

	const selected = createMemo(() => {
		const p = plan();
		if (!p || state.groups[state.activeGroup]?.active !== props.path) return null;
		return nodeAtLine(text(), p, state.cursor.line);
	});
	const selectedNode = () => plan()?.nodes.find((n) => n.id === selected());
	const moveCursor = (line: number) => {
		setState("activeGroup", props.group);
		editors[props.group]?.setSelection(new monaco.Range(line, 1, line, 1));
		setState("cursor", { line, column: 1 });
	};
	const select = (id: string | null | undefined) => {
		setEdge(null);
		const p = plan();
		const line = id && p ? nodeLines(text(), p).get(id) : undefined;
		moveCursor(line ?? 1);
	};

	// Keep the selection in sight, as an edit or an arrow key may land off screen.
	createEffect(() => {
		const id = selected();
		const l = layout();
		const box = id && l?.boxes.find((b) => b.id === id);
		if (!box || !canvas) return;
		const { width, height } = canvas.getBoundingClientRect();
		const v = untrack(view);
		const margin = 24;
		const dx = Math.min(0, width - margin - (box.x + box.width) * v.scale - v.x) || Math.max(0, margin - box.x * v.scale - v.x);
		const dy = Math.min(0, height - margin - (box.y + box.height) * v.scale - v.y) || Math.max(0, margin - box.y * v.scale - v.y);
		if (dx || dy) setView({ ...v, x: v.x + dx, y: v.y + dy });
	});

	/** Findings on each node, from what Problems shows, so the two cannot disagree. */
	const issues = createMemo(() => {
		const map = new Map<string, string[]>();
		const p = plan();
		const uri = doc()?.model.uri.toString();
		if (!p || !uri) return map;
		for (const d of diagnostics[uri] ?? []) {
			const id = nodeAtLine(text(), p, d.line);
			if (id) map.set(id, [...(map.get(id) ?? []), d.message]);
		}
		return map;
	});
	const unitStatuses = createMemo(() => nodeStatuses(assistOf(props.path).run));
	const findingCount = () => diagnostics[doc()?.model.uri.toString() ?? ""]?.length ?? 0;

	const apply = (next: Plan, selectId?: string | null) => {
		applyText(props.path, printPlan(next));
		if (selectId !== undefined) select(selectId);
	};
	const applyEdit = (result: Edit | null, edit = false) => {
		if (!result) return;
		apply(result.plan, result.select ?? null);
		if (edit && result.select) setEditing({ node: result.select });
	};
	const refocus = () => queueMicrotask(() => canvas?.focus());

	const addNext = () => {
		const p = plan();
		const at = selected();
		if (!p) return;
		if (!at) return notify("Select a node to add after it.");
		applyEdit(addAfter(p, at), true);
	};
	const addOther = () => {
		const p = plan();
		const at = selected();
		if (!p || !at) return notify("Select a step or decision to branch from.");
		const result = addBranch(p, at);
		if (!result) return notify("Only a step or a decision can branch.");
		applyEdit(result, true);
	};
	const toggleDecision = () => {
		const p = plan();
		const node = selectedNode();
		if (p && node && (node.kind === "step" || node.kind === "decision")) apply(setDecision(p, node.id, node.kind === "step"));
	};
	const remove = () => {
		const p = plan();
		const e = edge();
		if (!p) return;
		if (e) {
			apply(removeEdge(p, e.from, e.to));
			return setEdge(null);
		}
		const at = selected();
		if (at) applyEdit(removeNode(p, at));
	};
	const addCallAsk = async () => {
		const p = plan();
		if (!p) return;
		const ref = (await ask("Procedure, script or data source this calls"))?.trim();
		if (ref) applyEdit(addCall(p, ref, selected() ?? undefined));
		refocus();
	};
	const beginLink = () => {
		const at = selected();
		if (at) setLinking(at);
		else notify("Select the node the connection starts from.");
	};
	const undo = (action: "undo" | "redo") => editors[props.group]?.trigger("plan", action, null);

	/** The nearest node in a direction, for the arrow keys. */
	const step = (dx: number, dy: number) => {
		const l = layout();
		if (!l) return;
		const nodes = l.boxes.filter((b) => b.node);
		const here = nodes.find((b) => b.id === selected());
		if (!here) return select(nodes[0]?.id);
		const cx = (b: Box) => b.x + b.width / 2;
		const cy = (b: Box) => b.y + b.height / 2;
		let best: Box | undefined;
		let score = Infinity;
		for (const b of nodes) {
			if (b === here) continue;
			const along = (cx(b) - cx(here)) * dx + (cy(b) - cy(here)) * dy;
			if (along <= 0) continue;
			const across = Math.abs((cx(b) - cx(here)) * dy) + Math.abs((cy(b) - cy(here)) * dx);
			if (along + across * 2 < score) (score = along + across * 2), (best = b);
		}
		if (best) select(best.id);
	};

	const onKey = (e: KeyboardEvent) => {
		if (editing() || e.target !== canvas) return;
		const mod = e.ctrlKey || e.metaKey;
		if (mod && e.key.toLowerCase() === "z") {
			e.preventDefault();
			return undo(e.shiftKey ? "redo" : "undo");
		}
		if (mod && e.key.toLowerCase() === "y") {
			e.preventDefault();
			return undo("redo");
		}
		if (mod || e.altKey) return;
		const actions: Record<string, () => void> = {
			Enter: addNext,
			Tab: addOther,
			F2: () => {
				const e2 = edge();
				if (e2) setEditing(e2);
				else if (selected()) setEditing({ node: selected()! });
			},
			Delete: remove,
			Backspace: remove,
			d: toggleDecision,
			c: beginLink,
			Escape: () => {
				if (linking()) setLinking(null);
				else select(null);
			},
			ArrowUp: () => step(0, -1),
			ArrowDown: () => step(0, 1),
			ArrowLeft: () => step(-1, 0),
			ArrowRight: () => step(1, 0),
		};
		const action = actions[e.key];
		if (action) {
			e.preventDefault();
			action();
		}
	};

	const clickNode = (id: string) => {
		const from = linking();
		const p = plan();
		if (from && p) {
			setLinking(null);
			apply(connect(p, from, id));
		} else select(id);
		refocus();
	};

	// The small text box over the chart.
	const editBox = () => {
		const target = editing();
		const l = layout();
		const v = view();
		if (!target || !l) return null;
		if ("node" in target) {
			const b = l.boxes.find((x) => x.id === target.node);
			return b ? { left: b.x * v.scale + v.x, top: (b.y + b.height / 2 - 13) * v.scale + v.y, width: Math.max(150, b.width * v.scale) } : null;
		}
		const line = l.lines.find((x) => x.from === target.from && x.to === target.to);
		return line ? { left: line.at.x * v.scale + v.x - 50, top: line.at.y * v.scale + v.y - 13, width: 100 } : null;
	};
	const editValue = () => {
		const target = editing();
		const p = plan();
		if (!target || !p) return "";
		if ("node" in target) return p.nodes.find((n) => n.id === target.node)?.text ?? "";
		return p.edges.find((e) => e.from === target.from && e.to === target.to)?.label ?? "";
	};
	const commitEdit = (value: string) => {
		const target = editing();
		const p = plan();
		setEditing(null);
		refocus();
		if (!target || !p) return;
		if ("node" in target) {
			if (value.trim() && value !== p.nodes.find((n) => n.id === target.node)?.text) apply(setText(p, target.node, value.trim()));
		} else if (value !== (p.edges.find((e) => e.from === target.from && e.to === target.to)?.label ?? "")) apply(setEdgeLabel(p, target.from, target.to, value.trim()));
	};

	const setPlanField = (field: "title" | "goal", value: string) => {
		const p = plan();
		if (!p) return;
		const { [field]: _old, ...rest } = p;
		apply((value.trim() || field === "title" ? { ...rest, [field]: value.trim() } : rest) as Plan);
	};
	const setTargets = (value: string) => {
		const p = plan();
		if (!p) return;
		const { targets: _old, ...rest } = p;
		const list = value.split(",").map((t) => t.trim()).filter(Boolean);
		apply((list.length ? { ...rest, targets: list } : rest) as Plan);
	};
	const setNodeField = (field: "notes" | "ref", value: string) => {
		const p = plan();
		const node = selectedNode();
		if (!p || !node) return;
		const nodes = p.nodes.map((n) => {
			if (n.id !== node.id) return n;
			const { [field]: _old, ...rest } = n;
			return (value.trim() ? { ...rest, [field]: value.trim() } : rest) as PlanNode;
		});
		apply({ ...p, nodes });
	};
	const groupName = () => plan()?.groups.find((g) => g.id === selectedNode()?.group)?.name ?? "";

	let dragging: { x: number; y: number; moved: boolean } | null = null;

	return (
		<div class="plan">
			<Show
				when={plan()}
				fallback={
					<div class="plan-error">
						<p>This plan's text cannot be read as a chart.</p>
						<p class="hint">{parsed().error}</p>
						<button onClick={() => setState("planText", props.path, true)}>Fix it in the text</button>
					</div>
				}
			>
				<div class="graph-bar plan-bar">
					<strong>{plan()!.title || "Plan"}</strong>
					<button title="The next step (Enter)" onClick={() => (addNext(), refocus())}>
						Add step
					</button>
					<button title="Another way out (Tab)" onClick={() => (addOther(), refocus())}>
						Add branch
					</button>
					<button title="Something that already exists" onClick={() => void addCallAsk()}>
						Add call
					</button>
					<button title="Step or decision (D)" onClick={() => (toggleDecision(), refocus())}>
						Decision
					</button>
					<button title="Connect the selected node to another (C)" classList={{ on: Boolean(linking()) }} onClick={() => (linking() ? setLinking(null) : beginLink(), refocus())}>
						Connect
					</button>
					<button title="Delete the selection (Delete); undo brings it back" onClick={() => (remove(), refocus())}>
						Delete
					</button>
					<span class="spacer" />
					<button title="The agent's questions, suggestions and spec" classList={{ on: assistant() }} onClick={() => setAssistant((v) => !v)}>
						Assistant
					</button>
					<button class="link" title="Show the findings in Problems" onClick={() => (setState("bottomView", "problems"), setState("settings", "layout", "bottom", true))}>
						{findingCount() ? `${findingCount()} ${findingCount() === 1 ? "finding" : "findings"}` : "No findings"}
					</button>
					<button onClick={() => (fit(), refocus())}>Fit</button>
				</div>
				<div class="plan-main">
				<div
					class="plan-canvas"
					ref={canvas}
					tabIndex={0}
					role="application"
					aria-label="Plan chart. Enter adds a step, Tab adds a branch, F2 edits the words, arrow keys move between nodes."
					classList={{ linking: Boolean(linking()) }}
					onKeyDown={onKey}
					onWheel={(e) => {
						e.preventDefault();
						const v = view();
						setView({ ...v, scale: Math.min(2.5, Math.max(0.2, v.scale * (e.deltaY < 0 ? 1.1 : 0.9))) });
					}}
					onMouseDown={(e) => {
						if (e.target instanceof Element && e.target.closest(".plan-edit")) return;
						dragging = { x: e.clientX, y: e.clientY, moved: false };
					}}
					onMouseMove={(e) => {
						if (!dragging) return;
						const v = view();
						if (Math.abs(e.clientX - dragging.x) + Math.abs(e.clientY - dragging.y) > 2) dragging.moved = true;
						setView({ ...v, x: v.x + e.clientX - dragging.x, y: v.y + e.clientY - dragging.y });
						dragging = { ...dragging, x: e.clientX, y: e.clientY };
					}}
					onMouseUp={() => (dragging = null)}
					onMouseLeave={() => (dragging = null)}
					onDragOver={(e) => {
						if (e.dataTransfer?.types.includes(PROCEDURE_DRAG)) e.preventDefault();
					}}
					onDrop={(e) => {
						const name = e.dataTransfer?.getData(PROCEDURE_DRAG);
						const p = plan();
						if (!name || !p) return;
						e.preventDefault();
						applyEdit(addCall(p, name, selected() ?? undefined));
						refocus();
					}}
				>
					<svg class="graph-canvas" onClick={(e) => {
						if (e.target === e.currentTarget && !linking()) select(null);
						refocus();
					}}>
						<defs>
							<marker id="plan-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
								<path d="M0,0 L10,5 L0,10 z" class="arrow" />
							</marker>
						</defs>
						<Show when={layout()}>
							{(l) => (
								<g transform={`translate(${view().x},${view().y}) scale(${view().scale})`}>
									<For each={l().boxes.filter((b) => b.group)}>
										{(b) => (
											<g class="g-region plan-group">
												<rect x={b.x} y={b.y} width={b.width} height={b.height} rx="6" style={{ stroke: regionColor(b.group!), fill: `color-mix(in srgb, ${regionColor(b.group!)} 8%, transparent)` }} />
												<text x={b.x + 10} y={b.y + 19} style={{ fill: regionColor(b.group!) }}>
													{b.group}
												</text>
											</g>
										)}
									</For>
									<For each={l().lines}>
										{(line) => {
											const on = () => edge()?.from === line.from && edge()?.to === line.to;
											const choose = (e: MouseEvent) => (e.stopPropagation(), setEdge({ from: line.from, to: line.to }), refocus());
											return (
												<g class="plan-edge" classList={{ on: on(), pending: line.pending, removing: line.removing }}>
													<path d={pathOf(line.points)} class="plan-edge-hit" onClick={choose} />
													<path d={pathOf(line.points)} class="g-edge" marker-end="url(#plan-arrow)" />
													<Show when={line.label || line.missing}>
														<g class="plan-label" classList={{ missing: line.missing }} onClick={choose} onDblClick={(e) => (e.stopPropagation(), setEditing({ from: line.from, to: line.to }))}>
															<rect x={line.at.x - (line.label ?? "label?").length * 3.6 - 5} y={line.at.y - 10} width={(line.label ?? "label?").length * 7.2 + 10} height="20" rx="4" />
															<text x={line.at.x} y={line.at.y + 4} text-anchor="middle">
																{line.label ?? "label?"}
															</text>
														</g>
													</Show>
												</g>
											);
										}}
									</For>
									<For each={l().boxes.filter((b) => b.node)}>
										{(b) => {
											const n = b.node!;
											const cx = b.x + b.width / 2;
											const cy = b.y + b.height / 2;
											const trouble = () => issues().get(n.id);
											return (
												<g
													class={`plan-node ${n.kind} unit-${unitStatuses().get(n.id) ?? "none"}`}
													classList={{ selected: selected() === n.id, trouble: Boolean(trouble()), pending: Boolean(n.pending) }}
													onMouseDown={(e) => e.stopPropagation()}
													onClick={(e) => (e.stopPropagation(), !n.pending && clickNode(n.id))}
													onDblClick={(e) => (e.stopPropagation(), !n.pending && setEditing({ node: n.id }))}
												>
													<title>{[n.text, n.notes, ...(trouble() ?? [])].filter(Boolean).join("\n")}</title>
													<Show when={n.kind === "decision"} fallback={<rect x={b.x} y={b.y} width={b.width} height={b.height} rx={n.kind === "start" || n.kind === "end" ? b.height / 2 : 5} />}>
														<polygon points={`${cx},${b.y} ${b.x + b.width},${cy} ${cx},${b.y + b.height} ${b.x},${cy}`} />
													</Show>
													<Show when={n.kind === "call"}>
														<line x1={b.x + 10} y1={b.y} x2={b.x + 10} y2={b.y + b.height} />
														<line x1={b.x + b.width - 10} y1={b.y} x2={b.x + b.width - 10} y2={b.y + b.height} />
													</Show>
													<For each={b.lines}>
														{(text, i) => (
															<text x={cx} y={cy + (i() - (b.lines.length - 1) / 2) * LINE + 4} text-anchor="middle">
																{text}
															</text>
														)}
													</For>
													<Show when={trouble()}>
														<circle class="plan-dot" cx={b.x + b.width - (n.kind === "decision" ? b.width / 4 : 2)} cy={b.y + (n.kind === "decision" ? b.height / 4 : 2)} r="5" />
													</Show>
												</g>
											);
										}}
									</For>
								</g>
							)}
						</Show>
					</svg>
					<Show when={editBox()}>
						{(box) => (
							<input
								class="plan-edit"
								style={{ left: `${box().left}px`, top: `${box().top}px`, width: `${box().width}px` }}
								ref={(el) => {
									el.value = editValue();
									queueMicrotask(() => (el.focus(), el.select()));
								}}
								onMouseDown={(e) => e.stopPropagation()}
								onClick={(e) => e.stopPropagation()}
								onKeyDown={(e) => {
									e.stopPropagation();
									if (e.key === "Enter") commitEdit(e.currentTarget.value);
									if (e.key === "Escape") {
										setEditing(null);
										refocus();
									}
								}}
								onBlur={(e) => {
									if (editing()) commitEdit(e.currentTarget.value);
								}}
							/>
						)}
					</Show>
					<Show when={linking()}>
						<div class="plan-hint">Click the node this leads to. Esc cancels.</div>
					</Show>
				</div>
				<Show when={assistant()}>
					<PlanAssistant path={props.path} plan={plan()!} text={text()} onSelect={select} />
				</Show>
				</div>
				<div class="plan-details">
					<Show
						when={selectedNode()}
						keyed
						fallback={
							<>
								<label>
									Title <input value={plan()!.title} onChange={(e) => setPlanField("title", e.currentTarget.value)} />
								</label>
								<label class="grow">
									Goal <input value={typeof plan()!.goal === "string" ? (plan()!.goal as string) : ""} placeholder="What this should achieve" onChange={(e) => setPlanField("goal", e.currentTarget.value)} />
								</label>
								<label class="grow">
									Scripts <input value={Array.isArray(plan()!.targets) ? (plan()!.targets as string[]).join(", ") : ""} placeholder="Sample/Release.ssl" onChange={(e) => setTargets(e.currentTarget.value)} />
								</label>
							</>
						}
					>
						{(node) => (
							<>
								<span class="plan-kind">{node.kind}</span>
								<Show when={node.kind === "call"}>
									<label>
										Calls <input value={node.ref ?? ""} onChange={(e) => setNodeField("ref", e.currentTarget.value)} />
									</label>
								</Show>
								<label class="grow">
									Notes <input value={node.notes ?? ""} placeholder="Anything the agent should know" onChange={(e) => setNodeField("notes", e.currentTarget.value)} />
								</label>
								<label>
									Group{" "}
									<input
										value={groupName()}
										list="plan-groups"
										placeholder="None (becomes a region)"
										onChange={(e) => {
											const p = plan();
											if (p) apply(setGroup(p, node.id, e.currentTarget.value));
										}}
									/>
								</label>
								<datalist id="plan-groups">
									<For each={plan()!.groups}>{(g) => <option value={g.name} />}</For>
								</datalist>
							</>
						)}
					</Show>
				</div>
			</Show>
		</div>
	);
}
