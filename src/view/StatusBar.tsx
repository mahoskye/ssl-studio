// Workspace, language server and opencode status, cursor, and the size meter
// for the current script (program decision 0006).
import { createEffect, createSignal, on, onCleanup, Show } from "solid-js";
import { level, countHistoryEntries, type SizeReport } from "../shared/houseStyle";
import { backend } from "./backend";
import { measure } from "./editor/textmate";
import { counts } from "./panels/Problems";
import { activeDoc, activePath, notify, setState, state } from "./state";

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
		return s === "running" ? `Language server${version}` : `Language server ${s}`;
	};
	const lspNote = () => state.lsp.message ?? state.info?.lsp.message;
	const opencode = () => state.info?.opencode;
	// "near" and "over" are also said in words, for anyone who cannot tell them by colour.
	const part = (value: number, limit: number, text: string, near?: number) => {
		const at = level(value, limit, near);
		return (
			<span class={at} title={at === "ok" ? undefined : `${at === "over" ? "Over" : "Near"} the limit of ${limit}`}>
				{text}
				{at === "over" ? " (over)" : at === "near" ? " (near)" : ""}
			</span>
		);
	};
	return (
		<footer class="statusbar">
			<span class="item" title={state.workspace?.root}>
				{state.workspace?.name ?? "No folder"}
			</span>
			<button
				class="item"
				classList={{ warn: state.lsp.state !== "running" || Boolean(state.info?.lsp.message) }}
				title={`${lspNote() ? `${lspNote()}\n` : ""}Click to restart the language server.`}
				aria-label={`${lspLabel()}${lspNote() ? `: ${lspNote()}` : ""}. Restart the language server.`}
				onClick={() => (notify("Restarting the language server."), void backend.lspRestart())}
			>
				{lspLabel()}
				<span class="restart" aria-hidden="true">
					{" ⟳"}
				</span>
			</button>
			<Show
				when={opencode()?.ok}
				fallback={
					<button class="item warn" title="Show why opencode is not available" onClick={() => notify(opencode()?.message ?? "opencode was not found. The Agent panel needs opencode 2.2.x on PATH.", "error")}>
						opencode not available
					</button>
				}
			>
				<span class="item" title="opencode powers the Agent panel">
					opencode {opencode()!.version}
				</span>
			</Show>
			<button
				class="item"
				title="Show Problems (Ctrl+Shift+M)"
				aria-label={`${counts().errors} errors, ${counts().warnings} warnings. Show Problems.`}
				onClick={() => {
					setState("bottomView", "problems");
					setState("settings", "layout", "bottom", true);
				}}
			>
				<span aria-hidden="true">
					✖ {counts().errors} ⚠ {counts().warnings}
				</span>
			</button>
			<span class="spacer" />
			<Show when={size()}>
				{(s) => (
					<span class="item meter" title={`This script against the house size limits: ${limits().bytes / 1024} KB, ${limits().codeLines} lines of code, ${limits().historyEntries} entries in the banner's change list (program decision 0006)`}>
						{part(s().bytes, limits().bytes, `${(s().bytes / 1024).toFixed(1)} KB`)}
						{part(s().codeLines, limits().codeLines, `${s().codeLines} code lines`)}
						{part(s().historyEntries, limits().historyEntries, `${s().historyEntries} banner ${s().historyEntries === 1 ? "change" : "changes"}`, 1)}
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
