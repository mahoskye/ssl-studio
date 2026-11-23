// Workspace search, results grouped by file; and, from the same box, a
// replace across files. What would be replaced is shown in the results
// before anything is written, and nothing is written until it is confirmed.
// The search, the preview and the replace all find their matches with the
// one expression (src/shared/searchPattern.ts), so they agree.
import { Icon } from "../Icon";
import { FileMark } from "../FileMark";
import { createEffect, createMemo, createResource, createSignal, For, Show } from "solid-js";
import { monaco } from "../editor/monaco";
import { symbolPath } from "../editor/regions";
import { session } from "../lsp/session";
import type { SearchHit } from "../../shared/protocol";
import { backend } from "../backend";
import { choose } from "../dialogs";
import { activePath, canonical, documents, fileChangedOnDisk, notify, openFile, save, saveAll, setState, state } from "../state";
import { baseName, relativeTo } from "../../shared/paths";
import { DOC_FOLDERS, isCatalog, toneOf } from "../../shared/projectDocs";
import { matchesOn, SEARCH_LIMIT, searchPattern, type SearchOptions } from "../../shared/searchPattern";
import { outline } from "../../shared/outline";
import { tagSearchPattern, workspaceTags } from "../../shared/tags";
import { codeMatchesRef, descendantTickets, scriptsForTicket, ticketForFile, ticketWork } from "../../shared/workContext";
import { docs } from "../project";
import { ticketAtHand } from "../projectDocs";
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

/** Shows the Search panel scoped to a specific folder (relative to workspace root). */
export function findInFolder(relFolder: string) {
	const cleaned = relFolder.replace(/^[./\\]+|[\\/]+$/g, "").replace(/\\/g, "/");
	setInclude(cleaned ? `${cleaned}/**` : "");
	setChoosing(true);
	showPanel("search");
}

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

