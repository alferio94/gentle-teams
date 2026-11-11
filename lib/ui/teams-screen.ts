/**
 * /teams screen state, rendering, and key handling (feature spec S13-S14,
 * docs/architecture.md §7). Pure: no Pi runtime imports, no I/O.
 *
 * The command (lib/teams-command.ts) loads a ScreenData snapshot, opens the
 * screen, and gets back one ScreenAction; dialogs and store writes happen outside the
 * screen, which then reopens at the same place (ScreenPlace) with feedback.
 * Every rendered line is cut to the given width; every piece of stored text is shown
 * on one line without control characters. Given the terminal height (S19), the
 * screen fills it: blank lines pad the content, the footer is the last line, and a
 * list that does not fit scrolls around its selection.
 */

import { oneLine } from "../delivery.ts";
import { padEnd, plainLine, truncateToWidth, visibleWidth } from "./text.ts";

export type MemberState = "active" | "idle" | "offline";

export interface ScreenTheme {
	fg(color: string, text: string): string;
	bold(text: string): string;
}

export interface EventRow {
	seq: number;
	actor: string;
	role: string;
	transition: string;
	summary?: string;
	at: string;
}

export interface RequestRow {
	id: string;
	kind: string;
	from: string;
	to: string;
	title: string;
	state: string;
	events: EventRow[];
	/** A change still `requested` that this session's bound member may decide. */
	decidable: boolean;
	/** S18: the bound member sent it; deciding appends the event as this recipient. */
	onBehalfOf?: string;
}

export interface MemberRow {
	alias: string;
	repositoryRoot: string;
	state: MemberState;
	/** Open requests this member received, e.g. "1 waiting" or "—". */
	requests: string;
}

export interface TeamTab {
	name: string;
	description: string;
	/** This session is bound to a member of this team. */
	bound: boolean;
	/** Another member than this session's is live. */
	live: boolean;
	members: MemberRow[];
	requests: RequestRow[];
}

export interface ThisSession {
	/** Git root of the session's cwd; undefined outside a Git repository. */
	gitRoot?: string;
	binding?: { team: string; alias: string };
}

export type ScreenView = "members" | "requests" | "history";

export interface Feedback {
	text: string;
	level: "info" | "warning" | "error";
}

export interface ScreenState {
	tabs: TeamTab[];
	thisSession: ThisSession;
	/** Home directory, shown as `~`. */
	home?: string;
	tab: number;
	member: number;
	view: ScreenView;
	request: number;
	/** Selected event in the history view (D2); 0 when absent. */
	event?: number;
	feedback?: Feedback;
}

export interface ScreenData {
	tabs: TeamTab[];
	thisSession: ThisSession;
	home?: string;
}

/** Where the previous screen was, so a reopened screen keeps its place. */
export interface ScreenPlace {
	team?: string;
	member?: string;
	view?: ScreenView;
	requestId?: string;
	feedback?: Feedback;
}

export type ScreenAction =
	| { type: "close" }
	| { type: "new" }
	| { type: "join"; team: string }
	| { type: "leave"; team: string; alias: string }
	| { type: "decide"; team: string; requestId: string; choice: "Accept" | "Decline" }
	| { type: "prune"; team: string }
	| { type: "archive"; team: string };

export type KeyName = "left" | "right" | "up" | "down" | "enter" | "escape" | string;

/** Fits 80 columns with its leading space (D3). */
export const FOOTER = "←→ team ↑↓ member  j join l leave r requests p prune x archive n new esc close";

const REQUESTS_FOOTER = "↑↓ request  enter history";
const DECIDE_KEYS = "a accept  d decline";
const TITLE_MAX = 40;

/** Store text on one line, fences neutralized, no control characters (S9, S13). */
const show = (text: string): string => plainLine(oneLine(text));

const clamp = (value: number, length: number): number => Math.max(0, Math.min(value, length - 1));

