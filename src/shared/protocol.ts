// What the UI asks of the Bun process, and what the Bun process tells the UI.
// The same API travels over Electrobun's RPC in the app and over a WebSocket
// in the browser host (src/bun/web.ts); src/bun/backend.ts implements it.

export type Entry = { name: string; path: string; kind: "file" | "dir"; size: number };

export type Workspace = { root: string; name: string };

export type FileText = { path: string; text: string; mtime: number };

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

export type Info = { app: string; lsp: ToolStatus; opencode: ToolStatus; host: "app" | "browser"; selftest: boolean };

export type ThemeFile = { id: string; name: string; json: string };

export type Settings = {
	/** "system", "dark", "light" or an imported theme's id. */
	theme: string;
	fontSize: number;
	formatOnSave: boolean;
	minimap: boolean;
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
	settings(): Promise<{ effective: Settings; user: Partial<Settings>; workspace: Partial<Settings> }>;
	saveSettings(scope: SettingsScope, patch: Partial<Settings>): Promise<Settings>;
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
	/** Copies text with the app's clipboard; false when the host has none (the UI falls back). */
	clipboard(text: string): Promise<boolean>;
}

export type BackendEvents = {
	lsp: string;
	lspState: LspState;
	fileChanged: { path: string };
	agent: { type: string; data: unknown };
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
