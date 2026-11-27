// One box for going somewhere: Ctrl+P files (with :line, #heading, tag:/status:/type: facets),
// Ctrl+Shift+P commands, Ctrl+Shift+O in-file outline (@), Ctrl+T workspace symbols, tags & headings (#).
// What it lists is said by the first character in it (src/shared/quickPrefix.ts): the box opens with
// that character, and typing another, or taking it out, lists something else without closing the box.
import { FileMark } from "./FileMark";
import { createEffect, createMemo, createSignal, createUniqueId, For, onCleanup, Show } from "solid-js";
import { createAsyncQuery } from "./asyncQuery";
import { backend } from "./backend";
import { commands, keysShownFor, recentCommands, runCommand } from "./commands";
import { jumpToTableColumn } from "./editor/liveBridge";
import { mdOutline } from "./editor/mdOutline";
import { monaco } from "./editor/monaco";
import { session } from "./lsp/session";
import { Modal } from "./modal";
import { isPlanPath } from "./plan/model";
import { fileTier, filterCommands, isScript, matchWords, orderCommands } from "./quickRank";
import { csvColumns, mdSections, planStages, symbols as fileSymbols } from "./panels/Objects";
import { activeDoc, activePath, canonical, documents, markdownMode, openFile, setState, state } from "./state";
import { docs, isMarkdown, isTable } from "./project";
import { parseCsv } from "../shared/csv";
import { findHeadingLine } from "../shared/markdownEdit";
import { csvColumnOutline, hasOutline, markdownSectionTree, planStageOutline, type MarkdownSection } from "../shared/outline";
import { isCatalog, registryTitle, toneOf } from "../shared/projectDocs";
import type { DocFile } from "../shared/protocol";
import { baseName, relativeTo } from "../shared/paths";
import { fileTarget, lineAsked, parseQuickFacets, prefixFor, QUICK_PREFIXES, readQuick, type QuickMode } from "../shared/quickPrefix";

/**
 * `detail` follows the label on its line (a path, a shortcut); `note` is the quieter line below. `stay` keeps the
 * box open after the row is picked: the row changed what the box lists.
 */
type Item = { label: string; detail?: string; note?: string; divide?: boolean; /** A file's name, for its mark beside the label. */ file?: string; stay?: boolean; run: () => void };

const TITLES: Record<QuickMode, string> = {
	files: "Go to file",
	commands: "Run a command",
	outline: "Go to symbol in the open file",
	symbols: "Go to symbol, heading, or tag in workspace",
	line: "Go to line",
	help: "What can be typed here",
};
const PAGE = 10;

type Sym = monaco.languages.DocumentSymbol;
/** A file's symbols in the order they are written, each with the one it is inside. */
const flat = (list: readonly Sym[], inside = ""): { symbol: Sym; inside: string }[] => list.flatMap((symbol) => [{ symbol, inside }, ...flat(symbol.children ?? [], symbol.name)]);

const flatSections = (list: readonly MarkdownSection[], inside = ""): { section: MarkdownSection; inside: string }[] =>
	list.flatMap((section) => [
		{ section, inside },
		...flatSections(section.children, inside ? `${inside} › ${section.text}` : section.text),
	]);

const normStatus = (s?: string) => (s ?? "").toLowerCase().replace(/[-_]+/g, " ").trim();

function docDisplayTitle(doc: DocFile): string {
	if (doc.group === "registries") return registryTitle(doc.name);
	if (doc.ticket && doc.title && !doc.title.startsWith(doc.ticket)) return `${doc.ticket}: ${doc.title}`;
	return doc.ticket || doc.title || doc.heading || doc.name;
}

