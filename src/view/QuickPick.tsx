// Ctrl+P files, Ctrl+Shift+P commands, Ctrl+T workspace symbols.
import { FileMark } from "./FileMark";
import { createEffect, createMemo, createResource, createSignal, createUniqueId, For, Show } from "solid-js";
import { backend } from "./backend";
import { commands, keysFor, recentCommands, runCommand } from "./commands";
import { monaco } from "./editor/monaco";
import { session } from "./lsp/session";
import { Modal } from "./modal";
import { filterCommands, orderCommands, rankFiles } from "./quickRank";
import { openFile, setState, state } from "./state";
import { baseName, relativeTo } from "../shared/paths";

type Mode = "files" | "symbols" | "commands";
/** `detail` follows the label on its line (a path, a shortcut); `note` is the quieter line below. */
type Item = { label: string; detail?: string; note?: string; divide?: boolean; /** A file's name, for its mark beside the label. */ file?: string; run: () => void };

const TITLES: Record<Mode, string> = { files: "Go to file", commands: "Run a command", symbols: "Go to symbol in workspace" };
const PAGE = 10;

function Picker(props: { mode: Mode }) {
	const mode = props.mode;
	const listId = createUniqueId();
	const [query, setQuery] = createSignal("");
	const [selected, setSelected] = createSignal(0);
	const [failed, setFailed] = createSignal("");
	const close = () => setState("quickPick", null);
	const rel = (path: string) => relativeTo(state.workspace?.root, path);
	const [files] = createResource(
		() => mode === "files" && state.workspace?.root,
		() => backend.files().catch((e: any) => (setFailed(String(e?.message ?? e)), [] as string[])),
	);
	const [symbols] = createResource(
		() => (mode === "symbols" ? query() : false),
		(q) => session.workspaceSymbols(q as string).catch(() => []),
	);
	const items = createMemo<Item[]>(() => {
		if (mode === "files") {
			const found = (files() ?? []).map((path) => ({ path, rel: rel(path) }));
			return rankFiles(query(), found, (f) => f.rel).map((f) => ({ label: baseName(f.path), detail: f.rel, file: baseName(f.path), run: () => void openFile(f.path) }));
		}
		if (mode === "commands") {
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
		close();
		item.run();
	};
	// Enter pressed before the list arrived picks once it does.
	const [pendingEnter, setPendingEnter] = createSignal(false);
	const loading = () => (mode === "files" && files.loading) || (mode === "symbols" && symbols.loading);
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
		if (mode === "files") return !state.workspace ? "Open a folder to go to its files." : query().trim() ? "No files match." : "This folder has no files.";
		if (mode === "symbols") return state.lsp.state !== "running" ? "The language server is not running." : query().trim() ? "No symbols match." : "Type a name to find it in the workspace.";
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
		<Modal class="quickpick" top label={TITLES[mode]} onClose={close}>
			<input
				data-autofocus
				role="combobox"
				aria-label={TITLES[mode]}
				aria-expanded="true"
				aria-controls={listId}
				aria-autocomplete="list"
				aria-activedescendant={items().length ? `${listId}-${selected()}` : undefined}
				autocomplete="off"
				spellcheck={false}
				placeholder={TITLES[mode]}
				value={query()}
				onInput={(e) => (setQuery(e.currentTarget.value), setSelected(0))}
				onKeyDown={(e) => {
					if (e.key === "ArrowDown") (e.preventDefault(), move(1));
					else if (e.key === "ArrowUp") (e.preventDefault(), move(-1));
					else if (e.key === "PageDown") (e.preventDefault(), move(PAGE));
					else if (e.key === "PageUp") (e.preventDefault(), move(-PAGE));
					else if (e.key === "Enter") (e.preventDefault(), loading() ? setPendingEnter(true) : pick(items()[selected()]));
				}}
			/>
			<div class="items" role="listbox" id={listId} aria-label={TITLES[mode]} ref={list}>
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
							<span class="detail" classList={{ "quick-keys": mode === "commands" }}>
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
