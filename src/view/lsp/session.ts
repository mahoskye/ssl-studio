// One language-server session for the open workspace: documents, diagnostics
// and every Monaco provider the server's capabilities allow.
import { createSignal, createStore, reconcile } from "solid-js";
import { monaco } from "../editor/monaco";
import { LEGEND, onSemanticThemeChange, refreshSemanticTokens, translateTokens } from "../editor/semantic";
import { backend, on } from "../backend";
import { LspClient } from "./client";
import { applyTextEdits, FORMAT_WHOLE_UP_TO, formattedParts, selectedLines, smallEdits, trimEdit, typedLead } from "./edits";
import { decodeNameTokens, isDataSourceName, type LexToken, type NameToken } from "../../shared/lexicalTokens";
import { isSqlLanguage } from "../../shared/format";
import { baseName } from "../../shared/paths";

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
const [lspReadyEpoch, setLspReadyEpoch] = createSignal(0);
/**
 * False while the server runs and leaves what it was asked unanswered (the rule is the client's, `answerWait`).
 * The one source of that fact: the status bar, the panels and format on save all read it here.
 */
const [lspAnswering, setLspAnswering] = createSignal(true);
export { diagnostics, lspAnswering, lspReadyEpoch };

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

const LSP_MARKER_OWNER = "starlims-lsp";
const diagnosticsByOwner = new Map<string, Map<string, Diagnostic[]>>();

function setOwnerDiagnostics(uri: string, owner: string, list: Diagnostic[] | null) {
	let byOwner = diagnosticsByOwner.get(uri);
	if (list === null) {
		if (byOwner) {
			byOwner.delete(owner);
			if (!byOwner.size) diagnosticsByOwner.delete(uri);
		}
	} else {
		if (!byOwner) {
			byOwner = new Map();
			diagnosticsByOwner.set(uri, byOwner);
		}
		byOwner.set(owner, list);
	}
	const current = diagnosticsByOwner.get(uri);
	if (!current || !current.size) {
		setDiagnostics((s) => {
			delete s[uri];
		});
		return;
	}
	const merged: Diagnostic[] = [];
	for (const items of current.values()) for (const item of items) merged.push({ ...item });
	setDiagnostics((s) => {
		if (s[uri]) reconcile(merged, null)(s[uri]);
		else s[uri] = merged;
	});
}

function clearOwnerDiagnostics(owner: string) {
	for (const [uri, byOwner] of [...diagnosticsByOwner.entries()]) {
		if (!byOwner.has(owner)) continue;
		setOwnerDiagnostics(uri, owner, null);
		const model = monaco.editor.getModel(monaco.Uri.parse(uri));
		if (model && !model.isDisposed()) monaco.editor.setModelMarkers(model, owner, []);
	}
	for (const model of monaco.editor.getModels()) {
		if (!model.isDisposed()) monaco.editor.setModelMarkers(model, owner, []);
	}
}

/** Findings that come from SSL Studio rather than the server (a plan's check): Problems and markers, under their own owner. */
export function publishFindings(model: monaco.editor.ITextModel, owner: string, list: Omit<Diagnostic, "uri">[] | null) {
	const uri = model.uri.toString();
	if (!list) {
		setOwnerDiagnostics(uri, owner, null);
		if (!model.isDisposed()) monaco.editor.setModelMarkers(model, owner, []);
		return;
	}
	const stamped = list.map((d) => ({ ...d, uri }));
	setOwnerDiagnostics(uri, owner, stamped);
	if (!model.isDisposed()) {
		monaco.editor.setModelMarkers(
			model,
			owner,
			list.map((d) => ({ startLineNumber: d.line, startColumn: d.column, endLineNumber: d.endLine, endColumn: d.endColumn, severity: markerSeverity[d.severity] ?? monaco.MarkerSeverity.Info, message: d.message, code: d.code, source: d.source })),
		);
	}
}

export class LspSession {
	readonly client = new LspClient();
	private initialized: Promise<void> | null = null;
	private readyFlag = false;
	private epoch = 0;
	private root = "";
	private versions = new Map<string, number>();
	private tracked = new Map<string, () => void>();
	server: ServerInfo | null = null;
	capabilities: Record<string, any> = {};
	/** The style profile's `ssl` settings, sent at start and on change. */
	sslSettings: () => Record<string, unknown> = () => ({});
	/** Loads a model for a URI the server pointed at (definition, references). */
	ensureModel: (uri: string) => Promise<monaco.editor.ITextModel | null> = async () => null;

	constructor() {
		this.client.on("textDocument/publishDiagnostics", (params) => this.publish(params));
		this.client.onRequest("workspace/configuration", (params) =>
			(params?.items ?? []).map((item: { section?: string }) => (item.section === "ssl" ? this.sslSettings() : item.section ? null : { ssl: this.sslSettings() })),
		);
		this.client.onRequest("client/registerCapability", () => null);
		this.client.onRequest("window/workDoneProgress/create", () => null);
		this.client.onAnswering((answering) => setLspAnswering(answering));
		on("lspState", (state) => {
			if (state.state === "restarting" || state.state === "stopped" || state.state === "failed") {
				this.handleDown(state.state);
			}
			if (state.state === "running" && this.root) void this.start(this.root).catch(() => {});
		});
	}

	private abortScratchWaiters() {
		for (const resolve of this.scratchWaiters.values()) resolve(null);
		this.scratchWaiters.clear();
	}

	private clearLspDiagnostics() {
		clearOwnerDiagnostics(LSP_MARKER_OWNER);
	}

	private resetVersions() {
		for (const uri of this.versions.keys()) this.versions.set(uri, 0);
	}

