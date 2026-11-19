// Rows asked for from elsewhere: a registry opened from a ticket's page shows
// the rows that name that ticket, and not the whole table to look through.
import { createSignal } from "solid-js";

const [asked, setAsked] = createSignal<{ path: string; filter: string } | null>(null);

/** What was asked for and not yet shown. */
export const rowsAsked = asked;
/** Asks the table of that file, open or about to be, to narrow its rows to those the words are in. */
export const askRows = (path: string, filter: string) => setAsked({ path, filter });
/** The table has it. */
export const rowsShown = () => setAsked(null);
