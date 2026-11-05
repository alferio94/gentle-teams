# Changelog

## [0.1.2] - 2026-11-05

- A new animated banner for the README: the windows slide in, the connections draw
  themselves, messages travel between the repositories, and the approval check appears.
  Pure SVG and CSS, 12 KB; it shows the complete banner when reduced motion is preferred.

## [0.1.1] - 2026-11-05

- A banner for the project: an animated header in the README and a static image
  (`pi.image` in package.json) for package galleries such as Gentle Hub.

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
