// What the system itself prefers, asked of the system: a web view does not
// always know. On Linux a GTK web view takes its light or dark from GTK's own
// settings, which a desktop may leave alone while it tells every other
// program, through the settings portal, that it prefers dark.
import { dirname } from "node:path";
import { pathToFileURL } from "node:url";

async function run(cmd: string[], timeoutMs: number): Promise<string | null> {
	try {
		const proc = Bun.spawn(cmd, { stdout: "pipe", stderr: "ignore" });
		let timer: ReturnType<typeof setTimeout> | undefined;
		let killTimer: ReturnType<typeof setTimeout> | undefined;
		void proc.exited.finally(() => {
			if (killTimer !== undefined) clearTimeout(killTimer);
		});
		const timeout = new Promise<null>((resolve) => {
			timer = setTimeout(() => {
				try {
					proc.kill();
				} catch {
					// Already exited.
				}
				killTimer = setTimeout(() => {
					try {
						proc.kill("SIGKILL");
					} catch {
						// Already exited.
					}
				}, 250);
				killTimer.unref?.();
				resolve(null);
			}, timeoutMs);
		});
		const stdout = new Response(proc.stdout).text().catch(() => "");
		try {
			return await Promise.race([
				Promise.all([stdout, proc.exited]).then(([out, code]) => (code === 0 ? out : null)),
				timeout,
			]);
		} finally {
			if (timer !== undefined) clearTimeout(timer);
		}
	} catch {
		return null;
	}
}

/**
 * Whether the system prefers a dark appearance: true or false when it says,
 * undefined when it has no preference, cannot be asked, or is not Linux (where
 * the web view's own answer is the system's).
 */
export async function systemPrefersDark(): Promise<boolean | undefined> {
	if (process.platform !== "linux") return undefined;
	const out = await run(
		["gdbus", "call", "--session", "--dest", "org.freedesktop.portal.Desktop", "--object-path", "/org/freedesktop/portal/desktop", "--method", "org.freedesktop.portal.Settings.Read", "org.freedesktop.appearance", "color-scheme"],
		1500,
	);
	return out === null ? undefined : portalScheme(out);
}

/** The portal's answer read: 1 is "prefer dark", 2 is "prefer light", 0 is no preference. */
export function portalScheme(answer: string): boolean | undefined {
	const value = /uint32 (\d+)/.exec(answer)?.[1];
	return value === "1" ? true : value === "2" ? false : undefined;
}

/** Builds the OS command to open a file in its default application without invoking a shell. */
export function openFileCommand(platform: NodeJS.Platform, filePath: string): string[] {
	if (platform === "darwin") return ["open", filePath];
	if (platform === "win32") return ["rundll32.exe", "url.dll,FileProtocolHandler", filePath];
	return ["xdg-open", filePath];
}

/** Encodes a local path as a file:// URI safe inside a single-quoted GVariant array literal. */
export function fileUriForDbus(filePath: string): string {
	return pathToFileURL(filePath).href.replace(/'/g, "%27");
}

/** Opens a workspace-validated file path in the OS default application without shell interpolation. */
export async function openInSystemApp(filePath: string): Promise<void> {
	const proc = Bun.spawn(openFileCommand(process.platform, filePath), { stdout: "ignore", stderr: "ignore" });
	proc.unref();
}

/** Reveals/highlights a workspace-validated file path in the OS file manager without shell interpolation. */
export async function revealPathInFileManager(filePath: string): Promise<void> {
	if (process.platform === "darwin") {
		const proc = Bun.spawn(["open", "-R", filePath], { stdout: "ignore", stderr: "ignore" });
		proc.unref();
		return;
	}
	if (process.platform === "win32") {
		const proc = Bun.spawn(["explorer.exe", `/select,${filePath}`], { stdout: "ignore", stderr: "ignore" });
		proc.unref();
		return;
	}
	// Linux: try freedesktop FileManager1 ShowItems first, fall back to opening the parent folder.
	try {
		const fileUri = fileUriForDbus(filePath);
		const dbus = Bun.spawn(
			[
				"gdbus",
				"call",
				"--session",
				"--dest",
				"org.freedesktop.FileManager1",
				"--object-path",
				"/org/freedesktop/FileManager1",
				"--method",
				"org.freedesktop.FileManager1.ShowItems",
				`['${fileUri}']`,
				"",
			],
			{ stdout: "ignore", stderr: "ignore" },
		);
		let timer: ReturnType<typeof setTimeout> | undefined;
		let killTimer: ReturnType<typeof setTimeout> | undefined;
		void dbus.exited.finally(() => {
			if (killTimer !== undefined) clearTimeout(killTimer);
		});
		try {
			const code = await Promise.race([
				dbus.exited,
				new Promise<number>((resolve) => {
					timer = setTimeout(() => {
						try {
							dbus.kill();
						} catch {
							// Already exited.
						}
						killTimer = setTimeout(() => {
							try {
								dbus.kill("SIGKILL");
							} catch {
								// Already exited.
							}
						}, 250);
						killTimer.unref?.();
						resolve(1);
					}, 1200);
				}),
			]);
			if (code === 0) return;
		} finally {
			if (timer !== undefined) clearTimeout(timer);
		}
	} catch {
		// Fallback below.
	}
	const fallback = Bun.spawn(["xdg-open", dirname(filePath)], { stdout: "ignore", stderr: "ignore" });
	fallback.unref();
}
