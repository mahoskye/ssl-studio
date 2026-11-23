// Pure Obsidian Templater-compatible template engine & built-in defaults for SSL Studio.
// Supports `<% tp.date.now(...) %>`, `<% tp.file.* %>`, `<% tp.project.* %>`,
// `<% tp.system.prompt(...) %>`, `<% tp.system.suggester(...) %>`, `<% tp.file.cursor() %>`,
// whitespace trimming (`<%- ... -%>`, `<%_ ... _%>`), plus friendly `{{date}}`/`{{title}}` aliases.
// Zero `eval()` — safe parser for untrusted workspace templates. All tables in built-in
// templates strictly follow ADR 0008 (<= 4 columns, short cells <= 20 chars except last).

export type TemplateSource = "workspace" | "builtin";

export type MarkdownTemplate = {
	/** Stable identifier (slug). A workspace template with the same id overrides a built-in default. */
	id: string;
	/** Display name shown in menus, palette, and pickers. */
	name: string;
	/** One-line description of when to use this template. */
	description: string;
	/** Category for grouping in the picker and Palette. */
	group: "Work" | "Knowledge" | "Notes" | "Custom";
	/** Suggested relative folder under the project root (e.g. `docs/tickets`, `docs/specs`). */
	folder?: string;
	/** Suggested filename pattern (e.g. `{{ticket}}.md` or `{{slug}}.md`). */
	fileName?: string;
	/** Where this template came from (`workspace` file vs `builtin` default). */
	source: TemplateSource;
	/** Absolute path when loaded from the workspace templates folder. */
	path?: string;
	/** Raw template Markdown containing `<% tp.* %>` / `{{...}}` tags. */
	content: string;
};

export type TemplaterContext = {
	/** Title or stem of the target file (without `.md`). */
	title: string;
	/** Filename with extension (e.g. `DEMO-105.md`). */
	fileName: string;
	/** Relative path inside the workspace (e.g. `docs/tickets/DEMO-105.md`). */
	relativePath: string;
	/** Absolute file path if known. */
	fullPath?: string;
	/** Parent folder name (or relative folder path). */
	folder: string;
	/** Project name from `project.toml` or workspace root name. */
	projectName: string;
	/** Active ticket key if any (e.g. `DEMO-101`). */
	ticket?: string;
	/** Currently selected text in the active editor, if any (`tp.file.selection()`). */
	selection?: string;
	/** Current date/time (injectable for deterministic unit tests). */
	now?: Date;
	/** Interactive prompt callback (`tp.system.prompt`). Return null when user cancels. */
	prompt?: (label: string, defaultValue?: string) => Promise<string | null> | string | null;
	/** Interactive chooser callback (`tp.system.suggester`). Return null when user cancels. */
	suggest?: (labels: string[], values: string[], placeholder?: string) => Promise<string | null> | string | null;
	/** Clipboard reader (`tp.system.clipboard`). */
	clipboard?: () => Promise<string> | string;
};

export type RenderedTemplate = {
	/** Final Markdown text with all template expressions expanded. */
	text: string;
	/** Character offset where `<% tp.file.cursor() %>` stood (null if none). */
	cursorOffset: number | null;
	/** True when the user cancelled an interactive prompt/suggester. */
	cancelled: boolean;
};

const MONTHS_SHORT = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const MONTHS_LONG = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const DAYS_SHORT = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const DAYS_LONG = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

const pad2 = (n: number) => String(n).padStart(2, "0");

/** Formats a `Date` using Moment/Templater format tokens (`YYYY-MM-DD`, `HH:mm`, `MMM DD, YYYY`, etc.). */
export function formatDateToken(date: Date, format = "YYYY-MM-DD"): string {
	const yyyy = String(date.getFullYear());
	const yy = yyyy.slice(-2);
	const m = date.getMonth() + 1;
	const d = date.getDate();
	const dow = date.getDay();
	const hh = date.getHours();
	const min = date.getMinutes();
	const sec = date.getSeconds();
	return format.replace(/YYYY|YY|MMMM|MMM|MM|M|dddd|ddd|DD|D|HH|H|mm|m|ss|s/g, (tok) => {
		switch (tok) {
			case "YYYY":
				return yyyy;
			case "YY":
				return yy;
			case "MMMM":
				return MONTHS_LONG[m - 1]!;
			case "MMM":
				return MONTHS_SHORT[m - 1]!;
			case "MM":
				return pad2(m);
			case "M":
				return String(m);
			case "dddd":
				return DAYS_LONG[dow]!;
			case "ddd":
				return DAYS_SHORT[dow]!;
			case "DD":
				return pad2(d);
			case "D":
				return String(d);
			case "HH":
				return pad2(hh);
			case "H":
				return String(hh);
			case "mm":
				return pad2(min);
			case "m":
				return String(min);
			case "ss":
				return pad2(sec);
			case "s":
				return String(sec);
			default:
				return tok;
		}
	});
}

