// Blocks mode: the open file as region frames, procedure cards, control-flow
// blocks and code chips. A view of the text, never a copy: every action here
// is a text edit on the model the text editor shows, so one undo stack serves
// both modes (ADR 0002).
import { Icon } from "../Icon";
import { createEffect, createResource, createSignal, For, Match, on, onCleanup, Show, Switch } from "solid-js";
import { createStore, reconcile } from "solid-js/store";
import { monaco } from "../editor/monaco";
import { editors } from "../editor/EditorGroup";
import { regionColor } from "../editor/regions";
import { session } from "../lsp/session";
import { ask, choose } from "../dialogs";
import { documents, notify, setState, state } from "../state";
import { buildTree, neighbour, pathTo, procedureGroups, splitHeader, swapLines, treeFromSyntax, type Node, type SymbolIn } from "./model";

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
	// One string for the source: text that reads the same is not coloured again, however often it is asked for.
	const [html] = createResource(
		() => `${state.settings.theme}\u0000${state.settings.themeMaterial ?? ""}\u0000${props.text}`,
		(source) => monaco.editor.colorize(source.slice(source.indexOf("\u0000", source.indexOf("\u0000") + 1) + 1), "ssl", { tabSize: 4 }),
	);
	return <code class="block-code" innerHTML={html() ?? ""} />;
}

