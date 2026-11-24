// Purpose-built Markdown Info side-panel inspector (Properties, Ticket Work &
// Readiness, Linked Tickets, Schema Usages, and Links Inspector).
// Stays live-synced with the active Markdown document across Live, Read, and Source
// modes via the underlying Monaco ITextModel (ADR 0002).
import { createEffect, createMemo, createResource, createSignal, For, on, onCleanup, Show } from "solid-js";
import { Portal } from "solid-js/web";
import { placeAnchoredMenu, type RectBox } from "../../shared/contextMenu";
import { localDay } from "../../shared/dates";
import { evaluateTicketReadiness } from "../../shared/docExport";
import { linkLeads, withLinkFile } from "../../shared/docLinks";
import {
	addToFrontMatterList,
	formatFrontMatterInnerReplacement,
	frontMatter,
	frontMatterInnerSpan,
	one,
	quoteYamlScalar,
	removeFromFrontMatterList,
	stripEmptyFrontMatter,
	withFrontMatter,
} from "../../shared/frontMatter";
import { findHeadingLine } from "../../shared/markdownEdit";
import { docByName, linkedFrom, namedLink, nameFor } from "../../shared/namedLinks";
import { baseName, dirName, isInside, joinPath, relativeTo, resolvePath } from "../../shared/paths";
import { DOC_FOLDERS, isCatalog, registryTitle, statusChoices, toneOf } from "../../shared/projectDocs";
import { rowsLine } from "../../shared/registryTickets";
import { filterSchemaUsageGroups, groupSchemaUsages, type SchemaUsageCategory } from "../../shared/schemaIndex";
import { tagSearchPattern, workspaceTags } from "../../shared/tags";
import { descendantTickets, docLinkedTickets, ticketWork } from "../../shared/workContext";
import { backend } from "../backend";
import { ask, browseWorkspaceFile, choose, quickPick, type QuickPickOption } from "../dialogs";
import { createTextareaCompleter, type TextareaCompleter } from "../editor/cmCompletion";
import { buildHoverPreview, type HoverPreviewData } from "../editor/hoverPreview";
import { hydrateImagesInElement } from "../editor/imageResolve";
import { activeLiveEditor } from "../editor/liveBridge";
import { colourCode } from "../editor/markdownCode";
import {
	DATE_PROPERTY_KEYS,
	GOVERNANCE_PROPERTY_KEYS,
	hydrateMathInElement,
	isValidIsoDate,
	validateFrontmatterProperty,
} from "../editor/markdownHtml";
import {
	extractLineContextSnippet,
	extractOutgoingLinks,
	findUnlinkedMentions,
	linkifyMentionInText,
	mentionTermsForDoc,
	type OutgoingLinkItem,
	type UnlinkedMentionItem,
} from "../editor/markdownLinks";
import { monaco } from "../editor/monaco";
import { askRows } from "../editor/tableRows";
import { docAuditData } from "../docAudit";
import { FileMark } from "../FileMark";
import { gitStatus } from "../git";
import { Icon } from "../Icon";
import { Menu, type MenuItem } from "../Menu";
import { docs, isMarkdown } from "../project";
import {
	addRegistryRowForTicket,
	closeoutTicket,
	createTicketFolder,
	exportDeploymentManifest,
	exportDocAs,
	exportRtm,
	exportTicketPacket,
	generateSchemaDocFromSql,
	generateSqlFromSchemaDoc,
	generateTestExecutionProtocol,
	isArchivedTicket,
	linkDocumentToTicket,
	linkNonTicketToTicket,
	linkSchemaDocToSql,
	newKnowledge,
	newSpec,
	newTicket,
	newTicketFile,
	promoteQuestionToDecision,
	recordDocApproval,
	setStatus,
	unarchiveTicket,
	unlinkDocumentFromTicket,
	unlinkSchemaDocSql,
} from "../projectDocs";
import { activePath, canonical, documents, markdownMode, notify, openFile, save, setState, state } from "../state";
import {
	chooseDefaultLinksTab,
	computeMinimalTextChange,
	extractDisplayProperties,
	groupPropertiesForInspector,
	markdownPanelTabRequest,
	setMarkdownLinksSummary,
	setMarkdownYamlEditorOpen,
	type InspectorPropertyFact,
	type MarkdownLinksTab,
} from "./markdownBridge";
import { searchFor } from "./Search";

type HoverCardState = HoverPreviewData & {
	x: number;
	y: number;
	maxHeight: number;
	anchorRect: RectBox;
};

const LIST_PROP_KEYS = new Set(["tags", "tickets", "related", "blocks", "blocked-by", "specs", "plans"]);
const EDITABLE_LINK_KEYS = new Set(["parent", "ticket", "source", "supersedes", "superseded-by"]);
const QUICKPICK_SCALAR_KEYS = new Set([
	"status",
	"parent",
	"source",
	"ticket",
	"supersedes",
	"superseded-by",
	"direction",
	"type",
	"gxp-impact",
]);

const PROPERTY_DESCRIPTIONS: Record<string, string> = {
	status: "Workflow status",
	ticket: "Primary ticket key",
	tickets: "Linked ticket keys",
	parent: "Parent epic or ticket",
	related: "Related ticket keys",
	blocks: "Tickets blocked by this work",
	"blocked-by": "Tickets blocking this work",
	tags: "Categorization tags",
	specs: "Linked specification files",
	plans: "Linked process flowcharts",
	source: "External link or source schema",
	summary: "One-line document summary",
	type: "Ticket issue type",
	with: "External system partner",
	direction: "Message direction (in / out / both)",
	supersedes: "Earlier decision superseded",
	"superseded-by": "Newer decision superseding this",
	date: "Document date (YYYY-MM-DD)",
	asked: "Date question was raised (YYYY-MM-DD)",
	answered: "Date question was answered (YYYY-MM-DD)",
	created: "Creation date (YYYY-MM-DD)",
	updated: "Last updated date (YYYY-MM-DD)",
	due: "Target due date (YYYY-MM-DD)",
	version: "Controlled document version (e.g. 1.0, 1.1)",
	owner: "Document owner or author",
	reviewer: "Peer or QA reviewer",
	"approved-by": "Formal approver (ISO-17025 / GxP)",
	"approved-date": "Formal approval date (YYYY-MM-DD)",
	"effective-date": "Controlled effective date (YYYY-MM-DD)",
	"review-due": "Next periodic review due (YYYY-MM-DD)",
	"change-control": "Change control / CAPA reference ID",
	"gxp-impact": "Regulatory / GxP impact level",
};

/** Tracks the latest focus request sequence already acted upon across panel mounts. */
let lastConsumedFocusSeq = 0;

async function readFileText(path: string): Promise<string> {
	const key = canonical(path);
	const open = documents.get(key);
	if (open) return open.model.getValue();
	try {
		return (await backend.read(path)).text;
	} catch {
		return "";
	}
}

