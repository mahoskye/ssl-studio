// What the UI asks of the Bun process, and what the Bun process tells the UI.
// The same API travels over Electrobun's RPC in the app and over a WebSocket
// in the browser host (src/bun/web.ts); src/bun/backend.ts implements it.

import type { CsvTableConfig } from "./csvFormat";
import type { FormatDocumentRequest, FormatDocumentResult, SqlDialect } from "./format";
import type { SearchOptions } from "./searchPattern";
import type { GitStatus } from "./gitStatus";

export type Entry = { name: string; path: string; kind: "file" | "dir"; size: number };

export type Workspace = { root: string; name: string };

/**
 * A file as it was read. `encoding` is what its text is written in. A file that is not text (`binary`) has no text
 * here: how large it is, and what kind of picture it is when it is one.
 */
export type FileText = { path: string; text: string; mtime: number; encoding?: string; binary?: { size: number; image?: string } };

/** What `.ssl-studio/project.toml` says, with defaults for what it leaves out. */
export type Project = {
	/** False until the folder has a project.toml. */
	configured: boolean;
	/** Where project.toml is, or would be. */
	path: string;
	name: string;
	description: string;
	/** Folders relative to the root. The Docs panel lists the Markdown in `docs`, and what `schema` holds by its kinds. */
	docs: string;
	/** What the tables the project uses are. */
	schema: string;
	tests: string;
	/** Scripts and data sources; "." when they are at the root. */
	code: string;
	/** Where plans and tidy notes are: always `design` (ADR 0005). */
	plans: string;
	agentModel?: string;
	stylePreset?: "house" | "server";
	/** Why project.toml could not be read; the defaults apply. */
	error?: string;
};

/** A companion reference doc, code sample, or fixture kept inside a ticket's dedicated folder. */
export type TicketFile = {
	/** Absolute path on disk. */
	path: string;
	/** Path relative to the ticket's folder, using "/" separators (e.g. "samples/Legacy.ssl"). */
	rel: string;
	/** File size in bytes. */
	size: number;
};

