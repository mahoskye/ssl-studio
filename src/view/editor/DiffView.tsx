// A snapshot from local history against the current text, with restore.
import { onCleanup, onMount } from "solid-js";
import { monaco } from "./monaco";
import { documents, notify, setState, state } from "../state";

export function DiffView() {
	let host!: HTMLDivElement;
	onMount(() => {
		const diff = state.diffWith!;
		const doc = documents.get(diff.path);
		if (!doc) return setState("diffWith", null);
		const original = monaco.editor.createModel(diff.text, doc.model.getLanguageId());
		const editor = monaco.editor.createDiffEditor(host, { automaticLayout: true, readOnly: true, renderSideBySide: true, originalEditable: false });
		editor.setModel({ original, modified: doc.model });
		onCleanup(() => {
			editor.dispose();
			original.dispose();
		});
	});
	const restore = () => {
		const diff = state.diffWith!;
		const doc = documents.get(diff.path)!;
		// An edit, not a reload: undo brings the current text back.
		doc.model.pushEditOperations([], [{ range: doc.model.getFullModelRange(), text: diff.text }], () => null);
		setState("diffWith", null);
		notify("Snapshot restored into the editor. Save to keep it; undo to go back.");
	};
	return (
		<div class="diff">
			<div class="diff-bar">
				<span>
					Snapshot {new Date(Number(state.diffWith!.id.split("-")[0])).toLocaleString()} ← → current
				</span>
				<span class="spacer" />
				<button class="primary" onClick={restore}>
					Restore this snapshot
				</button>
				<button onClick={() => setState("diffWith", null)}>Close</button>
			</div>
			<div class="diff-host" ref={host} />
		</div>
	);
}
