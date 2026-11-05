import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openStore, type Store } from "../lib/store.ts";
import { openPresence } from "../lib/presence.ts";
import { createTeamSession, type PeerMessage, type SendOptions, type TeamSession } from "../lib/session.ts";
import { handleKey, render, type ScreenAction, type ScreenState } from "../lib/ui/teams-screen.ts";
import {
	NEEDS_INTERACTIVE,
	NOT_IN_GIT,
	createScreenComponent,
	decodeKey,
	defaultAlias,
	runTeamsCommand,
	type TeamsCommandPorts,
} from "../lib/teams-command.ts";

const T0 = Date.parse("2026-11-04T12:00:00.000Z");
const WS = "tienda-online";
const FRONT = "/repos/front";
const BACK = "/repos/back";
const identity = { fg: (_c: string, t: string) => t, bold: (t: string) => t };

interface Harness {
	store: Store;
	root: string;
	session: TeamSession;
	sent: { message: PeerMessage; options: SendOptions }[];
	inputs: { title: string; placeholder?: string }[];
	inputAnswers: (string | undefined)[];
	confirms: { title: string; message: string }[];
	confirmAnswers: boolean[];
	notes: { message: string; level: string }[];
	selectAnswers: (string | undefined)[];
	/** Each screen opening consumes one key list; the screen closes when the script runs out. */
	script: string[][];
	shown: ScreenState[];
	ports(overrides?: Partial<TeamsCommandPorts>): TeamsCommandPorts;
	/** Every stored file under the store root, with content: proves "nothing written". */
	snapshot(): Promise<string>;
	done(): Promise<void>;
}

async function harness(): Promise<Harness> {
	const base = await mkdtemp(join(tmpdir(), "gentle-teams-command-"));
	const root = join(base, "multiagent");
	const store = openStore(root);
	const h = {} as Harness;
	Object.assign(h, {
		store,
		root,
		sent: [],
		inputs: [],
		inputAnswers: [],
		confirms: [],
		confirmAnswers: [],
		notes: [],
		selectAnswers: [],
		script: [],
		shown: [],
	});
	h.session = createTeamSession({
		store,
		decisions: new Map(),
		sessionId: "sess-back",
		pid: process.pid,
		now: () => T0,
		sendMessage: (message, options) => void h.sent.push({ message, options }),
		ui: {
			select: async () => h.selectAnswers.shift() ?? "Later",
			notify: (message, level) => void h.notes.push({ message, level }),
			setStatus: () => undefined,
		},
		resolveGitRoot: async (cwd) => (cwd.startsWith("/repos/") ? cwd : undefined),
		watch: () => ({ stop: () => undefined }),
		every: () => () => undefined,
	});
	h.ports = (overrides = {}) => ({
		store,
		presence: openPresence(store, { now: () => T0 }),
		session: () => h.session,
		cwd: BACK,
		home: "/Users/me",
		interactive: true,
		ui: {
			input: async (title, placeholder) => {
				h.inputs.push({ title, placeholder });
				return h.inputAnswers.shift();
			},
			confirm: async (title, message) => {
				h.confirms.push({ title, message });
				return h.confirmAnswers.shift() ?? false;
			},
			notify: (message, level) => void h.notes.push({ message, level }),
		},
		resolveGitRoot: async (cwd) => (cwd.startsWith("/repos/") ? cwd : undefined),
		show: async (state) => {
			h.shown.push(state);
			// Every opened screen must render within the width.
			for (const line of render(state, 60, identity)) assert.ok([...line].length <= 60, line);
			const keys = h.script.shift();
			if (!keys) return { action: { type: "close" }, state };
			let current = state;
			for (const key of keys) {
				const result = handleKey(current, key);
				current = result.state;
				if (result.action) return { action: result.action, state: current };
			}
			return { action: { type: "close" } as ScreenAction, state: current };
		},
		...overrides,
	});
	h.snapshot = async () => {
		const files: string[] = [];
		const walk = async (dir: string): Promise<void> => {
			for (const entry of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
				const path = join(dir, entry.name);
				if (entry.isDirectory()) await walk(path);
				else files.push(`${path.slice(root.length)}=${await readFile(path, "utf8")}`);
			}
		};
		await walk(root);
		return files.sort().join("\n");
	};
	h.done = async () => {
		await h.session.shutdown();
		await rm(base, { recursive: true, force: true });
	};
	return h;
}

