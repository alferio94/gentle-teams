import { isTerminal, type RequestState } from "./lifecycle.ts";
import type { PresenceState } from "./presence.ts";
import { oneLine } from "./delivery.ts";
import { plainLine, truncateToWidth } from "./ui/text.ts";

export const TEAM_STATUS_KEYS = ["gentle-teams.1", "gentle-teams.2", "gentle-teams.3"] as const;

export interface TeamStatusInput {
	team: string;
	self: string;
	members: readonly { alias: string; state: PresenceState | "offline" }[];
	pendingApprovals: number;
	requests: readonly { title: string; state: RequestState; lastActivity: string }[];
}

/** Format the three ordered Integrations entries without reading the store. */
export function formatTeamStatus(input: TeamStatusInput): [string, string | undefined][] {
	const glyph = { active: "●", idle: "◐", offline: "○" } as const;
	const members = [...input.members].sort((a, b) => a.alias.localeCompare(b.alias))
		.map((member) => `${glyph[member.state]} ${member.alias}`).join("  ");
	const latest = input.requests.filter((request) => !isTerminal(request.state))
		.sort((a, b) => b.lastActivity.localeCompare(a.lastActivity))[0];
	const detail = input.pendingApprovals > 0
		? `⚠ ${input.pendingApprovals} approval${input.pendingApprovals === 1 ? "" : "s"} waiting`
		: latest ? `▸ ${truncateToWidth(plainLine(oneLine(latest.title)), 48)} · ${latest.state}` : undefined;
	return [[TEAM_STATUS_KEYS[0], `teams: ${input.team} · ★ ${input.self}`], [TEAM_STATUS_KEYS[1], members], [TEAM_STATUS_KEYS[2], detail]];
}