	private handleDown(reason: string) {
		this.epoch++;
		this.readyFlag = false;
		setLspReadyEpoch(0);
		this.initialized = null;
		this.resetVersions();
		this.client.rejectAll(reason);
		this.abortScratchWaiters();
		this.clearLspDiagnostics();
	}

	/** Clears session state and LSP diagnostics (e.g. when switching or closing a workspace). */
	reset(): void {
		this.root = "";
		this.server = null;
		this.capabilities = {};
		this.handleDown("reset");
	}

	/** Records the open workspace root so a server that starts or recovers later initializes cleanly. */
	setRoot(root: string): void {
		this.root = root;
	}

	start(root: string) {
		this.root = root;
		const myEpoch = ++this.epoch;
		this.readyFlag = false;
		this.resetVersions();
		this.initialized = (async () => {
			try {
				const result = await this.client.request("initialize", {
					processId: null,
					initializationOptions: { ssl: this.sslSettings() },
					rootUri: monaco.Uri.file(root).toString(),
					workspaceFolders: [{ uri: monaco.Uri.file(root).toString(), name: baseName(root) }],
					capabilities: {
						textDocument: {
							synchronization: { didSave: true },
							documentSymbol: { hierarchicalDocumentSymbolSupport: true },
							// `contextSupport`: each request says what set it off (`completionContext`), which the server answers by.
							completion: { contextSupport: true, completionItem: { snippetSupport: true, documentationFormat: ["markdown", "plaintext"] } },
							hover: { contentFormat: ["markdown", "plaintext"] },
							signatureHelp: { signatureInformation: { documentationFormat: ["markdown", "plaintext"] } },
							rename: { prepareSupport: true },
							publishDiagnostics: { relatedInformation: false },
							foldingRange: { lineFoldingOnly: true },
							semanticTokens: { requests: { full: true }, tokenTypes: LEGEND.tokenTypes, tokenModifiers: LEGEND.tokenModifiers, formats: ["relative"] },
						},
						workspace: { workspaceFolders: true, configuration: true },
					},
				});
				if (this.epoch !== myEpoch) return;
				this.server = result?.serverInfo ?? null;
				this.capabilities = result?.capabilities ?? {};
				this.client.notify("initialized", {});
				this.readyFlag = true;
				setLspReadyEpoch(myEpoch);
				for (const model of monaco.editor.getModels()) {
					const uri = model.uri.toString();
					if (this.tracked.has(uri) && !this.versions.get(uri) && !model.isDisposed() && readByServer(model)) this.open(model);
				}
				refreshSemanticTokens();
				for (const listener of this.readyListeners) listener();
			} catch (err) {
				if (this.epoch === myEpoch) {
					this.readyFlag = false;
					this.initialized = null;
				}
				throw err;
			}
		})();
		return this.initialized;
	}

	private readyListeners = new Set<() => void>();
	/** Told each time the server has started and been given the open documents: what was asked of it before can be asked again. */
	onReady(listener: () => void): () => void {
		this.readyListeners.add(listener);
		return () => void this.readyListeners.delete(listener);
	}

	/** Whether a model is one the server is told of, in the language mode it is in now (`readByServer`). */
	reads(model: monaco.editor.ITextModel): boolean {
		return readByServer(model) && isServed(model);
	}

