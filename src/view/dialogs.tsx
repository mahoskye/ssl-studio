// In-app prompts, confirmations, VS Code-style QuickPick list selectors
// (single- and multi-select), and a searchable Workspace File Browser
// (ADR 0032). Every overlay serializes through one unified FIFO queue so two
// overlays can never mount on top of each other simultaneously.
import { createEffect, createMemo, createResource, createSignal, createUniqueId, For, Show } from "solid-js";
import {
	initialMultiSelectIndices,
	resolveMultiSelectValues,
	selectAllVisibleIndices,
	shouldUseQuickPick,
	toggleMultiSelectIndex,
} from "../shared/contextMenu";
import { baseName, dirName, isInside, relativeTo } from "../shared/paths";
import { backend } from "./backend";
import {
	defaultButton,
	DialogQueue,
	type DialogOverlay,
	type FileBrowserPinnedItem,
	type FileBrowserRequest,
	type QuickPickItemData,
	type QuickPickManyRequest,
	type QuickPickRequest,
	type Request,
} from "./dialogQueue";
import { FileMark } from "./FileMark";
import { Icon, type IconName } from "./Icon";
import { Modal } from "./modal";
import { fileTier, matchWords } from "./quickRank";
import { canonical } from "./state";

const [activeOverlay, setActiveOverlay] = createSignal<DialogOverlay | null>(null);
const queue = DialogQueue.unified(setActiveOverlay);

// --- VS Code-style QuickPick & File Browser overlay API ----------------------

export type QuickPickOption<T = string> = Omit<QuickPickItemData<T>, "icon"> & {
	icon?: IconName;
};

export type QuickPickSingleOptions<T = string> = {
	title: string;
	placeholder?: string;
	items: QuickPickOption<T>[];
	empty?: string;
	searchable?: boolean;
	canPickMany?: false;
};

export type QuickPickManyOptions<T = string> = {
	title: string;
	placeholder?: string;
	items: QuickPickOption<T>[];
	initialSelected?: T[];
	empty?: string;
	confirmLabel?: string;
};

export type FileBrowserPinned = FileBrowserPinnedItem;

/**
 * VS Code-style top-center searchable QuickPick (ADR 0032). Use for selecting
 * from tickets, files, statuses, templates, headings, registries, or options.
 * Pass `canPickMany: true` (or call `quickPickMany`) for multi-select checkboxes.
 */
export function quickPick<T = string>(options: QuickPickManyOptions<T> & { canPickMany: true }): Promise<T[] | null>;
export function quickPick<T = string>(options: QuickPickSingleOptions<T>): Promise<T | null>;
export function quickPick<T = string>(
	options: (QuickPickManyOptions<T> & { canPickMany: true }) | QuickPickSingleOptions<T>,
): Promise<T | T[] | null> {
	if ("canPickMany" in options && options.canPickMany) {
		return quickPickMany(options);
	}
	return queue.quickPick(options);
}

/**
 * VS Code-style top-center multi-select QuickPick with checkboxes, live search
 * that preserves already-checked items, Select all / Clear controls, and
 * Enter-to-confirm / Escape-to-cancel semantics (ADR 0032).
 */
export function quickPickMany<T = string>(options: QuickPickManyOptions<T>): Promise<T[] | null> {
	return queue.quickPickMany(options);
}

/**
 * VS Code-style Workspace File Browser with folder navigation, breadcrumbs,
 * pinned quick-access files, and instant fuzzy search across the workspace.
 */
export function browseWorkspaceFile(options: {
	title?: string;
	root: string;
	initialDir?: string;
	pinned?: FileBrowserPinned[];
	pinnedLabel?: string;
	exclude?: Iterable<string>;
}): Promise<{ path: string; rel: string } | null> {
	const exclude = new Set<string>();
	for (const p of options.exclude ?? []) exclude.add(canonical(p));
	return queue.browseWorkspaceFile({
		title: options.title,
		root: options.root,
		initialDir: options.initialDir && isInside(options.root, options.initialDir) ? options.initialDir : options.root,
		pinned: options.pinned,
		pinnedLabel: options.pinnedLabel,
		exclude,
	});
}

