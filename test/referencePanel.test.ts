import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { contrast, TEXT } from "../src/shared/contrast";
import { allOklchThemes } from "../src/shared/oklchTheme";
import {
	buildReferenceEntries,
	CATALOG_ELEMENT_COUNTS,
	filterReferenceEntries,
	groupReferenceTree,
	matchingGuides,
	REFERENCE_GUIDES,
	REFERENCE_SECTIONS,
	REFERENCE_SITE_URL,
	relatedGuidesForEntry,
	type LspReferenceCompletion,
} from "../src/shared/referenceCatalog";
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

describe("Reference catalog — taxonomy, URLs, search, and grouping", () => {
	test("catalog matches the 460 published STARLIMS SSL Reference elements, 11 qualified predefined globals, and 10 guides", () => {
		expect(CATALOG_ELEMENT_COUNTS).toEqual({
			functions: 330,
			classes: 29,
			returns: 12,
			keywords: 38,
			operators: 32,
			types: 8,
			literals: 3,
			specialForms: 8,
			predefinedGlobals: 11,
			guides: 10,
		});
		const total =
			CATALOG_ELEMENT_COUNTS.functions +
			CATALOG_ELEMENT_COUNTS.classes +
			CATALOG_ELEMENT_COUNTS.returns +
			CATALOG_ELEMENT_COUNTS.keywords +
			CATALOG_ELEMENT_COUNTS.operators +
			CATALOG_ELEMENT_COUNTS.types +
			CATALOG_ELEMENT_COUNTS.literals +
			CATALOG_ELEMENT_COUNTS.specialForms;
		expect(total).toBe(460);
		expect(REFERENCE_SECTIONS.length).toBe(9);
		expect(REFERENCE_GUIDES.every((g) => g.url.startsWith(REFERENCE_SITE_URL))).toBe(true);
	});

	test("buildReferenceEntries categorizes live LSP items, preserves unknown future built-ins, and builds exact GitHub Pages URLs", () => {
		const sampleLsp: LspReferenceCompletion[] = [
			{ label: "BeginLimsTransaction", kind: 3, detail: "BeginLimsTransaction([sConn]) → boolean", doc: "Starts a transaction." },
			{ label: "RunDS", kind: 3, detail: "RunDS(sDataSource, ...)", doc: "Executes a data source." },
			{ label: "AAdd", kind: 3, detail: "AAdd(aTarget, vValue)", doc: "Appends to array." },
			{ label: "FutureLimsFunc", kind: 3, detail: "FutureLimsFunc()", doc: "Added in a newer starlims-lsp." },
			{ label: "SSLDataset", kind: 7, detail: "Built-in class" },
			{ label: ":TRY", kind: 14, detail: "Keyword" },
			{ label: ".AND.", kind: 24, detail: "Logical Operator", doc: "Logical AND" },
			{ label: ".T.", kind: 21, detail: "SSL Literal", doc: "Boolean true" },
			{ label: "Session", kind: 6, detail: "Predefined Global", doc: "Declared by a base STARLIMS installation; an installation may declare more or fewer." },
			{ label: "PublicConsts", kind: 6, detail: "Predefined Global", doc: "Declared by a base STARLIMS installation; an installation may declare more or fewer." },
			{ label: "CALDATEFORMAT", kind: 6, detail: "Predefined Global", doc: "Declared by a base STARLIMS installation; an installation may declare more or fewer." },
			{ label: "GlbDefaultWorkPath", kind: 6, detail: "Predefined Global", doc: "Declared by a base STARLIMS installation; an installation may declare more or fewer." },
			{ label: "MYUSERNAME", kind: 6, detail: "Predefined Global", doc: "Declared by a base STARLIMS installation; an installation may declare more or fewer." },
			{ label: "DQ", kind: 6, detail: "Predefined Global", doc: "Declared by a base STARLIMS installation; an installation may declare more or fewer." },
			{ label: "PLATFORMA", kind: 6, detail: "Predefined Global", doc: "Declared by a base STARLIMS installation; an installation may declare more or fewer." },
			{ label: "glb_In_Batch", kind: 6, detail: "Predefined Global", doc: "Declared by a base STARLIMS installation; an installation may declare more or fewer." },
			{ label: "CustomSiteGlobal", kind: 6, detail: "Site Global", doc: "Custom global from newer server." },
			{ label: "OKTOSTART", kind: 21, detail: "Status Keyword", doc: 'Predefined STARLIMS status constant. Value: "OKTOSTART"' },
		];

		const entries = buildReferenceEntries(sampleLsp);
		const byLabel = (sec: string, label: string) => entries.find((e) => e.section === sec && e.label === label);

		const tx = byLabel("functions", "BeginLimsTransaction")!;
		expect(tx.category).toBe("Database");
		expect(tx.subcategory).toBe("Transactions");
		expect(tx.docUrl).toBe(`${REFERENCE_SITE_URL}reference/functions/BeginLimsTransaction/`);
		expect(relatedGuidesForEntry(tx).map((g) => g.id)).toEqual(["sql-transactions", "sql-queries"]);

		const rds = byLabel("functions", "RunDS")!;
		expect(relatedGuidesForEntry(rds).map((g) => g.id)).toEqual(["data-sources", "sql-queries"]);

		const future = byLabel("functions", "FutureLimsFunc")!;
		expect(future.category).toBe("Other");
		expect(future.docUrl).toBe(`${REFERENCE_SITE_URL}reference/functions/`);

		const ds = byLabel("classes", "SSLDataset")!;
		expect(ds.category).toBe("Tabular data & datasets");
		expect(ds.docUrl).toBe(`${REFERENCE_SITE_URL}reference/classes/SSLDataset/`);

		const http = byLabel("returns", "HttpClient")!;
		expect(http.category).toBe("HTTP");
		expect(http.docUrl).toBe(`${REFERENCE_SITE_URL}reference/returns/HttpClient/`);
		expect(http.hoverProbe?.text).toBe("HttpClient");

		const kw = byLabel("keywords", ":TRY")!;
		expect(kw.category).toBe("Error Handling");
		expect(kw.docUrl).toBe(`${REFERENCE_SITE_URL}reference/keywords/TRY/`);
		expect(relatedGuidesForEntry(kw).map((g) => g.id)).toEqual(["error-handling"]);

		const eq = byLabel("operators", "==")!;
		expect(eq.category).toBe("Relational & Equality");
		expect(eq.docUrl).toBe(`${REFERENCE_SITE_URL}reference/operators/strict-equals/`);

		const andOp = byLabel("operators", ".AND.")!;
		expect(andOp.doc).toBe("Logical AND");
		expect(andOp.docUrl).toBe(`${REFERENCE_SITE_URL}reference/operators/and/`);

		const strType = byLabel("types", "string")!;
		expect(strType.docUrl).toBe(`${REFERENCE_SITE_URL}reference/types/string/`);
		expect(relatedGuidesForEntry(strType).map((g) => g.id)).toEqual(["type-system", "native-members"]);

		const reqForm = byLabel("special-forms", "Request")!;
		expect(reqForm.hoverProbe?.endpoint).toBe(true);
		expect(reqForm.docUrl).toBe(`${REFERENCE_SITE_URL}reference/special-forms/request/`);

		const trueLit = byLabel("literals", ".T.")!;
		expect(trueLit.doc).toBe("Boolean true");
		expect(trueLit.docUrl).toBe(`${REFERENCE_SITE_URL}reference/literals/true/`);

		// Only fully runtime-qualified predefined globals appear in Predefined Globals;
		// globals pending value/member qualification are withheld until verified on v12.
		expect(byLabel("globals", "Session")).toBeUndefined();
		expect(byLabel("globals", "PublicConsts")).toBeUndefined();
		expect(byLabel("globals", "CALDATEFORMAT")).toBeUndefined();
		expect(byLabel("globals", "GlbDefaultWorkPath")).toBeUndefined();

		const reqGlobal = byLabel("globals", "Request")!;
		expect(reqGlobal.category).toBe("Provided by the platform");
		expect(reqGlobal.hoverProbe?.endpoint).toBe(true);
		expect(reqGlobal.docUrl).toBe(`${REFERENCE_SITE_URL}reference/special-forms/request/`);

		const respGlobal = byLabel("globals", "Response")!;
		expect(respGlobal.category).toBe("Provided by the platform");

		const userGlobal = byLabel("globals", "MYUSERNAME")!;
		expect(userGlobal.category).toBe("User & session");
		expect(userGlobal.doc).toContain("GetUserData()");
		expect(userGlobal.docUrl).toBe(`${REFERENCE_SITE_URL}guides/predefined-globals/#user-and-session`);

		const dqGlobal = byLabel("globals", "DQ")!;
		expect(dqGlobal.category).toBe("Character constants");
		expect(dqGlobal.doc).toContain("Chr(39)");
		expect(dqGlobal.doc).toContain("single quote");

		const platGlobal = byLabel("globals", "PLATFORMA")!;
		expect(platGlobal.category).toBe("Environment & batch");

		const batchGlobal = byLabel("globals", "glb_In_Batch")!;
		expect(batchGlobal.category).toBe("Environment & batch");
		expect(batchGlobal.docUrl).toBe(`${REFERENCE_SITE_URL}guides/predefined-globals/#in-batch-jobs`);

		// Unknown future kind-6 globals from starlims-lsp stay visible with their live LSP docs.
		const customGlobal = byLabel("globals", "CustomSiteGlobal")!;
		expect(customGlobal.category).toBe("Other");
		expect(customGlobal.doc).toBe("Custom global from newer server.");

		// Legacy unverified status keywords (kind 21, non-literals) are NOT listed as fixed constants.
		expect(byLabel("globals", "OKTOSTART")).toBeUndefined();
		// Searching non-base look-alike names or status names still surfaces the Predefined Globals guide.
		expect(matchingGuides("MYUSERID").map((g) => g.id)).toContain("predefined-globals");
		expect(matchingGuides("TAB").map((g) => g.id)).toContain("predefined-globals");
		expect(matchingGuides("OKTOSTART").map((g) => g.id)).toContain("predefined-globals");
	});

	test("filterReferenceEntries, groupReferenceTree, and matchingGuides support domain queries and canonical ordering", () => {
		const sampleLsp: LspReferenceCompletion[] = [
			{ label: "SQLExecute", kind: 3 },
			{ label: "BeginLimsTransaction", kind: 3 },
			{ label: "EndLimsTransaction", kind: 3 },
			{ label: "AAdd", kind: 3 },
		];
		const all = buildReferenceEntries(sampleLsp);

		// Searching by subcategory ("transaction") finds both transaction functions and the guide.
		const txMatches = filterReferenceEntries(all, { query: "transaction", section: "all" });
		expect(txMatches.map((e) => e.label)).toContain("BeginLimsTransaction");
		expect(txMatches.map((e) => e.label)).toContain("EndLimsTransaction");
		expect(matchingGuides("transaction").map((g) => g.id)).toContain("sql-transactions");

		// Section filter isolates operators in exact precedence order (! before == before := before ^=).
		const ops = filterReferenceEntries(all, { query: "", section: "operators" });
		const opTree = groupReferenceTree(ops);
		expect(opTree.length).toBe(1);
		const flatOps = opTree[0]!.categories.flatMap((c) => c.entries.map((e) => e.label));
		expect(flatOps.indexOf("!")).toBeLessThan(flatOps.indexOf("=="));
		expect(flatOps.indexOf("==")).toBeLessThan(flatOps.indexOf(":="));
		expect(flatOps.indexOf(":=")).toBeLessThan(flatOps.indexOf("^="));

		// Database subcategories stay grouped cleanly under Database.
		const fnTree = groupReferenceTree(filterReferenceEntries(all, { query: "", section: "functions" }));
		const dbCat = fnTree[0]!.categories.find((c) => c.label === "Database")!;
		expect(dbCat.subcategories.map((s) => s.label)).toEqual(["SQL Queries", "Transactions"]);
	});
});

