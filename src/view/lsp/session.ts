// One language-server session for the open workspace: documents, diagnostics
// and every Monaco provider the server's capabilities allow.
import { createStore, reconcile } from "solid-js/store";
import { monaco } from "../editor/monaco";
import { backend, on } from "../backend";
import { LspClient } from "./client";
import { trimEdit } from "./edits";

export type Diagnostic = {
	uri: string;
	line: number;
	column: number;
	endLine: number;
	endColumn: number;
	severity: 1 | 2 | 3 | 4;
	message: string;
	code?: string;
	source?: string;
};

const [diagnostics, setDiagnostics] = createStore<Record<string, Diagnostic[]>>({});
export { diagnostics };

type Range = { start: { line: number; character: number }; end: { line: number; character: number } };
const toRange = (r: Range) => new monaco.Range(r.start.line + 1, r.start.character + 1, r.end.line + 1, r.end.character + 1);
const toPosition = (p: monaco.IPosition) => ({ line: p.lineNumber - 1, character: p.column - 1 });
const toLspRange = (r: monaco.IRange): Range => ({
	start: { line: r.startLineNumber - 1, character: r.startColumn - 1 },
	end: { line: r.endLineNumber - 1, character: r.endColumn - 1 },
});
const markerSeverity = [0, monaco.MarkerSeverity.Error, monaco.MarkerSeverity.Warning, monaco.MarkerSeverity.Info, monaco.MarkerSeverity.Hint];
const K = monaco.languages.CompletionItemKind;
// LSP CompletionItemKind (1-based) to Monaco's.
const completionKinds = [K.Text, K.Text, K.Method, K.Function, K.Constructor, K.Field, K.Variable, K.Class, K.Interface, K.Module, K.Property, K.Unit, K.Value, K.Enum, K.Keyword, K.Snippet, K.Color, K.File, K.Reference, K.Folder, K.EnumMember, K.Constant, K.Struct, K.Event, K.Operator, K.TypeParameter];
const markdown = (value: any) => (value == null ? undefined : typeof value === "string" ? { value } : { value: value.value });

export type ServerInfo = { name: string; version: string };

class Session {
	readonly client = new LspClient();
	private initialized: Promise<void> | null = null;
	private root = "";
	private versions = new Map<string, number>();
	server: ServerInfo | null = null;
	/** Loads a model for a URI the server pointed at (definition, references). */
	ensureModel: (uri: string) => Promise<monaco.editor.ITextModel | null> = async () => null;

	constructor() {
		this.client.on("textDocument/publishDiagnostics", (params) => this.publish(params));
		this.client.onRequest("workspace/configuration", (params) => (params?.items ?? []).map(() => null));
		this.client.onRequest("client/registerCapability", () => null);
		this.client.onRequest("window/workDoneProgress/create", () => null);
		on("lspState", (state) => {
			if (state.state === "restarting" || state.state === "stopped") {
				this.client.rejectAll(state.state);
				this.initialized = null;
			}
			if (state.state === "running" && this.root) void this.start(this.root);
		});
	}

	start(root: string) {
		this.root = root;
		this.initialized = (async () => {
			const result = await this.client.request("initialize", {
				processId: null,
				rootUri: monaco.Uri.file(root).toString(),
				workspaceFolders: [{ uri: monaco.Uri.file(root).toString(), name: root.split("/").pop() }],
				capabilities: {
					textDocument: {
						synchronization: { didSave: true },
						documentSymbol: { hierarchicalDocumentSymbolSupport: true },
						completion: { completionItem: { snippetSupport: true, documentationFormat: ["markdown", "plaintext"] } },
						hover: { contentFormat: ["markdown", "plaintext"] },
						signatureHelp: { signatureInformation: { documentationFormat: ["markdown", "plaintext"] } },
						rename: { prepareSupport: true },
						publishDiagnostics: { relatedInformation: false },
						foldingRange: { lineFoldingOnly: true },
					},
					workspace: { workspaceFolders: true, configuration: true },
				},
			});
			this.server = result?.serverInfo ?? null;
			this.client.notify("initialized", {});
			for (const model of monaco.editor.getModels()) if (this.versions.has(model.uri.toString())) this.open(model);
		})();
		return this.initialized;
	}

	private ready() {
		return this.initialized ?? Promise.reject(new Error("language server not running"));
	}

