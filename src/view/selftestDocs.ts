// The Docs panel in the self-test. Every run checks what the panel lists for
// the folder as it is. The cycle run works on a copy of the workspace, so it
// also presses "Set up project" and reads the documents that makes. Health
// says the same about the root files, and is checked beside it.
import { monaco } from "./editor/monaco";
import { baseName, joinPath } from "../shared/paths";
import { isCatalog, questionTemplate, specTemplate, ticketTemplate } from "../shared/projectDocs";
import { backend } from "./backend";
import { activeEditor } from "./editor/EditorGroup";
import { activeLiveEditor } from "./editor/liveBridge";
import { ICON } from "./icons";
import { requestMarkdownInspector, requestMarkdownPanelTab } from "./panels/markdownBridge";
import { showPanel } from "./panels/registry";
import { docs } from "./project";
import { followRename, setStatus, updateCatalogs } from "./projectDocs";
import { activePath, canonical, openFile, setState, state } from "./state";

type Steps = Record<string, boolean | string>;

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until<T>(get: () => T | undefined | null | false, ms = 8000): Promise<T | null> {
	const end = Date.now() + ms;
	while (Date.now() < end) {
		const value = get();
		if (value) return value;
		await wait(100);
	}
	return null;
}

const rows = () => [...document.querySelectorAll<HTMLElement>(".doc-row")];
const label = (row: HTMLElement) => row.querySelector(".label")?.textContent ?? "";
const row = (name: string) =>
	rows().find(
		(r) =>
			label(r) === name ||
			r.querySelector(".project-file-meta")?.textContent?.toLowerCase() === name.toLowerCase() ||
			baseName(r.dataset.row ?? "").toLowerCase() === name.toLowerCase(),
	);
const marked = (name: string, mark: string) => [...(row(name)?.querySelectorAll(".meta") ?? [])].some((m) => m.textContent === mark);
const setupButton = () => document.querySelector<HTMLButtonElement>(".docs-setup button");
const rendered = () => document.querySelector<HTMLElement>(".cm-md-host.cm-md-read .cm-content");
const renderedHeading = () => {
	const el = rendered()?.querySelector<HTMLElement>(".cm-md-h1");
	if (!el) return undefined;
	const clone = el.cloneNode(true) as HTMLElement;
	for (const copyBtn of clone.querySelectorAll(".cm-md-heading-link")) copyBtn.remove();
	return clone.textContent?.trim();
};
/** Health’s Project section: one row for each root file, with its mark. */
const healthRows = () => {
	const section = [...document.querySelectorAll("section")].find((s) => s.querySelector("h3")?.textContent === "Project");
	return [...(section?.querySelectorAll<HTMLElement>(".meter-row") ?? [])];
};
const healthMark = (name: string) =>
	healthRows()
		.find((r) => r.dataset.row?.toLowerCase() === name.toLowerCase() || r.querySelector("span")?.textContent === name)
		?.querySelector(".meta")?.textContent ?? "";
/** Health agrees with what the Bun side says about each root file. */
const healthAgrees = () => {
	const files = docs().filter((d) => d.group === "project");
	return files.length > 0 && healthRows().length === files.length && files.every((f) => healthMark(f.name).includes(!f.exists ? "missing" : f.untouched ? "template" : ICON.check));
};
const link = (text: string) =>
	[...(rendered()?.querySelectorAll<HTMLElement>("[data-md-href], [data-md-wiki], a") ?? [])].find((el) => el.textContent?.trim() === text);
const clickLink = (el: HTMLElement) => {
	el.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true, button: 0 }));
	el.click();
};
const tabs = () => state.groups.reduce((count, group) => count + group.tabs.length, 0);

/** A document written for the links check: each kind of link, and HTML that must not survive. */
const LINKS = `# Links

- [Orders](../Sample/Orders.ssl)
- [Top](#links)
- [Outside](../../outside.md)
- [Web](https://example.com/)

<script>window.selftestScriptRan = true;</script>
<img src="missing.png" onerror="window.selftestScriptRan = true">
`;

const switchButton = (view: "Edit" | "Read") =>
	[...document.querySelectorAll<HTMLButtonElement>(".mode-switch button")].find((b) => b.innerText.trim() === (view === "Edit" ? "Live" : view) || b.innerText.trim() === view);
