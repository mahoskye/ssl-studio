// The Docs panel in the self-test. Every run checks what the panel lists for
// the folder as it is. The cycle run works on a copy of the workspace, so it
// also presses "Set up project" and reads the documents that makes.
import { baseName } from "../shared/paths";
import { showPanel } from "./panels/registry";
import { activePath, state } from "./state";

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
	});
}
