# Changelog

## [0.1.0] - 2026-11-04

First release.

- Named teams of independent per-repository Pi sessions: `/teams` full-screen screen to
  create, join, and leave teams and to review and decide requests.
- Requests between members (`question`, `change`) with a strict lifecycle, dependencies
  without wait cycles, and four agent tools (`multiagent_status`, `multiagent_request`,
  `multiagent_inbox`, `multiagent_update`).
- Peer messages delivered as untrusted data, waking an idle session; the model is never
  told the same event twice within a Pi session.
- Change requests need a human decision; answering a question is read-only, and any other
  tool call asks the human in both terminals (first answer wins).
- Presence (active, idle, offline) and team status entries in Gentle Shell's Integrations
  panel or Pi's footer.
- Automatic and manual cleanup of closed requests older than 7 days (configurable).
- Migration of data written by the previous name, `pi-workspaces`, with a kept backup.
