// The low findings of the pass 4 audit in Word import and export (B11-6, B11-4, B11-11). Each test runs the code it
// names: documents are built in memory, read by `parseDocxToMarkdown`, and what it gives is put through the renderer
// the app uses. Nothing here goes to the network. One test starts a process of its own, to measure memory.
import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { deflateRawSync, inflateRawSync } from "node:zlib";
import { marked } from "marked";
import { markdownToDocx, parseDocxToMarkdown } from "../src/bun/docx";

const base = mkdtempSync(join(tmpdir(), "ssl-studio-p4l1-"));
afterAll(() => rmSync(base, { recursive: true, force: true }));

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

/** The files of a zip that the app wrote, by name: each stands whole after its own header. */
function unzip(bytes: Uint8Array): Map<string, string> {
	const files = new Map<string, string>();
	const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	const dec = new TextDecoder();
	let at = 0;
	while (at + 30 <= bytes.length && view.getUint32(at, true) === 0x04034b50) {
		const packed = view.getUint32(at + 18, true);
		const nameLength = view.getUint16(at + 26, true);
		const from = at + 30 + nameLength + view.getUint16(at + 28, true);
		files.set(dec.decode(bytes.subarray(at + 30, at + 30 + nameLength)), dec.decode(inflateRawSync(bytes.subarray(from, from + packed))));
		at = from + packed;
	}
	return files;
}

const W = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"';
const documentXml = (body: string) => `<?xml version="1.0"?><w:document ${W}><w:body>${body}</w:body></w:document>`;
const xml = (text: string) => text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const run = (text: string, props = "") => `<w:r>${props ? `<w:rPr>${props}</w:rPr>` : ""}<w:t xml:space="preserve">${text}</w:t></w:r>`;
const para = (inner: string, props = "") => `<w:p>${props ? `<w:pPr>${props}</w:pPr>` : ""}${inner}</w:p>`;
/** The Markdown of a document with this body. */
const read = (body: string) => parseDocxToMarkdown(zip([{ name: "word/document.xml", data: documentXml(body) }]), "Sample.docx").markdown;
/** The Markdown of one paragraph that says `text`. */
const readText = (text: string) => read(para(run(xml(text))));

const unhtml = (html: string) => html.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, "&");
/** What the renderer of the app makes of this Markdown: the text it shows, and where each link in it goes. */
function shown(markdown: string): { text: string; links: string[]; html: string } {
	const html = marked.parse(markdown, { gfm: true }) as string;
	return {
		text: unhtml(html.replace(/<[^>]+>/g, "")).trim(),
		links: [...html.matchAll(/<a href="([^"]*)"/g)].map((m) => unhtml(m[1]!)),
		html,
	};
}

// ---------------------------------------------------------------------------------------------------------------
// B11-6. An address that the document has in angle brackets
// ---------------------------------------------------------------------------------------------------------------

