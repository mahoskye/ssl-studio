// A table of values (CSV or TSV), as a table. It is a view of the text in the
// editor (ADR 0002): a cell changed here is that cell's part of the text
// changed, and nothing else; the Text switch shows the same file as written.
import { createMemo, createSignal, For, onCleanup, Show } from "solid-js";
import { columnOf, csvCell, csvRow, parseCsv, tally, type Cell } from "../../shared/csv";
import { toneOf } from "../../shared/projectDocs";
import { documents } from "../state";

/** As many rows as are drawn at once. A longer table is narrowed with the filter. */
const ROWS_SHOWN = 500;

export function TableView(props: { path: string }) {
	const model = documents.get(props.path)?.model;
	const [text, setText] = createSignal(model?.getValue() ?? "");
	const listener = model?.onDidChangeContent(() => setText(model.getValue()));
	onCleanup(() => listener?.dispose());
	const table = createMemo(() => parseCsv(text()));
	const [filter, setFilter] = createSignal("");
	/** The column the rows are ordered by here, and which way; the file's own order is not changed. */
	const [order, setOrder] = createSignal<{ column: number; down: boolean } | null>(null);
	/** The cell being changed: its row in the file and its column. */
	const [editing, setEditing] = createSignal<{ row: number; column: number } | null>(null);
	const statusAt = () => columnOf(table(), "status");
	const counted = createMemo(() => tally(table()));

	const rows = createMemo(() => {
		const words = filter().trim().toLowerCase().split(/\s+/).filter(Boolean);
		let list = table().rows.map((cells, index) => ({ cells, index }));
		if (words.length) list = list.filter(({ cells }) => words.every((word) => cells.some((cell) => cell.text.toLowerCase().includes(word))));
		const by = order();
		if (by) {
			const value = (cells: Cell[]) => cells[by.column]?.text ?? "";
			list = [...list].sort((a, b) => value(a.cells).localeCompare(value(b.cells), undefined, { numeric: true, sensitivity: "base" }) * (by.down ? -1 : 1));
		}
		return list;
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
		queueMicrotask(() => setEditing({ row: table().rows.length - 1, column: 0 }));
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
		<div class="table-view">
			<div class="table-bar">
				<input class="filter" type="search" placeholder="Filter rows" aria-label="Filter the rows by what they hold" value={filter()} onInput={(e) => setFilter(e.currentTarget.value)} />
				<span class="hint">
					{rows().length === table().rows.length ? `${table().rows.length} ${table().rows.length === 1 ? "row" : "rows"}` : `${rows().length} of ${table().rows.length} rows`}
				</span>
				<Show when={counted()}>
					<span class="table-tally" aria-label="Rows by status">
						<For each={counted()!.by}>
							{([status, count]) => (
								<button class={`doc-status tone-${toneOf(status)}`} title={`Show only the rows whose status is ${status || "empty"}`} onClick={() => setFilter(status)}>
									{status || "no status"} {count}
								</button>
							)}
						</For>
					</span>
				</Show>
				<span class="spacer" />
				<button title="A new row at the end of the file" onClick={addRow} disabled={!table().header.length}>
					Add row
				</button>
			</div>
			<Show when={table().problems.length}>
				<p class="hint warn table-problems" role="status">
					{table().problems.join(" ")} The Text view shows the file as written.
				</p>
			</Show>
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
						<For each={rows().slice(0, ROWS_SHOWN)}>
							{({ cells, index }) => (
								<tr>
									<For each={table().header}>
										{(_, column) => {
											const value = () => cells[column()]?.text ?? "";
											const open = () => editing()?.row === index && editing()?.column === column();
											return (
												<td tabindex={0} classList={{ number: /^-?\d[\d.,]*$/.test(value().trim()) }} title="Enter, F2 or a double-click changes this cell" onDblClick={() => setEditing({ row: index, column: column() })} onKeyDown={(e) => onKey(e, index, column())}>
													<Show
														when={open()}
														fallback={
															<Show when={column() === statusAt() && value().trim()} fallback={value()}>
																<span class={`doc-status tone-${toneOf(value())}`}>{value()}</span>
															</Show>
														}
													>
														<input
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
