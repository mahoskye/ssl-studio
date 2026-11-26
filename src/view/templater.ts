// Obsidian Templater-style workflow for SSL Studio:
// - Discovers customizable templates from `<docs>/templates/*.md` (or `settings.templatesFolder`)
// - Merges workspace templates with built-in defaults (workspace files override matching defaults)
// - Runs dynamic `<% tp.* %>` expressions using SSL Studio's native `ask()` and `choose()` dialogs
// - Provides Insert Template, New Note from Template, Customize Template, Insert Callout, and Insert Image actions.
import { addToFrontMatterList, frontMatter, withFrontMatter } from "../shared/frontMatter";
import { buildCalloutBlock, CALLOUT_PRESETS } from "../shared/markdownEdit";
import { baseName, dirName, isInside, joinPath, relativePath, relativeTo, resolvePath } from "../shared/paths";
import { slug } from "../shared/projectDocs";
import type { BackendApi } from "../shared/protocol";
import {
	DEFAULT_TEMPLATES,
	formatTemplateHeaderAttr,
	mergeTemplates,
	parseTemplateFile,
	renderTemplate,
	stripRawTemplateFrontmatter,
	stripTemplateFrontmatter,
	type MarkdownTemplate,
	type TemplaterContext,
} from "../shared/templater";
import { backend, fileExists } from "./backend";
import { ask, browseWorkspaceFile, choose, quickPick, type QuickPickOption } from "./dialogs";
import { activeEditor } from "./editor/EditorGroup";
import { listWorkspaceImages } from "./editor/imageResolve";
import { activeLiveEditor } from "./editor/liveBridge";
import { isMarkdown } from "./project";
import { ticketAtHand } from "./projectDocs";
import { activePath, applyText, canonical, documents, fileRemoved, markdownMode, notify, openFile, setMarkdownMode, setState, state } from "./state";

/** Ensures a Markdown file is editable without pulling users out of Source mode if they prefer it. */
function ensureEditableMarkdown(path: string, group?: number) {
	if (markdownMode(path, group) === "read") {
		setMarkdownMode(path, state.settings.livePreview === false ? "source" : "live", group);
	}
}

/**
 * Makes a new file with `text` in it, and refuses as `create` does when something is there already. Making the
 * file and writing it are two calls to the backend: when the write failed after the file was made, the empty file
 * stayed, and the next try at the same name found it, said "already exists" and opened it (an empty template of a
 * built-in's name took the built-in's place). The empty file is taken away again, to the trash and only while it
 * is still empty, and the write's own error is the one that is told. Where nothing can be put in the trash (the
 * browser host) it stays, as before.
 */
export async function createWithText(api: Pick<BackendApi, "create" | "write" | "sizes" | "trash">, dest: string, text: string): Promise<void> {
	await api.create(dest, "file");
	try {
		await api.write(dest, text);
	} catch (e) {
		const sizes = await api.sizes([dest]).catch(() => null);
		if (sizes?.[dest] === 0) await api.trash(dest).catch(() => {});
		throw e;
	}
}

/** Absolute path to the workspace templates folder (`<docs>/templates` by default, or `settings.templatesFolder`). */
export function templatesFolderPath(): string | null {
	const root = state.workspace?.root;
	if (!root) return null;
	const custom = state.settings.templatesFolder?.trim();
	if (custom && !custom.startsWith("/") && !custom.startsWith("\\") && !/^[a-zA-Z]:/.test(custom)) {
		const resolved = resolvePath(root, custom);
		if (isInside(root, resolved)) return resolved;
	}
	const docsRel = state.project?.docs ?? "docs";
	return joinPath(root, ...docsRel.split(/[\\/]/).filter((p) => p && p !== "."), "templates");
}

