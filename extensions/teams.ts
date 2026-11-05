/**
 * gentle-teams extension: thin wiring of Pi events to lib/session.ts, the agent
 * tools (lib/tools.ts), read-only question mode (lib/question-mode.ts), and the
 * `/teams` command (lib/teams-command.ts).
 *
 * S15-S17: a tool call question mode would block asks the human in both terminals
 * (session.askApproval); configured read-only tools (lib/config.ts) run without asking.
 * S19: /teams is a full-screen overlay sized to the terminal (public ctx.ui.custom
 * overlay options and `tui.terminal.rows`). S20: the configured cleanup age reaches the
 * session (cleanup at bind) and the screen (`p`).
 */

import { homedir } from "node:os";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { DEFAULT_PRUNE_DAYS, DEFAULT_READ_ONLY_TOOLS, loadConfig } from "../lib/config.ts";
import { PEER_MESSAGE_TYPE } from "../lib/delivery.ts";
import { migrateLegacyWorkspaces, migrationMessage } from "../lib/migrate.ts";
import { openPresence } from "../lib/presence.ts";
import { attachQuestionMode, createQuestionMode, type QuestionModeEvents } from "../lib/question-mode.ts";
import { createTeamSession, gitRoot, type TeamSession } from "../lib/session.ts";
import { defaultRoot, openStore } from "../lib/store.ts";
import { createAgentTools } from "../lib/tools.ts";
import type { ScreenTheme } from "../lib/ui/teams-screen.ts";
import { attachGentleShellRail, type RailAttachment } from "../lib/ui/gentle-shell-rail.ts";
import { renderTeamPanel } from "../lib/ui/team-panel.ts";
import type { TeamSnapshot, StatusTheme } from "../lib/team-status.ts";
import { createScreenComponent, runTeamsCommand, type ScreenResult } from "../lib/teams-command.ts";

export interface TeamsExtensionOptions {
	/** Store and config root; defaults to ~/.pi/multiagent. */
	root?: string;
}

export function createTeamsExtension(options: TeamsExtensionOptions = {}): (pi: ExtensionAPI) => void {
	const root = options.root ?? defaultRoot();
	return (pi) => teams(pi, root);
}

export default createTeamsExtension();