function addDays(date: Date, days: number): Date {
	const next = new Date(date.getTime());
	next.setDate(next.getDate() + days);
	return next;
}

/** Parses simple literal arguments inside a `tp.*(...)` call: strings, numbers, booleans, arrays, `vars`, and `tp.*` expressions. */
export function parseCallArgs(argText: string, resolveIdent?: (ident: string) => unknown): unknown[] {
	const args: unknown[] = [];
	const src = argText.trim();
	if (!src) return args;
	let i = 0;

	const skipWs = () => {
		while (i < src.length && /\s/.test(src[i]!)) i++;
	};

	const parseValue = (): unknown => {
		skipWs();
		if (i >= src.length) return undefined;
		const ch = src[i]!;
		if (ch === '"' || ch === "'" || ch === "`") {
			const quote = ch;
			i++;
			let out = "";
			while (i < src.length && src[i] !== quote) {
				if (src[i] === "\\" && i + 1 < src.length) {
					const next = src[i + 1]!;
					out += next === "n" ? "\n" : next === "t" ? "\t" : next;
					i += 2;
				} else {
					out += src[i++];
				}
			}
			if (i < src.length && src[i] === quote) i++;
			return out;
		}
		if (ch === "[") {
			i++;
			const arr: unknown[] = [];
			skipWs();
			while (i < src.length && src[i] !== "]") {
				arr.push(parseValue());
				skipWs();
				if (src[i] === ",") i++;
				skipWs();
			}
			if (src[i] === "]") i++;
			return arr;
		}
		// Number / boolean / null / identifier / nested `tp.x.y(...)` call
		const start = i;
		let parenDepth = 0;
		while (i < src.length) {
			const c = src[i]!;
			if (c === '"' || c === "'" || c === "`") {
				const q = c;
				i++;
				while (i < src.length && src[i] !== q) {
					if (src[i] === "\\") i++;
					i++;
				}
				if (i < src.length) i++;
				continue;
			}
			if (c === "(") parenDepth++;
			else if (c === ")" && parenDepth > 0) parenDepth--;
			else if (parenDepth === 0 && (c === "," || c === "]")) break;
			i++;
		}
		const raw = src.slice(start, i).trim();
		if (raw === "true") return true;
		if (raw === "false") return false;
		if (raw === "null" || raw === "undefined") return undefined;
		if (/^-?\d+(?:\.\d+)?$/.test(raw)) return Number(raw);
		if (resolveIdent) {
			const resolved = resolveIdent(raw);
			if (resolved !== undefined) return resolved;
		}
		return raw;
	};

	while (i < src.length) {
		skipWs();
		if (i >= src.length) break;
		args.push(parseValue());
		skipWs();
		if (src[i] === ",") i++;
	}
	return args;
}

const CURSOR_SENTINEL = "\u0000__SSL_STUDIO_TP_CURSOR__\u0000";

function parseSimpleLiteral(expr: string): string | null {
	const t = expr.trim();
	if (t.length >= 2 && ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'")) || (t.startsWith("`") && t.endsWith("`")))) {
		let out = "";
		for (let i = 1; i < t.length - 1; i++) {
			if (t[i] === "\\" && i + 1 < t.length - 1) {
				const next = t[++i]!;
				out += next === "n" ? "\n" : next === "t" ? "\t" : next;
			} else {
				out += t[i]!;
			}
		}
		return out;
	}
	if (/^-?\d+(?:\.\d+)?$/.test(t) || t === "true" || t === "false") return t;
	return null;
}

