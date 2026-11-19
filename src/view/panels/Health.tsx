// The project's documents and what the documents of the work need from
// someone, and the current script against the house style: size, procedures,
// findings.
import { For, Show } from "solid-js";
import { level } from "../../shared/houseStyle";
import { monaco } from "../editor/monaco";
import { diagnostics } from "../lsp/session";
import { size } from "../StatusBar";
import { activeDoc, activePath, openFile, setState, state } from "../state";
import { symbols } from "./Objects";
import { SeverityMark, SEVERITY } from "./Problems";
import { IconButton, Row, Rows } from "./Rows";
import { serverDown } from "./server";
import { openStyleProfile } from "../StyleProfile";
import { docs, setUpProject } from "../project";
import { checksSummary, docChecks, type DocCheck } from "../../shared/docChecks";
import { newTicket, updateCatalogs } from "../projectDocs";

const PROCEDURE = new Set([monaco.languages.SymbolKind.Function, monaco.languages.SymbolKind.Method]);

function procedures(list = symbols()): monaco.languages.DocumentSymbol[] {
	return list.flatMap((s) => (PROCEDURE.has(s.kind) ? [s] : procedures(s.children ?? [])));
}

/** How many of the longest procedures are listed. */
const LONGEST = 8;
const count = (n: number, one: string) => `${n} ${one}${n === 1 ? "" : "s"}`;

