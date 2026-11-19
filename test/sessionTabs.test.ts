import { describe, expect, test } from "bun:test";
import { packTabs, tabsKey, unpackTabs } from "../src/view/editor/sessionTabs";

test("the tabs of a folder come back as they were left", () => {
	const groups = [
		{ tabs: ["/w/A.ssl", "/w/B.ssl"], active: "/w/A.ssl", mode: "blocks" as const },
		{ tabs: ["/w/C.ssl"], active: "/w/C.ssl" },
	];
	expect(unpackTabs(packTabs(groups, 1))).toEqual({
		groups: [
			{ tabs: ["/w/A.ssl", "/w/B.ssl"], active: "/w/A.ssl" },
			{ tabs: ["/w/C.ssl"], active: "/w/C.ssl" },
		],
		activeGroup: 1,
	});
	expect(tabsKey("/w")).toBe("tabs:/w");
});

test("what storage holds is read with suspicion", () => {
	expect(unpackTabs(null)).toBeNull();
	expect(unpackTabs("not json")).toBeNull();
	expect(unpackTabs('{"groups":"no"}')).toBeNull();
	// Nothing open is nothing to restore.
	expect(unpackTabs(packTabs([{ tabs: [], active: null }], 0))).toBeNull();
	// A tab that is not a path, a second copy, and an active tab that is not there.
	expect(unpackTabs(JSON.stringify({ groups: [{ tabs: ["/w/A.ssl", 7, "", "/w/A.ssl", "/w/B.ssl"], active: "/w/Gone.ssl" }], activeGroup: 9 }))).toEqual({
		groups: [{ tabs: ["/w/A.ssl", "/w/B.ssl"], active: "/w/B.ssl" }],
		activeGroup: 0,
	});
	// An empty second group is not kept; an empty first one is, when the second holds the tabs.
	expect(unpackTabs(JSON.stringify({ groups: [{ tabs: ["/w/A.ssl"], active: "/w/A.ssl" }, { tabs: [] }], activeGroup: 1 }))).toEqual({ groups: [{ tabs: ["/w/A.ssl"], active: "/w/A.ssl" }], activeGroup: 0 });
	expect(unpackTabs(JSON.stringify({ groups: [{ tabs: [] }, { tabs: ["/w/B.ssl"] }], activeGroup: 1 }))?.groups.length).toBe(2);
});

import { packViews, unpackViews, viewsKey } from "../src/view/editor/sessionTabs";

describe("the panels a folder was left with", () => {
	const lefts = ["explorer", "objects", "search"];
	const bottoms = ["problems", "output"];

	test("come back as they were kept", () => {
		expect(unpackViews(packViews("objects", "output"), lefts, bottoms)).toEqual({ left: "objects", bottom: "output" });
		expect(viewsKey("/w")).toBe("views:/w");
	});

	test("a panel there is no longer, or never was, does not come back", () => {
		expect(unpackViews(packViews("gone", "output"), lefts, bottoms)).toEqual({ bottom: "output" });
		expect(unpackViews(JSON.stringify({ left: 3, bottom: null }), lefts, bottoms)).toEqual({});
	});

	test("nothing kept, or something unreadable, changes nothing", () => {
		expect(unpackViews(null, lefts, bottoms)).toEqual({});
		expect(unpackViews("not json", lefts, bottoms)).toEqual({});
		expect(unpackViews("null", lefts, bottoms)).toEqual({});
	});
});

