// A Markdown document, rendered. It is a reading view of the text in the
// editor (ADR 0002): the Text switch edits it, and this follows.
import { Icon } from "../Icon";
import { createEffect, createMemo, createResource, createSignal, For, on, onCleanup, Show } from "solid-js";
import DOMPurify from "dompurify";
import { marked } from "marked";
import { linkFile, linkLeads, linkWritten } from "../../shared/docLinks";
import { headingAnchor } from "../../shared/docTables";
import { docByName, linkedFrom } from "../../shared/namedLinks";
import { finishMarkdown, outlineOf, type NameResolver, type TicketRef } from "./markdownHtml";
import { frontMatter, plainMarkdown } from "../../shared/frontMatter";
import { dirName, isInside, joinPath, relativePath, relativeTo } from "../../shared/paths";
import { DOC_FOLDERS, registryTitle, statusChoices, toneOf } from "../../shared/projectDocs";
import { rowsLine } from "../../shared/registryTickets";
import { askRows } from "./tableRows";
import { Menu } from "../Menu";
import { setStatus, tickTask } from "../projectDocs";
import { tasks } from "../../shared/tasks";
import { colourCode } from "./markdownCode";
import { ticketWork } from "../../shared/workContext";
import { backend } from "../backend";
import { docs } from "../project";
import { outline, type OutlineItem } from "../../shared/outline";
import { canonical, documents, focusEditor, openFile, revealSignal, setState, state } from "../state";
import { chooseFromMenu } from "../panels/RowMenu";

