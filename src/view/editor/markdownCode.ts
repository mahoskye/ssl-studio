// Code in a rendered document, coloured as the editor colours it: each fenced
// block that names its language is tokenized by that language's grammar and
// drawn in the theme's colours.
import { monaco } from "./monaco";
import { languageFor } from "./languages";

/** The names a fence may give a language, beside its own id and its files' endings. */
const ALIASES: Record<string, string> = { md: "markdown", yml: "yaml", jsonc: "json", tsv: "csv", srvscr: "ssl", conf: "ini" };

/** The language a fence names: by its id, a usual short name, or what a file of that ending would be. */
function languageOf(code: Element): string | null {
	const named = [...code.classList].find((c) => c.startsWith("language-"))?.slice(9).toLowerCase();
	if (!named) return null;
	const id = ALIASES[named] ?? named;
	if (monaco.languages.getLanguages().some((l) => l.id === id)) return id;
	const byEnding = languageFor(`x.${named}`);
	return byEnding === "plaintext" ? null : byEnding;
}

/** Colours every fenced block under `root` that names a language the editor knows. A block already coloured is left. */
export async function colourCode(root: HTMLElement) {
	for (const code of root.querySelectorAll<HTMLElement>("pre > code[class*='language-']")) {
		if (code.dataset.coloured) continue;
		const language = languageOf(code);
		if (!language) continue;
		code.dataset.coloured = language;
		try {
			const html = await monaco.editor.colorize((code.textContent ?? "").replace(/\n$/, ""), language, { tabSize: 4 });
			// The document may have been drawn again while this was worked out.
			if (code.isConnected) code.innerHTML = html;
		} catch {
			delete code.dataset.coloured;
		}
	}
}
