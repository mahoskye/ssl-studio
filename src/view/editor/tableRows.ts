// Rows asked for from elsewhere: a registry opened from a ticket's page shows
// the rows that name that ticket, and not the whole table to look through.
import { createSignal } from "solid-js";

const [asked, setAsked] = createSignal<{ path: string; ticket: string; at: number } | null>(null);
/** How long a request waits for its table: a table opened later, for another reason, shows every row. */
const WAITS_MS = 10_000;

/** What was asked for and not yet shown; nothing once it has waited too long. */
export const rowsAsked = () => {
	const wanted = asked();
	return wanted && Date.now() - wanted.at <= WAITS_MS ? wanted : null;
};
/** Asks the table of that file, open or about to be, to show only the rows whose ticket column names this ticket. */
export const askRows = (path: string, ticket: string) => setAsked({ path, ticket, at: Date.now() });
/** The table has it. */
export const rowsShown = () => setAsked(null);