const switchTo = (view: "Edit" | "Read") => switchButton(view)?.click();
const ensureRead = async () => {
	if (rendered()) return true;
	const btn = await until(() => switchButton("Read"));
	if (!btn) return false;
	btn.click();
	return Boolean(await until(rendered));
};

/** Runs each step in turn, and stops at the first that fails: the later ones build on it. */
async function run(steps: Steps, work: (step: (name: string, check: () => Promise<unknown>) => Promise<void>) => Promise<void>) {
	try {
		await work(async (name, check) => {
			steps[name] = Boolean(await check());
			if (!steps[name]) throw new Error(`step failed: ${name}`);
		});
	} catch (e: any) {
		steps.failed = String(e?.message ?? e);
	}
	return steps;
}

/** What the panel lists, without changing the folder. */
export function selftestDocs(): Promise<Steps> {
	return run({}, async (step) => {
		showPanel("docs");
		await step("panelOpens", () => until(() => state.project && row("project.toml")));
		// README.md and AGENTS.md are listed whether or not they exist, each marked missing when it does not.
		await step("rootFilesListed", async () => ["README.md", "AGENTS.md"].every((name) => Boolean(row(name))));
		await step("missingMarked", async () => rows().every((r) => r.classList.contains("missing") === [...r.querySelectorAll(".meta")].some((m) => m.textContent === "missing")));
		// The sample workspace has a plan in design/.
		await step("plansListed", async () => row("Release.plan.json"));
		await step("setupOffered", async () => Boolean(setupButton()) === !state.project!.configured);
		showPanel("health");
		await step("healthListsRootFiles", () => until(healthAgrees));
		await step("healthMarksMissing", async () => docs().some((d) => d.group === "project" && !d.exists) === healthRows().some((r) => r.textContent?.includes("missing")));
	});
}

/** "Set up project" from the panel, then the documents it wrote, rendered and as text. */
export function selftestDocsSetup(): Promise<Steps> {
	return run({}, async (step) => {
		showPanel("docs");
		await step("setsUp", async () => {
			const button = await until(setupButton);
			button?.click();
			return until(() => state.project?.configured && !setupButton());
		});
		await step("nothingMissing", () => until(() => rows().length > 0 && !document.querySelector(".doc-row.missing")));
		// Fresh from the template: said so until someone writes them.
		await step("templatesMarked", () => until(() => marked("README.md", "template") && marked("AGENTS.md", "template")));
		await step("readmeOpensRendered", async () => {
			if (!(await until(() => baseName(activePath() ?? "") === "README.md" && document.querySelector(".cm-md-host")))) return false;
			if (!(await ensureRead())) return false;
			return until(() => baseName(activePath() ?? "") === "README.md" && renderedHeading() === state.project!.name);
		});
		await step("tableRendered", async () => rendered()?.querySelector("table td"));
		await step("textSwitch", async () => {
			switchTo("Edit");
			const text = await until(() => !rendered());
			switchTo("Read");
			return text && (await until(rendered));
		});
		// The new docs folder starts as its catalog, listed last in the Docs list as the other catalogs are; its row
		// opens it.
		const docsCatalog = () => rows().find((r) => canonical(r.dataset.row ?? "") === canonical(joinPath(state.workspace!.root, ...state.project!.docs.split(/[\\/]/), "INDEX.md")));
		await step("docsFolderListed", () => until(() => docsCatalog() && label(docsCatalog()!).trim() === "Catalog"));
		await step("rowOpensDocument", async () => {
			docsCatalog()!.click();
			if (!(await until(() => baseName(activePath() ?? "") === "INDEX.md" && document.querySelector(".cm-md-host")))) return false;
			if (!(await ensureRead())) return false;
			return until(() => renderedHeading() === "Docs");
		});
		await step("openRowSelected", async () => document.querySelector(".doc-row.selected"));

		showPanel("health");
		await step("healthSaysTemplate", () => until(() => healthAgrees() && healthMark("README.md").includes("template") && healthMark("AGENTS.md").includes("template")));
		await step("healthSaysSetUp", async () => healthMark("project.toml").includes(ICON.check));
		await step("healthRowOpens", async () => {
			healthRows()[0]!.click();
			if (!(await until(() => baseName(activePath() ?? "") === "README.md" && document.querySelector(".cm-md-host")))) return false;
			if (!(await ensureRead())) return false;
			return until(() => baseName(activePath() ?? "") === "README.md" && renderedHeading() === state.project!.name);
		});

		// Links in a rendered document. A web link would open the browser, so window.open is watched instead.
		const root = state.workspace!.root;
		const path = canonical(joinPath(root, ...state.project!.docs.split(/[\\/]/), "Links.md"));
		await backend.create(path, "file");
		await backend.write(path, LINKS);
		setState("treeVersion", (v) => v + 1);
		const opened: string[] = [];
		const open = window.open;
		window.open = (url) => (opened.push(String(url)), null);
		try {
			const toDoc = async () => {
				await openFile(path);
				if (!(await until(() => activePath() === path && document.querySelector(".cm-md-host")))) return null;
				if (!(await ensureRead())) return null;
				return until(() => activePath() === path && link("Orders"));
			};
			await step("linksRender", toDoc);
			await step("htmlCleaned", async () => !rendered()!.querySelector("script, [onerror]") && !(window as any).selftestScriptRan);
			await step("workspaceLinkOpens", async () => {
				clickLink(link("Orders")!);
				return until(() => activePath() === canonical(joinPath(root, "Sample", "Orders.ssl")));
			});
			await step("otherLinksStay", async () => {
				await toDoc();
				const before = tabs();
				clickLink(link("Top")!);
				clickLink(link("Outside")!);
				await wait(500);
				return activePath() === path && tabs() === before && !opened.length;
			});
			await step("webLinkOpensOutside", async () => {
				clickLink(link("Web")!);
				return opened.length === 1 && opened[0] === "https://example.com/" && activePath() === path;
			});
		} finally {
			window.open = open;
		}
	});
}

