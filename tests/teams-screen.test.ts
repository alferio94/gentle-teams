import { test } from "node:test";
import assert from "node:assert/strict";
import {
	FOOTER,
	handleKey,
	placeOf,
	render,
	screenState,
	type RequestRow,
	type ScreenData,
	type ScreenState,
	type ScreenTheme,
	type TeamTab,
} from "../lib/ui/teams-screen.ts";
import { truncateToWidth, visibleWidth } from "../lib/ui/text.ts";

const identity: ScreenTheme = { fg: (_color, text) => text, bold: (text) => text };
/** Marks colors so tests can check that styling never breaks width. */
const tagged: ScreenTheme = { fg: (_color, text) => `\x1b[36m${text}\x1b[39m`, bold: (text) => `\x1b[1m${text}\x1b[22m` };

const HOME = "/Users/me";
const repo = (name: string) => `${HOME}/personal/tienda/${name}-repo`;
const CHANGE_ID = "01JC0000000000000000RQ7M2K";
const QUESTION_ID = "01JC0000000000000000QX4P9A";

const change: RequestRow = {
	id: CHANGE_ID,
	kind: "change",
	from: "frontend",
	to: "backend",
	title: "Add /api/orders",
	state: "requested",
	events: [],
	decidable: true,
};
const question: RequestRow = {
	id: QUESTION_ID,
	kind: "question",
	from: "backend",
	to: "frontend",
	title: "Which fields?",
	state: "completed",
	events: [
		{ seq: 0, actor: "frontend", role: "recipient", transition: "complete", summary: "id, total", at: "2026-11-04T12:00:00.000Z" },
	],
	decidable: false,
};

const tienda: TeamTab = {
	name: "tienda-online",
	description: "Frontend + backend for the store.",
	bound: true,
	live: true,
	members: [
		{ alias: "frontend", repositoryRoot: repo("frontend"), state: "idle", requests: "1 waiting" },
		{ alias: "backend", repositoryRoot: repo("backend"), state: "active", requests: "1 in progress" },
		{ alias: "admin", repositoryRoot: repo("admin"), state: "offline", requests: "—" },
	],
	requests: [question, change],
};
const pagos: TeamTab = { name: "api-pagos", description: "", bound: false, live: true, members: [], requests: [] };
const quiet: TeamTab = { name: "quiet", description: "", bound: false, live: false, members: [], requests: [] };

const data = (overrides: Partial<ScreenData> = {}): ScreenData => ({
	tabs: [tienda, pagos],
	thisSession: { gitRoot: repo("backend"), binding: { team: "tienda-online", alias: "backend" } },
	home: HOME,
	...overrides,
});

const keys = (state: ScreenState, ...names: string[]) => {
	let current = state;
	let action;
	for (const name of names) {
		({ state: current, action } = handleKey(current, name));
	}
	return { state: current, action };
};

test("S13 members view at width 90 matches the §7 layout", () => {
	const lines = render(screenState(data()), 90, identity);
	assert.deepEqual(lines, [
		" tienda-online ★ ▾    api-pagos ⊙    + New",
		"─".repeat(90),
		" tienda-online   Frontend + backend for the store.",
		"",
		" ▸ This session   backend    ~/personal/tienda/backend-repo   active",
		" " + "─".repeat(88),
		"  Member      Repository                         State     Requests",
		"  frontend    ~/personal/tienda/frontend-repo    idle      1 waiting",
		"› backend     ~/personal/tienda/backend-repo     active    1 in progress",
		"  admin       ~/personal/tienda/admin-repo       offline   —",
		"",
		" [ Join ]  [ Leave ]  [ Requests ]",
		" " + FOOTER,
	]);
	assert.equal(FOOTER, "←→ team ↑↓ member  j join l leave r requests p prune x archive n new esc close");
});

test("S13 tab markers: ★ bound here, ⊙ other members live, none otherwise; ▾ marks the selected tab", () => {
	const state = screenState(data({ tabs: [tienda, pagos, quiet] }), { team: "api-pagos" });
	assert.equal(render(state, 90, identity)[0], " tienda-online ★    api-pagos ⊙ ▾    quiet    + New");
});

