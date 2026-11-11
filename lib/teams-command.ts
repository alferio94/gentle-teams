/**
 * `/teams` command orchestration (feature spec S13-S14, docs/architecture.md §7).
 *
 * One action at a time, like `/gentle:profiles`: load a snapshot of the store, open the
 * screen, get one action back, run its dialog (ctx.ui.input / confirm) and the store or
 * session change outside the screen, then reopen the screen at the same place with
 * feedback. Esc closes. Every port is injected, so the flows are tested with fakes;
 * extensions/teams.ts only adapts Pi's context.
 */

import { basename } from "node:path";
import { DEFAULT_PRUNE_DAYS } from "./config.ts";
import { listDeliverableRequests } from "./delivery.ts";
import { isTerminal } from "./lifecycle.ts";
import type { Presence } from "./presence.ts";
import { ageText, countText, pruneCandidates } from "./prune.ts";
import type { DecideOutcome, StartOutcome } from "./session.ts";
import { ALIAS_PATTERN, TeamStoreError, type RequestView, type Store } from "./store.ts";
import {
	handleKey,
	placeOf,
	render,
	screenState,
	type Feedback,
	type KeyName,
	type MemberRow,
	type RequestRow,
	type ScreenAction,
	type ScreenData,
	type ScreenPlace,
	type ScreenState,
	type ScreenTheme,
	type TeamTab,
} from "./ui/teams-screen.ts";

export const NEEDS_INTERACTIVE = "/teams requires interactive mode.";
export const NOT_IN_GIT = "teams: this session is not inside a Git repository; open it in a repository to join.";
const NO_SESSION = "teams: this session is still starting; try again in a moment.";

/** The part of TeamSession the command uses. */
export interface CommandSession {
	readonly binding: { team: string; alias: string } | undefined;
	bindTo(team: string, alias: string): Promise<StartOutcome>;
	unbind(): Promise<boolean>;
	clearDecision(root: string): void;
	decide(requestId: string, choice: "Accept" | "Decline"): Promise<DecideOutcome>;
	pruneRequests(team: string, ids: readonly string[], options: { days: number; now?: () => number }): Promise<string[]>;
}

export interface ScreenResult {
	action: ScreenAction;
	state: ScreenState;
}

export interface TeamsCommandPorts {
	store: Store;
	presence: Pick<Presence, "status">;
	/** The current Pi session's team session; undefined before session_start. */
	session(): CommandSession | undefined;
	cwd: string;
	/** Shown as `~` in repository paths. */
	home?: string;
	/** False outside the TUI: the command says so and changes nothing. */
	interactive: boolean;
	ui: {
		input(title: string, placeholder?: string): Promise<string | undefined>;
		confirm(title: string, message: string): Promise<boolean>;
		notify(message: string, level: "info" | "warning" | "error"): void;
	};
	resolveGitRoot(cwd: string): Promise<string | undefined>;
	/** Open the screen; resolves with the chosen action, or undefined when it could not be shown. */
	show(state: ScreenState): Promise<ScreenResult | undefined>;
	/** S20: `pruneClosedAfterDays` from the config; default 7. */
	pruneClosedAfterDays?: number;
	now?: () => number;
}

/** Repository folder name, lowercased and reduced to the alias pattern. */
export function defaultAlias(repositoryRoot: string): string {
	const alias = basename(repositoryRoot)
		.toLowerCase()
		.replace(/[^a-z0-9-]+/g, "-")
		.replace(/-+/g, "-")
		.replace(/^-+/, "")
		.slice(0, 32)
		.replace(/-+$/, "");
	return ALIAS_PATTERN.test(alias) ? alias : "member";
}

const verbatim = (error: unknown): Feedback => {
	if (error instanceof TeamStoreError) return { text: `${error.code}: ${error.message}`, level: "error" };
	return { text: `teams: ${error instanceof Error ? error.message : String(error)}`, level: "error" };
};
const info = (text: string): Feedback => ({ text, level: "info" });
const error = (text: string): Feedback => ({ text, level: "error" });

/** Open requests a member received, grouped by what they wait for. */
function requestSummary(views: RequestView[], alias: string): string {
	let waiting = 0;
	let progress = 0;
	let decision = 0;
	for (const view of views) {
		if (view.record.to !== alias || isTerminal(view.state)) continue;
		if (view.state === "requested") waiting++;
		else if (view.state === "needs_decision") decision++;
		else progress++;
	}
	const parts = [];
	if (waiting) parts.push(`${waiting} waiting`);
	if (progress) parts.push(`${progress} in progress`);
	if (decision) parts.push(`${decision} needs decision`);
	return parts.length > 0 ? parts.join(", ") : "—";
}

