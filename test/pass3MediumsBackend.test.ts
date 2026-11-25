// The medium findings of the pass 3 audit in the Bun backend and the HTML converter. Each test runs the code it
// names. What is for Windows alone (the cmd.exe line of a `.cmd` shim) is tested as far as the building of the
// line goes: nothing here runs cmd.exe.
import { afterAll, describe, expect, test } from "bun:test";
import { chmodSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deflateRawSync } from "node:zlib";
import { marked } from "marked";
import { createBackend, type Host } from "../src/bun/backend";
import { parseDocxToMarkdown } from "../src/bun/docx";
import { formatDocument } from "../src/bun/format";
import { dirs } from "../src/bun/paths";
import { SettingsStore } from "../src/bun/settings";
import { lspCommand, shimCommand, verbatim } from "../src/bun/tools";
import { HTML_CSP } from "../src/bun/web";
import { fileKey, WorkspaceFiles } from "../src/bun/workspace";
import { decodeHtmlEntities, htmlToMarkdown } from "../src/shared/htmlToMarkdown";

const base = mkdtempSync(join(tmpdir(), "ssl-studio-p3m-"));
afterAll(() => rmSync(base, { recursive: true, force: true }));
const fresh = (name: string) => {
	const dir = join(base, name);
	mkdirSync(dir, { recursive: true });
	return dir;
};
const posix = process.platform !== "win32";
const root0 = posix && process.getuid?.() === 0;

const makeHost = (events: string[] = []): Host => ({
	app: "test",
	kind: "app",
	emit: (event, payload) => void events.push(`${event}:${JSON.stringify(payload)}`),
	pick: async () => null,
	trash: async () => {},
	quit: () => {},
});

/** The app's own folders somewhere of the test's, for as long as the work takes. */
async function withDirs<T>(name: string, work: (d: { config: string; data: string; state: string }) => Promise<T>): Promise<T> {
	const before = { ...dirs };
	const sandbox = fresh(name);
	Object.assign(dirs, { config: join(sandbox, "config"), data: join(sandbox, "data"), state: join(sandbox, "state") });
	try {
		return await work({ config: dirs.config, data: dirs.data, state: dirs.state });
	} finally {
		Object.assign(dirs, before);
	}
}

/** A seeded run of numbers, so that a failing case can be run again. */
function seeded(seed: number) {
	let state = seed >>> 0;
	const next = () => ((state = (state * 1664525 + 1013904223) >>> 0), state / 2 ** 32);
	return { next, pick: <T>(from: readonly T[]) => from[Math.floor(next() * from.length)]! };
}

describe("1. a file saved through a link", () => {
	const linked = (name: string) => {
		const root = fresh(name);
		mkdirSync(join(root, "shared"));
		writeFileSync(join(root, "shared", "Common.ssl"), "original\n");
		try {
			symlinkSync(join("shared", "Common.ssl"), join(root, "Link.ssl"));
		} catch {
			return null;
		}
		return root;
	};

	test("the save lands in the file the link leads to, and the link stays a link", async () => {
		const root = linked("link-save");
		if (!root) return;
		const ws = new WorkspaceFiles(root);
		expect((await ws.read(join(root, "Link.ssl"))).text).toBe("original\n");
		const saved = await ws.write(join(root, "Link.ssl"), "edited through the link\n");
		expect(lstatSync(join(root, "Link.ssl")).isSymbolicLink()).toBe(true);
		expect(readFileSync(join(root, "shared", "Common.ssl"), "utf8")).toBe("edited through the link\n");
		expect(readFileSync(join(root, "Link.ssl"), "utf8")).toBe("edited through the link\n");
		expect(saved.mtime).toBe((await ws.read(join(root, "shared", "Common.ssl"))).mtime);
		// Nothing is left beside either name.
		expect(readdirSync(root).sort()).toEqual(["Link.ssl", "shared"]);
		expect(readdirSync(join(root, "shared"))).toEqual(["Common.ssl"]);
	});

	test("bytes written through a link land in its file too", async () => {
		const root = linked("link-bytes");
		if (!root) return;
		const ws = new WorkspaceFiles(root);
		await ws.writeBytes(join(root, "Link.ssl"), new TextEncoder().encode("bytes\n"));
		expect(lstatSync(join(root, "Link.ssl")).isSymbolicLink()).toBe(true);
		expect(readFileSync(join(root, "shared", "Common.ssl"), "utf8")).toBe("bytes\n");
	});

	test("a save by the link's name and one by the file's own name go one after the other", async () => {
		const root = linked("link-two-names");
		if (!root) return;
		const ws = new WorkspaceFiles(root);
		expect(fileKey(join(root, "Link.ssl"))).toBe(fileKey(join(root, "shared", "Common.ssl")));
		for (let round = 0; round < 25; round++) {
			// The first is the larger, so that at once it would land last.
			const first = `/* round ${round}, by the link */\n${"x".repeat(60_000)}\n`;
			const second = `/* round ${round}, by its own name */\n`;
			await Promise.all([ws.write(join(root, "Link.ssl"), first), ws.write(join(root, "shared", "Common.ssl"), second)]);
			expect(readFileSync(join(root, "shared", "Common.ssl"), "utf8")).toBe(second);
			expect(readFileSync(join(root, "Link.ssl"), "utf8")).toBe(second);
		}
		expect(lstatSync(join(root, "Link.ssl")).isSymbolicLink()).toBe(true);
	});

	test("a link to a file that is not there yet: the save makes the file, under the file's own key", async () => {
		const root = fresh("link-dangling");
		try {
			symlinkSync(join("made", "Later.ssl"), join(root, "Soon.ssl"));
		} catch {
			return;
		}
		const ws = new WorkspaceFiles(root);
		expect(fileKey(join(root, "Soon.ssl"))).toBe(fileKey(join(root, "made", "Later.ssl")));
		await ws.write(join(root, "Soon.ssl"), "now it is there\n");
		expect(lstatSync(join(root, "Soon.ssl")).isSymbolicLink()).toBe(true);
		expect(readFileSync(join(root, "made", "Later.ssl"), "utf8")).toBe("now it is there\n");
	});

	test("a link that leads out of the folder is still not written through, and an ordinary file is written as before", async () => {
		const root = fresh("link-out");
		const outside = fresh("link-out-elsewhere");
		writeFileSync(join(outside, "secret.ssl"), "theirs\n");
		writeFileSync(join(root, "plain.ssl"), "before\n");
		const ws = new WorkspaceFiles(root);
		await ws.write(join(root, "plain.ssl"), "after\n");
		expect(readFileSync(join(root, "plain.ssl"), "utf8")).toBe("after\n");
		expect(lstatSync(join(root, "plain.ssl")).isFile()).toBe(true);
		try {
			symlinkSync(join(outside, "secret.ssl"), join(root, "out.ssl"));
		} catch {
			return;
		}
		await expect(ws.write(join(root, "out.ssl"), "mine\n")).rejects.toThrow(/outside the workspace/);
		expect(readFileSync(join(outside, "secret.ssl"), "utf8")).toBe("theirs\n");
		expect(lstatSync(join(root, "out.ssl")).isSymbolicLink()).toBe(true);
	});
});