/** One row of the Docs panel. README.md and AGENTS.md are listed even when missing. */
export type DocGroup = "project" | "tickets" | "specs" | "knowledge" | "registries" | "docs" | "schema" | "plans";
export type DocFile = {
	path: string;
	/** Relative to the group's folder. */
	name: string;
	group: DocGroup;
	exists: boolean;
	/** Still holds the placeholder text "Set up project" wrote. */
	untouched?: boolean;
	/** What the document calls itself: its front matter's title, its first heading, or a snippet's first comment. */
	title?: string;
	/** The state its front matter says it is in. */
	status?: string;
	/** What it is about, in one line. */
	summary?: string;
	/** A ticket's own key. */
	ticket?: string;
	/** The tickets a spec, a decision or a question is for; for a ticket, the tickets it is related to. */
	tickets?: string[];
	/** A ticket or a spec: how many items of its task lists are ticked, when it has any. */
	tasks?: { done: number; total: number };
	/** A ticket: the ticket it is part of (an epic, a parent task). */
	parent?: string;
	/** A ticket: the specs it names, as paths from the project's root. */
	specs?: string[];
	/** A ticket: the plans it names, as paths from the project's root. */
	plans?: string[];
	/** A spec: the tickets declared in its own front matter (before merging a paired plan's ticket). */
	ownTickets?: string[];
	/** A spec written beside a `.plan.json`: the paired plan's name and ticket, when it names one. */
	pairedPlan?: { name: string; ticket?: string };
	/** A ticket: those of the specs or plans it names that are not there. */
	missing?: string[];
	/** A ticket with a dedicated bundle folder (docs/tickets/<KEY>/): the folder's absolute path. */
	ticketFolder?: string;
	/** Total number of companion files inside the ticket's bundle folder (uncapped). */
	ticketFileCount?: number;
	/** Sample of companion reference docs, code samples, and fixtures inside the ticket's bundle folder. */
	ticketFiles?: TicketFile[];
	/**
	 * Knowledge: the folder it is in under the knowledge base ("decisions", "snippets"); "" at its top. Schema: the
	 * folder it is in under the schema folder ("database", "interfaces", "files", or one of the project's own).
	 */
	kind?: string;
	/** A registry: how many rows, how many in each status (when it has that column), and what is wrong with it as a table. */
	rows?: number;
	tally?: { total: number; by: [status: string, count: number][] };
	problems?: string[];
	/**
	 * A Markdown document: its links to files of the project that are not there, as written, each with its line.
	 * `instead` is the one file of that name elsewhere in the project, as a link from this document would name it:
	 * where the file was moved to, most likely.
	 */
	broken?: { href: string; line: number; column: number; instead?: string }[];
	/** A registry with a "ticket" column: each ticket its rows name, with how many rows it has and how many of them are done. */
	forTickets?: { key: string; rows: number; done?: number }[];
	/** Per-ticket code/script tokens extracted from registry columns (keyed by lowercase ticket key). */
	ticketCodeRefs?: Record<string, string[]>;
	/** Code/SQL script paths or module names referenced by this document, plan, schema doc, or CSV registry. */
	codeRefs?: string[];
	/** Tags declared in YAML `tags:` or inline `#tag` prose (without leading `#`). */
	tags?: string[];
	/** Source file path declared in YAML `source:` (e.g. schema docs pointing to their DDL `.sql`). */
	source?: string;
	/** Set when `source:` points to a file inside the workspace that does not exist on disk. */
	missingSource?: string;
	/** ADRs/decisions this doc supersedes or is superseded by. */
	supersedes?: string[];
	supersededBy?: string[];
	/** Ticket dependency keys from `blocks:` / `blocked-by:`. */
	blocks?: string[];
	blockedBy?: string[];
	/**
	 * What a plain document in the docs folder calls itself: for its line in that folder's catalog. Not `title`: a
	 * plain document is linked by its file's name, as it always was, and not by a heading it happens to have.
	 */
	heading?: string;
	/**
	 * A catalog (INDEX.md): whether its list no longer says what the documents do, and which folder's it is, where
	 * that is not told by its group (the tests' and the code's, which are listed with the project's own files).
	 */
	catalog?: { stale: boolean; area?: "tickets" | "specs" | "knowledge" | "registries" | "schema" | "docs" | "tests" | "code" };
};
/**
 * A place in a Markdown document that leads to a file, or into a folder: the
 * document, the place's line and column, the path as written, what follows
 * the file or folder asked about in the path it leads to ("" for the file
 * itself), and how it is written: a link from the document ("doc"), a link
 * from the project's top ("/docs/…", "top"), or a path in front matter,
 * which is from the project's top with no mark ("root").
 */
export type LinkTo = { path: string; line: number; column: number; href: string; rest: string; from: "doc" | "top" | "root" };
/** A link by name in one of the workspace's Markdown documents: the document, the line (from 1), the column its name starts at (from 0), and the name as written. */
export type NameIn = { path: string; line: number; column: number; name: string };
/** One file of the project, for the file manifest. */
export type ManifestFile = { path: string; kind: string; bytes: number; lines: number; sha256: string };

export type Snapshot = { id: string; time: number; size: number };
export type GitCommit = { sha: string; shortSha: string; time: number; author: string; subject: string; path: string };

export type SearchHit = { path: string; line: number; column: number; length: number; text: string };

export type ToolStatus = {
	/** Found and runnable. */
	ok: boolean;
	version?: string;
	path?: string;
	/** Shown to the user when something is off: missing, unpinned, crashed. */
	message?: string;
};

export type Info = { /** Whether the system prefers dark, where the backend could ask it (Linux); otherwise the web view's own answer stands. */ systemDark?: boolean; app: string; lsp: ToolStatus; opencode: ToolStatus; host: "app" | "browser"; selftest: boolean; selftestCycle?: boolean; selftestClose?: boolean };

export type ThemeFile = { id: string; name: string; json: string };

