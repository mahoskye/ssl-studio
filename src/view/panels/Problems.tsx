// Diagnostics from the language server for every open file, by file, then
// by rule.
import { For, Show } from "solid-js";
import { monaco } from "../editor/monaco";
import { diagnostics, type Diagnostic } from "../lsp/session";
import { openFile, state } from "../state";
import { relativeTo } from "../../shared/paths";
import { Row, RowGroup, Rows } from "./Rows";
import { serverDown } from "./server";

const ICON = ["", "✖", "⚠", "ℹ", "·"];
const CLASS = ["", "error", "warning", "info", "hint"];
/** What a severity mark means, in a word: read out, and shown on hover. */
export const SEVERITY = ["", "Error", "Warning", "Note", "Hint"];

export const counts = () => {
	const c = { errors: 0, warnings: 0, other: 0 };
	for (const list of Object.values(diagnostics)) for (const d of list ?? []) d.severity === 1 ? c.errors++ : d.severity === 2 ? c.warnings++ : c.other++;
	return c;
};

/** The mark for a severity, named for assistive tech. */
export function SeverityMark(props: { severity: number }) {
	return (
		<span class={`sev ${CLASS[props.severity]}`} role="img" aria-label={SEVERITY[props.severity]} title={SEVERITY[props.severity]}>
			{ICON[props.severity]}
		</span>
	);
}

export function Problems() {
	const files = () => Object.entries(diagnostics).filter(([, list]) => list?.length) as [string, Diagnostic[]][];
	const rel = (uri: string) => {
		const path = monaco.Uri.parse(uri).fsPath;
		return relativeTo(state.workspace?.root, path);
	};
	return (
		<Rows class="problems" label="Problems in open files">
			<Show when={serverDown()}>
				<p class="hint warn">{serverDown()} Open files are not checked until it runs.</p>
			</Show>
			<Show when={files().length} fallback={<p class="hint">No problems in open files.</p>}>
				<For each={files()}>
					{([uri, list]) => (
						<RowGroup
							headClass="tree-row file-head"
							title={monaco.Uri.parse(uri).fsPath}
							head={
								<>
									<span class="label">{rel(uri)}</span>
									<span class="meta">{list.length}</span>
								</>
							}
						>
							<For each={[...list].sort((a, b) => a.severity - b.severity || a.line - b.line)}>
								{(d) => (
									<Row
										class="tree-row problem"
										key={`${uri}#${d.line}:${d.column}:${d.code ?? ""}`}
										style={{ "padding-left": "22px" }}
										title={`${SEVERITY[d.severity]}: ${d.message}${d.code ? ` [${d.code}]` : ""} (line ${d.line}, column ${d.column})`}
										onActivate={() => void openFile(monaco.Uri.parse(uri).fsPath, { reveal: { line: d.line, column: d.column, endLine: d.endLine, endColumn: d.endColumn } })}
									>
										<SeverityMark severity={d.severity} />
										<span class="label">{d.message}</span>
										<Show when={d.code}>
											<span class="code">{d.code}</span>
										</Show>
										<span class="meta">
											{d.line}:{d.column}
										</span>
									</Row>
								)}
							</For>
						</RowGroup>
					)}
				</For>
			</Show>
		</Rows>
	);
}

export function Output() {
	return (
		<pre class="output">
			<For each={state.output}>{(line) => <div>{line}</div>}</For>
		</pre>
	);
}