describe("2. the model a project names", () => {
	const project = (name: string, model: string) => {
		const ws = fresh(name);
		mkdirSync(join(ws, ".ssl-studio"));
		writeFileSync(join(ws, ".ssl-studio", "project.toml"), `[project]\nname = "P"\n[agent]\nmodel = "${model}"\n[style]\npreset = "server"\n`);
		return ws;
	};

	test("a local model in project.toml is the model until the user chooses one, and again when they take theirs out", async () => {
		await withDirs("dirs-model-local", async () => {
			const ws = project("model-local", "ollama/qwen3:14b");
			const store = new SettingsStore(() => ws);
			const loaded = await store.load();
			expect(loaded.effective.agentModel).toBe("ollama/qwen3:14b");
			expect(loaded.effective.stylePreset).toBe("server");
			// It is the project's, not something either settings file holds.
			expect(loaded.user).toEqual({});
			expect(loaded.workspace).toEqual({});
			// The model picker saves the user's choice, and that is the one used.
			expect((await store.save("user", { agentModel: "ollama/llama3:8b" })).agentModel).toBe("ollama/llama3:8b");
			expect((await store.load()).effective.agentModel).toBe("ollama/llama3:8b");
			expect((await store.save("user", { agentModel: null })).agentModel).toBe("ollama/qwen3:14b");
		});
	});

	test("a model that is paid for is never taken from a folder: not from project.toml, not from its settings.json", async () => {
		await withDirs("dirs-model-paid", async ({ config }) => {
			const ws = project("model-paid", "openrouter/expensive-model");
			writeFileSync(join(ws, ".ssl-studio", "settings.json"), JSON.stringify({ agentModel: "openai/gpt-5", fontSize: 15 }));
			const store = new SettingsStore(() => ws);
			const loaded = await store.load();
			expect(loaded.effective.agentModel).toBeUndefined();
			expect(loaded.effective.fontSize).toBe(15);
			expect(loaded.workspace).toEqual({ fontSize: 15 });
			// Nor does saving one into the workspace's settings bring it in.
			expect((await store.save("workspace", { agentModel: "anthropic/claude-opus" })).agentModel).toBeUndefined();
			// The user's own choice is theirs to make, paid or not, and stands over the folder's.
			mkdirSync(config, { recursive: true });
			writeFileSync(join(config, "settings.json"), JSON.stringify({ agentModel: "openai/gpt-5" }));
			expect((await store.load()).effective.agentModel).toBe("openai/gpt-5");
		});
	});

	test("the workspace's settings.json cannot set the model, though a local one: the project's shows", async () => {
		await withDirs("dirs-model-ws", async () => {
			const ws = project("model-ws", "ollama/qwen3:14b");
			writeFileSync(join(ws, ".ssl-studio", "settings.json"), JSON.stringify({ agentModel: "ollama/other:1b" }));
			const store = new SettingsStore(() => ws);
			expect((await store.load()).effective.agentModel).toBe("ollama/qwen3:14b");
			// With no project file at all, a folder sets no model.
			const bare = fresh("model-none");
			mkdirSync(join(bare, ".ssl-studio"));
			writeFileSync(join(bare, ".ssl-studio", "settings.json"), JSON.stringify({ agentModel: "ollama/other:1b" }));
			expect((await new SettingsStore(() => bare).load()).effective.agentModel).toBeUndefined();
		});
	});
});

/** A zip of these files, each deflated: enough of one for the reader. */
function zip(entries: { name: string; data: string }[]): Uint8Array {
	const enc = new TextEncoder();
	const locals: Uint8Array[] = [];
	const centrals: Uint8Array[] = [];
	let offset = 0;
	for (const entry of entries) {
		const name = enc.encode(entry.name);
		const raw = enc.encode(entry.data);
		const packed = new Uint8Array(deflateRawSync(raw));
		const local = new Uint8Array(30 + name.length + packed.length);
		const lv = new DataView(local.buffer);
		lv.setUint32(0, 0x04034b50, true);
		lv.setUint16(4, 20, true);
		lv.setUint16(8, 8, true);
		lv.setUint32(18, packed.length, true);
		lv.setUint32(22, raw.length, true);
		lv.setUint16(26, name.length, true);
		local.set(name, 30);
		local.set(packed, 30 + name.length);
		locals.push(local);
		const central = new Uint8Array(46 + name.length);
		const cv = new DataView(central.buffer);
		cv.setUint32(0, 0x02014b50, true);
		cv.setUint16(10, 8, true);
		cv.setUint32(20, packed.length, true);
		cv.setUint32(24, raw.length, true);
		cv.setUint16(28, name.length, true);
		cv.setUint32(42, offset, true);
		central.set(name, 46);
		centrals.push(central);
		offset += local.length;
	}
	const size = centrals.reduce((sum, part) => sum + part.length, 0);
	const end = new Uint8Array(22);
	const ev = new DataView(end.buffer);
	ev.setUint32(0, 0x06054b50, true);
	ev.setUint16(8, entries.length, true);
	ev.setUint16(10, entries.length, true);
	ev.setUint32(12, size, true);
	ev.setUint32(16, offset, true);
	return Buffer.concat([...locals, ...centrals, end]);
}
const W = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"';
const wordDoc = (body: string) => zip([{ name: "word/document.xml", data: `<?xml version="1.0"?><w:document ${W}><w:body>${body}</w:body></w:document>` }]);
/** What a .doc of the old kind, or a .docx behind a password, begins with: not a zip. */
const oldDoc = Buffer.from("\xD0\xCF\x11\xE0\xA1\xB1\x1A\xE1 an OLE compound file", "latin1");
const cutShort = Buffer.from("PK\x03\x04 a download that stopped here");
const base64 = (bytes: Uint8Array) => Buffer.from(bytes).toString("base64");