export type Settings = {
	/** "system", "oklch:<tone>:<material>", "dark", "light" or an imported theme's id. */
	theme: string;
	/** Material hue used when theme is "system" (defaults to "walnut"). */
	themeMaterial?: string;
	/** Interface chrome font family; empty uses system-ui. */
	uiFont?: string;
	/** Code, Blocks, Tables and Output font family; empty uses ui-monospace. */
	codeFont?: string;
	/** Optional reading font family for Markdown Read view; empty inherits uiFont. */
	readFont?: string;
	/** The size of code and documents: the editor, Blocks, diffs and rendered Markdown. */
	fontSize: number;
	formatOnSave: boolean;
	minimap: boolean;
	/** Long lines are wrapped at the editor's edge. Off unless set. */
	wordWrap?: boolean;
	/** Markdown drawn as it is written, in the text view: headings larger, the markup out of the way. On unless set to false. */
	livePreview?: boolean;
	/** Folder relative to workspace root for customizable Templater Markdown templates (defaults to `<docs>/templates`). */
	templatesFolder?: string;
	/** Folder relative to workspace root for pasted/dropped Markdown image attachments (defaults to `<docs>/attachments`). */
	attachmentsFolder?: string;
	/** The menu bar across the top of the window. Shown unless set to false. */
	menuBar?: boolean;
	/** Parameter names shown beside the arguments of a call. On unless set to false. */
	inlayHints?: boolean;
	/** A ruler at the style's line length. On unless set to false. */
	rulers?: boolean;
	/** How many columns to each side of that ruler the fainter rulers stand; 0 for none. 10 unless set. */
	rulerMargin?: number;
	/** The size of the whole interface: 1 is as designed, from 0.8 to 1.6. */
	uiScale?: number;
	/** Overrides discovery of the starlims-lsp binary. */
	lspPath?: string;
	/** Region colour by region name, kept outside the code (VISION). */
	regionColors: Record<string, string>;
	/** House style: limits from program decision 0006. */
	limits: { bytes: number; codeLines: number; historyEntries: number };
	/** Panel layout, saved per workspace. */
	layout: { left: boolean; right: boolean; bottom: boolean; leftWidth: number; rightWidth: number; bottomHeight: number; dock?: Record<string, "left" | "right"> };
	/**
	 * The style profile: the language server's own `ssl` settings (its
	 * docs/configuration/CONFIGURATION.md), chosen here, applied there.
	 */
	ssl: Record<string, any>;
	/** The base the `ssl` overrides sit on: the house style, or the server's defaults. */
	stylePreset: "house" | "server";
	/** Agent: "providerID/modelID" for new sessions; a local model by default. */
	agentModel?: string;
	/**
	 * Models ("providerID/modelID") on a remote provider that run on the user's
	 * own machines: treated as local, so they need no cost prompt.
	 */
	agentOwnModels?: string[];
	/**
	 * Extra opencode config for the IDE's private server only (JSON, passed as
	 * OPENCODE_CONFIG_CONTENT): e.g. a local provider's address. Never written
	 * to opencode's own config.
	 */
	agentServerConfig?: string;
	/** Attach to a running opencode server instead of starting one ("url"; password from OPENCODE_SERVER_PASSWORD). */
	agentServerUrl?: string;
	/** Shortcut overrides: key ("ctrl+shift+x") to command id; "" unbinds a default. */
	keys: Record<string, string>;
	/** Configurable CSV table column badge formatting (columns, value-to-tone mappings, fallback). */
	csvTable?: CsvTableConfig;
	/** SQL dialect used when formatting standalone .sql files (default "tsql" for SQL Server STARLIMS). */
	sqlDialect?: SqlDialect;
	/** Active focused ticket key (persisted per workspace) coordinating Agent, Git, Search, Docs, Graph & Explorer. */
	activeTicket?: string;
};

export type OpenTaskItem = {
	path: string;
	name: string;
	title?: string;
	ticket?: string;
	group: DocFile["group"];
	line: number;
	offset: number;
	text: string;
};

export type WorkspaceDocIssue = {
	path: string;
	line: number;
	column?: number;
	kind: "anchor" | "table" | "yaml";
	level: "warn" | "note";
	message: string;
	href?: string;
};

export type DocAuditResult = {
	unusedAttachments: string[];
	openTasks: OpenTaskItem[];
	issues: WorkspaceDocIssue[];
};

export type SettingsScope = "user" | "workspace";
/** What to change in one settings file. A value of null takes the setting out of that file. */
export type SettingsPatch = { [K in keyof Settings]?: Settings[K] | null };

export type LspState = { state: "starting" | "running" | "restarting" | "stopped" | "failed"; message?: string };

