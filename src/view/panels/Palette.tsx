// Templates from the style profile, inserted at the cursor as snippets, and
// the snippets the project keeps in its knowledge base (ADR 0012), inserted
// as they are written.
import { createSignal, For, Show } from "solid-js";
import { snippetAsText, TEMPLATES, type Template } from "../../shared/houseStyle";
import { isCatalog } from "../../shared/projectDocs";
import type { DocFile } from "../../shared/protocol";
import { backend } from "../backend";
import { activeEditor } from "../editor/EditorGroup";
import { docs } from "../project";
import { notify, openFile } from "../state";
import { Row, RowGroup, Rows } from "./Rows";

export function insertTemplate(template: Template) {
	const editor = activeEditor();
	if (!editor?.getModel()) return notify("Open a file to insert a template.");
	editor.focus();
	const snippets = editor.getContribution("snippetController2") as unknown as { insert(text: string): void } | null;
	const position = editor.getPosition()!;
	const line = editor.getModel()!.getLineContent(position.lineNumber);
	// Templates start a line of their own.
	const body = template.body();
	snippets?.insert(line.trim() && position.column > 1 ? `\n${body}` : body);
}

/** What is shown under the list: a template, or a snippet the project keeps, with what it would insert. */
type Shown = { label: string; note?: string; text: string; path?: string };

/** The project's kept snippets: SQL and SSL in the knowledge base. */
export const keptSnippets = (): DocFile[] => docs().filter((d) => d.exists && d.group === "knowledge" && d.kind === "snippets" && !isCatalog(d));

const snippetText = (file: DocFile) => backend.read(file.path).then((f) => f.text);

/** Puts a kept snippet at the cursor, as it is written: a `$` in a query is a `$`, not a field to fill. */
export async function insertSnippet(file: DocFile) {
	const editor = activeEditor();
	const model = editor?.getModel();
	if (!editor || !model) return notify("Open a file to insert a snippet into. Its row's title says where it is kept.");
	let text: string;
	try {
		text = await snippetText(file);
	} catch (e: any) {
		return notify(`The snippet could not be read: ${e?.message ?? e}`, "error");
	}
	const position = editor.getPosition() ?? model.getFullModelRange().getEndPosition();
	const selection = editor.getSelection();
	const range = selection && !selection.isEmpty() ? selection : { startLineNumber: position.lineNumber, startColumn: position.column, endLineNumber: position.lineNumber, endColumn: position.column };
	// A snippet starts a line of its own, as a template does.
	const ownLine = model.getLineContent(range.startLineNumber).slice(0, range.startColumn - 1).trim() ? "\n" : "";
	editor.pushUndoStop();
	editor.executeEdits("snippet", [{ range, text: `${ownLine}${text.replace(/\r\n/g, "\n")}`, forceMoveMarkers: true }]);
	editor.pushUndoStop();
	editor.focus();
}

export function Palette() {
	const groups = () => [...new Set(TEMPLATES.map((t) => t.group))];
	/** The template or snippet the keyboard or the pointer is on: what it would insert is shown under the list. */
	const [shown, setShown] = createSignal<Shown | null>(null);
	const showTemplate = (t: Template) => void setShown({ label: t.label, note: t.note, text: snippetAsText(t.body()) });
	/** A snippet's text is read when it is pointed at: the row asked for last is the one shown. */
	let asked = "";
	const showSnippet = (file: DocFile) => {
		asked = file.path;
		const label = file.title || file.name;
		void snippetText(file).then(
			(text) => asked === file.path && setShown({ label, note: file.summary, text, path: file.path }),
			() => asked === file.path && setShown({ label, note: "It could not be read.", text: "", path: file.path }),
		);
	};
	const copy = async (text: string) => {
		const copied = (await backend.clipboard(text).catch(() => false)) || (await navigator.clipboard?.writeText(text).then(() => true, () => false));
		notify(copied ? "Copied." : "Could not reach the clipboard.", copied ? "info" : "error");
	};
	return (
		<div class="panel-body" data-panel="palette">
			<div class="panel-title">
				<span>Palette</span>
			</div>
			<p class="hint">Click a template or a kept snippet, or press Enter on it, to insert it at the cursor; or drag a template into the editor. Tab then moves between a template's fields.</p>
			<Rows label="Templates">
				<For each={groups()}>
					{(group) => (
						<RowGroup head={group}>
							<For each={TEMPLATES.filter((t) => t.group === group)}>
								{(t) => (
									<Row
										class="tree-row palette-item"
										key={t.id}
										draggable={true}
										onDragStart={(e) => e.dataTransfer?.setData("text/plain", snippetAsText(t.body()))}
										onActivate={() => insertTemplate(t)}
										onFocus={() => showTemplate(t)}
										onPoint={() => showTemplate(t)}
										title={`${t.label}: ${t.detail}${t.note ? ` (${t.note})` : ""}`}
									>
										<span class="label">{t.label}</span>
										<span class="meta">{t.detail}</span>
									</Row>
								)}
							</For>
						</RowGroup>
					)}
				</For>
				{/* What the project keeps for use: its own queries and pieces of SSL, from the knowledge base. */}
				<Show when={keptSnippets().length}>
					<RowGroup head="Kept in this project">
						<For each={keptSnippets()}>
							{(file) => (
								<Row class="tree-row palette-item kept" key={file.path} onActivate={() => void insertSnippet(file)} onFocus={() => showSnippet(file)} onPoint={() => showSnippet(file)} title={[file.title || file.name, file.summary, file.path].filter(Boolean).join("\n")}>
									<span class="label">{file.title || file.name}</span>
									<span class="meta">{/\.sql$/i.test(file.name) ? "SQL" : /\.(ssl|srvscr|ds)$/i.test(file.name) ? "SSL" : ""}</span>
								</Row>
							)}
						</For>
					</RowGroup>
				</Show>
			</Rows>
			{/* Always there, at one size: a preview that came and went would move the rows under the pointer. */}
			<div class="palette-preview" role="region" aria-label="What it inserts">
				<Show when={shown()} fallback={<p class="hint">Point at a template or a snippet, or move to it with the arrow keys, to see here what it inserts.</p>}>
					{(t) => (
						<>
							<div class="palette-preview-head">
								<strong>{t().label}</strong>
								<Show when={t().note}>
									<span class="hint">{t().note}</span>
								</Show>
								<Show when={t().path}>
									<span class="spacer" />
									<button class="link" title="Copy the snippet" onClick={() => void copy(t().text)}>
										Copy
									</button>
									<button class="link" title="Open the snippet's file, to change it" onClick={() => void openFile(t().path!)}>
										Open
									</button>
								</Show>
							</div>
							<pre>{t().text}</pre>
						</>
					)}
				</Show>
			</div>
		</div>
	);
}