export function matchesDocType(doc: DocFile | undefined, path: string, wantedRaw: string): boolean {
	const w = wantedRaw.toLowerCase();
	switch (w) {
		case "spec":
		case "specs":
			return doc?.group === "specs";
		case "ticket":
		case "tickets":
			return doc?.group === "tickets";
		case "decision":
		case "decisions":
		case "adr":
			return doc?.group === "knowledge" && doc?.kind === "decisions";
		case "question":
		case "questions":
			return doc?.group === "knowledge" && doc?.kind === "questions";
		case "snippet":
		case "snippets":
			return doc?.group === "knowledge" && doc?.kind === "snippets";
		case "knowledge":
			return doc?.group === "knowledge";
		case "schema":
		case "schemas":
			return doc?.group === "schema";
		case "plan":
		case "plans":
			return doc?.group === "plans" || isPlanPath(path);
		case "registry":
		case "registries":
		case "csv":
			return doc?.group === "registries" || isTable(path);
		case "doc":
		case "docs":
		case "md":
		case "markdown":
			return isMarkdown(path);
		case "ssl":
		case "script":
		case "code":
			return /\.(ssl|srvscr|ds)(\.txt)?$/i.test(path);
		default:
			return doc?.group?.toLowerCase() === w || doc?.kind?.toLowerCase() === w;
	}
}

/**
 * The workspace symbols to list for what is typed now. The list the language server gave for this very question
 * is listed whole. One it gave for an earlier question, still held while the new one is waited for, is listed
 * only where a symbol's name has every word typed now: such a row answers the new question too. Without this the
 * rows of the earlier question stayed in the list through the wait, and Enter opened one of them.
 */
export function symbolsFor<S extends { name: string }>(held: { query: string; list: readonly S[] } | undefined, query: string): readonly S[] {
	if (!held) return [];
	if (held.query === query) return held.list;
	const words = query.toLowerCase().split(/\s+/).filter(Boolean);
	if (!words.length) return [];
	return held.list.filter((symbol) => {
		const name = symbol.name.toLowerCase();
		return words.every((word) => name.includes(word));
	});
}

