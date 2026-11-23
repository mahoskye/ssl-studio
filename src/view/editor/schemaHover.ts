// Secondary Monaco Hover provider & cursor commands bridging SSL/SQL code to documented
// `schema/` tables/messages (ADR 0003: looks up identifiers purely against workspace schema docs).
import { extractSchemaPreview, findSchemaDocForIdentifier } from "../../shared/schemaIndex";
import { relativeTo } from "../../shared/paths";
import { backend } from "../backend";
import { docs } from "../project";
import { activeEditor } from "./EditorGroup";
import { monaco } from "./monaco";
import { activePath, canonical, documents, notify, openFile, state } from "../state";

const previewCache = new Map<string, { version: number; markdown: string }>();

async function loadSchemaMarkdown(docPath: string, doc: ReturnType<typeof docs>[number]): Promise<string> {
	const ver = state.treeVersion;
	const open = documents.get(canonical(docPath));
	const cacheKey = `${docPath}:${open ? open.model.getAlternativeVersionId() : ver}`;
	const hit = previewCache.get(cacheKey);
	if (hit && hit.version === ver) return hit.markdown;
	const text = open ? open.model.getValue() : await backend.read(docPath).then((r) => (r.binary ? "" : r.text), () => "");
	const preview = text ? extractSchemaPreview(doc, text, 12) : doc.summary || "";
	const rel = state.workspace?.root ? relativeTo(state.workspace.root, docPath).replace(/\\/g, "/") : doc.name;
	const markdown = [
		`**Schema: ${doc.title || doc.name}** (\`${rel}\`)`,
		"",
		preview,
		"",
		`*Tip: Run “Open schema doc for table at cursor” to jump directly to this definition.*`,
	]
		.filter((s, i) => i !== 2 || Boolean(s))
		.join("\n");
	if (previewCache.size > 120) previewCache.delete(previewCache.keys().next().value!);
	previewCache.set(cacheKey, { version: ver, markdown });
	return markdown;
}

let registered = false;

/** Registers secondary schema-table hover providers on SSL and SQL editors (runs beside starlims-lsp). */
export function registerSchemaHoverProviders(): void {
	if (registered) return;
	registered = true;
	for (const lang of ["ssl", "sql"] as const) {
		monaco.languages.registerHoverProvider(lang, {
			async provideHover(model, position) {
				const word = model.getWordAtPosition(position);
				if (!word || word.word.length < 2) return null;
				const doc = findSchemaDocForIdentifier(word.word, docs());
				if (!doc) return null;
				const value = await loadSchemaMarkdown(doc.path, doc);
				return {
					range: new monaco.Range(position.lineNumber, word.startColumn, position.lineNumber, word.endColumn),
					contents: [{ value }],
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
			const hit = findSchemaDocForIdentifier(word.word, docs());
			if (hit) {
				await openFile(hit.path);
				return;
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
