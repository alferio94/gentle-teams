import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readdir, readFile, rename, rm, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openStore } from "../lib/store.ts";
import { cleanupTemporary } from "../lib/tmp-cleanup.ts";

test("R3-001 rechecks after isolating a candidate and restores young content", async () => {
	const base = await mkdtemp(join(tmpdir(), "gentle-teams-tmp-"));
	try {
		const store = openStore(base);
		await store.createTeam({ name: "team" });
		const dir = join(base, "teams", "team", "requests");
		const old = join(dir, ".tmp-old");
		await mkdir(old);
		// Run the clock two hours ahead so real ctimes count as old; young writes get mtime `now`.
		const now = Date.now() + 7_200_000;
		await utimes(old, (now - 3_601_000) / 1000, (now - 3_601_000) / 1000);
		await cleanupTemporary(store, "team", () => now, { beforeIsolate: async (path: string) => { await writeFile(join(path, "young"), "live"); await utimes(join(path, "young"), now / 1000, now / 1000); } });
		assert.equal(await readFile(join(old, "young"), "utf8"), "live");
		assert.deepEqual(await readdir(dir), [".tmp-old"]);
	} finally { await rm(base, { recursive: true, force: true }); }
});

test("R3-001 restoration never replaces an occupied original name", async () => {
	const base = await mkdtemp(join(tmpdir(), "gentle-teams-tmp-"));
	try {
		const store = openStore(base);
		await store.createTeam({ name: "team" });
		const dir = join(base, "teams", "team", "requests");
		const old = join(dir, ".tmp-old");
		await mkdir(old);
		const now = Date.now() + 7_200_000;
		await utimes(old, (now - 3_601_000) / 1000, (now - 3_601_000) / 1000);
		await cleanupTemporary(store, "team", () => now, { afterIsolate: async (original, trash) => {
			await mkdir(original);
			await writeFile(join(original, "replacement"), "new");
			await writeFile(join(trash, "young"), "live");
			await utimes(join(trash, "young"), now / 1000, now / 1000);
		} });
		assert.equal(await readFile(join(old, "replacement"), "utf8"), "new");
		const trash = (await readdir(dir)).find((name) => name.startsWith(".trash-"))!;
		assert.equal(await readFile(join(dir, trash, "young"), "utf8"), "live");
	} finally { await rm(base, { recursive: true, force: true }); }
});

test("R1-001 a stored request just hidden under .tmp-* by an older version survives cleanup", async () => {
	const base = await mkdtemp(join(tmpdir(), "gentle-teams-tmp-"));
	try {
		const store = openStore(base);
		await store.createTeam({ name: "team" });
		const dir = join(base, "teams", "team", "requests");
		const request = join(dir, "01M6KWM44BZ855D0C33VQ2ECSR");
		await mkdir(join(request, "events"), { recursive: true });
		await writeFile(join(request, "request.json"), "{}");
		const now = Date.now();
		const old = (now - 7_200_000) / 1000;
		for (const path of [join(request, "request.json"), join(request, "events"), request]) await utimes(path, old, old);
		// The previous version's pruner hides a request with rename(2), which keeps old mtimes.
		const hidden = join(dir, ".tmp-legacy");
		await rename(request, hidden);
		await cleanupTemporary(store, "team", () => now);
		assert.equal(await readFile(join(hidden, "request.json"), "utf8"), "{}");
	} finally { await rm(base, { recursive: true, force: true }); }
});

test("R1-001 an old .tmp-* directory holding a request.json is never removed", async () => {
	const base = await mkdtemp(join(tmpdir(), "gentle-teams-tmp-"));
	try {
		const store = openStore(base);
		await store.createTeam({ name: "team" });
		const dir = join(base, "teams", "team", "requests");
		const hidden = join(dir, ".tmp-stale");
		await mkdir(hidden);
		await writeFile(join(hidden, "request.json"), "{}");
		await writeFile(join(dir, ".tmp-file"), "partial");
		const later = Date.now() + 7_200_000; // every mtime and ctime is now more than an hour old
		await cleanupTemporary(store, "team", () => later);
		assert.deepEqual((await readdir(dir)).sort(), [".tmp-stale"]);
	} finally { await rm(base, { recursive: true, force: true }); }
});

test("R3-001 old trash is cleaned and young trash remains", async () => {
	const base = await mkdtemp(join(tmpdir(), "gentle-teams-tmp-"));
	try {
		const store = openStore(base);
		await store.createTeam({ name: "team" });
		const dir = join(base, "teams", "team", "requests");
		await writeFile(join(dir, ".trash-old"), "old");
		await writeFile(join(dir, ".trash-young"), "young");
		const now = Date.now() + 7_200_000;
		await utimes(join(dir, ".trash-old"), (now - 3_601_000) / 1000, (now - 3_601_000) / 1000);
		await utimes(join(dir, ".trash-young"), now / 1000, now / 1000);
		await cleanupTemporary(store, "team", () => now);
		assert.deepEqual(await readdir(dir), [".trash-young"]);
	} finally { await rm(base, { recursive: true, force: true }); }
});

test("S27 old temporary directories with a young descendant are preserved", async () => {
	const base = await mkdtemp(join(tmpdir(), "gentle-teams-tmp-"));
	try {
		const store = openStore(base);
		await store.createTeam({ name: "team" });
		const old = join(base, "teams", "team", "requests", ".tmp-old");
		const nested = join(old, "dir", "deeper");
		await mkdir(nested, { recursive: true });
		const young = join(nested, "file");
		await writeFile(young, "live");
		const now = Date.now();
		for (const path of [old, join(old, "dir"), nested]) await utimes(path, (now - 3_601_000) / 1000, (now - 3_601_000) / 1000);
		await cleanupTemporary(store, "team", () => now);
		assert.ok(await stat(young));
	} finally { await rm(base, { recursive: true, force: true }); }
});