export async function loadScreenData(ports: TeamsCommandPorts): Promise<ScreenData> {
	const { store } = ports;
	const binding = ports.session()?.binding;
	const gitRoot = await ports.resolveGitRoot(ports.cwd).catch(() => undefined);
	const tabs: TeamTab[] = [];
	for (const team of await store.listTeams()) {
		const name = team.name;
		const ownAlias = binding?.team === name ? binding.alias : undefined;
		// One unreadable request must not hide the team (as in delivery).
		const views = await listDeliverableRequests(store, name, () => undefined);
		const members: MemberRow[] = [];
		let live = false;
		for (const member of await store.listMembers(name)) {
			const status = await ports.presence.status(name, member.alias).catch(() => ({ online: false }) as const);
			const state = status.online ? status.record.state : "offline";
			if (status.online && member.alias !== ownAlias) live = true;
			members.push({ alias: member.alias, repositoryRoot: member.repositoryRoot, state, requests: requestSummary(views, member.alias) });
		}
		const requests: RequestRow[] = views.map(({ record, events, state }) => ({
			id: record.id,
			kind: record.kind,
			from: record.from,
			to: record.to,
			title: record.title,
			state,
			events: events.map((e) => ({
				seq: e.seq,
				actor: e.actor,
				role: e.role,
				transition: e.transition,
				...(e.summary !== undefined ? { summary: e.summary } : {}),
				at: e.at,
			})),
			// S18: the recipient decides, and so may the requester on the recipient's behalf.
			decidable:
				record.kind === "change" && ownAlias !== undefined && (record.to === ownAlias || record.from === ownAlias) && state === "requested",
			...(record.kind === "change" && ownAlias !== undefined && record.from === ownAlias && state === "requested" ? { onBehalfOf: record.to } : {}),
		}));
		tabs.push({ name, description: team.description, bound: ownAlias !== undefined, live, members, requests });
	}
	const thisSession = {
		...(gitRoot !== undefined ? { gitRoot } : {}),
		...(binding ? { binding: { ...binding } } : {}),
	};
	return { tabs, thisSession, ...(ports.home !== undefined ? { home: ports.home } : {}) };
}

async function createTeam(ports: TeamsCommandPorts, place: ScreenPlace): Promise<ScreenPlace> {
	const cancelled = { ...place, feedback: info("New team cancelled; nothing changed.") };
	const name = (await ports.ui.input("New team name:", "e.g. tienda-online"))?.trim();
	if (!name) return cancelled;
	const description = await ports.ui.input(`Description for "${name}" (optional):`, "");
	if (description === undefined) return cancelled;
	try {
		await ports.store.createTeam({ name, description: description.trim() });
	} catch (e) {
		return { ...place, feedback: verbatim(e) };
	}
	return { team: name, view: "members", feedback: info(`Created team "${name}". Press j to join it with this repository.`) };
}

async function join(ports: TeamsCommandPorts, place: ScreenPlace, team: string): Promise<ScreenPlace> {
	const at = (feedback: Feedback, extra: ScreenPlace = {}): ScreenPlace => ({ ...place, team, ...extra, feedback });
	const session = ports.session();
	if (!session) return at(error(NO_SESSION));
	const root = await ports.resolveGitRoot(ports.cwd).catch(() => undefined);
	if (!root) return at(error(NOT_IN_GIT));

	let members;
	try {
		members = await ports.store.listMembers(team);
	} catch (e) {
		return at(verbatim(e));
	}
	const existing = members.find((m) => m.repositoryRoot === root);
	let alias: string;
	if (existing) {
		alias = existing.alias;
	} else {
		const proposed = defaultAlias(root);
		const answer = await ports.ui.input(`Join "${team}" with this repository as (alias):`, proposed);
		if (answer === undefined) return at(info("Join cancelled; nothing changed."));
		alias = answer.trim() || proposed;
	}

	const current = session.binding;
	if (current && current.team === team && current.alias === alias) {
		return at(info(`This session is already bound to "${team}" as "${alias}".`), { member: alias });
	}
	// D4: one team at a time; the human confirms switching before anything is written.
	if (current) {
		const ok = await ports.ui.confirm(
			"Switch this session's team?",
			`This session is bound to "${current.team}" as "${current.alias}". Unbind it and join "${team}" as "${alias}"?`,
		);
		if (!ok) return at(info("Switch cancelled; nothing changed."));
	}

	let resumed: boolean;
	try {
		({ resumed } = await ports.store.joinMember(team, { alias, repositoryRoot: root }));
		// Check before unbinding, so a refused claim keeps the current binding.
		const holder = await ports.presence.status(team, alias);
		if (holder.online) {
			throw new TeamStoreError("member-bound", `Member "${alias}" is bound to another live session.`);
		}
		if (current) await session.unbind();
		const outcome = await session.bindTo(team, alias);
		if (!outcome.bound) return at(error(`teams: this session could not bind (${outcome.reason}).`), { member: alias });
	} catch (e) {
		return at(verbatim(e), { member: alias });
	}
	const text = resumed
		? `Resumed member "${alias}" of "${team}"; this session is bound to it.`
		: `Joined "${team}" as "${alias}"; this session is bound to it.`;
	return at(info(text), { member: alias, view: "members" });
}

