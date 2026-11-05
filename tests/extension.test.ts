import { test } from "node:test";
import assert from "node:assert/strict";
import { isChildSession, createTeamsExtension } from "../extensions/teams.ts";
import { mkdtemp, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openStore } from "../lib/store.ts";
import { gitRoot } from "../lib/session.ts";

test("S35a child marker is exactly 1", () => {
 const before = process.env.GENTLE_PI_AGENTS_CHILD;
 try {
  delete process.env.GENTLE_PI_AGENTS_CHILD; assert.equal(isChildSession(), false);
  process.env.GENTLE_PI_AGENTS_CHILD = "0"; assert.equal(isChildSession(), false);
  process.env.GENTLE_PI_AGENTS_CHILD = "1"; assert.equal(isChildSession(), true);
 } finally { if (before === undefined) delete process.env.GENTLE_PI_AGENTS_CHILD; else process.env.GENTLE_PI_AGENTS_CHILD = before; }
});

test("S35a child startup suppresses a real membership prompt, unlike a normal session", async () => {
 const before = process.env.GENTLE_PI_AGENTS_CHILD;
 const base = await mkdtemp(join(tmpdir(), "teams-extension-child-"));
 const root = join(base, "store");
 const repository = await gitRoot(process.cwd());
 assert.ok(repository);
 const store = openStore(root);
 const handlers: Record<string, Function> = {};
 const calls: string[] = [];
 const pi = { registerTool() {}, registerCommand() {}, on: (name: string, fn: Function) => { handlers[name] = fn; }, sendMessage() {} };
 const ctx = { cwd: repository, hasUI: true, mode: "rpc", sessionManager: { getSessionId: () => "child-test", getEntries: () => [] }, ui: {
  select: async (title: string) => { calls.push(`select:${title}`); return "Do not bind"; },
  notify: () => calls.push("notify"), setStatus: () => calls.push("status")
 } };
 try {
  await store.createTeam({ name: "child-test" });
  await store.joinMember("child-test", { alias: "member", repositoryRoot: repository });
  createTeamsExtension({ root })(pi as never);
  process.env.GENTLE_PI_AGENTS_CHILD = "1";
  await handlers.session_start!({ reason: "startup" }, ctx);
  assert.equal(calls.length, 0);
  assert.equal(existsSync(join(root, "teams", "child-test", "presence", "member.json")), false);
  delete process.env.GENTLE_PI_AGENTS_CHILD;
  await handlers.session_start!({ reason: "startup" }, ctx);
  const deadline = Date.now() + 2000;
  while (!calls.some((c) => c.startsWith("select:")) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 5));
  assert.deepEqual(calls, ["select:This repository is a member of a team. Bind this session to it?"]);
  assert.equal(existsSync(join(root, "teams", "child-test", "presence", "member.json")), false);
  await handlers.session_shutdown!();
 } finally {
  if (before === undefined) delete process.env.GENTLE_PI_AGENTS_CHILD; else process.env.GENTLE_PI_AGENTS_CHILD = before;
  await rm(base, { recursive: true, force: true });
 }
});

test("S35a child startup registers tools but performs no UI or session work", async () => {
 const before = process.env.GENTLE_PI_AGENTS_CHILD;
 try {
  process.env.GENTLE_PI_AGENTS_CHILD = "1";
  const handlers: Record<string, Function> = {}; const tools: any[] = []; const calls: string[] = [];
  const pi = { registerTool: (t: any) => tools.push(t), registerCommand() {}, on: (name: string, fn: Function) => { handlers[name] = fn; }, sendMessage: () => calls.push("send") };
  createTeamsExtension({ root: "/nonexistent-child-test" })(pi as never);
  const ctx = { cwd: "/", hasUI: true, mode: "tui", sessionManager: { getSessionId: () => "child", getEntries: () => [] }, ui: { select: () => { calls.push("select"); }, custom: () => { calls.push("custom"); }, notify: () => calls.push("notify"), setStatus: () => calls.push("status") } };
  await handlers.session_start!({ reason: "startup" }, ctx);
  assert.equal(tools.length, 4); assert.deepEqual(calls, []);
  const result = await tools.find(t => t.name === "multiagent_status").execute("id", {}, undefined, undefined, ctx);
  assert.equal(result.details.error.code, "not-bound");
 } finally { if (before === undefined) delete process.env.GENTLE_PI_AGENTS_CHILD; else process.env.GENTLE_PI_AGENTS_CHILD = before; }
});
