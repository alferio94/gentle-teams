import type { RequestState } from "./lifecycle.ts";
import type { PresenceState } from "./presence.ts";
import { oneLine } from "./delivery.ts";
import { plainLine, truncateToWidth } from "./ui/text.ts";

export const TEAM_STATUS_KEYS = ["gentle-teams.1", "gentle-teams.2", "gentle-teams.3"] as const;
export type StatusColor = "success" | "warning" | "muted" | "accent" | "error" | "dim" | "text";
export interface StatusTheme { fg(role: StatusColor, text: string): string }
/** Marks the name of the team this session belongs to (S34). */
export const TEAM_MARK = "👥";
export const memberGlyph = { active: "●", idle: "◐", offline: "○" } as const;
export const memberColor = { active: "success", idle: "warning", offline: "muted" } as const;
export const requestColor: Record<RequestState, StatusColor> = { requested: "muted", accepted: "accent", in_progress: "accent", needs_decision: "warning", completed: "success", failed: "error", declined: "error", cancelled: "dim" };
export interface TeamStatusInput {
 team: string; self: string;
 members: readonly { alias: string; state: PresenceState | "offline" }[];
 pendingApprovals: number;
 requests: readonly { title: string; state: RequestState; lastActivity: string }[];
}
export interface TeamSnapshot {
 team: string; self: string;
 members: TeamStatusInput["members"];
 pendingApprovals: number;
 recentRequests: readonly { title: string; state: RequestState; direction: "sent" | "received" }[];
}
export function formatTeamStatus(input: TeamStatusInput, theme?: StatusTheme): [string, string | undefined][] {
 const color = (role: StatusColor, text: string) => theme ? theme.fg(role, text) : text;
 const members = [...input.members].sort((a,b) => a.alias.localeCompare(b.alias)).map(m => color(memberColor[m.state], `${memberGlyph[m.state]} ${m.alias}`)).join("  ");
 const requests = [...input.requests].sort((a,b) => b.lastActivity.localeCompare(a.lastActivity)).slice(0,2);
 const details = [input.pendingApprovals > 0 ? color("warning", `⚠ ${input.pendingApprovals} approval${input.pendingApprovals === 1 ? "" : "s"} waiting`) : "", ...requests.map(r => `▸ ${truncateToWidth(plainLine(oneLine(r.title)), 48)} · ${color(requestColor[r.state], r.state)}`)].filter(Boolean).join("  ");
 return [[TEAM_STATUS_KEYS[0], `teams: ${color("accent", `${TEAM_MARK} ${input.team}`)} · ★ ${input.self}`], [TEAM_STATUS_KEYS[1], members], [TEAM_STATUS_KEYS[2], details || undefined]];
}
