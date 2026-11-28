// The order of the quick pick's rows: files for "Go to file", commands for
// the command list. It compares file names and labels only; it knows no SSL.
// No DOM and no app state, so the tests can drive it.
import { baseName } from "../shared/paths";

// --- files -------------------------------------------------------------------

/** The files the work is in: they come first among equal matches. */
export const isScript = (path: string) => /\.(ssl|srvscr|ds)(\.txt)?$/i.test(path);

const isDigit = (c: string) => c >= "0" && c <= "9";
const isUpper = (c: string) => c !== c.toLowerCase();
const isLower = (c: string) => c !== c.toUpperCase();
const isWordChar = (c: string | undefined): c is string => c !== undefined && (isDigit(c) || isUpper(c) || isLower(c));

/** Where the words of a name begin: after a separator, at a capital after a small letter, at a number. */
export function wordStarts(name: string): number[] {
	const starts: number[] = [];
	for (let i = 0; i < name.length; i++) {
		const c = name[i]!;
		const before = name[i - 1];
		const after = name[i + 1];
		if (!isWordChar(c)) continue;
		if (!isWordChar(before)) starts.push(i);
		else if (isUpper(c) && (isLower(before) || isDigit(before) || (isWordChar(after) && isLower(after)))) starts.push(i);
		else if (isDigit(c) && !isDigit(before)) starts.push(i);
	}
	return starts;
}

/** Each letter of the query continues a word of the name or begins a later one: "ssdd" in SetSampleDueDates. */
function matchesWords(query: string, lower: string, starts: number[]): boolean {
	if (!query.length) return true;
	const failed = new Set<number>();
	const stride = lower.length + 1;
	const from = (q: number, at: number): boolean => {
		if (q === query.length) return true;
		const key = q * stride + at;
		if (failed.has(key)) return false;
		if (lower[at] === query[q] && from(q + 1, at + 1)) return true;
		for (const s of starts) {
			if (s > at && lower[s] === query[q] && from(q + 1, s + 1)) return true;
		}
		failed.add(key);
		return false;
	};
	return starts.some((s) => lower[s] === query[0] && from(1, s + 1));
}

function isSubsequence(query: string, text: string): boolean {
	let at = -1;
	for (const ch of query) {
		at = text.indexOf(ch, at + 1);
		if (at < 0) return false;
	}
	return true;
}

/**
 * How well a file answers a query; lower is better, null is no match.
 * 0 the name is the query (with or without its extension), 1 the name starts
 * with it, 2 it starts a word of the name or spells words' beginnings,
 * 3 it is somewhere in the name, 4 somewhere in the path, 5 its letters
 * appear in the path in order.
 */
export function fileTier(query: string, path: string): number | null {
	const forward = path.replace(/\\/g, "/");
	const full = forward.toLowerCase();
	let q = query.trim().replace(/\\/g, "/").toLowerCase();
	if (!q) return 0;
	// "design/set": the folder part must be in the path's folders, the rest ranks the name.
	const cut = q.lastIndexOf("/");
	if (cut >= 0) {
		if (!full.slice(0, Math.max(0, full.lastIndexOf("/") + 1)).includes(q.slice(0, cut + 1))) return null;
		q = q.slice(cut + 1);
		if (!q) return 3;
	}
	const name = baseName(forward);
	const lower = name.toLowerCase();
	const dot = lower.indexOf(".", 1);
	if (lower === q || (dot > 0 && lower.slice(0, dot) === q)) return 0;
	if (lower.startsWith(q)) return 1;
	const starts = wordStarts(name);
	if (starts.some((s) => lower.startsWith(q, s)) || matchesWords(q, lower, starts)) return 2;
	if (lower.includes(q)) return 3;
	if (cut >= 0) return null;
	if (full.includes(q)) return 4;
	return isSubsequence(q, full) ? 5 : null;
}