async function withMembers(h: Harness): Promise<void> {
	await h.store.createTeam({ name: WS, description: "Store" });
	await h.store.joinMember(WS, { alias: "frontend", repositoryRoot: FRONT });
	await h.store.joinMember(WS, { alias: "backend", repositoryRoot: BACK });
}

const presenceFile = (h: Harness, ws: string, alias: string) => join(h.root, "teams", ws, "presence", `${alias}.json`);
const exists = (path: string) => readFile(path).then(() => true, () => false);
const lastFeedback = (h: Harness) => h.shown.at(-1)?.feedback;

test("S13 without interactive UI the command says so and changes nothing", async () => {
	const h = await harness();
	try {
		await withMembers(h);
		const before = await h.snapshot();
		let shows = 0;
		await runTeamsCommand(h.ports({ interactive: false, show: async () => (shows++, undefined) }));
		assert.equal(NEEDS_INTERACTIVE, "/teams requires interactive mode.");
		assert.deepEqual(h.notes, [{ message: NEEDS_INTERACTIVE, level: "error" }]);
		assert.equal(shows, 0);
		assert.equal(await h.snapshot(), before);
	} finally {
		await h.done();
	}
});

test("S13 the screen shows teams with presence states and request counts from the store", async () => {
	const h = await harness();
	try {
		await withMembers(h);
		await h.store.createRequest(WS, { from: "frontend", to: "backend", kind: "change", title: "Add", body: "" });
		const q = await h.store.createRequest(WS, { from: "backend", to: "frontend", kind: "change", title: "Q", body: "" });
		await h.store.appendEvent(WS, q.id, { actor: "frontend", transition: "accept" });
		await openPresence(h.store, { now: () => T0 }).claim(WS, "frontend", { sessionId: "other", state: "active" });
		await runTeamsCommand(h.ports());
		const [state] = h.shown;
		assert.equal(state!.tabs.length, 1);
		const tab = state!.tabs[0]!;
		assert.equal(tab.live, true);
		assert.equal(tab.bound, false);
		assert.deepEqual(
			tab.members.map((m) => [m.alias, m.state, m.requests]),
			[
				["backend", "offline", "1 waiting"],
				["frontend", "active", "1 in progress"],
			],
		);
		assert.deepEqual(state!.thisSession, { gitRoot: BACK });
	} finally {
		await h.done();
	}
});

test("S14 n creates a team and reopens on it", async () => {
	const h = await harness();
	try {
		h.script = [["n"]];
		h.inputAnswers = ["tienda-online", "Frontend + backend"];
		await runTeamsCommand(h.ports());
		assert.deepEqual(await h.store.getTeam(WS).then((w) => [w.name, w.description]), [WS, "Frontend + backend"]);
		assert.equal(h.shown.length, 2);
		assert.equal(h.shown[1]!.tabs[h.shown[1]!.tab]!.name, WS);
		assert.deepEqual(lastFeedback(h), { text: 'Created team "tienda-online". Press j to join it with this repository.', level: "info" });
	} finally {
		await h.done();
	}
});

test("S14 n with an invalid name shows the store error verbatim and writes nothing; cancel writes nothing", async () => {
	const h = await harness();
	try {
		const before = await h.snapshot();
		h.script = [["n"], ["n"]];
		h.inputAnswers = ["Bad Name", "", undefined];
		await runTeamsCommand(h.ports());
		assert.deepEqual(h.shown[1]!.feedback, {
			text: 'invalid-name: Team name "Bad Name" is invalid: use 1-64 lowercase letters, digits, or hyphens, starting with a letter or digit.',
			level: "error",
		});
		assert.deepEqual(h.shown[2]!.feedback, { text: "New team cancelled; nothing changed.", level: "info" });
		assert.deepEqual(await h.store.listTeams(), []);
		assert.equal(await h.snapshot(), before);
	} finally {
		await h.done();
	}
});

