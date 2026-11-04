// A plan's whole life in the real desktop window, with the recorded fake in place of a model
// (`hutch run selftest-cycle`, on a copy of the sample workspace): build, follow a link, change
// the chart and rebuild, see drift, write the tests. The window cannot be scripted from outside,
// so this presses the same buttons from inside it.
import { backend } from "./backend";
import { baseName, joinPath } from "../shared/paths";
import { parsePlan, printPlan } from "./plan/model";
import { applyText, canonical, documents, openFile, state } from "./state";

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until<T>(get: () => T | undefined | null | false, ms = 30000): Promise<T | null> {
	const end = Date.now() + ms;
	while (Date.now() < end) {
		const value = get();
		if (value) return value;
		await wait(100);
	}
	return null;
}
const button = (text: RegExp) => [...document.querySelectorAll("button")].find((b) => text.test(b.innerText.trim()) && !b.disabled);
async function press(text: RegExp) {
	const found = await until(() => button(text));
	if (!found) throw new Error(`no button matching ${text}`);
	found.click();
}
const assistant = () => document.querySelector<HTMLElement>(".plan-assist")?.innerText ?? "";

/** Runs each step in turn, and stops at the first that fails: the later ones build on it. */
export async function selftestCycle(plan: string): Promise<Record<string, boolean | string>> {
	const steps: Record<string, boolean | string> = {};
	const root = state.workspace!.root;
	const script = canonical(joinPath(root, "Sample", "Release.ssl"));
	const planPath = canonical(plan);
	const text = () => documents.get(script)?.model.getValue() ?? "";
	const toPlan = async () => {
		await openFile(planPath);
		await until(() => document.querySelector(".plan-assist"));
	};
	const step = async (name: string, work: () => Promise<boolean | null | undefined | void>) => {
		const outcome = await work();
		steps[name] = outcome !== false && outcome !== null;
		if (!steps[name]) throw new Error(`step failed: ${name}`);
	};
	/** Spec, approve, build, review, accept. */
	const buildIt = async (start: RegExp, accept: RegExp) => {
		await press(/^Write spec$/);
		await press(/^Approve the spec$/);
		await press(start);
		await press(/^Review /);
		await press(accept);
		await until(() => baseName(state.groups[state.activeGroup]?.active ?? "") === "Release.ssl");
	};
	try {
		await step("planOpens", async () => {
			await toPlan();
			return Boolean(document.querySelector(".plan-node"));
		});
		await step("builds", async () => {
			await buildIt(/^Build$/, /^Accept and create the file$/);
			return text().includes(":PROCEDURE ReleaseSample");
		});
		await step("linksShow", async () => {
			await toPlan();
			return Boolean(await until(() => document.querySelector(".plan-built")));
		});
		await step("linkOpensCode", async () => {
			const linked = document.querySelector(".plan-built")?.closest(".plan-node");
			linked?.dispatchEvent(new MouseEvent("click", { bubbles: true, ctrlKey: true }));
			return Boolean(await until(() => baseName(state.groups[state.activeGroup]?.active ?? "") === "Release.ssl" && state.cursor.line > 1));
		});
		await step("driftAgrees", async () => {
			await toPlan();
			return Boolean(await until(() => assistant().includes("They agree")));
		});
		await step("driftReports", async () => {
			const whole = text();
			const broken = whole.replace(/ExecFunction\("Regions\.IsUsableId", \{\w+\}\)/, ".T.");
			if (broken === whole) return false;
			applyText(script, broken);
			const found = await until(() => [...document.querySelectorAll(".plan-drift")].some((d) => d.textContent?.includes("IsUsableId")));
			applyText(script, whole);
			return Boolean(found && (await until(() => assistant().includes("They agree"))));
		});
		await step("changeShows", async () => {
			applyText(script, `${text().trimEnd()}\n\n/* A note kept by hand;\n`);
			const parsed = parsePlan(documents.get(planPath)!.model.getValue()).plan!;
			applyText(planPath, printPlan({ ...parsed, nodes: parsed.nodes.map((n) => (n.id === "n4" ? { ...n, notes: "Inside a transaction, and logged." } : n)) }));
			return Boolean(await until(() => assistant().includes("Since it was built") && assistant().includes("Rebuild what changed") === false));
		});
		await step("rebuildsInPlace", async () => {
			await buildIt(/^Rebuild what changed$/, /^Accept into the editor$/);
			return text().includes("/* A note kept by hand;") && (text().match(/:PROCEDURE ReleaseSample/g)?.length ?? 0) === 1;
		});
		await step("changeSettles", async () => {
			await toPlan();
			return Boolean(await until(() => !assistant().includes("Since it was built")));
		});
		await step("writesTests", async () => {
			await press(/^Write the test script$/);
			await press(/^Accept and create the file$/);
			const tests = canonical(joinPath(root, "Sample", "ReleaseTests.ssl"));
			await until(() => documents.has(tests));
			return (await backend.read(tests)).text.includes(":PROCEDURE RunTests");
		});
	} catch (e: any) {
		steps.failed = String(e?.message ?? e);
	}
	return steps;
}
