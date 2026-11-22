// One box for going somewhere: Ctrl+P files, Ctrl+Shift+P commands, Ctrl+T
// workspace symbols. What it lists is said by the first character in it
// (src/shared/quickPrefix.ts): the box opens with that character, and typing
// another, or taking it out, lists something else without closing the box.
import { FileMark } from "./FileMark";
import { createEffect, createMemo, createResource, createSignal, createUniqueId, For, Show } from "solid-js";
import { backend } from "./backend";
import { commands, keysFor, recentCommands, runCommand } from "./commands";
import { monaco } from "./editor/monaco";
import { session } from "./lsp/session";
import { Modal } from "./modal";
import { filterCommands, matchWords, orderCommands, rankFiles } from "./quickRank";
import { symbols as fileSymbols } from "./panels/Objects";
import { activeDoc, activePath, openFile, setState, state } from "./state";
import { baseName, relativeTo } from "../shared/paths";
import { fileAndLine, lineAsked, prefixFor, QUICK_PREFIXES, readQuick, type QuickMode } from "../shared/quickPrefix";

/**
 * `detail` follows the label on its line (a path, a shortcut); `note` is the quieter line below. `stay` keeps the
 * box open after the row is picked: the row changed what the box lists.
 */
type Item = { label: string; detail?: string; note?: string; divide?: boolean; /** A file's name, for its mark beside the label. */ file?: string; stay?: boolean; run: () => void };

const TITLES: Record<QuickMode, string> = {
	files: "Go to file",
	commands: "Run a command",
	outline: "Go to symbol in the open file",
	symbols: "Go to symbol in workspace",
	line: "Go to line",
	help: "What can be typed here",
};
const PAGE = 10;

type Sym = monaco.languages.DocumentSymbol;
/** A file's symbols in the order they are written, each with the one it is inside. */
const flat = (list: readonly Sym[], inside = ""): { symbol: Sym; inside: string }[] => list.flatMap((symbol) => [{ symbol, inside }, ...flat(symbol.children ?? [], symbol.name)]);

