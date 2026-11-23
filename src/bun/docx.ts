// Minimal, zero-dependency OpenXML (.docx) generator for STARLIMS stakeholder
// documents, Ticket Release Packets, and Deployment Manifests (Wave 3.6).
// Produces a standard OOXML package readable by Microsoft Word, LibreOffice
// Writer, and Google Docs — preserving headings, styled tables, shaded callout
// panels, fenced code blocks, lists, checklists, and inline bold/italic/code.
import { deflateRawSync } from "node:zlib";
import { frontMatter } from "../shared/frontMatter";

const xmlEsc = (s: string) =>
	s
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;")
		.replace(/'/g, "&apos;");

// --- Minimal ZIP writer (CRC32 + raw deflate) --------------------------------

const CRC_TABLE = (() => {
	const table = new Uint32Array(256);
	for (let i = 0; i < 256; i++) {
		let c = i;
		for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
		table[i] = c >>> 0;
	}
	return table;
})();

function crc32(buf: Uint8Array): number {
	let c = 0xffffffff;
	for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]!) & 0xff]! ^ (c >>> 8);
	return (c ^ 0xffffffff) >>> 0;
}

function buildZip(entries: { name: string; data: Uint8Array }[]): Uint8Array {
	const enc = new TextEncoder();
	const locals: Uint8Array[] = [];
	const centrals: Uint8Array[] = [];
	let offset = 0;

	for (const entry of entries) {
		const nameBytes = enc.encode(entry.name);
		const raw = entry.data;
		const compressed = new Uint8Array(deflateRawSync(raw));
		const crc = crc32(raw);

		const local = new Uint8Array(30 + nameBytes.length + compressed.length);
		const lv = new DataView(local.buffer);
		lv.setUint32(0, 0x04034b50, true); // Local file header signature
		lv.setUint16(4, 20, true); // Version needed (2.0)
		lv.setUint16(6, 0x0800, true); // UTF-8 filename flag
		lv.setUint16(8, 8, true); // Deflate compression
		lv.setUint16(10, 0, true);
		lv.setUint16(12, 0, true);
		lv.setUint32(14, crc, true);
		lv.setUint32(18, compressed.length, true);
		lv.setUint32(22, raw.length, true);
		lv.setUint16(26, nameBytes.length, true);
		lv.setUint16(28, 0, true);
		local.set(nameBytes, 30);
		local.set(compressed, 30 + nameBytes.length);
		locals.push(local);

		const central = new Uint8Array(46 + nameBytes.length);
		const cv = new DataView(central.buffer);
		cv.setUint32(0, 0x02014b50, true); // Central directory signature
		cv.setUint16(4, 20, true);
		cv.setUint16(6, 20, true);
		cv.setUint16(8, 0x0800, true);
		cv.setUint16(10, 8, true);
		cv.setUint16(12, 0, true);
		cv.setUint16(14, 0, true);
		cv.setUint32(16, crc, true);
		cv.setUint32(20, compressed.length, true);
		cv.setUint32(24, raw.length, true);
		cv.setUint16(28, nameBytes.length, true);
		cv.setUint16(30, 0, true);
		cv.setUint16(32, 0, true);
		cv.setUint16(34, 0, true);
		cv.setUint16(36, 0, true);
		cv.setUint32(38, 0, true);
		cv.setUint32(42, offset, true);
		central.set(nameBytes, 46);
		centrals.push(central);

		offset += local.length;
	}

	const centralSize = centrals.reduce((sum, b) => sum + b.length, 0);
	const eocd = new Uint8Array(22);
	const ev = new DataView(eocd.buffer);
	ev.setUint32(0, 0x06054b50, true);
	ev.setUint16(4, 0, true);
	ev.setUint16(6, 0, true);
	ev.setUint16(8, entries.length, true);
	ev.setUint16(10, entries.length, true);
	ev.setUint32(12, centralSize, true);
	ev.setUint32(16, offset, true);
	ev.setUint16(20, 0, true);

	const out = new Uint8Array(offset + centralSize + eocd.length);
	let pos = 0;
	for (const b of locals) (out.set(b, pos), (pos += b.length));
	for (const b of centrals) (out.set(b, pos), (pos += b.length));
	out.set(eocd, pos);
	return out;
}

// --- Markdown -> WordprocessingML runs & blocks ------------------------------

