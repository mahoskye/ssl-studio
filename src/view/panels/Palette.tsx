// Templates from the style profile, inserted at the cursor as snippets.
import { For } from "solid-js";
import { snippetAsText, TEMPLATES, type Template } from "../../shared/houseStyle";
import { activeEditor } from "../editor/EditorGroup";
import { notify } from "../state";
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

export function Palette() {
	const groups = () => [...new Set(TEMPLATES.map((t) => t.group))];
	return (
		<div class="panel-body" data-panel="palette">
			<div class="panel-title">
				<span>Palette</span>
			</div>
			<p class="hint">Click a template, or press Enter on it, to insert it at the cursor; or drag it into the editor. Tab then moves between its fields.</p>
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
			</Rows>
		</div>
	);
}