export function MarkdownInspector() {
	const path = createMemo(() => {
		const p = activePath();
		return p && isMarkdown(p) ? canonical(p) : "";
	});
	const activeMdDoc = createMemo(() => {
		const p = path();
		if (!p) return undefined;
		const d = documents.get(p);
		return d && !d.binary ? d : undefined;
	});
	const isRead = createMemo(() => {
		const p = path();
		return Boolean(p && markdownMode(p) === "read");
	});

	const [text, setText] = createSignal("");
	const [propsOpen, setPropsOpen] = createSignal(true);
	const [editYaml, setEditYaml] = createSignal(false);
	const [workOpen, setWorkOpen] = createSignal(true);
	const [workGuideOpen, setWorkGuideOpen] = createSignal(false);
	const [readinessOpen, setReadinessOpen] = createSignal(false);
	const [linkedTicketsOpen, setLinkedTicketsOpen] = createSignal(true);
	const [sqlSourceOpen, setSqlSourceOpen] = createSignal(true);
	const [schemaUsagesOpen, setSchemaUsagesOpen] = createSignal(false);
	const [usageFilter, setUsageFilter] = createSignal("");
	const [usageGroupFold, setUsageGroupFold] = createSignal<Partial<Record<SchemaUsageCategory, boolean>>>({});
	const [usageGroupShowAll, setUsageGroupShowAll] = createSignal<Partial<Record<SchemaUsageCategory, boolean>>>({});
	const [usageExpandedFiles, setUsageExpandedFiles] = createSignal<Record<string, boolean>>({});
	const [linksOpen, setLinksOpen] = createSignal(false);
	const [linksTab, setLinksTab] = createSignal<MarkdownLinksTab>("backlinks");
	const [linksRefresh, setLinksRefresh] = createSignal(0);
	const [editingProp, setEditingProp] = createSignal<{ key: string; value: string; draft: string; isDate: boolean } | null>(null);
	const [hoverCard, setHoverCard] = createSignal<HoverCardState | null>(null);

	let propsSectionEl: HTMLElement | undefined;
	let workSectionEl: HTMLElement | undefined;
	let linksSectionEl: HTMLElement | undefined;
	let yamlInputEl: HTMLTextAreaElement | undefined;
	let yamlEditBtnEl: HTMLButtonElement | undefined;
	let yamlCompleter: TextareaCompleter | undefined;
	let hoverCardEl: HTMLDivElement | undefined;
	let hoverBodyEl: HTMLDivElement | undefined;
	let lastYamlEditAt = 0;

	// Sync live text with the open Monaco model across Live, Read, and Source modes.
	createEffect(() => {
		const d = activeMdDoc();
		if (!d) {
			setText("");
			return;
		}
		setText(d.model.getValue());
		const sub = d.model.onDidChangeContent(() => {
			setText(d.model.getValue());
		});
		onCleanup(() => sub.dispose());
	});

	// Publish YAML editor open state so Live-mode Replace All knows whether frontmatter is being edited.
	createEffect(() => {
		setMarkdownYamlEditorOpen(editYaml() && !isRead());
	});
	onCleanup(() => {
		setMarkdownYamlEditorOpen(false);
		yamlCompleter?.dispose();
		yamlCompleter = undefined;
	});

	// Reset transient editing states when switching files or entering Read mode.
	createEffect(
		on(path, (p) => {
			yamlCompleter?.dispose();
			yamlCompleter = undefined;
			setEditYaml(false);
			setEditingProp(null);
			setWorkGuideOpen(false);
			setHoverCard(null);
			if (!p) return;
			const cur = documents.get(p)?.model.getValue() ?? "";
			const hasFm = Boolean(frontMatterInnerSpan(cur)) || extractDisplayProperties(frontMatter(cur).values).length > 0;
			setPropsOpen(hasFm);
			setWorkOpen(true);
			setReadinessOpen(false);
			setLinkedTicketsOpen(true);
			setSqlSourceOpen(true);
			setSchemaUsagesOpen(false);
			setUsageFilter("");
			setUsageGroupFold({});
			setUsageGroupShowAll({});
			setUsageExpandedFiles({});
		}),
	);

	createEffect(
		on(isRead, (read) => {
			if (!read) return;
			setEditingProp(null);
			if (editYaml()) {
				yamlCompleter?.dispose();
				yamlCompleter = undefined;
				setEditYaml(false);
			}
		}),
	);

	// --- Model Editing (ADR 0002: single source of truth via Monaco model) ---
	const applyDocTextUpdate = (nextText: string, coalesceUndo = false) => {
		const d = activeMdDoc();
		if (!d) return;
		const prev = d.model.getValue();
		const diff = computeMinimalTextChange(prev, nextText);
		if (!diff) return;
		const from = d.model.getPositionAt(diff.start);
		const to = d.model.getPositionAt(diff.endPrev);
		const range = new monaco.Range(from.lineNumber, from.column, to.lineNumber, to.column);
		if (!coalesceUndo) d.model.pushStackElement();
		d.model.pushEditOperations([], [{ range, text: diff.insert, forceMoveMarkers: true }], () => null);
		if (!coalesceUndo) d.model.pushStackElement();
	};

	const resizeYamlInput = (el: HTMLTextAreaElement | undefined) => {
		if (!el) return;
		el.style.height = "auto";
		el.style.height = `${Math.max(48, el.scrollHeight)}px`;
	};

	const front = createMemo(() => frontMatter(text()));
	const yamlSpan = createMemo(() => frontMatterInnerSpan(text()));
	const facts = createMemo(() => extractDisplayProperties(front().values));
	const groupedFacts = createMemo(() => groupPropertiesForInspector(facts()));

	createEffect(() => {
		const open = editYaml();
		const inner = yamlSpan()?.inner ?? "";
		if (!open) return;
		queueMicrotask(() => {
			if (!yamlInputEl) return;
			if (yamlInputEl.value !== inner) yamlInputEl.value = inner;
			resizeYamlInput(yamlInputEl);
		});
	});

	createEffect(() => {
		if (!editYaml() || typeof ResizeObserver === "undefined") return;
		let ro: ResizeObserver | undefined;
		const frame = requestAnimationFrame(() => {
			if (!yamlInputEl) return;
			resizeYamlInput(yamlInputEl);
			ro = new ResizeObserver(() => resizeYamlInput(yamlInputEl));
			ro.observe(yamlInputEl);
		});
		onCleanup(() => {
			cancelAnimationFrame(frame);
			ro?.disconnect();
		});
	});

	const applyYamlInnerEdit = (nextInner: string) => {
		const d = activeMdDoc();
		if (!d) return;
		const cur = d.model.getValue();
		const span = frontMatterInnerSpan(cur);
		if (!span) return;
		const replacement = formatFrontMatterInnerReplacement(nextInner, span.eol);
		if (cur.slice(span.start, span.end) === replacement) return;
		const now = Date.now();
		const coalesce = now - lastYamlEditAt < 450;
		lastYamlEditAt = now;
		const nextDoc = `${cur.slice(0, span.start)}${replacement}${cur.slice(span.end)}`;
		applyDocTextUpdate(nextDoc, coalesce);
	};

	const focusYamlInput = () => {
		queueMicrotask(() => {
			if (!yamlInputEl) return;
			yamlInputEl.focus();
			yamlInputEl.scrollIntoView({ block: "nearest" });
		});
	};

	const ensureFrontmatterAndOpenYaml = () => {
		if (isRead()) return;
		const p = path();
		const d = activeMdDoc();
		if (!p || !d) return;
		const cur = d.model.getValue();
		if (!frontMatterInnerSpan(cur)) {
			if (/^\s*---\s*$/m.test(cur.split(/\r?\n/)[0] ?? "")) {
				notify("Fix the unclosed YAML frontmatter block (missing closing ---) in Source mode first.", "error");
				return;
			}
			const eol = d.model.getEOL();
			const stem = baseName(p).replace(/\.(md|markdown)$/i, "");
			applyDocTextUpdate(`---${eol}title: ${quoteYamlScalar(stem)}${eol}---${eol}${eol}${cur}`);
		}
		setPropsOpen(true);
		setEditYaml(true);
		focusYamlInput();
	};

	const toggleEditYaml = () => {
		if (isRead()) return;
		if (editYaml()) {
			yamlCompleter?.dispose();
			yamlCompleter = undefined;
			setEditYaml(false);
			yamlEditBtnEl?.focus();
			return;
		}
		ensureFrontmatterAndOpenYaml();
	};

	// --- Document Metadata, Ticket Work, Readiness, Schema Usages & Links ----
	const listed = createMemo(() => {
		const p = path();
		return p ? docs().find((d) => canonical(d.path) === p) : undefined;
	});
	const ticket = createMemo(() => {
		const p = path();
		if (!p) return "";
		const file = docs().find((d) => d.group === "tickets" && d.ticket && canonical(d.path) === p);
		return file?.ticket ?? "";
	});
	const work = createMemo(() => (ticket() ? ticketWork(docs(), ticket()) : []));
	const totalWorkItems = createMemo(() => {
		const items = work().reduce((sum, g) => sum + g.items.length, 0);
		return items + (listed()?.ticketFolder ? 1 : 0);
	});
	const readiness = createMemo(() =>
		ticket() ? evaluateTicketReadiness(docs(), ticket(), { gitFiles: gitStatus()?.files, root: state.workspace?.root }) : null,
	);
	const linkedTickets = createMemo(() => {
		const p = path();
		return p && !ticket() ? docLinkedTickets(docs(), p) : [];
	});

	const workRollup = createMemo(() => {
		const me = listed();
		const groups = work();
		if (!ticket() || !me) return [];
		const allDocs = docs();
		const parts: string[] = [];
		const descendants = descendantTickets(allDocs, ticket());
		const activeSubs = descendants.filter((s) => toneOf(s.status) !== "off");
		if (activeSubs.length) {
			const done = activeSubs.filter((s) => toneOf(s.status) === "done").length;
			parts.push(`${done}/${activeSubs.length} sub-tickets done`);
		}
		const scopeDocs = [me, ...activeSubs];
		const taskTotal = scopeDocs.reduce((sum, d) => sum + (d.tasks?.total ?? 0), 0);
		const taskDone = scopeDocs.reduce((sum, d) => sum + (d.tasks?.done ?? 0), 0);
		if (taskTotal > 0) parts.push(`${taskDone}/${taskTotal} tasks`);
		const openQs = groups.find((g) => g.kind === "question")?.files.length ?? 0;
		if (openQs > 0) parts.push(`${openQs} open ${openQs === 1 ? "question" : "questions"}`);
		const scopeKeySet = new Set(scopeDocs.map((d) => d.ticket?.toLowerCase()).filter(Boolean) as string[]);
		const regRows = allDocs
			.filter((d) => d.exists && d.group === "registries" && !isCatalog(d) && d.forTickets?.length)
			.reduce(
				(acc, reg) => {
					for (const hit of reg.forTickets ?? []) {
						if (scopeKeySet.has(hit.key.toLowerCase())) {
							acc.total += hit.rows;
							acc.done += hit.done ?? 0;
						}
					}
					return acc;
				},
				{ total: 0, done: 0 },
			);
		if (regRows.total > 0) parts.push(`${regRows.done}/${regRows.total} registry rows`);
		return parts;
	});

	const knownTicketsSet = createMemo(() => {
		const out = new Set<string>();
		for (const d of docs()) {
			if (d.exists && d.group === "tickets" && d.ticket) out.add(d.ticket.toLowerCase());
		}
		return out;
	});

	const [allWorkspaceFiles] = createResource(
		() => (state.workspace?.root ? { root: state.workspace.root, ver: state.treeVersion } : null),
		async () => backend.files().catch(() => [] as string[]),
	);

	const workspaceFilesSet = createMemo(() => {
		const out = new Set<string>();
		for (const d of docs()) {
			if (d.exists) out.add(d.path.replace(/\\/g, "/").toLowerCase());
		}
		for (const f of allWorkspaceFiles() ?? []) {
			out.add(f.replace(/\\/g, "/").toLowerCase());
		}
		return out;
	});

	// Reverse Schema -> Code & Registries usages card for documented `schema/` files.
	const schemaIdent = createMemo(() => {
		const doc = listed();
		if (!doc || doc.group !== "schema" || isCatalog(doc)) return "";
		return baseName(doc.path).replace(/\.(md|markdown)$/i, "").trim();
	});

	// Explicit SQL DDL source state for database schema Markdown docs (no invisible frontmatter magic).
	const sqlSourceInfo = createMemo(() => {
		const doc = listed();
		const p = path();
		if (!doc || !p || doc.group !== "schema" || isCatalog(doc)) return null;
		const rawSource = one(front().values.source)?.trim() ?? "";
		const isSql = Boolean(rawSource && !/^https?:\/\//i.test(rawSource) && /\.(sql|ddl|pks|pkb)$/i.test(rawSource));
		if (doc.kind !== "database" && !isSql) return null;
		const root = state.workspace?.root ?? "";
		const resolvedPath = isSql
			? /^\.{1,2}[\\/]/.test(rawSource)
				? resolvePath(dirName(p), rawSource)
				: root
					? joinPath(root, rawSource)
					: rawSource
			: "";
		const exists = Boolean(resolvedPath && workspaceFilesSet().has(resolvedPath.replace(/\\/g, "/").toLowerCase()));
		const drifts = (docAuditData().schemaDrift ?? []).filter((d) => canonical(d.schemaPath) === p);
		const sharedCount = isSql
			? docs().filter(
					(d) =>
						d.exists &&
						d.group === "schema" &&
						canonical(d.path) !== p &&
						d.source?.trim().toLowerCase() === rawSource.toLowerCase(),
				).length
			: 0;
		const stem = baseName(p).replace(/\.(md|markdown)$/i, "");
		return {
			stem,
			rawSource: isSql ? rawSource : "",
			resolvedPath,
			exists,
			missing: isSql && !exists,
			drifts,
			sharedCount,
		};
	});
	const [schemaUsages] = createResource(
		() => {
			const ident = schemaIdent();
			const root = state.workspace?.root;
			return ident && root ? { ident, root, version: state.treeVersion } : null;
		},
		async ({ ident, root }) => {
			const cleanDir = (dir?: string) => (dir ?? "").replace(/^[./\\]+|[\\/]+$/g, "").replace(/\\/g, "/");
			const dRel = cleanDir(state.project?.docs ?? "docs");
			const pRel = cleanDir(state.project?.plans ?? "design");
			const sRel = cleanDir(state.project?.schema ?? "schema");
			const exclude = [dRel ? `${dRel}/**` : "", pRel ? `${pRel}/**` : "", sRel ? `${sRel}/**` : "", "README.md", "AGENTS.md", "**/INDEX.md"]
				.filter(Boolean)
				.join(", ");
			const hits = await backend.search(ident, { wholeWord: true, exclude }).catch(() => []);
			const codeHits = hits.map((h) => ({
				path: h.path,
				rel: relativeTo(root, h.path).replace(/\\/g, "/"),
				line: h.line,
				text: h.text,
			}));
			const regHits = docs()
				.filter(
					(d) =>
						d.exists &&
						d.group === "registries" &&
						!isCatalog(d) &&
						d.codeRefs?.some((ref) => ref.toLowerCase() === ident.toLowerCase() || ref.toLowerCase().endsWith(`.${ident.toLowerCase()}`)),
				)
				.map((d) => ({
					path: d.path,
					title: registryTitle(d.name),
					fileName: baseName(d.path),
					rel: relativeTo(root, d.path).replace(/\\/g, "/"),
				}));
			const groups = groupSchemaUsages(codeHits, regHits, {
				testsFolder: state.project?.tests,
				canonicalize: canonical,
			});
			const totalFiles = groups.reduce((sum, g) => sum + g.items.length, 0);
			const totalRefs = groups.reduce((sum, g) => sum + g.totalHits, 0);
			return { ident, exclude, groups, totalFiles, totalRefs };
		},
	);

	// Workspace Backlinks, Outgoing Links, and Unlinked Mentions.
	const docsFingerprint = createMemo(() => {
		const list = docs();
		return `${list.length}:${list.map((d) => `${d.path}|${d.title ?? ""}|${d.broken?.length ?? 0}`).join("\n")}`;
	});

	const [linked] = createResource(
		() => {
			const p = path();
			const root = state.workspace?.root;
			return p && root ? { path: p, sig: docsFingerprint(), root, rev: linksRefresh() } : null;
		},
		async (src) => {
			if (!src) return [];
			const files = docs();
			try {
				const [byPath, byName] = await Promise.all([backend.linksTo(src.path), backend.namesIn()]);
				const hits = linkedFrom(
					canonical(src.path),
					byPath.map((link) => ({ path: canonical(link.path), line: link.line })),
					byName.map((place) => ({ ...place, path: canonical(place.path) })),
					files.map((file) => ({ ...file, path: canonical(file.path) })),
					src.root,
				);
				return await Promise.all(
					hits.map(async (item) => {
						const content = await readFileText(item.path);
						return { ...item, snippet: extractLineContextSnippet(content, item.line) };
					}),
				);
			} catch {
				return [];
			}
		},
	);

	const outgoingLinks = createMemo<OutgoingLinkItem[]>(() => {
		const p = path();
		if (!p) return [];
		return extractOutgoingLinks(text(), p, docs(), {
			root: state.workspace?.root,
			broken: listed()?.broken,
		});
	});
	const brokenOutgoingCount = createMemo(() => outgoingLinks().filter((o) => o.broken).length);

	const [unlinkedMentions] = createResource(
		() => {
			const p = path();
			const root = state.workspace?.root;
			if (!p || !root) return null;
			const me = listed();
			const title = me?.title || one(front().values.title) || "";
			const tKey = ticket();
			const stem = baseName(p).replace(/\.(md|markdown)$/i, "");
			const linkedPaths = (linked() ?? []).map((b) => canonical(b.path));
			return { path: p, root, title, ticket: tKey, stem, sig: docsFingerprint(), linkedPaths, rev: linksRefresh() };
		},
		async (src) => {
			if (!src) return [] as UnlinkedMentionItem[];
			const terms = mentionTermsForDoc({ title: src.title, ticket: src.ticket, stem: src.stem });
			if (!terms.length) return [] as UnlinkedMentionItem[];
			const linkedSet = new Set(src.linkedPaths.map((p) => canonical(p)));
			const allMd = new Map<string, { path: string; name: string; title?: string }>();
			for (const d of docs()) {
				if (!d.exists || !/\.(md|markdown)$/i.test(d.path)) continue;
				const k = canonical(d.path);
				if (k === canonical(src.path) || linkedSet.has(k)) continue;
				allMd.set(k, { path: d.path, name: d.name, title: d.title });
			}
			if (!allMd.size) return [] as UnlinkedMentionItem[];
			const candidatePaths = new Set<string>();
			for (const term of terms.slice(0, 2)) {
				const hits = await backend.search(term, { wholeWord: true, caseSensitive: false }).catch(() => []);
				for (const h of hits) {
					const k = canonical(h.path);
					if (allMd.has(k)) candidatePaths.add(k);
					if (candidatePaths.size >= 24) break;
				}
				if (candidatePaths.size >= 24) break;
			}
			if (!candidatePaths.size) return [] as UnlinkedMentionItem[];
			const candidates = await Promise.all(
				[...candidatePaths].map(async (k) => {
					const info = allMd.get(k)!;
					return { ...info, text: await readFileText(info.path) };
				}),
			);
			return findUnlinkedMentions(
				{ path: src.path, title: src.title, ticket: src.ticket, stem: src.stem },
				candidates,
				linkedSet,
			);
		},
	);

	const totalLinksCount = createMemo(
		() => (linked()?.length ?? 0) + outgoingLinks().length + (unlinkedMentions()?.length ?? 0),
	);

	// Publish live link counts back to the compact editor strip & Objects tab badge.
	createEffect(() => {
		const p = path();
		if (!p) return;
		const backlinks = linked()?.length ?? 0;
		const outgoing = outgoingLinks().length;
		const unlinked = unlinkedMentions()?.length ?? 0;
		const broken = brokenOutgoingCount();
		setMarkdownLinksSummary({
			path: p,
			backlinks,
			outgoing,
			unlinked,
			broken,
			total: backlinks + outgoing + unlinked,
		});
	});

	// Respond to editor focus requests (`properties`, `yaml`, `work`, `links`).
	createEffect(() => {
		const req = markdownPanelTabRequest();
		if (!req || req.tab !== "info" || !req.focus || req.seq <= lastConsumedFocusSeq) return;
		lastConsumedFocusSeq = req.seq;
		const target = req.focus;
		if (target === "properties") {
			setPropsOpen(true);
			requestAnimationFrame(() => propsSectionEl?.scrollIntoView({ behavior: "smooth", block: "start" }));
		} else if (target === "yaml") {
			if (!isRead()) ensureFrontmatterAndOpenYaml();
			else setPropsOpen(true);
			requestAnimationFrame(() => propsSectionEl?.scrollIntoView({ behavior: "smooth", block: "start" }));
		} else if (target === "work") {
			setWorkOpen(true);
			requestAnimationFrame(() => workSectionEl?.scrollIntoView({ behavior: "smooth", block: "start" }));
		} else if (target === "links") {
			setLinksOpen(true);
			setLinksTab(
				chooseDefaultLinksTab({
					backlinks: linked()?.length ?? 0,
					outgoing: outgoingLinks().length,
					unlinked: unlinkedMentions()?.length ?? 0,
					brokenOutgoing: brokenOutgoingCount(),
					backlinksLoading: linked.loading,
				}),
			);
			requestAnimationFrame(() => linksSectionEl?.scrollIntoView({ behavior: "smooth", block: "start" }));
		}
	});

	// --- Navigation, Property Pickers & Link Actions -------------------------
	const called = (targetPath: string) => {
		const key = canonical(targetPath);
		const file = docs().find((d) => canonical(d.path) === key);
		if (!file) return relativeTo(state.workspace?.root, targetPath);
		const title = file.title || file.name;
		return file.ticket && !title.toLowerCase().startsWith(file.ticket.toLowerCase()) ? `${file.ticket}: ${title}` : title;
	};

	const jumpToLine = (line: number, column = 1) => {
		const p = path();
		if (!p) return;
		const live = activeLiveEditor();
		if (live && canonical(live.path) === p) {
			live.reveal({ line, column });
			return;
		}
		void openFile(p, { reveal: { line, column } });
	};

	const followHeadingInFile = async (targetPath: string, heading: string) => {
		const content = await readFileText(targetPath);
		const line = findHeadingLine(content, heading);
		if (canonical(targetPath) === path() && line) {
			jumpToLine(line);
			return;
		}
		await openFile(targetPath, line ? { reveal: { line } } : {});
	};

	const followLink = async (href: string) => {
		const p = path();
		if (!p) return;
		const leads = linkLeads(href, p, state.workspace?.root);
		if (!leads) return;
		if ("web" in leads) return void window.open(leads.web, "_blank", "noopener");
		if ("heading" in leads) {
			const line = findHeadingLine(text(), leads.heading);
			if (line) jumpToLine(line);
			return;
		}
		if (!leads.lines && href.includes("#")) {
			const hash = decodeURIComponent(href.slice(href.indexOf("#") + 1));
			if (hash) return void followHeadingInFile(leads.file, hash);
		}
		await openFile(leads.file, leads.lines ? { reveal: leads.lines } : {});
	};

	const followWiki = async (innerRaw: string) => {
		const p = path();
		if (!p) return;
		const bar = innerRaw.indexOf("|");
		const targetPart = (bar < 0 ? innerRaw : innerRaw.slice(0, bar)).trim();
		if (targetPart.startsWith("#")) {
			const heading = targetPart.slice(1).trim();
			const line = findHeadingLine(text(), heading);
			if (line) jumpToLine(line);
			return;
		}
		const parsed = namedLink(innerRaw.replace(/\\\|/g, "|"));
		if (!parsed) return;
		const root = state.workspace?.root;
		const found = docByName(parsed.name, docs(), root);
		if (found) {
			if (parsed.heading) return void followHeadingInFile(found.path, parsed.heading);
			await openFile(found.path);
			return;
		}
		if (!root) return;
		const safeName = parsed.name.replace(/[\\/:*?"<>|]+/g, "-").trim();
		if (!safeName) return;
		const fileName = /\.md$/i.test(safeName) ? safeName : `${safeName}.md`;
		const dest = joinPath(dirName(p), fileName);
		if (!isInside(root, dest)) return;
		const picked = await choose(`No note named "${parsed.name}" exists yet. Create ${relativeTo(root, dest)}?`, ["Create note"]);
		if (picked !== "Create note") return;
		try {
			await backend.create(dest, "file");
			await backend.write(dest, `# ${parsed.name.replace(/\.md$/i, "")}\n\n`);
			setState("treeVersion", (v) => v + 1);
			await openFile(dest);
		} catch (e: any) {
			notify(`Could not create note: ${e?.message ?? e}`, "error");
		}
	};

	const ticketFile = (key: string) => {
		const found = docs().find((d) => d.group === "tickets" && d.exists && d.ticket?.toLowerCase() === key.trim().toLowerCase());
		if (found) return found.path;
		if (!state.workspace || !state.project) return "";
		const parts = state.project.docs.split(/[\\/]/).filter((p) => p && p !== ".");
		return joinPath(state.workspace.root, ...parts, DOC_FOLDERS.tickets, `${key.trim()}.md`);
	};

	const targetOf = (key: string, value: string): { file?: string; web?: string; display?: string } => {
		if (/^https?:\/\//i.test(value)) return { web: value };
		const wiki = /^\[\[([^[\]]+)\]\]$/.exec(value.trim());
		if (wiki && state.workspace) {
			const parsed = namedLink(wiki[1]!);
			const found = parsed ? docByName(parsed.name, docs(), state.workspace.root) : null;
			if (found) return { file: found.path, display: parsed?.words || parsed?.name || value };
		}
		if (["ticket", "tickets", "related", "parent", "blocks", "blocked-by"].includes(key)) return { file: ticketFile(value) };
		if (["supersedes", "superseded-by"].includes(key) && state.workspace) {
			const found = docByName(value.trim(), docs(), state.workspace.root);
			if (found) return { file: found.path, display: found.title || value };
		}
		if (["specs", "spec", "plan", "plans", "source"].includes(key) && state.workspace && path()) {
			const clean = value.trim().replace(/\\/g, "/");
			if (!clean) return {};
			const resolved =
				clean.startsWith("./") || clean.startsWith("../")
					? resolvePath(dirName(path()), clean)
					: resolvePath(state.workspace.root, clean.replace(/^\/+/, ""));
			return isInside(state.workspace.root, resolved) ? { file: resolved } : {};
		}
		return {};
	};

	const go = (target: { file?: string; web?: string }) =>
		target.web ? void window.open(target.web, "_blank", "noopener") : target.file ? void openFile(target.file) : undefined;

	const isListProperty = (key: string) => LIST_PROP_KEYS.has(key) || Array.isArray(front().values[key]);

	const pickValueForProperty = async (key: string): Promise<string | null> => {
		const p = path();
		const root = state.workspace?.root;
		const all = docs().filter((d) => d.exists && !isCatalog(d));
		const CUSTOM = "__custom__";
		if (key === "status") {
			const choices = statusChoices(listed());
			const curStatus = one(front().values.status).toLowerCase();
			return await quickPick<string>({
				title: "Choose status",
				placeholder: "Filter statuses…",
				items: choices.map((s) => ({
					label: s,
					value: s,
					checked: s.toLowerCase() === curStatus,
					badge: { text: s, tone: toneOf(s) },
				})),
			});
		}
		if (key === "direction") {
			return await quickPick<string>({
				title: "Message direction",
				searchable: false,
				items: [
					{ label: "in", value: "in", icon: "arrow-left", detail: "Inbound into STARLIMS" },
					{ label: "out", value: "out", icon: "arrow-right", detail: "Outbound to external system" },
					{ label: "both", value: "both", icon: "sync", detail: "Bidirectional interface" },
				],
			});
		}
		if (key === "type") {
			const picked = await quickPick<string>({
				title: "Ticket type",
				placeholder: "Filter ticket types…",
				items: [
					{ label: "Task", value: "Task", icon: "checklist" },
					{ label: "Story", value: "Story", icon: "note" },
					{ label: "Bug", value: "Bug", icon: "bug" },
					{ label: "Epic", value: "Epic", icon: "layers" },
					{ label: "Sub-task", value: "Sub-task", icon: "list-tree" },
					{ label: "Enter custom value…", value: CUSTOM, icon: "edit", divide: true },
				],
			});
			if (!picked) return null;
			return picked === CUSTOM ? (await ask("Custom ticket type:"))?.trim() || null : picked;
		}
		if (key === "gxp-impact") {
			const picked = await quickPick<string>({
				title: "GxP / regulatory impact",
				searchable: false,
				items: [
					{ label: "high", value: "high", badge: { text: "high", tone: "blocked" }, detail: "Direct impact on validated lab data or patient safety" },
					{ label: "medium", value: "medium", badge: { text: "medium", tone: "waiting" }, detail: "Indirect GxP workflow or configuration impact" },
					{ label: "low", value: "low", badge: { text: "low", tone: "active" }, detail: "Minimal regulatory impact" },
					{ label: "none", value: "none", badge: { text: "none", tone: "off" }, detail: "No GxP impact" },
					{ label: "Enter custom value…", value: CUSTOM, icon: "edit", divide: true },
				],
			});
			if (!picked) return null;
			return picked === CUSTOM ? (await ask("Custom gxp-impact value:"))?.trim() || null : picked;
		}
		if (DATE_PROPERTY_KEYS.has(key)) {
			return (await ask(`Value for ${key} (YYYY-MM-DD):`, localDay()))?.trim() || null;
		}
		if (["ticket", "tickets", "parent", "related", "blocks", "blocked-by"].includes(key)) {
			const ticketDocs = all.filter((d) => d.group === "tickets" && d.ticket);
			if (ticketDocs.length) {
				const picked = await quickPick<string>({
					title: `Choose ticket for ${key}`,
					placeholder: "Search by ticket key, title, or status…",
					items: [
						...ticketDocs.map(
							(d): QuickPickOption<string> => ({
								label: d.ticket!,
								value: d.ticket!,
								icon: "checklist",
								detail: d.title && !d.title.toLowerCase().startsWith(d.ticket!.toLowerCase()) ? d.title : undefined,
								badge: d.status ? { text: d.status, tone: toneOf(d.status) } : undefined,
								keywords: `${d.ticket} ${d.title ?? ""} ${d.status ?? ""}`,
							}),
						),
						{ label: "Enter custom ticket key…", value: CUSTOM, icon: "edit", divide: true },
					],
				});
				if (!picked) return null;
				if (picked !== CUSTOM) return picked;
			}
			return (await ask(`Value for ${key}:`))?.trim() || null;
		}
		if (key === "supersedes" || key === "superseded-by") {
			const decisions = all.filter((d) => d.group === "knowledge" && d.kind === "decisions" && canonical(d.path) !== p);
			if (decisions.length) {
				const picked = await quickPick<string>({
					title: `Choose decision for ${key}`,
					placeholder: "Search decisions…",
					items: [
						...decisions.map((d): QuickPickOption<string> => {
							const stem = baseName(d.path).replace(/\.(md|markdown)$/i, "");
							return {
								label: stem,
								value: stem,
								icon: "note",
								detail: d.title || d.name,
								badge: d.status ? { text: d.status, tone: toneOf(d.status) } : undefined,
							};
						}),
						{ label: "Enter custom decision stem…", value: CUSTOM, icon: "edit", divide: true },
					],
				});
				if (!picked) return null;
				if (picked !== CUSTOM) return picked;
			}
			return (await ask(`Decision stem for ${key}:`))?.trim() || null;
		}
		if (key === "tags") {
			const existingTags = workspaceTags(all);
			if (existingTags.length) {
				const picked = await quickPick<string>({
					title: "Choose tag",
					placeholder: "Filter workspace tags…",
					items: [
						...existingTags.map(
							(t): QuickPickOption<string> => ({
								label: `#${t.tag}`,
								value: t.tag,
								icon: "tag",
								detail: `${t.count} ${t.count === 1 ? "doc" : "docs"}`,
							}),
						),
						{ label: "Enter new tag…", value: CUSTOM, icon: "add", divide: true },
					],
				});
				if (!picked) return null;
				if (picked !== CUSTOM) return picked;
			}
			return (await ask("New tag name (without #)"))?.trim().replace(/^#+/, "") || null;
		}
		if ((key === "specs" || key === "plans") && root) {
			const grp = key === "specs" ? "specs" : "plans";
			const pinned = all
				.filter((d) => d.group === grp)
				.map((d) => ({
					path: d.path,
					rel: relativeTo(root, d.path).replace(/\\/g, "/"),
					detail: d.title || undefined,
				}));
			const initialSub =
				grp === "plans"
					? state.project?.plans ?? "design"
					: joinPath(state.project?.docs ?? "docs", DOC_FOLDERS.specs);
			const initialDir = resolvePath(root, initialSub);
			const picked = await browseWorkspaceFile({
				title: grp === "specs" ? "Select specification file" : "Select plan file",
				root,
				initialDir: isInside(root, initialDir) ? initialDir : root,
				pinned,
				pinnedLabel: grp === "specs" ? "Spec" : "Plan",
				exclude: p ? [p] : [],
			});
			return picked ? picked.rel : null;
		}
		if (key === "source") {
			const grp = listed()?.group;
			if (grp === "tickets") {
				return (await ask("Ticket URL (https://…):", one(front().values.source) || "https://"))?.trim() || null;
			}
			if (grp === "schema" && root) {
				const pinned = all
					.filter((d) => d.group === "schema" && /\.(sql|ddl|pks|pkb|json|xml|xsd)$/i.test(d.name))
					.map((d) => ({
						path: d.path,
						rel: relativeTo(root, d.path).replace(/\\/g, "/"),
						detail: d.title || undefined,
					}));
				const schemaDir = resolvePath(root, state.project?.schema ?? "schema");
				const picked = await browseWorkspaceFile({
					title: "Select source schema file",
					root,
					initialDir: isInside(root, schemaDir) ? schemaDir : root,
					pinned,
					pinnedLabel: "Schema",
					exclude: p ? [p] : [],
				});
				return picked ? picked.rel : null;
			}
			return (await ask("Value for source:", one(front().values.source)))?.trim() || null;
		}
		return (await ask(`Value for ${key}:`))?.trim() || null;
	};

	const commitInlinePropertyEdit = (key: string, origVal: string, nextRaw: string, isDate: boolean) => {
		const trimmed = nextRaw.trim();
		setEditingProp(null);
		if (!trimmed || trimmed === origVal) return;
		if (isDate && !isValidIsoDate(trimmed)) return;
		const cur = activeMdDoc()?.model.getValue() ?? text();
		const next = withFrontMatter(cur, key, trimmed);
		if (next && next !== cur) applyDocTextUpdate(next);
	};

	const startInlinePropertyEdit = (key: string, currentVal: string) => {
		if (isRead()) return;
		const isDate = DATE_PROPERTY_KEYS.has(key.toLowerCase());
		const initialDraft = isDate ? (isValidIsoDate(currentVal) ? currentVal.trim() : "") : currentVal;
		setEditingProp({ key, value: currentVal, draft: initialDraft, isDate });
	};

	const editScalarPropertyInteractive = async (key: string, currentVal: string) => {
		if (isRead()) return;
		if (!QUICKPICK_SCALAR_KEYS.has(key)) {
			startInlinePropertyEdit(key, currentVal);
			return;
		}
		const nextVal = await pickValueForProperty(key);
		if (!nextVal || nextVal === currentVal) return;
		const cur = activeMdDoc()?.model.getValue() ?? text();
		const next = withFrontMatter(cur, key, nextVal);
		if (next && next !== cur) applyDocTextUpdate(next);
	};

	const commonKeysForDoc = (): { group: string; keys: readonly string[] }[] => {
		const doc = listed();
		let primary: string[];
		if (doc?.group === "knowledge" && doc.kind === "decisions") {
			primary = ["status", "ticket", "tickets", "supersedes", "superseded-by", "date", "summary", "tags"];
		} else if (doc?.group === "knowledge" && doc.kind === "questions") {
			primary = ["status", "ticket", "tickets", "asked", "answered", "summary", "tags"];
		} else if (doc?.group === "schema" && doc.kind === "interfaces") {
			primary = ["status", "with", "direction", "source", "ticket", "summary", "tags"];
		} else if (doc?.group === "tickets") {
			primary = ["status", "type", "summary", "source", "parent", "blocks", "blocked-by", "related", "specs", "plans", "tags", "due"];
		} else {
			primary = ["status", "ticket", "tickets", "parent", "related", "blocks", "blocked-by", "tags", "specs", "plans", "source", "summary", "created", "updated"];
		}
		return [
			{ group: "Document", keys: primary },
			{ group: "Governance", keys: GOVERNANCE_PROPERTY_KEYS },
		];
	};

	const addPropertyValueInteractive = async (explicitKey?: string) => {
		if (isRead()) return;
		const p = path();
		if (!p) return;
		let key = explicitKey;
		if (!key) {
			const CUSTOM_KEY = "__custom_prop__";
			const APPROVAL_ACTION = "__record_approval__";
			const groups = commonKeysForDoc();
			const existing = new Set(Object.keys(front().values).map((k) => k.toLowerCase()));
			const items: QuickPickOption<string>[] = [];
			for (let gIdx = 0; gIdx < groups.length; gIdx++) {
				const grp = groups[gIdx]!;
				grp.keys.forEach((k, idx) => {
					items.push({
						label: k,
						value: k,
						icon: grp.group === "Governance" ? "pass" : DATE_PROPERTY_KEYS.has(k) ? "checklist" : k === "tags" ? "tag" : "symbol-key",
						detail: grp.group,
						description: PROPERTY_DESCRIPTIONS[k],
						checked: existing.has(k.toLowerCase()),
						divide: gIdx > 0 && idx === 0,
						keywords: `${grp.group} ${k} ${PROPERTY_DESCRIPTIONS[k] ?? ""}`,
					});
				});
			}
			items.push(
				{
					label: "Record Approval / Bump Version…",
					value: APPROVAL_ACTION,
					icon: "pass-filled",
					detail: "Governance",
					description: "Record formal approval metadata or increment controlled version",
					divide: true,
				},
				{
					label: "Custom property…",
					value: CUSTOM_KEY,
					icon: "add",
					detail: "Enter any YAML key",
				},
			);
			const picked = await quickPick<string>({
				title: "Add or update YAML property",
				placeholder: "Filter document or governance properties…",
				items,
			});
			if (!picked) return;
			if (picked === APPROVAL_ACTION) {
				await recordDocApproval(p);
				return;
			}
			if (picked === CUSTOM_KEY) {
				key = (await ask("Property name (e.g. owner, version, system)"))?.trim().toLowerCase().replace(/[^a-z0-9_-]/g, "");
				if (!key) return;
			} else {
				key = picked;
			}
		}
		const val = await pickValueForProperty(key);
		if (!val) return;
		const cur = activeMdDoc()?.model.getValue() ?? text();
		if (!frontMatterInnerSpan(cur)) {
			if (/^\s*---\s*$/m.test(cur.split(/\r?\n/)[0] ?? "")) {
				notify("Fix the unclosed YAML frontmatter block (missing closing ---) before adding properties.", "error");
				return;
			}
			const eol = cur.includes("\r\n") ? "\r\n" : "\n";
			const safe = quoteYamlScalar(val);
			const lineVal = LIST_PROP_KEYS.has(key) ? `[${safe}]` : safe;
			applyDocTextUpdate(`---${eol}${key}: ${lineVal}${eol}---${eol}${eol}${cur}`);
			setPropsOpen(true);
			return;
		}
		const next = isListProperty(key) ? addToFrontMatterList(cur, key, val) : withFrontMatter(cur, key, val);
		if (next && next !== cur) {
			applyDocTextUpdate(next);
			setPropsOpen(true);
		} else if (next === null) {
			notify(`Could not update property "${key}" - click YAML to edit its raw block.`, "error");
		}
	};

	const removePropertyValue = (key: string, value: string, totalValues: number) => {
		if (isRead()) return;
		const cur = activeMdDoc()?.model.getValue() ?? text();
		if (totalValues > 1 || isListProperty(key)) {
			const next = removeFromFrontMatterList(cur, key, value);
			if (next && next !== cur) {
				const cleaned = stripEmptyFrontMatter(next);
				applyDocTextUpdate(cleaned);
				if (!frontMatterInnerSpan(cleaned)) setEditYaml(false);
				return;
			}
		}
		const span = frontMatterInnerSpan(cur);
		if (!span) return;
		const keyEsc = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
		const lines = span.inner.split(/\r?\n/);
		const idx = lines.findLastIndex((l) => new RegExp(`^${keyEsc}\\s*:`, "i").test(l));
		if (idx < 0) return;
		let endIdx = idx + 1;
		while (endIdx < lines.length && /^[ \t]*-\s+/.test(lines[endIdx]!)) endIdx++;
		lines.splice(idx, endIdx - idx);
		const replacement = formatFrontMatterInnerReplacement(lines.join("\n"), span.eol);
		const nextDoc = stripEmptyFrontMatter(`${cur.slice(0, span.start)}${replacement}${cur.slice(span.end)}`);
		applyDocTextUpdate(nextDoc);
		if (!frontMatterInnerSpan(nextDoc)) setEditYaml(false);
	};

	const linkifyUnlinkedMention = async (mention: UnlinkedMentionItem) => {
		const p = path();
		if (!p) return;
		const root = state.workspace?.root;
		const me = listed();
		const wikiName = (me ? nameFor(me, docs(), root) : null) ?? baseName(p).replace(/\.(md|markdown)$/i, "");
		if (!wikiName) return;
		const key = canonical(mention.path);
		const openDoc = documents.get(key);
		const curText = openDoc ? openDoc.model.getValue() : await readFileText(mention.path);
		const next = linkifyMentionInText(curText, mention.line, mention.column, mention.matchedText, wikiName);
		if (!next || next === curText) {
			notify("That mention moved or was already updated.");
			setLinksRefresh((v) => v + 1);
			return;
		}
		try {
			if (openDoc) {
				openDoc.model.pushStackElement();
				openDoc.model.pushEditOperations([], [{ range: openDoc.model.getFullModelRange(), text: next, forceMoveMarkers: true }], () => null);
				openDoc.model.pushStackElement();
				if (!state.dirty[key]) await save(key);
			} else {
				await backend.historyKeep(mention.path).catch(() => {});
				await backend.write(mention.path, next);
			}
			setState("treeVersion", (v) => v + 1);
			setLinksRefresh((v) => v + 1);
			notify(`Linked mention in ${called(key)}.`);
		} catch (err: any) {
			notify(`Could not link mention: ${err?.message ?? err}`, "error");
		}
	};

	const exportMenuItems = (): MenuItem[] => {
		const p = path();
		if (!p) return [];
		const t = ticket();
		const me = listed();
		return [
			{ label: "Copy as rich HTML", run: () => void exportDocAs(p, "html-copy") },
			{ label: "Copy as Jira / Confluence markup", run: () => void exportDocAs(p, "jira-copy") },
			"separator",
			{ label: "Print / Save as PDF…", run: () => void exportDocAs(p, "print") },
			{ label: "Export standalone HTML…", run: () => void exportDocAs(p, "html-download") },
			{ label: "Export as Word (.docx)…", run: () => void exportDocAs(p, "docx") },
			...(!isRead()
				? [
						"separator" as const,
						{ label: "Record Approval…", run: () => void recordDocApproval(p) },
					]
				: []),
			...(t
				? [
						"separator" as const,
						{ label: `Export ${t} packet (HTML)…`, run: () => void exportTicketPacket(p, t, "html") },
						{ label: `Export ${t} packet (Word .docx)…`, run: () => void exportTicketPacket(p, t, "docx") },
						{ label: `Export ${t} packet (Markdown)…`, run: () => void exportTicketPacket(p, t, "markdown") },
						"separator" as const,
						{ label: "Deployment manifest (Markdown)…", run: () => void exportDeploymentManifest(p, t, "markdown") },
						{ label: "Deployment manifest (CSV)…", run: () => void exportDeploymentManifest(p, t, "csv") },
						{ label: "Deployment manifest (HTML)…", run: () => void exportDeploymentManifest(p, t, "html") },
						{ label: "Deployment manifest (Word .docx)…", run: () => void exportDeploymentManifest(p, t, "docx") },
						"separator" as const,
						{ label: `Requirements Traceability Matrix (RTM)…`, run: () => void exportRtm(undefined, me ? { tickets: [me] } : undefined) },
						{ label: "Generate Test Execution Protocol…", run: () => void generateTestExecutionProtocol(p) },
					]
				: []),
		];
	};

	// --- Obsidian Hover Page Preview for sidebar links -----------------------
	let hoverTimer: ReturnType<typeof setTimeout> | undefined;
	let hideTimer: ReturnType<typeof setTimeout> | undefined;
	let cardHovered = false;

	const cancelHover = () => {
		clearTimeout(hoverTimer);
		clearTimeout(hideTimer);
	};
	onCleanup(cancelHover);

	const scheduleHideHover = () => {
		clearTimeout(hoverTimer);
		clearTimeout(hideTimer);
		hideTimer = setTimeout(() => {
			if (!cardHovered) setHoverCard(null);
		}, 180);
	};

	const clampHoverCard = () => {
		const card = hoverCard();
		if (!card || !hoverCardEl) return;
		const box = hoverCardEl.getBoundingClientRect();
		const width = box.width > 0 ? box.width : Math.min(440, window.innerWidth - 24);
		const height = box.height > 0 ? box.height : 220;
		const placed = placeAnchoredMenu(card.anchorRect, { width, height }, { width: window.innerWidth, height: window.innerHeight }, 12, 8);
		hoverCardEl.style.left = `${Math.round(placed.left)}px`;
		hoverCardEl.style.top = `${Math.round(placed.top)}px`;
		hoverCardEl.style.maxHeight = `${Math.round(Math.min(360, placed.maxHeight))}px`;
	};

	const hoverFileButton = (targetPath: string | undefined, anchor: HTMLElement, extra: { line?: number; ticket?: string } = {}) => {
		if (!targetPath) return;
		clearTimeout(hideTimer);
		clearTimeout(hoverTimer);
		const rect = anchor.getBoundingClientRect();
		hoverTimer = setTimeout(async () => {
			const preview = await buildHoverPreview(targetPath, { line: extra.line, ticket: extra.ticket });
			if (!preview) return;
			const anchorRect: RectBox = { left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom };
			const estW = Math.min(440, Math.max(220, window.innerWidth - 24));
			const placed = placeAnchoredMenu(anchorRect, { width: estW, height: 220 }, { width: window.innerWidth, height: window.innerHeight }, 12, 8);
			setHoverCard({
				...preview,
				x: Math.round(placed.left),
				y: Math.round(placed.top),
				maxHeight: Math.min(360, Math.round(placed.maxHeight)),
				anchorRect,
			});
			requestAnimationFrame(() => {
				if (hoverBodyEl) {
					hydrateImagesInElement(hoverBodyEl, targetPath);
					hydrateMathInElement(hoverBodyEl);
					void colourCode(hoverBodyEl).then(() => requestAnimationFrame(clampHoverCard));
				}
				clampHoverCard();
			});
		}, 320);
	};

	// --- Reusable Property Row Renderer --------------------------------------
	const PropertyRow = (rowProps: { fact: InspectorPropertyFact }) => (
		<div class="md-insp-prop-row">
			<dt class="md-insp-prop-key">{rowProps.fact.key}</dt>
			<dd class="md-insp-prop-val">
				<For each={rowProps.fact.values}>
					{(value) => {
						const target = () => targetOf(rowProps.fact.key, value);
						const isEditingThis = () => {
							const ed = editingProp();
							return Boolean(ed && ed.key === rowProps.fact.key && ed.value === value);
						};
						const issue = createMemo(() =>
							validateFrontmatterProperty(rowProps.fact.key, value, {
								knownTickets: knownTicketsSet(),
								existingFiles: workspaceFilesSet(),
								workspaceRoot: state.workspace?.root,
								docPath: path(),
							}),
						);
						return (
							<span class="cm-md-prop-chip">
								<Show
									when={target().file || target().web}
									fallback={
										<Show
											when={rowProps.fact.key === "tags" || rowProps.fact.key === "tag"}
											fallback={
												<Show
													when={rowProps.fact.key === "status" && listed()}
													fallback={
														<Show
															when={!isRead() && !isListProperty(rowProps.fact.key)}
															fallback={
																<span classList={{ "doc-status": rowProps.fact.key === "status", [`tone-${toneOf(value)}`]: rowProps.fact.key === "status" }}>
																	{value}
																</span>
															}
														>
															<Show
																when={isEditingThis()}
																fallback={
																	<button
																		type="button"
																		class="cm-md-prop-scalar-btn"
																		classList={{ "doc-status": rowProps.fact.key === "status", [`tone-${toneOf(value)}`]: rowProps.fact.key === "status" }}
																		title={`Click to edit ${rowProps.fact.key}`}
																		onClick={() => void editScalarPropertyInteractive(rowProps.fact.key, value)}
																	>
																		{value}
																	</button>
																}
															>
																{(() => {
																	let cancelled = false;
																	const ed = editingProp()!;
																	return (
																		<input
																			ref={(el) => {
																				queueMicrotask(() => {
																					el.focus();
																					if (el.type === "text") el.select();
																				});
																			}}
																			type={ed.isDate ? "date" : "text"}
																			class="cm-md-prop-inline-input"
																			aria-label={`Edit ${rowProps.fact.key}`}
																			value={ed.draft}
																			onInput={(e) => {
																				const v = e.currentTarget.value;
																				setEditingProp((cur) => (cur ? { ...cur, draft: v } : null));
																			}}
																			onKeyDown={(e) => {
																				if (e.key === "Escape") {
																					cancelled = true;
																					e.preventDefault();
																					e.stopPropagation();
																					setEditingProp(null);
																				} else if (e.key === "Enter") {
																					e.preventDefault();
																					e.stopPropagation();
																					const cur = editingProp();
																					if (cur) commitInlinePropertyEdit(cur.key, cur.value, e.currentTarget.value, cur.isDate);
																				}
																			}}
																			onBlur={(e) => {
																				if (cancelled) return;
																				const cur = editingProp();
																				if (cur) commitInlinePropertyEdit(cur.key, cur.value, e.currentTarget.value, cur.isDate);
																			}}
																		/>
																	);
																})()}
															</Show>
														</Show>
													}
												>
													<Menu
														floating
														class="md-status"
														label={`Status: ${value}. Change it`}
														title="Change the status"
														items={() =>
															statusChoices(listed()).map((status) => ({
																label: status,
																disabled: status.toLowerCase() === value.toLowerCase(),
																why: "It is this already",
																run: () => void setStatus(path(), status),
															}))
														}
													>
														<span class={`doc-status tone-${toneOf(value)}`}>{value}</span>
														<Icon name="chevron-down" />
													</Menu>
												</Show>
											}
										>
											<button
												type="button"
												class="cm-md-prop-tag"
												title={`Search workspace for #${value.replace(/^#+/, "")}`}
												onClick={() => searchFor(tagSearchPattern(value), { regex: true })}
											>
												#{value.replace(/^#+/, "")}
											</button>
										</Show>
									}
								>
									<button
										type="button"
										class="link"
										title={target().web ?? target().file}
										onClick={() => go(target())}
										onMouseEnter={(e) => hoverFileButton(target().file, e.currentTarget, { ticket: ticket() || undefined })}
										onMouseLeave={scheduleHideHover}
									>
										{target().display ?? value}
									</button>
									<Show
										when={
											!isRead() &&
											EDITABLE_LINK_KEYS.has(rowProps.fact.key) &&
											!(rowProps.fact.key === "ticket" && listed()?.group === "tickets")
										}
									>
										<button
											type="button"
											class="cm-md-prop-edit"
											title={`Edit ${rowProps.fact.key}`}
											aria-label={`Edit ${rowProps.fact.key}`}
											onClick={() => void editScalarPropertyInteractive(rowProps.fact.key, value)}
										>
											<Icon name="edit" />
										</button>
									</Show>
								</Show>
								<Show when={issue()}>
									{(warn) => (
										<span class="cm-md-prop-issue" title={warn().message} role="status">
											<Icon name="warning" />
											<span>{warn().label}</span>
										</span>
									)}
								</Show>
								<Show when={!isRead() && !(rowProps.fact.key === "status" && listed()) && rowProps.fact.key !== "title" && !(rowProps.fact.key === "ticket" && listed()?.group === "tickets")}>
									<button
										type="button"
										class="cm-md-prop-rm"
										title={`Remove ${value} from ${rowProps.fact.key}`}
										aria-label={`Remove ${value} from ${rowProps.fact.key}`}
										onClick={() => removePropertyValue(rowProps.fact.key, value, rowProps.fact.values.length)}
									>
										<Icon name="close" />
									</button>
								</Show>
							</span>
						);
					}}
				</For>
				<Show when={!isRead() && isListProperty(rowProps.fact.key)}>
					<button
						type="button"
						class="cm-md-prop-add"
						title={`Add another value to ${rowProps.fact.key}`}
						aria-label={`Add value to ${rowProps.fact.key}`}
						onClick={() => void addPropertyValueInteractive(rowProps.fact.key)}
					>
						<Icon name="add" />
					</button>
				</Show>
			</dd>
		</div>
	);

	const showLinkedTicketsSection = createMemo(
		() =>
			linkedTickets().length > 0 ||
			Boolean(!ticket() && listed() && !isCatalog(listed()!) && ["specs", "knowledge", "schema"].includes(listed()!.group)),
	);

	const isPromotableQuestion = createMemo(
		() => Boolean(listed()?.group === "knowledge" && listed()?.kind === "questions" && toneOf(listed()?.status) === "done"),
	);

	return (
		<div class="md-inspector" aria-label="Markdown document information">
			{/* Compact Action Strip */}
			<div class="md-insp-toolbar" role="toolbar" aria-label="Document actions">
				<Show when={!isRead()}>
					<button
						type="button"
						class="md-insp-btn"
						title="Add or update a YAML property without editing raw YAML"
						onClick={() => void addPropertyValueInteractive()}
					>
						<Icon name="add" />
						<span>Property</span>
					</button>
				</Show>
				<Menu
					floating
					class="md-insp-menu"
					label="Copy or export this document"
					title="Copy as HTML or Jira markup, print to PDF, export Word/HTML, record approval, or export ticket artifacts"
					items={exportMenuItems}
				>
					<span>Export</span>
					<Icon name="chevron-down" />
				</Menu>
				<Show when={!isRead()}>
					<button
						ref={yamlEditBtnEl}
						type="button"
						class="md-insp-btn"
						classList={{ active: editYaml() }}
						aria-expanded={editYaml()}
						title={editYaml() ? "Hide raw YAML frontmatter (Esc)" : "Edit raw YAML frontmatter"}
						onClick={toggleEditYaml}
					>
						<span>YAML</span>
					</button>
				</Show>
				<Show when={isPromotableQuestion()}>
					<button
						type="button"
						class="md-insp-btn md-insp-btn-accent"
						title="Create a numbered Decision ADR pre-filled with this question and answer"
						onClick={() => void promoteQuestionToDecision(path())}
					>
						<Icon name="pass" />
						<span>Promote</span>
					</button>
				</Show>
			</div>

			{/* Section 1: Properties */}
			<section ref={propsSectionEl} class="md-insp-section cm-md-props" aria-label="Document properties">
				<div class="md-insp-sec-head">
					<button
						type="button"
						class="md-insp-sec-toggle"
						aria-expanded={propsOpen()}
						onClick={() => setPropsOpen((v) => !v)}
					>
						<Icon name={propsOpen() ? "chevron-down" : "chevron-right"} />
						<span>Properties</span>
						<Show when={facts().length > 0}>
							<span class="md-insp-count">{facts().length}</span>
						</Show>
					</button>
				</div>
				<Show when={propsOpen()}>
					<Show
						when={facts().length > 0}
						fallback={
							<Show when={!editYaml()}>
								<p class="md-insp-empty">No YAML properties yet.</p>
							</Show>
						}
					>
						<dl class="md-insp-props-list">
							<For each={groupedFacts().primary}>{(fact) => <PropertyRow fact={fact} />}</For>
							<Show when={groupedFacts().governance.length > 0}>
								<Show when={groupedFacts().primary.length > 0}>
									<div class="md-insp-subkicker">Governance</div>
								</Show>
								<For each={groupedFacts().governance}>{(fact) => <PropertyRow fact={fact} />}</For>
							</Show>
						</dl>
					</Show>
					<Show when={!isRead() && editYaml() && yamlSpan()}>
						{(span) => (
							<div class="cm-md-props-yaml-wrap">
								<div class="cm-md-props-yaml-fence" aria-hidden="true">---</div>
								<textarea
									ref={(el) => {
										yamlCompleter?.dispose();
										yamlInputEl = el;
										el.value = span().inner;
										yamlCompleter = createTextareaCompleter(el, {
											mode: "yaml",
											filePath: () => path(),
											getListedDoc: () => listed(),
											onApply: () => {
												resizeYamlInput(el);
												applyYamlInnerEdit(el.value);
											},
										});
										queueMicrotask(() => resizeYamlInput(el));
									}}
									class="cm-md-props-yaml"
									aria-label="Raw YAML frontmatter"
									spellcheck={false}
									rows={3}
									onInput={(e) => {
										const el = e.currentTarget;
										resizeYamlInput(el);
										applyYamlInnerEdit(el.value);
										yamlCompleter?.update();
									}}
									onBlur={() => {
										yamlCompleter?.close();
									}}
									onKeyDown={(e) => {
										if (yamlCompleter?.handleKeyDown(e)) return;
										if (e.key === "Escape") {
											e.preventDefault();
											e.stopPropagation();
											yamlCompleter?.dispose();
											yamlCompleter = undefined;
											setEditYaml(false);
											yamlEditBtnEl?.focus();
										} else if (e.key === "Tab" && !e.shiftKey) {
											e.preventDefault();
											const el = e.currentTarget;
											const s = el.selectionStart;
											const end = el.selectionEnd;
											const next = `${el.value.slice(0, s)}  ${el.value.slice(end)}`;
											el.value = next;
											el.setSelectionRange(s + 2, s + 2);
											resizeYamlInput(el);
											applyYamlInnerEdit(next);
										} else if ((e.ctrlKey || e.metaKey) && !e.altKey) {
											const k = e.key.toLowerCase();
											const model = activeMdDoc()?.model;
											if (k === "z" && !e.shiftKey) {
												e.preventDefault();
												model?.undo();
											} else if (k === "y" || (k === "z" && e.shiftKey)) {
												e.preventDefault();
												model?.redo();
											}
										}
									}}
								/>
								<div class="cm-md-props-yaml-fence" aria-hidden="true">---</div>
							</div>
						)}
					</Show>
				</Show>
			</section>

			{/* Section 2: Ticket Work & Readiness */}
			<Show when={ticket()}>
				<section ref={workSectionEl} class="md-insp-section md-work" aria-label={`The work for ${ticket()}`}>
					<div class="md-insp-sec-head">
						<button
							type="button"
							class="md-insp-sec-toggle"
							aria-expanded={workOpen()}
							onClick={() => setWorkOpen((v) => !v)}
						>
							<Icon name={workOpen() ? "chevron-down" : "chevron-right"} />
							<span>Work for {ticket()}</span>
							<Show when={totalWorkItems() > 0}>
								<span class="md-insp-count">{totalWorkItems()}</span>
							</Show>
						</button>
					</div>
					<Show when={workOpen()}>
						<Show when={workRollup().length > 0}>
							<div class="md-work-rollup" aria-label="Work progress summary">
								<For each={workRollup()}>{(part) => <span class="md-insp-rollup-item">{part}</span>}</For>
							</div>
						</Show>
						<Show when={readiness()}>
							{(rep) => (
								<div class="md-readiness">
									<button
										type="button"
										class="md-readiness-toggle"
										aria-expanded={readinessOpen()}
										title="STARLIMS transport & release readiness checklist for this ticket"
										onClick={() => setReadinessOpen((v) => !v)}
									>
										<Icon name={readinessOpen() ? "chevron-down" : "chevron-right"} />
										<span>Release readiness</span>
										<span class={`md-readiness-badge ${rep().ready ? "ready" : "pending"}`}>
											{rep().pass}/{rep().total} {rep().ready ? "ready" : "checks"}
										</span>
									</button>
									<Show when={readinessOpen()}>
										<ul class="md-readiness-list">
											<For each={rep().checks}>
												{(chk) => (
													<li class={`md-readiness-row level-${chk.level}`}>
														<Icon name={chk.level === "pass" ? "check" : chk.level === "warn" ? "warning" : "info"} />
														<div class="md-insp-readiness-text">
															<strong>{chk.label}: </strong>
															<Show
																when={chk.path && !chk.ok}
																fallback={<span class="md-readiness-detail">{chk.detail}</span>}
															>
																<button
																	type="button"
																	class="link"
																	title="Open referenced document"
																	onClick={() => void openFile(chk.path!)}
																>
																	{chk.detail}
																</button>
															</Show>
														</div>
													</li>
												)}
											</For>
										</ul>
									</Show>
								</div>
							)}
						</Show>
						<div class="md-work-actions">
							<button
								type="button"
								class="md-work-btn"
								title={`Create a new spec for ${ticket()}`}
								onClick={() => void newSpec()}
							>
								<Icon name="add" />
								<span>Spec</span>
							</button>
							<button
								type="button"
								class="md-work-btn"
								title={`Create a new plan for ${ticket()}`}
								onClick={() => void import("../commands").then((m) => m.runCommand("new-plan"))}
							>
								<Icon name="add" />
								<span>Plan</span>
							</button>
							<button
								type="button"
								class="md-work-btn"
								title={`Link an existing spec, plan, ticket, decision, or question to ${ticket()}`}
								onClick={() => void linkDocumentToTicket(path(), ticket())}
							>
								<Icon name="references" />
								<span>Link…</span>
							</button>
							<Show
								when={listed()?.ticketFolder}
								fallback={
									<button
										type="button"
										class="md-work-btn"
										title={`Move ${ticket()} into its own folder (docs/tickets/${ticket()}/) for reference docs, code samples, and fixtures`}
										onClick={() => void createTicketFolder(path())}
									>
										<Icon name="new-folder" />
										<span>Folder</span>
									</button>
								}
							>
								{(folder) => (
									<button
										type="button"
										class="md-work-btn"
										title={`Create a new reference note, sample, or fixture inside ${relativeTo(state.workspace?.root, folder())}/`}
										onClick={() => void newTicketFile(folder(), ticket())}
									>
										<Icon name="new-file" />
										<span>File</span>
									</button>
								)}
							</Show>
							<Menu
								floating
								class="md-insp-work-menu"
								label={`More work items for ${ticket()}`}
								title={`Create a sub-ticket, decision, question, registry row, or export for ${ticket()}`}
								items={() => {
									const p = path();
									const t = ticket();
									const me = listed();
									return [
										{ label: "New sub-ticket…", run: () => void newTicket(undefined, undefined, { parent: t }) },
										{ label: "New decision…", run: () => void newKnowledge("decisions", { ticket: t }) },
										{ label: "New question…", run: () => void newKnowledge("questions", { ticket: t }) },
										{ label: "Add registry row…", run: () => void addRegistryRowForTicket(t) },
										"separator",
										{ label: "Deployment manifest (Markdown)…", run: () => void exportDeploymentManifest(p, t, "markdown") },
										{ label: "Deployment manifest (CSV)…", run: () => void exportDeploymentManifest(p, t, "csv") },
										{ label: "Deployment manifest (Word .docx)…", run: () => void exportDeploymentManifest(p, t, "docx") },
										{ label: "Release packet (HTML)…", run: () => void exportTicketPacket(p, t, "html") },
										{ label: "Release packet (Word .docx)…", run: () => void exportTicketPacket(p, t, "docx") },
										{ label: "Requirements Traceability Matrix (RTM)…", run: () => void exportRtm(undefined, me ? { tickets: [me] } : undefined) },
										{ label: "Generate Test Execution Protocol…", run: () => void generateTestExecutionProtocol(p) },
										"separator",
										{ label: "Close out ticket…", run: () => void closeoutTicket(p, t) },
										...(me && isArchivedTicket(me)
											? [{ label: "Unarchive ticket…", run: () => void unarchiveTicket(me) }]
											: []),
									];
								}}
							>
								<span>More</span>
								<Icon name="chevron-down" />
							</Menu>
							<button
								type="button"
								class="md-work-btn md-insp-icon-only"
								classList={{ active: workGuideOpen() }}
								aria-expanded={workGuideOpen()}
								aria-label="How ticket links work"
								title="How documents and plans associate with a ticket"
								onClick={() => setWorkGuideOpen((v) => !v)}
							>
								<Icon name="question" />
							</button>
						</div>

						<Show when={workGuideOpen()}>
							<div class="md-work-guide">
								<p class="md-work-guide-intro">
									Everything under <strong>{ticket()}</strong> comes straight from the files:
								</p>
								<dl class="md-work-guide-list">
									<div>
										<dt>Specs</dt>
										<dd>
											Add <code>specs: [docs/specs/Name.md]</code> here or <code>ticket: {ticket()}</code> in the spec for behavior and design specifics.
										</dd>
									</div>
									<div>
										<dt>Plans</dt>
										<dd>
											Set <code>&quot;ticket&quot;: &quot;{ticket()}&quot;</code> on the plan or add <code>plans: [design/Name.plan.json]</code> here. A companion <code>design/Name.plan.md</code> attaches automatically as its plan doc.
										</dd>
									</div>
									<div>
										<dt>Decisions &amp; Questions</dt>
										<dd>
											Add <code>ticket: {ticket()}</code> (or <code>tickets: [{ticket()}]</code>) in frontmatter.
										</dd>
									</div>
									<div>
										<dt>Tickets</dt>
										<dd>
											Use <code>parent: {ticket()}</code> on a sub-ticket or <code>related: [KEY]</code> on either ticket.
										</dd>
									</div>
									<div>
										<dt>Registries</dt>
										<dd>
											Any CSV row whose <code>Ticket</code> column lists <code>{ticket()}</code> opens filtered to those rows.
										</dd>
									</div>
									<div>
										<dt>Ticket folder</dt>
										<dd>
											Place reference docs and fixtures inside <code>docs/tickets/{ticket()}/</code>.
										</dd>
									</div>
								</dl>
							</div>
						</Show>

						<Show
							when={work().length > 0 || Boolean(listed()?.ticketFolder)}
							fallback={
								<p class="md-insp-empty">
									No specs, plans, or notes linked yet. Use <strong>Spec</strong>, <strong>Plan</strong>, <strong>Link…</strong>, or <strong>Folder</strong> above.
								</p>
							}
						>
							<For each={work()}>
								{(group) => (
									<div class="md-work-group">
										<h3>{group.name}</h3>
										<ul>
											<For each={group.items}>
												{(item) => {
													const file = item.file;
													const registryRows = () =>
														group.kind === "registry"
															? file.forTickets?.find((rows) => rows.key.toLowerCase() === ticket().toLowerCase())
															: undefined;
													return (
														<li>
															<div class="md-insp-work-row-top">
																<button
																	type="button"
																	class="link"
																	title={[file.path, `Linked via: ${item.detail}`, group.kind === "registry" ? `Opens the table at the rows for ${ticket()}.` : ""].filter(Boolean).join("\n")}
																	onClick={() => {
																		if (group.kind === "registry") askRows(file.path, ticket());
																		void openFile(file.path);
																	}}
																	onMouseEnter={(e) =>
																		hoverFileButton(file.path, e.currentTarget, {
																			ticket: group.kind === "registry" ? ticket() : undefined,
																		})
																	}
																	onMouseLeave={scheduleHideHover}
																>
																	{file.ticket && !file.title?.startsWith(file.ticket) ? `${file.ticket}: ` : ""}
																	{group.kind === "registry" ? registryTitle(file.name) : file.title || file.name.replace(/\.plan\.(json|md)$/i, "")}
																</button>
																<Show when={group.kind !== "registry"}>
																	<button
																		type="button"
																		class="md-work-unlink"
																		title={`Unlink ${file.ticket ?? file.title ?? file.name} from ${ticket()}`}
																		aria-label={`Unlink ${file.ticket ?? file.title ?? file.name}`}
																		onClick={() => void unlinkDocumentFromTicket(path(), ticket(), file)}
																	>
																		<Icon name="close" />
																	</button>
																</Show>
															</div>
															<div class="md-insp-work-row-meta">
																<Show when={file.status}>
																	<span class={`doc-status tone-${toneOf(file.status)}`}>{file.status}</span>
																</Show>
																<Show when={registryRows()}>
																	{(rows) => <span class="md-work-note">{rowsLine(rows())}</span>}
																</Show>
																<span class="md-work-via" title={item.detail}>
																	{item.reason}
																</span>
															</div>
														</li>
													);
												}}
											</For>
										</ul>
									</div>
								)}
							</For>

							<Show when={listed()?.ticketFolder}>
								{(folder) => {
									const count = () => listed()?.ticketFileCount ?? listed()?.ticketFiles?.length ?? 0;
									const relFolder = () => relativeTo(state.workspace?.root, folder()).split("\\").join("/");
									const openScoped = () =>
										void import("./Explorer").then((m) => m.browseFolderInExplorer(folder(), `${ticket()} files`));
									return (
										<div class="md-work-group md-work-files">
											<h3>Ticket files</h3>
											<ul>
												<li>
													<div class="md-insp-work-row-top">
														<button
															type="button"
															class="link md-work-folder-link"
															title={`Browse ${relFolder()}/ in a focused Explorer view`}
															onClick={openScoped}
														>
															<Icon name="folder" />
															<span>{relFolder()}/</span>
														</button>
													</div>
													<div class="md-insp-work-row-meta">
														<span class="md-work-note">
															{count() === 0 ? "No extra files" : `${count()} ${count() === 1 ? "file" : "files"}`}
														</span>
														<span class="md-work-via" title="Opens this ticket's folder in a focused Explorer view">
															Explorer
														</span>
													</div>
												</li>
											</ul>
										</div>
									);
								}}
							</Show>
						</Show>
					</Show>
				</section>
			</Show>

			{/* Section 3: Linked Tickets (for non-ticket specs, decisions, questions, schema) */}
			<Show when={showLinkedTicketsSection()}>
				<section class="md-insp-section md-linked-tickets" aria-label="Linked tickets">
					<div class="md-insp-sec-head">
						<button
							type="button"
							class="md-insp-sec-toggle"
							aria-expanded={linkedTicketsOpen()}
							onClick={() => setLinkedTicketsOpen((v) => !v)}
						>
							<Icon name={linkedTicketsOpen() ? "chevron-down" : "chevron-right"} />
							<span>Linked tickets</span>
							<Show when={linkedTickets().length > 0}>
								<span class="md-insp-count">{linkedTickets().length}</span>
							</Show>
						</button>
						<button
							type="button"
							class="md-work-btn"
							title="Link this document to a ticket"
							onClick={() => void linkNonTicketToTicket(path())}
						>
							<Icon name="references" />
							<span>Link…</span>
						</button>
					</div>
					<Show when={linkedTicketsOpen()}>
						<Show
							when={linkedTickets().length > 0}
							fallback={<p class="md-insp-empty">Not linked to a ticket yet.</p>}
						>
							<ul class="md-insp-item-list">
								<For each={linkedTickets()}>
									{(entry) => (
										<li>
											<div class="md-insp-work-row-top">
												<button
													type="button"
													class="link"
													title={[entry.ticket.path, `Linked via: ${entry.detail}`].join("\n")}
													onClick={() => void openFile(entry.ticket.path)}
													onMouseEnter={(e) => hoverFileButton(entry.ticket.path, e.currentTarget)}
													onMouseLeave={scheduleHideHover}
												>
													<strong>{entry.key}</strong>
													<Show when={entry.ticket.title && !entry.ticket.title.toLowerCase().startsWith(entry.key.toLowerCase())}>
														{`: ${entry.ticket.title}`}
													</Show>
												</button>
												<Show when={entry.reason !== "in ticket folder" && listed()}>
													<button
														type="button"
														class="md-work-unlink"
														title={`Unlink from ${entry.key}`}
														aria-label={`Unlink from ${entry.key}`}
														onClick={() => void unlinkDocumentFromTicket(entry.ticket.path, entry.key, listed()!)}
													>
														<Icon name="close" />
													</button>
												</Show>
											</div>
											<div class="md-insp-work-row-meta">
												<Show when={entry.ticket.status}>
													<span class={`doc-status tone-${toneOf(entry.ticket.status)}`}>{entry.ticket.status}</span>
												</Show>
												<span class="md-work-via" title={entry.detail}>
													{entry.reason}
												</span>
											</div>
										</li>
									)}
								</For>
							</ul>
						</Show>
					</Show>
				</section>
			</Show>

			{/* Section 3.5: Explicit SQL DDL Source (for schema/database docs) */}
			<Show when={sqlSourceInfo()}>
				{(info) => {
					const statusKind = () =>
						!info().rawSource ? "none" : info().missing ? "missing" : info().drifts.length > 0 ? "drift" : "sync";
					const statusLabel = () =>
						statusKind() === "none"
							? "Standalone"
							: statusKind() === "missing"
								? "Missing"
								: statusKind() === "drift"
									? "Drift"
									: "In sync";
					return (
						<section class="md-insp-section md-sql-source" aria-label="SQL source">
							<div class="md-insp-sec-head">
								<button
									type="button"
									class="md-insp-sec-toggle"
									aria-expanded={sqlSourceOpen()}
									onClick={() => setSqlSourceOpen((v) => !v)}
								>
									<Icon name={sqlSourceOpen() ? "chevron-down" : "chevron-right"} />
									<span>SQL source</span>
									<span class={`md-sql-pill ${statusKind()}`}>{statusLabel()}</span>
								</button>
							</div>
							<Show when={sqlSourceOpen()}>
								<div class="md-sql-body">
									<Show
										when={info().rawSource}
										fallback={
											<p class="md-insp-empty">
												No SQL file linked. Link an existing DDL script for drift checks, or generate a 1:1{" "}
												<code>{info().stem}.sql</code> from this table.
											</p>
										}
									>
										<div class="md-sql-link-row">
											<Icon name="database" />
											<Show
												when={info().exists}
												fallback={<span class="md-sql-missing">{info().rawSource} (not found)</span>}
											>
												<button
													type="button"
													class="link md-sql-link"
													title={`Open ${info().rawSource}`}
													onClick={() => void openFile(info().resolvedPath)}
												>
													{info().rawSource}
												</button>
											</Show>
										</div>
										<Show when={info().sharedCount > 0}>
											<p class="md-insp-empty">
												Shared with {info().sharedCount} other {info().sharedCount === 1 ? "doc" : "docs"} (drift checks this doc's table only).
											</p>
										</Show>
										<Show when={info().drifts.length > 0}>
											<ul class="md-sql-drift-list">
												<For each={info().drifts}>
													{(d) => (
														<li>
															<strong>{d.table}</strong>:{" "}
															{[
																d.added.length ? `+${d.added.length} added` : "",
																d.modified.length ? `~${d.modified.length} modified` : "",
																d.dropped.length ? `-${d.dropped.length} dropped` : "",
															]
																.filter(Boolean)
																.join(", ")}
														</li>
													)}
												</For>
											</ul>
										</Show>
									</Show>
									<div class="md-sql-actions">
										<Show when={info().drifts.length > 0 && info().exists}>
											<button
												type="button"
												class="md-insp-mini-btn"
												title="Update this Markdown table from the linked SQL DDL"
												onClick={() => void generateSchemaDocFromSql(info().resolvedPath, path())}
											>
												Sync from SQL
											</button>
										</Show>
										<button
											type="button"
											class="md-insp-mini-btn"
											title={info().rawSource ? "Generate or update SQL DDL from this Markdown table" : `Create ${info().stem}.sql from this Markdown table`}
											onClick={() => void generateSqlFromSchemaDoc(path())}
										>
											{info().rawSource ? "Update SQL" : `Generate ${info().stem}.sql`}
										</button>
										<button
											type="button"
											class="md-insp-mini-btn"
											title="Choose or change the linked SQL file"
											onClick={() => void linkSchemaDocToSql(path())}
										>
											{info().rawSource ? "Change…" : "Link SQL…"}
										</button>
										<Show when={info().rawSource}>
											<button
												type="button"
												class="md-insp-mini-btn"
												title="Remove source: link and make this a standalone table doc"
												onClick={() => void unlinkSchemaDocSql(path())}
											>
												Unlink
											</button>
										</Show>
									</div>
								</div>
							</Show>
						</section>
					);
				}}
			</Show>

			{/* Section 4: Used in Code & Registries (for schema/ docs) */}
			<Show when={schemaIdent() && (schemaUsages()?.totalFiles ?? 0) > 0 ? schemaUsages() : undefined}>
				{(usages) => {
					const USAGE_GROUP_CAP = 8;
					const filteredGroups = createMemo(() => filterSchemaUsageGroups(usages().groups, usageFilter()));
					const isFiltering = () => usageFilter().trim().length > 0;
					const hasProdUsages = () => usages().groups.some((g) => g.id !== "tests");
					const isGroupOpen = (id: SchemaUsageCategory) => {
						if (isFiltering()) return true;
						const explicit = usageGroupFold()[id];
						if (explicit !== undefined) return !explicit;
						// Fold Tests by default when production code or registries are also present so key usages stay above the fold.
						return !(id === "tests" && hasProdUsages());
					};
					const toggleGroup = (id: SchemaUsageCategory) => {
						const currentlyOpen = isGroupOpen(id);
						setUsageGroupFold((prev) => ({ ...prev, [id]: currentlyOpen }));
					};
					const toggleFileHits = (filePath: string) => {
						const key = canonical(filePath);
						setUsageExpandedFiles((prev) => ({ ...prev, [key]: !prev[key] }));
					};
					const isFileExpanded = (filePath: string) => Boolean(usageExpandedFiles()[canonical(filePath)]);
					return (
						<section class="md-insp-section md-schema-usages" aria-label="Used in code and registries">
							<div class="md-insp-sec-head">
								<button
									type="button"
									class="md-insp-sec-toggle"
									aria-expanded={schemaUsagesOpen()}
									onClick={() => setSchemaUsagesOpen((v) => !v)}
								>
									<Icon name={schemaUsagesOpen() ? "chevron-down" : "chevron-right"} />
									<span>Used in code &amp; registries</span>
									<span class="md-insp-count" title={`${usages().totalFiles} files · ${usages().totalRefs} references`}>
										{usages().totalFiles}
									</span>
								</button>
								<button
									type="button"
									class="md-insp-mini-btn"
									title={`Open all references to ${usages().ident} in Search`}
									aria-label={`Search workspace for ${usages().ident}`}
									onClick={() => searchFor(usages().ident, { wholeWord: true, exclude: usages().exclude })}
								>
									<Icon name="search" />
								</button>
							</div>
							<Show when={schemaUsagesOpen()}>
								<Show when={usages().totalFiles > 4 || usages().groups.length > 1}>
									<div class="md-usage-filter">
										<Icon name="search" class="md-usage-filter-icon" />
										<input
											type="text"
											value={usageFilter()}
											placeholder="Filter files or snippets…"
											aria-label="Filter code and registry usages"
											onInput={(e) => setUsageFilter(e.currentTarget.value)}
										/>
										<Show when={isFiltering()}>
											<button
												type="button"
												class="md-usage-filter-clear"
												title="Clear filter"
												aria-label="Clear filter"
												onClick={() => setUsageFilter("")}
											>
												<Icon name="close" />
											</button>
										</Show>
									</div>
								</Show>
								<Show
									when={filteredGroups().length > 0}
									fallback={<p class="md-insp-empty">No usages match "{usageFilter().trim()}".</p>}
								>
									<div class="md-usage-groups">
										<For each={filteredGroups()}>
											{(group) => {
												const open = () => isGroupOpen(group.id);
												const showingAll = () => isFiltering() || Boolean(usageGroupShowAll()[group.id]);
												const visibleItems = () => (showingAll() ? group.items : group.items.slice(0, USAGE_GROUP_CAP));
												const hiddenCount = () => Math.max(0, group.items.length - visibleItems().length);
												return (
													<div class="md-usage-group">
														<button
															type="button"
															class="md-usage-group-head"
															aria-expanded={open()}
															onClick={() => toggleGroup(group.id)}
														>
															<Icon name={open() ? "chevron-down" : "chevron-right"} class="md-usage-twisty" />
															<span class="md-usage-group-label">{group.label}</span>
															<span class="md-usage-group-count">{group.items.length}</span>
														</button>
														<Show when={open()}>
															<ul class="md-usage-list">
																<For each={visibleItems()}>
																	{(item) => {
																		const firstHit = () => item.hits[0];
																		const hasMultiple = () => item.hits.length > 1;
																		const expanded = () => hasMultiple() && (isFileExpanded(item.path) || isFiltering());
																		const openTarget = (line?: number) =>
																			void openFile(item.path, line ? { reveal: { line } } : {});
																		return (
																			<li class="md-usage-row">
																				<div class="md-usage-row-head">
																					<FileMark name={item.fileName} />
																					<button
																						type="button"
																						class="link md-usage-name"
																						title={firstHit() ? `${item.rel}:${firstHit()!.line}` : item.rel}
																						onClick={() => openTarget(firstHit()?.line)}
																						onMouseEnter={(e) =>
																							hoverFileButton(item.path, e.currentTarget, firstHit() ? { line: firstHit()!.line } : undefined)
																						}
																						onMouseLeave={scheduleHideHover}
																					>
																						{item.name}
																					</button>
																					<Show
																						when={item.category !== "registries"}
																						fallback={<span class="md-usage-meta-pill">{item.fileName}</span>}
																					>
																						<Show
																							when={hasMultiple()}
																							fallback={
																								<Show when={firstHit()}>
																									{(hit) => (
																										<button
																											type="button"
																											class="md-usage-line-pill"
																											title={`Jump to line ${hit().line}`}
																											onClick={() => openTarget(hit().line)}
																										>
																											L{hit().line}
																										</button>
																									)}
																								</Show>
																							}
																						>
																							<button
																								type="button"
																								class="md-usage-refs-btn"
																								classList={{ open: expanded() }}
																								aria-expanded={expanded()}
																								title={`${expanded() ? "Hide" : "Show"} all ${item.hits.length} matching lines in ${item.name}`}
																								onClick={() => toggleFileHits(item.path)}
																							>
																								<span>{item.count} refs</span>
																								<Icon name={expanded() ? "chevron-down" : "chevron-right"} />
																							</button>
																						</Show>
																					</Show>
																				</div>
																				<Show when={item.category !== "registries" && item.dir}>
																					<div class="md-usage-dir" title={item.dir}>
																						{item.dir}
																					</div>
																				</Show>
																				<Show when={!expanded() && firstHit()?.text}>
																					<button
																						type="button"
																						class="md-usage-snippet"
																						title={`Line ${firstHit()!.line}: ${firstHit()!.text}`}
																						onClick={() => openTarget(firstHit()!.line)}
																					>
																						{firstHit()!.text}
																					</button>
																				</Show>
																				<Show when={expanded()}>
																					<ul class="md-usage-hits">
																						<For each={item.hits}>
																							{(hit) => (
																								<li>
																									<button
																										type="button"
																										class="md-usage-hit-btn"
																										title={`${item.rel}:${hit.line} — ${hit.text}`}
																										onClick={() => openTarget(hit.line)}
																									>
																										<span class="md-usage-hit-line">L{hit.line}</span>
																										<span class="md-usage-hit-text">{hit.text || "(match)"}</span>
																									</button>
																								</li>
																							)}
																						</For>
																					</ul>
																				</Show>
																			</li>
																		);
																	}}
																</For>
															</ul>
															<Show when={hiddenCount() > 0}>
																<button
																	type="button"
																	class="md-usage-more"
																	onClick={() => setUsageGroupShowAll((prev) => ({ ...prev, [group.id]: true }))}
																>
																	Show {hiddenCount()} more…
																</button>
															</Show>
														</Show>
													</div>
												);
											}}
										</For>
									</div>
								</Show>
							</Show>
						</section>
					);
				}}
			</Show>

			{/* Section 5: Links Inspector (Backlinks · Outgoing · Unlinked) */}
			<section ref={linksSectionEl} class="md-insp-section cm-md-backlinks cm-md-links-inspector" aria-label="Document links inspector">
				<div class="md-insp-sec-head">
					<button
						type="button"
						class="md-insp-sec-toggle"
						aria-expanded={linksOpen()}
						onClick={() => setLinksOpen((v) => !v)}
					>
						<Icon name={linksOpen() ? "chevron-down" : "chevron-right"} />
						<span>Links</span>
						<span class="md-insp-count">{totalLinksCount()}</span>
					</button>
					<Show when={brokenOutgoingCount() > 0}>
						<button
							type="button"
							class="md-insp-warn-pill"
							title={`${brokenOutgoingCount()} broken outgoing ${brokenOutgoingCount() === 1 ? "link" : "links"}`}
							onClick={() => {
								setLinksOpen(true);
								setLinksTab("outgoing");
							}}
						>
							<Icon name="warning" />
							<span>{brokenOutgoingCount()}</span>
						</button>
					</Show>
				</div>

				<Show when={linksOpen()}>
					<div class="md-insp-links-tabs" role="tablist" aria-label="Links inspector tabs">
						<button
							type="button"
							role="tab"
							classList={{ active: linksTab() === "backlinks" }}
							aria-selected={linksTab() === "backlinks"}
							onClick={() => setLinksTab("backlinks")}
						>
							<span>Backlinks ({linked()?.length ?? 0})</span>
						</button>
						<button
							type="button"
							role="tab"
							classList={{ active: linksTab() === "outgoing" }}
							aria-selected={linksTab() === "outgoing"}
							onClick={() => setLinksTab("outgoing")}
						>
							<span>Outgoing ({outgoingLinks().length})</span>
							<Show when={brokenOutgoingCount() > 0}>
								<span class="md-insp-inline-err" title={`${brokenOutgoingCount()} broken outgoing`}>
									<Icon name="warning" />
									<span>{brokenOutgoingCount()}</span>
								</span>
							</Show>
						</button>
						<button
							type="button"
							role="tab"
							classList={{ active: linksTab() === "unlinked" }}
							aria-selected={linksTab() === "unlinked"}
							onClick={() => setLinksTab("unlinked")}
						>
							<span>Unlinked ({unlinkedMentions()?.length ?? 0})</span>
						</button>
					</div>

					<Show when={linksTab() === "backlinks"}>
						<Show
							when={(linked()?.length ?? 0) > 0}
							fallback={<p class="md-insp-empty">No other workspace documents link here yet.</p>}
						>
							<ul>
								<For each={linked()}>
									{(from) => (
										<li>
											<div class="md-insp-link-row-head">
												<button
													type="button"
													class="link"
													title={relativeTo(state.workspace?.root, from.path)}
													onClick={() => void openFile(from.path, { reveal: { line: from.line } })}
													onMouseEnter={(e) => hoverFileButton(from.path, e.currentTarget, { line: from.line })}
													onMouseLeave={scheduleHideHover}
												>
													{called(from.path)}
												</button>
												<span class="md-work-via">L{from.line}</span>
												<Show when={from.places > 1}>
													<span class="md-work-note">{from.places} places</span>
												</Show>
											</div>
											<Show when={from.snippet}>
												<div class="cm-md-link-snippet">{from.snippet}</div>
											</Show>
										</li>
									)}
								</For>
							</ul>
						</Show>
					</Show>

					<Show when={linksTab() === "outgoing"}>
						<Show
							when={outgoingLinks().length > 0}
							fallback={<p class="md-insp-empty">No outgoing links, embeds, or ticket references in this document.</p>}
						>
							<ul>
								<For each={outgoingLinks()}>
									{(item) => (
										<li>
											<div class="md-insp-link-row-head">
												<button
													type="button"
													class="link"
													title={
														item.broken
															? `Broken link on line ${item.line}: ${item.target}`
															: item.resolvedPath
																? relativeTo(state.workspace?.root, item.resolvedPath)
																: item.target
													}
													onClick={() => {
														if (item.kind === "web") {
															void window.open(item.target, "_blank", "noopener");
														} else if (item.broken) {
															jumpToLine(item.line);
														} else if (item.resolvedPath) {
															if (item.heading) void followHeadingInFile(item.resolvedPath, item.heading);
															else void openFile(item.resolvedPath, item.targetLine ? { reveal: { line: item.targetLine } } : {});
														} else if (item.kind === "wiki" || item.kind === "embed") {
															void followWiki(item.target);
														} else {
															void followLink(item.target);
														}
													}}
													onMouseEnter={(e) => {
														if (item.resolvedPath && !item.broken) {
															hoverFileButton(item.resolvedPath, e.currentTarget, { line: item.targetLine });
														}
													}}
													onMouseLeave={scheduleHideHover}
												>
													{item.label}
												</button>
											</div>
											<div class="md-insp-work-row-meta">
												<span class="md-work-via">{item.kind}</span>
												<button
													type="button"
													class="md-insp-mini-btn"
													title={`Jump to line ${item.line} in this document`}
													onClick={() => jumpToLine(item.line)}
												>
													L{item.line}
												</button>
												<Show when={item.broken}>
													<span class="md-insp-broken-pill">
														<Icon name="warning" />
														<span>Broken</span>
													</span>
												</Show>
												<Show when={item.broken && item.instead && !isRead()}>
													<button
														type="button"
														class="md-insp-mini-btn"
														title={`Update broken link to ${item.instead}`}
														onClick={() => {
															if (!item.instead) return;
															const cur = activeMdDoc()?.model.getValue() ?? text();
															const fixed = withLinkFile(cur, item.line, item.target, item.instead);
															if (fixed !== null && fixed !== cur) {
																applyDocTextUpdate(fixed);
																notify(`Fixed broken link to ${item.instead}.`);
															}
														}}
													>
														<Icon name="wand" />
														<span>Fix</span>
													</button>
												</Show>
											</div>
										</li>
									)}
								</For>
							</ul>
						</Show>
					</Show>

					<Show when={linksTab() === "unlinked"}>
						<Show
							when={(unlinkedMentions()?.length ?? 0) > 0}
							fallback={<p class="md-insp-empty">No unlinked plain-text mentions found in other workspace docs.</p>}
						>
							<ul>
								<For each={unlinkedMentions()}>
									{(m) => (
										<li>
											<div class="md-insp-link-row-head">
												<button
													type="button"
													class="link"
													title={`Open ${relativeTo(state.workspace?.root, m.path)} at line ${m.line}`}
													onClick={() => void openFile(m.path, { reveal: { line: m.line, column: m.column + 1 } })}
													onMouseEnter={(e) => hoverFileButton(m.path, e.currentTarget, { line: m.line })}
													onMouseLeave={scheduleHideHover}
												>
													{called(canonical(m.path))}
												</button>
												<span class="md-work-via">L{m.line}</span>
												<button
													type="button"
													class="md-insp-mini-btn"
													title={`Convert "${m.matchedText}" into a [[wikilink]] in ${called(canonical(m.path))}`}
													onClick={() => void linkifyUnlinkedMention(m)}
												>
													<Icon name="references" />
													<span>Link</span>
												</button>
											</div>
											<Show when={m.snippet}>
												<div class="cm-md-link-snippet">{m.snippet}</div>
											</Show>
										</li>
									)}
								</For>
							</ul>
						</Show>
					</Show>
				</Show>
			</section>

			{/* Portaled Hover Page Preview popover */}
			<Show when={hoverCard()}>
				{(card) => (
					<Portal>
						<div
							ref={hoverCardEl}
							class="md-hover-card"
							style={{ left: `${card().x}px`, top: `${card().y}px`, "max-height": `${card().maxHeight}px` }}
							onMouseEnter={() => {
								cardHovered = true;
								clearTimeout(hideTimer);
							}}
							onMouseLeave={() => {
								cardHovered = false;
								scheduleHideHover();
							}}
						>
							<div class="md-hover-head">
								<button
									type="button"
									class="md-hover-title"
									title={`Open ${card().relPath}`}
									onClick={() => {
										const target = card();
										setHoverCard(null);
										if (canonical(target.path) === path() && target.line) {
											jumpToLine(target.line);
											return;
										}
										void openFile(target.path, target.line ? { reveal: { line: target.line } } : {});
									}}
								>
									{card().title}
								</button>
								<Show when={card().status}>
									<span class={`doc-status tone-${card().statusTone ?? "active"}`}>{card().status}</span>
								</Show>
								<Show when={card().badge}>
									<span class="md-hover-badge">{card().badge}</span>
								</Show>
								<span class="md-hover-path">{card().relPath}</span>
							</div>
							<div
								ref={hoverBodyEl}
								class="md-hover-body md"
								innerHTML={card().html}
								onClick={(e) => {
									const a = (e.target as HTMLElement | null)?.closest?.("a");
									if (!a) return;
									e.preventDefault();
									const href = a.getAttribute("href");
									const basePath = card().path;
									setHoverCard(null);
									if (!href) return;
									const leads = linkLeads(href, basePath, state.workspace?.root);
									if (!leads) return;
									if ("web" in leads) return void window.open(leads.web, "_blank", "noopener");
									if ("heading" in leads) return void followHeadingInFile(basePath, leads.heading);
									if (!leads.lines && href.includes("#")) {
										const h = decodeURIComponent(href.slice(href.indexOf("#") + 1));
										if (h) return void followHeadingInFile(leads.file, h);
									}
									void openFile(leads.file, leads.lines ? { reveal: leads.lines } : {});
								}}
							/>
						</div>
					</Portal>
				)}
			</Show>
		</div>
	);
}
