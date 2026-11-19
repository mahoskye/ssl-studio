import { describe, expect, test } from "bun:test";
import { ticketMentions } from "../src/shared/ticketRefs";

const said = (text: string, keys: string[]) => ticketMentions(text, keys).map((m) => [text.slice(m.from, m.to), m.key]);

describe("a ticket's key written in prose", () => {
	const keys = ["DEMO-10", "DEMO-101", "DEMO-103"];
	test("is found where it is written, the longest key that is there", () => {
		expect(said("This waits on DEMO-101, and DEMO-10 is done.", keys)).toEqual([
			["DEMO-101", "DEMO-101"],
			["DEMO-10", "DEMO-10"],
		]);
	});
	test("is found at the start, at the end, in brackets and side by side", () => {
		expect(said("DEMO-101 (see DEMO-103)", keys).map(([written]) => written)).toEqual(["DEMO-101", "DEMO-103"]);
		expect(said("DEMO-101,DEMO-103", keys).map(([written]) => written)).toEqual(["DEMO-101", "DEMO-103"]);
	});
	test("is given as the project writes it, whatever case the prose used", () => {
		expect(said("as demo-101 says", keys)).toEqual([["demo-101", "DEMO-101"]]);
	});
	test("is not found inside a longer word, a longer key, a path or a file name", () => {
		expect(said("XDEMO-101 DEMO-1015 DEMO-101-old tickets/DEMO-101.md DEMO-101.md pre_DEMO-101", keys)).toEqual([]);
	});
	test("a key that is not the project's is a word", () => {
		expect(said("DEMO-999 and JIRA-1 are elsewhere.", keys)).toEqual([]);
	});
	test("a sentence that ends with a key ends with a mention", () => {
		expect(said("It follows DEMO-103.", keys)).toEqual([["DEMO-103", "DEMO-103"]]);
	});
	test("a key of digits is a mention only with its mark", () => {
		expect(said("Issue #12 took 12 days; see #123 and v#12.", ["12"])).toEqual([["#12", "12"]]);
	});
	test("a key that is an ordinary word is never a mention", () => {
		expect(said("The report is late.", ["report", "late"])).toEqual([]);
	});
	test("a key with marks a pattern would read is taken as written", () => {
		expect(said("See LAB.7+ and LAB.70.", ["LAB.7+"])).toEqual([["LAB.7+", "LAB.7+"]]);
	});
	test("no keys, no mentions", () => {
		expect(ticketMentions("DEMO-101", [])).toEqual([]);
	});
});
