// The low findings of the fourth audit pass in the call graph and the Blocks view (B8-2, B8-4, B8-3). The pure
// parts (src/view/graph/canvas.ts, src/view/graph/unfold.ts, src/view/blocks/model.ts) are run for real, as the
// views run them. GraphView.tsx and BlocksView.tsx need a DOM, a layout and the real Monaco to be mounted, which
// the suite does not have: what is checked of them is only that they are wired to the tested parts, by reading
// their source, and each such test says so in its name.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { cardOf, dropLine, procedureGroups, treeFromSyntax, type Node, type SyntaxNodeIn } from "../src/view/blocks/model";
import { nodeClicks, PAN_PX, secondClick, type Click } from "../src/view/graph/canvas";
import { fold, visible, withoutUnresolved, type Filter, type Graph } from "../src/view/graph/model";
import { ASK_ABOVE, asksFirst, chosenKey, layoutGate, openingFolds, openingSize, pictureSize, shownWords, sizeOf, unfoldQuestion, type Chosen } from "../src/view/graph/unfold";

const readSrc = (rel: string) => readFileSync(join(import.meta.dir, "..", rel), "utf8").replace(/\r\n/g, "\n");
const between = (src: string, from: string, to: string) => {
	const start = src.indexOf(from);
	const end = src.indexOf(to, start + from.length);
	expect(start).toBeGreaterThan(0);
	expect(end).toBeGreaterThan(start);
	return src.slice(start, end);
};

// --- B8-2. Call graph: a double-click opens its own node, and no node clicked before it ----------------------

