// A picture of the call graph or a plan's chart as a file: the SVG on screen,
// whole, with the styles it gets from the style sheet written onto each element,
// so that it looks the same in a document or a browser that has no such sheet.
import { joinPath } from "../../shared/paths";
import { backend } from "../backend";
import { ask, choose } from "../dialogs";
import { notify, openFile, setState, state } from "../state";
import type { Size } from "./canvas";

/** What an element is drawn with, and must take with it when it leaves the page. */
const KEPT = ["fill", "stroke", "stroke-width", "stroke-dasharray", "stroke-linecap", "stroke-linejoin", "opacity", "font-family", "font-size", "font-weight", "font-style", "text-anchor"];
/** What is there for the pointer or for measuring, and is no part of the picture. */
const NOT_DRAWN = ".g-edge-hit, .g-far, .plan-edge-hit, .plan-probe";
const MARGIN = 20;

const escapeXmlAttr = (value: string) =>
	value.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/** Writes the computed style of each element of `from` onto the element of `to` in the same place. */
function carryStyles(from: Element, to: Element) {
	const style = getComputedStyle(from);
	const kept = KEPT.map((name) => [name, style.getPropertyValue(name)] as const).filter(([, value]) => value);
	to.setAttribute("style", kept.map(([name, value]) => `${name}:${value}`).join(";"));
	for (const name of ["class", "tabindex", "role", "aria-label", "aria-expanded", "aria-describedby"]) to.removeAttribute(name);
	for (let i = 0; i < from.children.length; i++) carryStyles(from.children[i]!, to.children[i]!);
}

/**
 * The picture in `svg` as the text of a file: everything that is drawn, at its
 * full size whatever the zoom, on the window's own background.
 */
export function pictureOf(svg: SVGSVGElement, content: Size): string {
	if (!Number.isFinite(content.width) || !Number.isFinite(content.height) || !(content.width > 0) || !(content.height > 0)) return "";
	const drawn = svg.querySelector<SVGGElement>(":scope > g[transform]");
	if (!drawn) return "";
	const copy = drawn.cloneNode(true) as SVGGElement;
	carryStyles(drawn, copy);
	const defs = svg.querySelector<SVGDefsElement>(":scope > defs");
	const defsCopy = defs?.cloneNode(true) as SVGDefsElement | undefined;
	if (defs && defsCopy) {
		carryStyles(defs, defsCopy);
		// A marker is found by its id, which carryStyles left alone.
		defsCopy.removeAttribute("style");
	}
	// carryStyles took the classes away, so what is not drawn is found on the original and removed by its place.
	const places = [...drawn.querySelectorAll(NOT_DRAWN)].map((el) => {
		const path: number[] = [];
		for (let at: Element = el; at !== drawn; at = at.parentElement!) path.unshift([...at.parentElement!.children].indexOf(at));
		return path;
	});
	const doomed = places.map((path) => path.reduce<Element | undefined>((at, i) => at?.children[i], copy));
	for (const el of doomed) el?.remove();
	copy.setAttribute("transform", `translate(${MARGIN},${MARGIN})`);
	const [width, height] = [Math.ceil(content.width) + 2 * MARGIN, Math.ceil(content.height) + 2 * MARGIN];
	const background = escapeXmlAttr(getComputedStyle(document.documentElement).getPropertyValue("--bg").trim() || "#ffffff");
	const serialise = (node: Node) => new XMLSerializer().serializeToString(node);
	return [
		`<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">`,
		`<rect width="100%" height="100%" fill="${background}"/>`,
		defsCopy ? serialise(defsCopy) : "",
		serialise(copy),
		"</svg>\n",
	].join("");
}

export { pictureName } from "./canvas";

/**
 * Asks where in the workspace to keep the picture, and writes it there. A file
 * that is already there is replaced only if the user says so (ADR 0009).
 */
export async function savePicture(svg: SVGSVGElement | undefined, content: Size | null | undefined, suggested: string) {
	const root = state.workspace?.root;
	if (!svg || !content || !root) return;
	const answer = await ask("Save the picture as (a path inside this folder)", suggested);
	if (!answer?.trim()) return;
	const relative = /\.svg$/i.test(answer.trim()) ? answer.trim() : `${answer.trim()}.svg`;
	const path = joinPath(root, relative);
	const text = pictureOf(svg, content);
	if (!text) return notify("There is no picture to save yet.");
	try {
		await backend.create(path, "file");
	} catch (e: any) {
		if (!/already exists/.test(String(e?.message ?? e))) return notify(`The picture was not saved: ${e?.message ?? e}`, "error");
		if ((await choose(`${relative} is already there. Replace it?`, ["Replace"], { danger: "Replace" })) !== "Replace") return;
	}
	try {
		await backend.write(path, text);
		setState((s) => {
			s.treeVersion += 1;
		});
		notify(`Saved the picture as ${relative}.`, "info", { label: "Open", run: () => void openFile(path) });
	} catch (e: any) {
		notify(`The picture was not saved: ${e?.message ?? e}`, "error");
	}
}
