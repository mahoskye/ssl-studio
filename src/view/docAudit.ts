// Shared reactive workspace document audit cache (unused attachments, open tasks,
// broken #heading anchors, malformed YAML, workspace-wide ADR 0008 table rule).
// Driven once from the always-mounted StatusBar so StatusBar, Health, and Problems
// stay in sync without running duplicate backend scans.
import { createEffect, createSignal } from "solid-js";
import type { DocAuditResult } from "../shared/protocol";
import { backend } from "./backend";
import { state } from "./state";

const EMPTY: DocAuditResult = { unusedAttachments: [], openTasks: [], issues: [] };

const [docAuditData, setDocAuditData] = createSignal<DocAuditResult>(EMPTY);
const [auditNonce, setAuditNonce] = createSignal(0);

export { docAuditData };

export function refreshDocAudit() {
	setAuditNonce((n) => n + 1);
}

/** Reactive effect mountable once from StatusBar; keeps `docAuditData()` fresh on workspace or doc tree changes. */
export function useDocAudit() {
	let seq = 0;
	createEffect(() => {
		const root = state.workspace?.root;
		const attach = state.settings.attachmentsFolder ?? "";
		// Depend on workspace tree edits & explicit refreshes.
		void state.treeVersion;
		void auditNonce();
		const mine = ++seq;
		if (!root) {
			setDocAuditData(EMPTY);
			return;
		}
		void backend
			.docAudit(attach || undefined)
			.then((res) => {
				if (mine === seq) setDocAuditData(res);
			})
			.catch(() => {
				if (mine === seq) setDocAuditData(EMPTY);
			});
	});
}
