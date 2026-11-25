import { registerMarkdownLinks } from "./editor/markdownLinks";
import "./style.css";
import { Errored, Show, snapshot } from "solid-js";
import { render } from "@solidjs/web";
import { App } from "./App";
import { connect, backend, onConnectionLost } from "./backend";
import { installKeys } from "./commands";
import { installContextMenu } from "./contextMenu";
import { loadLanguageConfiguration } from "./editor/monaco";
import "./editor/opener";
import { loadGrammar } from "./editor/textmate";
import { registerProviders, session } from "./lsp/session";
import { syncWorkspaceThreads } from "./agent/store";
import { canonical, commitPendingEdits, loadProject, loadSettings, log, notify, reloadWithoutTabs, restoreTabs, saveAll, setState, snapshotUnsavedPaths, state, unsavedPaths } from "./state";
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
	const info = await backend.info();
	setState((s) => {
		s.info = info;
	});
	window.addEventListener("error", (e) => uncaught(e.error ?? e.message));
	window.addEventListener("unhandledrejection", (e) => uncaught(e.reason));
	// Prevent OS file drops outside explicit drop zones from navigating the webview away from SSL Studio.
	const preventFileDropNavigation = (e: DragEvent) => {
		const types = e.dataTransfer?.types;
		if (types && Array.from(types).includes("Files")) e.preventDefault();
	};
	window.addEventListener("dragover", preventFileDropNavigation);
	window.addEventListener("drop", preventFileDropNavigation);
	// Closing or reloading the window with edits that are not on disk asks first.
	window.addEventListener("beforeunload", (e) => {
		// A cell still being typed in counts: it is put in its document first, so the question is asked for it too.
		commitPendingEdits();
		if (snapshot(state).info?.selftest || !snapshotUnsavedPaths().length) return;
		e.preventDefault();
		e.returnValue = "";
	});
	onConnectionLost(() => notify("The connection to SSL Studio was lost, so nothing can be read or saved. Reload the page; unsaved edits in this tab will be lost, so copy them out first.", "error"));
	// The app may have been started with a folder: pick it up.
	const workspace = await backend.workspace();
	if (workspace) {
		setState((s) => {
			s.workspace = workspace;
		});
		syncWorkspaceThreads(canonical(workspace.root));
		const lsp = await backend.lspState();
		setState((s) => {
			s.lsp = lsp;
		});
		await Promise.all([loadSettings(true), loadProject()]);
		session.setRoot(workspace.root);
		if (state.lsp.state === "running") void session.start(workspace.root).catch(() => {});
	}
	render(
		() => (
			<Errored
				fallback={(err, reset) => {
					const message = () => {
						const e = err();
						return e instanceof Error ? e.message : String(e ?? "Unknown error");
					};
					return (
						<div
							role="alert"
							style={{
								display: "flex",
								"flex-direction": "column",
								"align-items": "flex-start",
								gap: "12px",
								padding: "24px",
								margin: "48px auto",
								"max-width": "560px",
								// The side panels' own colour, which every theme sets (`--panel` was never one: the card stayed dark
								// under the light themes' dark text, and could not be read).
								background: "var(--side-bg, #1e1e1e)",
								color: "var(--fg, #e0e0e0)",
								border: "1px solid var(--border, #3c3c3c)",
								"border-radius": "6px",
								"font-family": "var(--ui-font, system-ui, sans-serif)",
							}}
						>
							<h2 style={{ margin: "0", "font-size": "16px" }}>SSL Studio encountered a display error</h2>
							<p style={{ margin: "0", "font-size": "13px", opacity: "0.85", "white-space": "pre-wrap", "word-break": "break-word" }}>
								{message()}
							</p>
							{/* The documents are still held behind this card, so what is unsaved can be saved before a reload drops it. */}
							<Show when={unsavedPaths().length > 0}>
								<p style={{ margin: "0", "font-size": "13px", "word-break": "break-word" }}>
									{unsavedPaths().length === 1 ? "1 file has" : `${unsavedPaths().length} files have`} unsaved changes (
									{unsavedPaths()
										.map((path) => path.split(/[\\/]/).pop())
										.join(", ")}
									). Reloading discards them.
								</p>
							</Show>
							<div style={{ display: "flex", "flex-wrap": "wrap", gap: "8px" }}>
								<button type="button" class="primary" onClick={() => reset()}>
									Try again
								</button>
								<Show when={unsavedPaths().length > 0}>
									<button type="button" onClick={() => void saveAll()}>
										Save all
									</button>
								</Show>
								<button type="button" onClick={() => window.location.reload()}>
									Reload window
								</button>
								<button type="button" title="Reloads with no tabs open, for when a reopened tab is what fails" onClick={() => reloadWithoutTabs()}>
									Reload without reopening tabs
								</button>
							</div>
						</div>
					);
				}}
			>
				<App />
			</Errored>
		),
		document.getElementById("app")!,
	);
	// The folder opens with the files it was left with.
	await restoreTabs();
	if (state.info?.selftestClose) void import("./selftestClose").then((m) => m.selftestClose());
	else if (state.info?.selftest) void import("./selftest").then((m) => m.selftest());
}

start().catch((e) => {
	document.body.textContent = `SSL Studio failed to start: ${e?.message ?? e}`;
	console.error(`SSL Studio failed to start: ${e?.message ?? e}`, e?.stack);
});
