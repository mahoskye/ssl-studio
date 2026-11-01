// The house style profile's templates and markers (program decisions 0005
// and 0006). Conventions of the team, not facts about SSL: the language
// itself stays with the language server (ADR 0003).

export const HISTORY_MARKER = /^\s*Modification\.*\s*:/;

/** Modification blocks in the file banner, given the banner's lines. */
export function countHistoryEntries(bannerLines: string[], marker = HISTORY_MARKER): number {
	return bannerLines.filter((line) => marker.test(line)).length;
}

export type SizeReport = { bytes: number; codeLines: number; historyEntries: number };
export type Limits = { bytes: number; codeLines: number; historyEntries: number };
export type Level = "ok" | "near" | "over";

/** Near means within 10% of a limit (for bytes and code lines). */
export function level(value: number, limit: number, nearShare = 0.9): Level {
	return value > limit ? "over" : value >= limit * nearShare ? "near" : "ok";
}

export function bannerTemplate(date = new Date()) {
	const day = date.toISOString().slice(0, 10);
	const stars = "*".repeat(80);
	const rule = "_".repeat(79);
	return [
		`/${stars}`,
		"Description.. : ${1}",
		"Parameters... : ${2:-}",
		"Returns...... : ${3:-}",
		"Author....... : ",
		`Date......... : ${day}`,
		stars,
		rule,
		"Modification. : ",
		"Author....... : ",
		"Date......... : ",
		rule,
		`${stars}/;`,
		"",
	].join("\n");
}

export function procedureTemplate(name = "${1:Name}") {
	return [
		"/*",
		` * Procedure: ${name}`,
		" * Description: ${2}",
		" * Parameters:",
		" *   ${3:sName} - ${4:what it means}",
		" * Returns: ${5:what it returns}",
		";",
		`:PROCEDURE ${name};`,
		"\t:PARAMETERS ${3:sName};",
		"",
		"\t$0",
		"",
		"\t:RETURN;",
		":ENDPROC;",
		"",
	].join("\n");
}
