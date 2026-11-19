// A Markdown document, rendered. It is a reading view of the text in the
// editor (ADR 0002): the Text switch edits it, and this follows.
import { createMemo, createSignal, For, onCleanup, Show } from "solid-js";
import DOMPurify from "dompurify";
import { marked } from "marked";
import { headingAnchor } from "../../shared/docTables";
import { finishMarkdown, outlineOf } from "./markdownHtml";
import { dirName, isInside, resolvePath } from "../../shared/paths";
import { documents, openFile, state } from "../state";

export function MarkdownView(props: { path: string }) {
	const model = documents.get(props.path)?.model;
	const [text, setText] = createSignal(model?.getValue() ?? "");
	const listener = model?.onDidChangeContent(() => setText(model.getValue()));
	onCleanup(() => listener?.dispose());
	// A README can come from anywhere: its HTML is cleaned before it is shown.
	const html = createMemo(() => finishMarkdown(DOMPurify.sanitize(marked.parse(text(), { async: false, gfm: true }) as string), { anchors: true }));

	/** Links to files in the workspace open as tabs; web links open outside. */
	const follow = (e: MouseEvent) => {
		const link = (e.target as HTMLElement).closest("a");
		if (!link) return;
		e.preventDefault();
		const href = link.getAttribute("href") ?? "";
		if (/^https?:/i.test(href)) return void window.open(href, "_blank", "noopener");
		// A link to a heading in this document goes there.
		if (href.startsWith("#")) {
			const target = decodeURIComponent(href.slice(1));
			const heading = [...view.querySelectorAll<HTMLElement>("h1, h2, h3, h4, h5, h6")].find((h) => h.id === target || h.id === headingAnchor(target));
			heading?.scrollIntoView({ block: "start" });
			return;
		}
		if (!href || /^[a-z][a-z0-9+.-]*:/i.test(href)) return;
		const target = resolvePath(dirName(props.path), decodeURIComponent(href.split(/[?#]/)[0]!));
		if (state.workspace && isInside(state.workspace.root, target)) void openFile(target);
	};

	let view!: HTMLDivElement;
	/** The document's headings, down to the third level, for the list beside it. */
	const headings = createMemo(() => outlineOf(html()));
	/** The heading the reader is at or past: the last one above the top of the view. */
	const [at, setAt] = createSignal("");
	const follows = () => {
		const top = view.getBoundingClientRect().top + 24;
		let last = "";
		for (const h of view.querySelectorAll<HTMLElement>(".md h1, .md h2, .md h3")) {
			if (h.getBoundingClientRect().top > top) break;
			last = h.id;
		}
		setAt(last || (headings()[0]?.id ?? ""));
	};
	const go = (id: string) => [...view.querySelectorAll<HTMLElement>(".md h1, .md h2, .md h3")].find((h) => h.id === id)?.scrollIntoView({ block: "start" });
	return (
		<div class="md-view" ref={view} tabindex={0} aria-label={`${props.path.split(/[\\/]/).pop()}, rendered`} onScroll={follows}>
			<div class="md-page">
				<article class="md" innerHTML={html()} onClick={follow} />
				{/* A document with a few headings gets a list of them beside it, where the view is wide enough. */}
				<Show when={headings().length >= 3}>
					<nav class="md-outline" aria-label="On this page">
						<h2>On this page</h2>
						<ul>
							<For each={headings()}>
								{(h) => (
									<li class={`level-${h.level}`}>
										<button classList={{ on: (at() || headings()[0]!.id) === h.id }} aria-current={(at() || headings()[0]!.id) === h.id ? "location" : undefined} title={h.text} onClick={() => go(h.id)}>
											{h.text}
										</button>
									</li>
								)}
							</For>
						</ul>
					</nav>
				</Show>
			</div>
		</div>
	);
}