function Picker(props: { mode: QuickMode }) {
	const listId = createUniqueId();
	/** What is in the box, the first character included. */
	const [text, setText] = createSignal(prefixFor(props.mode));
	const read = createMemo(() => readQuick(text()));
	const mode = () => read().mode;
	const query = () => read().query;
	const [selected, setSelected] = createSignal(0);
	const [failed, setFailed] = createSignal("");
	const close = () => setState("quickPick", null);
	const rel = (path: string) => relativeTo(state.workspace?.root, path);
	const [files] = createResource(
		() => mode() === "files" && state.workspace?.root,
		() => backend.files().catch((e: any) => (setFailed(String(e?.message ?? e)), [] as string[])),
	);
	const [symbols] = createResource(
		() => (mode() === "symbols" ? query() : false),
		(q) => session.workspaceSymbols(q as string).catch(() => []),
	);
	const items = createMemo<Item[]>(() => {
		if (mode() === "files") {
			// "DueRules:20" is the file and the line to open it at.
			const asked = fileAndLine(query());
			const found = (files() ?? []).map((path) => ({ path, rel: rel(path) }));
			return rankFiles(asked.query, found, (f) => f.rel).map((f) => ({ label: baseName(f.path), detail: f.rel, file: baseName(f.path), run: () => void openFile(f.path, asked.at ? { reveal: asked.at, keep: true } : { keep: true }) }));
		}
		if (mode() === "help") {
			return [{ label: "A file's name", detail: "Go to a file; with :12 after the name, to that line of it", stay: true, run: () => setText("") }, ...QUICK_PREFIXES.filter((each) => each.mode !== "help").map((each) => ({ label: each.prefix, detail: each.says, stay: true, run: () => setText(each.prefix) }))];
		}
		if (mode() === "line") {
			const path = activeDoc()?.binary ? null : activePath();
			const at = path ? lineAsked(query(), activeDoc()?.model.getLineCount() ?? 1) : null;
			return path && at ? [{ label: `Go to line ${at.line}${at.column > 1 ? `, column ${at.column}` : ""}`, detail: rel(path), run: () => void openFile(path, { reveal: at }) }] : [];
		}
		if (mode() === "outline") {
			const path = activePath();
			if (!path) return [];
			return flat(fileSymbols())
				.filter((each) => !query().trim() || matchWords(query(), each.symbol.name, each.inside) > 0)
				.map(({ symbol, inside }) => ({
					label: symbol.name,
					detail: `${inside ? `${inside} · ` : ""}line ${symbol.range.startLineNumber}`,
					run: () => void openFile(path, { reveal: { line: symbol.selectionRange.startLineNumber, column: symbol.selectionRange.startColumn } }),
				}));
		}
		if (mode() === "commands") {
			// Recently used first, then the alphabet; a query matches words in any order.
			const { list, recent } = orderCommands(commands, recentCommands());
			const searching = Boolean(query().trim());
			return filterCommands(query(), list).map((c, i) => ({
				label: c.label,
				detail: keysFor(c.id),
				note: c.detail,
				divide: !searching && recent > 0 && i === recent,
				run: () => runCommand(c.id, { remember: true }),
			}));
		}
		return (symbols() ?? []).slice(0, 200).map((s) => {
			const path = monaco.Uri.parse(s.location.uri).fsPath;
			const r = s.location.range;
			return { label: s.name, detail: `${s.containerName ? s.containerName + " · " : ""}${rel(path)}`, run: () => void openFile(path, { reveal: { line: r.start.line + 1, column: r.start.character + 1 } }) };
		});
	});
	const pick = (item?: Item) => {
		if (!item) return;
		if (!item.stay) {
			close();
			// Defer running after the current Enter keydown/keypress cycle settles so focus-shifting commands never leak a stray newline into CM6.
			setTimeout(() => item.run(), 0);
		} else {
			item.run();
			setSelected(0);
		}
	};
	// Enter pressed before the list arrived picks once it does.
	const [pendingEnter, setPendingEnter] = createSignal(false);
	const loading = () => (mode() === "files" && files.loading) || (mode() === "symbols" && symbols.loading);
	createEffect(() => {
		if (pendingEnter() && !loading()) {
			setPendingEnter(false);
			pick(items()[selected()]);
		}
	});
	/** What the list says when it has no rows: why, and what to do. */
	const status = () => {
		if (items().length) return "";
		if (loading()) return "Loading…";
		if (failed()) return failed();
		if (mode() === "files") return !state.workspace ? "Open a folder to go to its files." : query().trim() ? "No files match." : "This folder has no files.";
		if (mode() === "symbols") return state.lsp.state !== "running" ? "The language server is not running." : query().trim() ? "No symbols match." : "Type a name to find it in the workspace.";
		if (mode() === "outline") return !activePath() ? "Open a file to go to its symbols." : query().trim() ? "No symbols match." : state.lsp.state !== "running" ? "The language server is not running." : "This file has no symbols.";
		if (mode() === "line") return !activePath() ? "Open a file to go to a line of it." : activeDoc()?.binary ? "The open file is not text: it has no lines to go to." : `Type a line number, 1 to ${activeDoc()?.model.getLineCount() ?? 1}; 12:5 is line 12, column 5.`;
		return "No commands match.";
	};
	const move = (by: number) => setSelected((i) => Math.max(0, Math.min(i + by, items().length - 1)));
	// The selected row stays in view when the arrows take it past the edge.
	let list: HTMLDivElement | undefined;
	createEffect(() => {
		const index = selected();
		items();
		list?.children[index]?.scrollIntoView({ block: "nearest" });
	});
	// The pointer selects a row only when it moves: a list scrolling under a
	// still pointer must not take the selection from the arrow keys.
	let pointer = "";
	const pointed = (e: MouseEvent, index: number) => {
		const at = `${e.clientX},${e.clientY}`;
		if (at === pointer) return;
		pointer = at;
		setSelected(index);
	};
	return (
		<Modal class="quickpick" top label={TITLES[mode()]} onClose={close}>
			<input
				data-autofocus
				role="combobox"
				aria-label={TITLES[mode()]}
				aria-expanded="true"
				aria-controls={listId}
				aria-autocomplete="list"
				aria-activedescendant={items().length ? `${listId}-${selected()}` : undefined}
				autocomplete="off"
				spellcheck={false}
				placeholder="A file's name, or ? for what else can be typed"
				value={text()}
				// What is typed after Enter was pressed is a new question: the Enter that was waiting for the list is let go.
				onInput={(e) => (setText(e.currentTarget.value), setSelected(0), setPendingEnter(false))}
				onKeyDown={(e) => {
					if (e.key === "ArrowDown") (e.preventDefault(), move(1));
					else if (e.key === "ArrowUp") (e.preventDefault(), move(-1));
					else if (e.key === "PageDown") (e.preventDefault(), move(PAGE));
					else if (e.key === "PageUp") (e.preventDefault(), move(-PAGE));
					else if (e.key === "Enter") (e.preventDefault(), e.stopPropagation(), loading() ? setPendingEnter(true) : pick(items()[selected()]));
				}}
			/>
			<div class="items" role="listbox" id={listId} aria-label={TITLES[mode()]} ref={list}>
				<For each={items()}>
					{(item, i) => (
						<div
							class="item"
							classList={{ selected: i() === selected(), "quick-noted": Boolean(item.note), "quick-divide": item.divide }}
							role="option"
							id={`${listId}-${i()}`}
							aria-selected={i() === selected()}
							onMouseMove={(e) => pointed(e, i())}
							onMouseDown={(e) => e.button === 0 && (e.preventDefault(), pick(item))}
						>
							<Show when={item.file}>{(name) => <FileMark name={name()} />}</Show>
							<span class="label">{item.label}</span>
							<span class="detail" classList={{ "quick-keys": mode() === "commands" }}>
								{item.detail}
							</span>
							<Show when={item.note}>
								<span class="quick-note">{item.note}</span>
							</Show>
						</div>
					)}
				</For>
			</div>
			<div class="quick-status" role="status">
				{status()}
			</div>
		</Modal>
	);
}

export function QuickPick() {
	return (
		<Show when={state.quickPick} keyed>
			{(mode) => <Picker mode={mode} />}
		</Show>
	);
}