async function leave(ports: TeamsCommandPorts, place: ScreenPlace, team: string, alias: string): Promise<ScreenPlace> {
	const at = (feedback: Feedback, extra: ScreenPlace = {}): ScreenPlace => ({ ...place, team, ...extra, feedback });
	const session = ports.session();
	const ownBinding = session?.binding?.team === team && session.binding.alias === alias;
	let member;
	try {
		member = (await ports.store.listMembers(team)).find((m) => m.alias === alias);
	} catch (e) {
		return at(verbatim(e));
	}
	if (!member) return at(error(`unknown-member: Member "${alias}" is not part of team "${team}".`));
	// Each session decides only for its own repository: another repository's member
	// can only be removed from a session opened in that repository.
	const root = await ports.resolveGitRoot(ports.cwd).catch(() => undefined);
	if (root !== member.repositoryRoot) {
		return at(error(`teams: only the session in ${member.repositoryRoot} can remove member "${alias}"; leave from that repository.`));
	}
	let note = "";
	if (ownBinding) note = " This session is bound to it and will be unbound.";
	else if ((await ports.presence.status(team, alias).catch(() => ({ online: false }))).online) {
		note = " Another live session is bound to it and will stop receiving requests.";
	}
	const ok = await ports.ui.confirm(`Leave team "${team}"?`, `Remove member "${alias}" (${member.repositoryRoot}) from "${team}".${note}`);
	if (!ok) return at(info("Leave cancelled; nothing changed."));
	try {
		await ports.store.leaveMember(team, alias);
	} catch (e) {
		return at(verbatim(e)); // D2: e.g. open-requests; the store left everything unchanged.
	}
	const unbound = ownBinding && session ? await session.unbind() : false;
	session?.clearDecision(root);
	return {
		team,
		view: "members",
		feedback: info(`Member "${alias}" left "${team}"${unbound ? "; this session is no longer bound." : "."}`),
	};
}

async function archive(ports: TeamsCommandPorts, place: ScreenPlace, team: string): Promise<ScreenPlace> {
	const ok = await ports.ui.confirm(`Archive team "${team}"?`, "Its history and configuration are preserved; repositories are not deleted. This will unbind all idle or disconnected sessions, including the current session if bound. No terminals or conversations are closed. Working sessions and open requests prevent archiving.");
	if (!ok) return { ...place, feedback: info("Archive cancelled; nothing changed.") };
	await ports.store.archiveTeam(team);
	const session = ports.session();
	if (session?.binding?.team === team) await session.unbind();
	return { view: "members", feedback: info(`Archived team "${team}"; its history and repositories are preserved.`) };
}

async function decide(ports: TeamsCommandPorts, place: ScreenPlace, requestId: string, choice: "Accept" | "Decline"): Promise<ScreenPlace> {
	const session = ports.session();
	if (!session) return { ...place, feedback: error(NO_SESSION) };
	const outcome = await session.decide(requestId, choice);
	if (!outcome.ok) return { ...place, feedback: error(`${outcome.code}: ${outcome.message}`) };
	let text: string;
	if (outcome.onBehalfOf !== undefined) {
		const who = `on behalf of "${outcome.onBehalfOf}"`;
		text = outcome.state === "accepted" ? `Accepted request ${requestId} ${who}; its session tells its model.` : `Declined request ${requestId} ${who}.`;
	} else {
		text = outcome.state === "accepted" ? `Accepted request ${requestId}; the model was told.` : `Declined request ${requestId}.`;
	}
	return { ...place, feedback: info(text) };
}

