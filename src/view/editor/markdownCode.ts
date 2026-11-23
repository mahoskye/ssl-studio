// Code in a rendered document, coloured as the editor colours it: each fenced
// block that names its language is tokenized by that language's Monaco / TextMate
// grammar and drawn in the active theme's exact `.mtk*` token colours.
import { normalizeFenceLang, parseMonacoColorizedHtml, type CodeTokenSpan } from "../../shared/codeTokens";
import { currentThemeVersion, syncCodeTokenStyles } from "../themes/themes";
import { languageFor } from "./languages";
import { monaco } from "./monaco";

/** Resolves a fence language hint (e.g. "ssl", "srvscr", "sql", "json", "bash", "yml") to a Monaco language id. */
export function resolveCodeLanguage(named: string | null | undefined): string | null {
	if (!named) return null;
	const id = normalizeFenceLang(named);
	if (!id) return null;
	const registered = monaco.languages.getLanguages();
	if (registered.some((l) => l.id === id)) return id;
	const byEnding = languageFor(`x.${id}`);
	return byEnding === "plaintext" ? null : byEnding;
}

const MAX_TOKEN_CACHE = 200;
let cacheThemeVer = -1;
const tokenCache = new Map<string, CodeTokenSpan[][]>();
const inflight = new Map<string, Promise<CodeTokenSpan[][] | null>>();

function resetCacheIfThemeChanged(themeVer: number) {
	if (cacheThemeVer !== themeVer) {
		tokenCache.clear();
		inflight.clear();
		cacheThemeVer = themeVer;
	}
}

function cacheKey(themeVer: number, langId: string, code: string) {
	return `${themeVer}\u0000${langId}\u0000${code}`;
}

/** Synchronous lookup of cached Monaco token spans for a fenced code block under the given theme revision. */
export function getCachedCodeTokens(code: string, lang: string, themeVer = currentThemeVersion()): CodeTokenSpan[][] | undefined {
	const langId = resolveCodeLanguage(lang);
	if (!langId) return undefined;
	resetCacheIfThemeChanged(themeVer);
	const key = cacheKey(themeVer, langId, code);
	const hit = tokenCache.get(key);
	if (hit) {
		// Refresh LRU order.
		tokenCache.delete(key);
		tokenCache.set(key, hit);
	}
	return hit;
}

/**
 * Tokenizes a fenced code block via Monaco's active grammar & theme (`tabSize: 1` so every
 * character maps 1:1 to UTF-16 document columns), caching results per theme revision.
 */
export async function tokenizeCodeBlock(code: string, lang: string, themeVer = currentThemeVersion()): Promise<CodeTokenSpan[][] | null> {
	const langId = resolveCodeLanguage(lang);
	if (!langId) return null;
	resetCacheIfThemeChanged(themeVer);
	const key = cacheKey(themeVer, langId, code);
	const cached = tokenCache.get(key);
	if (cached) return cached;
	const existing = inflight.get(key);
	if (existing) return existing;

	const job = (async (): Promise<CodeTokenSpan[][] | null> => {
		try {
			const html = await monaco.editor.colorize(code, langId, { tabSize: 1 });
			// Ensure Monaco's `.mtk*` token stylesheet is mirrored under `.cm-md-codeblock-line`.
			syncCodeTokenStyles();
			if (currentThemeVersion() !== themeVer) return null;
			const spans = parseMonacoColorizedHtml(html, { bomPrefix: code.startsWith("\uFEFF") });
			resetCacheIfThemeChanged(themeVer);
			if (tokenCache.size >= MAX_TOKEN_CACHE) {
				const oldest = tokenCache.keys().next().value;
				if (oldest !== undefined) tokenCache.delete(oldest);
			}
			tokenCache.set(key, spans);
			return spans;
		} catch {
			return null;
		} finally {
			inflight.delete(key);
		}
	})();

	inflight.set(key, job);
	return job;
}

/** The language a `<code class="language-...">` element names. */
function languageOf(code: Element): string | null {
	const named = [...code.classList].find((c) => c.startsWith("language-"))?.slice(9);
	return resolveCodeLanguage(named);
}

/** Colours every fenced block under `root` that names a language the editor knows. Re-colours automatically on theme change. */
export async function colourCode(root: HTMLElement) {
	const themeVer = currentThemeVersion();
	for (const code of root.querySelectorAll<HTMLElement>("pre > code[class*='language-']")) {
		const language = languageOf(code);
		if (!language) continue;
		const stamp = `${language}@${themeVer}`;
		if (code.dataset.coloured === stamp) continue;
		const raw = code.dataset.rawCode ?? (code.textContent ?? "").replace(/\n$/, "");
		code.dataset.rawCode = raw;
		code.dataset.coloured = stamp;
		try {
			const html = await monaco.editor.colorize(raw, language, { tabSize: 4 });
			// The document may have been drawn again, or the theme changed, while this was worked out.
			if (code.isConnected && code.dataset.coloured === stamp && currentThemeVersion() === themeVer) {
				code.innerHTML = html;
			}
		} catch {
			if (code.dataset.coloured === stamp) delete code.dataset.coloured;
		}
	}
}
