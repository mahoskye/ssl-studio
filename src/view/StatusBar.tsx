// Workspace, language server and opencode status, cursor, and the size meter
// for the current script (program decision 0006).
import { createEffect, createSignal, on, onCleanup, Show } from "solid-js";
import { level, countHistoryEntries, type SizeReport } from "../shared/houseStyle";
import { backend } from "./backend";
import { measure } from "./editor/textmate";
import { counts } from "./panels/Problems";
import { activeDoc, activePath, setState, state } from "./state";

const [size, setSize] = createSignal<SizeReport | null>(null);
export { size };

function useSizeMeter() {
	let timer: ReturnType<typeof setTimeout> | undefined;
	createEffect(
		on(activePath, () => {
			const doc = activeDoc();
			setSize(null);
			if (!doc || doc.model.getLanguageId() !== "ssl") return;
			const update = () => {
				const text = doc.model.getValue();
				const { codeLines, bannerLines } = measure(text);
				setSize({ bytes: new TextEncoder().encode(text).length, codeLines, historyEntries: countHistoryEntries(bannerLines) });
			};
			update();
			const sub = doc.model.onDidChangeContent(() => {
				clearTimeout(timer);
				timer = setTimeout(update, 500);
			});
			onCleanup(() => sub.dispose());
		}),
	);
}

export function StatusBar() {
	useSizeMeter();
	const limits = () => state.settings.limits;
	const lspLabel = () => {
		const s = state.lsp.state;
		const version = state.info?.lsp.version ? ` ${state.info.lsp.version}` : "";
		return s === "running" ? `LSP${version}` : `LSP ${s}`;
	};
	return (
		<footer class="statusbar">
			<span class="item">{state.workspace?.name ?? "No folder"}</span>
			<button
				class="item"
				classList={{ warn: state.lsp.state !== "running" || Boolean(state.info?.lsp.message) }}
				title={state.lsp.message ?? state.info?.lsp.message ?? "starlims-lsp: click to restart"}
				onClick={() => void backend.lspRestart()}
			>
				{lspLabel()}
			</button>
			<span class="item" classList={{ warn: !state.info?.opencode.ok }} title={state.info?.opencode.message ?? "opencode"}>
				{state.info?.opencode.version ? `opencode ${state.info.opencode.version}` : "opencode —"}
			</span>
			<button class="item" title="Problems" onClick={() => setState("settings", "layout", "bottom", true)}>
				✖ {counts().errors} ⚠ {counts().warnings}
			</button>
			<span class="spacer" />
			<Show when={size()}>
				{(s) => (
					<span class="item meter" title={`Size against the house limits (decision 0006): ${limits().bytes / 1024} KB, ${limits().codeLines} code lines, ${limits().historyEntries} history entries`}>
						<span class={level(s().bytes, limits().bytes)}>{(s().bytes / 1024).toFixed(1)} KB</span>
						<span class={level(s().codeLines, limits().codeLines)}>{s().codeLines} code lines</span>
						<span class={level(s().historyEntries, limits().historyEntries, 1)}>{s().historyEntries} history</span>
					</span>
				)}
			</Show>
			<Show when={activePath()}>
				<span class="item">
					Ln {state.cursor.line}, Col {state.cursor.column}
				</span>
				<span class="item">{activeDoc()?.model.getLanguageId().toUpperCase()}</span>
			</Show>
		</footer>
	);
}
