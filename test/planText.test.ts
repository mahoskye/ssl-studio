import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { planPaths } from "../src/view/plan/built";
import { parsePlan, type Plan } from "../src/view/plan/model";
import { choicesFromPath, choicesFromStep, decisionDisplayLabel, matchPathsForChoices, planFocusAround, planTextOutline, syncChoiceInGiven } from "../src/view/plan/textModel";

const dueDatesPlan = parsePlan(readFileSync(join(import.meta.dir, "../examples/due-dates/design/SetSampleDueDates.plan.json"), "utf8")).plan!;

describe("planTextOutline (flow-ordered plan list view)", () => {
	test("keeps stages contiguous in natural execution order and defers terminal outcomes", () => {
		const outline = planTextOutline(dueDatesPlan);
		expect(outline.rows.length).toBe(dueDatesPlan.nodes.length);
		expect(outline.rows[0]!.node.kind).toBe("start");
		// Terminal outcomes appear at the end of the reachable flow.
		expect(outline.rows.at(-2)!.node.kind).toBe("end");
		expect(outline.rows.at(-1)!.node.kind).toBe("end");

		// Each named stage appears as one contiguous section (never split across disconnected fragments).
		const stageSections = outline.sections.filter((s) => s.stageId).map((s) => s.heading);
		expect(stageSections).toEqual(["Loading", "Planning one sample", "Saving, in SaveDueDates"]);
	});

	test("omits redundant next-row arrows on simple linear steps while preserving decisions, jumps, and loops", () => {
		const outline = planTextOutline(dueDatesPlan);
		// Linear step "Read the holidays" flows straight into the next line ("Read the outages"): no redundant link noise.
		const holidays = outline.rowById.get("n2")!;
		expect(holidays.links).toEqual([]);
		expect(holidays.allOutgoing.length).toBe(1);
		expect(holidays.allOutgoing[0]!.isImmediateNext).toBe(true);

		// Decision "Did the rule give a date?" shows both outgoing branches.
		const ruleDecision = outline.rowById.get("n9")!;
		expect(ruleDecision.links.map((l) => [l.label, l.target.id])).toEqual([
			["yes", "n10"],
			["no", "n11"],
		]);

		// Loop-back step "Keep the date, to save later" marks its return edge to n5 as loopsBack.
		const keepDate = outline.rowById.get("n10")!;
		expect(keepDate.links.length).toBe(1);
		expect(keepDate.links[0]!.loopsBack).toBe(true);
		expect(keepDate.links[0]!.target.id).toBe("n5");
	});

	test("groups unreachable nodes cleanly at the end under Unconnected steps", () => {
		const plan: Plan = {
			version: 1,
			title: "Test",
			groups: [],
			nodes: [
				{ id: "n1", kind: "start", text: "Begin" },
				{ id: "n2", kind: "end", text: "Done" },
				{ id: "n3", kind: "step", text: "Floating step" },
			],
			edges: [{ from: "n1", to: "n2" }],
		};
		const outline = planTextOutline(plan);
		const lastSection = outline.sections.at(-1)!;
		expect(lastSection.unreachable).toBe(true);
		expect(lastSection.heading).toBe("Unconnected steps");
		expect(lastSection.rows.map((r) => r.node.id)).toEqual(["n3"]);
	});

	test("planFocusAround builds Comes from / Goes to for a step and Entered from / Leaves to for a stage", () => {
		const outline = planTextOutline(dueDatesPlan);

		// Focus on decision n9 ("Did the rule give a date?")
		const nodeFocus = planFocusAround(dueDatesPlan, outline, { kind: "node", id: "n9" });
		expect(nodeFocus?.kind).toBe("node");
		if (nodeFocus?.kind === "node") {
			expect(nodeFocus.stageName).toBe("Planning one sample");
			expect(nodeFocus.incoming.map((i) => i.node.id)).toEqual(["n8"]);
			expect(nodeFocus.outgoing.map((o) => [o.label, o.node.id])).toEqual([
				["yes", "n10"],
				["no", "n11"],
			]);
		}

		// Focus on stage g2 ("Planning one sample")
		const stageFocus = planFocusAround(dueDatesPlan, outline, { kind: "stage", id: "g2" });
		expect(stageFocus?.kind).toBe("stage");
		if (stageFocus?.kind === "stage") {
			expect(stageFocus.stageName).toBe("Planning one sample");
			expect(stageFocus.nodes.map((n) => n.id)).toEqual(["n6", "n7", "n8", "n9"]);
			expect(stageFocus.enteredFrom.map((e) => [e.label, e.node.id])).toEqual([["yes", "n5"]]);
			expect(stageFocus.leavesTo.map((e) => [e.label, e.node.id])).toEqual([
				["no", "n11"],
				["yes", "n10"],
			]);
		}
	});
});

