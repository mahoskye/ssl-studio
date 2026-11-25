import { expect, test } from "bun:test";
import { fileIcon, fileKind } from "../src/view/fileIcon";

test("a file's kind comes from the longest ending it has", () => {
	expect(["Release.ssl", "RELEASE.SRVSCR", "Old.ssl.txt"].map(fileKind)).toEqual(["script", "script", "script"]);
	expect(["Samples.ds", "Samples.ds.txt", "demo.sql"].map(fileKind)).toEqual(["data", "data", "data"]);
	// A plan and its companion plan doc are plans, though one is a .json and the other a .md.
	expect(["Set.plan.json", "Set.plan.md"].map(fileKind)).toEqual(["plan", "plan"]);
	expect(["README.md", "notes.markdown", "Set.spec.md"].map(fileKind)).toEqual(["doc", "doc", "doc"]);
	expect(["project.toml", "package.json"].map(fileKind)).toEqual(["config", "config"]);
	expect(["LICENSE", "photo.png", ".ssl"].map(fileKind)).toEqual(["file", "file", "script"]);
});

test("a folder's mark says whether it is open, whatever its name", () => {
	const closed = fileIcon("src.ssl", { open: false });
	const open = fileIcon("src.ssl", { open: true });
	expect([closed.kind, open.kind]).toEqual(["folder", "folder"]);
	expect(closed.glyph).not.toBe(open.glyph);
	expect(fileIcon("Release.ssl")).toMatchObject({ kind: "script", what: "SSL script" });
	// Every mark is one character of the icon font's private range.
	for (const name of ["a.ssl", "a.ds", "a.plan.json", "a.md", "a.toml", "a"]) expect(fileIcon(name).glyph).toMatch(/^[-]$/);
});
