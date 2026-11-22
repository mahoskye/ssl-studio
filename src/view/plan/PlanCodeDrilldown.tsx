// Collapsible developer code drill-down for a selected plan step/decision and
// for plan-level scripts/functions. Kept collapsed by default so business
// analysts and managers lead with plain process language, while developers can
// expand once to inspect implementing scripts, functions, called procedures,
// and live read-only SSL previews (all ranges from starlims-lsp, ADR 0003).
import { createEffect, createMemo, createSignal, For, Show } from "solid-js";
import { baseName, dirName } from "../../shared/paths";
import { Icon } from "../Icon";
import { IconButton } from "../panels/Rows";
import { nodeCodeDetails, type BuiltUnit } from "./built";
import { readProcedurePreview, type ProcedurePreview } from "./drift";
import type { Plan, PlanNode } from "./model";

type PreviewTarget = { name: string; script?: string; hintScript?: string; label: string };

const sigOf = (u: BuiltUnit) => `${u.name}(${(u.parameters ?? []).join(", ")})`;

export function NodeImplementation(props: {
	plan: Plan;
	planUri: string | undefined;
	node: PlanNode;
	open: boolean;
	onToggle: () => void;
	onOpenUnit: (unit: BuiltUnit) => void;
	onOpenRef: (ref: string) => void;
	onOpenScript: (script: string, line?: number) => void;
}) {
	const details = createMemo(() => nodeCodeDetails(props.plan, props.node));

	const summary = createMemo(() => {
		const d = details();
		if (d.units.length > 0) {
			const fnWord = d.units.length === 1 ? "function" : "functions";
			if (d.calls.length > 0) {
				const callWord = d.calls.length === 1 ? "call" : "calls";
				return `${d.units.length} ${fnWord}, ${d.calls.length} ${callWord}`;
			}
			return `${d.units.length} ${fnWord}`;
		}
		if (d.primaryRef) return "1 linked function";
		return "Not linked";
	});

	const defaultTarget = createMemo<PreviewTarget | null>(() => {
		const d = details();
		if (d.units[0]) return { name: d.units[0].name, script: d.units[0].script, label: d.units[0].name };
		if (d.primaryRef) return { name: d.primaryRef, label: d.primaryRef };
		return null;
	});

	const [pickedTarget, setPickedTarget] = createSignal<PreviewTarget | null>(null);
	const [preview, setPreview] = createSignal<ProcedurePreview | null>(null);
	const [loading, setLoading] = createSignal(false);
	const [missing, setMissing] = createSignal(false);

	// Reset custom call selection whenever the selected node changes.
	createEffect(() => {
		props.node.id;
		setPickedTarget(null);
	});

	const activeTarget = createMemo(() => pickedTarget() ?? defaultTarget());

	let fetchSeq = 0;
	createEffect(() => {
		const isOpen = props.open;
		const target = activeTarget();
		const uri = props.planUri;
		if (!isOpen || !target) {
			setPreview(null);
			setLoading(false);
			setMissing(false);
			return;
		}
		const seq = ++fetchSeq;
		setPreview(null);
		setLoading(true);
		setMissing(false);
		void readProcedurePreview(uri, { name: target.name, script: target.script, hintScript: target.hintScript }).then((res) => {
			if (seq !== fetchSeq) return;
			setLoading(false);
			setPreview(res);
			setMissing(!res);
		});
	});

	const isPreviewing = (name: string) => activeTarget()?.name.toLowerCase() === name.toLowerCase();

	return (
		<div class="plan-impl">
			<button
				type="button"
				class="plan-impl-toggle"
				aria-expanded={props.open}
				onClick={props.onToggle}
				title="Show or hide the scripts, functions, and code behind this step"
			>
				<Icon name={props.open ? "chevron-down" : "chevron-right"} />
				<span class="plan-impl-label">Implementation</span>
				<span class="spacer" />
				<span class="plan-impl-meta" classList={{ linked: details().units.length > 0 || Boolean(details().primaryRef) }}>
					{summary()}
				</span>
			</button>

			<Show when={props.open}>
				<div class="plan-impl-body">
					<Show
						when={details().units.length > 0}
						fallback={
							<Show when={!details().primaryRef}>
								<p class="plan-impl-empty">No code is linked to this step yet. Use the Assistant tab to generate a spec and build.</p>
							</Show>
						}
					>
						<div class="plan-impl-group">
							<span class="plan-impl-subhead">Implemented in</span>
							<For each={details().units}>
								{(unit) => {
									const file = () => baseName(unit.script);
									const folder = () => dirName(unit.script);
									return (
										<div class="plan-impl-card" classList={{ active: isPreviewing(unit.name) }}>
											<div class="plan-impl-card-row">
												<button
													type="button"
													class="plan-impl-fn"
													title={`Preview ${unit.name} below`}
													onClick={() => setPickedTarget({ name: unit.name, script: unit.script, label: unit.name })}
												>
													<Icon name="symbol-method" />
													<span>{sigOf(unit)}</span>
												</button>
												<IconButton
													label={`Open ${unit.name} in editor`}
													title={`Open ${unit.name} in ${unit.script} (G)`}
													icon="go-to-file"
													onClick={() => props.onOpenUnit(unit)}
												/>
											</div>
											<button
												type="button"
												class="plan-impl-script"
												title={`Open ${unit.script}`}
												onClick={() => props.onOpenUnit(unit)}
											>
												<Icon name="file" />
												<span class="plan-impl-script-file">{file()}</span>
												<Show when={folder()}>
													<span class="plan-impl-script-dir">{folder()}</span>
												</Show>
											</button>
											<Show when={unit.nodes.length > 1}>
												<span class="plan-impl-shared">Covers {unit.nodes.length} steps in this flow</span>
											</Show>
										</div>
									);
								}}
							</For>
						</div>
					</Show>

					<Show when={details().calls.length > 0}>
						<div class="plan-impl-group">
							<span class="plan-impl-subhead">{details().units.length > 0 ? "Calls" : "Linked function"}</span>
							<div class="plan-impl-chips">
								<For each={details().calls}>
									{(call) => (
										<button
											type="button"
											class="plan-impl-chip"
											classList={{
												active: isPreviewing(call),
												primary: details().primaryRef?.toLowerCase() === call.toLowerCase(),
											}}
											title={`Click to preview ${call}; double-click to open in editor`}
											onClick={() => setPickedTarget({ name: call, hintScript: details().units[0]?.script, label: call })}
											onDblClick={() => props.onOpenRef(call)}
										>
											<Icon name="references" />
											<span>{call}</span>
										</button>
									)}
								</For>
							</div>
						</div>
					</Show>

					<Show when={activeTarget()} keyed>
						{(target) => (
							<div class="plan-impl-code" role="region" aria-label={`Code preview for ${target.label}`}>
								<div class="plan-impl-code-head">
									<span class="plan-impl-code-title" title={preview()?.script ?? target.label}>
										{preview()?.name ?? target.label}
									</span>
									<Show when={preview()} keyed>
										{(pv) => (
											<span class="plan-impl-code-loc">
												{baseName(pv.script)}:{pv.line}-{pv.endLine}
											</span>
										)}
									</Show>
									<span class="spacer" />
									<button
										type="button"
										class="link plan-impl-open"
										title="Open in editor at this function"
										onClick={() => {
											const pv = preview();
											if (pv) props.onOpenScript(pv.script, pv.line);
											else if (target.script) props.onOpenScript(target.script);
											else props.onOpenRef(target.name);
										}}
									>
										Open
									</button>
								</div>
								<Show when={loading()}>
									<p class="plan-impl-code-status">Loading function…</p>
								</Show>
								<Show when={!loading() && missing()}>
									<p class="plan-impl-code-status">Could not locate {target.label} in the language server index.</p>
								</Show>
								<Show when={!loading() && preview()} keyed>
									{(pv) => (
										<div class="plan-impl-pre">
											<For each={pv.code.split("\n")}>
												{(line, idx) => (
													<div class="plan-impl-code-line">
														<span class="plan-impl-ln" aria-hidden="true">
															{pv.line + idx()}
														</span>
														<span class="plan-impl-src">{line || " "}</span>
													</div>
												)}
											</For>
										</div>
									)}
								</Show>
							</div>
						)}
					</Show>
				</div>
			</Show>
		</div>
	);
}

