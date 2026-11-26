// Puts the pinned starlims-lsp into vendor/, so `hutch run build` ships it
// inside the app (electrobun.config.ts copies it to app/bin). Uses a local
// copy of the pinned version when one is found; with --download, fetches the
// release asset for this platform (mahoskye/starlims-lsp, public).
//
//   bun scripts/bundle-lsp.ts [--download]
import { $ } from "bun";
import { homedir } from "node:os";
import { chmodSync, copyFileSync, existsSync, mkdirSync, rmSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { renameReplacing } from "../src/bun/atomic";
import { findLsp, LSP_PIN, lspCandidates } from "../src/bun/tools";

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
	/** The other places a local copy may be in, asked in order when what `findLocal` gives is not the pinned version. */
	candidates?: () => string[];
	/** Writes what is at `url` into the file at `path`. */
	fetchTo?: (url: string, path: string) => Promise<void>;
};

/** A file written beside where it goes, and a copy of what was there, kept until all of them are in place. */
const staged = (path: string) => `${path}.new`;
const kept = (path: string) => `${path}.old`;

/** What putting files in place does to the disk: given, so that the order of it can be tested without one. */
export type PlaceOps = {
	exists: (path: string) => boolean;
	copy: (from: string, to: string) => void;
	/** Moves a file to where another may be, in its place. */
	move: (from: string, to: string) => Promise<void>;
	remove: (path: string) => void;
};

/**
 * Puts staged files in place in the order given, which is the binary first: all of them, or none. The licence
 * files used to go first. On Windows a binary that is running (an open SSL Studio) cannot be replaced, so the
 * move of the binary failed with the new licence files already beside the old binary, and the notices described
 * a version that was not there. Now the binary that cannot be replaced fails before anything has changed. A file
 * that cannot be moved after others were is rarer, and those are put back from a copy taken of each before its
 * move. Where that fails too, the error names the files left new: what was there is beside each, as `.old`.
 */
