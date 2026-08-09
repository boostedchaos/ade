# Mission Control build — progress / resume state

Branch: `mission-control` off main (base `791f6ae`, spec commit atop `302d183`).
Orchestrator: Fable (architect only); execution via parallel Opus 5 subagents.

## Current phase

**Phase 5b — CLI wiring for parity extras** (dispatched to CLI lane, 2026-08-09).

Phase 4 COMPLETE at `a78777e`: tmux-compat translator (per-verb flag tables,
tmux exit codes, fail-soft unknown verbs → ~/.ade/tmux-compat.log),
respawn-pane via `exec /bin/sh -c` into placeholder shell (dead-pane rebuild
path remaps %N), atomic locked compat store (multi-process proven),
claude-teams launcher (darwin-gated, store RESET per launch, --teammate-mode
tmux appended), spawn cap 3→8 w/ ADE_MAX_CONCURRENT_SPAWNS. Golden tests
replay probe/tmux-calls.log with fixture guards; quoting property-tested
through real /bin/sh. Phase 6 smoke: real teammate spawn (TTY required!), no
unknown-verb log entries, teardown/re-respawn/multi-teammate, PACKAGED shim
must not pin dev bun path (ship compiled CLI entry or ADE_CLI_INVOCATION),
kill-switch degradation.

Phase 5a COMPLETE at `71005c5`: workspace_todos + agent_sessions.progress
(one migration 0042, deliberate), todos CRUD (writes RAISE, unlike
attention), browser scripting via browser-manager registry (webview≠browser
naming translated; native-setter typing for React inputs; fill stops at
first failure; screenshots avoid clipboard path; browser-capabilities/info
added), set-status routes through ingestAgentEvent (single authority;
--pane REQUIRED server-side), progress strip absolute-positioned 2px
(null≠0), splitPaneWithType closes the Phase-1 browser-split divergence
(focus:false pinned by identical-plan test), bundled ade-workspace skill
installed from ONE source file (repo skills/ → ~/.ade/skills + agent
scaffold; plain-claude discovery = DOCUMENTED GAP, needs opt-in ~/.claude
write — decide at ship). Thinnest coverage: todos store has no DB unit test
(smoke items 8-9 cover). Phase 6 smoke additions: browser split left/right
from nested pane w/o focus steal; React-form type; screenshot+clipboard
unchanged; ONE toast for set-status needsInput; progress strip no-PTY-resize
(stty before/after); migration 0042 on POPULATED db; todos survive restart;
skill present after boot + in new agent scaffold; skills/ copied into app
resources at packaging. CROSS-LANE HAZARD: stash-based baseline diffs
briefly revert other lanes' uncommitted files — serialize the Phase 6
baseline run (single lane, clean tree).

Earlier:

Phase 3 COMPLETE: notifications table (migration 0041) + attention module in
main (registry-sourced, kind attention|custom, dedupe, auto-read on leaving
needsInput), Dock badge, pane ring (BasePaneWindow + mosaic-theme.css, inset
shadow), tab/rail badges via tRPC query+invalidation, NotificationPanel
popover, jump-to-unread computed in main dispatching existing focus-pane op,
4 CLI commands. 225/111 pass, desktop baseline-diff identical (37).
Divergences: NO second native-toast path for needsInput (NotificationManager
already fires; two toasts otherwise) — gap: needsInput via `ade agent-event`
socket door gets no OS toast (documented in attention/index.ts, decide at
ship); `ade notify` defaults --pane to $ADE_SURFACE_ID.
Phase 6 live-smoke additions: exactly ONE toast per permission request; Dock
badge disappears (not "0") at zero; ring visibly beats focused style both
themes; migration 0041 upgrades a POPULATED db; jump-to-unread cycles+wraps
live; notify-toast click lands on right pane.

Earlier phases:

Phase 2 COMPLETE at `b4eeba7`: env aliases, full hook-event coverage (4 new
events, protocol v3, timestamped backup of ADE's hooks file), AgentSession
registry + `agent_sessions` table (migration 0040), stuck-state transcript
corrector (structurally cannot invent sessions), agent-state-changed events,
`ade hooks setup/status`, `agent-event` (silent-fail, never breaks Claude
outside ADE), `agent-sessions`; read-only daemon `snapshot` (no-resize
canary-proven) wired end to end. Notes for later phases:

- Phase 6 smoke asserts: live pane → `source: "live-screen"`; exited pane →
  `scrollback-history` with NO "live screen read failed" warning in main log.
- `packages/server-core/src/notifications/map-event-type.ts` is a SECOND
  copy serving apps/server (web shell) — not extended; web path ignores the
  new events (forward-compat safe). Extend if Feature 3 must cover web.
- `agentKind` field exists but nothing populates it yet (defaults claude).
- Never run biome --write over agent-setup/ (corrupts {{MARKER}} templates).

Earlier:

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