	private open(model: monaco.editor.ITextModel) {
		const uri = model.uri.toString();
		this.versions.set(uri, 1);
		this.client.notify("textDocument/didOpen", { textDocument: { uri, languageId: "ssl", version: 1, text: model.getValue() } });
	}

	/** Keeps the server's copy of an SSL model in step with the editor. */
	track(model: monaco.editor.ITextModel) {
		if (model.getLanguageId() !== "ssl" || model.uri.scheme !== "file") return;
		const uri = model.uri.toString();
		this.versions.set(uri, 0);
		this.initialized?.then(() => this.open(model));
		const changes = model.onDidChangeContent((event) => {
			if (!this.initialized || !this.versions.get(uri)) return;
			const version = this.versions.get(uri)! + 1;
			this.versions.set(uri, version);
			this.client.notify("textDocument/didChange", {
				textDocument: { uri, version },
				contentChanges: event.changes.map((c) => ({ range: toLspRange(c.range), rangeLength: c.rangeLength, text: c.text })),
			});
		});
		model.onWillDispose(() => {
			changes.dispose();
			this.versions.delete(uri);
			if (this.initialized) this.client.notify("textDocument/didClose", { textDocument: { uri } });
			setDiagnostics(uri, undefined!);
		});
	}

	saved(model: monaco.editor.ITextModel) {
		if (this.versions.get(model.uri.toString())) this.client.notify("textDocument/didSave", { textDocument: { uri: model.uri.toString() } });
	}

	private publish(params: { uri: string; diagnostics: any[] }) {
		const model = monaco.editor.getModel(monaco.Uri.parse(params.uri));
		const list: Diagnostic[] = params.diagnostics.map((d) => ({
			uri: params.uri,
			line: d.range.start.line + 1,
			column: d.range.start.character + 1,
			endLine: d.range.end.line + 1,
			endColumn: d.range.end.character + 1,
			severity: d.severity ?? 1,
			message: d.message,
			code: d.code == null ? undefined : String(typeof d.code === "object" ? d.code.value : d.code),
			source: d.source,
		}));
		setDiagnostics(params.uri, reconcile(list));
		if (model)
			monaco.editor.setModelMarkers(
				model,
				"starlims-lsp",
				list.map((d) => ({
					startLineNumber: d.line,
					startColumn: d.column,
					endLineNumber: d.endLine,
					endColumn: d.endColumn,
					message: d.message,
					code: d.code,
					severity: markerSeverity[d.severity]!,
					source: d.source,
				})),
			);
	}

	async request<T = any>(method: string, params: unknown): Promise<T> {
		await this.ready();
		return this.client.request<T>(method, params);
	}

	async documentSymbols(model: monaco.editor.ITextModel): Promise<monaco.languages.DocumentSymbol[]> {
		const convert = (s: any): monaco.languages.DocumentSymbol => ({
			name: s.name,
			detail: s.detail ?? "",
			kind: s.kind - 1,
			tags: [],
			range: toRange(s.range ?? s.location.range),
			selectionRange: toRange(s.selectionRange ?? s.location.range),
			children: (s.children ?? []).map(convert),
		});
		return ((await this.request("textDocument/documentSymbol", { textDocument: { uri: model.uri.toString() } })) ?? []).map(convert);
	}

	async workspaceSymbols(query: string) {
		return ((await this.request("workspace/symbol", { query })) ?? []) as { name: string; kind: number; containerName?: string; location: { uri: string; range: Range } }[];
	}

	/** Formats the given line ranges (0-based, inclusive) as small edits. */
	async formatRanges(model: monaco.editor.ITextModel, ranges: [number, number][], options: monaco.languages.FormattingOptions) {
		const edits: monaco.editor.IIdentifiedSingleEditOperation[] = [];
		for (const [start, end] of ranges) {
			const range = new monaco.Range(start + 1, 1, end + 1, model.getLineMaxColumn(end + 1));
			const result = await this.request("textDocument/rangeFormatting", {
				textDocument: { uri: model.uri.toString() },
				range: toLspRange(range),
				options: { tabSize: options.tabSize, insertSpaces: options.insertSpaces },
			});
			edits.push(...toMinimalEdits(model, result ?? []));
		}
		return edits;
	}
}

