// Writes src/view/public/THIRD-PARTY-NOTICES.md: the license texts of the
// packages, files and runtime the app ships, so every build carries them.
import { existsSync, readdirSync, realpathSync } from "node:fs";
import { dirname, join } from "node:path";

const root = join(import.meta.dir, "..");

/**
 * Build tools that are not dependencies of the app but leave small runtime helpers of their own in the bundle.
 */
const BUILD_HELPERS = ["vite", "rolldown"];

export type ShippedPackage = { name: string; version: string; license: string | undefined; dir: string };

/**
 * The packages the app ships: every dependency in package.json and everything those depend on, wherever it is
 * installed (a package can be there twice, at two versions, one nested under the package that asked for the older
 * one), and the build helpers. Worked out from what is installed, not kept by hand: a list kept by hand named 51
 * packages while the bundle held code from well over a hundred, among them ones with their own copyright holders.
 * It errs on the side of naming a package: one whose code the bundler ends up leaving out is still listed.
 * Left out are `@types/*`, which are declarations and hold no code that could be shipped.
 */
export async function shippedPackages(rootDir = root): Promise<ShippedPackage[]> {
	const found = new Map<string, ShippedPackage>();
	const top = realpathSync(rootDir);
	/** As the runtime finds a package: in the asking package's own node_modules, then in each folder's above it. */
	const locate = (from: string, name: string): string | null => {
		for (let dir = from; ; dir = dirname(dir)) {
			const candidate = join(dir, "node_modules", name);
			if (existsSync(join(candidate, "package.json"))) return realpathSync(candidate);
			if (dir === top || dirname(dir) === dir) return null;
		}
	};
	const visit = async (dir: string, names: string[], required: Set<string>, asker: string, deeper = true) => {
		for (const name of names) {
			if (name.startsWith("@types/")) continue;
			const at = locate(dir, name);
			if (!at) {
				if (required.has(name)) throw new Error(`"${name}", which ${asker} depends on, is not installed: run the install first.`);
				continue;
			}
			if (found.has(at)) continue;
			const pkg = await Bun.file(join(at, "package.json")).json();
			const license = typeof pkg.license === "string" ? pkg.license : typeof pkg.license?.type === "string" ? pkg.license.type : undefined;
			found.set(at, { name, version: String(pkg.version), license, dir: at });
			if (!deeper) continue;
			const needs = Object.keys(pkg.dependencies ?? {});
			await visit(at, [...needs, ...Object.keys(pkg.optionalDependencies ?? {})], new Set(needs), name);
		}
	};
	const own = await Bun.file(join(top, "package.json")).json();
	const direct = Object.keys(own.dependencies ?? {});
	await visit(top, direct, new Set(direct), "the app");
	// The helpers' own dependencies are build-time only: what they leave in the bundle is their own code.
	await visit(top, BUILD_HELPERS, new Set(BUILD_HELPERS), "the build", false);
	// One section for a package at a version, however many copies of it are installed.
	const byId = new Map<string, ShippedPackage>();
	for (const pkg of found.values()) if (!byId.has(`${pkg.name}@${pkg.version}`)) byId.set(`${pkg.name}@${pkg.version}`, pkg);
	return [...byId.values()].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : a.version.localeCompare(b.version, undefined, { numeric: true })));
}

export const NOTICE_FILENAMES = [
	"LICENSE",
	"LICENSE.md",
	"LICENSE.txt",
	"NOTICE",
	"NOTICES.txt",
	"ThirdPartyNotices.txt",
	"THIRD-PARTY-LICENSE",
	"THIRD-PARTY-NOTICES.md",
] as const;
/** Other spellings packages use for the same files: LICENCE, LICENSE-MIT, LICENSE-MPL, COPYING, UNLICENSE. Never code. */
const NOTICE_PATTERN = /^(?:licen[cs]e|notice|copying|unlicense)(?:[-_.][a-z0-9-]+)*$/i;
const NOT_A_NOTICE = /\.(?:[cm]?[jt]sx?|json|ya?ml|html?|css|map)$/i;
export const isNoticeFile = (file: string) =>
	(NOTICE_FILENAMES as readonly string[]).some((name) => name.toLowerCase() === file.toLowerCase()) || (NOTICE_PATTERN.test(file) && !NOT_A_NOTICE.test(file));

/** Licenses that ask for nothing to be reproduced: a package under one of these may ship no license file at all. */
const NOTHING_TO_REPRODUCE = new Set(["CC0-1.0", "Unlicense", "0BSD", "WTFPL"]);

export const FALLBACK_LICENSE: Record<string, string> = {
	"solid-js": "third-party/solid-MIT-LICENSE",
	"@solidjs/web": "third-party/solid-MIT-LICENSE",
};
const FALLBACK_SPDX: Record<string, string> = {
	khroma: "MIT",
};

const fence = (text: string) => `\`\`\`\n${text.replace(/\r\n/g, "\n").trim()}\n\`\`\`\n`;

