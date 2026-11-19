// A Markdown document's tables against the rule for them (ADR 0008), shown
// in Problems like any other finding. The rule is advice for a project's own
// documents, so each finding is information, not a warning: a README that
// came from somewhere else is not this project's to fix.
import { checkTables } from "../shared/docTables";
import { jsonProblem } from "../shared/jsonCheck";
import { monaco } from "./editor/monaco";
import { publishFindings } from "./lsp/session";

const OWNER = "doc-tables";

export function trackDoc(model: monaco.editor.ITextModel) {
	let timer: ReturnType<typeof setTimeout> | undefined;
	const run = () => {
		if (model.isDisposed()) return;
		const lines = model.getLineCount();
		publishFindings(
			model,
			OWNER,
			checkTables(model.getValue()).map((f) => {
				const line = Math.min(Math.max(f.line, 1), lines);
				return { line, column: 1, endLine: line, endColumn: model.getLineMaxColumn(line), severity: 3, message: f.message, code: "table-rule", source: "docs" };
			}),
		);
	};
	const changes = model.onDidChangeContent(() => {
		clearTimeout(timer);
		timer = setTimeout(run, 400);
	});
	model.onWillDispose(() => {
		clearTimeout(timer);
		changes.dispose();
		publishFindings(model, OWNER, null);
	});
	run();
}

const JSON_OWNER = "json";

/** A JSON document that cannot be read says where, in Problems and under the place itself: a plan, a data file. */
export function trackJson(model: monaco.editor.ITextModel) {
	let timer: ReturnType<typeof setTimeout> | undefined;
	const run = () => {
		if (model.isDisposed()) return;
		const problem = jsonProblem(model.getValue());
		if (!problem) return publishFindings(model, JSON_OWNER, []);
		const from = model.getPositionAt(problem.offset);
		const to = model.getPositionAt(problem.offset + problem.length);
		publishFindings(model, JSON_OWNER, [{ line: from.lineNumber, column: from.column, endLine: to.lineNumber, endColumn: to.column, severity: 1, message: problem.message, code: "json", source: "docs" }]);
	};
	const changes = model.onDidChangeContent(() => {
		clearTimeout(timer);
		timer = setTimeout(run, 400);
	});
	model.onWillDispose(() => {
		clearTimeout(timer);
		changes.dispose();
		publishFindings(model, JSON_OWNER, null);
	});
	run();
}
