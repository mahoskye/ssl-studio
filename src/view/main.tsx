import { registerMarkdownLinks } from "./editor/markdownLinks";
import "./style.css";
import { render } from "solid-js/web";
import { App } from "./App";
import { connect, backend, onConnectionLost } from "./backend";
import { installKeys } from "./commands";
import { installContextMenu } from "./contextMenu";
import { loadLanguageConfiguration } from "./editor/monaco";
import "./editor/opener";
import { loadGrammar } from "./editor/textmate";
import { registerProviders, session } from "./lsp/session";
import { loadProject, loadSettings, log, notify, restoreTabs, setState, state, unsavedPaths } from "./state";
import { applyFonts, applyTheme, resolveTheme, shapeEditorMenus } from "./themes/themes";

export const errors: string[] = [];

/**
 * An error nobody caught. It is kept for the self-test, written to Output and
 * shown: a failure that only reaches the console is one the user never hears of.
 * A cancelled request is not a failure (Monaco rejects with "Canceled" when a
 * newer request replaces an older one), and neither is the browser's notice
 * that a size it watches changed again within one frame: that change is only
 * delivered a frame later. Nor is a comparison's word that it was closed
 * before it had worked its lines out, as it is when a review is accepted: it
 * used to raise "Something went wrong" over work that had gone right.
 */
function uncaught(reason: unknown) {
	const text = String((reason as any)?.message ?? reason ?? "");
	if (!text || /^cancel{1,2}ed$/i.test(text) || (reason as any)?.name === "Canceled" || /^ResizeObserver loop/.test(text) || /^no diff result available/i.test(text)) return;
	errors.push(text);
	log(`uncaught: ${text}${(reason as any)?.stack ? `\n${(reason as any).stack}` : ""}`);
	notify(`Something went wrong: ${text}`, "error");
}

async function start() {
	await connect();
	await Promise.all([loadGrammar(), loadLanguageConfiguration(), loadSettings(true)]);
	applyFonts(state.settings);
	applyTheme(resolveTheme(state.settings.theme, state.themes, undefined, state.settings.themeMaterial));
	shapeEditorMenus();
	registerProviders();
	registerMarkdownLinks();
	installKeys();
	installContextMenu();
	setState("info", await backend.info());
	window.addEventListener("error", (e) => uncaught(e.error ?? e.message));
	window.addEventListener("unhandledrejection", (e) => uncaught(e.reason));
	// Closing or reloading the window with edits that are not on disk asks first.
	window.addEventListener("beforeunload", (e) => {
		if (state.info?.selftest || !unsavedPaths().length) return;
		e.preventDefault();
		e.returnValue = "";
	});
	onConnectionLost(() => notify("The connection to SSL Studio was lost, so nothing can be read or saved. Reload the page; unsaved edits in this tab will be lost, so copy them out first.", "error"));
	// The app may have been started with a folder: pick it up.
	const workspace = await backend.workspace();
	if (workspace) {
		setState("workspace", workspace);
		setState("lsp", await backend.lspState());
		await Promise.all([loadSettings(true), loadProject()]);
		if (state.lsp.state === "running") void session.start(workspace.root).catch(() => {});
	}
	render(() => <App />, document.getElementById("app")!);
	// The folder opens with the files it was left with.
	await restoreTabs();
	if (state.info?.selftestClose) void import("./selftestClose").then((m) => m.selftestClose());
	else if (state.info?.selftest) void import("./selftest").then((m) => m.selftest());
}

start().catch((e) => {
	document.body.textContent = `SSL Studio failed to start: ${e?.message ?? e}`;
	console.error(`SSL Studio failed to start: ${e?.message ?? e}`, e?.stack);
});