function Picker(props: { mode: QuickMode }) {
	const listId = createUniqueId();
	/** What is in the box, the first character included. */
	const [text, setText] = createSignal(prefixFor(props.mode));
	const read = createMemo(() => readQuick(text()));
	const mode = () => read().mode;
	const query = () => read().query;
	const [selected, setSelected] = createSignal(0);
	const [failed, setFailed] = createSignal("");
	const close = () => setState((s) => { s.quickPick = null; });
	const rel = (path: string) => relativeTo(state.workspace?.root, path);
	const failedKey = createMemo(() => `${mode()}\0${state.workspace?.root ?? ""}`);
	createEffect(
		() => failedKey(),
		() => {
			setFailed("");
		},
	);
	const [files] = createAsyncQuery(
		() => (mode() === "files" && state.workspace?.root ? state.workspace.root : (false as const)),
		() => {
			setFailed("");
			return backend.files().catch((e: any) => {
				setFailed(String(e?.message ?? e));
				return [] as string[];
			});
		},
	);
	const [debouncedSymbolQuery, setDebouncedSymbolQuery] = createSignal<string | false>(false);
	const [symbolsPending, setSymbolsPending] = createSignal(false);
	const symbolInput = createMemo(() => (mode() === "symbols" ? query() : (false as const)));
	createEffect(
		() => symbolInput(),
		(q) => {
			if (q === false) {
				setSymbolsPending(false);
				setDebouncedSymbolQuery(false);
				return;
			}
			setSymbolsPending(true);
			const timer = setTimeout(() => {
				setSymbolsPending(false);
				setDebouncedSymbolQuery(q);
			}, 120);
			return () => clearTimeout(timer);
		},
	);
	let symbolSeq = 0;
	onCleanup(() => symbolSeq++);
	// The list is kept with the question it answers: while a newer question waits for its own, the old list is
	// still the query's value, and `symbolsFor` lists of it only what the newer question would list too.
	const [symbols] = createAsyncQuery(debouncedSymbolQuery, async (q) => {
		const seq = ++symbolSeq;
		try {
			const list = await session.workspaceSymbols(q);
			return { query: q, list: seq === symbolSeq ? list : [] };
		} catch {
			return { query: q, list: [] };
		}
	});
	const items = createMemo<Item[]>(() => {
		if (mode() === "files") {
			// Parse `tag:`, `status:`, `type:` facets, then `file#heading` or `file:line:col`.
			const facets = parseQuickFacets(query());
			const asked = fileTarget(facets.text);
			const docByPath = new Map(docs().filter((d) => d.exists).map((d) => [canonical(d.path), d]));
			const found = (files() ?? [])
				.map((path) => {
					const doc = docByPath.get(canonical(path));
					const title = doc ? docDisplayTitle(doc) : "";
					const relPath = rel(path);
					const tags = doc?.tags ?? [];
					const tagsText = tags.map((t) => `#${t}`).join(" ");
					return { path, rel: relPath, doc, title, status: doc?.status, tags, tagsText };
				})
				.filter((f) => {
					if (facets.tags.length) {
						const dTags = f.tags.map((t) => t.toLowerCase());
						if (!facets.tags.every((wanted) => dTags.includes(wanted.toLowerCase()))) return false;
					}
					if (facets.statuses.length) {
						const dNorm = normStatus(f.status);
						const dTone = toneOf(f.status);
						if (!facets.statuses.every((wanted) => dNorm === normStatus(wanted) || dTone === normStatus(wanted))) return false;
					}
					if (facets.types.length) {
						if (!facets.types.some((wanted) => matchesDocType(f.doc, f.path, wanted))) return false;
					}
					return true;
				});

			const q = asked.file.trim();
			const ranked: { item: (typeof found)[number]; tier: number; script: boolean }[] = [];
			for (const f of found) {
				// Score path properly via `fileTier` on `f.rel` AND allow multi-word out-of-order matches against title/ticket/tags/path.
				const pathTier = fileTier(q, f.rel);
				const wordScore = q ? matchWords(q, f.title || baseName(f.path), `${f.status ?? ""} ${f.tagsText} ${f.rel}`) : 1;
				let tier: number | null = pathTier;
				if (wordScore > 0) {
					const titleTier = wordScore >= 4 ? 1.5 : 2.5;
					tier = tier === null ? titleTier : Math.min(tier, titleTier);
				}
				if (tier !== null) ranked.push({ item: f, tier, script: isScript(f.rel) });
			}
			ranked.sort(
				(a, b) =>
					a.tier - b.tier ||
					Number(b.script) - Number(a.script) ||
					a.item.rel.length - b.item.rel.length ||
					(a.item.rel < b.item.rel ? -1 : a.item.rel > b.item.rel ? 1 : 0),
			);

			// `file#heading`: expand matching Markdown headings directly so Enter lands on that section!
			if (asked.heading) {
				const headingQ = asked.heading;
				const headingLower = headingQ.toLowerCase();
				const expanded: Item[] = [];
				const mdFiles = ranked.filter(({ item }) => isMarkdown(item.path)).slice(0, 30);
				for (const { item: f } of mdFiles) {
					const headings = f.doc?.headings ?? [];
					if (headings.length) {
						const matching = headings
							.map((h) => {
								const tLower = h.text.toLowerCase();
								const sLower = h.slug.toLowerCase();
								const score =
									tLower === headingLower || sLower === headingLower
										? 100
										: tLower.startsWith(headingLower) || sLower.startsWith(headingLower)
											? 80
											: matchWords(headingQ, h.text, h.slug);
								return { h, score };
							})
							.filter((x) => x.score > 0)
							.sort((a, b) => b.score - a.score || a.h.line - b.h.line);
						for (const { h } of matching) {
							expanded.push({
								label: `${f.title || baseName(f.path)} › ${h.text}`,
								detail: `H${h.level} · line ${h.line} · ${f.rel}`,
								file: baseName(f.path),
								run: () => void openFile(f.path, { reveal: { line: h.line, column: 1 }, keep: true }),
							});
							if (expanded.length >= 100) break;
						}
					} else {
						// Unindexed Markdown file (e.g. README.md or outside docs/): resolve heading after opening.
						expanded.push({
							label: `${f.title || baseName(f.path)} #${headingQ}`,
							detail: f.rel,
							file: baseName(f.path),
							run: () =>
								void (async () => {
									await openFile(f.path, { keep: true });
									const open = documents.get(canonical(f.path));
									const line = open ? findHeadingLine(open.model.getValue(), headingQ) : null;
									if (line) await openFile(f.path, { reveal: { line, column: 1 }, keep: true });
								})(),
						});
					}
					if (expanded.length >= 100) break;
				}
				return expanded;
			}

			return ranked.slice(0, 200).map(({ item: f }) => ({
				label: f.title || baseName(f.path),
				detail: [f.status, f.tags.length ? f.tags.slice(0, 2).map((t) => `#${t}`).join(" ") : "", f.rel].filter(Boolean).join(" · "),
				file: baseName(f.path),
				run: () => void openFile(f.path, asked.at ? { reveal: asked.at, keep: true } : { keep: true }),
			}));
		}

		if (mode() === "help") {
			return [
				{
					label: "A file's name",
					detail: "Go to a file; :12 for line, #Heading for section, tag:/status:/type: to filter",
					stay: true,
					run: () => setText(""),
				},
				...QUICK_PREFIXES.filter((each) => each.mode !== "help").map((each) => ({
					label: each.prefix,
					detail: each.says,
					stay: true,
					run: () => setText(each.prefix),
				})),
			];
		}

		if (mode() === "line") {
			const path = activeDoc()?.binary ? null : activePath();
			const at = path ? lineAsked(query(), activeDoc()?.model.getLineCount() ?? 1) : null;
			return path && at ? [{ label: `Go to line ${at.line}${at.column > 1 ? `, column ${at.column}` : ""}`, detail: rel(path), run: () => void openFile(path, { reveal: at }) }] : [];
		}

		if (mode() === "outline") {
			const path = activePath();
			const doc = activeDoc();
			if (!path || !doc || doc.binary) return [];
			const q = query().trim();

			if (isMarkdown(path)) {
				const list = mdSections().length ? mdSections() : markdownSectionTree(doc.model.getValue());
				return flatSections(list)
					.filter(({ section, inside }) => !q || matchWords(q, section.text, `${inside} ${section.slug}`) > 0)
					.map(({ section, inside }) => {
						const tasks = section.tasksTotal > 0 ? `${section.tasksDone}/${section.tasksTotal} · ` : "";
						return {
							label: section.text,
							detail: `${inside ? `${inside} · ` : ""}H${section.level} · ${tasks}line ${section.line}`,
							run: () => {
								const liveInfo = mdOutline();
								if (markdownMode(path) !== "source" && liveInfo && canonical(liveInfo.path) === canonical(path)) {
									const hit = liveInfo.headings.find((h) => h.line === section.line) ?? liveInfo.headings.find((h) => h.id === section.slug);
									if (hit) {
										liveInfo.goTo(hit.id);
										return;
									}
								}
								void openFile(path, { reveal: { line: section.line, column: 1 } });
							},
						};
					});
			}

			if (isTable(path) || doc.model.getLanguageId() === "csv") {
				const cols = csvColumns().length ? csvColumns() : csvColumnOutline(doc.model.getValue());
				return cols
					.filter((c) => !q || matchWords(q, c.name, c.sampleType) > 0)
					.map((c) => ({
						label: c.name,
						detail: `${c.nonEmpty}/${c.totalRows} non-empty · ${c.distinct} distinct · ${c.sampleType}`,
						run: () => {
							if (jumpToTableColumn(c.index)) return;
							const table = parseCsv(doc.model.getValue());
							const cell = table.header[c.index];
							void openFile(path, { reveal: { line: 1, column: cell ? cell.start + 1 : 1 } });
						},
					}));
			}

			if (isPlanPath(path)) {
				const stages = planStages().length ? planStages() : planStageOutline(doc.model.getValue());
				const rows: Item[] = [];
				for (const stage of stages) {
					if (!stage.ungrouped && (!q || matchWords(q, stage.name, "stage") > 0)) {
						rows.push({
							label: stage.name,
							detail: `stage · ${stage.nodes.length} ${stage.nodes.length === 1 ? "step" : "steps"} · line ${stage.line}`,
							run: () => {
								const targetLine = stage.nodes[0]?.line ?? stage.line;
								setState((s) => {
									s.cursor = { line: targetLine, column: 1 };
								});
								void openFile(path, { reveal: { line: targetLine, column: 1 } });
							},
						});
					}
					for (const node of stage.nodes) {
						if (q && matchWords(q, node.text, `${stage.name} ${node.kind} ${node.ref ?? ""}`) <= 0) continue;
						rows.push({
							label: node.text,
							detail: `${stage.name} · ${node.kind} · line ${node.line}`,
							run: () => {
								setState((s) => {
									s.cursor = { line: node.line, column: 1 };
								});
								void openFile(path, { reveal: { line: node.line, column: 1 } });
							},
						});
					}
				}
				return rows;
			}

			return flat(fileSymbols())
				.filter((each) => !q || matchWords(q, each.symbol.name, each.inside) > 0)
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
				detail: keysShownFor(c.id),
				note: c.detail,
				divide: !searching && recent > 0 && i === recent,
				run: () => runCommand(c.id, { remember: true }),
			}));
		}

		// Workspace `#` mode: tagged docs (so `#tag` is never a dead end), code symbols, workspace Markdown headings, docs & ticket companion files.
		const q = query().trim();
		const qLower = q.toLowerCase();
		const activeDocs = docs().filter((d) => d.exists && !isCatalog(d));

		const taggedDocPaths = new Set<string>();
		const taggedDocsRanked: { doc: DocFile; tag: string; exact: boolean }[] = [];
		if (qLower && !/\s/.test(qLower)) {
			for (const d of activeDocs) {
				if (!d.tags?.length) continue;
				const exact = d.tags.find((t) => t.toLowerCase() === qLower);
				const prefix = !exact && qLower.length >= 2 ? d.tags.find((t) => t.toLowerCase().startsWith(qLower)) : undefined;
				const hitTag = exact ?? prefix;
				if (hitTag) {
					taggedDocPaths.add(canonical(d.path));
					taggedDocsRanked.push({ doc: d, tag: hitTag, exact: Boolean(exact) });
				}
			}
			taggedDocsRanked.sort((a, b) => Number(b.exact) - Number(a.exact) || a.tag.localeCompare(b.tag) || docDisplayTitle(a.doc).localeCompare(docDisplayTitle(b.doc)));
		}
		const taggedDocItems: Item[] = taggedDocsRanked.slice(0, 30).map(({ doc: d, tag }) => ({
			label: docDisplayTitle(d),
			detail: [`#${tag}`, d.status, rel(d.path)].filter(Boolean).join(" · "),
			file: baseName(d.path),
			run: () => void openFile(d.path, { keep: true }),
		}));

		const codeSymbols: Item[] = symbolsFor(symbols(), query()).slice(0, 150).map((s) => {
			const path = monaco.Uri.parse(s.location.uri).fsPath;
			const r = s.location.range;
			return {
				label: s.name,
				detail: `${s.containerName ? s.containerName + " · " : ""}${rel(path)}`,
				run: () => void openFile(path, { reveal: { line: r.start.line + 1, column: r.start.character + 1 } }),
			};
		});

		// Workspace Markdown `doc.headings` jump (`doc.title › Heading`).
		const headingItems: Item[] = [];
		if (q) {
			const rankedHeadings: { doc: DocFile; title: string; h: NonNullable<DocFile["headings"]>[number]; score: number }[] = [];
			for (const d of activeDocs) {
				if (!d.headings?.length) continue;
				const title = docDisplayTitle(d);
				for (const h of d.headings) {
					const hLower = h.text.toLowerCase();
					const sLower = h.slug.toLowerCase();
					const score =
						hLower === qLower || sLower === qLower
							? 100
							: hLower.startsWith(qLower) || sLower.startsWith(qLower)
								? 80
								: matchWords(q, h.text, `${title} ${h.slug}`);
					if (score > 0) rankedHeadings.push({ doc: d, title, h, score });
				}
			}
			rankedHeadings.sort((a, b) => b.score - a.score || a.h.level - b.h.level || a.title.localeCompare(b.title));
			for (const { doc: d, title, h } of rankedHeadings.slice(0, 60)) {
				headingItems.push({
					label: `${title} › ${h.text}`,
					detail: `H${h.level} · line ${h.line} · ${rel(d.path)}`,
					file: baseName(d.path),
					run: () => void openFile(d.path, { reveal: { line: h.line, column: 1 }, keep: true }),
				});
			}
		}

		// Project documents (tickets, specs, plans, decisions, questions, schemas, registries).
		const docItems: Item[] = activeDocs
			.filter((d) => !taggedDocPaths.has(canonical(d.path)))
			.filter(
				(d) =>
					!q ||
					matchWords(
						q,
						`${d.ticket ?? ""} ${d.title ?? ""} ${d.heading ?? ""}`,
						`${d.group === "registries" ? registryTitle(d.name) : d.name} ${d.summary ?? ""} ${(d.tags ?? []).map((t) => `#${t}`).join(" ")}`,
					) > 0,
			)
			.slice(0, 50)
			.map((d) => ({
				label: docDisplayTitle(d),
				detail: `${d.status ? `${d.status} · ` : ""}${rel(d.path)}`,
				file: baseName(d.path),
				run: () => void openFile(d.path, { keep: true }),
			}));

		const ticketFileItems: Item[] = [];
		for (const d of activeDocs) {
			if (d.group !== "tickets" || !d.ticketFiles?.length) continue;
			for (const tf of d.ticketFiles) {
				if (q && matchWords(q, baseName(tf.path), `${d.ticket ?? ""} ${tf.rel}`) <= 0) continue;
				ticketFileItems.push({
					label: baseName(tf.path),
					detail: `${d.ticket ? `${d.ticket} file · ` : ""}${rel(tf.path)}`,
					file: baseName(tf.path),
					run: () => void openFile(tf.path, { keep: true }),
				});
				if (ticketFileItems.length >= 25) break;
			}
			if (ticketFileItems.length >= 25) break;
		}
		return [...taggedDocItems, ...codeSymbols, ...headingItems, ...docItems, ...ticketFileItems];
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
	// Clamp selection reactively whenever the result list shrinks or changes.
	const maxIndex = createMemo(() => Math.max(0, items().length - 1));
	createEffect(
		() => maxIndex(),
		(max) => {
			setSelected((i) => Math.max(0, Math.min(i, max)));
		},
	);
	// Enter pressed while the list is still empty and loading picks once it arrives.
	const [pendingEnter, setPendingEnter] = createSignal(false);
	const loading = () => (mode() === "files" && files.loading) || (mode() === "symbols" && (symbolsPending() || symbols.loading));
	createEffect(
		() => (pendingEnter() && !loading() ? { pick: true as const, item: items()[selected()] } : { pick: false as const }),
		(next) => {
			if (next.pick) {
				setPendingEnter(false);
				pick(next.item);
			}
		},
	);
	/** What the list says when it has no rows: why, and what to do. */
	const status = () => {
		if (items().length) return "";
		if (loading()) return "Loading…";
		if (mode() === "files" && failed()) return failed();
		if (mode() === "files") return !state.workspace ? "Open a folder to go to its files." : query().trim() ? "No files match." : "This folder has no files.";
		if (mode() === "symbols") return !docs().length && state.lsp.state !== "running" ? "The language server is not running." : query().trim() ? "No symbols, headings, or tagged documents match." : "Type a symbol, #tag, heading, ticket key, or document title.";
		if (mode() === "outline") {
			const path = activePath();
			const doc = activeDoc();
			if (!path) return "Open a file to go to its outline.";
			if (query().trim()) return "Nothing in this file's outline matches.";
			if (isMarkdown(path)) return "This document has no headings.";
			if (isTable(path) || doc?.model.getLanguageId() === "csv") return "This table has no columns.";
			if (isPlanPath(path)) return "This plan has no stages or steps.";
			if (doc && hasOutline(doc.model.getLanguageId())) return "This file has no outline items.";
			if (state.lsp.state !== "running") return "The language server is not running.";
			return "This file has no symbols.";
		}
		if (mode() === "line") return !activePath() ? "Open a file to go to a line of it." : activeDoc()?.binary ? "The open file is not text: it has no lines to go to." : `Type a line number, 1 to ${activeDoc()?.model.getLineCount() ?? 1}; 12:5 is line 12, column 5.`;
		return "No commands match.";
	};
	const move = (by: number) => setSelected((i) => Math.max(0, Math.min(i + by, Math.max(0, items().length - 1))));
	// The selected row stays in view when the arrows take it past the edge.
	let list: HTMLDivElement | undefined;
	createEffect(
		() => [selected(), items()] as const,
		([index]) => {
			list?.children[index]?.scrollIntoView({ block: "nearest" });
		},
	);
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
		<Modal class="quickpick" top asked label={TITLES[mode()]} onClose={close}>
			<input
				data-autofocus
				role="combobox"
				aria-label={TITLES[mode()]}
				aria-expanded="true"
				aria-controls={listId}
				aria-autocomplete="list"
				aria-activedescendant={items().length ? `${listId}-${selected()}` : undefined}
				autocomplete="off"
				spellcheck="false"
				placeholder="A file's name (or #heading, tag:, status:, type:), or ? for help"
				value={text()}
				// What is typed after Enter was pressed is a new question: the Enter that was waiting for the list is let go.
				onInput={(e) => (setText(e.currentTarget.value), setSelected(0), setPendingEnter(false))}
				onKeyDown={(e) => {
					if (e.isComposing || e.keyCode === 229) return;
					if (e.key === "ArrowDown") (e.preventDefault(), move(1));
					else if (e.key === "ArrowUp") (e.preventDefault(), move(-1));
					else if (e.key === "PageDown") (e.preventDefault(), move(PAGE));
					else if (e.key === "PageUp") (e.preventDefault(), move(-PAGE));
					else if (e.key === "Enter") {
						e.preventDefault();
						e.stopPropagation();
						const current = items()[selected()];
						if (current) pick(current);
						else if (loading()) setPendingEnter(true);
					}
				}}
			/>
			<div class="items" role="listbox" id={listId} aria-label={TITLES[mode()]} ref={list}>
				<For each={items()}>
					{(item, i) => (
						<div
							class={["item", { selected: i() === selected(), "quick-noted": Boolean(item.note), "quick-divide": item.divide }]}
							role="option"
							id={`${listId}-${i()}`}
							aria-selected={i() === selected() ? "true" : "false"}
							onMouseMove={(e) => pointed(e, i())}
							onMouseDown={(e) => e.button === 0 && (e.preventDefault(), pick(item))}
						>
							<Show when={item.file}>{(name) => <FileMark name={name()} />}</Show>
							<span class="label">{item.label}</span>
							<span class={["detail", { "quick-keys": mode() === "commands" }]}>
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
