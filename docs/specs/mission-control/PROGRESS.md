# Mission Control build — progress / resume state

Branch: `mission-control` off main (base `791f6ae`, spec commit atop `302d183`).
Orchestrator: Fable (architect only); execution via parallel Opus 5 subagents.

## Current phase

**Phase 1 — Control plane + CLI core** (dispatching, 2026-08-09).
Phase 0 complete except probe (still running; only gates Phase 4).

- [x] Branch created, base verified (`302d183` is ancestor of HEAD)
- [x] Socket schema + amendments → `PROTOCOL.md` (this dir)
- [x] Ground truth re-verified at HEAD: 26/26 CONFIRMED, 0 drift → `RECON-HEAD.md`
- [x] Package scaffolds `@ade/control-plane`, `@ade/cli` (bun install clean, no lockfile change)
- [x] Agent-teams probe DONE — flag LIVE in 2.1.226, real contract captured →
      `probe/PROBE-CONTRACT.md` + raw `probe/tmux-calls.log`

Probe findings that re-scope Phase 4 (tmux-compat):

- Command channel is `set-option -p -t %N remain-on-exit failed` +
  `respawn-pane -k -t %N -- '<shell string>'` on a pane born running `cat`.
  send-keys and capture-pane are NEVER called; stdin never written; nothing
  polls. Teardown = kill-pane only. **respawn-pane (replace process, keep
  paneId) is the load-bearing verb.**
- Verbs used: display-message, list-panes, split-window, set-option,
  select-pane, respawn-pane, kill-pane, has-session, new-session, -V,
  show/show-environment. Format strings read: `#{pane_id}`, `#{window_id}`,
  `#{window_name}`, `#{session_name}:#{window_id}.#{pane_id}`.
- Launcher must pass `--teammate-mode tmux` (default is in-process even with
  the env var) and needs a real PTY (headless -p forces in-process).
  `CLAUDE_CODE_TEAMMATE_COMMAND` is a clean interpose seam.
  Server-side kill switch exists (`tengu_amber_flint`) → keep launcher
  marked experimental.

Key design amendments from recon (detail in PROTOCOL.md):

- Feature 2 = extend existing hook pipeline (`~/.ade/hooks/claude-settings.json`
  - `--settings` + notification server + useAgentHookListener); NO
  ~/.claude/settings.json merge. SUPERSET_PANE_ID stays; ADE_SURFACE_ID aliased.
- Control token per-launch (unconditional write); auth via wrapper middleware.
- Phase 1 must verify main's tabsState mirror — reads may skip renderer bridge.
- Phase 6 note: docs/releasing-mac.md wants SUPERSET_WORKSPACE_NAME unset for
  public artifacts; spec gate 6 bakes `default`. Two artifacts/two purposes —
  state which was produced, don't reconcile.

## Agent assignments

| Agent | Task | Output |
|---|---|---|
| recon | Re-verify spec ground truth at HEAD + extract socket/PATH/IPC/test/build patterns | docs/specs/mission-control/RECON-HEAD.md |
| probe | Static+dynamic agent-teams tmux vocabulary capture | docs/specs/mission-control/probe/ |

## Open items

- Hybrid harness clause: decide after probe whether one mechanical lane runs via agent teams.

## Resume notes

If resuming cold: read SPEC.md (contract), PROTOCOL.md (wire schema),
RECON-HEAD.md (verified file:line at HEAD), probe/PROBE-CONTRACT.md
(tmux-compat contract). Phases 1–6 per SPEC "Phases" section; commit at
every phase boundary.
