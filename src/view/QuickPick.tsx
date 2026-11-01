// Ctrl+P files, Ctrl+Shift+P commands, Ctrl+T workspace symbols.
import { createEffect, createMemo, createResource, createSignal, For, Show } from "solid-js";
import { backend } from "./backend";
import { commands, keysFor } from "./commands";
import { monaco } from "./editor/monaco";
import { session } from "./lsp/session";
import { openFile, setState, state } from "./state";
import { baseName, relativeTo } from "../shared/paths";

type Item = { label: string; detail?: string; run: () => void };

/** Subsequence match, scored by how tight and how early the letters fall. */
export function score(query: string, text: string): number {
	if (!query) return 1;
	const q = query.toLowerCase();
	const t = text.toLowerCase();
	let at = -1;
	let total = 0;
	for (const ch of q) {
		const next = t.indexOf(ch, at + 1);
		if (next < 0) return 0;
		total += next === at + 1 ? 3 : 1;
		at = next;
	}
	return total + (t.includes(q) ? 10 : 0) - t.length / 100;
}

export function QuickPick() {
	const [query, setQuery] = createSignal("");
	const [selected, setSelected] = createSignal(0);
	const close = () => {
		setState("quickPick", null);
		setQuery("");
		setSelected(0);
	};
	const rel = (path: string) => relativeTo(state.workspace?.root, path);
	const [files] = createResource(
		() => state.quickPick === "files" && state.workspace?.root,
		() => backend.files(),
	);
	const [symbols] = createResource(
		() => (state.quickPick === "symbols" ? query() : false),
		(q) => session.workspaceSymbols(q as string).catch(() => []),
	);
	const items = createMemo<Item[]>(() => {
		const mode = state.quickPick;
		let list: Item[] = [];
		if (mode === "files")
			list = (files() ?? []).map((path) => ({ label: baseName(path), detail: rel(path), run: () => void openFile(path) }));
		if (mode === "commands") list = commands.map((c) => ({ label: c.label, detail: keysFor(c.id), run: c.run }));
		if (mode === "symbols")
			return (symbols() ?? []).slice(0, 200).map((s) => {
				const path = monaco.Uri.parse(s.location.uri).fsPath;
				const r = s.location.range;
				return { label: s.name, detail: `${s.containerName ? s.containerName + " · " : ""}${rel(path)}`, run: () => void openFile(path, { reveal: { line: r.start.line + 1, column: r.start.character + 1 } }) };
			});
		return list
			.map((item) => ({ item, s: score(query(), mode === "files" ? item.detail! : item.label) }))
			.filter((x) => x.s > 0)
			.sort((a, b) => b.s - a.s)
			.slice(0, 200)
			.map((x) => x.item);
	});
	const pick = (item?: Item) => {
		close();
		item?.run();
	};
	// Enter pressed before the list arrived picks once it does.
	const [pendingEnter, setPendingEnter] = createSignal(false);
	const loading = () => (state.quickPick === "files" && files.loading) || (state.quickPick === "symbols" && symbols.loading);
	createEffect(() => {
		if (pendingEnter() && !loading()) {
			setPendingEnter(false);
			pick(items()[selected()]);
		}
	});
	return (
		<Show when={state.quickPick}>
			<div class="overlay top" onMouseDown={(e) => e.target === e.currentTarget && close()}>
				<div class="quickpick" role="dialog">
					<input
						ref={(el) => queueMicrotask(() => el.focus())}
						placeholder={state.quickPick === "files" ? "Go to file" : state.quickPick === "commands" ? "Run a command" : "Go to symbol in workspace"}
						value={query()}
						onInput={(e) => (setQuery(e.currentTarget.value), setSelected(0))}
						onKeyDown={(e) => {
							if (e.key === "Escape") close();
							else if (e.key === "ArrowDown") (e.preventDefault(), setSelected((i) => Math.min(i + 1, items().length - 1)));
							else if (e.key === "ArrowUp") (e.preventDefault(), setSelected((i) => Math.max(i - 1, 0)));
							else if (e.key === "Enter") (e.preventDefault(), loading() ? setPendingEnter(true) : pick(items()[selected()]));
						}}
					/>
					<div class="items">
						<For each={items()}>
							{(item, i) => (
								<div class="item" classList={{ selected: i() === selected() }} onMouseEnter={() => setSelected(i())} onMouseDown={() => pick(item)}>
									<span class="label">{item.label}</span>
									<span class="detail">{item.detail}</span>
								</div>
							)}
						</For>
					</div>
				</div>
			</div>
		</Show>
	);
}
