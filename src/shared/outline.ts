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

/** True when `s` contains a closing `"""` not escaped by an odd run of preceding backslashes. */
function hasUnescapedTripleQuote(s: string, from = 0): boolean {
	for (let i = from; i <= s.length - 3; i++) {
		if (s[i] === "\\") {
			i++;
			continue;
		}
		if (s[i] === '"' && s[i + 1] === '"' && s[i + 2] === '"') return true;
	}
	return false;
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
			// Three quotes escaped by an odd run of backslashes stay inside the string; an even run (`\\"""`) closes it.
			if (inside === '"""' ? hasUnescapedTripleQuote(line) : line.includes(inside)) inside = "";
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
		if (triple && (triple[1] === '"""' ? !hasUnescapedTripleQuote(value, 3) : value.indexOf("'''", 3) < 0)) inside = triple[1]!;
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
			while (j < text.length && text[j] !== '"' && text[j] !== "\n") {
				if (text[j] === "\\") {
					if (text[j + 1] === "\n") {
						j++;
						break;
					}
					j += 2;
				} else {
					j++;
				}
			}
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

const SQL_STATEMENT_START = /^(?:create|alter|drop|insert|update|delete|select|with|grant|revoke|merge|truncate|comment|begin|declare|exec|execute|set|commit|rollback|prompt|whenever|show|use)\b/i;

/** Returns true when a standalone `/` line is followed by EOF (or only comments/whitespace) or a new SQL statement. */
function isOracleBatchTerminator(text: string, afterLineEnd: number): boolean {
	let k = afterLineEnd;
	while (k < text.length) {
		const ch = text[k]!;
		if (/\s/.test(ch)) {
			k++;
			continue;
		}
		if (ch === "-" && text[k + 1] === "-") {
			const nl = text.indexOf("\n", k + 2);
			k = nl < 0 ? text.length : nl + 1;
			continue;
		}
		if (ch === "/" && text[k + 1] === "*") {
			const close = text.indexOf("*/", k + 2);
			k = close < 0 ? text.length : close + 2;
			continue;
		}
		return SQL_STATEMENT_START.test(text.slice(k, k + 24));
	}
	return true;
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
		// a comment after it. A line that is only a slash ends an Oracle batch when followed by EOF or a new statement (or
		// between semicolon-terminated statements), while still dividing inside multi-line expressions like `SELECT a\n/\nb`.
		if (i === 0 || text[i - 1] === "\n") {
			const stop = text.indexOf("\n", i);
			const whole = text.slice(i, stop < 0 ? text.length : stop).replace(/\r$/, "");
			const nextPos = stop < 0 ? text.length : stop + 1;
			if (
				/^[ \t]*go(?:[ \t]+\d+)?[ \t]*(?:--.*)?$/i.test(whole) ||
				(/^[ \t]*\/[ \t]*$/.test(whole) && (start < 0 || (start >= 0 && isOracleBatchTerminator(text, nextPos))))
			) {
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

function readJsonString(text: string, start: number): { value: string; end: number; newlines: number } {
	let j = start + 1;
	let newlines = 0;
	while (j < text.length && text[j] !== '"') {
		if (text[j] === "\\") {
			if (text[j + 1] === "\n") {
				newlines++;
				j += 2;
				continue;
			}
			j += 2;
			continue;
		}
		if (text[j] === "\n") newlines++;
		j++;
	}
	const end = j < text.length ? j : text.length - 1;
	const raw = text.slice(start, end + 1);
	let value: string;
	try {
		value = JSON.parse(raw);
	} catch {
		value = text.slice(start + 1, end);
	}
	return { value, end, newlines };
}

/** Finds 1-based line numbers for every `{ "id": "..." }` inside a top-level JSON array field (e.g. `"groups"` or `"nodes"`), regardless of indentation. */
function planSectionLines(text: string, field: string, ids: ReadonlySet<string>): Map<string, number> {
	const result = new Map<string, number>();
	if (!ids.size) return result;
	const stack: ("{" | "[")[] = [];
	let line = 1;
	let awaitingFieldArray = false;
	let inTargetArray = false;
	let targetArrayDepth = -1;

	const skipWs = (from: number): { index: number; newlines: number } => {
		let k = from;
		let nl = 0;
		while (k < text.length && /\s/.test(text[k]!)) {
			if (text[k] === "\n") nl++;
			k++;
		}
		return { index: k, newlines: nl };
	};

	for (let i = 0; i < text.length; i++) {
		const c = text[i]!;
		if (c === "\n") {
			line++;
			continue;
		}
		if (c === '"') {
			const keyLine = line;
			const str = readJsonString(text, i);
			line += str.newlines;
			i = str.end;
			const top = stack[stack.length - 1];
			if (top === "{") {
				const ws = skipWs(i + 1);
				if (text[ws.index] === ":") {
					if (stack.length === 1 && !inTargetArray && str.value === field) {
						awaitingFieldArray = true;
						line += ws.newlines;
						i = ws.index;
						continue;
					}
					if (inTargetArray && stack.length === targetArrayDepth + 1 && str.value === "id") {
						line += ws.newlines;
						const wsVal = skipWs(ws.index + 1);
						line += wsVal.newlines;
						if (text[wsVal.index] === '"') {
							const valStr = readJsonString(text, wsVal.index);
							line += valStr.newlines;
							i = valStr.end;
							if (ids.has(valStr.value) && !result.has(valStr.value)) {
								result.set(valStr.value, keyLine);
							}
							continue;
						}
						i = wsVal.index - 1;
						continue;
					}
				}
			}
			continue;
		}
		if (c === "{" || c === "[") {
			stack.push(c);
			if (awaitingFieldArray) {
				if (c === "[") {
					inTargetArray = true;
					targetArrayDepth = stack.length;
				}
				awaitingFieldArray = false;
			}
			continue;
		}
		if (c === "}" || c === "]") {
			if (inTargetArray && stack.length === targetArrayDepth && c === "]") {
				break;
			}
			stack.pop();
			continue;
		}
		if (awaitingFieldArray && !/\s/.test(c)) {
			awaitingFieldArray = false;
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

/**
 * One line of a document and the line end after it: `""` after the last line of a text that does not end in one.
 *
 * The moves below put lines in another order. They were joined again with one line end for the whole text (CRLF
 * if the text had one anywhere), so a file with both kinds came back with CRLF throughout: every line of it
 * changed for a move of two sections. A line now keeps the end it has, wherever it goes.
 */
type DocLine = { text: string; eol: string };

function docLines(text: string): DocLine[] {
	const lines: DocLine[] = [];
	let at = 0;
	while (at < text.length) {
		const feed = text.indexOf("\n", at);
		if (feed < 0) {
			lines.push({ text: text.slice(at), eol: "" });
			break;
		}
		const crlf = feed > at && text[feed - 1] === "\r";
		lines.push({ text: text.slice(at, crlf ? feed - 1 : feed), eol: crlf ? "\r\n" : "\n" });
		at = feed + 1;
	}
	return lines;
}

/** A text without the line end it ends in: its lines are then `docLines` of it, one for one. */
const withoutLastLineEnd = (text: string) => (text.endsWith("\r\n") ? text.slice(0, -2) : text.endsWith("\n") ? text.slice(0, -1) : text);

/** The text's own kind of line end, for a line that has none to keep: one made here with nothing to take it from. */
const lineEndOf = (text: string): "\r\n" | "\n" => (text.includes("\r\n") ? "\r\n" : "\n");

/**
 * Lines in their new order, as text. Only the place of the text's end can make a line end change hands: where the
 * text ended in no line end and its last line is last no more, that line takes the end of the line that now is.
 */
function joinDocLines(lines: readonly DocLine[], was: readonly DocLine[], made: string): string {
	const ended = was.length > 0 && was[was.length - 1]!.eol !== "";
	const last = lines.length - 1;
	const spare = (last >= 0 && lines[last]!.eol) || made;
	return lines.map((line, i) => line.text + (i < last ? line.eol || spare : ended ? line.eol || made : "")).join("");
}

const FOOTNOTE_DEFINITION = /^ {0,3}\[\^[^\]\s]+\]:/;
const LINK_DEFINITION = /^ {0,3}\[(?!\^)[^\]]+\]:\s*\S/;
/** The mark a spec ends in (`plan/assist.ts`): the print of the plan it was written from. */
const PLAN_MARK = /^ {0,3}<!--\s*plan\s[^\n]*-->\s*$/;
/** A line that is not more of the paragraph above it: a list item, a quote, a table row, a tag or a comment. */
const STARTS_A_BLOCK = /^ {0,3}(?:[-*+](?:\s|$)|\d+[.)](?:\s|$)|[>|<])/;

/**
 * Where a document's own closing lines begin, as an index into `lines` (their count, where it has none): the
 * footnote definitions and link definitions that stand after the last line of the last section's text, and the
 * mark a spec ends in. `lastHeading` is the index of the document's last heading.
 *
 * A section ran from its heading to the end of the file, so the last section took these lines with it when it
 * was moved: a document's footnotes and its closing mark ended up in the middle of it. They belong to the
 * document and stay last.
 *
 * Only what is known to be the document's is taken. Any other comment stays with the section it is in: it may be
 * a note on that section, or the closing half of a pair (`<!-- /catalog -->`, `<!-- /toc -->`,
 * `<!-- plan-mermaid:end -->`), and a pair torn apart is rewritten wrongly by whatever fills it next. And where
 * the last heading has nothing under it but definitions, they are that section's own text (a "Footnotes" or
 * "References" heading), not what is left over after it.
 */
function closingLinesStart(lines: readonly DocLine[], lastHeading: number): number {
	const scan = (definitionsClose: boolean): { start: number; text: boolean } => {
		let start = lines.length;
		let text = false;
		let fence = "";
		// A footnote's text goes on in indented lines, and in the lines right under its first.
		let footnote: "no" | "open" | "after blank" = "no";
		for (let at = lastHeading + 1; at < lines.length; at++) {
			const line = lines[at]!.text;
			const fenced = /^\s{0,3}(`{3,}|~{3,})(.*)$/.exec(line);
			let closing = false;
			if (fence) {
				if (fenced && fenced[1]![0] === fence[0] && fenced[1]!.length >= fence.length && !fenced[2]!.trim()) fence = "";
			} else if (fenced && !(fenced[1]![0] === "`" && fenced[2]!.includes("`"))) {
				fence = fenced[1]!;
			} else if (!line.trim()) {
				if (footnote === "open") footnote = "after blank";
				continue;
			} else if (PLAN_MARK.test(line)) {
				closing = true;
				footnote = "no";
			} else if (definitionsClose && FOOTNOTE_DEFINITION.test(line)) {
				closing = true;
				footnote = "open";
			} else if (definitionsClose && LINK_DEFINITION.test(line)) {
				closing = true;
				footnote = "no";
			} else if (footnote !== "no" && (/^(?: {4}|\t)/.test(line) || (footnote === "open" && !STARTS_A_BLOCK.test(line)))) {
				closing = true;
				footnote = "open";
			}
			if (closing) {
				if (start === lines.length) start = at;
			} else {
				start = lines.length;
				text = true;
				footnote = "no";
			}
		}
		return { start, text };
	};
	const found = scan(true);
	return found.text ? found.start : scan(false).start;
}

/**
 * A document made ready for a move of its sections: its lines, its sections, and where the sections end (see
 * `closingLinesStart`). A section that ran to the end of the file ends there instead.
 */
function sectionsOf(text: string): { lines: DocLine[]; tree: MarkdownSection[]; end: number } {
	const lines = docLines(text);
	const tree = markdownSectionTree(withoutLastLineEnd(text));
	let last: MarkdownSection | undefined = tree[tree.length - 1];
	while (last?.children.length) last = last.children[last.children.length - 1];
	const end = last ? closingLinesStart(lines, last.line - 1) : lines.length;
	const clamp = (list: MarkdownSection[]) => {
		for (const section of list) {
			if (section.endLine > end) section.endLine = end;
			clamp(section.children);
		}
	};
	if (end < lines.length) clamp(tree);
	return { lines, tree, end };
}

const isBlank = (line: DocLine) => line.text.trim() === "";

/** Splits trailing blank lines off a section slice while always keeping the heading line itself. */
function splitTrailingBlankLines(slice: DocLine[]): { core: DocLine[]; pad: DocLine[] } {
	let cut = slice.length;
	while (cut > 1 && isBlank(slice[cut - 1]!)) cut--;
	return { core: slice.slice(0, cut), pad: slice.slice(cut) };
}

/**
 * Moves a Markdown heading and its entire subtree past its adjacent sibling section
 * (`up` or `down`), preserving every line's own line ending, the trailing newline, the
 * document's closing lines (`closingLinesStart`) and inter-section blank-line spacing.
 * Returns `null` when already at the sibling boundary or not a heading.
 */
export function moveMarkdownSection(text: string, headingLine: number, direction: "up" | "down"): { text: string; newLine: number } | null {
	if (!text || headingLine < 1) return null;
	const { lines: rawLines, tree, end } = sectionsOf(text);

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
	if (startA < 0 || endB >= end || endA + 1 !== startB) return null;

	const { core: coreA, pad: padA } = splitTrailingBlankLines(rawLines.slice(startA, endA + 1));
	const { core: coreB, pad: padB } = splitTrailingBlankLines(rawLines.slice(startB, endB + 1));

	// Adjacent siblings in Markdown satisfy `first.level >= second.level`. When `first` is deeper than
	// `second` (e.g. `### A` followed by `## B`), placing `first` after `second` without rebasing would
	// make `second` swallow `first` as a child; promote `first`'s subtree to `second.level` so both stay siblings.
	const rebasedCoreA = coreA.slice();
	const deltaA = second.level - first.level;
	if (deltaA !== 0) {
		for (const h of collectSectionHeadings(first)) {
			const relIdx = h.line - first.line;
			if (relIdx >= 0 && relIdx < rebasedCoreA.length) {
				rebasedCoreA[relIdx] = { ...rebasedCoreA[relIdx]!, text: shiftHeadingLine(rebasedCoreA[relIdx]!.text, h.level + deltaA) };
			}
		}
	}

	const swapped = [...coreB, ...padA, ...rebasedCoreA, ...padB];
	const nextLines = [...rawLines.slice(0, startA), ...swapped, ...rawLines.slice(endB + 1)];
	const newLine = direction === "up" ? startA + 1 : startA + coreB.length + padA.length + 1;
	return { text: joinDocLines(nextLines, rawLines, lineEndOf(text)), newLine };
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

/** A document with the level of some of its headings changed by `by`: every line keeps its place and its line end. */
function withHeadingLevels(text: string, headings: readonly MarkdownSection[], by: number): string {
	const lines = docLines(text);
	for (const h of headings) {
		const line = lines[h.line - 1];
		if (line) lines[h.line - 1] = { ...line, text: shiftHeadingLine(line.text, Math.max(1, Math.min(6, h.level + by))) };
	}
	return lines.map((line) => line.text + line.eol).join("");
}

/**
 * Promotes a Markdown heading and all of its descendant sub-headings up by one
 * level (clamped at `#` level 1). Returns a no-op when the section is already
 * level 1 or `sectionLine` is not a heading. Preserves each line's line ending and front matter.
 */
export function promoteMarkdownSection(text: string, sectionLine: number): MarkdownSectionTransformResult {
	const noop: MarkdownSectionTransformResult = { text, newLine: sectionLine, changed: false };
	if (!text || sectionLine < 1) return noop;
	const section = findSectionByLine(markdownSectionTree(withoutLastLineEnd(text)), sectionLine);
	if (!section || section.level <= 1) return noop;

	const nextText = withHeadingLevels(text, collectSectionHeadings(section), -1);
	if (nextText === text) return noop;
	return { text: nextText, newLine: sectionLine, changed: true };
}

/**
 * Demotes a Markdown heading and all of its descendant sub-headings down by one
 * level (clamped at `######` level 6). Returns a no-op when the section or any
 * descendant is already level 6, or `sectionLine` is not a heading. Preserves
 * each line's line ending and front matter.
 */
export function demoteMarkdownSection(text: string, sectionLine: number): MarkdownSectionTransformResult {
	const noop: MarkdownSectionTransformResult = { text, newLine: sectionLine, changed: false };
	if (!text || sectionLine < 1) return noop;
	const section = findSectionByLine(markdownSectionTree(withoutLastLineEnd(text)), sectionLine);
	if (!section) return noop;

	const headings = collectSectionHeadings(section);
	if (headings.some((h) => h.level >= 6)) return noop;

	const nextText = withHeadingLevels(text, headings, 1);
	if (nextText === text) return noop;
	return { text: nextText, newLine: sectionLine, changed: true };
}

/** Maximum heading level (1..6) of `section` or any descendant heading in its subtree. */
export function maxSectionLevel(section: MarkdownSection): number {
	let max = section.level;
	for (const child of section.children) {
		const childMax = maxSectionLevel(child);
		if (childMax > max) max = childMax;
	}
	return max;
}

/**
 * Whether `source` can be moved to `placement` relative to `target` without
 * dropping onto itself/its descendants or exceeding ATX heading level 6 for any
 * heading in `source`'s subtree.
 */
export function canDropSection(
	source: MarkdownSection,
	target: MarkdownSection,
	placement: "before" | "after" | "inside",
): boolean {
	if (source.line === target.line) return false;
	if (target.line >= source.line && target.line <= source.endLine) return false;
	const desiredLevel = placement === "inside" ? target.level + 1 : target.level;
	if (desiredLevel > 6) return false;
	const delta = desiredLevel - source.level;
	if (maxSectionLevel(source) + delta > 6) return false;
	return true;
}

/**
 * Moves a Markdown section and its entire nested subtree to another position
 * (including across different parents):
 * - `"before"` / `"after"` places it as a sibling of `targetLine`, adopting `target.level`
 * - `"inside"` nests it at the end of `targetLine` as a child at `target.level + 1`
 * Automatically rebases descendant heading levels, ignores `#` inside fenced code
 * blocks and front matter, preserves each line's own line ending, leaves the document's
 * closing lines (`closingLinesStart`) last, and rejects drops onto itself,
 * inside its own descendant subtree, or where any rebased descendant would exceed H6.
 */
export function moveMarkdownSectionTo(
	text: string,
	sourceLine: number,
	targetLine: number,
	placement: "before" | "after" | "inside",
): MarkdownSectionTransformResult {
	const noop: MarkdownSectionTransformResult = { text, newLine: sourceLine, changed: false };
	if (!text || sourceLine < 1 || targetLine < 1 || sourceLine === targetLine) return noop;
	const { lines: allLines, tree, end } = sectionsOf(text);
	// The sections are moved among the lines that are theirs: the document's closing lines are put back after them.
	const rawLines = allLines.slice(0, end);
	const closingLines = allLines.slice(end);
	const eol = lineEndOf(text);
	const source = findSectionByLine(tree, sourceLine);
	const target = findSectionByLine(tree, targetLine);
	if (!source || !target) return noop;
	if (!canDropSection(source, target, placement)) return noop;

	const desiredLevel = placement === "inside" ? target.level + 1 : target.level;
	const delta = desiredLevel - source.level;

	const srcStart = source.line - 1;
	const srcEnd = source.endLine - 1;
	const tgtStart = target.line - 1;
	const tgtEnd = target.endLine - 1;
	if (srcStart < 0 || srcEnd >= rawLines.length || tgtStart < 0 || tgtEnd >= rawLines.length) return noop;

	// Preserve original trailing blank lines at EOF cleanly when moving sections to/from EOF.
	let eofPadStart = rawLines.length;
	while (eofPadStart > 0 && isBlank(rawLines[eofPadStart - 1]!)) eofPadStart--;
	const origEofPad = rawLines.slice(eofPadStart);

	const { core: srcCoreRaw, pad: srcPad } = splitTrailingBlankLines(rawLines.slice(srcStart, srcEnd + 1));
	const { pad: tgtPad } = splitTrailingBlankLines(rawLines.slice(tgtStart, tgtEnd + 1));

	// Rebase only actual Markdown headings in source's subtree (never touching `#` inside code fences).
	const rebasedCore = srcCoreRaw.slice();
	if (delta !== 0) {
		for (const h of collectSectionHeadings(source)) {
			const relIdx = h.line - source.line;
			if (relIdx >= 0 && relIdx < rebasedCore.length) {
				rebasedCore[relIdx] = { ...rebasedCore[relIdx]!, text: shiftHeadingLine(rebasedCore[relIdx]!.text, h.level + delta) };
			}
		}
	}

	// Infer inter-section blank-line spacing from surrounding sections (spaced vs tight documents).
	// A blank line made here stands for the one above the section it is read from, and has that one's line end.
	const blankLike = (line: DocLine): DocLine[] => [{ text: "", eol: line.eol || eol }];
	const gap: DocLine[] =
		srcPad.length > 0
			? srcPad
			: srcStart > 0 && isBlank(rawLines[srcStart - 1]!)
				? blankLike(rawLines[srcStart - 1]!)
				: tgtPad.length > 0
					? tgtPad
					: tgtStart > 0 && isBlank(rawLines[tgtStart - 1]!)
						? blankLike(rawLines[tgtStart - 1]!)
						: [];

	// Remove source cleanly while preserving inter-section spacing at the splice site.
	const beforeSrc = rawLines.slice(0, srcStart);
	const afterSrc = rawLines.slice(srcEnd + 1);
	let remaining: DocLine[];
	let removedCount: number;
	if (afterSrc.length === 0) {
		let cut = beforeSrc.length;
		while (cut > 0 && isBlank(beforeSrc[cut - 1]!)) cut--;
		remaining = [...beforeSrc.slice(0, cut), ...origEofPad];
		removedCount = rawLines.length - remaining.length;
	} else {
		const keepPad = beforeSrc.length > 0 && !isBlank(beforeSrc[beforeSrc.length - 1]!) ? srcPad : [];
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

	let nextLines: DocLine[];
	let newLine: number;
	if (tail.length === 0) {
		let headCut = head.length;
		while (headCut > 0 && isBlank(head[headCut - 1]!)) headCut--;
		const cleanHead = head.slice(0, headCut);
		const leadGap = cleanHead.length > 0 ? gap : [];
		newLine = cleanHead.length + leadGap.length + 1;
		nextLines = [...cleanHead, ...leadGap, ...rebasedCore, ...origEofPad];
	} else {
		const leadGap = head.length > 0 && !isBlank(head[head.length - 1]!) ? gap : [];
		const trailGap = !isBlank(tail[0]!) ? gap : [];
		newLine = head.length + leadGap.length + 1;
		nextLines = [...head, ...leadGap, ...rebasedCore, ...trailGap, ...tail];
	}

	const nextText = joinDocLines([...nextLines, ...closingLines], allLines, eol);
	if (nextText === text) return noop;
	return { text: nextText, newLine, changed: true };
}