test("S14 j outside a Git repository explains why and writes nothing", async () => {
	const h = await harness();
	try {
		await withMembers(h);
		const before = await h.snapshot();
		h.script = [["j"]];
		await runTeamsCommand(h.ports({ cwd: "/tmp/elsewhere" }));
		assert.equal(NOT_IN_GIT, "teams: this session is not inside a Git repository; open it in a repository to join.");
		assert.deepEqual(lastFeedback(h), { text: NOT_IN_GIT, level: "error" });
		assert.deepEqual(h.inputs, []);
		assert.equal(h.session.binding, undefined);
		assert.equal(await h.snapshot(), before);
	} finally {
		await h.done();
	}
});

test("S14 j proposes the repository folder name as alias, joins, and binds this session", async () => {
	const h = await harness();
	try {
		await h.store.createTeam({ name: WS });
		h.script = [["j"]];
		h.inputAnswers = [""]; // accept the proposed alias
		await runTeamsCommand(h.ports({ cwd: "/repos/My_Backend.Repo" }));
		assert.deepEqual(h.inputs, [{ title: 'Join "tienda-online" with this repository as (alias):', placeholder: "my-backend-repo" }]);
		assert.deepEqual((await h.store.listMembers(WS)).map((m) => [m.alias, m.repositoryRoot]), [["my-backend-repo", "/repos/My_Backend.Repo"]]);
		assert.deepEqual(h.session.binding, { team: WS, alias: "my-backend-repo" });
		assert.equal(await exists(presenceFile(h, WS, "my-backend-repo")), true);
		assert.deepEqual(lastFeedback(h), { text: 'Joined "tienda-online" as "my-backend-repo"; this session is bound to it.', level: "info" });
		assert.equal(h.shown.at(-1)!.tabs[0]!.bound, true);
	} finally {
		await h.done();
	}
});

test("S14 default alias is the folder name lowercased and reduced to the alias pattern", () => {
	assert.equal(defaultAlias("/repos/backend"), "backend");
	assert.equal(defaultAlias("/repos/My_Backend.Repo"), "my-backend-repo");
	assert.equal(defaultAlias("/repos/--Ünïcode--"), "n-code");
	assert.equal(defaultAlias("/repos/" + "a".repeat(40)), "a".repeat(32));
	assert.equal(defaultAlias("/repos/___"), "member");
});

test("S14 j with an invalid alias shows the store error and binds nothing", async () => {
	const h = await harness();
	try {
		await h.store.createTeam({ name: WS });
		const before = await h.snapshot();
		h.script = [["j"]];
		h.inputAnswers = ["Bad Alias"];
		await runTeamsCommand(h.ports());
		assert.equal(lastFeedback(h)!.level, "error");
		assert.match(lastFeedback(h)!.text, /^invalid-alias: Alias "Bad Alias" is invalid/);
		assert.equal(h.session.binding, undefined);
		assert.equal(await h.snapshot(), before);
	} finally {
		await h.done();
	}
});

test("S14 j resumes this repository's existing membership without asking for an alias", async () => {
	const h = await harness();
	try {
		await withMembers(h);
		h.script = [["j"]];
		await runTeamsCommand(h.ports());
		assert.deepEqual(h.inputs, []);
		assert.deepEqual((await h.store.listMembers(WS)).map((m) => m.alias), ["backend", "frontend"]);
		assert.deepEqual(h.session.binding, { team: WS, alias: "backend" });
		assert.deepEqual(lastFeedback(h), { text: 'Resumed member "backend" of "tienda-online"; this session is bound to it.', level: "info" });
	} finally {
		await h.done();
	}
});

test("S14 j on a member held by another live session reports member-bound and keeps the current binding", async () => {
	const h = await harness();
	try {
		await withMembers(h);
		await h.store.createTeam({ name: "other" });
		await h.store.joinMember("other", { alias: "backend", repositoryRoot: BACK });
		await openPresence(h.store, { now: () => T0 }).claim(WS, "backend", { sessionId: "someone-else" });
		await h.session.bindTo("other", "backend");
		h.script = [["right", "j"]];
		h.confirmAnswers = [true];
		await runTeamsCommand(h.ports());
		assert.deepEqual(lastFeedback(h), { text: 'member-bound: Member "backend" is bound to another live session.', level: "error" });
		assert.deepEqual(h.session.binding, { team: "other", alias: "backend" });
	} finally {
		await h.done();
	}
});

