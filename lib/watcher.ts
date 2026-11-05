/**
 * Team wakeup (feature spec S10, docs/architecture.md §5): `fs.watch` on the
 * team directory (recursive when supported) plus a polling fallback. Bursts of
 * changes are coalesced into one run (trailing debounce: each change restarts the
 * quiet period, bounded by a maximum wait); runs never overlap, and changes during a
 * run cause exactly one trailing run.
 *
 * macOS FSEvents reports changes in batches roughly 50 ms apart, so the debounce must
 * be longer than that to coalesce a burst.
 */

import { watch as fsWatch } from "node:fs";

export const POLL_INTERVAL_MS = 5000;
const DEFAULT_DEBOUNCE_MS = 100;

export interface Closable {
	close(): void;
}

export type WatchFn = (dir: string, options: { recursive: boolean }, listener: (event: string, filename: string | Buffer | null) => void) => Closable;

export interface WatchOptions {
	debounceMs?: number;
	pollMs?: number;
	/** Replace fs.watch (tests). Throwing means "unsupported" and falls back to polling only. */
	watch?: WatchFn;
	/** Ignore changes whose path (relative to `dir`) is rejected. Polling always runs. */
	filter?: (relativePath: string) => boolean;
}

export interface TeamWatcher {
	readonly mode: "recursive" | "flat" | "polling";
	/** Request a run (coalesced with other pending requests). */
	trigger(): void;
	/** Stop watching and polling; waits for a running pass. Idempotent. */
	stop(): Promise<void>;
}

const defaultWatch: WatchFn = (dir, options, listener) => fsWatch(dir, { recursive: options.recursive, persistent: false }, listener);

export function watchTeam(dir: string, onChange: () => Promise<void>, options: WatchOptions = {}): TeamWatcher {
	const debounceMs = options.debounceMs ?? DEFAULT_DEBOUNCE_MS;
	const pollMs = options.pollMs ?? POLL_INTERVAL_MS;
	const watch = options.watch ?? defaultWatch;
	const filter = options.filter;

	const maxWaitMs = debounceMs * 4;
	let stopped = false;
	let timer: NodeJS.Timeout | undefined;
	let firstPendingAt = 0;
	let running: Promise<void> | undefined;
	let again = false;

	const run = () => {
		timer = undefined;
		if (stopped) return;
		if (running) {
			again = true;
			return;
		}
		running = (async () => {
			try {
				await onChange();
			} catch {
				// The callback reports its own errors; a failed pass must not stop the watcher.
			}
		})().finally(() => {
			running = undefined;
			if (again && !stopped) {
				again = false;
				schedule();
			}
		});
	};

	const schedule = () => {
		if (stopped) return;
		const nowMs = Date.now();
		if (timer) {
			if (nowMs - firstPendingAt >= maxWaitMs) return; // let the pending run fire
			clearTimeout(timer);
		} else {
			firstPendingAt = nowMs;
		}
		const delay = Math.min(debounceMs, Math.max(0, firstPendingAt + maxWaitMs - nowMs));
		timer = setTimeout(run, delay);
		timer.unref?.();
	};

	const listener = (_event: string, filename: string | Buffer | null) => {
		if (filter && filename !== null && !filter(String(filename))) return;
		schedule();
	};

	let watcher: Closable | undefined;
	let mode: TeamWatcher["mode"] = "polling";
	for (const recursive of [true, false]) {
		try {
			watcher = watch(dir, { recursive }, listener);
			mode = recursive ? "recursive" : "flat";
			break;
		} catch {
			watcher = undefined;
		}
	}
	(watcher as { on?: (event: string, fn: () => void) => void } | undefined)?.on?.("error", () => {
		// The polling fallback keeps working when the watcher fails later.
	});

	const poll = setInterval(schedule, pollMs);
	poll.unref?.();

	return {
		mode,
		trigger: schedule,
		async stop() {
			if (stopped) return;
			stopped = true;
			clearInterval(poll);
			if (timer) clearTimeout(timer);
			timer = undefined;
			try {
				watcher?.close();
			} catch {
				// Already closed.
			}
			if (running) await running;
		},
	};
}