/** Asks for a line of text. Null when cancelled. */
export function ask(title: string, value = ""): Promise<string | null> {
	return queue.ask(title, value);
}

/**
 * Asks for one of `buttons`; "Cancel" is always offered too and gives null.
 * Compact confirmations (1-3 short buttons) render as centered confirmation
 * dialogs; larger option lists render as a VS Code-style QuickPick (ADR 0032).
 */
export function choose(title: string, buttons: string[], options: { danger?: string; details?: Record<string, string> } = {}): Promise<string | null> {
	return queue.choose(title, buttons, options);
}

function formatBytes(bytes: number): string {
	if (!Number.isFinite(bytes) || bytes < 0) return "";
	if (bytes < 1024) return `${bytes} B`;
	if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
	return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function QuickPickModal(props: { req: QuickPickRequest }) {
	const req = props.req;
	const listId = createUniqueId();
	const [query, setQuery] = createSignal("");
	const [selected, setSelected] = createSignal(0);
	let listEl: HTMLDivElement | undefined;

	const filtered = createMemo(() => {
		const q = query().trim();
		if (!q) return req.items;
		return req.items
			.map((item) => {
				const secondary = `${item.detail ?? ""} ${item.description ?? ""} ${item.badge?.text ?? ""} ${item.keywords ?? ""}`;
				return { item, score: matchWords(q, item.label, secondary) };
			})
			.filter((x) => x.score > 0)
			.sort((a, b) => b.score - a.score)
			.map((x) => x.item);
	});

	createEffect(() => {
		const len = filtered().length;
		if (selected() >= len) setSelected(Math.max(0, len - 1));
	});
	createEffect(() => {
		const idx = selected();
		filtered();
		listEl?.children[idx]?.scrollIntoView({ block: "nearest" });
	});

	const finish = (value: any | null) => queue.finishOverlay(req, value);
	const move = (by: number) => setSelected((i) => Math.max(0, Math.min(i + by, filtered().length - 1)));
	const pick = (item: QuickPickItemData<any> | undefined) => {
		if (!item) return;
		finish(item.value);
	};

	let pointer = "";
	const pointed = (e: MouseEvent, idx: number) => {
		const at = `${e.clientX},${e.clientY}`;
		if (at === pointer) return;
		pointer = at;
		setSelected(idx);
	};

	return (
		<Modal class="quickpick quickpick-dialog" top label={req.title} onClose={() => finish(null)}>
			<div class="quickpick-head">
				<span class="quickpick-title">{req.title}</span>
				<button type="button" class="quickpick-close" aria-label="Close" title="Close (Escape)" onClick={() => finish(null)}>
					<Icon name="close" />
				</button>
			</div>
			<Show when={req.searchable}>
				<input
					data-autofocus
					role="combobox"
					aria-label={req.title}
					aria-expanded="true"
					aria-controls={listId}
					aria-autocomplete="list"
					aria-activedescendant={filtered().length ? `${listId}-${selected()}` : undefined}
					autocomplete="off"
					spellcheck={false}
					placeholder={req.placeholder}
					value={query()}
					onInput={(e) => (setQuery(e.currentTarget.value), setSelected(0))}
					onKeyDown={(e) => {
						if (e.key === "ArrowDown") (e.preventDefault(), move(1));
						else if (e.key === "ArrowUp") (e.preventDefault(), move(-1));
						else if (e.key === "PageDown") (e.preventDefault(), move(8));
						else if (e.key === "PageUp") (e.preventDefault(), move(-8));
						else if (e.key === "Home" && !query()) (e.preventDefault(), setSelected(0));
						else if (e.key === "End" && !query()) (e.preventDefault(), setSelected(Math.max(0, filtered().length - 1)));
						else if (e.key === "Enter") (e.preventDefault(), e.stopPropagation(), pick(filtered()[selected()]));
					}}
				/>
			</Show>
			<div
				class="items"
				role="listbox"
				id={listId}
				aria-label={req.title}
				tabindex={req.searchable ? undefined : 0}
				data-autofocus={req.searchable ? undefined : ""}
				ref={listEl}
				onKeyDown={(e) => {
					if (req.searchable) return;
					if (e.key === "ArrowDown") (e.preventDefault(), move(1));
					else if (e.key === "ArrowUp") (e.preventDefault(), move(-1));
					else if (e.key === "Enter" || e.key === " ") (e.preventDefault(), e.stopPropagation(), pick(filtered()[selected()]));
				}}
			>
				<For each={filtered()}>
					{(item, i) => (
						<div
							class="item"
							classList={{
								selected: i() === selected(),
								"quick-noted": Boolean(item.description),
								"quick-divide": Boolean(item.divide && !query().trim()),
								"quick-danger": Boolean(item.danger),
							}}
							role="option"
							id={`${listId}-${i()}`}
							aria-selected={i() === selected()}
							onMouseMove={(e) => pointed(e, i())}
							onMouseDown={(e) => e.button === 0 && (e.preventDefault(), pick(item))}
						>
							<Show when={item.checked}>
								<Icon name="check" class="quick-item-icon quick-item-check" />
							</Show>
							<Show when={!item.checked && item.file}>
								{(name) => <FileMark name={name()} />}
							</Show>
							<Show when={!item.checked && !item.file && item.icon}>
								{(icon) => <Icon name={icon() as IconName} class="quick-item-icon" />}
							</Show>
							<span class="label">{item.label}</span>
							<Show when={item.badge}>
								{(b) => <span class={`doc-status tone-${b().tone ?? "waiting"}`}>{b().text}</span>}
							</Show>
							<Show when={item.detail}>
								<span class="detail">{item.detail}</span>
							</Show>
							<Show when={item.description}>
								<span class="quick-note">{item.description}</span>
							</Show>
						</div>
					)}
				</For>
			</div>
			<Show when={!filtered().length}>
				<div class="quick-status" role="status">
					{req.empty}
				</div>
			</Show>
		</Modal>
	);
}

function QuickPickManyModal(props: { req: QuickPickManyRequest }) {
	const req = props.req;
	const listId = createUniqueId();
	const [query, setQuery] = createSignal("");
	const [focused, setFocused] = createSignal(0);
	const [navigatingList, setNavigatingList] = createSignal(false);
	const [picked, setPicked] = createSignal<Set<number>>(initialMultiSelectIndices(req.items, req.initialSelected));
	let listEl: HTMLDivElement | undefined;

	const indexed = req.items.map((item, index) => ({ item, index }));
	const filtered = createMemo(() => {
		const q = query().trim();
		if (!q) return indexed;
		return indexed
			.map((entry) => {
				const secondary = `${entry.item.detail ?? ""} ${entry.item.description ?? ""} ${entry.item.badge?.text ?? ""} ${entry.item.keywords ?? ""}`;
				return { entry, score: matchWords(q, entry.item.label, secondary) };
			})
			.filter((x) => x.score > 0)
			.sort((a, b) => b.score - a.score)
			.map((x) => x.entry);
	});

	createEffect(() => {
		const len = filtered().length;
		if (focused() >= len) setFocused(Math.max(0, len - 1));
	});
	createEffect(() => {
		const idx = focused();
		filtered();
		listEl?.children[idx]?.scrollIntoView({ block: "nearest" });
	});

	const finish = (values: any[] | null) => queue.finishOverlay(req, values);
	const confirm = () => finish(resolveMultiSelectValues(req.items, picked()));
	const move = (by: number) => {
		setNavigatingList(true);
		setFocused((i) => Math.max(0, Math.min(i + by, filtered().length - 1)));
	};
	const toggleIndex = (origIndex: number) => setPicked((cur) => toggleMultiSelectIndex(cur, origIndex));
	const toggleFocused = () => {
		const entry = filtered()[focused()];
		if (entry) toggleIndex(entry.index);
	};
	const selectAllVisible = () =>
		setPicked((cur) =>
			selectAllVisibleIndices(
				cur,
				filtered().map((entry) => entry.index),
			),
		);
	const clearAll = () => setPicked(new Set<number>());
	const allVisiblePicked = createMemo(() => {
		const cur = picked();
		const vis = filtered();
		return vis.length > 0 && vis.every((entry) => cur.has(entry.index));
	});
	const confirmText = () => {
		const base = req.confirmLabel?.trim() || "Confirm";
		return /\(enter\)/i.test(base) ? base : `${base} (Enter)`;
	};

	let pointer = "";
	const pointed = (e: MouseEvent, idx: number) => {
		const at = `${e.clientX},${e.clientY}`;
		if (at === pointer) return;
		pointer = at;
		setFocused(idx);
	};

	return (
		<Modal class="quickpick quickpick-dialog quickpick-many" top label={req.title} onClose={() => finish(null)}>
			<div class="quickpick-head">
				<span class="quickpick-title">{req.title}</span>
				<div class="quickpick-many-actions">
					<span class="quickpick-many-count" role="status" aria-live="polite">
						{picked().size} selected
					</span>
					<button
						type="button"
						class="quickpick-many-btn"
						disabled={!filtered().length || allVisiblePicked()}
						onClick={selectAllVisible}
					>
						Select all
					</button>
					<button
						type="button"
						class="quickpick-many-btn"
						disabled={picked().size === 0}
						onClick={clearAll}
					>
						Clear
					</button>
					<button type="button" class="quickpick-many-confirm primary" onClick={confirm}>
						{confirmText()}
					</button>
					<button type="button" class="quickpick-close" aria-label="Close" title="Close (Escape)" onClick={() => finish(null)}>
						<Icon name="close" />
					</button>
				</div>
			</div>
			<input
				data-autofocus
				class="quickpick-search"
				role="combobox"
				aria-label={req.title}
				aria-expanded="true"
				aria-controls={listId}
				aria-autocomplete="list"
				aria-activedescendant={filtered().length ? `${listId}-${focused()}` : undefined}
				autocomplete="off"
				spellcheck={false}
				placeholder={req.placeholder}
				value={query()}
				onInput={(e) => {
					setQuery(e.currentTarget.value);
					setFocused(0);
					setNavigatingList(false);
				}}
				onKeyDown={(e) => {
					if (e.key === "ArrowDown") (e.preventDefault(), move(1));
					else if (e.key === "ArrowUp") (e.preventDefault(), move(-1));
					else if (e.key === "PageDown") (e.preventDefault(), move(8));
					else if (e.key === "PageUp") (e.preventDefault(), move(-8));
					else if (e.key === "Home" && !query()) (e.preventDefault(), setNavigatingList(true), setFocused(0));
					else if (e.key === "End" && !query()) (e.preventDefault(), setNavigatingList(true), setFocused(Math.max(0, filtered().length - 1)));
					else if (e.key === " " && (!query() || navigatingList())) {
						e.preventDefault();
						toggleFocused();
					} else if (e.key === "Enter") {
						e.preventDefault();
						e.stopPropagation();
						confirm();
					}
				}}
			/>
			<div
				class="items"
				role="listbox"
				aria-multiselectable="true"
				id={listId}
				aria-label={req.title}
				ref={listEl}
				onKeyDown={(e) => {
					if (e.key === "ArrowDown") (e.preventDefault(), move(1));
					else if (e.key === "ArrowUp") (e.preventDefault(), move(-1));
					else if (e.key === " ") (e.preventDefault(), toggleFocused());
					else if (e.key === "Enter") (e.preventDefault(), e.stopPropagation(), confirm());
				}}
			>
				<For each={filtered()}>
					{(entry, i) => {
						const item = entry.item;
						const isChecked = () => picked().has(entry.index);
						return (
							<div
								class="item quick-multi-item"
								classList={{
									selected: i() === focused(),
									"quick-multi-checked": isChecked(),
									"quick-noted": Boolean(item.description),
									"quick-divide": Boolean(item.divide && !query().trim()),
									"quick-danger": Boolean(item.danger),
								}}
								role="option"
								id={`${listId}-${i()}`}
								aria-selected={isChecked()}
								onMouseMove={(e) => pointed(e, i())}
								onMouseDown={(e) => e.button === 0 && e.preventDefault()}
								onClick={() => {
									setFocused(i());
									toggleIndex(entry.index);
								}}
							>
								<span class="quick-checkbox" classList={{ checked: isChecked() }} aria-hidden="true">
									<Show when={isChecked()}>
										<Icon name="check" />
									</Show>
								</span>
								<Show when={item.file}>
									{(name) => <FileMark name={name()} />}
								</Show>
								<Show when={!item.file && item.icon}>
									{(icon) => <Icon name={icon() as IconName} class="quick-item-icon" />}
								</Show>
								<span class="label">{item.label}</span>
								<Show when={item.badge}>
									{(b) => <span class={`doc-status tone-${b().tone ?? "waiting"}`}>{b().text}</span>}
								</Show>
								<Show when={item.detail}>
									<span class="detail">{item.detail}</span>
								</Show>
								<Show when={item.description}>
									<span class="quick-note">{item.description}</span>
								</Show>
							</div>
						);
					}}
				</For>
			</div>
			<Show when={!filtered().length}>
				<div class="quick-status" role="status">
					{req.empty}
				</div>
			</Show>
		</Modal>
	);
}

type BrowserRow =
	| { kind: "up"; label: string; dir: string }
	| { kind: "dir"; label: string; path: string; rel: string; divide?: boolean }
	| { kind: "file"; label: string; path: string; rel: string; detail?: string; badge?: string; divide?: boolean };

function FileBrowserModal(props: { req: FileBrowserRequest }) {
	const req = props.req;
	const listId = createUniqueId();
	const [dir, setDir] = createSignal(req.initialDir);
	const [query, setQuery] = createSignal("");
	const [selected, setSelected] = createSignal(0);
	let listEl: HTMLDivElement | undefined;

	const [entries] = createResource(dir, (folder) =>
		backend.list(folder).catch(() => []),
	);
	const [allFiles] = createResource(
		() => Boolean(query().trim()),
		(need) => (need ? backend.files().catch(() => [] as string[]) : Promise.resolve([] as string[])),
	);

	const breadcrumbs = createMemo(() => {
		const rootName = baseName(req.root) || "Workspace";
		const rel = relativeTo(req.root, dir()).replace(/\\/g, "/");
		if (!rel || rel === ".") return [{ label: rootName, path: req.root }];
		const parts = rel.split("/").filter(Boolean);
		const out = [{ label: rootName, path: req.root }];
		let acc = req.root;
		const sep = req.root.includes("\\") ? "\\" : "/";
		for (const part of parts) {
			acc = acc.endsWith(sep) ? `${acc}${part}` : `${acc}${sep}${part}`;
			out.push({ label: part, path: acc });
		}
		return out;
	});

	const rows = createMemo<BrowserRow[]>(() => {
		const q = query().trim();
		if (q) {
			const wsFiles = allFiles() ?? [];
			const ranked: { row: Extract<BrowserRow, { kind: "file" }>; tier: number }[] = [];
			for (const full of wsFiles) {
				if (req.exclude.has(canonical(full))) continue;
				const rel = relativeTo(req.root, full).replace(/\\/g, "/");
				const tier = fileTier(q, rel);
				if (tier === null) continue;
				const name = baseName(full);
				const folder = rel.includes("/") ? rel.slice(0, rel.lastIndexOf("/")) : "";
				ranked.push({
					tier,
					row: { kind: "file", label: name, path: full, rel, detail: folder },
				});
			}
			ranked.sort((a, b) => a.tier - b.tier || a.row.rel.length - b.row.rel.length || a.row.label.localeCompare(b.row.label));
			return ranked.slice(0, 80).map((r) => r.row);
		}

		const out: BrowserRow[] = [];
		const atRoot = canonical(dir()) === canonical(req.root);
		if (atRoot && req.pinned.length) {
			const availPinned = req.pinned.filter((p) => !req.exclude.has(canonical(p.path)));
			for (const p of availPinned) {
				out.push({
					kind: "file",
					label: baseName(p.path),
					path: p.path,
					rel: p.rel,
					detail: p.detail ?? p.rel,
					badge: req.pinnedLabel,
				});
			}
		}
		if (!atRoot) {
			const parent = dirName(dir());
			if (isInside(req.root, parent)) {
				out.push({ kind: "up", label: "..", dir: parent });
			}
		}
		const list = (entries() ?? []).slice().sort((a, b) => {
			if (a.kind !== b.kind) return a.kind === "dir" ? -1 : 1;
			return a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: "base" });
		});
		let firstAfterPinned = out.length > 0 && atRoot;
		for (const e of list) {
			if (e.kind === "file" && req.exclude.has(canonical(e.path))) continue;
			const rel = relativeTo(req.root, e.path).replace(/\\/g, "/");
			if (e.kind === "dir") {
				out.push({ kind: "dir", label: e.name, path: e.path, rel, divide: firstAfterPinned });
			} else {
				out.push({ kind: "file", label: e.name, path: e.path, rel, detail: formatBytes(e.size), divide: firstAfterPinned });
			}
			firstAfterPinned = false;
		}
		return out;
	});

	createEffect(() => {
		const len = rows().length;
		if (selected() >= len) setSelected(Math.max(0, len - 1));
	});
	createEffect(() => {
		const idx = selected();
		rows();
		listEl?.children[idx]?.scrollIntoView({ block: "nearest" });
	});

	const finish = (picked: { path: string; rel: string } | null) => queue.finishOverlay(req, picked);
	const move = (by: number) => setSelected((i) => Math.max(0, Math.min(i + by, rows().length - 1)));
	const activate = (row: BrowserRow | undefined) => {
		if (!row) return;
		if (row.kind === "up") {
			setDir(row.dir);
			setSelected(0);
		} else if (row.kind === "dir") {
			setDir(row.path);
			setSelected(0);
		} else {
			finish({ path: row.path, rel: row.rel });
		}
	};

	let pointer = "";
	const pointed = (e: MouseEvent, idx: number) => {
		const at = `${e.clientX},${e.clientY}`;
		if (at === pointer) return;
		pointer = at;
		setSelected(idx);
	};

	return (
		<Modal class="quickpick quickpick-dialog file-browser-pick" top label={req.title} onClose={() => finish(null)}>
			<div class="quickpick-head">
				<span class="quickpick-title">{req.title}</span>
				<button type="button" class="quickpick-close" aria-label="Close" title="Close (Escape)" onClick={() => finish(null)}>
					<Icon name="close" />
				</button>
			</div>
			<Show when={!query().trim()}>
				<nav class="file-browser-crumbs" aria-label="Current folder">
					<For each={breadcrumbs()}>
						{(crumb, i) => (
							<>
								<Show when={i() > 0}>
									<Icon name="chevron-right" class="file-browser-crumb-sep" />
								</Show>
								<button
									type="button"
									class="file-browser-crumb"
									classList={{ current: i() === breadcrumbs().length - 1 }}
									onClick={() => (setDir(crumb.path), setSelected(0))}
								>
									{crumb.label}
								</button>
							</>
						)}
					</For>
				</nav>
			</Show>
			<input
				data-autofocus
				role="combobox"
				aria-label={req.title}
				aria-expanded="true"
				aria-controls={listId}
				aria-autocomplete="list"
				aria-activedescendant={rows().length ? `${listId}-${selected()}` : undefined}
				autocomplete="off"
				spellcheck={false}
				placeholder="Type to search any workspace file, or browse folders below…"
				value={query()}
				onInput={(e) => (setQuery(e.currentTarget.value), setSelected(0))}
				onKeyDown={(e) => {
					if (e.key === "ArrowDown") (e.preventDefault(), move(1));
					else if (e.key === "ArrowUp") (e.preventDefault(), move(-1));
					else if (e.key === "PageDown") (e.preventDefault(), move(8));
					else if (e.key === "PageUp") (e.preventDefault(), move(-8));
					else if (e.key === "Backspace" && !query() && canonical(dir()) !== canonical(req.root)) {
						e.preventDefault();
						const parent = dirName(dir());
						if (isInside(req.root, parent)) (setDir(parent), setSelected(0));
					} else if (e.key === "Enter") {
						e.preventDefault();
						e.stopPropagation();
						activate(rows()[selected()]);
					}
				}}
			/>
			<div class="items" role="listbox" id={listId} aria-label={req.title} ref={listEl}>
				<For each={rows()}>
					{(row, i) => (
						<div
							class="item"
							classList={{
								selected: i() === selected(),
								"quick-divide": row.kind !== "up" && Boolean(row.divide),
							}}
							role="option"
							id={`${listId}-${i()}`}
							aria-selected={i() === selected()}
							onMouseMove={(e) => pointed(e, i())}
							onMouseDown={(e) => e.button === 0 && (e.preventDefault(), activate(row))}
						>
							<Show when={row.kind === "up"}>
								<Icon name="arrow-up" class="quick-item-icon" />
								<span class="label">..</span>
								<span class="detail">Up one folder</span>
							</Show>
							<Show when={row.kind === "dir"}>
								<Icon name="folder" class="quick-item-icon" />
								<span class="label">{row.label}/</span>
								<Icon name="chevron-right" class="file-browser-dir-arrow" />
							</Show>
							<Show when={row.kind === "file"}>
								<FileMark name={row.label} />
								<span class="label">{row.label}</span>
								<Show when={row.kind === "file" && row.badge}>
									<span class="doc-status tone-active">{(row as Extract<BrowserRow, { kind: "file" }>).badge}</span>
								</Show>
								<Show when={row.kind === "file" && row.detail}>
									<span class="detail">{(row as Extract<BrowserRow, { kind: "file" }>).detail}</span>
								</Show>
							</Show>
						</div>
					)}
				</For>
			</div>
			<Show when={entries.loading || (query().trim() && allFiles.loading)}>
				<div class="quick-status" role="status">
					Loading files…
				</div>
			</Show>
			<Show when={!entries.loading && !(query().trim() && allFiles.loading) && !rows().length}>
				<div class="quick-status" role="status">
					{query().trim() ? `No workspace files match “${query().trim()}”.` : "This folder has no attachable files."}
				</div>
			</Show>
		</Modal>
	);
}

