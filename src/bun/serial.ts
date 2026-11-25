// Work on one thing, one after another. Two saves of a file asked for at once
// used to write through the same temporary file, and two saves of the
// settings each read the file before the other had written it: one failed, or
// one's change was lost. Work given for a key here runs in the order it was
// asked for, each after the one before has finished, whether that one came to
// anything or failed. Work for different keys does not wait.
//
// Work must not ask for its own key again and wait for it: it would be
// waiting for itself. What needs to write a file from inside such work is
// given the write itself (WorkspaceFiles.alone).

export class Serial {
	private last = new Map<string, Promise<void>>();

	run<T>(key: string, work: () => Promise<T>): Promise<T> {
		const done = (this.last.get(key) ?? Promise.resolve()).then(work);
		// What is waited on never fails: a save that failed is its asker's to hear of, not the next save's.
		const settled = done.then(
			() => {},
			() => {},
		);
		this.last.set(key, settled);
		// The last of a key's work takes the key with it, so that nothing is kept for a file no longer written.
		void settled.then(() => {
			if (this.last.get(key) === settled) this.last.delete(key);
		});
		return done;
	}

	/** What is waiting or under way for the keys that match, to be waited for: each ends without failing. */
	pending(match: (key: string) => boolean): Promise<void>[] {
		return [...this.last].filter(([key]) => match(key)).map(([, settled]) => settled);
	}

	/** How many keys have work waiting or under way: for the tests. */
	get busy() {
		return this.last.size;
	}
}