function resolveSyncToken(raw: string, ctx: TemplaterContext, vars: Map<string, string>): string | undefined {
	const t = raw.trim().replace(/^await\s+/, "").replace(/;+\s*$/, "");
	if (vars.has(t)) return vars.get(t)!;
	const now = ctx.now ?? new Date();
	if (t === "tp.file.title" || t === "tp.file.title()") return ctx.title;
	if (t === "tp.file.name" || t === "tp.file.name()") return ctx.fileName;
	if (t === "tp.file.folder" || t === "tp.file.folder()") return ctx.folder;
	if (t === "tp.file.selection" || t === "tp.file.selection()") return ctx.selection ?? "";
	if (t === "tp.project.name" || t === "tp.project.name()") return ctx.projectName;
	if (t === "tp.project.ticket" || t === "tp.project.ticket()") return ctx.ticket ?? "";
	const dateCall = /^tp\.date\.(now|tomorrow|yesterday)\s*\(([\s\S]*)\)$/.exec(t);
	if (dateCall) {
		const subArgs = parseCallArgs(dateCall[2]!, (id) => resolveSyncToken(id, ctx, vars));
		const fmt = typeof subArgs[0] === "string" && subArgs[0] ? subArgs[0] : "YYYY-MM-DD";
		const offset = typeof subArgs[1] === "number" ? subArgs[1] : 0;
		if (dateCall[1] === "now") return formatDateToken(offset ? addDays(now, offset) : now, fmt);
		if (dateCall[1] === "tomorrow") return formatDateToken(addDays(now, 1 + offset), fmt);
		if (dateCall[1] === "yesterday") return formatDateToken(addDays(now, -1 + offset), fmt);
	}
	return undefined;
}

/** Splits `<%* ... %>` statements separated by newlines or top-level semicolons. */
function splitExecStatements(block: string): string[] {
	const out: string[] = [];
	let cur = "";
	let quote: string | null = null;
	let depth = 0;
	for (let i = 0; i < block.length; i++) {
		const ch = block[i]!;
		if (quote) {
			cur += ch;
			if (ch === "\\" && i + 1 < block.length) cur += block[++i]!;
			else if (ch === quote) quote = null;
			continue;
		}
		if (ch === '"' || ch === "'" || ch === "`") {
			quote = ch;
			cur += ch;
			continue;
		}
		if (ch === "(" || ch === "[" || ch === "{") depth++;
		else if ((ch === ")" || ch === "]" || ch === "}") && depth > 0) depth--;
		if (depth === 0 && (ch === ";" || ch === "\n")) {
			const s = cur.trim();
			if (s && !s.startsWith("//")) out.push(s);
			cur = "";
			continue;
		}
		cur += ch;
	}
	const tail = cur.trim();
	if (tail && !tail.startsWith("//")) out.push(tail);
	return out;
}

