// Built-in functions, classes and keywords from the language server's
// bundled reference, read through completion and hover on a scratch document.
import { createResource, createSignal, For, Show } from "solid-js";
import { monaco } from "../editor/monaco";
import { activeEditor } from "../editor/EditorGroup";
import { session } from "../lsp/session";
import { notify, state } from "../state";
import { focusRowsBelow, IconButton, Row, RowGroup, Rows } from "./Rows";
import { serverDown } from "./server";

type Entry = { label: string; kind: number; detail?: string; doc?: string };
const KINDS: Record<number, string> = { 3: "Functions", 2: "Methods", 7: "Classes", 14: "Keywords", 21: "Constants" };

async function loadReference(root: string): Promise<Entry[]> {
	const uri = monaco.Uri.file(`${root}/.ssl-studio/reference-scratch.ssl`).toString();
	session.client.notify("textDocument/didOpen", { textDocument: { uri, languageId: "ssl", version: 1, text: "\n" } });
	try {
		const result = await session.request("textDocument/completion", { textDocument: { uri }, position: { line: 0, character: 0 } });
		const items = (result?.items ?? result ?? []) as any[];
		return items
			.filter((i) => KINDS[i.kind])
			.map((i) => ({ label: i.label, kind: i.kind, detail: i.detail, doc: typeof i.documentation === "string" ? i.documentation : i.documentation?.value }))
			.sort((a, b) => a.label.localeCompare(b.label));
	} finally {
		session.client.notify("textDocument/didClose", { textDocument: { uri } });
	}
}

async function describe(entry: Entry, root: string): Promise<string> {
	if (entry.doc) return entry.doc;
	const uri = monaco.Uri.file(`${root}/.ssl-studio/reference-scratch.ssl`).toString();
	session.client.notify("textDocument/didOpen", { textDocument: { uri, languageId: "ssl", version: 1, text: entry.label } });
	try {
		const hover = await session.request("textDocument/hover", { textDocument: { uri }, position: { line: 0, character: 1 } });
		const contents = hover?.contents;
		return (Array.isArray(contents) ? contents : [contents]).map((c: any) => (typeof c === "string" ? c : c?.value ?? "")).join("\n\n");
	} catch {
		return entry.detail ?? "";
	} finally {
		session.client.notify("textDocument/didClose", { textDocument: { uri } });
	}
}

/** The server's words on a built-in, for an agent that asked. */
export const describeElement = (name: string, root: string) => describe({ label: name, kind: 3 }, root);

/** Plain rendering of the server's markdown: code fences and bold kept readable. */
function Markdown(props: { text: string }) {
	const parts = () => props.text.split(/```(?:\w+)?\n?/);
	return (
		<div class="markdown">
			<For each={parts()}>{(part, i) => (i() % 2 ? <pre>{part.trim()}</pre> : <p>{part.replace(/\*\*([^*]+)\*\*/g, "$1").replace(/`([^`]+)`/g, "$1").trim()}</p>)}</For>
		</div>
	);
}

export function Reference() {
	const [filter, setFilter] = createSignal("");
	const [open, setOpen] = createSignal<Entry | null>(null);
	const [reference, { refetch }] = createResource(
		() => state.lsp.state === "running" && state.workspace?.root,
		(root) => loadReference(root as string).then((entries) => ({ entries, error: "" }), (e) => ({ entries: [] as Entry[], error: String(e?.message ?? e) })),
	);
	const entries = () => reference()?.entries ?? [];
	const [details] = createResource(
		() => open() && state.workspace && ([open()!, state.workspace.root] as const),
		([entry, root]) => describe(entry, root).catch(() => entry.detail ?? ""),
	);
	const shown = () => entries().filter((e) => !filter() || e.label.toLowerCase().includes(filter().toLowerCase()));
	const insert = (label: string) => {
		const editor = activeEditor();
		if (!editor?.getModel()) return notify(`Open a file to insert ${label}.`);
		editor.focus();
		editor.trigger("reference", "type", { text: label });
	};
	/** Why the list is empty, and whether trying again can help. */
	const empty = (): { text: string; retry?: boolean } => {
		if (serverDown()) return { text: `${serverDown()} The reference comes from it.` };
		if (reference.loading && !entries().length) return { text: "Loading the reference…" };
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
					<div class="reference-detail" role="region" aria-label={`About ${entry().label}`}>
						<div class="reference-head">
							<strong>{entry().label}</strong>
							<span class="spacer" />
							<button title="Insert the name at the cursor" onClick={() => insert(entry().label)}>
								Insert
							</button>
							<IconButton label="Close the description" glyph="×" onClick={() => setOpen(null)} />
						</div>
						<Show when={!details.loading} fallback={<p class="hint">Loading the description…</p>}>
							<Show when={details()?.trim()} fallback={<p class="hint">The language server has no description of {entry().label}.</p>}>
								<Markdown text={details()!} />
							</Show>
						</Show>
					</div>
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
					<For each={Object.entries(KINDS)}>
						{([kind, title]) => (
							<Show when={shown().some((e) => e.kind === Number(kind))}>
								<RowGroup head={title}>
									<For each={shown().filter((e) => e.kind === Number(kind)).slice(0, 400)}>
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
