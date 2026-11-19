/** A day as it is written in a document, 2026-11-18: the day it is where the person is, not the day it is in UTC. */
export function localDay(date = new Date()): string {
	const two = (n: number) => String(n).padStart(2, "0");
	return `${date.getFullYear()}-${two(date.getMonth() + 1)}-${two(date.getDate())}`;
}