describe("B11-6 Word import: an address in angle brackets is a link to that address", () => {
	// `<https://support.docs.example>` was written `\<https://support.docs.example>`: the `<` is text then, and the
	// bare address after it takes the `>` for its last character, so the link went to `https://…example%3E`.
	test("the link goes to the address, and the brackets are shown as the document has them", () => {
		const cases: [string, string, string[]][] = [
			["<https://support.docs.example>", "\\<<https://support.docs.example>>", ["https://support.docs.example"]],
			["Contact <https://support.docs.example> today", "Contact \\<<https://support.docs.example>> today", ["https://support.docs.example"]],
			["<ftp://files.docs.example/x_y>", "\\<<ftp://files.docs.example/x_y>>", ["ftp://files.docs.example/x_y"]],
			["<HTTPS://DOCS.EXAMPLE/x>", "\\<<HTTPS://DOCS.EXAMPLE/x>>", ["HTTPS://DOCS.EXAMPLE/x"]],
			["<https://docs.example/q?a=1&b=2#frag>!", "\\<<https://docs.example/q?a=1&b=2#frag>>!", ["https://docs.example/q?a=1&b=2#frag"]],
			// With a sign in it, which was right before and is as it was.
			["<https://docs.example/a*b> and *more*", "\\<<https://docs.example/a*b>> and \\*more\\*", ["https://docs.example/a*b"]],
			// Two of them, and one in round brackets.
			["<https://docs.example/a>, <https://docs.example/b>", "\\<<https://docs.example/a>>, \\<<https://docs.example/b>>", ["https://docs.example/a", "https://docs.example/b"]],
			["(<https://docs.example/a>)", "(\\<<https://docs.example/a>>)", ["https://docs.example/a"]],
			// The `>` need not close a `<` that stands straight before the address: a bare address takes any `>`.
			["<URL:https://docs.example/a>", "\\<URL:<https://docs.example/a>>", ["https://docs.example/a"]],
			['<img src="https://docs.example/x.png">', '\\<img src="<https://docs.example/x.png>">', ["https://docs.example/x.png"]],
			["see https://docs.example/a>b", "see <https://docs.example/a>>b", ["https://docs.example/a"]],
			["<<https://docs.example>>", "<\\<<https://docs.example>>>", ["https://docs.example"]],
		];
		for (const [text, markdown, links] of cases) {
			const got = readText(text);
			const seen = shown(got);
			expect([text, got, seen.links, seen.text]).toEqual([text, markdown, links, text]);
		}
	});

	test("what stands after the address is not taken into it: a full stop, more text, the end of a cell", () => {
		const sentence = shown(readText("See <https://a.docs.example>."));
		expect(sentence.html.trim()).toBe('<p>See &lt;<a href="https://a.docs.example">https://a.docs.example</a>&gt;.</p>');
		const more = shown(readText("Write to <https://a.docs.example>and wait"));
		expect([more.links, more.text]).toEqual([["https://a.docs.example"], "Write to <https://a.docs.example>and wait"]);
		// A heading, a run in bold, and the cells of a table: a pipe in the address stays in its cell and in the link.
		expect(read(para(run(xml("Read <https://docs.example/a> first")), `<w:outlineLvl w:val="0"/>`))).toBe("# Read \\<<https://docs.example/a>> first");
		expect(read(para(run(xml("<https://docs.example/a>"), "<w:b/>")))).toBe("**\\<<https://docs.example/a>>**");
		const cell = (text: string) => `<w:tc>${para(run(xml(text)))}</w:tc>`;
		const table = read(`<w:tbl><w:tr>${cell("See <https://docs.example/a>.")}${cell("<https://docs.example/a|b>")}${cell("<lab@docs.example>")}</w:tr></w:tbl>`);
		expect(table).toBe("| See \\<<https://docs.example/a>>. | \\<<https://docs.example/a\\|b>> | \\<lab@docs.example> |\n| --- | --- | --- |");
		const html = marked.parse(table, { gfm: true }) as string;
		expect([...html.matchAll(/<th>(.*?)<\/th>/g)].map((m) => unhtml(m[1]!.replace(/<[^>]+>/g, "")))).toEqual(["See <https://docs.example/a>.", "<https://docs.example/a|b>", "<lab@docs.example>"]);
		expect(shown(table).links).toEqual(["https://docs.example/a", "https://docs.example/a%7Cb", "mailto:lab@docs.example"]);
		// The test that was there for an address in a cell, as it was: the brackets end before a backslash.
		const withBackslash = read(`<w:tbl><w:tr>${cell("https://docs.example/a*b\\|c")}</w:tr></w:tbl>`);
		expect(withBackslash).toBe("| <https://docs.example/a*b>\\\\\\|c |\n| --- |");
		expect(shown(withBackslash).links).toEqual(["https://docs.example/a*b"]);
	});

	test("a mail address in angle brackets is a link to it, `www.` with a `>` after it is text, and what is no address stays text", () => {
		const mail = shown(readText("mail <lab@docs.example> now"));
		expect([mail.links, mail.text]).toEqual([["mailto:lab@docs.example"], "mail <lab@docs.example> now"]);
		// No scheme, so no angle brackets can hold it: a backslash before its dot, as where a sign follows it.
		expect(readText("<www.docs.example>")).toBe("\\<www\\.docs.example>");
		expect(shown(readText("<www.docs.example>"))).toMatchObject({ links: [], text: "<www.docs.example>" });
		expect(readText("<not a url>")).toBe("\\<not a url>");
		expect(shown(readText("<not a url>"))).toMatchObject({ links: [], text: "<not a url>" });
		// An address cut short by a space ends there, as it did.
		const spaced = shown(readText("<https://docs.example/x y>"));
		expect([spaced.links, spaced.text]).toEqual([["https://docs.example/x"], "<https://docs.example/x y>"]);
	});

	test("an address with no `>` in it is written as it was", () => {
		const cases: [string, string][] = [
			["See https://docs.example/a_b?x=1&y=2. Also www.docs.example.", "See https://docs.example/a_b?x=1&y=2. Also www.docs.example."],
			["a > b, then https://docs.example/a_b and x -> www.docs.example", "a > b, then https://docs.example/a_b and x -> www.docs.example"],
			["at https://docs.example/_private/*x* here", "at <https://docs.example/_private/*x>\\* here"],
			["https://docs.example/a<b>", "<https://docs.example/a>\\<b>"],
			["www.docs.example/_a", "www\\.docs.example/\\_a"],
			["<https://docs.example", "\\<https://docs.example"],
			["a > b and 5 > 3", "a > b and 5 > 3"],
		];
		for (const [text, markdown] of cases) expect([text, readText(text)]).toEqual([text, markdown]);
	});

	// Texts of addresses, angle brackets and what stands around them, through the reader and the renderer: the text
	// is shown as it was written, and no link goes on past a `>`. Of these 600, 12 had such a link.
	test("six hundred texts of addresses and angle brackets: each is shown as written, and no link takes a `>`", () => {
		let seed = 5150;
		const rnd = (n: number) => {
			seed = (Math.imul(seed, 1103515245) + 12345) & 0x7fffffff;
			return (seed >>> 8) % n;
		};
		const bits = ["<", "<", ">", ">", "https://a.docs.example", "https://a.docs.example/x", "http://b.docs.example/y_z", "ftp://f.docs.example/q", "www.c.docs.example", "https://a.docs.example/a*b", "/p", "?q=1", ".", ",", ")", "(", " ", " ", " ", "see", "word", "*", "_", '"', "'", "!", "URL:", "lab@docs.example", "<b>", "|", "\\", "#x", "="];
		const wrong: string[] = [];
		for (let texts = 0; texts < 600; ) {
			let text = "";
			for (let i = 1 + rnd(7); i > 0; i--) text += bits[rnd(bits.length)];
			text = text.replace(/\s+/g, " ").trim();
			if (!text) continue;
			texts++;
			const inCell = texts % 3 === 0;
			const markdown = inCell ? read(`<w:tbl><w:tr><w:tc>${para(run(xml(text)))}</w:tc></w:tr></w:tbl>`) : readText(text);
			const seen = shown(markdown);
			if (seen.text.replace(/\s+/g, "") !== text.replace(/\s+/g, "") || seen.links.some((link) => /%3E|>/i.test(link))) wrong.push(JSON.stringify({ text, markdown, html: seen.html }));
		}
		expect(wrong.slice(0, 3)).toEqual([]);
	});
});