/** This session's row in a team: bound member, else this repository's member. */
function ownMemberIndex(tab: TeamTab | undefined, session: ThisSession): number {
	if (!tab) return -1;
	if (session.binding?.team === tab.name) {
		const bound = tab.members.findIndex((m) => m.alias === session.binding!.alias);
		if (bound >= 0) return bound;
	}
	return session.gitRoot === undefined ? -1 : tab.members.findIndex((m) => m.repositoryRoot === session.gitRoot);
}

const defaultMember = (tab: TeamTab | undefined, session: ThisSession): number => Math.max(0, ownMemberIndex(tab, session));

export function screenState(data: ScreenData, place: ScreenPlace = {}): ScreenState {
	const { tabs, thisSession } = data;
	let tab = tabs.findIndex((t) => t.name === place.team);
	if (tab < 0) tab = tabs.findIndex((t) => t.name === thisSession.binding?.team);
	if (tab < 0) tab = 0;
	const current = tabs[tab];
	const placed = current ? current.members.findIndex((m) => m.alias === place.member) : -1;
	const member = placed >= 0 ? placed : defaultMember(current, thisSession);
	const requests = current?.requests ?? [];
	const found = requests.findIndex((r) => r.id === place.requestId);
	let view: ScreenView = current ? (place.view ?? "members") : "members";
	if (view === "history" && found < 0) view = "requests";
	return {
		tabs,
		thisSession,
		...(data.home !== undefined ? { home: data.home } : {}),
		tab,
		member,
		view,
		request: Math.max(0, found),
		...(place.feedback ? { feedback: place.feedback } : {}),
	};
}

export function placeOf(state: ScreenState): ScreenPlace {
	const tab = state.tabs[state.tab];
	const place: ScreenPlace = {};
	if (tab) {
		place.team = tab.name;
		const member = tab.members[state.member];
		if (member) place.member = member.alias;
		const request = tab.requests[state.request];
		if (request) place.requestId = request.id;
	}
	place.view = state.view;
	return place;
}

function tilde(path: string, home: string | undefined): string {
	if (home && (path === home || path.startsWith(home.endsWith("/") ? home : `${home}/`))) return `~${path.slice(home.replace(/\/$/, "").length)}`;
	return path;
}

function tabsLine(state: ScreenState, theme: ScreenTheme): string {
	const parts = state.tabs.map((tab, index) => {
		const marker = tab.bound ? " ★" : tab.live ? " ⊙" : "";
		const selected = index === state.tab;
		const label = `${tab.name}${marker}${selected ? " ▾" : ""}`;
		return selected ? theme.bold(theme.fg("accent", label)) : label;
	});
	parts.push(theme.fg("muted", "+ New"));
	return ` ${parts.join("    ")}`;
}

function feedbackLine(state: ScreenState, theme: ScreenTheme): string[] {
	if (!state.feedback) return [];
	const color = state.feedback.level === "error" ? "error" : state.feedback.level === "warning" ? "warning" : "success";
	return [` ${theme.fg(color, show(state.feedback.text))}`];
}

/** A view: fixed lines around one list that may scroll, and the footer (last line). */
interface Layout {
	top: string[];
	list: string[];
	/** Index in `list` to keep visible; -1 shows the list from its start. */
	selected: number;
	bottom: string[];
	footer: string;
	/** D4: lines dropped, in this order, when the list would get no row at all. */
	droppable?: ["top" | "bottom", number][];
}

