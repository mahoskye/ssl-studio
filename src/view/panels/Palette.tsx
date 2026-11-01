// Templates from the style profile, inserted at the cursor as snippets.
import { For } from "solid-js";
import { TEMPLATES, type Template } from "../../shared/houseStyle";
import { activeEditor } from "../editor/EditorGroup";
import { notify } from "../state";

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
		<div class="panel-body">
			<div class="panel-title">
				<span>Palette</span>
			</div>
			<p class="hint">Click to insert at the cursor. Tab moves between fields.</p>
			<div class="tree">
				<For each={groups()}>
					{(group) => (
						<>
							<div class="group-head">{group}</div>
							<For each={TEMPLATES.filter((t) => t.group === group)}>
								{(t) => (
									<div class="tree-row palette-item" draggable={true} onDragStart={(e) => e.dataTransfer?.setData("text/plain", t.body().replace(/\$\{\d+:([^}]*)\}|\$\d/g, "$1"))} onClick={() => insertTemplate(t)} title={t.detail}>
										<span class="label">{t.label}</span>
										<span class="meta">{t.detail}</span>
									</div>
								)}
							</For>
						</>
					)}
				</For>
			</div>
		</div>
	);
}