/** Recursively discovers `.md` / `.markdown` templates under `dir` (up to depth 4). */
async function walkTemplateDir(dir: string, prefix = "", depth = 0): Promise<{ path: string; name: string; relStem: string }[]> {
	if (depth > 4) return [];
	const out: { path: string; name: string; relStem: string }[] = [];
	try {
		const entries = await backend.list(dir);
		for (const entry of entries) {
			if (entry.name.startsWith(".")) continue;
			if (entry.kind === "dir") {
				const subPrefix = prefix ? `${prefix}/${entry.name}` : entry.name;
				out.push(...(await walkTemplateDir(entry.path, subPrefix, depth + 1)));
			} else if (entry.kind === "file" && /\.(md|markdown)$/i.test(entry.name)) {
				const stem = entry.name.replace(/\.(md|markdown)$/i, "");
				out.push({ path: entry.path, name: entry.name, relStem: prefix ? `${prefix}/${stem}` : stem });
			}
		}
	} catch {
		// Folder missing or unreadable.
	}
	return out;
}

/** Loads workspace Markdown templates recursively from the templates folder and merges them with built-in defaults. */
export async function loadMarkdownTemplates(): Promise<MarkdownTemplate[]> {
	const dir = templatesFolderPath();
	if (!dir) return [...DEFAULT_TEMPLATES];
	try {
		const mdFiles = await walkTemplateDir(dir);
		const workspace: MarkdownTemplate[] = [];
		for (const entry of mdFiles) {
			try {
				const res = await backend.read(entry.path);
				if (res.binary) continue;
				const stem = entry.name.replace(/\.(md|markdown)$/i, "");
				const id = entry.relStem.includes("/")
					? entry.relStem
							.split("/")
							.map((p) => slug(p).toLowerCase() || p.toLowerCase())
							.join("/")
					: slug(stem).toLowerCase() || stem.toLowerCase();
				const displayName = entry.relStem
					.split("/")
					.map((p) => p.replace(/[-_]+/g, " ").replace(/\b\w/g, (c) => c.toUpperCase()))
					.join(" / ");
				workspace.push(parseTemplateFile(res.text, displayName, id, entry.path));
			} catch {
				// Skip unreadable file.
			}
		}
		return mergeTemplates(workspace, DEFAULT_TEMPLATES);
	} catch {
		return [...DEFAULT_TEMPLATES];
	}
}

function activeSelectionText(): string {
	const live = activeLiveEditor();
	if (live) return live.getSelectedText();
	const ed = activeEditor();
	const model = ed?.getModel();
	const sel = ed?.getSelection();
	return model && !model.isDisposed() && sel && !sel.isEmpty() ? model.getValueInRange(sel) : "";
}

/** Returns the open document only if the workspace, active tab, and Monaco model still match the captured snapshot. */
function activeDocIfCurrent(startRoot: string | undefined, canonPath: string) {
	if (state.workspace?.root !== startRoot || activePath() !== canonPath) return null;
	const docObj = documents.get(canonPath);
	return docObj && !docObj.model.isDisposed() ? docObj : null;
}

function buildContext(targetPath: string | null, explicitTitle?: string): TemplaterContext {
	const root = state.workspace?.root ?? "";
	const fileName = targetPath ? baseName(targetPath) : `${slug(explicitTitle || "Untitled") || "Untitled"}.md`;
	const title = explicitTitle?.trim() || fileName.replace(/\.(md|markdown)$/i, "");
	const rel = targetPath && root ? relativeTo(root, targetPath).split("\\").join("/") : fileName;
	const folder = targetPath && root ? relativeTo(root, dirName(targetPath)).split("\\").join("/") : "";

	return {
		title,
		fileName,
		relativePath: rel,
		fullPath: targetPath ?? undefined,
		folder: folder === "." ? "" : folder,
		projectName: state.project?.name || state.workspace?.name || "Project",
		ticket: ticketAtHand() || "",
		schemaFolder: (state.project?.schema || "schema").replace(/^[./\\]+|[\\/]+$/g, "") || "schema",
		plansFolder: (state.project?.plans || "design").replace(/^[./\\]+|[\\/]+$/g, "") || "design",
		selection: activeSelectionText(),
		prompt: (label, def) => ask(label, def ?? ""),
		suggest: async (labels, values, placeholder) => {
			const picked = await quickPick<number>({
				title: placeholder || "Choose an option",
				placeholder: "Filter options…",
				items: labels.map((label, idx) => ({ label, value: idx })),
			});
			if (picked === null) return null;
			return values[picked] ?? labels[picked] ?? null;
		},
		clipboard: async () => (await navigator.clipboard?.readText().catch(() => "")) ?? "",
	};
}

