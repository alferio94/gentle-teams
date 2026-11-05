import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { oneLine } from "../delivery.ts";
import { memberColor, memberGlyph, requestColor, TEAM_MARK, type StatusTheme, type TeamSnapshot } from "../team-status.ts";
import { plainLine } from "./text.ts";

/** Render only from the last session snapshot; no storage access on the render path. */
export function renderTeamPanel(snapshot: TeamSnapshot, theme: StatusTheme, width: number): string[] {
 const w = Math.max(0, Math.floor(width));
 const left = theme.fg("muted", "▾") + " " + theme.fg("text", "TEAMS");
 const team = theme.fg("accent", `${TEAM_MARK} ${plainLine(snapshot.team)}`);
 const right = visibleWidth(team) + 1 <= w ? team : "";
 const title = truncateToWidth(left, Math.max(0, w - visibleWidth(right) - (right ? 1 : 0)));
 const header = title + " ".repeat(Math.max(0, w - visibleWidth(title) - visibleWidth(right))) + right;
 const rows = [header,
  ...snapshot.members.map(m => `  ${theme.fg(memberColor[m.state], `${memberGlyph[m.state]} ${plainLine(m.alias)}`)}${m.alias === snapshot.self ? ` ${theme.fg("accent", "★")}` : ""}`),
  ...(snapshot.pendingApprovals > 0 ? [`  ${theme.fg("warning", `⚠ ${snapshot.pendingApprovals} approval${snapshot.pendingApprovals === 1 ? "" : "s"} waiting`)}`] : []),
  ...snapshot.recentRequests.slice(0,2).map(r => {
   const prefix = "  ▸ "; const suffix = ` · ${theme.fg(requestColor[r.state], r.state)}`;
   const room = w - visibleWidth(prefix) - visibleWidth(suffix);
   return room > 0 ? `${prefix}${truncateToWidth(plainLine(oneLine(r.title)), room, "…")}${suffix}` : `${prefix}${plainLine(oneLine(r.title))}${suffix}`;
  }),
 ];
 return rows.map(row => truncateToWidth(row, w));
}
