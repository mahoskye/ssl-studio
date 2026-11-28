import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { BOUNDARY, contrast, TEXT } from "../src/shared/contrast";
import { allOklchThemes } from "../src/shared/oklchTheme";
import {
	buildXtermTheme,
	clampTerminalSize,
	shortShellName,
	shouldTerminalAllowShellCommand,
} from "../src/shared/terminal";
import { detectShellProfiles, TerminalManager } from "../src/bun/terminal";
import darkClassic from "../src/view/themes/studio-dark.json";
import lightClassic from "../src/view/themes/studio-light.json";

const repoRead = (rel: string) => readFileSync(resolve(import.meta.dirname, "..", rel), "utf8");

function mixSrgb(fgHex: string, fgPct: number, bgHex: string): string {
	const p = (hex: string) => [
		parseInt(hex.slice(1, 3), 16),
		parseInt(hex.slice(3, 5), 16),
		parseInt(hex.slice(5, 7), 16),
	] as const;
	const [r1, g1, b1] = p(fgHex);
	const [r2, g2, b2] = p(bgHex);
	const a = fgPct / 100;
	const ch = (x: number, y: number) => Math.round(x * a + y * (1 - a)).toString(16).padStart(2, "0");
	return `#${ch(r1, r2)}${ch(g1, g2)}${ch(b1, b2)}`;
}

describe("Integrated Terminal — pure helpers, key guards, and 27-theme WCAG AA palette", () => {
	test("clampTerminalSize and shortShellName sanitize bounds and shell paths", () => {
		expect(clampTerminalSize(10, 1)).toEqual({ cols: 20, rows: 4 });
		expect(clampTerminalSize(999, 999)).toEqual({ cols: 400, rows: 150 });
		expect(clampTerminalSize(80.6, 24.4)).toEqual({ cols: 81, rows: 24 });
		expect(clampTerminalSize(Number.NaN, Number.POSITIVE_INFINITY)).toEqual({ cols: 80, rows: 24 });

		expect(shortShellName("/bin/bash")).toBe("bash");
		expect(shortShellName("/usr/local/bin/zsh/")).toBe("zsh");
		expect(shortShellName("C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe")).toBe("powershell");
		expect(shortShellName("C:\\Windows\\System32\\cmd.exe")).toBe("cmd");
	});

	test("shouldTerminalAllowShellCommand allows only shell-escape commands while preserving shell control keys", () => {
		for (const allowed of [
			"terminal",
			"terminal-new",
			"terminal-find",
			"toggle-panel",
			"toggle-panel-maximize",
			"command-palette",
			"zoom-in",
			"zoom-out",
			"zoom-reset",
		]) {
			expect(shouldTerminalAllowShellCommand(allowed), allowed).toBe(true);
		}
		for (const shellOwned of [undefined, "save", "close", "search", "explorer", "problems", "output", "copy-designer", "format", "toggle-sidebar"]) {
			expect(shouldTerminalAllowShellCommand(shellOwned), String(shellOwned)).toBe(false);
		}
	});

	test("buildXtermTheme meets WCAG AA contrast across all 27 built-in themes", () => {
		const allThemes = [
			...allOklchThemes().map((t) => ({
				name: t.name,
				tokens: {
					panelBg: t.studio.panelBg,
					fg: t.studio.fg,
					strongFg: t.studio.strongFg,
					muted: t.studio.muted,
					accent: t.studio.accent,
					selected: t.studio.selected,
					error: t.studio.error,
					warning: t.studio.warning,
					info: t.studio.info,
					ok: t.studio.ok,
				},
			})),
			...(
				[
					["classic-dark", darkClassic],
					["classic-light", lightClassic],
				] as const
			).map(([name, t]) => ({
				name,
				tokens: {
					panelBg: t.colors["panel.background"] ?? t.colors["sideBar.background"]!,
					fg: t.colors["sideBar.foreground"]!,
					strongFg: t.colors["tab.activeForeground"]!,
					muted: t.colors["descriptionForeground"]!,
					accent: t.colors["focusBorder"]!,
					selected: t.colors["list.activeSelectionBackground"]!,
					error: t.colors["editorError.foreground"]!,
					warning: t.colors["editorWarning.foreground"]!,
					info: t.colors["editorInfo.foreground"] ?? t.colors["focusBorder"]!,
					ok: t.colors["testing.iconPassed"]!,
				},
			})),
		];
		expect(allThemes.length).toBe(27);

		for (const { name, tokens } of allThemes) {
			const pal = buildXtermTheme(tokens);
			const bg = pal.background;
			for (const key of [
				"foreground",
				"red",
				"green",
				"yellow",
				"blue",
				"magenta",
				"cyan",
				"brightBlack",
				"brightRed",
				"brightGreen",
				"brightYellow",
				"brightBlue",
				"brightMagenta",
				"brightCyan",
			] as const) {
				expect(contrast(pal[key], bg), `${name} xterm.${key}`).toBeGreaterThanOrEqual(TEXT);
			}
			expect(contrast(pal.cursor, bg), `${name} xterm.cursor`).toBeGreaterThanOrEqual(BOUNDARY);
			expect(
				contrast(tokens.strongFg, mixSrgb(tokens.warning, 16, tokens.panelBg)),
				`${name} term-tab-exit badge`,
			).toBeGreaterThanOrEqual(TEXT);
		}
	});
});

