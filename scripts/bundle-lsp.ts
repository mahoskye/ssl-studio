// Puts the pinned starlims-lsp into vendor/, so `hutch run build` ships it
// inside the app (electrobun.config.ts copies it to app/bin). Uses a local
// copy of the pinned version when one is found; with --download, fetches the
// release asset for this platform (mahoskye/starlims-lsp, public).
//
//   bun scripts/bundle-lsp.ts [--download]
import { $ } from "bun";
import { homedir } from "node:os";
import { chmodSync, copyFileSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { renameReplacing } from "../src/bun/atomic";
import { findLsp, LSP_PIN } from "../src/bun/tools";

export async function versionOf(path: string): Promise<string | undefined> {
	if (!existsSync(path)) return undefined;
	const out = await $`${path} --version`.nothrow().quiet().text();
	return /starlims-lsp version (\S+)/.exec(out)?.[1];
}

export type BundleLspOptions = {
	vendorDir?: string;
	download?: boolean;
	repoDir?: string;
	platform?: NodeJS.Platform;
	arch?: string;
	findLocal?: typeof findLsp;
	getVersion?: (path: string) => Promise<string | undefined>;
};

export async function bundleLsp(opts: BundleLspOptions = {}): Promise<{ target: string; action: "downloaded" | "cached" | "copied" }> {
	const vendor = opts.vendorDir ?? join(import.meta.dir, "../vendor");
	const platformName = opts.platform ?? process.platform;
	const suffix = platformName === "win32" ? ".exe" : "";
	const target = join(vendor, `starlims-lsp${suffix}`);
	const licensePath = join(vendor, "STARLIMS-LSP-LICENSE");
	const noticesPath = join(vendor, "THIRD-PARTY-NOTICES.md");
	const getVersion = opts.getVersion ?? versionOf;
	const findLocal = opts.findLocal ?? findLsp;
	mkdirSync(vendor, { recursive: true });

	const sameResolvedPath = (a: string, b: string) => {
		const ra = resolve(a);
		const rb = resolve(b);
		return platformName === "win32" || platformName === "darwin" ? ra.toLowerCase() === rb.toLowerCase() : ra === rb;
	};
	const stageTarget = async (writeTemp: (tempPath: string) => Promise<void> | void) => {
		const temp = `${target}.new`;
		try {
			await writeTemp(temp);
			await renameReplacing(temp, target, { win32: platformName === "win32" });
		} catch (err) {
			try {
				rmSync(temp, { force: true });
			} catch {
				// Best-effort cleanup of temp file.
			}
			throw err;
		}
	};

	let action: "downloaded" | "cached" | "copied";
	if (opts.download) {
		const platform = platformName === "win32" ? "windows" : platformName;
		const arch = (opts.arch ?? process.arch) === "arm64" ? "arm64" : "amd64";
		const asset = `starlims-lsp-${platform}-${arch}${suffix}`;
		// The release is public: plain HTTPS works where gh is not installed (a fresh Windows VM).
		const release = `https://github.com/mahoskye/starlims-lsp/releases/download/v${LSP_PIN}`;
		const fetchTo = async (url: string, path: string) => {
			const response = await fetch(url, { signal: AbortSignal.timeout(120_000) });
			if (!response.ok) throw new Error(`${url}: ${response.status}`);
			await Bun.write(path, response);
		};
		// Beside the old one, then renamed over it: a server that is running (an open
		// SSL Studio) keeps its own copy, where writing into the file in use fails.
		await stageTarget((temp) => fetchTo(`${release}/${asset}`, temp));
		await fetchTo(`${release}/THIRD-PARTY-NOTICES.md`, noticesPath);
		await fetchTo(`https://raw.githubusercontent.com/mahoskye/starlims-lsp/v${LSP_PIN}/LICENSE`, licensePath);
		action = "downloaded";
	} else if ((await getVersion(target)) === LSP_PIN && existsSync(licensePath) && existsSync(noticesPath)) {
		// Already here, from an earlier --download (CI and the Windows VM do that first).
		action = "cached";
	} else {
		const found = await findLocal();
		if (!found.ok || found.version !== LSP_PIN) throw new Error(`No local starlims-lsp ${LSP_PIN} (found: ${found.version ?? "none"}). Use --download.`);
		if (platformName === "win32" && /\.(cmd|bat)$/i.test(found.path!)) {
			throw new Error(`Cannot bundle batch shim "${found.path}" as ${target}. Point STARLIMS_LSP at the real starlims-lsp.exe binary or use --download.`);
		}
		// Skip copying when findLocal() resolved to vendor/starlims-lsp itself; otherwise stage atomically.
		if (!sameResolvedPath(found.path!, target)) {
			await stageTarget((temp) => {
				copyFileSync(found.path!, temp);
			});
		}
		// Its license and notices travel with it.
		const repo = opts.repoDir ?? process.env.STARLIMS_LSP_REPO ?? `${homedir()}/dev/starlims-projects/starlims-lsp`;
		for (const file of ["LICENSE", "THIRD-PARTY-NOTICES.md"]) {
			const src = join(repo, file);
			const dest = file === "LICENSE" ? licensePath : noticesPath;
			if (existsSync(src) && !sameResolvedPath(src, dest)) copyFileSync(src, dest);
		}
		if (!existsSync(licensePath) || !existsSync(noticesPath)) {
			const missing = [!existsSync(licensePath) && licensePath, !existsSync(noticesPath) && noticesPath].filter(Boolean).join(", ");
			throw new Error(`Missing required ${missing} after bundling local starlims-lsp (looked in ${repo}). Set STARLIMS_LSP_REPO or use --download.`);
		}
		action = "copied";
	}
	chmodSync(target, 0o755);
	return { target, action };
}

if (import.meta.main) {
	const { target } = await bundleLsp({ download: process.argv.includes("--download") });
	const suffix = process.platform === "win32" ? ".exe" : "";
	console.log(`vendor/starlims-lsp${suffix}: ${(await $`${target} --version`.text()).split("\n")[0]}`);
}
