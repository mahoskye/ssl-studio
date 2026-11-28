// Shared reactive workspace document audit cache (unused attachments, open tasks,
// broken #heading anchors, malformed YAML, workspace-wide ADR 0008 table rule,
// and live #L code citations).
// Driven once from the always-mounted StatusBar so StatusBar, Health, Git, and
// Problems stay in sync without running duplicate backend scans.
import { createEffect, createMemo, createSignal, onCleanup } from "solid-js";
import { isInside } from "../shared/paths";
import type { AuditCitationIssue, DocAuditResult } from "../shared/protocol";
import { backend } from "./backend";
import { activeDoc, documents, log, state } from "./state";

const EMPTY: DocAuditResult = { unusedAttachments: [], openTasks: [], issues: [], citationIssues: [] };

const [docAuditData, setDocAuditData] = createSignal<DocAuditResult>(EMPTY);
const [auditNonce, setAuditNonce] = createSignal(0);

export { docAuditData };
export const docCitationIssues = (): AuditCitationIssue[] => docAuditData().citationIssues ?? [];

export function refreshDocAudit() {
	setAuditNonce((n) => n + 1);
}

/** Collects in-memory text for all dirty open workspace buffers so audit reflects live unsaved edits. */
function collectDirtyBuffers(root: string, dirtyKeys: readonly string[]): Record<string, string> | undefined {
	const out: Record<string, string> = {};
	let count = 0;
	for (const key of dirtyKeys) {
		const doc = documents.get(key);
		if (!doc || doc.binary || !isInside(root, doc.path)) continue;
		if (doc.model.isDisposed()) continue;
		out[doc.path] = doc.model.getValue();
		count++;
	}
	return count ? out : undefined;
}

/** Reactive effect mountable once from StatusBar; keeps `docAuditData()` fresh on workspace, doc tree, or open buffer edits. */
export function useDocAudit() {
	const [editNonce, setEditNonce] = createSignal(0);

	// Debounced refresh when the active open text document changes so Health & Problems stay live while editing.
	const currentDoc = createMemo(() => activeDoc());
	createEffect(currentDoc, (doc) => {
		if (!doc || doc.binary || doc.model.isDisposed()) return;
		let timer: ReturnType<typeof setTimeout> | undefined;
		const sub = doc.model.onDidChangeContent(() => {
			clearTimeout(timer);
			timer = setTimeout(() => setEditNonce((n) => n + 1), 700);
		});
		return () => {
			clearTimeout(timer);
			sub.dispose();
		};
	});

	let seq = 0;
	let prevRoot: string | undefined;
	let lastAuditSummary = "";
	onCleanup(() => {
		seq++;
	});
	const auditDeps = createMemo(
		() => {
			const root = state.workspace?.root;
			const attach = state.settings.attachmentsFolder ?? "";
			const templates = state.settings.templatesFolder ?? "";
			// Depend on workspace tree edits, dirty buffer transitions, debounced active edits, & explicit refreshes.
			const dirtyKeys = Object.keys(state.dirty).filter((k) => state.dirty[k]);
			return {
				root,
				attach,
				templates,
				dirtyKeys,
				dirtySig: dirtyKeys.join("|"),
				treeVersion: state.treeVersion,
				edit: editNonce(),
				audit: auditNonce(),
			};
		},
		{
			equals: (a, b) =>
				a.root === b.root &&
				a.attach === b.attach &&
				a.templates === b.templates &&
				a.dirtySig === b.dirtySig &&
				a.treeVersion === b.treeVersion &&
				a.edit === b.edit &&
				a.audit === b.audit,
		},
	);
	createEffect(auditDeps, ({ root, attach, templates, dirtyKeys }) => {
		const mine = ++seq;
		const rootChanged = root !== prevRoot;
		prevRoot = root;
		if (!root) {
			setDocAuditData(EMPTY);
			return () => {
				seq++;
			};
		}
		if (rootChanged) {
			setDocAuditData(EMPTY);
			lastAuditSummary = "";
		}
		const dirtyBuffers = collectDirtyBuffers(root, dirtyKeys);
		void backend
			.docAudit(attach || undefined, {
				...(templates ? { templatesFolder: templates } : {}),
				...(dirtyBuffers ? { dirtyBuffers } : {}),
			})
			.then((res) => {
				if (mine === seq) {
					const merged = { ...EMPTY, ...res, citationIssues: res.citationIssues ?? [] };
					setDocAuditData(merged);
					const warnCount = merged.issues.filter((i) => i.level === "warn").length + (merged.schemaDrift?.length ?? 0);
					const noteCount = merged.issues.filter((i) => i.level !== "warn").length;
					const summary = `${root}|${warnCount}|${noteCount}|${merged.openTasks.length}|${merged.unusedAttachments.length}`;
					if (summary !== lastAuditSummary) {
						lastAuditSummary = summary;
						log(
							`Document audit: ${warnCount} warning${warnCount === 1 ? "" : "s"}, ${noteCount} note${noteCount === 1 ? "" : "s"}, ${merged.openTasks.length} open task${merged.openTasks.length === 1 ? "" : "s"}${merged.unusedAttachments.length ? `, ${merged.unusedAttachments.length} unused attachment${merged.unusedAttachments.length === 1 ? "" : "s"}` : ""}.`,
							"docs",
							warnCount > 0 ? "warn" : "info",
						);
					}
				}
			})
			.catch(() => {
				if (mine === seq) setDocAuditData(EMPTY);
			});
		return () => {
			seq++;
		};
	});
}