export async function buildNotices(rootDir = root): Promise<{ text: string; packageCount: number; runtimeCount: number }> {
	const parts = [
		"# Third-party notices\n",
		"SSL Studio is MIT licensed (LICENSE). It ships code from the packages below: the ones it depends on and every one those depend on. " +
			"A package named here may have been left out of a build by the bundler; none that is in a build is left out here.\n",
	];
	const packages = await shippedPackages(rootDir);
	for (const { name, version, license, dir } of packages) {
		const licenseLabel = license ?? FALLBACK_SPDX[name] ?? "see license below";
		parts.push(`## ${name} ${version} (${licenseLabel})\n`);
		if (name === "elkjs") parts.push("Used under EPL-2.0 and included unmodified. Its source is at https://github.com/kieler/elkjs.\n");
		// In the order of NOTICE_FILENAMES first (LICENSE before NOTICE), then the other spellings by name.
		const entries = readdirSync(dir).filter(isNoticeFile);
		const rank = (file: string) => {
			const at = (NOTICE_FILENAMES as readonly string[]).findIndex((known) => known.toLowerCase() === file.toLowerCase());
			return at < 0 ? NOTICE_FILENAMES.length : at;
		};
		entries.sort((a, b) => rank(a) - rank(b) || (a < b ? -1 : a > b ? 1 : 0));
		let found = 0;
		const seenLower = new Set<string>();
		for (const actual of entries) {
			if (seenLower.has(actual.toLowerCase())) continue;
			seenLower.add(actual.toLowerCase());
			let text = await Bun.file(join(dir, actual)).text();
			// Vite's file goes on to its own build-time dependencies, which the app does not ship.
			if (name === "vite") text = text.split("# Licenses of bundled dependencies")[0]!;
			if (!text.trim()) continue;
			parts.push(`### ${actual}\n\n${fence(text)}`);
			found++;
		}
		if (found === 0) {
			const fallbackRel = FALLBACK_LICENSE[name];
			if (fallbackRel) {
				const fallbackPath = join(rootDir, fallbackRel);
				if (existsSync(fallbackPath)) {
					const text = await Bun.file(fallbackPath).text();
					if (text.trim()) {
						parts.push(`### LICENSE\n\n${fence(text)}`);
						found++;
					}
				}
			}
		}
		if (found === 0 && license && NOTHING_TO_REPRODUCE.has(license)) {
			parts.push(`The package ships no license file. Its package.json declares ${license}, which asks for no notice to be reproduced.\n`);
			found++;
		}
		if (found === 0) {
			throw new Error(
				`No license or notice file found for package "${name}" in ${dir}. Its license text has to be shipped: ` +
					"add it under third-party/ and name it in FALLBACK_LICENSE (scripts/notices.ts).",
			);
		}
	}
	parts.push(
		"## Codicons (CC BY 4.0)\n\nThe icon font inside monaco-editor is Microsoft's Codicons " +
			"(https://github.com/microsoft/vscode-codicons), licensed under the Creative Commons " +
			"Attribution 4.0 International license (https://creativecommons.org/licenses/by/4.0/).\n",
	);
	const source = (await Bun.file(join(rootDir, "src/view/public/grammar/SOURCE")).text()).trim();
	parts.push(`## SSL grammar and language configuration (MIT)\n\nFrom ${source}, copyright Benjamin Buddle, MIT licensed.\n`);

	// The desktop runtime: texts kept in third-party/ (its README says where each comes from).
	const runtime: [string, string][] = [
		["Bun 1.4.4 (bin/bun)", "bun-LICENSE.md"],
		["Electrobun 2.0.5 (launcher, native libraries, main-process API)", "electrobun-LICENSE"],
		["zig-bsdiff (bin/bspatch)", "zig-bsdiff-LICENSE"],
		["bsdiff, which bspatch is ported from", "bspatch-LICENSE"],
		["zig-zstd (bin/zig-zstd)", "zig-zstd-LICENSE"],
		["Zstandard, linked into zig-zstd and bspatch", "zstd-LICENSE"],
		["Microsoft WebView2 loader, linked into libNativeWrapper.dll on Windows", "webview2-LICENSE"],
		["Microsoft WebView2 SDK notices", "webview2-NOTICE"],
	];
	parts.push("# The desktop runtime\n");
	for (const [what, file] of runtime) parts.push(`## ${what}\n\n${fence(await Bun.file(join(rootDir, "third-party", file)).text())}`);

	parts.push("## starlims-lsp\n\nWhen a build bundles the language server, its license and notices are in `bin/` beside it.\n");
	return { text: parts.join("\n"), packageCount: packages.length, runtimeCount: runtime.length };
}

if (import.meta.main) {
	const { text, packageCount, runtimeCount } = await buildNotices();
	await Bun.write(join(root, "src/view/public/THIRD-PARTY-NOTICES.md"), text);
	console.log(`notices for ${packageCount} packages and ${runtimeCount} runtime parts`);
}
