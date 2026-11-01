// Where SSL Studio keeps its own files (ARCHITECTURE, "Settings and state").
import { homedir } from "node:os";
import { join } from "node:path";

const home = homedir();

export const dirs = {
	config: join(process.env.XDG_CONFIG_HOME ?? join(home, ".config"), "ssl-studio"),
	data: join(process.env.XDG_DATA_HOME ?? join(home, ".local", "share"), "ssl-studio"),
	state: join(process.env.XDG_STATE_HOME ?? join(home, ".local", "state"), "ssl-studio"),
};

/** The workspace's own settings folder, which the user may commit. */
export const workspaceDir = (root: string) => join(root, ".ssl-studio");
