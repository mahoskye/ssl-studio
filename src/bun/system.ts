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
