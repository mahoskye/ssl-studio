// The quick pick is one box. What it lists is said by the first character
// typed into it, as in VS Code: nothing for files, ">" for commands, "@" for
// the symbols of the open file, "#" for symbols anywhere, ":" for a line, and
// "?" for this list. The box opens with the character already in it, and
// taking it out changes what is listed. No DOM and no app state.

export type QuickMode = "files" | "commands" | "outline" | "symbols" | "line" | "help";

/** The characters, in the order "?" lists them, with what each one says. */
export const QUICK_PREFIXES: readonly { mode: Exclude<QuickMode, "files">; prefix: string; says: string }[] = [
	{ mode: "commands", prefix: ">", says: "Run a command" },
	{ mode: "outline", prefix: "@", says: "Go to a symbol in the open file" },
	{ mode: "symbols", prefix: "#", says: "Go to a symbol anywhere in the workspace" },
	{ mode: "line", prefix: ":", says: "Go to a line of the open file" },
	{ mode: "help", prefix: "?", says: "Show what can be typed here" },
];

/** What the box lists for what is typed, and the words after the character. */
export function readQuick(text: string): { mode: QuickMode; query: string } {
	const found = QUICK_PREFIXES.find((each) => text.startsWith(each.prefix));
	return found ? { mode: found.mode, query: text.slice(found.prefix.length).trimStart() } : { mode: "files", query: text };
}

/** What the box opens with, for what it is to list. */
export const prefixFor = (mode: QuickMode) => QUICK_PREFIXES.find((each) => each.mode === mode)?.prefix ?? "";

export type LineAsked = { line: number; column: number };

/** "12", "12:5" or "12,5" as a line and a column; null when it is not a number. A line past the end is the last one. */
export function lineAsked(query: string, lines: number): LineAsked | null {
	const found = /^\s*(\d+)(?:\s*[:,]\s*(\d+)?)?\s*$/.exec(query);
	if (!found) return null;
	const line = Math.min(Math.max(1, Number(found[1])), Math.max(1, lines));
	return { line, column: Math.max(1, Number(found[2] ?? 1)) };
}

/**
 * A file's name with a line after it: "DueRules.ssl:20" and "DueRules:20:5"
 * are the file and where to go in it. Only at the end, and only digits: a
 * colon inside a name, or a drive's, is part of the name.
 */
export function fileAndLine(query: string): { query: string; at: LineAsked | null } {
	const found = /^(.*?[^:\s]):(\d+)(?::(\d+))?\s*$/.exec(query);
	if (!found) return { query, at: null };
	return { query: found[1]!, at: { line: Math.max(1, Number(found[2])), column: Math.max(1, Number(found[3] ?? 1)) } };
}
