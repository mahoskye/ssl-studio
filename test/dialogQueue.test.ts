import { describe, expect, test } from "bun:test";
import { defaultButton, DialogQueue, type Request } from "../src/view/dialogQueue";

function queueWithScreen() {
	const shown: (Request | null)[] = [];
	return { queue: new DialogQueue((request) => shown.push(request)), shown };
}

describe("dialogs wait their turn", () => {
	test("a second dialog does not replace the open one, and both are answered in order", async () => {
		const { queue, shown } = queueWithScreen();
		const first = queue.choose("a.ssl has unsaved changes.", ["Save", "Discard"]);
		const second = queue.choose("b.ssl has unsaved changes.", ["Save", "Discard"]);
		expect(queue.length).toBe(2);
		expect(shown.map((r) => r?.title)).toEqual(["a.ssl has unsaved changes."]);
		expect(queue.current?.title).toBe("a.ssl has unsaved changes.");

		queue.finish(queue.current!, { button: "Save", value: "" });
		expect(await first).toBe("Save");
		expect(queue.current?.title).toBe("b.ssl has unsaved changes.");

		queue.finish(queue.current!, null);
		expect(await second).toBeNull();
		expect(queue.current).toBeNull();
		expect(shown.map((r) => r?.title ?? null)).toEqual(["a.ssl has unsaved changes.", "b.ssl has unsaved changes.", null]);
	});

	test("a prompt gives its text on OK and null on Cancel", async () => {
		const { queue } = queueWithScreen();
		const named = queue.ask("Name of the new region", "Checks");
		expect(queue.current).toMatchObject({ input: true, value: "Checks", buttons: ["OK"] });
		queue.finish(queue.current!, { button: "OK", value: "Totals" });
		expect(await named).toBe("Totals");

		const cancelled = queue.ask("Name of the new plan");
		queue.finish(queue.current!, null);
		expect(await cancelled).toBeNull();
	});

	test("an answer for a dialog that is not the open one is ignored", async () => {
		const { queue } = queueWithScreen();
		const first = queue.choose("one", ["Yes"]);
		const open = queue.current!;
		const second = queue.choose("two", ["Yes"]);
		queue.finish(open, { button: "Yes", value: "" });
		// A late second answer for the first (Escape, then a click) must not answer the second.
		queue.finish(open, null);
		expect(queue.current?.title).toBe("two");
		queue.finish(queue.current!, { button: "Yes", value: "" });
		expect(await first).toBe("Yes");
		expect(await second).toBe("Yes");
	});

	test("a dialog asked for while answering another is shown next", async () => {
		const { queue } = queueWithScreen();
		const first = queue.choose("one", ["Yes"]).then(() => queue.choose("three", ["Yes"]));
		const second = queue.choose("two", ["Yes"]);
		queue.finish(queue.current!, { button: "Yes", value: "" });
		expect(queue.current?.title).toBe("two");
		queue.finish(queue.current!, { button: "Yes", value: "" });
		await second;
		await Promise.resolve();
		expect(queue.current?.title).toBe("three");
		queue.finish(queue.current!, null);
		expect(await first).toBeNull();
	});
});

describe("the button Enter presses", () => {
	test("the first button, unless it is the dangerous one: then Cancel", () => {
		expect(defaultButton({ buttons: ["Save", "Discard"] })).toBe("Save");
		expect(defaultButton({ buttons: ["Save", "Discard"], danger: "Discard" })).toBe("Save");
		expect(defaultButton({ buttons: ["Delete"], danger: "Delete" })).toBeNull();
		expect(defaultButton({ buttons: [] })).toBeNull();
	});

	test("choose carries the dangerous button to the dialog", () => {
		const { queue } = queueWithScreen();
		void queue.choose("Reset every shortcut?", ["Reset shortcuts"], { danger: "Reset shortcuts" });
		expect(queue.current?.danger).toBe("Reset shortcuts");
		expect(defaultButton(queue.current!)).toBeNull();
	});
});
