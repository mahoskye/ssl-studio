// Puts the pinned starlims-lsp into vendor/, so `hutch run build` ships it
// inside the app (electrobun.config.ts copies it to app/bin). Uses a local
// copy of the pinned version when one is found; with --download, fetches the
// release asset for this platform (mahoskye/starlims-lsp, public).
//
//   bun scripts/bundle-lsp.ts [--download]
import { $ } from "bun";
import { homedir } from "node:os";
import { chmodSync, copyFileSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { findLsp, LSP_PIN } from "../src/bun/tools";

const vendor = join(import.meta.dir, "../vendor");
const suffix = process.platform === "win32" ? ".exe" : "";
const target = join(vendor, `starlims-lsp${suffix}`);
mkdirSync(vendor, { recursive: true });

async function versionOf(path: string) {
	if (!existsSync(path)) return undefined;
	const out = await $`${path} --version`.nothrow().quiet().text();
	return /starlims-lsp version (\S+)/.exec(out)?.[1];
}

if (process.argv.includes("--download")) {
	const platform = process.platform === "win32" ? "windows" : process.platform;
	const arch = process.arch === "arm64" ? "arm64" : "amd64";
	const asset = `starlims-lsp-${platform}-${arch}${suffix}`;
	// The release is public: plain HTTPS works where gh is not installed (a fresh Windows VM).
	const release = `https://github.com/mahoskye/starlims-lsp/releases/download/v${LSP_PIN}`;
	const fetchTo = async (url: string, path: string) => {
		const response = await fetch(url, { signal: AbortSignal.timeout(120_000) });
		if (!response.ok) throw new Error(`${url}: ${response.status}`);
		await Bun.write(path, response);
	};
	await fetchTo(`${release}/${asset}`, target);
	await fetchTo(`${release}/THIRD-PARTY-NOTICES.md`, join(vendor, "THIRD-PARTY-NOTICES.md"));
	await fetchTo(`https://raw.githubusercontent.com/mahoskye/starlims-lsp/v${LSP_PIN}/LICENSE`, join(vendor, "STARLIMS-LSP-LICENSE"));
} else if ((await versionOf(target)) === LSP_PIN && existsSync(join(vendor, "STARLIMS-LSP-LICENSE"))) {
	// Already here, from an earlier --download (CI and the Windows VM do that first).
} else {
	const found = await findLsp();
	if (!found.ok || found.version !== LSP_PIN) throw new Error(`No local starlims-lsp ${LSP_PIN} (found: ${found.version ?? "none"}). Use --download.`);
	copyFileSync(found.path!, target);
	// Its license and notices travel with it.
	const repo = process.env.STARLIMS_LSP_REPO ?? `${homedir()}/dev/starlims-projects/starlims-lsp`;
	for (const file of ["LICENSE", "THIRD-PARTY-NOTICES.md"]) if (existsSync(join(repo, file))) copyFileSync(join(repo, file), join(vendor, file === "LICENSE" ? "STARLIMS-LSP-LICENSE" : file));
}
chmodSync(target, 0o755);
console.log(`vendor/starlims-lsp${suffix}: ${(await $`${target} --version`.text()).split("\n")[0]}`);
