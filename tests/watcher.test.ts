import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { POLL_INTERVAL_MS, watchTeam } from "../lib/watcher.ts";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function tempDir(): Promise<{ dir: string; done: () => Promise<void> }> {
	const dir = await mkdtemp(join(tmpdir(), "gentle-teams-watch-"));
	await mkdir(join(dir, "requests", "r1", "events"), { recursive: true });
	await mkdir(join(dir, "presence"), { recursive: true });
	await sleep(200); // macOS FSEvents may report changes made just before a watcher starts
	return { dir, done: () => rm(dir, { recursive: true, force: true }) };
}

async function until(predicate: () => boolean, ms = 2000): Promise<void> {
	const end = Date.now() + ms;
	while (!predicate()) {
		if (Date.now() > end) throw new Error("condition not reached");
		await sleep(5);
	}
}

test("S10 polling fallback runs every 5 s by default", () => {
	assert.equal(POLL_INTERVAL_MS, 5000);
});

test("S10 fs.watch detects nested writes and coalesces a burst into one run", async () => {
	const { dir, done } = await tempDir();
	let runs = 0;
	const watcher = watchTeam(dir, async () => void runs++, { debounceMs: 150, pollMs: 60_000 });
	try {
		assert.notEqual(watcher.mode, "polling");
		await sleep(50); // let the watcher settle
		for (let i = 0; i < 10; i++) await writeFile(join(dir, "requests", "r1", "events", `00000${i}.json`), "{}");
		await until(() => runs >= 1);
		await sleep(400);
		assert.equal(runs, 1, "a burst of 10 writes produces one run");
		await writeFile(join(dir, "requests", "r1", "events", "000010.json"), "{}");
		await until(() => runs >= 2);
	} finally {
		await watcher.stop();
		await done();
	}
});

test("S10 filtered paths do not trigger a run", async () => {
	const { dir, done } = await tempDir();
	let runs = 0;
	const watcher = watchTeam(dir, async () => void runs++, {
		debounceMs: 20,
		pollMs: 60_000,
		filter: (path) => !path.startsWith("presence"),
	});
	try {
		await sleep(50);
		await writeFile(join(dir, "presence", "backend.json"), "{}");
		await sleep(150);
		assert.equal(runs, 0);
	} finally {
		await watcher.stop();
		await done();
	}
});

test("S10 when fs.watch is unavailable, polling still triggers runs", async () => {
	const { dir, done } = await tempDir();
	let runs = 0;
	const watcher = watchTeam(dir, async () => void runs++, {
		debounceMs: 1,
		pollMs: 20,
		watch: () => {
			throw new Error("unsupported");
		},
	});
	try {
		assert.equal(watcher.mode, "polling");
		await until(() => runs >= 3);
	} finally {
		await watcher.stop();
		await done();
	}
});

test("S10 runs never overlap; triggers during a run cause exactly one trailing run", async () => {
	const { dir, done } = await tempDir();
	let active = 0;
	let maxActive = 0;
	let runs = 0;
	const watcher = watchTeam(
		dir,
		async () => {
			active++;
			maxActive = Math.max(maxActive, active);
			runs++;
			await sleep(60);
			active--;
		},
		{ debounceMs: 1, pollMs: 60_000, watch: () => ({ close() {} }) },
	);
	try {
		watcher.trigger();
		await until(() => runs === 1);
		for (let i = 0; i < 5; i++) watcher.trigger();
		await until(() => runs === 2 && active === 0);
		await sleep(100);
		assert.equal(runs, 2);
		assert.equal(maxActive, 1);
	} finally {
		await watcher.stop();
		await done();
	}
});

test("S10 stop closes the watcher, waits for the running pass, and ignores later changes", async () => {
	const { dir, done } = await tempDir();
	let runs = 0;
	let finished = false;
	let closed = 0;
	const watcher = watchTeam(
		dir,
		async () => {
			runs++;
			await sleep(40);
			finished = true;
		},
		{ debounceMs: 1, pollMs: 10, watch: () => ({ close: () => void closed++ }) },
	);
	try {
		await until(() => runs === 1);
		await watcher.stop();
		assert.equal(finished, true, "stop waits for the in-flight run");
		assert.equal(closed, 1);
		const after = runs;
		watcher.trigger();
		await sleep(60);
		assert.equal(runs, after);
		await watcher.stop(); // idempotent
		assert.equal(closed, 1);
	} finally {
		await done();
	}
});
