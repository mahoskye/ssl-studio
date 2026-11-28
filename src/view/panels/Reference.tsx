// Categorized SSL Reference panel: live built-ins, classes, obtained objects,
// keywords, operators, types, literals, and special forms from starlims-lsp
// (ADR 0003), organized by the published STARLIMS SSL Reference taxonomy
// (https://mahoskye.github.io/starlims-ssl-reference/) with direct links to
// full documentation, examples, and conceptual guides.
import { createEffect, createMemo, createSignal, For, Show } from "solid-js";
import type { DocFile } from "../../shared/protocol";
import {
	buildReferenceEntries,
	filterReferenceEntries,
	groupReferenceTree,
	LISTED_LSP_COMPLETION_KINDS,
	matchingGuides,
	REFERENCE_GUIDES,
	REFERENCE_SECTION_MAP,
	REFERENCE_SECTIONS,
	REFERENCE_SITE_URL,
	referenceUrl,
	relatedGuidesForEntry,
	type LspReferenceCompletion,
	type ReferenceEntry,
	type ReferenceSectionId,
} from "../../shared/referenceCatalog";
import { createAsyncQuery } from "../asyncQuery";
import { Icon, type IconName } from "../Icon";
import { Menu, type MenuItem } from "../Menu";
import { monaco } from "../editor/monaco";
import { activeEditor } from "../editor/EditorGroup";
import { activeLiveEditor } from "../editor/liveBridge";
import { review } from "../editor/Review";
import { lspReadyEpoch, session } from "../lsp/session";
import { docs } from "../project";
import { activeDoc, notify, openFile, state } from "../state";
import { focusRowsBelow, IconButton } from "./Rows";
import { docsFolderGlob, searchFor } from "./Search";
import { SectionSplitter } from "./SectionSplitter";
import { recall, remember } from "../graph/canvas";
import { followReplyLink, renderReply } from "../agent/markdown";
import { serverDown, serverSilent } from "./server";

import { matchingProjectDocsForReference } from "../../shared/editorDocHelpers";
export { matchingProjectDocsForReference };

const SECTION_ICON: Record<ReferenceSectionId, IconName> = {
	functions: "symbol-method",
	classes: "symbol-class",
	returns: "symbol-structure",
	keywords: "symbol-key",
	operators: "symbol-event",
	types: "symbol-namespace",
	literals: "symbol-constant",
	"special-forms": "code",
	globals: "symbol-variable",
};