function membersView(state: ScreenState, tab: TeamTab, width: number, theme: ScreenTheme): Layout {
	const repo = (path: string) => show(tilde(path, state.home));
	const aliasWidth = Math.max(0, ...tab.members.map((m) => m.alias.length));
	const memberCol = Math.max("Member".length, aliasWidth) + 4;
	const repoCol = Math.max("Repository".length, ...tab.members.map((m) => visibleWidth(repo(m.repositoryRoot)))) + 4;
	const stateCol = 10;

	// "This session" row.
	const own = tab.members[ownMemberIndex(tab, state.thisSession)];
	const ownCol = Math.max(aliasWidth, 1) + 3;
	let session: string;
	if (own) {
		const bound = state.thisSession.binding?.team === tab.name && state.thisSession.binding.alias === own.alias;
		session = `${padEnd(show(own.alias), ownCol)}${repo(own.repositoryRoot)}   ${bound ? own.state : "not bound"}`;
	} else if (state.thisSession.gitRoot !== undefined) {
		session = `${padEnd("—", ownCol)}${repo(state.thisSession.gitRoot)}   not a member`;
	} else {
		session = `${padEnd("—", ownCol)}not in a Git repository`;
	}

	const top = [
		` ${theme.bold(show(tab.name))}${tab.description ? `   ${theme.fg("muted", show(tab.description))}` : ""}`,
		"",
		theme.fg("accent", ` ▸ This session   ${session}`),
		" " + theme.fg("borderMuted", "─".repeat(Math.max(0, width - 2))),
	];
	const list: string[] = [];
	if (tab.members.length === 0) {
		list.push("  No members yet. Press j to join with this repository.");
	} else {
		top.push(theme.fg("muted", `  ${padEnd("Member", memberCol)}${padEnd("Repository", repoCol)}${padEnd("State", stateCol)}Requests`));
		tab.members.forEach((m, index) => {
			const stateText = m.state === "offline" ? theme.fg("dim", m.state) : m.state === "active" ? theme.fg("success", m.state) : m.state;
			const row = `${padEnd(show(m.alias), memberCol)}${padEnd(repo(m.repositoryRoot), repoCol)}${padEnd(stateText, stateCol)}${show(m.requests)}`;
			list.push(index === state.member ? `${theme.fg("accent", "›")} ${row}` : `  ${row}`);
		});
	}
	return {
		top,
		list,
		selected: tab.members.length === 0 ? -1 : state.member,
		bottom: ["", ` ${theme.fg("accent", "[ Join ]  [ Leave ]  [ Requests ]")}`],
		footer: ` ${theme.fg("dim", FOOTER)}`,
		// Blank lines first, then the description line, then the rule.
		droppable: [
			["bottom", 0],
			["top", 1],
			["top", 0],
			["top", 3],
		],
	};
}

const shortId = (id: string): string => id.slice(-6);

/** The decision marker of a request row: awaiting this member, or decidable on the recipient's behalf (S18). */
const decisionMark = (r: RequestRow, theme: ScreenTheme): string => {
	if (!r.decidable) return "";
	return theme.fg("warning", r.onBehalfOf !== undefined ? ` · awaiting ${show(r.onBehalfOf)}, a/d on its behalf` : " · awaiting your decision");
};

function requestsView(state: ScreenState, tab: TeamTab, theme: ScreenTheme): Layout {
	const top = [` ${theme.bold(show(tab.name))} · Requests`, ""];
	const rows = tab.requests;
	if (rows.length === 0) {
		return { top: [...top, "  No requests in this team."], list: [], selected: -1, bottom: [""], footer: ` ${theme.fg("dim", "esc back")}` };
	}
	const route = (r: RequestRow) => `${show(r.from)} → ${show(r.to)}`;
	const title = (r: RequestRow) => truncateToWidth(show(r.title), TITLE_MAX);
	const routeCol = Math.max("From → To".length, ...rows.map((r) => visibleWidth(route(r)))) + 4;
	const titleCol = Math.max("Title".length, ...rows.map((r) => visibleWidth(title(r)))) + 4;
	top.push(theme.fg("muted", `  ${padEnd("Id", 8)}${padEnd("Kind", 10)}${padEnd("From → To", routeCol)}${padEnd("Title", titleCol)}State`));
	const list = rows.map((r, index) => {
		const row = `${padEnd(shortId(r.id), 8)}${padEnd(show(r.kind), 10)}${padEnd(route(r), routeCol)}${padEnd(title(r), titleCol)}${show(r.state)}${decisionMark(r, theme)}`;
		return index === state.request ? `${theme.fg("accent", "›")} ${row}` : `  ${row}`;
	});
	const selected = rows[state.request];
	return {
		top,
		list,
		selected: state.request,
		bottom: [""],
		footer: ` ${theme.fg("dim", `${REQUESTS_FOOTER}  ${selected?.decidable ? `${DECIDE_KEYS}  ` : ""}esc back`)}`,
	};
}

