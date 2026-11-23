// Secondary Monaco Hover, Definition, Link, and Completion providers bridging SSL/SQL/XML/JSON
// code to documented `schema/` tables/columns and workspace tickets (ADR 0003: matches identifiers
// strictly against workspace docs and DDL, never parsing SSL).
import { relativeTo } from "../../shared/paths";
import { isCatalog } from "../../shared/projectDocs";
import type { DocFile } from "../../shared/protocol";
import {
	extractSchemaColumns,
	extractSchemaPreview,
	findSchemaDocForIdentifier,
	referencedSchemaTables,
	schemaDocKeys,
	type SchemaColumnInfo,
} from "../../shared/schemaIndex";
import { ticketMatcher } from "../../shared/ticketRefs";
import { backend } from "../backend";
import { docs } from "../project";
import { activePath, canonical, documents, notify, openFile, state } from "../state";
import { activeEditor } from "./EditorGroup";
import { monaco } from "./monaco";

const REF_SCHEME = "ssl-studio-schema-ref";
const refUri = (file: string) => monaco.Uri.from({ scheme: REF_SCHEME, path: "/", query: JSON.stringify({ file }) });

const previewCache = new Map<string, { version: number; markdown: string }>();
const columnCache = new Map<string, { version: number; columns: SchemaColumnInfo[] }>();

async function readDocText(docPath: string): Promise<string> {
	const open = documents.get(canonical(docPath));
	if (open) return open.model.getValue();
	return backend.read(docPath).then((r) => (r.binary ? "" : r.text), () => "");
}

function cacheKeyFor(docPath: string): { key: string; ver: number } {
	const ver = state.treeVersion;
	const open = documents.get(canonical(docPath));
	return { key: `${docPath}:${open ? open.model.getAlternativeVersionId() : ver}`, ver };
}

async function loadSchemaMarkdown(docPath: string, doc: DocFile): Promise<string> {
	const { key, ver } = cacheKeyFor(docPath);
	const hit = previewCache.get(key);
	if (hit && hit.version === ver) return hit.markdown;
	const text = await readDocText(docPath);
	const preview = text ? extractSchemaPreview(doc, text, 12) : doc.summary || "";
	const rel = state.workspace?.root ? relativeTo(state.workspace.root, docPath).replace(/\\/g, "/") : doc.name;
	const markdown = [
		`**Schema: ${doc.title || doc.name}** (\`${rel}\`)`,
		"",
		preview,
		"",
		`*Ctrl+Click or F12 to jump directly to this schema doc.*`,
	]
		.filter((s, i) => i !== 2 || Boolean(s))
		.join("\n");
	if (previewCache.size > 120) previewCache.delete(previewCache.keys().next().value!);
	previewCache.set(key, { version: ver, markdown });
	return markdown;
}

async function loadColumnsForDoc(doc: DocFile): Promise<SchemaColumnInfo[]> {
	const { key, ver } = cacheKeyFor(doc.path);
	const hit = columnCache.get(key);
	if (hit && hit.version === ver) return hit.columns;
	const text = await readDocText(doc.path);
	const columns = text ? extractSchemaColumns(doc, text) : [];
	if (columnCache.size > 120) columnCache.delete(columnCache.keys().next().value!);
	columnCache.set(key, { version: ver, columns });
	return columns;
}

let cachedTicketSource: readonly DocFile[] | null = null;
let cachedTicketMap = new Map<string, DocFile>();
let cachedTicketMatch: (text: string) => { from: number; to: number; key: string }[] = () => [];

function ticketIndex() {
	const all = docs();
	if (all !== cachedTicketSource) {
		cachedTicketSource = all;
		cachedTicketMap = new Map();
		const keys: string[] = [];
		for (const d of all) {
			if (!d.exists || d.group !== "tickets" || isCatalog(d) || !d.ticket) continue;
			cachedTicketMap.set(d.ticket.toLowerCase(), d);
			keys.push(d.ticket);
		}
		cachedTicketMatch = ticketMatcher(keys);
	}
	return { map: cachedTicketMap, match: cachedTicketMatch };
}

