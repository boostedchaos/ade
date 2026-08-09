# Changelog

Notable changes to ADE. Releases before 0.4.0 were recorded only as GitHub
release notes — see the [releases page](https://github.com/boostedchaos/ade/releases).

## 0.4.0 — unreleased

### Added

- **`ade` command line (Mission Control).** A local command line that drives the
  running app: create, split, move, focus and close panes; type into terminals
  and read their screens; manage workspaces, tabs, todos and notifications; and
  stream app events as NDJSON. Every terminal pane ADE starts already has `ade`
  on its PATH; `ade cli install` puts it on yours. Full guide:
  [`docs/mission-control.md`](docs/mission-control.md).
- **Agent session tracking.** ADE now knows whether the agent in each terminal
  pane is working, waiting on you, or idle. It learns this from Claude Code
  hooks rather than by reading the screen, and a session stuck in `working` with
  no hook for ten minutes is re-checked against the agent's transcript and
  corrected. `ade hooks setup claude` wires it up; `ade agent-sessions` lists it.
- **Attention notifications.** The pane that needs you gets a ring, with unread
  counts on its tab, its workspace in the rail, and the Dock icon. A
  notifications panel lists them newest first, and `ade jump-to-unread` cycles
  focus through the panes that are waiting. Badges clear when the agent stops
  waiting. Agents without hooks can raise the same attention with
  `ade set-status needsInput`.
- **Workspace todos and pane progress bars.** `ade todo add|list|start|done|rm`
  keeps a per-workspace list that survives restarts, and `ade set-progress`
  draws a progress bar on an agent's pane.
- **Browser pane scripting.** `ade browser open|navigate|click|type|fill|
  screenshot|info|capabilities` drives a browser pane from the command line.
  `fill` stops at the first field it cannot find and reports how many it filled,
  so a half-filled form never reports success.
- **`ade claude-teams` — EXPERIMENTAL.** Launches Claude Code with its agent
  teams feature so teammate agents appear as real ADE panes. Agent teams is an
  undocumented Claude Code feature behind a server-side kill switch, so
  teammates may never spawn even when the command works; it also needs a real
  TTY. macOS only — Windows exits 2.
- **Bundled `ade-workspace` skill**, installed to `~/.ade/skills/` and copied
  into each ADE-managed agent, teaching agents the CLI patterns that do not
  steal your focus. Known gap: a plain `claude` session in a workspace terminal
  will not discover it, because ADE does not write into `~/.claude/`.

### Fixed

- **Packaged builds shipped without the agent hook templates.** The resource
  copy step pointed at a path the templates had moved out of, and it silently
  did nothing when the source was missing — so 0.3.0's packaged app threw while
  setting up agent hooks, which also aborted before the `ade` bin and the
  bundled skill were installed. The path is corrected and the copy step now
  fails the build loudly instead of skipping a missing source.
- Packaged builds now include the compiled `ade` CLI entry and the bundled
  `skills/` directory as app resources; without them the packaged app looked for
  a repo checkout that does not exist in a bundle, and agents got no `ade`.
- The `tmux-compat` store directory now honours the workspace suffix, so a
  suffixed workspace no longer shares state with the default one.