const [request, setRequest] = createSignal<({ query: string } & SearchOptions) | null>(null);
/** Shows the Search panel with this searched for: a table cell or code check asks where a value appears in code. */
export function searchFor(query: string, options: SearchOptions = {}) {
	setRequest({ query, ...options });
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
const [effectiveAsked, setEffectiveAsked] = createSignal("");
/** The switches and the files the results on screen were found with: a replace uses these, not what has been changed since. */
const [searched, setSearched] = createSignal<SearchOptions>({});
const [failure, setFailure] = createSignal("");
const [docFilterNote, setDocFilterNote] = createSignal("");
let latest = 0;

type ParsedDocFilters = { text: string; tags: string[]; statuses: string[] };

/** Extracts `tag:<name>` and `status:<val>` tokens from a search query string (supports quoted values). */
function parseDocFilterTokens(raw: string): ParsedDocFilters {
	const tags: string[] = [];
	const statuses: string[] = [];
	const rest = raw
		.replace(/(?:^|\s)(tag|status):(?:"([^"]+)"|'([^']+)'|(\S+))/gi, (full, kind: string, dq?: string, sq?: string, bare?: string) => {
			const val = (dq ?? sq ?? bare ?? "").trim();
			if (!val) return full;
			if (kind.toLowerCase() === "tag") tags.push(val.replace(/^#+/, ""));
			else statuses.push(val);
			return " ";
		})
		.replace(/\s+/g, " ")
		.trim();
	return { text: rest, tags, statuses };
}

const normStatus = (s?: string) => (s ?? "").toLowerCase().replace(/[-_]+/g, " ").trim();

export function Search() {
	let input!: HTMLInputElement;
	const [workspaceFiles] = createResource(
		() => (state.workspace?.root ? `${state.workspace.root}#${state.treeVersion}` : false),
		() => backend.files().catch(() => [] as string[]),
	);
	const run = async () => {
		const rawQuery = input.value;
		const mine = ++latest;
		setDocFilterNote("");
		if (!rawQuery) {
			setHits([]);
			setStatus("idle");
			return;
		}
		setStatus("busy");
		setAsked(rawQuery);
		// Support `tag:<name>` and `status:<val>` filter tokens using indexed `docs()` metadata when not in raw regex mode.
		const parsed = !regex() ? parseDocFilterTokens(rawQuery) : { text: rawQuery, tags: [], statuses: [] };
		let effectiveQuery = parsed.text;
		let effectiveRegex = regex();
		let effectiveWhole = wholeWord();
		let effectiveCase = caseSensitive();
		let effectiveInclude = choosing() ? include() : "";
		const effectiveExclude = choosing() ? exclude() : "";

		if (parsed.tags.length || parsed.statuses.length) {
			const root = state.workspace?.root;
			const matchedDocs = docs().filter((d) => {
				if (!d.exists || isCatalog(d)) return false;
				if (parsed.tags.length) {
					const dTags = (d.tags ?? []).map((t) => t.toLowerCase());
					if (!parsed.tags.every((wanted) => dTags.includes(wanted.toLowerCase()))) return false;
				}
				if (parsed.statuses.length) {
					const dNorm = normStatus(d.status);
					const dTone = toneOf(d.status);
					if (
						!parsed.statuses.every((wanted) => {
							const wNorm = normStatus(wanted);
							return dNorm === wNorm || dTone === wNorm;
						})
					) {
						return false;
					}
				}
				return true;
			});
			const filterLabel = [...parsed.tags.map((t) => `tag:${t}`), ...parsed.statuses.map((s) => `status:${s}`)].join(" ");
			setDocFilterNote(`${filterLabel} (${matchedDocs.length} ${matchedDocs.length === 1 ? "doc" : "docs"})`);
			if (!matchedDocs.length) {
				setHits([]);
				setSearched({ regex: effectiveRegex, caseSensitive: effectiveCase, wholeWord: effectiveWhole });
				setStatus("done");
				return;
			}
			effectiveInclude = matchedDocs.map((d) => relativeTo(root, d.path).replace(/\\/g, "/")).join(", ");
			if (!effectiveQuery) {
				if (parsed.tags.length) {
					effectiveQuery = tagSearchPattern(parsed.tags[0]!);
					effectiveRegex = true;
					effectiveWhole = false;
				} else {
					effectiveQuery = "^status\\s*:";
					effectiveRegex = true;
					effectiveCase = false;
					effectiveWhole = false;
				}
			}
		}

		// The files are narrowed only while their boxes are showing, or when tag:/status: metadata filters narrowed them.
		const options: SearchOptions = {
			regex: effectiveRegex,
			caseSensitive: effectiveCase,
			wholeWord: effectiveWhole,
			...(effectiveInclude || effectiveExclude ? { include: effectiveInclude, exclude: effectiveExclude } : {}),
		};
		setSearched(options);
		setEffectiveAsked(effectiveQuery);
		try {
			const found = await backend.search(effectiveQuery, options);
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
		setRegex(Boolean(wanted.regex));
		setWholeWord(Boolean(wanted.wholeWord));
		setCaseSensitive(Boolean(wanted.caseSensitive));
		const nextInc = wanted.include ?? "";
		const nextExc = wanted.exclude ?? "";
		setInclude(nextInc);
		setExclude(nextExc);
		setChoosing(Boolean(nextInc.trim() || nextExc.trim()));
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
	// Where each line sits: SSL region › procedure (from starlims-lsp) OR Markdown # Heading (from shared/outline).
	// Strictly skips Monaco model creation for non-SSL files so search never leaks ITextModels, and reads Markdown
	// from disk to match `backend.search` line numbers accurately.
	let placesSeq = 0;
	const [places] = createResource(groups, async (list) => {
		const mine = ++placesSeq;
		const out = new Map<string, string>();
		let sslChecked = 0;
		for (const [path, lines] of list) {
			if (mine !== placesSeq) return out;
			if (/\.(md|markdown)$/i.test(path)) {
				const text = await backend.read(path).then((r) => r.text, () => "");
				if (!text || mine !== placesSeq) continue;
				const mdSymbols = outline("markdown", text);
				for (const line of lines) {
					const trail: string[] = [];
					const walk = (nodes: typeof mdSymbols) => {
						for (const n of nodes) {
							if (line.line >= n.line && line.line <= n.endLine) {
								trail.push(n.name);
								if (n.children?.length) walk(n.children);
								break;
							}
						}
					};
					walk(mdSymbols);
					if (trail.length) out.set(`${path}:${line.line}`, trail.join(" › "));
				}
				continue;
			}
			if (!/\.(ssl|srvscr|ds)$/i.test(path) || sslChecked >= 60) continue;
			sslChecked++;
			const model = await session.ensureModel(monaco.Uri.file(path).toString());
			if (mine !== placesSeq) return out;
			if (!model || model.getLanguageId() !== "ssl") continue;
			const symbols = await session.documentSymbols(model).catch(() => []);
			if (mine !== placesSeq) return out;
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
	const cleanDir = (dir?: string) => (dir ?? "").replace(/^[./\\]+|[\\/]+$/g, "").replace(/\\/g, "/");
	const docsRel = () => cleanDir(state.project?.docs ?? "docs");
	const plansRel = () => cleanDir(state.project?.plans ?? "design");
	const schemaRel = () => cleanDir(state.project?.schema ?? "schema");
	const codeExcludeGlob = () =>
		[
			docsRel() ? `${docsRel()}/**` : `${DOC_FOLDERS.tickets}/**, ${DOC_FOLDERS.specs}/**, ${DOC_FOLDERS.knowledge}/**, ${DOC_FOLDERS.registries}/**`,
			plansRel() ? `${plansRel()}/**` : "",
			schemaRel() ? `${schemaRel()}/**` : "",
			"README.md",
			"AGENTS.md",
			"**/INDEX.md",
		]
			.filter(Boolean)
			.join(", ");
	const docsIncludeGlob = () =>
		[
			docsRel() ? `${docsRel()}/**` : `${DOC_FOLDERS.tickets}/**, ${DOC_FOLDERS.specs}/**, ${DOC_FOLDERS.knowledge}/**, ${DOC_FOLDERS.registries}/**`,
			plansRel() ? `${plansRel()}/**` : "",
			schemaRel() ? `${schemaRel()}/**` : "",
			"*.md",
		]
			.filter(Boolean)
			.join(", ");
	const activeTicketScope = createMemo(() => {
		const root = state.workspace?.root;
		const allDocs = docs();
		const key = state.settings.activeTicket?.trim() || ticketForFile(allDocs, activePath(), root) || ticketAtHand();
		if (!key) return null;
		const found = allDocs.find((d) => d.exists && d.group === "tickets" && d.ticket?.toLowerCase() === key.toLowerCase());
		if (!found) return null;
		const descendants = descendantTickets(allDocs, key);
		const globs = new Set<string>();
		const addTicketTree = (ticketDoc: typeof found) => {
			globs.add(relativeTo(root, ticketDoc.path).replace(/\\/g, "/"));
			if (ticketDoc.ticketFolder) {
				globs.add(`${relativeTo(root, ticketDoc.ticketFolder).replace(/\\/g, "/")}/**`);
			}
			const tKey = ticketDoc.ticket;
			if (!tKey) return;
			for (const group of ticketWork(allDocs, tKey)) {
				if (group.kind === "ticket") continue;
				for (const ref of group.files) {
					globs.add(relativeTo(root, ref.path).replace(/\\/g, "/"));
				}
			}
		};
		addTicketTree(found);
		for (const desc of descendants) addTicketTree(desc);
		// Resolve referenced scripts across the ticket & all descendant tickets against real workspace paths.
		const refs = scriptsForTicket(allDocs, key, { includeDescendants: true });
		let resolvedScripts = 0;
		if (refs.length) {
			const allWs = workspaceFiles() ?? [];
			for (const filePath of allWs) {
				if (refs.some((ref) => codeMatchesRef(filePath, ref, root))) {
					globs.add(relativeTo(root, filePath).replace(/\\/g, "/"));
					resolvedScripts++;
				}
			}
		}
		const extras = [
			descendants.length ? `${descendants.length} sub-${descendants.length === 1 ? "ticket" : "tickets"}` : "",
			resolvedScripts ? `${resolvedScripts} ${resolvedScripts === 1 ? "script" : "scripts"}` : "",
		].filter(Boolean);
		return {
			key,
			glob: [...globs].filter(Boolean).join(", "),
			tip: `Search ${key}${extras.length ? ` (${extras.join(", ")})` : ""}, its folder, and all linked specs/plans/decisions`,
		};
	});
	const topTags = createMemo(() => workspaceTags(docs()).slice(0, 4));
	const toggleQueryToken = (token: string) => {
		const cur = input ? input.value : typed();
		const esc = token.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
		const re = new RegExp(`(?:^|\\s)${esc}(?=\\s|$)`, "i");
		const next = re.test(cur) ? cur.replace(re, " ").replace(/\s+/g, " ").trim() : `${token}${cur.trim() ? ` ${cur.trim()}` : ""}`;
		if (input) input.value = next;
		setTyped(next);
		if (next) void run();
	};
	const hasQueryToken = (token: string) => {
		const esc = token.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
		return new RegExp(`(?:^|\\s)${esc}(?=\\s|$)`, "i").test(typed());
	};
	const applyScope = (inc: string, exc = "") => {
		setInclude(inc);
		setExclude(exc);
		setChoosing(Boolean(inc || exc));
		if (typed().trim()) void run();
	};
	const scopeActive = (inc: string, exc = "") => (choosing() ? include().trim() === inc && exclude().trim() === exc : !inc && !exc);

	// --- replacing -------------------------------------------------------------

	/** The expression the results were found with, for showing what each match would become. Null when it cannot be read. */
	const pattern = createMemo(() => {
		try {
			const q = effectiveAsked() || asked();
			return q ? searchPattern(q, searched()) : null;
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
		const query = effectiveAsked() || asked();
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
		if (status() === "idle") return "Type what to find and press Enter. Use tag:<name> or status:<val> to narrow Docs. Aa matches case; ab whole words; .* regex.";
		const filterTail = docFilterNote() ? ` [${docFilterNote()}]` : "";
		if (!hits().length) return `Nothing found for “${asked()}”${filterTail}${narrowed() && !docFilterNote() ? " in the files chosen" : ""}. Check the spelling${switchesOn().length ? `, or switch ${switchesOn().join(" and ")} off` : ""}${narrowed() ? ", or look in more files" : ""}.`;
		return `${hits().length >= SEARCH_LIMIT ? `The first ${SEARCH_LIMIT} results` : count(hits().length, "result")} in ${count(groups().length, "file")} for “${asked()}”${filterTail}${narrowed() && !docFilterNote() ? ", in the files chosen" : ""}`;
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
				// To stay or for a look, a result opens at its match.
				onKeep={() => void openFile(props.line.path, { keep: true, reveal: { line: props.line.line, column: first().column, endLine: props.line.line, endColumn: first().column + first().length } })}
				onActivate={() => void openFile(props.line.path, { preview: true, reveal: { line: props.line.line, column: first().column, endLine: props.line.line, endColumn: first().column + first().length } })}
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
						<Icon name={replacing() ? "chevron-down" : "chevron-right"} />
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
						icon="ellipsis"
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
				<div class="search-scopes" role="group" aria-label="Quick search scope">
					<button type="button" classList={{ on: scopeActive("", "") }} title="Search all workspace files" onClick={() => applyScope("", "")}>
						All
					</button>
					<button
						type="button"
						classList={{ on: scopeActive("", codeExcludeGlob()) }}
						title="Search code files only (exclude docs, design, schema, and catalogs)"
						onClick={() => applyScope("", codeExcludeGlob())}
					>
						Code
					</button>
					<button
						type="button"
						classList={{ on: scopeActive(docsIncludeGlob(), "") }}
						title="Search project documentation, plans, schema, and Markdown files"
						onClick={() => applyScope(docsIncludeGlob(), "")}
					>
						Docs
					</button>
					<Show when={activeTicketScope()}>
						{(scope) => (
							<button
								type="button"
								classList={{ on: scopeActive(scope().glob, "") }}
								title={scope().tip}
								onClick={() => applyScope(scope().glob, "")}
							>
								{scope().key}
							</button>
						)}
					</Show>
				</div>
				<Show when={scopeActive(docsIncludeGlob(), "")}>
					<div class="search-doc-tokens" role="group" aria-label="Document metadata filter chips">
						<For each={topTags()}>
							{(bucket) => {
								const tok = `tag:${bucket.tag}`;
								return (
									<button
										type="button"
										classList={{ on: hasQueryToken(tok) }}
										title={`Filter Docs by #${bucket.tag} (${bucket.count})`}
										onClick={() => toggleQueryToken(tok)}
									>
										#{bucket.tag}
									</button>
								);
							}}
						</For>
						<For each={["open", "in-progress", "draft", "done"]}>
							{(st) => {
								const tok = `status:${st}`;
								return (
									<button
										type="button"
										classList={{ on: hasQueryToken(tok) }}
										title={`Filter Docs by status:${st}`}
										onClick={() => toggleQueryToken(tok)}
									>
										{tok}
									</button>
								);
							}}
						</For>
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