export function BlocksView(props: { path: string; group: number }) {
	const doc = () => documents.get(props.path);
	const [tree, setTree] = createStore<{ root: Node | null }>({ root: null });
	const [version, setVersion] = createSignal(0);
	/**
	 * Bumped each time the tree is read again. A block's text is cut from the
	 * document by the block's lines; when an edit changes the words and not the
	 * lines, the tree comes back the same, and without this the block would go
	 * on showing what it said before.
	 */
	const [read, setRead] = createSignal(0);
	const [editing, setEditing] = createSignal<string | null>(null);
	const [dropAt, setDropAt] = createSignal<number | null>(null);
	/** Why the structure could not be read, when it could not: said in the view, with a way to try again. */
	const [failed, setFailed] = createSignal<string | null>(null);
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
					const [result, symbols] = await Promise.all([
						session.request("ssl/syntaxTree", { textDocument: { uri: model.uri.toString() } }),
						session.documentSymbols(model).catch(() => []),
					]);
					// Parameter names come from the outline, which lists them per procedure.
					const params = new Map<string, string[]>();
					const walk = (list: monaco.languages.DocumentSymbol[]) =>
						list.forEach((s) => (s.kind === monaco.languages.SymbolKind.Function || s.kind === monaco.languages.SymbolKind.Method ? params.set(s.name, (s.children ?? []).map((c) => c.name)) : walk(s.children ?? [])));
					walk(symbols);
					root = treeFromSyntax(model.getLinesContent(), result?.nodes ?? [], (name) => params.get(name));
				} else {
					const [symbols, folds] = await Promise.all([
						session.documentSymbols(model),
						session.request("textDocument/foldingRange", { textDocument: { uri: model.uri.toString() } }).then((f) => f ?? []),
					]);
					root = buildTree(model.getLinesContent(), toSymbols(symbols), folds);
				}
				// The answer is for the text as it was when asked: a file closed or swapped since is not this one.
				if (model.isDisposed() || doc()?.model !== model) return;
				const first = tree.root === null;
				setFailed(null);
				setTree("root", reconcile(root, { key: "key", merge: false }));
				setRead((v) => v + 1);
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
			} catch (e: any) {
				setTree("root", null);
				setFailed(String(e?.message ?? e));
			}
		}),
	);

	// The tree is read a moment after the text changes, so a node can point past the
	// end of a file that just got shorter. Such a node shows nothing until the next read.
	const within = (n: Node) => {
		const model = doc()?.model;
		return Boolean(model && !model.isDisposed() && n.start >= 1 && n.end <= model.getLineCount());
	};
	const lines = (n: Node) => (read(), within(n) ? doc()!.model.getValueInRange(new monaco.Range(n.start, 1, n.end, doc()!.model.getLineMaxColumn(n.end))) : "");
	const firstLine = (n: Node) => (read(), within(n) ? doc()!.model.getLineContent(n.start) : "");
	const selectedKey = () => {
		// Follows the text cursor of whichever group shows this file: side by side, the blocks track the text.
		const active = state.groups[state.activeGroup]?.active;
		if (!tree.root || active !== props.path) return null;
		const path = pathTo(tree.root, state.cursor.line);
		// A comment is drawn as one block: a cursor on any of its lines selects the comment.
		const comment = path.findIndex((n) => n.kind === "comment");
		return (comment >= 0 ? path[comment] : path.at(-1))?.key ?? null;
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
		if ((await choose(`Delete ${n.name ?? `lines ${n.start}-${n.end}`}? Undo brings it back.`, ["Delete"], { danger: "Delete" })) !== "Delete") return;
		replaceLines(n.start, n.end, null);
	};
	/**
	 * An in-place editor's text, set once as it opens: bound reactively, a tree
	 * refresh while it is open would write the old text over what is typed.
	 */
	const opened = (el: HTMLInputElement | HTMLTextAreaElement, text: string, select = false) => {
		el.value = text;
		queueMicrotask(() => (el.focus(), select && el.select()));
	};
	/** A block header's condition (`:IF a > b;` → `a > b`), read fresh from the text. */
	const headerParts = (n: Node) => {
		read();
		const h = n.header;
		if (!h) return null;
		const model = doc()!.model;
		const split = splitHeader(model.getValueInRange(new monaco.Range(h.line, h.startColumn, h.line, h.endColumn)), h.keyword);
		return split && { ...split, rest: model.getLineContent(h.line).slice(h.endColumn - 1) };
	};
	const conditionKey = (n: Node) => `${n.key}:condition`;
	/** Replaces only the condition, as one undoable edit; keyword, spacing and `;` stay as written. */
	const commitCondition = (n: Node, value: string) => {
		if (editing() !== conditionKey(n)) return;
		setEditing(null);
		const parts = headerParts(n);
		const condition = value.trim();
		if (!parts || condition === parts.condition) return;
		if (!condition) return notify("A condition cannot be empty; edit the statement in text to remove it.");
		const h = n.header!;
		const from = h.startColumn + parts.before.length;
		const model = doc()!.model;
		model.pushStackElement();
		model.pushEditOperations([], [{ range: new monaco.Range(h.line, from, h.line, from + parts.condition.length), text: condition }], () => null);
		model.pushStackElement();
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

	// Out of the Tab order: the keys on the view do the same (see onKey), and the buttons show for the selected block.
	const Tools = (props: { node: Node }) => (
		<span class="block-tools" onClick={(e) => e.stopPropagation()}>
			<button tabindex={-1} title="Move up (Alt+Up)" aria-label="Move up" onClick={() => void move(props.node, -1)}>
				<Icon name="arrow-up" />
			</button>
			<button tabindex={-1} title="Move down (Alt+Down)" aria-label="Move down" onClick={() => void move(props.node, 1)}>
				<Icon name="arrow-down" />
			</button>
			<button tabindex={-1} title="Wrap in a region" aria-label="Wrap in a region" onClick={() => void wrap(props.node)}>
				<Icon name="symbol-namespace" />
			</button>
			<button tabindex={-1} title="Show in text" aria-label="Show in text" onClick={() => select(props.node, true)}>
				<Icon name="go-to-file" />
			</button>
			<button tabindex={-1} title="Delete (Delete)" aria-label="Delete this block" onClick={() => void remove(props.node)}>
				<Icon name="trash" />
			</button>
		</span>
	);

	// --- the keyboard: the selected block is the one the text cursor is in -------------

	/** Every block that is showing, top to bottom: a folded block hides what is in it. */
	const visible = () => {
		const out: Node[] = [];
		const walk = (n: Node) => {
			for (const child of n.children) {
				if (child.kind === "blank") continue;
				out.push(child);
				// A comment's lines are not blocks of their own: the keys step over them.
				if (!isCollapsed(child) && child.kind !== "comment") walk(child);
			}
		};
		if (tree.root) walk(tree.root);
		return out;
	};
	const selectedNode = () => {
		const key = selectedKey();
		return key ? visible().find((n) => n.key === key) ?? null : null;
	};
	const editable = (n: Node) => n.kind === "text" || n.kind === "raw";
	const onKey = (e: KeyboardEvent) => {
		// An open editor has its own keys, and its own undo.
		if (editing() || (e.target as HTMLElement).closest("input, textarea")) return;
		const mod = e.ctrlKey || e.metaKey;
		const key = e.key.length === 1 ? e.key.toLowerCase() : e.key;
		const editor = editors[props.group];
		const done = () => (e.preventDefault(), e.stopPropagation());
		// Undo and redo are the text's own: one history for both views.
		if (mod && key === "z") return done(), void editor?.trigger("blocks", e.shiftKey ? "redo" : "undo", null);
		if (mod && key === "y") return done(), void editor?.trigger("blocks", "redo", null);
		if (mod) return;
		const list = visible();
		const node = selectedNode();
		const at = node ? list.indexOf(node) : -1;
		if (e.altKey && node && (key === "ArrowUp" || key === "ArrowDown")) return done(), void move(node, key === "ArrowUp" ? -1 : 1);
		if (e.altKey) return;
		const go = (to: Node | undefined) => to && select(to);
		if (key === "ArrowDown") return done(), go(list[Math.min(at + 1, list.length - 1)]);
		if (key === "ArrowUp") return done(), go(list[Math.max(at - 1, 0)]);
		if (key === "Home") return done(), go(list[0]);
		if (key === "End") return done(), go(list.at(-1));
		if (!node) return;
		if (key === "ArrowLeft" && node.children.length && !isCollapsed(node)) return done(), toggle(node);
		if (key === "ArrowRight" && node.children.length && isCollapsed(node)) return done(), toggle(node);
		if (key === "Enter" || key === "F2") return done(), editable(node) ? setEditing(node.key) : headerParts(node) ? setEditing(conditionKey(node)) : toggle(node);
		if (key === " ") return done(), toggle(node);
		if (key === "Delete") return done(), void remove(node);
	};
	let scroller: HTMLDivElement | undefined;
	// The selected block is kept in view, whether the keys here moved it or the text cursor did.
	createEffect(() => {
		if (selectedKey()) queueMicrotask(() => scroller?.querySelector(".selected")?.scrollIntoView({ block: "nearest" }));
	});
	// Leaving an edit gives the keys back to the view.
	createEffect(on(editing, (now, before) => before && !now && scroller?.focus({ preventScroll: true }), { defer: true }));

	/** A block's first line: keyword, an editable condition field, and the rest as written. */
	const HeadLine = (props: { node: Node }) => {
		const n = props.node;
		return (
			<Show when={headerParts(n)} fallback={<Code text={firstLine(n).trim()} />}>
				{(parts) => (
					<span class="b-head-line">
						<Code text={parts().before.trim()} />
						<Show
							when={editing() === conditionKey(n)}
							fallback={
								<span class="b-cond" title="Double-click, or Enter, to edit the condition" onDblClick={(e) => (e.stopPropagation(), setEditing(conditionKey(n)))}>
									<Code text={parts().condition} />
								</span>
							}
						>
							<input
								class="b-cond-edit"
								ref={(el) => opened(el, parts().condition, true)}
								size={Math.max(8, parts().condition.length + 2)}
								onClick={(e) => e.stopPropagation()}
								onDblClick={(e) => e.stopPropagation()}
								onKeyDown={(e) => {
									if (e.key === "Escape") setEditing(null);
									if (e.key === "Enter") commitCondition(n, e.currentTarget.value);
								}}
								onBlur={(e) => commitCondition(n, e.currentTarget.value)}
							/>
						</Show>
						{/* What closes the line stands against the condition, as it does in the text: "DueRule;", not "DueRule ;". */}
						<span classList={{ "b-tight": /^[;),]/.test((parts().after + parts().rest).trim()) }}>
							<Code text={(parts().after + parts().rest).trim()} />
						</span>
					</span>
				)}
			</Show>
		);
	};

	// A procedure is drawn with its doc block, and the annotation between them, as one card.
	const Children = (props: { node: Node }) => (
		<For each={procedureGroups(props.node.children)}>
			{(group) => (
				<Show when={group.length > 1} fallback={<Block node={group[0]!} />}>
					<div class="b-proc-group">
						<For each={group}>{(child) => <Block node={child} />}</For>
					</div>
				</Show>
			)}
		</For>
	);

	function Block(p: { node: Node }) {
		const n = p.node;
		const header = (label: any, meta?: string) => (
			<div class="block-head" {...dropZone(n.start)} classList={{ drop: dropAt() === n.start }} onClick={() => select(n)} onDblClick={() => toggle(n)}>
				<button class="twisty" tabindex={-1} aria-label={isCollapsed(n) ? "Unfold" : "Fold"} aria-expanded={!isCollapsed(n)} onClick={(e) => (e.stopPropagation(), toggle(n))}>
					<Icon name={isCollapsed(n) ? "chevron-right" : "chevron-down"} />
				</button>
				<span class="block-label">{label}</span>
				<Show when={meta}>
					<span class="meta">{meta}</span>
				</Show>
				<Tools node={n} />
			</div>
		);
		const size = `${n.end - n.start + 1} lines`;
		// Where it starts in the text, so that a block here and a line number in Problems or a diff are the same place.
		const from = `line ${n.start}`;
		return (
			<Switch>
				<Match when={n.kind === "region"}>
					<section class="b-region" classList={{ selected: selectedKey() === n.key }} style={{ "--region": regionColor(n.name!) }}>
						{header(<strong>{n.name}</strong>, `${from} · ${size} · ${n.children.filter((c) => c.kind === "procedure").length} procedures`)}
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
							`${from} · ${size}`,
						)}
						<Show when={!isCollapsed(n)}>
							<div class="block-body">
								<Children node={n} />
							</div>
						</Show>
					</section>
				</Match>
				<Match when={n.kind === "block"}>
					<section class="b-block" classList={{ selected: selectedKey() === n.key, "b-class": Boolean(n.classHead) }}>
						{header(
							<>
								<Show when={n.classHead}>
									<span class="class-mark" title="A class: its name, what it inherits and its fields">
										class
									</span>{" "}
								</Show>
								<HeadLine node={n} />
							</>,
							n.end - n.start > 1 ? size : undefined,
						)}
						<Show when={!isCollapsed(n)}>
							<div class="block-body">
								<Children node={n} />
							</div>
						</Show>
					</section>
				</Match>
				<Match when={n.kind === "comment"}>
					<section class="b-comment" classList={{ selected: selectedKey() === n.key, banner: n.start === 1, "b-doc": Boolean(n.doc) }}>
						{header(n.start === 1 ? <strong>File banner</strong> : n.doc ? <span class="doc-mark">Doc block</span> : <span class="comment-first">{firstLine(n).trim()}</span>, size)}
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
							<div class="b-text" {...dropZone(n.start)} classList={{ selected: selectedKey() === n.key, drop: dropAt() === n.start }} title="Double-click, or Enter, to edit" onClick={() => select(n)} onDblClick={() => setEditing(n.key)}>
								<Code text={lines(n)} />
							</div>
						}
					>
						<textarea
							class="b-edit"
							ref={(el) => opened(el, lines(n))}
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
					<div class="b-text b-raw" classList={{ selected: selectedKey() === n.key }} title="The language server could not read this; it is kept as written. Double-click, or Enter, to edit." onClick={() => select(n)} onDblClick={() => setEditing(n.key)}>
						<Show when={editing() === n.key} fallback={<Code text={lines(n)} />}>
							<textarea
								class="b-edit"
								ref={(el) => opened(el, lines(n))}
								rows={n.end - n.start + 1}
								onKeyDown={(e) => {
									if (e.key === "Escape") setEditing(null);
									if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) commitEdit(n, e.currentTarget.value);
								}}
								onBlur={(e) => commitEdit(n, e.currentTarget.value)}
							/>
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
				<span class="hint" title="Up and Down move between blocks. Left and Right fold and unfold. Enter edits. Alt+Up and Alt+Down move a block. Delete removes it. Ctrl+Z undoes.">
					Blocks: a view of the text. Arrows move, Enter edits, Ctrl+Z undoes here and in Text.
				</span>
				<button onClick={() => collapseAll(true)}>Collapse to signatures</button>
				<button onClick={() => collapseAll(false)}>Expand all</button>
			</div>
			<Show
				when={tree.root}
				fallback={
					<Show when={failed()} fallback={<p class="hint">{state.lsp.state === "running" ? "Reading the structure…" : "Blocks need the language server, which is not running. Restart it from the status bar, or switch to Text."}</p>}>
						<div class="hint" role="alert">
							<p>The language server could not give this file's structure: {failed()}</p>
							<button class="link" onClick={() => (setFailed(null), setVersion((v) => v + 1))}>
								Try again
							</button>
						</div>
					</Show>
				}
			>
				<div class="blocks-scroll" ref={scroller} tabindex={0} role="group" aria-label="Blocks of this script. Arrow keys move between blocks." onKeyDown={onKey}>
					<Children node={tree.root!} />
				</div>
			</Show>
		</div>
	);
}
