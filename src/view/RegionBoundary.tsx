import { Errored, Show, untrack } from "solid-js";
import type { JSX } from "@solidjs/web";
import { log } from "./state";

/**
 * A region's own error boundary. Solid stops the subtree whose effect, cleanup or onSettled threw and hands the
 * error to the nearest boundary. With only the one at the root (main.tsx), a throw anywhere replaced the whole
 * window, and a tab that threw as it was restored did so again after every reload. Around a panel, an editor
 * group and each editor view, the same throw costs that region alone: the tabs, the menus and Save stay.
 */
export function RegionBoundary(props: { what: string; hint?: string; children: JSX.Element }) {
	return (
		<Errored
			fallback={(err, reset) => {
				const message = () => {
					const e = err();
					return e instanceof Error ? e.message : String(e ?? "Unknown error");
				};
				// Output keeps the stack: the card says what failed, the log says where. Written after this render,
				// since the fallback is built inside a tracked scope and may not write to the store there.
				const first = untrack(err);
				const what = untrack(() => props.what);
				queueMicrotask(() => log(`display error (${what}): ${first instanceof Error ? (first.stack ?? first.message) : String(first)}`));
				return (
					<div class="region-error" role="alert">
						<strong>{props.what} could not be shown</strong>
						<p>{message()}</p>
						<Show when={props.hint}>
							<p>{props.hint}</p>
						</Show>
						<button type="button" class="primary" onClick={() => reset()}>
							Try again
						</button>
					</div>
				);
			}}
		>
			{props.children}
		</Errored>
	);
}