describe("Call graph — a press that moved the picture is not the first click of a double-click (B8-2)", () => {
	/**
	 * The clicks as GraphView hears them: every click on the picture first (the svg's capture listener, with how far
	 * the pointer moved the picture since it was pressed), and then, when it is a click of its own on a node, that
	 * node's own listener. What each one did is written down.
	 */
	const picture = () => {
		const clicks = nodeClicks<string>();
		const did: string[] = [];
		const click = (at: Click, on: string | null, moved = 0) => {
			const heard = clicks.heard(at, moved);
			if (heard.is === "pan") return void did.push("pan");
			if (heard.is === "second") return void did.push(`open ${heard.node}`);
			if (!on) return void did.push("background");
			clicks.onNode(at, on);
			did.push(`focus ${on}`);
		};
		return { click, did };
	};
	const at = (detail: number, ms: number, x: number, y: number): Click => ({ detail, at: ms, x, y });

	test("the auditor's sequence: A is focused; twenty seconds later a double-click on B whose first press drifts 4 px opens nothing of A's", () => {
		const { click, did } = picture();
		click(at(1, 0, 100, 100), "A");
		// |dx| + |dy| = 4: more than a click may move the picture. The window system still pairs the next press with it.
		click(at(1, 20_000, 402, 302), "B", 4);
		click(at(2, 20_180, 402, 302), "B");
		// It used to end "open A". The press that moved the picture is no first click, so B's is a click of its own.
		expect(did).toEqual(["focus A", "pan", "focus B"]);
		expect(PAN_PX).toBe(3);
	});

	test("an ordinary double-click still opens the node it began on, though the first click laid the picture out again", () => {
		const { click, did } = picture();
		click(at(1, 0, 100, 100), "A");
		click(at(1, 20_000, 400, 300), "B");
		// The focus moved the nodes: the second click lands on another node, or on none. It is B's all the same.
		click(at(2, 20_180, 400, 300), "C");
		expect(did).toEqual(["focus A", "focus B", "open B"]);
		const again = picture();
		again.click(at(1, 0, 400, 300), "B");
		again.click(at(2, 150, 401, 300), null);
		expect(again.did).toEqual(["focus B", "open B"]);
	});

	test("a click the count does not mark is still the second when it follows at once in the same place, but not across a press that moved the picture", () => {
		const { click, did } = picture();
		click(at(1, 1000, 200, 120), "A");
		click(at(1, 1300, 202, 121), "C");
		expect(did).toEqual(["focus A", "open A"]);
		const moved = picture();
		moved.click(at(1, 1000, 200, 120), "A");
		moved.click(at(1, 1150, 200, 120), "A", PAN_PX + 1);
		moved.click(at(1, 1300, 200, 120), "A");
		expect(moved.did).toEqual(["focus A", "pan", "focus A"]);
	});

	test("a press that moved the picture by no more than a click may is a click", () => {
		const { click, did } = picture();
		click(at(1, 0, 100, 100), "A", PAN_PX);
		click(at(2, 200, 101, 100), "A", PAN_PX);
		expect(did).toEqual(["focus A", "open A"]);
	});

	test("a click is remembered until the next one and no longer: a click on the background, or a third click, starts again", () => {
		const { click, did } = picture();
		click(at(1, 0, 100, 100), "A");
		click(at(1, 3000, 500, 400), null);
		// Counted 2 with the click on the background, and near it: that one was on no node, so nothing opens.
		click(at(2, 3200, 500, 400), "B");
		// The third click of three is not the second of the two before it.
		click(at(3, 3400, 500, 400), "B");
		expect(did).toEqual(["focus A", "background", "focus B", "focus B"]);
	});

	test("a click counted 2 is the second of the click before only near it and soon after it", () => {
		const first = at(1, 1000, 200, 120);
		// The window system's own pair: its second press lands a few pixels off, a finger's a little more.
		expect(secondClick(at(2, 1150, 204, 118), first)).toBe(true);
		expect(secondClick(at(2, 1500, 230, 120), first)).toBe(true);
		// Someone has set the system to a slow double-click: the count is still the system's to say.
		expect(secondClick(at(2, 4000, 200, 120), first)).toBe(true);
		// Far from it: the pair the system counted began with some other press, not with this click. It used to pass.
		expect(secondClick(at(2, 1150, 502, 322), first)).toBe(false);
		expect(secondClick(at(2, 1150, 260, 120), first)).toBe(false);
		// Long after it: no system pairs two presses twenty seconds apart. It used to pass too.
		expect(secondClick(at(2, 21_000, 200, 120), first)).toBe(false);
		// A press of the pair that is never heard as a click (let go outside the picture) leaves the click before it
		// remembered: the bounds are what keep the next click from being taken for its second.
		const { click, did } = picture();
		click(at(1, 0, 100, 100), "A");
		click(at(2, 20_180, 402, 302), "B");
		expect(did).toEqual(["focus A", "focus B"]);
	});

	test("GraphView keeps its clicks there: the svg hears each first with how far the press moved the picture, a node says it was clicked (source only: the view needs a DOM)", () => {
		const src = readSrc("src/view/graph/GraphView.tsx");
		expect(src).toContain("const clicks = nodeClicks<Box>();");
		const listener = between(src, 'el.addEventListener(\n\t\t\t\t\t\t\t\t"click",', "true,\n\t\t\t\t\t\t\t);");
		expect(listener).toContain("const heard = clicks.heard(clickAt(e), panned);");
		expect(listener).toContain('if (heard.is === "pan") return void (panned = 0);');
		expect(src).toContain("onClick={(e) => (e.stopPropagation(), clicks.onNode(clickAt(e), b), far() ? comeIn(b)");
		// Nothing else remembers a click, and the view makes no decision of its own about a second one.
		expect(src).not.toContain("let clicked");
		expect(src).not.toContain("secondClick(clickAt");
		expect(src.match(/clicks\.(heard|onNode)\(/g)).toEqual(["clicks.heard(", "clicks.onNode("]);
	});
});

// --- B8-4. Call graph: every way to a large picture is asked about, at the layout ----------------------------

describe("Call graph — a large picture is asked about whichever way it is reached (B8-4)", () => {
	/** The auditor's workspace: scripts of four procedures whose calls stay inside the script, one script in six calling another. */
	const workspace = (scripts: number, folders = 12): Graph => {
		const g: Graph = { scripts: [], nodes: [], edges: [], topLevel: [] };
		const path = (s: number) => `/ws/cat${s % folders}/S${s}.ssl`;
		for (let s = 0; s < scripts; s++) {
			g.scripts.push({ path: path(s), bytes: 1000, procedures: [] });
			for (let p = 0; p < 4; p++) g.nodes.push({ id: `${path(s)}#P${p}`, name: `P${p}`, path: path(s), line: p * 10 });
			for (let p = 1; p < 4; p++) g.edges.push({ from: `${path(s)}#P0`, to: `${path(s)}#P${p}`, crossScript: false, sites: [{ path: path(s), line: p }] });
		}
		for (let s = 0; s < scripts; s += 6) g.edges.push({ from: `${path(s)}#P1`, to: `${path((s * 7 + 3) % scripts)}#P0`, crossScript: true, sites: [{ path: path(s), line: 9 }] });
		return g;
	};
	const folderOf = (path: string) => (path === "(unresolved)" ? "" : path.slice("/ws/".length, path.lastIndexOf("/")));
	/** What GraphView's `shown` and `drawn` memos make of a choice (no ticket): the nodes the layout would be given. */
	const drawn = (g: Graph, c: Chosen) => {
		const keep = visible(g, c.filter);
		const shown = c.unresolved ? keep : withoutUnresolved(g, keep);
		return (c.filter.mode === "around" ? fold(shown, new Set()) : fold(shown, c.scripts, { folded: c.folders, of: folderOf })).nodes;
	};
	type Picked = Chosen & { mode: "graph" | "list" };
	const choice = (mode: Filter["mode"], more: Partial<Picked> = {}): Picked => ({ mode: "graph", filter: { mode, depth: 1 }, scripts: new Set(), folders: new Set(), unresolved: true, ticket: null, ...more });
	/** The call graph as far as the check goes: it opens on a workspace, and each change of what is chosen comes to the layout. */
	const graphOf = (g: Graph) => {
		const gate = layoutGate<Picked>();
		const opening = openingFolds(g, null, folderOf);
		gate.opens();
		const view = { gate, agreed: openingSize(g, opening, folderOf).nodes, opening: choice("all", { scripts: new Set(opening.scripts), folders: new Set(opening.folders) }) };
		const agree = (nodes: number) => (view.agreed = Math.max(view.agreed, nodes));
		/** A picture of `nodes` nodes comes to the layout, as in GraphView: one that is laid out counts as agreed to. */
		const layOut = (c: Picked, nodes: number) => {
			const verdict = gate.next(chosenKey(c), c, nodes, view.agreed);
			if (verdict === "draw") agree(nodes);
			return verdict;
		};
		const show = (c: Picked) => (c.mode === "list" ? (gate.rests(c), "list" as const) : layOut(c, sizeOf(drawn(g, c)).nodes));
		return { ...view, show, layOut, agree, agreed: () => view.agreed };
	};

	test("the auditor's way: \"Calls between scripts\", \"Unfold all\" (small, so no question), then Show \"Every call\" is asked about, and a no goes back", () => {
		const g = workspace(360);
		const graph = graphOf(g);
		expect(graph.show(graph.opening)).toBe("draw");
		const between = { ...graph.opening, filter: { mode: "cross" as const, depth: 1 } };
		expect(graph.show(between)).toBe("draw");
		// "Unfold all" asks for itself, of the picture it would make: 116 nodes, no question.
		expect(asksFirst(pictureSize(visible(g, between.filter), new Set(), { folded: new Set(), of: folderOf }).nodes, graph.agreed())).toBe(false);
		const unfolded = choice("cross");
		expect(graph.show(unfolded)).toBe("draw");
		// Show "Every call": the same folds, 1,440 nodes. This is what was laid out unasked.
		const every = choice("all");
		expect(sizeOf(drawn(g, every))).toEqual({ nodes: 1440, procedures: 1440 });
		expect(graph.show(every)).toBe("ask");
		expect(graph.gate.asked()).toBe(unfolded);
		expect(unfoldQuestion(shownWords(graph.gate.asked(), every), sizeOf(drawn(g, every)))).toBe(
			"Show every call? That draws 1440 nodes at once, 1440 of them procedures. Laying them out may take a while, and the window does not answer until it is done.",
		);
		// No: what was chosen before is what to go back to, and its picture needs no question.
		expect(graph.gate.answer(false)).toEqual({ back: unfolded });
		expect(graph.show(unfolded)).toBe("draw");
		// Asked again the next time, and the same no.
		expect(graph.show(every)).toBe("ask");
		expect(graph.gate.answer(false)).toEqual({ back: unfolded });
	});

	test("a yes lets the picture through, and what is within it is not asked about again", () => {
		const g = workspace(360);
		const graph = graphOf(g);
		graph.show(graph.opening);
		graph.show(choice("cross"));
		expect(graph.show(choice("all"))).toBe("ask");
		const yes = graph.gate.answer(true);
		expect(yes).toEqual({ agreed: 1440 });
		graph.agree(1440);
		expect(graph.show(choice("all"))).toBe("draw");
		expect(graph.show(choice("cross"))).toBe("draw");
		expect(graph.show(choice("all"))).toBe("draw");
	});

	test("the other ways are held to the same check: the folds, the unresolved targets, a focus, its depth, the list", () => {
		const g = workspace(90);
		// One procedure that 300 others call, and 40 targets that did not resolve.
		const hub = "/ws/cat0/S0.ssl#P0";
		for (let i = 0; i < 300; i++) {
			g.nodes.push({ id: `/ws/cat1/Many.ssl#C${i}`, name: `C${i}`, path: "/ws/cat1/Many.ssl", line: i });
			g.edges.push({ from: `/ws/cat1/Many.ssl#C${i}`, to: hub, crossScript: true, sites: [{ path: "/ws/cat1/Many.ssl", line: i }] });
		}
		g.scripts.push({ path: "/ws/cat1/Many.ssl", bytes: 1, procedures: [] });
		for (let i = 0; i < 40; i++) g.nodes.push({ id: `(unresolved)#T${i}`, name: `T${i}`, path: "(unresolved)", line: 0, kind: "unresolved" });
		const graph = graphOf(g);
		const opening = { ...graph.opening, unresolved: false };
		expect(graph.show(opening)).toBe("draw");
		// Folds set by anything that does not ask for itself: 660 procedures at once.
		expect(graph.show({ ...opening, scripts: new Set(), folders: new Set() })).toBe("ask");
		expect(graph.gate.answer(false)).toEqual({ back: opening });
		// A focus on the procedure everything calls: its 300 callers and its own three, drawn one by one.
		const focus = { ...opening, filter: { mode: "around" as const, focus: hub, depth: 1 } };
		expect(sizeOf(drawn(g, focus)).nodes).toBe(304);
		expect(graph.show(focus)).toBe("ask");
		expect(shownWords(opening, focus)).toBe("Show this picture");
		expect(graph.gate.answer(false)).toEqual({ back: opening });
		// A focus that is small passes; made deeper, it is asked about, and a no keeps the depth it had.
		const leaf = { ...opening, filter: { mode: "around" as const, focus: "/ws/cat1/Many.ssl#C7", depth: 1 } };
		expect(graph.show(leaf)).toBe("draw");
		const deeper = { ...leaf, filter: { ...leaf.filter, depth: 2 } };
		expect(graph.show(deeper)).toBe("ask");
		expect(graph.gate.answer(false)).toEqual({ back: leaf });
		// The unresolved targets, shown in a picture that is just under the limit without them.
		// 50 scripts open (200 procedures) and 41 folded: 241 nodes, and 281 with the 40 targets.
		const some = new Set(g.scripts.slice(50).map((s) => s.path));
		const under = { ...opening, scripts: some, folders: new Set<string>() };
		expect(sizeOf(drawn(g, under)).nodes).toBe(241);
		expect(241).toBeLessThanOrEqual(ASK_ABOVE);
		expect(graph.show(under)).toBe("draw");
		const withTargets = { ...under, unresolved: true };
		expect(sizeOf(drawn(g, withTargets)).nodes).toBe(281);
		expect(graph.show(withTargets)).toBe("ask");
		expect(shownWords(under, withTargets)).toBe("Show unresolved targets");
		expect(graph.gate.answer(false)).toEqual({ back: under });
		// In the list nothing is laid out, whatever is chosen there; the switch to the graph is what is asked about,
		// and a no goes back to the list with what was chosen in it.
		const listed: Picked = { ...opening, mode: "list", scripts: new Set(), folders: new Set() };
		expect(graph.show(listed)).toBe("list");
		const asGraph: Picked = { ...listed, mode: "graph" };
		expect(graph.show(asGraph)).toBe("ask");
		expect(graph.gate.answer(false)).toEqual({ back: listed });
	});

	test("while its question is open nothing is laid out and nothing more is asked", () => {
		const g = workspace(360);
		const graph = graphOf(g);
		graph.show(graph.opening);
		expect(graph.show(choice("all"))).toBe("ask");
		expect(graph.show(choice("all"))).toBe("wait");
		expect(graph.show(graph.opening)).toBe("wait");
		// What is chosen meanwhile is not what a no goes back to.
		graph.gate.rests({ ...choice("all"), mode: "list" });
		expect(graph.gate.answer(false)).toEqual({ back: graph.opening });
		expect(graph.gate.answer(false)).toBeNull();
	});

	test("a question that is not put (the graph is not the view on screen) holds the picture back until it is looked at again", () => {
		const g = workspace(360);
		const graph = graphOf(g);
		graph.show(graph.opening);
		expect(graph.show(choice("all"))).toBe("ask");
		graph.gate.unasked();
		// Not laid out meanwhile, and asked about when the layout looks again; a small picture passes as ever.
		expect(graph.show(choice("all"))).toBe("ask");
		graph.gate.unasked();
		expect(graph.show(choice("cross"))).toBe("draw");
	});

	test("the same choice over calls that have changed is not asked about: there is nothing to go back to", () => {
		const graph = graphOf(workspace(60));
		const all = choice("all");
		expect(graph.show(all)).toBe("draw");
		// Another choice that draws 360 nodes is asked about.
		const other = choice("all", { unresolved: false });
		expect(graph.layOut(other, 360)).toBe("ask");
		expect(graph.gate.answer(false)).toEqual({ back: all });
		// A refresh after scripts were added: 360 nodes too, but of the choice that was laid out last.
		const grown = workspace(90);
		expect(sizeOf(drawn(grown, all)).nodes).toBe(360);
		expect(graph.layOut(all, 360)).toBe("draw");
		// What has been laid out is not asked about again, nor is less of it: folding one script of that picture
		// (three nodes fewer) passes, where it would have been asked about for being more than was ever said yes to.
		expect(graph.agreed()).toBe(360);
		expect(graph.layOut(choice("all", { scripts: new Set(["/ws/cat0/S0.ssl"]) }), 357)).toBe("draw");
		expect(graph.layOut(other, 361)).toBe("ask");
	});

	test("the picture a workspace opens with is not asked about, however large, and a no with nothing before it has nothing to go back to", () => {
		// 300 scripts in one folder: folded, they are still 300 nodes, and there is nothing less to draw.
		const flat = workspace(300, 1);
		const graph = graphOf(flat);
		expect(openingSize(flat, openingFolds(flat, null, folderOf), folderOf)).toEqual({ nodes: 300, procedures: 0 });
		expect(graph.agreed()).toBe(300);
		expect(graph.show(graph.opening)).toBe("draw");
		// Coming back to it from a smaller picture is not asked about either; one script unfolded is.
		expect(graph.show({ ...graph.opening, filter: { mode: "cross", depth: 1 } })).toBe("draw");
		expect(graph.show(graph.opening)).toBe("draw");
		const one = new Set(graph.opening.scripts);
		one.delete("/ws/cat0/S0.ssl");
		expect(graph.show({ ...graph.opening, scripts: one })).toBe("ask");
		// Targets that are not drawn are not counted in what it opens with.
		const withTargets = { ...flat, nodes: [...flat.nodes, { id: "(unresolved)#Gone", name: "Gone", path: "(unresolved)", line: 0, kind: "unresolved" as const }] };
		const folds = openingFolds(withTargets, null, folderOf);
		expect(openingSize(withTargets, folds, folderOf, true).nodes).toBe(openingSize(withTargets, folds, folderOf, false).nodes + 1);
		// A large picture that is the first thing asked of a workspace (a focus asked for as the graph opens).
		const fresh = layoutGate<Picked>();
		fresh.opens();
		expect(fresh.next("k", choice("all"), 1440, 12)).toBe("ask");
		expect(fresh.answer(false)).toEqual({ back: null });
		// And an answer that comes after another workspace has opened is to nothing.
		expect(fresh.next("k", choice("all"), 1440, 12)).toBe("ask");
		fresh.opens();
		expect(fresh.answer(true)).toBeNull();
	});

	test("a choice is the same choice however it is written down, and another when anything that decides the picture differs", () => {
		const a = choice("all", { scripts: new Set(["/ws/b.ssl", "/ws/a.ssl"]), folders: new Set(["y", "x"]) });
		expect(chosenKey({ ...a, scripts: new Set(["/ws/a.ssl", "/ws/b.ssl"]), folders: new Set(["x", "y"]), filter: { depth: 4, mode: "all", focus: "/ws/a.ssl#P" } })).toBe(chosenKey(a));
		for (const other of [
			{ ...a, filter: { mode: "cross" as const, depth: 1 } },
			{ ...a, scripts: new Set(["/ws/a.ssl"]) },
			{ ...a, folders: new Set(["x"]) },
			{ ...a, unresolved: false },
			{ ...a, ticket: "LAB-7" },
		])
			expect(chosenKey(other)).not.toBe(chosenKey(a));
		// Around a focus, the focus, the depth and the direction are the choice; "both" is what no direction means.
		const around = choice("around", { filter: { mode: "around", focus: "/ws/a.ssl#P", depth: 2 } });
		expect(chosenKey({ ...around, filter: { ...around.filter, direction: "both" } })).toBe(chosenKey(around));
		expect(chosenKey({ ...around, filter: { ...around.filter, depth: 3 } })).not.toBe(chosenKey(around));
		expect(chosenKey({ ...around, filter: { ...around.filter, direction: "callers" } })).not.toBe(chosenKey(around));
		expect(chosenKey({ ...around, filter: { ...around.filter, focus: "/ws/a.ssl#Q" } })).not.toBe(chosenKey(around));
	});

	test("the question names the change in the bar's own words where one choice of the bar made it", () => {
		const cross = choice("cross");
		expect(shownWords(cross, choice("all"))).toBe("Show every call");
		expect(shownWords(choice("all", { scripts: new Set(["/ws/a.ssl"]) }), cross)).toBe("Show calls between scripts");
		expect(shownWords(choice("all", { unresolved: false }), choice("all"))).toBe("Show unresolved targets");
		// Folds, a ticket, the list, or nothing before it: the picture as it is.
		expect(shownWords(choice("all", { scripts: new Set(["/ws/a.ssl"]) }), choice("all"))).toBe("Show this picture");
		expect(shownWords(null, choice("all"))).toBe("Show this picture");
	});

	test("GraphView puts every picture to that check before it is laid out, and a no puts back what was chosen (source only: the view needs a DOM and a layout to run)", () => {
		const src = readSrc("src/view/graph/GraphView.tsx");
		const layout = between(src, "() => [graph(), drawn(), mode(), gathered(), govScriptState().map, fitKey(), folding(), state.workspace?.root, state.settings.limits.bytes, answered()] as const,", "void (async () => {");
		// The check comes before the layout is started, and a picture that is held back starts none.
		const [checked, held, started] = [layout.indexOf("const verdict = gate.next(choice, now, large.nodes, agreedNodes);"), layout.indexOf('if (verdict !== "draw") {'), layout.indexOf("const run = ++layoutRun;")];
		expect(checked).toBeGreaterThan(0);
		expect(held).toBeGreaterThan(checked);
		expect(started).toBeGreaterThan(held);
		expect(layout).toContain("const now = untrack(picked);\n\t\t\tconst choice = chosenKey(now);\n\t\t\tconst large = sizeOf(keep.nodes);");
		expect(layout).toContain('if (verdict === "ask" && untrack(isGraphView)) queueMicrotask(() => askLarger(large, now));');
		expect(layout).toContain('else if (verdict === "ask") (gate.unasked(), (heldUnseen = true));');
		expect(layout).toContain('if (g && keep && as !== "graph") gate.rests(untrack(picked));');
		// A picture that is laid out counts as agreed to.
		expect(layout.indexOf("agreedNodes = Math.max(agreedNodes, large.nodes);")).toBeGreaterThan(layout.indexOf('if (verdict !== "draw") {'));
		// The layout itself is asked for in one place only, after the check.
		expect(src.match(/elk\.layout\(/g)?.length).toBe(1);
		expect(src.indexOf("elk.layout(")).toBeGreaterThan(src.indexOf("const verdict = gate.next("));
		// What is chosen is everything that decides the picture, and all of it is put back after a no.
		expect(src).toContain("const picked = (): Picked => ({ mode: mode(), filter: filter(), scripts: folded(), folders: foldedDirs(), unresolved: unresolved(), ticket: ticketSubgraphOnly() ? ticketHighlightKey() : null, ticketOnly: ticketSubgraphOnly() });");
		const back = between(src, "const goBack = (to: Picked) => {", "const askLarger = (");
		for (const put of ["setFilter(to.filter);", "setFolded(to.scripts);", "setFoldedDirs(to.folders);", "setUnresolved(to.unresolved);", "setTicketSubgraphOnlySignal(to.ticketOnly);", "if (mode() !== to.mode) choose(to.mode);"]) expect(back).toContain(put);
		const ask = between(src, "const askLarger = (", "const toggleFold = (");
		expect(ask).toContain('chooseAnswer(unfoldQuestion(shownWords(gate.asked(), now), size), ["Show"])');
		expect(ask).toContain('const taken = gate.answer(answer === "Show");');
		expect(ask).toContain('if ("agreed" in taken) agreedNodes = Math.max(agreedNodes, taken.agreed);');
		expect(ask).toContain("else if (taken.back) (keepFor = chosenKey(taken.back)), goBack(taken.back);");
		expect(ask).toContain("setAnswered((n) => n + 1);");
		// After a no the picture that is still on screen is left there, not laid out again.
		expect(layout).toContain("if (kept === choice && onScreen?.every((value, i) => value === from[i])) {");
		expect(src).toContain("showNext = null;\n\t\t\t\t\tonScreen = from;");
		// A workspace's graph opens with nothing laid out, and its opening picture counted as agreed to.
		expect(src).toContain("gate.opens();\n\t\t\t\tagreedNodes = openingSize(read, opening, folderOf, unresolved()).nodes;");
		// The Show list is one of the ways, and needs nothing of its own: it sets what is shown, and the layout asks.
		expect(src).toContain('onChange={(e) => setFilter({ ...filter(), mode: e.currentTarget.value as Filter["mode"] })}');
	});
});

// --- B8-3. Blocks: nothing is dropped between a doc block and its procedure --------------------------------

describe("Blocks — a drop on a documented procedure lands above its doc block (B8-3)", () => {
	const span = (from: number, to: number) => ({ start: { line: from - 1, character: 0 }, end: { line: to - 1, character: 200 } });
	const text = [
		":PROCEDURE First;", //            1
		":RETURN 1;", //                   2
		":ENDPROC;", //                    3
		"", //                             4
		"/* Returns two;", //              5  doc block of Second
		"/* @visibility public;", //       6  the annotation between them
		"", //                             7
		":PROCEDURE Second;", //           8
		":RETURN 2;", //                   9
		":ENDPROC;", //                   10
		"", //                            11
		"nTotal := 0;", //                12
	];
	const syntax: SyntaxNodeIn[] = [
		{ kind: "procedure", name: "First", range: span(1, 3), closerRange: span(3, 3), children: [{ kind: "statement", keyword: "RETURN", range: span(2, 2) }] },
		{ kind: "docBlock", range: span(5, 5) },
		{ kind: "comment", range: span(6, 6) },
		{ kind: "procedure", name: "Second", range: span(8, 10), closerRange: span(10, 10), children: [{ kind: "statement", keyword: "RETURN", range: span(9, 9) }] },
		{ kind: "statement", range: span(12, 12) },
	];
	const root = () => treeFromSyntax(text, syntax, () => []);
	const at = (parent: Node, line: number) => parent.children.find((c) => c.start === line)!;
	/** The text after a drop, as BlocksView's `drop` makes it: the dropped lines put in at the start of that line. */
	const dropped = (line: number) => [...text.slice(0, line - 1), "nCount := 0;", ...text.slice(line - 1)];
	const gap = (lines: string[]) => lines.indexOf(":PROCEDURE Second;") - lines.indexOf("/* Returns two;");

	test("the card is the doc block, the annotation, the blank line and the procedure", () => {
		const r = root();
		expect(procedureGroups(r.children).map((g) => g.map((n) => n.start))).toEqual([[1], [4], [5, 6, 7, 8], [11], [12]]);
		expect(cardOf(r, at(r, 8))).toEqual({ start: 5, end: 10 });
	});

	test("a drop on the procedure's header goes in above the doc block, not at the procedure's own first line", () => {
		const r = root();
		const second = at(r, 8);
		expect(second).toMatchObject({ kind: "procedure", name: "Second" });
		expect(dropLine(r, second)).toBe(5);
		const after = dropped(dropLine(r, second));
		expect(after.slice(3, 9)).toEqual(["", "nCount := 0;", "/* Returns two;", "/* @visibility public;", "", ":PROCEDURE Second;"]);
		expect(gap(after)).toBe(gap(text));
		// What the header's zone used to give: the procedure's own line, which put the text between the two.
		expect(dropped(second.start).slice(4, 9)).toEqual(["/* Returns two;", "/* @visibility public;", "", "nCount := 0;", ":PROCEDURE Second;"]);
	});

	test("so does a drop on the annotation or the blank line between them, and on the doc block itself", () => {
		const r = root();
		for (const line of [5, 6, 7]) {
			expect(dropLine(r, at(r, line))).toBe(5);
			expect(gap(dropped(dropLine(r, at(r, line))))).toBe(gap(text));
		}
	});

	test("the card's other zones are as they were: into the procedure, after it, and on blocks that are no card", () => {
		const r = root();
		const second = at(r, 8);
		// Into it: above the statement dropped on, or above the closing line, which is the end of the body.
		expect(dropLine(second, at(second, 9))).toBe(9);
		expect(dropLine(second, at(second, 10))).toBe(10);
		expect(dropped(10).slice(7, 11)).toEqual([":PROCEDURE Second;", ":RETURN 2;", "nCount := 0;", ":ENDPROC;"]);
		// After it: the blank line under the card, and the statement after that.
		expect(dropLine(r, at(r, 11))).toBe(11);
		expect(dropLine(r, at(r, 12))).toBe(12);
		// A procedure with no doc block, and the blank line above a card (which is under the procedure before it).
		expect(dropLine(r, at(r, 1))).toBe(1);
		expect(dropLine(r, at(r, 4))).toBe(4);
	});

	test("BlocksView gives every drop zone that line, and marks it where the text will land (source only: the view needs a DOM and Monaco to run)", () => {
		const src = readSrc("src/view/blocks/BlocksView.tsx");
		const zone = between(src, "const dropZone = (node: () => Node) => {", "// Out of the Tab order");
		expect(zone).toContain("const parent = parentOf(n);\n\t\t\treturn parent ? dropLine(parent, n) : n.start;");
		expect(zone).toContain("onDragOver: (e: DragEvent) => (e.preventDefault(), setDropAt(line())),");
		expect(zone).toContain("onDrop: (e: DragEvent) => drop(e, line()),");
		// The three zones (a block's header, a statement, a blank line) are the only ones, and none works its line out itself.
		expect(src.match(/\{\.\.\.dropZone\(\(\) => p\.node\)\}/g)?.length).toBe(3);
		expect(src.match(/dropZone\(/g)?.length).toBe(3);
		expect(src).not.toContain("dropZone(() => p.node.start)");
		expect(src.match(/onDrop/g)?.length).toBe(1);
		// The mark is drawn on the block that starts at the line: the doc block's header, for a drop on its procedure.
		expect(src.match(/drop: dropAt\(\) === p\.node\.start/g)?.length).toBe(3);
	});
});