test("S14 j while bound elsewhere asks to switch first; refusing changes nothing, accepting rebinds", async () => {
	const h = await harness();
	try {
		await withMembers(h);
		await h.store.createTeam({ name: "api-pagos" });
		await h.session.bindTo(WS, "backend");
		const before = await h.snapshot();

		h.script = [["left", "j"]];
		h.inputAnswers = ["back"];
		h.confirmAnswers = [false];
		await runTeamsCommand(h.ports());
		assert.deepEqual(h.confirms, [
			{
				title: "Switch this session's team?",
				message: 'This session is bound to "tienda-online" as "backend". Unbind it and join "api-pagos" as "back"?',
			},
		]);
		assert.deepEqual(lastFeedback(h), { text: "Switch cancelled; nothing changed.", level: "info" });
		assert.deepEqual(h.session.binding, { team: WS, alias: "backend" });
		assert.equal(await h.snapshot(), before);

		h.shown = [];
		h.script = [["left", "j"]];
		h.inputAnswers = ["back"];
		h.confirmAnswers = [true];
		await runTeamsCommand(h.ports());
		assert.deepEqual(h.session.binding, { team: "api-pagos", alias: "back" });
		assert.equal(await exists(presenceFile(h, WS, "backend")), false, "the old member is released");
		assert.equal(await exists(presenceFile(h, "api-pagos", "back")), true);
		assert.equal(h.shown.at(-1)!.tabs[h.shown.at(-1)!.tab]!.name, "api-pagos");
	} finally {
		await h.done();
	}
});

test("S14 l asks for confirmation; cancel keeps the member, confirm removes it and unbinds the bound member", async () => {
	const h = await harness();
	try {
		await withMembers(h);
		await h.session.bindTo(WS, "backend");
		h.script = [["l"], ["l"]];
		h.confirmAnswers = [false, true];
		await runTeamsCommand(h.ports());
		assert.deepEqual(h.confirms[0], {
			title: 'Leave team "tienda-online"?',
			message: 'Remove member "backend" (/repos/back) from "tienda-online". This session is bound to it and will be unbound.',
		});
		assert.deepEqual(h.shown[1]!.feedback, { text: "Leave cancelled; nothing changed.", level: "info" });
		assert.equal(h.confirms.length, 2);
		assert.deepEqual((await h.store.listMembers(WS)).map((m) => m.alias), ["frontend"]);
		assert.equal(h.session.binding, undefined);
		assert.equal(await exists(presenceFile(h, WS, "backend")), false);
		assert.deepEqual(lastFeedback(h), { text: 'Member "backend" left "tienda-online"; this session is no longer bound.', level: "info" });
	} finally {
		await h.done();
	}
});

test("S14 l never removes another repository's member: no confirm, nothing changes", async () => {
	const h = await harness();
	try {
		await withMembers(h);
		const before = await h.snapshot();
		h.script = [["l"]];
		await runTeamsCommand(h.ports({ cwd: "/repos/other" }));
		assert.deepEqual(h.confirms, []);
		const feedback = lastFeedback(h)!;
		assert.equal(feedback.level, "error");
		assert.match(
			feedback.text,
			/^teams: only the session in \/repos\/(back|front) can remove member "(backend|frontend)"; leave from that repository\.$/,
		);
		assert.equal(await h.snapshot(), before);
	} finally {
		await h.done();
	}
});

test("S14 l blocked by open requests shows the store error verbatim and changes nothing", async () => {
	const h = await harness();
	try {
		await withMembers(h);
		const r = await h.store.createRequest(WS, { from: "frontend", to: "backend", kind: "question", title: "Q", body: "" });
		await h.session.bindTo(WS, "backend");
		const before = await h.snapshot();
		h.script = [["l"]];
		h.confirmAnswers = [true];
		await runTeamsCommand(h.ports());
		assert.deepEqual(lastFeedback(h), {
			text: `open-requests: Member "backend" has 1 open request (${r.id}); resolve or cancel them before leaving.`,
			level: "error",
		});
		assert.equal(await h.snapshot(), before);
		assert.deepEqual(h.session.binding, { team: WS, alias: "backend" });
	} finally {
		await h.done();
	}
});

