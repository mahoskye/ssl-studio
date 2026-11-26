// Built-in functions, classes and keywords from the language server's
// bundled reference, read through completion and hover on a scratch document.
import { createEffect, createMemo, createSignal, For, Show } from "solid-js";
import type { DocFile } from "../../shared/protocol";
import { createAsyncQuery } from "../asyncQuery";
import { Icon } from "../Icon";
import { monaco } from "../editor/monaco";
import { activeEditor } from "../editor/EditorGroup";
import { activeLiveEditor } from "../editor/liveBridge";
import { review } from "../editor/Review";
import { lspReadyEpoch, session } from "../lsp/session";
import { docs } from "../project";
import { activeDoc, notify, openFile, state } from "../state";
import { focusRowsBelow, IconButton, Row, RowGroup, Rows } from "./Rows";
import { docsFolderGlob, searchFor } from "./Search";
import { SectionSplitter } from "./SectionSplitter";
import { recall, remember } from "../graph/canvas";
import { followReplyLink, renderReply } from "../agent/markdown";
import { serverDown } from "./server";

import { matchingProjectDocsForReference } from "../../shared/editorDocHelpers";
export { matchingProjectDocsForReference };

type Entry = { label: string; kind: number; detail?: string; doc?: string };
/** The kinds of entry the server sends, in the order they are listed. Snippets (15) are the Palette's, not reference. */
const KINDS: [kind: number, title: string][] = [
	[3, "Functions"],
	[2, "Methods"],
	[7, "Classes"],
	[14, "Keywords"],
	[24, "Operators"],
	[6, "Predefined names"],
	[21, "Literals and status words"],
];
const LISTED = new Set(KINDS.map(([kind]) => kind));

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

async function loadReference(root: string): Promise<Entry[]> {
	await session.waitReady();
	const uri = nextReferenceScratchUri(root);
	session.client.notify("textDocument/didOpen", { textDocument: { uri, languageId: "ssl", version: 1, text: "\n" } });
	try {
		const result = await session.request("textDocument/completion", { textDocument: { uri }, position: { line: 0, character: 0 } });
		const items = (result?.items ?? result ?? []) as any[];
		return items
			.filter((i) => LISTED.has(i.kind))
			.map((i) => ({ label: i.label, kind: i.kind, detail: i.detail, doc: typeof i.documentation === "string" ? i.documentation : i.documentation?.value }))
			.sort((a, b) => a.label.localeCompare(b.label));
	} finally {
		session.client.notify("textDocument/didClose", { textDocument: { uri } });
	}
}

/**
 * The server's full words on an entry: its hover, which has the signature, each
 * parameter, what it returns, the errors it raises and its caveats. The line
 * the list came with stands in when the hover has nothing.
 */
async function describe(entry: Entry, root: string): Promise<string> {
	const short = () => [entry.detail ? `\`${entry.detail}\`` : "", entry.doc ?? ""].filter(Boolean).join("\n\n");
	let uri: string | null = null;
	try {
		await session.waitReady();
		uri = nextReferenceScratchUri(root);
		session.client.notify("textDocument/didOpen", { textDocument: { uri, languageId: "ssl", version: 1, text: entry.label } });
		const hover = await session.request("textDocument/hover", { textDocument: { uri }, position: { line: 0, character: 1 } });
		const contents = hover?.contents;
		const full = (Array.isArray(contents) ? contents : [contents]).map((c: any) => (typeof c === "string" ? c : c?.value ?? "")).join("\n\n");
		return full.trim() ? full : short();
	} catch {
		return short();
	} finally {
		if (uri) session.client.notify("textDocument/didClose", { textDocument: { uri } });
	}
}

/** The server's words on a built-in, for an agent that asked. */
export const describeElement = (name: string, root: string) => describe({ label: name, kind: 3 }, root);