describe("3. importing what is not a Word document", () => {
	test("the reader says so, for bytes that are not a zip, a zip cut short, and a zip that is not a document", () => {
		expect(() => parseDocxToMarkdown(oldDoc, "Report.docx")).toThrow(/^Report\.docx is not a Word document that can be read here/);
		expect(() => parseDocxToMarkdown(cutShort)).toThrow(/not a Word document that can be read here/);
		expect(() => parseDocxToMarkdown(new Uint8Array(0))).toThrow(/not a Word document/);
		expect(() => parseDocxToMarkdown(zip([{ name: "xl/workbook.xml", data: "<workbook/>" }]))).toThrow(/not a Word document/);
	});

	test("a document with nothing written in it is still a document", () => {
		expect(parseDocxToMarkdown(wordDoc(""))).toEqual({ markdown: "", images: [] });
		expect(parseDocxToMarkdown(wordDoc("<w:p><w:r><w:t>Kept</w:t></w:r></w:p>")).markdown).toBe("Kept");
	});

	test("dropped bytes that are no document fail before the Markdown in their place is touched, whatever was to be done about it", async () => {
		await withDirs("dirs-docx-bytes", async () => {
			const ws = fresh("docx-bytes");
			mkdirSync(join(ws, "docs"));
			const kept = "# Precious existing notes\n\nKeep me.\n";
			writeFileSync(join(ws, "docs", "Report.md"), kept);
			const backend = createBackend(makeHost(), ws);
			await backend.ready;
			try {
				for (const onConflict of ["overwrite", "copy", "prompt", undefined] as const) {
					for (const bytes of [oldDoc, cutShort]) {
						await expect(backend.api.importDocxBytes({ fileName: "Report.docx", base64: base64(bytes), destDir: join(ws, "docs"), ...(onConflict ? { onConflict } : {}) })).rejects.toThrow(
							/Report\.docx is not a Word document that can be read here/,
						);
					}
				}
				expect(readFileSync(join(ws, "docs", "Report.md"), "utf8")).toBe(kept);
				expect(readdirSync(join(ws, "docs"))).toEqual(["Report.md"]);
				// No snapshot was taken of a file nothing was done to.
				expect(await backend.api.history(join(ws, "docs", "Report.md"))).toEqual([]);

				// A real document still comes in, an empty one as an empty file, and Overwrite still keeps what was there.
				const empty = await backend.api.importDocxBytes({ fileName: "Empty.docx", base64: base64(wordDoc("")), destDir: join(ws, "docs") });
				expect(readFileSync(empty.path, "utf8")).toBe("\n");
				const over = await backend.api.importDocxBytes({ fileName: "Report.docx", base64: base64(wordDoc("<w:p><w:r><w:t>New text</w:t></w:r></w:p>")), destDir: join(ws, "docs"), onConflict: "overwrite" });
				expect(readFileSync(over.path, "utf8")).toBe("New text\n");
				const snaps = await backend.api.history(join(ws, "docs", "Report.md"));
				expect(await backend.api.snapshot(join(ws, "docs", "Report.md"), snaps[snaps.length - 1]!.id)).toBe(kept);
			} finally {
				backend.dispose();
			}
		});
	});

	test("a picked file that is no document fails the same way", async () => {
		await withDirs("dirs-docx-file", async () => {
			const ws = fresh("docx-file");
			const elsewhere = fresh("docx-file-downloads");
			mkdirSync(join(ws, "docs"));
			const kept = "# Notes\n";
			writeFileSync(join(ws, "docs", "Old Report.md"), kept);
			writeFileSync(join(elsewhere, "Old Report.docx"), oldDoc);
			writeFileSync(join(elsewhere, "Fine.docx"), wordDoc("<w:p><w:r><w:t>Fine</w:t></w:r></w:p>"));
			const backend = createBackend(makeHost(), ws);
			await backend.ready;
			try {
				for (const onConflict of ["overwrite", "copy", "prompt"] as const) {
					await expect(backend.api.importDocFile({ sourcePath: join(elsewhere, "Old Report.docx"), destDir: join(ws, "docs"), onConflict })).rejects.toThrow(/Old Report\.docx is not a Word document that can be read here/);
				}
				expect(readFileSync(join(ws, "docs", "Old Report.md"), "utf8")).toBe(kept);
				expect(readdirSync(join(ws, "docs"))).toEqual(["Old Report.md"]);
				expect(await backend.api.history(join(ws, "docs", "Old Report.md"))).toEqual([]);
				const fine = await backend.api.importDocFile({ sourcePath: join(elsewhere, "Fine.docx"), destDir: join(ws, "docs") });
				expect(fine?.kind).toBe("docx");
				expect(readFileSync(fine!.path, "utf8")).toBe("Fine\n");
			} finally {
				backend.dispose();
			}
		});
	});
});

