// Filters out of sight until asked for (ADR 0050), the Docs panel's marks by kind (ADR 0051), the status bar's order
// (ADR 0049), the Docs state dots in one column, and a table's row checkbox that can be hit.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createRoot, createSignal, flush } from "solid-js";
import { docKindOf } from "../src/shared/projectDocs";
import { docIcon, fileIcon } from "../src/view/fileIcon";
import { filterKey, filterMenuItem, filterToggle } from "../src/view/FilterBox";

const source = (path: string) => readFileSync(join(import.meta.dir, "..", path), "utf8");

describe("a filter out of sight until it is asked for", () => {
	const make = () =>
		createRoot(() => {
			const [text, setText] = createSignal("");
			return { text, setText, box: filterToggle(text, setText) };
		});

	test("it is not drawn until asked for, and is drawn while it holds text", () => {
		const f = make();
		expect(f.box.shown()).toBe(false);
		f.box.open();
		flush();
		expect(f.box.shown()).toBe(true);
		f.setText("due");
		flush();
		f.box.settle();
		flush();
		// Left with text in it, it stays: what hides rows stays in sight.
		expect(f.box.shown()).toBe(true);
		f.setText("");
		flush();
		f.box.settle();
		flush();
		expect(f.box.shown()).toBe(false);
	});

	test("text put in from elsewhere shows it; clearing empties and puts it away", () => {
		const f = make();
		f.setText("holiday");
		flush();
		expect(f.box.shown()).toBe(true);
		f.box.clear();
		flush();
		expect(f.text()).toBe("");
		expect(f.box.shown()).toBe(false);
	});

	test("the menu item opens it, after what is to happen first", () => {
		const f = make();
		const order: string[] = [];
		const item = filterMenuItem(f.box, () => order.push("section opened"));
		expect(item).not.toBe("separator");
		if (item === "separator") return;
		expect(item.label).toBe("Filter…");
		expect(item.keys).toBe("Ctrl+F");
		item.run();
		flush();
		expect(order).toEqual(["section opened"]);
		expect(f.box.shown()).toBe(true);
	});

	test("Ctrl+F in a list opens it; in a text box the key is the box's own", () => {
		const f = make();
		const key = (init: KeyboardEventInit, target: unknown) => {
			let stopped = false;
			const e = { key: "f", ctrlKey: false, metaKey: false, shiftKey: false, altKey: false, ...init, target, preventDefault() {}, stopPropagation() { stopped = true; } };
			return { taken: filterKey(e as unknown as KeyboardEvent, f.box), stopped: () => stopped };
		};
		const row = { closest: () => null };
		const input = { closest: (sel: string) => (sel.includes("input") ? input : null) };
		expect(key({ ctrlKey: true }, input).taken).toBe(false);
		expect(key({ ctrlKey: true, shiftKey: true }, row).taken).toBe(false);
		expect(key({}, row).taken).toBe(false);
		const taken = key({ metaKey: true }, row);
		expect(taken.taken).toBe(true);
		expect(taken.stopped()).toBe(true);
		flush();
		expect(f.box.shown()).toBe(true);
	});

	test("each list that had a box always on show draws it through the toggle", () => {
		for (const path of ["src/view/panels/Explorer.tsx", "src/view/panels/Objects.tsx", "src/view/panels/Docs.tsx", "src/view/panels/Health.tsx", "src/view/editor/TableView.tsx", "src/view/panels/MarkdownInspector.tsx"]) {
			const text = source(path);
			expect(text).toContain("<FilterBox");
			expect(text).toContain("filterToggle(");
			// No bare filter box is left behind it.
			expect(text).not.toMatch(/<input\s+class="filter"/);
		}
		// Docs' and Health's pills are items in a filter menu now, and an active one a chip.
		for (const path of ["src/view/panels/Docs.tsx", "src/view/panels/Health.tsx"]) {
			const text = source(path);
			expect(text).not.toContain("docs-filter-pills");
			expect(text).toContain('<Icon name={');
			expect(text).toContain('"filter-filled" : "filter"');
			expect(text).toContain('class="docs-filter-chips"');
		}
		// The table's Ctrl+F stays Find; its row filter is in its menu.
		expect(source("src/view/editor/TableView.tsx")).toContain('{ label: "Filter rows…", value: "filter-rows"');
		// The plan's and the graph's finder is a search button until it is used.
		const finder = source("src/view/graph/Finder.tsx");
		expect(finder).toContain('class="graph-find-open"');
		expect(finder).toContain("onBlur={() => (setText(\"\"), setOpen(false))}");
	});

	test("the lists for that purpose keep their box", () => {
		expect(source("src/view/panels/Reference.tsx")).toMatch(/<input\s+class="filter"/);
		expect(source("src/view/panels/Search.tsx")).toContain('placeholder="Search"');
		expect(source("src/view/Settings.tsx")).toContain('placeholder="Search settings"');
	});
});