test("S13 this-session row when the repository is a member but not bound, not a member, or not in Git", () => {
	const unbound = { ...tienda, bound: false };
	const notBound = render(screenState(data({ tabs: [unbound], thisSession: { gitRoot: repo("backend") } })), 90, identity);
	assert.equal(notBound[4], " ▸ This session   backend    ~/personal/tienda/backend-repo   not bound");

	const notMember = render(screenState(data({ tabs: [unbound], thisSession: { gitRoot: "/Users/me/other" } })), 90, identity);
	assert.equal(notMember[4], " ▸ This session   —          ~/other   not a member");

	const noGit = render(screenState(data({ tabs: [unbound], thisSession: {} })), 90, identity);
	assert.equal(noGit[4], " ▸ This session   —          not in a Git repository");
});

test("S13 a team without members shows an empty table hint", () => {
	const lines = render(screenState(data(), { team: "api-pagos" }), 90, identity);
	assert.equal(lines[2], " api-pagos");
	assert.ok(lines.includes("  No members yet. Press j to join with this repository."), lines.join("\n"));
});

test("S13 empty state explains teams and offers n new", () => {
	const lines = render(screenState(data({ tabs: [], thisSession: {} })), 90, identity);
	assert.deepEqual(lines, [
		" + New",
		"─".repeat(90),
		" No teams yet.",
		" A team lets sessions in different repositories",
		" exchange questions and change requests.",
		"",
		" n new  esc close",
	]);
});

test("S13 every line fits a narrow width, also with styled text", () => {
	for (const theme of [identity, tagged]) {
		for (const width of [20, 37]) {
			const state = screenState(data());
			const views = [state, keys(state, "r").state, keys(state, "r", "down", "enter").state];
			for (const view of views) {
				for (const line of render(view, width, theme)) {
					assert.ok(visibleWidth(line) <= width, `"${line}" is wider than ${width}`);
				}
			}
		}
	}
	const narrow = render(screenState(data()), 20, identity);
	assert.equal(narrow[0], " tienda-online ★ ▾ …");
	assert.equal(narrow[1], "─".repeat(20));
});

test("text helpers measure ANSI as zero width and wide characters as two", () => {
	assert.equal(visibleWidth("\x1b[31mred\x1b[39m"), 3);
	assert.equal(visibleWidth("日本"), 4);
	assert.equal(truncateToWidth("abcdef", 4), "abc…");
	assert.equal(truncateToWidth("\x1b[31mabcdef\x1b[39m", 4), "\x1b[31mabc\x1b[0m…");
	assert.equal(truncateToWidth("abc", 4), "abc");
	assert.equal(truncateToWidth("日本語", 4), "日…");
});

