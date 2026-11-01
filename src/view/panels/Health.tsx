// The current script against the house style: size, procedures, findings.
import { For, Show } from "solid-js";
import { level } from "../../shared/houseStyle";
import { monaco } from "../editor/monaco";
import { diagnostics } from "../lsp/session";
import { size } from "../StatusBar";
import { activeDoc, activePath, setState, state } from "../state";
import { symbols } from "./Objects";
import { openStyleProfile } from "../StyleProfile";

const PROCEDURE = new Set([monaco.languages.SymbolKind.Function, monaco.languages.SymbolKind.Method]);

function procedures(list = symbols()): monaco.languages.DocumentSymbol[] {
	return list.flatMap((s) => (PROCEDURE.has(s.kind) ? [s] : procedures(s.children ?? [])));
}

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
	const procs = () => procedures().map((p) => ({ name: p.name, lines: p.range.endLineNumber - p.range.startLineNumber + 1 })).sort((a, b) => b.lines - a.lines);
	const Meter = (props: { label: string; value: number; limit: number; unit?: string; near?: number }) => (
		<div class="meter-row">
			<span>{props.label}</span>
			<span class={level(props.value, props.limit, props.near)}>
				{props.unit === "KB" ? (props.value / 1024).toFixed(1) : props.value} / {props.unit === "KB" ? props.limit / 1024 : props.limit} {props.unit ?? ""}
			</span>
			<div class="bar">
				<div class={`fill ${level(props.value, props.limit, props.near)}`} style={{ width: `${Math.min(100, (props.value / props.limit) * 100)}%` }} />
			</div>
		</div>
	);
	return (
		<div class="panel-body health">
			<div class="panel-title">
				<span>Health</span>
				<button title="Style profile" onClick={openStyleProfile}>
					⚙
				</button>
			</div>
			<Show when={activePath() && size()} fallback={<p class="hint">Open an SSL file.</p>}>
				<section>
					<h3>Size (decision 0006)</h3>
					<Meter label="Bytes" value={size()!.bytes} limit={limits().bytes} unit="KB" />
					<Meter label="Code lines" value={size()!.codeLines} limit={limits().codeLines} />
					<Meter label="History entries" value={size()!.historyEntries} limit={limits().historyEntries} near={1} />
				</section>
				<section>
					<h3>
						Procedures <span class="meta">{procs().length}</span>
					</h3>
					<For each={procs().slice(0, 8)}>
						{(p) => (
							<div class="meter-row compact">
								<span>{p.name}</span>
								<span class="meta">{p.lines} lines</span>
							</div>
						)}
					</For>
				</section>
				<section>
					<h3>
						Findings <span class="meta">{findings().length}</span>
					</h3>
					<Show when={byRule().length} fallback={<p class="hint">None.</p>}>
						<For each={byRule()}>
							{([rule, entry]) => (
								<div class="meter-row compact clickable" onClick={() => (setState("bottomView", "problems"), setState("settings", "layout", "bottom", true))}>
									<span class={`sev ${["", "error", "warning", "info", "hint"][entry.severity]}`}>{["", "✖", "⚠", "ℹ", "·"][entry.severity]}</span>
									<span class="label">{rule}</span>
									<span class="meta">{entry.count}</span>
								</div>
							)}
						</For>
					</Show>
				</section>
			</Show>
		</div>
	);
}