/** S20: count the candidates first, confirm with that count, then remove them. */
async function prune(ports: TeamsCommandPorts, place: ScreenPlace, team: string): Promise<ScreenPlace> {
	const at = (feedback: Feedback): ScreenPlace => ({ ...place, team, feedback });
	const session = ports.session();
	if (!session) return at(error(NO_SESSION));
	const days = ports.pruneClosedAfterDays ?? DEFAULT_PRUNE_DAYS;
	const candidates = await pruneCandidates(ports.store, team, { days, now: ports.now });
	if (candidates.length === 0) return at(info(`No closed requests ${ageText(days)} in "${team}"; nothing to remove.`));
	const ok = await ports.ui.confirm(
		`Remove ${countText(candidates.length)} ${ageText(days)} from "${team}"?`,
		"Their events and approvals are deleted too. This cannot be undone.",
	);
	if (!ok) return at(info("Clean-up cancelled; nothing changed."));
	const removed = await session.pruneRequests(
		team,
		candidates.map((v) => v.record.id),
		{ days, ...(ports.now ? { now: ports.now } : {}) },
	);
	const kept = candidates.length - removed.length;
	return at(
		info(`Removed ${countText(removed.length)} from "${team}".${kept > 0 ? ` ${kept} changed meanwhile and ${kept === 1 ? "was" : "were"} kept.` : ""}`),
	);
}

export async function runTeamsCommand(ports: TeamsCommandPorts): Promise<void> {
	if (!ports.interactive) {
		ports.ui.notify(NEEDS_INTERACTIVE, "error");
		return;
	}
	let place: ScreenPlace = {};
	for (;;) {
		let state: ScreenState;
		try {
			state = screenState(await loadScreenData(ports), place);
		} catch (e) {
			ports.ui.notify(verbatim(e).text, "error");
			return;
		}
		const result = await ports.show(state);
		if (!result || result.action.type === "close") return;
		const { action } = result;
		place = placeOf(result.state);
		try {
			if (action.type === "new") place = await createTeam(ports, place);
			else if (action.type === "join") place = await join(ports, place, action.team);
			else if (action.type === "leave") place = await leave(ports, place, action.team, action.alias);
			else if (action.type === "prune") place = await prune(ports, place, action.team);
			else if (action.type === "archive") place = await archive(ports, place, action.team);
			else place = await decide(ports, place, action.requestId, action.choice);
		} catch (e) {
			place = { ...place, feedback: verbatim(e) };
		}
	}
}

/** The keybinding lookup Pi injects into custom components (subset). */
export interface KeyMatcher {
	matches(data: string, id: string): boolean;
}

const RAW_KEYS: Record<string, KeyName> = {
	"\x1b[A": "up",
	"\x1b[B": "down",
	"\x1b[C": "right",
	"\x1b[D": "left",
	"\x1bOA": "up",
	"\x1bOB": "down",
	"\x1bOC": "right",
	"\x1bOD": "left",
	"\r": "enter",
	"\n": "enter",
	"\x1b": "escape",
	"\x03": "close",
};

/** Turn raw terminal input into a screen key name; undefined for keys the screen ignores. */
export function decodeKey(data: string, keybindings?: KeyMatcher): KeyName | undefined {
	// Kitty keyboard protocol key-release events.
	if (/:3[u~A-DHFPQS]$/.test(data)) return undefined;
	// Letters first, so a remapped navigation binding never shadows an action key.
	if (data.length === 1 && data >= " " && data !== "\x7f") return data;
	const kitty = /^\x1b\[(\d+)u$/.exec(data);
	if (kitty) {
		const code = Number(kitty[1]);
		if (code === 27) return "escape";
		if (code === 13) return "enter";
		if (code >= 32 && code < 127) return String.fromCharCode(code);
		return undefined;
	}
	if (RAW_KEYS[data]) return RAW_KEYS[data];
	if (keybindings) {
		if (keybindings.matches(data, "tui.select.up")) return "up";
		if (keybindings.matches(data, "tui.select.down")) return "down";
		if (keybindings.matches(data, "tui.editor.cursorLeft")) return "left";
		if (keybindings.matches(data, "tui.editor.cursorRight")) return "right";
		if (keybindings.matches(data, "tui.select.confirm")) return "enter";
		if (keybindings.matches(data, "tui.select.cancel")) return "escape";
	}
	return undefined;
}

/**
 * The component handed to Pi's `ctx.ui.custom()`: renders the state, applies keys,
 * and finishes with the first action. `rows` (S19) is read at each render, e.g.
 * `() => tui.terminal.rows`, so the screen fills the terminal and follows resizes.
 */
export function createScreenComponent(
	initial: ScreenState,
	theme: ScreenTheme,
	keybindings: KeyMatcher | undefined,
	requestRender: () => void,
	done: (result: ScreenResult) => void,
	rows?: () => number,
): { render(width: number): string[]; handleInput(data: string): void; invalidate(): void } {
	let state = initial;
	let finished = false;
	return {
		render: (width) => render(state, width, theme, rows?.()),
		handleInput(data) {
			if (finished) return;
			const key = decodeKey(data, keybindings);
			if (key === undefined) return;
			const result = handleKey(state, key);
			state = result.state;
			if (result.action) {
				finished = true;
				done({ action: result.action, state });
				return;
			}
			requestRender();
		},
		invalidate: () => undefined,
	};
}