function historyView(state: ScreenState, tab: TeamTab, theme: ScreenTheme): Layout {
	const r = tab.requests[state.request];
	if (!r) return requestsView(state, tab, theme);
	const top = [
		` ${theme.bold(`Request ${show(r.id)}`)}`,
		` ${show(r.kind)}  ${show(r.from)} → ${show(r.to)}  ${show(r.state)}${decisionMark(r, theme)}`,
		` Title: ${show(r.title)}`,
		"",
	];
	const list: string[] = [];
	const selected = clamp(state.event ?? 0, r.events.length);
	if (r.events.length === 0) {
		list.push("  No events yet.");
	} else {
		const who = (e: EventRow) => `${show(e.actor)} (${show(e.role)})`;
		const whoCol = Math.max(...r.events.map((e) => visibleWidth(who(e)))) + 2;
		r.events.forEach((e, index) => {
			const summary = e.summary ? `  ${show(e.summary)}` : "";
			const row = `#${e.seq}  ${padEnd(show(e.transition), 12)}${padEnd(who(e), whoCol)}${show(e.at)}${summary}`;
			list.push(index === selected ? `${theme.fg("accent", "›")} ${row}` : `  ${row}`);
		});
	}
	const keys = `${r.events.length > 0 ? "↑↓ event  " : ""}${r.decidable ? `${DECIDE_KEYS}  ` : ""}esc back`;
	return { top, list, selected: r.events.length === 0 ? -1 : selected, bottom: [""], footer: ` ${theme.fg("dim", keys)}` };
}

function emptyView(theme: ScreenTheme): Layout {
	return {
		top: [" No teams yet.", " A team lets sessions in different repositories", " exchange questions and change requests."],
		list: [],
		selected: -1,
		bottom: [""],
		footer: ` ${theme.fg("dim", "n new  esc close")}`,
	};
}

/** The visible part of a list in `room` lines, with a marker line above and below when it scrolls. */
function windowOf(list: string[], selected: number, room: number, theme: ScreenTheme): string[] {
	if (list.length <= room) return list;
	if (room < 3) return list.slice(Math.max(0, Math.min(selected, list.length - room)), Math.max(0, Math.min(selected, list.length - room)) + room);
	const visible = room - 2;
	const focus = Math.max(0, selected);
	const start = Math.max(0, Math.min(focus - Math.floor(visible / 2), list.length - visible));
	const end = start + visible;
	return [
		start > 0 ? theme.fg("dim", `  ↑ ${start} more`) : "",
		...list.slice(start, end),
		end < list.length ? theme.fg("dim", `  ↓ ${list.length - end} more`) : "",
	];
}

/**
 * Lines of the screen, each cut to `width`. With `rows` (the terminal height, S19)
 * there are exactly `rows` lines: content, feedback, blank padding, then the footer.
 * Without it, the content is followed by the footer and the feedback.
 */