function teams(pi: ExtensionAPI, root: string): void {
	let session: TeamSession | undefined;
	let rail: RailAttachment | undefined;
	let snapshot: TeamSnapshot | undefined;
	let finishUi: (() => void) | undefined;
	let theme: StatusTheme | undefined;
	let attachPanel: (() => void) | undefined;
	// openStore only resolves paths; nothing touches the filesystem until a call.
	const store = openStore(root);
	// S17: defaults until session_start reads the config file.
	const questionMode = createQuestionMode({ readOnlyTools: DEFAULT_READ_ONLY_TOOLS });
	let pruneClosedAfterDays = DEFAULT_PRUNE_DAYS;

	// Registered at load so the model sees the tools in every session; each call reads
	// the current binding and fails with `not-bound` when there is none (S11).
	for (const tool of createAgentTools({
		store,
		binding: () => session?.binding,
		onUpdated: (requestId, transition) => questionMode.answered(requestId, transition),
	})) {
		pi.registerTool(tool as unknown as Parameters<ExtensionAPI["registerTool"]>[0]);
	}

	// S12/S15: while answering a peer question, a non-read-only tool asks the human
	// (this terminal and the requester's) and waits; only plugin dialogs answer.
	attachQuestionMode(pi as unknown as QuestionModeEvents, questionMode, async (requestId, call, ctx) => {
		const current = session;
		if (!current) return "no-human";
		const signal = (ctx as { signal?: AbortSignal } | undefined)?.signal;
		return current.askApproval({ requestId, toolName: call.toolName, input: call.input, ...(signal ? { signal } : {}) });
	});

	// S13-S14: the /teams screen. Presence is read-only here (status only).
	const presence = openPresence(store);
	pi.registerCommand("teams", {
		description: "Create, join, and leave teams; review and decide requests",
		handler: async (_args, ctx) => {
			const mode = (ctx as { mode?: string }).mode;
			await runTeamsCommand({
				store,
				presence,
				session: () => session,
				cwd: ctx.cwd,
				home: homedir(),
				// ctx.ui.custom() needs the TUI; RPC, JSON, and print modes cannot show the screen.
				interactive: ctx.hasUI && (mode === undefined || mode === "tui"),
				ui: {
					input: (title, placeholder) => ctx.ui.input(title, placeholder),
					confirm: (title, message) => ctx.ui.confirm(title, message),
					notify: (message, level) => ctx.ui.notify(message, level),
				},
				resolveGitRoot: gitRoot,
				pruneClosedAfterDays,
				show: (state) =>
					ctx.ui.custom<ScreenResult | undefined>(
						(tui, theme, keybindings, done) =>
							createScreenComponent(state, theme as unknown as ScreenTheme, keybindings, () => tui.requestRender(), done, () =>
								Math.max(1, tui.terminal.rows),
							),
						// Full screen like /gentle:profiles: an overlay as wide and tall as the terminal.
						{ overlay: true, overlayOptions: { anchor: "center", width: "100%", maxHeight: "100%", margin: 0 } },
					),
			});
		},
	});

	pi.on("session_start", async (_event, ctx) => {
		await session?.shutdown();
		questionMode.reset();
		const config = await loadConfig(root);
		questionMode.setReadOnlyTools(config.readOnlyTools);
		pruneClosedAfterDays = config.pruneClosedAfterDays;
		if (ctx.hasUI) for (const warning of config.warnings ?? []) ctx.ui.notify(warning, "warning");
		// S22: move data written by the previous version (pi-workspaces) before binding.
		try {
			const message = migrationMessage(await migrateLegacyWorkspaces(root), root);
			if (message && ctx.hasUI) ctx.ui.notify(message.text, message.level);
		} catch (error) {
			if (ctx.hasUI) ctx.ui.notify(`teams: migration from the previous version failed; the original data was not modified: ${error instanceof Error ? error.message : String(error)}`, "error");
		}
		if (ctx.hasUI && ctx.mode === "tui") {
			void ctx.ui.custom<void>((tui, activeTheme, _keys, done) => {
				theme = activeTheme;
				finishUi = () => done(undefined);
				const panel = { render: (width: number) => snapshot ? renderTeamPanel(snapshot, activeTheme, width) : [], invalidate() {}, digest: () => JSON.stringify(snapshot) };
				attachPanel = () => { if (!rail && snapshot) rail = attachGentleShellRail(tui, panel); };
				return { render: () => [], invalidate() {} };
			}, { overlay: true, overlayOptions: { nonCapturing: true, visible: () => false } }).catch(() => {});
		}
		const current = createTeamSession({
			store,
			onSnapshot: (next) => { snapshot = next; if (next) { attachPanel?.(); rail?.invalidate(); } else { rail?.dispose(); rail = undefined; } },
			isPanelActive: () => rail?.isActive() ?? false,
			statusTheme: () => theme,
			sessionId: ctx.sessionManager.getSessionId(),
			pid: process.pid,
			// Peer content only ever reaches the model as a custom message (S9).
			sendMessage: (message, options) => pi.sendMessage(message, options),
			hasDelivery: (id) => ctx.sessionManager.getEntries().some((entry) =>
				entry.type === "custom_message" && entry.customType === PEER_MESSAGE_TYPE &&
				(entry.details as { deliveryId?: unknown } | undefined)?.deliveryId === id),
			ui: ctx.hasUI
				? {
						select: (title, options, opts) => ctx.ui.select(title, options, opts),
						notify: (message, level) => ctx.ui.notify(message, level),
						setStatus: (key, text) => ctx.ui.setStatus(key, text),
					}
				: undefined,
			resolveGitRoot: gitRoot,
			pruneClosedAfterDays,
		});
		session = current;
		// Do not block startup on the binding prompt.
		void current.start(ctx.cwd).catch((error: unknown) => {
			if (ctx.hasUI) ctx.ui.notify(`teams: ${error instanceof Error ? error.message : String(error)}`, "error");
		});
	});

	pi.on("agent_start", async () => {
		await session?.agentStart();
	});

	pi.on("agent_end", async () => {
		await session?.agentEnd();
	});

	pi.on("session_shutdown", async () => {
		const current = session;
		session = undefined;
		questionMode.reset();
		await current?.shutdown();
		rail?.dispose(); rail = undefined;
		finishUi?.(); finishUi = undefined; attachPanel = undefined; theme = undefined; snapshot = undefined;
	});
}