async function evaluateExpression(
	rawExpr: string,
	ctx: TemplaterContext,
	vars: Map<string, string>,
	isExec = false,
): Promise<{ value: string; cancelled?: boolean }> {
	if (isExec) {
		let emitted = "";
		for (const stmt of splitExecStatements(rawExpr)) {
			const trAdd = /^tR\s*\+=\s*([\s\S]+)$/.exec(stmt);
			if (trAdd) {
				const rhs = await evaluateExpression(trAdd[1]!, ctx, vars, false);
				if (rhs.cancelled) return rhs;
				emitted += rhs.value;
				continue;
			}
			const res = await evaluateExpression(stmt, ctx, vars, false);
			if (res.cancelled) return res;
		}
		return { value: emitted };
	}

	const trimmed = rawExpr.trim().replace(/;+\s*$/, "");
	// Variable assignment without output: `<% let key = tp.system.prompt("Key"); %>` or `<% let env = "PROD" %>`
	const assign = /^(?:let|const|var)\s+([A-Za-z_]\w*)\s*=\s*([\s\S]+)$/.exec(trimmed);
	if (assign) {
		const varName = assign[1]!;
		const rhs = await evaluateExpression(assign[2]!, ctx, vars);
		if (rhs.cancelled) return rhs;
		vars.set(varName, rhs.value);
		return { value: "" };
	}

	// Variable interpolation: `<% varName %>` or `<%= varName %>`
	const varRef = /^=?\s*([A-Za-z_]\w*)$/.exec(trimmed);
	if (varRef && vars.has(varRef[1]!)) {
		return { value: vars.get(varRef[1]!)! };
	}

	const expr = trimmed.replace(/^=\s*/, "").replace(/^await\s+/, "");
	const lit = parseSimpleLiteral(expr);
	if (lit !== null) return { value: lit };
	const now = ctx.now ?? new Date();

	// Property-style expressions without parentheses
	if (expr === "tp.file.title") return { value: ctx.title };
	if (expr === "tp.file.name") return { value: ctx.fileName };
	if (expr === "tp.file.folder") return { value: ctx.folder };
	if (expr === "tp.file.selection") return { value: ctx.selection ?? "" };
	if (expr === "tp.project.name") return { value: ctx.projectName };
	if (expr === "tp.project.ticket") return { value: ctx.ticket ?? "" };

	// Method call: `tp.<group>.<method>(args)`
	const call = /^tp\.([a-zA-Z_]+)\.([a-zA-Z_]+)\s*\(([\s\S]*)\)$/.exec(expr);
	if (!call) {
		// Unrecognized expression: preserve it literally so users can see typos instead of losing text.
		return { value: `<% ${rawExpr.trim()} %>` };
	}

	const group = call[1]!;
	const method = call[2]!;
	const args = parseCallArgs(call[3]!, (id) => resolveSyncToken(id, ctx, vars));

	if (group === "date") {
		const fmt = typeof args[0] === "string" && args[0] ? args[0] : "YYYY-MM-DD";
		const offset = typeof args[1] === "number" ? args[1] : 0;
		if (method === "now") return { value: formatDateToken(offset ? addDays(now, offset) : now, fmt) };
		if (method === "tomorrow") return { value: formatDateToken(addDays(now, 1 + offset), fmt) };
		if (method === "yesterday") return { value: formatDateToken(addDays(now, -1 + offset), fmt) };
	}

	if (group === "file") {
		if (method === "title") return { value: ctx.title };
		if (method === "name") return { value: ctx.fileName };
		if (method === "folder") return { value: ctx.folder };
		if (method === "selection") return { value: ctx.selection ?? "" };
		if (method === "path") {
			const rel = args[0] === true;
			return { value: rel ? ctx.relativePath : (ctx.fullPath ?? ctx.relativePath) };
		}
		if (method === "cursor") return { value: CURSOR_SENTINEL };
		if (method === "creation_date" || method === "last_modified_date") {
			const fmt = typeof args[0] === "string" && args[0] ? args[0] : "YYYY-MM-DD HH:mm";
			return { value: formatDateToken(now, fmt) };
		}
	}

	if (group === "project") {
		if (method === "name") return { value: ctx.projectName };
		if (method === "ticket") return { value: ctx.ticket ?? "" };
	}

	if (group === "system") {
		if (method === "prompt") {
			const label = typeof args[0] === "string" ? args[0] : "Enter value";
			const def = typeof args[1] === "string" ? args[1] : "";
			if (!ctx.prompt) return { value: def };
			const answer = await ctx.prompt(label, def);
			if (answer === null) return { value: "", cancelled: true };
			return { value: answer };
		}
		if (method === "suggester") {
			const labels = Array.isArray(args[0]) ? args[0].map(String) : [];
			const values = Array.isArray(args[1]) ? args[1].map(String) : labels;
			const placeholder = typeof args[2] === "string" ? args[2] : typeof args[1] === "string" ? args[1] : undefined;
			if (!labels.length) return { value: "" };
			if (!ctx.suggest) return { value: values[0] ?? labels[0] ?? "" };
			const picked = await ctx.suggest(labels, values, placeholder);
			if (picked === null) return { value: "", cancelled: true };
			return { value: picked };
		}
		if (method === "clipboard") {
			if (!ctx.clipboard) return { value: "" };
			return { value: (await ctx.clipboard()) ?? "" };
		}
	}

	return { value: `<% ${rawExpr.trim()} %>` };
}

/**
 * Strips optional template metadata header comment (`<!-- template: ... -->`) from
 * a workspace template file and returns parsed metadata + body content.
 */