describe("Integrated Terminal — real backend PTY lifecycle & UI wiring", () => {
	test("detectShellProfiles finds host shells and TerminalManager runs interactive I/O, resize, and clean exit", async () => {
		const profiles = detectShellProfiles();
		expect(profiles.length).toBeGreaterThanOrEqual(1);
		expect(profiles.some((p) => p.isDefault)).toBe(true);

		let output = "";
		let exitedCode: number | null | undefined;
		const manager = new TerminalManager({
			onData: (_id, data) => {
				output += data;
			},
			onExit: (_id, code) => {
				exitedCode = code;
			},
		});

		try {
			const created = manager.create({ cols: 80, rows: 24 }, process.cwd());
			expect(created.alive).toBe(true);
			expect(manager.list().length).toBe(1);

			manager.resize(created.id, 102, 29);
			const marker = "SSL_STUDIO_TERM_PROBE_42";
			if (process.platform === "win32") {
				manager.write(created.id, `echo ${marker}\r\nexit 0\r\n`);
			} else {
				manager.write(created.id, `stty size 2>/dev/null; echo ${marker}; exit 0\r`);
			}

			for (let i = 0; i < 80 && exitedCode === undefined; i++) {
				await Bun.sleep(50);
			}
			expect(exitedCode).toBe(0);
			expect(output).toContain(marker);
			if (created.pty) {
				expect(output).toContain("29 102");
			}
		} finally {
			manager.disposeAll();
		}
	});

	test("TerminalManager.kill terminates an active shell cleanly", async () => {
		const manager = new TerminalManager({ onData: () => {}, onExit: () => {} });
		try {
			const created = manager.create({ cols: 80, rows: 24 }, process.cwd());
			expect(manager.list().length).toBe(1);
			manager.kill(created.id);
			expect(manager.list().length).toBe(0);
		} finally {
			manager.disposeAll();
		}
	});

	test("Terminal panel controls, shortcuts, menu entries, and backend teardown are wired cleanly", () => {
		const termSrc = repoRead("src/view/panels/Terminal.tsx");
		expect(termSrc).toContain('data-terminal-new="true"');
		expect(termSrc).toContain('data-terminal-kill="true"');
		expect(termSrc).toContain('data-terminal-clear="true"');
		expect(termSrc).toContain("FitAddon");
		expect(termSrc).toContain("SearchAddon");
		expect(termSrc).toContain("WebLinksAddon");
		// Never statically import ../commands from a panel (circular import guard)
		expect(termSrc).not.toMatch(/^\s*import\s+[^;]*from\s+["']\.\.\/commands["']/m);

		const appSrc = repoRead("src/view/App.tsx");
		expect(appSrc).toContain("<TerminalHeaderActions />");
		expect(appSrc).toContain('state.bottomView === "terminal"');

		const cmdSrc = repoRead("src/view/commands.ts");
		expect(cmdSrc).toContain('"ctrl+`": "terminal"');
		expect(cmdSrc).toContain("shouldTerminalAllowShellCommand");

		const menuSrc = repoRead("src/shared/menuBar.ts");
		expect(menuSrc).toContain('forFolder("Terminal", "terminal")');

		const backendSrc = repoRead("src/bun/backend.ts");
		expect(backendSrc).toContain("terminals.disposeAll()");
	});
});