export interface BackendApi {
	info(): Promise<Info>;
	/** Opens `path`, or asks with a folder dialog when it is absent. Null when cancelled. */
	openFolder(path?: string): Promise<Workspace | null>;
	workspace(): Promise<Workspace | null>;
	recent(): Promise<string[]>;
	list(dir: string): Promise<Entry[]>;
	/** Every file in the workspace (for quick open), up to a limit. */
	files(): Promise<string[]>;
	/** Sizes in bytes of workspace files (missing ones are left out). */
	sizes(paths: string[]): Promise<Record<string, number>>;
	read(path: string): Promise<FileText>;
	/**
	 * Writes a file's text, in the encoding it has. Text is not written over a file that is not text, unless
	 * `asText` says the text is the file's own, read as text and edited: an editor saving what it opened.
	 */
	write(path: string, text: string, asText?: boolean): Promise<{ mtime: number }>;
	create(path: string, kind: "file" | "dir"): Promise<void>;
	rename(from: string, to: string): Promise<void>;
	/** Keeps a file as it is on disk now in its local history, where it is text: before something is about to write over it. */
	historyKeep(path: string): Promise<void>;
	/** What git says has changed in the workspace, each file by its whole path. Null when it is not in a repository, or there is no git. */
	gitStatus(): Promise<GitStatus | null>;
	/** A file's text in the last commit ("head") or as it is staged ("index"); null when it was not there, or was not text. */
	gitBase(path: string, from: "head" | "index"): Promise<string | null>;
	/** Recent Git commits touching `path` (following renames). Empty outside a repository. */
	gitLog(path: string, limit?: number): Promise<GitCommit[]>;
	/** A file's text at a specific Git commit SHA (using its path in that commit when renamed). Null when binary or absent. */
	gitShow(path: string, sha: string, repoPath?: string): Promise<string | null>;
	/** Puts files into the next commit as they are now; takes them out of it again. */
	gitStage(paths: string[]): Promise<void>;
	gitUnstage(paths: string[]): Promise<void>;
	/** Commits what is staged. Says what git said of it, in a line. */
	gitCommit(message: string): Promise<string>;
	/**
	 * Lets a file's changes that are not staged go: a followed file goes back to what git has of it, and a file git
	 * does not follow goes to the trash. The file as it was is kept in its local history first.
	 */
	gitDiscard(path: string): Promise<void>;
	/** A picture's bytes, for showing it: its kind ("image/png") and the bytes in base64. */
	image(path: string): Promise<{ type: string; base64: string }>;
	/** Saves a binary picture (base64 payload) inside the workspace (e.g. clipboard paste or drag-and-drop into Markdown). */
	writeImage(path: string, base64: string): Promise<{ path: string; size: number }>;
	/** Copies a file, or a folder and everything in it, to a path nothing is at yet. */
	copy(from: string, to: string): Promise<void>;
	trash(path: string): Promise<void>;
	search(query: string, options: SearchOptions): Promise<SearchHit[]>;
	/**
	 * Replaces every match in the files named, on disk, each as it is written now. Says how many in each; a file
	 * that could not be written is left as it was and says why. Each file as it was is kept in local history.
	 */
	replace(query: string, replacement: string, options: SearchOptions, paths: string[]): Promise<{ path: string; count: number; error?: string }[]>;
	history(path: string): Promise<Snapshot[]>;
	snapshot(path: string, id: string): Promise<string>;
	/** The open folder's project settings (defaults when it has no project.toml). */
	project(): Promise<Project>;
	/** Writes project.toml, README.md and AGENTS.md where missing; returns what it created, relative to the root. */
	setupProject(): Promise<string[]>;
	/** What "Set up project" would create, without creating it. */
	setupPreview(): Promise<string[]>;
	/** Takes back the last "Set up project": removes what it wrote and nobody has changed since. */
	setupUndo(): Promise<{ removed: string[]; kept: string[] }>;
	/** How many open files have edits that are not on disk, so the app can ask before its window closes. */
	unsavedChanged(count: number): Promise<void>;
	/** Closes the app whatever is unsaved: the user has just said what to do with it. */
	closeWindow(): Promise<void>;
	/** README.md, AGENTS.md and project.toml, then the Markdown and plans in the project's docs and plans folders. */
	docs(): Promise<DocFile[]>;
	/** Cached workspace Markdown audit: unused attachments (configured + ticket bundles), open tasks, broken #anchors, table rule & YAML issues. */
	docAudit(attachmentsFolder?: string): Promise<DocAuditResult>;
	/** Every file of the project with its size and a checksum, for the file manifest. */
	manifest(): Promise<ManifestFile[]>;
	/**
	 * The files of the tests or the code folder as they lie, from that folder, with "/" between their parts: what
	 * its catalog lists. Null where the folder is not one to catalogue: it is not there, it is the project's own
	 * folder, or it holds more files than a catalog lists.
	 */
	catalogFiles(area: "tests" | "code"): Promise<string[] | null>;
	/** The first thing that keeps a text from being TOML, and where (from 1); null when it reads. */
	tomlProblem(text: string): Promise<{ message: string; line: number; column: number } | null>;
	/** Formats a non-SSL document (SQL, JavaScript, TypeScript, HTML, CSS, XML/XFD, JSON, YAML, Markdown). */
	formatDocument(request: FormatDocumentRequest): Promise<FormatDocumentResult>;
	/** The links in the workspace's Markdown documents that lead to this file, or into this folder. */
	linksTo(path: string): Promise<LinkTo[]>;
	/** The links by name ([[name]]) in the workspace's Markdown documents, as they stand on disk. */
	namesIn(): Promise<NameIn[]>;
	settings(): Promise<{ effective: Settings; user: Partial<Settings>; workspace: Partial<Settings> }>;
	saveSettings(scope: SettingsScope, patch: SettingsPatch): Promise<Settings>;
	themes(): Promise<ThemeFile[]>;
	/** Asks for a VS Code theme file and keeps a copy; null when cancelled. */
	importTheme(): Promise<ThemeFile | null>;
	/**
	 * A ticket export chosen with the system's own file dialog, from anywhere on the machine: its path and its text.
	 * Null when nothing was chosen, and where there is no such dialog (a browser tab).
	 */
	pickExport(): Promise<{ path: string; text: string } | null>;
	/** A ticket export's text by a path the person named, which may be outside the workspace: where a download lands. */
	readExport(path: string): Promise<string>;
	/** One JSON-RPC message for the language server, unframed. */
	lspSend(message: string): Promise<void>;
	lspRestart(): Promise<void>;
	lspState(): Promise<LspState>;
	/** Agent calls, forwarded to the opencode adapter (src/bun/agent.ts). */
	agent(method: string, args: unknown[]): Promise<unknown>;
	/** Self-test mode (SSL_STUDIO_SELFTEST=<report path>): the UI reports, then the app quits. */
	selftestDone(report: object): Promise<void>;
	/** Writes the self-test's report as it stands and stays open: the close check is read from outside while it runs. */
	selftestNote(report: object): Promise<void>;
	/** Copies text with the app's clipboard; false when the host has none (the UI falls back). */
	clipboard(text: string): Promise<boolean>;
}