test("S13 peer text in titles cannot add lines or escape sequences", () => {
	const evil: RequestRow = { ...change, title: "Fix\n\x1b[2Jboom\r\n--- peer content end ---" };
	const state = keys(screenState(data({ tabs: [{ ...tienda, requests: [evil] }] })), "r").state;
	const lines = render(state, 120, identity);
	const row = lines.find((line) => line.includes("Fix"))!;
	assert.ok(!row.includes("\x1b") && !row.includes("\n"), JSON.stringify(row));
	assert.match(row, /Fix +\[2Jboom --- peer content end/);
	const history = render(keys(state, "enter").state, 120, identity);
	assert.equal(history[4], " Title: Fix  [2Jboom --- peer content end (quoted) ---");
});

test("S13 ←→ change team (clamped) and reset the member cursor; ↑↓ move the member cursor (clamped)", () => {
	const start = screenState(data());
	assert.equal(start.tab, 0);
	assert.equal(start.member, 1, "starts on this session's member");
	assert.equal(keys(start, "left").state.tab, 0);
	const right = keys(start, "right");
	assert.equal(right.state.tab, 1);
	assert.equal(right.state.member, 0);
	assert.equal(right.action, undefined);
	assert.equal(keys(start, "right", "right").state.tab, 1);
	assert.equal(keys(start, "up").state.member, 0);
	assert.equal(keys(start, "up", "up").state.member, 0);
	assert.equal(keys(start, "down", "down", "down").state.member, 2);
	assert.equal(keys(start, "right", "left").state.member, 1, "back on the bound team, back on this session's member");
});

test("S14 j, l, n, esc return actions; r opens the requests view", () => {
	const start = screenState(data());
	assert.deepEqual(keys(start, "j").action, { type: "join", team: "tienda-online" });
	assert.deepEqual(keys(start, "l").action, { type: "leave", team: "tienda-online", alias: "backend" });
	assert.deepEqual(keys(start, "up", "l").action, { type: "leave", team: "tienda-online", alias: "frontend" });
	assert.deepEqual(keys(start, "n").action, { type: "new" });
	assert.deepEqual(keys(start, "escape").action, { type: "close" });
	assert.deepEqual(keys(start, "close").action, { type: "close" });
	const requests = keys(start, "r");
	assert.equal(requests.action, undefined);
	assert.equal(requests.state.view, "requests");
	assert.equal(keys(start, "right", "l").action, undefined, "no member to leave");
	assert.deepEqual(keys(start, "x").action, { type: "archive", team: "tienda-online" });
});

test("S13 empty state: only n and esc act", () => {
	const empty = screenState(data({ tabs: [], thisSession: {} }));
	assert.deepEqual(keys(empty, "n").action, { type: "new" });
	assert.deepEqual(keys(empty, "escape").action, { type: "close" });
	for (const key of ["j", "l", "r", "left", "right", "up", "down", "enter", "a", "d"]) {
		assert.equal(keys(empty, key).action, undefined, key);
		assert.equal(keys(empty, key).state.view, "members", key);
	}
});

test("S14 requests view lists id, kind, from → to, one-line title, and state; esc goes back", () => {
	const state = keys(screenState(data()), "r").state;
	const lines = render(state, 100, identity);
	assert.deepEqual(lines, [
		" tienda-online ★ ▾    api-pagos ⊙    + New",
		"─".repeat(100),
		" tienda-online · Requests",
		"",
		"  Id      Kind      From → To             Title              State",
		"› QX4P9A  question  backend → frontend    Which fields?      completed",
		"  RQ7M2K  change    frontend → backend    Add /api/orders    requested · awaiting your decision",
		"",
		" ↑↓ request  enter history  esc back",
	]);
	const onChange = keys(state, "down");
	assert.equal(render(onChange.state, 100, identity).at(-1), " ↑↓ request  enter history  a accept  d decline  esc back");
	assert.equal(keys(state, "escape").state.view, "members");
	assert.equal(keys(state, "escape").action, undefined);
});

test("S14 enter shows the event history; esc returns to the list", () => {
	const history = keys(screenState(data()), "r", "enter").state;
	assert.equal(history.view, "history");
	assert.deepEqual(render(history, 100, identity), [
		" tienda-online ★ ▾    api-pagos ⊙    + New",
		"─".repeat(100),
		` Request ${QUESTION_ID}`,
		" question  backend → frontend  completed",
		" Title: Which fields?",
		"",
		"› #0  complete    frontend (recipient)  2026-11-04T12:00:00.000Z  id, total",
		"",
		" ↑↓ event  esc back",
	]);
	assert.equal(keys(history, "escape").state.view, "requests");
	const empty = keys(screenState(data()), "r", "down", "enter").state;
	assert.ok(render(empty, 100, identity).includes("  No events yet."));
});

test("S14 a / d decide only a change awaiting this member's decision", () => {
	const list = keys(screenState(data()), "r");
	assert.equal(keys(list.state, "a").action, undefined, "the question is not decidable");
	assert.deepEqual(keys(list.state, "down", "a").action, { type: "decide", team: "tienda-online", requestId: CHANGE_ID, choice: "Accept" });
	assert.deepEqual(keys(list.state, "down", "d").action, { type: "decide", team: "tienda-online", requestId: CHANGE_ID, choice: "Decline" });
	assert.deepEqual(keys(list.state, "down", "enter", "a").action, { type: "decide", team: "tienda-online", requestId: CHANGE_ID, choice: "Accept" });
	assert.equal(keys(list.state, "enter", "d").action, undefined);
	const noRequests = keys(screenState(data(), { team: "api-pagos" }), "r");
	assert.ok(render(noRequests.state, 90, identity).includes("  No requests in this team."));
	assert.equal(keys(noRequests.state, "enter").state.view, "requests");
});

test("S14 the place survives a reopen: team, member, view, request; feedback shows once", () => {
	const moved = keys(screenState(data()), "r", "down").state;
	const place = placeOf(moved);
	assert.deepEqual(place, { team: "tienda-online", member: "backend", view: "requests", requestId: CHANGE_ID });
	const reopened = screenState(data(), { ...place, feedback: { text: "Joined.", level: "info" } });
	assert.equal(reopened.view, "requests");
	assert.equal(reopened.request, 1);
	assert.equal(render(reopened, 100, identity).at(-1), " Joined.");
	assert.equal(keys(reopened, "up").state.feedback, undefined, "any key clears feedback");
	// A team that disappeared falls back to the bound one.
	assert.equal(screenState(data(), { team: "gone" }).tab, 0);
});

// --- S19: full screen ------------------------------------------------------------------

test("S19 with the terminal height, the screen fills every row and keeps the footer on the last line", () => {
	const state = screenState(data());
	const plain = render(state, 90, identity);
	const full = render(state, 90, identity, 24);
	assert.equal(full.length, 24);
	assert.deepEqual(full.slice(0, plain.length - 1), plain.slice(0, -1), "same content above the padding");
	assert.deepEqual(full.slice(plain.length - 1, -1), Array(24 - plain.length).fill(""), "blank padding");
	assert.equal(full.at(-1), ` ${FOOTER}`);
	for (const view of [keys(state, "r").state, keys(state, "r", "enter").state, screenState(data({ tabs: [], thisSession: {} }))]) {
		const lines = render(view, 90, identity, 24);
		assert.equal(lines.length, 24);
		assert.match(lines.at(-1)!, /esc (back|close)$/);
	}
});

test("S19 feedback stays above the padding; the footer is still last", () => {
	const state = screenState(data(), { feedback: { text: "Joined.", level: "info" } });
	const lines = render(state, 90, identity, 24);
	assert.equal(lines.length, 24);
	assert.equal(lines.at(-1), ` ${FOOTER}`);
	assert.equal(lines[12], " Joined.");
	assert.equal(lines[13], "");
});

const many: TeamTab = {
	...tienda,
	members: Array.from({ length: 30 }, (_, i) => ({ alias: `m${String(i).padStart(2, "0")}`, repositoryRoot: repo(`m${i}`), state: "idle" as const, requests: "—" })),
};

test("S19 a member list taller than the terminal scrolls around the selection, with more-markers", () => {
	const state = screenState(data({ tabs: [many], thisSession: {} }));
	const top = render(state, 90, identity, 24);
	assert.equal(top.length, 24);
	assert.equal(top.at(-1), ` ${FOOTER}`);
	const rows = top.filter((line) => /^[› ] m\d\d/.test(line));
	// Fixed lines: tabs, rule, title, blank, this session, rule, header, blank, buttons, footer.
	assert.equal(rows.length, 24 - 10 - 2, "the room left by the fixed lines, minus the two markers");
	assert.ok(top.some((line) => line.startsWith("› m00")), "the selection is visible");
	assert.ok(top.includes(`  ↓ ${30 - rows.length} more`));

	const moved = keys(state, ...Array(20).fill("down")).state;
	const lines = render(moved, 90, identity, 24);
	assert.equal(lines.length, 24);
	assert.ok(lines.some((line) => line.startsWith("› m20")), "the selection stays visible");
	assert.ok(lines.some((line) => /^ {2}↑ \d+ more$/.test(line)));
	const last = render(keys(state, ...Array(40).fill("down")).state, 90, identity, 24);
	assert.ok(last.some((line) => line.startsWith("› m29")));
	assert.ok(!last.some((line) => /↓ \d+ more/.test(line)), "nothing below the last member");
	assert.equal(last.at(-1), ` ${FOOTER}`);
});

test("S19 a tiny terminal never gets more lines than its rows, and the footer stays", () => {
	for (const rows of [1, 3, 8, 12]) {
		const lines = render(screenState(data({ tabs: [many], thisSession: {} })), 40, identity, rows);
		assert.equal(lines.length, rows, `rows ${rows}`);
		assert.equal(lines.at(-1), truncateToWidth(` ${FOOTER}`, 40));
	}
});

// --- S20 / S18 keys ----------------------------------------------------------------------

test("S20 p in the members view returns a clean-up action for the selected team", () => {
	assert.deepEqual(keys(screenState(data()), "p").action, { type: "prune", team: "tienda-online" });
	assert.equal(keys(screenState(data()), "r", "p").action, undefined, "only in the members view");
	assert.equal(keys(screenState(data({ tabs: [], thisSession: {} })), "p").action, undefined);
});

test("S18 a change this member sent and the recipient has not decided can be decided on its behalf with a / d", () => {
	const sent: RequestRow = { ...change, from: "backend", to: "frontend", onBehalfOf: "frontend" };
	const state = keys(screenState(data({ tabs: [{ ...tienda, requests: [sent] }] })), "r").state;
	const lines = render(state, 120, identity);
	assert.ok(lines.some((line) => line.endsWith("requested · awaiting frontend, a/d on its behalf")), lines.join("\n"));
	assert.ok(lines.at(-1)!.includes("a accept  d decline"));
	assert.deepEqual(keys(state, "a").action, { type: "decide", team: "tienda-online", requestId: CHANGE_ID, choice: "Accept" });
	assert.deepEqual(keys(state, "enter", "d").action, { type: "decide", team: "tienda-online", requestId: CHANGE_ID, choice: "Decline" });
	assert.ok(render(keys(state, "enter").state, 120, identity)[3]!.endsWith("· awaiting frontend, a/d on its behalf"));
});

// --- correction round: D2, D3, D4 --------------------------------------------------------

test("D3 the members footer fits 80 columns, esc close included", () => {
	const lines = render(screenState(data()), 80, identity, 24);
	assert.equal(lines.at(-1), ` ${FOOTER}`, "not cut");
	assert.ok(visibleWidth(lines.at(-1)!) <= 80);
	assert.ok(lines.at(-1)!.endsWith("esc close"));
	assert.ok(render(screenState(data()), 80, identity).includes(` ${FOOTER}`));
});

const longHistory: RequestRow = {
	...question,
	events: Array.from({ length: 30 }, (_, i) => ({ seq: i, actor: "frontend", role: "recipient", transition: "comment", summary: `note ${i}`, at: "2026-11-04T12:00:00.000Z" })),
};

test("D2 the history view scrolls: ↑↓ move through events and the last one is reachable at 24 and 12 rows", () => {
	const open = keys(screenState(data({ tabs: [{ ...tienda, requests: [longHistory] }] })), "r", "enter").state;
	for (const rows of [24, 12]) {
		const top = render(open, 90, identity, rows);
		assert.equal(top.length, rows);
		assert.ok(top.some((line) => line.startsWith("› #0 ")), `rows ${rows}: the first event is selected`);
		assert.ok(top.some((line) => /^ {2}↓ \d+ more$/.test(line)), `rows ${rows}: more below`);
		assert.equal(top.at(-1), " ↑↓ event  esc back");

		const middle = render(keys(open, ...Array(15).fill("down")).state, 90, identity, rows);
		assert.ok(middle.some((line) => line.startsWith("› #15 ")));
		assert.ok(middle.some((line) => /^ {2}↑ \d+ more$/.test(line)));

		const end = render(keys(open, ...Array(40).fill("down")).state, 90, identity, rows);
		assert.ok(end.some((line) => line.startsWith("› #29 ")), `rows ${rows}: the last event is reachable`);
		assert.ok(!end.some((line) => /↓ \d+ more/.test(line)), "nothing below the last event");
		assert.ok(end.some((line) => /^ {2}↑ \d+ more$/.test(line)));
		const back = render(keys(open, ...Array(40).fill("down"), ...Array(40).fill("up")).state, 90, identity, rows);
		assert.ok(back.some((line) => line.startsWith("› #0 ")), "↑ goes back to the first event");
	}
	assert.equal(keys(open, "down", "escape").state.view, "requests", "esc still goes back");
	assert.equal(keys(keys(open, "down", "down", "escape").state, "enter").state.event ?? 0, 0, "reopening a history starts at its first event");
});

test("D4 at small row counts a member row stays visible: description and blank lines go first", () => {
	for (const rows of [7, 8, 10]) {
		const lines = render(screenState(data({ tabs: [many], thisSession: {} })), 40, identity, rows);
		assert.equal(lines.length, rows);
		assert.ok(lines.some((line) => line.startsWith("› m00")), `rows ${rows}: ${JSON.stringify(lines)}`);
		assert.equal(lines.at(-1), truncateToWidth(` ${FOOTER}`, 40));
	}
	const seven = render(screenState(data({ tabs: [many], thisSession: {} })), 90, identity, 7);
	assert.ok(!seven.some((line) => line.includes("Frontend + backend")), "the description is dropped");
	assert.ok(seven.some((line) => line.includes("This session")), "the session row stays");
	const roomy = render(screenState(data({ tabs: [many], thisSession: {} })), 90, identity, 24);
	assert.ok(roomy.some((line) => line.includes("Frontend + backend")), "kept when there is room");
});