/** Lets the user choose a template (workspace custom templates listed first, then built-in defaults). */
async function pickTemplate(title: string): Promise<MarkdownTemplate | null> {
	const all = await loadMarkdownTemplates();
	const items: QuickPickOption<MarkdownTemplate>[] = all.map((tpl) => ({
		value: tpl,
		label: tpl.name,
		icon: "notebook-template",
		badge: tpl.source === "workspace" ? { text: "Custom", tone: "active" } : undefined,
		detail: tpl.group,
		description: tpl.description,
		keywords: `${tpl.id} ${tpl.group} ${tpl.source}`,
	}));
	return quickPick<MarkdownTemplate>({
		title,
		placeholder: "Search templates…",
		items,
	});
}

/** Inserts a text snippet at the active editor's cursor (Live CM6 or Monaco Source), optionally landing at `cursorOffset`. */
function insertIntoActiveEditor(text: string, cursorOffset: number | null, opts?: { asBlock?: boolean }): boolean {
	const live = activeLiveEditor();
	if (live) {
		live.insertText(text, cursorOffset ?? undefined, opts);
		return true;
	}
	const editor = activeEditor();
	const model = editor?.getModel();
	if (!editor || !model || model.isDisposed()) return false;
	const sel = editor.getSelection() ?? {
		startLineNumber: 1,
		startColumn: 1,
		endLineNumber: 1,
		endColumn: 1,
	};
	const isEmpty = sel.startLineNumber === sel.endLineNumber && sel.startColumn === sel.endColumn;
	const eol = model.getEOL();
	const normText = text.replace(/\r?\n/g, eol);
	const normCursor = cursorOffset !== null ? text.slice(0, cursorOffset).replace(/\r?\n/g, eol).length : null;
	let insertText = normText;
	let offsetDelta = 0;
	let range = sel;
	if (opts?.asBlock && isEmpty) {
		const lineContent = model.getLineContent(sel.startLineNumber);
		if (lineContent.trim()) {
			const endCol = lineContent.length + 1;
			range = { startLineNumber: sel.startLineNumber, startColumn: endCol, endLineNumber: sel.startLineNumber, endColumn: endCol };
			insertText = `${eol}${eol}${normText}`;
			offsetDelta = eol.length * 2;
		}
	}
	const startOffset = model.getOffsetAt({ lineNumber: range.startLineNumber, column: range.startColumn });
	editor.pushUndoStop();
	editor.executeEdits("templater", [{ range, text: insertText, forceMoveMarkers: true }]);
	editor.pushUndoStop();
	if (normCursor !== null) {
		const targetPos = model.getPositionAt(startOffset + offsetDelta + normCursor);
		editor.setPosition(targetPos);
		editor.revealPositionInCenterIfOutsideViewport(targetPos);
	}
	editor.focus();
	return true;
}