export type BackendEvents = {
	lsp: string;
	lspState: LspState;
	fileChanged: { path: string };
	agent: { type: string; data: unknown };
	/** The window was asked to close while files had unsaved edits: the view asks what to do. */
	closeRequested: Record<string, never>;
};

export type AgentModel = { providerID: string; id: string; name: string; local: boolean; tools: boolean; variants: string[] };
export type AgentStatus = { state: "off" | "starting" | "ready" | "failed"; version?: string; message?: string; model?: string };
export type AgentReply = { sessionID: string; text: string; outcome: "succeeded" | "failed" | "interrupted" | "timeout"; tokens?: { input: number; output: number }; cost?: number; error?: string };

export type Call = { id: number; method: keyof BackendApi; args: unknown[] };
export type Reply = { id: number; result?: unknown; error?: string };
export type Push = { event: keyof BackendEvents; payload: unknown };

/**
 * The layout a folder first opens with. Made anew each time it is asked for: the view keeps its settings in the
 * very object it was given, so one that was handed out once is no longer the default.
 */
export const defaultLayout = (): Settings["layout"] => ({ left: true, right: false, bottom: true, leftWidth: 260, rightWidth: 360, bottomHeight: 200 });

export const DEFAULT_SETTINGS: Settings = {
	theme: "system",
	fontSize: 13,
	formatOnSave: true,
	minimap: true,
	regionColors: {},
	limits: { bytes: 50 * 1024, codeLines: 400, historyEntries: 3 },
	layout: defaultLayout(),
	ssl: {},
	stylePreset: "house",
	keys: {},
};