function ChooseQuickPick(props: { request: Request }) {
	const request = props.request;
	const listId = createUniqueId();
	const searchable = true;
	const [query, setQuery] = createSignal("");
	const [selected, setSelected] = createSignal(0);
	let listEl: HTMLDivElement | undefined;

	const filtered = createMemo(() => {
		const q = query().trim();
		if (!q) return request.buttons;
		return request.buttons
			.map((b) => ({ button: b, score: matchWords(q, b, request.details?.[b] ?? "") }))
			.filter((x) => x.score > 0)
			.sort((a, b) => b.score - a.score)
			.map((x) => x.button);
	});

	createEffect(() => {
		const len = filtered().length;
		if (selected() >= len) setSelected(Math.max(0, len - 1));
	});
	createEffect(() => {
		const idx = selected();
		filtered();
		listEl?.children[idx]?.scrollIntoView({ block: "nearest" });
	});

	const finish = (button: string | null) => queue.finish(request, button ? { button, value: "" } : null);
	const pick = (button: string | undefined) => {
		if (!button) return;
		finish(button);
	};
	const move = (by: number) => setSelected((i) => Math.max(0, Math.min(i + by, filtered().length - 1)));

	let pointer = "";
	const pointed = (e: MouseEvent, idx: number) => {
		const at = `${e.clientX},${e.clientY}`;
		if (at === pointer) return;
		pointer = at;
		setSelected(idx);
	};

	return (
		<Modal class="quickpick quickpick-dialog" top label={request.title} onClose={() => finish(null)}>
			<div class="quickpick-head">
				<span class="quickpick-title">{request.title}</span>
				<button type="button" class="quickpick-close" aria-label="Cancel" title="Cancel (Escape)" onClick={() => finish(null)}>
					<Icon name="close" />
				</button>
			</div>
			<Show when={searchable}>
				<input
					data-autofocus
					role="combobox"
					aria-label={request.title}
					aria-expanded="true"
					aria-controls={listId}
					aria-autocomplete="list"
					aria-activedescendant={filtered().length ? `${listId}-${selected()}` : undefined}
					autocomplete="off"
					spellcheck={false}
					placeholder="Type to filter options…"
					value={query()}
					onInput={(e) => (setQuery(e.currentTarget.value), setSelected(0))}
					onKeyDown={(e) => {
						if (e.key === "ArrowDown") (e.preventDefault(), move(1));
						else if (e.key === "ArrowUp") (e.preventDefault(), move(-1));
						else if (e.key === "PageDown") (e.preventDefault(), move(8));
						else if (e.key === "PageUp") (e.preventDefault(), move(-8));
						else if (e.key === "Home" && !query()) (e.preventDefault(), setSelected(0));
						else if (e.key === "End" && !query()) (e.preventDefault(), setSelected(Math.max(0, filtered().length - 1)));
						else if (e.key === "Enter") (e.preventDefault(), e.stopPropagation(), pick(filtered()[selected()]));
					}}
				/>
			</Show>
			<div class="items" role="listbox" id={listId} aria-label={request.title} ref={listEl}>
				<For each={filtered()}>
					{(button, i) => (
						<div
							class="item"
							classList={{
								selected: i() === selected(),
								"quick-noted": Boolean(request.details?.[button]),
								"quick-danger": button === request.danger,
							}}
							role="option"
							id={`${listId}-${i()}`}
							aria-selected={i() === selected()}
							onMouseMove={(e) => pointed(e, i())}
							onMouseDown={(e) => e.button === 0 && (e.preventDefault(), finish(button))}
						>
							<span class="label">{button}</span>
							<Show when={request.details?.[button]}>
								<span class="quick-note">{request.details![button]}</span>
							</Show>
						</div>
					)}
				</For>
			</div>
			<Show when={!filtered().length}>
				<div class="quick-status" role="status">
					No options match “{query().trim()}”.
				</div>
			</Show>
		</Modal>
	);
}

