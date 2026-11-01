import "./style.css";
import { render } from "solid-js/web";
import { App } from "./App";
import { connect, backend } from "./backend";
import { installKeys } from "./commands";
import { loadLanguageConfiguration } from "./editor/monaco";
import "./editor/opener";
import { loadGrammar } from "./editor/textmate";
import { registerProviders, session } from "./lsp/session";
import { loadSettings, setState, state } from "./state";
import { applyTheme, resolveTheme } from "./themes/themes";

export const errors: string[] = [];

async function start() {
	await connect();
	await Promise.all([loadGrammar(), loadLanguageConfiguration(), loadSettings()]);
	applyTheme(resolveTheme(state.settings.theme, state.themes));
	registerProviders();
	installKeys();
	setState("info", await backend.info());
	window.addEventListener("error", (e) => errors.push(String(e.message)));
	window.addEventListener("unhandledrejection", (e) => errors.push(String(e.reason?.message ?? e.reason)));
	// The app may have been started with a folder: pick it up.
	const workspace = await backend.workspace();
	if (workspace) {
		setState("workspace", workspace);
		setState("lsp", await backend.lspState());
		await loadSettings();
		void session.start(workspace.root);
	}
	render(() => <App />, document.getElementById("app")!);
	if (state.info?.selftest) void import("./selftest").then((m) => m.selftest());
}

start().catch((e) => {
	document.body.textContent = `SSL Studio failed to start: ${e?.message ?? e}`;
	console.error(`SSL Studio failed to start: ${e?.message ?? e}`, e?.stack);
});
