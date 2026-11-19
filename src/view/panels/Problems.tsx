// Diagnostics from the language server for every open file, by file, then
// by rule.
import { Icon, type IconName } from "../Icon";
import { createEffect, For, on, Show } from "solid-js";
import { monaco } from "../editor/monaco";
import { diagnostics, type Diagnostic } from "../lsp/session";
import { openFile, state } from "../state";
import { relativeTo } from "../../shared/paths";
import { Row, RowGroup, Rows } from "./Rows";
import { serverDown } from "./server";
import { FileMark } from "../FileMark";

const MARK: (IconName | null)[] = [null, "error", "warning", "info", "circle-small-filled"];
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
			<Show when={MARK[props.severity]}>{(name) => <Icon name={name()} />}</Show>
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
									<FileMark name={rel(uri)} />
									<span class="label">{rel(uri)}</span>
									{/* How many of each: a file with one error among twenty notes says so at a glance. */}
									<span class="meta tally">
										<For each={[1, 2, 3, 4].filter((severity) => list.some((d) => d.severity === severity))}>
											{(severity) => (
												<span title={`${list.filter((d) => d.severity === severity).length} × ${SEVERITY[severity]!.toLowerCase()}`}>
													<SeverityMark severity={severity} /> {list.filter((d) => d.severity === severity).length}
												</span>
											)}
										</For>
									</span>
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
	let box: HTMLPreElement | undefined;
	// A new line is followed while the view is at the end; someone reading further up is left where they are.
	createEffect(
		on(
			() => state.output.length,
			() => {
				if (box && box.scrollHeight - box.scrollTop - box.clientHeight < 40) queueMicrotask(() => box && (box.scrollTop = box.scrollHeight));
			},
		),
	);
	return (
		<pre class="output" ref={box}>
			<Show when={state.output.length} fallback={<span class="output-empty">Nothing here yet. Output keeps what the app did and what went wrong: folders opened, the language server's and the agent's failures.</span>}>
				<For each={state.output}>
					{(line) => {
						// A line is its time, two spaces, and what happened.
						const cut = line.indexOf("  ");
						return (
							<div>
								<span class="output-time">{cut > 0 ? line.slice(0, cut) : ""}</span>
								{cut > 0 ? line.slice(cut) : line}
							</div>
						);
					}}
				</For>
			</Show>
		</pre>
	);
}
