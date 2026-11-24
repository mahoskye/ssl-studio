// Diagnostics from the language server for every open file, by file, then
// by rule.
import { Icon, type IconName } from "../Icon";
import { createEffect, createMemo, createSignal, For, on, Show } from "solid-js";
import { monaco } from "../editor/monaco";
import { docAuditData } from "../docAudit";
import { diagnostics, type Diagnostic } from "../lsp/session";
import { canonical, openFile, state } from "../state";
import { docIssueCode, docIssueDedupKey } from "../../shared/contextMenu";
import { relativeTo } from "../../shared/paths";
import { Row, RowGroup, Rows } from "./Rows";
import { serverDown } from "./server";
import { FileMark } from "../FileMark";

const MARK: (IconName | null)[] = [null, "error", "warning", "info", "circle-small-filled"];
const CLASS = ["", "error", "warning", "info", "hint"];
/** What a severity mark means, in a word: read out, and shown on hover. */
export const SEVERITY = ["", "Error", "Warning", "Note", "Hint"];

function collectMergedProblems(): { uri: string; list: Diagnostic[] }[] {
	const byPath = new Map<string, { uri: string; list: Diagnostic[] }>();
	const seenKeys = new Set<string>();
	for (const [uri, list] of Object.entries(diagnostics)) {
		if (!list?.length) continue;
		const fsPath = canonical(monaco.Uri.parse(uri).fsPath);
		const entry = byPath.get(fsPath) ?? { uri, list: [] };
		for (const d of list) {
			entry.list.push(d);
			const key =
				d.line <= 1
					? `${fsPath}:${d.line}:${d.code ?? ""}:${d.message}`
					: d.column > 1
						? `${fsPath}:${d.line}:${d.column}:${d.code ?? ""}`
						: `${fsPath}:${d.line}:${d.code ?? ""}`;
			seenKeys.add(key);
		}
		byPath.set(fsPath, entry);
	}
	// Fold workspace-wide doc audit issues (broken #heading anchors, malformed YAML, ADR 0008 tables,
	// code citations, duplicate headings, schema drift, orphan & stale docs) into Problems under
	// `source: "docs"`, deduplicated against already-open file diagnostics.
	for (const issue of docAuditData().issues) {
		const fsPath = canonical(issue.path);
		const code = docIssueCode(issue.kind);
		const dedupKey = docIssueDedupKey(fsPath, issue);
		if (seenKeys.has(dedupKey)) continue;
		seenKeys.add(dedupKey);
		const uri = monaco.Uri.file(issue.path).toString();
		const entry = byPath.get(fsPath) ?? { uri, list: [] };
		entry.list.push({
			uri,
			line: issue.line,
			column: issue.column ?? 1,
			endLine: issue.line,
			endColumn: (issue.column ?? 1) + 1,
			severity: issue.level === "warn" ? 2 : 3,
			message: issue.message,
			code,
			source: "docs",
		});
		byPath.set(fsPath, entry);
	}
	return [...byPath.values()];
}

export const counts = () => {
	const c = { errors: 0, warnings: 0, other: 0 };
	for (const { list } of collectMergedProblems()) {
		for (const d of list) d.severity === 1 ? c.errors++ : d.severity === 2 ? c.warnings++ : c.other++;
	}
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

type ProblemsScope = "all" | "code" | "docs";
const [problemsScope, setProblemsScope] = createSignal<ProblemsScope>("all");

const isDocDiag = (uri: string, d: Diagnostic): boolean => {
	if (d.source === "docs") return true;
	const p = monaco.Uri.parse(uri).fsPath;
	return /\.(md|markdown|json|toml|xml|csv|tsv)$/i.test(p);
};

export function Problems() {
	const mergedFiles = createMemo(collectMergedProblems);

	const hasDocIssues = createMemo(() =>
		mergedFiles().some(({ uri, list }) => list.some((d) => isDocDiag(uri, d))),
	);
	const scopeCounts = createMemo(() => {
		let code = 0;
		let docsN = 0;
		for (const { uri, list } of mergedFiles()) {
			for (const d of list) {
				if (isDocDiag(uri, d)) docsN++;
				else code++;
			}
		}
		return { all: code + docsN, code, docs: docsN };
	});

	const files = createMemo(() => {
		const scope = problemsScope();
		const out: [string, Diagnostic[]][] = [];
		for (const { uri, list } of mergedFiles()) {
			const filtered =
				scope === "all"
					? list
					: scope === "docs"
						? list.filter((d) => isDocDiag(uri, d))
						: list.filter((d) => !isDocDiag(uri, d));
			if (filtered.length) out.push([uri, filtered]);
		}
		return out;
	});
	const rel = (uri: string) => {
		const path = monaco.Uri.parse(uri).fsPath;
		return relativeTo(state.workspace?.root, path);
	};
	return (
		<Rows class="problems" label="Problems in workspace">
			<Show when={hasDocIssues()}>
				<div class="problems-filter" role="tablist" aria-label="Filter problems by source">
					<button
						type="button"
						role="tab"
						aria-selected={problemsScope() === "all"}
						classList={{ active: problemsScope() === "all" }}
						onClick={() => setProblemsScope("all")}
					>
						All <span class="meta">{scopeCounts().all}</span>
					</button>
					<button
						type="button"
						role="tab"
						aria-selected={problemsScope() === "code"}
						classList={{ active: problemsScope() === "code" }}
						onClick={() => setProblemsScope("code")}
					>
						Code <span class="meta">{scopeCounts().code}</span>
					</button>
					<button
						type="button"
						role="tab"
						aria-selected={problemsScope() === "docs"}
						classList={{ active: problemsScope() === "docs" }}
						onClick={() => setProblemsScope("docs")}
					>
						Docs <span class="meta">{scopeCounts().docs}</span>
					</button>
				</div>
			</Show>
			<Show when={serverDown()}>
				<p class="hint warn">{serverDown()} Open files are not checked until it runs.</p>
			</Show>
			<Show
				when={files().length}
				fallback={
					<p class="hint">
						{problemsScope() === "code"
							? "No code problems in open files."
							: problemsScope() === "docs"
								? "No document problems found."
								: "No problems in open files or workspace documents."}
					</p>
				}
			>
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
										key={`${uri}#${d.line}:${d.column}:${d.code ?? ""}${d.line <= 1 ? `:${d.message}` : ""}`}
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