describe("Reference panel — 27-theme WCAG AA contrast and wiring invariants", () => {
	test("Reference breadcrumb pill and online docs chip meet WCAG AA (>= 4.5:1) across all 27 themes", () => {
		const allThemes = [
			...allOklchThemes().map((t) => ({ name: t.name, s: t.studio })),
			...(
				[
					["Classic Dark", darkClassic],
					["Classic Light", lightClassic],
				] as const
			).map(([name, t]) => ({
				name,
				s: {
					panelBg: t.colors["panel.background"] ?? t.colors["sideBar.background"]!,
					sideBg: t.colors["sideBar.background"]!,
					fg: t.colors["editor.foreground"]!,
					strongFg: t.colors["tab.activeForeground"]!,
					accent: t.colors["focusBorder"]!,
				},
			})),
		];
		expect(allThemes.length).toBe(27);

		for (const { name, s } of allThemes) {
			expect(
				contrast(s.strongFg, mixSrgb(s.accent, 13, s.panelBg)),
				`${name} ref-crumb-pill`,
			).toBeGreaterThanOrEqual(TEXT);
			expect(
				contrast(s.strongFg, mixSrgb(s.accent, 11, s.sideBg)),
				`${name} ref-docs-chip`,
			).toBeGreaterThanOrEqual(TEXT);
			expect(contrast(s.fg, s.panelBg), `${name} ref-globals-note body`).toBeGreaterThanOrEqual(TEXT);
			expect(contrast(s.strongFg, s.panelBg), `${name} ref-globals-note code`).toBeGreaterThanOrEqual(TEXT);
		}
	});

	test("Reference.tsx wires categorized catalog, Guides menu, GitHub Pages links, and preserves existing test contracts", () => {
		const src = repoRead("src/view/panels/Reference.tsx");
		expect(src).toContain("buildReferenceEntries");
		expect(src).toContain("groupReferenceTree");
		expect(src).toContain("REFERENCE_SITE_URL");
		expect(src).toContain('data-ref-open-docs="true"');
		expect(src).toContain('data-ref-collapse-all="true"');
		expect(src).toContain('data-ref-site-link="true"');
		expect(src).toContain('data-ref-globals-note="true"');
		expect(src).toMatch(/<input\s+class="filter"/);
		// Never statically import ../commands from a panel (circular import guard)
		expect(src).not.toMatch(/^\s*import\s+[^;]*from\s+["']\.\.\/commands["']/m);
	});
});
