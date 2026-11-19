// Workspace search, results grouped by file; and, from the same box, a
// replace across files. What would be replaced is shown in the results
// before anything is written, and nothing is written until it is confirmed.
// The search, the preview and the replace all find their matches with the
// one expression (src/shared/searchPattern.ts), so they agree.
import { FileMark } from "../FileMark";
import { createEffect, createMemo, createResource, createSignal, For, Show } from "solid-js";
import { monaco } from "../editor/monaco";
import { symbolPath } from "../editor/regions";
import { session } from "../lsp/session";
import type { SearchHit } from "../../shared/protocol";
import { backend } from "../backend";
import { choose } from "../dialogs";
import { canonical, documents, fileChangedOnDisk, notify, openFile, save, saveAll, setState, state } from "../state";
import { baseName, relativeTo } from "../../shared/paths";
import { matchesOn, SEARCH_LIMIT, searchPattern, type SearchOptions } from "../../shared/searchPattern";
import { focusRowsBelow, IconButton, Row, RowGroup, Rows } from "./Rows";
import { showPanel } from "./registry";
import { byLine, markedColumns, segments, type LineHit } from "./searchLines";

const count = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** How much of a line is shown before its first match. */
const LEAD = 12;

/** The row for replacing is open. Kept while the panel is away, as what was typed in it is. */
const [replacing, setReplacing] = createSignal(false);
/** The rows for which files to look in are open. */
const [choosing, setChoosing] = createSignal(false);
const [replacement, setReplacement] = createSignal("");
const [include, setInclude] = createSignal("");
const [exclude, setExclude] = createSignal("");

/** Shows the Search panel with its row for replacing open. */
export function showReplace() {
	setReplacing(true);
	showPanel("search");
}

/** Replaces every match in an open file's text, as one step that undo takes back. Says how many. */
function replaceInModel(model: monaco.editor.ITextModel, pattern: RegExp, with_: string, regex: boolean): number {
	const edits: monaco.editor.IIdentifiedSingleEditOperation[] = [];
	for (let line = 1; line <= model.getLineCount(); line++) {
		for (const match of matchesOn(model.getLineContent(line), pattern, with_, regex)) edits.push({ range: new monaco.Range(line, match.column, line, match.column + match.length), text: match.becomes });
	}
	if (!edits.length) return 0;
	model.pushStackElement();
	model.pushEditOperations([], edits, () => null);
	model.pushStackElement();
	return edits.length;
}

const [request, setRequest] = createSignal<{ query: string; regex: boolean } | null>(null);
/** Shows the Search panel with this searched for: a registry's row asks where its name is in the code. */
export function searchFor(query: string, options: { regex?: boolean } = {}) {
	setRequest({ query, regex: Boolean(options.regex) });
	showPanel("search");
}

// What was searched for, how, and what was found: kept while the panel is away, with the replacement and the file
// patterns, so that coming back to it is coming back to the same search.
const [typed, setTyped] = createSignal("");
const [hits, setHits] = createSignal<SearchHit[]>([]);
const [regex, setRegex] = createSignal(false);
const [caseSensitive, setCaseSensitive] = createSignal(false);
const [wholeWord, setWholeWord] = createSignal(false);
/** Where the panel stands: nothing asked yet, searching, the last search answered or failed. */
const [status, setStatus] = createSignal<"idle" | "busy" | "done" | "failed">("idle");
const [asked, setAsked] = createSignal("");
/** The switches and the files the results on screen were found with: a replace uses these, not what has been changed since. */
const [searched, setSearched] = createSignal<SearchOptions>({});
const [failure, setFailure] = createSignal("");
let latest = 0;

