import { describe, expect, test } from "bun:test";
import { addQuestions, answerQuestion, applySuggestion, decisionsOf, describeSuggestion, formatSurvey, looksCut, nounsOf, openQuestions, overLimit, parseContext, parseQuestions, parseSpec, parseSuggestions, planHash, previewPlan, printSpec, readBlocks, refinePrompt, specHash, specPrompt, unaccounted, type SpecUnit, type Suggestion } from "../src/view/plan/assist";
import { checkPlan, newPlan, parsePlan, printPlan, type Plan } from "../src/view/plan/model";

const plan = (): Plan => ({
	version: 1,
	title: "Release a sample",
	goal: "Release an approved sample",
	groups: [],
	nodes: [
		{ id: "n1", kind: "start", text: "A sample id arrives" },
		{ id: "n2", kind: "decision", text: "Is the id usable?" },
		{ id: "n3", kind: "step", text: "Mark the sample released" },
		{ id: "n4", kind: "end", text: "Return the status" },
	],
	edges: [
		{ from: "n1", to: "n2" },
		{ from: "n2", to: "n3", label: "yes" },
		{ from: "n2", to: "n4", label: "no" },
		{ from: "n3", to: "n4" },
	],
});

describe("reading a reply's blocks", () => {
	test("reads named blocks and ignores what is around them", () => {
		expect(readBlocks("Sure!\n<<<SPEC\nthe spec\n>>>SPEC\nthanks\n<<<UNITS\n[]\n>>>UNITS\n")).toEqual({ SPEC: "the spec", UNITS: "[]" });
	});
	test("keeps fences inside a block", () => {
		expect(readBlocks("<<<SPEC\n```ssl\ncode\n```\nmore\n>>>SPEC").SPEC).toBe("```ssl\ncode\n```\nmore");
	});
	test("a block closed the wrong way still ends, as gpt-oss wrote them", () => {
		expect(readBlocks("<<<UNITS  \n[1]\n<<<UNITS  \n<<<QUESTIONS  \n[2]\n<<<QUESTIONS")).toEqual({ UNITS: "[1]", QUESTIONS: "[2]" });
	});
	test("a block left open ends at the next, or at the end", () => {
		expect(readBlocks("<<<SPEC\nwords\n<<<UNITS\n[]")).toEqual({ SPEC: "words", UNITS: "[]" });
	});
	test("markers only count alone on a line", () => {
		expect(readBlocks("<<<SPEC\nsee <<<UNITS in text\n>>>SPEC").SPEC).toBe("see <<<UNITS in text");
	});
});

describe("questions", () => {
	test("reads questions, with a fence round the JSON or not", () => {
		const list = parseQuestions('```json\n[{"question":"Which table?","node":"n3","answers":["SAMPLES","ORDERS"]},{"nope":1}]\n```');
		expect(list).toEqual([{ question: "Which table?", node: "n3", suggested: ["SAMPLES", "ORDERS"] }]);
		expect(parseQuestions("not json")).toEqual([]);
		expect(parseQuestions(undefined)).toEqual([]);
	});
	test("are kept in the plan, once each, and survive printing", () => {
		const q = { question: "Which table?" };
		const twice = addQuestions(addQuestions(plan(), [q]), [{ question: " which table? " }]);
		expect(decisionsOf(twice).length).toBe(1);
		expect(decisionsOf(parsePlan(printPlan(twice)).plan!)).toEqual([q]);
	});
	test("a plan with none gains no field", () => {
		expect(addQuestions(plan(), []).decisions).toBeUndefined();
	});
	test("answering closes one, and drops its suggestions", () => {
		const asked = addQuestions(plan(), [{ question: "Which table?", suggested: ["A"] }, { question: "Who is told?" }]);
		expect(openQuestions(asked).length).toBe(2);
		const answered = answerQuestion(asked, "which table?", " SAMPLES ");
		expect(openQuestions(answered).map((q) => q.question)).toEqual(["Who is told?"]);
		expect(decisionsOf(answered)[0]).toEqual({ question: "Which table?", answer: "SAMPLES" });
	});
	test("a blank answer leaves it open", () => {
		const asked = addQuestions(plan(), [{ question: "Q?" }]);
		expect(openQuestions(answerQuestion(asked, "Q?", "  ")).length).toBe(1);
	});
	test("a plan with decisions still passes the check", () => {
		expect(checkPlan(addQuestions(newPlan("t"), [{ question: "Q?" }]))).toEqual([]);
	});
});