export function MarkdownView(props: { path: string; /** The editor group the page is shown in. */ group?: number }) {
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
					return { key: d.ticket!, href: linkWritten(relativePath(dirName(props.path), d.path)), about: `${named}${d.status ? ` (${d.status})` : ""}` };
				}),
		[],
		{ equals: (a, b) => JSON.stringify(a) === JSON.stringify(b) },
	);
	/** Where a link by name leads from this document: to the document the name means, by its path from here. */
	const named: NameResolver = (name) => {
		const found = docByName(name, docs(), state.workspace?.root);
		if (!found) return null;
		const title = found.title ?? "";
		return { href: linkWritten(relativePath(dirName(props.path), found.path)), about: [found.ticket && !title.toLowerCase().startsWith(found.ticket.toLowerCase()) ? found.ticket : "", title || found.name].filter(Boolean).join(": ") };
	};
	/**
	 * The documents this one is linked from, by path or by a name that means it: asked of the files as they are on
	 * disk, again whenever the project's documents change. What is typed and not yet saved is not counted.
	 */
	const [linked] = createResource(
		() => ({ path: props.path, files: docs(), root: state.workspace?.root }),
		async ({ path, files, root }) => {
			if (!root) return [];
			try {
				const [byPath, byName] = await Promise.all([backend.linksTo(path), backend.namesIn()]);
				return linkedFrom(
					canonical(path),
					byPath.map((link) => ({ path: canonical(link.path), line: link.line })),
					byName.map((place) => ({ ...place, path: canonical(place.path) })),
					files.map((file) => ({ ...file, path: canonical(file.path) })),
					root,
				);
			} catch {
				return [];
			}
		},
	);
	/** What a document that links here is called in that list: a ticket by its key and title, another by its title or its name. */
	const called = (path: string) => {
		const file = docs().find((d) => canonical(d.path) === path);
		if (!file) return relativeTo(state.workspace?.root, path);
		const title = file.title || file.name;
		return file.ticket && !title.toLowerCase().startsWith(file.ticket.toLowerCase()) ? `${file.ticket}: ${title}` : title;
	};
	const html = createMemo(() => finishMarkdown(DOMPurify.sanitize(marked.parse(front().body, { async: false, gfm: true }) as string), { anchors: true, tickets: mentioned(), named }));
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
		const leads = linkLeads(link.getAttribute("href") ?? "", props.path, state.workspace?.root);
		if (!leads) return;
		if ("web" in leads) return void window.open(leads.web, "_blank", "noopener");
		// A link to a heading in this document goes there.
		if ("heading" in leads) {
			const heading = [...view.querySelectorAll<HTMLElement>("h1, h2, h3, h4, h5, h6")].find((h) => h.id === leads.heading || h.id === headingAnchor(leads.heading));
			heading?.scrollIntoView({ block: "start" });
			return;
		}
		// A link to lines of a file opens the file at them: "#L12", "#L12-L18".
		void openFile(leads.file, leads.lines ? { reveal: leads.lines } : {});
	};

	let view!: HTMLDivElement;
	/**
	 * What a right-click on the page offers (or the menu key, with the page holding the keyboard): the words selected
	 * and the link under the pointer first, then the document itself. The page is for reading, so one entry goes to
	 * its text.
	 */
	const pageMenu = async (e: MouseEvent) => {
		const on = e.target instanceof Element ? e.target : null;
		// A box on the page and a menu that is open on it keep what they have.
		if (on?.closest("input, textarea, .menu-pop")) return;
		e.preventDefault();
		const link = on?.closest<HTMLElement>(".md a[href]") ?? null;
		const selection = window.getSelection();
		const words = selection && !selection.isCollapsed && view.contains(selection.anchorNode) ? selection.toString() : "";
		const inFolder = Boolean(state.workspace && isInside(state.workspace.root, props.path));
		const COPY = "Copy";
		const OPEN = "Open link";
		const COPY_LINK = "Copy link";
		const EDIT = "Edit the text";
		const PATH = "Copy path";
		const RELATIVE = "Copy path in the project";
		const NAME = "Copy file name";
		const SHOW = "Show in the Explorer";
		const items = [...(words.trim() ? [COPY] : []), ...(link ? [OPEN, COPY_LINK] : []), EDIT, PATH, ...(inFolder ? [RELATIVE] : []), NAME, ...(inFolder ? [SHOW] : [])];
		const box = view.getBoundingClientRect();
		const picked = await chooseFromMenu(`Actions for ${props.path.split(/[\\/]/).pop()}`, items, e.clientX || e.clientY ? { x: e.clientX, y: e.clientY } : { x: box.left + 24, y: box.top + 24 });
		if (!picked) return;
		// The commands are loaded when asked for, because commands.ts imports the editors.
		const { copyPath, copyText } = await import("../commands");
		if (picked === COPY) await copyText(words, "Copied the selected text.");
		else if (picked === OPEN) link?.click();
		else if (picked === COPY_LINK) await copyText(link?.getAttribute("href") ?? "", "Copied the link.");
		else if (picked === EDIT) {
			setState("mdText", props.path, true);
			// The page that had the keyboard is gone: the text takes it, in this page's own group. The keyboard may have
			// come here by Tab, which does not make a group the one at hand.
			if (props.group !== undefined) setState("activeGroup", props.group);
			setTimeout(focusEditor, 0);
		}
		else if (picked === SHOW) (await import("../panels/Explorer")).showInExplorer(props.path);
		else await copyPath(picked === PATH ? "whole" : picked === NAME ? "name" : "relative", props.path);
	};
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
		<div class="md-view" ref={view} tabindex={0} aria-label={`${props.path.split(/[\\/]/).pop()}, rendered`} aria-haspopup="menu" onScroll={follows} onContextMenu={(e) => void pageMenu(e)}>
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
																		<Icon name="chevron-down" />
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
														<button
															class="link"
															title={[file.path, group.kind === "registry" ? `Opens the table at the rows for ${ticket()}.` : ""].filter(Boolean).join("\n")}
															onClick={() => {
																// A registry opens at this ticket's rows, not at the whole table.
																if (group.kind === "registry") askRows(file.path, ticket());
																void openFile(file.path);
															}}
														>
															{file.ticket && !file.title?.startsWith(file.ticket) ? `${file.ticket}: ` : ""}
															{group.kind === "registry" ? registryTitle(file.name) : file.title || file.name.replace(/\.plan\.json$/i, "")}
														</button>
														<Show when={group.kind === "registry" && file.forTickets?.find((rows) => rows.key.toLowerCase() === ticket().toLowerCase())}>{(rows) => <span class="md-work-note">{rowsLine(rows())}</span>}</Show>
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
					{/* What links here, by path or by name: the way back from a document to those that speak of it. */}
					<Show when={linked()?.length}>
						<section class="md-linked" aria-label="Linked from">
							<h2>Linked from</h2>
							<ul>
								<For each={linked()}>
									{(from) => (
										<li>
											<button class="link" title={relativeTo(state.workspace?.root, from.path)} onClick={() => void openFile(from.path, { reveal: { line: from.line } })}>
												{called(from.path)}
											</button>
											<Show when={from.places > 1}>
												<span class="md-work-note">{from.places} places</span>
											</Show>
										</li>
									)}
								</For>
							</ul>
						</section>
					</Show>
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