export function parseTemplateFile(raw: string, fallbackName: string, id: string, path: string): MarkdownTemplate {
	// Strip any blank lines after `<!-- template: ... -->` so Prettier formatting never leaves a blank line before `---` YAML frontmatter.
	const metaRe = /^\s*<!--\s*template:\s*([\s\S]*?)-->(?:[ \t]*\r?\n)*/i;
	const m = metaRe.exec(raw);
	let name = fallbackName;
	let description = "Workspace template";
	let folder: string | undefined;
	let fileName: string | undefined;
	let group: MarkdownTemplate["group"] = "Custom";
	let content = raw;

	if (m) {
		content = raw.slice(m[0].length);
		const body = m[1]!;
		for (const kv of body.matchAll(/([a-zA-Z_-]+)\s*=\s*"([^"]*)"/g)) {
			const key = kv[1]!.toLowerCase();
			const val = kv[2]!.trim();
			if (key === "name" && val) name = val;
			else if (key === "description" && val) description = val;
			else if (key === "folder" && val) folder = val;
			else if (key === "filename" && val) fileName = val;
			else if (key === "group" && (val === "Work" || val === "Knowledge" || val === "Notes" || val === "Custom")) group = val;
		}
	}

	return { id, name, description, group, folder, fileName, source: "workspace", path, content };
}

/**
 * Strips leading YAML frontmatter from raw template source BEFORE evaluating prompts
 * when inserting into a non-empty note, avoiding wasted interactive prompts inside
 * frontmatter that would be discarded anyway — while preserving any `let`/`const`/`var`
 * tags declared inside frontmatter whose variable is referenced later in the body.
 */
export function stripRawTemplateFrontmatter(raw: string): string {
	const m = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n)+/.exec(raw);
	if (!m) return raw;
	const fmBlock = m[1]!;
	const body = raw.slice(m[0].length);
	const preserved: string[] = [];
	for (const tag of fmBlock.matchAll(/<%[*_-]?([\s\S]*?)[_-]?%>/g)) {
		const inner = tag[1]!.trim();
		const decl = /^(?:let|const|var)\s+([A-Za-z_]\w*)\s*=/.exec(inner);
		if (decl && new RegExp(`\\b${decl[1]}\\b`).test(body)) {
			preserved.push(`<% ${inner} %>`);
		}
	}
	return preserved.length ? `${preserved.join("")}${body}` : body;
}

/**
 * Strips leading YAML frontmatter (`---\n...\n---\n`) from a rendered template when inserting
 * mid-document into an already non-empty note, shifting `cursorOffset` cleanly to match.
 */
export function stripTemplateFrontmatter(rendered: RenderedTemplate): RenderedTemplate {
	const m = /^---\r?\n[\s\S]*?\r?\n---(?:\r?\n)+/.exec(rendered.text);
	if (!m) return rendered;
	const cut = m[0].length;
	return {
		...rendered,
		text: rendered.text.slice(cut),
		cursorOffset: rendered.cursorOffset === null ? null : Math.max(0, rendered.cursorOffset - cut),
	};
}

/**
 * Renders a Templater template string against `ctx`.
 * Handles `<% ... %>`, `<%* ... %>`, `<%- ... -%>`, `<%_ ... _%>`, `let/const` variable capture & reuse,
 * and `{{date}}`/`{{time}}`/`{{title}}`/`{{ticket}}`/`{{project}}`.
 */
