/**
 * S20 / D1 multi-process: one pruner, one live peer session, creators that make new
 * open requests depending on old closed ones, and readers, each in its own process,
 * for a bounded time. Afterwards: no redelivery to the peer, no open request removed,
 * no dangling dependency, no `.tmp-*` left, and no partial read.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { openStore, type Store } from "../lib/store.ts";
import { readCursor, writeCursor } from "../lib/delivery.ts";

const WS = "tienda-online";
const RUN_MS = 1500;
const OLD = 80;
const lib = (name: string) => pathToFileURL(join(import.meta.dirname, "..", "lib", name)).href;

const CHILD = `
const [role, root, ws, out, runMs, oldJson] = process.argv.slice(1);
const { openStore } = await import(${JSON.stringify(lib("store.ts"))});
const { removeRequests } = await import(${JSON.stringify(lib("prune.ts"))});
const { listDeliverableRequests } = await import(${JSON.stringify(lib("delivery.ts"))});
const { createTeamSession } = await import(${JSON.stringify(lib("session.ts"))});
const { writeFile } = await import("node:fs/promises");
const store = openStore(root);
const old = JSON.parse(oldJson); // id -> expected event count
const ids = Object.keys(old);
const end = Date.now() + Number(runMs);
// Reserve one old request for the pruner; creators cannot protect it with a dependency.
const pick = () => ids[1 + Math.floor(Math.random() * (ids.length - 1))];
const tick = () => new Promise((r) => setImmediate(r));
const result = { removed: [], created: [], refused: 0, partial: [], sent: [], errors: [] };
const DAY = 24 * 60 * 60 * 1000;
try {
	if (role === "pruner") {
		let first = true;
		while (Date.now() < end) {
			const batch = [first ? ids[0] : pick(), pick(), pick()];
			first = false;
			result.removed.push(...(await removeRequests(store, ws, batch, { days: 7, now: () => Date.now() + 8 * DAY, canWriteCursor: async (a) => a === "admin" })));
			await tick();
		}
	} else if (role === "creator") {
		while (Date.now() < end) {
			try {
				const r = await store.createRequest(ws, { from: "admin", to: "frontend", kind: "question", title: "new", body: "", dependsOn: [pick()] });
				result.created.push(r.id);
			} catch (error) {
				if (error.code !== "unknown-dependency") throw error;
				result.refused++;
			}
			await new Promise((r) => setTimeout(r, 2));
		}
	} else if (role === "reader") {
		while (Date.now() < end) {
			for (const view of [...(await store.listRequests(ws)), ...(await listDeliverableRequests(store, ws, (id) => result.partial.push("unreadable " + id)))]) {
				const want = old[view.record.id];
				if (want !== undefined && (view.events.length !== want || view.state !== "completed")) result.partial.push(view.record.id + " " + view.state + ":" + view.events.length);
			}
			await tick();
		}
	} else if (role === "peer") {
		const timers = [];
		const session = createTeamSession({
			store,
			sessionId: "peer",
			pid: process.pid,
			sendMessage: (m) => void result.sent.push([m.details.requestId, m.details.delivery, m.details.transition, m.details.advanceTo]),
			ui: { select: async () => undefined, notify: (msg, level) => level === "error" && result.errors.push(msg), setStatus: () => undefined },
			resolveGitRoot: async () => undefined,
			// Passes as often as possible, so many of them overlap the pruner's hidden windows.
			watch: (_dir, onChange) => {
				const h = setInterval(() => void onChange(), 1);
				return { stop: () => clearInterval(h) };
			},
		});
		await session.bindTo(ws, "frontend");
		while (Date.now() < end) await new Promise((r) => setTimeout(r, 20));
		await session.shutdown();
	}
} catch (error) {
	result.errors.push(String(error && error.stack || error));
}
await writeFile(out, JSON.stringify(result));
process.exit(0);
`;

/** A request admin → frontend, finished by frontend and fully received by both. */
async function oldFinished(store: Store, kind: "question" | "change"): Promise<[string, number]> {
	const r = await store.createRequest(WS, { from: "admin", to: "frontend", kind, title: "old", body: "" });
	const steps = kind === "question" ? (["complete"] as const) : (["accept", "start", "complete"] as const);
	for (const transition of steps) await store.appendEvent(WS, r.id, { actor: "frontend", transition });
	for (const [alias, seen] of [["frontend", 1], ["admin", steps.length + 1]] as const) {
		const cursor = await readCursor(store, WS, alias);
		await writeCursor(store, WS, alias, { version: 1, seen: { ...cursor.seen, [r.id]: seen } });
	}
	return [r.id, steps.length];
}

