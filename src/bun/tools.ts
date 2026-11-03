// Finding the external tools: starlims-lsp (pinned, ADR 0003) and opencode
// (a supported range, ADR 0004).
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";
import type { ToolStatus } from "../shared/protocol";

export const LSP_PIN = "0.29.0";
export const OPENCODE_RANGE = { min: "2.2.5", below: "2.3.0" };

async function run(cmd: string[]): Promise<string | null> {
	try {
		const proc = Bun.spawn(cmd, { stdout: "pipe", stderr: "pipe" });
		const timer = setTimeout(() => proc.kill(), 5000);
		const out = await new Response(proc.stdout).text();
		clearTimeout(timer);
		return (await proc.exited) === 0 ? out : null;
	} catch {
		return null;
	}
}

export function compareVersions(a: string, b: string): number {
	const pa = a.split(".").map(Number);
	const pb = b.split(".").map(Number);
	for (let i = 0; i < 3; i++) if ((pa[i] ?? 0) !== (pb[i] ?? 0)) return (pa[i] ?? 0) - (pb[i] ?? 0);
	return 0;
}

export function lspCandidates(configured?: string): string[] {
	const home = homedir();
	const arch = process.arch === "arm64" ? "arm64" : "amd64";
	const platform = process.platform === "win32" ? "windows" : process.platform;
	const suffix = process.platform === "win32" ? ".exe" : "";
	// A build may carry its own copy (scripts/bundle-lsp.ts): app/bin, beside app/bun.
	const bundled = resolve(import.meta.dir, "..", "bin", `starlims-lsp${suffix}`);
	return [
		configured,
		process.env.STARLIMS_LSP,
		bundled,
		...(process.env.PATH ?? "").split(delimiter).filter(Boolean).map((dir) => join(dir, `starlims-lsp${suffix}`)),
		`${home}/dev/starlims-projects/starlims-lsp/starlims-lsp-${platform}-${arch}${suffix}`,
		`${home}/dev/starlims-projects/ssl-style-guide/ssl-mcp-server/bin/lsp/starlims-lsp-${platform}-${arch}${suffix}`,
	].filter((p): p is string => Boolean(p));
}

export async function findLsp(configured?: string): Promise<ToolStatus> {
	for (const path of lspCandidates(configured)) {
		if (!existsSync(path)) continue;
		const out = await run([path, "--version"]);
		// A developer build says "version dev": usable, with the pin warning.
		const version = out && /starlims-lsp version (\S+)/.exec(out)?.[1];
		if (!version) continue;
		const message =
			version === LSP_PIN ? undefined : `starlims-lsp ${version} found; SSL Studio is tested with ${LSP_PIN}.`;
		return { ok: true, version, path, message };
	}
	return {
		ok: false,
		message: `starlims-lsp not found. Install ${LSP_PIN} from github.com/mahoskye/starlims-lsp/releases, put it on PATH or set "lspPath".`,
	};
}

/**
 * The command that runs opencode. On Windows npm installs a `.cmd` shim, which
 * a process cannot be spawned from directly; the shim sits beside the real
 * binary's package, so use that, else go through cmd.exe.
 */
export function opencodeCommand(): string[] {
	const found = Bun.which("opencode");
	if (!found || process.platform !== "win32" || !/\.(cmd|bat)$/i.test(found)) return [found ?? "opencode"];
	const exe = join(dirname(found), "node_modules", "@opencode", "cli", "bin", "opencode.exe");
	return existsSync(exe) ? [exe] : ["cmd.exe", "/d", "/s", "/c", found];
}

export async function findOpencode(): Promise<ToolStatus> {
	const out = await run([...opencodeCommand(), "--version"]);
	const version = out && /(\d+\.\d+\.\d+)/.exec(out)?.[1];
	if (!version) return { ok: false, message: "opencode not found on PATH: the Agent panel is off." };
	const inRange = compareVersions(version, OPENCODE_RANGE.min) >= 0 && compareVersions(version, OPENCODE_RANGE.below) < 0;
	return {
		ok: inRange,
		version,
		message: inRange ? undefined : `opencode ${version} is outside the supported range ${OPENCODE_RANGE.min} to below ${OPENCODE_RANGE.below}.`,
	};
}