export async function renderTemplate(
	template: string,
	ctx: TemplaterContext,
	sharedVars?: Map<string, string>,
): Promise<RenderedTemplate> {
	const now = ctx.now ?? new Date();
	// 1. Expand simple Obsidian core template aliases `{{...}}` first.
	let source = template
		.replace(/\{\{\s*date\s*\}\}/gi, formatDateToken(now, "YYYY-MM-DD"))
		.replace(/\{\{\s*today\s*\}\}/gi, formatDateToken(now, "YYYY-MM-DD"))
		.replace(/\{\{\s*time\s*\}\}/gi, formatDateToken(now, "HH:mm"))
		.replace(/\{\{\s*title\s*\}\}/gi, ctx.title)
		.replace(/\{\{\s*ticket\s*\}\}/gi, ctx.ticket ?? "")
		.replace(/\{\{\s*project\s*\}\}/gi, ctx.projectName);

	// 2. Walk `<% ... %>` / `<%* ... %>` tags sequentially so interactive prompts appear in natural reading order.
	const TAG_RE = /<%([-_])?(\*)?([\s\S]*?)([-_])?%>/g;
	const vars = sharedVars ?? new Map<string, string>();
	let out = "";
	let lastIndex = 0;

	for (const match of source.matchAll(TAG_RE)) {
		const idx = match.index;
		const full = match[0];
		const trimLeft = match[1];
		const isExec = Boolean(match[2]);
		const expr = match[3] ?? "";
		const trimRight = match[4];

		let before = source.slice(lastIndex, idx);
		if (trimLeft === "_") before = before.replace(/[ \t\r\n]+$/, "");
		else if (trimLeft === "-") before = before.replace(/[ \t]*\r?\n$/, "");
		out += before;

		const res = await evaluateExpression(expr, ctx, vars, isExec);
		if (res.cancelled) return { text: "", cursorOffset: null, cancelled: true };
		out += res.value;

		let nextIndex = idx + full.length;
		if (trimRight === "_") {
			const ws = /^[ \t\r\n]+/.exec(source.slice(nextIndex));
			if (ws) nextIndex += ws[0].length;
		} else if (trimRight === "-") {
			const nl = /^[ \t]*\r?\n/.exec(source.slice(nextIndex));
			if (nl) nextIndex += nl[0].length;
		}
		lastIndex = nextIndex;
	}
	out += source.slice(lastIndex);

	// 3. Extract first cursor sentinel (remove any extras cleanly).
	const cursorPos = out.indexOf(CURSOR_SENTINEL);
	const clean = out.split(CURSOR_SENTINEL).join("");
	return {
		text: clean,
		cursorOffset: cursorPos >= 0 ? cursorPos : null,
		cancelled: false,
	};
}

/** Merges workspace templates with built-in defaults; a workspace template with matching id overrides the built-in one. */
export function mergeTemplates(workspace: readonly MarkdownTemplate[], defaults: readonly MarkdownTemplate[] = DEFAULT_TEMPLATES): MarkdownTemplate[] {
	const overridden = new Set(workspace.map((t) => t.id.toLowerCase()));
	return [...workspace, ...defaults.filter((t) => !overridden.has(t.id.toLowerCase()))];
}

/**
 * Built-in default templates for STARLIMS / business-analyst / developer documentation.
 * Any user can customize these by copying them to `docs/templates/<id>.md`.
 */
