/**
 * S15: the first answer wins across processes. Two child Node processes (as two
 * terminals would) answer the same approval at the same instant, 20 rounds: exactly
 * one decision file per approval, one winner, and the loser reads the winner's answer.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { openStore } from "../lib/store.ts";
import { createApproval } from "../lib/approvals.ts";

const WS = "tienda-online";
const ROUNDS = 20;
const approvalsUrl = pathToFileURL(join(import.meta.dirname, "..", "lib", "approvals.ts")).href;
const storeUrl = pathToFileURL(join(import.meta.dirname, "..", "lib", "store.ts")).href;

/** Child: for each round, wait for the go file, answer, and write its result. */
const CHILD = `
const [root, ws, requestId, dir, who, choice, idsJson] = process.argv.slice(1);
const { openStore } = await import(${JSON.stringify(storeUrl)});
const { decideApproval } = await import(${JSON.stringify(approvalsUrl)});
const { existsSync } = await import("node:fs");
const { writeFile } = await import("node:fs/promises");
const store = openStore(root);
const ids = JSON.parse(idsJson);
for (let round = 0; round < ids.length; round++) {
	while (!existsSync(dir + "/go-" + round)) await new Promise((r) => setTimeout(r, 1));
	const result = await decideApproval(store, ws, requestId, ids[round], { choice, decidedBy: who });
	await writeFile(dir + "/result-" + round + "-" + who, JSON.stringify(result));
}
`;

const until = async (predicate: () => Promise<boolean>, ms = 10000) => {
	const end = Date.now() + ms;
	while (!(await predicate())) {
		if (Date.now() > end) throw new Error("condition not reached");
		await new Promise((r) => setTimeout(r, 2));
	}
};

test("S15 multi-process: two processes answering at once leave exactly one decision, 20 rounds", async () => {
	const base = await mkdtemp(join(tmpdir(), "gentle-teams-mp-"));
	// Children wait for go-<round> files; a failed round must not leave them waiting forever.
	const spawned: ReturnType<typeof spawn>[] = [];
	try {
		const root = join(base, "multiagent");
		const sync = join(base, "sync");
		await mkdir(sync);
		const store = openStore(root);
		await store.createTeam({ name: WS });
		await store.joinMember(WS, { alias: "frontend", repositoryRoot: "/repos/front" });
		await store.joinMember(WS, { alias: "backend", repositoryRoot: "/repos/back" });
		const q = await store.createRequest(WS, { from: "frontend", to: "backend", kind: "question", title: "Q", body: "" });
		const ids: string[] = [];
		for (let i = 0; i < ROUNDS; i++) ids.push((await createApproval(store, WS, { requestId: q.id, recipient: "backend", toolName: "bash", input: { command: "x" } })).approvalId);

		const children = [
			["backend", "allow-once"],
			["frontend", "deny"],
		].map(([who, choice]) => {
			const child = spawn(process.execPath, ["--input-type=module", "-e", CHILD, root, WS, q.id, sync, who!, choice!, JSON.stringify(ids)], {
				stdio: ["ignore", "ignore", "pipe"],
			});
			spawned.push(child);
			let stderr = "";
			child.stderr.on("data", (chunk) => (stderr += chunk));
			const exited = new Promise<void>((resolve, reject) =>
				child.on("exit", (code) => (code === 0 ? resolve() : reject(new Error(`child ${who} exited ${code}: ${stderr}`)))),
			);
			return exited;
		});

		// Still awaited below; this only avoids an unhandled rejection when a round fails first.
		for (const exited of children) exited.catch(() => undefined);
		const winners: Record<string, number> = { backend: 0, frontend: 0 };
		for (let round = 0; round < ROUNDS; round++) {
			await writeFile(join(sync, `go-${round}`), "");
			const files = [join(sync, `result-${round}-backend`), join(sync, `result-${round}-frontend`)];
			await until(async () => (await readdir(sync)).filter((n) => n.startsWith(`result-${round}-`)).length === 2);
			const results = await Promise.all(files.map(async (f) => JSON.parse(await readFile(f, "utf8"))));
			assert.equal(results.filter((r) => r.won).length, 1, `round ${round}: exactly one winner`);
			const winner = results.find((r) => r.won).decision;
			for (const r of results) assert.deepEqual(r.decision, winner, `round ${round}: both see the winning decision`);
			const dir = join(root, "teams", WS, "requests", q.id, "approvals", ids[round]!);
			// readdir order is file-system specific (sorted on APFS, hash order on ext4).
			assert.deepEqual((await readdir(dir)).sort(), ["decision.json", "request.json"], `round ${round}: one decision file, no temporary files`);
			assert.deepEqual(JSON.parse(await readFile(join(dir, "decision.json"), "utf8")), winner);
			winners[winner.decidedBy]!++;
		}
		await Promise.all(children);
		assert.equal(winners.backend! + winners.frontend!, ROUNDS);
	} finally {
		for (const child of spawned) if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
		await rm(base, { recursive: true, force: true });
	}
});