export async function putInPlace(paths: string[], ops: PlaceOps): Promise<void> {
	const moved: { path: string; had: boolean }[] = [];
	const stuck: string[] = [];
	try {
		for (const path of paths) {
			const had = ops.exists(path);
			try {
				if (had) ops.copy(path, kept(path));
				await ops.move(staged(path), path);
			} catch (err: any) {
				for (const before of moved.reverse()) {
					try {
						if (before.had) await ops.move(kept(before.path), before.path);
						else ops.remove(before.path);
					} catch {
						stuck.push(before.path);
					}
				}
				const state = stuck.length ? `Already in place and not put back: ${stuck.join(", ")} (what was there before is beside each, as .old).` : "The folder is as it was.";
				throw new Error(`Could not put ${path} in place: ${String(err?.message ?? err)}. ${state}`, { cause: err });
			}
			moved.push({ path, had });
		}
	} finally {
		for (const path of paths) {
			if (stuck.includes(path)) continue;
			try {
				ops.remove(kept(path));
			} catch {
				// Best-effort cleanup of the copies.
			}
		}
	}
}

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
	// The binary and its two licence files are written beside where they go and put in place when all of them are
	// there, the binary first (`putInPlace`). A download used to write the binary where it goes before the licence
	// files had come: when one then failed to arrive, vendor/ was left with a binary that could not be started and
	// had no licence beside it. Beside the old one and renamed over it also because a server that is running (an
	// open SSL Studio) keeps its own copy, where writing into the file in use fails.
	const place: PlaceOps = {
		exists: existsSync,
		copy: copyFileSync,
		move: (from, to) => renameReplacing(from, to, { win32: platformName === "win32" }),
		remove: (path) => rmSync(path, { force: true }),
	};
	const discardStaged = () => {
		for (const path of [target, licensePath, noticesPath]) {
			try {
				rmSync(staged(path), { force: true });
			} catch {
				// Best-effort cleanup of what was staged.
			}
		}
	};

	let action: "downloaded" | "cached" | "copied";
	let vendored: string | undefined;
	if (opts.download) {
		const platform = platformName === "win32" ? "windows" : platformName;
		const arch = (opts.arch ?? process.arch) === "arm64" ? "arm64" : "amd64";
		const asset = `starlims-lsp-${platform}-${arch}${suffix}`;
		// The release is public: plain HTTPS works where gh is not installed (a fresh Windows VM).
		const release = `https://github.com/mahoskye/starlims-lsp/releases/download/v${LSP_PIN}`;
		const fetchTo =
			opts.fetchTo ??
			(async (url: string, path: string) => {
				const response = await fetch(url, { signal: AbortSignal.timeout(120_000) });
				if (!response.ok) throw new Error(`${url}: ${response.status}`);
				await Bun.write(path, response);
			});
		try {
			await fetchTo(`${release}/${asset}`, staged(target));
			await fetchTo(`${release}/THIRD-PARTY-NOTICES.md`, staged(noticesPath));
			await fetchTo(`https://raw.githubusercontent.com/mahoskye/starlims-lsp/v${LSP_PIN}/LICENSE`, staged(licensePath));
			for (const path of [target, noticesPath, licensePath]) {
				if (!existsSync(staged(path)) || !statSync(staged(path)).size) throw new Error(`Nothing arrived for ${path}.`);
			}
			chmodSync(staged(target), 0o755);
			await putInPlace([target, licensePath, noticesPath], place);
		} catch (err) {
			discardStaged();
			throw err;
		}
		action = "downloaded";
	} else if ((vendored = await getVersion(target)) === LSP_PIN && existsSync(licensePath) && existsSync(noticesPath)) {
		// Already here, from an earlier --download (CI and the Windows VM do that first).
		action = "cached";
	} else {
		const found = await findLocal();
		// vendor/'s own copy will do when it is the pinned version and only its licence files are wanting.
		let source = found.ok && found.version === LSP_PIN ? found.path : vendored === LSP_PIN ? target : undefined;
		if (!source) {
			// What is found first may be vendor/'s own copy, of an earlier pin: the search for a language server looks
			// there before PATH. That used to end this one ("No local starlims-lsp"), and the old binary stayed where it
			// was, with the pinned version one folder further on. The other places are asked for their version too.
			for (const path of (opts.candidates ?? lspCandidates)()) {
				if (sameResolvedPath(path, target) || (found.path && sameResolvedPath(path, found.path))) continue;
				if ((await getVersion(path)) === LSP_PIN) {
					source = path;
					break;
				}
			}
		}
		if (!source) throw new Error(`No local starlims-lsp ${LSP_PIN} (found: ${found.version ?? "none"}). Use --download.`);
		if (platformName === "win32" && /\.(cmd|bat)$/i.test(source)) {
			throw new Error(`Cannot bundle batch shim "${source}" as ${target}. Point STARLIMS_LSP at the real starlims-lsp.exe binary or use --download.`);
		}
		// Its license and notices travel with it.
		const repo = opts.repoDir ?? process.env.STARLIMS_LSP_REPO ?? `${homedir()}/dev/starlims-projects/starlims-lsp`;
		try {
			const arriving: string[] = [];
			for (const [file, dest] of [
				["LICENSE", licensePath],
				["THIRD-PARTY-NOTICES.md", noticesPath],
			] as const) {
				const src = join(repo, file);
				if (!existsSync(src) || sameResolvedPath(src, dest)) continue;
				copyFileSync(src, staged(dest));
				arriving.push(dest);
			}
			const missing = [licensePath, noticesPath].filter((path) => !arriving.includes(path) && !existsSync(path));
			if (missing.length) {
				throw new Error(`Missing required ${missing.join(", ")} for the local starlims-lsp (looked in ${repo}). Set STARLIMS_LSP_REPO or use --download.`);
			}
			// Nothing to copy when the pinned version found is vendor/starlims-lsp itself.
			if (!sameResolvedPath(source, target)) {
				copyFileSync(source, staged(target));
				chmodSync(staged(target), 0o755);
				// Before its licence files: the one of the three that may not be replaceable.
				arriving.unshift(target);
			}
			await putInPlace(arriving, place);
		} catch (err) {
			discardStaged();
			throw err;
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
