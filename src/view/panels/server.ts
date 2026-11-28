// One sentence, for every panel that shows what the language server knows,
// on why it has nothing to show and what to do about it.
import { lspAnswering } from "../lsp/session";
import { state } from "../state";

/** Why the language server cannot answer just now, and what to do; "" while it is running. */
export function serverDown(): string {
	const now = state.lsp.state;
	if (now === "running") return "";
	if (now === "starting" || now === "restarting") return "The language server is starting.";
	return `The language server ${now === "failed" ? "has failed" : "is not running"}${state.lsp.message ? ` (${state.lsp.message})` : ""}. Click “LSP” in the status bar to restart it.`;
}

/**
 * The same for a server that runs and leaves what it was asked unanswered; "" while it answers. The words in
 * quotes are the status bar item's own while it is so (`lspIndicator`).
 */
export function serverSilent(): string {
	return state.lsp.state === "running" && !lspAnswering() ? "The language server is not answering. Click “LSP not answering” in the status bar to restart it." : "";
}

/**
 * What the outline of an SSL file says while it has no rows to show. The server comes first: one that is down or
 * silent explains a list not yet read, and an empty one it may have left behind, before anything is said of the
 * list itself. A server that ran and did not answer once left "Reading this file's outline…" there for good.
 */
export function sslOutlineEmpty(list: { reading: "idle" | "reading" | "read" | "failed"; failure: string; count: number; filter: string; compact?: boolean }): string {
	// A list read before the silence stays: with rows that the filter hides, it is the filter that is spoken of.
	const server = serverDown() || (list.count ? "" : serverSilent());
	if (server) return `${server} This file's outline comes from it.`;
	if (list.reading === "failed") return `The language server could not list this file's outline: ${list.failure}`;
	if (list.reading !== "read") return "Reading this file's outline…";
	if (!list.count) return list.compact ? "No regions or procedures yet." : "This file has no regions, procedures or public variables yet.";
	return `Nothing here matches “${list.filter}”. Clear the filter to see everything.`;
}