describe("the Docs panel marks a document by its kind", () => {
	test("a catalog is told by its name wherever it lies", () => {
		expect(docKindOf({ name: "INDEX.md", group: "tickets" })).toBe("catalog");
		expect(docKindOf({ name: "INDEX.md", group: "specs" })).toBe("catalog");
		expect(docKindOf({ name: "src/INDEX.md", group: "project", catalog: { area: "code" } as never })).toBe("catalog");
		expect(docKindOf({ name: "tests\\INDEX.md", group: "project" })).toBe("catalog");
	});

	test("the rest by the folder they are in, and the project's own by their names", () => {
		expect(docKindOf({ name: "DEMO-101.md", group: "tickets" })).toBe("ticket");
		expect(docKindOf({ name: "Report.md", group: "specs" })).toBe("spec");
		expect(docKindOf({ name: "A.md", group: "knowledge", kind: "decisions" })).toBe("decision");
		expect(docKindOf({ name: "A.md", group: "knowledge", kind: "questions" })).toBe("question");
		expect(docKindOf({ name: "A.md", group: "knowledge", kind: "prompts" })).toBe("prompt");
		expect(docKindOf({ name: "A.md", group: "knowledge", kind: "reference" })).toBe("reference");
		expect(docKindOf({ name: "A.md", group: "knowledge", kind: "snippets" })).toBe("snippet");
		expect(docKindOf({ name: "A.md", group: "schema", kind: "database" })).toBe("schema-database");
		expect(docKindOf({ name: "A.md", group: "schema", kind: "interfaces" })).toBe("schema-interface");
		expect(docKindOf({ name: "A.md", group: "schema", kind: "files" })).toBe("schema-file");
		expect(docKindOf({ name: "A.md", group: "schema", kind: "lims" })).toBe("schema");
		expect(docKindOf({ name: "database.csv", group: "registries" })).toBe("registry");
		expect(docKindOf({ name: "README.md", group: "project" })).toBe("overview");
		expect(docKindOf({ name: "AGENTS.md", group: "project" })).toBe("agents");
		expect(docKindOf({ name: "STATE.md", group: "project" })).toBe("state");
	});

	test("what has no kind keeps its file's mark", () => {
		expect(docKindOf({ name: "project.toml", group: "project" })).toBeNull();
		expect(docKindOf({ name: "Outages.sql", group: "knowledge", kind: "snippets" })).toBeNull();
		expect(docKindOf({ name: "Due.plan.md", group: "specs" })).toBeNull();
		expect(docKindOf({ name: "Worked-examples.md", group: "docs" })).toBeNull();
		expect(docKindOf({ name: "Loose.md", group: "knowledge", kind: "" })).toBeNull();
		expect(docIcon({ name: "Outages.sql", group: "knowledge", kind: "snippets" })).toEqual(fileIcon("Outages.sql"));
		expect(docIcon({ name: "Worked-examples.md", group: "docs" })).toEqual(fileIcon("Worked-examples.md"));
	});

	test("each kind has a mark of its own, in its file type's colour, none of them a panel's icon", () => {
		const kinds = [
			{ name: "INDEX.md", group: "specs" },
			{ name: "T.md", group: "tickets" },
			{ name: "S.md", group: "specs" },
			{ name: "D.md", group: "knowledge", kind: "decisions" },
			{ name: "Q.md", group: "knowledge", kind: "questions" },
			{ name: "P.md", group: "knowledge", kind: "prompts" },
			{ name: "R.md", group: "knowledge", kind: "reference" },
			{ name: "N.md", group: "knowledge", kind: "snippets" },
			{ name: "README.md", group: "project" },
			{ name: "AGENTS.md", group: "project" },
			{ name: "STATE.md", group: "project" },
			{ name: "A.md", group: "schema", kind: "database" },
			{ name: "A.md", group: "schema", kind: "interfaces" },
			{ name: "A.md", group: "schema", kind: "files" },
			{ name: "A.md", group: "schema", kind: "lims" },
		] as const;
		const glyphs = kinds.map((k) => docIcon(k));
		expect(new Set(glyphs.map((g) => g.glyph)).size).toBe(kinds.length);
		expect(new Set(glyphs.map((g) => g.kind))).toEqual(new Set(["doc"]));
		expect(glyphs.every((g) => g.glyph !== fileIcon("x.md").glyph)).toBe(true);
		expect(docIcon({ name: "files.csv", group: "registries" }).kind).toBe("data");
		const panelIcons = [...source("src/view/panels/registry.ts").matchAll(/icon: "\\u([0-9a-f]{4})"/g)].map((m) => String.fromCodePoint(parseInt(m[1]!, 16)));
		expect(panelIcons.length).toBeGreaterThan(5);
		for (const g of glyphs) expect(panelIcons).not.toContain(g.glyph);
		expect(source("src/view/panels/Docs.tsx")).not.toContain("<FileMark name={props.file.name} />");
	});
});