// ---------------------------------------------------------------------------------------------------------------
// B11-4. A text of nothing but signs
// ---------------------------------------------------------------------------------------------------------------

describe("B11-4 Word import: a text of signs is read in memory in proportion to it", () => {
	// A file of 2 KB that holds two million `*` took 260 MB to read, some 107 bytes a character: a string was joined
	// on for every sign, from a list of where the signs stood. It takes some 10 bytes a character now. Measured in a
	// process of its own, where nothing else has used memory before, and on Linux, where the numbers were taken.
	test.skipIf(process.platform !== "linux")("two million signs take a fraction of the memory they took", () => {
		const script = join(base, "signs.ts");
		writeFileSync(
			script,
			`import { deflateRawSync } from "node:zlib";
const { parseDocxToMarkdown } = await import(process.argv[2]);
const chars = 2_000_000;
const enc = new TextEncoder();
const name = enc.encode("word/document.xml");
const raw = enc.encode('<w:document ${W}><w:body><w:p><w:r><w:t>' + "*".repeat(chars) + "</w:t></w:r></w:p></w:body></w:document>");
const packed = new Uint8Array(deflateRawSync(raw));
const local = new Uint8Array(30 + name.length + packed.length);
const lv = new DataView(local.buffer);
lv.setUint32(0, 0x04034b50, true); lv.setUint16(8, 8, true); lv.setUint32(18, packed.length, true); lv.setUint32(22, raw.length, true); lv.setUint16(26, name.length, true);
local.set(name, 30); local.set(packed, 30 + name.length);
const central = new Uint8Array(46 + name.length);
const cv = new DataView(central.buffer);
cv.setUint32(0, 0x02014b50, true); cv.setUint16(10, 8, true); cv.setUint32(20, packed.length, true); cv.setUint32(24, raw.length, true); cv.setUint16(28, name.length, true);
central.set(name, 46);
const end = new Uint8Array(22);
const ev = new DataView(end.buffer);
ev.setUint32(0, 0x06054b50, true); ev.setUint16(8, 1, true); ev.setUint16(10, 1, true); ev.setUint32(12, central.length, true); ev.setUint32(16, local.length, true);
const bytes = Buffer.concat([local, central, end]);
Bun.gc(true);
const before = process.memoryUsage().rss;
const markdown = parseDocxToMarkdown(bytes, "Signs.docx").markdown;
const after = process.memoryUsage().rss;
console.log(JSON.stringify({ file: bytes.length, length: markdown.length, first: markdown.slice(0, 6), bytesEach: (after - before) / chars }));
`,
		);
		const state = join(base, "state");
		const ran = Bun.spawnSync([process.execPath, "--no-install", script, resolve(import.meta.dir, "../src/bun/docx.ts")], {
			env: { ...process.env, XDG_CONFIG_HOME: join(state, "config"), XDG_DATA_HOME: join(state, "data"), XDG_STATE_HOME: join(state, "state") },
			stdout: "pipe",
			stderr: "pipe",
		});
		expect(ran.stderr.toString()).toBe("");
		const told = JSON.parse(ran.stdout.toString()) as { file: number; length: number; first: string; bytesEach: number };
		expect(told.file).toBeLessThan(4000);
		expect([told.length, told.first]).toEqual([4_000_000, "\\*\\*\\*"]);
		// Some 10 now and 107 before, on the machine this was written on: the limit stands well clear of both.
		expect(told.bytesEach).toBeLessThan(40);
	}, 60_000);

	// What is written is made a string in blocks of 4,096 characters: texts that end at, before and after the edge of
	// a block, and addresses and signs that stand across one, come out as they always did.
	test("long texts come out as they did, whatever stands at the edge of a block", () => {
		for (const length of [1, 2047, 2048, 2049, 4095, 4096, 4097, 8191, 8192, 8193, 30_000]) {
			expect([length, readText("*".repeat(length)) === "\\*".repeat(length)]).toEqual([length, true]);
			// A backslash before a backslash is an escape, and so is the last one, before nothing.
			expect([length, readText("\\".repeat(length)) === "\\\\".repeat(length)]).toEqual([length, true]);
			expect([length, readText(`${"a".repeat(length)}*`) === `${"a".repeat(length)}\\*`]).toEqual([length, true]);
			// Characters of two bytes each, and a `_` that stands beside a space (between two letters it is left alone).
			expect([length, readText("_ 试".repeat(length)) === "\\_ 试".repeat(length)]).toEqual([length, true]);
			expect([length, readText("试_".repeat(length)) === `${"试_".repeat(length - 1)}试\\_`]).toEqual([length, true]);
		}
		for (let lead = 4070; lead < 4100; lead++) {
			const start = "a".repeat(lead);
			expect([lead, readText(`${start} https://docs.example/a_b* c`) === `${start} <https://docs.example/a_b>\\* c`]).toEqual([lead, true]);
			expect([lead, readText(`${start} www.docs.example/_a [x]`) === `${start} www\\.docs.example/\\_a \\[x\\]`]).toEqual([lead, true]);
			expect([lead, readText(`${start} \\https://docs.example/*x*`) === `${start} \\\\<https://docs.example/*x>\\*`]).toEqual([lead, true]);
		}
		// Nothing to escape: the text itself.
		const plain = "The limit is 5 mg/kg at pH = 7.2, SAMPLE_ID kept. ".repeat(400).trim();
		expect(readText(plain)).toBe(plain);
	});

	test("a text of signs is read in the time of a text, not of each sign", () => {
		const started = performance.now();
		const markdown = readText("*_`[".repeat(250_000));
		const took = performance.now() - started;
		expect(markdown.length).toBe(2_000_000);
		expect(markdown.startsWith("\\*\\_\\`\\[\\*")).toBe(true);
		// Tens of milliseconds; the limit is for a slow machine.
		expect(took).toBeLessThan(3000);
	});
});

