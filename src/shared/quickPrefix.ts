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
	const found = /^(.*?[^:\s]):(\d*)(?::(\d*))?\s*$/.exec(query);
	if (!found) return { query, at: null };
	// "DueRules:" with the number still to come is the file, and no line yet.
	if (!found[2]) return { query: found[1]!, at: null };
	return { query: found[1]!, at: { line: Math.max(1, Number(found[2])), column: Math.max(1, Number(found[3] || 1)) } };
}

export type FileTarget = {
	file: string;
	at: LineAsked | null;
	heading: string | null;
};

/**
 * Parses a Files-mode quick-pick target:
 * - `spec.md#Rollback` -> `{ file: "spec.md", heading: "Rollback", at: null }`
 * - `DueRules.ssl:20:5` -> `{ file: "DueRules.ssl", at: { line: 20, column: 5 }, heading: null }`
 * Requires a non-whitespace character immediately before `#` so standalone `#tag` words stay intact.
 */
export function fileTarget(query: string): FileTarget {
	const trimmed = query.trim();
	const hash = /^(.*?[^\s#])#(.*)$/.exec(trimmed);
	if (hash) {
		const file = hash[1]!.trim();
		const heading = hash[2]!.trim() || null;
		return { file, at: null, heading };
	}
	const lined = fileAndLine(query);
	return { file: lined.query, at: lined.at, heading: null };
}

export type QuickFacets = {
	text: string;
	tags: string[];
	statuses: string[];
	types: string[];
};

/**
 * Extracts `tag:<name>`, `status:<val>`, and `type:<kind>` facet tokens from a
 * Files-mode query (supporting quoted values like `status:"in progress"`), leaving
 * remaining free text and `file#heading` targets intact.
 */
export function parseQuickFacets(query: string): QuickFacets {
	const tags: string[] = [];
	const statuses: string[] = [];
	const types: string[] = [];
	const text = query
		.replace(/(?:^|\s)(tag|status|type):(?:"([^"]+)"|'([^']+)'|(\S+))/gi, (full, kind: string, dq?: string, sq?: string, bare?: string) => {
			const val = (dq ?? sq ?? bare ?? "").trim();
			if (!val) return full;
			const k = kind.toLowerCase();
			if (k === "tag") {
				const clean = val.replace(/^#+/, "");
				if (clean) tags.push(clean);
				else return full;
			} else if (k === "status") {
				statuses.push(val);
			} else {
				types.push(val.toLowerCase());
			}
			return " ";
		})
		.replace(/\s+/g, " ")
		.trim();
	return { text, tags, statuses, types };
}