export function render(state: ScreenState, width: number, theme: ScreenTheme, rows?: number): string[] {
	const tab = state.tabs[state.tab];
	const head = [tabsLine(state, theme), theme.fg("border", "─".repeat(Math.max(0, width)))];
	let layout: Layout;
	if (!tab) layout = emptyView(theme);
	else if (state.view === "requests") layout = requestsView(state, tab, theme);
	else if (state.view === "history") layout = historyView(state, tab, theme);
	else layout = membersView(state, tab, width, theme);
	const feedback = feedbackLine(state, theme);
	const fit = (lines: string[]) => lines.map((line) => truncateToWidth(line, width));

	if (rows === undefined) return fit([...head, ...layout.top, ...layout.list, ...layout.bottom, layout.footer, ...feedback]);
	const height = Math.max(1, Math.floor(rows));
	const top: (string | undefined)[] = [...layout.top];
	const bottom: (string | undefined)[] = [...layout.bottom];
	const lineCount = () => head.length + top.filter((l) => l !== undefined).length + bottom.filter((l) => l !== undefined).length + feedback.length;
	// D4: keep at least one list row by dropping optional lines first.
	for (const [where, index] of layout.droppable ?? []) {
		if (layout.list.length === 0 || height - 1 - lineCount() >= 1) break;
		(where === "top" ? top : bottom)[index] = undefined;
	}
	const fixed = [...head, ...top.filter((l): l is string => l !== undefined)];
	const after = [...bottom.filter((l): l is string => l !== undefined), ...feedback];
	const room = height - 1 - fixed.length - after.length;
	const body = [...fixed, ...(room > 0 ? windowOf(layout.list, layout.selected, room, theme) : []), ...after].slice(0, height - 1);
	return fit([...body, ...Array<string>(height - 1 - body.length).fill(""), layout.footer]);
}

export function handleKey(previous: ScreenState, key: KeyName): { state: ScreenState; action?: ScreenAction } {
	const { feedback: _cleared, ...state } = previous;
	if (key === "close") return { state, action: { type: "close" } };
	const tab = state.tabs[state.tab];
	if (!tab) {
		if (key === "n") return { state, action: { type: "new" } };
		if (key === "escape") return { state, action: { type: "close" } };
		return { state };
	}

	const decide = (choice: "Accept" | "Decline") => {
		const request = tab.requests[state.request];
		return request?.decidable
			? { state, action: { type: "decide", team: tab.name, requestId: request.id, choice } as ScreenAction }
			: { state };
	};

	if (state.view === "history") {
		const events = tab.requests[state.request]?.events.length ?? 0;
		if (key === "escape") {
			const { event: _event, ...rest } = state;
			return { state: { ...rest, view: "requests" } };
		}
		if (key === "up") return { state: { ...state, event: clamp((state.event ?? 0) - 1, events) } };
		if (key === "down") return { state: { ...state, event: clamp((state.event ?? 0) + 1, events) } };
		if (key === "a") return decide("Accept");
		if (key === "d") return decide("Decline");
		return { state };
	}

	if (state.view === "requests") {
		const count = tab.requests.length;
		if (key === "escape") return { state: { ...state, view: "members" } };
		if (key === "up") return { state: { ...state, request: clamp(state.request - 1, count) } };
		if (key === "down") return { state: { ...state, request: clamp(state.request + 1, count) } };
		if (key === "enter") return count > 0 ? { state: { ...state, view: "history", event: 0 } } : { state };
		if (key === "a") return decide("Accept");
		if (key === "d") return decide("Decline");
		return { state };
	}

	switch (key) {
		case "left":
		case "right": {
			const next = clamp(state.tab + (key === "left" ? -1 : 1), state.tabs.length);
			if (next === state.tab) return { state };
			return { state: { ...state, tab: next, member: defaultMember(state.tabs[next], state.thisSession), request: 0 } };
		}
		case "up":
			return { state: { ...state, member: clamp(state.member - 1, tab.members.length) } };
		case "down":
			return { state: { ...state, member: clamp(state.member + 1, tab.members.length) } };
		case "j":
			return { state, action: { type: "join", team: tab.name } };
		case "l": {
			const member = tab.members[state.member];
			return member ? { state, action: { type: "leave", team: tab.name, alias: member.alias } } : { state };
		}
		case "r":
			return { state: { ...state, view: "requests", request: 0 } };
		case "p":
			return { state, action: { type: "prune", team: tab.name } };
		case "x":
			return { state, action: { type: "archive", team: tab.name } };
		case "n":
			return { state, action: { type: "new" } };
		case "escape":
			return { state, action: { type: "close" } };
		default:
			return { state };
	}
}
