// Targeted "Check in code" dialog for CSV tables: lets the user pick the exact
// column, row subset (selected, filtered, or all), file scope/globs, and match
// options instead of blindly scanning the first 300 entries of column 1.
import { createMemo, createSignal, createUniqueId, For, Show, untrack } from "solid-js";
import type { Cell, Table } from "../../shared/csv";
import {
	CODE_FILE_SCOPES,
	codeCheckSearchOptions,
	columnCheckTargets,
	looksLikeListColumn,
	type CodeCheckRowScope,
	type CodeCheckSpec,
	type CodeFileScopeId,
} from "../../shared/registryCheck";
import { Icon } from "../Icon";
import { Modal } from "../modal";

export function CsvCodeCheckDialog(props: {
	table: Table;
	filteredRows: readonly Cell[][];
	checkedRows?: readonly Cell[][];
	hasActiveFilters: boolean;
	selectedRow: { index: number; cells: Cell[] } | null;
	initialColumn: number;
	initialRowScope?: CodeCheckRowScope;
	defaultExclude: string;
	lastSpec?: Partial<CodeCheckSpec>;
	onRun: (spec: CodeCheckSpec) => void;
	onClose: () => void;
}) {
	const titleId = createUniqueId();
	const safeInitialCol = () => Math.max(0, Math.min(props.initialColumn, Math.max(0, props.table.header.length - 1)));
	const hasChecked = () => (props.checkedRows?.length ?? 0) > 0;
	const computeInitialScope = (): CodeCheckRowScope => {
		const initialScope: CodeCheckRowScope =
			props.initialRowScope ?? (hasChecked() ? "checked" : props.hasActiveFilters ? "filtered" : "all");
		return initialScope === "selected" && !props.selectedRow
			? hasChecked()
				? "checked"
				: props.hasActiveFilters
					? "filtered"
					: "all"
			: initialScope === "checked" && !hasChecked()
				? props.hasActiveFilters
					? "filtered"
					: "all"
				: initialScope;
	};

	const [column, setColumn] = createSignal(untrack(safeInitialCol));
	const [rowScope, setRowScope] = createSignal<CodeCheckRowScope>(untrack(computeInitialScope));
	const [fileScope, setFileScope] = createSignal<CodeFileScopeId>(untrack(() => props.lastSpec?.fileScope ?? "code"));
	const [include, setInclude] = createSignal(untrack(() => props.lastSpec?.include ?? ""));
	const [exclude, setExclude] = createSignal(untrack(() => props.lastSpec?.exclude ?? props.defaultExclude));
	const [wholeWord, setWholeWord] = createSignal(untrack(() => props.lastSpec?.wholeWord ?? true));
	const [caseSensitive, setCaseSensitive] = createSignal(untrack(() => props.lastSpec?.caseSensitive ?? false));
	const [splitLists, setSplitLists] = createSignal(untrack(() => looksLikeListColumn(props.table.rows, safeInitialCol())));

	const colName = (idx: number) => props.table.header[idx]?.text.trim() || `Column ${idx + 1}`;

	const onColumnChange = (nextCol: number) => {
		setColumn(nextCol);
		setSplitLists(looksLikeListColumn(props.table.rows, nextCol));
	};

	const targetRows = createMemo<readonly Cell[][]>(() => {
		if (rowScope() === "selected" && props.selectedRow) return [props.selectedRow.cells];
		if (rowScope() === "checked" && props.checkedRows?.length) return props.checkedRows;
		if (rowScope() === "filtered" && props.hasActiveFilters) return props.filteredRows;
		return props.table.rows;
	});

	const targets = createMemo(() =>
		columnCheckTargets(targetRows(), column(), {
			splitLists: splitLists(),
			caseSensitive: caseSensitive(),
			minLength: rowScope() === "selected" ? 1 : 2,
		}),
	);

	const effectiveOptions = createMemo(() =>
		codeCheckSearchOptions(
			{
				fileScope: fileScope(),
				include: include(),
				exclude: exclude(),
				wholeWord: wholeWord(),
				caseSensitive: caseSensitive(),
			},
			props.defaultExclude,
		),
	);

	const selectedCellPreview = createMemo(() => {
		if (!props.selectedRow) return "";
		const val = (props.selectedRow.cells[column()]?.text ?? "").trim();
		if (!val) return `row ${props.selectedRow.index + 1}`;
		return val.length > 30 ? `${val.slice(0, 29)}…` : val;
	});

	const submit = (e: Event) => {
		e.preventDefault();
		if (!targets().terms.length) return;
		props.onRun({
			column: column(),
			rowScope: rowScope(),
			fileScope: fileScope(),
			include: include().trim(),
			exclude: exclude().trim(),
			wholeWord: wholeWord(),
			caseSensitive: caseSensitive(),
			splitLists: splitLists(),
		});
	};

	return (
		<Modal labelledBy={titleId} class="dialog csv-check-dialog" onClose={props.onClose}>
			<div class="csv-fmt-head">
				<div>
					<h3 id={titleId}>Check values in code</h3>
					<p class="csv-fmt-sub">Search workspace files for values from a specific column and annotate matches inline.</p>
				</div>
				<button type="button" class="icon-btn" title="Close (Esc)" aria-label="Close" onClick={() => props.onClose()}>
					<Icon name="close" />
				</button>
			</div>

			<form class="csv-check-form" onSubmit={submit}>
				<div class="csv-check-grid">
					<label class="csv-fmt-field">
						<span>Column to check</span>
						<select value={String(column())} onChange={(e) => onColumnChange(Number(e.currentTarget.value))}>
							<For each={props.table.header}>
								{(_, idx) => <option value={String(idx())}>{colName(idx())}</option>}
							</For>
						</select>
					</label>

					<label class="csv-fmt-field">
						<span>Files to search</span>
						<select value={fileScope()} onChange={(e) => setFileScope(e.currentTarget.value as CodeFileScopeId)}>
							<For each={CODE_FILE_SCOPES}>{(scope) => <option value={scope.id}>{scope.label}</option>}</For>
						</select>
					</label>
				</div>

				<Show when={fileScope() === "custom"}>
					<div class="csv-check-grid">
						<label class="csv-fmt-field">
							<span>Include files (comma-separated globs)</span>
							<input
								type="text"
								placeholder="e.g. src/DueDates/**, *.ssl"
								value={include()}
								onInput={(e) => setInclude(e.currentTarget.value)}
							/>
						</label>
						<label class="csv-fmt-field">
							<span>Exclude files</span>
							<input
								type="text"
								placeholder="e.g. docs/**, design/**"
								value={exclude()}
								onInput={(e) => setExclude(e.currentTarget.value)}
							/>
						</label>
					</div>
				</Show>

				<Show when={fileScope() !== "custom"}>
					<p class="csv-check-scope-note">
						<Show when={effectiveOptions().include}>
							<span>
								Includes: <code>{effectiveOptions().include}</code>
							</span>
						</Show>
						<Show when={effectiveOptions().exclude}>
							<span>
								Excludes: <code>{effectiveOptions().exclude}</code>
							</span>
						</Show>
					</p>
				</Show>

				<fieldset class="csv-check-fieldset">
					<legend>Rows to check</legend>
					<div class="csv-check-radios">
						<Show when={props.selectedRow}>
							<label>
								<input
									type="radio"
									name="csv-check-rows"
									checked={rowScope() === "selected"}
									onChange={() => setRowScope("selected")}
								/>
								<span>
									Selected row <span class="hint">({selectedCellPreview()})</span>
								</span>
							</label>
						</Show>
						<Show when={props.checkedRows?.length}>
							<label>
								<input
									type="radio"
									name="csv-check-rows"
									checked={rowScope() === "checked"}
									onChange={() => setRowScope("checked")}
								/>
								<span>
									Checked rows <span class="hint">({props.checkedRows!.length} selected)</span>
								</span>
							</label>
						</Show>
						<Show when={props.hasActiveFilters}>
							<label>
								<input
									type="radio"
									name="csv-check-rows"
									checked={rowScope() === "filtered"}
									onChange={() => setRowScope("filtered")}
								/>
								<span>
									Filtered rows <span class="hint">({props.filteredRows.length} of {props.table.rows.length})</span>
								</span>
							</label>
						</Show>
						<label>
							<input
								type="radio"
								name="csv-check-rows"
								checked={rowScope() === "all"}
								onChange={() => setRowScope("all")}
							/>
							<span>
								All rows <span class="hint">({props.table.rows.length})</span>
							</span>
						</label>
					</div>
				</fieldset>

				<div class="csv-check-options">
					<label class="csv-fmt-toggle">
						<input type="checkbox" checked={wholeWord()} onChange={(e) => setWholeWord(e.currentTarget.checked)} />
						<span>Whole word only</span>
					</label>
					<label class="csv-fmt-toggle">
						<input type="checkbox" checked={caseSensitive()} onChange={(e) => setCaseSensitive(e.currentTarget.checked)} />
						<span>Case sensitive</span>
					</label>
					<label class="csv-fmt-toggle" title="Split cells containing comma- or semicolon-separated lists and check each item individually">
						<input type="checkbox" checked={splitLists()} onChange={(e) => setSplitLists(e.currentTarget.checked)} />
						<span>Split comma-separated lists</span>
					</label>
				</div>

				<div class="csv-check-preview">
					<Show
						when={targets().terms.length > 0}
						fallback={<span class="hint">No searchable values in “{colName(column())}” for the chosen rows.</span>}
					>
						<div class="csv-check-preview-head">
							<strong>
								Will search {targets().terms.length} unique {targets().terms.length === 1 ? "value" : "values"}
							</strong>
							<Show when={targets().skippedShort > 0}>
								<span class="hint">
									({targets().skippedShort} single-character skipped)
								</span>
							</Show>
						</div>
						<div class="csv-check-samples">
							<For each={targets().terms.slice(0, 6)}>
								{(term) => <code class="csv-check-sample">{term}</code>}
							</For>
							<Show when={targets().terms.length > 6}>
								<span class="hint">+{targets().terms.length - 6} more</span>
							</Show>
						</div>
						<Show when={targets().terms.length > 100}>
							<p class="hint csv-check-large-note">
								Large check — filter rows first for faster results, or cancel anytime while running.
							</p>
						</Show>
					</Show>
				</div>

				<div class="csv-fmt-foot">
					<span class="spacer" />
					<button type="button" onClick={() => props.onClose()}>
						Cancel
					</button>
					<button type="submit" class="primary" disabled={!targets().terms.length}>
						<Icon name="search" /> Check {targets().terms.length || ""} {targets().terms.length === 1 ? "value" : "values"}
					</button>
				</div>
			</form>
		</Modal>
	);
}
