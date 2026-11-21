// Persistent Tucked Folio tab strip for workspace-level center views (Call Graph,
// Diff Review, Projects switcher) so open document tabs stay one click away
// inside the same framed Folio Bento island (ADR 0027).
import { createEffect, createMemo, createSignal, For, onCleanup, Show, type JSX } from "solid-js";
import { FileMark } from "../FileMark";
import { Icon, type IconName } from "../Icon";
import { closeTab, displayName, newUntitled, notify, setState, state } from "../state";
import { closeComparison, review } from "./Review";
import { tabLabels } from "./tabs";

export function CenterTabStrip(props: {
	title: string;
	tooltip?: string;
	icon: IconName;
	onClose: () => void;
	children: JSX.Element;
}) {
	const group = () => state.groups[state.activeGroup] ?? state.groups[0] ?? { tabs: [], active: null };
	const labels = createMemo(() => tabLabels(group().tabs, state.workspace?.root));

	let tabsHost: HTMLDivElement | undefined;
	const [canScrollLeft, setCanScrollLeft] = createSignal(false);
	const [canScrollRight, setCanScrollRight] = createSignal(false);
	const updateTabOverflow = () => {
		const el = tabsHost;
		if (!el) return (setCanScrollLeft(false), setCanScrollRight(false));
		setCanScrollLeft(el.scrollLeft > 2);
		setCanScrollRight(el.scrollLeft + el.clientWidth < el.scrollWidth - 2);
	};
	const scrollTabsBy = (delta: number) => {
		if (!tabsHost) return;
		tabsHost.scrollBy({ left: delta, behavior: "smooth" });
		setTimeout(updateTabOverflow, 180);
	};
	const bindTabsHost = (el: HTMLDivElement) => {
		tabsHost = el;
		const ro = typeof ResizeObserver !== "undefined" ? new ResizeObserver(() => updateTabOverflow()) : null;
		ro?.observe(el);
		queueMicrotask(() => {
			el.scrollLeft = el.scrollWidth;
			updateTabOverflow();
		});
		onCleanup(() => {
			ro?.disconnect();
			if (tabsHost === el) tabsHost = undefined;
		});
	};
	createEffect(() => {
		void group().tabs.length;
		queueMicrotask(updateTabOverflow);
	});

	const activateFile = (path: string) => {
		const activeReview = review();
		if (activeReview && !activeReview.compare) {
			notify("Accept or reject the open review before switching to another file.");
			return;
		}
		closeComparison();
		setState("centerView", "editors");
		setState("groups", state.activeGroup, "active", path);
	};

	return (
		<section
			class="group active virtual-group"
			classList={{ "first-tab-active": group().tabs.length === 0 }}
		>
			<div class="tabs-row">
				<Show when={canScrollLeft() || canScrollRight()}>
					<button
						class="tabs-scroll-btn"
						disabled={!canScrollLeft()}
						title="Scroll tabs left"
						aria-label="Scroll tabs left"
						onClick={() => scrollTabsBy(-180)}
					>
						<Icon name="chevron-left" />
					</button>
				</Show>
				<div class="tabs-scroll-wrap" classList={{ "can-left": canScrollLeft(), "can-right": canScrollRight() }}>
					<div
						ref={bindTabsHost}
						class="tabs"
						role="tablist"
						aria-label="Open files"
						onScroll={updateTabOverflow}
						onWheel={(e) => {
							if (!tabsHost || tabsHost.scrollWidth <= tabsHost.clientWidth) return;
							if (Math.abs(e.deltaY) >= Math.abs(e.deltaX)) {
								e.preventDefault();
								tabsHost.scrollLeft += e.deltaY;
								updateTabOverflow();
							}
						}}
						onDblClick={(e) => {
							if (e.target === e.currentTarget) {
								const activeReview = review();
								if (activeReview && !activeReview.compare) return;
								closeComparison();
								void newUntitled(state.activeGroup);
							}
						}}
					>
						<For each={group().tabs}>
							{(path) => (
								<div
									class="tab"
									role="tab"
									aria-selected="false"
									tabindex={-1}
									title={path}
									classList={{
										dirty: Boolean(state.dirty[path]),
										conflict: Boolean(state.conflicts[path]),
										pinned: Boolean(group().pinned?.includes(path)),
										preview: group().preview === path,
									}}
									onMouseDown={(e) => {
										if (e.button === 1) {
											e.preventDefault();
											void closeTab(path, state.activeGroup);
										} else {
											activateFile(path);
										}
									}}
								>
									<FileMark name={displayName(path)} />
									<span class="name">{labels().get(path) ?? displayName(path)}</span>
									<Show when={state.conflicts[path]}>
										<span class="conflict-mark" aria-label="changed on disk">
											!
										</span>
									</Show>
									<Show when={group().pinned?.includes(path) && state.dirty[path]}>
										<span class="pinned-dot" aria-hidden="true">
											<span class="dot" />
										</span>
									</Show>
									<button
										class="close"
										tabindex={-1}
										title="Close"
										aria-label={`Close ${displayName(path)}`}
										onMouseDown={(e) => e.stopPropagation()}
										onClick={() => void closeTab(path, state.activeGroup)}
									>
										<span class="dot" aria-hidden="true" />
										<Icon name="close" class="x" />
									</button>
								</div>
							)}
						</For>
						<div
							class="tab active virtual-tab"
							role="tab"
							aria-selected="true"
							tabindex={0}
							title={props.tooltip ?? props.title}
							onKeyDown={(e) => {
								if (e.key === "Escape") {
									e.preventDefault();
									props.onClose();
								}
							}}
						>
							<Icon name={props.icon} class="virtual-tab-icon" />
							<span class="name">{props.title}</span>
							<button
								class="close"
								tabindex={-1}
								title={`Close ${props.title}`}
								aria-label={`Close ${props.title}`}
								onMouseDown={(e) => e.stopPropagation()}
								onClick={props.onClose}
							>
								<Icon name="close" class="x" />
							</button>
						</div>
					</div>
				</div>
				<Show when={canScrollLeft() || canScrollRight()}>
					<button
						class="tabs-scroll-btn"
						disabled={!canScrollRight()}
						title="Scroll tabs right"
						aria-label="Scroll tabs right"
						onClick={() => scrollTabsBy(180)}
					>
						<Icon name="chevron-right" />
					</button>
				</Show>
			</div>
			<div class="editor-sheet">{props.children}</div>
		</section>
	);
}
