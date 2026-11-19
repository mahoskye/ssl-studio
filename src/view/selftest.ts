// Self-test of a running build (SSL_STUDIO_SELFTEST): opens the first SSL
// file of the workspace, exercises the editor and the language server, and
// reports. Used to check the desktop app, whose window cannot be scripted.
import { backend } from "./backend";
import { activeEditor } from "./editor/EditorGroup";
import { monaco } from "./editor/monaco";
import { errors } from "./main";
import { session, diagnostics } from "./lsp/session";
import { procedureSpans } from "./plan/build";
import { isPlanPath } from "./plan/model";
import { activeDoc, openFile, setState, state } from "./state";

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

/** Whether the picture of what an SVG shows is written out as a file another program can read: its size, or 0. */
async function pictureParses(svg: SVGSVGElement): Promise<number> {
	const { pictureOf } = await import("./graph/picture");
	const box = svg.querySelector<SVGGElement>(":scope > g[transform]")?.getBBox();
	const text = pictureOf(svg, { width: box?.width ?? 0, height: box?.height ?? 0 });
	const parsed = new DOMParser().parseFromString(text, "image/svg+xml");
	return text && !parsed.querySelector("parsererror") && parsed.documentElement.nodeName === "svg" ? text.length : 0;
}

export async function selftest() {
	const report: Record<string, unknown> = { host: state.info?.host, userAgent: navigator.userAgent, lspPath: state.info?.lsp.path, lspVersion: state.info?.lsp.version };
	const timings: Record<string, number> = {};
	const timed = async <T>(name: string, work: () => Promise<T>) => {
		const start = performance.now();
		const result = await work();
		timings[name] = Math.round(performance.now() - start);
		return result;
	};
	try {
		report.workspace = Boolean(await until(() => state.workspace));
		report.lsp = await until(() => state.lsp.state === "running" && state.lsp.state);
		const files = await backend.files();
		const file = files.find((p) => p.endsWith(".ssl"));
		report.file = Boolean(file);
		if (file) {
			await timed("open", () => openFile(file));
			const doc = await until(() => activeDoc());
			const editor = await until(() => activeEditor()?.getModel() && activeEditor());
			editor!.revealLineInCenter(doc!.model.getLineCount());
			await wait(800);
			report.tokenClasses = new Set([...document.querySelectorAll(".view-lines span span[class*='mtk']")].map((e) => e.className)).size;
			report.symbols = (await timed("documentSymbols", () => session.documentSymbols(doc!.model))).length;
			report.diagnosticsArrived = Boolean(await until(() => diagnostics[doc!.model.uri.toString()]));
			const hover = await timed("hover", () =>
				session.request("textDocument/hover", { textDocument: { uri: doc!.model.uri.toString() }, position: { line: 0, character: 0 } }).catch(() => null),
			);
			report.hoverAnswered = hover !== undefined;
			const before = doc!.model.getValue();
			await timed("format", async () => editor!.getAction("editor.action.formatDocument")!.run());
			report.formatUndoable = doc!.model.getValue() === before || doc!.model.canUndo();
			if (doc!.model.getValue() !== before) editor!.trigger("selftest", "undo", null);
			report.revertedClean = doc!.model.getValue() === before;
			report.monacoTheme = Boolean(document.querySelector(".monaco-editor"));
			report.markers = monaco.editor.getModelMarkers({ resource: doc!.model.uri }).length;
			// The server's own views of the code (blocks and graph modes), when it offers them.
			if (session.supports("ssl/syntaxTree")) {
				const tree: any = await timed("syntaxTree", () => session.request("ssl/syntaxTree", { textDocument: { uri: doc!.model.uri.toString() } }));
				report.syntaxTreeNodes = tree?.nodes?.length ?? 0;
			}
			if (session.capabilities.semanticTokensProvider) {
				const tokens = await timed("semanticTokens", () => session.semanticTokens(doc!.model));
				report.semanticTokens = (tokens?.length ?? 0) / 5;
			}
		}
		if (session.supports("ssl/callGraph")) {
			// The sample's Report calls Sample.Orders.CountOpenOrders through ExecFunction.
			const graph: any = await timed("callGraph", async () => {
				const end = Date.now() + 8000;
				let result: any = await session.request("ssl/callGraph", {});
				while (result?.indexing && Date.now() < end) {
					await wait(250);
					result = await session.request("ssl/callGraph", {});
				}
				return result;
			});
			report.callGraph = { nodes: graph?.nodes?.length ?? 0, edges: graph?.edges?.length ?? 0 };
			report.callGraphResolvesExecFunction = Boolean(graph?.edges?.some((e: any) => e.kind === "ExecFunction" && e.resolved));
			// What a plan's drift report and its in-place edits read, on this machine's paths.
			const caller = graph?.edges?.find((e: any) => e.kind === "ExecFunction" && e.resolved)?.location?.uri;
			if (caller) {
				const calls = await session.scriptCalls(caller);
				report.scriptCalls = { procedures: calls?.procedures.length ?? 0, edges: calls?.edges.length ?? 0 };
			}
			report.procedureSpans = procedureSpans(await session.scratchTree("/* Doc;\n:PROCEDURE P;\n:ENDPROC;\n"));
		}
	} catch (e: any) {
		errors.push(String(e?.stack ?? e));
	}
	try {
		// A plan's chart, in this webview: laid out, and its findings in Problems.
		const plan = (await backend.files()).find(isPlanPath);
		if (plan) {
			await openFile(plan);
			report.planNodes = (await until(() => document.querySelectorAll(".plan-node").length, 5000)) ?? 0;
			report.planEdges = document.querySelectorAll(".plan-edge").length;
		}
	} catch (e: any) {
		errors.push(String(e?.stack ?? e));
	}
	try {
		// The chart's lines are drawn with rounded corners, and its picture can be written out, in this webview.
		const chart = document.querySelector<SVGSVGElement>(".plan svg.graph-canvas");
		if (chart) {
			report.planCurvedEdges = [...chart.querySelectorAll(".plan-edge .g-edge")].filter((e) => /^M[^Z]*[LQ]/.test(e.getAttribute("d") ?? "")).length;
			report.planArrows = chart.querySelectorAll("defs marker").length;
			report.planPicture = await pictureParses(chart);
		}
	} catch (e: any) {
		errors.push(String(e?.stack ?? e));
	}
	try {
		// The call graph, in this webview: laid out and drawn, with its key, and its picture written out.
		if (session.supports("ssl/callGraph")) {
			setState("centerView", "graph");
			const graph = await until(() => {
				const svg = document.querySelector<SVGSVGElement>(".graph svg.graph-canvas");
				return svg && svg.querySelectorAll(".g-proc, .g-top, .g-fold").length > 0 && svg;
			}, 15000);
			if (graph) {
				report.graphNodes = graph.querySelectorAll(".g-proc, .g-top, .g-fold").length;
				report.graphLines = [...graph.querySelectorAll(".g-edge")].filter((e) => (e.getAttribute("d") ?? "").startsWith("M")).length;
				report.graphKey = document.querySelectorAll(".graph-legend li").length;
				const box = graph.querySelector<SVGGElement>(".g-root")?.getBBox();
				report.graphDrawn = Boolean(box && box.width > 0 && box.height > 0);
				report.graphPicture = await pictureParses(graph);
			} else report.graphNodes = 0;
			setState("centerView", "editors");
		}
	} catch (e: any) {
		errors.push(String(e?.stack ?? e));
	}
	const docs = await import("./selftestDocs");
	try {
		report.docs = await docs.selftestDocs();
	} catch (e: any) {
		errors.push(String(e?.stack ?? e));
	}
	const plan = state.info?.selftestCycle ? (await backend.files()).find(isPlanPath) : undefined;
	if (plan) report.cycle = await import("./selftestCycle").then((m) => m.selftestCycle(plan));
	// Setting a project up writes files, so only on the cycle run’s copy of the workspace.
	if (state.info?.selftestCycle) report.docsSetup = await docs.selftestDocsSetup();
	report.timingsMs = timings;
	// Monaco cancels work when a diff or an editor closes before it finishes, as an accepted review does.
	report.errors = errors.filter((e) => !/^(Canceled|no diff result available)/.test(e));
	report.ok =
		!(report.errors as string[]).length &&
		report.lsp === "running" &&
		Number(report.tokenClasses) > 1 &&
		Number(report.symbols) >= 0 &&
		report.revertedClean === true &&
		// A server that offers its views must answer with them.
		(report.syntaxTreeNodes === undefined || Number(report.syntaxTreeNodes) > 0) &&
		(report.semanticTokens === undefined || Number(report.semanticTokens) > 0) &&
		(report.planNodes === undefined || Number(report.planNodes) > 0) &&
		(report.planPicture === undefined || (Number(report.planPicture) > 0 && Number(report.planArrows) > 0)) &&
		// A server that gives a call graph must end in a picture of it: nodes, lines, a key, and a file of it.
		(report.graphNodes === undefined || (Number(report.graphNodes) > 0 && report.graphDrawn === true && Number(report.graphKey) > 0 && Number(report.graphPicture) > 0)) &&
		(report.callGraph === undefined || report.callGraphResolvesExecFunction === true) &&
		(report.scriptCalls === undefined || (Number((report.scriptCalls as any).procedures) > 0 && Number((report.scriptCalls as any).edges) > 0)) &&
		(report.procedureSpans === undefined || (report.procedureSpans as any[])[0]?.startLine === 0) &&
		Boolean(report.docs && !(report.docs as any).failed) &&
		(!state.info?.selftestCycle || Boolean(report.cycle && !(report.cycle as any).failed && report.docsSetup && !(report.docsSetup as any).failed));
	await backend.selftestDone(report);
}
