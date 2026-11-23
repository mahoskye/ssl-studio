// Obsidian Templater-style workflow for SSL Studio:
// - Discovers customizable templates from `<docs>/templates/*.md` (or `settings.templatesFolder`)
// - Merges workspace templates with built-in defaults (workspace files override matching defaults)
// - Runs dynamic `<% tp.* %>` expressions using SSL Studio's native `ask()` and `choose()` dialogs
// - Provides Insert Template, New Note from Template, Customize Template, Insert Callout, and Insert Image actions.
import { frontMatter } from "../shared/frontMatter";
import { buildCalloutBlock, CALLOUT_PRESETS } from "../shared/markdownEdit";
import { baseName, dirName, isInside, joinPath, relativePath, relativeTo } from "../shared/paths";
import { slug } from "../shared/projectDocs";
import {
	DEFAULT_TEMPLATES,
	mergeTemplates,
	parseTemplateFile,
	renderTemplate,
	stripRawTemplateFrontmatter,
	stripTemplateFrontmatter,
	type MarkdownTemplate,
	type TemplaterContext,
} from "../shared/templater";
import { backend } from "./backend";
import { ask, choose } from "./dialogs";
import { activeEditor } from "./editor/EditorGroup";
import { listWorkspaceImages } from "./editor/imageResolve";
import { activeLiveEditor } from "./editor/liveBridge";
import { isMarkdown } from "./project";
import { ticketAtHand } from "./projectDocs";
import { activePath, canonical, documents, fileRemoved, notify, openFile, setMarkdownMode, setState, state } from "./state";

/** Absolute path to the workspace templates folder (`<docs>/templates` by default, or `settings.templatesFolder`). */
export function templatesFolderPath(): string | null {
	const root = state.workspace?.root;
	if (!root) return null;
	const custom = state.settings.templatesFolder?.trim();
	if (custom) return joinPath(root, ...custom.split(/[\\/]/).filter((p) => p && p !== "."));
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
	return model && sel && !sel.isEmpty() ? model.getValueInRange(sel) : "";
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
		selection: activeSelectionText(),
		prompt: (label, def) => ask(label, def ?? ""),
		suggest: async (labels, values, placeholder) => {
			const picked = await choose(placeholder || "Choose an option", labels);
			if (!picked) return null;
			const idx = labels.indexOf(picked);
			return idx >= 0 ? (values[idx] ?? picked) : picked;
		},
		clipboard: async () => (await navigator.clipboard?.readText().catch(() => "")) ?? "",
	};
}

/** Lets the user choose a template (workspace custom templates listed first, then built-in defaults). */
async function pickTemplate(title: string): Promise<MarkdownTemplate | null> {
	const all = await loadMarkdownTemplates();
	const labels: string[] = [];
	const details: Record<string, string> = {};
	const byLabel = new Map<string, MarkdownTemplate>();

	for (const tpl of all) {
		const baseLabel = tpl.source === "workspace" ? `${tpl.name} (Custom)` : tpl.name;
		let label = baseLabel;
		if (byLabel.has(label)) {
			label = `${baseLabel} · ${tpl.id}`;
		}
		labels.push(label);
		details[label] = tpl.description;
		byLabel.set(label, tpl);
	}
	const picked = await choose(title, labels, { details });
	return picked ? (byLabel.get(picked) ?? null) : null;
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
	if (!editor || !model) return false;
	const sel = editor.getSelection() ?? {
		startLineNumber: 1,
		startColumn: 1,
		endLineNumber: 1,
		endColumn: 1,
	};
	const isEmpty = sel.startLineNumber === sel.endLineNumber && sel.startColumn === sel.endColumn;
	let insertText = text;
	let offsetDelta = 0;
	let range = sel;
	if (opts?.asBlock && isEmpty) {
		const lineContent = model.getLineContent(sel.startLineNumber);
		if (lineContent.trim()) {
			const endCol = lineContent.length + 1;
			range = { startLineNumber: sel.startLineNumber, startColumn: endCol, endLineNumber: sel.startLineNumber, endColumn: endCol };
			insertText = `\n\n${text}`;
			offsetDelta = 2;
		}
	}
	const startOffset = model.getOffsetAt({ lineNumber: range.startLineNumber, column: range.startColumn });
	editor.pushUndoStop();
	editor.executeEdits("templater", [{ range, text: insertText, forceMoveMarkers: true }]);
	editor.pushUndoStop();
	if (cursorOffset !== null) {
		const targetPos = model.getPositionAt(startOffset + offsetDelta + cursorOffset);
		editor.setPosition(targetPos);
		editor.revealPositionInCenterIfOutsideViewport(targetPos);
	}
	editor.focus();
	return true;
}