test("S14 a in the requests view accepts a pending change like the S8 prompt: event as recipient, then the model is told", async () => {
	const h = await harness();
	try {
		await withMembers(h);
		const c = await h.store.createRequest(WS, { from: "frontend", to: "backend", kind: "change", title: "Add", body: "B" });
		h.selectAnswers = ["Later"];
		await h.session.bindTo(WS, "backend");
		assert.deepEqual([...h.sent], [], "deferred with later");
		h.script = [["r", "a"]];
		await runTeamsCommand(h.ports());
		const view = await h.store.readRequest(WS, c.id);
		assert.equal(view.state, "accepted");
		assert.deepEqual(view.events.map((e) => [e.actor, e.role, e.transition, e.summary]), [
			["backend", "recipient", "accept", "Accepted by the human in the recipient session."],
		]);
		assert.deepEqual(h.sent.map((s) => [s.message.details.requestId, s.message.details.delivery, s.options]), [
			[c.id, "incoming-change", { deliverAs: "followUp", triggerTurn: true }],
		]);
		assert.deepEqual(JSON.parse(await readFile(join(h.root, "teams", WS, "cursors", "backend.json"), "utf8")), { version: 1, seen: { [c.id]: 1 } });
		const reopened = h.shown.at(-1)!;
		assert.equal(reopened.view, "requests");
		assert.deepEqual(reopened.feedback, { text: `Accepted request ${c.id}; the model was told.`, level: "info" });
		assert.equal(reopened.tabs[0]!.requests[0]!.decidable, false);
	} finally {
		await h.done();
	}
});

test("S14 d in the requests view declines a pending change and never tells the model", async () => {
	const h = await harness();
	try {
		await withMembers(h);
		const c = await h.store.createRequest(WS, { from: "frontend", to: "backend", kind: "change", title: "Add", body: "B" });
		await h.session.bindTo(WS, "backend");
		h.script = [["r", "enter", "d"]];
		await runTeamsCommand(h.ports());
		const view = await h.store.readRequest(WS, c.id);
		assert.equal(view.state, "declined");
		assert.deepEqual(view.events.map((e) => [e.actor, e.transition]), [["backend", "decline"]]);
		assert.deepEqual(h.sent, []);
		assert.deepEqual(lastFeedback(h), { text: `Declined request ${c.id}.`, level: "info" });
	} finally {
		await h.done();
	}
});

test("S14 a change the requester cancelled meanwhile cannot be accepted; the error is shown and nothing is told", async () => {
	const h = await harness();
	try {
		await withMembers(h);
		const c = await h.store.createRequest(WS, { from: "frontend", to: "backend", kind: "change", title: "Add", body: "B" });
		await h.session.bindTo(WS, "backend");
		h.script = [["r"]];
		let opened = 0;
		const ports = h.ports();
		await runTeamsCommand({
			...ports,
			show: async (state) => {
				if (opened++ === 0) {
					await h.store.appendEvent(WS, c.id, { actor: "frontend", transition: "cancel" });
					return { action: { type: "decide", team: WS, requestId: c.id, choice: "Accept" }, state: handleKey(state, "r").state };
				}
				return ports.show(state);
			},
		});
		assert.deepEqual(h.sent, []);
		assert.deepEqual(lastFeedback(h), {
			text: `not-decidable: Request ${c.id} is not a change request awaiting this member's decision (state "cancelled").`,
			level: "error",
		});
		assert.deepEqual((await h.store.readRequest(WS, c.id)).events.map((e) => e.transition), ["cancel"]);
	} finally {
		await h.done();
	}
});

