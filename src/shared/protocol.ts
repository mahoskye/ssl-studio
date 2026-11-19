// What the UI asks of the Bun process, and what the Bun process tells the UI.
// The same API travels over Electrobun's RPC in the app and over a WebSocket
// in the browser host (src/bun/web.ts); src/bun/backend.ts implements it.

export type Entry = { name: string; path: string; kind: "file" | "dir"; size: number };

export type Workspace = { root: string; name: string };

export type FileText = { path: string; text: string; mtime: number };

/** What `.ssl-studio/project.toml` says, with defaults for what it leaves out. */
export type Project = {
	/** False until the folder has a project.toml. */
	configured: boolean;
	/** Where project.toml is, or would be. */
	path: string;
	name: string;
	description: string;
	/** Folders relative to the root. The Docs panel lists the Markdown in `docs` and `schema`. */
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
	/** A ticket: those of the specs it names that are not there. */
	missing?: string[];
	/** Knowledge: the folder it is in under the knowledge base ("decisions", "snippets"); "" at its top. */
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
	broken?: { href: string; line: number; instead?: string }[];
	/** A catalog (INDEX.md): whether its list no longer says what the documents do. */
	catalog?: { stale: boolean };
};
/** One file of the project, for the file manifest. */
export type ManifestFile = { path: string; kind: string; bytes: number; lines: number; sha256: string };

export type Snapshot = { id: string; time: number; size: number };

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
	/** "system", "dark", "light" or an imported theme's id. */
	theme: string;
	/** The size of code and documents: the editor, Blocks, diffs and rendered Markdown. */
	fontSize: number;
	formatOnSave: boolean;
	minimap: boolean;
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
	write(path: string, text: string): Promise<{ mtime: number }>;
	create(path: string, kind: "file" | "dir"): Promise<void>;
	rename(from: string, to: string): Promise<void>;
	trash(path: string): Promise<void>;
	search(query: string, options: { regex?: boolean; caseSensitive?: boolean }): Promise<SearchHit[]>;
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
	/** Every file of the project with its size and a checksum, for the file manifest. */
	manifest(): Promise<ManifestFile[]>;
	/** The first thing that keeps a text from being TOML, and where (from 1); null when it reads. */
	tomlProblem(text: string): Promise<{ message: string; line: number; column: number } | null>;
	settings(): Promise<{ effective: Settings; user: Partial<Settings>; workspace: Partial<Settings> }>;
	saveSettings(scope: SettingsScope, patch: SettingsPatch): Promise<Settings>;
	themes(): Promise<ThemeFile[]>;
	/** Asks for a VS Code theme file and keeps a copy; null when cancelled. */
	importTheme(): Promise<ThemeFile | null>;
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

export const DEFAULT_SETTINGS: Settings = {
	theme: "system",
	fontSize: 13,
	formatOnSave: true,
	minimap: true,
	regionColors: {},
	limits: { bytes: 50 * 1024, codeLines: 400, historyEntries: 3 },
	layout: { left: true, right: false, bottom: true, leftWidth: 260, rightWidth: 360, bottomHeight: 200 },
	ssl: {},
	stylePreset: "house",
	keys: {},
};