describe("4. opening a folder when the list of recent folders cannot be written", () => {
	test.skipIf(!posix || root0)("the open comes to the new folder, in the backend and in what it answers", async () => {
		await withDirs("dirs-open", async ({ state }) => {
			const wsA = fresh("open-a");
			const wsB = fresh("open-b");
			writeFileSync(join(wsA, "a.ssl"), ":RETURN 1;\n");
			writeFileSync(join(wsB, "b.ssl"), ":RETURN 2;\n");
			const events: string[] = [];
			const backend = createBackend(makeHost(events), wsA);
			await backend.ready;
			// Nothing can be made in the folder the list is kept in.
			mkdirSync(state, { recursive: true });
			chmodSync(state, 0o555);
			const said = console.error;
			const logged: string[] = [];
			console.error = (...args: unknown[]) => void logged.push(args.map(String).join(" "));
			try {
				await expect(backend.api.recent()).resolves.toEqual(expect.any(Array));
				const opened = await backend.api.openFolder(wsB);
				expect(opened).toEqual({ root: wsB, name: "open-b" });
				expect(await backend.api.workspace()).toEqual({ root: wsB, name: "open-b" });
				// The folder is whole: its files are written, and the one before is not this backend's any more.
				await backend.api.write(join(wsB, "b.ssl"), ":RETURN 3;\n");
				expect(readFileSync(join(wsB, "b.ssl"), "utf8")).toBe(":RETURN 3;\n");
				await expect(backend.api.write(join(wsA, "a.ssl"), "x\n")).rejects.toThrow(/outside the workspace/);
				expect(logged.some((line) => /list of recent folders was not written/.test(line))).toBe(true);
				// The language server was looked for as on any open: its state was said after the one that stopped it.
				expect(events.filter((event) => event.startsWith("lspState:")).length).toBeGreaterThan(0);
			} finally {
				console.error = said;
				chmodSync(state, 0o755);
				backend.dispose();
			}
		});
	});
});