export function Reference() {
	const [filter, setFilter] = createSignal("");
	const [open, setOpen] = createSignal<Entry | null>(null);
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
		([root]) => loadReference(root).then((entries) => ({ entries, error: "" }), (e) => ({ entries: [] as Entry[], error: String(e?.message ?? e) })),
	);
	const entries = () => reference()?.entries ?? [];
	const [details] = createAsyncQuery(
		() => {
			const cur = open();
			const root = state.workspace?.root;
			return cur && root ? ([cur, root, lspReadyEpoch()] as const) : false;
		},
		([entry, root]) => describe(entry, root).catch(() => entry.detail ?? ""),
	);
	const shown = () => entries().filter((e) => !filter() || e.label.toLowerCase().includes(filter().toLowerCase()));
	const relatedDocs = createMemo(() => {
		const cur = open();
		return cur ? matchingProjectDocsForReference(cur.label, docs()) : { snippets: [] as DocFile[], notes: [] as DocFile[] };
	});
	const findInDocs = (label: string) => {
		searchFor(label, { include: docsFolderGlob(), exclude: "" });
	};
	const findUsages = (label: string) => {
		searchFor(label, { wholeWord: true, include: "", exclude: "" });
	};
	const insert = (label: string) => {
		insertReferenceText(label);
	};
	/** Why the list is empty, and whether trying again can help. */
	const empty = (): { text: string; retry?: boolean } => {
		if (serverDown()) return { text: `${serverDown()} The reference comes from it.` };
		if ((reference.loading || (state.lsp.state === "running" && lspReadyEpoch() === 0)) && !entries().length) return { text: "Loading the reference…" };
		if (reference()?.error) return { text: `The reference could not be loaded: ${reference()!.error}`, retry: true };
		if (!entries().length) return { text: "The language server sent no reference entries.", retry: true };
		return { text: `No entry matches “${filter()}”. Clear the filter to see them all.` };
	};
	return (
		<div class="panel-body" data-panel="reference">
			<div class="panel-title">
				<span>Reference</span>
			</div>
			<input
				class="filter"
				data-autofocus=""
				aria-label="Filter the reference"
				placeholder={entries().length ? `Filter ${entries().length} entries` : "Filter"}
				value={filter()}
				onInput={(e) => setFilter(e.currentTarget.value)}
				onKeyDown={(e) => e.key === "ArrowDown" && focusRowsBelow(e.currentTarget) && e.preventDefault()}
			/>
			<Show when={open()}>
				{(entry) => (
					<>
						<div class="reference-detail" role="region" aria-label={`About ${entry().label}`} style={{ height: `${detailH()}px` }}>
							<div class="reference-head">
								<strong>{entry().label}</strong>
								<span class="spacer" />
								<button title="Insert the name at the cursor" onClick={() => insert(entry().label)}>
									Insert
								</button>
								<IconButton label="Close the description" icon="close" onClick={() => setOpen(null)} />
							</div>
							<div
								class="reference-actions"
								style={{
									display: "flex",
									"flex-wrap": "wrap",
									gap: "var(--space-2)",
									"margin-bottom": "var(--space-3)",
								}}
							>
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
							</div>
							<Show when={!details.loading} fallback={<p class="hint">Loading the description…</p>}>
								<Show when={details()?.trim()} fallback={<p class="hint">The language server has no description of {entry().label}.</p>}>
									{/* The server's own Markdown, cleaned like any other: lists of parameters and errors read as lists. */}
									<div
										class="md reference-doc"
										innerHTML={renderReply(details()!)}
										onClick={(e) => void followReplyLink(e)}
									/>
								</Show>
							</Show>
							<Show when={relatedDocs().snippets.length || relatedDocs().notes.length}>
								<div
									class="reference-project-links"
									style={{
										"margin-top": "var(--space-3)",
										"padding-top": "var(--space-3)",
										"border-top": "1px solid var(--border)",
										display: "flex",
										"flex-direction": "column",
										gap: "var(--space-2)",
									}}
								>
									<Show when={relatedDocs().snippets.length}>
										<div style={{ display: "flex", "flex-direction": "column", gap: "4px" }}>
											<span style={{ "font-size": "var(--text-xs)", "font-weight": "600", color: "var(--muted)", "text-transform": "uppercase", "letter-spacing": "0.04em" }}>
												Kept snippets
											</span>
											<For each={relatedDocs().snippets.slice(0, 6)}>
												{(doc) => (
													<button
														type="button"
														class="link"
														title={doc.summary ? `${doc.title || doc.name} — ${doc.summary}` : doc.name}
														onClick={() => void openFile(doc.path)}
														style={{
															display: "inline-flex",
															"align-items": "center",
															gap: "var(--space-2)",
															"text-align": "left",
															padding: "1px 0",
															"font-size": "var(--text-sm)",
														}}
													>
														<Icon name="notebook-template" />
														<span>{doc.title || doc.name}</span>
													</button>
												)}
											</For>
										</div>
									</Show>
									<Show when={relatedDocs().notes.length}>
										<div style={{ display: "flex", "flex-direction": "column", gap: "4px" }}>
											<span style={{ "font-size": "var(--text-xs)", "font-weight": "600", color: "var(--muted)", "text-transform": "uppercase", "letter-spacing": "0.04em" }}>
												Decisions &amp; reference notes
											</span>
											<For each={relatedDocs().notes.slice(0, 6)}>
												{(doc) => (
													<button
														type="button"
														class="link"
														title={doc.summary ? `${doc.title || doc.name} — ${doc.summary}` : doc.name}
														onClick={() => void openFile(doc.path)}
														style={{
															display: "inline-flex",
															"align-items": "center",
															gap: "var(--space-2)",
															"text-align": "left",
															padding: "1px 0",
															"font-size": "var(--text-sm)",
														}}
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
			<Show
				when={shown().length}
				fallback={
					<p class="hint">
						{empty().text}{" "}
						<Show when={empty().retry}>
							<button class="link" onClick={() => void refetch()}>
								Try again
							</button>
						</Show>
					</p>
				}
			>
				<Rows label="Reference entries">
					<For each={KINDS}>
						{([kind, title]) => (
							<Show when={shown().some((e) => e.kind === kind)}>
								<RowGroup head={title}>
									<For each={shown().filter((e) => e.kind === kind).slice(0, 400)}>
										{(e) => (
											<Row
												key={`${kind}:${e.label}`}
												selected={open()?.label === e.label && open()?.kind === e.kind}
												classList={{ selected: open()?.label === e.label && open()?.kind === e.kind }}
												onActivate={() => setOpen(e)}
												title={e.detail ? `${e.label}: ${e.detail}` : e.label}
											>
												<span class="label">{e.label}</span>
											</Row>
										)}
									</For>
								</RowGroup>
							</Show>
						)}
					</For>
				</Rows>
			</Show>
		</div>
	);
}