	/**
	 * Whether the server offers a custom request: starlims-lsp lists them as
	 * `experimental.ssl.<name>: <shape version>` (its docs/features/custom-requests.md).
	 * Shape version 1 is the one SSL Studio reads.
	 */
	supports(method: string): boolean {
		const name = method.replace(/^ssl\//, "");
		const version = this.capabilities.experimental?.ssl?.[name];
		return version === 1;
	}

	/** The server's semantic tokens in Monaco's form; null from a server without them. */
	async semanticTokens(model: monaco.editor.ITextModel) {
		await this.ready();
		const legend = this.capabilities.semanticTokensProvider?.legend;
		if (!legend) return null;
		const result = await this.request("textDocument/semanticTokens/full", { textDocument: { uri: model.uri.toString() } });
		return result ? translateTokens(result.data ?? [], legend) : null;
	}

	/**
	 * Where an open document's comments, strings and keywords are, as the server's lexer reads them
	 * (`ssl/lexicalTokens`, since starlims-lsp 0.32.0). Null from a server without the request, for a document it
	 * does not hold, and for one that changed while it was asked: the ranges would be of another text.
	 */
	async lexicalTokens(model: monaco.editor.ITextModel): Promise<LexToken[] | null> {
		await this.ready();
		if (!this.supports("ssl/lexicalTokens")) return null;
		const uri = model.uri.toString();
		if (!((this.versions.get(uri) ?? 0) > 0)) return null;
		const result = await this.request("ssl/lexicalTokens", { textDocument: { uri } });
		if (!result || result.version !== this.versions.get(uri)) return null;
		return result.tokens ?? [];
	}

	/** The server's semantic tokens by name, for asking what kind of name a word is. Null as for `lexicalTokens`. */
	async nameTokens(model: monaco.editor.ITextModel): Promise<NameToken[] | null> {
		await this.ready();
		const legend = this.capabilities.semanticTokensProvider?.legend;
		if (!legend) return null;
		const uri = model.uri.toString();
		const sent = this.versions.get(uri) ?? 0;
		if (!(sent > 0)) return null;
		const result = await this.request("textDocument/semanticTokens/full", { textDocument: { uri } });
		if (!result || sent !== this.versions.get(uri)) return null;
		return decodeNameTokens(result.data ?? [], legend);
	}

	/**
	 * The lexical tokens of text that is not in any editor. `name` is the file's own name: the server tells a script
	 * from a data source by it, and reads an SQL data source as no SSL at all.
	 */
	async scratchLexical(text: string, name = "text.ssl"): Promise<LexToken[] | null> {
		await this.ready();
		if (!this.supports("ssl/lexicalTokens")) return null;
		const myEpoch = this.epoch;
		const ending = /(\.(?:ssl|ds)\.txt|\.[A-Za-z0-9]+)$/.exec(name)?.[1] ?? ".ssl";
		const uri = monaco.Uri.file(`${this.root}/.ssl-studio/lexical-${++this.scratchCount}${ending}`).toString();
		this.client.notify("textDocument/didOpen", { textDocument: { uri, languageId: "ssl", version: 1, text } });
		try {
			return (await this.client.request("ssl/lexicalTokens", { textDocument: { uri } }))?.tokens ?? null;
		} finally {
			if (this.epoch === myEpoch && this.readyFlag) this.client.notify("textDocument/didClose", { textDocument: { uri } });
		}
	}

	/** Sends a changed style profile; the server re-checks open documents. */
	configure() {
		if (this.readyFlag) this.client.notify("workspace/didChangeConfiguration", { settings: { ssl: this.sslSettings() } });
	}

	private scratchWaiters = new Map<string, (diagnostics: any[] | null) => void>();
	private scratchCount = 0;

	/**
	 * Diagnostics and symbols for text that is not in any editor (a proposed change).
	 * `timedOut` says the server published nothing in time: `diagnostics` is then
	 * empty because nothing is known, not because nothing was found, and must not
	 * be read as a pass.
	 */
	async analyze(text: string): Promise<{ diagnostics: { code?: string; severity: number; message: string; line: number }[]; symbols: monaco.languages.DocumentSymbol[]; timedOut: boolean }> {
		await this.ready();
		const myEpoch = this.epoch;
		const uri = monaco.Uri.file(`${this.root}/.ssl-studio/scratch-${++this.scratchCount}.ssl`).toString();
		let timer: ReturnType<typeof setTimeout> | undefined;
		const published = new Promise<any[] | null>((resolve) => {
			this.scratchWaiters.set(uri, resolve);
			timer = setTimeout(() => resolve(null), 8000);
		});
		this.client.notify("textDocument/didOpen", { textDocument: { uri, languageId: "ssl", version: 1, text } });
		try {
			const answer = await published;
			clearTimeout(timer);
			if (this.epoch !== myEpoch || !this.readyFlag) {
				return { diagnostics: [], symbols: [], timedOut: true };
			}
			const raw = answer ?? [];
			const symbols = ((await this.client.request("textDocument/documentSymbol", { textDocument: { uri } })) ?? []).map(function convert(s: any): monaco.languages.DocumentSymbol {
				return { name: s.name, detail: s.detail ?? "", kind: s.kind - 1, tags: [], range: toRange(s.range ?? s.location.range), selectionRange: toRange(s.selectionRange ?? s.range ?? s.location.range), children: (s.children ?? []).map(convert) };
			});
			if (this.epoch !== myEpoch || !this.readyFlag) {
				return { diagnostics: [], symbols: [], timedOut: true };
			}
			return {
				diagnostics: raw.map((d) => ({ code: d.code == null ? undefined : String(typeof d.code === "object" ? d.code.value : d.code), severity: d.severity ?? 1, message: d.message, line: d.range.start.line + 1 })),
				symbols,
				timedOut: answer === null,
			};
		} finally {
			clearTimeout(timer);
			this.scratchWaiters.delete(uri);
			if (this.epoch === myEpoch && this.readyFlag) this.client.notify("textDocument/didClose", { textDocument: { uri } });
		}
	}

	/** Calls in text not in any editor, named by the procedure that makes them. The server reads an open document from its buffer. */
	async scratchCalls(text: string): Promise<{ from: string; target: string; resolved: boolean }[]> {
		await this.ready();
		if (!this.supports("ssl/callGraph")) return [];
		const myEpoch = this.epoch;
		const parsedUri = monaco.Uri.file(`${this.root}/.ssl-studio/calls-${++this.scratchCount}.ssl`);
		const uri = parsedUri.toString();
		const fsPath = parsedUri.fsPath;
		this.client.notify("textDocument/didOpen", { textDocument: { uri, languageId: "ssl", version: 1, text } });
		try {
			const graph = await this.client.request("ssl/callGraph", { textDocument: { uri } });
			const names = new Map<string, string>((graph?.nodes ?? []).map((n: any) => [n.id, n.name]));
			const matchesUri = (other?: string) => {
				if (!other) return false;
				const parsed = monaco.Uri.parse(other);
				return parsed.toString() === uri || parsed.fsPath === fsPath;
			};
			return (graph?.edges ?? []).filter((e: any) => matchesUri(e.location?.uri)).map((e: any) => ({ from: names.get(e.from) ?? e.from, target: e.target, resolved: Boolean(e.resolved) }));
		} finally {
			if (this.epoch === myEpoch && this.readyFlag) this.client.notify("textDocument/didClose", { textDocument: { uri } });
		}
	}

	/** A file changed outside the editor. The server re-reads it, so what it knows across files stays true. */
	fileChanged(path: string, exists: boolean) {
		if (this.readyFlag) this.client.notify("workspace/didChangeWatchedFiles", { changes: [{ uri: monaco.Uri.file(path).toString(), type: exists ? 2 : 3 }] });
	}

	/** The server's syntax tree for text not in any editor. */
	async scratchTree(text: string): Promise<any[]> {
		await this.ready();
		if (!this.supports("ssl/syntaxTree")) return [];
		const myEpoch = this.epoch;
		const uri = monaco.Uri.file(`${this.root}/.ssl-studio/tree-${++this.scratchCount}.ssl`).toString();
		this.client.notify("textDocument/didOpen", { textDocument: { uri, languageId: "ssl", version: 1, text } });
		try {
			return (await this.client.request("ssl/syntaxTree", { textDocument: { uri } }))?.nodes ?? [];
		} finally {
			if (this.epoch === myEpoch && this.readyFlag) this.client.notify("textDocument/didClose", { textDocument: { uri } });
		}
	}

	/** Standard LSP document symbols for text not in any editor, without waiting for diagnostics. */
	async scratchSymbols(text: string): Promise<monaco.languages.DocumentSymbol[]> {
		await this.ready();
		const myEpoch = this.epoch;
		const uri = monaco.Uri.file(`${this.root}/.ssl-studio/sym-${++this.scratchCount}.ssl`).toString();
		this.client.notify("textDocument/didOpen", { textDocument: { uri, languageId: "ssl", version: 1, text } });
		try {
			const convert = (s: any): monaco.languages.DocumentSymbol => ({
				name: s.name,
				detail: s.detail ?? "",
				kind: s.kind - 1,
				tags: [],
				range: toRange(s.range ?? s.location.range),
				selectionRange: toRange(s.selectionRange ?? s.range ?? s.location.range),
				children: (s.children ?? []).map(convert),
			});
			return ((await this.client.request("textDocument/documentSymbol", { textDocument: { uri } })) ?? []).map(convert);
		} finally {
			if (this.epoch === myEpoch && this.readyFlag) this.client.notify("textDocument/didClose", { textDocument: { uri } });
		}
	}

	/** One script's procedures and the calls they make: from its buffer if it is open, else the index. Null while it cannot be known. */
	async scriptCalls(uri: string): Promise<{ name: string; procedures: { name: string; line: number }[]; edges: { from: string; target: string; resolved: boolean }[] } | null> {
		await this.ready();
		if (!this.supports("ssl/callGraph")) return null;
		const graph = await this.client.request("ssl/callGraph", { textDocument: { uri } });
		if (graph?.indexing) return null;
		const path = monaco.Uri.parse(uri).fsPath;
		const here = (other?: string) => Boolean(other) && monaco.Uri.parse(other!).fsPath === path;
		const nodes: any[] = graph?.nodes ?? [];
		const names = new Map<string, string>(nodes.map((n) => [n.id, n.name]));
		return {
			name: nodes.find((n) => n.kind === "script" && here(n.location?.uri))?.name ?? "",
			procedures: nodes.filter((n) => n.kind === "procedure" && here(n.location?.uri)).map((n) => ({ name: n.name, line: n.location.range.start.line + 1 })),
			edges: (graph?.edges ?? []).filter((e: any) => here(e.location?.uri)).map((e: any) => ({ from: names.get(e.from) ?? e.from, target: e.target, resolved: Boolean(e.resolved) })),
		};
	}

	/**
	 * The formatter's output for text not in any editor. `name` is the name of the file the text is of, where it
	 * is of one: the server tells a script from a data source by it (as for `scratchLexical`), and leaves an SQL
	 * data source as it is.
	 */
	async formatText(text: string, options: { tabSize: number; insertSpaces: boolean }, name = "text.ssl"): Promise<string> {
		await this.ready();
		const myEpoch = this.epoch;
		const ending = /(\.(?:ssl|ds)\.txt|\.[A-Za-z0-9]+)$/.exec(name)?.[1] ?? ".ssl";
		const uri = monaco.Uri.file(`${this.root}/.ssl-studio/format-${++this.scratchCount}${ending}`).toString();
		this.client.notify("textDocument/didOpen", { textDocument: { uri, languageId: "ssl", version: 1, text } });
		try {
			const edits = ((await this.client.request("textDocument/formatting", { textDocument: { uri }, options })) ?? []) as { range: Range; newText: string }[];
			return applyTextEdits(text, edits);
		} finally {
			if (this.epoch === myEpoch && this.readyFlag) this.client.notify("textDocument/didClose", { textDocument: { uri } });
		}
	}

	/** As `lspAnswering`, read now: for work that is not drawn (a save deciding how long to wait). */
	get answering(): boolean {
		return this.client.answering;
	}

	/** Which silence this is, counted from one: what is said once for a silence remembers the number it was said at. */
	get silences(): number {
		return this.client.silences;
	}

	/**
	 * A caller that would wait no longer for what it asked says so here (a save waits two seconds, less than the
	 * session does). If the server has in fact answered nothing since, it counts as not answering from now, so that
	 * what gave up and what is shown agree.
	 */
	unanswered() {
		this.client.noAnswer();
	}

	/** Waits until the language server has finished initializing. */
	waitReady(): Promise<void> {
		return this.ready().then(() => {});
	}

	private async ready() {
		const init = this.initialized;
		if (!init) throw new Error("language server not running");
		await init;
		if (!this.readyFlag) throw new Error("language server not running");
	}

	private open(model: monaco.editor.ITextModel) {
		const uri = model.uri.toString();
		this.versions.set(uri, 1);
		this.client.notify("textDocument/didOpen", { textDocument: { uri, languageId: "ssl", version: 1, text: model.getValue() } });
	}

	/** Keeps the server's copy of an SSL model in step with the editor. */
	track(model: monaco.editor.ITextModel) {
		if (!readByServer(model) || !isServed(model)) return;
		const uri = model.uri.toString();
		if (this.tracked.has(uri)) return;
		this.versions.set(uri, 0);
		this.initialized
			?.then(() => {
				if (this.readyFlag && this.tracked.has(uri) && !this.versions.get(uri) && !model.isDisposed() && readByServer(model)) {
					this.open(model);
				}
			})
			.catch(() => {});
		const changes = model.onDidChangeContent((event) => {
			const current = this.versions.get(uri) ?? 0;
			if (!this.readyFlag || current <= 0) return;
			const version = current + 1;
			this.versions.set(uri, version);
			this.client.notify("textDocument/didChange", {
				textDocument: { uri, version },
				contentChanges: event.changes.map((c) => ({ range: toLspRange(c.range), rangeLength: c.rangeLength, text: c.text })),
			});
		});
		const disposeSub = model.onWillDispose(() => this.untrack(model));
		this.tracked.set(uri, () => {
			changes.dispose();
			disposeSub.dispose();
		});
	}

	/** Stops tracking a model when its language mode switches away from SSL or it is disposed. */
	untrack(model: monaco.editor.ITextModel) {
		const uri = model.uri.toString();
		const stop = this.tracked.get(uri);
		if (!stop) return;
		this.tracked.delete(uri);
		stop();
		const hadOpen = (this.versions.get(uri) ?? 0) > 0;
		this.versions.delete(uri);
		if (this.readyFlag && hadOpen) this.client.notify("textDocument/didClose", { textDocument: { uri } });
		setOwnerDiagnostics(uri, LSP_MARKER_OWNER, null);
		if (!model.isDisposed()) monaco.editor.setModelMarkers(model, LSP_MARKER_OWNER, []);
	}

	saved(model: monaco.editor.ITextModel) {
		const uri = model.uri.toString();
		if (this.readyFlag && (this.versions.get(uri) ?? 0) > 0) this.client.notify("textDocument/didSave", { textDocument: { uri } });
	}

	private publish(params: { uri: string; diagnostics: any[] }) {
		const parsedUri = monaco.Uri.parse(params.uri);
		const uri = parsedUri.toString();
		// Scratch documents (Reference panel, agent checks) are not the user's files.
		if (uri.includes("/.ssl-studio/") || parsedUri.path.includes("/.ssl-studio/")) {
			this.scratchWaiters.get(uri)?.(params.diagnostics);
			return;
		}
		const model = monaco.editor.getModel(parsedUri);
		const list: Diagnostic[] = params.diagnostics.map((d) => ({
			uri,
			line: d.range.start.line + 1,
			column: d.range.start.character + 1,
			endLine: d.range.end.line + 1,
			endColumn: d.range.end.character + 1,
			severity: d.severity ?? 1,
			message: d.message,
			code: d.code == null ? undefined : String(typeof d.code === "object" ? d.code.value : d.code),
			source: d.source,
		}));
		setOwnerDiagnostics(uri, LSP_MARKER_OWNER, list);
		if (model && !model.isDisposed())
			monaco.editor.setModelMarkers(
				model,
				LSP_MARKER_OWNER,
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

	/**
	 * The edits that leave the given line ranges (0-based, inclusive) as a format of the whole document would leave
	 * them, and touch nothing else. The document is formatted as "Format document" formats it, and the lines of the
	 * ranges are taken from the answer (`formattedParts`), as the smallest edits that make the change.
	 *
	 * A range format is not the same: the server leaves out of it what it does to a whole document only. Null where
	 * the two texts cannot be set side by side; the caller then has the range format to fall back on.
	 */
	async formatRangesAsDocument(model: monaco.editor.ITextModel, ranges: [number, number][], options: monaco.languages.FormattingOptions): Promise<monaco.editor.IIdentifiedSingleEditOperation[] | null> {
		if (model.isDisposed()) return [];
		const version = model.getVersionId();
		const answer = ((await this.request("textDocument/formatting", {
			textDocument: { uri: model.uri.toString() },
			options: { tabSize: options.tabSize, insertSpaces: options.insertSpaces },
		})) ?? []) as { range: Range; newText: string }[];
		if (model.isDisposed() || model.getVersionId() !== version) return [];
		if (!answer.length) return [];
		return linesFromFormatted(model, applyTextEdits(model.getLinesContent().join("\n"), answer), ranges);
	}

	/**
	 * Formats the given line ranges (0-based, inclusive). The edits are each range's changed lines; with `small`,
	 * only the characters that differ in a line the formatter kept (`toSmallEdits`), for a cursor that is to stay
	 * where it is.
	 */
	async formatRanges(model: monaco.editor.ITextModel, ranges: [number, number][], options: monaco.languages.FormattingOptions, small = false) {
		if (model.isDisposed()) return [];
		const version = model.getVersionId();
		const edits: monaco.editor.IIdentifiedSingleEditOperation[] = [];
		for (const [start, end] of ranges) {
			if (model.isDisposed() || model.getVersionId() !== version) return [];
			const lineCount = model.getLineCount();
			const startLine = Math.min(Math.max(1, start + 1), lineCount);
			const endLine = Math.min(Math.max(startLine, end + 1), lineCount);
			const range = new monaco.Range(startLine, 1, endLine, model.getLineMaxColumn(endLine));
			const result = await this.request("textDocument/rangeFormatting", {
				textDocument: { uri: model.uri.toString() },
				range: toLspRange(range),
				options: { tabSize: options.tabSize, insertSpaces: options.insertSpaces },
			});
			if (model.isDisposed() || model.getVersionId() !== version) return [];
			edits.push(...(small ? toSmallEdits : toMinimalEdits)(model, result ?? []));
		}
		return edits;
	}
}

/** The formatter's edits replace whole ranges; shrink each to its changed lines. */
export function toMinimalEdits(model: monaco.editor.ITextModel, edits: { range: Range; newText: string }[]) {
	if (!edits.length) return [];
	const clamped = edits.map((edit) => ({
		range: model.validateRange(toRange(edit.range)),
		newText: edit.newText,
	}));
	const eol = model.getEOL();
	if (clamped.length > 1) {
		const sorted = [...clamped].sort(
			(a, b) => a.range.startLineNumber - b.range.startLineNumber || a.range.endLineNumber - b.range.endLineNumber,
		);
		let sharesLine = false;
		for (let i = 1; i < sorted.length; i++) {
			if (sorted[i]!.range.startLineNumber <= sorted[i - 1]!.range.endLineNumber) {
				sharesLine = true;
				break;
			}
		}
		if (sharesLine) {
			return clamped.map((edit) => ({ range: edit.range, text: edit.newText.replace(/\r?\n/g, eol) }));
		}
	}
	const lineCount = model.getLineCount();
	return clamped.flatMap((edit) => {
		const range = edit.range;
		// Extend to whole lines so line-based trimming is exact.
		const full = new monaco.Range(range.startLineNumber, 1, range.endLineNumber, model.getLineMaxColumn(range.endLineNumber));
		const before = model.getValueInRange(new monaco.Range(range.startLineNumber, 1, range.startLineNumber, range.startColumn));
		const after = model.getValueInRange(new monaco.Range(range.endLineNumber, range.endColumn, range.endLineNumber, model.getLineMaxColumn(range.endLineNumber)));
		const oldLines = model.getValueInRange(full).split(eol);
		const newLines = (before + edit.newText.replace(/\r?\n/g, eol) + after).split(eol);
		const trimmed = trimEdit(oldLines, newLines);
		if (!trimmed) return [];
		const startLine = full.startLineNumber + trimmed.startLine;
		const endLine = full.startLineNumber + trimmed.endLine;
		if (endLine < startLine) {
			// Pure insertion before line `startLine`, or after the last line at EOF.
			if (startLine > lineCount) {
				const lastCol = model.getLineMaxColumn(lineCount);
				return [{ range: new monaco.Range(lineCount, lastCol, lineCount, lastCol), text: eol + trimmed.lines.join(eol) }];
			}
			return [{ range: new monaco.Range(startLine, 1, startLine, 1), text: trimmed.lines.join(eol) + eol }];
		}
		if (!trimmed.lines.length) {
			// Pure deletion of whole lines.
			const next =
				endLine + 1 <= lineCount
					? new monaco.Range(startLine, 1, endLine + 1, 1)
					: new monaco.Range(Math.max(1, startLine - 1), model.getLineMaxColumn(Math.max(1, startLine - 1)), endLine, model.getLineMaxColumn(endLine));
			return [{ range: next, text: "" }];
		}
		return [{ range: new monaco.Range(startLine, 1, endLine, model.getLineMaxColumn(endLine)), text: trimmed.lines.join(eol) }];
	});
}

/**
 * The formatter's edits as the smallest edits that make the same change (`smallEdits`): a line the formatter kept
 * is changed only where its characters differ. For edits applied where a cursor is: one inside a replaced range
 * is put at the range's edge, and format on save, which replaced a whole procedure, took the cursor off the line
 * being typed. Edits that share a line are left as `toMinimalEdits` makes them.
 */
export function toSmallEdits(model: monaco.editor.ITextModel, edits: { range: Range; newText: string }[]): monaco.editor.IIdentifiedSingleEditOperation[] {
	if (!edits.length) return [];
	const ranges = edits.map((edit) => model.validateRange(toRange(edit.range)));
	const sorted = [...ranges].sort((a, b) => a.startLineNumber - b.startLineNumber || a.endLineNumber - b.endLineNumber);
	for (let i = 1; i < sorted.length; i++) if (sorted[i]!.startLineNumber <= sorted[i - 1]!.endLineNumber) return toMinimalEdits(model, edits);
	const eol = model.getEOL();
	return edits.flatMap((edit, at) => {
		const range = ranges[at]!;
		const full = new monaco.Range(range.startLineNumber, 1, range.endLineNumber, model.getLineMaxColumn(range.endLineNumber));
		const before = model.getValueInRange(new monaco.Range(range.startLineNumber, 1, range.startLineNumber, range.startColumn));
		const after = model.getValueInRange(new monaco.Range(range.endLineNumber, range.endColumn, range.endLineNumber, model.getLineMaxColumn(range.endLineNumber)));
		const oldLines = model.getValueInRange(full).split(eol);
		const newLines = (before + edit.newText.replace(/\r?\n/g, eol) + after).split(eol);
		const trimmed = trimEdit(oldLines, newLines);
		if (!trimmed) return [];
		const changed = oldLines.slice(trimmed.startLine, trimmed.endLine + 1);
		// Lines only added, or only taken out: the one edit is the smallest there is.
		if (!changed.length || !trimmed.lines.length) return toMinimalEdits(model, [edit]);
		const first = full.startLineNumber + trimmed.startLine;
		return smallEdits(changed, trimmed.lines).map((small) => ({
			range: new monaco.Range(first + small.startLine, small.startColumn + 1, first + small.endLine, small.endColumn + 1),
			text: small.text.replace(/\n/g, eol),
		}));
	});
}

export const session = new LspSession();

/**
 * Whether a model is in a language mode the server reads: SSL, or SQL where the file is a data source. The server
 * tells an SQL data source from an SSL one by the file itself, whatever mode the editor shows it in, and checks
 * what is its own to check in one (its parameters, a misplaced `;`): shown as SQL (ADR 0038), it is still told
 * of, so those findings are kept.
 */
function readByServer(model: monaco.editor.ITextModel) {
	const language = model.getLanguageId();
	return language === "ssl" || (isSqlLanguage(language) && isDataSourceName(model.uri.path));
}

/**
 * Whether a model is a document the server is told of: a file, or a document not yet saved. The server reads an
 * `untitled:` document as it does a file. Other models in the language (the earlier side of a comparison, a
 * preview) are not the user's documents, and the server holds no copy of them to answer from.
 */
function isServed(model: monaco.editor.ITextModel) {
	return model.uri.scheme === "file" || model.uri.scheme === "untitled";
}
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

/**
 * What set a completion off, as the protocol says it: typing, a trigger character (and which), or a list that was
 * not complete. The protocol's numbers are the editor's plus one.
 *
 * The server answers by it. Told that ":" was typed, it gives the members of the object before the colon, or the
 * keywords alone, each with the range it replaces. Told nothing, it gave every name it knows at every place, and no
 * range: the list after "oMail:" was the whole language, and the app had never said what was typed.
 */
export function completionContext(context?: { triggerKind?: number; triggerCharacter?: string }): { triggerKind: number; triggerCharacter?: string } {
	const triggerKind = (context?.triggerKind ?? 0) + 1;
	return context?.triggerCharacter ? { triggerKind, triggerCharacter: context.triggerCharacter } : { triggerKind };
}

/**
 * What is said of a rename the server answered with no edits. It answers so for a new name it will not take (a
 * keyword, the name of a built-in function, something that is no name), and gives no reason. Which of its rules
 * said no is not for the app to guess, which knows no SSL: this says what was asked, and that nothing changed.
 */
export const renameRefusal = (from: string, to: string) =>
	from ? `The language server would not rename “${from}” to “${to}”. Nothing was changed.` : `The language server would not take “${to}” as the new name. Nothing was changed.`;

/** What is said of a rename that failed: the server's own words where it gave any (a reason, should it come to give one). */
export const renameFailure = (err: unknown) => {
	const said = String((err as { message?: unknown } | null)?.message ?? "").trim();
	return said ? `Nothing was renamed: ${said}` : "Nothing was renamed: the language server did not answer.";
};

/**
 * The edits that leave the given line ranges (0-based, inclusive) of a document as they are in `formatted`, a format
 * of the whole of it, and touch nothing else: the lines are taken from the formatted text (`formattedParts`), as the
 * smallest edits that make the change. Null where the two texts cannot be set side by side.
 */
export function linesFromFormatted(model: monaco.editor.ITextModel, formatted: string, ranges: [number, number][]): monaco.editor.IIdentifiedSingleEditOperation[] | null {
	const oldLines = model.getLinesContent();
	const parts = formattedParts(oldLines, formatted.split(/\r?\n/), ranges);
	if (!parts) return null;
	const eol = model.getEOL();
	const lineCount = oldLines.length;
	return parts.flatMap((part): monaco.editor.IIdentifiedSingleEditOperation[] => {
		const first = part.start + 1;
		const last = part.start + part.oldLines.length;
		// The formatter has none of these lines any more: they go, with a line break, so no empty line is left.
		if (!part.newLines.length) {
			if (last < lineCount) return [{ range: new monaco.Range(first, 1, last + 1, 1), text: "" }];
			if (first > 1) return [{ range: new monaco.Range(first - 1, model.getLineMaxColumn(first - 1), last, model.getLineMaxColumn(last)), text: "" }];
			return [{ range: new monaco.Range(first, 1, last, model.getLineMaxColumn(last)), text: "" }];
		}
		return smallEdits(part.oldLines, part.newLines).map((small) => ({
			range: new monaco.Range(first + small.startLine, small.startColumn + 1, first + small.endLine, small.endColumn + 1),
			text: small.text.replace(/\n/g, eol),
		}));
	});
}

/**
 * Puts the language server behind the editor's own features for SSL: completion, hover, going to a definition,
 * rename and the rest.
 *
 * `tell` is where a thing the user has to hear of is said, the app's notices. The session draws nothing itself.
 */
export function registerProviders(tell: (text: string) => void = () => {}) {
	monaco.languages.registerCompletionItemProvider("ssl", {
		triggerCharacters: [":"],
		async provideCompletionItems(model, position, context) {
			if (!isServed(model)) return { suggestions: [] };
			const result = await quiet(session.request("textDocument/completion", { ...doc(model), position: toPosition(position), context: completionContext(context) }), null);
			// Closed while the server was asked (its tab shut, a scratch copy let go): there is no list to show, and
			// reading the document now raised "Something went wrong".
			if (model.isDisposed()) return { suggestions: [] };
			const items = (result?.items ?? result ?? []) as any[];
			const word = model.getWordUntilPosition(position);
			const range = new monaco.Range(position.lineNumber, word.startColumn, position.lineNumber, word.endColumn);
			const beforeWord = model.getLineContent(position.lineNumber).slice(0, word.startColumn - 1);
			return {
				incomplete: Boolean(result?.isIncomplete),
				suggestions: items.map((item) => {
					const snippet = item.insertTextFormat === 2;
					const insertText: string = item.textEdit?.newText ?? item.insertText ?? item.label;
					const named = item.textEdit?.range ?? item.textEdit?.replace;
					// With no range from the server (it names one for a keyword only when a typed ":" set the list off, not
					// when the list is asked for later) the word at the cursor is replaced, and with it the punctuation
					// before the word that the text itself opens with: ":WHILE" for a typed ":wh" is not "::WHILE".
					const lead = named ? 0 : typedLead(beforeWord, insertText, snippet);
					const typed = insertText.slice(0, lead);
					const filter: string = item.filterText ?? item.label;
					return {
						label: item.label,
						kind: completionKinds[item.kind ?? 1] ?? K.Text,
						detail: item.detail,
						documentation: markdown(item.documentation),
						insertText,
						insertTextRules: snippet ? monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet : undefined,
						range: named ? toRange(named) : lead ? new monaco.Range(position.lineNumber, word.startColumn - lead, position.lineNumber, word.endColumn) : range,
						sortText: item.sortText,
						// The list is narrowed by what the range holds, which now starts with that punctuation: an item
						// whose name does not (a snippet named "while" that writes ":WHILE") is found by it all the same.
						filterText: lead && !filter.startsWith(typed) ? typed + filter : item.filterText,
					};
				}),
			};
		},
	});
	monaco.languages.registerHoverProvider("ssl", {
		async provideHover(model, position) {
			if (!isServed(model)) return null;
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
			if (!isServed(model)) return null;
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
			if (!isServed(model)) return [];
			return locations(await quiet(session.request("textDocument/definition", { ...doc(model), position: toPosition(position) }), null));
		},
	});
	monaco.languages.registerReferenceProvider("ssl", {
		async provideReferences(model, position, context) {
			if (!isServed(model)) return [];
			return locations(
				await quiet(session.request("textDocument/references", { ...doc(model), position: toPosition(position), context: { includeDeclaration: context.includeDeclaration } }), null),
			);
		},
	});
	/** The name the server last said a rename is of, and in which document: what the editor's box opened with. */
	let renaming = { uri: "", name: "" };
	monaco.languages.registerRenameProvider("ssl", {
		async provideRenameEdits(model, position, newName) {
			// A reason given back to the editor here goes to its notifications, and this editor's are written to the
			// console and nowhere else: the box closed, nothing changed and nothing was said. So it is told as well.
			const refuse = (reason: string) => (tell(reason), { edits: [], rejectReason: reason });
			if (!isServed(model)) return refuse("Nothing to rename here.");
			const edits: monaco.languages.IWorkspaceTextEdit[] = [];
			try {
				const edit: any = await session.request("textDocument/rename", { ...doc(model), position: toPosition(position), newName });
				const changes: Record<string, any[]> = { ...(edit?.changes ?? {}) };
				for (const change of edit?.documentChanges ?? []) {
					if (!change?.textDocument?.uri || !Array.isArray(change.edits)) continue;
					changes[change.textDocument.uri] = [...(changes[change.textDocument.uri] ?? []), ...change.edits];
				}
				for (const [uri, list] of Object.entries(changes)) {
					if (!list?.length) continue;
					await session.ensureModel(uri);
					for (const e of list) edits.push({ resource: monaco.Uri.parse(uri), textEdit: { range: toRange(e.range), text: e.newText }, versionId: undefined });
				}
			} catch (err: any) {
				return refuse(renameFailure(err));
			}
			if (!edits.length) return refuse(renameRefusal(renaming.uri === model.uri.toString() ? renaming.name : "", newName));
			return { edits };
		},
		async resolveRenameLocation(model, position) {
			if (!isServed(model)) {
				return { range: new monaco.Range(position.lineNumber, position.column, position.lineNumber, position.column), text: "", rejectReason: "Nothing to rename here." };
			}
			let result: any;
			try {
				result = await session.request("textDocument/prepareRename", { ...doc(model), position: toPosition(position) });
			} catch (err: any) {
				return { range: new monaco.Range(position.lineNumber, position.column, position.lineNumber, position.column), text: "", rejectReason: String(err?.message ?? "Nothing to rename here.") };
			}
			if (!result || model.isDisposed()) return { range: new monaco.Range(position.lineNumber, position.column, position.lineNumber, position.column), text: "", rejectReason: "Nothing to rename here." };
			const range = toRange(result.range ?? result);
			const text = result.placeholder ?? model.getValueInRange(range);
			renaming = { uri: model.uri.toString(), name: text };
			return { range, text };
		},
	});
	monaco.languages.registerDocumentSymbolProvider("ssl", {
		provideDocumentSymbols: (model) => (isServed(model) ? quiet(session.documentSymbols(model), []) : []),
	});
	monaco.languages.registerFoldingRangeProvider("ssl", {
		async provideFoldingRanges(model) {
			if (!isServed(model)) return [];
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
			if (!isServed(model) || model.isDisposed()) return [];
			const version = model.getVersionId();
			const edits = await quiet(session.request("textDocument/formatting", { ...doc(model), options: { tabSize: options.tabSize, insertSpaces: options.insertSpaces } }), null);
			if (!edits || model.isDisposed() || model.getVersionId() !== version) return [];
			return toMinimalEdits(model, edits);
		},
	});
	monaco.languages.registerDocumentRangeFormattingEditProvider("ssl", {
		async provideDocumentRangeFormattingEdits(model, range, options) {
			if (!isServed(model) || model.isDisposed()) return [];
			const version = model.getVersionId();
			// The selected lines as "Format document" leaves them, as a save takes its changed lines (ADR 0037, ADR 0043).
			// The server's range format indents what it is given from its first line: two lines of an :IF, the first
			// at the wrong depth, both came back at that depth, the right one taken out of its block.
			if (model.getValueLength() <= FORMAT_WHOLE_UP_TO) {
				const whole = await quiet(session.formatRangesAsDocument(model, selectedLines(range), options), null);
				if (model.isDisposed() || model.getVersionId() !== version) return [];
				if (whole) return whole.map((e) => ({ range: e.range, text: e.text ?? "" }));
			}
			const edits = await quiet(
				session.request("textDocument/rangeFormatting", {
					...doc(model),
					range: toLspRange(range),
					options: { tabSize: options.tabSize, insertSpaces: options.insertSpaces },
				}),
				null,
			);
			if (!edits || model.isDisposed() || model.getVersionId() !== version) return [];
			return toMinimalEdits(model, edits);
		},
	});
	monaco.languages.registerDocumentSemanticTokensProvider("ssl", {
		onDidChange: onSemanticThemeChange,
		getLegend: () => LEGEND,
		async provideDocumentSemanticTokens(model) {
			if (!isServed(model)) return null;
			const result = await quiet(session.semanticTokens(model), null);
			return result && { data: result };
		},
		releaseDocumentSemanticTokens() {},
	});
	monaco.languages.registerInlayHintsProvider("ssl", {
		async provideInlayHints(model, range) {
			if (!isServed(model)) return { hints: [], dispose() {} };
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