test("S20/D1 multi-process: pruning races creators, readers, and a live peer without redelivery or loss", { timeout: 30_000 }, async () => {
	const base = await mkdtemp(join(tmpdir(), "gentle-teams-prune-mp-"));
	try {
		const root = join(base, "multiagent");
		const outDir = join(base, "out");
		await mkdir(outDir);
		const store = openStore(root);
		await store.createTeam({ name: WS });
		await store.joinMember(WS, { alias: "frontend", repositoryRoot: "/repos/front" });
		await store.joinMember(WS, { alias: "admin", repositoryRoot: "/repos/admin" });
		const old: Record<string, number> = {};
		for (let i = 0; i < OLD; i++) {
			const [id, count] = await oldFinished(store, i % 2 === 0 ? "change" : "question");
			old[id] = count;
		}

		const roles = ["peer", "pruner", "creator", "creator", "reader", "reader"];
		const started = Date.now();
		const results = await Promise.all(
			roles.map(async (role, index) => {
				const out = join(outDir, `${role}-${index}.json`);
				await new Promise<void>((resolve, reject) => {
					const child = spawn(process.execPath, ["--input-type=module", "-e", CHILD, role, root, WS, out, String(RUN_MS), JSON.stringify(old)], {
						stdio: ["ignore", "ignore", "pipe"],
					});
					let stderr = "";
					child.stderr.on("data", (chunk) => (stderr += chunk));
					const kill = setTimeout(() => child.kill("SIGKILL"), RUN_MS + 15_000);
					child.on("exit", (code) => {
						clearTimeout(kill);
						if (code === 0) resolve();
						else reject(new Error(`${role} exited ${code}: ${stderr}`));
					});
				});
				return { role, ...JSON.parse(await readFile(out, "utf8")) };
			}),
		);
		assert.ok(Date.now() - started < RUN_MS + 15_000, "bounded run time");
		for (const r of results) assert.deepEqual(r.errors, [], `${r.role} errors`);

		const peer = results.find((r) => r.role === "peer")!;
		const keys = peer.sent.map((s: unknown[]) => JSON.stringify(s));
		assert.equal(new Set(keys).size, keys.length, "0 redeliveries");
		assert.deepEqual(peer.sent.filter((s: string[]) => s[0]! in old), [], "nothing about an old, fully received request reaches the peer's model");

		const removed = new Set(results.flatMap((r) => r.removed));
		const created: string[] = results.flatMap((r) => r.created);
		assert.ok(removed.size > 0, "the pruner removed something");
		assert.ok(created.length > 0, "creators created dependents");
		const left = await readdir(join(root, "teams", WS, "requests"));
		assert.deepEqual(left.filter((n) => n.startsWith(".")), [], "0 .tmp-* left");
		for (const id of created) assert.ok(left.includes(id), `open request ${id} was removed`);
		for (const view of await store.listRequests(WS)) {
			for (const dep of view.record.dependsOn) assert.ok(left.includes(dep), `dangling dependency ${dep} of ${view.record.id}`);
		}
		for (const id of removed) assert.equal(left.includes(id), false);
		assert.deepEqual(results.flatMap((r) => r.partial), [], "0 partial reads");
		// The peer's cursor still covers every old request that was kept.
		const cursor = await readCursor(store, WS, "frontend");
		for (const id of Object.keys(old)) if (left.includes(id)) assert.equal(cursor.seen[id], 1, `cursor entry of ${id}`);
		await writeFile(join(outDir, "done"), "");
	} finally {
		await rm(base, { recursive: true, force: true });
	}
});
