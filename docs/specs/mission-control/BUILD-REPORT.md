# Mission Control — build report

Date: 2026-08-09 · Branch: `mission-control` (left pushed to
`boostedchaos/ade`; MERGED to main 2026-08-09, fast-forward to `2692376`) · Base: `302d183` · Final code SHA:
`4dac3e2` · Orchestration: Fable architect + parallel Opus 5 executors;
ship-gating reviewer at xhigh; Codex CLI cross-check.

## Post-report live smoke on Kyle's machine (addendum)

Kyle ran the packaged 0.4.0 live; the smoke found and we fixed two real
bugs (`4dac3e2`): (1) the CLI reused `SUPERSET_WORKSPACE_NAME` — which the
app fills with the workspace DISPLAY name in agent terminals — as its
data-dir suffix, so every agent terminal in a named workspace got "app is
not running"; fixed with a dedicated validated `ADE_DATA_DIR_NAME`
(injected into PTYs, defaulted by the generated launcher). (2)
`buildSafeEnv` was stripping ALL `ADE_*` vars between env build and PTY
spawn — the Phase-2 env aliases had never reached a real agent shell;
fixed with explicit allowlist entries. Verified live: browser split beside
the pane with focus restored (event stream showed the restore),
`read-screen` returned the live Claude TUI as `live-screen`,
`pane-created`/`agent-state-changed` events streamed, browser
info/screenshot worked, tables rendered, and Kyle visually confirmed the
attention ring + Dock badge from `set-status needsInput`. Artifacts were
rebuilt at `4dac3e2`: DMG sha256 `c1ae94c0…7b616d`, zip `7448e64e…162054`
(SHA256SUMS.txt updated). Later the same day, live on Kyle's installed 0.4.0: `ade claude-teams`
spawned a real teammate pane through the shim (task completed, file
written, ZERO unknown-verb entries in tmux-compat.log), and a fresh agent
pane carried `ADE_DATA_DIR_NAME=.ade-default`. Still open: one-toast-per-
permission-ask (bypass mode skips asks; will verify in normal daily use).
Operational gotcha found: the detached terminal-host daemon survives app
upgrades running from the OLD bundle path — new PTY spawns die until it is
restarted (issue filed). Noted twice, cause unknown: occasional
>25s SIGTERM quit in the smoke harness.

## What shipped

All four spec features, in the spec's dependency order:

1. **`ade` CLI + control socket** — `packages/control-plane` (NDJSON socket
   server in Electron main, per-launch 0600 token, auth-by-construction
   middleware, subscribe event stream) + `packages/cli` (29 verbs: panes,
   tabs/workspaces, terminal I/O, status, todos, notifications, browser,
   events, hooks, teams; tables for humans, `--json` for machines;
   exit codes 0/1/2/3, 127 for a broken install). Reads are served from
   main's app-state mirror — the renderer bridge carries mutations only.
   `ade cli install` puts the CLI on an external terminal's PATH; agent
   terminals get it automatically via agent-setup.
2. **Agent session tracking** — extends ADE's existing hook pipeline (no
   `~/.claude/settings.json` merge; ADE's own forced-settings file). Full
   event coverage → authoritative per-pane `AgentSession` registry in main,
   persisted (`agent_sessions`, migration 0040), PTY-exit liveness,
   10-minute stuck-state transcript corrector that structurally cannot
   invent sessions. `ade agent-event` is silent-fail outside ADE.
   `Notification` hook messages are payload-classified: permission-shaped →
   needsInput; idle-nudge-shaped → ignored; unknown → needsInput
   (fail-open so a real ask is never dropped).
3. **Attention notifications** — `notifications` table (0041), pane ring
   (inset shadow, beats focused style), tab/rail badges + macOS Dock badge,
   native toast (single decision point — no double-toast), notification
   panel popover, `jump-to-unread`, `ade notify`.
4. **`ade claude-teams` + tmux shim** — built against the CAPTURED contract
   of Claude Code 2.1.226 (probe committed under `probe/`): flag is live;
   the real channel is `set-option remain-on-exit` + `respawn-pane -k`;
   shim translates the full observed verb set, wraps every start command in
   `/bin/sh -c '…'`, per-launch mapping store (advisory-locked, atomic,
   owner-verified stale-break), PTY-readiness wait before respawn sends,
   spawn cap 3→8 (`ADE_MAX_CONCURRENT_SPAWNS`). darwin-gated; marked
   EXPERIMENTAL (upstream server-side kill switch `tengu_amber_flint`).