/** Inserts a chosen Templater template at the cursor of the active Markdown editor, merging any missing template YAML keys into existing frontmatter. */
export async function insertMarkdownTemplate(explicit?: MarkdownTemplate): Promise<void> {
	const path = activePath();
	if (!path || !isMarkdown(path)) {
		notify("Open a Markdown document to insert a template.");
		return;
	}
	const startRoot = state.workspace?.root;
	const canonPath = canonical(path);
	if (!activeDocIfCurrent(startRoot, canonPath)) return;

	// Pick template BEFORE switching Read -> Live so cancelling leaves view mode untouched.
	const tpl = explicit ?? (await pickTemplate("Insert template at cursor"));
	if (!tpl) return;
	const docBeforeRender = activeDocIfCurrent(startRoot, canonPath);
	if (!docBeforeRender) return;

	const existing = docBeforeRender.model.getValue();
	const existingFm = frontMatter(existing);
	const hasExistingFm = existingFm.lines > 0;
	const hasBodyContent = existing.trim().length > 0;
	const tplHasFm = frontMatter(tpl.content).lines > 0;

	// If the target doc already has YAML frontmatter, strip keys that are ALREADY present in the target
	// BEFORE evaluating interactive prompts so users aren't asked for duplicate properties, while still
	// prompting for and merging any missing template properties (e.g. status, ticket, tags).
	const existingKeys = hasExistingFm ? new Set(Object.keys(existingFm.values)) : undefined;
	const sourceContent = hasExistingFm
		? stripRawTemplateFrontmatter(tpl.content, existingKeys)
		: hasBodyContent
			? stripRawTemplateFrontmatter(tpl.content)
			: tpl.content;
	const renderedRaw = await renderTemplate(sourceContent, buildContext(path));
	if (renderedRaw.cancelled) return;
	if (!activeDocIfCurrent(startRoot, canonPath)) return;

	if (!activeLiveEditor() && !activeEditor()?.getDomNode()?.offsetParent) {
		ensureEditableMarkdown(path, state.activeGroup);
		for (let i = 0; i < 12 && !activeLiveEditor() && !activeEditor()?.getDomNode()?.offsetParent; i++) {
			await new Promise((r) => requestAnimationFrame(r));
			if (!activeDocIfCurrent(startRoot, canonPath)) return;
		}
	}
	const docObj = activeDocIfCurrent(startRoot, canonPath);
	if (!docObj) return;

	const latestBeforeInsert = docObj.model.getValue();
	const latestFm = frontMatter(latestBeforeInsert);
	const hadExistingFmNow = latestFm.lines > 0;
	const hadBodyNow = latestBeforeInsert.trim().length > 0;

	// Insert the stripped body at the user's current cursor FIRST so merging YAML keys
	// never corrupts cursor position in Live (CM6) or Source (Monaco) mode.
	const rendered = hadExistingFmNow || hadBodyNow ? stripTemplateFrontmatter(renderedRaw) : renderedRaw;
	if (rendered.text.length > 0) {
		const asBlock = rendered.text.includes("\n");
		if (!insertIntoActiveEditor(rendered.text, rendered.cursorOffset, { asBlock })) {
			notify("Could not insert template into the active editor.", "error");
			return;
		}
	}
	const liveAfterInsert = activeLiveEditor();
	const livePosAfterInsert = liveAfterInsert?.getPosition() ?? null;

	const mergedKeys: string[] = [];
	const docAfterInsert = activeDocIfCurrent(startRoot, canonPath);
	if (hadExistingFmNow && tplHasFm && docAfterInsert) {
		const tplFm = frontMatter(renderedRaw.text);
		const beforeMerge = docAfterInsert.model.getValue();
		const currentFm = frontMatter(beforeMerge);
		if (currentFm.lines > 0) {
			const missingEntries = Object.entries(tplFm.values).filter(
				([k, v]) => k !== "title" && !(k in currentFm.values) && (Array.isArray(v) ? v.length > 0 : Boolean(v)),
			);
			if (missingEntries.length) {
				let updated = beforeMerge;
				for (const [k, v] of missingEntries) {
					if (Array.isArray(v)) {
						for (const item of v) updated = addToFrontMatterList(updated, k, item) ?? updated;
					} else {
						updated = withFrontMatter(updated, k, v) ?? updated;
					}
					mergedKeys.push(k);
				}
				if (updated !== beforeMerge && applyText(canonPath, updated)) {
					// CM6 external sync keeps raw character offsets; shift Live cursor down by the inserted frontmatter lines.
					const addedLines = frontMatter(updated).lines - currentFm.lines;
					if (
						liveAfterInsert &&
						liveAfterInsert === activeLiveEditor() &&
						livePosAfterInsert &&
						addedLines !== 0 &&
						livePosAfterInsert.lineNumber > currentFm.lines
					) {
						liveAfterInsert.reveal({ line: livePosAfterInsert.lineNumber + addedLines, column: livePosAfterInsert.column });
					}
				}
			}
		}
	}

	if (mergedKeys.length) {
		notify(`Inserted template and merged YAML properties: ${mergedKeys.join(", ")}.`);
	}
}