function findTicketAtPosition(lineText: string, column: number): { doc: DocFile; startColumn: number; endColumn: number } | null {
	const { map, match } = ticketIndex();
	const offset = column - 1;
	for (const m of match(lineText)) {
		if (offset >= m.from && offset <= m.to) {
			const doc = map.get(m.key.toLowerCase());
			if (doc) return { doc, startColumn: m.from + 1, endColumn: m.to + 1 };
		}
	}
	return null;
}

function ticketHoverMarkdown(doc: DocFile): string {
	const rel = state.workspace?.root ? relativeTo(state.workspace.root, doc.path).replace(/\\/g, "/") : doc.name;
	const meta = [
		doc.status ? `Status: **${doc.status}**` : "",
		doc.parent ? `Parent: \`${doc.parent}\`` : "",
		doc.tasks && doc.tasks.total > 0 ? `Checklist: ${doc.tasks.done}/${doc.tasks.total}` : "",
	]
		.filter(Boolean)
		.join(" · ");
	return [
		`**${doc.ticket}${doc.title ? `: ${doc.title}` : ""}** (\`${rel}\`)`,
		...(meta ? ["", meta] : []),
		...(doc.summary ? ["", doc.summary] : []),
	].join("\n");
}

function columnHoverMarkdown(matches: readonly SchemaColumnInfo[]): string {
	const lines: string[] = [];
	for (const col of matches.slice(0, 4)) {
		const rel = state.workspace?.root ? relativeTo(state.workspace.root, col.docPath).replace(/\\/g, "/") : col.docPath;
		const sig = [col.type ? `\`${col.type}\`` : "", col.constraints && col.constraints !== "—" ? col.constraints : ""].filter(Boolean).join(" — ");
		lines.push(`**${col.table}.${col.name}**${sig ? ` (${sig})` : ""}`);
		if (col.notes) lines.push(col.notes);
		lines.push(`*From \`${rel}\`*`);
		lines.push("");
	}
	return lines.join("\n").trim();
}

function qualifierBeforeWord(line: string, wordStartCol: number): string | null {
	const before = line.slice(0, Math.max(0, wordStartCol - 1));
	const m = /(?:^|[^\w$])([A-Za-z_][\w$]*)\.\s*$/.exec(before);
	return m ? m[1]! : null;
}

let registered = false;