Plus: read-only terminal-host `snapshot` (accurate TUI screen reads, canary-
proven no-resize), browser-as-split store action, `set-status`/`set-progress`,
todos (`workspace_todos`, 0042), bundled `skills/ade-workspace` skill,
`docs/mission-control.md`, CHANGELOG 0.4.0.

## Ship gates — results and the commands that produced them

1. **Baseline-diff vs 302d183 — PASS.** Detached worktree
   (`git worktree add /private/tmp/mc-baseline 302d183`), full suite both
   trees per-package from each package cwd, failure names stripped of
   timings, `comm -23 ours.sorted base.sorted` → **empty both directions**:
   identical 37-name failure set (all pre-existing, apps/desktop
   static-ports/setup fs-mock suites). Ours: 2296 pass vs baseline 1634.
   The comparison was canary-proven (planted fake failure was reported).
   Population note: ours adds two packages that don't exist at baseline
   (cli 259, control-plane 274 — all passing, so they cannot mask anything).
2. **New-code tests — PASS.** Final counts (each from its package cwd):
   control-plane 274/0, cli 259/0, server-core 484 pass + 1 pre-existing
   fail (verified present with work stashed), desktop 871 pass / 37
   pre-existing fail. Repo-root `bun run typecheck`: 18/18 — note this gate
   was RED on main (53 webui errors at the merge-base); the branch leaves
   it green.
3. **Live macOS smoke — PARTIAL (machine-verifiable half done).** Verified
   on the packaged 0.4.0 app under an isolated `$HOME`: boots, control
   socket + 0600 token created, agent-setup installs the packaged CLI
   launcher + skill, `ade list-workspaces` answers over the socket (both
   direct and via the generated launcher and via `ade cli install`
   symlink), list output renders as tables, zero "live screen read failed"
   warnings, claude-teams shim points at the packaged entry. **Not
   verified — needs a human UI session** (creating the first project is a
   UI action; fabricating state was rightly refused): see "Kyle's 5-minute
   checklist" below.
4. **Adversarial review + Codex cross-check — both ran, both FIX-FIRST,
   all findings resolved.** Codex (`codex exec --sandbox read-only`,
   12-finding cap): 9 findings, all confirmed on re-verification, all
   fixed (`dbd6567`) — including a real typecheck blocker in the webui
   shell that every per-package check missed. Adversarial reviewer (fresh
   Opus at xhigh, full diff): 5 major + 6 minor; round 2 (`abe5909`) fixed
   8, one re-scoped to documentation with evidence (the specified code fix
   had no call site). Canary discipline throughout: every fix's test was
   demonstrated to fail against the old behavior.
