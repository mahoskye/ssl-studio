// Where SSL Studio keeps its own files (ARCHITECTURE, "Settings and state").
import { homedir } from "node:os";
import { join } from "node:path";

const home = homedir();

const windows = process.platform === "win32";
const appData = process.env.APPDATA ?? join(home, "AppData", "Roaming");
const localAppData = process.env.LOCALAPPDATA ?? join(home, "AppData", "Local");

// XDG variables win everywhere (the self-test sets them); then the platform's own places.
export const dirs = {
	config: join(process.env.XDG_CONFIG_HOME ?? (windows ? appData : join(home, ".config")), "ssl-studio"),
	data: join(process.env.XDG_DATA_HOME ?? (windows ? localAppData : join(home, ".local", "share")), "ssl-studio"),
	state: process.env.XDG_STATE_HOME ? join(process.env.XDG_STATE_HOME, "ssl-studio") : windows ? join(localAppData, "ssl-studio", "state") : join(home, ".local", "state", "ssl-studio"),
};

/** The workspace's own settings folder, which the user may commit. */
export const workspaceDir = (root: string) => join(root, ".ssl-studio");
