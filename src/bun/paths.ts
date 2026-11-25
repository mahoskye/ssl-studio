// Where SSL Studio keeps its own files (ARCHITECTURE, "Settings and state").
import { homedir } from "node:os";
import { isAbsolute, join, posix, win32 } from "node:path";

const envDir = (v: string | undefined, checkAbsolute: (p: string) => boolean = isAbsolute) => (v && checkAbsolute(v) ? v : undefined);

export function resolveDirs(
	env: NodeJS.ProcessEnv = process.env,
	platform: NodeJS.Platform = process.platform,
	home = homedir(),
) {
	const windows = platform === "win32";
	const pathApi = windows ? win32 : posix;
	const checkAbs = (p: string) => pathApi.isAbsolute(p);
	const appData = envDir(env.APPDATA, checkAbs) ?? pathApi.join(home, "AppData", "Roaming");
	const localAppData = envDir(env.LOCALAPPDATA, checkAbs) ?? pathApi.join(home, "AppData", "Local");
	const xdgConfig = envDir(env.XDG_CONFIG_HOME, checkAbs);
	const xdgData = envDir(env.XDG_DATA_HOME, checkAbs);
	const xdgState = envDir(env.XDG_STATE_HOME, checkAbs);

	// XDG variables win everywhere (the self-test sets them); then the platform's own places.
	return {
		config: pathApi.join(xdgConfig ?? (windows ? appData : pathApi.join(home, ".config")), "ssl-studio"),
		data: pathApi.join(xdgData ?? (windows ? localAppData : pathApi.join(home, ".local", "share")), "ssl-studio"),
		state: xdgState
			? pathApi.join(xdgState, "ssl-studio")
			: windows
				? pathApi.join(localAppData, "ssl-studio", "state")
				: pathApi.join(home, ".local", "state", "ssl-studio"),
	};
}

export const dirs = resolveDirs();

/** The workspace's own settings folder, which the user may commit. */
export const workspaceDir = (root: string) => join(root, ".ssl-studio");