export function Health() {
	const limits = () => state.settings.limits;
	const findings = () => {
		const doc = activeDoc();
		return doc ? (diagnostics[doc.model.uri.toString()] ?? []) : [];
	};
	const byRule = () => {
		const map = new Map<string, { count: number; severity: number }>();
		for (const d of findings()) {
			const key = d.code ?? "(no code)";
			const entry = map.get(key) ?? { count: 0, severity: d.severity };
			entry.count++;
			entry.severity = Math.min(entry.severity, d.severity);
			map.set(key, entry);
		}
		return [...map].sort((a, b) => a[1].severity - b[1].severity || b[1].count - a[1].count);
	};
	const procs = () =>
		procedures()
			.map((p) => ({ name: p.name, line: p.selectionRange.startLineNumber, lines: p.range.endLineNumber - p.range.startLineNumber + 1 }))
			.sort((a, b) => b.lines - a.lines);
	/** Each procedure's length against the longest: the bars show where the script's weight is. */
	const share = (lines: number) => `${Math.max(3, Math.round((lines / Math.max(1, procs()[0]?.lines ?? 1)) * 100))}%`;
	const Meter = (props: { label: string; title?: string; value: number; limit: number; unit?: string; near?: number }) => (
		<div class="meter-row" title={props.title}>
			<span>{props.label}</span>
			<span class={level(props.value, props.limit, props.near)}>
				{props.unit === "KB" ? (props.value / 1024).toFixed(1) : props.value} / {props.unit === "KB" ? props.limit / 1024 : props.limit} {props.unit ?? ""}
			</span>
			<div class="bar">
				<div class={`fill ${level(props.value, props.limit, props.near)}`} style={{ width: `${Math.min(100, (props.value / props.limit) * 100)}%` }} />
			</div>
		</div>
	);
	/** What the tickets, specs, knowledge base and registries need from someone. */
	const checks = () => docChecks(docs());
	const hasWork = () => docs().some((d) => d.exists && (d.group === "tickets" || d.group === "specs" || d.group === "knowledge" || d.group === "registries"));
	const fixLabel = (check: DocCheck) => (check.fix?.kind === "catalogs" ? "Update" : "Start it");
	const fixTitle = (check: DocCheck) => (check.fix?.kind === "catalogs" ? "Write every catalog afresh from the documents in its folder" : check.fix?.kind === "ticket" ? `Start ${check.fix.key} as a ticket of its own` : "");
	const fix = (check: DocCheck) => (check.fix?.kind === "catalogs" ? void updateCatalogs() : check.fix?.kind === "ticket" ? void newTicket(check.fix.key, check.fix.related) : undefined);
	const fileState = (file: { exists: boolean; untouched?: boolean }) => (!file.exists ? "missing" : file.untouched ? "still the template text" : "written");
	return (
		<div class="panel-body health" data-panel="health">
			<div class="panel-title">
				<span>Health</span>
				<IconButton label="Style profile" title="Open the style profile" glyph="⚙" onClick={() => openStyleProfile()} />
			</div>
			<section>
				<h3>Project</h3>
				<Rows class="health-rows" role="listbox" label="The project's files">
					<For each={docs().filter((d) => d.group === "project")}>
						{(file) => (
							<Row
								class="meter-row compact clickable"
								key={file.name}
								title={file.exists ? `${file.name}: ${fileState(file)}. ${file.path}` : `${file.name} is missing. Click it, or press Enter on it, to create it.`}
								onActivate={() => (file.exists ? void openFile(file.path) : void setUpProject())}
							>
								<span>{file.name}</span>
								<Show when={file.exists && !file.untouched} fallback={<span class="meta warn">⚠ {file.exists ? "template" : "missing"}</span>}>
									<span class="meta">✓</span>
								</Show>
							</Row>
						)}
					</For>
				</Rows>
			</section>
			<Show when={hasWork()}>
				<section>
					<h3 title="The tickets, specs, knowledge base and registries under the docs folder: what is out of date, not written, or named and not there">
						Work <span class="meta">{checksSummary(checks()) || "in order"}</span>
					</h3>
					<Show when={checks().length} fallback={<p class="hint">Every catalog says what its folder holds, every registry reads as a table, and nothing is named that is not there.</p>}>
						<Rows class="health-rows" role="listbox" label="What the working documents need">
							<For each={checks()}>
								{(check) => (
									<Row class="check-row clickable" key={check.text} label={check.text} title={`${check.text}\nClick it, or press Enter on it, to open the document.`} onActivate={() => void openFile(check.path)}>
										<span class={`check-mark ${check.level}`} aria-hidden="true">
											{check.level === "warn" ? "⚠" : "•"}
										</span>
										<span class="label">{check.text}</span>
										<Show when={check.fix}>
											<button class="link" title={fixTitle(check)} onClick={(e) => (e.stopPropagation(), fix(check))}>
												{fixLabel(check)}
											</button>
										</Show>
									</Row>
								)}
							</For>
						</Rows>
					</Show>
				</section>
			</Show>
			<Show when={activePath() && size()} fallback={<p class="hint">Open an SSL file to see its size, procedures and findings.</p>}>
				<section>
					<h3 title="The house limits for one script (program decision 0006)">Size limits</h3>
					<Meter label="Bytes" value={size()!.bytes} limit={limits().bytes} unit="KB" />
					<Meter label="Code lines" value={size()!.codeLines} limit={limits().codeLines} />
					<Meter
						label="Banner changes"
						title="Modification entries in the file's banner, against the house limit (program decision 0006). These are not the snapshots in Local history."
						value={size()!.historyEntries}
						limit={limits().historyEntries}
						near={1}
					/>
				</section>
				<section>
					<h3>
						Procedures <span class="meta">{procs().length}</span>
					</h3>
					<Show when={procs().length > LONGEST}>
						<p class="hint">The {LONGEST} longest:</p>
					</Show>
					<Rows class="health-rows" role="listbox" label="The longest procedures">
						<For each={procs().slice(0, LONGEST)}>
							{(p) => (
								<Row
									class="meter-row sized clickable"
									key={p.name}
									label={`${p.name}, ${count(p.lines, "line")}`}
									title={`${p.name}: ${count(p.lines, "line")}. Click it, or press Enter on it, to go to it.`}
									onActivate={() => activePath() && void openFile(activePath()!, { reveal: { line: p.line } })}
								>
									<span class="label">{p.name}</span>
									<span class="meta">{count(p.lines, "line")}</span>
									<span class="bar" aria-hidden="true">
										<span class="fill plain" style={{ width: share(p.lines) }} />
									</span>
								</Row>
							)}
						</For>
					</Rows>
				</section>
				<section>
					<h3>
						Findings <span class="meta">{findings().length}</span>
					</h3>
					<Show when={byRule().length} fallback={<p class="hint">{serverDown() ? `${serverDown()} This file is not checked until it runs.` : "No findings in this file."}</p>}>
						<Rows class="health-rows" role="listbox" label="Findings in this file, by rule">
							<For each={byRule()}>
								{([rule, entry]) => (
									<Row
										class="meter-row compact clickable"
										key={rule}
										label={rule}
										title={`${rule}: ${count(entry.count, "finding")} (${SEVERITY[entry.severity]!.toLowerCase()}). Click, or press Enter, to see them in Problems.`}
										onActivate={() => (setState("bottomView", "problems"), setState("settings", "layout", "bottom", true))}
									>
										<SeverityMark severity={entry.severity} />
										<span class="label">{rule}</span>
										<span class="meta">{entry.count}</span>
									</Row>
								)}
							</For>
						</Rows>
					</Show>
				</section>
			</Show>
		</div>
	);
}