/** The formatter's edits replace whole ranges; shrink each to its changed lines. */
export function toMinimalEdits(model: monaco.editor.ITextModel, edits: { range: Range; newText: string }[]) {
	return edits.flatMap((edit) => {
		const range = toRange(edit.range);
		// Extend to whole lines so line-based trimming is exact.
		const full = new monaco.Range(range.startLineNumber, 1, range.endLineNumber, model.getLineMaxColumn(range.endLineNumber));
		const before = model.getValueInRange(new monaco.Range(range.startLineNumber, 1, range.startLineNumber, range.startColumn));
		const after = model.getValueInRange(new monaco.Range(range.endLineNumber, range.endColumn, range.endLineNumber, model.getLineMaxColumn(range.endLineNumber)));
		const eol = model.getEOL();
		const oldLines = model.getValueInRange(full).split(eol);
		const newLines = (before + edit.newText.replace(/\r?\n/g, eol) + after).split(eol);
		const trimmed = trimEdit(oldLines, newLines);
		if (!trimmed) return [];
		const startLine = full.startLineNumber + trimmed.startLine;
		const endLine = full.startLineNumber + trimmed.endLine;
		if (endLine < startLine) {
			// Pure insertion before line `startLine`.
			return [{ range: new monaco.Range(startLine, 1, startLine, 1), text: trimmed.lines.join(eol) + eol }];
		}
		if (!trimmed.lines.length) {
			// Pure deletion of whole lines.
			const next = endLine + 1 <= model.getLineCount() ? new monaco.Range(startLine, 1, endLine + 1, 1) : new monaco.Range(Math.max(1, startLine - 1), model.getLineMaxColumn(Math.max(1, startLine - 1)), endLine, model.getLineMaxColumn(endLine));
			return [{ range: next, text: "" }];
		}
		return [{ range: new monaco.Range(startLine, 1, endLine, model.getLineMaxColumn(endLine)), text: trimmed.lines.join(eol) }];
	});
}

export const session = new Session();

const doc = (model: monaco.editor.ITextModel) => ({ textDocument: { uri: model.uri.toString() } });
const quiet = <T>(work: Promise<T>, fallback: T) => work.catch(() => fallback);

async function locations(result: any): Promise<monaco.languages.Location[]> {
	const list = Array.isArray(result) ? result : result ? [result] : [];
	const out: monaco.languages.Location[] = [];
	for (const l of list) {
		const uri = l.uri ?? l.targetUri;
		const range = l.range ?? l.targetSelectionRange ?? l.targetRange;
		await session.ensureModel(uri);
		out.push({ uri: monaco.Uri.parse(uri), range: toRange(range) });
	}
	return out;
}