test("S13 keys decode from raw terminal input and drive the component until an action", () => {
	assert.equal(decodeKey("\x1b[D"), "left");
	assert.equal(decodeKey("\x1b[C"), "right");
	assert.equal(decodeKey("\x1b[A"), "up");
	assert.equal(decodeKey("\x1b[B"), "down");
	assert.equal(decodeKey("\r"), "enter");
	assert.equal(decodeKey("\x1b"), "escape");
	assert.equal(decodeKey("\x1b[27u"), "escape");
	assert.equal(decodeKey("\x03"), "close");
	assert.equal(decodeKey("j"), "j");
	assert.equal(decodeKey("\x1b[106u"), "j");
	assert.equal(decodeKey("\x1b[106;1:3u"), undefined, "key release");
	const kb = { matches: (data: string, id: string) => data === "\x0e" && id === "tui.select.down" };
	assert.equal(decodeKey("\x0e", kb), "down");

	const results: { action: ScreenAction; state: ScreenState }[] = [];
	let renders = 0;
	const state: ScreenState = { tabs: [], thisSession: {}, tab: 0, member: 0, view: "members", request: 0 };
	const component = createScreenComponent(state, identity, undefined, () => void renders++, (r) => void results.push(r));
	assert.deepEqual(component.render(40), render(state, 40, identity));
	component.handleInput("x");
	assert.equal(results.length, 0);
	assert.equal(renders, 1);
	component.handleInput("n");
	assert.deepEqual(results.map((r) => r.action), [{ type: "new" }]);
});

test("S13 the screen reopens after each action until it is closed", async () => {
	const h = await harness();
	try {
		await withMembers(h);
		h.script = [["r", "escape", "n"], ["escape"], ["n"]];
		h.inputAnswers = [undefined];
		await runTeamsCommand(h.ports());
		assert.equal(h.shown.length, 2, "esc closes; nothing after it opens");
		assert.equal(h.shown[1]!.view, "members");
	} finally {
		await h.done();
	}
});

// --- S18: the requester decides on the recipient's behalf -------------------------------

test("S18 a in the requests view accepts, on the recipient's behalf, a change this member sent", async () => {
	const h = await harness();
	try {
		await withMembers(h);
		await h.session.bindTo(WS, "backend");
		const c = await h.store.createRequest(WS, { from: "backend", to: "frontend", kind: "change", title: "Add", body: "B" });
		h.script = [["r", "a"]];
		await runTeamsCommand(h.ports());
		assert.equal(h.shown[0]!.tabs[0]!.requests[0]!.decidable, true);
		assert.equal(h.shown[0]!.tabs[0]!.requests[0]!.onBehalfOf, "frontend");
		const view = await h.store.readRequest(WS, c.id);
		assert.deepEqual(view.events.map((e) => [e.actor, e.role, e.transition, e.summary]), [
			["frontend", "recipient", "accept", "Accepted on the recipient's behalf by the human in the requester session."],
		]);
		assert.deepEqual(lastFeedback(h), { text: `Accepted request ${c.id} on behalf of "frontend"; its session tells its model.`, level: "info" });
		assert.equal(h.shown.at(-1)!.tabs[0]!.requests[0]!.decidable, false);
		// D6: this session's human made the accept, so its model is not told it back.
		assert.deepEqual(h.sent, []);
	} finally {
		await h.done();
	}
});

test("S18 d declines on the recipient's behalf; a change between other members is not decidable here", async () => {
	const h = await harness();
	try {
		await withMembers(h);
		await h.store.joinMember(WS, { alias: "admin", repositoryRoot: "/repos/admin" });
		await h.session.bindTo(WS, "backend");
		const c = await h.store.createRequest(WS, { from: "backend", to: "frontend", kind: "change", title: "Add", body: "B" });
		const other = await h.store.createRequest(WS, { from: "admin", to: "frontend", kind: "change", title: "Other", body: "" });
		const sentBefore = h.sent.length;
		h.script = [["r", "enter", "d"]];
		await runTeamsCommand(h.ports());
		assert.deepEqual((await h.store.readRequest(WS, c.id)).events.map((e) => [e.actor, e.transition, e.summary]), [
			["frontend", "decline", "Declined on the recipient's behalf by the human in the requester session."],
		]);
		assert.deepEqual(lastFeedback(h), { text: `Declined request ${c.id} on behalf of "frontend".`, level: "info" });
		assert.equal(h.shown[0]!.tabs[0]!.requests.find((r) => r.id === other.id)!.decidable, false);
		assert.deepEqual((await h.store.readRequest(WS, other.id)).events, []);
		assert.ok(h.sent.length >= sentBefore);
	} finally {
		await h.done();
	}
});