function openReferenceUrl(url: string) {
	if (!/^https?:\/\//i.test(url)) return;
	window.open(url, "_blank", "noopener,noreferrer");
}

let refScratchSeq = 0;

/** Allocates a unique scratch document URI so concurrent Reference requests never collide or close each other's buffer. */
export function nextReferenceScratchUri(root: string): string {
	return monaco.Uri.file(`${root}/.ssl-studio/reference-scratch-${++refScratchSeq}.ssl`).toString();
}

/** Clamps a recalled splitter height into `[min, max]`, falling back when missing or non-numeric. */
export function clampReferenceHeight(raw: string | null, min = 100, max = 520, fallback = 220): number {
	if (raw === null || raw.trim() === "") return fallback;
	const n = Number(raw);
	return Number.isFinite(n) ? Math.max(min, Math.min(max, n)) : fallback;
}

/** Inserts a reference identifier into the active visible text editor (CM6 Live or visible Monaco), never into hidden/binary views. */
export function insertReferenceText(label: string): boolean {
	if (state.centerView !== "editors" || review()) {
		notify(`Switch to an editable text view to insert ${label}.`);
		return false;
	}
	const doc = activeDoc();
	if (!doc || doc.binary) {
		notify(`Open an editable text file to insert ${label}.`);
		return false;
	}
	const live = activeLiveEditor();
	if (live) {
		live.insertText(label);
		return true;
	}
	const editor = activeEditor();
	const model = editor?.getModel();
	if (!editor || !model || model.isDisposed() || !editor.getDomNode()?.offsetParent) {
		notify(`Switch to an editable text view to insert ${label}.`);
		return false;
	}
	editor.focus();
	editor.trigger("reference", "type", { text: label });
	return true;
}

async function loadReference(root: string): Promise<ReferenceEntry[]> {
	await session.waitReady();
	const uri = nextReferenceScratchUri(root);
	session.client.notify("textDocument/didOpen", { textDocument: { uri, languageId: "ssl", version: 1, text: "\n" } });
	try {
		const result = await session.request("textDocument/completion", { textDocument: { uri }, position: { line: 0, character: 0 } });
		const items = (result?.items ?? result ?? []) as any[];
		const lspItems: LspReferenceCompletion[] = items
			.filter((i) => LISTED_LSP_COMPLETION_KINDS.has(i.kind))
			.map((i) => ({
				label: i.label,
				kind: i.kind,
				detail: i.detail,
				doc: typeof i.documentation === "string" ? i.documentation : i.documentation?.value,
			}));
		return buildReferenceEntries(lspItems);
	} finally {
		session.client.notify("textDocument/didClose", { textDocument: { uri } });
	}
}

/**
 * The server's full words on an entry: its hover, which has the signature, each
 * parameter, what it returns, the errors it raises and its caveats. The line
 * the list came with stands in when the hover has nothing.
 */
async function describe(entry: Pick<ReferenceEntry, "label" | "detail" | "doc" | "hoverProbe">, root: string): Promise<string> {
	const short = () => [entry.detail ? `\`${entry.detail}\`` : "", entry.doc ?? ""].filter(Boolean).join("\n\n");
	const probe = entry.hoverProbe ?? { text: entry.label, line: 0, character: 1 };
	let uri: string | null = null;
	try {
		await session.waitReady();
		uri = nextReferenceScratchUri(root);
		session.client.notify("textDocument/didOpen", {
			textDocument: { uri, languageId: "ssl", version: 1, text: probe.text },
		});
		const hover = await session.request("textDocument/hover", {
			textDocument: { uri },
			position: { line: probe.line, character: probe.character },
		});
		const contents = hover?.contents;
		const full = (Array.isArray(contents) ? contents : [contents])
			.map((c: any) => (typeof c === "string" ? c : c?.value ?? ""))
			.join("\n\n");
		return full.trim() ? full : short();
	} catch {
		return short();
	} finally {
		if (uri) session.client.notify("textDocument/didClose", { textDocument: { uri } });
	}
}

/** The server's words on a built-in, for an agent that asked. */
export const describeElement = (name: string, root: string) =>
	describe({ label: name, hoverProbe: { text: name, line: 0, character: 1 } }, root);

export function Reference() {
	const [filter, setFilter] = createSignal("");
	const [sectionFilter, setSectionFilter] = createSignal<ReferenceSectionId | "all">("all");
	const [open, setOpen] = createSignal<ReferenceEntry | null>(null);
	// At rest, keep Functions expanded so its 17 domain categories are immediately scannable while other sections stay compact.
	const [openSections, setOpenSections] = createSignal<ReadonlySet<string>>(new Set(["functions"]));
	const [openCategories, setOpenCategories] = createSignal<ReadonlySet<string>>(new Set());

	const wsRoot = createMemo(() => state.workspace?.root);
	createEffect(
		() => wsRoot(),
		() => {
			setOpen(null);
		},
		{ defer: true },
	);

	const [detailH, setDetailH] = createSignal(clampReferenceHeight(recall("reference.detail.h"), 100, 520, 220));
	const resizeDetail = (delta: number) => {
		const next = Math.max(100, Math.min(520, detailH() + delta));
		setDetailH(next);
		remember("reference.detail.h", String(Math.round(next)));
	};
	const resetDetail = () => {
		setDetailH(220);
		remember("reference.detail.h", "220");
	};

	const [reference, { refetch }] = createAsyncQuery(
		() => {
			const epoch = lspReadyEpoch();
			const root = state.workspace?.root;
			return state.lsp.state === "running" && epoch > 0 && root ? ([root, epoch] as const) : false;
		},
		([root]) =>
			loadReference(root).then(
				(entries) => ({ entries, error: "" }),
				(e) => ({ entries: [] as ReferenceEntry[], error: String(e?.message ?? e) }),
			),
	);

	const entries = () => reference()?.entries ?? [];
	const isFiltering = () => Boolean(filter().trim()) || sectionFilter() !== "all";

	const [details] = createAsyncQuery(
		() => {
			const cur = open();
			const root = state.workspace?.root;
			return cur && root ? ([cur, root, lspReadyEpoch()] as const) : false;
		},
		([entry, root]) => describe(entry, root).catch(() => entry.detail ?? ""),
	);

	const sectionCounts = createMemo(() => {
		const counts: Record<ReferenceSectionId, number> = {
			functions: 0,
			classes: 0,
			returns: 0,
			keywords: 0,
			operators: 0,
			types: 0,
			literals: 0,
			"special-forms": 0,
			globals: 0,
		};
		for (const e of entries()) counts[e.section]++;
		return counts;
	});

	const shown = createMemo(() =>
		filterReferenceEntries(entries(), {
			query: filter(),
			section: sectionFilter(),
		}),
	);

	const tree = createMemo(() => groupReferenceTree(shown()));

	const visibleGuides = createMemo(() => {
		if (sectionFilter() !== "all") return [];
		return matchingGuides(filter());
	});

	const relatedDocs = createMemo(() => {
		const cur = open();
		return cur ? matchingProjectDocsForReference(cur.label, docs()) : { snippets: [] as DocFile[], notes: [] as DocFile[] };
	});

	const relatedGuides = createMemo(() => {
		const cur = open();
		return cur ? relatedGuidesForEntry(cur) : [];
	});

	const toggleSection = (id: string) => {
		setOpenSections((prev) => {
			const next = new Set(prev);
			if (next.has(id)) next.delete(id);
			else next.add(id);
			return next;
		});
	};

	const toggleCategory = (key: string) => {
		setOpenCategories((prev) => {
			const next = new Set(prev);
			if (next.has(key)) next.delete(key);
			else next.add(key);
			return next;
		});
	};

	const collapseAll = () => {
		setOpenSections(new Set<string>());
		setOpenCategories(new Set<string>());
	};

	const isSectionExpanded = (id: string) => isFiltering() || openSections().has(id);
	const isCategoryExpanded = (key: string) => Boolean(filter().trim()) || openCategories().has(key);

	const findInDocs = (label: string) => {
		searchFor(label, { include: docsFolderGlob(), exclude: "" });
	};
	const findUsages = (label: string) => {
		searchFor(label, { wholeWord: true, include: "", exclude: "" });
	};
	const insert = (label: string) => {
		insertReferenceText(label);
	};

	const sectionFilterMenuItems = (): MenuItem[] => {
		const counts = sectionCounts();
		const active = sectionFilter();
		const items: MenuItem[] = [
			{
				label: "All Sections",
				keys: entries().length ? String(entries().length) : undefined,
				checked: active === "all",
				run: () => setSectionFilter("all"),
			},
			"separator",
			...REFERENCE_SECTIONS.map((sec) => ({
				label: sec.label,
				keys: counts[sec.id] ? String(counts[sec.id]) : undefined,
				checked: active === sec.id,
				run: () => setSectionFilter(sec.id),
			})),
		];
		if (active !== "all") {
			items.push("separator", { label: "Clear Section Filter", run: () => setSectionFilter("all") });
		}
		return items;
	};

	const guidesMenuItems = (): MenuItem[] => [
		...REFERENCE_GUIDES.map((g) => ({
			label: g.title,
			run: () => openReferenceUrl(g.url),
		})),
		"separator",
		{
			label: "Open SSL Reference Home",
			run: () => openReferenceUrl(REFERENCE_SITE_URL),
		},
	];

	const breadcrumbOf = (entry: ReferenceEntry) => {
		const parts = [REFERENCE_SECTION_MAP[entry.section].label];
		if (entry.category && entry.category !== REFERENCE_SECTION_MAP[entry.section].label && entry.category !== "Core Types") {
			parts.push(entry.category);
		}
		if (entry.subcategory) parts.push(entry.subcategory);
		return parts.join(" › ");
	};

	/** Why the list is empty, and whether trying again can help. */
	const empty = (): { text: string; retry?: boolean } => {
		if (serverDown()) return { text: `${serverDown()} The reference comes from it.` };
		if (serverSilent() && !entries().length) return { text: `${serverSilent()} The reference comes from it.` };
		if ((reference.loading || (state.lsp.state === "running" && lspReadyEpoch() === 0)) && !entries().length) {
			return { text: "Loading the reference…" };
		}
		if (reference()?.error) return { text: `The reference could not be loaded: ${reference()!.error}`, retry: true };
		if (!entries().length) return { text: "The language server sent no reference entries.", retry: true };
		return { text: `No entry matches “${filter() || REFERENCE_SECTION_MAP[sectionFilter() as ReferenceSectionId]?.label}”.` };
	};

	const renderEntryRow = (e: ReferenceEntry) => {
		const selected = () => open()?.key === e.key;
		return (
			<div
				class={`ref-row${selected() ? " selected" : ""}`}
				role="treeitem"
				aria-selected={selected() ? "true" : "false"}
				tabindex={0}
				title={e.secondary ? `${e.label} — ${e.secondary}` : e.detail ? `${e.label}: ${e.detail}` : e.label}
				onClick={() => setOpen(e)}
				onKeyDown={(ev) => {
					if (ev.key === "Enter" || ev.key === " ") {
						ev.preventDefault();
						setOpen(e);
					}
				}}
			>
				<Icon name={SECTION_ICON[e.section]} class="ref-row-icon" />
				<span class="ref-row-label">{e.label}</span>
				<Show when={e.secondary}>
					<span class="ref-row-meta">{e.secondary}</span>
				</Show>
				<div class="ref-row-acts">
					<button
						type="button"
						class="ref-row-act"
						title={`Open ${e.label} on SSL Reference`}
						aria-label={`Open ${e.label} documentation online`}
						onClick={(ev) => {
							ev.stopPropagation();
							openReferenceUrl(e.docUrl);
						}}
					>
						<Icon name="globe" />
					</button>
				</div>
			</div>
		);
	};

	return (
		<div class="panel-body" data-panel="reference">
			<div class="panel-title">
				<span>Reference</span>
				<span class="spacer" />
				<div class="ref-head-acts">
					<Menu
						floating
						class="docs-filter-menu"
						label="SSL Reference Guides and Online Site"
						title="Open SSL Reference Guides & GitHub Pages site"
						items={guidesMenuItems}
					>
						<Icon name="book" />
					</Menu>
					<button
						type="button"
						class="ref-head-btn"
						data-ref-collapse-all="true"
						title="Collapse all sections"
						aria-label="Collapse all reference sections"
						onClick={collapseAll}
					>
						<Icon name="collapse-all" />
					</button>
					<Menu
						floating
						class={sectionFilter() !== "all" ? "docs-filter-menu on" : "docs-filter-menu"}
						label={sectionFilter() !== "all" ? `Filter section: ${REFERENCE_SECTION_MAP[sectionFilter() as ReferenceSectionId].label}` : "Filter by section"}
						title="Filter Reference by language section"
						items={sectionFilterMenuItems}
					>
						<Icon name={sectionFilter() !== "all" ? "filter-filled" : "filter"} />
					</Menu>
				</div>
			</div>

			<input
				class="filter"
				data-autofocus=""
				aria-label="Filter the reference"
				placeholder={entries().length ? `Filter ${entries().length} entries, categories, or guides…` : "Filter reference…"}
				value={filter()}
				onInput={(e) => setFilter(e.currentTarget.value)}
				onKeyDown={(e) => {
					if (e.key === "ArrowDown" && focusRowsBelow(e.currentTarget)) e.preventDefault();
					if (e.key === "Escape" && filter()) {
						e.preventDefault();
						setFilter("");
					}
				}}
			/>

			<Show when={sectionFilter() !== "all"}>
				<div class="docs-filter-chips ref-filter-chips" role="group" aria-label="Active Reference section filter">
					<button
						type="button"
						class="docs-tag-active"
						title="Clear section filter"
						onClick={() => setSectionFilter("all")}
					>
						<span>{REFERENCE_SECTION_MAP[sectionFilter() as ReferenceSectionId].label}</span>
						<Icon name="close" />
					</button>
				</div>
			</Show>

			<Show when={open()}>
				{(entry) => (
					<>
						<div class="reference-detail" role="region" aria-label={`About ${entry().label}`} style={{ height: `${detailH()}px` }}>
							<div class="reference-head">
								<Icon name={SECTION_ICON[entry().section]} class="ref-detail-icon" />
								<strong class="ref-detail-title">{entry().label}</strong>
								<span class="spacer" />
								<Show when={entry().insertText}>
									<button
										type="button"
										class="ref-insert-btn"
										title="Insert at the cursor"
										onClick={() => insert(entry().insertText!)}
									>
										Insert
									</button>
								</Show>
								<IconButton label="Close the description" icon="close" onClick={() => setOpen(null)} />
							</div>

							<div class="ref-breadcrumb">
								<span class="ref-crumb-pill">{breadcrumbOf(entry())}</span>
								<Show when={entry().secondary}>
									<span class="ref-crumb-meta">{entry().secondary}</span>
								</Show>
							</div>

							<div class="reference-actions">
								<button
									type="button"
									class="agent-ctx-chip"
									title={`Search project docs for ${entry().label}`}
									onClick={() => findInDocs(entry().label)}
								>
									<Icon name="search" />
									<span>Find in Docs</span>
								</button>
								<button
									type="button"
									class="agent-ctx-chip"
									title={`Find usages of ${entry().label} across the workspace`}
									onClick={() => findUsages(entry().label)}
								>
									<Icon name="references" />
									<span>Find usages</span>
								</button>
								<button
									type="button"
									class="agent-ctx-chip ref-docs-chip"
									data-ref-open-docs="true"
									title={`Open ${entry().docUrl}`}
									onClick={() => openReferenceUrl(entry().docUrl)}
								>
									<Icon name="globe" />
									<span>Full docs</span>
								</button>
							</div>

							<Show when={!details.loading} fallback={<p class="hint">Loading the description…</p>}>
								<Show
									when={details()?.trim()}
									fallback={
										<p class="hint">
											See full details, type behavior, and examples for <strong>{entry().label}</strong> on the{" "}
											<button type="button" class="link" onClick={() => openReferenceUrl(entry().docUrl)}>
												SSL Reference site
											</button>
											.
										</p>
									}
								>
									{/* The server's own Markdown, cleaned like any other: lists of parameters and errors read as lists. */}
									<div
										class="md reference-doc"
										innerHTML={renderReply(details()!)}
										onClick={(e) => void followReplyLink(e)}
									/>
								</Show>
							</Show>

							<Show when={relatedGuides().length > 0}>
								<div class="ref-related-block">
									<span class="ref-related-heading">Related guides</span>
									<div class="ref-related-list">
										<For each={relatedGuides()}>
											{(g) => (
												<button
													type="button"
													class="link ref-related-link"
													title={g.summary}
													onClick={() => openReferenceUrl(g.url)}
												>
													<Icon name="book" />
													<span>{g.title}</span>
												</button>
											)}
										</For>
									</div>
								</div>
							</Show>

							<Show when={relatedDocs().snippets.length || relatedDocs().notes.length}>
								<div class="reference-project-links">
									<Show when={relatedDocs().snippets.length}>
										<div class="ref-related-group">
											<span class="ref-related-heading">Kept snippets</span>
											<For each={relatedDocs().snippets.slice(0, 6)}>
												{(doc) => (
													<button
														type="button"
														class="link ref-related-link"
														title={doc.summary ? `${doc.title || doc.name} — ${doc.summary}` : doc.name}
														onClick={() => void openFile(doc.path)}
													>
														<Icon name="notebook-template" />
														<span>{doc.title || doc.name}</span>
													</button>
												)}
											</For>
										</div>
									</Show>
									<Show when={relatedDocs().notes.length}>
										<div class="ref-related-group">
											<span class="ref-related-heading">Decisions &amp; reference notes</span>
											<For each={relatedDocs().notes.slice(0, 6)}>
												{(doc) => (
													<button
														type="button"
														class="link ref-related-link"
														title={doc.summary ? `${doc.title || doc.name} — ${doc.summary}` : doc.name}
														onClick={() => void openFile(doc.path)}
													>
														<Icon name={doc.kind === "decisions" ? "lightbulb" : "note"} />
														<span>
															{doc.title || doc.name}
															{doc.status ? ` (${doc.status})` : ""}
														</span>
													</button>
												)}
											</For>
										</div>
									</Show>
								</div>
							</Show>
						</div>
						<SectionSplitter
							label="Height of the reference description"
							value={detailH()}
							min={100}
							max={520}
							onDrag={resizeDetail}
							onReset={resetDetail}
						/>
					</>
				)}
			</Show>

			<Show when={tree().length === 0}>
				<div class="ref-empty">
					<p class="hint">
						{empty().text}{" "}
						<Show when={empty().retry}>
							<button type="button" class="link" onClick={() => void refetch()}>
								Try again
							</button>
						</Show>
						<Show when={isFiltering() && entries().length > 0}>
							<button
								type="button"
								class="link"
								onClick={() => {
									setFilter("");
									setSectionFilter("all");
								}}
							>
								Clear filter
							</button>
						</Show>
					</p>
					<Show when={visibleGuides().length === 0}>
						<button type="button" class="link ref-empty-web" onClick={() => openReferenceUrl(REFERENCE_SITE_URL)}>
							<Icon name="globe" />
							<span>Browse SSL Reference online</span>
						</button>
					</Show>
				</div>
			</Show>

			<Show when={tree().length > 0 || visibleGuides().length > 0}>
				<div class="ref-tree" role="tree" aria-label="SSL Reference catalog">
					<For each={tree()}>
						{(sec) => {
							const expanded = () => isSectionExpanded(sec.meta.id);
							const singleFlatCategory = () => sec.categories.length === 1 && sec.categories[0]!.subcategories.length === 0 && (sec.meta.id === "types" || sec.meta.id === "literals");
							return (
								<div class="ref-sec" data-ref-section={sec.meta.id}>
									<div class="ref-sec-head-wrap">
										<button
											type="button"
											class="ref-sec-head"
											aria-expanded={expanded() ? "true" : "false"}
											title={sec.meta.description}
											onClick={() => toggleSection(sec.meta.id)}
										>
											<Icon name={expanded() ? "chevron-down" : "chevron-right"} class="ref-chev" />
											<Icon name={SECTION_ICON[sec.meta.id]} class="ref-sec-icon" />
											<span class="ref-sec-label">{sec.meta.label}</span>
											<span class="ref-count">{sec.total}</span>
										</button>
										<button
											type="button"
											class="ref-sec-web"
											title={`Open ${sec.meta.label} index on SSL Reference`}
											aria-label={`Open ${sec.meta.label} index online`}
											onClick={(ev) => {
												ev.stopPropagation();
												openReferenceUrl(referenceUrl(sec.meta.path));
											}}
										>
											<Icon name="globe" />
										</button>
									</div>

									<Show when={expanded()}>
										<div class="ref-sec-body" role="group">
											<Show
												when={!singleFlatCategory()}
												fallback={
													<For each={sec.categories[0]!.entries}>
														{(e) => renderEntryRow(e)}
													</For>
												}
											>
												<For each={sec.categories}>
													{(cat) => {
														const catOpen = () => isCategoryExpanded(cat.key);
														return (
															<div class="ref-cat" data-ref-category={cat.key}>
																<button
																	type="button"
																	class="ref-cat-head"
																	aria-expanded={catOpen() ? "true" : "false"}
																	onClick={() => toggleCategory(cat.key)}
																>
																	<Icon name={catOpen() ? "chevron-down" : "chevron-right"} class="ref-chev" />
																	<span class="ref-cat-label">{cat.label}</span>
																	<span class="ref-count subtle">{cat.total}</span>
																</button>
																<Show when={catOpen()}>
																	<div class="ref-cat-body" role="group">
																		<Show
																			when={cat.subcategories.length > 0}
																			fallback={
																				<For each={cat.entries}>
																					{(e) => renderEntryRow(e)}
																				</For>
																			}
																		>
																			<For each={cat.subcategories}>
																				{(sub) => (
																					<div class="ref-subcat">
																						<div class="ref-subcat-head">
																							<span>{sub.label}</span>
																							<span class="ref-count subtle">{sub.entries.length}</span>
																						</div>
																						<For each={sub.entries}>
																							{(e) => renderEntryRow(e)}
																						</For>
																					</div>
																				)}
																			</For>
																		</Show>
																	</div>
																</Show>
															</div>
														);
													}}
												</For>
											</Show>
											<Show when={sec.meta.id === "globals" && !filter().trim()}>
												<div class="ref-globals-note" data-ref-globals-note="true">
													<p>
														Only <code>Request</code> and <code>Response</code> here are platform objects; the rest are base v12{" "}
														<code>SystemInit</code> <code>:PUBLIC</code>s (customized installs may differ — check uncertain names
														with <code>IsDefined()</code>).
													</p>
													<p>
														<button
															type="button"
															class="link ref-note-link"
															onClick={() => openReferenceUrl(referenceUrl("guides/predefined-globals/#status-names"))}
														>
															Status names
														</button>{" "}
														(<code>Done</code>, <code>Logged</code>, <code>Released</code>, …) are installation-specific{" "}
														<code>:PUBLIC</code>s whose values may differ from their variable names.
													</p>
													<p>
														<button
															type="button"
															class="link ref-note-link"
															onClick={() => openReferenceUrl(referenceUrl("guides/predefined-globals/#names-that-are-not-predefined"))}
														>
															Not predefined on base v12:
														</button>{" "}
														<code>CR</code>, <code>LF</code>, <code>TAB</code>, <code>sTab</code>, <code>sDQ</code>,{" "}
														<code>sSQ</code>, <code>MYUSERID</code>, <code>MYLANGID</code>, <code>MYDEPT</code>,{" "}
														<code>MYSITE</code>.
													</p>
												</div>
											</Show>
										</div>
									</Show>
								</div>
							);
						}}
					</For>

					<Show when={visibleGuides().length > 0}>
						<div class="ref-sec" data-ref-section="guides">
							<div class="ref-sec-head-wrap">
								<button
									type="button"
									class="ref-sec-head"
									aria-expanded={isSectionExpanded("guides") ? "true" : "false"}
									title="Conceptual guides on the STARLIMS SSL Reference site"
									onClick={() => toggleSection("guides")}
								>
									<Icon name={isSectionExpanded("guides") ? "chevron-down" : "chevron-right"} class="ref-chev" />
									<Icon name="book" class="ref-sec-icon" />
									<span class="ref-sec-label">Guides</span>
									<span class="ref-count">{visibleGuides().length}</span>
								</button>
								<button
									type="button"
									class="ref-sec-web"
									title="Open STARLIMS SSL Reference home"
									aria-label="Open STARLIMS SSL Reference website"
									onClick={(ev) => {
										ev.stopPropagation();
										openReferenceUrl(REFERENCE_SITE_URL);
									}}
								>
									<Icon name="globe" />
								</button>
							</div>
							<Show when={isSectionExpanded("guides")}>
								<div class="ref-sec-body" role="group">
									<For each={visibleGuides()}>
										{(g) => (
											<button
												type="button"
												class="ref-row ref-guide-row"
												title={`${g.title} — ${g.summary}`}
												onClick={() => openReferenceUrl(g.url)}
											>
												<Icon name="book" class="ref-row-icon" />
												<span class="ref-row-label">{g.title}</span>
												<Icon name="globe" class="ref-guide-ext" />
											</button>
										)}
									</For>
								</div>
							</Show>
						</div>
					</Show>

					<div class="ref-site-foot">
						<button
							type="button"
							class="link ref-site-link"
							data-ref-site-link="true"
							title={REFERENCE_SITE_URL}
							onClick={() => openReferenceUrl(REFERENCE_SITE_URL)}
						>
							<Icon name="globe" />
							<span>STARLIMS SSL Reference (v11 / v12)</span>
						</button>
					</div>
				</div>
			</Show>
		</div>
	);
}