export function Search() {
	let input!: HTMLInputElement;
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
		// The files are narrowed only while their boxes are showing: a pattern out of sight would hide results with no sign of why.
		const options: SearchOptions = { regex: regex(), caseSensitive: caseSensitive(), wholeWord: wholeWord(), ...(choosing() ? { include: include(), exclude: exclude() } : {}) };
		setSearched(options);
		try {
			const found = await backend.search(query, options);
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
	// A search asked for from elsewhere is put in the box and run, as if it had been typed.
	createEffect(() => {
		const wanted = request();
		if (!wanted || !input) return;
		setRequest(null);
		input.value = wanted.query;
		setTyped(wanted.query);
		setRegex(wanted.regex);
		void run();
	});
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
	/** The switches that narrow a search, by the names on their buttons: what to try without when nothing is found. */
	const switchesOn = () => [caseSensitive() ? "Aa" : "", wholeWord() ? "ab" : "", regex() ? ".*" : ""].filter(Boolean);
	const narrowed = () => Boolean(searched().include?.trim() || searched().exclude?.trim());

	// --- replacing -------------------------------------------------------------

	/** The expression the results were found with, for showing what each match would become. Null when it cannot be read. */
	const pattern = createMemo(() => {
		try {
			return asked() ? searchPattern(asked(), searched()) : null;
		} catch {
			return null;
		}
	});
	/** What each marked match of a line would become, by the column it starts at. */
	const becomes = (line: LineHit) => {
		const found = pattern();
		return new Map(found ? matchesOn(line.text, found, replacement(), Boolean(searched().regex)).map((match) => [match.column, match.becomes] as const) : []);
	};
	/** Why "Replace all" cannot be pressed now; "" when it can. */
	const noReplace = () => {
		if (status() === "busy") return "The search is still running";
		if (status() !== "done" || !hits().length) return "Search for something first: what is found is what is replaced";
		if (hits().length >= SEARCH_LIMIT) return `There are ${SEARCH_LIMIT} results or more, and only the first are listed: narrow the search before replacing`;
		return "";
	};
	const replaceAll = async () => {
		if (noReplace()) return;
		const query = asked();
		const options = searched();
		const with_ = replacement();
		const found = pattern();
		if (!found) return;
		const paths = groups().map(([path]) => path);
		const total = hits().length;
		const answer = await choose(`Replace ${count(total, "match", "matches")} in ${count(paths.length, "file")} with ${with_ ? `“${with_}”` : "nothing"}? Each file that is written is first kept as it was in its local history.`, ["Replace"]);
		if (answer !== "Replace") return;
		setStatus("busy");
		let done = 0;
		let files = 0;
		const unsaved: string[] = [];
		const failed: string[] = [];
		const onDisk: string[] = [];
		try {
			for (const path of paths) {
				const at = canonical(path);
				// A file with a tab is changed in the editor, where undo takes it back: saved straight away when it had
				// nothing unsaved, and left unsaved when it had. A file that was only read to show where its results are
				// has no tab and nothing to undo in: it is changed on disk like any file that is not open.
				const doc = documents.get(at);
				const tabbed = state.groups.some((group) => group.tabs.includes(at));
				if (!doc || doc.binary || (!tabbed && !state.dirty[at])) {
					onDisk.push(path);
					continue;
				}
				const wasUnsaved = Boolean(state.dirty[at]);
				// The file as it is on disk goes into its local history before the save that follows writes over it.
				if (!wasUnsaved) await backend.historyKeep(at).catch(() => {});
				const changed = replaceInModel(doc.model, found, with_, Boolean(options.regex));
				if (!changed) continue;
				done += changed;
				files++;
				if (wasUnsaved) unsaved.push(path);
				else if (!(await save(at, { format: false }))) failed.push(`${baseName(path)}: it is changed in the editor, and could not be saved`);
			}
			for (const result of onDisk.length ? await backend.replace(query, with_, options, onDisk) : []) {
				if (result.error) failed.push(`${baseName(result.path)}: ${result.error}`);
				if (!result.count) continue;
				done += result.count;
				files++;
				// The language server and the tree are told, and a copy that was read without a tab follows the disk.
				await fileChangedOnDisk(result.path);
			}
		} catch (e: any) {
			failed.push(String(e?.message ?? e));
		}
		setState("treeVersion", (v) => v + 1);
		// What was replaced is what is there now, which is what was listed unless a file changed since the search.
		const differs = done !== total && !failed.length ? ` ${count(total, "match", "matches")} were listed: a file has changed since the search, or holds unsaved changes.` : "";
		const note = `Replaced ${count(done, "match", "matches")} in ${count(files, "file")}.${differs}`;
		if (unsaved.length) {
			// The one thing left to do: it stays long enough to do it, and offers it.
			notify(`${note} ${unsaved.length === 1 ? `${baseName(unsaved[0]!)} had unsaved changes: it is changed in the editor and not saved.` : `${unsaved.length} files had unsaved changes: they are changed in the editor and not saved.`} A search reads what is saved, so it finds the old words there until then.`, "info", { label: "Save all", run: () => void saveAll() });
		} else notify(note);
		if (failed.length) notify(`Not replaced: ${failed.join("; ")}`, "error");
		// What is left to find is searched for again: nothing, unless the replacement itself is a match.
		await run();
	};
	const summary = () => {
		if (status() === "busy") return "Searching…";
		if (status() === "failed") return `The search for “${asked()}” failed: ${failure()}${regex() ? " Check the regular expression, or switch .* off." : ""}`;
		if (status() === "idle") return "Type what to find and press Enter. Aa matches upper and lower case exactly; ab finds whole words only; .* reads it as a regular expression.";
		if (!hits().length) return `Nothing found for “${asked()}”${narrowed() ? " in the files chosen" : ""}. Check the spelling${switchesOn().length ? `, or switch ${switchesOn().join(" and ")} off` : ""}${narrowed() ? ", or look in more files" : ""}.`;
		return `${hits().length >= SEARCH_LIMIT ? `The first ${SEARCH_LIMIT} results` : count(hits().length, "result")} in ${count(groups().length, "file")} for “${asked()}”${narrowed() ? ", in the files chosen" : ""}`;
	};
	const HitRow = (props: { line: LineHit }) => {
		const first = () => props.line.matches[0]!;
		/** The line's parts, each marked match with the column it starts at. */
		const parts = () => {
			const columns = markedColumns(props.line);
			let mark = 0;
			return segments(props.line, LEAD).map((part) => ({ ...part, column: part.match ? columns[mark++] : undefined }));
		};
		// A line cut short for the list cannot say what a match near its cut would become: it is only marked.
		const after = createMemo(() => (replacing() && props.line.text.length < 400 ? becomes(props.line) : null));
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
					{/* A dozen characters of what comes before: in a side panel's width, more would push the match itself out of sight. */}
					<For each={parts()}>
						{(part) =>
							!part.match ? (
								part.text
							) : after()?.has(part.column!) ? (
								// What is there now, struck out, and what would stand in its place.
								<>
									<del>{part.text}</del>
									<span class="visually-hidden"> becomes </span>
									<ins>{after()!.get(part.column!)}</ins>
									<span class="visually-hidden"> </span>
								</>
							) : (
								<mark>{part.text}</mark>
							)
						}
					</For>
				</span>
			</Row>
		);
	};
	return (
		<div class="panel-body" data-panel="search">
			<div class="panel-title">
				<span>Search</span>
			</div>
			<form
				class="search-form"
				role="search"
				onSubmit={(e) => (e.preventDefault(), void run())}
				// With more than one box a form no longer sends itself on Enter: each box asks for the search.
				onKeyDown={(e) => e.key === "Enter" && e.target instanceof HTMLInputElement && (e.preventDefault(), void run())}
			>
				<div class="search-row">
					<button type="button" class="search-fold" title={replacing() ? "Hide the replace row" : "Replace across files"} aria-label="Replace across files" aria-expanded={replacing()} onClick={() => setReplacing(!replacing())}>
						<span aria-hidden="true">{replacing() ? "▾" : "▸"}</span>
					</button>
					<input
						ref={(el) => ((input = el), queueMicrotask(() => el.focus()))}
						value={typed()}
						onInput={(e) => setTyped(e.currentTarget.value)}
						id="search-input"
						data-autofocus=""
						aria-label="Search the workspace"
						placeholder="Search the workspace"
						onKeyDown={(e) => e.key === "ArrowDown" && focusRowsBelow(e.currentTarget) && e.preventDefault()}
					/>
					<IconButton label="Match case" glyph="Aa" pressed={caseSensitive()} onClick={() => flip(setCaseSensitive, caseSensitive())} />
					<IconButton label="Match whole word" title="Whole word" glyph="ab" pressed={wholeWord()} onClick={() => flip(setWholeWord, wholeWord())} />
					<IconButton label="Use a regular expression" title="Regular expression" glyph=".*" pressed={regex()} onClick={() => flip(setRegex, regex())} />
					<IconButton
						label="Choose which files to search"
						title="Which files: to include, to exclude"
						glyph="…"
						pressed={choosing()}
						onClick={() => {
							setChoosing(!choosing());
							// Patterns that were narrowing the results stop when their boxes go, and start when they come back.
							if (status() !== "idle" && (include().trim() || exclude().trim())) void run();
						}}
					/>
				</div>
				<Show when={replacing()}>
					<div class="search-row">
						<span class="search-fold" aria-hidden="true" />
						<input aria-label="Replace with" placeholder={regex() ? "Replace with ($1 is the first group)" : "Replace with"} value={replacement()} onInput={(e) => setReplacement(e.currentTarget.value)} />
						{/* Not the button's own "disabled": it keeps the keyboard, and says why it does nothing. */}
						<button type="button" class="search-replace" aria-disabled={noReplace() ? "true" : undefined} title={noReplace() || "Replace every match listed below, after asking"} onClick={() => (noReplace() ? notify(`${noReplace()}.`) : void replaceAll())}>
							Replace all
						</button>
					</div>
				</Show>
				<Show when={choosing()}>
					<div class="search-row">
						<span class="search-fold" aria-hidden="true" />
						<input aria-label="Files to include" title="Patterns with commas between: *.ssl, src/DueDates, docs/**/*.md. Empty for every file." placeholder="Files to include: *.ssl, src" value={include()} onInput={(e) => setInclude(e.currentTarget.value)} />
					</div>
					<div class="search-row">
						<span class="search-fold" aria-hidden="true" />
						<input aria-label="Files to exclude" title="Patterns with commas between: tests, *.md. These are left out even when included above." placeholder="Files to exclude: tests, *.md" value={exclude()} onInput={(e) => setExclude(e.currentTarget.value)} />
					</div>
				</Show>
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
									<FileMark name={path} />
									<span class="label">{rel(path)}</span>
									<span class="meta" title={count(matchesIn(list), "match", "matches") + " in this file"}>
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
