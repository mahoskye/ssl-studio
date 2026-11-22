// CodeMirror 6 theme wired directly to SSL Studio's OKLCH theme CSS variables
// so all 25 built-in Warm Material themes (including Split Warm) and custom
// VS Code themes render Markdown Live Preview with guaranteed WCAG AA contrast.
import { HighlightStyle, syntaxHighlighting } from "@codemirror/language";
import { EditorView } from "@codemirror/view";
import { tags } from "@lezer/highlight";

export const cmStudioTheme = EditorView.theme({
	"&": {
		backgroundColor: "transparent",
		color: "var(--editor-fg, var(--fg))",
		fontFamily: "var(--read-font, var(--ui-font))",
		fontSize: "calc(var(--code-size) + 1.5px)",
		lineHeight: "1.65",
		height: "100%",
	},
	"&.cm-focused": {
		outline: "none",
	},
	".cm-scroller": {
		fontFamily: "inherit",
		lineHeight: "inherit",
		overflow: "visible",
	},
	".cm-content": {
		padding: "8px 0 36vh",
		caretColor: "var(--editor-accent, var(--accent))",
		minHeight: "260px",
	},
	".cm-line": {
		padding: "1px 2px",
	},
	".cm-cursor, .cm-dropCursor": {
		borderLeftColor: "var(--editor-accent, var(--accent))",
		borderLeftWidth: "2px",
	},
	"&.cm-focused .cm-selectionBackground, .cm-selectionBackground, .cm-content ::selection": {
		backgroundColor: "color-mix(in srgb, var(--editor-accent, var(--accent)) 24%, transparent)",
	},
	".cm-activeLine": {
		backgroundColor: "transparent",
	},
	".cm-gutters": {
		backgroundColor: "transparent",
		color: "var(--editor-muted, var(--muted))",
		border: "none",
		paddingRight: "6px",
	},
	".cm-activeLineGutter": {
		backgroundColor: "transparent",
	},
	".cm-foldGutter .cm-gutterElement": {
		padding: "0 2px",
		display: "flex",
		alignItems: "center",
		justifyContent: "center",
		cursor: "pointer",
		opacity: "0",
		transition: "opacity 120ms ease, color 120ms ease",
		fontSize: "12px",
		userSelect: "none",
	},
	".cm-line:hover ~ *, .cm-foldGutter:hover .cm-gutterElement, .cm-foldGutter .cm-gutterElement[data-folded='true']": {
		opacity: "0.75",
	},
	".cm-foldGutter .cm-gutterElement:hover": {
		opacity: "1",
		color: "var(--editor-strong, var(--strong-fg))",
	},
	".cm-foldPlaceholder": {
		backgroundColor: "var(--input-bg)",
		color: "var(--muted)",
		border: "1px solid var(--border)",
		borderRadius: "var(--radius-sm)",
		padding: "0 5px",
		margin: "0 4px",
		fontSize: "0.85em",
		cursor: "pointer",
	},
	".cm-searchMatch": {
		backgroundColor: "color-mix(in srgb, var(--warning) 28%, transparent)",
		borderRadius: "2px",
	},
	".cm-searchMatch.cm-searchMatch-selected": {
		backgroundColor: "color-mix(in srgb, var(--editor-accent, var(--accent)) 36%, transparent)",
		outline: "1px solid var(--editor-accent, var(--accent))",
	},
	// Native CodeMirror search / find-replace panel styled to match SSL Studio chrome.
	".cm-panels": {
		backgroundColor: "var(--side-bg)",
		color: "var(--side-fg)",
		borderBottom: "1px solid var(--border)",
		zIndex: "6",
	},
	".cm-panels.cm-panels-top": {
		position: "sticky",
		top: "0",
		borderBottom: "1px solid var(--border)",
	},
	".cm-panels.cm-panels-bottom": {
		borderTop: "1px solid var(--border)",
	},
	".cm-search": {
		display: "flex",
		flexWrap: "wrap",
		alignItems: "center",
		gap: "6px",
		padding: "6px 12px",
		fontFamily: "var(--ui-font)",
		fontSize: "var(--text-md)",
	},
	".cm-search input.cm-textfield": {
		backgroundColor: "var(--input-bg)",
		color: "var(--input-fg)",
		border: "1px solid var(--input-border)",
		borderRadius: "var(--radius-sm)",
		padding: "3px 7px",
		fontFamily: "inherit",
		fontSize: "inherit",
	},
	".cm-search input.cm-textfield:focus": {
		outline: "2px solid var(--accent)",
		outlineOffset: "-1px",
	},
	".cm-search button.cm-button": {
		background: "var(--panel-bg)",
		color: "var(--fg)",
		border: "1px solid var(--border)",
		borderRadius: "var(--radius-sm)",
		padding: "3px 8px",
		fontFamily: "inherit",
		fontSize: "var(--text-sm)",
		cursor: "pointer",
	},
	".cm-search button.cm-button:hover": {
		background: "var(--hover)",
		color: "var(--strong-fg)",
	},
	".cm-search label": {
		display: "inline-flex",
		alignItems: "center",
		gap: "4px",
		color: "var(--muted)",
		fontSize: "var(--text-sm)",
		cursor: "pointer",
	},
	".cm-search button[name='close']": {
		color: "var(--muted)",
		fontSize: "16px",
		padding: "0 6px",
		background: "transparent",
		border: "none",
		cursor: "pointer",
	},
	".cm-search button[name='close']:hover": {
		color: "var(--strong-fg)",
	},
	// Autocomplete popup ([[wikilinks]], [[doc#headings]], ](links), [!callouts]).
	".cm-tooltip": {
		backgroundColor: "var(--side-bg)",
		color: "var(--side-fg)",
		border: "1px solid var(--input-border)",
		borderRadius: "var(--radius-lg)",
		boxShadow: "var(--shadow)",
		fontFamily: "var(--ui-font)",
		fontSize: "var(--text-base)",
		overflow: "hidden",
	},
	".cm-tooltip.cm-tooltip-autocomplete > ul": {
		fontFamily: "var(--ui-font)",
		maxHeight: "260px",
		minWidth: "240px",
		padding: "4px",
	},
	".cm-tooltip-autocomplete ul li": {
		display: "flex",
		alignItems: "baseline",
		gap: "8px",
		padding: "5px 8px",
		borderRadius: "var(--radius-sm)",
	},
	".cm-tooltip-autocomplete ul li[aria-selected]": {
		backgroundColor: "var(--selected)",
		color: "var(--strong-fg)",
	},
	".cm-completionDetail": {
		marginLeft: "auto",
		fontStyle: "normal",
		fontSize: "var(--text-sm)",
		color: "var(--muted)",
	},
	".cm-completionMatchedText": {
		textDecoration: "none",
		fontWeight: "600",
		color: "var(--accent)",
	},
});

