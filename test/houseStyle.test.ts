import { expect, test } from "bun:test";
import { countHistoryEntries, level } from "../src/shared/houseStyle";

test("history entries are counted from the banner's modification markers", () => {
	const banner = ["/****", "Description.. : x", "____", "Modification. : first", "Author....... :", "____", "Modification. : second", "****/;"];
	expect(countHistoryEntries(banner)).toBe(2);
	expect(countHistoryEntries(["Modification : loose spacing"])).toBe(1);
	expect(countHistoryEntries(["  no marker here"])).toBe(0);
});

test("levels", () => {
	expect(level(100, 400)).toBe("ok");
	expect(level(370, 400)).toBe("near");
	expect(level(401, 400)).toBe("over");
});