export function PlanImplementation(props: {
	plan: Plan;
	builtUnits: BuiltUnit[];
	open: boolean;
	onToggle: () => void;
	onOpenUnit: (unit: BuiltUnit) => void;
	onOpenScript: (script: string, line?: number) => void;
	onSetTargets: (value: string) => void;
	onCommitOnEnter: (e: KeyboardEvent) => void;
	bindTextarea: (value: () => string) => (el: HTMLTextAreaElement) => void;
	fitTextarea: (el: HTMLTextAreaElement) => void;
}) {
	const targets = createMemo(() => (Array.isArray(props.plan.targets) ? (props.plan.targets as string[]).filter((s) => typeof s === "string" && s.trim()) : []));
	const allScripts = createMemo(() => [...new Set([...targets(), ...props.builtUnits.map((u) => u.script).filter(Boolean)])]);
	const scriptsText = () => targets().join(", ");

	const summary = createMemo(() => {
		const sc = allScripts().length;
		const fn = props.builtUnits.length;
		const parts: string[] = [];
		if (sc > 0) parts.push(`${sc} ${sc === 1 ? "script" : "scripts"}`);
		if (fn > 0) parts.push(`${fn} ${fn === 1 ? "function" : "functions"}`);
		return parts.join(", ") || "No scripts yet";
	});

	return (
		<section class="plan-prop-section plan-impl-section" aria-label="Plan implementation">
			<button
				type="button"
				class="plan-impl-toggle"
				aria-expanded={props.open}
				onClick={props.onToggle}
				title="Show or hide the scripts and functions implementing this plan"
			>
				<Icon name={props.open ? "chevron-down" : "chevron-right"} />
				<span class="plan-impl-label">Implementation</span>
				<span class="spacer" />
				<span class="plan-impl-meta" classList={{ linked: allScripts().length > 0 || props.builtUnits.length > 0 }}>
					{summary()}
				</span>
			</button>

			<Show when={props.open}>
				<div class="plan-impl-body">
					<Show when={allScripts().length > 0}>
						<div class="plan-impl-group">
							<span class="plan-impl-subhead">Scripts</span>
							<div class="plan-impl-list">
								<For each={allScripts()}>
									{(script) => (
										<button
											type="button"
											class="plan-impl-script-row"
											title={`Open ${script}`}
											onClick={() => props.onOpenScript(script)}
										>
											<Icon name="file" />
											<span class="plan-impl-script-file">{baseName(script)}</span>
											<Show when={dirName(script)}>
												<span class="plan-impl-script-dir">{dirName(script)}</span>
											</Show>
										</button>
									)}
								</For>
							</div>
						</div>
					</Show>

					<Show when={props.builtUnits.length > 0}>
						<div class="plan-impl-group">
							<span class="plan-impl-subhead">Functions</span>
							<div class="plan-impl-list">
								<For each={props.builtUnits}>
									{(unit) => (
										<button
											type="button"
											class="plan-impl-fn-row"
											title={`Open ${unit.name} in ${unit.script}`}
											onClick={() => props.onOpenUnit(unit)}
										>
											<Icon name="symbol-method" />
											<span class="plan-impl-fn-name">{unit.name}</span>
											<span class="spacer" />
											<span class="plan-impl-fn-meta">
												{baseName(unit.script).replace(/\.ssl$/i, "")}
											</span>
										</button>
									)}
								</For>
							</div>
						</div>
					</Show>

					<label class="plan-prop-field">
						<span>Target scripts</span>
						<textarea
							ref={props.bindTextarea(scriptsText)}
							class="plan-scripts-input"
							rows={2}
							value={scriptsText()}
							placeholder="Sample/Release.ssl"
							onKeyDown={props.onCommitOnEnter}
							onInput={(e) => props.fitTextarea(e.currentTarget)}
							onChange={(e) => props.onSetTargets(e.currentTarget.value)}
						/>
					</label>
				</div>
			</Show>
		</section>
	);
}