/**
 * The working documents (ADR 0012), on the cycle run's copy of the workspace:
 * a ticket with a part under it, a spec, a question and a registry are
 * written, and the panel, Health, the table, the ticket's page, a state set
 * from it and a row's menu are each checked as a person would meet them.
 */
export function selftestWork(): Promise<Steps> {
	return run({}, async (step) => {
		const root = state.workspace!.root;
		const folder = state.project!.docs.split(/[\\/]/);
		const write = async (parts: string[], text: string) => {
			const path = canonical(joinPath(root, ...folder, ...parts));
			await backend.create(path, "file");
			await backend.write(path, text);
			return path;
		};
		const ticket = await write(["tickets", "SELF-1.md"], ticketTemplate({ key: "SELF-1", title: "A ticket for the self-test", description: "Asked for by the self-test." }));
		await write(["tickets", "SELF-2.md"], ticketTemplate({ key: "SELF-2", title: "Its part", parent: "SELF-1", status: "in progress", description: "Part of the first." }));
		await write(["specs", "Self-spec.md"], specTemplate({ title: "Self spec", ticket: "SELF-1" }));
		const question = await write(["knowledge", "questions", "Is-it-read.md"], questionTemplate({ title: "Is it read?", date: "2026-01-01", ticket: "SELF-1" }));
		const registry = await write(["registries", "settings.csv"], "name,value,status,ticket\nAlpha,1,found,SELF-1\nBeta,2,verified,SELF-1\n");
		setState("treeVersion", (v) => v + 1);

		showPanel("docs");
		const keyed = (key: string) => rows().find((r) => r.querySelector(".doc-key")?.textContent === key);
		const named = (text: string) => rows().find((r) => label(r).includes(text));
		const indent = (r: HTMLElement | undefined) => Number.parseFloat(r?.style.paddingLeft ?? "0");
		await step("workListed", () => until(() => keyed("SELF-1") && keyed("SELF-2")));
		// A ticket that is part of another is under it; with something under way beneath it, the parent comes first.
		await step("partUnderParent", async () => rows().indexOf(keyed("SELF-1")!) < rows().indexOf(keyed("SELF-2")!) && indent(keyed("SELF-2")) > indent(keyed("SELF-1")));
		await step("specUnderTicket", async () => named("Self spec") && indent(named("Self spec")) > indent(keyed("SELF-1")));
		await step("knowledgeListed", async () => named("Is it read?"));
		await step("registryProgress", async () => named("Application settings")?.textContent?.includes("1 of 2 done"));

		// The catalogs are written from the documents, and then say what the folders hold.
		await step("catalogsWritten", async () => {
			await updateCatalogs();
			return until(() => {
				// The four folders of working documents, and the schema folder where it has a catalog: each up to date.
				const catalogs = docs().filter((d) => d.catalog);
				const groups = new Set<string>(catalogs.map((d) => d.group));
				return ["tickets", "specs", "knowledge", "registries"].every((group) => groups.has(group)) && catalogs.every((d) => !d.catalog!.stale);
			});
		});
		showPanel("health");
		const checks = () => [...document.querySelectorAll<HTMLElement>(".check-row")].map((r) => r.textContent ?? "");
		await step("healthSaysWork", () => until(() => checks().some((text) => text.includes("question is open")) && !checks().some((text) => text.includes("out of date"))));

		await step("registryOpensAsTable", async () => {
			await openFile(registry);
			return until(() => document.querySelectorAll(".table-view tbody tr").length === 2);
		});
		await step("ticketPageShowsWork", async () => {
			await openFile(ticket);
			requestMarkdownInspector("work");
			return until(() => document.querySelector(".cm-md-props, .md-front") && [...document.querySelectorAll(".md-work li")].some((li) => li.textContent?.includes("Self spec")));
		});
		// A registry's rows say which ticket carries them: the ticket's page lists them, and leads to the table at those rows.
		await step("ticketPageShowsRows", () => until(() => [...document.querySelectorAll(".md-work li")].some((li) => li.textContent?.includes("Application settings") && li.textContent.includes("2 rows, 1 done"))));
		await step("registryOpensAtRows", async () => {
			[...document.querySelectorAll<HTMLButtonElement>(".md-work li button")].find((button) => button.textContent?.trim() === "Application settings")?.click();
			return until(() => document.querySelector(".table-view .table-for")?.textContent?.includes("SELF-1") && document.querySelectorAll(".table-view button.table-ticket").length === 2);
		});
		// A state set from the document's page updates the file's one line and marks its catalog out of date
		// until Update catalogs is run manually (ADR 0031).
		await step("statusSetFromPage", async () => {
			await setStatus(ticket, "done");
			const markedStale = await until(() => docs().find((d) => canonical(d.path) === ticket)?.status === "done" && docs().some((d) => d.group === "tickets" && d.catalog?.stale));
			if (!markedStale) return false;
			await updateCatalogs();
			return until(() => docs().filter((d) => d.catalog).every((d) => !d.catalog!.stale));
		});

		// What done looks like is a list that is ticked on the ticket's page: the box is the item of that place in the text.
		await step("taskTickedFromPage", async () => {
			await openFile(ticket);
			if (!(await until(() => activePath() === ticket && document.querySelector(".cm-md-host")))) return false;
			if (!(await ensureRead())) return false;
			const box = await until(() => {
				const found = document.querySelector<HTMLInputElement>('.cm-md-host.cm-md-read input[type="checkbox"]');
				return found && !found.disabled && found;
			});
			box?.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true, button: 0 }));
			return until(() => docs().find((d) => canonical(d.path) === ticket)?.tasks?.done === 1);
		});

		// A row's menu, asked for the way a right-click or the menu key asks, whichever panel is showing.
		showPanel("docs");
		await step("rowMenuOpens", async () => {
			const target = await until(() => keyed("SELF-2"));
			const box = target!.getBoundingClientRect();
			target!.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: box.left + 8, clientY: box.top + 4 }));
			const statusTrigger = await until(() =>
				[...document.querySelectorAll<HTMLElement>(".menu-pop.row-menu [role=menuitem]")].find((item) => item.textContent?.trim() === "Set status"),
			);
			if (!statusTrigger) return false;
			statusTrigger.click();
			return until(() =>
				[...document.querySelectorAll(".row-submenu [role=menuitem], .row-submenu [role=menuitemcheckbox]")].some((item) => item.textContent?.trim() === "done"),
			);
		});
		await step("rowMenuCloses", async () => {
			// Escape in submenu returns to parent, second Escape closes root menu.
			(document.activeElement ?? document.body).dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
			await until(() => !document.querySelector(".row-submenu"));
			(document.activeElement ?? document.body).dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
			return until(() => !document.querySelector(".menu-pop.row-menu"));
		});

		// A list's heading has a menu of its own: what the list keeps, and a new folder in the list's folder.
		const entries = () => [...document.querySelectorAll<HTMLElement>(".menu-pop.row-menu [role=menuitem], .menu-pop.row-menu button")];
		await step("headMenuOpens", async () => {
			const head = await until(() => document.querySelector<HTMLElement>('[data-panel="docs"] [data-row="head:docs:work"]'));
			if (!head) return false;
			const box = head.getBoundingClientRect();
			head.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: box.left + 8, clientY: box.top + 4 }));
			return until(() => ["New ticket…", "New folder…", "Show in the Explorer"].every((name) => entries().some((item) => item.textContent?.trim() === name)));
		});
		// The folder is made where the heading says the list is, folders on the way to it and all.
		await step("folderMadeFromHead", async () => {
			entries()
				.find((item) => item.textContent?.trim() === "New folder…")
				?.click();
			const box = await until(() => document.querySelector<HTMLInputElement>(".dialog input"));
			if (!box?.form) return false;
			box.value = "self-made/inner";
			box.form.requestSubmit();
			await until(() => !document.querySelector(".dialog"));
			for (let tries = 0; tries < 40; tries++) {
				const made = await backend.list(joinPath(root, ...folder, "tickets", "self-made")).then(
					(found) => found.some((entry) => entry.name === "inner" && entry.kind === "dir"),
					() => false,
				);
				if (made) return true;
				await wait(100);
			}
			return false;
		});

		// The same menu by key, from the heading the keyboard is on; Escape gives the keyboard back to the heading.
		await step("headMenuByKey", async () => {
			showPanel("docs");
			const head = await until(() => document.querySelector<HTMLElement>('[data-panel="docs"] [data-row="head:docs:knowledge"]'));
			if (!head) return false;
			head.focus();
			// Shift+F10, then the menu's own key: each opens it, and Escape gives the keyboard back to the heading each time.
			for (const key of [{ key: "F10", shiftKey: true }, { key: "ContextMenu" }]) {
				head.dispatchEvent(new KeyboardEvent("keydown", { ...key, bubbles: true, cancelable: true }));
				if (!(await until(() => entries().some((item) => item.textContent?.trim() === "New decision…")))) return false;
				(document.activeElement ?? document.body).dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
				if (!(await until(() => !document.querySelector(".menu-pop.row-menu") && document.activeElement === head))) return false;
			}
			return true;
		});

		// What the data looks like is listed by its kinds, each with a heading of its own; a table is described from
		// its kind's heading, in that kind's folder, and is marked as still its template.
		await step("schemaKindsListed", async () => {
			showPanel("docs");
			return until(() => ["database", "interfaces", "files"].every((kind) => document.querySelector(`[data-panel="docs"] [data-row="head:docs:schema:${kind}"]`)));
		});
		await step("tableDescribedFromHead", async () => {
			const head = document.querySelector<HTMLElement>('[data-panel="docs"] [data-row="head:docs:schema:database"]');
			if (!head) return false;
			const box = head.getBoundingClientRect();
			head.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: box.left + 8, clientY: box.top + 4 }));
			const entry = await until(() => entries().find((item) => item.textContent?.trim() === "New table…"));
			entry?.click();
			const name = await until(() => document.querySelector<HTMLInputElement>(".dialog input"));
			if (!name?.form) return false;
			name.value = "SELF_TABLE";
			name.form.requestSubmit();
			return until(() => docs().some((d) => d.group === "schema" && d.kind === "database" && /(^|[\\/])SELF_TABLE\.md$/.test(d.name) && d.title === "SELF_TABLE" && d.untouched));
		});
		// The schema folder has a catalog like the other folders: written on Update catalogs (ADR 0031), and up to date.
		await step("schemaCatalogKept", async () => {
			await updateCatalogs();
			return until(() => docs().some((d) => d.group === "schema" && !d.kind && isCatalog(d) && d.catalog && !d.catalog.stale));
		});
		// A prompt kept in the knowledge base is offered in the Agent panel, by its name.
		await step("promptKeptAndOffered", async () => {
			await write(["knowledge", "prompts", "Self-prompt.md"], "# Self prompt\n\nSay what the selected code does.\n");
			setState("treeVersion", (v) => v + 1);
			const { keptPrompts } = await import("./agent/Agent");
			return until(() => keptPrompts().some((prompt) => prompt.title === "Self prompt" && prompt.kind === "prompts"));
		});

		// A document that is not SSL has an outline of its own.
		showPanel("objects");
		await step("documentOutlined", async () => {
			await openFile(question);
			requestMarkdownPanelTab("outline");
			return until(() => [...document.querySelectorAll('[data-panel="objects"] [data-row]')].some((r) => r.textContent?.includes("Why it matters")));
		});

		// A link to a file that is not there is said in Health, and marked on the page before anyone clicks it.
		const linked = await write(["knowledge", "reference", "Links.md"], "# Where things are\n\nThe ticket is [SELF-1](../../tickets/SELF-1.md). The first notes were in [a file since removed](../../specs/Removed.md#notes).\n");
		setState("treeVersion", (v) => v + 1);
		showPanel("health");
		await step("brokenLinkSaid", () => until(() => checks().some((text) => text.includes("links to a file that is not there: ../../specs/Removed.md"))));
		await step("brokenLinkMarked", async () => {
			await openFile(linked);
			return until(() => {
				const links = [...document.querySelectorAll<HTMLElement>(".cm-md-host [data-md-href]")];
				return links.length === 2 && links.filter((el) => el.classList.contains("cm-md-link-broken")).map((el) => el.textContent).join() === "a file since removed";
			});
		});

		// A link whose file was moved is pointed at where the file is, from the row that says so; and a ticket's key
		// written in the prose is a way to that ticket.
		await write(["specs", "kept", "Moved.md"], "# A spec that was moved\n");
		const moved = await write(["knowledge", "reference", "Moved.md"], "# Where the spec went\n\nIt follows SELF-1. The spec is [here](../../specs/Moved.md#checks).\n");
		setState("treeVersion", (v) => v + 1);
		showPanel("health");
		await step("movedLinkMended", async () => {
			const row = await until(() => [...document.querySelectorAll<HTMLElement>(".check-row")].find((r) => r.textContent?.includes("../../specs/Moved.md")));
			row?.querySelector<HTMLButtonElement>("button.link")?.click();
			if (!(await until(() => !checks().some((text) => text.includes("../../specs/Moved.md"))))) return false;
			return (await backend.read(moved)).text.includes("](../../specs/kept/Moved.md#checks)");
		});
		// A document that is not SSL says where it cannot be read: XML by the view's own reader.
		const marked = (path: string, code: string) => monaco.editor.getModelMarkers({ resource: monaco.Uri.file(path) }).find((marker) => (typeof marker.code === "string" ? marker.code : marker.code?.value) === code);
		await step("xmlSaysWhere", async () => {
			const path = await write(["reference.xml"], '<?xml version="1.0"?>\n<settings>\n  <setting name="a">1</settng>\n</settings>\n');
			await openFile(path);
			return until(() => marked(path, "xml")?.startLineNumber === 3);
		});

		// A file that is renamed takes the links that led to it along, on the person's word.
		await step("linksFollowRename", async () => {
			const from = canonical(joinPath(root, ...folder, "specs", "kept", "Moved.md"));
			const to = canonical(joinPath(root, ...folder, "specs", "kept", "Moved-again.md"));
			await backend.rename(from, to);
			const asked = followRename(from, to);
			const go = await until(() => [...document.querySelectorAll<HTMLButtonElement>(".dialog button")].find((button) => button.textContent?.trim() === "Update it"));
			go?.click();
			await asked;
			return (await backend.read(moved)).text.includes("](../../specs/kept/Moved-again.md#checks)");
		});
		await step("ticketKeyLinked", async () => {
			await openFile(moved);
			return until(() => [...document.querySelectorAll<HTMLElement>(".cm-md-host [data-md-ticket]")].some((el) => el.textContent === "SELF-1" && el.title.startsWith("SELF-1")));
		});
	});
}

