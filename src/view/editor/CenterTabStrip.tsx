// Persistent Tucked Folio tab strip for workspace-level center views (Call Graph,
// Diff Review, Projects switcher) so open document tabs stay one click away
// inside the same framed Folio Bento island (ADR 0027).
import { createEffect, createMemo, createSignal, For, onSettled, Show } from "solid-js";
import type { JSX } from "@solidjs/web";
import { submenuOrInline, type RowMenuEntry } from "../../shared/contextMenu";
import { createMiddleCloseTracker } from "../../shared/middleClickGuard";
import { isInside, joinPath } from "../../shared/paths";
import { othersOf, rightOf } from "../../shared/tabOrder";
import { FileMark } from "../FileMark";
import { Icon, type IconName } from "../Icon";
import { chooseFromMenu } from "../panels/RowMenu";
import { canonical, closeTab, displayName, isUntitled, keepTab, newUntitled, notify, setState, state, togglePin } from "../state";
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
	const middleClose = createMiddleCloseTracker();
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
	onSettled(() => {
		const el = tabsHost;
		const ro = el && typeof ResizeObserver !== "undefined" ? new ResizeObserver(() => updateTabOverflow()) : null;
		if (el) {
			ro?.observe(el);
			el.scrollLeft = el.scrollWidth;
			updateTabOverflow();
		}
		return () => {
			ro?.disconnect();
			if (el && tabsHost === el) tabsHost = undefined;
			middleClose.dispose();
		};
	});
	createEffect(
		() => group().tabs.length,
		() => {
			queueMicrotask(updateTabOverflow);
		},
	);

	const reviewedTargetPath = (): string | null => {
		const activeReview = review();
		if (!activeReview || activeReview.compare || !activeReview.path) return null;
		const raw = activeReview.path;
		if (raw.startsWith("untitled:")) return raw;
		const root = state.workspace?.root;
		if (root && !isInside(root, raw) && !raw.startsWith("/") && !/^[A-Za-z]:[\\/]/.test(raw)) {
			return canonical(joinPath(root, ...raw.split(/[\\/]/)));
		}
		return canonical(raw);
	};

	const isBlockedByReview = (path: string): boolean => {
		const target = reviewedTargetPath();
		return Boolean(target && canonical(path) === target);
	};

	const tryCloseTab = async (path: string, groupIdx: number) => {
		if (isBlockedByReview(path)) {
			notify("Accept or reject the open review before closing this file.");
			return false;
		}
		return closeTab(path, groupIdx);
	};

	const tryCloseTabs = async (paths: readonly string[], groupIdx: number) => {
		for (const p of paths) {
			if (!(await tryCloseTab(p, groupIdx))) return;
		}
	};

	const activateFile = (path: string) => {
		const activeReview = review();
		if (activeReview && !activeReview.compare) {
			notify("Accept or reject the open review before switching to another file.");
			return;
		}
		closeComparison();
		setState((s) => {
			s.centerView = "editors";
			const g = s.groups[s.activeGroup];
			if (g) g.active = path;
		});
	};

	const openTabMenu = async (path: string, at: { x: number; y: number }) => {
		const gIdx = state.activeGroup;
		const g = group();
		const isPinned = Boolean(g.pinned?.includes(path));
		const CLOSE = "Close";
		const OTHERS = "Close others";
		const RIGHT = "Close to the right";
		const ALL = "Close all";
		const PIN = isPinned ? "Unpin" : "Pin";
		const KEEP = "Keep open";
		const PATH = "Copy path";
		const RELATIVE = "Copy path in the project";
		const NAME = "Copy file name";
		const SHOW = "Show in the Explorer";
		const untitled = isUntitled(path);
		const inFolder = !untitled && Boolean(state.workspace && isInside(state.workspace.root, path));
		const bulkClose: RowMenuEntry[] = [
			...(othersOf(g.tabs, g.pinned ?? [], path).length ? [OTHERS] : []),
			...(rightOf(g.tabs, g.pinned ?? [], path).length ? [RIGHT] : []),
			ALL,
		];
		const items: RowMenuEntry[] = [
			...(isPinned ? [] : [{ label: CLOSE, value: CLOSE, keys: "Ctrl+W" }]),
			...submenuOrInline("Close tabs", bulkClose),
			"separator",
			...(g.preview === path ? [KEEP] : []),
			PIN,
			"separator",
			...submenuOrInline("Copy path", [...(untitled ? [] : [PATH]), ...(inFolder ? [RELATIVE] : []), NAME]),
			...(inFolder ? [SHOW] : []),
		];
		const picked = await chooseFromMenu(`Actions for the tab ${displayName(path)}`, items, at);
		if (!picked) return;
		const latestGroup = state.groups[gIdx];
		if (picked === CLOSE) await tryCloseTab(path, gIdx);
		else if (picked === KEEP) keepTab(path, gIdx);
		else if (picked === OTHERS) await tryCloseTabs(othersOf(latestGroup?.tabs ?? [], latestGroup?.pinned ?? [], path), gIdx);
		else if (picked === RIGHT) await tryCloseTabs(rightOf(latestGroup?.tabs ?? [], latestGroup?.pinned ?? [], path), gIdx);
		else if (picked === ALL) await tryCloseTabs(othersOf(latestGroup?.tabs ?? [], latestGroup?.pinned ?? [], null), gIdx);
		else if (picked === PIN) togglePin(path, gIdx);
		else if (picked === PATH || picked === RELATIVE || picked === NAME) {
			await (await import("../commands")).copyPath(picked === PATH ? "whole" : picked === NAME ? "name" : "relative", path);
		} else if (picked === SHOW) (await import("../panels/Explorer")).showInExplorer(path);
	};

	return (
		<section
			class={["group active virtual-group", { "first-tab-active": group().tabs.length === 0 }]}
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
				<div class={["tabs-scroll-wrap", { "can-left": canScrollLeft(), "can-right": canScrollRight() }]}>
					<div
						ref={tabsHost}
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
									class={[
										"tab",
										{
											dirty: Boolean(state.dirty[path]),
											conflict: Boolean(state.conflicts[path]),
											pinned: Boolean(group().pinned?.includes(path)),
											preview: group().preview === path,
										},
									]}
									role="tab"
									aria-selected="false"
									tabindex={-1}
									title={path}
									onMouseDown={(e) => {
										if (e.button === 1) {
											e.preventDefault();
											e.stopPropagation();
											middleClose.press(path);
										} else if (e.button === 0) {
											middleClose.cancel();
											activateFile(path);
										} else {
											middleClose.cancel();
										}
									}}
									onMouseLeave={() => middleClose.cancel(path)}
									onMouseUp={(e) => {
										if (e.button !== 1) return;
										e.preventDefault();
										e.stopPropagation();
										middleClose.release(path, () => void tryCloseTab(path, state.activeGroup));
									}}
									onAuxClick={(e) => {
										if (e.button !== 1) return;
										e.preventDefault();
										e.stopPropagation();
										middleClose.auxClick(path, () => void tryCloseTab(path, state.activeGroup));
									}}
									onContextMenu={(e) => {
										e.preventDefault();
										void openTabMenu(path, { x: e.clientX, y: e.clientY });
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
									<Show when={group().pinned?.includes(path)}>
										<button
											class="pin"
											tabindex={-1}
											title="Pinned. Unpin"
											aria-label={`Unpin ${displayName(path)}${state.dirty[path] ? " (unsaved changes)" : ""}`}
											onMouseDown={(e) => e.button !== 1 && e.stopPropagation()}
											onClick={() => togglePin(path, state.activeGroup)}
										>
											<span class="pin-mark" aria-hidden="true" />
										</button>
									</Show>
									<button
										class="close"
										tabindex={-1}
										title="Close"
										aria-label={`Close ${displayName(path)}`}
										onMouseDown={(e) => e.button !== 1 && e.stopPropagation()}
										onClick={() => void tryCloseTab(path, state.activeGroup)}
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
							onMouseDown={(e) => {
								if (e.button === 1) {
									e.preventDefault();
									e.stopPropagation();
									middleClose.press("__virtual__");
								}
							}}
							onMouseLeave={() => middleClose.cancel("__virtual__")}
							onMouseUp={(e) => {
								if (e.button !== 1) return;
								e.preventDefault();
								e.stopPropagation();
								middleClose.release("__virtual__", () => props.onClose());
							}}
							onAuxClick={(e) => {
								if (e.button !== 1) return;
								e.preventDefault();
								e.stopPropagation();
								middleClose.auxClick("__virtual__", () => props.onClose());
							}}
							onKeyDown={(e) => {
								if (e.key === "Escape") {
									e.preventDefault();
									props.onClose();
								}
							}}
							onContextMenu={(e) => {
								e.preventDefault();
								const CLOSE_VIEW = `Close ${props.title}`;
								void chooseFromMenu(`Actions for ${props.title}`, [{ label: CLOSE_VIEW, value: CLOSE_VIEW, keys: "Esc" }], { x: e.clientX, y: e.clientY }).then((picked) => {
									if (picked === CLOSE_VIEW) props.onClose();
								});
							}}
						>
							<Icon name={props.icon} class="virtual-tab-icon" />
							<span class="name">{props.title}</span>
							<button
								class="close"
								tabindex={-1}
								title={`Close ${props.title}`}
								aria-label={`Close ${props.title}`}
								onMouseDown={(e) => e.button !== 1 && e.stopPropagation()}
								onClick={() => props.onClose()}
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
