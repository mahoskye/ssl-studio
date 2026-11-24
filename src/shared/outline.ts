// A document's outline: what a file that is not SSL is made of, to find one's
// way in it. A Markdown document's headings, a TOML or INI file's tables and
// keys, a JSON document's keys, a SQL file's statements, a YAML file's top
// keys, a CSV/TSV file's columns, and a Plan's stages & steps. SSL's own
// outline comes from the language server and is not read here (ADR 0003).
import { parseCsv } from "./csv";
import { headingAnchor } from "./docTables";
import { frontMatter, HEADING, plainMarkdown } from "./frontMatter";

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
export const OUTLINED = ["markdown", "toml", "ini", "json", "sql", "yaml", "csv"] as const;
export const hasOutline = (language: string | undefined): boolean => (OUTLINED as readonly string[]).includes(language ?? "");

/** What the file's outline is made of, in a few words: for the panel to say when there is none. */
export const outlineOf: Record<string, string> = { markdown: "headings", toml: "tables or keys", ini: "sections or keys", json: "keys", sql: "statements", yaml: "keys", csv: "columns" };

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
		case "csv":
			return csvColumnOutline(text).map((col) => ({
				name: col.name,
				kind: "key" as const,
				line: 1,
				endLine: 1,
				detail: `${col.nonEmpty}/${col.totalRows} · ${col.distinct} distinct`,
				children: [],
			}));
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
		const fenced = /^\s{0,3}(`{3,}|~{3,})(.*)$/.exec(line);
		if (fenced) {
			// A fence is closed by one of its own marks, at least as long, with nothing after it: "```python" inside a block opens nothing and closes nothing.
			// A backtick fence's opening line holds no further backtick: "```sql``` is a tag" is a span of code in a sentence.
			const span = !fence && fenced[1]![0] === "`" && fenced[2]!.includes("`");
			if (!fence && !span) fence = fenced[1]!;
			else if (fence && fenced[1]![0] === fence[0] && fenced[1]!.length >= fence.length && !fenced[2]!.trim()) fence = "";
			if (!span) continue;
		}
		if (fence) continue;
		const heading = HEADING.exec(line);
		if (!heading) continue;
		const level = heading[1]!.length;
		const name = plainMarkdown(heading[2]!);
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
			// Three quotes with a backslash before them are part of the string, not its end.
			if (inside === '"""' ? /(?<!\\)"""/.test(line) : line.includes(inside)) inside = "";
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
		// A string of several lines opens the value: three quotes in a comment after it open nothing.
		const triple = /^("""|''')/.exec(value);
		if (triple && value.indexOf(triple[1]!, 3) < 0) inside = triple[1]!;
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
	// The words between the verb and the kind of thing say how it is made, not what it is: OR ALTER, FORCE, MATERIALIZED.
	const made = first(`^(create|alter|drop)\\s+(?:or\\s+(?:replace|alter)\\s+)?(?:(?:unique|temporary|temp|global|no\\s+force|force|editionable|noneditionable|materialized|clustered|nonclustered|public|bitmap)\\s+)*(\\w+)\\s+(?:if\\s+(?:not\\s+)?exists\\s+)?${SQL_NAME}`);
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
		// A line that is only GO ends a batch where a script has no semicolons (SQL Server): alone, with a count, or with
		// a comment after it. A line that is only a slash does the same between statements (Oracle); inside one it divides.
		if (i === 0 || text[i - 1] === "\n") {
			const stop = text.indexOf("\n", i);
			const whole = text.slice(i, stop < 0 ? text.length : stop).replace(/\r$/, "");
			if (/^[ \t]*go(?:[ \t]+\d+)?[ \t]*(?:--.*)?$/i.test(whole) || (start < 0 && /^[ \t]*\/[ \t]*$/.test(whole))) {
				end(Math.max(startLine, line - 1));
				i += whole.length - 1;
				continue;
			}
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

// --- CSV/TSV column outline ---------------------------------------------------

export type CsvColumnSummary = {
	/** 0-based column index. */
	index: number;
	name: string;
	nonEmpty: number;
	totalRows: number;
	distinct: number;
	sampleType: "empty" | "number" | "date" | "boolean" | "text";
};

const CSV_BOOL = /^(?:true|false|yes|no)$/i;
const CSV_NUM = /^[+-]?(?:\d+(?:\.\d+)?|\.\d+)$/;
const CSV_DATE = /^(?:\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?)?|\d{1,2}\/\d{1,2}\/\d{2,4})$/;

/** Summarizes every column of a CSV or TSV table: name, index, non-empty count, distinct count, and inferred sample type. */
export function csvColumnOutline(text: string): CsvColumnSummary[] {
	if (!text.trim()) return [];
	const table = parseCsv(text);
	if (!table.header.length) return [];
	const cols = Math.min(table.header.length, MOST);
	const totalRows = table.rows.length;
	const out: CsvColumnSummary[] = [];
	for (let index = 0; index < cols; index++) {
		const name = table.header[index]!.text.trim() || `Column ${index + 1}`;
		let nonEmpty = 0;
		const seen = new Set<string>();
		let allBool = true;
		let allNum = true;
		let allDate = true;
		for (const row of table.rows) {
			const v = (row[index]?.text ?? "").trim();
			if (!v) continue;
			nonEmpty++;
			seen.add(v);
			if (allBool && !CSV_BOOL.test(v)) allBool = false;
			if (allNum && !CSV_NUM.test(v)) allNum = false;
			if (allDate && !CSV_DATE.test(v)) allDate = false;
		}
		const sampleType: CsvColumnSummary["sampleType"] =
			nonEmpty === 0 ? "empty" : allBool ? "boolean" : allNum ? "number" : allDate ? "date" : "text";
		out.push({ index, name, nonEmpty, totalRows, distinct: seen.size, sampleType });
	}
	return out;
}

// --- Plan (.plan.json) stage & step outline -----------------------------------

export type PlanOutlineNode = {
	id: string;
	kind: string;
	text: string;
	ref?: string;
	group?: string;
	/** 1-based line number in the JSON text. */
	line: number;
};

export type PlanOutlineStage = {
	id: string;
	name: string;
	/** 1-based line number in the JSON text. */
	line: number;
	ungrouped?: boolean;
	nodes: PlanOutlineNode[];
};

/** Finds 1-based line numbers for every `{ "id": "..." }` inside a top-level JSON array field (e.g. `"groups"` or `"nodes"`). */
function planSectionLines(text: string, field: string, ids: ReadonlySet<string>): Map<string, number> {
	const lines = text.split(/\r?\n/);
	const result = new Map<string, number>();
	const headerRe = new RegExp(`^\\s*"${field}"\\s*:`);
	const start = lines.findIndex((l) => headerRe.test(l));
	if (start < 0) return result;
	for (let i = start; i < lines.length; i++) {
		if (i > start && /^\s{0,2}"\w+"\s*:/.test(lines[i]!)) break;
		for (const m of lines[i]!.matchAll(/"id"\s*:\s*"([^"]*)"/g)) {
			if (ids.has(m[1]!) && !result.has(m[1]!)) result.set(m[1]!, i + 1);
		}
	}
	return result;
}

/** Parses a `.plan.json` document into navigable stages (`groups`) and their steps, decisions, and calls. */
export function planStageOutline(text: string): PlanOutlineStage[] {
	let raw: unknown;
	try {
		raw = JSON.parse(text);
	} catch {
		return [];
	}
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) return [];
	const obj = raw as Record<string, unknown>;
	if (!Array.isArray(obj.nodes)) return [];

	const rawGroups = Array.isArray(obj.groups) ? obj.groups : [];
	const groups: { id: string; name: string }[] = [];
	for (const g of rawGroups) {
		if (g && typeof g === "object" && typeof (g as any).id === "string" && typeof (g as any).name === "string") {
			groups.push({ id: (g as any).id, name: (g as any).name });
		}
	}
	const rawNodes: { id: string; kind: string; text: string; ref?: string; group?: string }[] = [];
	for (const n of obj.nodes) {
		if (n && typeof n === "object" && typeof (n as any).id === "string" && typeof (n as any).text === "string") {
			rawNodes.push({
				id: (n as any).id,
				kind: typeof (n as any).kind === "string" ? (n as any).kind : "step",
				text: (n as any).text,
				...(typeof (n as any).ref === "string" ? { ref: (n as any).ref } : {}),
				...(typeof (n as any).group === "string" ? { group: (n as any).group } : {}),
			});
		}
	}

	const groupIds = new Set(groups.map((g) => g.id));
	const nodeIds = new Set(rawNodes.map((n) => n.id));
	const groupLineMap = planSectionLines(text, "groups", groupIds);
	const nodeLineMap = planSectionLines(text, "nodes", nodeIds);

	const byGroup = new Map<string, PlanOutlineNode[]>();
	for (const g of groups) byGroup.set(g.id, []);
	const ungrouped: PlanOutlineNode[] = [];

	for (const n of rawNodes) {
		const item: PlanOutlineNode = {
			id: n.id,
			kind: n.kind,
			text: n.text,
			...(n.ref ? { ref: n.ref } : {}),
			...(n.group ? { group: n.group } : {}),
			line: nodeLineMap.get(n.id) ?? 1,
		};
		if (n.group && byGroup.has(n.group)) byGroup.get(n.group)!.push(item);
		else ungrouped.push(item);
	}

	const stages: PlanOutlineStage[] = groups.map((g) => {
		const nodes = byGroup.get(g.id) ?? [];
		return {
			id: g.id,
			name: g.name,
			line: groupLineMap.get(g.id) ?? nodes[0]?.line ?? 1,
			nodes,
		};
	});
	if (ungrouped.length) {
		stages.push({
			id: "__ungrouped__",
			name: groups.length ? "Other steps" : "Flow",
			line: ungrouped[0]!.line,
			ungrouped: true,
			nodes: ungrouped,
		});
	}
	return stages;
}

// --- Markdown section tree & structural refactoring ---------------------------

export type MarkdownSection = {
	level: number;
	text: string;
	slug: string;
	/** 1-based first line of the heading. */
	line: number;
	/** 1-based last line of the section (inclusive of nested subsections). */
	endLine: number;
	/** Number of checked `- [x]` tasks within this section (inclusive of children). */
	tasksDone: number;
	/** Total number of `- [ ]` / `- [x]` tasks within this section (inclusive of children). */
	tasksTotal: number;
	children: MarkdownSection[];
};

const TASK_LINE_RE = /^\s*(?:>\s*)*(?:(?:[-*+]|\d+[.)])\s+)+\[([ xX])\](?:\s|$)/;

/**
 * Builds a nested Markdown heading tree with GitHub-compatible unique slugs,
 * section line spans, and per-section task list completion counts (ignoring
 * YAML front matter and fenced code blocks).
 */
export function markdownSectionTree(text: string): MarkdownSection[] {
	const lines = text.split(/\r?\n/);
	const top: MarkdownSection[] = [];
	const open: MarkdownSection[] = [];
	const usedSlugs = new Map<string, number>();
	let fence = "";
	let at = frontMatter(text).lines;

	for (; at < lines.length; at++) {
		const line = lines[at]!;
		const fenced = /^\s{0,3}(`{3,}|~{3,})(.*)$/.exec(line);
		if (fenced) {
			const span = !fence && fenced[1]![0] === "`" && fenced[2]!.includes("`");
			if (!fence && !span) fence = fenced[1]!;
			else if (fence && fenced[1]![0] === fence[0] && fenced[1]!.length >= fence.length && !fenced[2]!.trim()) fence = "";
			if (!span) continue;
		}
		if (fence) continue;

		const heading = HEADING.exec(line);
		if (heading) {
			const level = heading[1]!.length;
			const name = plainMarkdown(heading[2]!);
			if (!name) continue;
			while (open.length && open[open.length - 1]!.level >= level) open.pop()!.endLine = at;
			const base = headingAnchor(name) || headingAnchor(heading[2]!) || `section-${at + 1}`;
			const count = usedSlugs.get(base) ?? 0;
			usedSlugs.set(base, count + 1);
			const slug = count ? `${base}-${count}` : base;
			const item: MarkdownSection = {
				level,
				text: name,
				slug,
				line: at + 1,
				endLine: lines.length,
				tasksDone: 0,
				tasksTotal: 0,
				children: [],
			};
			const into = open.length ? open[open.length - 1]!.children : top;
			if (into.length < MOST) into.push(item);
			open.push(item);
			continue;
		}

		const task = TASK_LINE_RE.exec(line);
		if (task && open.length) {
			const done = task[1] !== " ";
			for (const anc of open) {
				anc.tasksTotal++;
				if (done) anc.tasksDone++;
			}
		}
	}
	return top;
}

/** Finds the sibling array and index containing the section starting on `headingLine`. */
function findSectionSiblings(list: MarkdownSection[], headingLine: number): { siblings: MarkdownSection[]; index: number } | null {
	for (let i = 0; i < list.length; i++) {
		const sec = list[i]!;
		if (sec.line === headingLine) return { siblings: list, index: i };
		if (headingLine > sec.line && headingLine <= sec.endLine && sec.children.length) {
			const hit = findSectionSiblings(sec.children, headingLine);
			if (hit) return hit;
		}
	}
	return null;
}

/** Splits trailing blank lines off a section slice while always keeping the heading line itself. */
function splitTrailingBlankLines(slice: string[]): { core: string[]; pad: string[] } {
	let cut = slice.length;
	while (cut > 1 && slice[cut - 1]!.trim() === "") cut--;
	return { core: slice.slice(0, cut), pad: slice.slice(cut) };
}

/**
 * Moves a Markdown heading and its entire subtree past its adjacent sibling section
 * (`up` or `down`), preserving CRLF/LF line endings, trailing newline, and inter-section
 * blank-line spacing. Returns `null` when already at the sibling boundary or not a heading.
 */
export function moveMarkdownSection(text: string, headingLine: number, direction: "up" | "down"): { text: string; newLine: number } | null {
	if (!text || headingLine < 1) return null;
	const eol = text.includes("\r\n") ? "\r\n" : "\n";
	const hasTrailingNewline = text.endsWith("\r\n") || text.endsWith("\n");
	const body = hasTrailingNewline ? text.slice(0, text.endsWith("\r\n") ? -2 : -1) : text;
	const rawLines = body.split(/\r?\n/);

	const tree = markdownSectionTree(body);
	const found = findSectionSiblings(tree, headingLine);
	if (!found) return null;
	const { siblings, index } = found;
	const targetIdx = direction === "up" ? index - 1 : index + 1;
	if (targetIdx < 0 || targetIdx >= siblings.length) return null;

	const first = direction === "up" ? siblings[targetIdx]! : siblings[index]!;
	const second = direction === "up" ? siblings[index]! : siblings[targetIdx]!;

	const startA = first.line - 1;
	const endA = first.endLine - 1;
	const startB = second.line - 1;
	const endB = second.endLine - 1;
	if (startA < 0 || endB >= rawLines.length || endA + 1 !== startB) return null;

	const { core: coreA, pad: padA } = splitTrailingBlankLines(rawLines.slice(startA, endA + 1));
	const { core: coreB, pad: padB } = splitTrailingBlankLines(rawLines.slice(startB, endB + 1));

	const swapped = [...coreB, ...padA, ...coreA, ...padB];
	const nextLines = [...rawLines.slice(0, startA), ...swapped, ...rawLines.slice(endB + 1)];
	const newLine = direction === "up" ? startA + 1 : startA + coreB.length + padA.length + 1;
	const nextText = nextLines.join(eol) + (hasTrailingNewline ? eol : "");
	return { text: nextText, newLine };
}

/**
 * Reorders a Markdown heading (`fromLine`) before or after another sibling heading (`toLine`)
 * under the same parent by applying adjacent `moveMarkdownSection` swaps.
 */
export function reorderMarkdownSection(
	text: string,
	fromLine: number,
	toLine: number,
	place: "before" | "after",
): { text: string; newLine: number } | null {
	if (fromLine === toLine) return null;
	const body = text.endsWith("\r\n") ? text.slice(0, -2) : text.endsWith("\n") ? text.slice(0, -1) : text;
	const tree = markdownSectionTree(body);
	const fromInfo = findSectionSiblings(tree, fromLine);
	const toInfo = findSectionSiblings(tree, toLine);
	if (!fromInfo || !toInfo || fromInfo.siblings !== toInfo.siblings) return null;

	const fromIdx = fromInfo.index;
	const toIdx = toInfo.index;
	let desiredIdx = place === "before" ? toIdx : toIdx + 1;
	if (fromIdx < desiredIdx) desiredIdx--;
	if (desiredIdx === fromIdx) return null;

	const direction: "up" | "down" = desiredIdx < fromIdx ? "up" : "down";
	const steps = Math.abs(desiredIdx - fromIdx);
	let curText = text;
	let curLine = fromLine;
	for (let s = 0; s < steps; s++) {
		const res = moveMarkdownSection(curText, curLine, direction);
		if (!res) return null;
		curText = res.text;
		curLine = res.newLine;
	}
	return { text: curText, newLine: curLine };
}

export type MarkdownSectionTransformResult = {
	text: string;
	newLine: number;
	changed: boolean;
};

/** Finds a section anywhere in the Markdown heading tree by its 1-based heading line. */
function findSectionByLine(list: MarkdownSection[], headingLine: number): MarkdownSection | null {
	for (const sec of list) {
		if (sec.line === headingLine) return sec;
		if (headingLine > sec.line && headingLine <= sec.endLine && sec.children.length) {
			const hit = findSectionByLine(sec.children, headingLine);
			if (hit) return hit;
		}
	}
	return null;
}

/** Collects `section` and all its descendant sub-headings in document order. */
function collectSectionHeadings(section: MarkdownSection, out: MarkdownSection[] = []): MarkdownSection[] {
	out.push(section);
	for (const child of section.children) collectSectionHeadings(child, out);
	return out;
}

/** Rewrites an ATX heading line's `#` count to `newLevel` (clamped 1..6) without altering its text or indentation. */
function shiftHeadingLine(line: string, newLevel: number): string {
	const clamped = Math.max(1, Math.min(6, newLevel));
	const match = /^(\s{0,3})(#{1,6})(\s+.*)$/.exec(line);
	if (!match) return line;
	const indent = match[1]!;
	const oldCount = match[2]!.length;
	const rest = match[3]!;
	const closing = /^(.*?)(\s+)(#{1,6})(\s*)$/.exec(rest);
	if (closing && closing[3]!.length === oldCount) {
		return `${indent}${"#".repeat(clamped)}${closing[1]}${closing[2]}${"#".repeat(clamped)}${closing[4]}`;
	}
	return `${indent}${"#".repeat(clamped)}${rest}`;
}

function splitDocumentLines(text: string): { eol: "\r\n" | "\n"; hasTrailingNewline: boolean; body: string; rawLines: string[] } {
	const eol: "\r\n" | "\n" = text.includes("\r\n") ? "\r\n" : "\n";
	const hasTrailingNewline = text.endsWith("\r\n") || text.endsWith("\n");
	const body = hasTrailingNewline ? text.slice(0, text.endsWith("\r\n") ? -2 : -1) : text;
	return { eol, hasTrailingNewline, body, rawLines: body.split(/\r?\n/) };
}

/**
 * Promotes a Markdown heading and all of its descendant sub-headings up by one
 * level (clamped at `#` level 1). Returns a no-op when the section is already
 * level 1 or `sectionLine` is not a heading. Preserves CRLF/LF and front matter.
 */
export function promoteMarkdownSection(text: string, sectionLine: number): MarkdownSectionTransformResult {
	const noop: MarkdownSectionTransformResult = { text, newLine: sectionLine, changed: false };
	if (!text || sectionLine < 1) return noop;
	const { eol, hasTrailingNewline, body, rawLines } = splitDocumentLines(text);
	const section = findSectionByLine(markdownSectionTree(body), sectionLine);
	if (!section || section.level <= 1) return noop;

	const nextLines = rawLines.slice();
	for (const h of collectSectionHeadings(section)) {
		const idx = h.line - 1;
		if (idx >= 0 && idx < nextLines.length) {
			nextLines[idx] = shiftHeadingLine(nextLines[idx]!, Math.max(1, h.level - 1));
		}
	}
	const nextText = nextLines.join(eol) + (hasTrailingNewline ? eol : "");
	if (nextText === text) return noop;
	return { text: nextText, newLine: sectionLine, changed: true };
}

/**
 * Demotes a Markdown heading and all of its descendant sub-headings down by one
 * level (clamped at `######` level 6). Returns a no-op when the section or any
 * descendant is already level 6, or `sectionLine` is not a heading. Preserves
 * CRLF/LF and front matter.
 */
export function demoteMarkdownSection(text: string, sectionLine: number): MarkdownSectionTransformResult {
	const noop: MarkdownSectionTransformResult = { text, newLine: sectionLine, changed: false };
	if (!text || sectionLine < 1) return noop;
	const { eol, hasTrailingNewline, body, rawLines } = splitDocumentLines(text);
	const section = findSectionByLine(markdownSectionTree(body), sectionLine);
	if (!section) return noop;

	const headings = collectSectionHeadings(section);
	if (headings.some((h) => h.level >= 6)) return noop;

	const nextLines = rawLines.slice();
	for (const h of headings) {
		const idx = h.line - 1;
		if (idx >= 0 && idx < nextLines.length) {
			nextLines[idx] = shiftHeadingLine(nextLines[idx]!, Math.min(6, h.level + 1));
		}
	}
	const nextText = nextLines.join(eol) + (hasTrailingNewline ? eol : "");
	if (nextText === text) return noop;
	return { text: nextText, newLine: sectionLine, changed: true };
}

/**
 * Moves a Markdown section and its entire nested subtree to another position
 * (including across different parents):
 * - `"before"` / `"after"` places it as a sibling of `targetLine`, adopting `target.level`
 * - `"inside"` nests it at the end of `targetLine` as a child at `target.level + 1`
 * Automatically rebases descendant heading levels, ignores `#` inside fenced code
 * blocks and front matter, preserves CRLF/LF, and rejects drops onto itself or
 * inside its own descendant subtree.
 */
export function moveMarkdownSectionTo(
	text: string,
	sourceLine: number,
	targetLine: number,
	placement: "before" | "after" | "inside",
): MarkdownSectionTransformResult {
	const noop: MarkdownSectionTransformResult = { text, newLine: sourceLine, changed: false };
	if (!text || sourceLine < 1 || targetLine < 1 || sourceLine === targetLine) return noop;
	const { eol, hasTrailingNewline, body, rawLines } = splitDocumentLines(text);
	const tree = markdownSectionTree(body);
	const source = findSectionByLine(tree, sourceLine);
	const target = findSectionByLine(tree, targetLine);
	if (!source || !target) return noop;
	// Reject invalid drops onto itself or inside its own descendant subtree.
	if (target.line >= source.line && target.line <= source.endLine) return noop;
	// ATX headings cannot exceed level 6; cannot nest a child under an H6 section.
	if (placement === "inside" && target.level >= 6) return noop;

	const desiredLevel = placement === "inside" ? target.level + 1 : target.level;
	const delta = desiredLevel - source.level;

	const srcStart = source.line - 1;
	const srcEnd = source.endLine - 1;
	const tgtStart = target.line - 1;
	const tgtEnd = target.endLine - 1;
	if (srcStart < 0 || srcEnd >= rawLines.length || tgtStart < 0 || tgtEnd >= rawLines.length) return noop;

	// Preserve original trailing blank lines at EOF cleanly when moving sections to/from EOF.
	let eofPadStart = rawLines.length;
	while (eofPadStart > 0 && rawLines[eofPadStart - 1]!.trim() === "") eofPadStart--;
	const origEofPad = rawLines.slice(eofPadStart);

	const { core: srcCoreRaw, pad: srcPad } = splitTrailingBlankLines(rawLines.slice(srcStart, srcEnd + 1));
	const { pad: tgtPad } = splitTrailingBlankLines(rawLines.slice(tgtStart, tgtEnd + 1));

	// Rebase only actual Markdown headings in source's subtree (never touching `#` inside code fences).
	const rebasedCore = srcCoreRaw.slice();
	if (delta !== 0) {
		for (const h of collectSectionHeadings(source)) {
			const relIdx = h.line - source.line;
			if (relIdx >= 0 && relIdx < rebasedCore.length) {
				rebasedCore[relIdx] = shiftHeadingLine(rebasedCore[relIdx]!, h.level + delta);
			}
		}
	}

	// Infer inter-section blank-line spacing from surrounding sections (spaced vs tight documents).
	const gap: string[] =
		srcPad.length > 0
			? srcPad
			: srcStart > 0 && rawLines[srcStart - 1]!.trim() === ""
				? [""]
				: tgtPad.length > 0
					? tgtPad
					: tgtStart > 0 && rawLines[tgtStart - 1]!.trim() === ""
						? [""]
						: [];

	// Remove source cleanly while preserving inter-section spacing at the splice site.
	const beforeSrc = rawLines.slice(0, srcStart);
	const afterSrc = rawLines.slice(srcEnd + 1);
	let remaining: string[];
	let removedCount: number;
	if (afterSrc.length === 0) {
		let cut = beforeSrc.length;
		while (cut > 0 && beforeSrc[cut - 1]!.trim() === "") cut--;
		remaining = [...beforeSrc.slice(0, cut), ...origEofPad];
		removedCount = rawLines.length - remaining.length;
	} else {
		const keepPad = beforeSrc.length > 0 && beforeSrc[beforeSrc.length - 1]!.trim() !== "" ? srcPad : [];
		remaining = [...beforeSrc, ...keepPad, ...afterSrc];
		removedCount = srcEnd - srcStart + 1 - keepPad.length;
	}

	const rawInsertAt = placement === "before" ? tgtStart : tgtEnd + 1;
	const insertAt = Math.max(
		0,
		Math.min(rawInsertAt <= srcStart ? rawInsertAt : rawInsertAt - removedCount, remaining.length),
	);

	const head = remaining.slice(0, insertAt);
	const tail = remaining.slice(insertAt);

	let nextLines: string[];
	let newLine: number;
	if (tail.length === 0) {
		let headCut = head.length;
		while (headCut > 0 && head[headCut - 1]!.trim() === "") headCut--;
		const cleanHead = head.slice(0, headCut);
		const leadGap = cleanHead.length > 0 ? gap : [];
		newLine = cleanHead.length + leadGap.length + 1;
		nextLines = [...cleanHead, ...leadGap, ...rebasedCore, ...origEofPad];
	} else {
		const leadGap = head.length > 0 && head[head.length - 1]!.trim() !== "" ? gap : [];
		const trailGap = tail[0]!.trim() !== "" ? gap : [];
		newLine = head.length + leadGap.length + 1;
		nextLines = [...head, ...leadGap, ...rebasedCore, ...trailGap, ...tail];
	}

	const nextText = nextLines.join(eol) + (hasTrailingNewline ? eol : "");
	if (nextText === text) return noop;
	return { text: nextText, newLine, changed: true };
}
