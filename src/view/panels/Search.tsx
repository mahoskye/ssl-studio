// Workspace search, results grouped by file.
import { createSignal, For } from "solid-js";
import type { SearchHit } from "../../shared/protocol";
import { backend } from "../backend";
import { notify, openFile, state } from "../state";

export function Search() {
	let input!: HTMLInputElement;
	const [hits, setHits] = createSignal<SearchHit[]>([]);
	const [regex, setRegex] = createSignal(false);
	const [caseSensitive, setCaseSensitive] = createSignal(false);
	const [busy, setBusy] = createSignal(false);
	const run = async () => {
		setBusy(true);
		try {
			setHits(await backend.search(input.value, { regex: regex(), caseSensitive: caseSensitive() }));
		} catch (e: any) {
			notify(String(e?.message ?? e), "error");
		}
		setBusy(false);
	};
	const groups = () => {
		const map = new Map<string, SearchHit[]>();
		for (const hit of hits()) map.set(hit.path, [...(map.get(hit.path) ?? []), hit]);
		return [...map];
	};
	const rel = (path: string) => (state.workspace ? path.slice(state.workspace.root.length + 1) : path);
	return (
		<div class="panel-body">
			<div class="panel-title">
				<span>Search</span>
			</div>
			<form class="search-form" onSubmit={(e) => (e.preventDefault(), void run())}>
				<input ref={(el) => ((input = el), queueMicrotask(() => el.focus()))} id="search-input" placeholder="Search the workspace" />
				<button type="button" classList={{ on: caseSensitive() }} title="Match case" onClick={() => setCaseSensitive(!caseSensitive())}>
					Aa
				</button>
				<button type="button" classList={{ on: regex() }} title="Regular expression" onClick={() => setRegex(!regex())}>
					.*
				</button>
			</form>
			<p class="hint">{busy() ? "Searching…" : hits().length ? `${hits().length} results in ${groups().length} files` : ""}</p>
			<div class="tree">
				<For each={groups()}>
					{([path, list]) => (
						<>
							<div class="tree-row file-head" title={path}>
								<span class="label">{rel(path)}</span>
								<span class="meta">{list.length}</span>
							</div>
							<For each={list}>
								{(hit) => (
									<div class="tree-row hit" style={{ "padding-left": "22px" }} onClick={() => void openFile(hit.path, { reveal: { line: hit.line, column: hit.column, endLine: hit.line, endColumn: hit.column + hit.length } })}>
										<span class="meta">{hit.line}</span>
										<span class="label">
											{hit.text.slice(Math.max(0, hit.column - 30), hit.column - 1).trimStart()}
											<mark>{hit.text.slice(hit.column - 1, hit.column - 1 + hit.length)}</mark>
											{hit.text.slice(hit.column - 1 + hit.length, hit.column + 80)}
										</span>
									</div>
								)}
							</For>
						</>
					)}
				</For>
			</div>
		</div>
	);
}
