// Blocks mode: the open file as region frames, procedure cards, control-flow
// blocks and code chips. A view of the text, never a copy: every action here
// is a text edit on the model the text editor shows, so one undo stack serves
// both modes (ADR 0002).
import { createEffect, createResource, createSignal, For, Match, on, onCleanup, Show, Switch } from "solid-js";
import { createStore, reconcile } from "solid-js/store";
import { monaco } from "../editor/monaco";
import { editors } from "../editor/EditorGroup";
import { regionColor } from "../editor/regions";
import { session } from "../lsp/session";
import { ask, choose } from "../dialogs";
import { documents, notify, setState, state } from "../state";
import { buildTree, neighbour, pathTo, swapLines, treeFromSyntax, type Node, type SymbolIn } from "./model";

const collapsedByPath = new Map<string, Set<string>>();

function toSymbols(list: monaco.languages.DocumentSymbol[]): SymbolIn[] {
	return list.map((s) => ({
		name: s.name,
		kind: s.kind + 1,
		startLine: s.range.startLineNumber - 1,
		endLine: s.range.endLineNumber - 1,
		children: toSymbols(s.children ?? []),
	}));
}

/** Theme-coloured HTML for a few lines of SSL, through the same tokenizer as the editor. */
function Code(props: { text: string }) {
	const [html] = createResource(
		() => [props.text, state.settings.theme] as const,
		([text]) => monaco.editor.colorize(text, "ssl", { tabSize: 4 }),
	);
	return <code class="block-code" innerHTML={html() ?? ""} />;
}