/**
 * The symbols that answer a query, best first, by the ranks `fileTier` gives a name: the name itself, its start,
 * the starts of its words ("awd" for AddWorkingDays), anywhere in it, then its letters in order. Each word of the
 * query has to answer. The language server matches a part of the name only, so the procedures the app has whole are
 * ranked here (ADR 0047), as VS Code ranks a server's answer with its own fuzzy matching.
 */
export function rankSymbols<S extends { name: string }>(query: string, list: readonly S[]): S[] {
	const words = query.trim().split(/\s+/).filter(Boolean);
	if (!words.length) return [...list];
	const ranked: { symbol: S; tier: number }[] = [];
	for (const symbol of list) {
		let tier = 0;
		for (const word of words) {
			const t = fileTier(word, symbol.name);
			if (t === null || t === 4) {
				tier = -1;
				break;
			}
			tier = Math.max(tier, t);
		}
		if (tier >= 0) ranked.push({ symbol, tier });
	}
	return ranked
		.sort((a, b) => a.tier - b.tier || a.symbol.name.length - b.symbol.name.length || a.symbol.name.localeCompare(b.symbol.name, undefined, { sensitivity: "base" }))
		.map((each) => each.symbol);
}

/**
 * The files that answer a query, best first. Among equal matches scripts
 * come before other files, then shorter paths, then the alphabet.
 */
export function rankFiles<T>(query: string, items: T[], pathOf: (item: T) => string, limit = 200): T[] {
	const ranked: { item: T; path: string; tier: number; script: boolean }[] = [];
	for (const item of items) {
		const path = pathOf(item);
		const tier = fileTier(query, path);
		if (tier !== null) ranked.push({ item, path, tier, script: isScript(path) });
	}
	return ranked
		.sort((a, b) => a.tier - b.tier || Number(b.script) - Number(a.script) || a.path.length - b.path.length || (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
		.slice(0, limit)
		.map((r) => r.item);
}

// --- commands ----------------------------------------------------------------

export type Listed = { id: string; label: string; detail?: string };

/** The last commands run from the list, newest first, without repeats. */
export const noteUsed = (recent: string[], id: string, keep = 10): string[] => [id, ...recent.filter((r) => r !== id)].slice(0, keep);

/** Recently used commands first, newest first, then the rest by label. `recent` says how many lead the list. */
export function orderCommands<T extends Listed>(commands: T[], recentIds: string[]): { list: T[]; recent: number } {
	const used = recentIds.map((id) => commands.find((c) => c.id === id)).filter((c): c is T => Boolean(c));
	const rest = commands.filter((c) => !used.includes(c)).sort((a, b) => a.label.localeCompare(b.label, undefined, { sensitivity: "base" }));
	return { list: [...used, ...rest], recent: used.length };
}

/**
 * How well a label answers a query's words, in any order; 0 is no match.
 * Every word has to be found: beginning a word of the label counts most,
 * inside the label less, in the quieter second line least.
 */
export function matchWords(query: string, label: string, detail = ""): number {
	const words = query.toLowerCase().split(/\s+/).filter(Boolean);
	if (!words.length) return 1;
	const text = label.toLowerCase();
	const labelWords = text.split(/[^\p{L}\p{N}]+/u).filter(Boolean);
	const second = detail.toLowerCase();
	let total = 0;
	for (const word of words) {
		if (labelWords.some((w) => w.startsWith(word))) total += 4;
		else if (text.includes(word)) total += 2;
		else if (second.includes(word)) total += 1;
		else return 0;
	}
	return total;
}

/** The commands that answer a query, best first; equal matches keep the order they came in. */
export function filterCommands<T extends Listed>(query: string, ordered: T[]): T[] {
	if (!query.trim()) return ordered;
	return ordered
		.map((item) => ({ item, score: matchWords(query, item.label, item.detail) }))
		.filter((x) => x.score > 0)
		.sort((a, b) => b.score - a.score)
		.map((x) => x.item);
}
