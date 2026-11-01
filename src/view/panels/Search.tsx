// Workspace search, results grouped by file.
import { createResource, createSignal, For, Show } from "solid-js";
import { monaco } from "../editor/monaco";
import { symbolPath } from "../editor/regions";
import { session } from "../lsp/session";
import type { SearchHit } from "../../shared/protocol";
import { backend } from "../backend";
import { notify, openFile, state } from "../state";
import { relativeTo } from "../../shared/paths";

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
	// Where each hit sits, region › procedure, from the server's symbols (first 40 files).
	const [places] = createResource(groups, async (list) => {
		const out = new Map<string, string>();
		for (const [path, fileHits] of list.slice(0, 40)) {
			const model = await session.ensureModel(monaco.Uri.file(path).toString());
			if (!model || model.getLanguageId() !== "ssl") continue;
			const symbols = await session.documentSymbols(model).catch(() => []);
			for (const hit of fileHits) out.set(`${path}:${hit.line}:${hit.column}`, symbolPath(symbols, hit.line).filter((s) => s.kind === monaco.languages.SymbolKind.Namespace || s.kind === monaco.languages.SymbolKind.Function || s.kind === monaco.languages.SymbolKind.Method).map((s) => s.name).join(" › "));
		}
		return out;
	});
	const place = (hit: SearchHit) => places()?.get(`${hit.path}:${hit.line}:${hit.column}`) ?? "";
	const byPlace = (list: SearchHit[]) => {
		const map = new Map<string, SearchHit[]>();
		for (const hit of list) map.set(place(hit), [...(map.get(place(hit)) ?? []), hit]);
		return [...map];
	};
	const rel = (path: string) => relativeTo(state.workspace?.root, path);
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
							<For each={byPlace(list)}>
								{([where, placeHits]) => (
									<>
										<Show when={where}>
											<div class="tree-row place" style={{ "padding-left": "16px" }}>
												<span class="label">{where}</span>
											</div>
										</Show>
										<For each={placeHits}>
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
						</>
					)}
				</For>
			</div>
		</div>
	);
}