// ---------------------------------------------------------------------------------------------------------------
// B11-11. A numbered list that the app wrote to Word
// ---------------------------------------------------------------------------------------------------------------

/** The Markdown that comes back from the Word file the app writes of this Markdown. */
const roundTrip = (markdown: string) => parseDocxToMarkdown(markdownToDocx({ title: "Method sheet", markdown, headerFooter: false }), "Method sheet.docx").markdown;

describe("B11-11 Word export: a numbered list is a numbered list of Word, and comes back as one", () => {
	// The number of an item was written as text, "1. first". The reader cannot tell that from a paragraph someone
	// began with "1." in Word, and gave both back as `1\. first`: a list sent out for review came back paragraphs.
	test("a list comes back a list, with the numbers the Markdown has", () => {
		expect(roundTrip("1. first\n2. second\n3. third")).toBe("1. first\n2. second\n3. third");
		expect(roundTrip("Steps:\n\n1. first\n2. second\n\nThen:\n\n5. fifth\n6. sixth")).toBe("Steps:\n\n1. first\n2. second\n\nThen:\n\n5. fifth\n6. sixth");
		// Numbers as the file has them, not as Word would count on: each written `1.`, one left out, one from nought.
		expect(roundTrip("1. one\n1. one again\n1. and again")).toBe("1. one\n1. one again\n1. and again");
		expect(roundTrip("1. one\n2. two\n4. four\n5. five")).toBe("1. one\n2. two\n4. four\n5. five");
		expect(roundTrip("0. nought\n1. one")).toBe("0. nought\n1. one");
		// A list under an item, begun where the file begins it, and begun again under the next item.
		expect(roundTrip("1. first\n   1. under it\n   2. under it too\n2. second\n   1. under the second")).toBe("1. first\n  1. under it\n  2. under it too\n2. second\n  1. under the second");
		expect(roundTrip("1. first\n   3. from three\n   4. four\n2. second")).toBe("1. first\n  3. from three\n  4. four\n2. second");
		// A bullet between two items does not send the count back to one.
		expect(roundTrip("1. first\n   - a bullet\n2. second")).toBe("1. first\n- a bullet\n2. second");
		// The text of an item is text still: what looks like a list in it is not one.
		expect(roundTrip("1. 2. not an inner list\n2. a * b and **bold**")).toBe("1. 2\\. not an inner list\n2. a \\* b and **bold**");
		// A quote keeps its numbers too.
		expect(roundTrip("> 1. quoted first\n> 2. quoted second")).toBe("1. quoted first\n2. quoted second");
	});

	test("the numbers are Word's own, each list counted by itself, and a file with no list has no numbering", () => {
		const files = unzip(markdownToDocx({ title: "Method sheet", markdown: "1. first\n2. second\n   3. under it\n\nBetween.\n\n7. seventh\n8. eighth", headerFooter: false }));
		const body = files.get("word/document.xml")!;
		// No number is written as text, and each item says which list it is of and how deep.
		expect(body).not.toMatch(/>\d+\. /);
		expect([...body.matchAll(/<w:numPr><w:ilvl w:val="(\d)"\/><w:numId w:val="(\d+)"\/><\/w:numPr>/g)].map((m) => `${m[2]}:${m[1]}`)).toEqual(["1:0", "1:0", "1:1", "2:0", "2:0"]);
		expect(body).toContain(`<w:t xml:space="preserve">first</w:t>`);
		// The indent of an item is what it was.
		expect(body).toContain(`<w:numPr><w:ilvl w:val="1"/><w:numId w:val="1"/></w:numPr><w:ind w:left="720" w:hanging="280"/><w:spacing w:before="20" w:after="40"/>`);
		// Each list has its own description, which says where each depth begins: 1 and 3, and 7.
		const numbering = files.get("word/numbering.xml")!;
		const starts = [...numbering.matchAll(/<w:abstractNum w:abstractNumId="(\d+)">(.*?)<\/w:abstractNum>/g)].map((m) => [...m[2]!.matchAll(/<w:start w:val="(\d+)"\/>/g)].map((s) => Number(s[1])).slice(0, 2));
		expect(starts).toEqual([
			[1, 3],
			[7, 1],
		]);
		expect([...numbering.matchAll(/<w:num w:numId="(\d+)"><w:abstractNumId w:val="(\d+)"\/><\/w:num>/g)].map((m) => `${m[1]}>${m[2]}`)).toEqual(["1>0", "2>1"]);
		expect(numbering).toContain(`<w:numFmt w:val="decimal"/><w:suff w:val="space"/><w:lvlText w:val="%1."/>`);
		// The part is named where Word looks for it.
		expect(files.get("[Content_Types].xml")).toContain(`<Override PartName="/word/numbering.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.numbering+xml"/>`);
		expect(files.get("word/_rels/document.xml.rels")).toMatch(/Type="http:\/\/schemas\.openxmlformats\.org\/officeDocument\/2006\/relationships\/numbering" Target="numbering\.xml"/);
		// The number of a quoted item is in the colour of the quote, as it was when it was text.
		const quoted = unzip(markdownToDocx({ title: "Method sheet", markdown: "> 1. quoted", headerFooter: false })).get("word/document.xml")!;
		expect(quoted).toMatch(/<w:numPr>.*?<\/w:numPr><w:pBdr>.*?<w:spacing w:before="20" w:after="40"\/><w:rPr><w:color w:val="475569"\/><\/w:rPr><\/w:pPr>/);

		const none = unzip(markdownToDocx({ title: "Method sheet", markdown: "- a bullet\n- [ ] a task\n\nA paragraph.", headerFooter: false }));
		expect(none.has("word/numbering.xml")).toBe(false);
		expect(none.get("[Content_Types].xml")).not.toContain("numbering");
		expect(none.get("word/_rels/document.xml.rels")).not.toContain("numbering");
	});

	test("where Word or the reader cannot keep a number it stays text, as it was", () => {
		// In a callout, which is a table cell in Word: the reader takes a paragraph in a cell for its text alone.
		const callout = "> [!note] Steps\n> 1. first in the callout\n> 2. second in the callout";
		expect(unzip(markdownToDocx({ title: "Method sheet", markdown: callout, headerFooter: false })).get("word/document.xml")).toContain(`<w:t xml:space="preserve">1. first in the callout</w:t>`);
		expect(roundTrip(callout)).toBe("| Steps<br>1. first in the callout<br>2. second in the callout |\n| --- |");
		// A number Word does not write so, and one it cannot start a list at.
		const odd = unzip(markdownToDocx({ title: "Method sheet", markdown: "007. an agent\n\n40000. a large number", headerFooter: false }));
		expect(odd.has("word/numbering.xml")).toBe(false);
		expect(odd.get("word/document.xml")).toContain(`<w:t xml:space="preserve">007. an agent</w:t>`);
		expect(odd.get("word/document.xml")).toContain(`<w:t xml:space="preserve">40000. a large number</w:t>`);
		// A file is given 2,000 lists and no more. Here every item is written `1.` and so is a list of its own: the
		// items after the 2,000th are written as they all were, with the number as text.
		const many = unzip(markdownToDocx({ title: "Method sheet", markdown: Array.from({ length: 2003 }, (_, at) => `1. step ${at + 1}`).join("\n"), headerFooter: false }));
		expect(many.get("word/numbering.xml")!.match(/<w:num /g)).toHaveLength(2000);
		expect(many.get("word/document.xml")!.match(/<w:numPr>/g)).toHaveLength(2000);
		expect(many.get("word/document.xml")).toContain(`<w:t xml:space="preserve">step 2000</w:t>`);
		expect(many.get("word/document.xml")).toContain(`<w:t xml:space="preserve">1. step 2001</w:t>`);
	});

	// The other half of the rule, which the fix must not weaken: what someone typed in Word is text.
	test("a paragraph typed in Word that only looks like a list item or a tag comes back as text", () => {
		expect(readText("1. Not a list item")).toBe("1\\. Not a list item");
		expect(readText("#notatag and 12) twelfth")).toBe("\\#notatag and 12) twelfth");
		// Beside a list that Word numbers, in one document: the list is a list, the typed paragraph is text.
		const numbering = `<w:numbering ${W}><w:abstractNum w:abstractNumId="0"><w:lvl w:ilvl="0"><w:start w:val="1"/><w:numFmt w:val="decimal"/></w:lvl></w:abstractNum><w:num w:numId="1"><w:abstractNumId w:val="0"/></w:num></w:numbering>`;
		const listed = `<w:numPr><w:ilvl w:val="0"/><w:numId w:val="1"/></w:numPr>`;
		const both = parseDocxToMarkdown(
			zip([
				{ name: "word/document.xml", data: documentXml(para(run("first"), listed) + para(run("second"), listed) + para(run("3. typed by hand")) + para(run("#typed"))) },
				{ name: "word/numbering.xml", data: numbering },
			]),
			"Sample.docx",
		).markdown;
		expect(both).toBe("1. first\n2. second\n\n3\\. typed by hand\n\n\\#typed");
	});
});
