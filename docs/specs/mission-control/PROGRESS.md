# Mission Control build — progress / resume state

Branch: `mission-control` off main (base `791f6ae`, spec commit atop `302d183`).
Orchestrator: Fable (architect only); execution via parallel Opus 5 subagents.

## Current phase

**Phase 2 — Agent session tracking** (dispatching, 2026-08-09).

Phase 1 COMPLETE: control-plane server (181 tests), `ade` CLI (82 tests),
renderer bridge (40 tests), agent-setup bin injection (58 tests), all
verified independently; desktop failures identical to baseline (22, all
pre-existing in static-ports/loader.test.ts). Notable:

- Reads bypass renderer (main's app-state mirror incl. layout); bridge =
  mutations only. Focused workspace = window URL.
- send-key: CLI pre-encodes (`data`), server prefers it; 112-case
  cross-package contract test pins both key tables (dep edge
  @ade/cli → control-plane devDeps, 1-line lockfile delta).
- Real bug found+fixed: bridge originally split at layout ROOT always;
  now path-based split + swap-at-path (identity-preserving).
- Divergences (accepted, for build report): browser new-pane = new tab
  (split-in action deferred to Phase 5); --command on splits → UNSUPPORTED;
  new-workspace routes via renderer tRPC mutation; read-screen/capture-pane
  read persisted scrollback (low fidelity for TUIs) until Phase 2 daemon
  snapshot; ade bin requires bun in dev checkouts (packaged build must ship
  compiled dist entry — Phase 6 item); bin entry-missing exit = 127.
- Desktop tests MUST run from apps/desktop cwd or they error spuriously.

Phase 0 was committed at `b611c0e` (probe: agent-teams flag LIVE).

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
- Phase 6 smoke must confirm: (a) the PTY-level `stty size` snapshot test in
  terminal-host/snapshot.test.ts (gated on a beforeAll probe; did NOT run in
  the build worktree — PTY writes EBADF there) runs on a normal machine;
  (b) `ade read-screen` on a live pane reports `source: "live-screen"`.
- Phase 6 packaging must ship a compiled Node-runnable CLI entry
  (dist/index.mjs or resources/cli/index.mjs) — the dev `ade` bin requires
  bun otherwise.

## Resume notes

If resuming cold: read SPEC.md (contract), PROTOCOL.md (wire schema),
RECON-HEAD.md (verified file:line at HEAD), probe/PROBE-CONTRACT.md
(tmux-compat contract). Phases 1–6 per SPEC "Phases" section; commit at
every phase boundary.
