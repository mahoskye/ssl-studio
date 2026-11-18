// Workspace search, results grouped by file.
import { createResource, createSignal, For, Show } from "solid-js";
import { monaco } from "../editor/monaco";
import { symbolPath } from "../editor/regions";
import { session } from "../lsp/session";
import type { SearchHit } from "../../shared/protocol";
import { backend } from "../backend";
import { openFile, state } from "../state";
import { relativeTo } from "../../shared/paths";
import { focusRowsBelow, IconButton, Row, RowGroup, Rows } from "./Rows";
import { byLine, segments, type LineHit } from "./searchLines";

const count = (n: number, one: string) => `${n} ${one}${n === 1 ? "" : "s"}`;

export function Search() {
	let input!: HTMLInputElement;
	const [hits, setHits] = createSignal<SearchHit[]>([]);
	const [regex, setRegex] = createSignal(false);
	const [caseSensitive, setCaseSensitive] = createSignal(false);
	/** Where the panel stands: nothing asked yet, searching, the last search answered or failed. */
	const [status, setStatus] = createSignal<"idle" | "busy" | "done" | "failed">("idle");
	const [asked, setAsked] = createSignal("");
	const [failure, setFailure] = createSignal("");
	let latest = 0;
	const run = async () => {
		const query = input.value;
		const mine = ++latest;
		if (!query) {
			setHits([]);
			setStatus("idle");
			return;
		}
		setStatus("busy");
		setAsked(query);
		try {
			const found = await backend.search(query, { regex: regex(), caseSensitive: caseSensitive() });
			if (mine !== latest) return;
			setHits(found);
			setStatus("done");
		} catch (e: any) {
			if (mine !== latest) return;
			setHits([]);
			setFailure(String(e?.message ?? e));
			setStatus("failed");
		}
	};
	// A switch changes what the results on screen mean, so they are fetched again.
	const flip = (set: (v: boolean) => void, now: boolean) => {
		set(!now);
		if (status() !== "idle") void run();
	};
	const groups = () => {
		const map = new Map<string, LineHit[]>();
		for (const line of byLine(hits())) map.set(line.path, [...(map.get(line.path) ?? []), line]);
		return [...map];
	};
	// Where each line sits, region › procedure, from the server's symbols (first 40 files).
	const [places] = createResource(groups, async (list) => {
		const out = new Map<string, string>();
		for (const [path, lines] of list.slice(0, 40)) {
			const model = await session.ensureModel(monaco.Uri.file(path).toString());
			if (!model || model.getLanguageId() !== "ssl") continue;
			const symbols = await session.documentSymbols(model).catch(() => []);
			for (const line of lines) out.set(`${path}:${line.line}`, symbolPath(symbols, line.line).filter((s) => s.kind === monaco.languages.SymbolKind.Namespace || s.kind === monaco.languages.SymbolKind.Function || s.kind === monaco.languages.SymbolKind.Method).map((s) => s.name).join(" › "));
		}
		return out;
	});
	const place = (line: LineHit) => places()?.get(`${line.path}:${line.line}`) ?? "";
	const byPlace = (list: LineHit[]) => {
		const map = new Map<string, LineHit[]>();
		for (const line of list) map.set(place(line), [...(map.get(place(line)) ?? []), line]);
		return [...map];
	};
	const rel = (path: string) => relativeTo(state.workspace?.root, path);
	const matchesIn = (list: LineHit[]) => list.reduce((n, line) => n + line.matches.length, 0);
	const summary = () => {
		if (status() === "busy") return "Searching…";
		if (status() === "failed") return `The search for “${asked()}” failed: ${failure()}${regex() ? " Check the regular expression, or switch .* off." : ""}`;
		if (status() === "idle") return "Type what to find and press Enter. Aa matches upper and lower case exactly; .* reads it as a regular expression.";
		if (!hits().length) return `Nothing found for “${asked()}”. Check the spelling${caseSensitive() || regex() ? ", or switch Aa and .* off" : ""}.`;
		return `${count(hits().length, "result")} in ${count(groups().length, "file")} for “${asked()}”`;
	};
	const HitRow = (props: { line: LineHit }) => {
		const first = () => props.line.matches[0]!;
		return (
			<Row
				class="tree-row hit"
				key={`${props.line.path}:${props.line.line}`}
				style={{ "padding-left": "22px" }}
				label={props.line.text.trim()}
				title={`Line ${props.line.line}${props.line.matches.length > 1 ? `, ${props.line.matches.length} matches` : ""}: ${props.line.text.trim()}`}
				onActivate={() => void openFile(props.line.path, { reveal: { line: props.line.line, column: first().column, endLine: props.line.line, endColumn: first().column + first().length } })}
			>
				<span class="meta">{props.line.line}</span>
				<span class="label">
					<For each={segments(props.line)}>{(part) => (part.match ? <mark>{part.text}</mark> : part.text)}</For>
				</span>
			</Row>
		);
	};
	return (
		<div class="panel-body" data-panel="search">
			<div class="panel-title">
				<span>Search</span>
			</div>
			<form class="search-form" role="search" onSubmit={(e) => (e.preventDefault(), void run())}>
				<input
					ref={(el) => ((input = el), queueMicrotask(() => el.focus()))}
					id="search-input"
					data-autofocus=""
					aria-label="Search the workspace"
					placeholder="Search the workspace"
					onKeyDown={(e) => e.key === "ArrowDown" && focusRowsBelow(e.currentTarget) && e.preventDefault()}
				/>
				<IconButton label="Match case" glyph="Aa" pressed={caseSensitive()} onClick={() => flip(setCaseSensitive, caseSensitive())} />
				<IconButton label="Use a regular expression" title="Regular expression" glyph=".*" pressed={regex()} onClick={() => flip(setRegex, regex())} />
			</form>
			<p class="hint" classList={{ warn: status() === "failed" }} role="status">
				{summary()}
			</p>
			<Rows label="Search results">
				<For each={groups()}>
					{([path, list]) => (
						<RowGroup
							headClass="tree-row file-head"
							title={path}
							head={
								<>
									<span class="label">{rel(path)}</span>
									<span class="meta" title={count(matchesIn(list), "match") + " in this file"}>
										{matchesIn(list)}
									</span>
								</>
							}
						>
							<For each={byPlace(list)}>
								{([where, lines]) => (
									<Show when={where} fallback={<For each={lines}>{(line) => <HitRow line={line} />}</For>}>
										<div role="group" aria-label={where}>
											<div class="tree-row place" style={{ "padding-left": "16px" }} title={where} aria-hidden="true">
												<span class="label">{where}</span>
											</div>
											<For each={lines}>{(line) => <HitRow line={line} />}</For>
										</div>
									</Show>
								)}
							</For>
						</RowGroup>
					)}
				</For>
			</Rows>
		</div>
	);
}
