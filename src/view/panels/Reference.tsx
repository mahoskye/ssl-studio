// Built-in functions, classes and keywords from the language server's
// bundled reference, read through completion and hover on a scratch document.
import { createResource, createSignal, For, Show } from "solid-js";
import { monaco } from "../editor/monaco";
import { activeEditor } from "../editor/EditorGroup";
import { session } from "../lsp/session";
import { state } from "../state";

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
	const [entries] = createResource(
		() => state.lsp.state === "running" && state.workspace?.root,
		(root) => loadReference(root as string).catch(() => []),
	);
	const [details] = createResource(
		() => open() && state.workspace && ([open()!, state.workspace.root] as const),
		([entry, root]) => describe(entry, root),
	);
	const shown = () => (entries() ?? []).filter((e) => !filter() || e.label.toLowerCase().includes(filter().toLowerCase()));
	return (
		<div class="panel-body">
			<div class="panel-title">
				<span>Reference</span>
			</div>
			<input class="filter" placeholder={`Filter ${entries()?.length ?? ""} entries`} value={filter()} onInput={(e) => setFilter(e.currentTarget.value)} />
			<Show when={open()}>
				{(entry) => (
					<div class="reference-detail">
						<div class="reference-head">
							<strong>{entry().label}</strong>
							<span class="spacer" />
							<button title="Insert at the cursor" onClick={() => activeEditor()?.trigger("reference", "type", { text: entry().label })}>
								Insert
							</button>
							<button onClick={() => setOpen(null)}>×</button>
						</div>
						<Show when={details()} fallback={<p class="hint">Loading…</p>}>
							<Markdown text={details()!} />
						</Show>
					</div>
				)}
			</Show>
			<div class="tree">
				<Show when={entries()?.length} fallback={<p class="hint">{state.lsp.state === "running" ? "Loading the reference…" : "The reference needs the language server."}</p>}>
					<For each={Object.entries(KINDS)}>
						{([kind, title]) => (
							<Show when={shown().some((e) => e.kind === Number(kind))}>
								<div class="group-head">{title}</div>
								<For each={shown().filter((e) => e.kind === Number(kind)).slice(0, 400)}>
									{(e) => (
										<div class="tree-row" classList={{ selected: open()?.label === e.label }} onClick={() => setOpen(e)} title={e.detail}>
											<span class="label">{e.label}</span>
										</div>
									)}
								</For>
							</Show>
						)}
					</For>
				</Show>
			</div>
		</div>
	);
}
