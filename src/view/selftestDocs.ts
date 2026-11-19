// The Docs panel in the self-test. Every run checks what the panel lists for
// the folder as it is. The cycle run works on a copy of the workspace, so it
// also presses "Set up project" and reads the documents that makes. Health
// says the same about the root files, and is checked beside it.
import { monaco } from "./editor/monaco";
import { baseName, joinPath } from "../shared/paths";
import { questionTemplate, specTemplate, ticketTemplate } from "../shared/projectDocs";
import { backend } from "./backend";
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
const row = (name: string) => rows().find((r) => label(r) === name);
const marked = (name: string, mark: string) => [...(row(name)?.querySelectorAll(".meta") ?? [])].some((m) => m.textContent === mark);
const setupButton = () => document.querySelector<HTMLButtonElement>(".docs-setup button");
const rendered = () => document.querySelector<HTMLElement>(".md-view .md");
/** Health’s Project section: one row for each root file, with its mark. */
const healthRows = () => {
	const section = [...document.querySelectorAll("section")].find((s) => s.querySelector("h3")?.textContent === "Project");
	return [...(section?.querySelectorAll<HTMLElement>(".meter-row") ?? [])];
};
const healthMark = (name: string) => healthRows().find((r) => r.querySelector("span")?.textContent === name)?.querySelector(".meta")?.textContent ?? "";
/** Health agrees with what the Bun side says about each root file. */
const healthAgrees = () => {
	const files = docs().filter((d) => d.group === "project");
	return files.length > 0 && healthRows().length === files.length && files.every((f) => healthMark(f.name).includes(!f.exists ? "missing" : f.untouched ? "template" : "✓"));
};
const link = (text: string) => [...(rendered()?.querySelectorAll("a") ?? [])].find((a) => a.textContent === text);
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

const switchTo = (view: "Text" | "Read") => [...document.querySelectorAll<HTMLButtonElement>(".mode-switch button")].find((b) => b.innerText.trim() === view)?.click();

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
		await step("rootFilesListed", async () => ["README.md", "AGENTS.md"].every((name) => rows().some((r) => label(r).toLowerCase() === name.toLowerCase())));
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
		await step("readmeOpensRendered", () => until(() => baseName(activePath() ?? "") === "README.md" && rendered()?.querySelector("h1")?.textContent === state.project!.name));
		await step("tableRendered", async () => rendered()?.querySelector("table td"));
		await step("textSwitch", async () => {
			switchTo("Text");
			const text = await until(() => !rendered());
			switchTo("Read");
			return text && (await until(rendered));
		});
		// The new docs folder starts with a README of its own; its row opens it.
		await step("docsFolderListed", () => until(() => rows().filter((r) => label(r) === "README.md").length > 1));
		await step("rowOpensDocument", async () => {
			rows().filter((r) => label(r) === "README.md")[1]!.click();
			return until(() => rendered()?.querySelector("h1")?.textContent === "Docs");
		});
		await step("openRowSelected", async () => document.querySelector(".doc-row.selected"));

		showPanel("health");
		await step("healthSaysTemplate", () => until(() => healthAgrees() && healthMark("README.md").includes("template") && healthMark("AGENTS.md").includes("template")));
		await step("healthSaysSetUp", async () => healthMark("project.toml").includes("✓"));
		await step("healthRowOpens", async () => {
			healthRows()[0]!.click();
			return until(() => baseName(activePath() ?? "") === "README.md" && rendered()?.querySelector("h1")?.textContent === state.project!.name);
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
				return until(() => activePath() === path && link("Orders"));
			};
			await step("linksRender", toDoc);
			await step("htmlCleaned", async () => !rendered()!.querySelector("script, [onerror]") && !(window as any).selftestScriptRan);
			await step("workspaceLinkOpens", async () => {
				link("Orders")!.click();
				return until(() => activePath() === canonical(joinPath(root, "Sample", "Orders.ssl")));
			});
			await step("otherLinksStay", async () => {
				await toDoc();
				const before = tabs();
				link("Top")!.click();
				link("Outside")!.click();
				await wait(500);
				return activePath() === path && tabs() === before && !opened.length;
			});
			await step("webLinkOpensOutside", async () => {
				link("Web")!.click();
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
		const registry = await write(["registries", "settings.csv"], "name,value,status\nAlpha,1,found\nBeta,2,verified\n");
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
				const catalogs = docs().filter((d) => d.catalog);
				return catalogs.length === 4 && catalogs.every((d) => !d.catalog!.stale);
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
			return until(() => document.querySelector(".md-front") && [...document.querySelectorAll(".md-work li")].some((li) => li.textContent?.includes("Self spec")));
		});
		// A state set from the document's page is the file's one line and the catalog's, both.
		await step("statusSetFromPage", async () => {
			await setStatus(ticket, "done");
			return until(() => docs().find((d) => canonical(d.path) === ticket)?.status === "done" && docs().filter((d) => d.catalog).every((d) => !d.catalog!.stale));
		});

		// What done looks like is a list that is ticked on the ticket's page: the box is the item of that place in the text.
		await step("taskTickedFromPage", async () => {
			await openFile(ticket);
			const box = await until(() => {
				const found = document.querySelector<HTMLInputElement>('.md input[type="checkbox"]');
				return found && !found.disabled && found;
			});
			box?.click();
			return until(() => docs().find((d) => canonical(d.path) === ticket)?.tasks?.done === 1);
		});

		// A row's menu, asked for the way a right-click or the menu key asks, whichever panel is showing.
		showPanel("docs");
		await step("rowMenuOpens", async () => {
			const target = await until(() => keyed("SELF-2"));
			const box = target!.getBoundingClientRect();
			target!.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: box.left + 8, clientY: box.top + 4 }));
			return until(() => [...document.querySelectorAll(".menu-pop.row-menu [role=menuitem], .menu-pop.row-menu button")].some((item) => item.textContent?.trim() === "Set to done"));
		});
		await step("rowMenuCloses", async () => {
			(document.activeElement ?? document.body).dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
			return until(() => !document.querySelector(".menu-pop.row-menu"));
		});

		// A document that is not SSL has an outline of its own.
		showPanel("objects");
		await step("documentOutlined", async () => {
			await openFile(question);
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
				const links = [...document.querySelectorAll<HTMLAnchorElement>(".md a")];
				return links.length === 2 && links.filter((link) => link.classList.contains("broken")).map((link) => link.textContent).join() === "a file since removed";
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
		// A document that is not SSL says where it cannot be read: XML by the view's own reader, YAML by the backend's.
		const marked = (path: string, code: string) => monaco.editor.getModelMarkers({ resource: monaco.Uri.file(path) }).find((marker) => (typeof marker.code === "string" ? marker.code : marker.code?.value) === code);
		await step("xmlSaysWhere", async () => {
			const path = await write(["reference.xml"], '<?xml version="1.0"?>\n<settings>\n  <setting name="a">1</settng>\n</settings>\n');
			await openFile(path);
			return until(() => marked(path, "xml")?.startLineNumber === 3);
		});
		await step("yamlSaysWhere", async () => {
			const path = await write(["reference.yaml"], "name: self-test\nitems: [1,\n  2]\n bad: 1\n");
			await openFile(path);
			return until(() => marked(path, "yaml")?.startLineNumber === 4);
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
			return until(() => [...document.querySelectorAll<HTMLAnchorElement>(".md a.ticket-ref")].some((link) => link.textContent === "SELF-1" && link.title.startsWith("SELF-1")));
		});
	});
}