describe("chart suggestions", () => {
	const block = JSON.stringify({
		nodes: [
			{ id: "a", kind: "step", text: "Report the failure", why: "The chart says nothing about it" },
			{ kind: "start", text: "a second start is not offered" },
			{ id: "n3", kind: "decision", text: "An id that clashes" },
			{ kind: "step", text: " " },
		],
		edges: [
			{ from: "n2", to: "a", label: "no" },
			{ from: "a", to: "n4" },
			{ from: "ghost", to: "n4" },
			{ from: "n1", to: "n2" },
		],
		remove: [
			{ from: "n2", to: "n4" },
			{ from: "n1", to: "n4" },
		],
		changes: [
			{ id: "n3", notes: "Inside a transaction." },
			{ id: "ghost", text: "x" },
			{ id: "n4" },
		],
	});
	test("keeps what makes sense against this plan", () => {
		const list = parseSuggestions(block, plan());
		expect(list.map((s) => s.key)).toEqual(["new:a", "new:new3", "edge:n2>new:a", "edge:new:a>n4", "remove:n2>n4", "change:n3"]);
	});
	test("nothing usable is nothing", () => {
		expect(parseSuggestions("not json", plan())).toEqual([]);
		expect(parseSuggestions(undefined, plan())).toEqual([]);
	});
	test("a new node takes a free id, and edges follow it", () => {
		const list = parseSuggestions(block, plan());
		const ids = new Map<string, string>();
		const added = applySuggestion(plan(), list[0]!, ids)!;
		expect(added.nodes.at(-1)).toEqual({ id: "n5", kind: "step", text: "Report the failure" });
		expect(ids.get("new:a")).toBe("n5");
		const linked = applySuggestion(added, list[2]!, ids)!;
		expect(linked.edges.at(-1)).toEqual({ from: "n2", to: "n5", label: "no" });
	});
	test("an edge waits for its new node", () => {
		const list = parseSuggestions(block, plan());
		expect(applySuggestion(plan(), list[2]!, new Map())).toBeNull();
	});
	test("disconnecting and changing apply", () => {
		const list = parseSuggestions(block, plan());
		const ids = new Map<string, string>();
		const cut = applySuggestion(plan(), list[4]!, ids)!;
		expect(cut.edges.some((e) => e.from === "n2" && e.to === "n4")).toBe(false);
		const noted = applySuggestion(plan(), list[5]!, ids)!;
		expect(noted.nodes.find((n) => n.id === "n3")!.notes).toBe("Inside a transaction.");
	});
	test("the preview draws what is proposed, marked, and changes nothing", () => {
		const original = plan();
		const list = parseSuggestions(block, original);
		const seen = previewPlan(original, list);
		expect(seen.nodes.find((n) => n.id === "new:a")!.pending).toBe(true);
		expect(seen.edges.find((e) => e.to === "new:a")!.pending).toBe(true);
		expect(seen.edges.find((e) => e.from === "n2" && e.to === "n4")!.removing).toBe(true);
		expect(original.nodes.length).toBe(4);
		expect(printPlan(original)).not.toContain("pending");
	});
	test("each reads in plain words", () => {
		const list = parseSuggestions(block, plan());
		const read = (s: Suggestion) => describeSuggestion(s, plan(), list);
		expect(read(list[0]!)).toBe('Add a step: "Report the failure"');
		expect(read(list[2]!)).toBe('Connect "Is the id usable?" to "Report the failure" (no)');
		expect(read(list[4]!)).toBe('Disconnect "Is the id usable?" from "Return the status"');
		expect(read(list[5]!)).toBe('Change "Mark the sample released", noting: Inside a transaction.');
	});
});

describe("what the agent asks to read", () => {
	test("reads files, procedures and elements, within reason", () => {
		expect(parseContext('[{"file":"a.ssl"},{"procedure":"P"},{"element":"Len"},{"other":1}]')).toEqual([{ file: "a.ssl" }, { procedure: "P" }, { element: "Len" }]);
		expect(parseContext(JSON.stringify(Array.from({ length: 20 }, (_, i) => ({ file: `${i}` })))).length).toBe(6);
		expect(parseContext("nope")).toEqual([]);
	});
});

