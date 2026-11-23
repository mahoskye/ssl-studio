// What the system itself prefers, asked of the system: a web view does not
// always know. On Linux a GTK web view takes its light or dark from GTK's own
// settings, which a desktop may leave alone while it tells every other
// program, through the settings portal, that it prefers dark.

/**
 * Whether the system prefers a dark appearance: true or false when it says,
 * undefined when it has no preference, cannot be asked, or is not Linux (where
 * the web view's own answer is the system's).
 */
export async function systemPrefersDark(): Promise<boolean | undefined> {
	if (process.platform !== "linux") return undefined;
	try {
		const proc = Bun.spawn(
			["gdbus", "call", "--session", "--dest", "org.freedesktop.portal.Desktop", "--object-path", "/org/freedesktop/portal/desktop", "--method", "org.freedesktop.portal.Settings.Read", "org.freedesktop.appearance", "color-scheme"],
			{ stdout: "pipe", stderr: "ignore" },
		);
		const timer = setTimeout(() => proc.kill(), 1500);
		const out = await new Response(proc.stdout).text();
		clearTimeout(timer);
		return (await proc.exited) === 0 ? portalScheme(out) : undefined;
	} catch {
		return undefined;
	}
}

/** The portal's answer read: 1 is "prefer dark", 2 is "prefer light", 0 is no preference. */
export function portalScheme(answer: string): boolean | undefined {
	const value = /uint32 (\d+)/.exec(answer)?.[1];
	return value === "1" ? true : value === "2" ? false : undefined;
}

import { dirname } from "node:path";

/** Opens a workspace-validated file path in the OS default application without shell interpolation. */
export async function openInSystemApp(filePath: string): Promise<void> {
	const cmd =
		process.platform === "darwin"
			? ["open", filePath]
			: process.platform === "win32"
				? ["cmd", "/c", "start", "", filePath]
				: ["xdg-open", filePath];
	const proc = Bun.spawn(cmd, { stdout: "ignore", stderr: "ignore" });
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
		const fileUri = `file://${encodeURI(filePath)}`;
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
				`['${fileUri.replace(/'/g, "%27")}']`,
				"",
			],
			{ stdout: "ignore", stderr: "ignore" },
		);
		const code = await Promise.race([dbus.exited, new Promise<number>((r) => setTimeout(() => (dbus.kill(), r(1)), 1200))]);
		if (code === 0) return;
	} catch {
		// Fallback below.
	}
	const fallback = Bun.spawn(["xdg-open", dirname(filePath)], { stdout: "ignore", stderr: "ignore" });
	fallback.unref();
}