describe("5. Format Document on XML keeps what the elements say", () => {
	const xfd = (text: string, path = "/x/form.xfd", root: string | null = null) => formatDocument({ path, languageId: "xml", text }, root);
	const source = ["<Form>", '  <Label Caption="x  y"><Text>Sample  ID:   </Text></Label>', "      <Script>if (a &lt; b) {", '    run( "two  spaces" );', "}</Script>", '  <add key="k">a,b,  c</add>', "<Outer><Inner><Leaf a='1'/></Inner></Outer>", "</Form>", ""].join("\n");

	test("text comes out as it went in, and elements that hold only elements are still indented", async () => {
		const result = await xfd(source);
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.text).toBe(
			["<Form>", '    <Label Caption="x  y">', "        <Text>Sample  ID:   </Text>", "    </Label>", "    <Script>if (a &lt; b) {", '    run( "two  spaces" );', "}</Script>", '    <add key="k">a,b,  c</add>', "    <Outer>", "        <Inner>", "            <Leaf a='1' />", "        </Inner>", "    </Outer>", "</Form>", ""].join("\n"),
		);
		const again = await xfd(result.text);
		expect(again.ok && again.changed).toBe(false);
	});

	test("an element that holds only spaces, or only a character written by name, keeps exactly that", async () => {
		const result = await xfd("<R><Sep> </Sep><Tab>\t\t</Tab><Op>&lt;</Op><Pad>  &amp;  </Pad><Nb>&#160;</Nb><Empty></Empty><Laid>\n</Laid></R>\n");
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.text).toBe(["<R>", "    <Sep> </Sep>", "    <Tab>\t\t</Tab>", "    <Op>&lt;</Op>", "    <Pad>  &amp;  </Pad>", "    <Nb>&#160;</Nb>", "    <Empty />", "    <Laid />", "</R>", ""].join("\n"));
		// The mark that kept them is not in the result, though the file held the first choice of mark already.
		const held = await xfd("<R><Note>a \ue000 b</Note><Sep> </Sep></R>\n");
		expect(held.ok && held.text).toBe(["<R>", "    <Note>a \ue000 b</Note>", "    <Sep> </Sep>", "</R>", ""].join("\n"));
	});

	test("a project's own Prettier config can still ask for the printer's way with text", async () => {
		const root = fresh("fmt-rc");
		writeFileSync(join(root, ".prettierrc"), JSON.stringify({ xmlWhitespaceSensitivity: "ignore" }));
		const result = await xfd("<R><Text>Sample  ID:   </Text></R>\n", join(root, "form.xfd"), root);
		expect(result.ok && result.text).toBe("<R>\n    <Text>Sample ID:</Text>\n</R>\n");
	});

	test("many forms: every leaf's text is byte for byte what it was, and a second format changes nothing", async () => {
		const { next, pick } = seeded(20261124);
		const PIECES = ["Sample", "ID:", "x", "42", " ", " ", "  ", "   ", "\t", "&lt;", "&gt;", "&amp;", "&#32;", "&#9;", "&quot;", '"two  spaces"', "'", ",", ";", "=", "(", ")", "{", "}", "\n    run();", "\n", "a,b,  c", "é", "--", "]]", "?", "!", "/", "\\"];
		const ATTRS = ["", "", ' a="1"', ' Caption="x  y"', " b='q &gt; r'", ' c="has > inside"', '\n    d="long attribute value number one"\n    e="2"'];
		let count = 0;
		const leaf = (leaves: string[]) => {
			let text = Array.from({ length: Math.floor(next() * 5) }, () => pick(PIECES)).join("");
			// Nothing but the break between the two tags is layout, and is the printer's to close in one tag.
			if (/^\s*$/.test(text) && /[\r\n]/.test(text)) text = "";
			leaves.push(text);
			const name = `L${count++}`;
			return text === "" && next() < 0.5 ? `<${name}${pick(ATTRS)}/>` : `<${name}${pick(ATTRS)}>${text}</${name}>`;
		};
		const node = (depth: number, leaves: string[]): string => {
			if (depth > 3 || next() < 0.45) return leaf(leaves);
			const kids = Array.from({ length: 1 + Math.floor(next() * 4) }, () => node(depth + 1, leaves));
			const gap = () => pick(["", "\n", "\n  ", " ", "\n\n\n", "\t"]);
			const beside = () => pick(["", "", "", "<!-- a   note -->", "<![CDATA[ raw  <L99> </L99> ]]>"]);
			return `<C${pick(ATTRS)}>${kids.map((kid) => gap() + beside() + kid).join("")}${gap()}</C>`;
		};
		const leavesOf = (xml: string) =>
			[...xml.replace(/<!--[\s\S]*?-->|<!\[CDATA\[[\s\S]*?\]\]>/g, "").matchAll(/<(L\d+)\b(?:[^>"']|"[^"]*"|'[^']*')*?(?:\/>|>([^<]*)<\/\1>)/g)].map((m) => m[2] ?? "");
		for (let round = 0; round < 150; round++) {
			count = 0;
			const leaves: string[] = [];
			const xml = `<Root>${node(0, leaves)}</Root>\n`;
			const result = await xfd(xml);
			if (!result.ok) throw new Error(`not formatted: ${JSON.stringify(xml)}: ${result.error}`);
			expect({ xml, leaves: leavesOf(result.text) }).toEqual({ xml, leaves });
			expect(/[\ue000-\ue00f]/.test(result.text)).toBe(false);
			const again = await xfd(result.text);
			expect({ xml, stable: again.ok && again.text === result.text }).toEqual({ xml, stable: true });
		}
	});
});

describe("6. the cmd.exe line of a .cmd shim (Windows; built here, never run here)", () => {
	/** What cmd.exe makes of what follows `/c` when `/s` is given: the first quote and the last one are taken off. */
	const afterS = (command: string[]) => {
		const line = command.slice(4).join(" ");
		if (!line.startsWith('"')) return line;
		const last = line.lastIndexOf('"');
		return line.slice(1, last) + line.slice(last + 1);
	};
	/** The words of a cmd line, quotes off, and whatever stood outside quotes besides the spaces between words. */
	const read = (line: string) => {
		const found: string[] = [];
		let word = "";
		let inQuotes = false;
		let bare = "";
		let any = false;
		for (const ch of line) {
			if (ch === '"') {
				inQuotes = !inQuotes;
				any = true;
			} else if (!inQuotes && (ch === " " || ch === "\t")) {
				if (any) found.push(word);
				word = "";
				any = false;
			} else {
				word += ch;
				any = true;
				if (!inQuotes) bare += ch;
			}
		}
		if (any) found.push(word);
		return { words: found, bare, closed: !inQuotes };
	};

	test("no shim, or not Windows: the program and its arguments as they are", () => {
		expect(lspCommand("C:\\Program Files\\STARLIMS\\starlims-lsp.exe", ["--stdio"], "win32")).toEqual(["C:\\Program Files\\STARLIMS\\starlims-lsp.exe", "--stdio"]);
		expect(lspCommand("/home/a b/starlims-lsp.cmd", ["--stdio"], "linux")).toEqual(["/home/a b/starlims-lsp.cmd", "--stdio"]);
		expect(verbatim(["C:\\Program Files\\STARLIMS\\starlims-lsp.exe", "--stdio"], "win32")).toBe(false);
		expect(verbatim(["/usr/bin/starlims-lsp", "--stdio"], "linux")).toBe(false);
	});

	test("a shim whose path needs no quotes: the same words as before, however the process is started", () => {
		const command = lspCommand("C:\\tools\\starlims-lsp.cmd", ["--stdio"], "win32");
		expect(command).toEqual(["cmd.exe", "/d", "/s", "/c", "C:\\tools\\starlims-lsp.cmd", "--stdio"]);
		expect(verbatim(command, "win32")).toBe(false);
		expect(lspCommand("C:\\tools\\LSP.BAT", ["--version"], "win32")).toEqual(["cmd.exe", "/d", "/s", "/c", "C:\\tools\\LSP.BAT", "--version"]);
	});

	test("a path with a space: one line in quotes of its own, which cmd reads back as the path and the arguments", () => {
		const path = "C:\\Users\\First Last\\AppData\\Roaming\\npm\\opencode.cmd";
		const command = shimCommand(path, ["--version"]);
		expect(command).toEqual(["cmd.exe", "/d", "/s", "/c", `""${path}" --version"`]);
		expect(verbatim(command, "win32")).toBe(true);
		// Only on Windows is there such a thing as a line passed as written.
		expect(verbatim(command, "linux")).toBe(false);
		expect(afterS(command)).toBe(`"${path}" --version`);
		expect(read(afterS(command))).toEqual({ words: [path, "--version"], bare: "--version", closed: true });
	});

	test("the agent's way: arguments added after the command still read back, the line's own last quote being the one taken off", () => {
		const path = "C:\\Users\\First Last\\AppData\\Roaming\\npm\\opencode.cmd";
		const command = [...shimCommand(path), "serve", "--stdio", "--port", "0"];
		expect(verbatim(command, "win32")).toBe(true);
		expect(afterS(command)).toBe(`"${path}" serve --stdio --port 0`);
		expect(read(afterS(command)).words).toEqual([path, "serve", "--stdio", "--port", "0"]);
	});

	test("cmd's own signs in a path or an argument stay inside quotes", () => {
		for (const path of ["C:\\R&D\\lsp.cmd", "C:\\Program Files (x86)\\tools\\lsp.cmd", "C:\\a^b\\lsp.cmd", "C:\\a|b\\x.bat", "C:\\a<b>\\x.cmd", "C:\\a,b;c=d\\x.cmd", "C:\\Tom & Jerry's\\x.cmd"]) {
			const command = lspCommand(path, ["--stdio"], "win32");
			expect(verbatim(command, "win32")).toBe(true);
			const got = read(afterS(command));
			expect({ path, ...got }).toEqual({ path, words: [path, "--stdio"], bare: "--stdio", closed: true });
		}
		const command = shimCommand("C:\\tools\\x.cmd", ["--name", "a b", "c&d", "", "plain"]);
		expect(command).toEqual(["cmd.exe", "/d", "/s", "/c", '"C:\\tools\\x.cmd --name "a b" "c&d" "" plain"']);
		expect(read(afterS(command))).toEqual({ words: ["C:\\tools\\x.cmd", "--name", "a b", "c&d", "", "plain"], bare: "C:\\tools\\x.cmd--nameplain", closed: true });
	});

	test("a quote cannot end the quoting: dropped from a path, doubled in an argument", () => {
		const fromPath = shimCommand('C:\\a b\\x.cmd" & calc.exe & "', ["--stdio"]);
		expect(read(afterS(fromPath))).toEqual({ words: ["C:\\a b\\x.cmd & calc.exe & ", "--stdio"], bare: "--stdio", closed: true });
		const fromArg = shimCommand("C:\\tools\\x.cmd", ['say "hi" & calc.exe']);
		expect(fromArg[4]).toBe('"C:\\tools\\x.cmd "say ""hi"" & calc.exe""');
		const got = read(afterS(fromArg));
		expect(got.closed).toBe(true);
		expect(/[&|<>^]/.test(got.bare)).toBe(false);
	});
});

describe("7. the browser host's content security policy", () => {
	test("a form in a rendered document can be sent nowhere", () => {
		const rules = HTML_CSP.split(";").map((rule) => rule.trim());
		expect(rules).toContain("form-action 'none'");
		// And what was there is there still.
		expect(rules).toContain("base-uri 'self'");
		expect(rules).toContain("frame-ancestors 'none'");
		expect(rules).toContain("object-src 'none'");
	});
});

describe("8. HTML to Markdown: what a page showed as text stays text", () => {
	const render = (md: string) => (marked.parse(md, { async: false }) as string).trim();
	const elements = (html: string) => [...new Set([...html.matchAll(/<([a-zA-Z][a-zA-Z0-9]*)/g)].map((m) => m[1]!.toLowerCase()))].sort();
	const one = (text: string) => text.replace(/\s+/g, " ").trim();
	const shown = (html: string) => one(decodeHtmlEntities(html.replace(/<br\s*\/?>/g, "\n").replace(/<[^>]+>/g, "")));

	test("an escaped tag is written as text, and renders as the text the page showed", () => {
		expect(htmlToMarkdown("<p>Set the &lt;DataSource&gt; element, then close &lt;/Form&gt;.</p>")).toBe("Set the &lt;DataSource> element, then close &lt;/Form>.");
		const script = htmlToMarkdown("<p>&lt;script&gt;alert(1)&lt;/script&gt; &lt;img src=x onerror=alert(1)&gt;</p>");
		expect(script).not.toContain("<script");
		expect(script).not.toContain("<img");
		expect(render(script)).toBe("<p>&lt;script&gt;alert(1)&lt;/script&gt; &lt;img src=x onerror=alert(1)&gt;</p>");
		expect(htmlToMarkdown("<strong>&lt;div&gt;</strong>")).toBe("**&lt;div>**");
		// A page that showed "&lt;b&gt;" as those very characters shows them still.
		expect(shown(render(htmlToMarkdown("<p>&amp;lt;b&amp;gt;</p>")))).toBe("&lt;b&gt;");
		// A named character this does not read is left for Markdown, which reads the same names.
		expect(htmlToMarkdown("<p>caf&eacute; &rarr; 5 &times; 3 &amp;eacute;</p>")).toBe("caf&eacute; &rarr; 5 &times; 3 &amp;eacute;");
	});

	test("the marks of Markdown in a page's text are written as themselves", () => {
		expect(htmlToMarkdown("<p>2 * 3 * 4 and snake_case_name and _edge_ [b] `d` ~x~ \\ e</p>")).toBe("2 \\* 3 \\* 4 and snake_case_name and \\_edge\\_ \\[b\\] \\`d\\` \\~x\\~ \\\\ e");
		const md = htmlToMarkdown("<p># heading?</p><p>1. not a list</p><p>- dash</p><p>&gt; quoted?</p><p>a | b<br>--- | ---</p><p>Title<br>===</p><p>- - -</p>");
		expect(md).toBe("\\# heading?\n\n1\\. not a list\n\n\\- dash\n\n\\> quoted?\n\na | b\n\\--- | ---\n\nTitle\n\\===\n\n\\- - -");
		expect(elements(render(md))).toEqual(["p"]);
		// The same at the start of a list's item, and a "#" at a heading's end.
		expect(elements(render(htmlToMarkdown("<ul><li># one</li><li>1. two</li><li>- three</li><li>---</li></ul>")))).toEqual(["li", "ul"]);
		expect(render(htmlToMarkdown("<h2>C#</h2>"))).toBe("<h2>C#</h2>");
		// A paragraph the page wrote indented is not code.
		expect(render(htmlToMarkdown("<p>one</p><div>\n        <p>\n            two\n        </p>\n</div>"))).toBe("<p>one</p>\n<p>two</p>");
	});

	test("an address is judged with every character reference in it read", () => {
		for (const href of ["JaVaScRiPt&colon;alert(1)", "java&#115;cript:alert(1)", "jav&Tab;ascript:alert(1)", "jav&NewLine;ascript:alert(1)", "javascript&#58alert(1)", "javascript&#x3a;alert(1)", "&#32;&#9;javascript:alert(1)", "vbscript&colon;x", "data&colon;text/html,x", " \tjavascript:alert(1)"]) {
			expect({ href, md: htmlToMarkdown(`<a href="${href}">Click</a>`) }).toEqual({ href, md: "Click" });
			expect({ href, md: htmlToMarkdown(`<img alt="Pic" src="${href}">`) }).toEqual({ href, md: "[Image: Pic]" });
		}
		expect(htmlToMarkdown('<a href="https://example.com/doc?a=1&amp;b=2">Doc</a>')).toBe("[Doc](https://example.com/doc?a=1&b=2)");
		// What is taken out of an address as it is written makes no scheme of what was none.
		expect(htmlToMarkdown('<a href="java&#127;script:alert(1)">x</a>')).toBe("[x](java%7Fscript:alert%281%29)");
		expect(htmlToMarkdown('<a href="java&#1;script:alert(1)">x</a>')).toBe("x");
	});

	test("a link survives a bracket in its words and a bracket, a space or a quote in its address", () => {
		const md = htmlToMarkdown('<p><a href="http://x/a)b (c)/d&quot;e">t]x [y](javascript:alert(1))</a> <img src="a b.png" alt="al]t"></p>');
		expect(md).toBe("[t&#93;x &#91;y&#93;(javascript:alert(1))](http://x/a%29b%20%28c%29/d%22e) ![al&#93;t](a%20b.png)");
		expect(render(md)).toBe('<p><a href="http://x/a%29b%20%28c%29/d%22e">t]x [y](javascript:alert(1))</a> <img src="a%20b.png" alt="al]t"></p>');
		// An address between angle brackets only where Markdown knows it for one; any other would be read as a tag.
		expect(htmlToMarkdown('<a href="https://example.com">https://example.com</a>')).toBe("<https://example.com>");
		expect(htmlToMarkdown('<a href="docs/x.md">docs/x.md</a>')).toBe("[docs/x.md](docs/x.md)");
		// An "&" of the address that Markdown would read as a named character is written as the character it is.
		expect(render(htmlToMarkdown('<a href="x?a=1&amp;copy;=2">q</a>'))).toBe('<p><a href="x?a=1&amp;copy;=2">q</a></p>');
	});

	test("code holds its backticks, and a summary is the page's words", () => {
		expect(render(htmlToMarkdown("<p><code>a `` b</code> and <code>`tick`</code></p>"))).toBe("<p><code>a `` b</code> and <code>`tick`</code></p>");
		const fenced = htmlToMarkdown("<pre>x\n```\n&lt;script&gt;alert(1)&lt;/script&gt;\n</pre>");
		expect(fenced).toBe("````\nx\n```\n<script>alert(1)</script>\n````");
		expect(elements(render(fenced))).toEqual(["code", "pre"]);
		expect(htmlToMarkdown("<details><summary>a*b &lt;script&gt; <b>bold</b></summary><p>x</p></details>")).toBe("<details>\n<summary>a*b &lt;script&gt; bold</summary>\n\nx\n\n</details>");
	});

	test("the words of a link that is not kept as one make no tag with the text beside them", () => {
		expect(htmlToMarkdown('<p>&lt;<a href="javascript:x">script</a>&gt;alert(1)&lt;/<a>script</a>&gt;</p>')).toBe("&lt;script>alert(1)&lt;/script>");
		expect(htmlToMarkdown('<p>&lt;<a href="">img src=x onerror=alert(1)</a>&gt;</p>')).toBe("&lt;img src=x onerror=alert(1)>");
		expect(htmlToMarkdown("<p><a>a&lt;</a>script&gt;</p>")).toBe("a&lt;script>");
		expect(htmlToMarkdown('<p>&lt;<a href="script"></a>&gt;</p>')).toBe("&lt;script>");
		expect(render(htmlToMarkdown("<p>&amp;<a>copy;</a> <a>&amp;</a>copy; <a>&amp;#</a>35;</p>"))).toBe("<p>&amp;copy; &amp;copy; &amp;#35;</p>");
	});

	const BITS = ["a", "b", "word", "Sample", "ID", "x1", "9", "12", " ", " ", " ", "  ", "\n", "*", "**", "_", "__", "`", "``", "```", "~", "~~", "~~~", "[", "]", "(", ")", "<", ">", "&", "#", "# ", "## ", "-", "- ", "+ ", "1.", "1. ", "2) ", ".", "!", "|", "\\", "=", "===", "---", "- - -", "---- - -", "***", "___", ":", ";", "/", '"', "'", "^", "{", "}", "$", "%",
		"<script>", "</script>", "<div>", "</div>", "<!--", "-->", "<b>", "<img src=x onerror=alert(1)>", "<a href=x>", "<?php", "<DataSource>", "&amp;", "&lt;", "&gt;", "&#35;", "&copy;", "&nbsp;", "&colon;", "[x](y)", "![a](b)", "[a]: b", "[^1]", "[^1]: n", "| - |", "|---|", "--- | ---", ":--", "    ", "\t", "> ", ">", "snake_case", "_x_", "*x*", "<x@y>", "</", "<!", "\\*", "\\\\", "&#", "&x;"];
	const WRAPS: { name: string; wrap: (inner: string[]) => string; allowed: string[] }[] = [
		{ name: "p", wrap: (inner) => inner.map((t) => `<p>${t}</p>`).join("\n"), allowed: ["br", "p"] },
		{ name: "div", wrap: (inner) => inner.map((t) => `<div>\n    ${t}\n</div>`).join("\n"), allowed: ["br", "p"] },
		{ name: "ul", wrap: (inner) => `<ul>${inner.map((t) => `<li>${t}</li>`).join("")}</ul>`, allowed: ["br", "li", "ul"] },
		{ name: "ol", wrap: (inner) => `<ol>${inner.map((t) => `<li>${t}</li>`).join("")}</ol>`, allowed: ["br", "li", "ol"] },
		{ name: "h2", wrap: (inner) => inner.map((t) => `<h2>${t}</h2>`).join(""), allowed: ["br", "h2"] },
		{ name: "blockquote", wrap: (inner) => `<blockquote>${inner.map((t) => `<p>${t}</p>`).join("")}</blockquote>`, allowed: ["blockquote", "br", "p"] },
	];

	test("many pages of text alone: rendering the Markdown makes no element the page did not have, and shows the same text", () => {
		const { next, pick } = seeded(8);
		// As a page writes text: the characters HTML keeps for itself as references, by name or by number.
		const written = (text: string) =>
			text.replace(/[&<>"']/g, (ch) => (next() < 0.5 ? `&#${ch.charCodeAt(0)};` : ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" } as Record<string, string>)[ch]!)).replace(/\n/g, "<br>");
		// Some of the text stands in a link that is not kept as one (no address, or one that runs something) or in a
		// span: its words alone are left, and must not make a tag or a named character with the text beside them.
		const held = (text: string) => {
			if (!text || text !== text.trim() || next() < 0.6) return written(text);
			return pick([(t: string) => `<a>${t}</a>`, (t: string) => `<a href="javascript:alert(1)">${t}</a>`, (t: string) => `<span class="x">${t}</span>`])(written(text));
		};
		for (let round = 0; round < 5000; round++) {
			const wrap = pick(WRAPS);
			const pieces = Array.from({ length: 1 + Math.floor(next() * 3) }, () => Array.from({ length: 1 + Math.floor(next() * 3) }, () => Array.from({ length: 1 + Math.floor(next() * 4) }, () => pick(BITS)).join("")));
			const parts = pieces.map((of) => of.join(""));
			const html = wrap.wrap(pieces.map((of) => of.map(held).join("")));
			const md = htmlToMarkdown(html);
			const out = render(md);
			expect({ html, md, extra: elements(out).filter((name) => !wrap.allowed.includes(name)) }).toEqual({ html, md, extra: [] });
			expect({ html, md, shown: shown(out) }).toEqual({ html, md, shown: one(parts.map(one).join(" ")) });
		}
	});

	test("many links: one link each, to the address the page had, with the words the page had", () => {
		const { next, pick } = seeded(3);
		const ADDRESS = ["a", "b", "docs", "x.md", "/", "/", ".", ")", "(", " ", "<", ">", "\\", "&", "&copy;", "&amp;", "&lt;", "?q=1", "&r=2", "#frag", "%20", "[", "]", "*", "_", "`", "~", '"', "'", "é", "!", ":", "|"];
		const WORDS = ["text", "t", " ", "]", "[", "](", ")", "(", "*", "_", "`", "<b>", "&", "\\", "!", "|", "](javascript:alert(1))", "[x]", "![", "<", ">"];
		const START = ["https://x.test/", "http://x.test/", "docs/", "/abs/", "../up/", "mailto:a@b.test", "#", "x"];
		const inAttr = (text: string) => text.replace(/[&<>"]/g, (ch) => (next() < 0.4 ? `&#${ch.charCodeAt(0)};` : ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" } as Record<string, string>)[ch]!));
		const inText = (text: string) => text.replace(/[&<>]/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" } as Record<string, string>)[ch]!);
		const unescaped = (text: string) => {
			try {
				return decodeURIComponent(text);
			} catch {
				return text;
			}
		};
		for (let round = 0; round < 3000; round++) {
			const url = (pick(START) + Array.from({ length: Math.floor(next() * 6) }, () => pick(ADDRESS)).join("")).trim();
			const label = one(Array.from({ length: 1 + Math.floor(next() * 5) }, () => pick(WORDS)).join(""));
			if (!label) continue;
			const html = `<p>before <a href="${inAttr(url)}">${inText(label)}</a> after</p>`;
			const md = htmlToMarkdown(html);
			const out = render(md);
			const links = [...out.matchAll(/<a href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/g)];
			expect({ html, md, elements: elements(out) }).toEqual({ html, md, elements: ["a", "p"] });
			expect({ html, md, links: links.length }).toEqual({ html, md, links: 1 });
			expect({ html, md, href: unescaped(decodeHtmlEntities(links[0]![1]!)) }).toEqual({ html, md, href: unescaped(url) });
			expect({ html, md, words: one(decodeHtmlEntities(links[0]![2]!)) }).toEqual({ html, md, words: label });
			expect({ html, md, shown: shown(out) }).toEqual({ html, md, shown: `before ${label} after` });
		}
	});

	test("many addresses with a scheme that runs something, written every way a page can: none comes through", () => {
		const { next, pick } = seeded(5);
		const NAMED: Record<string, string[]> = { ":": ["&colon;"], "\t": ["&Tab;"], "\n": ["&NewLine;"] };
		const disguised = (ch: string) => {
			const roll = next();
			if (roll < 0.3) return next() < 0.5 ? ch.toUpperCase() : ch;
			if (roll < 0.45) return `&#${ch.charCodeAt(0)};`;
			if (roll < 0.55) return `&#x${ch.charCodeAt(0).toString(16)};`;
			if (roll < 0.65) return `&#0000${ch.charCodeAt(0)};`;
			if (roll < 0.9 && NAMED[ch]) return pick(NAMED[ch]!);
			return ch;
		};
		const between = () => pick(["", "", "", "&#9;", "&Tab;", "&#10;", "&NewLine;", "&#13;", "\t", "\n"]);
		const before = () => pick(["", "", " ", "  ", "&#32;", "&#1;", "&#31;", "\t"]);
		for (let round = 0; round < 3000; round++) {
			const scheme = pick(["javascript", "vbscript", "data"]);
			const url = before() + [...scheme].map((ch) => disguised(ch) + between()).join("") + disguised(":") + pick(["alert(1)", "text/html,x", "x"]);
			const link = htmlToMarkdown(`<p>a <a href="${url}">link</a> b</p>`);
			expect({ url, md: link }).toEqual({ url, md: "a link b" });
			const picture = htmlToMarkdown(`<p>a <img alt="pic" src="${url}"> b</p>`);
			expect({ url, md: picture }).toEqual({ url, md: "a [Image: pic] b" });
		}
	});
});
