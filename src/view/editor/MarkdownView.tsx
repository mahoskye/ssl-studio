// A Markdown document, rendered. It is a reading view of the text in the
// editor (ADR 0002): the Text switch edits it, and this follows.
import { createEffect, createMemo, createSignal, For, on, onCleanup, Show } from "solid-js";
import DOMPurify from "dompurify";
import { marked } from "marked";
import { linkFile } from "../../shared/docLinks";
import { headingAnchor } from "../../shared/docTables";
import { finishMarkdown, outlineOf, type TicketRef } from "./markdownHtml";
import { frontMatter, plainMarkdown } from "../../shared/frontMatter";
import { dirName, isInside, joinPath, relativePath, resolvePath } from "../../shared/paths";
import { DOC_FOLDERS, linkedLines, statusChoices, toneOf } from "../../shared/projectDocs";
import { Menu } from "../Menu";
import { setStatus, tickTask } from "../projectDocs";
import { tasks } from "../../shared/tasks";
import { colourCode } from "./markdownCode";
import { ticketWork } from "../../shared/workContext";
import { docs } from "../project";
import { outline, type OutlineItem } from "../../shared/outline";
import { canonical, documents, openFile, revealSignal, state } from "../state";

export function MarkdownView(props: { path: string }) {
	const model = documents.get(props.path)?.model;
	const [text, setText] = createSignal(model?.getValue() ?? "");
	const listener = model?.onDidChangeContent(() => setText(model.getValue()));
	onCleanup(() => listener?.dispose());
	// A README can come from anywhere: its HTML is cleaned before it is shown.
	// What the document says of itself in the lines it opens with is shown as a heading of its own, not as text.
	const front = createMemo(() => frontMatter(text()));
	/**
	 * The project's other tickets, as this page links to them where the prose names one: each by its key, with what it
	 * is in a line. The same list is the same page: a listing read again does not draw the page again.
	 */
	const mentioned = createMemo(
		(): TicketRef[] =>
			docs()
				.filter((d) => d.group === "tickets" && d.exists && d.ticket && canonical(d.path) !== props.path)
				.map((d) => {
					const title = d.title ?? "";
					const named = title.toLowerCase().startsWith(d.ticket!.toLowerCase()) ? title : [d.ticket, title].filter(Boolean).join(": ");
					return { key: d.ticket!, href: encodeURI(relativePath(dirName(props.path), d.path)), about: `${named}${d.status ? ` (${d.status})` : ""}` };
				}),
		[],
		{ equals: (a, b) => JSON.stringify(a) === JSON.stringify(b) },
	);
	const html = createMemo(() => finishMarkdown(DOMPurify.sanitize(marked.parse(front().body, { async: false, gfm: true }) as string), { anchors: true, tickets: mentioned() }));
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
	/** A ticket's page shows what is tied to it: its plans and specs, the tickets around it, the questions and the decisions (ADR 0012). */
	const ticket = createMemo(() => {
		const file = docs().find((d) => d.group === "tickets" && d.ticket && canonical(d.path) === props.path);
		return file?.ticket ?? "";
	});
	const work = createMemo(() => (ticket() ? ticketWork(docs(), ticket()) : []));
	/** This document among the project's tickets, specs and knowledge base, if it is one of them: those have a state that is kept in their catalog. */
	const listed = createMemo(() => docs().find((d) => ["tickets", "specs", "knowledge"].includes(d.group) && canonical(d.path) === props.path));
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
		const file = linkFile(href);
		if (!file) return;
		// A path from the top is from the project's top, as a repository's page reads it.
		const target = file.startsWith("/") && state.workspace ? joinPath(state.workspace.root, ...file.split("/").filter(Boolean)) : resolvePath(dirName(props.path), file);
		// A link to lines of a file opens the file at them: "#L12", "#L12-L18".
		const lines = linkedLines(href);
		if (state.workspace && isInside(state.workspace.root, target)) void openFile(target, lines ? { reveal: lines } : {});
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
	/**
	 * A place in the text asked for from elsewhere (a heading in the Objects panel, a link to a line) is shown here as
	 * the heading that line is under: the editor behind this view has taken the cursor there.
	 */
	const flat = (items: OutlineItem[]): OutlineItem[] => items.flatMap((item) => [item, ...flat(item.children)]);
	const stopReveal = revealSignal.listen((path) => {
		if (path !== props.path) return;
		queueMicrotask(() => {
			const all = flat(outline("markdown", text()));
			const at = all.findLastIndex((item) => item.line <= state.cursor.line);
			if (at < 0) return;
			// By its words, and which of that name it is: the page may have headings the outline does not count.
			const name = all[at]!.name;
			const which = all.slice(0, at).filter((item) => item.name === name).length;
			const same = [...view.querySelectorAll<HTMLElement>(".md h1, .md h2, .md h3, .md h4, .md h5, .md h6")].filter((h) => plainMarkdown(h.textContent ?? "") === name);
			// Failing that (a heading written with escapes or an image), the heading of that place in the page.
			(same[which] ?? same[0] ?? view.querySelectorAll<HTMLElement>(".md h1, .md h2, .md h3, .md h4, .md h5, .md h6")[at])?.scrollIntoView({ block: "start" });
		});
	});
	onCleanup(stopReveal);
	const goTo = (id: string) => [...view.querySelectorAll<HTMLElement>(".md h1, .md h2, .md h3")].find((h) => h.id === id)?.scrollIntoView({ block: "start" });
	// Code in the document is coloured as the editor colours it, each block in its own language.
	let article!: HTMLElement;
	/** The links of this document that lead to a file that is not there, as the project's listing has them. */
	const broken = createMemo(() => new Set((docs().find((d) => canonical(d.path) === props.path)?.broken ?? []).map((link) => linkFile(link.href))));
	/** Each such link says so on the page, before it is clicked. */
	const markBroken = () => {
		if (!article) return;
		for (const link of article.querySelectorAll<HTMLAnchorElement>("a[href]")) {
			const file = linkFile(link.getAttribute("href") ?? "");
			const gone = Boolean(file) && broken().has(file);
			link.classList.toggle("broken", gone);
			if (gone) link.title = `Nothing is there: ${file}`;
			else if (link.title.startsWith("Nothing is there: ")) link.removeAttribute("title");
		}
	};
	// The listing is read again after a save or a change in the folder: the marks follow it.
	createEffect(on(broken, markBroken, { defer: true }));
	createEffect(
		on(html, () =>
			queueMicrotask(() => {
				if (!article) return;
				void colourCode(article);
				markBroken();
				// A task list's boxes can be ticked here: each is the item of that place in the text. Where the page and the
				// text do not count the same items, the boxes stay as the renderer made them, for reading only.
				const boxes = [...article.querySelectorAll<HTMLInputElement>('li > input[type="checkbox"], li > p > input[type="checkbox"]')];
				const items = tasks(text());
				// Each box must be an item that has a place in the text, and the page must not have been wired already.
				if (boxes.length !== items.length || items.some((item) => item.offset < 0) || boxes.some((box) => box.dataset.task)) return;
				boxes.forEach((box, index) => {
					box.dataset.task = String(index);
					box.disabled = false;
					box.setAttribute("aria-label", `${items[index]!.done ? "Done" : "Not done"}: ${items[index]!.text}`);
					box.addEventListener("change", () => void tickTask(props.path, index));
				});
			}),
		),
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
														<Show
															when={target.file || target.web}
															fallback={
																<Show when={fact.key === "status" && listed()} fallback={<span classList={{ "doc-status": fact.key === "status", [`tone-${toneOf(value)}`]: fact.key === "status" }}>{value}</span>}>
																	{/* One of the project's working documents: its state is changed here, without going to the text. */}
																	<Menu
																		class="md-status"
																		label={`Status: ${value}. Change it`}
																		title="Change the status"
																		items={() => statusChoices(listed()).map((status) => ({ label: status, disabled: status.toLowerCase() === value.toLowerCase(), why: "It is this already", run: () => void setStatus(props.path, status) }))}
																	>
																		<span class={`doc-status tone-${toneOf(value)}`}>{value}</span>
																		<span aria-hidden="true"> ▾</span>
																	</Menu>
																</Show>
															}
														>
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
					<Show when={work().length}>
						<section class="md-work" aria-label={`The work for ${ticket()}`}>
							<h2>The work for {ticket()}</h2>
							<For each={work()}>
								{(group) => (
									<div class="md-work-group">
										<h3>{group.name}</h3>
										<ul>
											<For each={group.files}>
												{(file) => (
													<li>
														<button class="link" title={[file.path, file.summary].filter(Boolean).join("\n")} onClick={() => void openFile(file.path)}>
															{file.ticket && !file.title?.startsWith(file.ticket) ? `${file.ticket}: ` : ""}
															{file.title || file.name.replace(/\.plan\.json$/i, "")}
														</button>
														<Show when={file.status}>
															<span class={`doc-status tone-${toneOf(file.status)}`}>{file.status}</span>
														</Show>
													</li>
												)}
											</For>
										</ul>
									</div>
								)}
							</For>
						</section>
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
