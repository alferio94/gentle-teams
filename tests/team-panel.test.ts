import { test } from "node:test";
import assert from "node:assert/strict";
import { visibleWidth } from "@earendil-works/pi-tui";
import { stripAnsi } from "../lib/ui/text.ts";
import { renderTeamPanel } from "../lib/ui/team-panel.ts";
const theme = { fg: (role: string, value: string) => `\x1b[${({success:32,warning:33,muted:90,accent:36,error:31,dim:90,text:37} as Record<string,number>)[role]}m${value}\x1b[0m` };
const snapshot = {team: "alpha", self: "me", members: [{alias:"me",state:"idle" as const},{alias:"other",state:"active" as const},{alias:"off",state:"offline" as const}], pendingApprovals: 1, recentRequests: [{title:"Hello\n\u202e界",state:"completed" as const,direction:"sent" as const},{title:"Oops",state:"failed" as const,direction:"received" as const}]};
test("S31/S32 panel shows all rows, colors and neutralized peer text within width", () => {
 const lines = renderTeamPanel(snapshot, theme, 28);
 assert.deepEqual(lines.map(stripAnsi), ["▾ TEAMS             👥 alpha", "  ◐ me ★", "  ● other", "  ○ off", "  ⚠ 1 approval waiting", "  ▸ Hello 界 · completed", "  ▸ Oops · failed"]);
 assert.match(lines[0]!, /\x1b\[36m👥 alpha\x1b\[0m$/);
 assert.match(lines[1]!, /\x1b\[33m◐ me\x1b\[0m \x1b\[36m★/); assert.match(lines[2]!, /\x1b\[32m/); assert.match(lines[6]!, /\x1b\[31m/);
 for (let width=0;width<40;width++) for (const line of renderTeamPanel(snapshot, theme, width)) assert.ok(visibleWidth(line)<=width);
});
test("S32 long request title is truncated before its colored state", () => {
 const value = {...snapshot, recentRequests: [{title: "Long title ".repeat(20), state:"completed" as const, direction:"sent" as const}]};
 const row = stripAnsi(renderTeamPanel(value, theme, 28).at(-1)!);
 assert.match(row, /… · completed$/);
});