// --- S20: p cleans up -------------------------------------------------------------------

const DAY = 24 * 60 * 60 * 1000;

async function oldClosed(h: Harness, count: number): Promise<string[]> {
	const ids: string[] = [];
	for (let i = 0; i < count; i++) {
		const q = await h.store.createRequest(WS, { from: "frontend", to: "backend", kind: "question", title: `Q${i}`, body: "" });
		await h.store.appendEvent(WS, q.id, { actor: "frontend", transition: "cancel" });
		ids.push(q.id);
	}
	return ids;
}

test("S20 p asks with the exact count; cancel removes nothing", async () => {
	const h = await harness();
	try {
		await withMembers(h);
		await oldClosed(h, 2);
		await h.store.createRequest(WS, { from: "frontend", to: "backend", kind: "question", title: "open", body: "" });
		const before = await h.snapshot();
		h.script = [["p"]];
		h.confirmAnswers = [false];
		await runTeamsCommand(h.ports({ pruneClosedAfterDays: 7, now: () => Date.now() + 8 * DAY }));
		assert.deepEqual(h.confirms, [
			{ title: 'Remove 2 closed requests older than 7 days from "tienda-online"?', message: "Their events and approvals are deleted too. This cannot be undone." },
		]);
		assert.deepEqual(lastFeedback(h), { text: "Clean-up cancelled; nothing changed.", level: "info" });
		assert.equal(await h.snapshot(), before);
	} finally {
		await h.done();
	}
});

test("S20 p confirmed removes exactly the candidates and reports the count", async () => {
	const h = await harness();
	try {
		await withMembers(h);
		const ids = await oldClosed(h, 3);
		const open = await h.store.createRequest(WS, { from: "frontend", to: "backend", kind: "question", title: "open", body: "" });
		h.script = [["p"]];
		h.confirmAnswers = [true];
		await runTeamsCommand(h.ports({ pruneClosedAfterDays: 7, now: () => Date.now() + 8 * DAY }));
		assert.equal(h.confirms[0]!.title, 'Remove 3 closed requests older than 7 days from "tienda-online"?');
		assert.deepEqual(lastFeedback(h), { text: 'Removed 3 closed requests from "tienda-online".', level: "info" });
		assert.deepEqual((await h.store.listRequests(WS)).map((v) => v.record.id), [open.id]);
		const left = await readdir(join(h.root, "teams", WS, "requests"));
		assert.deepEqual(left, [open.id], "no temporary directory left");
		for (const id of ids) assert.equal(left.includes(id), false);
		assert.deepEqual(h.shown.at(-1)!.tabs[0]!.requests.map((r) => r.id), [open.id], "the reopened screen shows what is left");
	} finally {
		await h.done();
	}
});

test("S20 p with nothing to remove shows an info line and asks nothing", async () => {
	const h = await harness();
	try {
		await withMembers(h);
		await oldClosed(h, 1);
		const before = await h.snapshot();
		h.script = [["p"]];
		await runTeamsCommand(h.ports({ pruneClosedAfterDays: 30, now: () => Date.now() + 8 * DAY }));
		assert.deepEqual(h.confirms, []);
		assert.deepEqual(lastFeedback(h), { text: 'No closed requests older than 30 days in "tienda-online"; nothing to remove.', level: "info" });
		assert.equal(await h.snapshot(), before);
	} finally {
		await h.done();
	}
});

test("S19 the screen component renders with the terminal height it is given", () => {
	const state: ScreenState = { tabs: [], thisSession: {}, tab: 0, member: 0, view: "members", request: 0 };
	let rows = 10;
	const component = createScreenComponent(state, identity, undefined, () => undefined, () => undefined, () => rows);
	assert.equal(component.render(40).length, 10);
	rows = 15;
	assert.equal(component.render(40).length, 15, "read at each render, so a resize applies");
	assert.equal(component.render(40).at(-1), " n new  esc close");
	assert.deepEqual(createScreenComponent(state, identity, undefined, () => undefined, () => undefined).render(40), render(state, 40, identity));
});