export function BlocksView(props: { path: string; group: number }) {
	const doc = () => documents.get(props.path);
	const [tree, setTree] = createStore<{ root: Node | null }>({ root: null });
	const [version, setVersion] = createSignal(0);
	const [editing, setEditing] = createSignal<string | null>(null);
	const [dropAt, setDropAt] = createSignal<number | null>(null);
	const collapsed = () => {
		if (!collapsedByPath.has(props.path)) collapsedByPath.set(props.path, new Set());
		return collapsedByPath.get(props.path)!;
	};
	const [collapseVersion, setCollapseVersion] = createSignal(0);
	const isCollapsed = (n: Node) => (collapseVersion(), collapsed().has(n.key));
	const toggle = (n: Node) => {
		collapsed().has(n.key) ? collapsed().delete(n.key) : collapsed().add(n.key);
		setCollapseVersion((v) => v + 1);
	};

	let timer: ReturnType<typeof setTimeout> | undefined;
	createEffect(
		on(
			() => [props.path, state.lsp.state] as const,
			() => {
				const model = doc()?.model;
				if (!model) return;
				const sub = model.onDidChangeContent(() => {
					clearTimeout(timer);
					timer = setTimeout(() => setVersion((v) => v + 1), 300);
				});
				setVersion((v) => v + 1);
				onCleanup(() => sub.dispose());
			},
		),
	);
	createEffect(
		on(version, async () => {
			const model = doc()?.model;
			if (!model) return;
			try {
				let root: Node;
				if (session.supports("ssl/syntaxTree")) {
					// The server's own parse (L1): statement-level chips, arms, unreadable spans.
					const result = await session.request("ssl/syntaxTree", { textDocument: { uri: model.uri.toString() } });
					const nodes = result?.nodes ?? result?.children ?? result?.root?.children ?? (Array.isArray(result) ? result : []);
					root = treeFromSyntax(model.getLinesContent(), nodes);
				} else {
					const [symbols, folds] = await Promise.all([
						session.documentSymbols(model),
						session.request("textDocument/foldingRange", { textDocument: { uri: model.uri.toString() } }).then((f) => f ?? []),
					]);
					root = buildTree(model.getLinesContent(), toSymbols(symbols), folds);
				}
				const first = tree.root === null;
				setTree("root", reconcile(root, { key: "key", merge: false }));
				// The banner opens folded; long files open as a region outline.
				if (first) {
					const banner = root.children.find((c) => c.kind === "comment" && c.start === 1);
					if (banner) collapsed().add(banner.key);
					if (model.getLineCount() > 300) {
						const walk = (n: Node) => n.children.forEach((c) => (c.kind === "procedure" || c.kind === "comment" ? collapsed().add(c.key) : walk(c)));
						walk(root);
					}
					setCollapseVersion((v) => v + 1);
				}
			} catch {
				setTree("root", null);
			}
		}),
	);

	const lines = (n: Node) => doc()!.model.getValueInRange(new monaco.Range(n.start, 1, n.end, doc()!.model.getLineMaxColumn(n.end)));
	const firstLine = (n: Node) => doc()!.model.getLineContent(n.start);
	const selectedKey = () => {
		// Follows the text cursor of whichever group shows this file: side by side, the blocks track the text.
		const active = state.groups[state.activeGroup]?.active;
		if (!tree.root || active !== props.path) return null;
		const path = pathTo(tree.root, state.cursor.line);
		return path.at(-1)?.key ?? null;
	};
	const select = (n: Node, focusText = false) => {
		const editor = editors[props.group];
		setState("activeGroup", props.group);
		editor?.setSelection(new monaco.Range(n.start, 1, n.start, 1));
		setState("cursor", { line: n.start, column: 1 });
		if (focusText) {
			setState("groups", props.group, "mode", "text");
			queueMicrotask(() => {
				editor?.revealLineInCenter(n.start);
				editor?.focus();
			});
		}
	};

	/** Replaces lines start..end (1-based) with `text`, as one undoable edit. */
	const replaceLines = (start: number, end: number, text: string | null) => {
		const model = doc()!.model;
		const eol = model.getEOL();
		let range: monaco.Range;
		let replacement = text ?? "";
		if (text === null) {
			// Delete whole lines, with their line break.
			range = end < model.getLineCount() ? new monaco.Range(start, 1, end + 1, 1) : new monaco.Range(Math.max(1, start - 1), model.getLineMaxColumn(Math.max(1, start - 1)), end, model.getLineMaxColumn(end));
			replacement = "";
		} else range = new monaco.Range(start, 1, end, model.getLineMaxColumn(end));
		model.pushStackElement();
		model.pushEditOperations([], [{ range, text: replacement.replace(/\r?\n/g, eol) }], () => null);
		model.pushStackElement();
	};
	const formatLines = async (start: number, end: number) => {
		const model = doc()!.model;
		try {
			const edits = await session.formatRanges(model, [[start - 1, Math.min(end, model.getLineCount()) - 1]], model.getOptions());
			if (edits.length) model.pushEditOperations([], edits, () => null);
		} catch {
			// The move stands unformatted; format on save will tidy it.
		}
	};
	const parentOf = (target: Node, from: Node | null = tree.root): Node | null => {
		if (!from) return null;
		for (const c of from.children) {
			if (c === target) return from;
			const found = parentOf(target, c);
			if (found) return found;
		}
		return null;
	};
	const move = async (n: Node, direction: -1 | 1) => {
		const parent = parentOf(n);
		const other = parent && neighbour(parent, n, direction);
		if (!other) return;
		const [a, b] = direction < 0 ? [other, n] : [n, other];
		const swapped = swapLines(doc()!.model.getLinesContent(), a, b);
		replaceLines(swapped.start, swapped.end, swapped.lines.join("\n"));
		await formatLines(swapped.start, swapped.end);
	};
	const wrap = async (n: Node) => {
		const name = await ask("Name of the new region");
		if (!name) return;
		const body = lines(n);
		replaceLines(n.start, n.end, `/* region ${name};\n${body}\n/* endregion;`);
		await formatLines(n.start, n.end + 2);
	};
	const remove = async (n: Node) => {
		if ((await choose(`Delete ${n.name ?? `lines ${n.start}-${n.end}`}? Undo brings it back.`, ["Delete"])) !== "Delete") return;
		replaceLines(n.start, n.end, null);
	};
	const commitEdit = (n: Node, text: string) => {
		setEditing(null);
		if (text !== lines(n)) replaceLines(n.start, n.end, text);
	};
	const drop = (e: DragEvent, line: number) => {
		e.preventDefault();
		setDropAt(null);
		const text = e.dataTransfer?.getData("text/plain");
		if (!text) return;
		const model = doc()!.model;
		model.pushStackElement();
		model.pushEditOperations([], [{ range: new monaco.Range(line, 1, line, 1), text: text.replace(/\n?$/, "\n") }], () => null);
		model.pushStackElement();
		notify("Inserted. Format or save to settle its layout.");
	};
	const dropZone = (line: number) => ({
		onDragOver: (e: DragEvent) => (e.preventDefault(), setDropAt(line)),
		onDragLeave: () => setDropAt(null),
		onDrop: (e: DragEvent) => drop(e, line),
	});

	const Tools = (props: { node: Node }) => (
		<span class="block-tools" onClick={(e) => e.stopPropagation()}>
			<button title="Move up" onClick={() => void move(props.node, -1)}>
				↑
			</button>
			<button title="Move down" onClick={() => void move(props.node, 1)}>
				↓
			</button>
			<button title="Wrap in a region" onClick={() => void wrap(props.node)}>
				▣
			</button>
			<button title="Show in text" onClick={() => select(props.node, true)}>
				⇥
			</button>
			<button title="Delete" onClick={() => void remove(props.node)}>
				×
			</button>
		</span>
	);

	const Children = (props: { node: Node }) => <For each={props.node.children}>{(child) => <Block node={child} />}</For>;

	function Block(p: { node: Node }) {
		const n = p.node;
		const header = (label: any, meta?: string) => (
			<div class="block-head" {...dropZone(n.start)} classList={{ drop: dropAt() === n.start }} onClick={() => select(n)} onDblClick={() => toggle(n)}>
				<button class="twisty" onClick={(e) => (e.stopPropagation(), toggle(n))}>
					{isCollapsed(n) ? "▸" : "▾"}
				</button>
				<span class="block-label">{label}</span>
				<Show when={meta}>
					<span class="meta">{meta}</span>
				</Show>
				<Tools node={n} />
			</div>
		);
		const size = `${n.end - n.start + 1} lines`;
		return (
			<Switch>
				<Match when={n.kind === "region"}>
					<section class="b-region" classList={{ selected: selectedKey() === n.key }} style={{ "--region": regionColor(n.name!) }}>
						{header(<strong>{n.name}</strong>, `${size} · ${n.children.filter((c) => c.kind === "procedure").length} procedures`)}
						<Show when={!isCollapsed(n)}>
							<div class="block-body">
								<Children node={n} />
							</div>
						</Show>
					</section>
				</Match>
				<Match when={n.kind === "procedure"}>
					<section class="b-procedure" classList={{ selected: selectedKey() === n.key }}>
						{header(
							<>
								<span class="proc-icon">ƒ</span> <strong>{n.name}</strong>
								<span class="params">({n.params?.join(", ")})</span>
							</>,
							size,
						)}
						<Show when={!isCollapsed(n)}>
							<div class="block-body">
								<Children node={n} />
							</div>
						</Show>
					</section>
				</Match>
				<Match when={n.kind === "block"}>
					<section class="b-block" classList={{ selected: selectedKey() === n.key }}>
						{header(<Code text={firstLine(n).trim()} />, n.end - n.start > 1 ? size : undefined)}
						<Show when={!isCollapsed(n)}>
							<div class="block-body">
								<Children node={n} />
							</div>
						</Show>
					</section>
				</Match>
				<Match when={n.kind === "comment"}>
					<section class="b-comment" classList={{ selected: selectedKey() === n.key, banner: n.start === 1 }}>
						{header(n.start === 1 ? <strong>File banner</strong> : <span class="comment-first">{firstLine(n).trim()}</span>, size)}
						<Show when={!isCollapsed(n)}>
							<div class="block-body">
								<pre class="comment-text">{lines(n).split(/\r?\n/).slice(1).join("\n")}</pre>
							</div>
						</Show>
					</section>
				</Match>
				<Match when={n.kind === "text"}>
					<Show
						when={editing() === n.key}
						fallback={
							<div class="b-text" {...dropZone(n.start)} classList={{ selected: selectedKey() === n.key, drop: dropAt() === n.start }} title="Double-click to edit" onClick={() => select(n)} onDblClick={() => setEditing(n.key)}>
								<Code text={lines(n)} />
							</div>
						}
					>
						<textarea
							class="b-edit"
							ref={(el) => queueMicrotask(() => el.focus())}
							value={lines(n)}
							rows={n.end - n.start + 1}
							onKeyDown={(e) => {
								if (e.key === "Escape") setEditing(null);
								if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) commitEdit(n, e.currentTarget.value);
							}}
							onBlur={(e) => commitEdit(n, e.currentTarget.value)}
						/>
					</Show>
				</Match>
				<Match when={n.kind === "raw"}>
					<div class="b-text b-raw" classList={{ selected: selectedKey() === n.key }} title="The language server could not read this; it is kept as written. Double-click to edit." onClick={() => select(n)} onDblClick={() => setEditing(n.key)}>
						<Show when={editing() === n.key} fallback={<Code text={lines(n)} />}>
							<textarea class="b-edit" ref={(el) => queueMicrotask(() => el.focus())} value={lines(n)} rows={n.end - n.start + 1} onKeyDown={(e) => e.key === "Escape" && setEditing(null)} onBlur={(e) => commitEdit(n, e.currentTarget.value)} />
						</Show>
					</div>
				</Match>
				<Match when={n.kind === "blank"}>
					<div class="b-blank" {...dropZone(n.start)} classList={{ drop: dropAt() === n.start }} />
				</Match>
			</Switch>
		);
	}

	const collapseAll = (all: boolean) => {
		const walk = (n: Node) =>
			n.children.forEach((c) => {
				if (c.kind === "procedure" || c.kind === "block" || c.kind === "comment") all ? collapsed().add(c.key) : collapsed().delete(c.key);
				if (c.kind === "region" && !all) collapsed().delete(c.key);
				walk(c);
			});
		if (tree.root) walk(tree.root);
		setCollapseVersion((v) => v + 1);
	};

	return (
		<div class="blocks">
			<div class="blocks-bar">
				<span class="hint">Blocks: a view of the text. Edits here are text edits; undo works in both modes.</span>
				<span class="spacer" />
				<button onClick={() => collapseAll(true)}>Collapse to signatures</button>
				<button onClick={() => collapseAll(false)}>Expand all</button>
			</div>
			<Show when={tree.root} fallback={<p class="hint">{state.lsp.state === "running" ? "Reading the structure…" : "Blocks mode needs the language server."}</p>}>
				<div class="blocks-scroll">
					<Children node={tree.root!} />
				</div>
			</Show>
		</div>
	);
}