function Dialog(props: { request: Request }) {
	const request = props.request;
	if (!request.input && shouldUseQuickPick(request.buttons, request.details)) {
		return <ChooseQuickPick request={request} />;
	}
	const titleId = createUniqueId();
	const inputId = createUniqueId();
	let input: HTMLInputElement | undefined;
	const enter = defaultButton(request);
	const finish = (button: string | null) => queue.finish(request, button ? { button, value: input?.value ?? "" } : null);
	return (
		<Modal
			class="dialog"
			labelledBy={titleId}
			onClose={() => finish(null)}
			onSubmit={(e) => {
				e.preventDefault();
				finish(enter);
			}}
		>
			<Show
				when={request.input}
				fallback={
					<p class="dialog-message" id={titleId}>
						{request.title}
					</p>
				}
			>
				<label for={inputId}>
					<span id={titleId}>{request.title}</span>
					<input id={inputId} ref={input} value={request.value ?? ""} data-autofocus="select" autocomplete="off" spellcheck={false} />
				</label>
			</Show>
			<div class="buttons" classList={{ list: Boolean(request.details) }}>
				<For each={request.buttons}>
					{(button) => (
						<button
							type={button === enter ? "submit" : "button"}
							classList={{ primary: button === enter, danger: button === request.danger }}
							data-autofocus={!request.input && button === enter ? "" : undefined}
							onClick={() => button !== enter && finish(button)}
						>
							{button}
							<Show when={request.details?.[button]}>
								<span class="detail">{request.details![button]}</span>
							</Show>
						</button>
					)}
				</For>
				<button type="button" classList={{ primary: enter === null }} data-autofocus={!request.input && enter === null ? "" : undefined} onClick={() => finish(null)}>
					Cancel
				</button>
			</div>
		</Modal>
	);
}

export function Dialogs() {
	return (
		<Show when={activeOverlay()} keyed>
			{(active) =>
				active.kind === "dialog" ? (
					<Dialog request={active} />
				) : active.kind === "pick" ? (
					<QuickPickModal req={active} />
				) : active.kind === "pick-many" ? (
					<QuickPickManyModal req={active} />
				) : (
					<FileBrowserModal req={active} />
				)
			}
		</Show>
	);
}
