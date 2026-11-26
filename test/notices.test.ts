// The third-party notices name every package the app ships. The list used to be kept by hand and had fallen
// behind the bundle: 51 packages named, code from well over a hundred shipped, among them packages with their own
// copyright holders. It is now worked out from what is installed, and these tests hold it to that.
import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { buildNotices, isNoticeFile, shippedPackages } from "../scripts/notices";

const root = resolve(import.meta.dir, "..");
const scratch = mkdtempSync(join(tmpdir(), "ssl-studio-notices-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

/** A package folder with a package.json, under `at`. */
function pkg(at: string, name: string, version: string, extra: Record<string, unknown> = {}) {
	const dir = join(at, "node_modules", name);
	mkdirSync(dir, { recursive: true });
	writeFileSync(join(dir, "package.json"), JSON.stringify({ name, version, license: "MIT", ...extra }));
	writeFileSync(join(dir, "LICENSE"), `Copyright the authors of ${name}`);
	return dir;
}

describe("the packages the app ships", () => {
	test("are the dependencies and everything they depend on, wherever it is installed", async () => {
		const app = join(scratch, "app");
		mkdirSync(app, { recursive: true });
		writeFileSync(join(app, "package.json"), JSON.stringify({ name: "app", dependencies: { direct: "1.0.0", other: "1.0.0" }, devDependencies: { "dev-only": "1.0.0" } }));
		const direct = pkg(app, "direct", "1.0.0", { dependencies: { deep: "^2.0.0", shared: "^1.0.0", "@types/thing": "1.0.0" }, optionalDependencies: { "not-installed": "1.0.0" } });
		pkg(app, "other", "1.0.0", { dependencies: { shared: "^2.0.0", twin: "1.0.0" } });
		pkg(app, "deep", "2.0.0", { dependencies: { deepest: "1.0.0", twin: "1.0.0" } });
		pkg(app, "deepest", "1.0.0", { license: { type: "ISC" } });
		// Two versions of one package: the newer at the top, the older under the package that asked for it.
		pkg(app, "shared", "2.0.0");
		pkg(direct, "shared", "1.4.0");
		// The same package at the same version installed twice is one package.
		pkg(app, "twin", "1.0.0");
		pkg(join(app, "node_modules", "deep"), "twin", "1.0.0");
		pkg(app, "@types/thing", "1.0.0");
		pkg(app, "dev-only", "1.0.0");
		// The build helpers leave their own helpers in the bundle, not their dependencies' code.
		pkg(app, "vite", "8.0.0", { dependencies: { "vite-internal": "1.0.0" } });
		pkg(app, "vite-internal", "1.0.0");
		pkg(app, "rolldown", "1.0.0");

		const shipped = await shippedPackages(app);
		expect(shipped.map((p) => `${p.name}@${p.version}`)).toEqual([
			"deep@2.0.0",
			"deepest@1.0.0",
			"direct@1.0.0",
			"other@1.0.0",
			"rolldown@1.0.0",
			"shared@1.4.0",
			"shared@2.0.0",
			"twin@1.0.0",
			"vite@8.0.0",
		]);
		expect(shipped.find((p) => p.name === "deepest")!.license).toBe("ISC");
	});

	test("a dependency that is not installed stops the build, an optional one does not", async () => {
		const app = join(scratch, "missing");
		mkdirSync(app, { recursive: true });
		writeFileSync(join(app, "package.json"), JSON.stringify({ name: "app", dependencies: { direct: "1.0.0" } }));
		pkg(app, "direct", "1.0.0", { dependencies: { gone: "1.0.0" } });
		pkg(app, "vite", "8.0.0");
		pkg(app, "rolldown", "1.0.0");
		await expect(shippedPackages(app)).rejects.toThrow(/"gone", which direct depends on, is not installed/);
	});

	test("license files are found under the names packages give them, and code is never one", () => {
		for (const file of ["LICENSE", "license", "LICENSE.md", "License.txt", "LICENCE", "LICENSE-MIT", "LICENSE-MPL", "LICENSE-APACHE.txt", "COPYING", "UNLICENSE", "NOTICE", "NOTICE.md", "ThirdPartyNotices.txt", "THIRD-PARTY-LICENSE"]) {
			expect(isNoticeFile(file), file).toBe(true);
		}
		for (const file of ["license-update.mjs", "licenses.json", "license.js", "LICENSE.html", "README.md", "package.json", "notice.ts", "relicense"]) {
			expect(isNoticeFile(file), file).toBe(false);
		}
	});
});

describe("THIRD-PARTY-NOTICES.md as built for this app", () => {
	const built = buildNotices(root);
	const shipped = shippedPackages(root);

	test("has a section for every dependency in package.json, at the installed version", async () => {
		const { text } = await built;
		const own = await Bun.file(join(root, "package.json")).json();
		for (const name of Object.keys(own.dependencies)) {
			const { version } = await Bun.file(join(root, "node_modules", name, "package.json")).json();
			expect(text, name).toContain(`## ${name} ${version} (`);
		}
	});

	test("names what the bundle holds through other packages, which the hand-kept list had left out", async () => {
		const { text } = await built;
		const names = new Set((await shipped).map((p) => p.name));
		for (const name of [
			// Through @codemirror/lang-markdown.
			"@codemirror/lang-html", "@lezer/html", "@lezer/css", "@lezer/javascript",
			// Through mermaid.
			"lodash-es", "cose-base", "layout-base", "d3-scale-chromatic", "d3-ease", "d3-geo", "d3-delaunay", "internmap", "@chevrotain/regexp-to-ast",
			// Through @prettier/plugin-xml, in the backend.
			"regexp-to-ast",
		]) {
			expect(names.has(name), name).toBe(true);
			expect(text, name).toContain(`## ${name} `);
		}
		// Their copyright holders are in the text: each of these appears only in a package the old list did not have.
		for (const holder of ["Cynthia Brewer", "Robert Penner", "Mapbox", "Observable, Inc", "iVis@Bilkent", "Shahar Soel"]) expect(text, holder).toContain(holder);
	});

	test("names a second copy of a package at the version it is installed at", async () => {
		const { text } = await built;
		// Each is there when the package that asked for the older version has its own copy.
		for (const [name, nested] of [
			["chevrotain", "node_modules/@xml-tools/parser/node_modules/chevrotain"],
			["marked", "node_modules/mermaid/node_modules/marked"],
			["d3-array", "node_modules/d3-sankey/node_modules/d3-array"],
		] as const) {
			const top = join(root, "node_modules", name, "package.json");
			const inner = join(root, nested, "package.json");
			if (!existsSync(inner)) continue;
			const [a, b] = [(await Bun.file(top).json()).version, (await Bun.file(inner).json()).version];
			expect(text, `${name} ${a}`).toContain(`## ${name} ${a} (`);
			expect(text, `${name} ${b}`).toContain(`## ${name} ${b} (`);
		}
	});

	test("gives every package its license text, or says why there is none to give", async () => {
		const { text, packageCount } = await built;
		const list = await shipped;
		expect(packageCount).toBe(list.length);
		expect(list.some((p) => p.name.startsWith("@types/"))).toBe(false);
		for (const [i, p] of list.entries()) {
			const from = text.indexOf(`## ${p.name} ${p.version} (`);
			expect(from, `${p.name} ${p.version}`).toBeGreaterThan(-1);
			const next = list[i + 1];
			const to = next ? text.indexOf(`## ${next.name} ${next.version} (`, from + 1) : text.indexOf("## Codicons", from);
			const section = text.slice(from, to);
			expect(section.includes("```") || section.includes("asks for no notice to be reproduced"), `${p.name} ${p.version}`).toBe(true);
		}
	});
});
