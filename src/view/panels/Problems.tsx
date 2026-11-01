// Diagnostics from the language server for every open file, by file, then
// by rule.
import { For, Show } from "solid-js";
import { monaco } from "../editor/monaco";
import { diagnostics, type Diagnostic } from "../lsp/session";
import { openFile, state } from "../state";

const ICON = ["", "✖", "⚠", "ℹ", "·"];
const CLASS = ["", "error", "warning", "info", "hint"];

export const counts = () => {
	const c = { errors: 0, warnings: 0, other: 0 };
	for (const list of Object.values(diagnostics)) for (const d of list ?? []) d.severity === 1 ? c.errors++ : d.severity === 2 ? c.warnings++ : c.other++;
	return c;
};

export function Problems() {
	const files = () => Object.entries(diagnostics).filter(([, list]) => list?.length) as [string, Diagnostic[]][];
	const rel = (uri: string) => {
		const path = monaco.Uri.parse(uri).fsPath;
		return state.workspace ? path.slice(state.workspace.root.length + 1) : path;
	};
	return (
		<div class="problems">
			<Show when={files().length} fallback={<p class="hint">No problems in open files.</p>}>
				<For each={files()}>
					{([uri, list]) => (
						<>
							<div class="tree-row file-head">
								<span class="label">{rel(uri)}</span>
								<span class="meta">{list.length}</span>
							</div>
							<For each={[...list].sort((a, b) => a.severity - b.severity || a.line - b.line)}>
								{(d) => (
									<div class="tree-row" style={{ "padding-left": "22px" }} onClick={() => void openFile(monaco.Uri.parse(uri).fsPath, { reveal: { line: d.line, column: d.column, endLine: d.endLine, endColumn: d.endColumn } })}>
										<span class={`sev ${CLASS[d.severity]}`}>{ICON[d.severity]}</span>
										<span class="label">{d.message}</span>
										<Show when={d.code}>
											<span class="code">{d.code}</span>
										</Show>
										<span class="meta">
											{d.line}:{d.column}
										</span>
									</div>
								)}
							</For>
						</>
					)}
				</For>
			</Show>
		</div>
	);
}

export function Output() {
	return (
		<pre class="output">
			<For each={state.output}>{(line) => <div>{line}</div>}</For>
		</pre>
	);
}