describe("the status bar, the Docs dots and a table's checkbox", () => {
	test("the status bar's left reads LSP, Agent, Git, Problems", () => {
		const bar = source("src/view/StatusBar.tsx");
		const at = (needle: string) => {
			const i = bar.indexOf(needle);
			expect(i).toBeGreaterThan(0);
			return i;
		};
		const lsp = at("<span>{lsp().label}</span>");
		const agent = at("<span>{agentInfo().label}</span>");
		const git = at('class="item git-item"');
		const problems = at('<span class="problem-counts" aria-hidden="true">');
		expect(lsp < agent && agent < git && git < problems).toBe(true);
	});

	test("every state dot keeps the room the ringed one needs", () => {
		const css = source("src/view/style.css");
		const block = css.slice(css.indexOf("@container docs (max-width: 380px)"));
		expect(block).toMatch(/\.doc-row \.doc-status \{[^}]*margin: 0 3px;/);
		const active = block.match(/\.doc-row \.doc-status\.tone-active \{([^}]*)\}/)?.[1] ?? "";
		expect(active).toContain("box-shadow: 0 0 0 2px var(--side-bg), 0 0 0 3px var(--accent)");
		// Its own margin was the only one: the others sat 3px off its column.
		expect(active).not.toContain("margin");
	});

	test("a table's selection column is set in one place, and its checkbox has a 24px target", () => {
		const css = source("src/view/style.css");
		expect(css).toContain(".table-view td.table-sel-col { position: sticky; left: 0; width: calc(60px * var(--ui-scale));");
		expect(css).toMatch(/\.table-sel-hit \{[^}]*width: var\(--target\); height: var\(--target\);/);
		expect(source("src/view/editor/tableViewExtra.css")).not.toMatch(/\.table-sel-col\s*\{[^}]*width/);
		const view = source("src/view/editor/TableView.tsx");
		expect(view.match(/<label class="table-sel-hit"/g)?.length).toBe(3);
		// A press on the target ticks the box; it does not start dragging the row.
		expect(view).toContain('if (target?.closest("input, .table-sel-hit")) return;');

		// The bar for the ticked rows is under them: above, it pushed every row down as the first was ticked.
		const bar = view.indexOf('<div class="table-bulk-bar"');
		expect(bar).toBeGreaterThan(view.indexOf("</table>"));
		expect(bar).toBeLessThan(view.indexOf('<div class="table-footer"'));
	});
});

describe("the editor's own stylesheets do not lose to the app's", () => {
	// The build puts a stylesheet that an editor imports in a chunk loaded before style.css, so a rule in style.css
	// for the same selector wins whatever the editor's says. That is how the table's selection column stayed 32px.
	const topLevelRules = (css: string) => {
		const text = css.replace(/\/\*[\s\S]*?\*\//g, "");
		const rules: { selector: string; props: Map<string, string> }[] = [];
		let depth = 0;
		let start = 0;
		let skipFrom = -1;
		for (let i = 0; i < text.length; i++) {
			const ch = text[i];
			if (ch === "{") {
				const head = text.slice(start, i).trim();
				if (depth === 0 && head.startsWith("@")) skipFrom = depth;
				if (depth === 0 && !head.startsWith("@")) {
					const end = text.indexOf("}", i);
					const props = new Map<string, string>();
					for (const decl of text.slice(i + 1, end).split(";")) {
						const colon = decl.indexOf(":");
						if (colon > 0) props.set(decl.slice(0, colon).trim(), decl.slice(colon + 1).trim());
					}
					for (const selector of head.split(",")) rules.push({ selector: selector.replace(/\s+/g, " ").trim(), props });
					i = end;
					start = end + 1;
					continue;
				}
				depth++;
				start = i + 1;
			} else if (ch === "}") {
				depth--;
				if (depth === 0 && skipFrom === 0) skipFrom = -1;
				start = i + 1;
			} else if (ch === ";" && depth === 0) start = i + 1;
		}
		return rules;
	};

	test("no selector both set, to different values", () => {
		const app = new Map<string, Map<string, string>>();
		for (const r of topLevelRules(source("src/view/style.css"))) {
			const props = app.get(r.selector) ?? new Map<string, string>();
			for (const [k, v] of r.props) props.set(k, v);
			app.set(r.selector, props);
		}
		const clashes: string[] = [];
		for (const path of ["src/view/editor/tableViewExtra.css", "src/view/editor/markdownLive.css", "src/view/editor/cmLive.css"]) {
			for (const r of topLevelRules(source(path))) {
				const theirs = app.get(r.selector);
				if (!theirs) continue;
				for (const [k, v] of r.props) {
					const other = theirs.get(k);
					// The same colour said two ways is no clash: the editor's token falls back to the app's.
					if (other !== undefined && other !== v && v.replace(/, var\(--[a-z-]+\)\)$/, ")") !== other) clashes.push(`${path}: ${r.selector} { ${k}: ${v} } loses to ${other}`);
				}
			}
		}
		expect(clashes).toEqual([]);
	});
});