function inlineRuns(text: string): string {
	// Clean wikilinks/markdown links to readable text before inline formatting.
	const cleaned = text
		.replace(/!?\[\[[^[\]|]+\\?\|([^\]]+)\]\]/g, "$1")
		.replace(/!?\[\[([^\]]+)\]\]/g, "$1")
		.replace(/!\[([^\]]*)\]\([^)]*\)/g, (_, alt: string) => (alt ? `[Image: ${alt}]` : "[Image]"))
		.replace(/\[([^\]]+)\]\([^)]*\)/g, "$1");

	const tokens = cleaned.split(/(`[^`]+`|\*\*[^*]+\*\*|\*[^*]+\*|~~[^~]+~~)/g);
	return tokens
		.filter(Boolean)
		.map((tok) => {
			if (tok.startsWith("`") && tok.endsWith("`") && tok.length >= 2) {
				const inner = tok.slice(1, -1);
				return `<w:r><w:rPr><w:rFonts w:ascii="Consolas" w:hAnsi="Consolas"/><w:sz w:val="19"/><w:shd w:val="clear" w:color="auto" w:fill="F4F4F5"/></w:rPr><w:t xml:space="preserve">${xmlEsc(inner)}</w:t></w:r>`;
			}
			if (tok.startsWith("**") && tok.endsWith("**") && tok.length >= 4) {
				return `<w:r><w:rPr><w:b/></w:rPr><w:t xml:space="preserve">${xmlEsc(tok.slice(2, -2))}</w:t></w:r>`;
			}
			if (tok.startsWith("*") && tok.endsWith("*") && tok.length >= 2) {
				return `<w:r><w:rPr><w:i/></w:rPr><w:t xml:space="preserve">${xmlEsc(tok.slice(1, -1))}</w:t></w:r>`;
			}
			if (tok.startsWith("~~") && tok.endsWith("~~") && tok.length >= 4) {
				return `<w:r><w:rPr><w:strike/></w:rPr><w:t xml:space="preserve">${xmlEsc(tok.slice(2, -2))}</w:t></w:r>`;
			}
			return `<w:r><w:t xml:space="preserve">${xmlEsc(tok)}</w:t></w:r>`;
		})
		.join("");
}

function paragraph(runs: string, style?: string, extraPPr = ""): string {
	const pPr = style || extraPPr ? `<w:pPr>${style ? `<w:pStyle w:val="${style}"/>` : ""}${extraPPr}</w:pPr>` : "";
	return `<w:p>${pPr}${runs}</w:p>`;
}

function calloutBox(kind: string, title: string, bodyLines: string[]): string {
	const k = kind.toLowerCase();
	let border = "2563EB";
	let fill = "EFF6FF";
	if (/warn|caution|attention/.test(k)) (border = "D97706"), (fill = "FFFBEB");
	else if (/danger|error|bug|fail/.test(k)) (border = "DC2626"), (fill = "FEF2F2");
	else if (/tip|hint|success|check|done|ok/.test(k)) (border = "16A34A"), (fill = "F0FDF4");
	else if (/important|abstract|summary/.test(k)) (border = "7C3AED"), (fill = "F5F3FF");

	const titleP = paragraph(
		`<w:r><w:rPr><w:b/><w:color w:val="${border}"/></w:rPr><w:t xml:space="preserve">${xmlEsc(title || kind.toUpperCase())}</w:t></w:r>`,
		undefined,
		`<w:spacing w:before="60" w:after="60"/>`,
	);
	const bodyPs = bodyLines.map((l) => paragraph(inlineRuns(l), undefined, `<w:spacing w:before="20" w:after="40"/>`)).join("");
	return `<w:tbl><w:tblPr><w:tblW w:w="9360" w:type="dxa"/><w:tblBorders><w:top w:val="single" w:sz="4" w:color="CBD5E1"/><w:bottom w:val="single" w:sz="4" w:color="CBD5E1"/><w:right w:val="single" w:sz="4" w:color="CBD5E1"/><w:left w:val="single" w:sz="24" w:color="${border}"/></w:tblBorders><w:tblCellMar><w:top w:w="100" w:type="dxa"/><w:bottom w:w="100" w:type="dxa"/><w:left w:w="160" w:type="dxa"/><w:right w:w="140" w:type="dxa"/></w:tblCellMar></w:tblPr><w:tr><w:tc><w:tcPr><w:shd w:val="clear" w:color="auto" w:fill="${fill}"/></w:tcPr>${titleP}${bodyPs || paragraph("")}</w:tc></w:tr></w:tbl>${paragraph("", undefined, `<w:spacing w:before="0" w:after="80"/>`)}`;
}

function codeBox(codeLines: string[]): string {
	const ps = codeLines
		.map(
			(l) =>
				`<w:p><w:pPr><w:spacing w:before="0" w:after="0" w:line="240" w:lineRule="auto"/></w:pPr><w:r><w:rPr><w:rFonts w:ascii="Consolas" w:hAnsi="Consolas"/><w:sz w:val="18"/></w:rPr><w:t xml:space="preserve">${xmlEsc(l || " ")}</w:t></w:r></w:p>`,
		)
		.join("");
	return `<w:tbl><w:tblPr><w:tblW w:w="9360" w:type="dxa"/><w:tblBorders><w:top w:val="single" w:sz="4" w:color="E2E8F0"/><w:bottom w:val="single" w:sz="4" w:color="E2E8F0"/><w:left w:val="single" w:sz="4" w:color="E2E8F0"/><w:right w:val="single" w:sz="4" w:color="E2E8F0"/></w:tblBorders><w:tblCellMar><w:top w:w="90" w:type="dxa"/><w:bottom w:w="90" w:type="dxa"/><w:left w:w="140" w:type="dxa"/><w:right w:w="140" w:type="dxa"/></w:tblCellMar></w:tblPr><w:tr><w:tc><w:tcPr><w:shd w:val="clear" w:color="auto" w:fill="F8FAFC"/></w:tcPr>${ps || paragraph("")}</w:tc></w:tr></w:tbl>${paragraph("", undefined, `<w:spacing w:before="0" w:after="80"/>`)}`;
}

function splitPipeRow(line: string): string[] {
	const trimmed = line.trim().replace(/^\|/, "").replace(/\|$/, "");
	const cells: string[] = [];
	let cur = "";
	for (let i = 0; i < trimmed.length; i++) {
		if (trimmed[i] === "\\" && trimmed[i + 1] === "|") {
			cur += "|";
			i++;
		} else if (trimmed[i] === "|") {
			cells.push(cur.trim());
			cur = "";
		} else cur += trimmed[i]!;
	}
	cells.push(cur.trim());
	return cells;
}

function tableXml(headers: string[], rows: string[][]): string {
	const cols = Math.max(1, headers.length);
	const colW = Math.floor(9360 / cols);
	const makeCell = (text: string, isHeader: boolean) =>
		`<w:tc><w:tcPr><w:tcW w:w="${colW}" w:type="dxa"/>${isHeader ? '<w:shd w:val="clear" w:color="auto" w:fill="F4F4F5"/>' : ""}</w:tcPr>${paragraph(
			isHeader ? `<w:r><w:rPr><w:b/></w:rPr><w:t xml:space="preserve">${xmlEsc(text)}</w:t></w:r>` : inlineRuns(text),
			undefined,
			`<w:spacing w:before="40" w:after="40"/>`,
		)}</w:tc>`;

	const headerTr = `<w:tr><w:trPr><w:tblHeader/></w:trPr>${headers.map((h) => makeCell(h, true)).join("")}</w:tr>`;
	const bodyTrs = rows
		.map((r) => `<w:tr>${headers.map((_, i) => makeCell(r[i] ?? "", false)).join("")}</w:tr>`)
		.join("");
	return `<w:tbl><w:tblPr><w:tblW w:w="9360" w:type="dxa"/><w:tblBorders><w:top w:val="single" w:sz="4" w:color="D4D4D8"/><w:bottom w:val="single" w:sz="4" w:color="D4D4D8"/><w:left w:val="single" w:sz="4" w:color="D4D4D8"/><w:right w:val="single" w:sz="4" w:color="D4D4D8"/><w:insideH w:val="single" w:sz="4" w:color="E4E4E7"/><w:insideV w:val="single" w:sz="4" w:color="E4E4E7"/></w:tblBorders><w:tblCellMar><w:top w:w="60" w:type="dxa"/><w:bottom w:w="60" w:type="dxa"/><w:left w:w="100" w:type="dxa"/><w:right w:w="100" w:type="dxa"/></w:tblCellMar></w:tblPr>${headerTr}${bodyTrs}</w:tbl>${paragraph("", undefined, `<w:spacing w:before="0" w:after="80"/>`)}`;
}

/** Builds a valid `.docx` OpenXML binary archive from Markdown content. */
export function markdownToDocx(options: { title: string; subtitle?: string; markdown: string }): Uint8Array {
	const bodyText = frontMatter(options.markdown).body.replace(/\r\n/g, "\n");
	const lines = bodyText.split("\n");
	const blocks: string[] = [];

	if (options.subtitle) {
		blocks.push(paragraph(`<w:r><w:t xml:space="preserve">${xmlEsc(options.title)}</w:t></w:r>`, "Title"));
		blocks.push(
			paragraph(
				`<w:r><w:rPr><w:color w:val="52525B"/><w:sz w:val="20"/></w:rPr><w:t xml:space="preserve">${xmlEsc(options.subtitle)}</w:t></w:r>`,
				undefined,
				`<w:pBdr><w:bottom w:val="single" w:sz="6" w:space="6" w:color="E4E4E7"/></w:pBdr><w:spacing w:after="200"/>`,
			),
		);
	}

	let i = 0;
	while (i < lines.length) {
		const line = lines[i]!;
		if (!line.trim()) {
			i++;
			continue;
		}
		// Skip HTML comments
		if (/^[ \t]*<!--/.test(line)) {
			if (!/-->[ \t]*$/.test(line)) {
				i++;
				while (i < lines.length && !/-->/.test(lines[i]!)) i++;
			}
			i++;
			continue;
		}
		// Fenced code block
		const fence = /^[ \t]{0,3}(`{3,}|~{3,})/.exec(line);
		if (fence) {
			const delim = fence[1]![0]!;
			const len = fence[1]!.length;
			i++;
			const code: string[] = [];
			while (i < lines.length) {
				if (new RegExp(`^[ \\t]{0,3}${delim}{${len},}[ \\t]*$`).test(lines[i]!)) {
					i++;
					break;
				}
				code.push(lines[i]!);
				i++;
			}
			blocks.push(codeBox(code));
			continue;
		}
		// Callout block
		const callout = /^[ \t]{0,3}>[ \t]*\[!([A-Za-z0-9_-]+)\][+-]?[ \t]*(.*)$/.exec(line);
		if (callout) {
			const kind = callout[1]!;
			const title = callout[2]!.trim() || kind;
			i++;
			const body: string[] = [];
			while (i < lines.length && /^[ \t]{0,3}>/.test(lines[i]!)) {
				body.push(lines[i]!.replace(/^[ \t]{0,3}>[ \t]?/, ""));
				i++;
			}
			blocks.push(calloutBox(kind, title, body));
			continue;
		}
		// Blockquote
		if (/^[ \t]{0,3}>/.test(line)) {
			const body: string[] = [];
			while (i < lines.length && /^[ \t]{0,3}>/.test(lines[i]!)) {
				body.push(lines[i]!.replace(/^[ \t]{0,3}>[ \t]?/, ""));
				i++;
			}
			blocks.push(calloutBox("quote", "Note", body));
			continue;
		}
		// Pipe table
		if (line.includes("|") && i + 1 < lines.length && /^[ \t]*\|?[ \t:|-]+\|[ \t:|-]*$/.test(lines[i + 1]!)) {
			const headers = splitPipeRow(line);
			i += 2;
			const rows: string[][] = [];
			while (i < lines.length && lines[i]!.includes("|") && lines[i]!.trim()) {
				rows.push(splitPipeRow(lines[i]!));
				i++;
			}
			blocks.push(tableXml(headers, rows));
			continue;
		}
		// Heading
		const heading = /^[ \t]{0,3}(#{1,6})[ \t]+(.+?)[ \t]*#*[ \t]*$/.exec(line);
		if (heading) {
			const lvl = Math.min(4, heading[1]!.length);
			blocks.push(paragraph(inlineRuns(heading[2]!.trim()), `Heading${lvl}`));
			i++;
			continue;
		}
		// Horizontal rule
		if (/^[ \t]*(?:[-*_][ \t]*){3,}$/.test(line)) {
			blocks.push(paragraph("", undefined, `<w:pBdr><w:bottom w:val="single" w:sz="6" w:space="4" w:color="D4D4D8"/></w:pBdr><w:spacing w:before="120" w:after="120"/>`));
			i++;
			continue;
		}
		// Checklist or bullet/numbered list item
		const task = /^([ \t]*)[-*+][ \t]+\[([ xX])\][ \t]+(.*)$/.exec(line);
		if (task) {
			const indent = Math.floor(task[1]!.length / 2) * 360 + 360;
			const mark = task[2]!.toLowerCase() === "x" ? "☑ " : "☐ ";
			blocks.push(paragraph(inlineRuns(`${mark}${task[3]!}`), undefined, `<w:ind w:left="${indent}" w:hanging="240"/><w:spacing w:before="20" w:after="40"/>`));
			i++;
			continue;
		}
		const bullet = /^([ \t]*)[-*+][ \t]+(.*)$/.exec(line);
		if (bullet) {
			const indent = Math.floor(bullet[1]!.length / 2) * 360 + 360;
			blocks.push(paragraph(inlineRuns(`• ${bullet[2]!}`), undefined, `<w:ind w:left="${indent}" w:hanging="240"/><w:spacing w:before="20" w:after="40"/>`));
			i++;
			continue;
		}
		const ordered = /^([ \t]*)(\d+\.)[ \t]+(.*)$/.exec(line);
		if (ordered) {
			const indent = Math.floor(ordered[1]!.length / 2) * 360 + 360;
			blocks.push(paragraph(inlineRuns(`${ordered[2]!} ${ordered[3]!}`), undefined, `<w:ind w:left="${indent}" w:hanging="280"/><w:spacing w:before="20" w:after="40"/>`));
			i++;
			continue;
		}
		// Plain paragraph (coalesce consecutive plain lines)
		const paraLines: string[] = [line.trim()];
		i++;
		while (
			i < lines.length &&
			lines[i]!.trim() &&
			!/^[ \t]{0,3}(?:#{1,6}\s|>|`{3,}|~{3,}|[-*+]\s|\d+\.\s|<!--)/.test(lines[i]!) &&
			!(lines[i]!.includes("|") && i + 1 < lines.length && /^[ \t]*\|?[ \t:|-]+\|[ \t:|-]*$/.test(lines[i + 1]!))
		) {
			paraLines.push(lines[i]!.trim());
			i++;
		}
		blocks.push(paragraph(inlineRuns(paraLines.join(" ")), undefined, `<w:spacing w:before="40" w:after="120"/>`));
	}

	const documentXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
<w:body>
${blocks.join("\n")}
<w:sectPr><w:pgSz w:w="12240" w:h="15840"/><w:pgMar w:top="1080" w:right="1080" w:bottom="1080" w:left="1080"/></w:sectPr>
</w:body>
</w:document>`;

	const stylesXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
<w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:ascii="Calibri" w:hAnsi="Calibri"/><w:sz w:val="21"/><w:color w:val="18181B"/></w:rPr></w:rPrDefault></w:docDefaults>
<w:style w:type="paragraph" w:styleId="Title"><w:name w:val="Title"/><w:pPr><w:spacing w:before="0" w:after="80"/></w:pPr><w:rPr><w:b/><w:sz w:val="36"/><w:color w:val="09090B"/></w:rPr></w:style>
<w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="heading 1"/><w:pPr><w:keepNext/><w:spacing w:before="260" w:after="100"/><w:pBdr><w:bottom w:val="single" w:sz="4" w:space="4" w:color="E4E4E7"/></w:pBdr></w:pPr><w:rPr><w:b/><w:sz w:val="32"/><w:color w:val="09090B"/></w:rPr></w:style>
<w:style w:type="paragraph" w:styleId="Heading2"><w:name w:val="heading 2"/><w:pPr><w:keepNext/><w:spacing w:before="220" w:after="80"/></w:pPr><w:rPr><w:b/><w:sz w:val="26"/><w:color w:val="18181B"/></w:rPr></w:style>
<w:style w:type="paragraph" w:styleId="Heading3"><w:name w:val="heading 3"/><w:pPr><w:keepNext/><w:spacing w:before="180" w:after="60"/></w:pPr><w:rPr><w:b/><w:sz w:val="23"/><w:color w:val="27272A"/></w:rPr></w:style>
<w:style w:type="paragraph" w:styleId="Heading4"><w:name w:val="heading 4"/><w:pPr><w:keepNext/><w:spacing w:before="140" w:after="40"/></w:pPr><w:rPr><w:b/><w:sz w:val="21"/><w:color w:val="3F3F46"/></w:rPr></w:style>
</w:styles>`;

	const contentTypesXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="xml" ContentType="application/xml"/>
<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
<Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>
</Types>`;

	const rootRelsXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
</Relationships>`;

	const docRelsXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>
</Relationships>`;

	const enc = new TextEncoder();
	return buildZip([
		{ name: "[Content_Types].xml", data: enc.encode(contentTypesXml) },
		{ name: "_rels/.rels", data: enc.encode(rootRelsXml) },
		{ name: "word/_rels/document.xml.rels", data: enc.encode(docRelsXml) },
		{ name: "word/styles.xml", data: enc.encode(stylesXml) },
		{ name: "word/document.xml", data: enc.encode(documentXml) },
	]);
}