/** Registers secondary schema/ticket Hover, Definition, Link & Completion providers (runs beside starlims-lsp). */
export function registerSchemaHoverProviders(): void {
	if (registered) return;
	registered = true;

	monaco.editor.registerLinkOpener({
		open(resource) {
			if (resource.scheme !== REF_SCHEME) return false;
			try {
				const place = JSON.parse(resource.query) as { file?: string };
				if (place.file) void openFile(place.file);
			} catch {
				// Ignore malformed internal link.
			}
			return true;
		},
	});

	for (const lang of ["ssl", "sql"] as const) {
		monaco.languages.registerHoverProvider(lang, {
			async provideHover(model, position) {
				const lineText = model.getLineContent(position.lineNumber);
				const ticketHit = findTicketAtPosition(lineText, position.column);
				if (ticketHit) {
					return {
						range: new monaco.Range(position.lineNumber, ticketHit.startColumn, position.lineNumber, ticketHit.endColumn),
						contents: [{ value: ticketHoverMarkdown(ticketHit.doc) }],
					};
				}
				const word = model.getWordAtPosition(position);
				if (!word || word.word.length < 2) return null;
				const allDocs = docs();
				const range = new monaco.Range(position.lineNumber, word.startColumn, position.lineNumber, word.endColumn);

				// 1. Qualified `TABLE.COLUMN` hover
				const qualifier = qualifierBeforeWord(lineText, word.startColumn);
				if (qualifier) {
					const tableDoc = findSchemaDocForIdentifier(qualifier, allDocs);
					if (tableDoc) {
						const cols = await loadColumnsForDoc(tableDoc);
						const qLower = qualifier.toLowerCase();
						const colLower = word.word.toLowerCase();
						const exact = cols.filter(
							(c) => c.name.toLowerCase() === colLower && (c.table.toLowerCase() === qLower || c.table.toLowerCase().endsWith(`.${qLower}`)),
						);
						const hits = exact.length ? exact : cols.filter((c) => c.name.toLowerCase() === colLower);
						if (hits.length) return { range, contents: [{ value: columnHoverMarkdown(hits) }] };
					}
				}

				// 2. Documented schema table hover
				const tableDoc = findSchemaDocForIdentifier(word.word, allDocs);
				if (tableDoc) {
					const value = await loadSchemaMarkdown(tableDoc.path, tableDoc);
					return { range, contents: [{ value }] };
				}

				// 3. Column hover for tables referenced elsewhere in this file
				if (model.getValueLength() <= 200_000) {
					const refTables = referencedSchemaTables(model.getValue(), allDocs, 8);
					if (refTables.length) {
						const colLower = word.word.toLowerCase();
						const matches: SchemaColumnInfo[] = [];
						for (const refDoc of refTables) {
							const cols = await loadColumnsForDoc(refDoc);
							for (const col of cols) {
								if (col.name.toLowerCase() === colLower) matches.push(col);
							}
						}
						if (matches.length) return { range, contents: [{ value: columnHoverMarkdown(matches) }] };
					}
				}
				return null;
			},
		});

		monaco.languages.registerDefinitionProvider(lang, {
			provideDefinition(model, position) {
				const lineText = model.getLineContent(position.lineNumber);
				const ticketHit = findTicketAtPosition(lineText, position.column);
				if (ticketHit) {
					return {
						uri: monaco.Uri.file(ticketHit.doc.path),
						range: new monaco.Range(1, 1, 1, 1),
					};
				}
				const word = model.getWordAtPosition(position);
				if (!word || word.word.length < 2) return null;
				const allDocs = docs();
				const tableDoc = findSchemaDocForIdentifier(word.word, allDocs);
				if (tableDoc) {
					return {
						uri: monaco.Uri.file(tableDoc.path),
						range: new monaco.Range(1, 1, 1, 1),
					};
				}
				const qualifier = qualifierBeforeWord(lineText, word.startColumn);
				if (qualifier) {
					const qDoc = findSchemaDocForIdentifier(qualifier, allDocs);
					if (qDoc) {
						return {
							uri: monaco.Uri.file(qDoc.path),
							range: new monaco.Range(1, 1, 1, 1),
						};
					}
				}
				return null;
			},
		});

		monaco.languages.registerLinkProvider(lang, {
			provideLinks(model) {
				const lineCount = model.getLineCount();
				if (lineCount > 5000) return { links: [] };
				const allDocs = docs();
				const wsRoot = state.workspace?.root;
				const { map: ticketMap, match: matchTickets } = ticketIndex();

				// Build a single combined regex for documented schema table names (>= 3 chars) so scanning is O(lines).
				const schemaKeySet = new Set<string>();
				for (const d of allDocs) {
					if (!d.exists || d.group !== "schema" || isCatalog(d)) continue;
					for (const k of schemaDocKeys(d)) {
						if (k.length >= 3 && /^[a-z_][\w$]*$/i.test(k)) schemaKeySet.add(k);
					}
				}
				const schemaKeys = [...schemaKeySet].sort((a, b) => b.length - a.length);
				const schemaRe = schemaKeys.length
					? new RegExp(`(?<![A-Za-z0-9_])(${schemaKeys.map((k) => k.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|")})(?![A-Za-z0-9_])`, "gi")
					: null;

				const links: monaco.languages.ILink[] = [];
				const MAX_LINKS = 500;
				for (let lineNum = 1; lineNum <= lineCount && links.length < MAX_LINKS; lineNum++) {
					const text = model.getLineContent(lineNum);
					if (!text.trim()) continue;
					const taken: [number, number][] = [];

					for (const m of matchTickets(text)) {
						const doc = ticketMap.get(m.key.toLowerCase());
						if (!doc) continue;
						taken.push([m.from, m.to]);
						links.push({
							range: new monaco.Range(lineNum, m.from + 1, lineNum, m.to + 1),
							url: refUri(canonical(doc.path)),
							tooltip: `Open ${doc.ticket}${doc.title ? `: ${doc.title}` : ""}`,
						});
						if (links.length >= MAX_LINKS) break;
					}

					if (schemaRe && links.length < MAX_LINKS) {
						schemaRe.lastIndex = 0;
						for (let m = schemaRe.exec(text); m && links.length < MAX_LINKS; m = schemaRe.exec(text)) {
							const from = m.index;
							const to = from + m[0].length;
							if (taken.some(([a, b]) => from < b && to > a)) continue;
							const doc = findSchemaDocForIdentifier(m[0], allDocs);
							if (!doc) continue;
							const rel = wsRoot ? relativeTo(wsRoot, doc.path).replace(/\\/g, "/") : doc.name;
							links.push({
								range: new monaco.Range(lineNum, from + 1, lineNum, to + 1),
								url: refUri(canonical(doc.path)),
								tooltip: `Open schema ${doc.title || doc.name} (${rel})`,
							});
						}
					}
				}
				return { links };
			},
		});

		monaco.languages.registerCompletionItemProvider(lang, {
			triggerCharacters: ["."],
			async provideCompletionItems(model, position) {
				const allDocs = docs();
				const lineBefore = model.getLineContent(position.lineNumber).slice(0, position.column - 1);

				// 1. After `TABLE.` -> suggest documented columns of that table.
				const dotMatch = /(?:^|[^\w$])([A-Za-z_][\w$]*)\.([A-Za-z_][\w$]*)?$/.exec(lineBefore);
				if (dotMatch) {
					const tbl = dotMatch[1]!;
					const typed = dotMatch[2] ?? "";
					const tableDoc = findSchemaDocForIdentifier(tbl, allDocs);
					if (!tableDoc) return { suggestions: [] };
					const cols = await loadColumnsForDoc(tableDoc);
					const tblLower = tbl.toLowerCase();
					const scoped = cols.filter((c) => c.table.toLowerCase() === tblLower || c.table.toLowerCase().endsWith(`.${tblLower}`));
					const list = scoped.length ? scoped : cols;
					const range = new monaco.Range(position.lineNumber, position.column - typed.length, position.lineNumber, position.column);
					return {
						suggestions: list.map((col, idx) => ({
							label: col.name,
							kind: monaco.languages.CompletionItemKind.Field,
							detail: [col.type, col.constraints && col.constraints !== "—" ? col.constraints : ""].filter(Boolean).join(" · ") || `${col.table} column`,
							documentation: col.notes || undefined,
							insertText: col.name,
							sortText: `z_col_${String(idx).padStart(4, "0")}`,
							range,
						})),
					};
				}

				// 2. Bare prefix (>= 2 chars) -> suggest documented schema table names + columns of tables referenced in this file.
				const wordMatch = /(?:^|[^\w$])([A-Za-z_][\w$]{1,})$/.exec(lineBefore);
				if (!wordMatch) return { suggestions: [] };
				const prefix = wordMatch[1]!;
				const prefixLower = prefix.toLowerCase();
				const range = new monaco.Range(position.lineNumber, position.column - prefix.length, position.lineNumber, position.column);
				const suggestions: monaco.languages.CompletionItem[] = [];
				const seenTables = new Set<string>();

				for (const d of allDocs) {
					if (!d.exists || d.group !== "schema" || isCatalog(d)) continue;
					const candidates = [
						...(d.schemaObjects ?? []),
						...(d.title && /^[A-Za-z_][\w$.]{1,64}$/.test(d.title.trim()) ? [d.title.trim()] : []),
						(d.name.split(/[\\/]/).pop() ?? d.name).replace(/\.(md|markdown|sql|ddl|pks|pkb)$/i, ""),
					];
					for (const rawName of candidates) {
						const bare = rawName.includes(".") ? rawName.split(".").pop()! : rawName;
						const lower = bare.toLowerCase();
						if (!bare || bare.length < 2 || seenTables.has(lower) || !lower.includes(prefixLower)) continue;
						seenTables.add(lower);
						suggestions.push({
							label: bare,
							kind: monaco.languages.CompletionItemKind.Struct,
							detail: `Schema table (${d.name})`,
							documentation: d.summary || undefined,
							insertText: bare,
							sortText: `z_tbl_${lower}`,
							range,
						});
					}
				}

				if (model.getValueLength() <= 200_000) {
					const refTables = referencedSchemaTables(model.getValue(), allDocs, 6);
					const seenCols = new Set<string>();
					for (const refDoc of refTables) {
						const cols = await loadColumnsForDoc(refDoc);
						for (const col of cols) {
							const colKey = `${col.table.toLowerCase()}.${col.name.toLowerCase()}`;
							if (seenCols.has(colKey) || !col.name.toLowerCase().includes(prefixLower)) continue;
							seenCols.add(colKey);
							suggestions.push({
								label: col.name,
								kind: monaco.languages.CompletionItemKind.Field,
								detail: `${col.table}${col.type ? ` · ${col.type}` : ""}`,
								documentation: col.notes || undefined,
								insertText: col.name,
								sortText: `z_col_${col.name.toLowerCase()}`,
								range,
							});
						}
					}
				}

				return { suggestions };
			},
		});
	}

	// Ticket-key hover summaries on config/form languages as well.
	for (const lang of ["xml", "json", "jsonc"] as const) {
		monaco.languages.registerHoverProvider(lang, {
			provideHover(model, position) {
				const ticketHit = findTicketAtPosition(model.getLineContent(position.lineNumber), position.column);
				if (!ticketHit) return null;
				return {
					range: new monaco.Range(position.lineNumber, ticketHit.startColumn, position.lineNumber, ticketHit.endColumn),
					contents: [{ value: ticketHoverMarkdown(ticketHit.doc) }],
				};
			},
		});
	}
}