5. **windows-ci — GREEN** on both `09733d5` (pre-fix) and `abe5909`
   (post-fix): runs 31318087559, 31321294093 (workflow_dispatch — the
   workflow doesn't trigger on branch pushes). Commits after `abe5909` are
   docs/report only.
6. **Packaged 0.4.0 — DELIVERED.** Built twice from a `/private/tmp` clone
   (codesign fails under ~/Documents), final at `abe5909`. SUPERSET_*
   scrubbed (ten vars), `SUPERSET_WORKSPACE_NAME=default` baked (verified
   in the compiled chunk). Artifacts + updated SHA256SUMS.txt at the
   project root (`ADE-0.4.0-arm64.dmg` sha256 `553f4803…d67d04`,
   `ADE-0.4.0-arm64-mac.zip` sha256 `1333914a…9a105f`). **Ad-hoc signed,
   not notarized** — no Developer ID on this machine. Isolated boot smoke
   passed. Per the two-artifacts note: this is Kyle's personal-workspace
   build, not the public-release shape (`docs/releasing-mac.md` wants the
   name unset for public artifacts).

Leak grep before each push: full diff vs 302d183 against 17 patterns
(homelab IPs/hostnames, token shapes, username) → 0 hits, with a positive
control proving the grep fires; probe artifacts sanitized to neutral paths
(golden tests re-run green after).

## Found and fixed along the way (not in the spec)

- **0.3.0's packaged app silently shipped without hook templates** — the
  vite resource copy pointed at a moved directory and `copyDir` no-ops on a
  missing source; `setupAgentHooks()` then threw at runtime, so the 0.3.0
  app never completed agent hook setup. Fixed + a guard that fails the
  build loudly (canary-proven). Verified against the `mac-v0.3.0` tag.
- Repo-root typecheck was red on main (webui shell shim types); now green.
- The webui version check compared against a no-op function and failed
  open; it now receives a real `__APP_VERSION__`.

## Divergences from the spec (all deliberate, all documented)

- Feature 2 extends ADE's existing hooks pipeline instead of merging
  `~/.claude/settings.json` (recon found ADE already forces its own hooks
  file; two writers of PaneStatus would have been worse). The spec's
  backup rule is applied to ADE's own hooks file.
- `subscribe` upgrades one connection (spec shape) rather than the daemon's
  two-socket pattern; response field `result` per spec, vs daemon `payload`.
- No second native-toast path for needsInput — the existing
  NotificationManager already fires; the spec reading would have produced
  two toasts per ask. Known gap: needsInput arriving via the `ade
  agent-event` socket door gets ring/badges but no OS toast (only affects
  hooks ADE didn't install).
- `--command` on splits returns UNSUPPORTED (store actions take no command);
  `new-tab --command` works.
- tmux shim: panes are born on the default shell (not `cat`) so
  `respawn-pane` has a live channel; `select-pane -T` sets title without
  focusing (a spawn burst would yank focus); `-l` sizes ignored (mosaic
  owns geometry); version reported as "tmux 3.4".
- `pane-ready` is a wire-only command (used by the shim); it has no CLI verb.
- Refs (`tab:<n>`/`pane:<n>`) resolve against the focused context —
  documented in PROTOCOL.md/help rather than adding an unused scope param.
- Bin entry-missing exit code is 127 (3 is reserved for app-not-running).
- Migration 0042 carries both `workspace_todos` and
  `agent_sessions.progress` (single drizzle generation, not hand-split).

## Deliberately NOT changed

- No merge to main; no release published; NOTICE untouched; no code,
  comments, or text from cmux/Ghostty/Bonsplit anywhere (reimplementation
  from observed behavior + the committed probe log only).
- Existing store actions were extended, never replaced; mosaic remains the
  layout engine; the terminal-host daemon's own protocol/token semantics
  are untouched (the new `snapshot` request is additive).
- The second `map-event-type.ts` copy serving the web shell (`apps/server`)
  was not extended — the web path ignores the new events safely.
- Windows shim, worktree auto-orchestration, CDP/cookie support,
  hibernation, canvas layout: out of scope per spec, not built.
- Kyle's real `~/.ade-default` and running app: untouched by all smokes
  (isolated `$HOME` + separate automation ports). One early non-isolated
  smoke by a predecessor agent bound the real dir briefly; its leftovers
  were preserved at `/private/tmp/ade-smoketest-predecessor-leftover`.

## Known limitations / follow-ups

- **Kyle's 5-minute checklist (the un-automatable smoke half):** open the
  0.4.0 app, add a project, then in a terminal:
  1. `ade new-pane --type browser --direction right --url https://example.com --focus false`
     → browser splits in BESIDE the pane (not a new tab) and the caret
     stays put. Try `--direction left` from a nested pane.
  2. Run a Claude pane, trigger a permission ask → exactly ONE toast, red
     ring, badge; answer it → all clear. Let a pane idle >60s → confirm NO
     false red ring (if one appears, the idle-nudge wording differs from
     the classifier's — send me the exact message text).
  3. `ade claude-teams` in an ADE terminal (needs a real TTY) → teammate
     appears as a real pane; afterwards `~/.ade-default/claude-teams/<launch>/tmux-compat.log`
     should contain no `unknown-verb` lines.
  4. `ade events --once` in a second terminal while opening a pane →
     prints a `pane-created` event. `ade read-screen pane:1` → says
     `source: live-screen`.
- SIGTERM quit of the rebuilt packaged app took >25s once in the smoke
  harness (first build quit cleanly). Unreproduced, cause not established —
  an observation to watch, not a diagnosed regression.
- Unread badge counts use `unreadOnly` but still `limit 200` — >200 unread
  rows would undercount (documented in code; a COUNT(*) closes it).
- Per-launch claude-teams store dirs accumulate (kept as debugging trail);
  a cleanup policy is future work.
- Plain `claude` outside ADE has the bundled skill on disk but no discovery
  path (writing into `~/.claude/skills` is an opt-in decision left open).
- Artifacts are ad-hoc signed; notarization needs a Developer ID.
