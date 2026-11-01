// Self-test of a running build (SSL_STUDIO_SELFTEST): opens the first SSL
// file of the workspace, exercises the editor and the language server, and
// reports. Used to check the desktop app, whose window cannot be scripted.
import { backend } from "./backend";
import { activeEditor } from "./editor/EditorGroup";
import { monaco } from "./editor/monaco";
import { errors } from "./main";
import { session, diagnostics } from "./lsp/session";
import { activeDoc, openFile, state } from "./state";

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
		const file = (await backend.files()).find((p) => p.endsWith(".ssl"));
		report.file = Boolean(file);
		if (file) {
			await timed("open", () => openFile(file));
			const doc = await until(() => activeDoc());
			const editor = await until(() => activeEditor()?.getModel() && activeEditor());
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
		}
	} catch (e: any) {
		errors.push(String(e?.stack ?? e));
	}
	report.timingsMs = timings;
	report.errors = errors;
	report.ok = !errors.length && report.lsp === "running" && Number(report.tokenClasses) > 1 && Number(report.symbols) >= 0 && report.revertedClean === true;
	await backend.selftestDone(report);
}
