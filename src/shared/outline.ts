// A document's outline: what a file that is not SSL is made of, to find one's
// way in it. A Markdown document's headings, a TOML or INI file's tables and
// keys, a JSON document's keys, a SQL file's statements, a YAML file's top
// keys. SSL's own outline comes from the language server and is not read here
// (ADR 0003).

export type OutlineItem = {
	name: string;
	/** What kind of thing it is: the Objects panel draws each its own way. */
	kind: "heading" | "section" | "key" | "statement";
	/** Its first line, from 1, and its last. */
	line: number;
	endLine: number;
	/** A word or two more: a heading's level, a statement's first words. */
	detail?: string;
	children: OutlineItem[];
};

/** The languages an outline is read for, by the editor's name for each. */
export const OUTLINED = ["markdown", "toml", "ini", "json", "sql", "yaml"] as const;
export const hasOutline = (language: string | undefined): boolean => (OUTLINED as readonly string[]).includes(language ?? "");

/** What the file's outline is made of, in a few words: for the panel to say when there is none. */
export const outlineOf: Record<string, string> = { markdown: "headings", toml: "tables or keys", ini: "sections or keys", json: "keys", sql: "statements", yaml: "keys" };

/** As many items as an outline holds at one level: a file of ten thousand rows is not an outline. */
const MOST = 500;

export function outline(language: string | undefined, text: string): OutlineItem[] {
	const lines = text.split(/\r?\n/);
	switch (language) {
		case "markdown":
			return markdown(lines);
		case "toml":
			return tables(lines, true);
		case "ini":
			return tables(lines, false);
		case "json":
			return json(text);
		case "sql":
			return sql(text);
		case "yaml":
			return yaml(lines);
		default:
			return [];
	}
}

/** Headings, each holding the ones under it. A `#` inside a code fence or the front matter is not one. */
function markdown(lines: string[]): OutlineItem[] {
	const top: OutlineItem[] = [];
	const open: { level: number; item: OutlineItem }[] = [];
	let fence = "";
	let at = 0;
	if (lines[0]?.trim() === "---") {
		const end = lines.findIndex((line, i) => i > 0 && /^(---|\.\.\.)\s*$/.test(line));
		if (end > 0) at = end + 1;
	}
	for (; at < lines.length; at++) {
		const line = lines[at]!;
		const fenced = /^\s{0,3}(`{3,}|~{3,})/.exec(line);
		if (fenced) {
			if (!fence) fence = fenced[1]![0]!.repeat(fenced[1]!.length);
			else if (fenced[1]!.startsWith(fence)) fence = "";
			continue;
		}
		if (fence) continue;
		const heading = /^\s{0,3}(#{1,6})\s+(.+?)\s*#*\s*$/.exec(line);
		if (!heading) continue;
		const level = heading[1]!.length;
		const name = heading[2]!.replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1").replace(/[*_`~]+/g, "").trim();
		if (!name) continue;
		// A heading ends where the next of its level, or of a higher one, begins.
		while (open.length && open[open.length - 1]!.level >= level) open.pop()!.item.endLine = at;
		const item: OutlineItem = { name, kind: "heading", line: at + 1, endLine: lines.length, detail: `level ${level}`, children: [] };
		const into = open.length ? open[open.length - 1]!.item.children : top;
		if (into.length < MOST) into.push(item);
		open.push({ level, item });
	}
	return top;
}

