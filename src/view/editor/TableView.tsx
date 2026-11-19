// A table of values (CSV or TSV), as a table. It is a view of the text in the
// editor (ADR 0002): a cell changed here is that cell's part of the text
// changed, and nothing else; the Text switch shows the same file as written.
import { createMemo, createSignal, createUniqueId, For, onCleanup, Show } from "solid-js";
import { columnOf, csvCell, csvRow, parseCsv, rowSpan, tally, type Cell } from "../../shared/csv";
import { relativeTo } from "../../shared/paths";
import { toneOf } from "../../shared/projectDocs";
import { checksNames, nameQuery, namesOf, NAMES_CHECKED, outsideDocuments, usesSummary } from "../../shared/registryCheck";
import { backend } from "../backend";
import { searchFor } from "../panels/Search";
import { documents, notify, state } from "../state";

/** As many hits as a workspace search returns before it stops (src/bun/workspace.ts). */
const SEARCH_GIVES_UP_AT = 2000;

/** The words a status is most often one of in a registry, offered beside those the table already uses. */
const USUAL_STATUSES = ["found", "migrated", "verified", "not needed", "blocked"];

/** As many rows as are drawn at once. A longer table is narrowed with the filter. */
const ROWS_SHOWN = 500;

export function TableView(props: { path: string }) {
	const model = documents.get(props.path)?.model;
	const [text, setText] = createSignal(model?.getValue() ?? "");
	const listener = model?.onDidChangeContent(() => {
		setText(model.getValue());
		// The rows have moved: the row that was pointed at by its place in the file may be another now.
		setCurrent(null);
	});
	onCleanup(() => listener?.dispose());
	const table = createMemo(() => parseCsv(text()));
	const [filter, setFilter] = createSignal("");
	/** The status the rows are narrowed to, exactly as the column has it ("" is a row with none); null when they are not. */
	const [onlyStatus, setOnlyStatus] = createSignal<string | null>(null);
	/** The row the keyboard or the pointer was last in, by its place in the file: the one Delete row takes out. */
	const [current, setCurrent] = createSignal<number | null>(null);
	/** The column the rows are ordered by here, and which way; the file's own order is not changed. */
	const [order, setOrder] = createSignal<{ column: number; down: boolean } | null>(null);
	/** The cell being changed: its row in the file and its column. */
	const [editing, setEditing] = createSignal<{ row: number; column: number } | null>(null);
	const statusAt = () => columnOf(table(), "status");
	const counted = createMemo(() => tally(table()));

	/** The statuses to offer when one is typed: those the table uses, then the usual ones. */
	const statuses = createMemo(() => [...new Set([...(counted()?.by.map(([status]) => status).filter(Boolean) ?? []), ...USUAL_STATUSES])]);
	const statusList = createUniqueId();

	/**
	 * How often each row's name is found outside the project's documents, once it has been asked: by name, so that it
	 * holds while the table is edited. A registry lists what a migration must carry; a name found nowhere is a row to question.
	 */
	const [uses, setUses] = createSignal<Map<string, number> | null>(null);
	const [checking, setChecking] = createSignal("");
	const [onlyMissing, setOnlyMissing] = createSignal(false);
	const usesOf = (cells: Cell[]) => uses()?.get((cells[0]?.text ?? "").trim().toLowerCase());
	const checkNames = async () => {
		const root = state.workspace?.root;
		if (!root || checking()) return;
		const names = namesOf(table()).slice(0, NAMES_CHECKED);
		const apart = [state.project?.docs ?? "docs", state.project?.plans ?? "design", ".ssl-studio"].map((folder) => folder.split("\\").join("/"));
		const found = new Map<string, number>();
		try {
			for (const [at, name] of names.entries()) {
				setChecking(`Looking for ${at + 1} of ${names.length}…`);
				const hits = await backend.search(nameQuery(name), { regex: true, caseSensitive: false });
				const outside = hits.filter((hit) => outsideDocuments(relativeTo(root, hit.path).split("\\").join("/"), apart)).length;
				// A search gives up after so many hits: when it did, and none of those it gave were outside the documents, it is not known.
				if (outside === 0 && hits.length >= SEARCH_GIVES_UP_AT) continue;
				found.set(name.toLowerCase(), outside);
			}
			setUses(found);
			notify(usesSummary(found));
		} catch (e: any) {
			notify(`The names could not be looked for: ${e?.message ?? e}`, "error");
		} finally {
			setChecking("");
		}
	};
	const missing = () => [...(uses()?.values() ?? [])].filter((count) => count === 0).length;

	const rows = createMemo(() => {
		const words = filter().trim().toLowerCase().split(/\s+/).filter(Boolean);
		let list = table().rows.map((cells, index) => ({ cells, index }));
		if (onlyMissing() && uses()) list = list.filter(({ cells }) => usesOf(cells) === 0);
		const wanted = onlyStatus();
		if (wanted !== null && statusAt() >= 0) list = list.filter(({ cells }) => (cells[statusAt()]?.text ?? "").trim().toLowerCase() === wanted);
		if (words.length) list = list.filter(({ cells }) => words.every((word) => cells.some((cell) => cell.text.toLowerCase().includes(word))));
		const by = order();
		if (by) {
			const value = (cells: Cell[]) => cells[by.column]?.text ?? "";
			list = [...list].sort((a, b) => value(a.cells).localeCompare(value(b.cells), undefined, { numeric: true, sensitivity: "base" }) * (by.down ? -1 : 1));
		}
		return list;
	});

	/** The rows drawn: the first of them, and the row being typed in when it is beyond those, so that a row added to a long table is there to type in. */
	const drawn = createMemo(() => {
		const first = rows().slice(0, ROWS_SHOWN);
		const typing = editing();
		const beyond = typing && !first.some((row) => row.index === typing.row) ? rows().find((row) => row.index === typing.row) : undefined;
		return beyond ? [...first, beyond] : first;
	});

	/** Changes one cell: that part of the text, written as a cell must be. A row short of the column gets the cells between. */
	const change = (row: number, column: number, value: string) => {
		setEditing(null);
		if (!model) return;
		const cells = table().rows[row];
		if (!cells) return;
		const delimiter = table().delimiter;
		const cell = cells[column];
		if (cell && cell.text === value) return;
		const last = cells[cells.length - 1]!;
		const [start, end, written] = cell ? [cell.start, cell.end, csvCell(value, delimiter)] : [last.end, last.end, delimiter.repeat(column - cells.length + 1) + csvCell(value, delimiter)];
		const from = model.getPositionAt(start);
		const to = model.getPositionAt(end);
		model.pushStackElement();
		model.pushEditOperations([], [{ range: { startLineNumber: from.lineNumber, startColumn: from.column, endLineNumber: to.lineNumber, endColumn: to.column }, text: written }], () => null);
		model.pushStackElement();
	};

	/** A new, empty row at the end of the file, and its first cell open to type in. */
	const addRow = () => {
		if (!model) return;
		const end = model.getPositionAt(model.getValueLength());
		const value = model.getValue();
		// A row of nothing but separators is a row; a table of one column needs its empty cell written, or the line is blank.
		const line = table().header.length > 1 ? csvRow(table().header.map(() => ""), table().delimiter) : '""';
		model.pushStackElement();
		model.pushEditOperations([], [{ range: { startLineNumber: end.lineNumber, startColumn: end.column, endLineNumber: end.lineNumber, endColumn: end.column }, text: `${value && !/\n$/.test(value) ? model.getEOL() : ""}${line}${model.getEOL()}` }], () => null);
		model.pushStackElement();
		setFilter("");
		setOrder(null);
		setOnlyStatus(null);
		setOnlyMissing(false);
		queueMicrotask(() => setEditing({ row: table().rows.length - 1, column: 0 }));
	};

	const deleteRow = () => {
		const row = current();
		if (!model || row === null) return;
		const span = rowSpan(model.getValue(), table(), row);
		if (!span) return;
		const from = model.getPositionAt(span.start);
		const to = model.getPositionAt(span.end);
		model.pushStackElement();
		model.pushEditOperations([], [{ range: { startLineNumber: from.lineNumber, startColumn: from.column, endLineNumber: to.lineNumber, endColumn: to.column }, text: "" }], () => null);
		model.pushStackElement();
		setCurrent(null);
		setEditing(null);
	};
	/** What the row is known by, for the button to say which it would take out. */
	const currentName = () => {
		const row = current();
		return row === null ? "" : (table().rows[row]?.[0]?.text.trim() ?? "");
	};

	let body: HTMLTableSectionElement | undefined;
	/** The arrow keys move between cells; Enter or F2 changes the one the keys are on. */
	const onKey = (e: KeyboardEvent, row: number, column: number) => {
		if (editing()) return;
		const cell = e.currentTarget as HTMLElement;
		const move = (to: Element | null | undefined) => to instanceof HTMLElement && (e.preventDefault(), to.focus());
		if (e.key === "Enter" || e.key === "F2") return e.preventDefault(), setEditing({ row, column });
		if (e.key === "ArrowRight") return move(cell.nextElementSibling);
		if (e.key === "ArrowLeft") return move(cell.previousElementSibling);
		const at = [...cell.parentElement!.children].indexOf(cell);
		if (e.key === "ArrowDown") return move(cell.parentElement!.nextElementSibling?.children[at]);
		if (e.key === "ArrowUp") return move(cell.parentElement!.previousElementSibling?.children[at]);
	};
	const sortBy = (column: number) => setOrder((by) => (by?.column !== column ? { column, down: false } : by.down ? null : { column, down: true }));

	return (
		<div
			class="table-view"
			onKeyDown={(e) => {
				// The table is a view of the text, and its changes are the text's: they are undone as the text's are.
				if (!model || !(e.ctrlKey || e.metaKey) || e.altKey || (e.target as HTMLElement).tagName === "INPUT") return;
				const key = e.key.toLowerCase();
				if (key === "z" && !e.shiftKey) (e.preventDefault(), void model.undo());
				else if (key === "y" || (key === "z" && e.shiftKey)) (e.preventDefault(), void model.redo());
			}}
		>
			<div class="table-bar">
				<input class="filter" type="search" placeholder="Filter rows" aria-label="Filter the rows by what they hold" value={filter()} onInput={(e) => setFilter(e.currentTarget.value)} />
				<span class="hint">
					{rows().length === table().rows.length ? `${table().rows.length} ${table().rows.length === 1 ? "row" : "rows"}` : `${rows().length} of ${table().rows.length} rows`}
				</span>
				<Show when={counted()}>
					<span class="table-tally" aria-label="Rows by status">
						<For each={counted()!.by}>
							{([status, count]) => (
								<button class={`doc-status tone-${toneOf(status)}`} aria-pressed={onlyStatus() === status} title={onlyStatus() === status ? "Show every row again" : `Show only the rows whose status is ${status || "empty"}`} onClick={() => setOnlyStatus(onlyStatus() === status ? null : status)}>
									{status || "no status"} {count}
								</button>
							)}
						</For>
					</span>
				</Show>
				<Show when={uses() && missing()}>
					<button class="doc-status tone-off table-missing" aria-pressed={onlyMissing()} title="Show only the rows whose name is found nowhere outside the project's documents" onClick={() => setOnlyMissing(!onlyMissing())}>
						not in code {missing()}
					</button>
				</Show>
				<span class="spacer" />
				<Show when={checksNames(table())}>
					<button
						title={`Looks for each row's ${table().header[0]?.text.trim() || "name"} in the project's files, outside its documents: a row whose name is found nowhere is one to question. A search for the name, as a whole word.`}
						onClick={() => void checkNames()}
						disabled={Boolean(checking())}
					>
						{checking() || (uses() ? "Check again" : "Check against code")}
					</button>
				</Show>
				<button
					title={current() === null || !table().rows[current()!] ? "Click a row, or move to it with the arrow keys, to choose the row to take out" : `Takes out the row${currentName() ? ` ${currentName()}` : ` ${current()! + 1}`}: its line of the file. Ctrl+Z brings it back.`}
					onClick={deleteRow}
					disabled={current() === null || !table().rows[current()!]}
				>
					Delete row
				</button>
				<button title="A new row at the end of the file" onClick={addRow} disabled={!table().header.length}>
					Add row
				</button>
			</div>
			<Show when={table().problems.length}>
				<p class="hint warn table-problems" role="status">
					{table().problems.join(" ")} The Text view shows the file as written.
				</p>
			</Show>
			{/* What a status is typed from: the ones this table uses, and the usual ones. */}
			<datalist id={statusList}>
				<For each={statuses()}>{(status) => <option value={status} />}</For>
			</datalist>
			<div class="table-scroll">
				<table>
					<thead>
						<tr>
							<For each={table().header}>
								{(cell, column) => (
									<th scope="col" aria-sort={order()?.column === column() ? (order()!.down ? "descending" : "ascending") : "none"}>
										<button title={`Order the rows by ${cell.text.trim() || "this column"}. The file's own order is not changed.`} onClick={() => sortBy(column())}>
											{cell.text.trim() || "(no name)"}
											<span aria-hidden="true">{order()?.column === column() ? (order()!.down ? " ↓" : " ↑") : ""}</span>
										</button>
									</th>
								)}
							</For>
						</tr>
					</thead>
					<tbody ref={body}>
						<For each={drawn()}>
							{({ cells, index }) => (
								<tr>
									<For each={table().header}>
										{(_, column) => {
											const value = () => cells[column()]?.text ?? "";
											const open = () => editing()?.row === index && editing()?.column === column();
											return (
												<td tabindex={0} classList={{ number: /^-?\d[\d.,]*$/.test(value().trim()) }} title="Enter, F2 or a double-click changes this cell" onFocus={() => setCurrent(index)} onDblClick={() => setEditing({ row: index, column: column() })} onKeyDown={(e) => onKey(e, index, column())}>
													<Show
														when={open()}
														fallback={
															<>
																<Show when={column() === statusAt() && value().trim()} fallback={value()}>
																	<span class={`doc-status tone-${toneOf(value())}`}>{value()}</span>
																</Show>
																{/* Once the names have been looked for: how often this row's is found, as the way to where; or that it is not. */}
																<Show when={column() === 0 && usesOf(cells) !== undefined}>
																	<Show
																		when={usesOf(cells)}
																		fallback={
																			<span class="doc-status tone-off table-use" title="Found nowhere outside the project's documents">
																				not in code
																			</span>
																		}
																	>
																		<button class="link table-use" title={`Found ${usesOf(cells)} ${usesOf(cells) === 1 ? "time" : "times"} outside the documents. Show where.`} onClick={(e) => (e.stopPropagation(), searchFor(nameQuery(value().trim()), { regex: true }))}>
																			{usesOf(cells)}×
																		</button>
																	</Show>
																</Show>
															</>
														}
													>
														<input
															list={column() === statusAt() ? statusList : undefined}
															value={value()}
															aria-label={`${table().header[column()]?.text.trim() || "Cell"}, row ${index + 1}`}
															ref={(el) => queueMicrotask(() => (el.focus(), el.select()))}
															onKeyDown={(e) => {
																e.stopPropagation();
																if (e.key === "Enter") change(index, column(), e.currentTarget.value);
																if (e.key === "Escape") setEditing(null);
															}}
															onBlur={(e) => open() && change(index, column(), e.currentTarget.value)}
														/>
													</Show>
												</td>
											);
										}}
									</For>
								</tr>
							)}
						</For>
					</tbody>
				</table>
				<Show when={rows().length > ROWS_SHOWN}>
					<p class="hint">
						The first {ROWS_SHOWN} of {rows().length} rows are shown. Filter to narrow them; the Text view has them all.
					</p>
				</Show>
				<Show when={!table().rows.length && table().header.length}>
					<p class="hint">No rows yet. Add row starts the first.</p>
				</Show>
			</div>
		</div>
	);
}
