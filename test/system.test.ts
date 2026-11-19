import { expect, test } from "bun:test";
import { portalScheme } from "../src/bun/system";

test("the settings portal's colour scheme is read as dark, light or no preference", () => {
	expect(portalScheme("(<<uint32 1>>,)\n")).toBe(true);
	expect(portalScheme("(<<uint32 2>>,)\n")).toBe(false);
	expect(portalScheme("(<<uint32 0>>,)\n")).toBeUndefined();
	expect(portalScheme("Error: no such interface")).toBeUndefined();
	expect(portalScheme("")).toBeUndefined();
});