/** Creates a brand-new Markdown document from a chosen Templater template and opens it in Live mode. */
export async function newNoteFromTemplate(explicit?: MarkdownTemplate): Promise<void> {
	const root = state.workspace?.root;
	if (!root) {
		notify("Open a folder first.");
		return;
	}
	const tpl = explicit ?? (await pickTemplate("New note from template"));
	if (!tpl || state.workspace?.root !== root) return;

	const title = (await ask(`Title for new ${tpl.name}`))?.trim();
	if (!title || state.workspace?.root !== root) return;

	const docsRel = (state.project?.docs ?? "docs").replace(/^[./\\]+|[\\/]+$/g, "");
	const schemaRel = (state.project?.schema ?? "schema").replace(/^[./\\]+|[\\/]+$/g, "");
	const plansRel = (state.project?.plans ?? "design").replace(/^[./\\]+|[\\/]+$/g, "");
	const defaultFolder = tpl.folder
		? tpl.folder
				.replace(/^docs(?=\/|$)/, docsRel)
				.replace(/^schema(?=\/|$)/, schemaRel)
				.replace(/^design(?=\/|$)/, plansRel)
				.replace(/^\/+|\/+$/g, "")
		: docsRel;
	// Share variable map between `fileName` and `content` so prompts aren't repeated.
	const sharedVars = new Map<string, string>();
	let stemName = slug(title) || "untitled";
	if (tpl.fileName) {
		const renderedName = await renderTemplate(tpl.fileName, buildContext(joinPath(root, docsRel, `${stemName}.md`), title), sharedVars);
		if (renderedName.cancelled || state.workspace?.root !== root) return;
		const cleanStem = renderedName.text.trim().replace(/\.(md|markdown)$/i, "").replace(/[\\/:*?"<>|]+/g, "-").replace(/^-+|-+$/g, "");
		if (cleanStem) stemName = cleanStem;
	}
	const defaultFile = `${defaultFolder ? `${defaultFolder}/` : ""}${stemName}.md`;
	const targetRel = (await ask("Where to save the new note (path in workspace)", defaultFile))?.trim();
	if (!targetRel || state.workspace?.root !== root) return;

	const cleanRel = targetRel.replace(/\\/g, "/").replace(/^\/+/, "");
	const withExt = /\.(md|markdown)$/i.test(cleanRel) ? cleanRel : `${cleanRel}.md`;
	const dest = joinPath(root, ...withExt.split("/").filter(Boolean));
	if (!isInside(root, dest)) {
		notify("The file path must stay inside the workspace.", "error");
		return;
	}

	// Check target existence BEFORE running interactive content prompts so user effort is never wasted. Asked
	// whether the file is there, not read: a file the read refuses (a text too large to open) was taken for no
	// file, the template's questions were asked, and only then did making the file fail with "already exists".
	const alreadyExists = await fileExists(dest);
	if (state.workspace?.root !== root) return;
	if (alreadyExists) {
		notify(`${withExt} already exists — opened it instead.`);
		await openFile(dest);
		return;
	}

	const rendered = await renderTemplate(tpl.content, buildContext(dest, title), sharedVars);
	if (rendered.cancelled || state.workspace?.root !== root) return;

	try {
		await createWithText(backend, dest, rendered.text);
		if (state.workspace?.root !== root) return;
		setState((s) => { s.treeVersion += 1; });
		ensureEditableMarkdown(canonical(dest));
		const reveal = (() => {
			if (rendered.cursorOffset === null) return undefined;
			const before = rendered.text.slice(0, rendered.cursorOffset).split("\n");
			return { line: before.length, column: before[before.length - 1]!.length + 1 };
		})();
		await openFile(dest, reveal ? { reveal } : {});
	} catch (e: any) {
		notify(`Could not create note from template: ${e?.message ?? e}`, "error");
	}
}

/**
 * Lets the user create a new blank custom template OR copy a built-in template into
 * `<docs>/templates/` to customize it for the project.
 */
export async function manageTemplates(copyBuiltin?: MarkdownTemplate): Promise<void> {
	const dir = templatesFolderPath();
	const root = state.workspace?.root;
	if (!dir || !root) {
		notify("Open a folder first.");
		return;
	}
	const startRoot = root;

	if (copyBuiltin) {
		const fileName = `${copyBuiltin.id}.md`;
		const dest = joinPath(dir, fileName);
		const exists = await fileExists(dest);
		if (state.workspace?.root !== startRoot) return;
		if (!exists) {
			const attrs = [
				formatTemplateHeaderAttr("name", copyBuiltin.name),
				formatTemplateHeaderAttr("description", copyBuiltin.description),
				formatTemplateHeaderAttr("group", copyBuiltin.group),
				...(copyBuiltin.folder ? [formatTemplateHeaderAttr("folder", copyBuiltin.folder)] : []),
				...(copyBuiltin.fileName ? [formatTemplateHeaderAttr("fileName", copyBuiltin.fileName)] : []),
			];
			const header = `<!-- template: ${attrs.join(" ")} -->\n`;
			try {
				await createWithText(backend, dest, header + copyBuiltin.content);
				if (state.workspace?.root !== startRoot) return;
				setState((s) => { s.treeVersion += 1; });
				notify(`Saved customizable copy to ${relativeTo(startRoot, dest)}.`);
			} catch (e: any) {
				notify(`Could not save custom template: ${e?.message ?? e}`, "error");
				return;
			}
		}
		if (state.workspace?.root !== startRoot) return;
		ensureEditableMarkdown(canonical(dest));
		await openFile(dest);
		return;
	}

	type ManageAction =
		| { kind: "blank" }
		| { kind: "customize" }
		| { kind: "custom"; tpl: MarkdownTemplate };
	const customTemplates = (await loadMarkdownTemplates()).filter((t) => t.source === "workspace" && t.path);
	if (state.workspace?.root !== startRoot) return;
	const items: QuickPickOption<ManageAction>[] = [
		{
			value: { kind: "blank" },
			label: "Create blank custom template…",
			icon: "new-file",
			description: "Start a new .md template with <% tp.date.now() %> and <% tp.file.cursor() %> tags",
		},
		{
			value: { kind: "customize" },
			label: "Customize a built-in template…",
			icon: "notebook-template",
			description: "Copy a built-in default (Ticket, Spec, Plan Doc, Database Table…) into your project to edit",
		},
		...customTemplates.map((tpl, i): QuickPickOption<ManageAction> => ({
			value: { kind: "custom", tpl },
			label: `Edit / delete: ${tpl.name}`,
			icon: "edit",
			badge: { text: "Custom", tone: "active" },
			detail: tpl.path ? relativeTo(startRoot, tpl.path) : undefined,
			description: tpl.description,
			divide: i === 0,
		})),
	];
	const action = await quickPick<ManageAction>({
		title: `Project templates (${relativeTo(startRoot, dir)}/)`,
		placeholder: "Choose a template action or search custom templates…",
		items,
	});
	if (!action || state.workspace?.root !== startRoot) return;

	if (action.kind === "custom" && action.tpl.path) {
		const chosenCustom = action.tpl;
		const customPath = action.tpl.path;
		const sub = await quickPick<"edit" | "delete">({
			title: chosenCustom.name,
			searchable: false,
			items: [
				{
					value: "edit",
					label: "Edit template",
					icon: "edit",
					description: `Open ${relativeTo(startRoot, customPath)} in Live Preview`,
				},
				{
					value: "delete",
					label: "Move template to trash",
					icon: "trash",
					danger: true,
					description: "Move this custom template file to trash",
				},
			],
		});
		if (!sub || state.workspace?.root !== startRoot) return;
		if (sub === "edit") {
			ensureEditableMarkdown(canonical(customPath));
			await openFile(customPath);
		} else if (sub === "delete") {
			if ((await choose(`Move template ${relativeTo(startRoot, customPath)} to trash?`, ["Move to trash"], { danger: "Move to trash" })) === "Move to trash") {
				if (state.workspace?.root !== startRoot) return;
				try {
					await backend.trash(customPath);
					if (state.workspace?.root !== startRoot) return;
					fileRemoved(customPath);
					setState((s) => { s.treeVersion += 1; });
					notify(`Moved ${chosenCustom.name} to trash.`);
				} catch (e: any) {
					notify(`Could not move template to trash: ${e?.message ?? e}`, "error");
				}
			}
		}
		return;
	}

	if (action.kind === "customize") {
		const found = await quickPick<MarkdownTemplate>({
			title: "Choose a built-in template to customize",
			placeholder: "Search built-in templates…",
			items: DEFAULT_TEMPLATES.map((t) => ({
				value: t,
				label: t.name,
				icon: "notebook-template",
				detail: t.group,
				description: t.description,
			})),
		});
		if (found && state.workspace?.root === startRoot) await manageTemplates(found);
		return;
	}

	const name = (await ask("Name of the new custom template (e.g. Incident Report)"))?.trim();
	if (!name || state.workspace?.root !== startRoot) return;
	const id = slug(name).toLowerCase() || "custom-template";
	const dest = joinPath(dir, `${id}.md`);
	const exists = await fileExists(dest);
	if (state.workspace?.root !== startRoot) return;
	if (!exists) {
		const header = `<!-- template: ${formatTemplateHeaderAttr("name", name)} ${formatTemplateHeaderAttr("description", "Custom project template")} ${formatTemplateHeaderAttr("group", "Custom")} ${formatTemplateHeaderAttr("folder", "docs")} -->`;
		const starter = `${header}
---
title: <% tp.file.yamlTitle %>
date: <% tp.date.now("YYYY-MM-DD") %>
ticket: <% tp.yaml(tp.project.ticket) %>
status: draft
---

# <% tp.file.title %>

> [!important] Summary
> <% tp.file.cursor() %>

## Details

- 
`;
		try {
			await createWithText(backend, dest, starter);
			if (state.workspace?.root !== startRoot) return;
			setState((s) => { s.treeVersion += 1; });
		} catch (e: any) {
			notify(`Could not create custom template: ${e?.message ?? e}`, "error");
			return;
		}
	}
	if (state.workspace?.root !== startRoot) return;
	ensureEditableMarkdown(canonical(dest));
	await openFile(dest);
}

/**
 * Inserts a callout card right at the cursor (wrapping any selection).
 * - When `presetType` is provided (e.g. from Markdown Palette), inserts immediately with zero modals
 *   and focuses the inline callout body editor where title, type, and fold state are 1-click editable.
 * - Otherwise prompts once to choose the callout type, then inserts and focuses immediately.
 */
export async function insertCalloutInteractive(presetType?: string): Promise<void> {
	const path = activePath();
	if (!path || !isMarkdown(path)) {
		notify("Open a Markdown document to insert a callout.");
		return;
	}
	const startRoot = state.workspace?.root;
	const canonPath = canonical(path);
	if (!activeDocIfCurrent(startRoot, canonPath)) return;

	if (!activeLiveEditor() && !activeEditor()?.getDomNode()?.offsetParent) {
		ensureEditableMarkdown(path);
		for (let i = 0; i < 12 && !activeLiveEditor() && !activeEditor()?.getDomNode()?.offsetParent; i++) {
			await new Promise((r) => requestAnimationFrame(r));
			if (!activeDocIfCurrent(startRoot, canonPath)) return;
		}
	}
	if (!activeDocIfCurrent(startRoot, canonPath)) return;

	let type = presetType;
	if (!type) {
		const picked = await quickPick<string>({
			title: "Insert callout",
			placeholder: "Filter callout types…",
			items: CALLOUT_PRESETS.map((p) => ({
				value: p.type,
				label: p.label,
				icon: "quote",
				detail: `[!${p.type}]`,
				description: p.about,
			})),
		});
		if (!picked || !activeDocIfCurrent(startRoot, canonPath)) return;
		type = picked;
	}

	const selected = activeSelectionText();
	const { insert, cursorOffset } = buildCalloutBlock(type, "", selected);
	insertIntoActiveEditor(insert, cursorOffset, { asBlock: !selected });
}

/** Interactive Insert Image dialog: picks an existing workspace image, opens the workspace file browser, or accepts a remote URL. */
export async function insertImageInteractive(): Promise<void> {
	const path = activePath();
	if (!path || !isMarkdown(path)) {
		notify("Open a Markdown document to insert an image.");
		return;
	}
	const startRoot = state.workspace?.root;
	const canonPath = canonical(path);
	if (!activeDocIfCurrent(startRoot, canonPath)) return;

	if (!activeLiveEditor() && !activeEditor()?.getDomNode()?.offsetParent) {
		ensureEditableMarkdown(path);
		for (let i = 0; i < 12 && !activeLiveEditor() && !activeEditor()?.getDomNode()?.offsetParent; i++) {
			await new Promise((r) => requestAnimationFrame(r));
			if (!activeDocIfCurrent(startRoot, canonPath)) return;
		}
	}
	if (!activeDocIfCurrent(startRoot, canonPath)) return;

	const root = startRoot;
	const images = await listWorkspaceImages();
	if (!activeDocIfCurrent(startRoot, canonPath)) return;
	let targetSrc = "";
	let defaultAlt = "";

	const formatLocalTarget = (abs: string) => {
		const rel = relativePath(dirName(path), abs);
		targetSrc = rel
			.split("/")
			.map((s) => encodeURIComponent(s))
			.join("/");
		defaultAlt = baseName(abs).replace(/\.[^.]+$/, "").replace(/[-_]+/g, " ");
	};

	type ImageChoice = { kind: "image"; path: string } | { kind: "browse" } | { kind: "url" };
	const items: QuickPickOption<ImageChoice>[] = images.map((imgPath) => {
		const rel = root ? relativeTo(root, imgPath).replace(/\\/g, "/") : baseName(imgPath);
		return {
			value: { kind: "image", path: imgPath },
			label: baseName(imgPath),
			file: baseName(imgPath),
			detail: rel,
			description: `Insert relative link to ${baseName(imgPath)}`,
			keywords: rel,
		};
	});
	if (root) {
		items.push({
			value: { kind: "browse" },
			label: "Browse workspace files…",
			icon: "folder",
			description: "Pick any image or attachment from the workspace file browser",
			divide: images.length > 0,
		});
	}
	items.push({
		value: { kind: "url" },
		label: "Enter remote image URL…",
		icon: "file-media",
		description: "Paste an https:// image URL (tip: you can also paste screenshots with Ctrl+V)",
		divide: !root && images.length > 0,
	});

	const picked = await quickPick<ImageChoice>({
		title: "Insert image (tip: you can also paste or drop images directly)",
		placeholder: images.length ? "Search workspace images or browse files…" : "Browse workspace files or enter a URL…",
		items,
	});
	if (!picked || !activeDocIfCurrent(startRoot, canonPath)) return;

	if (picked.kind === "image") {
		formatLocalTarget(picked.path);
	} else if (picked.kind === "browse" && root) {
		const chosen = await browseWorkspaceFile({
			title: "Choose image from workspace",
			root,
			initialDir: dirName(path),
			pinned: images.slice(0, 8).map((p) => ({
				path: p,
				rel: relativeTo(root, p).replace(/\\/g, "/"),
			})),
			pinnedLabel: "Image",
		});
		if (!chosen || !activeDocIfCurrent(startRoot, canonPath)) return;
		formatLocalTarget(chosen.path);
	} else {
		const typed = (await ask("Image URL (https://…)", "https://"))?.trim();
		if (!typed || !activeDocIfCurrent(startRoot, canonPath)) return;
		targetSrc = typed;
	}

	const alt = await ask("Optional caption / alt text (add |400 to set width, e.g. Architecture|400)", defaultAlt);
	if (alt === null || !activeDocIfCurrent(startRoot, canonPath)) return;
	const snippet = `![${alt.trim()}](${targetSrc})`;
	insertIntoActiveEditor(snippet, snippet.length);
}