/**
 * Writing a document, in the real window: the page's links by name and what links to it, the text drawn as it is
 * written (a long one too, which is read aside from the window), a list going on with Enter, a link followed from
 * the text, and a rename that takes the links by name along. On the cycle run's copy, after the working documents.
 */
export function selftestWriting(): Promise<Steps> {
	const steps: Steps = {};
	return run(steps, async (step) => {
		const root = state.workspace!.root;
		const folder = state.project!.docs.split(/[\\/]/);
		const write = async (parts: string[], text: string) => {
			const path = canonical(joinPath(root, ...folder, ...parts));
			await backend.create(path, "file");
			await backend.write(path, text);
			return path;
		};
		const listed = (path: string) => until(() => docs().some((d) => canonical(d.path) === path));
		const inLive = (selector: string) => document.querySelector(`.cm-md-host ${selector}`);

		const note = await write(["Writing.md"], "# Writing\n\nSee [[SELF-1]] and [[SELF-1|the ticket]]. None: [[no such note]].\n\n- first\n");
		setState("treeVersion", (v) => v + 1);
		await listed(note);
		await step("namedLinkOnPage", async () => {
			await openFile(note);
			switchTo("Read");
			return until(() => {
				const links = [...document.querySelectorAll<HTMLElement>(".cm-md-host.cm-md-read [data-md-wiki].cm-md-link")];
				return links.length === 2 && links[1]!.textContent === "the ticket" && document.querySelectorAll(".cm-md-host.cm-md-read [data-md-wiki].cm-md-link-missing").length === 1;
			});
		});
		await step("namedLinkOpens", async () => {
			const first = document.querySelector<HTMLElement>(".cm-md-host.cm-md-read [data-md-wiki].cm-md-link");
			if (first) clickLink(first);
			return until(() => baseName(activePath() ?? "") === "SELF-1.md");
		});
		// The ticket's page says the note links to it, from two places.
		await step("linkedFromListed", async () => {
			requestMarkdownInspector("links");
			return until(() => [...document.querySelectorAll(".cm-md-backlinks li, .md-linked li")].some((item) => item.textContent?.includes("Writing") && item.textContent.includes("2 places")));
		});
		await step("drawnAsWritten", async () => {
			await openFile(note);
			switchTo("Edit");
			return until(() => inLive(".cm-md-h1") && inLive(".cm-md-link") && inLive(".cm-md-link-missing"));
		});
		await step("listContinues", async () => {
			const live = activeLiveEditor();
			if (!live) return false;
			live.reveal({ line: 5, column: 8 });
			live.focus();
			live.runAction("md-checkbox");
			const model = activeEditor()?.getModel();
			const toggled = Boolean(model?.getLineContent(5).includes("[ ]"));
			live.runAction("undo");
			return toggled;
		});
		await step("linkFollowedInText", async () => {
			const live = activeLiveEditor();
			if (!live) return false;
			live.reveal({ line: 3, column: 8 });
			live.focus();
			live.openLinkAtCursor();
			return until(() => baseName(activePath() ?? "") === "SELF-1.md");
		});
		await step("longPageDrawn", async () => {
			const long = `# Long\n\n${Array.from({ length: 400 }, (_, n) => `## Part ${n}\n\nA paragraph with **strong** words and \`code\`, number ${n}.\n`).join("\n")}`;
			const path = await write(["Long.md"], long);
			setState("treeVersion", (v) => v + 1);
			const from = performance.now();
			await openFile(path);
			switchTo("Edit");
			const done = await until(() => inLive(".cm-md-h1") && inLive(".cm-md-strong"));
			steps.longPageMs = String(Math.round(performance.now() - from));
			steps.longPageChars = String(long.length);
			return Boolean(done);
		});
		// A file that is renamed takes the links that named it along, on the person's word.
		await step("renameFollowedByName", async () => {
			const target = await write(["Named.md"], "# A page to be renamed\n");
			const pointer = await write(["Pointer.md"], "# Pointer\n\nSee [[Named]] and [[Named|it]].\n");
			setState("treeVersion", (v) => v + 1);
			await listed(target);
			const to = canonical(joinPath(root, ...folder, "Renamed.md"));
			await backend.rename(target, to);
			const asked = followRename(target, to);
			const go = await until(() => [...document.querySelectorAll<HTMLButtonElement>(".dialog button")].find((button) => button.textContent?.trim() === "Update them"));
			go?.click();
			await asked;
			return (await backend.read(pointer)).text === "# Pointer\n\nSee [[Renamed]] and [[Renamed|it]].\n";
		});
	});
}

