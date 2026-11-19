// A Markdown document, rendered. It is a reading view of the text in the
// editor (ADR 0002): the Text switch edits it, and this follows.
import { createEffect, createMemo, createSignal, For, on, onCleanup, Show } from "solid-js";
import DOMPurify from "dompurify";
import { marked } from "marked";
import { headingAnchor } from "../../shared/docTables";
import { finishMarkdown, outlineOf } from "./markdownHtml";
import { frontMatter } from "../../shared/frontMatter";
import { dirName, isInside, joinPath, resolvePath } from "../../shared/paths";
import { DOC_FOLDERS, toneOf } from "../../shared/projectDocs";
import { colourCode } from "./markdownCode";
import { documents, openFile, state } from "../state";

export function MarkdownView(props: { path: string }) {
	const model = documents.get(props.path)?.model;
	const [text, setText] = createSignal(model?.getValue() ?? "");
	const listener = model?.onDidChangeContent(() => setText(model.getValue()));
	onCleanup(() => listener?.dispose());
	// A README can come from anywhere: its HTML is cleaned before it is shown.
	// What the document says of itself in the lines it opens with is shown as a heading of its own, not as text.
	const front = createMemo(() => frontMatter(text()));
	const html = createMemo(() => finishMarkdown(DOMPurify.sanitize(marked.parse(front().body, { async: false, gfm: true }) as string), { anchors: true }));
	/** The front matter as it is shown: each key with its values, a ticket or a file as a link to it. */
	const facts = createMemo(() =>
		Object.entries(front().values)
			.filter(([key, value]) => key !== "title" && (Array.isArray(value) ? value.length : value))
			.map(([key, value]) => ({ key, values: Array.isArray(value) ? value : [value] })),
	);
	const ticketFile = (key: string) => (state.workspace && state.project ? joinPath(state.workspace.root, ...state.project.docs.split(/[\\/]/), DOC_FOLDERS.tickets, `${key}.md`) : "");
	/** Where a value leads, if anywhere: a ticket's file, a file of the project, a page outside. */
	const targetOf = (key: string, value: string): { file?: string; web?: string } => {
		if (/^https?:\/\//i.test(value)) return { web: value };
		if (["ticket", "tickets", "related", "parent", "blocks", "blocked-by"].includes(key)) return { file: ticketFile(value) };
		if (["specs", "spec", "plan", "plans"].includes(key) && state.workspace) return { file: joinPath(state.workspace.root, ...value.split("/")) };
		return {};
	};
	const go = (target: { file?: string; web?: string }) => (target.web ? void window.open(target.web, "_blank", "noopener") : target.file ? void openFile(target.file) : undefined);

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
	const goTo = (id: string) => [...view.querySelectorAll<HTMLElement>(".md h1, .md h2, .md h3")].find((h) => h.id === id)?.scrollIntoView({ block: "start" });
	// Code in the document is coloured as the editor colours it, each block in its own language.
	let article!: HTMLElement;
	createEffect(
		on(html, () => queueMicrotask(() => article && void colourCode(article))),
	);
	return (
		<div class="md-view" ref={view} tabindex={0} aria-label={`${props.path.split(/[\\/]/).pop()}, rendered`} onScroll={follows}>
			<div class="md-page">
				<div class="md-column">
					<Show when={facts().length}>
						<dl class="md-front" aria-label="About this document">
							<For each={facts()}>
								{(fact) => (
									<div>
										<dt>{fact.key}</dt>
										<dd>
											<For each={fact.values}>
												{(value) => {
													const target = targetOf(fact.key, value);
													return (
														<Show when={target.file || target.web} fallback={<span classList={{ "doc-status": fact.key === "status", [`tone-${toneOf(value)}`]: fact.key === "status" }}>{value}</span>}>
															<button class="link" title={target.web ?? target.file} onClick={() => go(target)}>
																{value}
															</button>
														</Show>
													);
												}}
											</For>
										</dd>
									</div>
								)}
							</For>
						</dl>
					</Show>
					<article class="md" ref={article} innerHTML={html()} onClick={follow} />
				</div>
				{/* A document with a few headings gets a list of them beside it, where the view is wide enough. */}
				<Show when={headings().length >= 3}>
					<nav class="md-outline" aria-label="On this page">
						<h2>On this page</h2>
						<ul>
							<For each={headings()}>
								{(h) => (
									<li class={`level-${h.level}`}>
										<button classList={{ on: (at() || headings()[0]!.id) === h.id }} aria-current={(at() || headings()[0]!.id) === h.id ? "location" : undefined} title={h.text} onClick={() => goTo(h.id)}>
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
