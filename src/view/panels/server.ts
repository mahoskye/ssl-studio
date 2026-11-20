// One sentence, for every panel that shows what the language server knows,
// on why it has nothing to show and what to do about it.
import { state } from "../state";

/** Why the language server cannot answer just now, and what to do; "" while it is running. */
export function serverDown(): string {
	const now = state.lsp.state;
	if (now === "running") return "";
	if (now === "starting" || now === "restarting") return "The language server is starting.";
	return `The language server ${now === "failed" ? "has failed" : "is not running"}${state.lsp.message ? ` (${state.lsp.message})` : ""}. Click “LSP” in the status bar to restart it.`;
}
