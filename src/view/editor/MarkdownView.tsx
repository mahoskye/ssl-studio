// A Markdown document, rendered. It is a reading view of the text in the
// editor (ADR 0002): the Text switch edits it, and this follows.
import { createMemo, createSignal, onCleanup } from "solid-js";
import DOMPurify from "dompurify";
import { marked } from "marked";
import { headingAnchor } from "../../shared/docTables";
import { finishMarkdown } from "./markdownHtml";
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
	return (
		<div class="md-view" ref={view} tabindex={0} aria-label={`${props.path.split(/[\\/]/).pop()}, rendered`}>
			<article class="md" innerHTML={html()} onClick={follow} />
		</div>
	);
}