export const DEFAULT_TEMPLATES: readonly MarkdownTemplate[] = [
	{
		id: "ticket",
		name: "Ticket",
		description: "Work ticket with acceptance criteria, callout banner, and impacted areas",
		group: "Work",
		folder: "docs/tickets",
		source: "builtin",
		content: `---
ticket: <% tp.system.prompt("Ticket key (e.g. LIMS-123)", "LIMS-100") %>
title: <% tp.file.title %>
type: <% tp.system.suggester(["Feature", "Change request", "Bug fix", "Investigation"], ["feature", "change", "bug", "investigation"], "Ticket type") %>
status: open
created: <% tp.date.now("YYYY-MM-DD") %>
related: []
---

# <% tp.file.title %>

> [!important] Call to action
> Summarize the core business outcome and any deadline or regulatory impact here.

## What is asked

<% tp.file.cursor() %>

## Acceptance criteria

- [ ] Expected business behavior verified in test environment
- [ ] Edge cases and error messages confirmed with stakeholders

## Impacted STARLIMS areas

| Area | Object | Notes |
| --- | --- | --- |
| Script |  |  |
| Table |  |  |

## Notes

`,
	},
	{
		id: "change-spec",
		name: "Change Spec",
		description: "Functional and technical change specification linked to a ticket",
		group: "Work",
		folder: "docs/specs",
		source: "builtin",
		content: `---
title: <% tp.file.title %>
ticket: <% tp.system.prompt("Ticket key (leave empty if none)") %>
status: draft
created: <% tp.date.now("YYYY-MM-DD") %>
---

# <% tp.file.title %>

> [!summary] Overview
> One concise paragraph explaining what this change builds and why the lab needs it.

## Current vs proposed behavior

<% tp.file.cursor() %>

## In scope

- 

## Out of scope

- 

## STARLIMS objects touched

| Kind | Name | Change |
| --- | --- | --- |
| Script |  |  |
| Data source |  |  |

## Verification checklist

- [ ] Happy path verified with representative sample data
- [ ] Boundary and missing-data paths verified
- [ ] Rollback steps confirmed

> [!warning] Rollback & risks
> Note any schema, configuration, or scheduling dependencies before promoting to production.
`,
	},
	{
		id: "decision",
		name: "Decision Record (ADR)",
		description: "Architecture or business rule decision with alternatives and consequences",
		group: "Knowledge",
		folder: "docs/knowledge/decisions",
		source: "builtin",
		content: `---
title: <% tp.file.title %>
status: proposed
date: <% tp.date.now("YYYY-MM-DD") %>
ticket: <% tp.project.ticket %>
---

# <% tp.file.title %>

## Context

<% tp.file.cursor() %>

> [!important] Decision
> State the decision clearly in one or two direct sentences.

## Alternatives considered

| Option | Verdict | Trade-offs |
| --- | --- | --- |
| Chosen option | Accepted |  |
| Alternative | Rejected |  |

## Consequences

- **Positive:** 
- **Trade-offs:** 
`,
	},
	{
		id: "investigation",
		name: "Bug / Investigation",
		description: "Root-cause investigation notes with symptom callout, repro steps, and fix checks",
		group: "Knowledge",
		folder: "docs/knowledge/reference",
		source: "builtin",
		content: `---
title: <% tp.file.title %>
ticket: <% tp.project.ticket %>
status: open
date: <% tp.date.now("YYYY-MM-DD") %>
---

# <% tp.file.title %>

> [!bug] Symptom
> Describe what users observed, including exact error codes or sample states.

## Steps to reproduce

1. <% tp.file.cursor() %>

## Findings & root cause

- 

## Proposed fix & verification

- [ ] Root cause confirmed in code or SQL
- [ ] Regression test covers the failing scenario
`,
	},
	{
		id: "meeting-notes",
		name: "Meeting Notes",
		description: "Structured stakeholder or technical review notes with decisions and action items",
		group: "Notes",
		folder: "docs",
		source: "builtin",
		content: `---
title: <% tp.file.title %>
date: <% tp.date.now("YYYY-MM-DD") %>
ticket: <% tp.project.ticket %>
---

# <% tp.file.title %> — <% tp.date.now("MMM DD, YYYY") %>

## Agenda

1. <% tp.file.cursor() %>

## Discussion notes

- 

> [!important] Decisions agreed
> Record any scope, workflow, or priority decisions made in this session.

## Action items

- [ ] Action item — Owner (Due <% tp.date.now("YYYY-MM-DD", 7) %>)
`,
	},
	{
		id: "release-checklist",
		name: "Release Checklist",
		description: "Deployment runbook with pre-flight warning, migration steps, and smoke tests",
		group: "Work",
		folder: "docs",
		source: "builtin",
		content: `---
title: <% tp.file.title %>
date: <% tp.date.now("YYYY-MM-DD") %>
status: draft
ticket: <% tp.project.ticket %>
---

# <% tp.file.title %>

> [!warning] Pre-flight check
> Confirm backups, maintenance window, and stakeholder sign-off before starting deployment.

## Deployment sequence

| Step | Area | Action |
| --- | --- | --- |
| 1 | Database | <% tp.file.cursor() %> |
| 2 | Scripts |  |
| 3 | Config |  |

## Post-deploy smoke tests

- [ ] Primary workflow runs without errors
- [ ] Scheduled jobs / interfaces report healthy status
- [ ] Stakeholders notified

> [!caution] Rollback plan
> Steps to restore prior state if a critical defect is found during smoke testing.
`,
	},
	{
		id: "callout-cta",
		name: "Important Callout / CTA",
		description: "Insert an attention-grabbing Important callout box with action checklist",
		group: "Notes",
		source: "builtin",
		content: `> [!important] <% tp.system.prompt("Callout title", "Action required") %>
> <% tp.file.cursor() %>
> - [ ] Next step`,
	},
];