describe("the spec", () => {
	const reply = ['<<<SPEC\n# Spec\n```ssl\nx\n```\n>>>SPEC', '<<<UNITS\n[{"name":"Release","script":"a.ssl","nodes":["n3"],"lines":30},{"nope":1}]\n>>>UNITS', '<<<MAP\n[{"node":"n1","becomes":"parameters"},{"node":"n2","becomes":"an :IF"},{"node":"n4","becomes":"a return"}]\n>>>MAP', '<<<QUESTIONS\n[]\n>>>QUESTIONS'].join("\n");
	test("reads its parts", () => {
		const parsed = parseSpec(reply);
		expect(parsed.spec).toBe("# Spec\n```ssl\nx\n```");
		expect(parsed.units.map((u) => u.name)).toEqual(["Release"]);
		expect(parsed.map.length).toBe(3);
		expect(parsed.questions).toEqual([]);
	});
	test("every node must be accounted for, by a unit or the map", () => {
		const { units, map } = parseSpec(reply);
		expect(unaccounted(plan(), units, map)).toEqual([]);
		expect(unaccounted(plan(), [], map).map((n) => n.id)).toEqual(["n3"]);
		expect(unaccounted(plan(), [], []).length).toBe(4);
	});
	test("finds a script past the limit, summing its units", () => {
		const units: SpecUnit[] = [
			{ name: "a", script: "big.ssl", lines: 300 },
			{ name: "b", script: "big.ssl", lines: 150 },
			{ name: "c", script: "small.ssl", lines: 100 },
			{ name: "d" },
		];
		expect(overLimit(plan(), units, 400)).toEqual([{ script: "big.ssl", lines: 450 }]);
	});
	test("the file keeps what later stages read, and which plan it came from", () => {
		const { spec, units, map } = parseSpec(reply);
		const text = printSpec(spec, units, map, planHash(plan()));
		expect(text.startsWith("# Spec")).toBe(true);
		expect(text).toContain('"name": "Release"');
		expect(specHash(text)).toBe(planHash(plan()));
		expect(specHash("no marker")).toBeNull();
	});
	test("the hash changes with the words and answers, not with the layout of the file", () => {
		const base = planHash(plan());
		expect(planHash(parsePlan(printPlan(plan())).plan!)).toBe(base);
		expect(planHash({ ...plan(), title: "Other" })).not.toBe(base);
		expect(planHash(addQuestions(plan(), [{ question: "Q?" }]))).not.toBe(base);
	});
});

describe("a prompt that was cut", () => {
	test("shows in its token count", () => {
		expect(looksCut(40000, 4096)).toBe(true);
		expect(looksCut(16000, 4096)).toBe(true);
		expect(looksCut(16000, 1000)).toBe(true);
		expect(looksCut(12000, 3500)).toBe(false);
		expect(looksCut(12000, 0)).toBe(false);
	});
});

describe("the survey", () => {
	test("picks the chart's own words", () => {
		const words = nounsOf(plan());
		expect(words).toContain("sample");
		expect(words).toContain("released");
		expect(words).not.toContain("the");
		expect(nounsOf(plan(), 2).length).toBe(2);
		expect(words.indexOf("sample")).toBe(0);
	});
	test("reads plainly, says when a script is new, and stays short", () => {
		const text = formatSurvey({ calls: [{ ref: "IsUsableId", code: ":PROCEDURE IsUsableId;" }], targets: [{ path: "a.ssl", outline: null }], symbols: [{ name: "ReleaseIt", file: "b.ssl" }], hits: [{ word: "sample", file: "c.ssl", line: 3, text: "x" }], callGraph: ["P calls Q"] });
		for (const part of ["a.ssl: does not exist yet", ":PROCEDURE IsUsableId;", "ReleaseIt in b.ssl", "c.ssl:3: x", "P calls Q"]) expect(text).toContain(part);
		expect(formatSurvey({ calls: [], targets: [], symbols: [], hits: [], callGraph: [] })).toBe("Nothing in the workspace matched.");
		const long = formatSurvey({ calls: [], targets: [], symbols: Array.from({ length: 2000 }, (_, i) => ({ name: `Name${i}`, file: "f.ssl" })), hits: [], callGraph: [] });
		expect(long.length).toBeLessThan(6100);
		expect(long).toContain("CONTEXT");
	});
});

describe("prompts", () => {
	const asked = answerQuestion(addQuestions(plan(), [{ question: "Which table?" }, { question: "Who is told?" }]), "Which table?", "SAMPLES");
	test("carry the plan, what is decided, and the survey, and ask for no code in refining", () => {
		const text = refinePrompt(asked, "SURVEY HERE");
		expect(text.startsWith("PLAN STAGE: refine")).toBe(true);
		expect(text).toContain("Mark the sample released");
		expect(text).toContain("SURVEY HERE");
		expect(text).toContain("Which table? SAMPLES");
		expect(text).not.toContain("Who is told?");
		expect(text).toContain("cannot read");
	});
	test("the spec asks for every node, and states the limit", () => {
		const text = specPrompt(asked, "SURVEY", { codeLines: 400 });
		expect(text.startsWith("PLAN STAGE: spec")).toBe(true);
		expect(text).toContain("under 400 code lines");
		expect(text).toContain("EVERY node");
		expect(text).toContain("<<<MAP");
	});
	test("can carry more", () => {
		expect(refinePrompt(plan(), "s", "CONTEXT YOU ASKED FOR")).toContain("CONTEXT YOU ASKED FOR");
	});
});