/** TOML and INI: `[tables]` with their keys under them, and the keys before any table. */
function tables(lines: string[], toml: boolean): OutlineItem[] {
	const top: OutlineItem[] = [];
	let table: OutlineItem | null = null;
	/** Inside a string of several lines, or an array or inline table still open: its lines are not keys. */
	let inside = "";
	let depth = 0;
	for (let at = 0; at < lines.length; at++) {
		const line = lines[at]!;
		if (inside) {
			if (line.includes(inside)) inside = "";
			continue;
		}
		if (depth > 0) {
			depth += brackets(line);
			continue;
		}
		const trimmed = line.trim();
		if (!trimmed || /^[#;]/.test(trimmed)) continue;
		const header = /^\[{1,2}\s*([^\]]+?)\s*\]{1,2}\s*(?:[#;].*)?$/.exec(trimmed);
		if (header) {
			if (table) table.endLine = at;
			table = { name: header[1]!, kind: "section", line: at + 1, endLine: lines.length, detail: trimmed.startsWith("[[") ? "one of a list" : undefined, children: [] };
			if (top.length < MOST) top.push(table);
			continue;
		}
		const pair = /^("[^"]*"|'[^']*'|[^=:\s][^=:]*?)\s*[=:]\s*(.*)$/.exec(trimmed);
		if (!pair || (toml && !line.includes("="))) continue;
		const value = pair[2]!;
		const into = table ? table.children : top;
		if (into.length < MOST) into.push({ name: pair[1]!.replace(/^["']|["']$/g, ""), kind: "key", line: at + 1, endLine: at + 1, children: [] });
		if (!toml) continue;
		const triple = /("""|''')/.exec(value);
		if (triple && value.indexOf(triple[1]!, triple.index + 3) < 0) inside = triple[1]!;
		else depth = Math.max(0, brackets(value));
	}
	return top;
}
/** How many more brackets a line opens than it closes, outside its strings. */
function brackets(line: string): number {
	let depth = 0;
	let quote = "";
	for (let i = 0; i < line.length; i++) {
		const c = line[i]!;
		if (quote) {
			if (c === "\\" && quote === '"') i++;
			else if (c === quote) quote = "";
		} else if (c === '"' || c === "'") quote = c;
		else if (c === "#") break;
		else if (c === "[" || c === "{") depth++;
		else if (c === "]" || c === "}") depth--;
	}
	return depth;
}

/** JSON: the keys of the document's object, and under each the keys of an object it holds. Read as far as the text can be. */
function json(text: string): OutlineItem[] {
	const top: OutlineItem[] = [];
	/** The objects and arrays open at this point, each with the key it is the value of, if it is an object's. */
	const open: { object: boolean; item: OutlineItem | null }[] = [];
	let line = 1;
	let pending: OutlineItem | null = null;
	const close = () => {
		const closed = open.pop();
		if (closed?.item) closed.item.endLine = line;
	};
	for (let i = 0; i < text.length; i++) {
		const c = text[i]!;
		if (c === "\n") line++;
		else if (c === '"') {
			const startLine = line;
			let j = i + 1;
			while (j < text.length && text[j] !== '"' && text[j] !== "\n") j += text[j] === "\\" ? 2 : 1;
			const word = text.slice(i + 1, j);
			i = j;
			if (text[j] === "\n") line++;
			// A string followed by a colon, in an object one or two levels down, is a key worth a row.
			const here = open[open.length - 1];
			if (here?.object && open.length <= 2 && /^\s*:/.test(text.slice(j + 1, j + 40))) {
				const item: OutlineItem = { name: word, kind: "key", line: startLine, endLine: startLine, children: [] };
				const into = open.length === 1 ? top : (open[0] && here.item ? here.item.children : null);
				if (into && into.length < MOST) into.push(item);
				pending = item;
			}
		} else if (c === "{" || c === "[") {
			open.push({ object: c === "{", item: pending });
			pending = null;
		} else if (c === "}" || c === "]") close();
		else if (c === ",") pending = null;
	}
	return top;
}

const SQL_NAME = String.raw`((?:\[[^\]]+\]|"[^"]+"|[\w$#@]+)(?:\.(?:\[[^\]]+\]|"[^"]+"|[\w$#@]+))*)`;
/** What a statement is called: its verb, and what it is done to. */
function statementName(sql: string): { name: string; detail?: string } {
	const flat = sql.replace(/\s+/g, " ").trim();
	const first = (pattern: string) => new RegExp(pattern, "i").exec(flat);
	const made = first(`^(create|alter|drop)\\s+(?:or\\s+replace\\s+)?(?:unique\\s+|temporary\\s+|temp\\s+|global\\s+)*(\\w+)\\s+(?:if\\s+(?:not\\s+)?exists\\s+)?${SQL_NAME}`);
	if (made) return { name: `${made[1]!.toUpperCase()} ${made[2]!.toUpperCase()} ${made[3]}` };
	const into = first(`^insert\\s+(?:into\\s+)?${SQL_NAME}`);
	if (into) return { name: `INSERT INTO ${into[1]}` };
	const updated = first(`^update\\s+${SQL_NAME}`);
	if (updated) return { name: `UPDATE ${updated[1]}` };
	const removed = first(`^delete\\s+(?:from\\s+)?${SQL_NAME}`);
	if (removed) return { name: `DELETE FROM ${removed[1]}` };
	const selected = /^(select|with)\b/i.test(flat) ? first(`\\bfrom\\s+${SQL_NAME}`) : null;
	if (selected) return { name: `SELECT from ${selected[1]}` };
	const words = flat.split(" ").slice(0, 3).join(" ");
	return { name: words.length > 40 ? `${words.slice(0, 40)}…` : words };
}

/** SQL: its statements, each from its first word to its semicolon. A semicolon in a string or a comment ends nothing. */
function sql(text: string): OutlineItem[] {
	const items: OutlineItem[] = [];
	let line = 1;
	let start = -1;
	let startLine = 1;
	let body = "";
	const end = (endLine: number) => {
		if (start >= 0 && body.trim() && items.length < MOST) {
			const { name, detail } = statementName(body);
			items.push({ name, kind: "statement", line: startLine, endLine, detail, children: [] });
		}
		start = -1;
		body = "";
	};
	for (let i = 0; i < text.length; i++) {
		const c = text[i]!;
		if (c === "\n") {
			line++;
			if (start >= 0) body += " ";
			continue;
		}
		if (c === "-" && text[i + 1] === "-") {
			while (i < text.length && text[i + 1] !== "\n") i++;
			continue;
		}
		if (c === "/" && text[i + 1] === "*") {
			const close = text.indexOf("*/", i + 2);
			const stop = close < 0 ? text.length : close + 2;
			line += (text.slice(i, stop).match(/\n/g) ?? []).length;
			i = stop - 1;
			continue;
		}
		if (c === "'" || c === '"') {
			let j = i + 1;
			while (j < text.length && text[j] !== c) {
				if (text[j] === "\n") line++;
				j++;
			}
			if (start < 0) {
				start = i;
				startLine = line;
			}
			body += c === "'" ? "''" : text.slice(i, j + 1);
			i = j;
			continue;
		}
		if (c === ";") {
			end(line);
			continue;
		}
		if (start < 0) {
			if (/\s/.test(c)) continue;
			start = i;
			startLine = line;
		}
		body += c;
	}
	end(line);
	return items;
}

/** YAML: the keys at its left edge. */
function yaml(lines: string[]): OutlineItem[] {
	const top: OutlineItem[] = [];
	for (let at = 0; at < lines.length; at++) {
		const key = /^([A-Za-z0-9_"'][^:#]*?)\s*:(\s|$)/.exec(lines[at]!);
		if (!key) continue;
		if (top.length) top[top.length - 1]!.endLine = at;
		if (top.length < MOST) top.push({ name: key[1]!.replace(/^["']|["']$/g, ""), kind: "key", line: at + 1, endLine: lines.length, children: [] });
	}
	return top;
}

/** The kinds of thing a schema's SQL makes that a registry of database objects lists. An index belongs to its table and is not one. */
const OBJECT_KINDS = ["table", "view", "procedure", "function", "sequence", "trigger"];

/**
 * The database objects a SQL text creates: each `CREATE TABLE`, view,
 * procedure, function, sequence or trigger, by its name, once. What a
 * registry of database objects starts from, where the project keeps its
 * schema as SQL.
 */
export function createdObjects(text: string): { object: string; kind: string }[] {
	const found: { object: string; kind: string }[] = [];
	for (const item of outline("sql", text)) {
		const made = /^CREATE (\w+) (.+)$/.exec(item.name);
		const kind = made?.[1]?.toLowerCase();
		if (!made || !kind || !OBJECT_KINDS.includes(kind)) continue;
		const object = made[2]!.replace(/[\[\]"]/g, "");
		if (!found.some((other) => other.object.toLowerCase() === object.toLowerCase())) found.push({ object, kind });
	}
	return found;
}