export function registerProviders() {
	monaco.languages.registerCompletionItemProvider("ssl", {
		triggerCharacters: [":"],
		async provideCompletionItems(model, position) {
			const result = await quiet(session.request("textDocument/completion", { ...doc(model), position: toPosition(position) }), null);
			const items = (result?.items ?? result ?? []) as any[];
			const word = model.getWordUntilPosition(position);
			const range = new monaco.Range(position.lineNumber, word.startColumn, position.lineNumber, word.endColumn);
			return {
				incomplete: Boolean(result?.isIncomplete),
				suggestions: items.map((item) => ({
					label: item.label,
					kind: completionKinds[item.kind ?? 1] ?? K.Text,
					detail: item.detail,
					documentation: markdown(item.documentation),
					insertText: item.textEdit?.newText ?? item.insertText ?? item.label,
					insertTextRules: item.insertTextFormat === 2 ? monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet : undefined,
					range: item.textEdit?.range ? toRange(item.textEdit.range) : range,
					sortText: item.sortText,
					filterText: item.filterText,
				})),
			};
		},
	});
	monaco.languages.registerHoverProvider("ssl", {
		async provideHover(model, position) {
			const hover = await quiet(session.request("textDocument/hover", { ...doc(model), position: toPosition(position) }), null);
			if (!hover?.contents) return null;
			const contents = (Array.isArray(hover.contents) ? hover.contents : [hover.contents]).map(markdown).filter(Boolean);
			return { contents, range: hover.range && toRange(hover.range) };
		},
	});
	monaco.languages.registerSignatureHelpProvider("ssl", {
		signatureHelpTriggerCharacters: ["(", ","],
		signatureHelpRetriggerCharacters: [","],
		async provideSignatureHelp(model, position) {
			const help = await quiet(session.request("textDocument/signatureHelp", { ...doc(model), position: toPosition(position) }), null);
			if (!help?.signatures?.length) return null;
			return {
				value: {
					activeSignature: help.activeSignature ?? 0,
					activeParameter: help.activeParameter ?? 0,
					signatures: help.signatures.map((s: any) => ({
						label: s.label,
						documentation: markdown(s.documentation),
						parameters: (s.parameters ?? []).map((p: any) => ({ label: p.label, documentation: markdown(p.documentation) })),
						activeParameter: s.activeParameter,
					})),
				},
				dispose() {},
			};
		},
	});
	monaco.languages.registerDefinitionProvider("ssl", {
		async provideDefinition(model, position) {
			return locations(await quiet(session.request("textDocument/definition", { ...doc(model), position: toPosition(position) }), null));
		},
	});
	monaco.languages.registerReferenceProvider("ssl", {
		async provideReferences(model, position, context) {
			return locations(
				await quiet(session.request("textDocument/references", { ...doc(model), position: toPosition(position), context: { includeDeclaration: context.includeDeclaration } }), null),
			);
		},
	});
	monaco.languages.registerRenameProvider("ssl", {
		async provideRenameEdits(model, position, newName) {
			const edit = await session.request("textDocument/rename", { ...doc(model), position: toPosition(position), newName });
			const edits: monaco.languages.IWorkspaceTextEdit[] = [];
			const changes: Record<string, any[]> = edit?.changes ?? {};
			for (const change of edit?.documentChanges ?? []) changes[change.textDocument.uri] = [...(changes[change.textDocument.uri] ?? []), ...change.edits];
			for (const [uri, list] of Object.entries(changes)) {
				await session.ensureModel(uri);
				for (const e of list) edits.push({ resource: monaco.Uri.parse(uri), textEdit: { range: toRange(e.range), text: e.newText }, versionId: undefined });
			}
			return { edits };
		},
		async resolveRenameLocation(model, position) {
			const result = await session.request("textDocument/prepareRename", { ...doc(model), position: toPosition(position) });
			if (!result) return { range: new monaco.Range(position.lineNumber, position.column, position.lineNumber, position.column), text: "", rejectReason: "Nothing to rename here." };
			const range = toRange(result.range ?? result);
			return { range, text: result.placeholder ?? model.getValueInRange(range) };
		},
	});
	monaco.languages.registerDocumentSymbolProvider("ssl", {
		provideDocumentSymbols: (model) => quiet(session.documentSymbols(model), []),
	});
	monaco.languages.registerFoldingRangeProvider("ssl", {
		async provideFoldingRanges(model) {
			const folds = (await quiet(session.request("textDocument/foldingRange", doc(model)), null)) ?? [];
			const kinds: Record<string, monaco.languages.FoldingRangeKind> = {
				comment: monaco.languages.FoldingRangeKind.Comment,
				imports: monaco.languages.FoldingRangeKind.Imports,
				region: monaco.languages.FoldingRangeKind.Region,
			};
			return folds.map((f: any) => ({ start: f.startLine + 1, end: f.endLine + 1, kind: f.kind ? kinds[f.kind] : undefined }));
		},
	});
	monaco.languages.registerDocumentFormattingEditProvider("ssl", {
		async provideDocumentFormattingEdits(model, options) {
			const edits = await session.request("textDocument/formatting", { ...doc(model), options: { tabSize: options.tabSize, insertSpaces: options.insertSpaces } });
			return toMinimalEdits(model, edits ?? []);
		},
	});
	monaco.languages.registerDocumentRangeFormattingEditProvider("ssl", {
		async provideDocumentRangeFormattingEdits(model, range, options) {
			const edits = await session.request("textDocument/rangeFormatting", {
				...doc(model),
				range: toLspRange(range),
				options: { tabSize: options.tabSize, insertSpaces: options.insertSpaces },
			});
			return toMinimalEdits(model, edits ?? []);
		},
	});
	monaco.languages.registerInlayHintsProvider("ssl", {
		async provideInlayHints(model, range) {
			const hints = (await quiet(session.request("textDocument/inlayHint", { ...doc(model), range: toLspRange(range) }), null)) ?? [];
			return {
				hints: hints.map((h: any) => ({
					position: { lineNumber: h.position.line + 1, column: h.position.character + 1 },
					label: typeof h.label === "string" ? h.label : h.label.map((p: any) => p.value).join(""),
					kind: h.kind,
					paddingLeft: h.paddingLeft,
					paddingRight: h.paddingRight,
				})),
				dispose() {},
			};
		},
	});
}

export { backend };