describe("interactive Text test builder helpers", () => {
	const { paths } = planPaths(dueDatesPlan);
	const outline = planTextOutline(dueDatesPlan);

	test("matchPathsForChoices narrows journeys live and resolves unique outcomes and exact journeys", () => {
		// Choosing "Did the rule give a date?" = no narrows to the 7 skipped journeys and rules out n10 ("Keep the date").
		const partial = matchPathsForChoices(dueDatesPlan, paths, { n6: "yes", n9: "no" });
		expect(partial.matchingPathIndices.length).toBe(7);
		expect(partial.exactPathIndex).toBeNull();
		expect(partial.reachableNodeIds.has("n11")).toBe(true);
		expect(partial.reachableNodeIds.has("n10")).toBe(false);

		// Adding "Was anything wrong with the answer?" = no resolves uniqueOutcome to n23 ("Return how many were set...").
		const withOutcome = matchPathsForChoices(dueDatesPlan, paths, { n6: "yes", n9: "no", n25: "no" });
		expect(withOutcome.uniqueOutcome?.id).toBe("n23");

		// Choices extracted from Journey #1 round-trip to match exactPathIndex 0.
		const full = choicesFromPath(dueDatesPlan, paths[0]!);
		const exact = matchPathsForChoices(dueDatesPlan, paths, full);
		expect(exact.exactPathIndex).toBe(0);
		expect(exact.uniqueOutcome?.id).toBe("n22");

		// Loop header first-visit semantics: choosing n5 = no matches the 3 zero-sample journeys only.
		const zeroSamples = matchPathsForChoices(dueDatesPlan, paths, { n5: "no" });
		expect(zeroSamples.matchingPathIndices.length).toBe(3);
		expect(zeroSamples.reachableNodeIds.has("n8")).toBe(false);
	});

	test("choicesFromStep pre-selects invariant first-visit prerequisites without over-constraining loop steps", () => {
		// Step n8 ("Work out the due date with the rule") always requires n5 = yes and n6 = yes.
		expect(choicesFromStep("n8", paths)).toEqual({ n5: "yes", n6: "yes" });
		// Step n18 ("Write the due date") inside Saving requires n14 = yes and n16 = yes, leaving n5 free.
		expect(choicesFromStep("n18", paths)).toEqual({ n14: "yes", n16: "yes" });
	});

	test("decisionDisplayLabel adds preceding action context for terse questions like 'Is it?'", () => {
		expect(decisionDisplayLabel(outline, "n16")).toBe("Check the row is a sample and a day (Is it?)");
		expect(decisionDisplayLabel(outline, "n9")).toBe("Did the rule give a date?");
	});

	test("syncChoiceInGiven updates, appends, and removes choice lines while preserving custom analyst text", () => {
		const base = "Rush sample received Friday 4pm";
		const added = syncChoiceInGiven(base, "Did the rule give a date?", "yes");
		expect(added).toBe("Rush sample received Friday 4pm\n- Did the rule give a date?: yes");
		const flipped = syncChoiceInGiven(added, "Did the rule give a date?", "no");
		expect(flipped).toBe("Rush sample received Friday 4pm\n- Did the rule give a date?: no");
		const removed = syncChoiceInGiven(flipped, "Did the rule give a date?", null);
		expect(removed).toBe("Rush sample received Friday 4pm");
	});
});