/** Inserts a chosen Templater template at the cursor of the active Markdown editor. */
export async function insertMarkdownTemplate(explicit?: MarkdownTemplate): Promise<void> {
	const path = activePath();
	if (!path || !isMarkdown(path)) {
		notify("Open a Markdown document to insert a template.");
		return;
	}
	// Pick template BEFORE switching Read -> Live so cancelling leaves view mode untouched.
	const tpl = explicit ?? (await pickTemplate("Insert template at cursor"));
	if (!tpl) return;
	const existing = documents.get(canonical(path))?.model.getValue() ?? "";
	const shouldStripFm = frontMatter(existing).lines > 0 || existing.trim().length > 0;
	const sourceContent = shouldStripFm ? stripRawTemplateFrontmatter(tpl.content) : tpl.content;
	const renderedRaw = await renderTemplate(sourceContent, buildContext(path));
	if (renderedRaw.cancelled) return;
	if (!activeLiveEditor() && !activeEditor()?.getDomNode()?.offsetParent) {
		setMarkdownMode(path, "live");
		await new Promise((r) => setTimeout(r, 40));
	}
	const rendered = shouldStripFm ? stripTemplateFrontmatter(renderedRaw) : renderedRaw;
	const asBlock = rendered.text.includes("\n");
	if (!insertIntoActiveEditor(rendered.text, rendered.cursorOffset, { asBlock })) {
		notify("Could not insert template into the active editor.", "error");
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
	if (!tpl) return;

	const title = (await ask(`Title for new ${tpl.name}`))?.trim();
	if (!title) return;

	const docsRel = state.project?.docs ?? "docs";
	const defaultFolder = tpl.folder
		? tpl.folder.replace(/^docs(?=\/|$)/, docsRel)
		: docsRel;
	// Share variable map between `fileName` and `content` so prompts aren't repeated.
	const sharedVars = new Map<string, string>();
	let stemName = slug(title) || "untitled";
	if (tpl.fileName) {
		const renderedName = await renderTemplate(tpl.fileName, buildContext(joinPath(root, docsRel, `${stemName}.md`), title), sharedVars);
		if (renderedName.cancelled) return;
		const cleanStem = renderedName.text.trim().replace(/\.(md|markdown)$/i, "").replace(/[\\/:*?"<>|]+/g, "-").replace(/^-+|-+$/g, "");
		if (cleanStem) stemName = cleanStem;
	}
	const defaultFile = `${defaultFolder ? `${defaultFolder}/` : ""}${stemName}.md`;
	const targetRel = (await ask("Where to save the new note (path in workspace)", defaultFile))?.trim();
	if (!targetRel) return;

	const cleanRel = targetRel.replace(/\\/g, "/").replace(/^\/+/, "");
	const withExt = /\.(md|markdown)$/i.test(cleanRel) ? cleanRel : `${cleanRel}.md`;
	const dest = joinPath(root, ...withExt.split("/").filter(Boolean));
	if (!isInside(root, dest)) {
		notify("The file path must stay inside the workspace.", "error");
		return;
	}

	// Check target existence BEFORE running interactive content prompts so user effort is never wasted.
	const alreadyExists = await backend
		.read(dest)
		.then(() => true)
		.catch(() => false);
	if (alreadyExists) {
		notify(`${withExt} already exists — opened it instead.`);
		await openFile(dest);
		return;
	}

	const rendered = await renderTemplate(tpl.content, buildContext(dest, title), sharedVars);
	if (rendered.cancelled) return;

	try {
		await backend.create(dest, "file");
		await backend.write(dest, rendered.text);
		setState("treeVersion", (v) => v + 1);
		setMarkdownMode(canonical(dest), "live");
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

	if (copyBuiltin) {
		const fileName = `${copyBuiltin.id}.md`;
		const dest = joinPath(dir, fileName);
		const exists = await backend.read(dest).then(() => true, () => false);
		if (!exists) {
			const header = `<!-- template: name="${copyBuiltin.name}" description="${copyBuiltin.description}" group="${copyBuiltin.group}"${copyBuiltin.folder ? ` folder="${copyBuiltin.folder}"` : ""}${copyBuiltin.fileName ? ` fileName="${copyBuiltin.fileName}"` : ""} -->\n`;
			await backend.create(dest, "file");
			await backend.write(dest, header + copyBuiltin.content);
			setState("treeVersion", (v) => v + 1);
			notify(`Saved customizable copy to ${relativeTo(root, dest)}.`);
		}
		setMarkdownMode(canonical(dest), "live");
		await openFile(dest);
		return;
	}

	const CREATE_BLANK = "Create blank custom template…";
	const CUSTOMIZE = "Customize a built-in template…";
	const customTemplates = (await loadMarkdownTemplates()).filter((t) => t.source === "workspace" && t.path);
	const customLabels = new Map<string, MarkdownTemplate>();
	const options: string[] = [CREATE_BLANK, CUSTOMIZE];
	const details: Record<string, string> = {
		[CREATE_BLANK]: "Start a new .md template with <% tp.date.now() %> and <% tp.file.cursor() %> tags",
		[CUSTOMIZE]: "Copy a built-in default (Ticket, Change Spec, Meeting Notes…) into your project to edit",
	};
	for (const tpl of customTemplates) {
		const label = `Edit / delete: ${tpl.name}`;
		options.push(label);
		details[label] = tpl.path ? relativeTo(root, tpl.path) : tpl.description;
		customLabels.set(label, tpl);
	}
	const action = await choose(`Project templates live in ${relativeTo(root, dir)}/`, options, { details });
	if (!action) return;

	const chosenCustom = customLabels.get(action);
	if (chosenCustom?.path) {
		const EDIT = "Edit template";
		const DELETE = "Move template to trash";
		const sub = await choose(chosenCustom.name, [EDIT, DELETE], {
			details: {
				[EDIT]: `Open ${relativeTo(root, chosenCustom.path)} in Live Preview`,
				[DELETE]: "Move this custom template file to trash",
			},
		});
		if (sub === EDIT) {
			setMarkdownMode(canonical(chosenCustom.path), "live");
			await openFile(chosenCustom.path);
		} else if (sub === DELETE) {
			if ((await choose(`Move template ${relativeTo(root, chosenCustom.path)} to trash?`, ["Move to trash", "Cancel"], { danger: "Move to trash" })) === "Move to trash") {
				try {
					await backend.trash(chosenCustom.path);
					fileRemoved(chosenCustom.path);
					setState("treeVersion", (v) => v + 1);
					notify(`Moved ${chosenCustom.name} to trash.`);
				} catch (e: any) {
					notify(`Could not move template to trash: ${e?.message ?? e}`, "error");
				}
			}
		}
		return;
	}

	if (action === CUSTOMIZE) {
		const names = DEFAULT_TEMPLATES.map((t) => t.name);
		const details = Object.fromEntries(DEFAULT_TEMPLATES.map((t) => [t.name, t.description]));
		const picked = await choose("Choose a built-in template to customize", names, { details });
		const found = DEFAULT_TEMPLATES.find((t) => t.name === picked);
		if (found) await manageTemplates(found);
		return;
	}

	const name = (await ask("Name of the new custom template (e.g. Incident Report)"))?.trim();
	if (!name) return;
	const id = slug(name).toLowerCase() || "custom-template";
	const dest = joinPath(dir, `${id}.md`);
	const exists = await backend.read(dest).then(() => true, () => false);
	if (!exists) {
		const starter = `<!-- template: name="${name}" description="Custom project template" group="Custom" folder="docs" -->
---
title: <% tp.file.title %>
date: <% tp.date.now("YYYY-MM-DD") %>
ticket: <% tp.project.ticket %>
status: draft
---

# <% tp.file.title %>

> [!important] Summary
> <% tp.file.cursor() %>

## Details

- 
`;
		await backend.create(dest, "file");
		await backend.write(dest, starter);
		setState("treeVersion", (v) => v + 1);
	}
	setMarkdownMode(canonical(dest), "live");
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
	if (!activeLiveEditor() && !activeEditor()?.getDomNode()?.offsetParent) {
		setMarkdownMode(path, "live");
		await new Promise((r) => setTimeout(r, 40));
	}

	let type = presetType;
	if (!type) {
		const labels = CALLOUT_PRESETS.map((p) => p.label);
		const details = Object.fromEntries(CALLOUT_PRESETS.map((p) => [p.label, p.about]));
		const picked = await choose("Insert callout", labels, { details });
		if (!picked) return;
		type = CALLOUT_PRESETS.find((p) => p.label === picked)?.type ?? "important";
	}

	const selected = activeLiveEditor()?.getSelectedText() ?? "";
	const { insert, cursorOffset } = buildCalloutBlock(type, "", selected);
	insertIntoActiveEditor(insert, cursorOffset, { asBlock: !selected });
}

/** Interactive Insert Image dialog: picks an existing workspace image or lets the user enter a path / URL. */
export async function insertImageInteractive(): Promise<void> {
	const path = activePath();
	if (!path || !isMarkdown(path)) {
		notify("Open a Markdown document to insert an image.");
		return;
	}
	if (!activeLiveEditor() && !activeEditor()?.getDomNode()?.offsetParent) {
		setMarkdownMode(path, "live");
		await new Promise((r) => setTimeout(r, 40));
	}

	const root = state.workspace?.root;
	const images = await listWorkspaceImages();
	let targetSrc = "";
	let defaultAlt = "";

	if (images.length) {
		const OTHER = "Enter URL or image path…";
		const byLabel = new Map<string, string>();
		const labels: string[] = [];
		const details: Record<string, string> = {};
		for (const imgPath of images.slice(0, 20)) {
			const rel = root ? relativeTo(root, imgPath) : baseName(imgPath);
			labels.push(rel);
			details[rel] = `Insert relative link to ${baseName(imgPath)}`;
			byLabel.set(rel, imgPath);
		}
		labels.push(OTHER);
		details[OTHER] = "Paste an https:// image URL or relative file path";

		const picked = await choose("Insert image (tip: you can also paste or drop images directly)", labels, { details });
		if (!picked) return;
		if (picked === OTHER) {
			const typed = (await ask("Image URL or path relative to this document", "https://"))?.trim();
			if (!typed) return;
			targetSrc = typed;
		} else {
			const abs = byLabel.get(picked)!;
			const rel = relativePath(dirName(path), abs);
			targetSrc = rel
				.split("/")
				.map((s) => encodeURIComponent(s))
				.join("/");
			defaultAlt = baseName(abs).replace(/\.[^.]+$/, "").replace(/[-_]+/g, " ");
		}
	} else {
		const typed = (await ask("Image URL or path (tip: you can also paste screenshots with Ctrl+V or drag-drop files)", ""))?.trim();
		if (!typed) return;
		targetSrc = typed;
	}

	const alt = (await ask("Optional caption / alt text (add |400 to set width, e.g. Architecture|400)", defaultAlt)) ?? "";
	const snippet = `![${alt.trim()}](${targetSrc})`;
	insertIntoActiveEditor(snippet, snippet.length);
}
