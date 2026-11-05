import { test } from "node:test";
import assert from "node:assert/strict";
import { formatTeamStatus } from "../lib/team-status.ts";
import { stripAnsi } from "../lib/ui/text.ts";

const base = { team: "tienda-online", self: "backend", members: [
 { alias: "frontend", state: "active" as const }, { alias: "admin", state: "offline" as const }, { alias: "backend", state: "idle" as const },
], pendingApprovals: 0, requests: [] };
test("S23 identity and sorted presence remain unchanged", () => {
 assert.deepEqual(formatTeamStatus(base), [["gentle-teams.1", "teams: 👥 tienda-online · ★ backend"], ["gentle-teams.2", "○ admin  ◐ backend  ● frontend"], ["gentle-teams.3", undefined]]);
});
test("S32 two latest requests include closed and sanitize peer text, alongside approvals", () => {
 const requests = [
  { title: "Old", state: "accepted" as const, lastActivity: "2026-01-01" },
  { title: "Done", state: "completed" as const, lastActivity: "2026-01-03" },
  { title: "Fix\n\u202eboom", state: "in_progress" as const, lastActivity: "2026-01-02" },
 ];
 assert.equal(formatTeamStatus({ ...base, requests, pendingApprovals: 2 })[2][1], "⚠ 2 approvals waiting  ▸ Done · completed  ▸ Fix boom · in_progress");
});
test("S32 footer colors preserve plain text and use state roles", () => {
 const theme = { fg: (role: string, text: string) => `\x1b[${({success:32,warning:33,muted:90,accent:36} as Record<string,number>)[role] ?? 31}m${text}\x1b[0m` };
 const input = { ...base, requests: [{ title: "Work", state: "completed" as const, lastActivity: "2026-01-01" }] };
 const plain = formatTeamStatus(input); const colored = formatTeamStatus(input, theme);
 assert.deepEqual(colored.map(([k,v]) => [k, v === undefined ? undefined : stripAnsi(v)]), plain);
 assert.match(colored[1]![1]!, /\x1b\[32m● frontend/);
 assert.match(colored[1]![1]!, /\x1b\[33m◐ backend/);
 assert.match(colored[2]![1]!, /\x1b\[32mcompleted/);
});