export const cmMarkdownHighlight = syntaxHighlighting(
	HighlightStyle.define([
		{ tag: tags.heading, color: "var(--editor-strong, var(--strong-fg))", fontWeight: "600" },
		{ tag: tags.strong, color: "var(--editor-strong, var(--strong-fg))", fontWeight: "700" },
		{ tag: tags.emphasis, fontStyle: "italic" },
		{ tag: tags.strikethrough, textDecoration: "line-through", opacity: "0.75" },
		{ tag: tags.link, color: "var(--editor-accent, var(--accent))" },
		{ tag: tags.url, color: "var(--editor-muted, var(--muted))" },
		{ tag: tags.monospace, fontFamily: "var(--code-font)", fontSize: "0.9em" },
		{ tag: tags.quote, color: "var(--editor-muted, var(--muted))" },
		{ tag: tags.processingInstruction, color: "var(--editor-muted, var(--muted))", opacity: "0.6" },
		{ tag: tags.meta, color: "var(--editor-muted, var(--muted))", opacity: "0.65" },
		{ tag: tags.comment, color: "var(--editor-muted, var(--muted))", fontStyle: "italic" },
		{ tag: tags.keyword, color: "var(--editor-accent, var(--accent))" },
		{ tag: tags.string, color: "var(--ok, var(--fg))" },
		{ tag: tags.number, color: "var(--info, var(--fg))" },
	]),
);
