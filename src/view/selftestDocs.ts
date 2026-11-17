// The Docs panel in the self-test. Every run checks what the panel lists for
// the folder as it is. The cycle run works on a copy of the workspace, so it
// also presses "Set up project" and reads the documents that makes. Health
// says the same about the root files, and is checked beside it.
import { baseName, joinPath } from "../shared/paths";
import { backend } from "./backend";
import { showPanel } from "./panels/registry";
import { docs } from "./project";
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
