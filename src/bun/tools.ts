// Finding the external tools: starlims-lsp (pinned, ADR 0003) and opencode
// (a supported range, ADR 0004).
import { accessSync, constants, existsSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";
import type { ToolStatus } from "../shared/protocol";

export const LSP_PIN = "0.31.0";
export const OPENCODE_RANGE = { min: "2.2.5", below: "2.4.0" };

async function run(cmd: string[]): Promise<string | null> {
	try {
		const proc = Bun.spawn(cmd, { stdout: "pipe", stderr: "ignore", windowsVerbatimArguments: verbatim(cmd) });
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
			}, 5000);
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

function parseVersion(value: string): number[] | null {
	const trimmed = value.trim();
	if (!trimmed) return null;
	const parts = trimmed.split(".");
	if (parts.some((p) => !/^\d+$/.test(p))) return null;
	const nums = parts.map(Number);
	if (nums.some((n) => !Number.isSafeInteger(n))) return null;
	return nums;
}

export function compareVersions(a: string, b: string): number {
	const pa = parseVersion(a);
	const pb = parseVersion(b);
	if (!pa || !pb) return Number.NaN;
	const len = Math.max(3, pa.length, pb.length);
	for (let i = 0; i < len; i++) {
		const da = pa[i] ?? 0;
		const db = pb[i] ?? 0;
		if (da !== db) return da - db;
	}
	return 0;
}

export function lspCandidates(configured?: string): string[] {
	const home = homedir();
	const arch = process.arch === "arm64" ? "arm64" : "amd64";
	const platform = process.platform === "win32" ? "windows" : process.platform;
	const suffix = process.platform === "win32" ? ".exe" : "";
	// A build may carry its own copy (scripts/bundle-lsp.ts): app/bin, beside app/bun, or vendor/ in dev.
	const bundled = resolve(import.meta.dir, "..", "bin", `starlims-lsp${suffix}`);
	const vendored = resolve(import.meta.dir, "..", "..", "vendor", `starlims-lsp${suffix}`);
	return [
		configured,
		process.env.STARLIMS_LSP,
		bundled,
		vendored,
		...(process.env.PATH ?? "").split(delimiter).filter(Boolean).map((dir) => join(dir, `starlims-lsp${suffix}`)),
		`${home}/dev/starlims-projects/starlims-lsp/starlims-lsp-${platform}-${arch}${suffix}`,
		`${home}/dev/starlims-projects/ssl-style-guide/ssl-mcp-server/bin/lsp/starlims-lsp-${platform}-${arch}${suffix}`,
	].filter((p): p is string => Boolean(p));
}

/** What cmd.exe reads as more than part of a word when it stands outside quotes: the space that ends the word, and cmd's own signs. */
const CMD_SPECIAL = /[\s&|<>()^,;="]/;

/** One word of a cmd.exe command line: in quotes where cmd would read something into it. A quote in it is doubled, so every sign stays between two quotes. */
const cmdWord = (word: string) => (word !== "" && !CMD_SPECIAL.test(word) ? word : `"${word.replace(/"/g, '""')}"`);

/**
 * The command that runs a `.cmd` or `.bat` file with these arguments. Windows starts one only through cmd.exe, and
 * with `/s` cmd takes the first and the last quote off what follows `/c`. Each word used to be given to cmd on its
 * own, so a path with a space in it reached cmd as `"C:\Users\First Last\opencode.cmd" --version`, lost its two
 * quotes, and `C:\Users\First` was run: the npm shim of opencode in such a home folder was never found.
 *
 * So where a word needs quotes, the whole line is written here as cmd is to read it, in a pair of quotes of its own
 * for `/s` to take off (`cmd.exe /d /s /c ""C:\a b\x.cmd" --version"`), and the process must be started with
 * that line as it is written: `windowsVerbatimArguments: verbatim(command)`. Bun's own quoting would put a
 * backslash before each quote. Arguments added after such a command go after its last quote and must be plain words.
 * Where no word needs quotes the command is the words, as before, and is the same line however it is started.
 *
 * A quote cannot be in a Windows path and is dropped from it. A `%NAME%` is still filled in by cmd, quotes or not.
 */
export function shimCommand(path: string, args: string[] = []): string[] {
	const words = [path.replace(/"/g, ""), ...args];
	if (!words.some((word) => word === "" || CMD_SPECIAL.test(word))) return ["cmd.exe", "/d", "/s", "/c", ...words];
	return ["cmd.exe", "/d", "/s", "/c", `"${words.map(cmdWord).join(" ")}"`];
}

/** True for a command that is a line written out for cmd.exe (`shimCommand`): on Windows it is passed as written. */
export function verbatim(command: readonly string[], platform: string = process.platform): boolean {
	return platform === "win32" && /^cmd(?:\.exe)?$/i.test(command[0] ?? "") && command[3] === "/c" && Boolean(command[4]?.startsWith('"'));
}

/** Builds the argv to invoke `starlims-lsp`, wrapping `.cmd`/`.bat` shims via `cmd.exe` on Windows. */
export function lspCommand(path: string, args: string[], platform: string = process.platform): string[] {
	if (platform === "win32" && /\.(cmd|bat)$/i.test(path)) return shimCommand(path, args);
	return [path, ...args];
}

/**
 * Whether what is at `path` is a program this user can start: a file, and outside Windows one with its execute bit.
 * A candidate that is not is passed over before anything is started. That it was passed over at all used to rest on
 * the start failing: a vendor/starlims-lsp left without the bit by a download that broke off was tried each time.
 */
export function runnable(path: string, platform: string = process.platform): boolean {
	try {
		if (!statSync(path).isFile()) return false;
		if (platform !== "win32") accessSync(path, constants.X_OK);
		return true;
	} catch {
		return false;
	}
}

export async function findLsp(configured?: string): Promise<ToolStatus> {
	for (const path of lspCandidates(configured)) {
		if (!runnable(path)) continue;
		const out = await run(lspCommand(path, ["--version"]));
		// A developer build says "version dev": usable, with the pin warning.
		const version = out && /starlims-lsp version (\S+)/.exec(out)?.[1];
		if (!version) continue;
		const message =
			version === LSP_PIN ? undefined : `Language server ${version} found; SSL Studio is tested with ${LSP_PIN}.`;
		return { ok: true, version, path, message };
	}
	return {
		ok: false,
		message: `The language server (starlims-lsp) was not found. Install ${LSP_PIN} from github.com/mahoskye/starlims-lsp/releases and put it on PATH, or give its path in Settings under "Language server program".`,
	};
}

/**
 * The command that runs opencode. On Windows npm installs a `.cmd` shim, which
 * a process cannot be spawned from directly; the shim sits beside the real
 * binary's package, so use that, else go through cmd.exe.
 */
export function opencodeCommand(args: string[] = []): string[] {
	const found = Bun.which("opencode");
	if (!found || process.platform !== "win32" || !/\.(cmd|bat)$/i.test(found)) return [found ?? "opencode", ...args];
	const exe = join(dirname(found), "node_modules", "@opencode", "cli", "bin", "opencode.exe");
	return existsSync(exe) ? [exe, ...args] : shimCommand(found, args);
}

export async function findOpencode(): Promise<ToolStatus> {
	const out = await run(opencodeCommand(["--version"]));
	const version = out && /(\d+\.\d+\.\d+)/.exec(out)?.[1];
	if (!version) return { ok: false, message: "opencode not found on PATH: the Agent panel is off." };
	const inRange = compareVersions(version, OPENCODE_RANGE.min) >= 0 && compareVersions(version, OPENCODE_RANGE.below) < 0;
	return {
		ok: inRange,
		version,
		message: inRange ? undefined : `opencode ${version} is outside the supported range ${OPENCODE_RANGE.min} to below ${OPENCODE_RANGE.below}.`,
	};
}