/** Command Palette action: jumps from the identifier under cursor in SSL/SQL to its documented schema file. */
export async function openSchemaAtCursor(): Promise<void> {
	const editor = activeEditor();
	const model = editor?.getModel();
	const pos = editor?.getPosition();
	if (model && pos) {
		const word = model.getWordAtPosition(pos);
		if (word) {
			const allDocs = docs();
			const hit = findSchemaDocForIdentifier(word.word, allDocs);
			if (hit) {
				await openFile(hit.path);
				return;
			}
			const qualifier = qualifierBeforeWord(model.getLineContent(pos.lineNumber), word.startColumn);
			if (qualifier) {
				const qHit = findSchemaDocForIdentifier(qualifier, allDocs);
				if (qHit) {
					await openFile(qHit.path);
					return;
				}
			}
			notify(`No documented schema file matches “${word.word}”.`);
			return;
		}
	}
	// Fallback: let user pick from documented schema files if cursor isn't on a table name.
	const schemaDocs = docs().filter((d) => d.exists && d.group === "schema" && !/index\.md$/i.test(d.name));
	if (!schemaDocs.length) return notify("No schema documents exist in this project yet.");
	const { choose } = await import("../dialogs");
	const labels = schemaDocs.map((d) => `${d.title || d.name} (${d.name})`);
	const picked = await choose("Open which schema document?", labels);
	if (!picked) return;
	const found = schemaDocs[labels.indexOf(picked)];
	if (found) await openFile(found.path);
}

/** Command Palette action: appends the selected constant/setting/table identifier to a CSV registry pre-linked to the active ticket. */
export async function addSelectionToRegistry(): Promise<void> {
	const editor = activeEditor();
	const model = editor?.getModel();
	const sel = editor?.getSelection();
	let itemName = "";
	if (model && sel && !sel.isEmpty()) {
		itemName = model.getValueInRange(sel).trim().replace(/^["'`[]|["'`\]]$/g, "");
	} else if (model && editor?.getPosition()) {
		itemName = model.getWordAtPosition(editor.getPosition()!)?.word ?? "";
	}
	const { docs: allDocs } = await import("../project");
	const { ticketForFile } = await import("../../shared/workContext");
	const { ticketAtHand, addRegistryRowForTicket } = await import("../projectDocs");
	const key =
		state.settings.activeTicket?.trim() ||
		ticketForFile(allDocs(), activePath(), state.workspace?.root) ||
		ticketAtHand() ||
		"";
	if (!key) {
		notify("Set an active ticket (or open a ticket-linked file) first, then add the registry row.");
		return;
	}
	await addRegistryRowForTicket(key, itemName || undefined);
}
